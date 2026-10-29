#!/usr/bin/env node
// deep-plan — plan a change as a reviewable artifact, and refuse edits until
// the human authorizes each increment.
//
// Built from deep-plan/ADAPTING.md for this machine (2026-09-12). Decisions:
//   floors    ≤120 words/paragraph; ceil(words/900) mermaid diagrams, min 1
//   quiz      rendered on the review surface, graded by `deep-plan grade`
//   gate      hard deny (exit 2); one `go` authorizes a whole increment
//   keys      ~/.claude/deep-plan/keys — separate tree from rendered plans
//
// Surfaces (all regenerable from the archived spec — `rehydrate` proves it):
//   ~/.claude/plans/<slug>.md            durable record
//   ~/.claude/plans/<slug>.review.html   frozen review + quiz (mermaid inlined)
//   ~/.claude/plans/<slug>.working.html  live tracker (mermaid inlined; the
//                                        intent server swaps it for /mermaid.min.js)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync, execFileSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDiagrams, validateSurface, mermaidPath, mermaidCandidates, VENDOR_DIR, MERMAID_HOME } from "./lib/validate.mjs";
import { loadAdrConfig, resolveAdrDir, nextNumber, adrFileName, renderAdr, adrEntries, adrScanReport } from "./lib/adr.mjs";
import { epicHtml, incrementMd, bundleReadme, incrementFileNames, checkLinesMd } from "./lib/cutover.mjs";
import { checkEvidence } from "./lib/evidence.mjs";
import { SURFACE_CSS, SURFACE_JS, surfaceOpen, surfaceClose, fileTreeHtml, diagramCardHtml, diagramsForValidation } from "./lib/surface.mjs";
import { resolveFiles, resolver } from "./lib/verify.mjs";
import { runExec, acquireSteps, alive, sleep, tail } from "./lib/runner.mjs";
import { releaseClaims } from "./lib/claims.mjs";
import { buildProof, withProof, ghCanAttach, gh } from "./lib/proof.mjs";
import { readEvidence, evidenceSummary, newEvidenceDir, pruneEvidence, showTab, browserDriver } from "./lib/browser.mjs";
import { detect, draftFile } from "./lib/detect.mjs";
import { detectHost, hostLine } from "./lib/host.mjs";
import * as SERVE from "./lib/serve.mjs";
import * as SYNC from "./lib/sync.mjs";
import { mergeStates, mergeFiles } from "./lib/merge.mjs";
import { installRepo, checkRepo, targetRoot } from "./lib/install.mjs";
import { EXT_DIR, listExt, runExt, extPath } from "./lib/ext.mjs";
import {
  FAMILIES_DIR, validateWorkstreams, buildIndex, writeIndex, readIndex, indexPath,
  familyOf, refreshFamilyFor, overlaps, checkFamily, draftParent, waitingOn, waitText,
  memberAt, readSeen, gatherNews, newsText, familyRow, familiesBySlug, protects,
  goOwner, goBy, goHow, goRefusal, updateControl, pruneControl, controlPath,
} from "./lib/family.mjs";
import {
  STATE_DIR, KEYS_DIR, PLANS_DIR, DATA_ROOT, REMOTE_DIR, statePath, sessionId,
  readState, writeState, allStates, log1, progress, gateView,
  planFor, CHECK_KINDS, specChecks, reconcileChecks, checksOf, checksBlock,
  checksAggregate, needsTree, treeOf, checkMeta, canon,
} from "./lib/state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The pinned diagram engine. `setup` and the first render that finds no bundle
// fetch exactly this build into the data tree, and refuse any other bytes.
const MERMAID_VERSION = "11.17.2";
const MERMAID_SHA256 = "581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8";
const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
// The engine pointer: where this engine lives, for callers outside Claude (the
// board's go chip, triage, the intent server, the ~/.local/bin shim). The
// overrides are for the probe, so a test run never repoints the real one.
const ENGINE_FILE = process.env.DEEP_PLAN_ENGINE_FILE ||
  path.join(os.homedir(), ".claude", "deep-plan", "engine.json");
const SHIM_DIR = process.env.DEEP_PLAN_BIN_DIR || path.join(os.homedir(), ".local", "bin");

const PARA_CEILING = 120;   // words; rejects the house's worst walls (178/140/130)
const DIAGRAM_PER = 900;    // one diagram per this many prose words, min 1
const RISK_DISPOSITIONS = ["accept", "mitigate", "spike", "promote"];

// One reading of a risks entry for every renderer: the text, the disposition
// (empty when none), and the payload that disposition carries — a deliverable
// title or a ticket for mitigate, the note for spike, nothing for the rest.
function riskView(r) {
  if (typeof r === "string") return { risk: r, disposition: "", payload: "", undisposed: true };
  const d = r.disposition || "";
  let payload = "";
  if (d === "mitigate") payload = r.deliverableRef || (r.ticketRef ? `ticket ${r.ticketRef}${r.note ? " — " + r.note : ""}` : "");
  else if (r.note) payload = r.note;
  return { risk: r.risk || "", disposition: d, payload, undisposed: !d };
}
// The text form, for the md plan and the cutover increments.
function riskLine(r) {
  const v = riskView(r);
  return v.disposition ? `${v.risk}  \n  disposition: ${v.disposition}${v.payload ? " — " + v.payload : ""}` : v.risk;
}

// ---------------------------------------------------------------- helpers

function die(msg) { console.error("deep-plan: " + msg); process.exit(1); }
function say(msg) { console.log(msg); }

function words(s) { return (s || "").split(/\s+/).filter(Boolean).length; }

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Deterministic per-slug shuffle, so rehydrate is byte-identical and the
// stored answer key always matches the rendered order.
function shuffled(arr, seed) {
  const out = arr.map((v, i) => {
    const h = crypto.createHash("sha256").update(seed + ":" + i).digest();
    return { v, i, k: h.readUInt32BE(0) };
  });
  out.sort((a, b) => a.k - b.k);
  return out; // [{v, i(original index), k}]
}

function gitRoot(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------- validate

function validate(spec, force) {
  const errs = [];
  if (!spec.slug || !/^[a-z0-9][a-z0-9-]*$/.test(spec.slug))
    errs.push("slug must be kebab-case: got " + JSON.stringify(spec.slug));
  if (!spec.title) errs.push("title is required");
  // A parent's workstreams, shape only; membership is judged at render.
  errs.push(...validateWorkstreams(spec));
  if (!spec.context) errs.push("context is required (why now, what exists, what is out of frame)");
  if (!Array.isArray(spec.deliverables) || spec.deliverables.length === 0)
    errs.push("at least one deliverable (increment) is required");

  for (const d of spec.decisions || []) {
    if (!d.why) errs.push(`decision "${d.decision}" has no why`);
    // A decision flagged as an ADR must own its consequences — without them
    // it is just a decision wearing the name. Everything else in the adr
    // field (context, alternatives, status) stays optional.
    if (d.adr && !(d.adr.consequences && String(d.adr.consequences).trim()))
      errs.push(`decision "${d.decision}" is flagged adr but has no consequences`);
  }
  for (const f of spec.verifiedFacts || [])
    if (!f.claim || !f.evidence)
      errs.push("a verifiedFacts entry is missing claim or evidence (path:line). Uncited claims belong in risks.");

  // Risks: a disposition is what the review produces about each one — accept,
  // mitigate (a deliverable here, or a filed ticket), spike (a named check),
  // promote (a quiz question). Authoring stays permissive: a string or an
  // undispositioned object renders. Grade is where an undispositioned risk
  // refuses (key.undispositionedRisks), the same shape as uncovered contracts.
  // A disposition that IS set must hold together, and that refuses here.
  for (const r of spec.risks || []) {
    if (typeof r === "string") continue;
    const text = r.risk || "(unnamed risk)";
    if (!r.risk) errs.push("a risks entry has no risk text");
    if (r.disposition === undefined || r.disposition === null || r.disposition === "") continue;
    if (!RISK_DISPOSITIONS.includes(r.disposition)) {
      errs.push(`risk "${text}": disposition must be one of ${RISK_DISPOSITIONS.join("|")}`);
      continue;
    }
    if (r.disposition === "mitigate") {
      const named = (spec.deliverables || []).some(d => d.title === r.deliverableRef);
      if (!named && !(r.ticketRef && r.note))
        errs.push(`risk "${text}": mitigate needs deliverableRef naming a deliverable title, or ticketRef plus a note`);
    }
    if (r.disposition === "spike" && !r.note)
      errs.push(`risk "${text}": spike needs a note saying what check settles it`);
    if (r.disposition === "promote" && !(spec.quiz || []).some(q => q.riskRef === r.risk))
      errs.push(`risk "${text}": promote needs a quiz question whose riskRef is this risk's text`);
  }

  // Contracts: declared shape changes (schemas, APIs, signatures) are the
  // expensive, hard-to-reverse kind, so this block is enforced — unlike
  // observability, which stays advisory. Quiz coverage of contract decisions
  // is grade's job, not render's: authoring stays permissive, review cannot
  // pass around a contract change.
  const CONTRACT_KINDS = ["db-schema", "api", "method-signature", "event", "config"];
  for (const c of spec.contracts || []) {
    const name = c.surface || "(unnamed surface)";
    if (!c.surface) errs.push("a contracts entry has no surface");
    if (!CONTRACT_KINDS.includes(c.kind))
      errs.push(`contract "${name}": kind must be one of ${CONTRACT_KINDS.join("|")}`);
    if (!["internal", "external"].includes(c.scope))
      errs.push(`contract "${name}": scope must be internal or external`);
    if (!["new", "modify", "remove"].includes(c.change))
      errs.push(`contract "${name}": change must be new, modify or remove`);
    if (!c.reach)
      errs.push(`contract "${name}": reach is required — who consumes this surface (scout it)`);
    const dec = (spec.decisions || []).find(d => d.decision === c.decisionRef);
    if (!c.decisionRef || !dec)
      errs.push(`contract "${name}": decisionRef must name a decision in the spec`);
    else if (c.scope === "external" && !dec.adr && !(c.waiver && String(c.waiver).trim()))
      errs.push(`contract "${name}": external scope defaults toward ADR — flag the decision, or write a waiver`);
  }

  // Checks: `done` is gated on them, so one the engine cannot read must refuse
  // here rather than gate an increment on something nobody can satisfy.
  (spec.deliverables || []).forEach((d, i) => {
    if (d.checks !== undefined && !Array.isArray(d.checks)) {
      errs.push(`deliverable ${i + 1}: checks must be an array`); return;
    }
    for (const c of d.checks || []) {
      const label = `deliverable ${i + 1} check "${c.id || c.name || c.recipe || "?"}"`;
      if (!CHECK_KINDS.includes(c.kind))
        errs.push(`${label}: kind must be one of ${CHECK_KINDS.join("|")}`);
      if (c.kind === "review") {
        if (c.recipe || c.run)
          errs.push(`${label}: a review check runs \`lookout gate\` for its increment; it names no recipe or command`);
      } else if (!(c.name || c.recipe)) errs.push(`${label}: needs a name, or the recipe it runs`);
      if (c.id !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(String(c.id)))
        errs.push(`${label}: id must be letters, digits, dot, dash or underscore`);
    }
    if ((d.checks || []).filter(c => c.kind === "review").length > 1)
      errs.push(`deliverable ${i + 1}: one review check per increment (it gates on that increment's one review)`);
    if (d.waiver !== undefined && !(typeof d.waiver === "string" && d.waiver.trim()))
      errs.push(`deliverable ${i + 1}: a waiver is a sentence saying why nothing can prove it`);
    const ids = specChecks(d).map(c => c.id);
    for (const id of new Set(ids.filter((x, k) => ids.indexOf(x) !== k)))
      errs.push(`deliverable ${i + 1}: two checks share the id "${id}"`);
  });

  // Floors, derived from this house's own plans. The fix for a wall is to
  // draw it, not to trim it to just under the limit.
  const prose = [spec.context, ...(spec.deliverables || []).map(d => d.body)];
  const total = prose.reduce((n, p) => n + words(p), 0);
  const floor = Math.max(1, Math.ceil(total / DIAGRAM_PER));
  const have = (spec.diagrams || []).length;
  if (have < floor)
    errs.push(`diagram floor: ${total} prose words need ${floor} diagram(s), spec has ${have}`);
  for (const dg of spec.diagrams || []) {
    if (!dg.question) errs.push("a diagram is missing its question — the question is the heading");
    if (!dg.mermaid) errs.push(`diagram "${dg.question}" has no mermaid`);
    if (dg.simple != null && typeof dg.simple !== "string")
      errs.push(`diagram "${dg.question}": simple is the overview's mermaid source, a string`);
  }
  prose.forEach((p, i) => {
    for (const para of (p || "").split(/\n\s*\n/)) {
      const w = words(para);
      if (w > PARA_CEILING)
        errs.push(`paragraph ceiling: a ${w}-word paragraph in ${i === 0 ? "context" : "deliverable " + i} (max ${PARA_CEILING}). Draw it instead.`);
    }
  });

  // Quiz linter: non-leading by construction.
  const quiz = spec.quiz || [];
  if (quiz.length < 3)
    errs.push(`alignment check needs 3+ questions about consequences; spec has ${quiz.length}`);
  const BANNED = /\b(recommended|correct|obviously|of course|as decided|as we agreed|best practice|the right)\b/i;
  for (const q of quiz) {
    const opts = q.options || [];
    if (opts.length < 2) { errs.push(`quiz ${q.id}: needs 2+ options`); continue; }
    if (typeof q.answer !== "number" || q.answer < 0 || q.answer >= opts.length)
      errs.push(`quiz ${q.id}: answer must index options as written`);
    if (!q.why) errs.push(`quiz ${q.id}: missing why`);
    if (!q.decisionRef) errs.push(`quiz ${q.id}: missing decisionRef (the decision to reopen when missed)`);
    for (const o of opts) {
      if (BANNED.test(o)) errs.push(`quiz ${q.id}: option "${o}" contains a leading word`);
      if (/\b(all|none) of the above\b/i.test(o)) errs.push(`quiz ${q.id}: "${o}" — no all/none of the above`);
    }
    const lens = opts.map(o => o.length);
    const correct = opts[q.answer] || "";
    if (correct.length === Math.max(...lens) && lens.filter(l => l === correct.length).length === 1 && opts.length > 2)
      errs.push(`quiz ${q.id}: the correct option is the single longest — the classic length tell`);
    if (Math.max(...lens) / Math.max(1, Math.min(...lens)) > 2.2)
      errs.push(`quiz ${q.id}: option lengths spread wider than 2.2×`);
    for (const tok of correct.split(/\W+/)) {
      if (tok.length > 6 && (q.prompt || "").includes(tok) &&
          !opts.some((o, i) => i !== q.answer && o.includes(tok)))
        errs.push(`quiz ${q.id}: prompt echoes "${tok}", unique to the correct answer`);
    }
  }

  // Which increments get a lookout review, and whether the full delivery
  // does, is the human's call at planning time: the spec must say, even when
  // the answer is none (`deep-plan render --force` past it is logged).
  const rv = spec.review;
  if (rv !== undefined && (typeof rv !== "object" || rv === null || Array.isArray(rv)))
    errs.push('review: an object, e.g. { "increments": [1, 3], "delivery": true }');
  else {
    const n = (spec.deliverables || []).length;
    for (const k of ["agentMayClose", "quiz", "delivery", "family"])
      if (rv && rv[k] !== undefined && typeof rv[k] !== "boolean") errs.push(`review.${k}: true or false`);
    // The family review is how a parent's delivery closes, so it needs both
    // a family and a delivery phase to happen in.
    if (rv && rv.family === true && !(Array.isArray(spec.workstreams) && spec.workstreams.length))
      errs.push("review.family: only a parent plan (one with workstreams) has a family to review");
    else if (rv && rv.family === true && rv.delivery !== true)
      errs.push("review.family needs review.delivery: true (the family review is how the parent's delivery closes)");
    const inc = rv && rv.increments;
    if (!rv || inc === undefined || rv.delivery === undefined)
      errs.push('review: ask the human which increments deserve a lookout review and whether the full delivery ' +
        'does, and record it: "review": { "increments": [1, 3] | "all" | "none", "delivery": true | false }');
    else if (!(inc === "all" || inc === "none" || (Array.isArray(inc) && inc.length &&
        inc.every(x => Number.isInteger(x) && x >= 1 && x <= n) && new Set(inc).size === inc.length)))
      errs.push(`review.increments: "all", "none", or increment numbers from 1 to ${n}, each once`);
  }
  // Whether the plan's state syncs to a branch, and where (lib/sync.mjs).
  errs.push(...SYNC.shareProblems(spec.share));
  if (errs.length && !force) {
    console.error("deep-plan: spec refused —");
    for (const e of errs) console.error("  ✗ " + e);
    process.exit(1);
  }
  if (errs.length) console.error(`deep-plan: --force past ${errs.length} floor violation(s) — logged`);
  return errs;
}

// ---------------------------------------------------------------- checks

// A review check is gated on lookout's verdict for its increment. Its command
// is synthesized, not a recipe: `lookout gate --plan <slug> --inc <n>`, run
// through lookout's engine pointer (deep-plan reaches lookout only through its
// CLI; plugins cannot import each other). It rides the recipe path — `check
// run`, staleness, the hand-pass refusal — but is marked `synth`, so drift
// against the repo's recipe files never applies to it.
const REVIEW_RECIPE = "lookout:gate";
function reviewCheck(c, slug, n) {
  const shown = `lookout gate --plan ${slug} --inc ${n}`;
  return { ...c, recipe: REVIEW_RECIPE, synth: "review", source: "deep-plan (review check)",
    hash: crypto.createHash("sha256").update("review\0" + shown).digest("hex").slice(0, 12),
    exec: { tier: "cheap", cwd: ".", timeout: 120, steps: [{ kind: "run", command: shown }] } };
}

// The plan as approved (its archived spec), or {} when there is none.
function planSpec(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(KEYS_DIR, slug + ".spec.json"), "utf8")); } catch { return {}; }
}

// The plan's review policy as lookout open flags: who may close findings,
// and the ownership quiz (lookout's group notes). Both are fixed when the
// review is created, so every open of a plan's review passes both.
function reviewPolicy(slug) {
  const spec = planSpec(slug);
  const agent = !!(spec.review && spec.review.agentMayClose);
  const quiz = !!(spec.review && spec.review.quiz);
  return { agent, quiz, flags: [...(agent ? ["--agent-may-close"] : []), ...(quiz ? ["--quiz"] : [])] };
}

// lookout's engine: $LOOKOUT_ENGINE, else the root its pointer names. "" when
// lookout is not installed.
function lookoutRoot() {
  const ok = r => r && fs.existsSync(path.join(r, "lookout.mjs")) ? r : "";
  // Authoritative when set, even empty: the probe sets it so no test run ever
  // reaches the machine's real lookout (or its reviews).
  if ("LOOKOUT_ENGINE" in process.env) return ok(process.env.LOOKOUT_ENGINE);
  try {
    return ok(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "lookout", "engine.json"), "utf8")).root);
  } catch { return ""; }
}
const LOOKOUT_MISSING = "lookout is not installed: enable the lookout plugin and run `lookout setup` (or set LOOKOUT_ENGINE)";
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

// The exec a review check actually runs: the stored one names the command a
// reader understands; this one names the engine that answers it.
function reviewExec(cur, slug, n) {
  const root = lookoutRoot();
  const command = root
    ? `${shq(process.execPath)} ${shq(path.join(root, "lookout.mjs"))} gate --plan ${shq(slug)} --inc ${Number(n)}`
    : `echo ${shq(LOOKOUT_MISSING)} >&2; exit 127`;
  return { ...cur.exec, steps: [{ kind: "run", command }] };
}

// An increment's review is <slug>-inc<n>; the full delivery's is
// <slug>-delivery (lookout's --inc all).
const reviewId = (slug, n) => n === "all" ? `${slug}-delivery` : `${slug}-inc${Number(n)}`;
// What the session does once a review is open: the engine opens it, but only
// the session can spawn the one reviewer subagent (it must not be the context
// that wrote the change). The last line is for the board, which shows only that.
const spawnLine = (slug, n) => `review: spawn a reviewer — lookout prompt ${reviewId(slug, n)}`;
function spawnHint(slug, n, pol = {}) {
  return `next: spawn ONE fresh reviewer subagent whose prompt is the output of\n  lookout prompt ${reviewId(slug, n)}\n` +
    `then: ${n === "all" ? `deep-plan deliver ${slug}` : `deep-plan check run ${slug} ${n}`}` +
    (pol.agent ? "\n(this plan lets the agent close findings too)" : "") +
    (pol.quiz ? "\n(this plan quizzes: the reviewer writes a question for each high-risk group)" : "");
}

// The increment whose start sha a review or diff is based on: the increment
// itself, or (inc "all") the plan's first. Never a later one standing in for a
// first that has none: a delivery review based there silently drops the
// earlier increments' work.
const baseInc = (st, inc) => inc === "all" ? (st.increments || [])[0] : inc;
const recordedSha = (st, inc) => (baseInc(st, inc) || {}).startSha || "";

// The base a review or diff opens at: the recorded start sha, else the --base
// given for a plan that has none (an increment authorized before go recorded
// one). A --base is recorded as that start sha, logged, so the check run and
// the deliver re-run that follow open the same review. A recorded sha always
// wins, and --base beside one is refused rather than ignored, so the flag
// cannot quietly move a base. Dies on a refusal.
function baseFor(st, inc, base) {
  const rec = recordedSha(st, inc);
  const bi = baseInc(st, inc);
  const what = inc === "all" ? `${st.slug}'s first increment` : `increment ${inc.n}`;
  if (rec && base) die(`${what} has a recorded start sha (${rec.slice(0, 8)}), which is its base; drop --base\n` +
    `--base refused: a start sha is recorded`);
  if (!base) return rec;
  const r = spawnSync("git", ["-C", st.root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`], { encoding: "utf8" });
  if (r.status !== 0) die(`--base ${base} is not a commit in ${st.root}`);
  const sha = r.stdout.trim();
  if (bi) {
    const fresh = readState(st.slug);         // re-read: never clobber a newer write
    const fi = findInc(fresh, bi.n);
    fi.startSha = bi.startSha = sha;
    log1(fresh, `--base: increment ${bi.n}'s start sha recorded as ${sha.slice(0, 8)}`);
    writeState(fresh);
  }
  return sha;
}

// The refusal for a review or diff with no base, naming the flag that gives one.
const noBase = (verb, slug, n) => `no recorded start sha — give one: deep-plan ${verb} ${slug}` +
  (verb === "deliver" ? "" : ` ${n || "<n>"}`) + " --base <sha>";

// Open (or refresh) a review in lookout with the plan's policy: an
// increment's work since its start sha, or (inc "all") the whole plan's since
// the first increment's; `base` stands in when none is recorded (baseFor has
// vetted it). { ok, out, agent, quiz } — never throws.
function openReview(st, inc, base = "") {
  const all = inc === "all";
  const sha = recordedSha(st, inc) || base;
  if (!sha) return { ok: false, out: noBase(all ? "deliver" : "review", st.slug, all || !inc ? "" : inc.n) };
  const pol = reviewPolicy(st.slug);
  const r = runLookout(["open", "--plan", st.slug, "--inc", all ? "all" : String(inc.n), "--base", sha, "--at", st.root,
    ...pol.flags], { cwd: st.root });
  return { ...r, agent: pol.agent, quiz: pol.quiz };
}

// ---------------------------------------------------------------- family review

// The reviewer's view of the family around one member: who the members are,
// what each owns, and the parent's contracts with who consumes them, so a
// review of one member's work looks hardest at the seams.
function familyContext(spec, idx) {
  const lines = [
    `This is one member's work in the deep-plan family ${spec.slug}. Each member is reviewed on its own;`,
    "look hardest at the seams: the contracts below, and files members share.",
  ];
  // Contracts first: they are the seams, and the part to keep if the text is cut.
  if ((spec.contracts || []).length) {
    lines.push("", "Contracts (the parent's spec):");
    for (const c of spec.contracts)
      lines.push(`- ${c.surface} [${c.kind}, ${c.change}]: reached by ${c.reach || "?"}`);
  }
  lines.push("", "Members:");
  for (const m of idx.members) {
    const bits = [m.role === "parent" ? "the parent" : "a workstream"];
    if ((m.owns || []).length) bits.push("owns " + m.owns.map(c => c.glob).join(", "));
    if ((m.contracts || []).length) bits.push("provides " + m.contracts.join("; "));
    if ((m.consumes || []).length) bits.push("consumes " + m.consumes.join("; "));
    lines.push(`- ${m.slug}: ${bits.join(" · ")}`);
  }
  return lines.join("\n") + "\n";
}

// `deliver` for a parent with review.family: once every member is done, one
// lookout review per member (<parent>-family-<member>: its work since its first
// increment's start sha, at its root, with the family context), and the parent
// is done only when every one passes. Returns the exit code.
function familyDeliver(st, spec) {
  const slug = st.slug;
  const idx = familyOf(slug) || die(`${slug} sets review.family but has no live family index — re-render it`);
  // A child still in its own delivery phase is not done: its own delivery
  // review comes first. The parent is the one in delivery now. A closed
  // member is skipped (closing a plan is setting it aside), and said so.
  const closed = idx.members.filter(m => { const s = readState(m.slug); return s && s.phase === "closed"; }).map(m => m.slug);
  const notDone = idx.members.filter(m => {
    const s = readState(m.slug);
    if (!s) return true;
    if (s.phase === "done" || s.phase === "closed") return false;
    const incs = s.increments || [];
    return !(incs.length && incs.every(i => i.status === "done") && (m.role === "parent" || s.phase !== "delivery"));
  }).map(m => m.slug);
  if (notDone.length)
    die(`the family review waits for every member to finish: ${notDone.join(", ")} not done yet\n` +
      `deliver refused: family not done (${notDone.join(", ")})`);
  const ctx = path.join(PLANS_DIR, `${slug}.family-context.md`);
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(ctx, familyContext(spec, idx));
  const pol = reviewPolicy(slug);
  const spawn = [], blocked = [], passed = [], problems = [];
  if (closed.length) say(`family review of ${slug}: skipping closed member(s) ${closed.join(", ")}`);
  for (const m of idx.members.filter(x => !closed.includes(x.slug))) {
    const id = `${slug}-family-${m.slug}`;
    const ms = readState(m.slug);
    const sha = (((ms && ms.increments) || [])[0] || {}).startSha || "";
    if (!m.root || !fs.existsSync(m.root)) { problems.push(`${m.slug}: its root is gone (${m.root || "none"})`); continue; }
    if (!sha) { problems.push(`${m.slug}: its first increment has no recorded start sha to review from`); continue; }
    let g = runLookout(["gate", id], { cwd: m.root });
    if (g.missing) die(LOOKOUT_MISSING);
    if (g.code === 3) {
      const r = runLookout(["open", "--id", id, "--title", `${slug} family review · ${m.slug}`,
        "--plan", m.slug, "--inc", "all", "--base", sha, "--at", m.root, "--context-file", ctx, "--no-open",
        ...pol.flags], { cwd: m.root });
      if (!r.ok) { problems.push(`${m.slug}: lookout open failed — ${r.out.split("\n")[0]}`); continue; }
      spawn.push(id);
    } else if (g.code === 0) passed.push(id);
    else blocked.push(`${id} (${g.out.split("\n")[0]})`);
  }
  say(`family review of ${slug}: ${passed.length} passed, ${spawn.length} awaiting a reviewer, ${blocked.length} blocked` +
    (problems.length ? `, ${problems.length} cannot open` : ""));
  for (const p of problems) say("  ✗ " + p);
  for (const b of blocked) say("  ✗ " + b + " — fix, lookout address, then deliver again");
  if (spawn.length) {
    say("next: spawn ONE fresh reviewer subagent per review, whose prompt is the output of");
    for (const id of spawn) say(`  lookout prompt ${id}`);
    say(`then: deep-plan deliver ${slug}` + (pol.agent ? "\n(this plan lets the agent close findings too)" : ""));
  }
  if (problems.length || blocked.length || spawn.length) {
    if (spawn.length) say(`review: spawn a reviewer — lookout prompt ${spawn[0]}`);
    else console.error(`deliver refused: the family review is open on ${problems.length + blocked.length} member(s)`);
    return 1;
  }
  st.phase = "done";
  log1(st, `deliver: the family review passed for every member (${passed.join(", ")}); the gate retires`);
  writeState(st); rerenderWorking(slug);
  say(`delivered ${slug} — the family review passed for all ${passed.length} members; plan complete`);
  return 0;
}

// Run lookout with args; { ok, out } — never throws.
function runLookout(args, { cwd } = {}) {
  const root = lookoutRoot();
  if (!root) return { ok: false, out: LOOKOUT_MISSING, missing: true };
  const r = spawnSync(process.execPath, [path.join(root, "lookout.mjs"), ...args],
    { encoding: "utf8", cwd: cwd || process.cwd(), timeout: 180000 });
  return { ok: r.status === 0, code: r.status, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

// Each deliverable's checks as render resolved them: declared checks, with a
// named recipe bound to the config its files land on; then every default
// recipe whose match covers its files, inferred; then the legacy fields. The
// resolution reads the repo's recipe files, so it happens once, at render, and
// lives in state — surfaces re-render from the stored list (rehydrate stays
// byte-identical) and `check run` executes exactly what was reviewed.
function resolvePlanChecks(spec, root) {
  const R = resolver(root);
  const errs = [];
  const bind = (c, r) => ({ ...c, recipe: r.key, hash: r.hash, source: r.source,
    exec: { tier: r.tier, cwd: path.posix.join(r.project || ".", r.cwd), timeout: r.timeout, steps: r.steps,
      ...(r.brief ? { brief: r.brief } : {}),
      ...(r.scripts && r.scripts.length ? { scripts: r.scripts.map(f => path.posix.join(r.project || ".", r.cwd, f)) } : {}) } });
  const lists = (spec.deliverables || []).map((d, i) => {
    const label = `deliverable ${i + 1} ("${d.title}")`;
    const rows = (d.files || []).map(f => R.file(f)).filter(r => !r.outside);
    // A check may name any recipe available where the deliverable's files
    // land, match aside — naming one is the author choosing it. With no
    // config under any of its files, the root's.
    const dirs = [...new Set(rows.filter(r => r.config)
      .map(r => path.dirname(path.dirname(path.join(R.root, r.config)))))];
    const nameable = new Map();
    for (const dir of dirs.length ? dirs : [R.root]) for (const r of R.available(dir)) nameable.set(r.key, r);
    const out = [];
    for (const c of specChecks(d)) {
      if (c.kind === "review") { out.push(reviewCheck(c, spec.slug, i + 1)); continue; }
      if (!c.recipe) { out.push(c); continue; }
      const hits = [...nameable.values()].filter(r => r.key === c.recipe || r.id === c.recipe);
      if (hits.length === 1) out.push(bind(c, hits[0]));
      else if (!hits.length)
        errs.push(`${label} check "${c.id}": no recipe "${c.recipe}" where its files land — ` +
          "`deep-plan verify resolve <file>` lists what is there");
      else errs.push(`${label} check "${c.id}": recipe "${c.recipe}" is ambiguous here (` +
        `${hits.map(h => h.key).join(", ")}) — name one by its key`);
    }
    const named = new Set(out.map(c => c.recipe).filter(Boolean));
    const ids = new Set(out.map(c => c.id));
    for (const row of rows) for (const r of row.recipes) {
      if (!r.default || named.has(r.key)) continue;
      named.add(r.key);
      let id = r.key;
      for (let k = 2; ids.has(id); k++) id = `${r.key}-${k}`;
      ids.add(id);
      out.push(bind({ id, kind: r.kind, name: r.name, inferred: true }, r));
    }
    // The increments the human chose for a lookout review at planning time
    // (`review.increments`) carry a review check, as if each declared one.
    const chosen = spec.review && spec.review.increments;
    if (!out.some(c => c.kind === "review") && (chosen === "all" || (Array.isArray(chosen) && chosen.includes(i + 1)))) {
      let id = "review-code-review";
      for (let k = 2; ids.has(id); k++) id = `review-code-review-${k}`;
      ids.add(id);
      out.push(reviewCheck({ id, kind: "review", name: "code review", chosen: true }, spec.slug, i + 1));
    }
    // Old plans are not grandfathered: an increment nothing can prove is a
    // finding, and the author either names the proof or says why there is none.
    if (!out.length && !(typeof d.waiver === "string" && d.waiver.trim()))
      errs.push(`${label} has no checks. Declare one in "checks", add a default recipe whose match ` +
        "covers its files (`deep-plan verify resolve <file>` shows what applies), or write a " +
        "\"waiver\" saying why nothing can prove it");
    return out;
  });
  for (const e of R.errors()) errs.push(`recipe config ${e}`);
  return { lists, errs };
}

// The resolved lists ride beside the spec object rather than inside it, so
// the spec archived on the keys tree stays exactly what the author wrote.
const RESOLVED = new WeakMap();
function planChecks(spec, i) {
  return ((RESOLVED.get(spec) || [])[i]) ?? specChecks((spec.deliverables || [])[i]);
}
// For every re-render that does not resolve (rehydrate, the approved
// snapshot, export): the list as stored at the last render.
function checksFromState(spec, st) {
  RESOLVED.set(spec, (spec.deliverables || []).map((d, i) => {
    const inc = ((st && st.increments) || []).find(x => x.n === i + 1);
    if (!inc || !inc.checks || typeof inc.checks !== "object") return null;
    return Object.entries(inc.checks).filter(([, v]) => !v.retired).map(([id, v]) => checkMeta(id, v));
  }));
  return spec;
}

// The markdown subset checkLinesMd writes — **bold** and `code` — as HTML,
// escaped first. Bold is never read inside code: a glob's `**` stays literal.
function mdInline(s) {
  return esc(s).split(/(`[^`]+`)/).map(seg =>
    seg.length > 1 && seg.startsWith("`") && seg.endsWith("`")
      ? `<code>${seg.slice(1, -1)}</code>`
      : seg.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")).join("");
}

function checksHtml(list, waiver) {
  if (!list.length) return waiver ? `<p class="dim">checks: none — waived: ${esc(waiver)}</p>` : "";
  return `<p class="dim">checks — <code>done</code> is gated on these:</p><ul class="dim">` +
    list.map(c => {
      const { head, lines } = checkLinesMd(c);
      return `<li>${mdInline(head)}${lines.map(l => `<br>${mdInline(l)}`).join("")}</li>`;
    }).join("") + "</ul>";
}

// ---------------------------------------------------------------- render

// The plan's ADRs: flagged decisions resolved to a destination and preseeded
// number at RENDER time, so the human reviews where each record will land,
// not just its text. Stored in state (st.adrs) — surfaces re-render from the
// stored resolution, keeping rehydrate byte-identical even if the repo's ADR
// tree moves underneath; apply re-checks numbering and says so on drift.
function planAdrs(spec, root) {
  const entries = adrEntries(spec);
  if (!entries.length) return [];
  const config = loadAdrConfig(root);
  const files = (spec.deliverables || []).flatMap(d => d.files || []);
  const { dir, source } = resolveAdrDir(root, config, files);
  const dirAbs = path.join(root, dir);
  const base = nextNumber(dirAbs, config.numberScan);
  // The one way this goes silently wrong: the folder is full of ADRs the scan
  // does not recognise, so "next number" is 1 and apply writes a second ADR 1
  // beside the real one. Say it at render, while the plan is still being read.
  const miss = adrScanReport(dirAbs, config.numberScan);
  if (miss) {
    console.error(`  ⚠ adr: ${dir} holds ${miss.total} .md file(s) and the numbering scan matched none of them`);
    console.error(`        e.g. ${miss.examples.join(", ")}`);
    console.error(`        numbering therefore restarts at 1. Set numberScan in .seamux/adr.json to match.`);
  }
  return entries.map((e, i) => ({
    n: i + 1, decision: e.decision, dir, source,
    number: base + i, file: adrFileName(base + i, e.decision, config.filePattern),
    applied: "",
  }));
}

function adrDraftText(spec, root, adrInfo) {
  const entry = adrEntries(spec)[adrInfo.n - 1];
  return renderAdr(entry, loadAdrConfig(root), { number: adrInfo.number, root });
}

function mdPlan(spec, adrs = []) {
  const L = [];
  L.push(`# ${spec.title}`, "", `> plan \`${spec.slug}\` — generated by deep-plan; edit the spec and re-render, never this file.`, "");
  L.push("## Context", "", spec.context, "");
  // Non-goals sit before the decisions on purpose: the cheapest way to review a
  // plan is to find out first what it is deliberately NOT doing, and a reader
  // who learns that only at the end has already argued with the wrong plan.
  if ((spec.nonGoals || []).length) {
    L.push("## Non-goals", "");
    for (const g of spec.nonGoals) L.push(`- ${typeof g === "string" ? g : g.nonGoal || JSON.stringify(g)}`);
    L.push("");
  }
  if ((spec.decisions || []).length) {
    L.push("## Decisions", "");
    for (const d of spec.decisions) L.push(`- **${d.decision}** — ${d.why}`);
    L.push("");
  }
  if ((spec.workstreams || []).length) {
    L.push("## Workstreams", "");
    for (const w of spec.workstreams) L.push(`- **${w.slug}** — ${workstreamLine(w)}`);
    L.push("");
  }
  if ((spec.contracts || []).length) {
    L.push("## Contracts", "");
    for (const c of spec.contracts) {
      L.push(`- **${c.surface}** — ${c.kind}, ${c.scope}, ${c.change}` +
        (c.waiver ? ` (waiver: ${c.waiver})` : ""));
      L.push(`  reach: ${c.reach}  \n  decision: ${c.decisionRef}`);
    }
    L.push("");
  }
  if (adrs.length) {
    L.push("## ADRs (applied after the alignment check, by `deep-plan adr apply`)", "");
    const entries = adrEntries(spec);
    for (const a of adrs) {
      const e = entries[a.n - 1] || {};
      L.push(`### ADR ${a.n}: ${e.decision}`, "",
        `destination: \`${a.dir}/${a.file}\` (${a.source})`, "",
        `consequences: ${(e.adr || {}).consequences || ""}`, "");
    }
  }
  if ((spec.verifiedFacts || []).length) {
    L.push("## Verified facts", "");
    for (const f of spec.verifiedFacts) L.push(`- ${f.claim}  \n  evidence: \`${f.evidence}\``);
    L.push("");
  }
  if ((spec.risks || []).length) {
    L.push("## Risks (uncited claims live here)", "");
    for (const r of spec.risks) L.push(`- ${riskLine(r)}`);
    L.push("");
  }
  const _ob = spec.observability || {};
  if ((_ob.existing || []).length || (_ob.gaps || []).length) {
    L.push("## Observability", "");
    for (const e of _ob.existing || [])
      L.push(`- [${e.kind || "?"}] ${e.name || ""}` + (e.ref ? `  \n  ref: \`${e.ref}\`` : ""));
    if ((_ob.gaps || []).length) {
      L.push("", "Gaps this plan fills:", "");
      for (const g of _ob.gaps || []) L.push(`- ${typeof g === "string" ? g : g.gap || ""}`);
    }
    L.push("");
  }
  for (const dg of spec.diagrams || []) {
    L.push(`## ${dg.question}`, "");
    if (dg.simple) L.push("Overview:", "", "```mermaid", String(dg.simple).trim(), "```", "", "Detailed:", "");
    L.push("```mermaid", dg.mermaid.trim(), "```", "");
  }
  L.push("## Increments", "");
  (spec.deliverables || []).forEach((d, i) => {
    L.push(`### ${i + 1}. ${d.title}`, "", d.body || "");
    if ((d.files || []).length) L.push("", "Files: " + d.files.map(f => "`" + f + "`").join(", "));
    // Per-deliverable verification is not a duplicate of the plan-wide list: it
    // is how you check THIS increment, which is what someone reviewing one
    // increment in isolation needs.
    // Every check gates `done`, whatever its kind; per-deliverable
    // `verification` strings are among them, as manual checks.
    const checks = planChecks(spec, i);
    if (checks.length) {
      L.push("", "Checks — `done` is gated on these:", "");
      for (const c of checks) {
        const { head, lines } = checkLinesMd(c);
        L.push(`- ${head}`, ...lines.map(l => `  - ${l}`));
      }
    } else if (d.waiver) L.push("", `Checks: none — waived: ${d.waiver}`);
    if ((d.commits || []).length) {
      L.push("", "Commits:", "");
      for (const c of d.commits) L.push(commitLine(c));
    }
    L.push("");
  });
  if ((spec.verification || []).length) {
    L.push("## Verification", "");
    for (const v of spec.verification) L.push("- " + v);
    L.push("");
  }
  if ((spec.commits || []).length) {
    L.push("## Commits", "");
    for (const c of spec.commits) L.push(commitLine(c));
    L.push("");
  }
  return L.join("\n");
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// Put the pinned bundle at MERMAID_HOME. Bytes come from a local copy that
// already matches the pin (a checkout's vendor/, the old skills copy), else from
// the CDN through curl, which keeps this synchronous for the renderers that call
// it. DEEP_PLAN_MERMAID_SRC replaces the download with a local file, for the
// probe. Anything that fails the sha256 check is deleted, never installed.
// Returns { ok, how } or { ok: false, why }.
function fetchMermaid() {
  for (const c of mermaidCandidates()) {
    if (c === MERMAID_HOME || !fs.existsSync(c)) continue;
    try {
      if (sha256File(c) === MERMAID_SHA256) {
        fs.mkdirSync(VENDOR_DIR, { recursive: true });
        fs.copyFileSync(c, MERMAID_HOME);
        return { ok: true, how: "copied from " + c };
      }
    } catch { /* unreadable candidate: try the next */ }
  }
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const tmp = MERMAID_HOME + ".part-" + process.pid;
  const src = process.env.DEEP_PLAN_MERMAID_SRC;
  if (src) {
    try { fs.copyFileSync(src, tmp); } catch (e) { return { ok: false, why: "could not read " + src }; }
  } else {
    const r = spawnSync("curl", ["-fsSL", MERMAID_URL, "-o", tmp], { encoding: "utf8" });
    if (r.error || r.status !== 0) {
      fs.rmSync(tmp, { force: true });
      return { ok: false, why: "could not download " + MERMAID_URL + (r.stderr ? ": " + r.stderr.trim() : "") };
    }
  }
  const got = sha256File(tmp);
  if (got !== MERMAID_SHA256) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, why: `the download failed the sha256 check (got ${got.slice(0, 12)}…, pinned ${MERMAID_SHA256.slice(0, 12)}…); nothing installed` };
  }
  fs.renameSync(tmp, MERMAID_HOME);
  return { ok: true, how: "fetched mermaid " + MERMAID_VERSION };
}

function mermaidB64() {
  // The validator degrades to a documented "skipped" sentinel when the bundle
  // is missing; render cannot, because a surface with no diagram engine is not
  // a surface. A plugin install starts without it, so the first render fetches
  // it. If that fails too, refuse legibly: a bare readFileSync here once handed
  // a fresh clone an ENOENT stack trace, which reads as a broken tool rather
  // than a missing 3 MB file.
  let file = mermaidPath();
  if (!file) {
    const f = fetchMermaid();
    if (!f.ok) {
      die("vendor/mermaid.min.js is missing, so no diagram can be inlined, and fetching it failed:\n" +
          "  " + f.why + "\n" +
          "  Run `deep-plan setup` (it fetches the pinned build and verifies its sha256),\n" +
          "  or put mermaid " + MERMAID_VERSION + " at " + MERMAID_HOME);
    }
    file = MERMAID_HOME;
    try { writeEnginePointer(); } catch { /* the pointer catches up on the next run */ }
  }
  return fs.readFileSync(file).toString("base64");
}

// ---------------------------------------------------------------- engine pointer

function engineVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, ".claude-plugin", "plugin.json"), "utf8")).version || "dev"; }
  catch { return "dev"; }
}

