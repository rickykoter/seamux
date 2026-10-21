//! `crew-feed`: publish the pending Feed ask for a workspace onto the board.
//!
//! ```text
//! crew-feed publish [<workspace-id>]   write feed:* tokens (called from hooks)
//! crew-feed clear   [<workspace-id>]   remove them
//! crew-feed show    [<workspace-id>]   what it would publish, and why
//! crew-feed reply   <once|deny> [ws]   answer it (re-validated + audited)
//! ```
//!
//! Feed blocks an agent for at most 120 seconds, and its `pending` status
//! cannot be trusted (asks outlive a cmux that died before their timeout). So
//! an ask is live only when it is pending, inside the window, and its
//! workspace's agent is needsInput with a live pid; anything else publishes
//! `feed:stale` and the board offers jump only. One-tap Allow is gated further:
//! never a plan, never text truncated to fit a row, never a command the bash
//! guard would block. Every reply is re-validated at the tap and audited.

use std::path::Path;
use std::time::Duration;

use cmux::{Cmux, WorkspaceAction};
use crew_core::{py, pyjson};
use serde_json::{json, Map, Value};

use crate::pypath::{self, join};
use crate::pyval::{py_space, py_str, read_json, truthy};
use crate::{plugin_root, proc, pyerr};

const KEYS: [&str; 5] = ["feed", "feedby", "feedgate", "feedreq", "feedws"];

struct Ctx {
    home: String,
    audit: String,
    window: i64,
    fits: usize,
}

fn ctx() -> Option<Ctx> {
    let home = pypath::home();
    // os.environ.get("XDG_CACHE_HOME", default): set-but-empty counts as set.
    let xdg = std::env::var("XDG_CACHE_HOME").unwrap_or_else(|_| join(&home, ".cache"));
    let int = |k: &str, d: i64| match std::env::var(k) {
        Ok(v) => crate::pyval::py_int(&v).and_then(|n| i64::try_from(n).ok()),
        Err(_) => Some(d),
    };
    Some(Ctx {
        audit: join(&xdg, "cmux-crew/feed-audit.jsonl"),
        window: int("CREW_FEED_WINDOW", 120)?,
        fits: usize::try_from(int("CREW_FEED_FITS", 72)?).unwrap_or(0),
        home,
    })
}

fn get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.get(k).filter(|x| truthy(Some(x)))
}

/// `d.get(k) or default` as a string.
fn or(v: &Value, k: &str, d: &str) -> String {
    get(v, k).map(py_str).unwrap_or_else(|| d.to_string())
}

/// `cmux rpc <method> <json>`: the answer, or {} on any failure.
fn rpc(method: &str, params: Value) -> Value {
    let Ok(c) = Cmux::connect() else { return json!({}) };
    match c.rpc(method, params) {
        Ok(v @ Value::Object(_)) => v,
        _ => json!({}),
    }
}

/// The workspace rows, read as the Python did (CMUX_QUIET=1); None on failure.
fn workspaces() -> Option<Vec<Value>> {
    let c = Cmux::connect().ok()?.with_cli_env("CMUX_QUIET", "1");
    match c.workspace_list(None).ok()?.get("workspaces") {
        Some(Value::Array(a)) => Some(a.clone()),
        Some(v) if !truthy(Some(v)) => Some(vec![]),
        _ => None,
    }
}

fn row(ws: &str) -> Option<Value> {
    workspaces()?.into_iter().find(|w| w.get("id").and_then(Value::as_str) == Some(ws))
}

fn workspace_cwd(ws: &str) -> String {
    row(ws).map(|w| or(&w, "current_directory", "")).unwrap_or_default()
}

/// Is a live agent in this workspace blocked right now?
fn agent_waiting(c: &Ctx, ws: &str) -> bool {
    let Some(d) = read_json(&join(&c.home, ".cmuxterm/claude-hook-sessions.json")) else { return false };
    let sid = get(&d, "activeSessionsByWorkspace").and_then(|m| get(m, ws)).and_then(|s| s.get("sessionId"));
    let sid = sid.filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
    let rec = get(&d, "sessions").and_then(|m| get(m, &sid)).cloned().unwrap_or(json!({}));
    if rec.get("agentLifecycle") != Some(&json!("needsInput")) {
        return false;
    }
    crate::sync::facts::kill0(rec.get("pid"))
}

