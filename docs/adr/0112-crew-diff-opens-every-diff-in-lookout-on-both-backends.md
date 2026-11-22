# 0112. crew-diff opens every diff in lookout, on both backends

Date: 2026-11-22

## Status

Accepted

## Context

crew-diff exits when the cmux CLI is missing, and with cmux installed on the tmux backend it opens its split in cmux's window, away from the app.

## Decision

You chose one diff tool. lookout already shows a branch, a commit range, a patch and an agent's turn, and it is what deep-plan diff and the reviews use. On tmux, cmux diff would open in cmux's window even when cmux is installed.

## Consequences

cmux diff is no longer used anywhere in crew. The branch view opens lookout --range <base>...HEAD, the merge base to HEAD, so it shows committed work only, as cmux diff --branch did; uncommitted work is crew-diff unstaged and staged. cmux's context-menu actions and the board's diff chip on cmux open lookout's page wherever lookout's host rule puts it.
