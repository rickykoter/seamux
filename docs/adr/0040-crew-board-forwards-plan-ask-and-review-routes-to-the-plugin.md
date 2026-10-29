# 0040. crew-board forwards plan, ask and review routes to the plugin servers

Date: 2026-10-29

## Status

Accepted

## Context

the seamux app assumes one origin for every page it frames or recognises (shell.rs intent_server, tabs.ts, sheet.ts, panelinks.ts, companion.rs seamux_page), so a redirect to another port would quietly break them. A reverse proxy keeps crew's origin and moves the implementation.

## Decision

crew-board forwards plan, ask and review routes to the plugin servers

## Consequences

routes.rs forwards /plan/, /plan-stamp, /plan-evidence/, /inc, /open, /answer, /check/*, /ask/ and /mermaid.min.js to deep-plan serve, and /review/ to lookout serve. It rewrites Host and Origin to the plugin's own and starts a server through its CLI when none answers. The Rust copies of those routes are deleted. Dock URLs, board thumbnails and the app need no change.
