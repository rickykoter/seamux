# Ask the Bosun, from any other session

The Bosun is a read-only Claude session over the whole code root, with the
person's MCP servers (Snowflake, Datadog, Splunk, Jira). Ask it when a
question cuts across repos or needs those lookups, and no code here has to
change: "does any other service still call this endpoint?", "what did
checkout's error rate do after yesterday's deploy?", "is SHOP-12 still
open?". Questions about this repo's own code you can answer yourself.

## Write the question so it stands alone

The Bosun can't see this session. Name the repo, the branch, what you
already checked, and what the answer is for. One question per ask.

## Ask, without blocking

```bash
seamux bosun ask "<question>" --from "<repo>/<branch>"
```

`ask` queues the question, waits for the answer and prints it. It waits up
to 15 minutes by default, far longer than a Bash call's usual limit, so run
it with the Bash tool's `run_in_background` and go on with other work. You
are told when it ends.

| Exit | What it means | Then |
|---|---|---|
| 0 | the answer is on stdout | use it |
| 3 | still waiting; stderr names the id (`bosun ask <id>: ...`) | `seamux bosun ask --id <id>`, again in the background |
| 1 | nothing was queued | tell the person; `seamux bosun status` says whether the Bosun runs |
| 2 | bad arguments | fix the call |

The Bosun runs only on the seamux app's tmux backend. On cmux there is none
to ask: say so to the person rather than retrying.

## Use the answer

The answer cites its sources (`path:line`, commands, queries, links). Pass
the citations along when you repeat a fact, and check the one or two your
next step depends on. Asking the Bosun to change code doesn't work: it is
read-only, and it would hand the work to a new workspace instead of yours.
