#!/usr/bin/env bash
# install.sh — seamux: the crew Dock, its cmux tie-ins, and the deep-plan skill.
#
#   ./install.sh [--main-repo PATH] [--dry-run] [--check] [--force]
#                [--no-apply] [--no-claude-settings] [--no-crew]
#                [--no-deep-plan] [--no-mermaid] [--force-mermaid]
#                [--uninstall] [--with-jira[=SITE]] [--with-github-issues]
#                [--with-observability=STACK] [--no-integrations]
#
# The repo is the source of truth: running this syncs repo -> machine
# (~/.config/cmux/crew, ~/.claude/skills/deep-plan, statusline, hooks) and then
# hands over to `crew apply`. Safe to re-run; an existing crew install is moved
# aside first. `--check` reports drift between the repo and the live install
# without changing anything — run it before reinstalling if you edited live files.

set -uo pipefail

HERE="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.config/cmux/crew"
SKILL="$HOME/.claude/skills/deep-plan"
SHIM="$HOME/.local/bin/deep-plan"
MERMAID_VERSION="11.17.2"
MERMAID_SHA256="581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8"

DRY=0 APPLY=1 SETTINGS=1 CREW=1 DEEPPLAN=1 MERMAID=1 FORCE_MERMAID=0 CHECK=0 FORCE=0 UNINSTALL=0 MAIN=""
WITH_JIRA="" JIRA_SITE="" WITH_GHI="" WITH_OBS="" OBS_STACK="" NO_INTEG=0

while [ $# -gt 0 ]; do
  case "$1" in
    --main-repo) MAIN="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --check) CHECK=1; shift ;;
    --force) FORCE=1; shift ;;
    --no-apply) APPLY=0; shift ;;
    --no-claude-settings) SETTINGS=0; shift ;;
    --no-crew) CREW=0; shift ;;
    --no-deep-plan) DEEPPLAN=0; shift ;;
    --no-mermaid) MERMAID=0; shift ;;
    --force-mermaid) FORCE_MERMAID=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --with-jira) WITH_JIRA=1; shift ;;
    --with-jira=*) WITH_JIRA=1; JIRA_SITE="${1#--with-jira=}"; shift ;;
    --with-github-issues) WITH_GHI=1; shift ;;
    --with-observability=*) WITH_OBS=1; OBS_STACK="${1#--with-observability=}"; shift ;;
    --no-integrations) NO_INTEG=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '  \033[2m+ %s\033[0m\n' "$*"; else eval "$@"; fi; }

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

# ---------------------------------------------------------------- main repo
# Several helpers default to "the repo this fleet of worktrees belongs to".
# The repo ships that as __MAIN_REPO__. Resolution order: --main-repo, the
# path already baked into an existing install (zero-arg re-runs), a single
# repo under ~/code, else an interactive picker.
resolve_main() {
  [ -n "$MAIN" ] && return 0
  if [ -x "$DEST/bin/crew" ]; then
    MAIN="$(sed -n 's/^MONOLITH="\${CREW_MONOLITH:-\(.*\)}"$/\1/p' "$DEST/bin/crew" | head -1)"
    if [ -n "$MAIN" ] && [ "$MAIN" != "__MAIN_REPO__" ]; then
      ok "main repo (from the existing install): $MAIN"; return 0
    fi
    MAIN=""
  fi
  cands="$(find "$HOME/code" -maxdepth 2 -name .git -print 2>/dev/null \
           | sed 's|/\.git$||' | grep -v '\.worktrees/' | sort)"
  n="$(printf '%s\n' "$cands" | grep -c . )"
  if [ "$n" = 1 ]; then
    MAIN="$cands"; ok "main repo auto-detected: $MAIN"; return 0
  fi
  if [ "$n" = 0 ]; then
    die "no git repos under ~/code — pass --main-repo PATH"
  fi
  if [ ! -t 0 ]; then
    printf '%s\n' "$cands" >&2
    die "found $n candidates (above) — pass --main-repo PATH"
  fi
  say "which repo do your worktrees come from? (crew-worktree lists all repos"
  say "either way; this only sets the default)"
  i=0
  printf '%s\n' "$cands" | while read -r c; do i=$((i+1)); printf '   %2d) %s\n' "$i" "$c"; done
  printf '  choice [1-%s]: ' "$n"; read -r pick
  MAIN="$(printf '%s\n' "$cands" | sed -n "${pick}p")"
  [ -n "$MAIN" ] || die "no such choice"
  ok "main repo: $MAIN"
}

