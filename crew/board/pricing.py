#!/usr/bin/env python3
"""Crew-owned ccusage pricing overrides: published prices for named models.

    config_args() -> [] | ["--config", PATH]     append to every ccusage call
    compare(overrides, upstream) -> [(level, message)]   pure, for crew doctor

Nothing here prices anything. ccusage reads its rates from LiteLLM's price
table at runtime, and a new model reads $0 (or a wrong rate) until LiteLLM
lists it. `defaults.pricingOverrides` in a ccusage config is ccusage's own
answer to that, so this only decides which overrides to hand it:

- config/ccusage-pricing.json, shipped with crew: one entry per model whose
  published price upstream has wrong or missing. Empty is the normal state.
- $CREW_LOCAL/ccusage-pricing.json, this machine's own: an entry here replaces
  the shipped entry for the same model, wholesale.

What ccusage does with a config, measured against 20.0.23 (README, spend):
- a partial entry merges field by field with upstream's rates; for a model
  upstream does not list, the fields it leaves out price at $0;
- `--config` REPLACES discovery: the user's own ccusage.json is not read at all;
- a file that is unreadable, or carries one malformed value anywhere in
  pricingOverrides, loses every override, silently, with exit 0; an extra
  key inside an entry (a "source", say) is tolerated.

So the file ccusage sees is generated: the user's discovered ccusage.json
(cwd/.ccusage, then $CLAUDE_CONFIG_DIR or ~/.config/claude, ~/.claude --
ccusage's own order, first found wins) with crew's entries merged over it,
numeric fields only, under a content-hashed name in ~/.cache/cmux-crew so two
callers with different discovered configs never trade files. With no crew
override there is no `--config` at all, and ccusage runs exactly as before.

Every failure degrades to [] -- ccusage's own prices -- never to an error.

    pricing.py --args                     the args, as JSON (probe)
    pricing.py --merge SHIPPED LOCAL      effective overrides, as JSON (probe)
    pricing.py --compare OVR.json UP.json compare(), as JSON (probe)
    pricing.py --doctor                   tab-separated level/message lines
"""
import glob
import hashlib
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
SHIPPED = os.path.join(os.path.dirname(HERE), "config", "ccusage-pricing.json")
NAME = "ccusage-pricing.json"

# ccusage's override fields, and LiteLLM's name for each. fastMultiplier has no
# LiteLLM counterpart, so doctor can only say it has nothing to compare it with.
FIELDS = {
    "inputCostPerToken": "input_cost_per_token",
    "outputCostPerToken": "output_cost_per_token",
    "cacheCreationInputTokenCost": "cache_creation_input_token_cost",
    "cacheReadInputTokenCost": "cache_read_input_token_cost",
    "inputCostPerTokenAbove200kTokens": "input_cost_per_token_above_200k_tokens",
    "outputCostPerTokenAbove200kTokens": "output_cost_per_token_above_200k_tokens",
    "cacheCreationInputTokenCostAbove200kTokens": "cache_creation_input_token_cost_above_200k_tokens",
    "cacheReadInputTokenCostAbove200kTokens": "cache_read_input_token_cost_above_200k_tokens",
    "maxInputTokens": "max_input_tokens",
    "fastMultiplier": None,
}
BASE = ("inputCostPerToken", "outputCostPerToken",
        "cacheCreationInputTokenCost", "cacheReadInputTokenCost")
# Where an entry records where its price came from. Kept in crew's files and
# stripped from the generated one: ccusage tolerates them, but it has no use
# for them either.
PROVENANCE = ("source", "why", "added")


def local_dir():
    return os.environ.get("CREW_LOCAL") or os.path.join(
        os.path.expanduser("~"), ".config", "cmux", "crew-local")


def cache_dir():
    return os.path.join(os.path.expanduser("~"), ".cache", "cmux-crew", "ccusage")


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and \
        math.isfinite(v) and v >= 0


def entries(cfg):
    """Raw {model: entry} from a ccusage-shaped config, or {} when it has none."""
    po = ((cfg or {}).get("defaults") or {}).get("pricingOverrides") \
        if isinstance(cfg, dict) else None
    return po if isinstance(po, dict) else {}


