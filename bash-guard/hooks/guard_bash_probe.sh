#!/usr/bin/env bash
# Feeds every case in guard_bash_cases.txt to guard_bash.sh as a PreToolUse
# payload and checks the exit code: 2 for `block`, 0 for `allow`. Each case
# runs twice: once with python3 reading the payload, once with python3 off
# PATH so the plain-shell fallback reads it. Then a few checks on the guard
# itself: the fallback says so, an unreadable payload is waved through loudly,
# and a long heredoc stays well inside the hook's 5s timeout.
#
#   bash bash-guard/hooks/guard_bash_probe.sh
set -u

here="$(cd "$(dirname "$0")" && pwd)"
hook="$here/guard_bash.sh"
cases="$here/guard_bash_cases.txt"
bash_bin="$(command -v bash)"

# The opt-in force-push cases need this set; the checks below clear it.
leased='git push --force-with-lease=deploy-5:0123456789abcdef0123456789abcdef01234567 origin x:deploy-5'
export BASH_GUARD_FORCE_PUSH_BRANCHES='deploy-([1-9]|1[0-9]|20)'

# A PATH with only what the guard needs besides builtins, and no python3.
nopy="$(mktemp -d "${TMPDIR:-/tmp}/guard-probe.XXXXXX")"
trap 'rm -r "$nopy"' EXIT
for t in cat head; do ln -s "$(command -v "$t")" "$nopy/$t"; done

modes="shell"
if command -v python3 >/dev/null 2>&1; then
  modes="python3 shell"
else
  echo "note: python3 is not on PATH; only the plain-shell fallback is probed"
fi

fails=0
runs=0
rc=0
err=""

# hook MODE PAYLOAD: runs the guard, sets rc and err (its stderr).
hook() {
  if [ "$1" = python3 ]; then
    err="$(printf '%s' "$2" | CMUX_WORKSPACE_ID='' "$bash_bin" "$hook" 2>&1 >/dev/null)"
  else
    err="$(printf '%s' "$2" | CMUX_WORKSPACE_ID='' PATH="$nopy" "$bash_bin" "$hook" 2>&1 >/dev/null)"
  fi
  rc=$?
}

fail() {
  fails=$((fails + 1))
  printf 'FAIL %s\n' "$*"
}

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  expect="${line%% *}"
  body="${line#* }"
  case "$expect" in
    block) want=2 ;;
    allow) want=0 ;;
    *) fail "bad case line: $line"; continue ;;
  esac
  payload="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$body\",\"description\":\"probe\"}}"
  for mode in $modes; do
    runs=$((runs + 1))
    hook "$mode" "$payload"
    [ "$rc" = "$want" ] || fail "[$mode] want $expect, exit $rc: $body"
  done
done <"$cases"

# Without the opt-in variable, or with a pattern that does not name the branch,
# the same leased push is blocked like any other force-push.
for setting in "unset" "empty" "other"; do
  for mode in $modes; do
    case "$setting" in
      unset) payload_env=(env -u BASH_GUARD_FORCE_PUSH_BRANCHES) ;;
      empty) payload_env=(env BASH_GUARD_FORCE_PUSH_BRANCHES=) ;;
      other) payload_env=(env 'BASH_GUARD_FORCE_PUSH_BRANCHES=release-[0-9]+') ;;
    esac
    if [ "$mode" = python3 ]; then
      "${payload_env[@]}" CMUX_WORKSPACE_ID='' "$bash_bin" "$hook" >/dev/null 2>&1 \
        <<<"{\"tool_input\":{\"command\":\"$leased\"}}"
    else
      "${payload_env[@]}" CMUX_WORKSPACE_ID='' PATH="$nopy" "$bash_bin" "$hook" >/dev/null 2>&1 \
        <<<"{\"tool_input\":{\"command\":\"$leased\"}}"
    fi
    rc=$?
    [ "$rc" = 2 ] || fail "[$mode] leased push with the variable $setting: want block, exit $rc"
    runs=$((runs + 1))
  done
done

# The fallback announces itself, and still blocks.
hook shell '{"tool_input":{"command":"git status"}}'
case "$err" in *plain-shell\ fallback*) ;; *) fail "[shell] no fallback note on stderr: $err" ;; esac
runs=$((runs + 1))

# A payload nothing can read goes through, but never silently.
for mode in $modes; do
  hook "$mode" 'not json'
  [ "$rc" = 0 ] || fail "[$mode] unreadable payload: exit $rc"
  case "$err" in *NOT\ checked*) ;; *) fail "[$mode] unreadable payload passed silently" ;; esac
  runs=$((runs + 1))
done

# Long commands are split and checked quickly (bash 3.2 has quadratic string
# operations that once took minutes here), and a dangerous line at the end is
# still found: a heredoc full of quotes and separators, one whose stray
# apostrophe never closes, and one long line with no escapes at all.
quoted="cat <<'EOF' > notes.txt"
stray="cat <<EOF > notes.txt\\ndon't"
i=0
while [ $i -lt 3000 ]; do
  quoted="$quoted\\nline $i: it's \\\"quoted\\\"; a | b && c"
  stray="$stray\\nline $i: plain words, and more words to make it long"
  i=$((i + 1))
done
oneline="aaaaaaaaaaaaaaaa"
i=0
while [ $i -lt 13 ]; do oneline="$oneline$oneline"; i=$((i + 1)); done
for big in "$quoted\\nEOF\\nrm -rf ~" "$stray\\nEOF\\nrm -rf ~" "echo $oneline; rm -rf ~"; do
  for mode in $modes; do
    start=$SECONDS
    hook "$mode" "{\"tool_input\":{\"command\":\"$big\"}}"
    took=$((SECONDS - start))
    [ "$rc" = 2 ] || fail "[$mode] ${#big}-char command: want block, exit $rc"
    [ "$took" -le 2 ] || fail "[$mode] ${#big}-char command took ${took}s"
    runs=$((runs + 1))
  done
done

if [ "$fails" -gt 0 ]; then
  printf '%d of %d guard checks failed\n' "$fails" "$runs"
  exit 1
fi
printf 'ok: %d guard checks passed (%s)\n' "$runs" "$modes"
