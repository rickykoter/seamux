//! The adapter host: finds adapters, gives each the session's context, and
//! reads back `seamux.run/1` documents (docs/RUNS.md).
//!
//! An adapter is either built in (the two Claude Code ones) or a command: a
//! folder under ~/.config/seamux/adapters (SEAMUX_ADAPTERS_DIR) holding an
//! `adapter.json` manifest and a program in any language. The host writes
//! the context to the program's stdin as JSON, waits up to its timeout, and
//! validates what it prints, exactly as it validates a built-in's output.
//! A result is cached until a file under the session's folder or the
//! adapter's own folder changes, so a board that asks every few seconds runs
//! nothing while a run is quiet.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::{json, Value};

use super::model::{parse_document, Doc, Run, SCHEMA};
use crate::status::Background;

pub const MANIFEST: &str = "adapter.json";
pub const MANIFEST_SCHEMA: &str = "seamux.adapter/1";
pub const CONTEXT_SCHEMA: &str = "seamux.context/1";
pub const TIMEOUT_DEFAULT_MS: u64 = 3_000;
pub const TIMEOUT_MAX_MS: u64 = 10_000;
/// More output than this is an adapter gone wrong.
pub const OUTPUT_MAX: usize = 4 * 1024 * 1024;
/// The file walk behind the cache key stops here: a session folder is far
/// smaller, and a stamp over the first files still notices a change.
const WALK_MAX: usize = 20_000;

/// What an adapter is told about the session.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Context {
    pub session: String,
    /// Claude Code's folder for the session: ~/.claude/projects/<project>/<session>.
    pub session_dir: PathBuf,
    pub transcript: Option<PathBuf>,
    pub cwd: String,
    /// The pane's background list (crew_core::status).
    pub background: Vec<Background>,
}

impl Context {
    pub fn to_json(&self) -> Value {
        json!({
            "schema": CONTEXT_SCHEMA,
            "session": self.session,
            "sessionDir": self.session_dir.display().to_string(),
            "transcript": self.transcript.as_ref().map(|t| t.display().to_string()),
            "cwd": self.cwd,
            "background": self.background.iter().map(Background::to_json).collect::<Vec<_>>(),
        })
    }
}

/// A command adapter's manifest.
#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub name: String,
    pub dir: PathBuf,
    /// The background task types it reads (Claude Code's background_tasks
    /// type: subagent, workflow, teammate...).
    pub recognizes: Vec<String>,
    /// The program and its arguments, run in `dir`.
    pub command: Vec<String>,
    pub timeout_ms: u64,
    /// Folders outside the session's whose changes it reads (its `watch`:
    /// `~/…` paths, or `$NAME` for an environment variable's folder, skipped
    /// when unset). The cache's key covers them too.
    pub watch: Vec<PathBuf>,
}

/// A manifest's `watch` entries as folders: `~/x` under the home folder,
/// `$NAME` the variable's value when set, an absolute path as itself.
pub fn watch_dirs(entries: &[String]) -> Vec<PathBuf> {
    entries.iter().filter_map(|e| {
        if let Some(name) = e.strip_prefix('$') {
            crate::py::env_or(name).filter(|v| v.starts_with('/')).map(PathBuf::from)
        } else if let Some(rest) = e.strip_prefix("~/") {
            Some(crate::py::home().join(rest))
        } else {
            e.starts_with('/').then(|| PathBuf::from(e))
        }
    }).take(8).collect()
}

/// Something the person should hear about: background work no adapter reads,
/// or an adapter that failed.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    /// "missing" or "failed".
    pub kind: String,
    pub adapter: Option<String>,
    pub task_type: Option<String>,
    /// How many background tasks it covers.
    pub count: usize,
    pub why: String,
}

impl Notice {
    pub fn to_json(&self) -> Value {
        json!({"kind": self.kind, "adapter": self.adapter, "taskType": self.task_type, "count": self.count, "why": self.why})
    }

    /// The line a card or the run page shows.
    pub fn text(&self) -> String {
        match (self.kind.as_str(), &self.adapter) {
            ("failed", Some(a)) => format!("adapter {a} failed: {}", self.why),
            _ => {
                let what = self.task_type.as_deref().unwrap_or("an unknown type");
                let n = self.count;
                format!("{n} background task{} from {what}: no adapter", if n == 1 { "" } else { "s" })
            }
        }
    }
}

pub type BuiltinFn = fn(&Context) -> Value;

