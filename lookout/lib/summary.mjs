// A review's state in one object, for a reader that should not re-implement
// lookout's rules (the seamux app's Wake, through `lookout list --json`).
// Everything here is derived from the stored review with the rules in
// findings.mjs, so a change to the gate or to re-review rounds reaches every
// reader at once.
import fs from "node:fs";
import path from "node:path";
import { gate, isOpen, pendingRound, MAX_ROUNDS, SEVERITIES } from "./findings.mjs";

// Where a review is, one word for a reader to label:
//   finding  no reviewer has reported yet
//   claims   the reviewer's assumptions wait on the claims check
//   round    addressed findings wait on a re-review (round n of MAX_ROUNDS)
//   ask      addressed findings wait, and the re-review rounds are used up:
//            the person decides how to go on
//   fix      findings are open and not yet addressed
//   close    every finding left is addressed and re-reviewed: it waits on
//            whoever may close it
//   past     nothing is left open
export const STAGES = ["finding", "claims", "round", "ask", "fix", "close", "past"];

export function summarize(review) {
  const findings = review.findings || [];
  const open = findings.filter(isOpen);
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, open.filter(f => f.severity === s).length]));
  const pending = pendingRound(review);
  const sealed = (review.rounds || []).length;
  const sealedIds = new Set((review.rounds || []).flatMap(r => r.findings || []));
  const assumptions = (review.notes || []).flatMap(n => n.assumptions || []);
  const claims = {
    unchecked: assumptions.filter(a => !a.verdict).length,
    broken: assumptions.filter(a => a.verdict?.status === "broken").length,
  };
  const g = gate(review);
  const agentMayClose = !!review.policy?.agentMayClose;
  // Addressed and re-reviewed: only a close is left, and when the agent may
  // not close, only the person can.
  const reReviewed = open.filter(f => f.status === "addressed" && sealedIds.has(f.id));
  const stage = !review.reviewedAt ? "finding"
    : claims.unchecked ? "claims"
    : pending.length ? (sealed >= MAX_ROUNDS ? "ask" : "round")
    : open.some(f => (f.status || "open") === "open") ? "fix"
    : open.length ? "close"
    : "past";
  // Only once nothing else is left: while claims wait or fixes are under way
  // the agent still has work, and the review is not waiting on the person.
  const closeIds = stage === "close" && !agentMayClose ? reReviewed.map(f => f.id) : [];
  const past = stage === "past";
  const closedAt = past
    ? findings.map(f => f.statusAt || "").filter(Boolean).sort().pop() || review.reviewedAt || review.updatedAt || null
    : null;
  return {
    id: review.id,
    title: review.title || review.id,
    root: review.source?.root || "",
    branch: review.source?.branch || "",
    plan: review.source?.plan || "",
    inc: review.source?.inc ?? null,
    createdAt: review.createdAt || null,
    updatedAt: review.updatedAt || null,
    reviewedAt: review.reviewedAt || null,
    reviewer: review.policy?.reviewer || "agent",
    agentMayClose,
    stage,
    gate: { code: g.code, why: g.why },
    counts,
    // `counts` is every open finding by severity, addressed ones included;
    // these split the same findings by status.
    unaddressed: open.filter(f => (f.status || "open") === "open").length,
    addressed: open.filter(f => f.status === "addressed").length,
    round: { sealed, pending: pending.length, max: MAX_ROUNDS, n: pending.length ? Math.min(sealed + 1, MAX_ROUNDS) : sealed },
    claims,
    needsPerson: stage === "ask" || closeIds.length > 0,
    closeIds,
    past,
    closedAt,
  };
}

// A path as the filesystem resolves it, so /tmp and /private/tmp, or a
// trailing slash, still match.
function real(p) {
  const s = String(p || "").replace(/(.)\/+$/, "$1");
  try { return fs.realpathSync(s); } catch { return path.resolve(s); }
}

// The reviews whose source is the worktree at `root`.
export function underRoot(reviews, root) {
  const want = real(root);
  return reviews.filter(r => r.source?.root && real(r.source.root) === want);
}
