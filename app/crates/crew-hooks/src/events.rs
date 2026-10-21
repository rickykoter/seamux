//! `seamux crew-hook <event>`: crew/hooks/crew-hook.sh and lib.sh in Rust.
//!
//! ```text
//! seamux crew-hook <session|pretool|ask|answered|task|notification|stop|end>  < payload
//! ```
//!
//! crew/hooks/seamux-hook.sh is the hook command: it keeps pretool's
//! lane-marker test in bash, so the common tool use never starts this
//! binary, and execs it for everything else. The events do what the bash
//! did, call for call: the same cmux argv on the CLI transport (the probes
//! read them from fakecmux's log), the same marker files, the one-write
//! description merge, the same detached spawns. On the socket, the writes
//! that name a workspace go there with CMUX_WORKSPACE_ID filled in; the
//! verbs cmux only has on its CLI run the CLI, as the bash did.

use std::path::{Path, PathBuf};

use cmux::{Cmux, Transport, WorkspaceAction};
use serde_json::Value;

use crate::pyval;
use crate::spawn;

/// What a hook knows: its cmux, its workspace, its state dir, its payload.
pub struct Hook {
    pub cmux: Cmux,
    pub ws: String,
    pub state: PathBuf,
    pub payload: String,
    cwd: Option<String>,
}

/// `${XDG_CACHE_HOME:-$HOME/.cache}/cmux-crew`.
pub fn state_dir() -> PathBuf {
    crew_core::home::xdg_cache()
}

/// crew_guard: outside cmux, with no workspace, or with crew disabled, a
/// hook does nothing. None means exit 0 now.
pub fn guard() -> Option<(Cmux, String, PathBuf)> {
    let cmux = spawn::connect()?;
    let ws = crew_core::py::env_or("CMUX_WORKSPACE_ID")?;
    if crew_core::py::env_or("CREW_DISABLED").is_some() {
        return None;
    }
    let state = state_dir();
    if state.join("disabled").exists() {
        return None;
    }
    Some((cmux, ws, state))
}

/// `$(cat)`: stdin, trailing newlines dropped as command substitution does.
pub fn read_payload() -> String {
    use std::io::Read;
    let mut b = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut b);
    strip_newlines(&String::from_utf8_lossy(&b)).to_string()
}

pub fn strip_newlines(s: &str) -> &str {
    s.trim_end_matches('\n')
}

/// `printf '%s\n' "$out" | sed -n <n>p`: the n-th line, 1-based.
pub fn line(out: &str, n: usize) -> String {
    out.split('\n').nth(n - 1).unwrap_or("").to_string()
}

fn touch(p: &Path) {
    let _ = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(p);
}

fn mkdir(p: &Path) {
    let _ = std::fs::create_dir_all(p);
}

/// `basename "$p"`.
pub fn basename(p: &str) -> String {
    if p.is_empty() {
        return String::new();
    }
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return "/".into();
    }
    t.rsplit('/').next().unwrap_or(t).to_string()
}

/// `${branch#*/}` then the three ticket shapes, case-blind:
/// `dev/thing-proj-123` and `proj-123-thing` are "PROJ-123 · thing".
pub fn ticket_label(branch: &str) -> String {
    let rest = match branch.find('/') {
        Some(i) => &branch[i + 1..],
        None => branch,
    };
    let letters = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphabetic());
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (ticket, rest) = 'found: {
        // ^(.+)-([a-z]+-[0-9]+)$
        if let Some(d) = rest.rfind('-') {
            if let Some(l) = rest[..d].rfind('-') {
                if l > 0 && letters(&rest[l + 1..d]) && digits(&rest[d + 1..]) {
                    break 'found (&rest[l + 1..], &rest[..l]);
                }
            }
        }
        let parts: Vec<&str> = rest.splitn(3, '-').collect();
        // ^([a-z]+-[0-9]+)-(.+)$
        if parts.len() == 3 && letters(parts[0]) && digits(parts[1]) && !parts[2].is_empty() {
            break 'found (&rest[..parts[0].len() + 1 + parts[1].len()], parts[2]);
        }
        // ^([a-z]+-[0-9]+)$
        if parts.len() == 2 && letters(parts[0]) && digits(parts[1]) {
            break 'found (rest, "");
        }
        return String::new();
    };
    let ticket = ticket.to_ascii_uppercase();
    if rest.is_empty() {
        ticket
    } else {
        format!("{ticket} · {rest}")
    }
}

