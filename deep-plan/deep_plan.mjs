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
import {
  STATE_DIR, KEYS_DIR, PLANS_DIR,
  readState, writeState, allStates, log1, progress, gateView,
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

  for (const d of spec.decisions || [])
    if (!d.why) errs.push(`decision "${d.decision}" has no why`);
  for (const f of spec.verifiedFacts || [])
    if (!f.claim || !f.evidence)
      errs.push("a verifiedFacts entry is missing claim or evidence (path:line). Uncited claims belong in risks.");

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

function mdPlan(spec) {
  const L = [];
  L.push(`# ${spec.title}`, "", `> plan \`${spec.slug}\` — generated by deep-plan; edit the spec and re-render, never this file.`, "");
  L.push("## Context", "", spec.context, "");
  if ((spec.decisions || []).length) {
    L.push("## Decisions", "");
    for (const d of spec.decisions) L.push(`- **${d.decision}** — ${d.why}`);
    L.push("");
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
  for (const dg of spec.diagrams || []) {
    L.push(`## ${dg.question}`, "", "```mermaid", dg.mermaid.trim(), "```", "");
  }
  L.push("## Increments", "");
  (spec.deliverables || []).forEach((d, i) => {
    L.push(`### ${i + 1}. ${d.title}`, "", d.body || "");
    if ((d.files || []).length) L.push("", "Files: " + d.files.map(f => "`" + f + "`").join(", "));
    L.push("");
  });
  if ((spec.verification || []).length) {
    L.push("## Verification", "");
    for (const v of spec.verification) L.push("- " + v);
    L.push("");
  }
  return L.join("\n");
}

function mermaidB64() {
  return fs.readFileSync(MERMAID).toString("base64");
}

// One <head> shared by both HTML surfaces. Mermaid is inlined as base64 so the
// file works opened from disk; the intent server swaps that src for its cached
// /mermaid.min.js on the way out (regex: src="data:text/javascript;base64,…").
function htmlHead(title, b64) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<script src="data:text/javascript;base64,${b64}"></script>
<style>
:root{--bg:#0e1116;--fg:#d5dbe3;--dim:#859289;--line:#232a33;--accent:#7aa2f7;
--good:#4ADE80;--warn:#F5A524;--bad:#F97066}
body{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,system-ui,sans-serif;
max-width:860px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:22px}h2{font-size:17px;margin-top:2em;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px}
code{background:#161b22;border-radius:4px;padding:1px 5px;font-size:13px}
.dim{color:var(--dim)}.mermaid{background:#12161d;border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}
.inc{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.inc .st{float:right;font-size:12px;padding:2px 8px;border-radius:10px;border:1px solid var(--line)}
.st-done{color:var(--good)}.st-working{color:var(--accent)}.st-authorized{color:var(--warn)}
.st-blocked{color:var(--bad)}.st-pending{color:var(--dim)}
.dp-act{margin-right:6px;background:#1a212b;color:var(--fg);border:1px solid var(--line);
border-radius:6px;padding:3px 12px;cursor:pointer}
.dp-act[disabled]{opacity:.45;cursor:default}
.dp-path{color:var(--fg);cursor:default}
.dp-live .dp-path{color:var(--accent);text-decoration:underline;cursor:pointer}
.dp-path.dp-bad{color:var(--bad)}
.q{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.q .opt{display:block;margin:4px 0 4px 12px}
label.auto{position:fixed;top:10px;right:14px;font-size:12px;color:var(--dim)}
</style></head><body>`;
}

const MERMAID_BOOT = `<script>mermaid.initialize({startOnLoad:true,theme:"dark"});</script>`;

function diagramsHtml(spec) {
  return (spec.diagrams || []).map(dg =>
    `<h2>${esc(dg.question)}</h2><pre class="mermaid">${esc(dg.mermaid.trim())}</pre>`).join("\n");
}

function commonBody(spec) {
  const facts = (spec.verifiedFacts || []).map(f =>
    `<li>${esc(f.claim)} <span class="dim">— <code>${esc(f.evidence)}</code></span></li>`).join("");
  const decs = (spec.decisions || []).map(d =>
    `<li><b>${esc(d.decision)}</b> — ${esc(d.why)}</li>`).join("");
  const risks = (spec.risks || []).map(r =>
    `<li>${esc(typeof r === "string" ? r : r.risk)}</li>`).join("");
  return `<h1>${esc(spec.title)}</h1>
<p class="dim">plan <code>${esc(spec.slug)}</code></p>
<h2>Context</h2><p>${esc(spec.context).replace(/\n\s*\n/g, "</p><p>")}</p>
${decs ? `<h2>Decisions</h2><ul>${decs}</ul>` : ""}
${facts ? `<h2>Verified facts</h2><ul>${facts}</ul>` : ""}
${risks ? `<h2>Risks</h2><ul>${risks}</ul>` : ""}
${diagramsHtml(spec)}`;
}

function reviewHtml(spec, b64) {
  // Quiz options shuffled per-slug; the shuffled correct position lives in the
  // key file, never in this page.
  const qs = (spec.quiz || []).map((q, qi) => {
    const sh = shuffled(q.options, spec.slug + ":" + q.id);
    const opts = sh.map((o, i) => {
      const L = String.fromCharCode(97 + i);
      return `<label class="opt"><input type="radio" name="dp-q-${esc(q.id)}" value="${L}"> ${L}) ${esc(o.v)}</label>`;
    }).join("");
    return `<div class="q" data-qid="${esc(q.id)}"><b>${qi + 1}. ${esc(q.prompt)}</b>${opts}
<div class="dim">id: <code>${esc(q.id)}</code></div></div>`;
  }).join("\n");
  const verif = (spec.verification || []).map(v => `<li><code>${esc(v)}</code></li>`).join("");
  const incs = (spec.deliverables || []).map((d, i) =>
    `<div class="inc"><b>${i + 1}. ${esc(d.title)}</b><p>${esc(d.body || "")}</p>
${(d.files || []).length ? `<p class="dim">files: ${d.files.map(f => `<code>${esc(f)}</code>`).join(" ")}</p>` : ""}
<textarea class="dp-note" data-section="increment ${i + 1}" rows="1" placeholder="comment on this increment (optional)"></textarea></div>`).join("\n");
  // Everything below is client-side only: selections and comments live in the
  // DOM, nothing is stored or sent anywhere, and the page keeps working over
  // file:// (clipboard falls back to select+execCommand there).
  const COPYBACK = `
<h2>Send it back</h2>
<p class="dim">Highlight any text above to pin a comment to it.</p>
<div id="dp-quotes"></div>
<textarea class="dp-note" data-section="general" rows="2" placeholder="general comments (optional)"></textarea>
<p><button id="dp-copyback">Copy for session</button>
<span id="dp-copied" class="dim"></span></p>
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

  // Highlight-to-comment: select any text, a chip appears, clicking it pins
  // the excerpt with its own comment box. The blob labels the comment with
  // the nearest heading and the quote, so the session can find the spot.
  var chip = document.createElement("button");
  chip.id = "dp-hl-add"; chip.textContent = "\\uFF0B comment"; chip.style.display = "none";
  document.body.appendChild(chip);
  document.addEventListener("mouseup", function () {
    setTimeout(function () {
      var sel = window.getSelection();
      var txt = sel ? String(sel).trim() : "";
      if (!txt || sel.rangeCount === 0 || chip.contains(sel.anchorNode)) { chip.style.display = "none"; return; }
      var r = sel.getRangeAt(0).getBoundingClientRect();
      chip.style.left = (window.scrollX + r.right + 6) + "px";
      chip.style.top = (window.scrollY + r.top - 4) + "px";
      chip.style.display = "block";
    }, 0);
  });
  chip.addEventListener("mousedown", function (e) {
    e.preventDefault();
    var sel = window.getSelection();
    var txt = String(sel).trim();
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
    note.setAttribute("data-section", (section ? section + " \\u00B7 " : "") + 'on "' + excerpt + '"');
    var rm = document.createElement("button");
    rm.className = "dp-x"; rm.textContent = "\\u00D7";
    rm.addEventListener("click", function () { row.remove(); });
    row.appendChild(bq); row.appendChild(note); row.appendChild(rm);
    document.getElementById("dp-quotes").appendChild(row);
    chip.style.display = "none";
    sel.removeAllRanges();
    note.focus();
    note.scrollIntoView({ block: "center" });
  });
})();
</script>`;
  return htmlHead(spec.title + " — review", b64) + `<style>
label.opt{cursor:pointer}
.dp-note{display:block;width:100%;box-sizing:border-box;margin:8px 0;background:transparent;
  color:inherit;border:1px solid var(--dim,#888);border-radius:4px;padding:6px;font:inherit}
#dp-copyback{background:var(--accent,#46f);color:#fff;border:0;border-radius:4px;
  padding:8px 14px;font:inherit;cursor:pointer}
#dp-hl-add{position:absolute;z-index:9;background:var(--accent,#46f);color:#fff;border:0;
  border-radius:12px;padding:2px 10px;font:inherit;font-size:.85em;cursor:pointer}
.dp-quote{position:relative;margin:10px 0;padding-left:10px;border-left:3px solid var(--accent,#46f)}
.dp-quote blockquote{margin:0 0 4px;font-style:italic;opacity:.8}
.dp-x{position:absolute;top:0;right:0;background:transparent;border:0;color:inherit;
  opacity:.5;cursor:pointer;font:inherit}
</style>` + commonBody(spec) + `
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

function workingHtml(spec, st, b64) {
  const rows = (st.increments || []).map(inc => {
    const d = (spec.deliverables || [])[inc.n - 1] || {};
    const files = (d.files || []).map(f =>
      `<span class="dp-path" data-file="${esc(f)}">${esc(f)}</span>`).join(" · ");
    const acts = ["go", "start", "done", "block", "reset"].map(a =>
      `<button class="dp-act" data-a="${a}" data-n="${inc.n}" disabled ` +
      `title="${a} increment ${inc.n} — available when served in the Dock">${a}</button>`).join("");
    return `<div class="inc"><span class="st st-${esc(inc.status)}">${esc(inc.status)}</span>
<b>${inc.n}. ${esc(inc.title)}</b>
<p>${esc(d.body || "")}</p>
${files ? `<p class="dim">${files}</p>` : ""}
<p>${acts}</p></div>`;
  }).join("\n");
  const g = gateView(st);
  const logRows = (st.log || []).slice(-12).reverse().map(l =>
    `<li class="dim">${esc(new Date(l.at).toISOString().slice(0, 16).replace("T", " "))} — ${esc(l.what)}</li>`).join("");
  return htmlHead(spec.title, b64) + `
<label class="auto"><input type="checkbox" id="dp-auto" checked> auto-refresh</label>` +
    commonBody(spec) + `
<h2>Gate</h2><p>${g.allow ? "🟢 open" : "🔴 shut"} <span class="dim">— ${esc(g.why)}</span>
<span class="dim">· root <code>${esc(st.root || "?")}</code> · phase ${esc(st.phase)}</span></p>
<h2>Increments</h2>${rows}
${annotationsSection(spec, st)}
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
  };
  fs.writeFileSync(path.join(KEYS_DIR, spec.slug + ".spec.json"), JSON.stringify(spec, null, 2) + "\n");
  fs.writeFileSync(path.join(KEYS_DIR, spec.slug + ".key.json"), JSON.stringify(key, null, 2) + "\n");

  const b64 = mermaidB64();
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".md"), mdPlan(spec));
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".review.html"), reviewHtml(spec, b64));

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
  const old = new Map((st.increments || []).map(i => [i.n, i]));
  st.increments = (spec.deliverables || []).map((d, i) => {
    const prev = old.get(i + 1) || {};
    return { n: i + 1, title: d.title, status: prev.status || "pending",
      authorizedAt: prev.authorizedAt || 0, startedAt: prev.startedAt || 0,
      doneAt: prev.doneAt || 0, note: prev.note || "", startSha: prev.startSha || "" };
  });
  writeState(st);
  fs.writeFileSync(path.join(PLANS_DIR, spec.slug + ".working.html"), workingHtml(spec, st, b64));
  say(`rendered ${spec.slug}: ${PLANS_DIR}/${spec.slug}.md, .review.html, .working.html`);
  say(`spec + key archived under ${KEYS_DIR} (separate tree, on purpose)`);
  if (st.phase === "review") say("phase: review — the alignment check gates everything.");
}

function rerenderWorking(slug) {
  const spec = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, slug + ".spec.json"), "utf8"));
  const st = readState(slug);
  if (!st) return;
  fs.writeFileSync(path.join(PLANS_DIR, slug + ".working.html"), workingHtml(spec, st, mermaidB64()));
}

function rehydrate(slug) {
  const specPath = path.join(KEYS_DIR, slug + ".spec.json");
  if (!fs.existsSync(specPath)) die("no archived spec for " + slug);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const b64 = mermaidB64();
  const md = mdPlan(spec), rv = reviewHtml(spec, b64);
  const mdP = path.join(PLANS_DIR, slug + ".md"), rvP = path.join(PLANS_DIR, slug + ".review.html");
  const same = (p, s) => fs.existsSync(p) && fs.readFileSync(p, "utf8") === s;
  const okMd = same(mdP, md), okRv = same(rvP, rv);
  fs.writeFileSync(mdP, md); fs.writeFileSync(rvP, rv);
  rerenderWorking(slug);
  say(`rehydrated ${slug} — md ${okMd ? "byte-identical" : "REWRITTEN (differs)"}, review ${okRv ? "byte-identical" : "REWRITTEN (differs)"}`);
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

function transition(action, slug, n, why) {
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
    inc.status = "done"; inc.doneAt = Date.now();
    log1(st, `done: increment ${n}`);
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
    log1(st, `reset: increment ${n}`);
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
    const url = `http://127.0.0.1:${port}/do?a=plan&r=${encodeURIComponent(rid)}` +
      `&t=${encodeURIComponent(token)}`;
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
  }));
}

function status(json) {
  const rows = statusRows();
  if (json) { process.stdout.write(JSON.stringify(rows)); return; }
  if (!rows.length) { say("no tracked plans"); return; }
  for (const r of rows) {
    say(`${r.slug}  [${r.phase}]  ${r.gate.allow ? "gate open" : "GATE SHUT"} — ${r.gate.why}`);
    say(`  root ${r.root}${r.rootBroken ? "  ⚠ BROKEN ROOT — gone; the gate FAILS OPEN here" : ""}`);
    say(`  ${r.progress.done}/${r.progress.total} increments` +
      (r.progress.next ? ` · next: ${r.progress.next.n}. ${r.progress.next.title}` : "") +
      (r.progress.blocked.length ? ` · blocked: ${r.progress.blocked.map(b => b.title).join(", ")}` : ""));
  }
}

// ---------------------------------------------------------------- main

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
    transition(cmd, args[0], args[1] ?? die(cmd + " <slug> <n>")); break;
  case "block": transition("block", args[0], args[1], args.slice(2).join(" ")); break;
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
  default:
    say(`deep-plan — plan as artifact, gate per increment
  render <spec.json> [--root DIR] [--force]   spec -> md + review + working surfaces
  rehydrate <slug>                            re-render from the archived spec
  validate <slug|file>                        mermaid + formatting lint of rendered surfaces
  export-artifact <slug> [--json]             shareable annotate-able page (agent publishes it)
  attach-artifact <slug> <url>                record the published artifact in state
  grade <slug> [q1=a q2=c ...]                the alignment check; pass -> implementing
                                              (no answers on a TTY: prompts, keeps them out of history)
  status [--json]                             tracked plans (the board reads --json)
  go <slug> <n|next> | go --at DIR next       authorize an increment
  start|done|block|reset <slug> <n> [why]     move an increment
  open-gate|shut-gate <slug>                  the human lever, logged
  diff <slug> [n]                             the increment's patch since start
  close <slug>                                retire a finished plan`);
    if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
}
