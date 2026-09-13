#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) guard for destructive shell commands.
# Exit 2 + stderr blocks the call and feeds the message back to Claude.
# Patterns are intentionally conservative: things that destroy work, leak
# secrets, or rewrite shared history.

set -u

payload="$(cat 2>/dev/null || true)"
cmd=""
if command -v python3 >/dev/null 2>&1; then
  cmd="$(printf '%s' "$payload" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print((d.get("tool_input") or {}).get("command",""))
except Exception:
    pass' 2>/dev/null)"
fi
[ -n "$cmd" ] || exit 0

block() {
  reason="$1"
  if command -v cmux >/dev/null 2>&1 && [ -n "${CMUX_WORKSPACE_ID:-}" ]; then
    cmux notify --title "Claude · blocked" --subtitle "$reason" \
      --body "$(printf '%s' "$cmd" | head -c 200)" >/dev/null 2>&1 || true
  fi
  printf 'Blocked by cmux guard: %s\nCommand: %s\nIf this is intentional, ask the user to run it manually.\n' \
    "$reason" "$cmd" >&2
  exit 2
}

shopt -s nocasematch

# rm -rf on filesystem root / home / wildcards
if [[ "$cmd" =~ (^|[[:space:];|&])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr)[[:space:]]+(/|/\*|~|\$HOME|\.\.|\*) ]]; then
  block "rm -rf at dangerous path"
fi

# force-push (any flavor)
if [[ "$cmd" =~ git[[:space:]]+push.*(--force([^-]|$)|--force-with-lease|[[:space:]]-f([[:space:]]|$)) ]]; then
  block "git push --force"
fi

# hard reset / destructive checkout that wipes uncommitted work
if [[ "$cmd" =~ git[[:space:]]+reset[[:space:]]+(--hard|-{1,2}keep[[:space:]]+--hard) ]]; then
  block "git reset --hard"
fi
if [[ "$cmd" =~ git[[:space:]]+(checkout|restore)[[:space:]]+.*[[:space:]](--|\.)([[:space:]]|$) ]]; then
  block "git checkout/restore -- (discards uncommitted changes)"
fi
if [[ "$cmd" =~ git[[:space:]]+clean[[:space:]]+(-[a-zA-Z]*f|-fd|-fx|-dxf) ]]; then
  block "git clean -f"
fi
if [[ "$cmd" =~ git[[:space:]]+branch[[:space:]]+-D ]]; then
  block "git branch -D (force-delete)"
fi

# bypass hooks / signing
if [[ "$cmd" =~ (--no-verify|--no-gpg-sign|commit\.gpgsign=false) ]]; then
  block "--no-verify / signing bypass"
fi

# database destruction
if [[ "$cmd" =~ (DROP[[:space:]]+(DATABASE|TABLE|SCHEMA)|TRUNCATE[[:space:]]+TABLE) ]]; then
  block "destructive SQL"
fi
if [[ "$cmd" =~ (rails|rake|bundle[[:space:]]+exec[[:space:]]+(rails|rake))[[:space:]]+db:(drop|reset|nuke)([^a-z]|$) ]]; then
  block "rails db:drop/reset"
fi

# pipe-curl-to-shell
if [[ "$cmd" =~ curl[[:space:]].*\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh ]]; then
  block "curl | sh"
fi
if [[ "$cmd" =~ wget[[:space:]].*\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh ]]; then
  block "wget | sh"
fi

# 777 perms
if [[ "$cmd" =~ chmod[[:space:]]+(-R[[:space:]]+)?777 ]]; then
  block "chmod 777"
fi

exit 0
