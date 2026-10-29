# Spec shape

The full shape of the spec JSON (discipline step 5); `examples/example.spec.json` in the plugin root is a worked one.

## Contents

- [Overview diagrams](#overview-diagrams)
- [Parent plans](#parent-plans)
- [Shared state](#shared-state)
- [Advisory and derived fields](#advisory-and-derived-fields)
- [How evidence is checked](#how-evidence-is-checked)

```json
{ "slug": "kebab-case", "title": "imperative",
  "context": "why now, what exists, what is out of frame",
  "decisions":     [{ "decision": "...", "why": "...",
                      "adr": { "consequences": "required when flagged",
                               "context": "optional; defaults to why",
                               "alternatives": ["optional"], "status": "optional" } }],
  "contracts":     [{ "surface": "table/endpoint/signature", "kind": "db-schema|api|method-signature|event|config",
                      "scope": "internal|external", "change": "new|modify|remove",
                      "reach": "who consumes it (scouted)", "decisionRef": "the owning decision",
                      "waiver": "external-scope escape hatch: why no ADR" }],
  "verifiedFacts": [{ "claim": "...", "evidence": "path:line" }],
  "risks":         ["uncited claims live here, not in verifiedFacts",
                    { "risk": "…", "disposition": "accept|mitigate|spike|promote",
                      "deliverableRef": "mitigate: a deliverable title", "ticketRef": "mitigate: or a filed ticket",
                      "note": "spike: the check that settles it; ticket: its context" }],
  "diagrams":      [{ "question": "the heading, phrased as a question", "mermaid": "...",
                      "simple": "optional: the same idea in plain words, the page opens on it" }],
  "deliverables":  [{ "title": "...", "body": "...", "files": ["relative/paths"],
                      "checks": [{ "kind": "test|e2e|observability|manual|review|browser", "name": "...",
                        "id": "optional; derived from kind + name",
                        "recipe": "a recipe id (or id@project) from .seamux/verify.json",
                        "run": "a command shown, not run (no recipe)",
                        "system": "datadog|splunk|...", "query": "...", "expect": "what proves it",
                        "note": "optional" }],
                      "waiver": "only when nothing can prove it: why",
                      "commits": ["sha subject", { "sha": "...", "subject": "..." }] }],
  "review":        { "increments": [1, 3], "delivery": true,
                     "agentMayClose": false, "quiz": false,
                     "family": false },
  "share":         "optional: true, or { \"remote\": \"origin\", \"prefix\": \"seamux-state/\", \"sync\": \"transitions|manual\" }",
  "nonGoals":      ["what this plan deliberately does not do"],
  "verification":  ["runnable commands"],
  "commits":       ["plan-wide record of what landed (same two shapes)"],
  "quiz":          [{ "id": "q1", "prompt": "...", "options": ["..."], "answer": 0,
                      "why": "...", "decisionRef": "the decision to reopen" }],
  "observability": { "existing": [{ "kind": "monitor|dashboard|runbook",
                                    "name": "...", "ref": "url or path" }],
                     "gaps": ["what this change needs that does not exist"] } }
```

## Overview diagrams

`simple` is a second mermaid source for the same question, drawn for someone
who has not read the code: four to six boxes, plain words, no file, function
or table names. The review and working pages show it first, with the
detailed diagram one tab away, and it is parsed like any other diagram. It
does not count toward the diagram floor.

## Parent plans

A parent plan (see Families) adds one block, and a child plan adds nothing:

```json
  "workstreams":   [{ "slug": "an existing plan", "repo": "optional: path or name under ~/code",
                      "owns": ["glob", { "repo": "other-repo", "glob": "..." }],
                      "shared": ["globs no one owns: lockfiles, CHANGELOG"],
                      "contracts": ["surfaces from this spec it owns"], "consumes": ["... it uses"],
                      "after": [1], "go": "parent" }]
```

`go: "parent"` delegates that child's go to the parent agent; leave it out
and the child's go is a person's, as for any plan (see Families).

`review.family: true` (a parent with `review.delivery: true` only) makes the
parent's delivery one lookout review per member; see checks.md.

## Shared state

`share` says whether the plan's state syncs to its own git branch, where
other sessions pull it. It is false when left out, and a family child
follows its parent's. Render refuses any other shape. What it does and the
`SEAMUX_STATE_*` overrides are in sharing.md.

## Advisory and derived fields

The top-level `observability` block is optional and **advisory** — the
renderer shows it but never refuses a spec for lacking it. See the
observability discipline below for when it is expected.

`quiz.answer` indexes options **as written**; rendering shuffles per-slug and the
key stores the shuffled letter — the two cannot drift.

## How evidence is checked

Render checks every `verifiedFacts` citation back, warn-only (the plugin's `lib/evidence.mjs`):
a cited path that is missing or a line past the end of its file always warns,
and with a TypeSafe key on the machine one
batched request also judges whether the cited lines support each claim — a
warning when real probability mass sits off `supports`, silence otherwise.
It reads the distribution rather than the answer's `confidence` field, which
some models report as the margin between their top two options: a verdict
torn between `contradicts` and `says_nothing` has almost no margin and
almost all of its mass against the claim. What
leaves the machine per fact is the claim sentence plus the cited lines ±3;
warnings never refuse a render and the edit gate never hears of them. No
key, no client, or any error: only the deterministic half runs.
