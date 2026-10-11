# Observability-aware planning (opt-in per project)

A project opts in with `.seamux/observability.json` at the plan root (falling
back to the `observability` entry in `~/.config/cmux/crew/integrations.json`),
naming its stack (`datadog`, `splunk`, …) and how to read it (env-var names
for keys — never key values). On an opted-in project:

1. **Sweep before drafting, read-only.** Query the monitors, dashboards and
   runbooks relevant to what the change touches — the stack's API/CLI when
   credentials answer, in-repo runbooks and alert configs always. What exists
   goes in `observability.existing` (and load-bearing items into
   `verifiedFacts` with real refs); what the change needs but found missing
   goes in `gaps`.
2. **Signals the change must move become observability checks** on the
   deliverable that moves them (`checks` entries with `kind:
   "observability"`, `system`, `query`, `expect`), recorded by hand with
   `check pass|fail` once seen.
3. **Gaps become deliverables**, gated like any other work: new
   instrumentation in the code, and for monitors/dashboards an **importable
   JSON definition (labeled with the API version it targets) or step-by-step
   manual setup** — never a live API write from the plan. The human imports
   or clicks; the plan only produces reviewable artifacts.
4. Not opted in, or the sweep cannot answer? Plan as always — the block is
   simply absent. Never guess monitor state you could not read.
