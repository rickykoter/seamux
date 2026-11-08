//! Agent status per pane, and the one roll-up from panes to a workspace.
//!
//! ```text
//! ~/.cache/cmux-crew/pane-<key>.json
//! {"ws": "<uuid>", "surface": "<uuid>|", "session": "<id>", "state": "working",
//!  "question": {...}|null, "asked": "<text>"|null, "review": false, "at": 1792627120000,
//!  "limited": {"error": "rate_limit", "session": "<id>", "at": <ms>, "window": "five_hour"|null,
//!              "resets_at": <ms>|null, "tries": 0, "next_try": <ms>|null,
//!              "gave_up": "<why>"|null}}   only while a limit stopped it
//! ~/.cache/cmux-crew/hold-<key>     while the pane holds something a tool use releases
//! ```
//!
//! `<key>` is the pane (crew_core::ident: SEAMUX_PANE_ID, else
//! CMUX_SURFACE_ID), or the workspace id when a hook runs without one. A pane's hooks write only its own file, so two
//! Claudes in one workspace never clear each other's state.
//!
//! `rollup` is the only code that turns a workspace's panes into one state,
//! ranked needs_input > working > idle > ended. `write_markers` keeps the
//! workspace-level files older readers use (question-<ws>, its .json, and
//! asked-<ws>) in step with it; the hook applies the lane and the phase:
//! token from the same roll-up.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// A pane's states, ranked: the first one any pane is in is the workspace's.
pub const RANK: [&str; 4] = ["needs_input", "working", "idle", "ended"];

/// One pane's state, as its hooks last wrote it.
#[derive(Clone, Debug, PartialEq)]
pub struct Pane {
    pub ws: String,
    pub surface: String,
    pub session: String,
    /// One of `RANK` (crew-core's history states).
    pub state: String,
    /// The open AskUserQuestion: the app's record, or `{}` for an ask with
    /// no question text. None when nothing is asked.
    pub question: Option<Value>,
    /// The turn-end judgment's question, while it waits on you.
    pub asked: Option<String>,
    /// The turn ended with work nobody has reviewed (the review lane).
    pub review: bool,
    /// Milliseconds since the epoch of the last write.
    pub at: u64,
    /// The turn was stopped by a usage limit (a StopFailure of rate_limit or
    /// billing_error), until the pane works again.
    pub limited: Option<Limited>,
    /// Background sub-agents and workflows the session still runs, from
    /// Claude Code's Stop and SubagentStop payloads (background_tasks).
    pub background: Vec<Background>,
    /// The main turn ended and only background work keeps the pane working,
    /// so the silent and interrupt checks leave it alone. A prompt, an
    /// answer, a new session or the last task's finish clears it.
    pub bg_only: bool,
}

/// The background task types that keep a pane working: agents, which
/// finish on their own and start a main turn when they do. A background
/// shell or monitor (a dev server, a log tail) can run for hours and is not
/// the session at work, unless a sub-agent started it (see from_payload).
pub const BACKGROUND_KINDS: [&str; 3] = ["subagent", "workflow", "teammate"];

/// One background task, as Claude Code's background_tasks lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Background {
    /// Claude Code's task type: subagent, workflow, shell, monitor and so on.
    pub kind: String,
    pub id: String,
    /// The workflow's name, else the task's description, else its agent type.
    pub label: String,
    /// When this pane first saw it, in ms since the epoch.
    pub at: u64,
}

impl Background {
    pub fn to_json(&self) -> Value {
        json!({"kind": self.kind, "id": self.id, "label": self.label, "at": self.at})
    }

    pub fn from_json(v: &Value) -> Option<Background> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let id = s("id");
        (!id.is_empty()).then(|| Background { kind: s("kind"), id, label: s("label"), at: v.get("at").and_then(Value::as_u64).unwrap_or(0) })
    }

    /// The agent tasks (BACKGROUND_KINDS) in a hook payload's
    /// background_tasks that still run, less `except` (a SubagentStop lists
    /// its own agent as running). A task this pane already knows keeps its
    /// start; a new one starts at `now_ms`.
    ///
    /// A sub-agent that stops while a shell it put in the background still
    /// runs drops off the list, and Claude Code (2.1.319) lists only the
    /// shell, with no owner. So a shell counts when a sub-agent started it:
    /// its id is in `owned`, the shell ids the departing agents' own
    /// transcripts name (shells_owned). Once adopted it counts until it
    /// ends. Any other shell (the main agent's dev server) never does.
    pub fn from_payload(payload: &Value, except: &str, known: &[Background], owned: &[String], now_ms: u64) -> Vec<Background> {
        let Some(tasks) = payload.get("background_tasks").and_then(Value::as_array) else { return Vec::new() };
        let s = |t: &Value, k: &str| t.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        tasks.iter().filter_map(|t| {
            let id = s(t, "id");
            let status = s(t, "status");
            let kind = s(t, "type");
            let agent = BACKGROUND_KINDS.contains(&kind.as_str());
            let shell = kind == "shell" && (known.iter().any(|b| b.id == id) || owned.contains(&id));
            if id.is_empty() || id == except || !(agent || shell)
                || !(status.is_empty() || status == "running" || status == "pending") {
                return None;
            }
            let label = [s(t, "name"), s(t, "description"), s(t, "agent_type"), s(t, "type")]
                .into_iter().find(|l| !l.is_empty()).unwrap_or_default();
            let at = known.iter().find(|b| b.id == id).map(|b| b.at).unwrap_or(now_ms);
            Some(Background { kind, id, label, at })
        }).collect()
    }

    /// The agents this pane knew that a payload no longer lists: they
    /// stopped (and may have left a shell running).
    pub fn agents_left(payload: &Value, known: &[Background]) -> Vec<String> {
        let listed: Vec<&str> = payload.get("background_tasks").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|t| t.get("id").and_then(Value::as_str)).collect();
        known.iter().filter(|b| b.kind == "subagent" && !listed.contains(&b.id.as_str())).map(|b| b.id.clone()).collect()
    }

    /// The payload's shell ids that these transcripts name: Claude Code
    /// writes "Command running in background with ID: <id>" into the
    /// transcript of the agent that started it. Each transcript is read
    /// line by line, keeping only the lines that say so.
    pub fn shells_owned(payload: &Value, transcripts: &[PathBuf]) -> Vec<String> {
        use std::io::BufRead;
        let ids: Vec<String> = payload.get("background_tasks").and_then(Value::as_array).into_iter().flatten()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("shell"))
            .filter_map(|t| t.get("id").and_then(Value::as_str).filter(|i| !i.is_empty()).map(str::to_string)).collect();
        if ids.is_empty() {
            return Vec::new();
        }
        let mut text = String::new();
        for t in transcripts {
            let Ok(f) = fs::File::open(t) else { continue };
            let mut r = std::io::BufReader::new(f);
            let mut raw = Vec::new();
            loop {
                raw.clear();
                match r.read_until(b'\n', &mut raw) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let line = String::from_utf8_lossy(&raw);
                if line.contains("background with ID: ") {
                    text.push_str(&line);
                }
            }
        }
        // The id must end where the text's does: a prefix of another id is no match.
        let named = |id: &str| {
            let pat = format!("background with ID: {id}");
            text.match_indices(&pat).any(|(i, _)| {
                text[i + pat.len()..].chars().next().is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
            })
        };
        ids.into_iter().filter(|id| named(id)).collect()
    }
}

