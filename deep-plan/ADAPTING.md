# Build your own deep-plan — Ricky's edition

This is the crew-dock recipe with this machine's decisions written in, so the
next adaptation starts from how *we* work, not the original author's stack.

**Decisions made here (2026-09-12), all confirmed by Ricky:**

- **Scope:** everything except tickets (Stage 7) and observability signals
  (Stage 8) — personal laptop, hobby projects, git/GitHub only.
- **Machine profile (Stage 0):** no `defaultMode: auto`, no pre-existing hooks,
  7 prose plans, cmux nightly + crew Dock as the visible surface. No single
  main repo — many hobby projects; plans key on whatever worktree they render in.
- **Floors (Stage 3), from our own plans:** ≤120 words/paragraph (worst walls
  measured 178/140/130), ceil(words/900) diagrams min 1 (4 of 7 plans had none).
- **Quiz administration (Stage 4):** review surface in the crew Dock; grading by
  `deep-plan grade` in the session. Markdown stays the durable record.
- **Gate (Stage 5):** hard deny, exit 2; one `go` per increment. Keys and
  archived specs on `~/.claude/deep-plan/keys`, a separate tree.
- Tenet 9 (verify the signal) dropped by its own drop-rule: no external signals.

The original recipe follows, unedited — work it the same way for the next person.

---

# Build your own deep-plan

**You are Claude Code, and you are about to build a planning discipline for the person
you are working with — not install mine.**

This is a recipe, not a package. The skill it describes was shaped by one engineer's
worktrees, board, ticket tracker and observability stack. Copying it wholesale gives your
human someone else's habits. Working these stages gives them their own, with the traps
already paid for.

Read this whole file before you start. Then work the stages in order, because each one
depends on a decision made in the one before.

---

## How you must behave while doing this

Five rules. They matter more than any stage below.

1. **Never build a stage the human has not chosen.** Every ◆ marker is an
   `AskUserQuestion` with real options and a recommendation. Do not infer past one.
2. **Never carry my specifics across.** My stack is Datadog + Splunk + Snowflake, my board
   is cmux, my tracker is Jira via `acli`. Yours is whatever you find in Stage 0. If you
   catch yourself writing `lh-prod-` anything, stop.
3. **Build the probe before you wire the thing.** Anything that can block work gets a test
   first. This is not optional; see *Traps already paid for*.
4. **Everything you write into their docs must be something you measured on their
   machine.** Not "hooks fire on tool use" — run one and record the millisecond count. A
   doc full of plausible claims is worse than no doc, because it gets trusted.
5. **Stop and show your work at the end of every stage.** One paragraph: what exists now,
   what it cost, what you would do next. Let them redirect. They will.

---

## Stage 0 — Read the room

You cannot design a discipline for a workflow you have not looked at. Two halves: what they
say, and what their machine says.

### 0a. Their `/insights` — ask, do not run

**`/insights` is a terminal UI command. You cannot invoke it** — only skills are invocable,
and built-in slash commands are not skills. So ask:

> Run `/insights` and paste what it shows me — or just summarise it. I want to see how you
> actually use Claude Code before I design anything around it.

When it comes back, mine it for these five things and say what you found:

| Look for | Because it decides |
|---|---|
| **Which tools dominate** (Edit vs Bash vs Read vs Task) | whether a gate must cover Bash-as-editor, or only Edit/Write |
| **Session length and count** | whether state must survive restarts, or a session is a whole unit of work |
| **What they redo often** | the thing worth automating first — it is rarely planning itself |
| **Where turns end** | if turns end on questions, they want more gating; if they end on completion, less |
| **Model / effort / fast-mode habits** | how much per-tool-call latency a hook may spend |

Then ask them the one thing `/insights` cannot tell you:

> Where does planning currently go wrong for you — plans that drift, plans nobody reads,
> plans that skip the boring half, or work that starts before the plan is agreed?

That answer ranks Stage 1 for you. Write it down verbatim; you will quote it back later.

### 0b. Their machine — read, do not ask

Read all of these before asking another question. Report what you found, not what you
looked for.

```bash
cat ~/.claude/CLAUDE.md 2>/dev/null            # standing instructions; the rules you must not violate
ls ~/.claude/skills/ ~/.claude/commands/       # what they have already built
ls ~/.claude/plans/ | wc -l                    # do they already write plans? how many?
python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));
print('mode:', d.get('permissions',{}).get('defaultMode'));
print('hooks:', list(d.get('hooks',{}).keys()))"
git -C . rev-parse --show-toplevel 2>/dev/null # is work done in a repo? a worktree?
ls ~/.config 2>/dev/null | head                # a board, a terminal multiplexer, a dotfile system
```

