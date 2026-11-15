#!/bin/sh
# seamux-app's land check (plan landing): prints the merge commit once the
# running app was built from a commit that contains it, and nothing before.
# The app writes the commit it was built from to app-build.json at start
# (seamux-app build_stamp.rs); a wait step polls this until install.sh's
# restart has brought the new build up. A newer build (a later merge landed
# first) contains the merge too.
f="${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew/app-build.json"
[ -n "${MERGE_SHA:-}" ] && [ -f "$f" ] || exit 1
sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("sha", ""))' "$f" 2>/dev/null) || exit 1
sha=${sha%-dirty}
case "$sha" in "" | unknown) exit 1 ;; esac
git merge-base --is-ancestor "$MERGE_SHA" "$sha" 2>/dev/null && echo "$MERGE_SHA"
