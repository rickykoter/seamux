#!/usr/bin/env node
// deep-plan probe — one command, no arguments, throwaway everything.
// Asserts both directions: blocks what it should, and NEVER what it should not.
// `-v` walks it step by step (the probe is also the demo).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verdict } from "./lib/evidence.mjs";
import { resolver, resolveFiles, matchesGlob, recipeHash, load as loadVerify } from "./lib/verify.mjs";
import { pruneEvidence, readEvidence } from "./lib/browser.mjs";
import { classifyScript } from "./lib/detect.mjs";
import * as HOST from "./lib/host.mjs";
import * as HOST_TWIN from "../lookout/lib/host.mjs";

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
  // Authoritative and empty: no lookout, so `diff` falls back to cmux diff and
  // nothing reaches the machine's real reviews. The review block sets its own.
  LOOKOUT_ENGINE: "",
};
delete ENV.DEEP_PLAN_SKILL_DIR;
delete ENV.DEEP_PLAN_ENGINE;
// A probe run from inside a Claude session must not stamp that session (or its
// cmux workspace) as the owner of every throwaway plan; the owner block below
// sets them explicitly.
delete ENV.CLAUDE_CODE_SESSION_ID;
delete ENV.CLAUDE_SESSION_ID;
delete ENV.CMUX_WORKSPACE_ID;
// Host signals come from the session running the probe; each test sets its own.
for (const k of ["SEAMUX_HOST", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_ENTRYPOINT", "DEEP_PLAN_SERVE_FILE", "LOOKOUT_SERVE_FILE"]) delete ENV[k];
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

bad = JSON.parse(JSON.stringify(spec));
bad.diagrams[0].simple = 'flowchart LR\n  A --> B[\\"broken label]';
{
  const rr = cli("render", tmpSpec(bad));
  ok("a broken overview diagram is refused like a detailed one (or says it skipped)",
    (rr.status !== 0 && /overview/.test(rr.stderr)) || /validation skipped/.test(rr.stderr));
}
bad = JSON.parse(JSON.stringify(spec));
bad.diagrams[0].simple = { not: "a string" };
ok("refuses an overview that is not mermaid source", cli("render", tmpSpec(bad)).status !== 0);

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
// The page's own copy says "answer", so a word search proves nothing. A page
// that carries no key in any form cannot depend on it: the same plan with every
// correct option moved must render byte-identical.
{
  const a = { ...JSON.parse(JSON.stringify(spec)), slug: "key-leak-plan" };
  const b = JSON.parse(JSON.stringify(a));
  for (const q of b.quiz) q.answer = (q.answer + 1) % q.options.length;
  const page = s => cli("render", tmpSpec(s), "--force").status === 0 &&
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "key-leak-plan.review.html"), "utf8");
  const pa = page(a), pb = page(b);
  ok("review page never contains the answer key",
    !review.includes('"answers"') && typeof pa === "string" && pa === pb);
  cli("close", "key-leak-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "key-leak-plan.json"), { force: true });
}
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
  fs.mkdirSync(path.join(EVREPO, ".seamux"), { recursive: true });
  fs.writeFileSync(path.join(EVREPO, ".seamux", "verify.json"), "{\n  \"recipes\": []\n}\n");
  const ev = JSON.parse(JSON.stringify(spec));
  ev.slug = "evidence-probe";
  ev.verifiedFacts = [
    { claim: "a fine citation", evidence: "src/real.txt:3-5" },
    { claim: "line out of range", evidence: "src/real.txt:99" },
    { claim: "file is gone", evidence: "gone.txt:1" },
    { claim: "free prose evidence stays legal", evidence: "the search came up empty" },
    { claim: "a dotfile tree resolves", evidence: ".seamux/verify.json:2" },
  ];
  const r1 = cli("render", tmpSpec(ev), "--root", EVREPO);
  ok("evidence: warnings never refuse the render", r1.status === 0);
  ok("evidence: out-of-range line is warned with the file's real length",
    /src\/real\.txt:99 — the file ends at line 10/.test(r1.stderr));
  ok("evidence: missing file is warned", /gone\.txt:1 — no such file/.test(r1.stderr));
  ok("evidence: a resolvable citation and free prose stay silent",
    !/real\.txt:3/.test(r1.stderr) && !(/prose/.test(r1.stderr)));
  ok("evidence: a citation under a dotfile tree keeps its dot and resolves",
    !/verify\.json/.test(r1.stderr));

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
  review.includes('getAttribute("data-theme")==="light"') && review.includes('theme: "base"') &&
  review.includes("startOnLoad: false"));
// The reading layer (lib/surface.mjs): shell, rail, find, diagram cards,
// file trees, comments kept where they were left, drafts kept across reloads.
{
  const working0 = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".working.html"), "utf8");
  const both = [review, working0];
  ok("both surfaces carry the shell: rail, main column, comment margin",
    both.every(h => h.includes('id="dp-rail"') && h.includes('id="dp-main"') && h.includes('id="dp-margin"') &&
      h.includes("window.DP_PAGE=")));
  ok("both surfaces carry find with case, word, regex and fuzzy toggles",
    both.every(h => ['data-o="c"', 'data-o="w"', 'data-o="r"', 'data-o="z"', "fuzzyTok", "new RegExp(src"].every(x => h.includes(x))));
  ok("comments are painted where they were left and re-anchor by quote",
    both.every(h => h.includes('paint("dp-note"') && h.includes("resolveNote") && h.includes("::highlight(dp-note)")));
  ok("drafts are kept per plan and surface, and auto-refresh waits on them",
    both.every(h => h.includes('key("drafts")')) && working0.includes("window.dpBusy && window.dpBusy()"));
  ok("a diagram with an overview renders Overview/Detailed tabs, overview first",
    review.includes('data-view="simple" aria-selected="true">Overview') &&
    review.indexOf('class="dp-dg-view" data-view="simple"') < review.indexOf('class="dp-dg-view" data-view="detailed"') &&
    review.includes("a timer tries again") && review.includes("<h2>Diagrams</h2>"));
  ok("diagrams zoom and open full screen", review.includes('data-z="full"') && review.includes("openLb"));
  ok("file lists render names, keeping the full path as the open target",
    review.includes('data-file="app/workers/retry_sweep.rb" title="app/workers/retry_sweep.rb">retry_sweep.rb</span>'));
  ok("increments carry anchors for the rail; working rows carry their status",
    review.includes('id="inc-1"') && /id="inc-1" data-status="\w+"/.test(working0));
  const md0 = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, spec.slug + ".md"), "utf8");
  ok("the md plan carries the overview before the detailed diagram",
    md0.indexOf("Overview:") > 0 && md0.indexOf("Overview:") < md0.indexOf("Detailed:"));
}
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
  // A house template that is not there refuses the render by name, before any
  // write. It used to throw ENOENT after the surfaces and before the state.
  fs.writeFileSync(path.join(REPO3, ".seamux", "adr.json"), JSON.stringify({ template: "docs/typo.md" }));
  const tr = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "render", tmpSpec({ ...cSpec, slug: "typo-tpl-plan" })],
    { encoding: "utf8", env: ENV, cwd: REPO3 });
  ok("a missing house template refuses the render by name, before any write",
    tr.status === 1 && /template file missing: docs\/typo\.md/.test(tr.stderr) && !/ENOENT/.test(tr.stderr) &&
    !fs.existsSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "typo-tpl-plan.md")) &&
    !fs.existsSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "typo-tpl-plan.key.json")));
}

// -------------------------------------------------- re-render --root resolves against the new root
// The recovery for a moved root is `render --root NEW`; the floors used to
// keep reading the recorded (gone) root, so the new one was never checked.
{
  const RA = path.join(TMP, "root-a"), RB = path.join(TMP, "root-b");
  for (const d of [RA, RB]) { fs.mkdirSync(d, { recursive: true }); execSync("git init -q", { cwd: d }); }
  fs.writeFileSync(path.join(RB, "only-in-b.txt"), "x\n");
  const mv = JSON.parse(JSON.stringify(spec));
  mv.slug = "moved-root-plan";
  mv.deliverables[0].files.push("only-in-b.txt");
  ok("a plan renders at its first root", cli("render", tmpSpec(mv), "--root", RA).status === 0);
  const rb = cli("render", tmpSpec(mv), "--root", RB);
  ok("a re-render with --root runs the read-before-plan floor on the new root",
    rb.status === 1 && /edits only-in-b\.txt — no verifiedFact cites it/.test(rb.stderr));
  cli("close", "moved-root-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "moved-root-plan.json"), { force: true });
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

// -------------------------------------------------- redraw + overviews
// The migration for a new engine: redraw re-renders surfaces with spec and
// state untouched; overviews adds plain-words diagrams through mermaid.
{
  const rs = JSON.parse(JSON.stringify(spec));
  rs.slug = "redraw-plan";
  rs.diagrams.forEach(d => delete d.simple);
  ok("redraw fixture renders", cli("render", tmpSpec(rs)).status === 0);
  const P = n => path.join(ENV.DEEP_PLAN_PLANS_DIR, n);
  fs.writeFileSync(P("redraw-plan.spec.json"), JSON.stringify(rs, null, 2));
  const stP = path.join(ENV.DEEP_PLAN_STATE_DIR, "redraw-plan.json");
  const st0 = fs.readFileSync(stP, "utf8");
  const hash0 = JSON.parse(cli("export-artifact", "redraw-plan", "--json").stdout).spec_hash;
  let o = cli("redraw", "redraw-plan", "--dry-run");
  ok("redraw --dry-run names plans missing overviews and writes nothing",
    o.status === 0 && /would redraw redraw-plan · 1 diagram without an overview/.test(o.stdout));
  fs.writeFileSync(P("redraw-plan.review.html"), "<html>an old engine's page</html>");
  fs.writeFileSync(P("redraw-plan.working.html"), "<html>an old engine's page</html>");
  o = cli("redraw", "redraw-plan");
  ok("redraw brings an old plan's review and working pages onto this engine",
    o.status === 0 && /redrew redraw-plan/.test(o.stdout) &&
    fs.readFileSync(P("redraw-plan.review.html"), "utf8").includes('id="dp-rail"') &&
    fs.readFileSync(P("redraw-plan.working.html"), "utf8").includes('id="dp-rail"'));
  ok("redraw leaves state untouched", fs.readFileSync(stP, "utf8") === st0);
  o = cli("overviews", "redraw-plan");
  ok("overviews lists each diagram with its mermaid",
    o.status === 0 && o.stdout.includes(rs.diagrams[0].question) && o.stdout.includes("1 of 1 without an overview"));
  const archived = () => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "redraw-plan.spec.json"), "utf8"));
  const ovf = path.join(TMP, "ov.json");
  fs.writeFileSync(ovf, JSON.stringify({ "1": 'flowchart LR\n  A --> B[\\"broken label]' }));
  o = cli("overviews", "redraw-plan", ovf);
  ok("overviews refuses an overview mermaid cannot parse, writing nothing (or says it skipped)",
    (o.status !== 0 && /nothing written/.test(o.stderr) && !archived().diagrams[0].simple) || /validation skipped/.test(o.stderr));
  fs.writeFileSync(ovf, JSON.stringify({ "2": "flowchart LR\n  A --> B" }));
  ok("overviews refuses a diagram number the plan does not have", cli("overviews", "redraw-plan", ovf).status !== 0);
  fs.writeFileSync(ovf, JSON.stringify({ "1": "flowchart LR\n  A[a save fails] --> B[a timer tries again]" }));
  o = cli("overviews", "redraw-plan", ovf);
  ok("overviews writes the archived and authored specs and redraws",
    o.status === 0 && archived().diagrams[0].simple.includes("a timer tries again") &&
    JSON.parse(fs.readFileSync(P("redraw-plan.spec.json"), "utf8")).diagrams[0].simple.includes("a timer tries again") &&
    fs.readFileSync(P("redraw-plan.review.html"), "utf8").includes('data-view="simple"'));
  ok("an overview is not an amendment: the spec hash does not move",
    JSON.parse(cli("export-artifact", "redraw-plan", "--json").stdout).spec_hash === hash0);
  ok("overviews will not replace one without --force",
    cli("overviews", "redraw-plan", ovf).status !== 0 && cli("overviews", "redraw-plan", ovf, "--force").status === 0);
  o = cli("redraw", "--all", "--json");
  const rows = o.status === 0 ? JSON.parse(o.stdout) : [];
  ok("redraw --all walks every archived plan", rows.some(x => x.slug === "redraw-plan" && x.ok) && rows.some(x => x.slug === spec.slug));
  // Gone again, so the plan counts further down see only the example.
  fs.rmSync(stP, { force: true });
  fs.rmSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "redraw-plan.spec.json"), { force: true });
}

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
ok("a search for a quoted > allowed", bash('rg "=>" src').status === 0);
ok("git status allowed", bash("git status").status === 0);
ok("test run allowed", bash("npm test").status === 0);
ok("sed -i denied", bash("sed -i '' s/a/b/ file.rb").status === 2);
ok("git commit denied", bash("git commit -m x").status === 2);
ok("a heredoc write denied", bash("cat <<EOF > f.txt\nhi\nEOF").status === 2);
ok("the plan's own tooling allowed", bash("deep-plan status").status === 0);
ok("…its quoted notes are its arguments, not writes",
  bash('cd /x && deep-plan check fail slug 1 t "rm left > 5 rows" 2>/dev/null | tail -1').status === 0);
// The word alone used to be the test: a path, a comment or a commit message
// naming deep-plan let any write through.
ok("the word deep-plan in a path, a comment or a message opens nothing",
  bash("sed -i s/a/b/ deep-plan/lib/x.mjs").status === 2 &&
  bash("echo hi > f # deep-plan").status === 2 &&
  bash('git commit -m "deep-plan: x"').status === 2);
ok("a write chained beside the CLI is still a write",
  bash("deep-plan status && rm -rf x").status === 2 &&
  bash("deep-plan diff slug > out.patch").status === 2 &&
  bash('deep-plan block slug 2 "$(rm -rf x)"').status === 2);

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
const HEAD0 = execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
let st = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"));
ok("go records HEAD as the increment's start sha", st.increments[0].startSha === HEAD0);
ok("authorized increment: Edit allowed", edit(path.join(REPO, "a.txt")).status === 0);
st = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"));
ok("that edit flipped it to working (via gate)", st.increments[0].status === "working");
ok("…and kept the sha go recorded", st.increments[0].startSha === HEAD0);
// A second go next while increment 1 waits (a button's go, then a typed one)
// is refused, naming the open increment on the last line the chip shows.
r = cli("go", spec.slug, "next");
ok("go next is refused while an increment is already open", r.status === 1 &&
  /increment 1 \(.*\) is already working/.test(r.stderr) &&
  r.stderr.trim().split("\n").pop() === "go refused: increment 1 is already working", r.stderr);
st = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"));
ok("…and authorizes nothing", st.increments[1].status === "pending");
r = cli("go", spec.slug, "next", "--force");
ok("…unless forced, which opens the next one beside it (logged)", r.status === 0 &&
  JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8")).increments[1].status === "authorized");
cli("reset", spec.slug, "2");
// go --at finds the plan from a directory: its `next` is refused by name while
// increment 1 is open, and a number authorizes that increment.
r = cli("go", "--at", REPO, "next");
ok("go --at resolves a plan from a directory",
  r.status === 1 && /go refused: increment 1 is already working/.test(r.stderr));
r = cli("go", "--at", REPO, "2");
ok("…and authorizes the increment it names", r.status === 0 &&
  JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8")).increments[1].status === "authorized");
cli("reset", spec.slug, "2");
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
// A reset on a complete plan reopens it. The phase stayed "done", and the
// gate, reading the phase, let edits through with increment 2 pending.
{
  const phase = () => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8")).phase;
  cli("reset", spec.slug, "2");
  ok("a reset on a complete plan reopens it and gates again",
    phase() === "implementing" && edit(path.join(REPO, "a.txt")).status === 2);
  cli("go", spec.slug, "2"); passAll(spec.slug, 2); cli("done", spec.slug, "2");
  ok("…until its done closes the plan again",
    phase() === "done" && edit(path.join(REPO, "a.txt")).status === 0);
  ok("a passing re-grade leaves a complete plan complete",
    cli("grade", spec.slug, ...right).status === 0 && phase() === "done");
}

// -------------------------------------------------- deep-plan serve: the plugin's own page server
{
  const SV = path.join(TMP, "serve");
  fs.mkdirSync(SV, { recursive: true });
  const screen = path.join(SV, "screen.txt");
  const SENV = { ...ENV, DEEP_PLAN_SERVE_FILE: path.join(SV, "serve.json"), DEEP_PLAN_SERVE_IDLE_MS: "4000",
    LOOKOUT_ENGINE_FILE: path.join(SV, "no-lookout.json"), LOOKOUT_SERVE_FILE: path.join(SV, "lk-serve.json"),
    CREW_CMUX: path.join(HERE, "tools", "fake-cmux"), FAKE_CMUX_SCREEN: screen, DEEP_PLAN_CONFIRM_GAP_MS: "20",
    DEEP_PLAN_OPENER: "true" };
  const sv = (...a) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...a], { encoding: "utf8", env: SENV, cwd: REPO });
  const rec = () => { try { return JSON.parse(fs.readFileSync(SENV.DEEP_PLAN_SERVE_FILE, "utf8")); } catch { return null; } };
  const get = async (url, headers = {}) => {
    const r = await fetch(url, { headers, redirect: "manual" });
    const body = await r.text();
    let json = null; try { json = JSON.parse(body); } catch { /* html */ }
    return { status: r.status, body, json, headers: r.headers };
  };
  let r = sv("serve", "--url", `/plan/${spec.slug}`);
  const R = rec();
  ok("serve: --url starts a server and prints the page's URL",
    r.status === 0 && R && r.stdout.trim() === `http://127.0.0.1:${R.port}/plan/${spec.slug}`);
  ok("serve: serve.json is mode 0600 and records port, token, pid, version, started",
    R && (fs.statSync(SENV.DEEP_PLAN_SERVE_FILE).mode & 0o777) === 0o600 &&
    ["port", "token", "pid", "version", "started"].every(k => R[k]));
  ok("serve: a second --url reuses the running server", sv("serve", "--url", "/x").status === 0 && rec().pid === R.pid);
  const B = `http://127.0.0.1:${R.port}`, T = R.token;
  let g = await get(B + "/health");
  ok("serve: /health names the server and its pid", g.status === 200 && g.json.server === "deep-plan" && g.json.pid === R.pid &&
    g.headers.get("server") === "deep-plan-serve");
  // fetch will not send a Host of its choosing; a raw request will.
  const rawHost = await new Promise(res => {
    const q = http.request({ host: "127.0.0.1", port: R.port, path: "/health", headers: { Host: "evil.example:" + R.port } },
      rs => { let b = ""; rs.on("data", c => b += c); rs.on("end", () => res({ status: rs.statusCode, body: b })); });
    q.on("error", () => res({ status: 0, body: "" })); q.end();
  });
  ok("serve: a foreign Host is refused", rawHost.status === 403 && /unknown host/.test(rawHost.body));
  g = await get(`http://localhost:${R.port}/health`);
  ok("serve: localhost:<port> is its own name too", g.status === 200);
  g = await get(`${B}/plan/${spec.slug}`);
  ok("serve: the plan page is served with its token and slug injected, and mermaid swapped",
    g.status === 200 && g.body.includes(`var T = "${T}", SLUG = "${spec.slug}"`) && !g.body.includes("__TOKEN__") &&
    !/src="data:text\/javascript;base64/.test(g.body));
  g = await get(`${B}/plan/${spec.slug}.md`);
  ok("serve: a plan's markdown is plain text", g.status === 200 && /^text\/plain/.test(g.headers.get("content-type")));
  g = await get(`${B}/plan/..%2F..%2Fetc%2Fpasswd.html`);
  ok("serve: a /plan/ path cannot leave the plans directory", g.status === 404);
  g = await get(`${B}/plan-stamp?slug=${spec.slug}`);
  ok("serve: /plan-stamp answers the page's mtime", g.status === 200 && g.json.mtime > 0);
  g = await get(`${B}/plan-evidence/${spec.slug}/inc1-x-1/../../${spec.slug}.json`);
  ok("serve: /plan-evidence serves only a run's frames, replay and trace", g.status === 404);
  for (const route of ["/inc", "/open", "/answer", "/check/run"]) {
    g = await get(`${B}${route}?t=wrong&slug=${spec.slug}&n=1&a=go&id=x`);
    ok(`serve: ${route} refuses a bad token`, g.status === 403 && g.json.error === "bad token");
  }
  g = await fetch(B + "/review/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok("serve: nothing here takes a POST", g.status === 404);
  // /inc runs the engine: reset then go increment 2 from the page, as a person's click.
  const pg = (host, ...a) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "page", spec.slug, ...a],
    { encoding: "utf8", env: { ...SENV, SEAMUX_HOST: host }, cwd: REPO }).stdout;
  ok("page: on a terminal it prints the served URL with its host, and the text quiz",
    pg("terminal", "--review").includes(`served at ${B}/plan/${spec.slug}.review.html (host: terminal)`) &&
    /cat .*\.quiz\.txt/.test(pg("terminal", "--review")));
  ok("page: on desktop it says to open the URL in the browser pane",
    pg("desktop").includes(`served at ${B}/plan/${spec.slug} (host: desktop)`) && /preview_start/.test(pg("desktop")));
  ok("page: on a remote host there is no live page, and the quiz is the text one",
    /no live page on this host .*\(host: remote\)/.test(pg("remote", "--review")) && /quiz\.txt/.test(pg("remote", "--review")) &&
    /export-artifact/.test(pg("remote")));
  g = await get(`${B}/inc?t=${T}&slug=${spec.slug}&n=2&a=reset`);
  const st2 = () => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, spec.slug + ".json"), "utf8"));
  ok("serve: /inc runs a transition through the engine", g.status === 200 && g.json.ok && st2().increments[1].status === "pending");
  g = await get(`${B}/inc?t=${T}&slug=${spec.slug}&n=2&a=go`);
  ok("serve: a go from the page is recorded as the human's", g.status === 200 && g.json.ok &&
    st2().increments[1].status === "authorized" && /human/.test(JSON.stringify(st2().log.slice(-1))));
  g = await get(`${B}/inc?t=${T}&slug=${spec.slug}&n=2&a=pass`);
  ok("serve: /inc refuses anything but a transition", g.status === 500 && g.json.detail === "bad transition");
  passAll(spec.slug, 2); cli("done", spec.slug, "2");
  fs.writeFileSync(path.join(REPO, "serve-open.txt"), "x\n");
  g = await get(`${B}/open?t=${T}&slug=${spec.slug}&path=serve-open.txt:3`);
  const g2 = await get(`${B}/open?t=${T}&slug=${spec.slug}&path=../../etc/passwd`);
  ok("serve: /open opens a file in the plan's worktree, and nothing outside it",
    g.json.ok && g.json.detail === "opened serve-open.txt:3" && !g2.json.ok && g2.json.detail === "outside the worktree");
  fs.rmSync(path.join(REPO, "serve-open.txt"), { force: true });
  g = await get(`${B}/check/run?t=${T}&slug=${spec.slug}&n=1&id=Not%20An%20Id`);
  ok("serve: /check/* refuses a malformed check id", g.status === 400 && g.json.detail === "bad check id");
  // Asks: typed only where a cmux surface was recorded, and then verified.
  const askFile = path.join(HERE, "examples", "example.ask.json");
  const mk = env => {
    const a = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "ask", askFile], { encoding: "utf8", env, cwd: TMP });
    return { id: (a.stdout.match(/ask (\S+):/) || [])[1], out: a.stdout };
  };
  const plain = mk(SENV);
  ok("serve: an ask outside cmux prints its URL on deep-plan's server",
    plain.id && plain.out.includes(`served at ${B}/ask/${plain.id}`), plain.out);
  g = await get(`${B}/ask/${plain.id}`);
  ok("serve: the ask page is served with its token and id", g.status === 200 && g.body.includes(`var T = "${T}", ID = "${plain.id}"`));
  g = await get(`${B}/answer?t=${T}&id=${plain.id}&n=2`);
  ok("serve: with no cmux surface a pick is recorded, not typed, and says to answer in the chat",
    g.status === 200 && g.json.ok && g.json.delivered === false && /in the chat prompt/.test(g.json.detail));
  g = await get(`${B}/answer?t=${T}&id=${plain.id}&n=1`);
  ok("serve: an ask is answered once", g.status === 400 && /already answered: 2/.test(g.json.detail));
  const typed = mk({ ...SENV, CMUX_SURFACE_ID: "SURF-9" });
  fs.writeFileSync(screen, "something else entirely\n");
  g = await get(`${B}/answer?t=${T}&id=${typed.id}&n=1`);
  ok("serve: delivery looks before typing: a screen without the question gets nothing",
    g.json.ok && g.json.delivered === false && /not showing this question/.test(g.json.detail));
  const typed2 = mk({ ...SENV, CMUX_SURFACE_ID: "SURF-9" });
  fs.writeFileSync(screen, "? For temporary share links\n❯ 1. Whole site, read-only\n  2. Day-of planner only\n");
  g = await get(`${B}/answer?t=${T}&id=${typed2.id}&n=2`);
  ok("serve: when the pointer never moves to the pick, Enter is not sent",
    g.json.ok && g.json.delivered === false && /could not confirm/.test(g.json.detail));
  // The server's own env carries no FAKE_CMUX_AFTER_SEND: restart it with one.
  sv("serve", "--stop");
  const AENV = { ...SENV, FAKE_CMUX_AFTER_SEND: "  1. Whole site, read-only\n❯ 2. Day-of planner only\n" };
  spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "serve"], { encoding: "utf8", env: AENV });
  const R2 = rec();
  const typed3 = mk({ ...SENV, CMUX_SURFACE_ID: "SURF-9" });
  fs.writeFileSync(screen, "? For temporary share links\n❯ 1. Whole site, read-only\n  2. Day-of planner only\n");
  g = await get(`http://127.0.0.1:${R2.port}/answer?t=${R2.token}&id=${typed3.id}&n=2`);
  ok("serve: the pointer moved to the pick, so Enter follows and it is delivered",
    g.json.ok && g.json.delivered === true && g.json.detail === "delivered 2 — selected, then Enter");
  ok("serve: the recorded answer says it was typed",
    JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "asks", typed3.id + ".json"), "utf8")).answer.delivered === true);
  g = await get(`http://127.0.0.1:${R2.port}/review/x-inc1`);
  ok("serve: /review/ without lookout says so", g.status === 404 && /lookout is not installed/.test(g.json.error));
  // A stale record (a dead pid) is replaced, not trusted.
  sv("serve", "--stop");
  fs.writeFileSync(SENV.DEEP_PLAN_SERVE_FILE, JSON.stringify({ port: R2.port, token: "x", pid: 999999, version: "0", started: "" }));
  r = sv("serve", "--url", "/health");
  ok("serve: a stale serve.json (dead pid) starts a fresh server", r.status === 0 && rec().pid !== 999999 && rec().token !== "x");
  // Idle exit: the server goes after IDLE_MS without a request, and tidies its record.
  const idlePid = rec().pid;
  let gone = false;
  for (let i = 0; i < 80 && !gone; i++) { await new Promise(res => setTimeout(res, 500)); gone = !rec() && !(() => { try { process.kill(idlePid, 0); return true; } catch { return false; } })(); }
  ok("serve: an idle server exits and removes serve.json", gone);
  // Two starters at once, nothing running: both get the one server that won.
  const both = await Promise.all([0, 1].map(() => new Promise(res => {
    const c = spawn("node", [path.join(HERE, "deep_plan.mjs"), "serve", "--url", "/health"], { env: SENV, cwd: REPO });
    let o = ""; c.stdout.on("data", d => o += d); c.on("close", code => res({ code, url: o.trim() }));
  })));
  await new Promise(res => setTimeout(res, 600));
  const alivePids = fs.readFileSync(SENV.DEEP_PLAN_SERVE_FILE, "utf8") && spawnSync("pgrep", ["-f", `${path.join(HERE, "deep_plan.mjs")} serve --foreground`]).stdout.toString().trim().split("\n").filter(Boolean);
  ok("serve: two starters racing share one server, and the loser exits",
    both.every(b => b.code === 0 && b.url === both[0].url && b.url.endsWith("/health")) && alivePids.includes(String(rec().pid)),
    JSON.stringify(both));
  sv("serve", "--stop");
}

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
// The gate counts increments rather than trusting the phase, whichever writer
// left a "done" or "delivery" phase over pending work.
ok("a done or delivery phase with an increment pending gates",
  ["done", "delivery"].every(phase => !lib.gateView({ slug: "x", phase, gate: "increment",
    increments: [{ n: 1, status: "done" }, { n: 2, status: "pending" }] }).allow));
