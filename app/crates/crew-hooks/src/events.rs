//! `seamux crew-hook <event>`: crew/hooks/crew-hook.sh and lib.sh in Rust.
//!
//! ```text
//! seamux crew-hook <session|pretool|prompt|ask|answered|task|notification|stop|end>  < payload
//! ```
//!
//! Beyond the bash: `prompt` (UserPromptSubmit), the state history every
//! event that changes an agent's state appends (crew-core's history), and
//! the pane's own state file (crew-core's status). An event changes only its
//! own pane's file; the workspace's lane, phase: token and question and asked
//! markers then come from the roll-up of every pane in it, so one Claude's
//! turn ending never clears another's ask. The bash and Python copies
//! (crew-hook.sh, lib.sh, crew-sync) are frozen and still key everything by
//! workspace: hooks_probe's two-pane cases run only under CREW_IMPL=rust
//! (ADR 0036).
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
use crew_core::status::{self, Lane, Pane, Rollup};
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
    // The cheap tests first, so a hook outside cmux or with crew disabled
    // never opens a connection.
    let ws = crew_core::py::env_or("CMUX_WORKSPACE_ID")?;
    if crew_core::py::env_or("CREW_DISABLED").is_some() {
        return None;
    }
    let state = state_dir();
    if state.join("disabled").exists() {
        return None;
    }
    let cmux = spawn::connect()?;
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

/// The git toplevel of `dir`, or "".
pub fn toplevel(dir: &str) -> String {
    git(dir, &["rev-parse", "--show-toplevel"]).1
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

    /// One line of state history for this workspace's pane (crew-core's history).
    pub fn history(&self, state: &str, detail: &str) {
        crew_core::history::record(&self.ws, &surface(), state, "hook", detail);
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

    /// The phase: token set to `phase` ("" drops it) and the `clear` keys
    /// dropped, in one read-modify-write, and no write when nothing changed.
    /// The board matches phase:working and phase:waiting.
    pub fn tokens(&self, phase: &str, clear: &[&str]) {
        self.tokens_with(phase, clear, None);
    }

    /// `tokens`, and with `pin` (a directory) the root: token of its git
    /// toplevel added when the description has none (a pin is never moved).
    pub fn tokens_with(&self, phase: &str, clear: &[&str], pin: Option<&str>) {
        let cur = self.desc_get();
        let mut toks: Vec<String> = split_tokens(&cur)
            .into_iter()
            .filter(|t| !t.starts_with("phase:") && !clear.iter().any(|k| t.starts_with(&format!("{k}:"))))
            .map(String::from)
            .collect();
        if !phase.is_empty() {
            toks.push(format!("phase:{phase}"));
        }
        if let Some(dir) = pin.filter(|d| !d.is_empty()) {
            if crew_core::worktree::root_of(&cur).is_none() {
                let root = toplevel(dir);
                if !root.is_empty() {
                    toks.push(crew_core::worktree::root_tok(&root));
                }
            }
        }
        let new = toks.join(" ");
        if new == cur {
            return;
        }
        self.desc_put(&new);
    }

    // ---- this pane, and the workspace's roll-up -------------------------------

    /// Change this pane's state file, roll the workspace up, and tell cmux:
    /// the lane, then (with `phase`) the phase: token, `clear` dropped in the
    /// same write. The roll-up is returned for what else the event decides.
    pub fn settle(&mut self, phase: bool, clear: &[&str], change: impl FnOnce(&mut Pane)) -> Rollup {
        let sid = self.json("session_id");
        let (before, after, _pane) = status::update(&self.state, &self.ws, &surface(), &sid, crew_core::history::now_ms(), change);
        self.lane_to(&before, &after, true);
        if phase {
            self.tokens(after.phase(), clear);
        }
        after
    }

    /// The lane the roll-up asks for. With `always` false a lane already
    /// pinned to it is left alone (pretool's case: no cmux call per tool use).
    fn lane_to(&self, before: &Rollup, after: &Rollup, always: bool) {
        let want = match after.lane {
            Lane::Attention => "needs-attention",
            Lane::Review => "review",
            Lane::Auto => return self.lane_release(),
        };
        if always || before.lane != after.lane || !self.lane_marker().exists() {
            self.lane_set(want);
        }
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

/// The pane this hook runs in, as cmux tells Claude Code, or "".
pub fn surface() -> String {
    crew_core::py::env_or("CMUX_SURFACE_ID").unwrap_or_default()
}

/// What the app reads back to show and answer an ask:
/// `{at, surface, session_id, questions: [{question, header, multiSelect, options: [{label, description}]}]}`.
/// None when the payload carries no questions.
pub fn question_record(payload: &str, surface: &str, at_ms: u64) -> Option<Value> {
    let d: Value = serde_json::from_str(payload).ok()?;
    let qs = d.get("tool_input")?.get("questions")?.as_array()?;
    if qs.is_empty() {
        return None;
    }
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let questions: Vec<Value> = qs
        .iter()
        .map(|q| {
            let options: Vec<Value> = q
                .get("options")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|o| serde_json::json!({"label": s(o, "label"), "description": s(o, "description")})).collect())
                .unwrap_or_default();
            serde_json::json!({
                "question": s(q, "question"),
                "header": s(q, "header"),
                "multiSelect": q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                "options": options,
            })
        })
        .collect();
    Some(serde_json::json!({"at": at_ms, "surface": surface, "session_id": s(&d, "session_id"), "questions": questions}))
}

/// The "waiting for your input" reminder Claude Code sends a while after a
/// turn ends, by its type where the payload carries one, else its words.
pub fn is_idle_reminder(kind: &str, message: &str) -> bool {
    kind == "idle_prompt" || (kind.is_empty() && message.trim_start().starts_with("Claude is waiting for your input"))
}

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
    // A new session is idle until its first prompt: it has not worked yet,
    // and a sibling pane's state stays the workspace's. A compaction also
    // fires SessionStart, often mid-turn: the pane keeps what it was.
    let after = if h.json("source") == "compact" {
        h.settle(false, &[], |_| {})
    } else {
        let r = h.settle(false, &[], |p| {
            p.state = "idle".into();
            p.question = None;
            p.asked = None;
            p.review = false;
        });
        h.history("idle", "session");
        r
    };
    // A workspace made outside the Dock form has no pin yet: the first
    // session pins it to its worktree, in the same write as the phase.
    h.tokens_with(after.phase(), &[], Some(&cwd));
    h.listen_ensure();
}

