// A worktree's pull requests in the Wake (plan dock-many-prs): crew-sync's
// list (crew-core prs.rs, served by the wake_prs command), grouped as the
// Dock's pills count them. Pure: no DOM, so prs_probe.ts runs it in Node.

export type Check = { name: string; url: string };
export type Counts = { fail: number; run: number; pass: number; gate: number; unseen?: number };
export type Pr = {
  n: number;
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed" | string;
  review?: string;
  conflict?: boolean;
  branch?: string;
  updatedAt?: string;
  checks: Counts | null;
  failing?: Check[];
  gating?: Check[];
  /** The group crew-sync filed it in (crew-core prs.rs `group`): the one
   *  rule the Dock's pills count by. groupOf falls back to its copy. */
  group?: string;
};

/** The Wake's groups, in the order they show. */
export const GROUPS = ["you", "people", "draft", "open", "done"] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_SAID: Record<Group, string> = {
  you: "needs you",
  people: "needs people",
  draft: "draft",
  open: "open",
  done: "done",
};

const n = (c: Counts | null, k: keyof Counts): number => (c && typeof c[k] === "number" ? (c[k] as number) : 0);

/** Where a PR is filed: crew-sync's own word when the file has it, else
 *  the same rule as crew-core's `group`, for a list written before it. */
export function groupOf(pr: Pr): Group {
  if ((GROUPS as readonly string[]).includes(pr.group ?? "")) return pr.group as Group;
  if (pr.state === "merged" || pr.state === "closed") return "done";
  const draft = pr.state === "draft";
  const red = n(pr.checks, "fail") > 0;
  if (!draft && (red || pr.conflict || pr.review === "CHANGES_REQUESTED")) return "you";
  if (draft && red) return "draft";
  if (n(pr.checks, "gate") > 0 || (!draft && pr.review === "REVIEW_REQUIRED")) return "people";
  return draft ? "draft" : "open";
}

/** The PRs by group, each group in the list's order (newest made first). */
export function grouped(prs: Pr[]): Map<Group, Pr[]> {
  const out = new Map<Group, Pr[]>(GROUPS.map((g) => [g, []]));
  for (const p of prs) out.get(groupOf(p))!.push(p);
  return out;
}

/** The done group's fold line: "9 merged · 2 closed". */
export function doneSaid(prs: Pr[]): string {
  const m = prs.filter((p) => p.state === "merged").length;
  const c = prs.filter((p) => p.state === "closed").length;
  return [m ? `${m} merged` : "", c ? `${c} closed` : ""].filter(Boolean).join(" · ");
}

export type Seg = { kind: "fail" | "run" | "pass" | "gate"; cells: number };

/** The mini bar: `width` cells split by bucket, fail first, every non-zero
 *  bucket at least one cell. Empty with no checks. */
export function bar(c: Counts | null, width = 10): Seg[] {
  const order: Seg["kind"][] = ["fail", "run", "pass", "gate"];
  const total = order.reduce((s, k) => s + n(c, k), 0);
  if (!total) return [];
  const want = order.map((k) => ({ kind: k, v: n(c, k) })).filter((x) => x.v > 0);
  const cells = want.map((x) => Math.max(1, Math.floor((x.v / total) * width)));
  // Hand out what rounding left to the biggest remainders, take back any
  // excess from the biggest segment: the bar is always `width` wide.
  let left = width - cells.reduce((s, x) => s + x, 0);
  const rem = want.map((x, i) => ({ i, r: (x.v / total) * width - Math.floor((x.v / total) * width) })).sort((a, b) => b.r - a.r);
  for (let j = 0; left > 0; j = (j + 1) % rem.length, left--) cells[rem[j].i]++;
  while (left < 0) {
    const big = cells.indexOf(Math.max(...cells));
    cells[big]--;
    left++;
  }
  return want.map((x, i) => ({ kind: x.kind, cells: cells[i] })).filter((s) => s.cells > 0);
}

/** The bar's hover: exact counts, and what was not read. */
export function countsSaid(c: Counts | null): string {
  if (!c) return "no checks";
  const bits = [
    c.fail ? `${c.fail} failed` : "",
    c.run ? `${c.run} running` : "",
    c.pass ? `${c.pass} passed` : "",
    c.gate ? `${c.gate} waiting on people` : "",
    c.unseen ? `${c.unseen} more not read` : "",
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : "no checks";
}

/** "5m", "2h", "3d": how long since the PR last changed. */
export function age(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** The PR a Wake row's URL names, by its canonical /pull/N URL. */
export function byUrl(prs: Pr[]): Map<string, Pr> {
  const out = new Map<string, Pr>();
  for (const p of prs) {
    const m = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.exec(p.url);
    if (m) out.set(m[0], p);
  }
  return out;
}

/** A row badge's word for a PR: its state, and red when a check failed. */
export function badgeOf(pr: Pr): { text: string; cls: string } {
  if (pr.state === "merged" || pr.state === "closed") return { text: pr.state, cls: "done" };
  const g = groupOf(pr);
  const cls = n(pr.checks, "fail") > 0 ? "bad" : g === "people" ? "wait" : "ok";
  return { text: pr.state, cls };
}
