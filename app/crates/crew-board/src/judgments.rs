//! Turn-end TypeSafe judgments for the board, cached. Policy lives here
//! (crew/board/judgments.py).
//!
//!   record(cwd, size, values)          writer, called by hooks/asked.sh
//!   fresh_map(now)                     reader: {cwd: entry}, freshness applied
//!   stuck_for(w, jmap) / urgency_for   what rank() consults
//!
//!   seamux judgments --record CWD SIZE [BLOCKED]   values JSON on stdin
//!   seamux judgments --apply FIXTURE.json          pure policy over a fixture
//!
//! The board only ever reads this file, so a push never waits on the
//! network. A judgment is ignored mid-turn (it is about a turn that ended)
//! and after the TTL; anything missing leaves the board as if TypeSafe had
//! never been heard of.

use std::io::Read;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crew_core::{py, pyjson};

use crate::pyval::{get, parse_float, parse_int, py_float, truthy};

pub const GC_AGE: f64 = 172800.0; // writer-side, 48h
pub const STUCK_DEFAULT: f64 = 0.8;

const DOC: &str = "Turn-end TypeSafe judgments for the board, cached. Policy lives HERE.

    record(cwd, size, values)          writer — called by hooks/asked.sh
    fresh_map(now)                     reader — {cwd: entry}, freshness applied
    stuck_for(w, jmap) / urgency_for   what rank() actually consults

    judgments.py --record CWD SIZE     values JSON on stdin (the asked.sh CLI)
    judgments.py --apply FIXTURE.json  pure policy over a fixture, for the probe
";

/// The cache: CREW_JUDGMENTS_FILE (probes only), else ~/.cache/cmux-crew/judgments.json.
pub fn cache_path() -> PathBuf {
    match py::env_or("CREW_JUDGMENTS_FILE") {
        Some(p) => PathBuf::from(p),
        None => py::home().join(".cache").join("cmux-crew").join("judgments.json"),
    }
}

/// How long a turn-end judgment stays credible: CREW_JUDGMENT_TTL, else 6h.
pub fn ttl() -> f64 {
    std::env::var("CREW_JUDGMENT_TTL")
        .ok()
        .and_then(|s| parse_int(&s))
        .map(|n| n as f64)
        .unwrap_or(21600.0)
}

/// From integrations.json via the shared client; degrades to the default.
pub fn stuck_threshold() -> f64 {
    crew_core::typesafe::threshold("stuck_threshold", STUCK_DEFAULT)
}

fn load() -> Map<String, Value> {
    std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| match v {
            Value::Object(o) => Some(o),
            _ => None,
        })
        .unwrap_or_default()
}

/// Read-modify-write one entry under an flock on `<cache>.lock`, so turn-ends
/// in the same instant keep each other's entries; atomic replace; drop
/// entries older than GC_AGE.
pub fn record(cwd: &str, size: i64, values: &Map<String, Value>, now: Option<f64>) -> Result<(), String> {
    let path = cache_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| py::os_error(&e, dir))?;
    }
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    let _held = py::Flock::exclusive(&lock).map_err(|e| py::os_error(&e, &lock))?;
    let now = match now {
        Some(n) if n != 0.0 => n,
        _ => py::now(),
    };
    let mut cache = load();
    let mut entry = Map::new();
    entry.insert("at".into(), pyjson::float(now));
    entry.insert("transcript_size".into(), json!(size));
    for k in ["blocked", "stuck", "urgency"] {
        if let Some(v) = values.get(k) {
            let f = py_float(v).ok_or_else(|| format!("could not convert {k} to float"))?;
            entry.insert(k.into(), pyjson::float(f));
        }
    }
    cache.insert(cwd.to_string(), Value::Object(entry));
    let old: Vec<String> = cache
        .iter()
        .filter(|(_, v)| {
            let at = v.get("at").filter(|a| truthy(a)).and_then(py_float).unwrap_or(0.0);
            now - at > GC_AGE
        })
        .map(|(k, _)| k.clone())
        .collect();
    for k in old {
        cache.remove(&k);
    }
    py::write_atomic(&path, pyjson::dumps(&Value::Object(cache)).as_bytes())
        .map_err(|e| py::os_error(&e, &path))
}

/// {cwd: entry} for entries young enough to still mean something.
pub fn fresh_map(now: Option<f64>, cache: Option<&Map<String, Value>>) -> Map<String, Value> {
    let now = match now {
        Some(n) if n != 0.0 => n,
        _ => py::now(),
    };
    let loaded;
    let cache = match cache {
        Some(c) => c,
        None => {
            loaded = load();
            &loaded
        }
    };
    let ttl = ttl();
    let mut out = Map::new();
    for (cwd, e) in cache {
        let at = match e.get("at") {
            None => Some(0.0),
            Some(v) => py_float(v),
        };
        if let Some(at) = at {
            if now - at <= ttl {
                out.insert(cwd.clone(), e.clone());
            }
        }
    }
    out
}

