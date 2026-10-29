// Merging two states of one plan, when two writers raced on its state branch
// (lib/sync.mjs). The rules, in the order they apply:
//
//   increments  each keeps the side whose latest transition is later, so a
//               reset after a done wins, and a go after a reset does
//   checks      each check keeps its newest verdict, from either side
//   log         the union, by time
//   guests      the union
//   the rest    the side with the latest activity (its phase, owner, share)
//
// A transition's time is the latest of inc.changedAt, which every transition
// stamps (block and reset had no time of their own), and the authorizedAt,
// startedAt and doneAt older plans carry; the gate's flip to working stamps
// startedAt. Ties go to the side passed first.
import { VERDICT_FIELDS } from "./state.mjs";

export function transitionAt(inc) {
  if (!inc) return 0;
  return Math.max(inc.changedAt || 0, inc.authorizedAt || 0, inc.startedAt || 0, inc.doneAt || 0);
}

function checkAt(inc) {
  return Math.max(0, ...Object.values((inc && inc.checks) || {}).map(v => (v && v.at) || 0));
}

export function lastActivity(st) {
  const log = (st.log || []).reduce((m, l) => Math.max(m, l.at || 0), 0);
  return Math.max(log, ...(st.increments || []).map(i => Math.max(transitionAt(i), checkAt(i))));
}

const verdictOf = v => Object.fromEntries(Object.entries(v).filter(([k]) => VERDICT_FIELDS.includes(k)));
const metaOf = v => Object.fromEntries(Object.entries(v).filter(([k]) => !VERDICT_FIELDS.includes(k)));

function mergeChecks(base, other) {
  const a = (base && base.checks) || {}, b = (other && other.checks) || {};
  if (typeof a !== "object" || typeof b !== "object") return a;
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const va = a[id], vb = b[id];
    if (!va) { out[id] = vb; continue; }
    if (!vb || (vb.at || 0) <= (va.at || 0)) { out[id] = va; continue; }
    // The newer verdict; what the check is stays the chosen side's.
    out[id] = { ...metaOf(va), ...verdictOf(vb) };
  }
  return out;
}

// a and b: two parsed states of the same plan. Returns a new state; neither
// input is changed.
export function mergeStates(a, b) {
  if (!a) return structuredClone(b);
  if (!b) return structuredClone(a);
  const [lead, other] = lastActivity(b) > lastActivity(a) ? [b, a] : [a, b];
  const out = structuredClone(lead);
  const byN = new Map((other.increments || []).map(i => [i.n, i]));
  out.increments = (lead.increments || []).map(li => {
    const oi = byN.get(li.n);
    if (!oi) return structuredClone(li);
    const [base, rest] = transitionAt(oi) > transitionAt(li) ? [oi, li] : [li, oi];
    const inc = structuredClone(base);
    if (base.checks || rest.checks) inc.checks = structuredClone(mergeChecks(base, rest));
    return inc;
  });
  for (const oi of other.increments || [])
    if (!out.increments.some(i => i.n === oi.n)) out.increments.push(structuredClone(oi));
  const key = l => `${l.at}\u0000${l.what}`;
  const seen = new Set();
  out.log = [...(a.log || []), ...(b.log || [])].filter(l => !seen.has(key(l)) && seen.add(key(l)))
    .sort((x, y) => (x.at || 0) - (y.at || 0)).slice(-200).map(l => ({ ...l }));
  if (a.guests || b.guests) out.guests = { ...(other.guests || {}), ...(lead.guests || {}) };
  // The phase follows the merged increments: a plan is not finished while
  // one is open, and is when both sides' work together finishes it.
  const allDone = out.increments.length && out.increments.every(i => i.status === "done");
  if (!allDone && (out.phase === "delivery" || out.phase === "done")) out.phase = "implementing";
  if (allDone && out.phase === "implementing" && ["delivery", "done"].includes(other.phase)) out.phase = other.phase;
  return out;
}

// The plan's other files: the union, and on a clash the side whose state
// leads. The state file itself is the merged one.
export function mergeFiles(aFiles, bFiles, aState, bState, stateRel, merged) {
  const lead = lastActivity(bState) > lastActivity(aState) ? bFiles : aFiles;
  const out = { ...(lead === aFiles ? bFiles : aFiles), ...lead };
  out[stateRel] = Buffer.from(JSON.stringify(merged, null, 2) + "\n");
  return out;
}
