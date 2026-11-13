# 0096. A force-push allow covers one branch for one Claude session, kept in cmux-crew/allow/<session>.json, written only by the app

Date: 2026-11-13

## Status

Accepted

## Context

A rebased feature branch gets pushed several times in one session, and asking each time is the friction this work set out to remove. The agent runs as the same user, though, so any file bash-guard trusts is a file the agent could write. bash-guard guards against accidents, not against a determined agent.

## Decision

The held banner's "Run and allow <branch> this session" runs the push in the chat, then has the app add the branch to `forcePush` in `cmux-crew/allow/<session>.json`. For the rest of that session, bash-guard lets a leased push to a listed branch through. That means a plain `git push` with `--force-with-lease` (and optionally `--force-if-includes`, `-u`, `-q` or `-v`), at most a remote and one refspec, and no `-f`, `--force`, `+refspec` or `--mirror`. Without a refspec, the branch is the one checked out in the session's folder, and only when the push is the whole command.

## Consequences

bash-guard refuses any Bash command that names the allow folder, including one that names `cmux-crew` and an `allow` path word together. guard_write.sh refuses an Edit or Write there. A determined agent could still build the path from pieces. The allow ends with the session. `BASH_GUARD_FORCE_PUSH_BRANCHES` stays the way to set a permanent allow.

Alternatives considered: no allow in this version; writing the branch pattern into BASH_GUARD_FORCE_PUSH_BRANCHES for good; allowing any runnable block for the session.
