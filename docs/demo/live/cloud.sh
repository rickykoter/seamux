#!/bin/bash
# cloud — the simulated cloud session: Claude in the cloud clone, in a tmux
# of its own, shown in a Terminal window titled "cloud sandbox".
#
#   bash docs/demo/live/cloud.sh [ROOT] start    start Claude and open the window
#   bash docs/demo/live/cloud.sh [ROOT] stop     close both
#
# Prints the window's id (for winrec) on start.
set -eu
ROOT=${1:-/private/tmp/seamux-demo}
C=$ROOT/cloud
SOCK=$C/tmux.sock
X=${CLOUD_X:-300} Y=${CLOUD_Y:-160} W=${CLOUD_W:-1280} H=${CLOUD_H:-720}
case "${2:-start}" in
stop)
  tmux -S "$SOCK" kill-server 2>/dev/null || true
  sleep 0.5
  # Terminal keeps a finished window open: close ours, by its close button.
  for _ in 1 2 3 4 5; do
    osascript -e 'tell application "System Events" to tell process "Terminal" to click (first button of (first window whose name contains "cloud sandbox") whose subrole is "AXCloseButton")' >/dev/null 2>&1 || break
    sleep 0.3
  done
  exit 0 ;;
esac
bash "$0" "$ROOT" stop
[ -d "$C/shop" ] || { echo "cloud: no clone at $C/shop (family-stage.sh makes it)" >&2; exit 2; }
tmux -S "$SOCK" kill-server 2>/dev/null || true
# A clean environment: nothing of the shell that runs this (a Claude Code
# session's markers would turn the cloud session's transcripts off).
env -i HOME="$C/home" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TERM=xterm-256color LANG=en_US.UTF-8 \
  PATH="$C/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  tmux -S "$SOCK" -f /dev/null new-session -d -s cloud -x 150 -y 42 -c "$C/shop" \
  -e COLORTERM=truecolor -e CLAUDE_CODE_TMUX_TRUECOLOR=1 "$C/bin/claude; exec /bin/zsh -l"
tmux -S "$SOCK" set-option -t cloud status off
tmux -S "$SOCK" set-option -s escape-time 0
# Terminal.app opens a .command file in a new window (no Apple Events to
# Terminal, so no Automation permission). The pane paints its own dark
# background through tmux; the title comes from an escape sequence; the
# window is sized through accessibility, which the take already uses.
tmux -S "$SOCK" set-option -t cloud window-style 'bg=#1c2023,fg=#d3c6aa'
tmux -S "$SOCK" set-option -t cloud window-active-style 'bg=#1c2023,fg=#d3c6aa'
cat > "$C/attach.command" <<CMD
#!/bin/bash
printf '\033]0;cloud sandbox · auth-api\007'
exec tmux -S '$SOCK' attach -t cloud
CMD
chmod +x "$C/attach.command"
open -a Terminal "$C/attach.command"
for _ in $(seq 40); do
  osascript -e 'tell application "System Events" to exists (first window of process "Terminal" whose name contains "cloud sandbox")' 2>/dev/null | grep -q true && break
  sleep 0.25
done
osascript -e "tell application \"System Events\" to tell (first window of process \"Terminal\" whose name contains \"cloud sandbox\")
set position to {$X, $Y}
set size to {$W, $H}
end tell" >/dev/null
sleep 0.5
"$ROOT/tools/wins" "$(pgrep -x Terminal | head -1)" | awk '/cloud sandbox/{print $1; exit}'
