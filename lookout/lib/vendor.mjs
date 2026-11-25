// lookout's files under ~: the pinned highlight.js bundle, the engine pointer,
// and the ~/.local/bin shim. A plugin install cannot ship any of them, so
// `lookout setup` puts them in place, and every run refreshes the pointer.
//
// highlight.js is pinned and sha256-checked the way deep-plan pins mermaid
// (deep-plan/deep_plan.mjs, fetchMermaid): exactly this build, from a local
// copy that already matches or from the CDN, and any other bytes are deleted,
// never installed. The bundle runs here, in node, at render time — the page
// receives highlighted rows, not the highlighter — so a block comment or a
// template string that opens before a hunk still colors the hunk right: each
// side's WHOLE file is highlighted, then cut into lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HLJS_VERSION = "11.11.1";
export const HLJS_SHA256 = "c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381";
export const HLJS_URL = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}/highlight.min.js`;

// The overrides are for the probe, so a test run never touches the network or
// repoints the real pointer and shim.
export const LOOKOUT_HOME = path.join(os.homedir(), ".claude", "lookout");
export const VENDOR_DIR = process.env.LOOKOUT_VENDOR_DIR || path.join(LOOKOUT_HOME, "vendor");
export const HLJS_HOME = path.join(VENDOR_DIR, "highlight.min.js");
// The copy the plugin ships (committed: the cloud's network allowlist leaves
// out cdnjs). Setup checks it against the pin like a download.
export const HLJS_PLUGIN = process.env.LOOKOUT_HLJS_PLUGIN ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "highlight.min.js");
export const ENGINE_FILE = process.env.LOOKOUT_ENGINE_FILE || path.join(LOOKOUT_HOME, "engine.json");
export const SHIM_DIR = process.env.LOOKOUT_BIN_DIR || path.join(os.homedir(), ".local", "bin");

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// Put the pinned bundle at HLJS_HOME. LOOKOUT_HLJS_SRC replaces the download
// with a local file. Returns { ok, how } or { ok: false, why }.
export function fetchHljs() {
  if (fs.existsSync(HLJS_HOME) && sha256File(HLJS_HOME) === HLJS_SHA256)
    return { ok: true, how: "already in place" };
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const tmp = HLJS_HOME + ".part-" + process.pid;
  const shipped = fs.existsSync(HLJS_PLUGIN) && sha256File(HLJS_PLUGIN) === HLJS_SHA256;
  const src = process.env.LOOKOUT_HLJS_SRC || (shipped ? HLJS_PLUGIN : "");
  if (src) {
    try { fs.copyFileSync(src, tmp); } catch { return { ok: false, why: "could not read " + src }; }
  } else {
    const r = spawnSync("curl", ["-fsSL", HLJS_URL, "-o", tmp], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, why: "could not download " + HLJS_URL + (r.stderr ? ": " + r.stderr.trim() : "") };
    }
  }
  const got = sha256File(tmp);
  if (got !== HLJS_SHA256) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, why: `the download failed the sha256 check (got ${got.slice(0, 12)}…, pinned ${HLJS_SHA256.slice(0, 12)}…); nothing installed` };
  }
  fs.renameSync(tmp, HLJS_HOME);
  return { ok: true, how: (src === HLJS_PLUGIN ? "copied the plugin's highlight.js " : "fetched highlight.js ") + HLJS_VERSION };
}

// ---------------------------------------------------------------- highlighting

// Extension (or whole name) → highlight.js language. Anything the common
// bundle already knows as an alias needs no entry; this covers the rest.
const BY_EXT = {
  mjs: "javascript", cjs: "javascript", jsx: "javascript", tsx: "typescript", mts: "typescript",
  sh: "bash", zsh: "bash", bash: "bash", py: "python", rb: "ruby", rs: "rust", kt: "kotlin",
  yml: "yaml", md: "markdown", html: "xml", htm: "xml", svg: "xml", plist: "xml",
  toml: "ini", cfg: "ini", conf: "ini", h: "c", hpp: "cpp", cc: "cpp", m: "objectivec",
  gql: "graphql", json: "json", jsonl: "json",
};
const BY_NAME = { makefile: "makefile", gnumakefile: "makefile", gemfile: "ruby", rakefile: "ruby",
                  ".bashrc": "bash", ".zshrc": "bash", ".profile": "bash" };
const SHEBANG = [[/\b(node|deno|bun)\b/, "javascript"], [/\bpython[0-9.]*\b/, "python"],
                 [/\b(ba|z|da)?sh\b/, "bash"], [/\bruby\b/, "ruby"], [/\bperl\b/, "perl"]];

let HL = null;      // the loaded hljs, once
let HL_WHY = "";    // why it is not loaded

export function loadHljs() {
  if (HL || HL_WHY) return HL;
  try {
    const ctx = {};
    vm.createContext(ctx);
    // The home copy, else the plugin's own when it matches the pin (a fresh
    // install that has not run setup, or a cloud session).
    const file = fs.existsSync(HLJS_HOME) ? HLJS_HOME
      : fs.existsSync(HLJS_PLUGIN) && sha256File(HLJS_PLUGIN) === HLJS_SHA256 ? HLJS_PLUGIN : HLJS_HOME;
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
    HL = ctx.hljs || null;
    if (!HL) HL_WHY = "the bundle defined no hljs";
  } catch (e) {
    HL_WHY = fs.existsSync(HLJS_HOME) ? "the bundle failed to load: " + e.message
                                      : "highlight.js is not installed (run `lookout setup`)";
  }
  return HL;
}
export function hljsMissing() { loadHljs(); return HL ? "" : HL_WHY; }

// ---------------------------------------------------------------- BPMN

// bpmn.io's viewer (bpmn-js), for a review that changes a .bpmn file: the
// page draws the diagram before and after. Unlike highlight.js it runs in the
// page, inlined only when the review has a diagram. The plugin ships it
// (vendor/bpmn-js, the same build app/package.json pins), and every file must
// match its pin or the page goes without.
export const BPMN_VERSION = "18.31.1";
export const BPMN_DIR = process.env.LOOKOUT_BPMN_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "bpmn-js");
export const BPMN_FILES = {
  "bpmn-navigated-viewer.production.min.js": "134280f49f2ca8bbc90797fa656177e2b787ae0a62249fe3dadb8038eb88e9db",
  "diagram-js.css": "73f990dcd6cd2ed696aa63a3c73822a97f0ea69a221d76ebe6cf24b01111df21",
  "bpmn-js.css": "a1add5dca479c779a54adda507f26796f4d61a5ae15f6cc14a1b017ff65b4015",
};
// The layout for a diagram with no positions in it (Flowable's .bpmn20.xml,
// usually): app/ui/bpmnlayout.ts with bpmn-auto-layout 1.3.0, bundled by
// `npm run vendor:lookout` in app/ (the same bytes each build), as the
// global SeamuxBpmnLayout. Licenses in LICENSE-layout.
export const BPMN_LAYOUT = ["bpmn-layout.min.js", "454654fad921b34b4d1c1aa88c1dfda0a78ddc0c40327bd8df9f4ed607a8a8ef"];
// A .bpmn file, or a .bpmn20.xml as Flowable and Activiti name theirs.
export const isBpmn = p => /\.(bpmn|bpmn20\.xml)$/i.test(p || "");
// Whether the XML places any shape; one with none needs the layout to draw.
export const hasBpmnDiagram = xml => /<(?:[\w.-]+:)?BPMNShape[\s/>]/.test(xml || "");

// The file at its pin, else why not.
function pinned(name, sha) {
  const p = path.join(BPMN_DIR, name);
  if (!fs.existsSync(p)) return { why: name + " is missing from this install" };
  if (sha256File(p) !== sha) return { why: name + " failed its sha256 check; not loaded" };
  return { text: fs.readFileSync(p, "utf8") };
}

// { js, css } when every viewer file is there and matches its pin, else
// { why }. `layout` adds the layout bundle to the js; when that one file is
// missing or off its pin, the viewer still comes, with { layoutWhy }, so a
// diagram that stores its positions still draws.
export function bpmnAssets({ layout = false } = {}) {
  const got = {};
  for (const [name, sha] of Object.entries(BPMN_FILES)) {
    const f = pinned(name, sha);
    if (f.why) return { why: "bpmn-js: " + f.why };
    got[name] = f.text;
  }
  const out = { js: got["bpmn-navigated-viewer.production.min.js"], css: got["diagram-js.css"] + "\n" + got["bpmn-js.css"] };
  if (!layout) return out;
  const l = pinned(...BPMN_LAYOUT);
  if (l.why) return { ...out, layoutWhy: l.why };
  return { ...out, js: out.js + "\n;" + l.text };
}

// The language for a path, with the file's first line for scripts that carry a
// shebang and no extension (hooks, engines). "" means plain text.
export function languageFor(file, firstLine = "") {
  const base = path.basename(file).toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  const hl = loadHljs();
  if (ext) {
    if (BY_EXT[ext]) return BY_EXT[ext];
    // An alias the bundle knows, named by its registered key ("js" → "javascript").
    const def = hl && hl.getLanguage(ext);
    if (def) return hl.listLanguages().find(k => hl.getLanguage(k) === def) || ext;
  }
  if (firstLine.startsWith("#!"))
    for (const [re, lang] of SHEBANG) if (re.test(firstLine)) return lang;
  return "";
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// highlight.js output as one HTML string per source line. Spans that cross a
// newline (a block comment, a template string) are closed at the end of the
// line and reopened at the start of the next, so every line is well-formed on
// its own and keeps the color of the construct it sits in.
export function splitHighlighted(html) {
  const lines = [];
  const open = [];          // the opening tags in force
  let cur = "";
  let i = 0;
  while (i < html.length) {
    const c = html[i];
    if (c === "<") {
      const j = html.indexOf(">", i);
      const tag = html.slice(i, j + 1);
      if (tag.startsWith("</")) open.pop(); else open.push(tag);
      cur += tag;
      i = j + 1;
    } else if (c === "\n") {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
      i++;
    } else { cur += c; i++; }
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}

// Highlight a whole text and return its lines. Falls back to escaped plain
// text whenever there is no language, no bundle, or highlight.js throws.
export function highlightLines(text, lang) {
  const hl = lang ? loadHljs() : null;
  if (hl && hl.getLanguage(lang)) {
    try { return splitHighlighted(hl.highlight(text, { language: lang, ignoreIllegals: true }).value); }
    catch { /* fall through to plain */ }
  }
  return text.split("\n").map(escapeHtml);
}

// ---------------------------------------------------------------- pointer + shim

export function engineVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).version || "dev"; }
  catch { return "dev"; }
}

// The root the pointer names now, or null when there is no usable pointer:
// none, unreadable, or naming a copy that is gone.
export function pointedRoot() {
  let o;
  try { o = JSON.parse(fs.readFileSync(ENGINE_FILE, "utf8")); } catch { return null; }
  const root = o && typeof o.root === "string" ? o.root : "";
  return root && fs.existsSync(path.join(root, "lookout.mjs")) ? root : null;
}

// One key per line is part of the contract: the shim reads "root" with sed.
// Written only when the content changes, and only by the copy the pointer
// already names (a version bump), by any copy when there is no usable
// pointer, or by `lookout setup` (force). Any other copy (a worktree's, run
// for a probe or a check) leaves it alone and returns null, so it cannot
// move every session and the app onto itself.
export function writeEnginePointer(root, { force = false } = {}) {
  const body = JSON.stringify({ root, version: engineVersion(root) }, null, 2) + "\n";
  let cur = null;
  try { cur = fs.readFileSync(ENGINE_FILE, "utf8"); } catch { /* first write */ }
  if (cur === body) return body;
  const named = pointedRoot();
  if (!force && named && path.resolve(named) !== path.resolve(root)) return null;
  fs.mkdirSync(path.dirname(ENGINE_FILE), { recursive: true });
  const tmp = ENGINE_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, ENGINE_FILE);
  return body;
}

// ~/.local/bin/lookout. It holds no path of its own: the engine is
// $LOOKOUT_ENGINE, else the root the plugin last wrote to engine.json.
export const SHIM = `#!/bin/sh
# ~/.local/bin/lookout, installed by \`lookout setup\`.
# It holds no path of its own: the engine is $LOOKOUT_ENGINE, else the root
# the plugin last wrote to ~/.claude/lookout/engine.json (one key per line,
# which is what lets sed read it here without a JSON parser).
ROOT=\${LOOKOUT_ENGINE:-}
if [ -z "$ROOT" ] && [ -f "$HOME/.claude/lookout/engine.json" ]; then
  ROOT=$(sed -n 's/^  "root": "\\(.*\\)",\\{0,1\\}$/\\1/p' "$HOME/.claude/lookout/engine.json")
