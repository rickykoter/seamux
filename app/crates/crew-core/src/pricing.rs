//! Crew-owned ccusage pricing overrides: published prices for named models
//! (crew/board/pricing.py).
//!
//!   config_args() -> [] | ["--config", PATH]       append to every ccusage call
//!   compare(overrides, upstream) -> [(level, message)]   pure, for crew doctor
//!
//! Overrides come from crew's shipped config/ccusage-pricing.json and this
//! machine's $CREW_LOCAL/ccusage-pricing.json (a local entry replaces the
//! shipped one wholesale). Because `--config` replaces ccusage's own config
//! discovery, the file ccusage sees is generated: the user's discovered
//! ccusage.json with crew's entries merged over it, numeric fields only, under
//! a content-hashed name. The name is sha256 of Python's
//! `json.dumps(cfg, sort_keys=True, indent=1)`, so the Rust and the Python
//! agree on it. Every failure degrades to [] (ccusage's own prices).
//!
//!   seamux pricing --args                     the args, as JSON
//!   seamux pricing --merge SHIPPED LOCAL      effective overrides, as JSON
//!   seamux pricing --compare OVR.json UP.json compare(), as JSON
//!   seamux pricing --doctor                   tab-separated level/message lines

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::home::{crew_home, crew_local, home_cache};
use crate::py::{self, env_or, home, percent_g};
use crate::pyjson::{self, Opts};

const NAME: &str = "ccusage-pricing.json";

/// ccusage's override fields, and LiteLLM's name for each.
const FIELDS: &[(&str, Option<&str>)] = &[
    ("inputCostPerToken", Some("input_cost_per_token")),
    ("outputCostPerToken", Some("output_cost_per_token")),
    ("cacheCreationInputTokenCost", Some("cache_creation_input_token_cost")),
    ("cacheReadInputTokenCost", Some("cache_read_input_token_cost")),
    ("inputCostPerTokenAbove200kTokens", Some("input_cost_per_token_above_200k_tokens")),
    ("outputCostPerTokenAbove200kTokens", Some("output_cost_per_token_above_200k_tokens")),
    ("cacheCreationInputTokenCostAbove200kTokens", Some("cache_creation_input_token_cost_above_200k_tokens")),
    ("cacheReadInputTokenCostAbove200kTokens", Some("cache_read_input_token_cost_above_200k_tokens")),
    ("maxInputTokens", Some("max_input_tokens")),
    ("fastMultiplier", None),
];
const BASE: [&str; 4] = ["inputCostPerToken", "outputCostPerToken", "cacheCreationInputTokenCost", "cacheReadInputTokenCost"];
const PROVENANCE: [&str; 3] = ["source", "why", "added"];

fn field(k: &str) -> Option<Option<&'static str>> {
    FIELDS.iter().find(|(f, _)| *f == k).map(|(_, l)| *l)
}

fn shipped() -> PathBuf {
    crew_home().join("config").join(NAME)
}

pub fn local_dir() -> PathBuf {
    crew_local()
}

fn cache_dir() -> PathBuf {
    home_cache().join("ccusage")
}

/// A non-negative finite number that is not a bool.
fn is_num(v: &Value) -> bool {
    matches!(v, Value::Number(n) if n.as_f64().map(|f| f.is_finite() && f >= 0.0).unwrap_or(false))
}

