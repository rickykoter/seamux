//! `seamux options`: crew/hooks/options.py in Rust. Renders the crew plugin's
//! options into integrations.json.
//!
//! ```text
//! seamux options [--from-settings [SETTINGS]] [--out PATH] [--get KEY]
//! ```
//!
//! Same sources (CLAUDE_PLUGIN_OPTION_<KEY>, or settings.json's
//! pluginConfigs["crew@..."].options), same rendering, same bytes, and the
//! same rule: write only when the text changes, through `<out>.tmp-<pid>`.
//! Exit 0 always except on usage (2) and on input Python would crash on (1).

use std::path::{Path, PathBuf};

use crew_core::py::{env_or, home};
use serde_json::{json, Map, Value};

use crate::pyval::{self, str_of, str_or, strip, truthy};

const KEYS: &[&str] = &["jira_site", "github_issues", "observability_stack", "main_repo", "sweep_dormant_days"];
const STACKS: &[&str] = &["datadog", "splunk", "grafana"];
pub const MARK: &str = "crew plugin options (crew/hooks/options.py)";
const USAGE: &str = "    options.py [--from-settings [SETTINGS]] [--out PATH] [--get KEY]";

type Opts = Map<String, Value>;

fn from_env() -> Opts {
    let mut out = Map::new();
    for k in KEYS {
        if let Ok(v) = std::env::var(format!("CLAUDE_PLUGIN_OPTION_{}", k.to_uppercase())) {
            out.insert(k.to_string(), Value::String(v));
        }
    }
    out
}

/// Err is the crash Python would have (the message for stderr).
fn from_settings(path: &Path) -> Result<Opts, String> {
    let Ok(Ok(text)) = pyval::read_text(path) else { return Ok(Map::new()) };
    let Ok(s) = pyval::loads(&text) else { return Ok(Map::new()) };
    if !truthy(&s) {
        return Ok(Map::new());
    }
    let Value::Object(s) = s else {
        return Err(format!("AttributeError: '{}' object has no attribute 'get'", pyval::type_name(&s)));
    };
    let configs = match s.get("pluginConfigs") {
        Some(v) if truthy(v) => v,
        _ => return Ok(Map::new()),
    };
    let Value::Object(configs) = configs else {
        return Err(format!("AttributeError: '{}' object has no attribute 'items'", pyval::type_name(configs)));
    };
    for (key, cfg) in configs {
        if key.split('@').next() == Some("crew") {
            if let Value::Object(cfg) = cfg {
                return match cfg.get("options") {
                    Some(Value::Object(o)) => Ok(o.clone()),
                    Some(v) if truthy(v) => dict_of(v),
                    _ => Ok(Map::new()),
                };
            }
        }
    }
    Ok(Map::new())
}

/// `dict(v)` for a non-dict: a list of two-item lists works, the rest raise.
fn dict_of(v: &Value) -> Result<Opts, String> {
    let mut out = Map::new();
    if let Value::Array(items) = v {
        for (i, it) in items.iter().enumerate() {
            match it {
                Value::Array(kv) if kv.len() == 2 => {
                    let Value::String(k) = &kv[0] else {
                        // a non-string key can never match an option name
                        continue;
                    };
                    out.insert(k.clone(), kv[1].clone());
                }
                Value::String(s) if s.chars().count() == 2 => {
                    let mut cs = s.chars();
                    let (k, v) = (cs.next().unwrap(), cs.next().unwrap());
                    out.insert(k.to_string(), Value::String(v.to_string()));
                }
                _ => {
                    return Err(format!(
                        "ValueError: dictionary update sequence element #{i} has length {}; 2 is required",
                        match it {
                            Value::Array(a) => a.len(),
                            Value::String(s) => s.chars().count(),
                            _ => 0,
                        }
                    ))
                }
            }
        }
        return Ok(out);
    }
    Err(match v {
        Value::String(_) => "ValueError: dictionary update sequence element #0 has length 1; 2 is required".into(),
        other => format!("TypeError: '{}' object is not iterable", pyval::type_name(other)),
    })
}

