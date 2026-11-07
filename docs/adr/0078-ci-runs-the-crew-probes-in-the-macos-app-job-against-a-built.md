# 0078. CI runs the crew probes in the macOS app job against a built seamux-cli

Date: 2026-11-07

## Status

Accepted

## Context

With the crew Python gone, every crew probe needs a built `seamux`. CI's probes job ran on Ubuntu and macOS with no Rust toolchain, so it had tested only the Python. The macOS app job already had the toolchain, a rust-cache and tmux. Whether seamux-cli builds on Ubuntu is unverified, and the person chose not to take that risk.

Considered and rejected: adding a Rust toolchain and `cargo build -p seamux-cli` to the probes job on both OSes.

## Decision

The app job builds seamux-cli after `cargo test` and runs the crew probes that need a real `seamux` (board, typesafe, family sync, cli, hooks, workspaces, artifacts, wake split, core). The probes job keeps the two that use stub seamuxes (crew_impl, install) and every non-crew probe, on both OSes.

## Consequences

The crew probes stop running on Ubuntu. They run once, on macOS, after cargo test, and need tmux there, which the job already installs. The probes job keeps deep-plan, restack, lookout and the other non-crew probes on both OSes.
