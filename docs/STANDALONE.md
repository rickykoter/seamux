# Running deep-plan and lookout outside cmux

deep-plan and lookout were built inside cmux, where crew's intent server
serves every live page and cmux places it beside the terminal. This file
records what each other host offers, what was tried before the plugins were
changed to use it, and what that means for the cloud install path.

Plan of record: `standalone-hosts` (increment 1 is this spike).

## Hosts

| Host | How it is detected | Where a page goes | Who answers an ask |
|---|---|---|---|
| cmux | `CMUX_WORKSPACE_ID` is set | a pane beside the terminal, through crew-board on 7345 | the page types the number into the terminal |
| desktop | `CLAUDE_CODE_ENTRYPOINT` is `claude-desktop`, `claude-desktop-3p` or `local-agent` | the app's built-in browser pane | the chat prompt (the page only shows the options) |
| terminal | none of the others | a printed `served at` link | the terminal prompt |
| remote | `CLAUDE_CODE_REMOTE=true` | a published Artifact (nobody can reach the sandbox's localhost) | the chat prompt |

`SEAMUX_HOST=cmux|desktop|terminal|remote` beats every detected signal,
cmux included.

## Desktop: tried 2026-10-28

Setup: Claude desktop 4.29.0, Claude Code 2.1.309, no cmux in the session's
environment. A throwaway Node server listened on `127.0.0.1` at a random
port and kept crew's guards: Host must be `127.0.0.1:<port>` or
`localhost:<port>`, a POST needs the server's own Origin, a JSON content
type and a token compared in constant time.

What happened:

- The session's environment had `CLAUDE_CODE_ENTRYPOINT=claude-desktop`
  and no `CMUX_WORKSPACE_ID` or `CLAUDE_CODE_REMOTE`.
- `preview_start` with the printed `http://127.0.0.1:<port>/` opened the
  page in the browser pane on the first try.
- The page's token-checked GET returned 200. Its POST arrived with
  `Origin: http://127.0.0.1:<port>`, passed all three guards and was
  recorded by the server.

So on desktop a verb prints `served at <url>` and Claude opens it with
`preview_start`. The plugin servers can keep crew's guards unchanged.

## Cloud: what the docs say

This account has no cloud environment yet, so the cloud half of the spike
could not be run from here. The official docs answer each question it asked
(code.claude.com/docs/en/cloud-environments, settings, hooks):

- Hooks in a repo's committed `.claude/settings.json` run in a single-repo
  cloud session. Multi-repo sessions and project threads do not load them.
  User-level `~/.claude/settings.json` does not reach the cloud.
- `CLAUDE_CODE_REMOTE` is `true` there, and hook commands inherit it.
  `$CLAUDE_PROJECT_DIR` is set to the repository root.
- Node 22 is on PATH in the default image.
- Skills in the repo's `.claude/skills/` load. Plugins named in the repo's
  `enabledPlugins` or `extraKnownMarketplaces` do not install.
- The default network level ("Trusted") allows package registries.
  cdnjs.cloudflare.com is not on the default list, so highlight.js is
  vendored rather than fetched.

## What this means for increment 10

The shape in the plan stands: `install-repo` copies the engine, the skill
and the hooks into the target repo's `.claude/`, and merges hook entries
that run `node "$CLAUDE_PROJECT_DIR"/.claude/<plugin>/<engine>.mjs` into its
`.claude/settings.json`. It has to say that multi-repo sessions get no gate.

The observation the spike could not make here (a repo hook running the
engine and seeing `CLAUDE_CODE_REMOTE=true`) moves into increment 10's
manual cloud check. That check needs a cloud environment set up at
claude.ai/code and a person to start the session.
