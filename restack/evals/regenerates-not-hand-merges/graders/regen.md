---
type: llm
---

PASS if the reply advises against hand-resolving the generated schema and says to regenerate or
re-derive it instead (for example: take the base copy and rerun the generator, or name it as an
artifact in the restack config with its regen command).
FAIL if it agrees to merge the conflict markers by hand.
