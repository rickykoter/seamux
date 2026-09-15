# Changelog

Notable changes to seamux. Dates are release dates; the repo is the source of
truth and every entry lands on the machine via `./install.sh`.

## Unreleased

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
