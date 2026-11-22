//! The Bosun's loops: timed prompts from bosun.json's `loops`, queued for
//! the supervisor to type in. The supervisor calls `tick` once per poll; it
//! only enqueues (a `loop:<id>` source), and the idle drain types the items.
//!
//! ```text
//! bosun.json  "loops": [{"id": "checkin", "at": ["09:00"], "days": "weekdays",
//!                        "prompt": "…", "enabled": true},
//!                       {"id": "inbox", "every": "2h", "prompt": "…"}]
//! loops-state.json      {"<id>": {"last": <secs>, "slot": "YYYY-MM-DD HH:MM", "queued": "<item id>"}}
//! ```
//!
//! `at` loops run at each listed local time on their `days` (daily,
//! weekdays, weekends, or a list such as ["mon", "thu"]). A time missed
//! while the machine slept runs once when it wakes, if it is still the same
//! day; a missed time from an earlier day is dropped. `every` loops run once
//! the interval has passed since their last run. A new loop starts counting
//! from when it is first seen, so adding one at 15:00 does not fire its
//! 09:00 time at once. A loop whose last item still waits in the queue is
//! not queued again.
//!
//! The first tick that finds bosun.json without a `loops` key writes the
//! starter loops into it; an empty list is the person's and stays empty.

use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};

use super::queue;

const STATE: &str = "loops-state.json";
/// The shortest `every` interval: anything less would keep the Bosun busy.
const MIN_EVERY: i64 = 5 * 60;

/// When a loop runs.
#[derive(Clone, Debug, PartialEq)]
pub enum Sched {
    /// Local minutes of the day, sorted.
    At(Vec<u32>),
    /// Seconds between runs.
    Every(i64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Loop {
    pub id: String,
    pub sched: Sched,
    /// Which weekdays it runs on, indexed Sunday = 0.
    pub days: [bool; 7],
    pub prompt: String,
    pub enabled: bool,
}

/// A local moment: what the schedule is read against.
#[derive(Clone, Debug, PartialEq)]
pub struct Local {
    /// YYYY-MM-DD.
    pub day: String,
    /// Sunday = 0.
    pub wday: usize,
    /// Minutes since local midnight.
    pub minute: u32,
}

/// The local date, weekday and minute at `secs` since the epoch.
pub fn local(secs: i64) -> Local {
    // SAFETY: localtime_r writes only into `tm`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t: libc::time_t = secs as libc::time_t;
    unsafe { libc::localtime_r(&t, &mut tm) };
    Local {
        day: format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday),
        wday: tm.tm_wday.clamp(0, 6) as usize,
        minute: (tm.tm_hour.max(0) * 60 + tm.tm_min.max(0)) as u32,
    }
}

/// What one loop last did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Last {
    /// When it was last queued (or first seen), in seconds since the epoch.
    pub last: i64,
    /// The `at` time it last covered, "YYYY-MM-DD HH:MM".
    pub slot: String,
    /// The queue item id of its last run.
    pub queued: String,
}

fn hhmm(m: u32) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60 && !s.trim().starts_with('+')).then_some(h * 60 + m)
}

fn parse_every(s: &str) -> Option<i64> {
    let s = s.trim();
    let (n, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit())?);
    let n: i64 = n.parse().ok()?;
    let secs = match unit {
        "m" => n * 60,
        "h" => n * 3600,
        _ => return None,
    };
    (secs >= MIN_EVERY).then_some(secs)
}

const DAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn parse_days(v: Option<&Value>) -> Result<[bool; 7], String> {
    match v {
        None => Ok([true; 7]),
        Some(Value::String(s)) => match s.trim() {
            "daily" | "" => Ok([true; 7]),
            "weekdays" => Ok([false, true, true, true, true, true, false]),
            "weekends" => Ok([true, false, false, false, false, false, true]),
            other => Err(format!("days {other:?}: use daily, weekdays, weekends or a list of mon..sun")),
        },
        Some(Value::Array(a)) => {
            let mut d = [false; 7];
            for x in a {
                let name = x.as_str().unwrap_or("").trim().to_ascii_lowercase();
                let i = DAY_NAMES.iter().position(|n| name.starts_with(n)).ok_or(format!("days: {x} is not a weekday"))?;
                d[i] = true;
            }
            if d.iter().any(|b| *b) { Ok(d) } else { Err("days: the list is empty".into()) }
        }
        Some(x) => Err(format!("days: {x} is not a string or a list")),
    }
}

