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

## The cloud install

`deep-plan install-repo` and `lookout install-repo` copy each plugin into
the repo's `.claude/skills/<plugin>/`: the skill and its references where
skills load from, and the engine, its hooks and `bin/` beside them. They
merge the plugin's hooks into `.claude/settings.json` with the plugin's root
rewritten to `$CLAUDE_PROJECT_DIR/.claude/skills/<plugin>`, plus a
SessionStart hook that puts `bin/` on the Bash tool's PATH through
`CLAUDE_ENV_FILE`. deep-plan's copy also carries the machine's pinned
mermaid, since the cloud's default network level may not reach the CDN.

Each hook command starts with a guard, so it runs only when
`CLAUDE_CODE_REMOTE=true` or `SEAMUX_REPO_HOOKS=1`. A local session with the
plugins installed runs their own hooks, not these. Multi-repo cloud sessions
load no repo hooks, so they get no gate. Two things the guard cannot settle:
a local session still sees the committed skill beside the plugin's own (the
same text, so it does no harm), and a remote session that also loads the
plugins would run both hook sets. Cloud sessions load no plugins, which is
why the guard keys on the remote host.

The copy carries `.install.json` (the version and a hash per file);
`install-repo --check` reports drift from the plugin it came from. Nothing is
committed for you.

On the remote host plan state and reviews live in the repo under
`.seamux/state/`, kept out of git through `.git/info/exclude`. A fresh
sandbox has none of that, so `deep-plan export-state <slug>` writes a bundle
to commit or carry, and `import-state <file>` brings it back. A review is
shared as an Artifact: `lookout export-artifact`, published only on the
person's yes, then `lookout pull` to bring their comments and closes back.

The live cloud observation the spike could not make (a repo hook running the
engine and seeing `CLAUDE_CODE_REMOTE=true`) is increment 10's manual check.
It needs a cloud environment set up at claude.ai/code and a person to start
the session.