// A `>` inside quotes is a pattern, not a redirect: searching for arrow
// functions was blocked until a go.
ok("a quoted > is not a redirect (rg, jq)",
  !lib.bashMutates('rg "=>" src') && !lib.bashMutates("jq '.a > 1' f.json") &&
  !lib.bashMutates('grep -n "a; rm -rf b" f'));
ok("…but a redirect after the quotes still mutates",
  lib.bashMutates('rg "=>" src > hits.txt') && lib.bashMutates('echo "x" >"out"'));
ok("a quoted command still mutates, and a substitution is not blanked",
  lib.bashMutates('bash -c "rm -rf x"') && lib.bashMutates('echo "$(date)" > f') &&
  lib.bashMutates('cat "$(echo x > f)"'));
ok("an escaped quote opens nothing; an unclosed one reads as written",
  lib.bashMutates('cat \\"; rm -rf x; echo \\"') && lib.bashMutates("echo it's > f"));
// A reader is judged by its structure: what its substitutions run, a second
// line, find's own actions, and `rm` with nothing after it all used to ride
// on the first word being a reader.
for (const c of ["cat $(rm -rf x)", "cat `rm -rf x`", "ls $(touch y)", "git diff $(rm x)",
  'cat "$(rm x)"', "cat $(echo $(rm x))", "cat ${X:-$(rm y)}", "cat $(bash -c \"rm -rf x\")"])
  ok(`a write inside a substitution gates: ${c}`, lib.bashMutates(c));
for (const c of ["cat f\nrm -rf x", "ls\ntouch y"])
  ok(`a second line is not part of the reader: ${JSON.stringify(c)}`, lib.bashMutates(c));
for (const c of ["find . -delete", "find . -exec rm {} +", "find . -fprint out", "find . | xargs rm"])
  ok(`find's writes and a trailing rm gate: ${c}`, lib.bashMutates(c));
for (const c of ["cat $(ls)", "cat `ls`", "cat $(git rev-parse --show-toplevel)/x",
  "grep 'rm -rf' $(git ls-files)", "diff <(ls a) <(ls b)", "git status", "git diff",
  "git log | head", "grep foo", "rg '=>'", "jq '.a > 1'", "ls", "sed -n 1,5p f",
  "find . -name '*.js'", "find . -exec grep -l x {} +", "grep 'find . -delete' notes"])
  ok(`a reader stays a reader: ${c}`, !lib.bashMutates(c));

// -------------------------------------------------- treeOf: a racily clean edit
// Git trusts an entry's cached stat only when the entry is older than the index
// file. treeOf's scratch copy of the index must keep the real one's mtime, or a
// same-size edit made in the same second as `git add` is read as unchanged.
{
  const RR = path.join(TMP, "racy-repo");
  fs.mkdirSync(RR);
  execSync("git init -q && git config core.trustctime false && " +
    "git -c user.email=p@p -c user.name=p commit -q --allow-empty -m init", { cwd: RR });
  const f = path.join(RR, "f.txt"), past = 1_700_000_000;
  fs.writeFileSync(f, "old\n");
  fs.utimesSync(f, past, past);
  execSync("git add f.txt", { cwd: RR });
  fs.writeFileSync(f, "new\n");
  fs.utimesSync(f, past, past);
  fs.utimesSync(path.join(RR, ".git", "index"), past, past);
  const t = lib.treeOf(RR);
  const blob = t && t.content ? execSync(`git cat-file -p ${t.content}:f.txt`, { cwd: RR, encoding: "utf8" }) : "";
  ok("treeOf sees a same-size edit made in the second of its git add", blob === "new\n");
}

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

// -------------------------------------------------- a relative root gates nothing
// `render --root .` once stored the dot as typed. The hook resolves a root
// against its own cwd, so that plan claimed whichever worktree the agent stood
// in and refused edits there with its own shut gate.
{
  const LOOSE = path.join(TMP, "loose-worktree");
  fs.mkdirSync(LOOSE, { recursive: true });
  fs.writeFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "dot.json"), JSON.stringify(
    { slug: "dot", root: ".", phase: "implementing", gate: "increment", increments: [{ n: 1, status: "pending" }] }));
  ok("brokenRoots reports a relative root", lib.brokenRoots().some(b => b.slug === "dot"));
  const dg = spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], {
    encoding: "utf8", env: ENV, cwd: LOOSE,
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(LOOSE, "a.txt") }, cwd: LOOSE }),
  });
  ok("a relative root does not claim the hook's cwd", dg.status === 0 && !/gate \[dot\]/.test(dg.stderr));
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "dot.json"));

  const RR = path.join(TMP, "root-relative");
  fs.mkdirSync(RR, { recursive: true });
  execSync("git init -q", { cwd: RR });
  const rel = JSON.parse(JSON.stringify(spec));
  rel.slug = "relative-root-plan";
  const rr = cli("render", tmpSpec(rel), "--root", path.relative(REPO, RR));
  const rst = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "relative-root-plan.json"), "utf8"));
  // The CLI's cwd is the realpath, so /var and /private/var both name RR here.
  ok("render stores --root as an absolute path",
    rr.status === 0 && path.isAbsolute(rst.root) && fs.realpathSync(rst.root) === fs.realpathSync(RR));
  cli("close", "relative-root-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "relative-root-plan.json"), { force: true });
}

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
    ["a step with two kinds", { id: "a", tier: "expensive", steps: [{ run: "x", wait: "y" }] }, /needs exactly one of acquire\|claim\|wait\|run\|browser \(has wait and run\)/],
    ["an acquire after a run", { id: "a", tier: "expensive", steps: [{ run: "x" }, { acquire: "y" }, { run: "z" }] }, /acquire after run/],
    ["a browser step that is not last", { id: "a", kind: "browser", steps: [{ browser: "t/a.js" }, { run: "y" }] }, /browser step comes last/],
    ["two browser steps", { id: "a", kind: "browser", steps: [{ browser: "t/a.js" }, { browser: "t/b.js" }] }, /at most one browser step/],
    ["a browser recipe with no browser step", { id: "a", kind: "browser", run: "x" }, /ends with a browser step/],
    ["a browser step in a test recipe", { id: "a", tier: "expensive", steps: [{ browser: "t/a.js" }] }, /belongs in a recipe of kind browser/],
    ["a browser script outside the project", { id: "a", kind: "browser", steps: [{ browser: "../x.js" }] }, /names a \.js script by its path inside/],
    ["a browser script that is not .js", { id: "a", kind: "browser", steps: [{ browser: "t/a.py" }] }, /names a \.js script/],
    ["scripts outside the project", { id: "a", kind: "browser", scripts: ["/etc/x"], steps: [{ browser: "t/a.js" }] }, /scripts must be a list of paths inside/],
    ["a brief that is not a string", { id: "a", kind: "browser", brief: 3, steps: [{ browser: "t/a.js" }] }, /brief must be a string/],
    ["a claim that asks with no export", { id: "a", steps: [{ claim: "x", ask: "Which?" }, { run: "y" }] }, /needs an export to name the answer/],
    ["claim choices with no ask", { id: "a", steps: [{ claim: "x", choices: "y", export: "V" }, { run: "y" }] }, /choices are what a person picks from/],
    ["a claim lock with a bad name", { id: "a", steps: [{ claim: "x", lock: "a b" }, { run: "y" }] }, /lock must be a name/],
    ["a null claim with no ask", { id: "a", steps: [{ claim: null }, { run: "y" }] }, /claim must be a command string/],
    ["a claim in the cheap tier", { id: "a", tier: "cheap", steps: [{ claim: "x" }, { run: "y" }] }, /must be expensive/],
    ["an export on an acquire step", { id: "a", steps: [{ acquire: "x", export: "V" }, { run: "y" }] }, /cannot export/],
    ["an export that is not an env var name", { id: "a", steps: [{ run: "x", export: "base-url" }] }, /env var name/],
    ["a remote recipe with no run step", { id: "a", steps: [{ wait: "x" }] }, /needs a run or browser step/],
    ["a wait in the cheap tier", { id: "a", tier: "cheap", steps: [{ wait: "x" }, { run: "y" }] }, /must be expensive/],
    ["a cwd outside the project", { id: "a", run: "x", cwd: "../other" }, /cwd must be a path inside/],
    ["a non-positive timeout", { id: "a", run: "x", timeout: 0 }, /timeout must be a positive/],
  ]) ok(`a recipe with ${label} is refused`, re.test(errsOf({ recipes: [recipe] })));
  {
    const H = path.join(TMP, "hash-pin");
    fs.mkdirSync(path.join(H, ".seamux"), { recursive: true });
    fs.writeFileSync(path.join(H, ".seamux", "verify.json"),
      JSON.stringify({ recipes: [{ id: "unit", run: "npm test", match: ["src/**"], default: true }] }));
    ok("a recipe with no brief or scripts keeps the hash it had before they existed (no pass resets)",
      recipeHash(loadVerify(H).recipes[0], "") === "f30577dbe35b");
  }
  ok("a wait after a run is accepted (claim, deploy, watch the job)",
    errsOf({ recipes: [{ id: "a", tier: "expensive", steps: [{ run: "x" }, { wait: "y" }, { run: "z" }] }] }) === "");
  ok("a browser recipe with setup steps, a brief and scripts is accepted, and runs detached",
    errsOf({ recipes: [{ id: "b", kind: "browser", brief: "QA suite", scripts: ["e2e/seed.spec.ts"],
      steps: [{ run: "npx playwright test e2e/seed.spec.ts", export: "STORAGE_STATE" }, { browser: "e2e/flow.js" }] }] }) === "" &&
    loadVerify(BAD).recipes[0].tier === "expensive" && loadVerify(BAD).recipes[0].brief === "QA suite");
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
    waitFor(() => stOf("run-1").log.some(l => /exp finished pass, but the check was reset|exp — a runner started after its attempt was reset/.test(l.what))) &&
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

