// Session search: every open session and every tucked or muted worktree, as
// rows the palette lists, and how a query ranks them. Pure: no DOM, no Tauri,
// so search_probe.ts runs it under Node (ADR: search ranks by match, then
// cached Jev priority, never calling Jev).
//
// The order: tucked and muted rows always sit below live ones. Within each,
// the match score decides, in bands TIE wide counted down from the best
// score; within a band, the higher priority (the turn-end judgment's, from
// views:frame) first, then whichever waits on you, then the most recent.
// With no query the same order holds without a score.

/** The parts of a wall tile search reads (tiles.ts Tile). */
export type TileIn = {
  surface: string;
  workspace: string;
  workspace_title: string;
  label: string;
  cwd: string;
  agent: string | null;
  state: string;
  since: number;
  lines: string[];
  topic?: string | null;
  root?: string;
  owner?: string | null;
};

/** The parts of a tucked row search reads (tuck.ts TuckRow). */
export type TuckIn = { path: string; name: string; branch: string; level: string; waiting: boolean; last: number; workspaces: string[] };

export type Inputs = {
  tiles: TileIn[];
  /** Each live workspace's plan (views:frame plans). */
  plans: { ws: string; slug: string }[];
  /** Open questions and asked turns, with their text (views:frame decisions). */
  asks: { ws: string; text: string }[];
  tucked: TuckIn[];
  /** Workspace id -> 0..1 (views:frame priority). */
  priority: Record<string, number>;
  /** Workspace id -> branch (views:frame branches). */
  branches: Record<string, string>;
};

export type Field = "name" | "branch" | "topic" | "plan" | "ask" | "path";
export const FIELDS: Field[] = ["name", "branch", "topic", "plan", "ask", "path"];
/** How much a match in each field counts: what you call a session first. */
const WEIGHT: Record<Field, number> = { name: 1, branch: 0.9, topic: 0.8, plan: 0.8, ask: 0.6, path: 0.5 };
/** How wide a band of scores is, as a fraction of the best: one band is a tie for priority to break. */
export const TIE = 0.15;

export type Row = {
  /** "ws:<id>" for a live session, "tuck:<path>" for a tucked one. */
  key: string;
  /** The live workspace to jump to; "" for a tucked worktree with none. */
  ws: string;
  /** The pane to show: the agent that waits, else works, else any. */
  pane: string;
  /** "" live, "tuck" or "mute". */
  level: string;
  name: string;
  branch: string;
  topic: string;
  plan: string;
  ask: string;
  path: string;
  /** needs_input, working, idle, ended or shell. */
  state: string;
  since: number;
  priority: number;
  lines: string[];
  /** The tucked worktree's path, for bringing it back; "" when live. */
  tuckPath: string;
};

const STATE_RANK: Record<string, number> = { needs_input: 0, working: 1, idle: 2, ended: 3, shell: 4 };
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

/** One row per live workspace (its agent panes folded in) and per tucked or
 *  muted worktree. A worktree that is tucked but still open is one row, the
 *  tucked one, carrying its workspace so Enter still jumps. */
export function rowsOf(i: Inputs): Row[] {
  const tuckedWs = new Map<string, TuckIn>();
  for (const t of i.tucked) for (const w of t.workspaces) tuckedWs.set(w, t);
  const byWs = new Map<string, TileIn[]>();
  for (const t of i.tiles) if (t.workspace) byWs.set(t.workspace, [...(byWs.get(t.workspace) ?? []), t]);
  const askOf = (ws: string) => i.asks.filter((a) => a.ws === ws).map((a) => a.text).join(" · ");
  const planOf = (ws: string) => i.plans.find((p) => p.ws === ws)?.slug ?? "";
  const rows: Row[] = [];
  for (const [ws, tiles] of byWs) {
    if (tuckedWs.has(ws)) continue;
    const agents = tiles.filter((t) => t.agent);
    const lead = [...(agents.length ? agents : tiles)].sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) || b.since - a.since)[0];
    const where = lead.root || lead.cwd;
    rows.push({
      key: `ws:${ws}`, ws, pane: lead.surface, level: "",
      name: tiles.find((t) => t.workspace_title)?.workspace_title || base(where), branch: i.branches[ws] ?? "",
      topic: agents.map((t) => t.topic).filter(Boolean).join(" · "), plan: planOf(ws) || (lead.owner ?? ""),
      ask: askOf(ws), path: where, state: lead.agent ? lead.state : "shell",
      since: Math.max(...tiles.map((t) => t.since)), priority: i.priority[ws] ?? 0, lines: lead.lines, tuckPath: "",
    });
  }
  for (const t of i.tucked) {
    const ws = t.workspaces.find((w) => byWs.has(w)) ?? "";
    const tiles = ws ? byWs.get(ws)! : [];
    const lead = tiles.find((x) => x.agent) ?? tiles[0];
    rows.push({
      key: `tuck:${t.path}`, ws, pane: lead?.surface ?? "", level: t.level,
      name: t.name, branch: t.branch, topic: tiles.map((x) => x.topic).filter(Boolean).join(" · "),
      plan: ws ? planOf(ws) : "", ask: ws ? askOf(ws) : "", path: t.path,
      state: t.waiting ? "needs_input" : lead?.agent ? lead.state : "idle",
      since: t.last, priority: ws ? i.priority[ws] ?? 0 : 0, lines: lead?.lines ?? [], tuckPath: t.path,
    });
  }
  return rows;
}

