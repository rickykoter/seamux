#!/bin/bash
# live-family — prove, with real Claude sessions, that the family hooks reach
# the model: the guard's note on an edit into a sibling's claim, and the news
# at the next prompt. The probe proves what the hooks print; only a live
# session proves Claude Code delivers it.
#
#   bash deep-plan/tools/live-family.sh              headless: two `claude -p` calls
#   bash deep-plan/tools/live-family.sh --cmux       the same checks, on screen
#
# Headless options: KEEP=1 leaves the fixture; LIVE_MODEL=sonnet (default haiku).
#
# --cmux runs the take in real cmux workspaces with an interactive claude,
# paced for a screen recording (docs/demo/reel/take.md, "Family clip"):
#
#   --real-state     render the family into your real plan state, so the crew
#                    board, the sidebar, /plan-pane and the family's colors show
#                    it (grouping and shades need crew applied at a version with
#                    families); the parent and api worktrees get workspaces too.
#                    Removed afterwards.
#   --captions FILE  write the beats as [{at, text}] on the take's clock
#                    (seconds since the script started), for stitch.mjs
#   --lead S         seconds before the first workspace opens (default 3):
#                    time to start the recording
#   --pace S         seconds to hold after each beat (default 4)
#   --keep           leave the workspaces (and real-state plans) open
#
# The session runs this checkout's hooks through --settings, as headless does,
# whatever version of the plugin is installed; --real-state only moves the
# plan state. It also gets a neutral status line: the usual one shows your
# usage window.
#
# Costs two short model calls. Needs `claude` on PATH and logged in; --cmux
# needs cmux running. The family is family-fixture.sh's.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
MODE=headless REAL="" KEEP=${KEEP:-} CAPTIONS="" LEAD=3 PACE=4
while [ $# -gt 0 ]; do
  case "$1" in
    --cmux) MODE=cmux ;;
    --real-state) REAL=1 ;;
    --keep) KEEP=1 ;;
    --captions) CAPTIONS=$2; shift ;;
    --lead) LEAD=$2; shift ;;
    --pace) PACE=$2; shift ;;
    *) echo "live-family: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$REAL" ] && [ "$MODE" != cmux ] && { echo "live-family: --real-state goes with --cmux" >&2; exit 2; }
MODEL=${LIVE_MODEL:-haiku}
fail=0
check() {  # check <name> <0|1 result> [what to show on failure]
  local at=""; [ -n "${T0:-}" ] && at=" [$(( $(date +%s) - T0 ))s]"
  if [ "$2" = 0 ]; then echo "  ok   $1$at"; else echo "  FAIL $1$at"; [ -n "${3:-}" ] && printf '       %s\n' "$3"; fail=1; fi
}
# The sessions run with the fixture's overrides removed. Exported, they reach
# the installed plugin's hook entry points too: DEEP_PLAN_SKILL_DIR sends its
# gate.sh to this checkout's decide.mjs and the state overrides to the
# fixture, so the installed hook delivers the note and the test passes on a
# hook it was not meant to exercise. Only the --settings wrappers below carry
# the fixture's env.
session() {
  env -u DEEP_PLAN_STATE_DIR -u DEEP_PLAN_KEYS_DIR -u DEEP_PLAN_PLANS_DIR -u DEEP_PLAN_VENDOR_DIR \
      -u DEEP_PLAN_SKILL_DIR -u DEEP_PLAN_ENGINE claude -p --model "$MODEL" "$@"
}
dp() { node "$HERE/deep_plan.mjs" "$@"; }

GUARD_PROMPT="Create the file api/auth/token.ts containing exactly: export const token = 1; \
Then, in one or two sentences, report any note or system reminder you received about that file after \
writing it (quote it if there was one; say 'none' if not)."
NEWS_PROMPT="Answering only from context you were given with this message (do not use tools): \
has anything changed in your deep-plan family? Quote the relevant line, or say 'nothing'."

# ---------------------------------------------------------------- fixture
if [ "$MODE" = headless ]; then
  DIR=$(mktemp -d "${TMPDIR:-/tmp}/dp-live-family.XXXXXX")
  if [ -z "$KEEP" ]; then trap 'rm -rf "$DIR"' EXIT; else echo "fixture kept: $DIR"; fi
else
  # One fixed place, so Claude Code's folder-trust answer from the first take
  # holds for the next; the previous take's fixture is cleared first.
  DIR=${LIVE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/seamux-demo/live-family}
  python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$DIR/fx"
  mkdir -p "$DIR"
fi
eval "$(bash "$HERE/tools/family-fixture.sh" "$DIR/fx" ${REAL:+--real-state})" || { echo "fixture failed"; exit 2; }
STATE=${DEEP_PLAN_STATE_DIR:-$HOME/.claude/deep-plan/state}
FAM="$STATE/families/example-auth-revamp"

