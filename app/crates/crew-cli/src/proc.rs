//! `subprocess.run(argv, capture_output=True, text=True, cwd=..., timeout=...)`.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What a finished run gave back.
pub struct Out {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run `argv` (stdin closed), optionally in `cwd` and with extra environment;
/// None where Python raises: it cannot start, or `timeout` passed (the child
/// is killed first). No timeout waits for as long as it takes.
pub fn run(argv: &[&str], cwd: Option<&str>, env: &[(&str, &str)], timeout: Option<Duration>) -> Option<Out> {
    run_with_input(argv, cwd, env, None, timeout)
}

/// `run`, with `input` written to the child's stdin (`input=` in Python).
pub fn run_with_input(
    argv: &[&str],
    cwd: Option<&str>,
    env: &[(&str, &str)],
    input: Option<&str>,
    timeout: Option<Duration>,
) -> Option<Out> {
    use std::io::Write;
    let (prog, args) = argv.split_first()?;
    let mut cmd = Command::new(prog);
    cmd.args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().ok()?;
    if let Some(data) = input {
        // Written on its own thread, so a child that never reads cannot block us.
        let mut sin = child.stdin.take()?;
        let data = data.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = sin.write_all(&data);
        });
    }
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    // The readers report through a channel, so the deadline covers reading the
    // output to its end too, as communicate(timeout) does: a descendant that
    // keeps the pipes open after the child exits must not hang the caller.
    let (tx, rx) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        let _ = tx.send((true, b));
    });
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        let _ = tx2.send((false, b));
    });
    let deadline = timeout.map(|t| Instant::now() + t);
    let expired = || deadline.is_some_and(|d| Instant::now() > d);
    let status = loop {
        if let Ok(Some(st)) = child.try_wait() {
            break st;
        }
        if expired() {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let (mut stdout, mut stderr) = (None, None);
    while stdout.is_none() || stderr.is_none() {
        let got = match deadline {
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())).ok(),
            None => rx.recv().ok(),
        };
        match got {
            Some((true, b)) => stdout = Some(b),
            Some((false, b)) => stderr = Some(b),
            None => return None, // past the deadline with a pipe still open
        }
    }
    Some(Out {
        code: status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&stdout.unwrap_or_default()).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.unwrap_or_default()).into_owned(),
    })
}

/// `subprocess.Popen(argv, stdout=DEVNULL, stderr=DEVNULL)`, not waited for.
pub fn spawn_quiet(argv: &[&str]) {
    if let Some((prog, args)) = argv.split_first() {
        let _ = Command::new(prog).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_descendant_holding_the_pipe_does_not_outlast_the_timeout() {
        let t0 = Instant::now();
        let r = run(&["sh", "-c", "(sleep 5 &) ; echo hi"], None, &[], Some(Duration::from_millis(500)));
        assert!(r.is_none(), "timed out, as subprocess.run raises");
        assert!(t0.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn output_and_code_come_back() {
        let r = run(&["sh", "-c", "echo out; echo err >&2; exit 3"], None, &[], Some(Duration::from_secs(5))).unwrap();
        assert_eq!((r.code, r.stdout.as_str(), r.stderr.as_str()), (3, "out\n", "err\n"));
    }
}
