//! A native terminal's plumbing: a PTY whose session leader is a tmux client
//! attached to a cmux local-tmux session. tmux owns the session (its process
//! and scrollback); cmux and the app are both clients of it. The page draws
//! the bytes with xterm.js and sends keys and sizes back.
//!
//! The app runs `tmux -S <socket> attach -t =<session>` itself rather than
//! `cmux local-tmux attach --headless`: that wrapper runs tmux outside the
//! terminal's foreground process group, so a resize never reaches it.

use std::fs::File;
use std::io::Write;
use std::os::fd::{FromRawFd, OwnedFd};
use std::process::{Child, Command, Stdio};

use serde_json::Value;

// The native start lives in crew-core, so crew's own tools start sessions
// the same way the app does.
use crew_core::native::{cmux_ok, tmux_ok, tmux_out};
pub use crew_core::native::{claude_line, field, open_native_workspace, sh_quote, start_native, start_native_with, surfaces_in, tmux_bin, PANE_VARS};

pub use crew_core::backend::cmux::{client_surface, live, live_sessions, name_ok, registry_target};
pub use crew_core::backend::Target;

/// The tmux session behind `pane`, if it has one: asked of the app's backend
/// (cmux's local-tmux registry, or the app's own tmux).
pub fn target_for(pane: &str) -> Result<Option<Target>, String> {
    crate::backend::get()?.target(pane)
}

/// The surfaces (upper case) of native panes with a Claude running inside
/// their tmux session. `panes` are (client surface, the session's pane pid);
/// `procs` is `ps -axo pid=,ppid=,command=`. cmux sees only the tmux client
/// in such a pane, so it reports no agent there.
pub fn claude_in_panes(panes: &[(String, u32)], procs: &str) -> Vec<String> {
    let mut kids: std::collections::HashMap<u32, Vec<u32>> = Default::default();
    let mut cmd: std::collections::HashMap<u32, String> = Default::default();
    for line in procs.lines() {
        let mut f = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (f.next().and_then(|v| v.parse::<u32>().ok()), f.next().and_then(|v| v.parse::<u32>().ok())) else { continue };
        let first = f.next().unwrap_or("").to_string();
        kids.entry(ppid).or_default().push(pid);
        cmd.insert(pid, first);
    }
    let is_claude = |c: &str| c.rsplit('/').next() == Some("claude");
    let mut out: Vec<String> = Vec::new();
    for (surface, root) in panes {
        let mut stack = vec![*root];
        let mut seen = std::collections::HashSet::new();
        while let Some(pid) = stack.pop() {
            if !seen.insert(pid) {
                continue;
            }
            if cmd.get(&pid).is_some_and(|c| is_claude(c)) {
                let s = surface.to_uppercase();
                if !out.contains(&s) {
                    out.push(s);
                }
                break;
            }
            stack.extend(kids.get(&pid).cloned().unwrap_or_default());
        }
    }
    out
}

/// What a native pane tells the Wall besides its text: the command its
/// shell (or Claude's) is running, and whether it rang the bell since it was
/// last looked at.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PaneSignals {
    pub running: Option<String>,
    pub bell: bool,
    /// What Claude says the conversation is about: the short topic Claude
    /// Code puts in the terminal title once it has read the first prompt.
    pub topic: Option<String>,
}

/// The topic in a Claude pane's title ("✳ Fix Dock button sizes"): its
/// spinner or mark taken off, None while it is still Claude Code's own
/// name (no prompt read yet). The mark is one character and a space (tmux
/// may print it as "_" when it has no UTF-8 client); a topic's own leading
/// punctuation, "(WIP) fix", stays.
pub fn topic_of(title: &str) -> Option<String> {
    let t = title.trim();
    let mut cs = t.chars();
    let t = match (cs.next(), cs.next()) {
        (Some(m), Some(' ')) if !m.is_alphanumeric() => cs.as_str().trim(),
        _ => t,
    };
    if t.is_empty() || t == "Claude Code" || t.eq_ignore_ascii_case("claude") {
        return None;
    }
    let mut out: String = t.chars().filter(|c| !c.is_control()).take(60).collect();
    if t.chars().count() > 60 {
        out.push('…');
    }
    Some(out)
}

const SHELLS: [&str; 5] = ["zsh", "bash", "sh", "fish", "dash"];

fn base(word: &str) -> &str {
    word.trim_start_matches('-').rsplit('/').next().unwrap_or(word)
}

