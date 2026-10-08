#!/usr/bin/env node
// deep-plan probe — one command, no arguments, throwaway everything.
// Asserts both directions: blocks what it should, and NEVER what it should not.
// `-v` walks it step by step (the probe is also the demo).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verdict } from "./lib/evidence.mjs";
import { resolver, resolveFiles, matchesGlob, recipeHash, load as loadVerify } from "./lib/verify.mjs";
import { classifyScript } from "./lib/detect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V = process.argv.includes("-v");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dp-probe-"));
const ENV = {
  ...process.env,
  DEEP_PLAN_STATE_DIR: path.join(TMP, "state"),
  DEEP_PLAN_KEYS_DIR: path.join(TMP, "keys"),
  DEEP_PLAN_PLANS_DIR: path.join(TMP, "plans"),
  DEEP_PLAN_ANNOT_DIR: path.join(TMP, "annotations"),
  // No DEEP_PLAN_SKILL_DIR: every gate call below runs hooks/gate.sh by path
  // and must find decide.mjs beside itself, as it does from a plugin root.
  // Authoritative override (empty = no client): a probe render on a machine
  // with a real TypeSafe key must never judge evidence over the network.
  DEEP_PLAN_TYPESAFE_CLIENT: "",
  // The bundle, the engine pointer and the shim, all under TMP. With
  // DEEP_PLAN_VENDOR_DIR set the engine looks nowhere else for mermaid, and
  // MERMAID_SRC replaces the CDN download: the probe never touches the network
  // or repoints the real ~/.claude/deep-plan/engine.json.
  DEEP_PLAN_VENDOR_DIR: path.join(TMP, "vendor"),
  DEEP_PLAN_ENGINE_FILE: path.join(TMP, "engine.json"),
  DEEP_PLAN_BIN_DIR: path.join(TMP, "shim-bin"),
  DEEP_PLAN_MERMAID_SRC: path.join(TMP, "no-download-in-the-probe"),
  DEEP_PLAN_MERMAID: "",
};
delete ENV.DEEP_PLAN_SKILL_DIR;
delete ENV.DEEP_PLAN_ENGINE;
// A probe run from inside a Claude session must not stamp that session (or its
// cmux workspace) as the owner of every throwaway plan; the owner block below
// sets them explicitly.
delete ENV.CLAUDE_CODE_SESSION_ID;
delete ENV.CLAUDE_SESSION_ID;
delete ENV.CMUX_WORKSPACE_ID;
const MERMAID_VENDOR = path.join(ENV.DEEP_PLAN_VENDOR_DIR, "mermaid.min.js");
// The real bundle to test with: where CI fetched it, where `deep-plan setup`
// put it, a checkout's own vendor/, or the old skills copy. Copied, not moved.
{
  const src = [
    process.env.DEEP_PLAN_VENDOR_DIR && path.join(process.env.DEEP_PLAN_VENDOR_DIR, "mermaid.min.js"),
    path.join(os.homedir(), ".claude", "deep-plan", "vendor", "mermaid.min.js"),
    path.join(HERE, "vendor", "mermaid.min.js"),
    path.join(os.homedir(), ".claude", "skills", "deep-plan", "vendor", "mermaid.min.js"),
  ].filter(Boolean).find(p => fs.existsSync(p));
  if (!src) {
    console.error("deep-plan probe: no mermaid.min.js to test with. Run `deep-plan setup`, " +
      "or point DEEP_PLAN_VENDOR_DIR at a directory holding the pinned build.");
    process.exit(1);
  }
  fs.mkdirSync(ENV.DEEP_PLAN_VENDOR_DIR, { recursive: true });
  fs.copyFileSync(src, MERMAID_VENDOR);
}
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
// Record a pass on every check of increment n, the way a person who has seen
// them would — for flows whose subject is something after the checks.
const passAll = (slug, n, run = cli) => {
  const st = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, slug + ".json"), "utf8"));
  for (const id of Object.keys(st.increments[n - 1].checks || {}))
    run("check", "pass", slug, String(n), id, "seen in the probe", "--force");
};

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
// A fresh plugin install has no bundle until setup or the first render fetches
// it. When that fetch fails too (offline; here, MERMAID_SRC names no file), the
// validator degrades to a "skipped" sentinel, but render used to hand that case
// an ENOENT stack trace straight out of node:fs, which reads as a broken tool
// rather than a missing file. It must refuse legibly instead.
{
  const stash = MERMAID_VENDOR + ".probe-stash";
  fs.renameSync(MERMAID_VENDOR, stash);
  const r = cli("render", tmpSpec(spec));
  fs.renameSync(stash, MERMAID_VENDOR);
  ok("render without the vendored mermaid refuses legibly, not with a stack trace",
    r.status !== 0 && /vendor\/mermaid\.min\.js is missing/.test(r.stderr) &&
    /deep-plan setup/.test(r.stderr) && !/node:fs|readFileSync|ENOENT/.test(r.stderr));
}

// -------------------------------------------------- plugin: pointer, setup, shim, bin
//
// Out-of-session callers (the go chip, triage, the intent server, the shim)
// find the engine through engine.json, so every run must leave it naming this
// copy, with the version and the bundle the intent server serves.
{
  // The refusal test above ran with the bundle hidden, so its pointer rightly
  // has no mermaid. One ordinary run with the bundle back must restore it.
  cli("status");
  const ptr = JSON.parse(fs.readFileSync(ENV.DEEP_PLAN_ENGINE_FILE, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, ".claude-plugin", "plugin.json"), "utf8"));
  ok("an ordinary run writes engine.json naming root, version and mermaid",
    ptr.root === HERE && ptr.version === manifest.version && ptr.mermaid === MERMAID_VENDOR);
  ok("engine.json keeps one key per line (the shim reads root with sed)",
    /^  "root": ".*",$/m.test(fs.readFileSync(ENV.DEEP_PLAN_ENGINE_FILE, "utf8")));
  const before = fs.statSync(ENV.DEEP_PLAN_ENGINE_FILE).mtimeMs;
  cli("status");
  ok("an unchanged pointer is not rewritten", fs.statSync(ENV.DEEP_PLAN_ENGINE_FILE).mtimeMs === before);

  // setup: a fresh vendor dir, bytes that are not the pinned build.
  const SV = path.join(TMP, "setup-vendor");
  const bogus = path.join(TMP, "bogus-mermaid.js");
  fs.writeFileSync(bogus, "window.mermaid = 'not the pinned build';\n");
  const scfg = src => ({ ...ENV, DEEP_PLAN_VENDOR_DIR: SV, DEEP_PLAN_MERMAID_SRC: src });
  const setupRun = src => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "setup"],
    { encoding: "utf8", env: scfg(src), cwd: REPO });
  let r = setupRun(bogus);
  ok("setup refuses a bundle whose sha256 does not match the pin, and installs nothing",
    r.status !== 0 && /sha256/.test(r.stderr) && !fs.existsSync(path.join(SV, "mermaid.min.js")) &&
    !fs.readdirSync(SV).some(n => n.includes(".part-")));
  r = setupRun(MERMAID_VENDOR);
  const shim = path.join(ENV.DEEP_PLAN_BIN_DIR, "deep-plan");
  ok("setup installs the pinned bundle and the shim",
    r.status === 0 && fs.existsSync(path.join(SV, "mermaid.min.js")) &&
    fs.existsSync(shim) && (fs.statSync(shim).mode & 0o111) !== 0);
  r = setupRun(bogus);
  ok("setup again is a no-op that says so",
    r.status === 0 && /in place \(sha256 verified\)/.test(r.stdout) && /shim in place/.test(r.stdout));

  // The shim holds no path: it reads engine.json from $HOME, then falls back.
  const H = path.join(TMP, "home");
  fs.mkdirSync(path.join(H, ".claude", "deep-plan"), { recursive: true });
  fs.copyFileSync(ENV.DEEP_PLAN_ENGINE_FILE, path.join(H, ".claude", "deep-plan", "engine.json"));
  const shimRun = (extra = {}) => spawnSync("sh", [shim, "engine"],
    { encoding: "utf8", env: { ...ENV, HOME: H, ...extra }, cwd: REPO });
  r = shimRun();
  ok("the shim runs the engine engine.json names",
    r.status === 0 && JSON.parse(r.stdout).root === HERE);
  r = shimRun({ DEEP_PLAN_ENGINE: path.join(TMP, "nowhere") });
  ok("a bad DEEP_PLAN_ENGINE and no old skills copy: the shim says what is missing",
    r.status === 127 && /no engine found/.test(r.stderr));
  fs.rmSync(path.join(H, ".claude", "deep-plan", "engine.json"));
  r = shimRun({ DEEP_PLAN_ENGINE: HERE });
  ok("DEEP_PLAN_ENGINE wins with no pointer at all",
    r.status === 0 && JSON.parse(r.stdout).root === HERE);

  // The plugin's own bin/: on the Bash tool's PATH, without CLAUDE_PLUGIN_ROOT,
  // possibly reached through a symlink.
  const LB = path.join(TMP, "linkbin");
  fs.mkdirSync(LB, { recursive: true });
  fs.symlinkSync(path.join(HERE, "bin", "deep-plan"), path.join(LB, "dp"));
  r = spawnSync(path.join(LB, "dp"), ["engine"], { encoding: "utf8", env: ENV, cwd: TMP });
  ok("bin/deep-plan finds its engine through a symlink, with no plugin env",
    r.status === 0 && JSON.parse(r.stdout).root === HERE);
}
// -------------------------------------------------- evidence citation check
// Warn-only in both halves: code checks the cited path and line resolve, a
// (mocked) TypeSafe client judges whether the lines back the claim. Neither
// may ever fail a render — the assertions pin exit 0 with warnings present.
{
  // Its own root, and its state cleaned after: an evidence-probe plan left
  // rooted at REPO would gate the very edits the later gate tests assert.
  const EVREPO = path.join(TMP, "evrepo");
  fs.mkdirSync(path.join(EVREPO, "src"), { recursive: true });
  fs.writeFileSync(path.join(EVREPO, "src", "real.txt"),
    Array.from({ length: 10 }, (_, i) => "line " + (i + 1)).join("\n"));
  const ev = JSON.parse(JSON.stringify(spec));
  ev.slug = "evidence-probe";
  ev.verifiedFacts = [
    { claim: "a fine citation", evidence: "src/real.txt:3-5" },
    { claim: "line out of range", evidence: "src/real.txt:99" },
    { claim: "file is gone", evidence: "gone.txt:1" },
    { claim: "free prose evidence stays legal", evidence: "the search came up empty" },
  ];
  const r1 = cli("render", tmpSpec(ev), "--root", EVREPO);
  ok("evidence: warnings never refuse the render", r1.status === 0);
  ok("evidence: out-of-range line is warned with the file's real length",
    /src\/real\.txt:99 — the file ends at line 10/.test(r1.stderr));
  ok("evidence: missing file is warned", /gone\.txt:1 — no such file/.test(r1.stderr));
  ok("evidence: a resolvable citation and free prose stay silent",
    !/real\.txt:3/.test(r1.stderr) && !(/prose/.test(r1.stderr)));

  // The judged half, against a scripted stand-in for typesafe.py: fact 1
  // contradicted at high confidence (warns), fact 2 says_nothing below the
  // confidence floor (silent), fact 3 supported (silent).
  const fake = path.join(TMP, "fake_typesafe.py");
  fs.writeFileSync(fake, `#!/usr/bin/env python3
import json, sys
if (sys.argv[1:] or [""])[0] == "available": sys.exit(0)
req = json.loads(sys.stdin.read())
verdicts = [{"choice": "contradicts", "confidence": 0.9},
            {"choice": "says_nothing", "confidence": 0.3},
            {"choice": "supports", "confidence": 0.95}]
qs = sorted(req["questions"], key=lambda k: int(k[1:]))
print(json.dumps({q: verdicts[i % 3] for i, q in enumerate(qs)}))
`);
  ev.slug = "evidence-probe-judged";
  ev.verifiedFacts = [
    { claim: "one", evidence: "src/real.txt:2" },
    { claim: "two", evidence: "src/real.txt:4" },
    { claim: "three", evidence: "src/real.txt:6" },
  ];
  const r2 = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "render",
    tmpSpec(ev), "--root", EVREPO],
    { encoding: "utf8", cwd: REPO, env: { ...ENV, DEEP_PLAN_TYPESAFE_CLIENT: fake } });
  ok("evidence: a contradicted fact warns, naming its citation",
    r2.status === 0 && /fact 1 — .*src\/real\.txt:2.*contradicting/.test(r2.stderr));
  ok("evidence: below the confidence floor is silence, support is silence",
    !/fact 2/.test(r2.stderr) && !/fact 3/.test(r2.stderr));
  ok("evidence: no client configured means no judged warnings at all",
    !/contradicting|do not appear/.test(r1.stderr));

  // The distribution path, which is what the local Kev this machine points at
  // actually returns. Three shapes, two of which the previous `confidence`
  // gate got wrong.
  const fakeProbs = path.join(TMP, "fake_typesafe_probs.py");
  fs.writeFileSync(fakeProbs, `#!/usr/bin/env python3
import json, sys
if (sys.argv[1:] or [""])[0] == "available": sys.exit(0)
req = json.loads(sys.stdin.read())
verdicts = [
  # torn between contradicts and says_nothing: margin 0.10, mass off
  # "supports" 0.86. The old rule read the margin and stayed silent.
  {"choice": "contradicts", "confidence": 0.21,
   "probabilities": {"supports": 0.14, "contradicts": 0.48, "says_nothing": 0.38}},
  # mass split evenly between the two alarming options: margin ZERO, and 70%
  # of the mass says the citation does not back the claim.
  {"choice": "contradicts", "confidence": 0.0,
   "probabilities": {"supports": 0.30, "contradicts": 0.35, "says_nothing": 0.35}},
  # genuinely supported: must stay silent.
  {"choice": "supports", "confidence": 0.87,
   "probabilities": {"supports": 0.92, "contradicts": 0.03, "says_nothing": 0.05}},
]
qs = sorted(req["questions"], key=lambda k: int(k[1:]))
print(json.dumps({q: verdicts[i % 3] for i, q in enumerate(qs)}))
`);
  ev.slug = "evidence-probe-probs";
  const r3 = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "render",
    tmpSpec(ev), "--root", EVREPO],
    { encoding: "utf8", cwd: REPO, env: { ...ENV, DEEP_PLAN_TYPESAFE_CLIENT: fakeProbs } });
  ok("evidence: a low top-two MARGIN no longer silences a contradicted fact",
    r3.status === 0 && /fact 1 — .*real\.txt:2.*contradicting/.test(r3.stderr), r3.stderr);
  ok("evidence: mass split across both alarming options still warns",
    /fact 2 — .*real\.txt:4/.test(r3.stderr), r3.stderr);
  ok("evidence: a genuinely supported fact stays silent", !/fact 3/.test(r3.stderr), r3.stderr);

  // The reading itself, directly: the compat path must not move.
  ok("verdict: reads mass off supports when a distribution is given",
    verdict({ choice: "contradicts", confidence: 0.21,
              probabilities: { supports: 0.14, contradicts: 0.48, says_nothing: 0.38 } }).warn === true);
  ok("verdict: a confident supports is silence",
    verdict({ choice: "supports", confidence: 0.9,
              probabilities: { supports: 0.92, contradicts: 0.03, says_nothing: 0.05 } }).warn === false);
  ok("verdict: wording follows whichever alarming option holds more mass",
    verdict({ probabilities: { supports: 0.1, contradicts: 0.2, says_nothing: 0.7 } }).choice === "says_nothing");
  ok("verdict: no distribution keeps the old confidence gate",
    verdict({ choice: "contradicts", confidence: 0.9 }).warn === true &&
    verdict({ choice: "contradicts", confidence: 0.3 }).warn === false);
  ok("verdict: an unreadable answer warns about nothing",
    verdict({}).warn === false && verdict(null).warn === false);
  ok("verdict: a supports choice with no distribution stays silent",
    verdict({ choice: "supports", confidence: 0.2 }).warn === false);

  for (const s of ["evidence-probe", "evidence-probe-judged", "evidence-probe-probs"]) {
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, s + ".json"), { force: true });
    fs.rmSync(path.join(os.homedir(), ".claude", "deep-plan", "active", s), { force: true });
  }
}

// The interactive layer: answerable quiz + comment boxes + one copy-back blob.
ok("review quiz options are selectable radios",
  (review.match(/type="radio" name="dp-q-/g) || []).length >=
    (spec.quiz || []).length * 2);
ok("every increment and ADR carries a comment box, plus a general one",
  (review.match(/class="dp-note"/g) || []).length ===
    (spec.deliverables || []).length + spec.decisions.filter(d => d.adr).length + 1);
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

// -------------------------------------------------- read-before-plan floor
{
  fs.writeFileSync(path.join(REPO, "existing.sh"), "#!/bin/sh\n");
  const base = JSON.parse(JSON.stringify(spec));
  base.slug = "floor-plan";
  base.deliverables[0].files = ["existing.sh"];
  let rr = cli("render", tmpSpec(base));
  ok("refuses a deliverable naming an existing file no fact cites",
    rr.status !== 0 && /not read/.test(rr.stderr) && /existing\.sh/.test(rr.stderr));
  base.verifiedFacts.push({ claim: "existing.sh is a stub", evidence: "existing.sh:1" });
  ok("citing the file satisfies the floor", cli("render", tmpSpec(base)).status === 0);
  const fresh = JSON.parse(JSON.stringify(spec));
  fresh.slug = "floor-new";
  fresh.deliverables[0].files = ["not-created-yet.sh"];
  ok("a file the plan will CREATE is exempt (output, not input)",
    cli("render", tmpSpec(fresh)).status === 0);
  for (const s of ["floor-plan", "floor-new"]) {
    cli("close", s);
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, s + ".json"), { force: true });
  }
}