// -------------------------------------------------- browser checks: a repo script through cmux's repl
//
// A browser recipe's last step names a script; the engine wraps it in the
// prelude and runs it through `cmux browser repl --eval -` in the plan root's
// workspace, with the repl's cwd in the check's evidence directory. The
// verdict is the exit code; the frames, trace and replay are kept, and
// status --json carries a summary. tools/fake-cmux stands in for cmux.
{
  const BR = path.join(TMP, "browser-root");
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  fs.mkdirSync(path.join(BR, ".seamux"), { recursive: true });
  fs.mkdirSync(path.join(BR, "e2e"), { recursive: true });
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: BR });
  fs.writeFileSync(path.join(BR, "e2e", "flow.js"),
    'await step("open the page", async () => { await page.goto(env.BASE_URL); });\n' +
    'await step("sign in", async () => { await expect(page.getByRole("button")).toBeVisible(); });\n');
  fs.writeFileSync(path.join(BR, "e2e", "broken.js"),
    'await step("open the page", async () => {});\nawait step("find the alert", async () => { /* FAKE_FAIL */ });\n');
  fs.writeFileSync(path.join(BR, "e2e", "slow.js"),
    '// FAKE_SLEEP_MS=700\nawait step("one", async () => {});\nawait step("two", async () => {});\nawait step("three", async () => {});\n');
  fs.writeFileSync(path.join(BR, "e2e", "seed.sh"), 'mkdir -p .auth && echo "{\\"cookies\\":[]}" > .auth/user.json && echo .auth/user.json\n');
  fs.writeFileSync(path.join(BR, ".seamux", "verify.json"), JSON.stringify({ recipes: [
    { id: "flow", kind: "browser", brief: "the sign-in suite; extend a step per new screen",
      scripts: ["e2e/seed.sh"], steps: [
        { run: "echo http://shop.local", export: "BASE_URL" },
        { run: "sh e2e/seed.sh", export: "STORAGE_STATE" },
        { browser: "e2e/flow.js" }] },
    { id: "broken", kind: "browser", steps: [{ browser: "e2e/broken.js" }] },
    { id: "missing", kind: "browser", steps: [{ browser: "e2e/nope.js" }] },
    { id: "slow", kind: "browser", steps: [{ browser: "e2e/slow.js" }] },
  ] }, null, 2));
  const FAKE = path.join(HERE, "tools", "fake-cmux");
  const CLOG = path.join(TMP, "fake-cmux.log");
  const TARGETS = path.join(TMP, "board-targets.json");
  fs.writeFileSync(TARGETS, JSON.stringify({ "WS-1": { id: "WS-1", ref: "workspace:7", cwd: BR } }));
  // The cmux driver is cmux's host; the Playwright driver's checks are at the end.
  const BENV = { ...ENV, CREW_CMUX: FAKE, FAKE_CMUX_LOG: CLOG, DEEP_PLAN_BOARD_TARGETS: TARGETS, SEAMUX_HOST: "cmux" };
  const bcli = (...args) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args], { encoding: "utf8", env: BENV, cwd: REPO });
  const s = JSON.parse(JSON.stringify(spec));
  s.slug = "br-1";
  s.deliverables[0] = { title: "Sign-in flow", body: "A page.", files: ["src/a.ts"],
    checks: ["flow", "broken", "missing", "slow"].map(id => ({ id, kind: "browser", name: id, recipe: id })) };
  bcli("render", tmpSpec(s), "--root", BR);
  const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "br-1.key.json"), "utf8"));
  bcli("grade", "br-1", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
  bcli("go", "br-1", "1"); bcli("start", "br-1", "1");
  const bst = () => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "br-1.json"), "utf8"));
  const bck = id => bst().increments[0].checks[id];
  const runs = path.join(ENV.DEEP_PLAN_PLANS_DIR, "br-1.runs");

  ok("render stores a browser check's steps, brief and setup scripts",
    bck("flow").kind === "browser" && bck("flow").exec.tier === "expensive" &&
    bck("flow").exec.steps[2].kind === "browser" && /sign-in suite/.test(bck("flow").exec.brief) &&
    bck("flow").exec.scripts[0] === "e2e/seed.sh");
  let r = bcli("check", "list", "br-1", "1");
  ok("check list shows the script, its setup and the brief",
    /script: e2e\/flow\.js/.test(r.stdout) && /setup:  e2e\/seed\.sh/.test(r.stdout) && /brief:  the sign-in suite/.test(r.stdout));

  r = bcli("check", "run", "br-1", "1", "flow", "--inline");
  const flow = bck("flow");
  ok("a browser check passes on the repl's exit 0", r.status === 0 && flow.status === "pass" && !!flow.tree);
  const call = fs.readFileSync(CLOG, "utf8").trim().split("\n").map(l => JSON.parse(l)).pop();
  ok("…run through cmux browser repl in the plan root's workspace, in its own session",
    call.argv.join(" ").includes("browser repl") && call.argv.includes("--workspace") &&
    call.argv[call.argv.indexOf("--workspace") + 1] === "WS-1" &&
    call.argv[call.argv.indexOf("--session") + 1] === "dp-br-1-1-flow" && call.argv.includes("--eval"));
  ok("…with its cwd in the check's evidence directory under <slug>.runs",
    call.cwd.startsWith(fs.realpathSync(runs)) || call.cwd.startsWith(runs));
  ok("…and earlier exports reach the script's env, the seed's storage state copied in",
    /storage state loaded from .*storage-state\.json/.test(fs.readFileSync(flow.ran.log, "utf8")) &&
    fs.existsSync(path.join(runs, flow.evidence.dir, "storage-state.json")));
  ok("the verdict carries the run's evidence: frames, replay and trace",
    flow.evidence && flow.evidence.frames === 2 && flow.evidence.animation === "run.png" &&
    flow.evidence.trace === "trace.jsonl" && flow.evidence.result === "pass" &&
    fs.existsSync(path.join(runs, flow.evidence.dir, "frame-0002.png")));
  r = bcli("check", "evidence", "br-1", "1", "flow", "--json");
  const fev = JSON.parse(r.stdout);
  ok("check evidence --json lists each frame and each step with its frames",
    fev.framesList.length === 2 && fev.steps.map(x => x.label).join("|") === "open the page|sign in" &&
    fev.steps.every(x => x.status === "pass"));
  r = bcli("status", "--json");
  const row = JSON.parse(r.stdout).find(p => p.slug === "br-1").increments[0].checks.find(c => c.id === "flow");
  ok("status --json carries the evidence summary, without the frame list",
    row.evidence && row.evidence.frames === 2 && row.evidence.latest === "frame-0002.png" &&
    !("framesList" in row.evidence) && row.evidence.steps === 2);
  ok("…and a check that is not a browser check carries none",
    !("evidence" in (JSON.parse(r.stdout).find(p => p.slug === "br-1").increments[0].checks.find(c => c.kind === "review") || {})));

  const work = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "br-1.working.html"), "utf8");
  ok("the working page marks a browser check's row for the Dock, with its brief",
    /<li class="dp-check" data-n="1" data-id="flow" data-status="pass" data-browser="1">/.test(work) &&
    /<span class="dp-brief">brief: the sign-in suite; extend a step per new screen<\/span>/.test(work));
  ok("…and leaves other checks' rows plain", !/data-id="review-code-review"/.test(work));
  r = bcli("check", "evidence", "br-1", "1", "flow", "--json");
  const fj = JSON.parse(r.stdout);
  ok("check evidence --json carries the run's tab, the brief, and which of its scripts changed in the increment",
    fj.tab === "TAB-1" && /sign-in suite/.test(fj.brief) && Array.isArray(fj.changed));
  fs.writeFileSync(path.join(BR, "e2e", "seed.sh"), fs.readFileSync(path.join(BR, "e2e", "seed.sh"), "utf8") + "# edited\n");
  ok("…an edited setup script or a new script is listed as changed",
    (c => c.includes("e2e/seed.sh") && c.includes("e2e/flow.js"))(JSON.parse(bcli("check", "evidence", "br-1", "1", "flow", "--json").stdout).changed));
  r = bcli("check", "tab", "br-1", "1", "flow");
  const tcall = fs.readFileSync(CLOG, "utf8").trim().split("\n").map(l => JSON.parse(l)).pop();
  ok("check tab brings the run's own tab forward, in its session and workspace",
    r.status === 0 && /its tab is in front/.test(r.stdout) && /tabs\.get\("TAB-1"\)/.test(tcall.argv[tcall.argv.length - 1]) &&
    tcall.argv[tcall.argv.indexOf("--session") + 1] === "dp-br-1-1-flow" && tcall.argv[tcall.argv.indexOf("--workspace") + 1] === "WS-1");
  ok("check tab on a check with no run says so", bcli("check", "tab", "br-1", "1", "missing").status === 1);

  r = bcli("check", "run", "br-1", "1", "broken", "--inline");
  ok("a script that throws fails the check, naming the step it failed in",
    r.status === 1 && bck("broken").status === "fail" &&
    /^step "find the alert": expect\(locator\)\.toBeVisible\(\) failed/.test(bck("broken").note) &&
    bck("broken").evidence.result === "fail" && bck("broken").evidence.label === "find the alert");
  r = bcli("check", "run", "br-1", "1", "missing", "--inline");
  ok("a browser script that does not exist fails without calling cmux",
    r.status === 1 && /e2e\/nope\.js does not exist/.test(fs.readFileSync(bck("missing").ran.log, "utf8")));
  r = bcli("check", "run", "br-1", "1", "flow", "--inline");
  bcli("check", "run", "br-1", "1", "flow", "--inline");
  bcli("check", "run", "br-1", "1", "flow", "--inline");
  ok("evidence is kept for the latest three runs of a check",
    fs.readdirSync(runs).filter(d => /^inc1-flow-\d+$/.test(d)).length === 3);

  const until2 = (cond, ms = 10000) => { const t = Date.now() + ms; while (Date.now() < t) { if (cond()) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } return cond(); };
  r = bcli("check", "run", "br-1", "1", "slow");
  ok("a browser check runs detached by default", r.status === 0 && /started detached/.test(r.stdout));
  const until = Date.now() + 8000;
  let mid = null;
  while (Date.now() < until) {
    const ev = JSON.parse(bcli("check", "evidence", "br-1", "1", "slow", "--json").stdout);
    if (ev.live && ev.frames >= 1) { mid = ev; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  ok("…and its evidence fills while it runs (the Dock's filmstrip)", !!mid && mid.live && mid.frames >= 1 && mid.frames < 3);
  bcli("check", "wait", "br-1", "1", "slow", "--timeout", "20");
  ok("…landing its verdict with every frame", bck("slow").status === "pass" && bck("slow").evidence.frames === 3);
  bcli("check", "run", "br-1", "1", "slow");
  until2(() => { const e = JSON.parse(bcli("check", "evidence", "br-1", "1", "slow", "--json").stdout); return e.live && e.frames >= 1; });
  const spid = bck("slow").runner.pid;
  try { process.kill(-spid, "SIGKILL"); } catch { process.kill(spid, "SIGKILL"); }
  until2(() => { try { process.kill(spid, 0); return false; } catch { return true; } });
  bcli("check", "status", "br-1", "1", "slow");
  ok("a lost browser run keeps its own evidence, not the last run's",
    bck("slow").status === "fail" && /runner lost/.test(bck("slow").note) &&
    bck("slow").evidence.frames < 3 && bck("slow").evidence.dir !== undefined && bck("slow").evidence.live === false);

  {
    const PR = path.join(TMP, "prune-runs");
    for (const d of ["inc1-flow-1", "inc1-flow-2", "inc1-flow-3", "inc1-flow-4", "inc1-flow-x-1", "inc1-flow-x-2"])
      fs.mkdirSync(path.join(PR, d), { recursive: true });
    pruneEvidence(PR, 1, "flow");
    ok("pruning one check's evidence never touches a check whose id extends it",
      fs.readdirSync(PR).sort().join(" ") === "inc1-flow-2 inc1-flow-3 inc1-flow-4 inc1-flow-x-1 inc1-flow-x-2");
    ok("a run with no pass or fail event is live only when read as the run in flight",
      readEvidence(PR, "inc1-flow-2").live === false && readEvidence(PR, "inc1-flow-2", { live: true }).live === true);
  }
  // PR proof: built locally from the last passed run; --attach goes through gh.
  {
    bcli("check", "run", "br-1", "1", "flow", "--inline");
    const FB = path.join(TMP, "fake-bin");
    fs.mkdirSync(FB, { recursive: true });
    const BODY = path.join(TMP, "pr-body.txt"), GLOG = path.join(TMP, "gh.log");
    fs.writeFileSync(BODY, "What this PR does.\n");
    fs.writeFileSync(path.join(FB, "gh"), `#!/bin/sh
echo "$*" >> ${JSON.stringify(GLOG)}
case "$*" in
  "pr edit --help") [ -n "$FAKE_GH_ATTACH" ] && echo "  --attach file   Upload a file"; echo "  -F, --body-file"; exit 0;;
  "pr view --json number -q .number") echo 42; exit 0;;
  "pr view 42 --json body -q .body") cat ${JSON.stringify(BODY)}; exit 0;;
  "pr edit 42 -F "*) f="$5"; cp "$f" ${JSON.stringify(BODY)}; exit 0;;
esac
exit 1
`);
    fs.writeFileSync(path.join(FB, "ffmpeg"), '#!/bin/sh\nfor a; do last="$a"; done\necho fake > "$last"\n');
    fs.chmodSync(path.join(FB, "gh"), 0o755); fs.chmodSync(path.join(FB, "ffmpeg"), 0o755);
    const pcli = (extra, ...args) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args],
      { encoding: "utf8", env: { ...BENV, ...extra }, cwd: REPO });
    const PROOF = path.join(ENV.DEEP_PLAN_PLANS_DIR, "br-1.proof");
    let pr = pcli({}, "proof", "br-1", "1", "flow");
    const md = fs.readFileSync(path.join(PROOF, "proof.md"), "utf8");
    ok("proof builds the replay, a key frame per step and proof.md, locally",
      pr.status === 0 && md.startsWith("<!-- deep-plan proof -->") && md.trim().endsWith("<!-- /deep-plan proof -->") &&
      /!\[flow: the whole run\]\(\.\/1-flow-replay\.png\)/.test(md) && /1\. \*\*open the page\*\*/.test(md) &&
      /!\[sign in\]\(\.\/1-flow-02\.png\)/.test(md) && fs.existsSync(path.join(PROOF, "1-flow-01.png")));
    pr = pcli({ PATH: FB + path.delimiter + process.env.PATH }, "proof", "br-1", "1", "flow");
    ok("…and a GIF of the replay when ffmpeg is on PATH, which the markdown shows",
      fs.existsSync(path.join(PROOF, "1-flow.gif")) && /\(\.\/1-flow\.gif\)/.test(fs.readFileSync(path.join(PROOF, "proof.md"), "utf8")));
    pr = pcli({}, "proof", "br-1", "1", "broken");
    ok("proof refuses a check with no passed run", pr.status === 1 && /no passed run to prove/.test(pr.stderr));
    const GH = { PATH: FB + path.delimiter + process.env.PATH, FAKE_GH_ATTACH: "1" };
    pr = pcli({ PATH: FB + path.delimiter + process.env.PATH }, "proof", "br-1", "1", "flow", "--attach");
    ok("--attach with a gh that cannot upload says to upgrade", pr.status === 1 && /gh pr edit --attach arrived in 2\.99/.test(pr.stderr));
    fs.writeFileSync(GLOG, "");
    pr = pcli(GH, "proof", "br-1", "1", "flow", "--attach");
    ok("--attach without --yes says what it would send and sends nothing",
      pr.status === 2 && /would update PR 42/.test(pr.stdout) && !/pr edit 42/.test(fs.readFileSync(GLOG, "utf8")));
    pr = pcli(GH, "proof", "br-1", "1", "flow", "--attach", "--yes");
    const sent = fs.readFileSync(GLOG, "utf8").split("\n").find(l => l.startsWith("pr edit 42 -F")) || "";
    const body1 = fs.readFileSync(BODY, "utf8");
    ok("--attach --yes edits the PR body through gh, uploading every file the markdown names",
      pr.status === 0 && /--attach 1-flow\.gif/.test(sent) && /--attach 1-flow-01\.png --attach 1-flow-02\.png/.test(sent) &&
      body1.startsWith("What this PR does.") && body1.includes("<!-- deep-plan proof -->"));
    {
      const dir = path.join(TMP, "md-esc"); fs.mkdirSync(path.join(dir, "ev"), { recursive: true });
      fs.writeFileSync(path.join(dir, "ev", "key-01.png"), "x");
      const { buildProof } = await import(path.join(HERE, "lib", "proof.mjs"));
      const b = buildProof("x", path.join(dir, "out"), [{ n: 1, id: "f", name: "a [link](http://x) *b*", dir: path.join(dir, "ev"),
        ev: { steps: [{ label: "![img](http://evil) <b>", key: "key-01.png", status: "pass" }] } }]);
      ok("proof escapes the repo's labels and names in its markdown",
        !/[^\\]\]\(http:\/\/evil\)/.test(b.md) && /\\!\\\[img\\\]\(http:\/\/evil\) \\<b\\>/.test(b.md) && /a \\\[link\\\]/.test(b.md));
    }
    pr = pcli(GH, "proof", "br-1", "1", "flow", "--attach", "42", "--yes");
    const body2 = fs.readFileSync(BODY, "utf8");
    ok("…and a second attach replaces its section instead of adding another",
      pr.status === 0 && /section replaced/.test(pr.stdout) && body2.split("<!-- deep-plan proof -->").length === 2 &&
      body2.startsWith("What this PR does."));
  }

  const ws0 = JSON.parse(fs.readFileSync(TARGETS, "utf8"));
  fs.writeFileSync(TARGETS, "{}");
  r = bcli("check", "run", "br-1", "1", "flow", "--inline");
  ok("with no workspace for the root the run still goes, and its log says where the tabs land",
    r.status === 0 && /no cmux workspace found/.test(fs.readFileSync(bck("flow").ran.log, "utf8")));
  fs.writeFileSync(TARGETS, JSON.stringify(ws0));
  // ---- the Playwright driver: the same scripts where cmux is not the host.
  // tools/fake-playwright stands in for the package and Chromium, and runs
  // the real browser/prelude-node.js.
  {
    const PWLOG = path.join(TMP, "fake-pw.log");
    fs.writeFileSync(path.join(BR, "e2e", "throws.js"),
      'await step("open the page", async () => { await page.goto(env.BASE_URL || "http://x"); });\n' +
      'await step("see the banner", async () => { await expect(page.locator("#banner")).toHaveText("Welcome", { timeout: 300 }); });\n');
    const vj = JSON.parse(fs.readFileSync(path.join(BR, ".seamux", "verify.json"), "utf8"));
    vj.recipes.push({ id: "throws", kind: "browser", steps: [{ browser: "e2e/throws.js" }] });
    fs.writeFileSync(path.join(BR, ".seamux", "verify.json"), JSON.stringify(vj, null, 2));
    const p2 = JSON.parse(JSON.stringify(spec));
    p2.slug = "br-pw";
    p2.deliverables[0] = { title: "Sign-in flow", body: "A page.", files: ["src/a.ts"],
      checks: ["flow", "throws"].map(id => ({ id, kind: "browser", name: id, recipe: id })) };
    const PENV = { ...ENV, DEEP_PLAN_BOARD_TARGETS: TARGETS, SEAMUX_HOST: "terminal",
      DEEP_PLAN_PLAYWRIGHT: path.join(HERE, "tools", "fake-playwright"), FAKE_PW_LOG: PWLOG, CREW_CMUX: FAKE, FAKE_CMUX_LOG: CLOG };
    const pcli = (env, ...args) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args], { encoding: "utf8", env, cwd: REPO });
    pcli(PENV, "render", tmpSpec(p2), "--root", BR);
    const k2 = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "br-pw.key.json"), "utf8"));
    pcli(PENV, "grade", "br-pw", ...Object.entries(k2.answers).map(([q, v]) => `${q}=${v.letter}`));
    pcli(PENV, "go", "br-pw", "1"); pcli(PENV, "start", "br-pw", "1");
    const pck = id => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "br-pw.json"), "utf8")).increments[0].checks[id];
    const pruns = path.join(ENV.DEEP_PLAN_PLANS_DIR, "br-pw.runs");
    const cmuxCalls = () => fs.existsSync(CLOG) ? fs.readFileSync(CLOG, "utf8").trim().split("\n").length : 0;
    const before = cmuxCalls();
    r = pcli(PENV, "check", "run", "br-pw", "1", "flow", "--inline");
    const pf = pck("flow");
    const pwlog = fs.readFileSync(PWLOG, "utf8").trim().split("\n").map(l => JSON.parse(l));
    ok("playwright: outside cmux a browser check runs through Playwright, not cmux's repl",
      r.status === 0 && pf.status === "pass" && cmuxCalls() === before && pwlog.some(e => e.launch) &&
      /\[playwright: .*\(stand-in\)\]/.test(fs.readFileSync(pf.ran.log, "utf8")), r.stdout + r.stderr);
    ok("playwright: earlier exports reach env, and the seed's storage state loads into the context",
      pwlog.some(e => e.goto === "http://shop.local") && pwlog.some(e => e.context && /storage-state\.json$/.test(e.context.storageState || "")));
    const pdir = path.join(pruns, pf.evidence.dir);
    ok("playwright: the same evidence: progress, frames per step, key frames and a trace; no replay",
      pf.evidence.result === "pass" && pf.evidence.frames >= 4 && pf.evidence.trace === "trace.jsonl" && pf.evidence.animation === "" &&
      fs.existsSync(path.join(pdir, "key-01.png")) && fs.existsSync(path.join(pdir, "key-02.png")) &&
      /"type":"navigate","url":"http:\/\/shop\.local"/.test(fs.readFileSync(path.join(pdir, "trace.jsonl"), "utf8")),
      JSON.stringify(pf.evidence));
    r = pcli(PENV, "check", "run", "br-pw", "1", "throws", "--inline");
    const pt = pck("throws");
    ok("playwright: a failed expect fails the check, named by its step, with a key frame",
      pt.status === "fail" && /step "see the banner": expect\(locator\)\.toHaveText\("Welcome"\) failed/.test(pt.note) &&
      pt.evidence.result === "fail" && pt.evidence.label === "see the banner" &&
      fs.existsSync(path.join(pruns, pt.evidence.dir, "key-02.png")), pt.note);
    r = pcli({ ...PENV, DEEP_PLAN_PLAYWRIGHT: "none" }, "check", "run", "br-pw", "1", "flow", "--inline");
    ok("playwright: with neither cmux nor Playwright the check needs a variant and says what to install",
      pck("flow").status === "needs-variant" && /no browser driver here/.test(pck("flow").note) && /npx playwright install chromium/.test(pck("flow").note) &&
      /✋ flow needs a variant/.test(r.stdout) && !/❌ flow/.test(r.stdout),
      JSON.stringify(pck("flow")));
    r = pcli({ ...PENV, FAKE_PW_NO_BROWSER: "1" }, "check", "run", "br-pw", "1", "flow", "--inline");
    ok("playwright: the package without its Chromium is a missing driver, not a failed check",
      pck("flow").status === "needs-variant" && /Chromium is not installed/.test(pck("flow").note), JSON.stringify(pck("flow")));
    fs.writeFileSync(path.join(BR, "e2e", "hangs.js"), 'await step("wait forever", async () => { await new Promise(() => {}); });\n');
    vj.recipes.push({ id: "hangs", kind: "browser", steps: [{ browser: "e2e/hangs.js", timeout: 2 }] });
    fs.writeFileSync(path.join(BR, ".seamux", "verify.json"), JSON.stringify(vj, null, 2));
    p2.deliverables[0].checks.push({ id: "hangs", kind: "browser", name: "hangs", recipe: "hangs" });
    pcli(PENV, "render", tmpSpec(p2), "--root", BR);
    const t0 = Date.now();
    r = pcli(PENV, "check", "run", "br-pw", "1", "hangs", "--inline");
    const pl = fs.readFileSync(PWLOG, "utf8").trim().split("\n").map(l => JSON.parse(l));
    ok("playwright: a script past its timeout fails in its step and closes the browser itself, well before the hard kill",
      pck("hangs").status === "fail" && /timed out after 2s/.test(pck("hangs").note) && Date.now() - t0 < 20000 &&
      pl[pl.length - 1].close === true, pck("hangs").note);
    r = pcli({ ...PENV, SEAMUX_HOST: "cmux" }, "check", "run", "br-pw", "1", "flow", "--inline");
    ok("playwright: in cmux the repl still drives it", r.status === 0 && cmuxCalls() > before);
    pcli(PENV, "close", "br-pw");
  }
}

