#!/usr/bin/env node
// lookout probe — one command, no arguments, throwaway everything. Every
// review, pointer, shim and vendor file lands under a temp dir; the real
// ~/.claude is never written and nothing touches the network. `-v` lists
// every assertion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = process.argv.includes("-v");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-probe-"));
const HOME = path.join(TMP, "home");
const ENV = {
  ...process.env,
  LOOKOUT_REVIEWS_DIR: path.join(TMP, "reviews"),
  LOOKOUT_VENDOR_DIR: path.join(TMP, "vendor"),
  LOOKOUT_ENGINE_FILE: path.join(HOME, ".claude", "lookout", "engine.json"),
  LOOKOUT_BIN_DIR: path.join(TMP, "shim-bin"),
  LOOKOUT_HLJS_SRC: path.join(TMP, "no-download-in-the-probe"),
};
delete ENV.LOOKOUT_ENGINE;
delete ENV.CMUX_WORKSPACE_ID;
// The libs read their overrides at import time, so set them before importing.
Object.assign(process.env, ENV);

// The real bundle to test with: where CI or `lookout setup` put it. Copied.
{
  const src = [
    process.env.LOOKOUT_PROBE_HLJS,
    path.join(os.homedir(), ".claude", "lookout", "vendor", "highlight.min.js"),
  ].filter(Boolean).find(p => fs.existsSync(p));
  if (!src) {
    console.error("lookout probe: no highlight.min.js to test with. Run `lookout setup`, " +
      "or point LOOKOUT_PROBE_HLJS at the pinned build.");
    process.exit(1);
  }
  fs.mkdirSync(ENV.LOOKOUT_VENDOR_DIR, { recursive: true });
  fs.copyFileSync(src, path.join(ENV.LOOKOUT_VENDOR_DIR, "highlight.min.js"));
}

