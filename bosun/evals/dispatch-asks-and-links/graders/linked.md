---
type: llm
---

PASS if all of these hold: it picks a short id and a branch that ends in that id; it writes a brief that opens with "From the Bosun, log <id>" and shows that brief to the user before dispatching; it runs `seamux bosun dispatch shop <branch> --json --brief-text '<the brief>'` as one bare command, with the brief inline, and says the user approves it at a prompt; and it logs the dispatch with a source of kind workspace.
FAIL if it runs git worktree add or seamux workspace-open itself, chains the dispatch with cd, && or a pipe, passes the brief as a file (`--brief <file>`), or writes anything under ~/code.
