//! A Claude session's background shells, read from its transcript: every
//! Bash call it ran with `run_in_background`, the task id and output file
//! Claude Code gave it, and how it ended (its `<task-notification>`, or a
//! KillShell / TaskStop). The pane's strip and the Dock show them.
//!
//! The transcript only grows, so a reader keeps its place (`Reader`) and
//! parses each line once.

use std::collections::HashMap;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// One background shell.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Shell {
    /// Claude Code's task id (`b…`).
    pub id: String,
    pub command: String,
    /// The Bash call's description, when it gave one.
    pub label: String,
    /// running, completed, failed or killed.
    pub status: String,
    pub exit: Option<i32>,
    /// Where its output goes, when the transcript says.
    pub output: Option<String>,
    /// When it started and ended (the transcript's timestamps, ms since the epoch).
    pub at: u64,
    pub ended: Option<u64>,
}

impl Shell {
    pub fn to_json(&self) -> Value {
        json!({"id": self.id, "command": self.command, "label": self.label, "status": self.status, "exit": self.exit,
               "output": self.output, "at": self.at, "ended": self.ended})
    }
}

/// What a reader has gathered so far.
#[derive(Default, Debug)]
pub struct Shells {
    /// tool_use id → (command, description, timestamp), for a background
    /// Bash call not yet given a task id.
    pending: HashMap<String, (String, String, u64)>,
    /// Shells in the order they started.
    pub list: Vec<Shell>,
}

fn ts(v: &Value) -> u64 {
    v.get("timestamp").and_then(Value::as_str).and_then(parse_rfc3339_ms).unwrap_or(0)
}

/// `2026-11-11T09:30:01.123Z` as ms since the epoch.
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.trim_end_matches('Z');
    let time = time.split(['+']).next()?;
    let mut t = time.split(':');
    let (h, mi) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec: f64 = t.next()?.parse().ok()?;
    // Days from the civil date (Howard Hinnant's algorithm).
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60) as f64 * 1000.0 + sec * 1000.0) as u64)
}

/// The text between `<tag>` and `</tag>` in `s`.
fn tag<'a>(s: &'a str, tag: &str) -> Option<&'a str> {
    let a = s.find(&format!("<{tag}>"))? + tag.len() + 2;
    let b = s[a..].find(&format!("</{tag}>"))? + a;
    Some(s[a..b].trim())
}

/// A message's text, whether a plain string or a list of text blocks.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b.get("text").and_then(Value::as_str).or_else(|| b.as_str())).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

impl Shells {
    fn find(&mut self, id: &str) -> Option<&mut Shell> {
        self.list.iter_mut().find(|s| s.id == id)
    }

    /// Take one transcript line.
    pub fn line(&mut self, line: &str) {
        // Most lines are not about shells: skip them before parsing.
        if !(line.contains("run_in_background") || line.contains("backgroundTaskId") || line.contains("in background with ID") || line.contains("task-notification")
            || line.contains("KillShell") || line.contains("TaskStop") || line.contains("KillBash"))
        {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        let at = ts(&v);
        let content = v.pointer("/message/content");
        if let Some(blocks) = content.and_then(Value::as_array) {
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("tool_use") => self.tool_use(b, at),
                    Some("tool_result") => self.tool_result(b, v.get("toolUseResult"), at),
                    _ => {}
                }
            }
        }
        // A finished shell: Claude Code tells the session in a user message.
        let text = content.map(text_of).unwrap_or_default();
        let text = if text.contains("<task-notification>") { text } else { v.get("content").map(text_of).unwrap_or_default() };
        for note in text.split("<task-notification>").skip(1) {
            let Some(id) = tag(note, "task-id") else { continue };
            let status = tag(note, "status").unwrap_or("").to_string();
            let summary = tag(note, "summary").unwrap_or("");
            let exit = summary.rsplit_once("exit code ").and_then(|(_, r)| r.trim_end_matches(')').trim().parse::<i32>().ok());
            let output = tag(note, "output-file").map(str::to_string);
            if let Some(s) = self.find(id) {
                if !status.is_empty() {
                    s.status = status;
                }
                s.exit = exit.or(s.exit);
                s.ended = Some(at);
                if s.output.is_none() {
                    s.output = output;
                }
            }
        }
    }

    fn tool_use(&mut self, b: &Value, at: u64) {
        let name = b.get("name").and_then(Value::as_str).unwrap_or("");
        let input = b.get("input").cloned().unwrap_or(Value::Null);
        let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        if name == "Bash" && input.get("run_in_background").and_then(Value::as_bool) == Some(true) {
            if let Some(id) = b.get("id").and_then(Value::as_str) {
                self.pending.insert(id.to_string(), (s("command"), s("description"), at));
            }
        } else if matches!(name, "KillShell" | "KillBash" | "TaskStop") {
            let id = [s("shell_id"), s("task_id"), s("bash_id"), s("id")].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
            if let Some(sh) = self.find(&id) {
                if sh.status == "running" {
                    sh.status = "killed".into();
                    sh.ended = Some(at);
                }
            }
        }
    }

    fn tool_result(&mut self, b: &Value, result: Option<&Value>, at: u64) {
        let Some(use_id) = b.get("tool_use_id").and_then(Value::as_str) else { return };
        let Some((command, label, started)) = self.pending.remove(use_id) else { return };
        let text = b.get("content").map(text_of).unwrap_or_default();
        let id = result
            .and_then(|r| r.get("backgroundTaskId"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| text.split("with ID: ").nth(1).map(|r| r.split(|c: char| c == '.' || c.is_whitespace()).next().unwrap_or("").to_string()))
            .filter(|i| !i.is_empty());
        let Some(id) = id else { return };
        let output = text.split("written to: ").nth(1).and_then(|r| r.split(".output").next()).map(|p| format!("{p}.output"));
        self.list.push(Shell { id, command, label, status: "running".into(), exit: None, output, at: if started > 0 { started } else { at }, ended: None });
    }
}

