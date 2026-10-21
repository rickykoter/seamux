//! Cache facts from a Claude Code transcript: breaks, causes, and a
//! staleness clock (crew/hooks/cachefacts.py).
//!
//! A break is visible after the fact: the read figure collapses while the
//! creation figure re-writes most of the prior context. This adds the why
//! (compaction, model switch, TTL gap, upgrade) and the when-next (staleAt,
//! from a TTL that is derived, never inferred). Facts land in
//! ~/.cache/cmux-crew/cache-facts/<session_id>.json, written atomically.
//!
//!   seamux cachefacts <transcript.jsonl> [session_id]   write facts, print JSON
//!   seamux cachefacts --scan <projects_dir>             corpus sweep, cause table
//!   seamux cachefacts --stop <transcript> <session_id> [label]
//!   seamux cachefacts --sleep <session_id> <transcript> [label]

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::home::{crew_local, home_cache};
use crate::py::{self, expand_user, home, iso_timestamp, splitlines};
use crate::pyjson;
use crate::typesafe::is_falsy;

const TAIL_BYTES: u64 = 512 * 1024;
const MIN_CONTEXT: f64 = 20_000.0;
const READ_COLLAPSE: f64 = 0.5;
const CREATION_SPIKE: f64 = 0.4;
const FIVE_MIN: i64 = 5 * 60;
const ONE_HOUR: i64 = 60 * 60;
const STALE_LEAD: f64 = 60.0;
const FRESH_WINDOW: f64 = 600.0;

pub fn facts_dir() -> PathBuf {
    home_cache().join("cache-facts")
}

/// A JSON number that remembers whether Python would hold an int or a float.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Num {
    I(i64),
    F(f64),
}

impl Num {
    fn of(v: Option<&Value>) -> Num {
        match v {
            Some(Value::Number(n)) => n.as_i64().map(Num::I).unwrap_or_else(|| Num::F(n.as_f64().unwrap_or(0.0))),
            Some(Value::Bool(true)) => Num::I(1),
            _ => Num::I(0),
        }
    }
    fn f(self) -> f64 {
        match self {
            Num::I(i) => i as f64,
            Num::F(f) => f,
        }
    }
    fn add(self, o: Num) -> Num {
        match (self, o) {
            (Num::I(a), Num::I(b)) => Num::I(a + b),
            _ => Num::F(self.f() + o.f()),
        }
    }
    fn json(self) -> Value {
        match self {
            Num::I(i) => json!(i),
            Num::F(f) => pyjson::float(f),
        }
    }
}

