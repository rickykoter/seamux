#!/usr/bin/env node
// chartroom: charts (UX mocks, architecture views, domain explorers) kept
// with the repo, shown in a local studio, and published only on a yes.
//
// Every verb works on the chart dir lib/store.mjs resolves from the cwd.
// Output is plain text for people; --json gives the same facts to a script.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as S from "./lib/store.mjs";
import { hostLine, detectHost, sessionIds } from "./lib/host.mjs";
import * as SV from "./lib/serve.mjs";
import * as N from "./lib/news.mjs";
import * as A from "./lib/artifact.mjs";
import { waitsOnPerson } from "./lib/ops.mjs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, ".claude-plugin", "plugin.json"), "utf8")).version;

const USAGE = `chartroom ${VERSION}: charts kept with the repo, reviewed in a local studio

  chartroom new <ux|arch|domain> <title> [--purpose TEXT] [--id ID]
  chartroom template <ux|arch|domain> [file.html]   copy the kind's starter page (or print its path)
  chartroom add <id> <pane>... [--option|--view] [--note TEXT]
                 a pane is FILE.html, KEY=FILE.html or KEY:Label=FILE.html
  chartroom list [--json]
  chartroom show <id> [--json]
  chartroom status <id> <exploring|chosen|superseded> [--decision TEXT]
  chartroom export <id> [--json]           a page to publish as an Artifact, only on the person's yes
  chartroom link <id> <claude.ai artifact url> [--version N]
  chartroom pull <id> <rows dir or file>    replay the published page's comments and picks
  chartroom threads <id> [--open] [--json]
  chartroom reply <id> <t#> <text>        put -- before text that holds words starting with --
  chartroom resolve|reopen <id> <t#> [text]
  chartroom wait [id] [--timeout SECONDS]   until the person comments or picks (exit 3: nothing yet)
  chartroom share [on|off|status]
  chartroom open [id] [--no-open] [--json]   the studio, beside the terminal where it can be
  chartroom serve [--status|--stop|--foreground]
  chartroom doctor [--json]
`;

// ------------------------------------------------------------ args

const argv = process.argv.slice(2);
// A bare --version is the engine's version; link's --version N is a flag.
const verb = argv[0] && !argv[0].startsWith("-") ? argv[0] : (argv[0] === "--version" ? "version" : "help");
const rest = verb === "version" && argv[0] === "--version" ? [] : argv.slice(verb === argv[0] ? 1 : 0);
const VALUED = new Set(["--purpose", "--id", "--note", "--decision", "--version", "--timeout"]);
const flags = {}, pos = [];
// "--" ends the flags: everything after it is words, so a title or a reply
// can hold "--" words (chartroom reply id t1 -- --version is wrong).
let words = false;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (words) { pos.push(a); continue; }
  if (a === "--") { words = true; continue; }
  if (VALUED.has(a)) {
    if (i + 1 >= rest.length) die(`${a} needs a value`, 2);
    flags[a.slice(2)] = rest[++i];
  } else if (a.startsWith("--")) flags[a.slice(2)] = true;
  else pos.push(a);
}
const JSON_OUT = !!flags.json;

function die(msg, code = 1) { process.stderr.write("chartroom: " + msg + "\n"); process.exit(code); }
function out(obj, text) { process.stdout.write(JSON_OUT ? JSON.stringify(obj, null, 2) + "\n" : text.replace(/\n?$/, "\n")); }

let loc;
function where() {
  if (!loc) { try { loc = S.resolve(process.cwd()); } catch (e) { die(e.message); } }
  return loc;
}
const rel = p => { const r = path.relative(process.cwd(), p); return r && !r.startsWith("..") ? r : p; };

function need(n, what) { if (pos.length < n) die(`${verb} needs ${what} (chartroom help)`, 2); }

function describe(c) {
  const last = c.versions[c.versions.length - 1];
  const panes = last ? last.panes.map(p => p.role === "option" ? `[${p.key}] ${p.label}` : p.label).join(", ") : "no versions yet";
  const pub = (c.published || []).length ? `\n  published: ${c.published.map(p => `${p.url} (v${p.version})`).join(", ")}` : "";
  const chose = c.chosen ? ` (option ${c.chosen.pane} of v${c.chosen.version})` : "";
  return `${c.id}  ${c.kind}  ${c.status}${chose}  ${c.title}\n` +
    (c.purpose ? `  purpose: ${c.purpose}\n` : "") +
    (c.decision ? `  decision: ${c.decision}\n` : "") +
    `  versions: ${c.versions.length}${last ? ` (latest v${last.n}: ${panes})` : ""}` + pub;
}

