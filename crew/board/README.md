# crew board — who needs you, ranked

One ordered list: the agents blocked on a human decision first, then the broken ones,
then the working ones. Everything calm collapses to a count.

The board is the page the intent server serves at `http://127.0.0.1:7345/board`, fed
live over server-sent events. Open it as the seamux app's Board tab, with cmux's
"Crew board" command (cmd+k c), as the Board control in the Dock, or with:

```
crew-board open              open /board in a cmux browser tab (starts the server if needed)
crew-board usage             open /usage the same way
crew-board state [--json]    the ranked state, without touching cmux
```

Only the seamux app (`tauri://localhost`) and the server's own pages may frame
these pages: every page carries a `frame-ancestors` policy, and the board talks
by `postMessage` only to those origins. If you run the app's pages under Vite,
start the intent server with `CREW_INTENT_FRAME_ANCESTORS=http://localhost:5173`,
because the dev port is not trusted by default.

`~/.local/bin/crew-board` is `seamux crew-board`. `push`, `watch`, `tidy` and `close`
drove the Dock surface this README describes below; the cutover retired that surface,
and those verbs now only say where the board went. The Python `crew-board` in this
directory still has them, for the probes and `docs/demo/board-demo.py`. The live tree
does not install it. Most of what follows was written for the Dock board. The ranking,
the rendering and the click routes still apply to the served page.

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
| **wilt** | broken | `ci:fail`, a deep-plan check that failed or lost its runner, `pr:conflict`, `review:changes`, a blocked increment |
| **running** | mid-turn | `claude_code=Running`, `phase:working` |
| **done** | finished, needs closing | `gone:merged`, a plan whose every increment is done |
| quiet | everything else | one line each, under a `quiet · N` divider |

`--screens` adds one `cmux read-screen` per active row, so a card shows what the agent
actually last said. It costs a socket call per row, which is why it is opt-in.

## Reading a card

```
┃ ◔ ● checkout-flow                    GATE SHUT    rail = tier · dot = worktree colour
┃ Coupon at capture needs your go-ahead.            what was said, 2 lines at most
┃ [ go 3 ] ( diff ) ( jump ) ( ● CI )               28px buttons; the first is filled
┃ dev/checkout-flow ● #142 ✓ approved   $4.20      mono footer: links, status, spend
```

One rail, in the tier's colour. The worktree's own colour, the hex Peacock paints
its VS Code window with, is the dot beside the name; it used to be a second stripe
beside the rail, and two stripes read as one smudge at Dock width.

The **button row** is everything you can do. The first chip is the verb that
resolves the row (the collector orders them that way), and on the tiers that ask
something of you (attend, wilt, done) it is filled. A working card asks nothing,
so its buttons stay ghosts: filling every card's first button made the board a
wall of colour. Actionable signals (`● CI`, `allow`, `deny`, a Jira key, the
sandbox) follow as ghosts in their own colour. Every button is at least 28px tall.

The **footer** is what you recognise the row by: branch, the dirty dot, PR, issue,
status signals (`✓ approved`, `draft`, `⚠ conflicts`), progress and spend, in one
mono line that wraps. Branch, PR and issue are links, at least 24px tall.

A **quiet row** is one line: the dot, the name, then its `diff` / `pr` chips as
ghost buttons, or, with none, its badge (and no badge when it has none). Its
rail is the jump, which is why `jump` is not repeated there. Unfolded, it shows
its footer -- branch, PR, issue -- under the line; a quiet row with no footer has
nothing to fold, and its line selects the workspace.

**Every card folds in place, and its rail is the jump.** The tier-coloured strip
down a card's left edge is 14px wide and switches to the workspace whether the
card is folded or not; hover shows an arrow on it. The header line (with a caret)
folds and unfolds. A click anywhere on a folded card unfolds it; on an unfolded
card, a click on its body (not a chip or link) selects the workspace. Cards that
wait on you or are broken start unfolded, everything else folded; a folded card
that needs you keeps its first chip, filled, on its header. What you fold by hand
lives on `#rows` as `data-fold` (id -> [open, tier]) and holds across pushes until
the card changes tier, when it takes the new tier's default -- so a card you folded
while quiet opens itself when it starts waiting on you.