/// `git -C dir <args>`: stdout with trailing newlines dropped, "" on failure.
fn git(dir: &str, args: &[&str]) -> (bool, String) {
    let mut a = vec!["-C", dir];
    a.extend_from_slice(args);
    match std::process::Command::new("git").args(&a).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output() {
        Ok(o) => (o.status.success(), strip_newlines(&String::from_utf8_lossy(&o.stdout)).to_string()),
        Err(_) => (false, String::new()),
    }
}

pub fn branch(dir: &str) -> String {
    git(dir, &["branch", "--show-current"]).1
}

/// A dirty tree, or commits the upstream has not seen.
fn has_unreviewed_work(dir: &str) -> bool {
    if !git(dir, &["rev-parse", "--git-dir"]).0 {
        return false;
    }
    let (_, status) = git(dir, &["status", "--porcelain"]);
    if !status.is_empty() {
        return true;
    }
    let (ok, ahead) = git(dir, &["rev-list", "--count", "@{u}..HEAD"]);
    let ahead = if ok { ahead } else { "0".into() };
    ahead.trim().parse::<i64>().unwrap_or(0) > 0
}

/// Python's str.split(): runs of whitespace, the ASCII separators included.
fn split_tokens(s: &str) -> Vec<&str> {
    s.split(|c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)).filter(|t| !t.is_empty()).collect()
}

impl Hook {
    pub fn new(cmux: Cmux, ws: String, state: PathBuf, payload: String) -> Hook {
        Hook { cmux, ws, state, payload, cwd: None }
    }

    fn cli_transport(&self) -> bool {
        matches!(self.cmux.transport(), Transport::Cli(_))
    }

    /// crew_cmux: fire and forget, never failing the turn.
    fn cli(&self, argv: &[&str]) {
        let _ = self.cmux.cli(argv);
    }

    /// crew_json <key>: a top-level field as Python's print would show it.
    pub fn json(&self, key: &str) -> String {
        let Ok(Value::Object(d)) = pyval::loads(&self.payload) else { return String::new() };
        match d.get(key) {
            None | Some(Value::Null) => String::new(),
            Some(v) => strip_newlines(&pyval::str_of(v)).to_string(),
        }
    }

    pub fn cwd(&mut self) -> String {
        if self.cwd.is_none() {
            let mut c = self.json("cwd");
            if c.is_empty() {
                c = crew_core::py::env_or("CMUX_AGENT_LAUNCH_CWD")
                    .or_else(|| std::env::var("PWD").ok())
                    .or_else(|| std::env::current_dir().ok().map(|d| d.display().to_string()))
                    .unwrap_or_default();
            }
            self.cwd = Some(c);
        }
        self.cwd.clone().unwrap_or_default()
    }

    /// crew_label: the branch's ticket, else the directory's name.
    pub fn label(&mut self) -> String {
        let cwd = self.cwd();
        let l = ticket_label(&branch(&cwd));
        if l.is_empty() {
            basename(&cwd)
        } else {
            l
        }
    }

    // ---- the workspace's lane ------------------------------------------------

    fn status_set(&self, lane: &str) {
        if self.cli_transport() {
            self.cli(&["workspace", "status", "set", lane]);
        } else {
            let _ = self.cmux.workspace_status_set(&self.ws, lane);
        }
    }

    pub fn lane_marker(&self) -> PathBuf {
        self.state.join(format!("lane-{}", self.ws))
    }

