//! How the board reaches cmux and its other children, with the Python's
//! `run()` contract: never raise, answer (ok, text), and put stderr in the
//! text when stdout is empty, since that is where a reason lives.
//!
//! cmux goes through `crates/cmux`: the typed op when there is one, its
//! `cli()` for a verb no op covers. With CREW_CMUX set (a probe's fakecmux)
//! that client runs every call through the CLI.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cmux::Cmux;

static CLIENT: Mutex<Option<Arc<Cmux>>> = Mutex::new(None);

/// The process's cmux client, or None when cmux cannot be reached right now.
/// A failed connect is not remembered: a long-lived caller (the intent
/// server's board feed) reconnects once cmux is back, as the Python's
/// CLI-per-call did. A connected client reopens a dropped socket itself.
pub fn client() -> Option<Arc<Cmux>> {
    let mut slot = CLIENT.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_none() {
        *slot = Cmux::connect().ok().map(Arc::new);
    }
    slot.clone()
}

/// A call through the client failed: drop it, so the next one connects
/// afresh and re-resolves the socket (cmux restarted, perhaps elsewhere), as
/// the Python's CLI-per-call did.
pub fn failed() {
    *CLIENT.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Python's `(p.stdout or "").strip() or (p.stderr or "").strip()`.
pub fn text(stdout: &str, stderr: &str) -> String {
    let o = stdout.trim();
    if o.is_empty() { stderr.trim().to_string() } else { o.to_string() }
}

/// A cmux verb by argv, through the client's CLI path: (ok, text).
pub fn cmux(argv: &[&str]) -> (bool, String) {
    let Some(c) = client() else { return (false, "cmux is not reachable".into()) };
    match c.cli(argv) {
        Ok(o) => (o.ok(), text(&o.stdout, &o.stderr)),
        Err(e) => {
            failed();
            (false, e.to_string())
        }
    }
}

/// Any other child (git, node): (ok, text), never an error.
pub fn run(program: &str, args: &[&str], timeout: Duration) -> (bool, String) {
    match crew_core::py::run(program, args, timeout) {
        Some((code, out, err)) => (code == 0, text(&out, &err)),
        None => (false, format!("no such executable or timed out: {program}")),
    }
}
