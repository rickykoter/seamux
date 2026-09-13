#!/usr/bin/env python3
"""Render a cmux sidebar source through the interpreter worker and dump the IR.

The worker is the app binary itself in --cmux-sidebar-interpreter-worker mode,
speaking 4-byte big-endian length-prefixed JSON on stdin/stdout. Encoding of
`state` follows Swift's synthesized enum Codable for SwiftValue: a single-key
container named for the case, payload under "_0" for unlabeled values.
"""
import json
import struct
import subprocess
import sys

CMUX = "/Applications/cmux.app/Contents/MacOS/cmux"
FLAG = "--cmux-sidebar-interpreter-worker"


def S(v):
    return {"string": {"_0": v}}


def I(v):
    return {"int": {"_0": v}}


def D(v):
    return {"double": {"_0": v}}


def B(v):
    return {"bool": {"_0": v}}


def A(vs):
    return {"array": {"_0": vs}}


def O(d):
    return {"object": {"_0": d}}


NOW = 1786400000


def ws(wid, title, branch, desc, age, **kw):
    d = {
        "id": S(wid),
        "title": S(title),
        "branch": S(branch),
        "description": S(desc),
        "latestAt": I(NOW - age),
        "latestMessage": S(kw.get("msg", "a readable last message")),
        "latestPrompt": S("what you last asked"),
        "selected": B(kw.get("selected", False)),
        "unread": I(kw.get("unread", 0)),
        "dirty": B(kw.get("dirty", False)),
    }
    # cmux's custom_color, which the board wears as a leading sliver. Optional on
    # purpose: a workspace that is not a worktree has none, and the nil path has
    # to render too — see the `!= nil` note in FINDINGS.md.
    if kw.get("color"):
        d["color"] = S(kw["color"])
    if kw.get("pr"):
        n, status = kw["pr"]
        d["pr"] = O({
            "number": I(n),
            "url": S(f"https://github.com/your-org/main-repo/pull/{n}"),
            "status": S(status),
        })
    if kw.get("progress"):
        v, label = kw["progress"]
        d["progress"] = O({"value": D(v), "label": S(label)})
    return O(d)


# One workspace per affordance, so every chip site has to render.
WORKSPACES = [
    ws("w-wait", "waiting-row", "dev/PROJ-1-wait",
       "phase:waiting feed:pending feedby:%d feedgate:allow" % (NOW + 90), 30, color="#C0392B"),
    ws("w-wait2", "waiting-read", "dev/PROJ-2-read",
       "phase:waiting feed:pending feedby:%d feedgate:read" % (NOW + 40), 60),
    ws("w-dead", "waiting-expired", "dev/PROJ-3-dead",
       "phase:waiting feed:pending feedby:%d" % (NOW - 10), 400),
    ws("w-work", "working-row", "dev/PROJ-4-work",
       "phase:working ci:run sandbox:running", 5, pr=(31001, "open"), dirty=True, color="#1565C0"),
    ws("w-rev", "review-row", "dev/PROJ-5-rev",
       "ci:fail review:changes pr:conflict sandbox:stopped jira:in-review", 900,
       pr=(31002, "open"), progress=(1.0, "plan complete"), dirty=True, color="#196F3D"),
    ws("w-pass", "review-pass", "dev/PROJ-6-pass",
       "ci:pass review:approved pr:draft stack:ready jira:done", 1200,
       pr=(31003, "open"), color="#6A1B9A"),
    ws("w-merged", "merged-row", "dev/PROJ-7-merged", "gone:merged", 7200),
    ws("w-idle", "idle-row", "dev/PROJ-8-idle", "", 99999, color="#7D6608"),
    # planning rows: both sources, so the glyph slot's precedence is covered
    ws("w-planmode", "plan-mode-row", "dev/PROJ-9-plan",
       "phase:working plan:mode", 20, color="#0E6B8C"),
    ws("w-plandeep", "deep-plan-row", "dev/PROJ-10-deep",
       "phase:working plan:deep ci:pass", 45, pr=(31004, "open"), color="#880E4F"),
]

STATE = {
    "workspaces": A(WORKSPACES),
    "workspaceCount": I(len(WORKSPACES)),
    "unreadTotal": I(3),
    "paneCount": I(2),
    "sidebarMode": S("workspaces"),
    "clock": O({
        "epoch": I(NOW),
        "second": I(2),
        "minute": I(13),
        "hour": I(10),
        "time": S("10:13"),
        "date": S("2026-08-13"),
    }),
}


def render(source):
    req = json.dumps({"id": 1, "source": source, "state": STATE}).encode()
    p = subprocess.Popen([CMUX, FLAG], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    p.stdin.write(struct.pack(">I", len(req)) + req)
    p.stdin.flush()
    head = p.stdout.read(4)
    if len(head) < 4:
        p.kill()
        err = p.stderr.read().decode(errors="replace")[:600]
        raise SystemExit(f"no response frame. stderr:\n{err}")
    n = struct.unpack(">I", head)[0]
    body = b""
    while len(body) < n:
        chunk = p.stdout.read(n - len(body))
        if not chunk:
            break
        body += chunk
    p.stdin.close()
    p.kill()
    return json.loads(body)


def walk(node, out, depth=0):
    if not isinstance(node, dict):
        return
    out.append((depth, node))
    for child in node.get("children") or []:
        walk(child, out, depth + 1)
    for m in node.get("modifiers") or []:
        for child in m.get("children") or []:
            walk(child, out, depth + 1)


if __name__ == "__main__":
    src = open(sys.argv[1]).read()
    resp = render(src)
    node = resp.get("node")
    if node is None:
        raise SystemExit("interpreter returned node=null (no supported view)")
    flat = []
    walk(node, flat)
    print(f"nodes: {len(flat)}")
    json.dump(node, open(sys.argv[2], "w"), indent=1)
    print(f"IR written to {sys.argv[2]}")