# ---------------------------------------------------------------- drift check
# Compares the repo against the live install. The files that bake __MAIN_REPO__
# are compared after reverse-substituting the live path back to the placeholder.
drift_check() {
  resolve_main
  rc=0
  check_pair() { # repo_file live_file [bake]
    r="$1"; l="$2"; bake="${3:-}"
    if [ ! -e "$l" ]; then say "repo-only: ${r#$HERE/} (will be installed)"; return; fi
    if [ -n "$bake" ]; then
      if ! diff -q "$r" <(sed "s|$MAIN|__MAIN_REPO__|g" "$l") >/dev/null; then
        warn "differs: ${r#$HERE/}  (live: $l)"; rc=1
      fi
    elif ! diff -q "$r" "$l" >/dev/null; then
      warn "differs: ${r#$HERE/}  (live: $l)"; rc=1
    fi
  }
  BAKED="bin/crew bin/crew-worktree bin/crew-sandbox bin/crew-reclaim bin/crew-digest"
  while IFS= read -r f; do
    rel="${f#$HERE/crew/}"
    case " $BAKED " in *" $rel "*) check_pair "$f" "$DEST/$rel" bake ;;
                       *) check_pair "$f" "$DEST/$rel" ;; esac
  done < <(find "$HERE/crew" -type f ! -path '*__pycache__*' ! -name '.DS_Store')
  while IFS= read -r f; do
    rel="${f#$HERE/deep-plan/}"
    case "$rel" in vendor/*) continue ;; esac
    check_pair "$f" "$SKILL/$rel"
  done < <(find "$HERE/deep-plan" -type f ! -name '.gitkeep' ! -name '.DS_Store')
  check_pair "$HERE/claude/statusline.py" "$HOME/.claude/statusline.py"
  check_pair "$HERE/claude/hooks/guard_bash.sh" "$HOME/.claude/hooks/cmux/guard_bash.sh"
  check_pair "$HERE/bin/deep-plan.shim" "$SHIM"
  # live-only files under the crew tree (informational)
  if [ -d "$DEST" ]; then
    while IFS= read -r f; do
      rel="${f#$DEST/}"
      case "$rel" in .seamux-source|integrations.json) continue ;; esac  # install-time state, never in the repo
      [ -e "$HERE/crew/$rel" ] || [ -e "$HERE/docs/$(basename "$rel")" ] || say "live-only: crew/$rel"
    done < <(find "$DEST" -type f ! -path '*__pycache__*' ! -name '*.pyc' ! -name '.DS_Store')
  fi
  if [ "$rc" = 0 ]; then ok "no drift — repo and live install match"
  else warn "drift found: copy live edits back into the repo (reverse-substitute"
       warn "\$MAIN -> __MAIN_REPO__ in the five baked bin files), commit, reinstall."
  fi
  return $rc
}

printf '\n\033[1mseamux install\033[0m  %s\n\n' "$([ "$DRY" = 1 ] && echo '(dry run)')"

if [ "$CHECK" = 1 ]; then drift_check; exit $?; fi

# ---------------------------------------------------------------- uninstall
# The exit door, in dependency order: unwire cmux first (crew uninstall
# restores the pre-crew cmux.json and Claude hooks), then remove what this
# script placed. Deliberately left behind: guard_bash.sh (a safety rail
# outlives its installer), plan state/keys under ~/.claude/deep-plan and
# ~/.claude/plans (user work), and the crew backups.
if [ "$UNINSTALL" = 1 ]; then
  if [ -x "$DEST/bin/crew" ]; then
    run "'$DEST/bin/crew' uninstall" || warn "crew uninstall failed — continuing"
  fi
  if [ -d "$DEST" ]; then
    BAK="$HOME/.config/cmux/crew-backups/crew.uninstalled.$(date +%Y%m%d-%H%M%S)"
    run "mkdir -p '$(dirname "$BAK")' && mv '$DEST' '$BAK'"
    ok "crew tree moved aside -> ${BAK/#$HOME/~} (delete it when sure)"
  fi
  [ -d "$SKILL" ] && { run "rm -rf '$SKILL'"; ok "removed the deep-plan skill"; }
  [ -f "$SHIM" ]  && { run "rm -f '$SHIM'";   ok "removed the deep-plan shim"; }
  run "python3 '$HERE/claude/merge_settings.py' --remove$([ "$DRY" = 1 ] && echo ' --dry-run')"
  say "kept: guard_bash.sh, ~/.claude/deep-plan (state/keys), ~/.claude/plans, statusline backups"
  exit 0
fi

# ---------------------------------------------------------------- preflight
[ "$(uname -s)" = "Darwin" ] || warn "not macOS — cmux, the sidebar and the VS Code hand-off are mac-only"
command -v python3 >/dev/null || die "python3 is required (the board, the triage hook and the frame are Python)"
command -v node    >/dev/null || die "node is required (the board renderer, the probes and deep-plan)"
CMUX="$(command -v cmux || true)"
[ -n "$CMUX" ] || CMUX="$("$HERE/crew/bin/crew-cmux-bin" 2>/dev/null || true)"
if [ -n "$CMUX" ]; then ok "cmux at $CMUX"; else warn "cmux not found — the files install, but nothing will drive them"; fi
if command -v gh >/dev/null; then ok "gh present (PR chips, checks)"; else warn "no gh — PR and check chips stay blank"; fi
if command -v ccusage >/dev/null; then ok "ccusage present (usage windows)"; else warn "no ccusage — the status line says so (npm i -g ccusage)"; fi

resolve_main
[ -d "$MAIN/.git" ] || warn "$MAIN is not a git checkout — the Dock and sandbox steps will skip"

# Warn on drift before overwriting live edits.
if [ "$CREW" = 1 ] && [ -d "$DEST" ] && [ "$FORCE" = 0 ]; then
  if ! drift_check >/dev/null 2>&1; then
    warn "the live install differs from this repo — those edits are about to be"
    warn "replaced (a backup is kept). Run ./install.sh --check to see them, or"
    warn "--force to skip this warning."
    if [ -t 0 ] && [ "$DRY" = 0 ]; then
      printf '  continue? [y/N] '; read -r a
      case "$a" in y|Y) ;; *) die "stopped — nothing changed" ;; esac
    fi
  fi
fi

# ---------------------------------------------------------------- crew layer
if [ "$CREW" = 1 ]; then
  # Integration answers survive the move-aside below: captured here, decided
  # (flags > prompts > prior answers > absent) and rewritten after the copy.
  PREV_INTEG="$(cat "$DEST/integrations.json" 2>/dev/null || true)"
  if [ -d "$DEST" ]; then
    BAK="$HOME/.config/cmux/crew-backups/crew.$(date +%Y%m%d-%H%M%S)"
    run "mkdir -p '$(dirname "$BAK")' && mv '$DEST' '$BAK'"
    ok "moved the existing install aside -> ${BAK/#$HOME/~}"
  fi
  run "mkdir -p '$DEST'"
  run "cp -R '$HERE/crew/.' '$DEST/'"
  ok "copied crew -> ${DEST/#$HOME/~}"

  # Provenance marker: `crew doctor` reads this to find the repo and run the
  # drift check automatically. Not a repo file — written at install time.
  run "printf '%s\n' '$HERE' > '$DEST/.seamux-source'"
  ok "recorded the source repo -> $DEST/.seamux-source"

  # ------------------------------------------------------------ integrations
  # Which trackers does this machine use? Flags win; else an interactive first
  # run asks; else prior answers carry over; else absent (= all disabled —
  # doctor prints one quiet line per integration instead of nagging).
  if [ "$DRY" = 0 ]; then
    if [ "$NO_INTEG" = 1 ]; then
      printf '{}\n' > "$DEST/integrations.json"
      ok "integrations: all off (--no-integrations)"
    elif [ -n "$WITH_JIRA" ] || [ -n "$WITH_GHI" ] || [ -n "$WITH_OBS" ]; then
      python3 - "$DEST/integrations.json" "$WITH_JIRA" "$JIRA_SITE" "$WITH_GHI" "$PREV_INTEG" "$WITH_OBS" "$OBS_STACK" <<'PY'
import json, sys
path, jira, site, ghi, prev, obs, stack = sys.argv[1:8]
try: cfg = json.loads(prev) if prev.strip() else {}
except ValueError: cfg = {}
if jira: cfg["jira"] = {"enabled": True, **({"site": site} if site else
                        {k: v for k, v in (cfg.get("jira") or {}).items() if k == "site"})}
if ghi: cfg["github_issues"] = {"enabled": True}
if obs: cfg["observability"] = {"enabled": True, "stack": stack,
                                "note": "read-only for planning; keys come from env at read time"}
json.dump(cfg, open(path, "w"), indent=2)
PY
      ok "integrations recorded -> $DEST/integrations.json"
    elif [ -n "$PREV_INTEG" ]; then
      printf '%s\n' "$PREV_INTEG" > "$DEST/integrations.json"
      ok "integrations: kept prior answers"
    elif [ -t 0 ]; then
      say "which integrations does this machine use? (Enter skips; rerun"
      say "./install.sh --with-jira=SITE / --with-github-issues to change later)"
      printf '  Jira via acli? [y/N] '; read -r a
      case "$a" in y|Y)
        printf '  Jira site (e.g. yourco.atlassian.net, blank to skip links): '; read -r JIRA_SITE
        WITH_JIRA=1 ;;
      esac
      printf '  Link GitHub issues on board rows? [y/N] '; read -r a
      case "$a" in y|Y) WITH_GHI=1 ;; esac
      if [ -n "$WITH_JIRA" ] || [ -n "$WITH_GHI" ]; then
        python3 - "$DEST/integrations.json" "$WITH_JIRA" "$JIRA_SITE" "$WITH_GHI" "" <<'PY'
import json, sys
path, jira, site, ghi, _ = sys.argv[1:6]
cfg = {}
if jira: cfg["jira"] = {"enabled": True, **({"site": site} if site else {})}
if ghi: cfg["github_issues"] = {"enabled": True}
json.dump(cfg, open(path, "w"), indent=2)
PY
        ok "integrations recorded -> $DEST/integrations.json"
      else
        say "integrations: none — doctor stays quiet about them"
      fi
    fi
  fi

  # Substitute in the installed copy only: the repo stays a clean template.
  if [ "$DRY" = 0 ]; then
    grep -rl '__MAIN_REPO__' "$DEST" 2>/dev/null | while read -r f; do
      python3 - "$f" "$MAIN" <<'PY'
import io, sys
p, main = sys.argv[1], sys.argv[2]
t = io.open(p, encoding="utf-8").read()
io.open(p, "w", encoding="utf-8").write(t.replace("__MAIN_REPO__", main))
PY
    done
    # __HOME__ is NOT substituted here: `crew apply` renders it out of the
    # config templates at apply time, which is how the layer has always worked.
    left="$(grep -rl '__MAIN_REPO__' "$DEST" 2>/dev/null | wc -l | tr -d ' ')"
    [ "$left" = 0 ] || die "$left file(s) still carry __MAIN_REPO__"
    ok "substituted __MAIN_REPO__ -> $MAIN"
    chmod +x "$DEST"/bin/* "$DEST"/board/crew-board "$DEST"/board/crew-board-diag \
             "$DEST"/board/crew-board-intent "$DEST"/hooks/*.sh "$DEST"/hooks/*.py 2>/dev/null
    ok "made the commands executable"
  fi
fi

# ---------------------------------------------------------------- status line
if [ -f "$HERE/claude/statusline.py" ]; then
  if [ -f "$HOME/.claude/statusline.py" ] && ! diff -q "$HERE/claude/statusline.py" "$HOME/.claude/statusline.py" >/dev/null; then
    run "cp '$HOME/.claude/statusline.py' '$HOME/.claude/statusline.py.pre-seamux.bak'"
    warn "kept your statusline.py as statusline.py.pre-seamux.bak"
  fi
  run "mkdir -p '$HOME/.claude'"
  run "cp '$HERE/claude/statusline.py' '$HOME/.claude/statusline.py'"
  ok "installed statusline.py"
fi

# ---------------------------------------------------------------- the guard
# `crew doctor` requires it and crew deliberately does not own it (disabling
# crew must never disable the destructive-command guard). An existing one is
# never overwritten: it is a safety rail, and it may carry local rules.
GUARD="$HOME/.claude/hooks/cmux/guard_bash.sh"
if [ -f "$HERE/claude/hooks/guard_bash.sh" ]; then
  if [ -f "$GUARD" ]; then
    ok "keeping the guard_bash.sh already on this machine"
  else
    run "mkdir -p '$(dirname "$GUARD")'"
    run "cp '$HERE/claude/hooks/guard_bash.sh' '$GUARD'"
    run "chmod +x '$GUARD'"
    ok "installed guard_bash.sh (blocks force pushes, recursive deletes, hook bypasses)"
  fi
fi

# ---------------------------------------------------------------- deep-plan
if [ "$DEEPPLAN" = 1 ]; then
  printf '\n\033[1mdeep-plan\033[0m\n'
  run "mkdir -p '$SKILL'"
  # No --delete on purpose: the user's vendor/mermaid.min.js (and anything else
  # they added) survives; state and keys live outside the skill dir anyway.
  run "rsync -a --exclude 'vendor/' --exclude '.gitkeep' '$HERE/deep-plan/' '$SKILL/'"
  run "mkdir -p '$SKILL/vendor'"
  run "chmod +x '$SKILL/hooks/gate.sh'"
  ok "copied the skill -> ${SKILL/#$HOME/~}"
  run "mkdir -p '$HOME/.local/bin'"
  run "cp '$HERE/bin/deep-plan.shim' '$SHIM' && chmod +x '$SHIM'"
  ok "installed the deep-plan shim -> ${SHIM/#$HOME/~}"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "~/.local/bin is not on PATH — add it or call the skill by full path" ;; esac

  if [ "$MERMAID" = 1 ] && [ "$DRY" = 0 ]; then
    MJS="$SKILL/vendor/mermaid.min.js"
    if [ -f "$MJS" ] && [ "$FORCE_MERMAID" = 0 ]; then
      if [ "$(sha256 "$MJS")" = "$MERMAID_SHA256" ]; then
        ok "mermaid $MERMAID_VERSION already in place (sha256 verified)"
      else
        warn "vendor/mermaid.min.js present but not the pinned $MERMAID_VERSION — keeping it (--force-mermaid to refetch)"
      fi
    else
      TMP="$(mktemp)"
      if curl -fsSL "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js" -o "$TMP"; then
        if [ "$(sha256 "$TMP")" = "$MERMAID_SHA256" ]; then
          mv "$TMP" "$MJS"; ok "fetched mermaid $MERMAID_VERSION (sha256 verified)"
        else
          rm -f "$TMP"; die "mermaid download failed the sha256 check — not installing it"
        fi
      else
        rm -f "$TMP"
        warn "could not fetch mermaid — plan diagrams degrade and the probe will fail until it exists"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- hand over
if [ "$CREW" = 1 ] && [ "$APPLY" = 1 ]; then
  printf '\n'
  run "CREW_MONOLITH='$MAIN' '$DEST/bin/crew' apply"
elif [ "$CREW" = 1 ]; then
  say "skipped \`crew apply\` — run it yourself: $DEST/bin/crew apply"
fi

if [ "$SETTINGS" = 1 ]; then
  printf '\n\033[1mClaude settings\033[0m\n'
  run "python3 '$HERE/claude/merge_settings.py'$([ "$DRY" = 1 ] && echo ' --dry-run')"
fi

printf '\n\033[1mnext\033[0m\n'
say "crew doctor                              # must be green"
say "node $DEST/board/board_probe.mjs"
say "node $SKILL/probe.mjs                    # must be all green"
say "./install.sh --check                     # should report no drift"
printf '\n'