fn cwd_of(w: &Value) -> String {
    match get(w, "cwd") {
        Value::String(s) => s.clone(),
        v if !truthy(v) => String::new(),
        v => crate::pyval::py_str(v),
    }
}

/// Should this workspace's row read as stuck? Never mid-turn.
pub fn stuck_for(w: &Value, jmap: &Map<String, Value>, threshold: Option<f64>) -> bool {
    if truthy(get(w, "running")) {
        return false;
    }
    let e = match jmap.get(&cwd_of(w)) {
        Some(e) if truthy(e) => e,
        _ => return false,
    };
    let t = threshold.unwrap_or_else(stuck_threshold);
    match e.get("stuck") {
        None => 0.0 >= t,
        Some(v) => py_float(v).map_or(false, |s| s >= t),
    }
}

/// The within-tier sort key; 0 when unknown, so unjudged rows keep their order.
pub fn urgency_for(w: &Value, jmap: &Map<String, Value>) -> f64 {
    match jmap.get(&cwd_of(w)) {
        Some(e) if truthy(e) => match e.get("urgency") {
            None => 0.0,
            Some(v) => py_float(v).unwrap_or(0.0),
        },
        _ => 0.0,
    }
}

/// Pure: the whole policy over explicit inputs. {cwd: {stuck, urgency}}.
pub fn apply(workspaces: &[Value], cache: &Map<String, Value>, now: f64, threshold: f64) -> Value {
    let jmap = fresh_map(Some(now), Some(cache));
    let mut out = Map::new();
    for w in workspaces {
        // A dict key as json.dumps writes it: None and booleans in JSON's spelling.
        let key = match w.get("cwd") {
            None => String::new(),
            Some(Value::Null) => "null".into(),
            Some(Value::Bool(b)) => b.to_string(),
            Some(v) => crate::pyval::py_str(v),
        };
        out.insert(key, json!({"stuck": stuck_for(w, &jmap, Some(threshold)),
                               "urgency": pyjson::float(urgency_for(w, &jmap))}));
    }
    Value::Object(out)
}

pub fn main(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    if a.first() == Some(&"--record") && a.len() >= 3 {
        let mut input = String::new();
        let _ = std::io::stdin().read_to_string(&mut input);
        let mut vals = match serde_json::from_str::<Value>(if input.is_empty() { "{}" } else { &input }) {
            Ok(Value::Object(o)) => o,
            Ok(_) => Map::new(),
            Err(e) => {
                eprintln!("judgments: values on stdin are not JSON: {e}");
                return 1;
            }
        };
        if a.len() > 3 {
            if let Some(b) = parse_float(a[3]) {
                vals.insert("blocked".into(), pyjson::float(b));
            }
        }
        // int(size or 0): an empty size is 0, anything not an integer is an error.
        let size = if a[2].is_empty() { Some(0) } else { parse_int(a[2]) };
        let size = match size {
            Some(s) => s,
            None => {
                eprintln!("judgments: invalid size {:?}", a[2]);
                return 1;
            }
        };
        return match record(a[1], size, &vals, None) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("judgments: {e}");
                1
            }
        };
    }
    if a.first() == Some(&"--apply") && a.len() >= 2 {
        let fx: Value = match std::fs::read_to_string(a[1]).map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("judgments: {}: {e}", a[1]);
                return 1;
            }
        };
        let wss = get(&fx, "workspaces").as_array().cloned().unwrap_or_default();
        let cache = get(&fx, "cache").as_object().cloned().unwrap_or_default();
        let now = match get(&fx, "now") {
            v if truthy(v) => py_float(v).unwrap_or(0.0),
            _ => py::now(),
        };
        let threshold = match fx.get("threshold") {
            None => STUCK_DEFAULT,
            Some(v) => py_float(v).unwrap_or(STUCK_DEFAULT),
        };
        println!("{}", pyjson::dumps(&apply(&wss, &cache, now, threshold)));
        return 0;
    }
    eprint!("{DOC}");
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_over_a_fixture() {
        let now = 1_000_000.0;
        let cache = json!({
            "/w/stuck":  {"at": now - 60.0, "stuck": 0.93, "urgency": 2.8},
            "/w/typing": {"at": now - 60.0, "stuck": 0.93, "urgency": 2.8},
            "/w/old":    {"at": now - 100000.0, "stuck": 0.99, "urgency": 3.0},
        });
        let wss = vec![json!({"cwd": "/w/stuck", "running": false}),
                       json!({"cwd": "/w/typing", "running": true}),
                       json!({"cwd": "/w/old", "running": false}),
                       json!({"cwd": "/w/none", "running": false})];
        let r = apply(&wss, cache.as_object().unwrap(), now, STUCK_DEFAULT);
        assert_eq!(r["/w/stuck"], json!({"stuck": true, "urgency": 2.8}));
        assert_eq!(r["/w/typing"]["stuck"], json!(false));
        assert_eq!(r["/w/old"], json!({"stuck": false, "urgency": 0.0}));
        assert_eq!(r["/w/none"], json!({"stuck": false, "urgency": 0.0}));
    }
}
