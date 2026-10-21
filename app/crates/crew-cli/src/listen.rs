//! `crew-listen`: reconcile the board when cmux says a workspace changed.
//!
//! ```text
//! crew-listen            follow forever (what the SessionStart hook starts)
//! crew-listen --once     reconcile if due, print what happened, exit
//! ```
//!
//! The third trigger for crew-sync beside the Stop hook and the tick. It
//! follows four structural events only (created, closed, renamed, selected):
//! crew's own writes are hot events, and subscribing to them would loop. It
//! shares the Stop hook's sync stamp, so whichever trigger arrives first runs
//! the reconcile and the rest stand down for CREW_SYNC_INTERVAL. Three
//! cadences: events (immediate), the reconcile tick (TICK) and the fast board
//! tick (CREW_BOARD_TICK). A selection repaints the board and the pane frame
//! at once, with the id from the event, which beats `workspace list` by
//! ~151ms. One listener at a time, by pidfile.

use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use cmux::{Cmux, EventOptions, Transport};
use serde_json::Value;

use crate::pyval::truthy;
use crate::{pyerr, sibling};

const NAMES: [&str; 4] = ["workspace.created", "workspace.closed", "workspace.renamed", "workspace.selected"];

struct Cfg {
    state: PathBuf,
    interval: i64,
    tick: i64,
    board_tick: i64,
}

impl Cfg {
    fn stamp(&self) -> PathBuf {
        self.state.join("sync-stamp")
    }
    fn cursor(&self) -> PathBuf {
        self.state.join("events.seq")
    }
    fn pidfile(&self) -> PathBuf {
        self.state.join("listen.pid")
    }
}

/// One reconcile at a time: the ticker and the event loop both claim the stamp.
static CLAIM: Mutex<()> = Mutex::new(());
/// The last board push, so a tick can decline to stack another on top.
static LAST_PUSH: Mutex<Option<Child>> = Mutex::new(None);

/// stderr, `HH:MM:SS msg`, as the log under launchd reads.
fn log(msg: &str) {
    let now = crew_core::py::now() as libc::time_t;
    // SAFETY: localtime_r fills tm, which we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&now, &mut tm) };
    eprintln!("{:02}:{:02}:{:02} {msg}", tm.tm_hour, tm.tm_min, tm.tm_sec);
}

fn disabled(c: &Cfg) -> bool {
    c.state.join("disabled").exists() || std::env::var("CREW_DISABLED").is_ok_and(|v| !v.is_empty())
}

/// The shared throttle allows another reconcile.
fn due(c: &Cfg) -> bool {
    let Ok(text) = std::fs::read_to_string(c.stamp()) else { return true };
    let t = crate::pyval::py_strip(&text);
    let last = if t.is_empty() { Some(0) } else { crate::pyval::py_int(t) };
    match last {
        Some(last) => (crew_core::py::now() as i128 - last) >= c.interval as i128,
        None => true, // int() raised
    }
}

/// Bring the board's click server up if it is not already answering.
fn start_intent() -> bool {
    let (status, start): (Vec<String>, Vec<String>) = match sibling::own("crew-board-intent") {
        Some(head) => (
            head.iter().cloned().chain(["--status".to_string()]).collect(),
            head,
        ),
        None => {
            let intent = sibling::home_path("board/crew-board-intent");
            if !sibling::readable(&intent) {
                return false;
            }
            let p = intent.to_string_lossy().into_owned();
            (vec!["python3".into(), p.clone(), "--status".into()], vec!["python3".into(), p])
        }
    };
    let argv: Vec<&str> = status.iter().map(String::as_str).collect();
    match crate::proc::run(&argv, None, &[], Some(Duration::from_secs(8))) {
        Some(st) if st.stdout.contains("\"running\": true") => true,
        Some(_) => match sibling::spawn_reaped(&start) {
            Ok(()) => {
                log("intent server started");
                true
            }
            Err(e) => {
                log(&format!("intent server failed to start: {e}"));
                false
            }
        },
        None => {
            log("intent server failed to start: it did not answer --status");
            false
        }
    }
}

