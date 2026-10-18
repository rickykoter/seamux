#!/usr/bin/env python3
"""artifacts_probe — the Artifact Log's indexer and store against fixture
transcripts in a throwaway HOME. No real transcripts, db or scratchpads.

A fixture session in a real git checkout (origin on GitHub) writes a
scratchpad note, a doc, source code, a file under ~, an image and a
transcript-dir file; redirects to /tmp through a literal path and through a
variable; commits; and publishes the doc as a claude.ai artifact. A subagent
writes into the same scratchpad, a stray file sits only in the scratchpad,
and deep-plan, lookout and ask stores each hold one record. What is asserted:

  - each write lands as its kind, and source code and ~/.claude/projects do not;
  - each row carries the prompt in flight, system reminders stripped, capped
    at 500 characters, with session and branch; a subagent's row carries the
    human's prompt from the parent transcript;
  - the commit row has its full sha and a GitHub URL from origin, and a
    `git commit -q` is found by a trailing oneline or by HEAD's time;
  - the publish adds a row with its URL and gives the doc's own row the URL;
  - the scratchpad file only a listing finds is indexed, .git skipped;
  - lines that are malformed or in a newer shape cost nothing else;
  - an appended chunk resumes from the cursor and still finds the prompt in
    flight before it; an unchanged transcript is not reread; backfill keeps ids;
  - Keep copies an at-risk file into kept/<workspace>/ keeping its mtime and
    repoints the row, which re-indexing never undoes; it refuses rows outside
    a temp root, missing files, symlinks, directories and files over 50MB;
    keep all reports each refusal;
  - a row files under the session's starting directory even after a cd, a
    symlinked spelling of it finds the same rows, and a git command that only
    mentions commit adds no commit;
  - a kept file written again at its temp path is at risk (and keepable)
    again; keep all leaves artifact rows alone;
  - search goes through FTS5 by prompt word, filters by ws and kind, and
    treats query syntax as text;
  - plan, review and ask rows land keyed by root or cwd;
  - a second index run exits while the lock is held, leaving a marker the
    holder consumes; ~/.claude/crew is 0700;
  - crew-artifacts index and search (text, --ws, --kind, --json) work;
  - /usr/bin/python3 (3.9) runs the indexer too.

    python3 crew/tools/artifacts_probe.py      exit 0 when all hold
"""
import fcntl
import json
import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BOARD = os.path.join(REPO, "crew", "board")
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


def norm_sp(p):
    d, b = os.path.split(p)
    return os.path.join(os.path.realpath(d), b)


def jl(fh, d):
    fh.write(json.dumps(d) + "\n")


