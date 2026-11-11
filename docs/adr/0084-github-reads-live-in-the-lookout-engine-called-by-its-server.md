# 0084. GitHub reads live in the lookout engine, called by its server and the app

Date: 2026-11-11

## Status

Accepted

## Context

Nothing in the repo reads GitHub review threads. crew-sync polls PR facts per workspace folder every 5 minutes, without the head sha or check links, and never sees the Lookout tab's clones. The app's Lookout tab reads the PR once, when it fetches it.

## Decision

Every GitHub read lives in the lookout engine as `lookout gh sync <id>`. It writes a `github` block into the review record. lookout's page server runs it while a page is visible, and the app runs it in the background for notifications. Wherever lookout serves the page (cmux, Claude desktop, a plain terminal), the page then shows the PR, and the review store keeps one writer. The page already re-reads its record every 2.5 s, so it needs no new wiring.

## Consequences

lookout gains a gh dependency (LOOKOUT_GH, faked in its probe). The app calls lookout for GitHub reads and for posting instead of calling gh itself. A later CI auto-fix plan reads the same `github` block.
