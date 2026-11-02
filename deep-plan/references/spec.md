# Spec shape

The full shape of the spec JSON (discipline step 5); `examples/example.spec.json` in the plugin root is a worked one.

## Contents

- [Overview diagrams](#overview-diagrams)
- [Auto-go](#auto-go)
- [Parent plans](#parent-plans)
- [Shared state](#shared-state)
- [The simpler approach](#the-simpler-approach)
- [Lessons](#lessons)
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
                      "waiver": "external-scope escape hatch: why no ADR",
                      "at": ["optional: repo-relative paths where it lives, for the map"] }],
  "verifiedFacts": [{ "claim": "...", "evidence": "path:line" }],
  "risks":         ["uncited claims live here, not in verifiedFacts",
                    { "risk": "…", "disposition": "accept|mitigate|spike|promote",
                      "deliverableRef": "mitigate: a deliverable title", "ticketRef": "mitigate: or a filed ticket",
                      "note": "spike: the check that settles it; ticket: its context" }],
  "diagrams":      [{ "question": "the heading, phrased as a question", "mermaid": "...",
                      "simple": "optional: the same idea in plain words, the page opens on it" }],
  "deliverables":  [{ "title": "...", "body": "...", "files": ["relative/path", { "path": "relative/path", "change": "remove" }],
                      "checks": [{ "kind": "test|e2e|observability|manual|review|browser|ci", "name": "...",
                        "id": "optional; derived from kind + name",
                        "recipe": "a recipe id (or id@project) from .seamux/verify.json",
                        "run": "a command shown, not run (no recipe)",
                        "system": "datadog|splunk|...", "query": "...", "expect": "what proves it",
                        "note": "optional", "timeout": "ci only: seconds to wait (1800)" }],
                      "waiver": "only when nothing can prove it: why",
                      "go": { "human": "auto plans only: why a person gives this increment's go" },
                      "commits": ["sha subject", { "sha": "...", "subject": "..." }] }],
  "review":        { "increments": [1, 3], "delivery": true,
                     "agentMayClose": false, "quiz": false,
                     "family": false },
  "go":            "optional: \"human\" (the default), \"auto\", or { \"mode\": \"auto\", \"between\": \"commit|draft-pr\" }",
  "share":         "optional: true, or { \"remote\": \"origin\", \"prefix\": \"seamux-state/\", \"sync\": \"transitions|manual\" }",
  "nonGoals":      ["what this plan deliberately does not do"],
  "simpler":       { "alternative": "the simplest approach considered", "whyNot": "why the plan does not take it" },
  "retry":         { "max": 3 },
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

## Auto-go

`go` says who gives each increment's go after the first. `"human"`, or left
out, is the usual: a person gives every one. With `"auto"`, a `done` whose
checks all passed authorizes the next pending increment in the same write,
logged and shown as `by: auto`, and prints what to do before starting it.
`between` is that step: `"commit"` (the default; the increment is committed
before `done`) or `"draft-pr"` (also push the branch and open or update a
draft PR).

The first go, after the alignment check, is always a person's. The chain
stops, and `done` says why, at an increment with `go: { "human": "<why>" }`,
after a `done --force` (a skipped proof), while another increment is open
or blocked,
and on a family child whose go is its parent's, held, or waiting. Render
refuses an auto plan where a reviewed increment is followed by one that
auto-goes unless `review.agentMayClose` is true, since otherwise the chain
waits on a person closing findings that nobody asked them to close. A
`go.human` on increment 1 or on a plan that is not auto is refused too.

`retry.max` (default 3) is how many failed runs in a row of one
recipe-backed check block its increment for a re-plan. The chain stops at
the block like any other, and a person's go starts the count again
(loops.md, "Fix until green, then stop").

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

## The simpler approach

`simpler` names the simplest approach the plan considered and why it does
not take it. It is advisory: render warns when it is missing and refuses
only a malformed one. The md and both pages show it after the non-goals.

## Lessons

A repo's lessons live in its committed `.seamux/lessons.md`, one rule per
`## L<n>` section with an `applies:` line of path globs and a `from:` line
naming the plans it came from. Only `deep-plan retro` writes it, and it holds
at most 30 rules. A session hears the file at start.

Render reads it against the spec. A lesson whose globs match a file a
deliverable names, while no decision or risk cites its id, is a warning.
Cite it where the plan says how it heeds the rule, as in "L3: the module
was read first". A file over 30 rules is refused until a retro retires or
merges some.

During a plan, misses become candidates in the plan's state: `deep-plan
lesson "<text>"` after a correction from the human, and the engine's own
at a failed grade, a `done --force`, and a review held by a blocker or
major. `deep-plan retro <slug>` lists them; `keep <cid> "<rule>" --applies
<globs>`, `merge <cid> L<n> ["<rule>"]` and `drop <cid> "<why>"` settle each,
and `retire L<n> "<why>"` removes a rule. `close` and an ending `deliver`
refuse while a candidate is unsettled; `--force` is the human's.

## Advisory and derived fields

The top-level `observability` block is optional and **advisory** — the
renderer shows it but never refuses a spec for lacking it. See the
observability discipline below for when it is expected.

A `files` entry is a path, or `{ "path", "change": "remove" }` for a file the
increment deletes (a removed file is still read and cited). Render archives
every entry as `{ path, change }`, with `change` null unless you declared it;
whether a path is new or modified is inferred at render and kept in plan
state, never written into the spec. Your own spec file is left as you wrote
it. `contracts[].at` places a contract on the End state map: each path must
be one a deliverable lists or a fact cites, or render refuses it.

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