fi
# Node without trusting PATH: callers include processes fired from the cmux
# app, whose environment has no version manager loaded.
if command -v node >/dev/null 2>&1; then
  NODE=node
else
  for c in "$HOME/.asdf/shims/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
[ -n "\${NODE:-}" ] || { echo "lookout: node not found" >&2; exit 127; }
[ -n "$ROOT" ] && [ -f "$ROOT/lookout.mjs" ] || { echo "lookout: no engine found (install the lookout plugin, or set LOOKOUT_ENGINE)" >&2; exit 127; }
exec "$NODE" "$ROOT/lookout.mjs" "$@"
`;

// Install or refresh the shim. A symlink at the name is replaced, never
// written through. Returns a line for `setup` to print.
export function installShim() {
  const shim = path.join(SHIM_DIR, "lookout");
  try { if (fs.lstatSync(shim).isSymbolicLink()) fs.unlinkSync(shim); } catch { /* absent */ }
  let have = null;
  try { have = fs.readFileSync(shim, "utf8"); } catch { /* not installed */ }
  if (have === SHIM) return `ok    shim in place: ${shim}`;
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  fs.writeFileSync(shim, SHIM, { mode: 0o755 });
  fs.chmodSync(shim, 0o755);
  return `ok    ${have === null ? "installed" : "updated"} the shim: ${shim}`;
}
