---
type: llm
---

PASS if it runs `seamux bosun ask` with a question that stands alone (it names the payments repo and the ORDERS_V1 flag), in the background or with a short timeout, and says that on exit 3 it waits again with `seamux bosun ask --id <id>`.
FAIL if it answers the question itself by searching other repos, runs ask in the foreground with no plan for an answer that takes longer than the call, or says a timeout loses the answer.
