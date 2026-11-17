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