// -------------------------------------------------- claim steps: engine-run acquisition
//
// A claim polls a command until it prints the resource, may ask a person at
// the same time (first to land wins), may hold a machine-wide lock, and
// releases what it took when the run ends: pass, fail or a trapped signal.
// Only a SIGKILL leaves it held, for `check release`.
{
  const CR = path.join(TMP, "claim-root");
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  fs.mkdirSync(path.join(CR, ".seamux"), { recursive: true });
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: CR });
  const REL = path.join(CR, "released.txt");
  const recipes = [
    { id: "poll", kind: "e2e", steps: [
      { claim: "test -f env.free && cat env.free", export: "QA_ENV", interval: 0.1, timeout: 10,
        release: `echo released-$QA_ENV >> ${JSON.stringify(REL)}` },
      { run: "echo deploy-to-$QA_ENV" }] },
    { id: "askonly", kind: "e2e", steps: [
      { claim: null, ask: "Which variant?", export: "VARIANT" }, { run: "echo using-$VARIANT" }] },
    { id: "both", kind: "e2e", steps: [
      { claim: "test -f never-there && echo x", ask: "Pick a QA env", choices: "printf 'qa-1\\nqa-2\\n'",
        export: "QA_ENV", interval: 0.2, timeout: 20 },
      { run: "echo on-$QA_ENV" }] },
    { id: "lock", kind: "e2e", steps: [{ claim: "true", lock: "port:5432", interval: 0.2, timeout: 10 }, { run: "echo locked-run" }] },
    { id: "fails", kind: "e2e", steps: [
      { claim: "echo qa-5", export: "QA_ENV", release: `echo released-$QA_ENV >> ${JSON.stringify(REL)}` }, { run: "exit 4" }] },
    { id: "sleeper", kind: "e2e", steps: [
      { claim: "test -f never-there && echo x", export: "QA_ENV", lock: "qa-lock-4", interval: 2, timeout: 60,
        release: `echo rel-sleeper >> ${JSON.stringify(REL)}` }, { run: "true" }] },
    { id: "badrel", kind: "e2e", steps: [{ claim: "echo qa-4", export: "QA_ENV", lock: "qa-lock-3", release: "exit 9" }, { run: "true" }] },
    { id: "term", kind: "e2e", steps: [
      { claim: "echo qa-9", export: "QA_ENV", lock: "qa-lock", release: `echo rel-$QA_ENV >> ${JSON.stringify(REL)}` },
      { run: "sleep 30" }] },
    { id: "kill", kind: "e2e", steps: [
      { claim: "echo qa-7", export: "QA_ENV", lock: "qa-lock-2", release: `echo rel-$QA_ENV >> ${JSON.stringify(REL)}` },
      { run: "sleep 30" }] },
  ];
  fs.writeFileSync(path.join(CR, ".seamux", "verify.json"), JSON.stringify({ recipes }, null, 2));
  const s = JSON.parse(JSON.stringify(spec));
  s.slug = "cl-1";
  s.deliverables[0] = { title: "QA flow", body: "A claim.", files: ["src/a.ts"],
    checks: recipes.map(r => ({ id: r.id, kind: "e2e", name: r.id, recipe: r.id })) };
  cli("render", tmpSpec(s), "--root", CR);
  const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "cl-1.key.json"), "utf8"));
  cli("grade", "cl-1", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
  cli("go", "cl-1", "1"); cli("start", "cl-1", "1");
  const cst = () => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "cl-1.json"), "utf8"));
  const cck = id => cst().increments[0].checks[id];
  const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (cond, ms = 10000) => { const t = Date.now() + ms; while (Date.now() < t) { if (cond()) return true; pause(100); } return cond(); };
  const LOCKS = path.join(ENV.DEEP_PLAN_PLANS_DIR, "locks");

  ok("render stores a claim step with its ask, lock and release",
    cck("both").exec.steps[0].kind === "claim" && cck("both").exec.steps[0].ask === "Pick a QA env" &&
    cck("lock").exec.steps[0].lock === "port:5432" && cck("poll").exec.tier === "expensive" &&
    cck("askonly").exec.steps[0].command === "");

  let r = cli("check", "run", "cl-1", "1", "poll");
  ok("a claim runs detached and polls", r.status === 0 && /started detached/.test(r.stdout));
  pause(400);
  fs.writeFileSync(path.join(CR, "env.free"), "qa-3\n");
  cli("check", "wait", "cl-1", "1", "poll", "--timeout", "20");
  ok("…until its command prints a value, exported to the steps after it",
    cck("poll").status === "pass" && /deploy-to-qa-3/.test(fs.readFileSync(cck("poll").ran.log, "utf8")));
  ok("…and its release runs when the run ends, with the claimed value",
    /released-qa-3/.test(fs.readFileSync(REL, "utf8")) && !cck("poll").claims);

  r = cli("check", "run", "cl-1", "1", "askonly", "--inline");
  ok("a claim that only asks parks the check at needs-value, keeping its question",
    r.status === 0 && cck("askonly").status === "needs-value" && cck("askonly").ask.question === "Which variant?" &&
    /--from claim --set VARIANT=<value>/.test(r.stdout));
  const srow = JSON.parse(cli("status", "--json").stdout).find(p => p.slug === "cl-1");
  ok("status --json carries the question for the Dock, and lists the check outstanding",
    srow.increments[0].checks.find(c => c.id === "askonly").ask.name === "VARIANT" &&
    srow.checksOutstanding.some(c => c.id === "askonly" && c.status === "needs-value"));
  ok("done is refused while a check needs a value", /askonly needs-value/.test(cli("done", "cl-1", "1").stderr));
  r = cli("check", "run", "cl-1", "1", "askonly", "--set", "VARIANT=v2", "--detach");
  ok("--detach runs even a run-to-completion as a detached runner (the Dock's buttons)",
    r.status === 0 && /started detached/.test(r.stdout));
  cli("check", "wait", "cl-1", "1", "askonly", "--timeout", "20");
  ok("…and an answer to a parked claim resumes from it, the value reaching the steps after",
    cck("askonly").status === "pass" && /using-v2/.test(fs.readFileSync(cck("askonly").ran.log, "utf8")));
  const cwork = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "cl-1.working.html"), "utf8");
  ok("the working page marks a claim that asks for the Dock's picker",
    /<li class="dp-check" data-n="1" data-id="askonly" data-status="pass" data-asks="1">/.test(cwork));
  cli("check", "reset", "cl-1", "1", "askonly");
  cli("check", "run", "cl-1", "1", "askonly", "--inline");
  r = cli("check", "run", "cl-1", "1", "askonly", "--set", "VARIANT=v2", "--inline");
  ok("--set answers it and the run goes on with the value",
    r.status === 0 && cck("askonly").status === "pass" && !cck("askonly").ask &&
    /using-v2/.test(fs.readFileSync(cck("askonly").ran.log, "utf8")));
  ok("--set takes NAME=value, the value not empty", cli("check", "run", "cl-1", "1", "askonly", "--set", "nope").status === 1 &&
    cli("check", "run", "cl-1", "1", "askonly", "--set", "VARIANT=").status === 1);

  r = cli("check", "run", "cl-1", "1", "both");
  ok("a claim that polls and asks stays running while it asks",
    until(() => { const c = cck("both"); return c.status === "running" && c.ask && c.ask.choices.join(",") === "qa-1,qa-2"; }));
  r = cli("check", "run", "cl-1", "1", "both", "--set", "QA_ENV=qa-2");
  ok("…a person's answer is handed to the running claim", r.status === 0 && /handed QA_ENV=qa-2 to the running both/.test(r.stdout));
  cli("check", "wait", "cl-1", "1", "both", "--timeout", "20");
  ok("…and the first to land wins: the run goes on with the person's value",
    cck("both").status === "pass" && /on-qa-2/.test(fs.readFileSync(cck("both").ran.log, "utf8")));
  ok("an answer naming the wrong variable is refused while it asks", (() => {
    cli("check", "run", "cl-1", "1", "both");
    until(() => cck("both").ask);
    const x = cli("check", "run", "cl-1", "1", "both", "--set", "OTHER=1");
    cli("check", "run", "cl-1", "1", "both", "--set", "QA_ENV=qa-1");
    cli("check", "wait", "cl-1", "1", "both", "--timeout", "20");
    return x.status === 1 && /asking for QA_ENV, not OTHER/.test(x.stderr) && cck("both").status === "pass";
  })());

  // Not the probe's own child: one it never waits on would linger as a zombie
  // that kill(pid, 0) still finds, and the lock would never look free.
  const holder = { pid: Number(execSync("sh -c 'sleep 2 >/dev/null 2>&1 & echo $!'", { encoding: "utf8" }).trim()) };
  fs.mkdirSync(LOCKS, { recursive: true });
  fs.writeFileSync(path.join(LOCKS, "port_5432.lock"), JSON.stringify({ name: "port:5432", pid: holder.pid, slug: "other", n: "1", id: "db" }));
  r = cli("check", "run", "cl-1", "1", "lock");
  cli("check", "wait", "cl-1", "1", "lock", "--timeout", "20");
  const llog = fs.readFileSync(cck("lock").ran.log, "utf8");
  ok("a lock held by a live process is waited on, naming who holds it",
    cck("lock").status === "pass" && new RegExp(`waiting on pid ${holder.pid} \\(other 1 db\\)`).test(llog) && /locked-run/.test(llog));
  ok("…and released when the run ends", !fs.existsSync(path.join(LOCKS, "port_5432.lock")));
  fs.writeFileSync(path.join(LOCKS, "port_5432.lock"), JSON.stringify({ name: "port:5432", pid: 999999 }));
  cli("check", "run", "cl-1", "1", "lock");
  cli("check", "wait", "cl-1", "1", "lock", "--timeout", "20");
  ok("a lock whose pid is dead is broken at once",
    cck("lock").status === "pass" && /pid 999999 is gone, breaking it/.test(fs.readFileSync(cck("lock").ran.log, "utf8")));

  cli("check", "run", "cl-1", "1", "fails");
  cli("check", "wait", "cl-1", "1", "fails", "--timeout", "20");
  ok("a run that fails still releases its claim", cck("fails").status === "fail" && /released-qa-5/.test(fs.readFileSync(REL, "utf8")));

  cli("check", "run", "cl-1", "1", "sleeper");
  ok("a claim polling (asleep between polls) holds its lock", until(() => fs.existsSync(path.join(LOCKS, "qa-lock-4.lock")) && cck("sleeper").status === "running"));
  process.kill(cck("sleeper").runner.pid, "SIGTERM");
  ok("…and a SIGTERM then still stops the run, as terminated",
    until(() => cck("sleeper").status === "fail", 15000) && /terminated/.test(cck("sleeper").note));
  ok("…dropping its lock and not running a release for a claim that never landed",
    !fs.existsSync(path.join(LOCKS, "qa-lock-4.lock")) && !/rel-sleeper/.test(fs.readFileSync(REL, "utf8")) && !cck("sleeper").claims);
  cli("check", "run", "cl-1", "1", "badrel");
  cli("check", "wait", "cl-1", "1", "badrel", "--timeout", "20");
  ok("a release that fails keeps the claim and its lock, and says so",
    /release failed, still held/.test(cck("badrel").note) && (cck("badrel").claims || [])[0].release === "exit 9" &&
    fs.existsSync(path.join(LOCKS, "qa-lock-3.lock")));
  r = cli("check", "release", "cl-1", "1", "badrel");
  ok("…and check release tries it again, keeping it while it still fails",
    r.status === 1 && /still held/.test(r.stdout) && (cck("badrel").claims || []).length === 1);
  r = cli("check", "status", "cl-1", "1", "badrel", "--json");
  ok("check status --json lists held claims without the env they were claimed under",
    JSON.parse(r.stdout)[0].claims[0].release === "exit 9" && !("env" in JSON.parse(r.stdout)[0].claims[0]));
  cli("check", "run", "cl-1", "1", "term");
  ok("a claiming run records what it holds", until(() => (cck("term").claims || []).some(c => c.value === "qa-9")));
  process.kill(cck("term").runner.pid, "SIGTERM");
  ok("SIGTERM to its runner fails the check as terminated",
    until(() => cck("term").status === "fail", 15000) && /terminated/.test(cck("term").note));
  ok("…and releases the claim and its lock",
    until(() => /rel-qa-9/.test(fs.readFileSync(REL, "utf8"))) && !fs.existsSync(path.join(LOCKS, "qa-lock.lock")) && !cck("term").claims);

  cli("check", "run", "cl-1", "1", "kill");
  until(() => (cck("kill").claims || []).some(c => c.value === "qa-7"));
  const kpid = cck("kill").runner.pid;
  try { process.kill(-kpid, "SIGKILL"); } catch { process.kill(kpid, "SIGKILL"); }
  until(() => { try { process.kill(kpid, 0); return false; } catch { return true; } });
  r = cli("check", "status", "cl-1", "1", "kill");
  ok("a SIGKILL leaves the claim held: the check is lost and names it",
    cck("kill").status === "fail" && /runner lost/.test(cck("kill").note) && /check release cl-1 1 kill/.test(cck("kill").note) &&
    /holds: QA_ENV=qa-7 · lock qa-lock-2/.test(r.stdout) && !/rel-qa-7/.test(fs.readFileSync(REL, "utf8")));
  r = cli("check", "run", "cl-1", "1", "kill");
  ok("a new run is refused while the last one's claims are held", r.status === 1 && /still holds qa-lock-2 .*check release cl-1 1 kill/.test(r.stdout));
  r = cli("check", "release", "cl-1", "1", "kill");
  ok("check release gives it back: the release runs and the dead pid's lock goes",
    r.status === 0 && /rel-qa-7/.test(fs.readFileSync(REL, "utf8")) && !fs.existsSync(path.join(LOCKS, "qa-lock-2.lock")) &&
    !cck("kill").claims);
  ok("…and a check holding nothing says so", /holds nothing to release/.test(cli("check", "release", "cl-1", "1", "kill").stdout));
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
  // The untracked file reaches the patch through a scratch index; the real one
  // used to keep it as intent-to-add, for the next `git commit -a` to commit.
  ok("…and leaves the untracked file out of the user's index",
    execSync("git ls-files -- worked.txt", { cwd: REPO, encoding: "utf8" }).trim() === "");
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

// -------------------------------------------------- the start sha comes from go
//
// The gate sees Edit/Write and the Bash writes its heuristic catches, so an
// increment built by a script or a `cp` was never flipped to working and closed
// with no base: no patch, nothing for a review to open. go records the base, so
// every increment has one however its writes were made.
{
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  const sha = n => stOf("sha-plan").increments[n - 1].startSha;
  const head = () => execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  const commit = m => execSync(`git add -A && git -c user.email=p@p -c user.name=p commit -q --allow-empty -m ${m}`, { cwd: REPO });
  cli("render", tmpSpec({ ...spec, slug: "sha-plan" }));
  const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "sha-plan.key.json"), "utf8"));
  cli("grade", "sha-plan", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));

  const h1 = head();
  cli("go", "sha-plan", "1");
  ok("go stamps HEAD on the increment", sha(1) === h1 && stOf("sha-plan").increments[0].status === "authorized");
  // A write the gate never sees: no Edit, no Bash command, just a file landing.
  fs.writeFileSync(path.join(REPO, "scripted.txt"), "written by a script\n");
  passAll("sha-plan", 1);
  const d = cli("done", "sha-plan", "1");
  const patch = path.join(ENV.DEEP_PLAN_PLANS_DIR, "sha-plan.inc1.patch");
  ok("an increment taken from go to done with no gated edit still writes its patch",
    d.status === 0 && fs.existsSync(patch) && fs.readFileSync(patch, "utf8").includes("scripted.txt"), d.stderr);
  commit("inc1");

  const h2 = head();
  cli("go", "sha-plan", "2");
  commit("late");                            // HEAD moves after the go
  ok("start keeps the sha go recorded", cli("start", "sha-plan", "2").status === 0 && sha(2) === h2 && h2 !== head());
  cli("reset", "sha-plan", "2");
  ok("reset clears the start sha", sha(2) === "" && stOf("sha-plan").increments[1].status === "pending");
  const h3 = head();
  cli("go", "sha-plan", "2");
  ok("the next go re-stamps it at the new HEAD", sha(2) === h3 && h3 !== h2);
  cli("block", "sha-plan", "2", "waiting");
  commit("blocked");
  ok("block keeps the sha", sha(2) === h3);
  cli("go", "sha-plan", "2");
  ok("a blocked increment's re-go keeps its first sha", sha(2) === h3 && h3 !== head());
  // An older engine's reset left the sha in place; go from pending must not keep it.
  cli("reset", "sha-plan", "2");
  const stale = stOf("sha-plan"); stale.increments[1].startSha = h1;
  fs.writeFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "sha-plan.json"), JSON.stringify(stale));
  cli("go", "sha-plan", "2");
  ok("go re-stamps a pending increment that still carries an old sha", sha(2) === head() && head() !== h1);

  fs.rmSync(path.join(REPO, "scripted.txt"), { force: true });
  commit("cleanup");
  cli("close", "sha-plan");
  fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "sha-plan.json"), { force: true });
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

  // The owner is a pane. Only its writes flip an increment to working; any
  // other Claude writing inside the root is a guest: let through, told once
  // per session, and logged for the increment's review.
  const ROOT3 = path.join(TMP, "owner-root");
  fs.mkdirSync(ROOT3, { recursive: true });
  const gateWho = (env, session, file) => spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], {
    encoding: "utf8", env: { ...ENV, ...env },
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(ROOT3, file) }, cwd: ROOT3, session_id: session }),
  });
  const P1 = { CLAUDE_CODE_SESSION_ID: "sess-a", CMUX_WORKSPACE_ID: "ws-1", CMUX_SURFACE_ID: "pane-1111aaaa" };
  const s3 = JSON.parse(JSON.stringify(spec)); s3.slug = "owner-3";
  as(P1, "render", tmpSpec(s3), "--root", ROOT3);
  ok("render stamps the owner's pane from CMUX_SURFACE_ID", stOf("owner-3").owner.surface === "pane-1111aaaa");
  ok("status --json carries the owner's pane", rowOf("owner-3").owner.surface === "pane-1111aaaa");
  const key3 = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "owner-3.key.json"), "utf8"));
  cli("grade", "owner-3", ...Object.entries(key3.answers).map(([q, v]) => `${q}=${v.letter}`));
  cli("go", "owner-3", "1");

  const guestEnv = { CMUX_WORKSPACE_ID: "ws-1", CMUX_SURFACE_ID: "pane-2222bbbb" };
  let g = gateWho(guestEnv, "sess-guest", "a.txt");
  let said = {}; try { said = JSON.parse(g.stdout || "{}"); } catch { /* checked below */ }
  ok("a guest's write inside the root is let through", g.status === 0);
  ok("…with a systemMessage naming the plan and the owner's pane",
    /owner-3 is owned by pane pane-111/.test(said.systemMessage || "") && /guest/.test(said.systemMessage || ""));
  ok("…which the model hears too", /owner-3 is owned by/.test((said.hookSpecificOutput || {}).additionalContext || ""));
  ok("…and it does not flip the increment to working", stOf("owner-3").increments[0].status === "authorized");
  ok("…nor take the plan's ownership",
    stOf("owner-3").owner.surface === "pane-1111aaaa" && stOf("owner-3").owner.session === "sess-a");
  ok("…and the plan's log names the guest's pane and the increment",
    (stOf("owner-3").log || []).some(l => /^guest: pane pane-222 wrote inside the root during increment 1/.test(l.what)));
  g = gateWho(guestEnv, "sess-guest", "b.txt");
  ok("the warning is said once per session and plan",
    g.status === 0 && !(g.stdout || "").includes("guest") &&
    (stOf("owner-3").log || []).filter(l => /^guest:/.test(l.what)).length === 1);

  // A /clear in the owner's pane: a new session id, the same pane.
  g = gateWho({ CMUX_WORKSPACE_ID: "ws-1", CMUX_SURFACE_ID: "pane-1111aaaa" }, "sess-after-clear", "c.txt");
  ok("the owner's pane after a /clear flips the increment to working, unwarned",
    g.status === 0 && !(g.stdout || "").includes("guest") && stOf("owner-3").increments[0].status === "working");
  ok("…and the gate's own write leaves the owner as it was", stOf("owner-3").owner.session === "sess-a");
  const before3 = (stOf("owner-3").log || []).length;
  g = gateWho({ CMUX_WORKSPACE_ID: "ws-9", CMUX_SURFACE_ID: "pane-9999ffff" }, "sess-a", "d.txt");
  ok("the owner's session resumed in another pane is still the owner, unwarned",
    g.status === 0 && !(g.stdout || "").includes("guest") && (stOf("owner-3").log || []).length === before3);

  // Outside cmux the owner is its session.
  const ROOT4 = path.join(TMP, "owner-root-4");
  fs.mkdirSync(ROOT4, { recursive: true });
  const s4 = JSON.parse(JSON.stringify(spec)); s4.slug = "owner-4";
  const NOCMUX = { CMUX_SURFACE_ID: "", CMUX_WORKSPACE_ID: "" };
  as({ ...NOCMUX, CLAUDE_CODE_SESSION_ID: "sess-solo" }, "render", tmpSpec(s4), "--root", ROOT4);
  const key4 = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "owner-4.key.json"), "utf8"));
  cli("grade", "owner-4", ...Object.entries(key4.answers).map(([q, v]) => `${q}=${v.letter}`));
  cli("go", "owner-4", "1");
  const gate4 = session => spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], {
    encoding: "utf8", env: { ...ENV, ...NOCMUX },
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(ROOT4, "x.txt") }, cwd: ROOT4, session_id: session }),
  });
  g = gate4("sess-other");
  ok("outside cmux, another session is a guest", g.status === 0 && /guest/.test(g.stdout) &&
    stOf("owner-4").increments[0].status === "authorized");
  g = gate4("sess-solo");
  ok("…and the owner's own session flips the increment", stOf("owner-4").increments[0].status === "working");

  for (const n of ["owner-1", "owner-2", "owner-3", "owner-4"]) cli("close", n);
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
  // The guard's cost: an edit in a family member against an edit outside
  // every family, taken alternately at the same moment (so the state the
  // gate scans is the same for both), each side's fastest of 15. One hook
  // call is a process spawn of 50-70 ms; a mean of a few is mostly a shared
  // runner's scheduling, while the fastest call still carries any real work.
  const once = (target, cwd) => {
    const t = process.hrtime.bigint();
    gateAs("timing", target, cwd);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const guardCost = () => {
    const fam = [], out = [];
    for (let i = 0; i < 15; i++) {
      fam.push(once(path.join(UI, "web", "login", "form.tsx"), UI));
      out.push(once(path.join(REPO, "x.txt"), REPO));
    }
    return { fam: Math.min(...fam), out: Math.min(...out) };
  };
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
  ok("the parent's review page links each child to its own page",
    ["example-auth-api", "example-auth-ui", "example-docs"].every(c =>
      fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, fam.slug + ".review.html"), "utf8")
        .includes(`<a class="dp-fam-link" href="${c}.working.html" data-plan="${c}">`)));
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
    const cost = guardCost();
    console.log(`\n  family guard: ${(cost.fam - cost.out).toFixed(1)} ms/edit over an edit outside every family (${cost.out.toFixed(1)} → ${cost.fam.toFixed(1)}, fastest of 15 each)`);
    ok("the family guard costs under 15 ms per edit", cost.fam - cost.out < 15);
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

  // protects: the one answer crew's close paths ask before closing a workspace.
  {
    const prot = (dir) => { const x = cli("protects", dir, "--json"); return x.status === 0 ? JSON.parse(x.stdout) : { err: x.stderr }; };
    let p = prot(UI);
    ok("protects: a child of a live family is protected",
      p.protected === true && p.plan === "example-auth-ui" && p.family && p.family.parent === fam.slug &&
      p.family.role === "child" && p.family.live === true);
    fs.mkdirSync(path.join(UI, "web", "deep"), { recursive: true });
    p = prot(path.join(UI, "web", "deep"));
    ok("protects: a directory inside a plan's root, not only at it", p.protected === true && p.plan === "example-auth-ui");
    fs.rmSync(path.join(UI, "web", "deep"), { recursive: true, force: true });
    const plain = fs.mkdtempSync(path.join(TMP, "plain-"));
    p = prot(plain);
    ok("protects: a directory no plan or family holds is not", JSON.stringify(p) === '{"protected":false}');
    {
    const gone = cli("protects", path.join(TMP, "no-such-dir"), "--json");
    ok("protects: a directory that is gone still gets an answer", gone.status === 0 && JSON.parse(gone.stdout).protected === false);
    const goneIn = cli("protects", path.join(UI, "gone", "deeper"), "--json");
    ok("protects: …inside a live root, a gone directory is protected", goneIn.status === 0 && JSON.parse(goneIn.stdout).protected === true);
  }

    // A finished member stays protected while its family is not done.
    const apiFile = path.join(ENV.DEEP_PLAN_STATE_DIR, "example-auth-api.json");
    const apiWas = fs.readFileSync(apiFile, "utf8");
    const apiDone = JSON.parse(apiWas);
    apiDone.phase = "done"; for (const i of apiDone.increments) i.status = "done";
    fs.writeFileSync(apiFile, JSON.stringify(apiDone));
    p = prot(API);
    ok("protects: a finished child of a live family is still protected",
      p.protected === true && p.open.length === 0 && /the example-auth-revamp family, which is not done/.test(p.why));
    fs.writeFileSync(apiFile, apiWas);

    // Outside every family: a done phase with an increment left open is live;
    // a plan done in full is not.
    const SOLO = path.join(TMP, "solo");
    fs.mkdirSync(SOLO); execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: SOLO });
    r = cli("render", tmpSpec(child("example-solo", ["solo.txt"])), "--root", SOLO);
    ok("protects: a solo plan renders", r.status === 0);
    const soloFile = path.join(ENV.DEEP_PLAN_STATE_DIR, "example-solo.json");
    const solo = JSON.parse(fs.readFileSync(soloFile, "utf8"));
    solo.phase = "done"; solo.increments.forEach((i, k) => { i.status = k === 0 ? "pending" : "done"; });
    fs.writeFileSync(soloFile, JSON.stringify(solo));
    p = prot(SOLO);
    ok("protects: a done phase with an increment not done is protected",
      p.protected === true && p.family === null && p.open.join() === String(solo.increments[0].n));
    solo.increments.forEach(i => { i.status = "done"; });
    fs.writeFileSync(soloFile, JSON.stringify(solo));
    p = prot(SOLO);
    ok("protects: a plan done in full, in no family, is not", p.protected === false && p.plan === "example-solo");
    const t = cli("protects", UI);
    ok("protects: the text form says why", t.status === 0 && /^protected: plan example-auth-ui is \w+/.test(t.stdout));
    solo.phase = "closed"; fs.writeFileSync(soloFile, JSON.stringify(solo));
    p = prot(SOLO);
    ok("protects: a closed plan holds nothing", JSON.stringify(p) === '{"protected":false}');
    // Reached through the family index rather than the state scan, a closed
    // member with open increments is still set aside.
    const uiFile = path.join(ENV.DEEP_PLAN_STATE_DIR, "example-auth-ui.json");
    const uiWas = fs.readFileSync(uiFile, "utf8");
    fs.writeFileSync(uiFile, JSON.stringify({ ...JSON.parse(uiWas), phase: "closed" }));
    p = prot(UI);
    ok("protects: a closed member with open increments is not live as a plan",
      p.protected === true && !/plan example-auth-ui is closed/.test(p.why) && /family, which is not done/.test(p.why), JSON.stringify(p));
    fs.writeFileSync(uiFile, uiWas);
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

