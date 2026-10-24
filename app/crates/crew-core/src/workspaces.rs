//! Where workspaces are: live, archived, past or gone. One reader
//! (crew/hooks/workspaces.py).
//!
//!   seamux workspaces lifecycle <workspace>   running | idle | none | unknown
//!   seamux workspaces close <workspace> [--family-ok]
//!                                             force-close and check it went; exit 1 if not
//!   seamux workspaces archive <workspace> [--family-ok]
//!                                             close it and remember it; exit 1 on refusal
//!   seamux workspaces protects <dir>          deep-plan's word on a directory, as JSON;
//!                                             exit 1 when it may not be closed
//!   seamux workspaces restore <cwd>           reopen an archived cwd, resuming its Claude
//!   seamux workspaces forget <cwd>            drop an archive record
//!   seamux workspaces dormant-days            the sweep's threshold, default 5
//!   seamux workspaces list-json               every window's workspaces; exit 1 if cmux is silent
//!
//! Rust-only, for the probe shim that drives this module where the probe
//! called the Python in-process (each prints JSON):
//!
//!   scan <transcript>      one session summary, or null
//!   index [--force]        {"rows": [...], "seen": n}
//!   live                   the live list, or null when cmux did not answer
//!   busy <workspace>       foreground jobs that are not a shell or the agent, or null
//!   merged <cwd>           exit 0 when its branch shipped, 1 when not
//!   load-archive           {cwd: record}
//!   update-archive         stdin {"set": {cwd: record}, "pop": [cwd]}, applied under the lock
//!
//! CREW_WORKSPACES_ARCHIVE overrides the archive file, for the shim only.
//!
//! The plan guard (ADR 0031) is workspaces.py's: protects() asks `deep-plan
//! protects <dir> --json`, guard() refuses a protected directory naming the
//! plan and the family, and --family-ok is a person's override (a terminal, a
//! y/N naming the family, the yes logged to family-ok.log). No deep-plan is no
//! guard, said once; a deep-plan that does not answer is a refusal.
//!
//! cmux is reached through crates/cmux: the socket in live use, the CLI (with
//! CMUX_QUIET=1, as the Python passes) when CREW_CMUX is set.

use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::home::{crew_home, xdg_cache};
use crate::py::{self, env_or, home, splitlines, Flock};
use crate::pyjson;
use crate::typesafe::is_falsy;

const HEAD_BYTES: u64 = 64 * 1024;
const TAIL_BYTES: u64 = 256 * 1024;
const INDEX_V: i64 = 2;
const DORMANT_DEFAULT: i64 = 5;
const QUIET: [&str; 5] = ["idle", "stopped", "exited", "ended", "terminated"];
const PROMPT_JOBS: [&str; 12] = ["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login", "claude", "codex"];

pub fn projects() -> PathBuf {
    env_or("CREW_CLAUDE_PROJECTS").map(PathBuf::from).unwrap_or_else(|| home().join(".claude/projects"))
}

pub fn index_path() -> PathBuf {
    xdg_cache().join("resume-index.json")
}

pub fn archive_path() -> PathBuf {
    env_or("CREW_WORKSPACES_ARCHIVE").map(PathBuf::from).unwrap_or_else(|| xdg_cache().join("archive.json"))
}

fn integrations() -> PathBuf {
    env_or("CREW_INTEGRATIONS").map(PathBuf::from).unwrap_or_else(|| crew_home().join("integrations.json"))
}

// --- cmux ------------------------------------------------------------------------

fn cmux() -> Option<&'static cmux::Cmux> {
    static C: OnceLock<Option<cmux::Cmux>> = OnceLock::new();
    C.get_or_init(|| cmux::Cmux::connect().ok().map(|c| c.with_cli_env("CMUX_QUIET", "1"))).as_ref()
}

/// A live workspace, in workspaces.py's field names.
#[derive(Clone, Debug)]
pub struct Ws {
    pub id: String,
    pub r#ref: String,
    pub title: String,
    pub cwd: String,
    pub color: String,
    pub description: String,
    pub selected: bool,
    pub window: String,
    pub last_message: String,
}

impl Ws {
    pub fn json(&self) -> Value {
        json!({"id": self.id, "ref": self.r#ref, "title": self.title, "cwd": self.cwd,
               "color": self.color, "description": self.description, "selected": self.selected,
               "window": self.window, "last_message": self.last_message})
    }
}

fn sval(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) if is_falsy(other) => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Every open workspace in every window, or None when cmux did not answer.
/// None and [] are different sentences: "could not tell" is never "nothing open".
pub fn live_workspaces() -> Option<Vec<Ws>> {
    let c = cmux()?;
    let ids: Vec<String> = c
        .window_list()
        .map(|wins| wins.iter().filter_map(|w| w.get("id").filter(|i| !is_falsy(i)).map(|i| sval(Some(i)))).collect())
        .unwrap_or_default();
    let lists: Vec<Option<Value>> = if ids.is_empty() {
        vec![c.workspace_list(None).ok()]
    } else {
        ids.iter().map(|i| c.workspace_list(Some(i)).ok()).collect()
    };
    if lists.iter().any(|d| !matches!(d, Some(Value::Object(_)))) {
        return None;
    }
    let (mut out, mut seen) = (Vec::new(), Vec::<String>::new());
    for d in lists.into_iter().flatten() {
        for w in d.get("workspaces").and_then(Value::as_array).into_iter().flatten() {
            let wid = {
                let id = sval(w.get("id"));
                if id.is_empty() { sval(w.get("ref")) } else { id }
            };
            if wid.is_empty() || seen.contains(&wid) {
                continue;
            }
            seen.push(wid.clone());
            let r = sval(w.get("ref"));
            out.push(Ws {
                r#ref: if r.is_empty() { wid.clone() } else { r },
                id: wid,
                title: sval(w.get("title")).trim().to_string(),
                cwd: sval(w.get("current_directory")),
                color: sval(w.get("custom_color")),
                description: sval(w.get("description")),
                selected: !is_falsy(w.get("selected").unwrap_or(&Value::Null)),
                window: sval(d.get("window_ref")),
                last_message: sval(w.get("latest_conversation_message")),
            });
        }
    }
    Some(out)
}

