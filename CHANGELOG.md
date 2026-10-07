# Changelog

Notable changes to seamux. Dates are release dates; the repo is the source of
truth. Since 0.3.0 the plugins run from the checkout (a folder marketplace), so
an entry is live after `/reload-plugins`, and crew's after `crew apply`.

## Unreleased

- **Every deep-plan increment is gated on its checks, and the engine runs
  them.** A deliverable's checks (test, e2e, observability, manual) gate
  `done`: it is refused until each has passed against the tree being closed,
  and an edit after a pass makes it stale (a commit of what passed does not).
  Recipes live in `.seamux/verify.json` beside each project — the nearest
  ancestor wins, the root's are inherited unless redefined — and a
  `default: true` recipe whose `match` covers an increment's files becomes a
  check without being written down. `deep-plan check run` runs them: cheap
  ones in the foreground, expensive ones detached (`check status`, `check
  wait`). Remote QA is acquire, wait and run steps: the acquire (a push, a
  preview channel) is always the human's, then `--from wait` polls for the
  variant and tests it. `deep-plan verify init` drafts recipes from the
  scripts, CI steps and configs a repo already has, with templates for Vercel,
  Firebase, RWX and GitHub deployments (all marked unverified until proven
  against a real preview) and a guided setup prompt. The plan pane shows each
  check, with `run checks` and `variant ready`. **Breaking:** re-rendering a
  plan whose increments have no checks is refused until each gets one or a
  written `waiver` (`render --force` is the logged way past); `deep-plan obs`
  keeps working as an alias. ADRs 0006–0009.
- **Plans record who owns them, and `/plan-pane` finds yours wherever it is.**
  deep-plan read the session id from `CLAUDE_SESSION_ID`, which Claude Code
  never sets (it exports `CLAUDE_CODE_SESSION_ID`), so every plan's `session`
  was empty. Every state write made from inside a session now stamps
  `owner {session, workspace, at}` from `CLAUDE_CODE_SESSION_ID` and
  `CMUX_WORKSPACE_ID`, and `status --json` carries `owner` and `touchedAt`.
  The pane no longer needs the cwd inside the plan's root: it shows the
  newest active plan this session or workspace owns, lists the others with
  `switch`, and `/plan-pane <slug>` pins one. Back-to-back plans in one
  workspace resolve to the newest, across `/clear`.
- **`/plan-pane` links back to the plan's page.** A clickable link and an
  `open review` / `open plan` button (`o`) under the increments: the review
  page while the alignment check is pending, the working tracker after it, so
  a graded plan never puts the quiz back in front. `open` runs `cmux open`,
  which lands as a tab in this workspace; without cmux the URL is toasted, and
  without the intent server the link is the page's file.
- **restack re-derives a generated file git merged cleanly.** Only conflicted
  artifacts were regenerated, so two sides adding types in different places
  merged into a schema whose header undercounted them, and `restack check`
  failed after the walk said ok. Every artifact both sides touched is now
  regenerated in each replayed commit that changes it (the expensive tier is
  recorded stale, as for a conflict). Graphite walks are not covered yet.
- **restack says why the guard sent you a generated file.** A path the
  judgment layer escalated was listed under "yours to resolve" with no reason
  outside `--json`; the line now reads e.g. `schema.graphql — 1 hunk (sent to
  you: only 42% likely to be generated; --no-judge skips this check)`.
- **`/plan-pane` finds a plan rooted through a symlink.** It matched the cwd
  against the root as written, so on macOS a plan rooted at `/tmp/x` was not
  found from `/private/tmp/x`, though the gate resolved it. `deep-plan status
  --json` now also reports `realRoot`, and the pane and status entry match
  either.
- **A detached check whose runner died shows as lost, not running.** The pane
  and status entry said `↻ N running` until a `check` verb reaped it.
  `deep-plan status --json` now reports such a check as `lost` (judged on
  read; it still writes nothing), and the pane shows `⚠ lost` with its `run
  checks` button.

## 0.3.0 — 2026-10-04

- **Every feature is a Claude Code plugin, listed by one marketplace.**
  deep-plan, restack, bash-guard and crew each install on their own
  (`claude plugin install deep-plan@seamux`), so restack can be adopted
  without the mac-only crew layer and the skills keep their names. Each plugin
  carries its own hooks in `hooks/hooks.json`; `settings.json` no longer holds
  any of seamux's hook entries. Decision records: `docs/adr/0004` and `0005`.
