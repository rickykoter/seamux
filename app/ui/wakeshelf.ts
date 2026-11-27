// The Wake's shelves and turn cards, as one model both layouts draw from:
// which shelf each row, pull request, review and ask lands on, what needs the
// person, the reading order the keys walk, and each turn's name. A pure
// module (no imports), so `node app/ui/wakeshelf_probe.ts` runs it as is.

/** A Wake row, the fields this module reads (wake.ts's Row has them all). */
export type ShelfRow = {
  id: number;
  kind: string;
  title: string;
  path: string;
  url: string;
  sha: string;
  created_at: string;
  session_id: string;
  prompt: string;
  locator: string;
  state: "ok" | "risk" | "kept" | "gone";
};

export type ShelfChecks = { fail: number; run: number; pass: number; gate: number } | null;
/** A pull request with the group the Wake filed it in (prs.ts groupOf) and
 *  its landing when it merged (release.ts readLandings). */
export type ShelfPr = {
  n: number;
  url: string;
  title: string;
  state: string;
  group: string;
  review?: string;
  conflict?: boolean;
  checks: ShelfChecks;
  updatedAt?: string;
  merge?: { sha: string; at: string };
  landing?: { overall: { status: string; stage: string; recipe: string; live: boolean } } | null;
};

/** A review as `lookout list --json --root` reports it (lookout/lib/summary.mjs). */
export type ReviewSum = {
  id: string;
  title: string;
  plan: string;
  inc: number | "all" | null;
  updatedAt: string | null;
  reviewer: string;
  stage: "finding" | "claims" | "round" | "ask" | "fix" | "close" | "past";
  gate: { code: number; why: string };
  counts: { blocker: number; major: number; minor: number; nit: number };
  unaddressed: number;
  addressed: number;
  round: { sealed: number; pending: number; max: number; n: number };
  claims: { unchecked: number; broken: number };
  needsPerson: boolean;
  closeIds: string[];
  past: boolean;
  closedAt: string | null;
};

/** An ask page from the views feed (views.rs NowPage, kind "ask"). */
export type AskPage = { path: string; label: string; waiting: boolean; since: number; root?: string };

/** A plan row from `deep-plan status --json` (wake_plans). */
export type PlanRow = {
  slug: string;
  title?: string;
  increments?: { n: number; title: string; status: string; authorizedAt?: number; doneAt?: number }[];
};

/** `R` is the caller's own row type: the rows come back as given. */
export type Input<R extends ShelfRow = ShelfRow> = {
  /** The worktree shown. */
  ws: string;
  /** Newest first, as wake_data returns them. */
  rows: R[];
  prs: ShelfPr[];
  reviews: ReviewSum[];
  asks: AskPage[];
  plans: PlanRow[];
};

export type Need =
  | { key: string; kind: "ask"; title: string; path: string; since: number }
  | { key: string; kind: "landing"; title: string; n: number; stage: string; recipe: string }
  | { key: string; kind: "pr"; title: string; n: number; why: string }
  | { key: string; kind: "review"; title: string; id: string; findings: number; why: string }
  | { key: string; kind: "risk"; title: string; rows: ShelfRow[] };

export type LaneState = "done" | "now" | "needs" | "failed" | "none";
export type Lane = {
  key: string;
  pr: ShelfPr;
  /** review, checks, merged, landed */
  states: [LaneState, LaneState, LaneState, LaneState];
  /** Shown only after "older": landed or closed, past the newest one. */
  fold: boolean;
};

/** The shelves, in the order they show. Empty ones are left for the page to hide. */
export const SHELVES = ["needs", "reviews", "plans", "prs", "pictures", "files", "commits"] as const;
export type ShelfId = (typeof SHELVES)[number];
export const SHELF_SAID: Record<ShelfId, string> = {
  needs: "Needs you",
  reviews: "Reviews",
  plans: "Plans and asks",
  prs: "Pull requests and landings",
  pictures: "Pictures and recordings",
  files: "Files",
  commits: "Commits",
};

/** Which shelf a row's kind lands on. Pull request and review rows are drawn
 *  from their own sources (the lanes and lookout's reviews) on the shelves,
 *  and as rows only inside turn cards. */
export function shelfOf(kind: string): ShelfId {
  if (kind === "image" || kind === "video") return "pictures";
  if (kind === "commit" || kind === "turn") return "commits";
  if (kind === "plan" || kind === "ask" || kind === "issue") return "plans";
  if (kind === "review") return "reviews";
  if (kind === "pr") return "prs";
  return "files";
}

export type Shelves<R extends ShelfRow = ShelfRow> = {
  needs: Need[];
  reviews: { live: ReviewSum[]; past: ReviewSum[] };
  plans: R[];
  lanes: Lane[];
  pictures: R[];
  files: R[];
  commits: R[];
  /** Every item's key in the order j and k walk it. */
  order: string[];
};

const under = (path: string | undefined, root: string): boolean => {
  if (!path || !root) return false;
  const p = path.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return p === r || p.startsWith(r + "/");
};

