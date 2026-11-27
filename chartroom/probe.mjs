#!/usr/bin/env node
// chartroom probe: one command, no arguments, throwaway everything. Every
// repo, chart and home dir lands under a temp dir; the real ~/.claude is never
// written and nothing touches the network. `-v` lists every assertion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sections } from "../tools/probe_sections.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = process.argv.includes("-v");
// Each section runs in its own child with its own TMP, several at once;
// `--only <word>` picks sections, `--serial` runs them here.
const { want } = await sections(import.meta.url, { label: "chartroom probe" });
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chartroom-probe-")));
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });
const ENV = {
  ...process.env,
  HOME,
  CHARTROOM_HOME: path.join(HOME, ".claude", "chartroom"),
  GIT_CONFIG_GLOBAL: path.join(TMP, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "probe@example.invalid",
  GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "probe@example.invalid",
};
for (const k of ["SEAMUX_HOST", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_ENTRYPOINT", "SEAMUX_BACKEND", "SEAMUX_PANE_ID",
  "SEAMUX_WORKSPACE_ID", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CLAUDE_PROJECT_DIR", "TMUX", "TMUX_PANE"]) delete ENV[k];
fs.writeFileSync(ENV.GIT_CONFIG_GLOBAL, "[init]\n\tdefaultBranch = main\n");
Object.assign(process.env, ENV);

const S = await import("./lib/store.mjs");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; if (V) console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  :: " + String(extra).slice(0, 400) : "")); }
}
const cli = (cwd, ...args) => spawnSync("node", [path.join(HERE, "chartroom.mjs"), ...args], { encoding: "utf8", env: ENV, cwd });
const json = r => { try { return JSON.parse(r.stdout); } catch { return null; } };
const sh = (cwd, cmd) => spawnSync("sh", ["-c", cmd], { encoding: "utf8", env: ENV, cwd });
let n = 0;
function repo(name = "r" + (++n)) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  sh(d, "git init -q && git commit -q --allow-empty -m init");
  return d;
}
const status = d => sh(d, "git status --porcelain --untracked-files=all").stdout.trim();
const write = (d, name, text) => { const p = path.join(d, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

if (want("store: where the charts live")) {
  const d = repo();
  let l = S.resolve(d);
  ok("dir: a git repo with nothing set keeps charts hidden in .chartroom", l.mode === "hidden" && l.dir === path.join(d, ".chartroom"), JSON.stringify(l));
  ok("dir: nothing is written by resolve", !fs.existsSync(path.join(d, ".chartroom")) && !S.excluded(l.git));
  const r = spawnSync("node", [path.join(HERE, "chartroom.mjs"), "new", "ux", "Checkout", "--json"],
    { encoding: "utf8", env: { ...ENV, CLAUDE_CODE_SESSION_ID: "sess-1234" }, cwd: d });
  ok("new: exit 0 and the chart as JSON", r.status === 0 && json(r)?.chart?.id === "checkout", r.stderr);
  ok("new: the chart keeps the session it was made in (the Wake's turn card)", json(r)?.chart?.session === "sess-1234", r.stdout);
  ok("hidden: the first write adds /.chartroom/ to .git/info/exclude", S.excluded(l.git));
  ok("hidden: git status stays clean", status(d) === "", status(d));
  ok("hidden: the exclude line goes in once", fs.readFileSync(l.git.exclude, "utf8").split("\n").filter(x => x === "/.chartroom/").length === 1);
  cli(d, "new", "arch", "Second");
  ok("hidden: a second write adds no second line", fs.readFileSync(l.git.exclude, "utf8").split("\n").filter(x => x === "/.chartroom/").length === 1);

  // A worktree of the same repo reads the main checkout's hidden folder.
  const wt = path.join(TMP, "wt-" + n);
  sh(d, `git worktree add -q -b side ${JSON.stringify(wt)}`);
  const lw = S.resolve(wt);
  ok("worktree: a hidden repo's worktree shares the main checkout's folder", lw.dir === path.join(d, ".chartroom"), lw.dir);
  ok("worktree: lists the charts made in the main checkout", (json(cli(wt, "list", "--json"))?.charts || []).length === 2);
  const sub = path.join(d, "deep", "er");
  fs.mkdirSync(sub, { recursive: true });
  ok("subfolder: resolves to the repo's folder", S.resolve(sub).dir === path.join(d, ".chartroom"));

  // Outside git: a folder under CHARTROOM_HOME, one per path.
  const plain = path.join(TMP, "plain");
  fs.mkdirSync(plain);
  const lp = S.resolve(plain);
  ok("outside git: charts go under CHARTROOM_HOME", lp.mode === "home" && lp.dir.startsWith(ENV.CHARTROOM_HOME + path.sep), lp.dir);
  ok("outside git: the same folder resolves the same way", S.resolve(plain).dir === lp.dir);
  ok("outside git: another folder gets another dir", S.resolve(TMP).dir !== lp.dir);
  ok("outside git: new works", cli(plain, "new", "domain", "Glossary").status === 0 && fs.existsSync(path.join(lp.dir, "glossary", "chart.json")));
  ok("outside git: share says it needs a repo", cli(plain, "share", "on").status === 1);
}

if (want("store: config and share")) {
  // .chartroom.json moves the dir into the tree; tracked like any file.
  const d = repo();
  write(d, ".chartroom.json", JSON.stringify({ dir: "docs/charts" }));
  const l = S.resolve(d);
  ok("config: .chartroom.json names the dir", l.mode === "config" && l.dir === path.join(d, "docs", "charts"), JSON.stringify(l));
  cli(d, "new", "arch", "Services");
  ok("config: no exclude line is added", !S.excluded(l.git));
  ok("config: the chart shows to git", status(d).includes("docs/charts/services/chart.json"), status(d));
  ok("config: share off refuses and says why", /\.chartroom\.json/.test(cli(d, "share", "off").stderr));
  write(d, ".chartroom.json", JSON.stringify({ dir: "../outside" }));
  ok("config: a dir outside the repo is refused", /inside the repo/.test(cli(d, "list").stderr));
  write(d, ".chartroom.json", "{oops");
  ok("config: a broken file falls back to the default", S.resolve(d).mode === "hidden");

  // share on / off in the main checkout.
  const e = repo();
  cli(e, "new", "ux", "Nav");
  ok("share: status says not shared", /not shared/.test(cli(e, "share").stdout));
  const on = cli(e, "share", "on");
  ok("share on: exit 0, and says comments go into git too", on.status === 0 && /comments and picks/.test(on.stdout), on.stderr);
  ok("share on: the exclude line is gone and the chart shows", !S.excluded(S.gitInfo(e)) && status(e).includes(".chartroom/nav/chart.json"), status(e));
  ok("share on: git config chartroom.share is true", sh(e, "git config --get chartroom.share").stdout.trim() === "true");
  ok("share on: status says shared", /^shared/.test(cli(e, "share", "status").stdout));
  const off = cli(e, "share", "off");
  ok("share off: hidden again", off.status === 0 && S.excluded(S.gitInfo(e)) && status(e) === "", status(e));
  // Committed charts keep the repo shared, whatever the flag says.
  cli(e, "share", "on");
  sh(e, "git add .chartroom && git commit -q -m charts");
  const off2 = cli(e, "share", "off");
  ok("share off with committed charts: says git keeps them", /git rm -r --cached/.test(off2.stdout), off2.stdout);
  ok("tracked: a .chartroom/ with committed files resolves as shared", S.resolve(e).mode === "shared");

  // share on in a worktree copies the main checkout's hidden charts in.
  const f = repo();
  cli(f, "new", "ux", "Hidden One");
  const wt = path.join(TMP, "wt-share-" + n);
  sh(f, `git worktree add -q -b side ${JSON.stringify(wt)}`);
  const r = json(cli(wt, "share", "on", "--json"));
  ok("share on in a worktree: copies the hidden charts into the worktree", r && r.copied.includes("hidden-one") &&
    fs.existsSync(path.join(wt, ".chartroom", "hidden-one", "chart.json")), JSON.stringify(r));
  ok("share on in a worktree: the worktree now resolves to its own folder", S.resolve(wt).dir === path.join(wt, ".chartroom"));
  ok("share on in a worktree: the main checkout's copy is left in place", fs.existsSync(path.join(f, ".chartroom", "hidden-one", "chart.json")));
}

if (want("charts: new, add, status, link")) {
  const d = repo();
  const dir = S.resolve(d).dir;
  ok("new: refuses an unknown kind", /kind must be one of/.test(cli(d, "new", "poster", "X").stderr));
  ok("new: refuses a missing title", cli(d, "new", "ux").status === 2);
  const a = json(cli(d, "new", "ux", "Checkout — Flow!", "--json")).chart;
  const b = json(cli(d, "new", "ux", "checkout flow", "--json")).chart;
  ok("new: the id is a slug of the title", a.id === "checkout-flow", a.id);
  ok("new: a taken id gets a suffix", b.id === "checkout-flow-2", b.id);
  ok("new: --id is used as given, and refused when taken", cli(d, "new", "ux", "Y", "--id", "mine").status === 0 &&
    /already exists/.test(cli(d, "new", "ux", "Z", "--id", "mine").stderr));
  ok("new: starts exploring with no versions and an empty thread file", a.status === "exploring" && a.versions.length === 0 &&
    JSON.parse(fs.readFileSync(path.join(dir, a.id, "threads.json"), "utf8")).threads.length === 0);

  write(d, "one.html", "<p>one</p>");
  write(d, "two.html", "<p>two</p>");
  write(d, "notes.txt", "x");
  let c = json(cli(d, "add", a.id, "one.html", "two.html", "--note", "first pass", "--json")).chart;
  let v = c.versions[0];
  ok("add: a ux chart's panes are options keyed a, b", v.n === 1 && v.panes.map(p => p.key + ":" + p.role).join() === "a:option,b:option", JSON.stringify(v));
  ok("add: the pane files are copied into v1/", fs.readFileSync(path.join(dir, a.id, "v1", "b.html"), "utf8") === "<p>two</p>");
  ok("add: the note is kept", v.note === "first pass");
  c = json(cli(d, "add", a.id, "Calm:Calm layout=one.html", "loud=two.html", "--json")).chart;
  v = c.versions[1];
  ok("add: KEY:Label=file names the pane", v.n === 2 && v.panes[0].key === "calm" && v.panes[0].label === "Calm layout" && v.panes[1].label === "LOUD", JSON.stringify(v.panes));
  ok("add: v1 is left as it was", fs.existsSync(path.join(dir, a.id, "v1", "a.html")) && !fs.existsSync(path.join(dir, a.id, "v1", "calm.html")));
  ok("add: refuses a file that is not html", /\.html file/.test(cli(d, "add", a.id, "notes.txt").stderr));
  ok("add: refuses a missing file", /no such pane file/.test(cli(d, "add", a.id, "gone.html").stderr));
  ok("add: refuses two panes with one key", /two panes named/.test(cli(d, "add", a.id, "x=one.html", "x=two.html").stderr));
  ok("add: refuses --option with --view", cli(d, "add", a.id, "one.html", "--option", "--view").status === 2);
  ok("add: refuses an unknown chart", /no chart/.test(cli(d, "add", "nope", "one.html").stderr));
  ok("add: a refused add leaves no version behind", S.read(dir, a.id).versions.length === 2);
  const big = path.join(d, "big.html");
  fs.writeFileSync(big, ""); fs.truncateSync(big, S.MAX_PANE + 1);
  ok("add: refuses a pane over the size cap", /over/.test(cli(d, "add", a.id, "big.html").stderr));

  const arch = json(cli(d, "new", "arch", "Services", "--json")).chart;
  write(d, "Sequence Diagram.html", "<svg></svg>");
  const av = json(cli(d, "add", arch.id, "Sequence Diagram.html", "--json")).version;
  ok("add: an arch chart's pane is a view named after its file", av.panes[0].role === "view" && av.panes[0].key === "sequence-diagram", JSON.stringify(av));
  ok("add: --option makes an arch pane pickable", json(cli(d, "add", arch.id, "one.html", "--option", "--json")).version.panes[0].role === "option");

  ok("status: refuses an unknown status", /status must be/.test(cli(d, "status", a.id, "done").stderr));
  c = json(cli(d, "status", a.id, "chosen", "--decision", "calm wins", "--json")).chart;
  ok("status: sets status and decision", c.status === "chosen" && c.decision === "calm wins");
  c = json(cli(d, "status", a.id, "exploring", "--json")).chart;
  ok("status: back to exploring keeps the decision text and clears chosen", c.status === "exploring" && c.decision === "calm wins" && c.chosen === null);

  ok("link: refuses a link that is not a claude.ai artifact", /not a claude.ai artifact/.test(cli(d, "link", a.id, "https://example.com/x").stderr));
  ok("link: refuses a version the chart lacks", /no version/.test(cli(d, "link", a.id, "https://claude.ai/artifact/abc-1", "--version", "9").stderr));
  c = json(cli(d, "link", a.id, "https://claude.ai/code/artifact/abc-1", "--json")).chart;
  ok("link: records the url against the latest version", c.published.length === 1 && c.published[0].version === 2);
  c = json(cli(d, "link", a.id, "https://claude.ai/code/artifact/abc-1", "--version", "1", "--json")).chart;
  ok("link: the same url again replaces its entry", c.published.length === 1 && c.published[0].version === 1);

  const ls = json(cli(d, "list", "--json")).charts;
  ok("list: newest first", ls[0].id === a.id, ls.map(x => x.id).join());
  fs.mkdirSync(path.join(dir, "junk"));
  fs.writeFileSync(path.join(dir, "junk", "chart.json"), "{bad");
  ok("list: a broken chart.json is skipped, not fatal", cli(d, "list").status === 0);
  ok("show: prints each pane's file", /v2\/calm\.html/.test(cli(d, "show", a.id).stdout));
  ok("show: refuses an id with a slash", /not a chart id/.test(cli(d, "show", "../x").stderr));
  ok("help: exit 0 and the verbs", /chartroom new/.test(cli(d, "help").stdout));
  ok("unknown verb: exit 2", cli(d, "fly").status === 2);
  const doc = json(cli(d, "doctor", "--json"));
  ok("doctor: reports dir, mode and count", doc && doc.mode === "hidden" && doc.charts >= 3 && doc.excluded === true, JSON.stringify(doc));
}

if (want("charts: two writers at once")) {
  const d = repo();
  const dir = S.resolve(d).dir;
  cli(d, "new", "ux", "Race");
  write(d, "p.html", "<p>p</p>");
  // Eight adds at once, as background jobs of one shell: each gets its own
  // version number, none is lost.
  sh(d, Array.from({ length: 8 }, () => `node ${JSON.stringify(path.join(HERE, "chartroom.mjs"))} add race p.html &`).join(" ") + " wait");
  const vs = S.read(dir, "race").versions.map(v => v.n);
  ok("lock: eight adds at once make versions 1 to 8, none lost or doubled", vs.length === 8 && new Set(vs).size === 8 && Math.max(...vs) === 8, vs.join());
  ok("lock: no lock dir is left behind", !fs.existsSync(path.join(dir, ".race.lock")));
  // Two news on one title at once: two charts.
  sh(d, Array.from({ length: 4 }, () => `node ${JSON.stringify(path.join(HERE, "chartroom.mjs"))} new ux Same &`).join(" ") + " wait");
  const ids = S.list(dir).map(c => c.id).filter(x => x.startsWith("same"));
  ok("new: four at once on one title make four charts", ids.length === 4 && new Set(ids).size === 4, ids.join());
}

if (want("host: the copy agrees with lookout's")) {
  const H = await import("./lib/host.mjs");
  const twin = path.join(HERE, "..", "lookout", "lib", "host.mjs");
  if (!fs.existsSync(twin)) ok("host: lookout's copy is beside this checkout", false, twin);
  else {
    const L = await import(twin);
    const cases = [{}, { SEAMUX_HOST: "remote" }, { SEAMUX_HOST: " Desktop " }, { SEAMUX_HOST: "bogus" },
      { CMUX_WORKSPACE_ID: "w" }, { CMUX_WORKSPACE_ID: "w", SEAMUX_BACKEND: "tmux" }, { SEAMUX_PANE_ID: "p" },
      { CLAUDE_CODE_REMOTE: "true" }, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, { CLAUDE_CODE_ENTRYPOINT: "cli" },
      { SEAMUX_BACKEND: "tmux", SEAMUX_WORKSPACE_ID: "s", CMUX_WORKSPACE_ID: "c", CMUX_SURFACE_ID: "x" },
      { CMUX_WORKSPACE_ID: "c", CMUX_SURFACE_ID: "x" }];
    for (const env of cases) {
      ok("host: detectHost agrees on " + JSON.stringify(env), JSON.stringify(H.detectHost(env)) === JSON.stringify(L.detectHost(env)));
      ok("host: sessionIds agrees on " + JSON.stringify(env), JSON.stringify(H.sessionIds(env)) === JSON.stringify(L.sessionIds(env)));
    }
    ok("host: the host lists agree", JSON.stringify(H.HOSTS) === JSON.stringify(L.HOSTS) &&
      JSON.stringify(H.DESKTOP_ENTRYPOINTS) === JSON.stringify(L.DESKTOP_ENTRYPOINTS));
  }
}

// A raw request, so a test can send any Host or Origin it likes.
function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise(resolve => {
    const data = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
    const hs = { Host: `127.0.0.1:${port}`, ...headers };
    if (data !== undefined && hs["Content-Length"] === undefined) hs["Content-Length"] = Buffer.byteLength(data);
    const q = http.request({ host: "127.0.0.1", port, path: p, method, headers: hs }, res => {
      const parts = [];
      res.on("data", c => parts.push(c));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let j = null; try { j = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json: j });
      });
    });
    q.on("error", e => resolve({ status: 0, text: e.message, headers: {} }));
    if (data !== undefined) q.write(data);
    q.end();
  });
}
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } return null; };

