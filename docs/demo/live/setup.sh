#!/bin/bash
# setup — a throwaway HOME for filming the seamux app with live Claude sessions.
#
#   bash docs/demo/live/setup.sh [ROOT]     build ROOT/home (default /private/tmp/seamux-demo)
#   bash docs/demo/live/app.sh   [ROOT]     then start the app on it
#
# The app, its tmux server, its intent server and every Claude it starts run
# with HOME=ROOT/home, so their state (~/.local/state/seamux, ~/.cache/cmux-crew,
# ~/.claude/deep-plan, ~/.claude/projects) is the demo's, never yours. The
# root has no user name in it, so the film shows ~/code/shop like any machine.
#
# Claude signs in through your login keychain (ROOT/home/Library/Keychains is
# a link to yours); nothing else of your HOME is read. Every session is
# Sonnet at low effort, loads the plugins from this checkout with
# --plugin-dir, and starts without Remote Control (CREW_REMOTE=0).
set -eu
ROOT=${1:-/private/tmp/seamux-demo}
CHECKOUT=$(cd "$(dirname "$0")/../../.." && pwd)
REAL_HOME=$HOME
H=$ROOT/home
[ -e "$H" ] && { echo "setup: $H exists; remove $ROOT first" >&2; exit 2; }
mkdir -p "$H/Library" "$H/.local/bin" "$H/.claude" "$H/code"
# The plugins run from a copy under ROOT: a hook's path is printed on screen
# (a refused edit names its gate.sh), and the checkout's has your user name.
SEAMUX=$ROOT/seamux
rsync -a --exclude .git --exclude node_modules --exclude app --exclude 'docs/demo/reel' "$CHECKOUT/" "$SEAMUX/"
ln -s "$REAL_HOME/Library/Keychains" "$H/Library/Keychains"

APPBIN=$REAL_HOME/Applications/seamux.app/Contents/Resources/bin/seamux
ln -s "$APPBIN" "$H/.local/bin/seamux"
# The real node, not a version manager's shim (asdf finds nothing under this HOME).
NODE_BIN=$(dirname "$(node -p process.execPath)")
CLAUDE_BIN=$(command -v claude)

# claude: Sonnet, low effort, this checkout's plugins.
{
  echo '#!/bin/bash'
  echo '# Your account'"'"'s claude.ai connectors stay out of the demo.'
  echo 'export ENABLE_CLAUDEAI_MCP_SERVERS=false'
  echo "exec $CLAUDE_BIN --model sonnet --effort low --strict-mcp-config \\"
  for p in deep-plan lookout crew bash-guard humanize restack; do echo "  --plugin-dir $SEAMUX/$p \\"; done
  echo '  "$@"'
} > "$H/.local/bin/claude"
chmod +x "$H/.local/bin/claude"
for t in deep-plan:deep-plan/deep_plan.mjs lookout:lookout/lookout.mjs restack:restack/restack.mjs; do
  printf '#!/bin/bash\nexec %s/node %s/%s "$@"\n' "$NODE_BIN" "$SEAMUX" "${t#*:}" > "$H/.local/bin/${t%%:*}"
  chmod +x "$H/.local/bin/${t%%:*}"
done

# The panes run `zsh -l`: give it a PATH with the wrapper first and a plain prompt.
cat > "$H/.zshenv" <<EOF
export PATH=$H/.local/bin:$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export GIT_AUTHOR_NAME="Sam Rivera" GIT_AUTHOR_EMAIL=sam@shop.example
export GIT_COMMITTER_NAME="Sam Rivera" GIT_COMMITTER_EMAIL=sam@shop.example
export SEAMUX_BIN=$APPBIN CREW_REMOTE=0
EOF
cat > "$H/.zprofile" <<EOF
export PATH=$H/.local/bin:$NODE_BIN:/opt/homebrew/bin:\$PATH
EOF
cat > "$H/.zshrc" <<'EOF'
PROMPT='%F{245}%~%f %F{208}❯%f '
EOF
printf '[user]\n\tname = Sam Rivera\n\temail = sam@shop.example\n[init]\n\tdefaultBranch = main\n' > "$H/.gitconfig"