export const rowKey = (r: ShelfRow) => `row:${r.id}`;
export const prKey = (p: ShelfPr) => `pr:${p.n}`;
export const reviewKey = (r: ReviewSum) => `review:${r.id}`;

/** Why a pull request in the "you" group needs the person. */
function prWhy(p: ShelfPr): string {
  if (p.checks && p.checks.fail > 0) return `${p.checks.fail} check${p.checks.fail === 1 ? "" : "s"} failing`;
  if (p.conflict) return "a merge conflict";
  if (p.review === "CHANGES_REQUESTED") return "changes requested";
  return "needs you";
}

export function needsOf<R extends ShelfRow>(inp: Input<R>): Need[] {
  const out: Need[] = [];
  for (const a of inp.asks) {
    if (a.waiting && under(a.root, inp.ws)) out.push({ key: `ask:${a.path}`, kind: "ask", title: a.label || "ask", path: a.path, since: a.since });
  }
  for (const p of inp.prs) {
    const o = p.landing?.overall;
    if (p.state === "merged" && o?.status === "awaiting")
      out.push({ key: `land:${p.n}`, kind: "landing", title: `#${p.n} landing: approve ${o.stage || "its next stage"}`, n: p.n, stage: o.stage, recipe: o.recipe });
  }
  for (const p of inp.prs) {
    if (p.group === "you" && p.state !== "merged" && p.state !== "closed")
      out.push({ key: `needpr:${p.n}`, kind: "pr", title: `#${p.n} ${p.title}`, n: p.n, why: prWhy(p) });
  }
  for (const r of inp.reviews) {
    // Two ways a review waits on the person: findings only they may close,
    // or fixes waiting after the re-review rounds are used up (their call).
    if (r.needsPerson)
      out.push({ key: `needreview:${r.id}`, kind: "review", title: r.title, id: r.id,
        findings: r.stage === "ask" ? r.addressed : r.closeIds.length, why: r.stage === "ask" ? "rounds used up: your call" : "close its finding" });
  }
  const risk = inp.rows.filter((r) => r.state === "risk");
  if (risk.length)
    out.push({ key: "risk", kind: "risk", title: `${risk.length} file${risk.length === 1 ? "" : "s"} will be lost`, rows: risk });
  return out;
}

/** A pull request's four lane cells: review, checks, merged, landed. */
export function laneStates(p: ShelfPr): Lane["states"] {
  const c = p.checks;
  const review: LaneState = p.review === "APPROVED" ? "done" : p.review === "CHANGES_REQUESTED" ? "failed"
    : p.review === "REVIEW_REQUIRED" ? "now" : p.state === "merged" ? "done" : "none";
  const checks: LaneState = !c ? "none" : c.fail > 0 ? "failed" : c.run > 0 ? "now" : c.pass > 0 || c.gate > 0 ? "done" : "none";
  const merged: LaneState = p.state === "merged" ? "done" : "none";
  const o = p.landing?.overall;
  const landed: LaneState = p.state !== "merged" || !o ? "none"
    : o.status === "done" ? "done" : o.status === "awaiting" ? "needs" : o.status === "landing" ? "now"
    : o.status === "failed" || o.status === "stopped" ? "failed" : "none";
  return [review, checks, merged, landed];
}

/** Lane order: what needs the person first, then landings under way, then
 *  what waits on others, then open and draft, then the finished ones. */
function laneRank(p: ShelfPr): number {
  const o = p.landing?.overall?.status;
  if (p.state === "merged" && o === "awaiting") return 1;
  if (p.group === "you" && p.state !== "merged" && p.state !== "closed") return 0;
  if (p.state === "merged" && (o === "landing" || o === "failed" || o === "stopped")) return 2;
  if (p.group === "people") return 3;
  if (p.state === "open") return 4;
  if (p.state === "draft") return 5;
  return 6;
}

export function lanesOf(prs: ShelfPr[]): Lane[] {
  const sorted = prs.map((p, i) => ({ p, i })).sort((a, b) => laneRank(a.p) - laneRank(b.p) || a.i - b.i);
  let shownDone = 0;
  return sorted.map(({ p }) => {
    const finished = laneRank(p) === 6;
    const fold = finished && shownDone++ >= 1;
    return { key: prKey(p), pr: p, states: laneStates(p), fold };
  });
}

/** Files at risk first, then newest first. */
function filesOf<R extends ShelfRow>(rows: R[]): R[] {
  const f = rows.filter((r) => shelfOf(r.kind) === "files");
  return [...f.filter((r) => r.state === "risk"), ...f.filter((r) => r.state !== "risk")];
}