- **`install.sh` is a bootstrap over `claude plugin`.** It adds the checkout
  as a folder marketplace, so the plugins run from the repo itself and an
  edit plus `/reload-plugins` is live with no version bump (`--github`
  installs the published copy instead). Then each engine's `setup`, then
  `crew apply`. A machine set up by the old installer is migrated: the
  `~/.claude/skills` copies, the old shims and the hook entries move into
  `~/.claude/seamux-migrated/<time>/`, each only once the plugin replacing it
  is installed and enabled, and a failed install stops before any of it.
  `--check` reports the marketplace, each plugin and where it runs from,
  leftovers, and crew drift.
- **Engine pointers.** deep-plan and restack write
  `~/.claude/{deep-plan,restack}/engine.json` at every session start and run.
  The board, the intent server, triage's go chip and the `~/.local/bin`
  shims find the engine through it, since none of them can see the plugin's
  location. `deep-plan setup` and `restack setup` install the shims;
  `deep-plan engine` and `restack engine` say which copy runs.
- **mermaid lives in the data tree.** `deep-plan setup`, or the first render
  that finds none, fetches the pinned build into `~/.claude/deep-plan/vendor`
  and refuses any other bytes. A plugin root is replaced on every update; the
  data tree is not. CI uses the same step.
- **crew installs from its plugin.** `crew apply` copies the plugin root into
  `~/.config/cmux/crew` (the path cmux and launchd need), bakes the main repo,
  and records the source; run from the live tree it re-copies first, so a
  plugin update lands. `crew doctor` compares the two and flags an update not
  yet applied, and every verb but `apply` run from the plugin root goes to the
  live tree.
- **crew's integrations are plugin options.** `jira_site`, `github_issues`,
  `observability_stack` and `main_repo`, set with `/plugin`. `hooks/options.py`
  renders them into `integrations.json` at session start and at `crew apply`,
  writing only on change and leaving the old installer's answers alone until
  an option is set. The status line and the settings merge moved under
  `crew/claude/`; the merge sets only `statusLine` and the push flags.
- **seamux-mods (optional, Claude Code 2.1.287+).** deep-plan inside the
  terminal: `/plan-pane` with go, done and obs buttons; a band with `go next`
  when the gate refuses an edit; the plan and the prompt-cache clock in the
  status line. The gate's refusal now opens with a pinned
  `deep-plan gate [<slug>]: `, which the probe holds.
- **Fixes found on the way.** `restack --help` printed the status. `crew
  uninstall` exited 1 after succeeding when no settings backup existed. A
  folder marketplace's `installPath` names a cache snapshot, not the folder
  Claude reads; `crew/bin/crew-plugin-root` resolves the real one.

- **deep-plan's evidence check reads the answer's distribution, not its
  `confidence`.** The gate was written against Jev; the local model this
  machine now uses reports `confidence` as the margin between its top two
  options, so a citation verdict torn between "contradicts" and
  "says_nothing" arrives under the floor with almost all of its mass against
  the claim — and a verdict splitting that mass evenly (0.35/0.35 against 0.30
  supports) has a margin of zero, a shape no confidence number can express.
  `verdict()` now warns on `1 - p(supports)` and takes its wording from
  whichever alarming option holds more mass; an answer without probabilities
  keeps the old path byte for byte. Measured: on clear-cut citations both
  rules agree, so this removes a latent trap rather than rescuing a broken
  check. Still warn-only, still a real floor — uncertainty does not warn here,
  unlike restack's guard, because the two gate very different things.

- **restack verify — did the rebase change anything of yours?** A rebase
  reports success when every commit applied, not when every commit still
  says what it said. `verify` range-diffs each branch against the tips the
  walk recorded before it moved anything, and buckets every difference:
  regenerated artifacts and files you resolved at a stop are expected,
  everything else is residue worth reading. Two bugs found building it were
  the check lying in the safe direction — `git range-diff` refuses an empty
  range, which is exactly the "every commit was dropped" case, and an
  unreadable range coerced to zero looked like "every commit is new". Both
  are handled, and a branch that could not be checked now exits non-zero:
  an unrunnable safety check is not a pass.
