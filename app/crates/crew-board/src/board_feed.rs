//! The served board's feed: one worker per server builds the ranked state
//! from cmux events, plan-state stat and a heartbeat (as `crew-board watch`
//! does) and hands each change to every /board/events subscriber. No request
//! thread waits on a build. The worker stops a minute after the last
//! subscriber leaves (the event tail and plan watcher it wakes on stay, one
//! of each per server). Each build also writes the click table, so /do
//! resolves the rows the page shows.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

use crew_core::pyjson;

use crate::server::{dp_state, log};
use crate::state::{self, Opts};

pub const BOARD_JS: &str = include_str!("inject/board.js");

const WAKE_EVENTS: [&str; 6] = [
    "agent.hook.Notification", "agent.hook.Stop", "workspace.created",
    "workspace.closed", "workspace.renamed", "workspace.selected",
];
const IDLE_STOP: Duration = Duration::from_secs(60);

/// CREW_BOARD_HEARTBEAT seconds (30 by default): the backstop for what no
/// event announces (CI, review and Jira state).
fn heartbeat() -> Duration {
    let h = std::env::var("CREW_BOARD_HEARTBEAT").ok().and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(30.0);
    // Clamped: a nonsense value (0, inf, 1e30) must not stop the feed.
    Duration::from_secs_f64(if h.is_finite() && h > 0.0 { h.clamp(0.1, 3600.0) } else { 30.0 })
}

pub type Sub = Arc<Mutex<VecDeque<String>>>;

struct Inner {
    subs: Vec<Sub>,
    last: Option<String>,
    running: bool,
    /// The event tail and the plan watcher: started once, for the server's life.
    watching: bool,
}

pub struct Feed {
    inner: Mutex<Inner>,
    news: Condvar,
    dirty: Mutex<bool>,
    woke: Condvar,
}

pub fn feed() -> &'static Feed {
    static F: OnceLock<Feed> = OnceLock::new();
    F.get_or_init(|| Feed {
        inner: Mutex::new(Inner { subs: Vec::new(), last: None, running: false, watching: false }),
        news: Condvar::new(),
        dirty: Mutex::new(false),
        woke: Condvar::new(),
    })
}

impl Feed {
    fn mark_dirty(&self) {
        *self.dirty.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.woke.notify_all();
    }

    /// Wait for a wake or the heartbeat: true when something woke it.
    fn wait_dirty(&self, t: Duration) -> bool {
        let g = self.dirty.lock().unwrap_or_else(|p| p.into_inner());
        let (mut g, _) = self.woke.wait_timeout_while(g, t, |d| !*d).unwrap_or_else(|p| p.into_inner());
        std::mem::replace(&mut *g, false)
    }

    fn clear_dirty(&self) {
        *self.dirty.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }

