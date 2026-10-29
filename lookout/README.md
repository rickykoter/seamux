# lookout: review a diff with the agent

Part of [seamux](../README.md). Install and setup are in the [main README](../README.md#setup).

`lookout open` puts a diff in a browser tab beside the terminal: this branch
against its base by default, or `--worktree`, `--range A..B`, `--patch FILE`.
Ask Claude to "review this branch" and it opens the page, briefs a reviewer,
and talks the findings through with you there. Opening a review never
touches your git index.

Outside cmux, lookout serves the page itself and prints `served at <url>`.
In a cloud session, where nobody can reach the sandbox, `lookout
export-artifact` turns the review into a private Artifact page (published
only when you say yes) and `lookout pull` brings your comments and closes
back.

## The page

The layout is VS Code's Source Control view: the changed files on the left,
one file's diff on the right, split or unified (`v`), with `j`/`k` to move
between files. Highlighting covers each side's whole file, so a change
inside a block comment still reads as a comment, and changed words are
marked. Lockfiles, generated and very large files start collapsed.

The file list has two orders. **Path** is a folder tree. **Risk** puts the
riskiest files first, in high, medium and low bands, with related files
grouped on a rail that says why they belong together: one imports the
other, a test and its source, a finding that names both. Risk blends simple
signals (how much changed, whether the path is auth, a schema, a server or
config, whether it is only tests) with one Jev score per file. By default
only paths and line counts go to TypeSafe; `.seamux/lookout.json`
`{"sendContent": true}` lets the changed lines go too. Without TypeSafe the
page says it is ranking on the signals alone.

![a lookout review: files in risk bands with a related group on a rail, a split diff of a checkout route, and a comment thread under one of its lines](../docs/img/lookout-risk.png)

## Findings and threads

Findings come from one fresh reviewer subagent, not from the agent that
wrote the code. `lookout prompt <id>` prints its brief: the diff, the files
riskiest first, a rubric across correctness, security, performance and
maintainability, and the JSON to write. Each finding is `/code-review`'s
shape plus a severity (blocker, major, minor, nit), and it sits under its
line with a thread. `n`/`p` step through them.

When crew's intent server is running the page is live. Click a line number
to comment, reply under a finding, resolve or dismiss it. What you write
reaches the agent at its next prompt, and its replies (`lookout reply`)
appear on the page without a reload. Without crew the page opens as a
read-only file.

![a major finding under the line it names: the failure scenario, the agent's reply, its "addressed" note, your answer, and the reply box with Resolve and Dismiss](../docs/img/lookout-findings.png)

Only you close a finding. The agent can reply and mark one addressed; it
can resolve or dismiss only when the review was opened with
`--agent-may-close`, which a plan sets with `review.agentMayClose`.

## Group notes

Findings say what is wrong. Alongside them the reviewer writes a note for
each risky group of files: why it is risky, the direction it moves the
design (a boundary moved, an invariant relaxed, a new dependency between
systems), what to check by hand at which lines, and which fundamentals it
touches. A review with notes opens on an **Overview** (`o` toggles it) that
lists the groups riskiest first, so you can judge the architecture before
reading lines; each file shows its group's note as a strip above the diff.
The reviewer can also link files the grouping rules missed, such as a
migration and the query that reads its table, and the link's reason shows
on the group's rail.

`lookout open --quiz` (or `.seamux/lookout.json` `{"quiz": true}`, or a
plan's `review.quiz`) adds a question to each high-risk group and hides its
note until you answer, so you form your own reading of the change before
you see the agent's. The quiz never gates anything. A wrong answer reaches
the agent at your next prompt, so it can explain the gap if you ask; a right
one stays yours. Answers need crew's intent server: opened as a file, the
page shows the notes in full.

![the Overview of a quizzed review: the checkout group's question with four options, waiting for an answer, and below it the session group answered right, with its reason and the note: why it is risky, the direction, and what to watch at which lines](../docs/img/lookout-overview.png)

Inside a plan, a group that heads somewhere the increment's description
does not is filed as a `plan-drift` finding, always major or worse. It
holds the review check until you close it; dismissing it records that the
deviation was meant.

## Reviews in a plan

`lookout gate` answers 0 when no blocker or major finding is open. A
deep-plan increment you chose for review has a check that runs it, so the
increment can't be done until you have closed those findings, and a plan
with a delivery review can't be complete until its review passes (see
[Checks before done](../deep-plan/README.md#checks-before-done)). On a plain branch nothing gates
on it: the review is a conversation.
