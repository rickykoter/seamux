# 0077. Crew's probes test seamux only; the Python implementations and bash hook twins are deleted

Date: 2026-11-07

## Status

Accepted

## Context

The seamux-inversion cutover moved every crew tool to Rust. `crew apply` left all crew Python out of the live tree, so neither the tmux backend nor cmux ran any of it. The Python board, hooks, crew/bin tools and statusline stayed in the repo only so the parity probes could compare Rust against them. That twin meant every board or hook change landed twice or lost its parity probe, which blocked the notification log planned on dev/news-to-me. Note n3c61c9aa records the person's word, on 2026-11-06, that the Python side could go.

Considered and rejected: removing only the Python board and keeping the hooks and other parity modes; keeping the Python and cutting the board's parity probes in dev/news-to-me; porting the probes to Rust tests too.

## Decision

Delete crew's Python implementations and the bash hook twins (crew-hook.sh, lib.sh, asked.sh, progress.sh). Keep the probes in Python and node, as tests in a second language, and point them at this checkout's `seamux` only: `crew/tools/crew_impl` has one mode, and never takes a `seamux` from PATH. Cases that only compared the two implementations are held to golden files recorded from the Python before it went (crew/tools/golden/).

## Consequences

CREW_IMPL and its three modes go away. A crew change lands in Rust alone. Every crew probe needs a built seamux. Cases that only compared the two implementations are kept as golden files. python3 stays a dependency for crew apply's JSON helpers and the probes.
