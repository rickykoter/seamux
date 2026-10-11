# Ask pages: show a fork instead of describing it

Read this when a fork in the interrogation (discipline step 1) is about shape, placement, flow or a payload.

**When a fork is about shape, placement, flow, or a payload, show it.**
Write the question as an ask file (`examples/example.ask.json` in the plugin root: one
question, 2+ options, per-option `mermaid` and `example`) and run
`deep-plan ask <file.json>` from the worktree — it renders the page,
prints the id and the `/ask/<id>` URL, and opens it in the Dock. Then
call `AskUserQuestion` as usual with the same options, each preview
carrying that URL plus a text sketch: the terminal prompt is the
answer of record, and a pick on the page types the option number into
it (verified by reading the screen back; if unverified the page says
which key to press). `deep-plan ask show <id>` prints what was picked.
**One question per `AskUserQuestion` call while an ask is open.** A
multi-question prompt is tabs, and a number key lands on whichever tab
is showing; the server refuses to type unless the terminal is showing
that ask's options, but a batched prompt still leaves the other asks'
pages unanswerable. Render the ask, put its one question, read the
answer, then the next. The page opens as a tab beside the terminal in
the same workspace (falling back to a Dock tab when no workspace is
known); it does not take focus.
