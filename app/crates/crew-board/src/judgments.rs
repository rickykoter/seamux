//! Turn-end TypeSafe judgments for the board, cached. Policy lives here
//! (the former crew/board/judgments.py).
//!
//!   record(cwd, size, values)          writer, called by `seamux asked-hook`
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
    // A judgment the hook recorded with its pane is keyed by that pane, so two
    // Claudes in one worktree keep their own (ADR 0036: the pane is the unit
    // of status); it keeps the cwd and the workspace a board row looks it up
    // by. Without a pane, the key is the cwd, as before.
    let s = |k: &str| values.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let surface = s("surface");
    let key = if surface.is_empty() {
        cwd.to_string()
    } else {
        entry.insert("cwd".into(), json!(cwd));
        entry.insert("ws".into(), json!(s("ws")));
        entry.insert("surface".into(), json!(surface));
        format!("pane:{}", surface.to_uppercase())
    };
    cache.insert(key, Value::Object(entry));
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

/// A pane's state from crew's pane files, by surface; None when its file is
/// gone. The real one reads the state dir; tests pass their own.
type PaneState<'a> = &'a dyn Fn(&str) -> Option<String>;

fn pane_state_now(surface: &str) -> Option<String> {
    crew_core::status::read(&crate::state::state_dir(), surface).map(|p| p.state)
}

/// The judgment that speaks for a workspace's row: the newest of its panes'
/// (entries recorded with the workspace's id). A pane entry speaks only while
/// its pane is there and between turns: one working again is judged on a
/// turn that is over, and one ended or with no file (closed, pruned) is gone.
/// With no pane entry for the workspace, the entry keyed by the row's cwd, as
/// before per-pane entries.
fn entry_for<'a>(w: &Value, jmap: &'a Map<String, Value>, pane: PaneState) -> Option<&'a Value> {
    let ws = crate::pyval::py_str(get(w, "id"));
    let speaks = |e: &Value| match e.get("surface").and_then(Value::as_str).unwrap_or("") {
        "" => true,
        s => pane(s).is_some_and(|st| st != "working" && st != "ended"),
    };
    let at = |e: &Value| e.get("at").and_then(py_float).unwrap_or(0.0);
    let mine = jmap.values()
        .filter(|e| !ws.is_empty() && e.get("ws").and_then(Value::as_str).is_some_and(|x| x.eq_ignore_ascii_case(&ws)))
        .filter(|e| speaks(e))
        .max_by(|a, b| at(a).partial_cmp(&at(b)).unwrap_or(std::cmp::Ordering::Equal));
    let any_pane = jmap.values().any(|e| e.get("ws").and_then(Value::as_str).is_some_and(|x| x.eq_ignore_ascii_case(&ws)));
    match mine {
        Some(e) => Some(e),
        // A workspace whose panes were all judged and all work again: no word.
        None if any_pane => None,
        None => jmap.get(&cwd_of(w)).filter(|e| truthy(e)),
    }
}

/// How much a row needs its human now, 0 to 1, for ordering within a tier
/// (ADR: the turn-end judgment ranks by one priority). From the judgment:
/// 0.6 × max(blocked, urgency/3) + 0.2 × stuck; plus 0.2 × how long it has
/// waited (minutes / 60, at most 1), counted from the judgment's turn end,
/// else from its panes' last write. A running row waits on nobody, so it has
/// no age term. 0 when nothing is known.
pub fn priority_for(w: &Value, jmap: &Map<String, Value>, now: f64) -> f64 {
    priority_with(w, jmap, now, &pane_state_now)
}

fn priority_with(w: &Value, jmap: &Map<String, Value>, now: f64, pane: PaneState) -> f64 {
    let f = |e: &Value, k: &str| e.get(k).and_then(py_float).unwrap_or(0.0).clamp(0.0, 3.0);
    let running = truthy(get(w, "running"));
    let (jev, since) = match entry_for(w, jmap, pane) {
        Some(e) => {
            let jev = 0.6 * f(e, "blocked").min(1.0).max(f(e, "urgency") / 3.0) + 0.2 * f(e, "stuck").min(1.0);
            (jev, e.get("at").and_then(py_float).unwrap_or(0.0))
        }
        None => {
            let ws = crate::pyval::py_str(get(w, "id"));
            let last = crew_core::status::panes(&crate::state::state_dir(), &ws).iter().map(|p| p.at).max().unwrap_or(0);
            (0.0, last as f64 / 1000.0)
        }
    };
    let age = if running || since <= 0.0 { 0.0 } else { ((now - since) / 3600.0).clamp(0.0, 1.0) };
    let p = jev + 0.2 * age;
    (p * 1000.0).round() / 1000.0
}

