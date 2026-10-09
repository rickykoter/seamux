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
import { execSync, spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDiagrams, validateSurface, mermaidPath, mermaidCandidates, VENDOR_DIR, MERMAID_HOME } from "./lib/validate.mjs";
import { loadAdrConfig, resolveAdrDir, nextNumber, adrFileName, renderAdr, adrEntries, adrScanReport } from "./lib/adr.mjs";
import { epicHtml, incrementMd, bundleReadme, incrementFileNames, checkLinesMd } from "./lib/cutover.mjs";
import { checkEvidence } from "./lib/evidence.mjs";
import { resolveFiles, resolver } from "./lib/verify.mjs";
import { runExec, acquireSteps, alive, sleep, tail } from "./lib/runner.mjs";
import { detect, draftFile } from "./lib/detect.mjs";
import { EXT_DIR, listExt, runExt, extPath } from "./lib/ext.mjs";
import {
  FAMILIES_DIR, validateWorkstreams, buildIndex, writeIndex, readIndex, indexPath,
  familyOf, refreshFamilyFor, overlaps, checkFamily, draftParent, waitingOn, waitText,
  memberAt, readSeen, gatherNews, newsText, familyRow, familiesBySlug,
} from "./lib/family.mjs";
import {
  STATE_DIR, KEYS_DIR, PLANS_DIR, statePath, sessionId,
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

  if (spec.review !== undefined && (typeof spec.review !== "object" || spec.review === null || Array.isArray(spec.review) ||
      (spec.review.agentMayClose !== undefined && typeof spec.review.agentMayClose !== "boolean")))
    errs.push('review: an object, e.g. { "agentMayClose": true }');
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

// Run lookout with args; { ok, out } — never throws.
function runLookout(args, { cwd } = {}) {
  const root = lookoutRoot();
  if (!root) return { ok: false, out: LOOKOUT_MISSING, missing: true };
  const r = spawnSync(process.execPath, [path.join(root, "lookout.mjs"), ...args],
    { encoding: "utf8", cwd: cwd || process.cwd(), timeout: 180000 });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
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
    exec: { tier: r.tier, cwd: path.posix.join(r.project || ".", r.cwd), timeout: r.timeout, steps: r.steps } });
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
    L.push(`## ${dg.question}`, "", "```mermaid", dg.mermaid.trim(), "```", "");
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
:root{--bg:#0e1116;--fg:#d5dbe3;--dim:#859289;--line:#232a33;--accent:#7aa2f7;
--good:#4ADE80;--warn:#F5A524;--bad:#F97066;--card:#161b22;--card2:#12161d;--card3:#1a212b}
:root[data-theme="light"]{--bg:#f6f8fa;--fg:#1f2328;--dim:#57606a;--line:#d0d7de;--accent:#0969da;
--good:#1a7f37;--warn:#9a6700;--bad:#cf222e;--card:#eaeef2;--card2:#f0f3f6;--card3:#e6ebf1}
body{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif;
max-width:860px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:22px}h2{font-size:17px;margin-top:2em;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px}
code{background:var(--card);border-radius:4px;padding:1px 5px;font-size:13px}
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

function diagramsHtml(spec) {
  return (spec.diagrams || []).map(dg =>
    `<h2>${esc(dg.question)}</h2><pre class="mermaid">${esc(dg.mermaid.trim())}</pre>`).join("\n");
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

function workstreamsHtml(spec) {
  const items = (spec.workstreams || []).map(w =>
    `<li><b>${esc(w.slug)}</b> <span class="dim">— ${esc(workstreamLine(w))}</span></li>`).join("");
  return items ? `<h2>Workstreams</h2>
<p class="dim">child plans this family coordinates. Their own deliverable files are claims too; an edit into a sibling's claim is allowed and noted, never refused.</p>
<ul>${items}</ul>` : "";
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
${workstreamsHtml(spec)}
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
    `<div class="inc"><b>${i + 1}. ${esc(d.title)}</b><p>${esc(d.body || "")}</p>
${(d.files || []).length ? `<p class="dim">files: ${d.files.map(f => `<code>${esc(f)}</code>`).join(" ")}</p>` : ""}
${checksHtml(planChecks(spec, i), d.waiver)}
${(d.commits || []).length ? `<ul class="dim">${d.commits.map(c => commitLi(c)).join("")}</ul>` : ""}
<textarea class="dp-note" data-section="increment ${i + 1}" rows="1" placeholder="comment on this increment (optional)" aria-label="comment on increment ${i + 1}"></textarea></div>`).join("\n");
  // Everything below is client-side only: selections and comments live in the
  // DOM, nothing is stored or sent anywhere, and the page keeps working over
  // file:// (clipboard falls back to select+execCommand there).
  const COPYBACK = `
<h2>Send it back</h2>
<p class="dim">Highlight any text above — mouse or keyboard — then click the
＋&nbsp;comment chip, or press <kbd>⌘M</kbd> / <kbd>Ctrl+M</kbd>, to pin a comment to it.</p>
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

  // Highlight-to-comment: select any text (mouse or keyboard), a chip appears,
  // and clicking it — or ⌘M/Ctrl+M, the keyboard path — pins the excerpt with
  // its own comment box. The blob labels the comment with the nearest heading
  // and the quote, so the session can find the spot.
  var chip = document.createElement("button");
  chip.id = "dp-hl-add"; chip.type = "button";
  chip.textContent = "\\uFF0B comment";
  chip.setAttribute("aria-label", "pin a comment to the highlighted text (or press Cmd/Ctrl+M)");
  chip.style.display = "none";
  document.body.appendChild(chip);
  function placeChip() {
    var sel = window.getSelection();
    var txt = sel ? String(sel).trim() : "";
    if (!txt || sel.rangeCount === 0 || chip.contains(sel.anchorNode)) { chip.style.display = "none"; return; }
    var r = sel.getRangeAt(0).getBoundingClientRect();
    // Measure first, then clamp inside the viewport: a selection ending near
    // the right margin used to push the chip clean off the page.
    chip.style.visibility = "hidden"; chip.style.display = "block";
    var w = chip.offsetWidth, h = chip.offsetHeight;
    var x = Math.max(8, Math.min(r.right + 6, document.documentElement.clientWidth - w - 8));
    var y = r.top - h - 6;
    if (y < 8) y = r.bottom + 6;
    chip.style.left = (window.scrollX + x) + "px";
    chip.style.top = (window.scrollY + y) + "px";
    chip.style.visibility = "visible";
  }
  document.addEventListener("mouseup", function () { setTimeout(placeChip, 0); });
  document.addEventListener("keyup", function (e) {
    // Keyboard selection (Shift+arrows / Shift+Cmd+arrows) surfaces the chip too.
    if (e.key === "Shift" || e.shiftKey) setTimeout(placeChip, 0);
  });
  function pinComment() {
    var sel = window.getSelection();
    var txt = sel ? String(sel).trim() : "";
    if (!txt) return;
    var excerpt = txt.length > 120 ? txt.slice(0, 117) + "\\u2026" : txt;
    var section = "";
    var hs = document.querySelectorAll("h2");
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].compareDocumentPosition(sel.anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING)
        section = hs[i].textContent;
    }
    var row = document.createElement("div");
    row.className = "dp-quote";
    var bq = document.createElement("blockquote");
    bq.textContent = excerpt;
    var note = document.createElement("textarea");
    note.className = "dp-note"; note.rows = 1;
    note.placeholder = "comment on the highlighted text";
    note.setAttribute("aria-label", 'comment on "' + excerpt + '"');
    note.setAttribute("data-section", (section ? section + " \\u00B7 " : "") + 'on "' + excerpt + '"');
    var rm = document.createElement("button");
    rm.className = "dp-x"; rm.type = "button"; rm.textContent = "\\u00D7";
    rm.setAttribute("aria-label", "remove this pinned comment");
    rm.addEventListener("click", function () { row.remove(); });
    row.appendChild(bq); row.appendChild(note); row.appendChild(rm);
    document.getElementById("dp-quotes").appendChild(row);
    chip.style.display = "none";
    sel.removeAllRanges();
    note.focus();
    note.scrollIntoView({ block: "center" });
  }
  chip.addEventListener("mousedown", function (e) { e.preventDefault(); pinComment(); });
  chip.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pinComment(); }
  });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === "m" || e.key === "M")) {
      e.preventDefault(); pinComment();
    }
  });
})();
</script>`;
  return htmlHead(spec.title + " — review", b64) + `<style>
label.opt{cursor:pointer;padding:3px 0}
.dp-note{display:block;width:100%;box-sizing:border-box;margin:8px 0;background:transparent;
  color:inherit;border:1px solid var(--dim,#888);border-radius:4px;padding:6px;font:inherit}
${DP_RISK_CSS}
#dp-copyback{background:var(--accent,#46f);color:#fff;border:0;border-radius:4px;
  padding:10px 16px;font:inherit;cursor:pointer;min-height:44px}
#dp-hl-add{position:absolute;z-index:9;background:var(--accent,#46f);color:#fff;border:0;
  border-radius:14px;padding:6px 14px;font:inherit;font-size:.85em;cursor:pointer;
  white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.dp-quote{position:relative;margin:10px 0;padding:2px 34px 2px 10px;border-left:3px solid var(--accent,#46f)}
.dp-quote blockquote{margin:0 0 4px;font-style:italic;opacity:.8}
kbd{font:inherit;font-size:.85em;border:1px solid var(--dim,#888);border-radius:3px;padding:0 4px}
.opt input:focus-visible,#dp-copyback:focus-visible,#dp-hl-add:focus-visible,
.dp-note:focus-visible,.dp-x:focus-visible{outline:2px solid var(--accent,#46f);outline-offset:2px}
.dp-x{position:absolute;top:0;right:0;background:transparent;border:0;color:inherit;
  opacity:.6;cursor:pointer;font:inherit;padding:6px 10px;min-width:32px;min-height:32px}
.dp-x:hover{opacity:1}
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
${MERMAID_BOOT}</body></html>`;
}

// Annotations pulled back from the plan's published artifact, if any. The AGENT
// fetches them (Artifact read_db --out_dir); this CLI only renders what is on
// disk — the renderer keeps its no-network invariant.
const ANNOT_DIR = process.env.DEEP_PLAN_ANNOT_DIR ||
  path.join(os.homedir(), ".claude", "deep-plan", "annotations");

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

function specHash(spec) {
  return crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
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

const CHECK_MARK = { pass: "✅", fail: "❌", pending: "⏳", running: "🔄", "needs-variant": "✋", stale: "⚠️" };

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
    return `<li>${CHECK_MARK[st] || ""} ${esc(st)} · [${esc(v.kind || "?")}${v.system ? " · " + esc(v.system) : ""}] ` +
      `${esc(v.name || "")} <code>${esc(id)}</code>` +
      // A served working page reaches the review page on the same server.
      (v.synth === "review" && slug ? ` · <a href="/review/${esc(slug)}-inc${inc.n}">open the review</a>` : "") +
      (v.note ? ` — ${esc(v.note)}` : "") + detail + "</li>";
  }).join("");
  return `<p class="dim">checks: ${CHECK_MARK[agg] || ""} ${esc(agg)}</p><ul class="dim">${items}</ul>`;
}

