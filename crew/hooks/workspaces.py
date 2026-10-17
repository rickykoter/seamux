#!/usr/bin/env python3
"""crew — where workspaces are: live, archived, past or gone. One reader.

    workspaces.py lifecycle <workspace>   running | idle | none | unknown
    workspaces.py close <workspace>       force-close and check it went; exit 1 if not
    workspaces.py archive <workspace>     close it and remember it; exit 1 on refusal
    workspaces.py restore <cwd>           reopen an archived cwd, resuming its Claude
    workspaces.py forget <cwd>            drop an archive record
    workspaces.py dormant-days            the sweep's threshold, default 5

Four callers need the same answers: crew-resume (the finder), crew-sweep,
triage.py (the board's archive chip) and crew-reclaim (its mid-turn guard).
A second copy of any of them is how the finder ends up calling a workspace
archived that the sweep thinks is live, so they live here.

What is here:
  - the transcript index (scan, build_index), moved out of crew-resume: one
    JSONL per Claude session under ~/.claude/projects, cached by mtime+size;
  - the live list: `workspace list --json` for every window, joined to
    `sessions list --json` for each workspace's Claude session and whether it
    is mid-turn. sessions list comes from a nightly build and its field names
    may move, so every read of it is defensive and an unreadable answer is
    "unknown", never "idle";
  - the archive store, ~/.cache/cmux-crew/archive.json (ADR 0022):
        {version: 1, records: {<cwd>: {cwd, title, color, branch, session_id,
                                       sessions[], workspace_id, archived_at}}}
    written read-modify-write under an flock with an atomic replace, the
    judgments.py pattern, so two archives in one second keep both records;
  - merged(), the cheap is-it-shipped check, with default_base in
    crew-reclaim's order; dormant_days() from integrations.json.

Archive is close and remember. The worktree, branch and transcript all survive
a close already; the record carries what a close loses — title, color, branch
and the Claude session id — so restore can reopen the workspace as it was with
`claude --resume`. Losing the file costs labels only: an archived row becomes a
past one.
"""

import fcntl
import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.realpath(__file__))
# Env overrides exist for the probe: every one of these is user state.
PROJECTS = os.environ.get("CREW_CLAUDE_PROJECTS") or os.path.join(HOME, ".claude", "projects")
CACHE_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"),
                         "cmux-crew")
INDEX = os.path.join(CACHE_DIR, "resume-index.json")
ARCHIVE = os.path.join(CACHE_DIR, "archive.json")
INTEGRATIONS = os.environ.get("CREW_INTEGRATIONS") or os.path.join(HERE, "..", "integrations.json")
DORMANT_DEFAULT = 5

# One definition of "which cmux": bin/crew-cmux-bin, the same lookup crew-resume
# has always made. PATH first so the common case costs no subprocess.
_CMUX_RESOLVER = os.path.join(HERE, "..", "bin", "crew-cmux-bin")
CMUX = (os.environ.get("CREW_CMUX")
        or next((os.path.join(d, "cmux")
                 for d in os.environ.get("PATH", "").split(os.pathsep)
                 if d and os.access(os.path.join(d, "cmux"), os.X_OK)), None)
        or (subprocess.run([_CMUX_RESOLVER], capture_output=True, text=True).stdout.strip()
            if os.access(_CMUX_RESOLVER, os.X_OK) else "")
        or "cmux")


# --- the transcript index ------------------------------------------------------
# Transcripts run to tens of megabytes. The fields we want sit at the two ends:
# cwd/branch/first-prompt in the opening records, ai-title/last-prompt near the
# close. So read a slice from each end rather than the whole file.
HEAD_BYTES = 64 * 1024
TAIL_BYTES = 256 * 1024
# Bumped when scan() learns a field, so a cached summary without it is re-read.
INDEX_V = 2


def _records(chunk):
    for line in chunk.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue          # a slice can clip a line at either edge
        if isinstance(rec, dict):
            yield rec


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return block.get("text", "")
    return ""


