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
  // Card paths are relative to the plan root; the diff's, to the repo top.
  const pre = planMap.prefix || "";
  const inRepo = p => pre + p;
  const how = new Map();
  for (const f of files || []) {
    if (f.path) how.set(f.path, f.status || "M");
    if (f.oldPath) how.set(f.oldPath, f.status === "R" ? "R" : f.status || "M");
  }
  const named = new Set(scope.map(c => inRepo(c.path)));
  // A planned removal is done only when the diff deletes (or renames away)
  // the file; an edit to it leaves the removal undone.
  const done = c => {
    const s = how.get(inRepo(c.path));
    if (!s) return false;
    return c.change === "remove" ? s === "D" || s === "R" : true;
  };
  const cards = scope.map(c => ({ ...c, status: done(c) ? "ok" : "miss",
    ...(c.change === "remove" && how.has(inRepo(c.path)) && !done(c) ? { undone: "edited, not removed" } : {}) }));
  const elsewhere = new Map(planMap.cards.filter(c => !inScope(c)).map(c => [inRepo(c.path), c.increments || []]));
  const extra = (files || []).filter(f => !named.has(f.path) && !(f.oldPath && named.has(f.oldPath))).map(f => ({
    // Shown relative to the plan root when it sits under it, like the cards.
    id: f.path.startsWith(pre) ? f.path.slice(pre.length) : f.path,
    path: f.path.startsWith(pre) ? f.path.slice(pre.length) : f.path,
    diffPath: f.path, change: CHANGE[f.status] || "modify", increments: [],
    facts: [], contracts: [], usedBy: empty(), uses: empty(), links: [],
    status: "extra", plannedIn: elsewhere.get(f.path) || [],
  }));
  const count = s => cards.filter(c => c.status === s).length;
  return { inc: n === null ? "all" : n, cards, extra, counts: { ok: count("ok"), miss: count("miss"), extra: extra.length } };
}
