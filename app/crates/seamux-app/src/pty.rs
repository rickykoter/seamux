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

/// A local-tmux session, as tmux addresses it.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub socket: String,
    pub session: String,
}

/// The live sessions `cmux local-tmux list --json` names: (session name, socket).
pub fn live_sessions(list: &Value) -> Vec<(String, String)> {
    let top = list.get("socket_path").and_then(Value::as_str).unwrap_or("");
    list.get("sessions")
        .and_then(Value::as_array)
        .map(|ss| {
            ss.iter()
                .filter(|s| s.get("live").and_then(Value::as_bool).unwrap_or(false))
                .filter_map(|s| {
                    let name = s.get("session_name").and_then(Value::as_str)?.to_string();
                    let sock = s.get("socket_path").and_then(Value::as_str).filter(|p| !p.is_empty()).unwrap_or(top).to_string();
                    (!name.is_empty() && !sock.is_empty()).then_some((name, sock))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The cmux surface a session's client is, from `status <name> --json`.
pub fn client_surface(status: &Value) -> String {
    status.get("surface_id").and_then(Value::as_str).unwrap_or("").to_string()
}

/// A session name tmux takes as is: what `cmux local-tmux` itself allows.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

fn cmux_json(argv: &[&str]) -> Result<Value, String> {
    let bin = cmux::resolve_cli_bin().map_err(|e| e.to_string())?;
    let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let out = cmux::run_cli(&bin, &argv).map_err(|e| e.to_string())?;
    if !out.ok() {
        return Err(format!("cmux {}: {}", argv.join(" "), out.stderr.trim()));
    }
    serde_json::from_str(&out.stdout).map_err(|e| format!("cmux {}: {e}", argv.join(" ")))
}

/// The session cmux's local-tmux registry (`sessions.json`) records for a
/// client surface: its name and socket. The registry is cmux's own file;
/// `target_for` falls back to the CLI when it cannot be read.
pub fn registry_target(registry: &Value, surface: &str) -> Option<Target> {
    registry.get("sessions")?.as_array()?.iter().find_map(|s| {
        let sid = s.get("surfaceID").and_then(Value::as_str)?;
        if !sid.eq_ignore_ascii_case(surface) {
            return None;
        }
        let session = s.get("name").and_then(Value::as_str)?.to_string();
        let socket = s.get("socketPath").and_then(Value::as_str)?.to_string();
        (name_ok(&session) && !socket.is_empty()).then_some(Target { socket, session })
    })
}

/// Whether tmux still has `t`: the registry can outlive a session.
pub fn live(t: &Target) -> bool {
    Command::new(tmux_bin())
        .args(["-S", &t.socket, "has-session", "-t", &format!("={}", t.session)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The local-tmux session whose cmux client is `surface`, if it is one: from
/// the registry (a file read and one tmux call, ~20ms), else from the CLI
/// (`local-tmux list` and `status`, ~1.3s a call).
pub fn target_for(surface: &str) -> Result<Option<Target>, String> {
    let file = crew_core::py::home().join(".cmux/local-tmux/sessions.json");
    if let Some(reg) = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        return Ok(registry_target(&reg, surface).filter(live));
    }
    let list = cmux_json(&["local-tmux", "list", "--json"])?;
    for (name, socket) in live_sessions(&list) {
        if !name_ok(&name) {
            continue;
        }
        let Ok(st) = cmux_json(&["local-tmux", "status", &name, "--json"]) else { continue };
        if client_surface(&st).eq_ignore_ascii_case(surface) {
            return Ok(Some(Target { socket, session: name }));
        }
    }
    Ok(None)
}

/// tmux, from PATH (the app adopts the login shell's at start) or Homebrew.
pub fn tmux_bin() -> String {
    for dir in std::env::var("PATH").unwrap_or_default().split(':').chain(["/opt/homebrew/bin", "/usr/local/bin"]) {
        let p = std::path::Path::new(dir).join("tmux");
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    "tmux".into()
}

/// `s` as one shell word (tmux runs the command through a shell).
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A cmux pane's variables, as cmux's own client of a session has them: its
/// IDs, socket and capability, Claude's hook settings, and PATH (led by the
/// pane's claude shim). tmux copies these from the attaching client into the
/// session (update-environment), so Claude started there is that pane's agent.
pub const PANE_VARS: [&str; 25] = [
    "CMUX_SURFACE_ID", "CMUX_PANEL_ID", "CMUX_TAB_ID", "CMUX_WORKSPACE_ID", "CMUX_SOCKET_PATH", "CMUX_SOCKET",
    "CMUX_SOCKET_CAPABILITY", "CMUX_BUNDLE_ID", "CMUX_BUNDLED_CLI_PATH", "CMUX_CLAUDE_HOOK_CMUX_BIN",
    "CMUX_CLAUDE_HOOK_SPOOL_DIR", "CMUX_CLAUDE_INTEGRATION_DISABLED", "CMUX_CLAUDE_HEADLESS", "CMUX_CLAUDE_WRAPPER_SHIM",
    "CMUX_CLAUDE_WRAPPER_SHIM_ROOT", "CMUX_AGENT_COMMAND_SHIM_ROOT", "CMUX_TERMINAL_LIFECYCLE_ID",
    "CMUX_SUPPRESS_SUBAGENT_NOTIFICATIONS", "CMUX_PORT", "CMUX_PORT_END", "CMUX_PORT_RANGE", "CMUX_SHELL_INTEGRATION",
    "CMUX_SHELL_INTEGRATION_DIR", "CMUX_HISTORY_FILE", "PATH",
];

/// `key=value` out of a cmux CLI's `OK key=value ...` line.
pub fn field(line: &str, key: &str) -> Option<String> {
    line.split_whitespace().find_map(|w| w.strip_prefix(&format!("{key}=")).map(str::to_string)).filter(|v| !v.is_empty())
}

/// The claude command a native session runs: resuming `resume` when given.
pub fn claude_line(resume: Option<&str>) -> Result<String, String> {
    match resume {
        None => Ok("claude".into()),
        Some(id) if cmux::is_uuid(id) => Ok(format!("claude --resume {id}")),
        Some(id) => Err(format!("not a session id: {id:?}")),
    }
}

fn cmux_ok(argv: &[&str]) -> Result<String, String> {
    let bin = cmux::resolve_cli_bin().map_err(|e| e.to_string())?;
    let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let out = cmux::run_cli(&bin, &argv).map_err(|e| e.to_string())?;
    if !out.ok() {
        return Err(format!("cmux {}: {}", argv.join(" "), out.stderr.trim()));
    }
    Ok(out.stdout)
}

fn tmux_ok(sock: &str, args: &[&str]) -> Result<(), String> {
    let o = Command::new(tmux_bin()).arg("-S").arg(sock).args(args).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!("tmux {}: {}", args.join(" "), String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(())
}

/// Start Claude as a native session in workspace `ws` (a UUID) at `cwd`:
/// a local-tmux session, its pane's cmux variables copied in at attach,
/// no tmux bar or prefix (Claude Code uses Ctrl-B), focus events on. Returns
/// the new cmux pane's surface id.
pub fn start_native(ws: &str, cwd: &str, resume: Option<&str>) -> Result<String, String> {
    if !cmux::is_uuid(ws) {
        return Err(format!("not a workspace UUID: {ws:?}"));
    }
    if !cwd.starts_with('/') || !std::path::Path::new(cwd).is_dir() {
        return Err(format!("not a directory: {cwd:?}"));
    }
    let claude = claude_line(resume)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros()).unwrap_or(0);
    let name = format!("claude-{:x}", stamp & 0xffff_ffff);
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    // A login shell until cmux's client has attached and filled the variables in.
    cmux_ok(&["local-tmux", "start", &name, "--cwd", cwd, "--command", &format!("{} -l", sh_quote(&shell)), "--detached"])?;
    // Anything that fails from here takes the half-made session with it.
    let made = finish_native(&name, ws, &claude);
    if made.is_err() {
        let _ = cmux_ok(&["local-tmux", "close", &name]);
    }
    made
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
    if target_for(surface)?.is_some() {
        return Err("this pane is already a native session".into());
    }
    // The pid is cmux's record: make sure it is still that Claude.
    let out = Command::new("ps").args(["-o", "command=", "-p", &run.pid.to_string()]).output().map_err(|e| e.to_string())?;
    let cmd = String::from_utf8_lossy(&out.stdout);
    if !cmd.contains("claude") {
        return Err(format!("process {} is no longer Claude", run.pid));
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

/// The socket of a session cmux has just started: from its registry (a path
/// may hold spaces, so never from the CLI's `key=value` line), else its status.
fn socket_of(name: &str) -> Result<String, String> {
    let file = crew_core::py::home().join(".cmux/local-tmux/sessions.json");
    let from_registry = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|reg| {
        reg.get("sessions")?.as_array()?.iter().find_map(|s| {
            (s.get("name")?.as_str()? == name).then(|| s.get("socketPath")?.as_str().map(str::to_string)).flatten()
        })
    });
    if let Some(s) = from_registry.filter(|s| !s.is_empty()) {
        return Ok(s);
    }
    let st = cmux_json(&["local-tmux", "status", name, "--json"])?;
    st.get("socket_path").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).ok_or_else(|| format!("cmux did not say {name}'s socket"))
}

fn finish_native(name: &str, ws: &str, claude: &str) -> Result<String, String> {
    let sock = socket_of(name)?;
    tmux_ok(&sock, &["set-option", "-t", name, "update-environment", &PANE_VARS.join(" ")])?;
    tmux_ok(&sock, &["set-option", "-t", name, "status", "off"])?;
    tmux_ok(&sock, &["set-option", "-t", name, "prefix", "None"])?;
    tmux_ok(&sock, &["set-option", "-t", name, "prefix2", "None"])?;
    tmux_ok(&sock, &["set-option", "-s", "focus-events", "on"])?;
    let out = cmux_ok(&["local-tmux", "attach", name, "--workspace", ws, "--focus", "false"])?;
    let surface = field(&out, "surface").ok_or_else(|| format!("cmux did not say the new pane: {}", out.trim()))?;
    // cmux's attach returns before its client has connected: wait until tmux
    // has copied the pane's variables in, or Claude would start without them.
    let want = format!("CMUX_SURFACE_ID={surface}");
    let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let o = Command::new(tmux_bin()).args(["-S", &sock, "show-environment", "-t", name, "CMUX_SURFACE_ID"]).output();
        if o.map(|o| String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case(&want)).unwrap_or(false) {
            break;
        }
        if std::time::Instant::now() > end {
            return Err(format!("cmux's pane {surface} did not reach the session {name}: Claude was not started"));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // From now on no client changes the session's variables: the app's own
    // client (which has none of cmux's) must not wipe the pane's identity.
    tmux_ok(&sock, &["set-option", "-t", name, "update-environment", ""])?;
    // Claude starts now, from the session's environment: the pane's own.
    tmux_ok(&sock, &["respawn-pane", "-k", "-t", &format!("={name}:"), claude])?;
    Ok(surface)
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
    pub fn attach(t: &Target, cols: u16, rows: u16) -> Result<Pty, String> {
        Self::spawn(&tmux_bin(), &["-S", &t.socket, "attach-session", "-t", &format!("={}", t.session)], cols, rows)
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
        cmd.args(args).stdin(io(&slave)?).stdout(io(&slave)?).stderr(io(&slave)?).env("TERM", "xterm-256color");
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
        assert!(target_for(&new).unwrap().is_some());
        println!("moved {} to {new}", run.session);
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
}