const P = await import("./lib/patch.mjs");
const VD = await import("./lib/vendor.mjs");
const S = await import("./lib/store.mjs");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; if (V) console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  :: " + String(extra).slice(0, 400) : "")); }
}
function cli(cwd, ...args) {
  return spawnSync("node", [path.join(HERE, "lookout.mjs"), ...args], { encoding: "utf8", env: ENV, cwd });
}
const G = "git -c user.email=probe@lookout -c user.name=probe";
function repo(name) {
  const d = path.join(TMP, name);
  fs.mkdirSync(d, { recursive: true });
  execSync(`git init -q -b main && ${G} commit -q --allow-empty -m init`, { cwd: d });
  return d;
}
const write = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
const sh = (d, c) => execSync(c, { cwd: d, encoding: "utf8" });
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// ---------------------------------------------------------------- parse
{
  const text = [
    "diff --git a/src/a.js b/src/a.js",
    "index 111..222 100644",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,4 +1,4 @@ function f() {",
    " one",
    "--- not a header, a removed line",
    "+++ not a header, an added line",
    " four",
    "\\ No newline at end of file",
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 90%",
    "rename from old name.txt",
    "rename to new name.txt",
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "Binary files /dev/null and b/img.png differ",
    "diff --git a/gone.py b/gone.py",
    "deleted file mode 100644",
    "--- a/gone.py",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-print(1)",
    'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
    "--- \"a/caf\\303\\251.md\"",
    "+++ \"b/caf\\303\\251.md\"",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const fs_ = P.parsePatch(text);
  ok("parse: five files", fs_.length === 5, fs_.map(f => f.path));
  const a = fs_[0];
  ok("parse: hunk lines are counted, so ---/+++ inside a hunk stay lines",
     a.hunks[0].lines.length === 4 && a.dels === 1 && a.adds === 1, JSON.stringify(a.hunks[0].lines));
  ok("parse: line numbers on both sides", a.hunks[0].lines[3][1] === 3 && a.hunks[0].lines[3][2] === 3);
  ok("parse: a pure rename keeps both names", fs_[1].status === "R" && fs_[1].path === "new name.txt" && fs_[1].oldPath === "old name.txt");
  ok("parse: binary and new", fs_[2].binary && fs_[2].status === "A");
  ok("parse: deletion keeps its path", fs_[3].status === "D" && fs_[3].path === "gone.py" && fs_[3].dels === 1);
  ok("parse: quoted octal paths are decoded", fs_[4].path === "café.md", fs_[4].path);

  const plain = P.parsePatch("--- x.c.orig\t2026-01-01\n+++ x.c\t2026-01-02\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
  ok("parse: plain diff -u (no git header)", plain.length === 1 && plain[0].path === "x.c" && plain[0].status === "M" && !plain[0].oldPath,
     JSON.stringify(plain));
}

// ---------------------------------------------------------------- intraline
{
  const w = P.wordRanges("const total = price * qty;", "const total = price * quantity;");
  ok("intraline: only the changed word is marked", w && w.a.length === 1 && w.b.length === 1 &&
     "const total = price * quantity;".slice(...w.b[0]) === "quantity", JSON.stringify(w));
  ok("intraline: unrelated lines get no marks", P.wordRanges("import fs from 'fs';", "return x + y;") === null);
  const m = P.applyMarks('<span class="a">x &lt; y</span> z', [[2, 3]]);
  ok("intraline: an entity counts as one character", m === '<span class="a">x <mark>&lt;</mark> y</span> z', m);
  const m2 = P.applyMarks('a<span class="k">bc</span>d', [[0, 4]]);
  ok("intraline: a mark closes around tags, never straddles them",
     m2 === '<mark>a</mark><span class="k"><mark>bc</mark></span><mark>d</mark>', m2);
}

// ---------------------------------------------------------------- highlighting
{
  const lines = VD.splitHighlighted('<span class="hljs-comment">/* a\nb */</span>\nx');
  ok("highlight: a span across lines is closed and reopened", lines.length === 3 &&
     lines[0] === '<span class="hljs-comment">/* a</span>' && lines[1] === '<span class="hljs-comment">b */</span>', JSON.stringify(lines));
  ok("highlight: languages by extension and shebang",
     VD.languageFor("a/b.mjs") === "javascript" && VD.languageFor("hooks/x.sh") === "bash" &&
     VD.languageFor("crew/board/crew-board-intent", "#!/usr/bin/env python3") === "python" &&
     VD.languageFor("Makefile") === "makefile" && VD.languageFor("notes.weird") === "");
  ok("highlight: the bundle loads in a vm", !VD.hljsMissing(), VD.hljsMissing());
}

// ---------------------------------------------------------------- a real repo
const R1 = repo("r1");
{
  // A block comment whose middle changes: the hunk starts INSIDE the comment,
  // where highlighting the hunk alone would read the prose as code.
  const body = n => ["/*", ...Array.from({ length: 30 }, (_, i) => i === 20 ? `  line ${n} return if while` : `  prose ${i}`), "*/",
                     "const x = 1;", ""].join("\n");
  write(R1, "src/app.js", body("old"));
  write(R1, "tool.py", "def f():\n    return 1\n");
  write(R1, "package-lock.json", '{"lockfileVersion": 3}\n');
  write(R1, "page.html", "<p>hi</p>\n");
  sh(R1, `git add -A && ${G} commit -q -m base`);
  sh(R1, "git checkout -q -b dev/feature");
  write(R1, "src/app.js", body("new"));
  write(R1, "package-lock.json", '{"lockfileVersion": 3, "x": 1}\n');
  // A diff that carries the page's own placeholders and a closing script tag.
  write(R1, "page.html", "<p>hi</p>\n<script>/*__JS__*/ __DATA__</script>\n");
  sh(R1, `git add -A && ${G} commit -q -m feature`);
  // Uncommitted and untracked work, and a staged change the user owns.
  write(R1, "tool.py", "def f():\n    return 2\n");
  write(R1, "new_file.sh", "#!/bin/sh\necho hi\n");
  write(R1, "staged.txt", "staged\n");
  sh(R1, "git add staged.txt");
  const idx = path.join(R1, ".git", "index");
  const before = { sha: sha(idx), cached: sh(R1, "git diff --cached --name-only"), status: sh(R1, "git status --porcelain") };

  const r = cli(R1, "open", "--json");
  ok("open: default base is main and it succeeds", r.status === 0, r.stderr);
  const out = JSON.parse(r.stdout || "{}");
  ok("open: the id is repo-branch", out.id === "r1-dev-feature", out.id);
  ok("open: the real index is untouched (bytes, staged set, status)",
     sha(idx) === before.sha && sh(R1, "git diff --cached --name-only") === before.cached &&
     sh(R1, "git status --porcelain") === before.status);
  const rev = S.read(out.id);
  const by = Object.fromEntries(rev.files.map(f => [f.path, f]));
  ok("open: committed, uncommitted, staged and untracked changes are all in the review",
     by["src/app.js"] && by["tool.py"] && by["new_file.sh"]?.status === "A" && by["staged.txt"], Object.keys(by));
  ok("open: the source names branch, base and that it carries uncommitted work",
     rev.source.kind === "base" && rev.source.base === "main" && rev.source.dirty && /dev\/feature vs main/.test(rev.title), rev.title);
  ok("open: a lockfile is generated and collapsed", by["package-lock.json"].generated && by["package-lock.json"].collapsed);

  const rows = JSON.parse(fs.readFileSync(S.paths(out.id).rows, "utf8"));
  const app = rows["src/app.js"];
  ok("rows: whole-file highlighting was used", app.whole === true && app.lang === "javascript");
  const changed = app.hunks.flatMap(h => h.rows).filter(x => x[0] !== " ");
  ok("rows: a changed line inside a block comment is colored as comment (no keyword spans)",
     changed.length === 2 && changed.every(x => x[3].startsWith('<span class="hljs-comment">') && !x[3].includes("hljs-keyword")),
     JSON.stringify(changed));
  ok("rows: the changed word is marked on both sides", changed.every(x => /<mark>(old|new)<\/mark>/.test(x[3])), JSON.stringify(changed));
  ok("rows: a shebang script is highlighted as bash", rows["new_file.sh"].lang === "bash");

  const html = fs.readFileSync(out.page, "utf8");
  ok("page: every placeholder is filled exactly once", !/^<title>__TITLE__/m.test(html) &&
     html.includes("<title>lookout · r1-dev-feature</title>") && !html.includes("<style>/*__CSS__*/") &&
     (html.match(/<script>/g) || []).length === 1);
  ok("page: data from the diff cannot close the script element",
     (html.match(/<\/script/gi) || []).length === 2, (html.match(/<\/script/gi) || []).length);
  const data = JSON.parse(html.match(/<script type="application\/json" id="lookout-data">([\s\S]*?)<\/script>/)[1]);
  ok("page: the embedded data round-trips", data.review.id === out.id && data.rows["page.html"].hunks.length === 1);

  // Re-open keeps what people said; a changed patch drops the score cache.
  S.update(out.id, cur => ({ ...cur, findings: [{ id: "f1", file: "tool.py", line: 2, summary: "kept" }],
                            scoring: { cached: true } }));
  write(R1, "tool.py", "def f():\n    return 3\n");
  const again = JSON.parse(cli(R1, "open", "--json").stdout || "{}");
  const rev2 = S.read(again.id);
  ok("store: re-open keeps findings and createdAt", rev2.findings.length === 1 && rev2.createdAt === rev.createdAt);
  ok("store: a new patch drops the score cache", rev2.scoring === null && rev2.patchHash !== rev.patchHash);
  ok("store: agent-may-close defaults off and sticks once set",
     rev2.policy.agentMayClose === false &&
     (cli(R1, "open", "--agent-may-close", "--json"), S.read(again.id).policy.agentMayClose === true) &&
     (cli(R1, "open", "--json"), S.read(again.id).policy.agentMayClose === true));

  const wt = JSON.parse(cli(R1, "open", "--worktree", "--json").stdout || "{}");
  const wf = S.read(wt.id).files.map(f => f.path).sort();
  ok("open --worktree: only work since HEAD", wt.id === "r1-dev-feature-wt" &&
     JSON.stringify(wf) === JSON.stringify(["new_file.sh", "staged.txt", "tool.py"]), wf);

  const rg = JSON.parse(cli(R1, "open", "--range", "main...dev/feature", "--json").stdout || "{}");
  const rf = S.read(rg.id).files.map(f => f.path).sort();
  ok("open --range: committed work only", JSON.stringify(rf) === JSON.stringify(["package-lock.json", "page.html", "src/app.js"]), rf);

  const pf = path.join(TMP, "x.patch");
  fs.writeFileSync(pf, sh(R1, "git diff main dev/feature -- src/app.js"));
  const pr = JSON.parse(cli(TMP, "open", "--patch", pf, "--json").stdout || "{}");
  const prow = JSON.parse(fs.readFileSync(S.paths(pr.id).rows, "utf8"))["src/app.js"];
  ok("open --patch: works outside a repo, highlighted per hunk", pr.id === "patch-x" && prow.whole === false && prow.hunks.length === 1);

  ok("open: two sources at once are refused", cli(R1, "open", "--worktree", "--base", "main").status === 1);
  ok("open: a bad id is refused", cli(R1, "open", "--id", "../etc").status === 1);
  ok("show/list answer", cli(R1, "show", out.id).status === 0 && /r1-dev-feature/.test(cli(R1, "list").stdout));
}

// ---------------------------------------------------------------- big and plain
{
  const R2 = repo("r2");
  write(R2, "big.txt", Array.from({ length: 1700 }, (_, i) => "line " + i).join("\n") + "\n");
  write(R2, ".gitattributes", "gen/** linguist-generated\n");
  write(R2, "gen/out.js", "x\n");
  const r = JSON.parse(cli(R2, "open", "--worktree", "--json").stdout || "{}");
  const by = Object.fromEntries(S.read(r.id).files.map(f => [f.path, f]));
  ok("collapse: a large file starts collapsed", by["big.txt"].large && by["big.txt"].collapsed);
  ok("collapse: .gitattributes linguist-generated is honored", by["gen/out.js"].generated);
  const rows = JSON.parse(fs.readFileSync(S.paths(r.id).rows, "utf8"));
  ok("collapse: a collapsed file is still drawable, plain", rows["big.txt"].hunks[0].rows.length === 1700 && rows["big.txt"].lang === "");
}

// ---------------------------------------------------------------- setup
{
  const bad = path.join(TMP, "bad.js");
  fs.writeFileSync(bad, "var hljs = 0;");
  fs.rmSync(path.join(ENV.LOOKOUT_VENDOR_DIR, "highlight.min.js"));
  const r1 = spawnSync("node", [path.join(HERE, "lookout.mjs"), "setup"],
    { encoding: "utf8", env: { ...ENV, LOOKOUT_HLJS_SRC: bad } });
  ok("setup: bytes that fail the pin are refused and not installed",
     r1.status === 1 && /sha256/.test(r1.stdout) && !fs.existsSync(path.join(ENV.LOOKOUT_VENDOR_DIR, "highlight.min.js")), r1.stdout);
  const good = [process.env.LOOKOUT_PROBE_HLJS, path.join(os.homedir(), ".claude", "lookout", "vendor", "highlight.min.js")]
    .filter(Boolean).find(p => fs.existsSync(p));
  const r2 = spawnSync("node", [path.join(HERE, "lookout.mjs"), "setup"],
    { encoding: "utf8", env: { ...ENV, LOOKOUT_HLJS_SRC: good } });
  ok("setup: the pinned bytes install", r2.status === 0 && fs.existsSync(path.join(ENV.LOOKOUT_VENDOR_DIR, "highlight.min.js")), r2.stdout);
  const shim = path.join(ENV.LOOKOUT_BIN_DIR, "lookout");
  ok("setup: the shim is installed executable", (fs.statSync(shim).mode & 0o111) !== 0);
  const viaShim = spawnSync("sh", [shim, "engine"], { encoding: "utf8", env: { ...ENV, HOME } });
  ok("shim: finds the engine through the pointer", viaShim.status === 0 && JSON.parse(viaShim.stdout).root === HERE, viaShim.stderr);
  const viaBin = spawnSync(path.join(HERE, "bin", "lookout"), ["engine"], { encoding: "utf8", env: ENV });
  ok("bin/lookout: runs the engine beside it", viaBin.status === 0 && JSON.parse(viaBin.stdout).root === HERE);
}

// ---------------------------------------------------------------- page script
{
  const r = spawnSync("node", ["--check", path.join(HERE, "page", "review.js")], { encoding: "utf8" });
  ok("page: review.js parses", r.status === 0, r.stderr);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`lookout probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