    pub fn lane_set(&self, lane: &str) {
        mkdir(&self.state);
        self.status_set(lane);
        touch(&self.lane_marker());
    }

    pub fn lane_release(&self) {
        let m = self.lane_marker();
        if !m.exists() {
            return;
        }
        let _ = std::fs::remove_file(&m);
        self.status_set("auto");
    }

    // ---- the description's tokens --------------------------------------------

    /// This workspace's row in cmux's list, if cmux lists it.
    fn row(&self) -> Option<Value> {
        let rows: Vec<Value> = if self.cli_transport() {
            // The bash's own read: one `workspace list --json`.
            match self.cmux.cli(&["workspace", "list", "--json"]) {
                Ok(o) => match pyval::loads(&o.stdout) {
                    Ok(Value::Object(d)) => d.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default(),
                    _ => Vec::new(),
                },
                Err(_) => Vec::new(),
            }
        } else {
            // On the socket, every window: workspace.list answers for one.
            let wins = self.cmux.window_list().unwrap_or_default();
            let ids: Vec<Option<String>> = if wins.is_empty() {
                vec![None]
            } else {
                wins.iter().map(|w| w.get("id").and_then(Value::as_str).map(String::from)).collect()
            };
            ids.iter()
                .filter_map(|id| self.cmux.workspace_list(id.as_deref()).ok())
                .flat_map(|d| d.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default())
                .collect()
        };
        rows.into_iter().find(|w| w.get("id").and_then(Value::as_str) == Some(self.ws.as_str()))
    }

    /// This workspace's description, or "" when cmux does not list it.
    fn desc_get(&self) -> String {
        self.row()
            .map(|w| match w.get("description") {
                Some(d) if pyval::truthy(d) => strip_newlines(&pyval::str_of(d)).to_string(),
                _ => String::new(),
            })
            .unwrap_or_default()
    }

    fn desc_put(&self, new: &str) {
        if self.cli_transport() {
            if new.is_empty() {
                self.cli(&["workspace-action", "--action", "clear-description"]);
            } else {
                self.cli(&["workspace-action", "--action", "set-description", "--description", new]);
            }
        } else {
            let a = if new.is_empty() {
                WorkspaceAction::ClearDescription
            } else {
                WorkspaceAction::SetDescription(new.to_string())
            };
            let _ = self.cmux.workspace_action(&self.ws, &a);
        }
    }

    /// crew_token_set: one token merged in, every other left alone.
    pub fn token_set(&self, key: &str, val: &str) {
        let cur = self.desc_get();
        let prefix = format!("{key}:");
        let mut toks: Vec<String> = split_tokens(&cur).into_iter().filter(|t| !t.starts_with(&prefix)).map(String::from).collect();
        if !val.is_empty() {
            toks.push(format!("{key}:{val}"));
        }
        self.desc_put(&toks.join(" "));
    }

    /// crew_token_clear: several keys in one read-modify-write, and no write
    /// when nothing changed.
    pub fn token_clear(&self, keys: &[&str]) {
        let cur = self.desc_get();
        let new = split_tokens(&cur)
            .into_iter()
            .filter(|t| !keys.iter().any(|k| t.starts_with(&format!("{k}:"))))
            .collect::<Vec<_>>()
            .join(" ");
        if new == cur {
            return;
        }
        self.desc_put(&new);
    }

    /// crew_phase: the board matches phase:working and phase:waiting.
    pub fn phase(&self, p: &str) {
        let v = match p {
            "working" => "working",
            "waiting on you" => "waiting",
            other => other,
        };
        self.token_set("phase", v);
    }

    pub fn notify(&mut self, subtitle: &str, body: &str) {
        let title = self.label();
        self.cli(&["notify", "--title", &title, "--subtitle", subtitle, "--body", body]);
    }

    // ---- spawns --------------------------------------------------------------

