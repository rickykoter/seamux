//! `crew-plugin-root <plugin-name>`: the directory Claude Code runs an
//! installed plugin from, or nothing (exit 1).
//!
//! installed_plugins.json's `installPath` is not always that directory: for a
//! plugin whose marketplace is a local folder, Claude reads the plugin from
//! the folder itself. So a directory marketplace gives its folder plus the
//! plugin's `source` from that folder's marketplace.json, and anything else
//! gives `installPath`. CLAUDE_CONFIG_DIR is honoured as Claude honours it.
//!
//! Where the Python would raise on a malformed file (a list where it expects
//! an object), this exits 1 with nothing on stdout, as the Python does.

use std::path::Path;

use crew_core::py::{env_or, home};
use serde_json::{Map, Value};

use crate::pyerr;

const USAGE: &str = "    crew-plugin-root <plugin-name>       prints the root, or nothing (exit 1)";

/// What a Python TypeError/AttributeError would have stopped on: the
/// exception line, for stderr.
pub struct Raise(pub String);

pub fn main(args: &[String]) -> i32 {
    if args.len() != 1 {
        eprintln!("{USAGE}");
        return 2;
    }
    match plugin_root(&args[0], None) {
        Ok(root) if !root.is_empty() => {
            println!("{root}");
            0
        }
        Ok(_) => 1,
        Err(Raise(m)) => pyerr::crash(&m),
    }
}

/// `json.load(open(path)) or {}`, and `{}` when the file is missing or bad.
fn load(path: &str) -> Value {
    let Ok(bytes) = std::fs::read(path) else { return Value::Object(Map::new()) };
    let Ok(text) = String::from_utf8(bytes) else { return Value::Object(Map::new()) };
    match serde_json::from_str::<Value>(&text) {
        Ok(v) if truthy(&v) => v,
        _ => Value::Object(Map::new()),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `d.get(key)` on something that must be a dict.
fn get<'a>(d: &'a Value, key: &str) -> Result<Option<&'a Value>, Raise> {
    match d {
        Value::Object(o) => Ok(o.get(key)),
        other => Err(Raise(format!("AttributeError: '{}' object has no attribute 'get'", type_name(other)))),
    }
}

/// `d.get(key) or default`: the value when truthy.
fn get_truthy<'a>(d: &'a Value, key: &str) -> Result<Option<&'a Value>, Raise> {
    Ok(get(d, key)?.filter(|v| truthy(v)))
}

/// `for x in (v or [])`: the items of a list. Anything else truthy is a
/// string, dict or number, whose iteration ends in a raise on the next line.
fn items(v: Option<&Value>) -> Result<Vec<&Value>, Raise> {
    match v {
        None => Ok(vec![]),
        Some(Value::Array(a)) => Ok(a.iter().collect()),
        Some(Value::Object(o)) if !o.is_empty() => {
            Err(Raise("AttributeError: 'str' object has no attribute 'get'".into()))
        }
        Some(Value::String(_)) => Err(Raise("AttributeError: 'str' object has no attribute 'get'".into())),
        Some(other) => Err(Raise(format!("TypeError: '{}' object is not iterable", type_name(other)))),
    }
}

/// A path string as `os.path.join` takes it; anything else is a TypeError.
fn path_str(v: Option<&Value>) -> Result<&str, Raise> {
    match v {
        None => Ok(""),
        Some(Value::String(s)) => Ok(s),
        Some(other) => Err(Raise(format!(
            "TypeError: expected str, bytes or os.PathLike object, not {}",
            type_name(other)
        ))),
    }
}

pub fn plugin_root(name: &str, config_dir: Option<&str>) -> Result<String, Raise> {
    let cfg = config_dir
        .filter(|c| !c.is_empty())
        .map(String::from)
        .or_else(|| env_or("CLAUDE_CONFIG_DIR"))
        .unwrap_or_else(|| join(&home().to_string_lossy(), ".claude"));
    let installed = load(&join(&cfg, "plugins/installed_plugins.json"));
    let plugins = get_truthy(&installed, "plugins")?;
    let markets = load(&join(&cfg, "plugins/known_marketplaces.json"));
    let plugins = match plugins {
        None => return Ok(String::new()),
        Some(Value::Object(o)) => o,
        Some(other) => {
            return Err(Raise(format!("AttributeError: '{}' object has no attribute 'items'", type_name(other))))
        }
    };
    for (key, installs) in plugins {
        let (pname, market) = key.split_once('@').unwrap_or((key.as_str(), ""));
        if pname != name {
            continue;
        }
        let empty = Value::Object(Map::new());
        let m = get_truthy(&markets, market)?.unwrap_or(&empty);
        let source = get_truthy(m, "source")?.unwrap_or(&empty);
        if get(source, "source")? == Some(&Value::String("directory".into())) {
            let folder = match get_truthy(m, "installLocation")? {
                Some(v) => path_str(Some(v))?,
                None => path_str(get_truthy(source, "path")?)?,
            };
            let market_json = load(&join(folder, ".claude-plugin/marketplace.json"));
            for e in items(get_truthy(&market_json, "plugins")?)? {
                let src = get(e, "source")?;
                if get(e, "name")? == Some(&Value::String(name.into())) {
                    if let Some(Value::String(src)) = src {
                        let root = normpath(&join(folder, src));
                        if Path::new(&root).is_dir() {
                            return Ok(root);
                        }
                    }
                }
            }
        }
        for inst in items(Some(installs).filter(|v| truthy(v)))? {
            match get_truthy(inst, "installPath")? {
                Some(Value::String(p)) if Path::new(p).is_dir() => return Ok(p.clone()),
                // os.path.isdir takes an int as a file descriptor (never a
                // plugin directory) and raises on anything else.
                Some(v @ (Value::Array(_) | Value::Object(_))) => {
                    return Err(Raise(format!(
                        "TypeError: stat: path should be string, bytes, os.PathLike or integer, not {}",
                        type_name(v)
                    )))
                }
                Some(Value::Number(n)) if n.is_f64() => {
                    return Err(Raise(
                        "TypeError: stat: path should be string, bytes, os.PathLike or integer, not float".into(),
                    ))
                }
                _ => {}
            }
        }
    }
    Ok(String::new())
}