// -------------------------------------------------- ADRs: draft at render, apply post-grade
{
  // Flagged without consequences: refused.
  const noCons = JSON.parse(JSON.stringify(spec));
  noCons.decisions[0].adr = { alternatives: ["x"] };
  ok("refuses a flagged decision with no consequences",
    cli("render", tmpSpec(noCons)).status !== 0);
  // The example spec is flagged: draft + surfaces + state, all from render.
  ok("render drafts the ADR beside the surfaces",
    fs.existsSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".adr1.md")));
  const draft = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".adr1.md"), "utf8");
  ok("draft is Proposed with a deterministic date placeholder",
    draft.includes("Proposed") && draft.includes("(pending apply)"));
  ok("review carries the ADR card and its comment box",
    review.includes("ADR 1: Sweep on a timer") && review.includes('data-section="adr 1"'));
  ok("md plan carries the ADRs section",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".md"), "utf8").includes("## ADRs"));
  const stAdr = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"));
  ok("state records the resolved destination (default here) and preseeded number",
    stAdr.adrs.length === 1 && stAdr.adrs[0].dir === "docs/adr" &&
    stAdr.adrs[0].source === "default" && stAdr.adrs[0].number === 1);
  ok("apply refused while phase is review",
    cli("adr", "apply", spec.slug).status !== 0 &&
    /review/.test(cli("adr", "apply", spec.slug).stderr));
  // Unflagged spec: zero ADR machinery — advisory by name, like observability.
  const plain = JSON.parse(JSON.stringify(spec));
  plain.slug = "no-adr-plan";
  delete plain.decisions[0].adr;
  ok("an unflagged spec renders", cli("render", tmpSpec(plain)).status === 0);
  ok("…with no ADR section and no draft",
    !fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "no-adr-plan.review.html"), "utf8").includes("<h2>ADRs</h2>") &&
    !fs.existsSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "no-adr-plan.adr1.md")));
  cli("close", "no-adr-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "no-adr-plan.json"), { force: true });
  // Config: custom template + explicit dir, honored end to end.
  const REPO3 = path.join(TMP, "repo3");
  fs.mkdirSync(path.join(REPO3, ".seamux"), { recursive: true });
  execSync("git init -q", { cwd: REPO3 });
  fs.writeFileSync(path.join(REPO3, "tpl.md"), "!! {{title}} [{{status}}]\n{{consequences}}\n");
  fs.writeFileSync(path.join(REPO3, ".seamux", "adr.json"),
    JSON.stringify({ template: "tpl.md", dir: "notes/decisions" }));
  const cSpec = JSON.parse(JSON.stringify(spec));
  cSpec.slug = "custom-tpl-plan";
  spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "render", tmpSpec(cSpec)],
    { encoding: "utf8", env: ENV, cwd: REPO3 });
  const cDraft = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "custom-tpl-plan.adr1.md"), "utf8");
  ok("custom template and config dir are honored",
    cDraft.startsWith("!! Sweep on a timer") &&
    JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "custom-tpl-plan.json"), "utf8"))
      .adrs[0].dir === "notes/decisions");
  cli("close", "custom-tpl-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "custom-tpl-plan.json"), { force: true });
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

// -------------------------------------------------- contracts: enforced at render, covered at grade
{
  // The fixture itself declares a contract — assert it reaches both surfaces.
  ok("fixture's contracts entry renders on review + md",
    review.includes("<h2>Contracts</h2>") && review.includes("outbox table (attempt_count") &&
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".md"), "utf8").includes("## Contracts"));
  // Refusals, one per floor.
  let cbad = JSON.parse(JSON.stringify(spec));
  cbad.contracts[0].decisionRef = "no such decision";
  ok("refuses a contract whose decisionRef names no decision",
    /decisionRef must name a decision/.test(cli("render", tmpSpec(cbad)).stderr));
  cbad = JSON.parse(JSON.stringify(spec));
  cbad.contracts[0].scope = "external";
  ok("refuses an external contract with no ADR flag and no waiver",
    /external scope defaults toward ADR/.test(cli("render", tmpSpec(cbad)).stderr));
  cbad.contracts[0].waiver = "single invited consumer, endpoint is versioned";
  cbad.slug = "waived-plan";
  ok("a written waiver passes, and renders on the surface",
    cli("render", tmpSpec(cbad)).status === 0 &&
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "waived-plan.review.html"), "utf8")
      .includes("waiver: single invited consumer"));
  cli("close", "waived-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "waived-plan.json"), { force: true });
  // Coverage is grade's job: render passes an uncovered contract decision,
  // grade then fails structurally, naming it, before any answers are read.
  const unc = JSON.parse(JSON.stringify(spec));
  unc.slug = "uncovered-plan";
  unc.decisions.push({ decision: "Widen the status enum", why: "x" });
  unc.contracts.push({ surface: "outbox.status", kind: "db-schema", scope: "internal",
    change: "modify", reach: "worker only", decisionRef: "Widen the status enum" });
  ok("render passes an uncovered contract decision", cli("render", tmpSpec(unc)).status === 0);
  const gu = cli("grade", "uncovered-plan", "q1=a", "q2=a", "q3=a");
  ok("grade fails on it, naming the decision",
    gu.status !== 0 && /no quiz question covers/.test(gu.stderr) &&
    /Widen the status enum/.test(gu.stderr));
  cli("close", "uncovered-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "uncovered-plan.json"), { force: true });
  // Absence stays free: a contract-free spec renders with no Contracts section.
  const cfree = JSON.parse(JSON.stringify(spec));
  cfree.slug = "contract-free-plan";
  delete cfree.contracts;
  ok("a spec with no contracts block renders",
    cli("render", tmpSpec(cfree)).status === 0 &&
    !fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "contract-free-plan.review.html"), "utf8")
      .includes("<h2>Contracts</h2>"));
  cli("close", "contract-free-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "contract-free-plan.json"), { force: true });
}

// -------------------------------------------------- risks: dispositioned at review, enforced at grade
{
  const rm = (s) => { cli("close", s); fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, s + ".json"), { force: true }); };
  // The fixture's risk is dispositioned — it shows on every surface.
  ok("fixture's dispositioned risk renders on review + md",
    review.includes("backoff cap has not been agreed") && review.includes("— accept") &&
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".md"), "utf8").includes("disposition: accept"));
  // Authoring is permissive: a plain string and an undispositioned object render…
  const rs = JSON.parse(JSON.stringify(spec));
  rs.slug = "risk-string-plan";
  rs.risks = ["nobody looked at this one", { risk: "nor this one" }];
  ok("render passes plain-string and undispositioned risks", cli("render", tmpSpec(rs)).status === 0);
  // …and grade refuses, naming each, before reading any answer.
  const gr = cli("grade", "risk-string-plan", "q1=a", "q2=a", "q3=a");
  ok("grade fails on them, naming both",
    gr.status !== 0 && /carry no disposition/.test(gr.stderr) &&
    /nobody looked at this one/.test(gr.stderr) && /nor this one/.test(gr.stderr));
  rm("risk-string-plan");
  // A disposition that is set must hold together, at render.
  let rb = JSON.parse(JSON.stringify(spec));
  rb.risks = [{ risk: "x", disposition: "defer" }];
  ok("refuses an unknown disposition", /disposition must be one of/.test(cli("render", tmpSpec(rb)).stderr));
  rb.risks = [{ risk: "x", disposition: "mitigate", deliverableRef: "no such deliverable" }];
  ok("refuses mitigate naming no deliverable and no ticket",
    /mitigate needs deliverableRef/.test(cli("render", tmpSpec(rb)).stderr));
  rb.risks = [{ risk: "x", disposition: "mitigate", ticketRef: "PROJ-12" }];
  ok("refuses a ticketRef with no note", /mitigate needs deliverableRef/.test(cli("render", tmpSpec(rb)).stderr));
  rb.risks = [{ risk: "x", disposition: "spike" }];
  ok("refuses spike with no note", /spike needs a note/.test(cli("render", tmpSpec(rb)).stderr));
  rb.risks = [{ risk: "x", disposition: "promote" }];
  ok("refuses promote with no riskRef quiz question", /promote needs a quiz question/.test(cli("render", tmpSpec(rb)).stderr));
  // The four good shapes render, show their payload, and pass grade's floor.
  const rg = JSON.parse(JSON.stringify(spec));
  rg.slug = "risk-good-plan";
  rg.risks = [
    { risk: "r-accept", disposition: "accept" },
    { risk: "r-mitigate-deliverable", disposition: "mitigate", deliverableRef: rg.deliverables[0].title },
    { risk: "r-mitigate-ticket", disposition: "mitigate", ticketRef: "PROJ-12", note: "filed with context" },
    { risk: "r-spike", disposition: "spike", note: "run the sweep against a copy" },
    { risk: "r-promote", disposition: "promote" },
  ];
  rg.quiz.push({ id: "q4", prompt: "What does the sweep do to a row past the cap?", options: ["leaves it", "drops it", "logs it twice"],
    answer: 0, why: "x", decisionRef: rg.decisions[0].decision, riskRef: "r-promote" });
  ok("every disposition shape renders", cli("render", tmpSpec(rg)).status === 0);
  const rgh = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "risk-good-plan.review.html"), "utf8");
  ok("payloads show on the surface: deliverable, ticket, note",
    rgh.includes("mitigate: " + rg.deliverables[0].title) && rgh.includes("ticket PROJ-12") &&
    rgh.includes("spike: run the sweep"));
  const rgk = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "risk-good-plan.key.json"), "utf8"));
  ok("the key lists no undispositioned risk", (rgk.undispositionedRisks || []).length === 0);
  // Editing surfaces carry a card per risk with its defaults as data
  // attributes; the shareable artifact and the cutover epic carry plain items.
  ok("review carries one card per risk, defaults as data attributes",
    (rgh.match(/class="dp-risk"/g) || []).length === 5 &&
    rgh.includes('data-n="2" data-disposition="mitigate" data-payload="' + rg.deliverables[0].title + '"') &&
    rgh.includes('name="dp-risk-3"') && rgh.includes('value="PROJ-12"') && rgh.includes("dpRiskLines"));
  ok("the working surface carries the cards too",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "risk-good-plan.working.html"), "utf8").includes('class="dp-risk"'));
  ok("the cutover epic carries plain items, no cards",
    !fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "risk-good-plan.cutover", "risk-good-plan.epic.html"), "utf8").includes("dp-risk"));
  ok("both copy-back blobs concatenate dpRiskLines",
    (rgh.match(/dpRiskLines\(\)/g) || []).length >= 1 &&
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "risk-good-plan.working.html"), "utf8").includes("dpRiskLines()"));
  ok("the cutover increment carries the disposition",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "risk-good-plan.cutover", "01-retry-sweep.md"), "utf8")
      .includes("r-mitigate-ticket — mitigate: ticket PROJ-12"));
  rm("risk-good-plan");
}

// -------------------------------------------------- ask: a question as a page, standalone
{
  const askFile = path.join(HERE, "examples", "example.ask.json");
  const asksDir = path.join(ENV.DEEP_PLAN_PLANS_DIR, "asks");
  // Outside any plan root: renders, records no slug, never reaches the board.
  const r = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "ask", askFile],
    { encoding: "utf8", env: { ...ENV, CMUX_SURFACE_ID: "SURF-1", CMUX_WORKSPACE_ID: "WS-1" }, cwd: TMP });
  const id = (r.stdout.match(/ask (\d{8}-\d{6}-[0-9a-f]{4}):/) || [])[1];
  ok("ask renders standalone and prints a time-ordered id", r.status === 0 && !!id);
  const ask = id ? JSON.parse(fs.readFileSync(path.join(asksDir, id + ".json"), "utf8")) : {};
  ok("the ask records its target surface and workspace from the environment",
    ask.surface === "SURF-1" && ask.workspace === "WS-1");
  ok("no tracked plan at the cwd: no slug recorded", ask.slug === "" && ask.answer === null);
  const html = id ? fs.readFileSync(path.join(asksDir, id + ".html"), "utf8") : "";
  ok("the page carries the question, per-option mermaid, examples, and disabled pick buttons",
    html.includes("logged-out visitor") && (html.match(/<pre class="mermaid">/g) || []).length === 2 &&
    html.includes("amounts redacted") && html.includes('class="dp-act dp-ask-pick" data-n="3" disabled'));
  ok("the id passes the intent server's slug pattern", /^[a-z0-9][a-z0-9._-]{0,120}$/.test(id || "!"));
  ok("ask show reports unanswered", /unanswered/.test(cli("ask", "show", id || "x").stdout));
  // Inside a tracked plan root: the slug is recorded.
  const r2 = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "ask", askFile],
    { encoding: "utf8", env: ENV, cwd: REPO });
  const id2 = (r2.stdout.match(/ask (\S+):/) || [])[1];
  ok("inside a plan root the ask records the slug",
    id2 && JSON.parse(fs.readFileSync(path.join(asksDir, id2 + ".json"), "utf8")).slug === spec.slug);
  // Refusals.
  const multi = path.join(TMP, "multi.json");
  fs.writeFileSync(multi, JSON.stringify({ questions: [{ question: "a", options: [{ label: "x" }, { label: "y" }] }] }));
  ok("refuses a multi-question ask", /one question per ask/.test(cli("ask", multi).stderr));
  fs.writeFileSync(multi, JSON.stringify({ question: "a", options: [{ label: "x" }] }));
  ok("refuses fewer than two options", /2\+ options/.test(cli("ask", multi).stderr));
}

// -------------------------------------------------- ADR file convention is the adopter's
//
// "One ADR per file, numbered, in a folder" is the only part every adopter
// shares; the spelling is house style. A repo with 348 ADRs named
// `adr_001_snake_case.md` will not restyle them to suit a planning tool, and
// the failure when it does not match is not cosmetic: a scan that recognises
// none of the existing files reports "next number = 1" and writes a second
// ADR 1 beside the real one.
{
  const alib = await import(new URL("lib/adr.mjs", import.meta.url));
  const HOUSE = path.join(TMP, "house");
  fs.mkdirSync(HOUSE, { recursive: true });
  // Three real-world spellings, none of them the default.
  for (const n of ["adr_001_first.md", "adr_002_second.md", "adr-003-third.md", "004_fourth.md"])
    fs.writeFileSync(path.join(HOUSE, n), "x\n");

  ok("the default scan recognises the default convention",
    alib.nextNumber(path.dirname(path.join(HOUSE, "x")), alib.ADR_DEFAULT_SCAN) === 1);
  // The bug this exists to prevent, asserted as a bug:
  ok("the default scan does NOT recognise the house convention (so it would restart at 1)",
    alib.nextNumber(HOUSE, alib.ADR_DEFAULT_SCAN) === 1);
  ok("a configured scan continues the house numbering",
    alib.nextNumber(HOUSE, "^(?:adr[-_])?(\\d+)[-_]") === 5);
  // …and that mismatch is reported rather than left to be discovered later.
  const rep = alib.adrScanReport(HOUSE, alib.ADR_DEFAULT_SCAN);
  ok("a folder whose files the scan cannot read is reported",
    rep && rep.total === 4 && rep.examples.length === 3);
  ok("…and a folder it CAN read reports nothing",
    alib.adrScanReport(HOUSE, "^(?:adr[-_])?(\\d+)[-_]") === null);
  ok("an empty folder reports nothing (starting at 1 is correct there)",
    alib.adrScanReport(path.join(TMP, "no-such-adr-dir"), alib.ADR_DEFAULT_SCAN) === null);

  ok("filePattern chooses the number width and the word separator",
    alib.adrFileName(13, "Stamp The Lender Entity", "adr_{nnn}_{snake}.md") ===
      "adr_013_stamp_the_lender_entity.md" &&
    alib.adrFileName(13, "Stamp The Lender Entity", "{nnnn}-{kebab}.md") ===
      "0013-stamp-the-lender-entity.md" &&
    alib.adrFileName(7, "X", "{n}_{snake}.md") === "7_x.md");
  ok("the default pattern is unchanged for adopters with no config",
    alib.adrFileName(13, "Stamp The Lender Entity") === "0013-stamp-the-lender-entity.md");

  // A pattern produces a FILENAME. Without this it can produce a path, and the
  // ADR lands outside the directory the config named.
  const cfgDir = path.join(TMP, "cfgroot");
  const writeCfg = o => {
    fs.mkdirSync(path.join(cfgDir, ".seamux"), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, ".seamux", "adr.json"), JSON.stringify(o));
  };
  for (const bad of ["../{kebab}.md", "a/{kebab}.md", "..{nnn}.md"]) {
    writeCfg({ filePattern: bad });
    ok(`filePattern ${JSON.stringify(bad)} is refused, falling back to the default`,
      alib.loadAdrConfig(cfgDir).filePattern === alib.ADR_DEFAULT_PATTERN);
  }
  // No number placeholder means every ADR overwrites the last.
  writeCfg({ filePattern: "{kebab}.md" });
  ok("a filePattern with no number placeholder is refused",
    alib.loadAdrConfig(cfgDir).filePattern === alib.ADR_DEFAULT_PATTERN);
  writeCfg({ numberScan: "^(unclosed" });
  ok("an uncompilable numberScan is refused, not thrown",
    alib.loadAdrConfig(cfgDir).numberScan === alib.ADR_DEFAULT_SCAN);
  writeCfg({ numberScan: "^adr_\\d+" });
  ok("a numberScan with no capture group is refused",
    alib.loadAdrConfig(cfgDir).numberScan === alib.ADR_DEFAULT_SCAN);
  writeCfg({ filePattern: "adr_{nnn}_{snake}.md", numberScan: "^(?:adr[-_])?(\\d+)[-_]" });
  const good = alib.loadAdrConfig(cfgDir);
  ok("a valid convention is accepted",
    good.filePattern === "adr_{nnn}_{snake}.md" && good.numberScan === "^(?:adr[-_])?(\\d+)[-_]");
  fs.rmSync(path.join(cfgDir, ".seamux"), { recursive: true, force: true });
  ok("no config at all keeps every default",
    JSON.stringify(alib.loadAdrConfig(cfgDir)) ===
      JSON.stringify({ template: "nygard", dir: null,
        filePattern: alib.ADR_DEFAULT_PATTERN, numberScan: alib.ADR_DEFAULT_SCAN }));

  // Discovery runs BEFORE any config, so it has to be broader than one style.
  // A folder NAMED adr/adrs is matched by name, which would pass this whatever
  // the file pattern — so the folder here is deliberately called something
  // else, leaving the filename test as the only thing that can find it.
  const disco = path.join(TMP, "disco", "docs", "decisions");
  fs.mkdirSync(disco, { recursive: true });
  fs.writeFileSync(path.join(disco, "adr_001_house_style.md"), "x\n");
  ok("discovery finds an ADR home that is not named adr/adrs, by its filenames",
    alib.resolveAdrDir(path.join(TMP, "disco"), { dir: null }).dir === "docs/decisions");
  // …and the name path still works on its own, with no recognisable files.
  const named = path.join(TMP, "disco2", "docs", "adrs");
  fs.mkdirSync(named, { recursive: true });
  fs.writeFileSync(path.join(named, "README.md"), "x\n");
  ok("a folder named adrs is found by name even with no ADR files in it",
    alib.resolveAdrDir(path.join(TMP, "disco2"), { dir: null }).dir === "docs/adrs");

  // The number widths a house template needs in its heading.
  const rendered = alib.renderAdr(
    { decision: "Do the thing", why: "because", adr: { consequences: "c" } },
    { template: "nygard" }, { number: 13, root: TMP });
  ok("the built-in template still renders a 4-padded number", rendered.includes("0013"));
  const tplPath = path.join(TMP, "house.tmpl.md");
  fs.writeFileSync(tplPath, "# ADR {{n}} / {{nnn}} / {{nnnn}}: {{title}}\n{{context}}\n");
  const houseRendered = alib.renderAdr(
    { decision: "Do the thing", why: "because" },
    { template: { path: "house.tmpl.md" } }, { number: 13, root: TMP });
  ok("a house template can choose the number width",
    houseRendered.includes("# ADR 13 / 013 / 0013: Do the thing"));
}

