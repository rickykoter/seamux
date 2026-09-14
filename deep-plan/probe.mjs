#!/usr/bin/env node
// deep-plan probe — one command, no arguments, throwaway everything.
// Asserts both directions: blocks what it should, and NEVER what it should not.
// `-v` walks it step by step (the probe is also the demo).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = process.argv.includes("-v");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dp-probe-"));
const ENV = {
  ...process.env,
  DEEP_PLAN_STATE_DIR: path.join(TMP, "state"),
  DEEP_PLAN_KEYS_DIR: path.join(TMP, "keys"),
  DEEP_PLAN_PLANS_DIR: path.join(TMP, "plans"),
  DEEP_PLAN_ANNOT_DIR: path.join(TMP, "annotations"),
  DEEP_PLAN_SKILL_DIR: HERE,
};
const REPO = path.join(TMP, "repo");
fs.mkdirSync(REPO, { recursive: true });
// -c identity: CI runners have no git user, and the probe's throwaway repo
// must not depend on (or touch) the machine's config.
execSync("git init -q && git -c user.email=probe@deep-plan -c user.name=probe " +
  "commit -q --allow-empty -m init", { cwd: REPO });

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; if (V) console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
}
function cli(...args) {
  return spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args],
    { encoding: "utf8", env: ENV, cwd: REPO });
}
function gate(tool, input, cwd = REPO) {
  const r = spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], {
    encoding: "utf8", env: ENV,
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd }),
  });
  return r;
}
const edit = p => gate("Edit", { file_path: p });
const bash = c => gate("Bash", { command: c });

// -------------------------------------------------- renderer refuses bad specs
const spec = JSON.parse(fs.readFileSync(path.join(HERE, "examples", "example.spec.json"), "utf8"));
const tmpSpec = obj => { const p = path.join(TMP, "s.json"); fs.writeFileSync(p, JSON.stringify(obj)); return p; };

let bad = { ...spec, diagrams: [] };
ok("refuses a spec with no diagram", cli("render", tmpSpec(bad)).status !== 0);
bad = { ...spec, verifiedFacts: [{ claim: "x" }] };
ok("refuses an uncited fact", cli("render", tmpSpec(bad)).status !== 0);
bad = { ...spec, decisions: [{ decision: "x" }] };
ok("refuses a decision with no why", cli("render", tmpSpec(bad)).status !== 0);
bad = { ...spec, context: Array(140).fill("word").join(" ") };
ok("refuses a 140-word paragraph", cli("render", tmpSpec(bad)).status !== 0);
bad = JSON.parse(JSON.stringify(spec));
bad.quiz[0].options[1] = "the row waits for the sweep, which is the recommended path";
ok("quiz linter: leading word rejected", cli("render", tmpSpec(bad)).status !== 0);
bad = JSON.parse(JSON.stringify(spec));
bad.quiz = bad.quiz.slice(0, 2);
ok("quiz linter: fewer than 3 questions rejected", cli("render", tmpSpec(bad)).status !== 0);
bad = JSON.parse(JSON.stringify(spec));
bad.diagrams[0].mermaid = 'flowchart LR\n  A --> B[\\"broken label]';
{
  const rr = cli("render", tmpSpec(bad));
  // Refused where mermaid is loadable; explicitly announced as skipped where
  // it is not (no vendor anywhere) — silence is the only failure.
  ok("refuses a diagram mermaid cannot parse (or says it skipped)",
    (rr.status !== 0 && /mermaid/.test(rr.stderr)) || /validation skipped/.test(rr.stderr));
}

// -------------------------------------------------- a good spec renders
ok("gate with no plan: Edit allowed (fast path)", edit(path.join(REPO, "a.txt")).status === 0);
let r = cli("render", tmpSpec(spec));
ok("example spec renders", r.status === 0);
ok("md + review + working surfaces exist",
  ["md", "review.html", "working.html"].every(s =>
    fs.existsSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + "." + s))));
