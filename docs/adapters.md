# Writing a seamux adapter

seamux shows a session's background work as rows on its Dock card and as a
run page beside the terminal. It reads that work through adapters. Two ship
built in, for Claude Code's own sub-agents and workflows. Any other
orchestrator, or a newer Claude Code layout, needs an adapter: a small
program that reads the orchestrator's files and prints what it found in
seamux's run model. [RUNS.md](RUNS.md) is the schema and the protocol; this
page is how to write one.

## When seamux asks for one

When a session runs background work that no adapter reads, its card shows a
notice row: "2 background tasks from teammate: no adapter". When an adapter
fails, the row says how: "adapter mine failed: runs[0].status: "sleeping"
is not one of running, done, failed, cancelled, unknown".

The row's **Create adapter** (or **Fix adapter**) button opens a new Claude
session in that workspace's worktree. Its prompt names this guide and the
template, and carries a sample of what there is to read: the background task
entries Claude Code's hooks listed, and a listing of the session's folder.
That session can write the adapter. You can also write one by hand, as
below.

## Start from the template

`crew/adapters/template` is a working adapter in Python. Copy it into your
adapters folder under the name you want:

```bash
mkdir -p ~/.config/seamux/adapters
cp -R ~/.config/cmux/crew/adapters/template ~/.config/seamux/adapters/my-orchestrator
```

(`~/.config/cmux/crew` is crew's live copy; the same files are in the
seamux checkout at `crew/adapters/template`.)

Then edit two things.

1. In `adapter.json`, set `name` (unique among your adapters, and not
   `claude-subagents` or `claude-workflow`) and `recognizes`, the Claude Code
   background task types it reads, as the notice names them.
2. In `adapter.py`, change `read_runs()` to read the orchestrator's files
   under the context's `sessionDir`. As it ships, it reports each
   recognized background task as a run of one agent, from the hooks' entry
   alone.

The program can be in any language. `command` in the manifest is the
argument list seamux runs, in the adapter's own folder.

## What the program gets and gives

It reads one JSON object from stdin, the context:

```json
{"schema": "seamux.context/1", "session": "<id>", "sessionDir": "/…/.claude/projects/<project>/<id>",
 "transcript": "/…/<id>.jsonl", "cwd": "/w/repo",
 "background": [{"kind": "teammate", "id": "t1", "label": "helper", "at": 1794147717000}]}
```

It prints one JSON document to stdout and exits 0:

```json
{"schema": "seamux.run/1", "runs": [{"id": "t1", "name": "helper", "task": "t1", "status": "running",
  "agents": [{"id": "t1", "state": "running", "start": 1794147717000}]}]}
```

A run needs `id` and `status`; an agent needs `id` and `state`. Fill in
whatever the orchestrator's files record: labels, phases, models, start and end times
(milliseconds since the epoch), tokens, and a `result` with a short `badge`
and a longer `detail`. Set `task` to the background task's id when you know
it, so the card ties the run to its pane. Give each agent's `transcript` as
an absolute path under `~/.claude/projects` when there is one: the
transcript page serves nothing else.

## Check it

```bash
seamux runs <session-id> --all
```

prints every adapter's runs for the session, and a notice for any that
failed. A failure names the first thing wrong: the exit code and the first
line of stderr, a timeout, output that is not JSON, or the field that did
not validate. The card and the run page show the same notice.

## Rules of thumb

- **Read, never write.** The files belong to the orchestrator.
- **Be quick.** The default timeout is 3 seconds, and the most a manifest
  can ask for is 10. seamux runs an adapter again only when a file under the
  session's folder or the adapter's own folder changes, and at most every 2
  seconds.
- **Report what you know.** A missing field is filled with a default; a
  wrong one fails the whole document. When you can only read part of a run,
  say so in the run's `notice`.
- **Keep runs few.** seamux keeps the first 50 runs and the first 500 agents
  of each. Report the newest first.
