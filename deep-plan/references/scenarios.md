# Scenarios: acceptance checks the building session never reads

## Contents

- [What a scenario is](#what-a-scenario-is)
- [Writing them](#writing-them)
- [What the building session sees](#what-the-building-session-sees)
- [The judge](#the-judge)
- [The harness](#the-harness)
- [The person's page](#the-persons-page)
- [When a scenarios check fails](#when-a-scenarios-check-fails)

## What a scenario is

A scenario is a story a user or caller lives through: steps taken from the
outside (a command, a page, a request) and what a person would accept as
working. A plan's scenarios are drafted by a separate writer from the
approved plan, kept in a sealed folder outside the repo
(`~/.claude/deep-plan/sealed/<slug>/`, mode 0600), and scored by a judge
that runs the change. The building agent never reads them, so they test
what the plan promised, not what the agent chose to build.

A deliverable asks for them with a check of kind `scenarios`:

```json
{ "kind": "scenarios", "threshold": 0.8 }
```

It names no recipe or command, one per deliverable. `threshold` (0 to 1) is
the score every scenario must meet; left out, it is the repo's
`.seamux/scenarios.json` `threshold`, else 0.8. A repo policy may require
one (`scenarios.require` in `.seamux/policy.json`), and render refuses a
plan that ship would act on alone without it.

## Writing them

Once the grade passes, run:

```
deep-plan scenarios write <slug>
```

It starts a fresh headless model with no tools, no settings and no
`CLAUDECODE`, given only the approved snapshot and the repo's harness and
style, each fenced as data. It prints how many it sealed and their titles.
It spends real tokens. `--model` picks the writer (default opus, or the
repo's `writer`). Run it again only with `--force`; once the person has
edited them, writing them again is theirs.

## What the building session sees

`deep-plan scenarios list <slug>` gives the count, the titles and the last
scores. That is all. The gate refuses a Read, Grep, Glob or Bash that names
the sealed folder, in any spelling it can see, and writes each attempt to
the plan's access log; `scenarios access <slug>` lists them, and a verdict
says how many there were. `scenarios show` and `scenarios edit` are the
person's, refused from a session.

Do not try to read the scenarios by any route: a subagent, another
session, an MCP file server or a spelling the gate misses all defeat the
check, and the access log is how a person finds out.

## The judge

`deep-plan check run <slug> <n>` runs the judge for a scenarios check. It
is expensive, so it runs detached; `check wait` follows it. It:

1. makes a throwaway worktree at HEAD, so commit first: uncommitted work is
   not judged;
2. points HOME, XDG_CACHE_HOME and CREW_DURABLE_DIR at a temp folder for
   everything the change runs, and drops deep-plan's store overrides. The
   bin folder of the node running deep-plan goes first on PATH, so a
   version manager's shims (asdf, nodenv), which find their version through
   the home folder, do not break `node`, `npm` and `npx` there;
3. starts the repo's harness, if it has one;
4. runs a different model (default sonnet, or the repo's `judge`) headless
   with Bash, Read, Grep and Glob only, from an empty folder beside the
   checkout, with no settings loaded; its shell cannot push, run gh or
   change remotes;
5. scores each scenario from 0 to 1, and passes when every one meets the
   threshold.

What the check prints is all the building session gets: each scenario's
title and score, and a hint under a failing one only when the person
allowed that hint. The judge's reasons and transcript stay sealed.
`deep-plan scenarios judge <slug>` runs the same judging outside a check.

Exit 3 is no verdict: no scenarios yet, a bad harness file, or a judge that
did not answer. It fails the check without counting toward the retry cap.

## The harness

`.seamux/scenarios.json` says how to run the change for the judge, and how
the writer should write. Every field is optional:

```json
{ "harness": { "setup": "npm ci", "start": "npm run dev -- --port $PORT",
    "ready": "curl -fsS -o /dev/null http://127.0.0.1:$PORT/",
    "export": { "BASE_URL": "http://127.0.0.1:$PORT" }, "timeout": 180 },
  "style": "Write each scenario as a visit to $BASE_URL ...",
  "writer": "opus", "judge": "sonnet", "threshold": 0.8 }
```

`setup` runs to completion, `start` runs for the whole judging and is
stopped after, `ready` is polled until it exits 0. `$PORT` is a free port.
Each export reaches the judge's prompt and its shell. A harness that never
gets ready fails every scenario, which is a verdict: the change does not
start. A pack can write this file (`deep-plan pack add`).

## The person's page

`deep-plan scenarios show <slug>`, run by the person in their own shell,
opens the scenarios page: each scenario's steps, what to accept, the hint
and whether the builder may see it, the last scores with the judge's
reasons, and the access log. They edit and save there, or in an editor with
`scenarios edit`. The page is served behind a key kept in the sealed
folder, not serve's token, and its address is printed only to a terminal.

## When a scenarios check fails

Read the titles and scores, and any hint, then fix the behavior the title
names. Do not ask for the scenario text, and do not weaken the plan's
promise to get a pass. A failure counts toward the retry cap like any
recipe; after three in a row the increment blocks, and you stop and
re-plan. A scenario that seems wrong is the person's to edit: say which
title, and why.
