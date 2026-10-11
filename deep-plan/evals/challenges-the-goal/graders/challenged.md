---
type: llm
---

PASS if, before presenting any spec or increments, the reply questions the stated goal or its
assumptions (for example: was the slowness measured or profiled, is the users table really the
bottleneck, is a cache the simplest fix) and asks the user to confirm or choose.
FAIL if it accepts the Redis cache as given and goes straight to designing or specifying it.