/// The command a shell under `root` is running now, newest first, as a
/// short name ("cargo test"). Only a shell's children count: a program's
/// own helpers (Claude's MCP servers, a compiler's workers) do not. `procs`
/// is `ps -axo pid=,ppid=,command=`.
pub fn running_under(root: u32, procs: &str) -> Option<String> {
    let mut kids: std::collections::HashMap<u32, Vec<u32>> = Default::default();
    let mut argv: std::collections::HashMap<u32, Vec<&str>> = Default::default();
    for line in procs.lines() {
        let mut f = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (f.next().and_then(|v| v.parse::<u32>().ok()), f.next().and_then(|v| v.parse::<u32>().ok())) else { continue };
        kids.entry(ppid).or_default().push(pid);
        argv.insert(pid, f.collect());
    }
    let name = |pid: u32| argv.get(&pid).and_then(|a| a.first()).map(|w| base(w)).unwrap_or("");
    let is_shell = |pid: u32| SHELLS.contains(&name(pid));
    let mut best: Option<u32> = None;
    let mut stack = vec![root];
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        for &k in kids.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
            let quiet = matches!(name(k), "claude" | "cmux" | "crew" | "tmux");
            if is_shell(pid) && !is_shell(k) && !quiet {
                best = best.max(Some(k));
            } else {
                stack.push(k);
            }
        }
    }
    let a = argv.get(&best?)?;
    let mut out = base(a.first()?).to_string();
    if let Some(arg) = a.get(1).filter(|w| !w.starts_with('-') && !w.contains('/') && w.len() <= 20) {
        out.push(' ');
        out.push_str(arg);
    }
    Some(out.chars().take(32).collect())
}

/// Which native panes have a Claude in them now: the registry's sessions, each
/// session's pane process, and one look at the process table.
pub fn native_claude_now() -> std::collections::HashSet<String> {
    native_now().0
}

/// One look at every native pane: the surfaces with a Claude in them, and
/// each surface's signals (what runs, a bell).
pub fn native_now() -> (std::collections::HashSet<String>, std::collections::HashMap<String, PaneSignals>) {
    let file = crew_core::py::home().join(".cmux/local-tmux/sessions.json");
    let Some(reg) = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return Default::default() };
    let mut panes: Vec<(String, u32)> = Vec::new();
    let mut bells: std::collections::HashSet<String> = Default::default();
    let mut titles: std::collections::HashMap<String, String> = Default::default();
    for s in reg.get("sessions").and_then(Value::as_array).into_iter().flatten() {
        let (Some(surface), Some(name), Some(sock)) = (
            s.get("surfaceID").and_then(Value::as_str),
            s.get("name").and_then(Value::as_str).filter(|n| name_ok(n)),
            s.get("socketPath").and_then(Value::as_str).filter(|p| !p.is_empty()),
        ) else {
            continue;
        };
        let Ok(o) = Command::new(tmux_bin()).args(["-S", sock, "list-panes", "-t", &format!("={name}"), "-F", "#{pane_pid}|#{@seamux_bell}|#{@seamux_role}|#{pane_title}"]).stderr(Stdio::null()).output() else { continue };
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let mut w = line.splitn(4, SEP);
            let Some(pid) = w.next().and_then(|v| v.trim().parse::<u32>().ok()) else { continue };
            if w.next() == Some("1") {
                bells.insert(surface.to_uppercase());
            }
            // Claude's pane, not the companion shell: its title is the topic.
            if w.next() != Some("shell") {
                if let Some(title) = w.next() {
                    titles.insert(surface.to_uppercase(), title.to_string());
                }
            }
            panes.push((surface.to_string(), pid));
        }
    }
    if panes.is_empty() {
        return Default::default();
    }
    let Ok(ps) = Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output() else { return Default::default() };
    let procs = String::from_utf8_lossy(&ps.stdout);
    let claude: std::collections::HashSet<String> = claude_in_panes(&panes, &procs).into_iter().collect();
    let mut signals: std::collections::HashMap<String, PaneSignals> = Default::default();
    for (surface, pid) in &panes {
        let s = signals.entry(surface.to_uppercase()).or_default();
        s.running = s.running.take().or_else(|| running_under(*pid, &procs));
        s.bell = bells.contains(&surface.to_uppercase());
        // A topic only where Claude runs: a shell's title is the host's name.
        if claude.iter().any(|c| c.eq_ignore_ascii_case(surface)) {
            s.topic = titles.get(&surface.to_uppercase()).and_then(|t| topic_of(t));
        }
    }
    (claude, signals)
}

/// The pane was looked at: its bell is heard.
pub fn bell_seen(t: &Target) -> Result<(), String> {
    tmux_ok(&t.socket, &["set-option", "-t", &t.session, "-u", "@seamux_bell"])
}







/// Leave copy mode, where the wheel put a pane, so typed keys reach the
/// program again: every pane of the session's window (with the companion
/// shell shown, the wheel may have scrolled either). Nothing happens to a
/// pane not in a mode.
pub fn leave_scroll(t: &Target) -> Result<(), String> {
    let ids = tmux_out(&t.socket, &["list-panes", "-t", &format!("{}:", t.session), "-F", "#{pane_id}"])?;
    for id in ids.lines().filter(|l| l.starts_with('%')) {
        tmux_ok(&t.socket, &["copy-mode", "-q", "-t", id])?;
    }
    Ok(())
}

