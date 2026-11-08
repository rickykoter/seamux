// Plan families in the views: which family a workspace's plan belongs to,
// and a child waiting on its parent saying so.

/** views.rs FamilyMember / FamilyBrief. */
export type FamilyMember = {
  slug: string;
  role: string;
  phase: string;
  done: number;
  total: number;
  n: number;
  open: boolean;
  ws: string | null;
  waits: number[];
  /** As status --json reports it; the Desk never works it out. */
  ready: boolean;
  /** Who gives its go: "parent" for a delegated child, else "human". */
  go: string;
  /** The hold its family's parent wrote on it, or "". */
  held: string;
  increments: FamilyInc[];
};
/** views.rs FamilyInc: one increment's verdicts. */
export type FamilyInc = { n: number; title: string; status: string; checks: string; review: string; by: string };
export type FamilyBrief = { parent: string; members: FamilyMember[]; done: number; total: number };

/** The family a workspace works in, and which member it is. */
export function familyOf(fams: FamilyBrief[] | undefined, ws: string): { fam: FamilyBrief; member: FamilyMember } | undefined {
  for (const fam of fams ?? []) {
    const member = fam.members.find((m) => m.ws === ws);
    if (member) return { fam, member };
  }
  return undefined;
}

/** "waits on auth inc 2" (or incs 2, 3), or "" when it waits on nothing. */
export function waitText(fam: FamilyBrief, m: FamilyMember): string {
  if (!m.waits.length) return "";
  return `waits on ${fam.parent} inc${m.waits.length > 1 ? "s" : ""} ${m.waits.join(", ")}`;
}

/** What a member is doing, in a few words. */
export function memberState(fam: FamilyBrief, m: FamilyMember): string {
  if (m.phase === "done") return "done";
  const w = waitText(fam, m);
  if (w) return w;
  if (m.open) return `working inc ${m.n}/${m.total}`;
  if (m.ready) return m.go === "parent" ? `parent goes · inc ${m.n}` : `can go: inc ${m.n}`;
  return m.phase;
}