// -------------------------------------------------- ADR inline editor + markdown subset
{
  const workingNow = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8");
  ok("ADR editor present on review and working (toggle + fields + preview)",
    [review, workingNow].every(h => h.includes('class="dp-adr-edit"') &&
      h.includes('id="dp-adr-ed-1"') && h.includes('class="dp-adr-field"') &&
      h.includes('class="dp-adr-preview"')));
  ok("promote button on the un-flagged decision only",
    (review.match(/dp-adr-promote" data-decision/g) || []).length === 1 &&
    review.includes('data-decision="Track retries on the outbox row"'));
  ok("both blob builders append staged ADR lines",
    review.includes("window.dpAdrLines") && workingNow.includes("window.dpAdrLines") &&
    review.includes("promote to ADR") && review.includes("- [adr "));
  // dpMd, executed for real: escape-first, subset only, no js: links.
  const mdSrc = (review.match(/function dpMd\(src\) \{[\s\S]*?\n\}/) || [])[0];
  ok("dpMd ships in the page", !!mdSrc);
  if (mdSrc) {
    const dpMd = new Function(mdSrc + "; return dpMd;")();
    const out = dpMd("# H\n\n**b** *i* `c` [l](https://x.dev)\n\n- a\n\n```\n<script>\n```\n\n<b>raw</b>");
    ok("dpMd renders the subset and escapes everything else",
      out.includes("<h2>H</h2>") && out.includes("<b>b</b>") && out.includes("<i>i</i>") &&
      out.includes("<code>c</code>") && out.includes('<a href="https://x.dev">l</a>') &&
      out.includes("<ul>") && out.includes("&lt;script&gt;") && out.includes("&lt;b&gt;raw&lt;/b&gt;"));
    ok("dpMd never links javascript: URLs", !dpMd("[x](javascript:alert(1))").includes("<a"));
  }
  // A spec with no flagged decision: no editor cards, but promotion offered.
  const plainHtml = (() => {
    const p = JSON.parse(JSON.stringify(spec));
    p.slug = "no-editor-plan"; delete p.decisions[0].adr;
    cli("render", tmpSpec(p));
    const h = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "no-editor-plan.review.html"), "utf8");
    cli("close", "no-editor-plan");
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "no-editor-plan.json"), { force: true });
    return h;
  })();
  ok("unflagged plan: no editor card, every decision promotable",
    !plainHtml.includes('class="dp-adr-edit"') &&
    (plainHtml.match(/dp-adr-promote" data-decision/g) || []).length === 2);
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
// The amend channel: a box per plan section and per ADR card, one copy
// button, and a blob headed for the session — mid-increment spec edits ride
// this, the same way review comments ride the review blob.
ok("working surface has amend boxes per section, per ADR, plus general",
  ["context", "decisions", "risks", "general", "adr 1"].every(s =>
    working.includes(`data-section="${s}"`)));
ok("amend copy button builds the paste blob",
  working.includes('id="dp-amend-copy"') &&
  working.includes('"deep-plan amend \\u2014 " + slug'));

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
ok("exported page carries the Contracts section",
  art1.includes("<h2>Contracts</h2>") && art1.includes("outbox table (attempt_count"));
ok("exported page has no ADR editor (share is read-only)",
  !art1.includes("dp-adr-edit") && !art1.includes("dpAdrLines"));
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
// The seamux-mods band recognises a denial by this exact opening, read back
// out of the tool result the model sees. Reword it and the band goes silent,
// so the shape is held here, slug and all.
ok("the denial opens with `deep-plan gate [<slug>]: ` (seamux-mods keys off it)",
  edit(path.join(REPO, "a.txt")).stderr.startsWith(`deep-plan gate [${spec.slug}]: `));

// -------------------------------------------------- approved snapshot: cut once, immutable
{
  const apPath = path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".approved.md");
  ok("grade-pass cut the approved snapshot", fs.existsSync(apPath) &&
    fs.readFileSync(apPath, "utf8").includes("approved snapshot"));
  // Read defensively. Anything that stops `grade` from passing leaves no
  // snapshot, and this section then ended the whole run on an ENOENT — hiding
  // every assertion below it, and the dozen that had already failed above,
  // behind a stack trace. An assertion should fail; only the suite should stop.
  const ap1 = fs.existsSync(apPath) ? fs.readFileSync(apPath, "utf8") : "";
  const stAp = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"));
  ok("state records the snapshot path and spec hash",
    stAp.approved && stAp.approved.path === apPath && stAp.approved.spec_hash.length === 16);
  ok("status carries the snapshot", JSON.parse(cli("status", "--json").stdout)[0].approved === apPath);
  // Amend the spec (a context tweak) and re-render: live surfaces move,
  // the snapshot does not, and the working page notes the drift.
  const amended = JSON.parse(JSON.stringify(spec));
  amended.context += " Amended mid-implementation.";
  cli("render", tmpSpec(amended));
  ok("re-render after grade leaves the snapshot byte-identical",
    fs.existsSync(apPath) && fs.readFileSync(apPath, "utf8") === ap1);
  ok("working surface notes the drift",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8")
      .includes("DRIFTED from the approved snapshot"));
  // Restore the original spec so later assertions see the canonical plan.
  cli("render", tmpSpec(spec));
  ok("no drift note once the spec matches again",
    !fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8")
      .includes("DRIFTED from the approved snapshot"));
}

// -------------------------------------------------- adr apply, post-grade
{
  // Land an interloper so the preseeded number (1) is stale: drift must
  // reallocate and say so, not silently overwrite.
  fs.mkdirSync(path.join(REPO, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "docs", "adr", "0001-interloper.md"), "x\n");
  const ap = cli("adr", "apply", spec.slug);
  ok("apply lands the ADR after the grade", ap.status === 0 &&
    fs.existsSync(path.join(REPO, "docs", "adr", "0002-sweep-on-a-timer-not-on-write.md")));
  ok("stale preseeded number reallocates loudly", /drifted 1 -> 2/.test(ap.stdout));
  const applied = fs.readFileSync(
    path.join(REPO, "docs", "adr", "0002-sweep-on-a-timer-not-on-write.md"), "utf8");
  ok("applied file is Accepted with a real date",
    applied.includes("Accepted") && !applied.includes("(pending apply)") &&
    /Date: \d{4}-\d{2}-\d{2}/.test(applied));
  const ap2 = cli("adr", "apply", spec.slug);
  ok("re-apply rewrites the same file, no fresh number", ap2.status === 0 &&
    /0002-.*\(rewritten\)/.test(ap2.stdout) &&
    !fs.existsSync(path.join(REPO, "docs", "adr", "0003-sweep-on-a-timer-not-on-write.md")));
  ok("working surface flips the ADR chip to applied",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8")
      .includes(">applied</span>"));
}

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
// The pane matches a session's cwd against the root, and a process reports
// its cwd with symlinks resolved (/private/tmp, not /tmp, on macOS).
ok("status --json carries the root resolved, beside the root as written",
  rows[0].realRoot === fs.realpathSync(rows[0].root) && typeof rows[0].root === "string", JSON.stringify(rows[0].realRoot));
ok("status --json gate/progress shapes",
  "allow" in rows[0].gate && "why" in rows[0].gate &&
  ["total", "done", "blocked", "open", "next"].every(k => k in rows[0].progress));
ok("done is refused while the example's checks are pending", cli("done", spec.slug, "1").status === 1);
passAll(spec.slug, 1);
ok("done closes the increment once they pass", cli("done", spec.slug, "1").status === 0);
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

// -------------------------------------------------- render preserves state it does not own
//
// The increment reconcile used to be a field WHITELIST. That is complete for a
// plan this engine created, because it writes nothing else — which is exactly
// why the gap was invisible. On a plan from anywhere else (an older generation,
// or a future field) everything unlisted was dropped on the next render, with
// no error and no log line.
{
  const s = { ...spec, slug: "keep-plan" };
  ok("a plan renders for the preserve test", cli("render", tmpSpec(s)).status === 0);
  const sp = path.join(ENV.DEEP_PLAN_STATE_DIR, "keep-plan.json");
  const st = JSON.parse(fs.readFileSync(sp, "utf8"));
  // Fields this engine does not write: four the older generation used, plus one
  // nobody has invented yet. The last one is the point — the fix has to be
  // about not dropping the unknown, not about knowing these four names.
  Object.assign(st.increments[0], {
    pr: "4121", branch: "dev/keep", head: "abc1234", jira: "ABC-1",
    somethingLater: { nested: true },
  });
  st.increments[0].title = "a title the spec disagrees with";
  fs.writeFileSync(sp, JSON.stringify(st, null, 2));
  ok("re-render succeeds", cli("render", tmpSpec(s)).status === 0);
  const after = JSON.parse(fs.readFileSync(sp, "utf8")).increments[0];
  ok("render preserves per-increment fields it does not own",
    after.pr === "4121" && after.branch === "dev/keep" &&
    after.head === "abc1234" && after.jira === "ABC-1");
  ok("render preserves a field this engine has never heard of",
    after.somethingLater && after.somethingLater.nested === true);
  // The spread must not let stale state beat the spec on a field the spec owns.
  ok("the spec still wins on title", after.title === spec.deliverables[0].title);
  cli("close", "keep-plan");
  fs.rmSync(sp, { force: true });
}

// -------------------------------------------------- observability checks gate `done`
//
// Per-DELIVERABLE observability, which is a different thing from the top-level
// advisory spec.observability block asserted further up: declaring checks on a
// deliverable means its `done` is refused until they pass. The legacy
// `observability.checks` field still reads, as observability-kind checks, and
// the `obs` verb still drives them; this block holds both to their old meaning.
{
  const CHECK = { checks: [{ system: "datadog", name: "retry counter climbs",
    query: "sum:outbox.retry{env:qa}", expect: "non-zero within 15m" }] };
  const ID = "obs-retry-counter-climbs";
  const withObs = n => {
    const s = JSON.parse(JSON.stringify(spec));
    s.slug = n;
    delete s.deliverables[0].checks;
    s.deliverables[0].observability = CHECK;
    return s;
  };
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  const chk = (n, i, id = ID) => (stOf(n).increments[i].checks || {})[id];
  const nChecks = (n, i) => Object.keys(stOf(n).increments[i].checks || {}).length;
  // Take a plan to the point where increment 1 can be done.
  const arm = n => {
    cli("render", tmpSpec(withObs(n)));
    const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, n + ".key.json"), "utf8"));
    cli("grade", n, ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
    cli("go", n, "1"); cli("start", n, "1");
  };

  arm("obs-1");
  ok("a deliverable that declares observability starts pending",
    chk("obs-1", 0).status === "pending" && chk("obs-1", 0).kind === "observability");
  ok("the pre-checks verdict field is gone from state", !("obs" in stOf("obs-1").increments[0]));
  ok("a deliverable that declares nothing has no checks", nChecks("obs-1", 1) === 0);
  let r = cli("done", "obs-1", "1");
  ok("done is refused while the check is pending",
    r.status === 1 && new RegExp(`${ID} +\\[observability\\] pending`).test(r.stderr));
  ok("the refusal names how to see the checks and how to record one",
    /check list obs-1 1/.test(r.stderr) && /check pass\|fail obs-1 1/.test(r.stderr));
  ok("the refusal names the override", /--force/.test(r.stderr));
  // crew's board shows only the last line of a refusal; it must be the reason.
  ok("the refusal's last line is the reason, not a hint",
    r.stderr.trim().split("\n").pop() === `done refused: ${ID} pending`);
  ok("the increment did not move", stOf("obs-1").increments[0].status === "working");

  ok("obs fail refuses without a reason", cli("obs", "fail", "obs-1", "1").status === 1);
  ok("obs fail records one", cli("obs", "fail", "obs-1", "1", "counter flat").status === 0 &&
    chk("obs-1", 0).status === "fail");
  r = cli("done", "obs-1", "1");
  ok("done is refused while the check is fail, and shows the note",
    r.status === 1 && /\] fail/.test(r.stderr) && /counter flat/.test(r.stderr));

  ok("obs pass records a verdict and a note",
    cli("obs", "pass", "obs-1", "1", "412 over 20m").status === 0 &&
    chk("obs-1", 0).status === "pass" && chk("obs-1", 0).note === "412 over 20m");
  ok("done is allowed once the check passes",
    cli("done", "obs-1", "1").status === 0 && stOf("obs-1").increments[0].status === "done");

  // A recorded verdict must survive a re-render, or amending the spec would
  // quietly clear evidence.
  cli("render", tmpSpec(withObs("obs-1")));
  ok("a recorded pass survives a re-render", chk("obs-1", 0).status === "pass");
  // …and must survive the declaration being dropped: it was true when recorded.
  const dropped = JSON.parse(JSON.stringify(spec)); dropped.slug = "obs-1";
  cli("render", tmpSpec(dropped));
  ok("a pass survives the declaration being dropped, retired",
    chk("obs-1", 0).status === "pass" && chk("obs-1", 0).retired === true);

  ok("recording against an undeclared increment is refused",
    cli("obs", "pass", "obs-1", "2", "x").status === 1);

  // A verdict proves something about the code that was there when it was
  // recorded. Redoing the increment invalidates it, and leaving a `pass` in
  // place would let the gate pass on stale evidence — silently, which is the
  // one failure this mechanism exists to prevent. Deliberate divergence from
  // the older engine, which kept it and relied on the human remembering.
  arm("obs-5");
  cli("obs", "pass", "obs-5", "1", "seen once");
  ok("done is allowed with a pass", cli("done", "obs-5", "1").status === 0);
  cli("reset", "obs-5", "1");
  ok("resetting an increment re-gates its checks", chk("obs-5", 0).status === "pending");
  ok("…keeping what the verdict was, rather than deleting the evidence",
    /was pass: seen once/.test(chk("obs-5", 0).note));
  ok("…and saying so in the log",
    stOf("obs-5").log.some(l => /returned to pending/.test(l.what)));
  cli("go", "obs-5", "1"); cli("start", "obs-5", "1");
  ok("done is refused again after the reset", cli("done", "obs-5", "1").status === 1);
  // An increment with nothing to re-gate must not gain a spurious check.
  cli("reset", "obs-5", "2");
  ok("resetting an increment with no checks leaves it with none", nChecks("obs-5", 1) === 0);

  // The explicit hatch, for when the work stands but the evidence does not.
  cli("obs", "pass", "obs-5", "1", "seen twice");
  ok("obs reset returns a recorded verdict to pending",
    cli("obs", "reset", "obs-5", "1").status === 0 &&
    chk("obs-5", 0).status === "pending" && /was pass: seen twice/.test(chk("obs-5", 0).note));
  ok("obs reset refuses where there is no check",
    cli("obs", "reset", "obs-5", "2").status === 1);

  // Adding the field to a spec whose state already exists must gate it, not
  // leave it silently un-gated.
  arm("obs-2");
  const both = withObs("obs-2"); both.deliverables[1].observability = CHECK;
  cli("render", tmpSpec(both));
  ok("declaring observability on an existing plan adds a pending check",
    chk("obs-2", 1).status === "pending");

  // --force, and the log saying so.
  arm("obs-3");
  ok("done --force overrides a pending check",
    cli("done", "obs-3", "1", "--force").status === 0 &&
    stOf("obs-3").increments[0].status === "done");
  ok("the override is written to the log",
    stOf("obs-3").log.some(l => /overridden with --force/.test(l.what) && /observability/.test(l.what)));

  // `obs check` reads what render took from the SPEC. The older engine
  // generated these blocks per vendor; none of that comes across, so the check
  // output is only ever a readback of what the plan already committed to.
  const ck = cli("obs", "check", "obs-3", "1");
  ok("obs check prints the declared checks from the spec",
    ck.status === 0 && ck.stdout.includes("retry counter climbs") &&
    ck.stdout.includes("sum:outbox.retry{env:qa}") && ck.stdout.includes("non-zero within 15m"));
  ok("obs check on an increment with no checks says so, and does not fail",
    cli("obs", "check", "obs-3", "2").status === 0 &&
    /declares no checks/.test(cli("obs", "check", "obs-3", "2").stdout));

  arm("obs-4");
  const rows = JSON.parse(cli("status", "--json").stdout);
  const row4 = rows.find(x => x.slug === "obs-4");
  ok("status --json carries the outstanding verdicts for the board (the older shape)",
    row4 && row4.obsOutstanding.length === 1 && row4.obsOutstanding[0].n === 1 &&
    row4.obsOutstanding[0].status === "pending");
  ok("status names them in the text form too",
    /checks outstanding: 1 \(pending\)/.test(cli("status").stdout));
  const wp = n => fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, n + ".working.html"), "utf8");
  ok("the working page lists the checks while one is outstanding",
    wp("obs-4").includes("retry counter climbs") && wp("obs-4").includes("pending"));
  cli("obs", "pass", "obs-4", "1", "seen");
  ok("…and shows the verdict instead once it passes",
    wp("obs-4").includes("pass") && wp("obs-4").includes("seen") &&
    !wp("obs-4").includes("sum:outbox.retry{env:qa}"));

  // A state file from before checks: one `obs` verdict per increment. It gates
  // as it did until a render migrates it, and the render keeps the verdict.
  arm("obs-6");
  const p6 = path.join(ENV.DEEP_PLAN_STATE_DIR, "obs-6.json");
  const s6 = stOf("obs-6");
  delete s6.increments[0].checks; delete s6.increments[1].checks;
  s6.increments[0].obs = { status: "pending", at: 0, note: "", version: "" };
  s6.increments[1].obs = { status: "n/a", at: 0, note: "", version: "" };
  fs.writeFileSync(p6, JSON.stringify(s6, null, 2));
  ok("a legacy pending verdict still refuses done",
    cli("done", "obs-6", "1").status === 1);
  s6.increments[0].obs = { status: "pass", at: 1, note: "seen before checks", version: "" };
  fs.writeFileSync(p6, JSON.stringify(s6, null, 2));
  cli("render", tmpSpec(withObs("obs-6")));
  ok("a render carries a legacy pass onto the observability check",
    chk("obs-6", 0).status === "pass" && chk("obs-6", 0).note === "seen before checks" &&
    !("obs" in stOf("obs-6").increments[0]));
  ok("a legacy n/a becomes no checks", nChecks("obs-6", 1) === 0);

  for (const n of ["obs-1", "obs-2", "obs-3", "obs-4", "obs-5", "obs-6"]) {
    cli("close", n);
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), { force: true });
  }
}

