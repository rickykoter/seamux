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
