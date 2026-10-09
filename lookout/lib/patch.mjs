// What a review is OF: a source (a base, a range, the working tree, a patch
// file), the unified diff it yields, that diff parsed into files and hunks, and
// the rows the page draws — highlighted, with word-level marks on changed lines.
//
// The working tree is captured on a SCRATCH index (GIT_INDEX_FILE), never the
// real one. deep-plan's increment patch runs `git add -AN` against the real
// index (deep-plan/deep_plan.mjs, incrementDiff), which leaves intent-to-add
// entries behind in the user's staging area; a review tool must not change
// what `git commit` would do. The scratch index starts as a copy of the real
// one (so its stat cache spares a rehash of every file), takes `git add -A`,
// and is written to a tree object: both sides of the diff are then plain git
// objects, readable with `git show <rev>:<path>`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { highlightLines, languageFor, escapeHtml } from "./vendor.mjs";

export const LARGE_LINES = 1500;      // changed lines past which a file starts collapsed
export const EMBED_ROWS = 6000;       // rows past which a file is not drawn at all
const WHOLE_CAP = 1_500_000;          // bytes past which a side is highlighted per hunk only

export function git(root, args, { env, input, allowFail = false, buffer = false } = {}) {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root, input, maxBuffer: 256e6,
    encoding: buffer ? undefined : "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (r.status !== 0 && !allowFail)
    throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").toString().trim() || "exit " + r.status}`);
  return r.status === 0 ? r.stdout : null;
}
const line1 = s => (s || "").trim();

// ---------------------------------------------------------------- sources

export function repoInfo(cwd) {
  const root = line1(git(cwd, ["rev-parse", "--show-toplevel"]));
  // The repository's name, not the worktree's folder: a worktree of seamux is
  // still seamux. The common dir is <repo>/.git for every worktree.
  const common = path.resolve(root, line1(git(root, ["rev-parse", "--git-common-dir"])));
  const repo = path.basename(path.basename(common) === ".git" ? path.dirname(common) : common).replace(/\.git$/, "");
  const head = line1(git(root, ["rev-parse", "-q", "--verify", "HEAD"], { allowFail: true }));
  const branch = line1(git(root, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true })) ||
    (head ? head.slice(0, 8) : "");
  return { root, repo, head, branch };
}

// origin's default branch when it is known, else main, else master.
export function defaultBase(root) {
  const o = line1(git(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { allowFail: true }));
  if (o) return o;
  for (const b of ["main", "master"])
    if (git(root, ["rev-parse", "-q", "--verify", b + "^{commit}"], { allowFail: true })) return b;
  return "";
}