def scan(path):
    """Pull a session summary out of one transcript."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > HEAD_BYTES + TAIL_BYTES:
                head = fh.read(HEAD_BYTES)
                fh.seek(-TAIL_BYTES, os.SEEK_END)
                tail = fh.read()
            else:
                # Small enough to read whole. The whole file is the tail too,
                # or a 100 KB transcript's last words would come from its
                # first 64 KB.
                tail = fh.read()
                head = tail[:HEAD_BYTES]
    except OSError:
        return None

    info = {
        "id": os.path.basename(path)[:-6],
        "path": path,
        "cwd": "",
        "branch": "",
        "title": "",
        "prompt": "",
        "started": "",
        "turns": 0,
        "v": INDEX_V,
    }

    for rec in _records(head.decode("utf-8", "replace")):
        if not info["cwd"] and rec.get("cwd"):
            info["cwd"] = rec["cwd"]
            info["branch"] = rec.get("gitBranch") or ""
            info["started"] = rec.get("timestamp") or ""
        if not info["prompt"] and rec.get("type") == "user":
            info["prompt"] = _text_of((rec.get("message") or {}).get("content"))
        if info["cwd"] and info["prompt"]:
            break

    # ai-title is a recent addition — most older sessions have none, so the
    # first prompt stays the fallback. Claude's last words ride along for the
    # sweep, which asks Jev whether the work they describe is finished.
    end = tail.decode("utf-8", "replace")
    for chunk in (tail.decode("utf-8", "replace"), head.decode("utf-8", "replace")):
        for rec in _records(chunk):
            if rec.get("type") == "ai-title" and rec.get("aiTitle"):
                info["title"] = rec["aiTitle"]
            elif rec.get("type") == "last-prompt" and rec.get("lastPrompt"):
                info["last"] = rec["lastPrompt"]
        if info["title"]:
            break
    for rec in _records(end):
        if rec.get("type") == "assistant":
            said = _text_of((rec.get("message") or {}).get("content"))
            if said:
                info["said"] = said[-600:]

    info["mtime"] = os.path.getmtime(path)
    info["size"] = size
    return info


def build_index(force=False):
    """Every transcript's summary, re-scanning only what changed. -> (rows, seen)"""
    cache = {}
    if not force and os.path.exists(INDEX):
        try:
            with open(INDEX) as fh:
                cache = json.load(fh)
        except Exception:
            cache = {}

    out, seen = {}, 0
    for root, _dirs, files in os.walk(PROJECTS):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(root, name)
            seen += 1
            try:
                st = os.stat(path)
            except OSError:
                continue
            prev = cache.get(path)
            # An unchanged transcript cannot have grown a new title.
            if prev and prev.get("mtime") == st.st_mtime and prev.get("size") == st.st_size \
                    and prev.get("v") == INDEX_V:
                out[path] = prev
                continue
            info = scan(path)
            if info:
                out[path] = info

    _write_json(INDEX, out)
    return list(out.values()), seen


def label(s):
    t = s.get("title") or s.get("prompt") or "(no prompt)"
    return " ".join(t.split())


# --- cmux ------------------------------------------------------------------------

def _cmux(*argv, timeout=10):
    """(ok, stdout, stderr) of one cmux call; never raises."""
    try:
        r = subprocess.run([CMUX] + list(argv), capture_output=True, text=True,
                           timeout=timeout, env=dict(os.environ, CMUX_QUIET="1"))
        return r.returncode == 0, r.stdout, (r.stderr or r.stdout).strip()
    except Exception as e:
        return False, "", str(e)


def _cmux_json(*argv):
    ok, out, _ = _cmux(*argv)
    if not ok:
        return None
    try:
        return json.loads(out)
    except ValueError:
        return None


def live_workspaces():
    """Every open workspace in every window, or None when cmux did not answer.

    None and [] are different sentences: "could not tell" must never read as
    "nothing is open", or an archived record looks orphaned while it is live.
    """
    wins = _cmux_json("list-windows", "--json")
    ids = [w.get("id") for w in wins if isinstance(w, dict) and w.get("id")] \
        if isinstance(wins, list) else []
    lists = [_cmux_json("workspace", "list", "--json", "--window", i) for i in ids] \
        if ids else [_cmux_json("workspace", "list", "--json")]
    if any(not isinstance(d, dict) for d in lists):
        return None
    out, seen = [], set()
    for d in lists:
        for w in d.get("workspaces") or []:
            wid = w.get("id") or w.get("ref")
            if not wid or wid in seen:
                continue
            seen.add(wid)
            out.append({
                "id": wid,
                "ref": w.get("ref") or wid,
                "title": (w.get("title") or "").strip(),
                "cwd": w.get("current_directory") or "",
                "color": w.get("custom_color") or "",
                "description": w.get("description") or "",
                "selected": bool(w.get("selected")),
                "window": d.get("window_ref") or "",
                "last_message": w.get("latest_conversation_message") or "",
            })
    return out