/// Seconds since the ask was updated; 1e9 when that cannot be told (missing,
/// unparseable, or a time with no offset, which Python cannot subtract from
/// an aware now).
fn age_of(item: &Value) -> f64 {
    let Some(Value::String(s)) = item.get("updated_at").filter(|v| truthy(Some(v))) else { return 1e9 };
    match aware_ts(&s.replace('Z', "+00:00")) {
        Some(ts) => py::now() - ts,
        None => 1e9,
    }
}

fn digits_at(b: &[u8], i: usize, n: usize) -> Option<i64> {
    let s = b.get(i..i + n)?;
    s.iter().all(u8::is_ascii_digit).then(|| std::str::from_utf8(s).ok()?.parse().ok())?
}

/// The date at the start of `b`: (days since the epoch, its length).
/// YYYY-MM-DD, YYYYMMDD, YYYY-Www-D and YYYYWwwD, as fromisoformat takes them.
fn iso_date(b: &[u8]) -> Option<(i64, usize)> {
    let y = digits_at(b, 0, 4)?;
    let ext = b.get(4) == Some(&b'-');
    let o = if ext { 5 } else { 4 };
    if b.get(o) == Some(&b'W') {
        let w = digits_at(b, o + 1, 2)?;
        let dsep = ext && b.get(o + 3) == Some(&b'-');
        if ext != dsep {
            return None;
        }
        let dpos = o + 3 + dsep as usize;
        let d = digits_at(b, dpos, 1)?;
        // Python's rule: week 53 exists when 1 January is a Thursday, or a
        // Wednesday in a leap year (weekday of days_from_civil: 0 is Thursday).
        let jan1 = crew_core::py::days_from_civil(y, 1, 1).rem_euclid(7);
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let weeks = if jan1 == 0 || (jan1 == 6 && leap) { 53 } else { 52 };
        if y == 0 || !(1..=weeks).contains(&w) || !(1..=7).contains(&d) {
            return None;
        }
        // ISO week 1 holds 4 January; its Monday starts the year.
        let jan4 = crew_core::py::days_from_civil(y, 1, 4);
        let monday = jan4 - (jan4 + 3).rem_euclid(7);
        return Some((monday + (w - 1) * 7 + (d - 1), dpos + 1));
    }
    let m = digits_at(b, o, 2)?;
    let dpos = if ext {
        if b.get(o + 2) != Some(&b'-') {
            return None;
        }
        o + 3
    } else {
        o + 2
    };
    let d = digits_at(b, dpos, 2)?;
    let mdays = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => return None,
    };
    if y == 0 || d < 1 || d > mdays {
        return None;
    }
    Some((crew_core::py::days_from_civil(y, m as u32, d as u32), dpos + 2))
}

/// HH[:MM[:SS[.f]]] or HH[MM[SS[.f]]] as seconds; the colon form must hold
/// throughout. Fraction digits past six are dropped, as fromisoformat does.
fn iso_clock(b: &[u8]) -> Option<f64> {
    let h = digits_at(b, 0, 2)?;
    let (mut i, mut mi, mut sec, mut frac) = (2, 0, 0, 0.0);
    let colon = b.get(2) == Some(&b':');
    let field = |i: usize| -> Option<(i64, usize)> {
        let at = i + colon as usize;
        if colon && b.get(i) != Some(&b':') {
            return None;
        }
        Some((digits_at(b, at, 2)?, at + 2))
    };
    if i < b.len() {
        let (v, n) = field(i)?;
        mi = v;
        i = n;
        if i < b.len() {
            let (v, n) = field(i)?;
            sec = v;
            i = n;
            if i < b.len() {
                if b[i] != b'.' && b[i] != b',' {
                    return None;
                }
                // Up to six digits are read; past the sixth, whatever follows
                // is ignored, but a shorter fraction must end the clock.
                let ds = &b[i + 1..];
                let n = ds.iter().take(6).take_while(|c| c.is_ascii_digit()).count();
                if n < 6 && n != ds.len() {
                    return None;
                }
                let six: String = ds.iter().take(n).map(|&c| c as char).chain(std::iter::repeat('0')).take(6).collect();
                frac = six.parse::<f64>().ok()? / 1e6;
                i = b.len();
            }
        }
    }
    if i != b.len() || mi > 59 || sec > 59 {
        return None;
    }
    if h == 24 {
        // 24:00:00 is the next midnight, and nothing else past 23
        return (mi == 0 && sec == 0 && frac == 0.0).then_some(86400.0);
    }
    (h <= 23).then_some((h * 3600 + mi * 60 + sec) as f64 + frac)
}