    /// crew_sync_maybe: crew-sync, detached, at most once per CREW_SYNC_INTERVAL.
    fn sync_maybe(&self) {
        let stamp = self.state.join("sync-stamp");
        let now = crew_core::py::now() as i64;
        if stamp.exists() {
            let last = std::fs::read_to_string(&stamp).unwrap_or_else(|_| "0".into());
            let interval = std::env::var("CREW_SYNC_INTERVAL").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "120".into());
            // $((now - last)): an empty stamp, or a word (an unset shell
            // variable), counts as 0; anything else that is not a number is
            // an arithmetic error, and `[ -ge ]` on a bad interval fails too:
            // both return without syncing.
            let last = last.trim();
            let last = if last.is_empty()
                || (last.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                    && last.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
            {
                Ok(0)
            } else {
                last.parse::<i64>()
            };
            let (Ok(last), Ok(interval)) = (last, interval.trim().parse::<i64>()) else { return };
            if now - last < interval {
                return;
            }
        }
        mkdir(&self.state);
        let _ = std::fs::write(&stamp, now.to_string());
        let t = spawn::tool("crew-sync", &[]);
        if t.runnable() {
            let _ = spawn::detach(&t.argv, None, None);
        }
    }

    /// crew_color_ensure: crew-color's colour, only into a blank.
    fn color_ensure(&self, cwd: &str) {
        if cwd.is_empty() {
            return;
        }
        let t = spawn::tool("crew-color", &["assign", cwd]);
        if !t.runnable() {
            return;
        }
        let cur = if self.cli_transport() {
            // The bash's read: sidebar-state's color= line.
            let state = self.cmux.sidebar_state(&self.ws).unwrap_or_default();
            let cur: Vec<&str> = state.lines().filter_map(|l| l.strip_prefix("color=")).collect();
            strip_newlines(&cur.join("\n")).to_string()
        } else {
            // On the socket the list carries the colour; sidebar-state is
            // CLI-only, and its CLI costs ~170 ms of a session start.
            self.row()
                .and_then(|w| w.get("custom_color").filter(|c| pyval::truthy(c)).map(pyval::str_of))
                .unwrap_or_default()
        };
        if !(cur.is_empty() || cur == "none") {
            return;
        }
        let hex = spawn::run(&t.argv, None, None).map(|(_, out)| strip_newlines(&out).to_string()).unwrap_or_default();
        if hex.starts_with('#') {
            if self.cli_transport() {
                self.cli(&["workspace-action", "--action", "set-color", "--color", &hex]);
            } else {
                let _ = self.cmux.workspace_action(&self.ws, &WorkspaceAction::SetColor(hex));
            }
        }
    }

    /// crew_listen_ensure: the singleton reconciler, started from SessionStart.
    fn listen_ensure(&self) {
        let t = spawn::tool("crew-listen", &[]);
        if !t.runnable() || self.state.join("listen.off").exists() {
            return;
        }
        let pid = std::fs::read_to_string(self.state.join("listen.pid")).unwrap_or_default();
        if let Ok(pid) = pid.trim().parse::<i32>() {
            // SAFETY: signal 0 only checks that the pid exists and is ours.
            if pid > 0 && unsafe { libc::kill(pid, 0) } == 0 {
                return;
            }
        }
        mkdir(&self.state);
        let _ = spawn::detach(&t.argv, None, Some(&self.state.join("listen.log")));
    }
}

// ---- the events ------------------------------------------------------------

/// The ask's first question, at most 160 characters, as the Python showed it.
fn question(payload: &str) -> String {
    let Ok(Value::Object(d)) = pyval::loads(payload) else { return String::new() };
    let ti = d.get("tool_input").filter(|v| pyval::truthy(v));
    let Some(Value::Object(ti)) = ti else {
        return String::new();
    };
    let qs = ti.get("questions").filter(|v| pyval::truthy(v));
    let Some(Value::Array(qs)) = qs else { return String::new() };
    let Some(Value::Object(q)) = qs.first() else { return String::new() };
    let text = match q.get("question") {
        Some(Value::String(s)) => s.chars().take(160).collect(),
        Some(Value::Array(a)) if !a.is_empty() => pyval::repr(&Value::Array(a.iter().take(160).cloned().collect())),
        _ => String::new(),
    };
    strip_newlines(&text).to_string()
}

