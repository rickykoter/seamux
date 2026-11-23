// The side column's tabs, grouped by kind: the Wake, then one chip each for
// plans, reviews (lookout's pages), asks and everything else. The chip says
// "Review", not "Lookout": Lookout is the top bar's view, which runs reviews
// for every repo, and this chip is only this workspace's review pages. A pure module (no DOM),
// so sheetgroups_probe.ts can run it under Node.

export const WAKE = "wake";

/** The groups after the Wake, in strip order, with the ⌘⇧ letter that jumps to each. */
export const GROUPS = [
  { id: "plan", label: "Plan", key: "P" },
  { id: "review", label: "Review", key: "L" },
  { id: "ask", label: "Ask", key: "A" },
  { id: "other", label: "Other", key: "O" },
] as const;
export type GroupId = (typeof GROUPS)[number]["id"];

/** The group a tab's kind files under; the Wake is its own. */
export function groupOf(kind: string): GroupId | typeof WAKE {
  if (kind === WAKE) return WAKE;
  // A plan's scenarios sit with the plan.
  if (kind === "scenarios") return "plan";
  return kind === "plan" || kind === "review" || kind === "ask" ? kind : "other";
}

const RANK: Record<string, number> = { [WAKE]: 0, plan: 1, review: 2, ask: 3, other: 4 };

/** Tabs in strip order: the Wake, then each group, each in the order it came. */
export function ordered<T extends { kind: string }>(tabs: T[]): T[] {
  return tabs.map((t, i) => ({ t, i })).sort((a, b) => RANK[groupOf(a.t.kind)] - RANK[groupOf(b.t.kind)] || a.i - b.i).map((x) => x.t);
}

type Pickable = { key: string; kind: string; waiting: boolean };

/** A group's tabs in the order its key steps through them, its list shows
 *  them and its "2/3" counts: the ones waiting on you first, then the
 *  rest, each in the order they came. */
export function round<T extends { waiting: boolean }>(its: T[]): T[] {
  return [...its.filter((t) => t.waiting), ...its.filter((t) => !t.waiting)];
}

/** The tab a group's key goes to. On a tab of that group already: the next
 *  in its round, which takes the ones waiting on you first, then the rest,
 *  each in the order they came. Else one that waits on you (what a key pressed in a
 *  hurry is for); else the one last picked there, if it is still open; else
 *  the first. "" when the group is empty. */
export function jump(tabs: Pickable[], group: GroupId, active: string, last: string): string {
  const its = tabs.filter((t) => groupOf(t.kind) === group);
  if (!its.length) return "";
  const at = its.findIndex((t) => t.key === active);
  if (at >= 0) {
    const r = round(its);
    return r[(r.findIndex((t) => t.key === active) + 1) % r.length].key;
  }
  return face(tabs, group, active, last);
}

/** The tab a group's chip stands for, and a click on it opens: the active
 *  one if it is in the group, else one that waits on you, else the one last
 *  picked there, else the first. */
export function face(tabs: Pickable[], group: GroupId, active: string, last: string): string {
  const its = tabs.filter((t) => groupOf(t.kind) === group);
  return (its.find((t) => t.key === active) ?? its.find((t) => t.waiting) ?? its.find((t) => t.key === last) ?? its[0])?.key ?? "";
}