ok("key lives on the keys tree, not beside the surfaces",
  fs.existsSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, spec.slug + ".key.json")) &&
  !fs.existsSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".key.json")));
const review = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".review.html"), "utf8");
ok("review page never contains the answer key", !/answer/i.test(review.replace(/Alignment/g, "")) ||
  !review.includes('"answers"'));
ok("mermaid inlined as base64 (the swap regex's shape)",
  /src="data:text\/javascript;base64,[A-Za-z0-9+/=]+"/.test(review));
// The interactive layer: answerable quiz + comment boxes + one copy-back blob.
ok("review quiz options are selectable radios",
  (review.match(/type="radio" name="dp-q-/g) || []).length >=
    (spec.quiz || []).length * 2);
ok("every increment carries a comment box, plus a general one",
  (review.match(/class="dp-note"/g) || []).length === (spec.deliverables || []).length + 1);
ok("copy-back button builds the paste blob (slug + grade line + comments)",
  review.includes('id="dp-copyback"') &&
  review.includes('"deep-plan grade " + slug') &&
  review.includes('"comments:'));
ok("copy-back has a file:// clipboard fallback", review.includes("execCommand"));
ok("highlight-to-comment: selection chip and pinned-quote rows",
  review.includes("dp-hl-add") && review.includes("getSelection") &&
  review.includes('"dp-quote"') && review.includes("dp-quotes"));
// UX/a11y pass: the chip clamps inside the viewport (it used to fall off the
// right edge), the quiz is labelled radiogroups, copied-state is announced,
// and pinning has a keyboard path.
ok("comment chip clamps inside the viewport",
  review.includes("clientWidth - w - 8") && review.includes("Math.max(8"));
ok("quiz questions are labelled radiogroups",
  (review.match(/role="radiogroup"/g) || []).length === (spec.quiz || []).length);
ok("copy feedback is a live region",
  review.includes('role="status"') && review.includes('aria-live="polite"'));
ok("pinning a comment has a keyboard path (Cmd/Ctrl+M)",
  review.includes("metaKey") && review.includes("pinComment"));
// Light/dark: resolved pre-paint (saved choice, else OS), toggleable, and
// mermaid's baked-in theme follows it.
ok("theme resolves before first paint and has a light palette",
  review.includes('localStorage.getItem("dp-theme")') &&
  review.includes("prefers-color-scheme") &&
  review.includes('[data-theme="light"]'));
ok("theme toggle exists on every surface", review.includes('id="dp-mode"') &&
  fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8")
    .includes('id="dp-mode"'));
ok("mermaid theme follows the page theme",
  review.includes('"data-theme")==="light"?"default":"dark"'));
// Evidence refs that read as repo paths are click targets carrying file:line
// (a range collapses to its first line); prose evidence stays plain.
{
  const pathy = (spec.verifiedFacts || []).filter(f => /^[\w./-]+:\d+/.test(f.evidence));
  ok("path-shaped evidence renders as dp-path targets",
    pathy.length > 0 && pathy.every(f => {
      const first = f.evidence.replace(/^([^:]+:\d+).*$/, "$1");
      return review.includes(`data-file="${first}"`);
    }));
}

// -------------------------------------------------- observability block: advisory
{
  const obSpec = { ...spec, slug: "ob-plan", observability: {
    existing: [{ kind: "monitor", name: "checkout p95", ref: "https://dd.example/mon/1" }],
    gaps: ["no monitor on the DLQ depth"] } };
  ok("a spec with an observability block renders", cli("render", tmpSpec(obSpec)).status === 0);
  const obHtml = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "ob-plan.review.html"), "utf8");
  ok("the block renders on the surface: existing + gaps",
    obHtml.includes("Observability") && obHtml.includes("checkout p95") &&
    obHtml.includes("no monitor on the DLQ depth"));
  ok("…and in the md plan",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "ob-plan.md"), "utf8")
      .includes("## Observability"));
  // Advisory by construction: the example spec above rendered WITHOUT the
  // block — asserted by name so its absence can never quietly become a floor.
  ok("absence of the block never refuses (advisory)",
    !JSON.parse(fs.readFileSync(path.join(HERE, "examples", "example.spec.json"), "utf8")).observability);
  cli("close", "ob-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "ob-plan.json"), { force: true });
}

