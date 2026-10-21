#!/usr/bin/env bash
# crew — turn-end follow-up, on seamux: asked.sh's work, done by
# `seamux asked-hook`. Spawned detached by the stop event with the stop
# payload on stdin.
#
#   seamux-asked.sh <transcript-size-at-stop>  < stop-payload
#
# seamux is $SEAMUX_BIN, else ~/.local/bin/seamux (the family's install
# links it there); without it, a no-op.

set -u

seamux="${SEAMUX_BIN:-$HOME/.local/bin/seamux}"
[ -x "$seamux" ] || exit 0
exec "$seamux" asked-hook "$@"
