# 0095. Run is offered for git blocks only, other blocks are copy-only, and a hook or signing bypass gets no escalation

Date: 2026-11-13

## Status

Accepted

## Context

Most of what bash-guard refuses is routine git work an agent hands back: a force push after a rebase, a branch delete, a hard reset. Some of it should stay a deliberate act, such as `rm -rf` on a home folder or a script piped from curl into sh. CLAUDE.md says never to route around `--no-verify`.

## Decision

Each held record has a kind. It is `run` for a force push, `git branch -D`, `git reset --hard`, a checkout, restore or switch that discards changes, and `git clean -f`. It is `copy` for every other block: `rm -rf` on a root, home or parent, curl or wget piped to sh, destructive SQL, `rails db:drop` and `chmod 777`. A hook or signing bypass, or a command that touches the session allow folder, gets no record at all.

## Consequences

bash-guard collects every reason a command is refused, and the strictest one sets the kind. A force push joined to `--no-verify` gets no record, and a reset joined to `curl | sh` is copy-only. A command too long for the record to keep whole is copy-only too. The banner and the Dock show Run only for kind `run`.

Alternatives considered: offering Run for every block; offering Run for all but the bypass flags.
