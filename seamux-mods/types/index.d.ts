// The state seamux-mods keeps for the session: what its pane, band and status
// entry draw from. A drawing reads these; only the module's handlers and timer
// write them.

/** One increment as `deep-plan status --json` reports it. */
export type SeamuxIncrement = {
  n: number
  title: string
  /** pending | authorized | working | done | blocked */
  status: string
  /** the observability verdict: n/a | pending | pass | fail */
  obs: string
}

/** One plan row of `deep-plan status --json`, the fields this plugin reads. */
export type SeamuxPlan = {
  slug: string
  root: string
  phase: string
  rootBroken: boolean
  gate: { allow: boolean; why: string }
  progress: { total: number; done: number; next?: { n: number; title: string } | null }
  increments?: SeamuxIncrement[]
}

/** What the last refresh found for the session's working directory. */
export type SeamuxView = {
  /** the plan whose root holds the cwd, or null when none does */
  plan: SeamuxPlan | null
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
    }
  }
}
