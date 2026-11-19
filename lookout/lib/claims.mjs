// The claims check: a fresh agent tries to break each assumption a reviewer
// wrote on its notes (notes.mjs), and answers per assumption id.
//
//   held      — the claim is true; `at` cites the line that shows it, checked
//               against the repo as an assumption's enforced_at is.
//   broken    — the claim is false; `finding` says what breaks, filed as a
//               CONFIRMED cross-system finding on a file in the diff.
//   unchecked — the agent could not settle it either way; `finding` is filed
//               as a PLAUSIBLE cross-system finding, so the gap stays open
//               for the human instead of passing as held.
//
// The gate (findings.mjs) answers 4 while any assumption has no verdict, so
// a review is not finished until its cross-system claims were attacked by
// someone other than the reviewer who wrote them (ADR: the claims check).
import { FINDING, CROSS, validate as validateFindings, ingest as ingestFindings } from "./findings.mjs";

export const STATUSES = ["held", "broken", "unchecked"];
const clip = (s, n = 1000) => String(s ?? "").trim().slice(0, n);
const norm = p => String(p || "").replace(/^\.?\//, "");
const now = () => new Date().toISOString();

const AT = {
  type: "object", required: ["path", "line"],
  description: "held only: the line that shows the claim is true; any file in the repo",
  properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 },
    side: { enum: ["new", "old"], default: "new" } },
};
const CLAIM_FINDING = {
  ...FINDING,
  required: ["file", "line", "severity", "summary", "failure_scenario"],
  description: "broken or unchecked only: the defect, anchored on a file in the diff (the line the claim rests on); category and verdict are set for you",
};
export const VERDICT_SCHEMA = {
  type: "object", required: ["id", "status", "why"],
  properties: {
    id: { type: "string", description: "the assumption's id, as listed (n3.a1)" },
    status: { enum: STATUSES },
    why: { type: "string", maxLength: 600, description: "what you traced, naming files and lines" },
    at: AT,
    finding: CLAIM_FINDING,
  },
};
export const OUTPUT_SCHEMA = {
  type: "object", required: ["verdicts"],
  properties: { verdicts: { type: "array", items: VERDICT_SCHEMA, description: "one per assumption listed" } },
};

// Every assumption still owed a verdict, with the note it sits on.
export function pending(review) {
  return (review.notes || []).flatMap(n => (n.assumptions || [])
    .filter(a => !a.verdict).map(a => ({ ...a, note: n.id, files: n.files })));
}

// The claims agent's reply: an object with a verdicts array, or the array
// alone, either inside a ```json fence with prose around it.
export function parse(text) {
  const t = String(text || "").trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) tries.push(fence[1]);
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  const c = t.indexOf("["), d = t.lastIndexOf("]");
  if (c >= 0 && d > c) tries.push(t.slice(c, d + 1));
  for (const x of tries) {
    let v;
    try { v = JSON.parse(x); } catch { continue; }
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.verdicts)) return v.verdicts;
  }
  throw new Error('no JSON object with a "verdicts" array in the input');
}

// Validate verdicts against the review. `cite` checks a held verdict's line
// as notes.mjs checks an enforced_at; `anchors` places a finding as
// findings.mjs does. A claim answered again with the verdict it already has
// is skipped, as a repeated finding is: a corrected reply carries the whole
// object again. Returns { accepted: [{id, status, why, at?, finding?}],
// rejected: [{index, why}], repeats }.
export function validate(review, items, { anchors, cite = () => null } = {}) {
  const owed = new Map(pending(review).map(a => [a.id, a]));
  const known = new Set((review.notes || []).flatMap(n => (n.assumptions || []).map(a => a.id)));
  const done = new Map((review.notes || []).flatMap(n => (n.assumptions || []).filter(a => a.verdict).map(a => [a.id, a.verdict.status])));
  const accepted = [], rejected = [], seen = new Set();
  let repeats = 0;
  (items || []).forEach((x, index) => {
    const bad = why => rejected.push({ index, why });
    if (!x || typeof x !== "object") return bad("not an object");
    const id = String(x.id || "").trim();
    if (!known.has(id)) return bad(`${JSON.stringify(x.id)} is not an assumption in this review`);
    if (!owed.has(id)) {
      if (done.get(id) === String(x.status || "").toLowerCase()) { repeats++; return; }
      return bad(`${id} already has a verdict (${done.get(id)})`);
    }
    if (seen.has(id)) return bad(`${id} is answered twice`);
    const status = String(x.status || "").toLowerCase();
    if (!STATUSES.includes(status)) return bad(`${id}: status must be one of ${STATUSES.join(", ")}`);
    const why = clip(x.why, 600);
    if (!why) return bad(`${id}: why is required: what you traced, naming files and lines`);
    if (status === "held") {
      const e = x.at;
      if (!e || typeof e !== "object") return bad(`${id}: a held claim needs at: {path, line, side}, the line that shows it`);
      const p = norm(e.path), line = Number(e.line);
      const side = e.side === undefined || e.side === null ? "new" : String(e.side).toLowerCase();
      if (!p || !Number.isInteger(line) || line < 1) return bad(`${id}: at needs a path and a positive line`);
      if (side !== "new" && side !== "old") return bad(`${id}: at.side must be new or old`);
      const c = cite(p, side);
      if (c && c.missing) return bad(`${id}: at: ${JSON.stringify(p)} ${c.missing}`);
      if (c && line > c.lines) return bad(`${id}: at: ${p} has ${c.lines} line(s) on the ${side} side, not ${line}`);
      seen.add(id);
      accepted.push({ id, status, why, at: { path: p, line, side }, verified: !!c });
      return;
    }
    if (!x.finding || typeof x.finding !== "object") return bad(`${id}: a ${status} claim needs a finding on a file in the diff`);
    const f = { ...x.finding, category: CROSS, verdict: status === "broken" ? "CONFIRMED" : "PLAUSIBLE" };
    const fv = validateFindings(review, [f], anchors);
    if (!fv.accepted.length) return bad(`${id}: finding: ${fv.rejected[0].why}`);
    seen.add(id);
    accepted.push({ id, status, why, finding: fv.accepted[0] });
  });
  return { accepted, rejected, repeats };
}

// Store accepted verdicts (mutates): each broken or unchecked one files its
// finding first, and the verdict names it. Returns { verdicts, findings }.
export function ingest(review, accepted, by = "claims") {
  const byId = new Map((review.notes || []).flatMap(n => (n.assumptions || []).map(a => [a.id, a])));
  const added = [];
  for (const v of accepted) {
    const a = byId.get(v.id);
    if (!a || a.verdict) continue;
    let fid = null;
    if (v.finding) {
      const before = (review.findings || []).length;
      const out = ingestFindings(review, [v.finding], by);
      // An exact repeat of a finding already there: the verdict names that one.
      fid = out.length ? out[0].id : ((review.findings || []).slice(0, before)
        .find(f => f.file === v.finding.file && f.line === v.finding.line && f.summary === v.finding.summary) || {}).id || null;
      added.push(...out);
    }
    a.verdict = { status: v.status, why: v.why, ...(v.at ? { at: v.at, verified: v.verified } : {}),
                  ...(fid ? { finding: fid } : {}), by, when: now() };
  }
  return { verdicts: accepted.length, findings: added };
}