/// Why a pane's turn stopped on a limit, and when it may go again. Times are
/// milliseconds since the epoch, as a pane's `at` is.
#[derive(Clone, Debug, PartialEq)]
pub struct Limited {
    /// Claude Code's StopFailure error: rate_limit or billing_error.
    pub error: String,
    /// The session the limit stopped: a resume types only into it.
    pub session: String,
    pub at: u64,
    /// The window it hit (crew_core::limits::WINDOWS), None when unknown.
    pub window: Option<String>,
    /// When that window resets, None when unknown.
    pub resets_at: Option<u64>,
    /// Resumes tried so far (usage billing retries a rate_limit).
    pub tries: u32,
    /// When the next resume is due, where it is not the reset.
    pub next_try: Option<u64>,
    /// Why the app stopped trying to resume it (a refused screen, an
    /// unconfirmed resume, three tries): it waits for you.
    pub gave_up: Option<String>,
}

impl Limited {
    pub fn to_json(&self) -> Value {
        json!({"error": self.error, "session": self.session, "at": self.at, "window": self.window,
               "resets_at": self.resets_at, "tries": self.tries, "next_try": self.next_try, "gave_up": self.gave_up})
    }

    pub fn from_json(v: &Value) -> Option<Limited> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Limited {
            error: s("error").filter(|e| !e.is_empty())?,
            session: s("session").unwrap_or_default(),
            at: v.get("at").and_then(Value::as_u64).unwrap_or(0),
            window: s("window"),
            resets_at: v.get("resets_at").and_then(Value::as_u64),
            tries: v.get("tries").and_then(Value::as_u64).unwrap_or(0) as u32,
            next_try: v.get("next_try").and_then(Value::as_u64),
            gave_up: s("gave_up"),
        })
    }
}

impl Pane {
    pub fn new(ws: &str, surface: &str) -> Pane {
        Pane {
            ws: ws.to_string(),
            surface: surface.to_string(),
            session: String::new(),
            state: "idle".into(),
            question: None,
            asked: None,
            review: false,
            at: 0,
            limited: None,
            background: Vec::new(),
            bg_only: false,
        }
    }

    /// The file's key: the surface, else the workspace.
    pub fn key(&self) -> &str {
        key(&self.ws, &self.surface)
    }

    /// Whether a tool use in this pane has something to release: pretool's
    /// hot path tests the hold marker this keeps. A limit stop is one: the
    /// pane at work again is no longer stopped.
    pub fn holds(&self) -> bool {
        self.state == "needs_input" || self.review || self.asked.is_some() || self.limited.is_some()
    }

    /// The file's JSON. `limited`, `background` and `bg_only` are written
    /// only while set, so a pane without them reads as it always did.
    pub fn to_json(&self) -> Value {
        let mut v = json!({"ws": self.ws, "surface": self.surface, "session": self.session, "state": self.state,
               "question": self.question, "asked": self.asked, "review": self.review, "at": self.at});
        if let Some(l) = &self.limited {
            v["limited"] = l.to_json();
        }
        if !self.background.is_empty() {
            v["background"] = Value::Array(self.background.iter().map(Background::to_json).collect());
        }
        if self.bg_only {
            v["bg_only"] = Value::Bool(true);
        }

        v
    }

    pub fn from_json(v: &Value) -> Option<Pane> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let state = s("state").filter(|st| RANK.contains(&st.as_str()))?;
        Some(Pane {
            ws: s("ws").filter(|w| !w.is_empty())?,
            surface: s("surface").unwrap_or_default(),
            session: s("session").unwrap_or_default(),
            state,
            question: v.get("question").filter(|q| q.is_object()).cloned(),
            asked: s("asked"),
            review: v.get("review").and_then(Value::as_bool).unwrap_or(false),
            at: v.get("at").and_then(Value::as_u64).unwrap_or(0),
            limited: v.get("limited").and_then(Limited::from_json),
            background: v.get("background").and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Background::from_json).collect()).unwrap_or_default(),
            bg_only: v.get("bg_only").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// A pane's file key: its surface, or its workspace without one.
pub fn key<'a>(ws: &'a str, surface: &'a str) -> &'a str {
    if surface.is_empty() {
        ws
    } else {
        surface
    }
}

pub fn path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("pane-{key}.json"))
}

pub fn hold_path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("hold-{key}"))
}

pub fn read(dir: &Path, key: &str) -> Option<Pane> {
    let text = fs::read_to_string(path(dir, key)).ok()?;
    Pane::from_json(&serde_json::from_str(&text).ok()?)
}