A **deep-plan family** is one card. `families.py` already emits each family as a
contiguous run, parent first, ranked at its most urgent member's tier;
`render.js` folds that run into the parent's card and puts the children inside
it, on a darker well:

```
┃ ◔ ● billing-revamp                  1 NEEDS YOU   the badge counts the children
┃ Split the ledger in progress.
┃ ( diff ) ( jump )
┃ dev/billing-revamp  1/3 increments
┃ ┌───────────────────────────────────────────┐
┃ │ ▸ ◔ ● billing-ledger            [ go 2 ]  │   needs you: its line and button, inline
┃ │     Ledger schema needs your go-ahead.    │
┃ │ ▾ ◌ ● billing-invoices           WORKING  │   opened: its whole card, in place
┃ │     Mid-turn.  ( diff ) ( jump )  …       │
┃ │ ▸ ○   billing-emails           PLAN IDLE  │   one line
┃ └───────────────────────────────────────────┘
```

Each child is still a `.row` with its own `data-id`, so every button inside it
acts on the child. It folds like any card -- its header is `data-a="fold"`, which
only `intent.js` knows, and its rail (a pill inside the well) is its jump -- and
it starts folded. Unfolding sends nothing. The parent's
badge says the children's most urgent tier, counted (`1 needs you`, `2 broken`),
when that is more urgent than the parent itself; otherwise it keeps its own. A family whose
parent has no row gets a shell card named by its label, which carries no actions
of its own.

The reorder animation measures every row against the page, not its card, and
takes the card's slide out of each child's: the card's own animation already
carries the child, and adding it again moved children twice.

**Every piece of text reads at 4.5:1** on the ground behind it. The colours are
tokens on `:root` in `board.html`, and `board_probe.mjs` resolves every `color:` in
the stylesheet through them and measures it against the page, a card and an
attend card. The collector's signal colours are the Swift sidebar's, picked for a
near-black ground, and five of the seven fall short on a card (`#F97066` is 3.9:1), so
`render.js` mixes each toward white until it passes. Nothing dims text with
`opacity`, because the measurement cannot see it; the old board lost its meta line
and quiet rows that way.

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
  clock. The board keeps that for everything that carries information: a quiet row has no
  animation at all, and motion on a card always means something changed. It makes two
  deliberate exceptions, the shelf's sky and the napping cat (see **Whimsy** below), and
  `prefers-reduced-motion` stops those too.

## Verifying it

```bash
node board/board_probe.mjs   # the render path, contrast and target sizes, no cmux needed
crew-board state             # the ranking, as text
python3 docs/demo/board-preview.py --open      # this checkout's board, fixed cast, in the Dock
python3 docs/demo/board-preview.py --audit S   # measure it there: contrast, target heights, one-line rows
python3 docs/demo/board-preview.py --open --listen 8791   # ...wired to a stand-in server that prints each click
python3 docs/demo/board-preview.py --push S --port 8791   # push again, as the collector does
```

The render path is the riskiest piece: a JS error there yields a *blank surface* rather
than an error, and the daemon would keep pushing into it. The probe pulls the script out
of `board.html`, runs it against a DOM stub, and asserts — including that agent output
captured with `read-screen` is escaped rather than executed.

## Whimsy

The rule, inherited from whimsy's shaders and amended once: **motion on a card
means something happened; motion on the shelf means the board is alive.**

- **Events** move cards, and only for the push that brought them: a row that
  climbs gets a ring, one that turns done ripples and throws pixel confetti, a
  family whose last child turns done celebrates as a whole card, and the cat
  hops, stretches or perks its ears. `data-prev` on `#rows` is what makes each
  of these fire once. A quiet row never moves.
- **States in flight** move for as long as they last: a gate or question
  waiting on you breathes its button, a working dial with no number sweeps, a
  reply window drains, and the cat swats or paces.