/// A transcript read as it grows: each call parses only what was added.
#[derive(Default)]
pub struct Reader {
    offset: u64,
    /// A line not yet ended (the writer was mid-line).
    rest: String,
    pub shells: Shells,
}

impl Reader {
    pub fn advance(&mut self, path: &Path) -> std::io::Result<()> {
        let mut f = std::fs::File::open(path)?;
        let len = f.metadata()?.len();
        if len < self.offset {
            // Rewritten from the start: read it again.
            *self = Reader::default();
        }
        if len == self.offset {
            return Ok(());
        }
        f.seek(SeekFrom::Start(self.offset))?;
        // Line by line: a long transcript read the first time is never held
        // in memory whole.
        let mut r = std::io::BufReader::new(f.take(len - self.offset));
        let mut buf = Vec::new();
        loop {
            buf.clear();
            if r.read_until(b'\n', &mut buf)? == 0 {
                break;
            }
            let piece = String::from_utf8_lossy(&buf);
            if let Some(line) = piece.strip_suffix('\n') {
                let mut whole = std::mem::take(&mut self.rest);
                whole.push_str(line);
                self.shells.line(&whole);
            } else {
                // The writer was mid-line: the rest comes next time.
                self.rest.push_str(&piece);
            }
        }
        self.offset = len;
        Ok(())
    }
}

/// One session's reader, behind its own lock: reading one transcript never
/// holds up another's.
type Slot = std::sync::Arc<std::sync::Mutex<(PathBuf, Reader)>>;

/// The most sessions whose readers are kept; past it, the one used longest
/// ago goes.
const READERS_MAX: usize = 64;

/// Each session's reader and when it was last asked for: the transcript is
/// read on from where it was, and its path found once.
fn readers() -> &'static std::sync::Mutex<HashMap<String, (Slot, std::time::Instant)>> {
    static R: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (Slot, std::time::Instant)>>> = std::sync::OnceLock::new();
    R.get_or_init(Default::default)
}

/// Session `session`'s reader, made (and its transcript found) the first time.
fn slot(home: &Path, session: &str) -> Option<Slot> {
    static MISSED: std::sync::OnceLock<std::sync::Mutex<HashMap<String, std::time::Instant>>> = std::sync::OnceLock::new();
    let now = std::time::Instant::now();
    {
        let mut all = readers().lock().unwrap_or_else(|e| e.into_inner());
        if let Some((s, used)) = all.get_mut(session) {
            *used = now;
            return Some(s.clone());
        }
    }
    // A session with no transcript yet is looked for again only now and then.
    {
        let missed = MISSED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        if missed.get(session).is_some_and(|t| t.elapsed() < std::time::Duration::from_secs(20)) {
            return None;
        }
    }
    let Some(path) = transcript_of(home, session) else {
        let mut missed = MISSED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        if missed.len() > 256 {
            missed.clear();
        }
        missed.insert(session.to_string(), now);
        return None;
    };
    let mut all = readers().lock().unwrap_or_else(|e| e.into_inner());
    evict(&mut all, READERS_MAX);
    let s = all.entry(session.to_string()).or_insert_with(|| (std::sync::Arc::new(std::sync::Mutex::new((path, Reader::default()))), now));
    Some(s.0.clone())
}