/// Where tmux's copy mode has the session's panes: (one is in it, its lines
/// up from the bottom, its lines of history), the furthest back of them.
/// None when tmux cannot say.
pub fn scroll_state(t: &Target) -> Option<(bool, u64, u64)> {
    let out = tmux_out(&t.socket, &["list-panes", "-t", &format!("{}:", t.session), "-F", "#{pane_in_mode} #{scroll_position} #{history_size}"]).ok()?;
    Some(furthest_scroll(&out))
}

/// Of `list-panes` lines "<in mode> <scroll position> <history>", the pane
/// scrolled furthest back; (false, 0, 0) when none is in copy mode.
pub fn furthest_scroll(lines: &str) -> (bool, u64, u64) {
    let mut best = (false, 0, 0);
    for l in lines.lines() {
        let mut w = l.split_whitespace();
        if w.next() != Some("1") {
            continue;
        }
        let pos = w.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let hist = w.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        if !best.0 || pos > best.1 {
            best = (true, pos, hist);
        }
    }
    best
}

/// The field separator in list-panes formats. Not a tab: tmux 3.8 prints a
/// tab in -F output as "_". The path comes last, so a "|" in it is kept.
const SEP: char = '|';

/// The session's own pane: the one that is not the companion shell, where
/// Claude runs. Its id ("%3").
pub fn main_pane(t: &Target) -> Option<String> {
    let out = tmux_out(&t.socket, &["list-panes", "-t", &format!("{}:", t.session), "-F", "#{pane_id}|#{@seamux_role}"]).ok()?;
    out.lines().find_map(|l| l.split_once(SEP).filter(|(_, role)| *role != "shell").map(|(id, _)| id.to_string()))
}

/// Line-editing keys the pane's ⌘ keys stand for, sent with send-keys so
/// a tmux prefix bound to one of them (C-a is common) never takes it.
pub const LINE_KEYS: [&str; 3] = ["C-a", "C-e", "C-u"];

/// Send one of LINE_KEYS to the pane that has the keys.
pub fn send_line_key(t: &Target, key: &str) -> Result<(), String> {
    if !LINE_KEYS.contains(&key) {
        return Err(format!("not a line key: {key:?}"));
    }
    tmux_ok(&t.socket, &["send-keys", "-t", &format!("={}:", t.session), key])
}


/// The alert-bell slot seamux's hook takes.
pub const BELL_HOOK: &str = "alert-bell[87]";

/// What the companion shell's border says: "shell · <what runs>". Other
/// panes' borders say nothing.
const SHELL_BORDER: &str = "#{?#{==:#{@seamux_role},shell}, shell · #{pane_current_command} ,}";

/// Show or hide the session's companion shell: a split under Claude, in the
/// same folder, made the first time. Hiding zooms Claude's pane, so the
/// shell keeps running. Returns whether the shell shows now (and has the keys).
pub fn toggle_shell(t: &Target) -> Result<bool, String> {
    let win = format!("{}:", t.session);
    let list = tmux_out(&t.socket, &["list-panes", "-t", &win, "-F", "#{pane_id}|#{@seamux_role}|#{window_zoomed_flag}|#{pane_current_path}"])?;
    let rows: Vec<Vec<&str>> = list.lines().map(|l| l.splitn(4, SEP).collect()).filter(|r: &Vec<&str>| r.len() == 4).collect();
    let main = rows.iter().find(|r| r[1] != "shell").ok_or("the session has no pane")?;
    let shell = rows.iter().find(|r| r[1] == "shell");
    let zoomed = main[2] == "1";
    match shell {
        None => {
            let id = tmux_out(&t.socket, &["split-window", "-v", "-l", "30%", "-t", main[0], "-c", main[3], "-P", "-F", "#{pane_id}"])?;
            tmux_ok(&t.socket, &["set-option", "-p", "-t", &id, "@seamux_role", "shell"])?;
            tmux_ok(&t.socket, &["set-option", "-w", "-t", &win, "pane-border-status", "top"])?;
            tmux_ok(&t.socket, &["set-option", "-w", "-t", &win, "pane-border-format", SHELL_BORDER])?;
            Ok(true)
        }
        Some(sh) if zoomed => {
            tmux_ok(&t.socket, &["resize-pane", "-Z", "-t", main[0]])?;
            tmux_ok(&t.socket, &["select-pane", "-t", sh[0]])?;
            Ok(true)
        }
        Some(_) => {
            tmux_ok(&t.socket, &["select-pane", "-t", main[0]])?;
            tmux_ok(&t.socket, &["resize-pane", "-Z", "-t", main[0]])?;
            Ok(false)
        }
    }
}






