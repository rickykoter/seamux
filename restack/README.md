# restack: rebase without merging generated files

Part of [seamux](../README.md). Install and setup are in the [main README](../README.md#setup).

A stack that sits for a few days picks up two kinds of conflict. One is your
code against someone else's, which needs a person. The other is a checked-in
generated file (a GraphQL dump, a Rails schema, a generated client) that
conflicts the same way on every branch. Merging that by hand means editing a
program's output, and CI tells you twenty minutes later that it's out of
date.

restack handles the second kind. A per-repo `.seamux/restack.json` lists each
generated file, the command that rebuilds it, and whether rebuilding is cheap
(a code generator) or expensive (a container, a migrated database).

- `restack run` walks the stack from the bottom, resolves each generated-file
  conflict by regenerating it, and **stops only for conflicts a person needs
  to resolve**. It exits with code 2 and lists the files with a hunk count
  for each, instead of dumping git output.
- A file too expensive to rebuild mid-walk is set to the base's copy and
  marked **stale**, along with the command that fixes it. `restack check` and
  `restack push` refuse while anything is stale, so a half-merged schema
  never ships unnoticed.
- `restack check --deep` runs the staleness and breaking-change comparisons
  locally against a freshly fetched base, before you push.
- `restack push` only prints the push commands; a person runs them. A
  restacked stack can only go up with a force push, and seamux's Bash guard
  deliberately blocks those from agents.

```sh
restack plan --json      # what will be restacked, which artifacts will collide
restack run              # the walk; exit 2 means something needs you
restack continue         # after you resolved it
restack check --deep     # the CI comparisons, locally
restack push             # prints; never pushes
```

Here is a two-branch stack after `main` moved. Both sides added GraphQL
types, so the generated `schema.graphql` conflicts, and both changed the tax
rate in `app/billing.rb`. restack regenerates the schema and stops only for
the tax rate:

```text
$ restack plan
plan · git rebase --onto, bottom first · base origin/main (1 behind)
  • feat/invoices — 1 commit(s) onto origin/main
  • feat/invoice-emails — 1 commit(s) onto feat/invoices

  generated artifacts both sides touched (conflicts expected, and handled):
    graphql-schema — resolve regen, cheap

$ restack run
  rebasing feat/invoices onto origin/main

stopped on feat/invoices at 1/1 — invoices: Invoice type, tax from the rate table
  resolved for you (generated):
    graphql-schema — regenerated (1 file)
  yours to resolve:
    app/billing.rb — 1 hunk

  then: restack continue

$ git add app/billing.rb && restack continue
  rebasing feat/invoice-emails onto feat/invoices

  ok   feat/invoices b5481eab7428
  ok   feat/invoice-emails b355d0a6a178

$ restack check
  staleness: graphql-schema …
  ok   graphql-schema

$ restack push
  run these yourself (the stack must go up bottom-first):
    git push --force-with-lease=feat/invoices:9c41e2a07b5d3f86e1a4c0d97b2f5e8a3d6c1b04 origin feat/invoices:feat/invoices
    git push --force-with-lease=feat/invoice-emails:e07d5b3a91c4f2e6d8a0b7c35f19e4a2c6d8b031 origin feat/invoice-emails:feat/invoice-emails
```

Each lease names the remote tip restack recorded when it planned the walk, so
the push fails if someone pushed to that branch since.

If you use Graphite, restack leaves the rebase to `gt restack` and does its
resolving between Graphite's stops. Without Graphite, it finds the chain from
your open PRs or from branch topology.
