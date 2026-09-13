# FINDINGS

What cmux 0.64.22 and Claude Code 2.1.224 actually do on this machine, measured
rather than assumed. Read this before changing anything in `crew` — several of
these contradict the obvious design.

## cmux has no config include mechanism

`cmux config paths` lists exactly one primary file, `~/.config/cmux/cmux.json`,
plus two legacy fallbacks read only for keys the primary omits. The schema has
no `include` / `import` / `extends` key:

```
$ python3 -c "import json;s=json.load(open('cmux.schema.json'));
  print([k for k in s['properties'] if 'includ' in k or 'import' in k or 'extend' in k])"
[]
```

So a package cannot layer fragments onto the user's config. `crew apply` owns
the whole file: it copies the live one to a timestamped `.bak`, then renders
`config/cmux.jsonc` over it. `crew uninstall` restores the newest backup. cmux's
own CLI help asks for exactly this backup discipline.

Project-local `.cmux/cmux.json` *does* override the global for some keys, which
is a partial escape hatch, but it is per-directory, not compositional.

## The custom-sidebar interpreter cannot see the workspace lane

`cmux workspace status set <lane>` accepts
`todo|working|needs-attention|review|done|auto|none`, and the lane drives cmux's
own sidebar grouping. But the bindings available to a custom sidebar are only:

```
id title selected pinned index directory ports portCount unread tabs tabCount
description color branch dirty pr prs progress{value,label}
latestMessage latestPrompt latestAt remote
```

plus `workspaceCount`, `selectedTitle`, `selectedId`, `unreadTotal`, `clock`.

No lane. So `sidebars/crew.swift` derives its own buckets from `unread`,
`latestAt`, `pr`, `dirty`, and `progress` instead of reading the lane crew sets.
The two agree in practice because they read the same underlying reality, but
they are independent — changing the lane mapping in `crew-hook.sh` does **not**
change what the board shows.

If they ever need to agree exactly, the side channel is `description`: it is
bindable, and `cmux workspace-action --action set-description` can write it.

## The sidebar interpreter: three things that validate but render wrong

`cmux sidebar validate` only parses. All three of these passed validation and
were caught by looking at the rendered pane.

**Edge-specific padding is silently dropped.** The supported-modifier list has
`.padding(8)` and nothing else. `.padding(.top, 4)`, `.padding(.horizontal, 5)`,
`.padding(.vertical, 1)` parse fine and then do nothing. This is not cosmetic:
a dropped padding lets `.background` fill the entire available width, which
turned a 2-character unread badge into a full-height red block. Use plain
`.padding(n)`, and size anything with a background using an explicit `.frame`.

**`ProgressView(value:)` paints its own numeric label.** A bar with
`value: 1.0` renders the literal text `1.0` at its origin, on top of whatever
is next to it, and `.frame(height: 3)` collapses the view so the label overlaps
the neighbouring rows. Draw the bar instead — `Capsule().fill(…).frame(width:
track * value, height: 3)` inside a `ZStack(alignment: .leading)` is fully
supported and deterministic. A fixed track width is required; `GeometryReader`
is not in the subset.

**Mixed-type ternaries in a color modifier are a hazard.**
`.foregroundColor(cond ? "#4ADE80" : .secondary)` mixes a hex string and a
token. Use two hex strings.

## Render the sidebar from the command line instead of squinting at the pane

The "validates but renders wrong" problem above is only unfalsifiable while the
rendered pane is the sole oracle. It is not: the interpreter is an
**out-of-process worker that is the app binary itself**, and it will render an
arbitrary source file against an arbitrary state on demand.

```
/Applications/cmux.app/Contents/MacOS/cmux --cmux-sidebar-interpreter-worker
```

The flag is checked before any AppKit setup, so it never boots a second GUI. It
speaks 4-byte big-endian length-prefixed JSON on stdin/stdout:
`{id, source, state}` in, `{id, node}` out, where `node` is the full render IR —
every node with its `kind`, `text`, `action`, and `modifiers`. `state` is
`[String: SwiftValue]`, encoded as Swift's synthesized enum Codable, i.e. a
one-key wrapper per value with the payload under `_0`:

```json
{"workspaces": {"array": {"_0": [{"object": {"_0": {"title": {"string": {"_0": "row"}}}}}]}}}
```

`render_probe.py` builds a synthetic eight-workspace state that lights up every
branch in `crew.swift` at once — waiting with a live Feed window, waiting with an
expired one, working, review, merged, idle — and dumps the IR. Asserting over the
IR is how the three bugs below were found, all of which `cmux sidebar validate`
calls OK.

Keep it. Any change to `crew.swift` can be checked for real before it goes near
the board.

## A `return` inside a `for` body does not escape the loop

The worst interpreter bug found so far, because the failure is a plausible value
rather than an error.

```swift
for t in phase(w).split(separator: " ") {
    let parts = t.split(separator: ":")
    if parts.count > 1 {
        if parts[0] == key { return parts[1] }   // ignored
    }
}
return ""                                        // always this
```

The loop runs, the split works, the comparison works, and the `return` is simply
discarded — execution falls through to the function's final `return`. So
`tokenValue()` answered `""` for every key on every row, from the day it was
written.

What that cost: `feedLeft()` is `Int(tokenValue(w, "feedby"))`, so it was
`Int("")` → nil. And **a nil propagates through `<` and `>` as `false`, not as an
error**, so `feedLeft(w) > 0` and `feedLeft(w) < 1` were false *at the same
time* — every branch guarded by the Feed window was unreachable. The countdown,
`allow`, `deny`, `read it →` and `jump →` had never rendered once. The board drew
an empty `HStack` containing a `Spacer` and looked completely normal.

Get values out of an expression, not a jump. `.filter` + index works:

```swift
let hit = phase(w).split(separator: " ").filter { $0.hasPrefix("\(key):") }
if hit.count < 1 { return "" }
return hit[0].split(separator: ":")[1]
```

`return` from inside a plain `if` (including `if let`) is fine — it is only the
`for` body that swallows it. Guard string-to-`Int` conversions with an explicit
`raw == ""` check so a nil can never reach a comparison.

Related, and the reason the top-level `let` note further down matters more than
it looks: a top-level `let` is invisible from the **view body** as well as from
func bodies, so `let toks = d.split(…)` at file scope followed by
`Text("\(toks.count)")` renders an empty string rather than failing.

## `!= nil` is not a Bool, and a non-Bool condition is false

`if w.pr != nil { return 2 }` never fired, while `if let p = w.pr { ... }`
directly beneath it worked on the same row. Comparing an object binding to nil
does not produce a Bool, and `SwiftValue.isTruthy` returns `false` for
everything that is not a Bool — so an unevaluable condition is silently a
negative rather than a mistake.

The visible symptom was subtle enough to live a long time: a workspace whose
only Review signal was an open PR — clean tree, no finished plan — fell past the
`pr` test into **Idle**, greyscaled and de-emphasised, when it was waiting for
review. Always `if let`.

## The sidebar cannot change the mouse cursor, so the affordance has to be drawn

There is no way to get a pointing-hand cursor over a tappable sidebar element.
Three independent confirmations:

- The documented interaction surface is `.onTapGesture`, `.contextMenu`,
  `.help`, `.disabled`, `.accessibilityLabel`. No cursor, no hover.
- cmux's own `docs/swiftui-interpreter-surface.md` lists `.onHover` as **not
  implemented** (marked ○, deferred), because live-appearance hover forms need
  `@State`, which the interpreter does not have.
- The host attaches exactly this to a tappable node, in `RenderNodeView.swift`:
  `.contentShape(Rectangle()).onTapGesture { }.reportTapTarget(action)`. No
  `pointerStyle` anywhere in that path — and unknown modifiers are ignored
  rather than rejected, so `.pointerStyle(.link)` validates and does nothing.

