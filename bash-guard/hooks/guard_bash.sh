#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) guard for destructive shell commands.
# Exit 2 + stderr blocks the call and feeds the message back to Claude.
# Patterns are intentionally conservative: things that destroy work, leak
# secrets, or rewrite shared history. guard_bash_probe.sh holds the commands
# each check must block and must allow; run it after any change here.
#
# Runs under macOS's /bin/bash 3.2, so no ${var,,}, no associative arrays.

set -u
# Byte-wise matching: the same on every locale, and fast on long heredocs.
export LC_ALL=C

payload="$(cat 2>/dev/null || true)"

# The "command" string read straight out of the JSON with builtins, JSON's
# escapes undone; used only when python3 cannot read the payload. It splits
# the value at each backslash, so the cost stays linear: ${s//a/b} and one
# regex matching every escape both took minutes on a 3000-line heredoc.
# \uXXXX above ASCII stays as written; no check looks for those characters.
shell_command() {
  local parts t c hex n k=1
  [[ "$payload" =~ \"command\"[[:space:]]*:[[:space:]]*\"(.*)$ ]] || return 1
  IFS='\' read -r -d '' -a parts <<<"${BASH_REMATCH[1]}"
  n=${#parts[@]}
  # plain TEXT: print it up to the closing quote; fail once the string ends.
  plain() {
    if [[ "$1" =~ ^([^\"]*)\" ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 1
    fi
    printf '%s' "$1"
  }
  plain "${parts[0]-}" || return 0
  # Each later part followed a backslash: its first character is the escape,
  # or, when it is empty, the next backslash is (\\) and the part after that
  # is plain text.
  while [ "$k" -lt "$n" ]; do
    t="${parts[$k]}"
    k=$((k + 1))
    if [ -z "$t" ]; then
      printf '\\'
      plain "${parts[$k]-}" || return 0
      k=$((k + 1))
      continue
    fi
    c="${t:0:1}"
    t="${t:1}"
    case "$c" in
      n) printf '\n' ;;
      t) printf '\t' ;;
      r) printf '\r' ;;
      b) printf '\b' ;;
      f) printf '\f' ;;
      u)
        hex="${t:0:4}"
        t="${t:4}"
        case "$hex" in
          00[0-7][0-9a-fA-F]) printf "\\x${hex:2}" ;;
          *) printf '\\u%s' "$hex" ;;
        esac
        ;;
      *) printf '%s' "$c" ;;
    esac
    plain "$t" || return 0
  done
  return 1
}

# python3 parses the payload exactly. Without it the guard does not wave every
# command through: it falls back to shell_command and says so on stderr (shown
# in the transcript), and only an unreadable payload goes unchecked, loudly.
# Failing closed instead would refuse every Bash call on a machine without
# python3, which would make the session unusable rather than safer.
cmd=""
read_by=""
if command -v python3 >/dev/null 2>&1; then
  if cmd="$(printf '%s' "$payload" | python3 -c 'import json,sys
d=json.load(sys.stdin)
c=(d.get("tool_input") or {}).get("command","")
sys.stdout.write(c if isinstance(c,str) else str(c))' 2>/dev/null)"; then
    read_by=python3
  else
    why="python3 could not parse the hook payload"
  fi
else
  why="python3 is not on PATH"
fi
if [ -z "$read_by" ]; then
  if cmd="$(shell_command)"; then
    printf 'bash-guard: %s; read the command with the plain-shell fallback\n' "$why" >&2
  else
    printf 'bash-guard: %s, and the plain-shell fallback found no command: NOT checked\n' "$why" >&2
    exit 0
  fi
fi
[ -n "$cmd" ] || exit 0

# A JSON string of $1: backslash, quote and control characters escaped, so
# the file below needs no python.
json_str() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      '\') out+='\\' ;;
      '"') out+='\"' ;;
      $'\n') out+='\n' ;;
      $'\t') out+='\t' ;;
      $'\r') out+='\r' ;;
      *) if [[ "$c" < ' ' ]]; then out+="$(printf '\\u%04x' "'$c")"; else out+="$c"; fi ;;
    esac
  done
  printf '"%s"' "$out"
}

