# Changelog

Notable changes to seamux. Dates are release dates; the repo is the source of
truth and every entry lands on the machine via `./install.sh`.

## Unreleased

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
- Review surface is interactive: answerable quiz, per-increment comments, and
  a "Copy for session" paste-back blob.
- Adoption prep: `docs/ADOPTION.md` (portability + security audit), draft CI
  workflow (not yet enabled).

## 0.1.0 — 2026-09-13

- Initial repo, seeded from the live install on this machine: the crew Dock
  layer, the deep-plan skill, the Claude-side pieces (statusline, guards,
  settings merge), `install.sh` with `--check` drift reporting, and both
  probes (board 54, deep-plan 52 at seed time).