// One key per line (JSON.stringify's two-space form) is part of the contract:
// the ~/.local/bin shim reads "root" with sed. Written only when the content
// changes, so the hundreds of runs a session makes cost one read each.
// The old ~/.claude/skills copy never writes it: that copy is the fallback the
// pointer exists to supersede, and naming it would only hide the plugin.
function writeEnginePointer() {
  if (!process.env.DEEP_PLAN_ENGINE_FILE &&
      HERE === path.join(os.homedir(), ".claude", "skills", "deep-plan")) return null;
  const m = mermaidPath();
  const body = JSON.stringify({ root: HERE, version: engineVersion(), ...(m ? { mermaid: m } : {}) }, null, 2) + "\n";
  let cur = null;
  try { cur = fs.readFileSync(ENGINE_FILE, "utf8"); } catch { /* first write */ }
  if (cur === body) return body;
  fs.mkdirSync(path.dirname(ENGINE_FILE), { recursive: true });
  const tmp = ENGINE_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, ENGINE_FILE);
  return body;
}

// `deep-plan setup`: everything a plugin install cannot ship. The bundle (into
// the data tree, pinned), the pointer, and the shim that gives a human shell
// and the cmux app a `deep-plan` command. Safe to re-run; --force refetches a
// bundle that does not match the pin.
function setup(force) {
  let bad = 0;
  if (fs.existsSync(MERMAID_HOME) && !force) {
    if (sha256File(MERMAID_HOME) === MERMAID_SHA256) say(`  ok    mermaid ${MERMAID_VERSION} in place (sha256 verified)`);
    else say(`  warn  ${MERMAID_HOME} is not the pinned ${MERMAID_VERSION}; keeping it (setup --force refetches)`);
  } else {
    if (force) fs.rmSync(MERMAID_HOME, { force: true });
    const f = fetchMermaid();
    if (f.ok) say(`  ok    ${f.how} -> ${MERMAID_HOME} (sha256 verified)`);
    else { console.error(`  FAIL  mermaid: ${f.why}`); bad++; }
  }
  const body = writeEnginePointer();
  say(body ? `  ok    engine pointer -> ${ENGINE_FILE} (root ${HERE})`
           : `  skip  engine pointer: this is the old ~/.claude/skills copy`);
  const shimSrc = path.join(HERE, "lib", "deep-plan.shim");
  const shim = path.join(SHIM_DIR, "deep-plan");
  const want = fs.readFileSync(shimSrc, "utf8");
  // A symlink here (an old install linked the name straight at an engine) is
  // replaced, never written through: writing through it would overwrite the
  // engine it points at with this shim.
  try { if (fs.lstatSync(shim).isSymbolicLink()) fs.unlinkSync(shim); } catch { /* absent */ }
  let have = null;
  try { have = fs.readFileSync(shim, "utf8"); } catch { /* not installed */ }
  if (have === want) say(`  ok    shim in place: ${shim}`);
  else {
    fs.mkdirSync(SHIM_DIR, { recursive: true });
    fs.writeFileSync(shim, want, { mode: 0o755 });
    fs.chmodSync(shim, 0o755);
    say(`  ok    ${have === null ? "installed" : "updated"} the shim: ${shim}`);
  }
  if (!(process.env.PATH || "").split(":").includes(SHIM_DIR))
    say(`  warn  ${SHIM_DIR} is not on PATH; add it to call \`deep-plan\` from your own shell`);
  if (bad) process.exit(1);
}

// One <head> shared by both HTML surfaces. Mermaid is inlined as base64 so the
// file works opened from disk; the intent server swaps that src for its cached
// /mermaid.min.js on the way out (regex: src="data:text/javascript;base64,…").
function htmlHead(title, b64) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<script>
// Theme, resolved before first paint so neither mode flashes the other:
// the saved choice wins, else the OS preference.
(function () {
  var t = "";
  try { t = localStorage.getItem("dp-theme") || ""; } catch (e) {}
  if (!t) t = (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
})();
</script>
<script src="data:text/javascript;base64,${b64}"></script>
<style>
:root{--bg:#2d353b;--fg:#d3c6aa;--dim:#859289;--faint:#5c6a72;--line:#3d484d;--line2:#4f5b58;--accent:#7fbbb3;
--good:#a7c080;--warn:#dbbc7f;--bad:#e67e80;--mark:#dbbc7f;--card:#3a464c;--card2:#343f44;--card3:#424e54;
--hl:rgba(167,192,128,.26);--hl-on:rgba(167,192,128,.5);--find:rgba(219,188,127,.32);--find-on:#e69875;
--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
:root[data-theme="light"]{--bg:#fdf6e3;--fg:#5c6a72;--dim:#829181;--faint:#a6b0a0;--line:#e6e2cc;--line2:#c9cdb6;--accent:#3a94c5;
--good:#8da101;--warn:#c08000;--bad:#f85552;--mark:#a77c00;--card:#efebd4;--card2:#f4f0d9;--card3:#e6e2cc;
--hl:rgba(141,161,1,.2);--hl-on:rgba(141,161,1,.38);--find:rgba(223,160,0,.28);--find-on:#f57d26}
body{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
-webkit-font-smoothing:antialiased;max-width:860px;margin:0 auto;padding:28px 20px 80px}
h1{font:600 22px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;letter-spacing:-.01em}
h2{font:700 12.5px/1.3 system-ui;letter-spacing:.12em;text-transform:uppercase;color:var(--mark);
margin-top:2.4em;border-bottom:1px solid var(--line);padding-bottom:7px}
h3{font-size:15px}
a{color:var(--accent)}
code{background:var(--card);border-radius:4px;padding:1px 5px;font:12.5px var(--mono)}
.dim{color:var(--dim)}.mermaid{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}
.inc{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.inc .st{float:right;font-size:12px;padding:2px 8px;border-radius:10px;border:1px solid var(--line)}
.st-done{color:var(--good)}.st-working{color:var(--accent)}.st-authorized{color:var(--warn)}
.st-blocked{color:var(--bad)}.st-pending{color:var(--dim)}
.dp-act{margin-right:6px;background:var(--card3);color:var(--fg);border:1px solid var(--line);
border-radius:6px;padding:3px 12px;cursor:pointer}
.dp-act[disabled]{opacity:.45;cursor:default}
.dp-path{color:var(--fg);cursor:default}
.dp-live .dp-path{color:var(--accent);text-decoration:underline;cursor:pointer}
.dp-path.dp-bad{color:var(--bad)}
.dp-adr-edit,.dp-adr-promote{background:var(--card3);color:var(--fg);border:1px solid var(--line);
border-radius:6px;padding:2px 10px;cursor:pointer;font:inherit;font-size:12px}
.dp-adr-promote[data-staged="1"]{color:var(--good);border-color:var(--good)}
.dp-adr-editor{border:1px dashed var(--line);border-radius:8px;padding:10px;margin:8px 0}
.dp-adr-editor label{display:block;font-size:12px;color:var(--dim);margin:6px 0}
.dp-adr-editor input,.dp-adr-editor textarea{display:block;width:100%;box-sizing:border-box;
background:transparent;color:inherit;border:1px solid var(--dim);border-radius:4px;padding:6px;font:inherit}
.dp-adr-preview{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:2px 12px;margin-top:8px}
.dp-adr-edit:focus-visible,.dp-adr-promote:focus-visible,.dp-adr-editor input:focus-visible,
.dp-adr-editor textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.q{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.q .opt{display:block;margin:4px 0 4px 12px}
label.auto{position:fixed;top:10px;right:64px;font-size:12px;color:var(--dim)}
#dp-mode{position:fixed;top:8px;right:14px;background:var(--card3);color:var(--fg);
border:1px solid var(--line);border-radius:6px;padding:4px 10px;font:inherit;font-size:13px;
cursor:pointer;min-height:32px}
#dp-mode:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style></head><body>
<button id="dp-mode" type="button" aria-label="switch between light and dark mode">◐</button>
<script>
document.getElementById("dp-mode").addEventListener("click", function () {
  var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  try { localStorage.setItem("dp-theme", next); } catch (e) {}
  // Reload rather than restyle in place: mermaid bakes its theme into the
  // rendered SVGs at boot, and a reload of a static page is instant.
  location.reload();
});
</script>`;
}

// Theme chosen at boot to match the page (see the head script) — mermaid
// bakes colors into its SVGs, so this is decided before startOnLoad runs.
const MERMAID_BOOT = `<script>mermaid.initialize({startOnLoad:true,
theme:document.documentElement.getAttribute("data-theme")==="light"?"default":"dark"});</script>`;

// One section, a card per diagram: an optional plain-words overview beside
// the detailed drawing, with zoom and a full-screen view (lib/surface.mjs).
function diagramsHtml(spec) {
  const ds = spec.diagrams || [];
  return ds.length ? `<h2>Diagrams</h2>\n` + ds.map(diagramCardHtml).join("\n") : "";
}

// ADR cards: title, resolved destination (and why that destination), the
// record's fields. `withNotes` adds a review-surface comment box per card —
// the human's channel for "wrong home" or "wrong consequences", riding the
// same copy-back blob as everything else.
function adrsHtml(spec, adrs, withNotes) {
  if (!adrs.length) return "";
  const entries = adrEntries(spec);
  const cards = adrs.map(a => {
    const e = entries[a.n - 1] || {};
    const adr = e.adr || {};
    const alts = (adr.alternatives || []).map(x => `<li>${esc(x)}</li>`).join("");
    return `<div class="inc" id="adr-${a.n}">
<span class="st st-${a.applied ? "done" : "pending"}">${a.applied ? "applied" : "draft"}</span>
<b>ADR ${a.n}: ${esc(e.decision)}</b>
<p class="dim">destination: <span class="dp-path" data-file="${esc(a.dir + "/" + a.file)}"><code>${esc(a.dir + "/" + a.file)}</code></span> (${esc(a.source)})</p>
<p><span class="dp-md">${esc(adr.context || e.why)}</span></p>
<p><b>Consequences:</b> <span class="dp-md">${esc(adr.consequences || "")}</span></p>
${alts ? `<p class="dim">alternatives considered:</p><ul>${alts}</ul>` : ""}
${withNotes ? `<p><button type="button" class="dp-adr-edit" data-n="${a.n}" aria-expanded="false" aria-controls="dp-adr-ed-${a.n}">Edit</button></p>
<div class="dp-adr-editor" id="dp-adr-ed-${a.n}" hidden>
<label>decision<input class="dp-adr-field" data-n="${a.n}" data-field="decision" value="${esc(e.decision || "")}"></label>
<label>context<textarea class="dp-adr-field" data-n="${a.n}" data-field="context" rows="3">${esc(adr.context || e.why || "")}</textarea></label>
<label>consequences<textarea class="dp-adr-field" data-n="${a.n}" data-field="consequences" rows="3">${esc(adr.consequences || "")}</textarea></label>
<label>alternatives (one per line)<textarea class="dp-adr-field" data-n="${a.n}" data-field="alternatives" rows="2">${esc((adr.alternatives || []).join("\n"))}</textarea></label>
<p class="dim">preview — markdown subset: # ## ###, **bold**, *italic*, \`code\`, \`\`\`fences\`\`\`, lists, [links](https://…). Edits are staged; <b>Copy</b> below puts them in the paste-back.</p>
<div class="dp-adr-preview" data-n="${a.n}"></div>
</div>
<textarea class="dp-note" data-section="adr ${a.n}" rows="1" placeholder="comment on this ADR — text, consequences, or destination (optional)" aria-label="comment on ADR ${a.n}"></textarea>` : ""}
</div>`;
  }).join("\n");
  return `<h2>ADRs</h2>
<p class="dim">drafted with the plan; applied into the repo by <code>deep-plan adr apply</code>
only after the alignment check passes.</p>
${cards}`;
}

// Risk list items, shared by the review/working body and the shareable
// artifact page. A dispositioned risk shows what was decided about it.
//
// On editing surfaces each risk is a card: the four dispositions as radios, a
// deliverable select and a ticket box for mitigate, and a note. Nothing is
// written by the page — a changed card stages one `- [risk N] <disposition>:
// <payload>` line into the copy-back blob (dpRiskLines), and the session
// applies it as a spec edit. Defaults ride as data attributes so only real
// changes are staged, and the surface on disk stays byte-identical.
function risksHtml(spec, withNotes = false) {
  const titles = (spec.deliverables || []).map(d => d.title || "");
  return (spec.risks || []).map((r, i) => {
    const v = riskView(r);
    const o = typeof r === "string" ? {} : r;
    const shown = v.disposition
      ? ` <span class="dim">— ${esc(v.disposition)}${v.payload ? ": " + esc(v.payload) : ""}</span>` : "";
    if (!withNotes) return `<li>${esc(v.risk)}${shown}</li>`;
    const n = i + 1;
    const radios = RISK_DISPOSITIONS.map(d =>
      `<label class="dp-risk-opt"><input type="radio" name="dp-risk-${n}" value="${d}"${v.disposition === d ? " checked" : ""}> ${d}</label>`).join(" ");
    const opts = `<option value="">— a deliverable in this plan —</option>` + titles.map(t =>
      `<option value="${esc(t)}"${o.deliverableRef === t ? " selected" : ""}>${esc(t)}</option>`).join("");
    return `<li class="dp-risk" data-n="${n}" data-disposition="${esc(v.disposition)}" data-payload="${esc(v.payload)}">${esc(v.risk)}${shown}
<div class="dp-risk-ctl">${radios}
<select class="dp-risk-deliv" aria-label="deliverable that mitigates risk ${n}">${opts}</select>
<input class="dp-risk-ticket" type="text" value="${esc(o.ticketRef || "")}" placeholder="or a filed ticket (URL or key)" aria-label="ticket that mitigates risk ${n}">
<input class="dp-risk-note" type="text" value="${esc(o.note || "")}" placeholder="note (what settles a spike; context for a ticket)" aria-label="note on risk ${n}">
</div></li>`;
  }).join("");
}

// One workstream in words, for the md plan and the HTML surfaces alike. Drawn
// from the spec only, so rehydrate stays byte-identical.
function workstreamLine(w) {
  const claim = c => typeof c === "string" ? c : `${c.repo}:${c.glob}`;
  const parts = [];
  if ((w.owns || []).length) parts.push("owns " + w.owns.map(claim).join(", "));
  if ((w.shared || []).length) parts.push("shared " + w.shared.map(claim).join(", "));
  if ((w.contracts || []).length) parts.push("contracts " + w.contracts.join("; "));
  if ((w.consumes || []).length) parts.push("consumes " + w.consumes.join("; "));
  if ((w.after || []).length) parts.push("after increment " + w.after.join(", "));
  if (w.repo) parts.push("repo " + w.repo);
  return parts.join(" · ") || "no claims declared";
}

// `link` makes each child's name a link to its own plan page (served
// /plan/<slug>, or the file beside this one): the review and working pages
// have them, the shareable artifact page does not, its readers have no files.
function workstreamsHtml(spec, link = false) {
  const name = w => link
    ? `<a class="dp-fam-link" href="${esc(w.slug)}.working.html" data-plan="${esc(w.slug)}">${esc(w.slug)}</a>`
    : esc(w.slug);
  const items = (spec.workstreams || []).map(w =>
    `<li><b>${name(w)}</b> <span class="dim">— ${esc(workstreamLine(w))}</span></li>`).join("");
  const served = link && items ? `
<script>
if (/^https?:/.test(location.protocol)) document.querySelectorAll(".dp-ws .dp-fam-link").forEach(function (a) {
  a.setAttribute("href", "/plan/" + encodeURIComponent(a.getAttribute("data-plan")));
});
</script>` : "";
  return items ? `<h2>Workstreams</h2>
<p class="dim">child plans this family coordinates. Their own deliverable files are claims too; an edit into a sibling's claim is allowed and noted, never refused.</p>
<ul class="dp-ws">${items}</ul>${served}` : "";
}

// Contracts card list, shared by the review/working body and the shareable
// artifact page — declared shape changes stay visible wherever the plan goes.
function contractsHtml(spec) {
  const items = (spec.contracts || []).map(c =>
    `<li><b>${esc(c.surface || "")}</b> <span class="dim">[${esc(c.kind || "?")} · ${esc(c.scope || "?")} · ${esc(c.change || "?")}]</span><br>` +
    `reach: ${esc(c.reach || "")} <span class="dim">— decision: ${esc(c.decisionRef || "")}` +
    (c.waiver ? ` · waiver: ${esc(c.waiver)}` : "") + `</span></li>`).join("");
  return items ? `<h2>Contracts</h2>
<p class="dim">declared shape changes — schemas, APIs, signatures. Reach is scouted; the decision is the human's.</p>
<ul>${items}</ul>` : "";
}

// The in-page markdown subset + ADR editor. No library, by explicit decision:
// dpMd is escape-first (~40 lines) covering headings, bold, italic, inline
// code, fences, lists and http(s) links — everything else stays literal text.
// It runs client-side only (display upgrade at load + live preview), so the
// bytes on disk never change and rehydrate stays byte-identical. Edits are
// STAGED: window.dpAdrLines() serializes changed fields and staged promotions
// as blob lines (newlines \n-escaped — the versioned line protocol, ADR 0002),
// and both surfaces' copy buttons append them to their paste-back.
const DP_EDITOR_JS = `
<script>
function dpMd(src) {
  var escf = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var inline = function (s) {
    s = s.replace(/\\x60([^\\x60]+)\\x60/g, "<code>$1</code>");
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
    s = s.replace(/\\*([^*]+)\\*/g, "<i>$1</i>");
    return s;
  };
  var lines = escf(src).split("\\n"), out = [], para = [], list = null, fence = null;
  var closePara = function () { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  var closeList = function () { if (list) { out.push("</" + list + ">"); list = null; } };
  for (var i = 0; i < lines.length; i++) {
    var L = lines[i];
    if (fence !== null) {
      if (/^\\x60\\x60\\x60/.test(L)) { out.push("<pre><code>" + fence.join("\\n") + "</code></pre>"); fence = null; }
      else fence.push(L);
      continue;
    }
    if (/^\\x60\\x60\\x60/.test(L)) { closePara(); closeList(); fence = []; continue; }
    var h = L.match(/^(#{1,3})\\s+(.*)/);
    if (h) { closePara(); closeList(); var n = h[1].length + 1; out.push("<h" + n + ">" + inline(h[2]) + "</h" + n + ">"); continue; }
    var ul = L.match(/^[-*]\\s+(.*)/), ol = L.match(/^\\d+[.)]\\s+(.*)/);
    if (ul || ol) {
      closePara();
      var want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push("<" + want + ">"); list = want; }
      out.push("<li>" + inline((ul || ol)[1]) + "</li>");
      continue;
    }
    if (!L.trim()) { closePara(); closeList(); continue; }
    para.push(L);
  }
  if (fence !== null) out.push("<pre><code>" + fence.join("\\n") + "</code></pre>");
  closePara(); closeList();
  return out.join("\\n");
}
(function () {
  // Display upgrade: ADR prose renders as markdown at load; disk bytes untouched.
  document.querySelectorAll(".dp-md").forEach(function (el) { el.innerHTML = dpMd(el.textContent); });
  var preview = function (n) {
    var parts = [];
    document.querySelectorAll('.dp-adr-field[data-n="' + n + '"]').forEach(function (f) {
      var v = f.value.trim();
      if (v) parts.push("### " + f.getAttribute("data-field") + "\\n\\n" + v);
    });
    var pv = document.querySelector('.dp-adr-preview[data-n="' + n + '"]');
    if (pv) pv.innerHTML = dpMd(parts.join("\\n\\n"));
  };
  document.querySelectorAll(".dp-adr-edit").forEach(function (b) {
    b.addEventListener("click", function () {
      var ed = document.getElementById("dp-adr-ed-" + b.getAttribute("data-n"));
      ed.hidden = !ed.hidden;
      b.setAttribute("aria-expanded", ed.hidden ? "false" : "true");
      if (!ed.hidden) preview(b.getAttribute("data-n"));
    });
  });
  document.querySelectorAll(".dp-adr-field").forEach(function (f) {
    f.addEventListener("input", function () { preview(f.getAttribute("data-n")); });
  });
  document.querySelectorAll(".dp-adr-promote").forEach(function (b) {
    b.addEventListener("click", function () {
      var on = b.getAttribute("data-staged") === "1";
      b.setAttribute("data-staged", on ? "" : "1");
      b.textContent = on ? "add an ADR" : "ADR staged \\u2713 (copy below)";
    });
  });
  window.dpAdrLines = function () {
    var lines = [];
    document.querySelectorAll(".dp-adr-field").forEach(function (f) {
      if (f.value !== f.defaultValue)
        lines.push("- [adr " + f.getAttribute("data-n") + " \\u00B7 " + f.getAttribute("data-field") + "] " +
          f.value.replace(/\\\\/g, "\\\\\\\\").replace(/\\n/g, "\\\\n"));
    });
    document.querySelectorAll('.dp-adr-promote[data-staged="1"]').forEach(function (b) {
      lines.push("- [decision: " + b.getAttribute("data-decision") + "] promote to ADR \\u2014 seed the adr block from its why");
    });
    return lines;
  };

  // Risk cards: the mitigate controls show only while mitigate is picked, and
  // a card stages a line only when its disposition or payload actually moved.
  function riskPayload(card) {
    var picked = card.querySelector('input[type=radio]:checked');
    var d = picked ? picked.value : "";
    var deliv = card.querySelector(".dp-risk-deliv").value;
    var ticket = card.querySelector(".dp-risk-ticket").value.trim();
    var note = card.querySelector(".dp-risk-note").value.trim();
    var payload = "";
    if (d === "mitigate") payload = deliv || (ticket ? "ticket " + ticket + (note ? " \\u2014 " + note : "") : "");
    else if (note) payload = note;
    return { d: d, payload: payload };
  }
  function riskSync(card) {
    var d = riskPayload(card).d;
    card.classList.toggle("dp-risk-mitigate", d === "mitigate");
  }
  document.querySelectorAll(".dp-risk").forEach(function (card) {
    riskSync(card);
    card.addEventListener("change", function () { riskSync(card); });
  });
  window.dpRiskLines = function () {
    var lines = [];
    document.querySelectorAll(".dp-risk").forEach(function (card) {
      var p = riskPayload(card);
      if (!p.d) return;
      if (p.d === card.getAttribute("data-disposition") && p.payload === card.getAttribute("data-payload")) return;
      lines.push("- [risk " + card.getAttribute("data-n") + "] " + p.d + (p.payload ? ": " + p.payload : ""));
    });
    return lines;
  };
})();
</script>`;

// Risk card styling, shared by the review and working stylesheets.
const DP_RISK_CSS = `.dp-risk-ctl{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin:6px 0 10px;font-size:.9em}
.dp-risk-opt{cursor:pointer;white-space:nowrap}
.dp-risk-deliv,.dp-risk-ticket,.dp-risk-note{background:transparent;color:inherit;border:1px solid var(--dim,#888);
  border-radius:4px;padding:4px 6px;font:inherit;font-size:.95em;max-width:100%}
.dp-risk-note{flex:1 1 240px}
.dp-risk-deliv,.dp-risk-ticket{display:none}
.dp-risk-mitigate .dp-risk-deliv,.dp-risk-mitigate .dp-risk-ticket{display:inline-block}`;

function commonBody(spec, adrs = [], withNotes = false) {
  // Evidence that reads as a repo path becomes a click target: the served
  // working surface opens it in VS Code at that line (same handler and same
  // crew-code-open hand-off as the increments' file lists and the Dock's
  // Cmd-click). A line RANGE goes to its first line — that is all --goto
  // takes. Prose evidence ("ccusage output inspected…") stays plain text.
  const evRef = ev => {
    const m = /^([A-Za-z0-9_][\w./-]*?)(?::(\d+)(?:-\d+)?)?$/.exec(ev);
    if (!m || !/[/.]/.test(m[1])) return `<code>${esc(ev)}</code>`;
    const target = m[2] ? `${m[1]}:${m[2]}` : m[1];
    return `<code class="dp-path" data-file="${esc(target)}">${esc(ev)}</code>`;
  };
  const facts = (spec.verifiedFacts || []).map(f =>
    `<li>${esc(f.claim)} <span class="dim">— ${evRef(f.evidence)}</span></li>`).join("");
  // Un-flagged decisions carry a promote button on editing surfaces: it
  // stages a "- [decision: <name>] promote to ADR" line into the same blob,
  // and the session seeds the adr block from the decision's why.
  const decs = (spec.decisions || []).map(d =>
    `<li><b>${esc(d.decision)}</b> — ${esc(d.why)}` +
    (withNotes && !d.adr ? ` <button type="button" class="dp-adr-promote" data-decision="${esc(d.decision)}">add an ADR</button>` : "") +
    `</li>`).join("");
  const risks = risksHtml(spec, withNotes);
  // Contracts sit right after Decisions: shape changes are the review's
  // front-and-center item, with scouted reach and the owning decision.
  const contractsSection = contractsHtml(spec);
  // Observability block — advisory by design: rendered when present, never
  // required. `existing` cites what the read-only sweep found (monitors,
  // dashboards, runbooks); `gaps` is what the plan fills, each via a
  // deliverable that emits an importable definition or manual steps — never
  // a live API write (SKILL.md carries the discipline).
  const ob = spec.observability || {};
  const obExisting = (ob.existing || []).map(e =>
    `<li><span class="dim">[${esc(e.kind || "?")}]</span> ${esc(e.name || "")}` +
    (e.ref ? ` <span class="dim">— <code>${esc(e.ref)}</code></span>` : "") + "</li>").join("");
  const obGaps = (ob.gaps || []).map(g =>
    `<li>${esc(typeof g === "string" ? g : g.gap || "")}</li>`).join("");
  const obSection = (obExisting || obGaps) ? `<h2>Observability</h2>
${obExisting ? `<p class="dim">exists today (read-only sweep):</p><ul>${obExisting}</ul>` : ""}
${obGaps ? `<p class="dim">gaps this plan fills:</p><ul>${obGaps}</ul>` : ""}` : "";
  // Non-goals before decisions: the cheapest way to review a plan is to learn
  // first what it is deliberately not doing. A reader who finds that out at the
  // end has already argued with a plan nobody proposed.
  const nonGoals = (spec.nonGoals || []).map(g =>
    `<li>${esc(typeof g === "string" ? g : g.nonGoal || "")}</li>`).join("");
  const commits = (spec.commits || []).map(c => commitLi(c)).join("");
  return `<h1>${esc(spec.title)}</h1>
<p class="dim">plan <code>${esc(spec.slug)}</code></p>
<h2>Context</h2><p>${esc(spec.context).replace(/\n\s*\n/g, "</p><p>")}</p>
${nonGoals ? `<h2>Non-goals</h2><ul>${nonGoals}</ul>` : ""}
${decs ? `<h2>Decisions</h2><ul>${decs}</ul>` : ""}
${workstreamsHtml(spec, true)}
${contractsSection}
${facts ? `<h2>Verified facts</h2><ul>${facts}</ul>` : ""}
${risks ? `<h2>Risks</h2><ul>${risks}</ul>` : ""}
${commits ? `<h2>Commits</h2><ul>${commits}</ul>` : ""}
${obSection}
${adrsHtml(spec, adrs, withNotes)}
${diagramsHtml(spec)}
${withNotes ? DP_EDITOR_JS : ""}`;
}

// ---------------------------------------------------------------- quiz.txt
//
// The review page is the quiz's home, but it is an HTML file: a terminal
// session cannot read it, and `grade`'s interactive prompt asks for "q1 = "
// without showing the question. So the same quiz goes out as plain text, in the
// SAME shuffled order as the page and the key — it reads `shuffled` for that
// reason, and any other order would grade correct answers as wrong.
//
// Letters, not the older engine's numbers: this engine's `grade` takes q1=a, so
// the file ends with the exact command to run rather than a format to translate.
function quizTxt(spec) {
  const qs = spec.quiz || [];
  const L = [`Alignment check — ${spec.title}`, `plan: ${spec.slug}`, ""];
  if (!qs.length) {
    L.push("This plan carries no quiz.", "");
    return L.join("\n");
  }
  qs.forEach((q, qi) => {
    L.push(`Q${qi + 1}. [${q.id}] ${q.prompt}`);
    shuffled(q.options, spec.slug + ":" + q.id)
      .forEach((o, i) => L.push(`   ${String.fromCharCode(97 + i)}) ${o.v}`));
    L.push("");
  });
  L.push("Answer every question, then run:", "",
    `  deep-plan grade ${spec.slug} ` + qs.map(q => `${q.id}=<letter>`).join(" "), "",
    "A wrong answer names the decision to reopen — it is the plan that is being",
    "checked, not you. On a TTY, `deep-plan grade " + spec.slug + "` prompts instead,",
    "so the letters stay out of your shell history.", "");
  return L.join("\n");
}

// ---------------------------------------------------------------- widget
//
// An HTML FRAGMENT for a rich client's inline-widget surface (the desktop and
// web clients inject `sendPrompt`). Deliberately different from review.html on
// three counts: it is a fragment with no <head>, it styles itself from the
// host's CSS variables rather than this engine's palette, and answering it
// sends a prompt back to the session instead of copying a blob to the clipboard.
//
// Mermaid is the vendored copy inlined as a data URI, exactly as every other
// surface here does it — not a CDN import. A widget that needs the network to
// draw its diagrams is a widget that renders blank on a train.
function widgetHtml(spec, b64) {
  const qs = spec.quiz || [];
  const diagrams = spec.diagrams || [];
  // Screen-reader summary first, before any visual content: the host renders
  // this inline in a conversation, so it needs to announce what it is.
  const summary = `Plan review for ${esc(spec.title)}: ${diagrams.length} diagram` +
    `${diagrams.length === 1 ? "" : "s"}` +
    (qs.length ? ` and a ${qs.length}-question alignment check.` : ".");
  const diagBlocks = diagrams.map((dg, i) =>
    `<figure class="dpfig"><figcaption class="dpcap">${esc(dg.question)}</figcaption>
<pre class="mermaid" id="dpd-${i}">${esc(dg.mermaid.trim())}</pre></figure>`).join("\n");
  const quizBlocks = qs.map((q, qi) => {
    const opts = shuffled(q.options, spec.slug + ":" + q.id).map((o, i) => {
      const letter = String.fromCharCode(97 + i);
      return `<label class="dpo"><input type="radio" name="${esc(q.id)}" value="${letter}">` +
        `<span>${letter}) ${esc(o.v)}</span></label>`;
    }).join("");
    return `<fieldset class="dpq"><legend>Question ${qi + 1} of ${qs.length}</legend>
<p class="dps">${esc(q.prompt)}</p>${opts}</fieldset>`;
  }).join("\n");
  return `<h2 class="dpsr">${summary}</h2>
<style>
.dpsr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.dpwrap{padding:1rem 0}
.dpfig{margin:0 0 var(--gap-md,16px)}
.dpcap{font-size:13px;color:var(--text-muted,#666);margin-bottom:6px}
.mermaid{background:var(--surface-1,#f6f6f6);border:1px solid var(--border,#ddd);
  border-radius:var(--radius,8px);padding:12px;overflow-x:auto}
.dpq{border:1px solid var(--border,#ddd);border-radius:12px;padding:var(--pad-md,14px);
  margin:0 0 var(--gap-md,16px);background:var(--surface-1,#fafafa)}
.dpq legend{font-size:13px;color:var(--text-muted,#666);padding:0 6px}
.dps{font-size:15px;line-height:1.6;margin:0 0 12px;color:var(--text-primary,#111)}
.dpo{display:flex;gap:10px;align-items:flex-start;padding:9px 11px;
  border:1px solid var(--border,#ddd);border-radius:var(--radius,8px);margin-bottom:7px;
  cursor:pointer;background:var(--surface-2,#fff)}
.dpo:hover{border-color:var(--border-strong,#999)}
.dpo input{margin-top:3px;flex:none}
.dpo span{font-size:14px;line-height:1.5;color:var(--text-primary,#111)}
.dpbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:4px}
.dpgo{font:500 14px var(--font-sans,system-ui);padding:8px 16px;
  border-radius:var(--radius,8px);border:1px solid var(--border-strong,#999);
  background:var(--surface-2,#fff);color:var(--text-primary,#111);cursor:pointer}
.dpgo[disabled]{cursor:default;opacity:.6}
</style>
<div class="dpwrap">
${diagBlocks}
${quizBlocks}
${qs.length ? `<div class="dpbar">
<button class="dpgo" id="dpgo" type="button">Send answers for grading</button>
<span id="dpmeta" style="font-size:13px;color:var(--text-secondary,#555)">0 of ${qs.length} answered</span>
<span id="dperr" style="font-size:13px;color:var(--text-danger,#b00)" role="status"></span>
</div>` : ""}
</div>
${diagrams.length ? `<script src="data:text/javascript;base64,${b64}"></script>
<script>mermaid.initialize({startOnLoad:true,theme:
  window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"default"});</script>` : ""}
${qs.length ? `<script>
(function(){
var ids=${JSON.stringify(qs.map(q => q.id))};
var meta=document.getElementById("dpmeta"),err=document.getElementById("dperr"),go=document.getElementById("dpgo");
function picked(){return ids.filter(function(id){
  return document.querySelector('input[name="'+id+'"]:checked');});}
document.addEventListener("change",function(){
  meta.textContent=picked().length+" of "+ids.length+" answered";err.textContent="";});
go.addEventListener("click",function(){
  if(picked().length<ids.length){err.textContent="Answer all "+ids.length+" first";return;}
  // Letters, and the command spelled out: the session runs \`grade\`, so the
  // prompt carries something runnable rather than a payload to interpret.
  var parts=ids.map(function(id){
    return id+"="+document.querySelector('input[name="'+id+'"]:checked').value;});
  sendPrompt("Run: deep-plan grade ${esc(spec.slug)} "+parts.join(" "));
  go.textContent="Sent";go.disabled=true;
});
})();
</script>` : ""}
`;
}

function reviewHtml(spec, b64, adrs = []) {
  // Quiz options shuffled per-slug; the shuffled correct position lives in the
  // key file, never in this page.
  const qs = (spec.quiz || []).map((q, qi) => {
    const sh = shuffled(q.options, spec.slug + ":" + q.id);
    const opts = sh.map((o, i) => {
      const L = String.fromCharCode(97 + i);
      return `<label class="opt"><input type="radio" name="dp-q-${esc(q.id)}" value="${L}"> ${L}) ${esc(o.v)}</label>`;
    }).join("");
    return `<div class="q" data-qid="${esc(q.id)}" role="radiogroup" aria-labelledby="dp-p-${esc(q.id)}">
<b id="dp-p-${esc(q.id)}">${qi + 1}. ${esc(q.prompt)}</b>${opts}
<div class="dim">id: <code>${esc(q.id)}</code></div></div>`;
  }).join("\n");
  const verif = (spec.verification || []).map(v => `<li><code>${esc(v)}</code></li>`).join("");
  const incs = (spec.deliverables || []).map((d, i) =>
    `<div class="inc" id="inc-${i + 1}"><b>${i + 1}. ${esc(d.title)}</b><p>${esc(d.body || "")}</p>
${fileTreeHtml(d.files)}
${checksHtml(planChecks(spec, i), d.waiver)}
${(d.commits || []).length ? `<ul class="dim">${d.commits.map(c => commitLi(c)).join("")}</ul>` : ""}
<textarea class="dp-note" data-section="increment ${i + 1}" rows="1" placeholder="comment on this increment (optional)" aria-label="comment on increment ${i + 1}"></textarea></div>`).join("\n");
  // Everything below is client-side only: selections and comments live in the
  // DOM, nothing is stored or sent anywhere, and the page keeps working over
  // file:// (clipboard falls back to select+execCommand there).
  const COPYBACK = `
<h2>Send it back</h2>
<p class="dim">Highlight any text above — mouse or keyboard — then click the
comment chip, or press <kbd>⌘M</kbd> / <kbd>Ctrl+M</kbd>, to pin a comment to it. It stays
marked where you left it; click the marked text to edit it. Everything here is kept as a draft
until you clear it.</p>
<div id="dp-quotes"></div>
<textarea class="dp-note" data-section="general" rows="2" placeholder="general comments (optional)" aria-label="general comments"></textarea>
<p><button id="dp-copyback" type="button">Copy for session</button>
<span id="dp-copied" class="dim" role="status" aria-live="polite"></span></p>
<script>
(function () {
  var slug = ${JSON.stringify(spec.slug)};
  document.getElementById("dp-copyback").addEventListener("click", function () {
    var parts = ["deep-plan review \\u2014 " + slug];
    var answers = [];
    document.querySelectorAll(".q[data-qid]").forEach(function (q) {
      var picked = q.querySelector("input:checked");
      if (picked) answers.push(q.getAttribute("data-qid") + "=" + picked.value);
    });
    if (answers.length) parts.push("deep-plan grade " + slug + " " + answers.join(" "));
    var notes = [];
    document.querySelectorAll(".dp-note").forEach(function (t) {
      if (t.value.trim()) notes.push("- [" + t.getAttribute("data-section") + "] " + t.value.trim());
    });
    if (window.dpAdrLines) notes = notes.concat(window.dpAdrLines());
    if (window.dpRiskLines) notes = notes.concat(window.dpRiskLines());
    if (notes.length) parts.push("comments:\\n" + notes.join("\\n"));
    var blob = parts.join("\\n");
    var done = function () {
      document.getElementById("dp-copied").textContent = "copied \\u2713 \\u2014 paste it into the session";
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(blob).then(done, function () { fallback(blob, done); });
    } else fallback(blob, done);
  });
  function fallback(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); }
    catch (e) { document.getElementById("dp-copied").textContent = "copy failed \\u2014 select and copy by hand:"; ta.remove(); alert(text); return; }
    ta.remove();
  }

  // Highlight-to-comment lives in lib/surface.mjs (SURFACE_JS): a comment
  // stays marked where it was pinned, and its card is a .dp-note like the
  // boxes above, so this button carries it with no extra wiring.
})();
</script>`;
  return htmlHead(spec.title + " — review", b64) + SURFACE_CSS + surfaceOpen(spec.slug, "review") + `<style>
label.opt{cursor:pointer;padding:3px 0}
.dp-note{display:block;width:100%;box-sizing:border-box;margin:8px 0;background:transparent;
  color:inherit;border:1px solid var(--dim,#888);border-radius:4px;padding:6px;font:inherit}
${DP_RISK_CSS}
#dp-copyback{background:var(--accent,#46f);color:var(--bg);border:0;border-radius:6px;font-weight:600;
  padding:10px 16px;font:inherit;cursor:pointer;min-height:44px}
kbd{font:inherit;font-size:.85em;border:1px solid var(--dim,#888);border-radius:3px;padding:0 4px}
.opt input:focus-visible,#dp-copyback:focus-visible,#dp-hl-add:focus-visible,
.dp-note:focus-visible,.dp-x:focus-visible{outline:2px solid var(--accent,#46f);outline-offset:2px}
</style>` + commonBody(spec, adrs, true) + `
<h2>Increments</h2>${incs}
${verif ? `<h2>Verification</h2><ul>${verif}</ul>` : ""}
<h2>Alignment check</h2>
<p class="dim">Pick an answer per question, add comments where you have them, then
<b>Copy for session</b> below puts one paste-back on your clipboard — the slug, a ready
<code>deep-plan grade</code> line, and your comments. A wrong answer means the plan
and your model of it disagree — and either one may be the broken one.</p>
${qs}
${COPYBACK}
${surfaceClose()}${SURFACE_JS}</body></html>`;
}

// Annotations pulled back from the plan's published artifact, if any. The AGENT
// fetches them (Artifact read_db --out_dir); this CLI only renders what is on
// disk — the renderer keeps its no-network invariant.
const ANNOT_DIR = process.env.DEEP_PLAN_ANNOT_DIR ||
  path.join(DATA_ROOT, "deep-plan", "annotations");

function readAnnotations(slug) {
  const dir = path.join(ANNOT_DIR, slug, "annotations");
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith(".json")); }
  catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      out.push(j.data || j);
    } catch { /* skip malformed */ }
  }
  out.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  return out;
}

