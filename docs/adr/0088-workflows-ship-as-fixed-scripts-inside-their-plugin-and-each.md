# 0088. Workflows ship as fixed scripts inside their plugin, and each agent fetches its own brief from the CLI

Date: 2026-11-11

## Status

Accepted

## Context

Claude Code lets a plugin ship workflows in a workflows/ folder, run as /<plugin>:<name> with args. A workflow script has no filesystem or shell access, but its agents can run Bash.

## Decision

a fixed file is reviewed once and the probe can run it against stub agents, while each agent runs lookout prompt itself, so the brief still reaches it exactly as printed and never passes through another model

## Consequences

lookout/workflows/review.js and deep-plan/workflows/scout.js are the only workflow scripts; a new brief is a new lookout prompt flag, never text inside a script; a session or the app that cannot run the plugin by name passes the file's path as scriptPath
