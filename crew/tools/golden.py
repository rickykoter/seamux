"""Golden files: bytes kept under crew/tools/golden/ for fixtures that only a
parity check used to hold seamux to. They were first recorded from crew's
retired Python, so they are the Python's bytes until a change re-records them.

    import golden
    golden.expect("core/compare.txt", text, subs={T: "<T>"})   # -> (ok, want)
    golden.same("core/compare.txt", text, subs={T: "<T>"})     # -> (ok, want)

expect compares, or with CREW_GOLDEN=write records `text` instead. same only
ever compares, so a second implementation in the same run can never record.
subs replaces machine paths before either. Re-record only when a change is
meant to move the bytes, and say so in the PR.
"""
import os

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden")


def norm(text, subs=None):
    """text with each subs key (longest first) replaced by its placeholder."""
    for k, v in sorted((subs or {}).items(), key=lambda kv: -len(kv[0])):
        if k:
            text = text.replace(k, v)
    return text


def _path(name):
    return os.path.join(DIR, name)


def same(name, text, subs=None):
    """(text == the golden, the golden or why there is none)."""
    text = norm(text, subs)
    try:
        with open(_path(name), encoding="utf-8", newline="") as fh:
            want = fh.read()
    except FileNotFoundError:
        return False, "(no golden at %s; CREW_GOLDEN=write records one)" % _path(name)
    return text == want, want


def expect(name, text, subs=None):
    """same(), or under CREW_GOLDEN=write record text and report a match."""
    if os.environ.get("CREW_GOLDEN") == "write":
        text = norm(text, subs)
        os.makedirs(os.path.dirname(_path(name)), exist_ok=True)
        with open(_path(name), "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        return True, text
    return same(name, text, subs)
