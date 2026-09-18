# deep-plan — developing

For whoever changes this next. Built 2026-09-12 on this machine, from
`~/code/crew-dock/deep-plan/ADAPTING.md`.

## Inventory

| file | lines | what |
|---|---|---|
| `deep_plan.mjs` | 1488 | CLI: render/rehydrate/grade/status/transitions/diff; validate() enforces the contracts block, grade() enforces contract quiz coverage + cuts the approved snapshot; DP_EDITOR_JS carries dpMd + the ADR editor |
| `lib/state.mjs` | 160 | state IO + THE decision function (`decideToolCall`) — one definition of "may I edit", shared by CLI and gate |
| `hooks/gate.sh` | 13 | PreToolUse fast path: glob test, exec node only when state files exist |
| `hooks/decide.mjs` | 43 | slow half: parse payload, decide, exit 2; flips authorized→working on first edit |
| `probe.mjs` | 563 | throwaway everything, `-v` walks it; prints its own count |
| `examples/example.spec.json` | — | reference spec; the probe's fixture, so a broken example breaks the build |
| `vendor/mermaid.min.js` | 3.4MB | inlined base64 into surfaces; the intent server swaps it for `/mermaid.min.js` |

Trees: state `~/.claude/deep-plan/state/`, keys+archived specs
`~/.claude/deep-plan/keys/` (separate on purpose — never render from there),
surfaces `~/.claude/plans/`. Probe overrides: `DEEP_PLAN_STATE_DIR`,
`DEEP_PLAN_KEYS_DIR`, `DEEP_PLAN_PLANS_DIR`, `DEEP_PLAN_SKILL_DIR`.

## Integration seams (change these and the board breaks)

- `status --json` rows: `{slug, root, phase, gate:{allow,why}, progress:{total,
  done, next:{n,title}, blocked:[{title,note}], open:[{title}]}}` — consumed by
  `~/.config/cmux/crew/board/crew-board` (plans(), ranking tiers).
- Surfaces named `<slug>.md`, `<slug>.review.html`, `<slug>.working.html` —
  `crew-board-intent` serves working over review at `/plan/<slug>`.
- Working surface markup: `.dp-act[data-a][data-n]` buttons rendered disabled
  with a title ending "— available when served in the Dock" (the injected
  PLAN_JS strips exactly that suffix); `.dp-path[data-file]` spans; `#dp-auto`
  checkbox armed on its change event, polling `window.__dpChanged`.
- Asks: `~/.claude/plans/asks/<id>.json` (`{id, created, header, question,
  mermaid, options:[{label, description, mermaid, example}], surface, workspace,
  cwd, slug, answer:{n, at, delivered}|null}`) and `<id>.html` beside it, written
  by `deep-plan ask`; the page's `.dp-ask-pick[data-n]` buttons render disabled
  and `crew-board-intent` serves `/ask/<id>` with ASK_JS injected, `/answer`
  records into the json and types into `surface` only. `deep-plan ask` calls
  `/do?a=ask&r=<workspace>&x=<id>` best-effort to open the Dock tab.
- Risk cards on editing surfaces: `li.dp-risk[data-n][data-disposition][data-payload]`
  with radios `dp-risk-N`, `.dp-risk-deliv`, `.dp-risk-ticket`, `.dp-risk-note`;
  `window.dpRiskLines()` stages `- [risk N] <disposition>: <payload>` lines into
  both copy-back blobs. `riskView()` is the one reading of an entry every
  renderer uses; `key.undispositionedRisks` is what grade refuses on.
- Mermaid inlined as `src="data:text/javascript;base64,…"` — must match
  crew-board-intent's `MERMAID_DATA` regex or every page ships 3.4MB.
- Transitions the intent server offers: `go start done block reset`, plus
  `close`; triage.py's plan-go runs `deep-plan go --at <cwd> next` (shim at
  `~/.local/bin/deep-plan`).

## Measured on this machine (2026-09-12)

- Gate hot path with state files present, path untracked: **~45 ms/call over
  20 iterations** (node startup dominates). With no state files the bash glob
  answers without starting node.
- A `settings.json` hook edit was picked up **on the very next tool call in an
  already-running session** — sentinel-tested (`echo fired >> /tmp/dp-hook-check`),
  two fires recorded, no restart. Do not assume this survives Claude Code
  upgrades; re-run the sentinel when in doubt.