// Overview diagrams are presentation, not plan: adding one (deep-plan
// overviews) neither drifts the approved snapshot nor stales a published copy.
// A spec without any hashes exactly as it did before overviews existed.
function specHash(spec) {
  const plain = spec.diagrams ? { ...spec, diagrams: spec.diagrams.map(({ simple, ...d }) => d) } : spec;
  return crypto.createHash("sha256").update(JSON.stringify(plain)).digest("hex").slice(0, 16);
}

function annotationsSection(spec, st) {
  const anns = readAnnotations(st.slug);
  const bits = [];
  if (st.artifact && st.artifact.url) {
    const stale = st.artifact.spec_hash && st.artifact.spec_hash !== specHash(spec);
    bits.push(`<h2>Shared for annotation</h2>
<p class="dim">artifact: <a href="${esc(st.artifact.url)}" style="color:var(--accent)">${esc(st.artifact.url)}</a>${
      stale ? ' · <span style="color:var(--warn)">published copy is STALE — spec changed since publish; re-export and republish</span>' : ""}</p>`);
  }
  if (anns.length) {
    const open = anns.filter(a => !a.resolved);
    bits.push(`<h2>Annotations (${open.length} open / ${anns.length})</h2><ul>` +
      anns.map(a =>
        `<li class="${a.resolved ? "dim" : ""}">${a.resolved ? "✓ " : "• "}<b>${esc(a.author_name || a.author_id || "?")}</b>` +
        (a.increment ? ` <span class="dim">on increment ${esc(String(a.increment))}</span>` : "") +
        ` — ${esc(a.text || "")}</li>`).join("") + "</ul>");
  }
  return bits.join("\n");
}

// A commit entry is either a bare sha/subject string or {sha, subject, ref}.
// Accept both: the field was authored by hand on real specs and both shapes
// occur, and refusing one of them would be a floor nobody asked for.
function commitLi(c) {
  if (typeof c === "string") return `<li><code>${esc(c)}</code></li>`;
  const sha = c.sha ? `<code>${esc(String(c.sha).slice(0, 12))}</code> ` : "";
  return `<li>${sha}${esc(c.subject || c.ref || "")}</li>`;
}
const commitLine = c => typeof c === "string"
  ? `- \`${c}\``
  : `- ${c.sha ? "`" + String(c.sha).slice(0, 12) + "` " : ""}${c.subject || c.ref || ""}`;

const CHECK_MARK = { pass: "✅", fail: "❌", pending: "⏳", running: "🔄", "needs-variant": "✋", "needs-value": "✋", stale: "⚠️" };
// The same verdicts drawn for the pages, which carry no emoji. The terminal
// keeps CHECK_MARK.
const glyphSvg = inner => `<svg class="dp-mark" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true">${inner}</svg>`;
const RING = c => `<circle cx="6" cy="6" r="4.6" fill="none" stroke="${c}" stroke-width="1.4"/>`;
const CHECK_GLYPH = {
  pass: glyphSvg(`<circle cx="6" cy="6" r="5.2" fill="var(--good)"/><path d="M3.5 6.2l1.7 1.7 3.3-3.5" fill="none" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`),
  fail: glyphSvg(`<circle cx="6" cy="6" r="5.2" fill="var(--bad)"/><path d="M4.2 4.2l3.6 3.6M7.8 4.2l-3.6 3.6" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round"/>`),
  pending: glyphSvg(RING("var(--faint)")),
  running: glyphSvg(RING("var(--accent)") + `<path d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" fill="var(--accent)"/>`),
  "needs-variant": glyphSvg(RING("var(--warn)") + `<circle cx="6" cy="6" r="1.8" fill="var(--warn)"/>`),
  "needs-value": glyphSvg(RING("var(--warn)") + `<circle cx="6" cy="6" r="1.8" fill="var(--warn)"/>`),
  stale: glyphSvg(`<path d="M6 1.2l5 9.3H1z" fill="var(--warn)"/><path d="M6 4.6v2.6M6 8.9v.1" stroke="var(--bg)" stroke-width="1.4" stroke-linecap="round"/>`),
};

// Each check with its verdict, and — while it is outstanding — what it runs.
// Showing the detail only while it matters keeps a finished increment short.
function checksRow(inc, slug = "") {
  const all = Object.entries(checksOf(inc)).filter(([, v]) => !v.retired);
  if (!all.length) return "";
  const agg = checksAggregate(inc);
  const items = all.map(([id, v]) => {
    const st = v.status || "pending";
    const detail = st === "pass" ? "" :
      checkLinesMd({ id, ...v }).lines.map(l => `<br>${mdInline(l)}`).join("");
    // A check the Dock can act on (a browser run, a claim that asks) carries
    // its address; the served page's plan.js adds run, open tab, the live
    // filmstrip and the picker. On disk the row is just text.
    const steps = (v.exec && v.exec.steps) || [];
    const browser = steps.some(s => s.kind === "browser"), asks = steps.some(s => s.kind === "claim" && s.ask);
    const live = (browser || asks) && v.recipe
      ? ` class="dp-check" data-n="${inc.n}" data-id="${esc(id)}" data-status="${esc(st)}"` +
        `${browser ? ' data-browser="1"' : ""}${asks ? ' data-asks="1"' : ""}` : "";
    const extra = (v.exec && v.exec.brief ? `<br><span class="dp-brief">brief: ${esc(v.exec.brief)}</span>` : "") +
      (v.ask && (st === "running" || st === "needs-value") ? `<br><span class="dp-ask">asks: ${esc(v.ask.question)}</span>` : "");
    return `<li${live}>${CHECK_GLYPH[st] || ""} ${esc(st)} · [${esc(v.kind || "?")}${v.system ? " · " + esc(v.system) : ""}] ` +
      `${esc(v.name || "")} <code>${esc(id)}</code>` +
      // A served working page reaches the review page on the same server.
      (v.synth === "review" && slug ? ` · <a href="/review/${esc(slug)}-inc${inc.n}">open the review</a>` : "") +
      (v.note ? ` — ${esc(v.note)}` : "") + extra + detail + "</li>";
  }).join("");
  return `<p class="dim">checks: ${CHECK_GLYPH[agg] || ""} ${esc(agg)}</p><ul class="dim">${items}</ul>`;
}

// The family this plan belongs to, under the title: the parent and every
// sibling with its phase and progress, what this plan owns, and what it waits
// on. Names link to each plan's own page (served /plan/<slug>, or the file).
// One increment of a family member in a few characters, for `family status`
// and the working page's strip: its status, then its checks and its lookout
// review as glyphs, then who gave its go.
const FAM_STATUS = { done: "✓", working: "●", authorized: "▶", pending: "·", blocked: "✗" };
const FAM_VERDICT = { pass: "✓", fail: "✗", pending: "…", running: "…", "needs-variant": "…", "needs-value": "…" };
function famIncParts(i) {
  return {
    status: FAM_STATUS[i.status] || "·",
    checks: i.checks && i.checks !== "n/a" ? `${FAM_VERDICT[i.checks] || "…"} checks` : "",
    review: i.review ? `${FAM_VERDICT[i.review] || "…"} review` : "",
    by: i.by ? `go by ${i.by}` : "",
  };
}

function familyStripHtml(slug) {
  const idx = familyOf(slug);
  const f = idx && familyRow(idx, slug);
  if (!f) return "";
  const items = f.members.map(m => {
    const me = m.slug === slug;
    const name = me ? `<b>${esc(m.slug)}</b>` :
      `<a class="dp-fam-link" href="${esc(m.slug)}.working.html" data-plan="${esc(m.slug)}">${esc(m.slug)}</a>`;
    const incs = (m.increments || []).map(i => {
      const p = famIncParts(i);
      return `<span class="dp-fam-inc dp-fam-${esc(i.status)}" title="${esc(i.title)} — ${esc(i.status)}">` +
        `${p.status} ${i.n}${[p.checks, p.review, p.by].filter(Boolean).map((x, k) => `${k ? " ·" : ""} <span class="dim">${esc(x)}</span>`).join("")}</span>`;
    }).join("");
    return `<li class="dp-fam-m${me ? " dp-fam-me" : ""}"><span class="dim">${m.role === "parent" ? "parent" : "child"}</span> ${name}` +
      ` <span class="dim">· ${esc(m.phase)} · ${m.done}/${m.total} done${m.role === "child" && m.go === "parent" ? " · parent goes" : ""}</span>` +
      (m.held ? `<div class="dp-fam-wait">held by the parent: ${esc(m.held)}</div>` : "") +
      (incs ? `<div class="dp-fam-incs">${incs}</div>` : "") + `</li>`;
  }).join("");
  const owns = f.owns.length ? `<p class="dim">this plan owns ${f.owns.map(g => `<code>${esc(g)}</code>`).join(" ")}</p>` : "";
  const waits = f.waitingOn.length
    ? `<p class="dp-fam-wait">waits on ${f.waitingOn.map(w => `<a class="dp-fam-link" href="${esc(f.parent)}.working.html" data-plan="${esc(f.parent)}">${esc(f.parent)}</a> increment ${w.n}${w.title ? ` (${esc(w.title)})` : ""}, ${esc(w.status)}`).join("; ")}</p>`
    : (f.after.length ? `<p class="dim">its parent's increments ${f.after.join(", ")} are done: free to go</p>` : "");
  return `<section class="dp-fam" aria-label="plan family">
<style>
.dp-fam{border:1px solid var(--line,#8884);border-radius:8px;padding:8px 12px;margin:4px 0 14px}
.dp-fam ul{list-style:none;margin:4px 0;padding:0;display:flex;flex-direction:column;gap:6px}
.dp-fam-incs{display:flex;flex-wrap:wrap;gap:2px 14px;margin:2px 0 0 1.2em;font-size:.92em}
.dp-fam-inc{white-space:nowrap}
.dp-fam-done{opacity:.75}
.dp-fam p{margin:4px 0}
.dp-fam-wait{color:var(--warn,#c80)}
.dp-fam-link{color:inherit}
</style>
<p class="dim">family <b>${esc(f.parent)}</b> · ${f.members.filter(m => m.phase === "done" || (m.total && m.done === m.total)).length}/${f.members.length} plans done</p>
<ul>${items}</ul>${owns}${waits}
<script>
if (/^https?:/.test(location.protocol)) document.querySelectorAll(".dp-fam-link").forEach(function (a) {
  a.setAttribute("href", "/plan/" + encodeURIComponent(a.getAttribute("data-plan")));
});
</script>
</section>`;
}

function workingHtml(spec, st, b64) {
  const rows = (st.increments || []).map(inc => {
    const d = (spec.deliverables || [])[inc.n - 1] || {};
    const files = fileTreeHtml(d.files);
    const acts = ["go", "start", "done", "block", "reset"].map(a =>
      `<button class="dp-act" data-a="${a}" data-n="${inc.n}" disabled ` +
      `title="${a} increment ${inc.n} — available when served">${a}</button>`).join("");
    // The verdict belongs beside the status, not in a section of its own: it is
    // a precondition on THIS increment's `done`, and a reader deciding whether
    // the increment is finished needs both in one glance.
    const checks = checksRow(inc, st.slug) || (d.waiver ? `<p class="dim">checks: none — waived: ${esc(d.waiver)}</p>` : "");
    // Per-deliverable commits: the record of what actually landed for this one.
    const dcommits = (d.commits || []).map(c => commitLi(c)).join("");
    return `<div class="inc" id="inc-${inc.n}" data-status="${esc(inc.status)}"><span class="st st-${esc(inc.status)}">${esc(inc.status)}</span>
<b>${inc.n}. ${esc(inc.title)}</b>
<p>${esc(d.body || "")}</p>
${files}
${dcommits ? `<ul class="dim">${dcommits}</ul>` : ""}
${checks}
<p>${acts}</p></div>`;
  }).join("\n");
  const g = gateView(st);
  const logRows = (st.log || []).slice(-12).reverse().map(l =>
    `<li class="dim">${esc(new Date(l.at).toISOString().slice(0, 16).replace("T", " "))} — ${esc(l.what)}</li>`).join("");
  return htmlHead(spec.title, b64) + SURFACE_CSS + surfaceOpen(spec.slug, "working") + `
<label class="auto"><input type="checkbox" id="dp-auto" checked> auto-refresh</label>
<style>
.dp-note{display:block;width:100%;box-sizing:border-box;margin:8px 0;background:transparent;
  color:inherit;border:1px solid var(--dim,#888);border-radius:4px;padding:6px;font:inherit}
${DP_RISK_CSS}
#dp-amend-copy{background:var(--accent,#46f);color:var(--bg);border:0;border-radius:6px;font-weight:600;
  padding:10px 16px;font:inherit;cursor:pointer;min-height:44px}
#dp-amend-copy:focus-visible,.dp-note:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>` +
    commonBody(spec, st.adrs || [], true).replace(/(<p class="dim">plan <code>[^\n]*<\/p>)/, (m) => m + "\n" + familyStripHtml(spec.slug)) + `
${st.approved ? `<p class="dim">approved snapshot: <span class="dp-path" data-file="${esc(st.approved.path)}"><code>${esc(st.approved.path)}</code></span>${
      st.approved.spec_hash !== specHash(spec) ? ' · <span style="color:var(--warn)">the live plan has DRIFTED from the approved snapshot (spec amended since grade-pass)</span>' : ""}</p>` : ""}
<h2>Gate</h2><p>${g.allow ? CHECK_GLYPH.pass + " open" : CHECK_GLYPH.fail + " shut"} <span class="dim">— ${esc(g.why)}</span>
<span class="dim">· root <code>${esc(st.root || "?")}</code> · phase ${esc(st.phase)}</span></p>
<h2>Increments</h2>${rows}
${annotationsSection(spec, st)}
<h2>Amend the plan</h2>
<p class="dim">Discovery amends the spec, not just the code — mid-increment included. Note what
changed (per section above, per ADR card, or generally), then <b>Copy amendments</b> puts one
paste-back on your clipboard; the session applies it as a spec edit and re-renders. Increment
statuses survive a re-render. Highlight any text above and press <kbd>⌘M</kbd> to pin an amendment
to that spot; drafts survive the auto-refresh.</p>
<div id="dp-quotes"></div>
${["context", "decisions", "risks"].map(s =>
  `<textarea class="dp-note" data-section="${s}" rows="1" placeholder="amend ${s} (optional)" aria-label="amend ${s}"></textarea>`).join("\n")}
<textarea class="dp-note" data-section="general" rows="2" placeholder="general amendment (optional)" aria-label="general amendment"></textarea>
<p><button id="dp-amend-copy" type="button">Copy amendments</button>
<span id="dp-amend-done" class="dim" role="status" aria-live="polite"></span></p>
<script>
(function () {
  var slug = ${JSON.stringify(spec.slug)};
  document.getElementById("dp-amend-copy").addEventListener("click", function () {
    var notes = [];
    document.querySelectorAll(".dp-note").forEach(function (t) {
      if (t.value.trim()) notes.push("- [" + t.getAttribute("data-section") + "] " + t.value.trim());
    });
    if (window.dpAdrLines) notes = notes.concat(window.dpAdrLines());
    if (window.dpRiskLines) notes = notes.concat(window.dpRiskLines());
    var blob = "deep-plan amend \\u2014 " + slug + (notes.length ? "\\n" + notes.join("\\n") : "\\n(no notes)");
    var done = function () {
      document.getElementById("dp-amend-done").textContent = "copied \\u2713 \\u2014 paste it into the session";
    };
    var fallback = function () {
      var ta = document.createElement("textarea");
      ta.value = blob; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { alert(blob); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(blob).then(done, fallback);
    else fallback();
  });
})();
</script>
${logRows ? `<h2>Log</h2><ul>${logRows}</ul>` : ""}
${surfaceClose()}${SURFACE_JS}
<script>
// Auto-refresh, armed on the checkbox's change event. The served page injects
// window.__dpChanged (a /plan-stamp probe); on disk there is no probe and the
// timer stays a no-op, so the file never blind-reloads under a reader.
(function(){
  var t = null, box = document.getElementById("dp-auto");
  function tick(){
    // Not under someone mid-comment: the reload would cost them their place.
    if (!window.__dpChanged || (window.dpBusy && window.dpBusy())) return;
    window.__dpChanged(function(moved){ if (moved) location.reload(); });
  }
  function arm(){ if (t) clearInterval(t); t = null;
    if (box.checked) t = setInterval(tick, 4000); }
  box.addEventListener("change", arm);
  arm();
})();
</script></body></html>`;
}

// After a render: write a parent's index and report its overlaps, or refresh
// the family a re-rendered child belongs to (its derived claims may have
// moved). A parent that dropped its workstreams dissolves the family; the old
// index is kept beside, as history, and governs nothing.
function renderFamily(spec, family) {
  if (family) {
    writeIndex(family.index);
    try { pruneControl(family.index); } catch (e) { console.error(`  ⚠ family ${spec.slug}: control.json not pruned (${e.message})`); }
    const kids = family.index.members.filter(m => m.role === "child").map(m => m.slug);
    say(`family ${spec.slug}: ${kids.length} workstream(s) — ${kids.join(", ")}`);
    for (const o of overlaps(family.index)) console.error("  ⚠ overlap: " + o);
    return;
  }
  const own = readIndex(spec.slug);
  if (own && !spec.workstreams) {
    fs.renameSync(indexPath(spec.slug), indexPath(spec.slug).replace(/index\.json$/, "index.dissolved.json"));
    if (fs.existsSync(controlPath(spec.slug)))
      fs.renameSync(controlPath(spec.slug), controlPath(spec.slug).replace(/control\.json$/, "control.dissolved.json"));
    say(`family ${spec.slug}: dissolved (the spec no longer lists workstreams)`);
    return;
  }
  const r = refreshFamilyFor(spec.slug);
  if (!r) return;
  if (r.errors.length) {
    console.error(`  ⚠ family ${r.parent}: not refreshed — re-render the parent to see why:`);
    for (const e of r.errors) console.error("    " + e);
    return;
  }
  say(`family ${r.parent}: claims refreshed`);
  for (const o of overlaps(readIndex(r.parent))) if (o.includes(spec.slug)) console.error("  ⚠ overlap: " + o);
}