- **An optional judgment layer over the same client crew uses**, which on
  this machine is a local Kev. Three narrow questions — is this file the
  tool is about to rebuild really generated, did a commit that became empty
  claim more than a regeneration, is a leftover patch change benign — under
  one rule enforced in code: **a judgment may escalate, never authorize.**
  No answer can make restack resolve something it would not have resolved.
  The bar is asymmetric on purpose: it asks whether the model is positively
  confident the automatic action is SAFE, not whether it is confident in the
  alarm. Measured reason — Kev reports confidence as the margin between its
  top two options, so a file scored {generated 0.14, handwritten 0.48,
  unclear 0.38} arrived with confidence 0.21 and sailed through the naive
  rule, losing a branch's change and then dropping the commit as empty.
  Content questions are sent only to a loopback endpoint; anything else
  degrades to paths and subjects. No client, no key, a failed call or an
  unreadable answer is silence and today's behaviour. `--no-judge` is
  explicit, `judge.safeFloor` is the knob, and every answer lands in
  `~/.cache/seamux-restack/judgments.log` with its probabilities, because
  these numbers are untuned for this model and deserve to be tuned from real
  runs.

- **restack — a companion skill for landing a stack.** `~/.claude/skills/restack`
  plus a `restack` shim. It walks a stack bottom-first with `git rebase --onto`
  (tips recorded before anything moves, so nothing replays twice), resolves
  every conflict in a *generated* artifact by rebuilding it rather than merging
  it, and stops only for conflicts a human owns — exit code 2, with the files
  and a hunk count each. Artifacts and their generators are declared per repo
  in `.seamux/restack.json` and tiered: cheap generators run inside the walk,
  expensive ones (a container, a migrated database) resolve to the base copy
  and are recorded **stale** with the command that fixes them. `check` runs the
  staleness and breaking-change comparisons CI would run, locally, against a
  freshly fetched base, and both `check` and `push` refuse while anything is
  stale. `push` prints the lines and never runs one. Graphite is detected and
  keeps ownership of its own rebase; without it the chain comes from open PRs
  or from topology, and which source answered is always reported. Two things
  it refuses to do quietly: a commit that becomes empty once its generated
  file is re-derived is reported as dropped, with its subject, and a
  `take-base` resolution records the branch copy it discarded (cleared with
  `restack clear-stale --only <name>`, which is logged). Probe:
  `node restack/probe.mjs` — real repositories in a temp dir, wired into CI.

- **Ask surfaces.** `deep-plan ask <file.json>` renders a question with
  per-option mermaid and examples, served by the intent server at
  `/ask/<id>` in a Dock tab. A pick on the page types the option number
  into the terminal the ask was created in and reads the screen back to
  prove the prompt took it (the number key submits on its own; Enter is
  sent only if the pointer moved without resolving, never blind), and
  otherwise tells you which key to press. The terminal question stays the answer of record; asks
  work with or without a tracked plan. ADR 0003 records the channel.
- **Risk triage.** Every spec risk carries a disposition — accept,
  mitigate (a deliverable here or a filed ticket), spike (a named check),
  promote (a quiz question) — chosen on the review page per card and
  applied through the copy-back blob as `- [risk N] …` lines. `grade`
  refuses while any risk has none, the same way it refuses an uncovered
  contract decision. Plain-string risks in older specs are not
  grandfathered.
- **Optional TypeSafe check for questions at turn end.** A turn that ends on
  a question used to file as finished, because only Notification opened
  "Needs you". With a TypeSafe key present, Stop asks Jev in the background
  whether the last message leaves the agent blocked on you, and if so publishes
  `phase:waiting` with the question as the banner. With no key, disabled in
  `integrations.json`, or on any error, behavior is unchanged. `crew doctor`
  reports the state.
- **One TypeSafe client, under CI.** Config, key resolution and the 429/529
  retry moved from `asked.py` into `crew/hooks/typesafe.py`; question text
  stays with each feature. The client grew an `ask` CLI mode (JSON on
  stdin/stdout) so node callers reuse it. `typesafe_probe.py` runs a local
  mock of `/v1/systemone` in CI — happy path, retry, 4xx/5xx, unreachable,
  no-key and `enabled:false` all asserted, the failure paths as "no
  judgment, old behavior". The doctor's package list also learned about
  `asked.py`/`asked.sh`, which increment 0 forgot to add.
- **Board ranking from turn-end judgments.** The Stop-time TypeSafe request
  grew two questions over the same last message: "did the agent stop on an
  error it couldn't get past" and a 4-level urgency score. `asked.sh` caches
  all three answers per worktree in `~/.cache/cmux-crew/judgments.json`; the
  board reads only the cache (`board/judgments.py`, costs.py-shaped, pure and
  probed). Policy in code: stuck ≥ `typesafe.stuck_threshold` (0.8,
  provisional) files an idle row as wilt/`stuck` — hard signals like red CI
  still outrank it — and urgency orders rows within a tier; tiers never move.
  Mid-turn rows, stale entries (6h TTL), and machines without a key rank
  byte-identically to before. Scores land in `asked.log` for tuning; the
  doctor line now prints both thresholds.