What each tells you:

- **`defaultMode: "auto"`** — the gate in Stage 5 is the highest-value thing in this file.
  Auto mode never asks, so a locked plan with five increments gets done in one unsupervised
  run unless something stops it. If they are on `default` or `plan`, the gate is a
  nice-to-have and you should say so rather than overselling it.
- **Existing hooks** — you are joining a hot path, not arriving at an empty one. Note every
  `PreToolUse` entry and its timeout; yours has to coexist.
- **`~/.claude/plans/` already full** — they plan already, in prose. Read three of them.
  The gaps you find are the house rules for Stage 3, and they will be specific to this
  person. (In mine: 46 plans, 4 with a single diagram. That one number justified the whole
  diagram floor.)
- **Worktrees** — decides whether state keys on a path, a session id, or both.
- **`~/.config/<something>`** — a board or sidebar is the difference between Stage 6 being
  half an hour or being skipped.

◆ **Decision 0: scope.** Ask before building anything:

- **The spine only** — spec → surfaces → alignment check. Half a day. Everything else
  hangs off it later. *(Recommend this unless they say otherwise.)*
- **Spine plus the gate** — adds state and a `PreToolUse` refusal. The right answer if
  `defaultMode` is `auto`.
- **Everything** — including board, tickets, signals. Only if they have a concrete project
  to run through it this week; otherwise you will build surfaces nobody opens.

End of stage: a written profile they confirmed. Keep it — Stage 10 turns it into a doc.

---

## Stage 1 — Choose the tenets

Ten tenets. Each one earned its place by something that went wrong. Present them **ranked
against the answer they gave in 0a**, and get a keep / adapt / drop on each. Do not present
all ten as equally important; that is how you get ten yeses and no discipline.

| # | Tenet | It exists because | Drop it when |
|---|---|---|---|
| 1 | **The spec is the artifact.** One JSON file; every surface derives from it and is regenerable. | A plan that lives in chat dies with the session. A plan that lives in six hand-edited files disagrees with itself. | Never. This is the load-bearing one. |
| 2 | **Evidence or it is a risk.** Every load-bearing claim carries `path:line`; anything uncited moves to `risks`. | A memory note named four files as broken; three were already fixed and the real defect was elsewhere. | Never, but the citation form can be theirs. |
| 3 | **Diagrams instead of prose walls.** A floor: `ceil(words / N)` diagrams, minimum 1. | 46 existing plans, 4 with a single diagram. Nobody reads the walls, including their author. | They think in prose and genuinely reread it. Rare. |
| 4 | **Interrogate before drafting.** Every hard-to-reverse fork goes to the human as a concrete choice *before* the plan exists. | A plan that silently resolved a fork is a plan the human never agreed to. | Never. This is also how you should be running *this* file. |
| 5 | **A graded alignment check.** 3+ questions on *consequences*, non-leading by construction, and it must pass before implementation. | Approval means "I skimmed it". A wrong answer means the plan and their model disagree — and either one may be the broken one. | They are the only reader of their own plans and always will be. |
| 6 | **The gate.** Auto mode stops at the plan boundary until a human authorizes each increment. | Auto mode never asks. Five increments get done in one run. | `defaultMode` is not `auto` and never will be. |
| 7 | **Plan and progress are different files.** The spec changes on a decision; state changes hourly. | One file for both means either a heavyweight re-render per status change, or a spec you cannot trust. | The plan has no increments. |
| 8 | **Generate, never apply.** Producing an artifact and applying it are different commands. | Generation is reversible; applying a monitor, a migration or a ticket is not. | Never. Collapsing them makes the safe half as dangerous as the unsafe half. |
| 9 | **Verify the signal before trusting it.** A check whose query returns nothing is not passing, it is blind. | An estate of monitors pinned to metrics that stopped existing, silently green for years. | They have no external signals at all. |
| 10 | **Record the measurement, not the number.** Any threshold carries what was measured and *how it was aggregated*. | A p90 read with a `max` aggregator gave 0.68s; the real typical was 0.07s. The threshold was 14× too loose. | Never. It costs one sentence. |