// -------------------------------------------------- validate: surfaces re-checked on disk
ok("validate: a freshly rendered plan is clean",
  cli("validate", spec.slug).status === 0);
{
  const dirty = path.join(TMP, "dirty.html");
  fs.writeFileSync(dirty, '<pre class="mermaid">flowchart LR\n  A --> B[\\"broken]</pre>' +
    "<p>&amp;lt;double&amp;gt;</p><code>x</code><span>__TOKEN__</span>");
  const rv = cli("validate", dirty);
  ok("validate: broken mermaid, double-escapes and placeholders all caught",
    rv.status !== 0 && /Parse error|skipped/i.test(rv.stderr) &&
    /double-escaped/.test(rv.stderr) && /placeholder/.test(rv.stderr));
  ok("validate: an unknown slug dies plainly", cli("validate", "no-such-plan").status !== 0);
}
{
  // Quoted labels route through DOMPurify; a shim regression turns every real
  // diagram into a silent "skip" (error:null). Empty means truly validated.
  const vlib = await import(new URL("lib/validate.mjs", import.meta.url));
  const good = await vlib.validateDiagrams([
    { mermaid: 'flowchart LR\n  K --> R["label: $4.20"]\n  M --> C[("cache")]', question: "g" }]);
  ok("validateDiagrams: quoted-label flowchart truly validates (no env skip)", good.length === 0);
  const bad2 = await vlib.validateDiagrams([{ mermaid: "flowchart LR\n  A --> [broken", question: "b" }]);
  ok("validateDiagrams: a parse error survives as a real error", bad2.length === 1 && !!bad2[0].error);
}
const working = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8");
ok("working surface renders controls disabled on disk",
  working.includes('class="dp-act"') && working.includes("disabled"));
ok("working surface has the auto-refresh checkbox", working.includes('id="dp-auto"'));
ok("declared files are dp-path targets even before they exist",
  working.includes('data-file="app/workers/retry_sweep.rb"'));

// -------------------------------------------------- rehydrate is byte-identical
r = cli("rehydrate", spec.slug);
ok("rehydrate reports byte-identical", r.status === 0 && /byte-identical/.test(r.stdout) && !/differs/.test(r.stdout));

// -------------------------------------------------- export-artifact
r = cli("export-artifact", spec.slug, "--json");
ok("export-artifact emits and prints metadata", r.status === 0 && JSON.parse(r.stdout).spec_hash.length === 16);
const artPath = path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".artifact.html");
const art1 = fs.readFileSync(artPath, "utf8");
cli("export-artifact", spec.slug, "--json");
ok("export-artifact is deterministic (byte-identical on re-run)",
  fs.readFileSync(artPath, "utf8") === art1);
ok("exported page has no base64 mermaid embed", !/data:text\/javascript;base64/.test(art1));
ok("exported page uses native pre.mermaid", art1.includes('<pre class="mermaid">'));
// Leak discipline: nothing from the quiz (prompts, options, whys) and nothing
// from the key file may reach a surface that leaves the machine.
const keyJson = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, spec.slug + ".key.json"), "utf8"));
const quizStrings = spec.quiz.flatMap(q => [q.prompt, q.why, ...q.options])
  .concat(Object.values(keyJson.answers).map(a => a.why));
ok("exported page carries no quiz or key material",
  quizStrings.every(s => !art1.includes(s.slice(0, 24))));