/// One entry of `loops`: the loop, or why it can't run.
pub fn parse(v: &Value) -> Result<Loop, String> {
    let id = v.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !queue::valid_id(&id) || id.len() > 40 {
        return Err(format!("id {id:?}: use letters, digits and dashes"));
    }
    let prompt = v.get("prompt").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if prompt.is_empty() {
        return Err(format!("{id}: no prompt"));
    }
    let sched = match (v.get("at"), v.get("every")) {
        (Some(_), Some(_)) => return Err(format!("{id}: give at or every, not both")),
        (Some(at), None) => {
            let list: Vec<&Value> = match at {
                Value::Array(a) => a.iter().collect(),
                one => vec![one],
            };
            let mut mins = Vec::new();
            for t in list {
                mins.push(t.as_str().and_then(parse_hhmm).ok_or(format!("{id}: at {t} is not HH:MM"))?);
            }
            if mins.is_empty() {
                return Err(format!("{id}: at lists no times"));
            }
            mins.sort_unstable();
            mins.dedup();
            Sched::At(mins)
        }
        (None, Some(e)) => Sched::Every(e.as_str().and_then(parse_every).ok_or(format!("{id}: every {e} is not <n>m or <n>h of at least 5m"))?),
        (None, None) => return Err(format!("{id}: no at or every")),
    };
    let days = parse_days(v.get("days")).map_err(|e| format!("{id}: {e}"))?;
    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    Ok(Loop { id, sched, days, prompt, enabled })
}

/// The latest `at` time at or before `now` today, as a slot name, when the
/// loop runs today.
fn latest_slot(l: &Loop, now: &Local) -> Option<String> {
    let Sched::At(mins) = &l.sched else { return None };
    if !l.days[now.wday] {
        return None;
    }
    mins.iter().rev().find(|m| **m <= now.minute).map(|m| format!("{} {}", now.day, hhmm(*m)))
}

/// What the tick does with a loop.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Nothing yet.
    Wait,
    /// First seen: start counting from now, without running.
    Begin(Last),
    /// Run it, covering this state.
    Run(Last),
}

/// Whether `l` is due at `now_secs` (`now` its local reading), given what it last did.
pub fn step(l: &Loop, last: Option<&Last>, now_secs: i64, now: &Local) -> Step {
    if !l.enabled {
        return Step::Wait;
    }
    let slot = latest_slot(l, now).unwrap_or_default();
    let Some(last) = last else {
        return Step::Begin(Last { last: now_secs, slot, queued: String::new() });
    };
    let due = match &l.sched {
        // Slot names sort as times, and only today's are ever named, so a
        // missed one from an earlier day never runs.
        Sched::At(_) => !slot.is_empty() && slot > last.slot,
        Sched::Every(secs) => l.days[now.wday] && now_secs - last.last >= *secs,
    };
    if due {
        Step::Run(Last { last: now_secs, slot: if slot.is_empty() { last.slot.clone() } else { slot }, queued: String::new() })
    } else {
        Step::Wait
    }
}

/// The next time `l` would run after `now_secs`, given `last`: seconds since
/// the epoch, or None when it never will (disabled) or not within 8 days.
pub fn next_run(l: &Loop, last: Option<&Last>, now_secs: i64) -> Option<i64> {
    if !l.enabled {
        return None;
    }
    let last = match last {
        Some(x) => x.clone(),
        None => match step(l, None, now_secs, &local(now_secs)) {
            Step::Begin(b) => b,
            _ => return None,
        },
    };
    let start = now_secs - now_secs.rem_euclid(60) + 60;
    (0..8 * 24 * 60).map(|i| start + i * 60).find(|t| matches!(step(l, Some(&last), *t, &local(*t)), Step::Run(_)))
}

