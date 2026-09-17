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
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDiagrams, validateSurface } from "./lib/validate.mjs";
import { loadAdrConfig, resolveAdrDir, nextNumber, adrFileName, renderAdr, adrEntries, adrScanReport } from "./lib/adr.mjs";
import { epicHtml, incrementMd, bundleReadme, incrementFileNames } from "./lib/cutover.mjs";
import { checkEvidence } from "./lib/evidence.mjs";
import { EXT_DIR, listExt, runExt, extPath } from "./lib/ext.mjs";
import {
  STATE_DIR, KEYS_DIR, PLANS_DIR,
  readState, writeState, allStates, log1, progress, gateView,
  reconcileObs, obsBlocks,
} from "./lib/state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERMAID = path.join(HERE, "vendor", "mermaid.min.js");

const PARA_CEILING = 120;   // words; rejects the house's worst walls (178/140/130)
const DIAGRAM_PER = 900;    // one diagram per this many prose words, min 1

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

  if (errs.length && !force) {
    console.error("deep-plan: spec refused —");
    for (const e of errs) console.error("  ✗ " + e);
    process.exit(1);
  }
  if (errs.length) console.error(`deep-plan: --force past ${errs.length} floor violation(s) — logged`);
  return errs;
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
    for (const r of spec.risks) L.push(`- ${typeof r === "string" ? r : r.risk || JSON.stringify(r)}`);
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
    if ((d.verification || []).length) {
      L.push("", "Verify this increment:", "");
      for (const v of d.verification) L.push("- " + v);
    }
    if ((d.commits || []).length) {
      L.push("", "Commits:", "");
      for (const c of d.commits) L.push(commitLine(c));
    }
    if ((d.observability && d.observability.checks || []).length) {
      L.push("", "Observability — `done` is gated on these:", "");
      for (const c of d.observability.checks) {
        L.push(`- [${c.system || "?"}] ${c.name || ""}`);
        if (c.query) L.push(`  - query: \`${c.query}\``);
        if (c.expect) L.push(`  - expect: ${c.expect}`);
      }
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

function mermaidB64() {
  // The validator degrades to a documented "skipped" sentinel when the vendored
  // bundle is missing; render cannot, because a surface with no diagram engine
  // is not a surface. So fail, but say what to do -- a bare readFileSync here
  // handed a fresh clone an ENOENT stack trace out of node:fs, which reads as a
  // broken tool rather than a missing 3 MB file that install.sh normally fetches.
  if (!fs.existsSync(MERMAID)) {
    die("vendor/mermaid.min.js is missing, so no diagram can be inlined.\n" +
        "  Run ./install.sh (it fetches the pinned build and verifies its sha256),\n" +
        "  or fetch it yourself into " + MERMAID);
  }
  return fs.readFileSync(MERMAID).toString("base64");
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
})();
</script>`;

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
  const risks = (spec.risks || []).map(r =>
    `<li>${esc(typeof r === "string" ? r : r.risk)}</li>`).join("");
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
${(d.verification || []).length ? `<p class="dim">verify: ${d.verification.map(v => `<code>${esc(v)}</code>`).join(" · ")}</p>` : ""}
${(d.commits || []).length ? `<ul class="dim">${d.commits.map(c => commitLi(c)).join("")}</ul>` : ""}
${(d.observability && d.observability.checks || []).length ? `<p class="dim">observability gate: ${d.observability.checks.map(c => esc(c.name || c.system || "?")).join(" · ")}</p>` : ""}
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

// The verdict, and — when it is still outstanding — what the spec says to run.
// Showing the checks only while they matter keeps a finished increment short.
function obsRow(d, inc) {
  const checks = (d.observability && d.observability.checks) || [];
  const st = (inc.obs && inc.obs.status) || "n/a";
  if (!checks.length && st === "n/a") return "";
  const mark = { pass: "✅", fail: "❌", pending: "⏳", "n/a": "" }[st] || "";
  const head = `<p class="dim">observability: ${mark} ${esc(st)}` +
    (inc.obs && inc.obs.note ? ` — ${esc(inc.obs.note)}` : "") + "</p>";
  if (st === "pass" || !checks.length) return head;
  const items = checks.map(c =>
    `<li>[${esc(c.system || "?")}] ${esc(c.name || "")}` +
    (c.query ? `<br><code>${esc(c.query)}</code>` : "") +
    (c.expect ? `<br><span class="dim">expect: ${esc(c.expect)}</span>` : "") + "</li>").join("");
  return head + `<ul class="dim">${items}</ul>`;
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
    const obs = obsRow(d, inc);
    // Per-deliverable commits: the record of what actually landed for this one.
    const dcommits = (d.commits || []).map(c => commitLi(c)).join("");
    return `<div class="inc"><span class="st st-${esc(inc.status)}">${esc(inc.status)}</span>