// -------------------------------------------------- delegated go
// A workstream with go: "parent" lets the parent agent give that child's go.
// Who gives a go is worked out from where it runs: inside the parent's root is
// the parent, --by human or a shell outside Claude Code is a person, anything
// else is the plan's own session (self). A delegated child's self-go is
// refused, --force or not; a person can always step in.
{
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  const DR = path.join(TMP, "dlgrepo"), DW = path.join(TMP, "dlgrepo.worktrees");
  fs.mkdirSync(DR, { recursive: true });
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: DR });
  const KID = path.join(DW, "kid"), TWO = path.join(DW, "two");
  execSync(`git worktree add -q -b kid ${KID} && git worktree add -q -b two ${TWO}`, { cwd: DR });
  const NOCC = { ...ENV }; delete NOCC.CLAUDECODE;
  // A command as some session would run it: from `cwd`, inside Claude Code or not.
  const as = (cwd, agent, ...args) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...args],
    { encoding: "utf8", cwd, env: agent ? { ...NOCC, CLAUDECODE: "1" } : NOCC });
  const st = slug => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, slug + ".json"), "utf8"));
  const lastLine = r => { const l = r.stderr.trim().split("\n"); return l[l.length - 1]; };
  const gradeRight = slug => {
    const k = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, slug + ".key.json"), "utf8"));
    return cli("grade", slug, ...Object.entries(k.answers).map(([q, a]) => `${q}=${a.letter}`));
  };
  const kidSpec = slug => { const c = JSON.parse(JSON.stringify(spec)); c.slug = slug;
    c.deliverables = c.deliverables.map(d => ({ ...d, files: [] })); return c; };
  for (const [slug, root] of [["example-dlg-kid", KID], ["example-dlg-two", TWO]]) {
    cli("render", tmpSpec(kidSpec(slug)), "--root", root); gradeRight(slug);
  }
  const fam = JSON.parse(fs.readFileSync(path.join(HERE, "examples", "example.family.spec.json"), "utf8"));
  const parent = { ...fam, slug: "example-dlg",
    workstreams: [{ slug: "example-dlg-kid", owns: ["kid/**"], go: "parent" }, { slug: "example-dlg-two", owns: ["two/**"] }] };
  let r = cli("render", tmpSpec({ ...parent, workstreams: [{ slug: "example-dlg-kid", go: "parents" }] }), "--root", DR);
  ok("delegation: a go other than \"parent\" is refused at render", r.status !== 0 && /\.go must be "parent"/.test(r.stderr));
  r = cli("render", tmpSpec(parent), "--root", DR);
  gradeRight("example-dlg");
  const idx = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "families", "example-dlg", "index.json"), "utf8"));
  ok("delegation: the index carries each child's go owner",
    r.status === 0 && idx.members.find(m => m.slug === "example-dlg-kid").go === "parent" &&
    idx.members.find(m => m.slug === "example-dlg-two").go === "");

  // The child cannot authorize itself, and --force is no way past that.
  r = as(KID, true, "go", "example-dlg-kid", "next");
  ok("delegation: a delegated child's own go is refused, the reason on the last line",
    r.status !== 0 && lastLine(r) === "go refused: self-go on a delegated child" && /a person can too/.test(r.stderr) && !/--by human/.test(r.stderr));
  r = as(KID, true, "go", "example-dlg-kid", "next", "--force");
  ok("delegation: …--force does not get past it", r.status !== 0 && st("example-dlg-kid").increments.every(i => i.status === "pending"));
  const row = JSON.parse(cli("status", "--json").stdout).find(x => x.slug === "example-dlg-kid");
  ok("delegation: the shut gate says the parent gives the go", row && /parent's to give \(example-dlg\)/.test(row.gate.why));
  const e = spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], { encoding: "utf8", env: ENV,
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(KID, "x.ts") }, cwd: KID, session_id: "dlg" }) });
  ok("delegation: the edit refusal tells the child not to run go", e.status === 2 && /delegated to the parent \(example-dlg\): do not run deep-plan go here/.test(e.stderr));

  // The parent gives it from its own root; the record says so.
  r = as(DR, true, "go", "example-dlg-kid", "next");
  ok("delegation: the parent's go from its own root goes, recorded by parent",
    r.status === 0 && st("example-dlg-kid").increments[0].status === "authorized" && st("example-dlg-kid").increments[0].by === "parent" &&
    st("example-dlg-kid").log.some(l => /authorized by parent/.test(l.what)));
  const incRow = JSON.parse(cli("status", "--json").stdout).find(x => x.slug === "example-dlg-kid").increments[0];
  ok("delegation: status rows carry who gave each go", incRow.by === "parent");
  cli("done", "example-dlg-kid", "1", "--force");

  // A hold: the parent's written reason, and its own go refused while it holds.
  ok("delegation: the child cannot hold itself", as(KID, true, "family", "hold", "example-dlg-kid", "x").status !== 0);
  r = as(DR, true, "family", "hold", "example-dlg-kid", "the session type is still moving");
  ok("delegation: the parent holds a child, saying why", r.status === 0 && /holding example-dlg-kid/.test(r.stdout));
  ok("delegation: a hold needs a reason", as(DR, true, "family", "hold", "example-dlg-kid").status !== 0);
  r = as(DR, true, "go", "example-dlg-kid", "next");
  ok("delegation: the parent's go is refused while it holds", r.status !== 0 && /family unhold example-dlg-kid/.test(r.stderr));
  const held = JSON.parse(cli("status", "--json").stdout).find(x => x.slug === "example-dlg-kid");
  ok("delegation: the gate reason shows the hold", /holding it: "the session type is still moving"/.test(held.gate.why));
  r = as(KID, true, "go", "example-dlg-kid", "next", "--by", "human");
  ok("delegation: a person's go passes a hold, recorded by human",
    r.status === 0 && st("example-dlg-kid").increments[1].by === "human");
  cli("reset", "example-dlg-kid", "2");
  ok("delegation: --by takes only human", as(DR, true, "go", "example-dlg-kid", "next", "--by", "parent").status !== 0);
  r = as(DR, true, "family", "unhold", "example-dlg-kid");
  ok("delegation: the parent lifts its hold", r.status === 0 && !JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, "families", "example-dlg", "control.json"), "utf8")).holds["example-dlg-kid"]);

  // Take-back is a person's, and outlives a re-render.
  r = as(DR, true, "family", "take-back", "example-dlg-kid");
  ok("delegation: an agent cannot take a child's go back", r.status !== 0 && lastLine(r) === "family take-back refused: not a person");
  r = as(DR, false, "family", "take-back", "example-dlg-kid");
  ok("delegation: a person takes it back", r.status === 0 && /a person's until/.test(r.stdout));
  cli("render", tmpSpec(parent), "--root", DR);
  r = as(DR, true, "go", "example-dlg-kid", "next");
  ok("delegation: after a take-back (and a re-render) the parent's go is refused", r.status !== 0 && /family give-back example-dlg-kid/.test(r.stderr));
  r = as(KID, true, "go", "example-dlg-kid", "next");
  ok("delegation: …and the child's go is ordinary again, recorded by self", r.status === 0 && st("example-dlg-kid").increments[1].by === "self");
  cli("reset", "example-dlg-kid", "2");
  r = as(DR, true, "family", "give-back", "example-dlg-kid", "--by", "human");
  ok("delegation: give-back on a person's word returns it", r.status === 0 && as(KID, true, "go", "example-dlg-kid", "next").status !== 0);

  // A child the spec does not delegate: the parent may not give its go.
  r = as(DR, true, "go", "example-dlg-two", "next");
  ok("delegation: the parent's go on an undelegated child is refused", r.status !== 0 && /does not delegate it/.test(r.stderr));
  r = as(TWO, true, "go", "example-dlg-two", "next");
  ok("delegation: an undelegated child's own go goes, as before", r.status === 0 && st("example-dlg-two").increments[0].by === "self");
  r = as(TWO, true, "family", "take-back", "example-dlg-two", "--by", "human");
  ok("delegation: nothing to take back on an undelegated child", r.status !== 0);
  r = as(TMP, false, "go", "example-dlg", "next");
  ok("delegation: a go from a shell outside Claude Code is a person's", r.status === 0 && st("example-dlg").increments[0].by === "human");
  ok("delegation: the log says how a person was decided",
    st("example-dlg").log.some(l => /authorized by human \(no Claude Code session\)/.test(l.what)) &&
    st("example-dlg-kid").log.some(l => /authorized by human \(--by human\)/.test(l.what)));
  const ctl = path.join(ENV.DEEP_PLAN_STATE_DIR, "families", "example-dlg", "control.json");
  const c0 = JSON.parse(fs.readFileSync(ctl, "utf8"));
  c0.holds["example-gone"] = { reason: "stale", at: 1, by: "parent" };
  fs.writeFileSync(ctl, JSON.stringify(c0));
  cli("render", tmpSpec(parent), "--root", DR);
  ok("delegation: a render drops control entries for slugs no longer children",
    !("example-gone" in JSON.parse(fs.readFileSync(ctl, "utf8")).holds));

  // Family verdicts: who goes, what is held, and each increment's verdicts,
  // on status rows, in `family status` and on the working page.
  {
    as(DR, true, "family", "hold", "example-dlg-two", "waiting on the contract");
    const rows = JSON.parse(cli("status", "--json").stdout);
    const kf = rows.find(x => x.slug === "example-dlg-kid").family;
    const pf = rows.find(x => x.slug === "example-dlg").family;
    ok("verdicts: a delegated child's row says the parent goes", kf.go === "parent" && pf.go === "human");
    ok("verdicts: the row lists the parent's holds", pf.holds["example-dlg-two"] === "waiting on the contract");
    const km = pf.members.find(m => m.slug === "example-dlg-kid"), tm = pf.members.find(m => m.slug === "example-dlg-two");
    ok("verdicts: each member says who goes and what it is held on",
      km.go === "parent" && km.held === "" && tm.go === "human" && tm.held === "waiting on the contract");
    const k1 = km.increments[0];
    ok("verdicts: each increment carries status, checks, review and who gave its go",
      k1.n === 1 && k1.status === "done" && typeof k1.checks === "string" && k1.review === "" && k1.by === "parent" &&
      km.increments.length === st("example-dlg-kid").increments.length);
    const t = cli("family", "status", "example-dlg").stdout;
    ok("verdicts: family status prints them per increment",
      /example-dlg-kid .*· parent goes/.test(t) && /example-dlg-two .*· a person goes/.test(t) &&
      /✓ 1 .*go by parent/.test(t) && /held by the parent: waiting on the contract/.test(t));
    const page = fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "example-dlg.working.html"), "utf8");
    ok("verdicts: the parent's working page shows the go owner, the hold and each increment",
      /parent goes/.test(page) && /held by the parent: waiting on the contract/.test(page) &&
      /class="dp-fam-inc dp-fam-done"[^>]*>✓ 1 [\s\S]*?go by parent<\/span><\/span>/.test(page));
    as(DR, true, "family", "unhold", "example-dlg-two");
  }

  // await-go: the child blocks until the parent's go, and nothing is typed into it.
  r = as(KID, true, "await-go", "example-dlg-kid", "--timeout", "1");
  ok("await-go: with no go, it exits 2 at its timeout", r.status === 2 && /run it again/.test(r.stderr));
  ok("await-go: --timeout must be above 0", as(KID, true, "await-go", "example-dlg-kid", "--timeout", "0").status !== 0);
  {
    const { spawn } = await import("node:child_process");
    const waiter = spawn("node", [path.join(HERE, "deep_plan.mjs"), "await-go", "example-dlg-kid", "--timeout", "30"],
      { cwd: KID, env: { ...NOCC, CLAUDECODE: "1" } });
    let out = "";
    waiter.stdout.on("data", d => { out += d; });
    const exited = new Promise(res => waiter.on("exit", code => res(code)));
    await new Promise(res => setTimeout(res, 1500));
    const g = as(DR, true, "go", "example-dlg-kid", "next");
    const code = await Promise.race([exited, new Promise(res => setTimeout(() => res("timeout"), 10000))]);
    if (code === "timeout") waiter.kill();
    ok("await-go: the parent's go from another process wakes it, printing the number",
      g.status === 0 && code === 0 && out.trim() === "2");
  }
  r = cli("family", "news", "example-dlg-kid");
  ok("await-go: news says an authorized increment has not started, for a child whose wait died",
    /Increment 2 \(.*\) of example-dlg-kid is authorized by parent and not started: start it\./.test(r.stdout));
  r = as(KID, true, "await-go", "example-dlg-kid", "--timeout", "5");
  ok("await-go: an increment already authorized returns at once", r.status === 0 && r.stdout.trim() === "2");
  cli("reset", "example-dlg-kid", "2");
  as(DR, false, "family", "take-back", "example-dlg-kid");
  r = as(KID, true, "await-go", "example-dlg-kid", "--timeout", "5");
  ok("await-go: a take-back ends the wait with exit 3", r.status === 3 && /took example-dlg-kid's go back/.test(r.stderr));
  as(DR, false, "family", "give-back", "example-dlg-kid");
  as(DR, true, "go", "example-dlg-kid", "next"); cli("done", "example-dlg-kid", "2", "--force");
  r = as(KID, true, "await-go", "example-dlg-kid", "--timeout", "5");
  ok("await-go: a plan with nothing left exits 3", r.status === 3 && /no increment left/.test(r.stderr));
  ok("await-go: no such plan exits 3", as(KID, true, "await-go", "example-no-plan", "--timeout", "1").status === 3);
  ok("await-go: a go not given by the parent is not repeated as news",
    !/is authorized/.test(cli("family", "news", "example-dlg-two").stdout));
  cli("reset", "example-dlg-two", "1");
  {
    const { spawn } = await import("node:child_process");
    const waiter = spawn("node", [path.join(HERE, "deep_plan.mjs"), "await-go", "example-dlg-two", "--timeout", "30"],
      { cwd: TWO, env: { ...NOCC, CLAUDECODE: "1" } });
    let err = "";
    waiter.stderr.on("data", d => { err += d; });
    const exited = new Promise(res => waiter.on("exit", code => res(code)));
    await new Promise(res => setTimeout(res, 1500));
    cli("close", "example-dlg");
    const code = await Promise.race([exited, new Promise(res => setTimeout(() => res("timeout"), 10000))]);
    if (code === "timeout") waiter.kill();
    ok("await-go: a parent closed mid-wait ends it with exit 3", code === 3 && /no longer in a family/.test(err));
  }
  for (const n of ["example-dlg", "example-dlg-kid", "example-dlg-two"]) cli("close", n);
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

// -------------------------------------------------- review checks (lookout)
//
// A deliverable that declares a `review` check is gated on `lookout gate` for
// its increment. deep-plan synthesizes the command and runs it through
// lookout's engine; nothing names a recipe. The spike: a synthesized command
// must never trip the recipe-drift warning, however often it runs.
{
  const LK = path.join(HERE, "..", "lookout");
  const RV = path.join(TMP, "review-root");
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  fs.mkdirSync(path.join(RV, ".seamux"), { recursive: true });
  fs.mkdirSync(path.join(RV, "src"), { recursive: true });
  fs.writeFileSync(path.join(RV, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(RV, ".seamux", "verify.json"), JSON.stringify({ recipes: [
    { id: "envs", run: 'echo "root=$DEEP_PLAN_ROOT start=$DEEP_PLAN_START_SHA"' }] }));
  execSync(`git init -q && git add -A && ${G} commit -q -m init`, { cwd: RV });
  // Reviews beside the plans, as installed (~/.claude/plans/reviews): lookout
  // finds a plan's cutover one level up from its store.
  const LENV = { ...ENV, LOOKOUT_ENGINE: LK, LOOKOUT_REVIEWS_DIR: path.join(ENV.DEEP_PLAN_PLANS_DIR, "reviews"),
    LOOKOUT_TYPESAFE_CLIENT: "", LOOKOUT_VENDOR_DIR: path.join(TMP, "lookout-vendor"),
    LOOKOUT_ENGINE_FILE: path.join(TMP, "lookout-engine.json"), LOOKOUT_BIN_DIR: path.join(TMP, "lookout-bin") };
  const lc = (env, ...a) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...a], { encoding: "utf8", env, cwd: RV });
  const lk = (...a) => spawnSync("node", [path.join(LK, "lookout.mjs"), ...a], { encoding: "utf8", env: LENV, cwd: RV });
  const mk = (slug, checks, extra = {}) => {
    const s = JSON.parse(JSON.stringify(spec));
    s.slug = slug;
    // A review block merges into the example's (which answers the planning
    // question: no reviews, no delivery review); anything else replaces it.
    const { review, ...rest } = extra;
    Object.assign(s, rest);
    if (review !== undefined) s.review = review && typeof review === "object" && !Array.isArray(review) ? { ...s.review, ...review } : review;
    s.verifiedFacts = [...s.verifiedFacts, { claim: "a starts at 1", evidence: "src/a.ts:1" }];
    s.deliverables[0] = { title: "Retry sweep", body: "A timer job.", files: ["src/a.ts"], checks };
    return s;
  };
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  const ck = (n, id) => stOf(n).increments[0].checks[id];
  const arm = (n, checks, extra) => {
    const r = lc(LENV, "render", tmpSpec(mk(n, checks, extra)), "--root", RV);
    const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, n + ".key.json"), "utf8"));
    lc(LENV, "grade", n, ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
    lc(LENV, "go", n, "1"); lc(LENV, "start", n, "1");
    return r;
  };

  const bad = (checks, extra) => lc(LENV, "render", tmpSpec(mk("rv-bad", checks, extra)), "--root", RV);
  ok("review check: one that names a recipe is refused",
    /names no recipe or command/.test(bad([{ kind: "review", recipe: "envs" }]).stderr));
  ok("review check: two in one increment are refused",
    /one review check per increment/.test(bad([{ kind: "review" }, { kind: "review", id: "r2" }]).stderr));
  ok("review check: spec.review must be an object", /review: an object/.test(bad([{ kind: "review" }], { review: "yes" }).stderr));

  const r0 = arm("rv-1", [{ kind: "review" }, { id: "envs", kind: "test", name: "envs", recipe: "envs" }]);
  const v0 = ck("rv-1", "review-code-review");
  ok("review check: renders with no recipe in the repo, its command synthesized",
    r0.status === 0 && v0 && v0.kind === "review" && v0.synth === "review" && v0.recipe === "lookout:gate" &&
    v0.exec.steps[0].command === "lookout gate --plan rv-1 --inc 1", JSON.stringify(v0));
  let r = lc(LENV, "check", "run", "rv-1", "1", "review-code-review", "--detach");
  ok("a review check is not the Dock's to run detached: its reviewer is spawned from the session",
    r.status === 1 && /run it from the session/.test(r.stderr));
  r = lc(LENV, "check", "run", "rv-1", "1", "review-code-review");
  ok("review check: with no review yet, check run opens it and says to spawn the reviewer",
    r.status === 1 && ck("rv-1", "review-code-review").status === "fail" &&
    fs.existsSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-1-inc1.json")) &&
    /spawn ONE fresh reviewer subagent with lookout prompt rv-1-inc1/.test(ck("rv-1", "review-code-review").note) &&
    /lookout prompt rv-1-inc1\nthen: deep-plan check run rv-1 1/.test(r.stdout), ck("rv-1", "review-code-review").note + r.stdout);
  ok("review check: the last line is the board's: spawn a reviewer",
    r.stdout.trim().split("\n").pop() === "review: spawn a reviewer — lookout prompt rv-1-inc1", r.stdout);
  const r2 = lc(LENV, "check", "run", "rv-1", "1", "review-code-review");
  ok("spike settled: running a synthesized review check never warns about recipe drift",
    !/⚠|drift|changed in|no longer in/.test(r.stderr + r2.stderr), r.stderr + r2.stderr);
  ok("review check: a hand pass is refused like any command-backed check",
    lc(LENV, "check", "pass", "rv-1", "1", "review-code-review", "looked fine").status !== 0);

  r = lc(LENV, "check", "run", "rv-1", "1", "envs");
  const startSha = stOf("rv-1").increments[0].startSha;
  ok("recipes see DEEP_PLAN_ROOT and DEEP_PLAN_START_SHA",
    fs.readFileSync(ck("rv-1", "envs").ran.log, "utf8").includes(`root=${RV} start=${startSha}`) && !!startSha);

  fs.writeFileSync(path.join(RV, "src", "a.ts"), "export const a = 2;\n");
  r = lc(LENV, "review", "rv-1", "1");
  ok("deep-plan review: opens the increment's lookout review and names the brief",
    r.status === 0 && /lookout rv-1-inc1/.test(r.stdout) && /lookout prompt rv-1-inc1/.test(r.stdout), r.stdout + r.stderr);
  const store = path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-1-inc1.json");
  const rv = JSON.parse(fs.readFileSync(store, "utf8"));
  ok("deep-plan review: the review covers the increment's work since its start sha",
    rv.source.plan === "rv-1" && rv.source.inc === 1 && rv.files.some(f => f.path === "src/a.ts") &&
    rv.policy.agentMayClose === false);
  const fjson = path.join(TMP, "rv-findings.json");
  fs.writeFileSync(fjson, JSON.stringify([{ file: "src/a.ts", line: 1, severity: "major", summary: "a is 2", failure_scenario: "callers expect 1" }]));
  lk("findings", "add", "rv-1-inc1", fjson);
  r = lc(LENV, "check", "run", "rv-1", "1", "review-code-review");
  ok("review check: fails while a major is open, saying the human closes it",
    r.status === 1 && /human closes it/.test(ck("rv-1", "review-code-review").note));
  const dr = lc(LENV, "done", "rv-1", "1");
  ok("done is refused while the review check fails, naming the reviewer's brief",
    dr.status === 1 && /spawn ONE fresh reviewer subagent whose prompt is the output of `lookout prompt rv-1-inc1`/.test(dr.stderr), dr.stderr);
  // The human resolves it on the page (the intent server's write, by hand here).
  const closed = JSON.parse(fs.readFileSync(store, "utf8"));
  closed.findings[0].status = "resolved"; closed.findings[0].statusBy = "human";
  fs.writeFileSync(store, JSON.stringify(closed));
  r = lc(LENV, "check", "run", "rv-1", "1", "review-code-review");
  lc(LENV, "check", "run", "rv-1", "1", "envs");
  ok("review check: passes once the human closed the major; done then succeeds",
    r.status === 0 && ck("rv-1", "review-code-review").status === "pass" && lc(LENV, "done", "rv-1", "1").status === 0,
    r.stdout + r.stderr);
  ok("the working page links the increment's review",
    fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, "rv-1.working.html"), "utf8").includes('href="/review/rv-1-inc1"'));

  arm("rv-2", [{ kind: "review" }], { review: { agentMayClose: true } });
  fs.writeFileSync(path.join(RV, "src", "a.ts"), "export const a = 3;\n");
  lc(LENV, "review", "rv-2", "1");
  ok("spec review.agentMayClose reaches the review's policy",
    JSON.parse(fs.readFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-2-inc1.json"), "utf8")).policy.agentMayClose === true);
  ok("spec review.quiz must be a boolean", /review\.quiz: true or false/.test(bad([{ kind: "review" }], { review: { quiz: "yes" } }).stderr));
  ok("a review without review.quiz has the quiz off",
    JSON.parse(fs.readFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-2-inc1.json"), "utf8")).policy.quiz === false);
  arm("rv-q", [{ kind: "review" }], { review: { quiz: true } });
  fs.writeFileSync(path.join(RV, "src", "a.ts"), "export const a = 4;\n");
  // A diff viewed first creates the review: with the plan's quiz, since a
  // re-open cannot add it later.
  lc(LENV, "diff", "rv-q", "1");
  ok("deep-plan diff opened first still creates the review with the plan's quiz",
    JSON.parse(fs.readFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-q-inc1.json"), "utf8")).policy.quiz === true);
  r = lc(LENV, "review", "rv-q", "1");
  const qv = JSON.parse(fs.readFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-q-inc1.json"), "utf8"));
  ok("spec review.quiz opens a quizzed review, and says the reviewer owes questions",
    r.status === 0 && qv.policy.quiz === true && qv.policy.agentMayClose === false && /this plan quizzes/.test(r.stdout), r.stdout + r.stderr);
  r = lc({ ...LENV, LOOKOUT_ENGINE: path.join(TMP, "no-lookout-here") }, "check", "run", "rv-2", "1", "review-code-review");
  ok("review check: without lookout it fails with the install hint",
    r.status === 1 && /lookout is not installed/.test(ck("rv-2", "review-code-review").note));
  r = lc(LENV, "diff", "rv-2", "1");
  ok("deep-plan diff opens the increment in lookout, view-only (no reviewer hint)",
    r.status === 0 && /lookout rv-2-inc1/.test(r.stdout) && !/next:\s+brief/.test(r.stdout), r.stdout + r.stderr);
  // Which increments are reviewed is the human's answer at planning time:
  // the spec must record it, and each chosen increment carries the check.
  const chosen = (n, review) => {
    lc(LENV, "render", tmpSpec(mk(n, [{ kind: "manual", name: "looked" }], { review })), "--root", RV);
    return stOf(n).increments[0].checks["review-code-review"];
  };
  const cv = chosen("rv-pick", { increments: [1] });
  ok("chosen review: an increment the human picked carries the check, its command synthesized",
    cv && cv.chosen === true && cv.synth === "review" && cv.exec.steps[0].command === "lookout gate --plan rv-pick --inc 1", JSON.stringify(cv));
  ok("chosen review: \"all\" picks every increment", !!chosen("rv-all", { increments: "all" }));
  ok("chosen review: \"none\" picks none", !chosen("rv-none", { increments: "none" }));
  const noAnswer = s => { const x = mk("rv-ask", [{ kind: "manual", name: "looked" }]); s(x); return lc(LENV, "render", tmpSpec(x), "--root", RV).stderr; };
  ok("render refuses a spec that does not say which increments are reviewed",
    /ask the human which increments deserve a lookout review/.test(noAnswer(x => delete x.review.increments)));
  ok("…or whether the full delivery is", /ask the human which increments/.test(noAnswer(x => delete x.review.delivery)) &&
    /ask the human which increments/.test(noAnswer(x => delete x.review)));
  ok("review.increments names real increments, each once",
    /review\.increments: "all", "none", or increment numbers from 1 to/.test(bad([{ kind: "manual", name: "m" }], { review: { increments: [9] } }).stderr) &&
    /review\.increments/.test(bad([{ kind: "manual", name: "m" }], { review: { increments: [1, 1] } }).stderr));
  ok("review.delivery is a boolean", /review\.delivery: true or false/.test(bad([{ kind: "manual", name: "m" }], { review: { delivery: "yes" } }).stderr));

  // The delivery review: after the last increment the plan waits in a
  // delivery phase until lookout's review of every increment's work passes.
  {
    const s = mk("rv-d", [{ kind: "manual", name: "looked" }], { review: { delivery: true } });
    s.deliverables = [s.deliverables[0]];
    lc(LENV, "render", tmpSpec(s), "--root", RV);
    const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "rv-d.key.json"), "utf8"));
    lc(LENV, "grade", "rv-d", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
    lc(LENV, "go", "rv-d", "1"); lc(LENV, "start", "rv-d", "1");
    fs.writeFileSync(path.join(RV, "src", "a.ts"), "export const a = 5;\n");
    ok("deliver before the last increment is refused", /every increment must be done first/.test(lc(LENV, "deliver", "rv-d").stderr));
    lc(LENV, "check", "pass", "rv-d", "1", "manual-looked", "a is 5");
    let d = lc(LENV, "done", "rv-d", "1");
    ok("the last increment done puts a delivery plan in its delivery phase, naming the next step",
      d.status === 0 && stOf("rv-d").phase === "delivery" && /deep-plan deliver rv-d/.test(d.stdout), d.stdout + d.stderr);
    const row = JSON.parse(lc(LENV, "status", "--json").stdout).find(x => x.slug === "rv-d");
    ok("…where the gate stays open for its fixes", row && row.gate.allow === true && /delivery review holds the plan open/.test(row.gate.why));
    d = lc(LENV, "deliver", "rv-d");
    const dstore = path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-d-delivery.json");
    const dv = fs.existsSync(dstore) ? JSON.parse(fs.readFileSync(dstore, "utf8")) : {};
    ok("deliver with no reviewer opens the whole plan's review and says to spawn one",
      d.status === 1 && dv.source && dv.source.inc === "all" && /the full delivery/.test(dv.title) &&
      dv.files.some(f => f.path === "src/a.ts") && stOf("rv-d").phase === "delivery" &&
      d.stdout.trim().split("\n").pop() === "review: spawn a reviewer — lookout prompt rv-d-delivery" &&
      /then: deep-plan deliver rv-d/.test(d.stdout), d.stdout + d.stderr);
    ok("the delivery brief carries the plan, every increment", /the plan it delivers, every increment/.test(lk("prompt", "rv-d-delivery").stdout));
    lk("findings", "add", "rv-d-delivery", fjson);
    d = lc(LENV, "deliver", "rv-d");
    ok("deliver is refused while a blocker or major is open", d.status === 1 && /deliver refused/.test(d.stderr) && stOf("rv-d").phase === "delivery", d.stderr);
    const cl = JSON.parse(fs.readFileSync(dstore, "utf8"));
    cl.findings[0].status = "resolved"; cl.findings[0].statusBy = "human";
    fs.writeFileSync(dstore, JSON.stringify(cl));
    d = lc(LENV, "deliver", "rv-d");
    ok("once the human closed it, deliver completes the plan", d.status === 0 && /delivered rv-d — plan complete/.test(d.stdout) &&
      stOf("rv-d").phase === "done", d.stdout + d.stderr);
  }
  // --base: a plan whose increments were authorized before go recorded a
  // start sha has none, and review, diff and deliver refused it with nothing
  // to do about it. They take a base then, recorded as the start sha so what
  // follows opens the same review; a recorded sha always wins.
  {
    const unsha = (n, only) => { const st = stOf(n); for (const i of st.increments) if (!only || i.n === only) i.startSha = "";
      fs.writeFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), JSON.stringify(st)); };
    const base = execSync("git rev-parse HEAD", { cwd: RV, encoding: "utf8" }).trim();
    arm("rv-b", [{ kind: "review" }]);
    unsha("rv-b");
    fs.writeFileSync(path.join(RV, "src", "a.ts"), "export const a = 6;\n");
    lc(LENV, "check", "run", "rv-b", "1", "review-code-review");
    ok("a review check with no start sha says to give one with --base",
      /deep-plan review rv-b 1 --base <sha>/.test(ck("rv-b", "review-code-review").note), ck("rv-b", "review-code-review").note);
    for (const verb of ["review", "diff"]) {
      r = lc(LENV, verb, "rv-b", "1");
      ok(`${verb} with no start sha is refused, naming --base`,
        r.status === 1 && r.stderr.includes(`deep-plan ${verb} rv-b 1 --base <sha>`), r.stderr);
    }
    r = lc(LENV, "review", "rv-b");
    ok("review of a plan with no start sha at all names the increment and --base",
      r.status === 1 && r.stderr.includes("deep-plan review rv-b <n> --base <sha>"), r.stderr);
    r = lc(LENV, "review", "rv-b", "1", "--base", "not-a-commit");
    ok("--base that is not a commit is refused", r.status === 1 && /is not a commit/.test(r.stderr), r.stderr);
    r = lc(LENV, "review", "rv-b", "1", "--base", base.slice(0, 10));
    const bv = JSON.parse(fs.readFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-b-inc1.json"), "utf8"));
    ok("review --base opens the review at that base",
      r.status === 0 && bv.source.base === base && bv.files.some(f => f.path === "src/a.ts"), r.stdout + r.stderr);
    ok("…and records it as the increment's start sha, logged",
      stOf("rv-b").increments[0].startSha === base && (stOf("rv-b").log || []).some(l => /--base: increment 1's start sha recorded/.test(JSON.stringify(l))));
    lc(LENV, "check", "run", "rv-b", "1", "review-code-review");
    ok("so the check run that follows reopens that review, not a refusal",
      /spawn ONE fresh reviewer subagent/.test(ck("rv-b", "review-code-review").note), ck("rv-b", "review-code-review").note);
    r = lc(LENV, "review", "rv-b", "1", "--base", base);
    ok("a second --base is refused once one is recorded", r.status === 1 && /--base refused/.test(r.stderr), r.stderr);
    unsha("rv-b");
    r = lc(LENV, "diff", "rv-b", "1", "--base", base);
    ok("diff --base opens the increment at that base", r.status === 0 && /lookout rv-b-inc1/.test(r.stdout), r.stdout + r.stderr);
    for (const verb of ["review", "diff"]) {
      r = lc(LENV, verb, "rv-2", "1", "--base", base);
      ok(`${verb} --base beside a recorded start sha is refused`,
        r.status === 1 && /--base refused: a start sha is recorded/.test(r.stderr), r.stderr);
    }

    const s = mk("rv-bd", [{ kind: "manual", name: "looked" }], { review: { delivery: true } });
    s.deliverables = [s.deliverables[0], { ...s.deliverables[0], title: "Retry metrics", body: "Count the retries." }];
    lc(LENV, "render", tmpSpec(s), "--root", RV);
    const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, "rv-bd.key.json"), "utf8"));
    lc(LENV, "grade", "rv-bd", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
    for (const n of ["1", "2"]) {
      lc(LENV, "go", "rv-bd", n);
      lc(LENV, "check", "pass", "rv-bd", n, "manual-looked", "a is 6");
      lc(LENV, "done", "rv-bd", n);
    }
    r = lc(LENV, "deliver", "rv-bd", "--base", base);
    ok("deliver --base beside a recorded start sha is refused",
      stOf("rv-bd").phase === "delivery" && r.status === 1 && /--base refused/.test(r.stderr) &&
      !fs.existsSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-bd-delivery.json")), r.stderr);
    // Only the first increment lacks one: a later increment's sha must not
    // stand in, or the delivery review silently drops the first one's work.
    unsha("rv-bd", 1);
    r = lc(LENV, "deliver", "rv-bd");
    ok("deliver whose first increment has no start sha is refused, naming --base",
      r.status === 1 && r.stderr.includes("deep-plan deliver rv-bd --base <sha>") && !!stOf("rv-bd").increments[1].startSha, r.stderr);
    r = lc(LENV, "deliver", "rv-bd", "--base", base);
    const dv = JSON.parse(fs.readFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, "rv-bd-delivery.json"), "utf8"));
    ok("deliver --base opens the full delivery's review at that base",
      r.status === 1 && dv.source.base === base && dv.source.inc === "all" && /lookout prompt rv-bd-delivery/.test(r.stdout), r.stdout + r.stderr);
    r = lc(LENV, "deliver", "rv-bd");
    ok("…and the deliver re-run its hint names needs no --base",
      r.status === 1 && /lookout prompt rv-bd-delivery/.test(r.stdout) && !/no recorded start sha/.test(r.stderr), r.stdout + r.stderr);
  }
  // The opt-in family review: a parent with review.family closes its delivery
  // only when every member is done and one lookout review per member passes,
  // each opened at the member's root with the family's contracts as context.
  {
    const FR = path.join(TMP, "famrv"), KR = path.join(TMP, "famrv.worktrees", "kid");
    fs.mkdirSync(FR, { recursive: true });
    execSync(`git init -q && ${G} commit -q --allow-empty -m init && git worktree add -q -b kid ${KR}`, { cwd: FR });
    const kid = JSON.parse(JSON.stringify(spec));
    kid.slug = "frv-kid"; kid.deliverables = kid.deliverables.map(d => ({ ...d, files: [] }));
    const fam = JSON.parse(fs.readFileSync(path.join(HERE, "examples", "example.family.spec.json"), "utf8"));
    const par = { ...fam, slug: "frv-par", workstreams: [{ slug: "frv-kid", owns: ["kid/**"], consumes: ["POST /session"] }],
      review: { increments: "none", delivery: true, family: true, agentMayClose: true } };
    let r = lc(LENV, "render", tmpSpec({ ...kid, review: { ...kid.review, family: true } }), "--root", KR);
    ok("family review: review.family on a plan with no workstreams is refused", r.status !== 0 && /only a parent plan/.test(r.stderr));
    r = lc(LENV, "render", tmpSpec({ ...par, review: { ...par.review, delivery: false } }), "--root", FR);
    ok("family review: review.family needs review.delivery", r.status !== 0 && /needs review\.delivery: true/.test(r.stderr));
    ok("family review: review.family is a boolean",
      /review\.family: true or false/.test(lc(LENV, "render", tmpSpec({ ...par, review: { ...par.review, family: "yes" } }), "--root", FR).stderr));
    lc(LENV, "render", tmpSpec(kid), "--root", KR);
    r = lc(LENV, "render", tmpSpec(par), "--root", FR);
    ok("family review: a parent with review.family renders", r.status === 0, r.stderr);
    const passAll = (slug, root) => {
      const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, slug + ".key.json"), "utf8"));
      lc(LENV, "grade", slug, ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
      for (const i of stOf(slug).increments) {
        lc(LENV, "go", slug, String(i.n), "--force");
        fs.writeFileSync(path.join(root, `${slug}-${i.n}.txt`), `work ${i.n}\n`);
        execSync(`git add -A && ${G} commit -q -m "${slug} ${i.n}"`, { cwd: root });
        lc(LENV, "done", slug, String(i.n), "--force");
      }
    };
    passAll("frv-par", FR);
    r = lc(LENV, "deliver", "frv-par");
    ok("family review: deliver waits for every member, naming the ones not done",
      r.status !== 0 && /deliver refused: family not done \(frv-kid\)/.test(r.stderr) && stOf("frv-par").phase === "delivery", r.stdout + r.stderr);
    passAll("frv-kid", KR);
    const kidFile = path.join(ENV.DEEP_PLAN_STATE_DIR, "frv-kid.json");
    const kidWas = fs.readFileSync(kidFile, "utf8");
    fs.writeFileSync(kidFile, JSON.stringify({ ...JSON.parse(kidWas), phase: "delivery" }));
    r = lc(LENV, "deliver", "frv-par");
    ok("family review: a child still in its own delivery review is not done yet",
      r.status !== 0 && /family not done \(frv-kid\)/.test(r.stderr), r.stderr);
    fs.writeFileSync(kidFile, kidWas);
    r = lc(LENV, "deliver", "frv-par");
    const ids = ["frv-par-family-frv-par", "frv-par-family-frv-kid"];
    const store = id => JSON.parse(fs.readFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, id + ".json"), "utf8"));
    ok("family review: deliver opens one review per member and names a reviewer for each",
      r.status === 1 && ids.every(id => fs.existsSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, id + ".json")) && r.stdout.includes(`lookout prompt ${id}`)) &&
      r.stdout.trim().split("\n").pop() === `review: spawn a reviewer — lookout prompt ${ids[0]}`, r.stdout + r.stderr);
    const ks = store(ids[1]);
    ok("family review: each is the member's own work, at its root, with the plan's close policy",
      ks.source.root && fs.realpathSync(ks.source.root) === fs.realpathSync(KR) && ks.files.some(f => f.path === "frv-kid-1.txt") &&
      !ks.files.some(f => /frv-par/.test(f.path)) && ks.policy.agentMayClose === true, JSON.stringify(ks.source));
    const brief = lk("prompt", ids[1]).stdout;
    ok("family review: the reviewer's brief carries the family's members and contracts",
      /## The context it was opened with/.test(brief) && /frv-kid: a workstream · owns kid\/\*\* · consumes POST \/session/.test(brief) &&
      /POST \/session \[api, new\]/.test(brief), brief.slice(0, 400));
    const empty = path.join(TMP, "frv-empty.json"); fs.writeFileSync(empty, "[]");
    lk("findings", "add", ids[0], empty);
    const kjson = path.join(TMP, "frv-kid-findings.json");
    fs.writeFileSync(kjson, JSON.stringify([{ file: "frv-kid-1.txt", line: 1, severity: "major", summary: "the seam is off", failure_scenario: "the parent's session type changes" }]));
    lk("findings", "add", ids[1], kjson);
    r = lc(LENV, "deliver", "frv-par");
    ok("family review: a major open on one member holds the parent", r.status === 1 && /✗ frv-par-family-frv-kid/.test(r.stdout) &&
      /deliver refused: the family review is open on 1 member/.test(r.stderr) && stOf("frv-par").phase === "delivery", r.stdout + r.stderr);
    const cl = store(ids[1]); cl.findings[0].status = "resolved"; cl.findings[0].statusBy = "human";
    fs.writeFileSync(path.join(LENV.LOOKOUT_REVIEWS_DIR, ids[1] + ".json"), JSON.stringify(cl));
    r = lc(LENV, "deliver", "frv-par");
    ok("family review: once every member's review passes, the parent is done",
      r.status === 0 && /family review passed for all 2 members/.test(r.stdout) && stOf("frv-par").phase === "done", r.stdout + r.stderr);
    for (const n of ["frv-par", "frv-kid"]) lc(LENV, "close", n);
  }
  for (const n of ["rv-1", "rv-2", "rv-q", "rv-pick", "rv-all", "rv-none", "rv-d", "rv-b", "rv-bd"]) lc(LENV, "close", n);
}