fn stop(h: &mut Hook) -> String {
    if h.json("stop_hook_active") == "True" {
        return String::new();
    }
    let cwd = h.cwd();
    let br = branch(&cwd);
    let review = has_unreviewed_work(&cwd);
    // A turn cannot end with its AskUserQuestion still open: one cancelled
    // with Esc fires no answered event, so its question goes here. The
    // turn-end judgment, spawned below, sets asked again if it finds one.
    // Only this pane's: another Claude's ask in the workspace stays.
    let sid = h.json("session_id");
    let (before, after, _pane) = status::update(&h.state, &h.ws, &surface(), &sid, crew_core::history::now_ms(), |p| {
        p.state = "idle".into();
        p.question = None;
        p.asked = None;
        p.review = review;
    });
    h.lane_to(&before, &after, true);
    if !after.busy() {
        h.cli(&["clear-status", "claude"]);
    }
    h.history("idle", "stop");
    // The feed's tokens describe the ask a pane waits on: they stay while one does.
    let feed: &[&str] = if after.state == "needs_input" { &[] } else { &["feed", "feedby", "feedgate", "feedreq", "feedws"] };
    h.tokens(after.phase(), feed);
    let body = if br.is_empty() { "Turn complete".to_string() } else { format!("Turn complete — {br}") };
    h.notify("crew:turn", &body);
    h.sync_maybe();

    // TypeSafe's turn-end judgment, detached so the turn never waits on it.
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

/// pretool, past seamux-hook.sh's hold test: this pane is at work again, so
/// what it held (a wait, a turn-end ask, the review lane) is released, and
/// the workspace's lane and phase follow the roll-up. A sibling pane that
/// still waits keeps the workspace waiting.
fn pretool() -> i32 {
    let state = state_dir();
    let in_ws = std::env::var("CMUX_WORKSPACE_ID").ok().filter(|v| !v.is_empty());
    let ws = in_ws.clone().unwrap_or_else(|| "none".into());
    // A marker left from before pane files (or written by the bash) still
    // means a turn-end ask is taken back.
    let legacy_ask = state.join(format!("asked-{ws}")).exists();
    let (before, after, _pane) = status::update(&state, &ws, &surface(), "", crew_core::history::now_ms(), |p| {
        p.state = "working".into();
        p.asked = None;
        p.review = false;
    });
    // Back from waiting on you: the phase is the roll-up's again.
    let resumed = before.state == "needs_input" || before.asked.is_some() || legacy_ask;
    let Some(cmux) = spawn::connect() else {
        // No cmux to tell: the files are in step, and the lane marker goes
        // when nothing in the workspace pins it.
        if after.lane == Lane::Auto {
            let _ = std::fs::remove_file(state.join(format!("lane-{ws}")));
        }
        return 0;
    };
    let h = Hook::new(cmux, ws, state, String::new());
    h.lane_to(&before, &after, false);
    if resumed && in_ws.is_some() {
        h.tokens(after.phase(), &[]);
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
            h.settle(true, &[], |p| p.state = "working".into());
            String::new()
        }
        "ask" => {
            // The app's record of the questions; `{}` still marks an ask.
            let rec = question_record(&h.payload, &surface(), crew_core::history::now_ms()).unwrap_or_else(|| serde_json::json!({}));
            h.history("needs_input", "ask");
            h.settle(true, &[], |p| {
                p.state = "needs_input".into();
                p.question = Some(rec);
            });
            let mut q = question(&h.payload);
            if q.is_empty() {
                q = "Claude asked you a question".into();
            }
            h.notify("crew:blocked", &q);
            String::new()
        }
        "answered" => {
            h.history("working", "answered");
            h.settle(true, &[], |p| {
                p.state = "working".into();
                p.question = None;
            });
            String::new()
        }
        // UserPromptSubmit: the person typed into the pane, so whatever it
        // waited on is answered and the agent is at work again.
        "prompt" => {
            h.history("working", "prompt");
            h.settle(true, &[], |p| {
                p.state = "working".into();
                p.question = None;
                p.asked = None;
                p.review = false;
            });
            String::new()
        }
        "notification" => {
            // Claude Code's idle reminder after a finished turn is no new
            // block: the turn's own stop (and the asked judgment) said what
            // the agent waits on.
            if !is_idle_reminder(&h.json("notification_type"), &h.json("message")) {
                h.history("needs_input", "notification");
            }
            h.settle(true, &[], |p| p.state = "needs_input".into());
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
            // The session is over: nothing it asked waits any more.
            h.history("ended", "end");
            let sid = h.json("session_id");
            let (before, after, _pane) = status::update(&h.state, &h.ws, &surface(), &sid, crew_core::history::now_ms(), |p| {
                p.state = "ended".into();
                p.question = None;
                p.asked = None;
                p.review = false;
            });
            h.lane_to(&before, &after, true);
            if !after.busy() {
                h.cli(&["clear-status", "claude"]);
            }
            h.tokens(after.phase(), &[]);
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

    #[test]
    fn the_question_record_keeps_every_question_and_option() {
        let payload = r#"{"session_id": "S1", "tool_name": "AskUserQuestion", "tool_input": {"questions": [
            {"question": "Which?", "header": "Pick", "multiSelect": false,
             "options": [{"label": "A", "description": "first"}, {"label": "B"}]},
            {"question": "And?", "multiSelect": true, "options": [{"label": "C", "description": "x", "preview": "p"}]}]}}"#;
        let r = question_record(payload, "SURF", 7).unwrap();
        assert_eq!(r["at"], 7);
        assert_eq!(r["surface"], "SURF");
        assert_eq!(r["session_id"], "S1");
        let qs = r["questions"].as_array().unwrap();
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0]["options"][1], serde_json::json!({"label": "B", "description": ""}));
        assert_eq!(qs[1]["multiSelect"], true);
        assert_eq!(qs[1]["header"], "");
        // Only what the app needs: a preview is not kept.
        assert!(qs[1]["options"][0].get("preview").is_none());
    }

    #[test]
    fn the_idle_reminder_is_told_from_a_block() {
        assert!(is_idle_reminder("idle_prompt", ""));
        assert!(is_idle_reminder("", "Claude is waiting for your input"));
        assert!(!is_idle_reminder("permission_prompt", "Claude is waiting for your input"));
        assert!(!is_idle_reminder("", "Claude needs your permission to use Bash"));
    }

    #[test]
    fn no_questions_no_record() {
        assert!(question_record("{}", "", 0).is_none());
        assert!(question_record(r#"{"tool_input": {"questions": []}}"#, "", 0).is_none());
        assert!(question_record("not json", "", 0).is_none());
    }
}
