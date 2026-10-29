# 0041. A page types into a session only through the plugin's server, and only in cmux

Date: 2026-10-29

## Status

Accepted

## Context

ADR 0003's verify-then-type rule depends on cmux read-screen and send, which exist nowhere else. Outside cmux the terminal prompt stays the answer of record, and the page shows the options without acting.

## Decision

A page types into a session only through the plugin's server, and only in cmux

## Consequences

Amends ADR 0003: 'the intent server' becomes 'the plugin's server, reached directly or through crew-board's proxy'. deep-plan serve ports crew's deliver() unchanged and runs it only when the ask recorded a cmux surface. In desktop, terminal and remote hosts an ask page says to answer in the chat prompt. Keystrokes are still only the option number and Enter, and Enter is never sent blind.