// ---------------------------------------------------------------- host detection
{
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
  ];
  for (const [env, want] of HOST_TABLE) {
    const got = HOST.detectHost(env), twin = HOST_TWIN.detectHost(env);
    ok(`host: ${JSON.stringify(env)} is ${want}`, got.host === want);
    ok(`host: the lookout copy agrees on ${JSON.stringify(env)}`, twin.host === got.host && twin.why === got.why);
  }
  ok("host: an ignored SEAMUX_HOST is named in why", /SEAMUX_HOST=bogus ignored/.test(HOST.detectHost({ SEAMUX_HOST: "bogus" }).why));
  ok("host: the twin files match apart from the line naming the other copy",
    fs.readFileSync(path.join(HERE, "lib", "host.mjs"), "utf8").split("\n").slice(3).join("\n") ===
    fs.readFileSync(path.join(HERE, "..", "lookout", "lib", "host.mjs"), "utf8").split("\n").slice(3).join("\n"));
  const r = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "doctor", "--json"],
    { encoding: "utf8", env: { ...ENV, SEAMUX_HOST: "remote" }, cwd: REPO });
  let j = {}; try { j = JSON.parse(r.stdout); } catch {}
  ok("host: doctor --json reports the host and why", r.status === 0 && j.host === "remote" && j.why === "SEAMUX_HOST=remote" && j.root === HERE);
  const t = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "doctor"],
    { encoding: "utf8", env: { ...ENV, CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, cwd: REPO });
  ok("host: doctor prints a host line", /^host: desktop \(CLAUDE_CODE_ENTRYPOINT=claude-desktop\)$/m.test(t.stdout));
}

// -------------------------------------------------- remote host: state in the repo, export and import
{
  const RH = path.join(TMP, "remote-home");
  fs.mkdirSync(RH, { recursive: true });
  const RA = path.join(TMP, "remote-a"), RB = path.join(TMP, "remote-b");
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  fs.mkdirSync(RA); execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: RA });
  // A remote session: no overrides, a home of its own, the repo as the project.
  const REnv = (dir, extra = {}) => {
    const e = { ...ENV, HOME: RH, SEAMUX_HOST: "remote", CLAUDE_PROJECT_DIR: dir, ...extra };
    for (const k of ["DEEP_PLAN_STATE_DIR", "DEEP_PLAN_KEYS_DIR", "DEEP_PLAN_PLANS_DIR", "DEEP_PLAN_ANNOT_DIR"]) delete e[k];
    return e;
  };
  const rc = (dir, ...a) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...a], { encoding: "utf8", env: REnv(dir), cwd: dir });
  const rs = { ...spec, slug: "remote-plan" };
  let r = rc(RA, "render", tmpSpec(rs), "--root", RA);
  const SD = path.join(RA, ".seamux", "state");
  ok("remote: state, keys and pages default into the repo's .seamux/state",
    r.status === 0 && fs.existsSync(path.join(SD, "deep-plan", "state", "remote-plan.json")) &&
    fs.existsSync(path.join(SD, "deep-plan", "keys", "remote-plan.key.json")) && fs.existsSync(path.join(SD, "plans", "remote-plan.md")) &&
    !fs.existsSync(path.join(RH, ".claude", "deep-plan", "state", "remote-plan.json")), r.stderr);
  ok("remote: the folder is kept out of git through info/exclude, not .gitignore",
    /^\/\.seamux\/state\/$/m.test(fs.readFileSync(path.join(RA, ".git", "info", "exclude"), "utf8")) &&
    !fs.existsSync(path.join(RA, ".gitignore")) && execSync("git status --porcelain", { cwd: RA, encoding: "utf8" }).trim() === "");
  const key = JSON.parse(fs.readFileSync(path.join(SD, "deep-plan", "keys", "remote-plan.key.json"), "utf8"));
  rc(RA, "grade", "remote-plan", ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
  const rgate = (dir, file) => spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], { encoding: "utf8", env: REnv(dir),
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir }) });
  ok("remote: the gate (its bash fast path included) finds the plan in the repo and refuses an edit",
    rgate(RA, path.join(RA, "a.txt")).status === 2);
  ok("remote: an override still wins over the repo default",
    spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "status", "--json"], { encoding: "utf8",
      env: { ...REnv(RA), DEEP_PLAN_STATE_DIR: path.join(TMP, "elsewhere") }, cwd: RA }).stdout.trim() === "[]");
  r = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "status"], { encoding: "utf8",
    env: { ...REnv(RA), DEEP_PLAN_STATE_DIR: path.join(TMP, "elsewhere") }, cwd: RA });
  ok("remote: status warns when state sits outside the repo", /outside the repo: a new sandbox starts without it/.test(r.stderr), r.stderr);
  ok("remote: and says nothing when it is in the repo", !/outside the repo/.test(rc(RA, "status").stderr));
  // Export, then import into a fresh clone at another path (a new sandbox).
  const bundle = path.join(TMP, "remote-plan.bundle.json");
  r = rc(RA, "export-state", "remote-plan", "--out", bundle);
  const bj = JSON.parse(fs.readFileSync(bundle, "utf8"));
  ok("export-state writes one bundle with state, spec, key, the approved snapshot and the pages",
    r.status === 0 && bj.kind === "deep-plan-state" && ["deep-plan/state/remote-plan.json", "deep-plan/keys/remote-plan.spec.json",
      "deep-plan/keys/remote-plan.key.json", "plans/remote-plan.approved.md", "plans/remote-plan.working.html"].every(k => k in bj.files),
    Object.keys(bj.files).join(" "));
  execSync(`git clone -q ${RA} ${RB}`);
  r = rc(RB, "import-state", bundle);
  const st = JSON.parse(fs.readFileSync(path.join(RB, ".seamux", "state", "deep-plan", "state", "remote-plan.json"), "utf8"));
  ok("import-state brings the plan back in the new clone's repo, keeping the root it finds",
    r.status === 0 && st.phase === "implementing" && st.root === RA, r.stdout + r.stderr);
  r = rc(RB, "import-state", bundle);
  ok("import-state refuses a plan that already exists", r.status !== 0 && /already exists here; --force/.test(r.stderr));
  fs.renameSync(RA, RA + "-gone");
  r = rc(RB, "import-state", bundle, "--force");
  const st2 = JSON.parse(fs.readFileSync(path.join(RB, ".seamux", "state", "deep-plan", "state", "remote-plan.json"), "utf8"));
  ok("…--force replaces it, and a root that is gone becomes this checkout", r.status === 0 && fs.realpathSync(st2.root) === fs.realpathSync(RB),
    st2.root);
  ok("…and the gate holds in the new sandbox", rgate(RB, path.join(RB, "a.txt")).status === 2);
  const evil = path.join(TMP, "evil.bundle.json");
  fs.writeFileSync(evil, JSON.stringify({ ...bj, files: { "deep-plan/state/../../../x.json": "e30=" } }));
  ok("import-state refuses a bundle that names a path outside the plan's files",
    rc(RB, "import-state", evil, "--force").status !== 0 && !fs.existsSync(path.join(RB, ".seamux", "x.json")));
  fs.renameSync(RA + "-gone", RA);
  // Only the plan's own file names: not another plan whose slug extends it.
  const other = path.join(TMP, "other.bundle.json");
  fs.writeFileSync(other, JSON.stringify({ ...bj, files: { ...bj.files, "deep-plan/state/remote-plan-x.json": "e30=" } }));
  ok("import-state refuses a bundle that carries another plan's state (a slug that extends this one)",
    /outside the plan's own files/.test(rc(RB, "import-state", other, "--force").stderr) &&
    !fs.existsSync(path.join(RB, ".seamux", "state", "deep-plan", "state", "remote-plan-x.json")));
  const nost = Object.fromEntries(Object.entries(bj.files).filter(([k]) => !k.startsWith("deep-plan/state/")));
  fs.writeFileSync(other, JSON.stringify({ ...bj, slug: "remote-plan", files: nost }));
  ok("import-state refuses a bundle with no state, before writing anything",
    /has no deep-plan\/state\/remote-plan\.json/.test(rc(RB, "import-state", other, "--force").stderr));
  // The bash fast path reads SEAMUX_HOST as host.mjs does.
  ok("remote: SEAMUX_HOST=' Remote' still finds the repo's state in the gate's fast path",
    spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], { encoding: "utf8", env: { ...REnv(RB), SEAMUX_HOST: " Remote" },
      input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(RB, "a.txt") }, cwd: RB }) }).status === 2);
  // A worktree of the same repo, with no CLAUDE_PROJECT_DIR: the same state.
  const WT = path.join(TMP, "remote-b-wt");
  execSync(`git worktree add -q ${WT} -b wt-probe`, { cwd: RB });
  const wenv = REnv(WT); delete wenv.CLAUDE_PROJECT_DIR;
  const ws = spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "status", "--json"], { encoding: "utf8", env: wenv, cwd: WT });
  ok("remote: a worktree of the repo finds the main checkout's state", JSON.parse(ws.stdout || "[]").some(x => x.slug === "remote-plan"), ws.stdout + ws.stderr);
}

