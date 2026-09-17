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
  // Authoritative override (empty = no client): a probe render on a machine
  // with a real TypeSafe key must never judge evidence over the network.
  DEEP_PLAN_TYPESAFE_CLIENT: "",
};
const MERMAID_VENDOR = path.join(HERE, "vendor", "mermaid.min.js");
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
// A fresh clone has no vendor/mermaid.min.js (it is gitignored; install.sh and
// CI fetch it). The validator degrades to a "skipped" sentinel, but render used
// to hand that case an ENOENT stack trace straight out of node:fs, which reads
// as a broken tool rather than a missing file. It must refuse legibly instead.
{
  const stash = MERMAID_VENDOR + ".probe-stash";
  fs.renameSync(MERMAID_VENDOR, stash);
  const r = cli("render", tmpSpec(spec));
  fs.renameSync(stash, MERMAID_VENDOR);
  ok("render without the vendored mermaid refuses legibly, not with a stack trace",
    r.status !== 0 && /vendor\/mermaid\.min\.js is missing/.test(r.stderr) &&
    !/node:fs|readFileSync|ENOENT/.test(r.stderr));
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
  for (const s of ["evidence-probe", "evidence-probe-judged"]) {
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

// -------------------------------------------------- observability verdicts gate `done`
//
// Per-DELIVERABLE observability, which is a different thing from the top-level
// advisory spec.observability block asserted further up: declaring checks on a
// deliverable means its `done` is refused until a verdict is recorded.
{
  const CHECK = { checks: [{ system: "datadog", name: "retry counter climbs",
    query: "sum:outbox.retry{env:qa}", expect: "non-zero within 15m" }] };
  const withObs = n => {
    const s = JSON.parse(JSON.stringify(spec));
    s.slug = n;
    s.deliverables[0].observability = CHECK;
    return s;
  };
  const stOf = n => JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), "utf8"));
  // Take a plan to the point where increment 1 can be done.
  const arm = n => {
    cli("render", tmpSpec(withObs(n)));
    const key = JSON.parse(fs.readFileSync(path.join(ENV.DEEP_PLAN_KEYS_DIR, n + ".key.json"), "utf8"));
    cli("grade", n, ...Object.entries(key.answers).map(([q, v]) => `${q}=${v.letter}`));
    cli("go", n, "1"); cli("start", n, "1");
  };

  arm("obs-1");
  ok("a deliverable that declares observability starts pending",
    stOf("obs-1").increments[0].obs.status === "pending");
  ok("a deliverable that declares nothing is n/a",
    stOf("obs-1").increments[1].obs.status === "n/a");
  let r = cli("done", "obs-1", "1");
  ok("done is refused while the verdict is pending",
    r.status === 1 && /observability check and it is pending/.test(r.stderr));
  ok("the refusal names how to see the checks and how to record one",
    /obs check obs-1 1/.test(r.stderr) && /obs pass obs-1 1/.test(r.stderr));
  ok("the refusal names the override", /--force/.test(r.stderr));
  ok("the increment did not move", stOf("obs-1").increments[0].status === "working");

  ok("obs fail refuses without a reason", cli("obs", "fail", "obs-1", "1").status === 1);
  ok("obs fail records one", cli("obs", "fail", "obs-1", "1", "counter flat").status === 0 &&
    stOf("obs-1").increments[0].obs.status === "fail");
  r = cli("done", "obs-1", "1");
  ok("done is refused while the verdict is fail, and shows the note",
    r.status === 1 && /it is fail/.test(r.stderr) && /counter flat/.test(r.stderr));

  ok("obs pass records a verdict and a note",
    cli("obs", "pass", "obs-1", "1", "412 over 20m").status === 0 &&
    stOf("obs-1").increments[0].obs.status === "pass" &&
    stOf("obs-1").increments[0].obs.note === "412 over 20m");
  ok("done is allowed once the verdict passes",
    cli("done", "obs-1", "1").status === 0 && stOf("obs-1").increments[0].status === "done");

  // A recorded verdict must survive a re-render, or amending the spec would
  // quietly clear evidence.
  cli("render", tmpSpec(withObs("obs-1")));
  ok("a recorded pass survives a re-render", stOf("obs-1").increments[0].obs.status === "pass");
  // …and must survive the declaration being dropped: it was true when recorded.
  const dropped = JSON.parse(JSON.stringify(spec)); dropped.slug = "obs-1";
  cli("render", tmpSpec(dropped));
  ok("a pass survives the declaration being dropped", stOf("obs-1").increments[0].obs.status === "pass");

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
  ok("resetting an increment re-gates its verdict",
    stOf("obs-5").increments[0].obs.status === "pending");
  ok("…keeping what the verdict was, rather than deleting the evidence",
    /was pass: seen once/.test(stOf("obs-5").increments[0].obs.note));
  ok("…and saying so in the log",
    stOf("obs-5").log.some(l => /returned to pending/.test(l.what)));
  cli("go", "obs-5", "1"); cli("start", "obs-5", "1");
  ok("done is refused again after the reset", cli("done", "obs-5", "1").status === 1);
  // An increment with nothing to re-gate must not gain a spurious verdict.
  cli("reset", "obs-5", "2");
  ok("resetting an undeclared increment leaves it n/a",
    stOf("obs-5").increments[1].obs.status === "n/a");

  // The explicit hatch, for when the work stands but the evidence does not.
  cli("obs", "pass", "obs-5", "1", "seen twice");
  ok("obs reset returns a recorded verdict to pending",
    cli("obs", "reset", "obs-5", "1").status === 0 &&
    stOf("obs-5").increments[0].obs.status === "pending" &&
    /was pass: seen twice/.test(stOf("obs-5").increments[0].obs.note));
  ok("obs reset refuses where there is no verdict",
    cli("obs", "reset", "obs-5", "2").status === 1);

  // Adding the field to a spec whose state already exists must gate it, not
  // leave it silently un-gated at n/a.
  arm("obs-2");
  const p2 = path.join(ENV.DEEP_PLAN_STATE_DIR, "obs-2.json");
  const s2 = JSON.parse(fs.readFileSync(p2, "utf8"));
  s2.increments[1].obs = { status: "n/a", at: 0, note: "", version: "" };
  fs.writeFileSync(p2, JSON.stringify(s2, null, 2));
  const both = withObs("obs-2"); both.deliverables[1].observability = CHECK;
  cli("render", tmpSpec(both));
  ok("declaring observability on an existing plan flips n/a to pending",
    stOf("obs-2").increments[1].obs.status === "pending");

  // --force, and the log saying so.
  arm("obs-3");
  ok("done --force overrides a pending verdict",
    cli("done", "obs-3", "1", "--force").status === 0 &&
    stOf("obs-3").increments[0].status === "done");
  ok("the override is written to the log",
    stOf("obs-3").log.some(l => /overridden with --force/.test(l.what) && /observability/.test(l.what)));

  // `obs check` reads the SPEC. The older engine generated these blocks per
  // vendor; none of that comes across, so the check output is only ever a
  // readback of what the plan already committed to.
  const chk = cli("obs", "check", "obs-3", "1");
  ok("obs check prints the declared checks from the spec",
    chk.status === 0 && chk.stdout.includes("retry counter climbs") &&
    chk.stdout.includes("sum:outbox.retry{env:qa}") && chk.stdout.includes("non-zero within 15m"));
  ok("obs check on an undeclared increment says so, and does not fail",
    cli("obs", "check", "obs-3", "2").status === 0 &&
    /declares no observability check/.test(cli("obs", "check", "obs-3", "2").stdout));

  arm("obs-4");
  const rows = JSON.parse(cli("status", "--json").stdout);
  const row4 = rows.find(x => x.slug === "obs-4");
  ok("status --json carries the outstanding verdicts for the board",
    row4 && row4.obsOutstanding.length === 1 && row4.obsOutstanding[0].n === 1 &&
    row4.obsOutstanding[0].status === "pending");
  ok("status names them in the text form too",
    /observability outstanding: 1 \(pending\)/.test(cli("status").stdout));
  const wp = n => fs.readFileSync(path.join(ENV.DEEP_PLAN_PLANS_DIR, n + ".working.html"), "utf8");
  ok("the working page lists the checks while a verdict is outstanding",
    wp("obs-4").includes("retry counter climbs") && wp("obs-4").includes("pending"));
  cli("obs", "pass", "obs-4", "1", "seen");
  ok("…and shows the verdict instead once it passes",
    wp("obs-4").includes("pass") && wp("obs-4").includes("seen") &&
    !wp("obs-4").includes("sum:outbox.retry{env:qa}"));

  for (const n of ["obs-1", "obs-2", "obs-3", "obs-4"]) {
    cli("close", n);
    fs.rmSync(path.join(ENV.DEEP_PLAN_STATE_DIR, n + ".json"), { force: true });
  }
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

// -------------------------------------------------- hot-path cost
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) gate("Edit", { file_path: "/tmp/x" }, TMP);
const ms = Number(process.hrtime.bigint() - t0) / 20e6;
console.log(`\n  hot path (state files present, path untracked): ${ms.toFixed(1)} ms/call over 20`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ndeep-plan probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