fn session(h: &mut Hook) {
    // `crew adopt` replays this event and must not leave the marker.
    if std::env::var("CREW_ADOPT").map(|v| v != "1").unwrap_or(true) {
        let sid = h.json("session_id");
        if !sid.is_empty() {
            mkdir(&h.state);
            touch(&h.state.join(format!("session-{sid}")));
        }
    }
    let cwd = h.cwd();
    let dir = basename(&cwd);
    let br = branch(&cwd);
    let mut label = if br.is_empty() { String::new() } else { ticket_label(&br) };
    if label.is_empty() {
        label = dir.clone();
    }
    if h.cli_transport() {
        h.cli(&["rename-workspace", &label]);
    } else {
        let _ = h.cmux.rename_workspace(&h.ws, &label);
    }
    let tab = if br.is_empty() { dir.clone() } else { format!("{dir} · {br}") };
    h.cli(&["rename-tab", &tab]);
    h.color_ensure(&cwd);
    h.phase("working");
    h.listen_ensure();
}

fn stop(h: &mut Hook) -> String {
    if h.json("stop_hook_active") == "True" {
        return String::new();
    }
    let cwd = h.cwd();
    let br = branch(&cwd);
    if has_unreviewed_work(&cwd) {
        h.lane_set("review");
    } else {
        h.lane_release();
    }
    h.cli(&["clear-status", "claude"]);
    h.token_clear(&["phase", "feed", "feedby", "feedgate", "feedreq", "feedws"]);
    let body = if br.is_empty() { "Turn complete".to_string() } else { format!("Turn complete — {br}") };
    h.notify("crew:turn", &body);
    h.sync_maybe();

    // TypeSafe's turn-end judgment, detached so the turn never waits on it.
    let _ = std::fs::remove_file(h.state.join(format!("asked-{}", h.ws)));
    let mut transcript = None;
    let avail = spawn::tool("asked", &["available"]);
    if spawn::run(&avail.argv, Some(""), None).is_some_and(|(rc, _)| rc == 0) {
        let tp = h.json("transcript_path");
        let size = std::fs::metadata(&tp).map(|m| m.len().to_string()).unwrap_or_default();
        transcript = Some(tp);
        // A file, not a pipe: the detached job reads it as stdin.
        let pl = h.state.join(format!("asked-payload-{}", h.ws));
        mkdir(&h.state);
        if std::fs::write(&pl, &h.payload).is_ok() {
            let t = spawn::tool("asked-hook", &[&size]);
            let _ = spawn::detach(&t.argv, Some(&pl), None);
        }
    }

    // Cache facts: --stop in the foreground (its stdout is the hook's), the
    // sleeper detached.
    let mut out = String::new();
    let transcript = transcript.filter(|t| !t.is_empty()).unwrap_or_else(|| h.json("transcript_path"));
    let sid = h.json("session_id");
    if !transcript.is_empty() && !sid.is_empty() {
        let label = h.label();
        let t = spawn::tool("cachefacts", &["--stop", &transcript, &sid, &label]);
        if let Some((_, o)) = spawn::run(&t.argv, None, None) {
            out = o;
        }
        let t = spawn::tool("cachefacts", &["--sleep", &sid, &transcript, &label]);
        let _ = spawn::detach(&t.argv, None, None);
    }

    // The Artifact Log's indexer, detached.
    let t = spawn::tool("crew-artifacts", &["index"]);
    let _ = spawn::detach(&t.argv, None, None);
    out
}

