// Merging two states of one plan, when two writers raced on its state branch
// (lib/sync.mjs). The rules, in the order they apply:
//
//   increments  each keeps the side whose latest transition is later, so a
//               reset after a done wins, and a go after a reset does
//   checks      each check keeps its newest verdict, from either side
//   log         the union, by time
//   guests      the union
//   the rest    the side with the latest activity (its phase, owner, share);
//               a field only the other side has is kept
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
  if (out.increments.length) {
    const allDone = out.increments.every(i => i.status === "done");
    if (!allDone && (out.phase === "delivery" || out.phase === "done")) out.phase = "implementing";
    if (allDone && out.phase === "implementing" && ["delivery", "done"].includes(other.phase)) out.phase = other.phase;
  }
  // A plan-level record only one side has (an approved snapshot cut at grade,
  // an applied ADR list, a published artifact) is kept, whichever side leads.
  for (const [k, v] of Object.entries(other))
    if (!["increments", "log", "guests", "phase"].includes(k) && (out[k] === undefined || out[k] === null || out[k] === "") && v !== undefined)
      out[k] = structuredClone(v);
  return out;
}

// A family's control.json from two machines: each hold and take-back is
// decided per child, the newer of the two entries, unless it was released
// (unhold, give-back) later than it was made.
export function mergeControl(a, b) {
  const out = { takenBack: {}, holds: {}, released: { ...(a.released || {}) } };
  for (const [k, at] of Object.entries(b.released || {})) out.released[k] = Math.max(out.released[k] || 0, at || 0);
  for (const kind of ["takenBack", "holds"]) {
    const A = a[kind] || {}, B = b[kind] || {};
    for (const slug of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const e = [A[slug], B[slug]].filter(Boolean).sort((x, y) => (y.at || 0) - (x.at || 0))[0];
      if ((e.at || 0) > (out.released[`${kind}/${slug}`] || 0)) out[kind][slug] = e;
    }
  }
  return out;
}

// An append-only log (a family's trespass.jsonl): both machines' lines, once.
function mergeLines(a, b) {
  const seen = new Set(), out = [];
  for (const l of [...String(a).split("\n"), ...String(b).split("\n")]) if (l.trim() && !seen.has(l)) { seen.add(l); out.push(l); }
  return out.join("\n") + (out.length ? "\n" : "");
}

// The plan's other files: the union, and on a clash the side whose state
// leads, except a family's control (merged per child) and trespass log
// (merged by line). The state file itself is the merged one.
export function mergeFiles(aFiles, bFiles, aState, bState, stateRel, merged) {
  const lead = lastActivity(bState) > lastActivity(aState) ? bFiles : aFiles;
  const out = { ...(lead === aFiles ? bFiles : aFiles), ...lead };
  for (const rel of Object.keys(out)) {
    if (!(rel in aFiles) || !(rel in bFiles)) continue;
    if (/^deep-plan\/state\/families\/[^/]+\/control\.json$/.test(rel)) {
      try {
        const c = mergeControl(JSON.parse(Buffer.from(aFiles[rel]).toString("utf8")), JSON.parse(Buffer.from(bFiles[rel]).toString("utf8")));
        out[rel] = Buffer.from(JSON.stringify(c, null, 2) + "\n");
      } catch { /* one side does not parse: the leading side's stands */ }
    } else if (/^deep-plan\/state\/families\/[^/]+\/trespass\.jsonl$/.test(rel)) {
      out[rel] = Buffer.from(mergeLines(Buffer.from(aFiles[rel]).toString("utf8"), Buffer.from(bFiles[rel]).toString("utf8")));
    }
  }
  out[stateRel] = Buffer.from(JSON.stringify(merged, null, 2) + "\n");
  return out;
}
