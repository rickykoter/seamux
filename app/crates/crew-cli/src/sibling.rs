//! Starting a sibling tool the way the Python did, from the Rust.
//!
//! A tool crew-cli owns runs as `seamux <tool>` (this binary), in its own
//! process as the Python's did, so a detached sync or frame keeps its own
//! lifetime and output. A tool another crate has registered with seamux runs
//! the same way. Anything else (crew-board until port-board registers it,
//! crew-reclaim, crew-cmux-bin) runs from its path under the crew home.

use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

/// This binary, when it is seamux (never a test harness).
fn seamux() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    (exe.file_name()? == "seamux").then_some(exe)
}

/// The tools `seamux --tools` lists, asked once.
fn registered() -> &'static Vec<String> {
    static TOOLS: OnceLock<Vec<String>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let Some(exe) = seamux() else { return vec![] };
        let exe = exe.to_string_lossy().into_owned();
        crate::proc::run(&[&exe, "--tools"], None, &[], Some(Duration::from_secs(10)))
            .map(|o| o.stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
            .unwrap_or_default()
    })
}

/// `seamux <tool>`'s argv head when this binary can run `tool`, else None.
///
/// `SEAMUX_TOOLS_BY_PATH=1` (probe-only, the same switch crew-hooks honors)
/// runs every tool another crate registers from its path under the crew
/// home, so a probe's stub tree sees the call; crew-cli's own tools still
/// self-exec, since their parity is what the probe tests.
pub fn own(tool: &str) -> Option<Vec<String>> {
    let exe = seamux()?;
    let ours = crate::TOOLS.iter().any(|(n, _)| *n == tool);
    let by_path = std::env::var("SEAMUX_TOOLS_BY_PATH").is_ok_and(|v| v == "1");
    (ours || (!by_path && registered().iter().any(|t| t == tool)))
        .then(|| vec![exe.to_string_lossy().into_owned(), tool.to_string()])
}

/// A file under the crew home (CREW_HOME, else ~/.config/cmux/crew).
pub fn home_path(rel: &str) -> PathBuf {
    crew_core::home::crew_home().join(rel)
}

pub fn executable(p: &std::path::Path) -> bool {
    std::ffi::CString::new(p.as_os_str().as_encoded_bytes())
        // SAFETY: access(2) on a NUL-terminated path we own.
        .map(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
        .unwrap_or(false)
}

pub fn readable(p: &std::path::Path) -> bool {
    std::ffi::CString::new(p.as_os_str().as_encoded_bytes())
        // SAFETY: access(2) on a NUL-terminated path we own.
        .map(|c| unsafe { libc::access(c.as_ptr(), libc::R_OK) } == 0)
        .unwrap_or(false)
}

/// `Popen(argv, stdout=DEVNULL, stderr=DEVNULL, start_new_session=True)`.
pub fn spawn_detached(argv: &[String]) -> std::io::Result<Child> {
    let (prog, args) = argv.split_first().ok_or_else(|| std::io::Error::other("empty argv"))?;
    let mut cmd = Command::new(prog);
    cmd.args(args).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches only the child.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()
}

/// spawn_detached, and reap it on a thread so a long-lived caller leaves no zombie.
pub fn spawn_reaped(argv: &[String]) -> std::io::Result<()> {
    let mut child = spawn_detached(argv)?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