◆ **Decision 1: which tenets, and in what order.**  Push back once if they drop 1, 4 or 8 —
those three are what make the rest cohere — then build what they chose.

---

## Stage 2 — The spec contract

Smallest thing that holds a plan. Start here, in their scratchpad, hand-written, before any
renderer exists:

```json
{
  "slug": "kebab-case-names-every-output",
  "title": "imperative, ticket-prefixed if they use tickets",
  "context": "why now, what exists, what is out of frame",
  "decisions":     [{ "decision": "...", "why": "..." }],
  "verifiedFacts": [{ "claim": "...", "evidence": "path:line" }],
  "diagrams":      [{ "question": "the question it answers", "mermaid": "..." }],
  "deliverables":  [{ "title": "...", "body": "...", "files": ["..."] }],
  "verification":  ["runnable commands and observable checks"],
  "quiz":          [{ "id": "q1", "prompt": "...", "options": ["..."], "answer": 0,
                      "why": "...", "decisionRef": "the decision to reopen when missed" }]
}
```

Teach them these four properties as you write it, because each one is a decision they are
making now and living with later:

- **`slug` names every output.** One name, one plan, everywhere.
- **`diagrams[].question` leads.** It is the heading, not a label. "How does a write reach
  the outbox?" not "Outbox diagram". This single habit is why the diagrams get read.
- **`deliverables` are increments.** One per unit of work that could ship alone. This array
  is what the gate, the tickets and the progress tracker all key on. Getting the
  granularity right here is the highest-leverage thing in the spec.
- **`quiz.answer` indexes the array as written.** The renderer shuffles per-slug and stores
  the shuffled position in the key, so the two never drift.

◆ **Decision 2: where the answer key lives.** It must be a *separate tree* from the
rendered plan — my layout is `~/.claude/plans/` for output and
`~/.claude/deep-plan/keys/` for the spec archive and the key. Anything that carries answers
must never sit where it could be pasted into a review surface. Ask them where, but do not
accept "same directory".

---

## Stage 3 — The renderer, and their house rules

One script: spec in, surfaces out. Order the surfaces by what they will actually open.

Start with **two**: a durable markdown plan, and whichever review surface their client
supports. Add more only when asked. Every surface must be regenerable from the archived
spec — build `--rehydrate <slug>` in the first version, not later, and prove it is
byte-identical.

The renderer's real job is refusing bad specs. **Their floors, not mine:**

```
diagram floor        ceil(prose_words / N) diagrams, minimum 1
paragraph ceiling    no paragraph over N words in context or a deliverable body
evidence             every verifiedFacts entry has both claim and evidence
rationale            every decision has a why
```

◆ **Decision 3: the numbers.** Derive N from *their* plans, not from mine. Read three,
count the words per paragraph and the diagrams per thousand words, and propose floors that
would have rejected their worst plan and passed their best. Show them the arithmetic. A
floor they cannot justify is a floor they will pass `--force` to.

Then teach the rule that makes floors work: **the fix for a wall is to draw it, not to trim
it to just under the limit.** Put that sentence in their skill doc.

---

## Stage 4 — The alignment check

The part most likely to be built badly, because a bad quiz feels the same as a good one
while producing false confidence.

**Ask about consequences the human did not explicitly decide.** "Which of the two reported
errors does this actually fix?" is a real question. "What did you choose for cutover?" is
recall, and they will always get it right.

Then make it non-leading *by construction*, because intent is not enough. Reject, in code:

- any option containing *recommended / correct / obviously / of course / as decided / as we
  agreed / best practice / the right*
- "all of the above" / "none of the above"
- the correct option being the single longest — the classic length tell
- option lengths spread wider than ~2.2×
- the prompt echoing a distinctive (>6 char) token unique to the correct answer

Beyond what a linter sees, teach: **draw distractors from real vocabulary in their
codebase** — actual enum values, real class names, plausible-but-wrong mechanisms. A
distractor nobody would pick teaches nothing.

Grading closes the loop: exit non-zero on any wrong or unanswered question, and name the
decision to reopen. Then say the thing that makes it a discipline rather than a test:

> A wrong answer means the plan and your model of it disagree, **and either one may be the
> broken one.** Fix whichever is wrong, re-render, re-check.

◆ **Decision 4: how the check is administered.** Branch on *capability*, never on guessing
the client: a rich review surface if their client renders HTML, an interactive widget if
their host injects one, plain text in a terminal. Whatever they pick, the durable record is
the markdown, and rehydration reproduces the rest.

