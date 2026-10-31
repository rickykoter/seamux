# 0044. Notes live beside each plan's state, in deep-plan

Date: 2026-10-30

## Status

Accepted

## Context

deep-plan's remote features (state branches, families, export and import) have no place for side findings. A bug or idea found in the middle of an increment, but outside its plan, is written into the spec or lost. A handoff proposed an optional logbook plugin that copied plans into Beads, a Go CLI on a Dolt database, and filed notes there. Beads is not installed on this machine and no repo uses it. Asked whether the appeal was Beads or the memory, the human chose the memory with no new dependency, and then placed it inside deep-plan rather than in a plugin of its own.

## Decision

Notes are a deep-plan feature stored beside each plan's state, not a Beads mirror in a separate plugin. A note belongs to the plan and increment it was found in and is readable from any plan in the same repo. It is kept in `<data root>/deep-plan/state/<slug>.notes.jsonl`, an append-only file of open lines `{id, at, by, plan, inc, text}` and close lines `{id, at, by, closed, into?}`. Ids are random hex, so two machines that note at once do not collide. The file follows the plan's `share` setting, with no switch of its own.

A note is open until `deep-plan note close <id> "why"` appends a close line, optionally `--into` a live plan. `close` and a `deliver` that ends the plan both archive its branch, and both refuse while the plan has open notes. An archived branch becomes a tag that new sandboxes never pull.

## Alternatives considered

- A logbook plugin that mirrors plans and notes into Beads through `bd --json`
  (the handoff's shape).
- A logbook plugin with its own copy of the git state-branch code, as lookout
  twins `install.mjs`.
- A logbook plugin that hands its file to a new `deep-plan state attach` verb.
- For the archive rule: move open notes at close to one repo-level notes branch
  every session pulls, or leave a closed plan's notes local, unseen by a new
  sandbox.

## Consequences

deep-plan gains the `note`, `note close` and `notes` verbs and a `<slug>.notes.jsonl` file under its state folder. Notes sync, merge and export with the plan and need nothing outside node and git. Beads interop, and `bd ready` showing deep-plan work to other tools, is out of scope; a later plan can add it as a backend behind the same CLI. ADR 0004's one-plugin-per-feature rule is unchanged: notes belong to a plan, so they are part of deep-plan's feature.

`close` and an ending `deliver` list the plan's open notes and refuse until each is closed or moved into a live plan with `note close --into`. The rule applies to every plan, shared or not, so it reads the same everywhere. `--force` stays the human's. A closed plan's notes file keeps its history and is still listed by `deep-plan notes --all` on the machine that has it.