// -------------------------------------------------- checks: one model, every kind
//
// Declared `checks`, legacy observability and legacy `verification` strings are
// one list with stable ids. A pass records the tree it was seen against, and
// `done` treats a pass against other content as stale. A check backed by a
// recipe takes its verdict from running it, so passing one by hand needs
// --force, which is logged.
{
  const ROOT = path.join(TMP, "checks-root");
  fs.mkdirSync(ROOT, { recursive: true });
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: ROOT });
  fs.mkdirSync(path.join(ROOT, ".seamux"));
  fs.writeFileSync(path.join(ROOT, ".seamux", "verify.json"),
    JSON.stringify({ recipes: [{ id: "unit", kind: "test", run: "true" }] }));
  const mk = (slug, edit = s => s) => {
    const s = JSON.parse(JSON.stringify(spec));
    s.slug = slug;
    s.deliverables[0].checks = [
      { kind: "test", name: "unit suite", recipe: "unit" },
      { kind: "manual", name: "Read the sweep log", id: "log" },
    ];
    s.deliverables[0].verification = ["bundle exec rspec spec/outbox"];
    return edit(s);
  };
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  const arm = (n, s = mk(n)) => {
    cli("render", tmpSpec(s), "--root", ROOT);
    const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, n + ".key.json"), "utf8"));
    cli("grade", n, ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
    cli("go", n, "1"); cli("start", n, "1");
  };
  const last = r => r.stderr.trim().split("\n").pop();

  for (const [label, edit] of [
    ["an unknown kind", s => { s.deliverables[0].checks = [{ kind: "smoke", name: "x" }]; return s; }],
    ["a check with no name or recipe", s => { s.deliverables[0].checks = [{ kind: "test" }]; return s; }],
    ["two checks with one id", s => { s.deliverables[0].checks = [
      { kind: "test", name: "a", id: "same" }, { kind: "manual", name: "b", id: "same" }]; return s; }],
    ["checks that are not an array", s => { s.deliverables[0].checks = { kind: "test" }; return s; }],
  ]) ok(`render refuses ${label}`, cli("render", tmpSpec(mk("chk-bad", edit))).status === 1);

  arm("chk-1");
  const ids = Object.keys(stOf("chk-1").increments[0].checks);
  ok("declared checks, then legacy verification, under stable ids",
    JSON.stringify(ids) === JSON.stringify(["test-unit-suite", "log", "manual-bundle-exec-rspec-spec-outbox"]));
  ok("a verification string becomes a pending manual check",
    stOf("chk-1").increments[0].checks["manual-bundle-exec-rspec-spec-outbox"].kind === "manual");

  const row = () => JSON.parse(cli("status", "--json").stdout).find(x => x.slug === "chk-1");
  ok("status --json lists each check on its increment",
    row().increments[0].checks.length === 3 &&
    row().increments[0].checks[0].recipe === "unit" && row().increments[0].obs === "pending");
  ok("status --json names every outstanding check",
    row().checksOutstanding.length === 3 &&
    row().checksOutstanding.every(c => c.n === 1 && c.status === "pending"));

  ok("check pass refuses an id the increment does not have",
    /its checks: test-unit-suite, log/.test(cli("check", "pass", "chk-1", "1", "nope", "x").stderr));
  ok("check fail refuses without a reason", cli("check", "fail", "chk-1", "1", "log").status === 1);

  let r = cli("check", "pass", "chk-1", "1", "test-unit-suite", "ran it myself");
  ok("a hand pass on a recipe-backed check is refused without --force",
    r.status === 1 && stOf("chk-1").increments[0].checks["test-unit-suite"].status === "pending");
  ok("…and the refusal ends with the reason", /^refused: test-unit-suite recipe-backed/.test(last(r)));
  ok("with --force it records the pass",
    cli("check", "pass", "chk-1", "1", "test-unit-suite", "ran it myself", "--force").status === 0 &&
    stOf("chk-1").increments[0].checks["test-unit-suite"].by === "hand, forced");
  ok("…and the force is in the log",
    stOf("chk-1").log.some(l => /test-unit-suite \(recipe-backed, passed by hand with --force\)/.test(l.what)));

  ok("a manual check takes a hand pass", cli("check", "pass", "chk-1", "1", "log", "3 rows requeued").status === 0);
  const tree = stOf("chk-1").increments[0].checks.log.tree;
  ok("a pass records the tree it was seen against",
    tree && /^[0-9a-f]{40}$/.test(tree.head) && /^[0-9a-f]{40}$/.test(tree.content));
  r = cli("done", "chk-1", "1");
  ok("done names only the checks still outstanding",
    r.status === 1 && /manual-bundle-exec-rspec-spec-outbox pending$/.test(last(r)) && !/ log /.test(last(r)));
  cli("check", "pass", "chk-1", "1", "manual-bundle-exec-rspec-spec-outbox", "green");

  // Staleness is judged on content: an edit after the pass stales it, putting
  // the content back un-stales it, and a commit of what was passed does not.
  fs.writeFileSync(path.join(ROOT, "sweep.rb"), "edited after the pass\n");
  r = cli("done", "chk-1", "1");
  ok("an edit after a pass makes done refuse it as stale",
    r.status === 1 && /log stale/.test(last(r)) && /test-unit-suite stale/.test(last(r)));
  ok("check list says which passes went stale",
    /log  \[manual\] stale/.test(cli("check", "list", "chk-1", "1").stdout));
  ok("status takes a pass as recorded (it does not hash the tree)", row().checksOutstanding.length === 0);
  fs.rmSync(path.join(ROOT, "sweep.rb"));
  fs.writeFileSync(path.join(ROOT, "sweep.rb"), "the passed content\n");
  cli("check", "pass", "chk-1", "1", "log", "again");
  cli("check", "pass", "chk-1", "1", "test-unit-suite", "again", "--force");
  cli("check", "pass", "chk-1", "1", "manual-bundle-exec-rspec-spec-outbox", "again");
  execSync(`git add -A && ${G} commit -q -m sweep`, { cwd: ROOT });
  ok("committing what was passed does not stale it",
    cli("done", "chk-1", "1").status === 0 && stOf("chk-1").increments[0].status === "done");

  // reset folds every verdict back to pending; check reset takes one id.
  cli("reset", "chk-1", "1");
  ok("reset returns every check to pending",
    Object.values(stOf("chk-1").increments[0].checks).every(v => v.status === "pending" && !v.tree));
  cli("go", "chk-1", "1");
  cli("check", "pass", "chk-1", "1", "log", "x"); cli("check", "fail", "chk-1", "1", "manual-bundle-exec-rspec-spec-outbox", "red");
  ok("check reset <id> resets only that check",
    cli("check", "reset", "chk-1", "1", "log").status === 0 &&
    stOf("chk-1").increments[0].checks.log.status === "pending" &&
    stOf("chk-1").increments[0].checks["manual-bundle-exec-rspec-spec-outbox"].status === "fail");
  ok("check reset refuses an unknown id", cli("check", "reset", "chk-1", "1", "nope").status === 1);

  // A renamed check is a new one; the old verdict is kept, retired, and gates nothing.
  cli("check", "pass", "chk-1", "1", "log", "kept");
  cli("render", tmpSpec(mk("chk-1", s => { s.deliverables[0].checks[1].id = "sweep-log"; return s; })), "--root", ROOT);
  const c1 = stOf("chk-1").increments[0].checks;
  ok("a dropped check's pass is kept, retired",
    c1.log.retired === true && c1.log.note === "kept" && c1["sweep-log"].status === "pending");
  ok("a retired check is not listed in status --json",
    !row().increments[0].checks.some(c => c.id === "log"));

  for (const n of ["chk-1", "chk-bad"]) {
    cli("close", n);
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), { force: true });
  }
}

// -------------------------------------------------- recipe files: load, inherit, resolve
//
// .seamux/verify.json lives beside the code it verifies. A file lands on its
// nearest ancestor's config; the root's recipes are inherited unless that
// config redefines the id, and configs in between are not. `match` and `cwd`
// are relative to the project directory holding the config.
{
  const VR = path.join(TMP, "verify-root");
  const put = (rel, obj) => {
    const p = path.join(VR, rel, ".seamux", "verify.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  };
  put("", { recipes: [
    { id: "unit", kind: "test", run: "npm test", match: ["src/**"], default: true },
    { id: "lint", kind: "test", run: "npm run lint", default: true },
    { id: "e2e", kind: "e2e", steps: [
      { acquire: "git push -u origin HEAD", note: "opens a preview" },
      { wait: "scripts/preview-url.sh", export: "BASE_URL" },
      { run: "npx playwright test" }] },
  ] });
  put("apps", { recipes: [{ id: "apps-only", run: "true" }] });
  put("apps/web", { recipes: [
    { id: "unit", kind: "test", run: "npm -w web test", match: ["src/**/*.tsx", "src/**/*.ts"], default: true },
    { id: "web-a11y", kind: "e2e", run: "npm run test:a11y", tier: "expensive" },
  ] });

  const R = resolver(VR);
  const web = R.file("apps/web/src/cart.tsx");
  const keys = rs => rs.map(r => r.key).sort().join(",");
  ok("a file lands on its nearest ancestor's config",
    web.config === "apps/web/.seamux/verify.json");
  ok("…with that project's recipes, plus the root's it does not redefine",
    keys(web.recipes) === "e2e,lint,unit@apps/web,web-a11y@apps/web");
  ok("a redefined id replaces the root's recipe for that project",
    web.recipes.find(r => r.id === "unit").steps[0].command === "npm -w web test");
  ok("a config between the project and the root is not inherited",
    !web.recipes.some(r => r.id === "apps-only"));
  ok("inherited recipes say so", web.recipes.find(r => r.id === "lint").inherited === true &&
    web.recipes.find(r => r.id === "unit").inherited === false);
  ok("match is relative to the project: apps/web's src/** does not cover its README",
    !R.file("apps/web/README.md").recipes.some(r => r.id === "unit"));
  ok("a file with no config of its own lands on the nearest one above (apps/)",
    R.file("apps/api/server.ts").config === "apps/.seamux/verify.json" &&
    keys(R.file("apps/api/server.ts").recipes) === "apps-only@apps,e2e,lint");
  ok("…and the root's match globs are relative to the root",
    R.file("src/index.ts").recipes.some(r => r.key === "unit") &&
    !R.file("apps/api/src/index.ts").recipes.some(r => r.id === "unit") &&
    keys(R.file("docs/guide.md").recipes) === "e2e,lint");
  ok("the copied glob matcher keeps restack's semantics",
    matchesGlob("a/b/c.ts", "**/*.ts") && matchesGlob("c.ts", "**/*.ts") && matchesGlob("proto/x/y", "proto") &&
    !matchesGlob("src/a/b.ts", "src/*.ts") && matchesGlob("src/a.ts", "src/?.ts"));
  ok("a file that does not exist yet still resolves (plans name files they create)",
    R.file("apps/web/src/new/thing.ts").recipes.some(r => r.key === "unit@apps/web"));
  ok("a file outside the root resolves to nothing", R.file(path.join(TMP, "elsewhere.ts")).outside === true);

  const both = resolveFiles(VR, ["apps/web/src/cart.tsx", "src/index.ts"]);
  ok("two projects' same-named recipes stay two checks",
    both.recipes.some(r => r.key === "unit") && both.recipes.some(r => r.key === "unit@apps/web"));

  const e2e = web.recipes.find(r => r.id === "e2e");
  ok("a recipe with acquire or wait steps defaults to the expensive tier", e2e.tier === "expensive");
  ok("a wait step gets a timeout and a poll interval",
    e2e.steps[1].timeout === 1200 && e2e.steps[1].interval === 15 && e2e.steps[1].export === "BASE_URL");
  ok("`run` is shorthand for one run step",
    JSON.stringify(web.recipes.find(r => r.id === "lint").steps.map(s => s.kind)) === '["run"]');
  ok("every recipe carries a 12-hex content hash", web.recipes.every(r => /^[0-9a-f]{12}$/.test(r.hash)));
  ok("verify resolve labels an acquire step as a person's, and names what a wait exports",
    /e2e .*acquire \(a person runs it\) → wait → \$BASE_URL → run/.test(
      cli("verify", "resolve", "apps/web/src/cart.tsx", "--root", VR).stdout));
  const unitHash = () => resolver(VR).file("src/a.ts").recipes.find(r => r.id === "unit").hash;
  const h1 = unitHash();
  ok("the hash is stable across loads", h1 === unitHash());
  put("", { recipes: [{ id: "unit", kind: "test", run: "npm test -- --ci", match: ["src/**"], default: true },
    { id: "lint", kind: "test", run: "npm run lint", default: true }] });
  ok("…and changes when the recipe is edited", h1 !== unitHash());
  ok("an inherited recipe is the root's recipe, hash and all",
    resolver(VR).file("apps/web/x.ts").recipes.find(r => r.id === "lint").hash ===
    resolveFiles(VR, ["src/a.ts"]).recipes.find(r => r.id === "lint").hash);
  ok("one recipe body in two projects is two recipes (cwd differs)",
    recipeHash(loadVerify(VR).recipes[0], "") !== recipeHash(loadVerify(VR).recipes[0], "apps/web"));

  // A config is validated as it is loaded; nothing invalid reads as "no recipes".
  const BAD = path.join(TMP, "verify-bad");
  const errsOf = obj => {
    const p = path.join(BAD, ".seamux", "verify.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj));
    return loadVerify(BAD).errors.join(" | ");
  };
  ok("a missing config is not an error", loadVerify(path.join(TMP, "nowhere")).present === false &&
    loadVerify(path.join(TMP, "nowhere")).errors.length === 0);
  ok("invalid JSON is an error", /not valid JSON/.test(errsOf("{ nope")));
  ok("a file without a recipes array is an error", /expected \{ "recipes"/.test(errsOf({ checks: [] })));
  for (const [label, recipe, re] of [
    ["no id", { run: "x" }, /id is required/],
    ["an unknown kind", { id: "a", kind: "manual", run: "x" }, /kind must be/],
    ["run and steps both", { id: "a", run: "x", steps: [{ run: "y" }] }, /not both/],
    ["nothing to run", { id: "a" }, /nothing to run/],
    ["a step with two kinds", { id: "a", tier: "expensive", steps: [{ run: "x", wait: "y" }] }, /needs exactly one of acquire\|wait\|run \(has wait and run\)/],
    ["a wait after a run", { id: "a", tier: "expensive", steps: [{ run: "x" }, { wait: "y" }] }, /wait after run/],
    ["an export on an acquire step", { id: "a", steps: [{ acquire: "x", export: "V" }, { run: "y" }] }, /cannot export/],
    ["an export that is not an env var name", { id: "a", steps: [{ run: "x", export: "base-url" }] }, /env var name/],
    ["a remote recipe with no run step", { id: "a", steps: [{ wait: "x" }] }, /needs a run step/],
    ["a wait in the cheap tier", { id: "a", tier: "cheap", steps: [{ wait: "x" }, { run: "y" }] }, /must be expensive/],
    ["a cwd outside the project", { id: "a", run: "x", cwd: "../other" }, /cwd must be a path inside/],
    ["a non-positive timeout", { id: "a", run: "x", timeout: 0 }, /timeout must be a positive/],
  ]) ok(`a recipe with ${label} is refused`, re.test(errsOf({ recipes: [recipe] })));
  ok("two recipes with one id are refused",
    /share the id "a"/.test(errsOf({ recipes: [{ id: "a", run: "x" }, { id: "a", run: "y" }] })));

  // The verb: text for a person, --json for the render that infers checks.
  let r = cli("verify", "resolve", "apps/web/src/cart.tsx", "docs/guide.md", "--root", VR);
  ok("verify resolve names the config each file lands on and what applies",
    r.status === 0 && /apps\/web\/src\/cart\.tsx  → apps\/web\/\.seamux\/verify\.json/.test(r.stdout) &&
    /unit@apps\/web/.test(r.stdout) && /lint .*\(inherited from the root\)/.test(r.stdout));
  r = cli("verify", "resolve", "apps/web/src/cart.tsx", "--root", VR, "--json");
  const js = JSON.parse(r.stdout);
  ok("verify resolve --json carries files, recipes with hashes, and errors",
    js.files[0].config === "apps/web/.seamux/verify.json" && js.recipes.every(x => x.hash && x.source) &&
    Array.isArray(js.errors));
  ok("a file under no config says so",
    /no \.seamux\/verify\.json at or above it/.test(cli("verify", "resolve", "x.ts", "--root", REPO).stdout));
  put("apps/web", "{ broken");
  r = cli("verify", "resolve", "apps/web/src/cart.tsx", "--root", VR);
  ok("a broken config fails verify resolve loudly",
    r.status === 1 && /apps\/web\/\.seamux\/verify\.json: not valid JSON/.test(r.stderr));
  ok("verify with no subcommand says how to use it", cli("verify").status === 1);
}

// -------------------------------------------------- render infers checks and refuses gaps
//
// At render each deliverable's checks are its declared ones (a named recipe
// bound to the config its files land on), then every default recipe whose
// match covers its files, then the legacy fields. An increment with none is
// refused unless it carries a waiver. The resolved list lives in state, with
// each recipe's steps and hash, and every surface shows it.
{
  // The example as shipped renders; stripped of its checks and waiver, it is
  // refused, and the refusal says how to get past it.
  const stripped = JSON.parse(JSON.stringify(spec));
  stripped.slug = "inf-stripped";
  delete stripped.deliverables[0].checks; delete stripped.deliverables[1].waiver;
  let r = cli("render", tmpSpec(stripped));
  ok("an increment with no checks and no waiver is refused",
    r.status === 1 && /deliverable 1 \("Retry sweep"\) has no checks/.test(r.stderr) &&
    /deliverable 2 \("Backoff bookkeeping"\) has no checks/.test(r.stderr));
  ok("…and the refusal names the ways past it: a check, a default recipe, or a waiver",
    /Declare one in "checks"/.test(r.stderr) && /verify resolve/.test(r.stderr) && /"waiver"/.test(r.stderr));
  const blank = JSON.parse(JSON.stringify(stripped)); blank.deliverables[1].waiver = "  ";
  ok("a blank waiver is not a waiver", /a waiver is a sentence/.test(cli("render", tmpSpec(blank)).stderr));
  r = cli("render", tmpSpec(stripped), "--force");
  ok("render --force is the logged way past",
    r.status === 0 && JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "inf-stripped.key.json"), "utf8"))
      .violationsForced.some(v => /has no checks/.test(v)));

  // A repo with recipes: the root's and a nested project's.
  const IR = path.join(TMP, "infer-root");
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  fs.mkdirSync(IR, { recursive: true });
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: IR });
  const put = (rel, obj) => {
    const p = path.join(IR, rel, ".seamux", "verify.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  };
  const ROOT_RECIPES = { recipes: [
    { id: "unit", kind: "test", name: "unit suite", run: "npm test", match: ["app/**"], default: true },
    { id: "slow", kind: "test", run: "npm run slow", match: ["app/**"] },
    { id: "docs", kind: "test", run: "npm run docs", match: ["docs/**"], default: true },
  ] };
  put("", ROOT_RECIPES);
  put("web", { recipes: [
    { id: "unit", kind: "test", run: "npm -w web test", default: true },
    { id: "preview", kind: "e2e", steps: [
      { acquire: "scripts/open-preview.sh", note: "opens a preview" },
      { wait: "scripts/preview-url.sh", export: "BASE_URL", timeout: 600 },
      { run: "npx playwright test" }] },
  ] });
  const mk = (slug, edit) => {
    const s = JSON.parse(JSON.stringify(spec));
    s.slug = slug;
    s.deliverables[0] = { title: "Retry sweep", body: "A timer job.", files: ["app/workers/retry_sweep.rb"] };
    s.deliverables[1] = { title: "Preview page", body: "A page in web.", files: ["web/src/page.tsx"],
      checks: [{ kind: "e2e", name: "preview e2e", recipe: "preview" }] };
    return edit ? edit(s) : s;
  };
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  const rend = (s, ...extra) => cli("render", tmpSpec(s), "--root", IR, ...extra);
  const FORCE = "--" + "force";

  r = rend(mk("inf-1"));
  ok("a deliverable whose files a default recipe covers renders with no checks declared", r.status === 0);
  const c1 = stOf("inf-1").increments[0].checks;
  ok("the covering default recipe becomes an inferred check",
    c1.unit && c1.unit.inferred === true && c1.unit.recipe === "unit" && c1.unit.status === "pending");
  ok("a recipe that is not default, or does not match, is not inferred", !c1.slow && !c1.docs);
  ok("an inferred check stores what will run: steps, cwd, tier, timeout, hash and source",
    c1.unit.exec.steps[0].command === "npm test" && c1.unit.exec.cwd === "." && c1.unit.exec.tier === "cheap" &&
    c1.unit.exec.timeout === 900 && /^[0-9a-f]{12}$/.test(c1.unit.hash) && c1.unit.source === ".seamux/verify.json");
  const c2 = stOf("inf-1").increments[1].checks;
  ok("a named recipe binds to the config its files land on (nearest wins)",
    c2["e2e-preview-e2e"].recipe === "preview@web" && c2["e2e-preview-e2e"].exec.cwd === "web" &&
    c2["e2e-preview-e2e"].exec.tier === "expensive");
  ok("…and the project's default recipe is inferred beside it, keyed to the project",
    c2["unit@web"] && c2["unit@web"].exec.steps[0].command === "npm -w web test" && !c2.unit);

  // Surfaces show the resolved checks, label remote steps, and mark the
  // acquire step as a person's.
  const rd = n => sfx => fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, `${n}.${sfx}`), "utf8");
  const s1 = rd("inf-1");
  const cut = fs.readdirSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "inf-1.cutover")).filter(f => /^02-/.test(f))[0];
  const cut2 = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "inf-1.cutover", cut), "utf8");
  cli("export-artifact", "inf-1");
  const surfaces = { md: s1("md"), review: s1("review.html"), working: s1("working.html"),
    cutover: cut2, export: s1("artifact.html") };
  for (const [name, text] of Object.entries(surfaces)) {
    ok(`${name}: shows the inferred and the bound checks`, text.includes("unit@web") && text.includes("preview@web"));
    ok(`${name}: marks the acquire step as a person's`, text.includes("a person runs this; the engine stops here"));
    ok(`${name}: labels the wait step with what it polls and exports`,
      text.includes("scripts/preview-url.sh") && text.includes("up to 600s") && text.includes("$BASE_URL"));
  }
  ok("an inferred check says where it came from",
    surfaces.md.includes("inferred: a default recipe in `web/.seamux/verify.json` covers"));
  ok("a waiver is shown where checks would be",
    rd(spec.slug)("md").includes("Checks: none — waived: the retry sweep spec") &&
    rd(spec.slug)("review.html").includes("waived: the retry sweep spec") &&
    rd(spec.slug)("working.html").includes("waived: the retry sweep spec"));

  // What was reviewed is what runs: rehydrate reads the stored resolution, so
  // a config edited after render changes no surface until the next render —
  // and recording a verdict changes neither the md nor the review page.
  put("", { recipes: [...ROOT_RECIPES.recipes, { id: "lint", kind: "test", run: "npm run lint", default: true }] });
  cli("check", "pass", "inf-1", "1", "unit", "green", FORCE);
  ok("rehydrate stays byte-identical across a recipe edit and a recorded verdict",
    /md byte-identical, review byte-identical/.test(cli("rehydrate", "inf-1").stdout));

  // A recipe edited after a pass: the pass proves nothing about the recipe as it is now.
  put("", { recipes: ROOT_RECIPES.recipes.map(x => x.id === "unit" ? { ...x, run: "npm test -- --ci" } : x) });
  rend(mk("inf-1"));
  const u = stOf("inf-1").increments[0].checks.unit;
  ok("a re-render after the recipe changed returns its pass to pending",
    u.status === "pending" && /was pass: green \(recipe changed since — re-run\)/.test(u.note) &&
    u.exec.steps[0].command === "npm test -- --ci");
  cli("check", "pass", "inf-1", "1", "unit", "green again", FORCE);
  rend(mk("inf-1"));
  ok("…while a re-render with the recipe unchanged keeps the verdict",
    stOf("inf-1").increments[0].checks.unit.status === "pass");

  // Refusals: a recipe that is not there, one that is ambiguous, a declared id
  // an inferred one would collide with, and a broken config.
  r = rend(mk("inf-bad", s => { s.deliverables[1].checks[0].recipe = "nope"; return s; }));
  ok("a check naming a recipe that is not where its files land is refused",
    r.status === 1 && /no recipe "nope" where its files land/.test(r.stderr));
  r = rend(mk("inf-bad", s => {
    s.deliverables[0].files.push("web/src/x.tsx");
    s.deliverables[0].checks = [{ kind: "test", name: "unit", recipe: "unit" }];
    return s;
  }));
  ok("a bare recipe id that two projects define is refused as ambiguous",
    r.status === 1 && /recipe "unit" is ambiguous here \((unit, unit@web|unit@web, unit)\)/.test(r.stderr));
  r = rend(mk("inf-key", s => {
    s.deliverables[0].files.push("web/src/x.tsx");
    s.deliverables[0].checks = [{ kind: "test", name: "web unit", recipe: "unit@web" }];
    return s;
  }));
  ok("…and naming it by its key binds it, with the other default still inferred",
    r.status === 0 && stOf("inf-key").increments[0].checks["test-web-unit"].recipe === "unit@web" &&
    stOf("inf-key").increments[0].checks.unit.inferred === true &&
    !stOf("inf-key").increments[0].checks["unit@web"]);
  r = rend(mk("inf-id", s => {
    s.deliverables[0].checks = [{ id: "unit", kind: "manual", name: "eyeball the sweep" }];
    return s;
  }));
  ok("an inferred check never takes a declared check's id",
    r.status === 0 && stOf("inf-id").increments[0].checks.unit.kind === "manual" &&
    stOf("inf-id").increments[0].checks["unit-2"].recipe === "unit");
  put("web", "{ broken");
  r = rend(mk("inf-bad"));
  ok("a broken recipe config refuses the render",
    r.status === 1 && /recipe config web\/\.seamux\/verify\.json: not valid JSON/.test(r.stderr));

  for (const n of ["inf-stripped", "inf-1", "inf-bad", "inf-key", "inf-id"]) {
    cli("close", n);
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), { force: true });
  }
}