async function render(specPath, opts) {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const violations = validate(spec, opts.force);
  // Read-before-plan floor: a deliverable that names an EXISTING file must
  // have a verifiedFact citing it — you cannot plan to edit a file you have
  // not read. Born of the crew-integrations retro: a spec planned "deepen
  // the Jira badges" without anyone opening crew-sync, which already carried
  // batched JQL, key parsing and a status cache. Files that do not exist yet
  // are exempt (they are the plan's output, not its input), and --force
  // remains the say-so-out-loud override.
  // The root this render will record (see State below): --root wins, then the
  // recorded one. Resolving against the recorded root under --root checked a
  // moved plan against the path it was moved away from.
  const prior0 = readState(spec.slug);
  const planRoot = opts.root || (prior0 && prior0.root) ||
    gitRoot(process.cwd()) || process.cwd();
  {
    const root = planRoot;
    const cited = f => (spec.verifiedFacts || []).some(v => {
      const ev = String(v.evidence || "");
      return ev === f || ev.startsWith(f + ":");
    });
    const unread = [];
    (spec.deliverables || []).forEach((d, i) => {
      for (const f of d.files || [])
        if (fs.existsSync(path.join(root, f)) && !cited(f))
          unread.push(`deliverable ${i + 1} ("${d.title}") edits ${f} — no verifiedFact cites it`);
    });
    if (unread.length && !opts.force) {
      console.error("deep-plan: spec refused — files planned but not read:");
      for (const u of unread) console.error("  ✗ " + u);
      console.error("Read each file, cite it (path:line), then re-render. " +
        "A file you have not read is a file you cannot plan.");
      process.exit(1);
    } else if (unread.length) {
      console.error(`deep-plan: --force past ${unread.length} unread file(s) — logged`);
      violations.push(...unread);
    }
  }
  // Checks: resolved against the repo's recipe files, and refused where an
  // increment has none and no waiver, or names a recipe that is not there.
  const { lists: checkLists, errs: checkErrs } = resolvePlanChecks(spec, planRoot);
  if (checkErrs.length && !opts.force) {
    console.error("deep-plan: spec refused — checks:");
    for (const e of checkErrs) console.error("  ✗ " + e);
    process.exit(1);
  } else if (checkErrs.length) {
    console.error(`deep-plan: --force past ${checkErrs.length} check problem(s) — logged`);
    violations.push(...checkErrs);
  }
  RESOLVED.set(spec, checkLists);
  // A parent's family resolves here, before anything is written: a missing
  // child, a child already in another family, or roots that nest would leave
  // the gate and the board unable to say which plan a path belongs to.
  let family = null;
  if (spec.workstreams) {
    family = buildIndex(spec, planRoot);
    if (family.errors.length && !opts.force) {
      console.error("deep-plan: spec refused — family:");
      for (const e of family.errors) console.error("  ✗ " + e);
      process.exit(1);
    } else if (family.errors.length) {
      console.error(`deep-plan: --force past ${family.errors.length} family problem(s) — logged; the index is not written`);
      violations.push(...family.errors);
      family = null;
    }
  }
  // The citations themselves, warn-only — the other direction of the floor
  // above. Code checks that each path:line resolves; with a TypeSafe key one
  // batched request judges whether the cited lines back each claim
  // (lib/evidence.mjs). Warnings never refuse and the gate never hears of
  // them: a TypeSafe result can only add warnings, and a bad citation is
  // review feedback, not a lockout.
  try {
    for (const w of checkEvidence(spec, planRoot))
      console.error("  ⚠ evidence: " + w);
  } catch { /* the check must never break a render */ }
  // Refuse-first extends to the diagrams: parse each with the vendored
  // mermaid before any surface is written — a plan page with a parse error
  // where a drawing should be fails the reader exactly where it matters.
  const diagResults = await validateDiagrams(diagramsForValidation(spec.diagrams));
  const badDiagrams = diagResults.filter(b => b.error !== null);
  if (diagResults.some(b => b.error === null))
    console.error("deep-plan: mermaid validation skipped for some/all diagrams (environment-limited here)");
  if (badDiagrams.length && !opts.force) {
    console.error("deep-plan: spec refused — mermaid will not parse:");
    for (const b of badDiagrams) console.error(`  ✗ ${b.label}: ${b.error}`);
    process.exit(1);
  } else if (badDiagrams.length) {
    console.error(`deep-plan: --force past ${badDiagrams.length} broken diagram(s) — logged`);
  }
  // ADR destinations resolve once, here, and live in state: surfaces and
  // drafts re-render from the stored resolution (rehydrate stays
  // byte-identical); apply re-checks the numbering against the repo. The
  // drafts are filled before anything is written: a house template that is
  // not there refuses the render, not half of it.
  const adrs = planAdrs(spec, planRoot);
  let adrDrafts;
  try { adrDrafts = adrs.map(a => adrDraftText(spec, planRoot, a)); }
  catch (e) { die("spec refused — adr: " + e.message); }
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.mkdirSync(KEYS_DIR, { recursive: true });

  // Archive the spec + answer key on the keys tree, never beside the surfaces.
  const key = {
    slug: spec.slug,
    answers: Object.fromEntries((spec.quiz || []).map(q => {
      const sh = shuffled(q.options, spec.slug + ":" + q.id);
      const pos = sh.findIndex(o => o.i === q.answer);
      return [q.id, { letter: String.fromCharCode(97 + pos), why: q.why, decisionRef: q.decisionRef }];
    })),
    violationsForced: violations,
    // Contract decisions no quiz question covers — grade fails on these.
    uncoveredContracts: [...new Set((spec.contracts || [])
      .map(c => c.decisionRef)
      .filter(ref => !(spec.quiz || []).some(q => q.decisionRef === ref)))],
    // Risks nobody dispositioned — grade fails on these too.
    undispositionedRisks: (spec.risks || []).map(riskView).filter(v => v.undisposed).map(v => v.risk),
  };
  fs.writeFileSync(path.join(KEYS_DIR, spec.slug + ".spec.json"), JSON.stringify(spec, null, 2) + "\n");
  fs.writeFileSync(path.join(KEYS_DIR, spec.slug + ".key.json"), JSON.stringify(key, null, 2) + "\n");

  const b64 = mermaidB64();
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".md"), mdPlan(spec, adrs));
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".review.html"), reviewHtml(spec, b64, adrs));
  const extras = writeSpecArtifacts(spec, b64);
  adrs.forEach((a, i) => fs.writeFileSync(
    path.join(PLANS_DIR, `${spec.slug}.adr${a.n}.md`), adrDrafts[i]));

  // State: an existing root outranks an inferred one; only --root overwrites.
  let st = readState(spec.slug);
  if (!st) {
    st = {
      slug: spec.slug, phase: "review", gate: "increment",
      root: opts.root || gitRoot(process.cwd()) || process.cwd(),
      session: sessionId(),
      increments: [], log: [],
    };
    log1(st, "rendered; alignment check pending");
  } else if (opts.root) {
    st.root = opts.root;
    log1(st, "root set explicitly: " + opts.root);
  }
  // Reconcile increments with deliverables, keeping recorded status.
  //
  // Spread `prev` FIRST so a field this engine does not know about survives a
  // re-render. The previous shape was a whitelist, which is complete for a plan
  // this engine created — it writes nothing else — but silently dropped
  // everything else on a plan that came from anywhere: an older generation's
  // `pr`/`branch`/`head`/`jira`, or anything a future field adds. The owned
  // keys are listed after the spread so the spec still wins on `title` and the
  // defaults still apply.
  const old = new Map((st.increments || []).map(i => [i.n, i]));
  st.increments = (spec.deliverables || []).map((d, i) => {
    const prev = old.get(i + 1) || {};
    return { ...prev,
      n: i + 1, title: d.title, status: prev.status || "pending",
      authorizedAt: prev.authorizedAt || 0, startedAt: prev.startedAt || 0,
      doneAt: prev.doneAt || 0, note: prev.note || "", startSha: prev.startSha || "",
      // `obs` is the pre-checks verdict; reconcileChecks carries it over.
      checks: reconcileChecks(prev, checkLists[i]), obs: undefined };
  });
  // Keep what apply recorded (applied path) for unchanged entries; a spec
  // edit that reorders or reworded a flagged decision re-resolves fresh.
  const oldAdrs = new Map((st.adrs || []).map(a => [a.decision, a]));
  st.adrs = adrs.map(a => {
    const prev = oldAdrs.get(a.decision);
    return prev ? { ...a, number: prev.number, file: prev.file, dir: prev.dir,
      source: prev.source, applied: prev.applied || "" } : a;
  });
  // The plan holds its own sync setting: the spec's share, false when unset.
  st.share = spec.share === undefined ? false : spec.share;
  reopenPhase(st);
  writeState(st);
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".working.html"), workingHtml(spec, st, b64));
  say(`rendered ${spec.slug}: ${PLANS_DIR}/${spec.slug}.md, .review.html, .working.html`);
  renderFamily(spec, family);
  say(`  also: ${extras.join(", ")}`);
  say(`spec + key archived under ${KEYS_DIR} (separate tree, on purpose)`);
  if (st.phase === "review") say("phase: review — the alignment check gates everything.");
}

function rerenderWorking(slug, kin = true) {
  const spec = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, slug + ".spec.json"), "utf8"));
  const st = readState(slug);
  if (!st) return;
  fs.writeFileSync(path.join(PLANS_DIR, slug + ".working.html"), workingHtml(spec, st, mermaidB64()));
  // Each family member's page shows this plan's progress in its strip.
  const idx = kin && familyOf(slug);
  for (const m of (idx && idx.members) || []) {
    if (m.slug === slug) continue;
    try { rerenderWorking(m.slug, false); } catch { /* a member's page is best-effort */ }
  }
}

// The three artifacts that are pure functions of the spec: the widget, the
// text quiz, and the cutover bundle. One writer, called by BOTH `render` and
// `rehydrate`, because two call sites emitting different subsets is the exact
// shape of bug this engine keeps finding in itself — and `rehydrate` is the
// only re-render available for a plan whose spec cannot pass the floors.
function writeSpecArtifacts(spec, b64) {
  const out = [];
  // `render` creates this; `rehydrate` did not, and only ever worked because
  // ~/.claude/plans already exists on a machine that has run the skill once.
  // The writer is shared, so it makes its own directory rather than inheriting
  // one caller's assumption.
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".widget.html"), widgetHtml(spec, b64));
  out.push("widget");
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".quiz.txt"), quizTxt(spec));
  out.push("quiz.txt");

  const dir = path.join(PLANS_DIR, spec.slug + ".cutover");
  fs.mkdirSync(dir, { recursive: true });
  const names = incrementFileNames(spec);
  // Written from the SAME body the other surfaces use, so the epic cannot
  // drift into being a second, staler spelling of the plan.
  fs.writeFileSync(path.join(dir, spec.slug + ".epic.html"),
    epicHtml({ spec, body: commonBody(spec, [], false), b64,
      hasDiagrams: (spec.diagrams || []).length > 0 }));
  names.forEach((name, i) => fs.writeFileSync(path.join(dir, name),
    incrementMd({ spec, index: i, total: names.length, checks: planChecks(spec, i) })));
  fs.writeFileSync(path.join(dir, "README.md"), bundleReadme({ spec, files: names }));
  out.push(`cutover/ (epic + ${names.length} increment${names.length === 1 ? "" : "s"}, no quiz)`);
  return out;
}

function rehydrate(slug, { quiet = false } = {}) {
  const specPath = path.join(KEYS_DIR, slug + ".spec.json");
  if (!fs.existsSync(specPath)) die("no archived spec for " + slug);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const b64 = mermaidB64();
  const st0 = readState(slug);
  checksFromState(spec, st0);
  const adrs = (st0 && st0.adrs) || [];
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  const md = mdPlan(spec, adrs), rv = reviewHtml(spec, b64, adrs);
  const mdP = path.join(PLANS_DIR, slug + ".md"), rvP = path.join(PLANS_DIR, slug + ".review.html");
  const same = (p, s) => fs.existsSync(p) && fs.readFileSync(p, "utf8") === s;
  const okMd = same(mdP, md), okRv = same(rvP, rv);
  fs.writeFileSync(mdP, md); fs.writeFileSync(rvP, rv);
  if (st0 && st0.root) adrs.forEach(a => fs.writeFileSync(
    path.join(PLANS_DIR, `${slug}.adr${a.n}.md`), adrDraftText(spec, st0.root, a)));
  const extras = writeSpecArtifacts(spec, b64);
  rerenderWorking(slug);
  if (quiet) return { md: okMd, review: okRv, missing: missingOverviews(spec).length };
  say(`rehydrated ${slug} — md ${okMd ? "byte-identical" : "REWRITTEN (differs)"}, review ${okRv ? "byte-identical" : "REWRITTEN (differs)"}`);
  say(`  also rewritten: ${extras.join(", ")}`);
}

// ---------------------------------------------------------------- redraw
//
// The migration for a new engine: every plan with an archived spec gets its
// surfaces re-rendered by THIS engine, spec and state untouched. rehydrate is
// the writer (it alone re-renders a spec that no longer passes today's
// floors); redraw only finds the plans and keeps one failure from stopping
// the rest. "Differs" is the expected answer here — the engine moved — so it
// is reported as redrawn, not as a hand edit.
function archivedSlugs() {
  try {
    return fs.readdirSync(KEYS_DIR).filter(n => n.endsWith(".spec.json"))
      .map(n => n.slice(0, -".spec.json".length)).sort();
  } catch { return []; }
}

function missingOverviews(spec) {
  return (spec.diagrams || []).map((d, i) => ({ n: i + 1, question: d.question, has: !!d.simple }))
    .filter(d => !d.has);
}

function redraw(target, { json = false, dry = false } = {}) {
  const slugs = target === "--all" || target === "all" ? archivedSlugs() : [target];
  if (!slugs.length) die("no archived specs under " + KEYS_DIR);
  const rows = [];
  for (const slug of slugs) {
    const specPath = path.join(KEYS_DIR, slug + ".spec.json");
    if (!fs.existsSync(specPath)) { rows.push({ slug, ok: false, error: "no archived spec" }); continue; }
    try {
      const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
      if (dry) { rows.push({ slug, ok: true, dry: true, missing: missingOverviews(spec).length }); continue; }
      rows.push({ slug, ok: true, ...rehydrate(slug, { quiet: true }) });
    } catch (e) {
      rows.push({ slug, ok: false, error: String(e && e.message || e).split("\n")[0] });
    }
  }
  if (json) { say(JSON.stringify(rows, null, 2)); return rows; }
  for (const r of rows) {
    if (!r.ok) { say(`  ✗ ${r.slug}: ${r.error}`); continue; }
    const tail = r.missing ? ` · ${r.missing} diagram${r.missing === 1 ? "" : "s"} without an overview` : "";
    say(`  ${r.dry ? "would redraw" : "redrew"} ${r.slug}${tail}`);
  }
  const need = rows.filter(r => r.ok && r.missing);
  say(`${dry ? "would redraw" : "redrew"} ${rows.filter(r => r.ok).length}/${rows.length} plan(s)` +
    (need.length ? `; ${need.length} lack overview diagrams — \`deep-plan overviews <slug>\` lists them` : ""));
  if (rows.some(r => !r.ok)) process.exitCode = 1;
  return rows;
}

// ---------------------------------------------------------------- overviews
//
// `overviews <slug>` lists a plan's diagrams with their mermaid, for whoever
// drafts the plain-words versions; `overviews <slug> <file.json>` takes
// {"<n>": "<mermaid>"} (or [{n, simple}]), parses each with the vendored
// mermaid, refuses on any error, and only then writes. The archived spec is
// patched, and so is ~/.claude/plans/<slug>.spec.json when it carries the same
// diagram questions, so a later render from the authored file keeps them.
async function overviews(slug, file, { json = false, force = false } = {}) {
  const specPath = path.join(KEYS_DIR, slug + ".spec.json");
  if (!fs.existsSync(specPath)) die("no archived spec for " + slug);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const ds = spec.diagrams || [];
  if (!file) {
    const list = ds.map((d, i) => ({ n: i + 1, question: d.question, mermaid: d.mermaid, simple: d.simple || null }));
    if (json) return say(JSON.stringify(list, null, 2));
    for (const d of list) {
      say(`\n## ${d.n}. ${d.question}${d.simple ? "   (has an overview)" : ""}\n`);
      say(d.mermaid.trim());
    }
    const miss = list.filter(d => !d.simple).length;
    say(`\n${miss} of ${list.length} without an overview. Write {"<n>": "<mermaid>"} to a file, then: deep-plan overviews ${slug} <file.json>`);
    return;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { die(`overviews: ${file} is not JSON (${e.message})`); }
  const pairs = Array.isArray(raw) ? raw.map(o => [Number(o && o.n), o && o.simple]) : Object.entries(raw).map(([n, v]) => [Number(n), v]);
  const errs = [];
  for (const [n, v] of pairs) {
    if (!Number.isInteger(n) || n < 1 || n > ds.length) errs.push(`diagram ${n}: no such diagram (the plan has ${ds.length})`);
    else if (typeof v !== "string" || !v.trim()) errs.push(`diagram ${n}: the overview must be mermaid source, a non-empty string`);
    else if (ds[n - 1].simple && !force) errs.push(`diagram ${n} already has an overview (--force replaces it)`);
  }
  if (!errs.length) {
    const parsed = await validateDiagrams(pairs.map(([n, v]) => ({ question: `overview of diagram ${n}`, mermaid: v })));
    for (const b of parsed) if (b.error !== null) errs.push(`${b.label}: ${b.error}`);
    if (parsed.some(b => b.error === null)) console.error("deep-plan: mermaid validation skipped for some overviews (environment-limited here)");
  }
  if (errs.length) { for (const e of errs) console.error("  ✗ " + e); die(`overviews refused for ${slug}: nothing written`); }
  const patch = sp => {
    for (const [n, v] of pairs) {
      const d = (sp.diagrams || [])[n - 1];
      if (d && d.question === ds[n - 1].question) d.simple = v.trim();
    }
    return sp;
  };
  fs.writeFileSync(specPath, JSON.stringify(patch(spec), null, 2) + "\n");
  const authored = path.join(PLANS_DIR, slug + ".spec.json");
  let alsoAuthored = false;
  try {
    const a = JSON.parse(fs.readFileSync(authored, "utf8"));
    if ((a.diagrams || []).length === ds.length) {
      fs.writeFileSync(authored, JSON.stringify(patch(a), null, 2) + "\n");
      alsoAuthored = true;
    }
  } catch { /* no authored copy, or not ours to touch */ }
  rehydrate(slug, { quiet: true });
  say(`overviews: ${pairs.length} written to ${slug}${alsoAuthored ? " (archived + authored spec)" : " (archived spec)"}; surfaces redrawn`);
}

// ---------------------------------------------------------------- grade

// ---------------------------------------------------------------- artifact

// The shareable page: review content + a db-backed annotation layer, emitted
// for the AGENT to publish with the Artifact tool. This CLI never touches the
// network. Deterministic (no timestamps), so re-exports are diffable.
//
// Leak discipline: rendered from the archived spec, but the alignment quiz is
// omitted ENTIRELY — no prompts, options, whys — because this surface leaves
// the machine and the quiz's whole value is that readers meet it cold. No key
// material is read (probe.mjs asserts the output carries none).
//
// Mermaid: artifacts render <pre class="mermaid"> natively, so the 3.4MB base64
// vendor embed the local surfaces need is dead weight here and is not emitted.
function exportArtifact(slug, asJson) {
  const specPath = path.join(KEYS_DIR, slug + ".spec.json");
  if (!fs.existsSync(specPath)) die("no archived spec for " + slug);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const st = readState(slug);
  checksFromState(spec, st);
  const incs = (spec.deliverables || []).map((d, i) =>
    `<div class="inc" id="inc-${i + 1}"><b>${i + 1}. ${esc(d.title)}</b><p>${esc(d.body || "")}</p>
${(d.files || []).length ? `<p class="dim">files: ${d.files.map(f => `<code>${esc(f)}</code>`).join(" ")}</p>` : ""}
${checksHtml(planChecks(spec, i), d.waiver)}</div>`).join("\n");
  const diagrams = (spec.diagrams || []).map(dg =>
    `<h2>${esc(dg.question)}</h2>` +
    (dg.simple ? `<p class="dim">overview</p><pre class="mermaid">${esc(String(dg.simple).trim())}</pre><p class="dim">detailed</p>` : "") +
    `<pre class="mermaid">${esc(dg.mermaid.trim())}</pre>`).join("\n");
  const facts = (spec.verifiedFacts || []).map(f =>
    `<li>${esc(f.claim)} <span class="dim">— <code>${esc(f.evidence)}</code></span></li>`).join("");
  const decs = (spec.decisions || []).map(d =>
    `<li><b>${esc(d.decision)}</b> — ${esc(d.why)}</li>`).join("");
  const risks = risksHtml(spec);
  const incOpts = (spec.deliverables || []).map((d, i) =>
    `<option value="${i + 1}">${i + 1}. ${esc(d.title)}</option>`).join("");

  const html = `<title>${esc(spec.title)}</title>
<style>
:root{--bg:#f6f5f1;--card:#ffffff;--ink:#232a2e;--muted:#68727a;--line:#d9d6cd;
--accent:#3a6ea5;--good:#2e7d4f;--warn:#a06a00}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
--bg:#20262b;--card:#2a3138;--ink:#d7dce1;--muted:#8b969e;--line:#3a434b;
--accent:#7aa7d8;--good:#69c08c;--warn:#e0b25c}}
:root[data-theme="dark"]{--bg:#20262b;--card:#2a3138;--ink:#d7dce1;--muted:#8b969e;
--line:#3a434b;--accent:#7aa7d8;--good:#69c08c;--warn:#e0b25c}
body{background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,system-ui,"Segoe UI",sans-serif;
max-width:760px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:21px;letter-spacing:-.01em}h2{font-size:16px;margin-top:2em;
border-bottom:1px solid var(--line);padding-bottom:4px}
code{background:color-mix(in srgb,var(--ink) 8%,transparent);border-radius:4px;padding:1px 5px;font-size:13px}
.dim{color:var(--muted)}
.inc{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.mermaid{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}
.annot{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;margin-top:10px}
.annot input[type=text]{background:var(--bg);color:var(--ink);border:1px solid var(--line);
border-radius:6px;padding:7px 10px;font:14px system-ui;width:55%}
.annot select{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:7px}
.annot button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 14px;
font:600 13px system-ui;cursor:pointer}
.annot button:focus-visible,.annot input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
ul.alist{padding-left:0;list-style:none}
ul.alist li{border-top:1px solid var(--line);padding:7px 0;font-size:13px}
ul.alist li b{color:var(--accent)}
.ro{color:var(--warn);font-size:13px}
</style>
<h1>${esc(spec.title)}</h1>
<p class="dim">plan <code>${esc(spec.slug)}</code> — shared for annotation; the plan itself
is read-only here and changes only by the author re-rendering.</p>
<h2>Context</h2><p>${esc(spec.context).replace(/\n\s*\n/g, "</p><p>")}</p>
${decs ? `<h2>Decisions</h2><ul>${decs}</ul>` : ""}
${workstreamsHtml(spec)}
${contractsHtml(spec)}
${facts ? `<h2>Verified facts</h2><ul>${facts}</ul>` : ""}
${risks ? `<h2>Risks</h2><ul>${risks}</ul>` : ""}
${diagrams}
<h2>Increments</h2>${incs}
${(spec.verification || []).length ? `<h2>Verification</h2><ul>${spec.verification.map(v => `<li><code>${esc(v)}</code></li>`).join("")}</ul>` : ""}
<h2>Annotations</h2>
<div class="annot">
  <p id="dp-ro" class="ro" hidden>Read-only view — annotation needs a shared grant; ask the author to share with you.</p>
  <p>
    <select id="dp-inc" aria-label="what this annotation is about">
      <option value="">whole plan</option>${incOpts}
    </select>
    <input type="text" id="dp-text" placeholder="what should the author know?" aria-label="annotation text">
    <button id="dp-add" disabled>Annotate</button>
  </p>
  <ul class="alist" id="dp-list" aria-live="polite"></ul>
</div>
<script>
(async function(){
  var $ = function(id){ return document.getElementById(id); };
  var db = await claude.use("db");
  if (!db) { $("dp-ro").hidden = false; return; }
  $("dp-add").disabled = false;
  var who = null;
  try { who = localStorage.getItem("dp-annotator-name"); } catch(e){}
  db.collection("annotations").orderBy("created_at").limit(200).onSnapshot(function(snap){
    var docs = snap && snap.docs ? snap.docs : (snap || []);
    var html = "";
    docs.forEach(function(d){
      var v = d.data ? d.data() : d;
      var safe = function(s){ return String(s==null?"":s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];}); };
      html += "<li>" + (v.resolved ? "✓ " : "• ") + "<b>" + safe(v.author_name||"someone") + "</b>" +
        (v.increment ? " <span class=\\"dim\\">on increment " + safe(v.increment) + "</span>" : "") +
        " — " + safe(v.text) + "</li>";
    });
    $("dp-list").innerHTML = html;
  });
  $("dp-add").addEventListener("click", async function(){
    var t = $("dp-text").value.trim();
    if (!t) return;
    if (!who) {
      who = (prompt("Your name (shown with your annotations):") || "").trim() || "anonymous";
      try { localStorage.setItem("dp-annotator-name", who); } catch(e){}
    }
    var id = "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try {
      await db.doc("annotations/" + id).set({
        slug: ${JSON.stringify(spec.slug)},
        increment: $("dp-inc").value ? Number($("dp-inc").value) : null,
        anchor: null, text: t, author_id: null, author_name: who,
        created_at: Date.now(), resolved: false
      });
      $("dp-text").value = "";
    } catch (e) { alert("could not save: " + (e && e.code || e)); }
  });
})();
</script>`;

  fs.mkdirSync(PLANS_DIR, { recursive: true });
  const out = path.join(PLANS_DIR, slug + ".artifact.html");
  fs.writeFileSync(out, html);
  const meta = {
    path: out, slug, spec_hash: specHash(spec),
    capabilities: { db: { rules: [{ path: "annotations", write: "interact" }] } },
    favicon: "🗺️",
    note: "publish via the Artifact tool; then: deep-plan attach-artifact " + slug + " <url>",
    already_published: (st && st.artifact) || null,
  };
  if (asJson) process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
  else {
    say("exported " + out);
    say("publish it (Artifact tool) with capabilities: " + JSON.stringify(meta.capabilities));
    say("then: deep-plan attach-artifact " + slug + " <url>");
    if (meta.already_published) say("already published at " + meta.already_published.url +
      (meta.already_published.spec_hash !== meta.spec_hash ? " (STALE — republish to same url)" : " (up to date)"));
  }
}

// ---------------------------------------------------------------- adr apply

// The one command that writes ADRs into the repo — separate from render by
// tenet 8 (generate, never apply), and refused until the alignment check has
// passed: the repo must not change while the plan is still under review.
// The DESTINATION is the one the human reviewed (stored in state at render);
// only the number re-checks against the repo, because another ADR can land
// between render and apply — drift reallocates and says so out loud.
// Re-apply is idempotent: an entry with a recorded applied path rewrites
// that same file, never allocates a fresh number.
function adrApply(slug) {
  const st = readState(slug) || die("no plan " + slug);
  if (st.phase === "review")
    die("phase is review — the alignment check has not passed; ADRs stay drafts until it does");
  const adrs = st.adrs || [];
  if (!adrs.length) die(slug + " has no flagged ADRs (decisions[].adr)");
  const specPath = path.join(KEYS_DIR, slug + ".spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const entries = adrEntries(spec);
  const config = loadAdrConfig(st.root);
  const date = new Date().toISOString().slice(0, 10);
  for (const a of adrs) {
    const entry = entries[a.n - 1];
    if (!entry) continue;
    const dirAbs = path.join(st.root, a.dir);
    if (!a.applied) {
      const miss = adrScanReport(dirAbs, config.numberScan);
      if (miss)
        say(`adr ${a.n}: WARNING — ${a.dir} holds ${miss.total} .md file(s) the numbering scan does not ` +
            `recognise (e.g. ${miss.examples[0]}); numbering restarts at 1 and may duplicate an existing ADR`);
      const fresh = nextNumber(dirAbs, config.numberScan);
      if (fresh !== a.number) {
        say(`adr ${a.n}: number drifted ${a.number} -> ${fresh} (something landed in ${a.dir} since render)`);
        a.number = fresh;
        a.file = adrFileName(fresh, entry.decision, config.filePattern);
      }
    }
    const rel = path.join(a.dir, a.file);
    fs.mkdirSync(dirAbs, { recursive: true });
    fs.writeFileSync(path.join(st.root, rel),
      renderAdr(entry, config, { number: a.number, root: st.root, status: "Accepted", date }));
    const re = a.applied ? " (rewritten)" : "";
    a.applied = rel;
    log1(st, `adr apply: ${rel}${re}`);
    say(`applied ${rel}${re}`);
  }
  writeState(st); rerenderWorking(slug);
}

function attachArtifact(slug, url) {
  const st = readState(slug) || die("no plan " + slug);
  const specPath = path.join(KEYS_DIR, slug + ".spec.json");
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  st.artifact = { url, spec_hash: specHash(spec), published_at: Date.now() };
  log1(st, "published for annotation: " + url);
  writeState(st); rerenderWorking(slug);
  say("recorded artifact for " + slug + ": " + url);
}

// No answers on a TTY -> prompt per question, so the letters never touch
// shell history (q1=a on the command line is grep-able forever). The argv
// form stays: the board and the probes are not TTYs.
async function promptAnswers(key) {
  if (!process.stdin.isTTY)
    die("grade <slug> q1=a q2=c …  (no TTY here, so no interactive prompt)");
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  say("answers stay off the command line — type the letter for each:");
  const given = [];
  for (const qid of Object.keys(key.answers)) {
    const a = (await rl.question(`  ${qid} = `)).trim().toLowerCase();
    given.push(`${qid}=${a}`);
  }
  rl.close();
  return given;
}

async function grade(slug, answers) {
  const keyPath = path.join(KEYS_DIR, slug + ".key.json");
  if (!fs.existsSync(keyPath)) die("no answer key for " + slug);
  const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const st = readState(slug) || die("no state for " + slug);
  // Contract coverage is structural: no set of answers can pass a quiz that
  // never asked about a contract decision, so refuse before prompting.
  const uncovered = key.uncoveredContracts || [];
  if (uncovered.length) {
    console.error(`alignment check FAILED — ${uncovered.length} contract decision(s) no quiz question covers:`);
    for (const ref of uncovered) console.error(`  ✗ reopen the decision: ${ref}`);
    console.error("Add a question whose decisionRef matches each, re-render, re-check.");
    log1(st, `alignment check failed (uncovered contract decisions: ${uncovered.length})`);
    writeState(st); rerenderWorking(slug);
    process.exit(1);
  }
  // Same for risks: a risk the human never dispositioned is a risk the review
  // never looked at, and no set of answers can stand in for that.
  const undisposed = key.undispositionedRisks || [];
  if (undisposed.length) {
    console.error(`alignment check FAILED — ${undisposed.length} risk(s) carry no disposition:`);
    for (const r of undisposed) console.error(`  ✗ disposition the risk: ${r}`);
    console.error("Pick accept, mitigate, spike or promote on the review page (Copy for session), apply, re-render, re-check.");
    log1(st, `alignment check failed (undispositioned risks: ${undisposed.length})`);
    writeState(st); rerenderWorking(slug);
    process.exit(1);
  }
  if (!answers.length) answers = await promptAnswers(key);
  const given = {};
  for (const a of answers) {
    const m = a.match(/^([\w-]+)=([a-z])$/i);
    if (!m) die("answers look like q1=a q2=c — got " + a);
    given[m[1]] = m[2].toLowerCase();
  }
  let wrong = [];
  for (const [qid, k] of Object.entries(key.answers)) {
    if (!(qid in given)) wrong.push({ qid, why: "unanswered", ref: k.decisionRef });
    else if (given[qid] !== k.letter) wrong.push({ qid, why: k.why, ref: k.decisionRef });
  }
  if (wrong.length) {
    console.error(`alignment check FAILED — ${wrong.length} of ${Object.keys(key.answers).length}:`);
    for (const w of wrong)
      console.error(`  ✗ ${w.qid}: ${w.why}\n    reopen the decision: ${w.ref}`);
    console.error("Either the plan or your model of it is wrong. Fix whichever is, re-render, re-check.");
    log1(st, `alignment check failed (${wrong.length} wrong)`);
    writeState(st); rerenderWorking(slug);
    process.exit(1);
  }
  // Review is the only phase a pass moves on from: a re-grade must not pull a
  // delivery, done or closed plan back to implementing.
  if (st.phase === "review") st.phase = "implementing";
  log1(st, "alignment check passed");
  // The approved snapshot: the plan AS AGREED, cut once at the plan→working
  // boundary and never overwritten — paste-anywhere context (Jira, PRs).
  // Amends keep changing the live surfaces; the working page notes drift.
  if (!st.approved) {
    const spec = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, slug + ".spec.json"), "utf8"));
    const apPath = path.join(PLANS_DIR, slug + ".approved.md");
    fs.writeFileSync(apPath,
      `> approved snapshot of plan \`${slug}\` — cut when the alignment check passed; immutable. The live plan may have moved on.\n\n` +
      mdPlan(checksFromState(spec, st), st.adrs || []));
    st.approved = { spec_hash: specHash(spec), path: apPath };
    log1(st, "approved snapshot cut: " + apPath);
    say("approved snapshot: " + apPath + " (immutable — paste it into tickets/PRs as context)");
  }
  writeState(st); rerenderWorking(slug);
  say("alignment check passed — phase: implementing. `deep-plan go " + slug + " 1` opens the first increment.");
}

// ---------------------------------------------------------------- tracker

function findInc(st, n) {
  const inc = (st.increments || []).find(i => i.n === Number(n));
  if (!inc) die(`no increment ${n} in ${st.slug}`);
  return inc;
}

// Both sides resolved as the gate resolves them: a root is recorded as the
// real path (/private/var/… on macOS), and --at is often spelled /var/….
function resolveSlugAt(dir) {
  const target = canon(dir);
  for (const st of allStates()) {
    if (!st.root || st.phase === "closed") continue;
    const r = canon(st.root);
    if (target === r || target.startsWith(r + path.sep)) return st.slug;
  }
  return null;
}

// The refusal reads top-down for a person and bottom-up for a machine: crew's
// board shows only the LAST line of a refused command, so the reason goes
// there, never a hint.
function checksRefusal(slug, n, out) {
  const short = s => s.length > 60 ? s.slice(0, 57) + "…" : s;
  const review = out.find(c => c.synth === "review" || c.kind === "review");
  const lines = out.map(c => `  ${CHECK_MARK[c.status] || "·"} ${c.id}  [${c.kind}] ${c.status}` +
    (c.status === "stale" ? " — passed against other content than the tree now" : "") +
    (c.note ? ` — ${c.note}` : ""));
  return `increment ${n} has ${out.length} check(s) outstanding:\n${lines.join("\n")}` +
    `\n\n  what each one runs:  deep-plan check list ${slug} ${n}` +
    `\n  record a verdict:    deep-plan check pass|fail ${slug} ${n} <id> "<what you saw>"` +
    (review ? `\n  the review:          deep-plan check run ${slug} ${n} opens it; then spawn ONE fresh reviewer ` +
      `subagent whose prompt is the output of \`lookout prompt ${reviewId(slug, n)}\`` : "") +
    `\n  override, logged:    deep-plan done ${slug} ${n} --force` +
    `\n\ndone refused: ${out.map(c => `${c.id} ${c.status}${c.note ? ` (${short(c.note)})` : ""}`).join("; ")}`;
}

// Back to pending, folding what the verdict was into its note rather than
// deleting it: re-gate without destroying what was observed. `ids` null means
// every check that has moved off pending. Returns the ids it moved.
function repend(inc, ids, why) {
  const checks = checksOf(inc), moved = [];
  for (const [id, v] of Object.entries(checks)) {
    if (v.retired) continue;
    if (ids ? !ids.includes(id) : (v.status || "pending") === "pending") continue;
    const was = v.status || "pending";
    const { ran, tree, by, runner, acquire, evidence, ...rest } = v;
    checks[id] = { ...rest, status: "pending", at: Date.now(),
      note: `was ${was}${v.note ? `: ${v.note}` : ""} (${why})` };
    moved.push(id);
  }
  return moved;
}

// HEAD of the plan root, or "" outside git: an increment's base.
function headSha(root) {
  const sha = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return sha.status === 0 ? sha.stdout.trim() : "";
}

// A complete plan that has work again (an increment reset or blocked, or an
// amend that added one) is being implemented: the board, `deliver` and the
// family's sequencing all read the phase.
function reopenPhase(st) {
  if ((st.phase === "done" || st.phase === "delivery") &&
      !(st.increments || []).every(i => i.status === "done")) {
    log1(st, `phase ${st.phase} -> implementing: an increment is not done`);
    st.phase = "implementing";
  }
}

