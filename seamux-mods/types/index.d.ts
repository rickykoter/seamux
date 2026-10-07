// The state seamux-mods keeps for the session: what its pane, band and status
// entry draw from. A drawing reads these; only the module's handlers and timer
// write them.

/** One check on an increment, as `deep-plan status --json` reports it. */
export type SeamuxCheck = {
  id: string
  /** test | e2e | observability | manual */
  kind: string
  name: string
  /** pending | running | needs-variant | pass | fail, or lost: running, but its runner died (judged on read) */
  status: string
  /** what was seen; for needs-variant, what a person runs; for running, since when */
  note: string
  at: number
  /** the recipe key, when deep-plan can run the check itself */
  recipe?: string
}

/** One increment as `deep-plan status --json` reports it. */
export type SeamuxIncrement = {
  n: number
  title: string
  /** pending | authorized | working | done | blocked */
  status: string
  /** the checks folded to one word: n/a | pending | pass | fail */
  obs: string
  /** each check with its verdict; absent from an engine older than checks */
  checks?: SeamuxCheck[]
}

/** One plan row of `deep-plan status --json`, the fields this plugin reads. */
export type SeamuxPlan = {
  slug: string
  root: string
  /** root with symlinks resolved; absent from an older engine */
  realRoot?: string
  phase: string
  rootBroken: boolean
  gate: { allow: boolean; why: string }
  progress: { total: number; done: number; next?: { n: number; title: string } | null }
  increments?: SeamuxIncrement[]
  /** who last touched the plan from inside a session; null before owners were stamped */
  owner?: SeamuxOwner | null
  /** owner.at, else the state file's mtime (ms); absent from an older engine */
  touchedAt?: number
}

/** The session and cmux workspace that last wrote a plan, and when (ms). */
export type SeamuxOwner = { session: string; workspace: string; at: number }

/** What the last refresh found for this session. */
export type SeamuxView = {
  /**
   * the pinned plan, else the session's latest: among plans this session or
   * workspace owns and plans whose root holds the cwd, active before done,
   * then the most recently touched, then the deepest root. Null when none.
   */
  plan: SeamuxPlan | null
  /** the other candidates, in the same order, for the pane's switch list */
  others: SeamuxPlan[]
  /** why there is no plan to show: no engine, a failed run; empty otherwise */
  problem: string
  /** the session's working directory at that refresh */
  cwd: string
}

/** The classic gate's last refusal in this session, until it is acted on. */
export type SeamuxDenial = { slug: string; why: string }

declare module 'claude-code' {
  interface PluginState {
    'seamux-mods': {
      view: SeamuxView | null
      denied: SeamuxDenial | null
      /** the last button's outcome, shown at the foot of the pane */
      note: string
      /** the slug `/plan-pane <slug>` or a switch button pinned; empty means automatic */
      pinned: string
    }
  }
}
