//! Per-workspace dollars from ccusage, cached (crew/board/costs.py).
//!
//!   costs_for(cwds) -> {cwd: {"today", "week", "unpriced", "unpricedToday"}}
//!
//! Source: `ccusage claude daily --instances --json`, grouped by munged project
//! directory. Attribution reverse-matches each munged dir against the KNOWN
//! workspace cwds; a dir name is never parsed back into a path. `unpriced`
//! names models ccusage could not price, so the dollars are a floor. The raw
//! output is cached ~5 min (CREW_COSTS_TTL), keyed by the pricing args.
//! Degrades to {} when ccusage is missing, slow or unreadable.
//!
//!   seamux costs --attribute FIXTURE.json CWD...   pure attribution
//!   seamux costs CWD...                            live costs

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::home::home_cache;
use crate::py;
use crate::{pricing, pyjson};

const DAYS: i64 = 7;

fn cache() -> PathBuf {
    home_cache().join("costs.json")
}

fn ttl() -> f64 {
    std::env::var("CREW_COSTS_TTL").ok().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(300) as f64
}

/// Mirror the transcript-dir naming: every character but [A-Za-z0-9-] becomes '-'.
pub fn munge(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

/// Python's float() of a ccusage cost, or None where it would raise.
fn cost_of(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => Some(0.0),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(*b as u8 as f64),
        Some(Value::String(s)) if s.is_empty() => Some(0.0),
        Some(Value::String(s)) => s.trim().parse().ok(),
        Some(Value::Array(a)) if a.is_empty() => Some(0.0),
        Some(Value::Object(o)) if o.is_empty() => Some(0.0),
        _ => None,
    }
}

/// Models in one ccusage row whose tokens it could not price.
pub fn unpriced(row: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for b in row.get("modelBreakdowns").and_then(Value::as_array).into_iter().flatten() {
        if b.is_object() && !crate::typesafe::is_falsy(b.get("missingPricing").unwrap_or(&Value::Null)) {
            let name = b.get("modelName").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("?").to_string();
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// Pure: ccusage {munged-dir: [day rows]} x known cwds -> per-cwd dollars.
pub fn attribute(projects: &Map<String, Value>, cwds: &[String], today: &str) -> Map<String, Value> {
    let today = if today.is_empty() { py::local_date_iso(0) } else { today.to_string() };
    let mut by_munged: Vec<(String, &String)> = Vec::new();
    for cwd in cwds {
        let m = munge(cwd);
        if !by_munged.iter().any(|(k, _)| *k == m) {
            by_munged.push((m, cwd)); // first claim wins on collision
        }
    }
    struct Tot {
        today: f64,
        week: f64,
        unpriced: Vec<String>,
        unpriced_today: Vec<String>,
    }
    let mut order: Vec<String> = Vec::new();
    let mut tots: Vec<Tot> = Vec::new();
    for (dirname, rows) in projects {
        let Some((_, cwd)) = by_munged.iter().find(|(k, _)| k == dirname) else { continue };
        let idx = match order.iter().position(|c| c == *cwd) {
            Some(i) => i,
            None => {
                order.push((*cwd).clone());
                tots.push(Tot { today: 0.0, week: 0.0, unpriced: vec![], unpriced_today: vec![] });
                order.len() - 1
            }
        };
        let t = &mut tots[idx];
        for r in rows.as_array().into_iter().flatten() {
            let Some(cost) = cost_of(r.get("totalCost")) else { continue };
            let is_today = r.get("date").and_then(Value::as_str) == Some(today.as_str());
            t.week += cost;
            if is_today {
                t.today += cost;
            }
            for m in unpriced(r) {
                if !t.unpriced.contains(&m) {
                    t.unpriced.push(m.clone());
                }
                if is_today && !t.unpriced_today.contains(&m) {
                    t.unpriced_today.push(m);
                }
            }
        }
    }
    order
        .into_iter()
        .zip(tots)
        .map(|(cwd, t)| {
            (
                cwd,
                json!({"today": pyjson::float(t.today), "week": pyjson::float(t.week),
                       "unpriced": t.unpriced, "unpricedToday": t.unpriced_today}),
            )
        })
        .collect()
}

/// Raw ccusage output, or None when it cannot be had (60 s budget).
pub fn fetch_projects(days: i64, cfg: &[String]) -> Option<Map<String, Value>> {
    let (y, m, d) = py::local_date(days);
    let since = format!("{y:04}{m:02}{d:02}");
    let mut child = Command::new("ccusage")
        .args(["claude", "daily", "--instances", "--json", "--since", &since])
        .args(cfg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Ok(Some(st)) = child.try_wait() {
            break st;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = reader.join().ok()?;
    if !status.success() {
        return None;
    }
    let v: Value = serde_json::from_str(&stdout).ok()?;
    if !v.is_object() {
        return None;
    }
    Some(v.get("projects").and_then(Value::as_object).cloned().unwrap_or_default())
}

fn read_cache(cfg: &[String]) -> Option<Map<String, Value>> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(cache()).ok()?).ok()?;
    let at = v.get("at").and_then(Value::as_f64).unwrap_or(0.0);
    let cached_cfg: Vec<String> = v
        .get("cfg")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if py::now() - at < ttl() && cached_cfg == cfg {
        return v.get("projects").and_then(Value::as_object).cloned();
    }
    None
}

fn write_cache(projects: &Map<String, Value>, cfg: &[String]) {
    let body = pyjson::dumps(&json!({"at": pyjson::float(py::now()), "projects": projects, "cfg": cfg}));
    let _ = py::write_atomic(&cache(), body.as_bytes());
}

pub fn costs_for(cwds: &[String]) -> Map<String, Value> {
    let cfg = pricing::config_args(None);
    let projects = match read_cache(&cfg) {
        Some(p) => p,
        None => match fetch_projects(DAYS, &cfg) {
            None => return Map::new(),
            Some(p) => {
                write_cache(&p, &cfg);
                p
            }
        },
    };
    attribute(&projects, cwds, "")
}

pub fn main(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("--attribute") && args.len() >= 2 {
        let fx: Value = match std::fs::read_to_string(&args[1]).map_err(|e| e.to_string()).and_then(|t| {
            serde_json::from_str(&t).map_err(|e| e.to_string())
        }) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("costs: {e}");
                return 1;
            }
        };
        let projects = fx.get("projects").and_then(Value::as_object).cloned().unwrap_or_default();
        let today = fx.get("today").and_then(Value::as_str).unwrap_or("");
        println!("{}", pyjson::dumps(&Value::Object(attribute(&projects, &args[2..], today))));
        return 0;
    }
    println!("{}", pyjson::dumps(&Value::Object(costs_for(args))));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn munge_like_transcript_dirs() {
        assert_eq!(munge("/code/a.b/x_y"), "-code-a-b-x-y");
        assert_eq!(munge("/tmp/é"), "-tmp--");
    }

    #[test]
    fn attribution() {
        let projects = json!({
            "-a": [{"date": "2026-10-21", "totalCost": 1.5}, {"date": "2026-10-20", "totalCost": 2,
                    "modelBreakdowns": [{"modelName": "m9", "missingPricing": true}]}],
            "-nobody": [{"date": "2026-10-21", "totalCost": 9}]
        });
        let got = attribute(projects.as_object().unwrap(), &["/a".to_string(), ".a".to_string()], "2026-10-21");
        assert_eq!(
            Value::Object(got),
            json!({"/a": {"today": 1.5, "week": 3.5, "unpriced": ["m9"], "unpricedToday": []}})
        );
    }
}
