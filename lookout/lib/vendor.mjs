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

export const HLJS_VERSION = "11.11.1";
export const HLJS_SHA256 = "c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381";
export const HLJS_URL = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}/highlight.min.js`;

// The overrides are for the probe, so a test run never touches the network or
// repoints the real pointer and shim.
export const LOOKOUT_HOME = path.join(os.homedir(), ".claude", "lookout");
export const VENDOR_DIR = process.env.LOOKOUT_VENDOR_DIR || path.join(LOOKOUT_HOME, "vendor");
export const HLJS_HOME = path.join(VENDOR_DIR, "highlight.min.js");
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
  const src = process.env.LOOKOUT_HLJS_SRC;
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
  return { ok: true, how: "fetched highlight.js " + HLJS_VERSION };
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
    vm.runInContext(fs.readFileSync(HLJS_HOME, "utf8"), ctx, { filename: HLJS_HOME });
    HL = ctx.hljs || null;
    if (!HL) HL_WHY = "the bundle defined no hljs";
  } catch (e) {
    HL_WHY = fs.existsSync(HLJS_HOME) ? "the bundle failed to load: " + e.message
                                      : "highlight.js is not installed (run `lookout setup`)";
  }
  return HL;
}
export function hljsMissing() { loadHljs(); return HL ? "" : HL_WHY; }

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

// One key per line is part of the contract: the shim reads "root" with sed.
// Written only when the content changes.
export function writeEnginePointer(root) {
  const body = JSON.stringify({ root, version: engineVersion(root) }, null, 2) + "\n";
  let cur = null;
  try { cur = fs.readFileSync(ENGINE_FILE, "utf8"); } catch { /* first write */ }
  if (cur === body) return body;
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