<b>${inc.n}. ${esc(inc.title)}</b>
<p>${esc(d.body || "")}</p>
${files ? `<p class="dim">${files}</p>` : ""}
${(d.verification || []).length ? `<p class="dim">verify: ${d.verification.map(v => `<code>${esc(v)}</code>`).join(" · ")}</p>` : ""}
${dcommits ? `<ul class="dim">${dcommits}</ul>` : ""}
${obs}
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
      session: process.env.CLAUDE_SESSION_ID || "",
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
      obs: reconcileObs(prev, d) };
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
    incrementMd({ spec, index: i, total: names.length })));
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
  const incs = (spec.deliverables || []).map((d, i) =>
    `<div class="inc" id="inc-${i + 1}"><b>${i + 1}. ${esc(d.title)}</b><p>${esc(d.body || "")}</p>
${(d.files || []).length ? `<p class="dim">files: ${d.files.map(f => `<code>${esc(f)}</code>`).join(" ")}</p>` : ""}</div>`).join("\n");
  const diagrams = (spec.diagrams || []).map(dg =>
    `<h2>${esc(dg.question)}</h2><pre class="mermaid">${esc(dg.mermaid.trim())}</pre>`).join("\n");
  const facts = (spec.verifiedFacts || []).map(f =>
    `<li>${esc(f.claim)} <span class="dim">— <code>${esc(f.evidence)}</code></span></li>`).join("");
  const decs = (spec.decisions || []).map(d =>
    `<li><b>${esc(d.decision)}</b> — ${esc(d.why)}</li>`).join("");
  const risks = (spec.risks || []).map(r =>
    `<li>${esc(typeof r === "string" ? r : r.risk)}</li>`).join("");
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
      mdPlan(spec, st.adrs || []));
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
    inc.status = "authorized"; inc.authorizedAt = Date.now(); inc.note = "";
    log1(st, `go: increment ${n} (${inc.title}) authorized`);
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
    // An increment that declared an observability check cannot be done until
    // the check has a verdict. Declaring one is the whole point: a plan that
    // promises a signal and ships without looking at it has promised nothing.
    if (obsBlocks(inc) && !force)
      die(`increment ${n} declares an observability check and it is ${inc.obs.status}` +
        (inc.obs.note ? `\n  last note: ${inc.obs.note}` : "") +
        `\n\n  what to verify:    deep-plan obs check ${slug} ${n}` +
        `\n  record the result: deep-plan obs pass ${slug} ${n} "<what you saw>"` +
        `\n\n  or override, which is written to the log:` +
        `\n    deep-plan done ${slug} ${n} --force`);
    inc.status = "done"; inc.doneAt = Date.now();
    // An override is logged for the same reason the verdict is recorded: someone
    // reading the history has to be able to see that the signal was skipped.
    log1(st, `done: increment ${n}` +
      (obsBlocks(inc) ? ` (observability ${inc.obs.status}, overridden with --force)` : ""));
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
    if (inc.obs && (inc.obs.status === "pass" || inc.obs.status === "fail")) {
      const was = inc.obs.status, note = inc.obs.note || "";
      inc.obs = { status: "pending", at: 0,
        note: `was ${was}${note ? `: ${note}` : ""} (reset — re-verify)`,
        version: inc.obs.version || "" };
      log1(st, `reset: increment ${n} — observability verdict (${was}) returned to pending`);
    } else {
      log1(st, `reset: increment ${n}`);
    }
  } else die("unknown transition " + action);
  writeState(st); rerenderWorking(slug);
  say(`${action} ${slug} ${n}`);
  if (action === "go") openWorkingSurface(st);
}

