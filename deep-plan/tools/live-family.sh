#!/bin/bash
# live-family — prove, with real headless Claude sessions, that the family
# hooks reach the model: the guard's note on an edit into a sibling's claim,
# and the news at the next prompt. The probe proves what the hooks print;
# only a live session proves Claude Code delivers it.
#
#   bash deep-plan/tools/live-family.sh        exit 0 when both land
#   KEEP=1 ...                                 leave the fixture for a look
#   LIVE_MODEL=sonnet ...                      default: haiku
#
# Costs two short model calls. Needs `claude` on PATH and logged in. The
# family is staged by family-fixture.sh in a temp dir with its own plan state;
# the sessions run this checkout's hooks through --settings, so it tests the
# code here, not the installed plugin.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
DIR=$(mktemp -d "${TMPDIR:-/tmp}/dp-live-family.XXXXXX")
if [ -z "${KEEP:-}" ]; then trap 'rm -rf "$DIR"' EXIT; else echo "fixture kept: $DIR"; fi
eval "$(bash "$HERE/tools/family-fixture.sh" "$DIR/fx")" || { echo "fixture failed"; exit 2; }
MODEL=${LIVE_MODEL:-haiku}
FAM="$FIX_DIR/state/families/example-auth-revamp"
fail=0
# The sessions run with the fixture's overrides removed. Exported, they would
# reach the installed deep-plan plugin's hooks too, which would then read the
# fixture's state and could deliver the note themselves -- passing this test
# on the installed code instead of this checkout's. Only the --settings
# wrappers below carry the fixture's env.
session() {
  env -u DEEP_PLAN_STATE_DIR -u DEEP_PLAN_KEYS_DIR -u DEEP_PLAN_PLANS_DIR -u DEEP_PLAN_VENDOR_DIR \
      -u DEEP_PLAN_SKILL_DIR -u DEEP_PLAN_ENGINE claude -p --model "$MODEL" "$@"
}
check() {  # check <name> <0|1 result> [what to show on failure]
  if [ "$2" = 0 ]; then echo "  ok   $1"; else echo "  FAIL $1"; [ -n "${3:-}" ] && printf '       %s\n' "$3"; fail=1; fi
}

# One wrapper per hook, so the session's hook carries the fixture's env.
for h in gate news; do
  printf '#!/bin/bash\nsource %s\nexec bash %s/hooks/%s.sh\n' "$FIX_ENV" "$HERE" "$h" > "$DIR/$h-hook.sh"
  chmod +x "$DIR/$h-hook.sh"
done
printf '{"hooks":{"PreToolUse":[{"matcher":"Edit|Write","hooks":[{"type":"command","command":"%s"}]}]}}' \
  "$DIR/gate-hook.sh" > "$DIR/guard.json"
printf '{"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"%s"}]}]}}' \
  "$DIR/news-hook.sh" > "$DIR/news.json"
node "$HERE/deep_plan.mjs" open-gate example-auth-ui >/dev/null

echo "guard: the ui session writes into api's claim"
reply=$(cd "$FIX_UI" && echo "Create the file api/auth/token.ts containing exactly: export const token = 1; \
Then, in one or two sentences, report any note or system reminder you received about that file after \
writing it (quote it if there was one; say 'none' if not)." |
  session --settings "$DIR/guard.json" --permission-mode acceptEdits --allowedTools "Write,Edit,Read" 2>&1)
[ -f "$FIX_UI/api/auth/token.ts" ]; check "the edit was allowed" $?
grep -q '"path":"api/auth/token.ts"' "$FAM/trespass.jsonl" 2>/dev/null &&
  ! grep -q '"session":""' "$FAM/trespass.jsonl"; check "the trespass was recorded with the session's id" $?
grep -qi 'example-auth-api' <<<"$reply"; check "the agent saw the note" $? "$reply"

echo "news: a sibling finishes an increment, then the ui session is prompted"
echo "{\"cwd\":\"$FIX_UI\",\"hook_event_name\":\"UserPromptSubmit\"}" | bash "$DIR/news-hook.sh" >/dev/null
answers=$(python3 -c "import json,sys;print(' '.join(q+'='+a['letter'] for q,a in json.load(open(sys.argv[1]))['answers'].items()))" \
  "$FIX_DIR/keys/example-auth-api.key.json")
node "$HERE/deep_plan.mjs" grade example-auth-api $answers >/dev/null 2>&1
node "$HERE/deep_plan.mjs" go example-auth-api 1 --force >/dev/null 2>&1
node "$HERE/deep_plan.mjs" done example-auth-api 1 --force >/dev/null 2>&1
reply=$(cd "$FIX_UI" && echo "Answering only from context you were given with this message (do not use tools): \
has anything changed in your deep-plan family? Quote the relevant line, or say 'nothing'." |
  session --settings "$DIR/news.json" 2>&1)
grep -qi 'finished increment 1' <<<"$reply"; check "the agent saw the news" $? "$reply"

[ "$fail" = 0 ] && echo "live family: both hooks reached the model" || echo "live family: FAILED"
exit "$fail"
