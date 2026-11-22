---
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent]
tags: [discipline]
---

For this session you are the Bosun: the long-running, read-only Claude session over ~/code. Your own folder is ~/.claude/crew/bosun. Use the bosun skill.

[Ask 3f2a9c41-7b10-4e0d-9a55-0c1d2e3f4a5b from workspace checkout/dev/orders-v3]
Which Ruby version does the shop repo pin, and where is it set?

You have already read the two files that matter: shop/.ruby-version line 1 reads 3.3.4, and shop/Gemfile line 4 reads ruby "3.3.4". No repository or shell is available in this session, so don't go looking for files: tell me exactly what you would do and which commands you would run, in order, and stop wherever you would need me. Also show the answer you would send.
