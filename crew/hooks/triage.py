#!/usr/bin/env python3
"""crew — cmux notification hook. Decides which notifications earn a banner.

Wired from cmux.json as notifications.hooks[]. cmux pipes the notification
policy in on stdin and applies whatever policy we print back.

The rule: a banner should mean "something is stuck on you". Routine
turn-complete does not qualify — across a dozen worktrees it fires constantly
and trains you to dismiss banners without reading them. Those stay in the
sidebar, and cmux's own agentIdleReminder still pings ~60s later if you never
come back.

Markers come from crew-hook.sh, which stamps the notification subtitle:
    crew:turn      turn finished     -> sidebar only
    crew:blocked   Claude needs you  -> banner

Board buttons ride the same channel with their own verbs; crew:plan-go is
deep-plan's, and it is the only one that authorizes work rather than reporting it.
crew:reclaim is the only one that deletes, so it opens a terminal and asks
rather than acting.

Anything without a crew marker is left exactly as cmux proposed it. On any
error we echo the input back unchanged, so a bug here degrades to stock
behavior rather than swallowing notifications.
"""

import json
import os
import shlex
import subprocess
import sys

BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin")
CREW_SYNC = os.path.join(BIN, "crew-sync")
# One definition of "which cmux": bin/crew-cmux-bin. PATH is consulted here first so
# the common case costs no subprocess; the resolver is only reached when PATH has no
# cmux. A hardcoded bundle path silently drove the old cli against the nightly app.
_CMUX_RESOLVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../bin/crew-cmux-bin")
CMUX = (os.environ.get("CMUX_CLAUDE_HOOK_CMUX_BIN")
        or next((os.path.join(d, "cmux")
                 for d in os.environ.get("PATH", "").split(os.pathsep)
                 if os.access(os.path.join(d, "cmux"), os.X_OK)), None)
        or (subprocess.run([_CMUX_RESOLVER], capture_output=True, text=True).stdout.strip()
            if os.access(_CMUX_RESOLVER, os.X_OK) else "")
        or "cmux")

# deep-plan's go-ahead, fired from the board's `go N` chip.
#
# Through a login shell, unlike every other fired command here, for one reason:
# deep-plan is node, and this hook's environment is the cmux app's -- which carries
# neither ~/.local/bin nor whichever nvm/asdf shim owns `node`. `sh -lc` loads the
# profile that does. The fallback is not decoration: a missing symlink would
# otherwise fail silently, and a go-ahead that quietly does nothing is the worst
# possible bug in a gate.
#
# crew-sync runs straight after, because increment status lives in `description` and
# that only moves when sync does -- without it the chip you just tapped sits there
# looking untapped for up to two minutes.
PLAN_GO = ('if command -v deep-plan >/dev/null 2>&1; then deep-plan go --at %s next; '
           'else node "$HOME/.claude/skills/deep-plan/deep_plan.mjs" go --at %s next; fi; '
           'exec %s')


def ws_cwd(ws: str) -> str:
    """Resolve a workspace id to its directory — here, in the hook.

    This has to happen before fire(), not inside the command fire() spawns. The
    cmux CLI only answers callers it recognises as running inside cmux, and it
    authorizes this hook because the hook is a live child of the cmux app; the
    hook's own environment carries no capability token, only CMUX_NOTIFICATION_*.
    A fired command is detached and outlives the hook, so by the time it runs its
    parent is pid 1 — not a descendant, no token — and the CLI answers
    "Access denied - only processes started inside cmux can connect".

    That denial was silent in the shape crew consumed it: the lookup came back
    empty and the command fell through to its own cwd, which for a child of the
    cmux app is ~/.config/cmux. That is why tapping a branch on the board opened
    crew's config directory in VS Code instead of the worktree.
    """
    if not ws:
        return ""
    try:
        out = subprocess.run([CMUX, "sidebar-state", "--workspace", ws],
                             capture_output=True, text=True, timeout=10)
        if out.returncode != 0:
            return ""
        for line in out.stdout.splitlines():
            if line.startswith("cwd="):
                p = line[4:].strip()
                return p if p and p != "unknown" and os.path.isdir(p) else ""
    except Exception:
        pass
    return ""


