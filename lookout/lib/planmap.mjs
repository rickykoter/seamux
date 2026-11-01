// The Map view's comparison: a deep-plan End state map (review.planMap, from
// `lookout open --plan-map`) held against the files this diff touches.
//
// Each planned card in scope (the review's increment, or every card for a
// full delivery) is "ok" when the diff touches it and "miss" when it does
// not. A file the diff touches that no card in scope names is "extra": a
// card of its own, marked with the increments that do plan it, if any.
// The page draws the result with the shared renderer (page/plan-map.js).

const CHANGE = { A: "new", D: "remove", C: "new" };
const empty = () => ({ paths: [], more: 0 });

// `inc` is the review's source.inc: a number, "all", or undefined.
export function comparePlan(planMap, files, inc) {
  if (!planMap || !Array.isArray(planMap.cards)) return null;
  const n = typeof inc === "number" ? inc : null;
  const inScope = c => n === null || (c.increments || []).includes(n);
  const scope = planMap.cards.filter(inScope);
  const touched = new Set();
  for (const f of files || []) {
    if (f.path) touched.add(f.path);
    if (f.oldPath) touched.add(f.oldPath);
  }
  const named = new Set(scope.map(c => c.path));
  const cards = scope.map(c => ({ ...c, status: touched.has(c.path) ? "ok" : "miss" }));
  const elsewhere = new Map(planMap.cards.filter(c => !inScope(c)).map(c => [c.path, c.increments || []]));
  const extra = (files || []).filter(f => !named.has(f.path) && !(f.oldPath && named.has(f.oldPath))).map(f => ({
    id: f.path, path: f.path, change: CHANGE[f.status] || "modify", increments: [],
    facts: [], contracts: [], usedBy: empty(), uses: empty(), links: [],
    status: "extra", plannedIn: elsewhere.get(f.path) || [],
  }));
  const count = s => cards.filter(c => c.status === s).length;
  return { inc: n === null ? "all" : n, cards, extra, counts: { ok: count("ok"), miss: count("miss"), extra: extra.length } };
}