def agent_sessions():
    """The saved agent session records, or None when sessions list did not answer.

    It needs no socket, so None means the command itself is missing or its
    output moved — read every field through _field for the same reason.
    """
    # --all: the default view filters to active/restorable/transcript-backed
    # records, and a filtered-out record would read as "no agent here".
    d = _cmux_json("sessions", "list", "--json", "--all")
    rows = d.get("sessions") if isinstance(d, dict) else d
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else None


def _field(r, *names):
    for n in names:
        v = r.get(n)
        if v not in (None, ""):
            return v
    return None


def _ws_of(r):
    return _field(r, "workspace_id", "workspaceId", "workspace")


def _sid_of(r):
    return _field(r, "session_id", "sessionId", "id")


def _stamp(r):
    try:
        return float(_field(r, "updated_at_unix", "updatedAtUnix") or 0)
    except (TypeError, ValueError):
        return 0.0


QUIET = ("idle", "stopped", "exited", "ended", "terminated")


def _mid_turn(r):
    """Anything but a known quiet lifecycle is mid-turn: "running", but also an
    agent waiting on a permission prompt or a question (needsInput), and any
    value a later build invents. A record whose pid is gone says so about a
    process that died; the workspace is not busy, it is orphaned."""
    if r.get("stored_pid_exists") is False:
        return False
    life = str(_field(r, "agent_lifecycle", "agentLifecycle", "lifecycle") or "").lower()
    return life not in QUIET


def sessions_for(ws, records):
    """This workspace's records, the active one first, then newest first."""
    mine = [r for r in records or [] if _ws_of(r) in (ws.get("id"), ws.get("ref"))]
    mine.sort(key=lambda r: (not r.get("active_for_workspace"), -_stamp(r)))
    return mine


def _is_uuid(s):
    return len(s or "") == 36 and s.count("-") == 4


def lifecycle(ws, records=None):
    """running | idle | none | unknown for one workspace (a dict, id or ref).

    `none` is a workspace with no agent record: a plain shell. `unknown` is a
    sessions list that did not answer and a sidebar-state that did not either;
    callers refuse on it.
    """
    if not isinstance(ws, dict):
        # Session records carry the uuid; a hand-typed handle is a ref, and with
        # no live list to translate it nothing would match: unknown, not none.
        handle, live = ws, live_workspaces()
        ws = find_live(handle, live) or {"id": handle, "ref": handle}
        if live is None and not _is_uuid(handle):
            return "unknown"
    if records is None:
        records = agent_sessions()
    if records is not None:
        mine = sessions_for(ws, records)
        if not mine:
            return "none"
        return "running" if any(_mid_turn(r) for r in mine) else "idle"
    ok, out, _ = _cmux("sidebar-state", "--workspace", ws.get("ref") or ws.get("id"))
    if not ok:
        return "unknown"
    if "claude_code=Running" in out:
        return "running"
    return "idle" if "claude_code=" in out else "none"


def find_live(handle, live=None):
    """The live workspace a uuid, ref or cwd names, or None."""
    live = live_workspaces() if live is None else live
    for w in live or []:
        if handle in (w["id"], w["ref"]):
            return w
    for w in live or []:
        if w["cwd"] and w["cwd"] == handle:
            return w
    return None


