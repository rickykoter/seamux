#!/usr/bin/env node
// lookout — review a diff in a browser pane beside the terminal.
//
// A review is a source (a base, a range, the working tree, a patch file), the
// diff it yields, and what people say about it. `lookout open` builds the diff
// without touching the real git index, stores the review under
// ~/.claude/plans/reviews/<id>.json, draws the page, and puts it in a browser
// tab beside the terminal. The page is VS Code's Source Control layout: the
// changed files on the left, one file's split or unified diff on the right,
// highlighted whole-file so a hunk inside a block comment still reads right.
//
// deep-plan reaches lookout only through this CLI and its exit codes; it never
// reads the store (ADR 0004: a plugin cannot import another's libs).
//
// Exit codes:
//   0  done
//   1  refused or failed (the reason is on stderr)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as V from "./lib/vendor.mjs";
import * as S from "./lib/store.mjs";
import { resolveSource, buildPatch, parsePatch, sideText, buildRows, looksGenerated,
         generatedByAttr, LARGE_LINES } from "./lib/patch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- argv
const argv = process.argv.slice(2);
const verb = argv.includes("--help") || argv.includes("-h") ? "help"
  : argv.find(a => !a.startsWith("-")) || "help";
const rest = argv.slice(argv.indexOf(verb) + 1);
const flag = n => rest.includes("--" + n);
const opt = (n, d = null) => {
  const i = rest.indexOf("--" + n);
  return i >= 0 && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[i + 1] : d;
};
// Options that take a value; every other --flag stands alone.
const VALUED = new Set(["--base", "--range", "--patch", "--id", "--title", "--plan", "--inc", "--at"]);
const positional = () => rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(rest[i - 1])));

const say = s => process.stdout.write(s + "\n");
function die(msg, code = 1) { process.stderr.write("lookout: " + msg + "\n"); process.exit(code); }

// ---------------------------------------------------------------- page

const pageTitle = id => "lookout · " + id;

// JSON inside a <script> element: nothing in it may close the element or open
// a comment, whatever the diff contains.
const scriptJson = v => JSON.stringify(v).replace(/</g, "\\u003c")
  .replace(/[\u2028\u2029]/g, c => "\\u" + c.charCodeAt(0).toString(16));

// The page is one self-contained file: template, styles, script and data
// inlined, so it opens from disk as well as from the intent server.
export function renderPage(id) {
  const r = S.read(id);
  const p = S.paths(id);
  let rows = {};
  try { rows = JSON.parse(fs.readFileSync(p.rows, "utf8")); } catch { /* drawn without rows */ }
  const tpl = fs.readFileSync(path.join(HERE, "page", "review.html"), "utf8");
  const css = fs.readFileSync(path.join(HERE, "page", "review.css"), "utf8");
  const js = fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8");
  // One pass over the template, so a placeholder that appears INSIDE the
  // substituted content (a review of this very file does) is never rescanned.
  const fill = {
    "__TITLE__": () => V.escapeHtml(pageTitle(id)),
    "/*__CSS__*/": () => css,
    "__DATA__": () => scriptJson({ review: r, rows }),
    "/*__JS__*/": () => js.replace(/<\/script/gi, "<\\/script"),
  };
  const html = tpl.replace(/__TITLE__|\/\*__CSS__\*\/|__DATA__|\/\*__JS__\*\//g, m => fill[m]());
  S.writeAtomic(p.html, html);
  return p.html;
}

// ---------------------------------------------------------------- open

// The cmux workspace to put the page in: the caller's own, else the one the
// board lists for this directory.
function workspaceFor(cwd) {
  if (process.env.CMUX_WORKSPACE_ID) return process.env.CMUX_WORKSPACE_ID;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cache", "cmux-crew", "board-targets.json"), "utf8"));
    const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    return Object.keys(t).find(k => t[k] && t[k].cwd && real(t[k].cwd) === real(cwd)) || "";
  } catch { return ""; }
}

