#!/usr/bin/env python3
"""board-preview — the crew board from THIS checkout, on a fixed cast, at Dock width.

    python3 docs/demo/board-preview.py                 write the page, print its path
    python3 docs/demo/board-preview.py --open          ...and open it in a Dock browser tab
    python3 docs/demo/board-preview.py --audit S       measure the page in surface S
    python3 docs/demo/board-preview.py --shot S PATH   screenshot surface S to PATH
    python3 docs/demo/board-preview.py --open --listen 8791
                        open it wired to a stand-in server that prints each click
    python3 docs/demo/board-preview.py --push S [--port 8791]
                        push the cast again, the way the collector does

For design work on board.html / render.js / intent.js. Unlike board-demo.py,
which pushes into the LIVE board through the installed collector, this touches
nothing installed: it inlines the working tree's three files into one static
page with a cast that covers every tier, every signal colour the collector
sends, a reply window, the current workspace, quiet rows and both kinds of
family. Clicks go nowhere (port 0) unless --listen is given; the red flash on
a pressed button is the fetch failing, which is expected.

--listen PORT stands in for crew-board-intent on 127.0.0.1:PORT: it answers
every /do with ok and prints the action, row id and argument, so you can see
exactly what a click would have asked the real server for. It runs until ^C.
--push S re-sends render.js, the cast and intent.js into surface S with
`cmux browser addscript`, as crew-board does on every update -- which is how to
check that something survives a push (an opened family child, say).

--audit runs in the page and reports, against what the board promises:
  - every visible piece of text at 4.5:1 or better on the ground behind it
  - every button at least 28px tall, every footer link at least 24px
  - every quiet row, and every family child's header, one line tall
It cancels the rows' entry animations first: WebKit pauses Web Animations in a
Dock tab that is not showing, which leaves fresh rows at opacity 0.
Exit status is non-zero when anything fails.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD = os.path.join(HERE, "..", "..", "crew", "board")
OUT = os.path.join(tempfile.gettempdir(), "crew-board-preview", "index.html")

NOW = int(time.time())


def row(**o):
    o.setdefault("said", "")
    o.setdefault("chips", [])
    o.setdefault("meta", "")
    o.setdefault("frac", None)
    return o


def sig(t, c, h, a=None, x=None):
    e = {"t": t, "c": c, "h": h}
    if a:
        e["a"] = a
    if x is not None:
        e["x"] = x
    return e


CAST = [
    row(id="payments-idem", kind="attend", name="payments-idem", badge="asked you",
        ref="w1", said="Reuse the idempotency table, or a new ledger? The {{plan}} carries the trade-off.",
        branch="dev/payments-idem", cost=1.14, chips=["jump"], color="#7fbbb3",
        feedby=NOW + 600,
        signals=[sig("allow", "#4ADE80", "Approve what the agent asked for", "feed-allow"),
                 sig("deny", "#F97066", "Refuse it; the agent keeps waiting", "feed-deny")]),
    row(id="checkout-flow", kind="attend", name="checkout-flow", badge="gate shut",
        slug="checkout-flow", ref="w2", selected=True,
        said="{{Coupon at capture}} needs your go-ahead. Increment 2 is done and its checks passed.",
        frac=0.5, branch="dev/checkout-flow", dirty=True, pr="#142", pr_state="open",
        cost=4.2, chips=["go 3", "diff", "jump"], meta="2/4 increments", color="#dfa000",
        signals=[sig("● CI", "#F5A524", "Open the running checks", "checks"),
                 sig("✓ approved", "#4ADE80", "A reviewer approved this PR")]),
    row(id="billing-revamp", kind="running", name="billing-revamp", badge="working",
        slug="billing-revamp", ref="w3", said="{{Split the ledger}} in progress.", frac=0.33,
        branch="dev/billing-revamp", chips=["diff", "jump"], meta="1/3 increments",
        family="billing-revamp", famrole="parent", famtier="attend", famkid=False,
        color="#d699b6"),
    row(id="billing-ledger", kind="attend", name="billing-ledger", badge="gate shut",
        slug="billing-ledger", ref="w4", said="{{Ledger schema}} needs your go-ahead.",
        frac=0.25, branch="dev/billing-ledger", chips=["go 2", "diff", "jump"],
        meta="1/4 increments", family="billing-revamp", famrole="child", famtier="attend",
        famkid=True, color="#e69875"),
    row(id="billing-invoices", kind="running", name="billing-invoices", badge="working",
        slug="billing-invoices", ref="w5", said="Mid-turn.", branch="dev/billing-invoices",
        dirty=True, chips=["diff", "jump"], meta="0/2 increments", family="billing-revamp",
        famrole="child", famtier="attend", famkid=True, color="#83c092"),
    row(id="billing-emails", kind="quiet", name="billing-emails", badge="plan idle",
        slug="billing-emails", ref="w6", frac=0, branch="dev/billing-emails",
        chips=["jump"], meta="0/3 increments", family="billing-revamp", famrole="child",
        famtier="attend", famkid=True),
    row(id="rate-limits", kind="wilt", name="rate-limits", badge="ci failed", ref="w7",
        said="Checks are red on `dev/rate-limits`.", frac=0.75, branch="dev/rate-limits",
        pr="#139", pr_state="open", cost=11.87, chips=["checks", "diff", "jump"],
        meta="3/4 increments · contract-aware-interrogation-rate-limits", color="#d699b6", issue="#87",
        signals=[sig("↻ changes", "#F97066", "A reviewer asked for changes"),
                 sig("⚠ conflicts", "#F97066", "This branch conflicts with its base"),
                 sig("⊙ PROJ-1039", "#A78BFA", "Jira: In Review — open PROJ-1039", "jira", "PROJ-1039")]),
    row(id="search-index", kind="running", name="search-index", badge="working", ref="w8",
        said="{{Tokenizer}} in progress.", branch="dev/PROJ-2210-search-index-tokenizer-rewrite",
        dirty=True, cost=0.62, chips=["diff", "jump"], meta="2/4 increments",
        color="#83c092",
        signals=[sig("▣ sandbox", "#60A5FA", "Running in a Docker sandbox — click to stop it", "sandbox-down"),
                 sig("draft", "#859289", "The PR is still a draft"),
                 sig("⇣ parent open", "#F5A524", "Stacked on a branch that has not merged yet")]),
    row(id="login-copy", kind="done", name="login-copy", badge="merged", ref="w9",
        said="Merged. The worktree can be reclaimed.", frac=1, branch="dev/login-copy",
        pr="#137", cost=2.05, chips=["reclaim", "jump"], meta="4/4 increments",
        color="#e69875",
        signals=[sig("▢ sandbox", "#8E8E93", "Sandbox is stopped — click to start it", "sandbox-up")]),
    row(id="docs-site", kind="quiet", name="docs-site — zsh", badge="", ref="w10",
        branch="dev/docs-site", chips=["jump"]),
    row(id="spike-cache", kind="quiet", name="spike-cache — ~/code/seamux.worktrees/spike-cache",
        badge="uncommitted", ref="w11", branch="dev/spike-cache", dirty=True,
        chips=["jump", "diff"], color="#7fbbb3"),
    row(id="api-docs", kind="quiet", name="api-docs", badge="pr open", ref="w12",
        branch="dev/api-docs", pr="#151", pr_state="open", cost=1.3, chips=["jump", "pr"]),
    row(id="search-v2-api", kind="quiet", name="search-v2-api", badge="plan idle",
        slug="search-v2-api", ref="w13", frac=0, family="search-v2", famrole="child",
        famtier="quiet", famkid=True, famlabel="search-v2", chips=["jump"]),
    row(id="search-v2-ui", kind="quiet", name="search-v2-ui", badge="plan idle",
        slug="search-v2-ui", ref="w14", frac=0, family="search-v2", famrole="child",
        famtier="quiet", famkid=True, chips=["jump"]),
]

SNAP = {
    "rows": CAST, "quiet": "", "src": "preview", "stamp": time.strftime("%H:%M:%S"),
    "stale": False,
    "news": {"hours": 5, "lede": "{{checkout-flow}} is waiting on a gate.",
             "items": [{"tier": "attend", "text": "{{checkout-flow}} is waiting on a gate."},
                       {"tier": "wilt", "text": "{{rate-limits}} checks went red."},
                       {"tier": "done", "text": "{{login-copy}} merged."}]},
}

# The audit. One expression, so `cmux browser eval` can run it whichever world
# it evaluates in -- the page's own functions may not be visible from there.
AUDIT = r"""(() => {
  document.querySelectorAll("#rows *").forEach((el) => el.getAnimations && el.getAnimations().forEach((a) => a.cancel()));
  const rgb = (s) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(s); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
  const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ground = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c[3] > 0.5) return c; } return [255, 255, 255, 1]; };
  const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && el.className.baseVal === undefined ? "." + String(el.className).trim().split(/\s+/).join(".") : "");
  const fails = [], seen = {};
  let texts = 0, minRatio = 99;
  document.querySelectorAll("body *").forEach((el) => {
    if (el.closest("svg")) return;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) return;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(el).visibility === "hidden") return;
    texts++;
    const fg = rgb(getComputedStyle(el).color), bg = ground(el);
    if (!fg) { fails.push("unreadable colour on " + name(el)); return; }
    const a = fg[3] * opacity(el);
    const mix = fg.slice(0, 3).map((x, i) => x * a + bg[i] * (1 - a));
    const r = (Math.max(lum(mix), lum(bg)) + 0.05) / (Math.min(lum(mix), lum(bg)) + 0.05);
    minRatio = Math.min(minRatio, r);
    const key = name(el);
    if (r < 4.5 && !seen[key]) { seen[key] = 1; fails.push("contrast " + r.toFixed(2) + ":1 on " + key + " \"" + el.textContent.trim().slice(0, 24) + "\""); }
  });
  // Only what is showing: a closed family child carries its whole card, hidden.
  const h = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length)
    .map((e) => [e, e.getBoundingClientRect().height]);
  const chips = h("#rows .chip"), links = h("#rows .foot .branch, #rows .foot .pr, #rows .foot .issue");
  chips.forEach(([e, v]) => { if (v < 28) fails.push("button " + v.toFixed(1) + "px: " + e.textContent.trim()); });
  links.forEach(([e, v]) => { if (v < 24) fails.push("footer link " + v.toFixed(1) + "px: " + e.textContent.trim()); });
  // A quiet row, and a family child's header, are each one line: no taller
  // than their floor (22px, 36px) or their tallest item, whichever is more.
  const quiet = h("#rows .row.quiet:not(.kid) > .top").concat(h("#rows .kidhd"));
  quiet.forEach(([e, v]) => { const tallest = Math.max(...[...e.children].map((c) => c.getBoundingClientRect().height)); if (v > Math.max(e.classList.contains("kidhd") ? 36 : 22, tallest) + 1) fails.push((e.classList.contains("kidhd") ? "child header" : "quiet row") + " wraps (" + v.toFixed(1) + "px): " + e.textContent.trim().slice(0, 24)); });
  return JSON.stringify({ width: document.documentElement.clientWidth, texts, minRatio: +minRatio.toFixed(2),
    buttons: chips.length, minButton: Math.min(...chips.map(([, v]) => v)),
    links: links.length, minLink: Math.min(...links.map(([, v]) => v)),
    oneLiners: quiet.length, fails });
})()"""


def build(path=OUT, port=0):
    def read(name):
        with open(os.path.join(BOARD, name), encoding="utf8") as fh:
            return fh.read()

    page = read("board.html")
    # </script> inside the data cannot close the tag: json.dumps leaves "/" alone.
    data = json.dumps(SNAP, ensure_ascii=False).replace("</", "<\\/")
    inject = ("<script>\n" + read("render.js") + "\n" + read("intent.js") +
              "\nvar SNAP = " + data + ";\n__boardRender(SNAP);\n"
              "__boardIntent({port: %d, token: \"preview\"});\n</script>\n" % port)
    page = page.replace("</body>", inject + "</body>")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8") as fh:
        fh.write(page)
    return path


def cmux(*args):
    return subprocess.run(["cmux", *args], capture_output=True, text=True, timeout=30)


def audit(surface):
    r = cmux("browser", surface, "eval", AUDIT)
    out = r.stdout.strip()
    try:
        rep = json.loads(json.loads(out) if out.startswith('"') else out)
    except ValueError:
        print(r.stdout + r.stderr)
        return 2
    print("width %(width)spx · %(texts)s text runs, lowest %(minRatio)s:1 · "
          "%(buttons)s buttons, shortest %(minButton)spx · "
          "%(links)s footer links, shortest %(minLink)spx · %(oneLiners)s quiet rows and child headers" % rep)
    for f in rep["fails"]:
        print("  FAIL " + f)
    print("audit: " + ("clean" if not rep["fails"] else "%d problem(s)" % len(rep["fails"])))
    return 1 if rep["fails"] else 0


def push(surface, port):
    """One update, built the way crew-board's push_state builds it."""
    def read(name):
        with open(os.path.join(BOARD, name), encoding="utf8") as fh:
            return fh.read()

    script = (read("render.js") + "\n__boardRender(" + json.dumps(SNAP) + ");\n" +
              read("intent.js") + "\n__boardIntent(" +
              json.dumps({"port": port, "token": "preview"}) + ");")
    r = cmux("browser", "--surface", surface, "addscript", "--script", script)
    print(r.stdout.strip() or r.stderr.strip())
    return r.returncode


