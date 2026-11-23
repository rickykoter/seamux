# 0121. A report section names the hosts its cmd: sources need

Date: 2026-11-23

## Status

Accepted

## Context

The gh host check knows one CLI. Most vendor CLIs reach a host that depends on the account, region or a self-hosted install, so a table in code can't know it. The choices were a hosts list on each section, one map of command to hosts beside the sandbox lists, or a host inside the via string.

## Decision

The person's call: the hosts sit in the section, next to the ask that needs them, so any vendor CLI gets the same Not checked line as gh without a code change.

## Consequences

A section in bosun.json's reports may carry "hosts": ["<host>", ...]. When the key is there it replaces the built-in table for that section's cmd: sources, and an empty list turns the host check off; without it the built-in table applies. Every listed host must be covered by the running sandbox's allowedDomains, and the why names each one that is not. mcp: sources ignore it. Two reports that use the same CLI each list its hosts.