function transition(action, slug, n, why, force = false, { byHuman = false } = {}) {
  const st = readState(slug) || die("no plan " + slug);
  let by = "";
  if (action === "go") {
    if (st.phase === "review") die("the alignment check has not passed — `deep-plan grade` first");
    // Who is giving this go, and whether they may. A delegated child cannot
    // authorize itself; --force is not a way past that (a person's go is:
    // --by human). The reason goes on the last line, for the chip and pane.
    by = goBy(slug, { byHuman });
    const refusal = goRefusal(slug, by);
    if (refusal) die(`${refusal}\ngo refused: ${by === "self" ? "self-go on a delegated child" : "not the parent's go to give"}`);
    let beside = null;
    if (n === "next") {
      // A go already given and not yet acted on (the pane's or the board's
      // button, then the human typing "go" to the session) must not open a
      // second increment: `next` would skip past the one waiting to start.
      // The reason goes on the last line, which is what the chip and the pane show.
      const open = (st.increments || []).find(i => i.status === "authorized" || i.status === "working");
      if (open && !force)
        die(`increment ${open.n} (${open.title}) is already ${open.status}: start it, or close it with ` +
          `\`deep-plan done ${slug} ${open.n}\` before the next go.\n` +
          `  another increment beside it, logged:  deep-plan go ${slug} next --force\n` +
          `go refused: increment ${open.n} is already ${open.status}`);
      beside = open || null;
      const nxt = (st.increments || []).find(i => i.status === "pending");
      if (!nxt) die("no pending increment in " + slug);
      n = nxt.n;
    }
    const inc = findInc(st, n);
    if (inc.status !== "pending" && inc.status !== "blocked")
      die(`increment ${n} is ${inc.status}, not pending/blocked`);
    // A family child waits on the parent increments its workstream names in
    // `after` (the shared contract lands first). The reason goes on the last
    // line: the board's chip and the pane show only that.
    const waits = waitingOn(slug);
    if (waits.length && !force)
      die(`${slug} waits on its family's parent: ${waitText(waits)}.\n` +
        `  override, logged:  deep-plan go ${slug} ${n} --force\n` +
        `go refused: waits on ${waits.map(w => `${w.parent} increment ${w.n}`).join(", ")}`);
    // The increment's base is HEAD at authorization, recorded here rather than
    // at the first edit: the gate sees only Edit/Write and the Bash writes its
    // heuristic catches, so an increment built by a script or a `cp` was never
    // marked working and closed with no base, no patch and no review. A
    // blocked increment's re-go keeps the sha its first go recorded; a pending
    // one is always re-stamped, so a sha left by an older engine's reset
    // (which did not clear it) cannot become a stale base.
    if (inc.status === "pending" || !inc.startSha) inc.startSha = headSha(st.root);
    const how = by === "human" ? goHow({ byHuman }) : "";
    inc.status = "authorized"; inc.authorizedAt = inc.changedAt = Date.now(); inc.note = ""; inc.by = by;
    log1(st, `go: increment ${n} (${inc.title}) authorized by ${by}${how ? ` (${how})` : ""}` +
      (waits.length ? ` (--force past the family wait: ${waitText(waits)})` : "") +
      (beside ? ` (--force beside increment ${beside.n}, still ${beside.status})` : ""));
  } else if (action === "start") {
    const inc = findInc(st, n);
    if (inc.status !== "authorized") die(`increment ${n} is ${inc.status}, not authorized`);
    inc.status = "working"; inc.startedAt = inc.changedAt = Date.now();
    // go records the base; this stamps only an increment authorized before it did.
    if (!inc.startSha) inc.startSha = headSha(st.root);
    log1(st, `start: increment ${n}`);
  } else if (action === "done") {
    const inc = findInc(st, n);
    if (inc.status !== "working" && inc.status !== "authorized")
      die(`increment ${n} is ${inc.status}`);
    // An increment cannot be done until every check has passed against the
    // tree being closed. Declaring one is the whole point: a plan that promises
    // a proof and ships without looking at it has promised nothing.
    const out = checksBlock(inc, needsTree(inc) ? treeOf(st.root) : null);
    if (out.length && !force) die(checksRefusal(slug, n, out));
    inc.status = "done"; inc.doneAt = inc.changedAt = Date.now();
    // An override is logged for the same reason the verdict is recorded: someone
    // reading the history has to be able to see that the proof was skipped.
    log1(st, `done: increment ${n}` + (out.length
      ? ` (checks outstanding: ${out.map(c => `${c.id} [${c.kind}] ${c.status}`).join(", ")}; overridden with --force)`
      : ""));
    if ((st.increments || []).every(i => i.status === "done")) {
      // A plan whose human asked for a review of the full delivery is not
      // complete until that review passes: `deep-plan deliver` closes it.
      const delivery = !!(planSpec(slug).review || {}).delivery;
      st.phase = delivery ? "delivery" : "done";
      log1(st, delivery ? `every increment done; the delivery review closes the plan — deep-plan deliver ${slug}`
                        : "every increment done; the gate retires");
    }
    writeState(st); rerenderWorking(slug);
    incrementDiff(st, inc);
    say(`done ${slug} ${n}` + (st.phase === "done" ? " — plan complete"
      : st.phase === "delivery" ? `\nevery increment is done; the full delivery is reviewed next: deep-plan deliver ${slug}` : ""));
    return;
  } else if (action === "block") {
    const inc = findInc(st, n);
    inc.status = "blocked"; inc.note = why || "no reason recorded"; inc.changedAt = Date.now();
    log1(st, `block: increment ${n} — ${inc.note}`);
  } else if (action === "reset") {
    const inc = findInc(st, n);
    inc.status = "pending"; inc.note = ""; inc.changedAt = Date.now();
    inc.startSha = "";                      // redone work gets a fresh base at its next go
    // Reset means the work is being redone, so a verdict recorded against the
    // PREVIOUS attempt no longer proves anything — leaving it would let the
    // gate pass on stale evidence, silently, which is the failure this whole
    // mechanism exists to prevent. The prior verdict is folded into the note
    // rather than deleted: re-gate without destroying what was observed.
    //
    // This is a deliberate divergence from the older engine, which kept the
    // verdict across a reset and relied on the human remembering to clear it.
    const back = repend(inc, null, "reset — re-verify");
    log1(st, `reset: increment ${n}` + (back.length
      ? ` — ${back.length} check verdict(s) returned to pending (${back.join(", ")})` : ""));
  } else die("unknown transition " + action);
  reopenPhase(st);
  writeState(st); rerenderWorking(slug);
  say(`${action} ${slug} ${n}`);
  if (action === "go") {
    const url = openWorkingSurface(st);
    if (url) say(`  served at ${url} (host: ${detectHost().host})`);
    else if (!process.env.DEEP_PLAN_FROM_SERVE && detectHost().host === "remote")
      say(`  no live page on this host (host: remote); deep-plan export-artifact ${st.slug} shares one`);
  }
}

// The go-ahead opens the plan's working surface in the Dock, so the page you
// steer from appears the moment there is something to steer. Same coupling
// budget as the board ping on `go`: strictly best-effort against the
// board's intent server (whose open_plan reuses the existing Dock tab instead
// of stacking a new one per go) — no server, no row, no cmux means silence,
// never a failed go.
// ---------------------------------------------------------------- ask
// A question the human answers from a page. The terminal question tool stays
// the source of record: the agent calls both, the page shows what a terminal
// cannot (mermaid, a payload, a before/after), and — when served by the crew
// intent server — a click on the page types the option number into the
// terminal surface this ask recorded. Standalone by design: most questions
// happen outside any plan, so the file records a slug only when a plan is
// tracked at the cwd. Asks live under the plans tree because that is the
// tree the intent server already serves; ids are time-ordered and SLUG_OK-safe.
const ASKS_DIR = path.join(PLANS_DIR, "asks");

function askId() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-` +
    crypto.randomBytes(2).toString("hex");
}

function askValidate(a) {
  const errs = [];
  if (Array.isArray(a) || Array.isArray(a.questions))
    errs.push("one question per ask — multi-question prompts are not supported; make one ask per question");
  if (!a.question) errs.push("question is required");
  const opts = Array.isArray(a.options) ? a.options : [];
  if (opts.length < 2) errs.push("2+ options are required");
  opts.forEach((o, i) => { if (!o || !o.label) errs.push(`option ${i + 1} has no label`); });
  if (errs.length) die("ask refused —\n" + errs.map(e => "  ✗ " + e).join("\n"));
}

// The page. Buttons render disabled: as a file it cannot act. The intent
// server injects the transport (token, id) when it serves /ask/<id>, the same
// way PLAN_JS does for plan surfaces.
function askHtml(ask, b64) {
  const opts = ask.options.map((o, i) => {
    const n = i + 1;
    return `<div class="inc dp-ask-opt" data-n="${n}">
<h3><button type="button" class="dp-act dp-ask-pick" data-n="${n}" disabled title="pick ${n} — available when served">${n}</button> ${esc(o.label)}</h3>
${o.description ? `<p>${esc(o.description)}</p>` : ""}
${o.mermaid ? `<pre class="mermaid">${esc(String(o.mermaid).trim())}</pre>` : ""}
${o.example ? `<pre class="dp-example"><code>${esc(String(o.example))}</code></pre>` : ""}
</div>`;
  }).join("\n");
  return htmlHead((ask.header ? ask.header + " — " : "") + "question", b64) + `<style>
.dp-example{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;font-size:13px}
.dp-ask-opt h3{margin:0 0 6px}
#dp-ask-status{margin-top:16px}
</style>
<h1>${esc(ask.header || "A question for you")}</h1>
<p class="dim">ask <code>${esc(ask.id)}</code>${ask.slug ? ` · plan <code>${esc(ask.slug)}</code>` : ""} · ${esc(ask.created)}</p>
<p>${esc(ask.question).replace(/\n\s*\n/g, "</p><p>")}</p>
${ask.mermaid ? `<pre class="mermaid">${esc(String(ask.mermaid).trim())}</pre>` : ""}
<h2>Options</h2>
${opts}
<p id="dp-ask-status" class="dim" role="status" aria-live="polite">${ask.answer
  ? `answered: ${esc(String(ask.answer.n))} — ${esc(ask.options[ask.answer.n - 1]?.label || "")}`
  : "Answer in the prompt as usual. In cmux, a pick here is typed into the terminal for you."}</p>
${MERMAID_BOOT}
</body></html>`;
}

function askWrite(ask) {
  fs.mkdirSync(ASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(ASKS_DIR, ask.id + ".json"), JSON.stringify(ask, null, 2) + "\n");
  fs.writeFileSync(path.join(ASKS_DIR, ask.id + ".html"), askHtml(ask, mermaidB64()));
}

function askCreate(file) {
  let a;
  try { a = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { die("cannot read ask json: " + e.message); }
  askValidate(a);
  const cwd = process.cwd();
  const plan = planFor(cwd);
  const ask = {
    id: askId(), created: new Date().toISOString(),
    header: a.header || "", question: a.question, mermaid: a.mermaid || "",
    options: a.options.map(o => ({ label: o.label, description: o.description || "",
      mermaid: o.mermaid || "", example: o.example || "" })),
    // The one legitimate delivery target: the terminal this verb ran in. The
    // intent server types only here, never into a surface a request names.
    surface: process.env.CMUX_SURFACE_ID || "", workspace: process.env.CMUX_WORKSPACE_ID || "",
    cwd, slug: plan ? plan.slug : "", answer: null,
  };
  askWrite(ask);
  say(`ask ${ask.id}: ${path.join(ASKS_DIR, ask.id + ".html")}`);
  if (!ask.surface) say("  (not in a cmux terminal: the page shows the options; the chat prompt takes the answer)");
  const url = openAskSurface(ask);
  const host = detectHost().host;
  if (url) say(`  served at ${url} (host: ${host})`);
  else if (host === "remote") say("  no live page on this host (host: remote): answer in the chat prompt");
  else if (host === "cmux") say("  intent server not reachable — open the file, or start the board (crew listen on) (host: cmux)");
  else say(`  deep-plan serve did not start — open the file read-only (host: ${host})`);
  return ask;
}

function askShow(id) {
  const p = path.join(ASKS_DIR, id + ".json");
  if (!fs.existsSync(p)) die("no such ask: " + id);
  const ask = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!ask.answer) { say(`ask ${id}: unanswered`); return; }
  const o = ask.options[ask.answer.n - 1] || {};
  say(`ask ${id}: ${ask.answer.n} — ${o.label || ""}${ask.answer.delivered ? "" : " (shown on the page, not typed)"}`);
}

// A page's URL on deep-plan's own server, started if nothing answers. Used on
// every host but cmux, which keeps crew's URL. Empty when there is no page a
// person can reach: on the remote host (the sandbox's localhost is out of
// reach), inside a request the server itself is running, or in a probe that
// did not ask for a server.
function servedUrl(rel) {
  if (process.env.DEEP_PLAN_FROM_SERVE) return "";
  if (detectHost().host === "remote") return "";
  if (process.env.DEEP_PLAN_STATE_DIR && !process.env.DEEP_PLAN_SERVE_FILE) return "";
  const rec = SERVE.ensureServer({ script: path.join(HERE, "deep_plan.mjs"), root: HERE });
  return rec ? SERVE.urlFor(rec, rel) : "";
}

// `deep-plan serve`: start the server if needed and print a page's URL, or
// run it in the foreground (what the detached start runs), or stop it.
function serveCmd(flags, args) {
  if (flags.foreground) {
    SERVE.serveForeground({ script: path.join(HERE, "deep_plan.mjs"), version: engineVersion(), root: HERE });
    return true; // keep the process alive
  }
  if (flags.stop) { say(SERVE.stopServer() ? "stopped deep-plan serve" : "deep-plan serve was not running"); return false; }
  if (flags.status) {
    const rec = SERVE.liveServer(HERE);
    if (flags.json) process.stdout.write(JSON.stringify(rec ? { running: true, port: rec.port, pid: rec.pid, root: rec.root, version: rec.version, started: rec.started } : { running: false }) + "\n");
    else say(rec ? `deep-plan serve on 127.0.0.1:${rec.port} (pid ${rec.pid}${rec.foreign ? ", from another engine copy: " + rec.root : ""})` : "deep-plan serve is not running");
    return false;
  }
  const rel = flags.url || args[0] || "/health";
  const rec = SERVE.ensureServer({ script: path.join(HERE, "deep_plan.mjs"), root: HERE });
  if (!rec) die(`deep-plan serve did not start — see ${SERVE.LOG_FILE}`);
  say(SERVE.urlFor(rec, rel));
  return false;
}

// The house's one way to show a page beside the chat: the workspace's
// companion pane (crew-board companion.rs, `seamux companion open`). One tab
// per key, reused; an agent's open gives the keyboard back to its terminal.
// false when seamux is not installed or refuses: the caller then opens the
// page the way it did before.
function companionKey(prefix, id) {
  return (prefix + "-" + String(id)).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 96);
}

function companionOpen(url, key, ws, surface) {
  const bin = process.env.SEAMUX_BIN || path.join(os.homedir(), ".local", "bin", "seamux");
  if (!ws || !fs.existsSync(bin)) return false;
  const args = ["companion", "open", url, "--key", key, "--workspace", ws];
  if (surface) args.push("--surface", surface);
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 20000, env: { ...process.env, CMUX_QUIET: "1" } });
  return r.status === 0;
}

// Best-effort, like openWorkingSurface. Returns the served URL when the
// intent server is up.
//
// The page goes into the WORKSPACE the ask came from, as a browser tab beside
// the terminal (`cmux open --workspace`), not into the Dock: cmux has no verb
// that brings a Dock tab to the front, so a Dock ask sat behind the board, and
// the one-tab-per-workspace dedupe there meant a second ask replaced the
// first's page while its prompt was still up. In the workspace every ask is
// its own tab and stays visible. The Dock route remains the fallback for a
// caller with no workspace in its environment (a detached process).
function openAskSurface(ask) {
  try {
    if (process.env.DEEP_PLAN_FROM_SERVE) return "";
    if (detectHost().host !== "cmux") return servedUrl(`/ask/${ask.id}`);
    if (process.env.DEEP_PLAN_STATE_DIR) return "";
    const cache = path.join(os.homedir(), ".cache", "cmux-crew");
    const rd = f => fs.readFileSync(path.join(cache, f), "utf8").trim();
    const port = parseInt(rd("board-intent.port"), 10);
    const token = rd("board-intent.token");
    if (!port || !token) return "";
    const url = `http://127.0.0.1:${port}/ask/${ask.id}`;
    // Beside the terminal that asked, in the workspace's companion.
    if (ask.workspace && companionOpen(url, companionKey("ask", ask.id), ask.workspace, ask.surface)) return url;
    if (ask.workspace) {
      // --focus false: the human is mid-prompt in the terminal; do not steal it.
      const r = spawnSync("cmux", ["open", url, "--workspace", ask.workspace, "--focus", "false"],
        { encoding: "utf8", env: { ...process.env, CMUX_QUIET: "1" }, timeout: 10000 });
      if (r.status === 0) return url;
    }
    const targets = JSON.parse(fs.readFileSync(path.join(cache, "board-targets.json"), "utf8"));
    const rid = ask.workspace && targets[ask.workspace] ? ask.workspace :
      Object.keys(targets).find(k => (targets[k] || {}).cwd && path.resolve(targets[k].cwd) === path.resolve(ask.cwd));
    if (rid) {
      spawnSync("curl", ["-fsS", "-m", "5", "-o", "/dev/null",
        `http://127.0.0.1:${port}/do?a=ask&r=${encodeURIComponent(rid)}&t=${encodeURIComponent(token)}&x=${encodeURIComponent(ask.id)}`]);
    }
    return url;
  } catch { return ""; }
}

function openWorkingSurface(st) {
  try {
    // A go clicked on a page: that page is open and reloads itself.
    if (process.env.DEEP_PLAN_FROM_SERVE) return;
    const host = detectHost().host;
    // A go from outside any Claude session (the seamux app's Desk, a person's
    // shell) still goes to crew's board when there is one, as before; only a
    // session on another host is sent to deep-plan's own server.
    const board = host === "cmux" || (host === "terminal" && process.env.CLAUDECODE !== "1");
    if (!board) return servedUrl(`/plan/${st.slug}`);
    const viaBoard = openOnBoard(st);
    return viaBoard || (host === "cmux" ? undefined : servedUrl(`/plan/${st.slug}`));
  } catch { return undefined; }
}

function openOnBoard(st) {
  try {
    // Probe/test runs override the state dir; they must never reach the
    // machine's real board, whatever this machine happens to be running.
    if (process.env.DEEP_PLAN_STATE_DIR) return;
    const cache = path.join(os.homedir(), ".cache", "cmux-crew");
    const rd = f => fs.readFileSync(path.join(cache, f), "utf8").trim();
    const port = parseInt(rd("board-intent.port"), 10);
    const token = rd("board-intent.token");
    if (!port || !token) return;
    // Run by an agent in cmux: the plan opens in its workspace's companion,
    // beside its terminal, which keeps the keyboard.
    const here = process.env.CMUX_WORKSPACE_ID;
    const page = `http://127.0.0.1:${port}/plan/${st.slug}`;
    if (here && companionOpen(page, companionKey("plan", st.slug), here,
                              process.env.CMUX_SURFACE_ID || "")) return page;
    const targets = JSON.parse(fs.readFileSync(path.join(cache, "board-targets.json"), "utf8"));
    const rid = Object.keys(targets).find(k => {
      const t = targets[k] || {};
      return t.slug === st.slug ||
        (st.root && t.cwd && path.resolve(t.cwd) === path.resolve(st.root));
    });
    if (!rid) return;
    // x carries the slug we just authorized: the row's own slug field lags a
    // sync behind and the first go on a fresh plan hit exactly that gap.
    const url = `http://127.0.0.1:${port}/do?a=plan&r=${encodeURIComponent(rid)}` +
      `&t=${encodeURIComponent(token)}&x=${encodeURIComponent(st.slug)}`;
    const r = spawnSync("curl", ["-fsS", "-m", "5", "-o", "/dev/null", url]);
    return r.status === 0 ? page : undefined;
  } catch { /* board offline or never installed — the go already succeeded */ }
}

// `deep-plan install-repo [--root DIR] [--check]`: the plugin into a repo's
// own .claude/, for cloud sessions (lib/install.mjs). The pinned mermaid
// goes with it, sha256-checked, since a cloud sandbox may not reach the CDN.
function installRepoCmd(flags) {
  const root = targetRoot(flags.root);
  // The first candidate that is the pinned build, not merely the first found.
  const m = mermaidCandidates().find(p => { try { return fs.existsSync(p) && sha256File(p) === MERMAID_SHA256; } catch { return false; } });
  const extra = m ? [{ from: m, rel: "vendor/mermaid.min.js" }] : [];
  const opts = { pluginRoot: HERE, name: "deep-plan", version: engineVersion(), root, extra, optional: ["vendor/mermaid.min.js"] };
  if (flags.check) {
    const c = checkRepo(opts);
    say(c.ok ? `deep-plan in ${root}/.claude/skills/deep-plan matches this plugin (${engineVersion()})` : c.lines.join("\n"));
    if (!c.ok) process.exitCode = 1;
    return;
  }
  let r;
  try { r = installRepo(opts); } catch (e) { die(e.message); }
  say(`installed deep-plan ${r.version} into ${r.dest} (${r.files} files)`);
  say(`  hooks merged into ${r.settings}; they run on the remote host (CLAUDE_CODE_REMOTE=true) or with SEAMUX_REPO_HOOKS=1`);
  if (!extra.length) say("  no pinned mermaid on this machine (deep-plan setup); cloud plan pages will draw diagrams only if the CDN is reachable");
  say("  commit .claude/ yourself; deep-plan install-repo --check reports drift later");
}

// ---------------------------------------------------------------- state bundles
// A plan's state moved between machines or sandboxes as one JSON file: its
// state, spec and key, its rendered files (the approved snapshot cannot be
// rebuilt), and its lookout reviews. Paths are relative to the data root
// (~/.claude, or the repo's .seamux/state on the remote host), so a bundle
// from one host imports on another. Nothing here commits it; a person does.
const BUNDLE_KIND = "deep-plan-state";
const REVIEWS_DIR_DP = () => process.env.LOOKOUT_REVIEWS_DIR || path.join(PLANS_DIR, "reviews");

// Exactly the names a plan's own files take, folder by folder: another
// plan's files (a slug that extends this one, "v1" and "v1.2" or "foo" and
// "foo-bar") never match.
const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function bundleNames(slug) {
  const s = reEsc(slug);
  return {
    "deep-plan/state": new RegExp(`^${s}\\.json$`),
    "deep-plan/keys": new RegExp(`^${s}\\.(spec|key)\\.json$`),
    "plans": new RegExp(`^${s}\\.(md|review\\.html|working\\.html|widget\\.html|quiz\\.txt|approved\\.md|artifact\\.html|adr\\d+\\.md|inc\\d+\\.patch)$`),
    "plans/reviews": new RegExp(`^${s}-(inc\\d+|delivery)\\.(json|patch|rows\\.json|html|seen\\.json)$`),
    // A family parent's: the index, the holds and take-backs, the trespass
    // log. Each member's seen file is its own machine's, and stays.
    [`deep-plan/state/families/${slug}`]: /^(index\.json|control\.json|trespass\.jsonl)$/,
  };
}

const BUNDLE_BASES = slug => ({ "deep-plan/state": STATE_DIR, "deep-plan/keys": KEYS_DIR, "plans/reviews": REVIEWS_DIR_DP(),
  "plans": PLANS_DIR, [`deep-plan/state/families/${slug}`]: path.join(FAMILIES_DIR, slug) });

function bundleFiles(slug) {
  const names = bundleNames(slug);
  const dirs = BUNDLE_BASES(slug);
  const out = [];
  for (const [rel, dir] of Object.entries(dirs)) {
    let list = [];
    try { list = fs.readdirSync(dir); } catch { /* absent */ }
    for (const n of list) {
      const p = path.join(dir, n);
      try { if (names[rel].test(n) && fs.statSync(p).isFile()) out.push([rel + "/" + n, p]); } catch { /* gone */ }
    }
  }
  return out;
}

function exportState(slug, flags) {
  if (!slug || !readState(slug)) die(`no plan ${slug || "?"} (export-state <slug> [--out FILE])`);
  const files = {};
  for (const [rel, p] of bundleFiles(slug)) files[rel] = fs.readFileSync(p).toString("base64");
  const bundle = { kind: BUNDLE_KIND, version: 1, slug, exportedAt: new Date().toISOString(), from: DATA_ROOT, files };
  const out = path.resolve(flags.out || `${slug}.deep-plan-state.json`);
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + "\n");
  say(`exported ${slug}: ${Object.keys(files).length} file(s) to ${out}`);
  say("  commit it (or copy it) yourself; `deep-plan import-state <file>` brings it back");
}

// A bundle's files, checked whole before anything is written: only the
// plan's own file names, in the known folders, and at least its state and
// spec, both JSON. "" when it may be written, else why not.
function checkBundle(slug, files) {
  const bases = BUNDLE_BASES(slug), names = bundleNames(slug);
  for (const rel of Object.keys(files)) {
    const dir = path.posix.dirname(rel), name = path.posix.basename(rel);
    if (!bases[dir] || !names[dir].test(name)) return `refused: the bundle names ${rel}, outside the plan's own files`;
  }
  for (const need of [`deep-plan/state/${slug}.json`, `deep-plan/keys/${slug}.spec.json`]) {
    if (!(need in files)) return `refused: the bundle has no ${need}`;
    try { JSON.parse(Buffer.from(files[need]).toString("utf8")); }
    catch { return `refused: the bundle's ${need} is not JSON`; }
  }
  return "";
}
function writeBundle(slug, files) {
  const bases = BUNDLE_BASES(slug);
  let n = 0;
  for (const [rel, data] of Object.entries(files)) {
    const base = bases[path.posix.dirname(rel)];
    fs.mkdirSync(base, { recursive: true });
    // Atomic, as writeState is: the gate reads the state file on every call.
    const dest = path.join(base, path.posix.basename(rel)), tmp = dest + ".tmp." + process.pid;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
    n++;
  }
  return n;
}
// The root a written plan guards: as given, else the root this machine had
// for the plan before the write (another machine's root is not this one's,
// even when the same path exists here), else the recorded one when it is
// here, else this checkout (a fresh sandbox clones to its own path).
function settleRoot(slug, flags, how, before = "") {
  const st = readState(slug);
  const here = (() => { const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : ""; })();
  const root = flags.root ? path.resolve(flags.root) : before && fs.existsSync(before) ? before
    : st.root && fs.existsSync(st.root) ? st.root : here;
  let changed = false;
  if (root && root !== st.root) { st.root = root; log1(st, `${how}: root is now ${root}`); changed = true; }
  // The approved snapshot came with the plan's files; its recorded path is
  // the machine's that cut it.
  const ap = path.join(PLANS_DIR, slug + ".approved.md");
  if (st.approved && st.approved.path && st.approved.path !== ap && fs.existsSync(ap)) { st.approved.path = ap; changed = true; }
  if (changed) writeState(st);
  return st;
}

function importState(file, flags) {
  if (!file) die("import-state <file> [--force] [--root DIR]");
  let b;
  try { b = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { die(`cannot read ${file}: ${e.message}`); }
  if (!b || b.kind !== BUNDLE_KIND || !b.slug || typeof b.files !== "object") die(`${file} is not a deep-plan state bundle`);
  if (!/^[a-z0-9][a-z0-9._-]{0,120}$/.test(b.slug)) die(`bad slug in the bundle: ${b.slug}`);
  if (readState(b.slug) && !flags.force) die(`plan ${b.slug} already exists here; --force replaces it`);
  const files = Object.fromEntries(Object.entries(b.files).map(([rel, b64]) => [rel, Buffer.from(String(b64), "base64")]));
  const bad = checkBundle(b.slug, files);
  if (bad) die(bad);
  const n = writeBundle(b.slug, files);
  const st = settleRoot(b.slug, flags, "import-state");
  try { rerenderWorking(b.slug); } catch (e) { say(`  (the working page was not redrawn: ${e.message}; deep-plan rehydrate ${b.slug} redraws it)`); }
  say(`imported ${b.slug}: ${n} file(s); root ${st.root || "(none)"}`);
}

// ---------------------------------------------------------------- state branches
// `deep-plan state push|pull|status|list`: a plan's bundle files on a branch
// of its own (lib/sync.mjs), so another machine or sandbox can pull it. What
// a branch may hold is the bundle's rule (checkBundle); pull checks it before
// anything is written. What this machine last synced is kept beside the
// state, outside the bundle, in <state>/.sync/<slug>.json: the version it
// pushed or pulled, where, and a digest of the plan's files right after.
const SYNC_META_DIR = () => path.join(STATE_DIR, ".sync");
function syncMeta(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(SYNC_META_DIR(), slug + ".json"), "utf8")); } catch { return null; }
}
function writeSyncMeta(slug, m) {
  fs.mkdirSync(SYNC_META_DIR(), { recursive: true });
  const p = path.join(SYNC_META_DIR(), slug + ".json"), tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  fs.renameSync(tmp, p);
}
function bundleBuffers(slug) {
  const files = {};
  for (const [rel, p] of bundleFiles(slug)) files[rel] = fs.readFileSync(p);
  return files;
}
function digestOf(files) {
  const h = crypto.createHash("sha256");
  for (const rel of Object.keys(files).sort()) h.update(rel + "\0").update(files[rel]).update("\0");
  return h.digest("hex").slice(0, 16);
}

// A plan's share setting, as render recorded it from the spec: false, true
// or {remote, prefix, sync}. A plan that is not here has none, and its
// branch is looked for where the defaults (and SEAMUX_STATE_*) say.
function planShare(st) {
  if (!st) return false;
  if (st.share) return st.share;
  // A family child follows its parent, with no flag of its own.
  if (!planShare.fams) planShare.fams = new Map();
  if (!planShare.fams.has(st.slug)) planShare.fams.set(st.slug, familyOf(st.slug));
  const idx = planShare.fams.get(st.slug);
  if (idx && idx.parent !== st.slug) { const p = readState(idx.parent); return (p && p.share) || false; }
  return false;
}

// The backend for a plan: its root's repo when the root is here, else this
// checkout's. Config problems are said, never fatal.
function openSync(st, { soft = false, timeout } = {}) {
  const dir = st && st.root && fs.existsSync(st.root) ? st.root : process.cwd();
  let o;
  try { o = SYNC.openBackend(planShare(st), dir, timeout ? { timeout } : {}); }
  catch (e) { if (soft) return { error: e.message }; die(e.message); }
  for (const p of o.cfg.problems) console.error("deep-plan: " + p);
  return o;
}

// Where a plan stands against its branch, from the sync record, the files
// on disk, and the branch's version on the remote ("" when it has none).
function syncState(slug, remote) {
  const meta = syncMeta(slug);
  const local = readState(slug) ? digestOf(bundleBuffers(slug)) : "";
  if (!local) return remote ? "not here" : "nothing";
  if (!meta) return remote ? "never synced here; the branch exists" : "no branch";
  const changed = local !== meta.digest, moved = remote !== meta.version;
  if (!remote) return "no branch (it was removed)";
  if (changed && moved) return "both moved";
  if (changed) return "local changes to push";
  if (moved) return "branch ahead: pull";
  return "in sync";
}

// A branch's files merged into the plan here by lib/merge.mjs's rules, and
// written back: the other files first, the state last and under its lock.
// The root stays this machine's. "" when done, else why not.
function mergeIn(slug, r) {
  const bad = checkBundle(slug, r.files);
  if (bad) return bad;
  const rel = `deep-plan/state/${slug}.json`;
  const ls = readState(slug);
  let rs;
  try { rs = JSON.parse(Buffer.from(r.files[rel]).toString("utf8")); } catch { return `the branch's ${rel} is not JSON`; }
  const files = mergeFiles(bundleBuffers(slug), r.files, ls, rs, rel, mergeStates(ls, rs));
  delete files[rel];
  writeBundle(slug, files);
  // The state is merged again from a fresh read right before it is written,
  // so a write here since the first read is in it; writeState's own merge
  // then keeps any verdict or log line that lands in the last moment.
  const now = readState(slug) || ls;
  const merged = mergeStates(now, rs);
  merged.root = now.root;
  log1(merged, `state: merged ${r.version.slice(0, 8)} from the state branch`);
  writeState(merged, { stamp: false });
  try { rerenderWorking(slug); } catch { /* the pages are redrawn by the next write */ }
  return "";
}

// Push a plan's files to its branch. When the branch moved since this
// machine last synced, its files are merged in first; a push the remote
// refuses because it moved again is merged and tried again, a few times.
// Returns { ok, message } or { error }; never exits, so a transition can
// call it and carry on.
function pushPlan(slug, backend, tries = 3) {
  const where = `${backend.branch(slug)} on ${backend.where}`;
  for (let i = 0; i < tries; i++) {
    const meta = syncMeta(slug);
    const mine = meta && meta.where === backend.where ? meta.version : "";
    let cur;
    try { cur = backend.version(slug); } catch (e) { return { error: e.message }; }
    let merged = false;
    if (cur && cur !== mine) {
      // Nothing changed here since the last sync: there is nothing to push,
      // and the branch's state is simply newer.
      if (meta && meta.where === backend.where && digestOf(bundleBuffers(slug)) === meta.digest)
        return { ok: true, message: `${slug}: nothing to push; ${where} is ahead (deep-plan state pull ${slug})` };
      let r;
      try { r = backend.read(slug); } catch (e) { return { error: e.message }; }
      if (r.version !== cur) continue;
      const why = mergeIn(slug, r);
      if (why) return { error: `cannot merge ${where}: ${why}` };
      merged = true;
    }
    const files = bundleBuffers(slug), digest = digestOf(files);
    if (cur && !merged && meta && meta.digest === digest) return { ok: true, message: `${slug} is in sync with ${backend.branch(slug)} (${cur.slice(0, 8)})` };
    let w;
    try { w = backend.write(slug, files, cur); } catch (e) { return { error: e.message }; }
    if (!w.ok) continue;
    writeSyncMeta(slug, { version: w.version, where: backend.where, branch: backend.branch(slug), digest, at: new Date().toISOString(), last: "push" });
    return { ok: true, message: `pushed ${slug} to ${where} (${w.version.slice(0, 8)}): ${Object.keys(files).length} file(s)` +
      (merged ? "; merged with the branch first" : "") };
  }
  return { error: `${where} kept moving; gave up after ${tries} tries` };
}

function statePush(slug) {
  const st = readState(slug) || die(`no plan ${slug || "?"} (state push <slug>)`);
  const { backend } = openSync(st);
  const r = pushPlan(slug, backend);
  if (r.error) die(r.error);
  say(r.message);
}

// Pull a plan from its branch: write it when nothing changed here since the
// last sync, merge it when something did (or --force replaces it). Returns
// { message } or { error }; never exits, so the session hook can call it.
function pullPlan(slug, backend, flags = {}) {
  const local = readState(slug);
  let r;
  try { r = backend.read(slug); } catch (e) { return { error: e.message }; }
  const where = `${backend.branch(slug)} on ${backend.where}`;
  if (!r.version) {
    // The plan ended elsewhere: its branch became an archive tag.
    let tag = false;
    try { tag = backend.archived(slug); } catch { /* unreachable: said as no branch */ }
    const m0 = syncMeta(slug);
    if (tag && m0) {
      if (!m0.archived) writeSyncMeta(slug, { ...m0, archived: { tag: SYNC.ARCHIVE_PREFIX + slug, at: new Date().toISOString(), seen: "pull" } });
      return { error: `${slug} ended elsewhere: ${backend.branch(slug)} was archived as ${SYNC.ARCHIVE_PREFIX}${slug}`, archived: true, told: !!m0.archived };
    }
    return { error: `no branch ${where}` };
  }
  const meta = syncMeta(slug);
  // A failed push stays recorded through a merge: the result still is not
  // on the branch. A plain pull replaces the plan, so it clears.
  const record = (digest, keepFailed = false) => writeSyncMeta(slug, { version: r.version, where: backend.where, branch: backend.branch(slug), digest,
    at: new Date().toISOString(), last: "pull", ...(keepFailed && meta && meta.failed ? { failed: meta.failed } : {}) });
  if (local && meta && meta.version === r.version && meta.where === backend.where && !flags.force)
    return { message: `${slug} is up to date with ${backend.branch(slug)} (${r.version.slice(0, 8)})`, same: true };
  // The session hook brings plans that are not here only while they are live.
  if (!local && flags.liveOnly) {
    try {
      const ph = JSON.parse(Buffer.from(r.files[`deep-plan/state/${slug}.json`]).toString("utf8")).phase;
      if (ph === "closed" || ph === "done") return { message: "", same: true };
    } catch { /* checkBundle below names it */ }
  }
  // Changes here the branch does not have: merged with it, not dropped.
  // The result is ahead of the branch until the next push.
  if (local && !flags.force && (!meta || digestOf(bundleBuffers(slug)) !== meta.digest)) {
    const why = mergeIn(slug, r);
    if (why) return { error: why };
    if (flags.root) settleRoot(slug, flags, "state pull");
    record(digestOf(r.files), true);
    return { writer: (r.meta && r.meta.writer) || "", message: `merged ${slug} with ${where} (${r.version.slice(0, 8)}); deep-plan state push ${slug} shares the result` };
  }
  const bad = checkBundle(slug, r.files);
  if (bad) return { error: bad };
  const n = writeBundle(slug, r.files);
  const st = settleRoot(slug, flags, "state pull", local && local.root);
  let note = "";
  try { rerenderWorking(slug); } catch (e) { note = `\n  (the working page was not redrawn: ${e.message}; deep-plan rehydrate ${slug} redraws it)`; }
  record(digestOf(bundleBuffers(slug)));
  return { writer: (r.meta && r.meta.writer) || "", message: `pulled ${slug} from ${where} (${r.version.slice(0, 8)}): ${n} file(s); root ${st.root || "(none)"}` +
    (r.meta && r.meta.writer ? `; last written by ${r.meta.writer} at ${r.meta.at}` : "") + note };
}