// The workspace's companion pane under cmux (crew-board companion.rs), when
// seamux is installed; false otherwise. Best-effort, never a failure.
function companionOpen(url, room) {
  const bin = process.env.SEAMUX_BIN || path.join(os.homedir(), ".local", "bin", "seamux");
  const ws = sessionIds().workspace;
  if (!ws || !fs.existsSync(bin)) return false;
  const args = ["companion", "open", url, "--key", "chartroom-" + room, "--workspace", ws];
  if (process.env.CMUX_SURFACE_ID) args.push("--surface", process.env.CMUX_SURFACE_ID);
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 20000, env: { ...process.env, CMUX_QUIET: "1" } });
  return r.status === 0;
}

// reply, resolve and reopen, as Claude (by "agent").
function threadOp(op) {
  need(op === "reply" ? 3 : 2, op === "reply" ? "a chart id, a thread and the text" : "a chart id and a thread");
  const [id, item, ...words] = pos;
  const l = where();
  let code, res;
  try { [code, res] = S.applyChartOp(l.dir, id, { op, item, text: words.join(" ") }, "agent"); } catch (e) { die(e.message); }
  if (code !== 200) die(res.error || "refused");
  out({ ok: true, item: res.item }, `${id} ${res.item}: ${op === "reply" ? "replied" : op === "resolve" ? "resolved" : "reopened"}`);
}

// ------------------------------------------------------------ verbs