/// Write `text` whole: a reader never sees half a file.
fn write_whole(p: &Path, text: &str) {
    let tmp = p.with_extension(format!("tmp-{}", std::process::id()));
    if fs::write(&tmp, text).is_ok() && fs::rename(&tmp, p).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// The pane's file, and its hold marker beside it.
pub fn write(dir: &Path, p: &Pane) {
    let _ = fs::create_dir_all(dir);
    write_whole(&path(dir, p.key()), &format!("{}\n", p.to_json()));
    let hold = hold_path(dir, p.key());
    if p.holds() {
        if !hold.exists() {
            let _ = fs::write(&hold, "");
        }
    } else {
        let _ = fs::remove_file(&hold);
    }
}

/// A pane is gone (its surface closed): its files go.
pub fn remove(dir: &Path, key: &str) {
    let _ = fs::remove_file(path(dir, key));
    let _ = fs::remove_file(hold_path(dir, key));
}

/// Every pane file in `dir`, whichever workspace.
/// How long a working pane may go with no hook write before it reads as
/// silent: SEAMUX_SILENT_MINUTES (whole minutes, at least 1), default 10.
/// Only Stop and End move a pane out of working, so a turn that hangs
/// mid-tool would otherwise read as working forever.
pub fn silent_threshold_ms() -> u64 {
    let m = std::env::var("SEAMUX_SILENT_MINUTES").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|m| *m >= 1).unwrap_or(10);
    m * 60_000
}

/// What a working pane past the threshold is doing, by its hook activity,
/// with how long it has been so (ms).
#[derive(Clone, Debug, PartialEq)]
pub enum Quiet {
    /// Inside one tool call (a long test, a script, a subagent): busy.
    InTool(u64),
    /// No tool in flight and nothing since: the turn may be hung.
    Silent(u64),
}

/// A pane's tool-use marks from crew's hook script: (last tool start, last
/// tool end) in ms, from the mtimes of act-<key> and done-<key>; 0 when a
/// mark is missing.
pub fn activity(dir: &Path, key: &str) -> (u64, u64) {
    let at = |name: String| {
        fs::metadata(dir.join(name)).and_then(|m| m.modified()).ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
    };
    (at(format!("act-{key}")), at(format!("done-{key}")))
}

/// The working panes quiet past `threshold_ms`, longest first. A tool that
/// started after the last tool ended (and after the pane's last write) is
/// in flight: such a pane is InTool by how long that tool has run. Any other
/// is Silent by how long since its last sign of life (a write, a tool start
/// or end). `activity` gives a pane's (tool start, tool end) marks. A pane
/// whose main turn ended while background work runs (bg_only) is busy,
/// never quiet: its sub-agents' tool use leaves no marks of its own.
pub fn quiet<'a>(panes: &'a [Pane], now_ms: u64, threshold_ms: u64, activity: &dyn Fn(&Pane) -> (u64, u64)) -> Vec<(&'a Pane, Quiet)> {
    let mut out: Vec<(&Pane, Quiet, u64)> = Vec::new();
    for p in panes.iter().filter(|p| p.state == "working" && p.at > 0 && !p.bg_only) {
        let (act, done) = activity(p);
        if act > done && act >= p.at {
            let age = now_ms.saturating_sub(act);
            if age > threshold_ms {
                out.push((p, Quiet::InTool(age), age));
            }
        } else {
            let age = now_ms.saturating_sub(p.at.max(act).max(done));
            if age > threshold_ms {
                out.push((p, Quiet::Silent(age), age));
            }
        }
    }
    out.sort_by(|a, b| b.2.cmp(&a.2));
    out.into_iter().map(|(p, q, _)| (p, q)).collect()
}

pub fn all(dir: &Path) -> Vec<Pane> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Pane> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let key = name.strip_prefix("pane-")?.strip_suffix(".json")?.to_string();
            read(dir, &key)
        })
        .collect();
    out.sort_by(|a, b| (a.at, &a.surface).cmp(&(b.at, &b.surface)));
    out
}

/// The panes of one workspace, oldest write first.
pub fn panes(dir: &Path, ws: &str) -> Vec<Pane> {
    all(dir).into_iter().filter(|p| p.ws == ws).collect()
}

/// The store cmux's Claude hooks keep: which session each surface runs, and
/// each session's record (its pid among them).
pub fn store_path() -> PathBuf {
    crate::py::home().join(".cmuxterm").join("claude-hook-sessions.json")
}

/// Whether process `pid` exists (kill 0; EPERM still means it exists).
pub fn pid_alive(pid: i64) -> bool {
    if pid <= 0 || pid > i32::MAX as i64 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; it only asks whether the pid exists.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// When process `pid` started, as (seconds, microseconds) since the epoch,
/// where the OS tells it (macOS); None elsewhere or when it cannot.
pub fn pid_start(pid: i64) -> Option<(u64, u64)> {
    #[cfg(target_os = "macos")]
    {
        if pid <= 0 || pid > i32::MAX as i64 {
            return None;
        }
        // SAFETY: proc_pidinfo writes at most `size` bytes into `info`, a
        // zeroed proc_bsdinfo of exactly that size.
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let n = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
        (n == size).then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        None
    }
}

/// Whether the process the store recorded is the one running: its pid is
/// alive and, when both the store and the OS give a start time, it started
/// then. A pid reused by a later process has a different start.
pub fn proc_alive(pid: i64, recorded: Option<(u64, u64)>) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    match (recorded, pid_start(pid)) {
        (Some((rs, ru)), Some((s, u))) => rs == s && ru.abs_diff(u) < 1000,
        _ => true,
    }
}

/// What the store says about the Claude a pane file names: its session's
/// record, found by session id, with that process alive or not. A pane is
/// absent when its file is ended, the store has no record of its session,
/// or the record puts the session on another surface: none of that proves
/// the pane alive or dead.
pub fn liveness(
    panes: &[Pane],
    store: &Value,
    alive: impl Fn(i64, Option<(u64, u64)>) -> bool,
) -> std::collections::HashMap<String, (bool, String)> {
    let mut out = std::collections::HashMap::new();
    let Some(sessions) = store.get("sessions").and_then(Value::as_object) else { return out };
    for p in panes.iter().filter(|p| p.state != "ended" && !p.surface.is_empty() && !p.session.is_empty()) {
        let Some(rec) = sessions.get(&p.session) else { continue };
        let on = rec.get("surfaceId").and_then(Value::as_str).unwrap_or("");
        if !on.is_empty() && !on.eq_ignore_ascii_case(&p.surface) {
            continue;
        }
        let pid = rec.get("pid").and_then(Value::as_i64).unwrap_or(0);
        if pid <= 0 {
            continue;
        }
        let start = rec.get("pidStartSeconds").and_then(Value::as_u64)
            .map(|s| (s, rec.get("pidStartMicroseconds").and_then(Value::as_u64).unwrap_or(0)));
        out.insert(p.surface.to_uppercase(), (alive(pid, start), p.state.clone()));
    }
    out
}

