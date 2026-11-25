//! The Bosun's reports: timed runs of checked sections, from bosun.json's
//! `reports` (the bosun-reports plan's ADRs).
//!
//! ```text
//! bosun.json  "reports": [{"id": "morning", "title": "Morning report", "at": ["09:00"], "days": "weekdays",
//!                          "sections": [{"title": "Monitors", "via": ["mcp:datadog"], "ask": "…"}],
//!                          "to": ["doc", "banner"], "enabled": true}]
//! reports-state.json     {"<id>": {"last", "slot", "queued", "doc", "note"}}
//! reports/runs/<run>.json  one run: what was queued, then what the check found
//! ```
//!
//! A report keeps the loops' schedule rules (loops.rs) and its own state. A
//! due run goes into the queue as a placeholder (source `report:<id>`); the
//! supervisor, just before it types one, checks the sources (sources.rs)
//! and puts the whole prompt in its place, where a section whose source is
//! down already reads "Not checked: <why>". Nothing the Bosun runs from its
//! sandbox needs to check sources: `report run` and `report list` read and
//! queue only. `report check` is for a person's shell; run inside the
//! sandbox, its `claude mcp list` may fail, and it says so.
//!
//! The supervisor's first tick that finds no `reports` key writes the
//! starter reports, built from the MCP servers `claude mcp list` lists,
//! and turns off the starter loops they cover when those are still as
//! shipped. An empty list is the person's and stays empty.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::{json, Map, Value};

use super::loops::{self, Last, Local, Loop, Step};
use super::queue;
use super::sources::{Found, Via};

const STATE: &str = "reports-state.json";
const LOCK: &str = "reports.lock";
/// How long after a failed try the starters are tried again, in seconds.
const SEED_RETRY: i64 = 30 * 60;

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    pub title: String,
    pub via: Vec<Via>,
    pub ask: String,
    /// The hosts its cmd: sources need the sandbox to let out, in place of
    /// the built-in table (sources.rs); Some(empty) turns the check off.
    pub hosts: Option<Vec<String>>,
}

/// A section's `hosts`: absent, or a list of the host names its CLI
/// connects to (dot-separated labels of letters, digits and dashes; no
/// wildcard or port, which belong in allowedDomains), or why not.
fn hosts_of(s: &Value) -> Result<Option<Vec<String>>, String> {
    let bare = |h: &str| h.split('.').all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    match s.get("hosts") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map(str::trim).filter(|h| bare(h)).map(str::to_string).ok_or(format!("hosts {x}: use host names like api.example.com")))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(x) => Err(format!("hosts {x} is not a list")),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub id: String,
    pub title: String,
    /// When it runs: a Loop holding only the schedule (its prompt is unused).
    pub when: Loop,
    pub sections: Vec<Section>,
    /// `to` holds "doc": the run updates the report's Claude Doc.
    pub doc: bool,
    /// `to` holds "banner": a run that finds something for the person posts one.
    pub banner: bool,
}

/// The Claude Docs connector, as a source a doc-bound run needs.
pub fn docs_via() -> Via {
    Via::Mcp("claude docs".into())
}

fn text(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

/// "morning" → "Morning report".
fn title_of(id: &str) -> String {
    let words = id.replace('-', " ");
    let mut c = words.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect::<String>() + " report").unwrap_or_default()
}

/// One entry of `reports`: the report, or why it can't run.
pub fn parse(v: &Value) -> Result<Report, String> {
    let id = text(v, "id");
    if !queue::valid_id(&id) || id.len() > 40 {
        return Err(format!("id {id:?}: use letters, digits and dashes"));
    }
    let (sched, days) = loops::parse_sched(v, &id)?;
    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    let list = v.get("sections").and_then(Value::as_array).ok_or(format!("{id}: no sections"))?;
    let mut sections = Vec::new();
    for (i, s) in list.iter().enumerate() {
        let title = text(s, "title");
        let ask = text(s, "ask");
        if title.is_empty() || ask.is_empty() {
            return Err(format!("{id}: section {} needs a title and an ask", i + 1));
        }
        let via = match s.get("via") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a.iter().map(|x| Via::parse(x.as_str().unwrap_or(""))).collect::<Result<Vec<_>, _>>().map_err(|e| format!("{id}: {title}: {e}"))?,
            Some(x) => return Err(format!("{id}: {title}: via {x} is not a list")),
        };
        let hosts = hosts_of(s).map_err(|e| format!("{id}: {title}: {e}"))?;
        if sections.iter().any(|s: &Section| s.title.eq_ignore_ascii_case(&title)) {
            return Err(format!("{id}: two sections are titled {title:?}"));
        }
        sections.push(Section { title, via, ask, hosts });
    }
    if sections.is_empty() {
        return Err(format!("{id}: no sections"));
    }
    let (doc, banner) = match v.get("to") {
        None | Some(Value::Null) => (true, true),
        Some(Value::Array(a)) => {
            let mut to = (false, false);
            for x in a {
                match x.as_str().unwrap_or("") {
                    "doc" => to.0 = true,
                    "banner" => to.1 = true,
                    other => return Err(format!("{id}: to {other:?}: use doc and banner")),
                }
            }
            to
        }
        Some(x) => return Err(format!("{id}: to {x} is not a list")),
    };
    let title = Some(text(v, "title")).filter(|t| !t.is_empty()).unwrap_or_else(|| title_of(&id));
    Ok(Report { when: Loop { id: id.clone(), sched, days, prompt: String::new(), enabled }, id, title, sections, doc, banner })
}

fn bosun_json(dir: &Path) -> PathBuf {
    dir.join("bosun.json")
}

/// bosun.json's reports in `dir`, each parsed or why not. Read only: the
/// starters are the supervisor's to write (`seed`).
pub fn load(dir: &Path) -> Vec<Result<Report, String>> {
    let entries = loops::read_json(&bosun_json(dir)).and_then(|v| v.get("reports").and_then(Value::as_array).cloned()).unwrap_or_default();
    let mut seen: Vec<String> = Vec::new();
    entries
        .iter()
        .map(|v| {
            let r = parse(v)?;
            if seen.contains(&r.id) {
                return Err(format!("{}: another report already has this id", r.id));
            }
            seen.push(r.id.clone());
            Ok(r)
        })
        .collect()
}

/// The id of every entry in bosun.json's reports, parsed or not, or None
/// when bosun.json can't be read right now (mid-write, a typo): then no
/// report's kept state (its doc link) is dropped.
fn entry_ids(dir: &Path) -> Option<Vec<String>> {
    let v = loops::read_json(&bosun_json(dir)).filter(Value::is_object)?;
    Some(v.get("reports").and_then(Value::as_array).cloned().unwrap_or_default().iter().map(|e| text(e, "id")).collect())
}

// ---- state ----

/// What one report last did, and what it keeps between runs.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Kept {
    pub last: Last,
    /// Its Claude Doc's link, once a run has made one.
    pub doc: String,
    /// A line for its next run to pass on (the starter loops it turned off).
    pub note: String,
}