/// The text typed into the Bosun for one run of `l`.
pub fn prompt_text(l: &Loop, item: &str, slot: &str, seamux: &str) -> String {
    let q = crate::native::sh_quote(seamux);
    let when = if slot.is_empty() { String::new() } else { format!(", {slot}") };
    format!(
        "[Loop {}{when}]\n{}\n\n\
Answer it, saying where each fact comes from. Then log it with `{q} bosun log add` \
(one JSON entry on stdin: question, answer, sources [{{kind, ref, label}}], asker \"loop:{}\", id \"{item}\").",
        l.id, l.prompt, l.id
    )
}

/// The starter loops, written into bosun.json when it has no `loops` key.
pub fn starters() -> Value {
    json!([
        {
            "id": "checkin",
            "at": ["09:00"],
            "days": "weekdays",
            "prompt": "Morning check-in. Give me a short sitrep across the code root: branches with work in progress, open pull requests and how their checks stand, live workspaces, and anything deployed since yesterday. End with what needs me today.",
            "enabled": true
        },
        {
            "id": "my-prs",
            "at": ["09:30", "14:00"],
            "days": "weekdays",
            "prompt": "List the open pull requests waiting on my review or assigned to me (gh search prs --state=open --review-requested=@me, and --assignee=@me), oldest first, with each one's repo, age and check status.",
            "enabled": true
        },
        {
            "id": "systems",
            "at": ["10:00"],
            "days": "weekdays",
            "prompt": "Systems check. In Datadog, list the monitors that are alerting or warning; in Splunk, look for error spikes over the last 24 hours. Say what changed since yesterday's check, and name the monitor, dashboard or search behind each point.",
            "enabled": true
        }
    ])
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("no folder")?;
    fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let tmp = parent.join(format!(".{}.{}.tmp", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), std::process::id()));
    fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default() + "\n").map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// bosun.json's loops in `dir`, writing the starters first when the file