export function shelves<R extends ShelfRow>(inp: Input<R>): Shelves<R> {
  const needs = needsOf(inp);
  const live = inp.reviews.filter((r) => !r.past);
  const past = inp.reviews.filter((r) => r.past).sort((a, b) => (b.closedAt || "").localeCompare(a.closedAt || ""));
  const plans = inp.rows.filter((r) => shelfOf(r.kind) === "plans");
  const lanes = lanesOf(inp.prs);
  const pictures = inp.rows.filter((r) => shelfOf(r.kind) === "pictures");
  const files = filesOf(inp.rows);
  const commits = inp.rows.filter((r) => shelfOf(r.kind) === "commits");
  const order = [
    ...needs.map((n) => n.key),
    ...live.map(reviewKey),
    ...past.map(reviewKey),
    ...plans.map(rowKey),
    ...lanes.filter((l) => !l.fold).map((l) => l.key),
    ...pictures.map(rowKey),
    ...files.map(rowKey),
    ...commits.map(rowKey),
  ];
  return { needs, reviews: { live, past }, plans, lanes, pictures, files, commits, order };
}

// ------------------------------------------------------------ turns

export type Section<R extends ShelfRow = ShelfRow> = { shelf: Exclude<ShelfId, "needs">; rows: R[] };
export type Turn<R extends ShelfRow = ShelfRow> = {
  key: string;
  prompt: string;
  /** "Increment 2 of <plan title>" when the turn falls in an increment's window. */
  name: string | null;
  session: string;
  /** ms */
  start: number;
  end: number;
  /** Local day, YYYY-MM-DD. */
  day: string;
  /** Non-empty sections, in the shelves' order. */
  sections: Section<R>[];
};

const t = (iso: string) => {
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : 0;
};
const pad = (n: number) => (n < 10 ? "0" : "") + n;
export const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The increment whose go window [authorizedAt, doneAt] holds `at`; when two
 *  plans' windows overlap, the one whose go came last. */
export function incrementAt(plans: PlanRow[], at: number): string | null {
  let best: { at: number; name: string } | null = null;
  for (const p of plans) {
    for (const i of p.increments || []) {
      const from = i.authorizedAt || 0;
      if (!from || at < from) continue;
      if (i.doneAt && at > i.doneAt) continue;
      if (!best || from > best.at) best = { at: from, name: `Increment ${i.n} of ${p.title || p.slug}` };
    }
  }
  return best ? best.name : null;
}

const SECTION_ORDER: Section["shelf"][] = ["reviews", "plans", "prs", "pictures", "files", "commits"];

/** One card per turn: a run of rows with the same session and prompt on the
 *  same day (the same prompt later in the day is a new card). Newest first. */
export function turns<R extends ShelfRow>(inp: Input<R>): Turn<R>[] {
  const out: Turn<R>[] = [];
  let cur: { t: Turn<R>; rows: R[] } | null = null;
  const keyOf = (r: R) => `${dayOf(t(r.created_at))}|${r.session_id}|${r.prompt}|${r.prompt ? "" : r.kind}`;
  let last = "";
  const close = () => {
    if (!cur) return;
    const rows = cur.rows;
    cur.t.sections = SECTION_ORDER.map((shelf) => ({
      shelf,
      rows: shelf === "files" ? filesOf(rows) : rows.filter((r) => shelfOf(r.kind) === shelf),
    })).filter((s) => s.rows.length);
    cur.t.name = incrementAt(inp.plans, cur.t.start);
    out.push(cur.t);
    cur = null;
  };
  for (const r of inp.rows) {
    const k = keyOf(r);
    const at = t(r.created_at);
    if (!cur || k !== last) {
      close();
      cur = { t: { key: `turn:${r.id}`, prompt: r.prompt, name: null, session: r.session_id, start: at, end: at, day: dayOf(at), sections: [] }, rows: [] };
      last = k;
    }
    cur.rows.push(r);
    cur.t.start = Math.min(cur.t.start, at);
    cur.t.end = Math.max(cur.t.end, at);
  }
  close();
  return out;
}

/** Timeline's reading order: Needs you, then each card's sections in order. */
export function timelineOrder<R extends ShelfRow>(needs: Need[], cards: Turn<R>[]): string[] {
  return [...needs.map((n) => n.key), ...cards.flatMap((c) => c.sections.flatMap((s) => s.rows.map(rowKey)))];
}

/** The key after (`by` 1) or before (-1) `key` in `order`; the first one
 *  when nothing is selected, and `key` itself at either end. */
export function stepKey(order: string[], key: string | null, by: 1 | -1): string | null {
  if (!order.length) return null;
  const i = key === null ? -1 : order.indexOf(key);
  if (i < 0) return by > 0 ? order[0] : order[order.length - 1];
  const j = i + by;
  return j < 0 || j >= order.length ? key : order[j];
}

/** A review's one-line stage, as its row on the Reviews shelf says it. */
export function stageSaid(r: ReviewSum): string {
  switch (r.stage) {
    case "finding": return r.reviewer === "panel" ? "panel · finding" : "finding";
    case "claims": return `${r.claims.unchecked} claim${r.claims.unchecked === 1 ? "" : "s"} unchecked`;
    case "round": return `round ${r.round.n} of ${r.round.max}`;
    case "ask": return `${r.round.sealed} rounds done: your call`;
    case "fix": return "fixing";
    case "close": return r.needsPerson ? "you close it" : "closing";
    default: return "past";
  }
}