/// The terminal (`ttys003`, no /dev/) of surface `surface` (its id or ref)
/// in cmux's `tree --json`.
pub fn surface_tty(tree: &Value, surface: &str) -> Option<String> {
    let arr = |v: &Value, k: &str| v.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    arr(tree, "windows")
        .iter()
        .flat_map(|w| arr(w, "workspaces"))
        .flat_map(|w| arr(&w, "panes"))
        .flat_map(|p| arr(&p, "surfaces"))
        .find(|s| ["id", "ref"].iter().any(|k| s.get(*k).and_then(Value::as_str).is_some_and(|v| v.eq_ignore_ascii_case(surface))))
        .and_then(|s| s.get("tty").and_then(Value::as_str).map(|t| t.trim_start_matches("/dev/").to_string()))
        .filter(|t| !t.is_empty())
}

/// Whether `ps -o tty=,command=` of one pid shows a Claude on terminal `tty`.
pub fn is_claude_on(ps: &str, tty: &str) -> bool {
    let Some(line) = ps.lines().find(|l| !l.trim().is_empty()) else { return false };
    let line = line.trim_start();
    let (t, cmd) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    !tty.is_empty() && t.trim_start_matches("/dev/") == tty.trim_start_matches("/dev/") && cmd.contains("claude")
}

/// The Claude that runs in a pane, by cmux's records: its session, the
/// directory it runs in, and its process.
#[derive(Debug, PartialEq)]
pub struct Running {
    pub session: String,
    pub cwd: String,
    pub pid: i32,
}

