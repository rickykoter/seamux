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
import { hostLine, detectHost } from "./lib/host.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, ".claude-plugin", "plugin.json"), "utf8")).version;

const USAGE = `chartroom ${VERSION}: charts kept with the repo, reviewed in a local studio

  chartroom new <ux|arch|domain> <title> [--purpose TEXT] [--id ID]
  chartroom add <id> <pane>... [--option|--view] [--note TEXT]
                 a pane is FILE.html, KEY=FILE.html or KEY:Label=FILE.html
  chartroom list [--json]
  chartroom show <id> [--json]
  chartroom status <id> <exploring|chosen|superseded> [--decision TEXT]
  chartroom link <id> <claude.ai artifact url> [--version N]
  chartroom share [on|off|status]
  chartroom doctor [--json]
`;

// ------------------------------------------------------------ args

const argv = process.argv.slice(2);
// A bare --version is the engine's version; link's --version N is a flag.
const verb = argv[0] && !argv[0].startsWith("-") ? argv[0] : (argv[0] === "--version" ? "version" : "help");
const rest = verb === "version" && argv[0] === "--version" ? [] : argv.slice(verb === argv[0] ? 1 : 0);
const VALUED = new Set(["--purpose", "--id", "--note", "--decision", "--version"]);
const flags = {}, pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
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
        (r.tracked ? `\n.chartroom/ still holds committed files, so git keeps them; git rm -r --cached .chartroom stops that` : ""));
    }
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
