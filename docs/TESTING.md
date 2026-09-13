# Testing crew on a real changeset

A walkthrough on a fresh worktree. Roughly 15 minutes, and you end up with a
real branch you can throw away.

**The one thing that matters:** Claude Code binds hooks at session start. A
session already running when crew was installed is still on the old wiring, and
it fails silently — no name, no progress, no lane. Everything below assumes a
**new** session.

`crew status` says which case any session is in. For one that predates crew,
`crew adopt` back-fills it once (name, colour, plan, progress) and
`crew-resume` + `^T` restarts it in place so hooks actually bind.

---

## 1. New worktree

Titlebar `+` → **New monolith worktree + Claude**, or from any terminal:

```sh
crew-worktree crew-smoke-test-proj-999
```

It fetches, creates `dev/crew-smoke-test-proj-999`, copies `.husky/_`, symlinks
`node_modules`, and opens a workspace with Claude already running.

**Look for:** the sidebar row says **PROJ-999 · crew-smoke-test**, not a file
path. It has a colour. It sits under the worktrees group with a branch icon.

> No ticket in the branch name falls back to the directory name — that is
> intended, not a failure.

## 2. Give Claude a multi-step task

In that new session, something that will produce a plan and touch files:

```
Add a spec for a trivial new PORO in gems/core, then run it. Use a task list.
```

**Look for, as it works:**

- a progress bar on the sidebar row, `2/5`, advancing
- a pill naming the task in flight, e.g. `Writing the spec`
- the row's checklist (click the row's summary line) matching Claude's plan

## 3. Walk away

Switch to another workspace, or another app, for a minute.

**Look for:**

- when Claude finishes a turn: a sidebar entry, **no** desktop banner
- ~60s later, if you have not come back: cmux's idle reminder banner
- if Claude needs permission or asks a question: a banner **immediately**, plus
  a Feed card you can answer without switching in

That split is the point. Banner means blocked; sidebar means done.

## 4. The board

Right-click the sidebar toggle button → **crew**.

**Look for:** your workspaces bucketed into **Needs you / Working / Review /
Idle**, each with branch, PR, progress and time since the last message. Click a
row and it selects that workspace.

## 5. Diffs

`cmd+k` then:

| Key | Shows |
|---|---|
| `d` | the picker |
| `t` | just what Claude changed in its last turn |
| `b` | the whole branch vs `origin/master` |
| `u` | unstaged |
| `p` | the open PR |

In the picker, type a **number** for one commit, or `2-4` for a range.

**Look for:** `cmd+k t` after a Claude turn shows only that turn's edits. On a
clean tree, `cmd+k u` says "nothing unstaged" instead of opening a blank pane.

> A cmux action has no headless target, so every chord briefly opens a terminal
> tab to run the command in. Those tabs close themselves once the work is done.
> If you see one linger, the command failed — the error is in that tab, which is
> deliberate. The picker's tab stays until you choose.

> The `cmd+k` chords are the one part that could not be verified from the CLI —
> `cmux shortcuts` does not enumerate custom-action shortcuts. If a chord does
> nothing, the same entries are in the Command Palette (`cmd+shift+p`, search
> "Diff"), and `crew-diff` works from any terminal.

## 5b. Resume an old session

`cmd+k r`, or the **Sessions** Dock control.

Type to filter — try a ticket (`proj-938`), a tool (`moto`), or a phrase you
remember from a prompt. `⇥` widens from this repo to all projects.

**Look for:** 324 sessions, newest first, each with age, branch and a title.
`⏎` opens the selected one in a new workspace with `claude --resume` already
running; `^T` resumes in the current tab instead.

**Also look for:** rows marked `no cwd`. 94 sessions point at worktrees you have
since deleted — the picker refuses those rather than handing you a broken
resume.

## 6. VS Code

`cmd+k e`, or `crew-code`.

**Look for:** the VS Code **desktop app** comes forward with a window on **this
worktree**, Source Control showing **this branch**, and your usual extensions
loaded. Run it again — the same window is focused, not a second one.

Then **Cmd-click a file path in the terminal**.

**Look for:** the file opens in that worktree's window, as a new tab. Cmd-click
a path belonging to a *different* worktree — it must land in **that** worktree's
window, opening one if none exists, never in the window you were looking at.

```sh
crew-code status    # folder, branch, whether this worktree has a window
crew-code windows   # every open window folder
```

A brand-new worktree may ask you to trust it. If it does, `~/code` is not
trusted yet — see README, and `crew doctor` flags it.

## 7. The Dock

Open the Dock (right sidebar) in the monolith. First time in the repo, cmux
asks you to trust the project config — that prompt is expected.

**Look for:** four controls — **Checks** (`gh pr checks`, which lists the RWX
run), **Diffs** (the picker), **Git**, **DB**. `crew-spec` prints usage rather
than launching a long suite unasked.

## 8. Undo it

```sh
crew off          # instant: hooks stay wired but do nothing. No restart.
crew on
```

Further:

```sh
crew uninstall    # restores the pre-crew cmux.json from its .bak
```

**Check afterwards:** a force-push is still blocked, and whimsy still animates.
Neither belongs to crew, and `crew doctor` fails loudly if `guard_bash.sh` ever
stops being wired.

## 9. Clean up the test branch

```sh
cmux close-workspace --workspace <id>
git -C ~/code/main-repo worktree remove \
  ~/code/main-repo.worktrees/crew-smoke-test-proj-999 --force
git -C ~/code/main-repo branch -D dev/crew-smoke-test-proj-999
```

---

## If something looks wrong

```sh
crew doctor       # every check, non-zero exit if anything fails
crew status       # runtime state + this workspace's live sidebar state
crew demo <session-id>   # fire each hook synthetically and print what changed
crew-code status         # which worktree window VS Code thinks it has
```

The sidebar hot-reloads on save, and errors show inline in the pane with the
failing location — so iterating on `sidebars/crew.swift` is a save away.

`cmux sidebar validate crew` only parses. It will not catch a render bug, and it
does not even reject a modifier that does not exist — unknown modifiers are
silently ignored, so a typo validates clean and then does nothing. Render it for
real instead:

```sh
python3 tools/render_probe.py sidebars/crew.swift /tmp/ir.json
```

That drives cmux's own interpreter worker (`--cmux-sidebar-interpreter-worker`)
against a synthetic eight-workspace state chosen to light up every branch on the
board at once — a live Feed ask, an expired one, working, review with failing CI,
merged, idle — and writes the full render IR. Every node with its `text`,
`action` and `modifiers`, so you can assert on what actually rendered:

```sh
python3 -c "
import json; ir = json.load(open('/tmp/ir.json'))
rows = []
def walk(n):
    if not isinstance(n, dict): return
    mods = {m['name'] for m in (n.get('modifiers') or [])}
    if n.get('text') and n.get('action'):
        rows.append((n['text'], 'background' in mods or 'underline' in mods))
    for c in (n.get('children') or []): walk(c)
    for m in (n.get('modifiers') or []):
        for c in (m.get('children') or []): walk(c)
walk(ir)
print('tappable:', len(rows), '| bare:', [t for t, ok in rows if not ok] or 'none')
"
```

Three real bugs were found this way that validation called OK — see FINDINGS
(`A return inside a for body`, `!= nil is not a Bool`). Node count is a decent
smoke signal on its own: the board is ~324 nodes with that state, and a branch
that silently stopped rendering shows up as a drop.