function statePull(slug, flags) {
  if (flags.session) return stateSessionPull();
  if (!slug) die("state pull <slug> [--force] [--root DIR] | state pull --session");
  const { backend } = openSync(readState(slug));
  const r = pullPlan(slug, backend, flags);
  if (r.error) die(r.error);
  say(r.message);
}

// The SessionStart hook: pull the shared plans rooted in this repo. On the
// remote host, where a new sandbox starts with nothing, also pull every plan
// with a branch on this repo's remote that is not here yet. Quiet unless
// something came in; a failure is one line; never exits non-zero.
// The hook is killed at 60 s (hooks.json). Each network call may take 25 s,
// which a cloud sandbox's git proxy has needed; the budget stops new pulls
// in time for the summary line.
const SESSION_TIMEOUT_MS = Number(process.env.DEEP_PLAN_SYNC_TIMEOUT_MS) || 25000, SESSION_BUDGET_MS = 45000;
function stateSessionPull() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const common = d => {
    const r = spawnSync("git", ["-C", d, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? canon(r.stdout.trim()) : "";
  };
  const repo = common(dir);
  if (!repo) return;
  // What does not fit in the budget waits for
  // the next session or a state pull by hand, and is named.
  const t0 = Date.now(), late = [];
  const lines = [], failed = [];
  const run = (slug, backend, flags = {}) => {
    if (Date.now() - t0 > SESSION_BUDGET_MS) { late.push(slug); return; }
    const r = pullPlan(slug, backend, flags);
    if (r.archived) { if (!r.told) lines.push(r.error); }
    else if (r.error) failed.push(`${slug}: ${r.error}`);
    else if (!r.same) lines.push(r.message.split("\n")[0]);
  };
  for (const st of allStates()) {
    if (st.phase === "closed" || !planShare(st) || !st.root || !fs.existsSync(st.root) || common(st.root) !== repo) continue;
    const sm = syncMeta(st.slug);
    if (sm && sm.archived) continue;
    const o = openSync(st, { soft: true, timeout: SESSION_TIMEOUT_MS });
    if (o.error) { failed.push(`${st.slug}: ${o.error}`); continue; }
    // sync manual or off: nothing automatic, the pull included.
    if (o.cfg.sync !== "transitions") continue;
    run(st.slug, o.backend);
  }
  if (detectHost().host === "remote") {
    let o;
    try { o = SYNC.openBackend(true, dir, { timeout: SESSION_TIMEOUT_MS }); } catch (e) { failed.push(e.message); }
    if (o && o.cfg.sync === "transitions") {
      let list = [];
      try { list = o.backend.list(); } catch (e) { failed.push(e.message); }
      for (const x of list) if (!readState(x.slug)) run(x.slug, o.backend, { liveOnly: true });
    }
  }
  for (const l of lines) say(`deep-plan: ${l}`);
  if (failed.length) say(`deep-plan: state pull at session start failed for ${failed.join("; ")}`);
  if (late.length) say(`deep-plan: no time left at session start for ${late.join(", ")}; deep-plan state pull <slug> brings each`);
}

function stateStatus(slug, flags) {
  const slugs = slug ? [slug] : allStates().filter(s => s.phase !== "closed").map(s => s.slug);
  const rows = [];
  // One listing per remote and prefix, not one round trip per plan.
  const lists = new Map();
  const versionOf = (backend, s) => {
    const k = backend.where + "\0" + backend.prefix;
    if (!lists.has(k)) {
      try { lists.set(k, { map: new Map(backend.list().map(x => [x.slug, x.version])) }); }
      catch (e) { lists.set(k, { error: e.message }); }
    }
    const l = lists.get(k);
    if (l.error) throw new Error(l.error);
    return l.map.get(s) || "";
  };
  for (const s of slugs) {
    const st = readState(s);
    const o = openSync(st, { soft: true });
    if (o.error) { rows.push({ slug: s, share: !!planShare(st), state: "misconfigured", error: o.error }); continue; }
    const { backend } = o;
    let remote = "", error = "";
    try { remote = versionOf(backend, s); } catch (e) { error = e.message; }
    const meta = syncMeta(s);
    rows.push({ slug: s, share: !!planShare(st), branch: backend.branch(s), where: backend.where, remote,
      synced: meta ? meta.version : "", state: error ? "unreachable" : syncState(s, remote), ...(error ? { error } : {}) });
  }
  if (flags.json) { process.stdout.write(JSON.stringify(rows)); return; }
  if (!rows.length) { say("no tracked plans"); return; }
  for (const r of rows)
    say(`${r.slug}  ${r.share ? "shared" : "not shared"}  ` + (r.branch ? `${r.branch} on ${r.where}: ` : "") + r.state +
      (r.remote ? ` (branch ${r.remote.slice(0, 8)}` + (r.synced && r.synced !== r.remote ? `, synced here ${r.synced.slice(0, 8)})` : ")") : "") +
      (r.error ? `\n  ${r.error}` : ""));
}

function stateList(flags) {
  const { backend } = openSync(null);
  let list;
  try { list = backend.list(); } catch (e) { die(e.message); }
  if (flags.json) { process.stdout.write(JSON.stringify(list.map(x => ({ ...x, here: !!readState(x.slug) })))); return; }
  if (!list.length) { say(`no state branches under ${backend.prefix} on ${backend.where}`); return; }
  for (const x of list) say(`${x.slug}  ${x.version.slice(0, 8)}  ${readState(x.slug) ? "here" : "not here"}`);
}

function stateCmd(args, flags) {
  const [verb, slug] = args;
  if (verb === "push") return statePush(slug);
  if (verb === "pull") return statePull(slug, flags);
  if (verb === "status") return stateStatus(slug, flags);
  if (verb === "list") return stateList(flags);
  die("state push <slug> | pull <slug> [--force] [--root DIR] | status [slug] [--json] | list [--json]");
}

// `deep-plan page <slug> [--review]`: show a plan's page where this host can,
// and say where it went. One line, `served at <url> (host: <h>)`, when there
// is a live page; otherwise what to use instead.
function pageCmd(slug, flags) {
  if (!slug) die("page <slug> [--review]");
  const file = path.join(PLANS_DIR, slug + (flags.review ? ".review.html" : ".working.html"));
  const any = fs.existsSync(file) ? file : path.join(PLANS_DIR, slug + ".review.html");
  if (!fs.existsSync(any)) die(`no rendered plan ${slug} under ${PLANS_DIR}`);
  const rel = `/plan/${slug}${flags.review ? ".review.html" : ""}`;
  const { host } = detectHost();
  const quiz = path.join(PLANS_DIR, slug + ".quiz.txt");
  if (host === "remote") {
    say(`no live page on this host (remote: nobody can reach the sandbox's localhost) (host: remote)`);
    say(flags.review ? `  quiz: cat ${quiz}, then run the grade command it prints`
                     : `  share it: deep-plan export-artifact ${slug} --json, published only with the person's ok`);
    return;
  }
  if (host === "cmux") {
    let url = "";
    try {
      const cache = path.join(os.homedir(), ".cache", "cmux-crew");
      const port = parseInt(fs.readFileSync(path.join(cache, "board-intent.port"), "utf8").trim(), 10);
      if (port) url = `http://127.0.0.1:${port}${rel}`;
    } catch { /* crew's server is not running */ }
    if (!url) { say(`not served: crew's intent server is down (crew listen on); the read-only file is ${any} (host: cmux)`); return; }
    const ws = process.env.CMUX_WORKSPACE_ID || "";
    if (!ws) { say(`served at ${url} (host: cmux, but no CMUX_WORKSPACE_ID to open it in)`); return; }
    if (!companionOpen(url, companionKey("plan", slug), ws, process.env.CMUX_SURFACE_ID || ""))
      spawnSync("cmux", ["open", url, "--workspace", ws, "--focus", "false"], { encoding: "utf8", env: { ...process.env, CMUX_QUIET: "1" }, timeout: 10000 });
    say(`served at ${url} (host: cmux)`);
    return;
  }
  const url = servedUrl(rel);
  if (!url) { say(`not served: deep-plan serve did not start (see ${SERVE.LOG_FILE}); the read-only file is ${any} (host: ${host})`); return; }
  say(`served at ${url} (host: ${host})`);
  if (host === "desktop") say("  open it in the app's browser pane (preview_start with this url)");
  if (host === "terminal" && flags.review) say(`  or the text quiz: cat ${quiz}`);
}

// A patch of everything since the increment started — committed, uncommitted
// and untracked. Always written; only OPENED when the human asked for a diff.
//
// `done` used to open it in `cmux diff` automatically. That is removed: a state
// transition should not seize a browser split. It stole focus on every `done`,
// and `cmux diff` defaults its target to $CMUX_WORKSPACE_ID — which is unset
// when `done` arrives from the board's chip or any detached process, so the
// split landed somewhere unrelated or not at all. The patch file is the durable
// part and it still gets written; `deep-plan diff <slug> [n]` opens it, which
// is the point at which someone has actually asked to look.
function incrementDiff(st, inc, { open = false, base = "" } = {}) {
  const sha = inc.startSha || base;
  if (!sha || !st.root) return;
  // `add -AN` (so untracked files show) runs on a scratch copy of the index:
  // on the real one it left intent-to-add entries for `git commit -a` to sweep
  // up. The copy keeps the index's mtime, or git trusts racily-clean entries.
  const tmp = path.join(os.tmpdir(), `deep-plan-diff-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    const index = execSync("git rev-parse --path-format=absolute --git-path index",
      { cwd: st.root }).toString().trim();
    if (fs.existsSync(index)) {
      fs.copyFileSync(index, tmp);
      const s = fs.statSync(index);
      fs.utimesSync(tmp, s.atime, s.mtime);
    }
    execSync("git add -AN", { cwd: st.root, env });
    const patch = execSync(`git diff ${sha}`, { cwd: st.root, env, maxBuffer: 64e6 }).toString();
    if (!patch.trim()) return;
    const p = path.join(PLANS_DIR, `${st.slug}.inc${inc.n}.patch`);
    fs.writeFileSync(p, patch);
    const how = `  view: git -C ${st.root} diff ${sha.slice(0, 8)}` +
      `\n  or:   deep-plan diff ${st.slug} ${inc.n}`;
    if (!open) { say(`patch: ${p}\n${how}`); return; }
    const title = `${st.slug} · increment ${inc.n} since ${sha.slice(0, 8)}`;
    const r = spawnSync("cmux", ["diff", "--title", title, p], { stdio: "ignore" });
    if (r.error || r.status !== 0) say(`patch: ${p}\n${how}`);
  } catch { /* the patch is a courtesy, never a failure */ }
  finally { for (const f of [tmp, tmp + ".lock"]) fs.rmSync(f, { force: true }); }
}

// ---------------------------------------------------------------- status

function stateMtime(slug) {
  try { return Math.round(fs.statSync(statePath(slug)).mtimeMs); } catch { return 0; }
}

// `status --json` stays a read (the pane polls it), so a running check whose
// runner died is not reaped here, only reported as `lost`: the same judgment
// reapLost makes, without the write. The next `check run|status|wait` records it.
function shownStatus(v, status = v.status) {
  return status === "running" && runnerGone(v) ? "lost" : status;
}

function statusRows() {
  const fams = familiesBySlug();
  return allStates().filter(st => st.phase !== "closed").map(st => ({
    slug: st.slug, root: st.root || "", phase: st.phase,
    // The root with symlinks resolved, as the gate compares it: a session in
    // /private/tmp/x is inside a plan rooted at /tmp/x on macOS.
    realRoot: st.root ? canon(st.root) : "",
    rootBroken: !!(st.root && !fs.existsSync(st.root)),
    gate: familyGate(st), progress: progress(st), session: st.session || "",
    approved: (st.approved && st.approved.path) || "",
    // Who touched the plan last from inside a session, and when. The pane ranks
    // plans by these when several could be the session's. A plan from before
    // owners were stamped has no owner, only its state file's own time.
    owner: st.owner || null,
    touchedAt: (st.owner && st.owner.at) || stateMtime(st.slug),
    // Who this plan is to its family, when it is in one; absent otherwise, so
    // a reader that predates families sees the row it always saw.
    ...(fams.has(st.slug) ? { family: familyRow(fams.get(st.slug), st.slug) } : {}),
    // Checks still outstanding. Their increments cannot go `done` without
    // --force, so a plan that looks one step from finished may not be — the
    // board reads this from --json. A pass is taken as recorded here; whether
    // it went stale is judged at `done`, which hashes the tree.
    // A push that did not land: shown until one does (sync on transitions).
    ...((m => m && m.failed ? { unsynced: m.failed } : {})(syncMeta(st.slug))),
    checksOutstanding: (st.increments || []).flatMap(i =>
      checksBlock(i).map(c => ({ n: i.n, id: c.id, kind: c.kind, status: shownStatus(checksOf(i)[c.id], c.status) }))),
    // The pre-checks shape, one entry per increment, kept for older readers.
    obsOutstanding: (st.increments || []).filter(i => checksBlock(i).length)
      .map(i => ({ n: i.n, status: checksAggregate(i) })),
    // Every increment's own row, for a reader that draws the whole plan (the
    // seamux-mods pane) rather than the board's one-line summary. `obs` is the
    // checks folded to one word, for a pane built before checks.
    increments: (st.increments || []).map(i => ({
      n: i.n, title: i.title, status: i.status, obs: checksAggregate(i), by: i.by || "",
      checks: Object.entries(checksOf(i)).filter(([, v]) => !v.retired).map(([id, v]) => {
        const status = shownStatus(v) || "pending";
        return {
          id, kind: v.kind || "", name: v.name || "", status,
          note: status === "lost" ? `runner lost: pid ${v.runner.pid || "?"} exited without a verdict` : v.note || "",
          at: v.at || 0, ...(v.recipe ? { recipe: v.recipe } : {}),
          // A browser check's frames, step and replay, for the board's
          // thumbnail and the plan page; absent for every other check.
          ...((ev => ev ? { evidence: ev } : {})(evidenceOf(st.slug, v))),
          // A claim's open question (the Dock's picker) and what a run holds.
          ...(v.ask && (status === "running" || status === "needs-value") ? { ask: v.ask } : {}),
          ...(v.claims && v.claims.length ? { claims: v.claims.map(({ env, ...c }) => c) } : {}),
        };
      }),
    })),
  }));
}

// gateView, plus why a shut gate will stay shut: a family child waiting on
// its parent. Only the reason grows; `allow` is gateView's.
function familyGate(st) {
  const g = gateView(st);
  if (g.allow) return g;
  const waits = waitingOn(st.slug);
  let why = waits.length ? `${g.why} go waits on ${waitText(waits)}.` : g.why;
  const own = goOwner(st.slug);
  if (own && own.hold) why += ` The parent is holding it: "${own.hold.reason}".`;
  else if (own && own.delegated) why += ` Its go is the parent's to give (${own.parent}).`;
  return why === g.why ? g : { ...g, why };
}

// On the remote host, state outside the repo goes with the sandbox: the next
// one has no plan, and its gate is open. Said on every status.
function remoteStateWarning() {
  if (detectHost().host !== "remote") return "";
  const top = REMOTE_DIR ? path.dirname(path.dirname(REMOTE_DIR)) : "";
  if (top && STATE_DIR.startsWith(top + path.sep)) return "";
  return `⚠ remote host, but plan state is at ${STATE_DIR}, outside the repo: a new sandbox starts without it and the gate fails open. ` +
    "Unset DEEP_PLAN_STATE_DIR, or move it with deep-plan export-state / import-state.";
}

function status(json) {
  const rows = statusRows();
  const warn = remoteStateWarning();
  if (warn) console.error(warn);
  if (json) { process.stdout.write(JSON.stringify(rows)); return; }
  if (!rows.length) { say("no tracked plans"); return; }
  for (const r of rows) {
    say(`${r.slug}  [${r.phase}]  ${r.gate.allow ? "gate open" : "GATE SHUT"} — ${r.gate.why}`);
    say(`  root ${r.root}${r.rootBroken ? "  ⚠ BROKEN ROOT — gone; the gate FAILS OPEN here" : ""}`);
    if (r.approved) say(`  approved snapshot ${r.approved}`);
    if (r.unsynced) say(`  ⚠ unsynced: the last push to its state branch failed (${r.unsynced.why}) — deep-plan state push ${r.slug}`);
    if (r.obsOutstanding.length)
      say("  checks outstanding: " +
        r.obsOutstanding.map(o => `${o.n} (${o.status})`).join(", ") +
        " — `deep-plan check list <slug> <n>` for what to run");
    if (r.family) {
      const f = r.family;
      say(`  family ${f.parent} (${f.role})` +
        (f.waitingOn.length ? ` · go waits on ${f.waitingOn.map(w => `${f.parent} ${w.n}`).join(", ")}` : "") +
        (f.trespasses.total ? ` · ${f.trespasses.total} overlap(s) recorded` : "") +
        (f.news ? ` · ${f.news} news` : "") + (f.done ? " · family done" : ""));
    }
    say(`  ${r.progress.done}/${r.progress.total} increments` +
      (r.progress.next ? ` · next: ${r.progress.next.n}. ${r.progress.next.title}` : "") +
      (r.progress.blocked.length ? ` · blocked: ${r.progress.blocked.map(b => b.title).join(", ")}` : ""));
  }
}

// ---------------------------------------------------------------- checks

// `check list` prints the increment's checks from state, which render filled
// from the spec: what each one is, what it runs, and where its verdict stands.
// A pass is judged against the tree as it is now, the way `done` will judge it.
function checkList(slug, n) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  const all = Object.entries(checksOf(inc)).filter(([, v]) => !v.retired);
  say(`${slug} increment ${inc.n}: ${inc.title}`);
  if (!all.length) {
    say("\nthis increment declares no checks, so `done` is not gated on one.");
    say(`to gate it, add "checks" to deliverables[${inc.n - 1}] and re-render.`);
    return;
  }
  const stale = new Set(checksBlock(inc, needsTree(inc) ? treeOf(st.root) : null)
    .filter(c => c.status === "stale").map(c => c.id));
  say(`\n${all.length} check(s):`);
  for (const [id, v] of all) {
    const s = stale.has(id) ? "stale — passed against other content than the tree now" : v.status || "pending";
    say(`\n  ${CHECK_MARK[stale.has(id) ? "stale" : v.status] || "·"} ${id}  [${v.kind}${v.system ? " · " + v.system : ""}] ${s}`);
    say(`    ${v.name}`);
    if (v.recipe) say(`    recipe: ${v.recipe}  (its verdict comes from running it; a hand pass needs --force)`);
    const browserStep = ((v.exec && v.exec.steps) || []).find(x => x.kind === "browser");
    if (browserStep) say(`    script: ${browserStep.command}`);
    if (v.exec && v.exec.scripts && v.exec.scripts.length) say(`    setup:  ${v.exec.scripts.join(", ")}`);
    if (v.exec && v.exec.brief) say(`    brief:  ${v.exec.brief}`);
    if (v.run) say(`    run:    ${v.run}`);
    if (v.query) say(`    query:  ${v.query}`);
    if (v.expect) say(`    expect: ${v.expect}`);
    if (v.hint) say(`    about:  ${v.hint}`);
    if (v.note) say(`    seen:   ${v.note}`);
  }
  say(`\nrecord one:  deep-plan check pass|fail ${slug} ${inc.n} <id> "<what you saw>"`);
}

// A verdict recorded by hand. A pass records the tree it was seen against, so
// an edit after it sends the increment's `done` back to "stale". A check backed
// by a recipe gets its verdict from the recipe's exit code; passing one by hand
// is refused unless forced, and the force is logged — the same bargain as
// `done --force`.
function checkRecord(slug, n, ids, verdict, note, force) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  const checks = checksOf(inc);
  const active = Object.keys(checks).filter(id => !checks[id].retired);
  for (const id of ids)
    if (!active.includes(id))
      die(`increment ${n} has no check "${id}"\n` + (active.length
        ? `  its checks: ${active.join(", ")}`
        : `  it declares none — add "checks" to the spec's deliverables[${inc.n - 1}] and re-render first`));
  if (verdict === "fail" && !note)
    die(`say what failed: deep-plan check fail ${slug} ${n} ${ids.length === 1 ? ids[0] : "<id>"} "<what you saw>"`);
  const recipes = ids.filter(id => checks[id].recipe);
  if (verdict === "pass" && recipes.length && !force)
    die(`${recipes.join(", ")} ${recipes.length === 1 ? "is" : "are"} backed by a recipe, so the verdict ` +
      `comes from running it (\`deep-plan check run\`), not from a note.\n` +
      `  pass by hand anyway, logged:  deep-plan check pass ${slug} ${n} ${recipes[0]} "<why>" --force\n\n` +
      `refused: ${recipes.join(", ")} recipe-backed — a hand pass needs --force`);
  const tree = verdict === "pass" ? treeOf(st.root) : null;
  for (const id of ids) {
    const { ran, tree: _t, runner, acquire, ...rest } = checks[id];
    const forced = verdict === "pass" && !!checks[id].recipe;
    checks[id] = { ...rest, status: verdict, at: Date.now(), note: note || "",
      by: forced ? "hand, forced" : "hand", ...(tree ? { tree } : {}) };
    log1(st, `check ${verdict}: increment ${inc.n} ${id}` +
      (forced ? " (recipe-backed, passed by hand with --force)" : "") + (note ? ` — ${note}` : ""));
  }
  writeState(st); rerenderWorking(slug);
  say(`recorded ${verdict} for ${slug} ${inc.n}: ${ids.join(", ")}` +
    (verdict === "pass" ? "" : " — `done` stays blocked until it passes"));
}

// The explicit hatch: the checks changed, or a verdict is stale for a reason
// the engine cannot see. Increment `reset` re-gates on its own, so this is for
// when the work stands but the evidence does not. No id means every verdict.
function checkReset(slug, n, id, ids = null) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  const checks = checksOf(inc);
  const want = ids || (id ? [id] : Object.keys(checks).filter(k => !checks[k].retired));
  if (id && !(checks[id] && !checks[id].retired)) die(`increment ${n} has no check "${id}"`);
  if (!want.length) die(`increment ${n} has no check verdict to reset`);
  const was = want.map(k => `${k} (was ${checks[k].status || "pending"})`);
  repend(inc, want, "reset by hand");
  log1(st, `check reset: increment ${inc.n} — ${was.join(", ")}`);
  writeState(st); rerenderWorking(slug);
  say(`back to pending for ${slug} ${inc.n}: ${was.join(", ")} — \`done\` is blocked again`);
}

// ---------------------------------------------------------------- check run

// `check run` executes a recipe-backed check exactly as render stored it, and
// records the verdict from the exit code. Cheap recipes run here, in the
// foreground. Expensive ones — a deploy wait plus e2e can take longer than an
// agent's foreground limit — run in a detached copy of this CLI (`--inline
// --log --token <token>`), which writes the log and the verdict itself; `check
// status` and `check wait` follow it. A runner that dies without a verdict is
// found by its pid and recorded as `fail: runner lost`.

