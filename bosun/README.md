# bosun: one read-only session for questions across your repos

Part of [seamux](../README.md). Install and setup are in the [main README](../README.md#setup).

The Bosun is a Claude session the seamux app keeps running over your code
root, off the board, read-only on files. It is for questions that need no
code: is a claim true, where does a project stand, what do Snowflake,
Datadog, Splunk or Jira say. The app's `seamux bosun` CLI starts it and
carries questions in and answers out. This plugin is the skill that tells
each session what to do.

In the Bosun, the skill covers four jobs:

- **Sitrep**: branches in flight, open PRs, live workspaces and recent
  deploys for every repo under the root, each line with its source.
- **Answers**: every fact cites a file and line, a command, a query, a
  ticket or a link. A queued question is answered with
  `seamux bosun answer <id>`, and every answer is logged with
  `seamux bosun log add`, which feeds the app's answer log.
- **Dispatch**: when an answer turns into real work, the Bosun writes a
  brief and runs `seamux bosun dispatch <repo> <branch> --brief <file>`.
  You approve each one at a permission prompt. The new worktree's folder,
  and so its card on the board, ends in the log entry's id.
- **Reports**: timed runs of sections from `bosun.json`'s `reports`. Before
  each run the supervisor checks every section's sources (`claude mcp list`
  for `mcp:` ones, PATH for `cmd:` ones), so a section whose source is down
  reads "Not checked: <why>" instead of a guess. The Bosun adds each run to
  the report's Claude Doc, newest on top, and sends the results with
  `seamux bosun report done <run>`. The app's rail shows a card per run, and
  a run that finds something waiting on you posts a banner.

In any other session, the skill covers asking: `seamux bosun ask "<question>"`
in the background, with `ask --id <id>` to pick up an answer that came late.

The Bosun runs on the seamux app's tmux backend only. Its sandbox lets out
only the hosts and folders listed in `~/.claude/crew/bosun/bosun.json`
(`sandbox.allowedDomains`, `sandbox.allowWrite`), and it reads them when it
starts, so restart it after a change (`seamux bosun stop`, then
`seamux bosun ensure`). Add the folders a CLI keeps its cache in to
`sandbox.allowWrite`.

GitHub is off until you add it. Put `api.github.com` in
`sandbox.allowedDomains` for `gh`; until then a report's `cmd:gh` section
reads Not checked and names that host. `gh` acts with your token, so once
GitHub is on, a ticket or page that talks the Bosun into it could have `gh`
write there too (a gist, a PR comment). The Bosun points `gh` at macOS's
certificate file (`SSL_CERT_FILE=/etc/ssl/cert.pem`), so `gh` can check
GitHub's certificate without a sandbox setting. Behind a proxy that swaps in
your company's certificate, that file lacks it: set `SSL_CERT_FILE` to a
bundle that includes it where the app will see it (an app opened from the
Finder doesn't read your shell profile; `launchctl setenv` reaches it), then
restart the app and the Bosun.

A report in `bosun.json` (the supervisor writes starter ones the first time
it runs: `morning` covers your PRs, where your open workspaces stand, and a
section per MCP server you have; `afternoon` covers PRs):

```json
"reports": [{"id": "morning", "title": "Morning report", "at": ["09:00"], "days": "weekdays",
             "sections": [{"title": "Pull requests", "via": ["cmd:gh"], "ask": "PRs waiting on my review, oldest first"},
                          {"title": "Monitors", "via": ["mcp:datadog"], "ask": "monitors alerting or warning"}],
             "to": ["doc", "banner"]}]
```

A `cmd:` source is checked before each run: the command must be on PATH,
and the sandbox must let out the hosts it needs. seamux knows the hosts of
a few CLIs that always call one API (`gh`, `vercel`, `netlify`, `fly`,
`heroku`, `doctl`, `stripe`, `circleci`). For any other CLI, or to change
those, give the section a `hosts` list, and add the same hosts to
`sandbox.allowedDomains`. An empty list turns the check off:

```json
{"title": "Deploys", "via": ["cmd:gcloud"], "hosts": ["oauth2.googleapis.com", "run.googleapis.com"],
 "ask": "failed Cloud Run deploys today"}
```

`seamux bosun report list` shows each report and its next run,
`seamux bosun report run <id>` runs one now, and
`seamux bosun report check [<id>]` says which sources work right now.
`crew doctor` shows the same under **bosun**: each section that can't be
checked yet and why, and an MCP server you have set up that no section uses.

| file | what |
|---|---|
| `SKILL.md` | which session this is, the rules, and which reference to read |
| `references/sitrep.md` | what a sitrep reads and how it reports |
| `references/answers.md` | citing, answering a queued ask, and the log entry |
| `references/dispatch.md` | naming, the brief, the bare dispatch command, logging it |
| `references/report.md` | running a report: the checked sections, the doc and `report done` |
| `references/ask.md` | asking from a workspace without blocking |
