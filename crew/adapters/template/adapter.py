#!/usr/bin/env python3
"""A seamux adapter template: a working one, to copy and change.

seamux runs this with the session's context on stdin (seamux.context/1)
and reads one seamux.run/1 document from stdout. docs/adapters.md is the
guide and docs/RUNS.md the schema.

As it stands it reports each background task of a type in adapter.json's
`recognizes` as a run of one agent, from the hooks' entry alone. A real
adapter reads the orchestrator's own files under the context's
sessionDir (its state, its log, each agent's transcript) for labels,
phases, models, times, tokens and results. Change read_runs(); keep the
rest. Read files, never write them, and finish well inside the timeout.
"""
import json
import os
import sys

SCHEMA = "seamux.run/1"
# The task types this adapter reads: keep in step with adapter.json.
RECOGNIZES = ("teammate",)


def read_runs(ctx):
    """The session's runs, as seamux.run/1 run objects."""
    runs = []
    for task in ctx.get("background", []):
        if task.get("kind") not in RECOGNIZES:
            continue
        # Look for this task's files here: os.path.join(ctx["sessionDir"], ...).
        runs.append({
            "id": task["id"],
            "kind": "agent",
            "name": task.get("label") or task["id"],
            "task": task["id"],          # ties the run to the pane's background list
            "status": "running",         # running, done, failed, cancelled or unknown
            "start": task.get("at"),     # ms since the epoch
            "agents": [{
                "id": task["id"],
                "label": task.get("label") or task["id"],
                "state": "running",      # queued, running, done, failed or cancelled
                "start": task.get("at"),
                # "model": "claude-sonnet-5-5",
                # "phase": "Review",
                # "tokens": 12345,
                # "result": {"badge": "7", "detail": "what it found"},
                # "transcript": "/absolute/path/under/~/.claude/projects/agent.jsonl",
            }],
        })
    return runs


def main():
    ctx = json.load(sys.stdin)
    if not os.path.isdir(ctx.get("sessionDir", "")):
        runs = []
    else:
        runs = read_runs(ctx)
    json.dump({"schema": SCHEMA, "runs": runs}, sys.stdout)


if __name__ == "__main__":
    main()
