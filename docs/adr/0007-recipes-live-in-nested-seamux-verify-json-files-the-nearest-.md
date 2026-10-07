# 0007. Recipes live in nested .seamux/verify.json files; the nearest ancestor wins

Date: 2026-10-07

## Status

Accepted

## Context

In a monorepo, projects own their verification beside their code, the way they own package.json or go.mod. A deliverable file resolves to its nearest ancestor's file, and root recipes are inherited unless redefined. `match` globs narrow a recipe to a language inside a project.

## Decision

Recipes live in nested .seamux/verify.json files; the nearest ancestor wins

## Consequences

Adopters write `.seamux/verify.json` at the repo root and optionally in any project directory. Recipe ids are inherited from the root and overridden by the nearest file, so a project redefining `unit` replaces the root's `unit` for its files only. Resolution is a true nearest-ancestor walk, not the ADR resolver's segment scoring. Moving a project directory moves its recipes with it. A recipe file is shell commands read from the working tree, so trusting a repo's verify.json is like trusting its Makefile.