cmux already has the helper it would need (`.backport.pointerStyle(.link)`, used
in `SurfaceSearchOverlay.swift`), so upstream this is a one-line change; from a
sidebar file it is unreachable. Switching renderers does not help either —
`"renderer": "remote"` is strictly *less* input-capable ("forwarded clicks only,
no hover, focus, or keyboard").

So `crew.swift` carries the affordance in the drawing instead:

| looks like | means |
|---|---|
| chip (rounded rect, tinted fill at 0.14) | tapping it does something |
| underlined text | tapping it opens something outside the board |
| bare coloured text | status only, inert |

Every tappable also carries `.help`, so resting on it names the action. Two
deliberate exceptions: the row itself has no `.help` (a whole-row tooltip fires
whenever the pointer rests anywhere on the board), and the `✗ CI` chip is inlined
rather than built by `chipURL` so it can keep its bold weight.

`.help` is *not* a click signal — several inert badges carry one too, because
crew's own vocabulary (`⇣ stacked`, `↻ changes`) needs explaining.

## A tap can reach the system browser, and the embedded one is a separate login

A sidebar tap body is not limited to `cmux(...)`. The interpreter's action parser
recognises exactly three calls — `cmux`, `log`, and **`openURL`** — and the host
runs the last one as `DispatchQueue.main.sync { NSWorkspace.shared.open(url) }`.
So `openURL("\(pr.url)/checks")` opens in the default browser, and the argument is
evaluated like any other expression, interpolation included.

That is the right channel for anything behind a login. The embedded cmux browser
keeps its own cookies, so a PR opened with `browser.open_split` asks you to sign
into GitHub again in a browser that is not the one holding the session.

`openURL` also removes the reason those taps selected the row's workspace first.
`browser.open_split` needed a `workspace_id` or the split landed on whichever row
you were standing on; a system-browser handoff has no workspace, so the select is
pure side effect — it moves you off what you were doing.

**The `browser.hostsToOpenInEmbeddedBrowser` setting is an allowlist, and empty
does not mean "none".** With `openTerminalLinksInCmuxBrowser` and
`interceptTerminalOpenCommandInCmuxBrowser` on, a non-empty list means only those
hosts stay inside; `[]` means *no restriction*, so every link stays inside. To
push everything out to the default browser, turn the two switches off — emptying
the list does the exact opposite of what it looks like.

Note that this setting governs only links reached some *other* way: a click in a
terminal, `open https://…` from a shell, cmux's own sidebar PR row. The board's
`openURL` taps bypass it entirely.

## A "last reconciled" clock needs one carrier, because it must break the rules

The board re-renders about once a second, so the clock in its corner and every
`elapsed()` are always live. That is exactly what makes it misleading: CI, review,
Jira, sandbox and `gone:merged` only move when `crew-sync` runs, and it runs on
turn-end (throttled to `CREW_SYNC_INTERVAL`, 120s) or when you tap `↻`. With
`crew timer off` there is nothing periodic at all — so a board nobody has
reconciled in an hour is pixel-identical to a board where nothing is happening.
Two caches sit behind it besides: GitHub 300s, Jira 900s.

Publishing the reconcile time runs straight into the one-writable-field problem.
`description` is the only bindable field crew can write, and a timestamp changes
on *every* run — so whichever workspace carries it is written every run, which is
precisely what `crew-sync`'s conditional-write discipline exists to avoid.

The resolution is to stamp **one** workspace, the lowest id, and have the board
read the newest `synced:` it can find anywhere:

- one write per sync instead of one per workspace per sync;
- `max` means a leftover stamp on a former carrier is outvoted, not believed, so
  no cleanup pass is needed when the carrier closes;
- lowest-id is stable across runs and independent of cmux's ordering;
- hooks cannot clobber it — `crew_token_set` strips only its own key and
  re-appends every other token.

The stamp must also be excluded from change *reporting* (`without_stamp()`), or
`crew sync` would print a diff on every run forever and lose the one property
that makes its output worth reading: silence means converged. Verified — four
consecutive syncs, the first two reported real changes, the last two printed
nothing while the stamp still advanced.

Empty state is worth handling explicitly: with no stamp anywhere the age is
`never`, which means crew-sync has not completed a run since these workspaces were
opened — not that it is one tick late. Tint it like the worst case, because the
CI and review badges may be missing entirely rather than merely old.

## Claude session transcripts are a usable index

One JSONL per session at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`;
`claude --resume <id>` picks one back up. Measured here: **324 transcripts
across 46 project dirs**.

Useful record types, and where they sit in the file:

| Field | Where | Coverage |
|---|---|---|
| `cwd`, `gitBranch`, `timestamp`, `version` | on most records, including the first | ~all |
| first user prompt (`type: "user"`) | opening records | 321/324 |
| `{"type":"ai-title","aiTitle":…}` | near the end | **31/324** |
| `{"type":"last-prompt","lastPrompt":…}` | near the end | recent sessions |

`ai-title` is a recent addition, so anything older has none — the first prompt
has to be the fallback, not the other way round.

Files reach tens of megabytes, so read a slice from each end (64KB head, 256KB
tail) rather than the whole thing, and tolerate a clipped line at each edge.
Cache on `(mtime, size)`: 0.39s to index all 324 cold, 0.01s warm.

`~/.claude/usage-data/session-meta/` is richer — goals, outcomes, token counts —
but it only covers the 67 sessions `/insights` has analysed, so it cannot be the
index.

**29% of sessions point at a directory that no longer exists** (94/324), because
worktrees get removed and sessions outlive them. A resume UI has to detect that
rather than hand over a `--resume` that will fail.

## The board cannot see whether an agent is working

There is no `agentLifecycle` binding, and the obvious substitute does not work:
**`latestAt` is the last *message*, not the last activity.** Claude thinks and
runs tools for minutes between messages — measured here, a board row reading
`1m` beside a terminal reading `Inferring… 1m 4s`, and turns reporting
"Cogitated for 1h 16m 35s". Any freshness threshold over `latestAt` therefore
files a hard-working agent under idle.

The fix is a side channel. `description` **is** bindable and writable
(`workspace-action --action set-description` / `clear-description`), so crew
mirrors the phase into it — `working` / `waiting on you` — from the hook events
that already do socket work, never from the PreToolUse hot path. The board reads
phase first and only falls back to `unread`/`latestAt` when none is published
(a pre-crew session).

Related trap: `unread > 0` must **not** outrank the phase. A stale notification
from an earlier turn otherwise pins a busy agent to "Needs you" — which is
exactly the bug this replaced.

`sidebar.showWorkspaceDescription` is off, so the tokens do not print under
every row; the binding is readable either way.

## `workspace list --json` is the good read path

`sidebar-state` does **not** report `description`, so it cannot be used to check
whether the phase needs updating. `cmux workspace list --json` does, along with
`has_custom_title`, `current_directory`, `custom_color`, `latest_conversation_message`
and `latest_submitted_at` — one call for every workspace instead of an N+1 of
per-workspace `sidebar-state` calls.

`has_custom_title` is the honest signal for "may I rename this": false means
cmux is showing its own fallback. It beats sniffing the title for slashes.
Progress and status pills are still only in `sidebar-state`.

## The notification hook doubles as an RPC channel for the sidebar

A custom sidebar's tap action can only call `cmux(method, params)` against the
dispatcher. There is no shell action, and none of the 303 methods runs an entry
from the `actions` registry — `workspace.action` / `surface.action` are the
context-menu verbs, and `vm.exec` is for cloud VMs. So a button cannot, on the
face of it, run a script.

But `notifications.hooks` entries are shell commands cmux runs on **every**
notification, including ones created over the socket. That closes the loop:

    button  ->  cmux("notification.create", subtitle: "crew:sync-now")
            ->  cmux runs hooks/triage.py with the policy on stdin
            ->  triage.py spawns crew-sync and returns every effect false

Verified: the notification count is unchanged before and after (no banner, no
sidebar entry, no unread badge) and the reconcile runs. Zero every effect, not
just `desktop` — it is an RPC, not a message.

The same trick generalises to any crew command worth putting on the board.

## Feed's `pending` status cannot be trusted, and the window is narrow

Two measurements decide how much answer-from-the-board is safe to build.

**The window is 120s, and the median reply here is 203s.** Feed parks the hook
on a semaphore for at most two minutes, then emits `{}` and the agent falls
through to its own TUI prompt. So for this user the window has usually closed
before they look. Jump always works; reply is the minority case.

**`status: pending` is a stale flag.** Of 1721 items in `feed.list`: 1703
telemetry, 16 expired, and 2 pending — aged **61 days and 33 days**. cmux died
before their timeout fired and nothing ever marked them expired. Rendering
Allow for anything marked pending therefore offers a button whose reply lands
on a semaphore nobody is waiting on: a silent no-op that looks like success.

So liveness is derived, not trusted — all three of:

    status == pending
    updated_at within the window
    the workspace's agent is `needsInput` with a pid that is alive

The session store is the load-bearing part; Feed's own status is the weakest of
the three.

Useful shapes: a permission item carries `request_id`, `tool_name`,
`tool_input`, and `context.toolSummary`; a question carries `question_prompt`
and `question_options`. Reply methods are
`feed.permission.reply {request_id, mode ∈ once|always|all|bypass|deny}`,
`feed.question.reply {request_id, selections: [string]}`, and
`feed.jump {workstream_id}` — which returns `matched: false` rather than
erroring on a dead id, so jump is always safe to offer.

**Replies route through a script, not from the sidebar.** The interpreter could
call `feed.permission.reply` directly, but then there is nowhere to write an
audit line and no chance to re-validate between render and tap. Going through
the notification-hook RPC costs a hook spawn and buys both.

## Top-level `let` constants are invisible inside `func` bodies

The single most confusing failure so far, because it is completely silent and
`cmux sidebar validate` passes.

    let CAT_NAP = [[4,1,1], ...]        // top level

    func catFrame() -> Any {
        return CAT_NAP                   // <- yields nothing
    }

Nothing errors, nothing renders, and `\(frame.count)` interpolates to empty.
Built-in bindings (`workspaces`, `clock`, `unreadTotal`) *are* visible from
inside a func — user-declared constants are not, so the two look
interchangeable right up until one silently isn't.

Isolated by putting three markers in the same view: a plain `Rectangle` (drew),
an inline literal `ForEach([[0,0,1],[1,0,2],[2,0,3]])` (drew — so `ForEach` over
an array-of-arrays is fine), and `Text("n=\(frame.count)")` (empty — so the
array never arrived). Two of the three functions in the same file worked, which
is what makes it confusing: `catColor()` used only literals and `catSays()` used
`workspaces`.

Keep data local to the function that consumes it, or pass it in as a parameter.

## A string interpolation containing its own string literal renders nothing

Same silent class as the one above, found while adding deep-plan's chips. This

    Text("\u25c8 \(tokenValue(w, "planinc"))")

does not render a partial label or an empty one — the entire enclosing `if` block
vanishes from the IR. `cmux sidebar validate` passes, `render_probe.py` reports a
node count with no error, and the chip is simply not there.

Every interpolation that already worked in this file interpolates a *binding*, never
a call carrying a literal: `"#\(pr.number)"`, `"\(pr.url)/checks"`, `"\(feedLeft(w))s"`.
The fix is to move the literal out and interpolate a parameter instead:

    func planCount(_ v: String) -> String { return "\u25c8 \(v)" }
    Text(planCount(tokenValue(w, "planinc")))

`crew.swift` now has five such helpers (`planCount`, `planGoLabel`, `planGoTip`,
`planUrl`, `planWorkTip`) for no other reason.

## The signals strip is gated, so a lone token renders nothing

Not an interpreter limit — a condition in this file, but it presents identically to
one and cost the same hour:

    if has(w, "ci:") || has(w, "review:") || has(w, "pr:conflict")
        || has(w, "sandbox:") { HStack { ... } }

Everything inside that `HStack` — the CI chips, the Jira status chips, the sandbox
chip — only appears when one of those four prefixes is present. A row carrying only
`jira:in-progress` renders no strip at all, which is a live latent bug: those chips
are unreachable unless the row also has CI, a review, a conflict or a sandbox.

`planinc:` was added to the condition so plan rows get a strip. **`jira:` was
deliberately left alone** — adding it changes rows that have nothing to do with
plans, and that is a decision, not a fix to slip in sideways.

## The board cannot host search, or any non-cmux data

Two hard limits on the custom-sidebar interpreter, both from the docs and both
confirmed by building against it:

- **No `@State`**, and therefore no `TextField`, `Toggle`, `Slider`, or
  `Picker`. Buttons and taps that run `cmux(...)` work; two-way-bound editing
  does not exist. A search box is not expressible.
- **Bindings are cmux's own workspace data only.** "Data cmux doesn't track
  (custom domain collections) won't appear" — so Claude transcripts, git log,
  or anything else off the workspace model cannot be rendered there at all.

Anything needing either belongs in a TUI in a pane or Dock control, not the
sidebar. That is why `crew-resume` and `crew-diff` are curses/shell pickers.

## cmux already infers a lane; overriding it pins it

From the docs: status "is inferred from live signals (agent needs input / agent
running / open PR / merged PRs / dirty tree)". Setting a lane explicitly pins it
and suppresses that inference until you set `auto` again.

This is why crew is conservative. It only pins:

- `needs-attention` on `Notification` (Claude is blocked on you)
- `review` on `Stop` **and only when `crew_has_unreviewed_work` is true** — a
  dirty tree or commits ahead of upstream. A plain question-answering turn
  releases to `auto` instead, so it doesn't park the workspace in review.

and releases on the next tool use. Fighting the inference wholesale would be
worse than not overriding at all.

cmux also posts its own notification when a workspace first reaches `done` and
when its checklist first completes — free signals, no wiring needed.

## `cmux todo set` is an atomic bulk write

The obvious mirror of an agent's task list is `todo clear` + N × `todo add`,
which is N+1 socket calls on every task update. But:

```
$ cmux todo set
Error: Usage: cmux todo set '[{"text":"...","state":"pending"}]' (or pipe the JSON on stdin)
```

One call, whole list, idempotent. States are `pending|in-progress|completed`.
`hooks/progress.sh` uses this, so publishing a 12-item plan costs one round trip.

## Claude Code persists task state on disk

`~/.claude/tasks/<session_id>/<n>.json`, one file per task:

```json
{"id":"6","subject":"Write ADR 005 …","description":"…",
 "activeForm":"Writing ADR 005 (optimistic concurrency)",
 "status":"completed","blocks":[],"blockedBy":[]}
```

The directory also holds `.lock` and `.highwatermark`, so filter on a parsed
object with a `subject`. Reading this beats parsing the `PostToolUse` payload,
which only carries the delta for the one task that changed.

## `cmux diff` takes any patch on stdin — that is the per-commit hook

Built-in sources are `unstaged`, `staged`, `branch`, `last-turn`. There is no
per-commit source, and none is needed:

```sh
git show <sha>      | cmux diff -    # one commit
git diff a..b       | cmux diff -    # a range
gh pr diff <n>      | cmux diff -    # a pull request
```

Two caveats found by testing:

**`--last-turn` is scoped to the calling surface.** The help says "changes since
*this surface's* last agent-turn baseline". Run from a Dock pane or a second
split, that surface has no baseline. `--session <id>` scopes it explicitly, and
the id is in `~/.cmuxterm/claude-hook-sessions.json` under
`activeSessionsByWorkspace[<CMUX_WORKSPACE_ID>].sessionId`.

**The built-in sources open an empty viewer rather than declining.**
`cmux diff --unstaged` on a clean tree opens a blank split you then have to
close. `crew-diff` pre-checks with `git diff --name-only` and refuses.

Piped patches are handed over as a temp file rather than on the pipe, because
cmux reads the source when the split opens, not when the command returns.

## `shortcuts.bindings` only accepts built-in action ids

The schema constrains `shortcuts.bindings` keys to an enum of cmux's own action
ids, so a custom action cannot be bound there. Custom actions carry their own
`shortcut` field instead, taking the same string-or-two-item-array chord syntax
(`["cmd+k", "d"]`). `cmux shortcuts` does **not** list them, so there is no way
to verify a custom chord from the CLI — you have to press it.

`cmd+k` is free: absent from cmux's bindings and from the Ghostty config, which
only binds `cmd+ctrl+backquote` and `cmd+shift+r`.

## VS Code: the desktop app, not `serve-web`

Measured 2026-08-12 against VS Code 1.132.0, macOS 26.5. The CLI is **not** on
`PATH`; it lives at
`/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`.

crew ran `code serve-web` in a cmux browser pane for its first month, which put
the real editor and its diff viewer next to the agent terminal. Two structural
problems retired it, neither fixable by configuration:

**serve-web is a different editor install.** Its extensions live in
`~/.vscode/cli/serve-web/<commit>/extensions` — 96 directories, every one of
them a VS Code built-in. The 17 marketplace extensions in `~/.vscode/extensions`
are invisible to it, so claude-code, the GitHub PR extension, Kotlin and Gradle
are simply absent from the web editor.

**Its workspace-trust store is separate too.** Trusting a folder in the desktop
app does nothing for the same folder under serve-web, so every worktree asks
again.

The server component measured **672MB** in `~/.vscode/cli`, not the ~100MB the
docs imply.

## `code <folder> --goto <file>` is the entire desktop mechanism

One call, both cases, ~1.2s cold or warm:

- no window on that folder → a new window opens on it, with the file loaded
- a window already has it → that window is focused and the file arrives as a
  tab, with no duplicate window and no reload

**Routing is by containment, and it is path-exact.** VS Code picks the window
whose folder contains the file. Verified against the trap case: with windows
open on both `~/code/main-repo` and
`….worktrees/migrate-dms-docs-to-monolith`, each one's `Rakefile` landed in its
own window despite identical basenames — and the `.worktrees` sibling being a
path-prefix neighbour of the primary checkout changed nothing.

**Naming the folder is not optional.** `code --goto <file>` alone, for a file in
a worktree that has no window, does **not** open one — it drops the file into
whichever window was last active. Nothing errors. You end up editing the right
file with some other branch's Source Control beside it.

**`--goto` on a nonexistent path opens an empty buffer** instead of failing, so
it proves nothing on its own. Two of the first routing probes here used
`Rakefile` and `Gemfile`, neither of which exists at the monolith root; they
demonstrated window assignment but not file opening. Re-run with `AGENTS.md`
and `CODEOWNERS`, which do exist.

## Which VS Code windows are open, asked from outside

Neither available source answers alone:

- `~/Library/Application Support/Code/User/globalStorage/storage.json` →
  `windowsState.openedWindows[].folder` carries the **exact folder URI** of
  every window and is rewritten as windows open. It is a persisted snapshot.
- `code --status` is the **live** view, but names folders by basename only
  (`|    Folder (migrate-dms-docs-to-monolith): …`) and costs ~1.2s.

Intersecting them yields live windows with real paths, which is what
`crew-code windows` returns.

Guard it on the app actually running, and match the **bare** process:
`pgrep -f "…/MacOS/Code$"`. Without the `$` anchor every `code`-launched CLI
subprocess matches too and the app looks up when it is down. The guard is not
cosmetic — `code --status` will *launch* VS Code just to answer.

**Nothing can close a window from outside.** VS Code ships no `code --close`,
and the AppleScript route fails here with
`osascript is not allowed assistive access (-25211)`. So a reclaimed worktree's
leftover window can only be warned about, never cleaned up.

## The cmux CLI refuses detached processes, and crew consumed that silently

`hooks/triage.py` turns a board tap into a shell command with `fire()`, which is
`Popen(..., start_new_session=True)` — deliberately detached so the hook can
return its policy JSON to cmux immediately.

The cmux CLI authorizes a caller that is **either** a live descendant of the cmux
app **or** carrying the `CMUX_SOCKET_CAPABILITY` / `CMUX_SOCKET*` environment it
hands to its terminals. A detached command has neither:

- the notification hook itself **is** authorized — a direct child of the app,
  even though its whole environment is just `CMUX_NOTIFICATION_{TITLE,SUBTITLE,
  BODY,SURFACE_ID,WORKSPACE_ID,POLICY_JSON}`, with no capability token
- the command `fire()` spawns outlives the hook, so its parent becomes pid 1 —
  not a descendant, still no token — and every CLI call answers
  `Error: ERROR: Access denied - only processes started inside cmux can connect`

Two tests pin it down. `env -i HOME=… PATH=…` from a cmux terminal still works,
so it is not the environment alone. A `start_new_session=True` child of a *live*
cmux-terminal parent also works, because it inherits the token. Only the
detached-and-orphaned combination is refused.

**It is the token, not the ancestry — measured.** Orphaning alone is not what
cmux objects to. From a cmux terminal, two `start_new_session=True` children whose
parent had already exited, both at `ppid=1`:

    inherited env intact          → PONG
    same, minus CMUX_SOCKET*      → Access denied

So a detached daemon keeps access indefinitely *as long as it carries the
capability env*. This corrects the natural but wrong reading of the paragraph
above — that being orphaned is itself disqualifying, or that macOS is attributing
a responsible process. Neither is happening; the check is the environment.

**Which is exactly why launchd cannot run crew's jobs.** A launchd job is neither
a descendant nor a holder of the token, so it is refused:

    launchctl submit … cmux ping  → Access denied

and the consequence is silent, because `crew-sync` swallows CLI failures. Proven
with the freshness stamp: after a launchd-run sync the stamp was still 140s old,
while the identical binary run from a cmux terminal moved it to 3s. `crew timer`
is therefore a no-op, and the `com.crew.listen` job respawned every 10s doing
nothing.

Pasting a token into the plist is not the fix: it is minted per cmux session and
goes stale on restart. The working shape is to spawn the daemon from something
that already holds a live token — a cmux terminal, i.e. a Claude `SessionStart`
hook — and let it detach. Note that the *notification* hook is the wrong parent
for this despite being a child of the app: as the bullets above record, its
environment carries no capability token at all.

**The bug this caused.** `crew-code --workspace <id>` ran
`cmux sidebar-state --workspace <id> | sed -n 's/^cwd=//p'`, which turns the
denial — printed on stderr — into an empty string. The empty cwd fell through to
`${WS_CWD:-$PWD}`, and `$PWD` for a child of the cmux app is `~/.config/cmux`.
So tapping a branch on the board opened **crew's own config directory** in VS
Code instead of the worktree. Nothing errored.

Two fixes, both needed:

1. `triage.py` resolves the workspace id to a path *before* `fire()`, while it is
   still authorized, and hands the command the path. `crew-code` and
   `crew-sandbox` both already accept a bare path.
2. `crew-code` and `crew-sandbox` **refuse** when `--workspace` was given and no
   cwd came back, instead of falling through to `$PWD`. A named target that
   cannot be resolved is never the current directory.

**Still on the broken channel.** `crew:sync-now` and `crew:feed-allow` /
`crew:feed-deny` need the CLI for the *action*, not just a lookup, so the
resolved-path handoff does not save them. A real fix means doing that work
inside the hook, which would stall notification delivery for as long as it takes.

`crew-reclaim`'s `close-workspace` **is off it now**, by a different route: the
hook no longer fires the command detached, it opens a terminal pane and runs it
there. A pane inherits the capability token like any cmux terminal, so
`crew-reclaim` has the whole CLI — see *The board can open a terminal, and that
is how a tap gets a prompt*.

## Workspace trust leaves no trace until you use it

No `content.trust.model.key` — no trust-related key at all — exists in
`state.vscdb` or `storage.json` on a machine that has never explicitly trusted a
folder. So absence cannot be read as "trust is off". `crew doctor` scans the
values of every trust-ish key for `file://$HOME/code` and warns when it finds
nothing.

This matters because every worktree is a path VS Code has never seen: an
untrusted parent means a modal per worktree, and declining leaves the window in
Restricted Mode with extensions disabled — the exact failure that moving off
serve-web was meant to fix. Trusting the parent folder `~/code` once covers
every worktree created under it, forever.

## `app.preferredEditor` is a shell command with a hard fallback rule

From `PreferredEditorService.open(_:)`:

```swift
process.arguments = ["-c", "\(command) \(url.path.posixShellSingleQuoted)"]
```

- run as `/bin/sh -c "<command> '<path>'"`; the path is single-quoted and
  appended as the **last argument**. No placeholders, no line number.
- stdout and stderr are discarded, so a command cannot report anything.
- **a nonzero exit falls back to the macOS default handler.** That is a feature:
  `crew-code-open` exits 1 for paths outside a repo and lets macOS take them.

**`app.openSupportedFilesInCmux` gates the whole thing.** While it is `true`
(the default), cmux previews every type it can handle and `preferredEditor` is
only consulted for the leftovers — a `.rb` Cmd-click never reaches it. The two
settings have to agree; `crew doctor` checks that they do.

`fileExplorer.doubleClickAction: "preferredEditor"` routes the file tree to the
same command.

## A cmux action always spawns a host tab — there is no headless target

```swift
enum CmuxConfigTerminalCommandTarget: String {
    case currentTerminal
    case newTabInCurrentPane
}
static let defaultForActions: CmuxConfigTerminalCommandTarget = .newTabInCurrentPane
```

Those are the only two. `currentTerminal` types the command into whatever is
already running in the pane — which, when that is Claude, means the command
text lands in Claude's prompt. So any `command` action gets a new terminal tab,
and for a fire-and-forget command (open a diff, open a pane) that tab is litter
left behind on every invocation.

The fix is for the command to close its own tab: `CMUX_SURFACE_ID` is set in
every cmux terminal, so `cmux close-surface --surface "$CMUX_SURFACE_ID"` as the
script's last act removes the host tab.

Two rules make that safe:

- **Gate it on an env var the action sets** (`CREW_EPHEMERAL=1`), never
  unconditionally. Run by hand from your own terminal the variable is unset and
  nothing closes — otherwise `crew-diff branch` would close the terminal you
  typed it in.
- **Put it on the success path only.** A failure then leaves the tab up with the
  error still readable, which is the whole reason you would look at it.

Note that `cmux diff` also defaults `--surface` to `$CMUX_SURFACE_ID` as the
surface to split from. The diff lands in its own pane, so closing the host tab
afterwards does not take it with it.

## Two cmux commands, two output formats

`cmux diff` prints labelled fields, `cmux new-pane` prints positional ones:

```
cmux diff       ->  OK surface=surface:17 pane=pane:5
cmux new-pane   ->  OK surface:36 pane:10 workspace:1
```

A parser written against one silently returns nothing for the other, which is
how the VS Code pane first ended up stacking a new split on every Cmd-click
instead of reusing one. `awk '{print $2}'` handles both.

With `--id-format uuids` the output is `OK <surface> <pane> <workspace>` — bare
UUIDs, no labels at all. Store UUIDs, not short refs: `surface:7` is positional
and shifts as panes come and go, and `cmux browser --surface <stale-ref> goto`
fails with `Invalid surface handle`.

## `cmux` on PATH is a per-session shim

```
$ which cmux
/var/folders/…/T/cmux-cli-shims/AD250BDC-…/cmux
```

It is scoped to a terminal session and disappears between app launches. Scripts
that may run outside a cmux terminal must fall back to
`/Applications/cmux.app/Contents/Resources/bin/cmux`. `hooks/lib.sh` does.

## The built-in `claude_code` status pill already exists

```
$ cmux list-status
claude=Bash color=#f59e0b            <- the v1 hook's pill
claude_code=Running icon=bolt.fill   <- cmux's own, via the Claude wrapper
```

A custom pill that reports the current tool duplicates cmux's. crew spends the
pill on something cmux cannot know: the `activeForm` of the in-flight task.

## cmux's `needsInput` is not "blocked" — it is "at a prompt"

`agentLifecycle` in `~/.cmuxterm/claude-hook-sessions.json` takes `running`,
`needsInput`, `idle`, `unknown`. Only `running` is safe to reconcile a phase
from. `needsInput` is set whenever Claude is sitting at its prompt, which is
equally true of:

- an agent blocked on an AskUserQuestion / permission prompt — really needs you
- an agent that finished its turn an hour ago and was left open — does not

Measured here: five live Claude processes, all `needsInput`, none blocked.

`crew-sync` reconciled `needsInput` → `phase:waiting`, which re-added the token
the Stop hook had just cleared. Consequences, all of them visible on the board:

- every idle Claude session sat in **Needs you** until its terminal was closed
- `bucket()` tests `phase:waiting` before `gone:merged`, so shipped worktrees
  showed as urgent rather than reclaimable — four of six rows here
- the `needs-attention` lane was only released for a *mid-turn* agent, so a
  session that got answered and then went quiet kept the lane indefinitely

The rule that works: **keep, never mint.** For `needsInput`, carry forward a
`phase:waiting` the hooks published and publish nothing otherwise. The hooks
already have this right — `Notification` sets it, `Stop` clears it — so the
reconciler's job is to not overwrite them with a coarser signal.

## The workspace unread count is not an agent signal

`w.unread` counts anything cmux recorded for a workspace that you have not
looked at. Any pane raises it: a shell bell, a finished command under shell
integration, output in a background split. `bucket()` used `unread > 0` as a
"Needs you" fallback for sessions whose hooks are not live, which meant a
workspace with a couple of busy terminals could put itself there with no agent
involved at all. It is not a fallback for a blocked agent, and there is no
per-source breakdown to filter it with — the sidebar sees a single integer. So
it no longer affects bucketing, only the header badge.

## Feed is already bridging Claude's blocking prompts

`~/.cmuxterm/workstream.jsonl` holds 2483 events, all `source: claude` —
including 122 `permissionRequest` and 54 `question`. Permission / AskUserQuestion
/ ExitPlanMode already reach the sidebar and native banners through Feed. The
work is to stop *duplicating* those, not to add them.

## `gh pr checks` already covers RWX

The `rwx` CLI (v3.17.1) has no "runs for this branch" command — `rwx results`
needs a run ID. But RWX reports as a GitHub check:

```
$ gh pr checks
RWX: ci.yml (pull request)  fail  0  https://cloud.rwx.com/your-org/runs/65f9810e…
your-org/ci              pass  0  https://buildkite.com/…
your-org/jira-check      pass  0  PR title contains valid Jira issue ID: PROJ-961
mergefreeze                 pass  0
```

One Dock control, not two.

## macOS has no `watch`

Hence `bin/crew-watch`. It uses the alternate screen so exiting a Dock control
restores the pane, and prints a status dot + timestamp header so a Dock pane is
self-describing.

## A fresh worktree cannot commit in the monolith

`core.hooksPath` is `.husky`, and two things the hooks need are untracked, so
`git worktree add` alone produces a checkout where every commit fails:

- `.husky/_/husky.sh` — generated by `npm install`
- `node_modules/` — the hooks shell out to wrappers in it

Existing worktrees have `.husky/_` copied and `node_modules` symlinked to the
primary checkout. `bin/crew-worktree` does both. The usual escape,
`git commit --no-verify`, is blocked on purpose by
`~/.claude/hooks/cmux/guard_bash.sh`.

## Hook cost

Measured with 40 iterations on this machine:

| Hook path | Cost | Fires |
|---|---|---|
| `pretool`, no override outstanding | **9.1 ms** | every tool use |
| `pretool` via the general path (before the short-circuit) | 15.7 ms | — |
| `set_status_running.sh` (the v1 hook crew replaces) | **51.5 ms** | every tool use |
| `session` (git + python + 3 socket calls) | 193 ms | once per session |

The hot path is short-circuited *before* `lib.sh` is sourced — parsing the
library costs more than the work it would do. Net effect: crew is about 5.7×
cheaper per tool use than the bridge it replaces, because the v1 hook made an
unconditional socket call every time and crew makes none unless a lane override
is actually outstanding.

**Turn end used to fan out.** `stop` cleared five description keys with five
separate `crew_token_set` calls, and each one is a full read-modify-write: a
`workspace list --json` socket read piped through `python3`, then a
`set-description` write. Five of them is 5 reads, 5 writes and 10 process forks
per turn -- and because each re-read the description the previous call had just
rewritten, they raced against each other for no benefit.

`crew_token_clear <key>...` does the whole set in one read-modify-write, and skips
the write entirely when nothing changed. That last part matters more than it
looks: an ordinary turn has none of those keys set, so the old code wrote an
identical description -- and one `workspace.action` event -- every single turn.
Those events are why crew-listen must never subscribe to `workspace.action`: at
187/day it was mostly crew listening to itself.

## Docker Sandboxes: `sbx`, not `docker sandbox`

Measured 2026-08-11 against **sbx v0.38.0**, Docker Desktop 4.75.0, macOS 26.5,
arm64.

The `docker sandbox` Desktop CLI plugin on this machine is **v0.12.0 and
deprecated** — removed entirely at Docker Desktop 4.80.0, and missing `cp`,
`ports`, `policy`, `secret`, `inspect`, `template`, `--publish`, `--memory`.
The live product is a standalone binary, `sbx`.

Install is a **cask in an untrusted tap**, so the obvious command fails:

```sh
brew tap docker/tap
brew trust docker/tap                 # required — cask, not formula
brew install --cask docker/tap/sbx
```

Its daemon is at `~/.sbx/run/d/sandboxd.sock`, entirely separate from the
plugin's `~/.docker/sandboxes/sandboxd.sock`; the two coexist, so the plugin
need not be uninstalled. The daemon is a **real dependency with its own
lifecycle** — everything 401s or hangs without it, and `sbx daemon start`
*without* `-d` runs in the foreground:

```sh
sbx daemon start -d --policy balanced
```

## The mount model for a git worktree

A worktree **cannot be mounted alone**. Its `.git` is a pointer file
(`gitdir: <primary>/.git/worktrees/<dir>`), so with only the worktree mounted git
inside has no repository at all. `node_modules` fails the same way — it is an
*absolute* symlink into the primary checkout. sbx exposes every workspace at its
**host path**, so mounting the primary checkout makes both resolve unchanged.

Verified inside a sandbox over the monolith worktree: `git status`, `git log`,
`git branch --show-current` all work, and a real `git commit` succeeds and lands
on the host immediately (virtiofs passthrough, not a copy).

**`<monolith>:ro` is rejected.** `sbx create … "$MAIN:ro"` prompts *"The selected
workspace does not exist. Would you like to create it?"* and aborts.
Deterministic, and not stateful — it fails with zero sandboxes present. Ruled
out by experiment: `:ro` itself (other repos and `$MAIN/gems:ro` mount fine),
registered worktrees (a synthetic repo with a worktree mounts `:ro` fine), stale
worktree registrations (none), dangling symlinks (none), path prefix collision
with the `.worktrees` sibling (synthetic sibling-prefix pair mounts fine). Cause
unknown; a trailing slash (`$MAIN/:ro`) is accepted but **silently drops the
mount**, which is worse than failing.

So the primary checkout goes in **read-write**. The cost is real: the agent can
write the primary checkout and its `.git`, which carries every worktree's
history. What still holds is the outer boundary — verified from inside, unmounted
host paths (`~/code/rikipedia`, `~/code/lh-data-workflow`, `~/.ssh`, `~/.aws`)
are **invisible**.

### Only the primary workspace is echoed

`sbx create` prints one `workspace …` line — the first path. Extra workspaces
mount correctly but are **never shown**, so the resolve summary cannot be used to
confirm them. Check from inside instead.

## `~/.claude:ro` is accepted, and the read-only really is enforced

Measured 2026-08-12, sbx v0.38.0. `sbx create … "$HOME/.claude:ro"` is accepted —
unlike `<monolith>:ro`, which is still refused for reasons never found. Inside,
the mount appears at its host path and `touch` there fails:

```
touch: cannot touch '/Users/…/.claude/ESCAPE-TEST': Read-only file system
```

That closes the escape vector that ruled out mounting it at all: the sandbox can
read the config but cannot rewrite the `settings.json` hooks the host Claude
executes. **Symlinks from a writable directory into the ro mount resolve
normally**, for both files and directories — which is what makes `--claude=link`
work: the per-sandbox config dir stays writable for `projects/` and history while
`CLAUDE.md`, `skills/`, `commands/` and `plugins/` are links into the ro mount.

`settings.json` must be copied and filtered, not linked. Its `hooks` name
`~/.config/cmux/crew/hooks/*`, which is not mounted, and `statusLine` names
`~/.claude/statusline.py`; Claude reports an error on every event for a hook it
cannot execute. `mcpServers` names host processes.

## Claude's login is in the Keychain, so no mount can carry it

There is no `~/.claude/.credentials.json` on macOS. The credential lives in the
login Keychain under service `Claude Code-credentials`, and **two items share
that service name**:

| `acct` | Holds |
|---|---|
| `unknown` | `mcpOAuth` only — MCP connector tokens, nothing to do with the account |
| `$USER` | `claudeAiOauth` — accessToken, refreshToken, expiresAt, scopes, subscriptionType |

`security find-generic-password -s "Claude Code-credentials" -w` returns the
*first* match, which is the connector one — the account credential needs
`-a "$USER"`. Writing `{"claudeAiOauth": …}` to `$CLAUDE_CONFIG_DIR/.credentials.json`
inside authenticates a sandboxed Claude: verified with a real round trip through
`claude -p`.

Two costs, both real and neither fixable from here. The token lands in plaintext
on the host outside the Keychain, and it is handed to an agent that could send it
anywhere. And Claude refreshes it in place, so a sandbox holding it past
expiry rotates the refresh token without the host Keychain learning — which can
log you out on the host.

## A registry reader must `unset` before sourcing

`crew-sandbox`'s registry files are shell-sourceable, and read back in a subshell:

```sh
( . "$f"; printf '%s' "${CLAUDE_MODE:-}" )
```

`CLAUDE_MODE` and `TEMPLATE` are *also* globals in that script, so the subshell
inherits them — and a registry file written before the field existed silently
returns the current value instead of empty. A sandbox created without the
`:ro` mount confidently reported `claude link`, which would then have seeded
symlinks into a mount that was not there. `( unset CLAUDE_MODE; . "$f"; … )` is
the fix, and the same applies to every sourced-file reader whose keys collide
with a variable already in scope.

## Never mount `~/.claude` read-write

*(Superseded in part: `:ro` is fine and is what `--claude=link` uses — see
"`~/.claude:ro` is accepted" above. What follows is why **rw** stays out.)*

Mounted rw it comes back **writable**, which lets a sandboxed agent rewrite the
`settings.json` hook entries that the *host* Claude executes. That is an escape
path, not a convenience.

A mount alone would not have been enough anyway: **`$HOME` inside the sandbox is
`/home/agent`**, not the host home, so a `~/.claude` mounted at its host path is
not where Claude looks — `CLAUDE_CONFIG_DIR` has to point at it either way. This
is the real content of the "sbx does not pass through user-level config"
limitation.

crew mounts a **per-sandbox config directory** instead —
`~/.cache/cmux-crew/sandbox/claude/<name>` — and points Claude at it with
`CLAUDE_CONFIG_DIR`. Transcripts and task state then land on the host, which is
what lets `crew-sync` see phase for a sandboxed workspace.

`sbx run` has **no `-e` flag**, so the variable has to be planted inside.
`/etc/sandbox-persistent.sh` is the documented hook and is sourced for **both
login and non-login** shells (verified). `crew-sandbox` writes it idempotently at
`up`, so a sandbox created before this existed self-heals.

## Sandbox performance is a non-issue

Timed on the monolith worktree — 2.0 GB `.git`, 192,719 commits, 1.3 GB
`node_modules`:

| Operation | Host | Sandbox (virtiofs) |
|---|---|---|
| `git status --porcelain` | 0.54 s | 0.75 s |
| `git rev-list --count HEAD` | 0.14 s | **0.07 s** |

virtiofs caching is on by default. The worry about a 2 GB `.git` over a bind
mount did not materialise; `rev-list` was *faster* inside.

## Each sandbox has its own Docker daemon

Verified: `docker info` inside reports its own server (29.7.1, 0 containers),
independent of the host. This is the whole reason to sandbox the *services* —
`docker compose up postgres` inside a sandbox does not contend with the host's
5432, which is what stopped parallel worktrees from running specs at once.

The cost is that sandboxes **share no image layers**, so every one re-pulls
postgres/redis and re-runs `bundle install` unless a template is baked once with
`crew-sandbox base` (`sbx save`).

## bash 3.2 breaks empty array expansion

macOS ships bash 3.2.57, and `#!/usr/bin/env bash` resolves to it. Under
`set -u`, `"${arr[@]}"` on an **empty** array is an unbound-variable error, not an
empty expansion. Use the guard form:

```sh
cmd ${arr[@]+"${arr[@]}"}
```

This bit `crew-sandbox` when no template image was present.

## cmux already has a per-workspace color, and the sidebar already binds it

`custom_color` is a first-class writable field on a cmux workspace, and the plan
for crew's identity colors was going to carry them in a `description` token like
every other crew signal. It does not need to:

    cmux workspace list --json        → "custom_color": null | "#RRGGBB"
    cmux workspace-action --action set-color --color <name|#hex>
    cmux workspace-action --action clear-color
    cmux sidebar-state --workspace X  → color=#RRGGBB | color=none

and the sidebar DSL binds it as **`w.color`** (docs list it beside `branch` and
`dirty`). So the board reads the same field cmux paints its own workspace strip
with — no token, no parsing, no crew-sync round trip to get it onto the board, and
the color is correct in cmux's *native* sidebar for free.

Measured, because none of it is documented in one place:

- `--color '#1565C0'` is stored **verbatim**. Nothing snaps it to a nearby
  named color, so a crew-owned palette does not need cmux's blessing.
- `--color Amber` resolves to `#7D6608`, and cmux's sixteen names resolve to
  exactly the sixteen hexes already hard-coded in `crew_ticket_color`. That
  comment claiming "cmux's own 16 workspace colors" is literally true — the
  ordering differs, the set does not.
- it reads back on both `sidebar-state` and `workspace list --json`, and
  `clear-color` returns it to `none`.

**Sixteen colors, twenty worktrees.** There is no free-slot guarantee to be had,
so `crew-color` prefers a hash-derived color when that slot is free (a worktree
tends to keep its color across a prune-and-return) and otherwise takes the
least-used one, spreading the overflow instead of stacking it.

## A color worn by hand is just as taken as one crew allocated

Two bugs, both from treating crew's registry as the whole truth about who holds
what. Both surfaced on the first real run, and neither would have shown up in a
synthetic test.

1. **Allocation duplicated a manual color.** Three worktrees had been colored by
   hand in cmux's picker and so had no registry entry. `pick()` counted only
   registry entries, handed a fresh worktree the Purple one of them was already
   wearing, and the board grew two identical slivers. `pick()` now also counts the
   colors live cmux workspaces are wearing.
2. **`apply` overruled the color the workspace already had.** Worse, because it
   broke the entire premise: for those same three worktrees `assign()` allocated a
   *rival* hex, so the Peacock window came up Magenta while the cmux strip stayed
   Indigo. `assign()` now **adopts** a color already worn in cmux instead of
   inventing one — which also means a color picked by hand propagates out to VS
   Code rather than being fought over.

The rule that falls out: cmux's `custom_color` is the source of truth, crew only
ever fills a blank. crew cannot distinguish its own assignment from a hand-picked
one — cmux's picker offers exactly crew's sixteen — so overwriting anything
non-empty would eventually clobber a deliberate choice.

## Peacock is a settings file, and `.vscode/` is already gitignored

Peacock (`johnpapa.vscode-peacock`) has no CLI, and `code` cannot invoke an
extension command — there is no `code --command`. The only way in is the workspace
settings file, which turns out to be the easy path:

- `.gitignore:67` is `.vscode/`, and `git check-ignore` confirms it applies
  **inside worktrees** too. So per-worktree Peacock settings never dirty the tree
  and never reach the board's dirty dot. If that directory were tracked, every
  colored worktree would read as modified.
- Peacock's `activationEvents` is `["*"]`, so it activates in every window and
  recomputes `workbench.colorCustomizations` from `peacock.color`. crew writes
  **both** anyway: the window is colored the instant it appears instead of after
  the extension host wakes up, and it still works with Peacock disabled. Any
  divergence in the arithmetic self-heals the moment Peacock runs.
- The write is a key-level merge, so unrelated settings survive, and `free`
  removes exactly Peacock's keys. `settings.json` is JSONC — comments and trailing
  commas are legal and `json.loads` rejects both — so parsing strips them, and an
  unparseable file is **refused** rather than overwritten.

`crew-code` applies the settings *before* launching, and VS Code picks up the
write live on a window that is already open, so re-running it recolors in place.

## `/bin/true` does not exist on macOS

Only `/usr/bin/true`. Stubbing a launcher with `CREW_CODE_BIN=/bin/true` made
`crew-code` report "VS Code CLI not found" — which reads like the bug being
tested rather than a bad path in the test itself.

## Plan mode is in the transcript, as a timestamp-free line written every turn

Claude Code records the permission mode in the session transcript as its own
entry type:

```json
{"type":"permission-mode","permissionMode":"plan","sessionId":"da322d7d-…"}
```

Three properties that decide how to read it, all measured on one 8.7MB
transcript:

- **It is written every turn, not on change.** 213 entries for 4 actual
  transitions. So there is no "mode changed" event to react to.
- **It carries no timestamp.** The keys are exactly `type`, `permissionMode`,
  `sessionId`. Byte position in the file is the only ordering available, which
  makes *last occurrence* the only correct read.
- **The last one sat 15KB from EOF.** So a tail read is not a heuristic — the
  entries are dense near the end by construction. crew reads 256KB and returns ""
  on a miss rather than falling back to a full scan; a missing badge is much
  cheaper than making every turn-end slow.

Values seen across 14 live sessions: `auto` (13), `acceptEdits` (1), and `plan`
during a planning session. It is the full permission mode, not a plan flag, so
match `== "plan"` rather than truthiness.

**It must be gated on the session being alive.** The transcript keeps its last
value forever, so a session that once planned reads as planning for the rest of
time. crew gates on the `pid` from `claude-hook-sessions.json`.

The workspace → session link already exists:
`~/.cmuxterm/claude-hook-sessions.json` → `activeSessionsByWorkspace` →
`sessionId`, and the transcript is `~/.claude/projects/*/<sessionId>.jsonl`. Glob
for it rather than reconstructing the munged-cwd directory name — that munging is
Claude Code's rule, not crew's.

## `/deep-plan` has no observable state, so it has to leave one

There is nothing in the transcript, in cmux, or in Claude Code that says "a
deep-plan is in progress". A `Skill` tool_use records that one *started*
(`"name":"Skill","input":{"skill":"deep-plan"}`) and nothing records that it
finished, so any transcript-derived answer would latch on forever.

So the skill brackets it with a file. `render_plan.mjs` writes
`~/.claude/deep-plan/active/<slug>` and `grade_quiz.mjs` removes it on exit 0 —
which makes the marker's lifetime exactly *a plan is rendered and nobody has
signed off*. Only written when the spec actually has a quiz; with no check to
pass, nothing would ever clear it.

The marker carries two keys because each covers the other's blind spot:

    SESSION   CLAUDE_CODE_SESSION_ID — exact, and already how crew maps
              workspaces, but it changes when the session restarts
    CWD       the git root — survives /compact and a resume, but is wrong if the
              renderer ran from anywhere other than the worktree

crew matches on either. `CLAUDE_CODE_SESSION_ID` is a real environment variable in
a Claude Bash call and equals the transcript filename, which is what makes the
exact match possible at all.

Two workspaces on the same worktree both get the badge. That is correct: a plan
belongs to the worktree, not to the pane that drafted it.

## Badges flickered because crew asked cmux whether to ask GitHub

Three defects, one shape: crew-sync deciding whether to *probe*, and publishing
the silence when it decided not to.

**1. The probe was gated on cmux's own `pr` field.** `signals(cwd, has_pr)` took
`has_pr` from `sidebar-state`'s `pr=` line, which comes from cmux's
snapshot-then-diff PR watch. When that blipped to `none`, crew skipped the gh call,
wrote a description with every `ci:`/`review:`/`pr:`/`stack:` token missing, and
stayed wrong — because skipping the probe also stopped the cache refreshing, so
nothing pulled it back. Measured over two days of `events.jsonl`: **11
lost-then-restored cycles**, the worst a 17-minute gap on `ci:fail pr:draft`.

Gate on `toplevel(cwd)` instead. Whether a directory is a git checkout is a local,
stable fact; whether cmux currently believes in a PR is neither.

**2. A failed fetch still stamped the cache fresh.** `out["at"] = now` ran on the
fallback path, so one blip pinned the previous answer for another full `GH_TTL` —
and since the next run then read the cache as fresh, it never retried. Observed at
**5 days old**, holding an OPEN PR for a branch that had since merged. Only a real
answer may set `at`; a failure backs off to `now - GH_TTL + 60`.

**3. `gh` exits 1 for "no PR" and for "broken" alike.** The distinguishing signal
is on stderr:

    no pull requests found for branch "dev/PSA-to-DMS"     -> a real answer
    failed to run git: fatal: not a git repository         -> silence

Treating the first as a failure meant falling back to the previous cache, so a
merged, closed or deleted PR haunted its branch indefinitely. That is how `master`
carried a `gone:merged` badge derived from a PR closed days earlier.

Two smaller things fell out:

- `merged_already()` returns true for `master` itself — it is trivially an
  ancestor of `origin/master` — so the primary checkout permanently read as
  "shipped, reclaim me". Guarded.
- Non-repo workspaces (a plain `~/code` row) were accumulating gh caches that
  could only ever hold junk. They are no longer probed at all.

The invariant worth keeping: **"I could not find out" must never be published as
"there is nothing".** When a probe raises or times out, carry the previous signal
tokens forward and log that you did.

## The periodic reconcile has to be spawned by a hook, not by launchd

`crew timer` wrote a `com.crew.sync` launchd job and it could never have worked.
The cmux socket authorizes a caller by the `CMUX_SOCKET_CAPABILITY` in its
environment, and launchd hands out none:

    launchctl submit ... cmux ping  ->  Access denied - only processes started
                                        inside cmux can connect

Nothing surfaced, because `crew-sync` swallows failed cmux calls by design. Proven
with the `synced:` stamp: after a launchd-driven run it was still 140s old, and the
identical binary run from a cmux terminal moved it to 3s.

Detachment is not the problem — the environment is. Two `start_new_session=True`
children whose parent had exited, both at `ppid=1`: the one with the env intact got
`PONG`, the one with `CMUX_SOCKET*` stripped was refused.

So the daemon is started by the **SessionStart hook**, which runs inside a cmux
terminal and passes the token to its detached child. It is a singleton on a pidfile
so every new session can safely call it. Two design notes worth keeping:

- the periodic tick runs on **its own thread**, independent of the event stream, so
  a cmux restart or a dead stream degrades to timer-only rather than to nothing
- the stream is retried with exponential backoff instead of being allowed to end
  the process; under launchd's `KeepAlive` the same failure produced a respawn loop
  every 10 seconds

Tick interval is aligned to `CREW_SYNC_INTERVAL` (120s) because the two triggers
share one stamp — ticking faster cannot reconcile more often. A converged
`crew-sync` costs ~4.5s, and profiling says it is subprocess spawns, not network:
`sidebar-state` and `workspace status` are each one call per workspace.

## Two different colour algorithms were fighting

`hooks/crew-hook.sh` set a workspace colour on every `SessionStart` from
`crew_ticket_color`, a hash of the ticket — while `bin/crew-color` maintains a
registry that deliberately avoids colours already in use. The hook won, on every
session start, and the hash collides: among the worktrees open at the time,
**three pairs** mapped to the same hex.

The hook now calls `crew_color_ensure`, which asks crew-color for the registry
colour and sets it only when the workspace has none — the same "only fill a blank"
rule crew-sync follows, and for the same reason: cmux's own picker offers exactly
crew-color's sixteen, so crew cannot distinguish its own assignment from a
deliberate one.

## The board can open a terminal, and that is how a tap gets a prompt

A chip that deletes something should be able to ask first, and the sidebar has no
dialog. The notification hook can build one: it is a live descendant of the cmux
app, so it is authorized, and `new-pane` is enough.

    cmux new-pane --type terminal --direction down --workspace <id> --focus true
    → OK surface:131 pane:51 workspace:3

The surface id comes back on stdout, and the pane inherits the **workspace's**
cwd, not the app's. Four things had to be measured to make it usable:

- **`send` races the shell's own startup.** Typing into a fresh pane at 0.5s and
  at 1.5s both produce the command echoed raw by the tty and then redrawn by zsh
  under its prompt — it appears twice and reads like a bug. Clean only at 3s;
  this zsh loads whimsy, asdf and nvm. A 3s blocking sleep inside a notification
  hook is not worth it.
- **`respawn-pane --command` skips the race entirely.** It hands the pty to
  `/bin/sh -c` with no rc files in the way, so output starts immediately and
  nothing is echoed. It is interactive: a `read -r` in the command gets the
  keystrokes.
- **A respawned command that exits takes the pane with it.** Verified: after a
  command ended, `read-screen` answered `not_found: Surface not found`. All of
  its output goes with it — fatal for a report you are meant to read. Appending
  `; exec "${SHELL:-/bin/zsh}" -l` keeps the pane and leaves a usable prompt
  under the output.
- **A respawned pane still carries the capability env.** `CMUX_SOCKET_CAPABILITY`
  is set and `cmux ping` answers `PONG`, despite the `/usr/bin/login -flp` in the
  chain. So a command run this way has the full CLI — which is what takes
  `crew-reclaim`'s `close-workspace` off the detached-process problem above.

Where the terminal goes matters as much as how. Reclaim **closes the target
workspace** before deleting the directory, so a prompt living in it would be
SIGHUPed halfway through — after the close, before the removal. The hook picks
the focused workspace (`selected` in `workspace list --json`) and falls back to
any other one when that is the target. `chipRPC` does not select the row's
workspace, so "focused" is still whatever you were looking at when you tapped.

## `workspace list --json` carries both an id and a ref, and guards must accept either

Each row has `id` (a UUID) and `ref` (`workspace:4`). `crew-reclaim` excluded the
workspace being reclaimed from its "is anyone else standing in this worktree?"
count by comparing against `id` only. From the notification hook that is fine —
the payload's `workspaceId` is a UUID — but `crew-reclaim workspace:4` by hand
matched nothing, so **the target counted itself** and the guard refused with
`1 other workspace(s) still open here: datadog-dms`, naming the very workspace
being reclaimed. Invisible until the guards were printed as a checklist.

## A worktree name can be a prefix of its neighbour

The same guard tested `current_directory.startswith(top)`. Under
`<repo>.worktrees/` the names nest — `PROJ-1013-BNL-Remarks-Isolated` is a prefix of
`PROJ-1013-BNL-Remarks-Isolated-CLI-Page` — so reclaiming the shorter one reported a
workspace open in the longer one. It fails safe, so it never corrupted anything;
it just refused for a reason that was not true. A path-boundary compare
(`d == top or d.startswith(top + "/")`) is the fix, and the bare-prefix form is
worth grepping for elsewhere.

## `sbx ls --json` can wedge, and crew-sandbox's reader has no timeout

`crew-sandbox`'s `sbx_state()` pipes `sbx ls --json` straight into python with no
bound. Measured hung at **86s and still going** before it was killed, on a daemon
that had answered the same call in ~2s minutes earlier. `crew-sync` is safe — its
own `sandbox_states()` passes `timeout=15` — but `crew-reclaim` went through
`crew-sandbox status` and inherited the hang, which in the new flow means a delete
prompt frozen with nothing on screen.

`crew-reclaim` now runs that probe under a 20s `subprocess.run(timeout=...)` and
treats a timeout as a **blocker**, not a pass: "I could not tell" and "it is not
running" are different sentences when the next step unmounts the thing.

## A deep-plan's `active` marker points at the renderer's cwd, not the worktree

`render_plan.mjs` writes `CWD=` from wherever it ran. Both live markers on this
machine, side by side:

    active/sync-order-status-oms-to-erp   CWD=…/main-repo.worktrees/handle-status-change
    active/billing-entity-cutover  CWD=…/.claude/deep-plan/keys

The second one rendered from the keys directory, so its `CWD` names no worktree at
all. `crew-sync` already compensates by matching the session id as well
(`deep_plan_markers` returns both sets), but a session id is no use to
`crew-reclaim`, which is handed a path.

`state/<slug>.json` carries the plan's real `root` — `…worktrees/entity-cutover-plan`
for that same plan — so the two files together cover each other: the marker knows
*rendered but not signed off*, the state file knows *which worktree*. The reclaim
guard reads both and merges by slug, because a plan in review has both files and
reporting it twice makes two blockers out of one fact.

Neither file is pruned by anything. A dropped plan blocks its worktree forever, so
the blocker has to name the files to remove — an unexplained permanent refusal is
worse than no guard.

## A webview Dock surface has no way to report a click (2026-09-08)

Restoring the Swift sidebar's click targets on the HTML board meant finding a
page-to-host channel. Four routes were tested and three do not exist:

- `window.webkit.messageHandlers` is an **empty array**, and there is no
  `window.cmux`. The page has no host object to call. The only injected globals
  are internal (`__cmuxConsoleLog`, `__cmuxErrorLog`, the file-system-access and
  WebAuthn bridges) — none of them general purpose.
- `<a href="cmuxintent:...">` is **swallowed**: clicking it neither navigates nor
  emits an event. Custom-scheme-as-IPC does not work.
- `browser.interaction` is a real event in `events.v1`, but it fires with
  `source: "socket.v2"` and a payload echoing `method: "browser.click"` — it
  reports **CLI-driven automation, not the human**. Watching it tells you what
  you already did.
- polling `browser get value` works (the board's original "intent channel") but
  costs a subprocess per poll and adds up to a whole interval of latency.

What does work: **`fetch` from a `file://` page to `http://127.0.0.1` is
allowed**, with `Access-Control-Allow-Origin: *` and no preflight for a simple
GET. Verified by eval in a live surface, not assumed — WebKit blocks plenty of
other cross-origin traffic from `file://`. cmux's own Dock docs use this shape:
their browser-control example is `"url": "http://127.0.0.1:8877/sidebar"`.

So `board/crew-board-intent` is a loopback server, started by `crew-listen`
alongside the board push.

### Two traps in pushing a listener into a page

1. **An idempotency guard is an upgrade trap.** Guarding the install with
   `data-intent="1"` stops a push from attaching a second listener — and also
   stops it from ever attaching a *fixed* one. A page wired once kept running
   the old handler, and no push could correct it. The guard has to carry a
   version, and the listener has to check that version and stand down when it
   is superseded (`removeEventListener` is not an option: the old function is
   not reachable from the new script).
2. **Never close over the server's address.** The listener outlives every push;
   the port and token do not. A handler that captured them kept talking to a
   dead port, silently. Config lives on the DOM (`#rows[data-intent-cfg]`) and
   is read at click time. The server also reuses its previous port and token
   across restarts, so an open page survives a restart with no push at all.

## `sidebar-state` reports compound fields (2026-09-08)

Two fields are not single values, and reading either whole is wrong:

    pr=#51852 open https://github.com/OWNER/REPO/pull/51852
    git_branch=dev/proj-1071-paos-close-psa-request clean

Taking `pr` verbatim put the **entire URL into the board's meta line**, and
`git_branch` verbatim appended `" clean"` to every branch name — both visible on
the board for as long as it has existed. The upside: cmux hands over the
canonical PR URL, so it never has to be constructed from a git remote (and that
spares a `git remote get-url` per row).

## `cmux diff --workspace` defaults to unstaged (2026-09-08)

The common board row is a branch whose work is committed and under review, so
`cmux diff --workspace <ref>` fails with `diff input is empty` and the chip reads
as dead. `crew-diff branch` (this branch vs its merge base) is what a board row
means, and it resolves the repo from cwd, so it must run inside the worktree.

## Setting `.className` on an `<svg>` silently does nothing (2026-09-09)

The board's cat is an inline `<svg id="cat">` whose mood is a class. render.js set
it with `cat.className = mood` — which on an SVG element assigns to a **read-only
`SVGAnimatedString`**. No throw, no console error, no CSP complaint: the sprite
simply kept its initial mood forever and not one of its animations ever started.

    document.getElementById('cat').className   // -> {}  (an object, not a string)

`setAttribute("class", mood)` is the fix. Two things made this hard to see:

- The mood classes only *enable* animation, so the failure looked like "the CSS
  didn't take", which sent me looking at the stylesheet.
- `board_probe.mjs`'s DOM stub modelled elements as plain objects with a
  `className` string property, so the probe was **more permissive than the
  browser** and passed while the feature was completely dead. The stub now reads
  the attribute, which is what the real element actually honours.

The tell that caught it was `document.getAnimations()` over the live surface:
`breathe` and `sweep` were running, `tailsway`/`twitch`/`blink` were absent.
That call is the cheapest way to ask a page which animations are actually live,
and it beats screenshotting for anything time-based.

## "This row moved up" has three possible meanings, and two are wrong (2026-09-09)

Animating the board's reordering needed a definition of "climbed". Attempts:

1. **Pixel delta** (`old offsetTop > new offsetTop`). Wrong: any change in list
   length shifts everything below it, so one new row lit up five unrelated rows
   as having climbed.
2. **Absolute rank** (index in the list). Better, still wrong: inserting a row at
   the top demotes every row beneath it by a slot, so all of them report a change
   when nothing about them changed.
3. **Relative rank among rows present in BOTH pushes.** Correct: it means "this
   overtook something", which is the only version a reader can act on. Rows that
   merely got displaced by an arrival or a departure keep their standing.

The pixel delta is still what drives the *slide* — a row must never teleport when
something above it grows — but it is deliberately not what drives the accent.
Motion and meaning are two separate decisions on the same element.

## The cat was in crew.swift, not in the cmux bundle (2026-09-09)

Asked for "the cat sprite from the cmux app", I searched the app: `Assets.car`
(16 assets, all agent and app icons), the Mach-O strings, and every JS resource.
The only hits were `fa-cat` and `md-cat` — icon-font *names* in cmux's icon set.
So I drew an Everforest silhouette instead.

The actual cat was ~800 lines further down the file I had already been reading:
`sidebars/crew.swift` renders a **tuxedo pixel cat** as SwiftUI Rectangles, with
six poses (`NAP_A/B`, `WALK_A/B`, `SWAT_A/B`), a documented palette (charcoal
body — *not* black, because against a near-black sidebar a black cat is a hole in
the screen), and a full motion spec: `catMood`, `catStep`, `catFlip`, `catLunge`,
`catBob`, `catSays`.

When someone says "the X from the app", their own config for that app is part of
its surface — search there first. The vendor bundle was the wrong haystack.

The port reads the pose arrays out of crew.swift at build time
(`board/cat_from_swift.py`), so the two boards show the same animal pixel for
pixel and neither can drift silently; `--check` fails the probe if they do.
726 pixels become ~30 `<path>`s, one per pose per colour.

## A 1Hz sprite in an inert page has to be pure CSS (2026-09-09)

The sidebar's cat animates off `clock.second`, re-rendering every second. The
board has no such clock and cannot grow one: the page is inert by contract, and
pushes are ~120s apart, so the renderer is the wrong place to drive frames.

Every part of the spec maps onto CSS instead, and `steps(1, end)` is what makes
it work — the frames must *cut*, not tween, or the pixel art blurs:

| crew.swift | CSS |
|---|---|
| `even ? A : B` at 1Hz | two `<g>`s, `visibility` keyframes at `2s steps(1,end)` |
| nap breathing, 6s | same, `6s steps(1,end)` |
| `catX()` triangle wave, 5px/s | `8s steps(7,end) infinite alternate` |
| `catFlip()` on the return leg | `scaleX(-1)` at `16s steps(1,end)`, origin 25.5px |
| `catLunge()` / `catBob()` | 2s and 8s step keyframes on a wrapper `<g>` |
| three drifting z's | one keyframe, `animation-delay` 0/2/4s |

Nested groups matter: the walk translates the outer `<g>` and the flip scales the
inner one, because a single element cannot carry two competing `transform`
animations.

## A ported palette is only valid against the background it was drawn for (2026-09-09)

`catColor()` picks a charcoal `#36363F` body with an explicit comment: against
the sidebar's near-black background "a true-black cat is a hole in the screen".
Dropped onto the board, whose ground is Everforest `#2d353b` — **lighter** than
that charcoal — the body disappeared and only the white bib and paws rendered.
The cat looked like four floating dashes, and I spent a diagnosis pass on
clipping and mirror origins before checking contrast.

The fix keeps every pixel: a dark plinth behind the sprite (`#1e2326`), which
restores the contrast the art was drawn for and doubles as the shelf crew.swift's
own comments describe it pacing along. Porting art means porting its ground, not
just its pixels.

## `cmux sidebar-state` is 89% of a board build, and there is no bulk form (2026-09-09)

Asked to refresh the board more often than 120s, I measured before changing the
number. Over 10 workspaces:

    workspace list --json        27 ms   (one call: title, cwd, description, colour)
    deep_plan status --json      73 ms   (one node process)
    sidebar-state x10          1564 ms   (~156 ms each — 89% of the total)
    ------------------------------------
    full build                 1754 ms

`sidebar-state --help` takes only `--workspace`; there is no all-workspaces form,
so the N+1 is unavoidable per pass. Dropping the tick to 15s would have meant
shelling out ~2s every 15s forever — a 14% duty cycle to answer a question that
mostly has not changed.

What it supplies is `git_branch`, `pr` and `claude_code=Running`. The first two
barely move, and the third is also tracked by the `phase:` token crew publishes in
the description — which arrives in the 27ms call. So the split is natural:

- **fast pass** (15s): the JSON call plus deep-plan state, branch/PR/live-turn
  from an on-disk cache → **136ms**, and the ranking still reacts immediately to
  every token and every plan-gate change.
- **full pass** (every event, every reconcile, startup): pays for sidebar-state.

The cache has to be on disk, not in memory: the listener shells out to
`crew-board push`, so every push is a fresh process and an in-process dict would
be cold every time.

Two guards, because a stale cache is worse than a slow board — it renders a
plausible wrong branch. A fast pass refuses entries older than 300s and pays full
price instead, and `board_probe.mjs` diffs a fast build against a full one on
every run.

Incidental: the fast path spent ~80ms of its ~240ms spawning `python3
crew-board-intent --status` just to ask whether the click server was up. Opening
the socket directly answers the same question in microseconds.

## `workspace.selected` fires ~151ms before the selection is queryable (2026-09-09)

Making the board ring the current workspace's card, and the pane frame wear its
colour, both looked like one line: react to `workspace.selected`, ask which
workspace is selected, paint. Both came out **permanently one switch behind** --
each switch displayed the previous one's answer, which is the most confusing
possible failure because it always looks *almost* right.

Measured: after the event lands, `workspace list --json` takes **151ms** to start
reporting the new `selected`. A listener that reacts to the event and then asks
is guaranteed to read the old value.

The event payload answers it outright, so nothing has to race:

    "payload": { "workspace_id": "AC5CDEA8-…", "previous_workspace_id": "892845FA-…",
                 "selected": true, "title": "FIX-51888 · ci", "cwd": "…" }

So `crew-frame --workspace <uuid>` and `crew-board push --selected <uuid>` both
take the id from the payload, and only fall back to asking at startup, when
nothing is in flight. Worth noting *what* races: only `selected`. Each
workspace's `custom_color` is stable, so looking a colour up by id is safe
immediately.

A fixed sleep would also have "worked" and is the wrong answer -- it encodes a
measurement of one machine on one day into a race that then fails silently.

## cmux has no per-workspace border colour, and refs are positional (2026-09-09)

Two things the schema settles:

- The only border keys are `activePaneBorderColor` and `paneBorderColor`, both
  top-level `colorHexOrNull` — **global**, with no per-workspace override and no
  width setting. "The frame follows the workspace" therefore has to mean
  rewriting one global value on every switch and reloading. That is affordable:
  `cmux reload-config` measured at **39ms** and refreshes terminals in place
  (this session survived dozens of them), but only because crew-frame skips the
  write entirely when the colour has not changed — which most switches are, once
  you are bouncing between two worktrees of the same colour.
- The schema's wording is `activePaneBorderColor` is drawn "around the focused
  cmux pane **in split workspaces**", so an unsplit workspace may show no frame.

Also: `workspace:N` refs are **positional** and shift as workspaces open and
close. Mid-session, `workspace:12` was a different workspace than it had been an
hour earlier. Anything that must survive churn addresses workspaces by uuid;
refs are for a single command, right now.

Editing cmux.json at runtime means a targeted regex on one value, never
parse-and-reserialize: it is JSONC, and it is full of the comments `crew apply`
renders into it, every one of which `json.dump` would delete.

## A test that "proves the refusal path" must first be refusable (2026-09-09)

Smoke-testing the plan surface's new `/inc` endpoint, I fired what I believed was
an illegal transition — `start` on increment 1, which was `done` — expecting the
tracker to reject it and prove the error path. It returned `ok: true`.

`deep_plan.mjs move()` had no transition check whatsoever, and both `start` and
`done` re-read git and overwrite the increment's `branch` and `head`. So the call
moved a finished increment back to `working` and replaced its recorded branch and
sha with today's worktree values. The log preserved `startedAt`, so status and
timing were restorable exactly; the branch was reconstructable from the
increment→ticket→branch pattern; **the sha was not** — the branch had been
rebased since, so no sha in git matched what had been recorded, and writing an
inferred one would have been a guess wearing the authority of a record.

Two lessons, and the second is the real one:

1. A "this will be refused" test is a write until the refusal is proven. Point it
   at a scratch state dir (`DEEP_PLAN_STATE` exists precisely for this) or assert
   the guard exists first.
2. The guard did not exist because nothing had ever asked for it. The fix is in
   `move()`, not in the caller: `FROM` now refuses leaving `done` except through
   `reset`, and refuses re-recording a `done` increment, naming the branch and sha
   at risk in the refusal.

The first version of that table was too strict — it also refused
`authorized -> done`, which `obs_probe` immediately rejected. Skipping `start` is
an ordinary way to work and loses nothing, because an increment that never
started has no branch to overwrite. The rule that matters is narrower than
"follow the state machine": **do not overwrite a record that is the only copy.**

## cmux does not load a webview in a workspace you are not looking at (2026-09-09)

Reported: "mermaid is not rendering on an existing plan, it's just the markdown."
It was rendering. It had not started.

Measured on one plan surface, same file, same surface:

    workspace NOT selected   readyState "loading" at 3s, 6s, ... 49s. mermaid undefined.
    workspace selected       readyState "complete" within 3s, all 5 diagrams drawn.

A restored surface behaves the same way: four plan tabs sat at `loading`
indefinitely and each completed ~3s after its workspace was first displayed. So
the webview is lazily instantiated or suspended until shown, and a page whose
diagrams need a script simply shows its prose until then -- which is exactly what
"just the markdown" looks like. (The generator's own "Rendering diagram…"
placeholder was doing its job; nobody waits long enough to see it change.)

That is not a bug to fix, it is a constraint to design for: the first render after
focus should be CHEAP. A working page inlines mermaid as 4.6MB of base64 -- ~3s of
parse before anything is drawn, every time a tab is looked at.

Serving is what fixes it. `crew-board-intent` swaps the inline data: URI for its
own `/mermaid.min.js` on the way out, so a plan serves at **105KB instead of
4.86MB** and every plan shares one immutably-cached copy of the library. Same
surface, same background workspace: the served page reached `complete` with all
five diagrams and its buttons live in ≤3s, where the file never finished at all.

The file on disk stays self-contained, deliberately. An earlier version of this
made the file itself reference `/mermaid.min.js`, which broke a working page that
was already open on `file://` -- render_plan's own note had already established
why ("a cross-directory file:// `<script src>` does not load at all"). The rule
that came out of it: **the generator emits something that works alone; the server
optimises it on the way out.** Never the reverse.

Plan surfaces now carry the server's port in their URL and cmux restores them
across launches, so `crew-board-diag` reports any that point at a stale port.

## Serving a page relocates every relative link in it (2026-09-09)

Plan pages link to each other by bare filename — `<slug>.review.html`,
`<slug>.md`, `<slug>.cutover/<slug>.epic.html`. As files in one directory those
always resolved. Served at `/plan/<slug>`, the same hrefs resolve to
`/plan/<name>`, which the route did not handle: **404, and the way back to the
review of record was gone.**

The fix is a resolver rather than a special case for the one link that was
noticed, because there were four kinds and only one was obvious. It takes either a
bare slug or a relative path, allows `.html` and `.md` only (the directory also
holds `.json` and `.txt`), and checks containment with `realpath` so `..`, its
percent-encoded form, and symlinks all fail. The answer keys are unaffected either
way: they live in a separate tree, which is worth keeping true.

The general lesson is worth more than the fix: **moving a document from a
directory to an origin silently rewrites the meaning of every relative URL in
it.** Anything self-contained enough to work as a file has internal links that
assume the directory, and serving it breaks exactly the ones nobody clicks during
testing.

`crew-board-intent --selftest` now covers the route table and the refusals. Its
first run failed a check it should have passed — it read only the first 400KB
looking for the mermaid boot script, which is emitted after the page body. A test
that reads a prefix of a 4.8MB file and reports on the whole is worse than no
test, because it fails loudly about something that works.

## byCwd matching is longest-match-WINS, not merge (2026-09-10)

Giving every repo the "New worktree + Claude" context menu looked like one
`"~/code/*"` catch-all. It is not: `workspaceGroups.byCwd` picks the single
longest matching key and uses that entry alone. A named repo like
`"~/code/gamma-infrastructure"` shadows the catch-all completely, so it would
have kept its colour and icon and silently lost the menu.

The catch-all is still worth having for repos nobody has coloured yet, but every
named entry needs its own copy of the menu. JSONC has no anchors, so the
repetition is the price.

## crew-dock retired; nothing unique was lost (2026-09-13)

The seamux cutover's first increment diffed ~/code/crew-dock (not under git)
against this repo before deprecating it. Result: `crew/FINDINGS.md` and
`crew/TESTING.md` were byte-identical to the `docs/` copies here, and the one
genuinely unique file — `deep-plan/TIE-INS.md`, the six crew↔deep-plan
integration points — was preserved as `docs/TIE-INS.md`. Everything else in the
bundle was a stale snapshot of what this repo already versions. Its README is
now a deprecation pointer at seamux; the tree stays as a historical reference
until deletion feels safe.