/// Should this workspace's row read as stuck? Never mid-turn.
pub fn stuck_for(w: &Value, jmap: &Map<String, Value>, threshold: Option<f64>) -> bool {
    if truthy(get(w, "running")) {
        return false;
    }
    let e = match entry_for(w, jmap, &pane_state_now) {
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
    match entry_for(w, jmap, &pane_state_now) {
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

    /// Two panes in one worktree keep their own judgments; a row finds its
    /// workspace's newest, and the old cwd-keyed entry only when it has none.
    #[test]
    fn a_row_takes_its_panes_newest_judgment_then_the_cwd_one() {
        let pane = |ws: &str, s: &str, at: f64, u: f64| json!({"at": at, "ws": ws, "surface": s, "cwd": "/w/a", "urgency": u});
        let jmap: Map<String, Value> = [
            ("pane:P1".to_string(), pane("W1", "P1", 100.0, 1.0)),
            ("pane:P2".to_string(), pane("W1", "P2", 200.0, 3.0)),
            ("pane:P3".to_string(), pane("W4", "P3", 300.0, 3.0)),
            ("/w/b".to_string(), json!({"at": 100.0, "urgency": 2.0})),
        ].into_iter().collect();
        let u = |w: Value, states: &[(&str, &str)]| {
            let states: Vec<(String, String)> = states.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
            let pane = move |s: &str| states.iter().find(|(k, _)| k == s).map(|(_, v)| v.clone());
            entry_for(&w, &jmap, &pane).and_then(|e| e.get("urgency")).and_then(Value::as_f64).unwrap_or(0.0)
        };
        let idle = [("P1", "idle"), ("P2", "idle"), ("P3", "idle")];
        assert_eq!(u(json!({"id": "w1", "cwd": "/w/a"}), &idle), 3.0, "the newest pane's, any case");
        assert_eq!(u(json!({"id": "W1", "cwd": "/w/a"}), &[("P1", "idle"), ("P2", "working")]), 1.0, "a pane at work again is skipped");
        assert_eq!(u(json!({"id": "W1", "cwd": "/w/a"}), &[("P1", "idle")]), 1.0, "a pane with no file is gone");
        assert_eq!(u(json!({"id": "W4", "cwd": "/w/b"}), &[("P3", "ended")]), 0.0, "its only pane ended: no word, not the cwd's");
        assert_eq!(u(json!({"id": "W2", "cwd": "/w/b"}), &idle), 2.0, "no pane entry: the cwd's");
        assert_eq!(u(json!({"id": "W3", "cwd": "/w/none"}), &idle), 0.0);
    }

    /// priority = 0.6 × max(blocked, urgency/3) + 0.2 × stuck + 0.2 × age (an
    /// hour's wait is the whole age term); a running row has no age term.
    #[test]
    fn priority_blends_the_judgment_with_how_long_it_waited() {
        let now = 10_000.0;
        let jmap: Map<String, Value> = [
            ("pane:A".to_string(), json!({"at": now - 3600.0, "ws": "W1", "surface": "A", "blocked": 0.9, "urgency": 1.5, "stuck": 0.5})),
            ("pane:B".to_string(), json!({"at": now - 1800.0, "ws": "W2", "surface": "B", "blocked": 0.1, "urgency": 3.0})),
        ].into_iter().collect();
        let idle = |_: &str| Some("idle".to_string());
        let p = |w: Value| priority_with(&w, &jmap, now, &idle);
        assert_eq!(p(json!({"id": "W1"})), 0.84, "0.6×0.9 + 0.2×0.5 + 0.2×1");
        assert_eq!(p(json!({"id": "W2"})), 0.7, "0.6×(3/3) + 0.2×0.5");
        assert_eq!(p(json!({"id": "W1", "running": true})), 0.64, "running: no age term");
        assert_eq!(p(json!({"id": "W9"})), 0.0, "nothing known");
    }
}
