# 0046. Sessions carry SEAMUX_WORKSPACE_ID and SEAMUX_PANE_ID; hooks read those first and fall back to CMUX_*

Date: 2026-10-31

## Status

Accepted

## Context

Without cmux nothing sets CMUX_*, and the hooks exit early, so no agent state is ever written. Minting fake CMUX_* ids would mislead every piece of code that takes them to mean cmux is there.

## Decision

Sessions carry SEAMUX_WORKSPACE_ID and SEAMUX_PANE_ID; hooks read those first and fall back to CMUX_*

## Consequences

Under cmux, a native session sets SEAMUX_* equal to cmux's ids and a plain cmux pane uses the CMUX_* fallback, so pane-status keys do not change. Under tmux the app mints the ids. A hook writes pane status without a cmux connection and skips cmux's decoration (sidebar, color, notifications) when there is none. The pretool fast path in seamux-hook.sh reads the same order.