function runsDir(slug) {
  const d = path.join(PLANS_DIR, slug + ".runs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const fileSafe = s => String(s).replace(/[^a-z0-9._-]+/gi, "_");
const hasBrowserStep = exec => !!(exec && (exec.steps || []).some(s => s.kind === "browser"));
const hasClaimStep = exec => !!(exec && (exec.steps || []).some(s => s.kind === "claim"));
const locksDir = () => path.join(PLANS_DIR, "locks");

// The shell a detached claiming run lives under ($1 node, $2 engine, $3-$6
// slug n id token, the rest the run's own argv). On SIGTERM/INT/HUP it stops
// the step in flight, gives the run three seconds to release and record its
// verdict, then stops it and runs `check release` for whatever is left.
const CLAIM_RUNNER = `n="$1"; e="$2"; s="$3"; i="$4"; c="$5"; t="$6"; shift 6
"$n" "$e" "$@" & child=$!
trap 'trap - TERM INT HUP; pkill -TERM -P $child 2>/dev/null; (sleep 3; kill -TERM $child 2>/dev/null) & wait $child 2>/dev/null; "$n" "$e" check release "$s" "$i" "$c" --terminated --token "$t"; exit 143' TERM INT HUP
wait $child`;

// What a claim step tells the check while it runs: the question it asks a
// person (for the Dock's picker), the answer if one came in, and what it holds.
// Every write is the runner's own (token) and stamped, for the merge.
function claimHooks(slug, n, id, token) {
  const update = f => {
    const s2 = readState(slug), c2 = checksOf(findInc(s2, n))[id];
    // Another run's check is not this run's to write; a check reset under a
    // run (no runner now) still is, so what it holds and gives back is told.
    if (!c2 || (c2.runner && c2.runner.token !== token)) return;
    f(c2); c2.at = Date.now(); writeState(s2);
  };
  return {
    ask: q => update(c => { if (q) c.ask = q; else delete c.ask; }),
    answer: () => {
      const c = checksOf(findInc(readState(slug), n))[id];
      if (!c || !c.answer) return null;
      return !c.ask || !c.ask.name || c.answer.name === c.ask.name ? c.answer.value : null;
    },
    held: list => update(c => { c.claims = list.map(x => ({ release: x.release, lock: x.lock, name: x.name, value: x.value, env: x.env })); }),
    released: () => update(c => { delete c.claims; }),
  };
}
// One repl session per check, so its tabs outlive a run (for `open tab`) and
// a re-run lands in the same tab group rather than a new one each time.
const replSession = (slug, n, id) => fileSafe(`dp-${slug}-${n}-${id}`).slice(0, 80);
const pidFile = (slug, n, id) => path.join(runsDir(slug), `inc${n}-${fileSafe(id)}.pid`);
const secs = ms => ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round(ms % 60000 / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;

// A running check's runner is gone. A runner is recorded before it is
// spawned, so a missing pid gets a grace period rather than an instant verdict.
function runnerGone(v) {
  if (!v.runner) return false;
  return v.runner.pid ? !alive(v.runner.pid) : Date.now() - (v.runner.startedAt || 0) > 30000;
}

// Running checks whose runner is gone. Judged on a FRESH read after the pid is
// seen dead: a runner writes its verdict before it exits, so a check still
// "running" once its pid is gone never got one. Writes and returns the state.
function reapLost(slug) {
  const st = readState(slug) || die("no plan " + slug);
  let lost = 0;
  for (const inc of st.increments || []) {
    for (const [id, v] of Object.entries(checksOf(inc))) {
      if (v.status !== "running" || !runnerGone(v)) continue;
      // A lost browser run's evidence is its own (what it got to before it
      // died), never the previous run's: the board's thumbnail reads it.
      const { runner, evidence: _old, ...rest } = v;
      const ev = runner.evidence ? evidenceSummary(readEvidence(runsDir(slug), runner.evidence, { live: true })) : null;
      if (ev) rest.evidence = { ...ev, live: false };
      inc.checks[id] = { ...rest, status: "fail", at: Date.now(), by: "runner",
        note: `runner lost: pid ${runner.pid || "?"} exited without a verdict (log: ${runner.log})` +
          (v.claims && v.claims.length ? ` — it holds ${v.claims.map(c => c.lock || c.release || c.name).join(", ")}: deep-plan check release ${slug} ${inc.n} ${id}` : ""),
        ran: { log: runner.log, code: -1 } };
      try { fs.rmSync(pidFile(slug, inc.n, id), { force: true }); } catch { /* gone */ }
      log1(st, `check fail: increment ${inc.n} ${id} — runner lost (pid ${runner.pid || "?"})`);
      lost++;
    }
  }
  if (lost) { writeState(st); rerenderWorking(slug); }
  return st;
}

// A recipe edited after render is not what was reviewed. The run uses the
// stored version and says so; a re-render adopts the edit (and re-pends any
// pass recorded against the old one).
function recipeDrift(st, v) {
  if (v.synth) return "";                // synthesized by deep-plan: no recipe file to drift from
  try {
    const at = v.recipe.includes("@") ? v.recipe.slice(v.recipe.indexOf("@") + 1) : "";
    const cur = resolver(st.root).available(path.join(st.root, at)).find(r => r.key === v.recipe);
    if (!cur) return `recipe ${v.recipe} is no longer in ${v.source}; running the version that was reviewed`;
    if (cur.hash !== v.hash)
      return `recipe ${v.recipe} changed in ${v.source} since render (#${v.hash} → #${cur.hash}); ` +
        "running the version that was reviewed — re-render to adopt the edit";
  } catch { /* drift is advice; it never stops a run */ }
  return "";
}

function checkRun(slug, n, ids, opts) {
  let st = reapLost(slug);
  const inc = findInc(st, n);
  const checks = checksOf(inc);
  const active = Object.keys(checks).filter(id => !checks[id].retired);
  for (const id of ids) {
    if (!active.includes(id)) die(`increment ${n} has no check "${id}"\n  its checks: ${active.join(", ") || "none"}`);
    const v = checks[id];
    if (!v.recipe) die(`${id} is a ${v.kind} check with no recipe — there is nothing to run.\n` +
      `  record what you saw: deep-plan check pass|fail ${slug} ${n} ${id} "<what you saw>"\n\n` +
      `refused: ${id} has no recipe to run`);
    if (!v.exec) die(`${id} names recipe ${v.recipe}, but its steps were never stored — re-render the plan`);
  }
  let want = ids;
  if (!ids.length) {
    const tree = needsTree(inc) ? treeOf(st.root) : null;
    const stale = new Set(checksBlock(inc, tree).filter(c => c.status === "stale").map(c => c.id));
    want = active.filter(id => checks[id].recipe && checks[id].exec &&
      checks[id].status !== "running" && (checks[id].status !== "pass" || stale.has(id)));
    if (!want.length) {
      say(`nothing to run for ${slug} ${inc.n}: every recipe-backed check has passed against this tree or is running`);
      return 0;
    }
  }

  const lines = [];
  let failed = 0;
  const kickoffs = [];         // reviews this run opened, for the spawn instruction
  for (const id of want) {
    st = readState(slug);
    const cur = checksOf(findInc(st, n))[id];
    const own = opts.token && cur.runner && cur.runner.token === opts.token;
    // A detached runner whose attempt was reset or replaced before it got
    // going has nothing to do: running it anyway would land a verdict nobody
    // asked for under an attempt of its own.
    if (opts.token && !own) {
      log1(st, `check run: increment ${inc.n} ${id} — a runner started after its attempt was reset or replaced; it did nothing`);
      writeState(st);
      say(`${id}: this runner's attempt was reset or replaced before it started — nothing run`);
      continue;
    }
    // A review check's run ends by telling this session to spawn a reviewer;
    // detached, nobody would read it.
    if (opts.detach && cur.synth === "review") die(`${id} is a review check: run it from the session, where its reviewer is spawned`);
    // A person's answer to a running claim's question: handed to the run,
    // which takes it on its next poll. Whichever lands first wins.
    if (cur.status === "running" && cur.runner && !own && alive(cur.runner.pid) && opts.set) {
      const [name, value] = Object.entries(opts.set)[0];
      if (!cur.ask) die(`${id} is running but asks for nothing right now — there is no claim to answer`);
      if (cur.ask.name && cur.ask.name !== name)
        die(`${id} is asking for ${cur.ask.name}, not ${name}: --set ${cur.ask.name}=<value>`);
      const s2 = readState(slug), c2 = checksOf(findInc(s2, n))[id];
      c2.answer = { name, value, at: Date.now() }; c2.at = Date.now();
      log1(s2, `check answer: increment ${inc.n} ${id} — ${name}=${value}`);
      writeState(s2);
      say(`✋ handed ${name}=${value} to the running ${id} — it takes it on its next poll`);
      lines.push(`${id} answered`);
      continue;
    }
    if (cur.status === "running" && cur.runner && !own && alive(cur.runner.pid)) {
      say(`🔄 ${id} is already running (pid ${cur.runner.pid}) — deep-plan check wait ${slug} ${n} ${id}`);
      lines.push(`${id} already running`);
      continue;
    }
    // An answer to a parked claim resumes from it: reaching needs-value means
    // any acquire steps before it were already a person's to run, and were.
    if (opts.set && cur.status === "needs-value" && !opts.from) opts = { ...opts, from: "claim" };
    // A lost run's claims are still out there; a new run would forget them.
    if (!own && cur.claims && cur.claims.length && cur.status !== "running") {
      say(`✋ ${id} still holds ${cur.claims.map(c => c.lock || c.release || c.name).join(", ")} from its last run — ` +
        `give it back first: deep-plan check release ${slug} ${n} ${id}`);
      lines.push(`${id} holds claims`); failed++;
      continue;
    }
    const drift = recipeDrift(st, cur);
    if (drift && !opts.token) console.error("  ⚠ " + drift);

    // An acquire step is a person's: stop before anything runs, and say what
    // to run and how to resume. Never executed here, not even with a `go`.
    const acquire = acquireSteps(cur.exec);
    if (acquire.length && !opts.from) {
      const { runner, ...rest } = cur;
      checksOf(findInc(st, n))[id] = { ...rest, status: "needs-variant", at: Date.now(), by: "runner",
        note: `a person runs: ${acquire.map(s => s.command).join(" && ")}`,
        acquire: acquire.map(s => ({ command: s.command, note: s.note || "" })) };
      log1(st, `check needs-variant: increment ${inc.n} ${id}`);
      writeState(st); rerenderWorking(slug);
      say(`✋ ${id} needs a variant. A person runs${acquire.length > 1 ? " these" : " this"} — the engine never does:`);
      for (const s of acquire) say(`     ${s.command}${s.note ? `   (${s.note})` : ""}`);
      say(`   then: deep-plan check run ${slug} ${n} ${id} --from wait`);
      lines.push(`${id} needs a variant — run it, then check run ${slug} ${n} ${id} --from wait`);
      continue;
    }

    const token = own ? opts.token : crypto.randomBytes(6).toString("hex");
    const log = own && opts.log ? opts.log
      : path.join(runsDir(slug), `inc${n}-${fileSafe(id)}-${Date.now()}.log`);

    if ((cur.exec.tier === "expensive" || opts.detach) && !opts.inline) {
      // Recorded before the spawn, so the runner finds its token on its first
      // read; the pid follows once there is one.
      const startedAt = Date.now();
      const set = pid => {
        const s2 = readState(slug), c2 = checksOf(findInc(s2, n));
        // Once the child exists it may already have written (its evidence
        // directory, a claim's question): the pid is patched in, stamped, and
        // nothing of the child's is replaced.
        if (pid) {
          const cur2 = c2[id];
          if (cur2 && cur2.runner && cur2.runner.token === token) {
            cur2.runner = { ...cur2.runner, pid }; cur2.at = Math.max(Date.now(), (cur2.at || 0) + 1); writeState(s2);
          }
          return;
        }
        // A new run starts with no question, answer or claim of the last one's.
        const { ran, ask, answer, claims, ...rest } = c2[id];
        c2[id] = { ...rest, status: "running", at: startedAt, by: "runner",
          note: `running since ${new Date(startedAt).toISOString().slice(11, 19)}Z`,
          runner: { token, pid, log, startedAt, from: opts.from || "" } };
        if (!pid) log1(s2, `check run: increment ${inc.n} ${id} started detached (log: ${log})`);
        writeState(s2);
      };
      set(0);
      const fd = fs.openSync(log, "a");
      const runArgs = ["check", "run", slug, String(n), id, "--inline", "--log", log, "--token", token,
        ...(opts.from ? ["--from", opts.from] : []),
        ...Object.entries(opts.set || {}).flatMap(([k, v]) => ["--set", `${k}=${v}`])];
      // A run that claims something runs under a shell that traps SIGTERM,
      // SIGINT and SIGHUP: the step in flight is stopped, the run releases
      // what it holds as it ends, and `check release` sweeps up after it.
      // Only a SIGKILL or a crash leaves a claim held.
      const child = hasClaimStep(cur.exec)
        ? spawn("sh", ["-c", CLAIM_RUNNER, "dp-runner", process.execPath, path.join(HERE, "deep_plan.mjs"),
            slug, String(n), id, token, ...runArgs],
          { detached: true, stdio: ["ignore", fd, fd], cwd: st.root, env: { ...process.env } })
        : spawn(process.execPath, [path.join(HERE, "deep_plan.mjs"), ...runArgs],
          { detached: true, stdio: ["ignore", fd, fd], cwd: st.root, env: { ...process.env } });
      child.unref(); fs.closeSync(fd);
      set(child.pid);
      fs.writeFileSync(pidFile(slug, n, id), JSON.stringify({ pid: child.pid, token, log, startedAt }) + "\n");
      rerenderWorking(slug);
      say(`🔄 ${id} started detached (pid ${child.pid}) — log: ${log}`);
      lines.push(`${id} running detached — deep-plan check wait ${slug} ${n}`);
      continue;
    }

    // In the foreground (or this IS the detached runner): mark it running,
    // run, then record — unless the check was reset or re-run meanwhile, in
    // which case this verdict belongs to an attempt nobody is waiting on.
    // A browser run leaves its frames in a directory of its own, named on the
    // runner while it goes so the surfaces can follow it live.
    const evidence = hasBrowserStep(cur.exec) ? newEvidenceDir(runsDir(slug), n, id) : "";
    if (!own) {
      const { ran, ask, answer, claims, ...rest } = cur;
      checksOf(findInc(st, n))[id] = { ...rest, status: "running", at: Date.now(), by: "runner",
        note: "running in the foreground", runner: { token, pid: process.pid, log, startedAt: Date.now(), from: opts.from || "",
          ...(evidence ? { evidence } : {}) } };
      writeState(st);
    } else if (evidence) {
      const s2 = readState(slug), c2 = checksOf(findInc(s2, n))[id];
      // Stamped: writeState merges concurrent writes by each check's `at`.
      if (c2 && c2.runner && c2.runner.token === token) { c2.runner = { ...c2.runner, evidence }; c2.at = Date.now(); writeState(s2); }
    }
    // No signal listeners here: node cannot run one while a step or a poll's
    // sleep holds the thread, so a listener would only swallow the signal. A
    // detached claiming run lives under CLAIM_RUNNER, whose trap stops the
    // step (the run then releases on its way out) or, failing that, the run,
    // and then runs `check release`. A claim left by an --inline run killed
    // by hand is held, named by check status, and given back by check release.
    const tree = treeOf(st.root);
    const exec = cur.synth === "review" ? reviewExec(cur, slug, n) : cur.exec;
    const res = runExec(exec, { root: st.root, from: opts.from || "", log,
      env: { DEEP_PLAN_SLUG: slug, DEEP_PLAN_INCREMENT: String(n), DEEP_PLAN_CHECK: id,
             DEEP_PLAN_ROOT: st.root || "", DEEP_PLAN_START_SHA: findInc(st, n).startSha || "" },
      browser: { runsDir: runsDir(slug), evidence, session: replSession(slug, n, id) },
      claim: { preset: opts.set || {}, locksDir: locksDir(), owner: { slug, n: String(n), id },
        hooks: claimHooks(slug, n, id, token) } });
    if (cur.synth === "review" && res.status === "fail") {
      const code = res.ran && res.ran.code;
      if (code === 3) {
        // No verdict yet: the engine opens the review itself (a re-open of one
        // already there refreshes it to the tree now), and the session is told
        // to spawn the reviewer. It stays failed until a reviewer reports.
        const o = openReview(readState(slug), findInc(readState(slug), n));
        res.note = o.ok ? `review opened, no reviewer yet — spawn ONE fresh reviewer subagent with lookout prompt ${reviewId(slug, n)}`
          : `no verdict yet, and the review could not be opened: ${(o.out || "").split("\n").pop()}`;
        if (o.ok) kickoffs.push({ out: o.out, agent: o.agent });
      } else res.note = code === 127 ? LOOKOUT_MISSING
        : code === 1 ? "a blocker or major finding is open — the human closes it on the review page"
        : res.note;
    }
    const fresh = readState(slug);
    const now = checksOf(findInc(fresh, n))[id];
    if (!now || !now.runner || now.runner.token !== token) {
      log1(fresh, `check run: increment ${inc.n} ${id} finished ${res.status}, but the check was reset ` +
        "or re-run meanwhile — this verdict was discarded");
      writeState(fresh);
      say(`${id}: finished ${res.status}, but the check changed while it ran — verdict discarded`);
      continue;
    }
    // A run's evidence replaces the last one's, and a browser run that left
    // none (it failed before the browser step) clears it.
    // `claims` stays: the run's release hook cleared it, unless a release
    // failed and the claim is still held for `check release`.
    const { runner, ask, answer, ...rest } = now;
    if (evidence) delete rest.evidence;
    // A parked claim keeps its question for the Dock's picker; anything else
    // is over.
    if (res.status === "needs-value" && ask) rest.ask = ask;
    const ev = evidence ? evidenceSummary(readEvidence(runsDir(slug), evidence)) : null;
    if (evidence) pruneEvidence(runsDir(slug), n, id);
    checksOf(findInc(fresh, n))[id] = { ...rest, status: res.status, at: Date.now(), by: "runner",
      note: res.note, ran: res.ran, ...(res.status === "pass" && tree ? { tree } : {}),
      ...(ev ? { evidence: ev } : {}) };
    log1(fresh, `check ${res.status}: increment ${inc.n} ${id} — ${res.note}`);
    // The pidfile goes before the verdict lands: whoever waits on the verdict
    // (check wait, the pane) must never find a finished run's pidfile, and the
    // re-render after the write is slow on a busy machine. A lost runner is
    // judged by its pid, not by this file.
    try { if (own) fs.rmSync(pidFile(slug, n, id), { force: true }); } catch { /* gone */ }
    writeState(fresh); rerenderWorking(slug);
    if (res.status === "pass") say(`✅ ${id} pass — ${res.note} (log: ${log})`);
    else if (res.status === "needs-value") {
      const q = ask || {};
      say(`✋ ${id} needs a value — ${q.question || res.note}`);
      if (q.choices && q.choices.length) say(`   choices: ${q.choices.join(", ")}`);
      say(`   then: deep-plan check run ${slug} ${n} ${id} --from claim --set ${q.name || "NAME"}=<value>   (or pick it on the Dock)`);
      lines.push(`${id} needs a value`);
      continue;
    } else if (res.status === "needs-variant") {
      // No browser driver here: a person installs one, or records it by hand.
      say(`✋ ${id} needs a variant — ${res.note}`);
      lines.push(`${id} needs a variant`);
      continue;
    } else {
      failed++;
      say(`❌ ${id} fail — ${res.note} (log: ${log})`);
      if (res.ran.tail) say(res.ran.tail.split("\n").map(l => "     " + l).join("\n"));
      // What the developer wrote for whoever repairs it: the suite it runs
      // against and how to extend it. The agent reads this before a fix.
      if (cur.exec && cur.exec.brief) say(`   brief: ${cur.exec.brief}`);
      if (ev) say(`   evidence: ${path.join(runsDir(slug), ev.dir)} (${ev.frames} frame(s)) — deep-plan check evidence ${slug} ${n} ${id}`);
    }
    lines.push(`${id} ${res.status}`);
  }
  if (lines.length > 1 || failed) say(`\ncheck run ${slug} ${n}: ${lines.join("; ")}`);
  if (kickoffs.length) {
    const k = kickoffs[kickoffs.length - 1];
    say("\n" + k.out + "\n\n" + spawnHint(slug, n, k));
    say(spawnLine(slug, n));
  }
  return failed ? 1 : 0;
}

// Where each check stands; a running one with its elapsed time, pid and the
// tail of its log, so "is it stuck?" has an answer without opening anything.
// Give back what a run claimed and never released: a runner killed with
// SIGKILL, or one the claim runner's trap stopped (--terminated). Runs each
// claim's release with the env it claimed under and drops its lock. Refused
// while the run is alive, unless it is the trap's own call (--terminated).
function checkRelease(slug, n, id, { terminated = false, token = "", force = false } = {}) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  const v = checksOf(inc)[id] || die(`increment ${n} has no check "${id}"`);
  const mine = token && v.runner && v.runner.token === token;
  if (v.status === "running" && v.runner && alive(v.runner.pid) && !(terminated && mine) && !force)
    die(`${id} is still running (pid ${v.runner.pid}); it releases its claims when it ends. Stop it first, or --force`);
  if (terminated && token && v.runner && !mine) return 0;         // a newer run owns the check now
  const claims = v.claims || [];
  const log = (v.runner && v.runner.log) || (v.ran && v.ran.log) || path.join(runsDir(slug), `inc${n}-${fileSafe(id)}-release-${Date.now()}.log`);
  const cwd = path.resolve(st.root || ".", (v.exec && v.exec.cwd) || ".");
  const { said, failed } = claims.length ? releaseClaims(claims, { cwd, log, locksDir: locksDir(), pid: -1 }) : { said: [], failed: [] };
  const fresh = readState(slug), c = checksOf(findInc(fresh, n))[id];
  const { runner, claims: _c, ask, answer, ...rest } = c;
  if (failed.length) rest.claims = failed;
  const wasRunning = c.status === "running";
  checksOf(findInc(fresh, n))[id] = { ...rest, at: Date.now(),
    ...(wasRunning ? { status: "fail", by: "runner", note: `terminated${said.length ? `; released: ${said.join("; ")}` : ""}`,
      ran: { log, code: -1, signal: terminated ? "SIGTERM" : "" } } : {}),
    ...(!wasRunning && said.length ? { note: `${c.note || ""}${c.note ? " — " : ""}released: ${said.join("; ")}` } : {}) };
  log1(fresh, `check release: increment ${inc.n} ${id}${said.length ? ` — ${said.join("; ")}` : " — nothing held"}`);
  try { fs.rmSync(pidFile(slug, n, id), { force: true }); } catch { /* gone */ }
  writeState(fresh); rerenderWorking(slug);
  say(said.length ? `released for ${id}: ${said.join("; ")}` : `${id} holds nothing to release`);
  if (failed.length) { say(`   still held (its release failed): ${failed.map(x => x.release).join(", ")} — fix it and run check release again`); return 1; }
  return 0;
}

// A check's browser evidence: the running run's (synced from the recorder as
// it is read, so the Dock's filmstrip fills while it goes) or the last one's.
function evidenceOf(slug, v, { full = false } = {}) {
  if (!v) return null;
  const liveRel = v.status === "running" && v.runner && v.runner.evidence;
  const rel = liveRel || (v.evidence && v.evidence.dir);
  if (!rel) return null;
  const ev = readEvidence(path.join(PLANS_DIR, slug + ".runs"), rel, { live: !!liveRel });
  if (!ev) return null;
  return full ? { ...ev, root: path.join(PLANS_DIR, slug + ".runs") } : evidenceSummary(ev);
}

// The files a check's run depends on that changed in this increment: its
// browser script and its setup scripts, against the increment's start sha
// (tracked edits and new files alike). The surfaces flag them, so an agent's
// repair of a check is never invisible.
function scriptsChanged(st, inc, v) {
  const exec = v.exec || {};
  const browser = (exec.steps || []).filter(s => s.kind === "browser").map(s => path.posix.join(exec.cwd || ".", s.command));
  const files = [...browser, ...(exec.scripts || [])].map(f => path.posix.normalize(f));
  if (!files.length || !st.root || !inc.startSha) return [];
  // argv, not a shell string: the paths come from a repo's recipe file.
  const git = args => { try { return execFileSync("git", [...args, "--", ...files],
    { cwd: st.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); } catch { return []; } };
  return [...new Set([...git(["diff", "--name-only", inc.startSha]), ...git(["ls-files", "--others", "--exclude-standard"])])];
}

function checkEvidenceCmd(slug, n, id, json) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  const v = checksOf(inc)[id] || die(`increment ${n} has no check "${id}"`);
  const ev = evidenceOf(slug, v, { full: true });
  if (json) {
    const extra = { id, status: shownStatus(v) || "pending", ...(v.ask ? { ask: v.ask } : {}),
      ...(v.claims && v.claims.length ? { claims: v.claims.map(({ env, ...c }) => c) } : {}),
      // Not while a run goes on: the page polls every second and the scripts
      // do not change under a run; it reads them once the run is over.
      changed: v.status === "running" ? [] : scriptsChanged(st, inc, v), ...(v.exec && v.exec.brief ? { brief: v.exec.brief } : {}) };
    process.stdout.write(JSON.stringify(ev ? { ...extra, ...ev } : { ...extra, frames: 0 }, null, 2) + "\n");
    return;
  }
  if (!ev) { say(`${id}: no browser evidence yet${v.kind === "browser" ? ` — deep-plan check run ${slug} ${n} ${id}` : ""}`); return; }
  say(`${id}  ${v.status}${ev.live ? " (live)" : ""} — ${ev.frames} frame(s) in ${path.join(ev.root, ev.dir)}`);
  for (const s of ev.steps) say(`  ${s.status === "pass" ? "✓" : s.status === "fail" ? "✗" : "●"} ${s.label}  frames ${s.from}–${s.to ?? "…"}`);
  if (ev.error) say(`  failed in "${ev.label}": ${ev.error.split("\n")[0]}`);
  if (ev.animation) say(`  replay: ${path.join(ev.root, ev.dir, ev.animation)}`);
  if (ev.trace) say(`  trace:  ${path.join(ev.root, ev.dir, ev.trace)}`);
}

// PR proof from passed browser runs (lib/proof.mjs): one check, or every
// passed browser check in the plan. Built locally; never committed or pushed.
// --attach puts it in the PR description through gh 2.99+'s --attach, and
// only with --yes: it sends files off the machine, so a person says ok each
// time (the Dock's button asks, then passes --yes).
function proof(slug, n, id, { attach = false, pr = "", yes = false, json = false } = {}) {
  const st = readState(slug) || die("no plan " + slug);
  // The proof (its directory and the PR's section) always covers every
  // passed browser check in the plan: proving one never drops the others'.
  // A named check must be one of them.
  // A pass against other content than the tree now proves an older tree.
  const tree = treeOf(st.root);
  const stale = new Set();
  for (const inc of st.increments || [])
    for (const c of checksBlock(inc, tree)) if (c.status === "stale") stale.add(`${inc.n}/${c.id}`);
  if (id) {
    const v = checksOf(findInc(st, n))[id] || die(`increment ${n} has no check "${id}"`);
    if (!hasBrowserStep(v.exec)) die(`${id} is not a browser check`);
    if (v.status !== "pass" || !v.evidence || !v.evidence.dir) die(`${id} has no passed run to prove — deep-plan check run ${slug} ${n} ${id}`);
    if (stale.has(`${n}/${id}`)) die(`${id} passed against an older tree — run it again first: deep-plan check run ${slug} ${n} ${id}`);
  }
  const runs = [];
  for (const inc of st.increments || []) {
    for (const [cid, v] of Object.entries(checksOf(inc))) {
      if (v.retired || !hasBrowserStep(v.exec) || v.status !== "pass" || !v.evidence || !v.evidence.dir) continue;
      if (stale.has(`${inc.n}/${cid}`)) continue;
      const ev = readEvidence(runsDir(slug), v.evidence.dir);
      if (ev) runs.push({ n: inc.n, id: cid, name: v.name || cid, dir: path.join(runsDir(slug), v.evidence.dir), ev });
    }
  }
  if (!runs.length) die(`${slug} has no passed browser check to prove`);
  const out = path.join(PLANS_DIR, slug + ".proof");
  const built = buildProof(slug, out, runs, { title: st.title || slug });
  if (!attach) {
    if (json) process.stdout.write(JSON.stringify({ ok: true, dir: built.dir, md: path.join(built.dir, "proof.md"), files: built.files }) + "\n");
    else {
      say(`proof for ${runs.map(r => `${r.n} ${r.id}`).join(", ")}: ${path.join(built.dir, "proof.md")} (${built.files.length} file(s))`);
      say(`   put it on the PR (uploads the files; asks first): deep-plan proof ${slug}${n ? ` ${n} ${id}` : ""} --attach [<pr>]`);
    }
    return 0;
  }
  if (!built.files.length) die(`the proof has no replay or key frames to upload (${built.dir}) — re-run the check so its run records them`);
  if (!ghCanAttach()) die("this gh cannot upload files to a PR (gh pr edit --attach arrived in 2.99) — upgrade gh, or drag the files into the PR from " + built.dir);
  const cwd = st.root || process.cwd();
  const num = pr || gh(["pr", "view", "--json", "number", "-q", ".number"], { cwd }).out;
  if (!num) die("no PR for this branch — pass one: deep-plan proof " + slug + " --attach <pr>");
  const body = gh(["pr", "view", num, "--json", "body", "-q", ".body"], { cwd });
  if (!body.ok) die(`gh could not read PR ${num}: ${body.err.split("\n")[0]}`);
  if (!yes) {
    say(`would update PR ${num}'s description with ${built.files.length} file(s) from ${built.dir}: ${built.files.join(", ")}`);
    say("   it uploads them to GitHub. Once a person has said ok: re-run with --yes");
    return 2;
  }
  const next = path.join(built.dir, "pr-body.md");
  fs.writeFileSync(next, withProof(body.out, built.md));
  const r = gh(["pr", "edit", num, "-F", next, ...built.files.flatMap(f => ["--attach", f])], { cwd: built.dir });
  if (!r.ok) die(`gh pr edit failed: ${(r.err || r.out).split("\n").slice(-1)[0]}`);
  log1(st, `proof: attached ${built.files.length} file(s) to PR ${num}`);
  writeState(st);
  say(`proof is on PR ${num}: ${built.files.length} file(s) uploaded, its proof section ${body.out.includes("<!-- deep-plan proof -->") ? "replaced" : "added"}`);
  return 0;
}

// Bring the tab a check's last browser run drove to the front of its
// workspace (the Dock's `open tab`). The repl session keeps it for 30 idle
// minutes, and a failed run keeps its tab regardless.
function checkTab(slug, n, id) {
  const st = readState(slug) || die("no plan " + slug);
  const v = checksOf(findInc(st, n))[id] || die(`increment ${n} has no check "${id}"`);
  const ev = evidenceOf(slug, v, { full: true });
  if (!ev) die(`${id} has no browser run to show`);
  const r = showTab(ev.tab, { session: replSession(slug, n, id), root: st.root });
  if (!r.ok) die(`${id}: the tab could not be shown — ${r.out.split("\n")[0]}`);
  say(`${id}: its tab is in front`);
}

function checkStatus(slug, n, ids, json) {
  const st = reapLost(slug);
  const inc = findInc(st, n);
  const all = Object.entries(checksOf(inc)).filter(([id, v]) => !v.retired && (!ids.length || ids.includes(id)));
  if (json) {
    process.stdout.write(JSON.stringify(all.map(([id, v]) => ({ id, kind: v.kind, status: v.status, note: v.note || "",
      at: v.at || 0, ...(v.runner ? { runner: v.runner } : {}), ...(v.ran ? { ran: v.ran } : {}),
      ...(v.acquire ? { acquire: v.acquire } : {}),
      ...((ev => ev ? { evidence: ev } : {})(evidenceOf(slug, v))),
      ...(v.ask ? { ask: v.ask } : {}),
      // What is held, without the env it was claimed under (earlier exports).
      ...(v.claims ? { claims: v.claims.map(({ env, ...c }) => c) } : {}) })), null, 2) + "\n");
    return;
  }
  say(`${slug} increment ${inc.n}: ${inc.title}`);
  for (const [id, v] of all) {
    // A needs-variant note IS the acquire command, listed on its own line below.
    const said = v.note && !(v.status === "needs-variant" && v.acquire) ? ` — ${v.note}` : "";
    say(`  ${CHECK_MARK[v.status] || "·"} ${id}  ${v.status}${said}`);
    if (v.status === "running" && v.runner) {
      say(`      ${secs(Date.now() - v.runner.startedAt)} so far · pid ${v.runner.pid || "starting"} · log ${v.runner.log}`);
      try { say(tail(fs.readFileSync(v.runner.log, "utf8"), 5).split("\n").map(l => "      | " + l).join("\n")); } catch { /* not yet */ }
    }
    if (v.ask && (v.status === "running" || v.status === "needs-value")) {
      say(`      asks: ${v.ask.question}${v.ask.choices && v.ask.choices.length ? ` — choices: ${v.ask.choices.join(", ")}` : ""}`);
      say(`      answer: deep-plan check run ${slug} ${n} ${id} --from claim --set ${v.ask.name || "NAME"}=<value>`);
    }
    if (v.claims && v.claims.length) {
      for (const c of v.claims) say(`      holds: ${[c.name && c.value ? `${c.name}=${c.value}` : "", c.lock ? `lock ${c.lock}` : "", c.release ? `release ${c.release}` : ""].filter(Boolean).join(" · ")}`);
      if (v.status !== "running") say(`      give it back: deep-plan check release ${slug} ${n} ${id}`);
    }
    if (v.status === "needs-variant" && v.acquire) {
      for (const a of v.acquire) say(`      a person runs: ${a.command}`);
      say(`      then: deep-plan check run ${slug} ${n} ${id} --from wait`);
    }
    if (v.ran && v.ran.log && v.status !== "running") say(`      log ${v.ran.log}`);
  }
}

// Block until the selected checks stop running, then report them. Exits 0
// when every one passed, 1 when any did not, 2 when the timeout came first —
// the default stays inside an agent's foreground limit, and waiting again is
// always safe.
function checkWait(slug, n, ids, timeoutSec) {
  const until = Date.now() + timeoutSec * 1000;
  for (;;) {
    const st = reapLost(slug);
    const inc = findInc(st, n);
    const sel = Object.entries(checksOf(inc)).filter(([id, v]) => !v.retired && (!ids.length || ids.includes(id)));
    const running = sel.filter(([, v]) => v.status === "running");
    if (!running.length) {
      checkStatus(slug, n, ids, false);
      const bad = sel.filter(([, v]) => v.status !== "pass");
      say(bad.length ? `\nwait over: ${bad.map(([id, v]) => `${id} ${v.status}`).join("; ")}` : "\nwait over: every check passed");
      return bad.length ? 1 : 0;
    }
    if (Date.now() >= until) {
      checkStatus(slug, n, ids, false);
      say(`\nstill running after ${timeoutSec}s: ${running.map(([id]) => id).join(", ")} — wait again`);
      return 2;
    }
    sleep(500);
  }
}

// ---------------------------------------------------------------- await-go

// What a delegated child runs, in the background, between increments: block
// until an increment is authorized, then print its number. Nothing is typed
// into the waiting session (ADR 0012); it reads the state file. The deadline
// is wall-clock, so after a sleep it may fire at once, and the child runs it
// again. Exit 0 with the number, 2 at the deadline, 3 when there is nothing
// left to wait for: the plan is done or closed, or a person took the go back
// from the parent (the child's go is a person's again, so ask them).
// A child in another sandbox learns of its parent's go only from its state
// branch: the gate reads local state, and the news hook does not fetch. So a
// shared plan's wait pulls the branch, at most every AWAIT_PULL_MS and with
// the session timeout. A failed pull is said once; the wait goes on with
// local state. A plan that does not share never touches the network.
const AWAIT_PULL_MS = Number(process.env.DEEP_PLAN_AWAIT_PULL_MS) || 15000;
function awaitPull(slug, w, leftMs) {
  if (Date.now() - w.last < AWAIT_PULL_MS || leftMs < 1000) return;
  w.last = Date.now();
  const st = readState(slug);
  if (!st || !planShare(st)) return;
  // Never past the wait's own deadline.
  const o = openSync(st, { soft: true, timeout: Math.min(SESSION_TIMEOUT_MS, leftMs) });
  const r = o.error ? { error: o.error } : o.cfg.sync !== "transitions" ? null : pullPlan(slug, o.backend);
  if (!r) return;
  if (r.error) {
    if (!w.said) console.error(`await-go: could not pull ${slug}'s state branch (${r.error}); still waiting on the state here`);
    w.said = true;
    return;
  }
  if (!r.same) w.writer = r.writer || "another session";
}

function awaitGo(slug, timeoutSec) {
  const until = Date.now() + timeoutSec * 1000;
  // A child that starts waiting in a family and then is in none (its parent
  // closed or its family dissolved) has no parent left to give the go.
  const startedIn = !!goOwner(slug);
  const w = { last: 0, said: false, writer: "" };
  for (;;) {
    const st = readState(slug);
    if (!st) { say(`await-go: no plan ${slug}`); return 3; }
    const incs = st.increments || [];
    const open = incs.find(i => i.status === "authorized" || i.status === "working");
    if (open) {
      if (w.writer) console.error(`go arrived from the state branch (written by ${w.writer})`);
      say(String(open.n));
      console.error(`await-go: increment ${open.n} (${open.title}) of ${slug} is ${open.status}` +
        (open.by ? `, by ${open.by}` : "") + " — start it");
      return 0;
    }
    if (st.phase === "closed" || st.phase === "done" || (incs.length && incs.every(i => i.status === "done"))) {
      console.error(`await-go: ${slug} has no increment left to wait for (${st.phase})`);
      return 3;
    }
    const own = goOwner(slug);
    if (own && own.takenBack) {
      console.error(`await-go: a person took ${slug}'s go back from the parent; ask them for the next go`);
      return 3;
    }
    if (startedIn && !own) {
      console.error(`await-go: ${slug} is no longer in a family (its parent closed or the family dissolved); ask a person for the next go`);
      return 3;
    }
    if (Date.now() >= until) {
      console.error(`await-go: no go for ${slug} after ${timeoutSec}s — run it again to keep waiting`);
      return 2;
    }
    // Local state first, every second; the branch only when that shows no go.
    w.writer = "";
    awaitPull(slug, w, until - Date.now());
    if (w.writer) continue;
    sleep(1000);
  }
}

// ---------------------------------------------------------------- verify

// `verify resolve` answers "which recipes would check these files, and from
// which config" without running anything — the question an author asks while
// writing a deliverable's file list, and the one to ask when a check that
// should have been inferred was not.
function stepsLine(r) {
  if (r.steps.length === 1 && r.steps[0].kind === "run") return r.steps[0].command;
  return r.steps.map(s => s.kind === "acquire" ? "acquire (a person runs it)" : s.kind +
    (s.export ? ` → $${s.export}` : "")).join(" → ");
}

function verifyResolve(files, root, json) {
  if (!files.length) die("verify resolve <file>... [--root DIR] [--json]");
  const res = resolveFiles(root, files);
  if (json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  else {
    say(`root ${res.root}`);
    for (const f of res.files) {
      if (f.outside) { say(`\n${f.file}  ✗ outside the root — nothing here verifies it`); continue; }
      say(`\n${f.rel}  → ${f.config || "no .seamux/verify.json at or above it"}`);
      if (f.config && !f.recipes.length) say("    no recipe's match covers it");
      for (const r of f.recipes)
        say(`    ${r.key.padEnd(18)} [${r.kind} · ${r.tier}]${r.default ? " default" : ""}` +
          `${r.inherited ? " (inherited from the root)" : ""}  ${stepsLine(r)}  #${r.hash}`);
    }
  }
  if (res.errors.length) {
    for (const e of res.errors) console.error("  ✗ " + e);
    die(`verify: ${res.errors.length} config error(s) — a broken recipe file is never read as "no recipes"`);
  }
}

// `verify init` reads what the repo already does to prove a change works
// (lib/detect.mjs) and drafts a .seamux/verify.json per project, a TODO on
// every gap. A dry run unless --write, and --write never overwrites a file —
// a reviewed config is worth more than any draft. Remote templates are only
// ever copied in by name; the setup prompt walks what is left with a person.
const TEMPLATES_DIR = path.join(HERE, "verify", "templates");
const SETUP_PROMPT = path.join(HERE, "verify", "setup-prompt.md");

function listTemplates() {
  try { return fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort(); }
  catch { return []; }
}

function loadTemplate(name) {
  const p = path.join(TEMPLATES_DIR, name + ".json");
  if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(p))
    die(`no template "${name}" — there are: ${listTemplates().join(", ")}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// A template copied into a project's draft. Its run step's {{e2e}} becomes
// the project's own e2e script when one was found, else a command that fails
// loudly — a placeholder that passes would be a proof of nothing.
function applyTemplate(tpl, project) {
  const e2e = project.recipes.find(r => r.kind === "e2e");
  const fill = e2e ? e2e.run : "echo 'TODO: the e2e command, run against $BASE_URL' >&2; exit 1";
  const r = JSON.parse(JSON.stringify(tpl.recipe));
  r.steps = r.steps.map(s => Object.fromEntries(Object.entries(s).map(([k, v]) =>
    [k, typeof v === "string" ? v.split("{{e2e}}").join(fill) : v])));
  r.default = false;
  r.todo = [
    e2e ? `runs \`${e2e.run}\` against the preview — make the suite read $BASE_URL (and skip any local webServer when it is set)`
      : "fill in the run step: the e2e command, reading $BASE_URL",
    ...(tpl.verified ? [] : [`template ${tpl.template} is unverified: ${tpl.verify}`]),
    ...(tpl.needs || []).map(n => `needs: ${n}`),
  ];
  r.evidence = [`deep-plan verify/templates/${tpl.template}.json`];
  const ids = new Set(project.recipes.map(x => x.id));
  for (let k = 2, base = r.id; ids.has(r.id); k++) r.id = `${base}-${k}`;
  return r;
}

function verifyInit(root, opts) {
  const det = detect(root);
  const extra = new Map();
  for (const t of opts.templates || []) {
    const [name, at] = t.split("@");
    const tpl = loadTemplate(name);
    const dir = at !== undefined ? at.replace(/^\.\/?|\/$/g, "")
      : (det.projects.find(p => p.hosts.some(h => h.template === name)) || { dir: "" }).dir;
    const proj = det.projects.find(p => p.dir === dir) ||
      die(`--template ${t}: no project at "${dir}" — projects: ${det.projects.map(p => p.dir || ".").join(", ")}`);
    if (!extra.has(dir)) extra.set(dir, []);
    extra.get(dir).push(applyTemplate(tpl, proj));
  }
  const drafts = det.projects.map(p => ({
    dir: p.dir, path: path.posix.join(p.dir || ".", ".seamux", "verify.json"), exists: p.existing,
    file: draftFile(p, extra.get(p.dir) || []),
  })).filter(d => d.file.recipes.length);

  const written = [];
  if (opts.write) for (const d of drafts) {
    if (d.exists) continue;
    const abs = path.join(det.root, d.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(d.file, null, 2) + "\n");
    written.push(d.path);
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...det, drafts, written, templatesAvailable: listTemplates(),
      setupPrompt: SETUP_PROMPT }, null, 2) + "\n");
    return;
  }

  say(`verify init — ${det.root} (${det.packageManager})`);
  if (det.workspaces.length) say(`workspaces: ${det.workspaces.join(", ")}`);
  for (const p of det.projects) {
    const d = drafts.find(x => x.dir === p.dir);
    say(`\nproject ${p.dir || "."}${p.manifests.length ? ` (${p.manifests.join(", ")})` : ""}` +
      (p.runners.length ? ` — runners: ${p.runners.join(", ")}` : ""));
    if (!d) { say("  nothing that reads as a check — the setup prompt starts this one from a blank page"); continue; }
    say(`  draft ${d.path}` + (d.exists ? "  [exists — left alone; --write never overwrites]"
      : written.includes(d.path) ? "  [written]" : ""));
    for (const r of d.file.recipes) {
      const cmd = r.run || stepsLine({ steps: r.steps.map(s => ({ kind: Object.keys(s).find(k => ["acquire", "wait", "run"].includes(k)), export: s.export, command: s.run || s.wait || s.acquire })) });
      say(`    ${r.id.padEnd(14)} ${r.kind} · ${r.tier}${r.default ? " · default" : ""}  ${cmd}`);
      for (const e of r.evidence || []) say(`      evidence: ${e}`);
      for (const t of r.todo || []) say(`      TODO ${t}`);
    }
    for (const a of p.aggregates) say(`    (${a.name} chains ${a.runs.join(", ")} — its parts are recipes; it is not one)`);
    for (const h of p.hosts)
      if (!(extra.get(p.dir) || []).length) say(`    host: ${h.name} → remote QA template: deep-plan verify init --template ${h.template}`);
  }
  const steps = det.ci.filter(s => s.command), flags = det.ci.filter(s => !s.command || s.notes.length);
  say(`\nCI: ${steps.length ? `${steps.length} run step(s) read` : "no .github/workflows or .rwx run steps found"}`);
  for (const f of flags) say(`  ⚠ ${f.at}${f.job ? ` (${f.job})` : ""}: ${f.notes.join("; ")}`);
  if (!det.projects.some(p => p.hosts.length))
    say(`remote QA: no host config found (vercel.json, firebase.json, .rwx/, netlify.toml); ` +
      `templates: ${listTemplates().join(", ")}`);
  const todos = drafts.reduce((n, d) => n + d.file.recipes.reduce((m, r) => m + (r.todo || []).length, 0), 0);
  say(opts.write
    ? `\nwrote ${written.length ? written.join(", ") : "nothing (every draft's file exists)"}. ${todos} TODO(s) to walk: ${SETUP_PROMPT}`
    : `\ndry run — nothing written. ${drafts.length} draft(s), ${todos} TODO(s). ` +
      `\`deep-plan verify init --write\` writes the drafts whose file does not exist; then walk the TODOs: ${SETUP_PROMPT}`);
}