/// pretool, past seamux-hook.sh's marker test: release the lane, and take
/// the phase back from a turn-end ask.
fn pretool() -> i32 {
    let state = state_dir();
    let ws = std::env::var("CMUX_WORKSPACE_ID").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "none".into());
    let _ = std::fs::remove_file(state.join(format!("lane-{ws}")));
    let asked = state.join(format!("asked-{ws}"));
    let Some(cmux) = spawn::connect() else {
        // No cmux to tell, but the bash still takes the turn-end ask back.
        let _ = std::fs::remove_file(&asked);
        return 0;
    };
    let h = Hook::new(cmux, ws.clone(), state.clone(), String::new());
    if h.cli_transport() {
        h.cli(&["workspace", "status", "set", "auto"]);
    } else {
        let _ = h.cmux.workspace_status_set(&ws, "auto");
    }
    if asked.exists() {
        let _ = std::fs::remove_file(&asked);
        if std::env::var("CMUX_WORKSPACE_ID").is_ok_and(|v| !v.is_empty()) {
            h.phase("working");
        }
    }
    0
}

pub fn main(args: &[String]) -> i32 {
    use std::io::Write;
    let event = args.first().map(String::as_str).unwrap_or("");
    if event == "pretool" {
        return pretool();
    }
    // The plugin's options, before the guard: they are this machine's
    // whether or not this session is in cmux. Never stdin, never stdout.
    if event == "session" && crew_core::py::env_or("CLAUDE_PLUGIN_ROOT").is_some() {
        let t = spawn::tool("options", &[]);
        let _ = spawn::run(&t.argv, None, None);
    }
    let Some((cmux, ws, state)) = guard() else { return 0 };
    let mut h = Hook::new(cmux, ws, state, read_payload());
    let out = match event {
        "session" => {
            session(&mut h);
            String::new()
        }
        "task" => {
            crate::progress::publish(&h);
            h.phase("working");
            String::new()
        }
        "ask" => {
            mkdir(&h.state);
            touch(&h.state.join(format!("question-{}", h.ws)));
            h.lane_set("needs-attention");
            h.phase("waiting on you");
            let mut q = question(&h.payload);
            if q.is_empty() {
                q = "Claude asked you a question".into();
            }
            h.notify("crew:blocked", &q);
            String::new()
        }
        "answered" => {
            let _ = std::fs::remove_file(h.state.join(format!("question-{}", h.ws)));
            h.lane_release();
            h.phase("working");
            String::new()
        }
        "notification" => {
            h.lane_set("needs-attention");
            h.phase("waiting on you");
            let t = spawn::tool("crew-feed", &["publish", &h.ws]);
            let _ = spawn::detach(&t.argv, None, None);
            let mut message = h.json("message");
            if message.is_empty() {
                message = "Claude needs attention".into();
            }
            h.notify("crew:blocked", &message);
            String::new()
        }
        "stop" => stop(&mut h),
        "end" => {
            h.lane_release();
            h.cli(&["clear-status", "claude"]);
            h.phase("");
            String::new()
        }
        _ => String::new(),
    };
    let mut so = std::io::stdout();
    let _ = so.write_all(out.as_bytes());
    let _ = so.flush();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_labels_match_lib_sh() {
        assert_eq!(ticket_label("dev/graphql-db-schema-updates-proj-961"), "PROJ-961 · graphql-db-schema-updates");
        assert_eq!(ticket_label("proj-961-graphql-db-schema-updates"), "PROJ-961 · graphql-db-schema-updates");
        assert_eq!(ticket_label("dev/thing-proj-123"), "PROJ-123 · thing");
        assert_eq!(ticket_label("PROJ-7"), "PROJ-7");
        assert_eq!(ticket_label("main"), "");
        assert_eq!(ticket_label("dev/port-hooks"), "");
        assert_eq!(ticket_label("a/b/x-ab-12"), "AB-12 · b/x");
    }

    #[test]
    fn basenames() {
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(basename("/"), "/");
        assert_eq!(basename(""), "");
        assert_eq!(basename("x"), "x");
    }

    #[test]
    fn lines_as_sed_reads_them() {
        assert_eq!(line("a\nb\nc", 2), "b");
        assert_eq!(line("a", 3), "");
    }
}