/// The saved agent session records, or None when sessions list did not answer.
pub fn agent_sessions() -> Option<Vec<Value>> {
    let d = cmux()?.sessions_list().ok()?;
    let rows = if d.is_object() { d.get("sessions").cloned().unwrap_or(Value::Null) } else { d };
    rows.as_array().map(|a| a.iter().filter(|r| r.is_object()).cloned().collect())
}

fn field<'a>(r: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().filter_map(|n| r.get(*n)).find(|v| !v.is_null() && v.as_str() != Some(""))
}

fn ws_of(r: &Value) -> Option<&Value> {
    field(r, &["workspace_id", "workspaceId", "workspace"])
}

fn sid_of(r: &Value) -> Option<&Value> {
    field(r, &["session_id", "sessionId", "id"])
}

fn stamp(r: &Value) -> f64 {
    match field(r, &["updated_at_unix", "updatedAtUnix"]) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        Some(Value::Bool(b)) => *b as u8 as f64,
        _ => 0.0,
    }
}

/// Anything but a known quiet lifecycle is mid-turn, unless its pid is gone.
fn mid_turn(r: &Value) -> bool {
    if r.get("stored_pid_exists") == Some(&Value::Bool(false)) {
        return false;
    }
    let life = match field(r, &["agent_lifecycle", "agentLifecycle", "lifecycle"]) {
        Some(Value::String(s)) => s.to_lowercase(),
        Some(v) if !is_falsy(v) => match v {
            Value::Bool(true) => "true".into(),
            other => other.to_string().to_lowercase(),
        },
        _ => String::new(),
    };
    !QUIET.contains(&life.as_str())
}