with tempfile.TemporaryDirectory(prefix="artifacts-probe-") as t:
    t = os.path.realpath(t)
    home = os.path.join(t, "home")
    faketmp = os.path.join(t, "faketmp")
    scratch_base = os.path.join(faketmp, "claude-501")
    env = dict(os.environ, HOME=home, CREW_SCRATCH_BASE=scratch_base,
               CREW_TEMP_ROOTS=faketmp + "/:/private/tmp/",
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    env.pop("CREW_DURABLE_DIR", None)
    os.environ.clear()
    os.environ.update(env)

    ws = os.path.join(home, "code", "shop")
    os.makedirs(os.path.join(ws, "docs"))
    os.makedirs(os.path.join(home, "notes"))

    def git(*a):
        return subprocess.run(["git", "-C", ws] + list(a), capture_output=True, text=True,
                              check=True).stdout.strip()

    git("init", "-q", "-b", "main")
    git("config", "user.email", "probe@example.com")
    git("config", "user.name", "probe")
    open(os.path.join(ws, "docs", "guide.md"), "w").write("# Guide\n")
    git("add", ".")
    git("commit", "-q", "-m", "Add guide")
    sha = git("rev-parse", "HEAD")
    git("remote", "add", "origin", "git@github.com:octo/shop.git")

    proj = "-probe-code-shop"
    sess = "11111111-2222-3333-4444-555555555555"
    pdir = os.path.join(home, ".claude", "projects", proj)
    os.makedirs(os.path.join(pdir, sess, "subagents"))
    sp = os.path.join(scratch_base, proj, sess, "scratchpad")
    os.makedirs(os.path.join(sp, "repo", ".git"))
    open(os.path.join(sp, "notes.md"), "w").write("notes")
    open(os.path.join(sp, "stray.py"), "w").write("print(1)")
    open(os.path.join(sp, "repo", ".git", "HEAD"), "w").write("ref")
    tr = os.path.join(pdir, sess + ".jsonl")

    base = {"cwd": ws, "sessionId": sess, "gitBranch": "main"}

    def user(ts, text):
        return dict(base, type="user", timestamp=ts, message={"role": "user", "content": text})

    def use(ts, uid, name, inp):
        return dict(base, type="assistant", timestamp=ts, message={
            "role": "assistant", "content": [{"type": "tool_use", "id": uid, "name": name,
                                              "input": inp}]})

    def result(ts, uid, tur, text="ok"):
        return dict(base, type="user", timestamp=ts, toolUseResult=tur, message={
            "role": "user", "content": [{"type": "tool_result", "tool_use_id": uid,
                                         "content": text}]})

    P1 = "Draft the shop guide and keep scratch notes"
    long_tail = " word" * 200
    with open(tr, "w") as fh:
        jl(fh, user("2020-01-01T10:00:00.000Z",
                    "<system-reminder>secret context here</system-reminder>" + P1 + long_tail))
        jl(fh, use("2020-01-01T10:00:01.000Z", "u1", "Write",
                   {"file_path": os.path.join(sp, "notes.md"), "content": "x"}))
        jl(fh, use("2020-01-01T10:00:02.000Z", "u2", "Write",
                   {"file_path": os.path.join(ws, "docs", "guide.md"), "content": "x"}))
        jl(fh, use("2020-01-01T10:00:03.000Z", "u3", "Write",
                   {"file_path": os.path.join(ws, "src", "app.py"), "content": "x"}))
        jl(fh, use("2020-01-01T10:00:04.000Z", "u4", "Write",
                   {"file_path": os.path.join(home, "notes", "todo.txt"), "content": "x"}))
        jl(fh, use("2020-01-01T10:00:05.000Z", "u5", "Write",
                   {"file_path": os.path.join(pdir, "memo.md"), "content": "x"}))
        jl(fh, use("2020-01-01T10:00:06.000Z", "u6", "Write",
                   {"file_path": os.path.join(ws, "shot.png"), "content": "x"}))
        jl(fh, use("2020-01-01T10:00:07.000Z", "u7", "Bash",
                   {"command": "echo hi > /tmp/artprobe-out.log; echo x > $S/hidden.txt"}))
        fh.write("{not json at all\n")
        jl(fh, dict(base, type="user", timestamp="2020-01-01T10:00:08.000Z",
                    toolUseResult=["a", "list"], message={"content": 42}))
        jl(fh, dict(base, type="assistant", timestamp="2020-01-01T10:00:09.000Z",
                    message={"content": [{"type": "tool_use", "id": "u8", "name": "Write",
                                          "input": "a string where a dict was"}]}))
        jl(fh, use("2020-01-01T10:00:10.000Z", "u9", "Bash",
                   {"command": "git commit -m 'Add guide'"}))
        jl(fh, result("2020-01-01T10:00:11.000Z", "u9",
                      {"stdout": "[main %s] Add guide\n 1 file changed, 1 insertion(+)\n" % sha[:7],
                       "stderr": ""}))
        jl(fh, user("2099-01-01T10:00:00.000Z", "Publish the guide as an artifact"))
        jl(fh, use("2099-01-01T10:00:01.000Z", "u10", "Artifact",
                   {"file_path": os.path.join(ws, "docs", "guide.md"), "title": "Shop guide"}))
        jl(fh, result("2099-01-01T10:00:02.000Z", "u10",
                      {"url": "https://claude.ai/code/artifact/abc-123",
                       "path": os.path.join(ws, "docs", "guide.md"), "title": "Shop guide"}))
    with open(os.path.join(pdir, sess, "subagents", "agent-a1.jsonl"), "w") as fh:
        jl(fh, dict(user("2020-01-01T10:05:00.000Z", "You are a subagent: write the summary"),
                    isSidechain=True))
        jl(fh, use("2020-01-01T10:05:01.000Z", "s1", "Write",
                   {"file_path": os.path.join(sp, "summary.txt"), "content": "x"}))

    dp = os.path.join(home, ".claude", "deep-plan", "state")
    os.makedirs(dp)
    json.dump({"slug": "shop-guide", "root": ws, "session": sess,
               "log": [{"at": 1600000000000, "what": "rendered"},
                       {"at": 1600000500000, "what": "graded"}]},
              open(os.path.join(dp, "shop-guide.json"), "w"))
    plans = os.path.join(home, ".claude", "plans")
    os.makedirs(os.path.join(plans, "reviews"))
    os.makedirs(os.path.join(plans, "asks"))
    open(os.path.join(plans, "shop-guide.md"), "w").write("# Write the shop guide\n")
    json.dump({"id": "shop-inc1", "title": "shop · increment 1", "createdAt": "2020-02-01T00:00:00.000Z",
               "source": {"root": ws, "branch": "main"}},
              open(os.path.join(plans, "reviews", "shop-inc1.json"), "w"))
    json.dump({"rows": []}, open(os.path.join(plans, "reviews", "shop-inc1.rows.json"), "w"))
    json.dump({"cwd": ws, "created": "2020-03-01T00:00:00.000Z", "header": "Scope",
               "question": "Which pages?"}, open(os.path.join(plans, "asks", "a1.json"), "w"))

    sys.path.insert(0, BOARD)
    import artifacts as A

    print("index a fixture session")
    A.index()
    rows = A.search(limit=1000)
    by = {}
    for r in rows:
        by.setdefault(r["kind"], []).append(r)

    def find(kind, tail):
        return next((r for r in by.get(kind, []) if r["locator"].endswith(tail)), None)

    notes = find("temp", "scratchpad/notes.md")
    guide = find("doc", "docs/guide.md")
    check("a scratchpad Write is temp", notes, [r["locator"] for r in rows])
    check("a .md in the workspace is a doc", guide)
    check("a file elsewhere under ~ is a file", find("file", "notes/todo.txt"))
    check("an image is an image", find("image", "shot.png"))
    check("a literal /tmp redirect is temp", find("temp", "/tmp/artprobe-out.log"))
    check("source code and ~/.claude/projects are skipped",
          not any(r["locator"].endswith(("app.py", "memo.md")) for r in rows))
    check("a variable redirect is not guessed at",
          not any(r["locator"].endswith("hidden.txt") for r in rows))
    p = (notes or {}).get("prompt", "")
    check("the prompt in flight rides along, reminder stripped",
          p.startswith(P1) and "secret" not in p, repr(p[:80]))
    check("the prompt is capped at 500 characters", len(p) == 500, len(p))
    check("session and branch ride along",
          notes and notes["session_id"] == sess and notes["branch"] == "main")
    check("ws is the session cwd and created_at the line's time",
          notes and notes["ws"] == ws and notes["created_at"] == "2020-01-01T10:00:01.000Z")
    c = find("commit", sha[:7])
    check("a commit carries its full sha", c and c["sha"] == sha and c["title"] == "Add guide")
    check("a commit's URL comes from origin",
          c and c["url"] == "https://github.com/octo/shop/commit/" + sha, (c or {}).get("url"))
    art = find("artifact", "abc-123")
    check("a publish is a row with its URL and title",
          art and art["title"] == "Shop guide" and art["prompt"] == "Publish the guide as an artifact")
    check("the published file's own row gains the URL",
          guide and guide["url"] == "https://claude.ai/code/artifact/abc-123")
    stray = find("temp", "scratchpad/stray.py")
    check("a file only the scratchpad listing knows is indexed", stray)
    check("a listed file takes the prompt in flight at its birth",
          stray and stray["prompt"].startswith(P1), (stray or {}).get("prompt"))
    check("a fixture repo's .git is not listed", not any("/.git/" in r["locator"] for r in rows))
    sub = find("temp", "scratchpad/summary.txt")
    check("a subagent's write carries the human's prompt from the parent",
          sub and sub["prompt"].startswith(P1), (sub or {}).get("prompt"))
    check("bad lines cost nothing else", len(by.get("temp", [])) >= 4 and guide)
    check("a plan row is keyed by its root",
          find("plan", "shop-guide") and find("plan", "shop-guide")["ws"] == ws
          and find("plan", "shop-guide")["title"] == "Write the shop guide")
    rv = find("review", "shop-inc1")
    check("a review row is keyed by source.root; sidecar json is not a review",
          rv and rv["ws"] == ws and len(by.get("review", [])) == 1)
    ask = find("ask", "a1")
    check("an ask row is keyed by its cwd", ask and ask["title"] == "Scope: Which pages?")
    mode = stat.S_IMODE(os.stat(os.path.join(home, ".claude", "crew")).st_mode)
    check("~/.claude/crew is 0700", mode == 0o700, oct(mode))

    print("resume, reread nothing unchanged, backfill")
    n_before = len(rows)
    ids = {r["locator"]: r["id"] for r in rows}
    with open(tr, "a") as fh:
        jl(fh, use("2099-01-01T11:00:00.000Z", "u11", "Write",
                   {"file_path": os.path.join(ws, "docs", "later.md"), "content": "x"}))
    A.index()
    later = next((r for r in A.search(kind="doc") if r["locator"].endswith("later.md")), None)
    check("an appended chunk finds the prompt in flight before its offset",
          later and later["prompt"] == "Publish the guide as an artifact", (later or {}).get("prompt"))
    db = A.connect()
    cur = db.execute("SELECT offset, size FROM cursors WHERE transcript = ?", (tr,)).fetchone()
    db.close()
    check("the cursor sits at the end of the transcript",
          cur and cur["offset"] == cur["size"] == os.path.getsize(tr))
    check("an unchanged index run reads nothing, stores included",
          A.index() == 0 and len(A.search(limit=1000)) == n_before + 1)
    A.backfill()
    after = A.search(limit=1000)
    check("backfill keeps every row and id",
          len(after) == n_before + 1 and all(ids[r["locator"]] == r["id"]
                                             for r in after if r["locator"] in ids))

    print("quiet commits")
    import time as _t
    now = _t.strftime("%Y-%m-%dT%H:%M:%S.000Z", _t.gmtime())
    open(os.path.join(ws, "docs", "q1.md"), "w").write("q1")
    git("add", ".")
    git("commit", "-q", "-m", "Quiet with oneline")
    one = git("log", "--oneline", "-1")
    open(os.path.join(ws, "docs", "q2.md"), "w").write("q2")
    git("add", ".")
    git("commit", "-q", "-m", "Quiet and silent")
    with open(tr, "a") as fh:
        jl(fh, use(now, "u20", "Bash", {"command": "git add . && git commit -q -m x && git log --oneline -1"}))
        jl(fh, result(now, "u20", {"stdout": one + "\n", "stderr": ""}))
        jl(fh, use(now, "u21", "Bash", {"command": "git -C . commit -q -F -"}))
        jl(fh, result(now, "u21", {"stdout": "", "stderr": ""}))
    A.index()
    titles = [r["title"] for r in A.search(kind="commit")]
    check("a -q commit followed by git log --oneline is a commit row", "Quiet with oneline" in titles, titles)
    check("a silent -q commit is found by HEAD's time", "Quiet and silent" in titles, titles)
    check("one commit is one row however git abbreviated it",
          all(len(r["locator"]) == 7 for r in A.search(kind="commit")))

    print("workspace keys and commit matching")
    sub_dir = os.path.join(ws, "docs")
    link = os.path.join(t, "shop-link")
    os.symlink(ws, link)
    with open(tr, "a") as fh:
        # A Bash cd left the session in docs/: the row still files under ws.
        jl(fh, dict(use(now, "u30", "Write", {"file_path": os.path.join(sp, "after-cd.txt"), "content": "x"}),
                    cwd=sub_dir))
        # A git command that only mentions commit is not a commit, and a sha
        # line in its output is not this session's commit.
        jl(fh, use(now, "u31", "Bash", {"command": "git log --grep commit --oneline -1"}))
        jl(fh, result(now, "u31", {"stdout": git("log", "--oneline", "-1", "HEAD~2") + "\n", "stderr": ""}))
        jl(fh, use(now, "u32", "Bash", {"command": "git show HEAD~2 --oneline -s && echo commit"}))
        jl(fh, result(now, "u32", {"stdout": git("log", "--oneline", "-1", "HEAD~2") + "\n", "stderr": ""}))
    A.index()
    ac = next((r for r in A.search(limit=2000) if r["locator"].endswith("after-cd.txt")), None)
    check("a row files under the session's starting directory after a cd", ac and ac["ws"] == ws, (ac or {}).get("ws"))
    check("a ws spelled through a symlink finds the same rows",
          ac and any(r["id"] == ac["id"] for r in A.search(ws=link + "/")))
    check("a git command that only mentions commit adds no commit row",
          sorted(r["title"] for r in A.search(kind="commit")) == ["Add guide", "Quiet and silent", "Quiet with oneline"],
          [r["title"] for r in A.search(kind="commit")])

    print("search")
    hits = A.search("scratch notes")
    check("FTS finds rows by a word in their prompt", any(r["locator"].endswith("notes.md") for r in hits))
    check("search filters by ws", A.search("guide", ws="/nowhere") == [] and A.search("guide", ws=ws))
    check("search filters by kind", all(r["kind"] == "commit" for r in A.search("guide", kind="commit"))
          and A.search("guide", kind="commit"))
    try:
        A.search('"oops* OR (NEAR')
        ok = True
    except Exception as e:
        ok = False
        print("       ", e)
    check("query syntax is treated as text", ok)
    check("workspaces() lists the fixture ws", any(w["ws"] == ws for w in A.workspaces()))
    check("row(id) returns that row", A.row(after[0]["id"])["locator"] == after[0]["locator"])

    print("keep")
    notes = next(r for r in A.search(kind="temp") if r["locator"].endswith("scratchpad/notes.md"))
    src = notes["path"]
    os.utime(src, (1600000000, 1600000000))
    res = A.keep(notes["id"])
    k = A.row(notes["id"])
    check("keep copies into kept/<workspace>/ and repoints the row",
          res.get("ok") and k["path"].startswith(os.path.join(home, ".claude", "crew", "kept", "shop-"))
          and k["was_path"] == src and k["kept_at"] and open(k["path"]).read() == "notes", res)
    check("keep preserves the file's mtime", res.get("ok") and int(os.path.getmtime(k["path"])) == 1600000000)
    check("a kept copy sits in a 0700 directory",
          stat.S_IMODE(os.stat(os.path.dirname(k["path"])).st_mode) == 0o700)
    os.unlink(src)
    A.backfill()
    k2 = A.row(notes["id"])
    check("re-indexing never moves a kept row back to its temp path", k2["path"] == k["path"] and k2["kept_at"])
    check("keeping twice is refused", A.keep(notes["id"]).get("why") == "already kept")
    todo = next(r for r in A.search(kind="file") if r["locator"].endswith("todo.txt"))
    check("a row outside a temp root is refused", A.keep(todo["id"]).get("why") == "not in a temp directory")
    sub = next(r for r in A.search(kind="temp") if r["locator"].endswith("summary.txt"))
    check("a missing file is refused", A.keep(sub["id"]).get("why") == "the file is gone")
    big = os.path.join(sp, "big.bin")
    with open(big, "wb") as fh:
        fh.truncate(51 * 1024 * 1024)
    os.makedirs(os.path.join(sp, "adir"))
    os.symlink(os.path.join(home, "notes", "todo.txt") if os.path.exists(os.path.join(home, "notes", "todo.txt"))
               else tr, os.path.join(sp, "link.txt"))
    db = A.connect()
    db.execute("BEGIN IMMEDIATE")
    mk = lambda p: dict(dict.fromkeys(A.FIELDS, ""), ws=ws, kind="temp", locator=p, path=p, title=os.path.basename(p))
    A.write_rows(db, [mk(big), mk(os.path.join(sp, "adir")), mk(os.path.join(sp, "link.txt"))])
    db.execute("COMMIT")
    db.close()
    rid = {r["title"]: r["id"] for r in A.search(ws=ws, kind="temp")}
    check("a file over 50MB is refused", A.keep(rid["big.bin"]).get("why") == "over 50MB")
    check("a directory is refused", A.keep(rid["adir"]).get("why") == "a directory")
    check("a symlink is refused", A.keep(rid["link.txt"]).get("why") == "a symlink")
    allres = A.keep_all(ws)
    kept_titles = [A.row(x["id"])["title"] for x in allres if x["ok"]]
    whys = sorted(x.get("why") for x in allres if not x["ok"])
    check("keep all keeps every at-risk row and reports each refusal",
          "stray.py" in kept_titles and whys == ["a directory", "a symlink", "over 50MB"], (kept_titles, whys))
    check("keep all skips rows already kept or gone",
          all(A.row(x["id"])["title"] not in ("notes.md", "summary.txt") for x in allres))

    print("keep, again")
    re_src = os.path.join(sp, "again.txt")
    open(re_src, "w").write("v1")
    with open(tr, "a") as fh:            # the turn that made it grows the transcript
        jl(fh, dict(base, type="assistant", timestamp=now, message={"content": [{"type": "text", "text": "ok"}]}))
    A.index()
    ag = next(r for r in A.search(limit=2000) if r["locator"].endswith("again.txt"))
    first = A.keep(ag["id"])
    _t.sleep(1.1)
    open(re_src, "w").write("v2")
    with open(tr, "a") as fh:
        later_ts = _t.strftime("%Y-%m-%dT%H:%M:%S.000Z", _t.gmtime(_t.time() + 2))
        jl(fh, use(later_ts, "u40", "Write", {"file_path": re_src, "content": "v2"}))
    A.index()
    ag2 = A.row(ag["id"])
    check("a kept file written again at its temp path is at risk again",
          first.get("ok") and ag2["path"] == norm_sp(re_src) and not ag2["kept_at"] and os.path.exists(first["path"]),
          (ag2["path"], ag2["kept_at"]))
    check("...and can be kept again", A.keep(ag["id"]).get("ok"))
    db = A.connect()
    db.execute("BEGIN IMMEDIATE")
    art_file = os.path.join(sp, "published.html")
    open(art_file, "w").write("<p>x</p>")
    A.write_rows(db, [dict(dict.fromkeys(A.FIELDS, ""), ws=ws, kind="artifact", locator="https://claude.ai/artifact/z",
                           path=art_file, url="https://claude.ai/artifact/z", title="published")])
    db.execute("COMMIT")
    db.close()
    zr = next(r for r in A.search(kind="artifact") if r["locator"].endswith("/z"))
    check("keep all leaves artifact rows alone", all(x["id"] != zr["id"] for x in A.keep_all(ws)))

    print("lock and 3.9")
    lk = open(A.LOCK, "a")
    fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        A.index()
        busy = False
    except A.Busy:
        busy = True
    lk.close()
    check("a second index run exits while the lock is held", busy)
    check("and leaves a marker asking the holder to go round again", os.path.exists(A.AGAIN))
    A.index()
    check("the next run consumes the marker", not os.path.exists(A.AGAIN))
    cli = os.path.join(REPO, "crew", "bin", "crew-artifacts")
    p = subprocess.run([sys.executable, cli, "search", "scratch", "notes", "--ws", ws, "--json"],
                       capture_output=True, text=True, env=env)
    try:
        got = json.loads(p.stdout)
    except ValueError:
        got = None
    check("crew-artifacts search --ws --json returns the rows",
          got and any(r["locator"].endswith("notes.md") for r in got), p.stderr[-300:])
    p = subprocess.run([sys.executable, cli, "search", "guide", "--kind", "commit"],
                       capture_output=True, text=True, env=env)
    check("crew-artifacts search prints a row with its prompt",
          p.returncode == 0 and "Add guide" in p.stdout and "> " in p.stdout, p.stdout[-300:])
    p = subprocess.run([sys.executable, cli, "index"], capture_output=True, text=True, env=env)
    check("crew-artifacts index runs", p.returncode == 0 and "indexed" in p.stdout, p.stderr[-300:])
    sys39 = "/usr/bin/python3"
    if os.path.exists(sys39):
        with open(tr, "a") as fh:
            jl(fh, use("2099-01-01T12:00:00.000Z", "u12", "Write",
                       {"file_path": os.path.join(ws, "docs", "py39.md"), "content": "x"}))
        p = subprocess.run([sys39, os.path.join(BOARD, "artifacts.py"), "index"],
                           capture_output=True, text=True, env=env)
        check("/usr/bin/python3 runs the indexer",
              p.returncode == 0 and any(r["locator"].endswith("py39.md") for r in A.search(kind="doc")),
              p.stderr[-400:])
    else:
        print("  skip /usr/bin/python3 is not on this machine")

print(f"\n{sum(results)}/{len(results)} hold")
sys.exit(0 if all(results) else 1)