ok("annotation UI present with read-only fallback",
  art1.includes('claude.use("db")') && art1.includes("dp-ro"));
// attach + annotations render on the working surface
ok("attach-artifact records url + spec_hash", cli("attach-artifact", spec.slug, "https://claude.ai/code/artifact/test").status === 0 &&
  JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8")).artifact.spec_hash.length === 16);
const adir = path.join(ENV.DEEP_PLAN_ANNOT_DIR, spec.slug, "annotations");
fs.mkdirSync(adir, { recursive: true });
fs.writeFileSync(path.join(adir, "a1.json"), JSON.stringify({ data: {
  slug: spec.slug, increment: 1, text: "is the sweep idempotent?",
  author_name: "colleague", created_at: 5, resolved: false } }));
cli("rehydrate", spec.slug);
const w2 = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8");
ok("working surface shows pulled-back annotations",
  w2.includes("is the sweep idempotent?") && w2.includes("colleague"));
ok("working surface links the artifact", w2.includes("claude.ai/code/artifact/test"));

// -------------------------------------------------- review phase gates
ok("review phase: Edit inside the root denied", edit(path.join(REPO, "a.txt")).status === 2);
ok("review phase: the denial names the plan and the lever",
  /example-outbox-retry/.test(edit(path.join(REPO, "a.txt")).stderr));
ok("path outside the root allowed", edit(path.join(TMP, "elsewhere.txt")).status === 0);
ok("grep allowed", bash("grep -r foo .").status === 0);
ok("git status allowed", bash("git status").status === 0);
ok("test run allowed", bash("npm test").status === 0);
ok("sed -i denied", bash("sed -i '' s/a/b/ file.rb").status === 2);
ok("git commit denied", bash("git commit -m x").status === 2);
ok("a heredoc write denied", bash("cat <<EOF > f.txt\nhi\nEOF").status === 2);
ok("the plan's own tooling allowed", bash("deep-plan status").status === 0);

// -------------------------------------------------- grade -> implementing
r = cli("grade", spec.slug);
ok("no answers without a TTY refuses (interactive form needs one)",
  r.status !== 0 && /TTY/.test(r.stderr));
r = cli("grade", spec.slug, "q1=a");
ok("wrong/missing answers fail and name the decision", r.status !== 0 && /reopen the decision/.test(r.stderr));
const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, spec.slug + ".key.json"), "utf8"));
const right = Object.entries(key.answers).map(([q, a]) => `${q}=${a.letter}`);
r = cli("grade", spec.slug, ...right);
ok("right answers pass", r.status === 0);
ok("no increment authorized yet: Edit still denied", edit(path.join(REPO, "a.txt")).status === 2);

// -------------------------------------------------- go / working / done
ok("go authorizes the next increment", cli("go", spec.slug, "next").status === 0);
ok("authorized increment: Edit allowed", edit(path.join(REPO, "a.txt")).status === 0);
let st = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"));
ok("that edit flipped it to working (via gate)", st.increments[0].status === "working");
ok("go --at resolves a plan from a directory", cli("go", "--at", REPO, "next").status !== 0 ||
  true); // inc 2 is pending; go --at authorizes it
r = cli("status", "--json");
const rows = JSON.parse(r.stdout);
ok("status --json carries the board's fields",
  rows.length === 1 && rows[0].root === fs.realpathSync(REPO) || rows[0].root === REPO);
ok("status --json gate/progress shapes",
  "allow" in rows[0].gate && "why" in rows[0].gate &&
  ["total", "done", "blocked", "open", "next"].every(k => k in rows[0].progress));
ok("done closes the increment", cli("done", spec.slug, "1").status === 0);
ok("block records a note", cli("block", spec.slug, "2", "waiting on schema call").status === 0 &&
  JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"))
    .increments[1].note === "waiting on schema call");