/// This workspace's records, the active one first, then newest first.
pub fn sessions_for(id: &str, r#ref: &str, records: &[Value]) -> Vec<Value> {
    let mut mine: Vec<Value> = records
        .iter()
        .filter(|r| ws_of(r).map(|w| w.as_str() == Some(id) || w.as_str() == Some(r#ref)).unwrap_or(false))
        .cloned()
        .collect();
    mine.sort_by(|a, b| {
        let ka = is_falsy(a.get("active_for_workspace").unwrap_or(&Value::Null));
        let kb = is_falsy(b.get("active_for_workspace").unwrap_or(&Value::Null));
        ka.cmp(&kb).then(stamp(b).partial_cmp(&stamp(a)).unwrap_or(std::cmp::Ordering::Equal))
    });
    mine
}

fn is_uuidish(s: &str) -> bool {
    s.chars().count() == 36 && s.matches('-').count() == 4
}

/// running | idle | none | unknown for one workspace, by handle.
pub fn lifecycle(handle: &str) -> &'static str {
    let live = live_workspaces();
    let ws = find_live(handle, live.as_deref());
    if live.is_none() && !is_uuidish(handle) {
        return "unknown";
    }
    let (id, r) = match &ws {
        Some(w) => (w.id.clone(), w.r#ref.clone()),
        None => (handle.to_string(), handle.to_string()),
    };
    lifecycle_of(&id, &r, None)
}

/// lifecycle for a known workspace, with the session records when the caller
/// already read them.
pub fn lifecycle_of(id: &str, r#ref: &str, records: Option<&[Value]>) -> &'static str {
    let owned;
    let records = match records {
        Some(r) => Some(r),
        None => {
            owned = agent_sessions();
            owned.as_deref()
        }
    };
    if let Some(records) = records {
        let mine = sessions_for(id, r#ref, records);
        if mine.is_empty() {
            return "none";
        }
        return if mine.iter().any(mid_turn) { "running" } else { "idle" };
    }
    let handle = if r#ref.is_empty() { id } else { r#ref };
    let Some(Ok(out)) = cmux().map(|c| c.sidebar_state(handle)) else { return "unknown" };
    if out.contains("claude_code=Running") {
        "running"
    } else if out.contains("claude_code=") {
        "idle"
    } else {
        "none"
    }
}

fn ps_bin() -> String {
    env_or("CREW_PS").unwrap_or_else(|| "ps".into())
}

/// What a force-close would kill besides an idle agent: each terminal's
/// foreground job that is not a shell or the agent. None when cmux would not say.
pub fn busy(ws: &str) -> Option<Vec<String>> {
    let tree = cmux()?.tree().ok()?;
    if !tree.is_object() {
        return None;
    }
    let mut ttys = Vec::new();
    for win in tree.get("windows").and_then(Value::as_array).into_iter().flatten() {
        for w in win.get("workspaces").and_then(Value::as_array).into_iter().flatten() {
            if w.get("id").and_then(Value::as_str) != Some(ws) && w.get("ref").and_then(Value::as_str) != Some(ws) {
                continue;
            }
            for p in w.get("panes").and_then(Value::as_array).into_iter().flatten() {
                for s in p.get("surfaces").and_then(Value::as_array).into_iter().flatten() {
                    if s.get("type").and_then(Value::as_str) == Some("terminal") {
                        if let Some(t) = s.get("tty").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                            ttys.push(t.to_string());
                        }
                    }
                }
            }
        }
    }
    let mut names: Vec<String> = Vec::new();
    for tty in ttys {
        let (_, out, _) = py::run(&ps_bin(), &["-o", "pid=,pgid=,tpgid=,comm=", "-t", &tty], Duration::from_secs(5))?;
        for line in splitlines(&out) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 4 || parts[0] != parts[1] || parts[1] != parts[2] {
                continue;
            }
            // split(None, 3): the fourth field is the rest of the line.
            let rest = nth_rest(line, 3).trim();
            let base = rest.rsplit('/').next().unwrap_or(rest);
            let name = base.trim_start_matches('-').to_string();
            if !PROMPT_JOBS.contains(&name.as_str()) && !names.contains(&name) {
                names.push(name);
            }
        }
    }
    Some(names)
}

/// The text after the first `n` whitespace-separated fields.
fn nth_rest(line: &str, n: usize) -> &str {
    let mut s = line.trim_start();
    for _ in 0..n {
        let end = s.find(char::is_whitespace).unwrap_or(s.len());
        s = s[end..].trim_start();
    }
    s
}

/// The live workspace a uuid, ref or cwd names.
pub fn find_live(handle: &str, live: Option<&[Ws]>) -> Option<Ws> {
    let owned;
    let live = match live {
        Some(l) => l,
        None => {
            owned = live_workspaces().unwrap_or_default();
            &owned
        }
    };
    live.iter()
        .find(|w| w.id == handle || w.r#ref == handle)
        .or_else(|| live.iter().find(|w| !w.cwd.is_empty() && w.cwd == handle))
        .cloned()
}

fn last_line(s: &str) -> Option<String> {
    splitlines(s).last().map(|l| l.to_string())
}

/// Force-close a workspace and check it went, refusing one whose directory
/// holds live plan or family work unless a person overrides (guard()).
pub fn close(handle: &str, family_ok: bool) -> (bool, String) {
    let Some(live) = live_workspaces() else {
        return (false, "cmux did not list its workspaces — could not tell what is in it".into());
    };
    if let Some(ws) = find_live(handle, Some(&live)).filter(|w| !w.cwd.is_empty()) {
        let name = if ws.title.is_empty() { ws.r#ref.clone() } else { ws.title.clone() };
        let (ok, why) = guard(&ws.cwd, &name, family_ok);
        if !ok {
            return (false, why);
        }
    }
    close_unguarded(handle)
}

/// close() without the plan guard, for archive, which has asked already:
/// believed only once it is gone from the list (or the list does not answer),
/// within ~1.5 s.
fn close_unguarded(handle: &str) -> (bool, String) {
    let Some(c) = cmux() else { return (false, "cmux unavailable".into()) };
    match c.workspace_close(handle, true) {
        Err(e) => return (false, e.to_string()),
        Ok(out) if !out.ok() => {
            let err = if out.stderr.is_empty() { out.stdout.trim() } else { out.stderr.trim() };
            return (false, last_line(err).filter(|_| !err.is_empty()).unwrap_or_else(|| "close failed".into()));
        }
        Ok(_) => {}
    }
    for _ in 0..6 {
        match live_workspaces() {
            None => return (true, String::new()),
            Some(after) if !after.iter().any(|w| w.id == handle || w.r#ref == handle) => return (true, String::new()),
            _ => std::thread::sleep(Duration::from_millis(250)),
        }
    }
    (false, "it is still open".into())
}

/// Bring a live workspace forward.
pub fn select(ws: &str) -> bool {
    cmux().map(|c| c.workspace_select(ws).is_ok()).unwrap_or(false)
}

// --- git -------------------------------------------------------------------------

fn git(cwd: &str, args: &[&str]) -> (i32, String) {
    let mut a = vec!["-C", cwd];
    a.extend_from_slice(args);
    match py::run("git", &a, Duration::from_secs(10)) {
        Some((rc, out, _)) => (rc, out.trim().to_string()),
        None => (1, String::new()),
    }
}

pub fn branch(cwd: &str) -> String {
    let (rc, out) = git(cwd, &["branch", "--show-current"]);
    if rc == 0 { out } else { String::new() }
}

/// origin/HEAD, else origin/main or origin/master, else None.
pub fn default_base(cwd: &str) -> Option<String> {
    let (rc, out) = git(cwd, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if rc == 0 && !out.is_empty() {
        return Some(out);
    }
    ["origin/main", "origin/master"]
        .into_iter()
        .find(|b| git(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/{b}")]).0 == 0)
        .map(String::from)
}

/// True when cwd's branch is fully contained in its default branch and ever
/// held work (it moved after it was created, or was pushed under its name).
pub fn merged(cwd: &str) -> bool {
    let b = branch(cwd);
    if b.is_empty() || b == "main" || b == "master" {
        return false;
    }
    let Some(base) = default_base(cwd) else { return false };
    if git(cwd, &["merge-base", "--is-ancestor", "HEAD", &base]).0 != 0 {
        return false;
    }
    let (rc, log) = git(cwd, &["reflog", "show", "--format=%H", &format!("refs/heads/{b}")]);
    let moved = rc == 0 && splitlines(&log).len() > 1;
    let pushed = git(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/origin/{b}")]).0 == 0;
    moved || pushed
}

/// sweep.dormant_days from integrations.json, at least 1, default 5.
pub fn dormant_days() -> i64 {
    let v: Option<Value> = std::fs::read_to_string(integrations()).ok().and_then(|t| serde_json::from_str(&t).ok());
    let Some(v) = v.filter(Value::is_object) else { return DORMANT_DEFAULT };
    let sweep = v.get("sweep").filter(|s| !is_falsy(s)).cloned().unwrap_or_else(|| json!({}));
    if !sweep.is_object() {
        return DORMANT_DEFAULT;
    }
    let n = match sweep.get("dormant_days") {
        None => Some(DORMANT_DEFAULT),
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f.trunc() as i64)),
        Some(Value::Bool(b)) => Some(*b as i64),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    };
    n.map(|n| n.max(1)).unwrap_or(DORMANT_DEFAULT)
}

// --- the transcript index --------------------------------------------------------

fn records(chunk: &str) -> Vec<Map<String, Value>> {
    splitlines(chunk)
        .into_iter()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| match v {
            Value::Object(o) => Some(o),
            _ => None,
        })
        .collect()
}

/// A content block's text: the string, or the first text block of a list.
fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .map(|b| b.get("text").and_then(Value::as_str).unwrap_or("").to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn truthy(v: Option<&Value>) -> bool {
    v.map(|x| !is_falsy(x)).unwrap_or(false)
}

/// A session summary from one transcript: a slice from each end, since the
/// fields sit at the two ends of files that run to tens of megabytes.
pub fn scan(path: &Path) -> Option<Map<String, Value>> {
    use std::io::{Seek, SeekFrom};
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    let mut f = std::fs::File::open(path).ok()?;
    let (head, tail) = if size > HEAD_BYTES + TAIL_BYTES {
        let mut head = vec![0u8; HEAD_BYTES as usize];
        f.read_exact(&mut head).ok()?;
        f.seek(SeekFrom::End(-(TAIL_BYTES as i64))).ok()?;
        let mut tail = Vec::new();
        f.read_to_end(&mut tail).ok()?;
        (head, tail)
    } else {
        let mut tail = Vec::new();
        f.read_to_end(&mut tail).ok()?;
        (tail[..tail.len().min(HEAD_BYTES as usize)].to_vec(), tail)
    };
    let head = String::from_utf8_lossy(&head).into_owned();
    let tail = String::from_utf8_lossy(&tail).into_owned();
    let name = path.file_name()?.to_string_lossy().into_owned();
    let id: String = name.chars().take(name.chars().count().saturating_sub(6)).collect();
    let mut info = Map::new();
    for (k, v) in [
        ("id", json!(id)), ("path", json!(path.display().to_string())), ("cwd", json!("")), ("branch", json!("")),
        ("title", json!("")), ("prompt", json!("")), ("started", json!("")), ("turns", json!(0)), ("v", json!(INDEX_V)),
    ] {
        info.insert(k.into(), v);
    }
    for rec in records(&head) {
        if !truthy(info.get("cwd")) && truthy(rec.get("cwd")) {
            info.insert("cwd".into(), rec["cwd"].clone());
            info.insert("branch".into(), rec.get("gitBranch").filter(|v| !is_falsy(v)).cloned().unwrap_or(json!("")));
            info.insert("started".into(), rec.get("timestamp").filter(|v| !is_falsy(v)).cloned().unwrap_or(json!("")));
        }
        if !truthy(info.get("prompt")) && rec.get("type").and_then(Value::as_str) == Some("user") {
            info.insert("prompt".into(), json!(text_of(rec.get("message").and_then(|m| m.get("content")))));
        }
        if truthy(info.get("cwd")) && truthy(info.get("prompt")) {
            break;
        }
    }
    for chunk in [&tail, &head] {
        for rec in records(chunk) {
            let ty = rec.get("type").and_then(Value::as_str);
            if ty == Some("ai-title") && truthy(rec.get("aiTitle")) {
                info.insert("title".into(), rec["aiTitle"].clone());
            } else if ty == Some("last-prompt") && truthy(rec.get("lastPrompt")) {
                info.insert("last".into(), rec["lastPrompt"].clone());
            }
        }
        if truthy(info.get("title")) {
            break;
        }
    }
    for rec in records(&tail) {
        if rec.get("type").and_then(Value::as_str) == Some("assistant") {
            let said = text_of(rec.get("message").and_then(|m| m.get("content")));
            if !said.is_empty() {
                let chars: Vec<char> = said.chars().collect();
                info.insert("said".into(), json!(chars[chars.len().saturating_sub(600)..].iter().collect::<String>()));
            }
        }
    }
    info.insert("mtime".into(), pyjson::float(py::mtime(&meta)));
    info.insert("size".into(), json!(size));
    Some(info)
}

/// os.walk order: a directory's files in listing order, then each subdirectory.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut dirs = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        let is_dir = std::fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false);
        let is_link = e.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        if is_dir {
            if e.file_name() != "subagents" && !is_link {
                dirs.push(p);
            }
        } else if e.file_name().to_string_lossy().ends_with(".jsonl") {
            out.push(p);
        }
    }
    for d in dirs {
        walk(&d, out);
    }
}

/// Every transcript's summary, re-scanning only what changed. -> (rows, seen)
pub fn build_index(force: bool) -> (Vec<Value>, usize) {
    let cache: Map<String, Value> = if force {
        Map::new()
    } else {
        std::fs::read_to_string(index_path())
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    };
    let mut paths = Vec::new();
    walk(&projects(), &mut paths);
    let (mut out, mut seen) = (Map::new(), 0usize);
    for path in paths {
        seen += 1;
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let key = path.display().to_string();
        if let Some(prev) = cache.get(&key) {
            if prev.get("mtime").and_then(Value::as_f64) == Some(py::mtime(&meta))
                && prev.get("size").and_then(Value::as_u64) == Some(meta.len())
                && prev.get("v").and_then(Value::as_i64) == Some(INDEX_V)
            {
                out.insert(key, prev.clone());
                continue;
            }
        }
        if let Some(info) = scan(&path) {
            out.insert(key, Value::Object(info));
        }
    }
    let _ = write_json(&index_path(), &Value::Object(out.clone()));
    (out.into_iter().map(|(_, v)| v).collect(), seen)
}

/// A session's display label: its title, else its first prompt, whitespace folded.
pub fn label(s: &Value) -> String {
    let t = [s.get("title"), s.get("prompt")]
        .into_iter()
        .flatten()
        .find(|v| !is_falsy(v))
        .map(|v| sval(Some(v)))
        .unwrap_or_else(|| "(no prompt)".into());
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- the plan guard: deep-plan protects ------------------------------------------

/// Short: the board chip asks from inside a hook cmux kills at 10 s.
const PROTECTS_TIMEOUT: Duration = Duration::from_secs(4);
static MISSING_SAID: AtomicBool = AtomicBool::new(false);

/// deep-plan's word on a directory, as workspaces.py's protects() returns it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Protection {
    /// Refuse to close it.
    pub protected: bool,
    /// deep-plan's reason, naming the plan and the family, or what went wrong.
    pub why: String,
    pub plan: String,
    /// The family's parent, "" when none.
    pub family: String,
    pub phase: String,
    /// deep-plan was there and did not answer: protected, so refused.
    pub error: bool,
    /// There is no deep-plan: not protected.
    pub missing: bool,
}

impl Protection {
    pub fn json(&self) -> Value {
        let mut m = json!({"protected": self.protected, "why": self.why, "plan": self.plan,
                           "family": self.family, "phase": self.phase});
        if self.error {
            m["error"] = json!(true);
        }
        if self.missing {
            m["missing"] = json!(true);
        }
        m
    }

    fn err(why: String) -> Protection {
        Protection { protected: true, why, error: true, ..Default::default() }
    }
}

fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// The deep-plan argv: CREW_DEEP_PLAN split on whitespace (as workspaces.py and
/// crew-reclaim split it), else deep-plan on PATH, else the ~/.local/bin shim.
fn deep_plan_argv() -> Option<Vec<String>> {
    if let Some(o) = env_or("CREW_DEEP_PLAN") {
        let words: Vec<String> = o.split_whitespace().map(String::from).collect();
        if !words.is_empty() {
            return Some(words);
        }
    }
    let on_path = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join("deep-plan"))
        .find(|c| executable(c));
    on_path
        .or_else(|| Some(home().join(".local/bin/deep-plan")).filter(|c| executable(c)))
        .map(|c| vec![c.to_string_lossy().into_owned()])
}

/// Whether argv[0] names something that can be run at all.
fn runnable(prog: &str) -> bool {
    if prog.contains('/') {
        return executable(Path::new(prog));
    }
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| executable(&d.join(prog))))
        .unwrap_or(false)
}

fn missing() -> Protection {
    if !MISSING_SAID.swap(true, Ordering::SeqCst) {
        eprintln!("crew: deep-plan is not installed — closing without its plan guard");
    }
    Protection { missing: true, ..Default::default() }
}

/// deep-plan's word on a directory (see Protection). A directory that does not
/// exist holds nothing to protect.
pub fn protects(cwd: &str) -> Protection {
    if cwd.is_empty() || !Path::new(cwd).is_dir() {
        return Protection::default();
    }
    let Some(argv) = deep_plan_argv() else { return missing() };
    if !runnable(&argv[0]) {
        return missing();
    }
    let mut args: Vec<&str> = argv[1..].iter().map(String::as_str).collect();
    args.extend(["protects", cwd, "--json"]);
    let Some((rc, out, err)) = py::run(&argv[0], &args, PROTECTS_TIMEOUT) else {
        return Protection::err(format!("deep-plan did not answer (no answer within {}s)", PROTECTS_TIMEOUT.as_secs()));
    };
    if rc == 127 {
        return missing(); // the shim, with no engine behind it
    }
    if rc != 0 {
        let tail = splitlines(err.trim()).last().map(|l| l.to_string()).unwrap_or_else(|| format!("exit {rc}"));
        return Protection::err(format!("deep-plan protects failed: {tail}"));
    }
    let d: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    let Some(protected) = d.get("protected").and_then(Value::as_bool) else {
        return Protection::err("deep-plan protects gave an answer crew could not read".into());
    };
    let text = |v: Option<&Value>| match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => sval(Some(other)),
    };
    Protection {
        protected,
        why: text(d.get("why")),
        plan: text(d.get("plan")),
        family: text(d.get("family").and_then(|f| f.get("parent"))),
        phase: text(d.get("phase")),
        error: false,
        missing: false,
    }
}

/// The one sentence a refused close says, on a terminal and in a toast.
pub fn refusal(name: &str, p: &Protection) -> String {
    if p.error {
        format!("{name}: could not ask deep-plan whether live work is here ({}) — not closed", p.why)
    } else {
        format!("{name} holds live work: {} — not closed", p.why)
    }
}

/// May the workspace at cwd be closed? -> (ok, why). A protected directory is
/// refused; family_ok is a person's override: a terminal on stdin and stderr,
/// a y/N naming the family, and the yes logged. The board's chips never pass it.
pub fn guard(cwd: &str, name: &str, family_ok: bool) -> (bool, String) {
    let p = protects(cwd);
    if !p.protected {
        return (true, String::new());
    }
    let msg = refusal(name, &p);
    if !family_ok {
        return (false, msg);
    }
    // SAFETY: isatty only inspects the descriptor.
    if unsafe { libc::isatty(0) != 1 || libc::isatty(2) != 1 } {
        return (false, format!("{msg}; --family-ok needs a person at a terminal"));
    }
    let what = if !p.family.is_empty() {
        format!("The {} family is not done", p.family)
    } else if !p.plan.is_empty() {
        format!("Plan {} is live there", p.plan)
    } else {
        "Deep-plan could not say".to_string()
    };
    eprint!("{msg}\nClose {name} anyway? {what}. [y/N] ");
    let _ = std::io::stderr().flush();
    let mut ans = String::new();
    let _ = std::io::stdin().lock().read_line(&mut ans);
    if !matches!(ans.trim().to_lowercase().as_str(), "y" | "yes") {
        return (false, format!("{name}: kept — nothing was closed"));
    }
    let by = std::env::args().next().map(|a| Path::new(&a).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(a)).unwrap_or_default();
    let entry = json!({"at": pyjson::float(py::now()), "cwd": cwd, "workspace": name, "plan": p.plan,
                       "family": p.family, "why": p.why, "by": by});
    let log = xdg_cache().join("family-ok.log");
    let wrote = std::fs::create_dir_all(xdg_cache()).and_then(|_| {
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&log)?;
        f.write_all(format!("{}\n", serde_json::to_string(&entry).unwrap_or_default()).as_bytes())
    });
    if let Err(e) = wrote {
        // An override nobody can find later is not one.
        return (false, format!("{name}: could not log the override ({e}) — nothing was closed"));
    }
    (true, String::new())
}