/// `os.path.join(a, b)` for two parts.
fn join(a: &str, b: &str) -> String {
    if b.starts_with('/') || a.is_empty() {
        b.to_string()
    } else if a.ends_with('/') {
        format!("{a}{b}")
    } else {
        format!("{a}/{b}")
    }
}

/// `os.path.normpath`, POSIX: lexical, keeps a leading `//`, never touches disk.
fn normpath(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let lead = if p.starts_with("//") && !p.starts_with("///") {
        2
    } else if p.starts_with('/') {
        1
    } else {
        0
    };
    let mut parts: Vec<&str> = Vec::new();
    for c in p.split('/') {
        if c.is_empty() || c == "." {
            continue;
        }
        if c != ".." || (lead == 0 && parts.is_empty()) || parts.last() == Some(&"..") {
            parts.push(c);
        } else if !parts.is_empty() {
            parts.pop();
        }
    }
    let out = "/".repeat(lead) + &parts.join("/");
    if out.is_empty() {
        ".".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normpath_matches_posixpath() {
        for (i, o) in [
            ("", "."),
            ("/", "/"),
            ("//", "//"),
            ("///", "/"),
            ("a/./b/../c", "a/c"),
            ("../a", "../a"),
            ("/../a", "/a"),
            ("a/../..", ".."),
            ("/x/y/", "/x/y"),
            ("//x/../y", "//y"),
        ] {
            assert_eq!(normpath(i), o, "{i}");
        }
    }

    #[test]
    fn join_matches_os_path_join() {
        assert_eq!(join("", "x"), "x");
        assert_eq!(join("/a/", "x"), "/a/x");
        assert_eq!(join("/a", "/abs"), "/abs");
    }

    fn tree() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("crew-cli-pr-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("plugins")).unwrap();
        d
    }

    #[test]
    fn directory_marketplace_wins_over_install_path() {
        let d = tree();
        let mkt = d.join("mkt");
        std::fs::create_dir_all(mkt.join(".claude-plugin")).unwrap();
        std::fs::create_dir_all(mkt.join("crew")).unwrap();
        std::fs::create_dir_all(d.join("cache/crew")).unwrap();
        let m = mkt.to_string_lossy();
        std::fs::write(mkt.join(".claude-plugin/marketplace.json"), r#"{"plugins":[{"name":"crew","source":"./crew"}]}"#).unwrap();
        std::fs::write(
            d.join("plugins/known_marketplaces.json"),
            format!(r#"{{"seamux":{{"source":{{"source":"directory","path":"{m}"}}}}}}"#),
        )
        .unwrap();
        let cache = d.join("cache/crew");
        std::fs::write(
            d.join("plugins/installed_plugins.json"),
            format!(r#"{{"plugins":{{"crew@seamux":[{{"installPath":"{}"}}]}}}}"#, cache.display()),
        )
        .unwrap();
        let cfg = d.to_string_lossy().to_string();
        assert_eq!(plugin_root("crew", Some(&cfg)).ok(), Some(format!("{m}/crew")));
        assert_eq!(plugin_root("nobody", Some(&cfg)).ok(), Some(String::new()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_list_install_path_raises_before_a_later_good_one() {
        let d = tree();
        let good = d.join("good");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            d.join("plugins/installed_plugins.json"),
            format!(r#"{{"plugins":{{"crew@x":[{{"installPath":["q"]}},{{"installPath":"{}"}}]}}}}"#, good.display()),
        )
        .unwrap();
        let cfg = d.to_string_lossy().to_string();
        assert!(plugin_root("crew", Some(&cfg)).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_list_where_a_dict_belongs_raises() {
        let d = tree();
        std::fs::write(d.join("plugins/installed_plugins.json"), r#"{"plugins":{"crew@x":"oops"}}"#).unwrap();
        let cfg = d.to_string_lossy().to_string();
        assert!(plugin_root("crew", Some(&cfg)).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