// Best-effort, never a failure: a tab already showing this review is pointed
// at the page again (a re-open refreshes, it does not stack tabs); otherwise a
// new browser tab opens beside the terminal without taking focus.
function showPage(id, file, cwd) {
  if (process.env.LOOKOUT_REVIEWS_DIR || flag("no-open")) return "";
  const ws = workspaceFor(cwd);
  if (!ws) return "";
  const url = "file://" + encodeURI(file);
  const env = { ...process.env, CMUX_QUIET: "1" };
  try {
    const r = spawnSync("cmux", ["list-panels", "--workspace", ws, "--json"], { encoding: "utf8", env, timeout: 10000 });
    const tab = (JSON.parse(r.stdout || "{}").surfaces || [])
      .find(s => s.type === "browser" && s.title === pageTitle(id));
    if (tab) {
      const n = spawnSync("cmux", ["browser", "--surface", tab.ref, "navigate", url], { encoding: "utf8", env, timeout: 10000 });
      if (n.status === 0) return "refreshed the open tab";
    }
  } catch { /* fall through to a new tab */ }
  const o = spawnSync("cmux", ["open", file, "--workspace", ws, "--focus", "false"], { encoding: "utf8", env, timeout: 10000 });
  return o.status === 0 ? "opened beside the terminal" : "";
}

function cmdOpen() {
  const cwd = path.resolve(opt("at", process.cwd()));
  const o = { base: opt("base"), range: opt("range"), patch: opt("patch"), worktree: flag("worktree"),
              plan: opt("plan"), inc: opt("inc") };
  if ([o.base, o.range, o.patch, o.worktree || null].filter(Boolean).length > 1)
    die("pick one of --base, --range, --patch, --worktree");
  let src;
  try { src = resolveSource(o, cwd); } catch (e) { die(e.message); }
  const id = opt("id") || S.defaultId(src, o);
  if (!S.ID_OK.test(id)) die("not a usable review id: " + id + " (lowercase letters, digits, . _ -)");

  const text = buildPatch(src);
  const files = parsePatch(text);
  const gen = src.kind === "patch" ? new Set() : generatedByAttr(src.root, files.map(f => f.path));
  const plain = flag("plain") || !!V.hljsMissing();
  const rows = {};
  const meta = files.map(f => {
    const changed = f.adds + f.dels;
    const generated = looksGenerated(f.path) || gen.has(f.path);
    const large = changed > LARGE_LINES;
    // A file the page starts collapsed is drawn plain: nobody reads a lockfile
    // for its colors, and highlighting thousands of rows is the slow part.
    const drawn = buildRows(f, (generated || large || f.binary) ? null : sideText(src, "old", f),
      (generated || large || f.binary) ? null : sideText(src, "new", f), { plain: plain || generated || large });
    rows[f.path] = drawn;
    return { path: f.path, oldPath: f.oldPath, status: f.status, adds: f.adds, dels: f.dels,
             binary: f.binary, generated, large, hunks: f.hunks.length, lang: drawn.lang || "",
             collapsed: f.binary || generated || large || !!drawn.note };
  });

  const p = S.paths(id);
  const fresh = {
    id, title: opt("title") || (o.plan ? `${o.plan} · increment ${o.inc}` : src.label),
    source: { ...src, plan: o.plan || undefined, inc: o.inc ? Number(o.inc) : undefined },
    patchHash: S.patchHash(text),
    stats: { files: meta.length, adds: meta.reduce((x, f) => x + f.adds, 0), dels: meta.reduce((x, f) => x + f.dels, 0) },
    files: meta,
    highlight: plain ? (flag("plain") ? "off" : V.hljsMissing()) : "highlight.js " + V.HLJS_VERSION,
  };
  if (flag("agent-may-close")) fresh.policy = { agentMayClose: true };
  const review = S.update(id, cur => {
    const m = S.merge(cur, fresh);
    m.policy = { agentMayClose: false, ...(m.policy || {}) };
    return m;
  });
  S.writeAtomic(p.patch, text);
  S.writeAtomic(p.rows, JSON.stringify(rows));
  const page = renderPage(id);
  const shown = showPage(id, page, src.root || cwd);
  if (flag("json")) {
    process.stdout.write(JSON.stringify({ id, page, store: p.json, patch: p.patch, files: meta.length,
      shown: shown || null, highlight: review.highlight }, null, 2) + "\n");
    return;
  }
  say(`lookout ${id}: ${review.title}`);
  say(`  ${meta.length} file(s), +${review.stats.adds} −${review.stats.dels}` +
      (plain ? `  (no highlighting: ${review.highlight})` : ""));
  say(`  page:  ${page}${shown ? "  (" + shown + ")" : ""}`);
  say(`  store: ${p.json}`);
}