/// `datetime.fromisoformat(s).timestamp()` when the result is aware, else
/// None (naive, or Python would raise).
fn aware_ts(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let (days, n) = iso_date(b)?;
    // any single character separates the date from the time
    let rest = b.get(n + 1..)?;
    // ...but never a digit, which would read as more date
    if b.get(n).is_none_or(u8::is_ascii_digit) || std::str::from_utf8(&b[n..n + 1]).is_err() {
        return None;
    }
    let tz = rest.iter().position(|&c| c == b'+' || c == b'-')?;
    let mut clock = &rest[..tz];
    // a space before the offset, but only after whole seconds
    if clock.last() == Some(&b' ') && !clock.iter().any(|&c| c == b'.' || c == b',') {
        clock = &clock[..clock.len() - 1];
    }
    let t = iso_clock(clock)?;
    let off = &rest[tz + 1..];
    let sign = if rest[tz] == b'-' { -1.0 } else { 1.0 };
    let off_secs = iso_offset(off)?;
    Some(days as f64 * 86400.0 + t - sign * off_secs)
}

/// ±HH, ±HHMM, ±HH:MM, ±HH:MM:SS[.f] and ±HHMMSS[.f], under 24 hours.
/// When its hours, minutes and seconds are all zero the fraction is dropped
/// (Python reads +00:00:00.5 as UTC, but +00:00:01.25 as 1.25s).
fn iso_offset(b: &[u8]) -> Option<f64> {
    // a time may end in a bare "." (09.Z) and skip what follows six fraction
    // digits; an offset's fraction must be digits to its end
    if let Some(p) = b.iter().position(|&c| c == b'.' || c == b',') {
        let f = &b[p + 1..];
        if f.is_empty() || !f.iter().all(u8::is_ascii_digit) {
            return None;
        }
    }
    let s = iso_clock(b)?;
    if s >= 86400.0 {
        return None;
    }
    Some(if s < 1.0 { 0.0 } else { s })
}

fn newest_ask(cwd: &str) -> Option<Value> {
    let items = match get(&rpc("feed.list", json!({})), "items") {
        Some(Value::Array(a)) => a.clone(),
        _ => vec![],
    };
    let mut best: Option<(String, Value)> = None;
    for i in items {
        let kind = i.get("kind").and_then(Value::as_str).unwrap_or("");
        if !["permissionRequest", "question", "exitPlan"].contains(&kind) || or(&i, "cwd", "") != cwd {
            continue;
        }
        let key = or(&i, "updated_at", "");
        // max() keeps the first of equal keys
        if best.as_ref().is_none_or(|(k, _)| key > *k) {
            best = Some((key, i));
        }
    }
    best.map(|(_, i)| i)
}

fn collapse(s: &str) -> String {
    s.split(py_space).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
}