- **The ambient two** are the exception, and the human chose them knowing they
  break whimsy's "nothing moves unless something is happening": the shelf's
  sky follows the local hour, and the napping cat opens an eye or flicks its
  tail every so often. Both are slow and sparse on purpose -- a minute-long
  fade four times a day, and three brief moments in a 47-second cycle, unevenly
  spaced so it reads as a cat and not a metronome. One cycle holds all three, so
  a peek and a flick can never land on top of each other, and the idling sits
  out any push that carries a reaction.
- **`prefers-reduced-motion` stops all of it**, except the reply window's bar,
  which is information (how long is left to answer) rather than decoration.
  Each animation is named in the reduced-motion block by its own selector, and
  `board_probe.mjs` fails if one is not; stopped, each mood holds its first
  frame, so the cat stays on its shelf, still.

**The sky** (`#shelf` `data-sky`): render.js reads the local hour at each push
and picks dawn (5-8), day (8-18), dusk (18-21) or night, and four layers inside
the shelf cross-fade over a minute -- except on a page's first push, which
shows its sky at once. A low sun, a high sun, and at night a moon with a
handful of pixel stars twinkling on a slow cycle. Every sky is dark: the cat's
charcoal was chosen against a near-black ground. The sky only changes when a
push arrives, which is at most two minutes apart.

**Confetti** is pixel bits, a dozen per card (eight for a family child, 22 for
a whole family), bursting up from the card's top edge and falling away in
steps. Each bit's spot, drift, delay and colour come from the row id, so a card
throws the same handful every time.

**Family pips** are kitten heads, one per child, beside the family card's name
and filled in that child's tier colour, with its name and badge as a tooltip --
so a card says how its family is doing before you read a sub-row. Five at most,
the most urgent first, then `+N`, so a big family does not clip its own name. When every
child is done, a family card with nothing more urgent of its own says
`all N done`.

**The header is parked.** It is `position: sticky`, with negative side margins
cancelling the body's padding so it and the shelf reach both edges. The board is a
list you scroll and the one thing you always want in view is what is waiting on
you. It costs 72px, about 12% of a Dock pane: the shelf, then the headline with
the tally beside it, then the cat's caption with the timestamp at its end. The
caption is a sentence set like one, 11.5px at full strength; it used to be 9px at
55% opacity, crammed onto the headline's line.

**The tally** (`#tally`) counts `broken`, `working` and `to close`, in the
ranking's own order, on the headline's line. The headline already counts the
attend tier and the `quiet · N` divider counts the quiet one, so neither repeats
there. Empty tiers are omitted: a row of zeroes is noise, and the absence of
"broken" reads faster than "0 broken".

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
| `swat` | a human is being waited on | crouches, lunges 3px on alternate seconds, *"hey. hey. HEY."*, *"{row} is waiting on you"* |
| `pace` | anything working **or** broken | walks the **full width** of the shelf, turns around at the halfway point, *"supervising"*, *"keeping an eye on {row}"* |
| `nap` | nothing is happening | breathes on a 6s cycle, three z's drift up, *"off duty"*, *"all quiet. nap time."* |

**What it says** (`#says`) rotates through a few lines per mood. The first of
each is the sidebar's `catSays()`; the rest are the board's own, and some name
the row the cat is watching (the first waiting row, or the first broken or
working one). The line is picked from the push's stamp, so it holds still for a
whole push and moves on with the next one rather than flickering.