---

## Stage 5 — State, and the gate

Build this only if Stage 0 found `defaultMode: "auto"`, or they asked for it. It is the
highest-value stage and the only one that can obstruct their work, so it gets the most care.

### 5a. State first, gate second

One small JSON file per plan, on its own tree, holding what happened rather than what was
planned:

```json
{ "slug": "...", "phase": "review | implementing | done",
  "gate": "increment | open",
  "root": "/the/worktree/this/plan/guards", "session": "the session that rendered it",
  "increments": [{ "n": 1, "title": "...", "status": "pending | authorized | working | done | blocked",
                   "authorizedAt": 0, "startedAt": 0, "doneAt": 0 }],
  "log": [{ "at": 0, "what": "one line, human readable" }] }
```

Three properties to get right the first time, because each one bit me:

- **Atomic writes.** Write a temp file and rename. The gate reads this on every tool call,
  and a half-written JSON reads as "no plan" — exactly the wrong default for a gate.
- **An existing `root` outranks an inferred one.** Only an explicit `--root` may overwrite
  it. I inferred root from `process.cwd()`, grading re-rendered from the skill directory,
  and the root silently moved out of the worktree — which does not badge the wrong thing, it
  *disarms the gate*.
- **Two match keys, conservative in different directions.** Session id is exact but dies on
  restart; git root survives restarts but is wrong if the renderer ran elsewhere. Match on
  either. And only take over `session` when the recorded `root` no longer exists — otherwise
  any session that rehydrates someone else's plan silently rebinds it. I did that to a live
  plan while testing.

### 5b. The gate, and its fast path

A `PreToolUse` hook. **Exit 2 with a message on stderr blocks the call and shows you the
reason** — that is the mechanism, and it is likely already proven on their machine if they
have any guard hook.

The hot path matters. `PreToolUse` fires thousands of times a session, and almost always
with no plan tracked. Measured here, 20 iterations each:

| | cost per call |
|---|---|
| bash guard, glob test only | **6 ms** |
| node, importing the state module | 52 ms |
| python3, parsing stdin JSON | 49 ms |

So: a tiny shell wrapper answers the common case before any interpreter starts, and the real
decision lives in whatever language the rest of the tooling is in. Node and python cost the
same, so **share the decision function with the CLI instead of reimplementing it** — one
definition of "may I edit".

### 5c. Scope it narrowly or it gets switched off

This is the difference between a gate they keep and a gate they disable in week two.

| Never gate | Because |
|---|---|
| paths outside the plan's own root | the scratchpad, `~/.claude`, `/tmp` are not the change |
| reads, greps, status commands, test runs | not writes |
| the plan's own tooling | a gate that blocks the command that opens it is a deadlock |
| a plan whose every increment is done | a gate that outlives its work is broken |
| a plan the human explicitly opened | give them one lever, and log its use |

Bash is the hard case and the one that matters most: under auto mode a heredoc or a
`sed -i` is a file edit that never touches the Edit tool. Match mutating commands by
heuristic. **False negatives are acceptable; false positives are not** — blocking `grep`
makes the whole thing intolerable within an hour.

Also decide, deliberately: **the gate fails open on a bad root.** It only refuses calls
whose target is inside the plan's root, so a plan recorded against the wrong directory gates
nothing. That is the safe direction, but nothing detects it — so print the root in their
status command.

◆ **Decision 5: what a blocked call says.** Two shapes, and it changes the UX materially:
hard deny (exit 2) so the agent must ask in conversation and one command authorizes a whole
increment; or a native permission prompt so the human clicks through per call. Recommend
hard deny — the go-ahead is per increment, not per tool call, and a prompt per call trains
them to click through it.

### 5d. Prove it before you wire it

**Write the probe first.** Synthesize `PreToolUse` payloads and assert exit codes, against a
throwaway state directory and a throwaway git repo. Cover both directions:

```
untracked repo, Edit                      -> allow
review phase, Edit inside the root        -> deny
review phase, path outside the root       -> allow
no increment authorized                   -> deny
grep / git status / test run              -> allow
sed -i / git commit / a heredoc write     -> deny
the plan's own commands                   -> allow
authorized increment, Edit                -> allow, and flips it to working
all increments done                       -> allow
gate opened by the human                  -> allow
a parked plan in the same repo            -> must not deadlock a live one
```

