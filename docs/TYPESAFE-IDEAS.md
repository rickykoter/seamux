# TypeSafe candidates, ranked

The exploration increment of plan `typesafe-crew-judgments` (2026-09-16).
Each candidate was checked against the code it would ride on, not assumed.
Patterns referenced are the skill's: route, select-not-generate, find-and-judge
evidence, reusable scores, verify-and-escalate.

## Kept

### 1. Evidence citation check (new — becomes an increment)

Every `verifiedFacts` entry carries `path:line` evidence, and today nothing
ever looks at it: `validate()` checks shape only (`deep_plan.mjs:85-87`), the
one filesystem-aware pass runs the *inverse* direction — planned files must be
cited (`deep_plan.mjs:1050-1080`) — and every render path prints evidence
verbatim. A fact citing a deleted file, a drifted line, or content that says
the opposite passes silently, and the whole plan's credibility rests on it.

This is the citation-check cookbook almost verbatim: code resolves the cited
lines (existence and line-range checks are deterministic and stay in code);
TypeSafe answers one Choice per fact — does the cited text `support`,
`contradict`, or `say_nothing` about the claim. Warn-only at render time, in
the same breath as the unread-files refusals, so a bad citation is visible the
moment the plan is on the table. Fits find-and-judge-evidence exactly; sends
one claim plus ~40 cited lines per fact.

### 2. Board ranking (already increment 3 — confirmed, not displaced)

Nothing found outranks it: it reuses the increment-0 flow end to end, and the
stuck/urgency judgments are the only candidates that act on the board's core
question, "who needs me first".

## Dropped

- **deep-plan alignment warnings** (was increment 4). The inputs assumed by
  the brief mostly don't persist: pinned review comments are DOM-only and
  "nothing is stored or sent anywhere" (`deep_plan.mjs:730-732, 806-841`), the
  amend blob is a transient paste (`deep_plan.mjs:1006-1013`), and annotations
  exist only for plans shared as artifacts. What remains — re-judging graded
  quiz answers — second-guesses a check that already passed deterministically.
  Thin evidence, judgment aimed at the human. The citation check keeps the
  same goal (catch a plan that's wrong) but aims it at the agent's claims.
- **Usage anomalies** (was increment 5). The `/usage` payload has exactly two
  dollar numbers per worktree (`crew-board-intent:993-1002`) — no progress,
  tokens, or history to judge "is this progress real" against without new
  plumbing. And increment 3's `stuck` judgment already covers the interesting
  case (spend without progress reads as an agent looping on an error).
  Revisit once judgments.json has accumulated real data to join dollars to.
- **Issue matching.** The premise ("pick from candidates code already found")
  is absent: crew-sync keeps `closingIssuesReferences[0]` or a conservative
  branch regex (`crew-sync:382-385, 620-624`) — there is no candidate search
  to rerank. Building one is a new feature, not a judgment on an existing one.
- **Reclaim second opinion.** `crew-reclaim` already evaluates seven
  deterministic guards and reports them all (`crew-reclaim:291-352`); the
  residual semantic risk (unfinished intent in a clean tree) is real but a
  caution-only nag with no threshold data yet would train dismissal — the
  wrong first impression for a destructive-path feature.
- **Digest ranking.** `crew-digest` is already sectioned by kind and read once
  a morning; reordering within sections is polish. Cheapest to add later if
  judgments.json scores prove trustworthy — the reusable-scores pattern means
  the digest could then rank on cached numbers with no new network call.

## The rule the ranking followed

A judgment earned its place only when (1) the evidence it needs already exists
on disk, (2) code keeps the policy and the failure mode is "exactly today's
behavior", and (3) it judges the agent's output, not the human's decisions.