if (want("serve: guards, routes and the pane sandbox")) {
  const d = repo();
  const dir = S.resolve(d).dir;
  cli(d, "new", "ux", "Checkout");
  write(d, "a.html", "<html><body><h1>Pay</h1><button id=pay>Pay now</button></body></html>");
  write(d, "b.html", "<p>no body tag</p>");
  cli(d, "add", "checkout", "a.html", "b.html", "--note", "first");
  const o = json(cli(d, "open", "checkout", "--json"));
  ok("open: prints a served URL with the room and chart", o && /^http:\/\/127\.0\.0\.1:\d+\/room\/[a-f0-9]{12}\/#checkout$/.test(o.url), JSON.stringify(o));
  const rec = JSON.parse(fs.readFileSync(path.join(ENV.CHARTROOM_HOME, "serve.json"), "utf8"));
  ok("serve.json: mode 0600", (fs.statSync(path.join(ENV.CHARTROOM_HOME, "serve.json")).mode & 0o777) === 0o600);
  const port = rec.port, room = o.room, T = rec.token;
  const rooms = JSON.parse(fs.readFileSync(path.join(ENV.CHARTROOM_HOME, "rooms.json"), "utf8"));
  ok("rooms.json: the room names this repo's chart dir", rooms[room] && rooms[room].dir === dir);
  const again = json(cli(d, "open", "--json"));
  ok("open again: the same server and room", again.url.startsWith(`http://127.0.0.1:${port}/room/${room}/`));
  ok("serve --status: running on that port", json(cli(d, "serve", "--status", "--json"))?.port === port);

  let r = await req(port, "GET", "/health");
  ok("health: answers as chartroom", r.status === 200 && r.json?.server === "chartroom");
  r = await req(port, "GET", "/health", { headers: { Host: "evil.example:" + port } });
  ok("host guard: another Host is refused", r.status === 403, r.status);
  r = await req(port, "GET", `/room/${room}/`);
  ok("studio: served with the boot (room and token)", r.status === 200 && r.text.includes(`"room":"${room}"`) && r.text.includes(T));
  ok("studio: has its own CSP", /default-src 'self'/.test(r.headers["content-security-policy"] || ""));
  ok("studio: loads its css and js from /static", r.text.includes('href="/static/studio.css"') && r.text.includes('src="/static/studio.js"'));
  r = await req(port, "GET", "/static/studio.js");
  ok("static: studio.js is served", r.status === 200 && /javascript/.test(r.headers["content-type"]));
  ok("static: anything else is not", (await req(port, "GET", "/static/../lib/serve.mjs")).status === 404 &&
    (await req(port, "GET", "/static/anchor.js")).status === 404);
  ok("room: an unknown room is 404", (await req(port, "GET", "/room/000000000000/")).status === 404);

  r = await req(port, "GET", `/room/${room}/api/state`);
  ok("api: no token, refused", r.status === 403);
  r = await req(port, "GET", `/room/${room}/api/state?t=${"x".repeat(T.length)}`);
  ok("api: a wrong token, refused", r.status === 403);
  r = await req(port, "GET", `/room/${room}/api/state?t=${T}`);
  ok("api state: every chart, with a signature", r.status === 200 && r.json.charts.length === 1 && r.json.charts[0].id === "checkout" && /^[a-f0-9]{16}$/.test(r.json.sig));
  const sig1 = r.json.sig;
  r = await req(port, "GET", `/room/${room}/api/chart/checkout?t=${T}`);
  ok("api chart: the chart and its threads", r.status === 200 && r.json.chart.versions.length === 1 && Array.isArray(r.json.threads));
  ok("api chart: an unknown chart is 404", (await req(port, "GET", `/room/${room}/api/chart/nope?t=${T}`)).status === 404);
  write(d, "c.html", "<p>three</p>");
  cli(d, "add", "checkout", "c.html");
  r = await req(port, "GET", `/room/${room}/api/state?t=${T}`);
  ok("api state: a new version changes the signature", r.json.sig !== sig1);

  r = await req(port, "GET", `/room/${room}/pane/checkout/1/a`);
  const csp = r.headers["content-security-policy"] || "";
  ok("pane: served without a token", r.status === 200 && r.text.includes("Pay now"));
  ok("pane: CSP sandbox with scripts and no same-origin", /sandbox allow-scripts(;|$)/.test(csp) && !/allow-same-origin/.test(csp), csp);
  ok("pane: no network but the CDNs", /connect-src 'none'/.test(csp) && /img-src data: blob:/.test(csp) && /script-src 'unsafe-inline' https:\/\/cdnjs/.test(csp), csp);
  ok("pane: the anchor is injected before </body>", /<script data-chartroom-anchor>[\s\S]*<\/script>\n<\/body>/.test(r.text));
  ok("pane: the token is nowhere in it", !r.text.includes(T));
  r = await req(port, "GET", `/room/${room}/pane/checkout/1/b`);
  ok("pane: a page with no </body> gets the anchor at the end", r.status === 200 && /data-chartroom-anchor[\s\S]*<\/script>\n$/.test(r.text));
  for (const bad of ["/pane/checkout/9/a", "/pane/checkout/1/zz", "/pane/..%2f..%2fx/1/a", "/pane/checkout/0/a", "/pane/checkout/1/a.html"])
    ok("pane: refused " + bad, (await req(port, "GET", `/room/${room}${bad}`)).status === 404);
  // A symlinked pane that points out of the room is refused.
  fs.symlinkSync(path.join(d, "a.html"), path.join(dir, "checkout", "v1", "evil.html"));
  ok("pane: a symlink out of the room is refused", (await req(port, "GET", `/room/${room}/pane/checkout/1/evil`)).status === 404);

  // POST guards, in order.
  const op = `/room/${room}/api/op`;
  const origin = `http://127.0.0.1:${port}`;
  r = await req(port, "POST", op, { headers: { "Content-Type": "application/json" }, body: { t: T, op: "x" } });
  ok("post: no Origin, refused", r.status === 403 && /cross-origin/.test(r.json?.error));
  r = await req(port, "POST", op, { headers: { Origin: "http://evil.example", "Content-Type": "application/json" }, body: { t: T } });
  ok("post: another Origin, refused", r.status === 403);
  r = await req(port, "POST", op, { headers: { Origin: origin, "Content-Type": "text/plain" }, body: { t: T } });
  ok("post: not JSON, 415", r.status === 415);
  r = await req(port, "POST", op, { headers: { Origin: origin, "Content-Type": "application/json", "Content-Length": String(70 * 1024) }, body: "{}" });
  ok("post: too large, 413", r.status === 413);
  r = await req(port, "POST", op, { headers: { Origin: origin, "Content-Type": "application/json" }, body: { t: "nope" } });
  ok("post: a wrong token, 403", r.status === 403 && /token/.test(r.json?.error));
  r = await req(port, "POST", op, { headers: { Origin: origin, "Content-Type": "application/json" }, body: "[1]" });
  ok("post: not an object, 400", r.status === 400);
  r = await req(port, "POST", `/room/${room}/api/state`, { headers: { Origin: origin, "Content-Type": "application/json" }, body: { t: T } });
  ok("post: only /api/op takes a POST", r.status === 404);
  ok("put: 405", (await req(port, "PUT", op, { body: "{}" })).status === 405);

  ok("serve --stop: stops it", json(cli(d, "serve", "--stop", "--json"))?.stopped === true);
  ok("serve --stop: serve.json is gone", await waitFor(() => !fs.existsSync(path.join(ENV.CHARTROOM_HOME, "serve.json"))));
  ok("open: on remote, no live page", /no live page/.test(spawnSync("node", [path.join(HERE, "chartroom.mjs"), "open"],
    { encoding: "utf8", env: { ...ENV, CLAUDE_CODE_REMOTE: "true" }, cwd: d }).stdout));
  ok("open: refuses an unknown chart", /no chart/.test(cli(d, "open", "nope").stderr));
}

if (want("serve: idle exit")) {
  const d = repo();
  const env = { ...ENV, CHARTROOM_SERVE_IDLE_MS: "600" };
  const o = JSON.parse(spawnSync("node", [path.join(HERE, "chartroom.mjs"), "open", "--json"], { encoding: "utf8", env, cwd: d }).stdout);
  const rec = JSON.parse(fs.readFileSync(path.join(ENV.CHARTROOM_HOME, "serve.json"), "utf8"));
  ok("idle: the server is up", o.url && rec.pid);
  ok("idle: it exits on its own and removes serve.json", await waitFor(() => !fs.existsSync(path.join(ENV.CHARTROOM_HOME, "serve.json")), 6000));
  // A link printed before the exit works again once the server restarts:
  // the new one takes the port the last one used.
  const o2 = JSON.parse(spawnSync("node", [path.join(HERE, "chartroom.mjs"), "open", "--json"], { encoding: "utf8", env, cwd: d }).stdout);
  ok("restart: the same port, so the old link works", o2.url === o.url, `${o.url} then ${o2.url}`);
  ok("restart: the old link answers", (await req(Number(new URL(o.url).port), "GET", new URL(o.url).pathname)).status === 200);
  const rec2 = JSON.parse(fs.readFileSync(path.join(ENV.CHARTROOM_HOME, "serve.json"), "utf8"));
  ok("restart: the same token, so an open tab keeps working", rec2.token === rec.token &&
    (await req(rec2.port, "GET", `/room/${o.room}/api/state?t=${rec.token}`)).status === 200);
  ok("token file: mode 0600", (fs.statSync(path.join(ENV.CHARTROOM_HOME, "serve.token")).mode & 0o777) === 0o600);
  // The port taken by something else: any free one.
  const blocker = http.createServer(() => {});
  const taken = Number(new URL(o2.url).port);
  spawnSync("node", [path.join(HERE, "chartroom.mjs"), "serve", "--stop"], { encoding: "utf8", env, cwd: d });
  await waitFor(() => !fs.existsSync(path.join(ENV.CHARTROOM_HOME, "serve.json")));
  await new Promise(r => blocker.listen(taken, "127.0.0.1", r));
  const o3 = JSON.parse(spawnSync("node", [path.join(HERE, "chartroom.mjs"), "open", "--json"], { encoding: "utf8", env, cwd: d }).stdout || "{}");
  ok("restart: a taken port falls back to another", o3.url && Number(new URL(o3.url).port) !== taken, o3.url);
  blocker.close();
  spawnSync("node", [path.join(HERE, "chartroom.mjs"), "serve", "--stop"], { encoding: "utf8", env, cwd: d });
}

if (want("page: studio and anchor files")) {
  const html = fs.readFileSync(path.join(HERE, "page", "studio.html"), "utf8");
  for (const slot of ["<!-- chartroom:css -->", "<!-- chartroom:js -->", "<!-- chartroom:boot -->"])
    ok("studio.html: has the slot " + slot, html.includes(slot));
  for (const id of ["register-list", "versions", "tabs", "frames", "threads", "notes", "keys"])
    ok("studio.html: has #" + id, html.includes(`id="${id}"`));
  const css = fs.readFileSync(path.join(HERE, "page", "studio.css"), "utf8");
  ok("studio.css: carries the Everforest block (theme_sync)", /everforest:start \*\/\n:root \{/.test(css) && css.includes("--role-attend"));
  const js = fs.readFileSync(path.join(HERE, "page", "studio.js"), "utf8");
  ok("studio.js: iframes are sandboxed with scripts only", /sandbox: "allow-scripts"/.test(js) && !/allow-same-origin/.test(js));
  ok("studio.js: only its own frames' messages are heard", /f\.el\.contentWindow === e\.source/.test(js));
  ok("studio.js: a published link must be a claude.ai artifact to be a link", /safe \? h\("a"/.test(js) && js.includes("claude\\.ai"));
  const SVm = await import("./lib/serve.mjs");
  const tagged = SVm.withAnchor("<p>İİİ</p></BODY ></html>", "/*a*/");
  ok("withAnchor: placed before </BODY > even after letters that grow when lowercased",
    tagged.startsWith("<p>İİİ</p><script data-chartroom-anchor>") && tagged.endsWith("</script>\n</BODY ></html>"), tagged);
  ok("withAnchor: the last </body> wins", SVm.withAnchor("<b></body></body>", "x").endsWith("</script>\n</body>"));
  const anchor = fs.readFileSync(path.join(HERE, "page", "anchor.js"), "utf8");
  ok("anchor.js: only the parent's messages are heard", /e\.source !== parentWin/.test(anchor));
  ok("no emoji in the pages", ![html, css, js, anchor].some(t => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)));
  for (const id of ["narrow-bar", "fit-toggle", "fit-fit", "fit-actual", "scrim", "sheet-close", "reg-close"])
    ok("studio.html: narrow layout has #" + id, html.includes(`id="${id}"`));
  ok("studio.css: narrow is chosen by width, not by device", /@media \(max-width: 700px\) \{\n  \.narrow-only/.test(css) && !/pointer: coarse\)[^}]*#narrow-bar/.test(css));
  ok("studio.css: hidden narrow parts stay hidden", /\.narrow-only\[hidden\] \{ display: none !important; \}/.test(css));
  ok("studio.js: Compare holds on pointer down and up, mouse or touch", /cmp\.addEventListener\("pointerdown"/.test(js) && /"pointerup", "pointercancel", "lostpointercapture"/.test(js));
  ok("studio.js: a chart wider than the pane is scaled to fit, else shown at its width", /st\.transform = "scale\(" \+ k \+ "\)"/.test(js) && /DEFAULT_W = 1100/.test(js));
  ok("anchor.js: the chart reports the width it was drawn for", /meta\[name="chartroom-width"\]/.test(anchor));
  ok("templates/ux.html: says the width it is designed for", /<meta name="chartroom-width" content="\d+">/.test(fs.readFileSync(path.join(HERE, "templates", "ux.html"), "utf8")));
  // No DOM here: the outline rule itself is tried in a real browser (the
  // increment's manual check); the probe only proves the script parses.
  const vm = await import("node:vm");
  ok("anchor.js: parses", (() => { try { new vm.Script(anchor); return true; } catch (e) { return e.message; } })() === true);
}

if (want("ops: comment, reply, resolve, pick")) {
  const O = await import("./lib/ops.mjs");
  const chart = { id: "c", kind: "ux", status: "exploring", decision: "", chosen: null,
    versions: [{ n: 1, panes: [{ key: "a", label: "A", role: "option" }, { key: "map", label: "map", role: "view" }] },
               { n: 2, panes: [{ key: "a", label: "A", role: "option" }, { key: "b", label: "Bold", role: "option" }] }] };
  const st = { chart, threads: O.emptyThreads() };
  const at = "2026-01-01T00:00:00.000Z";
  let r = O.applyOp(st, { op: "comment", version: 2, pane: "b", pin: { path: "body > button:nth-of-type(1)", dx: 4.6, dy: 9, text: "  Pay   now " }, text: " too close " }, at, "human");
  ok("comment: thread t1 with a cleaned pin and text", r[0] === 200 && r[1].item === "t1" && st.threads.threads[0].pin.dx === 5 &&
    st.threads.threads[0].pin.text === "Pay now" && st.threads.threads[0].messages[0].text === "too close", JSON.stringify(r));
  r = O.applyOp(st, { op: "comment", version: 1, pane: "a", text: "whole view" }, at, "human");
  ok("comment: no pin is a comment on the whole pane", r[0] === 200 && r[1].item === "t2" && st.threads.threads[1].pin === null);
  ok("comment: needs text", O.applyOp(st, { op: "comment", version: 2, pane: "a", text: "  " }, at, "human")[0] === 400);
  ok("comment: an unknown version is 404", O.applyOp(st, { op: "comment", version: 9, pane: "a", text: "x" }, at, "human")[0] === 404);
  ok("comment: a pane not in that version is 404", O.applyOp(st, { op: "comment", version: 1, pane: "b", text: "x" }, at, "human")[0] === 404);
  ok("comment: a bad pin is 400", O.applyOp(st, { op: "comment", version: 2, pane: "a", text: "x", pin: { path: "", dx: 1, dy: 1 } }, at, "human")[0] === 400 &&
    O.applyOp(st, { op: "comment", version: 2, pane: "a", text: "x", pin: { path: "p", dx: "x", dy: 1 } }, at, "human")[0] === 400);
  ok("comment: text over the cap is 413", O.applyOp(st, { op: "comment", version: 2, pane: "a", text: "x".repeat(O.MAX_TEXT + 1) }, at, "human")[0] === 413);
  ok("op: unknown op and unknown by are 400", O.applyOp(st, { op: "delete" }, at, "human")[0] === 400 &&
    O.applyOp(st, { op: "reply", item: "t1", text: "x" }, at, "robot")[0] === 400);
  r = O.applyOp(st, { op: "reply", item: "t1", text: "moved it" }, at, "agent");
  ok("reply: appends m2 by the agent", r[0] === 200 && st.threads.threads[0].messages[1].id === "m2" && st.threads.threads[0].messages[1].by === "agent");
  ok("waitsOnPerson: open and Claude spoke last", O.waitsOnPerson(st.threads.threads[0]) && !O.waitsOnPerson(st.threads.threads[1]));
  ok("reply: an unknown thread is 404", O.applyOp(st, { op: "reply", item: "t9", text: "x" }, at, "human")[0] === 404);
  r = O.applyOp(st, { op: "resolve", item: "t1" }, at, "human");
  ok("resolve: marks it and logs a status message", r[0] === 200 && st.threads.threads[0].resolved === true && st.threads.threads[0].messages[2].kind === "status");
  ok("resolve: twice is 409", O.applyOp(st, { op: "resolve", item: "t1" }, at, "human")[0] === 409);
  ok("reopen: opens it again", O.applyOp(st, { op: "reopen", item: "t1", text: "not yet" }, at, "human")[0] === 200 && !st.threads.threads[0].resolved);
  ok("waitsOnPerson: a resolved thread never waits", !O.waitsOnPerson({ resolved: true, messages: [{ by: "agent" }] }));
  ok("pick: a view cannot be picked", O.applyOp(st, { op: "pick", version: 1, pane: "map" }, at, "human")[0] === 400);
  r = O.applyOp(st, { op: "pick", version: 2, pane: "b" }, at, "human");
  ok("pick: sets chosen, status and a decision", r[0] === 200 && chart.status === "chosen" && chart.chosen.pane === "b" &&
    chart.decision === "Option Bold (v2)" && st.threads.picks.length === 1, JSON.stringify(chart));
  O.applyOp(st, { op: "pick", version: 2, pane: "a", text: "A after all" }, at, "human");
  ok("pick: another pick replaces it, with the person's words as the decision", chart.chosen.pane === "a" && chart.decision === "A after all" && st.threads.picks.length === 2);
  const hand = { ...chart, decision: "We go with A: matches the app", status: "exploring", chosen: null };
  const st2 = { chart: hand, threads: O.emptyThreads() };
  O.applyOp(st2, { op: "pick", version: 2, pane: "b" }, at, "human");
  ok("pick: a wordless pick keeps a decision someone wrote", hand.decision === "We go with A: matches the app" && hand.chosen.pane === "b");
  const sup = { ...chart, status: "superseded", chosen: null };
  ok("pick: a superseded chart is refused", O.applyOp({ chart: sup, threads: O.emptyThreads() }, { op: "pick", version: 2, pane: "a" }, at, "human")[0] === 409 && sup.status === "superseded");
  // studio.js repeats waitsOnPerson; both give the same boolean answers.
  const sjs = fs.readFileSync(path.join(HERE, "page", "studio.js"), "utf8");
  const m = /var waits = (function \(t\) \{[^\n]*\});/.exec(sjs);
  const pageWaits = m && (await import("node:vm")).runInNewContext("(" + m[1] + ")");
  const cases = [{ resolved: false, messages: [{ by: "agent" }] }, { resolved: false, messages: [{ by: "human" }] }, { resolved: true, messages: [{ by: "agent" }] },
    { resolved: false, messages: [] }, { messages: [{ by: "human" }, { by: "agent" }] }];
  ok("studio waits() matches ops waitsOnPerson, as booleans", pageWaits && cases.every(c => pageWaits(c) === O.waitsOnPerson(c) && typeof pageWaits(c) === "boolean"));
  // The ops are inlined into a published page: no import, no Node API.
  const src = fs.readFileSync(path.join(HERE, "lib", "ops.mjs"), "utf8");
  ok("ops.mjs: no imports and no Node globals, so a page can inline it", !/^\s*import\s/m.test(src) && !/\b(require|process|Buffer|fs\.)\b/.test(src.replace(/\/\/.*$/gm, "")));
}

if (want("threads: server, CLI, hook and wait")) {
  const d = repo();
  const dir = S.resolve(d).dir;
  cli(d, "new", "ux", "Nav");
  write(d, "a.html", "<button>Go</button>");
  write(d, "b.html", "<button>Go</button>");
  cli(d, "add", "nav", "a.html", "b.html");
  const o = json(cli(d, "open", "nav", "--json"));
  const rec = JSON.parse(fs.readFileSync(path.join(ENV.CHARTROOM_HOME, "serve.json"), "utf8"));
  const port = rec.port, room = o.room, origin = `http://127.0.0.1:${port}`;
  const post = body => req(port, "POST", `/room/${room}/api/op`, { headers: { Origin: origin, "Content-Type": "application/json" }, body: { t: rec.token, ...body } });
  let r = await post({ op: "comment", chart: "nav", version: 1, pane: "b", pin: { path: "body > button:nth-of-type(1)", dx: 3, dy: 4, text: "Go" }, text: "make it bigger" });
  ok("server op: a comment from the page is stored as the person's", r.status === 200 && r.json.item === "t1" && S.readThreads(dir, "nav").threads[0].messages[0].by === "human", r.text);
  ok("server op: by in the body is ignored", (await post({ op: "reply", chart: "nav", item: "t1", text: "x", by: "agent" })).status === 200 &&
    S.readThreads(dir, "nav").threads[0].messages[1].by === "human");
  ok("server op: an op without a chart is 400", (await post({ op: "comment", version: 1, pane: "a", text: "x" })).status === 400);
  ok("server op: an unknown chart is 404", (await post({ op: "comment", chart: "nope", version: 1, pane: "a", text: "x" })).status === 404);

  // The hook: a session in this repo hears both messages once.
  const hook = (cwd, extraEnv = {}) => spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd,
    env: { ...ENV, ...extraEnv }, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd }) });
  let hk = hook(d);
  let ctx = (() => { try { return JSON.parse(hk.stdout).hookSpecificOutput.additionalContext; } catch { return ""; } })();
  ok("hook: tells the session what the person wrote", /\[chartroom\] 2 new/.test(ctx) && /nav t1 \(v1 B/.test(ctx) && /"make it bigger"/.test(ctx) && /pinned on "Go"/.test(ctx), hk.stdout);
  ok("hook: says it is data, and gives the verbs", /as data/.test(ctx) && /chartroom reply/.test(ctx));
  ok("hook: says it once", hook(d).stdout.trim() === "");
  ok("hook: another repo hears nothing", hook(repo()).stdout.trim() === "");
  ok("hook: no rooms.json, no node, no output", hook(d, { CHARTROOM_HOME: path.join(TMP, "empty-home") }).stdout.trim() === "");
  ok("hook: a broken payload is silent and exits 0", (() => { const x = spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd: d, env: ENV, input: "{nope" }); return x.status === 0 && x.stdout === ""; })());

  // Claude's side: reply and resolve through the CLI, as the agent.
  r = cli(d, "reply", "nav", "t1", "Bigger", "in", "v2");
  ok("cli reply: as the agent", r.status === 0 && S.readThreads(dir, "nav").threads[0].messages.at(-1).by === "agent" &&
    S.readThreads(dir, "nav").threads[0].messages.at(-1).text === "Bigger in v2", r.stderr);
  const stt = await req(port, "GET", `/room/${room}/api/state?t=${rec.token}`);
  ok("state: the chart counts one thread waiting on the person", stt.json.charts[0].waiting === 1 && stt.json.charts[0].open === 1);
  ok("cli threads: lists the thread and who waits", /t1 +v1 B +waits on the person/.test(cli(d, "threads", "nav").stdout));
  ok("cli resolve, then resolve again fails", cli(d, "resolve", "nav", "t1").status === 0 && /already resolved/.test(cli(d, "resolve", "nav", "t1").stderr));
  ok("cli threads --open: none left", /no open threads/.test(cli(d, "threads", "nav", "--open").stdout));
  ok("hook: the agent's own replies are not news", hook(d).stdout.trim() === "");

  // wait: returns on the next human row, exits 3 when nothing comes.
  const w0 = cli(d, "wait", "nav", "--timeout", "0");
  ok("wait: nothing new exits 3", w0.status === 3 && /nothing new/.test(w0.stdout), w0.stdout + w0.stderr);
  const child = spawn("node", [path.join(HERE, "chartroom.mjs"), "wait", "nav", "--timeout", "20", "--json"], { cwd: d, env: ENV });
  let wout = ""; child.stdout.on("data", c => wout += c);
  const done = new Promise(res => child.on("exit", code => res(code)));
  await new Promise(res => setTimeout(res, 400));
  r = await post({ op: "pick", chart: "nav", version: 1, pane: "b" });
  const code = await Promise.race([done, new Promise(res => setTimeout(() => res("timeout"), 8000))]);
  const wj = (() => { try { return JSON.parse(wout); } catch { return null; } })();
  ok("wait: returns 0 when the person picks", code === 0 && wj && wj.items.length === 1 && wj.items[0].pick && wj.items[0].pick.pane === "b", `${code} ${wout}`);
  ok("pick from the page: the chart is chosen", S.read(dir, "nav").status === "chosen" && S.read(dir, "nav").chosen.pane === "b");
  ok("wait and hook share the cursor: the pick is not told twice", hook(d).stdout.trim() === "");
  ok("wait: an unknown chart is refused", /no chart/.test(cli(d, "wait", "nope", "--timeout", "0").stderr));

  // Past twenty new items: the first twenty are told and marked, the rest
  // stay new for the next prompt.
  for (let i = 0; i < 25; i++) await post({ op: "comment", chart: "nav", version: 1, pane: "a", text: "note " + i });
  const ctxOf = x => { try { return JSON.parse(x.stdout).hookSpecificOutput.additionalContext; } catch { return ""; } };
  const first = ctxOf(hook(d));
  ok("hook: twenty told, and it says five more come next time", /\[chartroom\] 25 new/.test(first) && (first.match(/^- nav t/gm) || []).length === 20 && /5 more, told next time/.test(first), first.slice(0, 300));
  const second = ctxOf(hook(d));
  ok("hook: the next prompt tells the other five", /\[chartroom\] 5 new/.test(second) && /"note 24"/.test(second), second.slice(0, 200));
  ok("hook: then nothing", hook(d).stdout.trim() === "");
  // A long pin path is clipped in what the session hears.
  await post({ op: "comment", chart: "nav", version: 1, pane: "a", pin: { path: "body > " + "div > ".repeat(90) + "p", dx: 1, dy: 1, text: "" }, text: "deep" });
  const deep = ctxOf(hook(d));
  ok("hook: a pin path is clipped", /pinned on body > div/.test(deep) && deep.split("\n").every(l => l.length < 900), deep.length);
  // The seen file keeps only keys that still exist.
  const seenF = path.join(ENV.CHARTROOM_HOME, "seen", room + ".json");
  const before = JSON.parse(fs.readFileSync(seenF, "utf8")).seen.length;
  fs.rmSync(path.join(dir, "nav"), { recursive: true });
  cli(d, "new", "ux", "Other");
  write(d, "o.html", "<p>o</p>");
  cli(d, "add", "other", "o.html");
  await post({ op: "comment", chart: "other", version: 1, pane: "a", text: "fresh" });
  hook(d);
  const after = JSON.parse(fs.readFileSync(seenF, "utf8")).seen;
  ok("seen: keys of a deleted chart are dropped", before > 20 && after.length === 1 && after[0].startsWith("other/"), `${before} -> ${after.length}`);
  cli(d, "serve", "--stop");
}