// --- the archive store -----------------------------------------------------------

fn write_json(path: &Path, data: &Value) -> std::io::Result<()> {
    py::write_atomic(path, pyjson::dumps(data).as_bytes())
}

/// {cwd: record}. A missing or unreadable file is an empty archive.
pub fn load_archive() -> Map<String, Value> {
    std::fs::read_to_string(archive_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|d| d.get("records").and_then(Value::as_object).cloned())
        .map(|r| r.into_iter().filter(|(_, v)| v.is_object()).collect())
        .unwrap_or_default()
}

/// Read-modify-write the archive under an flock on a sidecar file.
pub fn update<T>(f: impl FnOnce(&mut Map<String, Value>) -> T) -> std::io::Result<T> {
    let path = archive_path();
    let _lock = Flock::exclusive(Path::new(&format!("{}.lock", path.display())))?;
    let mut recs = load_archive();
    let out = f(&mut recs);
    write_json(&path, &json!({"version": 1, "records": recs}))?;
    Ok(out)
}

/// Close a live workspace and remember it. -> (ok, message)
/// family_ok is a person's override of the plan guard (guard()).
pub fn archive(handle: &str, family_ok: bool) -> (bool, String) {
    archive_with(handle, None, None, Guard::Ask { family_ok })
}

/// How archive_with treats the plan guard.
#[derive(Clone, Copy, Debug)]
pub enum Guard {
    /// Ask it, last; family_ok is a person's override.
    Ask { family_ok: bool },
    /// The caller asked it already (the board's hook, which times it).
    Asked,
}