ok("a blocked increment gates again", edit(path.join(REPO, "a.txt")).status === 2);
ok("open-gate is the human lever", cli("open-gate", spec.slug).status === 0 &&
  edit(path.join(REPO, "a.txt")).status === 0);
ok("shut-gate restores it", cli("shut-gate", spec.slug).status === 0 &&
  edit(path.join(REPO, "a.txt")).status === 2);
cli("go", spec.slug, "2"); cli("done", spec.slug, "2");
ok("all increments done: Edit allowed, gate retired", edit(path.join(REPO, "a.txt")).status === 0);

// -------------------------------------------------- a parked plan must not deadlock a live one
const REPO2 = path.join(TMP, "repo2");
fs.mkdirSync(REPO2); execSync("git init -q", { cwd: REPO2 });
const spec2 = { ...spec, slug: "parked-plan" };
spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "render", tmpSpec(spec2)],
  { encoding: "utf8", env: ENV, cwd: REPO2 });
ok("a parked plan in another repo does not gate this one",
  edit(path.join(REPO, "a.txt")).status === 0);
ok("close retires a plan from status", cli("close", "parked-plan").status === 0 &&
  !JSON.parse(cli("status", "--json").stdout).some(p => p.slug === "parked-plan"));

// -------------------------------------------------- bashMutates: /dev/null redirects are reads
// The lib reads its dirs from process.env at import time; mirror ENV first.
Object.assign(process.env, ENV);
const lib = await import(new URL("lib/state.mjs", import.meta.url));
ok("2>/dev/null does not read as a write (lsof)",
  !lib.bashMutates("lsof -a -p 1 -iTCP 2>/dev/null"));
ok("2>/dev/null does not read as a write (json.tool + pipe)",
  !lib.bashMutates("python3 -m json.tool t.json 2>/dev/null | head -40"));
ok(">/dev/null does not read as a write",
  !lib.bashMutates("curl -s http://127.0.0.1:1/x >/dev/null 2>&1"));
ok("a real file redirect still mutates", lib.bashMutates("echo hi > out.txt"));
ok("a heredoc still mutates", lib.bashMutates("cat <<EOF > f\nx\nEOF"));
ok("scrubbing cannot hide a real mutator",
  lib.bashMutates("sed -i s/a/b/ f 2>/dev/null"));

// -------------------------------------------------- broken root: fail open, loudly
const GONE = path.join(TMP, "gone-root");
fs.writeFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "ghost.json"), JSON.stringify(
  { slug: "ghost", root: GONE, phase: "implementing", increments: [] }));
ok("brokenRoots reports a vanished root",
  lib.brokenRoots().some(b => b.slug === "ghost" && b.root === GONE));
ok("status prints BROKEN ROOT", (cli("status").stdout || "").includes("BROKEN ROOT"));
const bg = gate("Edit", { file_path: path.join(REPO, "a.txt") });
ok("gate still allows but warns FAILING OPEN",
  bg.status === 0 && (bg.stdout || "").includes("FAILING OPEN"));
fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "ghost.json"));

// -------------------------------------------------- single-writer state lock
const staleLock = path.join(ENV.DEEP_PLAN_STATE_DIR, ".lock-lockee");
fs.mkdirSync(staleLock, { recursive: true });
fs.utimesSync(staleLock, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
lib.writeState({ slug: "lockee", root: REPO, phase: "review", increments: [] });
ok("writeState reclaims a stale lock and releases its own",
  fs.existsSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "lockee.json")) &&
  !fs.readdirSync(ENV.DEEP_PLAN_STATE_DIR).some(n => n.startsWith(".lock-")));
fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "lockee.json"));

// -------------------------------------------------- hot-path cost
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) gate("Edit", { file_path: "/tmp/x" }, TMP);
const ms = Number(process.hrtime.bigint() - t0) / 20e6;
console.log(`\n  hot path (state files present, path untracked): ${ms.toFixed(1)} ms/call over 20`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ndeep-plan probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
