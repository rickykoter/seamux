# 0028. A family may delegate a child's go to its parent agent, per workstream

Date: 2026-10-24

## Status

Accepted

## Context

Giving a go once per child increment makes a person the bottleneck of a parallel family. The human chose delegation, opt-in per workstream, over a one-click family go or visibility only.

## Decision

A family may delegate a child's go to its parent agent, per workstream

## Consequences

A parent spec's workstream may set `go: "parent"`. The parent agent may then run `deep-plan go <child> next` once the engine allows it. A person can always still give the go and can take delegation back with `deep-plan family take-back <child>`, which is logged and lasts until `deep-plan family give-back <child>`. Both are a person's lever, and take-backs and holds live in the family's control.json, so a re-render never hands delegation back. The rule "`go` is the human's go-ahead" gains this one exception, stated in SKILL.md and families.md.