fn truthy_opt(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(true)) => true,
        Some(v) => matches!(strip(&str_of(v)).to_lowercase().as_str(), "true" | "1" | "yes" | "on"),
        None => false,
    }
}

/// sweep_dormant_days as whole days (decimal digits), at least 1; None when
/// unset or not a number.
fn dormant(opts: &Opts) -> Option<String> {
    let v = opts.get("sweep_dormant_days").cloned().unwrap_or(Value::Null);
    let f = pyval::parse_float(strip(&str_of(&v)))?;
    let d = pyval::int_digits(f)?;
    Some(if d.starts_with('-') || d == "0" { "1".into() } else { d })
}

fn is_default(opts: &Opts) -> bool {
    strip(&str_or(opts.get("jira_site"), "")).is_empty()
        && !truthy_opt(opts.get("github_issues"))
        && !STACKS.contains(&strip(&str_or(opts.get("observability_stack"), "none")))
        && dormant(opts).is_none_or(|d| d == "5")
}

fn render(current: &Opts, opts: &Opts) -> Opts {
    let mut cfg = current.clone();
    let site = strip(&str_or(opts.get("jira_site"), "")).to_string();
    if !site.is_empty() {
        cfg.insert("jira".into(), json!({"enabled": true, "site": site}));
    } else {
        cfg.shift_remove("jira");
    }
    if truthy_opt(opts.get("github_issues")) {
        cfg.insert("github_issues".into(), json!({"enabled": true}));
    } else {
        cfg.shift_remove("github_issues");
    }
    let stack = strip(&str_or(opts.get("observability_stack"), "")).to_string();
    if STACKS.contains(&stack.as_str()) {
        cfg.insert(
            "observability".into(),
            json!({"enabled": true, "stack": stack, "note": "read-only for planning; keys come from env at read time"}),
        );
    } else {
        cfg.shift_remove("observability");
    }
    match dormant(opts) {
        Some(d) => {
            cfg.insert("sweep".into(), json!({ "dormant_days": pyval::big_int(&d) }));
        }
        None => {
            cfg.shift_remove("sweep");
        }
    }
    cfg.insert("managedBy".into(), Value::String(MARK.into()));
    cfg
}

/// json.dumps(cfg, indent=2).
fn dumps(cfg: &Opts) -> String {
    pyval::dumps(&Value::Object(cfg.clone()), Some(2))
}

fn crash(msg: &str) -> i32 {
    eprintln!("Traceback (most recent call last):\n  File \"options.py\"\n{msg}");
    1
}

pub fn main(argv: &[String]) -> i32 {
    let home = home();
    let live = env_or("CREW_LIVE").map(PathBuf::from).unwrap_or_else(|| home.join(".config/cmux/crew"));
    let mut out = live.join("integrations.json");
    let mut settings: Option<PathBuf> = None;
    let mut get: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "--out" | "--get" => {
                let Some(v) = argv.get(i + 1) else { return crash("IndexError: list index out of range") };
                if a == "--out" {
                    out = PathBuf::from(v);
                } else {
                    get = Some(v.clone());
                }
                i += 2;
            }
            "--from-settings" => {
                let nxt = argv.get(i + 1).filter(|n| !n.starts_with("--"));
                let cfg_dir = env_or("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".claude"));
                settings = Some(match nxt.filter(|n| !n.is_empty()) {
                    Some(n) => PathBuf::from(n),
                    None => cfg_dir.join("settings.json"),
                });
                // An empty next argument counts as no value, so it is parsed
                // as the next flag (and refused), as the Python does.
                i += if nxt.is_some_and(|n| !n.is_empty()) { 2 } else { 1 };
            }
            _ => {
                eprintln!("{USAGE}");
                return 2;
            }
        }
    }

    let opts = match &settings {
        Some(p) => match from_settings(p) {
            Ok(o) => o,
            Err(m) => return crash(&m),
        },
        None => from_env(),
    };
    if let Some(key) = get {
        match opts.get(&key) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s.is_empty() => {}
            Some(v) => println!("{}", str_of(v)),
        }
        return 0;
    }
    if opts.is_empty() {
        return 0;
    }

    let (text, current) = match pyval::read_text(&out) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, Map::new()),
        Err(e) => {
            eprintln!("crew options: cannot read {}: {}; left as is", out.display(), pyval::os_error(&e, &out));
            return 0;
        }
        Ok(Err(decode)) => {
            eprintln!("crew options: cannot read {}: {decode}; left as is", out.display());
            return 0;
        }
        Ok(Ok(text)) => {
            let current = if strip(&text).is_empty() {
                Value::Object(Map::new())
            } else {
                match pyval::loads(&text) {
                    Ok(v) => v,
                    Err(m) => {
                        eprintln!("crew options: cannot read {}: {m}; left as is", out.display());
                        return 0;
                    }
                }
            };
            let current = match current {
                Value::Object(o) => o,
                _ => Map::new(),
            };
            (Some(text), current)
        }
    };

    if is_default(&opts) && current.get("managedBy").and_then(Value::as_str) != Some(MARK) {
        return 0; // nothing chosen yet; the old installer's answers stand
    }

    let new = dumps(&render(&current, &opts)) + "\n";
    if text.as_deref() == Some(new.as_str()) {
        return 0;
    }
    if let Err(e) = write(&out, &new) {
        eprintln!("crew options: cannot write {}: {e}", out.display());
    }
    0
}

