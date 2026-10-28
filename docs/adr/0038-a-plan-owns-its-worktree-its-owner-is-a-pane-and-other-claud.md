# 0038. A plan owns its worktree; its owner is a pane, and other Claudes there are guests who are warned, not blocked

Date: 2026-10-28

## Status

Accepted

## Context

decide.mjs flips an authorized increment to working on the first allowed edit from any session. stampOwner records the session and workspace but not the pane, and a session id changes on /clear and resume. The board's working badge came from any Claude in the workspace.

## Decision

A plan owns its worktree; its owner is a pane, and other Claudes there are guests who are warned, not blocked

## Consequences

stampOwner records CMUX_SURFACE_ID. Only the owner flips an increment to working: the same pane (a /clear keeps it) or the same session (a resume in another pane keeps that). While the plan is implementing, a guest's write inside the root passes with a systemMessage naming the plan and the owner pane, once per session and plan, and a guest line goes to the plan's log so a review can see it. The gate's own writes never stamp the owner, so a guest never takes the plan. A deep-plan command run from another pane does move ownership there, and the warning says so. A guest's commits can still land in an increment's range; the human accepted that over blocking.
