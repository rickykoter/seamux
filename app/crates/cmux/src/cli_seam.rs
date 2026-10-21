//! Which way a call reaches cmux, and which cmux CLI to run when it goes by CLI.
//!
//! The rule (the family's contract, chosen by the human):
//!
//! * `CREW_CMUX` set, or `CREW_CMUX_TRANSPORT=cli`: every call runs the cmux CLI.
//!   That is how the probes put fakecmux.py in front of every crew tool.
//! * otherwise: v2 JSON lines on the socket, and the CLI only for a verb the
//!   socket has no method for (see `verbs.rs`).
//!
//! `CMUX_CLAUDE_HOOK_CMUX_BIN` never switches the transport. cmux sets it for the
//! hooks it runs, so treating it as a switch would push live triage onto the CLI.
//! It does take part in choosing the binary.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::Error;

/// How a `Cmux` reaches cmux.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    /// v2 JSON lines on this unix socket.
    Socket(PathBuf),
    /// Every call runs this cmux CLI (or a stand-in such as fakecmux.py).
    Cli(PathBuf),
}

/// An environment to read. `std::env` in use; a map in tests.
pub type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

pub(crate) fn real_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn set(env: Env, name: &str) -> Option<String> {
    env(name).filter(|v| !v.is_empty())
}

impl Transport {
    /// The transport this process's environment asks for.
    pub fn from_env() -> Result<Transport, Error> {
        Transport::from_vars(&real_env)
    }

    pub fn from_vars(env: Env) -> Result<Transport, Error> {
        if wants_cli(env) {
            return resolve_cli_bin_with(env).map(Transport::Cli);
        }
        crate::socket::resolve_socket_path(env)
            .map(Transport::Socket)
            .ok_or_else(|| Error::Unavailable("no cmux socket found (is cmux running?)".into()))
    }
}

/// True when the environment selects the CLI transport.
pub fn wants_cli(env: Env) -> bool {
    set(env, "CREW_CMUX").is_some()
        || env("CREW_CMUX_TRANSPORT").map(|v| v == "cli").unwrap_or(false)
}

/// The cmux CLI to run: CREW_CMUX, then CMUX_CLAUDE_HOOK_CMUX_BIN, then
/// crew-cmux-bin's order (CMUX_BIN, PATH, the newest /Applications/cmux*.app).
pub fn resolve_cli_bin() -> Result<PathBuf, Error> {
    resolve_cli_bin_with(&real_env)
}

pub fn resolve_cli_bin_with(env: Env) -> Result<PathBuf, Error> {
    for name in ["CREW_CMUX", "CMUX_CLAUDE_HOOK_CMUX_BIN", "CMUX_BIN"] {
        if let Some(v) = set(env, name) {
            return Ok(PathBuf::from(v));
        }
    }
    if let Some(path) = set(env, "PATH") {
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            let cand = Path::new(dir).join("cmux");
            if is_executable(&cand) {
                return Ok(cand);
            }
        }
    }
    newest_bundle_cli(Path::new("/Applications"))
        .ok_or_else(|| Error::Unavailable("no cmux CLI found (CREW_CMUX, PATH, /Applications)".into()))
}

/// The CLI inside the newest /Applications/cmux*.app by mtime, so an upgrade
/// wins over a stale bundle (the reason crew-cmux-bin exists).
pub(crate) fn newest_bundle_cli(apps: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(apps).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("cmux") && name.ends_with(".app")) {
            continue;
        }
        let cand = entry.path().join("Contents/Resources/bin/cmux");
        if !is_executable(&cand) {
            continue;
        }
        // One unreadable bundle is skipped, not allowed to end the search.
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, cand));
        }
    }
    best.map(|(_, p)| p)
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// What a CLI run printed. A non-zero status is data, not an error: most crew
/// callers treat a failed cmux call as "nothing happened" and carry on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CliOutput {
    pub fn ok(&self) -> bool {
        self.status == 0
    }
}

/// How long one CLI call may take: crew's Python gave every cmux call
/// `timeout=10` and read a hang as "cmux did not answer".
pub const CLI_TIMEOUT: Duration = Duration::from_secs(10);

/// Run `bin argv…` and capture its output, within CLI_TIMEOUT. Err when it
/// cannot start or does not finish in time (the child is killed).
pub fn run_cli(bin: &Path, argv: &[String]) -> Result<CliOutput, Error> {
    run_cli_env(bin, argv, &[], CLI_TIMEOUT)
}

/// run_cli with extra environment variables and its own time limit.
pub fn run_cli_env(
    bin: &Path,
    argv: &[String],
    env: &[(String, String)],
    timeout: Duration,
) -> Result<CliOutput, Error> {
    use std::io::Read;
    let mut child = Command::new(bin)
        .args(argv)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Unavailable(format!("cannot run {}: {e}", bin.display())))?;
    let drain = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = r.read_to_end(&mut b);
            b
        })
    };
    let out = drain(Box::new(child.stdout.take().expect("piped stdout")));
    let err = drain(Box::new(child.stderr.take().expect("piped stderr")));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Unavailable(format!(
                    "{} {} did not answer within {}s",
                    bin.display(),
                    argv.first().map(String::as_str).unwrap_or(""),
                    timeout.as_secs()
                )));
            }
        }
    };
    Ok(CliOutput {
        status: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&err.join().unwrap_or_default()).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| m.get(k).cloned()
    }

    #[test]
    fn crew_cmux_selects_the_cli() {
        let e = env_of(&[("CREW_CMUX", "/x/fakecmux.py")]);
        assert_eq!(Transport::from_vars(&e).unwrap(), Transport::Cli("/x/fakecmux.py".into()));
    }

    #[test]
    fn transport_cli_uses_the_hook_bin_when_crew_cmux_is_unset() {
        let e = env_of(&[("CREW_CMUX_TRANSPORT", "cli"), ("CMUX_CLAUDE_HOOK_CMUX_BIN", "/h/cmux")]);
        assert_eq!(Transport::from_vars(&e).unwrap(), Transport::Cli("/h/cmux".into()));
    }

    #[test]
    fn the_hook_bin_alone_keeps_the_socket() {
        let e = env_of(&[
            ("CMUX_CLAUDE_HOOK_CMUX_BIN", "/h/cmux"),
            ("CMUX_SOCKET_PATH", "/tmp/some.sock"),
        ]);
        assert!(!wants_cli(&e));
        assert_eq!(Transport::from_vars(&e).unwrap(), Transport::Socket("/tmp/some.sock".into()));
    }

    #[test]
    fn empty_crew_cmux_does_not_count() {
        let e = env_of(&[("CREW_CMUX", ""), ("CMUX_SOCKET_PATH", "/tmp/s.sock")]);
        assert!(!wants_cli(&e));
    }

    #[test]
    fn a_hung_cli_is_killed_at_the_limit() {
        let t = Instant::now();
        let r = run_cli_env(Path::new("/bin/sleep"), &["5".to_string()], &[], Duration::from_millis(200));
        assert!(matches!(r, Err(Error::Unavailable(m)) if m.contains("did not answer")));
        assert!(t.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn crew_cmux_wins_the_binary_order() {
        let e = env_of(&[
            ("CREW_CMUX", "/a"),
            ("CMUX_CLAUDE_HOOK_CMUX_BIN", "/b"),
            ("CMUX_BIN", "/c"),
        ]);
        assert_eq!(resolve_cli_bin_with(&e).unwrap(), PathBuf::from("/a"));
        let e = env_of(&[("CMUX_BIN", "/c")]);
        assert_eq!(resolve_cli_bin_with(&e).unwrap(), PathBuf::from("/c"));
    }
}