/// The panes whose own Claude is alive, by upper-case surface, with the state
/// their hooks last wrote (see `liveness`). This is the pane's status as crew
/// knows it: cmux keys lifecycle by session, so a session resumed in a
/// second pane reads "ended" in both once the first copy ends.
pub fn live_states(panes: &[Pane], store: &Value, alive: impl Fn(i64, Option<(u64, u64)>) -> bool) -> std::collections::HashMap<String, String> {
    liveness(panes, store, alive).into_iter().filter(|(_, (a, _))| *a).map(|(k, (_, s))| (k, s)).collect()
}

fn read_store() -> Option<Value> {
    fs::read_to_string(store_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

/// `live_states` over the pane files in `dir` and the store on disk; None
/// when the store cannot be read.
pub fn live_states_now(dir: &Path) -> Option<std::collections::HashMap<String, String>> {
    Some(live_states(&all(dir), &read_store()?, proc_alive))
}

/// `liveness` over the pane files in `dir` and the store on disk; None when
/// the store cannot be read, which proves nothing either way.
pub fn liveness_now(dir: &Path) -> Option<std::collections::HashMap<String, (bool, String)>> {
    Some(liveness(&all(dir), &read_store()?, proc_alive))
}

/// What the workspace's lane should say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane {
    /// Someone waits on you.
    Attention,
    /// A finished turn left work to review.
    Review,
    /// Nothing to pin: cmux's own.
    Auto,
}

/// A workspace's state, rolled up from its panes.
#[derive(Clone, Debug, PartialEq)]
pub struct Rollup {
    /// The highest-ranked pane state, or "" with no panes.
    pub state: &'static str,
    pub lane: Lane,
    /// The newest open ask's question, and the surface that asked it.
    pub question: Option<(String, Value)>,
    /// The newest turn-end question that waits on you.
    pub asked: Option<String>,
    pub panes: usize,
}

impl Rollup {
    /// The description's phase: token value, "" for none.
    pub fn phase(&self) -> &'static str {
        match self.state {
            "needs_input" => "waiting",
            "working" => "working",
            _ => "",
        }
    }

    /// Some pane is at work or waits on you.
    pub fn busy(&self) -> bool {
        matches!(self.state, "needs_input" | "working")
    }
}

/// The roll-up of these panes.
pub fn rollup_of(panes: &[Pane]) -> Rollup {
    let state = RANK.iter().find(|s| panes.iter().any(|p| p.state == **s)).copied().unwrap_or("");
    let lane = if state == "needs_input" {
        Lane::Attention
    } else if state == "working" {
        Lane::Auto
    } else if panes.iter().any(|p| p.review) {
        Lane::Review
    } else {
        Lane::Auto
    };
    let newest = |f: &dyn Fn(&Pane) -> bool| panes.iter().filter(|p| f(p)).max_by_key(|p| p.at);
    let question = newest(&|p| p.question.is_some()).map(|p| (p.surface.clone(), p.question.clone().unwrap_or(Value::Null)));
    let asked = newest(&|p| p.asked.is_some()).and_then(|p| p.asked.clone());
    Rollup { state, lane, question, asked, panes: panes.len() }
}

/// The roll-up of a workspace's pane files.
pub fn rollup(dir: &Path, ws: &str) -> Rollup {
    rollup_of(&panes(dir, ws))
}

/// The workspace-level files, in step with the roll-up: question-<ws> while
/// any pane asks, question-<ws>.json with its questions, and asked-<ws> with
/// the turn-end question. A file is rewritten only when its text changes, so
/// its mtime still says since when it waits.
pub fn write_markers(dir: &Path, ws: &str, r: &Rollup) {
    let marker = dir.join(format!("question-{ws}"));
    let qfile = dir.join(format!("question-{ws}.json"));
    match &r.question {
        Some((_, q)) => {
            if !marker.exists() {
                let _ = fs::write(&marker, "");
            }
            let has = q.get("questions").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
            if has {
                let text = format!("{q}\n");
                if fs::read_to_string(&qfile).ok().as_deref() != Some(text.as_str()) {
                    write_whole(&qfile, &text);
                }
            } else {
                let _ = fs::remove_file(&qfile);
            }
        }
        None => {
            let _ = fs::remove_file(&marker);
            let _ = fs::remove_file(&qfile);
        }
    }
    let asked = dir.join(format!("asked-{ws}"));
    match &r.asked {
        Some(text) => {
            if fs::read_to_string(&asked).ok().as_deref() != Some(text.as_str()) {
                write_whole(&asked, text);
            }
        }
        None => {
            let _ = fs::remove_file(&asked);
        }
    }
}

/// Held while a pane is changed and its workspace rolled up, so two panes'
/// hooks never write the workspace's files from stale reads.
pub struct Lock(Option<fs::File>);

