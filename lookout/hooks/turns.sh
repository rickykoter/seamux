#!/bin/bash
# lookout turns — UserPromptSubmit (start), Stop (end), SessionStart (prune).
# Snapshots the working tree into refs/seamux/turns/<session>/<n>/ (see
# lib/turns.mjs, which also skips cloud sessions by lib/host.mjs's rule).
# UserPromptSubmit's stdout becomes context, so this prints nothing, ever,
# and always exits 0.
case "${1:-}" in start|end|prune) ;; *) exit 0 ;; esac
case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
node "$HOOKS/../lib/turns.mjs" "$1" >/dev/null 2>&1
exit 0