def cmux_json(*argv):
    """Run a cmux command that speaks JSON and return the parsed object."""
    try:
        r = subprocess.run([CMUX] + list(argv), capture_output=True, text=True,
                           timeout=10, env=dict(os.environ, CMUX_QUIET="1"))
        return json.loads(r.stdout) if r.returncode == 0 else {}
    except Exception:
        return {}


def host_workspace(avoid: str) -> str:
    """Where a board tap should put a terminal: the workspace you are looking at.

    `avoid` is the workspace the command is about to operate on. Reclaim closes
    that workspace before it deletes the directory, so a terminal living inside
    it would be SIGHUPed halfway through — after the close, before the removal.
    Anywhere else will do, and the focused workspace is where you are already
    looking.
    """
    rows = (cmux_json("workspace", "list", "--json") or {}).get("workspaces") or []
    usable = [w for w in rows if w.get("id") and avoid not in (w.get("id"), w.get("ref"))]
    for w in usable:
        if w.get("selected"):
            return w["id"]
    return usable[0]["id"] if usable else ""


def open_terminal(ws: str, argv) -> bool:
    """Split a terminal into `ws` and run `argv` in it.

    Both calls happen here, in the hook, for the reason ws_cwd spells out — a
    detached child cannot be counted on to reach the socket.

    respawn-pane, not `send`: typing into a fresh pane races the shell's own
    startup, and this zsh takes ~3s to be ready, so the command gets echoed raw
    and then redrawn under the prompt. respawn hands the pty straight to
    /bin/sh -c with no rc files in the way. The `exec $SHELL -l` tail is what
    keeps the pane afterwards — a respawned command that simply exits takes the
    pane and all of its output down with it, which would erase the answer the
    moment it arrived.
    """
    if not ws:
        return False
    cmd = " ".join(shlex.quote(a) for a in argv) + '; exec "${SHELL:-/bin/zsh}" -l'
    try:
        r = subprocess.run([CMUX, "new-pane", "--type", "terminal",
                            "--direction", "down", "--workspace", ws,
                            "--focus", "true"],
                           capture_output=True, text=True, timeout=10)
        # "OK surface:131 pane:51 workspace:3"
        surface = next((t for t in r.stdout.split() if t.startswith("surface:")), "")
        if r.returncode != 0 or not surface:
            return False
        r = subprocess.run([CMUX, "respawn-pane", "--surface", surface,
                            "--command", cmd],
                           capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            return False
        # After respawn, not before: respawn resets the title to "Terminal".
        subprocess.run([CMUX, "rename-tab", "--surface", surface, "reclaim"],
                       capture_output=True, timeout=10)
        return True
    except Exception:
        return False


def fire(*argv) -> None:
    """Run a crew command in the background, detached from this hook."""
    try:
        subprocess.Popen(list(argv), start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def main() -> int:
    raw = sys.stdin.read()
    try:
        policy = json.loads(raw)
        subtitle = (policy.get("notification") or {}).get("subtitle") or ""
        effects = policy.get("effects")

        # The board's refresh button. A custom sidebar can only invoke cmux
        # dispatcher methods — there is no shell action and no `run this action
        # id` method — so the button posts a marked notification and this hook,
        # which cmux already runs on every notification, turns it into the
        # actual command. Suppress every effect: it is an RPC, not a message.
        # Board buttons ride this channel. The workspace id comes off the
        # notification itself, so a per-row button needs no extra encoding.
        if subtitle in ("crew:sync-now", "crew:reclaim", "crew:code",
                        "crew:sandbox-up", "crew:sandbox-down",
                        "crew:feed-allow", "crew:feed-deny",
                        "crew:plan-go"):
            note = policy.get("notification") or {}
            ws = note.get("workspaceId") or ""
            if subtitle == "crew:sync-now":
                fire(CREW_SYNC)
            elif subtitle == "crew:reclaim":
                # The one board button that deletes something. It does not run
                # the reclaim — it opens a terminal you can read, runs the dry
                # run there, and leaves a y/N prompt sitting at the bottom. A
                # chip is one stray click away from a gigabyte of worktree and
                # a branch, and the guards that would refuse are worth seeing
                # even when they all pass.
                #
                # The terminal goes anywhere except the workspace being
                # reclaimed, because reclaiming closes that workspace.
                bin_reclaim = os.path.join(BIN, "crew-reclaim")
                if not open_terminal(host_workspace(ws), [bin_reclaim, ws]):
                    # Never fall back to running it: a delete that happens
                    # because the terminal would not open is exactly the
                    # accident this branch exists to prevent.
                    # Synchronously, not through fire(): a detached child is
                    # orphaned and holds no token, so the notification telling
                    # you the tap failed would fail the same silent way.
                    try:
                        subprocess.run(
                            [CMUX, "notify", "--title", "crew",
                             "--subtitle", "reclaim",
                             "--body", "could not open a terminal — run: "
                                       "crew-reclaim " + (ws_cwd(ws) or ws)],
                            capture_output=True, timeout=10)
                    except Exception:
                        pass
            elif subtitle == "crew:code":
                # Opens that worktree in the VS Code desktop app, or focuses the
                # window already on it. Hand it the resolved path: it cannot do
                # the lookup itself once detached (see ws_cwd). Falling back to
                # the id is not a silent guess — crew-code refuses outright when
                # it cannot resolve one.
                cwd = ws_cwd(ws)
                if cwd:
                    fire(os.path.join(BIN, "crew-code"), cwd)
                else:
                    fire(os.path.join(BIN, "crew-code"), "--workspace", ws)
            elif subtitle == "crew:plan-go":
                # Authorizes the next increment of whichever plan is tracked against
                # that worktree. Same resolved-path handoff as crew:code, and for the
                # same reason: once detached this process cannot ask cmux anything,
                # and deep-plan resolves a plan from a directory.
                cwd = ws_cwd(ws)
                if cwd:
                    q = shlex.quote(cwd)
                    fire("/bin/sh", "-lc", PLAN_GO % (q, q, shlex.quote(CREW_SYNC)))
            elif subtitle in ("crew:sandbox-up", "crew:sandbox-down"):
                # The sandbox badge, both directions. Same resolved-path handoff
                # as crew:code, and it matters more here: the old cwd fallback
                # would have built a microVM around ~/.config/cmux.
                verb = "up" if subtitle.endswith("up") else "down"
                cwd = ws_cwd(ws)
                if cwd:
                    fire(os.path.join(BIN, "crew-sandbox"), verb, cwd)
                else:
                    fire(os.path.join(BIN, "crew-sandbox"), "--workspace", ws, verb)
            else:
                # Replies go through crew-feed, never straight to
                # feed.*.reply — it re-validates the window and writes the
                # audit line, and neither can happen from the sidebar.
                mode = "once" if subtitle.endswith("allow") else "deny"
                fire(os.path.join(BIN, "crew-feed"), "reply", mode, ws)
            if isinstance(effects, dict):
                for k in list(effects):
                    effects[k] = False
            sys.stdout.write(json.dumps(policy))
            return 0

        if isinstance(effects, dict) and subtitle == "crew:turn":
            effects["desktop"] = False
            effects["sound"] = False
            # Keep record/markUnread/reorderWorkspace: the sidebar is the point.

        sys.stdout.write(json.dumps(policy))
    except Exception:
        sys.stdout.write(raw)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
