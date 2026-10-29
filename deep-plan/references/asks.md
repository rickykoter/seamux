# Ask pages: show a fork instead of describing it

Read this when a fork in the interrogation (discipline step 1) is about shape, placement, flow or a payload.

**When a fork is about shape, placement, flow, or a payload, show it.**
Write the question as an ask file (`examples/example.ask.json` in the plugin root: one
question, 2+ options, per-option `mermaid` and `example`) and run
`deep-plan ask <file.json>` from the worktree — it renders the page,
prints the id and `served at <url> (host: …)`. In cmux the page opens
beside the terminal; in Claude desktop, open the URL in the browser
pane with `preview_start`; in a plain terminal, give the person the
link. Then call `AskUserQuestion` as usual with the same options, each
preview carrying that URL plus a text sketch. The prompt is the answer
of record on every host. Only in cmux does a pick on the page type the
option number into the terminal (verified by reading the screen back;
if unverified the page says which key to press). Anywhere else the page
records the pick and tells the person to answer in the chat prompt. `deep-plan ask show <id>` prints what was picked.
**One question per `AskUserQuestion` call while an ask is open.** A
multi-question prompt is tabs, and a number key lands on whichever tab
is showing; the server refuses to type unless the terminal is showing
that ask's options, but a batched prompt still leaves the other asks'
pages unanswerable. Render the ask, put its one question, read the
answer, then the next. In cmux the page opens as a tab beside the
terminal in the same workspace (falling back to a Dock tab when no
workspace is known); it does not take focus.
