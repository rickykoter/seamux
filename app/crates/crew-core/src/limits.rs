//! The account's usage limits, as the status line last saw them (the ADR
//! "Reset times come from the status line's rate_limits").
//!
//! ```text
//! ~/.cache/cmux-crew/limits.json
//! {"five_hour": {"used_percentage": 97, "resets_at": 1793990000} | null,
//!  "seven_day": {...} | null, "spend_limit": {...} | null, "at": 1793974348976}
//! ```
//!
//! Claude Code gives its status line `rate_limits` on every refresh, for
//! subscribers (and behind a gateway that sets a spend limit): each window's
//! `used_percentage` (0-100) and `resets_at` (seconds since the epoch). A
//! window is there only while the API reports it and its reset is ahead.
//! The StopFailure hook carries no reset time, so both status lines
//! (the retired statusline.py and crew-hooks' statusline.rs) kept this one file for it,
//! written only when a window changed. `at` is when it was written, in ms.
//! crew-hooks' stopfail reads it to say which window stopped a turn and when
//! it resets.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The windows Claude Code reports, in the order they are written.
pub const WINDOWS: [&str; 3] = ["five_hour", "seven_day", "spend_limit"];

/// A window at least this full is taken as the one a rate_limit stop hit.
/// The cache is a refresh behind the stop, so a full window can still read
/// a little under 100.
pub const FULL_PERCENT: f64 = 80.0;

pub fn path(dir: &Path) -> PathBuf {
    dir.join("limits.json")
}

/// The windows in a status line payload, each cut to its used_percentage and
/// resets_at, or None when the payload has no rate_limits.
pub fn from_statusline(payload: &Value) -> Option<Value> {
    let rl = payload.get("rate_limits").filter(|v| v.is_object())?;
    let mut out = serde_json::Map::new();
    for w in WINDOWS {
        let win = rl.get(w).filter(|v| v.is_object()).map(|v| {
            json!({"used_percentage": v.get("used_percentage").cloned().unwrap_or(Value::Null),
                   "resets_at": v.get("resets_at").cloned().unwrap_or(Value::Null)})
        });
        out.insert(w.into(), win.unwrap_or(Value::Null));
    }
    Some(Value::Object(out))
}

/// The cache on disk, or None.
pub fn read(dir: &Path) -> Option<Value> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path(dir)).ok()?).ok()?;
    v.is_object().then_some(v)
}

/// Whether two caches hold the same windows (`at` aside).
fn same_windows(a: &Value, b: &Value) -> bool {
    WINDOWS.iter().all(|w| a.get(*w).unwrap_or(&Value::Null) == b.get(*w).unwrap_or(&Value::Null))
}

/// Keep the windows of a status line payload (its raw text). Writes only
/// when the payload has rate_limits and they differ from the file's; true
/// when it wrote.
pub fn record(dir: &Path, payload: &str, now_ms: u64) -> bool {
    let Ok(p) = serde_json::from_str::<Value>(payload) else { return false };
    let Some(mut wins) = from_statusline(&p) else { return false };
    if read(dir).is_some_and(|old| same_windows(&old, &wins)) {
        return false;
    }
    wins["at"] = json!(now_ms);
    crate::py::write_atomic(&path(dir), format!("{wins}\n").as_bytes()).is_ok()
}

/// A window's used share and its reset, in seconds, when the reset is
/// still ahead of `now_s`.
fn window(limits: &Value, w: &str, now_s: u64) -> Option<(f64, u64)> {
    let v = limits.get(w)?;
    let resets = v.get("resets_at").and_then(Value::as_f64).filter(|r| *r > now_s as f64)? as u64;
    Some((v.get("used_percentage").and_then(Value::as_f64).unwrap_or(0.0), resets))
}

/// Which window stopped a turn with `error`, and when it resets (seconds),
/// from the cache. A billing_error is the spend limit. A rate_limit is the
/// fullest window at least FULL_PERCENT full, and when both the five-hour
/// and the weekly are full, the weekly: nothing resumes before the later
/// reset. Nothing known is (None, None): the stop is recorded without a
/// reset time and an armed resume waits for the person.
pub fn stopped_by(limits: Option<&Value>, error: &str, now_s: u64) -> (Option<&'static str>, Option<u64>) {
    let Some(l) = limits else { return (None, None) };
    if error == "billing_error" {
        return match window(l, "spend_limit", now_s) {
            Some((_, r)) => (Some("spend_limit"), Some(r)),
            None => (None, None),
        };
    }
    let full: Vec<(&'static str, f64, u64)> = ["five_hour", "seven_day"].into_iter()
        .filter_map(|w| window(l, w, now_s).map(|(u, r)| (w, u, r)))
        .filter(|(_, u, _)| *u >= FULL_PERCENT)
        .collect();
    let best = if full.iter().filter(|(_, u, _)| *u >= 100.0).count() > 1 {
        full.iter().max_by_key(|(_, _, r)| *r)
    } else {
        full.iter().max_by(|a, b| a.1.total_cmp(&b.1).then(b.2.cmp(&a.2)))
    };
    match best {
        Some((w, _, r)) => (Some(*w), Some(*r)),
        None => (None, None),
    }
}

/// A window's name as a person reads it.
pub fn window_label(w: &str) -> &'static str {
    match w {
        "five_hour" => "5h limit",
        "seven_day" => "weekly limit",
        "spend_limit" => "spend limit",
        _ => "usage limit",
    }
}

