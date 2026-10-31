#!/bin/bash
# family-setup — the family and the cloud for the families + remote take.
# Run after setup.sh (it needs ROOT/home and ROOT/remote.git):
#
#   bash docs/demo/live/family-setup.sh [ROOT]
#
# Writes the three specs into ~ (the demo HOME): a parent, auth-revamp, that
# shares its state on the remote (`share: true`), and two workstreams that
# wait on its first increment. auth-api takes its go from the parent agent and
# runs in the "cloud"; auth-ui takes its go from a person, on the laptop.
#
# The cloud is simulated with a local repo: ROOT/cloud/shop is a fresh clone
# of ROOT/remote.git (the stand-in for GitHub), and its Claude runs with a
# HOME of its own and CLAUDE_CODE_REMOTE=true, so deep-plan treats it as a
# cloud session: state in the repo's .seamux/state, plans pulled from their
# seamux-state/<slug> branches. Nothing but the remote is shared with the laptop.
set -eu
ROOT=${1:-/private/tmp/seamux-demo}
H=$ROOT/home
SEAMUX=$ROOT/seamux
[ -d "$H" ] || { echo "family-setup: run setup.sh first" >&2; exit 2; }

python3 - "$H" "$SEAMUX/deep-plan" <<'PY'
import json, sys, copy
home, engine = sys.argv[1:]
base = json.load(open(f"{engine}/examples/example.spec.json"))
unit = {"kind": "test", "name": "unit suite", "run": "npm test -s"}
def child(slug, title, context, incs):
    s = copy.deepcopy(base)
    s["slug"], s["title"], s["context"] = slug, title, context
    s["deliverables"] = [dict(copy.deepcopy(base["deliverables"][0]), title=t, body=b, files=f, checks=[unit])
                         for t, b, f in incs]
    s["review"] = {"increments": "none", "delivery": False}
    return s
api = child("auth-api", "Serve sign-in from server sessions",
    "The API issues a server session on sign-in. Part of the auth-revamp family; this workstream runs in a cloud session.",
    [("POST /session", "Sign-in returns a session id and its expiry, using the shared session type.", ["api/auth/session.js", "test/session.test.js"]),
     ("Session expiry", "An expired session is refused with 401.", ["api/auth/expiry.js"])])
ui = child("auth-ui", "Sign in through the new session API",
    "The login form posts to /session and keeps the id it gets back. Part of the auth-revamp family.",
    [("Login form posts to /session", "The form sends the code and shows the error the API returns.", ["web/login/form.js"]),
     ("Signed-out banner", "A banner says when the session ran out.", ["web/login/banner.js"])])
fam = json.load(open(f"{engine}/examples/example.family.spec.json"))
fam["slug"], fam["share"] = "auth-revamp", True
fam["deliverables"][0].update(title="Shared session type", body="One session shape, used by the API and the web app.",
                              files=["shared/session.js"], checks=[unit])
fam["deliverables"][1]["checks"] = [unit]
fam["review"] = {"increments": "none", "delivery": False}
fam["workstreams"] = [
    {"slug": "auth-api", "owns": ["api/auth/**"], "contracts": ["POST /session"], "after": [1], "go": "parent"},
    {"slug": "auth-ui", "owns": ["web/login/**"], "consumes": ["POST /session"], "after": [1]},
]
for s in (api, ui, fam):
    json.dump(s, open(f"{home}/{s['slug']}.spec.json", "w"), indent=1)
PY

# The cloud: its own HOME (signed in through the same keychain), its clone
# made later by the take (once the workstream's branch is on the remote).
C=$ROOT/cloud
mkdir -p "$C/home/Library" "$C/home/.claude" "$C/bin"
ln -sfn "$HOME/Library/Keychains" "$C/home/Library/Keychains"
cp "$H/.claude.json" "$C/home/.claude.json"
python3 - "$C/home/.claude.json" "$C/shop" <<'PY'
import json, sys
f, shop = sys.argv[1:]; c = json.load(open(f))
c["projects"] = {shop: {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True}}
json.dump(c, open(f, "w"), indent=2)
PY
cat > "$C/home/.claude/settings.json" <<'EOF'
{ "theme": "dark", "spinnerTipsEnabled": false,
  "permissions": { "defaultMode": "acceptEdits",
    "allow": ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "Skill"] } }
EOF
NODE_BIN=$(dirname "$(node -p process.execPath)")
CLAUDE_BIN=$(command -v claude)
{
  echo '#!/bin/bash'
  echo '# A cloud session, simulated: another HOME, CLAUDE_CODE_REMOTE=true.'
  echo "export HOME=$C/home CLAUDE_CODE_REMOTE=true ENABLE_CLAUDEAI_MCP_SERVERS=false"
  echo "export PATH=$C/bin:$NODE_BIN:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  echo 'export GIT_AUTHOR_NAME="Sam Rivera" GIT_AUTHOR_EMAIL=sam@shop.example GIT_COMMITTER_NAME="Sam Rivera" GIT_COMMITTER_EMAIL=sam@shop.example'
  echo 'unset SEAMUX_PANE_ID SEAMUX_WORKSPACE_ID SEAMUX_BACKEND SEAMUX_BIN TMUX TMUX_PANE'
  echo "exec $CLAUDE_BIN --model sonnet --effort low --strict-mcp-config \\"
  for p in deep-plan lookout bash-guard; do echo "  --plugin-dir $SEAMUX/$p \\"; done
  echo '  "$@"'
} > "$C/bin/claude"
printf '#!/bin/bash\nexec %s/node %s/deep-plan/deep_plan.mjs "$@"\n' "$NODE_BIN" "$SEAMUX" > "$C/bin/deep-plan"
chmod +x "$C/bin/claude" "$C/bin/deep-plan"
printf 'PROMPT="%%F{245}cloud:%%~%%f %%F{208}❯%%f "\n' > "$C/home/.zshrc"
echo "family-setup: specs in $H, cloud in $C"