# How a block reaches the person. In cmux, cmux notify. In a pane of the
# seamux app's own tmux (SEAMUX_BACKEND=tmux), a file in crew's state folder,
# blocked-<pane>.json, which the app posts and deletes: bash-guard never
# calls the app (ADR 0004).
tell_block() {
  local reason="$1" body key dir tmp
  body="$(printf '%s' "$cmd" | head -c 200)"
  if [ "${SEAMUX_BACKEND:-}" = tmux ]; then
    key="${SEAMUX_PANE_ID:-${SEAMUX_WORKSPACE_ID:-}}"
    [[ "$key" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || return 0
    dir="${HOME}/.cache/cmux-crew"
    mkdir -p "$dir" 2>/dev/null || return 0
    tmp="$dir/.blocked-$key.$$"
    if printf '{"pane": %s, "workspace": %s, "reason": %s, "command": %s, "at": %s}\n' \
      "$(json_str "${SEAMUX_PANE_ID:-}")" "$(json_str "${SEAMUX_WORKSPACE_ID:-}")" \
      "$(json_str "$reason")" "$(json_str "$body")" "$(date +%s)" >"$tmp" 2>/dev/null; then
      mv -f "$tmp" "$dir/blocked-$key.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    else
      rm -f "$tmp" 2>/dev/null
    fi
    return 0
  fi
  if command -v cmux >/dev/null 2>&1 && [ -n "${CMUX_WORKSPACE_ID:-}" ]; then
    cmux notify --title "Claude · blocked" --subtitle "$reason" --body "$body" >/dev/null 2>&1 || true
  fi
}

block() {
  reason="$1"
  tell_block "$reason"
  printf 'Blocked by cmux guard: %s\nCommand: %s\nIf this is intentional, ask the user to run it manually.\n' \
    "$reason" "$cmd" >&2
  exit 2
}

# ---------------------------------------------------------------- simple commands
#
# The checks on one command's flags (rm, git push/reset/checkout/restore/
# switch/clean/branch) look only inside one simple command, so `git push x &&
# rm -f y` is two commands and the -f is rm's. A command ends at an unquoted
# ; & | or newline; quoted strings (across lines too) and backslash escapes
# keep theirs, and a backslash-newline joins two lines into one command. An
# unclosed quote keeps the rest as one command, which can only match more.
#
# The split goes line by line: matching a regex against the whole remainder
# at every separator made a 3000-line heredoc take 20s, past the hook's 5s
# timeout. guard_bash_probe.sh times three long commands.

NL=$'\n'
q="'"
esc='\\.'
dqs='"([^"\\]|\\.)*"'
sqs="${q}[^${q}]*${q}"
# The longest stretch of one line that stays inside one command.
seg_re="^([^;&|\"\\${q}]|${esc}|${dqs}|${sqs})*"
# The rest of an open quoted string, up to its closing quote. Regexes with a
# captured tail, never ${s%%"'"*}: bash 3.2 makes those quadratic.
dq_close='^([^"\\]|\\.)*"'
sq_close="^([^${q}]*)${q}(.*)\$"

# unquoted TEXT: sets bare to TEXT with each closed quoted string and each
# backslash escape replaced by a space. An unclosed quote and what follows it
# stay as written. Only used on short text: one line, or one command's words.
bare=""
unq_re="^([^\"${q}\\\\]*)(${esc}|${dqs}|${sqs})(.*)\$"
unquoted() {
  local s="$1"
  bare=""
  while [[ "$s" =~ $unq_re ]]; do
    bare="$bare${BASH_REMATCH[1]} "
    s="${BASH_REMATCH[${#BASH_REMATCH[@]}-1]}"
  done
  bare="$bare$s"
}

# Commands that run a string or their stdin as code: shells, eval, ssh, su,
# interpreters and container launchers. Their quoted arguments and heredoc
# bodies are code, so they are checked as written.
runner_re="(^|[^[:alnum:]_.-])(eval|ssh|su|watch|(ba|z|da|k|fi)?sh|python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|osascript|docker|podman|kubectl|nsenter|chroot)[\"${q}]?([[:space:]]|\$)"

# A heredoc's body is data when a command that only reads text takes it:
# `cat > notes.md <<'EOF'`, `git commit -F - <<EOF`, a commit message built
# with `$(cat <<'EOF' ...)`. Those bodies are dropped before the per-command
# checks. Every other body (sh, python3, an unknown command) is kept and
# checked line by line, and so is a reader's body when the line also pipes it
# to a runner (`cat <<EOF | sh`). The whole-command checks further down still
# read every line. `code` is the command with the data bodies taken out.
heredoc_re="(^|[^<])<<(-?)[[:space:]]*\\\\?[\"${q}]?([A-Za-z_][A-Za-z0-9_.-]*)"
# The command that takes the heredoc: the last command before `<<`, past any
# VAR=value assignments and sudo/env/command.
reader_re="([^;&|(\`]*)\$"
first_re="^[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|sudo|env|command)[[:space:]]+)*([^[:space:]]+)"
text_reader() {
  local w
  [[ "${1%%<<*}" =~ $reader_re ]] || return 1
  [[ "${BASH_REMATCH[1]}" =~ $first_re ]] || return 1
  w="${BASH_REMATCH[3]##*/}"
  case "$w" in
    cat | tee | git | gh | glab | grep | egrep | fgrep | rg | jq | yq | wc | sort | uniq | \
      head | tail | less | more | pbcopy | base64 | xxd | diff | patch | sed | awk | tr | \
      cut | column | fmt | fold | iconv | mail | curl) return 0 ;;
  esac
  return 1
}
code="$cmd"
as_written=""
drop_data_heredocs() {
  local line delim="" dash="" keep=() d
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -n "$delim" ]; then
      # Inside a data body: skip it, up to the line that ends it.
      if [ "$line" = "$delim" ] || { [ -n "$dash" ] && [[ "$line" =~ ^$'\t'*"$delim"$ ]]; }; then
        delim=""
        keep[${#keep[@]}]="$line"
      fi
      continue
    fi
    keep[${#keep[@]}]="$line"
    case "$line" in *"<<"*) ;; *) continue ;; esac
    # The << must be outside quotes, or it is only text (`echo "use <<EOF"`).
    unquoted "$line"
    case "$bare" in *"<<"*) ;; *) continue ;; esac
    [[ "$line" =~ $heredoc_re ]] || continue
    d="${BASH_REMATCH[3]}"
    dash="${BASH_REMATCH[2]}"
    if text_reader "$bare" && ! [[ "$bare" =~ $runner_re ]]; then
      delim="$d"
    else
      # A body some program may run: its lines are code in that program's
      # language, so no quoted text in this command is set aside.
      as_written=1
    fi
  done <<<"$cmd"
  local IFS=$'\n'
  code="${keep[*]-}"
}
case "$cmd" in *"<<"*) drop_data_heredocs ;; esac

