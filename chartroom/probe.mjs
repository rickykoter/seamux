#!/usr/bin/env node
// chartroom probe: one command, no arguments, throwaway everything. Every
// repo, chart and home dir lands under a temp dir; the real ~/.claude is never
// written and nothing touches the network. `-v` lists every assertion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
  const r = cli(d, "new", "ux", "Checkout", "--json");
  ok("new: exit 0 and the chart as JSON", r.status === 0 && json(r)?.chart?.id === "checkout", r.stderr);
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