// -------------------------------------------------- check run: inline, detached, from wait
//
// A recipe-backed check runs exactly as render stored it and the verdict is
// the exit code. Cheap ones run in the foreground; expensive ones in a
// detached runner that outlives the CLI and lands its own verdict. An acquire
// step is never executed: the check waits for a person, then `--from wait`.
// A runner that dies without a verdict is found and failed as lost.
{
  const RR = path.join(TMP, "run-root");
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  fs.mkdirSync(path.join(RR, ".seamux"), { recursive: true });
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: RR });
  const RECIPES = { recipes: [
    { id: "ok", run: "echo hello; echo world", default: true },
    { id: "bad", run: "echo boom >&2; exit 3" },
    { id: "slow", run: "sleep 5", timeout: 0.5 },
    { id: "chain", steps: [
      { run: "echo http://preview.local", export: "BASE_URL" },
      { run: "test \"$BASE_URL\" = http://preview.local && echo got-$BASE_URL" }] },
    { id: "remote", kind: "e2e", steps: [
      { acquire: "scripts/open-preview.sh", note: "opens a preview" },
      { wait: "test -f ready && cat ready", export: "BASE_URL", timeout: 1, interval: 0.1 },
      { run: "echo against $BASE_URL" }] },
    { id: "exp", tier: "expensive", run: "sleep 1; echo detached-done" },
    { id: "hang", tier: "expensive", run: "sleep 30" },
  ] };
  const putCfg = obj => fs.writeFileSync(path.join(RR, ".seamux", "verify.json"), JSON.stringify(obj, null, 2));
  putCfg(RECIPES);
  const declared = ["bad", "slow", "chain", "remote", "exp", "hang"].map(id =>
    ({ id, kind: id === "remote" ? "e2e" : "test", name: id, recipe: id }));
  const mk = (slug, checks) => {
    const s = JSON.parse(JSON.stringify(spec));
    s.slug = slug;
    s.deliverables[0] = { title: "Retry sweep", body: "A timer job.", files: ["src/a.ts"],
      checks: [...checks, { id: "eyes", kind: "manual", name: "look at it" }] };
    return s;
  };
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  const ck = (n, id) => stOf(n).increments[0].checks[id];
  const arm = (n, checks) => {
    cli("render", tmpSpec(mk(n, checks)), "--root", RR);
    const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, n + ".key.json"), "utf8"));
    cli("grade", n, ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
    cli("go", n, "1"); cli("start", n, "1");
  };
  const lastOut = r => r.stdout.trim().split("\n").pop();
  const waitFor = (cond, ms = 8000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (cond()) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
    return cond();
  };

  arm("run-1", declared);
  let r = cli("check", "run", "run-1", "1", "ok");
  ok("a cheap recipe runs in the foreground and passes on exit 0",
    r.status === 0 && /✅ ok pass — exit 0/.test(r.stdout) && ck("run-1", "ok").status === "pass" &&
    ck("run-1", "ok").by === "runner" && ck("run-1", "ok").ran.code === 0);
  ok("…keeping the full output in its log",
    /hello\nworld/.test(fs.readFileSync(ck("run-1", "ok").ran.log, "utf8")));
  ok("…and recording the tree it ran against", /^[0-9a-f]{40}$/.test(ck("run-1", "ok").tree.content));
  ok("…and no runner left behind in the verdict", !("runner" in ck("run-1", "ok")));

  r = cli("check", "run", "run-1", "1", "bad");
  ok("a non-zero exit fails the check, naming the step and showing the tail",
    r.status === 1 && ck("run-1", "bad").status === "fail" &&
    ck("run-1", "bad").note === "exit 3 at step 1: echo boom >&2; exit 3" && /boom/.test(r.stdout));
  r = cli("check", "run", "run-1", "1", "slow");
  ok("a run past its timeout fails as timed out",
    r.status === 1 && /timed out after 0.5s at step 1/.test(ck("run-1", "slow").note) && ck("run-1", "slow").ran.timedOut);
  r = cli("check", "run", "run-1", "1", "chain");
  ok("a step's export reaches the steps after it",
    r.status === 0 && /got-http:\/\/preview\.local/.test(fs.readFileSync(ck("run-1", "chain").ran.log, "utf8")) &&
    /\[BASE_URL=http:\/\/preview\.local\]/.test(fs.readFileSync(ck("run-1", "chain").ran.log, "utf8")));
  r = cli("check", "run", "run-1", "1", "eyes");
  ok("a check with no recipe is refused, and told to record by hand",
    r.status === 1 && /^refused: eyes has no recipe to run$/.test(r.stderr.trim().split("\n").pop()) &&
    /check pass\|fail run-1 1 eyes/.test(r.stderr));

  // The acquire step: a person's. The engine stops, says what to run, and resumes from wait.
  fs.mkdirSync(path.join(RR, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(RR, "scripts", "open-preview.sh"), `#!/bin/sh\ntouch ${JSON.stringify(path.join(TMP, "ACQUIRED"))}\n`);
  fs.chmodSync(path.join(RR, "scripts", "open-preview.sh"), 0o755);
  r = cli("check", "run", "run-1", "1", "remote");
  ok("a recipe that starts with acquire stops at needs-variant",
    r.status === 0 && ck("run-1", "remote").status === "needs-variant" &&
    ck("run-1", "remote").acquire[0].command === "scripts/open-preview.sh");
  ok("…prints the command for a person and how to resume",
    /scripts\/open-preview\.sh/.test(r.stdout) && /check run run-1 1 remote --from wait/.test(r.stdout));
  ok("…and never runs it", !fs.existsSync(path.join(TMP, "ACQUIRED")));
  ok("done is refused while a check needs a variant",
    /remote needs-variant/.test(cli("done", "run-1", "1").stderr.trim().split("\n").pop()));
  ok("check status shows what a person runs",
    /a person runs: scripts\/open-preview\.sh/.test(cli("check", "status", "run-1", "1", "remote").stdout));
  r = cli("check", "run", "run-1", "1", "remote", "--from", "wait", "--inline");
  ok("--from wait polls, and fails when the variant never shows",
    r.status === 1 && /wait gave up after 1s/.test(ck("run-1", "remote").note) && !fs.existsSync(path.join(TMP, "ACQUIRED")));
  fs.writeFileSync(path.join(RR, "ready"), "http://pr-7.preview.local\n");
  r = cli("check", "run", "run-1", "1", "remote", "--from", "wait", "--inline");
  ok("--from wait resumes once the variant exists, exporting what the wait printed",
    r.status === 0 && ck("run-1", "remote").status === "pass" &&
    /against http:\/\/pr-7\.preview\.local/.test(fs.readFileSync(ck("run-1", "remote").ran.log, "utf8")));
  ok("--from takes only wait", cli("check", "run", "run-1", "1", "remote", "--from", "run").status === 1);

  // Detached: the CLI returns at once, the runner outlives it and lands the verdict.
  const t0 = Date.now();
  r = cli("check", "run", "run-1", "1", "exp");
  const took = Date.now() - t0;
  const pid = ck("run-1", "exp").runner && ck("run-1", "exp").runner.pid;
  ok("an expensive recipe starts detached and the CLI returns before it finishes",
    r.status === 0 && took < 1000 && /started detached/.test(r.stdout) &&
    ck("run-1", "exp").status === "running" && pid > 0);
  ok("…with a pidfile and a log under the plans directory",
    fs.existsSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "run-1.runs", "inc1-exp.pid")) &&
    ck("run-1", "exp").runner.log.startsWith(path.join(ENV.DEEP_PLAN_PLANS_DIR, "run-1.runs")));
  ok("check status reports it running", /exp {2}running/.test(cli("check", "status", "run-1", "1", "exp").stdout));
  ok("running again while it runs does not start a second one",
    /already running/.test(cli("check", "run", "run-1", "1", "exp").stdout));
  r = cli("check", "wait", "run-1", "1", "exp", "--timeout", "20");
  ok("check wait blocks until the runner lands its verdict",
    r.status === 0 && ck("run-1", "exp").status === "pass" && ck("run-1", "exp").by === "runner" &&
    /wait over: every check passed/.test(r.stdout));
  ok("…from the detached run, whose log is kept and pidfile removed",
    /detached-done/.test(fs.readFileSync(ck("run-1", "exp").ran.log, "utf8")) &&
    !fs.existsSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "run-1.runs", "inc1-exp.pid")));

  // A runner that dies without a verdict.
  cli("check", "run", "run-1", "1", "hang");
  const hpid = ck("run-1", "hang").runner.pid;
  try { process.kill(-hpid, "SIGKILL"); } catch { try { process.kill(hpid, "SIGKILL"); } catch { /* gone */ } }
  waitFor(() => { try { process.kill(hpid, 0); return false; } catch { return true; } });
  // status --json is what the pane polls: it reports the dead runner, and
  // leaves the recording of it to the check verbs.
  const lostRow = JSON.parse(cli("status", "--json").stdout).find(x => x.slug === "run-1");
  const lostCheck = lostRow.increments[0].checks.find(c => c.id === "hang");
  ok("status --json shows a check whose runner died as lost",
    lostCheck.status === "lost" && /^runner lost: pid \d+/.test(lostCheck.note) &&
    lostRow.checksOutstanding.some(c => c.id === "hang" && c.status === "lost"), JSON.stringify(lostCheck));
  ok("…without writing it: the state still says running", ck("run-1", "hang").status === "running");
  r = cli("check", "status", "run-1", "1", "hang");
  ok("a dead runner's check becomes fail: runner lost",
    ck("run-1", "hang").status === "fail" && /^runner lost: pid \d+ exited without a verdict/.test(ck("run-1", "hang").note));
  ok("check wait on a lost runner returns, not hangs", cli("check", "wait", "run-1", "1", "hang", "--timeout", "5").status === 1);

  // A reset while a runner is in flight: its verdict belongs to an attempt
  // nobody is waiting on, so it is discarded rather than landed.
  cli("check", "run", "run-1", "1", "exp");
  cli("check", "reset", "run-1", "1", "exp");
  ok("a verdict from a run that was reset meanwhile is discarded",
    waitFor(() => stOf("run-1").log.some(l => /exp finished pass, but the check was reset/.test(l.what))) &&
    ck("run-1", "exp").status === "pending");

  // No ids: every recipe-backed check not yet passed against this tree.
  arm("run-2", []);
  r = cli("check", "run", "run-2", "1");
  ok("with no ids, check run runs the recipe checks still outstanding",
    r.status === 0 && ck("run-2", "ok").status === "pass" && ck("run-2", "eyes").status === "pending");
  ok("…and once they pass, there is nothing to run", /nothing to run/.test(cli("check", "run", "run-2", "1").stdout));
  ok("check status --json carries each check's verdict",
    JSON.parse(cli("check", "status", "run-2", "1", "--json").stdout).find(c => c.id === "ok").ran.code === 0);

  // A recipe edited after render: the run uses what was reviewed, and says so.
  putCfg({ recipes: RECIPES.recipes.map(x => x.id === "ok" ? { ...x, run: "echo edited" } : x) });
  r = cli("check", "run", "run-2", "1", "ok");
  ok("a run whose recipe changed since render warns, and runs the reviewed version",
    /recipe ok changed in \.seamux\/verify\.json since render/.test(r.stderr) &&
    /hello/.test(fs.readFileSync(ck("run-2", "ok").ran.log, "utf8")));
  putCfg(RECIPES);

  // Concurrent writers: a stale copy written back does not erase a verdict
  // recorded after it was read, nor the log lines that came with it.
  process.env.DEEP_PLAN_STATE_DIR = ENV.DEEP_PLAN_STATE_DIR;
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CMUX_WORKSPACE_ID"]) delete process.env[k];
  const S = await import("./lib/state.mjs");
  const stale = S.readState("run-2");
  cli("check", "pass", "run-2", "1", "eyes", "looked, fine");
  stale.increments[0].note = "a writer that never saw the pass";
  S.writeState(stale);
  ok("a stale write keeps a verdict stamped after it read",
    ck("run-2", "eyes").status === "pass" && stOf("run-2").increments[0].note === "a writer that never saw the pass");
  ok("…and the log lines it never had", stOf("run-2").log.some(l => /check pass: increment 1 eyes/.test(l.what)));
  const stale2 = S.readState("run-2");
  cli("check", "reset", "run-2", "1", "eyes");
  S.writeState(stale2);
  ok("a reset is a verdict change too: a stale pass does not undo it", ck("run-2", "eyes").status === "pending");

  for (const n of ["run-1", "run-2"]) {
    cli("close", n);
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), { force: true });
  }
}