# One wrapper per hook, so the session's hook carries the fixture's env.
for h in gate news; do
  printf '#!/bin/bash\nsource %s\nexec bash %s/hooks/%s.sh\n' "$FIX_ENV" "$HERE" "$h" > "$DIR/$h-hook.sh"
  chmod +x "$DIR/$h-hook.sh"
done
GATE_HOOK='{"matcher":"Edit|Write","hooks":[{"type":"command","command":"'"$DIR/gate-hook.sh"'"}]}'
NEWS_HOOK='{"matcher":"","hooks":[{"type":"command","command":"'"$DIR/news-hook.sh"'"}]}'
printf '{"hooks":{"PreToolUse":[%s]}}' "$GATE_HOOK" > "$DIR/guard.json"
printf '{"hooks":{"UserPromptSubmit":[%s]}}' "$NEWS_HOOK" > "$DIR/news.json"
dp open-gate example-auth-ui >/dev/null
# The ui session has looked once, so its first prompt is not an orientation:
# what the agent says about example-auth-api can only come from the note.
echo "{\"cwd\":\"$FIX_UI\",\"hook_event_name\":\"UserPromptSubmit\"}" | bash "$DIR/news-hook.sh" >/dev/null

finish_api_increment() {
  local answers
  answers=$(python3 -c "import json,sys;print(' '.join(q+'='+a['letter'] for q,a in json.load(open(sys.argv[1]))['answers'].items()))" \
    "${DEEP_PLAN_KEYS_DIR:-$HOME/.claude/deep-plan/keys}/example-auth-api.key.json")
  dp grade example-auth-api $answers >/dev/null 2>&1
  dp go example-auth-api 1 --force >/dev/null 2>&1
  dp done example-auth-api 1 --force >/dev/null 2>&1
}
trespass_ok() {
  grep -q '"path":"api/auth/token.ts"' "$FAM/trespass.jsonl" 2>/dev/null &&
    ! grep -q '"session":""' "$FAM/trespass.jsonl"
}

# ---------------------------------------------------------------- headless
if [ "$MODE" = headless ]; then
  echo "guard: the ui session writes into api's claim"
  reply=$(cd "$FIX_UI" && echo "$GUARD_PROMPT" |
    session --settings "$DIR/guard.json" --permission-mode acceptEdits --allowedTools "Write,Edit,Read" 2>&1)
  [ -f "$FIX_UI/api/auth/token.ts" ]; check "the edit was allowed" $?
  trespass_ok; check "the trespass was recorded with the session's id" $?
  grep -qi 'example-auth-api' <<<"$reply"; check "the agent saw the note" $? "$reply"

  echo "news: a sibling finishes an increment, then the ui session is prompted"
  finish_api_increment
  reply=$(cd "$FIX_UI" && echo "$NEWS_PROMPT" | session --settings "$DIR/news.json" 2>&1)
  grep -qi 'finished increment 1' <<<"$reply"; check "the agent saw the news" $? "$reply"

  [ "$fail" = 0 ] && echo "live family: both hooks reached the model" || echo "live family: FAILED"
  exit "$fail"
fi

# ---------------------------------------------------------------- cmux
export CMUX_QUIET=1
CMUX=${CREW_CMUX:-cmux}
T0=$(date +%s)
CAPS=()
beat() {  # a caption, stamped on the take's clock
  local at=$(( $(date +%s) - T0 ))
  CAPS+=("$(python3 -c 'import json,sys; print(json.dumps({"at": float(sys.argv[1]), "text": sys.argv[2]}))' "$at" "$1")")
  echo "  [${at}s] $1"
}
WORKSPACES=()
open_ws() {  # open_ws <name> <cwd> <command> <focus>; sets WS
  local out
  out=$("$CMUX" new-workspace --name "$1" --cwd "$2" --focus "$4" --command "$3" 2>&1)
  WS=$(grep -o 'workspace:[0-9]*' <<<"$out" | head -1)
  [ -n "$WS" ] || { echo "live-family: cmux new-workspace failed: $out" >&2; return 1; }
  WORKSPACES+=("$WS")
}
screen() { "$CMUX" read-screen --workspace "$1" --scrollback --lines 300 2>/dev/null; }
wait_for() {  # wait_for <ws> <regex> <secs>
  local i
  for ((i = 0; i < $3; i++)); do screen "$1" | grep -qE "$2" && return 0; sleep 1; done
  return 1
}
ask() { "$CMUX" send --workspace "$1" "$2" >/dev/null && "$CMUX" send-key --workspace "$1" enter >/dev/null; }
cleanup() {
  if [ -n "$KEEP" ]; then
    echo "kept: ${WORKSPACES[*]:-} (close each with: cmux close-workspace --force --workspace <ref>)"
    return
  fi
  for w in "${WORKSPACES[@]:-}"; do [ -n "$w" ] && "$CMUX" close-workspace --force --workspace "$w" >/dev/null 2>&1; done
  if [ -n "$REAL" ]; then
    # Only what the fixture created: it refused to start if any of these existed.
    python3 - "$FIX_SLUGS" <<'PY'
import glob, os, shutil, sys
home = os.path.expanduser("~/.claude")
state = os.environ.get("DEEP_PLAN_STATE_DIR") or f"{home}/deep-plan/state"
keys = os.environ.get("DEEP_PLAN_KEYS_DIR") or f"{home}/deep-plan/keys"
plans = os.environ.get("DEEP_PLAN_PLANS_DIR") or f"{home}/plans"
for slug in sys.argv[1].split():
    for f in [f"{state}/{slug}.json", f"{keys}/{slug}.spec.json", f"{keys}/{slug}.key.json",
              *glob.glob(f"{plans}/{slug}.*")]:
        if os.path.isfile(f):
            os.remove(f)
    for d in [f"{state}/families/{slug}", f"{plans}/{slug}.cutover", f"{plans}/{slug}.runs"]:
        shutil.rmtree(d, ignore_errors=True)
PY
    echo "removed the fixture's plans from your real state"
  fi
}
trap cleanup EXIT