// The go-ahead opens the plan's working surface in the Dock, so the page you
// steer from appears the moment there is something to steer. Same coupling
// budget as `done` opening `cmux diff`: strictly best-effort against the
// board's intent server (whose open_plan reuses the existing Dock tab instead
// of stacking a new one per go) — no server, no row, no cmux means silence,
// never a failed go.
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
// and untracked. Opens in `cmux diff` when available; prints the path either way.
function incrementDiff(st, inc) {
  if (!inc.startSha || !st.root) return;
  try {
    execSync("git add -AN", { cwd: st.root });
    const patch = execSync(`git diff ${inc.startSha}`, { cwd: st.root, maxBuffer: 64e6 }).toString();
    if (!patch.trim()) return;
    const p = path.join(PLANS_DIR, `${st.slug}.inc${inc.n}.patch`);
    fs.writeFileSync(p, patch);
    const title = `${st.slug} · increment ${inc.n} since ${inc.startSha.slice(0, 8)}`;
    const r = spawnSync("cmux", ["diff", "--title", title, p], { stdio: "ignore" });
    if (r.error || r.status !== 0) say(`patch: ${p}\n  view: git -C ${st.root} diff ${inc.startSha.slice(0, 8)}`);
  } catch { /* diff is a courtesy, never a failure */ }
}

// ---------------------------------------------------------------- status

function statusRows() {
  return allStates().filter(st => st.phase !== "closed").map(st => ({
    slug: st.slug, root: st.root || "", phase: st.phase,
    rootBroken: !!(st.root && !fs.existsSync(st.root)),
    gate: gateView(st), progress: progress(st), session: st.session || "",
    approved: (st.approved && st.approved.path) || "",
    // Increments whose declared observability check is still outstanding. These
    // cannot go `done` without --force, so a plan that looks one step from
    // finished may not be — the board reads this from --json.
    obsOutstanding: (st.increments || []).filter(obsBlocks)
      .map(i => ({ n: i.n, status: i.obs.status })),
  }));
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
      say("  observability outstanding: " +
        r.obsOutstanding.map(o => `${o.n} (${o.status})`).join(", ") +
        " — `deep-plan obs check` for what to run");
    say(`  ${r.progress.done}/${r.progress.total} increments` +
      (r.progress.next ? ` · next: ${r.progress.next.n}. ${r.progress.next.title}` : "") +
      (r.progress.blocked.length ? ` · blocked: ${r.progress.blocked.map(b => b.title).join(", ")}` : ""));
  }
}

// ---------------------------------------------------------------- observability

// `obs check` prints what the SPEC already declared. The older engine generated
// these check blocks per vendor, which is where all its org-specific knowledge
// lived; the engine itself only ever needed to display them and record a
// verdict. So the generators do not come across — the declaration is authored
// in the spec like every other commitment the plan makes.
function obsCheck(slug, n) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  const specPath = path.join(KEYS_DIR, slug + ".spec.json");
  if (!fs.existsSync(specPath)) die("no archived spec for " + slug);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const d = (spec.deliverables || [])[inc.n - 1] || {};
  const checks = (d.observability && d.observability.checks) || [];
  say(`${slug} increment ${inc.n}: ${inc.title}`);
  say(`verdict: ${inc.obs ? inc.obs.status : "n/a"}` +
    (inc.obs && inc.obs.note ? ` — ${inc.obs.note}` : ""));
  if (!checks.length) {
    say("\nthis increment declares no observability check, so `done` is not gated on one.");
    say(`to gate it, add an "observability" block to deliverables[${inc.n - 1}] and re-render.`);
    return;
  }
  say(`\n${checks.length} check(s) to run:`);
  for (const c of checks) {
    say(`\n  [${c.system || "?"}] ${c.name || ""}`);
    if (c.query) say(`    query:  ${c.query}`);
    if (c.expect) say(`    expect: ${c.expect}`);
    if (c.note) say(`    note:   ${c.note}`);
  }
  say(`\nrecord it:  deep-plan obs pass|fail ${slug} ${inc.n} "<what you saw>"`);
}

