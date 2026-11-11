#!/usr/bin/env node
// lookout probe — one command, no arguments, throwaway everything. Every
// review, pointer, shim and vendor file lands under a temp dir; the real
// ~/.claude is never written and nothing touches the network. `-v` lists
// every assertion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sections } from "../tools/probe_sections.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = process.argv.includes("-v");
// Each section below runs in its own child with its own TMP, several at once;
// `--only <word>` picks sections, `--serial` runs them here (tools/probe_sections.mjs).
const { want } = await sections(import.meta.url, { label: "lookout probe" });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lookout-probe-"));
const HOME = path.join(TMP, "home");
const ENV = {
  ...process.env,
  LOOKOUT_REVIEWS_DIR: path.join(TMP, "reviews"),
  LOOKOUT_VENDOR_DIR: path.join(TMP, "vendor"),
  LOOKOUT_ENGINE_FILE: path.join(HOME, ".claude", "lookout", "engine.json"),
  LOOKOUT_BIN_DIR: path.join(TMP, "shim-bin"),
  LOOKOUT_HLJS_SRC: path.join(TMP, "no-download-in-the-probe"),
  // Authoritative and empty: no TypeSafe client, so no open in the probe can
  // reach the network. The scoring block below points it at a mock.
  LOOKOUT_TYPESAFE_CLIENT: "",
  // gh is lookout's fake, answering from a map no section has written until
  // it wants one: nothing in the probe can reach GitHub.
  LOOKOUT_GH: path.join(HERE, "tools", "fake-gh"),
  FAKE_GH_MAP: path.join(TMP, "gh-map.json"),
  FAKE_GH_LOG: path.join(TMP, "gh-log.jsonl"),
  LOOKOUT_GH_STATE: path.join(TMP, "gh-sync.json"),
};
delete ENV.TYPESAFE_BASE_URL;
delete ENV.LOOKOUT_ENGINE;
delete ENV.CMUX_WORKSPACE_ID;
delete ENV.CMUX_SURFACE_ID;
// Host signals come from the session running the probe; each test sets its own.
// The seamux app's tmux panes set SEAMUX_* and TMUX*, as cmux sets CMUX_*.
for (const k of ["SEAMUX_HOST", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_ENTRYPOINT", "LOOKOUT_SERVE_FILE",
  "SEAMUX_BACKEND", "SEAMUX_PANE_ID", "SEAMUX_WORKSPACE_ID", "TMUX", "TMUX_PANE"]) delete ENV[k];
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
if (want("parse")) {
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
if (want("intraline")) {
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
if (want("highlighting")) {
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
if (want("a real repo")) {
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
     !html.includes("/*__MAP_JS__*/") &&
     // Two plain scripts: the Map view's renderer (page/plan-map.js), then review.js.
     (html.match(/<script>/g) || []).length === 2);
  // The template's three script elements close, and nothing from the diff does.
  ok("page: data from the diff cannot close the script element",
     (html.match(/<\/script/gi) || []).length === 3, (html.match(/<\/script/gi) || []).length);
  const data = JSON.parse(html.match(/<script type="application\/json" id="lookout-data">([\s\S]*?)<\/script>/)[1]);
  ok("page: the embedded data round-trips", data.review.id === out.id && data.rows["page.html"].hunks.length === 1);

  // Re-open keeps what people said; a changed patch drops the score cache.
  S.update(out.id, cur => ({ ...cur, findings: [{ id: "f1", file: "tool.py", line: 2, summary: "kept" }],
                            scoring: { ...cur.scoring, cached: true } }));
  write(R1, "tool.py", "def f():\n    return 3\n");
  const again = JSON.parse(cli(R1, "open", "--json").stdout || "{}");
  const rev2 = S.read(again.id);
  ok("store: re-open keeps findings and createdAt", rev2.findings.length === 1 && rev2.createdAt === rev.createdAt);
  ok("store: a new patch drops the score cache", !rev2.scoring.cached && rev2.patchHash !== rev.patchHash);
  const grant = cli(R1, "open", "--agent-may-close", "--json");
  ok("store: agent-may-close defaults off, and a re-open cannot grant it",
     rev2.policy.agentMayClose === false && grant.status === 1 && /not changed on a re-open/.test(grant.stderr) &&
     S.read(again.id).policy.agentMayClose === false, grant.stderr);

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
  ok("open --patch: works outside a repo, highlighted per hunk", /^patch-x-[0-9a-f]{6}$/.test(pr.id) && prow.whole === false && prow.hunks.length === 1, pr.id);
  {
    const other = path.join(TMP, "elsewhere", "x.patch");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.copyFileSync(pf, other);
    const po = JSON.parse(cli(TMP, "open", "--patch", other, "--json").stdout || "{}");
    ok("open --patch: two patches with one name are two reviews", po.id && po.id !== pr.id);
  }

  ok("open: two sources at once are refused", cli(R1, "open", "--worktree", "--base", "main").status === 1);
  ok("open: a bad id is refused", cli(R1, "open", "--id", "../etc").status === 1);
  ok("show/list answer", cli(R1, "show", out.id).status === 0 && /r1-dev-feature/.test(cli(R1, "list").stdout));
  // A reader that stops early (`| head`) closes the pipe while `show` is still
  // writing one line per file; 400 files keep it writing long enough.
  {
    const many = path.join(TMP, "many.patch");
    fs.writeFileSync(many, Array.from({ length: 400 }, (_, i) =>
      `diff --git a/f${i}.txt b/f${i}.txt\nnew file mode 100644\n--- /dev/null\n+++ b/f${i}.txt\n@@ -0,0 +1 @@\n+x\n`).join(""));
    cli(TMP, "open", "--patch", many, "--id", "many-files", "--no-open");
    const piped = spawnSync("bash", ["-c", 'set -o pipefail; node "$0" show many-files | head -c 1 >/dev/null',
      path.join(HERE, "lookout.mjs")], { encoding: "utf8", env: ENV, cwd: TMP });
    ok("a closed pipe ends output quietly", piped.status === 0 && !/EPIPE|Unhandled/.test(piped.stderr), piped.stderr);
  }
}
}

// ---------------------------------------------------------------- big and plain
if (want("big and plain")) {
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

// ---------------------------------------------------------------- risk + groups
if (want("risk + groups")) {
  const SC = await import("./lib/score.mjs");
  const GR = await import("./lib/group.mjs");
  const T = await import("./lib/typesafe.mjs");
  ok("jev: the score is read from the distribution, not confidence",
     Math.abs(T.expected({ score: 9, confidence: 0.99, probabilities: { 0: 0, 1: 0.09, 2: 0.56, 3: 0.35 } }) - 0.753) < 0.001 &&
     T.expected({ confidence: 0.9 }) === null);
  {
    const keep = process.env.TYPESAFE_BASE_URL;
    process.env.TYPESAFE_BASE_URL = "https://api.typesafe.ai";
    const remote = T.contentAllowed({}), optIn = T.contentAllowed({ sendContent: true });
    process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:8123";
    const local = T.contentAllowed({});
    if (keep === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = keep;
    ok("jev: hunk text goes only to loopback or with sendContent", !remote && optIn && local);
  }

  const F = (p, adds = 10, dels = 2, extra = {}) => ({ path: p, status: "M", adds, dels, ...extra });
  const files = [F("README.md"), F("crew/hooks/news.sh"), F("server/routes.py"), F("src/app.js"),
                 F("src/app.test.js", 80), F("package-lock.json", 400, 300, { generated: true })];
  SC.rank(files, [], null);
  const r = Object.fromEntries(files.map(f => [f.path, f.risk]));
  ok("signals: hook and server files rank above docs", r["crew/hooks/news.sh"] > r["README.md"] && r["server/routes.py"] > r["README.md"]);
  ok("signals: a test ranks below its source, a lockfile below both", r["src/app.test.js"] < r["src/app.js"] &&
     r["package-lock.json"] < r["src/app.test.js"], JSON.stringify(r));
  SC.rank(files, [{ file: "README.md", severity: "major", status: "open" }], { ok: true, jev: { "README.md": 0 } });
  const readme = files.find(f => f.path === "README.md");
  ok("signals: an open major finding lifts a file however low Jev scored it", readme.risk >= 0.75 && readme.reasons.includes("open major finding"), readme.risk);
  SC.rank(files, [{ file: "README.md", severity: "major", status: "resolved" }], null);
  ok("signals: a resolved finding no longer lifts", files.find(f => f.path === "README.md").risk < 0.3);

  const texts = { "src/app.js": 'import { total } from "./lib/money";\nconst x = 1;\n',
                  "src/lib/money.js": "export const total = 1;\n",
                  "README.md": "See src/app.js and src/lib/money.js and lib/vendor.js.\n",
                  "bin/tool": "#!/bin/sh\nexec node tool.mjs\n", "notes/x.js": "// the tool and a review\n" };
  const gf = [F("src/app.js"), F("src/lib/money.js"), F("src/app.test.js"), F("README.md"), F("bin/tool"), F("notes/x.js"),
              F("a/one.py"), F("a/two.py")];
  SC.rank(gf, [], null);
  const { edges, unknown } = GR.edges(gf, { text: p => texts[p] || "", findings: [] },
    [...GR.DEFAULT_PROVIDERS, "jev-later"]);
  const has = (a, b, prov) => edges.some(e => e.a === a && e.b === b && e.provider === prov);
  ok("edges: an import links source to the imported file", has("src/app.js", "src/lib/money.js", "references"));
  ok("edges: docs naming files are not references", !edges.some(e => e.a === "README.md"));
  ok("edges: a bare word never matches an extensionless file", !has("notes/x.js", "bin/tool", "references"));
  ok("edges: a test is paired with its source", has("src/app.test.js", "src/app.js", "test-pair"));
  ok("edges: a small directory links its files", has("a/one.py", "a/two.py", "same-dir"));
  ok("edges: an unknown provider is reported, not fatal", unknown.length === 1 && unknown[0] === "jev-later");
  const groups = GR.group(gf, edges);
  const gOf = p => groups.find(g => g.files.includes(p));
  ok("groups: test, source and import share a group, with the why kept",
     gOf("src/app.test.js") === gOf("src/app.js") && gOf("src/app.js") === gOf("src/lib/money.js") &&
     gOf("src/app.js").edges.some(e => /tests/.test(e.why)));
  ok("groups: sorted by riskiest file, files within by risk",
     groups.every((g, i) => i === 0 || groups[i - 1].risk >= g.risk) &&
     groups.every(g => g.files.every((p, i) => i === 0 || gf.find(f => f.path === g.files[i - 1]).risk >= gf.find(f => f.path === p).risk)));
  const hub = Array.from({ length: 10 }, (_, i) => F(`m/mod${i}.js`));
  const hubEdges = hub.slice(1).map(f => ({ a: "m/mod0.js", b: f.path, weight: 1, why: "x", provider: "references" }));
  {
    const many = Array.from({ length: GR.REF_MAX_FILES + 1 }, (_, i) => F(`big/m${i}.js`));
    const t0 = Date.now();
    const e = GR.edges(many, { text: () => 'import x from "./m1.js";', findings: [] }, ["references"]).edges;
    ok("edges: references is bounded on a sweeping change", e.length === 0 && Date.now() - t0 < 2000);
  }
  ok("groups: a hub cannot swallow the whole change", Math.max(...GR.group(hub, hubEdges).map(g => g.files.length)) === GR.MAX_GROUP);
  {
    const twins = [F("x/README.md"), F("y/README.md"), F("z/tool.js")];
    const tw = GR.edges(twins, { text: p => p === "z/tool.js" ? 'read("README.md"); open("y/README.md")' : "", findings: [] }, ["references"]).edges;
    ok("edges: a basename two changed files share needs its folder to match", tw.length === 1 && tw[0].b === "y/README.md", JSON.stringify(tw));
  }
  const shared = GR.edges(gf, { text: () => "", findings: [{ id: "f1", file: "src/app.js", summary: "breaks a/one.py on retry" }] }, ["shared-finding"]).edges;
  ok("edges: a finding naming another file links the two", shared.length === 1 && shared[0].b === "a/one.py");

  {
    // Reviewer edges merge after every rule's: a folder pair stays together
    // even when a reviewer's chain would fill the group first.
    const rf = ["d/a.js", "d/b.js", "c.js", "e.js", "f.js", "g.js", "h.js"].map(p => ({ path: p, risk: 0.5 }));
    const chain = [["c.js", "e.js"], ["e.js", "f.js"], ["f.js", "g.js"], ["g.js", "h.js"], ["h.js", "d/a.js"]].map(([a, b]) => ({ a, b, why: "chain" }));
    const re = GR.edges(rf, { reviewerEdges: chain }, ["same-dir", "reviewer"]).edges;
    const ga = GR.group(rf, re).find(g => g.files.includes("d/a.js"));
    // (Merged first, the chain would take d/a.js to six files and leave d/b.js.)
    ok("groups: a reviewer edge never takes a file out of a rule's group", ga.files.includes("d/b.js"),
       JSON.stringify(ga.files));
  }

  // The whole open, against a mock client that logs every request it gets.
  const R3 = repo("r3");
  write(R3, "hooks/gate.sh", "#!/bin/sh\nexit 0\n");
  write(R3, "docs/guide.md", "# guide\n");
  sh(R3, `git add -A && ${G} commit -q -m base`);
  write(R3, "hooks/gate.sh", "#!/bin/sh\nSECRET_TOKEN=abc\nexit 1\n");
  write(R3, "docs/guide.md", "# guide\nmore\n");
  const log = path.join(TMP, "mock.log");
  const mock = path.join(TMP, "mock_typesafe.py");
  fs.writeFileSync(mock, [
    "import json, sys",
    "if sys.argv[1] == 'available': sys.exit(0)",
    "req = json.load(sys.stdin)",
    `open(${JSON.stringify(log)}, 'a').write(json.dumps(req) + '\\n')`,
    "out = {}",
    "for k, st in req['state'].items():",
    "    hi = 'hooks' in st['path']",
    "    out[k] = {'type': 'score', 'score': 0, 'confidence': 0.99,",
    "              'probabilities': {'0': 0.0, '1': 0.1, '2': 0.2, '3': 0.7} if hi else {'0': 0.9, '1': 0.1, '2': 0, '3': 0}}",
    "json.dump(out, sys.stdout)",
  ].join("\n"));
  const failing = path.join(TMP, "failing_typesafe.py");
  fs.writeFileSync(failing, "import sys\nif sys.argv[1] == 'available': sys.exit(0)\nsys.stderr.write('typesafe: HTTP Error 503\\n'); sys.exit(2)\n");
  const env = (client, extra = {}) => ({ ...ENV, LOOKOUT_TYPESAFE_CLIENT: client, TYPESAFE_BASE_URL: "https://api.typesafe.ai", ...extra });
  const open = (client, ...a) => spawnSync("node", [path.join(HERE, "lookout.mjs"), "open", "--worktree", "--json", ...a],
    { encoding: "utf8", env: env(client), cwd: R3 });
  const reqs = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];

  const o1 = JSON.parse(open(mock).stdout || "{}");
  const rv = S.read(o1.id);
  const byP = Object.fromEntries(rv.files.map(f => [f.path, f]));
  ok("open: one batched Jev request scores every file", reqs().length === 1 && Object.keys(reqs()[0].questions).length === 2 &&
     Object.values(reqs()[0].questions).every(q => q.type === "score"));
  ok("open: a remote endpoint gets paths and counts, never hunk text",
     !JSON.stringify(reqs()[0]).includes("SECRET_TOKEN") && Object.values(reqs()[0].state).every(st => !("changed_hunks" in st)));
  ok("open: Jev and signals together put the hook first", rv.scoring.ok && byP["hooks/gate.sh"].risk > byP["docs/guide.md"].risk &&
     byP["hooks/gate.sh"].jev > 0.8 && rv.groups[0].files[0] === "hooks/gate.sh");
  open(mock);
  ok("open: an unchanged patch reuses the cached scores (no second request)", reqs().length === 1);
  write(R3, ".seamux/lookout.json", '{"sendContent": true}');
  open(mock, "--rescore");
  const last = reqs().pop();
  ok("open: with sendContent the changed lines are sent", JSON.stringify(last).includes("SECRET_TOKEN"));
  fs.rmSync(path.join(R3, ".seamux"), { recursive: true });

  const o2 = JSON.parse(open(failing, "--rescore").stdout || "{}");
  const rf = S.read(o2.id);
  ok("open: a TypeSafe failure falls back to signals, with the reason kept for the banner",
     rf.scoring.ok === false && /503/.test(rf.scoring.why) && rf.files.every(f => typeof f.risk === "number" && f.jev === null), rf.scoring.why);
  const o3 = JSON.parse(open("", "--rescore").stdout || "{}");
  ok("open: no client at all is signals only too", S.read(o3.id).scoring.ok === false &&
     /no TypeSafe client/.test(S.read(o3.id).scoring.why));
  const page = fs.readFileSync(o3.page, "utf8");
  ok("page: the Risk view and its banner are in the page", page.includes('data-view="risk"') && page.includes("Risk from signals only"));
}

// ---------------------------------------------------------------- findings + gate
if (want("findings + gate")) {
  const FD = await import("./lib/findings.mjs");
  const one = { file: "a.js", line: 2, severity: "major", summary: "s", failure_scenario: "f" };
  ok("input: a bare array, {findings}, and a fenced block with prose all parse",
     FD.parseInput(JSON.stringify([one])).length === 1 && FD.parseInput(JSON.stringify({ findings: [one] })).length === 1 &&
     FD.parseInput("Here you go:\n```json\n" + JSON.stringify([one]) + "\n```\nDone.").length === 1);
  let threw = false; try { FD.parseInput("no json here"); } catch { threw = true; }
  ok("input: no array is an error, not an empty review", threw);

  const R4 = repo("r4");
  write(R4, "a.js", "const a = 1;\nconst b = 2;\n");
  write(R4, "b.py", "x = 1\n");
  sh(R4, `git add -A && ${G} commit -q -m base`);
  write(R4, "a.js", "const a = 1;\nconst b = 3;\nconst c = 4;\n");
  write(R4, "b.py", "x = 2\n");
  const id = JSON.parse(cli(R4, "open", "--worktree", "--json").stdout).id;
  const gate = (...a) => cli(R4, "gate", ...a);
  ok("gate: 3 before any reviewer has reported", gate(id).status === 3 && gate("no-such-review").status === 3);

  const ffile = path.join(TMP, "findings.json");
  fs.writeFileSync(ffile, JSON.stringify([
    { file: "a.js", line: 2, severity: "major", category: "Correctness", verdict: "confirmed", summary: "b is wrong", failure_scenario: "b=3 breaks x" },
    { file: "a.js", line: 1, side: "old", severity: "nit", summary: "old line", failure_scenario: "f" },
    { file: "b.py", line: 40, severity: "minor", summary: "outside", failure_scenario: "f", short_summary: "x".repeat(90) },
    { file: "zzz.js", line: 1, severity: "major", summary: "s", failure_scenario: "f" },
    { file: "a.js", line: 1, severity: "urgent", summary: "s", failure_scenario: "f" },
    { file: "a.js", line: 0, severity: "minor", summary: "s", failure_scenario: "f" },
    { file: "a.js", line: 1, severity: "minor", summary: "", failure_scenario: "f" },
  ]));
  const add = cli(R4, "findings", "add", id, ffile);
  const r = S.read(id);
  ok("findings add: three accepted, four rejected with reasons", add.status === 0 && r.findings.length === 3 &&
     (add.stdout.match(/rejected item/g) || []).length === 4 && /not in this review/.test(add.stdout), add.stdout);
  const [f1, f2, f3] = r.findings;
  ok("findings add: normalized (ids, category, verdict, side, status, clipped short summary)",
     f1.id === "f1" && f1.category === "correctness" && f1.verdict === "CONFIRMED" && f1.side === "new" && f1.status === "open" &&
     f2.side === "old" && f3.short_summary.length === 60);
  ok("findings add: a line the diff does not show is kept and flagged outside", f3.outside === true && f1.outside === false);
  cli(R4, "findings", "add", id, ffile);
  ok("findings add: ingesting the same file again adds nothing", S.read(id).findings.length === 3);
  {
    const fresh = JSON.parse(cli(R4, "open", "--worktree", "--id", "r4-rejected", "--json").stdout).id;
    const bad = path.join(TMP, "all-bad.json");
    fs.writeFileSync(bad, JSON.stringify([{ file: "/abs/a.js", line: 1, severity: "blocker", summary: "s", failure_scenario: "f" }]));
    const r1 = cli(R4, "findings", "add", fresh, bad);
    ok("findings add: all rejected changes nothing and the gate stays at no verdict",
       r1.status === 1 && !S.read(fresh).reviewedAt && cli(R4, "gate", fresh).status === 3, r1.stderr);
    const empty = path.join(TMP, "empty.json");
    fs.writeFileSync(empty, "[]");
    ok("findings add: an explicit [] is a review that found nothing (gate passes)",
       cli(R4, "findings", "add", fresh, empty).status === 0 && cli(R4, "gate", fresh).status === 0);
  }
  ok("findings move risk: the file with the major ranks first", S.read(id).groups[0].files[0] === "a.js" &&
     S.read(id).files.find(f => f.path === "a.js").reasons.includes("open major finding"));
  ok("gate: 1 while a major is open", gate(id).status === 1 && /f1 major a\.js:2/.test(gate(id).stdout));

  const res = cli(R4, "resolve", id, "f1", "done");
  ok("authority: the agent cannot resolve without the policy", res.status === 1 && /only the human closes/.test(res.stderr) &&
     S.read(id).findings[0].status === "open");
  ok("authority: nor dismiss", cli(R4, "dismiss", id, "f1").status === 1);
  ok("address: allowed, and leaves a status message", cli(R4, "address", id, "f1", "b is 2 again").status === 0 &&
     S.read(id).findings[0].status === "addressed" && S.read(id).findings[0].thread[0].kind === "status");
  ok("gate: an addressed major still blocks (the human closes it)", gate(id).status === 1 && /awaiting the human/.test(gate(id).stdout));
  ok("reply: lands in the thread as the agent", cli(R4, "reply", id, "f2", "it", "is", "fine").status === 0 &&
     S.read(id).findings[1].thread.at(-1).text === "it is fine" && S.read(id).findings[1].thread.at(-1).by === "agent");
  ok("reply: an unknown id is refused", cli(R4, "reply", id, "f99", "x").status === 1);

  // The human's close, as the page will do it (increment 4 carries it over HTTP).
  S.update(id, cur => { FD.setStatus(cur, "f1", "resolved", "human", "ok"); return cur; });
  const g0 = gate(id, "--json");
  ok("gate: 0 once the major is closed; minor and nit never hold it", g0.status === 0 && JSON.parse(g0.stdout).open === 2, g0.stdout);
  cli(R4, "reopen", id, "f1", "regressed");
  ok("reopen: the agent may reopen, and the gate blocks again", S.read(id).findings[0].status === "open" && gate(id).status === 1);

  // Comment threads (a human's line note) take replies and resolve.
  S.update(id, cur => { FD.comment(cur, { file: "b.py", line: 1, text: "why 2?" }); return cur; });
  ok("threads: a comment gets a t-id, and the agent can answer it",
     S.read(id).threads[0].id === "t1" && cli(R4, "reply", id, "t1", "spec says 2").status === 0 &&
     S.read(id).threads[0].messages.length === 2);
  ok("threads: re-open keeps findings and threads", (cli(R4, "open", "--worktree", "--json"), S.read(id).findings.length === 3 &&
     S.read(id).threads.length === 1));

  {
    // A same-size edit in the same second as the commit: the scratch index must
    // not trust the stat cache here (git's racy-entry rule needs the copied
    // index to keep the real one's mtime).
    const R6 = repo("r6");
    write(R6, "same.txt", "aaaa\n"); sh(R6, `git add -A && ${G} commit -q -m base`);
    write(R6, "same.txt", "bbbb\n");
    const rid = JSON.parse(cli(R6, "open", "--worktree", "--json").stdout).id;
    ok("scratch index: a same-size edit right after the commit is in the diff",
       S.read(rid).files.some(f => f.path === "same.txt"));
  }
  // A finding on a file that later leaves the diff is kept, still gates, and
  // is drawn in the page's "no longer in the diff" list.
  {
    const R5 = repo("r5");
    write(R5, "x.js", "a\n"); sh(R5, `git add -A && ${G} commit -q -m base`);
    write(R5, "x.js", "b\n"); write(R5, "y.js", "c\n");
    const gid = JSON.parse(cli(R5, "open", "--worktree", "--json").stdout).id;
    const gf = path.join(TMP, "ghost.json");
    fs.writeFileSync(gf, JSON.stringify([{ file: "x.js", line: 1, severity: "major", summary: "ghostly", failure_scenario: "f" }]));
    cli(R5, "findings", "add", gid, gf);
    write(R5, "x.js", "a\n");
    cli(R5, "open", "--worktree", "--json");
    const gr = S.read(gid);
    ok("left the diff: the finding is kept and still gates", !gr.files.some(f => f.path === "x.js") &&
       gr.findings.length === 1 && cli(R5, "gate", gid).status === 1);
    ok("left the diff: the page lists it where the human can close it",
       fs.readFileSync(S.paths(gid).html, "utf8").includes("ghostly") &&
       fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8").includes("no longer in the diff"));
  }
  ok("list: a reviewer's incoming file is not a review",
     (fs.writeFileSync(path.join(ENV.LOOKOUT_REVIEWS_DIR, id + ".incoming.json"), "[]"),
      !/undefined/.test(cli(R4, "list").stdout) && JSON.parse(cli(R4, "list", "--json").stdout).every(x => x.id)));

  // A review opened --agent-may-close lets the agent close.
  const idc = JSON.parse(cli(R4, "open", "--worktree", "--id", "r4-close", "--agent-may-close", "--json").stdout).id;
  cli(R4, "findings", "add", idc, ffile);
  ok("authority: --agent-may-close lets the agent resolve", cli(R4, "resolve", idc, "f1", "fixed").status === 0 &&
     S.read(idc).findings[0].status === "resolved" && S.read(idc).findings[0].statusBy === "agent");

  // The plan form: id from slug and increment, brief carries the cutover.
  fs.mkdirSync(path.join(TMP, "demo-plan.cutover"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "demo-plan.cutover", "02-make-b-three.md"), "# Make b three\nThe increment sets b to 3.\n");
  const pid = JSON.parse(cli(R4, "open", "--plan", "demo-plan", "--inc", "2", "--base", "HEAD", "--json").stdout).id;
  ok("plan: the review id is <slug>-inc<n>", pid === "demo-plan-inc2");
  ok("plan: gate --plan --inc finds it", gate("--plan", "demo-plan", "--inc", "2").status === 3 &&
     gate("--plan", "demo-plan", "--inc", "9").status === 3);
  const br = cli(R4, "prompt", pid).stdout;
  ok("prompt: carries the patch, the plan increment, the rubric, the schema and the ingest command",
     br.includes(S.paths(pid).patch) && br.includes("The increment sets b to 3.") && /security —/.test(br) &&
     br.includes('"failure_scenario"') && br.includes(`lookout findings add ${pid} `));
  ok("prompt: the reviewer writes its findings outside ~/.claude, where agent writes are refused",
     br.includes(path.join(os.tmpdir(), "lookout", pid + ".incoming.json")) && !/\.claude\/[^\s]*\.incoming\.json/.test(br));
  const rb = cli(R4, "prompt", pid, "--reply").stdout;
  ok("prompt --reply: the reviewer answers with the JSON, and writes no file and runs no ingest",
     /Your final reply is ONE JSON object/.test(rb) && rb.includes('"failure_scenario"') &&
     rb.includes(`lookout findings add ${pid} -`) && !rb.includes(".incoming.json") && !/^Write ONE JSON/m.test(rb));
  ok("prompt: a review opened without --context-file has no context section", !/## The context it was opened with/.test(br));
  // --context-file: text the opener wants beside the plan (a deep-plan family's
  // contracts), taken in at open and printed in the brief.
  const ctxf = path.join(TMP, "family-context.md");
  fs.writeFileSync(ctxf, "Members:\n- demo-kid: a workstream · consumes POST /session\n");
  const cid = JSON.parse(cli(R4, "open", "--id", "demo-fam-kid", "--plan", "demo-plan", "--inc", "2", "--base", "HEAD",
    "--context-file", ctxf, "--json").stdout).id;
  const cbr = cli(R4, "prompt", cid).stdout;
  ok("--context-file: the brief prints it beside the plan",
     cid === "demo-fam-kid" && /## The context it was opened with\n\nMembers:\n- demo-kid: a workstream · consumes POST \/session/.test(cbr) &&
     cbr.includes("The increment sets b to 3."));
  fs.writeFileSync(ctxf, "x".repeat(9000));
  cli(R4, "open", "--id", "demo-fam-big", "--base", "HEAD", "--context-file", ctxf, "--json");
  ok("--context-file: a long one is cut, and the cut is said",
     /\[… cut: the context ran to 9000 characters; the rest is in /.test(cli(R4, "prompt", "demo-fam-big").stdout));
  ok("--context-file: an unreadable file is refused",
     cli(R4, "open", "--id", "demo-fam-x", "--base", "HEAD", "--context-file", path.join(TMP, "no-such.md"), "--json").status !== 0);
  // The full delivery: --inc all is <slug>-delivery, and its brief carries
  // every increment's description.
  fs.writeFileSync(path.join(TMP, "demo-plan.cutover", "01-make-a-one.md"), "# Make a one\nThe first increment keeps a at 1.\n");
  const did = JSON.parse(cli(R4, "open", "--plan", "demo-plan", "--inc", "all", "--base", "HEAD", "--json").stdout).id;
  const dbr = cli(R4, "prompt", did).stdout;
  ok("plan: --inc all is the full delivery's review, gated by --inc all",
     did === "demo-plan-delivery" && S.read(did).source.inc === "all" && /the full delivery/.test(S.read(did).title) &&
     gate("--plan", "demo-plan", "--inc", "all").status === 3);
  ok("prompt: the delivery brief carries every increment, in order",
     /the plan it delivers, every increment/.test(dbr) && dbr.indexOf("keeps a at 1") >= 0 &&
     dbr.indexOf("keeps a at 1") < dbr.indexOf("sets b to 3"));
  const bs = cli(R4, "prompt", id).stdout;
  ok("prompt: standalone has no plan section and names the prior findings", !/plan increment it implements/.test(bs) &&
     /already has 3 finding/.test(bs));
  const page = fs.readFileSync(S.paths(id).html, "utf8");
  ok("page: findings and threads are in the drawn page", page.includes("b is wrong") && page.includes("why 2?"));
}

// ---------------------------------------------------------------- notes, edges, quiz
if (want("smells and the repo's conventions")) {
  const RS = repo("rs");
  write(RS, "a.js", "export const a = 1;\n");
  write(RS, "CLAUDE.md", "# Guide\n\n- No comments unless the why is non-obvious.\n- Run the tests before you push.\n" +
    "- Don't introduce abstractions for a second caller that isn't there.\n");
  sh(RS, `git add -A && ${G} commit -q -m base`);
  write(RS, "a.js", "// a is one\nexport const a = 1;\n");
  const id = JSON.parse(cli(RS, "open", "--worktree", "--json").stdout).id;
  const b = cli(RS, "prompt", id).stdout;
  ok("smell: the brief asks for smells, minor or nit, with a cost", /- smell — code that works but costs the next reader/.test(b) &&
    /Always minor or\s+nit/.test(b) && /naming the cost/.test(b), b.slice(0, 200));
  ok("smell: the brief quotes the repo's convention lines, and only those", /This repo's own conventions/.test(b) &&
    b.includes("- No comments unless the why is non-obvious.") && b.includes("abstractions for a second caller") &&
    !b.includes("Run the tests before you push"));
  const f = path.join(TMP, "smell.json");
  fs.writeFileSync(f, JSON.stringify([
    { file: "a.js", line: 1, severity: "nit", category: "smell", summary: "comment restates the code", failure_scenario: "a reader learns nothing; the comment drifts when a changes" },
    { file: "a.js", line: 2, severity: "major", category: "smell", summary: "too big", failure_scenario: "f" }]));
  const add = cli(RS, "findings", "add", id, f);
  const r = S.read(id);
  ok("smell: a nit smell is accepted, a major one refused with the reason",
    r.findings.length === 1 && r.findings[0].category === "smell" && /a smell is minor or nit at most/.test(add.stdout + add.stderr), add.stdout + add.stderr);
  ok("smell: it never holds the gate", cli(RS, "gate", id).status === 0);
  write(RS, "CLAUDE.md", "# Guide\n\nNothing about style here.\n");
  ok("smell: no matching convention lines, no conventions block", !/This repo's own conventions/.test(cli(RS, "prompt", id).stdout));
}

if (want("re-review rounds")) {
  const FD = await import("./lib/findings.mjs");
  const RR = repo("rr");
  write(RR, "a.js", "1\n"); write(RR, "b.js", "1\n"); sh(RR, `git add -A && ${G} commit -q -m base`);
  write(RR, "a.js", "2\n"); write(RR, "b.js", "2\n");
  const id = JSON.parse(cli(RR, "open", "--worktree", "--json").stdout).id;
  const F = (n, file) => ({ file, line: 1, side: "new", severity: "major", category: "correctness", verdict: "PLAUSIBLE",
    summary: `bug ${n}`, short_summary: `bug ${n}`, failure_scenario: "f", outside: false });
  S.update(id, cur => { FD.ingest(cur, [F(1, "a.js"), F(2, "b.js")]); cur.reviewedAt = new Date().toISOString(); return cur; });
  const hook = () => { const h = spawnSync("bash", [path.join(HERE, "hooks", "comments.sh")],
    { encoding: "utf8", env: ENV, input: JSON.stringify({ cwd: RR, hook_event_name: "UserPromptSubmit" }) });
    try { return JSON.parse(h.stdout).hookSpecificOutput.additionalContext; } catch { return ""; } };
  hook();
  ok("rounds: nothing addressed, nothing to re-review", /no addressed findings waiting/.test(cli(RR, "prompt", id, "--round").stderr));
  let r = cli(RR, "address", id, "f1", "guarded the empty case");
  ok("rounds: address says a re-review waits, round 1 of 2", /1 addressed finding\(s\) wait on a re-review \(round 1 of 2\)/.test(r.stdout) &&
    r.stdout.includes(`lookout prompt ${id} --round`), r.stdout);
  let h = hook();
  ok("rounds: the comments hook says so once", h.includes(`[lookout ${id}] 1 addressed finding(s) wait on a re-review`) && hook() === "", h);
  const b = cli(RR, "prompt", id, "--round").stdout;
  ok("rounds: the round brief lists the addressed finding and what changed, and only its file",
    /## Re-review, round 1/.test(b) && /- f1 major a\.js:1: bug 1\n  what changed: guarded the empty case/.test(b) &&
    /\+1 −1|a\.js/.test(b) && !/ b\.js  \+/.test(b), b.slice(0, 1500));
  ok("rounds: the round is sealed on the review", (S.read(id).rounds || []).length === 1 && S.read(id).rounds[0].findings.join() === "f1");
  ok("rounds: a sealed round is not briefed again", /no addressed findings waiting/.test(cli(RR, "prompt", id, "--round").stderr));
  cli(RR, "address", id, "f2", "fixed b");
  ok("rounds: round 2 briefs the next addressed finding", /## Re-review, round 2/.test(cli(RR, "prompt", id, "--round").stdout));
  S.update(id, cur => { FD.ingest(cur, [F(3, "a.js")]); return cur; });
  r = cli(RR, "address", id, "f3", "again");
  ok("rounds: after two rounds, address says to stop and ask the person", /had 2 re-review rounds: stop and ask the person/.test(r.stdout), r.stdout);
  r = cli(RR, "prompt", id, "--round");
  ok("rounds: …and a third round is refused", r.status !== 0 && /2 re-review rounds: stop and ask the person/.test(r.stderr), r.stderr);
  ok("rounds: the gate is unchanged by rounds", cli(RR, "gate", id).status === 1);
}

if (want("notes, edges, quiz")) {
  const FD = await import("./lib/findings.mjs");
  const N = await import("./lib/notes.mjs");
  const one = { file: "a.js", line: 2, severity: "major", summary: "s", failure_scenario: "f" };
  const po = FD.parseOutput(JSON.stringify({ findings: [one], edges: [{ a: "a", b: "b", why: "w" }], notes: [{ files: ["a"] }] }));
  ok("output: the object form carries findings, edges and notes", po.findings.length === 1 && po.edges.length === 1 && po.notes.length === 1);
  ok("output: a bare array is still findings only", FD.parseOutput(JSON.stringify([one])).notes.length === 0);
  ok("output: an unfenced array in prose is the array, not its first finding",
     FD.parseOutput("Here they are:\n" + JSON.stringify([one, one]) + "\nThat is all.").findings.length === 2);
  let why = ""; try { FD.parseOutput(JSON.stringify({ notes: [{ files: ["a"], why_risky: "x" }] })); } catch (e) { why = e.message; }
  ok("output: an object without a findings array is refused, never read as findings", /no findings array/.test(why), why);

  const good = { prompt: "A request arrives with a cookie signed by the old key. What happens?",
    options: ["it is rejected as unsigned", "it is accepted until it expires", "it is re-signed with the new key"], answer: 0,
    why: "verify only knows the current key" };
  ok("quiz lint: a balanced question passes", N.lintQuiz(good).length === 0, N.lintQuiz(good));
  const lint = q => N.lintQuiz({ ...good, ...q }).join("; ");
  ok("quiz lint: leading words", /leading word/.test(lint({ options: ["the correct one is this", "it is accepted until it expires", "it is re-signed with a key"] })));
  ok("quiz lint: all/none of the above", /all\/none/.test(lint({ options: ["it is rejected as unsigned", "none of the above", "it is re-signed with the new key"], answer: 1 })));
  ok("quiz lint: the answer may not be the single longest option",
     /single longest/.test(lint({ options: ["it is rejected outright as an unsigned cookie", "it is accepted", "it is re-signed now"] })));
  ok("quiz lint: lengths within 2.2x", /2\.2x/.test(lint({ options: ["no", "it is accepted until it expires", "it is re-signed with the new key"] })));
  ok("quiz lint: no prompt echo unique to the answer", /echoes "rejected"/.test(lint({ prompt: "Is the cookie rejected?" })));
  ok("quiz lint: an answer index off the end", /index options/.test(lint({ answer: 3 })));

  const R8 = repo("r8");
  write(R8, "src/auth/session.js", "export function verify(c) {\n  return check(c);\n}\n");
  write(R8, "server/routes.js", "import { verify } from 'x';\n");
  write(R8, "lib/money.js", "export const m = 1;\n");
  write(R8, "lib/tax.js", "export const t = 1;\n");
  write(R8, "docs/x.md", "# x\n");
  sh(R8, `git add -A && ${G} commit -q -m base`);
  write(R8, "src/auth/session.js", "export function verify(c) {\n  return c && check(c);\n}\nexport const MAX_AGE = 30;\n");
  write(R8, "server/routes.js", "import { verify } from 'x';\napp.use(verify);\n");
  write(R8, "lib/money.js", "export const m = 2;\n");
  write(R8, "lib/tax.js", "export const t = 2;\n");
  write(R8, "docs/x.md", "# x\nmore\n");
  const id = JSON.parse(cli(R8, "open", "--worktree", "--quiz", "--id", "n8", "--json").stdout).id;
  ok("quiz: --quiz is recorded in the policy, and every file has a hunk hash",
     S.read(id).policy.quiz === true && S.read(id).files.every(f => /^[0-9a-f]{16}$/.test(f.hash)));
  cli(R8, "open", "--worktree", "--id", "n8", "--json");
  ok("quiz: a re-open without --quiz does not turn it off", S.read(id).policy.quiz === true);
  cli(R8, "open", "--worktree", "--id", "n8b", "--json");
  const re = cli(R8, "open", "--worktree", "--id", "n8b", "--quiz");
  ok("quiz: a re-open with --quiz does not turn it on, and says so", S.read("n8b").policy.quiz === false && /does not add it/.test(re.stdout), re.stdout);
  {
    const R10 = repo("r10");
    write(R10, ".seamux/lookout.json", '{"quiz": true}'); write(R10, "a.js", "1\n");
    sh(R10, `git add -A && ${G} commit -q -m base`);
    write(R10, "a.js", "2\n");
    const rid = JSON.parse(cli(R10, "open", "--worktree", "--json").stdout).id;
    ok("quiz: .seamux/lookout.json quiz: true is the repo's default", S.read(rid).policy.quiz === true);
  }

  const inFile = (name, obj) => { const f = path.join(TMP, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
  const base = { why_risky: "a forged cookie reaches every route", direction: "verification moves from each route to one middleware",
                 watch: [{ text: "check() still throws on a bad signature", file: "src/auth/session.js", line: 2 }], touches: ["security-boundary"] };
  const major = { file: "src/auth/session.js", line: 2, severity: "major", summary: "null cookie passes", failure_scenario: "c=null returns null, read as ok" };
  const r1 = cli(R8, "findings", "add", id, inFile("n1.json", {
    findings: [major],
    edges: [{ a: "server/routes.js", b: "src/auth/session.js", why: "routes mount verify from session" },
            { a: "nope.js", b: "lib/tax.js", why: "x" }, { a: "lib/tax.js", b: "docs/x.md", why: "" }],
    notes: [
      { ...base, files: ["src/auth/session.js"] },
      { ...base, files: ["src/auth/session.js"], quiz: { ...good, options: ["it is rejected outright as an unsigned cookie", "it is accepted", "it is re-signed now"] } },
      { ...base, files: ["lib/money.js"], touches: ["vibes"] },
      { ...base, files: ["lib/money.js", "lib/tax.js"], watch: [{ text: "far away", file: "lib/tax.js", line: 40 }], touches: [], quiz: good },
      { ...base, files: ["lib/money.js", "docs/x.md"], watch: [], touches: ["data-model"] },
    ] }));
  const v1 = S.read(id);
  const authG = v1.groups.find(g => g.files.includes("src/auth/session.js"));
  ok("edges: a reviewer edge joins two groups, and its why is on the rail",
     authG.files.includes("server/routes.js") && authG.edges.some(e => e.provider === "reviewer" && e.why === "reviewer: routes mount verify from session"),
     JSON.stringify(authG));
  ok("edges: an unknown file and a missing why are rejected", (r1.stdout.match(/rejected edge/g) || []).length === 2 &&
     /not in this review/.test(r1.stdout) && /why is required/.test(r1.stdout), r1.stdout);
  ok("quiz: a high group's note without a question is rejected (the major made it high)",
     authG.band === "high" && /g1 is a high group and the quiz is on/.test(r1.stdout), r1.stdout);
  ok("quiz: a leaky question is rejected with the lint's reason", /quiz: the answer is the single longest/.test(r1.stdout), r1.stdout);
  ok("notes: touches outside the four are rejected", /"vibes" is not one of invariant/.test(r1.stdout));
  const nt = v1.notes.find(n => n.files.length === 2 && n.files.includes("lib/tax.js"));
  ok("quiz: a question on a group that is not high is dropped, the note kept", nt && !nt.quiz && /only a high group gets a question/.test(r1.stdout));
  ok("notes: a watch on a line the diff does not show is kept and flagged outside", nt && nt.watch[0].outside === true);
  const np = v1.notes.find(n => n.files.includes("docs/x.md"));
  ok("notes: a note whose files sit in two groups is partial", np && np.partial === true && np.group);
  ok("notes: the owed list names the high group still without a question", /still owed: g1 \(high/.test(r1.stdout), r1.stdout);

  const r2 = cli(R8, "findings", "add", id, inFile("n2.json", { findings: [major], notes: [{ ...base, files: ["src/auth/session.js"], quiz: good }] }));
  const v2 = S.read(id);
  const na = v2.notes.find(n => n.files.join() === "src/auth/session.js");
  ok("notes: keyed by files, a one-file note lands on the group the reviewer's edge grew",
     na && na.quiz && na.group === v2.groups.find(g => g.files.includes("server/routes.js")).id && !na.partial, JSON.stringify(na));
  ok("findings add: a repeat finding is skipped, and nothing is owed now", /0 finding\(s\) added, 1 already there/.test(r2.stdout) &&
     !/still owed: g1/.test(r2.stdout), r2.stdout);
  ok("prompt: with the quiz on, the brief marks the high group and prints the quiz schema",
     /g1 high\s+note \+ quiz/.test(cli(R8, "prompt", id).stdout) && cli(R8, "prompt", id).stdout.includes('"quiz"'));
  ok("prompt: without it, no question is asked for", !cli(R8, "prompt", "n8b").stdout.includes('"quiz"') &&
     !/note \+ quiz/.test(cli(R8, "prompt", "n8b").stdout));

  // An answered question survives the reviewer re-writing the note.
  S.update(id, cur => { cur.notes.find(n => n.id === na.id).quiz.answered = { pick: 1, correct: false, by: "human" }; return cur; });
  cli(R8, "findings", "add", id, inFile("n3.json", { findings: [], notes: [{ ...base, files: ["src/auth/session.js"], direction: "new words",
    quiz: { ...good, prompt: "A different question about the cookie?" } }] }));
  const na3 = S.read(id).notes.find(n => n.id === na.id);
  ok("notes: the same files replace the note's text but keep an answered question", na3.direction === "new words" &&
     na3.quiz.prompt === good.prompt && na3.quiz.answered.pick === 1 && S.read(id).notes.filter(n => n.files.join() === "src/auth/session.js").length === 1);

  cli(R8, "findings", "add", id, inFile("n3b.json", { findings: [], notes: [{ ...base, files: ["src/auth/session.js", "server/routes.js"],
    direction: "the whole group", quiz: { ...good, prompt: "Yet another question about the cookie?" } }] }));
  const grown = S.read(id).notes.filter(n => n.files.includes("src/auth/session.js"));
  ok("notes: a note on a grown group replaces the notes it covers, keeping the id and the answered question",
     grown.length === 1 && grown[0].id === na.id && grown[0].direction === "the whole group" && grown[0].quiz.answered.pick === 1, JSON.stringify(grown));
  write(R8, "lib/tax.js", "export const t = 3;\n");
  cli(R8, "open", "--worktree", "--id", "n8", "--json");
  const v4 = S.read(id);
  ok("stale: a note goes stale when one of its files' hunks change, and only that note",
     v4.notes.find(n => n.id === nt.id).stale === true && v4.notes.find(n => n.id === na.id).stale === false);
  ok("stale: notes and reviewer edges survive the re-open", v4.notes.length === 3 && v4.reviewerEdges.length === 1);
  cli(R8, "findings", "add", id, inFile("n4.json", { findings: [], notes: [{ ...base, files: ["lib/tax.js", "lib/money.js"], watch: [], touches: [] }] }));
  ok("stale: re-writing the note refreshes it", S.read(id).notes.find(n => n.id === nt.id).stale === false);

  const all = cli(R8, "findings", "add", id, inFile("n5.json", { findings: [{ ...major, file: "/abs" }], notes: [{ ...base, files: ["docs/x.md"] }] }));
  ok("findings add: every finding rejected changes nothing, notes or not", all.status === 1 &&
     !S.read(id).notes.some(n => n.files.join() === "docs/x.md"));

  // Plan drift: a finding only a plan review can have, always major or worse.
  const drift = { ...major, category: "plan-drift", severity: "minor", summary: "verify moved to middleware; the increment keeps it per route" };
  const sd = cli(R8, "findings", "add", "n8b", inFile("n6.json", { findings: [drift] }));
  ok("drift: a standalone review refuses plan-drift", sd.status === 1 && /plan-drift needs a plan increment/.test(sd.stdout), sd.stdout);
  fs.mkdirSync(path.join(TMP, "drift-plan.cutover"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "drift-plan.cutover", "01-verify-per-route.md"), "# Verify per route\nEach route calls verify itself.\n");
  const pid = JSON.parse(cli(R8, "open", "--plan", "drift-plan", "--inc", "1", "--worktree", "--json").stdout).id;
  cli(R8, "findings", "add", pid, inFile("n7.json", { findings: [drift], notes: [{ ...base, files: ["src/auth/session.js"] }] }));
  const dv = S.read(pid);
  ok("drift: in a plan review it is raised to major and holds the gate",
     dv.findings[0].severity === "major" && dv.findings[0].category === "plan-drift" && cli(R8, "gate", pid).status === 1);
  ok("drift: the note on its file lists it", dv.notes[0].drift.includes(dv.findings[0].id));
  ok("drift: the brief of a plan review asks for it, a standalone one does not",
     /category "plan-drift"/.test(cli(R8, "prompt", pid).stdout) && !/plan-drift/.test(cli(R8, "prompt", "n8b").stdout));

  // The cap: a reviewer linking eight files in a chain still makes groups of six or fewer.
  const R9 = repo("r9");
  const names = "abcdefgh".split("").map((c, i) => `${c}/m${i}.js`);
  for (const n of names) write(R9, n, "1\n");
  sh(R9, `git add -A && ${G} commit -q -m base`);
  for (const n of names) write(R9, n, "2\n");
  const cid = JSON.parse(cli(R9, "open", "--worktree", "--json").stdout).id;
  const chain = names.slice(1).map((n, i) => ({ a: names[i], b: n, why: "one chain" }));
  const cr = cli(R9, "findings", "add", cid, inFile("n8.json", { findings: [], edges: chain }));
  const big = Math.max(...S.read(cid).groups.map(g => g.files.length));
  ok("edges: reviewer edges stay under the six-file cap", /7 edge\(s\)/.test(cr.stdout) && big === (await import("./lib/group.mjs")).MAX_GROUP, `${big} ${cr.stdout}`);
  S.update(cid, cur => { cur.scoring.providers = cur.scoring.providers.filter(n => n !== "reviewer"); delete cur.scoring.providersFromConfig; return cur; });
  cli(R9, "sync", cid);
  {
    // The page: the notes travel in its data, and its script draws them.
    const html = fs.readFileSync(S.paths(id).html, "utf8");
    const js = fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8");
    const tpl = fs.readFileSync(path.join(HERE, "page", "review.html"), "utf8");
    ok("page: the drawn page carries the notes and the quiz policy",
       html.includes(base.why_risky) && html.includes('"quiz":true') && html.includes(good.prompt));
    ok("page: an Overview it opens on when there are notes, toggled by o and the header button",
       /function drawOverview\(/.test(js) && /notesOf\(\)\.length\) openOverview\(\);/.test(js) &&
       js.includes('e.key === "o"') && tpl.includes('id="ov-btn"'));
    ok("page: a question hides its note only on a served page with the quiz on, until answered",
       /const asking = n => quizOn\(\) && served\(\) && n\.quiz && !n\.quiz\.answered;/.test(js) &&
       /asking\(n\) \? quizBlock\(n\) :/.test(js));
    ok("page: a file shows its group's note as a strip above the diff, and watch items go to their lines",
       js.includes("strip(f.path),") && /function goToLine\(/.test(js) && js.includes("tr.line[data-${side"));
    ok("page: opened as a file with the quiz on, it says the quiz needs crew's server",
       js.includes("which needs crew's intent server to record answers"));
  }
  ok("edges: a review opened before the reviewer provider still draws reviewer edges", Math.max(...S.read(cid).groups.map(g => g.files.length)) === 6);
  S.update(cid, cur => { cur.scoring.providersFromConfig = true; return cur; });
  cli(R9, "sync", cid);
  ok("edges: a repo's edgeProviders without reviewer ignores the reviewer's edges", Math.max(...S.read(cid).groups.map(g => g.files.length)) === 1);
  ok("edges: and findings add says they are stored but not drawn",
     /stored but not drawn/.test(cli(R9, "findings", "add", cid, inFile("n9.json", { findings: [], edges: chain.slice(0, 1) })).stdout));

  // A review opened before hashes existed: a note written now is not stale.
  const hid = JSON.parse(cli(R9, "open", "--worktree", "--id", "r9-nohash", "--json").stdout).id;
  S.update(hid, cur => { for (const f of cur.files) delete f.hash; return cur; });
  cli(R9, "findings", "add", hid, inFile("n10.json", { findings: [], notes: [{ ...base, files: [names[0]], watch: [], touches: [] }] }));
  ok("stale: a file with no hash is unknown, not changed", S.read(hid).notes[0].stale === false);

  // A binary file's blob ids stand in for the hunks it does not have.
  const R11 = repo("r11");
  fs.writeFileSync(path.join(R11, "img.bin"), Buffer.from([0, 1, 2, 0, 255]));
  sh(R11, `git add -A && ${G} commit -q -m base`);
  fs.writeFileSync(path.join(R11, "img.bin"), Buffer.from([0, 1, 3, 0, 255]));
  const bid = JSON.parse(cli(R11, "open", "--worktree", "--json").stdout).id;
  const h1 = S.read(bid).files[0].hash;
  fs.writeFileSync(path.join(R11, "img.bin"), Buffer.from([0, 9, 3, 0, 255]));
  cli(R11, "open", "--worktree", "--json");
  ok("stale: a binary file that changes again gets a new hash", S.read(bid).files[0].binary && h1 !== S.read(bid).files[0].hash);
}

// ---------------------------------------------------------------- comments hook
if (want("comments hook")) {
  const R7 = repo("r7");
  write(R7, "a.js", "1\n"); sh(R7, `git add -A && ${G} commit -q -m base`);
  write(R7, "a.js", "2\n");
  fs.mkdirSync(path.join(R7, "sub"), { recursive: true });
  const id = JSON.parse(cli(R7, "open", "--worktree", "--json").stdout).id;
  const hook = (cwd, event = "UserPromptSubmit") => spawnSync("bash", [path.join(HERE, "hooks", "comments.sh")],
    { encoding: "utf8", env: ENV, input: JSON.stringify({ cwd, hook_event_name: event }) });
  ok("hook: a review with nothing from the human says nothing", hook(R7).stdout === "");
  // The human comments and closes on the page (the intent server's writes).
  const FD = await import("./lib/findings.mjs");
  S.update(id, cur => {
    FD.ingest(cur, [{ file: "a.js", line: 1, side: "new", severity: "major", category: "correctness", verdict: "PLAUSIBLE",
      summary: "s", short_summary: "s", failure_scenario: "f", outside: false }]);
    FD.comment(cur, { file: "a.js", line: 1, text: "why 2 and not 3?" }, "human");
    FD.setStatus(cur, "f1", "dismissed", "human", "intended");
    FD.reply(cur, "f1", "agent words", "agent");
    return cur;
  });
  const out = hook(path.join(R7, "sub"));
  let ctx = "";
  try { const j = JSON.parse(out.stdout); ctx = j.hookSpecificOutput.additionalContext; ok("hook: the event name is echoed", j.hookSpecificOutput.hookEventName === "UserPromptSubmit"); }
  catch { ok("hook: emits additionalContext JSON", false, out.stdout + out.stderr); }
  ok("hook: a session in the repo (a subfolder too) hears the human's comment and close",
     ctx.includes(`[lookout ${id}] 2 new`) && ctx.includes('t1 (comment on a.js:1): "why 2 and not 3?"') &&
     ctx.includes("f1 (major finding, a.js:1): the human marked it dismissed") && ctx.includes(`lookout reply ${id}`), ctx);
  ok("hook: the agent's own words are not echoed back", !ctx.includes("agent words"));
  ok("hook: on a review the agent may not close, it says only the human resolves",
     ctx.includes("Only the human resolves or dismisses.") && !ctx.includes("--agent-may-close"), ctx);
  ok("hook: each message is delivered once", hook(R7).stdout === "");
  {
    // Opened with --agent-may-close: the hook must not tell the agent otherwise.
    S.update(id, cur => { cur.policy = { ...(cur.policy || {}), agentMayClose: true }; FD.reply(cur, "t1", "you may close it", "human"); return cur; });
    const may = hook(R7).stdout;
    ok("hook: on an --agent-may-close review it names the agent's resolve and dismiss",
       may.includes("opened with --agent-may-close") && may.includes(`lookout resolve|dismiss ${id}`) && !may.includes("Only the human"), may);
    S.update(id, cur => { cur.policy = { ...(cur.policy || {}), agentMayClose: false }; return cur; });
  }
  S.update(id, cur => { FD.reply(cur, "t1", "and also this", "human"); return cur; });
  const again = hook(R7, "SessionStart").stdout;
  ok("hook: only what is new since the last prompt", again.includes("1 new") && again.includes("and also this") && !again.includes("why 2"));
  ok("hook: a session elsewhere hears nothing", (S.update(id, cur => { FD.reply(cur, "t1", "x", "human"); return cur; }), hook(TMP).stdout === ""));
  const none = spawnSync("bash", [path.join(HERE, "hooks", "comments.sh")],
    { encoding: "utf8", env: { ...ENV, LOOKOUT_REVIEWS_DIR: path.join(TMP, "empty-reviews") }, input: "{}" });
  ok("hook: no reviews at all costs a glob and exits clean", none.status === 0 && none.stdout === "");
  ok("hook: garbage on stdin never fails the prompt",
     spawnSync("bash", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", env: ENV, input: "{not json" }).status === 0);

  // Quiz answers (recorded by crew's server): a wrong one reaches the
  // session once, with the question, the pick, the expected answer and why;
  // a right one never does.
  S.update(id, cur => {
    const q = (prompt, answer, pick) => ({ prompt, options: ["it throws", "it is cached", "it is ignored"], answer, why: "db is never imported",
      answered: { pick, correct: pick === answer, at: new Date().toISOString(), by: "human" } });
    cur.policy = { ...cur.policy, quiz: true };
    cur.notes = [{ id: "n1", files: ["a.js"], group: "g1", why_risky: "w", direction: "d", watch: [], touches: [], quiz: q("What happens with a code?", 0, 2) },
                 { id: "n2", files: ["a.js"], group: "g1", why_risky: "w", direction: "d", watch: [], touches: [], quiz: q("And without one?", 1, 1) }];
    return cur;
  });
  const qctx = (() => { try { return JSON.parse(hook(R7).stdout).hookSpecificOutput.additionalContext; } catch { return ""; } })();
  ok("hook: a wrong quiz answer names the question, the pick, the expected answer and why",
     qctx.includes('n1 quiz (g1: a.js): the human answered "it is ignored" to "What happens with a code?"; the code says "it throws" — db is never imported') &&
     /explain it from the code/.test(qctx), qctx);
  ok("hook: a right answer is never delivered", !qctx.includes("And without one?") && !qctx.includes("n2 quiz"));
  ok("hook: the wrong answer is delivered once", hook(R7).stdout === "");
  S.update(id, cur => { cur.notes = [{ ...cur.notes[0], id: "n7" }]; return cur; });
  ok("hook: an answered question carried onto another note by a merge is not delivered again", hook(R7).stdout === "");

  // sync re-ranks after a page close: a resolved major stops lifting its file.
  S.update(id, cur => { FD.setStatus(cur, "f1", "open", "human"); return cur; });
  cli(R7, "sync", id);
  const before = S.read(id).files[0].risk;
  S.update(id, cur => { FD.setStatus(cur, "f1", "resolved", "human"); return cur; });
  cli(R7, "sync", id);
  ok("sync: re-ranks after a close made outside the CLI", S.read(id).files[0].risk < before);
  const page = fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8");
  ok("page: a served page answers through op answer", page.includes('send({ op: "answer", item: n.id, pick }, status)'));
  ok("page: has the served mode (serve, polling, POST)", /function serve\(/.test(page) && page.includes('method: "POST"') &&
     page.includes(".json?t="));
  ok("page: a new diff reloads only when nothing is being typed, else a banner offers the reload",
     /if \(next\.patchHash !== R\.patchHash\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*if \(!busy\(\)\) \{ location\.reload\(\); return; \}/.test(page) &&
     page.includes("live.stale = true") && page.includes("Reload when ready"));
  ok("page: drafts are kept per item in localStorage and put back after every redraw",
     page.includes('"lookout.drafts." + R.id') && /function drawFile\(\) \{[\s\S]{0,400}drawFileNow\(\);\s*afterDraw\(keep\);/.test(page) &&
     page.includes('"r:" + x.id') && page.includes("openComposer(tr, side, Number(line))"));
  ok("page: a composer draft is placed only on its own diff or an unchanged line, else shown unplaced",
     page.includes("if (d.h === R.patchHash) return true;") &&
     page.includes('/\\w/.test(d.x[1] || "") &&\n        JSON.stringify(lineCtx(file, side, line)) === JSON.stringify(d.x);') &&
     page.includes("if (!placeable(k, file, side, Number(line))) { unplaced.push(") && page.includes('class: "outside unplaced"'));
  ok("page: a send that reaches no server is told by the TypeError, not by its wording",
     page.includes("}).catch(e => { e.unreachable = true; throw e; })") && page.includes("status.textContent = e.unreachable ? \"not sent") && !page.includes("live.down || e.unreachable") &&
     !page.includes("/fetch/i") && !page.includes("e instanceof TypeError"));
  ok("page: a draft is saved by one key over what storage holds now, and other tabs' writes are taken in",
     /const saveDraft = \(k, v, meta\) => \{\s*const all = readDrafts\(\);/.test(page) && page.includes('addEventListener("storage"') &&
     page.includes("for (const k of Object.keys(before)) if (!(k in now)) delete drafts[k];") &&
     !page.includes("for (const k of Object.keys(drafts)) if (!(k in all)) delete drafts[k];"));
  ok("page: a composer opened on a line whose saved draft does not fit starts empty; the draft stays apart",
     page.includes("if (drafts[key] != null && !placeable(key, file, side, line)) {\n        setAside(key, file, side, line);") &&
     /function setAside\(key, file, side, line\)/.test(page));
  ok("page: a poll that reached nothing takes nothing (no reload onto a dead server)",
     page.includes("return UNREACHED; })") && page.includes("if (j === UNREACHED) return;"));
  ok("page: the reload banner clears when the page's own diff comes back",
     /\/\/ The page's own diff again[^\n]*\n\s*if \(live\.stale\) \{ live\.stale = false; drawHeader\(\); \}/.test(page));
  ok("page: a restored draft does not hold fresher reviews back; one focused or typed in since load does",
     page.includes("(t === document.activeElement || edited.has(t.dataset.draft))") && page.includes("edited.add(k);"));
  ok("page: only a poll that reached nothing counts toward disconnected; an HTTP error is a short note",
     page.includes('setHttp(r.ok ? "" : "HTTP " + r.status);') && page.includes("}, () => { if (++fails >= DOWN_AFTER) setDown(true); return UNREACHED; })") &&
     page.includes("`live · last poll ${live.http}`"));
  ok("page: a sent draft is cleared before the redraw that follows",
     /if \(key\) \{\s*saveDraft\(key, ""\); openComposers\.delete\(key\);/.test(page));
  ok("page: failed polls turn the header to disconnected, and a good one turns it back",
     page.includes("if (++fails >= DOWN_AFTER) setDown(true)") && page.includes("fails = 0; setDown(false);") &&
     page.includes("disconnected — run `lookout open` to reconnect"));
  ok("page: a hidden tab's poll says so (bg=1), so it does not keep the server up",
     page.includes('document.hidden ? "&bg=1" : ""'));
}

// ---------------------------------------------------------------- setup
if (want("setup")) {
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

// ---------------------------------------------------------------- the review lock
// withLock against what a crashed or busy writer leaves behind. Each attempt
// runs in a child with a hard timeout (the failure guarded against is a writer
// that never returns), and the two that wait out the deadline run side by side.
// crew/board/board_probe.mjs runs the same cases against crew's python twin.
if (want("the review lock")) {
  const { spawn } = await import("node:child_process");
  const dir = path.join(TMP, "lock-reviews");
  fs.mkdirSync(dir, { recursive: true });
  const lk = id => path.join(dir, id + ".lock");
  const old = new Date(Date.now() - 60000);
  const plant = (p, stale) => { fs.mkdirSync(p); if (stale) fs.utimesSync(p, old, old); };
  const take = id => new Promise(res => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", `
const S = await import(${JSON.stringify(path.join(HERE, "lib", "store.mjs"))});
const t = Date.now();
try { S.withLock(process.argv[1], () => {}); console.log(JSON.stringify({ took: true })); }
catch (e) { console.log(JSON.stringify({ took: false, err: e.message, s: (Date.now() - t) / 1000 })); }`, id],
      { env: { ...ENV, LOOKOUT_REVIEWS_DIR: dir }, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", d => (out += d));
    const kill = setTimeout(() => c.kill("SIGKILL"), 10000);
    c.on("exit", () => { clearTimeout(kill); try { res(JSON.parse(out)); } catch { res(null); } });
  });
  const waited = r => r && r.took === false && /locked by another writer/.test(r.err) && r.s >= 4.5 && r.s < 8;
  plant(lk("guard"), true); plant(lk("guard") + "-break", false);
  plant(lk("crash"), true); plant(lk("crash") + "-break", true);
  plant(lk("spin"), true); fs.writeFileSync(path.join(lk("spin"), "x"), ""); fs.utimesSync(lk("spin"), old, old);
  const [guard, crash, spin] = await Promise.all([take("guard"), take("crash"), take("spin")]);
  ok("lock: a stale lock another breaker is at work on (a fresh .lock-break) is waited out, not broken",
     waited(guard) && fs.existsSync(lk("guard")) && fs.existsSync(lk("guard") + "-break"), JSON.stringify(guard));
  ok("lock: a crashed breaker's stale .lock-break is cleared, then the stale lock is broken",
     crash?.took === true && !fs.existsSync(lk("crash")) && !fs.existsSync(lk("crash") + "-break"), JSON.stringify(crash));
  ok("lock: a stale lock that will not go (rmdir gets ENOTEMPTY) is a timeout, not a hang",
     waited(spin) && !fs.existsSync(lk("spin") + "-break"), JSON.stringify(spin));
}

// ---------------------------------------------------------------- host detection
if (want("host detection")) {
  const HOST = (await import("./lib/host.mjs")), HOST_TWIN = (await import("../deep-plan/lib/host.mjs"));
  const HOST_TABLE = [
    [{}, "terminal"],
    [{ CMUX_WORKSPACE_ID: "W1" }, "cmux"],
    [{ CLAUDE_CODE_REMOTE: "true" }, "remote"],
    [{ CLAUDE_CODE_REMOTE: "1" }, "terminal"],
    [{ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "desktop"],
    [{ CLAUDE_CODE_ENTRYPOINT: "claude-desktop-3p" }, "desktop"],
    [{ CLAUDE_CODE_ENTRYPOINT: "local-agent" }, "desktop"],
    [{ CLAUDE_CODE_ENTRYPOINT: "cli" }, "terminal"],
    [{ CMUX_WORKSPACE_ID: "W1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "cmux"],
    [{ CMUX_WORKSPACE_ID: "W1", CLAUDE_CODE_REMOTE: "true" }, "cmux"],
    [{ CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "remote"],
    [{ SEAMUX_HOST: "desktop", CMUX_WORKSPACE_ID: "W1" }, "desktop"],
    [{ SEAMUX_HOST: "Terminal", CLAUDE_CODE_REMOTE: "true" }, "terminal"],
    [{ SEAMUX_HOST: "remote" }, "remote"],
    [{ SEAMUX_HOST: "cmux" }, "cmux"],
    [{ SEAMUX_HOST: "bogus", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "desktop"],
    [{ SEAMUX_PANE_ID: "P1" }, "seamux"],
    [{ SEAMUX_PANE_ID: "P1", CMUX_WORKSPACE_ID: "W1" }, "cmux"],
    [{ SEAMUX_PANE_ID: "P1", CMUX_WORKSPACE_ID: "W1", SEAMUX_BACKEND: "tmux" }, "seamux"],
    [{ CMUX_WORKSPACE_ID: "W1", SEAMUX_BACKEND: "tmux" }, "terminal"],
    [{ SEAMUX_PANE_ID: "P1", CLAUDE_CODE_REMOTE: "true" }, "seamux"],
    [{ SEAMUX_HOST: "seamux" }, "seamux"],
  ];
  for (const [env, want] of HOST_TABLE) {
    const got = HOST.detectHost(env), twin = HOST_TWIN.detectHost(env);
    ok(`host: ${JSON.stringify(env)} is ${want}`, got.host === want);
    ok(`host: the deep-plan copy agrees on ${JSON.stringify(env)}`, twin.host === got.host && twin.why === got.why);
  }
  const IDS = [
    [{}, { workspace: "", pane: "" }],
    [{ CMUX_WORKSPACE_ID: "W1", CMUX_SURFACE_ID: "S1" }, { workspace: "W1", pane: "S1" }],
    [{ SEAMUX_WORKSPACE_ID: "W2", SEAMUX_PANE_ID: "P2", CMUX_WORKSPACE_ID: "W1", CMUX_SURFACE_ID: "S1" }, { workspace: "W2", pane: "P2" }],
    [{ CMUX_WORKSPACE_ID: "W1", CMUX_SURFACE_ID: "S1", SEAMUX_BACKEND: "tmux" }, { workspace: "", pane: "" }],
  ];
  for (const [env, want] of IDS) {
    const got = HOST.sessionIds(env), twin = HOST_TWIN.sessionIds(env);
    ok(`host: sessionIds of ${JSON.stringify(env)}`, got.workspace === want.workspace && got.pane === want.pane);
    ok(`host: the deep-plan copy's sessionIds agree on ${JSON.stringify(env)}`, twin.workspace === got.workspace && twin.pane === got.pane);
  }
  ok("host: an ignored SEAMUX_HOST is named in why", /SEAMUX_HOST=bogus ignored/.test(HOST.detectHost({ SEAMUX_HOST: "bogus" }).why));
  ok("host: the twin files match apart from the line naming the other copy",
    fs.readFileSync(path.join(HERE, "lib", "host.mjs"), "utf8").split("\n").slice(3).join("\n") ===
    fs.readFileSync(path.join(HERE, "..", "deep-plan", "lib", "host.mjs"), "utf8").split("\n").slice(3).join("\n"));
  {
    // .seamux/lookout.json in a repo that ignores .seamux: a worktree reads
    // main's copy, not its own stale one (ADR 0068).
    const T = await import("./lib/typesafe.mjs");
    const M = fs.realpathSync(repo("seamux-ignored")), W = path.join(path.dirname(M), "seamux-ignored-wt");
    write(M, ".gitignore", ".seamux/\n");
    sh(M, `${G} add -A && ${G} commit -qm ignore && git worktree add -q -b wt ${JSON.stringify(W)}`);
    write(M, ".seamux/lookout.json", JSON.stringify({ sendContent: true }));
    write(W, ".seamux/lookout.json", JSON.stringify({ sendContent: false }));
    ok("host: repoConfig in an ignoring repo's worktree reads main's lookout.json", T.repoConfig(W).sendContent === true);
    ok("host: the twin resolvers agree on that worktree",
      JSON.stringify(HOST.resolveSeamux(W, ".seamux/lookout.json", { warn: false })) ===
      JSON.stringify(HOST_TWIN.resolveSeamux(W, ".seamux/lookout.json", { warn: false })));
  }
  const r = spawnSync("node", [path.join(HERE, "lookout.mjs"), "engine"],
    { encoding: "utf8", env: { ...ENV, CMUX_WORKSPACE_ID: "W9" } });
  let j = {}; try { j = JSON.parse(r.stdout); } catch {}
  ok("host: engine reports the host beside the pointer", r.status === 0 && j.host === "cmux" && j.why === "CMUX_WORKSPACE_ID is set" && j.root === HERE);
}

// ---------------------------------------------------------------- the opener's pane
// A review records the workspace and pane that opened it, so the seamux Dock
// finds it there when that pane works outside the review's root.
if (want("opener: the review keeps its pane")) {
  const RO = repo("ropener");
  write(RO, "a.txt", "one\n");
  sh(RO, `git add -A && ${G} commit -q -m base`);
  write(RO, "a.txt", "two\n");
  const openAs = env => spawnSync("node", [path.join(HERE, "lookout.mjs"), "open", "--worktree", "--json", "--id", "opener-1"],
    { encoding: "utf8", env: { ...ENV, ...env }, cwd: RO });
  let r = openAs({ SEAMUX_WORKSPACE_ID: "W-open", SEAMUX_PANE_ID: "P-open" });
  ok("opener: an open from a pane records its workspace and pane",
    r.status === 0 && S.read("opener-1").source.workspace === "W-open" && S.read("opener-1").source.pane === "P-open", r.stderr);
  r = openAs({});
  ok("opener: a re-open with no ids keeps the ones the review has",
    r.status === 0 && S.read("opener-1").source.workspace === "W-open" && S.read("opener-1").source.pane === "P-open", r.stderr);
  r = openAs({ SEAMUX_WORKSPACE_ID: "W-next", SEAMUX_PANE_ID: "P-next" });
  ok("opener: a re-open from another pane records that pane",
    r.status === 0 && S.read("opener-1").source.workspace === "W-next" && S.read("opener-1").source.pane === "P-next", r.stderr);
  r = openAs({ CMUX_WORKSPACE_ID: "W-cmux", CMUX_SURFACE_ID: "S-cmux", SEAMUX_BACKEND: "tmux" });
  ok("opener: a tmux pane's inherited cmux ids are not recorded",
    r.status === 0 && S.read("opener-1").source.workspace === "W-next" && S.read("opener-1").source.pane === "P-next", r.stderr);
  r = openAs({ SEAMUX_WORKSPACE_ID: "W-next" });
  ok("opener: a re-open from the same workspace with no pane id keeps the pane",
    r.status === 0 && S.read("opener-1").source.workspace === "W-next" && S.read("opener-1").source.pane === "P-next", r.stderr);
  r = openAs({ SEAMUX_WORKSPACE_ID: "W-other" });
  ok("opener: a re-open from another workspace with no pane id drops the earlier pane",
    r.status === 0 && S.read("opener-1").source.workspace === "W-other" && S.read("opener-1").source.pane === undefined, r.stderr);
}

// ---------------------------------------------------------------- the shipped highlight.js
if (want("the shipped highlight.js")) {
  const shipped = path.join(HERE, "vendor", "highlight.min.js");
  ok("vendor: the plugin ships highlight.js at the pinned sha256",
    fs.existsSync(shipped) && sha(shipped) === VD.HLJS_SHA256);
  const env = { ...ENV, LOOKOUT_VENDOR_DIR: path.join(TMP, "vendor-shipped") };
  delete env.LOOKOUT_HLJS_SRC;
  const r = spawnSync("node", [path.join(HERE, "lookout.mjs"), "setup"], { encoding: "utf8", env });
  ok("vendor: setup installs the shipped copy, with no download",
    /copied the plugin's highlight.js/.test(r.stdout) && sha(path.join(env.LOOKOUT_VENDOR_DIR, "highlight.min.js")) === VD.HLJS_SHA256,
    r.stdout + r.stderr);
}

// ---------------------------------------------------------------- lookout serve
if (want("lookout serve")) {
  const SV = path.join(TMP, "serve");
  fs.mkdirSync(SV, { recursive: true });
  const SENV = { ...ENV, LOOKOUT_SERVE_FILE: path.join(SV, "serve.json"), LOOKOUT_SERVE_IDLE_MS: "8000" };
  const lk = (cwd, ...a) => spawnSync("node", [path.join(HERE, "lookout.mjs"), ...a], { encoding: "utf8", env: SENV, cwd });
  const rec = () => { try { return JSON.parse(fs.readFileSync(SENV.LOOKOUT_SERVE_FILE, "utf8")); } catch { return null; } };
  const RS = repo("rs");
  write(RS, "a.txt", "one\ntwo\n");
  sh(RS, `git add -A && ${G} commit -q -m base && git checkout -q -b dev/s`);
  write(RS, "a.txt", "one\nTWO\nthree\n");
  sh(RS, `git add -A && ${G} commit -q -m change`);
  const o = JSON.parse(lk(RS, "open", "--json", "--no-open").stdout);
  const id = o.id;
  const fj = path.join(SV, "f.json");
  fs.writeFileSync(fj, JSON.stringify([{ file: "a.txt", line: 2, severity: "major", summary: "two is shouted", failure_scenario: "a reader sees TWO" }]));
  lk(RS, "findings", "add", id, fj);
  const fid = S.read(id).findings[0].id;

  let r = lk(RS, "serve", "--url", `/review/${id}`);
  const R = rec();
  ok("serve: --url starts lookout's server and prints the review's URL",
    r.status === 0 && R && r.stdout.trim() === `http://127.0.0.1:${R.port}/review/${id}`, r.stdout + r.stderr);
  ok("serve: serve.json is mode 0600 with port, token, pid, version, started",
    R && (fs.statSync(SENV.LOOKOUT_SERVE_FILE).mode & 0o777) === 0o600 && ["port", "token", "pid", "version", "started"].every(k => R[k]));
  ok("serve: a second --url reuses the server", lk(RS, "serve", "--url", "/health").status === 0 && rec().pid === R.pid);
  const B = `http://127.0.0.1:${R.port}`, T = R.token, O = { Origin: B, "Content-Type": "application/json" };
  const raw = (method, p, headers, body) => new Promise(res => {
    const q = http.request({ host: "127.0.0.1", port: R.port, path: p, method, headers },
      rs => { let b = ""; rs.on("data", c => b += c); rs.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: rs.statusCode, body: b, json: j, headers: rs.headers }); }); });
    q.on("error", e => res({ status: 0, body: e.message, json: null }));
    if (body !== undefined) q.write(body);
    q.end();
  });
  const post = (body, headers = O) => raw("POST", `/review/${id}`, { ...headers, "Content-Length": Buffer.byteLength(JSON.stringify(body)) }, JSON.stringify(body));
  let g = await raw("GET", "/health", { Host: `127.0.0.1:${R.port}` });
  ok("serve: /health names lookout and its pid", g.status === 200 && g.json.server === "lookout" && g.json.pid === R.pid &&
    g.headers.server === "lookout-serve");
  g = await raw("GET", "/health", { Host: `evil.example:${R.port}` });
  ok("serve: a foreign Host is refused", g.status === 403 && g.json.error === "unknown host");
  g = await raw("GET", `/review/${id}`, { Host: `localhost:${R.port}` });
  ok("serve: the page is served with its token and id before the last </body>",
    g.status === 200 && g.body.includes(`window.lookout.serve({ token: "${T}", id: "${id}" })`) &&
    g.body.lastIndexOf("window.lookout.serve(") < g.body.lastIndexOf("</body>"));
  g = await raw("GET", `/review/${id}.json?t=wrong`, {});
  ok("serve: the record needs the token", g.status === 403 && g.json.error === "bad token");
  g = await raw("GET", `/review/${id}.json?t=${T}`, {});
  ok("serve: with it, the record is the stored JSON", g.status === 200 && g.json.id === id);
  g = await raw("GET", `/review/..%2F..%2Fx.json?t=${T}`, {});
  ok("serve: an id cannot leave the reviews directory", g.status === 404);
  // POST guards, in crew's order.
  g = await post({ t: T, op: "comment", item: fid, text: "hi" }, { Origin: "http://evil.example", "Content-Type": "application/json" });
  ok("serve: a POST from another origin is refused", g.status === 403 && g.json.error === "cross-origin request refused");
  g = await post({ t: T, op: "comment", item: fid, text: "hi" }, { Origin: B, "Content-Type": "text/plain" });
  ok("serve: a POST that is not JSON is refused", g.status === 415);
  g = await raw("POST", `/review/${id}`, { ...O, "Content-Length": String(70 * 1024) }, "");
  ok("serve: a POST over 64KB is refused", g.status === 413);
  g = await post({ t: "wrong", op: "comment", item: fid, text: "hi" });
  ok("serve: a POST without the token is refused", g.status === 403 && g.json.error === "bad token", g.status + " " + g.body);
  g = await post({ t: T, op: "launch" });
  ok("serve: an unknown op is refused", g.status === 400 && g.json.error === "unknown op");
  // The ops, each under lookout's lock.
  g = await post({ t: T, op: "comment", item: fid, text: "  is it, though?  " });
  const f0 = () => S.read(id).findings[0];
  ok("serve: comment on a finding adds a human message to its thread",
    g.status === 200 && g.json.ok && g.json.item === fid && f0().thread.some(m => m.by === "human" && m.text === "is it, though?"));
  g = await post({ t: T, op: "comment", file: "a.txt", line: 3, side: "new", text: "new line" });
  const t1 = g.json && g.json.item;
  ok("serve: a comment on a line opens a thread", g.status === 200 && t1 === "t1" &&
    S.read(id).threads.find(t => t.id === "t1" && t.line === 3 && t.status === "open"));
  g = await post({ t: T, op: "comment", file: "nope.txt", line: 1, text: "x" });
  ok("serve: a comment on a file outside the review is refused", g.status === 400 && g.json.error === "file is not in this review");
  g = await post({ t: T, op: "comment", item: fid, text: "   " });
  ok("serve: an empty comment is refused", g.status === 400);
  g = await post({ t: T, op: "resolve", item: fid, text: "fixed" });
  ok("serve: resolve closes a finding as the human, with a status message",
    g.status === 200 && f0().status === "resolved" && f0().statusBy === "human" &&
    f0().thread.slice(-1)[0].kind === "status" && f0().thread.slice(-1)[0].to === "resolved");
  g = await post({ t: T, op: "reopen", item: fid });
  ok("serve: reopen opens it again", g.status === 200 && f0().status === "open");
  g = await post({ t: T, op: "dismiss", item: "t1" });
  ok("serve: dismissing a thread resolves it", g.status === 200 && S.read(id).threads[0].status === "resolved");
  g = await post({ t: T, op: "answer", item: "n1", pick: 0 });
  ok("serve: answer on a review without a quiz is refused", g.status === 400 && g.json.error === "this review has no quiz");
  g = await post({ t: T, op: "resolve", item: "f999" });
  ok("serve: an op on a missing item is refused", g.status === 404);
  // A writer holding the lock: the op waits, and is refused when it outlasts the deadline.
  // Each op that wrote started a background `lookout sync`, which takes the
  // same lock; on a busy machine one may still hold it, so wait our turn.
  const lockDir = path.join(ENV.LOOKOUT_REVIEWS_DIR, id + ".lock");
  for (const until = Date.now() + 15000; ;) {
    try { fs.mkdirSync(lockDir); break; }
    catch (e) { if (e.code !== "EEXIST" || Date.now() > until) throw e; await new Promise(res => setTimeout(res, 25)); }
  }
  g = await post({ t: T, op: "comment", item: fid, text: "while locked" });
  ok("serve: a held lock refuses the op rather than writing past it", g.status === 409 && /locked/.test(g.json.error));
  fs.rmdirSync(lockDir);
  g = await raw("POST", "/elsewhere", { ...O, "Content-Length": "2" }, "{}");
  ok("serve: a POST anywhere but /review/ is refused", g.status === 404, g.status + " " + g.body);
  // Stale record, then idle exit.
  lk(RS, "serve", "--stop");
  fs.writeFileSync(SENV.LOOKOUT_SERVE_FILE, JSON.stringify({ port: R.port, token: "x", pid: 999999 }));
  r = lk(RS, "serve", "--url", "/health");
  ok("serve: a stale serve.json (dead pid) starts a fresh server", r.status === 0 && rec().pid !== 999999 && rec().token !== "x");
  const idlePid = rec().pid, idlePort = rec().port;
  let gone = false;
  // A hidden tab's poll (bg=1) keeps coming the whole time: it is not activity.
  for (let i = 0; i < 80 && !gone; i++) {
    await new Promise(res => setTimeout(res, 500));
    if (i % 2 === 0) await fetch(`http://127.0.0.1:${idlePort}/review/x.json?t=x&bg=1`).catch(() => {});
    gone = !rec() && !(() => { try { process.kill(idlePid, 0); return true; } catch { return false; } })();
  }
  ok("serve: an idle server exits and removes serve.json, background polls or not", gone);
  lk(RS, "serve", "--stop");
}

// ---------------------------------------------------------------- remote host: reviews in the repo
if (want("remote host: reviews in the repo")) {
  const R8 = repo("r8");
  write(R8, "a.js", "1\n"); sh(R8, `git add -A && ${G} commit -q -m base`);
  write(R8, "a.js", "2\n");
  const RH = path.join(TMP, "remote-home");
  fs.mkdirSync(RH, { recursive: true });
  const REnv = { ...ENV, HOME: RH, SEAMUX_HOST: "remote", CLAUDE_PROJECT_DIR: R8 };
  delete REnv.LOOKOUT_REVIEWS_DIR;
  const o = spawnSync("node", [path.join(HERE, "lookout.mjs"), "open", "--worktree", "--json"], { encoding: "utf8", env: REnv, cwd: R8 });
  const rid = JSON.parse(o.stdout || "{}").id;
  const RD = path.join(R8, ".seamux", "state", "plans", "reviews");
  ok("remote: a review's store defaults into the repo's .seamux/state",
    o.status === 0 && fs.existsSync(path.join(RD, rid + ".json")) && !fs.existsSync(path.join(RH, ".claude", "plans", "reviews")), o.stderr);
  ok("remote: open says there is no live page on this host", JSON.parse(o.stdout).shown === "no live page on this host (host: remote)");
  ok("remote: and keeps it out of git through info/exclude", /^\/\.seamux\/state\/$/m.test(fs.readFileSync(path.join(R8, ".git", "info", "exclude"), "utf8")));
  // A comment from the human, written the way the page's server writes it.
  spawnSync("node", ["--input-type=module", "-e", `
    const S = await import(${JSON.stringify(path.join(HERE, "lib", "store.mjs"))});
    const FD = await import(${JSON.stringify(path.join(HERE, "lib", "findings.mjs"))});
    S.update(${JSON.stringify(rid)}, cur => { FD.comment(cur, { file: "a.js", line: 1, text: "from the remote page" }, "human"); return cur; });`],
    { encoding: "utf8", env: REnv, cwd: R8 });
  const h = spawnSync("bash", [path.join(HERE, "hooks", "comments.sh")],
    { encoding: "utf8", env: REnv, cwd: R8, input: JSON.stringify({ cwd: R8, hook_event_name: "UserPromptSubmit" }) });
  ok("remote: the comments hook reads reviews from the repo and passes the human's comment on",
    /from the remote page/.test(h.stdout), h.stdout + h.stderr);
}

// ---------------------------------------------------------------- Artifact export and pull
if (want("Artifact export and pull")) {
  const R9 = repo("r9");
  write(R9, "a.js", "1\n"); sh(R9, `git add -A && ${G} commit -q -m base`);
  write(R9, "a.js", "2\n3\n");
  const id = JSON.parse(cli(R9, "open", "--worktree", "--json").stdout).id;
  const fj = path.join(TMP, "r9-f.json");
  fs.writeFileSync(fj, JSON.stringify([{ file: "a.js", line: 1, severity: "major", summary: "two", failure_scenario: "x" }]));
  cli(R9, "findings", "add", id, fj);
  let r = cli(R9, "export-artifact", id, "--json");
  const meta = JSON.parse(r.stdout || "{}");
  const page = meta.path ? fs.readFileSync(meta.path, "utf8") : "";
  ok("export-artifact writes the review page with a db layer, and says what to publish with",
    r.status === 0 && /\.artifact\.html$/.test(meta.path) && meta.capabilities.db.rules[0].path === "annotations" &&
    page.includes('claude.use("db")') && page.includes("function applyOp(") && !/^export /m.test(page.slice(page.lastIndexOf("<script>"))), r.stderr);
  // Run the page's db layer against a stand-in for the page and its db.
  const boot = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));
  const review = S.read(id);
  let served = null, shown = null;
  const writes = [];
  let snap = null;
  const db = {
    doc: p => ({ set: async row => { writes.push({ p, row }); } }),
    collection: () => ({ orderBy: () => ({ onSnapshot: fn => { snap = fn; } }) }),
  };
  const ctx = { window: { lookout: { review: JSON.parse(JSON.stringify(review)),
      serve: o => { served = o; return { take: rv => { shown = rv; } }; }, applyReview: rv => { shown = rv; } } },
    claude: { use: async n => n === "db" ? db : null }, document: { body: { insertBefore() {}, firstChild: null }, createElement: () => ({ style: {} }) },
    JSON, Date, Math, Number, String, Array, Object, Error, Promise };
  (await import("node:vm")).runInNewContext(boot, ctx);
  await new Promise(res => setTimeout(res, 20));
  ok("page: it serves through the db, not a server, and does not poll", served && served.poll === false && typeof served.post === "function");
  const posted = await served.post({ op: "comment", file: "a.js", line: 2, side: "new", text: "why three?", t: "ignored" });
  ok("page: a comment is one annotations row, written as the human, with no token in it",
    writes.length === 1 && /^annotations\/r/.test(writes[0].p) && writes[0].row.op === "comment" && writes[0].row.by === "human" &&
    writes[0].row.line === 2 && !("t" in writes[0].row) && posted.review.threads.length === 1, JSON.stringify(writes));
  await served.post({ op: "comment", item: "t1", text: "my own thread" });
  ok("page: a reply to a thread made on this page names it by the row that made it, not its t-number",
    writes.length === 2 && writes[1].row.item === "row:" + writes[0].p.split("/").pop(), JSON.stringify(writes[1]));
  writes.pop();
  let refused = "";
  try { await served.post({ op: "resolve", item: "f99" }); } catch (e) { refused = e.message; }
  ok("page: an op the rules refuse is said on the page and never stored", refused === "no finding or thread f99" && writes.length === 1);
  snap({ docs: [{ id: "x1", data: () => writes[0].row }, { id: "x2", data: () => ({ op: "resolve", item: "f1", text: "fine", by: "human", at: "2099-01-01T00:00:00.000Z" }) },
    { id: "x3", data: () => ({ op: "comment", file: "a.js", line: 1, text: "not the human's", by: "agent", at: "2099-01-02T00:00:00.000Z" }) }] });
  ok("page: every human row from the db is applied, in order, to what it shows, and no other",
    shown && shown.threads.length === 1 && shown.findings[0].status === "resolved" && shown.findings[0].statusBy === "human");
  // Pull: the rows as the agent saved them from ArtifactData.
  const rowsFile = path.join(TMP, "r9-rows.json");
  fs.writeFileSync(rowsFile, JSON.stringify({ docs: [
    { id: "annotations/rb", data: { op: "resolve", item: "f1", text: "fixed now", by: "human", at: "2026-01-01T00:00:02.000Z" } },
    { id: "annotations/ra", data: { ...writes[0].row, at: "2026-01-01T00:00:01.000Z" } },
    { id: "annotations/rc", data: { op: "dismiss", item: "f1", by: "agent", at: "2026-01-01T00:00:03.000Z" } },
    { id: "annotations/rd", data: { op: "launch", by: "human", at: "2026-01-01T00:00:04.000Z" } },
  ] }));
  r = cli(R9, "pull", id, rowsFile, "--json");
  const res = JSON.parse(r.stdout || "{}");
  const after = S.read(id);
  ok("pull: replays the human's rows in time order through the same ops",
    r.status === 0 && res.applied.map(a => a.rid).join() === "ra,rb" && after.threads[0].messages[0].text === "why three?" &&
    after.findings[0].status === "resolved" && after.findings[0].statusBy === "human" &&
    after.threads[0].messages[0].via === "artifact", r.stdout + r.stderr);
  ok("pull: a row not written by the page's human, and an op the rules refuse, are skipped and named",
    res.skipped.length === 2 && /written by "agent"/.test(res.skipped.find(k => k.rid === "rc").why) &&
    res.skipped.find(k => k.rid === "rd").why === "unknown op" && after.findings[0].status === "resolved");
  r = cli(R9, "pull", id, rowsFile, "--json");
  ok("pull: a second pull applies nothing again", JSON.parse(r.stdout).applied.length === 0 && S.read(id).threads.length === 1);
  // A reply that sorts before the thread it names (a slow clock), naming the
  // thread by its row; and bare rows with no ids.
  const later = path.join(TMP, "r9-rows2.json");
  const bare = { op: "comment", file: "a.js", line: 1, text: "a second thread", by: "human", at: "2026-01-02T00:00:05.000Z" };
  fs.writeFileSync(later, JSON.stringify([
    { id: "re", data: { op: "comment", item: "row:rf", text: "reply from a slow clock", by: "human", at: "2026-01-02T00:00:00.000Z" } },
    { id: "rf", data: { op: "comment", file: "a.js", line: 2, side: "new", text: "new thread", by: "human", at: "2026-01-02T00:00:09.000Z" } },
    bare]));
  r = cli(R9, "pull", id, later, "--json");
  const v = S.read(id), nt = v.threads.find(t => t.messages[0].text === "new thread");
  ok("pull: a reply that sorts before its thread is tried again after it, and lands on that thread",
    r.status === 0 && nt && nt.messages.some(m => m.text === "reply from a slow clock"), r.stdout);
  fs.writeFileSync(later, JSON.stringify([{ op: "comment", file: "a.js", line: 1, text: "first", by: "human", at: "2026-01-03T00:00:00.000Z" }, bare]));
  r = cli(R9, "pull", id, later, "--json");
  const od = path.join(TMP, "r9-outdir", "annotations");
  fs.mkdirSync(od, { recursive: true });
  fs.writeFileSync(path.join(od, "rz.json"), JSON.stringify({ op: "comment", item: "f1", text: "from a folder", by: "human", at: "2026-01-04T00:00:00.000Z" }));
  r = cli(R9, "pull", id, path.join(TMP, "r9-outdir"), "--json");
  ok("pull: reads an ArtifactData out_dir folder, one row per file named by its doc id",
    JSON.parse(r.stdout || "{}").applied?.[0]?.rid === "rz" && S.read(id).findings[0].thread.some(m => m.text === "from a folder"), r.stdout + r.stderr);
  ok("pull: a row saved without an id keeps one id however the list is ordered", JSON.parse(r.stdout).applied.length === 1 &&
    S.read(id).threads.filter(t => t.messages[0].text === "a second thread").length === 1, r.stdout);
}

// ---------------------------------------------------------------- install-repo
if (want("install-repo")) {
  const IR = repo("install");
  const ir = (...a) => spawnSync("node", [path.join(HERE, "lookout.mjs"), "install-repo", ...a], { encoding: "utf8", env: ENV, cwd: IR });
  let r = ir();
  const D = path.join(IR, ".claude", "skills", "lookout");
  const set = JSON.parse(fs.readFileSync(path.join(IR, ".claude", "settings.json"), "utf8"));
  ok("install-repo copies lookout into .claude/skills/lookout, highlight.js included, without the probe or evals",
    r.status === 0 && ["SKILL.md", "lookout.mjs", "hooks/comments.sh", "vendor/highlight.min.js", "bin/lookout", "page/review.js"]
      .every(f => fs.existsSync(path.join(D, f))) && !fs.existsSync(path.join(D, "probe.mjs")) && !fs.existsSync(path.join(D, "evals")), r.stderr);
  ok("install-repo merges the comments hooks behind the remote guard",
    set.hooks.UserPromptSubmit[0].hooks[0].command.startsWith('[ "$CLAUDE_CODE_REMOTE" = true ]') &&
    /\.claude\/skills\/lookout\/hooks\/comments\.sh/.test(set.hooks.UserPromptSubmit[0].hooks[0].command));
  ir();
  ok("install-repo again leaves one set of its hooks", JSON.stringify(JSON.parse(fs.readFileSync(path.join(IR, ".claude", "settings.json"), "utf8"))) === JSON.stringify(set));
  ok("install-repo --check: a fresh copy matches", ir("--check").status === 0);
  fs.rmSync(path.join(D, "page", "review.css"));
  r = ir("--check");
  ok("install-repo --check names what is missing", r.status === 1 && /missing: page\/review\.css/.test(r.stdout), r.stdout);
  ok("the twin install.mjs files match apart from the line naming the other",
    fs.readFileSync(path.join(HERE, "lib", "install.mjs"), "utf8").split("\n").filter((l, i) => i !== 18).join("\n") ===
    fs.readFileSync(path.join(HERE, "..", "deep-plan", "lib", "install.mjs"), "utf8").split("\n").filter((l, i) => i !== 18).join("\n"));
}

// ------------------------------------------------- the page on crew's server
// crew's intent server passes /review/ to lookout serve, which checks its own
// token, never crew's. So whether crew serves a review is asked of the page,
// which needs no token: a fake crew that refuses every .json (as lookout serve
// refuses crew's token) must still count as serving the review.
if (want("the page on crew's server")) {
  const SVM = await import("./lib/serve.mjs");
  const dir = path.join(TMP, "crew-intent");
  fs.mkdirSync(dir, { recursive: true });
  const src = `const http = require("http");
const s = http.createServer((q, r) => {
  if (q.url === "/review/demo") { r.writeHead(200, {"Content-Type": "text/html"}); return r.end("<p>demo</p>"); }
  if (q.url.startsWith("/review/demo.json")) { r.writeHead(403); return r.end('{"error":"bad token"}'); }
  r.writeHead(404); r.end('{"error":"no such review"}');
});
s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
  const fake = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise(res => fake.stdout.once("data", d => res(parseInt(String(d), 10))));
  fs.writeFileSync(path.join(dir, "board-intent.port"), String(port));
  fs.writeFileSync(path.join(dir, "board-intent.token"), "crews-own-token");
  ok("crew serving: a review crew serves is served, though its .json refuses crew's token",
    SVM.crewReviewUrl("demo", dir) === `http://127.0.0.1:${port}/review/demo`);
  ok("crew serving: a review crew does not have is not", SVM.crewReviewUrl("missing", dir) === "");
  ok("crew serving: no port file, no URL", SVM.crewReviewUrl("demo", path.join(TMP, "no-crew")) === "");
  fake.kill();
}

// ---------------------------------------------------------------- the plan's map
// lookout open --plan-map keeps a deep-plan End state map in the review; the
// page's Map view holds it against the diff (lib/planmap.mjs) and draws it
// with page/plan-map.js, a copy of shared/plan-map.js.
if (want("plan map: --plan-map, the three-way compare, the Map view")) {
  const RM = repo("rmap");
  write(RM, "src/a.mjs", "export const a = 1;\n");
  write(RM, "src/b.mjs", "export const b = 1;\n");
  write(RM, "src/old.mjs", "export const old = 1;\n");
  sh(RM, `git add -A && ${G} commit -q -m base`);
  const base = sh(RM, "git rev-parse HEAD").trim();
  write(RM, "src/a.mjs", "export const a = 2;\n");          // planned for 1, touched
  write(RM, "src/stray.mjs", "export const s = 1;\n");      // touched, planned nowhere
  write(RM, "src/later.mjs", "export const l = 1;\n");      // touched, planned for 2
  sh(RM, "git rm -q src/old.mjs");                           // a planned removal, touched
  const card = (p, incs, change) => ({ id: p, path: p, increments: incs, change, facts: [], contracts: [],
    usedBy: { paths: [], more: 0 }, uses: { paths: [], more: 0 }, links: [] });
  const map = { version: 1, slug: "map-demo", base, neighbours: true, why: "", unplaced: [],
    cards: [card("src/a.mjs", [1], "modify"), card("src/b.mjs", [1], "modify"), card("src/old.mjs", [1], "remove"),
            card("src/later.mjs", [2], "new")] };
  const mf = path.join(TMP, "map-demo.map.json");
  fs.writeFileSync(mf, JSON.stringify(map));
  let r = cli(RM, "open", "--plan", "map-demo", "--inc", "1", "--base", base, "--plan-map", mf, "--json");
  ok("--plan-map: open takes it", r.status === 0, r.stderr);
  const id = JSON.parse(r.stdout).id;
  ok("--plan-map: kept in the review as planMap", JSON.stringify(S.read(id).planMap) === JSON.stringify(map));
  r = cli(RM, "open", "--plan", "map-demo", "--inc", "1", "--base", base, "--json");
  ok("--plan-map: a re-open without it keeps the review's map", r.status === 0 && JSON.stringify(S.read(id).planMap) === JSON.stringify(map));
  fs.writeFileSync(path.join(TMP, "not-a-map.json"), '{"files": []}');
  ok("--plan-map: a file with no cards list is refused",
    cli(RM, "open", "--id", "map-bad", "--base", base, "--plan-map", path.join(TMP, "not-a-map.json"), "--json").status !== 0);
  ok("--plan-map: an unreadable file is refused",
    cli(RM, "open", "--id", "map-bad2", "--base", base, "--plan-map", path.join(TMP, "no-such.json"), "--json").status !== 0);

  const PM = await import("./lib/planmap.mjs");
  const v = PM.comparePlan(map, S.read(id).files, 1);
  const st = p => (v.cards.find(c => c.path === p) || v.extra.find(c => c.path === p) || {}).status;
  ok("compare: a planned file the diff touched is ok", st("src/a.mjs") === "ok" && st("src/old.mjs") === "ok");
  ok("compare: a planned file the diff did not touch is miss", st("src/b.mjs") === "miss");
  ok("compare: a touched file no card in scope names is extra", st("src/stray.mjs") === "extra" && st("src/later.mjs") === "extra");
  ok("compare: an extra planned for another increment says which",
    JSON.stringify(v.extra.find(c => c.path === "src/later.mjs").plannedIn) === "[2]" &&
    JSON.stringify(v.extra.find(c => c.path === "src/stray.mjs").plannedIn) === "[]");
  ok("compare: an increment's scope leaves out the other increments' cards", !v.cards.some(c => c.path === "src/later.mjs"));
  ok("compare: counts", JSON.stringify(v.counts) === JSON.stringify({ ok: 2, miss: 1, extra: 2 }), JSON.stringify(v.counts));
  const all = PM.comparePlan(map, S.read(id).files, "all");
  ok("compare: the full delivery scopes every card", all.inc === "all" && all.cards.length === 4 &&
    all.cards.find(c => c.path === "src/later.mjs").status === "ok" && all.extra.length === 1 && all.extra[0].path === "src/stray.mjs");
  ok("compare: no map, no comparison", PM.comparePlan(undefined, [], 1) === null);
  const edited = PM.comparePlan({ cards: [card("src/gone.mjs", [1], "remove")] }, [{ path: "src/gone.mjs", status: "M" }], 1);
  ok("compare: a planned removal the diff only edited is not done", edited.cards[0].status === "miss" && edited.cards[0].undone && edited.extra.length === 0);
  const mono = PM.comparePlan({ prefix: "packages/app/", cards: [card("src/a.ts", [1], "modify"), card("src/b.ts", [1], "modify")] },
    [{ path: "packages/app/src/a.ts", status: "M" }, { path: "packages/app/src/c.ts", status: "A" }, { path: "tools/x.sh", status: "M" }], 1);
  ok("compare: a plan rooted in a monorepo folder matches the diff's repo-top paths",
    mono.cards.find(c => c.path === "src/a.ts").status === "ok" && mono.cards.find(c => c.path === "src/b.ts").status === "miss" &&
    mono.extra.map(x => x.path).join() === "src/c.ts,tools/x.sh" && mono.extra[0].diffPath === "packages/app/src/c.ts");
  const renamed = PM.comparePlan({ cards: [card("src/was.mjs", [1], "modify")] }, [{ path: "src/now.mjs", oldPath: "src/was.mjs", status: "R" }], 1);
  ok("compare: a planned file the diff renamed counts as touched, and is no extra", renamed.cards[0].status === "ok" && renamed.extra.length === 0);
  r = cli(RM, "open", "--plan", "map-demo", "--inc", "1", "--base", base, "--no-plan-map", "--json");
  ok("--no-plan-map: a plan that has no map any more drops the review's old one", r.status === 0 && S.read(id).planMap === undefined, r.stderr);
  cli(RM, "open", "--plan", "map-demo", "--inc", "1", "--base", base, "--plan-map", mf, "--json");

  // The page: the renderer inlined in its own script, the comparison in its data.
  const page = fs.readFileSync(S.paths(id).html, "utf8");
  ok("page: the renderer ships inlined, a copy of shared/plan-map.js",
    page.includes(fs.readFileSync(path.join(HERE, "..", "shared", "plan-map.js"), "utf8").replace(/<\/script/gi, "<\\/script")) &&
    fs.readFileSync(path.join(HERE, "page", "plan-map.js"), "utf8") === fs.readFileSync(path.join(HERE, "..", "shared", "plan-map.js"), "utf8"));
  const data = JSON.parse(page.match(/<script type="application\/json" id="lookout-data">([\s\S]*?)<\/script>/)[1]);
  ok("page: its data carries the comparison", data.planView && data.planView.counts.extra === 2);
  ok("page: a Map button and the m key", /id="map-btn"/.test(page) && /<kbd>m<\/kbd>/.test(page) && /e\.key === "m"/.test(page));
  ok("page: the Map view hands the review's findings to the map and jumps to a finding's line",
    /findings: c => findingsOn\(c\)/.test(page) && /onFinding: \(c, f\) =>/.test(page) && /goToLine\(x\.file/.test(page) &&
    // a renamed planned file's findings sit under its new path; the map keeps the reader's place
    /renamedTo\(/.test(page) && /keep: mapKeep/.test(page));
  r = cli(RM, "open", "--id", "no-map", "--base", base, "--json");
  const bare = JSON.parse(fs.readFileSync(S.paths("no-map").html, "utf8").match(/<script type="application\/json" id="lookout-data">([\s\S]*?)<\/script>/)[1]);
  ok("page: a review with no map has no comparison, and the view says so", bare.planView === null && !S.read("no-map").planMap &&
    /No plan map was passed to this review/.test(fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8")));
}

// ---------------------------------------------------------------- turn snapshots
if (want("turn snapshots")) {
  const T = await import("./lib/turns.mjs");
  const RT = repo("rt");
  write(RT, "a.js", "1\n"); write(RT, ".gitignore", "build/\n");
  sh(RT, `git add -A && ${G} commit -q -m base`);
  write(RT, "a.js", "2\n"); write(RT, "staged.js", "s\n"); sh(RT, "git add staged.js");
  write(RT, "new.js", "untracked\n"); write(RT, "build/out.txt", "ignored\n");
  const hook = (verb, payload, env = ENV) => spawnSync("bash", [path.join(HERE, "hooks", "turns.sh"), verb],
    { encoding: "utf8", env, input: typeof payload === "string" ? payload : JSON.stringify(payload) });
  const refOf = (sid, n, side) => (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/seamux/turns/${sid}/${n}/${side}`],
    { cwd: RT, encoding: "utf8" }).stdout || "").trim();
  const state = () => [sh(RT, "git status --porcelain"), sh(RT, "git diff --cached --name-only"),
    sh(RT, "git stash list"), sh(RT, "git rev-parse HEAD"), sh(RT, "git branch --list")].join("|");
  const before = state();

  const s1 = hook("start", { cwd: RT, session_id: "s-1", prompt: "fix the\n  bug " + "x".repeat(200), hook_event_name: "UserPromptSubmit" });
  ok("turns: start prints nothing and exits 0", s1.status === 0 && s1.stdout === "" && s1.stderr === "", s1.stdout + s1.stderr);
  const st1 = refOf("s-1", 1, "start");
  ok("turns: a prompt points refs/seamux/turns/<session>/1/start at a snapshot", /^[0-9a-f]{40}$/.test(st1), st1);
  ok("turns: the snapshot is a parentless commit", st1 && sh(RT, `git rev-list --parents -n1 ${st1}`).trim() === st1);
  const tree1 = st1 ? sh(RT, `git ls-tree -r --name-only ${st1}`).split("\n") : [];
  ok("turns: it holds the working tree, untracked included and ignored files left out",
     tree1.includes("new.js") && tree1.includes("staged.js") && !tree1.includes("build/out.txt") &&
     sh(RT, `git show ${st1}:a.js`) === "2\n", tree1.join(","));
  ok("turns: status, the staged set, the stash, HEAD and the branches are unchanged", state() === before);

  write(RT, "b.js", "b\n");
  const e1 = hook("end", { cwd: RT, session_id: "s-1", hook_event_name: "Stop" });
  const en1 = refOf("s-1", 1, "end");
  ok("turns: a stop prints nothing and points 1/end at a snapshot", e1.status === 0 && e1.stdout === "" && /^[0-9a-f]{40}$/.test(en1));
  ok("turns: the turn's diff is what changed during it", sh(RT, `git diff --name-only ${st1} ${en1}`).trim() === "b.js");
  let log = T.readLog("s-1");
  ok("turns: the stop logs the turn with the prompt's first 120 characters and the changed-file count",
     log.length === 1 && log[0].n === 1 && log[0].session === "s-1" && log[0].start === st1 && log[0].end === en1 &&
     log[0].files === 1 && log[0].prompt === ("fix the bug " + "x".repeat(200)).slice(0, 120) &&
     fs.realpathSync(log[0].root) === fs.realpathSync(RT) && !Number.isNaN(Date.parse(log[0].at)), JSON.stringify(log));
  ok("turns: the log sits beside lookout's reviews", fs.existsSync(path.join(TMP, "turns", "s-1.jsonl")));
  ok("turns: the stop leaves the staged set, the stash, HEAD and the branches as they were",
     state().split("|").slice(1).join("|") === before.split("|").slice(1).join("|"));

  write(RT, "c.js", "c\n");
  hook("end", { cwd: RT, session_id: "s-1", hook_event_name: "Stop" });
  log = T.readLog("s-1");
  ok("turns: a second stop in the same turn moves the end and replaces its line",
     log.length === 1 && log[0].files === 2 && refOf("s-1", 1, "end") !== en1, JSON.stringify(log));

  hook("start", { cwd: RT, session_id: "s-1", prompt: "next" });
  ok("turns: the next prompt is turn 2", /^[0-9a-f]{40}$/.test(refOf("s-1", 2, "start")));
  hook("end", { cwd: RT, session_id: "s-1" });
  log = T.readLog("s-1");
  ok("turns: a turn that changed nothing is logged with files 0", log.length === 2 && log[1].n === 2 && log[1].files === 0, JSON.stringify(log));

  // A start past the budget records nothing, and the stop after it must not
  // move the last turn's end.
  const end2 = refOf("s-1", 2, "end");
  write(RT, "d.js", "d\n");
  hook("start", { cwd: RT, session_id: "s-1", prompt: "slow" }, { ...ENV, LOOKOUT_TURN_BUDGET_MS: "1" });
  hook("end", { cwd: RT, session_id: "s-1" });
  ok("turns: past the budget nothing is recorded, and the stop after it leaves the last turn alone",
     !refOf("s-1", 3, "start") && refOf("s-1", 2, "end") === end2 && T.readLog("s-1").length === 2);

  ok("turns: a stop with no turn open records nothing",
     (hook("end", { cwd: RT, session_id: "s-other" }), !refOf("s-other", 1, "end") && !T.readLog("s-other").length));
  const outside = path.join(TMP, "not-a-repo"); fs.mkdirSync(outside, { recursive: true });
  const o = hook("start", { cwd: outside, session_id: "s-out", prompt: "p" });
  ok("turns: outside a repo it records nothing and stays silent", o.status === 0 && o.stdout === "" &&
     !fs.existsSync(path.join(TMP, "turns", "s-out.open.json")));
  const rem = hook("start", { cwd: RT, session_id: "s-rem", prompt: "p" }, { ...ENV, CLAUDE_CODE_REMOTE: "true" });
  ok("turns: a cloud session takes no snapshot", rem.status === 0 && rem.stdout === "" && !refOf("s-rem", 1, "start"));
  const bad = hook("start", "{not json");
  ok("turns: garbage on stdin never fails the prompt", bad.status === 0 && bad.stdout === "");
  ok("turns: no session id, no snapshot", (hook("start", { cwd: RT, prompt: "p" }, { ...ENV, CLAUDE_CODE_SESSION_ID: "" }),
     !sh(RT, "git for-each-ref refs/seamux/turns/").split("\n").some(l => !/\/s-1\//.test(l) && l.trim())));

  // Prune: the last 50 turns per session stay; an idle session goes, refs and log.
  const any = refOf("s-1", 1, "start");
  const many = Array.from({ length: 53 }, (_, i) => `update refs/seamux/turns/s-many/${i + 1}/start ${any}\n`).join("");
  spawnSync("git", ["update-ref", "--stdin"], { cwd: RT, input: many });
  const old = spawnSync("git", ["commit-tree", `${any}^{tree}`, "-m", "old"], { cwd: RT, encoding: "utf8",
    env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
           GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@p", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@p" } }).stdout.trim();
  spawnSync("git", ["update-ref", "--stdin"], { cwd: RT,
    input: `update refs/seamux/turns/s-idle/1/start ${old}\nupdate refs/seamux/turns/s-idle/1/end ${old}\nupdate refs/seamux/turns/s-me/1/start ${old}\n` });
  write(path.join(TMP, "turns"), "s-idle.jsonl", "{}\n");
  fs.utimesSync(path.join(TMP, "turns", "s-idle.jsonl"), new Date("2020-01-01"), new Date("2020-01-01"));
  const p = hook("prune", { cwd: RT, session_id: "s-me", hook_event_name: "SessionStart" });
  const left = sh(RT, "git for-each-ref --format='%(refname)' refs/seamux/turns/").split("\n").filter(Boolean);
  const manyLeft = left.filter(r => r.includes("/s-many/")).map(r => Number(r.split("/")[4])).sort((a, b) => a - b);
  ok("turns: prune keeps each session's last 50 turns", p.stdout === "" && manyLeft.length === 50 && manyLeft[0] === 4, manyLeft.join(","));
  ok("turns: prune drops a session idle for 7 days, refs and log",
     !left.some(r => r.includes("/s-idle/")) && !fs.existsSync(path.join(TMP, "turns", "s-idle.jsonl")));
  ok("turns: prune never sweeps the session starting now", left.includes("refs/seamux/turns/s-me/1/start"));
  ok("turns: prune leaves a live session's turns alone", left.filter(r => r.includes("/s-1/")).length === 4);

  const ls = cli(RT, "turns", "--session", "s-1", "--json");
  let lj = null; try { lj = JSON.parse(ls.stdout); } catch { /* checked below */ }
  ok("turns: lookout turns lists a session's turns with their prompts", lj && lj.length === 2 && lj[0].n === 1 &&
     lj[0].files === 2 && lj[0].prompt.startsWith("fix the bug") && lj[0].end, ls.stdout + ls.stderr);

  const hj = JSON.parse(fs.readFileSync(path.join(HERE, "hooks", "hooks.json"), "utf8")).hooks;
  const cmds = ev => (hj[ev] || []).flatMap(g => g.hooks.map(h => h.command));
  ok("turns: hooks.json runs turns.sh start, end and prune on prompt, stop and session start",
     cmds("UserPromptSubmit").some(c => /hooks\/turns\.sh" start$/.test(c)) && cmds("Stop").some(c => /hooks\/turns\.sh" end$/.test(c)) &&
     cmds("SessionStart").some(c => /hooks\/turns\.sh" prune$/.test(c)) && /comments\.sh/.test(cmds("UserPromptSubmit")[0]));

  // A prompt sent while the agent still works: the open turn ends at the new
  // turn's start, so it keeps a diff and a log line.
  hook("start", { cwd: RT, session_id: "s-q", prompt: "first" });
  write(RT, "q.js", "q\n");
  hook("start", { cwd: RT, session_id: "s-q", prompt: "queued" });
  const ql = T.readLog("s-q");
  ok("turns: a prompt sent before the stop ends the open turn at the new start",
     ql.length === 1 && ql[0].n === 1 && ql[0].files === 1 && refOf("s-q", 1, "end") === refOf("s-q", 2, "start"), JSON.stringify(ql));
  hook("end", { cwd: RT, session_id: "s-q" });
  ok("turns: the stop after it ends the new turn", T.readLog("s-q").map(e => e.n).join(",") === "1,2");
  const KT = path.join(TMP, "kill-tmp"); fs.mkdirSync(KT, { recursive: true });
  const idx = () => fs.readdirSync(KT).filter(f => f.startsWith("lookout-index-"));
  for (const ms of ["40", "80", "120"]) hook("start", { cwd: RT, session_id: "s-kill", prompt: "p" }, { ...ENV, TMPDIR: KT, LOOKOUT_TURN_BUDGET_MS: ms });
  spawnSync("sleep", ["0.5"]);   // a git left running would write its scratch index back by now
  ok("turns: a start killed at the budget leaves no scratch index behind, now or later", !idx().length, idx().join(","));

  // A session that moved to another worktree of the repo ends its turn where
  // the turn began: the refs are shared, the working trees are not.
  const WT2 = path.join(TMP, "rt-other");
  sh(RT, `git worktree add -q ${WT2} -b other`);
  write(WT2, "elsewhere.js", "only in the other worktree\n");
  hook("start", { cwd: RT, session_id: "s-move", prompt: "p" });
  write(RT, "moved.js", "m\n");
  hook("end", { cwd: WT2, session_id: "s-move" });
  const mv = T.readLog("s-move");
  ok("turns: a turn ends in the worktree it began in, wherever the session's cwd is now",
     mv.length === 1 && fs.realpathSync(mv[0].root) === fs.realpathSync(RT) &&
     sh(RT, `git diff --name-only ${mv[0].start} ${mv[0].end}`).trim() === "moved.js", JSON.stringify(mv));
  hook("start", { cwd: RT, session_id: "s-move2", prompt: "p" });
  write(RT, "moved2.js", "m\n");
  hook("start", { cwd: WT2, session_id: "s-move2", prompt: "q" });
  const mv2 = T.readLog("s-move2");
  ok("turns: a prompt from another worktree ends the open turn with a snapshot of its own worktree",
     mv2.length === 1 && sh(RT, `git diff --name-only ${mv2[0].start} ${mv2[0].end}`).trim() === "moved2.js", JSON.stringify(mv2));

  // Turn numbers are per repo: the same session's turn 1 in another repo is
  // another line, not a replacement.
  const RT2 = repo("rt-second");
  write(RT2, "x.js", "x\n");
  hook("start", { cwd: RT2, session_id: "s-move", prompt: "in the second repo" });
  write(RT2, "y.js", "y\n");
  hook("end", { cwd: RT2, session_id: "s-move" });
  ok("turns: the same turn number in another repo adds a line rather than replacing one",
     T.readLog("s-move").map(e => e.n + ":" + path.basename(e.root)).join(",") === "1:rt,1:rt-second",
     JSON.stringify(T.readLog("s-move")));

  // The cap holds mid-session: a stop trims the session to its last 50 turns.
  const seed = refOf("s-1", 1, "start");
  spawnSync("git", ["update-ref", "--stdin"], { cwd: RT,
    input: Array.from({ length: 55 }, (_, i) => `update refs/seamux/turns/s-cap/${i + 1}/start ${seed}\nupdate refs/seamux/turns/s-cap/${i + 1}/end ${seed}\n`).join("") });
  hook("start", { cwd: RT, session_id: "s-cap", prompt: "p" });
  hook("end", { cwd: RT, session_id: "s-cap" });
  const capped = T.turnRefs(RT, "s-cap");
  const ns = [...new Set(capped.map(r => r.n))].sort((a, b) => a - b);
  ok("turns: a stop keeps the session's last 50 turns without waiting for the next session",
     ns.length === 50 && ns[0] === 7 && ns[ns.length - 1] === 56, ns.join(","));
}

// ---------------------------------------------------------------- turn targets
if (want("turn targets")) {
  const T = await import("./lib/turns.mjs");
  const RU = repo("ru");
  write(RU, "a.js", "1\n"); sh(RU, `git add -A && ${G} commit -q -m base`);
  write(RU, "before.js", "uncommitted before the prompt\n");
  T.start({ cwd: RU, session: "sess-one", prompt: "add the widget" });
  write(RU, "widget.js", "w\n"); write(RU, "a.js", "2\n");
  T.end({ cwd: RU, session: "sess-one" });
  T.start({ cwd: RU, session: "sess-one", prompt: "now the tests" });
  write(RU, "widget.test.js", "t\n");
  const open = (...a) => { const r = cli(RU, "open", "--no-open", "--no-jev", "--json", ...a); try { return JSON.parse(r.stdout); } catch { return { err: r.stderr + r.stdout }; } };
  const filesOf = id => S.read(id).files.map(f => f.path).sort().join(",");

  const t1 = open("--turn", "sess-one/1");
  ok("turn: --turn SESSION/N diffs that turn's start against its end, and nothing from before the prompt",
     t1.id && filesOf(t1.id) === "a.js,widget.js", t1.err || filesOf(t1.id));
  const r1 = S.read(t1.id);
  ok("turn: the source names the turn and the page label carries its prompt",
     r1.source.kind === "turn" && r1.source.n === 1 && r1.source.session === "sess-one" && !r1.source.live &&
     r1.source.label === "turn 1 · add the widget" && r1.title === "turn 1 · add the widget", JSON.stringify(r1.source));
  ok("turn: its default id names the repo, the session and the turn", t1.id === "ru-turn-sess-one-1", t1.id);

  const t2 = open("--turn", "last", "--session", "sess-one");
  ok("turn: --turn last while it runs diffs its start against the working tree",
     t2.id && filesOf(t2.id) === "widget.test.js" && S.read(t2.id).source.live &&
     S.read(t2.id).source.label === "turn 2 · running · now the tests", t2.err || JSON.stringify(S.read(t2.id).source));
  const env = { ...ENV, CLAUDE_CODE_SESSION_ID: "sess-one" };
  const sp = spawnSync("node", [path.join(HERE, "lookout.mjs"), "open", "--since-prompt", "--no-open", "--no-jev", "--json"], { encoding: "utf8", env, cwd: RU });
  let spj = {}; try { spj = JSON.parse(sp.stdout); } catch { /* checked below */ }
  ok("turn: --since-prompt reads this session's latest prompt and diffs it against the working tree",
     spj.id === "ru-since-sess-one-2" && filesOf(spj.id) === "widget.test.js" && S.read(spj.id).source.sincePrompt, sp.stderr + sp.stdout);

  T.end({ cwd: RU, session: "sess-one" });
  write(RU, "later.js", "after the stop\n");
  ok("turn: an ended turn shows only its own work, not what came after its stop",
     filesOf(open("--turn", "sess-one/2").id) === "widget.test.js");

  // An older turn whose stop was lost is not running: the working tree holds
  // later turns' work too, so it is refused rather than diffed against it.
  sh(RU, `git update-ref -d refs/seamux/turns/sess-one/1/end`);
  T.start({ cwd: RU, session: "sess-one", prompt: "a third" });
  const lost = cli(RU, "open", "--turn", "sess-one/1", "--no-open");
  ok("turn: an older turn with no end snapshot is refused", lost.status === 1 && /turn 1 of session sess-one has no end snapshot/.test(lost.stderr), lost.stderr);

  const two = cli(RU, "open", "--turn", "1", "--worktree");
  ok("turn: a second target is refused", two.status === 1 && /pick one of .*--turn, --since-prompt/.test(two.stderr), two.stderr);
  const none = cli(RU, "open", "--turn", "sess-one/9", "--no-open");
  ok("turn: a turn that was never taken is refused with the range there is", none.status === 1 && /no turn 9 .*turns 1–3/.test(none.stderr), none.stderr);
  const nos = spawnSync("node", [path.join(HERE, "lookout.mjs"), "open", "--turn", "last", "--no-open"],
    { encoding: "utf8", env: { ...ENV, CLAUDE_CODE_SESSION_ID: "" }, cwd: RU });
  ok("turn: with no session it says how to name one", nos.status === 1 && /pass --turn SESSION\/N/.test(nos.stderr), nos.stderr);
  const bad = cli(RU, "open", "--turn", "x/y", "--no-open");
  ok("turn: a malformed turn is refused", bad.status === 1 && /--turn wants N, last/.test(bad.stderr), bad.stderr);
  const other = cli(RU, "open", "--turn", "sess-two/last", "--no-open");
  ok("turn: a session with no turns here is refused", other.status === 1 && /no turns recorded for session sess-two/.test(other.stderr), other.stderr);

  const PR = await import("./lib/prompt.mjs");
  const b1 = PR.brief(S.read(t1.id), { patchPath: S.paths(t1.id).patch, plansDir: TMP, outPath: path.join(TMP, "o.json") });
  ok("turn: the reviewer brief words the target as one agent turn", /what one agent turn changed in .*turn 1 of session sess-one \(its start snapshot against its end snapshot\)/.test(b1));
  const b2 = PR.brief(S.read(spj.id), { patchPath: S.paths(spj.id).patch, plansDir: TMP, outPath: path.join(TMP, "o.json") });
  ok("turn: and since-prompt as everything since that prompt", /everything changed in .* since prompt 2 of session sess-one/.test(b2));
  const help = cli(RU, "help").stdout;
  ok("turn: the usage text lists --turn and --since-prompt", help.includes("--turn [SESSION/]N|last | --since-prompt"));
  const skill = fs.readFileSync(path.join(HERE, "SKILL.md"), "utf8");
  ok("turn: SKILL.md lists both targets", skill.includes("lookout open --turn last") && skill.includes("lookout open --since-prompt"));
}

// ---------------------------------------------------------------- page script
if (want("page script")) {
  const r = spawnSync("node", ["--check", path.join(HERE, "page", "review.js")], { encoding: "utf8" });
  ok("page: review.js parses", r.status === 0, r.stderr);
  const js = fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8");
  const tpl = fs.readFileSync(path.join(HERE, "page", "review.html"), "utf8");
  const css = fs.readFileSync(path.join(HERE, "page", "review.css"), "utf8");
  ok("page: framed by the app (?embed=app), it drops its title row and keeps one row of tools",
     js.includes('new URLSearchParams(location.search).get("embed") === "app"') &&
     js.includes('document.documentElement.dataset.embed = "app"') &&
     css.includes(":root[data-embed] .brand, :root[data-embed] .what { display: none; }") &&
     !/:root\[data-embed\][^{]*(#gate|\.mode|#ov-btn|#map-btn|#layout|\.keys-btn)[^{]*\{[^}]*display: none/.test(css));
  ok("page: the app frames it with ?embed=app",
     fs.readFileSync(path.join(HERE, "..", "app", "ui", "review.ts"), "utf8").includes("/review/${encodeURIComponent(rid)}?embed=app"));
  ok("page: no plan map, no Map button (nor its key in the list)",
     js.includes('$("map-btn").hidden = !R.planMap;') && js.includes('$("keys-map").hidden = !R.planMap;') && tpl.includes('id="keys-map"'));
  ok("page: the gate pill is a button that goes to the first open blocking finding, else on like n",
     tpl.includes('<button type="button" id="gate" class="gate">') && js.includes('$("gate").addEventListener("click", firstBlocking);') &&
     /function firstBlocking\(\) \{[\s\S]{0,400}x\.severity === "blocker" \|\| x\.severity === "major"[\s\S]{0,200}goTo\(list\[0\]\.id\);\s*else stepFinding\(1\);/.test(js));
  ok("page: a card puts the PR's chips by its severity chip, then its title, and shows a status pill only when it is not open",
     /el\("span", \{ class: "title", title: x\.id[^\n]*\n(\s*\/\/[^\n]*\n)*\s*finding \? el\("span", \{ class: "meta" \}, el\("span", \{ class: "cat" \}, metaWords\(x\)\)\) : null,/.test(js) &&
     js.includes('(x.status || "open") !== "open" ? (stillBlocks(x)') && js.includes(': el("span", { class: "status st-" + x.status }, x.gh ? "resolved on GitHub" : x.status)) : null);') &&
     js.includes("mark, sev, chips,\n      // Title next;"));
  const app = fs.readFileSync(path.join(HERE, "..", "app", "ui", "review.ts"), "utf8");
  const appCss = fs.readFileSync(path.join(HERE, "..", "app", "ui", "review.css"), "utf8");
  const lookoutPageMd = fs.readFileSync(path.join(HERE, "references", "page.md"), "utf8");
  ok("page: the gate pill says how many are open (\"blocked · 3 open\"); its tooltip, mirrored in the app, gives the breakdown by severity",
     js.includes('.map(([s, n]) => `${n} ${s}`).join(", ");') && js.includes("text: `blocked · ${open.length} open`, detail }") &&
     js.includes("text: open.length ? `pass · ${open.length} open` : \"pass · no open findings\", detail }") &&
     js.includes('const detail = open.length ? `${counts} open.` : "";') &&
     js.includes('return { go, title: (g.detail ? g.detail + " " : "") +') && !js.includes("`blocked · ${counts} open`") &&
     js.includes("gate: { cls: g.cls, text: g.text, title: gt.title, go: gt.go }") && app.includes("gate.title = p.gate.title;"));
  ok("app: one findings control, \"N open ▾\" or \"N open · M picked ▾\": no Findings ▸ beside an Act ▾, and the gate pill keeps the counts by severity",
     app.includes('const words = total ? `${total} open${n ? ` · ${n} picked` : ""}` : "No open findings";') &&
     !app.includes('`${total} finding${total === 1 ? "" : "s"}') &&
     app.includes('} else toggle.textContent = `${words} ▾`;') &&
     !app.includes("`Findings ${open ? \"▾\" : \"▸\"}`") && !app.includes("r-act-btn") && !app.includes("Act on ${n} picked") &&
     !app.includes("btn(`Findings · ${openSummary(j.open)}"));
  ok("app: the findings button opens one panel: the picker on top (Pick all, Blockers and majors, Clear, then the list), Edit, Fix with commits, Post comments and Push below, acting on the picks",
     app.includes('const bar = [this.menu(`find:${j.id}`, toggle, acts, "", top, { role: "dialog", cls: "r-find-panel", label: "Findings" })];') &&
     app.includes('top.push(this.picker(j.id, rows, ticked, busy), sep, el("p", "r-menu-meta", n ? `Acts on the ${n} picked` : "Pick findings to act on them"));') &&
     app.includes("if (total) acts.push(edit, fix, post);") && app.includes("acts.push(push);") &&
     app.includes("edit.disabled = fix.disabled = busy || !n;") && app.includes("post.disabled = busy || !j.pr || !n;") &&
     ['q("Pick all", "all"', 'q("Blockers and majors", "bm"', 'q("Clear", "none"'].every(k => app.includes(k)) &&
     !app.includes("pickerOpen") && !app.includes("changePicks") && !app.includes("pickedList") && !app.includes("out.push(this.picker(") &&
     app.includes('private menu(key: string, b: HTMLButtonElement, items: HTMLElement[], meta = "", top: HTMLElement[] = [], opts: { role?: "menu" | "dialog"; cls?: string; label?: string } = {}): HTMLElement {') &&
     app.includes('if (!it.getAttribute("role") && role === "menu") it.setAttribute("role", "menuitem");') &&
     app.includes('this.head.querySelector<HTMLElement>(".r-menu :is(button, input, a):not(:disabled)")?.focus();') &&
     app.includes("if (this.moreOpen === id || this.moreOpen === `find:${id}`) this.moreOpen = null;") &&
     app.includes('btn("Edit", ') && app.includes('btn("Fix with commits", ') && app.includes('btn("Post comments", ') &&
     app.includes('if (!this.ticked.has(j.id)) this.ticked.set(j.id, new Set(rows.filter((f) => f.severity === "blocker" || f.severity === "major").map((f) => f.id)));') &&
     appCss.includes(".r-menu.r-find-panel {"));
  ok("app: a pick in the panel keeps it open and gives the focus back to the box or quick pick clicked",
     app.includes('refocus(`input[data-fid="${CSS.escape(f.id)}"]`);') && app.includes('refocus(`[data-quick="${which}"]`);') &&
     app.includes("const refocus = (sel: string) => this.head.querySelector<HTMLElement>(`.r-find-panel ${sel}`)?.focus();"));
  ok("app: framed, the header leaves the verdict to the page's gate pill; unframed or down, its chip says it with the same counts",
     app.includes('const framed = j.status === "ready" && !!j.review_id && this.frameDown !== j.review_id;') &&
     app.includes('(framed ? null : el("span", `r-chip ${state}`, `${state} · ${openCount(j.open)}`))') &&
     app.includes("chip.title = openSummary(j.open);") && app.includes('return n ? `${n} open` : "no open findings";') &&
     app.includes('return parts.length ? `${parts.join(", ")} open` : "no open findings";') &&
     app.includes('const SEVERITIES = ["blocker", "major", "minor", "nit"];') && js.includes('const SEV = ["blocker", "major", "minor", "nit"];') &&
     /const down = [\s\S]{0,300}this\.frameDown = rid;/.test(app));
  ok("app: the log is a Log (n) item in the ⋯ menu that opens the log, not a row of its own",
     app.includes('const log = btn(`Log (${j.log.length})`') && app.includes("items.push(log);") &&
     app.includes("if (j.log.length && this.logOpen.get(j.id)) parts.push(this.logBox(j));") &&
     !app.includes("`log (${j.log.length})`") && !app.includes('el("details", "r-log")'));
  ok("app: a fix or post underway says what it is doing on the header row, not a row under it",
     app.includes('status = el("span", "r-now r-busy", j.activity || "starting");') && app.includes("this.headOf(this.title(j), chip, meta, link, acts.buttons, more, status);"));
  ok("app: the findings button is the header's one filled primary only while something is picked, outlined otherwise",
     app.includes('const toggle = el("button", `r-btn pickbtn${n ? " primary" : ""}${short ? " short" : ""}`);') &&
     appCss.includes(".r-btn.primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }") &&
     !/\.r-btn\.primary\.[\w-]+ \{[^}]*background/.test(appCss));
  ok("app: the header is one row at any width: GitHub folds, the View menu's items join ⋯, then the findings button shortens, before the title goes under 12ch; the gate pill and the findings button stay",
     app.includes('const FOLDS = ["github", "view", "findings"] as const;') && app.includes("const TITLE_MIN = 160;") &&
     /this\.fold = 0;\s*draw\(\);\s*while \(this\.fold < FOLDS\.length && this\.overflows\(\)\) \{\s*this\.fold\+\+;\s*draw\(\);\s*\}/.test(app) &&
     app.includes("return row.scrollWidth > row.clientWidth + 1 || squeezed;") &&
     app.includes("name.scrollWidth > name.clientWidth && name.clientWidth < TITLE_MIN") &&
     /new ResizeObserver\(\(\) => \{\s*if \(fitFrame\) return;\s*fitFrame = requestAnimationFrame\(\(\) => \{\s*fitFrame = 0;\s*const w = this\.head\.clientWidth;\s*if \(w && w !== this\.fitWidth\) this\.render\(true\);\s*\}\);\s*\}\)\.observe\(this\.head\);/.test(app) &&
     app.includes('if (tools.view.length && viewInMore) folded.push(...tools.view);') &&
     app.includes('folds.has("github") ? "Open on GitHub" : "GitHub"') &&
     appCss.includes(".r-mhead-row { display: flex; align-items: center; gap: 8px 10px; min-width: 0; flex-wrap: nowrap; }") &&
     appCss.includes(".r-acts { display: flex; gap: 6px; flex-wrap: nowrap; align-items: center; margin-left: auto; flex: none; }") &&
     !/\.r-(mhead-row|acts) \{[^}]*flex-wrap: wrap/.test(appCss));
  ok("app: a View menu that would hold one item (under 900px, only Keyboard shortcuts) is no menu: the item goes in ⋯",
     app.includes('const viewInMore = tools.view.length === 1 || folds.has("view");') &&
     app.includes('if (tools.view.length && !viewInMore) acts.append(this.viewMenu(tools.view));'));
  // The pill and the button count one set (not resolved, not dismissed) in one
  // word, "open", and a resolve in the framed page moves both.
  ok("page+app: the gate pill and the findings button count the same open set, say \"open\", and give the breakdown by severity in their tooltips",
     js.includes('for (const x of (R.findings || []).filter(isOpen)) open[x.severity] = (open[x.severity] || 0) + 1;') &&
     js.includes("gate: { cls: g.cls, text: g.text, title: gt.title, go: gt.go }, open,") &&
     app.includes("open?: Record<string, number>;") &&
     app.includes("const pageOpen = j.review_id && j.review_id === this.framed ? this.pageState?.open ?? null : null;") &&
     app.includes("${JSON.stringify(pageOpen)}") &&
     app.includes('const rows = all.filter((f) => f.status !== "resolved" && f.status !== "dismissed");') &&
     app.includes('toggle.title = (total ? `${openSummary(bySev)}. ` : "") +'));
  ok("app: a picker row leads with its severity chip and place, and its title wraps to two lines, clamped, not cut mid-word on one",
     app.includes('text.append(el("span", `r-sev ${f.severity}`, f.severity), " ", el("span", "r-loc", `${f.file.split("/").pop()}:${f.line}`), " ", el("span", "r-sum", f.summary));') &&
     app.includes("label.append(cb, text);") &&
     /\.r-findings \.r-find-text \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/.test(appCss) &&
     !appCss.includes(".r-findings .r-sum { white-space: nowrap;"));
  ok("app: Overview, Map, Split or Unified and ? sit in one View ▾ menu, each item showing its key, a check while on; o, m, v and ? work from the header as in the page",
     ['"o", () => this.tell("overview"), p.overview', '"m", () => this.tell("map"), p.map', '"v", () => this.tell("layout", { layout: v }), p.layout === v, "menuitemradio"', '"?", () => this.tell("keys"), p.keys'].every(k => app.includes(k)) &&
     app.includes('b.append(mark, el("span", "r-tool-name", text), el("kbd", "r-kbd", key));') && app.includes('b.setAttribute("aria-checked", String(on));') &&
     app.includes('const b = el("button", "r-btn quiet r-view-btn", "View ▾");') && app.includes('return this.menu("view", b, items);') &&
     !app.includes('"r-btn quiet r-tool"') && !app.includes('el("div", "r-seg")') && !app.includes('"r-btn quiet r-keys"') && !app.includes('el("span", "r-sep")') &&
     !/\.r-(sep|seg|seg-btn|keys|tool) \{/.test(appCss) && appCss.includes(".r-check svg {") && appCss.includes(".r-menu:not(:has(.r-check svg)) .r-check { display: none; }") &&
     app.includes('const op = ({ o: "overview", m: "map", v: "layout", "?": "keys" } as Record<string, string>)[e.key];') &&
     app.includes('this.tell(op, op === "layout" ? { layout: p.layout === "split" ? "unified" : "split" } : {});'));
  ok("page+app: one Overview: the app drops its Overview button while the page's file list shows its own Overview row (o still opens it)",
     js.includes('ovRow: !!document.querySelector("#tree .ov-row")?.getClientRects().length,') && js.includes("github: prSummary() }, hostOrigin);") &&
     /function drawSide\(\) \{[\s\S]*?\$\("tree"\)\.prepend\(el\("div", \{ class: "row ov-row"[\s\S]*?postState\(\);\n  \}/.test(js) &&
     app.includes("ovRow?: boolean;") && app.includes('if (!p.ovRow) view.push(item("Overview", "o",') &&
     js.includes('else if (e.key === "o") { toggleOverview(); e.preventDefault(); }'));
  ok("page+app: framed, the page's tools move onto the app's header row after a hello/host handshake, so one band sits above the file",
     js.includes('window.parent.postMessage({ lookout: "hello", id: R.id }, "*");') &&
     /if \(d\.lookout === "host"\) \{[\s\S]*?hostOrigin = e\.origin && e\.origin !== "null" \? e\.origin : "\*";\s*clearInterval\(helloTimer\);\s*hosted = true;\s*document\.documentElement\.dataset\.host = "app";/.test(js) &&
     /function postState\(\) \{\s*if \(!hosted\) return;/.test(js) &&
     js.includes("if (e.source !== window.parent ||") &&
     ["drawHeader", "drawLayout", "drawOverviewChrome", "toggleKeys"].every(f => new RegExp(`function ${f}\\(.*\\) \\{[\\s\\S]*?postState\\(\\);\\n  \\}`).test(js)) &&
     css.includes(":root[data-host] #top { padding: 0; border: 0; min-height: 0; height: 0; }") &&
     css.includes(":root[data-host] #top .tools { display: none; }") &&
     app.includes('if (!f || e.source !== f.contentWindow || e.origin !== this.pageOrigin) return;') &&
     /if \(d\.lookout === "hello"\) \{[^}]*this\.sentPicks = "";\s*f\.contentWindow\?\.postMessage\(\{ lookout: "host" \}, this\.pageOrigin\);/.test(app) &&
     app.includes('f.contentWindow?.postMessage({ lookout: "do", op, ...extra }, this.pageOrigin);') &&
     ["gate", "overview", "map", "layout", "keys"].every(op => app.includes(`this.tell("${op}"`) && js.includes(`d.op === "${op}"`)) &&
     app.includes("h.append(...tools.state);") && app.includes("acts.append(this.viewMenu(tools.view));"));
  // The page pins the host's origin: state goes only there, and only it is heard
  // after the handshake. Hello (only the id) repeats until answered, for an app
  // that was not listening yet.
  ok("page: the host's origin is pinned after the handshake, and hello repeats until answered",
     js.includes('if (hostOrigin !== "*" && e.origin !== hostOrigin) return;') &&
     /keys: !\$\("keys"\)\.hidden,[\s\S]{0,400}\}, hostOrigin\);/.test(js) &&
     /helloTimer = setInterval\(\(\) => \{ if \(hosted \|\| \+\+tries > 10\) clearInterval\(helloTimer\); else hello\(\); \}, 500\);/.test(js));
  ok("page: unframed, or framed by an app that never answers, the page keeps its own tools row",
     !/:root\[data-embed\][^{]*\.tools[^{]*\{[^}]*display: none/.test(css) && js.includes("let hosted = false;"));
  ok("app: an open review folds the list away, and Reviews ▸ brings it back, remembered in try/catch",
     app.includes('const folded = this.hasOpen() && !this.listShown;') && app.includes("this.side.hidden = folded;") &&
     /try \{\s*localStorage\.setItem\(LIST_KEY, this\.listShown \? "shown" : "folded"\);\s*\} catch/.test(app) &&
     app.includes('this.listShown = localStorage.getItem(LIST_KEY) === "shown";') &&
     app.includes('btn(shown ? "◂ Reviews" : "Reviews ▸"') && app.includes('list.setAttribute("aria-expanded", String(shown));') &&
     appCss.includes(".review.folded { grid-template-columns: minmax(0, 1fr); }") && appCss.includes(".r-side[hidden] { display: none; }"));
  ok("page: a card's category and verdict, in plain words, take no width from the title: out of the row (hovered, the title's tooltip names them with the id, so nothing covers the card), back in it when focused or current, and always in the DOM",
     /\.card-head \.meta \{ position: absolute;[^}]*opacity: 0; pointer-events: none;/.test(css) &&
     !/\.card:hover \.card-head \.meta/.test(css) && js.includes('title: x.id + (finding ? " · " + metaWords(x) : "")') &&
     js.includes('const verdictWords = x => x.verdict === "CONFIRMED" ? "confirmed" : "plausible, not confirmed";') &&
     js.includes('const metaWords = x => x.id.startsWith("f") ? `${x.category} · ${verdictWords(x)}` : "";') &&
     !js.includes('el("span", { class: "fid" }, x.id)') &&
     /\.card:focus-within \.card-head \.meta, \.card\.flash \.card-head \.meta, \.card\.cur \.card-head \.meta \{\s*position: static; opacity: 1;/.test(css) &&
     css.includes("@media (hover: none) { .card-head .meta { position: static; opacity: 1;") &&
     css.includes(".card { position: relative; }") &&
     !/\.card-head \.(meta|fid|cat)[^{]*\{[^}]*display: none/.test(css) && !css.includes(".card-head .fid, .card-head .cat { opacity: 0;"));
  ok("page: \"Fails when:\" is a quiet label, normal weight and muted, not bold",
     js.includes('el("span", { class: "label" }, "Fails when: "), el("span", { class: "scenario" }, x.failure_scenario)') &&
     css.includes(".card-body .failure .label { color: var(--muted); font-weight: 400; }") &&
     !js.includes('el("b", null, "Fails when: ")') && !css.includes(".card-body .failure b"));
  ok("page: under 900px of diff column (not window) it draws unified, keeping the saved choice (at 700-800 split wrapped nearly every line); wider brings split back; the toggle hides and the app is told",
     js.includes("const SPLIT_MIN = 900;") && !js.includes("const SPLIT_MIN = 700;") && lookoutPageMd.includes("A diff column under 900px") &&
     js.includes('const cramped = () => narrow() || ($("main").offsetWidth > 0 && $("main").offsetWidth < SPLIT_MIN);') &&
     js.includes('const useSplit = layout === "split" && !cramped() && !oneSided;') &&
     /new ResizeObserver\(\(\) => \{ if \(cramped\(\) !== wasCramped\) \{ wasCramped = cramped\(\); drawLayout\(\); drawMain\(\); \} \}\)\.observe\(\$\("main"\)\);/.test(js) &&
     /function setLayout\(l\) \{ layout = l; store\.set\("lookout\.layout", l\);/.test(js) && !/cramped\(\)[^\n]*store\.set\("lookout\.layout"/.test(js) &&
     js.includes('$("layout").classList.toggle("auto", cramped());') && css.includes("#layout.auto { display: none; }") &&
     js.includes("layout, auto: cramped(), overview,") && !js.includes("wasNarrow") &&
     app.includes("auto?: boolean;") && /if \(!p\.auto\) \{\s*for \(const \[v, label\] of \[\["split", "Split diff"\], \["unified", "Unified diff"\]\]\)/.test(app));
  ok("app: live (or disconnected) is only its dot at every width (words in its tooltip); short of width the findings button is an icon and \"M/N ▾\" (its words the label)",
     app.includes('const dot = p.mode.cls === "live" || p.mode.cls === "down";') && !app.includes('this.folds("live")') &&
     !appCss.includes('.r-mode.live::before { content: "● "; }') &&
     app.includes('mode.title = dot ? `${p.mode.text}. ${p.mode.title}` : p.mode.title;') && app.includes('mode.setAttribute("aria-label", p.mode.text);') &&
     appCss.includes('.r-mode.live.only::before { content: "●"; }') &&
     app.includes('const short = this.folds("findings");') && app.includes('toggle.append(listIcon(), `${n ? `${n}/${total}` : total} ▾`);') && app.includes('toggle.setAttribute("aria-label", words);') &&
     app.includes("private folds(f: Fold): boolean {\n    return FOLDS.indexOf(f) < this.fold;"));
  ok("app: the title keeps 12ch until every step is taken, and a cut title is the ⋯ menu's first line",
     appCss.includes("text-overflow: ellipsis; min-width: 12ch; flex: 0 1 auto; }") && appCss.includes(".r-mhead-row.tight .r-name { min-width: 3ch; }") &&
     app.includes('if (row && this.overflows()) row.classList.add("tight");') &&
     app.includes('if (row && name) row.classList.toggle("cut", name.scrollWidth > name.clientWidth);') &&
     app.includes('return this.menu(key, b, items, meta, name ? [el("p", "r-menu-title", name)] : []);') &&
     app.includes("this.more(more?.key ?? \"head\", meta, items, name)") &&
     /m\.append\(\.\.\.top\);\s*if \(meta\) m\.append\(el\("p", "r-menu-meta", meta\)\);/.test(app) &&
     appCss.includes(".r-mhead-row:not(.cut) .r-menu-title { display: none; }"));
  ok("page: an addressed blocker or major says it still blocks in its pill, with the why as its tooltip",
     js.includes('const stillBlocks = x => x.id.startsWith("f") && x.status === "addressed" && (x.severity === "blocker" || x.severity === "major");') &&
     js.includes('title: "Still blocks the gate until you resolve it" }, "addressed · still blocks")') &&
     !js.includes("still-blocks") && !css.includes(".still-blocks"));
  ok("page: the status change the pill already shows draws only its author's words, not \"marked it …\"",
     js.includes('const pill = last && last.to === (x.status || "open") && x.status !== "open" ? last : null;') &&
     /function message\(m, pill, folded\) \{[\s\S]{0,700}if \(m === pill\) return m\.text \?/.test(js) &&
     js.includes("messages(thread, pill, folded)") && js.includes("out.push(message(m, pill, folded));"));
  ok("page: status changes in a row by one author, minutes apart and without words, are one line with the net result (none when it ends where it began) and a \"changed N times\" that opens to each; authors are capitalized as on reply rows",
     js.includes("const RUN_GAP = 5 * 60000;") &&
     js.includes("const quiet = m => m.kind === \"status\" && !m.text && !(folded && m === folded.m);") &&
     js.includes("Date.parse(thread[j + 1].at) - Date.parse(thread[j].at) <= RUN_GAP) j++;") &&
     js.includes("const net = to === state ? null") && js.includes('el("details", { class: "msg change run",') &&
     js.includes("`changed ${run.length} times`") && js.includes('const DID = { open: "reopened it",') &&
     js.includes('return el("div", { class: "msg change" }, `${byName(m.by)} marked it ${m.to}`') &&
     !js.includes("`${m.by} marked it ${m.to}`"));
  ok("page: a status change its author made with a reply, within two minutes, rides on that reply's line instead of a second message",
     js.includes("const prev = pill && pill.text ? thread[thread.indexOf(pill) - 1] : null;") &&
     js.includes('prev.kind !== "status" && prev.by === pill.by &&') &&
     js.includes("Math.abs(Date.parse(pill.at) - Date.parse(prev.at)) <= 120000 ? { m: pill, after: prev, to: pill.to, text: pill.text } : null;") &&
     js.includes("if (folded && m === folded.m) return null;") &&
     js.includes('el("span", { class: "at note", title: `${folded.m.by} marked it ${folded.to}` }, " · " + folded.text)'));
  ok("page: folded, Reply / Resolve / Dismiss take no room until the card is current (click or n/p), focused or has a draft; always on touch; hover moves nothing",
     css.includes(".card > .actions.folded { display: none; }") &&
     css.includes(".card.cur > .actions.folded, .card:focus-within > .actions.folded,") &&
     css.includes(".card > .actions.folded.draft") &&
     css.includes("@media (hover: none) { .card > .actions.folded { display: flex; } }") &&
     !/\.card:hover[^{]*\.actions/.test(css) && !css.includes(".card > .actions.folded { opacity") &&
     css.includes("body.served .card:not(.cur):hover { border-color:") &&
     js.includes("onclick: e => pickCard(x.id, e) },") &&
     /function pickCard\(id, e\) \{\s*if \(e\.target\.closest\("button, a, textarea, input"\) \|\| String\(getSelection\(\) \|\| ""\)\) return;\s*openCard\(id\);/.test(js) &&
     /function openCard\(id, focus = false\) \{\s*const prev = curFinding;\s*curFinding = id;\s*redrawCards\(\[prev, id\]\);/.test(js) &&
     js.includes('box.classList.toggle("draft", !show && !!draftText(key).trim());') &&
     js.includes('(x.id === curFinding ? " cur" : "")'));
  ok("page+app: a blocked gate reads in the blocker colour, and its pill shows an arrow when it jumps",
     css.includes(".gate.blocked { color: var(--sev-blocker); border-color: var(--sev-blocker); }") &&
     appCss.includes(".r-chip.blocked { background: color-mix(in srgb, var(--bad-t) 16%, transparent); color: var(--bad-t); }") &&
     appCss.includes(".r-gate.blocked { color: var(--bad-t);") &&
     js.includes('$("gate").replaceChildren(g.text, gt.go ? el("span", { class: "go", "aria-hidden": "true" }, "↓") : "");') &&
     app.includes('const go = el("span", "r-go", "↓");'));
  ok("page: Reply, Resolve and Dismiss are quiet outlined buttons with a focus ring, not plain text",
     /\.buttons\.links button \{[^}]*border: 1px solid[^}]*\}/.test(css) && !/\.buttons\.links button \{[^}]*border: 0/.test(css) &&
     /\.buttons\.links button:focus-visible \{[^}]*outline: 2px solid/.test(css));
  ok("page: a line with open findings gets a dot per severity in its number cell, worst first; hovered they name the findings, a click or Enter goes to the worst",
     js.includes("let gutter = new Map();") && js.includes('const GUTTER_ORDER = [...SEV, "comment"];') &&
     js.includes('gutter = new Map([...anch.at].map(([k, list]) => [k, list.filter(isOpen).sort(worstFirst)]).filter(([, list]) => list.length));') &&
     js.includes('return el("button", { type: "button", class: "gmark", title: names.join("\\n"),') &&
     js.includes("onclick: e => { e.stopPropagation(); goTo(list[0].id); } },") &&
     js.includes('sevs.map(s => el("span", { class: "gdot sev-" + s })));') &&
     js.includes('const here = n == null ? null : gutter.get(side + ":" + n);') &&
     css.includes("table.diff td.ln.marked { position: relative; }") && css.includes(".gdot + .gdot { margin-left: -3px; }") &&
     ["blocker", "major", "minor", "comment"].every(s => css.includes(`.gdot.sev-${s} { --gdot: var(--gdot-${s}); }`)) && css.includes(".gdot.sev-nit {"));
  ok("page: blocker and major cards stay open; a minor, nit or comment folds to one row (chip and short title) unless current or holding a draft, and opens on click, Enter or n/p",
     js.includes('const holdsOpen = x => x.severity === "blocker" || x.severity === "major";') &&
     js.includes('const foldedCard = x => isOpen(x) && !holdsOpen(x) && x.id !== curFinding && !draftText("r:" + x.id).trim();') &&
     /if \(foldedCard\(x\)\) \{[\s\S]{0,300}class: "card folded"[\s\S]{0,300}tabindex: "0", role: "button", "aria-expanded": "false"[\s\S]{0,300}onclick: e => pickCard\(x\.id, e\),[\s\S]{0,200}e\.key === "Enter" \|\| e\.key === " "[\s\S]{0,100}openCard\(x\.id, true\);[\s\S]{0,100}el\("div", \{ class: "card-head" \}, mark, sev, chips, el\("span", \{ class: "title" \}, title\), ghMeta\(x\)\)\);/.test(js) &&
     /function goTo\(id\) \{[\s\S]{0,500}redrawCards\(\[prev, id\]\);/.test(js) &&
     /function stepFinding\(d\) \{\s*let list = \(R\.findings \|\| \[\]\)\.filter\(isOpen\);/.test(js) &&
     css.includes(".card.folded .card-head { padding: 3px 10px; flex-wrap: nowrap; }"));
  ok("page+app: picked (the app's Act set, .picked, a custom SVG check at the card's left) is named apart from current (the card the reader is on, .cur); the app posts its picks to the page",
     js.includes("let picked = new Set();") && js.includes('document.createElementNS(ns, "svg")') &&
     js.includes('(x.id === curFinding ? " cur" : "") + (mark ? " picked" : "")') &&
     js.includes('else if (d.op === "picks" && Array.isArray(d.ids)) setPicked(d.ids);') &&
     /function setPicked\(ids\) \{[\s\S]{0,300}redrawCards\(changed\);/.test(js) &&
     css.includes(".pickmark {") && !css.includes(".card.picked {") && !/picked by a click|focused or picked|or the picked finding/.test(js + css) &&
     app.includes('f.contentWindow?.postMessage({ lookout: "do", op: "picks", ids }, this.pageOrigin);') &&
     app.includes("this.syncPicks(job);") && app.includes("if (key === this.sentPicks) return;"));
  ok("page: the current card (.cur, where its actions show) has an accent left edge and border in both modes; picked keeps only its check",
     css.includes(".card.cur { border-color: color-mix(in srgb, var(--accent) 60%, var(--card-border)); box-shadow: inset 3px 0 0 var(--accent); }") &&
     !/\.card\.picked[^{]*\{[^}]*(border|box-shadow|background)/.test(css) && lookoutPageMd.includes("accent edge on its left"));
  ok("page: in light mode a selected row is an accent tint and hover a shade darker than the side list; the minor and nit gutter dots get a darker ring",
     [/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{\s*--sel: color-mix\(in srgb, var\(--role-focus\) 22%, var\(--ef-bg-dim\)\); --hover: var\(--ef-bg3\);\s*--gdot-nit: var\(--ef-dim\); --gdot-edge-minor: var\(--ef-text-faint\);/,
      /:root\[data-theme="light"\] \{\s*--sel: color-mix\(in srgb, var\(--role-focus\) 22%, var\(--ef-bg-dim\)\); --hover: var\(--ef-bg3\);\s*--gdot-nit: var\(--ef-dim\); --gdot-edge-minor: var\(--ef-text-faint\);/].every(r => r.test(css.slice(css.indexOf("/* everforest:end */")))) &&
     css.includes(".gdot.sev-minor { box-shadow: inset 0 0 0 1px var(--gdot-edge-minor, transparent), 0 0 0 1.5px var(--bg); }"));
  ok("page: a file's status letter spells itself out in its tooltip (modified, added, deleted, renamed), in the tree, the risk list and the file header",
     js.includes('const ST_NAMES = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed" };') &&
     js.includes('const stLetter = (f, cls = "") => el("span", { class: "st st-" + f.status + (cls ? " " + cls : ""), title: ST_NAMES[f.status] || f.status }, f.status);') &&
     (js.match(/stLetter\(f, "x"\)/g) || []).length === 2 && (js.match(/stLetter\(f\)/g) || []).length === 1 && !js.includes('el("span", { class: "st st-" + f.status }, f.status)'));
  ok("page: a file row is quiet: risk dot, name and findings badge; its folder, +/- counts and status letter (.x) show on the selected or hovered row, clipped (not removed) otherwise, and named in its tooltip",
     /\.row\.file:not\(\.sel\):not\(:hover\):not\(:focus-within\) \.x \{\s*position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\);/.test(css) &&
     (js.match(/el\("span", \{ class: "counts x" \}, countsText\(f\)\)/g) || []).length === 2 &&
     (js.match(/el\("span", \{ class: "in x" \}/g) || []).length === 2 && !js.includes('el("span", { class: "in" }') &&
     js.includes('countsText(f) + " · " + (ST_NAMES[f.status] || f.status),') &&
     (js.match(/title: rowTitle\(f/g) || []).length === 2 && !/\.x \{[^}]*display: none/.test(css));
  ok("page: a group's why is its tooltip, each row's (\"Grouped: …\") and its Overview row's, never a line between rows",
     !js.includes('el("div", { class: "why"') && !/^\.why \{/m.test(css) &&
     js.includes('box.append(el("div", { class: "group", "data-group": g.id, title: why.length ? why.join("\\n") : null },') &&
     js.includes('files.map(f => fileRow(f, { dir: true, why }))));') && js.includes('why.length ? "Grouped: " + why.join("; ") : ""') &&
     js.includes('why.length ? "Grouped: " + why.join("; ") : null,') && !js.includes('class: "ov-why"') && !css.includes(".ov-why"));
  ok("page: the file header says \"high risk\" in plain words: no language, no \"Jev 100%\", no reason that only repeats an open finding; its tooltip gives the score and Jev's part",
     js.includes('const headReasons = f => (f.reasons || []).filter(r => !/^open \\w+ finding$/.test(r) && !/^Jev \\d+%$/.test(r));') &&
     js.includes("`. Jev (TypeSafe's model) read the change as ${Math.round(f.jev * 100)}% risky.`") &&
     js.includes("title: riskLine(f) }, `${f.band} risk`,") &&
     !js.includes('el("span", { class: "lang" }, f.lang)') && !css.includes("#file-head .lang") &&
     js.includes('reasons.length ? el("span", { class: "reasons" }, " · " + reasons.join(", ")) : null) : null,'));
  ok("page: a closed finding has its own look: one row by default (opened by a click or Enter, folded again by its head), its severity chip and title muted, a muted resolved or dismissed chip, Reopen and no Resolve",
     js.includes("const foldedClosed = x => !isOpen(x) && !expandedClosed.has(x.id);") &&
     /if \(foldedClosed\(x\)\) \{[\s\S]{0,400}class: "card folded closed"[\s\S]{0,300}tabindex: "0", role: "button", "aria-expanded": "false",[\s\S]{0,700}el\("div", \{ class: "card-head" \}, mark, sev, chips, el\("span", \{ class: "title" \}, title\), ghMeta\(x\), closedChip\)\);/.test(js) &&
     js.includes("e.stopPropagation(); expandedClosed.delete(x.id); redrawCards([x.id]);") &&
     js.includes('open ? el("button", { type: "button", onclick: go("resolve") }, "Resolve") : null,') &&
     js.includes('!open ? el("button", { type: "button", onclick: go("reopen") }, "Reopen") : null,') &&
     css.includes(".card.closed .sev { --sev: var(--muted); }") &&
     css.includes(".card.closed .status { color: var(--muted);") && !css.includes(".card .status.st-resolved {") &&
     !/\.card\.closed[^{]*\{[^}]*opacity/.test(css));
  ok("page+app: amber is for status only: a minor chip is neutral grey on the page and in the findings panel, and the one filled primary is the primary role with its ink in both",
     css.includes("--sev-minor: var(--ef-text-dim);") && !css.includes("--sev-minor: var(--ef-text-yellow)") &&
     appCss.includes(".r-sev.minor { color: var(--ef-text-dim);") && !/\.r-sev\.minor \{[^}]*yellow/.test(appCss) &&
     css.includes(".buttons button.primary { background: var(--role-primary); border-color: var(--role-primary); color: var(--role-on-primary); }") &&
     css.includes("--sev-blocker: var(--role-broken-t); --sev-major: var(--ef-text-orange);"));
  {
    // Amber is the colour role for "needs you", and nothing on the review
    // page is a call: no state token, and no rule outside the synced block,
    // wears the palette's yellow, its mark or the attend role. Syntax
    // highlighting (--hl-*) is a palette of its own and may.
    const own = css.slice(css.indexOf("/* everforest:end */")).replace(/\/\*[\s\S]*?\*\//g, "");
    const amber = own.split(/[;{}]/).filter((d) => /--ef-(text-)?(yellow|mark|warn)\b|--ef-bg-yellow|--role-attend/.test(d) && !/^\s*--hl-/.test(d));
    ok("page: no state wears amber: medium risk, addressed, stale notes, modified files and the find flash moved off it",
       amber.length === 0 && /--risk-medium: var\(--ef-text-orange\)/.test(own) && /\.card \.status\.st-addressed \{ color: var\(--addressed\)/.test(own) &&
       /\.nmark\.stale \{ color: var\(--muted\); border-style: dashed; \}/.test(own) && /--flash: var\(--ef-bg-blue\)/.test(own) &&
       /--st-m: var\(--ef-text-blue\)/.test(own), amber.join(" | "));
  }
  {
    // The Overview: a folded list, one row per group, nothing open by default.
    const ov = js.slice(js.indexOf("function ovSection(key) {"), js.indexOf("  // The Map view:"));
    const sec = ov.slice(0, ov.indexOf("  function drawOverview() {"));
    ok("page: the Overview is a folded list: each group one row (band, headline, counts, chevron), its body drawn only once opened",
       sec.includes('el("span", { class: "gband" }, lost ? "" : band),') &&
       sec.includes(': !first ? "No note for this group"') && sec.includes("firstSentence(first.direction)") &&
       sec.includes('plural(files.length, "file")') && sec.includes('findings ? plural(findings, "finding") : null, watch ? `${watch} to watch` : null].filter(Boolean).join(" · ")') &&
       sec.includes('el("span", { class: "chev", "aria-hidden": "true" }, isOpenNow ? "▾" : "▸")') &&
       sec.includes('const body = isOpenNow ? el("div", { class: "ov-body",') &&
       css.includes(".ov-hl { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }") &&
       !js.includes("ovOpen.add(g.id)") && !/ovOpen = new Set\(\[/.test(js));
    ok("page: a group row is a focusable button that says whether it is open; ids and edge reasons sit in its tooltip only",
       sec.includes('el("div", { class: "ov-sum", role: "button", tabindex: "0", "aria-expanded": String(isOpenNow), "data-key": key, title,') &&
       sec.includes("const title = [lost ? null : `${g.id}, ${band} risk`,") && !sec.includes('class: "gid"') && !css.includes(".gid"));
    ok("page: Enter or Space opens and folds a row; ↑/↓ and Home/End move between rows; Esc in an open body folds it and goes back to its row; j/k still step files",
       sec.includes('if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }') &&
       sec.includes("/^(ArrowDown|ArrowUp|Home|End)$/.test(e.key)") && sec.includes('document.querySelectorAll("#diff .ov-sum")') &&
       /if \(e\.key !== "Escape"[^\n]*\n\s*e\.preventDefault\(\); toggle\(\);/.test(sec) &&
       sec.includes('next.querySelector(".ov-sum").focus({ preventScroll: true });') &&
       js.includes('if (e.key === "j") { step(1); e.preventDefault(); }'));
    ok("page: an opened group is its notes compacted: why and direction as paragraphs, file:line watch links, chips, file links; no caps labels",
       js.includes('n.why_risky ? el("p", { class: "nwhy" }, n.why_risky) : null,') && js.includes('lead ? null : el("p", { class: "ndir" }, n.direction),') &&
       js.includes('" — ", w.text);') && js.includes("lost ? null : fileLinks(files)") &&
       sec.includes('noteCard(n, { lead: i === 0 && !asking(n) && n.direction.trim() === headline,') &&
       !js.includes('class: "nlabel"') && !js.includes('"Why it is risky"') && !css.includes(".nlabel") && !css.includes(".nfield") &&
       /a\.wloc \{ font-family: var\(--mono\);/.test(css) && !/a\.gfile[^{]*\{[^}]*--mono/.test(css));
    ok("page: a group whose note waits on a question says so on its row, hides the note's words there, and opens to the quiz",
       sec.includes('ask ? el("span", { class: "ov-q",') && sec.includes('"? answer first"') &&
       sec.includes(': asking(first) ? "The note shows once its question is answered"') &&
       sec.includes("first && !asking(first) ? first.direction : null") &&
       /asking\(n\) \? quizBlock\(n\) : \[n\.quiz && n\.quiz\.answered \? quizBlock\(n\) : null, noteBody\(n, \{ lead \}\)\]/.test(js));
    ok("page: which groups are open survives a redraw and a reload: kept in memory and in sessionStorage per review, guarded",
       js.includes('const OV_OPEN = "lookout.ovopen." + R.id;') &&
       js.includes('const ovOpen = new Set((() => { try { return JSON.parse(sessionStorage.getItem(OV_OPEN) || "[]"); } catch { return []; } })());') &&
       js.includes("const saveOvOpen = () => { try { sessionStorage.setItem(OV_OPEN, JSON.stringify([...ovOpen])); } catch { /* private window */ } };") &&
       sec.includes("const isOpenNow = ovOpen.has(key);") && /isOpenNow \? ovOpen\.delete\(key\) : ovOpen\.add\(key\);\s*saveOvOpen\(\);/.test(sec));
    ok("page: openOverview(noteId) opens the group holding the note and scrolls it into view",
       /function openOverview\(noteId\) \{[\s\S]*?const key = n \? n\.group \|\| LOST : null;\s*if \(key && !ovOpen\.has\(key\)\) \{ ovOpen\.add\(key\); saveOvOpen\(\); \}\s*drawOverview\(\);[\s\S]*?sec\.scrollIntoView\(\{ block: "start" \}\);/.test(js));
    ok("page: low-risk groups without notes stay one line, and notes on files that left the diff are one more folded row",
       ov.includes('if (band === "low" && !ns.some(n => n.group === g.id)) continue;') && ov.includes("if (ns.some(n => !n.group)) list.append(ovSection(LOST));") &&
       ov.includes('`${plural(low.length, "low-risk group")} without notes: `') && sec.includes('const headline = lost ? "Notes on files no longer in the diff"'));
    // Opened, a note in that row still names its files (they left the diff,
    // so as plain names, not links); a toggle on a group a fresher review
    // dropped removes the row instead of inserting "null".
    ok("page: a note on files that left the diff names them when opened, and a dropped group's row goes on toggle",
       /const own = gone \|\| \(files && /.test(js) && js.includes('class: "gfile gone"') && js.includes("gone: lost })") &&
       js.includes("if (!next) { sec.remove(); return; }"));
  }
  // The PR (lookout gh sync's R.github): a strip, GitHub's threads as cards, and chips.
  ok("page: the PR strip has its own grid row under the banner, hidden until the review is linked",
     tpl.includes('<div id="banner" hidden></div>\n  <div id="pr" hidden></div>') &&
     css.includes('grid-template-areas: "top top" "banner banner" "pr pr" "side main";') && css.includes("#pr[hidden] { display: none; }") &&
     /function drawPR\(\) \{\s*const g = GH\(\), box = \$\("pr"\);[\s\S]{0,200}?if \(!g\) \{ box\.hidden = true;/.test(js) && js.includes("    drawPR();\n    postState();"));
  ok("page: the strip says how far the PR's head is past the review, offers Re-review only to its host, and lists checks failed first",
     js.includes('`${plural(g.behind, "commit")} past the review (${sha(g.reviewed)} → ${sha(g.head)})`') &&
     js.includes('postMessage({ lookout: "rereview", id: R.id }, hostOrigin)') && /const rereview = g\.behind > 0 && hosted/.test(js) &&
     js.includes("[...fails, ...pend, ...pass].map(c =>") && js.includes('"aria-controls": "pr-checks"'));
  ok("page: the narrow grid names the pr area, so the strip keeps its row at 760px and under",
     css.includes('grid-template-areas: "top" "banner" "pr" "side" "main"; }') && css.includes("grid-template-rows: auto auto auto auto 1fr;") &&
     /@media \(max-width: 760px\) \{ \.pr-checks \{ max-height: 20vh;/.test(css));
  ok("page: the checks button sits after the state and drift, says the worst news in words, and draws its marks as SVG",
     js.includes("drift, rereview, checks,") && js.includes('"aria-label": "Checks: " + said.join(", ")') &&
     js.includes('`${lead.length} ${kind === "fail" ? "failed" : kind === "pend" ? "running" : "passed"}`') &&
     js.includes('svg.setAttribute("class", "mk mk-" + kind); svg.setAttribute("aria-hidden", "true");') &&
     !/"[✓✗●▾]"/.test(js.slice(js.indexOf("function drawPR()"), js.indexOf("const openFindings = p =>"))) &&
     css.includes(".pr-checks-btn.ck-fail {"));
  ok("page: a check's workflow is dropped when the job's name already says it",
     js.includes('const checkName = c => c.workflow && !String(c.name).toLowerCase().startsWith(String(c.workflow).toLowerCase()) ? c.workflow + " / " + c.name : c.name;'));
  ok("page: stale reason, sync error and drift shas are said inline, not only in tooltips",
     js.includes('body && staleWhy(x) ? el("div", { class: "stale-why" + (prDone() ? " muted" : "") }, "Stale: " + staleWhy(x) + ".") : null,') &&
     js.includes('el("details", { class: "pr-err" },') && js.includes('el("div", { class: "pr-err-full" }, g.error)') &&
     css.includes(".pr-err summary {") && css.includes(".stale-why {"));
  ok("page: the strip's clock says GitHub, and its count of unposted items says not on GitHub",
     js.includes('"GitHub as of " + when(g.changedAt)') && js.includes('`${pending} not on GitHub`') && !js.includes('`${pending} pending`'));
  ok("page: the stale and not-on-GitHub counts are buttons that go to the next matching open item, round as n does",
     js.includes('el("button", { type: "button", class: "chip stale" + (done ? " muted" : ""), "data-pr": "stale", onclick: () => stepWhere(isStale),') &&
     js.includes('el("button", { type: "button", class: "chip pending", "data-pr": "pending", onclick: () => stepWhere(unposted),') &&
     /function stepWhere\(match\) \{[\s\S]*?goTo\(list\[\(i \+ 1\) % list\.length\]\.id\);/.test(js));
  ok("page: a strip redraw gives the focus back to the control that had it, by its data-pr key",
     js.includes('const key = had && had.getAttribute("data-pr");') &&
     /const back = key && \[\.\.\.box\.querySelectorAll\("\[data-pr\]"\)\]\.find\(e => e\.getAttribute\("data-pr"\) === key\);\s*if \(back\) back\.focus\(/.test(js) &&
     ['"data-pr": "checks"', '"data-pr": "rereview"', '"data-pr": "link"', '"data-pr": "err"'].every(k => js.includes(k)));
  ok("page: a hidden status line beside the strip says its counts when they change, not on the first draw",
     js.includes('el("div", { id: "pr-status", class: "sr", role: "status" })') && js.includes("box.after(status);") &&
     js.includes('if (prSaid != null && now !== prSaid) status.textContent = "PR #" + g.pr + ": " + now;'));
  ok("page: strip controls and a card's posted link stand 24px tall",
     css.includes(".pr-btn, .pr-checks-btn, .pr-row button.chip, a.chip { min-height: 24px; }"));
  ok("page: a merged or closed PR says nothing more goes to GitHub, counts nothing pending and mutes stale; unknown drift says why",
     js.includes('const done = st === "merged" || st === "closed";') && js.includes("const pending = done ? 0 :") &&
     js.includes('"nothing more goes to GitHub"') && css.includes(".chip.stale.muted {") &&
     js.includes('`drift unknown (${g.error ? "sync trouble" : "the PR\'s head is not fetched here"})`'));
  ok("page: on a merged or closed PR a card asks for nothing either: no pending chip, and its stale chip and why line are muted as in the strip",
     js.includes('const prDone = () => ["merged", "closed"].includes(String((GH() || {}).state || "").toLowerCase());') &&
     js.includes("const done = prDone();") && js.includes('class: "stale-why" + (prDone() ? " muted" : "")') && css.includes(".stale-why.muted {") &&
     js.includes('class: "chip stale" + (done ? " muted" : ""), title: why[0].toUpperCase()') &&
     js.includes('else if (isOpen(x) && !done) out.push(el("span", { class: "chip pending",'));
  ok("app: a merged or closed PR offers no Findings menu or Post, and the detail line says nothing more goes to GitHub",
     app.includes('const ended = !!g && ["merged", "closed"].includes(g.state.toLowerCase());') &&
     app.includes("if (g && rows.length && !ended) {") &&
     app.includes('else if (ended) say = `${parts.join(" · ")}. PR #${g.pr} is ${g.state.toLowerCase()}: nothing more goes to GitHub.'));
  ok("page: GitHub threads listed off their lines say why above the list",
     js.includes("ghOffLines(anch.outside),") && js.includes("if (!g || g.behind === 0 || !list.some(x => x.gh)) return null;") &&
     js.includes("off their lines: they sit on the PR's head,"));
  ok("page: GitHub threads are cards on their lines only while the review is at the PR's head; one a posted item began is that item's card",
     js.includes("line: g.behind === 0 ? t.line || t.originalLine : null,") &&
     js.includes("!mine.has(t.comments[0].id)") && js.includes("...ghItems()];") &&
     js.includes("body ? (x.gh ? ghOpen(x) : actions(x)) : null);") && js.includes("body && posted ? ghReplies(x) : null,"));
  ok("page: a posted card has two labelled parts: On GitHub (who posted it, GitHub's replies, resolved on GitHub) right under its body, then the replies only lookout holds; Reply says here and a link replies on GitHub",
     /body && posted \? ghReplies\(x\) : null,\s*body \? el\("div", \{ class: "msgs" \+ \(posted \? " local" : ""\) \}, local\.length && posted \? el\("div", \{ class: "local-head" \}, "In lookout only"\) : null, local\) : null,/.test(js) &&
     js.includes("const posted = !x.gh && !unposted(x);") &&
     js.includes('el("div", { class: "msg by-gh posted" }') && js.includes('"resolved on GitHub") : null') && !js.includes('"resolved there"') &&
     js.includes('const reply = posted ? "Reply here" : "Reply";') && js.includes('"Reply on GitHub ↗") : null;') &&
     (js.match(/\.\.\.closers, onGh\(\), status\)\);/g) || []).length === 2 &&
     /\.gh-head, \.local-head \{[^}]*padding: 0 10px;/.test(css) && /\.gh-replies \{[^}]*background: color-mix/.test(css) &&
     css.includes(".msg.by-gh .who { text-transform: none; }"));
  ok("page: a folded GitHub card says who began it, its replies and its latest time; GitHub's own threads draw comments as GitHub's",
     js.includes('return el("span", { class: "gh-meta" }, [c[0].author, n ? plural(n, "reply", "replies") : null, when(c[c.length - 1].at)].filter(Boolean).join(" · "));') &&
     js.includes("const local = x.gh ? x.gh.comments.slice(1).map(c => ghMessage(c)) : messages(thread, pill, folded).filter(Boolean);"));
  ok("page: pending is a filled to-do chip; posted, outdated and stale are outlined facts",
     /\.chip\.pending \{[^}]*background: color-mix/.test(css) && !/\.chip\.(outdated|posted|stale) \{[^}]*background/.test(css) &&
     !/\.chip\.outdated \{[^}]*dashed/.test(css));
  ok("page: a card says stale (with why), posted (linked) or pending, and GitHub's own outdated",
     js.includes('el("span", { class: "chip stale" + (done ? " muted" : ""), title: why[0].toUpperCase()') && js.includes('"posted ↗"') &&
     // A folded row is a button: its posted chip is words, not a link inside it.
     js.includes('if (!unposted(x)) out.push(link && !folded ? el("a",') && js.includes("const chips = prChips(x, foldedClosed(x) || foldedCard(x));") &&
     // A GitHub reply's author and time are its link, named for a screen reader; no bare arrow link.
     js.includes('el("a", { class: "gh-who", href: url, target: "_blank", rel: "noopener", "aria-label": `${author}${at}, open it on GitHub` }') &&
     js.includes('ghWho(c.author, " · " + when(c.at), ghUrl(c.url))') && !js.includes('" ↗") : null),') &&
     js.includes('el("span", { class: "chip pending",') && js.includes('el("span", { class: "chip outdated",') &&
     css.includes(".chip.stale {") && css.includes(".chip.pending {") && css.includes(".chip.posted {"));
  ok("page: only github.com links are drawn as links; the record is data",
     js.includes("const ghUrl = u => /^https:\\/\\/github\\.com\\//.test(String(u || \"\")) ? u : null;") &&
     !/href: (g\.url|c\.url|c\.link|x\.github\.url)\b/.test(js));
  ok("page: the host's focus op goes to a card, a GitHub comment (c<id>) or the checks list",
     js.includes('else if (d.op === "focus" && typeof d.item === "string") focusItem(d.item);') &&
     /function focusItem\(item\) \{\s*if \(item === "checks"\) \{ checksOpen = true; drawPR\(\);/.test(js) &&
     js.includes("const m = /^c(\\d+)$/.exec(item);"));
  ok("page: a GitHub sync redraws the page though updatedAt does not move",
     js.includes("if (j && (j.updatedAt !== R.updatedAt || ghAt(j) !== ghAt(R))) take(j);"));
  ok("page+app: framed, a GitHub link goes to the host, which opens only github.com through open_url; the tab's own links do too",
     js.includes('window.parent.postMessage({ lookout: "open", url }, hostOrigin);') && js.includes("const url = a && ghUrl(a.getAttribute(\"href\"));") &&
     app.includes('else if (d.lookout === "open") {') && app.includes('/^https:\\/\\/github\\.com\\//.test(url)) void invoke("open_url", { url })') &&
     app.includes(`closest?.('a[target="_blank"]')`) && app.includes('void invoke("open_url", { url: a.href })'));
  ok("page: GitHub's mark is drawn as SVG, no emoji", js.includes("function ghMark()") && js.includes('createElementNS("http://www.w3.org/2000/svg", "svg")'));
  ok("page: counts are real plurals, never \"(s)\"", !/[a-z]\(s\)[ `"')]/.test(js.replace("http(s)", "")) && js.includes('plural(s.files || 0, "file")'));
}

// ---------------------------------------------------------------- github
if (want("github: link, sync, staleness, post")) {
  const GHL = await import("./lib/github.mjs");
  const SV = await import("./lib/serve.mjs");
  const d = repo("gh-repo");
  sh(d, "git remote add origin https://github.com/o/r.git");
  sh(d, "git checkout -q -b feature");
  const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  write(d, "a.txt", lines(30));
  sh(d, `${G} add -A && ${G} commit -q -m one`);
  const one = sh(d, "git rev-parse HEAD").trim();
  const o = cli(d, "open", "--base", "main", "--no-open", "--json");
  ok("gh: a review opens on the branch", o.status === 0, o.stderr);
  const id = JSON.parse(o.stdout).id;
  const fpath = path.join(TMP, "gh-findings.json");
  fs.writeFileSync(fpath, JSON.stringify([
    { file: "a.txt", line: 3, severity: "major", summary: "near the change", failure_scenario: "x" },
    { file: "a.txt", line: 20, severity: "minor", summary: "far from it", failure_scenario: "y" }]));
  const fa = cli(d, "findings", "add", id, fpath);
  ok("gh: findings ingest", fa.status === 0, fa.stderr);
  ok("gh: a finding records the head it was read on", S.read(id).findings.every(f => f.at === one));

  write(d, "a.txt", lines(30).replace("line 4\n", "line four\n"));
  sh(d, `${G} commit -q -am two`);
  const two = sh(d, "git rev-parse HEAD").trim();
  const view = { number: 7, url: "https://github.com/o/r/pull/7", state: "OPEN", isDraft: false, title: "t", headRefName: "feature", headRefOid: two };
  const threads = { data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { id: "PRRT_1", path: "a.txt", line: 9, originalLine: 9, diffSide: "RIGHT", isOutdated: false, isResolved: false,
      comments: { nodes: [{ databaseId: 501, author: { login: "alice" }, body: "why?", createdAt: "2026-11-01T00:00:00Z", url: "https://github.com/o/r/pull/7#discussion_r501" }] } },
    { id: "PRRT_2", path: "a.txt", line: null, originalLine: 2, diffSide: "LEFT", isOutdated: true, isResolved: true, comments: { nodes: [] } }] } } } } };
  const checks = [{ name: "test", state: "FAILURE", bucket: "fail", link: "https://github.com/o/r/actions/runs/1/job/2", workflow: "ci", startedAt: "2026-11-01T00:00:00Z", completedAt: "2026-11-01T00:05:00Z" },
                  { name: "lint", state: "SUCCESS", bucket: "pass", link: "", workflow: "ci", startedAt: "", completedAt: "" }];
  const map = {
    "pr view feature --json": { stdout: view }, "pr view 7 -R o/r --json": { stdout: view },
    "api graphql": { stdout: threads }, "pr checks 7 -R o/r": { stdout: JSON.stringify(checks), status: 1 },
    "api user": { stdout: "probe-user\n" },
  };
  const setMap = m => fs.writeFileSync(ENV.FAKE_GH_MAP, JSON.stringify(m));
  setMap(map);
  const sy = cli(d, "gh", "sync", id, "--json");
  const g = S.read(id).github || {};
  ok("gh: sync links the review to the branch's PR", g.repo === "o/r" && g.pr === 7 && g.head === two, sy.stdout + sy.stderr);
  ok("gh: threads keep side, outdated and resolved", g.threads.length === 2 && g.threads[0].side === "new" && g.threads[1].side === "old" &&
     g.threads[1].outdated && g.threads[1].resolved && g.threads[0].comments[0].author === "alice", JSON.stringify(g.threads));
  ok("gh: checks parse even when gh exits non-zero for a failed one", g.checks.length === 2 && g.checks[0].bucket === "fail" && g.checks[0].link, JSON.stringify(g.checks));
  ok("gh: the viewer is known, so others' comments can be told apart", g.viewer === "probe-user");
  ok("gh: one commit past the review", g.behind === 1 && g.reviewed === one, String(g.behind));
  const [f1, f2] = S.read(id).findings;
  ok("gh: a finding beside the changed line is stale", !!g.stale[f1.id], JSON.stringify(g.stale));
  ok("gh: a finding far from it is not", !g.stale[f2.id]);

  const again = cli(d, "gh", "sync", id, "--json");
  ok("gh: a second sync moments later is skipped", /moments ago/.test(again.stdout), again.stdout);
  const before = S.read(id).updatedAt;
  const quiet = JSON.parse(cli(d, "gh", "sync", id, "--force", "--json").stdout);
  ok("gh: nothing new on GitHub leaves the record unwritten", quiet.changed === false && S.read(id).updatedAt === before, JSON.stringify(quiet));

  setMap({ ...map, "api graphql": { status: 1, stderr: "GraphQL: API rate limit exceeded for user" } });
  cli(d, "gh", "sync", id, "--force", "--json");
  ok("gh: a rate limit is recorded and backed off", /rate limit/i.test(S.read(id).github.error || "") &&
     JSON.parse(fs.readFileSync(ENV.LOOKOUT_GH_STATE, "utf8"))[id].backoffUntil > Date.now(), S.read(id).github.error);
  const st = JSON.parse(fs.readFileSync(ENV.LOOKOUT_GH_STATE, "utf8")); st[id].at = 0; fs.writeFileSync(ENV.LOOKOUT_GH_STATE, JSON.stringify(st));
  ok("gh: while backing off, a sync asks nothing", /backing off/.test(cli(d, "gh", "sync", id, "--json").stdout));
  ok("gh: the threads seen before the limit are kept", S.read(id).github.threads.length === 2);

  // Posting: one review pinned to the commit read, and each comment's id kept.
  const body = GHL.commentText(f1);
  setMap({ ...map, "api -X POST repos/o/r/pulls/7/reviews": { stdout: { id: 55, html_url: "https://github.com/o/r/pull/7#pullrequestreview-55" } },
    "api repos/o/r/pulls/7/reviews/55/comments?per_page=100&page=1": { stdout: JSON.stringify([{ id: 901, path: "a.txt", line: 3, body, html_url: "https://github.com/o/r/pull/7#discussion_r901" }]) } });
  fs.rmSync(ENV.FAKE_GH_LOG, { force: true });
  const po = cli(d, "gh", "post", id, f1.id, "--intro", "Lookout review (high depth): 1 finding(s).");
  ok("gh: post succeeds", po.status === 0, po.stderr);
  const sent = fs.readFileSync(ENV.FAKE_GH_LOG, "utf8").trim().split("\n").map(l => JSON.parse(l)).find(x => x.argv.includes("POST"));
  const payload = sent ? JSON.parse(sent.input) : {};
  ok("gh: the review is pinned to the commit the finding was read on", payload.commit_id === one && payload.comments[0].path === "a.txt" &&
     payload.comments[0].line === 3 && payload.comments[0].side === "RIGHT" && payload.body.startsWith("Lookout review (high"), JSON.stringify(payload));
  const pf = S.read(id).findings[0].github || {};
  ok("gh: the posted finding keeps its comment id and links", pf.commentId === 901 && /discussion_r901/.test(pf.url) && /review-55/.test(pf.reviewUrl), JSON.stringify(pf));
  const twice = cli(d, "gh", "post", id, f1.id);
  ok("gh: posting it again is refused without --again", twice.status !== 0 && /already posted/.test(twice.stderr), twice.stderr);
  setMap({ ...map, "api -X POST repos/o/r/pulls/7/reviews": { status: 1, stderr: "gh: Unprocessable Entity (HTTP 422)" } });
  const p422 = cli(d, "gh", "post", id, f2.id, f2.id);
  ok("gh: a refused line ends in an error, not a silent success", p422.status !== 0, p422.stdout);
  const sends = fs.readFileSync(ENV.FAKE_GH_LOG, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(x => x.argv.includes("POST"));
  const last = JSON.parse(sends[sends.length - 1].input);
  ok("gh: a 422 is retried with every item folded into the body", !last.comments && last.body.includes("`a.txt:20`"), JSON.stringify(last));
  ok("gh: an id named twice is posted once", last.body.split("`a.txt:20`").length === 2, last.body);
  ok("gh: the threads query sends the owner and name as strings", fs.readFileSync(ENV.FAKE_GH_LOG, "utf8").includes('"-f","owner=o","-f","name=r"') ||
     JSON.parse(fs.readFileSync(ENV.LOOKOUT_GH_STATE, "utf8"))._viewer.login === "probe-user");
  ok("gh: the login is cached under a key no review id can take", JSON.parse(fs.readFileSync(ENV.LOOKOUT_GH_STATE, "utf8"))._viewer.login === "probe-user");
  ok("gh: a --pr naming the saved PR in another case is not a switch",
     !GHL.switching({ prRef: "O/R#7", github: { repo: "o/r", pr: 7 } }) && GHL.switching({ prRef: "o/r#8", github: { repo: "o/r", pr: 7 } }));
  ok("gh: a 403 alone is a permission error, not a rate limit",
     !GHL.limited({ status: 1, err: "HTTP 403: Resource not accessible by integration" }) && GHL.limited({ status: 1, err: "API rate limit exceeded" }));

  // Threads past the first page are followed.
  const page = (nodes, next) => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !!next, endCursor: next || null }, nodes } } } } });
  const th = (i, more) => ({ id: "PRRT_p" + i, path: "a.txt", line: 9, originalLine: 9, diffSide: "RIGHT", isOutdated: false, isResolved: false,
    comments: { totalCount: more ? 101 : 1, nodes: [{ databaseId: 600 + i, author: { login: "bob" }, body: "b", createdAt: "", url: "" }] } });
  setMap({ ...map, "api graphql -f owner=o -f name=r -F n=7 -f": { stdout: JSON.stringify(page([th(1, true)], "C1")) },
    "api graphql -f owner=o -f name=r -F n=7 -f after=C1": { stdout: JSON.stringify(page([th(2)], null)) } });
  fs.rmSync(ENV.FAKE_GH_LOG, { force: true });
  cli(d, "gh", "sync", id, "--force");
  const pg = S.read(id).github.threads;
  ok("gh: a second page of threads is read", pg.length === 2 && pg[1].id === "PRRT_p2", JSON.stringify(pg.map(t => t.id)));
  ok("gh: comments past a thread's first hundred are counted", pg[0].more === 100);
  ok("gh: the names went as strings (-f), the number as a number (-F)", /"-f","owner=o","-f","name=r","-F","n=7"/.test(fs.readFileSync(ENV.FAKE_GH_LOG, "utf8")));

  // The delivery review's fixes.
  const readSt = () => JSON.parse(fs.readFileSync(ENV.LOOKOUT_GH_STATE, "utf8"));
  const writeSt = st => fs.writeFileSync(ENV.LOOKOUT_GH_STATE, JSON.stringify(st));
  const typo = cli(d, "gh", "post", id, "f1", "f3x");
  ok("gh: a word that names no item is refused, so nothing posts short", typo.status !== 0 && /f3x/.test(typo.stderr), typo.stderr);
  // A sync is not activity: updatedAt stays, changedAt moves.
  setMap({ ...map, "pr checks 9 -R o/r": { stdout: "[]" }, "pr view 9": { stdout: { ...view, number: 9, url: "https://github.com/o/r/pull/9" } },
    "pr checks 7 -R o/r": { stdout: JSON.stringify([...checks, { name: "new", bucket: "pending", state: "PENDING", link: "", workflow: "ci", startedAt: "", completedAt: "" }]), status: 8 } });
  const upd0 = S.read(id).updatedAt, ch0 = (S.read(id).github || {}).changedAt;
  cli(d, "gh", "sync", id, "--force");
  ok("gh: what GitHub says moves github.changedAt, not the review's updatedAt", S.read(id).updatedAt === upd0 && S.read(id).github.changedAt !== ch0,
     `${upd0} ${S.read(id).updatedAt}`);
  // Two items read on different heads go as two reviews, each pinned to its own.
  const posts = () => fs.readFileSync(ENV.FAKE_GH_LOG, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(x => x.argv.includes("POST")).map(x => JSON.parse(x.input));
  S.update(id, cur => { const [a1, a2] = cur.findings; delete a1.github; delete a2.github; a2.at = two; return cur; });
  fs.rmSync(ENV.FAKE_GH_LOG, { force: true });
  const big = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, path: "z.txt", line: 1, body: "other", html_url: "" }));
  setMap({ ...map, "api -X POST repos/o/r/pulls/7/reviews": { stdout: { id: 55, html_url: "https://github.com/o/r/pull/7#pullrequestreview-55" } },
    "api repos/o/r/pulls/7/reviews/55/comments?per_page=100&page=1": { stdout: JSON.stringify(big) },
    "api repos/o/r/pulls/7/reviews/55/comments?per_page=100&page=2": { stdout: JSON.stringify([
      { id: 901, path: "a.txt", line: 3, body: GHL.commentText(S.read(id).findings[0]), html_url: "u1" },
      { id: 902, path: "a.txt", line: 20, body: GHL.commentText(S.read(id).findings[1]), html_url: "u2" }]) } });
  const two_ = cli(d, "gh", "post", id, "f1", "f2");
  const sent2 = posts();
  ok("gh: items read on different heads go as one review per head", two_.status === 0 && sent2.length === 2 &&
     sent2.map(p => p.commit_id).sort().join() === [one, two].sort().join(), two_.stderr + JSON.stringify(sent2.map(p => p.commit_id)));
  ok("gh: a review's comments past the first hundred are read for their ids", S.read(id).findings[0].github.commentId === 901 &&
     S.read(id).findings[1].github.commentId === 902, JSON.stringify(S.read(id).findings.map(f => f.github)));
  // A folded retry pins the PR's head (the item's own commit may be gone),
  // and a post that fails outright marks nothing posted.
  S.update(id, cur => { for (const f of cur.findings) delete f.github; cur.findings[1].at = two; return cur; });
  fs.rmSync(ENV.FAKE_GH_LOG, { force: true });
  setMap({ ...map, "api -X POST repos/o/r/pulls/7/reviews": { status: 1, stderr: "HTTP 422 Unprocessable Entity" } });
  const fold = cli(d, "gh", "post", id, "f2");
  const fsent = posts();
  ok("gh: a folded retry is pinned to the PR's head", fsent.length === 2 && fsent[1].commit_id === two && !fsent[1].comments, JSON.stringify(fsent.map(p => p.commit_id)));
  ok("gh: a post that fails outright marks nothing posted", fold.status !== 0 && !S.read(id).findings[1].github);

  // An item read on a commit the checkout no longer has is stale.
  S.update(id, cur => { cur.findings[1].at = "0".repeat(40); return cur; });
  setMap(map);
  cli(d, "gh", "sync", id, "--force");
  ok("gh: an item read on a commit that is gone is stale, saying why", /gone/.test((S.read(id).github.stale || {}).f2 || ""), JSON.stringify(S.read(id).github.stale));
  // A closed PR is looked at again when its page is in view, or a day on.
  setMap({ ...map, "pr view 7 -R o/r --json": { stdout: { ...view, state: "CLOSED" } } });
  cli(d, "gh", "sync", id, "--force");
  let st4 = readSt(); st4[id].at = Date.now() - 60 * 60 * 1000; delete st4[id].backoffUntil; writeSt(st4);
  ok("gh: unseen, a closed PR is left alone for a day", /closed/.test(cli(d, "gh", "sync", id, "--json").stdout));
  setMap({ ...map, "pr view 7 -R o/r --json": { stdout: { ...view, state: "OPEN" } } });
  st4 = readSt(); st4[id].at = Date.now() - 60 * 60 * 1000; writeSt(st4);
  cli(d, "gh", "sync", id, "--visible");
  ok("gh: with its page in view, a reopened PR is seen open again", S.read(id).github.state === "OPEN");
  // An idle review in view is synced too.
  S.withLock(id, () => { const cur = S.read(id); cur.updatedAt = "2020-01-01T00:00:00Z"; S.writeAtomic(S.paths(id).json, JSON.stringify(cur)); });
  st4 = readSt(); st4[id].at = Date.now() - 60 * 60 * 1000; writeSt(st4);
  ok("gh: unseen, an idle review is left alone", /idle/.test(cli(d, "gh", "sync", id, "--json").stdout));
  st4 = readSt(); st4[id].at = Date.now() - 60 * 60 * 1000; writeSt(st4);
  ok("gh: in view, an idle review syncs", !/skipped/.test(cli(d, "gh", "sync", id, "--visible").stdout));
  ok("gh: the page server's sync says the page is in view", fs.readFileSync(path.join(HERE, "lib", "serve.mjs"), "utf8").includes('[cli, "gh", "sync", id, "--visible"]'));
  ok("gh: a review whose checkout is gone says so, not that gh is missing",
     /checkout is gone/.test(GHL.gh(["pr", "view"], { cwd: path.join(TMP, "no-such-dir") }).error || ""));
  S.update(id, cur => { cur.updatedAt = new Date().toISOString(); return cur; });

  // A --pr given on a re-open wins over the PR a sync saved.
  setMap({ ...map, "pr view 9": { stdout: { ...view, number: 9, url: "https://github.com/o/r/pull/9" } },
    "pr checks 9 -R o/r": { stdout: "[]" } });
  S.update(id, cur => { cur.prRef = "9"; return cur; });
  cli(d, "gh", "sync", id, "--force");
  ok("gh: a newer --pr is followed, not the saved PR", S.read(id).github.pr === 9, String(S.read(id).github.pr));

  // A merged PR had its last sync: later ones ask nothing unless forced.
  setMap({ ...map, "pr view 9": { stdout: { ...view, number: 9, state: "MERGED", url: "https://github.com/o/r/pull/9" } },
    "pr checks 9 -R o/r": { stdout: "[]" } });
  cli(d, "gh", "sync", id, "--force");
  const st2 = JSON.parse(fs.readFileSync(ENV.LOOKOUT_GH_STATE, "utf8")); st2[id].at = Date.now() - 60 * 60 * 1000; delete st2[id].backoffUntil; fs.writeFileSync(ENV.LOOKOUT_GH_STATE, JSON.stringify(st2));
  const msync = cli(d, "gh", "sync", id, "--json").stdout;
  ok("gh: a merged PR is not synced again unless forced", S.read(id).github.state === "MERGED" && /merged/.test(msync),
     S.read(id).github.state + " " + msync + " " + JSON.stringify(st2[id]));

  // A re-open with another --pr switches even from a merged PR, and a failed
  // read on the new PR does not carry the old one's threads over.
  S.update(id, cur => { cur.prRef = "11"; return cur; });
  setMap({ ...map, "pr view 11": { stdout: { ...view, number: 11, url: "https://github.com/o/r/pull/11" } },
    "api graphql": { status: 1, stderr: "GraphQL: Something went wrong" }, "pr checks 11 -R o/r": { stdout: "[]" } });
  const st3 = JSON.parse(fs.readFileSync(ENV.LOOKOUT_GH_STATE, "utf8")); st3[id].at = 0; fs.writeFileSync(ENV.LOOKOUT_GH_STATE, JSON.stringify(st3));
  cli(d, "gh", "sync", id);
  const g11 = S.read(id).github;
  ok("gh: a --pr switch is followed by an unforced sync, even from a merged PR", g11.pr === 11, String(g11.pr));
  ok("gh: a failed read on the new PR keeps none of the old PR's threads", g11.threads.length === 0 && /threads/.test(g11.error || ""), JSON.stringify(g11.threads.map(t => t.id)));

  // Items from before `at` existed keep the head they were read on when a
  // re-open moves the review to a newer one.
  S.update(id, cur => { for (const f of cur.findings) delete f.at; return cur; });
  const reo = cli(d, "open", "--base", "main", "--no-open", "--id", id);
  ok("gh: a re-open stamps old findings with the head they were read on", reo.status === 0 &&
     S.read(id).findings.every(f => f.at === one) && S.read(id).source.head === two, reo.stderr);

  // A patch review has no branch to ask about: nothing goes to gh.
  const pd = path.join(TMP, "gh-p.patch");
  fs.writeFileSync(pd, sh(d, "git diff main feature"));
  const op = JSON.parse(cli(TMP, "open", "--patch", pd, "--no-open", "--json").stdout);
  fs.rmSync(ENV.FAKE_GH_LOG, { force: true });
  const ps = JSON.parse(cli(TMP, "gh", "sync", op.id, "--json").stdout);
  ok("gh: a patch review is not linked, and asks gh nothing", ps.linked === false && !fs.existsSync(ENV.FAKE_GH_LOG), JSON.stringify(ps));
  const bad = cli(d, "open", "--base", "main", "--no-open", "--pr", "not-a-pr");
  ok("gh: an unreadable --pr is refused", bad.status !== 0 && /--pr/.test(bad.stderr));

  ok("gh: PR refs read in every pasted form", JSON.stringify(["12", "#12", "o/r#12", "https://github.com/o/r/pull/12/files"].map(GHL.parsePrRef)) ===
     JSON.stringify([{ repo: "", pr: 12 }, { repo: "", pr: 12 }, { repo: "o/r", pr: 12 }, { repo: "o/r", pr: 12 }]));
  const rg = GHL.changedRanges("@@ -4 +4 @@\n-a\n+b\n@@ -10,0 +11,2 @@\n+c\n");
  ok("gh: hunks read as old-side ranges, an insertion after its line", JSON.stringify(rg) === "[[4,4],[10,11]]", JSON.stringify(rg));
  ok("gh: within three lines counts as touched", GHL.touches(rg, 1) && !GHL.touches(rg, 0) && GHL.touches(rg, 14) && !GHL.touches(rg, 15));

  // The page server asks for a sync on a visible poll, at most once a minute.
  const kicked = [];
  const k = SV.ghKicker(i => kicked.push(i), 60000);
  ok("gh: the kicker runs once per review per minute", k("a", 1000) && !k("a", 30000) && k("b", 30000) && k("a", 62000) && kicked.join() === "a,b,a");
  const asked = [];
  const srv = SV.makeServer({ version: "t", root: TMP, token: "tok", kick: i => asked.push(i) });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const get = q => new Promise(r => http.get({ host: "127.0.0.1", port, path: `/review/${id}.json?t=tok${q}`, headers: { host: `127.0.0.1:${port}` } },
    res => { res.resume(); res.on("end", () => r(res.statusCode)); }));
  const c1 = await get("&bg=1"), c2 = await get("");
  srv.close();
  ok("gh: a hidden tab's poll asks for no sync; a visible one does", c1 === 200 && c2 === 200 && asked.join() === id, asked.join());
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`lookout probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
