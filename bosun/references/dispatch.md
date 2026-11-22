# Dispatch: hand real work to a new workspace

When an answer turns into work (a fix, a refactor, a new file), the Bosun
never does it. It writes a brief and opens a workspace that starts on it.
`seamux bosun dispatch` makes the worktree and opens the workspace. It is
the one command the sandbox lets out, and the person approves every run.

## 1. Name it

- **repo**: the folder name under the code root (`shop`), or its absolute
  path.
- **id**: six hex characters, from `openssl rand -hex 3` (say `3fa9c1`).
  This becomes the log entry's id.
- **branch**: a short kebab-case slug for the work, then the id:
  `retry-cap-3fa9c1`. Dispatch adds the branch prefix (`dev/`). The worktree
  lands at `<repo>.worktrees/retry-cap-3fa9c1`, and the board titles the
  card with that folder name, so the card carries the id.

## 2. Write the brief

Write it with the Write tool to `<dir>/dispatch/<id>.md`.
Inside the code root you can't write; your own folder is the one place you
can. It is the new session's first message, so it stands alone:

```markdown
From the Bosun, log <id>.

<the goal, in one or two sentences>

What is known: <the facts behind it, each with its source as in an answer>
Start here: <the files, tickets or dashboards to open first>
Done when: <what proves it, such as a test, a check or a number>
Out of scope: <what not to touch>
```

Follow the humanize skill's rules, and keep every citation as found.

## 3. Run it, bare

```bash
seamux bosun dispatch <repo> <branch> --brief <dir>/dispatch/<id>.md --json
```

Type it exactly as one command: no `cd`, no `&&`, no pipe, no `sh -c`, no
`env`. The ask rule matches only that form. Anything else stays in the
sandbox and fails. The person sees a permission prompt and decides.

- **Approved**: it prints `{"path", "branch", "workspace"}`.
- **Declined or failed**: say so and stop. Never fall back to
  `git worktree add` or `seamux workspace-open`, which the sandbox refuses.
  The brief stays in your folder for a later try.

## 4. Log it

Log the dispatch with `seamux bosun log add`, using the id from step 1:
`question` is what was asked for, and `answer` is one or two sentences on
what went where. The sources are the facts behind it, plus the workspace:

```json
{"kind": "workspace", "ref": "<path from dispatch>", "label": "<branch from dispatch>"}
```

When the dispatch came out of a queued ask, the ask's own answer names the
new workspace and the dispatch's log id.