/// One line describing the ask, and whether it had to be truncated to fit.
fn summarise(c: &Ctx, item: &Value) -> Result<(String, bool), String> {
    let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
    let text = match kind {
        "question" => or(item, "question_prompt", "AskUserQuestion"),
        "exitPlan" => "Plan ready to execute".to_string(),
        _ => {
            let tool = get(item, "tool_name").or_else(|| get(item, "title")).map(py_str).unwrap_or_else(|| "tool".into());
            let ti = match item.get("tool_input") {
                Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(json!({})),
                Some(v) if truthy(Some(v)) => v.clone(),
                _ => json!({}),
            };
            if !ti.is_object() {
                return Err(format!("AttributeError: '{}' object has no attribute 'get'", type_name(&ti)));
            }
            let detail = ["command", "file_path", "pattern"].iter().find_map(|k| get(&ti, k)).map(py_str).unwrap_or_default();
            let t = format!("{tool}: {detail}");
            crate::pyval::py_strip(&t).trim_end_matches(':').to_string()
        }
    };
    let text = collapse(&text);
    let long = text.chars().count() > c.fits;
    Ok((text, long))
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

/// The guard script: the old installer's copy, else the bash-guard plugin's.
fn guard_path(c: &Ctx) -> Option<String> {
    let legacy = join(&c.home, ".claude/hooks/cmux/guard_bash.sh");
    if Path::new(&legacy).exists() {
        return Some(legacy);
    }
    let root = plugin_root::plugin_root("bash-guard", None).ok().filter(|r| !r.is_empty())?;
    let p = join(&root, "hooks/guard_bash.sh");
    Path::new(&p).exists().then_some(p)
}

/// Would guard_bash.sh block this Bash command? Unknown counts as yes.
fn guard_would_block(c: &Ctx, item: &Value) -> Result<bool, String> {
    if item.get("kind") != Some(&json!("permissionRequest")) {
        return Ok(false);
    }
    let tool = get(item, "tool_name").or_else(|| get(item, "title"));
    if tool != Some(&json!("Bash")) {
        return Ok(false);
    }
    let Some(guard) = guard_path(c) else { return Ok(true) };
    let ti = match item.get("tool_input") {
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        },
        Some(v) if truthy(Some(v)) => return Ok(true), // json.loads of a non-string raises
        _ => json!({}),
    };
    let Some(o) = ti.as_object() else {
        return Err(format!("AttributeError: '{}' object has no attribute 'get'", type_name(&ti)));
    };
    let command = o.get("command").cloned().unwrap_or(json!(""));
    let payload = pyjson::dumps(&json!({"tool_input": {"command": command}}));
    match proc::run_with_input(&["bash", &guard], None, &[], Some(&payload), Some(Duration::from_secs(10))) {
        Some(r) => Ok(r.code != 0),
        None => Ok(true),
    }
}

/// May the board offer one-tap Allow? (allowed, reason)
fn gate(c: &Ctx, item: &Value, truncated: bool) -> Result<(bool, String), String> {
    if item.get("kind") == Some(&json!("exitPlan")) {
        return Ok((false, "a plan is too long to approve from a row".into()));
    }
    if truncated {
        return Ok((false, "does not fit without truncation".into()));
    }
    if guard_would_block(c, item)? {
        return Ok((false, "guard_bash would block this command".into()));
    }
    Ok((true, String::new()))
}

struct Eval {
    item: Value,
    age: f64,
    live: bool,
    text: String,
    allowed: bool,
    why: String,
    deadline: i64,
}

fn evaluate(c: &Ctx, ws: &str) -> Result<Option<Eval>, String> {
    let cwd = workspace_cwd(ws);
    if cwd.is_empty() {
        return Ok(None);
    }
    let Some(item) = newest_ask(&cwd) else { return Ok(None) };
    let age = age_of(&item);
    let live = item.get("status") == Some(&json!("pending")) && age <= c.window as f64 && agent_waiting(c, ws);
    let (text, truncated) = summarise(c, &item)?;
    let (allowed, why) = if live { gate(c, &item, truncated)? } else { (false, "window closed".into()) };
    let deadline = (py::now() + (c.window as f64 - age).max(0.0)) as i64;
    Ok(Some(Eval { item, age, live, text, allowed, why, deadline }))
}

/// Merge feed:* tokens into the description, leaving the others alone.
fn set_tokens(ws: &str, toks: &[String]) {
    let cur = workspaces()
        .and_then(|rows| rows.into_iter().find(|w| w.get("id").and_then(Value::as_str) == Some(ws)))
        .map(|w| or(&w, "description", ""))
        .unwrap_or_default();
    let mut kept: Vec<String> = cur
        .split(py_space)
        .filter(|t| !t.is_empty() && !KEYS.contains(&t.split(':').next().unwrap_or("")))
        .map(String::from)
        .collect();
    kept.extend(toks.iter().cloned());
    let new = kept.join(" ");
    let action = if new.is_empty() { WorkspaceAction::ClearDescription } else { WorkspaceAction::SetDescription(new) };
    if let Ok(c) = Cmux::connect() {
        let _ = c.workspace_action(ws, &action);
    }
}

