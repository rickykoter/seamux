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