fn crew_local_config() -> Map<String, Value> {
    std::fs::read_to_string(crew_local().join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// '5m' / '1h' / seconds-as-number -> seconds, else 0.
fn parse_ttl(raw: Option<&Value>) -> i64 {
    match raw {
        Some(Value::Number(n)) if n.as_f64().map(|f| f > 0.0).unwrap_or(false) => {
            n.as_i64().unwrap_or_else(|| n.as_f64().unwrap() as i64)
        }
        Some(Value::Bool(true)) => 1,
        Some(Value::String(s)) => parse_ttl_str(s),
        Some(Value::Number(n)) => parse_ttl_str(&n.to_string()),
        _ => 0,
    }
}

fn parse_ttl_str(s: &str) -> i64 {
    match s.trim().to_lowercase().as_str() {
        "5m" | "300" => FIVE_MIN,
        "1h" | "60m" | "3600" => ONE_HOUR,
        _ => 0,
    }
}

fn settings_ttl() -> i64 {
    let raw = std::fs::read_to_string(home().join(".claude/settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    parse_ttl(raw.as_ref().and_then(|v| v.get("promptCacheTtl")))
}

/// (seconds, source): force-5m > enable-1h > explicit TTL (env, then
/// settings) > billing mode; 5m when nothing says otherwise.
pub fn derive_ttl() -> (i64, String) {
    let set = |k: &str| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false);
    if set("FORCE_PROMPT_CACHING_5M") {
        return (FIVE_MIN, "FORCE_PROMPT_CACHING_5M".into());
    }
    if set("ENABLE_PROMPT_CACHING_1H") {
        return (ONE_HOUR, "ENABLE_PROMPT_CACHING_1H".into());
    }
    let env = std::env::var("CLAUDE_CODE_PROMPT_CACHE_TTL").ok().map(Value::String);
    let e = parse_ttl(env.as_ref());
    if e != 0 {
        return (e, "CLAUDE_CODE_PROMPT_CACHE_TTL".into());
    }
    let st = settings_ttl();
    if st != 0 {
        return (st, "promptCacheTtl".into());
    }
    let billing = py::env_or("CREW_BILLING")
        .or_else(|| {
            crew_local_config().get("billing").filter(|v| !is_falsy(v)).map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
        })
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if billing == "usage" {
        return (FIVE_MIN, "billing:usage".into());
    }
    if !billing.is_empty() {
        return (ONE_HOUR, format!("billing:{billing}"));
    }
    (FIVE_MIN, "default".into())
}

fn records(path: &Path, whole: bool) -> std::io::Result<Vec<Value>> {
    let text = if whole {
        String::from_utf8_lossy(&std::fs::read(path)?).into_owned()
    } else {
        py::read_tail(path, TAIL_BYTES)?
    };
    Ok(splitlines(&text).into_iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect())
}

/// Python's `_epoch`: an ISO-8601 timestamp, or int 0 when it does not parse.
fn epoch(ts: Option<&Value>) -> Num {
    let s = match ts {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => "None".into(),
        Some(other) => other.to_string(),
    };
    iso_timestamp(&s).map(Num::F).unwrap_or(Num::I(0))
}

fn truthy(n: Num) -> bool {
    n.f() != 0.0
}

/// One pass over a transcript -> the facts (not yet written). Sidechain
/// records are skipped: their small contexts read as false breaks.
pub fn read_facts(path: &Path, ttl: Option<i64>, whole: bool) -> std::io::Result<Map<String, Value>> {
    let (ttl_s, ttl_source) = match ttl {
        Some(t) if t != 0 => (t, "caller".to_string()),
        _ => derive_ttl(),
    };
    let mut prev_total = Num::I(0);
    // A set, as the Python's: transcripts hold tens of thousands of requests.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut prev_model: Option<Value> = None;
    let mut prev_version: Option<Value> = None;
    let mut prev_at = Num::F(0.0);
    let mut compact_pending = false;
    let mut breaks: Vec<Value> = Vec::new();
    let mut last_at = Num::F(0.0);
    let mut context = Num::I(0);

    for rec in records(path, whole)? {
        let Some(o) = rec.as_object() else { continue };
        if !is_falsy(o.get("isSidechain").unwrap_or(&Value::Null)) {
            continue;
        }
        let ty = match o.get("type") {
            Some(Value::String(s)) => s.clone(),
            None => String::new(),
            Some(other) => other.to_string(),
        };
        if !is_falsy(o.get("isCompactSummary").unwrap_or(&Value::Null))
            || !is_falsy(o.get("compactMetadata").unwrap_or(&Value::Null))
            || ty.to_lowercase().contains("compact")
        {
            compact_pending = true;
            continue;
        }
        if o.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let msg = o.get("message").filter(|m| !is_falsy(m)).cloned().unwrap_or_else(|| json!({}));
        let usage = msg.get("usage").filter(|u| !is_falsy(u)).cloned().unwrap_or_else(|| json!({}));
        let read = Num::of(usage.get("cache_read_input_tokens"));
        let creation = Num::of(usage.get("cache_creation_input_tokens"));
        let total = read.add(creation);
        if total.f() <= 0.0 {
            continue;
        }
        if let Some(req) = o.get("requestId").filter(|r| !is_falsy(r)) {
            // JSON text as the key: "1" and 1 stay distinct, as in Python.
            if !seen.insert(req.to_string()) {
                continue;
            }
        }
        let at = epoch(o.get("timestamp"));
        let model = msg.get("model").filter(|m| !m.is_null()).cloned();
        let version = o.get("version").filter(|v| !v.is_null()).cloned();
        let present = |v: &Option<Value>| v.as_ref().map(|x| !is_falsy(x)).unwrap_or(false);

        if prev_total.f() > MIN_CONTEXT
            && read.f() < prev_total.f() * READ_COLLAPSE
            && (compact_pending || creation.f() > prev_total.f() * CREATION_SPIKE)
        {
            let cause = if compact_pending {
                "compaction"
            } else if present(&prev_model) && present(&model) && model != prev_model {
                "model-switch"
            } else if truthy(prev_at) && truthy(at) && (at.f() - prev_at.f()) > ttl_s as f64 {
                "ttl-gap"
            } else if present(&prev_version) && present(&version) && version != prev_version {
                "upgrade"
            } else {
                "unknown"
            };
            breaks.push(json!({"ts": o.get("timestamp").cloned().unwrap_or(Value::Null),
                               "recachedTokens": creation.json(), "cause": cause}));
            prev_total = total;
        } else if total.f() > prev_total.f() {
            prev_total = total;
        }
        compact_pending = false;
        context = total;
        if present(&model) {
            prev_model = model;
        }
        if present(&version) {
            prev_version = version;
        }
        if truthy(at) {
            prev_at = at;
            last_at = at;
        }
    }

    let stale_at = if truthy(last_at) { Num::F(last_at.f() + ttl_s as f64) } else { Num::I(0) };
    let mut out = Map::new();
    out.insert("ttl".into(), json!(ttl_s));
    out.insert("ttlSource".into(), json!(ttl_source));
    out.insert("lastRequestAt".into(), last_at.json());
    out.insert("staleAt".into(), stale_at.json());
    out.insert("contextTokens".into(), context.json());
    out.insert("breaks".into(), Value::Array(breaks));
    Ok(out)
}

/// Atomic write; the sleeper and /usage read these. Never fails loudly.
pub fn write_facts(session_id: &str, facts: &Map<String, Value>) -> String {
    let path = facts_dir().join(format!("{session_id}.json"));
    match py::write_atomic(&path, pyjson::dumps(&Value::Object(facts.clone())).as_bytes()) {
        Ok(()) => path.display().to_string(),
        Err(_) => String::new(),
    }
}

fn read_prior(session_id: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(facts_dir().join(format!("{session_id}.json"))).ok()?).ok()
}

fn fmt_tokens(n: &Value) -> String {
    let n = match n {
        Value::Number(x) => x.as_i64().unwrap_or_else(|| x.as_f64().unwrap_or(0.0) as i64),
        _ => 0,
    };
    if n >= 1000 {
        format!("{:.0}k", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}

/// Write facts; the hook's systemMessage JSON only on a fresh break.
pub fn stop_mode(transcript: &Path, session_id: &str, label: &str) -> std::io::Result<String> {
    let prior = read_prior(session_id);
    let mut facts = read_facts(transcript, None, false)?;
    facts.insert("generatedAt".into(), pyjson::float(py::now()));
    if !label.is_empty() {
        facts.insert("label".into(), json!(label));
    }
    write_facts(session_id, &facts);
    let breaks = facts["breaks"].as_array().cloned().unwrap_or_default();
    let Some(last) = breaks.last() else { return Ok(String::new()) };
    let prior_breaks = prior.as_ref().and_then(|p| p.get("breaks")).filter(|b| !is_falsy(b));
    if let Some(pb) = prior_breaks.filter(|_| prior.as_ref().map(|p| !is_falsy(p)).unwrap_or(false)) {
        let prior_ts = pb.as_array().and_then(|a| a.last()).and_then(|b| b.get("ts")).cloned().unwrap_or(Value::Null);
        if last.get("ts").cloned().unwrap_or(Value::Null) == prior_ts {
            return Ok(String::new());
        }
    } else if py::now() - epoch(last.get("ts")).f() > FRESH_WINDOW {
        return Ok(String::new());
    }
    let place = if label.is_empty() { String::new() } else { format!(" [{label}]") };
    let cause = last.get("cause").and_then(Value::as_str).unwrap_or("");
    let msg = format!(
        "cache broke last turn{place}: ~{} tokens re-cached ({cause})",
        fmt_tokens(last.get("recachedTokens").unwrap_or(&Value::Null))
    );
    Ok(pyjson::dumps(&json!({"systemMessage": msg})))
}

/// Wake just before the cache goes stale; notify only if still idle. A newer
/// sleeper (the pid token) or a transcript that moved cancels it.
pub fn sleep_mode(session_id: &str, transcript: &Path, label: &str) -> i32 {
    let facts = read_prior(session_id).filter(|f| !is_falsy(f)).unwrap_or_else(|| json!({}));
    let stale_at = facts.get("staleAt").and_then(Value::as_f64).unwrap_or(0.0);
    let wake_at = stale_at - STALE_LEAD;
    let now = py::now();
    if stale_at == 0.0 || wake_at <= now {
        return 0;
    }
    let token = facts_dir().join(format!("{session_id}.sleeper"));
    let me = std::process::id().to_string();
    if std::fs::create_dir_all(facts_dir()).and_then(|_| std::fs::write(&token, &me)).is_err() {
        return 0;
    }
    let Ok(mtime0) = std::fs::metadata(transcript).map(|m| py::mtime(&m)) else { return 0 };
    std::thread::sleep(std::time::Duration::from_secs_f64(wake_at - now));
    if py::now() > stale_at {
        return 0;
    }
    match std::fs::read_to_string(&token) {
        Ok(t) if t.trim() == me => {}
        _ => return 0,
    }
    match std::fs::metadata(transcript).map(|m| py::mtime(&m)) {
        Ok(m) if m == mtime0 => {}
        _ => return 0,
    }
    let Ok(c) = cmux::Cmux::connect() else { return 0 };
    let ttl = facts.get("ttl").and_then(Value::as_i64).unwrap_or(0);
    let title = if label.is_empty() { session_id.chars().take(8).collect() } else { label.to_string() };
    let _ = c.notify(&cmux::Notify {
        title,
        subtitle: Some("crew:blocked".into()),
        body: Some(format!(
            "cache going stale in {}s ({}m TTL) — prompt now or let it lapse",
            STALE_LEAD as i64,
            ttl.div_euclid(60)
        )),
        workspace: None,
    });
    0
}

/// Corpus sweep: every transcript whole, cause distribution to stdout.
fn scan(projects_dir: &Path) {
    let mut causes: Vec<(String, u64)> = Vec::new();
    let (mut n_breaks, mut n_files, mut tokens) = (0u64, 0u64, 0f64);
    let mut paths: Vec<PathBuf> = Vec::new();
    for d in std::fs::read_dir(projects_dir).into_iter().flatten().flatten() {
        if d.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
            let n = f.file_name().to_string_lossy().into_owned();
            if n.ends_with(".jsonl") && !n.starts_with('.') {
                paths.push(f.path());
            }
        }
    }
    for path in paths {
        n_files += 1;
        let Ok(facts) = read_facts(&path, None, true) else { continue };
        for b in facts["breaks"].as_array().into_iter().flatten() {
            let cause = b["cause"].as_str().unwrap_or("").to_string();
            match causes.iter_mut().find(|(c, _)| *c == cause) {
                Some((_, n)) => *n += 1,
                None => causes.push((cause, 1)),
            }
            tokens += b["recachedTokens"].as_f64().unwrap_or(0.0);
            n_breaks += 1;
        }
    }
    println!("{n_files} transcripts, {n_breaks} breaks, {:.1}M tokens re-cached", tokens / 1e6);
    // Counter.most_common: count descending, ties in first-seen order.
    causes.sort_by(|a, b| b.1.cmp(&a.1));
    for (cause, count) in causes {
        println!("  {cause:14} {count}");
    }
}

pub fn main(args: &[String]) -> i32 {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    if a.len() >= 2 && a[0] == "--scan" {
        scan(&expand_user(a[1]));
        return 0;
    }
    if a.len() >= 3 && a[0] == "--stop" {
        return match stop_mode(&expand_user(a[1]), a[2], a.get(3).copied().unwrap_or("")) {
            Ok(out) => {
                if !out.is_empty() {
                    println!("{out}");
                }
                0
            }
            Err(e) => {
                eprintln!("cachefacts: {e}");
                1
            }
        };
    }
    if a.len() >= 3 && a[0] == "--sleep" {
        return sleep_mode(a[1], &expand_user(a[2]), a.get(3).copied().unwrap_or(""));
    }
    if a.is_empty() {
        eprintln!("Cache facts from a Claude Code transcript: breaks, causes, and a staleness clock.");
        return 2;
    }
    let mut facts = match read_facts(&expand_user(a[0]), None, false) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("cachefacts: {e}");
            return 1;
        }
    };
    facts.insert("generatedAt".into(), pyjson::float(py::now()));
    if let Some(sid) = a.get(1).filter(|s| !s.is_empty()) {
        write_facts(sid, &facts);
    }
    println!("{}", pyjson::dumps_indent(&Value::Object(facts), 2));
    0
}