def listen(port):
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs, urlparse

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            print("click  a=%-10s r=%-18s x=%s" % (q.get("a", ""), q.get("r", ""), q.get("x", "")),
                  flush=True)
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    print("listening on 127.0.0.1:%d -- every click prints here" % port, flush=True)
    try:
        HTTPServer(("127.0.0.1", port), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def arg(argv, flag, default=None):
    return argv[argv.index(flag) + 1] if flag in argv else default


def main(argv):
    if "--push" in argv:
        return push(arg(argv, "--push"), int(arg(argv, "--port", 0)))
    if "--audit" in argv:
        return audit(argv[argv.index("--audit") + 1])
    if "--shot" in argv:
        i = argv.index("--shot")
        cmux("browser", argv[i + 1], "eval", AUDIT)       # settles the entry animations
        r = cmux("browser", argv[i + 1], "screenshot", "--out", argv[i + 2])
        print(r.stdout.strip() or r.stderr.strip())
        return r.returncode
    port = int(arg(argv, "--listen", 0))
    path = build(port=port)
    print(path)
    if "--open" in argv:
        r = cmux("new-surface", "--type", "browser", "--placement", "dock",
                 "--url", "file://" + path)
        print(r.stdout.strip() or r.stderr.strip(), flush=True)
    return listen(port) if port else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
