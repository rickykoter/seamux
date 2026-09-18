# 0003. Pages act on a session only through the intent server, by typing a verified option number

Date: 2026-09-17

## Status

Accepted

## Context

Until now a served plan page could act on plan STATE (the token-checked /inc route runs deep-plan transitions) and could hand text back only through the clipboard blob. An ask page needs to act on the SESSION itself: put a choice into a terminal prompt that is waiting. cmux exposes send, send-key and read-screen addressed by surface, and the agent's own surface id is in its environment when it runs `deep-plan ask`, so the ask can record exactly one legitimate target.

## Decision

Pages act on a session only through the intent server, by typing a verified option number

## Consequences

a page may act on a session only through the intent server, never from the page's own script or a file:// copy; every such action is token-checked and targets only the surface the ask itself recorded, never a surface named by the request; keystrokes are limited to the option number and Enter; measured on 2026-09-17, the number key submits the prompt by itself and the prompt collapses to a line ending in "→ <option label>", which read-screen takes as the proof of delivery — Enter is sent only when the screen instead shows the pointer moved to that number without resolving, and never blind; a failed verification degrades to telling the human what to press, never to retrying; any future page-to-session action (approving a permission prompt, answering free text) goes through the same route and the same verify-then-commit rule
