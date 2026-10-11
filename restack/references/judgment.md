# The judgment layer (optional, local, escalation-only)

Read this when a line says the judgment layer sent a file to you, or when tuning `judge.safeFloor`.

When a TypeSafe-compatible client is on the machine — on this laptop that is a
local Kev — restack asks it three narrow questions. The rule, enforced in
`lib/judge.mjs` rather than trusted to callers:

> **A judgment may escalate, never authorize.**

There is no answer that makes restack resolve something it would not have
resolved, clear a stale mark, or let a push through. The worst a wrong answer
can do is cost you a look.

1. **The glob guard.** Before auto-resolving a conflicted file because an
   artifact glob claimed it, it asks whether the file reads as generated. A
   `protobuf/**` that quietly covers a hand-written helper is invisible to
   every deterministic check — the glob is narrow, the config is valid, the
   file just is not generated — and it is how a branch loses a change silently.
   The question carries the artifact's regen command and the top of the file
   as the base has it (no conflict markers).
   A file that does not clear the bar goes to the human pile with its conflict
   markers intact.
2. **Dropped-commit triage.** A commit that became empty is always reported;
   this decides whether it is a line or a stop. `chore: regenerate protos`
   vanishing is housekeeping. `feat: add the phone field` vanishing is a stop.
3. **Residue triage in `verify`.** Ranks leftover patch changes as benign
   (context moved) or semantic (the commit does something different now).

**The bar is asymmetric, and that is the whole design.** It does not ask
"is the model confident in the alarming answer" — it asks "is the model
positively confident this is SAFE", and escalates otherwise. Measured reason:
Kev reports `confidence` as the *margin* between its top two options, so a
file it scored `{generated 0.14, handwritten 0.48, unclear 0.38}` — one it
plainly would not call generated — arrives with confidence 0.21 and sailed
straight through the naive rule. Under the asymmetric bar, uncertainty
escalates. `judge.safeFloor` (default 0.5) is the knob; raise it toward 1 for
a more cautious tool. Every answer is logged to
`~/.cache/seamux-restack/judgments.log` with its probabilities, because these
numbers deserve tuning against real runs rather than trust.

**What leaves the machine.** The content questions carry file heads and patch
excerpts, which is what makes them answerable — and they are sent **only when
the endpoint is loopback**. Point `TYPESAFE_BASE_URL` at anything else and the
questions degrade to paths and commit subjects, plus two things for the glob
guard: the artifact's configured regen command, and the one line near the top
of the file that declares it generated ("DO NOT EDIT", "@generated"), when
there is one. Neither lowers the bar a file has to clear. No client, no key, a server
that is down, an unparsable answer: silence, and restack behaves exactly as it
does with no judgment layer at all. `--no-judge` turns it off explicitly.
