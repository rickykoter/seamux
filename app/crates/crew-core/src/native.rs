//! Native sessions: Claude in a cmux local-tmux session, which a cmux pane
//! and the seamux app both attach to. Every new session starts here, from
//! the app (its New workspace and the sheet's buttons) and from crew's own
//! tools (`crew-native`, which crew-worktree and crew-resume call).

use std::process::Command;

use serde_json::Value;

pub fn cmux_json(argv: &[&str]) -> Result<Value, String> {
    let bin = cmux::resolve_cli_bin().map_err(|e| e.to_string())?;
    let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let out = cmux::run_cli(&bin, &argv).map_err(|e| e.to_string())?;
    if !out.ok() {
        return Err(format!("cmux {}: {}", argv.join(" "), out.stderr.trim()));
    }
    serde_json::from_str(&out.stdout).map_err(|e| format!("cmux {}: {e}", argv.join(" ")))
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

pub fn cmux_ok(argv: &[&str]) -> Result<String, String> {
    let bin = cmux::resolve_cli_bin().map_err(|e| e.to_string())?;
    let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    let out = cmux::run_cli(&bin, &argv).map_err(|e| e.to_string())?;
    if !out.ok() {
        return Err(format!("cmux {}: {}", argv.join(" "), out.stderr.trim()));
    }
    Ok(out.stdout)
}

/// A tmux command's output, trimmed.
pub fn tmux_out(sock: &str, args: &[&str]) -> Result<String, String> {
    let o = Command::new(tmux_bin()).arg("-S").arg(sock).args(args).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!("tmux {}: {}", args.join(" "), String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
}

pub fn tmux_ok(sock: &str, args: &[&str]) -> Result<(), String> {
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
    let (wref, id) = crate::worktree::create_workspace(cwd)?;
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

/// How a workspace's Claude was started.
#[derive(Debug, PartialEq)]
pub enum Started {
    /// Natively, in a local-tmux session.
    Native,
    /// In cmux's own terminal, because the native start failed (the reason).
    Plain(String),
}

/// open_native_workspace for crew's tools: a native session when it can be,
/// else `cmd` in the new workspace's own cmux terminal, so a failed native
/// start never leaves a workspace without its Claude or opens a second one.
/// Err only when no workspace opened at all. Returns its `workspace:N`, its
/// UUID (when cmux listed it), and how Claude started.
pub fn open_workspace(cwd: &std::path::Path, cmd: &str) -> Result<(String, Option<String>, Started), String> {
    let (wref, id) = crate::worktree::create_workspace(cwd)?;
    let Some(id) = id else {
        let kept = format!("{cmd}; exec \"${{SHELL:-/bin/zsh}}\" -l");
        let r = cmux_ok(&["respawn-pane", "--workspace", &wref, "--command", &kept]);
        return Ok((wref, None, Started::Plain(r.err().unwrap_or_else(|| "cmux did not list the workspace".into()))));
    };
    let c = cmux::Cmux::connect().map_err(|e| format!("cmux: {e}"))?;
    let shells = c.tree().map(|t| surfaces_in(&t, &id)).unwrap_or_default();
    match start_native_with(&id, &cwd.to_string_lossy(), cmd) {
        Ok(_) => {
            for s in shells {
                let _ = c.cli(&["close-surface", "--surface", &s, "--workspace", &id, "--force"]);
            }
            Ok((wref, Some(id), Started::Native))
        }
        Err(e) => {
            // A shell after it, or the pane would close the moment Claude exits.
            let kept = format!("{cmd}; exec \"${{SHELL:-/bin/zsh}}\" -l");
            let mut argv = vec!["respawn-pane", "--workspace", id.as_str(), "--command", kept.as_str()];
            if let Some(s) = shells.first() {
                argv.extend(["--surface", s.as_str()]);
            }
            cmux_ok(&argv).map_err(|e2| format!("{wref} is open, but Claude started neither natively ({e}) nor in its terminal ({e2})"))?;
            Ok((wref, Some(id), Started::Plain(e)))
        }
    }
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

/// The socket of a session cmux has just started: from its registry (a path
/// may hold spaces, so never from the CLI's `key=value` line), else its status.
pub fn socket_of(name: &str) -> Result<String, String> {
    let file = crate::py::home().join(".cmux/local-tmux/sessions.json");
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

pub fn finish_native(name: &str, ws: &str, claude: &str) -> Result<String, String> {
    let sock = socket_of(name)?;
    tmux_ok(&sock, &["set-option", "-t", name, "update-environment", &PANE_VARS.join(" ")])?;
    tmux_ok(&sock, &["set-option", "-t", name, "status", "off"])?;
    tmux_ok(&sock, &["set-option", "-t", name, "prefix", "None"])?;
    tmux_ok(&sock, &["set-option", "-t", name, "prefix2", "None"])?;
    tmux_ok(&sock, &["set-option", "-s", "focus-events", "on"])?;
    keys_through(&sock)?;
    let out = cmux_ok(&["local-tmux", "attach", name, "--workspace", ws, "--focus", "false"])?;
    let surface = field(&out, "surface").ok_or_else(|| format!("cmux did not say the new pane: {}", out.trim()))?;
    // cmux's attach returns before its client has connected: wait until tmux
    // has copied the pane's variables in, or Claude would start without them.
    let want = format!("CMUX_SURFACE_ID={surface}");
    let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
    // The pane's id exactly as the session has it, case and all: its pane
    // file is keyed by it.
    let pane_id = loop {
        let o = Command::new(tmux_bin()).args(["-S", &sock, "show-environment", "-t", name, "CMUX_SURFACE_ID"]).output();
        let line = o.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        if line.eq_ignore_ascii_case(&want) {
            break line["CMUX_SURFACE_ID=".len()..].to_string();
        }
        if std::time::Instant::now() > end {
            return Err(format!("cmux's pane {surface} did not reach the session {name}: Claude was not started"));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    // From now on no client changes the session's variables: the app's own
    // client (which has none of cmux's) must not wipe the pane's identity.
    tmux_ok(&sock, &["set-option", "-t", name, "update-environment", ""])?;
    // Claude starts now, from the session's environment: the pane's own.
    // Every client of the session draws true color (cmux, and the app's own
    // client says so), so Claude may use it as it does in a cmux pane: in
    // tmux it keeps to 256 colors unless told otherwise.
    tmux_ok(&sock, &["set-environment", "-t", name, "COLORTERM", "truecolor"])?;
    tmux_ok(&sock, &["set-environment", "-t", name, "CLAUDE_CODE_TMUX_TRUECOLOR", "1"])?;
    // The backend's ids (crew_core::ident): cmux's own, so the hooks key the
    // pane as they always have.
    tmux_ok(&sock, &["set-environment", "-t", name, "SEAMUX_WORKSPACE_ID", ws])?;
    tmux_ok(&sock, &["set-environment", "-t", name, "SEAMUX_PANE_ID", &pane_id])?;
    tmux_ok(&sock, &["respawn-pane", "-k", "-t", &format!("={name}:"), claude])?;
    Ok(surface)
}

/// The terminal-features entry that has tmux ask its outer terminals (cmux's
/// Ghostty, the app's xterm.js) for modified keys.
pub const EXTKEYS_FEATURE: &str = "xterm*:extkeys";

/// Whether `features` (`show-options -s terminal-features`) already has
/// [`EXTKEYS_FEATURE`], so attaching again never appends it twice.
pub fn has_extkeys(features: &str) -> bool {
    features.lines().any(|l| l.split_whitespace().nth(1).map(|v| v.trim_matches('"')) == Some(EXTKEYS_FEATURE))
}

/// Let modified keys through the server at `sock`: Shift+Enter reaches Claude
/// as Shift+Enter (a newline), not as a plain Enter that sends the prompt.
/// With extended-keys off, tmux turns every modified Enter into a bare CR.
/// `on` (not `always`) forwards them only to a program that asks, as Claude
/// does; a shell still gets the plain key. Server-wide, so it reaches every
/// session; a client attached before it needs to attach again for its
/// terminal to be asked.
pub fn keys_through(sock: &str) -> Result<(), String> {
    tmux_ok(sock, &["set-option", "-s", "extended-keys", "on"])?;
    tmux_ok(sock, &["set-option", "-s", "extended-keys-format", "csi-u"])?;
    let features = tmux_out(sock, &["show-options", "-s", "terminal-features"]).unwrap_or_default();
    if !has_extkeys(&features) {
        tmux_ok(sock, &["set-option", "-as", "terminal-features", EXTKEYS_FEATURE])?;
    }
    Ok(())
}

const USAGE: &str = "usage: crew-native workspace --cwd <dir> --command <line> [--focus]\n       crew-native start --workspace <uuid> --cwd <dir> --command <line>\n";

/// `crew-native`: start Claude natively from a shell script or Python.
///
///   crew-native workspace --cwd D --command C [--focus]
///       a new cmux workspace at D running C natively (in its own cmux
///       terminal if that fails, said on stderr); prints
///       `OK workspace:N <uuid> native|plain`. --focus switches cmux to it.
///   crew-native start --workspace W --cwd D --command C
///       C as a native session in workspace W; prints the new pane's surface.
///
/// Exit 1 with the reason on stderr when it fails, so the caller can say so
/// and fall back to a plain cmux terminal.
pub fn main(args: &[String]) -> i32 {
    let Some(verb) = args.first() else {
        eprint!("{USAGE}");
        return 2;
    };
    let mut cwd = None;
    let mut cmd = None;
    let mut ws = None;
    let mut focus = false;
    let mut it = args[1..].iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--cwd" => cwd = it.next().cloned(),
            "--command" => cmd = it.next().cloned(),
            "--workspace" => ws = it.next().cloned(),
            "--focus" => focus = true,
            "-h" | "--help" => {
                print!("{USAGE}");
                return 0;
            }
            other => {
                eprintln!("crew-native: unknown argument {other:?}\n{USAGE}");
                return 2;
            }
        }
    }
    let (Some(cwd), Some(cmd)) = (cwd, cmd.filter(|c| !c.trim().is_empty())) else {
        eprint!("{USAGE}");
        return 2;
    };
    let done = match verb.as_str() {
        "workspace" => open_workspace(std::path::Path::new(&cwd), &cmd).map(|(wref, id, how)| {
            if focus {
                let _ = cmux_ok(&["select-workspace", "--workspace", id.as_deref().unwrap_or(&wref)]);
            }
            if let Started::Plain(why) = &how {
                eprintln!("crew-native: not started natively ({why}); Claude runs in the workspace's cmux terminal");
            }
            let mode = if how == Started::Native { "native" } else { "plain" };
            format!("OK {wref} {} {mode}", id.unwrap_or_default())
        }),
        "start" => match ws {
            Some(ws) => start_native_with(&ws, &cwd, &cmd),
            None => Err("start needs --workspace".into()),
        },
        _ => {
            eprint!("{USAGE}");
            return 2;
        }
    };
    match done {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(e) => {
            eprintln!("crew-native: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crew_native_refuses_bad_arguments() {
        let a = |v: &[&str]| main(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(a(&[]), 2);
        assert_eq!(a(&["workspace", "--cwd", "/tmp"]), 2, "no command");
        assert_eq!(a(&["workspace", "--cwd", "/tmp", "--command", " "]), 2, "a blank command");
        assert_eq!(a(&["nope", "--cwd", "/tmp", "--command", "claude"]), 2);
        assert_eq!(a(&["start", "--cwd", "/tmp", "--command", "claude"]), 1, "start without a workspace");
        assert_eq!(a(&["start", "--workspace", "not-a-uuid", "--cwd", "/tmp", "--command", "claude"]), 1);
    }

    #[test]
    fn extkeys_is_found_once_set() {
        let before = "terminal-features[0] xterm*:clipboard:ccolour:cstyle:focus:title\nterminal-features[3] *:RGB";
        assert!(!has_extkeys(before));
        assert!(has_extkeys(&format!("{before}\nterminal-features[4] xterm*:extkeys")));
        assert!(has_extkeys("terminal-features[4] \"xterm*:extkeys\""));
    }

    /// Against a scratch tmux server: Shift+Enter, typed into a client,
    /// reaches a program that asked for modified keys as CSI 13;2u, and
    /// keys_through is idempotent.
    #[test]
    fn shift_enter_reaches_the_pane() {
        if Command::new(tmux_bin()).arg("-V").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("seamux-keys-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("s").to_string_lossy().into_owned();
        let out = dir.join("out");
        let t = |a: &[&str]| Command::new(tmux_bin()).arg("-S").arg(&sock).args(a).output().unwrap();
        // The pane asks for modified keys (as Claude does, after the server is
        // set up), then records what arrives.
        let script = format!("sleep 0.5; printf '\\033[>4;2m'; stty raw -echo; dd bs=1 count=7 2>/dev/null > {}", out.display());
        t(&["-f", "/dev/null", "new-session", "-d", "-s", "k", "-x", "80", "-y", "24", &script]);
        keys_through(&sock).unwrap();
        keys_through(&sock).unwrap();
        let feats = String::from_utf8_lossy(&t(&["show-options", "-s", "terminal-features"]).stdout).into_owned();
        assert_eq!(feats.matches(EXTKEYS_FEATURE).count(), 1, "{feats}");
        std::thread::sleep(std::time::Duration::from_millis(1000));
        // What a client's terminal sends for Shift+Enter, as tmux's input.
        t(&["send-keys", "-t", "k", "S-Enter"]);
        let mut got = Vec::new();
        for _ in 0..30 {
            got = std::fs::read(&out).unwrap_or_default();
            if got.len() >= 7 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        t(&["kill-server"]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(got, b"\x1b[13;2u");
    }
}