- House floors derived from the 7 plans in `~/.claude/plans` on build day:
  worst paragraphs 178/140/130 words → ceiling 120; 4 of 7 plans had zero
  diagrams → floor ceil(words/900), min 1.

## Sharing seam (added 2026-09-12)

- `export-artifact <slug>` emits `~/.claude/plans/<slug>.artifact.html` — the
  shareable page (no quiz, no key material, no base64 mermaid; probe asserts all
  three). The AGENT publishes it (Artifact tool) with
  `{db: {rules: [{path: "annotations", write: "interact"}]}}` — rules shape
  verified against the control plane 2026-09-12; the `user` capability does NOT
  exist in contract 0.2.46, so annotator identity is self-reported
  (localStorage name, `author_id: null`).
- `attach-artifact <slug> <url>` records `{url, spec_hash, published_at}` in
  state; working surface links it and flags staleness by hash.
- Pulled-back annotations live at `~/.claude/deep-plan/annotations/<slug>/annotations/<id>.json`
  (the Artifact read_db `out_dir` layout); `readAnnotations` renders them on the
  working surface. The CLI never touches the network — the agent does the
  fetching, per SKILL.md.

## Contracts seam (added 2026-09-14)

- Spec gains an optional top-level `contracts` key (see SKILL.md shape).
  Enforced in `validate()`: fields, decisionRef→decision, external scope
  needs adr-flag or `waiver`. Coverage lives in the KEY file
  (`uncoveredContracts`, computed at render) and is refused by `grade()`
  before answers are read — a human decision (reopened at review): render
  stays permissive, grading is the wall.
- `contractsHtml()` renders the section on review/working (via commonBody),
  the md plan, and the exported artifact page. Board `status --json` is
  untouched.

## ADR editor + snapshot seam (added 2026-09-15)

- `DP_EDITOR_JS` (emitted by commonBody when withNotes): dpMd markdown subset
  + per-card ADR editor + promote buttons. Both surfaces' copy buttons call
  `window.dpAdrLines()` — changed fields serialize as
  `- [adr N · field] <\n-escaped payload>`, staged promotions as
  `- [decision: <name>] promote to ADR`. The line grammar is ADR 0002:
  extend the section vocabulary, never the grammar.
- `grade()` success writes `<slug>.approved.md` once (immutable) and records
  `{spec_hash, path}` in `st.approved`; workingHtml renders a drift note on
  hash mismatch; `status --json` rows gained an additive `approved` field.

## Known debts (honest list)

- The gate **fails open on a bad root** and nothing detects it beyond `status`
  printing the root.
- The Bash mutation heuristic will miss exotic writes (`dd`, `python -c` with
  file IO, `xargs rm`). Deliberate: false positives are the killer.
- Bash is gated by **cwd**, not by parsing target paths out of the command — a
  command run outside the root that writes into it passes.
- Two writers, no lock: the gate's authorized→working flip and a concurrent CLI
  transition can lose an update. The flip re-reads before writing, which narrows
  but does not close the window.
- `grade` accepts answers on the command line, so they land in shell history.
- The review page's quiz is display-only; grading is CLI. If a POST route is
  ever added to crew-board-intent, keep the key read server-side.
- Annotation authorship is honor-system: no `user` capability in contract
  0.2.46, so `author_name` is whatever the viewer typed, and any interact-level
  viewer can write any doc in `annotations/` (per-author rules not attempted).
  Acceptable for invited colleagues; revisit if the contract grows identity.
- The stale-artifact warning fires on spec-hash mismatch but nothing renders it
  on the BOARD row — only on the working surface.
- The contracts floor can over-fire on plans that mention contract files
  without changing their shape; `waiver` and `--force` are the valves. Watch
  the first few real plans.
- The scouting cap (one sub-agent per uncertain claim / contract surface) is
  SKILL.md prose, not code — nothing meters it.
- dpMd is a deliberate subset: nested lists, tables and mixed emphasis
  mis-render as flat text. Fallback is escaped literal text, never broken HTML.
- No size guard on staged ADR fields — a very large edit makes one very long
  blob line.
