#!/bin/bash
# family-stage — put the family's plans in place once the app's workspaces
# for the parent (auth-revamp) and auth-ui exist. Run by take-family.sh.
#
#   bash docs/demo/live/family-stage.sh [ROOT]
#
# The laptop renders and grades all three plans, as a person would after the
# planning conversation (each grade pushes its seamux-state/<slug> branch,
# since the parent shares). auth-api's worktree has no workspace here: that
# workstream runs in the cloud, a fresh clone of the remote on its branch,
# which pulls the plans the way a cloud session start does.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$HERE/lib.sh" "${1:-/private/tmp/seamux-demo}"
R=$DEMO_HOME/code/shop
T=$DEMO_HOME/code/shop.worktrees
C=$DEMO_ROOT/cloud
for b in auth-revamp auth-ui; do [ -d "$T/$b" ] || { echo "family-stage: no workspace for $b" >&2; exit 2; }; done
[ -d "$T/auth-api" ] || demo_env git -C "$R" worktree add -q -b dev/auth-api "$T/auth-api"
demo_env git -C "$R" push -q origin dev/auth-api

key() { python3 -c "import json;k=json.load(open('$DEMO_HOME/.claude/deep-plan/keys/$1.key.json'));print(' '.join(f'{q}={a[\"letter\"]}' for q,a in k['answers'].items()))"; }
for s in auth-api auth-ui auth-revamp; do
  demo_env bash -c "cd '$T/$s' && deep-plan render ~/$s.spec.json --root '$T/$s'" >/dev/null
done
for s in auth-api auth-ui auth-revamp; do
  demo_env bash -c "cd '$T/$s' && deep-plan grade $s $(key $s)" >/dev/null
done

# The cloud: a fresh clone on the workstream's branch. On one machine the
# laptop's root exists too, so name the clone as the root, as a real sandbox
# (where that path does not exist) settles on by itself.
rm -rf "$C/shop"
git clone -q -b dev/auth-api "$DEMO_ROOT/remote.git" "$C/shop"
( cd "$C/shop" && env HOME="$C/home" CLAUDE_CODE_REMOTE=true PATH="$C/bin:$PATH" bash -c \
  "deep-plan state pull --session >/dev/null && deep-plan state pull auth-api --root '$C/shop' >/dev/null" )
echo "family-stage: three plans graded; the cloud clone is at $C/shop"
