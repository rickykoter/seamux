# Changelog

Notable changes to seamux. Dates are release dates; the repo is the source of
truth and every entry lands on the machine via `./install.sh`.

## Unreleased

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