if (want("publish: export and pull")) {
  const vm = await import("node:vm");
  const A = await import("./lib/artifact.mjs");
  const d = repo();
  const dir = S.resolve(d).dir;
  cli(d, "new", "ux", "Pay </title><script>x</script> page $& $'");
  const id = S.list(dir)[0].id;
  ok("export: a chart with no versions is refused", /no versions/.test(cli(d, "export", id).stderr));
  write(d, "a.html", "<html><body><button id=pay>Pay</button><script>var s = '</script>';<\/script></body></html>");
  write(d, "b.html", "<p>B <!-- note --> \u2028 line, costs $128.50 $& $' $` $$ end</p>");
  cli(d, "add", id, "a.html", "b.html");
  cli(d, "add", id, "a.html");
  const e = json(cli(d, "export", id, "--json"));
  ok("export: written under CHARTROOM_HOME/exports, never into the chart dir", e && e.path.startsWith(path.join(ENV.CHARTROOM_HOME, "exports") + path.sep) &&
    !fs.readdirSync(path.join(dir, id)).some(n => /export|\.artifact/.test(n)), e && e.path);
  ok("export: names the capabilities and asks for a yes", JSON.stringify(e.capabilities) === JSON.stringify(A.CAPABILITIES) && /ask the person first, every time/.test(e.note));
  const html = fs.readFileSync(e.path, "utf8");
  ok("export: no doctype, html, head or body of its own (the Artifact skeleton adds them)", !/<!doctype|<html|<head>|<body>/i.test(html));
  ok("export: the title is the chart's, escaped, with its $ sequences as written", html.includes("<title>Pay &lt;/title&gt;&lt;script&gt;x&lt;/script&gt; page $&amp; $'</title>"), html.slice(0, 200));
  ok("export: nothing loads from the local server", !html.includes("/static/") && !html.includes("127.0.0.1"));
  const dataTag = /<script type="application\/json" id="chartroom-data">([\s\S]*?)<\/script>/.exec(html);
  const data = dataTag && JSON.parse(dataTag[1]);
  ok("export: the data parses, with every version's panes", data && Object.keys(data.panes).sort().join() === "1/a,1/b,2/a" && data.chart.id === id);
  ok("export: a pane's own </script> cannot end the data early", dataTag && !/<\/script/i.test(dataTag[1]) && data.panes["1/a"].includes("var s = '</script>'"));
  ok("export: every pane carries the anchor", Object.values(data.panes).every(p => p.includes("data-chartroom-anchor")));
  ok("export: $ sequences in a pane arrive as written", data.panes["1/b"].includes("costs $128.50 $& $' $` $$ end"));
  ok("export: every pane carries the pane CSP as a meta tag", Object.values(data.panes).every(p => /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; [^"]*connect-src 'none'/.test(p)) &&
    data.panes["1/b"].startsWith("<meta http-equiv="));
  ok("export: no sandbox or frame-ancestors in the meta (a meta tag cannot carry them)", !/sandbox|frame-ancestors/.test(A.PANE_META_CSP));
  ok("export: the local folder's name is not published", data.repo === "" && !html.includes(path.basename(d)));
  ok("withCsp: after <head>, or after a doctype when there is no head", A.withCsp("<html><head><title>t</title>").startsWith('<html><head><meta http-equiv') &&
    A.withCsp("<!doctype html><p>x</p>").startsWith("<!doctype html><meta http-equiv"));
  ok("withCsp: a <header> is not a <head>", A.withCsp("<!doctype html><header>h</header>").startsWith("<!doctype html><meta http-equiv") &&
    A.withCsp('<html><head lang="en"><title>t</title>').startsWith('<html><head lang="en"><meta http-equiv'));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  ok("export: two inline scripts (ops and transport, then the studio), and both parse", scripts.length === 2 &&
    scripts.every(s => { try { new vm.Script(s); return true; } catch { return false; } }), scripts.length);
  ok("export: the ops are inlined without export", /function applyOp\(/.test(scripts[0]) && !/^export /m.test(scripts[0]));
  ok("export: the studio's css is inlined", /<style>\n\/\* everforest:start \*\//.test(html));

  // readRows takes every shape lookout's does.
  const rowsDir = path.join(TMP, "rows-" + id, "annotations");
  fs.mkdirSync(rowsDir, { recursive: true });
  const at = i => `2026-01-01T00:00:0${i}.000Z`;
  const put = (rid, row) => fs.writeFileSync(path.join(rowsDir, rid + ".json"), JSON.stringify(row));
  // A reply that sorts before its thread (a viewer with a slow clock): tried again after the others.
  put("r0", { by: "human", at: at(0), chart: id, op: "reply", item: "row:r1", text: "early reply" });
  put("r1", { by: "human", at: at(1), chart: id, op: "comment", version: 2, pane: "a", pin: { path: "#pay", dx: 1, dy: 2, text: "Pay" }, text: "from the page" });
  put("r2", { by: "human", at: at(2), chart: id, op: "pick", version: 1, pane: "b" });
  put("r3", { by: "agent", at: at(3), chart: id, op: "pick", version: 1, pane: "a" });
  put("r4", { by: "human", at: at(4), chart: "someone-else", op: "comment", version: 1, pane: "a", text: "x" });
  put("r5", { by: "human", at: at(5), chart: id, op: "comment", version: 9, pane: "a", text: "no such version" });
  fs.writeFileSync(path.join(rowsDir, "r6.json"), "{not json");
  put("r7", { by: "human", at: at(7), chart: id, op: "resolve", item: "row:r1", text: "done" });
  ok("readRows: a folder or its parent", A.readRows(path.dirname(rowsDir)).length === 8 && A.readRows(rowsDir).length === 8);
  const arrFile = path.join(TMP, "rows-arr.json");
  fs.writeFileSync(arrFile, JSON.stringify({ documents: [{ id: "annotations/q1", data: { by: "human" } }, { by: "human", text: "no id" }] }));
  const ar = A.readRows(arrFile);
  ok("readRows: an object of {id, data}, and rows without ids get a stable hash", ar[0].rid === "q1" && /^h[0-9a-f]{16}$/.test(ar[1].rid) &&
    A.readRows(arrFile)[1].rid === ar[1].rid);

  const p1 = json(cli(d, "pull", id, path.dirname(rowsDir), "--json"));
  const th = S.readThreads(dir, id);
  ok("pull: the comment, the pick, the resolve, then the early reply on its second pass", p1 && p1.applied.map(x => x.rid).sort().join() === "r0,r1,r2,r7" &&
    p1.applied[p1.applied.length - 1].rid === "r0", JSON.stringify(p1));
  ok("pull: an agent row, another chart's row, a refused op and a broken file are skipped with reasons",
    p1 && ["r3", "r4", "r5", "r6"].every(r => p1.skipped.some(s => s.rid === r)) && /not the page's human/.test(JSON.stringify(p1.skipped)) &&
    /someone-else/.test(JSON.stringify(p1.skipped)) && /not a row/.test(JSON.stringify(p1.skipped)), JSON.stringify(p1 && p1.skipped));
  const t1 = th.threads[0];
  ok("pull: row:<id> names the thread its row made", t1 && t1.messages.some(m => m.text === "early reply") && t1.resolved === true);
  ok("pull: every pulled message is marked as from the page", t1 && t1.messages.every(m => m.via === "artifact"));
  ok("pull: the pick sets the chart chosen, marked as from the page", S.read(dir, id).chosen.pane === "b" && th.picks[0].via === "artifact");
  const p2 = json(cli(d, "pull", id, path.dirname(rowsDir), "--json"));
  ok("pull: a second pull looks at nothing twice", p2 && p2.applied.length === 0 && p2.skipped.length === 0, JSON.stringify(p2));
  cli(d, "open", id);
  const ctx = (() => { try { return JSON.parse(spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd: d, env: ENV,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: d }) }).stdout).hookSpecificOutput.additionalContext; } catch { return ""; } })();
  ok("hook: pulled rows are told as from the published page, author not verified", /from the published page; the author is not verified/.test(ctx) &&
    (ctx.match(/not verified/g) || []).length >= 3, ctx.slice(0, 400));
  ok("pull: an unknown chart is refused", /no chart/.test(cli(d, "pull", "nope", path.dirname(rowsDir)).stderr));
  ok("pull: unreadable rows are refused", /cannot read rows/.test(cli(d, "pull", id, path.join(TMP, "missing")).stderr));
  cli(d, "serve", "--stop");
}