Mine has 24 such assertions. That number is not the point — the point is that you cannot
responsibly wire a refusal into someone's editor without them.

Then wire it, and **prove it actually fires** with a sentinel: temporarily prefix the hook
command with `echo "$(date) fired" >> /tmp/hook-check`, trigger a matching tool, read the
file, strip the prefix. Measured here: a `settings.json` hook change was picked up **on the
very next tool call in an already-running session** — no restart, no `/hooks`. Do not assume
that; verify it on their machine, because the opposite would leave them thinking the gate is
live when it is not.

---

## Stage 6 — Make it visible

Optional, and worth it only if Stage 0 found a board, sidebar, status line or notification
surface they already look at.

The pattern that works: the plan's tooling writes a **marker or state file**, and their
existing surface *reads* it. Do not invert that — a plan tool that pushes into a UI couples
two things that fail separately.

Two things to warn them about, both learned the hard way in a custom sidebar DSL, and both
of a class that recurs in every such DSL:

- **Silent rendering failures.** A string interpolation containing its own string literal
  rendered *nothing at all* — no error, validation passed, the whole conditional block just
  absent from the output. Assume any templating layer has failures of this shape, and
  **build a probe that asserts the rendered output contains what you expect**, rather than
  trusting that it compiled.
- **Conditional containers.** A row's chip strip was gated on four unrelated tokens, so a
  row carrying only *my* token rendered an empty strip. Read the surrounding conditions
  before adding to a UI you did not write.

If their board can trigger a command, one chip is worth more than five badges: the one that
authorizes the next increment. A badge tells them something is waiting; a chip lets them
answer it.

---

## Stage 7 — Tickets

Optional. Build it only if they have a tracker *and* the plan's increments map onto it
one-to-one.

The rule that makes this good rather than annoying: **where the children go follows the
parent's hierarchy level, not its name.**

- the plan references a Story / Task / Bug → children are **sub-tasks of that ticket**
- the plan references an Epic → children are **tasks under the epic**
- the plan references nothing → create the parent, then children under it

And **discover the type names; never hardcode them.** The project I work in calls its
subtask type `Sub-task`, with the hyphen. A hardcoded `"Subtask"` fails at create time with
a message about an invalid issue type, at the worst possible moment.

Keep a `--dry-run` that prints the exact commands and creates nothing, and make the
read-only lookups still run under it — a dry run that stubs out the parent lookup reports a
problem with a ticket it never asked about.

---

## Stage 8 — Signals: what the plan will be able to prove

The tier structure is portable even though my systems are not. Substitute theirs.

| Tier | Answers | Usually owned by |
|---|---|---|
| **logs** | what exactly happened to this one entity | engineering |
| **metrics / traces / RUM** | is it healthy, and did this deploy change that | engineering |
| **warehouse / analytics** | did the business outcome move | product + data |

◆ **Decision 8: which systems fill those three rows.** Ask, then **verify each one before
building on it.** I assumed logs and metrics lived in the same tool; a bare `*` log query
returned zero results org-wide, and every log actually lived in the other system. That one
query changed the whole design.

Three portable lessons regardless of stack:

1. **Find the changeset identity.** Mine is a `version` tag carrying the merge commit SHA,
   present on every span in every environment. Without something like it, "did my change
   break it" is unanswerable, and you are looking at the whole service and calling it your
   change. Go find theirs before designing any check.
2. **Distinguish sampled from unsampled.** Sampled data cannot prove absence. Whichever of
   their systems is unsampled is the one that can carry a *deterministic* per-change
   assertion; the sampled one is for calibration and trend.
3. **A pre-production environment may be a canary, not a small production.** If its traffic
   is driven by tests, absence of signal *is* the failure — so the right instrument there is
   an assertion, not a threshold. A threshold monitor on test-driven traffic measures the
   test.

Then two ideas worth stealing whole:

- **A signal floor.** Once a spec declares any metric, require a decision on every tier — a
  metric, or an explicit written reason that tier is not applicable. "No user-facing
  surface" is a fine answer; silence is not. Same shape as the diagram floor: it demands a
  decision, not invention.
