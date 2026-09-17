#!/usr/bin/env python3
"""crew — did the turn that just ended leave a question sitting on you?

    asked.py available              exit 0 when TypeSafe is configured, 1 when not
    asked.py judge < stop-payload   exit 0 asked, 1 not asked, 2 no judgment

A Notification hook only fires for permission prompts and idle reminders. A turn
that ends with "which of these two should I do?" fires Stop, and Stop is
"turn complete": sidebar only, no banner, and the board files the row as done.
The agent is stuck on you and nothing says so.

Telling those turns apart from "done — want me to open a PR?" is a judgment, not
a regex, so it is optional and belongs to TypeSafe. Without a key this answers 2
and the hook keeps its old behavior exactly; nothing here guesses.

Config and transport live in typesafe.py, the one shared client — what
"TypeSafe is on" means must not fork between callers. The question text stays
HERE, next to the code that consumes the answer; that split is deliberate.

On a judgment, stdout carries two lines: the probability, then the question
text for the banner. Any failure (network, 4xx/5xx, a transcript we cannot read)
is exit 2, never a guess.
"""

import json
import os
import sys

import typesafe

# A tail is enough: the ask is at the end of the message, and transcripts run to
# megabytes. The model sees at most this many characters of the final message.
TAIL_BYTES = 512 * 1024
MAX_CHARS = 4000

YES, NO, UNKNOWN = 0, 1, 2

QUESTION = {
    "type": "noul",
    "instructions": (
        "`last_message` is the final message an AI coding agent wrote before it "
        "stopped and handed control back to its user. Is the agent blocked on the "
        "user: does the message ask a question, request a decision, approval, or "
        "missing information that the agent needs before it can carry on with the "
        "task it was given?"
    ),
    "criteria": {
        "true": ("The task is unfinished and waits on the user's answer: a direct "
                 "question, a choice between options, a request to confirm a risky "
                 "step, or a request for credentials, files or facts."),
        "false": ("The task is finished or the message only reports results. A "
                  "closing offer of optional further work (\"want me to open a "
                  "PR?\", \"let me know if...\") does not block anything."),
    },
}

# The board's two ranking questions ride the same request over the same text —
# no new network path, nothing new leaves the machine. Independent judgments,
# asked together because System One answers a questions map in parallel.
# Policy (thresholds, tiers, ordering) lives in crew-board; these only answer.
STUCK = {
    "type": "noul",
    "instructions": (
        "`last_message` is the final message an AI coding agent wrote before it "
        "stopped. Did the agent stop on a failure it could not resolve by "
        "itself — an error, missing dependency, or repeated failed attempts "
        "that left it unable to continue its task?"
    ),
    "criteria": {
        "true": ("The agent stopped on an unresolved failure: an error it tried "
                 "and could not fix, a missing tool, credential or dependency, "
                 "or the same attempt failing repeatedly."),
        "false": ("The agent finished, made progress, or stopped for an ordinary "
                  "reason such as asking a question, offering options, or "
                  "reporting results."),
    },
}
URGENCY = {
    "type": "score",
    "instructions": (
        "`last_message` is the final message an AI coding agent wrote before it "
        "stopped. How urgently does this message need its human's attention?"
    ),
    "criteria": [
        "Routine progress or completion; nothing is requested, nothing failing.",
        "Optional follow-up or a minor preference; safe to leave either way.",
        "The task cannot proceed until the user answers or approves something.",
        ("Something is failing or about to be lost: an error, a risky step "
         "awaiting confirmation, or work wasted without prompt action."),
    ],
}


def _text_of(message):
    content = (message or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def last_assistant_text(payload):
    """The final assistant text of the turn. Newer Claude Code puts it on the
    Stop payload; otherwise read it off the tail of the transcript."""
    direct = payload.get("last_assistant_message")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    path = payload.get("transcript_path") or ""
    if not path:
        return ""
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        fh.seek(max(0, fh.tell() - TAIL_BYTES))
        lines = fh.read().decode("utf-8", "replace").splitlines()
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except Exception:
            continue          # the first line of a tail is usually cut in half
        if rec.get("type") != "assistant":
            continue
        text = _text_of(rec.get("message")).strip()
        if text:              # tool-use-only records carry no text; keep looking
            return text
    return ""


def ask(key, text):
    """(p_blocked, extras) — extras carries the ranking answers, best-effort:
    the blocked judgment must not fail because a score came back odd."""
    answers = typesafe.ask(key, {"last_message": text[-MAX_CHARS:]},
                           {"blocked_on_user": QUESTION,
                            "stuck": STUCK, "urgency": URGENCY})
    extras = {}
    try:
        extras["stuck"] = round(float(answers["stuck"]["noul"]), 3)
        extras["urgency"] = round(float(answers["urgency"]["score"]), 3)
    except Exception:
        pass
    return float(answers["blocked_on_user"]["noul"]), extras


def banner_line(text):
    """The sentence the banner should show: the last one ending in '?', else the
    message's last line."""
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    for l in reversed(lines):
        if l.endswith("?"):
            return l[:200]
    return (lines[-1] if lines else "Claude is waiting on you")[:200]


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "available":
        return YES if typesafe.api_key() else NO
    if cmd != "judge":
        sys.stderr.write(__doc__)
        return UNKNOWN
    key = typesafe.api_key()
    if not key:
        return UNKNOWN
    try:
        text = last_assistant_text(json.loads(sys.stdin.read() or "{}"))
        if not text:
            return UNKNOWN
        p, extras = ask(key, text)
    except Exception as e:
        sys.stderr.write("asked: %s\n" % e)
        return UNKNOWN
    # Three lines now: probability, banner, then the ranking answers as JSON.
    # asked.sh reads lines by number, so the tail line is additive.
    sys.stdout.write("%.3f\n%s\n%s\n" % (p, banner_line(text), json.dumps(extras)))
    return YES if p >= typesafe.threshold() else NO


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