# Claude: onboarding done, dark theme, the code folder trusted, edits and
# shell commands allowed (the deep-plan gate and bash-guard still refuse).
cat > "$H/.claude.json" <<EOF
{ "hasCompletedOnboarding": true, "theme": "dark", "numStartups": 5,
  "hasSeenTasksHint": true, "autoUpdates": false,
  "projects": {} }
EOF
# Notices you have already dismissed stay dismissed here (tips, upsells, the
# auto-mode offer): only these flags are copied, nothing about the account.
python3 - "$REAL_HOME/.claude.json" "$H/.claude.json" <<'PY'
import json, sys
src = json.load(open(sys.argv[1])); dst = json.load(open(sys.argv[2]))
for k in ["tipsHistory", "tipLifetimeShownCounts", "tipsHistoryByCommand", "seenNotifications", "lastReleaseNotesSeen",
          "hasResetAutoModeOptInForDefaultOffer", "hasSeenAutoDefaultNotice", "hasSeenAutoModeEntryWarning",
          "hasSeenAutoModeOutsideReadPrompt", "opusProMigrationComplete", "passesUpsellSeenCount",
          "pushNotifUpsellSeenCount", "rcLongTurnNudgeSeenCount", "rcPermissionNudgeSeenCount", "hasSeenTasksHint"]:
    if k in src: dst[k] = src[k]
# Claude Code offers auto mode as the default after a refused command.
dst["hasSeenAutoDefaultNudge"] = True; dst["hasSeenAutoDefaultNotice"] = True
json.dump(dst, open(sys.argv[2], "w"), indent=2)
PY
# Trust is per folder: every worktree the take opens, ahead of time.
python3 - "$H" "${DEMO_BRANCHES:-coupons checkout-errors release search-index smoke}" <<'PY'
import json, sys
h, names = sys.argv[1], sys.argv[2].split()
f = h + "/.claude.json"; c = json.load(open(f))
for p in [h + "/code", h + "/code/shop"] + [f"{h}/code/shop.worktrees/{n}" for n in names]:
    c["projects"][p] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}
json.dump(c, open(f, "w"), indent=2)
PY
cat > "$H/.claude/settings.json" <<EOF
{ "theme": "dark",
  "permissions": { "defaultMode": "acceptEdits",
    "allow": ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill", "WebFetch(domain:127.0.0.1)"] },
  "spinnerTipsEnabled": false }
EOF

# The shop: a repo under ~/code with a bare remote beside it.
cp -R "$SEAMUX/docs/demo/world/shop" "$H/code/shop"
git init -q --bare -b main "$ROOT/remote.git"
( cd "$H/code/shop" && HOME=$H git init -q -b main && HOME=$H git add -A &&
  HOME=$H git commit -q -m "shop: cart, totals, checkout" &&
  git remote add origin "$ROOT/remote.git" && HOME=$H git push -q origin main 2>/dev/null )
cp "$SEAMUX/docs/demo/world/demo-coupons.spec.json" "$SEAMUX/docs/demo/world/coupon-ask.json" "$H/"

# crew's live tree (the Dock's board page, the hooks' tools) under this HOME.
# It sets its own permission mode and phone pushes: put the demo's back.
( cd "$ROOT" && PATH="$H/.local/bin:$NODE_BIN:$PATH" HOME="$H" SEAMUX_BIN="$APPBIN" \
  bash "$SEAMUX/crew/bin/crew" apply >"$ROOT/crew-apply.log" 2>&1 ) || { echo "setup: crew apply failed, see $ROOT/crew-apply.log" >&2; exit 1; }
python3 - "$H/.claude/settings.json" <<'PY'
import json, sys
f = sys.argv[1]; s = json.load(open(f))
s["permissions"]["defaultMode"] = "acceptEdits"
s["agentPushNotifEnabled"] = False; s["inputNeededNotifEnabled"] = False
s.pop("statusLine", None)
json.dump(s, open(f, "w"), indent=2)
PY

echo "built $H"
