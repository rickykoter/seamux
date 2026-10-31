# 0050. Without cmux, the app posts macOS notifications itself when a pane's status file changes

Date: 2026-10-31

## Status

Accepted

## Context

Hooks are separate processes and cannot reach the app. Pane-status files are already the record of state.

## Decision

Without cmux, the app posts macOS notifications itself when a pane's status file changes

## Consequences

No notification appears while the app is not running. Under cmux the app posts nothing, because the hooks already notify through cmux. A notification is posted when a pane moves to needs_input, or when a turn ends with working going to idle.