def clean(raw):
    """Only what ccusage accepts: known fields with numeric values.

    One bad value anywhere makes ccusage drop the whole config without a word,
    so nothing it might reject is ever passed through. doctor names what was
    dropped (problems()), which is the only place it would otherwise show.
    """
    out = {}
    for model, e in (raw or {}).items():
        if not isinstance(model, str) or not isinstance(e, dict):
            continue
        fields = {k: v for k, v in e.items() if k in FIELDS and _num(v)}
        if fields:
            out[model] = fields
    return out


def problems(raw):
    """What clean() would drop, said plainly."""
    out = []
    for model, e in (raw or {}).items():
        if not isinstance(e, dict):
            out.append("%s: not an object" % model)
            continue
        for k, v in e.items():
            if k in PROVENANCE:
                continue
            if k not in FIELDS:
                out.append("%s: %s is not a ccusage price field — ignored" % (model, k))
            elif not _num(v):
                out.append("%s: %s is not a non-negative number — dropped (passed on, "
                           "ccusage would ignore every override)" % (model, k))
    return out


def load(path):
    """(raw entries, error). A missing file is ({}, None), not an error."""
    try:
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
    except FileNotFoundError:
        return {}, None
    except (OSError, ValueError) as exc:
        return {}, "%s: %s" % (exc.__class__.__name__, exc)
    if not isinstance(cfg, dict):
        return {}, "not a JSON object"
    return entries(cfg), None


def merge(shipped, local):
    """Local entries win over shipped ones, per model and wholesale: a local
    entry is this machine's complete statement about that model."""
    out = dict(shipped or {})
    out.update(local or {})
    return out


def effective():
    shipped, _ = load(SHIPPED)
    local, _ = load(os.path.join(local_dir(), NAME))
    return clean(merge(shipped, local))


def discovered(cwd=None):
    """The config ccusage would have found on its own, or None.

    Its order, measured: ./.ccusage/ccusage.json, then ccusage.json in each
    Claude dir ($CLAUDE_CONFIG_DIR when set, else ~/.config/claude then
    ~/.claude). The first that exists wins; they never merge.
    """
    cands = [os.path.join(cwd or os.getcwd(), ".ccusage", "ccusage.json")]
    env = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    dirs = [d.strip() for d in env.split(",") if d.strip()] if env else [
        os.path.join(os.path.expanduser("~"), ".config", "claude"),
        os.path.join(os.path.expanduser("~"), ".claude")]
    cands += [os.path.join(d, "ccusage.json") for d in dirs]
    for p in cands:
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as fh:
                    cfg = json.load(fh)
                return cfg if isinstance(cfg, dict) else None
            except (OSError, ValueError):
                return None  # ccusage ignores an unreadable one too
    return None


def build(overrides, user=None):
    """Pure: the user's config with crew's entries merged over it, field-wise."""
    cfg = json.loads(json.dumps(user)) if isinstance(user, dict) else {}
    d = cfg.get("defaults")
    if not isinstance(d, dict):
        d = cfg["defaults"] = {}
    po = d.get("pricingOverrides")
    po = dict(po) if isinstance(po, dict) else {}
    for model, e in overrides.items():
        mine = po.get(model) if isinstance(po.get(model), dict) else {}
        po[model] = dict(mine, **e)
    d["pricingOverrides"] = po
    return cfg


