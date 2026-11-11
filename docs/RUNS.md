# Runs and adapters

A run is background work a Claude session started: one background sub-agent,
or an orchestrated run of many agents, such as a Claude Code workflow.
seamux reads runs through adapters. Each adapter turns one orchestrator's
files into the same neutral model, `seamux.run/1`, and the Dock card, the
transcript page and the run page read only that model. No orchestrator is
built into the pages.

Whether a session is still working comes from Claude Code's hooks, not from
adapters. The Stop hook's `background_tasks` list, plus SubagentStart and
SubagentStop, keep a pane's background list (`crew_core::status`). Adapters
add the detail: labels, phases, models, times, tokens and results. If an
adapter breaks, the card still says the session is working and only the
detail is lost.

`seamux runs <session-id> [--all]` prints a session's report. Without
`--all`, only the adapters for the pane's current background tasks run.

## The model: `seamux.run/1`

An adapter prints one JSON document:

```json
{
  "schema": "seamux.run/1",
  "runs": [
    {
      "id": "wf_f7b371f3-6f2",
      "kind": "workflow",
      "name": "review-changes",
      "task": "w1yenxe1b",
      "status": "running",
      "start": 1794147717444,
      "end": null,
      "cap": 4,
      "phases": ["Review", "Verify"],
      "totals": {"tokens": 21558},
      "summary": null,
      "notice": null,
      "agents": [
        {
          "id": "a661f3333b54e409a",
          "label": "review:bugs",
          "phase": "Review",
          "model": "claude-sonnet-5-5",
          "state": "done",
          "start": 1794147717463,
          "end": 1794147719239,
          "needsYou": false,
          "tokens": 10779,
          "result": {"badge": "7", "detail": "{\"score\": 7, \"why\": \"...\"}"},
          "transcript": "/home/me/.claude/projects/-w-repo/<session>/subagents/workflows/wf_f7b371f3-6f2/agent-a661f3333b54e409a.jsonl"
        }
      ]
    }
  ]
}
```

A run needs only `id` and `status`. An agent needs only `id` and `state`.
Ids are letters, digits, `.`, `_` and `-`, since the pages put them in
their paths; a run or agent with any other id is shown but cannot be
opened. A lone agent's card row opens `/agent/<session>/<agent id>`, and a
run's opens `/run/<session>/<run id>`.
Everything else is optional, and seamux fills the gaps: a missing name or
label becomes the id, and missing totals are counted from the agents.

| Field | Meaning |
|---|---|
| `status` | One of `running`, `done`, `failed`, `cancelled`, `unknown`. |
| `kind` | `agent` for a lone sub-agent, `workflow` for an orchestrated run, or the adapter's own word. Without it, a run with one agent is `agent`. |
| `task` | The Claude Code background task id this run is, when known. It ties the run to the pane's background list. |
| `start`, `end` | Milliseconds since the epoch. |
| `cap` | How many agents may run at once, if the orchestrator says. The run page draws it on the concurrency strip. |
| `phases` | Phase titles in order. Agents name theirs in `phase`. |
| `totals.tokens` | The run's tokens. Agents' `tokens` are summed when it is missing. |
| `notice` | One line to show about this run, such as a note that the adapter read only part of it. |
| agent `state` | One of `queued`, `running`, `done`, `failed`, `cancelled`. |
| agent `needsYou` | The agent waits on the person. The run page raises a banner, and the card asks for you. For Claude Code agents the hooks know it first: a `PermissionRequest` from a sub-agent puts its id on the background entry's `waiting` list (see the context below), and the agent's next tool call, a `PermissionDenied` or its stop takes it off. |
| agent `result.badge` | A few characters shown on a finished bar, such as a score or a verdict. Longer badges are cut to 8 characters. |
| agent `result.detail` | Hover text, cut to 2,000 characters. |
| agent `transcript` | An absolute path to the agent's JSONL transcript. The transcript page serves only paths an adapter listed. |

