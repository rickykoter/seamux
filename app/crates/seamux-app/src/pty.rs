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
    for s in reg.get("sessions").and_then(Value::as_array).into_iter().flatten() {
        let (Some(surface), Some(name), Some(sock)) = (
            s.get("surfaceID").and_then(Value::as_str),
            s.get("name").and_then(Value::as_str).filter(|n| name_ok(n)),
            s.get("socketPath").and_then(Value::as_str).filter(|p| !p.is_empty()),
        ) else {
            continue;
        };
        let Ok(o) = Command::new(tmux_bin()).args(["-S", sock, "list-panes", "-t", &format!("={name}"), "-F", "#{pane_pid} #{@seamux_bell}"]).stderr(Stdio::null()).output() else { continue };
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            let mut w = line.split_whitespace();
            let Some(pid) = w.next().and_then(|v| v.parse::<u32>().ok()) else { continue };
            if w.next() == Some("1") {
                bells.insert(surface.to_uppercase());
            }
            panes.push((surface.to_string(), pid));
        }
    }
    if panes.is_empty() {
        return Default::default();
    }
    let Ok(ps) = Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output() else { return Default::default() };
    let procs = String::from_utf8_lossy(&ps.stdout);
    let claude = claude_in_panes(&panes, &procs).into_iter().collect();
    let mut signals: std::collections::HashMap<String, PaneSignals> = Default::default();
    for (surface, pid) in &panes {
        let s = signals.entry(surface.to_uppercase()).or_default();
        s.running = s.running.take().or_else(|| running_under(*pid, &procs));
        s.bell = bells.contains(&surface.to_uppercase());
    }
    (claude, signals)
}