// `obs reset` is the explicit escape hatch: the checks changed, or the verdict
// is stale for a reason the engine cannot see. Increment `reset` re-gates on its
// own, so this is for the case where the work stands but the evidence does not.
function obsReset(slug, n) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  if (!inc.obs || inc.obs.status === "n/a")
    die(`increment ${n} has no observability verdict to reset`);
  const was = inc.obs.status;
  inc.obs = { status: "pending", at: 0,
    note: `was ${was}${inc.obs.note ? `: ${inc.obs.note}` : ""} (reset by hand)`,
    version: inc.obs.version || "" };
  log1(st, `obs reset: increment ${inc.n} (was ${was})`);
  writeState(st); rerenderWorking(slug);
  say(`obs verdict for ${slug} ${inc.n} back to pending (was ${was}) — \`done\` is blocked again`);
}

function obsRecord(slug, n, verdict, note) {
  const st = readState(slug) || die("no plan " + slug);
  const inc = findInc(st, n);
  // Recording against an increment that declared nothing is a sign the spec and
  // the verdict disagree about what this increment is. Say so rather than
  // storing a verdict nothing will ever read.
  if (!inc.obs || inc.obs.status === "n/a")
    die(`increment ${n} declares no observability check\n` +
        `  add an "observability" block to the spec's deliverables[${inc.n - 1}] and re-render first`);
  if (verdict === "fail" && !note)
    die(`say what failed: deep-plan obs fail ${slug} ${n} "<what you saw>"`);
  inc.obs = { status: verdict, at: Date.now(), note: note || "", version: inc.obs.version || "" };
  log1(st, `obs ${verdict}: increment ${inc.n}${note ? ` — ${note}` : ""}`);
  writeState(st); rerenderWorking(slug);
  say(`recorded obs ${verdict} for ${slug} ${inc.n}` +
    (verdict === "pass" ? "" : " — `done` stays blocked until this passes"));
}

// ---------------------------------------------------------------- main

// Every verb the switch below handles. Kept beside it so the usage listing can
// say that an extension file is SHADOWED rather than advertise a verb that can
// never dispatch — a user who writes ext/status.mjs and sees it listed as
// available has been told the opposite of the truth.
const BUILTIN_VERBS = new Set([
  "render", "rehydrate", "validate", "adr", "export-artifact", "attach-artifact",
  "grade", "status", "go", "start", "done", "reset", "block", "obs",
  "open-gate", "shut-gate", "close", "diff", "help",
]);

const [, , cmd, ...rest] = process.argv;
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--force") flags.force = true;
  else if (rest[i] === "--root") flags.root = rest[++i];
  else if (rest[i] === "--at") flags.at = rest[++i];
  else if (rest[i] === "--json") flags.json = true;
  else args.push(rest[i]);
}

switch (cmd) {
  case "render": {
    if (!args[0]) die("render <spec.json> [--root DIR] [--force]");
    await render(args[0], flags); break;
  }
  case "rehydrate": rehydrate(args[0] || die("rehydrate <slug>")); break;
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
    transition("go", slug, n || "next"); break;
  }
  case "start": case "done": case "reset":
    transition(cmd, args[0], args[1] ?? die(cmd + " <slug> <n>"), undefined, flags.force); break;
  case "block": transition("block", args[0], args[1], args.slice(2).join(" ")); break;
  case "obs": {
    const sub = args[0];
    if (sub === "check") obsCheck(args[1] || die("obs check <slug> <n>"), args[2] ?? die("obs check <slug> <n>"));
    else if (sub === "reset") obsReset(args[1] || die("obs reset <slug> <n>"), args[2] ?? die("obs reset <slug> <n>"));
    else if (sub === "pass" || sub === "fail")
      obsRecord(args[1] || die(`obs ${sub} <slug> <n> "<what you saw>"`),
        args[2] ?? die(`obs ${sub} <slug> <n> "<what you saw>"`), sub, args.slice(3).join(" "));
    else die('obs check|pass|fail|reset <slug> <n> ["<what you saw>"]');
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
    incrementDiff(st, inc); break;
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
                                              (done --force overrides a pending
                                              observability verdict, and logs it;
                                              reset puts the verdict back to
                                              pending — the work is being redone)
  obs check <slug> <n>                        the checks the spec declared for it
  obs pass|fail <slug> <n> "<what you saw>"   record the verdict; done is blocked
                                              until a declared check passes
  obs reset <slug> <n>                        verdict back to pending, keeping
                                              what it was in the note
  open-gate|shut-gate <slug>                  the human lever, logged
  diff <slug> [n]                             the increment's patch since start
  close <slug>                                retire a finished plan`);
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