- **The probe aborts rather than fails when `grade` cannot pass.** Everything
  after the "grade -> implementing" section reads a file that grading produced —
  the approved snapshot, then the applied ADRs — so a change that breaks grading
  outright ends the run on an ENOENT partway down, instead of printing the
  failures already collected above it. The two snapshot reads are now guarded;
  the ADR section still has several. The suite still exits non-zero, so CI stays
  honest, but the first screenful is a stack trace rather than the list of what
  broke. Found by mutation-testing: deliberately breaking a guard is how you
  learn whether its assertion can actually fail.

## Observability seam (added 2026-09-16)

Two different things share the word, and conflating them is the trap:

- **`spec.observability`** (top level) — advisory. What exists today, what gaps
  this plan fills. Rendered when present, never required.
- **`spec.deliverables[i].observability.checks`** — a **gate**. Declaring checks
  on a deliverable means that increment's `done` is refused until a verdict is
  recorded. Most increments do not change what the system reports about itself,
  so an increment that declares nothing is `n/a` and gates nothing — demanding a
  verdict from every increment would make the mechanism noise.

`obs check` prints what the spec declared; `obs pass|fail <slug> <n> "<what you
saw>"` records it; `done --force` overrides and the log says the verdict was
overridden. There are deliberately **no check generators**: the older engine
generated these blocks per vendor, and that is where all of its org-specific
knowledge lived. The engine only ever needed to display a declaration and record
a verdict, so the declaration is authored in the spec like every other
commitment the plan makes.

`reconcileObs` in `lib/state.mjs` carries two rules that both come from a way
this can silently go wrong:

- A recorded **pass survives** the declaration being dropped from the spec. It
  was true when it was recorded, and deleting evidence is worse than keeping a
  verdict nothing reads.
- Adding the field to a spec whose state file already exists flips `n/a` to
  `pending`, rather than leaving the increment un-gated because the field
  arrived second.

`status --json` carries `obsOutstanding` so the board can show that a plan which
looks one increment from finished is not.

**Resetting an increment re-gates its verdict.** A verdict proves something
about the code that was there when it was recorded; redoing the increment
invalidates it, and a `pass` left in place would let the gate through on stale
evidence — silently, which is the single failure this mechanism exists to
prevent. The prior verdict is folded into the note (`was pass: … (reset —
re-verify)`) rather than deleted, so re-gating costs no evidence. `obs reset`
is the explicit hatch for the other case: the work stands but the evidence does
not.

This is a **deliberate divergence** from the older engine, which kept the
verdict across a reset and relied on the human remembering to clear it.

## The increment reconcile preserves what it does not own

`render` rebuilds `st.increments` from the spec's deliverables. That used to be
a field **whitelist**, which is complete for a plan this engine created — it
writes nothing else — and therefore looked correct for as long as no plan came
from anywhere else. On one that did, every unlisted field was dropped on the
next render with no error and no log line. `prev` is now spread first and the
owned keys listed after, so the spec still wins on `title` and unknown fields
survive. A probe assertion plants a field no version of this engine has ever
written, because the property is "does not drop the unknown", not "knows these
four names".

**This engine deliberately does not WRITE a per-increment `files` field.** The
older one did, but measured across 68 real increments it was a verbatim copy of
`spec.deliverables[i].files` in 68 of 68 cases — a denormalization of a field
the spec already owns and this engine already renders from. Adding it here would
mean maintaining a second copy that can disagree with the spec.

A plan migrated from that engine still carries the copy, and the reconcile above
preserves it rather than deleting data. That is harmless precisely because
nothing reads it: every surface renders `files` from the spec. Do not start
reading the state copy — it is a fossil, and on any plan whose spec was amended
after migration it is the stale of the two.

## The three spec-only artifacts (added 2026-09-16)

`writeSpecArtifacts()` emits all three, and is called from **both** `render` and
`rehydrate`. One writer on purpose: two call sites emitting different subsets is
the bug shape this engine keeps finding in itself, and `rehydrate` is the only
re-render available for a plan whose spec cannot pass the floors (every real
pre-seamux spec is in that position).

| file | for | why it is not the review page |
|---|---|---|
| `<slug>.quiz.txt` | a terminal session | the review page is HTML, and `grade`'s TTY prompt asks `q1 = ` without showing the question |
| `<slug>.widget.html` | a rich client's inline widget | a fragment styled from the HOST's CSS variables, answered by `sendPrompt` rather than a clipboard blob |
| `<slug>.cutover/` | parking the plan in a tracker | self-contained epic + one standalone brief per increment, quiz stripped |

