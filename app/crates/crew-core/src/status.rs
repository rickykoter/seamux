//! Agent status per pane, and the one roll-up from panes to a workspace.
//!
//! ```text
//! ~/.cache/cmux-crew/pane-<key>.json
//! {"ws": "<uuid>", "surface": "<uuid>|", "session": "<id>", "state": "working",
//!  "question": {...}|null, "asked": "<text>"|null, "review": false, "at": 1792627120000}
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
        }
    }

    /// The file's key: the surface, else the workspace.
    pub fn key(&self) -> &str {
        key(&self.ws, &self.surface)
    }

    /// Whether a tool use in this pane has something to release: pretool's
    /// hot path tests the hold marker this keeps.
    pub fn holds(&self) -> bool {
        self.state == "needs_input" || self.review || self.asked.is_some()
    }

    pub fn to_json(&self) -> Value {
        json!({"ws": self.ws, "surface": self.surface, "session": self.session, "state": self.state,
               "question": self.question, "asked": self.asked, "review": self.review, "at": self.at})
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
    let _ = fs::create_dir_all(dir);
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("panes.lock")).ok();
    if let Some(f) = &f {
        use std::os::fd::AsRawFd;
        // SAFETY: flock on a descriptor we just opened; it blocks until held.
        unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) };
    }
    Lock(f)
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

#[cfg(test)]
mod tests {
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
}
