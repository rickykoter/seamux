# Config — `.seamux/restack.json`

Read this when setting up or changing a repo's restack config, or when `restack doctor` flags it.

Per repo, committed, because "this repo checks in a generated client" is a
property of the repo. `restack init` writes a starting point by detecting the
usual suspects; **every detected entry lands with an empty regen command on
purpose** — a command nobody has run is worse than none.

```json
{
  "base": "origin/master",
  "remote": "origin",
  "artifacts": [
    { "name": "graphql-schema",
      "paths": ["app/graphql/schema.graphql", "app/graphql/schema.json"],
      "resolve": "regen", "tier": "expensive",
      "regen": "docker compose run --rm app bundle exec rake graphql:dump",
      "breaks": "CI regenerates this and asserts no diff" },
    { "name": "grpc-clients",
      "paths": ["protobuf/**/*_pb.rb"],
      "resolve": "regen", "tier": "cheap",
      "regen": "cd protobuf && buf generate" },
    { "name": "db-schema",
      "paths": ["**/db/schema.rb"],
      "resolve": "take-base", "tier": "expensive",
      "note": "take the base copy; re-running your own migration re-adds your lines" }
  ],
  "checks": [
    { "name": "proto-breaking", "tier": "cheap",
      "run": "cd protobuf && buf breaking --against '../.git#branch=origin/master,subdir=protobuf'" },
    { "name": "graphql-breaking", "tier": "expensive",
      "run": "git show origin/master:app/graphql/schema.graphql > /tmp/base.graphql && schema_comparator verify /tmp/base.graphql app/graphql/schema.graphql" }
  ]
}
```

- **`resolve`** — `regen` (take the base copy, re-derive), `take-base`,
  `take-branch`, `union` (both sides' lines; only ever right for a file that is
  a set), `manual` (always a human's).
- **`tier`** — `cheap` runs inside the walk, `expensive` runs only under
  `--deep` and is otherwise recorded stale.
- **`checks`** — whatever CI runs that a laptop can run. `needsBase: true`
  (the default) is documentation for the reader; the base is fetched either way.

Setting this up for a repo for the first time is its own job, and the best
moment is right after a rebase that hurt — `examples/setup-prompt.md` is the
prompt for it, built around the conflicts that session just resolved.

`regen` and `check.run` are shell, read out of the working tree — running the
tool in a repo trusts that repo's config the way you trust its Makefile.
`--dry-run` prints every command without running it; `restack doctor` lists
them, and flags globs that match no tracked file.