const verbs = {
  help() { process.stdout.write(USAGE); },
  version() { process.stdout.write(VERSION + "\n"); },

  new() {
    need(2, "a kind and a title");
    const [kind, ...words] = pos;
    const l = where();
    S.prepare(l);
    let c;
    try { c = S.create(l.dir, { kind, title: words.join(" "), purpose: flags.purpose || "", id: flags.id || "" }); }
    catch (e) { die(e.message); }
    out({ chart: c, dir: l.dir, mode: l.mode },
      `made ${c.id} (${c.kind}) in ${rel(path.join(l.dir, c.id))}\n` +
      `next: write its panes as .html files, then chartroom add ${c.id} <file>...`);
  },

  template() {
    need(1, "a kind");
    const kind = pos[0];
    if (!S.KINDS.includes(kind)) die(`kind must be one of ${S.KINDS.join(", ")}`, 2);
    const src = path.join(HERE, "templates", kind + ".html");
    if (!pos[1]) return out({ kind, path: src }, src);
    const dest = path.resolve(pos[1]);
    if (!/\.html?$/i.test(dest)) die("the copy must be an .html file", 2);
    if (fs.existsSync(dest)) die(`${pos[1]} exists; pick another name`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    out({ kind, path: dest, from: src }, `wrote ${rel(dest)} from the ${kind} starter; edit it, then chartroom add <id> ${rel(dest)}`);
  },

  add() {
    need(2, "a chart id and at least one pane file");
    const [id, ...files] = pos;
    if (flags.option && flags.view) die("pick one of --option and --view", 2);
    const l = where();
    S.prepare(l);
    let c;
    try {
      c = S.addVersion(l.dir, id, files.map(S.parsePane), { role: flags.option ? "option" : flags.view ? "view" : "", note: flags.note || "" });
    } catch (e) { die(e.message); }
    const v = c.versions[c.versions.length - 1];
    out({ chart: c, version: v },
      `${c.id} v${v.n}: ${v.panes.map(p => `${p.key} (${p.role})`).join(", ")}`);
  },

  list() {
    const l = where();
    const cs = S.list(l.dir);
    out({ dir: l.dir, mode: l.mode, charts: cs },
      cs.length ? cs.map(describe).join("\n") : `no charts yet in ${rel(l.dir)} (chartroom new <kind> <title>)`);
  },

  show() {
    need(1, "a chart id");
    const l = where();
    let c;
    try { c = S.read(l.dir, pos[0]); } catch (e) { die(e.message); }
    const files = c.versions.map(v => `  v${v.n} ${v.at}${v.note ? ": " + v.note : ""}\n` +
      v.panes.map(p => `    ${p.key}  ${p.role}  ${p.label}  ${rel(path.join(l.dir, c.id, p.file))}`).join("\n")).join("\n");
    out({ chart: c, dir: path.join(l.dir, c.id) }, describe(c) + (files ? "\n" + files : ""));
  },

  status() {
    need(2, "a chart id and a status");
    const l = where();
    let c;
    try { c = S.setStatus(l.dir, pos[0], pos[1], flags.decision); } catch (e) { die(e.message); }
    out({ chart: c }, describe(c));
  },

  link() {
    need(2, "a chart id and its published url");
    const l = where();
    let c;
    try { c = S.link(l.dir, pos[0], pos[1], flags.version); } catch (e) { die(e.message); }
    out({ chart: c }, describe(c));
  },

  export() {
    need(1, "a chart id");
    const l = where();
    let r;
    try { r = A.exportPage(l, pos[0]); } catch (e) { die(e.message); }
    out(r, `wrote ${r.path} (${Math.round(r.bytes / 1024)} KB)\n` +
      `capabilities: ${JSON.stringify(r.capabilities)}\n${r.note}`);
  },

  pull() {
    need(2, "a chart id and the rows (an ArtifactData out_dir, or a JSON file)");
    const l = where();
    let rows, r;
    try { rows = A.readRows(pos[1]); } catch (e) { die(`cannot read rows from ${pos[1]}: ${e.message}`); }
    try { r = A.pull(l, pos[0], rows); } catch (e) { die(e.message); }
    // The prompt hook speaks only for rooms it knows; a repo that never ran
    // chartroom open (a cloud session, say) is added so pulled rows are heard.
    try { SV.addRoom(l); } catch { /* the pull itself stands */ }
    out(r, `${pos[0]}: ${r.applied.length} applied, ${r.skipped.length} skipped` +
      r.skipped.map(x => `\n  skipped ${x.rid}: ${x.why}`).join("") +
      (r.applied.length ? "\nthe session hears them at its next prompt, marked as from the published page" : ""));
  },

  threads() {
    need(1, "a chart id");
    const l = where();
    if (!S.exists(l.dir, pos[0])) die(`no chart ${pos[0]} in ${rel(l.dir)}`);
    let th;
    try { th = S.readThreads(l.dir, pos[0]); } catch (e) { die(e.message); }
    const list = th.threads.filter(t => !flags.open || !t.resolved);
    const text = list.length ? list.map(t => {
      const head = `${t.id}  v${t.version} ${t.pane.toUpperCase()}  ${t.resolved ? "resolved" : waitsOnPerson(t) ? "waits on the person" : "open"}` +
        (t.pin ? `  pin: ${t.pin.text ? JSON.stringify(t.pin.text) : t.pin.path}` : "  (whole pane)");
      return head + "\n" + t.messages.map(m => `    ${m.by}${m.kind === "status" ? " marked it " + m.to : ""}: ${m.text}`.replace(/: $/, "")).join("\n");
    }).join("\n") : (flags.open ? "no open threads" : "no threads yet");
    out({ threads: list, picks: th.picks }, text);
  },

  reply() { threadOp("reply"); },
  resolve() { threadOp("resolve"); },
  reopen() { threadOp("reopen"); },

  wait() {
    const l = where();
    const id = pos[0] || "";
    if (id && !S.exists(l.dir, id)) die(`no chart ${id} in ${rel(l.dir)}`);
    const room = S.roomId(l.dir);
    const secs = flags.timeout === undefined ? 1800 : Number(flags.timeout);
    if (!Number.isFinite(secs) || secs < 0) die("--timeout takes seconds", 2);
    const end = Date.now() + secs * 1000;
    const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (;;) {
      const { shown, total } = N.claim(l.dir, room, id);
      if (shown.length) {
        return out({ total, items: shown.map(x => ({ key: x.key, chart: x.chart.id, thread: x.thread ? x.thread.id : null, text: x.msg ? x.msg.text : null, pick: x.pick || null })) },
          N.describe(shown, total));
      }
      if (Date.now() >= end) { out({ items: [] }, `nothing new from the person in ${secs}s`); process.exit(3); }
      sleep(Math.min(1000, Math.max(0, end - Date.now())));
    }
  },

  share() {
    const what = pos[0] || "status";
    const l = where();
    if (what === "status") {
      return out({ dir: l.dir, mode: l.mode, shared: l.shared, why: l.why },
        `${l.shared ? "shared" : "not shared"}: ${rel(l.dir)} (${l.why})`);
    }
    let r;
    try { r = what === "on" ? S.shareOn(l) : what === "off" ? S.shareOff(l) : die("share takes on, off or status", 2); }
    catch (e) { die(e.message); }
    if (what === "on") {
      out(r, (r.note ? r.note : `shared: ${rel(r.dir)} is no longer excluded; commit it to carry the charts to other clones`) +
        (r.copied.length ? `\ncopied from the main checkout's hidden folder: ${r.copied.join(", ")}` : "") +
        "\nshared charts carry their comments and picks into git too");
    } else {
      out(r, `not shared: ${S.EXCLUDE_LINE} is excluded again` +
        (r.copied && r.copied.length ? `\ncopied this worktree's charts back to the main checkout's hidden folder: ${r.copied.join(", ")}` : "") +
        (r.tracked ? `\n.chartroom/ still holds committed files, so git keeps them; git rm -r --cached .chartroom stops that` : ""));
    }
  },

  open() {
    const l = where();
    const id = pos[0] || "";
    if (id && !S.exists(l.dir, id)) die(`no chart ${id} in ${rel(l.dir)} (chartroom list)`);
    const h = detectHost();
    if (h.host === "remote") {
      return out({ host: h.host, url: "" }, "no live page on this host (host: remote): nobody can reach this sandbox's localhost; " +
        "chartroom export makes a page to publish, on the person's yes");
    }
    const rec = SV.ensureServer({ cli: path.join(HERE, "chartroom.mjs") });
    if (!rec) die(`chartroom serve did not start (see ${SV.logFile()})`);
    const room = SV.addRoom(l);
    const url = SV.urlFor(rec, `/room/${room}/`) + (id ? "#" + id : "");
    let opened = false, how = "";
    if (!flags["no-open"]) {
      if (h.host === "cmux") { opened = companionOpen(url, room); how = opened ? "opened beside the terminal" : ""; }
      else if (h.host === "seamux") how = "click it in the terminal to open it in the Dock beside this session";
      else if (h.host === "desktop") how = "open it in the browser pane (preview_start)";
    }
    out({ url, host: h.host, opened, room },
      `served at ${url} (host: ${h.host})` + (how ? `\n  ${how}` : ""));
  },

  serve() {
    if (flags.foreground) {
      SV.serveForeground({ version: VERSION, root: HERE });
      return;
    }
    if (flags.stop) { const stopped = SV.stopServer(); return out({ stopped }, stopped ? "stopped" : "no chartroom server was running"); }
    const rec = flags.status ? SV.liveServer() : SV.ensureServer({ cli: path.join(HERE, "chartroom.mjs") });
    if (!rec) return flags.status ? out({ running: false }, "no chartroom server is running") : die(`chartroom serve did not start (see ${SV.logFile()})`);
    out({ running: true, port: rec.port, pid: rec.pid, root: rec.root, version: rec.version },
      `chartroom serve: http://127.0.0.1:${rec.port} (pid ${rec.pid}, ${rec.root})`);
  },

  doctor() {
    const l = where();
    const h = detectHost();
    const n = S.list(l.dir).length;
    const ex = l.git ? S.excluded(l.git) : null;
    out({ version: VERSION, engine: HERE, host: h.host, hostWhy: h.why, dir: l.dir, mode: l.mode, shared: l.shared,
      excluded: ex, charts: n, node: process.version },
      `chartroom ${VERSION} (${HERE})\n${hostLine()}\ndir: ${l.dir}\n  ${l.why}` +
      (l.mode === "hidden" ? `\n  exclude line: ${ex ? "present" : "added on the first write"}` : "") +
      `\ncharts: ${n}\nnode: ${process.version}`);
  },
};

if (!verbs[verb]) die(`unknown verb ${verb}\n\n${USAGE}`, 2);
verbs[verb]();
