# 0110. On tmux, the seamux app runs crew-sync's timer and workspace-change trigger; crew-listen stays cmux's

Date: 2026-11-22

## Status

Accepted

## Context

On tmux nothing runs crew-sync on a timer or when a workspace opens or closes. crew-listen does both on cmux, but it follows cmux's event stream and the SessionStart hook does not start it without cmux.

## Decision

You chose the app. On tmux the app already owns the sessions and runs the other watchers (land_watch, pr_watch). crew-listen was a detached daemon only because a launchd job could not reach cmux's socket.

## Consequences

The app starts a sync watcher at launch only when its backend is tmux. While the app is closed, only a turn's Stop hook runs crew-sync. crew doctor and crew status on tmux name the app as the reconciler and do not ask for crew-listen. Deleting cmux support later leaves crew-listen with nothing to do on tmux.