// -------------------------------------------------- verify init: detector, templates, setup prompt
//
// verify init reads what a repo already runs — package.json scripts, CI run
// steps cited as path:line, runner and host configs — and drafts a
// .seamux/verify.json per project, a TODO on every gap. Dry run unless
// --write, which never overwrites. Templates are copied in by name.
{
  const DR = path.join(TMP, "detect-root");
  const put = (rel, body) => {
    const p = path.join(DR, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  };
  put("package.json", { name: "mono", workspaces: ["apps/*"], scripts: {
    lint: "eslint .", dev: "next dev", check: "npm run lint && npm test", "test:watch": "vitest" } });
  put("package-lock.json", "{}");
  put("apps/web/package.json", { name: "web", scripts: {
    test: "vitest run", "test:e2e": "playwright test", build: "next build", "test:ui": "playwright test --ui" } });
  put("apps/web/playwright.config.ts", "export default { webServer: { command: 'npm run dev' } };\n");
  put("apps/web/vercel.json", "{}");
  put("apps/api/go.mod", "module example.com/api\n");
  const API_CFG = JSON.stringify({ recipes: [{ id: "mine", run: "make test" }] }, null, 2);
  put("apps/api/.seamux/verify.json", API_CFG);
  const CI = [
    "name: ci",
    "on: push",
    "jobs:",
    "  web:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - name: lint",
    "        run: npm run lint",
    "      - run: |",
    "          cd apps/web",
    "          npm test",
    "  matrix-test:",
    "    strategy:",
    "      matrix:",
    "        node: [20, 22]",
    "    steps:",
    "      - run: npm test -- --node ${{ matrix.node }}",
    "  local:",
    "    steps:",
    "      - uses: ./.github/actions/setup",
    "  reuse:",
    "    uses: org/repo/.github/workflows/e2e.yml@main",
    "",
  ].join("\n");
  put(".github/workflows/ci.yml", CI);
  const lineOf = needle => CI.split("\n").findIndex(l => l.includes(needle)) + 1;
  execSync("git init -q && git add -A", { cwd: DR });
  const before = execSync("git status --porcelain", { cwd: DR, encoding: "utf8" });

  let r = cli("verify", "init", "--root", DR, "--json");
  const det = JSON.parse(r.stdout);
  const proj = d => det.projects.find(p => p.dir === d);
  const rec = (d, id) => (proj(d).recipes || []).find(x => x.id === id);
  ok("verify init finds every project with a manifest, the root included",
    det.projects.map(p => p.dir).join(",") === ",apps/api,apps/web" && det.workspaces.includes("apps/*"));
  ok("package.json scripts become draft recipes, classified by role",
    rec("", "lint").run === "npm run lint" && rec("", "lint").default === true && rec("", "lint").tier === "cheap" &&
    rec("apps/web", "unit").run === "npm test" && rec("apps/web", "test-e2e").kind === "e2e");
  ok("dev servers, builds, watchers and UIs are not checks",
    !proj("").recipes.some(x => /dev|watch/.test(x.name)) &&
    !proj("apps/web").recipes.some(x => /build|test:ui/.test(x.name)));
  ok("a script that only chains others is an aggregate, not a recipe",
    proj("").aggregates[0].name === "check" && proj("").aggregates[0].runs.join(",") === "lint,test");
  ok("an e2e suite drafts expensive and not default, with TODOs for both",
    rec("apps/web", "test-e2e").tier === "expensive" && rec("apps/web", "test-e2e").default === false &&
    rec("apps/web", "test-e2e").todo.some(t => /decide default/.test(t)));
  ok("…and a Playwright config that serves itself is called out as a local e2e",
    rec("apps/web", "test-e2e").todo.some(t => /starts its own webServer/.test(t)) && proj("apps/web").runners.includes("playwright"));
  ok("a CI step running the script is cited as path:line evidence",
    rec("", "lint").evidence.includes(`.github/workflows/ci.yml:${lineOf("run: npm run lint")}`) &&
    rec("", "lint").todo[0].startsWith("confirm it matches CI"));
  ok("a script no CI step runs says so in its TODO",
    rec("apps/web", "test-e2e").todo[0].startsWith("no CI step runs this"));
  const step = needle => det.ci.find(s => s.command && s.command.includes(needle));
  ok("a block run step is read whole, cited at its run: line",
    step("cd apps/web && npm test") && step("cd apps/web && npm test").at === `.github/workflows/ci.yml:${lineOf("- run: |")}`);
  ok("a matrix job's step is flagged, its expressions not expanded",
    step("--node").notes.some(n => /matrix job/.test(n)) && step("--node").notes.some(n => /CI expressions/.test(n)));
  ok("a composite action is flagged, not read",
    det.ci.some(s => /composite action \.\/\.github\/actions\/setup/.test(s.notes.join(" "))));
  ok("a reusable workflow is flagged, not read",
    det.ci.some(s => /reusable workflow org\/repo/.test(s.notes.join(" "))));
  ok("a Go project drafts the convention, labeled as one",
    rec("apps/api", "go-test").run === "go test ./..." && rec("apps/api", "go-test").todo[0].includes("convention"));
  ok("a host config suggests its remote template",
    proj("apps/web").hosts[0].template === "vercel-preview" && det.templates.includes("vercel-preview"));
  ok("an existing config is noticed", proj("apps/api").existing === true);
  ok("a dry run writes nothing",
    execSync("git status --porcelain", { cwd: DR, encoding: "utf8" }) === before && det.written.length === 0);
  r = cli("verify", "init", "--root", DR);
  ok("the text form lists drafts, TODOs and the setup prompt",
    r.status === 0 && /draft apps\/web\/\.seamux\/verify\.json/.test(r.stdout) && /TODO /.test(r.stdout) &&
    /setup-prompt\.md/.test(r.stdout) && /--template vercel-preview/.test(r.stdout));

  // --write: only files that do not exist, and what it writes loads clean.
  r = cli("verify", "init", "--root", DR, "--write");
  ok("--write writes the drafts whose file does not exist",
    r.status === 0 && fs.existsSync(path.join(DR, ".seamux", "verify.json")) &&
    fs.existsSync(path.join(DR, "apps/web/.seamux/verify.json")));
  ok("…and never overwrites one that does",
    fs.readFileSync(path.join(DR, "apps/api/.seamux/verify.json"), "utf8") === API_CFG && /left alone/.test(r.stdout));
  ok("a written draft is a valid recipe file (its TODOs ride along, unread by the engine)",
    loadVerify(DR).errors.length === 0 && loadVerify(path.join(DR, "apps/web")).errors.length === 0 &&
    loadVerify(DR).recipes.some(x => x.id === "lint"));
  ok("the drafts resolve the way the configs nest",
    /unit@apps\/web/.test(cli("verify", "resolve", "apps/web/src/x.ts", "--root", DR).stdout) &&
    /lint .*inherited from the root/.test(cli("verify", "resolve", "apps/web/src/x.ts", "--root", DR).stdout));

  // Templates: copied in by name, filled with the project's e2e command.
  const T = JSON.parse(cli("verify", "init", "--root", DR, "--json", "--template", "vercel-preview").stdout);
  const tr = T.drafts.find(d => d.dir === "apps/web").file.recipes.find(x => x.id === "preview-e2e");
  ok("--template lands on the project whose host suggested it",
    tr && tr.steps[0].acquire && tr.steps.at(-1).run === "npm run test:e2e" && tr.default === false);
  ok("…with the template's unverified status and needs as TODOs",
    tr.todo.some(t => /template vercel-preview is unverified/.test(t)) && tr.todo.some(t => /^needs: /.test(t)));
  const T2 = JSON.parse(cli("verify", "init", "--root", DR, "--json", "--template", "github-deployment@apps/api").stdout);
  const tr2 = T2.drafts.find(d => d.dir === "apps/api").file.recipes.find(x => x.id === "preview-e2e");
  ok("a project with no e2e script gets a run step that fails loudly until filled in",
    /TODO: the e2e command/.test(tr2.steps.at(-1).run) && /exit 1/.test(tr2.steps.at(-1).run));
  ok("an unknown template is refused, naming the ones there are",
    /no template "nope" — there are: firebase-channel, github-deployment, rwx-run, vercel-preview/.test(
      cli("verify", "init", "--root", DR, "--template", "nope").stderr));

  // Every shipped template: a valid recipe once filled, remote-shaped, honest
  // about whether anyone proved it, and never reading an error as a value.
  const TD = path.join(HERE, "verify", "templates");
  for (const f of fs.readdirSync(TD)) {
    const t = JSON.parse(fs.readFileSync(path.join(TD, f), "utf8"));
    const dir = path.join(TMP, "tpl-" + t.template);
    fs.mkdirSync(path.join(dir, ".seamux"), { recursive: true });
    const recipe = JSON.parse(JSON.stringify(t.recipe).split("{{e2e}}").join("npx playwright test"));
    fs.writeFileSync(path.join(dir, ".seamux", "verify.json"), JSON.stringify({ recipes: [recipe] }));
    const L = loadVerify(dir);
    const kinds = L.recipes[0] ? L.recipes[0].steps.map(s => s.kind).join(",") : "";
    ok(`template ${t.template}: a valid recipe once filled`, L.errors.length === 0);
    ok(`template ${t.template}: acquire, then a wait that exports, then run`,
      kinds === "acquire,wait,run" && !!L.recipes[0].steps[1].export && L.recipes[0].tier === "expensive");
    ok(`template ${t.template}: says whether it was proven, and how to prove it`,
      typeof t.verified === "boolean" && typeof t.verify === "string" && t.verify.length > 40 && Array.isArray(t.needs));
    ok(`template ${t.template}: its wait discards stderr, so an error is never read as a value`,
      /2>\/dev\/null/.test(L.recipes[0].steps[1].command));
  }
  ok("the setup prompt walks confirm, run twice, measure, and the remote template",
    (() => { const s = fs.readFileSync(path.join(HERE, "verify", "setup-prompt.md"), "utf8");
      return /verify init/.test(s) && /twice/.test(s) && /Tier it on the measurement/.test(s) &&
        /--template/.test(s) && /acquire step is mine to/.test(s); })());

  ok("classifyScript: names and commands",
    classifyScript("test", "vitest run").role === "test" && classifyScript("typecheck", "tsc --noEmit").role === "type-check" &&
    classifyScript("e2e", "cypress run").role === "e2e" && classifyScript("verify", "hurl --test api.hurl").role === "e2e" &&
    classifyScript("test:watch", "vitest") === null && classifyScript("storybook", "storybook dev") === null);
}

// -------------------------------------------------- spec fields that used to be dropped
//
// nonGoals, commits (top-level and per-deliverable) and per-deliverable
// verification were present on real specs and had ZERO references in this
// engine: authored, archived, and silently never shown.
{
  const s = JSON.parse(JSON.stringify(spec));
  s.slug = "fields-plan";
  s.nonGoals = ["Rewriting the scheduler", "Touching the billing path"];
  // Both shapes occur on real specs, so both are accepted rather than one
  // being made a floor nobody asked for.
  s.commits = [{ sha: "abc123def4567890", subject: "seed the outbox table" }, "deadbeefcafe manual entry"];
  s.deliverables[0].verification = ["bundle exec rspec spec/outbox"];
  s.deliverables[0].commits = [{ sha: "1111111111111111", subject: "publisher retry" }];
  ok("a spec carrying all of them renders", cli("render", tmpSpec(s)).status === 0);
  const md = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "fields-plan.md"), "utf8");
  const rv = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "fields-plan.review.html"), "utf8");
  const wk = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "fields-plan.working.html"), "utf8");
  const onAll = (label, needle) => ok(label,
    md.includes(needle) && rv.includes(needle) && wk.includes(needle));
  onAll("nonGoals reach all three surfaces", "Rewriting the scheduler");
  onAll("top-level commits reach all three (object form)", "seed the outbox table");
  onAll("top-level commits reach all three (string form)", "deadbeefcafe manual entry");
  onAll("per-deliverable verification reaches all three", "bundle exec rspec spec/outbox");
  onAll("per-deliverable commits reach all three", "publisher retry");
  ok("a long sha is shortened for display, not printed whole",
    md.includes("abc123def456") && !md.includes("abc123def4567890"));
  // Both indexes checked for >= 0 first: indexOf returns -1 when absent, so a
  // bare `<` comparison passes when the section vanishes entirely.
  ok("non-goals are placed before the decisions",
    md.includes("## Non-goals") && md.includes("## Decisions") &&
    md.indexOf("## Non-goals") < md.indexOf("## Decisions"));
  // Advisory by construction, asserted by name: the example spec carries none
  // of these, so their absence can never quietly become a floor.
  const bare = JSON.parse(fs.readFileSync(path.join(HERE, "examples", "example.spec.json"), "utf8"));
  ok("absence of every one of them never refuses",
    !bare.nonGoals && !bare.commits &&
    !(bare.deliverables || []).some(d => d.verification || d.commits) &&
    cli("render", tmpSpec({ ...bare, slug: "bare-plan" })).status === 0);
  for (const n of ["fields-plan", "bare-plan"]) {
    cli("close", n);
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), { force: true });
  }
}