/// The pane was looked at: its bell is heard.
pub fn bell_seen(t: &Target) -> Result<(), String> {
    tmux_ok(&t.socket, &["set-option", "-t", &t.session, "-u", "@seamux_bell"])
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

/// Leave copy mode, where the wheel put the pane, so typed keys reach the
/// program again. Nothing happens when the pane is not in a mode.
pub fn leave_scroll(t: &Target) -> Result<(), String> {
    tmux_ok(&t.socket, &["copy-mode", "-q", "-t", &format!("={}:", t.session)])
}

/// Where tmux's copy mode has the pane: (in it, lines up from the bottom,
/// lines of history). None when tmux cannot say.
pub fn scroll_state(t: &Target) -> Option<(bool, u64, u64)> {
    let o = Command::new(tmux_bin())
        .args(["-S", &t.socket, "display-message", "-p", "-t", &format!("={}:", t.session), "#{pane_in_mode} #{scroll_position} #{history_size}"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&o.stdout);
    let mut w = s.split_whitespace();
    let mode = w.next()? == "1";
    let pos = w.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let hist = w.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    Some((mode, pos, hist))
}

/// A tmux command's output, trimmed.
fn tmux_out(sock: &str, args: &[&str]) -> Result<String, String> {
    let o = Command::new(tmux_bin()).arg("-S").arg(sock).args(args).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!("tmux {}: {}", args.join(" "), String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// What the companion shell's border says: "shell · <what runs>". Other
/// panes' borders say nothing.
const SHELL_BORDER: &str = "#{?#{==:#{@seamux_role},shell}, shell · #{pane_current_command} ,}";

/// Show or hide the session's companion shell: a split under Claude, in the
/// same folder, made the first time. Hiding zooms Claude's pane, so the
/// shell keeps running. Returns whether the shell shows now (and has the keys).
pub fn toggle_shell(t: &Target) -> Result<bool, String> {
    let win = format!("{}:", t.session);
    let list = tmux_out(&t.socket, &["list-panes", "-t", &win, "-F", "#{pane_id}\t#{@seamux_role}\t#{window_zoomed_flag}\t#{pane_current_path}"])?;
    let rows: Vec<Vec<&str>> = list.lines().map(|l| l.split('\t').collect()).filter(|r: &Vec<&str>| r.len() == 4).collect();
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
    start_native_with(ws, cwd, &claude_line(resume)?)
}

/// start_native, running `claude` (a shell command line) as the session's
/// program: a new workspace's Claude, with its first prompt.
pub fn start_native_with(ws: &str, cwd: &str, claude: &str) -> Result<String, String> {
    if !cmux::is_uuid(ws) {
        return Err(format!("not a workspace UUID: {ws:?}"));
    }
    if !cwd.starts_with('/') || !std::path::Path::new(cwd).is_dir() {
        return Err(format!("not a directory: {cwd:?}"));
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_micros()).unwrap_or(0);
    let name = format!("claude-{:x}", stamp & 0xffff_ffff);
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    // A login shell until cmux's client has attached and filled the variables in.
    // A start that fails can still leave its tmux session behind, unrecorded.
    if let Err(e) = cmux_ok(&["local-tmux", "start", &name, "--cwd", cwd, "--command", &format!("{} -l", sh_quote(&shell)), "--detached"]) {
        let _ = cmux_ok(&["local-tmux", "close", &name]);
        return Err(e);
    }
    // Anything that fails from here takes the half-made session with it.
    let made = finish_native(&name, ws, claude);
    if made.is_err() {
        let _ = cmux_ok(&["local-tmux", "close", &name]);
    }
    made
}

/// The workspace for `cwd`, with `cmd` (Claude and its first prompt) as a
/// native session there in place of cmux's shell: the Dock draws it.
pub fn open_native_workspace(cwd: &std::path::Path, cmd: &str) -> Result<(String, Option<String>), String> {
    let (wref, id) = crew_core::worktree::create_workspace(cwd)?;
    let id = id.ok_or_else(|| format!("cmux opened {wref} but did not list it, so Claude was not started there"))?;
    let c = cmux::Cmux::connect().map_err(|e| format!("cmux: {e}"))?;
    // cmux's own shell, closed once the native pane is there.
    let shells = c.tree().map(|t| surfaces_in(&t, &id)).unwrap_or_default();
    start_native_with(&id, &cwd.to_string_lossy(), cmd).map_err(|e| format!("{wref} is open, but Claude did not start natively ({e})"))?;
    for s in shells {
        let _ = c.cli(&["close-surface", "--surface", &s, "--workspace", &id, "--force"]);
    }
    Ok((wref, Some(id)))
}

/// The surface refs of workspace `ws` (a UUID) in cmux's `tree --json`.
pub fn surfaces_in(tree: &Value, ws: &str) -> Vec<String> {
    let arr = |v: &Value, k: &str| v.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    arr(tree, "windows")
        .iter()
        .flat_map(|w| arr(w, "workspaces"))
        .filter(|w| w.get("id").and_then(Value::as_str).is_some_and(|id| id.eq_ignore_ascii_case(ws)))
        .flat_map(|w| arr(&w, "panes"))
        .flat_map(|p| arr(&p, "surfaces"))
        .filter_map(|s| s.get("ref").and_then(Value::as_str).map(str::to_string))
        .collect()
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
    // Every client of the session draws true color (cmux, and the app's own
    // client says so), so Claude may use it as it does in a cmux pane: in
    // tmux it keeps to 256 colors unless told otherwise.
    tmux_ok(&sock, &["set-environment", "-t", name, "COLORTERM", "truecolor"])?;
    tmux_ok(&sock, &["set-environment", "-t", name, "CLAUDE_CODE_TMUX_TRUECOLOR", "1"])?;
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
    /// `-T hyperlinks`: xterm.js draws OSC 8 links, so tmux passes Claude's on
    /// (it strips them for a client it thinks cannot).
    pub fn attach(t: &Target, cols: u16, rows: u16) -> Result<Pty, String> {
        // History kept for the wheel to scroll back through: tmux sets it
        // when a pane is made, so this reaches sessions started from now on.
        let _ = tmux_ok(&t.socket, &["set-option", "-g", "history-limit", "10000"]);
        // Claude in fullscreen selects and copies itself, asking tmux (OSC 52)
        // to set the clipboard; "external", tmux's default, refuses programs.
        let _ = tmux_ok(&t.socket, &["set-option", "-s", "set-clipboard", "on"]);
        // A bell marks its session (even in the window a client shows, where
        // tmux sets no flag of its own) until the pane is looked at.
        let _ = tmux_ok(&t.socket, &["set-hook", "-g", "alert-bell", "set-option @seamux_bell 1"]);
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
