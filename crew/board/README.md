# crew board — who needs you, ranked

A browser surface in the cmux Dock showing one ordered list: the agents blocked on a human
decision first, then the broken ones, then the working ones. Everything calm collapses to
a count.

```
crew-board open              create the Dock surface and load the board
crew-board push [--screens]  gather, rank, push one update
crew-board watch [secs]      push on a loop (default 4s)
crew-board state [--json]    the ranked state, without touching cmux
crew-board close             close the surface
```

## Why a browser surface

The custom-sidebar interpreter has no `@State`, no text input, and can only bind cmux's
own workspace data — so it cannot host a list built from deep-plan state and agent output.
See `../FINDINGS.md`: "The board cannot host search, or any non-cmux data".

A Dock browser surface has none of those limits. And `cmux browser addscript` pushes state
into a page that is *already open*, so the surface never reloads — scroll position and
hover survive an update, and the daemon never rewrites the HTML.

Requires `rightSidebar.beta.dock.enabled` (Settings → beta features). Without it,
`--placement dock` returns `Dock placement is disabled`.

## The ranking is the product

Five tiers. The top of the list is the whole point; the bottom is deliberately not shown.

| Tier | Means | Sourced from |
|---|---|---|
| **attend** | blocked on a human | crew's `phase:waiting`; a plan whose check is untaken; a plan whose gate is shut |
| **wilt** | broken | `ci:fail`, `pr:conflict`, `review:changes`, a blocked increment |
| **running** | mid-turn | `claude_code=Running`, `phase:working` |
| **done** | finished, needs closing | `gone:merged`, a plan whose every increment is done |
| quiet | everything else | collapsed to a count |

`--screens` adds one `cmux read-screen` per active row, so a card shows what the agent
actually last said. It costs a socket call per row, which is why it is opt-in.

## How it stays current

No websockets, and it does not need them. A `file://` page cannot hold a socket open to
anything without a local server, and crew deliberately has none — that was one of the
reasons lavish was rejected. But a push stream already exists one level down, and updates
into the page are a push too, so nothing polls the thing it cares about.

```
cmux events --reconnect ──┐
  (unix socket, events.v1) │
                           ├─▶ debounce 150ms ─▶ gather ─▶ diff ─▶ browser addscript
plan state mtime (250ms) ──┘                                        (push into the page)
```

**cmux side — a real push stream.** `cmux events` is line-delivered JSON over the socket
with `--cursor-file` and `--reconnect`, so a cmux restart resumes rather than silently
stopping. Six names are subscribed, chosen against volumes crew-listen already measured:

| Subscribed | Why |
|---|---|
| `agent.hook.Notification` | an agent is blocked on a human — the board's entire purpose |
| `agent.hook.Stop` | a turn ended, so that row's status just changed |
| `workspace.created` / `closed` | a row appeared, or went stale |
| `workspace.renamed` / `selected` | title drift; or you are looking at it |

And what is deliberately *not* subscribed matters more:

| Excluded | Why |
|---|---|
| `agent.hook.PreToolUse` | 2838/day. The hot path — waking on it makes the board the most expensive thing in the session |
| `sidebar.metadata.updated` | 1465/day, and it is crew's *own* `set_status`. Feeding the board its own side effects |
| `workspace.action` | 187/day, crew-sync's `set_description`. Same loop |
| `browser.*` | this board writes to a browser surface; waking on that is a push that triggers a push |

It keeps its own cursor at `board-events.seq`. Sharing crew-listen's `events.seq` would put
two consumers on one resume position and both would miss events.

**Plan side — stat, because nothing pushes it.** No cmux event announces a deep-plan
increment transition; `deep-plan go` writes a file and that is the whole signal. `stat` on
a handful of files costs microseconds, so a 250ms interval is cheaper than one gather and
gives sub-second latency on the half of the board that changes most meaningfully.

**Debounce and diff.** A burst coalesces (created + renamed + selected arrive together, and
three gathers would produce three identical boards), and a gather whose rows are unchanged
is not pushed at all — so an idle board does no DOM work, which is the same rule whimsy
follows.

**The heartbeat is a backstop, not the mechanism.** 30s, and only for what neither source
can see: crew-listen documents that there is no git event and no PR event in cmux's
catalog, so CI, review and Jira state are learnable only by polling.

