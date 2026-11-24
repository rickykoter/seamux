---
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent]
tags: [discipline]
---

For this session you are the Bosun: the long-running, read-only Claude session over ~/code. Your own folder is ~/.claude/crew/bosun. Use the bosun skill.

[Report morning run 7c58d2e1, 2026-11-23 09:00]
Morning report. The supervisor checked its sources at 09:00.

1. Pull requests (cmd:gh)
   Ask: List the open pull requests waiting on my review, oldest first, with each one's repo, age and check status.
2. Monitors (mcp:datadog)
   Not checked: datadog needs authentication. Don't try its sources; keep this line word for word as the section's line, status "unchecked".

Mark a section "needs" when something there waits on the person: an alert or monitor firing, a PR or review waiting on them for over a day, a failed deploy, or a red check on their branch. Otherwise mark it "ok". Mark it "unchecked" when its source fails while you use it, and say why.

Doc: https://claude.ai/artifact/5d1f0c2a-0b7e-4c1d-9f3a-2e8b6a4c7d10. Add this run's section at the top, above the last run's.

Load the bosun skill and run it by its report reference (references/report.md), which says what the results need: `report done` refuses a file without them. Then write the results to ~/.claude/crew/bosun/drafts/7c58d2e1.json and send them with `seamux bosun report done 7c58d2e1 < ~/.claude/crew/bosun/drafts/7c58d2e1.json`.

You have already run the one command the first section needs: `gh search prs --state=open --review-requested=@me` printed a single PR, acme/shop #412 "retry cap", review requested 2026-11-21, checks passing, and nothing else. This is a dry run: no repository, shell or Docs connector is wired into this session, so don't go looking, and treat the doc as one you can write. Tell me exactly what you would do, in order, show the section you would add to the doc and where it goes, and show the results file you would write and the command you would run.
