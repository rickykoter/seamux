#!/bin/bash
# answers — the quiz answers for a plan, as `q1=a q2=c …`, from its key.
#
#   bash docs/demo/live/answers.sh SLUG [ROOT]
#
# The take answers the alignment check the way a person who read the plan
# would: right. The key sits beside the plan state in the demo HOME.
set -eu
ROOT=${2:-/private/tmp/seamux-demo}
python3 - "$ROOT/home/.claude/deep-plan/keys/$1.key.json" <<'PY'
import json, sys
k = json.load(open(sys.argv[1]))
print(" ".join(f"{q}={a['letter']}" for q, a in k["answers"].items()))
PY