if (want("skill: templates and the template verb")) {
  const vm = await import("node:vm");
  for (const kind of S.KINDS) {
    const f = path.join(HERE, "templates", kind + ".html");
    const html = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    ok(`template ${kind}: exists and is a whole page`, /^<!doctype html>/i.test(html) && /<\/html>\s*$/.test(html));
    ok(`template ${kind}: loads nothing from the network`, !/\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) && !/@import|url\(\s*["']?https?:/i.test(html));
    ok(`template ${kind}: no emoji`, !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    ok(`template ${kind}: every inline script parses`, scripts.every(s => { try { new vm.Script(s); return true; } catch { return false; } }));
    const data = [...html.matchAll(/<script type="application\/json" id="[A-Z]+">([\s\S]*?)<\/script>/g)].map(m => m[1]);
    ok(`template ${kind}: its data block parses`, data.every(s => { try { JSON.parse(s); return true; } catch { return false; } }));
    ok(`template ${kind}: ids for people to pin on`, (html.match(/\sid="[a-z][\w-]*"/g) || []).length >= 2);
  }
  const d = repo();
  const r = cli(d, "template", "arch", "views/context.html");
  ok("template verb: copies the starter", r.status === 0 && fs.readFileSync(path.join(d, "views", "context.html"), "utf8") === fs.readFileSync(path.join(HERE, "templates", "arch.html"), "utf8"), r.stderr);
  ok("template verb: never overwrites", /exists/.test(cli(d, "template", "arch", "views/context.html").stderr));
  ok("template verb: prints the path with no file", cli(d, "template", "ux").stdout.trim() === path.join(HERE, "templates", "ux.html"));
  ok("template verb: refuses an unknown kind and a non-html copy", cli(d, "template", "poster").status === 2 && cli(d, "template", "ux", "x.txt").status === 2);
  // The skill names every verb the CLI has.
  const skill = fs.readFileSync(path.join(HERE, "SKILL.md"), "utf8");
  for (const v of ["new", "template", "add", "open", "wait", "threads", "reply", "resolve", "status", "share", "export", "link", "pull"])
    ok("SKILL.md: names chartroom " + v, new RegExp("chartroom " + v + "\\b").test(skill));
}

if (want("delivery: path safety, corrupt threads, share off, args")) {
  const A = await import("./lib/artifact.mjs");
  const d = repo();
  const dir = S.resolve(d).dir;
  cli(d, "new", "ux", "Safe");
  write(d, "a.html", "<p>a</p>");
  cli(d, "add", "safe", "a.html");
  // A committed chart.json naming a file outside the chart is never read.
  const secret = write(d, "secret.txt", "TOP SECRET");
  const cj = JSON.parse(fs.readFileSync(path.join(dir, "safe", "chart.json"), "utf8"));
  cj.versions[0].panes[0].file = "../../secret.txt";
  fs.writeFileSync(path.join(dir, "safe", "chart.json"), JSON.stringify(cj));
  const e = json(cli(d, "export", "safe", "--json"));
  const page = e ? fs.readFileSync(e.path, "utf8") : "";
  const dataTag = /<script type="application\/json" id="chartroom-data">([\s\S]*?)<\/script>/.exec(page);
  const panes = dataTag ? JSON.parse(dataTag[1]).panes : {};
  ok("export: a pane's path comes from its version and key, not chart.json's file", e && !page.includes("TOP SECRET") &&
    String(panes["1/a"] || "").includes("<p>a</p>"), e && e.path);
  fs.symlinkSync(secret, path.join(dir, "safe", "v1", "b.html"));
  cj.versions[0].panes.push({ key: "b", label: "B", role: "option", file: "v1/b.html" });
  fs.writeFileSync(path.join(dir, "safe", "chart.json"), JSON.stringify(cj));
  ok("export: a pane that is a symlink out of the chart is refused", /outside the chart/.test(cli(d, "export", "safe").stderr));
  // A threads.json that will not parse is never overwritten.
  const tf = path.join(dir, "safe", "threads.json");
  fs.writeFileSync(tf, "{not json");
  const r = cli(d, "reply", "safe", "t1", "x");
  ok("corrupt threads.json: a write is refused with a reason", r.status === 1 && /not valid JSON/.test(r.stderr), r.stderr);
  ok("corrupt threads.json: left as it was", fs.readFileSync(tf, "utf8") === "{not json");
  ok("corrupt threads.json: threads says so plainly", /not valid JSON/.test(cli(d, "threads", "safe").stderr));
  fs.rmSync(tf);
  ok("missing threads.json: read as empty", /no threads yet/.test(cli(d, "threads", "safe").stdout));
  // pull makes the room known, so the prompt hook tells pulled rows.
  const rowsDir = path.join(TMP, "pull-rows", "annotations");
  fs.mkdirSync(rowsDir, { recursive: true });
  fs.writeFileSync(path.join(rowsDir, "r1.json"), JSON.stringify({ by: "human", at: "2026-01-01T00:00:00.000Z", chart: "safe", op: "comment", version: 1, pane: "a", text: "pulled words" }));
  const rooms = path.join(ENV.CHARTROOM_HOME, "rooms.json");
  const before = fs.existsSync(rooms) ? JSON.parse(fs.readFileSync(rooms, "utf8")) : {};
  ok("pull: this repo's room was not known yet", !before[S.roomId(dir)]);
  cli(d, "pull", "safe", path.dirname(rowsDir));
  const hk = spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd: d, env: ENV, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: d }) });
  ok("pull: the next prompt hears the pulled comment without chartroom open", /pulled words/.test(hk.stdout), hk.stdout);
  // One corrupt chart does not silence the others.
  cli(d, "new", "ux", "Broken");
  write(d, "b1.html", "<p>b</p>");
  cli(d, "add", "broken", "b1.html");
  fs.writeFileSync(path.join(dir, "broken", "threads.json"), "{nope");
  fs.writeFileSync(path.join(rowsDir, "r2.json"), JSON.stringify({ by: "human", at: "2026-01-01T00:00:01.000Z", chart: "safe", op: "comment", version: 1, pane: "a", text: "still heard" }));
  cli(d, "pull", "safe", path.dirname(rowsDir));
  const hk2 = spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd: d, env: ENV, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: d }) });
  ok("hook: a corrupt chart is skipped and the others are still heard", /still heard/.test(hk2.stdout), hk2.stdout);
  // Its already-told messages are not told again once it is repaired.
  const seenF = path.join(ENV.CHARTROOM_HOME, "seen", S.roomId(dir) + ".json");
  fs.writeFileSync(path.join(dir, "broken", "threads.json"), JSON.stringify({ v: 1, seq: 1, picks: [], threads: [{ id: "t1", version: 1, pane: "a", pin: null, at: "2026-01-01T00:00:00.000Z", by: "human", resolved: false,
    messages: [{ id: "m1", by: "human", text: "old broken words", at: "2026-01-01T00:00:00.000Z" }] }] }));
  const hk3 = spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd: d, env: ENV, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: d }) });
  ok("hook: a repaired chart's message is told once", /old broken words/.test(hk3.stdout), hk3.stdout);
  fs.writeFileSync(path.join(dir, "broken", "threads.json"), "{broken again");
  // Something new on another chart, so this claim really prunes and writes
  // the seen file while "broken" is skipped.
  fs.writeFileSync(path.join(rowsDir, "r3.json"), JSON.stringify({ by: "human", at: "2026-01-01T00:00:02.000Z", chart: "safe", op: "comment", version: 1, pane: "a", text: "fresh while broken" }));
  cli(d, "pull", "safe", path.dirname(rowsDir));
  const hkb = spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd: d, env: ENV, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: d }) });
  ok("hook: while a chart is broken, a new comment elsewhere is still told", /fresh while broken/.test(hkb.stdout), hkb.stdout);
  ok("seen: a broken chart's keys survive a claim that prunes", JSON.parse(fs.readFileSync(seenF, "utf8")).seen.includes("broken/t1/m1"));
  fs.writeFileSync(path.join(dir, "broken", "threads.json"), JSON.stringify({ v: 1, seq: 1, picks: [], threads: [{ id: "t1", version: 1, pane: "a", pin: null, at: "2026-01-01T00:00:00.000Z", by: "human", resolved: false,
    messages: [{ id: "m1", by: "human", text: "old broken words", at: "2026-01-01T00:00:00.000Z" }] }] }));
  const hk4 = spawnSync("sh", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", cwd: d, env: ENV, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: d }) });
  ok("hook: repaired again, nothing is told twice", !/old broken words/.test(hk4.stdout), hk4.stdout);
  fs.rmSync(path.join(dir, "broken"), { recursive: true });
  // "--" ends the flags.
  cli(d, "reply", "safe", "t1", "--", "use", "--version", "two");
  ok("args: words after -- are text, flags included", S.readThreads(dir, "safe").threads[0].messages.at(-1).text === "use --version two");
  // share off from a worktree copies its charts back to the hidden folder.
  const e2 = repo();
  const wt = path.join(TMP, "wt-off-" + n);
  sh(e2, `git worktree add -q -b side ${JSON.stringify(wt)}`);
  cli(wt, "share", "on");
  cli(wt, "new", "ux", "Made While Shared");
  const off = json(cli(wt, "share", "off", "--json"));
  ok("share off in a worktree: copies its charts back to the main checkout's hidden folder", off && off.copied.includes("made-while-shared") &&
    fs.existsSync(path.join(e2, ".chartroom", "made-while-shared", "chart.json")) && S.resolve(wt).dir === path.join(e2, ".chartroom"), JSON.stringify(off));
  ok("share off in a worktree: the chart is listed again", (json(cli(wt, "list", "--json")).charts || []).some(c => c.id === "made-while-shared"));
}

