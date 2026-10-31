// The shapes of wall.rs's Frame and Tile: the Dock's pane feed (wall:frame).

export type Tile = {
  surface: string;
  workspace: string;
  workspace_title: string;
  label: string;
  cwd: string;
  agent: string | null;
  state: string;
  lines: string[];
  error: string | null;
  /** The workspace's cmux colour, when it has one. */
  color: string | null;
  /** When the pane entered its current state (ms since the epoch). */
  since: number;
  /** What a native pane is running now ("cargo test"). */
  running?: string | null;
  /** A native pane rang the bell since it was last looked at. */
  bell?: boolean;
  /** What a native Claude says the conversation is about, once it has read the first prompt. */
  topic?: string | null;
  /** The workspace's pinned worktree (its root: token), "" without one. */
  root?: string;
  /** The plan this pane owns, by slug (deep-plan's owner pane). */
  owner?: string | null;
  /** The pane's cwd has left the workspace's pinned worktree. */
  outside?: boolean;
};
export type Frame = { tiles: Tile[]; error: string | null };

/** 45s, 4m, 1h 5m, 2d: how long, short. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
