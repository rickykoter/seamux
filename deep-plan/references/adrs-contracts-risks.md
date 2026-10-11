# ADRs, contracts and risks

Read this when a decision is flagged `adr`, when the plan touches a contract surface, and when writing or dispositioning risks.

## Contents

- [ADRs — decisions that outlive the plan](#adrs--decisions-that-outlive-the-plan)
- [Contracts — enforced, and the human is party to every one](#contracts--enforced-and-the-human-is-party-to-every-one)
- [Risks — dispositioned at review, and the review cannot pass around one](#risks--dispositioned-at-review-and-the-review-cannot-pass-around-one)

### ADRs — decisions that outlive the plan

A decision flagged `adr` becomes an Architecture Decision Record bound for the
repo itself (`NNNN-slug.md`), not just the plan surfaces. The discipline:

1. **Flagging is explicit and shared.** Only the human and agent together, at
   interrogation time, decide a fork is architectural. Flagged entries must
   carry `consequences` — the renderer refuses otherwise.
2. **The destination is reviewed, not assumed.** `render` resolves each ADR's
   home — explicit `.seamux/adr.json` `dir` first, else the existing ADR tree
   nearest the deliverables' files (multi-project repos keep per-project trees
   like `docs/adr/payments-service/`), else `docs/adr` — preseeds the next
   number, and shows `destination (source)` on every surface. A wrong home is
   review feedback like any other.
3. **Drafts at render, repo write at apply.** Drafts live beside the surfaces
   (`<slug>.adrN.md`, status Proposed, date pending). `deep-plan adr apply
   <slug>` is the only repo write — refused while phase is `review`, Accepted
   + dated on the way in, loudly reallocating a number that went stale, and
   idempotent on re-apply.
4. **Style is the adopter's.** `.seamux/adr.json`: `template` is `nygard`
   (default), `madr`, or a repo-relative path to their own template
   (`{{title}} {{status}} {{date}} {{context}} {{decision}} {{consequences}}
   {{alternatives}}`, plus `{{n}} {{nn}} {{nnn}} {{nnnn}}` for the number at
   the width the house style uses, or `{{number}}` for 4-padded); unknown
   names are treated as paths so a typo fails loudly instead of silently
   restyle-ing. **The file convention is theirs too:** `filePattern`
   (default `{nnnn}-{kebab}.md`; `{n}/{nn}/{nnn}/{nnnn}` set the width,
   `{kebab}`/`{snake}` the separator) and `numberScan` — the regex, with one
   capture group, that finds the number in existing filenames (default
   `^(\d{4})-.+\.md$`). Getting `numberScan` wrong is not cosmetic: a scan
   that matches none of the existing files makes the next number 1 and writes
   a second ADR 1 beside the real one, so `render` and `adr apply` both warn
   when a folder holds `.md` files the scan cannot read.
5. **ADRs are edited in the page, applied through the spec.** Every ADR card
   on the review and working surfaces has an **Edit** toggle: all fields
   (decision, context, consequences, alternatives) with a live preview in a
   markdown subset (`# ## ###`, bold, italic, code, fences, lists, http links
   — a small inlined renderer, no library; the display upgrade is client-side
   so surfaces on disk stay byte-identical). Saves are STAGED, not written:
   they ride the copy-back blob as one line per changed field,
   `- [adr N · field] <payload>` with real newlines escaped as `\n`
   (unescape before applying — the payload is markdown). Un-flagged decisions
   carry an **add an ADR** button that stages
   `- [decision: <name>] promote to ADR` — seed the `adr` block from the
   decision's why, then re-render; the new card is editable like any other.
6. **In-flight edits ride the amend channel.** The working surface carries
   amend boxes (per ADR card, per plan section); its **Copy amendments** blob
   (`deep-plan amend — <slug>`) is pasted into the session, applied as a spec
   edit, and re-rendered — increment statuses survive.

### Contracts — enforced, and the human is party to every one

Getting contracts and abstractions right is the point of planning slowly.
Unlike the top-level `observability` block, the `contracts` block is **enforced**: declare every
schema, API, method-signature, event, or config surface the plan creates or
changes shape on.

1. **Interrogation-time sign-off.** Every contract fork reaches the human as
   an `AskUserQuestion` during interrogation — before the spec exists. The
   entry's `decisionRef` must name the decision that came out of it; the
   renderer refuses a contract owned by no decision.
2. **Reach is scouted, never assumed.** The `reach` field records who
   consumes the surface, written from the scouting fan-out (step 3).
3. **External defaults toward ADR.** A contract crossing a service boundary
   outlives the plan: the renderer refuses an external-scope entry unless the
   owning decision is `adr`-flagged or the entry carries a written `waiver` —
   silence is not a decision.
4. **Coverage is checked at grading.** `deep-plan grade` fails structurally,
   before reading any answers, if a contract decision has no quiz question
   whose `decisionRef` matches — the review cannot pass around a contract
   change. Render stays permissive so authoring is not blocked.

### Risks — dispositioned at review, and the review cannot pass around one

A risk is an uncited claim; the review's job is to decide what to do about
each, not to score it. Every risk therefore carries a **disposition**, and
`deep-plan grade` refuses structurally — before reading any answer — while
any risk has none (`key.undispositionedRisks`, same shape as uncovered
contracts). A plain string is an undispositioned risk.

1. **Four dispositions, each with a payload the renderer checks.** `accept`
   (nothing more); `mitigate` with `deliverableRef` naming a deliverable
   title in this plan, **or** `ticketRef` (URL or key) plus a `note` — a
   backlog item filed with context is a real commitment too; `spike` with a
   `note` saying what check settles it; `promote`, matched by a quiz question
   whose `riskRef` is the risk's text. A disposition that is set but broken
   refuses at render.
2. **The human picks on the page.** On the review and working surfaces each
   risk is a card: radios for the disposition, a deliverable select and a
   ticket box shown while mitigate is picked, and a note. Nothing is written
   by the page: a changed card stages `- [risk N] <disposition>: <payload>`
   into the copy-back blob (N is 1-based, in spec order; the payload is the
   deliverable title, `ticket <ref> — <note>`, or the note). Apply it as a
   spec edit — set `disposition` and the matching field on entry N — and
   re-render. `promote` means you also write the quiz question with `riskRef`.
3. **Old plans are not grandfathered.** Re-rendering a spec written before
   dispositions existed refuses at grade until each risk has one; that is
   the floor doing its job, not a bug.
