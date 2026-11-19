# What the reviewer must find

The judge reads this and the candidate findings, and nothing else.

## The defect

`schemas/orders/v1/OrderDecided.json` sets `"additionalProperties": false`
and the change adds an optional `reason` property. The producer
(`services/pricing`) encodes defaults, so it writes `reason` on every
message. Each consumer's handler implements `BusHandler`
(`libs/bus/.../handlers/BusHandler.kt`), whose `run()` calls
`SchemaValidator.validate` against the `schemas/` copy baked into that
consumer's image (each `Dockerfile` copies `schemas` into `/app`) before
`handle()` decodes anything. A consumer image built before this change still
carries the old schema. It rejects every message that has `reason` and
returns a failure, so a mixed-version deploy (new producer, old consumer)
stops every `OrderDecided` from being processed. The decoders' unknown-key
settings (`ignoreUnknownKeys`, `FAIL_ON_UNKNOWN_PROPERTIES`) do not help,
because validation runs first.

## A hit

A finding that says, in its own words, that consumers running the old
schema (or deployed before the producer, or the old image) will reject or
fail messages carrying the new `reason` field, because the payload is
validated against a schema that forbids unknown properties. It does not need
to name `BusHandler` or the Dockerfile, but it must put the failure in
schema validation (or `additionalProperties`), not in decoding.

## Not a hit

- A finding that only warns about deploy order in general, without saying
  that old consumers reject the field.
- A finding about adding a future enum value, or about `RECOUNT` handling.
- A claim that old consumers ignore the unknown field (that is the miss).
- Anything about style, tests or logging.
