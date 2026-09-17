#!/usr/bin/env python3
"""crew — the one TypeSafe client. Config, transport, retry; no judgments.

    typesafe.py available      exit 0 when TypeSafe is configured, 1 when not
    typesafe.py ask            {"state":..., "questions":...} on stdin ->
                               answers JSON on stdout; exit 2 on any failure

Question text belongs to each feature, next to the code that consumes the
answer (asked.py holds its own; so will every judgment after it). What is
shared is the part that must never fork: what "TypeSafe is on" means, where
the key lives, and how a request fails. A second definition of any of those
is how one feature ends up on while another thinks the machine is off.

TypeSafe is on when a key exists — $TYPESAFE_API_KEY, or the first line of
${XDG_CONFIG_HOME:-~/.config}/typesafe/api-key — and integrations.json does
not say {"typesafe": {"enabled": false}}. The key file lives outside the crew
tree on purpose: install.sh syncs that tree, and a secret must never ride a
sync. Any failure — no key, network, 4xx/5xx, timeout, bad JSON — raises out
of ask(); callers turn that into "no judgment", never into a guess.

The `ask` CLI mode exists for node callers (deep-plan's evidence check): one
client, two languages. It speaks JSON on stdin/stdout so no question text
ever lands in an argv, and exit 2 mirrors asked.py's "no judgment" code.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# Env override exists for the probe, and only for the probe: the real file is
# user state beside the installed crew tree, which a test must never touch.
INTEGRATIONS = os.environ.get("TYPESAFE_INTEGRATIONS") or \
    os.path.join(HERE, "..", "integrations.json")
BASE_URL = os.environ.get("TYPESAFE_BASE_URL", "https://api.typesafe.ai").rstrip("/")
MODEL = os.environ.get("TYPESAFE_DEFAULT_MODEL", "jev-latest")
TIMEOUT = 10.0


def _config():
    try:
        with open(INTEGRATIONS) as fh:
            return json.load(fh).get("typesafe") or {}
    except Exception:
        return {}


def api_key():
    if _config().get("enabled") is False:
        return ""
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    try:
        with open(os.path.join(base, "typesafe", "api-key")) as fh:
            return fh.readline().strip()
    except Exception:
        return ""


def threshold(name="threshold", default=0.7):
    """A named threshold from integrations.json typesafe, clamped to [0,1].

    Named because every judgment gets its own knob (threshold,
    stuck_threshold, ...) and they must not share one number by accident.
    """
    try:
        return min(max(float(_config().get(name, default)), 0.0), 1.0)
    except Exception:
        return default


def ask(key, state, questions, timeout=TIMEOUT):
    """One /v1/systemone POST; the raw answers map back. Raises on any failure.

    429 and 529 are the retryable pair. Every caller here is either detached
    or a CLI moment, but an answer that arrives after the human already looked
    is worthless either way — so two short retries and out.
    """
    body = json.dumps({"model": MODEL, "state": state,
                       "questions": questions}).encode()
    req = urllib.request.Request(
        BASE_URL + "/v1/systemone", data=body, method="POST",
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)["answers"]
        except urllib.error.HTTPError as e:
            if e.code not in (429, 529) or attempt == 2:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("unreachable")


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "available":
        return 0 if api_key() else 1
    if cmd != "ask":
        sys.stderr.write(__doc__)
        return 2
    key = api_key()
    if not key:
        return 2
    try:
        req = json.loads(sys.stdin.read() or "{}")
        answers = ask(key, req.get("state"), req.get("questions") or {})
    except Exception as e:
        sys.stderr.write("typesafe: %s\n" % e)
        return 2
    json.dump(answers, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
