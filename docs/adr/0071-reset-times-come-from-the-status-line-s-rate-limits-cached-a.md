# 0071. Reset times come from the status line's rate_limits, cached account-wide

Date: 2026-11-06

## Status

Accepted

## Context

(context not recorded)

## Decision

in Claude Code 2.1.318 the StopFailure payload has only error, error_details and last_assistant_message, with no reset time, while the status line's input carries five_hour and seven_day resets_at on every refresh; crew's status line already runs there in both its Python and Rust forms

## Consequences

crew learns about limits through a new StopFailure hook and a small account-wide cache, limits.json, that both status lines write when their input changes. A person on another status line gets the stop recorded with no reset time, so an armed resume waits for them instead of guessing.