segments=()
# The command being read: `held` keeps the lines it already spans (an array,
# joined once at its end: appending each line to one string was quadratic),
# `cur` the part on this line.
held=()
cur=""
emit() {
  local IFS=
  segments+=("${held[*]-}$cur")
  held=()
  cur=""
}
split_commands() {
  local line rest open="" m
  while IFS= read -r line || [ -n "$line" ]; do
    rest="$line"
    while :; do
      # Inside a quote opened on an earlier line: find where it closes.
      if [ "$open" = "$q" ]; then
        if [[ "$rest" =~ $sq_close ]]; then
          m="${BASH_REMATCH[1]}"; cur="$cur$m$q"; rest="${BASH_REMATCH[2]}"; open=""
        else
          held[${#held[@]}]="$cur$rest$NL"; cur=""; continue 2
        fi
      elif [ "$open" = '"' ]; then
        if [[ "$rest" =~ $dq_close ]]; then
          m="${BASH_REMATCH[0]}"; cur="$cur$m"; rest="${rest:${#m}}"; open=""
        else
          held[${#held[@]}]="$cur$rest$NL"; cur=""; continue 2
        fi
      fi
      [[ "$rest" =~ $seg_re ]]
      m="${BASH_REMATCH[0]}"
      cur="$cur$m"
      rest="${rest:${#m}}"
      case "$rest" in
        '') emit; continue 2 ;;
        [\;\&\|]*) emit ;;
        "$q"* | \"*) open="${rest:0:1}"; cur="$cur$open" ;;
        # The one thing left is a backslash ending the line: it joins the next.
        *) cur="$cur "; continue 2 ;;
      esac
      rest="${rest:1}"
    done
  done <<<"$code"
  [ -z "${held[*]-}$cur" ] || emit
}
case "$code" in
  *[\;\&\|]* | *"$NL"*) split_commands ;;
  *) segments=("$code") ;;