/// The pane's running Claude: a record on `surface` whose process still
/// exists. None when no Claude runs there, or its record is not whole.
pub fn running_on(records: &[Value], surface: &str) -> Option<Running> {
    let str_of = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    records.iter().find_map(|r| {
        let mine = r.get("agent").and_then(Value::as_str).is_none_or(|a| a == "claude")
            && r.get("surface_id").and_then(Value::as_str).is_some_and(|s| s.eq_ignore_ascii_case(surface))
            && r.get("stored_pid_exists").and_then(Value::as_bool) == Some(true);
        if !mine {
            return None;
        }
        let session = str_of(r, "session_id");
        let pid = r.get("pid").and_then(Value::as_i64).filter(|p| *p > 1)? as i32;
        let cwd = ["cwd", "launch_working_directory"].iter().map(|k| str_of(r, k)).find(|c| !c.is_empty())?;
        cmux::is_uuid(&session).then_some(Running { session, cwd, pid })
    })
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Move the Claude running in `surface` to a native session in workspace
/// `ws`: stop it, resume its conversation natively, then close the old pane.
/// Two Claudes never write the conversation at once: the resume starts only
/// once the old process is gone. Returns the new pane's surface id.
pub fn move_native(ws: &str, surface: &str, run: &Running) -> Result<String, String> {
    if crew_core::backend::cmux::target_for(surface)?.is_some() {
        return Err("this pane is already a native session".into());
    }
    // The pid is cmux's record, and pids are reused: make sure it is still a
    // Claude, and one on this pane's terminal.
    let c = cmux::Cmux::connect().map_err(|e| format!("cmux: {e}"))?;
    let tree = c.tree().map_err(|e| format!("cmux tree: {e}"))?;
    // Surfaces carry `tty` in `cmux tree --json` (measured: docs/FINDINGS.md,
    // "cmux tree lists each terminal surface's tty"). Without it, refuse.
    let tty = surface_tty(&tree, surface).ok_or("cmux did not say which terminal this pane is, so its Claude was left running")?;
    let out = Command::new("ps").args(["-o", "tty=,command=", "-p", &run.pid.to_string()]).output().map_err(|e| e.to_string())?;
    if !is_claude_on(&String::from_utf8_lossy(&out.stdout), &tty) {
        return Err(format!("process {} is no longer this pane's Claude", run.pid));
    }
    // SAFETY: kill(2) on the pane's Claude, checked just above.
    unsafe {
        libc::kill(run.pid, libc::SIGTERM);
    }
    let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while alive(run.pid) {
        if std::time::Instant::now() > until {
            return Err("Claude did not exit; it is still in its pane".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let new = start_native(ws, &run.cwd, Some(&run.session))
        .map_err(|e| format!("Claude stopped, but the native session did not start ({e}); resume it in its pane"))?;
    // The old pane is a shell now, or gone with its Claude. (A surface is
    // looked up in the workspace given, which defaults to the caller's.)
    let _ = cmux_ok(&["close-surface", "--surface", surface, "--workspace", ws, "--force"]);
    Ok(new)
}



/// A tmux client in a PTY.
pub struct Pty {
    master: File,
    child: Child,
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(2), ws_col: cols.max(2), ws_xpixel: 0, ws_ypixel: 0 }
}

impl Pty {
    /// Attach to `t` at cols x rows. The child is the PTY's session leader,
    /// so a resize's SIGWINCH reaches it.
    /// `-T hyperlinks`: xterm.js draws OSC 8 links, so tmux passes Claude's on
    /// (it strips them for a client it thinks cannot).
    pub fn attach(t: &Target, cols: u16, rows: u16) -> Result<Pty, String> {
        // History kept for the wheel to scroll back through: tmux sets it
        // when a pane is made, so this reaches sessions started from now on.
        // Raised, never lowered: a tmux.conf may keep more.
        let had = tmux_out(&t.socket, &["show-options", "-gv", "history-limit"]).ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        if had < 10_000 {
            let _ = tmux_ok(&t.socket, &["set-option", "-g", "history-limit", "10000"]);
        }
        // Claude in fullscreen selects and copies itself, asking tmux (OSC 52)
        // to set the clipboard; "external", tmux's default, refuses programs.
        let _ = tmux_ok(&t.socket, &["set-option", "-s", "set-clipboard", "on"]);
        // Shift+Enter a newline in Claude, for sessions made before it was set.
        let _ = crew_core::native::keys_through(&t.socket);
        // A bell marks its session (even in the window a client shows, where
        // tmux sets no flag of its own) until the pane is looked at.
        // A slot of its own in the hook's list, so a tmux.conf's own bell
        // hooks keep running, and setting it again changes nothing.
        let _ = tmux_ok(&t.socket, &["set-hook", "-g", BELL_HOOK, "set-option @seamux_bell 1"]);
        Self::spawn(&tmux_bin(), &["-T", "hyperlinks", "-S", &t.socket, "attach-session", "-t", &format!("={}", t.session)], cols, rows)
    }

    /// Run `program args` with a new PTY as its controlling terminal.
    pub fn spawn(program: &str, args: &[&str], cols: u16, rows: u16) -> Result<Pty, String> {
        let (mut m, mut s) = (0, 0);
        let mut ws = winsize(cols, rows);
        // SAFETY: openpty writes two descriptors it opened; null name and termios are allowed.
        let rc = unsafe { libc::openpty(&mut m, &mut s, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) };
        if rc != 0 {
            return Err(format!("openpty: {}", std::io::Error::last_os_error()));
        }
        // Close-on-exec, at once: a terminal attached on another thread must
        // not inherit this one's descriptors (it would hold the slave open,
        // and this master would never see its client hang up).
        // SAFETY: m and s are open descriptors openpty just returned.
        unsafe {
            libc::fcntl(m, libc::F_SETFD, libc::FD_CLOEXEC);
            libc::fcntl(s, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        // SAFETY: both descriptors are ours from here on.
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(m), OwnedFd::from_raw_fd(s)) };
        let io = |fd: &OwnedFd| fd.try_clone().map(Stdio::from).map_err(|e| e.to_string());
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(io(&slave)?).stdout(io(&slave)?).stderr(io(&slave)?).env("TERM", "xterm-256color").env("COLORTERM", "truecolor");
        // Inside a cmux pane or tmux the app's own variables would mislead tmux.
        cmd.env_remove("TMUX").env_remove("TMUX_PANE");
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
        drop(slave);
        Ok(Pty { master: File::from(master), child })
    }

    /// A second handle on the output, for a reader thread. It reads until the
    /// client exits (EOF, or EIO once the PTY's other side is gone).
    pub fn reader(&self) -> Result<File, String> {
        self.master.try_clone().map_err(|e| e.to_string())
    }

    /// A second handle on the input, for a writer thread that writes keys in
    /// the order they came.
    pub fn writer(&self) -> Result<File, String> {
        self.master.try_clone().map_err(|e| e.to_string())
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.master.write_all(data).map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        let ws = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ reads one winsize from a valid pointer.
        let rc = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
        if rc != 0 {
            return Err(format!("resize: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }

    /// The client's pid, so it can be ended without the lock a write holds.
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Whether the client is still running.
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// End the client (tmux detaches it; the session lives on) and reap it.
    pub fn close(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn surfaces_of_one_workspace_from_the_tree() {
        let tree = serde_json::json!({"windows": [{"workspaces": [
            {"id": "AB79E681-B8EF-45FA-90AD-1AE7CC0E2456", "panes": [{"surfaces": [{"ref": "surface:1"}, {"ref": "surface:2"}]}]},
            {"id": "0E560759-0416-40C7-BC72-5AC8F6BE7C07", "panes": [{"surfaces": [{"ref": "surface:3"}]}]},
        ]}]});
        assert_eq!(super::surfaces_in(&tree, "ab79e681-b8ef-45fa-90ad-1ae7cc0e2456"), ["surface:1", "surface:2"]);
        assert!(super::surfaces_in(&tree, "1E560759-0416-40C7-BC72-5AC8F6BE7C07").is_empty());
    }

    /// Live: moves the Claude in MOVE_SURFACE (workspace MOVE_WS, both UUIDs)
    /// to a native session. It stops that Claude: point it at a throwaway.
    #[test]
    #[ignore]
    fn pty_moves_a_running_claude() {
        let (surface, ws) = (std::env::var("MOVE_SURFACE").unwrap(), std::env::var("MOVE_WS").unwrap());
        let recs = crew_core::workspaces::agent_sessions().unwrap();
        let run = running_on(&recs, &surface).expect("a running Claude there");
        let new = move_native(&ws, &surface, &run).unwrap();
        assert!(!alive(run.pid));
        assert!(crew_core::backend::cmux::target_for(&new).unwrap().is_some());
        println!("moved {} to {new}", run.session);
    }

    #[test]
    fn a_reused_pid_is_not_the_panes_claude() {
        let tree = serde_json::json!({"windows": [{"workspaces": [{"panes": [{"surfaces": [
            {"id": "AB-1", "ref": "surface:1", "tty": "/dev/ttys003"},
            {"id": "AB-2", "ref": "surface:2"}]}]}]}]});
        assert_eq!(super::surface_tty(&tree, "ab-1").as_deref(), Some("ttys003"));
        assert_eq!(super::surface_tty(&tree, "surface:1").as_deref(), Some("ttys003"));
        assert_eq!(super::surface_tty(&tree, "AB-2"), None);
        assert!(super::is_claude_on("ttys003  claude --resume x\n", "ttys003"));
        assert!(super::is_claude_on("ttys003 node /opt/lib/claude-code/cli.js\n", "/dev/ttys003"));
        // Same name, another terminal (or none): a different process now.
        assert!(!super::is_claude_on("ttys007 claude\n", "ttys003"));
        assert!(!super::is_claude_on("??       /usr/local/bin/claude-helper\n", "ttys003"));
        assert!(!super::is_claude_on("ttys003 -zsh\n", "ttys003"));
        assert!(!super::is_claude_on("", "ttys003"));
    }

    #[test]
    fn running_on_finds_the_panes_live_claude() {
        let a = "f845cb03-378e-4332-8f2f-cef27e50e0c4";
        let recs = vec![
            serde_json::json!({"agent": "claude", "surface_id": "S1", "stored_pid_exists": false, "pid": 10, "session_id": a, "cwd": "/x"}),
            serde_json::json!({"agent": "codex", "surface_id": "s1", "stored_pid_exists": true, "pid": 11, "session_id": a, "cwd": "/x"}),
            serde_json::json!({"agent": "claude", "surface_id": "s1", "stored_pid_exists": true, "pid": 12, "session_id": a, "launch_working_directory": "/w"}),
            serde_json::json!({"agent": "claude", "surface_id": "S2", "stored_pid_exists": true, "pid": 13, "session_id": "nope", "cwd": "/x"}),
        ];
        assert_eq!(running_on(&recs, "S1"), Some(Running { session: a.into(), cwd: "/w".into(), pid: 12 }));
        assert_eq!(running_on(&recs, "S2"), None);
        assert_eq!(running_on(&recs, "S3"), None);
    }
    use super::*;

    use serde_json::json;
    use std::io::Read;
    use std::time::{Duration, Instant};

    #[test]
    fn running_is_what_a_shell_runs_not_a_programs_helpers() {
        // pane shell 10 -> claude 11 -> MCP node 12, and zsh -c 13 -> cargo 14 -> rustc 15
        let procs = "10 1 -zsh\n11 10 claude --resume x\n12 11 node /mcp/server.js\n13 11 /bin/zsh -c eval 'cargo test'\n14 13 cargo test --workspace\n15 14 rustc --crate-name x\n";
        assert_eq!(running_under(10, procs).as_deref(), Some("cargo test"));
        // Claude alone, between commands: nothing runs.
        assert_eq!(running_under(10, "10 1 -zsh\n11 10 claude\n12 11 node /mcp/s.js\n"), None);
        // A plain shell's foreground job; a path argument is left off.
        assert_eq!(running_under(20, "20 1 -zsh\n21 20 /usr/bin/vim /tmp/x.rs\n").as_deref(), Some("vim"));
        // cmux's own hooks are not news.
        assert_eq!(running_under(20, "20 1 zsh\n21 20 cmux claude-hook stop\n"), None);
    }

    #[test]
    fn pty_reads_live_sessions_and_their_client() {
        let list = json!({"socket_path": "/s/server.sock", "sessions": [
            {"session_name": "a", "live": true, "socket_path": "/s/server.sock"},
            {"session_name": "gone", "live": false},
            {"session_name": "b", "live": true}
        ]});
        assert_eq!(live_sessions(&list), vec![("a".into(), "/s/server.sock".into()), ("b".into(), "/s/server.sock".into())]);
        assert_eq!(client_surface(&json!({"surface_id": "76B6D503-5A78"})), "76B6D503-5A78");
        assert_eq!(client_surface(&json!({})), "");
        assert!(name_ok("seamux-spike_1.2") && !name_ok("a b") && !name_ok("") && !name_ok("x;rm"));
        let reg = json!({"version": 1, "sessions": [
            {"name": "nt", "socketPath": "/s/server.sock", "surfaceID": "76B6D503-5A78"},
            {"name": "bad name", "socketPath": "/s/server.sock", "surfaceID": "AAAA"}
        ]});
        assert_eq!(registry_target(&reg, "76b6d503-5a78"), Some(Target { socket: "/s/server.sock".into(), session: "nt".into() }));
        assert_eq!(registry_target(&reg, "AAAA"), None, "a name tmux would misread is refused");
        assert_eq!(registry_target(&reg, "BBBB"), None);
        let ok = "OK session=claude-1a2b surface=A7954A0D-17EC-45D2-95EC-FE3B946EC787 mode=local-tmux";
        assert_eq!(field(ok, "surface").as_deref(), Some("A7954A0D-17EC-45D2-95EC-FE3B946EC787"));
        assert_eq!(field(ok, "socket"), None);
        assert_eq!(claude_line(None).unwrap(), "claude");
        assert_eq!(claude_line(Some("21b4ad73-7b2a-4926-a7dc-33f10ebfac32")).unwrap(), "claude --resume 21b4ad73-7b2a-4926-a7dc-33f10ebfac32");
        assert!(claude_line(Some("x; rm -rf /")).is_err());
        assert!(PANE_VARS.contains(&"CMUX_SURFACE_ID") && PANE_VARS.contains(&"PATH"));
        assert_eq!(topic_of("✳ Fix Dock button sizes").as_deref(), Some("Fix Dock button sizes"));
        assert_eq!(topic_of("_ Workspace status reporting bugs").as_deref(), Some("Workspace status reporting bugs"));
        assert_eq!(topic_of("⠂ Claude Code"), None);
        assert_eq!(topic_of("  "), None);
        assert_eq!(topic_of("✳ (WIP) fix the gate").as_deref(), Some("(WIP) fix the gate"));
        assert_eq!(topic_of("Plain topic").as_deref(), Some("Plain topic"));
        assert_eq!(topic_of(&format!("✳ {}", "a".repeat(80))).map(|t| t.chars().count()), Some(61));
        assert_eq!(sh_quote("/bin/zsh"), "/bin/zsh");
        assert_eq!(sh_quote("/opt/a b/bin/fish"), "'/opt/a b/bin/fish'");
        assert_eq!(sh_quote("/x/it's"), r"'/x/it'\''s'");
    }

    /// Read from `r` until `want` shows up (or the time runs out).
    fn read_until(r: &mut File, want: &str, secs: u64) -> String {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut r = r.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = r.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let end = Instant::now() + Duration::from_secs(secs);
        let mut seen = String::new();
        while Instant::now() < end && !seen.contains(want) {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(100)) {
                seen.push_str(&String::from_utf8_lossy(&b));
            }
        }
        seen
    }

    fn tmux(sock: &str, args: &[&str]) -> String {
        let o = Command::new(tmux_bin()).arg("-S").arg(sock).args(args).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    /// Live against cmux: PTY_SURFACE=<a local-tmux client's surface id>
    /// cargo test -p seamux-app --lib -- --ignored pty_finds_a_cmux_session
    #[test]
    #[ignore]
    fn pty_finds_a_cmux_session() {
        let s = std::env::var("PTY_SURFACE").expect("PTY_SURFACE");
        let t = target_for(&s).unwrap().expect("a local-tmux session for that surface");
        println!("{s} -> {t:?}");
        assert!(target_for("00000000-0000-0000-0000-000000000000").unwrap().is_none());
    }

    /// Live against cmux: NATIVE_WS=<workspace uuid> NATIVE_CWD=<dir>
    /// cargo test -p seamux-app --lib -- --ignored pty_starts_a_native_session
    #[test]
    #[ignore]
    fn pty_starts_a_native_session() {
        let ws = std::env::var("NATIVE_WS").expect("NATIVE_WS");
        let cwd = std::env::var("NATIVE_CWD").expect("NATIVE_CWD");
        let surface = start_native(&ws, &cwd, None).unwrap();
        println!("surface={surface}");
        assert_eq!(target_for(&surface).unwrap().map(|t| t.session.starts_with("claude-")), Some(true));
    }

    /// Two clients attached at once: closing one ends its output (no
    /// descriptor of it leaks into the other's child).
    #[test]
    fn pty_closing_one_of_two_ends_its_output() {
        if Command::new(tmux_bin()).arg("-V").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("seamux-pty2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sock = dir.join("s.sock").to_string_lossy().into_owned();
        for n in ["a", "b"] {
            tmux(&sock, &["-f", "/dev/null", "new-session", "-d", "-s", n, "sh"]);
        }
        let open = |n: &str| {
            let t = Target { socket: sock.clone(), session: n.to_string() };
            std::thread::spawn(move || Pty::attach(&t, 80, 24).unwrap())
        };
        let (ta, tb) = (open("a"), open("b"));
        let (mut a, b) = (ta.join().unwrap(), tb.join().unwrap());
        let mut r = a.reader().unwrap();
        a.close();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(r.read(&mut buf), Ok(n) if n > 0) {}
            let _ = tx.send(());
        });
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok(), "the closed client's output never ended");
        drop(b);
        tmux(&sock, &["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_pane_scrolled_furthest_back_is_the_one_shown() {
        assert_eq!(furthest_scroll("0 0 10\n1 40 900\n1 12 50\n"), (true, 40, 900));
        assert_eq!(furthest_scroll("0 0 10\n0 0 3\n"), (false, 0, 0));
    }

    /// Live: the companion shell splits once, then hides and shows by zoom.
    #[test]
    fn companion_shell_splits_then_hides_and_shows() {
        if Command::new(tmux_bin()).arg("-V").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("seamux-sh-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sock = dir.join("s.sock").to_string_lossy().into_owned();
        tmux(&sock, &["-f", "/dev/null", "new-session", "-d", "-s", "c", "-x", "80", "-y", "30", "sh"]);
        let t = Target { socket: sock.clone(), session: "c".into() };
        let look = || tmux(&sock, &["list-panes", "-t", "c:", "-F", "#{@seamux_role}:#{pane_active}:#{window_zoomed_flag}"]);
        assert_eq!(toggle_shell(&t), Ok(true));
        assert_eq!(look(), ":0:0\nshell:1:0");
        assert_eq!(toggle_shell(&t), Ok(false));
        assert_eq!(look(), ":1:1\nshell:0:1");
        assert_eq!(toggle_shell(&t), Ok(true));
        assert_eq!(look(), ":0:0\nshell:1:0");
        // Claude's pane is the main one; copy mode leaves both panes.
        let main = main_pane(&t).unwrap();
        assert_ne!(main, tmux(&sock, &["display-message", "-p", "-t", "c:", "#{pane_id}"]));
        tmux(&sock, &["copy-mode", "-t", &main]);
        assert!(scroll_state(&t).unwrap().0);
        leave_scroll(&t).unwrap();
        assert!(!scroll_state(&t).unwrap().0);
        tmux(&sock, &["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live: a real tmux server on a temporary socket (skipped without tmux).
    #[test]
    fn pty_attaches_to_a_real_tmux_session() {
        if Command::new(tmux_bin()).arg("-V").output().is_err() {
            eprintln!("no tmux: skipped");
            return;
        }
        let dir = std::env::temp_dir().join(format!("seamux-pty-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sock = dir.join("s.sock").to_string_lossy().into_owned();
        tmux(&sock, &["-f", "/dev/null", "new-session", "-d", "-s", "t1", "-x", "80", "-y", "24", "sh"]);
        let t = Target { socket: sock.clone(), session: "t1".into() };
        let mut p = Pty::attach(&t, 100, 30).expect("attach");
        let mut r = p.reader().unwrap();
        // Bytes arrive: tmux draws its client.
        assert!(!read_until(&mut r, "\u{1b}", 5).is_empty(), "no output from the client");
        // A write reaches the shell inside.
        p.write(b"echo pty-$((6*7))\r").unwrap();
        assert!(read_until(&mut r, "pty-42", 5).contains("pty-42"), "the shell did not answer");
        // A resize reaches tmux: its client takes the new size.
        p.resize(120, 40).unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        let mut size = String::new();
        while Instant::now() < end {
            size = tmux(&sock, &["list-clients", "-F", "#{client_width}x#{client_height}"]);
            if size == "120x40" {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(size, "120x40", "tmux did not take the resize");
        // Closing reaps the client; the session lives on.
        p.close();
        assert!(!p.alive());
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end && !tmux(&sock, &["list-clients"]).is_empty() {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(tmux(&sock, &["list-clients"]), "", "the client is still attached");
        assert_eq!(tmux(&sock, &["list-sessions", "-F", "#{session_name}"]), "t1");
        tmux(&sock, &["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_claude_under_a_native_panes_shell_is_found_and_a_shell_alone_is_not() {
        let procs = "100 1 -zsh\n101 100 claude --resume x\n102 101 node /x/gitnexus mcp\n200 1 -zsh\n201 200 vim a\n300 1 /usr/local/bin/claude\n";
        let panes = vec![("aa".to_string(), 100), ("bb".to_string(), 200), ("cc".to_string(), 300), ("dd".to_string(), 999)];
        assert_eq!(claude_in_panes(&panes, procs), vec!["AA".to_string(), "CC".to_string()]);
    }

    /// Against this machine's tmux and process table: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_native_claude_surfaces() {
        println!("{:?}", native_claude_now());
    }
}