/** Where a match lands in `text`, and how good it is. A run of the query in
 *  the text beats the same letters spread out; a run or letter at a word's
 *  start (after a space, / - _ . or a lower-to-upper case change) counts
 *  extra. null when the letters are not all there, in order. */
export function fuzzy(q: string, text: string): { score: number; at: number[] } | null {
  if (!q) return { score: 0, at: [] };
  // Lower case one UTF-16 unit at a time, so every index here is an index
  // into `text` as the page walks it (a unit whose lower case is longer, as
  // "İ" is, stays as it is).
  const low = (s: string) => s.split("").map((c) => (c.toLowerCase().length === 1 ? c.toLowerCase() : c)).join("");
  const t = low(text);
  const n = low(q);
  const start = (k: number) => k === 0 || /[\s/\-_.:·]/.test(text[k - 1]) || (/[a-z]/.test(text[k - 1]) && /[A-Z]/.test(text[k]));
  const run = t.indexOf(n);
  if (run >= 0) {
    // The earliest run at a word start, if there is one.
    let k = run, best = -1;
    while (k >= 0) { if (start(k)) { best = k; break; } k = t.indexOf(n, k + 1); }
    const at = best >= 0 ? best : run;
    return { score: n.length * 3 + (best >= 0 ? 4 : 0) + (at === 0 ? 2 : 0), at: [...Array(n.length).keys()].map((x) => x + at) };
  }
  // Letters in order, each taken at a word start where one is still ahead;
  // when that leaves later letters nowhere to go, the plain leftmost walk.
  const walk = (prefer: boolean): { score: number; at: number[] } | null => {
    const at: number[] = [];
    let score = 0, from = 0;
    for (const c of n) {
      let k = t.indexOf(c, from);
      if (k < 0) return null;
      if (prefer) for (let j = k; j >= 0; j = t.indexOf(c, j + 1)) if (start(j)) { k = j; break; }
      score += 1 + (start(k) ? 2 : 0) + (at.length && k === at[at.length - 1] + 1 ? 1.5 : 0) - Math.min(1, (k - from) * 0.05);
      at.push(k);
      from = k + 1;
    }
    return { score, at };
  };
  return walk(true) ?? walk(false);
}

export type Hit = { row: Row; score: number; marks: Partial<Record<Field, number[]>> };

/** The rows matching every word of `q` in some field, ranked (see the top
 *  of this file); with an empty `q`, every row. `marks` are the matched
 *  letters per field, for the page to underline. */
export function search(rows: Row[], q: string): Hit[] {
  const words = q.trim().split(/\s+/).filter(Boolean);
  const hits: Hit[] = [];
  for (const row of rows) {
    let total = 0;
    const marks: Partial<Record<Field, number[]>> = {};
    let ok = true;
    for (const w of words) {
      let best: { f: Field; s: number; at: number[] } | null = null;
      for (const f of FIELDS) {
        const m = fuzzy(w, row[f]);
        if (m && (!best || m.score * WEIGHT[f] > best.s)) best = { f, s: m.score * WEIGHT[f], at: m.at };
      }
      if (!best) { ok = false; break; }
      total += best.s;
      marks[best.f] = [...new Set([...(marks[best.f] ?? []), ...best.at])].sort((a, b) => a - b);
    }
    if (ok) hits.push({ row, score: total, marks });
  }
  // Scores fall into bands TIE wide, counted down from the best one: a band
  // is a tie that priority then breaks. Bands keep the order well defined,
  // where "within TIE of each other" would not be transitive.
  // Each group's bands count down from its own best: a strong tucked match
  // must not widen the ties among live rows.
  const group = (h: Hit) => (h.row.level ? 1 : 0);
  const tops = [0, 1].map((g) => Math.max(0, ...hits.filter((h) => group(h) === g).map((h) => h.score)));
  const band = (h: Hit) => { const top = tops[group(h)]; return top > 0 ? Math.floor((top - h.score) / (TIE * top)) : 0; };
  const key = new Map(hits.map((h) => [h, [h.row.level ? 1 : 0, band(h), -h.row.priority, h.row.state === "needs_input" ? 0 : 1, -h.row.since]]));
  return hits.sort((a, b) => {
    const ka = key.get(a)!, kb = key.get(b)!;
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}
