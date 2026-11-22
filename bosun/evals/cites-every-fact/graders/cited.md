---
type: llm
---

PASS if all of these hold: the answer it would send cites each fact to its file and line (shop/.ruby-version:1, shop/Gemfile:4, or both); it sends that answer with `seamux bosun answer 3f2a9c41-7b10-4e0d-9a55-0c1d2e3f4a5b` using that exact id; and it logs the answer with `seamux bosun log add`, with at least one source of kind file.
FAIL if a fact in the answer has no source, if it uses another id, if it skips sending or logging, or if it feeds the JSON entry through a heredoc or echo instead of a file.