SETTINGS=$DIR/session.json
printf '{"statusLine":{"type":"command","command":"printf example-auth-ui"},"hooks":{"PreToolUse":[%s],"UserPromptSubmit":[%s]}}' \
  "$GATE_HOOK" "$NEWS_HOOK" > "$SETTINGS"
if [ -n "$REAL" ] && [ ! -f "$HOME/.config/cmux/crew/board/families.py" ]; then
  echo "  note: the applied crew predates families: the board and sidebar list the plans but do not" \
       "group or shade them. \`crew apply\` from your kept checkout first." >&2
fi
sync=$(command -v crew-sync || echo "$HOME/.local/bin/crew-sync")

echo "lead: ${LEAD}s to start the recording"
sleep "$LEAD"
if [ -n "$REAL" ]; then
  open_ws example-auth-revamp "$FIX_PARENT" \
    "clear; DEEP_PLAN_ENGINE_FILE=$DIR/fx/engine.json node $HERE/deep_plan.mjs family status example-auth-revamp; exec cat" false
  open_ws example-auth-api "$FIX_API" "clear; exec cat" false
fi
open_ws example-auth-ui "$FIX_UI" \
  "clear; exec /bin/zsh -ilc 'claude --model $MODEL --settings $SETTINGS --permission-mode acceptEdits'" true || exit 2
UIWS=$WS
[ -n "$REAL" ] && [ -x "$sync" ] && "$sync" >/dev/null 2>&1
beat "A parent plan coordinates two workstreams, each in its own worktree"

# A first take in this folder asks whether to trust it; the default is "No, exit".
if wait_for "$UIWS" 'trust this folder|^❯' 40 && screen "$UIWS" | grep -q 'trust this folder'; then
  "$CMUX" send-key --workspace "$UIWS" down >/dev/null
  "$CMUX" send-key --workspace "$UIWS" enter >/dev/null
fi
wait_for "$UIWS" '^❯' 40; check "the ui session is ready" $?
sleep "$PACE"

beat "The ui agent writes a file the api workstream owns"
ask "$UIWS" "$GUARD_PROMPT"
wait_for "$UIWS" '[Ee]xample-auth-api' 120
seen=$?
[ -f "$FIX_UI/api/auth/token.ts" ]; check "the edit was allowed" $?
trespass_ok; check "the trespass was recorded with the session's id" $?
check "the agent saw the note" $seen "$(screen "$UIWS" | tail -15)"
beat "Allowed, and told who owns it; the overlap is recorded"
sleep "$PACE"

beat "Meanwhile the api workstream finishes an increment"
finish_api_increment
[ -n "$REAL" ] && [ -x "$sync" ] && "$sync" >/dev/null 2>&1
sleep "$PACE"

beat "At its next prompt the ui agent hears what changed"
# An idle prompt is the glyph and a no-break space, which ' *' does not match.
NBSP=$(printf '\302\240')
wait_for "$UIWS" "^❯[ $NBSP]*\$" 60; check "the ui session is idle again" $?
ask "$UIWS" "$NEWS_PROMPT"
wait_for "$UIWS" '[Ff]inished increment 1' 120; check "the agent saw the news" $? "$(screen "$UIWS" | tail -15)"
sleep "$PACE"

if [ -n "$CAPTIONS" ]; then
  (IFS=,; printf '[%s]\n' "${CAPS[*]}") > "$CAPTIONS"
  echo "captions: $CAPTIONS"
fi
[ "$fail" = 0 ] && echo "live family (cmux): both hooks reached the model" || echo "live family (cmux): FAILED"
exit "$fail"