**It reacts**, once, to what changed since the last push (`data-prev` remembers
each row's tier):

| reaction | when | what it does |
|---|---|---|
| `hop` | a row turned done | crouches, jumps, lands; a pixel heart rises. *"{row} is done!"* |
| `stretch` | the last thing needing you went away | one long stretch, then whatever the mood is now |
| `perk` | a row newly needs you | ears up. *"ears up: {row}"* |

One at a time, in that order, and only for the push that caused it; never on a
page's first push, when every row is new. `render.js` adds the reaction's class
beside the mood. Each plays once and hides the mood's own frames for exactly as
long, so the mood is simply back when it ends and nothing has to take the class
off in time.

Those poses are **the board's own**. `cat_poses.py` draws them as ASCII grids,
in crew.swift's 3px cells and palette, and writes them into a second marker
block nested inside the sprite, so they walk and turn with the cat.
`cat_from_swift.py` emits that block empty, keeps it when it rewrites the
sprite, and leaves it out of its `--check`: a change to the sidebar's cat does
not reach them, and nothing checks them against it. `python3 cat_poses.py
--sheet out.html` draws every pose, old and new, side by side; `--check` runs
in the probe.

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
- the **climb accent** (one pass of a ring in the row's tier colour) fires only when a row
  changed rank *relative to the rows present in both pushes* — i.e. it overtook
  something. A row displaced by an arrival has not climbed anything. See FINDINGS.md
  for the two wrong definitions this went through.

Rows that sink get no accent: losing urgency is not news. A row seen for the first
time fades in from slightly above, never from below, which would read as demotion.

**Pending** things breathe. On a row that is waiting on a human, the filled button
that would resolve it breathes a halo — exactly one moving element per row, and the
button itself never fades, so its label stays at full contrast. A mid-turn row with no
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
| the board's card | a dot in that colour by every card's name; a ring around `.row.here` |
| the focused pane's frame | `bin/crew-frame` rewrites `activePaneBorderColor` |
| Claude Code's status line | `~/.config/cmux/crew/claude/statusline.py` prints `▊ <title>` in it |

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

### Pricing overrides, while upstream is behind

ccusage prices from LiteLLM's model table, fetched at run time and cached in
`~/.cache/ccusage/http-cache` (its built-in snapshot is only for offline runs).
A new Claude model reads $0, or a wrong rate, until someone adds it there, and
that can take days. ccusage has its own way round that, `pricingOverrides` in
its config, so crew uses it instead of growing a price table again.

**An override is a published price for a named model, never a guess.** It goes
in only when upstream is missing it or has it wrong, it quotes Anthropic's
pricing page and the date, and it comes out once upstream agrees. Two files,
both shaped like a ccusage config holding only `defaults.pricingOverrides`:

- `crew/config/ccusage-pricing.json`, shipped with crew. Empty is its normal
  state.
- `~/.config/cmux/crew-local/ccusage-pricing.json`, this machine's own. An entry
  here replaces the shipped entry for the same model.

```json
{ "defaults": { "pricingOverrides": {
  "claude-example-9": { "cacheReadInputTokenCost": 1e-7,
                        "source": "Anthropic pricing, 2026-10-11" } } } }
```

Entries are keyed by the raw model name from the transcript, in dollars per
token. For a model upstream lists, a partial entry is enough: ccusage merges it
field by field with upstream's rates. Overriding only the cache-read rate moved
a day's cost by exactly cache-read tokens × the difference, and nothing else.
For a model upstream does not list, any field you leave out prices at $0, so
give all four base fields.

`crew doctor` compares each override with ccusage's cached copy of LiteLLM's
table. It reads that cache and never fetches:

- override equal to upstream: *now matches upstream — remove it* (a warning,
  because the override is no longer needed);
- different from upstream: a note quoting both values;
- no upstream entry: a note that the override is filling a gap (a warning if
  it leaves base fields at $0);
- no cache yet: skipped, with a dim note.

Four facts about ccusage 20.0.23 shaped this. The first three were measured
against a fixture transcript; the fourth is its config schema:

- **`--config` replaces ccusage's own config discovery. It does not merge.**
  ccusage looks for `./.ccusage/ccusage.json`, then `ccusage.json` in
  `$CLAUDE_CONFIG_DIR` (else `~/.config/claude`, then `~/.claude`), and uses
  the first one it finds. Passing crew's file directly would silently drop your
  own `ccusage.json`, with its timezone and your own overrides. So crew generates
  the file it passes: your discovered config with crew's entries merged over
  it, under a content-hashed name in `~/.cache/cmux-crew/ccusage/`. With no
  override at all there is no `--config`, and ccusage runs exactly as before.
- **One malformed value loses every override, silently, with exit 0.** A price
  written as a string does it, and so does a non-entry key inside
  `pricingOverrides`. So only known fields with numeric values reach ccusage,
  and doctor names whatever was dropped.
- An extra key *inside* an entry is tolerated. That is where `source`, `why`
  and `added` go. They stay in crew's files and are stripped from the generated
  one.
- The override fields have one long-context tier, at **200K** tokens
  (`…Above200kTokens`). A model whose price steps at a different threshold,
  such as Haiku 5.5 at 100K, cannot be expressed as an override. LiteLLM does
  list that tier (`…_above_100k_tokens`), but ccusage 20.0.23 does not apply it:
  a fixture with one 150K-token Haiku 5.5 request priced at $0.021, the base
  rate, where the published tier makes it $0.083. Long Haiku 5.5 prompts read
  low until ccusage handles the 100K step; the fix is ccusage's, not crew's.

Every ccusage call crew makes passes the same `--config`: `costs.py` (the board
rows and the per-workspace card), `/usage`'s reports, and the status line.

| model | field | override | upstream at time of adding | source | why |
|---|---|---|---|---|---|
| *example:* `claude-example-9` | `cacheReadInputTokenCost` | `1e-7` | `5e-8` | Anthropic pricing, 2026-10-11 | *example row, not a live override:* upstream had half the published rate |

There are no live overrides. A row goes in with its upstream value at the time,
and comes out when doctor says upstream matches.

### Usage ccusage could not price

When ccusage has no price for a model, it counts that model's tokens as $0 and
says so: `missingPricing: true` on the model's breakdown, which its JSON always
carries (no `--breakdown` needed), and `unpricedModels` in the totals. Any
dollar figure covering that model is then a floor, and **crew never prints a
floor as if it were exact.**

- A board row shows `$12.30+`, with a title naming the model. It shows even at
  `$0.00+`: a row burning only an unpriced model is not a quiet row.
- On `/usage`, the month, daily, week and per-workspace figures carry the same
  `+`, and each card adds one line naming the model.
- The status line's month figure gets the `+` and nothing more. It has no room
  for the name, and the other two surfaces show it.

Token counts are exact either way, so the subscription framing is unaffected.
An override (above) clears the `+` until upstream catches up.

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
(`crew/claude/statusline.py`) reads the same variable and follows the same rule.

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

## The news footer

The ranking answers "who needs you", one row at a time. The footer says the same
thing as a paragraph, plus what moved recently: one sentence per workspace, or
one per family, in exactly the board's order. Shut gates and untaken alignment
checks come first. Then red CI and failed checks, work in progress with its
increment count, merged and finished plans, quiet workspaces that committed
recently, and a count for the rest.

```
▸ NEWS · 5H  summary needs your go-ahead on Wire the cache.
```

It is a native `<details>` pinned to the pane's bottom edge. Collapsed, it shows
the first sentence. Open, it grows upward and shows every sentence, each on its
tier's rail. render.js writes only its contents and never replaces the element,
so if you leave it open it stays open across pushes. It is sticky rather than
fixed, so once you scroll to the end it sits after the last row instead of over
it.

**Rebuilt on every push, never generated on a timer.** `news.py` composes it
from `rank()`'s rows, so it cannot disagree with the cards above it: the push
that clears a `ci:fail` token also drops the "red on CI" sentence. The five
hours bound only the commits it counts (`CREW_NEWS_HOURS`, default 5). No model
writes it and nothing leaves the machine.

**Commits are the one expensive input**, so only the full pass reads them: one
`git log HEAD --not origin/HEAD` per worktree, onto the row in
`board-sidebar.json`. The fast pass reuses them and recounts the timestamps
against the sliding window. `--not origin/HEAD` stops a fresh worktree from
claiming main's commits as its own. A clone where `origin/HEAD` does not
resolve says nothing about commits rather than guessing (`git remote set-head
origin --auto` fixes it).

`crew-digest` opens with the same sentences, read from `crew-board state
--json`, and `crew-digest --paragraph` prints them as one line to paste.

## Refresh cadence

Two clocks, because they answer different questions.

| | every | costs | what it answers |
|---|---|---|---|
| reconcile (`crew-sync`) | `CREW_TICK_SECONDS`, 120s | ~4.5s (gh, acli, sbx) | CI, review, Jira — things only a remote knows |
| board push, fast | `CREW_BOARD_TICK`, **10s** | ~190ms | does the glass still show what is true locally |
| board push, full | every event + every reconcile + startup | ~2.1s | everything, including branch and PR |

The board used to refresh only on the reconcile's clock, so a gate you had just
opened or a turn that had just finished could sit unrendered for two minutes even
though every input was already on disk.

Ten seconds is affordable only because of the split. Measured over 10
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
| `✗ CI` (:565), `● CI` (:568), `✓ CI` (:572) | `checks` chip / `.chip.sig` | opens the checks page |
| `▣ ▢ sandbox` (:629, :634) | `.chip.sig` `data-a=sandbox-up/-down` | starts or stops the microVM |
| `go N` (:653) | `go N` chip / `.chip.sig` | authorizes the next increment |
| `plan →` (:662) | `plan` chip / `.chip.sig` | opens the plan's live page |
| `allow` / `deny` (:682, :687) | `.chip.sig` `data-a=feed-allow/-deny` | answers a blocked ask |
| `read it →` / `jump →` (:690, :695) | `jump` chip | goes to the workspace |
| reclaim (:736) | `reclaim` chip | dry-runs the reclaim, asks first |
| whole row (:803) | `.jmp` rail, `data-a=jump`; an unfolded card's body | selects the workspace |
| — | a card's header, `data-a=fold`; a folded card | folds / unfolds in place; sends nothing |
| sync clock (:1020) | `#stamp` | forces a reconcile |

Also carried over, though not clickable: the dirty dot, the whole signals
vocabulary (review, conflicts, draft, stack, **jira**), and the worktree's identity
colour, which the card wears as a dot by its name — the same hex Peacock paints its
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

## The served board

The same board also comes as a page of the intent server: `GET /board` serves
`board.html` with `render.js`, `intent.js` and a small boot script, for the
seamux app's tab or any cmux browser pane (`http://127.0.0.1:<port>/board`). It
carries the token the way `/plan/` pages do, so the Host check keeps a rebound
page from reading it.

The page does not wait for a push. Its boot script opens `GET /board/events`, a
server-sent-events stream of the ranked state (`crew-board state --json`), one
`state` event per change and the latest one at once on connect. One worker per
server builds it the way `crew-board watch` does: cmux's wake events, a stat of
deep-plan's state files, and a heartbeat (`CREW_BOARD_HEARTBEAT`, 30s) for CI,
review and Jira, which no event announces. A build that changes neither rows nor
news is not sent. Each build also writes `board-targets.json`, so a click on the
served page resolves through `/do` exactly as a Dock click does. The worker stops
a minute after the last page closes.

`EventSource` reconnects by itself; while it is down the stamp reads
"· reconnecting". `board.html` itself is unchanged, so the Dock push still works
until the family's cutover retires it. Both servers serve `/board`: the Python
`crew-board-intent` today, and `seamux crew-board-intent` after the cutover.

## Clickable, through a loopback server

The chips and rows are click targets. The Swift sidebar had them and losing them was a
regression, so the taxonomy is restored one-for-one: row → select the workspace, `jump`,
`diff`, `pr`, `checks`, `plan` / `take the check`, `reclaim`, `go N`, `close plan`, and
the sync stamp → force a reconcile. One verb is the board's own and never reaches the
server: `fold`, on every card's header.
When a click lands on a target inside another target (a child's filled button sits in
its header), the nearest one wins.

`diff` opens the branch against its base as a **lookout** review, beside the row's
terminal, and switches to that workspace: the branch's own review, so any threads
and findings `/lookout` left on it come along. `crew-diff branch` is the fallback
when lookout is not installed. Row-scoped verbs that go through the notification
RPC (`reclaim`, `archive`, `code`, `go N`, sandbox, allow / deny) send the workspace
as `workspace_id` only: cmux refuses the whole call over any key it does not know.

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