/// Raw {model: entry} from a ccusage-shaped config, or {}.
pub fn entries(cfg: &Value) -> Map<String, Value> {
    cfg.get("defaults")
        .filter(|d| d.is_object())
        .and_then(|d| d.get("pricingOverrides"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Only what ccusage accepts: known fields with numeric values.
pub fn clean(raw: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (model, e) in raw {
        let Some(e) = e.as_object() else { continue };
        let fields: Map<String, Value> =
            e.iter().filter(|(k, v)| field(k).is_some() && is_num(v)).map(|(k, v)| (k.clone(), v.clone())).collect();
        if !fields.is_empty() {
            out.insert(model.clone(), Value::Object(fields));
        }
    }
    out
}

/// What clean() would drop, said plainly.
pub fn problems(raw: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for (model, e) in raw {
        let Some(e) = e.as_object() else {
            out.push(format!("{model}: not an object"));
            continue;
        };
        for (k, v) in e {
            if PROVENANCE.contains(&k.as_str()) {
                continue;
            }
            if field(k).is_none() {
                out.push(format!("{model}: {k} is not a ccusage price field — ignored"));
            } else if !is_num(v) {
                out.push(format!(
                    "{model}: {k} is not a non-negative number — dropped (passed on, ccusage would ignore every override)"
                ));
            }
        }
    }
    out
}

/// (raw entries, error). A missing file is ({}, None), not an error.
pub fn load(path: &Path) -> (Map<String, Value>, Option<String>) {
    let text = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Map::new(), None),
        Err(e) => return (Map::new(), Some(py::os_error(&e, path))),
    };
    let text = match String::from_utf8(text) {
        Ok(t) => t,
        Err(e) => return (Map::new(), Some(format!("UnicodeDecodeError: {e}"))),
    };
    match serde_json::from_str::<Value>(&text) {
        Err(e) => (Map::new(), Some(format!("JSONDecodeError: {e}"))),
        Ok(v) if !v.is_object() => (Map::new(), Some("not a JSON object".into())),
        Ok(v) => (entries(&v), None),
    }
}

/// Local entries win over shipped ones, per model and wholesale.
pub fn merge(shipped: &Map<String, Value>, local: &Map<String, Value>) -> Map<String, Value> {
    let mut out = shipped.clone();
    for (k, v) in local {
        out.insert(k.clone(), v.clone());
    }
    out
}

pub fn effective() -> Map<String, Value> {
    let (s, _) = load(&shipped());
    let (l, _) = load(&local_dir().join(NAME));
    clean(&merge(&s, &l))
}

/// The config ccusage would have found on its own: ./.ccusage/ccusage.json,
/// then ccusage.json in each Claude dir ($CLAUDE_CONFIG_DIR, comma-separated,
/// else ~/.config/claude then ~/.claude). The first that exists wins.
pub fn discovered(cwd: Option<&Path>) -> Option<Value> {
    let cwd = cwd.map(Path::to_path_buf).or_else(|| std::env::current_dir().ok()).unwrap_or_default();
    let mut cands = vec![cwd.join(".ccusage/ccusage.json")];
    let env = std::env::var("CLAUDE_CONFIG_DIR").unwrap_or_default();
    let env = env.trim();
    if !env.is_empty() {
        cands.extend(env.split(',').map(str::trim).filter(|d| !d.is_empty()).map(|d| Path::new(d).join("ccusage.json")));
    } else {
        cands.push(home().join(".config/claude/ccusage.json"));
        cands.push(home().join(".claude/ccusage.json"));
    }
    for p in cands {
        if p.is_file() {
            return std::fs::read_to_string(&p)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .filter(Value::is_object);
        }
    }
    None
}

/// Pure: the user's config with crew's entries merged over it, field-wise.
pub fn build(overrides: &Map<String, Value>, user: Option<&Value>) -> Value {
    let mut cfg = user.filter(|u| u.is_object()).cloned().unwrap_or_else(|| json!({}));
    let o = cfg.as_object_mut().unwrap();
    if !o.get("defaults").map(Value::is_object).unwrap_or(false) {
        o.insert("defaults".into(), json!({}));
    }
    let d = o.get_mut("defaults").unwrap().as_object_mut().unwrap();
    let mut po = d.get("pricingOverrides").and_then(Value::as_object).cloned().unwrap_or_default();
    for (model, e) in overrides {
        let mut mine = po.get(model).and_then(Value::as_object).cloned().unwrap_or_default();
        for (k, v) in e.as_object().into_iter().flatten() {
            mine.insert(k.clone(), v.clone());
        }
        po.insert(model.clone(), Value::Object(mine));
    }
    d.insert("pricingOverrides".into(), Value::Object(po));
    cfg
}

fn write(cfg: &Value) -> std::io::Result<PathBuf> {
    let body = pyjson::dumps_with(cfg, Opts { indent: Some(1), sort_keys: true, compact: false });
    let digest = Sha256::digest(body.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let dir = cache_dir();
    let path = dir.join(format!("config-{}.json", &hex[..16]));
    if path.is_file() {
        // Still in use: keep it younger than the prune below.
        let _ = std::fs::File::options().append(true).open(&path).and_then(|f| f.set_modified(std::time::SystemTime::now()));
        return Ok(path);
    }
    py::write_atomic(&path, body.as_bytes())?;
    let cutoff = py::now() - 7.0 * 86400.0;
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if e.path() != path && n.starts_with("config-") && n.ends_with(".json") {
            if let Ok(m) = e.metadata() {
                if py::mtime(&m) < cutoff {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    Ok(path)
}

/// ["--config", path] when crew has an override to apply, else [].
pub fn config_args(cwd: Option<&Path>) -> Vec<String> {
    let ov = effective();
    if ov.is_empty() {
        return vec![];
    }
    match write(&build(&ov, discovered(cwd).as_ref())) {
        Ok(p) => vec!["--config".into(), p.display().to_string()],
        Err(_) => vec![],
    }
}

/// ccusage's own cached LiteLLM table, never fetched: doctor stays off the network.
pub fn litellm_cache() -> Option<Map<String, Value>> {
    let base = env_or("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".cache"));
    let dir = base.join("ccusage/http-cache");
    let prefix = "raw.githubusercontent.com-BerriAI-litellm-main-model_prices";
    let mut files: Vec<(f64, PathBuf)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with(prefix) && n.ends_with(".cache")
        })
        .filter_map(|e| e.metadata().ok().map(|m| (py::mtime(&m), e.path())))
        .collect();
    files.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    for (_, f) in files.iter().rev() {
        let Ok(t) = std::fs::read_to_string(f) else { continue };
        let rest = t.split_once('\n').map(|x| x.1).unwrap_or("");
        if let Ok(Value::Object(table)) = serde_json::from_str::<Value>(rest) {
            return Some(table);
        }
    }
    None
}

fn same(a: f64, b: f64) -> bool {
    // math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-15)
    a == b || (a - b).abs() <= (1e-9 * a.abs().max(b.abs())).max(1e-15)
}

/// Pure: each override against upstream's entry for the same model.
pub fn compare(overrides: &Map<String, Value>, upstream: Option<&Map<String, Value>>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(up_table) = upstream else {
        if !overrides.is_empty() {
            out.push(("note".into(), "no ccusage price cache to compare against (run ccusage once) — skipped".into()));
        }
        return out;
    };
    let mut models: Vec<&String> = overrides.keys().collect();
    models.sort();
    for model in models {
        let e = overrides[model].as_object().cloned().unwrap_or_default();
        let up = [model.clone(), format!("anthropic/{model}")]
            .iter()
            .find_map(|k| up_table.get(k).and_then(Value::as_object).cloned());
        let Some(up) = up else {
            let missing: Vec<&str> = BASE.iter().copied().filter(|f| !e.contains_key(*f)).collect();
            let mut msg = format!("{model}: upstream has no entry — the override is filling a gap");
            if !missing.is_empty() {
                msg += &format!(" (unset fields price at $0: {})", missing.join(", "));
            }
            out.push((if missing.is_empty() { "note" } else { "warn" }.into(), msg));
            continue;
        };
        let (mut diffs, mut nothing) = (Vec::new(), Vec::new());
        let mut keys: Vec<&String> = e.keys().collect();
        keys.sort();
        for f in keys {
            let v = &e[f];
            let lname = field(f).flatten();
            let u = lname.and_then(|l| up.get(l));
            match (lname, u) {
                (Some(_), Some(u)) if is_num(u) => {
                    let (vf, uf) = (v.as_f64().unwrap_or(0.0), u.as_f64().unwrap_or(0.0));
                    if !same(vf, uf) {
                        diffs.push(format!("{f} {} (upstream {})", percent_g(vf), percent_g(uf)));
                    }
                }
                _ => nothing.push(f.clone()),
            }
        }
        if diffs.is_empty() && nothing.is_empty() {
            out.push(("warn".into(), format!("override for {model} now matches upstream — remove it")));
        } else if !diffs.is_empty() {
            out.push(("note".into(), format!("{model}: override differs from upstream: {}", diffs.join("; "))));
        }
        if !nothing.is_empty() {
            out.push(("note".into(), format!("{model}: upstream has no {} to compare", nothing.join(", "))));
        }
    }
    out
}

pub fn doctor_lines() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (label, path) in [("shipped", shipped()), ("crew-local", local_dir().join(NAME))] {
        let (raw, err) = load(&path);
        if let Some(err) = err {
            out.push(("bad".into(), format!("{label} {NAME} is unreadable ({err}) — its overrides are ignored")));
        }
        for p in problems(&raw) {
            out.push(("warn".into(), format!("{label} {NAME}: {p}")));
        }
    }
    let ov = effective();
    if ov.is_empty() {
        out.push(("note".into(), "ccusage pricing: no crew overrides — ccusage's own prices apply".into()));
        return out;
    }
    let mut names: Vec<&String> = ov.keys().collect();
    names.sort();
    out.push((
        "ok".into(),
        format!("ccusage pricing overrides: {}", names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")),
    ));
    out.extend(compare(&ov, litellm_cache().as_ref()));
    out
}

const DOC: &str = "Crew-owned ccusage pricing overrides: published prices for named models.

    pricing.py --args                     the args, as JSON (probe)
    pricing.py --merge SHIPPED LOCAL      effective overrides, as JSON (probe)
    pricing.py --compare OVR.json UP.json compare(), as JSON (probe)
    pricing.py --doctor                   tab-separated level/message lines
";

fn read_json(path: &str) -> Result<Value, String> {
    let t = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&t).map_err(|e| e.to_string())
}

pub fn main(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.first().copied() {
        Some("--args") => println!("{}", pyjson::dumps(&json!(config_args(None)))),
        Some("--merge") if a.len() >= 3 => {
            let m = clean(&merge(&load(Path::new(a[1])).0, &load(Path::new(a[2])).0));
            println!("{}", pyjson::dumps_with(&Value::Object(m), Opts { sort_keys: true, ..Opts::default() }));
        }
        Some("--compare") if a.len() >= 2 => {
            let ov = match read_json(a[1]) {
                Ok(Value::Object(o)) => o,
                Ok(_) => Map::new(),
                Err(e) => {
                    eprintln!("pricing: {e}");
                    return 1;
                }
            };
            let up = if a.len() > 2 && a[2] != "-" {
                match read_json(a[2]) {
                    Ok(Value::Object(o)) => Some(o),
                    Ok(_) => Some(Map::new()),
                    Err(e) => {
                        eprintln!("pricing: {e}");
                        return 1;
                    }
                }
            } else {
                None
            };
            let pairs: Vec<Value> = compare(&ov, up.as_ref()).into_iter().map(|(l, m)| json!([l, m])).collect();
            println!("{}", pyjson::dumps(&Value::Array(pairs)));
        }
        Some("--doctor") => {
            for (lvl, msg) in doctor_lines() {
                println!("{lvl}\t{msg}");
            }
        }
        _ => {
            println!("{DOC}");
            return 2;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_keeps_numbers_only() {
        let raw = json!({"m": {"inputCostPerToken": 1e-6, "source": "x", "outputCostPerToken": "cheap"}, "n": 3});
        let c = clean(raw.as_object().unwrap());
        assert_eq!(Value::Object(c), json!({"m": {"inputCostPerToken": 1e-6}}));
        let p = problems(raw.as_object().unwrap());
        assert_eq!(p.len(), 2, "{p:?}");
    }

    #[test]
    fn build_merges_field_wise_over_the_user() {
        let user = json!({"x": 1, "defaults": {"pricingOverrides": {"m": {"inputCostPerToken": 1, "outputCostPerToken": 2}}}});
        let ov = json!({"m": {"inputCostPerToken": 5}});
        let cfg = build(ov.as_object().unwrap(), Some(&user));
        assert_eq!(cfg["defaults"]["pricingOverrides"]["m"], json!({"inputCostPerToken": 5, "outputCostPerToken": 2}));
        assert_eq!(cfg["x"], 1);
    }

    #[test]
    fn compare_names_what_differs() {
        let ov = json!({"m": {"inputCostPerToken": 3e-6, "fastMultiplier": 2}});
        let up = json!({"anthropic/m": {"input_cost_per_token": 1.5e-5}});
        let got = compare(ov.as_object().unwrap(), up.as_object());
        assert_eq!(got[0].1, "m: override differs from upstream: inputCostPerToken 3e-06 (upstream 1.5e-05)");
        assert_eq!(got[1].1, "m: upstream has no fastMultiplier to compare");
    }
}