esac

# A shell word inside one simple command, and git's global options before the
# subcommand (`git -C repo push`, `git -c k=v clean`).
word="([^[:space:]\"\\${q}]|${esc}|${dqs}|${sqs})+"
gitopts="([[:space:]]+(-[Cc]|--git-dir|--work-tree|--namespace|--exec-path|--config-env)[[:space:]]+${word}|[[:space:]]+-${word})*[[:space:]]+"

gitpre="git${gitopts}"

# squash TEXT: sets squashed to TEXT with the whitespace taken out of every
# closed quoted string, quotes kept. Text inside quotes then holds no separate
# `git` or `rm` word, so `echo "git push -f"`, `grep "git reset --hard"` and
# `git commit -m "why git push --force is refused"` name a command without
# running it and go through, while every word outside quotes, and every
# quoted flag or refspec (`'+main:main'`, `"$HOME"`), reads as before. A
# double-quoted string holding $( ) or backticks runs code, so it stays as
# written.
squashed=""
squash() {
  local s="$1" pre m
  squashed=""
  while [[ "$s" =~ $unq_re ]]; do
    pre="${BASH_REMATCH[1]}"
    m="${BASH_REMATCH[2]}"
    s="${BASH_REMATCH[${#BASH_REMATCH[@]}-1]}"
    case "$m" in
      \"*'$('* | \"*'`'*) ;;
      \"* | "$q"*) m="${m//[[:space:]]/}" ;;
    esac
    squashed="$squashed$pre$m"
  done
  squashed="$squashed$s"
}

# has ARGS REGEX: ARGS holds a whole word matching REGEX, quoted or not, or
# the last word of a $( ) or ` `.
has() {
  local re="[[:space:]][\"${q}]?(${2})[\"${q}\`)]*([[:space:],;]|\$)"
  [[ "$1" =~ $re ]]
}

# after TEXT REGEX: sets args to what follows REGEX's first match in TEXT,
# with a leading space for has, or fails if nothing matches. The regex takes
# the tail itself: ${1#*"$match"} and ${1%%"$match"*} read the same, and each
# is quadratic in bash 3.2, minutes on a 6000-line command.
args=""
after() {
  local re="${2}(.*)\$"
  [[ "$1" =~ $re ]] || return 1
  args=" ${BASH_REMATCH[${#BASH_REMATCH[@]}-1]}"
}

# git_args SEGMENT SUBCOMMAND: sets args to the words after `git ... SUBCOMMAND`,
# or fails if SEGMENT runs no such git.
git_args() {
  after "$1" "${gitpre}(${2})([[:space:]]|\$)"
}

# Long options: git (parse-options) and GNU rm take any unambiguous prefix,
# so `--forc` is `--force`; each pattern takes the shortest prefix that is
# unambiguous and every longer one.

# A target that is the root, a home directory, the parent, or everything here,
# i.e. one with no name in it: `/`, `/*`, `/*/`, `~`, `~/`, `~bob`, `$HOME`,
# `${HOME}/*`, `..`, `../..`, `*`, `./*`, `.*`. `/tmp/x`, `~/proj/build` and
# `../sibling` name something, so they go through.
danger_target='(~[[:alnum:]_-]*|\$HOME|\$\{HOME\})[/.*]*|[/.*]+'
rm_re="(^|[^[:alnum:]_.-])rm[\"${q}]?([[:space:]]|\$)"

# The one force-push the guard can let through, and only when the person opts
# in: BASH_GUARD_FORCE_PUSH_BRANCHES holds an extended regex for branch names
# (for example `deploy-[0-9]+`; set it in the settings.json "env" block). With
# it unset or empty, every force-push is blocked. When it is set, a leased push
# to a matching branch passes if it is a plain `git push` with no global
# options, the lease names that branch and a full 40-hex sha, the remote is
# origin, and the pushed ref lands on the same branch. A bare lease, -f, a
# +refspec, a quoted sha, another branch or extra arguments are still blocked.
branch_re='[A-Za-z0-9_][A-Za-z0-9._/-]*'
leased_push_re="^[[:space:]]*git[[:space:]]+push[[:space:]]+--force-with-lease=(${branch_re}):[0-9a-f]{40}[[:space:]]+origin[[:space:]]+${branch_re}:(${branch_re})[[:space:]]*\$"
allowed_force_push() {
  local ok=1 allow="${BASH_GUARD_FORCE_PUSH_BRANCHES-}"
  [ -n "$allow" ] || return 1
  # Case matters here: the lease and the branch name are git refs.
  shopt -u nocasematch
  if [[ "$1" =~ $leased_push_re ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ]; then
    local dest="${BASH_REMATCH[2]}" full="^(${allow})\$"
    [[ "$dest" =~ $full ]] && ok=0
  fi
  shopt -s nocasematch
  return $ok
}

check_segment() {
  local seg="$1"
  # Quoted text goes out of the way unless the command runs it as code. A very
  # long command is checked as written: squashing it would be slow, and
  # checking it as written can only block more.
  if [ -z "$as_written" ] && [ "${#seg}" -le 20000 ]; then
    squash "$seg"
    [[ "$squashed" =~ $runner_re ]] || seg="$squashed"
  fi

  # rm -r on the root / home / parent / everything: recursive flag anywhere
  # among its words, joined (-rf, -Rfv) or split (-r -f), with or without -f.
  if after "$seg" "$rm_re"; then
    if has "$args" '-[[:alnum:]]*[rR][[:alnum:]]*|--r[a-z]*' && has "$args" "$danger_target"; then
      block "rm -rf at dangerous path"
    fi
  fi

  # force-push (any flavor): --force and its prefixes, --force-with-lease,
  # --force-if-includes, -f alone or joined (-fu), a +refspec, --mirror.
  if git_args "$seg" push &&
    has "$args" '--force[-[:alnum:]]*(=[^[:space:]]*)?|--mir[a-z]*|-[[:alnum:]]*f[[:alnum:]]*|\+[^[:space:]]*'; then
    allowed_force_push "$seg" || block "git push --force"
  fi

  # hard reset / destructive checkout that wipes uncommitted work
  if git_args "$seg" reset && has "$args" '--ha[a-z]*'; then
    block "git reset --hard"
  fi
  if git_args "$seg" checkout && has "$args" '--|\.|--f[a-z]*|-[[:alnum:]]*f[[:alnum:]]*'; then
    block "git checkout/restore -- (discards uncommitted changes)"
  fi
  if git_args "$seg" switch && has "$args" '--di[a-z-]*|--f[a-z]*|-[[:alnum:]]*f[[:alnum:]]*'; then
    block "git switch --discard-changes (discards uncommitted changes)"
  fi
  # restore writes the worktree unless it is told --staged (-S) alone; that
  # only unstages, so it goes through. Flag letters are case-sensitive here:
  # -s is --source. A separator in its words means an unclosed quote merged
  # commands into this one, and then no --staged here vouches for them.
  if git_args "$seg" restore; then
    shopt -u nocasematch
    if [[ "$args" == *[\;\&\|]* || "$args" == *"$NL"* ]] ||
      ! has "$args" '--st[a-z]*|-[pqm23]*S[pqm23S]*' ||
      has "$args" '--w[a-z]*|-[pqm23S]*W[pqm23SW]*|--no-st[a-z]*'; then
      shopt -s nocasematch
      block "git checkout/restore -- (discards uncommitted changes)"
    fi
    shopt -s nocasematch
  fi
  if git_args "$seg" clean &&
    { has "$args" '--f[a-z]*|-[[:alnum:]]*f[[:alnum:]]*' || [[ "$seg" =~ requireforce ]]; }; then
    block "git clean -f"
  fi
  # -D is force-delete and -d is the safe one, so case matters: -D (or
  # joined, -rD), or -d/--delete together with -f/--force.
  if git_args "$seg" branch; then
    shopt -u nocasematch
    if has "$args" '-[[:alpha:]]*D[[:alpha:]]*' ||
      { has "$args" '--d[a-z]*|-[[:alpha:]]*d[[:alpha:]]*' && has "$args" '--forc[a-z]*|-[[:alpha:]]*f[[:alpha:]]*'; }; then
      shopt -s nocasematch
      block "git branch -D (force-delete)"
    fi
    shopt -s nocasematch
  fi

  # commit -n is --no-verify. Only in commit: on merge -n is --no-stat, on
  # push it is --dry-run. Words inside quotes are the message, not flags.
  if git_args "$seg" commit; then
    shopt -u nocasematch
    unquoted "$args"
    if has " $bare" '-[aeiopqsvzS]*n[[:alnum:]]*'; then
      shopt -s nocasematch
      block "--no-verify / signing bypass (git commit -n)"
    fi
    shopt -s nocasematch
  fi
}

# Case-insensitive by default, as the guard always was: SQL needs it, and on
# macOS's case-insensitive disk `RM` and `GIT` run rm and git. The two checks
# above where a flag's case changes its meaning turn it off for themselves.
shopt -s nocasematch

for seg in "${segments[@]}"; do
  case "$seg" in *rm* | *git*) check_segment "$seg" ;; esac
done

# ---------------------------------------------------------------- whole command
#
# These look at the whole string on purpose: a pipe spans commands, and a
# bypass flag is refused even inside a heredoc or a commit message.

# bypass hooks / signing. git takes any unambiguous prefix of a long option
# (`--no-verif`); `--no-ver` alone is ambiguous with --no-verbose. A quote or
# backslash between the letters (`--no-"verify"`) is still the same flag.
# Also refused: pointing core.hooksPath anywhere for one command, setting it
# to anything but a usual hooks folder (an empty folder turns hooks off just
# as /dev/null does), husky's off switch, and turning commit signing off.
qb="[\"${q}\\\\]*"
spell() {
  local s="$1" out="" i
  for ((i = 0; i < ${#s}; i++)); do out="$out${s:i:1}$qb"; done
  printf '%s' "$out"
}
no_verify_re="$(spell '--no-veri')"
no_gpg_re="$(spell '--no-gpg')"
hookspath_one_re="-c[[:space:]]+[\"${q}]?core\\.hookspath="
# Setting a value: `core.hooksPath X` or `core.hooksPath=X`. Reading it, or
# --unset (back to .git/hooks), names no value.
hookspath_set_re="core\\.hookspath([[:space:]]+|=)[^[:space:];&|]"
hookspath_ok_re="core\\.hookspath([[:space:]]+|=)[\"${q}]?(\\./)?(\\.husky(/_)?|\\.githooks|githooks|\\.hooks|hooks|\\.git/hooks)/?[\"${q}]?([[:space:];&|]|\$)"
husky_re="(^|[^[:alnum:]_])(HUSKY=[\"${q}]?0|HUSKY_SKIP_HOOKS=[\"${q}]?(1|true))([^[:alnum:]_]|\$)"
gpgsign_re="commit\\.gpgsign[[:space:]=]+[\"${q}]?(false|no|off|0)"
if [[ "$cmd" =~ $no_verify_re || "$cmd" =~ $no_gpg_re || "$cmd" =~ $gpgsign_re ||
  "$cmd" =~ $hookspath_one_re || "$cmd" =~ $husky_re ]] ||
  { [[ "$cmd" =~ $hookspath_set_re ]] && ! [[ "$cmd" =~ $hookspath_ok_re ]]; }; then
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
