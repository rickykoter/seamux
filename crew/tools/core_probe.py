#!/usr/bin/env python3
"""core_probe — crew-core's modules with no other probe, black-box.

cachefacts (a transcript with every break cause, the Stop-hook message, the
corpus sweep, TTL derivation), families (grouping), pricing (--doctor,
--args, --merge, --compare) and costs (--attribute, Python float printing),
plus workspaces' list-json and dormant-days against fakecmux.

Each case runs the implementation CREW_IMPL picks (crew_impl.argv) and checks
what it printed. Under CREW_IMPL=rust it also runs the Python on the same
input and checks the two printed the same bytes, so a Rust that differs only
in spacing or float format fails here. No cmux, no network, throwaway HOME.

    python3 crew/tools/core_probe.py
    CREW_IMPL=rust python3 crew/tools/core_probe.py
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CREW = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import crew_impl  # noqa: E402

PATHS = {
    "cachefacts": os.path.join(CREW, "hooks", "cachefacts.py"),
    "families": os.path.join(CREW, "board", "families.py"),
    "pricing": os.path.join(CREW, "board", "pricing.py"),
    "costs": os.path.join(CREW, "board", "costs.py"),
    "workspaces": os.path.join(CREW, "hooks", "workspaces.py"),
}
FAKE = os.path.join(HERE, "fakecmux.py")
results = []


def check(name, cond, extra=""):
    results.append(bool(cond))
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"\n       {extra}" if extra and not cond else ""))


T = os.path.realpath(tempfile.mkdtemp(prefix="core-probe-"))
SCRUB = ("FORCE_PROMPT_CACHING_5M", "ENABLE_PROMPT_CACHING_1H", "CLAUDE_CODE_PROMPT_CACHE_TTL",
         "CREW_BILLING", "CREW_LOCAL", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "CREW_INTEGRATIONS",
         "CREW_CMUX", "CREW_CMUX_TRANSPORT", "CREW_HOME", "FAKE_CMUX_DIR")


def home(tag):
    """A fresh HOME per run, so two implementations never share state."""
    h = os.path.join(T, "home-%s-%d" % (tag, len(os.listdir(T))))
    os.makedirs(h)
    return h


def env_for(h, **kw):
    e = {k: v for k, v in os.environ.items() if k not in SCRUB}
    e.update(HOME=h, CREW_LOCAL=os.path.join(h, "crew-local"))
    e.update(kw)
    return e


def run(tool, args, env, stdin="", impl=True):
    """The implementation CREW_IMPL picks (impl=True), or always the Python."""
    path = PATHS[tool]
    argv = crew_impl.argv(tool, path, sys.executable) if impl else [sys.executable, path]
    return subprocess.run(argv + list(args), input=stdin, capture_output=True, text=True,
                          env=crew_impl.env(env) if impl else env, timeout=60)


def both(tool, args, make_env, stdin="", norm=lambda s: s):
    """Run the picked implementation; under rust also the Python, each with
    its own fresh HOME from make_env. -> (result, same_as_python or None)."""
    r = run(tool, args, make_env("impl"), stdin)
    if not crew_impl.is_rust(tool):
        return r, None
    p = run(tool, args, make_env("py"), stdin, impl=False)
    return r, (norm(r.stdout), r.returncode) == (norm(p.stdout), p.returncode)


def same(name, eq, r):
    if eq is not None:
        check(name + " — Rust prints the Python's bytes", eq, r.stdout[-400:])


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------- cachefacts
print("cachefacts")
T0 = time.time() - 1100      # the last break lands ~90 s ago: fresh for --stop


def asst(dt, read, creation, model="m1", version="v1", rid=None, **kw):
    rec = {"type": "assistant", "timestamp": iso(T0 + dt), "version": version,
           "message": {"model": model, "usage": {"cache_read_input_tokens": read,
                                                 "cache_creation_input_tokens": creation}}}
    if rid:
        rec["requestId"] = rid
    rec.update(kw)
    return rec


TX = os.path.join(T, "projects", "-p", "s1.jsonl")
os.makedirs(os.path.dirname(TX))
with open(TX, "w") as fh:
    fh.write("half a line cut by a tail\n")
    for rec in (
        {"type": "user", "message": {"content": "go"}},
        asst(0, 0, 30000, rid="r1"),
        asst(1, 0, 30000, rid="r1"),                       # a retry: same requestId
        asst(10, 30000, 500, rid="r2"),
        asst(20, 1000, 25000, model="m2", rid="r3"),       # model-switch
        {"type": "summary", "isCompactSummary": True},
        asst(30, 100, 5000, model="m2", rid="r4"),         # compaction
        asst(40, 5100, 30000, model="m2", rid="r5"),
        asst(1000, 1000, 30000, model="m2", rid="r6"),     # ttl-gap (> 300 s)
        asst(1005, 10, 10, model="m2", isSidechain=True),  # a subagent: skipped
        asst(1010, 500, 31000, model="m2", version="v2", rid="r7"),  # upgrade
    ):
        fh.write(json.dumps(rec) + "\n")

no_gen = lambda s: "\n".join(l for l in s.splitlines() if '"generatedAt"' not in l)  # noqa: E731
r, eq = both("cachefacts", [TX, "s1"], lambda t: env_for(home(t), CREW_BILLING="usage"), norm=no_gen)
f = json.loads(r.stdout or "{}")
check("every break cause is named, in order",
      [b["cause"] for b in f.get("breaks", [])] == ["model-switch", "compaction", "ttl-gap", "upgrade"],
      r.stdout[-600:] + r.stderr[-300:])
check("the TTL is derived from billing", f.get("ttl") == 300 and f.get("ttlSource") == "billing:usage")
check("the clock runs from the last request", abs(f.get("staleAt", 0) - (T0 + 1010 + 300)) < 0.01
      and f.get("contextTokens") == 31500)
same("cachefacts <transcript> <sid>", eq, r)

r, eq = both("cachefacts", [TX], lambda t: env_for(home(t), CLAUDE_CODE_PROMPT_CACHE_TTL="1h"), norm=no_gen)
f = json.loads(r.stdout or "{}")
check("an explicit TTL wins over billing", f.get("ttl") == 3600
      and f.get("ttlSource") == "CLAUDE_CODE_PROMPT_CACHE_TTL")
check("…which moves the gap that counts as ttl-gap",
      [b["cause"] for b in f.get("breaks", [])] == ["model-switch", "compaction", "unknown", "upgrade"])
same("cachefacts with a 1h TTL", eq, r)

h = home("stop")
e = env_for(h, CREW_BILLING="usage")
r1 = run("cachefacts", ["--stop", TX, "s2", "lbl"], e)
r2 = run("cachefacts", ["--stop", TX, "s2", "lbl"], e)
msg = json.loads(r1.stdout or "{}").get("systemMessage", "")
check("--stop says so on a fresh break", msg == "cache broke last turn [lbl]: ~31k tokens re-cached (upgrade)",
      r1.stdout + r1.stderr)
check("…writes the facts file", os.path.isfile(os.path.join(h, ".cache", "cmux-crew", "cache-facts", "s2.json")))
check("…and is quiet the second time", r2.stdout == "" and r2.returncode == 0, r2.stdout)
if crew_impl.is_rust("cachefacts"):
    p1 = run("cachefacts", ["--stop", TX, "s2", "lbl"], env_for(home("stop-py"), CREW_BILLING="usage"), impl=False)
    check("--stop — Rust prints the Python's bytes", p1.stdout == r1.stdout, p1.stdout + "|" + r1.stdout)

r, eq = both("cachefacts", ["--scan", os.path.join(T, "projects")], lambda t: env_for(home(t), CREW_BILLING="usage"))
check("--scan tallies the corpus", r.stdout.startswith("1 transcripts, 4 breaks, 0.1M tokens re-cached"), r.stdout)
same("--scan", eq, r)

# ---------------------------------------------------------------- families
print("families")
board = {"rows": [{"id": "a", "kind": "attend", "urgency": 0.5},
                  {"id": "p", "kind": "done", "family": "f", "famrole": "parent"},
                  {"id": "c", "kind": "attend", "urgency": 3, "family": "f", "famrole": "child"},
                  {"id": "x", "kind": "running", "family": "g", "famrole": "child"}],
         "quiet": [{"id": "c2", "kind": "quiet", "family": "f", "famrole": "child"},
                   {"id": "q", "kind": "quiet"}]}
r, eq = both("families", [], lambda t: env_for(home(t)), stdin=json.dumps(board))
d = json.loads(r.stdout or "{}")
check("a family moves as one unit, parent first, at its most urgent member's place",
      [x["id"] for x in d.get("rows", [])] == ["p", "c", "c2", "a", "x"], r.stdout)
check("a family without its parent row is labelled", d["rows"][4].get("famlabel") == "g" if d.get("rows") else False)
same("families", eq, r)
flat = {"rows": [{"id": "a", "kind": "done"}], "quiet": []}
r, eq = both("families", [], lambda t: env_for(home(t)), stdin=json.dumps(flat))
check("no family on the board: the same rows back", json.loads(r.stdout or "{}") == flat)
same("families with no family", eq, r)

# ---------------------------------------------------------------- pricing
print("pricing")


def pricing_env(t, override=True, bad=False):
    h = home(t)
    local = os.path.join(h, "crew-local")
    os.makedirs(local)
    if override:
        body = "{ not json" if bad else json.dumps({"defaults": {"pricingOverrides": {
            "claude-test-9-9": {"inputCostPerToken": 3e-06, "outputCostPerToken": 1.5e-05,
                                "source": "published", "colour": "blue"},
            "claude-gap-1": {"inputCostPerToken": 1e-06}}}})
        open(os.path.join(local, "ccusage-pricing.json"), "w").write(body)
    cache = os.path.join(h, "xdg", "ccusage", "http-cache")
    os.makedirs(cache)
    with open(os.path.join(cache, "raw.githubusercontent.com-BerriAI-litellm-main-model_prices_x.cache"), "w") as fh:
        fh.write('"etag"\n' + json.dumps({"anthropic/claude-test-9-9": {
            "input_cost_per_token": 3e-06, "output_cost_per_token": 1.2e-05}}))
    claude = os.path.join(h, "claude")
    os.makedirs(claude)
    json.dump({"defaults": {"pricingOverrides": {"claude-test-9-9": {"cacheReadInputTokenCost": 3e-07}}},
               "other": 1}, open(os.path.join(claude, "ccusage.json"), "w"))
    return env_for(h, CREW_LOCAL=local, XDG_CACHE_HOME=os.path.join(h, "xdg"), CLAUDE_CONFIG_DIR=claude)


r, eq = both("pricing", ["--doctor"], lambda t: pricing_env(t))
lines = r.stdout.splitlines()
check("--doctor names the dropped field, the overrides and each comparison",
      any("colour is not a ccusage price field" in l for l in lines)
      and "ok\tccusage pricing overrides: claude-gap-1, claude-test-9-9" in lines
      and any("outputCostPerToken 1.5e-05 (upstream 1.2e-05)" in l for l in lines)
      and any(l.startswith("warn\tclaude-gap-1: upstream has no entry") for l in lines), r.stdout)
same("--doctor", eq, r)
r = run("pricing", ["--doctor"], pricing_env("bad", bad=True))
check("an unreadable local file is a bad line, not a crash",
      r.returncode == 0 and "bad\tcrew-local ccusage-pricing.json is unreadable (" in r.stdout, r.stdout + r.stderr)

ea = pricing_env("args")
r = run("pricing", ["--args"], ea)
a = json.loads(r.stdout or "[]")
check("--args names a generated config", a[:1] == ["--config"] and os.path.isfile(a[1] if len(a) > 1 else ""), r.stdout)
if crew_impl.is_rust("pricing") and len(a) > 1:
    gen = open(a[1]).read()
    os.remove(a[1])
    p = run("pricing", ["--args"], ea, impl=False)
    check("--args — the Python names the same file for the same overrides (one hash, one format)",
          p.stdout == r.stdout and open(json.loads(p.stdout)[1]).read() == gen, p.stdout + "|" + r.stdout)
cfg = json.load(open(a[1])) if len(a) > 1 else {}
check("…crew's fields over the user's, which survive underneath",
      cfg.get("other") == 1 and cfg["defaults"]["pricingOverrides"]["claude-test-9-9"] ==
      {"cacheReadInputTokenCost": 3e-07, "inputCostPerToken": 3e-06, "outputCostPerToken": 1.5e-05}, json.dumps(cfg))

sf, lf = os.path.join(T, "shipped.json"), os.path.join(T, "local.json")
json.dump({"defaults": {"pricingOverrides": {"m1": {"inputCostPerToken": 1}, "m2": {"inputCostPerToken": 2}}}},
          open(sf, "w"))
json.dump({"defaults": {"pricingOverrides": {"m2": {"outputCostPerToken": 0.5, "x": "y"}}}}, open(lf, "w"))
r, eq = both("pricing", ["--merge", sf, lf], lambda t: env_for(home(t)))
check("--merge: a local entry replaces the shipped one wholesale",
      json.loads(r.stdout or "{}") == {"m1": {"inputCostPerToken": 1}, "m2": {"outputCostPerToken": 0.5}}, r.stdout)
same("--merge", eq, r)
of, uf = os.path.join(T, "ov.json"), os.path.join(T, "up.json")
json.dump({"m": {"inputCostPerToken": 3e-06, "fastMultiplier": 2}, "n": {"inputCostPerToken": 1e-06}}, open(of, "w"))
json.dump({"m": {"input_cost_per_token": 3e-06}}, open(uf, "w"))
r, eq = both("pricing", ["--compare", of, uf], lambda t: env_for(home(t)))
check("--compare lists each model's verdict", len(json.loads(r.stdout or "[]")) == 2, r.stdout)
same("--compare", eq, r)
r, eq = both("pricing", ["--compare", of, "-"], lambda t: env_for(home(t)))
same("--compare with no upstream", eq, r)

# ---------------------------------------------------------------- costs
print("costs")
fx = os.path.join(T, "fx.json")
json.dump({"today": "2026-10-21", "projects": {
    "-w-a": [{"date": "2026-10-21", "totalCost": 0.1}, {"date": "2026-10-20", "totalCost": 0.2},
             {"date": "2026-10-19", "totalCost": "bad"},
             {"date": "2026-10-21", "totalCost": 1e-07,
              "modelBreakdowns": [{"modelName": "x-1", "missingPricing": True}]}],
    "-w-b": [{"date": "2026-10-18", "totalCost": 3}]}}, open(fx, "w"))
r, eq = both("costs", ["--attribute", fx, "/w/a", "/w/b"], lambda t: env_for(home(t)))
d = json.loads(r.stdout or "{}")
check("--attribute sums floats as Python does and names unpriced models",
      d.get("/w/a", {}).get("unpricedToday") == ["x-1"] and d.get("/w/b", {}).get("today") == 0.0, r.stdout)
same("--attribute (0.1 + 0.2, 1e-07)", eq, r)
# Real ccusage costs carry 16-17 significant digits, which a float parser
# that is not round-trip exact reads one ulp off (seeded, so a failure repeats).
import random  # noqa: E402
rng = random.Random(7)
long_rows = [{"date": "2026-10-21", "totalCost": rng.uniform(0, 40)} for _ in range(400)]
fx2 = os.path.join(T, "fx2.json")
json.dump({"today": "2026-10-21", "projects": {"-w-a": long_rows}}, open(fx2, "w"))
r, eq = both("costs", ["--attribute", fx2, "/w/a"], lambda t: env_for(home(t)))
check("--attribute over 400 17-digit costs", '"week"' in r.stdout, r.stdout[:200])
same("--attribute with 17-digit floats", eq, r)
# families echoes every row, so each float is parsed and printed once.
echo = {"rows": [{"id": str(i), "kind": "done", "family": "f", "urgency": x["totalCost"]}
                 for i, x in enumerate(long_rows)], "quiet": []}
r, eq = both("families", [], lambda t: env_for(home(t)), stdin=json.dumps(echo))
same("families echoing 400 17-digit floats", eq, r)

# ---------------------------------------------------------------- workspaces CLI
print("workspaces CLI")
fake = os.path.join(T, "cmux")
os.makedirs(fake)
json.dump([{"id": "W-1", "ref": "workspace:1", "title": "one·", "current_directory": "/a", "description": "d"}],
          open(os.path.join(fake, "workspaces.json"), "w"))
integ = os.path.join(T, "integ.json")
json.dump({"sweep": {"dormant_days": "7"}}, open(integ, "w"))
mk = lambda t: env_for(home(t), CREW_CMUX=FAKE, FAKE_CMUX_DIR=fake, CREW_INTEGRATIONS=integ)  # noqa: E731
r, eq = both("workspaces", ["list-json"], mk)
check("list-json in workspace list --json's field names",
      json.loads(r.stdout or "{}").get("workspaces", [{}])[0].get("current_directory") == "/a", r.stdout + r.stderr)
same("list-json", eq, r)
r, eq = both("workspaces", ["dormant-days"], mk)
check("dormant-days reads integrations.json", r.stdout.strip() == "7")
same("dormant-days", eq, r)
r = run("workspaces", ["list-json"], env_for(home("dead"), CREW_CMUX="/usr/bin/false"))
check("list-json exits 1 when cmux is silent", r.returncode == 1 and r.stdout == "")

print(f"\ncore probe: {sum(results)} passed, {len(results) - sum(results)} failed"
      + (" (CREW_IMPL=%s)" % os.environ["CREW_IMPL"] if os.environ.get("CREW_IMPL") else ""))
sys.exit(0 if all(results) else 1)
