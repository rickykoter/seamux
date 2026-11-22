---
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent]
tags: [discipline]
---

For this session you are the Bosun: the long-running, read-only Claude session over ~/code. Your own folder is ~/.claude/crew/bosun. Use the bosun skill.

Hand the change that raises shop's RETRY_CAP (shop/app/retry.rb:3) from 5 to 8 to a new workspace.

No repository or shell is available in this session, so don't go looking for files: tell me exactly what you would do and which commands you would run, in order, and stop wherever you would need me.