/// One board update, fire-and-forget; never creates a surface.
fn push_board(fast: bool, selected: Option<&str>, skip_if_busy: bool) -> bool {
    let head = match sibling::own("crew-board") {
        Some(h) => h,
        None => {
            let board = sibling::home_path("board/crew-board");
            if !sibling::executable(&board) {
                return false;
            }
            vec![board.to_string_lossy().into_owned()]
        }
    };
    let mut last = LAST_PUSH.lock().unwrap_or_else(|p| p.into_inner());
    if skip_if_busy {
        if let Some(ch) = last.as_mut() {
            if matches!(ch.try_wait(), Ok(None)) {
                return false;
            }
        }
    }
    let mut argv = head;
    argv.push("push".into());
    if fast {
        argv.push("--fast".into());
    }
    if let Some(s) = selected {
        argv.extend(["--selected".into(), s.to_string()]);
    }
    match sibling::spawn_detached(&argv) {
        Ok(child) => {
            // The one it replaces is reaped on its own thread.
            if let Some(mut old) = last.replace(child) {
                std::thread::spawn(move || {
                    let _ = old.wait();
                });
            }
            true
        }
        Err(e) => {
            log(&format!("board push failed to start: {e}"));
            false
        }
    }
}

/// Claim the stamp, then start a reconcile in the background.
fn reconcile(c: &Cfg, reason: &str) -> bool {
    {
        let _g = CLAIM.lock().unwrap_or_else(|p| p.into_inner());
        if disabled(c) || !due(c) {
            return false;
        }
        let _ = std::fs::create_dir_all(&c.state);
        let _ = std::fs::write(c.stamp(), (crew_core::py::now() as i64).to_string());
    }
    let Some(sync) = sibling::own("crew-sync") else {
        log("no seamux binary to run crew-sync");
        return false;
    };
    match sibling::spawn_reaped(&sync) {
        Ok(()) => {
            push_board(false, None, false);
            log(&format!("reconcile <- {reason}"));
            true
        }
        Err(e) => {
            log(&format!("reconcile failed to start: {e}"));
            false
        }
    }
}

/// A switch moves the board's ring and the pane frame now, with the event's id.
fn follow_selection(wsid: Option<&str>) {
    push_board(true, wsid, false);
    if std::env::var("CREW_FRAME").as_deref() == Ok("0") {
        return;
    }
    let Some(mut argv) = sibling::own("crew-frame") else { return };
    if let Some(w) = wsid {
        argv.extend(["--workspace".into(), w.to_string()]);
    }
    if let Err(e) = sibling::spawn_reaped(&argv) {
        log(&format!("frame follow failed to start: {e}"));
    }
}

fn pid_alive(pid: i64) -> bool {
    libc::pid_t::try_from(pid).is_ok_and(|p| unsafe { libc::kill(p, 0) } == 0)
}

/// The live daemon's pid, or 0 (clearing a stale pidfile).
fn running_pid(c: &Cfg) -> i64 {
    let Ok(text) = std::fs::read_to_string(c.pidfile()) else { return 0 };
    let t = crate::pyval::py_strip(&text);
    let pid = if t.is_empty() { Some(0) } else { crate::pyval::py_int(t).and_then(|v| i64::try_from(v).ok()) };
    let Some(pid) = pid else { return 0 };
    if pid != 0 && pid != std::process::id() as i64 && pid_alive(pid) {
        return pid;
    }
    let _ = std::fs::remove_file(c.pidfile());
    0
}

/// The pidfile path for the ^C handler, which may only make async-signal-safe calls.
static PIDFILE_C: std::sync::OnceLock<std::ffi::CString> = std::sync::OnceLock::new();

extern "C" fn on_interrupt(_: libc::c_int) {
    // ^C, as a person stops it: clear the pidfile, take the `cmux events`
    // child with us when it shares our group, and exit 0.
    unsafe {
        if let Some(p) = PIDFILE_C.get() {
            libc::unlink(p.as_ptr());
        }
        if libc::getpgrp() == libc::getpid() {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
            libc::kill(0, libc::SIGTERM);
        }
        libc::_exit(0);
    }
}