/// makedirs, then `<out>.tmp-<pid>` and os.replace. The temp file is left
/// behind on a failed rename, as the Python leaves it.
fn write(out: &Path, body: &str) -> Result<(), String> {
    let dir = out.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| pyval::os_error(&e, dir))?;
    let tmp = PathBuf::from(format!("{}.tmp-{}", out.display(), std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| pyval::os_error(&e, &tmp))?;
    std::fs::rename(&tmp, out).map_err(|e| {
        // os.replace names both paths: [Errno 21] Is a directory: 'a' -> 'b'
        let one = pyval::os_error(&e, &tmp);
        format!("{one} -> {}", pyval::repr_str(&out.to_string_lossy()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(v: Value) -> Opts {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn dormant_days() {
        assert_eq!(dormant(&o(json!({"sweep_dormant_days": "9.7"}))).as_deref(), Some("9"));
        assert_eq!(dormant(&o(json!({"sweep_dormant_days": "0"}))).as_deref(), Some("1"));
        assert_eq!(dormant(&o(json!({"sweep_dormant_days": -3}))).as_deref(), Some("1"));
        assert_eq!(dormant(&o(json!({"sweep_dormant_days": "1e999"}))), None);
        assert_eq!(dormant(&o(json!({"sweep_dormant_days": ""}))), None);
        assert_eq!(dormant(&o(json!({}))), None);
        assert_eq!(dormant(&o(json!({"sweep_dormant_days": true}))), None);
    }

    #[test]
    fn big_days_print_as_digits() {
        let cfg = render(&Map::new(), &o(json!({"sweep_dormant_days": "1e20"})));
        assert!(dumps(&cfg).contains("\"dormant_days\": 100000000000000000000\n"));
    }

    #[test]
    fn render_keeps_other_keys_in_place() {
        let cur = o(json!({"jira": {"x": 1}, "typesafe": {"enabled": true}, "sweep": {}}));
        let got = render(&cur, &o(json!({"jira_site": " s ", "github_issues": "On"})));
        let keys: Vec<&str> = got.keys().map(String::as_str).collect();
        assert_eq!(keys, ["jira", "typesafe", "github_issues", "managedBy"]);
        assert_eq!(got["jira"], json!({"enabled": true, "site": "s"}));
    }

    #[test]
    fn defaults() {
        assert!(is_default(&o(json!({"jira_site": "", "sweep_dormant_days": "5", "observability_stack": "none"}))));
        assert!(!is_default(&o(json!({"github_issues": "1"}))));
        assert!(!is_default(&o(json!({"sweep_dormant_days": "4"}))));
    }
}