/// Drop the readers used longest ago until fewer than `max` are left.
fn evict<T>(all: &mut HashMap<String, (T, std::time::Instant)>, max: usize) {
    while all.len() >= max {
        let Some(old) = all.iter().min_by_key(|(_, (_, used))| *used).map(|(k, _)| k.clone()) else { break };
        all.remove(&old);
    }
}

/// Session `session`'s background shells, read on from its transcript. A
/// shell the transcript still calls running, with nothing left writing its
/// output (Claude died before it could say how the shell ended), comes back
/// as `gone`.
pub fn of_session(home: &Path, session: &str) -> Vec<Shell> {
    let Some(slot) = slot(home, session) else { return Vec::new() };
    let mut list = {
        let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
        let (path, r) = &mut *g;
        if r.advance(path).is_err() {
            drop(g);
            readers().lock().unwrap_or_else(|e| e.into_inner()).remove(session);
            return Vec::new();
        }
        r.shells.list.clone()
    };
    let now = crate::history::now_ms();
    let asked: Vec<&str> = list.iter()
        .filter(|s| s.status == "running" && now.saturating_sub(s.at) > SETTLE_MS)
        .filter_map(|s| s.output.as_deref()).collect();
    if asked.is_empty() {
        return list;
    }
    let live = written(&asked);
    for s in list.iter_mut().filter(|s| s.status == "running" && now.saturating_sub(s.at) > SETTLE_MS) {
        if s.output.as_deref().is_some_and(|o| live.get(o) == Some(&false)) {
            s.status = "gone".into();
        }
    }
    list
}

/// How long a new shell has before a missing writer counts: its process
/// may not have opened the output file yet.
const SETTLE_MS: u64 = 5_000;
/// How long a reading of who writes the output files is kept.
const WRITTEN_MS: u64 = 10_000;

/// Of `outputs`, whether anything but Claude has each one open (true), or
/// none does (false). An output lsof could not be asked about is left out,
/// so it reads as still running. Kept WRITTEN_MS: lsof is not free.
fn written(outputs: &[&str]) -> HashMap<String, bool> {
    static SEEN: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (bool, u64)>>> = std::sync::OnceLock::new();
    let seen = SEEN.get_or_init(Default::default);
    let now = crate::history::now_ms();
    let mut out = HashMap::new();
    let mut ask = Vec::new();
    {
        let mut g = seen.lock().unwrap_or_else(|e| e.into_inner());
        g.retain(|_, (_, at)| now.saturating_sub(*at) < WRITTEN_MS);
        for o in outputs {
            match g.get(*o) {
                Some((v, _)) => {
                    out.insert(o.to_string(), *v);
                }
                None => ask.push(*o),
            }
        }
    }
    let ask: Vec<&str> = ask.into_iter().filter(|o| Path::new(o).exists()).collect();
    if ask.is_empty() {
        return out;
    }
    let Some(held) = holders(&ask) else { return out };
    let Some(procs) = procs() else { return out };
    let mut g = seen.lock().unwrap_or_else(|e| e.into_inner());
    for o in ask {
        // lsof names a file by its real path (/tmp is /private/tmp on a Mac).
        let real = std::fs::canonicalize(o).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| o.to_string());
        let pids = held.get(&real).or_else(|| held.get(o)).cloned().unwrap_or_default();
        let v = !writers(&pids, &procs).is_empty();
        g.insert(o.to_string(), (v, now));
        out.insert(o.to_string(), v);
    }
    out
}

/// Who has each of `paths` open, from one `lsof -F pn`: path to pids.
fn holders(paths: &[&str]) -> Option<HashMap<String, Vec<u32>>> {
    let o = std::process::Command::new("/usr/sbin/lsof").args(["-w", "-F", "pn", "--"]).args(paths).output().ok()?;
    Some(parse_lsof(&String::from_utf8_lossy(&o.stdout)))
}

