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
  // Authoritative and empty: no TypeSafe client, so no open in the probe can
  // reach the network. The scoring block below points it at a mock.
  LOOKOUT_TYPESAFE_CLIENT: "",
};
delete ENV.TYPESAFE_BASE_URL;
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

// ---------------------------------------------------------------- risk + groups
{
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
{
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
  const bs = cli(R4, "prompt", id).stdout;
  ok("prompt: standalone has no plan section and names the prior findings", !/plan increment it implements/.test(bs) &&
     /already has 3 finding/.test(bs));
  const page = fs.readFileSync(S.paths(id).html, "utf8");
  ok("page: findings and threads are in the drawn page", page.includes("b is wrong") && page.includes("why 2?"));
}

// ---------------------------------------------------------------- notes, edges, quiz
{
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
{
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
  ok("hook: each message is delivered once", hook(R7).stdout === "");
  S.update(id, cur => { FD.reply(cur, "t1", "and also this", "human"); return cur; });
  const again = hook(R7, "SessionStart").stdout;
  ok("hook: only what is new since the last prompt", again.includes("1 new") && again.includes("and also this") && !again.includes("why 2"));
  ok("hook: a session elsewhere hears nothing", (S.update(id, cur => { FD.reply(cur, "t1", "x", "human"); return cur; }), hook(TMP).stdout === ""));
  const none = spawnSync("bash", [path.join(HERE, "hooks", "comments.sh")],
    { encoding: "utf8", env: { ...ENV, LOOKOUT_REVIEWS_DIR: path.join(TMP, "empty-reviews") }, input: "{}" });
  ok("hook: no reviews at all costs a glob and exits clean", none.status === 0 && none.stdout === "");
  ok("hook: garbage on stdin never fails the prompt",
     spawnSync("bash", [path.join(HERE, "hooks", "comments.sh")], { encoding: "utf8", env: ENV, input: "{not json" }).status === 0);

  // sync re-ranks after a page close: a resolved major stops lifting its file.
  S.update(id, cur => { FD.setStatus(cur, "f1", "open", "human"); return cur; });
  cli(R7, "sync", id);
  const before = S.read(id).files[0].risk;
  S.update(id, cur => { FD.setStatus(cur, "f1", "resolved", "human"); return cur; });
  cli(R7, "sync", id);
  ok("sync: re-ranks after a close made outside the CLI", S.read(id).files[0].risk < before);
  const page = fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8");
  ok("page: has the served mode (serve, polling, POST)", /function serve\(/.test(page) && page.includes('method: "POST"') &&
     page.includes(".json?t="));
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