function workingHtml(spec, st, b64) {
  const rows = (st.increments || []).map(inc => {
    const d = (spec.deliverables || [])[inc.n - 1] || {};
    const files = (d.files || []).map(f =>
      `<span class="dp-path" data-file="${esc(f)}">${esc(f)}</span>`).join(" · ");
    const acts = ["go", "start", "done", "block", "reset"].map(a =>
      `<button class="dp-act" data-a="${a}" data-n="${inc.n}" disabled ` +
      `title="${a} increment ${inc.n} — available when served in the Dock">${a}</button>`).join("");
    // The verdict belongs beside the status, not in a section of its own: it is
    // a precondition on THIS increment's `done`, and a reader deciding whether
    // the increment is finished needs both in one glance.
    const checks = checksRow(inc, st.slug) || (d.waiver ? `<p class="dim">checks: none — waived: ${esc(d.waiver)}</p>` : "");
    // Per-deliverable commits: the record of what actually landed for this one.
    const dcommits = (d.commits || []).map(c => commitLi(c)).join("");
    return `<div class="inc"><span class="st st-${esc(inc.status)}">${esc(inc.status)}</span>
<b>${inc.n}. ${esc(inc.title)}</b>
<p>${esc(d.body || "")}</p>
${files ? `<p class="dim">${files}</p>` : ""}
${dcommits ? `<ul class="dim">${dcommits}</ul>` : ""}
${checks}
<p>${acts}</p></div>`;
  }).join("\n");
  const g = gateView(st);
  const logRows = (st.log || []).slice(-12).reverse().map(l =>
    `<li class="dim">${esc(new Date(l.at).toISOString().slice(0, 16).replace("T", " "))} — ${esc(l.what)}</li>`).join("");
  return htmlHead(spec.title, b64) + `
<label class="auto"><input type="checkbox" id="dp-auto" checked> auto-refresh</label>
<style>
.dp-note{display:block;width:100%;box-sizing:border-box;margin:8px 0;background:transparent;
  color:inherit;border:1px solid var(--dim,#888);border-radius:4px;padding:6px;font:inherit}
${DP_RISK_CSS}
#dp-amend-copy{background:var(--accent,#46f);color:#fff;border:0;border-radius:4px;
  padding:10px 16px;font:inherit;cursor:pointer;min-height:44px}
#dp-amend-copy:focus-visible,.dp-note:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>` +
    commonBody(spec, st.adrs || [], true) + `
${st.approved ? `<p class="dim">approved snapshot: <span class="dp-path" data-file="${esc(st.approved.path)}"><code>${esc(st.approved.path)}</code></span>${
      st.approved.spec_hash !== specHash(spec) ? ' · <span style="color:var(--warn)">the live plan has DRIFTED from the approved snapshot (spec amended since grade-pass)</span>' : ""}</p>` : ""}
<h2>Gate</h2><p>${g.allow ? "🟢 open" : "🔴 shut"} <span class="dim">— ${esc(g.why)}</span>
<span class="dim">· root <code>${esc(st.root || "?")}</code> · phase ${esc(st.phase)}</span></p>
<h2>Increments</h2>${rows}
${annotationsSection(spec, st)}
<h2>Amend the plan</h2>
<p class="dim">Discovery amends the spec, not just the code — mid-increment included. Note what
changed (per section above, per ADR card, or generally), then <b>Copy amendments</b> puts one
paste-back on your clipboard; the session applies it as a spec edit and re-renders. Increment
statuses survive a re-render.</p>
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
${MERMAID_BOOT}
<script>
// Auto-refresh, armed on the checkbox's change event. The served page injects
// window.__dpChanged (a /plan-stamp probe); on disk there is no probe and the
// timer stays a no-op, so the file never blind-reloads under a reader.
(function(){
  var t = null, box = document.getElementById("dp-auto");
  function tick(){
    if (!window.__dpChanged) return;
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
    const kids = family.index.members.filter(m => m.role === "child").map(m => m.slug);
    say(`family ${spec.slug}: ${kids.length} workstream(s) — ${kids.join(", ")}`);
    for (const o of overlaps(family.index)) console.error("  ⚠ overlap: " + o);
    return;
  }
  const own = readIndex(spec.slug);
  if (own && !spec.workstreams) {
    fs.renameSync(indexPath(spec.slug), indexPath(spec.slug).replace(/index\.json$/, "index.dissolved.json"));
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
  const prior0 = readState(spec.slug);
  const planRoot = (prior0 && prior0.root) || opts.root ||
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
  const diagResults = await validateDiagrams(spec.diagrams || []);
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

  // ADR destinations resolve once, here, and live in state: surfaces and
  // drafts re-render from the stored resolution (rehydrate stays
  // byte-identical); apply re-checks the numbering against the repo.
  const adrs = planAdrs(spec, planRoot);
  const b64 = mermaidB64();
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".md"), mdPlan(spec, adrs));
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".review.html"), reviewHtml(spec, b64, adrs));
  const extras = writeSpecArtifacts(spec, b64);
  adrs.forEach(a => fs.writeFileSync(
    path.join(PLANS_DIR, `${spec.slug}.adr${a.n}.md`), adrDraftText(spec, planRoot, a)));

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
  writeState(st);
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".working.html"), workingHtml(spec, st, b64));
  say(`rendered ${spec.slug}: ${PLANS_DIR}/${spec.slug}.md, .review.html, .working.html`);
  renderFamily(spec, family);
  say(`  also: ${extras.join(", ")}`);
  say(`spec + key archived under ${KEYS_DIR} (separate tree, on purpose)`);
  if (st.phase === "review") say("phase: review — the alignment check gates everything.");
}

function rerenderWorking(slug) {
  const spec = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, slug + ".spec.json"), "utf8"));
  const st = readState(slug);
  if (!st) return;
  fs.writeFileSync(path.join(PLANS_DIR, slug + ".working.html"), workingHtml(spec, st, mermaidB64()));
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

function rehydrate(slug) {
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
  say(`rehydrated ${slug} — md ${okMd ? "byte-identical" : "REWRITTEN (differs)"}, review ${okRv ? "byte-identical" : "REWRITTEN (differs)"}`);
  say(`  also rewritten: ${extras.join(", ")}`);
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
    `<h2>${esc(dg.question)}</h2><pre class="mermaid">${esc(dg.mermaid.trim())}</pre>`).join("\n");
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
  st.phase = "implementing";
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

function resolveSlugAt(dir) {
  const target = path.resolve(dir);
  for (const st of allStates()) {
    if (!st.root || st.phase === "closed") continue;
    const r = path.resolve(st.root);
    if (target === r || target.startsWith(r + path.sep)) return st.slug;
  }
  return null;
}

// The refusal reads top-down for a person and bottom-up for a machine: crew's
// board shows only the LAST line of a refused command, so the reason goes
// there, never a hint.
function checksRefusal(slug, n, out) {
  const short = s => s.length > 60 ? s.slice(0, 57) + "…" : s;
  const lines = out.map(c => `  ${CHECK_MARK[c.status] || "·"} ${c.id}  [${c.kind}] ${c.status}` +
    (c.status === "stale" ? " — passed against other content than the tree now" : "") +
    (c.note ? ` — ${c.note}` : ""));
  return `increment ${n} has ${out.length} check(s) outstanding:\n${lines.join("\n")}` +
    `\n\n  what each one runs:  deep-plan check list ${slug} ${n}` +
    `\n  record a verdict:    deep-plan check pass|fail ${slug} ${n} <id> "<what you saw>"` +
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
    const { ran, tree, by, runner, acquire, ...rest } = v;
    checks[id] = { ...rest, status: "pending", at: Date.now(),
      note: `was ${was}${v.note ? `: ${v.note}` : ""} (${why})` };
    moved.push(id);
  }
  return moved;
}

function transition(action, slug, n, why, force = false) {
  const st = readState(slug) || die("no plan " + slug);
  if (action === "go") {
    if (st.phase === "review") die("the alignment check has not passed — `deep-plan grade` first");
    if (n === "next") {
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
    inc.status = "authorized"; inc.authorizedAt = Date.now(); inc.note = "";
    log1(st, `go: increment ${n} (${inc.title}) authorized` +
      (waits.length ? ` (--force past the family wait: ${waitText(waits)})` : ""));
  } else if (action === "start") {
    const inc = findInc(st, n);
    if (inc.status !== "authorized") die(`increment ${n} is ${inc.status}, not authorized`);
    inc.status = "working"; inc.startedAt = Date.now();
    const sha = spawnSync("git", ["-C", st.root, "rev-parse", "HEAD"], { encoding: "utf8" });
    inc.startSha = sha.status === 0 ? sha.stdout.trim() : "";
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
    inc.status = "done"; inc.doneAt = Date.now();
    // An override is logged for the same reason the verdict is recorded: someone
    // reading the history has to be able to see that the proof was skipped.
    log1(st, `done: increment ${n}` + (out.length
      ? ` (checks outstanding: ${out.map(c => `${c.id} [${c.kind}] ${c.status}`).join(", ")}; overridden with --force)`
      : ""));
    if ((st.increments || []).every(i => i.status === "done")) {
      st.phase = "done";
      log1(st, "every increment done; the gate retires");
    }
    writeState(st); rerenderWorking(slug);
    incrementDiff(st, inc);
    say(`done ${slug} ${n}` + (st.phase === "done" ? " — plan complete" : ""));
    return;
  } else if (action === "block") {
    const inc = findInc(st, n);
    inc.status = "blocked"; inc.note = why || "no reason recorded";
    log1(st, `block: increment ${n} — ${inc.note}`);
  } else if (action === "reset") {
    const inc = findInc(st, n);
    inc.status = "pending"; inc.note = "";
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
  writeState(st); rerenderWorking(slug);
  say(`${action} ${slug} ${n}`);
  if (action === "go") openWorkingSurface(st);
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
<h3><button type="button" class="dp-act dp-ask-pick" data-n="${n}" disabled title="pick ${n} — available when served in the Dock">${n}</button> ${esc(o.label)}</h3>
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
  : "Pick an option here to send it to the terminal, or answer in the terminal prompt as usual."}</p>
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
  if (!ask.surface) say("  (no CMUX_SURFACE_ID in the environment — the page will show the answer, not type it)");
  const url = openAskSurface(ask);
  if (url) say(`  served at ${url}`);
  else say("  intent server not reachable — open the file, or start the board (crew listen on)");
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
    if (process.env.DEEP_PLAN_STATE_DIR) return "";
    const cache = path.join(os.homedir(), ".cache", "cmux-crew");
    const rd = f => fs.readFileSync(path.join(cache, f), "utf8").trim();
    const port = parseInt(rd("board-intent.port"), 10);
    const token = rd("board-intent.token");
    if (!port || !token) return "";
    const url = `http://127.0.0.1:${port}/ask/${ask.id}`;
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
    // Probe/test runs override the state dir; they must never reach the
    // machine's real board, whatever this machine happens to be running.
    if (process.env.DEEP_PLAN_STATE_DIR) return;
    const cache = path.join(os.homedir(), ".cache", "cmux-crew");
    const rd = f => fs.readFileSync(path.join(cache, f), "utf8").trim();
    const port = parseInt(rd("board-intent.port"), 10);
    const token = rd("board-intent.token");
    if (!port || !token) return;
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
    spawnSync("curl", ["-fsS", "-m", "5", "-o", "/dev/null", url]);
  } catch { /* board offline or never installed — the go already succeeded */ }
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
function incrementDiff(st, inc, { open = false } = {}) {
  if (!inc.startSha || !st.root) return;
  try {
    execSync("git add -AN", { cwd: st.root });
    const patch = execSync(`git diff ${inc.startSha}`, { cwd: st.root, maxBuffer: 64e6 }).toString();
    if (!patch.trim()) return;
    const p = path.join(PLANS_DIR, `${st.slug}.inc${inc.n}.patch`);
    fs.writeFileSync(p, patch);
    const how = `  view: git -C ${st.root} diff ${inc.startSha.slice(0, 8)}` +
      `\n  or:   deep-plan diff ${st.slug} ${inc.n}`;
    if (!open) { say(`patch: ${p}\n${how}`); return; }
    const title = `${st.slug} · increment ${inc.n} since ${inc.startSha.slice(0, 8)}`;
    const r = spawnSync("cmux", ["diff", "--title", title, p], { stdio: "ignore" });
    if (r.error || r.status !== 0) say(`patch: ${p}\n${how}`);
  } catch { /* the patch is a courtesy, never a failure */ }
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
    checksOutstanding: (st.increments || []).flatMap(i =>
      checksBlock(i).map(c => ({ n: i.n, id: c.id, kind: c.kind, status: shownStatus(checksOf(i)[c.id], c.status) }))),
    // The pre-checks shape, one entry per increment, kept for older readers.
    obsOutstanding: (st.increments || []).filter(i => checksBlock(i).length)
      .map(i => ({ n: i.n, status: checksAggregate(i) })),
    // Every increment's own row, for a reader that draws the whole plan (the
    // seamux-mods pane) rather than the board's one-line summary. `obs` is the
    // checks folded to one word, for a pane built before checks.
    increments: (st.increments || []).map(i => ({
      n: i.n, title: i.title, status: i.status, obs: checksAggregate(i),
      checks: Object.entries(checksOf(i)).filter(([, v]) => !v.retired).map(([id, v]) => {
        const status = shownStatus(v) || "pending";
        return {
          id, kind: v.kind || "", name: v.name || "", status,
          note: status === "lost" ? `runner lost: pid ${v.runner.pid || "?"} exited without a verdict` : v.note || "",
          at: v.at || 0, ...(v.recipe ? { recipe: v.recipe } : {}),
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
  return waits.length ? { ...g, why: `${g.why} go waits on ${waitText(waits)}.` } : g;
}

function status(json) {
  const rows = statusRows();
  if (json) { process.stdout.write(JSON.stringify(rows)); return; }
  if (!rows.length) { say("no tracked plans"); return; }
  for (const r of rows) {
    say(`${r.slug}  [${r.phase}]  ${r.gate.allow ? "gate open" : "GATE SHUT"} — ${r.gate.why}`);
    say(`  root ${r.root}${r.rootBroken ? "  ⚠ BROKEN ROOT — gone; the gate FAILS OPEN here" : ""}`);
    if (r.approved) say(`  approved snapshot ${r.approved}`);
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
      const { runner, ...rest } = v;
      inc.checks[id] = { ...rest, status: "fail", at: Date.now(), by: "runner",
        note: `runner lost: pid ${runner.pid || "?"} exited without a verdict (log: ${runner.log})`,
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
  for (const id of want) {
    st = readState(slug);
    const cur = checksOf(findInc(st, n))[id];
    const own = opts.token && cur.runner && cur.runner.token === opts.token;
    if (cur.status === "running" && cur.runner && !own && alive(cur.runner.pid)) {
      say(`🔄 ${id} is already running (pid ${cur.runner.pid}) — deep-plan check wait ${slug} ${n} ${id}`);
      lines.push(`${id} already running`);
      continue;
    }
    const drift = recipeDrift(st, cur);
    if (drift && !opts.token) console.error("  ⚠ " + drift);

    // An acquire step is a person's: stop before anything runs, and say what
    // to run and how to resume. Never executed here, not even with a `go`.
    const acquire = acquireSteps(cur.exec);
    if (acquire.length && opts.from !== "wait") {
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

    if (cur.exec.tier === "expensive" && !opts.inline) {
      // Recorded before the spawn, so the runner finds its token on its first
      // read; the pid follows once there is one.
      const startedAt = Date.now();
      const set = pid => {
        const s2 = readState(slug), c2 = checksOf(findInc(s2, n));
        const { ran, ...rest } = c2[id];
        c2[id] = { ...rest, status: "running", at: startedAt, by: "runner",
          note: `running since ${new Date(startedAt).toISOString().slice(11, 19)}Z`,
          runner: { token, pid, log, startedAt, from: opts.from || "" } };
        if (!pid) log1(s2, `check run: increment ${inc.n} ${id} started detached (log: ${log})`);
        writeState(s2);
      };
      set(0);
      const fd = fs.openSync(log, "a");
      const child = spawn(process.execPath, [path.join(HERE, "deep_plan.mjs"), "check", "run", slug, String(n), id,
        "--inline", "--log", log, "--token", token, ...(opts.from ? ["--from", opts.from] : [])],
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
    if (!own) {
      const { ran, ...rest } = cur;
      checksOf(findInc(st, n))[id] = { ...rest, status: "running", at: Date.now(), by: "runner",
        note: "running in the foreground", runner: { token, pid: process.pid, log, startedAt: Date.now(), from: opts.from || "" } };
      writeState(st);
    }
    const tree = treeOf(st.root);
    const exec = cur.synth === "review" ? reviewExec(cur, slug, n) : cur.exec;
    const res = runExec(exec, { root: st.root, from: opts.from || "", log,
      env: { DEEP_PLAN_SLUG: slug, DEEP_PLAN_INCREMENT: String(n), DEEP_PLAN_CHECK: id,
             DEEP_PLAN_ROOT: st.root || "", DEEP_PLAN_START_SHA: findInc(st, n).startSha || "" } });
    if (cur.synth === "review" && res.status === "fail") {
      const code = res.ran && res.ran.code;
      res.note = code === 127 ? LOOKOUT_MISSING
        : code === 3 ? `no verdict yet (no review, or no reviewer has reported) — deep-plan review ${slug} ${n}, ` +
          `then brief a reviewer subagent with lookout prompt ${slug}-inc${n}`
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
    const { runner, ...rest } = now;
    checksOf(findInc(fresh, n))[id] = { ...rest, status: res.status, at: Date.now(), by: "runner",
      note: res.note, ran: res.ran, ...(res.status === "pass" && tree ? { tree } : {}) };
    log1(fresh, `check ${res.status}: increment ${inc.n} ${id} — ${res.note}`);
    writeState(fresh); rerenderWorking(slug);
    try { if (own) fs.rmSync(pidFile(slug, n, id), { force: true }); } catch { /* gone */ }
    if (res.status === "pass") say(`✅ ${id} pass — ${res.note} (log: ${log})`);
    else {
      failed++;
      say(`❌ ${id} fail — ${res.note} (log: ${log})`);
      if (res.ran.tail) say(res.ran.tail.split("\n").map(l => "     " + l).join("\n"));
    }
    lines.push(`${id} ${res.status}`);
  }
  if (lines.length > 1 || failed) say(`\ncheck run ${slug} ${n}: ${lines.join("; ")}`);
  return failed ? 1 : 0;
}

// Where each check stands; a running one with its elapsed time, pid and the
// tail of its log, so "is it stuck?" has an answer without opening anything.
function checkStatus(slug, n, ids, json) {
  const st = reapLost(slug);
  const inc = findInc(st, n);
  const all = Object.entries(checksOf(inc)).filter(([id, v]) => !v.retired && (!ids.length || ids.includes(id)));
  if (json) {
    process.stdout.write(JSON.stringify(all.map(([id, v]) => ({ id, kind: v.kind, status: v.status, note: v.note || "",
      at: v.at || 0, ...(v.runner ? { runner: v.runner } : {}), ...(v.ran ? { ran: v.ran } : {}),
      ...(v.acquire ? { acquire: v.acquire } : {}) })), null, 2) + "\n");
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
        ((mem.owns || []).length ? `  owns ${mem.owns.map(c => c.glob).join(", ")}` : "") +
        (waits.length ? `  · waits on ${waits.map(w => w.n).join(", ")}` : ""));
    }
    for (const p of f.trespasses.pairs) say(`  ⚠ ${p.from} edited ${p.owner}'s claims ${p.count}×`);
    return;
  }
  die("family init <parent> <child>... [--out F] | family check <parent> [--json] | family news [slug] | family status [slug] [--json]");
}

// ---------------------------------------------------------------- main

// Every verb the switch below handles. Kept beside it so the usage listing can
// say that an extension file is SHADOWED rather than advertise a verb that can
// never dispatch — a user who writes ext/status.mjs and sees it listed as
// available has been told the opposite of the truth.
const BUILTIN_VERBS = new Set([
  "render", "rehydrate", "validate", "adr", "export-artifact", "attach-artifact",
  "grade", "status", "go", "start", "done", "reset", "block", "check", "obs",
  "open-gate", "shut-gate", "close", "diff", "review", "ask", "help", "setup", "engine", "verify",
  "family",
]);

const [, , cmd, ...rest] = process.argv;
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--force") flags.force = true;
  else if (rest[i] === "--root") flags.root = rest[++i];
  else if (rest[i] === "--at") flags.at = rest[++i];
  else if (rest[i] === "--json") flags.json = true;
  else if (rest[i] === "--inline") flags.inline = true;
  else if (rest[i] === "--write") flags.write = true;
  else if (rest[i] === "--out") flags.out = rest[++i];
  else if (rest[i] === "--template") (flags.templates = flags.templates || []).push(rest[++i]);
  else if (rest[i] === "--from") flags.from = rest[++i];
  else if (rest[i] === "--log") flags.log = rest[++i];
  else if (rest[i] === "--token") flags.token = rest[++i];
  else if (rest[i] === "--timeout") flags.timeout = Number(rest[++i]);
  else args.push(rest[i]);
}

// Every run refreshes the pointer, so whichever copy ran last is the one the
// out-of-session callers find. Never at the cost of the command itself.
let pointerBody = null;
try { pointerBody = writeEnginePointer(); } catch { /* read-only home, full disk: the verb still runs */ }

switch (cmd) {
  case "setup": setup(flags.force); break;
  case "engine": {
    // What the pointer says, as written by this very run. The SessionStart hook
    // calls this with stdout discarded; a human calls it to ask "which copy?".
    process.stdout.write(pointerBody || JSON.stringify({ root: HERE, version: engineVersion(), pointer: "not written" }, null, 2) + "\n");
    break;
  }
  case "render": {
    if (!args[0]) die("render <spec.json> [--root DIR] [--force]");
    await render(args[0], flags); break;
  }
  case "rehydrate": rehydrate(args[0] || die("rehydrate <slug>")); break;
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
  case "go": {
    let slug = args[0], n = args[1];
    if (flags.at) { slug = resolveSlugAt(flags.at) || die("no plan tracks " + flags.at); n = args[0] || "next"; }
    if (!slug) die("go <slug> <n|next>  |  go --at DIR next");
    transition("go", slug, n || "next", undefined, flags.force); break;
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
      need("check run <slug> <n> [id...] [--from wait] [--inline]");
      if (flags.from && flags.from !== "wait") die("--from takes one value: wait");
      process.exitCode = checkRun(slug, n, args.slice(3),
        { from: flags.from, inline: flags.inline, log: flags.log, token: flags.token });
    } else if (sub === "status") { need("check status <slug> <n> [id...] [--json]"); checkStatus(slug, n, args.slice(3), flags.json); }
    else if (sub === "wait") {
      need("check wait <slug> <n> [id...] [--timeout s]");
      process.exitCode = checkWait(slug, n, args.slice(3), flags.timeout > 0 ? flags.timeout : 540);
    }
    else die('check list|run|status|wait|pass|fail|reset <slug> <n> [<id>] ["<what you saw>"]');
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
    const inc = args[1] ? findInc(st, args[1])
      : (st.increments || []).filter(i => i.startSha).pop();
    if (!inc || !inc.startSha) die("no started increment with a recorded sha");
    // lookout's page when it is installed (risk-sorted, highlighted, the same
    // review the increment's review check reads); cmux diff otherwise.
    const r = runLookout(["open", "--plan", st.slug, "--inc", String(inc.n), "--base", inc.startSha,
      "--at", st.root, "--view-only"], { cwd: st.root });
    if (r.ok) { say(r.out); break; }
    if (!r.missing) say(`lookout could not open it (${r.out.split("\n").pop()}); falling back to cmux diff`);
    incrementDiff(st, inc, { open: true }); break;
  }
  case "review": {
    // Open (or refresh) the increment's review in lookout, with the plan's
    // close policy, and say how to brief the reviewer.
    const st = readState(args[0]) || die("review <slug> [n]");
    const inc = args[1] ? findInc(st, args[1])
      : (st.increments || []).filter(i => i.startSha).pop();
    if (!inc || !inc.startSha) die("no started increment with a recorded sha — its first edit records one, " +
      `or \`deep-plan start ${st.slug} ${args[1] || "<n>"}\``);
    let spec = {};
    try { spec = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, st.slug + ".spec.json"), "utf8")); } catch { /* no spec: defaults */ }
    const agent = !!(spec.review && spec.review.agentMayClose);
    const r = runLookout(["open", "--plan", st.slug, "--inc", String(inc.n), "--base", inc.startSha, "--at", st.root,
      ...(agent ? ["--agent-may-close"] : [])], { cwd: st.root });
    if (!r.ok) die(r.out || "lookout open failed");
    say(r.out);
    say(`\nnext: spawn ONE reviewer subagent whose prompt is the output of\n  lookout prompt ${st.slug}-inc${inc.n}\n` +
        `then: deep-plan check run ${st.slug} ${inc.n}` + (agent ? "\n(this plan lets the agent close findings too)" : ""));
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
  render <spec.json> [--root DIR] [--force]   spec -> md + review + working surfaces
  rehydrate <slug>                            re-render from the archived spec
  validate <slug|file>                        mermaid + formatting lint of rendered surfaces
  adr apply <slug>                            write flagged ADRs into the repo (refused in review phase)
  export-artifact <slug> [--json]             shareable annotate-able page (agent publishes it)
  attach-artifact <slug> <url>                record the published artifact in state
  grade <slug> [q1=a q2=c ...]                the alignment check; pass -> implementing
                                              (no answers on a TTY: prompts, keeps them out of history)
  status [--json]                             tracked plans (the board reads --json)
  go <slug> <n|next> | go --at DIR next       authorize an increment
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
  diff <slug> [n]                             open the increment's diff: lookout's page when
                                              installed, else cmux diff on the patch done writes
  review <slug> [n]                           open the increment's lookout review (the plan's
                                              review.agentMayClose applies); a review check gates on it
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
