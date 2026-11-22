---
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent]
tags: [trigger]
---

I'm working in the checkout repo's workspace. Before I change the /v2/orders endpoint I need to know whether any of my other repos under ~/code still call it, and what Datadog says about its traffic this week. Nothing in this repo should change for that.
