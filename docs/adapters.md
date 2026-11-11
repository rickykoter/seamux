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
fails, or a folder's manifest cannot be read, the row says how: "adapter mine failed: runs[0].status: "sleeping"
is not one of running, done, failed, cancelled, unknown".

The row's **Create adapter** (or **Fix adapter**) button opens a new Claude
session in that workspace's worktree. Its prompt names this guide and the
template, and carries a sample of what there is to read: the background task
entries Claude Code's hooks listed, and a listing of the session's folder.
That session can write the adapter. You can also write one by hand, as
below.

## Start from the template

`crew/adapters/template` is a working adapter in Python.
`crew/adapters/lookout` and `crew/adapters/explore` are fuller ones: the
first gives lookout reviewers their findings as a result, the second gives
Explore agents what they read and cited. Copy it into your
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

## Taking over a Claude Code sub-agent's run

An adapter can add to a run another adapter reports. When two adapters
report a run with the same id, the later one's run takes its place: the
built-ins load first, then crew's bundled adapters in folder-name order,
then yours. So an adapter that recognizes `subagent` and reports a run with
a sub-agent's id (its agent id, which is also its background task's id)
replaces that sub-agent's plain row with a richer one. A run you do not
report stays the built-in's.

`crew/adapters/explore` does this for Claude Code's Explore agents, and is
the example to read. For each background sub-agent whose meta file says
`"agentType": "Explore"`, it reads the agent's transcript and reports:

- `result.badge`: how many distinct files the agent's answer cites
  ("14 files");
- `metrics`: files read, searches run (Grep, Glob, or a `grep`, `rg` or
  `find` in Bash) and citations;
- `links`: the cited files, most cited first, each at its first cited line,
  which the session page opens in VS Code when they are in the session's
  worktree;
- `result.detail`: the answer's opening lines.

It finds the answer in the agent's `SubagentHandback` call, and a short
citation such as `rank.rs:470` is matched to a file the agent read. The
transcript reading it shares with other adapters lives in
`crew/adapters/lib/claude_agent.py`; a folder with no `adapter.json` is not
an adapter, so seamux skips it.

`crew/adapters/lookout` uses the same fields for lookout reviewers: its
findings by severity as `metrics`, the review page as a `url` link, and a
document `summary` with what is still open across the session's reviews.

`crew/adapters/scout` builds on it for deep-plan's scouts: it sets its own
`group` (the plan the scouts worked for, so they sit together on the
session page) and a document `summary`, and it loads after explore, so its
run replaces the Explore adapter's for a scout of type Explore. Order by
folder name is how one bundled adapter wins over another.

The session page shows a run's `group`, `metrics`, `links` and the
document's `summary` ([RUNS.md](RUNS.md#fields-for-the-session-page)). You
need not set `group`: seamux puts a run under the prompt that launched it.

## Check it

```bash
seamux runs <session-id> --all
```

prints every adapter's runs for the session, and a notice for any that
failed. A failure names the first thing wrong: the exit code and the first
line of stderr, a timeout, output that is not JSON, or the field that did
not validate. The card shows the same notice.

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
