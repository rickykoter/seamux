# Answering, with a source on every fact

Every question the Bosun answers goes the same way: find out, cite, write
the answer for a person, send it back if someone is waiting, and log it.

## 1. Find out, read-only

Read files, run read-only commands, and query through the MCP servers you
have (Snowflake, Datadog, Splunk, Jira). For git, take no locks:
`git --no-optional-locks -C <repo> log|show|branch|worktree list`. Never
fetch into a checkout: that writes under the root, and the sandbox refuses
it. Use `gh` for what is on GitHub instead.

## 2. Cite each fact where it is stated

| Kind | Cite it as | Log source |
|---|---|---|
| a file | `path:line` (from the code root) | `{"kind": "file", "ref": "shop/app/retry.rb:42", "label": "retry cap"}` |
| a command | the command, as run | `{"kind": "command", "ref": "gh pr list -R acme/shop --state open", "label": "open PRs"}` |
| a query | the query text, and where it ran | `{"kind": "query", "ref": "select count(*) from orders where ...", "label": "Snowflake: orders today"}` |
| a ticket | its key and link | `{"kind": "ticket", "ref": "https://acme.atlassian.net/browse/SHOP-12", "label": "SHOP-12"}` |
| a dashboard or log search | its link | `{"kind": "dashboard", "ref": "<url>", "label": "Datadog: checkout p95"}` |
| a web page | its URL | `{"kind": "url", "ref": "<url>", "label": "<page title>"}` |

Put the citation right after the fact it backs, not in a list at the end.
When something could not be checked, say so in the answer ("not checked:
the Splunk index was unreachable from the sandbox") rather than leaving it
out. When sources disagree, give both and say which is newer.

## 3. Write it for a person

Lead with the answer in one or two sentences, then the evidence. Follow the
humanize skill's rules: plain verbs, no hedging stacks, no restating the
question. Keep every id, path, command and citation exactly as found.

## 4. Send it back and log it

Write the answer and the log entry into your own folder first, with the
Write tool, then redirect each file into its command. Don't put the JSON
in a heredoc or an `echo`: Claude Code refuses a command with braces and
quotes in it ("expansion obfuscation"), and quoting can break the answer.
Run each command on its own, with nothing chained after it.

```bash
seamux bosun answer <id> < <dir>/drafts/<id>.md
seamux bosun log add < <dir>/drafts/<id>.json
```

- **A queued ask** arrives as `[Ask <id> from <who>]`, then the question.
  Answer with that exact `<id>`, and log with `"id": "<id>"` and
  `"asker": "<who>"`. Someone is waiting on `answer`, so send it first.
- **A question the person typed** has no one waiting: skip `answer`, log it
  with `"asker": "person"`, and let `log add` pick the id.

The entry is one JSON object:

```json
{"id": "<id>", "question": "<the question>", "answer": "<the answer as sent>",
 "sources": [{"kind": "file", "ref": "shop/app/retry.rb:42", "label": "retry cap"}],
 "asker": "<who>"}
```

`question` and `answer` are required, and each source needs a `ref`. A
sitrep and a dispatch are logged the same way.

## 5. If the answer is real work

Say so at the end of the answer, and offer a dispatch (the skill's dispatch
steps). A dispatch always waits on the person's yes at its prompt, so for a
queued ask, answer first and offer the dispatch in that answer.