// -------------------------------------------------- quiz.txt, widget, cutover bundle
//
// All three are pure functions of the spec, and all three were on 13/13 real
// plans. They are written by ONE function called from both `render` and
// `rehydrate`, because two call sites emitting different subsets is the bug
// shape this engine keeps finding in itself — and `rehydrate` is the only
// re-render available for a plan whose spec cannot pass the floors.
{
  const s = JSON.parse(JSON.stringify(spec));
  s.slug = "art-plan";
  s.nonGoals = ["Rewriting the scheduler"];
  s.commits = [{ sha: "abc123def4567890", subject: "seed the outbox" }, "deadbeefcafe bare string"];
  s.deliverables[0].verification = ["bundle exec rspec spec/outbox"];
  s.deliverables[0].commits = [{ sha: "1111111111111111", subject: "publisher retry" }];
  s.deliverables[0].observability = { checks: [{ system: "datadog", name: "retry counter climbs",
    query: "sum:outbox.retry{env:qa}", expect: "non-zero within 15m" }] };
  ok("a plan renders for the artifact tests", cli("render", tmpSpec(s)).status === 0);
  const P = n => path.join(ENV.DEEP_PLAN_PLANS_DIR, n);
  // Tolerant: an artifact the engine was supposed to write but did not must
  // fail the assertion about it, not end the run on an ENOENT.
  const read = n => { try { return fs.readFileSync(P(n), "utf8"); } catch { return ""; } };
  const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "art-plan.key.json"), "utf8"));
  const qlibShuffle = (opts, seed) => {
    // Recompute the expected display order independently of the engine, so the
    // assertion is a check rather than a restatement.
    const h = (str) => crypto.createHash("sha256").update(str).digest().readUInt32BE(0);
    return opts.map((v, i) => ({ v, i, k: h(seed + ":" + i) })).sort((a, b) => a.k - b.k);
  };

  // ---- quiz.txt
  const txt = read("art-plan.quiz.txt");
  ok("quiz.txt is written", txt.length > 0);
  ok("quiz.txt lists every question with its id",
    s.quiz.every((q, i) => txt.includes(`Q${i + 1}. [${q.id}]`) && txt.includes(q.prompt)));
  // THE property: a terminal reader answering from this file must be answering
  // the same lettering the key grades and the review page displays.
  ok("quiz.txt letters the options in the same order as the key and the page",
    s.quiz.every(q => {
      const order = qlibShuffle(q.options, "art-plan:" + q.id);
      const lines = order.map((o, i) => `   ${String.fromCharCode(97 + i)}) ${o.v}`);
      if (!lines.every(l => txt.includes(l))) return false;
      // and the letter the key calls correct must sit on the correct option
      const idx = key.answers[q.id].letter.charCodeAt(0) - 97;
      return order[idx].i === q.answer;
    }));
  ok("quiz.txt ends with the command that actually grades it",
    txt.includes("deep-plan grade art-plan ") &&
    s.quiz.every(q => txt.includes(`${q.id}=<letter>`)));
  ok("quiz.txt never prints which option is correct",
    !/correct|answer:|\(✓\)/i.test(txt));

  // ---- widget.html
  const w = read("art-plan.widget.html");
  ok("widget.html is written", w.length > 0);
  // A fragment: the host injects it into its own document, so a doctype or a
  // <head> would either be ignored or break the surrounding page.
  ok("the widget is a fragment, not a document",
    !/<!doctype/i.test(w) && !/<html[\s>]/i.test(w) && !/<head[\s>]/i.test(w));
  ok("the widget opens with a screen-reader summary",
    w.trimStart().startsWith('<h2 class="dpsr">') && w.includes("alignment check"));
  ok("the widget renders one radio group per question, valued by letter",
    s.quiz.every(q => w.includes(`name="${q.id}" value="a"`)));
  ok("the widget's option order matches the key",
    s.quiz.every(q => {
      const order = qlibShuffle(q.options, "art-plan:" + q.id);
      return order.every((o, i) =>
        w.includes(`value="${String.fromCharCode(97 + i)}"><span>${String.fromCharCode(97 + i)}) ${o.v}`));
    }));
  ok("the widget sends a runnable grade command, in letters",
    w.includes('sendPrompt("Run: deep-plan grade art-plan "') && w.includes('+"="+'));
  // Every other surface here inlines the vendored mermaid; a widget that needs
  // the network to draw is a widget that renders blank on a train. Matched on
  // script SOURCES, not on substrings of the whole file — a 3 MB base64 blob
  // contains "cdn" (and most other short strings) by coincidence.
  ok("the widget inlines mermaid rather than fetching it over the network",
    w.includes('<script src="data:text/javascript;base64,') &&
    !/<script[^>]+src=["']https?:/i.test(w));
  // `checked` as an ATTRIBUTE would pre-select an answer. The string also
  // appears in the ':checked' selectors the script uses to count answers, so
  // the naive substring test fails on correct code.
  ok("the widget pre-selects nothing and embeds no key material",
    !/<input[^>]*\schecked/i.test(w) && !w.includes('"letter"') &&
    !w.includes('"answers"'));
  // The widget is injected into the HOST's document, so unescaped spec text
  // would execute in the client's page rather than merely break this file.
  {
    const hostile = JSON.parse(JSON.stringify(s));
    hostile.slug = "esc-plan";
    hostile.diagrams[0].mermaid = 'flowchart LR\n  A["a <b> & tag"] --> B[ok]';
    hostile.quiz[0].options[0] = 'an option with <script>alert(1)</script> & "quotes"';
    cli("render", tmpSpec(hostile), "--force");
    const hw = read("esc-plan.widget.html");
    ok("spec text is escaped in the widget's options and diagram source",
      hw.length > 0 && !hw.includes("<script>alert(1)</script>") &&
      hw.includes("&lt;script&gt;alert(1)&lt;/script&gt;") &&
      !hw.includes('"a <b> &') && hw.includes("a &lt;b&gt; &amp;"));
    ok("the widget's script tags balance",
      (hw.match(/<script/g) || []).length === (hw.match(/<\/script>/g) || []).length);
    cli("close", "esc-plan");
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "esc-plan.json"), { force: true });
  }

  // ---- cutover bundle
  const dir = P("art-plan.cutover");
  // Same tolerance for the bundle: a missing directory is an assertion
  // failure about the bundle, not a reason to stop testing everything after it.
  const lsDir = d => { try { return fs.readdirSync(d).sort(); } catch { return []; } };
  const readIn = (d, n) => { try { return fs.readFileSync(path.join(d, n), "utf8"); } catch { return ""; } };
  const names = lsDir(dir);
  ok("the cutover bundle has an epic, a README and one file per increment",
    names.includes("art-plan.epic.html") && names.includes("README.md") &&
    names.filter(n => /^\d\d-/.test(n)).length === s.deliverables.length);
  // Position, never a parse of the title: real plans have "Inc 2b".
  ok("increment files are numbered by array position",
    (names.filter(n => /^\d\d-/.test(n))[0] || "").startsWith("01-"));
  const inc1 = readIn(dir, names.find(n => n.startsWith("01-")) || "");
  ok("an increment file repeats the plan's context and decisions",
    inc1.includes("Why this exists") && inc1.includes("| Decision | Why |") &&
    inc1.includes(spec.context.slice(0, 40)));
  ok("an increment file carries its own files, commits and verification",
    inc1.includes("publisher retry") && inc1.includes("bundle exec rspec spec/outbox") &&
    (s.deliverables[0].files || []).every(f => inc1.includes(f)));
  ok("an increment file carries its observability gate",
    inc1.includes("not done until these pass") && inc1.includes("sum:outbox.retry{env:qa}"));
  // An unqualified whole-change checklist read as this task's definition of
  // done is how an increment gets called finished early.
  const inc2 = readIn(dir, names.filter(n => /^\d\d-/.test(n))[1] || "");
  ok("an increment with no verification of its own says the list is whole-change",
    inc2.includes("Whole-change verification"));
  ok("increment files point at rehydrate, not at an engine path",
    inc1.includes("deep-plan rehydrate art-plan") && !inc1.includes(".mjs"));
  ok("the README names every increment file",
    names.filter(n => /^\d\d-/.test(n))
      .every(n => readIn(dir, "README.md").includes(n)));

  // THE exclusion. The bundle is built from the same spec that holds the quiz,
  // so keeping it out is a choice that has to be asserted. Note this is about
  // the quiz STRUCTURE — a lone option that happens to name a method the plan
  // discusses will appear in the plan body, and must: the bundle is the plan.
  const bundle = lsDir(dir).map(n => readIn(dir, n)).join("\n");
  ok("no quiz prompt appears anywhere in the bundle",
    !s.quiz.some(q => bundle.includes(q.prompt)));
  ok("no question's option set is rendered together anywhere in the bundle",
    !s.quiz.some(q => q.options.filter(o => bundle.includes(o)).length > 1));
  ok("no answer key material appears in the bundle",
    !bundle.includes('"answers"') && !bundle.includes('"letter"') &&
    !bundle.includes("violationsForced"));
  ok("the epic carries the plan body and renders diagrams offline",
    read("art-plan.cutover/art-plan.epic.html").includes("Decisions") &&
    read("art-plan.cutover/art-plan.epic.html").includes("data:text/javascript;base64,"));

  // ---- one writer, both callers
  // force: teardown must not throw when the thing it is clearing was never
  // written — that turns four honest assertion failures into a stack trace.
  for (const n of ["art-plan.quiz.txt", "art-plan.widget.html"]) fs.rmSync(P(n), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  ok("rehydrate rewrites all three artifacts too",
    cli("rehydrate", "art-plan").status === 0 &&
    fs.existsSync(P("art-plan.quiz.txt")) && fs.existsSync(P("art-plan.widget.html")) &&
    fs.existsSync(path.join(dir, "art-plan.epic.html")));
  // rehydrate used to assume PLANS_DIR existed, because render creates it and
  // ~/.claude/plans is always there in practice.
  ok("rehydrate creates the plans directory if it is missing",
    (() => {
      const stash = ENV.DEEP_PLAN_PLANS_DIR + ".stash";
      fs.renameSync(ENV.DEEP_PLAN_PLANS_DIR, stash);
      const r = cli("rehydrate", "art-plan");
      const made = fs.existsSync(P("art-plan.md"));
      fs.rmSync(ENV.DEEP_PLAN_PLANS_DIR, { recursive: true, force: true });
      fs.renameSync(stash, ENV.DEEP_PLAN_PLANS_DIR);
      return r.status === 0 && made;
    })());

  // The quiz-less branch is unreachable through `render` — the linter refuses
  // fewer than three questions. It is reachable through `rehydrate`, which
  // re-renders the ARCHIVED spec without re-validating it, so a hand-edited
  // archive is exactly the case that hits it.
  {
    const arch = path.join(ENV.DEEP_PLAN_KEYS_DIR, "art-plan.spec.json");
    const keep = fs.readFileSync(arch, "utf8");
    fs.writeFileSync(arch, JSON.stringify({ ...JSON.parse(keep), quiz: [] }, null, 2));
    const r = cli("rehydrate", "art-plan");
    const txtNow = read("art-plan.quiz.txt");
    fs.writeFileSync(arch, keep);
    cli("rehydrate", "art-plan");
    ok("an archived spec with no quiz rehydrates instead of crashing",
      r.status === 0 && txtNow.includes("carries no quiz"));
  }

  cli("close", "art-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "art-plan.json"), { force: true });
}

// -------------------------------------------------- extension verbs
//
// The seam for work that cannot go in a public repo. A subprocess, not an
// import: the gate runs through this same engine, so an extension that throws
// or hangs must not be able to take it down — and a static import of an
// optional module fails at load time on every machine that lacks it, which is
// how the older engine wired its private modules and why they could not be
// deleted from it.
{
  const EXT = path.join(TMP, "ext");
  fs.mkdirSync(EXT, { recursive: true });
  // SKILL_DIR and the older spellings are deliberately STRIPPED from the parent
  // env here. runExt spreads process.env, so anything the probe already exports
  // would satisfy an assertion about what runExt passes — the test would hold
  // whether or not the code did its job.
  const extEnv = { ...ENV, DEEP_PLAN_EXT: EXT };
  delete extEnv.DEEP_PLAN_SKILL_DIR;
  delete extEnv.DEEP_PLAN_STATE;
  delete extEnv.DEEP_PLAN_KEYS;
  delete extEnv.DEEP_PLAN_PLANS;
  const ecli = (...args) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args],
    { encoding: "utf8", env: extEnv, cwd: REPO });
  const write = (n, body) => fs.writeFileSync(path.join(EXT, n), body);

  write("hello.mjs", 'console.log("EXTRAN:" + process.argv.slice(2).join(","));\n' +
    'console.log("STATE:" + process.env.DEEP_PLAN_STATE_DIR);\n' +
    'console.log("OLDSTATE:" + process.env.DEEP_PLAN_STATE);\n' +
    'console.log("SKILL:" + process.env.DEEP_PLAN_SKILL_DIR);\n' +
    'console.log("VERB:" + process.env.DEEP_PLAN_VERB);\n' +
    'process.exit(Number(process.env.RC || 0));\n');

  let e = ecli("hello", "one", "two");
  ok("an extension verb runs and receives its arguments",
    e.status === 0 && e.stdout.includes("EXTRAN:one,two"));
  ok("an extension is told where the state, keys and skill trees are",
    e.stdout.includes("STATE:" + ENV.DEEP_PLAN_STATE_DIR) &&
    e.stdout.includes("SKILL:" + HERE) && e.stdout.includes("VERB:hello"));
  // An override the extension ignores does not error — it writes to the
  // default tree. The first module ported into this seam hardcoded its paths
  // and wrote into the real ~/.claude/plans from a throwaway test tree.
  ok("the older env spellings are passed too, so a ported module is redirected",
    e.stdout.includes("OLDSTATE:" + ENV.DEEP_PLAN_STATE_DIR));

  e = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "hello"],
    { encoding: "utf8", env: { ...extEnv, RC: "7" }, cwd: REPO });
  ok("an extension's exit code is the CLI's exit code", e.status === 7);

  // A built-in must always win. A private file silently redefining the gate's
  // own vocabulary is the one thing this seam must never allow.
  write("status.mjs", 'console.log("SHADOW RAN");\n');
  e = ecli("status");
  ok("a built-in verb always beats an extension of the same name",
    e.status === 0 && !e.stdout.includes("SHADOW RAN"));
  ok("…and the usage says that file is shadowed rather than advertising it",
    /status\s+SHADOWED by the built-in/.test(ecli("--help").stdout));
  fs.rmSync(path.join(EXT, "status.mjs"));

  ok("usage lists the installed extension verbs and where they come from",
    ecli("--help").stdout.includes("extension verbs (" + EXT) &&
    /hello\s+from hello\.mjs/.test(ecli("--help").stdout));
  // A real extension directory holds helper modules beside the verbs — the
  // ported private ones here are `_compat.mjs`, `_obs_scaffold.mjs` and
  // `_metric_matrix.mjs`. Listing those as verbs would advertise commands that
  // cannot dispatch, since a leading underscore is not a legal verb name.
  write("_helper.mjs", "export const x = 1;\n");
  write("notes.txt", "not a module\n");
  ok("helper modules and non-modules are not listed as verbs",
    !/_helper/.test(ecli("--help").stdout) && !/notes/.test(ecli("--help").stdout) &&
    /hello\s+from hello\.mjs/.test(ecli("--help").stdout));
  ok("…and a helper module cannot be invoked as a verb",
    ecli("_helper").status === 1 && ecli("_helper").stdout.includes("plan as artifact"));

  // A verb becomes a filename, so it must not be able to become a path.
  fs.writeFileSync(path.join(TMP, "outside.mjs"), 'console.log("ESCAPED");\n');
  for (const bad of ["../outside", "../../etc/hosts", "/etc/hosts", "Hello", "hello/../hello", ".hidden"]) {
    const r = ecli(bad);
    ok(`the verb "${bad}" cannot reach a file outside the extension directory`,
      r.status === 1 && !r.stdout.includes("ESCAPED") &&
      r.stdout.includes("plan as artifact"));
  }

  // An extension that blows up must fail loudly and locally, never take the
  // engine (and therefore the gate) with it.
  write("boom.mjs", 'throw new Error("extension exploded");\n');
  e = ecli("boom");
  ok("an extension that throws fails without breaking the engine",
    e.status !== 0 && /extension exploded/.test(e.stderr) &&
    ecli("status").status === 0);
  // Killed rather than exited: spawnSync reports status null and a signal, and
  // a null status must not read as success.
  write("suicide.mjs", 'process.kill(process.pid, "SIGTERM");\n');
  e = ecli("suicide");
  ok("an extension killed by a signal exits non-zero and says which signal",
    e.status === 1 && /killed by SIGTERM/.test(e.stderr));

  // The whole point of the default: a machine with no extensions behaves
  // exactly as it did before the seam existed.
  const noExt = { ...ENV, DEEP_PLAN_EXT: path.join(TMP, "no-such-ext") };
  const ncli = (...a) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...a],
    { encoding: "utf8", env: noExt, cwd: REPO });
  ok("with no extension directory an unknown verb still exits 1 with usage",
    ncli("bogus-verb").status === 1 && ncli("bogus-verb").stdout.includes("plan as artifact"));
  ok("…and says so, rather than leaving the seam invisible",
    ncli("--help").stdout.includes("no extension verbs installed"));
  ok("help still exits 0 with no extensions", ncli("--help").status === 0);
}