// The working tree, untracked files included and .gitignore respected, as a
// tree object. Nothing outside the scratch index file is written but objects.
export function worktreeTree(root) {
  const real = path.resolve(root, line1(git(root, ["rev-parse", "--git-path", "index"])));
  const tmp = path.join(os.tmpdir(), `lookout-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: tmp };
  try {
    if (fs.existsSync(real)) fs.copyFileSync(real, tmp);
    else if (git(root, ["rev-parse", "-q", "--verify", "HEAD"], { allowFail: true }))
      git(root, ["read-tree", "HEAD"], { env });
    git(root, ["add", "-A"], { env });
    return line1(git(root, ["write-tree"], { env }));
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp + ".lock", { force: true });
  }
}

const rev = (root, r) => line1(git(root, ["rev-parse", "--verify", r + "^{commit}"]));

// What to diff. Returns the source block the store keeps: enough to rebuild
// the same patch, and a label for the page header.
export function resolveSource(o, cwd) {
  if (o.patch) {
    const file = path.resolve(cwd, o.patch);
    if (!fs.existsSync(file)) throw new Error("no such patch file: " + o.patch);
    let info = null;
    try { info = repoInfo(cwd); } catch { /* a patch needs no repo */ }
    return { kind: "patch", file, root: info ? info.root : path.dirname(file),
             repo: info ? info.repo : "", branch: info ? info.branch : "",
             label: path.basename(file) };
  }
  const info = repoInfo(cwd);
  const { root, repo, branch, head } = info;
  if (o.range) {
    const tri = o.range.includes("...");
    const [a, b] = o.range.split(tri ? "..." : "..");
    if (!a || b === undefined) throw new Error("--range wants A..B or A...B");
    const newRev = rev(root, b || "HEAD");
    const oldRev = tri ? line1(git(root, ["merge-base", a, b || "HEAD"])) : rev(root, a);
    return { kind: "range", root, repo, branch, range: o.range, oldRev, newRev, head,
             label: o.range };
  }
  if (!head && !o.worktree) throw new Error("this repository has no commits; use --worktree");
  if (o.worktree) {
    const newRev = worktreeTree(root);
    return { kind: "worktree", root, repo, branch, head, oldRev: head || emptyTree(root), newRev,
             label: `${branch || "working tree"} · uncommitted` };
  }
  const base = o.base || defaultBase(root);
  if (!base) throw new Error("no base to compare against: pass --base REF (no origin/HEAD, main or master here)");
  const baseSha = rev(root, base);
  const oldRev = line1(git(root, ["merge-base", baseSha, head]));
  const newRev = worktreeTree(root);
  const headTree = line1(git(root, ["rev-parse", head + "^{tree}"]));
  return { kind: "base", root, repo, branch, head, base, baseSha, oldRev, newRev,
           dirty: newRev !== headTree,
           label: `${branch} vs ${base}${newRev !== headTree ? " · with uncommitted" : ""}` };
}

function emptyTree(root) {
  return line1(git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }));
}

// The patch text. Flags pin what a user's config could otherwise change:
// prefixes, colors, external diff drivers, textconv, relative paths.
export function buildPatch(src) {
  if (src.kind === "patch") return fs.readFileSync(src.file, "utf8");
  return git(src.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative",
    "-M", "--src-prefix=a/", "--dst-prefix=b/", src.oldRev, src.newRev]);
}

// One side's full text, or null (absent, binary, too large to highlight whole).
export function sideText(src, which, file) {
  if (src.kind === "patch") return null;
  const r = which === "old" ? src.oldRev : src.newRev;
  const p = which === "old" ? (file.oldPath || file.path) : file.path;
  if ((which === "old" && file.status === "A") || (which === "new" && file.status === "D")) return null;
  const buf = git(src.root, ["show", `${r}:${p}`], { allowFail: true, buffer: true });
  if (!buf || buf.length > WHOLE_CAP || buf.includes(0)) return null;
  return buf.toString("utf8");
}

// ---------------------------------------------------------------- parse

// git's C-style quoting: octal escapes are BYTES of the UTF-8 name, so the
// name is rebuilt as bytes and decoded once.
const C_ESC = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
function unquote(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { bytes.push(...Buffer.from(c, "utf8")); continue; }
    const o = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(o)) { bytes.push(parseInt(o, 8)); i += 3; }
    else { const e = body[++i]; bytes.push(C_ESC[e] ?? e.charCodeAt(0)); }
  }
  return Buffer.from(bytes).toString("utf8");
}
function cleanPath(p, strip) {
  if (!p) return null;
  p = unquote(p.replace(/\t.*$/, "").trim());
  if (p === "/dev/null") return null;
  return strip && /^[ab]\//.test(p) ? p.slice(2) : p;
}

// A unified diff — git's or plain `diff -u` — into files and hunks. Hunk bodies
// are consumed by their header's line counts, never by sniffing prefixes, so a
// removed line that reads "-- foo" or "+++ bar" stays a line.
export function parsePatch(text) {
  const files = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let f = null;
  const start = git => {
    f = { path: null, oldPath: null, status: "M", binary: false, adds: 0, dels: 0, hunks: [], git };
    files.push(f);
  };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.startsWith("diff --git ")) {
      start(true);
      // Fallback names for a file with no ---/+++ (mode change, binary, pure
      // rename): split the header in half when both halves name one path.
      const rest = L.slice(11), q = rest.match(/^"a\/(.*)" "b\/(.*)"$/);
      const half = (rest.length - 1) / 2, l = rest.slice(0, half), r = rest.slice(half + 1);
      if (q) { f.oldPath = unquote('"' + q[1] + '"'); f.path = unquote('"' + q[2] + '"'); }
      else if (l.startsWith("a/") && r.startsWith("b/") && l.slice(2) === r.slice(2)) f.oldPath = f.path = l.slice(2);
      continue;
    }
    if (L.startsWith("--- ") && (lines[i + 1] || "").startsWith("+++ ")) {
      if (!f || !f.git || f.hunks.length || f.sawMinus) start(false);
      f.sawMinus = true;
      const a = cleanPath(L.slice(4), f.git), b = cleanPath(lines[i + 1].slice(4), f.git);
      if (!f.git) { f.oldPath = a; f.path = b || a; if (!a) f.status = "A"; if (!b) f.status = "D"; }
      else { if (a) f.oldPath = a; if (b) f.path = b; if (!b) f.path = a; }
      i++;
      continue;
    }
    if (!f) continue;
    let m;
    if (L.startsWith("new file mode")) f.status = "A";
    else if (L.startsWith("deleted file mode")) f.status = "D";
    else if ((m = L.match(/^rename from (.+)$/))) { f.oldPath = unquote(m[1]); f.status = "R"; }
    else if ((m = L.match(/^rename to (.+)$/))) { f.path = unquote(m[1]); f.status = "R"; }
    else if ((m = L.match(/^copy from (.+)$/))) { f.oldPath = unquote(m[1]); f.status = "C"; }
    else if ((m = L.match(/^copy to (.+)$/))) { f.path = unquote(m[1]); f.status = "C"; }
    else if (L.startsWith("Binary files ") || L === "GIT binary patch") f.binary = true;
    else if ((m = L.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/))) {
      const h = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2],
                  newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4],
                  header: L, lines: [] };
      let o = h.oldStart, n = h.newStart, oLeft = h.oldLines, nLeft = h.newLines;
      while ((oLeft > 0 || nLeft > 0) && i + 1 < lines.length) {
        const B = lines[++i];
        const t = B === "" ? " " : B[0];
        const body = B.slice(1);
        if (t === "\\") continue;
        if (t === "+") { h.lines.push(["+", null, n++, body]); nLeft--; f.adds++; }
        else if (t === "-") { h.lines.push(["-", o++, null, body]); oLeft--; f.dels++; }
        else if (t === " ") { h.lines.push([" ", o++, n++, body]); oLeft--; nLeft--; }
        else { i--; break; }      // malformed: stop this hunk where it broke
      }
      while ((lines[i + 1] || "").startsWith("\\")) i++;
      f.hunks.push(h);
    }
  }
  for (const x of files) {
    delete x.sawMinus;
    if (x.oldPath === x.path) x.oldPath = null;
    if (x.git && x.status === "M" && x.oldPath) x.status = "R";
    if (!x.git) x.oldPath = null;
  }
  return files.filter(x => x.path);
}

// ---------------------------------------------------------------- generated

const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|uv\.lock|flake\.lock)$/,
  /\.min\.(js|css)$/, /\.map$/, /(^|\/)__generated__\//, /\.generated\.[^/]+$/,
  /\.pb\.go$/, /_pb2(_grpc)?\.py$/, /(^|\/)vendor\/.+\.min\./,
];
export function looksGenerated(p) { return GENERATED.some(re => re.test(p)); }

// Paths .gitattributes marks linguist-generated (GitHub's own convention).
export function generatedByAttr(root, paths) {
  if (!paths.length) return new Set();
  const out = git(root, ["check-attr", "-z", "--stdin", "linguist-generated"],
    { input: paths.join("\0") + "\0", allowFail: true });
  const set = new Set();
  if (!out) return set;
  const parts = out.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3)
    if (parts[i + 2] === "set" || parts[i + 2] === "true") set.add(parts[i]);
  return set;
}

// ---------------------------------------------------------------- intraline

const TOKEN = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;

// The changed character ranges of a paired removed/added line: common prefix
// and suffix trimmed, then a token LCS over what is left (when it is small
// enough to be cheap; past that, the whole middle is the change). Returns
// null when the lines share too little for marks to mean anything.
export function wordRanges(a, b) {
  const tok = s => { const t = []; for (const m of s.matchAll(TOKEN)) t.push([m[0], m.index]); return t; };
  const ta = tok(a), tb = tok(b);
  // Trim whole tokens off both ends, so a shared suffix like "ty;" never
  // splits "qty" from "quantity" mid-word.
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p][0] === tb[p][0]) p++;
  let s = 0;
  while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s][0] === tb[tb.length - 1 - s][0]) s++;
  const ma = ta.slice(p, ta.length - s), mb = tb.slice(p, tb.length - s);
  const ra = [], rb = [];
  const push = (r, [t, at]) => {
    const last = r[r.length - 1];
    if (last && last[1] === at) last[1] = at + t.length; else r.push([at, at + t.length]);
  };
  const n = ma.length, m = mb.length;
  if (n && m && n * m <= 40000) {
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = ma[i][0] === mb[j][0] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i][0] === mb[j][0]) { i++; j++; }
      else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) push(rb, mb[j++]);
      else push(ra, ma[i++]);
    }
  } else {
    for (const t of ma) push(ra, t);
    for (const t of mb) push(rb, t);
  }
  const changed = r => r.reduce((x, [f, t]) => x + t - f, 0);
  const longest = Math.max(a.length, b.length) || 1;
  const kept = longest - Math.max(changed(ra), changed(rb));
  if (kept / longest < 0.35) return null;
  return { a: ra, b: rb };
}

// Wrap the text characters of highlighted HTML that fall in `ranges` in
// <mark>. Offsets count decoded characters, so an entity is one. A mark never
// straddles a tag: it closes before one and reopens after, so nesting holds.
export function applyMarks(html, ranges) {
  if (!ranges || !ranges.length) return html;
  let out = "", pos = 0, k = 0, inMark = false, i = 0;
  const inRange = q => { while (k < ranges.length && q >= ranges[k][1]) k++; return k < ranges.length && q >= ranges[k][0]; };
  while (i < html.length) {
    if (html[i] === "<") {
      const j = html.indexOf(">", i);
      if (inMark) out += "</mark>";
      out += html.slice(i, j + 1);
      if (inMark) out += "<mark>";
      i = j + 1;
      continue;
    }
    let ch = html[i];
    if (ch === "&") { const j = html.indexOf(";", i); ch = html.slice(i, j + 1); }
    const want = inRange(pos);
    if (want && !inMark) { out += "<mark>"; inMark = true; }
    else if (!want && inMark) { out += "</mark>"; inMark = false; }
    out += ch;
    i += ch.length;
    pos++;
  }
  if (inMark) out += "</mark>";
  return out.replace(/<mark><\/mark>/g, "");
}

// ---------------------------------------------------------------- rows

// The rows the page draws for one file: per hunk, [type, oldNo, newNo, html].
// Each side's whole file is highlighted when it is available and agrees with
// the hunk text; otherwise each hunk's own old and new halves are highlighted
// (a patch-file review, a file too big to highlight whole).
export function buildRows(file, oldText, newText, { plain = false } = {}) {
  if (file.binary) return { note: "binary" };
  const total = file.hunks.reduce((x, h) => x + h.lines.length, 0);
  if (total > EMBED_ROWS) return { note: "too-large", total };
  const first = (newText || oldText || (file.hunks[0]?.lines[0]?.[3]) || "").split("\n", 1)[0];
  const lang = plain ? "" : languageFor(file.path, first);
  const agrees = (text, idx) => {
    if (text == null) return false;
    const raw = text.split("\n");
    return file.hunks.every(h => h.lines.every(r => r[idx] == null || raw[r[idx] - 1] === r[3]));
  };
  const whole = !plain && agrees(oldText, 1) && agrees(newText, 2);
  const oldHl = whole && oldText != null ? highlightLines(oldText, lang) : null;
  const newHl = whole && newText != null ? highlightLines(newText, lang) : null;

  const hunks = file.hunks.map(h => {
    let oldLocal = null, newLocal = null;
    if (!whole) {
      const hl = text => plain ? text.split("\n").map(escapeHtml) : highlightLines(text, lang);
      const os_ = h.lines.filter(r => r[0] !== "+"), ns = h.lines.filter(r => r[0] !== "-");
      const oh = hl(os_.map(r => r[3]).join("\n")), nh = hl(ns.map(r => r[3]).join("\n"));
      oldLocal = new Map(os_.map((r, k) => [r, oh[k]]));
      newLocal = new Map(ns.map((r, k) => [r, nh[k]]));
    }
    const html = h.lines.map(r => {
      if (whole) return r[0] === "-" ? oldHl[r[1] - 1] : (newHl ? newHl[r[2] - 1] : oldHl[r[1] - 1]);
      return r[0] === "-" ? oldLocal.get(r) : newLocal.get(r);
    });
    // Pair each run of removed lines with the run of added lines after it.
    for (let k = 0; k < h.lines.length;) {
      if (h.lines[k][0] !== "-") { k++; continue; }
      const d0 = k; while (k < h.lines.length && h.lines[k][0] === "-") k++;
      const a0 = k; while (k < h.lines.length && h.lines[k][0] === "+") k++;
      for (let q = 0; q < Math.min(a0 - d0, k - a0); q++) {
        const w = wordRanges(h.lines[d0 + q][3], h.lines[a0 + q][3]);
        if (!w) continue;
        html[d0 + q] = applyMarks(html[d0 + q], w.a);
        html[a0 + q] = applyMarks(html[a0 + q], w.b);
      }
    }
    return { header: h.header, rows: h.lines.map((r, k) => [r[0], r[1], r[2], html[k] ?? escapeHtml(r[3])]) };
  });
  return { lang, whole, hunks };
}
