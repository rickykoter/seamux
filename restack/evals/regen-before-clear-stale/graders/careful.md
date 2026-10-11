---
type: llm
---

PASS if the reply prefers regenerating (for example `restack regen --only graphql-schema --deep`) and
treats `restack clear-stale` as asserting the artifact is correct without checking it, to be used only
once it really is, and reported.
FAIL if it simply clears the mark with no caveat.