## It keeps working when cmux does not

cmux goes away for ordinary reasons — a restart, an update, a standalone launch on a
different socket (`/tmp/cmux-nightly.sock`; override with `CMUX_SOCKET_PATH`). Plan state
lives in files and does not.

So when the socket is unreachable the board ranks plans alone rather than going blank. A
board that blanks during a restart teaches you to stop looking at it.

## Whimsy, carried over

The board is part of the same terminal, so it speaks whimsy's language rather than
inventing one.

- **The palette is whimsy's**, byte-for-byte from `shaders/20-state.glsl`: sage `#a7c080`,
  aqua `#83c092`, sand `#dbbc7f`, teal `#7fbbb3`, red `#e67e80`, ochre `#dfa000`.
- **The four row states are whimsy's shader events.** `EV_ATTEND` is the ochre attention
  wash — the only thing allowed to demand the eye. `EV_RUNNING` is the tidepool, a slow
  7.5s stir rather than a spinner, because work in progress is not an emergency and a fast
  animation beside a real alert steals from it. `EV_FAILURE` wilts: the shader computes
  `mix(base, lum * C_OCHRE * 1.1, 0.55)`, and the CSS pulls saturation out and lays ochre
  back over it. `EV_SUCCESS` ripples once, on transition only.
- **The principle matters more than the palette.** whimsy's README: it "costs nothing when
  nothing is happening", because animation phase comes from events and never from a free
  clock. So a quiet row here has no animation at all, and `prefers-reduced-motion` stops
  the rest.

## Verifying it

```bash
node board/board_probe.mjs   # 10 assertions on the render path, no cmux needed
crew-board state             # the ranking, as text
```

The render path is the riskiest piece: a JS error there yields a *blank surface* rather
than an error, and the daemon would keep pushing into it. The probe pulls the script out
of `board.html`, runs it against a DOM stub, and asserts — including that agent output
captured with `read-screen` is escaped rather than executed.

## Whimsy

Carried over from whimsy's shaders, including its rule: **nothing animates unless
something is happening.** Every animation on this page is bound to a state that is
genuinely in flight and stops when it is not, and all of it yields to
`prefers-reduced-motion`.

**The header is parked.** It is `position: sticky`, with negative side margins
cancelling the body's padding so it and the shelf reach both edges. The board is a
list you scroll and the one thing you always want in view is what is waiting on
you. It costs 75px, about 12% of a Dock pane.

**The tally** (`#tally`) counts the five tiers — `need you`, `broken`, `working`,
`to close`, `quiet` — in the ranking's own order, so the eye travels the header
and the list the same way. Empty tiers are omitted: a row of zeroes is noise, and
the absence of "broken" reads faster than "0 broken".

Adding it exposed a contradiction that had been there all along. `#need` counts the
`attend` tier only, and printed **ALL CLEAR directly above "5 broken"**. It now
says `nothing needs you`, which is the question it can actually answer; the tally
answers the rest. The probe asserts the headline never claims all-clear over a
broken board.

**The cat** (`#cat`) is the sidebar's cat, not a new one: `cat_from_swift.py`
reads the six pose arrays out of `sidebars/crew.swift` and emits them as `<path>`s,
so both boards show the same animal pixel for pixel and neither can drift silently
(`--check` fails the probe if they do). Charcoal body, white bib, green eye, pink
nose — 726 pixels, ~30 paths. It sits on a dark plinth, which is both the shelf
crew.swift describes it pacing along and a necessity: the charcoal body was chosen
against the sidebar's near-black ground and is *lighter* than this board's, so
without it only the white bib rendered. Its geometry lives in `board.html`, not `render.js`,
because the renderer is re-sent on every push and the cat never changes; only the
mood class crosses the wire.

| mood | when | what it does |
|---|---|---|
| `swat` | a human is being waited on | crouches, lunges 3px on alternate seconds, *"hey. hey. HEY."* |
| `pace` | anything working **or** broken | walks the **full width** of the shelf, turns around at the halfway point, *"supervising"* |
| `nap` | nothing is happening | breathes on a 6s cycle, three z's drift up, *"off duty"* |

