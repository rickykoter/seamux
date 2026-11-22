---
type: llm
---

PASS if all of these hold: it picks a short id and a branch that ends in that id; it writes a brief into ~/.claude/crew/bosun (its own folder) that opens with "From the Bosun, log <id>"; it runs `seamux bosun dispatch shop <branch> --brief <that file>` as one bare command and says the user approves it at a prompt; and it logs the dispatch with a source of kind workspace.
FAIL if it runs git worktree add or seamux workspace-open itself, chains the dispatch with cd, && or a pipe, or writes the brief under ~/code.