fn publish(c: &Ctx, ws: &str) -> Result<(), String> {
    let ev = evaluate(c, ws)?;
    let mut toks: Vec<String> = Vec::new();
    if let Some(ev) = &ev {
        let kind = match ev.item.get("kind").and_then(Value::as_str) {
            Some("permissionRequest") => "perm",
            Some("question") => "quest",
            Some("exitPlan") => "plan",
            _ => "ask",
        };
        if ev.live {
            toks.push(format!("feed:{kind}"));
            toks.push(format!("feedby:{}", ev.deadline));
            toks.push(if ev.allowed { "feedgate:allow" } else { "feedgate:read" }.into());
            let rid = or(&ev.item, "request_id", "");
            if !rid.is_empty() {
                toks.push(format!("feedreq:{rid}"));
            }
        } else {
            toks.push("feed:stale".into());
        }
        let wsid = or(&ev.item, "workstream_id", "");
        if !wsid.is_empty() {
            toks.push(format!("feedws:{wsid}"));
        }
    }
    set_tokens(ws, &toks);
    Ok(())
}

/// One JSON line on the audit log, stamped with the local time to the second.
fn audit(c: &Ctx, mut entry: Map<String, Value>) {
    if let Some(dir) = Path::new(&c.audit).parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    entry.insert("at".into(), json!(local_iso_seconds()));
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&c.audit) {
        // one write, so concurrent replies cannot interleave their lines
        let line = pyjson::dumps(&Value::Object(entry)) + "\n";
        let _ = f.write_all(line.as_bytes());
    }
}