// -------------------------------------------------- install-repo: the plugin in a repo's own .claude/, for cloud sessions
{
  const IR = path.join(TMP, "install-repo");
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  fs.mkdirSync(path.join(IR, ".claude"), { recursive: true });
  execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: IR });
  // A repo that already has a hook of its own.
  fs.writeFileSync(path.join(IR, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo mine" }] }] }, model: "x" }));
  const ir = (...a) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), "install-repo", ...a], { encoding: "utf8", env: ENV, cwd: IR });
  let r = ir();
  const D = path.join(IR, ".claude", "skills", "deep-plan");
  const set = () => JSON.parse(fs.readFileSync(path.join(IR, ".claude", "settings.json"), "utf8"));
  ok("install-repo copies the plugin into .claude/skills/deep-plan, without its probe, evals or dev tools",
    r.status === 0 && ["SKILL.md", "deep_plan.mjs", "hooks/gate.sh", "lib/state.mjs", "bin/deep-plan", ".claude-plugin/plugin.json", "references/checks.md"]
      .every(f => fs.existsSync(path.join(D, f))) && !fs.existsSync(path.join(D, "probe.mjs")) && !fs.existsSync(path.join(D, "evals")) &&
      !fs.existsSync(path.join(D, "tools")) && (fs.statSync(path.join(D, "bin", "deep-plan")).mode & 0o111) !== 0, r.stdout + r.stderr);
  const s1 = set();
  ok("install-repo merges its hooks into the repo's settings and keeps what was there",
    s1.model === "x" && s1.hooks.Stop[0].hooks[0].command === "echo mine" &&
    /\.claude\/skills\/deep-plan\/hooks\/gate\.sh/.test(s1.hooks.PreToolUse[0].hooks[0].command) && !JSON.stringify(s1).includes("CLAUDE_PLUGIN_ROOT"));
  ir();
  ok("install-repo again replaces its own hooks instead of adding a second set",
    JSON.stringify(set()) === JSON.stringify(s1));
  ok("install-repo --check: a fresh copy matches", ir("--check").status === 0);
  const stamp = JSON.parse(fs.readFileSync(path.join(D, ".install.json"), "utf8"));
  ok("the stamp names the version and a hash per file, and no machine path or time",
    stamp.version && Object.keys(stamp.files).length > 10 && !("source" in stamp) && !("installedAt" in stamp) && !JSON.stringify(stamp).includes(HERE));
  const self = spawnSync("node", [path.join(D, "deep_plan.mjs"), "install-repo"], { encoding: "utf8", env: ENV, cwd: IR });
  ok("install-repo run from the repo's own copy refuses, and the copy stays whole",
    self.status !== 0 && /this is the repo's own copy/.test(self.stderr) && fs.existsSync(path.join(D, "deep_plan.mjs")) &&
    fs.existsSync(path.join(D, "hooks", "gate.sh")), self.stderr);
  const sjson = fs.readFileSync(path.join(IR, ".claude", "settings.json"), "utf8");
  fs.writeFileSync(path.join(IR, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: { matcher: "" } } }));
  const bad = ir();
  ok("a settings.json whose hooks are malformed is refused before the copy changes",
    bad.status !== 0 && /hooks\.Stop is not a list/.test(bad.stderr) && fs.existsSync(path.join(D, "deep_plan.mjs")), bad.stderr);
  fs.writeFileSync(path.join(IR, ".claude", "settings.json"), sjson);
  fs.appendFileSync(path.join(D, "lib", "state.mjs"), "\n// edited\n");
  r = ir("--check");
  ok("install-repo --check reports drift from the plugin", r.status === 1 && /changed: lib\/state\.mjs/.test(r.stdout), r.stdout);
  ir();
  // The hooks as the repo's settings state them, run the way a cloud session runs them.
  const nodeDir = path.dirname(process.execPath);
  const cenv = (extra = {}) => {
    const e = { ...ENV, HOME: path.join(TMP, "cloud-home"), CLAUDE_PROJECT_DIR: IR, PATH: `${nodeDir}:/usr/bin:/bin`, ...extra };
    for (const k of ["DEEP_PLAN_STATE_DIR", "DEEP_PLAN_KEYS_DIR", "DEEP_PLAN_PLANS_DIR", "DEEP_PLAN_ANNOT_DIR", "SEAMUX_HOST"]) delete e[k];
    return e;
  };
  fs.mkdirSync(path.join(TMP, "cloud-home"), { recursive: true });
  const envFile = path.join(TMP, "claude-env");
  const pathHook = set().hooks.SessionStart[0].hooks[0].command;
  spawnSync("bash", ["-c", pathHook], { encoding: "utf8", env: cenv({ CLAUDE_CODE_REMOTE: "true", CLAUDE_ENV_FILE: envFile }) });
  ok("the SessionStart hook puts the copy's bin on the Bash tool's PATH",
    fs.readFileSync(envFile, "utf8").includes(`export PATH="${IR}/.claude/skills/deep-plan/bin:$PATH"`));
  // A plan made with the copy itself, as a cloud session would.
  const cs = { ...spec, slug: "cloud-plan" };
  const copy = (...a) => spawnSync(path.join(D, "bin", "deep-plan"), a, { encoding: "utf8", env: cenv({ CLAUDE_CODE_REMOTE: "true" }), cwd: IR });
  r = copy("render", tmpSpec(cs), "--root", IR);
  const ck = JSON.parse(fs.readFileSync(path.join(IR, ".seamux", "state", "deep-plan", "keys", "cloud-plan.key.json"), "utf8"));
  copy("grade", "cloud-plan", ...Object.entries(ck.answers).map(([q, v]) => `${q}=${v.letter}`));
  const gateCmd = set().hooks.PreToolUse[0].hooks[0].command;
  const call = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(IR, "a.txt") }, cwd: IR });
  const g1 = spawnSync("bash", ["-c", gateCmd], { encoding: "utf8", env: cenv({ CLAUDE_CODE_REMOTE: "true" }), input: call });
  ok("in a cloud session the repo's gate hook runs the copy and refuses an edit the plan has not authorized",
    r.status === 0 && g1.status === 2 && /deep-plan gate/.test(g1.stderr), r.stderr + g1.stderr);
  const g2 = spawnSync("bash", ["-c", gateCmd], { encoding: "utf8", env: cenv(), input: call });
  ok("…and does nothing in a local session, where the plugin's own hooks run", g2.status === 0 && g2.stderr === "");
}

// -------------------------------------------------- shared state: config and the git backend
{
  const SYNC = await import(new URL("lib/sync.mjs", import.meta.url));
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  const SR = path.join(TMP, "sync-repo"), ORIGIN = path.join(TMP, "sync-origin.git"), OUT = path.join(TMP, "sync-outside.git");
  const CACHE = path.join(TMP, "sync-cache");
  execSync(`git init -q --bare ${ORIGIN} && git init -q --bare ${OUT}`);
  fs.mkdirSync(SR);
  execSync(`git init -q && ${G} commit -q --allow-empty -m init && git remote add origin ${ORIGIN} && git push -q origin HEAD:refs/heads/main`, { cwd: SR });
  const noEnv = {};
  let c = SYNC.loadConfig(true, SR, noEnv);
  ok("sync config: share: true is origin, seamux-state/ and transitions",
    c.shared && c.remote === "origin" && c.prefix === "seamux-state/" && c.sync === "transitions" && !c.problems.length && fs.realpathSync(c.top) === fs.realpathSync(SR));
  c = SYNC.loadConfig(undefined, SR, noEnv);
  ok("sync config: a plan with no share is not shared, and still resolves where its branch would go", !c.shared && c.remote === "origin");
  c = SYNC.loadConfig({ remote: OUT, prefix: "plans/", sync: "manual" }, SR, noEnv);
  ok("sync config: the plan's share sets remote, prefix and sync", c.shared && c.remote === OUT && c.prefix === "plans/" && c.sync === "manual" && c.source.remote === "plan");
  c = SYNC.loadConfig({ remote: OUT, prefix: "plans/" }, SR, { SEAMUX_STATE_REMOTE: "origin", SEAMUX_STATE_SYNC: "OFF" });
  ok("sync config: SEAMUX_STATE_* beat the plan on this machine", c.remote === "origin" && c.sync === "off" && c.prefix === "plans/" && c.source.remote === "SEAMUX_STATE_REMOTE");
  c = SYNC.loadConfig(true, SR, { SEAMUX_STATE_SYNC: "of", SEAMUX_STATE_PREFIX: "bad..prefix/" });
  ok("sync config: an unreadable sync mode becomes manual and a bad prefix the default, each reported",
    c.sync === "manual" && c.prefix === "seamux-state/" && c.problems.length === 2, c.problems.join("; "));
  fs.mkdirSync(path.join(SR, ".seamux"));
  fs.writeFileSync(path.join(SR, ".seamux", "state.json"), JSON.stringify({ remote: OUT }));
  ok("sync config: nothing in the repo is read, so a cloned repo cannot point a plan's state elsewhere", SYNC.loadConfig(true, SR, noEnv).remote === "origin");
  fs.rmSync(path.join(SR, ".seamux"), { recursive: true });
  ok("share: true, false and a well-formed object pass render's check",
    [true, false, undefined, { remote: "origin" }, { remote: OUT, prefix: "team/state-", sync: "manual" }].every(x => !SYNC.shareProblems(x).length));
  ok("share: anything else is named", SYNC.shareProblems("yes").length === 1 && SYNC.shareProblems({ remot: "x" }).length === 1 &&
    SYNC.shareProblems({ sync: "off" }).length === 1 && SYNC.shareProblems({ prefix: "" }).length === 1 && SYNC.shareProblems({ prefix: "a/." }).length === 1);

  // What a checkout looks like; none of it may move.
  const snap = () => ["rev-parse HEAD", "branch --list", "status --porcelain", "for-each-ref refs/heads refs/tags", "remote -v"]
    .map(a => execSync("git " + a, { cwd: SR, encoding: "utf8" })).join("\n--\n");
  const before = snap();
  const files = { "deep-plan/state/p1.json": JSON.stringify({ slug: "p1", phase: "implementing" }), "plans/p1.md": "# p1\n" };

  // Inside: the repo's own remote.
  const inB = new SYNC.GitBackend(SYNC.loadConfig(true, SR, noEnv), { cacheDir: CACHE });
  ok("git backend: the repo's own remote is inside", inB.inside && inB.where === "remote origin");
  let r = inB.read("p1");
  ok("git backend: a plan with no branch reads as version \"\"", r.version === "" && r.files === null);
  const w1 = inB.write("p1", files, "");
  r = inB.read("p1");
  ok("git backend: a write makes seamux-state/<slug> holding the files at their data-root paths and a meta.json",
    w1.ok && r.version === w1.version && r.files["plans/p1.md"].toString() === "# p1\n" &&
    JSON.parse(r.files["deep-plan/state/p1.json"]).phase === "implementing" && r.meta && r.meta.slug === "p1" && r.meta.writer && r.meta.at &&
    execSync(`git --git-dir ${ORIGIN} rev-parse refs/heads/seamux-state/p1`, { encoding: "utf8" }).trim() === w1.version, JSON.stringify(w1));
  const stale = inB.write("p1", { ...files, "plans/p1.md": "# lost\n" }, "");
  ok("git backend: a write pinned to an older version is refused and changes nothing",
    stale.ok === false && stale.moved === true && inB.version("p1") === w1.version);
  const w2 = inB.write("p1", { ...files, "plans/p1.md": "# p1 v2\n" }, w1.version);
  ok("git backend: a write pinned to the current version lands, on top of it",
    w2.ok && execSync(`git --git-dir ${ORIGIN} rev-parse ${w2.version}^`, { encoding: "utf8" }).trim() === w1.version);
  inB.write("p10", files, "");
  const lst = inB.list().map(x => x.slug).sort().join(",");
  ok("git backend: list names the plans with a branch under the prefix", lst === "p1,p10", lst);
  ok("git backend: the code checkout's HEAD, branches, status, tags and remotes never moved", snap() === before,
    before + "\n====\n" + snap());
  ok("git backend: a remove pinned to an older version is refused", inB.remove("p1", w1.version).moved === true && inB.version("p1") === w2.version);
  ok("git backend: a remove pinned to the current version deletes the branch", inB.remove("p1", w2.version).ok && inB.version("p1") === "");

  // Outside: any other git URL or path, through a bare cache.
  const outB = new SYNC.GitBackend(SYNC.loadConfig(true, SR, { SEAMUX_STATE_REMOTE: OUT }), { cacheDir: CACHE });
  const refsBefore = execSync("git for-each-ref", { cwd: SR, encoding: "utf8" });
  const ow = outB.write("p2", files, "");
  ok("git backend: a remote outside the repo is written through a bare cache under the data root",
    !outB.inside && ow.ok && fs.existsSync(path.join(outB.cache, "HEAD")) && outB.cache.startsWith(CACHE) &&
    execSync(`git --git-dir ${OUT} rev-parse refs/heads/seamux-state/p2`, { encoding: "utf8" }).trim() === ow.version);
  ok("git backend: …and the code repo gains no refs or objects from it",
    execSync("git for-each-ref", { cwd: SR, encoding: "utf8" }) === refsBefore &&
    spawnSync("git", ["cat-file", "-e", ow.version], { cwd: SR }).status !== 0 && snap() === before);
  const fresh = new SYNC.GitBackend(SYNC.loadConfig(true, SR, { SEAMUX_STATE_REMOTE: OUT }), { cacheDir: path.join(TMP, "sync-cache-2") });
  r = fresh.read("p2");
  ok("git backend: a fresh cache reads the branch back", r.version === ow.version && r.files["plans/p1.md"].toString() === "# p1\n");
  const relB = new SYNC.GitBackend(SYNC.loadConfig(true, SR, { SEAMUX_STATE_REMOTE: "../sync-outside.git", SEAMUX_STATE_PREFIX: "team/state-" }), { cacheDir: CACHE });
  const rw = relB.write("p3", files, "");
  ok("git backend: a relative path resolves against the repo, and the prefix need not end in /",
    rw.ok && execSync(`git --git-dir ${OUT} rev-parse refs/heads/team/state-p3`, { encoding: "utf8" }).trim() === rw.version &&
    relB.list().map(x => x.slug).join(",") === "p3");

  c = SYNC.loadConfig(true, SR, { SEAMUX_STATE_PREFIX: "" });
  ok("sync config: an empty prefix is refused, so a state branch is never a bare slug", c.prefix === "seamux-state/" && c.problems.length === 1);
  c = SYNC.loadConfig(true, SR, { SEAMUX_STATE_PREFIX: "state/." });
  ok("sync config: a prefix that makes a bad ref name with a slug after it is refused", c.prefix === "seamux-state/" && c.problems.length === 1);
  let scp = "";
  try { scp = new SYNC.GitBackend(SYNC.loadConfig(true, SR, { SEAMUX_STATE_REMOTE: "example.com:org/state.git" }), { cacheDir: CACHE }).target; } catch (e) { scp = e.message; }
  ok("git backend: scp's host:path without a user is a URL, not a relative path", scp === "example.com:org/state.git", scp);
  const ghost = inB.write("p10", files, "0123456789abcdef0123456789abcdef01234567");
  ok("git backend: a write pinned to a commit the remote no longer has reads as moved", ghost.ok === false && ghost.moved === true);
  let threw = "";
  try { new SYNC.GitBackend(SYNC.loadConfig(true, SR, { SEAMUX_STATE_REMOTE: "upstream" }), { cacheDir: CACHE }); } catch (e) { threw = e.message; }
  ok("git backend: a remote name the repo does not have is refused by name", /no git remote named upstream/.test(threw), threw);
  const gone = new SYNC.GitBackend(SYNC.loadConfig(true, SR, { SEAMUX_STATE_REMOTE: path.join(TMP, "no-such.git") }), { cacheDir: CACHE, timeout: 5000 });
  threw = "";
  try { gone.write("p4", files, ""); } catch (e) { threw = e.message; }
  ok("git backend: a remote that cannot be reached throws, naming it", threw.includes("no-such.git"), threw);
}

