#!/bin/bash
# lookout comments — UserPromptSubmit and SessionStart. A session whose cwd
# is inside a review's repository is told, as context, what the human said on
# that review's page since it last looked; a machine with no reviews pays one
# bash glob and no interpreter.
REVIEWS="${LOOKOUT_REVIEWS_DIR:-$HOME/.claude/plans/reviews}"
set -- "$REVIEWS"/*.json
[ -e "$1" ] || exit 0
case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
exec node "$HOOKS/comments.mjs"