    pub fn subscribe(&'static self) -> Sub {
        let q: Sub = Arc::new(Mutex::new(VecDeque::new()));
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(l) = &inner.last {
            q.lock().unwrap().push_back(l.clone());
        }
        inner.subs.push(q.clone());
        if !inner.watching {
            inner.watching = true;
            std::thread::spawn(move || self.tail_events());
            std::thread::spawn(move || self.watch_plans());
        }
        if !inner.running {
            inner.running = true;
            self.mark_dirty();
            std::thread::spawn(move || {
                // An idle stop clears `running` itself, under the lock; a panic
                // is cleared here, so the next subscriber starts another worker.
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.work())).is_err() {
                    log("FAIL board feed worker panicked; the next subscriber restarts it");
                    self.inner.lock().unwrap_or_else(|p| p.into_inner()).running = false;
                }
            });
        }
        q
    }

    pub fn unsubscribe(&self, q: &Sub) {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).subs.retain(|s| !Arc::ptr_eq(s, q));
    }

    /// The next state line for this subscriber, or None after `t`.
    pub fn wait(&self, q: &Sub, t: Duration) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if q.lock().unwrap().is_empty() {
            let _ = self.news.wait_timeout(inner, t);
        }
        q.lock().unwrap().pop_front()
    }

    fn publish(&self, line: String) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.last = Some(line.clone());
        for q in &inner.subs {
            // Each state is the whole board: a slow reader needs only the newest.
            let mut q = q.lock().unwrap();
            q.clear();
            q.push_back(line.clone());
        }
        self.news.notify_all();
    }

    fn work(&'static self) {
        let mut last_payload: Option<String> = None;
        let mut idle_since: Option<Instant> = None;
        loop {
            let woke = self.wait_dirty(heartbeat());
            {
                let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                if inner.subs.is_empty() {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() > IDLE_STOP {
                        // The next page builds afresh rather than paint an old snapshot.
                        inner.last = None;
                        inner.running = false;
                        return;
                    }
                } else {
                    idle_since = None;
                }
            }
            if woke {
                // Coalesce a burst: created+renamed+selected arrive together.
                std::thread::sleep(Duration::from_millis(150));
                self.clear_dirty();
            }
            let built = std::panic::catch_unwind(|| state::build(&Opts { screens: false, fast: false, selected: None, fixture: None, fixture_panes: None }));
            let Ok(d) = built else {
                log("FAIL board feed build: it panicked; trying again on the next wake");
                continue;
            };
            state::write_targets(&d);
            // Rows and news decide whether a viewer would see a change; the
            // clock alone does not.
            let payload = pyjson::dumps(&Value::Array(vec![d["rows"].clone(), d["news"].clone()]));
            if Some(&payload) == last_payload.as_ref() {
                continue;
            }
            last_payload = Some(payload);
            self.publish(pyjson::dumps(&d));
        }
    }

    fn tail_events(&self) {
        let mut backoff = Duration::from_secs(1);
        // Said once when the stream goes away, not on every retry.
        let mut said = false;
        loop {
            let stream = crate::cmux_cli::client().and_then(|c| {
                c.events(cmux::EventOptions {
                    names: WAKE_EVENTS.iter().map(|s| s.to_string()).collect(),
                    cursor_file: None,
                    reconnect: false,
                })
                .ok()
            });
            match stream {
                Some(events) => {
                    backoff = Duration::from_secs(1);
                    said = false;
                    for _ in events {
                        self.mark_dirty();
                    }
                    crate::cmux_cli::failed();
                }
                None => {
                    if !said {
                        log("board feed: no cmux event stream; the heartbeat carries the board");
                        said = true;
                    }
                    crate::cmux_cli::failed();
                }
            }
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    fn watch_plans(&self) {
        // Plan state files, the app's tucked.json (a tuck shows at once), and
        // on the tmux backend's side the pane-status files and the registry:
        // a Claude that asks there is no cmux event, only a pane file write.
        let print = || (plan_fingerprint(), crate::tucked::stamp(), pane_fingerprint());
        let mut last = print();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let cur = print();
            if cur != last {
                last = cur;
                self.mark_dirty();
            }
        }
    }
}

type Print = Vec<(String, Option<SystemTime>, u64)>;

/// mtime and size of every plan state file: deep-plan writes a file, and that
/// is the whole signal of an increment moving.
fn plan_fingerprint() -> Print {
    fingerprint(&dp_state(), &|n| n.ends_with(".json"))
}

/// The hooks' pane-<key>.json files in crew's state folder, and the tmux
/// backend's workspace registry (a pane started or closed, a sync's facts).
/// Only on the tmux backend: under cmux its events already wake the board.
fn pane_fingerprint() -> Print {
    if crate::backend::tmux().is_none() {
        return Vec::new();
    }
    let mut out = fingerprint(&crate::state::state_dir(), &|n| n.starts_with("pane-") && n.ends_with(".json"));
    out.extend(fingerprint(&crew_core::backend::tmux::state_dir(), &|n| n == "workspaces.json"));
    out
}

/// (name, mtime, size) of the files in `dir` whose names pass `keep`, by name.
fn fingerprint(dir: &std::path::Path, keep: &dyn Fn(&str) -> bool) -> Print {
    let mut out: Print = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| keep(&e.file_name().to_string_lossy()))
        .map(|e| {
            let m = e.metadata().ok();
            (e.file_name().to_string_lossy().into_owned(), m.as_ref().and_then(|m| m.modified().ok()),
             m.map(|m| m.len()).unwrap_or(0))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pane_file_write_changes_the_fingerprint() {
        let dir = std::env::temp_dir().join(format!("crew-feed-print-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let panes = |n: &str| n.starts_with("pane-") && n.ends_with(".json");
        std::fs::write(dir.join("pane-P1.json"), r#"{"state":"working"}"#).unwrap();
        std::fs::write(dir.join("asked-payload-X"), "x").unwrap();
        let a = fingerprint(&dir, &panes);
        assert_eq!(a.len(), 1, "only pane files: {a:?}");
        std::fs::write(dir.join("pane-P1.json"), r#"{"state":"needs_input"}"#).unwrap();
        assert_ne!(fingerprint(&dir, &panes), a, "a state change is a different size");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
