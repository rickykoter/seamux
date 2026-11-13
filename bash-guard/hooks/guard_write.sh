#!/usr/bin/env bash
# Claude Code PreToolUse(Edit|Write|MultiEdit|NotebookEdit) guard: the session
# allow folder (crew's state folder, allow/) is the person's. The app writes a
# session's force-push allow there on their click, and guard_bash.sh trusts
# it (ADR 0096), so an edit tool may not write there. guard_bash.sh refuses a
# Bash command that names the folder. Exit 2 + stderr refuses the call.
#
# Runs under macOS's /bin/bash 3.2. guard_bash_probe.sh checks it.

set -u
export LC_ALL=C

payload="$(cat 2>/dev/null || true)"

# The path, read exactly with python3 (normalized, so a/../b is b), else the
# first plain file_path or notebook_path string in the payload.
path=""
if command -v python3 >/dev/null 2>&1; then
  path="$(printf '%s' "$payload" | python3 -c 'import json,os,sys
d=json.load(sys.stdin)
t=d.get("tool_input") or {}
p=t.get("file_path") or t.get("notebook_path") or ""
sys.stdout.write(os.path.normpath(p) if isinstance(p,str) and p else "")' 2>/dev/null)" || path=""
fi
if [ -z "$path" ] && [[ "$payload" =~ \"(file_path|notebook_path)\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]]; then
  path="${BASH_REMATCH[2]}"
fi
[ -n "$path" ] || exit 0

# macOS disks ignore case, so the match does too. Without python3 the path is
# not normalized, so anything under cmux-crew that ends up in an allow folder
# (cmux-crew/./allow, cmux-crew/x/../allow) counts.
shopt -s nocasematch
if [[ "$path" =~ (^|/)cmux-crew/(.*/)?allow(/|$) ]]; then
  printf 'Blocked by bash-guard: the session allow folder is the person'\''s\nPath: %s\nOnly the seamux app writes it, when the person allows a force push from a held banner.\n' "$path" >&2
  exit 2
fi
exit 0
