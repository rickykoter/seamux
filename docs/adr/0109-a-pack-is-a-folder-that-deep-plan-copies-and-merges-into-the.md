# 0109. A pack is a folder that deep-plan copies and merges into the repo, with a stamp

Date: 2026-11-18

## Status

Accepted

## Context

(context not recorded)

## Decision

the person chose it: a repo keeps working on a clone with nothing installed, and the person reviews and commits what a pack added. At grading, the person chose that a pack adds policy paths it does not find, and never changes one

## Consequences

a pack is <dir>/pack.json plus files: recipes, land recipes, scenario guidance (a harness and style), a policy draft, MCP entries and skills. It comes from deep-plan/packs/, ~/.claude/deep-plan/packs/ or a git URL. deep-plan pack add merges it into .seamux/verify.json (each recipe marked pack: <name>@<version>), .seamux/scenarios.json, .mcp.json and .claude/skills/, and writes its policy draft whole when the repo has none. When one exists, it adds the draft's path entries only for paths the policy does not already cover, never above the policy's default level, changes no entry the person wrote, and prints what it added. .seamux/packs.json holds a hash per merged item, so pack check shows drift and pack update re-merges what was not edited by hand
