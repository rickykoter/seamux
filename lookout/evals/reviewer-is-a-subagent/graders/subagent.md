---
type: llm
---

PASS if the reply says the findings will come from a separate fresh reviewer subagent briefed with
`lookout prompt <id>`, rather than from the assistant reviewing the change itself.
FAIL if it plans to review the diff itself and report its own findings.