// -------------------------------------------------- `done` writes the patch, never opens it
//
// A state transition must not seize a browser split. `done` used to spawn
// `cmux diff`, which stole focus on every increment and — because cmux diff
// targets $CMUX_WORKSPACE_ID by default — landed somewhere unrelated whenever
// `done` came from the board chip or any detached process.
//
// Tested by putting a fake `cmux` first on PATH that records its arguments, so
// "does not open" is observed rather than assumed.
{
  const BIN = path.join(TMP, "fakebin");
  fs.mkdirSync(BIN, { recursive: true });
  const LOG = path.join(TMP, "cmux-calls.log");
  fs.writeFileSync(path.join(BIN, "cmux"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(LOG)}\nexit 0\n`);
  fs.chmodSync(path.join(BIN, "cmux"), 0o755);
  const spyEnv = { ...ENV, PATH: BIN + path.delimiter + process.env.PATH };
  const scli = (...args) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args],
    { encoding: "utf8", env: spyEnv, cwd: REPO });
  const calls = () => { try { return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };

  const s = { ...spec, slug: "diff-plan" };
  scli("render", tmpSpec(s));
  const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "diff-plan.key.json"), "utf8"));
  scli("grade", "diff-plan", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
  scli("go", "diff-plan", "1");
  scli("start", "diff-plan", "1");
  // Real work, so the patch is non-empty — an empty patch returns early.
  fs.writeFileSync(path.join(REPO, "worked.txt"), "a change worth reviewing\n");

  passAll("diff-plan", 1, scli);
  fs.writeFileSync(LOG, "");
  const doneOut = scli("done", "diff-plan", "1");
  const patch = path.join(ENV.DEEP_PLAN_PLANS_DIR, "diff-plan.inc1.patch");
  ok("done still writes the increment patch", doneOut.status === 0 && fs.existsSync(patch) &&
    fs.readFileSync(patch, "utf8").includes("worked.txt"));
  ok("done does NOT open cmux diff", calls().length === 0);
  ok("…and says where the patch is instead",
    doneOut.stdout.includes(patch) && /deep-plan diff diff-plan 1/.test(doneOut.stdout));

  // The explicit request is the one thing that should open a split.
  fs.writeFileSync(LOG, "");
  const diffOut = scli("diff", "diff-plan", "1");
  ok("deep-plan diff DOES open cmux diff", diffOut.status === 0 && calls().length === 1 &&
    /^diff --title .* since /.test(calls()[0]) && calls()[0].includes(patch));

  // A broken or absent cmux must degrade to the path, not fail the command.
  fs.writeFileSync(path.join(BIN, "cmux"), "#!/bin/sh\nexit 3\n");
  fs.chmodSync(path.join(BIN, "cmux"), 0o755);
  const brokeOut = scli("diff", "diff-plan", "1");
  ok("a failing cmux degrades to printing the patch path",
    brokeOut.status === 0 && brokeOut.stdout.includes(patch));

  fs.rmSync(path.join(REPO, "worked.txt"), { force: true });
  execSync("git add -A && git -c user.email=p@p -c user.name=p commit -q -m cleanup --allow-empty", { cwd: REPO });
  scli("close", "diff-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "diff-plan.json"), { force: true });
}

// -------------------------------------------------- owner: session and workspace
//
// A plan records who last touched it from inside a session, so the seamux-mods
// pane can find it when its root is another repo, and pick the newest of
// back-to-back plans in one workspace. Claude Code exports
// CLAUDE_CODE_SESSION_ID; the older CLAUDE_SESSION_ID name was read before and
// never set, which left every plan's session empty.
{
  const as = (env, ...args) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args],
    { encoding: "utf8", env: { ...ENV, ...env }, cwd: REPO });
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  const rowOf = n => JSON.parse(cli("status", "--json").stdout).find(r => r.slug === n);
  const S1 = { CLAUDE_CODE_SESSION_ID: "sess-a", CMUX_WORKSPACE_ID: "ws-1" };

  const s = JSON.parse(JSON.stringify(spec)); s.slug = "owner-1";
  as(S1, "render", tmpSpec(s));
  const st = stOf("owner-1");
  ok("render stamps the session from CLAUDE_CODE_SESSION_ID",
    st.session === "sess-a" && st.owner && st.owner.session === "sess-a");
  ok("render stamps the cmux workspace", st.owner && st.owner.workspace === "ws-1");
  const row = rowOf("owner-1");
  ok("status --json carries the owner and a touchedAt",
    row && row.session === "sess-a" && row.owner.workspace === "ws-1" &&
    row.touchedAt === st.owner.at);

  // A write with no session (the board's chip, a plain shell) keeps the owner.
  const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "owner-1.key.json"), "utf8"));
  cli("grade", "owner-1", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
  cli("go", "owner-1", "1");
  ok("a write with no session in its environment leaves the owner as it was",
    stOf("owner-1").owner.session === "sess-a" && stOf("owner-1").increments[0].status === "authorized");

  // The legacy name is still read, and a later session takes ownership.
  as({ CLAUDE_SESSION_ID: "sess-old", CMUX_WORKSPACE_ID: "ws-1" }, "start", "owner-1", "1");
  ok("the older CLAUDE_SESSION_ID is still read", stOf("owner-1").owner.session === "sess-old");
  as({ CLAUDE_CODE_SESSION_ID: "sess-b", CMUX_WORKSPACE_ID: "ws-2" }, "block", "owner-1", "1", "probe");
  ok("the newest session and workspace to write take ownership",
    stOf("owner-1").owner.session === "sess-b" && stOf("owner-1").owner.workspace === "ws-2" &&
    stOf("owner-1").session === "sess-b");

  // A plan whose state predates owners still reports when it last moved.
  const s2 = JSON.parse(JSON.stringify(spec)); s2.slug = "owner-2";
  cli("render", tmpSpec(s2));
  const row2 = rowOf("owner-2");
  ok("a plan with no owner reports null and its state file's time",
    row2 && row2.owner === null && row2.session === "" && row2.touchedAt > 0);

  for (const n of ["owner-1", "owner-2"]) cli("close", n);
}

// -------------------------------------------------- families
// A parent plan names child plans that already exist; membership lives only in
// the parent's index, claims compare as (repo, repo-relative path) across
// worktrees, and render refuses what would leave a path with two owners plans.
{
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  const FR = path.join(TMP, "famrepo");
  const FW = path.join(TMP, "famrepo.worktrees");
  fs.mkdirSync(FR, { recursive: true });
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: FR });
  const API = path.join(FW, "api"), UI = path.join(FW, "ui");
  execSync(`git worktree add -q -b api ${API} && git worktree add -q -b ui ${UI}`, { cwd: FR });
  // A second repository, for claims that must not collide across repos.
  const OR = path.join(TMP, "otherrepo");
  fs.mkdirSync(OR); execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: OR });

  const child = (slug, files) => {
    const c = JSON.parse(JSON.stringify(spec));
    c.slug = slug;
    c.deliverables = c.deliverables.map((d, i) => ({ ...d, files: i === 0 ? files : [] }));
    return c;
  };
  const fam = JSON.parse(fs.readFileSync(path.join(HERE, "examples", "example.family.spec.json"), "utf8"));
  const famIdx = () => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "families", fam.slug, "index.json"), "utf8"));

  let r = cli("render", tmpSpec(fam), "--root", FR);
  ok("a parent naming plans that do not exist is refused",
    r.status !== 0 && /no tracked plan by that slug/.test(r.stderr));

  // Children rendered on their own, before any family: adoption must not touch them.
  r = cli("render", tmpSpec(child("example-auth-api", ["api/auth/session.ts", "package-lock.json", "README.md"])), "--root", API);
  ok("child api renders", r.status === 0);
  r = cli("render", tmpSpec(child("example-auth-ui", ["web/login/form.tsx", "api/auth/session.ts", "package-lock.json"])), "--root", UI);
  ok("child ui renders", r.status === 0);
  r = cli("render", tmpSpec(child("example-docs", ["README.md"])), "--root", OR);
  ok("child docs (another repo) renders", r.status === 0);
  // The guard's cost is measured against the same edit before any family exists.
  cli("open-gate", "example-auth-ui");
  const gateAs = (session, target, cwd = UI) => spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], {
    encoding: "utf8", env: ENV,
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: target }, cwd, session_id: session }),
  });
  const timeEdits = () => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < 10; i++) gateAs("timing", path.join(UI, "web", "login", "form.tsx"));
    return Number(process.hrtime.bigint() - t) / 10e6;
  };
  const famless = timeEdits();
  const before = fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "example-auth-ui.json"), "utf8");

  const withDocs = { ...fam, workstreams: [...fam.workstreams, { slug: "example-docs", owns: ["README.md"] }] };
  r = cli("render", tmpSpec(withDocs), "--root", FR);
  ok("the parent renders once its children exist", r.status === 0 && /family example-auth-revamp: 3 workstream/.test(r.stdout));
  const idx = famIdx();
  const m = s => idx.members.find(x => x.slug === s);
  ok("the index holds the parent and every child",
    idx.members.length === 4 && m("example-auth-revamp").role === "parent" && m("example-auth-ui").role === "child");
  ok("worktrees of one repo share a repo id; another repo does not",
    m("example-auth-api").repo === m("example-auth-ui").repo && m("example-auth-api").repo === m("example-auth-revamp").repo &&
    m("example-docs").repo !== m("example-auth-api").repo && m("example-docs").repo !== "");
  ok("adopting a child leaves its state untouched",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "example-auth-ui.json"), "utf8") === before);
  ok("a child's deliverable inside a sibling's glob is reported",
    /example-auth-ui deliverable 1 names api\/auth\/session\.ts — owned by example-auth-api \(api\/auth\/\*\*\)/.test(r.stderr));
  ok("a shared path is not an overlap", !/package-lock/.test(r.stderr));
  ok("the same path in two repos is not an overlap", !/README/.test(r.stderr));
  ok("the parent's surfaces list the workstreams",
    /## Workstreams/.test(fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, fam.slug + ".md"), "utf8")) &&
    /<h2>Workstreams<\/h2>/.test(fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, fam.slug + ".review.html"), "utf8")));
  r = cli("rehydrate", fam.slug);
  ok("a parent rehydrates byte-identical", r.status === 0 && /byte-identical/.test(r.stdout));

  // One family per plan, and roots that never nest or coincide.
  r = cli("render", tmpSpec({ ...fam, slug: "example-rival", workstreams: [{ slug: "example-auth-api" }] }), "--root", OR);
  ok("a second parent claiming a member is refused",
    r.status !== 0 && /example-auth-api already belongs to family example-auth-revamp/.test(r.stderr));
  r = cli("render", tmpSpec(child("example-squatter", [])), "--root", FR);
  r = cli("render", tmpSpec({ ...withDocs, workstreams: [...withDocs.workstreams, { slug: "example-squatter" }] }), "--root", FR);
  ok("a child sharing the parent's root is refused", r.status !== 0 && /roots collide/.test(r.stderr));
  cli("close", "example-squatter");

  // Shape is judged before anything else.
  r = cli("render", tmpSpec({ ...fam, workstreams: [{ slug: "example-auth-api", after: [9] }] }), "--root", FR);
  ok("after must name the parent's own increments", r.status !== 0 && /after must list this plan's increment numbers/.test(r.stderr));
  r = cli("render", tmpSpec({ ...fam, workstreams: [{ slug: "example-auth-api", owns: [{ glob: "" }] }] }), "--root", FR);
  ok("a claim must carry a glob", r.status !== 0 && /owns\[0\] must be a glob/.test(r.stderr));

  // A child's re-render moves its derived claims in the index.
  r = cli("render", tmpSpec(child("example-auth-ui", ["web/login/form.tsx", "package-lock.json"])), "--root", UI);
  ok("a child's re-render refreshes the family", r.status === 0 && /family example-auth-revamp: claims refreshed/.test(r.stdout));
  ok("…and its derived claims follow the spec",
    !famIdx().members.find(x => x.slug === "example-auth-ui").derived.some(d => d.path === "api/auth/session.ts"));

  // The soft guard: allowed, told once per session and path, recorded.
  {
    const note = r => { try { return JSON.parse(r.stdout).hookSpecificOutput || null; } catch { return null; } };
    let g = gateAs("s1", path.join(UI, "api", "auth", "session.ts"));
    const h = note(g);
    ok("an edit into a sibling's claim is allowed", g.status === 0);
    ok("…and the agent is told who owns it",
      h && h.hookEventName === "PreToolUse" && /api\/auth\/session\.ts/.test(h.additionalContext) &&
      /workstream example-auth-api owns it \(api\/auth\/\*\*\)/.test(h.additionalContext) && /example-auth-ui/.test(h.additionalContext));
    ok("…and the guard never sets a permission decision", h && !("permissionDecision" in h) && !/"decision"/.test(g.stdout));
    g = gateAs("s1", path.join(UI, "api", "auth", "session.ts"));
    ok("the same session is told once per path", g.status === 0 && !note(g));
    g = gateAs("s2", path.join(UI, "api", "auth", "session.ts"));
    ok("another session is told again", note(g) !== null);
    g = gateAs("s1", path.join(UI, "web", "login", "form.tsx"));
    ok("an edit inside its own claim is silent", g.status === 0 && g.stdout.trim() === "");
    g = gateAs("s1", path.join(UI, "package-lock.json"));
    ok("an edit to a shared path is silent", g.status === 0 && g.stdout.trim() === "");
    g = gateAs("s1", path.join(UI, "notes", "scratch.md"));
    ok("an unclaimed path is silent", g.status === 0 && g.stdout.trim() === "");
    cli("open-gate", "example-auth-api");
    g = gateAs("s1", path.join(API, "web", "login", "form.tsx"));
    ok("editing a sibling's worktree outright is named as such",
      note(g) && /web\/login\/form\.tsx .*it sits in workstream example-auth-api's worktree/.test(note(g).additionalContext));
    g = gateAs("s1", path.join(REPO, "x.txt"), REPO);
    ok("a session outside every family is never told", g.stdout.trim() === "");
    const log = fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "families", fam.slug, "trespass.jsonl"), "utf8")
      .trim().split("\n").map(l => JSON.parse(l));
    if (V) console.log("  trespass log: " + JSON.stringify(log.map(l => [l.session, l.path, l.how])));
    ok("each told trespass is recorded once",
      log.length === 3 && log[0].from === "example-auth-ui" && log[0].owner === "example-auth-api" &&
      log[0].path === "api/auth/session.ts" && log[0].session === "s1" && log[1].session === "s2");
    const withFamily = timeEdits();
    console.log(`\n  family guard: ${(withFamily - famless).toFixed(1)} ms/edit over the same edit with no family (${famless.toFixed(1)} → ${withFamily.toFixed(1)})`);
    ok("the family guard costs under 15 ms per edit", withFamily - famless < 15);
  }

  // Sequencing: a child whose workstream names parent increments in `after`
  // cannot go until they are done; --force is the logged way past.
  {
    const gradeRight = slug => {
      const k = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, slug + ".key.json"), "utf8"));
      return cli("grade", slug, ...Object.entries(k.answers).map(([q, a]) => `${q}=${a.letter}`));
    };
    const apiState = () => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "example-auth-api.json"), "utf8"));
    ok("the child passes its own alignment check", gradeRight("example-auth-api").status === 0);
    let g = cli("go", "example-auth-api", "next");
    const lines = g.stderr.trim().split("\n");
    ok("go on a child waiting on its parent is refused, the reason on the last line",
      g.status !== 0 && /^go refused: waits on example-auth-revamp increment 1$/.test(lines[lines.length - 1]) &&
      /Shared session type\) is pending/.test(g.stderr));
    ok("…and nothing was authorized", apiState().increments.every(i => i.status === "pending"));
    cli("shut-gate", "example-auth-api");
    const row = JSON.parse(cli("status", "--json").stdout).find(x => x.slug === "example-auth-api");
    ok("a waiting child's shut gate says what it waits on",
      row && !row.gate.allow && /go waits on example-auth-revamp increment 1 \(Shared session type\) is pending/.test(row.gate.why));
    const e = gateAs("s9", path.join(API, "api", "auth", "x.ts"), API);
    ok("the edit refusal says it too", e.status === 2 && /go waits on example-auth-revamp increment 1/.test(e.stderr));
    g = cli("go", "example-auth-api", "1", "--force");
    ok("go --force passes the wait and logs it",
      g.status === 0 && apiState().increments[0].status === "authorized" &&
      apiState().log.some(l => /--force past the family wait: example-auth-revamp increment 1/.test(l.what)));
    // The parent lands increment 1; the wait clears for the next go.
    gradeRight(fam.slug);
    cli("go", fam.slug, "1"); cli("done", fam.slug, "1", "--force");
    g = cli("go", "example-auth-api", "2");
    ok("once the parent increment is done, go goes", g.status === 0 && apiState().increments[1].status === "authorized");
    ok("a workstream with no after never waits", cli("go", "example-docs", "next").stderr.indexOf("waits on") === -1);
    cli("open-gate", "example-auth-api");
  }

  // News: pulled at the next prompt, factual, cursor per member.
  {
    const newsAs = (cwd, event = "UserPromptSubmit") => {
      const r = spawnSync("bash", [path.join(HERE, "hooks", "news.sh")], {
        encoding: "utf8", env: ENV, input: JSON.stringify({ hook_event_name: event, cwd, session_id: "n1", prompt: "hi" }),
      });
      let h = null;
      try { h = JSON.parse(r.stdout).hookSpecificOutput; } catch { /* none */ }
      return { status: r.status, h, text: h ? h.additionalContext : "" };
    };
    let n = newsAs(UI, "SessionStart");
    ok("a member's first look is an orientation",
      n.status === 0 && n.h && n.h.hookEventName === "SessionStart" &&
      /example-auth-ui\) is a workstream of deep-plan family example-auth-revamp/.test(n.text) && /claims web\/login\/\*\*/.test(n.text));
    n = newsAs(UI);
    ok("nothing new says nothing", n.status === 0 && n.h === null);
    newsAs(API); newsAs(FR);                       // every member has looked once
    cli("done", "example-auth-api", "2", "--force");
    n = newsAs(UI);
    ok("a sibling's finished increment is news", /example-auth-api finished increment 2 \(/.test(n.text));
    n = newsAs(FR);
    ok("…for the parent too", /example-auth-api finished increment 2/.test(n.text));
    gateAs("s7", path.join(UI, "api", "auth", "z.ts"));
    n = newsAs(API);
    ok("an edit into a member's claim is news to its owner",
      /example-auth-ui edited api\/auth\/z\.ts, which example-auth-api claims \(api\/auth\/\*\*\)/.test(n.text));
    // A commit on the base branch that touches the member's claim.
    fs.mkdirSync(path.join(FR, "web", "login"), { recursive: true });
    fs.writeFileSync(path.join(FR, "web", "login", "banner.tsx"), "export {}\n");
    execSync(`git add -A && ${G} commit -q -m "login banner"`, { cwd: FR });
    const peek = cli("family", "news", "example-auth-ui");
    ok("family news shows it without moving the cursor", /gained \w+ login banner touching web\/login\/banner\.tsx/.test(peek.stdout));
    n = newsAs(UI);
    ok("a base commit touching a member's claim is news", /gained \w+ login banner touching web\/login\/banner\.tsx/.test(n.text));
    ok("…and only that member hears of it", !/banner/.test(newsAs(API).text));
    // The parent changes a contract the ui workstream consumes.
    const amended = { ...withDocs, contracts: withDocs.contracts.map(c => ({ ...c, reach: c.reach + "; also the mobile app" })) };
    cli("render", tmpSpec(amended), "--root", FR);
    n = newsAs(UI);
    ok("a consumed contract that changed shape is news", /contract "POST \/session" changed/.test(n.text));
    ok("a session outside every family hears nothing", newsAs(REPO).h === null);
    const st = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "families", fam.slug, "seen", "example-auth-ui.json"), "utf8"));
    ok("the cursor is stored per member", st.at > 0 && st.contracts["POST /session"]);
  }

  // Status rows carry the family; rows outside one do not change.
  {
    const rows = JSON.parse(cli("status", "--json").stdout);
    const ui = rows.find(x => x.slug === "example-auth-ui"), par = rows.find(x => x.slug === fam.slug);
    const f = ui && ui.family;
    ok("a child's row names its family and role", f && f.role === "child" && f.parent === fam.slug);
    ok("…lists every member with progress",
      f && f.members.length === 4 && f.members.some(m => m.slug === "example-auth-api" && m.done === 1 && m.total === 2));
    ok("…its claims and its after", f && f.owns.join() === "web/login/**" && f.after.join() === "1" && f.waitingOn.length === 0);
    ok("…and the overlaps it took part in",
      f && f.trespasses.total >= 1 && f.trespasses.pairs.some(p => p.from === "example-auth-ui" && p.owner === "example-auth-api"));
    ok("the parent's row counts every overlap in the family",
      par && par.family.role === "parent" && par.family.trespasses.total >= f.trespasses.total && par.family.done === false);
    ok("a plan in no family has no family field", rows.filter(x => !x.slug.startsWith("example-")).every(x => !("family" in x)));
    ok("board-facing keys keep their shape", ui && typeof ui.gate.allow === "boolean" && typeof ui.progress.total === "number");
    const t = cli("status").stdout;
    ok("text status prints the family line", /family example-auth-revamp \(child\)/.test(t));
    const fs2 = cli("family", "status", "example-auth-ui");
    ok("family status shows every member",
      fs2.status === 0 && /◆ example-auth-revamp/.test(fs2.stdout) && /◇ example-auth-ui/.test(fs2.stdout) &&
      /example-auth-ui edited example-auth-api's claims/.test(fs2.stdout));
  }

  // family check: what a worktree actually touched, Bash writes included.
  r = cli("family", "check", fam.slug);
  ok("family check is clean before anyone strays", r.status === 0 && /no member has touched/.test(r.stdout));
  fs.mkdirSync(path.join(UI, "api", "auth"), { recursive: true });
  fs.writeFileSync(path.join(UI, "api", "auth", "token.ts"), "export {}\n");
  r = cli("family", "check", fam.slug, "--json");
  const hits = r.status === 1 ? JSON.parse(r.stdout).overlaps : [];
  ok("family check names a file written into a sibling's claim",
    hits.some(h => h.slug === "example-auth-ui" && h.path === "api/auth/token.ts" && h.owner === "example-auth-api"));
  r = cli("family", "check", "example-auth-ui");
  ok("family check accepts a member's slug", r.status === 1 && /example-auth-ui touched api\/auth\/token\.ts/.test(r.stdout));
  fs.rmSync(path.join(UI, "api"), { recursive: true, force: true });

  // family init: a parent drafted from plans that already exist.
  r = cli("family", "init", "example-draft", "example-auth-api", "example-auth-ui");
  let draft = null;
  try { draft = JSON.parse(r.stdout); } catch { /* asserted below */ }
  ok("family init drafts workstreams with suggested globs",
    r.status === 0 && draft && draft.workstreams.length === 2 &&
    draft.workstreams[0].owns.includes("api/auth/**") && draft.workstreams[0].owns.includes("package-lock.json"));
  ok("family init reports what the plans already share",
    /example-auth-api deliverable 1 and example-auth-ui deliverable 1 both name package-lock\.json/.test(r.stderr));
  r = cli("family", "init", "example-draft", "example-nope");
  ok("family init refuses an unknown plan", r.status !== 0 && /example-nope: no tracked plan/.test(r.stderr));

  // Dropping the workstreams dissolves the family; the index is kept as history.
  const { workstreams, ...solo } = withDocs;
  r = cli("render", tmpSpec(solo), "--root", FR);
  ok("a parent without workstreams dissolves its family",
    r.status === 0 && /dissolved/.test(r.stdout) &&
    !fs.existsSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "families", fam.slug, "index.json")) &&
    fs.existsSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "families", fam.slug, "index.dissolved.json")));
  for (const n of [fam.slug, "example-auth-api", "example-auth-ui", "example-docs"]) cli("close", n);
}

// -------------------------------------------------- a new directory under a symlinked root
// macOS spells the temp tree /var/… and resolves it to /private/var/…. A file
// in a directory that does not exist yet has to resolve through its nearest
// existing ancestor, or the gate reads it as outside every root.
{
  const SR = fs.mkdtempSync(path.join(os.tmpdir(), "dp-symroot-"));
  execSync("git init -q", { cwd: SR });
  const sym = { ...JSON.parse(JSON.stringify(spec)), slug: "symlinked-root" };
  cli("render", tmpSpec(sym), "--root", SR);
  ok("a new file in a new directory under a gated root is refused",
    edit(path.join(SR, "fresh", "deeper", "new.ts")).status === 2);
  cli("close", "symlinked-root");
  fs.rmSync(SR, { recursive: true, force: true });
}

// -------------------------------------------------- hot-path cost
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) gate("Edit", { file_path: "/tmp/x" }, TMP);
const ms = Number(process.hrtime.bigint() - t0) / 20e6;
console.log(`\n  hot path (state files present, path untracked): ${ms.toFixed(1)} ms/call over 20`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ndeep-plan probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
