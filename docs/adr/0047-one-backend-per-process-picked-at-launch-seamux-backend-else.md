# 0047. One backend per process, picked at launch: SEAMUX_BACKEND, else cmux when its socket answers, else tmux

Date: 2026-10-31

## Status

Accepted

## Context

It mirrors the skills' host rule. Running both backends at once would give every view two sources and two id spaces.

## Decision

One backend per process, picked at launch: SEAMUX_BACKEND, else cmux when its socket answers, else tmux

## Consequences

Starting or quitting cmux while the app runs does nothing until the app restarts. The intent server picks on its own by the same rule, so the app passes its choice to the server it starts through SEAMUX_BACKEND. The status chip names the backend.
