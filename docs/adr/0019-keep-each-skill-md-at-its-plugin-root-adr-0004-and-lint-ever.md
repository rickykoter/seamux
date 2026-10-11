# 0019. Keep each SKILL.md at its plugin root (ADR 0004) and lint every SKILL.md with tools/skill_lint.py: per-skill default recipes during the refactor, then one repo-wide default recipe and a CI step once all three pass

Date: 2026-10-11

## Status

Accepted

## Context

Each seamux skill plugin carries a root SKILL.md so the skill keeps its name (ADR 0004). Claude Code supports that location, but `claude plugin validate` checks only skills under a skills/ directory, so frontmatter, length and reference rules on these files are checked by nothing. Anthropic's authoring guidance sets checkable rules: name at most 64 characters of lowercase, digits and hyphens; description at most 1,024 characters, third person, key use case first; body under 500 lines; references one level deep; a contents list atop any reference over 100 lines. Claude Code keeps only the first 5,000 tokens of a skill after compaction.

## Decision

Keep each SKILL.md at its plugin root (ADR 0004) and lint every SKILL.md with tools/skill_lint.py: per-skill default recipes during the refactor, then one repo-wide default recipe and a CI step once all three pass

## Consequences

Every SKILL.md and every file under a plugin's references/ is linted on the increment that touches it and in CI on every push. A skill can no longer regrow past 500 lines or past the compaction keep, or link a reference that links another, without CI saying so. The lint encodes rules as of October 2026; when Anthropic's guidance moves, tools/skill_lint.py is the one place to change. Layout stays as ADR 0004 left it.
