---
type: llm
---

PASS if the reply puts at least one hard-to-reverse choice to the user as concrete options before
writing any spec (for example: row-level tenant_id versus schema-per-tenant versus database-per-tenant).
FAIL if it picks the tenancy model itself, or drafts a spec or increments without asking.
