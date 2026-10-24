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
  /** who gave its go: human | parent | self, "" before one was given; absent from an older engine */
  by?: string
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
  /** who the plan is to its deep-plan family; absent when it is in none, or from an older engine */
  family?: SeamuxFamily
}

/** A plan's family, as `deep-plan status --json` reports it on each member's row. */
export type SeamuxFamily = {
  /** parent | child */
  role: string
  /** the parent plan's slug */
  parent: string
  /** who gives this plan's go: "parent" for a delegated child, else "human"; absent from an older engine */
  go?: string
  /** the holds the parent wrote, child slug to reason; absent from an older engine */
  holds?: Record<string, string>
  /** every member, the parent first, with its phase and progress */
  members: SeamuxFamilyMember[]
  /** the globs this plan's workstream owns */
  owns: string[]
  /** parent increments this plan's go waits on, and those not done yet */
  after: number[]
  waitingOn: { n: number; title: string; status: string }[]
  /** edits into another member's claims this plan took part in (every one, for the parent) */
  trespasses: { total: number; pairs: { from: string; owner: string; count: number }[] }
  /** news since this plan's session last looked, base-ref commits left out */
  news: number
  /** every member is done */
  done: boolean
}

/** One member of a family, on every member's `family` field. */
export type SeamuxFamilyMember = {
  slug: string
  role: string
  phase: string
  done: number
  total: number
  /** who gives its go: parent | human; absent from an older engine */
  go?: string
  /** the hold the parent wrote on it, "" for none */
  held?: string
  /** each increment's verdicts; absent from an older engine */
  increments?: SeamuxFamilyIncrement[]
}

/** A member increment's verdicts: `checks` folds every check to one word, `review` is the lookout review check's status ("" when it has none), `by` who gave its go. */
export type SeamuxFamilyIncrement = { n: number; title: string; status: string; checks: string; review: string; by: string }

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