- **Generate, then verify, then apply — three commands.** Recipes in the spec become
  artifacts; a verify step emits every check *plus* a probe per generated artifact ("does
  this query return data"); application is separate and often manual. Emit the verify list
  as JSON and an agent can run it while the CLI stays the recorder. That separation is what
  keeps an executor going away mid-run — an expired token, a missing credential — from
  wedging the plan. Mine did exactly that, and nothing broke.

If they already solicit metrics in a shared document, **emit that document's columns
verbatim** rather than inventing a format. A file that pastes into the artifact people
already argue in beats a better format nobody opens.

---

## Stage 9 — Probes

By now there are three or four things that can fail silently. Give each one a probe, and
make every probe runnable in one command with no arguments.

What makes a probe worth having, rather than theatre:

- **A throwaway everything.** Temp state dir, temp git repo, temp output dirs — driven by
  environment overrides you added for exactly this purpose. A probe that writes into their
  real plans directory is not a probe.
- **Assert both directions.** "Blocks what it should" is half a test. The failure that
  actually hurts is "blocks what it should not".
- **Assert the conventions, not just the shape.** Not "a monitor file was written" but "the
  monitor notifies the channel from the spec, carries the org's required webhook, and queries
  a metric that exists".
- **The example doubles as the fixture.** Point the probe at the reference example spec. It
  keeps the example honest, and a broken example breaks the build — which is what you want.
- **`-v` walks it step by step.** Then the probe is also the demo you show a new teammate.

---

## Stage 10 — Three documents, three audiences

Write all three. They are short and they diverge fast if you skip one.

| File | Audience | Contains |
|---|---|---|
| **`SKILL.md`** | the agent using it | how to run it, the house rules, the gotchas, a troubleshooting table keyed on real error strings |
| **`DEVELOPING.md`** | whoever changes it next | current file inventory with line counts, the integration seams, **measured** constraints, known debts, and the exact commands that verify a change |
| **`ADAPTING.md`** | a teammate building their own | this file, rewritten for their choices |

Two habits that make these worth reading:

- **Put the measurement next to the claim.** "6 ms bash, 52 ms node, measured 20 iterations"
  is useful for years. "Bash is faster" rots immediately.
- **Keep the debts list honest and current.** Mine names a gate that fails open on a bad
  root, a heuristic that will miss exotic writes, and two writers with no lock. A debts list
  someone trusts is worth more than a features list.

---

## Traps already paid for

Read these before building, not after. Each one cost real time.

**Silent failures**

- A hook that never fires looks exactly like a hook that always allows. Sentinel-test it.
- A monitor, check or query whose result set is empty is not passing — it is blind. Verify
  every query returns data *before* you build on it.
- Instrumentation can record an error without *declaring* one. A library here set
  `error.message`, `error.stack` and `error.type` and never the error flag: every failed
  span reported healthy, no error metric existed at all, and the error-tracking stack could
  not see any of it. One query settles it — search for the error-message attribute and group
  by status. Anything in an "ok" bucket is invisible.
- Templating DSLs fail quietly. Assert on rendered output.

**Numbers that lie**

- A percentile is a *series*, and how you collapse it decides the number you get. A `max`
  aggregator gave me 0.68s where the typical value was 0.07s, and the threshold derived from
  it was 14× too loose. Read the series; quote the typical *and* the peak; record the
  aggregation.
- Prefer a band derived from a metric's own history over a number someone picked. It cannot
  be mis-set the way the above was. Keep a static threshold as a backstop for the case the
  band has adapted to a bad new normal.
- Auto-derived metric names that encode the source layout — file path, method name — rename
  themselves during a refactor and take every monitor with them, silently.

**Discipline**

- Anything carrying quiz answers must never sit where it can be rendered, pasted or
  attached. Separate tree, and say so in the docs.
- Never hand-edit a generated surface to record progress. Progress is a command; a plan
  change is a spec edit plus a re-render. Anything written into the artifact is gone on the
  next transition.
- One writer per file. If several commands can transition the same state, expect a lost
  update eventually, and write that down as a known debt rather than pretending.

---

## If you only have an hour

Build, in this order, and stop wherever the hour ends:

1. The spec contract (Stage 2), hand-written for one real plan they have right now.
2. A renderer that emits a markdown plan and refuses a spec missing evidence or a
   rationale (Stage 3), with `--rehydrate` proven byte-identical.
3. Three quiz questions about consequences, graded, exiting non-zero (Stage 4).

That is a working discipline. Everything after it — the gate, the board, the tickets, the
signals — is leverage on top, and none of it helps if the spec is not the artifact.

**Then hand them back this file with their decisions written into it**, so the next teammate
starts from their way of working rather than mine.
