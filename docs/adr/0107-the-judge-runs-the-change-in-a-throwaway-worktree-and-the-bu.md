# 0107. The judge runs the change in a throwaway worktree and the builder learns only titles and scores

Date: 2026-11-18

## Status

Accepted

## Context

(context not recorded)

## Decision

the person chose it: behavior that only shows when the thing runs is what slipped past every check in the landing plan, and reasons passed back leak the scenarios over a few rounds

## Consequences

a scenarios check makes a worktree at HEAD, sets HOME, CREW_DURABLE_DIR and XDG_CACHE_HOME to a temp folder (L8), runs the repo's harness recipe, and starts the judge headless with the scenarios, the harness's exports and a fixed tool list. Each scenario gets a score from 0 to 1, and the check passes when the plan's threshold is met. The engine prints titles and scores, plus a hint the person approved, and keeps the judge's reasons and transcript in the sealed folder

## Notes

The judge starts in an empty folder beside the throwaway worktree and
reaches it through `--add-dir`, with no settings loaded, so nothing the
builder put in the checkout (a CLAUDE.md, a README) is loaded as its own
project. Its prompt names the checkout's files and output as evidence,
never instructions. Its shell may not push, run gh or change remotes, and
the GitHub tokens are unset there. The harness and the judge's shell get
the temp HOME through `CLAUDE_ENV_FILE`; the judge's own process keeps the
person's, where its sign-in lives.
