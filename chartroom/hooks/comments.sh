#!/bin/sh
# chartroom comments: SessionStart and UserPromptSubmit. Only a machine that
# has opened a studio (rooms.json exists) can have something to tell, so
# every other machine pays one file test and no interpreter.
ROOMS="${CHARTROOM_HOME:-$HOME/.claude/chartroom}/rooms.json"
[ -f "$ROOMS" ] || exit 0
case $0 in */*) HOOKS=${0%/*} ;; *) HOOKS=. ;; esac
command -v node >/dev/null 2>&1 || exit 0
exec node "$HOOKS/comments.mjs"
