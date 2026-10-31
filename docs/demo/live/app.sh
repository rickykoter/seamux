#!/bin/bash
# app — start the installed seamux app on the demo HOME (see setup.sh).
#
#   bash docs/demo/live/app.sh [ROOT]          start it (logs in ROOT/app.log)
#   bash docs/demo/live/app.sh [ROOT] --stop   quit it and its tmux server
#
# A second app beside yours: its own HOME, its own tmux socket, and its intent
# server pinned to port 7445 so it never answers on your 7345.
set -eu
ROOT=${1:-/private/tmp/seamux-demo}
H=$ROOT/home
APP=$HOME/Applications/seamux.app/Contents/MacOS/seamux-app
if [ "${2:-}" = "--stop" ]; then
  [ -f "$ROOT/app.pid" ] && kill "$(cat "$ROOT/app.pid")" 2>/dev/null || true
  tmux -S "$H/.local/state/seamux/tmux.sock" kill-server 2>/dev/null || true
  pkill -f "HOME=$H" 2>/dev/null || true
  for p in $(pgrep -f "seamux crew-board-intent"); do
    ps eww -p "$p" | grep -q "HOME=$H" && kill "$p" || true
  done
  rm -f "$ROOT/app.pid"; echo "stopped"; exit 0
fi
[ -d "$H" ] || { echo "app: run setup.sh first" >&2; exit 2; }
# shellcheck disable=SC1091
source "$H/.zshenv"
env -i HOME="$H" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TERM=xterm-256color LANG=en_US.UTF-8 \
  PATH="$PATH" SEAMUX_BIN="$SEAMUX_BIN" CREW_REMOTE=0 CREW_INTENT_PORT=7445 \
  GIT_AUTHOR_NAME="$GIT_AUTHOR_NAME" GIT_AUTHOR_EMAIL="$GIT_AUTHOR_EMAIL" \
  GIT_COMMITTER_NAME="$GIT_COMMITTER_NAME" GIT_COMMITTER_EMAIL="$GIT_COMMITTER_EMAIL" \
  "$APP" > "$ROOT/app.log" 2>&1 &
echo $! > "$ROOT/app.pid"
echo "started pid $(cat "$ROOT/app.pid") (log $ROOT/app.log)"