// ---------------------------------------------------------------- family

function familyCmd(args, flags) {
  const [sub, ...more] = args;
  if (sub === "init") {
    const [parent, ...children] = more;
    if (!parent || !children.length) die("family init <parent-slug> <child-slug>...");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(parent)) die("parent slug must be kebab-case: " + parent);
    const { draft, problems, overlaps: over } = draftParent(parent, children);
    for (const p of problems) console.error("  ✗ " + p);
    if (problems.length) process.exit(1);
    const text = JSON.stringify(draft, null, 2) + "\n";
    if (flags.out) { fs.writeFileSync(flags.out, text); say(`drafted ${flags.out}`); }
    else process.stdout.write(text);
    // The report goes to stderr so stdout stays a spec a redirect can keep.
    console.error(over.length
      ? `overlap as the plans stand (${over.length}):\n` + over.map(o => "  ⚠ " + o).join("\n")
      : "no overlap between the plans' deliverable files");
    console.error("next: cut the suggested globs down, fill the TODOs, then `deep-plan render` it");
    return;
  }
  if (sub === "check") {
    const slug = more[0] || die("family check <parent-slug>");
    const idx = readIndex(slug) || (familyOf(slug) && readIndex(familyOf(slug).parent)) ||
      die(`no family: ${slug} is not a rendered parent (${FAMILIES_DIR})`);
    const found = checkFamily(idx);
    const hits = found.filter(f => f.path);
    if (flags.json) process.stdout.write(JSON.stringify({ parent: idx.parent, overlaps: hits,
      problems: found.filter(f => f.problem) }) + "\n");
    else {
      for (const f of found.filter(f => f.problem)) say(`  ✗ ${f.slug}: ${f.problem}`);
      say(hits.length
        ? `family ${idx.parent}: ${hits.length} path(s) touched inside a sibling's claim\n` +
          hits.map(h => `  ⚠ ${h.slug} touched ${h.path} — ${h.how === "owns" ? `owned by ${h.owner} (${h.glob})`
            : `${h.owner} plans to edit it`}`).join("\n")
        : `family ${idx.parent}: no member has touched a sibling's claim`);
    }
    process.exit(hits.length ? 1 : 0);
  }
  if (sub === "news") {
    // What the news hook would tell this member now, without moving its
    // cursor: reading the news by hand must not swallow the session's copy.
    let hit = null;
    if (more[0]) {
      const idx = familyOf(more[0]) || die(`${more[0]} is in no family`);
      hit = { idx, me: idx.members.find(m => m.slug === more[0]) };
    } else hit = memberAt(process.cwd()) || die("no family member's root holds " + process.cwd());
    const { lines } = gatherNews(hit.idx, hit.me, readSeen(hit.idx.parent, hit.me.slug));
    say(lines.length ? newsText(hit.idx, lines) : `deep-plan family ${hit.idx.parent}: nothing new for ${hit.me.slug}`);
    return;
  }
  if (sub === "status") {
    // One family at a glance: every member's progress, waits and overlaps.
    const slug = more[0] || (memberAt(process.cwd()) || {}).idx?.parent || die("family status <slug> (no family member's root holds the cwd)");
    const idx = familyOf(slug) || die(`${slug} is in no family`);
    const f = familyRow(idx, idx.parent);
    if (flags.json) { process.stdout.write(JSON.stringify(f) + "\n"); return; }
    say(`family ${idx.parent}${f.done ? " — done" : ""}`);
    for (const m of f.members) {
      const mem = idx.members.find(x => x.slug === m.slug);
      const waits = waitingOn(m.slug);
      say(`  ${m.role === "parent" ? "◆" : "◇"} ${m.slug.padEnd(28)} ${m.phase.padEnd(12)} ${m.done}/${m.total}` +
        (m.role === "child" ? `  · ${m.go === "parent" ? "parent goes" : "a person goes"}` : "") +
        ((mem.owns || []).length ? `  owns ${mem.owns.map(c => c.glob).join(", ")}` : "") +
        (waits.length ? `  · waits on ${waits.map(w => w.n).join(", ")}` : ""));
      if (m.held) say(`      held by the parent: ${m.held}`);
      for (const i of m.increments || []) {
        const p = famIncParts(i);
        say(`      ${p.status} ${String(i.n).padEnd(3)}${[p.checks, p.review, p.by].filter(Boolean).join("  ")}`);
      }
    }
    for (const p of f.trespasses.pairs) say(`  ⚠ ${p.from} edited ${p.owner}'s claims ${p.count}×`);
    return;
  }
  if (["take-back", "give-back", "hold", "unhold"].includes(sub)) {
    const slug = more[0] || die(`family ${sub} <child>${sub === "hold" ? ' "<reason>"' : ""}`);
    const own = goOwner(slug) || die(`${slug} is not a family child`);
    const by = goBy(slug, { byHuman: !!flags.byHuman });
    const pst = readState(own.parent);
    const note = what => { if (pst) { log1(pst, what); writeState(pst); } };
    if (sub === "take-back" || sub === "give-back") {
      // A person's lever over the parent: the agents it constrains do not pull it.
      if (by !== "human")
        die(`family ${sub} is a person's lever, and this is a Claude Code session (${by}). ` +
          `A person runs it from their own shell.\nfamily ${sub} refused: not a person`);
      if (!own.declared) die(`${slug}'s go is not delegated in the ${own.parent} spec; there is nothing to ${sub === "take-back" ? "take back" : "give back"}`);
      try { updateControl(own.parent, c => { if (sub === "take-back") c.takenBack[slug] = { at: Date.now(), by }; else { delete c.takenBack[slug]; c.released["takenBack/" + slug] = Date.now(); } }); }
      catch (e) { die(`family ${sub}: ${e.message}`); }
      note(`family ${sub}: ${slug}'s go is ${sub === "take-back" ? "a person's again" : "the parent's again"} (by ${by})`);
      say(sub === "take-back"
        ? `${slug}: its go is a person's until  deep-plan family give-back ${slug}`
        : `${slug}: its go is the parent's again`);
    } else {
      if (by === "self") die(`family ${sub} is the parent's (or a person's), not the child's own\nfamily ${sub} refused: self`);
      const reason = sub === "hold" ? more.slice(1).join(" ").trim() || die(`family hold ${slug} "<reason>": a hold says why`) : "";
      if (sub === "unhold" && !own.hold) die(`${slug} is not held`);
      try { updateControl(own.parent, c => { if (sub === "hold") c.holds[slug] = { reason, at: Date.now(), by }; else { delete c.holds[slug]; c.released["holds/" + slug] = Date.now(); } }); }
      catch (e) { die(`family ${sub}: ${e.message}`); }
      note(`family ${sub}: ${slug}${reason ? ` — ${reason}` : ""} (by ${by})`);
      say(sub === "hold" ? `holding ${slug}: ${reason}` : `${slug} is no longer held`);
    }
    for (const m of (familyOf(slug) || { members: [] }).members) rerenderWorking(m.slug, false);
    return;
  }
  die("family init <parent> <child>... [--out F] | family check <parent> [--json] | family news [slug] | family status [slug] [--json]\n" +
    "       family take-back|give-back <child> [--by human] | family hold <child> \"<reason>\" | family unhold <child>");
}

// ---------------------------------------------------------------- main

// Every verb the switch below handles. Kept beside it so the usage listing can
// say that an extension file is SHADOWED rather than advertise a verb that can
// never dispatch — a user who writes ext/status.mjs and sees it listed as
// available has been told the opposite of the truth.
const BUILTIN_VERBS = new Set([
  "render", "rehydrate", "validate", "adr", "export-artifact", "attach-artifact",
  "grade", "status", "go", "start", "done", "reset", "block", "check", "obs",
  "open-gate", "shut-gate", "close", "diff", "review", "deliver", "ask", "help", "setup", "engine", "verify",
  "family", "redraw", "overviews", "protects", "await-go",
]);

const [, , cmd, ...rest] = process.argv;
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--force") flags.force = true;
  // Resolved here: state outlives this cwd, and the gate reads a relative root
  // against whatever directory the hook happens to run in.
  else if (rest[i] === "--root") flags.root = rest[++i] && path.resolve(rest[i]);
  else if (rest[i] === "--at") flags.at = rest[++i];
  else if (rest[i] === "--json") flags.json = true;
  else if (rest[i] === "--dry-run") flags.dry = true;
  else if (rest[i] === "--inline") flags.inline = true;
  else if (rest[i] === "--write") flags.write = true;
  else if (rest[i] === "--out") flags.out = rest[++i];
  else if (rest[i] === "--template") (flags.templates = flags.templates || []).push(rest[++i]);
  else if (rest[i] === "--from") flags.from = rest[++i];
  else if (rest[i] === "--set") {
    // NAME=value for a claim that asks; one per run.
    const m = /^([A-Z_][A-Z0-9_]*)=(.+)$/s.exec(rest[++i] || "");
    if (!m) die("--set takes NAME=value (NAME an env var name, as the claim's export; the value not empty)");
    flags.set = { ...(flags.set || {}), [m[1]]: m[2] };
  }
  else if (rest[i] === "--terminated") flags.terminated = true;
  else if (rest[i] === "--detach") flags.detach = true;
  else if (rest[i] === "--yes") flags.yes = true;
  else if (rest[i] === "--foreground") flags.foreground = true;
  else if (rest[i] === "--review") flags.review = true;
  else if (rest[i] === "--session") flags.session = true;
  else if (rest[i] === "--check") flags.check = true;
  else if (rest[i] === "--stop") flags.stop = true;
  else if (rest[i] === "--status") flags.status = true;
  else if (rest[i] === "--url") flags.url = rest[++i] || die("--url needs a path");
  else if (rest[i] === "--attach") {
    // An optional PR: a number or a URL. Without one, the branch's own PR.
    flags.attach = true;
    // A number only when nothing positional follows it, so `--attach 2 flow`
    // never reads an increment as the PR.
    const nx = rest[i + 1] || "", after = rest[i + 2];
    if (/^https?:\/\/\S+$/.test(nx) || (/^\d+$/.test(nx) && (after === undefined || after.startsWith("--")))) flags.pr = rest[++i];
  }
  else if (rest[i] === "--log") flags.log = rest[++i];
  else if (rest[i] === "--token") flags.token = rest[++i];
  else if (rest[i] === "--timeout") flags.timeout = Number(rest[++i]);
  else if (rest[i] === "--base") flags.base = rest[++i] || die("--base needs a sha");
  else if (rest[i] === "--by") {
    // Only "human" can be claimed: parent and self are worked out from where
    // the command runs, never asserted.
    if (rest[++i] !== "human") die(`--by takes only "human" (got ${rest[i] || "nothing"}); parent and self are worked out from the cwd`);
    flags.byHuman = true;
  }
  else args.push(rest[i]);
}

// Every run refreshes the pointer, so whichever copy ran last is the one the
// out-of-session callers find. Never at the cost of the command itself.
let pointerBody = null;
try { pointerBody = writeEnginePointer(); } catch { /* read-only home, full disk: the verb still runs */ }

// ---------------------------------------------------------------- sync on transitions
// A command that changed a plan's state pushes that plan to its branch when
// the plan shares and sync is transitions: go, start, done, block, reset, a
// check verdict (a detached run's too: it re-enters as check run), grade,
// import-state and the family verbs. It runs as the command exits, so every
// path through a verb is covered, and only plans whose state file changed
// are pushed. Best-effort with a short timeout: a failure is said once and
// recorded, the command's own exit code stands, and status shows the plan
// unsynced until a push lands. The gate's flip to working is not a command
// here and is never pushed; the next transition carries it.
const SYNC_CMDS = new Set(["go", "start", "done", "block", "reset", "check", "obs", "grade", "import-state", "family", "await-go", "deliver", "close"]);
// DEEP_PLAN_SYNC_TIMEOUT_MS is for the probe, whose machine may be loaded.
// Long enough for a cloud sandbox's git proxy, which can take seconds per
// call where a laptop takes a fraction of one.
const TRANSITION_PUSH_MS = Number(process.env.DEEP_PLAN_SYNC_TIMEOUT_MS) || 20000;
function stateFileDigests() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(STATE_DIR).filter(n => n.endsWith(".json")); } catch { return out; }
  for (const n of names) {
    try { out.set(n.slice(0, -5), crypto.createHash("sha1").update(fs.readFileSync(path.join(STATE_DIR, n))).digest("hex")); } catch { /* gone */ }
  }
  // A family's index and control files ride on its parent's branch, so a
  // change to them (a hold, a take-back, a re-render) is the parent's.
  let fams = [];
  try { fams = fs.readdirSync(FAMILIES_DIR); } catch { /* none */ }
  for (const f of fams) {
    const h = crypto.createHash("sha1");
    for (const n of ["index.json", "control.json"]) { try { h.update(fs.readFileSync(path.join(FAMILIES_DIR, f, n))); } catch { h.update("-"); } }
    const prev = out.get(f) || "";
    out.set(f, prev + ":" + h.digest("hex"));
  }
  return out;
}
function autoPush(slug) {
  const st = readState(slug);
  if (!st || !planShare(st)) return;
  const o = openSync(st, { soft: true, timeout: TRANSITION_PUSH_MS });
  if (o.error) return syncFailed(slug, o.error);
  if (o.cfg.sync !== "transitions") return;
  const r = pushPlan(slug, o.backend, 2);
  if (r.error) return syncFailed(slug, r.error);
  const m = syncMeta(slug);
  if (m && m.failed) { delete m.failed; writeSyncMeta(slug, m); }
}
// The end of a plan: its last state is pushed, then its branch is archived
// as a tag (seamux-state-archive/<slug>) and deleted, in one atomic push.
function autoArchive(slug) {
  const st = readState(slug);
  if (!st || !planShare(st)) return;
  autoPush(slug);
  const m = syncMeta(slug);
  if (!m || m.failed || !m.version) return;
  const o = openSync(st, { soft: true, timeout: TRANSITION_PUSH_MS });
  if (o.error || o.cfg.sync !== "transitions") return;
  let r;
  try { r = o.backend.archive(slug, m.version); } catch (e) { return syncFailed(slug, e.message); }
  if (!r.ok) return syncFailed(slug, `${o.backend.branch(slug)} moved before it could be archived`);
  writeSyncMeta(slug, { ...m, archived: { tag: r.tag, at: new Date().toISOString() } });
  console.error(`deep-plan: ${slug}'s state branch is archived as ${r.tag} and deleted`);
}
function syncFailed(slug, why) {
  writeSyncMeta(slug, { ...(syncMeta(slug) || {}), failed: { at: new Date().toISOString(), why } });
  console.error(`deep-plan: ${slug} was not pushed to its state branch (${why}); deep-plan state push ${slug} tries again`);
}
if (SYNC_CMDS.has(cmd) && !process.env.DEEP_PLAN_NO_SYNC) {
  const before = stateFileDigests();
  const phaseBefore = new Map(allStates().map(st => [st.slug, st.phase]));
  process.on("exit", () => {
    try {
      for (const [slug, d] of stateFileDigests()) {
        if (before.get(slug) === d) continue;
        const st = readState(slug);
        if (!st) continue;
        // Archived only when this command ended the plan (a family deliver
        // may end several); one that was already done just pushes.
        const ended = st.phase === "closed" || st.phase === "done";
        if ((cmd === "deliver" || cmd === "close") && ended && phaseBefore.get(slug) !== st.phase) autoArchive(slug);
        else autoPush(slug);
      }
    } catch (e) { console.error(`deep-plan: state sync skipped: ${e.message}`); }
  });
}

switch (cmd) {
  case "setup": setup(flags.force); break;
  case "engine": {
    // What the pointer says, as written by this very run. The SessionStart hook
    // calls this with stdout discarded; a human calls it to ask "which copy?".
    process.stdout.write(pointerBody || JSON.stringify({ root: HERE, version: engineVersion(), pointer: "not written" }, null, 2) + "\n");
    break;
  }
  case "serve": serveCmd(flags, args); break;
  case "page": pageCmd(args[0], flags); break;
  case "export-state": exportState(args[0], flags); break;
  case "install-repo": installRepoCmd(flags); break;
  case "import-state": importState(args[0], flags); break;
  case "state": stateCmd(args, flags); break;
  case "doctor": {
    // Which host this run thinks it is in, and which engine copy answers.
    // Later verbs route pages by the same host.
    if (flags.json) { process.stdout.write(JSON.stringify({ ...detectHost(), root: HERE, version: engineVersion() }, null, 2) + "\n"); break; }
    say(hostLine());
    say(`engine: ${HERE} (${engineVersion()})`);
    const drv = browserDriver(process.cwd());
    say(`browser checks: ${drv.kind === "cmux" ? "cmux browser repl (" + drv.bin + ")"
      : drv.kind === "playwright" ? "Playwright, headless Chromium" + (drv.fake ? " (stand-in " + drv.fake + ")" : " (from " + path.dirname(drv.from) + ")")
      : drv.why}`);
    break;
  }
  case "render": {
    if (!args[0]) die("render <spec.json> [--root DIR] [--force]");
    await render(args[0], flags); break;
  }
  case "rehydrate": rehydrate(args[0] || die("rehydrate <slug>")); break;
  case "redraw": redraw(args[0] || die("redraw <slug> | --all [--dry-run] [--json]"), flags); break;
  case "overviews": await overviews(args[0] || die("overviews <slug> [file.json] [--force] [--json]"), args[1], flags); break;
  case "ask": {
    if (args[0] === "show") askShow(args[1] || die("ask show <id>"));
    else askCreate(args[0] || die("ask <ask.json> | ask show <id>"));
    break;
  }
  case "validate": {
    // Re-check surfaces already on disk: `validate <slug>` for a plan's
    // md/review/working set, or `validate <file.html|file.md>` for any one file.
    const target = args[0] || die("validate <slug|file>");
    const files = fs.existsSync(target) && fs.statSync(target).isFile()
      ? [target]
      : ["md", "review.html", "working.html"]
          .map(sfx => path.join(PLANS_DIR, `${target}.${sfx}`))
          .filter(p => fs.existsSync(p));
    if (!files.length) die(`nothing to validate for "${target}"`);
    let bad = 0;
    for (const f of files) {
      const problems = await validateSurface(f);
      for (const p of problems) { console.error(`  ✗ ${p.label}: ${p.error}`); bad++; }
    }
    if (bad) { console.error(`deep-plan validate: ${bad} problem(s)`); process.exit(1); }
    say(`validate: ${files.length} surface(s) clean`); break;
  }
  case "adr": {
    if (args[0] !== "apply") die("adr apply <slug>");
    adrApply(args[1] || die("adr apply <slug>")); break;
  }
  case "export-artifact": exportArtifact(args[0] || die("export-artifact <slug> [--json]"), flags.json); break;
  case "attach-artifact": attachArtifact(args[0], args[1] || die("attach-artifact <slug> <url>")); break;
  case "grade": await grade(args[0] || die("grade <slug> [q1=a …]"), args.slice(1)); break;
  case "status": status(flags.json); break;
  case "proof": {
    const use = "proof <slug> [<n> <id>] [--attach [<pr>]] [--yes]";
    process.exitCode = proof(args[0] || die(use), args[1], args[2], { attach: flags.attach, pr: flags.pr, yes: flags.yes, json: flags.json });
    break;
  }
  case "go": {
    let slug = args[0], n = args[1];
    if (flags.at) { slug = resolveSlugAt(flags.at) || die("no plan tracks " + flags.at); n = args[0] || "next"; }
    if (!slug) die("go <slug> <n|next>  |  go --at DIR next");
    transition("go", slug, n || "next", undefined, flags.force, { byHuman: !!flags.byHuman }); break;
  }
  case "start": case "done": case "reset":
    transition(cmd, args[0], args[1] ?? die(cmd + " <slug> <n>"), undefined, flags.force); break;
  case "block": transition("block", args[0], args[1], args.slice(2).join(" ")); break;
  case "check": {
    const sub = args[0], slug = args[1], n = args[2];
    const need = use => (slug && n !== undefined) || die(use);
    if (sub === "list") { need("check list <slug> <n>"); checkList(slug, n); }
    else if (sub === "pass" || sub === "fail") {
      const use = `check ${sub} <slug> <n> <id> "<what you saw>" [--force]`;
      need(use);
      checkRecord(slug, n, [args[3] || die(use)], sub, args.slice(4).join(" "), flags.force);
    } else if (sub === "reset") { need("check reset <slug> <n> [id]"); checkReset(slug, n, args[3]); }
    else if (sub === "run") {
      need("check run <slug> <n> [id...] [--from wait|claim] [--set NAME=value] [--inline]");
      if (flags.from && !["wait", "claim"].includes(flags.from)) die("--from takes wait or claim");
      if (flags.set && args.length !== 4) die("--set answers one check: check run <slug> <n> <id> --from claim --set NAME=value");
      process.exitCode = checkRun(slug, n, args.slice(3),
        { from: flags.from || "", inline: flags.inline, log: flags.log, token: flags.token, set: flags.set, detach: flags.detach });
    } else if (sub === "status") { need("check status <slug> <n> [id...] [--json]"); checkStatus(slug, n, args.slice(3), flags.json); }
    else if (sub === "tab") {
      const use = "check tab <slug> <n> <id>";
      need(use);
      checkTab(slug, n, args[3] || die(use));
    }
    else if (sub === "release") {
      const use = "check release <slug> <n> <id>";
      need(use);
      process.exitCode = checkRelease(slug, n, args[3] || die(use), { terminated: flags.terminated, token: flags.token, force: flags.force });
    }
    else if (sub === "evidence") {
      const use = "check evidence <slug> <n> <id> [--json]";
      need(use);
      checkEvidenceCmd(slug, n, args[3] || die(use), flags.json);
    }
    else if (sub === "wait") {
      need("check wait <slug> <n> [id...] [--timeout s]");
      process.exitCode = checkWait(slug, n, args.slice(3), flags.timeout > 0 ? flags.timeout : 540);
    }
    else die('check list|run|status|evidence|tab|release|wait|pass|fail|reset <slug> <n> [<id>] ["<what you saw>"]');
    break;
  }
  case "obs": {
    // The verb from before checks: `obs pass|fail|reset` act on the
    // increment's observability checks, all of them at once, as the single
    // verdict they used to be.
    const sub = args[0], slug = args[1], n = args[2];
    const use = 'obs check|pass|fail|reset <slug> <n> ["<what you saw>"]';
    if (!["check", "pass", "fail", "reset"].includes(sub) || !slug || n === undefined) die(use);
    if (sub === "check") checkList(slug, n);
    else {
      const st = readState(slug) || die("no plan " + slug);
      const ids = Object.entries(checksOf(findInc(st, n)))
        .filter(([, v]) => !v.retired && v.kind === "observability").map(([id]) => id);
      if (!ids.length) die(`increment ${n} declares no observability check\n` +
        `  add one to the spec's deliverables[${Number(n) - 1}].checks and re-render first`);
      if (sub === "reset") checkReset(slug, n, null, ids);
      else checkRecord(slug, n, ids, sub, args.slice(3).join(" "), flags.force);
    }
    break;
  }
  case "family": familyCmd(args, flags); break;
  case "await-go": {
    const slug = args[0] || die("await-go <slug> [--timeout S]");
    if (flags.timeout !== undefined && !(flags.timeout > 0)) die("--timeout takes a number of seconds above 0");
    process.exit(awaitGo(slug, flags.timeout || 1800));
  }
  case "protects": {
    // Whether live plan or family work sits at a directory: what crew's close
    // paths ask before they archive, reclaim or close a workspace.
    const dir = args[0] || die("protects <dir> [--json]");
    // A directory that is gone still gets an answer: crew asks about a
    // workspace whose worktree was removed, and a refusal there is no answer.
    const p = protects(dir);
    if (flags.json) { process.stdout.write(JSON.stringify(p) + "\n"); break; }
    say(p.protected ? `protected: ${p.why}` : p.plan ? `not protected: ${p.why}` : `not protected: no tracked plan or family holds ${path.resolve(dir)}${fs.existsSync(dir) ? "" : " (it does not exist)"}`);
    break;
  }
  case "verify": {
    const root = flags.root || gitRoot(process.cwd()) || process.cwd();
    if (args[0] === "resolve") verifyResolve(args.slice(1), root, flags.json);
    else if (args[0] === "init") verifyInit(root, { write: flags.write, templates: flags.templates, json: flags.json });
    else die("verify resolve <file>... [--root DIR] [--json]  |  verify init [--root DIR] [--write] [--template name[@dir]]... [--json]");
    break;
  }
  case "open-gate": {
    const st = readState(args[0]) || die("no plan " + args[0]);
    st.gate = "open"; log1(st, "gate opened by the human — the one lever, logged");
    writeState(st); rerenderWorking(st.slug);
    say("gate open for " + st.slug + " (close it again with `deep-plan shut-gate`)"); break;
  }
  case "shut-gate": {
    const st = readState(args[0]) || die("no plan " + args[0]);
    st.gate = "increment"; log1(st, "gate shut again");
    writeState(st); rerenderWorking(st.slug);
    say("gate back to per-increment for " + st.slug); break;
  }
  case "close": {
    const st = readState(args[0]) || die("no plan " + args[0]);
    st.phase = "closed"; log1(st, "plan closed");
    writeState(st);
    say("closed " + st.slug + " — it leaves the board; surfaces stay in " + PLANS_DIR); break;
  }
  case "diff": {
    const st = readState(args[0]) || die("diff <slug> [n]");
    const pol = reviewPolicy(st.slug);
    const inc = args[1] ? findInc(st, args[1])
      : (st.increments || []).filter(i => i.startSha).pop();
    if (!inc) die(noBase("diff", st.slug, ""));
    const base = baseFor(st, inc, flags.base);
    if (!base) die(noBase("diff", st.slug, inc.n));
    // lookout's page when it is installed (risk-sorted, highlighted, the same
    // review the increment's review check reads); cmux diff otherwise.
    // The same review the check reads, so it is opened with the plan's
    // policy too: lookout fixes it when the review is created, and a diff
    // viewed first must not create it without the quiz or the close rule.
    const r = runLookout(["open", "--plan", st.slug, "--inc", String(inc.n), "--base", base,
      "--at", st.root, "--view-only", ...pol.flags], { cwd: st.root });
    if (r.ok) { say(r.out); break; }
    if (!r.missing) say(`lookout could not open it (${r.out.split("\n").pop()}); falling back to cmux diff`);
    incrementDiff(st, inc, { open: true, base }); break;
  }
  case "deliver": {
    // The closing step a plan with review.delivery takes after its last
    // increment: lookout's review of the whole plan's diff. No reviewer yet,
    // and it opens the review and says how to brief one; a blocker or major
    // open, and it names them; passed, and the plan is complete.
    const slug = args[0] || die("deliver <slug>");
    const st = readState(slug) || die("no plan " + slug);
    if (st.phase === "done") { say(`${slug} is already complete`); break; }
    if (st.phase !== "delivery")
      die(st.phase === "implementing" || st.phase === "review"
        ? `${slug} is not delivered yet: every increment must be done first (phase: ${st.phase})`
        : `${slug} is ${st.phase}`);
    const pspec = planSpec(slug);
    // An unreadable archived spec must not quietly turn a family parent's
    // delivery into an ordinary one.
    if (!pspec.slug && familyOf(slug) && familyOf(slug).parent === slug)
      die(`cannot read ${slug}'s archived spec (${path.join(KEYS_DIR, slug + ".spec.json")}), so whether it asks for the family review is unknown — re-render it`);
    if (pspec.review && pspec.review.family && (pspec.workstreams || []).length) { process.exit(familyDeliver(st, pspec)); }
    const base = baseFor(st, "all", flags.base);
    const g = runLookout(["gate", "--plan", slug, "--inc", "all"], { cwd: st.root });
    if (g.missing) die(LOOKOUT_MISSING);
    if (g.code === 3) {
      const r = openReview(st, "all", base);
      if (!r.ok) die(r.out || "lookout open failed");
      say(r.out + "\n\n" + spawnHint(slug, "all", r));
      say(spawnLine(slug, "all"));
      process.exit(1);
    }
    if (g.code !== 0) die(`the delivery review holds the plan open — ${g.out.split("\n")[0]}\n` +
      `deliver refused: a blocker or major is open on ${reviewId(slug, "all")}`);
    st.phase = "done";
    log1(st, `deliver: the delivery review passed (${g.out.split("\n")[0]}); the gate retires`);
    writeState(st); rerenderWorking(slug);
    say(`delivered ${slug} — plan complete`);
    break;
  }
  case "review": {
    // Open (or refresh) the increment's review in lookout, with the plan's
    // close policy, and say how to brief the reviewer.
    const st = readState(args[0]) || die("review <slug> [n]");
    const inc = args[1] ? findInc(st, args[1])
      : (st.increments || []).filter(i => i.startSha).pop();
    if (!inc) die(noBase("review", st.slug, ""));
    const base = baseFor(st, inc, flags.base);
    if (!base) die(noBase("review", st.slug, inc.n));
    const r = openReview(st, inc, base);
    if (!r.ok) die(r.out || "lookout open failed");
    say(r.out);
    say("\n" + spawnHint(st.slug, inc.n, r));
    break;
  }
  default: {
    // Fall through to an extension verb. This is AFTER every built-in case, so
    // an extension cannot shadow `grade`, `go`, or anything the gate reads —
    // a private file silently redefining the gate's own vocabulary is the one
    // failure this seam must not allow.
    if (cmd && extPath(cmd) !== null) {
      process.exit(runExt(cmd, rest, {
        state: STATE_DIR, keys: KEYS_DIR, plans: PLANS_DIR, skill: HERE,
      }));
    }
    say(`deep-plan — plan as artifact, gate per increment
  setup [--force]                             fetch the pinned mermaid, write the engine
                                              pointer, install the ~/.local/bin shim
  engine                                      print the engine pointer (which copy runs)
  doctor [--json]                             print the host (cmux, desktop, terminal, remote) and the engine copy
  serve [--url PATH] [--status|--stop]        start deep-plan's page server if needed and print a page's URL
  install-repo [--root DIR] [--check]        copy the plugin into a repo's .claude/ for cloud sessions
  export-state <slug> [--out FILE]            one file with the plan's state, spec, key, pages and reviews
  import-state <file> [--force] [--root DIR]  bring a bundle back (refuses an existing plan unless --force)
  page <slug> [--review]                      show the plan's working page (or its review) where this host can,
                                              and print "served at <url> (host: …)"
  render <spec.json> [--root DIR] [--force]   spec -> md + review + working surfaces
  rehydrate <slug>                            re-render from the archived spec
  redraw <slug> | --all [--dry-run] [--json]  re-render plans with this engine (spec + state untouched)
  overviews <slug> [file.json] [--force]      list diagrams, or add plain-words overviews {"<n>": "<mermaid>"}
  validate <slug|file>                        mermaid + formatting lint of rendered surfaces
  adr apply <slug>                            write flagged ADRs into the repo (refused in review phase)
  export-artifact <slug> [--json]             shareable annotate-able page (agent publishes it)
  attach-artifact <slug> <url>                record the published artifact in state
  grade <slug> [q1=a q2=c ...]                the alignment check; pass -> implementing
                                              (no answers on a TTY: prompts, keeps them out of history)
  status [--json]                             tracked plans (the board reads --json)
  protects <dir> [--json]                     whether live plan or family work sits at a
                                              directory (crew asks before closing one)
  go <slug> <n|next> | go --at DIR next       authorize an increment; records who gave it
     [--by human]                             (a delegated child cannot go itself)
  start|done|block|reset <slug> <n> [why]     move an increment
                                              (done is refused until every check
                                              passed against the tree as it is;
                                              done --force overrides, and logs it;
                                              reset puts every verdict back to
                                              pending — the work is being redone)
  check list <slug> <n>                       the increment's checks, verdicts and
                                              what each one runs
  check run <slug> <n> [id...] [--from wait]  run recipe-backed checks: cheap ones here,
                                              expensive ones detached; stops at an
                                              acquire step (a person runs it), and
                                              --from wait resumes after it
                                              (--inline runs an expensive one here)
  check status <slug> <n> [id...] [--json]    where each stands; a running one's log tail
  check wait <slug> <n> [id...] [--timeout s] block until none is running (default 540s;
                                              exit 0 all passed, 1 not, 2 still running)
  check pass|fail <slug> <n> <id> "<seen>"    record a verdict by hand (a check
                                              backed by a recipe needs --force)
  check reset <slug> <n> [id]                 verdict(s) back to pending, keeping
                                              what they were in the note
  obs check|pass|fail|reset <slug> <n> ...    the same, on the observability
                                              checks only (the older verb)
  open-gate|shut-gate <slug>                  the human lever, logged
  diff <slug> [n] [--base <sha>]              open the increment's diff: lookout's page when
                                              installed, else cmux diff on the patch done writes
  review <slug> [n] [--base <sha>]            open the increment's lookout review (the plan's
                                              review.agentMayClose applies); a review check gates on it
  deliver <slug> [--base <sha>]               after the last increment of a plan with review.delivery:
                                              open, then pass, the full delivery's lookout review
                                              (--base: only where no start sha is recorded;
                                              it is recorded as the start sha)
  close <slug>                                retire a finished plan
  ask <ask.json>                              render a question with diagrams/examples
                                              (served at /ask/<id>; a pick on the page
                                              types the number into this terminal)
  ask show <id>                               the recorded answer, if any
  family init <parent> <child>... [--out F]   draft a parent spec from existing plans:
                                              workstreams, suggested globs, their
                                              contracts, and the overlap report
  family check <parent> [--json]              what each member's worktree touched that
                                              a sibling claims (exit 1 when any)
  family status [slug] [--json]               every member's phase and progress, what
                                              waits, and recorded overlaps
  await-go <slug> [--timeout S]               block until an increment is authorized, print
                                              its number (exit 0); 2 at the timeout (run it
                                              again), 3 when nothing is left to wait for
  family take-back <child> [--by human]       a person takes a delegated child's go back
                                              from the parent; give-back returns it
  family hold <child> "<reason>"              the parent holds a child's go, saying why;
                                              unhold lifts it
  family news [slug]                          what the news hook would tell that member
                                              (default: the one at the cwd) now; does
                                              not move its cursor
  verify resolve <file>... [--root DIR]       which .seamux/verify.json each file
                 [--json]                     lands on and the recipes that apply
  verify init [--root DIR] [--write]          draft .seamux/verify.json per project from
              [--template name[@dir]]...      what the repo already runs (scripts, CI,
              [--json]                        runner and host configs), a TODO on every
                                              gap; dry run unless --write, which never
                                              overwrites. Templates: verify/templates/;
                                              then walk verify/setup-prompt.md`);
    // State which extensions are in force even when nothing is wrong: "my
    // extension is being ignored" is the failure this listing exists to remove.
    const ext = listExt();
    say(ext.length
      ? `\nextension verbs (${EXT_DIR}):\n` +
        ext.map(v => BUILTIN_VERBS.has(v)
          ? `  ${v.padEnd(42)}SHADOWED by the built-in ${v} — never runs`
          : `  ${v.padEnd(42)}from ${v}.mjs`).join("\n")
      : `\nno extension verbs installed (${EXT_DIR})`);
    if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
    break;
  }
}