**All three quiz surfaces must letter the options identically.** quiz.txt, the
widget and the review page each call `shuffled(q.options, slug + ":" + q.id)`,
and the key records that shuffled position. Any surface that ordered them
differently would grade correct answers as wrong. A probe assertion recomputes
the expected order independently of the engine rather than restating it.

Letters, not the older engine's numbers: this engine's `grade` takes `q1=a`, so
quiz.txt prints the exact command and the widget sends a runnable one, instead
of a payload something has to translate.

**The widget inlines the vendored mermaid as a data URI**, like every other
surface here — not a CDN import. A widget that needs the network to draw its
diagrams renders blank on a train. Assert this on script *sources*, never as a
substring of the file: a 3 MB base64 blob contains "cdn", and most other short
strings, by coincidence.

**The cutover bundle excludes the quiz and the key, and that is asserted.** The
bundle is built from the same spec that holds the quiz, so the exclusion is a
choice rather than a side effect. The assertion is about the quiz *structure* —
no prompt, no option set rendered together, no key material. A lone option that
happens to name a method the plan discusses will appear in the plan body and
must: the bundle IS the plan, and the quiz only ever tested whether you read it.

Context, decisions, verified facts and non-goals are repeated in **every**
increment brief, deliberately. A child task is read on its own by someone who
will not open the epic first, and deduplicating the context is precisely what
makes handoff docs useless. Increment files are numbered by **array position**,
never a parse of the title — real plans have an "Inc 2b".

## Extension verbs (added 2026-09-16)

`~/.claude/deep-plan/ext/<verb>.mjs`, overridable with `$DEEP_PLAN_EXT`.
`deep-plan <verb>` runs it as a subprocess when no built-in verb matches.

**Why under the data tree and not in the skill.** Three things destroy an
in-skill `ext/`: `install.sh --uninstall` does `rm -rf "$SKILL"` (and its
"kept" list names `~/.claude/deep-plan` explicitly), installing with
`rsync --delete` removes anything the repo does not have, and a plain rsync
leaves it but then drift reporting has to learn about it. This is the same
placement `~/.config/cmux/crew-local/` made for crew: a **sibling** of the
synced tree, not a child.

**Why a subprocess and not an import.** The gate runs through this same engine,
so an extension that throws or hangs must not be able to take it down. And a
static `import` of an optional module fails at load time on every machine that
lacks it — which is exactly how the older engine wired its private modules, and
why they could not simply be deleted from it. The contract is argv, env and an
exit code, which is small enough to keep stable.

**A built-in always wins.** Dispatch lives in the `default` branch, after every
`case`, so no private file can redefine `grade`, `go`, or anything the gate
reads. The usage listing marks such a file `SHADOWED … never runs` rather than
advertising a verb that can never dispatch — telling someone their extension is
available when it is unreachable is worse than not listing it.

**Both env spellings are passed** (`DEEP_PLAN_STATE_DIR` and `DEEP_PLAN_STATE`,
and so on). An extension that ignores an override does not error; it writes to
the default tree. Not hypothetical: the first module ported into this seam
hardcoded its paths and wrote into the real `~/.claude/plans` from a throwaway
test tree.

**What it does NOT cover: transition hooks.** The older engine pushed to a
tracker on `done` behind `state.jira.autoSync`. Measured here: that flag is set
on **1 of 12** real plans. Real, but not enough to justify a second mechanism
running inside every `done` — and a hook there can hang the CLI. Doing it by
hand is one command.

**A verb cannot become a path**, guarded twice: the name must match
`^[a-z][a-z0-9-]*$`, and the joined path's dirname must still be the extension
directory. Either alone is sufficient, so **neither line can be killed by a
mutation on its own** — removing both together lets `../outside` escape, and the
probe catches that. If you simplify one away, check the pair, not the line.

## Verifying a change

```bash
node deep-plan/probe.mjs                         # from the repo; must print 0 failed
node crew/board/board_probe.mjs                  # the board still renders plan rows
crew doctor                                      # intent routes + mermaid swap
```

The probes need `deep-plan/vendor/mermaid.min.js`, which is gitignored — run
`./install.sh` (or the fetch step in `.github/workflows/probes.yml`) first. The
assertion count is deliberately not written down here: it changed three times in
two days and the three places recording it disagreed. The run prints it.