impl Drop for Lock {
    fn drop(&mut self) {
        if let Some(f) = &self.0 {
            use std::os::fd::AsRawFd;
            // SAFETY: flock on a descriptor this struct owns.
            unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

pub fn lock(dir: &Path) -> Lock {
    lock_file(dir, "panes.lock")
}

/// An exclusive lock on `dir/name`, held until the Lock drops.
pub fn lock_file(dir: &Path, name: &str) -> Lock {
    let _ = fs::create_dir_all(dir);
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(name)).ok();
    if let Some(f) = &f {
        use std::os::fd::AsRawFd;
        // SAFETY: flock on a descriptor we just opened; it blocks until held.
        unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
    }
    Lock(f)
}

/// Change the limit stop a pane file carries, under the status lock, when it
/// is still the one `seen` (the same session and stop time) and the pane is
/// still stopped: a hook that moved the pane first wins. The pane's `at` is
/// kept, so how long it has been stopped still reads true. True when it wrote.
pub fn update_limited(dir: &Path, key: &str, seen: &Limited, change: impl FnOnce(&mut Limited)) -> bool {
    let _l = lock(dir);
    let Some(mut p) = read(dir, key) else { return false };
    let Some(l) = p.limited.as_mut().filter(|l| l.session == seen.session && l.at == seen.at) else { return false };
    if p.state != "idle" {
        return false;
    }
    change(l);
    write(dir, &p);
    true
}

/// One pane changed and its workspace rolled up, under the lock: the
/// roll-up before, the roll-up after (its markers written) and the pane as
/// written. The lock covers only the files: the caller's cmux calls come
/// after it, so a slow cmux never holds up another pane's hook.
pub fn update(dir: &Path, ws: &str, surface: &str, session: &str, now_ms: u64, change: impl FnOnce(&mut Pane)) -> (Rollup, Rollup, Pane) {
    let _l = lock(dir);
    let mut all = panes(dir, ws);
    let before = rollup_of(&all);
    let k = key(ws, surface).to_string();
    let mut pane = match all.iter().position(|p| p.key() == k) {
        Some(i) => all.remove(i),
        None => Pane::new(ws, surface),
    };
    change(&mut pane);
    if !session.is_empty() {
        pane.session = session.to_string();
    }
    pane.at = now_ms;
    write(dir, &pane);
    all.push(pane.clone());
    let after = rollup_of(&all);
    write_markers(dir, ws, &after);
    (before, after, pane)
}

// ---- interrupts ---------------------------------------------------------------
// Claude Code fires no Stop when the person presses Esc, so a pane the hooks
// left working stays working. A working pane quiet for a while is checked
// against its screen instead: Claude draws a live spinner line while a turn
// runs, and none once it stops.

/// How long a working pane must be quiet (no hook write, no tool mark) before
/// its screen is read.
pub const INTERRUPT_QUIET_MS: u64 = 30_000;

/// Whether a Claude screen shows a turn in progress. Claude Code draws a
/// spinner line, a verb with an ellipsis and then a bracket, while it works
/// ("✽ Bloviating… (34s · ↓ 1.9k tokens)", "… (thinking)", "… (running stop
/// hook)"); a finished turn's line has no ellipsis ("✻ Worked for 34s").
/// Older versions said "esc to interrupt". A false "busy" only keeps a pane
/// working, as before, so the match leans that way.
pub fn screen_busy(screen: &str) -> bool {
    screen.lines().any(|l| {
        let l = l.trim();
        if l.contains("esc to interrupt") {
            return true;
        }
        let Some(i) = l.find('…') else { return false };
        l[i + '…'.len_utf8()..].trim_start().starts_with('(')
    })
}

/// Whether a Claude screen is asking the person something: a permission
/// prompt or a question's options. Such a pane waits, it is not idle.
pub fn screen_asks(screen: &str) -> bool {
    screen.lines().any(|l| {
        let l = l.trim();
        l.starts_with("Do you want to") || l.starts_with("❯ 1.") || l.contains("Esc to cancel")
    })
}

/// Whether this pane's turn ended with no Stop: crew has it working, nothing
/// has moved for INTERRUPT_QUIET_MS, and its screen (the last lines, read
/// now) shows no turn running and asks nothing. An empty screen (a read that
/// failed) proves nothing. `activity` is the pane's (tool start, tool end).
pub fn interrupted(p: &Pane, activity: (u64, u64), screen: &str, now_ms: u64) -> bool {
    let last = p.at.max(activity.0).max(activity.1);
    p.state == "working" && p.at > 0 && !p.bg_only && now_ms.saturating_sub(last) >= INTERRUPT_QUIET_MS
        && !screen.trim().is_empty() && !screen_busy(screen) && !screen_asks(screen)
}

/// The working panes worth a screen read now: quiet past INTERRUPT_QUIET_MS.
/// A caller reads each one's screen and passes it to `settle_interrupted`.
/// A pane whose main turn already ended (bg_only) is none: no spinner is
/// expected while its sub-agents run.
pub fn interrupt_suspects(dir: &Path, now_ms: u64) -> Vec<Pane> {
    all(dir).into_iter().filter(|p| {
        let a = activity(dir, p.key());
        p.state == "working" && p.at > 0 && !p.bg_only && now_ms.saturating_sub(p.at.max(a.0).max(a.1)) >= INTERRUPT_QUIET_MS
    }).collect()
}

/// Set `seen` to idle if it was interrupted (see `interrupted`) and nothing
/// wrote its file since it was read: a hook that moved it first wins. Under
/// the status lock; the workspace's markers follow, and the history says
/// where the idle came from (`hist`: crate::history::dir() outside tests).
/// True when it changed the pane.
pub fn settle_interrupted(dir: &Path, hist: &Path, seen: &Pane, screen: &str, now_ms: u64) -> bool {
    let k = seen.key().to_string();
    if !interrupted(seen, activity(dir, &k), screen, now_ms) {
        return false;
    }
    let _l = lock(dir);
    let Some(mut p) = read(dir, &k) else { return false };
    if p.state != "working" || p.at != seen.at || p.bg_only {
        return false;
    }
    // Background agents outlive an interrupted turn: the main turn is over,
    // and the pane stays working on them.
    if !p.background.is_empty() {
        p.bg_only = true;
        p.at = now_ms;
        write(dir, &p);
        return true;
    }
    p.state = "idle".into();
    p.at = now_ms;
    write(dir, &p);
    let r = rollup_of(&panes(dir, &p.ws));
    write_markers(dir, &p.ws, &r);
    crate::history::record_in(hist, &p.ws, &p.surface, "idle", "interrupt", "");
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_pane_inside_a_long_tool_is_busy_and_one_with_none_in_flight_is_silent() {
        let pane = |s: &str, at: u64| { let mut p = Pane::new("W1", s); p.state = "working".into(); p.at = at; p };
        let panes = vec![pane("TOOL", 1_000), pane("HUNG", 1_000), pane("BUSY", 1_000), pane("FRESH", 1_000)];
        // TOOL: a test started at 2s and has not ended. HUNG: its last tool
        // ended at 3s. BUSY: a tool ended a minute ago. FRESH: no marks.
        let marks = |p: &Pane| match p.surface.as_str() {
            "TOOL" => (2_000, 1_500),
            "HUNG" => (2_500, 3_000),
            "BUSY" => (1_200_000, 1_230_000),
            _ => (0, 0),
        };
        let q = quiet(&panes, 1_290_000, 600_000, &marks);
        let of = |s: &str| q.iter().find(|(p, _)| p.surface == s).map(|(_, x)| x.clone());
        assert_eq!(of("TOOL"), Some(Quiet::InTool(1_288_000)));
        assert_eq!(of("HUNG"), Some(Quiet::Silent(1_287_000)));
        assert_eq!(of("BUSY"), None);
        assert_eq!(of("FRESH"), Some(Quiet::Silent(1_289_000)));
        // A prompt after a tool that never reported its end: that tool is not
        // in flight, so the pane is judged by its last write.
        let later = vec![pane("P", 5_000)];
        assert_eq!(quiet(&later, 700_000, 600_000, &|_| (2_000, 0)).first().map(|(_, q)| q.clone()), Some(Quiet::Silent(695_000)));
    }

    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("crew-status-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn pane(surface: &str, state: &str, at: u64) -> Pane {
        Pane { state: state.into(), at, ..Pane::new("W", surface) }
    }

    #[test]
    fn waiting_beats_working_beats_idle_beats_ended() {
        assert_eq!(rollup_of(&[]).state, "");
        assert_eq!(rollup_of(&[pane("a", "ended", 1), pane("b", "idle", 2)]).state, "idle");
        assert_eq!(rollup_of(&[pane("a", "idle", 1), pane("b", "working", 2)]).state, "working");
        let r = rollup_of(&[pane("a", "working", 3), pane("b", "needs_input", 2)]);
        assert_eq!((r.state, r.phase(), r.lane), ("needs_input", "waiting", Lane::Attention));
    }

    #[test]
    fn review_pins_only_when_nobody_works_or_waits() {
        let rev = Pane { review: true, ..pane("a", "idle", 1) };
        assert_eq!(rollup_of(&[rev.clone()]).lane, Lane::Review);
        assert_eq!(rollup_of(&[rev.clone(), pane("b", "working", 2)]).lane, Lane::Auto);
        assert_eq!(rollup_of(&[rev, pane("b", "needs_input", 2)]).lane, Lane::Attention);
    }

    #[test]
    fn the_newest_question_is_the_workspaces() {
        let q = |t: &str| json!({"questions": [{"question": t}]});
        let a = Pane { question: Some(q("A?")), ..pane("a", "needs_input", 1) };
        let b = Pane { question: Some(q("B?")), ..pane("b", "needs_input", 5) };
        let r = rollup_of(&[a, b]);
        assert_eq!(r.question, Some(("b".into(), q("B?"))));
    }

    #[test]
    fn one_panes_stop_leaves_the_others_ask() {
        let d = tmp("two");
        let q = json!({"surface": "B", "questions": [{"question": "Which?"}]});
        update(&d, "W", "A", "sa", 1, |p| p.state = "working".into());
        update(&d, "W", "B", "sb", 2, |p| {
            p.state = "needs_input".into();
            p.question = Some(q.clone());
        });
        assert!(d.join("question-W").exists());
        let (before, after, a) = update(&d, "W", "A", "sa", 3, |p| p.state = "idle".into());
        assert_eq!(before.state, "needs_input");
        assert_eq!(after.state, "needs_input");
        assert_eq!(a.state, "idle");
        assert!(d.join("question-W").exists());
        let kept: Value = serde_json::from_str(&fs::read_to_string(d.join("question-W.json")).unwrap()).unwrap();
        assert_eq!(kept, q);
        assert!(hold_path(&d, "B").exists() && !hold_path(&d, "A").exists());
        // B answered: the workspace's question goes.
        let (_, after, _) = update(&d, "W", "B", "sb", 4, |p| {
            p.state = "working".into();
            p.question = None;
        });
        assert_eq!(after.state, "working");
        assert!(!d.join("question-W").exists() && !d.join("question-W.json").exists());
        assert!(!hold_path(&d, "B").exists());
    }

    #[test]
    fn a_limit_stop_is_kept_through_writes_and_held_until_work_resumes() {
        let d = tmp("limited");
        let lim = Limited { error: "rate_limit".into(), session: "s".into(), at: 2, window: Some("five_hour".into()),
                            resets_at: Some(9_000), tries: 0, next_try: None, gave_up: None };
        update(&d, "W", "S", "s", 1, |p| p.state = "working".into());
        let raw: Value = serde_json::from_str(&fs::read_to_string(path(&d, "S")).unwrap()).unwrap();
        assert!(raw.get("limited").is_none(), "no limit, no field");
        update(&d, "W", "S", "s", 2, |p| { p.state = "idle".into(); p.limited = Some(lim.clone()); });
        assert!(hold_path(&d, "S").exists(), "pretool's fast path must wake to clear it");
        update(&d, "W", "S", "s", 3, |p| p.question = None);
        assert_eq!(read(&d, "S").unwrap().limited, Some(lim.clone()), "a write that does not touch it keeps it");
        assert!(update_limited(&d, "S", &lim, |l| l.next_try = Some(7)));
        let p = read(&d, "S").unwrap();
        assert_eq!((p.at, p.limited.as_ref().and_then(|l| l.next_try)), (3, Some(7)), "the pane's own time is kept");
        let other = Limited { at: 1, ..lim.clone() };
        assert!(!update_limited(&d, "S", &other, |l| l.tries = 9), "another stop than the one seen: no write");
        update(&d, "W", "S", "s", 4, |p| { p.state = "working".into(); p.limited = None; });
        assert!(read(&d, "S").unwrap().limited.is_none() && !hold_path(&d, "S").exists());
        assert!(Limited::from_json(&json!({"session": "s"})).is_none(), "no error, no limit");
    }

    #[test]
    fn markers_keep_their_mtime_while_unchanged() {
        let d = tmp("mtime");
        let r = Rollup { state: "needs_input", lane: Lane::Attention, question: None, asked: Some("Ship?".into()), panes: 1 };
        write_markers(&d, "W", &r);
        let f = d.join("asked-W");
        let then = fs::metadata(&f).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_markers(&d, "W", &r);
        assert_eq!(fs::metadata(&f).unwrap().modified().unwrap(), then);
        write_markers(&d, "W", &Rollup { asked: None, ..r });
        assert!(!f.exists());
    }

    #[test]
    fn panes_are_keyed_by_surface_else_workspace() {
        let d = tmp("keys");
        update(&d, "W", "", "s", 1, |p| p.state = "working".into());
        update(&d, "W", "S1", "s", 2, |p| p.state = "idle".into());
        update(&d, "X", "S2", "s", 3, |p| p.state = "working".into());
        assert!(path(&d, "W").exists() && path(&d, "S1").exists());
        assert_eq!(panes(&d, "W").len(), 2);
        assert_eq!(rollup(&d, "X").state, "working");
        assert_eq!(read(&d, "S1").unwrap().session, "s");
        fs::write(path(&d, "junk"), "{not json").unwrap();
        assert_eq!(all(&d).len(), 3);
    }

    #[test]
    fn liveness_goes_by_the_files_own_session() {
        let f = |surface: &str, session: &str, state: &str| Pane { session: session.into(), state: state.into(), ..Pane::new("W", surface) };
        let panes = vec![
            f("S-LIVE", "s1", "working"),
            f("S-DEAD", "s2", "idle"),
            f("S-MOVED", "s3", "working"),
            f("S-ENDED", "s4", "ended"),
            f("S-NOREC", "s5", "working"),
            // A native pane: the surface's active session is an older one, the file's is live.
            f("S-NAT", "s6", "needs_input"),
            f("S-REUSED", "s7", "working"),
        ];
        let store = json!({
            "activeSessionsBySurface": {"S-NAT": {"sessionId": "s-old"}},
            "sessions": {"s1": {"pid": 10, "surfaceId": "s-live"}, "s2": {"pid": 20, "surfaceId": "S-DEAD"},
                         "s3": {"pid": 10, "surfaceId": "S-ELSEWHERE"}, "s4": {"pid": 10},
                         "s6": {"pid": 10, "surfaceId": "S-NAT"}, "s-old": {"pid": 20, "surfaceId": "S-NAT"},
                         "s7": {"pid": 10, "pidStartSeconds": 5, "pidStartMicroseconds": 0}},
        });
        // pid 10 runs, started at second 1; pid 20 is gone.
        let alive = |pid: i64, start: Option<(u64, u64)>| pid == 10 && start.is_none_or(|s| s == (1, 0));
        let got = liveness(&panes, &store, alive);
        let want: std::collections::HashMap<String, (bool, String)> = [
            ("S-LIVE", true, "working"), ("S-DEAD", false, "idle"), ("S-NAT", true, "needs_input"), ("S-REUSED", false, "working"),
        ].into_iter().map(|(k, a, s)| (k.to_string(), (a, s.to_string()))).collect();
        assert_eq!(got, want, "moved, ended and unrecorded panes prove nothing");
        assert_eq!(live_states(&panes, &store, alive).len(), 2);
        assert!(liveness(&panes, &Value::Null, |_, _| true).is_empty(), "no store, no claim");
        let me = std::process::id() as i64;
        assert!(pid_alive(me) && !pid_alive(0) && !pid_alive(-1));
        assert!(proc_alive(me, None));
        if let Some((s, u)) = pid_start(me) {
            assert!(proc_alive(me, Some((s, u))) && !proc_alive(me, Some((s - 100, u))), "a reused pid started at another time");
        }
    }

    // The screens below are what Claude Code drew on this machine on
    // 2026-11-05: a turn running, a turn finished, a permission prompt.
    const BUSY: &str = "  ⎿  ran a thing\n\n✽ Bloviating… (34s · ↓ 1.9k tokens)\n\n────\n❯ \n────\n  ⏵⏵ auto mode on";
    const DONE: &str = "  ⎿  ran a thing\n\n✻ Worked for 34s\n\n────\n❯ \n────\n  ⏵⏵ auto mode on";
    const ASKS: &str = " Bash command\n   cargo build\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel";

    #[test]
    fn a_screen_says_whether_a_turn_runs_or_asks() {
        assert!(screen_busy(BUSY) && !screen_busy(DONE) && !screen_busy(ASKS));
        assert!(screen_busy("  esc to interrupt"), "an older Claude's footer");
        assert!(screen_busy("✶ Thinking… (thinking)") && screen_busy("· Finishing… (running stop hook)"), "a spinner with no clock");
        assert!(!screen_busy("Thinking… about it"), "an ellipsis in prose is not the spinner");
        assert!(screen_asks(ASKS) && !screen_asks(DONE) && !screen_asks(BUSY));
    }

    #[test]
    fn only_a_quiet_working_pane_whose_screen_shows_no_turn_is_interrupted() {
        let mut p = Pane::new("W1", "S1");
        p.state = "working".into();
        p.at = 1_000;
        let later = 1_000 + INTERRUPT_QUIET_MS;
        assert!(interrupted(&p, (0, 0), DONE, later));
        assert!(!interrupted(&p, (0, 0), DONE, later - 1), "not quiet long enough");
        assert!(!interrupted(&p, (later - 5, 0), DONE, later), "a tool started since");
        assert!(!interrupted(&p, (0, 0), BUSY, later), "the spinner runs");
        assert!(!interrupted(&p, (0, 0), ASKS, later), "it asks the person");
        assert!(!interrupted(&p, (0, 0), "  \n", later), "a failed read proves nothing");
        p.state = "idle".into();
        assert!(!interrupted(&p, (0, 0), DONE, later));
    }

    #[test]
    fn settling_an_interrupt_writes_idle_unless_a_hook_moved_the_pane_first() {
        let dir = tmp("interrupt");
        let hist = dir.join("history");
        let (_, _, seen) = update(&dir, "W1", "S1", "s", 1_000, |p| p.state = "working".into());
        let now = 1_000 + INTERRUPT_QUIET_MS;
        assert_eq!(interrupt_suspects(&dir, now).len(), 1);
        // A hook wrote after the read: its word stands.
        let (_, _, moved) = update(&dir, "W1", "S1", "s", 1_500, |p| p.state = "working".into());
        assert!(!settle_interrupted(&dir, &hist, &seen, DONE, now + 600));
        assert!(settle_interrupted(&dir, &hist, &moved, DONE, now + 600));
        assert_eq!(read(&dir, "S1").unwrap().state, "idle");
        assert_eq!(rollup(&dir, "W1").state, "idle");
        let h = crate::history::read_since(&hist, 0);
        assert!(h.iter().any(|e| e.source == "interrupt" && e.state == "idle"), "{h:?}");
        assert!(interrupt_suspects(&dir, now + 600).is_empty());
    }

    fn bg(id: &str) -> Background {
        Background { kind: "subagent".into(), id: id.into(), label: "judge".into(), at: 1 }
    }

    #[test]
    fn quiet_and_settle_interrupted_skip_a_pane_with_background_work() {
        // A pane whose main turn ended while two sub-agents run: no tool of
        // its own in flight and nothing written for an hour.
        let mut p = Pane::new("W1", "S1");
        p.state = "working".into();
        p.at = 1_000;
        p.background = vec![bg("a1"), bg("a2")];
        p.bg_only = true;
        let hour = 1_000 + 3_600_000;
        assert!(quiet(std::slice::from_ref(&p), hour, 600_000, &|_| (0, 0)).is_empty(), "background work is busy, not silent");
        assert!(!interrupted(&p, (0, 0), DONE, hour), "no spinner while sub-agents run");

        let dir = tmp("background");
        let hist = dir.join("history");
        let (_, _, seen) = update(&dir, "W1", "S1", "s", 1_000, |q| {
            q.state = "working".into();
            q.background = vec![bg("a1")];
            q.bg_only = true;
        });
        assert!(interrupt_suspects(&dir, hour).is_empty());
        let mut plain = seen.clone();
        plain.bg_only = false;
        assert!(!settle_interrupted(&dir, &hist, &plain, DONE, hour), "the file's own flag stands");
        assert_eq!(read(&dir, "S1").unwrap().state, "working");

        // The person's own turn runs beside the background work: Esc still
        // counts, and ends only the main turn.
        let (_, _, mine) = update(&dir, "W1", "S1", "s", 2_000, |q| q.bg_only = false);
        let later = 2_000 + INTERRUPT_QUIET_MS;
        assert!(!quiet(std::slice::from_ref(&mine), later + 600_000, 600_000, &|_| (0, 0)).is_empty(), "a turn of its own can go silent");
        assert_eq!(interrupt_suspects(&dir, later).len(), 1);
        assert!(settle_interrupted(&dir, &hist, &mine, DONE, later));
        let after = read(&dir, "S1").unwrap();
        assert_eq!((after.state.as_str(), after.bg_only, after.background.len()), ("working", true, 1));
    }

    #[test]
    fn the_background_list_round_trips_and_reads_a_payload() {
        let mut p = pane("S1", "working", 5);
        p.background = vec![bg("a1")];
        p.bg_only = true;
        assert_eq!(Pane::from_json(&p.to_json()), Some(p.clone()));
        let none = pane("S2", "idle", 5).to_json();
        assert!(none.get("background").is_none() && none.get("bg_only").is_none(), "unset, nothing is written");

        // Stop and SubagentStop as Claude Code 2.1.319 sends them.
        let payload = serde_json::json!({"background_tasks": [
            {"id": "a1", "type": "subagent", "status": "running", "description": "judge", "agent_type": "general-purpose"},
            {"id": "w1", "type": "workflow", "status": "running", "description": "tiny", "name": "spike-wf"},
            {"id": "s1", "type": "shell", "status": "completed", "description": "ls"},
            {"id": "s2", "type": "shell", "status": "running", "description": "npm run dev"},
            {"id": "m1", "type": "monitor", "status": "running", "description": "tail"}]});
        let got = Background::from_payload(&payload, "", &[Background { at: 1, ..bg("a1") }], &[], 99);
        let ids: Vec<(&str, &str, &str, u64)> = got.iter().map(|b| (b.kind.as_str(), b.id.as_str(), b.label.as_str(), b.at)).collect();
        assert_eq!(ids, vec![("subagent", "a1", "judge", 1), ("workflow", "w1", "spike-wf", 99)], "a known task keeps its start; a finished one, a shell and a monitor are not on it");
        assert_eq!(Background::from_payload(&payload, "a1", &[], &[], 99).len(), 1, "a SubagentStop's own agent is left out");
        assert!(Background::from_payload(&serde_json::json!({}), "", &[], &[], 99).is_empty());

        // A sub-agent that stops with its own shell still running, as
        // Claude Code 2.1.319 lists it: the shell is the sub-agent's when
        // the sub-agent's transcript names its id.
        let dir = tmp("owned");
        let tr = dir.join("agent-a1.jsonl");
        fs::write(&tr, "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"Command running in background with ID: b3. Output is being written to: /x\"}]}}\n").unwrap();
        let shell = serde_json::json!({"id": "b3", "type": "shell", "status": "running", "description": "Sleep in background", "command": "sleep 20"});
        let dev = serde_json::json!({"id": "d1", "type": "shell", "status": "running", "description": "npm run dev"});
        let agent = serde_json::json!({"id": "a1", "type": "subagent", "status": "running", "description": "nested sleeper"});
        let sub_stop = serde_json::json!({"background_tasks": [agent, shell, dev]});
        let owned = Background::shells_owned(&sub_stop, std::slice::from_ref(&tr));
        assert_eq!(owned, vec!["b3".to_string()], "only the shell the agent's transcript names; the main agent's dev server is not");
        let after = Background::from_payload(&sub_stop, "a1", &[bg("a1")], &owned, 5);
        assert_eq!(after.iter().map(|b| (b.kind.as_str(), b.id.as_str())).collect::<Vec<_>>(), vec![("shell", "b3")], "adopted from a SubagentStop");
        let only = serde_json::json!({"background_tasks": [shell, dev]});
        assert_eq!(Background::agents_left(&only, &[bg("a1")]), vec!["a1".to_string()], "a Stop where the agent just left");
        assert_eq!(Background::from_payload(&only, "", &after, &[], 5).len(), 1, "once adopted it counts until it ends");
        assert!(Background::from_payload(&only, "", &[], &[], 5).is_empty(), "a shell no agent's transcript names never counts");
        assert!(Background::shells_owned(&only, &[dir.join("missing.jsonl")]).is_empty());
        let pre = serde_json::json!({"background_tasks": [{"id": "b", "type": "shell", "status": "running"}]});
        assert!(Background::shells_owned(&pre, std::slice::from_ref(&tr)).is_empty(), "b is a prefix of b3, not a match");
    }
}