/// lsof's -F pn output: `p<pid>` starts a process, `n<path>` names a file it has open.
pub fn parse_lsof(text: &str) -> HashMap<String, Vec<u32>> {
    let mut out: HashMap<String, Vec<u32>> = HashMap::new();
    let mut pid = None;
    for l in text.lines() {
        if let Some(p) = l.strip_prefix('p') {
            pid = p.trim().parse::<u32>().ok();
        } else if let (Some(n), Some(p)) = (l.strip_prefix('n'), pid) {
            let e = out.entry(n.to_string()).or_default();
            if !e.contains(&p) {
                e.push(p);
            }
        }
    }
    out
}

/// Every process, as `ps -axo pid=,ppid=,command=`.
fn procs() -> Option<String> {
    let o = std::process::Command::new("/bin/ps").args(["-axo", "pid=,ppid=,command="]).output().ok()?;
    Some(String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The board's state word for a shell: running, done, failed, cancelled, or
/// unknown (gone without a word).
pub fn board_state(s: &Shell) -> &'static str {
    match s.status.as_str() {
        "running" => "running",
        "killed" => "cancelled",
        // Nothing writes its output and the transcript never said how it ended.
        "gone" => "unknown",
        "failed" => "failed",
        _ if s.exit.is_some_and(|e| e != 0) => "failed",
        _ => "done",
    }
}

/// The transcript of `session`: `~/.claude/projects/<any>/<session>.jsonl`.
pub fn transcript_of(home: &Path, session: &str) -> Option<PathBuf> {
    if session.is_empty() || session.contains('/') {
        return None;
    }
    let name = format!("{session}.jsonl");
    std::fs::read_dir(home.join(".claude/projects")).ok()?.flatten().map(|d| d.path().join(&name)).find(|p| p.is_file())
}

/// The last `max` bytes of a shell's output, from a line start where it can.
pub fn tail(path: &Path, max: u64) -> String {
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(max);
    if f.seek(SeekFrom::Start(from)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    let s = if from > 0 { s.split_once('\n').map(|(_, r)| r.to_string()).unwrap_or(s) } else { s };
    strip_ansi(&s)
}

/// Text without terminal escapes (colours, cursor moves) or carriage-return
/// overwrites (a progress bar keeps its last state).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            match it.peek() {
                Some('[') => {
                    it.next();
                    while let Some(&n) = it.peek() {
                        it.next();
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: to BEL or ST.
                    it.next();
                    while let Some(n) = it.next() {
                        if n == '\x07' || (n == '\x1b' && it.peek() == Some(&'\\')) {
                            if n == '\x1b' {
                                it.next();
                            }
                            break;
                        }
                    }
                }
                _ => {
                    it.next();
                }
            }
        } else {
            out.push(c);
        }
    }
    out.split('\n').map(|l| l.rsplit('\r').find(|p| !p.is_empty()).unwrap_or("")).collect::<Vec<_>>().join("\n")
}

/// The processes writing to `output` (the shell Claude Code started and the
/// commands under it), never Claude itself. `lsof` names the holders;
/// `procs` is `ps -axo pid=,ppid=,command=`.
pub fn writers(holders: &[u32], procs: &str) -> Vec<u32> {
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut comm: HashMap<u32, String> = HashMap::new();
    for l in procs.lines() {
        let mut w = l.split_whitespace();
        let (Some(pid), Some(ppid)) = (w.next().and_then(|x| x.parse().ok()), w.next().and_then(|x| x.parse().ok())) else { continue };
        let c: String = w.collect::<Vec<_>>().join(" ");
        kids.entry(ppid).or_default().push(pid);
        comm.insert(pid, c);
    }
    // Claude Code itself: its native binary, or node running its package. A
    // background `node server.js` is the command's own.
    // Only the program and node's script count: a shell's own argv carries
    // the whole command, which may name the package (`npm i -g @anthropic-ai/claude-code`).
    let is_claude = |pid: &u32| comm.get(pid).is_some_and(|c| {
        let mut argv = c.split_whitespace();
        let prog = argv.next().unwrap_or("").rsplit('/').next().unwrap_or("");
        let script = argv.find(|a| !a.starts_with('-')).unwrap_or("");
        prog == "claude" || (prog == "node" && (script.contains("@anthropic-ai/claude-code/") || script.contains("/claude-code/cli")))
    });
    let mut out = Vec::new();
    let mut stack: Vec<u32> = holders.iter().copied().filter(|p| !is_claude(p)).collect();
    while let Some(p) = stack.pop() {
        if out.contains(&p) {
            continue;
        }
        out.push(p);
        stack.extend(kids.get(&p).into_iter().flatten().copied());
    }
    out
}