fn load_state(dir: &Path) -> Map<String, Value> {
    match loops::read_json(&dir.join(STATE)) {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

pub fn kept(state: &Map<String, Value>, id: &str) -> Option<Kept> {
    let v = state.get(id)?;
    Some(Kept {
        last: Last { last: v.get("last").and_then(Value::as_i64).unwrap_or(0), slot: text(v, "slot"), queued: text(v, "queued") },
        doc: text(v, "doc"),
        note: text(v, "note"),
    })
}

fn put(state: &mut Map<String, Value>, id: &str, k: &Kept) {
    state.insert(id.into(), json!({"last": k.last.last, "slot": k.last.slot, "queued": k.last.queued, "doc": k.doc, "note": k.note}));
}

/// Change report `id`'s kept state under the lock.
pub fn update_state(dir: &Path, id: &str, f: impl FnOnce(&mut Kept)) -> Result<(), String> {
    let _lock = crate::status::lock_file(dir, LOCK);
    let mut state = load_state(dir);
    let mut k = kept(&state, id).unwrap_or_default();
    f(&mut k);
    put(&mut state, id, &k);
    loops::write_json(&dir.join(STATE), &Value::Object(state))
}

// ---- runs ----

pub fn runs_dir(dir: &Path) -> PathBuf {
    dir.join("reports").join("runs")
}

pub fn run_file(dir: &Path, run: &str) -> PathBuf {
    runs_dir(dir).join(format!("{run}.json"))
}

pub fn read_run(dir: &Path, run: &str) -> Option<Value> {
    queue::valid_id(run).then(|| loops::read_json(&run_file(dir, run))).flatten()
}

pub fn write_run(dir: &Path, run: &str, v: &Value) -> Result<(), String> {
    loops::write_json(&run_file(dir, run), v)
}

/// What sits in the queue until the supervisor builds the run's prompt.
pub fn placeholder(id: &str, run: &str) -> String {
    format!("[Report {id} run {run}] (waiting for the supervisor's source check)")
}

/// Queue one run of `r`: the run's id.
fn enqueue(dir: &Path, r: &Report, slot: &str, now_secs: i64) -> Result<String, String> {
    let run = crate::backend::tmux::new_id().to_ascii_lowercase();
    write_run(dir, &run, &json!({"run": run, "report": r.id, "slot": slot, "queuedAt": now_secs, "built": false}))?;
    if let Err(e) = queue::enqueue_as(dir, &run, &placeholder(&r.id, &run), &format!("report:{}", r.id)) {
        let _ = fs::remove_file(run_file(dir, &run));
        return Err(e);
    }
    Ok(run)
}

/// Queue whatever report is due at `now_secs`: the ids queued.
pub fn tick_at(dir: &Path, now_secs: i64, now: &Local) -> Vec<String> {
    let reports: Vec<Report> = load(dir).into_iter().filter_map(Result::ok).collect();
    let _lock = crate::status::lock_file(dir, LOCK);
    let mut state = load_state(dir);
    let before = state.clone();
    let mut queued = Vec::new();
    let waiting: Vec<String> = queue::waiting(dir).into_iter().map(|i| i.source).collect();
    for r in &reports {
        let mut k = kept(&state, &r.id).unwrap_or_default();
        let had = kept(&state, &r.id).is_some();
        match loops::step(&r.when, had.then_some(&k.last), now_secs, now) {
            Step::Wait => {}
            Step::Begin(b) => {
                k.last = b;
                put(&mut state, &r.id, &k);
            }
            Step::Run(mut last) => {
                // Its last run still waits to be typed: that one covers this time.
                if waiting.iter().any(|s| *s == format!("report:{}", r.id)) {
                    last.queued = k.last.queued.clone();
                    k.last = last;
                    put(&mut state, &r.id, &k);
                    continue;
                }
                match enqueue(dir, r, &last.slot, now_secs) {
                    Ok(run) => {
                        last.queued = run;
                        k.last = last;
                        put(&mut state, &r.id, &k);
                        queued.push(r.id.clone());
                    }
                    Err(e) => super::supervise::warn(&format!("reports-queue-{}", r.id), &format!("bosun reports: could not queue {}: {e}", r.id)),
                }
            }
        }
    }
    if let Some(ids) = entry_ids(dir) {
        state.retain(|k, _| ids.iter().any(|id| id == k));
    }
    if state != before {
        if let Err(e) = loops::write_json(&dir.join(STATE), &Value::Object(state)) {
            super::supervise::warn("reports-state", &format!("bosun reports: could not save {STATE}: {e}"));
        }
    }
    queued
}

/// The supervisor's call, once per poll: write the starters on its first
/// tick that finds no `reports` key, then queue whatever is due.
pub fn tick(dir: &Path, root: &Path, now_secs: i64) {
    // A failed try (claude mcp list down, bosun.json unwritable) is tried
    // again after SEED_RETRY, not on every tick: each try lists the servers.
    static TRIED: AtomicI64 = AtomicI64::new(i64::MIN);
    let last = TRIED.load(Ordering::SeqCst);
    if now_secs.saturating_sub(last) >= SEED_RETRY && needs_seed(dir) {
        TRIED.store(now_secs, Ordering::SeqCst);
        if let Err(e) = seed(dir, &Found::look(root, &super::launch::launched_domains(dir))) {
            super::supervise::warn("reports-starters", &format!("bosun reports: could not write the starter reports yet: {e}"));
        }
    }
    tick_at(dir, now_secs, &loops::local(now_secs));
}

/// Queue report `id` now, whatever its schedule: the run's id.
pub fn run_now(dir: &Path, id: &str, now_secs: i64) -> Result<String, String> {
    let r = load(dir).into_iter().filter_map(Result::ok).find(|r| r.id == id).ok_or(format!("no report {id:?} in bosun.json"))?;
    let run = enqueue(dir, &r, "", now_secs)?;
    update_state(dir, id, |k| {
        k.last.last = now_secs;
        k.last.queued = run.clone();
    })?;
    Ok(run)
}

// ---- the prompt ----

/// One section after the check: each source with Ok or why it is down.
#[derive(Clone, Debug, PartialEq)]
pub struct Checked {
    pub section: Section,
    pub via: Vec<(Via, Result<(), String>)>,
}

impl Checked {
    /// Whether the Bosun can check it: no sources named, or one that works.
    pub fn runnable(&self) -> bool {
        self.via.is_empty() || self.via.iter().any(|(_, r)| r.is_ok())
    }

    /// Why it can't be checked: each source's why, joined.
    pub fn why(&self) -> String {
        self.via.iter().filter_map(|(_, r)| r.as_ref().err().cloned()).collect::<Vec<_>>().join("; ")
    }
}

pub fn check_sections(r: &Report, found: &Found) -> Vec<Checked> {
    r.sections.iter().map(|s| Checked { section: s.clone(), via: s.via.iter().map(|v| (v.clone(), found.check_with(v, s.hosts.as_deref()))).collect() }).collect()
}

/// What the run does with its Claude Doc.
#[derive(Clone, Debug, PartialEq)]
pub enum Doc {
    /// `to` leaves the doc out.
    Off,
    /// The connector is down: the run skips the doc and says why.
    Down(String),
    /// No doc yet: the run makes one.
    New,
    /// Its link.
    At(String),
}

pub fn doc_for(r: &Report, k: &Kept, found: &Found) -> Doc {
    if !r.doc {
        return Doc::Off;
    }
    match found.check(&docs_via()) {
        Err(why) => Doc::Down(why),
        Ok(()) if k.doc.is_empty() => Doc::New,
        Ok(()) => Doc::At(k.doc.clone()),
    }
}

/// The rule the Bosun marks a section "needs" by.
pub const NEEDS_RULE: &str = "Mark a section \"needs\" when something there waits on the person: an alert or monitor firing, a PR or review waiting on them for over a day, a failed deploy, or a red check on their branch. Otherwise mark it \"ok\". Mark it \"unchecked\" when its source fails while you use it, and say why.";

/// The prompt typed into the Bosun for one run, once its sources are checked.
#[allow(clippy::too_many_arguments)]
pub fn prompt_text(r: &Report, run: &str, slot: &str, checked_at: &str, sections: &[Checked], doc: &Doc, note: &str, seamux: &str, dir: &Path) -> String {
    let q = crate::native::sh_quote(seamux);
    let when = if slot.is_empty() { String::new() } else { format!(", {slot}") };
    let mut out = format!("[Report {} run {run}{when}]\n{}. The supervisor checked its sources at {checked_at}.\n", r.id, r.title);
    if !note.is_empty() {
        out.push_str(&format!("{note}\n"));
    }
    out.push('\n');
    for (i, c) in sections.iter().enumerate() {
        let via = c.section.via.iter().map(Via::text).collect::<Vec<_>>().join(", ");
        out.push_str(&format!("{}. {}{}\n", i + 1, c.section.title, if via.is_empty() { String::new() } else { format!(" ({via})") }));
        if c.runnable() {
            out.push_str(&format!("   Ask: {}\n", c.section.ask));
            for (v, res) in &c.via {
                if let Err(why) = res {
                    out.push_str(&format!("   {} is down ({why}): don't use it, and say so in this section's line.\n", v.text()));
                }
            }
        } else {
            out.push_str(&format!("   Not checked: {}. Don't try its sources; keep this line word for word as the section's line, status \"unchecked\".\n", c.why()));
        }
    }
    out.push_str(&format!("\n{NEEDS_RULE}\n\n"));
    match doc {
        Doc::Off => out.push_str("Doc: this report has no doc.\n"),
        Doc::Down(why) => out.push_str(&format!("Doc: not updated this run, because {why}. Put that as the results' docWhy.\n")),
        Doc::New => out.push_str(&format!("Doc: none yet. Make one named \"{}\" with the Claude Docs connector, then add this run's section to it.\n", r.title)),
        Doc::At(url) => out.push_str(&format!("Doc: {url}. Add this run's section at the top, above the last run's.\n")),
    }
    let draft = dir.join("drafts").join(format!("{run}.json")).to_string_lossy().into_owned();
    out.push_str(&format!(
        "\nLoad the bosun skill and run it by its report reference (references/report.md), which says what the results need: `report done` refuses a file without them. Then write the results to {draft} and send them with `{q} bosun report done {run} < {}`.",
        crate::native::sh_quote(&draft)
    ));
    out
}

fn hhmm_now(now_secs: i64) -> String {
    let m = loops::local(now_secs).minute;
    format!("{:02}:{:02}", m / 60, m % 60)
}

/// Build the prompt for a report item about to be typed, from what `found`
/// says now: the item with its whole text, written back into the queue and
/// the run file. An item already built comes back as it is.
pub fn prepare_with(dir: &Path, item: &queue::Item, found: &Found, now_secs: i64, seamux: &str) -> Result<queue::Item, String> {
    let id = item.source.strip_prefix("report:").ok_or("not a report item")?;
    let run_v = read_run(dir, &item.id).unwrap_or_else(|| json!({"run": item.id, "report": id, "slot": "", "queuedAt": now_secs}));
    if run_v["built"] == true {
        return Ok(item.clone());
    }
    let r = load(dir).into_iter().filter_map(Result::ok).find(|r| r.id == id).ok_or(format!("report {id:?} is no longer in bosun.json"))?;
    let k = kept(&load_state(dir), id).unwrap_or_default();
    let sections = check_sections(&r, found);
    let doc = doc_for(&r, &k, found);
    let slot = run_v["slot"].as_str().unwrap_or("").to_string();
    let text = prompt_text(&r, &item.id, &slot, &hhmm_now(now_secs), &sections, &doc, &k.note, seamux, dir);
    let mut run_v = run_v;
    run_v["built"] = json!(true);
    run_v["builtAt"] = json!(now_secs);
    run_v["title"] = json!(r.title);
    run_v["sections"] = json!(sections
        .iter()
        .map(|c| json!({
            "title": c.section.title, "ask": c.section.ask, "runnable": c.runnable(), "why": c.why(),
            "via": c.via.iter().map(|(v, res)| json!({"via": v.text(), "ok": res.is_ok(), "why": res.as_ref().err()})).collect::<Vec<_>>(),
        }))
        .collect::<Vec<_>>());
    run_v["doc"] = match &doc {
        Doc::Off => json!({"to": false}),
        Doc::Down(why) => json!({"to": true, "ok": false, "why": why}),
        Doc::New => json!({"to": true, "ok": true, "url": ""}),
        Doc::At(u) => json!({"to": true, "ok": true, "url": u}),
    };
    run_v["banner"] = json!(r.banner);
    // The queue gets the prompt first: a stop between the two writes leaves
    // the run unbuilt, so the next try checks and builds it again, rather
    // than a built run whose queue item still holds the placeholder.
    let built = queue::rewrite_text(item, &text)?;
    write_run(dir, &item.id, &run_v)?;
    // The note is said once.
    if !k.note.is_empty() {
        if let Err(e) = update_state(dir, id, |k| k.note.clear()) {
            super::supervise::warn(&format!("reports-note-{id}"), &format!("bosun reports: could not clear {id}'s note: {e}"));
        }
    }
    Ok(built)
}

/// `prepare_with` on this machine: `claude mcp list` in `root`, and PATH.
pub fn prepare(dir: &Path, item: &queue::Item, root: &Path) -> Result<queue::Item, String> {
    if read_run(dir, &item.id).is_some_and(|v| v["built"] == true) {
        return Ok(item.clone());
    }
    prepare_with(dir, item, &Found::look(root, &super::launch::launched_domains(dir)), super::launch::now_secs(), &super::launch::seamux_bin())
}

// ---- results and the banner ----

/// A section's status, as the rail and the doc show it.
const STATUSES: &[&str] = &["ok", "needs", "unchecked"];
/// How long a run's file is kept.
const RUN_KEEP_SECS: i64 = 14 * 24 * 3600;

fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max { flat } else { flat.chars().take(max - 1).collect::<String>().trim_end().to_string() + "…" }
}

/// The most a section's detail keeps, in characters.
const DETAIL_MAX: usize = 6000;

/// A section's detail: markdown kept line for line (newlines matter to
/// lists and tables), trimmed, and cut at DETAIL_MAX with a note that it was.
fn detail_of(s: &str) -> String {
    let t = s.replace("\r\n", "\n").trim().to_string();
    if t.chars().count() <= DETAIL_MAX {
        return t;
    }
    t.chars().take(DETAIL_MAX).collect::<String>().trim_end().to_string() + "\n\n(cut here: the rest is in the doc)"
}

/// `report done <run>`: the Bosun's results for a run it was typed, logged
/// as one answer-log entry with a `report` field (the rail's report card),
/// the doc link kept for the next run, and the run marked done for the
/// supervisor's banner pass. A section the supervisor found down stays
/// "Not checked: <why>" whatever the results say. The entry as logged.
pub fn done(dir: &Path, run: &str, v: &Value, now_secs: i64) -> Result<Value, String> {
    // One `report done` at a time (reports.lock is update_state's, so not that one).
    let _lock = crate::status::lock_file(dir, "report-done.lock");
    let mut rv = read_run(dir, run).ok_or(format!("no run {run:?} (seamux bosun report list names each report's last run)"))?;
    if rv["built"] != true {
        return Err(format!("run {run} was never typed into the Bosun"));
    }
    if rv["done"] == true {
        return Err(format!("run {run} is already done"));
    }
    let id = rv["report"].as_str().unwrap_or("").to_string();
    let title = rv["title"].as_str().unwrap_or("").to_string();
    let sent = v.get("sections").and_then(Value::as_array).ok_or("the results need a sections list")?;
    // The fields the report reference asks for are required: a file written
    // without the reference (the skill not loaded) is refused, saying what
    // is missing, rather than logged half-filled.
    let answer = text(v, "answer");
    if answer.trim().is_empty() {
        return Err("no answer: the results need an answer, the run for a person (a line per section), as the bosun skill's report reference says".into());
    }
    let mut sections = Vec::new();
    let mut sources = Vec::new();
    for p in rv["sections"].as_array().cloned().unwrap_or_default() {
        let t = p["title"].as_str().unwrap_or("").to_string();
        if p["runnable"] == false {
            let why = p["why"].as_str().unwrap_or("").to_string();
            sections.push(json!({"title": t, "status": "unchecked", "line": format!("Not checked: {why}"), "why": why}));
            continue;
        }
        let s = sent.iter().find(|s| text(s, "title").eq_ignore_ascii_case(&t)).ok_or(format!("no result for the section {t:?}"))?;
        let status = text(s, "status");
        if !STATUSES.contains(&status.as_str()) {
            return Err(format!("{t}: status {status:?}: use ok, needs or unchecked"));
        }
        let line = one_line(&text(s, "line"), 200);
        if line.is_empty() {
            return Err(format!("{t}: no line"));
        }
        let why = one_line(&text(s, "why"), 200);
        let mut sec = json!({"title": t, "status": status, "line": line});
        if status == "unchecked" {
            sec["why"] = json!(if why.is_empty() { line.clone() } else { why });
        }
        // The section in full, as markdown (lists, tables, links), shown when
        // its card is opened. A line cut to fit stands in for one not sent.
        let full = text(s, "line").split_whitespace().collect::<Vec<_>>().join(" ");
        let detail = detail_of(&text(s, "detail"));
        if !detail.is_empty() {
            sec["detail"] = json!(detail);
        } else if full != line {
            sec["detail"] = json!(full);
        }
        let srcs = s.get("sources").and_then(Value::as_array).cloned().unwrap_or_default();
        if status != "unchecked" && srcs.is_empty() {
            return Err(format!("{t}: no sources: a checked section names where its line comes from, as {{\"kind\", \"ref\", \"label\"}}"));
        }
        for src in &srcs {
            let f = |k: &str| src.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
            if f("kind").is_empty() || f("ref").is_empty() {
                return Err(format!("{t}: a source without a kind or a ref ({src}): each is {{\"kind\", \"ref\", \"label\"}}"));
            }
            sources.push(json!({"kind": f("kind"), "ref": f("ref"), "label": f("label")}));
        }
        sections.push(sec);
    }
    let doc = text(v, "doc");
    if !doc.is_empty() && !doc.starts_with("https://") {
        return Err(format!("doc {doc:?}: send the doc's https link"));
    }
    let mut doc_why = one_line(&text(v, "docWhy"), 200);
    if rv["doc"]["to"] == true && doc.is_empty() && doc_why.is_empty() {
        match rv["doc"]["why"].as_str() {
            Some(why) => doc_why = why.to_string(),
            None => return Err("no doc and no docWhy: send the doc's https link, or docWhy saying why the doc was not updated".into()),
        }
    }
    if !doc.is_empty() {
        sources.push(json!({"kind": "doc", "ref": doc, "label": format!("{title} doc")}));
    }
    let mut report = json!({"id": id, "run": run, "title": title, "sections": sections});
    if !doc.is_empty() {
        report["doc"] = json!(doc);
    }
    if !doc_why.is_empty() {
        report["docWhy"] = json!(doc_why);
    }
    let entry = json!({"id": run, "question": title, "answer": answer, "sources": sources, "asker": format!("report:{id}"), "report": report});
    // A done that logged and then failed later is tried again without a
    // second entry: the log already holds this run's report (today's, or
    // yesterday's for a retry past midnight). log::add files an entry under
    // the real day, whatever `now_secs` says. An entry with the run's id but
    // no report (a stray log add) does not count: the card needs the report.
    let today = super::launch::local_day_hour(super::launch::now_secs()).0;
    let yesterday = super::launch::local_day_hour(super::launch::now_secs() - 86_400).0;
    let had = [today, yesterday]
        .iter()
        .flat_map(|d| super::log::list(dir, d).unwrap_or_default())
        .find(|e| e["id"] == run && e["report"]["run"] == run);
    let logged = match had {
        Some(e) => e,
        None => super::log::add_as(dir, &entry, true)?,
    };
    if !doc.is_empty() {
        update_state(dir, &id, |k| k.doc = doc.clone())?;
    }
    let needs: Vec<String> = sections
        .iter()
        .filter(|s| s["status"] == "needs")
        .map(|s| format!("{}: {}", s["title"].as_str().unwrap_or(""), s["line"].as_str().unwrap_or("")))
        .collect();
    // The run file shows what was found, beside what the supervisor checked.
    if let Some(ps) = rv["sections"].as_array_mut() {
        for p in ps.iter_mut() {
            let t = p["title"].as_str().unwrap_or("").to_string();
            if let Some(sec) = sections.iter().find(|s| s["title"] == t.as_str()) {
                p["status"] = sec["status"].clone();
                p["line"] = sec["line"].clone();
            }
        }
    }
    if !doc.is_empty() {
        rv["doc"]["url"] = json!(doc);
    }
    if !doc_why.is_empty() {
        rv["doc"]["docWhy"] = json!(doc_why);
    }
    rv["done"] = json!(true);
    rv["doneAt"] = json!(now_secs);
    rv["needs"] = json!(needs);
    rv["bannered"] = json!(false);
    write_run(dir, run, &rv)?;
    Ok(logged)
}

/// The banner one finished run posts, when it posts one: (title, body).
pub fn banner_of(rv: &Value) -> Option<(String, String)> {
    let needs: Vec<&str> = rv["needs"].as_array()?.iter().filter_map(Value::as_str).collect();
    let first = needs.first()?;
    if rv["banner"] == false {
        return None;
    }
    let more = if needs.len() > 1 { format!(" · {} more", needs.len() - 1) } else { String::new() };
    Some((format!("Bosun · {}", rv["title"].as_str().unwrap_or("a report")), format!("{first}{more}")))
}

/// The supervisor's pass, once per poll: each run that is done and not yet
/// bannered posts its banner (a note file in `notes`, ADR 0087) if it found
/// something for the person, and is marked so it never posts twice. Runs
/// older than two weeks are deleted. The runs bannered.
pub fn banner_pass(dir: &Path, notes: &Path, now_secs: i64) -> Vec<String> {
    let mut posted = Vec::new();
    for e in fs::read_dir(runs_dir(dir)).into_iter().flatten().flatten() {
        let path = e.path();
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Some(mut rv) = loops::read_json(&path) else { continue };
        let run = rv["run"].as_str().unwrap_or("").to_string();
        if now_secs - rv["queuedAt"].as_i64().unwrap_or(now_secs) > RUN_KEEP_SECS {
            let _ = fs::remove_file(&path);
            continue;
        }
        if rv["done"] != true || rv["bannered"] != false || !queue::valid_id(&run) {
            continue;
        }
        // Marked first: a run that can't be marked posts nothing, rather
        // than the same banner on every poll.
        rv["bannered"] = json!(true);
        if let Err(e) = write_run(dir, &run, &rv) {
            super::supervise::warn(&format!("reports-banner-{run}"), &format!("bosun reports: could not mark run {run} bannered, so it posts no banner: {e}"));
            continue;
        }
        if let Some((title, body)) = banner_of(&rv) {
            if crate::notifications::write_note_with(notes, "bosun", &title, &body, "", "", &json!({"entry": run})) {
                posted.push(run.clone());
            } else {
                super::supervise::warn(&format!("reports-note-{run}"), &format!("bosun reports: could not write run {run}'s banner to {}; its card is on the rail", notes.display()));
            }
        }
    }
    posted
}

// ---- starters ----

/// The sections a starter report gets for each server it finds: (server
/// word, title, ask).
const KNOWN: &[(&str, &str, &str)] = &[
    ("datadog", "Monitors", "List the Datadog monitors that are alerting or warning, and what changed since the last run. Name each monitor."),
    ("splunk", "Errors", "Look for error spikes in Splunk over the last 24 hours. Name the search behind each point."),
    ("atlassian", "Tickets", "List my open Jira tickets that changed since the last run, and any that are blocked."),
    ("linear", "Issues", "List my open Linear issues that changed since the last run, and any that are blocked."),
    ("sentry", "Sentry", "List new or regressed Sentry issues from the last 24 hours."),
    ("pagerduty", "Incidents", "List open PagerDuty incidents and who is on call."),
    ("slack", "Slack", "List messages that mention me or are sent to me and have waited over a day without a reply."),
];

/// The morning report's look at open workspaces: `context radar` already
/// leaves out the Bosun and tucked or snoozed worktrees, and archived ones
/// are closed, so what it lists is what is open.
const WORKSPACES_ASK: &str = "Summarize where each open workspace stands, from `seamux bosun context radar --json` (it leaves out the Bosun and tucked or snoozed workspaces; archived ones are closed): one line per workspace with its repo, branch and what it is doing, grouped by repo, and say which ones wait on me.";

const PRS_ASK: &str = "List the open pull requests waiting on my review or assigned to me (gh search prs --state=open --review-requested=@me, and --assignee=@me), oldest first, with each one's repo, age and check status.";

/// The starter reports for the servers `found` lists.
pub fn starters(found: &Found) -> Value {
    let prs = json!({"title": "Pull requests", "via": ["cmd:gh"], "ask": PRS_ASK});
    let mut morning = vec![prs.clone(), json!({"title": "Workspaces", "via": ["cmd:seamux"], "ask": WORKSPACES_ASK})];
    for (word, title, ask) in KNOWN {
        if found.has(word) {
            morning.push(json!({"title": title, "via": [format!("mcp:{word}")], "ask": ask}));
        }
    }
    json!([
        {"id": "morning", "title": "Morning report", "at": ["09:00"], "days": "weekdays", "sections": morning, "to": ["doc", "banner"], "enabled": true},
        {"id": "afternoon", "title": "Afternoon PRs", "at": ["14:00"], "days": "weekdays", "sections": [prs], "to": ["doc", "banner"], "enabled": true},
    ])
}

/// Whether bosun.json can be read (or is not there yet) and has no `reports` key.
pub fn needs_seed(dir: &Path) -> bool {
    match fs::read_to_string(bosun_json(dir)) {
        Ok(t) => matches!(serde_json::from_str::<Value>(&t), Ok(Value::Object(m)) if !m.contains_key("reports")),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Write the starter reports into bosun.json, turning off the starter loops
/// still as shipped. Ok(false) when it already has a `reports` key.
pub fn seed(dir: &Path, found: &Found) -> Result<bool, String> {
    let path = bosun_json(dir);
    let mut cfg = match fs::read_to_string(&path) {
        Ok(t) => match serde_json::from_str::<Value>(&t) {
            Ok(Value::Object(m)) => m,
            _ => return Err("bosun.json is not a JSON object; left alone".into()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => return Err(e.to_string()),
    };
    if cfg.contains_key("reports") {
        return Ok(false);
    }
    // Starters built from a listing that failed would leave out every
    // server for good: wait for one that reads.
    if let Err(e) = &found.servers {
        return Err(format!("the servers could not be listed ({e})"));
    }
    cfg.insert("reports".into(), starters(found));
    let off = loops::turn_off_untouched_starters(&mut cfg);
    loops::write_json(&path, &Value::Object(cfg))?;
    if !off.is_empty() {
        let note = format!("Say once, at the top of this run: the starter loops {} were turned off, since this report covers them.", off.join(", "));
        update_state(dir, "morning", |k| k.note = note)?;
    }
    Ok(true)
}

// ---- list, check and the CLI ----

/// Each report, its schedule and its next run, for `report list`.
pub fn list(dir: &Path, now_secs: i64) -> Vec<Value> {
    let state = load_state(dir);
    load(dir)
        .into_iter()
        .map(|r| match r {
            Ok(r) => {
                let k = kept(&state, &r.id);
                let next = loops::next_run(&r.when, k.as_ref().map(|k| &k.last), now_secs);
                json!({
                    "id": r.id, "title": r.title, "schedule": loops::sched_text(&r.when), "enabled": r.when.enabled,
                    "next": next, "nextText": next.map(|n| loops::when_text(n, now_secs)).unwrap_or_else(|| "never".into()),
                    "last": k.as_ref().map(|k| k.last.last).filter(|x| *x > 0),
                    "lastRun": k.as_ref().map(|k| k.last.queued.clone()).unwrap_or_default(),
                    "doc": k.map(|k| k.doc).unwrap_or_default(),
                    "sections": r.sections.iter().map(|s| json!({"title": s.title, "via": s.via.iter().map(Via::text).collect::<Vec<_>>(), "hosts": s.hosts})).collect::<Vec<_>>(),
                })
            }
            Err(e) => json!({"error": e}),
        })
        .collect()
}

/// What each report's sources say now, for `report check`.
pub fn check(dir: &Path, found: &Found, only: Option<&str>) -> Vec<Value> {
    let state = load_state(dir);
    load(dir)
        .into_iter()
        .filter(|r| only.is_none_or(|id| r.as_ref().is_ok_and(|r| r.id == id)))
        .map(|r| match r {
            Ok(r) => {
                let k = kept(&state, &r.id).unwrap_or_default();
                let doc = match doc_for(&r, &k, found) {
                    Doc::Off => json!({"to": false}),
                    Doc::Down(why) => json!({"to": true, "ok": false, "why": why}),
                    Doc::New | Doc::At(_) => json!({"to": true, "ok": true}),
                };
                json!({
                    "id": r.id, "title": r.title, "doc": doc,
                    "sections": check_sections(&r, found).iter().map(|c| json!({
                        "title": c.section.title, "runnable": c.runnable(),
                        "via": c.via.iter().map(|(v, res)| json!({"via": v.text(), "ok": res.is_ok(), "why": res.as_ref().err()})).collect::<Vec<_>>(),
                    })).collect::<Vec<_>>(),
                })
            }
            Err(e) => json!({"error": e}),
        })
        .collect()
}

/// What the Bosun's reports still need, for crew doctor: (level, message)
/// lines, the level ok, warn or note. A section that can't be checked yet
/// and why, a report bosun.json can't run, a doc-bound report whose
/// connector is down, and a set-up MCP server no section uses. Reads only.
pub fn doctor_lines(dir: &Path, found: &Found) -> Vec<(String, String)> {
    // One line each: a title with a newline or tab would split crew's read.
    let line = |l: &str, m: String| (l.to_string(), m.replace(['\n', '\r', '\t'], " "));
    // A section's mcp: word names a server as Server::named reads it: whole,
    // by the part after its last ':', or after "claude.ai ".
    let names = |w: &str, word: &str| {
        let w = w.to_ascii_lowercase();
        w == word || w.rsplit(':').next() == Some(word) || w.strip_prefix("claude.ai ") == Some(word)
    };
    if needs_seed(dir) {
        return vec![line("note", "no Bosun reports yet: the supervisor writes the starters on its first run".into())];
    }
    let reports = load(dir);
    if reports.is_empty() {
        return vec![line("note", "no Bosun reports: bosun.json's reports list is empty".into())];
    }
    let mut out = Vec::new();
    let sandboxed = found.sandboxed();
    if sandboxed {
        out.push(line("note", format!("Bosun reports: MCP sources and the Claude Doc were not checked: {}", super::sources::SANDBOXED)));
    } else if let Err(e) = &found.servers {
        out.push(line("warn", format!("Bosun reports: could not read claude mcp list ({e}), so no mcp: source could be checked")));
    }
    let state = load_state(dir);
    let mut used: Vec<String> = Vec::new();
    let mut running = 0;
    for r in &reports {
        let r = match r {
            Ok(r) => r,
            Err(e) => {
                out.push(line("warn", format!("bosun.json's reports: {e}")));
                continue;
            }
        };
        used.extend(r.sections.iter().flat_map(|s| s.via.iter()).filter_map(|v| match v {
            Via::Mcp(w) => Some(w.to_ascii_lowercase()),
            Via::Cmd(_) => None,
        }));
        if !r.when.enabled {
            continue;
        }
        running += 1;
        for c in check_sections(r, found).iter().filter(|c| !c.runnable()) {
            // From inside the sandbox, a section is down only by its cmd: sources.
            if sandboxed && c.via.iter().any(|(v, _)| matches!(v, Via::Mcp(_))) {
                continue;
            }
            out.push(line("warn", format!("Bosun report {} · {}: not checkable yet: {}", r.id, c.section.title, c.why())));
        }
        if sandboxed {
            continue;
        }
        if let Doc::Down(why) = doc_for(r, &kept(&state, &r.id).unwrap_or_default(), found) {
            out.push(line("warn", format!("Bosun report {}: its Claude Doc can't be updated: {why}", r.id)));
        }
    }
    if running == 0 {
        out.push(line("note", "every Bosun report is turned off (enabled: false), so none was checked".into()));
    } else if !sandboxed && !out.iter().any(|(l, _)| l == "warn") {
        out.insert(0, line("ok", format!("Bosun reports: every section's sources work ({running} report{})", if running == 1 { "" } else { "s" })));
    }
    for (word, _, _) in KNOWN {
        if found.has(word) && !used.iter().any(|u| names(u, word)) {
            out.push(line("note", format!("{word} is set up but no report section uses it: add one to bosun.json's reports")));
        }
    }
    out
}

/// Claude Code's own folder: CLAUDE_CONFIG_DIR, else ~/.claude.
fn claude_home() -> PathBuf {
    crate::py::env_or("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| crate::py::home().join(".claude"))
}

/// A warn line when the bosun plugin is not installed, or is turned off, in
/// `claude_home`: the Bosun then has no bosun skill, never reads the report
/// reference, and sends results `report done` refuses.
pub fn skill_line(claude_home: &Path) -> Option<(String, String)> {
    let read = |f: &str| fs::read_to_string(claude_home.join(f)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    let installed = read("plugins/installed_plugins.json");
    let ids: Vec<String> = installed["plugins"].as_object().map(|m| m.keys().filter(|k| k.starts_with("bosun@")).cloned().collect()).unwrap_or_default();
    let fix = "install it from the seamux checkout you keep (./install.sh, or /plugin install bosun@seamux), then restart the Bosun";
    let Some(id) = ids.first() else {
        return Some(("warn".into(), format!("the bosun plugin is not installed, so the Bosun runs reports without its skill and their results come back off format: {fix}")));
    };
    if read("settings.json")["enabledPlugins"][id.as_str()] == false {
        return Some(("warn".into(), format!("the bosun plugin ({id}) is turned off, so the Bosun runs reports without its skill: turn it on with /plugin, then restart the Bosun")));
    }
    None
}

fn print_errors_or(rows: &[Value], empty: &str, each: impl Fn(&Value)) {
    if rows.is_empty() {
        println!("{empty}");
    }
    for r in rows {
        match r.get("error").and_then(Value::as_str) {
            Some(e) => println!("  !  {e}"),
            None => each(r),
        }
    }
}

const USAGE: &str = "usage: seamux bosun report [list] [--json] | report run <id> [--json] | report check [<id>] [--json] | report doctor | report done <run> (results on stdin)";

/// `seamux bosun report …`.
pub fn main(args: &[String], dir: &Path) -> i32 {
    let json_out = args.iter().any(|a| a == "--json");
    let words: Vec<&str> = args.iter().map(String::as_str).filter(|a| !a.starts_with("--")).collect();
    let now = super::launch::now_secs();
    match words.as_slice() {
        [] | ["list"] => {
            let rows = list(dir, now);
            if json_out {
                println!("{}", json!({"reports": rows}));
            } else {
                let empty = if needs_seed(dir) { "no reports yet: the Bosun's supervisor writes the starters when it next starts" } else { "no reports (bosun.json's reports list is empty)" };
                print_errors_or(&rows, empty, |r| {
                    println!(
                        "  {:<12} {:<28} next {}{}",
                        r["id"].as_str().unwrap_or(""),
                        r["schedule"].as_str().unwrap_or(""),
                        r["nextText"].as_str().unwrap_or(""),
                        if r["enabled"] == false { " (off)" } else { "" }
                    );
                    for s in r["sections"].as_array().into_iter().flatten() {
                        let via = s["via"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                        println!("      {:<24} {via}", s["title"].as_str().unwrap_or(""));
                    }
                });
            }
            0
        }
        ["run", id] => match run_now(dir, id, now) {
            Ok(run) => {
                println!("{}", if json_out { json!({"run": run}).to_string() } else { format!("queued report {id} as run {run}") });
                0
            }
            Err(e) => {
                eprintln!("bosun report run: {e}");
                1
            }
        },
        ["done", run] => {
            let mut s = String::new();
            let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s);
            let v: Value = match serde_json::from_str(&s) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("bosun report done: stdin is not one JSON object: {e}");
                    return 1;
                }
            };
            match done(dir, run, &v, now) {
                Ok(e) => {
                    println!("{}", if json_out { e.to_string() } else { format!("logged run {run}") });
                    0
                }
                Err(e) => {
                    eprintln!("bosun report done: {e}");
                    1
                }
            }
        }
        ["doctor"] => {
            // crew doctor reads these lines, as it reads pricing --doctor's.
            let cfg = super::config::Config::load_from(dir);
            let found = if needs_seed(dir) { Found { servers: Ok(Vec::new()), path: String::new(), domains: Vec::new() } } else { Found::look(&cfg.root, &super::launch::launched_domains(dir)) };
            for (level, msg) in skill_line(&claude_home()).into_iter().chain(doctor_lines(dir, &found)) {
                println!("{level}\t{msg}");
            }
            0
        }
        ["check", rest @ ..] if rest.len() <= 1 => {
            let cfg = super::config::Config::load_from(dir);
            let found = Found::look(&cfg.root, &super::launch::launched_domains(dir));
            // From a person's shell, a store with no reports gets its starters
            // here too; inside the Bosun's sandbox the write is refused.
            if needs_seed(dir) {
                if let Err(e) = seed(dir, &found) {
                    eprintln!("bosun report check: could not write the starter reports: {e}");
                }
            }
            let rows = check(dir, &found, rest.first().copied());
            if json_out {
                println!("{}", json!({"reports": rows, "mcpList": found.servers.as_ref().err()}));
            } else {
                if let Err(e) = &found.servers {
                    println!("claude mcp list: {e}");
                }
                print_errors_or(&rows, "no reports to check", |r| {
                    println!("  {}  {}", r["id"].as_str().unwrap_or(""), r["title"].as_str().unwrap_or(""));
                    for s in r["sections"].as_array().into_iter().flatten() {
                        let vias: Vec<String> = s["via"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|v| match v["why"].as_str() {
                                Some(why) => format!("{}: {why}", v["via"].as_str().unwrap_or("")),
                                None => format!("{}: ok", v["via"].as_str().unwrap_or("")),
                            })
                            .collect();
                        let mark = if s["runnable"] == true { "ok  " } else { "down" };
                        println!("    {mark} {:<22} {}", s["title"].as_str().unwrap_or(""), if vias.is_empty() { "(no sources named)".to_string() } else { vias.join("; ") });
                    }
                    match (&r["doc"]["to"], r["doc"]["why"].as_str()) {
                        (Value::Bool(false), _) => println!("    doc  (none: to leaves it out)"),
                        (_, Some(why)) => println!("    doc  down: {why}"),
                        _ => println!("    doc  ok"),
                    }
                });
            }
            0
        }
        _ => {
            eprintln!("{USAGE}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bosun::sources::{parse_mcp_list, Found};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bosun-reports-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn at(day: &str, wday: usize, h: u32, m: u32) -> Local {
        Local { day: day.into(), wday, minute: h * 60 + m }
    }

    fn found() -> Found {
        let listed = "claude.ai Claude Docs: https://x - \u{2714} Connected\n\
plugin:engineering:datadog: https://x (HTTP) - ! Needs authentication\n\
plugin:engineering:atlassian: https://x (HTTP) - \u{2714} Connected\n\
plugin:engineering:google calendar:  (HTTP) - - Not configured\n";
        Found { servers: Ok(parse_mcp_list(listed)), path: String::new(), domains: vec![] }
    }

    fn morning() -> Value {
        json!({"id": "morning", "at": ["09:00"], "days": "weekdays", "sections": [
            {"title": "Pull requests", "via": ["cmd:gh"], "ask": "PRs waiting on me"},
            {"title": "Monitors", "via": ["mcp:datadog"], "ask": "alerting monitors"},
            {"title": "Tickets", "via": ["mcp:atlassian", "mcp:linear"], "ask": "my tickets"},
            {"title": "Notes", "ask": "anything in my notes folder"},
        ]})
    }

    #[test]
    fn a_report_parses_and_bad_ones_say_why() {
        let r = parse(&morning()).unwrap();
        assert_eq!(r.title, "Morning report");
        assert_eq!(r.sections.len(), 4);
        assert_eq!(r.sections[0].via, vec![Via::Cmd("gh".into())]);
        assert!(r.sections[3].via.is_empty());
        assert!(r.doc && r.banner, "to defaults to both");
        assert_eq!(r.when.sched, loops::Sched::At(vec![540]));
        let only_banner = parse(&json!({"id": "a", "every": "1h", "to": ["banner"], "sections": [{"title": "t", "ask": "a"}]})).unwrap();
        assert!(!only_banner.doc && only_banner.banner);
        for bad in [
            json!({"id": "x", "at": "09:00"}),
            json!({"id": "x", "at": "09:00", "sections": []}),
            json!({"id": "x", "at": "09:00", "sections": [{"title": "t"}]}),
            json!({"id": "x", "at": "09:00", "sections": [{"title": "t", "ask": "a", "via": ["http:x"]}]}),
            json!({"id": "x", "at": "09:00", "sections": [{"title": "t", "ask": "a", "via": "cmd:gh"}]}),
            json!({"id": "x", "at": "09:00", "to": ["email"], "sections": [{"title": "t", "ask": "a"}]}),
            json!({"id": "x", "sections": [{"title": "t", "ask": "a"}]}),
            json!({"id": "../x", "at": "09:00", "sections": [{"title": "t", "ask": "a"}]}),
            json!({"id": "x", "at": "09:00", "sections": [{"title": "PRs", "ask": "a"}, {"title": "prs", "ask": "b"}]}),
        ] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_due_report_queues_a_placeholder_once_while_it_waits() {
        let d = tmp("tick");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [morning()]})).unwrap();
        let mon = |h, m| at("2026-11-23", 1, h, m);
        assert!(tick_at(&d, 100, &mon(8, 59)).is_empty(), "first seen: counting starts");
        assert_eq!(tick_at(&d, 160, &mon(9, 0)), ["morning"]);
        let w = queue::waiting(&d);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].source, "report:morning");
        assert_eq!(w[0].text, placeholder("morning", &w[0].id));
        let run = read_run(&d, &w[0].id).unwrap();
        assert_eq!((run["report"].as_str(), run["slot"].as_str(), run["built"].as_bool()), (Some("morning"), Some("2026-11-23 09:00"), Some(false)));
        assert!(tick_at(&d, 220, &mon(9, 1)).is_empty());
        assert!(tick_at(&d, 90_000, &at("2026-11-24", 2, 9, 0)).is_empty(), "not queued twice while one waits");
        assert_eq!(queue::waiting(&d).len(), 1);
        // A loop and a report may share an id: their state is apart.
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [morning()], "loops": [{"id": "morning", "every": "1h", "prompt": "p"}]})).unwrap();
        loops::tick_at(&d, 300, &mon(9, 5), "/bin/seamux");
        assert_eq!(kept(&load_state(&d), "morning").unwrap().last.queued, w[0].id);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn report_doctor_says_what_the_reports_still_need() {
        let d = tmp("doctor");
        let lines = doctor_lines(&d, &found());
        assert_eq!(lines, vec![("note".to_string(), "no Bosun reports yet: the supervisor writes the starters on its first run".to_string())]);
        use std::os::unix::fs::PermissionsExt;
        fs::write(d.join("gh"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(d.join("gh"), fs::Permissions::from_mode(0o755)).unwrap();
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [
            {"id": "morning", "at": ["09:00"], "to": [], "sections": [
                {"title": "Pull requests", "via": ["cmd:gh"], "ask": "PRs"},
                {"title": "Monitors", "via": ["mcp:datadog"], "ask": "alerts"}]},
            {"id": "quiet", "at": ["09:00"], "enabled": false, "sections": [{"title": "Off", "via": ["cmd:nope"], "ask": "a"}]},
            {"id": "bad"}]})).unwrap();
        let f = Found { path: d.to_string_lossy().into_owned(), ..found() };
        let lines = doctor_lines(&d, &f);
        let has = |lvl: &str, text: &str| lines.iter().any(|(l, m)| l == lvl && m.contains(text));
        assert!(has("warn", "morning · Pull requests: not checkable yet: api.github.com is not in sandbox.allowedDomains"), "{lines:?}");
        assert!(has("warn", "morning · Monitors: not checkable yet: datadog needs authentication"), "{lines:?}");
        assert!(has("warn", "bosun.json's reports: bad:"), "a report that can't run is named: {lines:?}");
        assert!(has("note", "atlassian is set up but no report section uses it"), "{lines:?}");
        assert!(!lines.iter().any(|(_, m)| m.contains("quiet")), "a report turned off is not checked: {lines:?}");
        assert!(!lines.iter().any(|(l, _)| l == "ok"), "{lines:?}");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [{"id": "m", "at": ["09:00"], "to": [], "sections": [
            {"title": "Tickets", "via": ["mcp:atlassian"], "ask": "a"}, {"title": "Docs", "via": ["mcp:claude docs"], "ask": "b"}]}]})).unwrap();
        let lines = doctor_lines(&d, &found());
        assert!(lines.iter().any(|(l, m)| l == "ok" && m == "Bosun reports: every section's sources work (1 report)"), "{lines:?}");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [{"id": "m", "at": ["09:00"], "to": [], "enabled": false, "sections": [
            {"title": "Two\nlines", "via": ["mcp:plugin:engineering:atlassian", "mcp:claude.ai datadog"], "ask": "a"}]}]})).unwrap();
        let lines = doctor_lines(&d, &found());
        assert!(!lines.iter().any(|(l, _)| l == "ok"), "nothing ran, nothing is ok: {lines:?}");
        assert!(lines.iter().any(|(l, m)| l == "note" && m.contains("every Bosun report is turned off")), "{lines:?}");
        assert!(!lines.iter().any(|(_, m)| m.contains("atlassian is set up") || m.contains("datadog is set up")), "a full or claude.ai name counts as using it: {lines:?}");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [{"id": "m", "at": ["09:00"], "to": [], "sections": [
            {"title": "Two\nlines\there", "via": ["cmd:nope"], "ask": "a"}]}]})).unwrap();
        let lines = doctor_lines(&d, &found());
        assert!(lines.iter().any(|(l, m)| l == "warn" && m.contains("m · Two lines here: not checkable yet: nope is not on PATH")), "one line each: {lines:?}");
    }

    #[test]
    fn doctor_inside_the_sandbox_leaves_mcp_unchecked_instead_of_down() {
        let d = tmp("doctor-sbx");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [{"id": "m", "at": ["09:00"], "sections": [
            {"title": "Tickets", "via": ["mcp:atlassian"], "ask": "a"},
            {"title": "Pull requests", "via": ["cmd:gh"], "ask": "b"}]}]})).unwrap();
        let f = Found { servers: Err(super::super::sources::SANDBOXED.into()), ..found() };
        assert!(f.sandboxed());
        let lines = doctor_lines(&d, &f);
        let has = |lvl: &str, text: &str| lines.iter().any(|(l, m)| l == lvl && m.contains(text));
        assert!(has("note", "were not checked: this ran inside Claude Code's sandbox"), "{lines:?}");
        assert!(!lines.iter().any(|(_, m)| m.contains("Tickets") || m.contains("Claude Doc can't")), "an mcp: section is not called down: {lines:?}");
        assert!(has("warn", "Pull requests: not checkable yet"), "a cmd: source still is: {lines:?}");
        assert!(!lines.iter().any(|(l, _)| l == "ok"), "{lines:?}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn doctor_warns_when_the_bosun_plugin_is_missing_or_off() {
        let d = tmp("skill");
        assert!(skill_line(&d).unwrap().1.contains("not installed"));
        fs::create_dir_all(d.join("plugins")).unwrap();
        fs::write(d.join("plugins/installed_plugins.json"), r#"{"version": 2, "plugins": {"crew@seamux": [], "bosun@seamux": []}}"#).unwrap();
        assert_eq!(skill_line(&d), None);
        fs::write(d.join("settings.json"), r#"{"enabledPlugins": {"bosun@seamux": false}}"#).unwrap();
        assert!(skill_line(&d).unwrap().1.contains("turned off"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_sections_hosts_decide_its_cmd_sources() {
        let d = tmp("sec-hosts");
        use std::os::unix::fs::PermissionsExt;
        for c in ["gcloud", "gh"] {
            fs::write(d.join(c), "#!/bin/sh\n").unwrap();
            fs::set_permissions(d.join(c), fs::Permissions::from_mode(0o755)).unwrap();
        }
        let r = parse(&json!({"id": "infra", "at": ["09:00"], "sections": [
            {"title": "Deploys", "via": ["cmd:gcloud", "mcp:datadog"], "hosts": ["oauth2.googleapis.com", "run.googleapis.com"], "ask": "failed deploys"},
            {"title": "Offline", "via": ["cmd:gh"], "hosts": [], "ask": "local only"},
            {"title": "Plain", "via": ["cmd:gcloud"], "ask": "no hosts named"},
        ]}))
        .unwrap();
        let path = d.to_string_lossy().into_owned();
        let closed = check_sections(&r, &Found { path: path.clone(), ..found() });
        assert!(!closed[0].runnable(), "a section's hosts are checked for a CLI the table doesn't know");
        assert!(closed[0].why().contains("oauth2.googleapis.com and run.googleapis.com are not in sandbox.allowedDomains"), "{}", closed[0].why());
        assert!(closed[1].runnable(), "an empty list turns the host check off, even for gh");
        assert!(closed[2].runnable(), "no hosts key and no table entry: the PATH check alone");
        let open = check_sections(&r, &Found { path, domains: vec!["*.googleapis.com".into()], ..found() });
        assert!(open[0].runnable());
        for bad in [json!("run.googleapis.com"), json!(["https://run.googleapis.com"]), json!(["a b"]), json!([""]), json!([3]), json!(["*"]), json!(["*.googleapis.com"]), json!(["api.example.com:8443"]), json!([".."]), json!([":"])] {
            let v = json!({"id": "x", "at": ["09:00"], "sections": [{"title": "t", "via": ["cmd:gcloud"], "hosts": bad, "ask": "a"}]});
            assert!(parse(&v).is_err(), "{v}");
        }
    }

    #[test]
    fn a_starter_pr_section_names_the_host_the_sandbox_lacks() {
        let d = tmp("gh-host");
        use std::os::unix::fs::PermissionsExt;
        fs::write(d.join("gh"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(d.join("gh"), fs::Permissions::from_mode(0o755)).unwrap();
        let path = d.to_string_lossy().into_owned();
        let starters = starters(&found());
        let r = parse(&starters[1]).unwrap();
        let closed = Found { path: path.clone(), ..found() };
        let c = check_sections(&r, &closed);
        assert!(!c[0].runnable());
        assert_eq!(c[0].why(), "api.github.com is not in sandbox.allowedDomains (bosun.json, read when the Bosun starts)", "GitHub is opt-in, and the section says what to add");
        let open = Found { path, domains: vec!["api.github.com".into()], ..found() };
        assert!(check_sections(&r, &open)[0].runnable());
    }

    #[test]
    fn the_prompt_is_built_at_typing_with_down_sources_not_checked() {
        let d = tmp("prep");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [morning()]})).unwrap();
        let run = run_now(&d, "morning", 100).unwrap();
        let item = queue::waiting(&d).remove(0);
        assert_eq!(item.id, run);
        let built = prepare_with(&d, &item, &found(), 100, "/bin/seamux").unwrap();
        let t = &built.text;
        assert!(t.starts_with(&format!("[Report morning run {run}]\nMorning report.")), "{t}");
        assert!(t.contains("1. Pull requests (cmd:gh)\n   Not checked: gh is not on PATH."), "PATH is empty here: {t}");
        assert!(t.contains("2. Monitors (mcp:datadog)\n   Not checked: datadog needs authentication."), "{t}");
        assert!(t.contains("3. Tickets (mcp:atlassian, mcp:linear)\n   Ask: my tickets\n   mcp:linear is down (no MCP server named linear in claude mcp list)"), "{t}");
        assert!(t.contains("4. Notes\n   Ask: anything in my notes folder"), "{t}");
        assert!(t.contains("Doc: none yet. Make one named \"Morning report\""), "{t}");
        assert!(t.contains(&format!("/bin/seamux bosun report done {run} < {}", d.join("drafts").join(format!("{run}.json")).display())));
        assert!(t.contains("waits on the person"));
        // Written back: the queue item and the run file.
        assert_eq!(queue::waiting(&d)[0].text, *t);
        let rv = read_run(&d, &run).unwrap();
        assert_eq!(rv["built"], true);
        assert_eq!(rv["sections"][1]["why"], "datadog needs authentication");
        assert_eq!(rv["sections"][2]["runnable"], true);
        // Built once: a retry types the same text without a new check.
        let none = Found { servers: Err("gone".into()), path: String::new(), domains: vec![] };
        assert_eq!(prepare_with(&d, &built, &none, 200, "/bin/seamux").unwrap().text, *t);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_doc_line_follows_the_connector_and_the_kept_link() {
        let r = parse(&morning()).unwrap();
        let k = Kept { doc: "https://claude.ai/artifact/abc".into(), ..Default::default() };
        assert_eq!(doc_for(&r, &k, &found()), Doc::At("https://claude.ai/artifact/abc".into()));
        assert_eq!(doc_for(&r, &Kept::default(), &found()), Doc::New);
        let down = Found { servers: Ok(parse_mcp_list("claude.ai Claude Docs: https://x - ! Needs authentication\n")), path: String::new(), domains: vec![] };
        assert_eq!(doc_for(&r, &k, &down), Doc::Down("claude docs needs authentication".into()));
        let off = parse(&json!({"id": "a", "every": "1h", "to": ["banner"], "sections": [{"title": "t", "ask": "a"}]})).unwrap();
        assert_eq!(doc_for(&off, &k, &found()), Doc::Off);
    }

    #[test]
    fn a_report_gone_from_bosun_json_is_refused_at_typing() {
        let d = tmp("gone");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [morning()]})).unwrap();
        run_now(&d, "morning", 100).unwrap();
        loops::write_json(&d.join("bosun.json"), &json!({"reports": []})).unwrap();
        let item = queue::waiting(&d).remove(0);
        assert!(prepare_with(&d, &item, &found(), 100, "/bin/seamux").unwrap_err().contains("no longer in bosun.json"));
        assert!(run_now(&d, "morning", 100).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn starters_are_built_from_listed_servers_and_turn_off_untouched_loops() {
        let d = tmp("seed");
        let mut edited = loops::starters();
        edited[1]["at"] = json!(["10:00"]);
        loops::write_json(&d.join("bosun.json"), &json!({"resetHour": 6, "loops": edited})).unwrap();
        assert!(needs_seed(&d));
        assert_eq!(seed(&d, &found()), Ok(true));
        let v = loops::read_json(&d.join("bosun.json")).unwrap();
        assert_eq!(v["resetHour"], 6);
        let titles: Vec<&str> = v["reports"][0]["sections"].as_array().unwrap().iter().map(|s| s["title"].as_str().unwrap()).collect();
        assert_eq!(titles, ["Pull requests", "Workspaces", "Monitors", "Tickets"], "datadog needs a login but is listed; calendar is not configured");
        assert_eq!(v["reports"][0]["sections"][1]["via"], json!(["cmd:seamux"]));
        assert!(v["reports"][0]["sections"][1]["ask"].as_str().unwrap().contains("seamux bosun context radar --json"));
        assert_eq!(v["reports"][1]["id"], "afternoon");
        let on: Vec<bool> = v["loops"].as_array().unwrap().iter().map(|l| l["enabled"].as_bool().unwrap()).collect();
        assert_eq!(on, [false, true, false], "my-prs was edited, so it stays on");
        let note = kept(&load_state(&d), "morning").unwrap().note;
        assert!(note.contains("checkin, systems"), "{note}");
        assert!(load(&d).iter().all(Result::is_ok));
        assert_eq!(seed(&d, &found()), Ok(false), "once");
        assert!(!needs_seed(&d));
        // The note goes into the first run's prompt, then is cleared.
        let run = run_now(&d, "morning", 100).unwrap();
        let item = queue::waiting(&d).into_iter().find(|i| i.id == run).unwrap();
        assert!(prepare_with(&d, &item, &found(), 100, "/bin/seamux").unwrap().text.contains("starter loops checkin, systems were turned off"));
        assert!(kept(&load_state(&d), "morning").unwrap().note.is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fresh_store_gets_the_starter_loops_already_off_and_an_empty_list_stays() {
        let d = tmp("fresh");
        assert!(needs_seed(&d), "no bosun.json yet");
        seed(&d, &found()).unwrap();
        let v = loops::read_json(&d.join("bosun.json")).unwrap();
        assert!(v["loops"].as_array().unwrap().iter().all(|l| l["enabled"] == false));
        assert_eq!(loops::load(&d).len(), 3, "loops' own tick does not add them again");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": []})).unwrap();
        assert!(!needs_seed(&d), "an empty list is the person's");
        fs::write(d.join("bosun.json"), "{ not json").unwrap();
        assert!(!needs_seed(&d) && seed(&d, &found()).is_err(), "a broken bosun.json is left alone");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unreadable_bosun_json_keeps_every_reports_state() {
        let d = tmp("keep");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [morning()]})).unwrap();
        tick_at(&d, 100, &at("2026-11-23", 1, 8, 0));
        update_state(&d, "morning", |k| k.doc = "https://claude.ai/artifact/abc".into()).unwrap();
        fs::write(d.join("bosun.json"), "{ half written").unwrap();
        tick_at(&d, 200, &at("2026-11-23", 1, 8, 1));
        assert_eq!(kept(&load_state(&d), "morning").unwrap().doc, "https://claude.ai/artifact/abc");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": []})).unwrap();
        tick_at(&d, 300, &at("2026-11-23", 1, 8, 2));
        assert!(kept(&load_state(&d), "morning").is_none(), "a report taken out leaves the state");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn starters_wait_for_a_listing_that_reads() {
        let d = tmp("noseed");
        let failed = Found { servers: Err("claude mcp list did not finish in 60s".into()), path: String::new(), domains: vec![] };
        assert!(seed(&d, &failed).unwrap_err().contains("could not be listed"));
        assert!(needs_seed(&d), "tried again later");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_draft_path_is_quoted_for_the_shell() {
        let r = parse(&morning()).unwrap();
        let t = prompt_text(&r, "r1", "", "09:00", &[], &Doc::Off, "", "/bin/seamux", Path::new("/u/my folder/bosun"));
        assert!(t.contains("bosun report done r1 < '/u/my folder/bosun/drafts/r1.json'"), "{t}");
    }

    /// A run of morning() built against found(): gh off PATH, datadog down.
    fn built_run(d: &Path) -> String {
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [morning()]})).unwrap();
        let run = run_now(d, "morning", 100).unwrap();
        let item = queue::waiting(d).into_iter().find(|i| i.id == run).unwrap();
        prepare_with(d, &item, &found(), 100, "/bin/seamux").unwrap();
        run
    }

    #[test]
    fn done_logs_the_run_and_keeps_down_sections_not_checked() {
        let d = tmp("done");
        let run = built_run(&d);
        let results = json!({"doc": "https://claude.ai/artifact/abc", "answer": "- Tickets: PROJ-9 is blocked on you\n- Notes: nothing new", "sections": [
            {"title": "pull requests", "status": "ok", "line": "pretends to have checked"},
            {"title": "Monitors", "status": "ok", "line": "all quiet"},
            {"title": "Tickets", "status": "needs", "line": "PROJ-9 is blocked on you\nsince Monday", "sources": [{"kind": "ticket", "ref": "PROJ-9", "label": "PROJ-9"}]},
            {"title": "Notes", "status": "ok", "line": "nothing new", "sources": [{"kind": "file", "ref": "notes.md", "label": "notes"}]},
        ]});
        let e = done(&d, &run, &results, 200).unwrap();
        assert_eq!((e["id"].as_str(), e["asker"].as_str(), e["question"].as_str()), (Some(run.as_str()), Some("report:morning"), Some("Morning report")));
        let s = &e["report"]["sections"];
        assert_eq!(s[0]["line"], "Not checked: gh is not on PATH", "a down source can't be reported as checked");
        assert_eq!(s[1]["status"], "unchecked");
        assert_eq!(s[1]["line"], "Not checked: datadog needs authentication");
        assert_eq!((s[2]["status"].as_str(), s[2]["line"].as_str()), (Some("needs"), Some("PROJ-9 is blocked on you since Monday")));
        assert_eq!(e["report"]["doc"], "https://claude.ai/artifact/abc");
        assert!(e["sources"].as_array().unwrap().iter().any(|x| x["kind"] == "doc"));
        assert!(e["answer"].as_str().unwrap().contains("- Tickets: PROJ-9"));
        assert_eq!(super::super::log::list(&d, &super::super::launch::local_day_hour(super::super::launch::now_secs()).0).unwrap().len(), 1);
        assert_eq!(kept(&load_state(&d), "morning").unwrap().doc, "https://claude.ai/artifact/abc");
        let rv = read_run(&d, &run).unwrap();
        assert_eq!(rv["doc"]["url"], "https://claude.ai/artifact/abc", "the run file keeps the doc link");
        let by = |t: &str| rv["sections"].as_array().unwrap().iter().find(|p| p["title"] == t).unwrap().clone();
        assert_eq!((by("Tickets")["status"].as_str(), by("Tickets")["line"].as_str()), (Some("needs"), Some("PROJ-9 is blocked on you since Monday")));
        assert_eq!(by("Monitors")["status"], "unchecked", "each section's status and line is kept in the run file");
        let sec = |t: &str| e["report"]["sections"].as_array().unwrap().iter().find(|s| s["title"] == t).unwrap().clone();
        assert!(sec("Notes").get("detail").is_none(), "a short line and no detail: nothing to open");
        assert!(done(&d, &run, &results, 300).unwrap_err().contains("already done"));
        // A done whose run file was not marked (a failure after the log) is tried again: one entry.
        let mut rv = read_run(&d, &run).unwrap();
        rv["done"] = json!(false);
        write_run(&d, &run, &rv).unwrap();
        done(&d, &run, &results, 300).unwrap();
        assert_eq!(super::super::log::list(&d, &super::super::launch::local_day_hour(super::super::launch::now_secs()).0).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_sections_detail_is_kept_as_markdown_and_a_cut_line_stands_in_for_it() {
        let d = tmp("detail");
        let run = built_run(&d);
        let src = json!([{"kind": "query", "ref": "q", "label": "q"}]);
        let long = format!("{} end", "word ".repeat(60));
        let table = "| PR | Age |\n| --- | --- |\n| #1 | 2d |";
        let e = done(&d, &run, &json!({"answer": "a", "docWhy": "test", "sections": [
            {"title": "Tickets", "status": "ok", "line": "two tickets", "detail": format!("  {table}\r\n\n- more  "), "sources": src},
            {"title": "Notes", "status": "ok", "line": long, "sources": src}]}), 200).unwrap();
        let s = &e["report"]["sections"];
        assert_eq!(s[2]["detail"], format!("{table}\n\n- more"), "newlines kept, ends trimmed: {}", s[2]);
        assert!(s[3]["line"].as_str().unwrap().ends_with('…'));
        assert_eq!(s[3]["detail"], long.split_whitespace().collect::<Vec<_>>().join(" "), "the whole line, when it was cut");
        assert!(detail_of(&"x".repeat(DETAIL_MAX + 10)).ends_with("(cut here: the rest is in the doc)"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_stray_log_add_under_the_run_id_does_not_stand_in_for_the_report() {
        let d = tmp("stray");
        let run = built_run(&d);
        super::super::log::add(&d, &json!({"id": run, "question": "Morning report", "answer": "logged by hand"})).unwrap();
        let ok = |t: &str| json!({"title": t, "status": "ok", "line": "fine", "sources": [{"kind": "query", "ref": "q", "label": "q"}]});
        let e = done(&d, &run, &json!({"answer": "fine", "docWhy": "skipped", "sections": [ok("Tickets"), ok("Notes")]}), 200).unwrap();
        assert_eq!(e["report"]["run"], json!(run), "the report entry is logged");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn done_refuses_bad_results() {
        let d = tmp("bad-done");
        let run = built_run(&d);
        let src = json!([{"kind": "query", "ref": "status = open", "label": "open tickets"}]);
        let ok = |t: &str| json!({"title": t, "status": "ok", "line": "fine", "sources": src});
        let good = |secs: Value| json!({"answer": "- all fine", "doc": "https://claude.ai/artifact/abc", "sections": secs});
        let with = |k: &str, v: Value| {
            let mut g = good(json!([ok("Tickets"), ok("Notes")]));
            g[k] = v;
            g
        };
        let mut no_answer = good(json!([ok("Tickets"), ok("Notes")]));
        no_answer.as_object_mut().unwrap().remove("answer");
        let mut no_doc = good(json!([ok("Tickets"), ok("Notes")]));
        no_doc.as_object_mut().unwrap().remove("doc");
        for (bad, says) in [
            (json!({}), "sections"),
            (good(json!([ok("Tickets")])), "Notes"),
            (good(json!([ok("Tickets"), {"title": "Notes", "status": "great", "line": "x", "sources": src}])), "status"),
            (good(json!([ok("Tickets"), {"title": "Notes", "status": "ok", "line": "  ", "sources": src}])), "no line"),
            (with("doc", json!("javascript:alert(1)")), "https"),
            (no_answer, "no answer"),
            (good(json!([ok("Tickets"), {"title": "Notes", "status": "ok", "line": "fine"}])), "no sources"),
            (good(json!([ok("Tickets"), {"title": "Notes", "status": "ok", "line": "fine", "sources": [{"ref": "x", "label": "x"}]}])), "kind"),
            (no_doc, "docWhy"),
        ] {
            let e = done(&d, &run, &bad, 200).unwrap_err();
            assert!(e.contains(says), "{bad}: {e}");
        }
        assert!(done(&d, "nope", &json!({"sections": []}), 200).is_err());
        let unbuilt = run_now(&d, "morning", 100).unwrap();
        assert!(done(&d, &unbuilt, &good(json!([ok("Tickets"), ok("Notes")])), 200).unwrap_err().contains("never typed"));
        // An unchecked section needs no source; a docWhy stands in for the doc.
        let e = done(&d, &run, &json!({"answer": "a", "docWhy": "the connector timed out", "sections": [ok("Tickets"), {"title": "Notes", "status": "unchecked", "line": "Not checked: notes timed out"}]}), 200).unwrap();
        assert_eq!(e["report"]["docWhy"], "the connector timed out");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_run_that_needs_you_posts_one_banner_once() {
        let d = tmp("banner");
        let notes = d.join("state");
        let run = built_run(&d);
        assert!(banner_pass(&d, &notes, 200).is_empty(), "not done yet");
        let src = json!([{"kind": "ticket", "ref": "PROJ-9", "label": "PROJ-9"}]);
        let needs = |t: &str, l: &str| json!({"title": t, "status": "needs", "line": l, "sources": src});
        done(&d, &run, &json!({"answer": "two wait", "docWhy": "test", "sections": [needs("Tickets", "PROJ-9 is blocked on you"), needs("Notes", "a note waits")]}), 200).unwrap();
        assert_eq!(banner_pass(&d, &notes, 210), [run.clone()]);
        let files: Vec<_> = fs::read_dir(&notes).unwrap().flatten().collect();
        assert_eq!(files.len(), 1);
        let n: Value = serde_json::from_str(&fs::read_to_string(files[0].path()).unwrap()).unwrap();
        assert_eq!((n["kind"].as_str(), n["title"].as_str(), n["entry"].as_str()), (Some("bosun"), Some("Bosun · Morning report"), Some(run.as_str())));
        assert_eq!(n["body"], "Tickets: PROJ-9 is blocked on you · 1 more");
        assert!(banner_pass(&d, &notes, 220).is_empty(), "once");
        // A quiet run posts nothing; a run past two weeks is deleted.
        let quiet = { let i = run_now(&d, "morning", 300).unwrap(); let it = queue::waiting(&d).into_iter().find(|x| x.id == i).unwrap(); prepare_with(&d, &it, &found(), 300, "/bin/seamux").unwrap(); i };
        let ok = |t: &str| json!({"title": t, "status": "ok", "line": "fine", "sources": src});
        done(&d, &quiet, &json!({"answer": "fine", "docWhy": "test", "sections": [ok("Tickets"), ok("Notes")]}), 310).unwrap();
        assert!(banner_pass(&d, &notes, 320).is_empty());
        banner_pass(&d, &notes, 300 + RUN_KEEP_SECS + 1);
        assert!(read_run(&d, &quiet).is_none() && read_run(&d, &run).is_none());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_report_sent_to_no_banner_stays_quiet() {
        let rv = json!({"title": "PRs", "needs": ["PRs: #1 waits"], "banner": false});
        assert_eq!(banner_of(&rv), None);
        let rv = json!({"title": "PRs", "needs": ["PRs: #1 waits"], "banner": true});
        assert_eq!(banner_of(&rv), Some(("Bosun · PRs".into(), "PRs: #1 waits".into())));
    }

    #[test]
    fn list_and_check_show_each_report_and_the_bad_ones() {
        let d = tmp("list");
        loops::write_json(&d.join("bosun.json"), &json!({"reports": [morning(), {"id": "bad"}, morning()]})).unwrap();
        let rows = list(&d, super::super::launch::now_secs());
        assert_eq!(rows[0]["schedule"], "09:00 weekdays");
        assert_eq!(rows[0]["sections"][1]["via"][0], "mcp:datadog");
        assert!(rows[1]["error"].as_str().unwrap().contains("bad"));
        assert!(rows[2]["error"].as_str().unwrap().contains("another report"));
        let c = check(&d, &found(), Some("morning"));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0]["sections"][1]["via"][0]["why"], "datadog needs authentication");
        assert_eq!(c[0]["doc"]["ok"], true);
        let _ = fs::remove_dir_all(&d);
    }
}
