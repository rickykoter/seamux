# 0052. Sessions in the app's tmux panes are a fifth host, seamux, for deep-plan, lookout and seamux-mods

Date: 2026-10-31

## Status

Accepted

## Context

In a tmux pane the skills see no CMUX_WORKSPACE_ID and fall back to the terminal host: pages go to a printed link, and an ask page cannot type the answer.

## Decision

Sessions in the app's tmux panes are a fifth host, seamux, for deep-plan, lookout and seamux-mods

## Consequences

The host rule, in both twin copies, checks SEAMUX_HOST, then CMUX_WORKSPACE_ID (cmux), then SEAMUX_PANE_ID (seamux), then remote, desktop and terminal. On seamux, pages are served by crew's intent server as on cmux, and the Dock shows them in the workspace's page column; nothing is opened, and the verb prints the served link. Ask answers are typed with tmux send-keys through crew-board's ask runner, under the same look-before-typing rule. Plan owners, ask records, lookout's workspace and seamux-mods read SEAMUX_* before CMUX_*. Browser checks use Playwright there. The skills' own text is unchanged.