seamux refuses a document it cannot read, and names the field: a missing or
different `schema`, a status or state outside its list, a number that is not
a number, or a relative transcript path. It keeps the first 50 runs and the
first 500 agents of each.

### Fields for the session page

The session page (`/runs/<session>`) lists every run a session started. These
optional fields let an adapter say more there. A document without them reads
as before.

```json
{
  "schema": "seamux.run/1",
  "summary": "lookout: 2 major open across 1 review",
  "runs": [
    {
      "id": "a3f0c2e1d4b5a6978",
      "status": "done",
      "group": {"id": "session-overview", "label": "Scouts for session-overview", "kind": "plan"},
      "parent": "wf_f7b371f3-6f2",
      "metrics": [{"label": "read", "value": 14}, {"label": "cites", "value": 31}],
      "links": [
        {"file": "/w/repo/crew/board/run.js", "line": 35},
        {"label": "review", "url": "http://127.0.0.1:7345/review/r1"}
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `summary` | One line about the whole session, from this adapter, shown under the page's header. Cut to 200 characters. |
| `group` | The heading a run sits under: `id` (required), `label` (cut to 120 characters), `kind` (`prompt`, `plan` or the adapter's own word) and `at`. A run without one goes under the prompt that launched it (see below). |
| `parent` | The id of the run that started this one. The page nests it under that run. |
| `metrics` | Up to four named counts, shown as chips: `label` (cut to 24 characters) and `value`, a number or a short string (cut to 12). |
| `links` | Up to eight things to open, each a `file` (an absolute path, with an optional `line`) or a `url` (http or https only), and an optional `label` (the file's name or the URL by default). The page opens a file in the editor only when it lies inside the session's worktree. |

A bad entry fails the document like any other field, named by its path
(`runs[0].links[1].url: "file:///x" is not an http or https URL`).

**Grouping by prompt.** seamux reads the session's own transcript to learn
which prompt launched each run. When Claude Code launches a background agent
or workflow, the tool result line carries the prompt's `promptId` and a
`toolUseResult` with `agentId`, or with `runId` and `taskId`. The first
user line with that promptId holds the person's text. A run whose id, task id
or an agent's id was launched that way, and that has no `group`, gets that
prompt as its group (`kind: "prompt"`). This happens after adapters replace
runs by id, so a command adapter that takes over a built-in's run keeps the
grouping without reading the transcript itself. Launches in a turn that a
background task's finish started go under the person's last prompt before it.

### The badge convention

An adapter decides what goes on a bar. The workflow adapter follows one
convention: when an agent returns an object with a `badge`, `score` or
`verdict` field, that field is the badge. A string that holds such an
object counts too, fenced or not. Any other result has no badge, and hover shows its first lines.
A workflow opts in by what its agents return.

## Command adapters

An adapter is a folder under `~/.config/seamux/adapters/` (or
`$SEAMUX_ADAPTERS_DIR`). It holds a manifest and a program in any language:

```json
{
  "schema": "seamux.adapter/1",
  "name": "my-orchestrator",
  "recognizes": ["teammate"],
  "command": ["python3", "adapter.py"],
  "timeoutMs": 3000
}
```

- `recognizes` lists the Claude Code background task types the adapter
  reads, as `background_tasks` names them (`subagent`, `workflow`,
  `teammate` and so on). The board runs an adapter only while a session has
  a background task of one of its types.
- `command` runs in the adapter's folder. Its context arrives on stdin, and
  it prints one `seamux.run/1` document on stdout.
- `timeoutMs` defaults to 3,000 and is capped at 10,000. A command still
  running at its timeout is killed.

The context on stdin:

```json
{
  "schema": "seamux.context/1",
  "session": "9c328a5c-81d2-4f6f-95bc-605f17e4fc05",
  "sessionDir": "/home/me/.claude/projects/-w-repo/9c328a5c-81d2-4f6f-95bc-605f17e4fc05",
  "transcript": "/home/me/.claude/projects/-w-repo/9c328a5c-81d2-4f6f-95bc-605f17e4fc05.jsonl",
  "cwd": "/w/repo",
  "background": [
    {"kind": "workflow", "id": "w1yenxe1b", "label": "review-changes", "at": 1794147717000, "waiting": ["a661f3333b54e409a"]}
  ]
}
```

A background entry's `waiting` lists the agents of that task stopped on a
permission prompt (only while one is). An adapter sets `needsYou` on those
agents.

seamux caches each result until a file under the session's folder or the
adapter's own folder changes, so an adapter runs only when there is
something new to read.

crew also ships command adapters of its own, in `crew/adapters` (crew's
live tree, `~/.config/cmux/crew/adapters`). They load after the built-ins
and before yours, and one of yours with the same name takes a bundled one's
place. When two adapters report a run with the same id, the later one's run
replaces the earlier one's. That is how a command adapter that reads more
about a sub-agent than the built-in does takes over its row.

**lookout** (bundled, recognizes `subagent`) reports each background
sub-agent whose brief runs `lookout findings add <review-id>` as a lookout
reviewer. It reads that review's store (`~/.claude/plans/reviews/<id>.json`)
and counts the findings created while the reviewer ran. The badge reads
"2 major" or "clean", and the metrics count those findings by severity. The
hover text lists each finding with its severity, file and line, and the
review page is a link. Its summary line counts what is still open across
the session's reviews: "lookout: 2 major open across 1 review".

**explore** (bundled, recognizes `subagent`) reports each background
sub-agent whose `agentType` is `Explore`. The badge is how many distinct
files its answer cites ("14 files"), the metrics are files read, searches and
citations, and the links are the cited files at their first cited line. Its
transcript reader, shared with other bundled adapters, is
`crew/adapters/lib/claude_agent.py`.

**scout** (bundled, recognizes `subagent`) reports each background
sub-agent whose description starts with "Scout", the sub-agents deep-plan
sends to check a claim before a plan is written. It loads after explore, so
an Explore scout is its. It groups scouts under the plan the session owns
("Scouts for <slug>", from deep-plan's state folder). Once that plan's spec
is rendered, the badge counts the spec's verifiedFacts the scout's
citations back (the same file, within three lines) or, when none, the risks
that name a file it cited ("3 facts", "1 risk"); before that, its
citations. Its summary line counts each fact and risk once across scouts:
"scouts: 4 facts, 1 risk in <slug>".

### When an adapter is missing or fails

A background task type that no adapter recognizes is reported as a notice:
"2 background tasks from teammate: no adapter". So is an adapter that fails:
"adapter my-orchestrator failed: exited with 1: <its first stderr line>".
A failure is a non-zero exit, a timeout, output that is not JSON, or a
document that does not validate. One adapter's failure does not hide the
others' runs. A folder whose manifest cannot be read is reported the same
way.

## The built-in Claude Code adapters

Both read Claude Code's files under `~/.claude/projects/<project>/<session>/`.
That layout is undocumented. What follows was seen with Claude Code 2.1.319,
and the fixtures in `app/crates/crew-core/tests/fixtures/runs` are trimmed
copies of it.

**claude-subagents** (recognizes `subagent`) reads each
`subagents/agent-<id>.meta.json` that has `"requestShape": "background"`.
Claude Code writes the meta file at launch and adds `"finished": true` when
the agent ends. The transcript beside it gives the times, the model, the
tokens and the last reply, which becomes the result. The agent id is also
the background task's id.

**claude-workflow** (recognizes `workflow`) reads a run from these files:

| File | Written | Gives |
|---|---|---|
| `workflows/scripts/<name>-<run>.js` | at the start | the name and phase titles, from its `meta` |
| `subagents/workflows/<run>/journal.jsonl` | as agents start and return | each agent's label, phase and result |
| `subagents/workflows/<run>/agent-<id>.{jsonl,meta.json}` | per agent | its transcript and model |
| `workflows/<run>.json` | only when the run ends | the status, the background task id, each agent's state and times, the totals and the summary |

A run with no run file yet is running while the pane's background list names
its workflow, or while its files changed in the last 10 minutes. After that
it reads as `unknown`, since it was most likely killed.