def _write(cfg):
    body = json.dumps(cfg, sort_keys=True, indent=1)
    digest = hashlib.sha256(body.encode()).hexdigest()[:16]
    d = cache_dir()
    path = os.path.join(d, "config-%s.json" % digest)
    if os.path.isfile(path):
        return path
    os.makedirs(d, exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(body)
    os.replace(tmp, path)
    # Old generations: each is a few hundred bytes, but nothing else removes them.
    cutoff = time.time() - 7 * 86400
    for old in glob.glob(os.path.join(d, "config-*.json")):
        try:
            if old != path and os.path.getmtime(old) < cutoff:
                os.remove(old)
        except OSError:
            pass
    return path


def config_args(cwd=None):
    """["--config", path] when crew has an override to apply, else []."""
    try:
        ov = effective()
        if not ov:
            return []
        return ["--config", _write(build(ov, discovered(cwd)))]
    except Exception:
        return []


# ---- doctor ------------------------------------------------------------------

def litellm_cache():
    """(table, path) from ccusage's own cached LiteLLM fetch; (None, None) when
    there is none. Read only, never fetched: doctor must not touch the network."""
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    pat = os.path.join(base, "ccusage", "http-cache",
                       "raw.githubusercontent.com-BerriAI-litellm-main-model_prices*.cache")
    files = sorted(glob.glob(pat), key=os.path.getmtime)
    for f in reversed(files):
        try:
            with open(f, encoding="utf-8") as fh:
                fh.readline()  # the ETag
                table = json.load(fh)
            if isinstance(table, dict):
                return table, f
        except (OSError, ValueError):
            continue
    return None, None


def _same(a, b):
    return math.isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-15)


def compare(overrides, upstream):
    """Pure: each override against upstream's entry for the same model.

    Returns [(level, message)], level one of ok / warn / note. An override is
    a stopgap, so the loud case is the one where it is no longer needed.
    """
    out = []
    if upstream is None:
        if overrides:
            out.append(("note", "no ccusage price cache to compare against (run ccusage once) — skipped"))
        return out
    for model in sorted(overrides):
        e = overrides[model]
        up = next((upstream[k] for k in (model, "anthropic/" + model)
                   if isinstance(upstream.get(k), dict)), None)
        if up is None:
            missing = [f for f in BASE if f not in e]
            msg = "%s: upstream has no entry — the override is filling a gap" % model
            if missing:
                msg += " (unset fields price at $0: %s)" % ", ".join(missing)
            out.append(("note" if not missing else "warn", msg))
            continue
        diffs, nothing = [], []
        for f, v in sorted(e.items()):
            u = up.get(FIELDS.get(f) or "")
            if not FIELDS.get(f) or not _num(u):
                nothing.append(f)
            elif not _same(v, u):
                diffs.append("%s %g (upstream %g)" % (f, v, u))
        if not diffs and not nothing:
            out.append(("warn", "override for %s now matches upstream — remove it" % model))
        elif diffs:
            out.append(("note", "%s: override differs from upstream: %s" % (model, "; ".join(diffs))))
        if nothing:
            out.append(("note", "%s: upstream has no %s to compare" % (model, ", ".join(nothing))))
    return out


def doctor_lines():
    out = []
    for label, path in (("shipped", SHIPPED), ("crew-local", os.path.join(local_dir(), NAME))):
        raw, err = load(path)
        if err:
            out.append(("bad", "%s %s is unreadable (%s) — its overrides are ignored" % (label, NAME, err)))
        for p in problems(raw):
            out.append(("warn", "%s %s: %s" % (label, NAME, p)))
    ov = effective()
    if not ov:
        out.append(("note", "ccusage pricing: no crew overrides — ccusage's own prices apply"))
        return out
    out.append(("ok", "ccusage pricing overrides: %s" % ", ".join(sorted(ov))))
    table, _ = litellm_cache()
    out.extend(compare(ov, table))
    return out


def main(argv):
    if argv[:1] == ["--args"]:
        print(json.dumps(config_args()))
    elif argv[:1] == ["--merge"]:
        print(json.dumps(clean(merge(load(argv[1])[0], load(argv[2])[0])), sort_keys=True))
    elif argv[:1] == ["--compare"]:
        with open(argv[1]) as fh:
            ov = json.load(fh)
        up = None
        if len(argv) > 2 and argv[2] != "-":
            with open(argv[2]) as fh:
                up = json.load(fh)
        print(json.dumps(compare(ov, up)))
    elif argv[:1] == ["--doctor"]:
        for lvl, msg in doctor_lines():
            print("%s\t%s" % (lvl, msg))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