/// Stop the shell writing `output`: SIGTERM to it and everything under it.
/// Returns how many processes were signalled.
pub fn stop(output: &Path) -> Result<usize, String> {
    if !output.to_string_lossy().ends_with(".output") {
        return Err("not a background shell's output".into());
    }
    let o = std::process::Command::new("/usr/sbin/lsof").arg("-t").arg("--").arg(output).output().map_err(|e| e.to_string())?;
    let holders: Vec<u32> = String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect();
    if holders.is_empty() {
        return Ok(0);
    }
    let pids = writers(&holders, &procs().ok_or("ps did not run")?);
    // Deepest first, so a parent does not restart what it lost.
    for p in pids.iter().rev() {
        // SAFETY: kill(2) with a pid read from lsof/ps; a gone pid fails harmlessly.
        unsafe {
            libc::kill(*p as libc::pid_t, libc::SIGTERM);
        }
    }
    Ok(pids.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const USE: &str = r#"{"type":"assistant","timestamp":"2026-11-11T10:00:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm run dev","description":"Start the dev server","run_in_background":true}}]}}"#;
    const RES: &str = r#"{"type":"user","timestamp":"2026-11-11T10:00:01.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"Command running in background with ID: b1x. Output is being written to: /tmp/claude-501/p/s/tasks/b1x.output. You will be notified"}]},"toolUseResult":{"backgroundTaskId":"b1x"}}"#;
    const DONE: &str = r#"{"type":"user","timestamp":"2026-11-11T10:05:00.000Z","message":{"content":"<task-notification>\n<task-id>b1x</task-id>\n<output-file>/tmp/claude-501/p/s/tasks/b1x.output</output-file>\n<status>failed</status>\n<summary>Background command \"Start the dev server\" failed (exit code 1)</summary>\n</task-notification>"}}"#;

    #[test]
    fn a_background_shell_runs_then_ends() {
        let mut s = Shells::default();
        s.line(USE);
        assert!(s.list.is_empty(), "no task id yet");
        s.line(RES);
        assert_eq!(s.list.len(), 1);
        let sh = &s.list[0];
        assert_eq!((sh.id.as_str(), sh.command.as_str(), sh.label.as_str(), sh.status.as_str()), ("b1x", "npm run dev", "Start the dev server", "running"));
        assert_eq!(sh.output.as_deref(), Some("/tmp/claude-501/p/s/tasks/b1x.output"));
        assert_eq!(sh.at, 1_794_391_200_000);
        s.line(DONE);
        let sh = &s.list[0];
        assert_eq!((sh.status.as_str(), sh.exit), ("failed", Some(1)));
        assert_eq!(sh.ended, Some(1_794_391_500_000));
    }

    #[test]
    fn a_kill_ends_a_running_shell() {
        let mut s = Shells::default();
        s.line(USE);
        s.line(RES);
        s.line(r#"{"type":"assistant","timestamp":"2026-11-11T10:01:00.000Z","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"KillShell","input":{"shell_id":"b1x"}}]}}"#);
        assert_eq!(s.list[0].status, "killed");
    }

    #[test]
    fn a_foreground_bash_is_not_a_background_shell() {
        let mut s = Shells::default();
        s.line(r#"{"message":{"content":[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"ls","run_in_background":false}}]}}"#);
        s.line(r#"{"message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"a b"}]}}"#);
        assert!(s.list.is_empty());
    }

    #[test]
    fn the_id_comes_from_the_text_when_the_result_has_none() {
        let mut s = Shells::default();
        s.line(USE);
        s.line(r#"{"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"Command running in background with ID: b9z. Output is being written to: /x/b9z.output."}]}]}}"#);
        assert_eq!(s.list[0].id, "b9z");
        assert_eq!(s.list[0].output.as_deref(), Some("/x/b9z.output"));
    }

    #[test]
    fn a_reader_parses_only_what_was_added() {
        let dir = std::env::temp_dir().join(format!("seamux-bg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        // The result line is half written at first.
        std::fs::write(&p, format!("{USE}\n{}", &RES[..40])).unwrap();
        let mut r = Reader::default();
        r.advance(&p).unwrap();
        assert!(r.shells.list.is_empty());
        std::fs::write(&p, format!("{USE}\n{RES}\n")).unwrap();
        r.advance(&p).unwrap();
        assert_eq!(r.shells.list.len(), 1);
        std::fs::write(&p, format!("{USE}\n{RES}\n{DONE}\n")).unwrap();
        r.advance(&p).unwrap();
        assert_eq!(r.shells.list[0].status, "failed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_loses_its_escapes_and_overwrites() {
        assert_eq!(strip_ansi("\x1b[32mok\x1b[0m done"), "ok done");
        assert_eq!(strip_ansi("10%\r50%\r100%\nnext"), "100%\nnext");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link");
        assert_eq!(strip_ansi("line\r\n"), "line\n");
    }

    #[test]
    fn a_stop_spares_claude() {
        let ps = "100 1 /usr/local/bin/claude --resume x\n200 100 /bin/zsh -c npm run dev\n300 200 node vite.js\n301 200 vite\n400 1 other\n\
                  500 1 node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js\n600 1 node server.js";
        let mut w = writers(&[100, 200, 500], ps);
        w.sort();
        // node and vite under the shell are the command's; Claude (native or
        // node), though it holds the file, is not, nor what runs beside it.
        assert_eq!(w, vec![200, 300, 301]);
        // A node command holding its output itself is stopped.
        assert_eq!(writers(&[600], ps), vec![600]);
        // A shell whose command names Claude's package is the command, not Claude.
        let npm = "700 1 /bin/zsh -c npm i -g @anthropic-ai/claude-code\n701 700 node /usr/local/bin/npm i -g @anthropic-ai/claude-code";
        let mut w = writers(&[700], npm);
        w.sort();
        assert_eq!(w, vec![700, 701]);
    }

    #[test]
    fn a_shell_reads_as_a_board_state() {
        let s = |status: &str, exit: Option<i32>| Shell { status: status.into(), exit, ..Default::default() };
        assert_eq!(board_state(&s("running", None)), "running");
        assert_eq!(board_state(&s("completed", Some(0))), "done");
        assert_eq!(board_state(&s("completed", Some(2))), "failed");
        assert_eq!(board_state(&s("failed", Some(1))), "failed");
        assert_eq!(board_state(&s("killed", None)), "cancelled");
    }

    #[test]
    fn lsof_output_names_each_files_holders() {
        let t = "p100\nn/tmp/a.output\np200\nn/tmp/a.output\nn/tmp/b.output\np300\n";
        let h = parse_lsof(t);
        assert_eq!(h.get("/tmp/a.output"), Some(&vec![100, 200]));
        assert_eq!(h.get("/tmp/b.output"), Some(&vec![200]));
        assert_eq!(h.len(), 2);
    }

    #[test]
    fn the_reader_used_longest_ago_goes_first() {
        let t0 = std::time::Instant::now();
        let mut m: HashMap<String, ((), std::time::Instant)> = HashMap::new();
        for (i, k) in ["a", "b", "c"].iter().enumerate() {
            m.insert(k.to_string(), ((), t0 + std::time::Duration::from_secs(i as u64)));
        }
        // "a" is used again: "b" is now the oldest.
        m.get_mut("a").unwrap().1 = t0 + std::time::Duration::from_secs(9);
        evict(&mut m, 3);
        let mut left: Vec<&String> = m.keys().collect();
        left.sort();
        assert_eq!(left, ["a", "c"]);
    }

    /// Live: a file a running shell writes, and one nothing holds.
    #[test]
    fn a_held_output_is_written_and_a_loose_one_is_not() {
        if !Path::new("/usr/sbin/lsof").exists() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("seamux-written-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (held, loose) = (dir.join("held.output"), dir.join("loose.output"));
        std::fs::write(&loose, b"done").unwrap();
        let out = std::fs::File::create(&held).unwrap();
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "sleep 30"]).stdout(out).spawn().unwrap();
        let (h, l) = (held.to_string_lossy().into_owned(), loose.to_string_lossy().into_owned());
        let w = written(&[&h, &l]);
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!((w.get(&h), w.get(&l)), (Some(&true), Some(&false)), "{w:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_shell_with_no_writer_reads_as_gone() {
        let s = Shell { status: "gone".into(), ..Default::default() };
        assert_eq!(board_state(&s), "unknown");
    }

    #[test]
    fn timestamps_read_as_ms() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(parse_rfc3339_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
    }
}
