# Packs: set a repo up for a stack in one step

## Contents

- [What a pack holds](#what-a-pack-holds)
- [Where packs come from](#where-packs-come-from)
- [Adding one](#adding-one)
- [Drift, update and remove](#drift-update-and-remove)
- [The packs deep-plan ships](#the-packs-deep-plan-ships)

## What a pack holds

A pack is a folder with a `pack.json`:

```json
{ "pack": "node-web", "version": "1.0.0", "describes": "…",
  "detect": ["package.json"], "needs": ["node", "npx"],
  "recipes": [ … ], "land": [ … ],
  "scenarios": { "harness": { … }, "style": "…" },
  "policy": { "default": "auto-go", "paths": [ … ] },
  "mcp": { "playwright": { "command": "npx", "args": [ … ] } },
  "skills": ["skills/<name>"] }
```

`recipes` and `land` are verify.json recipes. `scenarios` is a
`.seamux/scenarios.json`. `policy` is a draft `.seamux/policy.json`. `mcp`
maps server names to `.mcp.json` entries. `skills` are folders in the pack
holding a SKILL.md. `detect` names files that suggest the pack fits a repo,
and `needs` the tools it expects on PATH.

## Where packs come from

`deep-plan pack list` names them: deep-plan's own `packs/` folder and
`~/.claude/deep-plan/packs/` (which wins on a name), marking the ones the
repo looks like. `pack show <pack>` prints what one holds and checks it.
`pack add` also takes a folder path or a git URL (`https://…`, `git@…`,
`file://…`, with `#ref` for a branch or tag), cloned to a cache. A pack's
recipes are shell commands the repo then runs, so a pack from a git URL is
someone else's code: read it with `pack show` first.

## Adding one

```
deep-plan pack add <pack|dir|git-url>
```

Each item merges into the repo:

- recipes and land recipes into `.seamux/verify.json`, each marked
  `"pack": "<name>@<version>"`;
- the scenarios harness and style into `.seamux/scenarios.json`, field by
  field;
- MCP servers into `.mcp.json`, by name;
- skills into `.claude/skills/<name>`;
- the policy draft into `.seamux/policy.json`: whole when the repo has
  none. When it has one, the pack adds only entries for paths the policy
  does not cover, at most at its default level, and changes nothing the
  person wrote; it prints what it left.

An item the repo already has, the same, is adopted (a recipe only gains its
mark). One it has differently is kept and named. Edits to verify.json and
policy.json touch only the array elements they change, so a hand-formatted
file keeps its layout. `.seamux/packs.json` records each merged item's hash.

The person reviews and commits what a pack wrote. A clone with no pack
installed works the same: the files are ordinary repo files.

## Drift, update and remove

- `deep-plan pack check [pack]` compares each item with its stamp: `edited`
  (by hand since it was merged), `missing`, `outdated` (the pack has
  changed since), or `new-in-pack`. Exit 1 on any drift.
- `pack update <pack>` re-merges what nobody edited from the pack as it is
  now, adds what is new, takes out what the pack dropped, and names each
  edited item it left.
- `pack remove <pack>` takes out what the pack merged and nobody edited,
  and leaves the rest.

## The packs deep-plan ships

- `seamux`: this repo's own recipes and land recipes, a scenarios harness
  that serves the app's pages in a browser against the demo mock
  (`docs/demo/app`), and a policy for a software factory. App and crew
  code (`app/ui`, `app/crates`, `crew`) and docs merge at auto-merge.
  Dependency manifests and the land watcher stop at auto-pr, as do the
  plugins and tools by default. The factory's own guards (the gate's hooks,
  `policy`, `scenarios`, `judge`, `autogo` and `state` in `deep-plan/lib`,
  bash-guard, CI and the scrub check) are supervised. Scenarios are
  required on the app's pages (`app/ui/**`, at auto-pr and above), which
  the judge clicks through on the demo mock, and not on the backend, which
  it cannot run. It is added in this repo,
  where `pack check` shows no drift; a change to `.seamux/verify.json`
  shows as drift until the pack is updated with it.
- `node-web`: unit tests and a build on every change, Playwright e2e, a
  land recipe that waits for the production deployment GitHub reports for
  the merge, a harness that starts the dev server, a policy draft, and the
  Playwright MCP server.
- `github-actions`: a `ci` recipe (`deep-plan ci wait`, for the PR checks on
  Actions) and a land recipe that waits for the merge's deployment status.

The verify templates (`deep-plan verify init`) stay where they are. The
node-web and github-actions land recipes are built from the
`land-github-deployment` template.