/// One run of the event stream; true when the listener should stop.
fn follow(c: &Cfg) -> bool {
    let Ok(cm) = Cmux::connect() else { return false };
    // On the socket a dropped stream ends this run, so the retry below (2s
    // doubling to 300s, logged) paces it as the Python's did. A `cmux events`
    // child keeps --reconnect in its argv, as the Python passed it.
    let opts = EventOptions {
        names: NAMES.iter().map(|s| s.to_string()).collect(),
        cursor_file: Some(c.cursor()),
        reconnect: matches!(cm.transport(), Transport::Cli(_)),
    };
    let Ok(stream) = cm.events(opts) else { return false };
    for frame in stream {
        let ev = match frame {
            Ok(v) => v,
            Err(cmux::Error::Protocol(_)) => continue, // an unparseable line
            Err(_) => break,
        };
        let name = ev.get("name").filter(|v| truthy(Some(v))).and_then(Value::as_str).unwrap_or("");
        if !NAMES.contains(&name) {
            continue;
        }
        if name == "workspace.selected" {
            let id = ev
                .get("payload")
                .and_then(|p| p.get("workspace_id"))
                .filter(|v| truthy(Some(v)))
                .or_else(|| ev.get("workspace_id").filter(|v| truthy(Some(v))))
                .map(crate::pyval::py_str);
            follow_selection(id.as_deref());
        }
        if !reconcile(c, name) {
            log(&format!("{name} (no reconcile: {})", if disabled(c) { "crew off" } else { "throttled" }));
        }
    }
    false
}

pub fn main(args: &[String]) -> i32 {
    let int = |k: &str, d: i64| match std::env::var(k) {
        Ok(v) => crate::pyval::py_int(&v).and_then(|n| i64::try_from(n).ok()),
        Err(_) => Some(d),
    };
    let Some(interval) = int("CREW_SYNC_INTERVAL", 120) else {
        return pyerr::crash("ValueError: invalid literal for int() with base 10");
    };
    let (Some(tick), Some(board_tick)) = (int("CREW_TICK_SECONDS", interval), int("CREW_BOARD_TICK", 10)) else {
        return pyerr::crash("ValueError: invalid literal for int() with base 10");
    };
    let c = Cfg { state: crew_core::home::xdg_cache(), interval, tick, board_tick };
    let _ = std::fs::create_dir_all(&c.state);

    if args.iter().any(|a| a == "--once") {
        let out = if reconcile(&c, "--once") {
            "reconciled"
        } else if disabled(&c) {
            "disabled"
        } else {
            "not due"
        };
        println!("{out}");
        return 0;
    }

    match cmux::resolve_cli_bin() {
        Ok(bin) if sibling::executable(&bin) => {}
        Ok(bin) => {
            log(&format!("no cmux binary at {}", bin.display()));
            return 1;
        }
        Err(_) => {
            log("no cmux binary at cmux");
            return 1;
        }
    }

    // Singleton: every new Claude session's SessionStart would start another.
    let other = running_pid(&c);
    if other != 0 {
        log(&format!("already running as pid {other}"));
        return 0;
    }
    let _ = std::fs::write(c.pidfile(), std::process::id().to_string());
    if let Ok(p) = std::ffi::CString::new(c.pidfile().as_os_str().as_encoded_bytes()) {
        let _ = PIDFILE_C.set(p);
    }
    // SAFETY: the handler makes only async-signal-safe calls.
    unsafe {
        libc::signal(libc::SIGINT, on_interrupt as *const () as libc::sighandler_t);
    }

    // A board cmux restored after a restart is blank until something pushes.
    start_intent();
    push_board(false, None, false);
    follow_selection(None);

    let ticks = std::sync::Arc::new(Cfg { state: c.state.clone(), ..c });
    let t = ticks.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(t.tick.max(0) as u64));
        reconcile(&t, "tick");
    });
    let fast = 0 < ticks.board_tick && ticks.board_tick < ticks.tick;
    if fast {
        let bt = ticks.board_tick as u64;
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(bt));
            push_board(true, None, true);
        });
    }
    log(&format!(
        "listening for {} (throttle {}s, tick {}s, board {}s)",
        NAMES.join(", "),
        ticks.interval,
        ticks.tick,
        if fast { ticks.board_tick } else { ticks.tick }
    ));
    // The stream is retried forever with backoff: a cmux restart degrades to
    // tick-only reconciles, never to a dead listener.
    let mut backoff = 2u64;
    loop {
        let started = crew_core::py::now();
        if follow(&ticks) {
            let _ = std::fs::remove_file(ticks.pidfile());
            return 0;
        }
        if crew_core::py::now() - started > 60.0 {
            backoff = 2;
        }
        log(&format!("event stream ended; retrying in {backoff}s"));
        std::thread::sleep(Duration::from_secs(backoff));
        backoff = (backoff * 2).min(300);
    }
}