def close(handle):
    """Force-close a workspace and check it went. -> (ok, why)

    --force because cmux asks for confirmation whenever any process runs in
    the workspace, and an idle Claude at its prompt is one. Callers have
    already refused a mid-turn agent; that check is the guard --force skips.
    A close cmux reports as done is believed only once the workspace is gone
    from the list, unless the list itself does not answer.
    """
    ok, _, err = _cmux("workspace", "close", handle, "--force")
    if not ok:
        return False, err.splitlines()[-1] if err else "close failed"
    # The list can trail the close by a beat; give it a second and a half
    # before calling a close that cmux said was done a failure.
    for _ in range(6):
        after = live_workspaces()
        if after is None or not any(handle in (w["id"], w["ref"]) for w in after):
            return True, ""
        time.sleep(0.25)
    return False, "it is still open"


def select(ws):
    """Bring a live workspace forward."""
    return _cmux("workspace", "select", ws)[0]


# --- git -------------------------------------------------------------------------

def _git(cwd, *argv, timeout=10):
    try:
        r = subprocess.run(["git", "-C", cwd] + list(argv), capture_output=True,
                           text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except Exception:
        return 1, ""


def branch(cwd):
    rc, out = _git(cwd, "branch", "--show-current")
    return out if rc == 0 else ""


def default_base(cwd):
    """origin/HEAD, else origin/main or origin/master, else None — the same
    order as crew-reclaim's and crew-worktree's default_base."""
    rc, out = _git(cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    if rc == 0 and out:
        return out
    for b in ("origin/main", "origin/master"):
        if _git(cwd, "show-ref", "--verify", "--quiet", "refs/remotes/" + b)[0] == 0:
            return b
    return None


def merged(cwd):
    """True when cwd's branch is fully contained in its default branch.

    Cheap on purpose (no fetch, no gh): the sweep asks it of every worktree on
    the machine. The primary checkout's branch is trivially contained, so it is
    never merged; crew-reclaim re-checks everything after a fetch anyway.
    """
    b = branch(cwd)
    if not b or b in ("main", "master"):
        return False
    base = default_base(cwd)
    if not base or _git(cwd, "merge-base", "--is-ancestor", "HEAD", base)[0] != 0:
        return False
    # A branch cut a minute ago is an ancestor of its base too. It shipped only
    # if it ever held work: it moved after it was created, or it was pushed
    # under its own name. Not "has an upstream": `worktree add -b X origin/main`
    # makes origin/main the upstream of every fresh branch.
    rc, log = _git(cwd, "reflog", "show", "--format=%H", "refs/heads/" + b)
    moved = rc == 0 and len(log.splitlines()) > 1
    pushed = _git(cwd, "show-ref", "--verify", "--quiet", "refs/remotes/origin/" + b)[0] == 0
    return moved or pushed


def dormant_days():
    """sweep.dormant_days from integrations.json (the sweep_dormant_days plugin
    option, rendered by options.py), at least 1, default 5."""
    try:
        with open(INTEGRATIONS) as fh:
            n = int((json.load(fh).get("sweep") or {}).get("dormant_days", DORMANT_DEFAULT))
        return max(1, n)
    except Exception:
        return DORMANT_DEFAULT


# --- the archive store -----------------------------------------------------------

def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())     # two writers must not share one tmp
    try:
        with open(tmp, "w") as fh:
            json.dump(data, fh)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def load_archive():
    """{cwd: record}. A missing or unreadable file is an empty archive."""
    try:
        with open(ARCHIVE) as fh:
            d = json.load(fh)
        recs = d.get("records") if isinstance(d, dict) else None
        if not isinstance(recs, dict):
            return {}
        return {k: v for k, v in recs.items() if isinstance(v, dict)}
    except (OSError, ValueError):
        return {}


def _update(fn):
    """Read-modify-write the archive under an flock on a sidecar file, released
    by the kernel if the writer dies. fn(records) mutates in place."""
    os.makedirs(os.path.dirname(ARCHIVE), exist_ok=True)
    with open(ARCHIVE + ".lock", "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        recs = load_archive()
        out = fn(recs)
        _write_json(ARCHIVE, {"version": 1, "records": recs})
        return out


def archive(handle, live=None, records=None):
    """Close a live workspace and remember it. -> (ok, message)

    Refuses while its agent is mid-turn, or when that cannot be told. The record
    is written before the close, so a close that lands and a process that dies
    right after still leave it remembered; a close that fails puts back whatever
    was there before. --force is what gets an idle Claude past cmux's
    confirmation — the mid-turn check above is the guard that replaces it.
    """
    live = live_workspaces() if live is None else live
    if live is None:
        return False, "cmux did not list its workspaces"
    ws = find_live(handle, live)
    if not ws:
        return False, "no open workspace %s" % handle
    if records is None:
        records = agent_sessions()
    life = lifecycle(ws, records)
    name = ws["title"] or ws["ref"]
    if life == "running":
        return False, "%s: Claude is mid-turn — archive it when the turn ends" % name
    if life == "unknown":
        return False, "%s: could not tell whether Claude is mid-turn" % name
    cwd = ws["cwd"]
    if not cwd:
        return False, "%s has no directory to remember" % name

    # Claude's sessions only: restore runs `claude --resume`, and another
    # agent's id would resume nothing. Mid-turn above counts every agent.
    sids = []
    for r in sessions_for(ws, records or []):
        s = _sid_of(r)
        if s and s not in sids and str(r.get("agent") or "claude").lower() == "claude":
            sids.append(s)
    rec = {
        "cwd": cwd,
        "title": ws["title"],
        "color": ws["color"],
        "branch": branch(cwd) if os.path.isdir(cwd) else "",
        "session_id": sids[0] if sids else "",
        "sessions": sids,
        "workspace_id": ws["id"],
        "archived_at": time.time(),
    }

    def put(recs):
        # One record per cwd. A second workspace archived on the same directory
        # takes the label, and keeps the first one's sessions behind its own,
        # so the finder's expand can still reach them.
        prev = recs.get(cwd)
        if prev:
            rec["sessions"] += [x for x in prev.get("sessions") or [] if x not in rec["sessions"]]
            rec["session_id"] = rec["session_id"] or prev.get("session_id") or ""
        recs[cwd] = rec
        return prev
    before = _update(put)

    ok, why = close(ws["id"])
    if not ok:
        def put_back(recs):
            if before is None:
                recs.pop(cwd, None)
            else:
                recs[cwd] = before
        _update(put_back)
        return False, "%s: cmux did not close it (%s)" % (name, why)
    return True, "archived %s" % name


def restore(cwd):
    """Reopen an archived cwd as it was, resuming its Claude. -> (ok, message)

    The record goes only once the new workspace exists; a color that will not
    set is cosmetic and does not fail the restore.
    """
    rec = load_archive().get(cwd)
    if not rec:
        return False, "nothing archived at %s" % cwd
    if not os.path.isdir(cwd):
        return False, "%s no longer exists — forget the record instead" % cwd
    sid = rec.get("session_id") or ""
    cmd = "claude --resume %s" % sid if sid else "claude"
    argv = ["workspace", "create", "--cwd", cwd, "--command", cmd, "--focus", "true"]
    if rec.get("title"):
        argv[2:2] = ["--name", rec["title"]]
    ok, out, err = _cmux(*argv)
    if not ok:
        return False, "cmux did not open %s (%s)" % (cwd, err.splitlines()[-1] if err else "?")
    ref = next((t for t in out.split() if t.startswith("workspace:")), "")
    if ref and rec.get("color"):
        _cmux("workspace-action", "--action", "set-color", "--color", rec["color"],
              "--workspace", ref)
    _update(lambda recs: recs.pop(cwd, None))
    return True, "restored %s%s" % (rec.get("title") or cwd, " in " + ref if ref else "")


def forget(cwd):
    """Drop an archive record. -> True when there was one."""
    return _update(lambda recs: recs.pop(cwd, None)) is not None


def main(argv):
    cmd, arg = (argv[1] if len(argv) > 1 else ""), (argv[2] if len(argv) > 2 else "")
    if cmd == "lifecycle" and arg:
        print(lifecycle(arg))
        return 0
    if cmd == "close" and arg:
        ok, why = close(arg)
        if not ok:
            print(why, file=sys.stderr)
        return 0 if ok else 1
    if cmd == "dormant-days":
        print(dormant_days())
        return 0
    if cmd in ("archive", "restore") and arg:
        ok, msg = (archive if cmd == "archive" else restore)(arg)
        print(msg, file=sys.stdout if ok else sys.stderr)
        return 0 if ok else 1
    if cmd == "forget" and arg:
        return 0 if forget(arg) else 1
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