// -------------------------------------------------- state push, pull, status and list
{
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  const SO = path.join(TMP, "st-origin.git"), SA = path.join(TMP, "st-a"), SB = path.join(TMP, "st-b");
  execSync(`git init -q --bare ${SO}`);
  fs.mkdirSync(SA);
  execSync(`git init -q && ${G} commit -q --allow-empty -m init && git remote add origin ${SO} && git push -q origin HEAD:refs/heads/main`, { cwd: SA });
  execSync(`git clone -q ${SO} ${SB}`);
  // Two machines: each its own data root, each its own clone.
  const side = name => {
    const d = path.join(TMP, "st-data-" + name);
    return { ...ENV, DEEP_PLAN_STATE_DIR: path.join(d, "state"), DEEP_PLAN_KEYS_DIR: path.join(d, "keys"),
      DEEP_PLAN_PLANS_DIR: path.join(d, "plans"), LOOKOUT_REVIEWS_DIR: path.join(d, "plans", "reviews") };
  };
  const EA = side("a"), EB = side("b");
  const on = (env, dir, ...a) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...a], { encoding: "utf8", env, cwd: dir });
  let r = on(EA, SA, "render", tmpSpec({ ...spec, slug: "shared-p" }), "--root", SA);
  ok("state: a plan renders on machine A", r.status === 0, r.stderr);
  const skey = JSON.parse(fs.readFileSync(path.join(EA.DEEP_PLAN_KEYS_DIR, "shared-p.key.json"), "utf8"));
  on(EA, SA, "grade", "shared-p", ...Object.entries(skey.answers).map(([q, v]) => `${q}=${v.letter}`));
  r = on(EA, SA, "state", "status", "shared-p");
  ok("state status: a plan with no branch says so, and that it is not shared", /shared-p  not shared  seamux-state\/shared-p on remote origin: no branch/.test(r.stdout), r.stdout + r.stderr);
  r = on(EA, SA, "state", "push", "shared-p");
  const tip = () => spawnSync("git", ["--git-dir", SO, "rev-parse", "refs/heads/seamux-state/shared-p"], { encoding: "utf8" }).stdout.trim();
  const tree = execSync(`git --git-dir ${SO} ls-tree -r --name-only refs/heads/seamux-state/shared-p`, { encoding: "utf8" });
  ok("state push: writes the plan's bundle files and meta.json to seamux-state/<slug> on the repo's remote",
    r.status === 0 && /pushed shared-p to seamux-state\/shared-p on remote origin/.test(r.stdout) &&
    ["deep-plan/state/shared-p.json", "deep-plan/keys/shared-p.spec.json", "deep-plan/keys/shared-p.key.json", "plans/shared-p.md", "meta.json"]
      .every(f => tree.split("\n").includes(f)), r.stdout + r.stderr + tree);
  const first = tip();
  r = on(EA, SA, "state", "push", "shared-p");
  ok("state push: nothing new is nothing written", r.status === 0 && /in sync/.test(r.stdout) && tip() === first, r.stdout);
  ok("state status: in sync after a push", /: in sync \(branch /.test(on(EA, SA, "state", "status", "shared-p").stdout));
  r = on(EB, SB, "state", "list");
  ok("state list: names the branch, and that the plan is not on this machine", /^shared-p  [0-9a-f]{8}  not here$/m.test(r.stdout), r.stdout + r.stderr);

  // B pulls into its own clone; A's root is still on this machine, so it stays.
  r = on(EB, SB, "state", "pull", "shared-p");
  const stB = JSON.parse(fs.readFileSync(path.join(EB.DEEP_PLAN_STATE_DIR, "shared-p.json"), "utf8"));
  ok("state pull: brings the plan to another data root", r.status === 0 && /pulled shared-p from seamux-state\/shared-p/.test(r.stdout) &&
    stB.slug === "shared-p" && fs.existsSync(path.join(EB.DEEP_PLAN_KEYS_DIR, "shared-p.key.json")) && stB.root === SA, r.stdout + r.stderr);
  ok("state pull: a second pull of the same version is a no-op", /up to date/.test(on(EB, SB, "state", "pull", "shared-p").stdout));
  // A moves on and pushes; B, unchanged, pulls it.
  on(EA, SA, "go", "shared-p", "next");
  r = on(EA, SA, "state", "push", "shared-p");
  ok("state status: B sees the branch ahead", /branch ahead: pull/.test(on(EB, SB, "state", "status", "shared-p").stdout));
  r = on(EB, SB, "state", "pull", "shared-p");
  ok("state pull: B picks up A's go", r.status === 0 &&
    JSON.parse(fs.readFileSync(path.join(EB.DEEP_PLAN_STATE_DIR, "shared-p.json"), "utf8")).increments[0].status === "authorized", r.stdout + r.stderr);
  // B changes something locally; a pull would lose it.
  on(EB, SB, "block", "shared-p", "1", "waiting on a reply");
  ok("state status: local changes are named", /local changes to push/.test(on(EB, SB, "state", "status", "shared-p").stdout));
  on(EA, SA, "start", "shared-p", "1");
  on(EA, SA, "state", "push", "shared-p");
  ok("state status: both moved", /both moved/.test(on(EB, SB, "state", "status", "shared-p").stdout));
  r = on(EB, SB, "state", "pull", "shared-p");
  const stM = JSON.parse(fs.readFileSync(path.join(EB.DEEP_PLAN_STATE_DIR, "shared-p.json"), "utf8"));
  ok("state pull: merges changes made here with the branch's instead of dropping them (the later start wins, both log lines stay)",
    r.status === 0 && /merged shared-p with/.test(r.stdout) && stM.increments[0].status === "working" &&
    stM.log.some(l => /^block: increment 1/.test(l.what)) && stM.log.some(l => /^start: increment 1/.test(l.what)), r.stdout + r.stderr);
  ok("state status: the merge is ahead of the branch until pushed", /local changes to push/.test(on(EB, SB, "state", "status", "shared-p").stdout));
  ok("state push: the merge lands", /pushed shared-p/.test(on(EB, SB, "state", "push", "shared-p").stdout));
  on(EB, SB, "block", "shared-p", "1", "only here");
  r = on(EB, SB, "state", "pull", "shared-p", "--force");
  ok("state pull --force: replaces changes made here", r.status === 0 &&
    JSON.parse(fs.readFileSync(path.join(EB.DEEP_PLAN_STATE_DIR, "shared-p.json"), "utf8")).increments[0].status === "working");
  // A fresh machine whose recorded root is gone takes its own checkout.
  const EC = side("c");
  fs.renameSync(SA, SA + "-gone");
  r = on(EC, SB, "state", "pull", "shared-p");
  ok("state pull: a root that is gone becomes this checkout",
    r.status === 0 && fs.realpathSync(JSON.parse(fs.readFileSync(path.join(EC.DEEP_PLAN_STATE_DIR, "shared-p.json"), "utf8")).root) === fs.realpathSync(SB), r.stdout + r.stderr);
  fs.renameSync(SA + "-gone", SA);
  // B's own root for the plan is kept when the branch's is not on this machine.
  const SB2 = path.join(TMP, "st-b2");
  execSync(`git clone -q ${SO} ${SB2}`);
  const EF = side("f");
  on(EF, SB, "state", "pull", "shared-p", "--root", SB);
  on(EA, SA, "state", "pull", "shared-p", "--force");
  on(EA, SA, "block", "shared-p", "2", "moved on A");
  on(EA, SA, "state", "push", "shared-p");
  fs.renameSync(SA, SA + "-gone");
  r = on(EF, SB2, "state", "pull", "shared-p");
  const stF = JSON.parse(fs.readFileSync(path.join(EF.DEEP_PLAN_STATE_DIR, "shared-p.json"), "utf8"));
  ok("state pull: a machine keeps its own root for the plan over this checkout when the branch's is gone",
    r.status === 0 && stF.root === SB && stF.increments[1].status === "blocked", r.stdout + r.stderr + stF.root);
  fs.renameSync(SA + "-gone", SA);
  // One plan whose share names no remote does not hide the others.
  const sfile = path.join(EB.DEEP_PLAN_STATE_DIR, "zz-bad.json");
  fs.writeFileSync(sfile, JSON.stringify({ slug: "zz-bad", root: SB, phase: "implementing", share: { remote: "nowhere" }, increments: [] }));
  r = on(EB, SB, "state", "status");
  ok("state status: a plan with a bad share is reported, and the rest still listed",
    r.status === 0 && /zz-bad  shared  misconfigured/.test(r.stdout) && /shared-p  not shared/.test(r.stdout), r.stdout + r.stderr);
  fs.rmSync(sfile);
  // A branch is checked like a bundle: nothing outside the plan's own files.
  const SYNC = await import(new URL("lib/sync.mjs", import.meta.url));
  const be = new SYNC.GitBackend(SYNC.loadConfig(true, SA, {}), { cacheDir: path.join(TMP, "st-cache") });
  const cur = be.read("shared-p");
  be.write("shared-p", { ...cur.files, "deep-plan/state/other-plan.json": "{}" }, cur.version);
  const ED = side("d");
  r = on(ED, SB, "state", "pull", "shared-p");
  ok("state pull: refuses a branch that carries another plan's files, writing nothing", r.status !== 0 &&
    /outside the plan's own files/.test(r.stderr) && !fs.existsSync(path.join(ED.DEEP_PLAN_STATE_DIR, "shared-p.json")), r.stderr);
  ok("state pull: a plan with no branch is named", /no branch seamux-state\/nope on remote origin/.test(on(EB, SB, "state", "pull", "nope").stderr));
  ok("state: export-state and import-state still work by hand",
    on(EA, SA, "export-state", "shared-p", "--out", path.join(TMP, "sp.bundle.json")).status === 0 &&
    on(side("e"), SB, "import-state", path.join(TMP, "sp.bundle.json")).status === 0);
}

// -------------------------------------------------- merge a race by rule
{
  const M = await import(new URL("lib/merge.mjs", import.meta.url));
  const base = () => ({ slug: "m", root: "/r", phase: "implementing", log: [{ at: 1, what: "render" }],
    increments: [
      { n: 1, title: "one", status: "pending", checks: { t: { kind: "test", name: "t", status: "pending", at: 1 } } },
      { n: 2, title: "two", status: "pending", checks: {} },
    ] });
  const a = base(), b = base();
  a.increments[0] = { ...a.increments[0], status: "done", doneAt: 100, changedAt: 100,
    checks: { t: { kind: "test", name: "t", status: "pass", at: 90, note: "a ran it" } } };
  a.log.push({ at: 100, what: "done: increment 1" });
  b.increments[0] = { ...b.increments[0], status: "pending", changedAt: 200,
    checks: { t: { kind: "test", name: "t", status: "pending", at: 200, note: "reset — re-verify" } } };
  b.log.push({ at: 200, what: "reset: increment 1" });
  let m = M.mergeStates(a, b);
  ok("merge: a reset after a done wins, and its re-pended check with it", m.increments[0].status === "pending" && m.increments[0].checks.t.status === "pending");
  m = M.mergeStates(b, a);
  ok("merge: …in either order", m.increments[0].status === "pending" && m.increments[0].checks.t.status === "pending");
  b.increments[0].changedAt = 50; b.increments[0].checks.t.at = 50; b.log[1].at = 50;
  m = M.mergeStates(b, a);
  ok("merge: a done after a reset wins", m.increments[0].status === "done" && m.increments[0].checks.t.status === "pass");
  ok("merge: the log is the union by time", m.log.map(l => l.at).join(",") === "1,50,100");
  const c = base(), d = base();
  c.increments[1] = { ...c.increments[1], status: "authorized", authorizedAt: 300, changedAt: 300 };
  d.increments[0].checks.t = { kind: "test", name: "t", status: "pass", at: 400, note: "d ran it" };
  m = M.mergeStates(c, d);
  ok("merge: each increment from its own latest side, and each check its newest verdict",
    m.increments[1].status === "authorized" && m.increments[0].checks.t.status === "pass" && m.increments[0].checks.t.note === "d ran it");
  const e = base(); e.increments[0].startedAt = 500; e.increments[0].status = "working"; e.increments[0].changedAt = 10;
  ok("merge: the gate's flip to working (startedAt) counts as a transition", M.mergeStates(base(), e).increments[0].status === "working");
  const done = base(); done.increments.forEach(i => { i.status = "done"; i.changedAt = 10; }); done.phase = "delivery";
  const reopened = base(); reopened.increments[1] = { ...reopened.increments[1], status: "pending", changedAt: 20 };
  ok("merge: the phase follows the merged increments", M.mergeStates(done, reopened).phase === "implementing");

  // Two machines on one plan, racing through the branch.
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  const RO = path.join(TMP, "race-origin.git"), RA = path.join(TMP, "race-a"), RB = path.join(TMP, "race-b");
  execSync(`git init -q --bare ${RO}`);
  fs.mkdirSync(RA);
  execSync(`git init -q && ${G} commit -q --allow-empty -m init && git remote add origin ${RO} && git push -q origin HEAD:refs/heads/main`, { cwd: RA });
  execSync(`git clone -q ${RO} ${RB}`);
  const side = name => {
    const dd = path.join(TMP, "race-data-" + name);
    return { ...ENV, DEEP_PLAN_STATE_DIR: path.join(dd, "state"), DEEP_PLAN_KEYS_DIR: path.join(dd, "keys"),
      DEEP_PLAN_PLANS_DIR: path.join(dd, "plans"), LOOKOUT_REVIEWS_DIR: path.join(dd, "plans", "reviews") };
  };
  const EA = side("a"), EB = side("b");
  const on = (env, dir, ...x) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...x], { encoding: "utf8", env, cwd: dir });
  const stOf = env => JSON.parse(fs.readFileSync(path.join(env.DEEP_PLAN_STATE_DIR, "race-p.json"), "utf8"));
  on(EA, RA, "render", tmpSpec({ ...spec, slug: "race-p" }), "--root", RA);
  const k = JSON.parse(fs.readFileSync(path.join(EA.DEEP_PLAN_KEYS_DIR, "race-p.key.json"), "utf8"));
  on(EA, RA, "grade", "race-p", ...Object.entries(k.answers).map(([q, v]) => `${q}=${v.letter}`));
  on(EA, RA, "state", "push", "race-p");
  on(EB, RB, "state", "pull", "race-p", "--root", RB);
  // A and B each move, neither having seen the other; A lands first.
  on(EA, RA, "go", "race-p", "1");
  on(EB, RB, "block", "race-p", "2", "B's reason");
  ok("race: the first writer's push lands", /pushed race-p/.test(on(EA, RA, "state", "push", "race-p").stdout));
  let r = on(EB, RB, "state", "push", "race-p");
  ok("race: the second writer's push merges with the branch and lands", r.status === 0 && /merged with the branch first/.test(r.stdout), r.stdout + r.stderr);
  on(EA, RA, "state", "pull", "race-p");
  let sa = stOf(EA), sb = stOf(EB);
  ok("race: nothing is lost — A has B's block and B has A's go",
    sa.increments[0].status === "authorized" && sa.increments[1].status === "blocked" &&
    sb.increments[0].status === "authorized" && sb.increments[1].status === "blocked", JSON.stringify([sa.increments.map(i => i.status), sb.increments.map(i => i.status)]));
  ok("race: both logs are kept", sa.log.some(l => /^block: increment 2/.test(l.what)) && sa.log.some(l => /^go: increment 1/.test(l.what)));
  ok("race: the root stays each machine's own", fs.realpathSync(sa.root) === fs.realpathSync(RA) && fs.realpathSync(sb.root) === fs.realpathSync(RB), sa.root + " " + sb.root);
  // The other order, and a later reset: B resets 1 after A started it, and A pushes second.
  on(EA, RA, "start", "race-p", "1");
  on(EB, RB, "reset", "race-p", "1");
  ok("race (other order): B lands first", /pushed race-p/.test(on(EB, RB, "state", "push", "race-p").stdout));
  r = on(EA, RA, "state", "push", "race-p");
  sa = stOf(EA);
  ok("race (other order): A merges, and B's later reset wins over A's earlier start",
    r.status === 0 && /merged with the branch first/.test(r.stdout) && sa.increments[0].status === "pending", r.stdout + r.stderr + JSON.stringify(sa.increments[0]));
  on(EB, RB, "state", "pull", "race-p");
  ok("race (other order): B pulls the same result", stOf(EB).increments[0].status === "pending" && stOf(EB).increments[1].status === "blocked");
  ok("race: both machines end in sync", /: in sync/.test(on(EA, RA, "state", "status", "race-p").stdout) && /: in sync/.test(on(EB, RB, "state", "status", "race-p").stdout));
  ok("merge: a plan with no increments keeps its phase", M.mergeStates({ slug: "e", phase: "done", increments: [] }, { slug: "e", phase: "done", increments: [] }).phase === "done");
  const ap = base(); ap.approved = { path: "/p.approved.md" }; ap.log.push({ at: 5, what: "grade" });
  const later = base(); later.log.push({ at: 900, what: "block" });
  ok("merge: a plan-level record only the trailing side has is kept", M.mergeStates(later, ap).approved && M.mergeStates(later, ap).approved.path === "/p.approved.md");
  // --root still applies when a pull merges.
  on(EB, RB, "block", "race-p", "1", "here");
  on(EA, RA, "block", "race-p", "2", "there again"); on(EA, RA, "state", "push", "race-p");
  const RB2 = path.join(TMP, "race-b2"); execSync(`git clone -q ${RO} ${RB2}`);
  r = on(EB, RB, "state", "pull", "race-p", "--root", RB2);
  ok("state pull --root: applies when the pull merges", /merged race-p/.test(r.stdout) && fs.realpathSync(stOf(EB).root) === fs.realpathSync(RB2), r.stdout + r.stderr);
}

// -------------------------------------------------- sync on transitions, and a pull at session start
{
  const G = "git -c user.email=probe@deep-plan -c user.name=probe";
  const TO = path.join(TMP, "tr-origin.git"), TA = path.join(TMP, "tr-a");
  execSync(`git init -q --bare ${TO}`);
  fs.mkdirSync(TA);
  execSync(`git init -q && ${G} commit -q --allow-empty -m init && git remote add origin ${TO} && git push -q origin HEAD:refs/heads/main`, { cwd: TA });
  const side = name => {
    const dd = path.join(TMP, "tr-data-" + name);
    return { ...ENV, DEEP_PLAN_STATE_DIR: path.join(dd, "state"), DEEP_PLAN_KEYS_DIR: path.join(dd, "keys"),
      DEEP_PLAN_PLANS_DIR: path.join(dd, "plans"), LOOKOUT_REVIEWS_DIR: path.join(dd, "plans", "reviews") };
  };
  const EA = side("a");
  const on = (env, dir, ...x) => spawnSync("node", [path.join(HERE, "deep_plan.mjs"), ...x], { encoding: "utf8", env, cwd: dir });
  const tipOf = slug => spawnSync("git", ["--git-dir", TO, "rev-parse", "--verify", "-q", "refs/heads/seamux-state/" + slug], { encoding: "utf8" }).stdout.trim();
  const branchState = slug => JSON.parse(execSync(`git --git-dir ${TO} show refs/heads/seamux-state/${slug}:deep-plan/state/${slug}.json`, { encoding: "utf8" }));
  const gradeIt = (env, dir, slug) => {
    const k = JSON.parse(fs.readFileSync(path.join(env.DEEP_PLAN_KEYS_DIR, slug + ".key.json"), "utf8"));
    return on(env, dir, "grade", slug, ...Object.entries(k.answers).map(([q, v]) => `${q}=${v.letter}`));
  };

  let r = on(EA, TA, "render", tmpSpec({ ...spec, slug: "tr-bad", share: { remote: "origin", sync: "always" } }), "--root", TA);
  ok("render refuses a share it cannot read", r.status !== 0 && /share\.sync: transitions or manual/.test(r.stderr), r.stderr);
  r = on(EA, TA, "render", tmpSpec({ ...spec, slug: "tr-p", share: true }), "--root", TA);
  ok("render records the spec's share in the plan state", r.status === 0 &&
    JSON.parse(fs.readFileSync(path.join(EA.DEEP_PLAN_STATE_DIR, "tr-p.json"), "utf8")).share === true, r.stderr);
  ok("render itself does not push", tipOf("tr-p") === "");
  gradeIt(EA, TA, "tr-p");
  ok("grade pushes a shared plan", tipOf("tr-p") !== "" && branchState("tr-p").phase === "implementing");
  let t = tipOf("tr-p");
  on(EA, TA, "go", "tr-p", "1");
  ok("go pushes", tipOf("tr-p") !== t && branchState("tr-p").increments[0].status === "authorized");
  t = tipOf("tr-p");
  const g = spawnSync("bash", [path.join(HERE, "hooks", "gate.sh")], { encoding: "utf8", env: EA,
    input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(TA, "a.txt") }, cwd: TA }) });
  ok("the gate's flip to working is not pushed", g.status === 0 &&
    JSON.parse(fs.readFileSync(path.join(EA.DEEP_PLAN_STATE_DIR, "tr-p.json"), "utf8")).increments[0].status === "working" && tipOf("tr-p") === t, g.stderr);
  on(EA, TA, "block", "tr-p", "2", "waiting");
  ok("block pushes, and carries the earlier flip to working", tipOf("tr-p") !== t &&
    branchState("tr-p").increments[0].status === "working" && branchState("tr-p").increments[1].status === "blocked");
  t = tipOf("tr-p");
  on(EA, TA, "reset", "tr-p", "2");
  ok("reset pushes", tipOf("tr-p") !== t && branchState("tr-p").increments[1].status === "pending");
  t = tipOf("tr-p");
  r = on(EA, TA, "check", "pass", "tr-p", "1", "nope", "x");
  ok("a refused command pushes nothing", r.status !== 0 && tipOf("tr-p") === t);

  // A plan that does not share never pushes; one on sync manual or off does not either.
  on(EA, TA, "render", tmpSpec({ ...spec, slug: "tr-private" }), "--root", TA);
  gradeIt(EA, TA, "tr-private"); on(EA, TA, "go", "tr-private", "1");
  ok("a plan that does not share is never pushed", tipOf("tr-private") === "");
  ok("…and state push still works on it by hand", on(EA, TA, "state", "push", "tr-private").status === 0 && tipOf("tr-private") !== "");
  on(EA, TA, "render", tmpSpec({ ...spec, slug: "tr-manual", share: { sync: "manual" } }), "--root", TA);
  gradeIt(EA, TA, "tr-manual");
  ok("share sync manual does not push on a transition", tipOf("tr-manual") === "");
  t = tipOf("tr-p");
  on({ ...EA, SEAMUX_STATE_SYNC: "off" }, TA, "block", "tr-p", "2", "offline here");
  ok("SEAMUX_STATE_SYNC=off stops the pushes on this machine", tipOf("tr-p") === t);

  // A push that fails: said once, the command still succeeds, status says unsynced until one lands.
  fs.renameSync(TO, TO + "-away");
  r = on(EA, TA, "reset", "tr-p", "2");
  ok("a failed push leaves the transition done and says so once",
    r.status === 0 && (r.stderr.match(/was not pushed to its state branch/g) || []).length === 1 &&
    JSON.parse(fs.readFileSync(path.join(EA.DEEP_PLAN_STATE_DIR, "tr-p.json"), "utf8")).increments[1].status === "pending", r.stderr);
  ok("status marks the plan unsynced", /unsynced: the last push to its state branch failed/.test(on(EA, TA, "status").stdout) &&
    JSON.parse(on(EA, TA, "status", "--json").stdout).find(x => x.slug === "tr-p").unsynced);
  fs.renameSync(TO + "-away", TO);
  on(EA, TA, "block", "tr-p", "2", "back online");
  ok("the next transition's push lands and clears it", branchState("tr-p").increments[1].status === "blocked" &&
    !JSON.parse(on(EA, TA, "status", "--json").stdout).find(x => x.slug === "tr-p").unsynced);

  // A session start pulls. Locally: the shared plans rooted in this repo.
  const EB = side("b");
  on(EB, TA, "state", "pull", "tr-p");
  on(EA, TA, "block", "tr-p", "1", "moved on A");
  r = on({ ...EB, CLAUDE_PROJECT_DIR: TA }, TA, "state", "pull", "--session");
  ok("session start pulls a shared plan of this repo that moved", r.status === 0 && /deep-plan: pulled tr-p/.test(r.stdout) &&
    JSON.parse(fs.readFileSync(path.join(EB.DEEP_PLAN_STATE_DIR, "tr-p.json"), "utf8")).increments[0].status === "blocked", r.stdout + r.stderr);
  ok("…and says nothing when nothing moved", on({ ...EB, CLAUDE_PROJECT_DIR: TA }, TA, "state", "pull", "--session").stdout.trim() === "");
  ok("…and does not bring plans that are not here, on a local machine", !fs.existsSync(path.join(EB.DEEP_PLAN_STATE_DIR, "tr-private.json")));
  // On the remote host: a new sandbox gets every plan with a branch on this repo's remote.
  const TC = path.join(TMP, "tr-c");
  execSync(`git clone -q ${TO} ${TC}`);
  const RH = path.join(TMP, "tr-remote-home");
  const REnv = { ...ENV, HOME: RH, SEAMUX_HOST: "remote", CLAUDE_PROJECT_DIR: TC };
  for (const k of ["DEEP_PLAN_STATE_DIR", "DEEP_PLAN_KEYS_DIR", "DEEP_PLAN_PLANS_DIR", "DEEP_PLAN_ANNOT_DIR"]) delete REnv[k];
  r = on(REnv, TC, "state", "pull", "--session");
  const SD = path.join(TC, ".seamux", "state", "deep-plan", "state");
  ok("session start on the remote host pulls the plans with a branch on the repo's remote, rooted in the new clone",
    r.status === 0 && fs.existsSync(path.join(SD, "tr-p.json")) && fs.existsSync(path.join(SD, "tr-private.json")) &&
    fs.realpathSync(JSON.parse(fs.readFileSync(path.join(SD, "tr-p.json"), "utf8")).root) === fs.realpathSync(TA), r.stdout + r.stderr);
  const gone = path.join(TMP, "tr-nowhere");
  r = on({ ...EB, CLAUDE_PROJECT_DIR: gone }, TMP, "state", "pull", "--session");
  ok("session start outside a repo does nothing and exits 0", r.status === 0 && r.stdout.trim() === "");
  const hooks = JSON.parse(fs.readFileSync(path.join(HERE, "hooks", "hooks.json"), "utf8")).hooks;
  ok("the plugin's SessionStart hooks pull shared state", hooks.SessionStart.some(gr => gr.hooks.some(h => /state pull --session/.test(h.command))));
  const IRP = path.join(TMP, "tr-install");
  fs.mkdirSync(IRP); execSync(`git init -q && ${G} commit -q --allow-empty -m init`, { cwd: IRP });
  r = on(ENV, IRP, "install-repo", "--root", IRP);
  const rs = r.status === 0 ? JSON.parse(fs.readFileSync(path.join(IRP, ".claude", "settings.json"), "utf8")) : {};
  ok("install-repo gives a cloud repo the same session-start pull", r.status === 0 &&
    (rs.hooks.SessionStart || []).some(gr => gr.hooks.some(h => /skills\/deep-plan\/deep_plan\.mjs" state pull --session/.test(h.command))), r.stderr);
}

// -------------------------------------------------- hot-path cost
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) gate("Edit", { file_path: "/tmp/x" }, TMP);
const ms = Number(process.hrtime.bigint() - t0) / 20e6;
console.log(`\n  hot path (state files present, path untracked): ${ms.toFixed(1)} ms/call over 20`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ndeep-plan probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