/// has no `loops` key. Each entry parsed, or why not. A bosun.json that is
/// there but can't be read is left alone, with no loops.
pub fn load(dir: &Path) -> Vec<Result<Loop, String>> {
    let path = dir.join("bosun.json");
    let mut cfg = match fs::read_to_string(&path) {
        Ok(t) => match serde_json::from_str::<Value>(&t) {
            Ok(Value::Object(m)) => m,
            _ => return Vec::new(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(_) => return Vec::new(),
    };
    if !cfg.contains_key("loops") {
        cfg.insert("loops".into(), starters());
        if let Err(e) = write_json(&path, &Value::Object(cfg.clone())) {
            eprintln!("bosun loops: could not write the starter loops: {e}");
        }
    }
    cfg.get("loops").and_then(Value::as_array).map(|a| a.iter().map(parse).collect()).unwrap_or_default()
}

fn load_state(dir: &Path) -> Map<String, Value> {
    match read_json(&dir.join(STATE)) {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

fn last_of(state: &Map<String, Value>, id: &str) -> Option<Last> {
    let v = state.get(id)?;
    Some(Last {
        last: v.get("last").and_then(Value::as_i64).unwrap_or(0),
        slot: v.get("slot").and_then(Value::as_str).unwrap_or("").to_string(),
        queued: v.get("queued").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

fn put(state: &mut Map<String, Value>, id: &str, l: &Last) {
    state.insert(id.into(), json!({"last": l.last, "slot": l.slot, "queued": l.queued}));
}

/// Each loop's last run, by id: what loops-state.json holds.
pub fn state(dir: &Path) -> Vec<(String, Last)> {
    let s = load_state(dir);
    s.keys().filter_map(|k| last_of(&s, k).map(|l| (k.clone(), l))).collect()
}

/// Queue whatever loop is due at `now_secs`: the ids queued.
pub fn tick_at(dir: &Path, now_secs: i64, now: &Local, seamux: &str) -> Vec<String> {
    let loops: Vec<Loop> = load(dir).into_iter().filter_map(Result::ok).collect();
    if loops.is_empty() {
        return Vec::new();
    }
    let mut state = load_state(dir);
    let mut changed = false;
    let mut queued = Vec::new();
    let waiting: Vec<String> = queue::waiting(dir).into_iter().map(|i| i.source).collect();
    for l in &loops {
        match step(l, last_of(&state, &l.id).as_ref(), now_secs, now) {
            Step::Wait => {}
            Step::Begin(b) => {
                put(&mut state, &l.id, &b);
                changed = true;
            }
            Step::Run(mut r) => {
                // Its last run still waits to be typed: that one covers this time.
                if waiting.iter().any(|s| *s == format!("loop:{}", l.id)) {
                    r.queued = last_of(&state, &l.id).map(|x| x.queued).unwrap_or_default();
                    put(&mut state, &l.id, &r);
                    changed = true;
                    continue;
                }
                let item = crate::backend::tmux::new_id().to_ascii_lowercase();
                match queue::enqueue_as(dir, &item, &prompt_text(l, &item, &r.slot, seamux), &format!("loop:{}", l.id)) {
                    Ok(_) => {
                        r.queued = item;
                        put(&mut state, &l.id, &r);
                        changed = true;
                        queued.push(l.id.clone());
                    }
                    // Not marked: the next tick tries again.
                    Err(e) => eprintln!("bosun loops: could not queue {}: {e}", l.id),
                }
            }
        }
    }
    // Loops no longer in bosun.json leave the state.
    let before = state.len();
    state.retain(|k, _| loops.iter().any(|l| &l.id == k));
    if changed || state.len() != before {
        if let Err(e) = write_json(&dir.join(STATE), &Value::Object(state)) {
            eprintln!("bosun loops: could not save {STATE}: {e}");
        }
    }
    queued
}

/// The supervisor's call, once per poll: queue whatever loop is due.
pub fn tick(dir: &Path, now_secs: i64) {
    tick_at(dir, now_secs, &local(now_secs), &super::launch::seamux_bin());
}

/// Queue loop `id` now, whatever its schedule: the item id.
pub fn run_now(dir: &Path, id: &str, now_secs: i64) -> Result<String, String> {
    let l = load(dir).into_iter().filter_map(Result::ok).find(|l| l.id == id).ok_or(format!("no loop {id:?} in bosun.json"))?;
    let item = crate::backend::tmux::new_id().to_ascii_lowercase();
    queue::enqueue_as(dir, &item, &prompt_text(&l, &item, "", &super::launch::seamux_bin()), &format!("loop:{id}"))?;
    let mut state = load_state(dir);
    let mut last = last_of(&state, id).unwrap_or_default();
    last.last = now_secs;
    last.queued = item.clone();
    put(&mut state, id, &last);
    write_json(&dir.join(STATE), &Value::Object(state))?;
    Ok(item)
}

fn sched_text(l: &Loop) -> String {
    let days = match l.days {
        [true, true, true, true, true, true, true] => "daily".to_string(),
        [false, true, true, true, true, true, false] => "weekdays".to_string(),
        [true, false, false, false, false, false, true] => "weekends".to_string(),
        d => DAY_NAMES.iter().zip(d).filter(|(_, on)| *on).map(|(n, _)| *n).collect::<Vec<_>>().join(","),
    };
    match &l.sched {
        Sched::At(m) => format!("{} {days}", m.iter().map(|x| hhmm(*x)).collect::<Vec<_>>().join(",")),
        Sched::Every(s) if s % 3600 == 0 => format!("every {}h {days}", s / 3600),
        Sched::Every(s) => format!("every {}m {days}", s / 60),
    }
}

fn when_text(secs: i64, now_secs: i64) -> String {
    let (a, b) = (local(secs), local(now_secs));
    let hm = hhmm(a.minute);
    if a.day == b.day { format!("today {hm}") } else { format!("{} {hm}", a.day) }
}

/// Each loop, its schedule and its next run, for `loops list`.
pub fn list(dir: &Path, now_secs: i64) -> Vec<Value> {
    let state = load_state(dir);
    load(dir)
        .into_iter()
        .map(|r| match r {
            Ok(l) => {
                let last = last_of(&state, &l.id);
                let next = next_run(&l, last.as_ref(), now_secs);
                json!({
                    "id": l.id, "schedule": sched_text(&l), "enabled": l.enabled,
                    "next": next, "nextText": next.map(|n| when_text(n, now_secs)).unwrap_or_else(|| "never".into()),
                    "last": last.as_ref().map(|x| x.last).filter(|x| *x > 0),
                    "lastItem": last.map(|x| x.queued).unwrap_or_default(),
                    "prompt": l.prompt,
                })
            }
            Err(e) => json!({"error": e}),
        })
        .collect()
}

/// `seamux bosun loops [list] [--json] | loops run <id>`.
pub fn main(args: &[String], dir: &Path) -> i32 {
    let json_out = args.iter().any(|a| a == "--json");
    let words: Vec<&str> = args.iter().map(String::as_str).filter(|a| !a.starts_with("--")).collect();
    let now = super::launch::now_secs();
    match words.as_slice() {
        [] | ["list"] => {
            let rows = list(dir, now);
            if json_out {
                println!("{}", json!({"loops": rows}));
            } else if rows.is_empty() {
                println!("no loops (bosun.json's loops list is empty)");
            } else {
                for r in rows {
                    match r.get("error").and_then(Value::as_str) {
                        Some(e) => println!("  !  {e}"),
                        None => println!(
                            "  {:<12} {:<28} next {}{}",
                            r["id"].as_str().unwrap_or(""),
                            r["schedule"].as_str().unwrap_or(""),
                            r["nextText"].as_str().unwrap_or(""),
                            if r["enabled"] == false { " (off)" } else { "" }
                        ),
                    }
                }
            }
            0
        }
        ["run", id] => match run_now(dir, id, now) {
            Ok(item) => {
                println!("{}", if json_out { json!({"id": item}).to_string() } else { format!("queued loop {id} as {item}") });
                0
            }
            Err(e) => {
                eprintln!("bosun loops run: {e}");
                1
            }
        },
        _ => {
            eprintln!("usage: seamux bosun loops [list] [--json] | loops run <id>");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bosun-loops-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn at(day: &str, wday: usize, h: u32, m: u32) -> Local {
        Local { day: day.into(), wday, minute: h * 60 + m }
    }

    fn checkin() -> Loop {
        parse(&json!({"id": "checkin", "at": ["09:00"], "days": "weekdays", "prompt": "sitrep"})).unwrap()
    }

    #[test]
    fn entries_parse_and_bad_ones_say_why() {
        let l = parse(&json!({"id": "prs", "at": ["14:00", "09:30"], "days": ["mon", "Thursday"], "prompt": "p"})).unwrap();
        assert_eq!(l.sched, Sched::At(vec![570, 840]));
        assert_eq!(l.days, [false, true, false, false, true, false, false]);
        assert!(l.enabled);
        assert_eq!(parse(&json!({"id": "e", "every": "2h", "prompt": "p"})).unwrap().sched, Sched::Every(7200));
        for bad in [
            json!({"id": "x", "prompt": "p"}),
            json!({"id": "x", "at": "9am", "prompt": "p"}),
            json!({"id": "x", "at": "24:00", "prompt": "p"}),
            json!({"id": "x", "every": "1m", "prompt": "p"}),
            json!({"id": "x", "at": "09:00", "every": "1h", "prompt": "p"}),
            json!({"id": "x", "at": "09:00"}),
            json!({"id": "../x", "at": "09:00", "prompt": "p"}),
            json!({"id": "x", "at": "09:00", "days": ["funday"], "prompt": "p"}),
        ] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_new_loop_starts_counting_without_running() {
        let l = checkin();
        let s = step(&l, None, 1000, &at("2026-11-23", 1, 15, 0));
        assert_eq!(s, Step::Begin(Last { last: 1000, slot: "2026-11-23 09:00".into(), queued: String::new() }));
    }

    #[test]
    fn a_time_missed_in_sleep_runs_once_the_same_day() {
        let l = checkin();
        // Seen Monday 08:00; asleep until 11:00.
        let seen = Last { last: 0, slot: String::new(), queued: String::new() };
        let Step::Run(r) = step(&l, Some(&seen), 11 * 3600, &at("2026-11-23", 1, 11, 0)) else { panic!("not run") };
        assert_eq!(r.slot, "2026-11-23 09:00");
        assert_eq!(step(&l, Some(&r), 11 * 3600 + 60, &at("2026-11-23", 1, 11, 1)), Step::Wait);
    }

    #[test]
    fn a_time_missed_on_an_earlier_day_is_dropped() {
        let l = checkin();
        let fri = Last { last: 0, slot: "2026-11-20 09:00".into(), queued: String::new() };
        // Asleep all weekend, awake Monday 08:30: Friday's and Monday's are not due.
        assert_eq!(step(&l, Some(&fri), 0, &at("2026-11-23", 1, 8, 30)), Step::Wait);
        // Saturday is not a weekday.
        assert_eq!(step(&l, Some(&fri), 0, &at("2026-11-21", 6, 10, 0)), Step::Wait);
        assert!(matches!(step(&l, Some(&fri), 0, &at("2026-11-23", 1, 9, 0)), Step::Run(_)));
    }

    #[test]
    fn two_missed_times_run_once() {
        let l = parse(&json!({"id": "prs", "at": ["09:30", "14:00"], "prompt": "p"})).unwrap();
        let before = Last { last: 0, slot: "2026-11-23 08:00".into(), queued: String::new() };
        let Step::Run(r) = step(&l, Some(&before), 0, &at("2026-11-23", 1, 15, 0)) else { panic!() };
        assert_eq!(r.slot, "2026-11-23 14:00");
        assert_eq!(step(&l, Some(&r), 0, &at("2026-11-23", 1, 15, 1)), Step::Wait);
    }

    #[test]
    fn every_runs_after_its_interval_and_off_loops_never() {
        let l = parse(&json!({"id": "e", "every": "30m", "prompt": "p"})).unwrap();
        let last = Last { last: 10_000, slot: String::new(), queued: String::new() };
        assert_eq!(step(&l, Some(&last), 10_000 + 1799, &at("2026-11-23", 1, 10, 0)), Step::Wait);
        assert!(matches!(step(&l, Some(&last), 10_000 + 1800, &at("2026-11-23", 1, 10, 0)), Step::Run(_)));
        let off = parse(&json!({"id": "o", "every": "30m", "prompt": "p", "enabled": false})).unwrap();
        assert_eq!(step(&off, None, 0, &at("2026-11-23", 1, 10, 0)), Step::Wait);
        assert_eq!(next_run(&off, None, 0), None);
    }

    #[test]
    fn next_run_finds_the_next_time() {
        let l = parse(&json!({"id": "d", "at": ["09:00"], "prompt": "p"})).unwrap();
        let now = super::super::launch::now_secs();
        let n = next_run(&l, None, now).expect("a daily loop runs within a day");
        assert!(n > now && n - now <= 24 * 3600 + 60);
        assert_eq!(local(n).minute, 9 * 60);
    }

    #[test]
    fn the_starters_are_written_once_and_an_empty_list_stays() {
        let d = tmp("seed");
        let got = load(&d);
        assert_eq!(got.len(), 3);
        assert!(got.iter().all(Result::is_ok));
        let v = read_json(&d.join("bosun.json")).unwrap();
        assert_eq!(v["loops"].as_array().unwrap().len(), 3);
        // The person's other keys are kept, and their empty list is theirs.
        write_json(&d.join("bosun.json"), &json!({"resetHour": 6, "loops": []})).unwrap();
        assert!(load(&d).is_empty());
        assert_eq!(read_json(&d.join("bosun.json")).unwrap(), json!({"resetHour": 6, "loops": []}));
        write_json(&d.join("bosun.json"), &json!({"resetHour": 6})).unwrap();
        assert_eq!(load(&d).len(), 3);
        assert_eq!(read_json(&d.join("bosun.json")).unwrap()["resetHour"], 6);
        // One that can't be read is left alone.
        fs::write(d.join("bosun.json"), "{ not json").unwrap();
        assert!(load(&d).is_empty());
        assert_eq!(fs::read_to_string(d.join("bosun.json")).unwrap(), "{ not json");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn tick_queues_a_due_loop_once_while_it_waits() {
        let d = tmp("tick");
        write_json(&d.join("bosun.json"), &json!({"loops": [{"id": "checkin", "at": ["09:00"], "prompt": "sitrep"}]})).unwrap();
        let mon = |h, m| at("2026-11-23", 1, h, m);
        // First seen before nine: counting starts, nothing queued.
        assert!(tick_at(&d, 100, &mon(8, 59), "/bin/seamux").is_empty());
        assert_eq!(tick_at(&d, 160, &mon(9, 0), "/bin/seamux"), ["checkin"]);
        let w = queue::waiting(&d);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].source, "loop:checkin");
        assert!(w[0].text.starts_with("[Loop checkin, 2026-11-23 09:00]\nsitrep"));
        assert!(w[0].text.contains(&format!("asker \"loop:checkin\", id \"{}\"", w[0].id)));
        assert!(tick_at(&d, 220, &mon(9, 1), "/bin/seamux").is_empty());
        let st = state(&d);
        assert_eq!(st[0].1.queued, w[0].id);
        // Tuesday's time comes while Monday's still waits: not queued twice.
        assert!(tick_at(&d, 90_000, &at("2026-11-24", 2, 9, 0), "/bin/seamux").is_empty());
        assert_eq!(queue::waiting(&d).len(), 1);
        assert_eq!(state(&d)[0].1.slot, "2026-11-24 09:00");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn run_now_queues_and_a_removed_loop_leaves_the_state() {
        let d = tmp("run");
        write_json(&d.join("bosun.json"), &json!({"loops": [{"id": "a", "every": "1h", "prompt": "pa"}, {"id": "b", "every": "1h", "prompt": "pb"}]})).unwrap();
        tick_at(&d, 100, &at("2026-11-23", 1, 9, 0), "/bin/seamux");
        assert_eq!(state(&d).len(), 2);
        let item = run_now(&d, "b", 200).unwrap();
        assert_eq!(queue::waiting(&d)[0].id, item);
        assert!(run_now(&d, "zz", 200).is_err());
        write_json(&d.join("bosun.json"), &json!({"loops": [{"id": "a", "every": "1h", "prompt": "pa"}]})).unwrap();
        tick_at(&d, 300, &at("2026-11-23", 1, 9, 5), "/bin/seamux");
        assert_eq!(state(&d).into_iter().map(|(k, _)| k).collect::<Vec<_>>(), ["a"]);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn list_shows_each_loop_and_the_bad_ones() {
        let d = tmp("list");
        write_json(&d.join("bosun.json"), &json!({"loops": [{"id": "a", "at": "09:00", "days": "weekdays", "prompt": "p"}, {"id": "b"}]})).unwrap();
        let rows = list(&d, super::super::launch::now_secs());
        assert_eq!(rows[0]["schedule"], "09:00 weekdays");
        assert!(rows[0]["next"].is_i64());
        assert!(rows[1]["error"].as_str().unwrap().contains("no prompt"));
        let _ = fs::remove_dir_all(&d);
    }
}