#[derive(Clone)]
pub enum Adapter {
    /// `watch`: the folders under the session's folder its files live in,
    /// the cache's key.
    Builtin { name: &'static str, recognizes: &'static [&'static str], watch: &'static [&'static str], run: BuiltinFn },
    Command(Manifest),
}

impl Adapter {
    pub fn name(&self) -> &str {
        match self {
            Adapter::Builtin { name, .. } => name,
            Adapter::Command(m) => &m.name,
        }
    }

    pub fn recognizes(&self, kind: &str) -> bool {
        match self {
            Adapter::Builtin { recognizes, .. } => recognizes.contains(&kind),
            Adapter::Command(m) => m.recognizes.iter().any(|r| r == kind),
        }
    }
}

/// What every adapter said about one session.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub runs: Vec<Run>,
    pub notices: Vec<Notice>,
    /// Each adapter's line about the session, as (adapter, text).
    pub summaries: Vec<(String, String)>,
}

impl Report {
    pub fn to_json(&self) -> Value {
        json!({
            "schema": SCHEMA,
            "runs": self.runs.iter().map(Run::to_json).collect::<Vec<_>>(),
            "notices": self.notices.iter().map(Notice::to_json).collect::<Vec<_>>(),
            "summaries": self.summaries.iter().map(|(a, t)| json!({"source": a, "text": t})).collect::<Vec<_>>(),
        })
    }
}

pub fn adapters_dir() -> PathBuf {
    crate::py::env_or("SEAMUX_ADAPTERS_DIR").map(PathBuf::from)
        .unwrap_or_else(|| crate::py::home().join(".config/seamux/adapters"))
}

/// Read one manifest.
pub fn manifest_of(dir: &Path) -> Result<Manifest, String> {
    let text = std::fs::read_to_string(dir.join(MANIFEST)).map_err(|e| format!("{MANIFEST}: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("{MANIFEST}: {e}"))?;
    if v.get("schema").and_then(Value::as_str) != Some(MANIFEST_SCHEMA) {
        return Err(format!("{MANIFEST}: schema must be {MANIFEST_SCHEMA:?}"));
    }
    let strs = |k: &str| -> Vec<String> {
        v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    };
    let name = v.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty())
        .ok_or_else(|| format!("{MANIFEST}: name missing"))?.to_string();
    let command = strs("command");
    if command.is_empty() {
        return Err(format!("{MANIFEST}: command must be a non-empty list"));
    }
    let recognizes = strs("recognizes");
    if recognizes.is_empty() {
        return Err(format!("{MANIFEST}: recognizes must name at least one task type"));
    }
    let timeout_ms = v.get("timeoutMs").and_then(Value::as_u64).unwrap_or(TIMEOUT_DEFAULT_MS).clamp(100, TIMEOUT_MAX_MS);
    let watch = watch_dirs(&strs("watch"));
    Ok(Manifest { name, dir: dir.to_path_buf(), recognizes, command, timeout_ms, watch })
}

/// The command adapters in `dir`, and a notice for each folder whose
/// manifest cannot be read.
pub fn load(dir: &Path) -> (Vec<Adapter>, Vec<Notice>) {
    let mut out = Vec::new();
    let mut notices = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return (out, notices) };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.join(MANIFEST).is_file()).collect();
    dirs.sort();
    let taken: Vec<String> = super::builtins().iter().map(|a| a.name().to_string()).collect();
    for d in dirs {
        match manifest_of(&d) {
            Ok(m) if taken.contains(&m.name) || out.iter().any(|a: &Adapter| a.name() == m.name) => notices.push(Notice {
                kind: "failed".into(),
                adapter: Some(m.name.clone()),
                task_type: None,
                count: 0,
                why: format!("another adapter is already named {:?} ({})", m.name, d.display()),
            }),
            Ok(m) => out.push(Adapter::Command(m)),
            Err(why) => notices.push(Notice {
                kind: "failed".into(),
                adapter: d.file_name().map(|n| n.to_string_lossy().into_owned()),
                task_type: None,
                count: 0,
                why,
            }),
        }
    }
    (out, notices)
}

/// The command adapters crew ships (crew/adapters, in crew's live tree):
/// every folder but the template.
pub fn bundled_dir() -> PathBuf {
    crate::crew_home().join("adapters")
}

/// The built-ins first, then crew's bundled command adapters, then the
/// person's own in adapters_dir(). A person's adapter with a bundled one's
/// name takes its place.
pub fn adapters() -> (Vec<Adapter>, Vec<Notice>) {
    let mut all = super::builtins();
    let (mine, mut notices) = load(&adapters_dir());
    let (bundled, bad) = load(&bundled_dir());
    notices.extend(bad);
    all.extend(bundled.into_iter().filter(|b| b.name() != "template" && !mine.iter().any(|m| m.name() == b.name())));
    all.extend(mine);
    (all, notices)
}

/// Run a command adapter: the context on stdin, its document on stdout.
pub fn run_command(m: &Manifest, ctx: &Context) -> Result<Value, String> {
    use std::os::unix::process::CommandExt;
    // Its own process group, so a timeout ends whatever it started too.
    let mut child = Command::new(&m.command[0])
        .args(&m.command[1..])
        .process_group(0)
        .current_dir(&m.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {:?}: {e}", m.command[0]))?;
    let input = ctx.to_json().to_string();
    let mut stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        if let Some(s) = stdin.as_mut() {
            let _ = s.write_all(input.as_bytes());
        }
    });
    // Each pipe is drained to its end, keeping at most OUTPUT_MAX + 1 bytes,
    // so a chatty adapter never blocks on a full pipe. The bytes come back
    // over a channel: a program the adapter left behind can hold a pipe open
    // past its exit, and the host stops waiting for it at the deadline.
    let read_all = |r: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let mut chunk = [0u8; 64 * 1024];
                while let Ok(n) = r.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    let room = (OUTPUT_MAX + 1).saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
            let _ = tx.send(buf);
        });
        rx
    };
    let out = read_all(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = read_all(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + Duration::from_millis(m.timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= deadline => {
                kill_group(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {} ms", m.timeout_ms));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    };
    let _ = writer.join();
    let left = || deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
    let Ok(stdout) = out.recv_timeout(left()) else {
        kill_group(child.id());
        return Err("exited, but something it started kept its output open".into());
    };
    let stderr = err.recv_timeout(left()).unwrap_or_else(|_| {
        kill_group(child.id());
        Vec::new()
    });
    if !status.success() {
        let line = String::from_utf8_lossy(&stderr).lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into());
        return Err(if line.is_empty() { format!("exited with {code}") } else { format!("exited with {code}: {line}") });
    }
    if stdout.len() > OUTPUT_MAX {
        return Err(format!("printed more than {OUTPUT_MAX} bytes"));
    }
    serde_json::from_slice(&stdout).map_err(|e| format!("printed no JSON document: {e}"))
}

/// End an adapter's process group: the adapter and everything it started.
fn kill_group(pid: u32) {
    // SAFETY: kill(2) with a negative pid signals that process group; the
    // group is the adapter's own (process_group(0) above), never ours.
    unsafe {
        libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

/// The newest modification time under these folders, in ms: the cache key.
pub fn stamp(dirs: &[&Path]) -> u128 {
    let mut newest = 0u128;
    let mut seen = 0usize;
    let mut stack: Vec<PathBuf> = dirs.iter().map(|d| d.to_path_buf()).collect();
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        if let Ok(m) = std::fs::metadata(&d).and_then(|m| m.modified()) {
            newest = newest.max(m.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
        }
        for e in rd.flatten() {
            seen += 1;
            if seen > WALK_MAX {
                return newest;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                stack.push(e.path());
            } else if let Ok(m) = md.modified() {
                newest = newest.max(m.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
            }
        }
    }
    newest
}

/// A result asked for again this soon is the cache's without a file walk.
pub const FRESH_MS: u128 = 2_000;
/// A result with a run still going is read again after this long even when
/// no file changed: a run nothing writes to turns unknown with time.
pub const RUNNING_MS: u128 = 60_000;
/// A failure is retried after this long even when no file changed.
pub const FAILED_MS: u128 = 30_000;

/// The stamp the result was read at, when it was read, when the stamp was
/// last checked, and the result.
type Cached = (u128, u128, u128, Result<Doc, String>);
static CACHE: Mutex<Option<HashMap<(String, String), Cached>>> = Mutex::new(None);

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Whether a cached result still holds at this age.
fn holds(got: &Result<Doc, String>, age: u128) -> bool {
    match got {
        Err(_) => age < FAILED_MS,
        Ok(doc) => age < RUNNING_MS || !doc.runs.iter().any(|r| r.status == "running"),
    }
}

/// One adapter's runs for this context, from the cache while nothing changed.
pub fn runs_of(a: &Adapter, ctx: &Context) -> Result<Vec<Run>, String> {
    doc_of(a, ctx).map(|d| d.runs)
}

/// One adapter's document for this context, from the cache while nothing
/// changed.
pub fn doc_of(a: &Adapter, ctx: &Context) -> Result<Doc, String> {
    let dirs: Vec<PathBuf> = match a {
        Adapter::Command(m) => [ctx.session_dir.clone(), m.dir.clone()].into_iter().chain(m.watch.iter().cloned()).collect(),
        Adapter::Builtin { watch, .. } => watch.iter().map(|w| ctx.session_dir.join(w)).collect(),
    };
    let key = (a.name().to_string(), ctx.to_json().to_string());
    let now = now_ms();
    let cached = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(&key).cloned());
    if let Some((_, _, checked, r)) = &cached {
        if now.saturating_sub(*checked) < FRESH_MS {
            return r.clone();
        }
    }
    let st = stamp(&dirs.iter().map(PathBuf::as_path).collect::<Vec<_>>());
    if let Some((s, read, _, r)) = cached {
        if s == st && holds(&r, now.saturating_sub(read)) {
            if let Some(e) = CACHE.lock().unwrap().as_mut().and_then(|c| c.get_mut(&key)) {
                e.2 = now;
            }
            return r;
        }
    }
    let doc = match a {
        Adapter::Builtin { run, .. } => Ok(run(ctx)),
        Adapter::Command(m) => run_command(m, ctx),
    };
    let got = doc.and_then(|d| parse_document(&d, a.name()));
    let mut c = CACHE.lock().unwrap();
    let map = c.get_or_insert_with(HashMap::new);
    if map.len() > 256 {
        map.clear();
    }
    map.insert(key, (st, now, now, got.clone()));
    got
}

/// Every run the adapters report for this session. With `all` false only
/// adapters that recognize a task on the background list run (the board's
/// case); with `all` true every adapter does (the run page's, which also
/// shows finished runs). A background type no adapter recognizes is a
/// "missing" notice; an adapter that fails is a "failed" one, and the other
/// adapters' runs still stand.
pub fn report(ctx: &Context, adapters: &[Adapter], all: bool) -> Report {
    let mut rep = Report::default();
    let mut kinds: Vec<(&str, usize)> = Vec::new();
    // A shell a sub-agent left running is that agent's, not a task type an
    // adapter reads: it raises no notice.
    for b in ctx.background.iter().filter(|b| b.kind != "shell") {
        match kinds.iter_mut().find(|(k, _)| *k == b.kind) {
            Some((_, n)) => *n += 1,
            None => kinds.push((b.kind.as_str(), 1)),
        }
    }
    for (k, n) in &kinds {
        if !adapters.iter().any(|a| a.recognizes(k)) {
            rep.notices.push(Notice { kind: "missing".into(), adapter: None, task_type: Some(k.to_string()), count: *n, why: "no adapter".into() });
        }
    }
    for a in adapters {
        let wanted = kinds.iter().filter(|(k, _)| a.recognizes(k)).map(|(_, n)| *n).sum::<usize>();
        if !all && wanted == 0 {
            continue;
        }
        match doc_of(a, ctx) {
            Ok(doc) => {
                rep.runs.extend(doc.runs);
                if let Some(s) = doc.summary {
                    rep.summaries.push((a.name().to_string(), s));
                }
            }
            Err(why) => rep.notices.push(Notice { kind: "failed".into(), adapter: Some(a.name().to_string()), task_type: None, count: wanted, why }),
        }
    }
    // A later adapter's run with an earlier one's id replaces it: a command
    // adapter that knows more about a sub-agent (lookout's) than the
    // built-in does takes its row.
    let mut kept: Vec<Run> = Vec::new();
    for r in rep.runs.drain(..) {
        match kept.iter().position(|k| k.id == r.id) {
            Some(i) => kept[i] = r,
            None => kept.push(r),
        }
    }
    rep.runs = kept;
    // A run with no group of its own goes under the prompt that launched
    // it: an adapter that replaced a built-in's run keeps that grouping.
    if let Some(t) = ctx.transcript.as_ref().filter(|_| rep.runs.iter().any(|r| r.group.is_none())) {
        let launched = super::launches::of(t);
        for r in rep.runs.iter_mut().filter(|r| r.group.is_none()) {
            let ids = std::iter::once(&r.id).chain(r.task.iter()).chain(r.agents.iter().map(|a| &a.id));
            r.group = ids.filter_map(|id| launched.get(id)).next().map(|p| p.group());
        }
    }
    rep.runs.sort_by(|a, b| b.start.unwrap_or(0).cmp(&a.start.unwrap_or(0)).then_with(|| a.id.cmp(&b.id)));
    rep
}