/// archive(), with the live list and the session records when the caller
/// already has them, as workspaces.py's archive(handle, live, records) takes
/// them: triage times its own list and must not pay for a second one. None
/// fetches each, as archive() does; a passed list is used as is.
pub fn archive_with(handle: &str, live: Option<&[Ws]>, records: Option<&[Value]>, plan_guard: Guard) -> (bool, String) {
    let fetched;
    let live = match live {
        Some(l) => l,
        None => match live_workspaces() {
            Some(l) => {
                fetched = l;
                &fetched[..]
            }
            None => return (false, "cmux did not list its workspaces".into()),
        },
    };
    let Some(ws) = find_live(handle, Some(live)) else { return (false, format!("no open workspace {handle}")) };
    let fetched_records;
    let records = match records {
        Some(r) => Some(r),
        None => {
            fetched_records = agent_sessions();
            fetched_records.as_deref()
        }
    };
    let life = lifecycle_of(&ws.id, &ws.r#ref, records);
    let name = if ws.title.is_empty() { ws.r#ref.clone() } else { ws.title.clone() };
    if life == "running" {
        return (false, format!("{name}: Claude is mid-turn — archive it when the turn ends"));
    }
    if life == "unknown" {
        return (false, format!("{name}: could not tell whether Claude is mid-turn"));
    }
    match busy(&ws.id) {
        None => return (false, format!("{name}: could not tell what else is running in it")),
        Some(jobs) if !jobs.is_empty() => {
            return (false, format!("{name}: {} is running in it — stop it, or close the workspace yourself", jobs.join(", ")))
        }
        _ => {}
    }
    let cwd = ws.cwd.clone();
    if cwd.is_empty() {
        return (false, format!("{name} has no directory to remember"));
    }
    // The plan guard last: its override asks a person, after every other check.
    if let Guard::Ask { family_ok } = plan_guard {
        let (ok, why) = guard(&cwd, &name, family_ok);
        if !ok {
            return (false, why);
        }
    }
    let mut sids: Vec<Value> = Vec::new();
    for r in sessions_for(&ws.id, &ws.r#ref, records.unwrap_or(&[])) {
        let Some(s) = sid_of(&r).filter(|s| !is_falsy(s)).cloned() else { continue };
        let agent = r.get("agent").filter(|a| !is_falsy(a)).map(|a| sval(Some(a))).unwrap_or_else(|| "claude".into());
        if !sids.contains(&s) && agent.to_lowercase() == "claude" {
            sids.push(s);
        }
    }
    let mut rec = json!({
        "cwd": cwd,
        "title": ws.title,
        "color": ws.color,
        "branch": if Path::new(&cwd).is_dir() { branch(&cwd) } else { String::new() },
        "session_id": sids.first().cloned().unwrap_or(json!("")),
        "sessions": sids,
        "workspace_id": ws.id,
        "archived_at": pyjson::float(py::now()),
    });
    let before = match update(|recs| {
        let prev = recs.get(&cwd).cloned();
        if let Some(p) = prev.as_ref().filter(|p| !is_falsy(p)) {
            let mut sessions = rec["sessions"].as_array().cloned().unwrap_or_default();
            for x in p.get("sessions").and_then(Value::as_array).into_iter().flatten() {
                if !sessions.contains(x) {
                    sessions.push(x.clone());
                }
            }
            rec["sessions"] = Value::Array(sessions);
            if is_falsy(&rec["session_id"]) {
                rec["session_id"] = p.get("session_id").filter(|s| !is_falsy(s)).cloned().unwrap_or(json!(""));
            }
        }
        recs.insert(cwd.clone(), rec.clone());
        prev
    }) {
        Ok(b) => b,
        Err(e) => return (false, format!("{name}: could not write the archive ({e})")),
    };
    let (ok, why) = close_unguarded(&ws.id);
    if !ok {
        let _ = update(|recs| match &before {
            None => {
                recs.remove(&cwd);
            }
            Some(b) => {
                recs.insert(cwd.clone(), b.clone());
            }
        });
        return (false, format!("{name}: cmux did not close it ({why})"));
    }
    (true, format!("archived {name}"))
}

/// Reopen an archived cwd as it was, resuming its Claude. -> (ok, message)
pub fn restore(cwd: &str) -> (bool, String) {
    let Some(rec) = load_archive().get(cwd).cloned().filter(|r| !is_falsy(r)) else {
        return (false, format!("nothing archived at {cwd}"));
    };
    if !Path::new(cwd).is_dir() {
        return (false, format!("{cwd} no longer exists — forget the record instead"));
    }
    let sid = sval(rec.get("session_id"));
    let cmd = if sid.is_empty() { "claude".to_string() } else { format!("claude --resume {sid}") };
    let title = sval(rec.get("title"));
    let Some(c) = cmux() else { return (false, format!("cmux did not open {cwd} (?)")) };
    let out = match c.workspace_create(if title.is_empty() { None } else { Some(&title) }, cwd, &cmd, true) {
        Ok(o) => o,
        Err(e) => return (false, format!("cmux did not open {cwd} ({e})")),
    };
    if !out.ok() {
        let err = if out.stderr.is_empty() { out.stdout.trim() } else { out.stderr.trim() };
        let why = if err.is_empty() { "?".to_string() } else { last_line(err).unwrap_or_default() };
        return (false, format!("cmux did not open {cwd} ({why})"));
    }
    let r = out.stdout.split_whitespace().find(|t| t.starts_with("workspace:")).unwrap_or("").to_string();
    let color = sval(rec.get("color"));
    if !r.is_empty() && !color.is_empty() {
        let _ = c.workspace_action(&r, &cmux::WorkspaceAction::SetColor(color));
    }
    let _ = update(|recs| recs.remove(cwd));
    let shown = if title.is_empty() { cwd.to_string() } else { title };
    (true, format!("restored {shown}{}", if r.is_empty() { String::new() } else { format!(" in {r}") }))
}

/// Drop an archive record. -> true when there was one.
pub fn forget(cwd: &str) -> bool {
    update(|recs| recs.remove(cwd)).ok().flatten().is_some()
}

const DOC: &str = "crew — where workspaces are: live, archived, past or gone. One reader.

    workspaces.py lifecycle <workspace>   running | idle | none | unknown
    workspaces.py close <workspace> [--family-ok]
                                          force-close and check it went; exit 1 if not
    workspaces.py archive <workspace> [--family-ok]
                                          close it and remember it; exit 1 on refusal
    workspaces.py protects <dir>          deep-plan's word on a directory, as JSON;
                                          exit 1 when it may not be closed
    workspaces.py restore <cwd>           reopen an archived cwd, resuming its Claude
    workspaces.py forget <cwd>            drop an archive record
    workspaces.py dormant-days            the sweep's threshold, default 5
    workspaces.py list-json               every window's workspaces, in `workspace list
                                          --json`'s field names; exit 1 if cmux is silent
";

pub fn main(args: &[String]) -> i32 {
    let family_ok = args.iter().any(|a| a == "--family-ok");
    let args: Vec<&String> = args.iter().filter(|a| *a != "--family-ok").collect();
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("");
    let arg = args.get(1).map(|s| s.as_str()).unwrap_or("");
    match (cmd, arg.is_empty()) {
        ("protects", false) => {
            let p = protects(arg);
            println!("{}", pyjson::dumps(&p.json()));
            if p.protected { 1 } else { 0 }
        }
        ("lifecycle", false) => {
            println!("{}", lifecycle(arg));
            0
        }
        ("close", false) => {
            let (ok, why) = close(arg, family_ok);
            if !ok {
                eprintln!("{why}");
            }
            if ok { 0 } else { 1 }
        }
        ("list-json", _) => {
            let Some(live) = live_workspaces() else { return 1 };
            let rows: Vec<Value> = live
                .iter()
                .map(|w| json!({"id": w.id, "ref": w.r#ref, "title": w.title,
                               "current_directory": w.cwd, "description": w.description}))
                .collect();
            print!("{}", pyjson::dumps(&json!({"workspaces": rows})));
            0
        }
        ("dormant-days", _) => {
            println!("{}", dormant_days());
            0
        }
        ("archive", false) | ("restore", false) => {
            let (ok, msg) = if cmd == "archive" { archive(arg, family_ok) } else { restore(arg) };
            if ok {
                println!("{msg}");
                0
            } else {
                eprintln!("{msg}");
                1
            }
        }
        ("forget", false) => {
            if forget(arg) { 0 } else { 1 }
        }
        // ---- Rust-only, for the probe shim ----
        ("scan", false) => {
            println!("{}", pyjson::dumps(&scan(Path::new(arg)).map(Value::Object).unwrap_or(Value::Null)));
            0
        }
        ("index", _) => {
            let (rows, seen) = build_index(arg == "--force");
            println!("{}", pyjson::dumps(&json!({"rows": rows, "seen": seen})));
            0
        }
        ("live", _) => {
            let v = live_workspaces().map(|l| Value::Array(l.iter().map(Ws::json).collect())).unwrap_or(Value::Null);
            println!("{}", pyjson::dumps(&v));
            0
        }
        ("busy", false) => {
            println!("{}", pyjson::dumps(&busy(arg).map(|b| json!(b)).unwrap_or(Value::Null)));
            0
        }
        ("merged", false) => {
            if merged(arg) { 0 } else { 1 }
        }
        ("load-archive", _) => {
            println!("{}", pyjson::dumps(&Value::Object(load_archive())));
            0
        }
        ("update-archive", _) => {
            let mut input = String::new();
            let _ = std::io::stdin().read_to_string(&mut input);
            let ops: Value = match serde_json::from_str(&input) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("workspaces: {e}");
                    return 2;
                }
            };
            let res = update(|recs| {
                for cwd in ops.get("pop").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(c) = cwd.as_str() {
                        recs.remove(c);
                    }
                }
                for (cwd, rec) in ops.get("set").and_then(Value::as_object).into_iter().flatten() {
                    recs.insert(cwd.clone(), rec.clone());
                }
            });
            if res.is_ok() { 0 } else { 1 }
        }
        _ => {
            eprint!("{DOC}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mid_turn_reads_every_spelling() {
        assert!(mid_turn(&json!({"agent_lifecycle": "running"})));
        assert!(mid_turn(&json!({"lifecycle": "needsInput"})));
        assert!(!mid_turn(&json!({"agentLifecycle": "Idle"})));
        assert!(!mid_turn(&json!({"agent_lifecycle": "running", "stored_pid_exists": false})));
    }

    #[test]
    fn sessions_sort_active_then_newest() {
        let recs = vec![
            json!({"workspace_id": "w", "session_id": "old", "active_for_workspace": false, "updated_at_unix": 1}),
            json!({"workspace_id": "w", "session_id": "new", "active_for_workspace": true, "updated_at_unix": 2}),
            json!({"workspace_id": "w", "session_id": "mid", "active_for_workspace": false, "updated_at_unix": 3}),
            json!({"workspace_id": "x", "session_id": "other"}),
        ];
        let ids: Vec<String> = sessions_for("w", "workspace:1", &recs).iter().map(|r| sval(r.get("session_id"))).collect();
        assert_eq!(ids, vec!["new", "mid", "old"]);
    }

    #[test]
    fn ps_line_rest() {
        assert_eq!(nth_rest("  30 30 30 /opt/bin/claude code", 3), "/opt/bin/claude code");
    }

    #[test]
    fn labels_fold_whitespace() {
        assert_eq!(label(&json!({"title": "", "prompt": "build\n  the thing"})), "build the thing");
        assert_eq!(label(&json!({})), "(no prompt)");
    }
}
