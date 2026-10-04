"""Where the deep-plan engine is, for crew's processes that run outside Claude.

The board, the intent server and the triage hook run with the cmux app's
environment, so they cannot see CLAUDE_PLUGIN_ROOT. The deep-plan plugin keeps
~/.claude/deep-plan/engine.json pointing at its root ({root, version,
mermaid?}); this module reads it. Resolution, first that exists:

    $DEEP_PLAN_ENGINE  ->  engine.json's root  ->  ~/.claude/skills/deep-plan

Read on every call, never cached: the intent server is long-lived, and a
plugin update moves the root under it.
"""

import json
import os

HOME = os.path.expanduser("~")
DATA = os.path.join(HOME, ".claude", "deep-plan")
POINTER = os.path.join(DATA, "engine.json")
LEGACY = os.path.join(HOME, ".claude", "skills", "deep-plan")


def _pointer():
    try:
        with open(POINTER, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def root():
    """The engine's directory (the one holding deep_plan.mjs)."""
    for r in (os.environ.get("DEEP_PLAN_ENGINE"), _pointer().get("root")):
        if r and os.path.isfile(os.path.join(r, "deep_plan.mjs")):
            return r
    return LEGACY


def script():
    """deep_plan.mjs, to run as `node <script> <verb> ...`."""
    return os.path.join(root(), "deep_plan.mjs")


def mermaid():
    """The pinned mermaid bundle the intent server serves, or the data-tree
    path where `deep-plan setup` puts it when no copy exists anywhere yet."""
    home = os.path.join(DATA, "vendor", "mermaid.min.js")
    for p in (_pointer().get("mermaid"), home,
              os.path.join(root(), "vendor", "mermaid.min.js"),
              os.path.join(LEGACY, "vendor", "mermaid.min.js")):
        if p and os.path.isfile(p):
            return p
    return home
