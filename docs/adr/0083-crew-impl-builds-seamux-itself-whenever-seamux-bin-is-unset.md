# 0083. crew_impl builds seamux itself whenever SEAMUX_BIN is unset

Date: 2026-11-08

## Status

Accepted

## Context

deep-plan's check run executes an increment's checks one at a time, declared before inferred, with no ordering field between recipes. crew-seamux-build was a separate recipe so the probes stayed cargo-free and tools/probes.py kept them in its quick set. A probe declared in a plan therefore ran before the inferred build, and on a fresh tree it failed. crew_impl also used whatever binary was on disk, built from whichever tree.

## Decision

Every crew probe finds seamux through crew_impl, so one change there covers check run, tools/probes.py, a hand run and CI. Running cargo each time also catches a stale binary, which no ordering in the runner would.

## Consequences

A crew probe runs `cargo build -q -p seamux-cli` once per process unless SEAMUX_BIN is set, and fails with cargo's output when the build fails. Probes need cargo on PATH, as rustup installs it. A no-op build costs about 0.27s, and parallel probes queue on cargo's lock. crew-seamux-build stays as a check of its own. This amends ADR 0077's consequence that every crew probe needs a built seamux: the probe builds it now.
