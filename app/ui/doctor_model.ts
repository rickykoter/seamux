// The Doctor tab's model (doctor.ts draws it): crew_core::doctor's scan,
// grouped for the triage list. A pure module, so doctor_probe.ts runs it
// in Node.

/** A fix a finding offers: the verb doctor_fix takes, and its button. */
export type Fix = { verb: string; label: string };

/** One finding, as crew_core::doctor's Finding::to_json writes it. */
export type Finding = {
  id: string;
  kind: string;
  class: "safe" | "confirm" | "report";
  ws: string;
  title: string;
  cwd: string;
  pane: string;
  summary: string;
  detail: string;
  session: string;
  subject: string;
  fixes: Fix[];
};

/** A scan, as Scan::to_json writes it. */
export type Scan = { tmux: "ok" | "gone" | "unreachable"; registry: string; findings: Finding[] };

/** A workspace that needs a person: its worst finding first. */
export type Group = { key: string; title: string; cwd: string; ws: string; findings: Finding[] };

/** What the page draws. */
export type Triage = {
  /** One line when the scan cannot be acted on, else "". */
  blocked: string;
  /** Workspaces with a confirm or report finding, worst first. */
  needs: Group[];
  /** Safe findings, folded to one line. */
  leftovers: Finding[];
};

/** How bad a kind is, within its class: lower is worse. */
const WORST = [
  "registry-unreadable", "missing-worktree", "claude-exited", "lost-pane", "orphan-session",
  "duplicate-workspace", "empty-workspace", "merged-live", "shared-session", "gone-owner", "cache-split",
];
const rank = (f: Finding) => (f.class === "confirm" ? 0 : f.class === "report" ? 100 : 200) + (WORST.indexOf(f.kind) + 1 || 50);

/** A finding's place in the list: confirm before report, and by kind. */
export function worse(a: Finding, b: Finding): number {
  return rank(a) - rank(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/** Group a scan for the page. */
export function triage(scan: Scan): Triage {
  const blocked =
    scan.registry !== "ok"
      ? "The workspace registry cannot be read, so nothing can be fixed from here."
      : scan.tmux === "unreachable"
        ? "tmux could not be asked, so nothing is fixed until it answers."
        : "";
  const groups = new Map<string, Group>();
  const leftovers: Finding[] = [];
  for (const f of [...scan.findings].sort(worse)) {
    if (f.class === "safe" && !blocked) {
      leftovers.push(f);
      continue;
    }
    const key = f.ws || f.id;
    let g = groups.get(key);
    if (!g) {
      g = { key, title: f.title || label(f), cwd: f.cwd, ws: f.ws, findings: [] };
      groups.set(key, g);
    }
    g.findings.push(f);
  }
  const needs = [...groups.values()].sort((a, b) => worse(a.findings[0], b.findings[0]));
  return { blocked, needs, leftovers };
}

/** A name for a finding with no workspace: its subject, short. */
export function label(f: Finding): string {
  const s = f.subject || f.pane || f.id;
  return /^[0-9A-Fa-f-]{36}$/.test(s) ? s.slice(0, 8) : s;
}

/** The ids Fix all safe runs: every safe finding with a fix, none while
 *  the scan is blocked. */
export function safeIds(scan: Scan): string[] {
  if (triage(scan).blocked) return [];
  return scan.findings.filter((f) => f.class === "safe" && f.fixes.length > 0).map((f) => f.id);
}

/** Whether a fix acts at once or asks first: only a safe finding's fix
 *  skips the confirm step. Reclaim opens its own wizard. */
export function asks(f: Finding, fix: Fix): "now" | "confirm" | "wizard" {
  if (fix.verb === "reclaim") return "wizard";
  return f.class === "safe" ? "now" : "confirm";
}

/** The Leftovers line: "12 leftovers: 10 lost panes, 2 stale files". */
export function leftoversSaid(fs: Finding[]): string {
  if (fs.length === 0) return "";
  const kinds: Record<string, [string, string]> = {
    "dead-gone": ["lost pane that can never restart", "lost panes that can never restart"],
    "stuck-working": ["pane stuck on working", "panes stuck on working"],
    "dead-pane": ["ended pane", "ended panes"],
    "orphan-pane-file": ["stale pane file", "stale pane files"],
    "orphan-held": ["stale held command", "stale held commands"],
    "registry-tmp": ["half-written registry copy", "half-written registry copies"],
  };
  const counts = new Map<string, number>();
  for (const f of fs) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${(kinds[k] ?? [k, k])[n === 1 ? 0 : 1]}`);
  return `${fs.length} leftover${fs.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/** The header's summary: "4 workspaces need you" or the calm line. */
export function headline(t: Triage): string {
  if (t.blocked) return t.blocked;
  if (t.needs.length === 0 && t.leftovers.length === 0) return "Every workspace looks healthy.";
  if (t.needs.length === 0) return "Nothing needs you; only leftovers to clean.";
  return `${t.needs.length} workspace${t.needs.length === 1 ? " needs" : "s need"} you`;
}

// --- All workspaces: crew-resume's rows (crew_cli::resume::app_rows).

export type RowState = "live" | "archived" | "past" | "gone";
export const STATES: RowState[] = ["live", "archived", "past", "gone"];

/** One workspace directory, as app_rows writes it. */
export type Row = {
  cwd: string;
  state: RowState;
  title: string;
  latest: string;
  branch: string;
  /** Seconds since the epoch, or 0. */
  when: number;
  exists: boolean;
  ws: string;
  sessions: string[];
  transcript: string;
};

/** What each state's rows offer, in the order of their buttons. */
export const ACTIONS: Record<RowState, { verb: "archive" | "restore" | "forget" | "resume"; label: string; confirm: boolean }[]> = {
  live: [{ verb: "archive", label: "Archive", confirm: true }],
  archived: [
    { verb: "restore", label: "Restore", confirm: false },
    { verb: "forget", label: "Forget", confirm: true },
  ],
  past: [{ verb: "resume", label: "Resume", confirm: false }],
  gone: [],
};

/** How many rows are in each state. */
export function counts(rows: Row[]): Record<RowState, number> {
  const c: Record<RowState, number> = { live: 0, archived: 0, past: 0, gone: 0 };
  for (const r of rows) c[r.state]++;
  return c;
}

/** The rows in `state` ("all" for every one) that match every word of
 *  `query` in their title, folder, branch or latest prompt; newest first. */
export function filterRows(rows: Row[], state: RowState | "all", query: string): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((r) => state === "all" || r.state === state)
    .filter((r) => {
      const hay = `${r.title} ${r.cwd} ${r.branch} ${r.latest}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => b.when - a.when || a.cwd.localeCompare(b.cwd));
}

/** How long ago, as crew-resume says it: 5m, 3h, 2d, then a date. */
export function ago(when: number, now: number): string {
  if (!when) return "";
  const d = Math.max(0, now - when);
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 14) return `${Math.floor(d / 86400)}d`;
  const t = new Date(when * 1000);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getMonth()]} ${t.getDate()}`;
}
