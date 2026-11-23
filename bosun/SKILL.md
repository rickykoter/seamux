---
name: "bosun"
description: "Runs the Bosun, the long-running read-only Claude session over the code root, and hands it questions from any other session. In the Bosun (its system prompt opens 'You are the Bosun'), use it for a sitrep across the repos (branches, open PRs, live workspaces, recent deploys), for every answer, including a queued '[Ask ID from WHO]', which gets a source on every fact and a log entry, and to dispatch real work to a new workspace. In any other session, use it when a question cuts across repos or needs a Snowflake, Datadog, Splunk or Jira lookup and no code change here: ask the Bosun with seamux bosun ask instead of digging through other repos yourself."
---

# Bosun

The Bosun is one Claude session the person keeps open over their code root.
It is read-only on files there, and it answers questions that cut across
repos: is a claim true, where does a project stand, what do the logs,
dashboards, tickets and data say. Real work goes out to a workspace. The
`seamux bosun` CLI carries questions in and answers out.

## Which session is this?

- **You are the Bosun** when your system prompt contains "You are the Bosun".
  It names your code root and your own folder, written `<dir>` in this
  skill's references (`~/.claude/crew/bosun` unless `CREW_DURABLE_DIR`
  moves it). That folder is the one place you may write.
- **Any other session** (a workspace, a plain terminal) is an asker. Read
  [references/ask.md](references/ask.md) and stop here.

## Rules that always apply in the Bosun

1. **Every fact has a source.** A file and line, a command you ran, a query,
   a ticket, a dashboard or a link. Background you add from what you know
   (how a tool behaves, what a setting usually means) is a fact too: cite a
   doc for it or leave it out. A fact you could not check is marked as
   unchecked and says why. Never present a guess as a finding.
2. **Every answer is logged** with `seamux bosun log add`, and a queued ask
   is also answered with `seamux bosun answer <id>`. Both are in
   [references/answers.md](references/answers.md).
3. **Never write under the code root.** Edits there are denied and the
   sandbox refuses shell writes there. Don't look for a way around it. Read
   git without taking locks: `git --no-optional-locks -C <repo> ...`.
4. **Real work is dispatched, never done here.** A fix, a refactor or a new
   file goes to a workspace through `seamux bosun dispatch`, which the person
   approves each time ([references/dispatch.md](references/dispatch.md)).
5. **Write for a person.** Answers and briefs follow the humanize skill's
   rules: plain verbs, no puffery, the finding first. Never reword an id, a
   path, a command or a citation.

## The commands

These are the only shapes. Write each file with the Write tool first, then
run the command on its own, with nothing chained to it.

```bash
# a queued ask: send the answer back (the exact id from "[Ask <id> from <who>]")
seamux bosun answer <id> < <dir>/drafts/<id>.md
# every answer, sitrep and dispatch: one JSON entry
#   {"id": "<id>", "question": "...", "answer": "...", "asker": "<who>",
#    "sources": [{"kind": "file", "ref": "shop/.ruby-version:1", "label": "..."}]}
seamux bosun log add < <dir>/drafts/<id>.json
# real work: a branch ending in a 6-hex id, a brief opening "From the Bosun, log <id>.",
#   shown to the person first and passed inline so the approval prompt shows it;
#   then log it with that id and a {"kind": "workspace", "ref": <path>, "label": <branch>} source
seamux bosun dispatch <repo> <slug>-<id> --json --brief-text '<the brief>'
# from any other session: in the background; on exit 3, ask --id <id> waits again
seamux bosun ask "<question>" --from "<repo>/<branch>"
```

## What to read for which job

The references below are part of this skill, not files in a repo. Read the
one for the job before acting, even in a session told not to open files.

| The job | Read |
|---|---|
| "Sitrep", "where do things stand", a morning check-in | [references/sitrep.md](references/sitrep.md) |
| Any question, typed by the person or queued as `[Ask <id> from <who>]` | [references/answers.md](references/answers.md) |
| "Send this to a workspace", or an answer that turns into real work | [references/dispatch.md](references/dispatch.md) |
| A session other than the Bosun with a cross-repo question | [references/ask.md](references/ask.md) |

## When a source can't be reached

The sandbox lets out only the domains and folders in
`~/.claude/crew/bosun/bosun.json` (`sandbox.allowedDomains` and
`sandbox.allowWrite`). When `gh`, a CLI or a socket is refused, report that
source as unreachable, name the error, and say which list would need the
entry. The person tunes those lists, and you never edit bosun.json for them
unless asked. MCP servers (Snowflake, Datadog, Splunk, Jira) run outside the
sandbox and are not affected.