`pace` covers broken as well as working because the sidebar's `catMood()` does
(`bucket == 1 || bucket == 5`) — the row rails already say which, and the cat is
only there to answer "is anyone waiting on me".

The walk animates `left`, not `transform`: the distance is "the width of the shelf
minus the cat", which only exists as a percentage, and a transform percentage is
relative to the element's own box — it would always be the same few pixels no
matter how wide the Dock got. Measured: the cat travels 0 → 382px across a 452px
shelf and turns around.

The animation is entirely CSS. It has to be: the page is inert and pushes are two
minutes apart, so a 1Hz sprite cannot be driven by the renderer. `steps(1, end)`
throughout, because the frames must cut rather than tween or the pixel art blurs.
See FINDINGS.md for the full mapping.

**Reordering** is a FLIP driven from `render.js` with the Web Animations API. Each
row's `offsetTop` is captured *before* `innerHTML` is replaced — the only moment the
old geometry exists — and `.animate()` runs from that measurement, so nothing is
left on the style attribute. Two separate decisions on the same element:

- the **slide** follows the pixel delta, so a row never teleports when something
  above it grows or a divider appears;
- the **climb accent** (one pass of the row's own rail colour) fires only when a row
  changed rank *relative to the rows present in both pushes* — i.e. it overtook
  something. A row displaced by an arrival has not climbed anything. See FINDINGS.md
  for the two wrong definitions this went through.

Rows that sink get no accent: losing urgency is not news. A row seen for the first
time fades in from slightly above, never from below, which would read as demotion.

**Pending** things breathe. On a row that is waiting on a human, the one chip that
would resolve it pulses — exactly one moving element per row. A mid-turn row with no
measurable progress gets an indeterminate sweep on its dial; a dial that *has* a
percentage never spins, because it has already answered the question, and a row that
is broken or waiting gets a bare dot rather than a stationary arc that would read as
a stalled spinner.

`board_probe.mjs` asserts all of it against a DOM stub with a query path, including
that an unchanged order animates nothing.

## Where you are

One colour per worktree, in four places. It is cmux's own `custom_color`, which
`crew-sync` sets and `crew-color` hands to Peacock:

| surface | how |
|---|---|
| the workspace tab in cmux | cmux, natively |
| the VS Code title bar | Peacock, via `bin/crew-color` |
| the board's card | a ring in that colour on `.row.here`, plus a brighter ground |
| the focused pane's frame | `bin/crew-frame` rewrites `activePaneBorderColor` |
| Claude Code's status line | `~/.claude/statusline.py` prints `▊ <title>` in it |

The current workspace's card is **marked, not moved** — promoting it would fight
the ranking, which is the one thing this board is for.

Two things to know about the frame. cmux has no per-workspace border colour: the
schema's only border keys are global, so following the selection means rewriting
that one value and reloading (39ms, terminals refresh in place). And the schema
says the border is drawn around the focused pane *"in split workspaces"*, so an
unsplit workspace may show nothing. `CREW_FRAME=0` turns it off;
`crew-frame --status` says what is set and what would be.

The status line lifts the colour before printing it. Peacock hexes are chosen to
sit *behind* white text in a title bar, so as ink on a dark terminal they are mud
— `#7D6608` becomes `#F3D148`, hue held, lightness floored at 0.62.

Selection is followed from the **event payload**, not by asking who is selected:
`workspace.selected` fires ~151ms before `workspace list --json` reports the
change, so asking makes both the ring and the frame permanently one switch behind.
See FINDINGS.md.

## Serving a plan into the Dock

`/plan/<slug>` serves a plan's live surface from the same loopback origin that owns
the board's click channel. That origin is what makes the Dock integration work at
all — see FINDINGS.md for why a `file://` plan page cannot be made light, and why a
backgrounded one never finishes loading.

What resolves under `/plan/`, and nothing else:

| request | serves |
|---|---|
| `<slug>` | that plan's working surface, or its review if there is no working one |
| `<slug>.review.html` | the review of record — the page's own "back to the plan" link |
| `<slug>.working.html` | the way back from the review |
| `<slug>.md` | the markdown source, as text |
| `<slug>.cutover/<slug>.epic.html` | the cutover bundle |

The internal links matter more than they look: they are written as bare relative
filenames, so under `/plan/<slug>` they resolve to `/plan/<name>` and 404ed until
this existed — serving the plan had quietly cut the link back to the review of
record. Only `.html` and `.md` resolve; the directory also holds `.json` and
`.txt` artifacts and there is no reason to publish those. Paths are resolved with
`realpath` and required to land inside the plans directory, so `..`, its
percent-encoded form, and a symlink all fail. (The answer keys and archived specs
are never at risk regardless — they live in `~/.claude/deep-plan/keys`, a separate
tree.)

Two rewrites happen on the way out, neither touching the file:

- the inline `data:` mermaid becomes `/mermaid.min.js`, one immutably-cached copy
  for every plan — **4.86MB on disk serves as ~100KB**;
- a small script is injected that enables the increment buttons (they ship
  `disabled`, because as a file they genuinely cannot act) and polls
  `/plan-stamp` so an increment an agent advances appears without a click.

`python3 board/crew-board-intent --selftest` asserts the route table, every
refusal above, and that the mermaid swap still matches a real page — both of those
have regressed once and neither announces itself. `crew doctor` runs it.

## The spend dashboard

`crew-board usage` opens it as a Dock tab, served at `/usage` and reusing its own
surface so it never fights the board for one. Four cards: the active window, the
daily series, the current week against its budget, and per-workspace dollars.

Nothing here computes a price. It shells out to `ccusage` — the hand-rolled
pricing table this replaced was reading about **2.5× high**, because it guessed a
rate for a model whose real price it had no way to know.

### Two billing models, and they want different pages

Everything above assumes a subscription, where the binding constraint is the 5h
window and money is not the question. On **usage-based billing that is simply
false**: there is no window limit, you are billed rather than throttled, and the
constraint is the month.

Say so in `~/.config/cmux/crew-local/config.json`:

```json
{ "billing": "usage", "monthBudget": 3500 }
```

**A file rather than an env var, and that was learned the hard way.** Both
surfaces originally read only `CREW_BILLING`. The status line is spawned by
Claude Code and this server by three different parents (`crew apply`,
`crew-listen`, `crew-board`), none of which source a shell rc — so a value
exported in a terminal reaches some of them, sometimes. In practice the server
inherited it from the `crew apply` that spawned it and looked perfectly correct,
while the status line never saw it at all and the next respawn would have
reverted the page in silence. The overlay dir is durable: outside `$DEST`, so
`install.sh` cannot replace it. `CREW_BILLING` and `CREW_MONTH_BUDGET` still
override it for a one-off, and `crew doctor` prints which mode is in force and
where it came from.

It changes what the page leads with:

| | subscription (default) | `CREW_BILLING=usage` |
|---|---|---|
| leads with | the 5h window, tokens vs budget | the month, spend vs `CREW_MONTH_BUDGET` |
| window card | tokens view by default | time view — the clock and burn rate, since a token budget means nothing here |
| daily bars, axis, table, tooltip | tokens | dollars |
| week card | tokens vs a weekly budget | what the week cost, no bar (there is no weekly allowance to be a share of) |

The month card puts spend and elapsed days on one bar on purpose: "43% of budget,
50% of the month gone" is the whole question, and two numbers side by side answer
it faster than a projection does. The projection is there too, and it is
suppressed on day 1 — one day extended across a month is noise wearing a
number's clothes.

`CREW_MONTH_BUDGET` is optional. Without it the card shows what you have spent
and does **not** invent a denominator — deliberately unlike the window card,
whose "largest on record" fallback is a high-water mark rather than a limit.

An explicit switch rather than a guess: the local transcripts show tokens and
computed costs either way and state nothing about your plan, so any detection
would be a heuristic that silently picks the wrong framing. The status line
(`claude/statusline.py`) reads the same variable and follows the same rule.

### The window card holds two views

Tokens against the budget, or time against the reset; the button switches and
the choice sticks in `localStorage`, because the page reloads itself every 60s.

They are not the same question, and neither is always the one that binds. Tokens
answer "how much of my allowance is gone", but only if there *is* an allowance:
without `CREW_BLOCK_BUDGET` the denominator is the largest window you have ever
had, which is a high-water mark rather than a limit. Time answers "how long until
this resets", which is a fact either way. So whichever view is not showing, its
headline number sits in the card header — neither view hides what the other
leads with. With no budget on record at all the tokens view says so outright
rather than rendering a confident `0%`.

Two things it deliberately does not take from the server: the countdown is
computed from the block's own `endTime`, since a snapshot's `remainingMinutes`
is stale the moment it is written and a Dock tab can sit open for hours; and the
window's length comes from the block's own bounds, so a non-default `ccusage
blocks --session-length` is labelled honestly instead of being called "5h".

Form was chosen before colour, per the dataviz method. The block's cost, burn
rate and time remaining are **stat tiles, not charts** — a one-bar bar chart is an
anti-pattern, and the number is the chart. Daily cost is magnitude across discrete
buckets, so bars rather than a line. That is one series, which means no
categorical palette and no legend; the title names it.

**The series colour is `#e69875`, and it is the only one that works.** Everforest
is a pastel theme: run its hues through `dataviz/scripts/validate_palette.js` and
teal, aqua, green and pink all fail the chroma floor at 0.06–0.09 — they read as
grey against this surface. Of the three that pass, gold and red are already the
board's status tokens for "needs you" and "broken", and a status colour reused for
a series is the first entry in the anti-pattern catalog. Orange is what is left,
and it passes contrast against the surface too.

The rest follows the mark specs: rounded data-ends anchored to the baseline, a 2px
surface gap instead of borders between bars, solid hairline grid one shade off the
surface, and direct labels on exactly two bars — the peak and today — with the
axis and tooltip carrying the rest. Hover and keyboard focus show the same
tooltip, every bar has an `aria-label`, and the chart has a table twin behind the
`table` toggle, because a tooltip must never be the only way to read a value.

One thing worth knowing when inspecting it: a Dock tab that is not the selected
one has its **transitions frozen**, so the tooltip's opacity reads 0 from the
outside even though the inline style is 1. That is the same throttling that keeps
a backgrounded plan page from finishing its load — not a bug in the page.

## Refresh cadence

Two clocks, because they answer different questions.

| | every | costs | what it answers |
|---|---|---|---|
| reconcile (`crew-sync`) | `CREW_TICK_SECONDS`, 120s | ~4.5s (gh, acli, sbx) | CI, review, Jira — things only a remote knows |
| board push, fast | `CREW_BOARD_TICK`, **15s** | ~190ms | does the glass still show what is true locally |
| board push, full | every event + every reconcile + startup | ~2.1s | everything, including branch and PR |

The board used to refresh only on the reconcile's clock, so a gate you had just
opened or a turn that had just finished could sit unrendered for two minutes even
though every input was already on disk.

Fifteen seconds is affordable only because of the split. Measured over 10
workspaces: `workspace list --json` **27ms**, deep-plan status **73ms**, and
`cmux sidebar-state` **1564ms** — 89% of a 1754ms build, ~156ms per workspace,
one call each, with no bulk form in the CLI. A fast pass skips those calls and
reads branch, PR and the live-turn flag from `board-sidebar.json`, which the full
pass writes: **2104ms → 136ms**.

That is a correctness risk as much as a speed trick — a stale cache renders a
plausible but wrong branch — so three things guard it:

- the ranking never depends on cached data: `phase:*`, `ci:*`, `gone:*` and the
  plan gate are read fresh on every pass, from the one cheap JSON call and
  deep-plan's own files;
- a fast pass refuses any entry older than `FAST_MAX_AGE` (300s) and pays full
  price instead, so a dead listener degrades to slow rather than to wrong;
- `board_probe.mjs` compares a fast build against a full one on every run, and
  `crew-board-diag` reports the oldest cache entry.

To change it: `CREW_BOARD_TICK=5 crew listen on` for a snappier board (~4% duty
cycle), or `CREW_BOARD_TICK=0` to switch the fast tick off and go back to the
reconcile's cadence. A push with no board open costs 42ms — `crew-board push`
checks for a surface before it builds.

## Parity with the Swift sidebar

Every interactive element in `sidebars/crew.swift` has an equivalent here. The
list is the sixteen call sites of `onTapGesture` / `openURL` / `chipRPC` /
`chipURL` / `chipJump` in that file:

| crew.swift | board | what it does |
|---|---|---|
| branch text (:510) | `.branch` `data-a=code` | opens the worktree in VS Code, Peacock colour and all |
| PR number (:539) | `.pr` `data-a=pr` | opens the pull request |
| `✗ CI` (:565), `● CI` (:568), `✓ CI` (:572) | `checks` chip / `.sig` | opens the checks page |
| `▣ ▢ sandbox` (:629, :634) | `.sig` `data-a=sandbox-up/-down` | starts or stops the microVM |
| `go N` (:653) | `go N` chip / `.sig` | authorizes the next increment |
| `plan →` (:662) | `plan` chip / `.sig` | opens the plan's live page |
| `allow` / `deny` (:682, :687) | `.sig` `data-a=feed-allow/-deny` | answers a blocked ask |
| `read it →` / `jump →` (:690, :695) | `jump` chip | goes to the workspace |
| reclaim (:736) | `reclaim` chip | dry-runs the reclaim, asks first |
| whole row (:803) | `.row` | selects the workspace |
| sync clock (:1020) | `#stamp` | forces a reconcile |

Also carried over, though not clickable: the dirty dot, the whole signals
vocabulary (review, conflicts, draft, stack, **jira**), and the worktree's identity
colour, which the row wears as an inner stripe — the same hex Peacock paints its
VS Code title bar with.

The `jira:` chips work here and never did in the sidebar: `crew.swift` wrapped the
whole strip in `has(ci:) || has(review:) || has(pr:conflict) || has(sandbox:) ||
has(planinc:)`, so a workspace whose only token was `jira:in-review` showed nothing
at all. Each token stands on its own here.

Two deliberate departures. The reply window is a bar that drains in real time
rather than a number, because a number would be a lie by the next push. And the
branch is clipped from the **head** (`…prelim-invoice-dedupe-match-process`), since
every branch starts `dev/` and the tail is the half worth keeping — the full value
is always in the tooltip.

## Clickable, through a loopback server

The chips and rows are click targets. The Swift sidebar had them and losing them was a
regression, so the taxonomy is restored one-for-one: row → select the workspace, `jump`,
`diff`, `pr`, `checks`, `plan` / `take the check`, `reclaim`, `go N`, `close plan`, and
the sync stamp → force a reconcile.

A webview click cannot reach cmux on its own, and the alternatives were tried first:

| route | verdict |
|---|---|
| `window.webkit.messageHandlers` | **empty**, and no `window.cmux`. No host to call. |
| `<a href="cmuxintent:…">` | click is swallowed: no navigation, no event. |
| `browser.interaction` event | real, but fires with `source: socket.v2` only for **CLI-driven** clicks. It reports automation, not the human. |
| polling `browser get value` | works — the original "intent channel" — but costs a subprocess per poll and adds up to a full interval of latency per click. |

So `crew-board-intent` binds a loopback HTTP server and the page sends a plain `fetch`.
This is the shape cmux's own Dock docs use (`"url": "http://127.0.0.1:8877/sidebar"`).
`fetch` from a `file://` page to `127.0.0.1` **is** allowed, with
`Access-Control-Allow-Origin: *` and no preflight (a simple GET, no custom headers) —
verified, not assumed.

Dispatch reuses what exists. Simple verbs shell out to cmux; anything touching a worktree
or deleting goes through the same `crew:*` notification RPC the Swift sidebar used, so
`hooks/triage.py` remains the one place deciding what those verbs do — including its "ask
before deleting anything" gate on `reclaim`.

The original caution still holds where it matters: the board does not silently authorize
or delete. `go N` and `reclaim` post an RPC that triage gates; the board only asks.

### What the page is trusted with

Nothing. A click sends `(row id, action)` and never a path, ref or URL — those are resolved
server-side from `board-targets.json`, which the collector writes. A stale or tampered page
can only request an action on a row the collector itself published. Requests must carry the
token from `board-intent.token` (mode 0600, fresh per server start), because any page in any
browser can issue a cross-origin GET to localhost; the server is loopback-bound, the action
list is fixed, and no argument reaches a shell.