/// A moment as the local clock shows it: "3:04pm" today, "Sat 3:04pm"
/// within the week, "Nov 14 3:04pm" past that.
pub fn clock(at_s: u64, now_s: u64) -> String {
    let tm = |t: u64| {
        let t = t as libc::time_t;
        // SAFETY: localtime_r writes only into tm, which we own.
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe { libc::localtime_r(&t, &mut tm) };
        tm
    };
    let (a, n) = (tm(at_s), tm(now_s));
    let h12 = match a.tm_hour % 12 { 0 => 12, h => h };
    let hm = format!("{h12}:{:02}{}", a.tm_min, if a.tm_hour < 12 { "am" } else { "pm" });
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    if (a.tm_year, a.tm_yday) == (n.tm_year, n.tm_yday) {
        hm
    } else if at_s > now_s && at_s - now_s < 6 * 86_400 {
        format!("{} {hm}", DAYS[a.tm_wday.rem_euclid(7) as usize])
    } else {
        format!("{} {} {hm}", MONTHS[a.tm_mon.rem_euclid(12) as usize], a.tm_mday)
    }
}

/// The notification's body for a limit stop: "5h limit · resets 3:04pm",
/// "Spend limit reached", "Rate limited · reset time unknown".
pub fn stop_text(error: &str, window: Option<&str>, resets_s: Option<u64>, now_s: u64) -> String {
    match (window, resets_s) {
        (Some(w), Some(r)) => format!("{} · resets {}", window_label(w), clock(r, now_s)),
        _ if error == "billing_error" => "Spend limit reached".into(),
        _ => "Rate limited · reset time unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("crew-limits-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A status line payload as Claude Code 2.1.318 builds it.
    fn payload(five: f64, week: f64) -> String {
        json!({"session_id": "s", "model": {"id": "m"},
               "rate_limits": {"five_hour": {"used_percentage": five, "resets_at": 2_000},
                               "seven_day": {"used_percentage": week, "resets_at": 9_000}}}).to_string()
    }

    #[test]
    fn the_cache_is_written_only_when_a_window_changes() {
        let d = tmp("record");
        assert!(!record(&d, r#"{"model": {"id": "m"}}"#, 1), "no rate_limits, no file");
        assert!(!path(&d).exists());
        assert!(record(&d, &payload(40.0, 10.0), 5));
        let v = read(&d).unwrap();
        assert_eq!(v["five_hour"], json!({"used_percentage": 40.0, "resets_at": 2_000}));
        assert_eq!((v["spend_limit"].clone(), v["at"].clone()), (Value::Null, json!(5)));
        assert!(!record(&d, &payload(40.0, 10.0), 6), "the same windows: no write");
        assert_eq!(read(&d).unwrap()["at"], json!(5));
        assert!(record(&d, &payload(41.0, 10.0), 7));
        assert!(!record(&d, "not json", 8));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_stop_is_put_on_the_window_that_filled() {
        let l = |five: f64, week: f64| from_statusline(&serde_json::from_str(&payload(five, week)).unwrap()).unwrap();
        assert_eq!(stopped_by(Some(&l(99.0, 40.0)), "rate_limit", 1_000), (Some("five_hour"), Some(2_000)));
        assert_eq!(stopped_by(Some(&l(30.0, 100.0)), "rate_limit", 1_000), (Some("seven_day"), Some(9_000)));
        assert_eq!(stopped_by(Some(&l(100.0, 100.0)), "rate_limit", 1_000), (Some("seven_day"), Some(9_000)),
                   "both full: the later reset");
        assert_eq!(stopped_by(Some(&l(50.0, 20.0)), "rate_limit", 1_000), (None, None), "nothing near full: no guess");
        assert_eq!(stopped_by(Some(&l(99.0, 40.0)), "rate_limit", 2_000), (None, None), "a reset already passed");
        assert_eq!(stopped_by(None, "rate_limit", 0), (None, None));
        assert_eq!(stopped_by(Some(&l(99.0, 40.0)), "billing_error", 1_000), (None, None), "no spend limit reported");
        let spend = json!({"spend_limit": {"used_percentage": 100, "resets_at": 5_000}});
        assert_eq!(stopped_by(Some(&spend), "billing_error", 1_000), (Some("spend_limit"), Some(5_000)));
    }

    #[test]
    fn the_stop_reads_as_a_window_and_a_time() {
        assert_eq!(stop_text("billing_error", None, None, 0), "Spend limit reached");
        assert_eq!(stop_text("rate_limit", None, None, 0), "Rate limited · reset time unknown");
        let now = 1_793_974_348;
        let t = stop_text("rate_limit", Some("five_hour"), Some(now + 60), now);
        assert!(t.starts_with("5h limit · resets ") && (t.ends_with("am") || t.ends_with("pm")), "{t}");
        let days = clock(now + 3 * 86_400, now);
        assert!(["Sun ", "Mon ", "Tue ", "Wed ", "Thu ", "Fri ", "Sat "].iter().any(|d| days.starts_with(d)), "{days}");
        assert!(clock(now + 30 * 86_400, now).split(' ').count() == 3);
    }
}
