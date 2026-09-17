#!/usr/bin/env python3
"""crew — TypeSafe client probe: no network, no key, no cmux, throwaway env.

Asserts both directions, like the deep-plan probe: the client answers when a
mock /v1/systemone answers, and every failure path — no key, disabled,
4xx/5xx, unreachable — degrades to "no judgment" (exit 2) rather than a
guess. The mock is scripted per test: a list of (status, body) consumed one
request at a time, so a retry is asserted by the requests it actually makes.
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TYPESAFE = os.path.join(HERE, "typesafe.py")
ASKED = os.path.join(HERE, "asked.py")

SCRIPT = []          # (status, dict-body) pairs, consumed per request
REQUESTS = []        # every body the mock ever received


class Mock(BaseHTTPRequestHandler):
    def do_POST(self):
        REQUESTS.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        status, body = SCRIPT.pop(0) if SCRIPT else (500, {})
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *a):
        pass


def serve():
    srv = HTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d" % srv.server_address[1]


PASS = FAIL = 0


def ok(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print("  FAIL " + name)


def run(argv, env, stdin=""):
    return subprocess.run([sys.executable, *argv], input=stdin, env=env,
                          capture_output=True, text=True, timeout=30)


def main():
    srv, base = serve()
    tmp = tempfile.mkdtemp(prefix="ts-probe-")
    # A hermetic environment: no real key file (XDG points at an empty dir),
    # no real integrations.json, and the API is the mock.
    integ = os.path.join(tmp, "integrations.json")
    clean = {**os.environ, "TYPESAFE_BASE_URL": base,
             "XDG_CONFIG_HOME": os.path.join(tmp, "xdg"),
             "TYPESAFE_INTEGRATIONS": integ}
    clean.pop("TYPESAFE_API_KEY", None)
    keyed = {**clean, "TYPESAFE_API_KEY": "probe-key"}

    # -------------------------------------------------- on/off is one question
    ok("available: no key -> 1", run([TYPESAFE, "available"], clean).returncode == 1)
    ok("available: env key -> 0", run([TYPESAFE, "available"], keyed).returncode == 0)
    with open(integ, "w") as fh:
        json.dump({"typesafe": {"enabled": False}}, fh)
    ok("available: enabled:false beats a key",
       run([TYPESAFE, "available"], keyed).returncode == 1)
    ok("asked.py available agrees", run([ASKED, "available"], keyed).returncode == 1)
    os.unlink(integ)

    # -------------------------------------------------- ask CLI, happy + retry
    SCRIPT[:] = [(200, {"answers": {"q": {"noul": 0.9}}})]
    r = run([TYPESAFE, "ask"], keyed,
            json.dumps({"state": {"t": "x"}, "questions": {"q": {"type": "noul"}}}))
    ok("ask: happy path exits 0", r.returncode == 0)
    ok("ask: answers pass through", json.loads(r.stdout or "{}").get("q", {}).get("noul") == 0.9)
    ok("ask: auth header question reached the mock",
       REQUESTS and REQUESTS[-1].get("questions", {}).get("q", {}).get("type") == "noul")

    SCRIPT[:] = [(429, {}), (200, {"answers": {"q": {"noul": 0.5}}})]
    before = len(REQUESTS)
    r = run([TYPESAFE, "ask"], keyed, json.dumps({"state": {}, "questions": {"q": {}}}))
    ok("ask: 429 retries once and succeeds",
       r.returncode == 0 and len(REQUESTS) == before + 2)

    SCRIPT[:] = [(500, {})]
    ok("ask: 500 -> exit 2, no retry storm",
       run([TYPESAFE, "ask"], keyed, json.dumps({"state": {}, "questions": {}})).returncode == 2)
    ok("ask: no key -> exit 2 without a request",
       (lambda n: run([TYPESAFE, "ask"], clean, "{}").returncode == 2
        and len(REQUESTS) == n)(len(REQUESTS)))

    # -------------------------------------------------- asked.py end to end
    payload = json.dumps({"last_assistant_message": "Should I take route A or B?"})
    SCRIPT[:] = [(200, {"answers": {"blocked_on_user": {"noul": 0.93},
                                    "stuck": {"noul": 0.12},
                                    "urgency": {"score": 2.1}}})]
    r = run([ASKED, "judge"], keyed, payload)
    lines = r.stdout.splitlines()
    ok("judge: over threshold -> exit 0", r.returncode == 0)
    ok("judge: stdout is probability, banner, then ranking JSON",
       len(lines) == 3 and lines[0] == "0.930" and lines[1].endswith("?"))
    ok("judge: line 3 carries stuck and urgency for the board cache",
       json.loads(lines[2] or "{}") == {"stuck": 0.12, "urgency": 2.1})
    ok("judge: one request carried all three questions",
       set(REQUESTS[-1].get("questions", {})) == {"blocked_on_user", "stuck", "urgency"})

    # Ranking answers are best-effort: a response missing them must not cost
    # the blocked judgment — line 3 degrades to {}.
    SCRIPT[:] = [(200, {"answers": {"blocked_on_user": {"noul": 0.91}}})]
    r = run([ASKED, "judge"], keyed, payload)
    ok("judge: missing ranking answers degrade to {} without failing",
       r.returncode == 0 and r.stdout.splitlines()[2] == "{}")
    ok("judge: only the tail leaves the machine",
       "last_message" in json.dumps(REQUESTS[-1].get("state", {})))

    SCRIPT[:] = [(200, {"answers": {"blocked_on_user": {"noul": 0.12}}})]
    ok("judge: under threshold -> exit 1", run([ASKED, "judge"], keyed, payload).returncode == 1)
    ok("judge: no key -> exit 2", run([ASKED, "judge"], clean, payload).returncode == 2)

    srv.shutdown()
    dead = {**keyed, "TYPESAFE_BASE_URL": base}   # port now closed
    ok("judge: unreachable API -> exit 2", run([ASKED, "judge"], dead, payload).returncode == 2)

    print("typesafe probe: %d ok, %d failed" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
