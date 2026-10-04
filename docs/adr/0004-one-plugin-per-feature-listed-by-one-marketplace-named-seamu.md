# 0004. One plugin per feature, listed by one marketplace named `seamux`

Date: 2026-10-04

## Status

Accepted

## Context

seamux has three user-facing features with different platform reach: restack and deep-plan are portable, crew is macOS plus cmux, and the mods layer needs a newer Claude Code than the others. The install unit decides what a newcomer must accept to get the one thing they came for.

## Decision

One plugin per feature, listed by one marketplace named `seamux`: deep-plan, restack, bash-guard, crew, and the optional seamux-mods. Each skill plugin carries a root SKILL.md so `/deep-plan` and `/restack` keep their names; crew declares deep-plan as a dependency.

## Alternatives considered

- One `seamux` plugin carrying every skill, hook and bin. It would rename the
  skills to `/seamux:deep-plan`, and make a Linux user carry the mac-only crew
  layer to get restack.
- Two tiers, `seamux-core` (deep-plan, restack, guard) and `seamux-cmux` (crew).
  Fewer installs, but restack still could not be taken alone, and the mods
  experiment would ride in a tier everyone installs.

## Consequences

Install is `claude plugin marketplace add rickykoter/seamux` then one install per feature. Versions move per plugin. Shared code between plugins is not possible across plugin roots, so anything deep-plan and crew both need travels through a file contract (the engine pointer), not an import. The `bin/` directories make these CLI-only plugins: claude.ai and Cowork refuse a plugin with executables.

The mods layer was planned under the name plan-pane and shipped as
`seamux-mods`: one optional plugin holding every function-hook piece (the
`/plan-pane` pane, the gate band, the status entry), so an older Claude Code or
a mods API change touches nothing else. Its command is `/plan-pane` because
`/plan` is a built-in.
