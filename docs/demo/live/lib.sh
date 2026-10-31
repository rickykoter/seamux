# lib — drive the demo app and its live Claude sessions. Source it:
#
#   source docs/demo/live/lib.sh [ROOT]
#   ui press Create | ui set Branch x | ui dump    the app, through accessibility
#   newws BRANCH [PROMPT]                          the New workspace form
#   say BRANCH TEXT                                type a line into that workspace's Claude
#   keys BRANCH KEY...                             send keys (Enter, Down, 1, ...)
#   screen BRANCH                                  its screen as text
#   idle BRANCH [SECS]                             wait until its Claude is at an empty prompt
#   until_screen BRANCH REGEX [SECS]               wait until its screen matches
#   snap FILE                                      a still of the app window
DEMO_ROOT=${1:-${DEMO_ROOT:-/private/tmp/seamux-demo}}
DEMO_HOME=$DEMO_ROOT/home
DEMO_LIVE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
DEMO_SOCK=$DEMO_HOME/.local/state/seamux/tmux.sock
DEMO_TOOLS=${DEMO_TOOLS:-$DEMO_ROOT/tools}

app_pid() { cat "$DEMO_ROOT/app.pid"; }
ui() { osascript "$DEMO_LIVE/ui.applescript" "$(app_pid)" "$@"; }
win_id() { "$DEMO_TOOLS/wins" "$(app_pid)" | awk '$3=="seamux"{print $1; exit}'; }
snap() { screencapture -x -o -l "$(win_id)" "$1"; }

# The tmux session of the workspace whose folder is BRANCH (its first pane).
pane_of() {
  python3 - "$DEMO_HOME/.local/state/seamux/workspaces.json" "$1" <<'PY'
import json, sys, os
reg = json.load(open(sys.argv[1]))
ws = [w["id"] for w in reg.get("workspaces", []) if os.path.basename(w.get("cwd", "")) == sys.argv[2]]
ps = [p["session"] for p in reg.get("panes", []) if ws and p["ws"] == ws[-1]]
print(ps[0] if ps else "")
PY
}
# "cloud" is the simulated cloud session (family-setup.sh): its own tmux.
CLOUD_SOCK=$DEMO_ROOT/cloud/tmux.sock
_sock() { if [ "$1" = cloud ]; then echo "$CLOUD_SOCK"; else echo "$DEMO_SOCK"; fi; }
_t() {
  [ "$1" = cloud ] && { echo "cloud:"; return; }
  local s; s=$(pane_of "$1"); [ -n "$s" ] || { echo "no pane for $1" >&2; return 1; }; echo "$s:"
}
screen() { tmux -S "$(_sock "$1")" capture-pane -p -t "$(_t "$1")"; }
keys() { local t k; t=$(_t "$1") || return 1; k=$(_sock "$1"); shift; for x in "$@"; do tmux -S "$k" send-keys -t "$t" "$x"; sleep 0.15; done; }
say() {
  local t k; t=$(_t "$1") || return 1; k=$(_sock "$1")
  tmux -S "$k" send-keys -t "$t" -l "$2"; sleep 0.4
  tmux -S "$k" send-keys -t "$t" Enter
}
# Idle: an empty (or placeholder) prompt line and no spinner timer on screen.
idle() {
  local end=$((SECONDS + ${2:-300})) s
  sleep 2
  while [ $SECONDS -lt $end ]; do
    s=$(screen "$1" 2>/dev/null)
    if printf '%s' "$s" | grep -q '^❯' && ! printf '%s' "$s" | grep -qE '…? \([0-9]+(m [0-9]+)?s ·|esc to interrupt'; then return 0; fi
    sleep 1
  done
  echo "idle: $1 still busy after ${2:-300}s" >&2; return 1
}
until_screen() {
  local end=$((SECONDS + ${3:-300}))
  while [ $SECONDS -lt $end ]; do screen "$1" 2>/dev/null | grep -qE "$2" && return 0; sleep 1; done
  echo "until_screen: $1 never showed /$2/" >&2; return 1
}
newws() {
  ui press "New workspace" >/dev/null; sleep 1.2
  ui set Branch "$1" >/dev/null; sleep 0.3
  [ -n "${2:-}" ] && { ui set "First prompt" "$2" >/dev/null; sleep 0.3; }
  ui press Create >/dev/null
  local end=$((SECONDS + 60)); until [ -n "$(pane_of "$1")" ] || [ $SECONDS -ge $end ]; do sleep 0.5; done
  pane_of "$1"
}
# The demo world's env for running the plugins' CLIs as a person would.
# PATH is the panes' own (.zshenv): your shell's node may be a version
# manager's shim, which finds nothing under the demo HOME.
demo_env() { env HOME="$DEMO_HOME" PATH="$(. "$DEMO_HOME/.zshenv"; echo "$PATH")" SEAMUX_BIN="$DEMO_HOME/.local/bin/seamux" "$@"; }

# Answer whatever question Claude has up with its first (recommended)
# option: a single choice takes "1" and moves on, a multi-select ticks 1
# and tabs on, and the review page submits with "1". Prints what it did, or
# nothing when no question is up.
answer() {
  local s; s=$(screen "$1" 2>/dev/null) || return 1
  if printf '%s' "$s" | grep -q 'Ready to submit'; then keys "$1" 1; echo submit
  elif printf '%s' "$s" | grep -q 'Enter to select'; then
    if printf '%s' "$s" | grep -qE '\[[ x✔]\]'; then
      printf '%s' "$s" | grep -qE '\[(x|✔)\]' || keys "$1" 1
      keys "$1" Tab; echo multi
    else keys "$1" 1; echo pick; fi
  fi
}

# tap TEXT [SECS]   press the control named TEXT (^TEXT: starting with it)
#                   through accessibility, scrolled into view first,
#                   retrying until it shows up.
# hand TEXT [SECS]  the same with a real click: the cursor moves there and the
#                   demo app comes to the front (for web content that takes no
#                   accessibility press, like the board's chips).
_where() {
  local end=$((SECONDS + ${2:-10})) p
  while [ $SECONDS -lt $end ]; do
    p=$("$DEMO_TOOLS/axfind" "$(app_pid)" "$1" 2>/dev/null) && { echo "$p"; return 0; }
    sleep 0.5
  done
  echo "no control: $1" >&2; return 1
}
tap() {
  local end=$((SECONDS + ${2:-10}))
  while [ $SECONDS -lt $end ]; do
    "$DEMO_TOOLS/axfind" --press "$(app_pid)" "$1" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "no control: $1" >&2; return 1
}
front() { osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $(app_pid)) to true"; sleep 0.3; }
hand() { local p; p=$(_where "$1" "${2:-10}") || return 1; set -- $p; front; "$DEMO_TOOLS/click" "$1" "$2" >/dev/null; }
