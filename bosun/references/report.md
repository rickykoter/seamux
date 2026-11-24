# Running a report

A report is a timed run of sections from `bosun.json`'s `reports`. The
supervisor types it as a prompt that opens `[Report <id> run <run>]`, after
checking each section's sources itself. You run the sections, add this run
to the report's Claude Doc, and send the results with
`seamux bosun report done <run>`. That command logs the run: don't also run
`log add` for it.

## Contents

1. Read what the supervisor checked
2. Run the sections
3. Add the run to the doc
4. Send the results
5. Never

## 1. Read what the supervisor checked

Each numbered section is one of three kinds:

| The prompt says | What you do |
|---|---|
| `Ask: <ask>` | Run the ask through the sources the section names |
| `Ask:` and `<via> is down (<why>)` | Run it through the sources that work, and say in its line which one was down |
| `Not checked: <why>` | Don't try its sources. Its line is that `Not checked: <why>` text, word for word, with status `unchecked` |

A down source is never reported as quiet. "No alerts" from a Datadog server
that needs a login is a guess, so the line stays `Not checked`.

## 2. Run the sections

Answer each ask read-only, the way the answers reference says, with a
source on every fact. Run independent sections side by side. When a source
fails while you use it (a refused command, a tool error), the section is
`unchecked` and its line names the error: `Not checked: gh was refused by
the sandbox (api.github.com is not in sandbox.allowedDomains)`.

Give each section one status:

- `needs`: something there waits on the person: an alert or monitor
  firing, a PR or review waiting on them for over a day, a failed deploy,
  or a red check on their branch.
- `ok`: checked, and nothing waits on them.
- `unchecked`: a source was down or failed.

Give each section one line, finding first, under about 120 characters:
`#412 "retry cap" waits 2 days on your review`, `3 monitors warning, none
alerting`.

## 3. Add the run to the doc

Follow the prompt's `Doc:` line:

| `Doc:` says | What you do |
|---|---|
| a link | Add this run's section at the top of the doc's tab, above the last run's. Leave older runs as they are |
| `none yet` | Make a doc with the Claude Docs connector, named as the prompt says, holding this run's section |
| `not updated this run` | Skip the doc. Put the reason in the results' `docWhy` |
| `this report has no doc` | Skip the doc |

Load the Claude Docs connector's guide first if no docs skill is loaded.
The connector's own instructions assume a person watching: open the doc,
put up a skeleton, fill it one section per call, post progress in chat.
Nobody watches a report run, so this reference wins over them here: make
or update the doc in one call holding the run's whole section, never open
it (no Artifact `open`, no link at the top of a message), and post no
progress lines.

Each run's section looks like this, newest on top:

```markdown
## Mon 23 Nov, 09:00

| Section | Status | Finding | Source |
| --- | --- | --- | --- |
| Pull requests | Needs you | #412 waits 2 days on your review | [gh search prs](https://github.com/acme/shop/pull/412) |
| Monitors | Not checked | datadog needs authentication | claude mcp list |

### Pull requests

#412 "retry cap" in acme/shop has waited on your review since Saturday;
checks are green ([PR 412](https://github.com/acme/shop/pull/412)).
```

The Status column says `Needs you`, `Fine` or `Not checked`. Under the
table, give each checked section a short part with its sources, written
by the humanize skill's rules. A `Not checked` section needs no part of
its own.

## 4. Send the results

Write the results into your own folder with the Write tool, at the path
the prompt names, then run the command on its own:

```bash
seamux bosun report done <run> < <dir>/drafts/<run>.json
```

```json
{"doc": "<the doc's https link, when you wrote it>",
 "docWhy": "<only when the doc was not updated: why>",
 "answer": "<the run for a person: a line per section, and anything else worth saying>",
 "sections": [
   {"title": "Pull requests", "status": "needs", "line": "#412 waits 2 days on your review",
    "sources": [{"kind": "url", "ref": "https://github.com/acme/shop/pull/412", "label": "PR 412"}]},
   {"title": "Monitors", "status": "unchecked", "line": "Not checked: datadog needs authentication",
    "why": "datadog needs authentication"}
 ]}
```

Every section in the prompt gets an entry, titled as the prompt titles it.
`report done` refuses a file that misses any of these, and says which:

- `answer`, at the top level, not one per section.
- Each section's `status` and `line`.
- `sources` on each `ok` or `needs` section, every one with a `kind`
  (`url`, `query`, `ticket`, `command`, `file`, ...) and a `ref`.
- `doc` when the doc was written, else `docWhy`.

It keeps the supervisor's `Not checked` lines whatever the file says, and
posts a banner when a section `needs` the person. Fix the file and run it
again.

When the prompt has a line such as "Say once, at the top of this run: …",
put that sentence first in `answer` and at the top of the doc's section.

## 5. Never

- Mark a section `ok` when you did not reach its source.
- Edit `bosun.json` to add, fix or turn off a report. Reports are the
  person's. Say what you would change instead.
- Run `seamux bosun report check` to see what's up: the supervisor has
  already checked, and that check is what the prompt shows.