/// `datetime.now().isoformat(timespec="seconds")`: local, no offset.
fn local_iso_seconds() -> String {
    let now = py::now() as libc::time_t;
    // SAFETY: localtime_r fills tm, which we own, from a time_t we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

fn entry(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// Answer the pending ask, re-validated at the tap, never trusted from the render.
fn reply(c: &Ctx, ws: &str, mode: &str) -> Result<i32, String> {
    if mode != "once" && mode != "deny" {
        audit(c, entry(&[("ws", json!(ws)), ("mode", json!(mode)), ("result", json!("refused")), ("why", json!("unknown mode"))]));
        eprintln!("crew-feed: reply mode must be once or deny, not {}", pyerr::repr(mode));
        return Ok(2);
    }
    let ev = evaluate(c, ws)?;
    let Some(ev) = ev.filter(|e| e.live) else {
        audit(c, entry(&[("ws", json!(ws)), ("mode", json!(mode)), ("result", json!("refused")), ("why", json!("window closed"))]));
        set_tokens(ws, &["feed:stale".into()]);
        return Ok(1);
    };
    if mode != "deny" && !ev.allowed {
        audit(
            c,
            entry(&[
                ("ws", json!(ws)),
                ("mode", json!(mode)),
                ("result", json!("refused")),
                ("why", json!(ev.why)),
                ("text", json!(ev.text)),
            ]),
        );
        return Ok(1);
    }
    let rid = or(&ev.item, "request_id", "");
    if rid.is_empty() {
        audit(c, entry(&[("ws", json!(ws)), ("mode", json!(mode)), ("result", json!("refused")), ("why", json!("no request_id"))]));
        return Ok(1);
    }
    let kind = ev.item.get("kind").cloned().unwrap_or(Value::Null);
    if kind != "permissionRequest" {
        audit(
            c,
            entry(&[
                ("ws", json!(ws)),
                ("mode", json!(mode)),
                ("result", json!("refused")),
                ("why", json!(format!("{} is jump-only", py_str(&kind)))),
                ("text", json!(ev.text)),
            ]),
        );
        return Ok(1);
    }
    let out = rpc("feed.permission.reply", json!({"request_id": rid, "mode": mode}));
    audit(
        c,
        entry(&[
            ("ws", json!(ws)),
            ("mode", json!(mode)),
            ("result", json!("sent")),
            ("kind", kind),
            ("text", json!(ev.text)),
            ("request_id", json!(rid)),
            ("response", out),
        ]),
    );
    set_tokens(ws, &[]);
    Ok(0)
}

pub fn main(args: &[String]) -> i32 {
    let Some(c) = ctx() else {
        return pyerr::crash("ValueError: invalid literal for int() with base 10");
    };
    let cmd = args.first().map(String::as_str).unwrap_or("show");
    // `reply` takes a mode first: crew-feed reply <once|deny> [workspace]
    let argpos = if cmd == "reply" { 2 } else { 1 };
    let ws = args.get(argpos).cloned().unwrap_or_else(|| std::env::var("CMUX_WORKSPACE_ID").unwrap_or_default());
    if ws.is_empty() {
        eprintln!("crew-feed: no workspace");
        return 1;
    }
    let res: Result<i32, String> = match cmd {
        "clear" => {
            set_tokens(&ws, &[]);
            Ok(0)
        }
        "reply" => reply(&c, &ws, args.get(1).map(String::as_str).unwrap_or("deny")),
        "publish" => publish(&c, &ws).map(|_| 0),
        _ => evaluate(&c, &ws).map(|ev| {
            match ev {
                None => println!("  no Feed ask for this workspace"),
                Some(ev) => {
                    let py_bool = |b: bool| if b { "True" } else { "False" };
                    println!("  kind      {}", ev.item.get("kind").map(py_str).unwrap_or_else(|| "None".into()));
                    println!("  age       {:.0}s   (window {}s)", ev.age, c.window);
                    println!("  status    {}", ev.item.get("status").map(py_str).unwrap_or_else(|| "None".into()));
                    println!("  live      {}", py_bool(ev.live));
                    println!("  text      {}", crate::pyval::head(&ev.text, 100));
                    let why = if ev.allowed { String::new() } else { format!("   ({})", ev.why) };
                    println!("  allow     {}{why}", py_bool(ev.allowed));
                }
            }
            0
        }),
    };
    match res {
        Ok(code) => code,
        Err(m) => pyerr::crash(&m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aware_times_parse_as_python_3_14_does() {
        // python3: datetime.fromisoformat(c.replace("Z", "+00:00")).timestamp() when aware
        let cases: &[(&str, Option<f64>)] = &[
            ("2026-10-21T13:53:09Z", Some(1792590789.0)),
            ("2026-10-21T13:53:09+0000", Some(1792590789.0)),
            ("2026-10-21T13:53:09+00", Some(1792590789.0)),
            ("20261021T135309Z", Some(1792590789.0)),
            ("20261021T1353Z", Some(1792590780.0)),
            ("2026-10-21 13:53:09.123456+02:00", Some(1792583589.123456)),
            ("2026-10-21T13:53:09.1234567+00:00", Some(1792590789.123456)),
            ("2026-10-21T13:53:09,5Z", Some(1792590789.5)),
            ("2026-10-21T13Z", Some(1792587600.0)),
            ("2026-10-21T13:53Z", Some(1792590780.0)),
            ("2026-10-21T13:53:09-05:30", Some(1792610589.0)),
            ("2026-10-21T13:53:09+05:30:15", Some(1792570974.0)),
            ("2026-10-21T13:53:09+053015", Some(1792570974.0)),
            ("2026-10-21x13:53:09Z", Some(1792590789.0)),
            ("2026-10-21T13:53:09", None),
            ("2026-10-21", None),
            ("2026-10-21T25:00:00Z", None),
            ("2026-W43-3T10:00:00Z", Some(1792576800.0)),
            ("2026-10-21T13:53:09.5+00:00", Some(1792590789.5)),
            ("2026-10-21T135309Z", Some(1792590789.0)),
            ("2026-10-21T13:5309Z", None),
            ("2026-10-21T24:00:00Z", Some(1792627200.0)),
            ("2026-10-21T13:53:09 +00:00", Some(1792590789.0)),
            ("2026-10-21T13:53:09+0", None),
            ("2026-10-21T13:53:09+00:0", None),
            ("2026-10-21T13:53:09.123+00:00:00.5", Some(1792590789.123)),
            ("2026-1021T13:53:09Z", None),
            ("Z", None),
            ("", None),
            ("2026-10-21T13:53:09.Z", Some(1792590789.0)),
            ("2026-10-21T13:53:09+24:00", None),
            ("2026-02-29T00:00:00Z", None),
            ("2024-02-29T00:00:00Z", Some(1709164800.0)),
            ("2026-10-21T13:53:60Z", None),
            ("2026-10-21T13:53:09.000000001Z", Some(1792590789.0)),
            ("+2026-10-21T13:53:09Z", None),
            ("2026-10-21T13:53:09z", None),
            ("2026-10-21T13:53:09+00:00:01.25", Some(1792590787.75)),
            ("2026-10-21T13:53:09.5+00:00:00.5", Some(1792590789.5)),
        ];
        for (c, want) in cases {
            let got = aware_ts(&c.replace('Z', "+00:00"));
            match (got, want) {
                (Some(g), Some(w)) => assert!((g - w).abs() < 1e-6, "{c}: {g} != {w}"),
                (None, None) => {}
                _ => panic!("{c}: got {got:?}, want {want:?}"),
            }
        }
    }

    /// A fuzz table from Python (FEED_ISO_CASES=<json [[s, ts|null], ...]>):
    /// cargo test -p crew-cli fuzz_iso -- --ignored
    #[test]
    #[ignore]
    fn fuzz_iso_against_python() {
        let path = std::env::var("FEED_ISO_CASES").expect("FEED_ISO_CASES");
        let cases: Vec<(String, Option<f64>)> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let bad: Vec<String> = cases
            .iter()
            .filter(|(c, want)| {
                let got = aware_ts(&c.replace('Z', "+00:00"));
                !matches!((got, want), (None, None)) && !matches!((got, want), (Some(g), Some(w)) if (g - w).abs() < 1e-6)
            })
            .map(|(c, w)| format!("{c:?} want {w:?} got {:?}", aware_ts(&c.replace('Z', "+00:00"))))
            .collect();
        let looser = bad.iter().filter(|b| b.contains("want None got Some")).count();
        assert!(
            bad.is_empty(),
            "{} of {} differ ({looser} accepted where Python refuses, the rest refused where Python accepts):\n{}",
            bad.len(),
            cases.len(),
            bad[..bad.len().min(40)].join("\n")
        );
    }

    #[test]
    fn age_needs_an_offset() {
        assert_eq!(age_of(&json!({"updated_at": "2026-01-01T00:00:00"})), 1e9);
        assert_eq!(age_of(&json!({"updated_at": "nope"})), 1e9);
        assert_eq!(age_of(&json!({})), 1e9);
        let a = age_of(&json!({"updated_at": "2026-01-01T00:00:00Z"}));
        assert!(a > 0.0 && a < 1e9);
        let b = age_of(&json!({"updated_at": "2026-01-01T02:00:00.5+02:00"}));
        assert!((a - b - 0.0).abs() < 1.0, "{a} {b}");
    }

    #[test]
    fn summaries() {
        let c = Ctx { home: String::new(), audit: String::new(), window: 120, fits: 72 };
        let s = |v: Value| summarise(&c, &v).unwrap();
        assert_eq!(s(json!({"kind": "question"})), ("AskUserQuestion".into(), false));
        assert_eq!(s(json!({"kind": "exitPlan"})), ("Plan ready to execute".into(), false));
        assert_eq!(s(json!({"kind": "permissionRequest", "tool_name": "Bash", "tool_input": "{\"command\": \"ls  -la\\n x\"}"})).0, "Bash: ls -la x");
        assert_eq!(s(json!({"kind": "permissionRequest", "title": "Edit", "tool_input": "nope"})).0, "Edit");
        assert_eq!(s(json!({"kind": "x", "tool_input": {"file_path": "/a"}})).0, "tool: /a");
        assert!(s(json!({"kind": "permissionRequest", "tool_input": json!({"command": "x".repeat(80)}).to_string()})).1);
    }
}