- **deep-plan now checks the citations back.** `verifiedFacts` evidence was
  printed verbatim and verified by nothing — the read-before-plan floor only
  ran the other way. `deep-plan/lib/evidence.mjs` warns at render when a
  cited path is missing or its line is out of range (always on, pure code),
  and with a TypeSafe key asks Jev per fact whether the cited lines support
  the claim — the citation-check pattern; `contradicts`/`says_nothing` warn,
  low confidence is silence. Warn-only by decision: never a refusal, never
  the gate. The probe covers both halves with a scripted client stand-in,
  and a probe render can never reach the real client
  (`DEEP_PLAN_TYPESAFE_CLIENT` is authoritative, empty means none).

## 0.2.0 — 2026-09-15

- **Scrubbed internal identifiers from the tree and from all history.** Five
  names (one product, four repos) rode in with the 0.1.0 seed. `main` was
  rewritten with `git filter-repo` and force-pushed, the `v0.1.0` tag
  re-pointed, and nine stale remote branches deleted; a mirror backup was taken
  and verified first. Every blob hash outside the affected files is unchanged.
- **`tools/scrub_check.py`** refuses internal identifiers in tracked files and
  runs first in CI, before the network. The previous check lived only in the
  export script that built the retired crew-dock bundle, so it never saw this
  repo. Its own patterns hide one character each (`lending[h]ome`) so the file
  is covered by its own check and survives a text rewrite.
- **Machine-local overlay** (`~/.config/cmux/crew-local`, `$CREW_LOCAL`):
  an executable `crew-spec` replaces the stack detector outright, and
  `cmux.json` / `dock.json` / `dock.global.json` fragments deep-merge over the
  package's templates, with `controls` lists merging by `id`. A sibling of the
  crew tree, so it survives `install.sh`'s move-aside and stays invisible to
  `drift_check`. No overlay means byte-identical output as before; a broken
  overlay fails loudly rather than shipping an unmerged config. `crew doctor`
  reports it and hard-fails on the two silent cases.
- **`render` no longer crashes without the vendored mermaid.** It was a bare
  `readFileSync` on a gitignored file, so the probe suite was red on any fresh
  clone with an ENOENT trace out of `node:fs`. It now refuses with the file and
  the fix named.
- **`docs/SYNCING.md`**: per-path ownership, the traps that have actually bitten
  (`--main-repo` must be shell-expanded; a dry run cannot prove the
  substitution; `crew apply` takes no backup once it has run on a machine), and
  what to check before installing over a live tree that has files the repo never
  had.
- Un-staled three claims: `probes.yml`'s "draft, not enabled" header (CI has
  been live and green since the push), `docs/ADOPTION.md`'s matching CI note,
  and `crew/README.md`'s "not tracked in git yet".
- Probes: board 65 → 76, deep-plan 128 → 129. The assertion count is no longer
  written down in prose; three places recorded it and all three disagreed.

- crew-dock bundle retired; its one unique doc preserved as `docs/TIE-INS.md`.
- `crew doctor` runs the repo drift check automatically (`.seamux-source`
  provenance marker) and reports Computer Use setup (warn-only).
- Board go chip fixed end-to-end: notification workspace key mismatch,
  triage fire-chain logging (`~/.cache/cmux-crew/triage.log`), PATH for the
  deep-plan shim, and a shim that resolves node without a version manager.
- deep-plan hardening: loud fail-open on a vanished plan root (BROKEN ROOT in
  status + a hook warning), single-writer state lock, `/dev/null` redirects no
  longer read as writes by the Bash gate heuristic.
- `deep-plan grade` prompts on a TTY when no answers are given — quiz letters
  stay out of shell history.
- `install.sh --uninstall`: crew unwired and moved aside, skill and shim
  removed, settings entries removed; guard_bash.sh and plan state kept.
- Review surface is interactive: answerable quiz, per-increment comments,
  highlight-to-comment (select text to pin a quoted comment), and a "Copy for
  session" paste-back blob.
- Adoption prep: `docs/ADOPTION.md` (portability + security audit), draft CI
  workflow (not yet enabled).

## 0.1.0 — 2026-09-13

- Initial repo, seeded from the live install on this machine: the crew Dock
  layer, the deep-plan skill, the Claude-side pieces (statusline, guards,
  settings merge), `install.sh` with `--check` drift reporting, and both
  probes (board 54, deep-plan 52 at seed time).
