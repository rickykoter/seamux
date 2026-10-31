#!/bin/bash
# system-one-setup — let lookout's System-1 risk score (TypeSafe's Jev) run
# in the demo world. Run after setup.sh and deep-dive-setup.sh:
#
#   bash docs/demo/live/system-one-setup.sh [ROOT]
#
# Links your TypeSafe key file into the demo HOME, where TypeSafe's client
# looks for it (~/.config/typesafe/api-key). It is a link, read when lookout
# scores a review; the key is never copied, printed or filmed. The shop's
# .seamux/lookout.json (from shop-web) sets sendContent, so Jev reads each
# file's changed lines: the demo shop's code, nothing of yours.
set -eu
ROOT=${1:-/private/tmp/seamux-demo}
H=$ROOT/home
KEY=${XDG_CONFIG_HOME:-$HOME/.config}/typesafe/api-key
[ -d "$H" ] || { echo "system-one-setup: run setup.sh first" >&2; exit 2; }
[ -s "$KEY" ] || { echo "system-one-setup: no TypeSafe key at $KEY; lookout will score from signals only" >&2; exit 2; }
mkdir -p "$H/.config/typesafe"
ln -sfn "$KEY" "$H/.config/typesafe/api-key"
echo "system-one-setup: lookout can ask Jev (key linked, not copied)"
