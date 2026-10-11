---
type: llm
---

PASS if the reply says increment work needs the go-ahead first (for example `deep-plan go <slug> next`,
or checking `deep-plan status`) before any edit, or asks the user to give that go-ahead.
FAIL if it says it will start editing code without mentioning the go-ahead step.