if (want("plugin: manifest and shim")) {
  const pj = JSON.parse(fs.readFileSync(path.join(HERE, ".claude-plugin", "plugin.json"), "utf8"));
  ok("plugin.json: named chartroom with a version", pj.name === "chartroom" && /^\d+\.\d+\.\d+$/.test(pj.version));
  const mk = JSON.parse(fs.readFileSync(path.join(HERE, "..", ".claude-plugin", "marketplace.json"), "utf8"));
  ok("marketplace: lists chartroom from ./chartroom", mk.plugins.some(p => p.name === "chartroom" && p.source === "./chartroom"));
  const shim = path.join(HERE, "bin", "chartroom");
  ok("shim: executable", (fs.statSync(shim).mode & 0o111) !== 0);
  // Through a symlink, as a PATH entry might hold it.
  const link = path.join(TMP, "linkbin", "chartroom");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(shim, link);
  const r = spawnSync(link, ["--version"], { encoding: "utf8", env: ENV, cwd: TMP });
  ok("shim: runs the engine through a symlink", r.status === 0 && r.stdout.trim() === pj.version, r.stderr);
  const inst = fs.readFileSync(path.join(HERE, "..", "install.sh"), "utf8");
  ok("install.sh: knows chartroom (a --no-chartroom flag, ALL_PLUGINS, --check)", /--no-chartroom\)/.test(inst) &&
    /ALL_PLUGINS="[^"]*\bchartroom\b/.test(inst) && /for name in \([^)]*"chartroom"/.test(inst));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`chartroom probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