// ---------------------------------------------------------------- the rest

function cmdSetup() {
  say(`  ok    engine pointer -> ${V.ENGINE_FILE} (root ${HERE})`);
  say("  " + V.installShim());
  if (!(process.env.PATH || "").split(":").includes(V.SHIM_DIR))
    say(`  warn  ${V.SHIM_DIR} is not on PATH; add it to call \`lookout\` from your own shell`);
  const h = V.fetchHljs();
  if (h.ok) say(`  ok    highlight.js ${V.HLJS_VERSION}: ${h.how} (${V.HLJS_HOME})`);
  else { say(`  FAIL  highlight.js: ${h.why}`); process.exitCode = 1; }
}

function reviewArg() {
  const id = positional()[0];
  if (!id) die(`${verb} wants a review id (lookout list)`);
  if (!S.ID_OK.test(id) || !S.exists(id)) die("no review " + id);
  return id;
}

function cmdShow() {
  const r = S.read(reviewArg());
  if (flag("json")) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }
  say(`${r.id}: ${r.title}`);
  for (const f of r.files)
    say(`  ${f.status} ${f.path}${f.oldPath ? " (from " + f.oldPath + ")" : ""}  +${f.adds} −${f.dels}` +
        (f.collapsed ? "  [collapsed" + (f.binary ? ": binary" : f.generated ? ": generated" : f.large ? ": large" : "") + "]" : ""));
}

function cmdList() {
  const all = S.list();
  if (flag("json")) {
    process.stdout.write(JSON.stringify(all.map(r => ({ id: r.id, title: r.title, root: r.source?.root,
      updatedAt: r.updatedAt, files: r.stats?.files })), null, 2) + "\n");
    return;
  }
  if (!all.length) { say("no reviews yet (lookout open)"); return; }
  for (const r of all) say(`  ${r.id}  ${r.title}  (${r.stats?.files ?? 0} files, ${r.updatedAt})`);
}

function usage() {
  say(`lookout — review a diff in a browser pane beside the terminal

  lookout open [--base REF | --worktree | --range A..B | --patch FILE]
               [--id ID] [--title T] [--plan SLUG --inc N] [--agent-may-close]
               [--plain] [--no-open] [--json]
        build the diff, store the review, draw the page and show it.
        Default: --base <origin's default branch, else main/master>, which
        compares the merge base with the working tree (uncommitted included).
  lookout render <id>       redraw the page from the store
  lookout show <id> [--json]
  lookout list [--json]
  lookout setup             engine pointer, ~/.local/bin shim, pinned highlight.js
  lookout engine            print the engine pointer

  store: ${S.REVIEWS_DIR}/<id>.json`);
}

// ---------------------------------------------------------------- dispatch
// Every run refreshes the pointer, so whichever copy ran last is the one the
// shim finds. Never at the cost of the command itself.
let pointerBody = null;
try { pointerBody = V.writeEnginePointer(HERE); } catch { /* read-only home */ }

switch (verb) {
  case "open":   cmdOpen(); break;
  case "render": say(renderPage(reviewArg())); break;
  case "show":   cmdShow(); break;
  case "list":   cmdList(); break;
  case "setup":  cmdSetup(); break;
  case "engine": process.stdout.write(pointerBody || JSON.stringify({ root: HERE, pointer: "not written" }, null, 2) + "\n"); break;
  case "help":   usage(); break;
  default:       usage(); die("unknown verb: " + verb);
}
