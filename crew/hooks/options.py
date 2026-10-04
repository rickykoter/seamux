#!/usr/bin/env python3
"""Render the crew plugin's options into integrations.json.

    options.py [--from-settings [SETTINGS]] [--out PATH] [--get KEY]

The crew plugin's `userConfig` (set with `/plugin`, or `claude plugin configure
crew@seamux`) is where a person answers "which integrations does this machine
use". Eight readers already read ~/.config/cmux/crew/integrations.json and run
outside Claude, so this bridges one to the other rather than teaching them
Claude's settings format.

Two sources, one renderer:
    (default)          CLAUDE_PLUGIN_OPTION_<KEY>, as Claude hands the plugin's
                       hooks their options; crew-hook.sh calls this at SessionStart
    --from-settings    pluginConfigs["crew@<marketplace>"].options in settings.json,
                       for `crew apply` before any session has run

What it writes, keeping every other key of the file (typesafe.*, anything yours):
    jira_site                  -> jira = {enabled, site}           (blank: Jira off)
    github_issues              -> github_issues = {enabled}
    observability_stack        -> observability = {enabled, stack} (none: off)
and `managedBy`, so the file says where those three came from. main_repo is not
an integration; `--get main_repo` prints it for `crew apply` to bake.

Options left at their defaults on a file this has never written change nothing:
the answers the old installer recorded there stay until an option is set. Once
it has written the file, the options own those three keys, defaults included,
so clearing an option turns the integration off.

Writes only when the content changes (atomically), so a session start costs a
read. Exit 0 always for the hook's sake; problems go to stderr.
"""
import json
import os
import sys

KEYS = ("jira_site", "github_issues", "observability_stack", "main_repo")
STACKS = ("datadog", "splunk", "grafana")
MARK = "crew plugin options (crew/hooks/options.py)"


def from_env():
    out = {}
    for k in KEYS:
        v = os.environ.get("CLAUDE_PLUGIN_OPTION_" + k.upper())
        if v is not None:
            out[k] = v
    return out


def from_settings(path):
    try:
        with open(path, encoding="utf-8") as fh:
            s = json.load(fh) or {}
    except (OSError, ValueError):
        return {}
    for key, cfg in (s.get("pluginConfigs") or {}).items():
        if key.split("@")[0] == "crew" and isinstance(cfg, dict):
            return dict(cfg.get("options") or {})
    return {}


def truthy(v):
    return v is True or str(v).strip().lower() in ("true", "1", "yes", "on")


def is_default(opts):
    return (not str(opts.get("jira_site") or "").strip()
            and not truthy(opts.get("github_issues"))
            and str(opts.get("observability_stack") or "none").strip() not in STACKS)


def render(current, opts):
    """The integrations dict the options describe, from the current one."""
    cfg = dict(current)
    site = str(opts.get("jira_site") or "").strip()
    if site:
        cfg["jira"] = {"enabled": True, "site": site}
    else:
        cfg.pop("jira", None)
    if truthy(opts.get("github_issues")):
        cfg["github_issues"] = {"enabled": True}
    else:
        cfg.pop("github_issues", None)
    stack = str(opts.get("observability_stack") or "").strip()
    if stack in STACKS:
        cfg["observability"] = {"enabled": True, "stack": stack,
                                "note": "read-only for planning; keys come from env at read time"}
    else:
        cfg.pop("observability", None)
    cfg["managedBy"] = MARK
    return cfg


def main(argv):
    home = os.path.expanduser("~")
    live = os.environ.get("CREW_LIVE") or os.path.join(home, ".config", "cmux", "crew")
    out = os.path.join(live, "integrations.json")
    settings = None
    get = None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            out = argv[i + 1]; i += 2; continue
        if a == "--get":
            get = argv[i + 1]; i += 2; continue
        if a == "--from-settings":
            nxt = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("--") else None
            cfg_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")
            settings = nxt or os.path.join(cfg_dir, "settings.json")
            i += 2 if nxt else 1
            continue
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2

    opts = from_settings(settings) if settings else from_env()
    if get:
        v = opts.get(get)
        if v not in (None, ""):
            print(v)
        return 0
    if not opts:
        return 0

    try:
        with open(out, encoding="utf-8") as fh:
            text = fh.read()
        current = json.loads(text) if text.strip() else {}
    except FileNotFoundError:
        text, current = None, {}
    except (OSError, ValueError) as e:
        print(f"crew options: cannot read {out}: {e}; left as is", file=sys.stderr)
        return 0
    if not isinstance(current, dict):
        current = {}

    if is_default(opts) and current.get("managedBy") != MARK:
        return 0   # nothing chosen yet; the old installer's answers stand

    new = json.dumps(render(current, opts), indent=2) + "\n"
    if new == text:
        return 0
    try:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        tmp = f"{out}.tmp-{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(new)
        os.replace(tmp, out)
    except OSError as e:
        print(f"crew options: cannot write {out}: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
