//! crew-sync on the app's tmux: on a tick, and when a workspace opens or
//! closes. On cmux that is crew-listen's job; it follows cmux's event stream
//! and does not run without cmux, so on tmux only a turn's Stop hook ran
//! crew-sync, and the board, the Dock and the land watcher went stale while
//! every session idled (plan tmux-sync-timer).
//!
//! Each pass looks at the registry (workspaces.json). Only a change in its
//! set of workspace ids counts: crew-sync writes each workspace's facts into
//! the same file, and following those writes would follow crew's own, which
//! crew-listen avoids for the same reason. A change seen while the shared
//! sync-stamp is not due waits for it rather than being dropped. Every try
//! goes through crew-listen's own claim, so the watcher, crew-listen and the
//! Stop hook throttle by one stamp.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use crew_core::backend::Kind;
use serde_json::Value;

/// How often a pass looks at the registry and the clock.
const PASS: Duration = Duration::from_secs(2);

/// What the passes have seen, apart from the disk and the clock.
#[derive(Debug)]
struct Watch {
    /// The registry's workspace ids at the last read; None before the first.
    ids: Option<BTreeSet<String>>,
    /// A workspace opened or closed and no sync has run since.
    pending: bool,
    /// When the last try was made (claimed or not).
    tried: i64,
}

impl Watch {
    /// A watcher whose first pass tries at once: a sync soon after launch,
    /// if the stamp allows.
    fn new(now: i64, tick: i64) -> Watch {
        Watch { ids: None, pending: false, tried: now - tick }
    }

    /// The registry's ids, read again because the file changed. The first
    /// read is not a change.
    fn saw(&mut self, ids: BTreeSet<String>) {
        if self.ids.as_ref().is_some_and(|old| *old != ids) {
            self.pending = true;
        }
        self.ids = Some(ids);
    }

    /// Why a sync should be tried now, if it should.
    fn reason(&self, now: i64, tick: i64) -> Option<&'static str> {
        if self.pending {
            Some("workspaces")
        } else if now - self.tried >= tick {
            Some("tick")
        } else {
            None
        }
    }

    /// A try was made. A pending change is settled only by a sync that ran.
    fn tried(&mut self, now: i64, claimed: bool) {
        self.tried = now;
        if claimed {
            self.pending = false;
        }
    }
}

/// The workspace ids in a registry's text; None when it does not parse.
fn ids_of(text: &str) -> Option<BTreeSet<String>> {
    let v: Value = serde_json::from_str(text).ok()?;
    let rows = v.get("workspaces")?.as_array()?;
    Some(rows.iter().filter_map(|w| w.get("id").and_then(Value::as_str)).map(str::to_string).collect())
}

/// The registry's ids when its mtime moved since `seen`, else None. A
/// missing or unreadable file reads as unchanged.
fn read_if_changed(path: &Path, seen: &mut Option<SystemTime>) -> Option<BTreeSet<String>> {
    let m = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    if *seen == Some(m) {
        return None;
    }
    let ids = ids_of(&std::fs::read_to_string(path).ok()?)?;
    *seen = Some(m);
    Some(ids)
}

/// An env number of seconds, else the default (a bad value too).
fn secs(name: &str, default: i64) -> i64 {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(default)
}

/// Start `seamux crew-sync` in the background, with the login shell's PATH
/// so it finds gh.
fn spawn_sync(why: &str) {
    let child = Command::new(crate::pane_app::seamux_cli())
        .arg("crew-sync")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("CLAUDECODE")
        .env("PATH", crate::shell::login_path())
        .spawn();
    match child {
        Ok(mut c) => {
            std::thread::spawn(move || {
                let _ = c.wait();
            });
        }
        Err(e) => eprintln!("seamux: crew-sync ({why}) did not start: {e}"),
    }
}

/// The watcher, on the tmux backend only; on cmux crew-listen does this.
pub fn start() {
    std::thread::spawn(|| {
        if seamux_app::backend::kind() != Kind::Tmux {
            return;
        }
        let state = crew_core::home::xdg_cache();
        let registry = crew_core::backend::tmux::state_dir().join("workspaces.json");
        let interval = secs("CREW_SYNC_INTERVAL", 120);
        let tick = secs("CREW_TICK_SECONDS", interval).max(1);
        let now = || crew_core::py::now() as i64;
        let mut w = Watch::new(now(), tick);
        let mut seen = None;
        loop {
            if let Some(ids) = read_if_changed(&registry, &mut seen) {
                w.saw(ids);
            }
            if let Some(why) = w.reason(now(), tick) {
                let claimed = crew_cli::listen::claim(&state, interval);
                if claimed {
                    spawn_sync(why);
                }
                w.tried(now(), claimed);
            }
            std::thread::sleep(PASS);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_first_pass_tries_and_then_it_waits_a_tick() {
        let mut w = Watch::new(1000, 120);
        assert_eq!(w.reason(1000, 120), Some("tick"));
        w.tried(1000, true);
        assert_eq!(w.reason(1119, 120), None);
        assert_eq!(w.reason(1120, 120), Some("tick"));
    }

    #[test]
    fn the_first_registry_read_is_not_a_change() {
        let mut w = Watch::new(1000, 120);
        w.tried(1000, true);
        w.saw(set(&["W1", "W2"]));
        assert_eq!(w.reason(1001, 120), None);
    }

    #[test]
    fn a_write_that_keeps_the_ids_is_not_a_change() {
        // crew-sync writing a workspace's facts: same ids, new mtime.
        let mut w = Watch::new(1000, 120);
        w.tried(1000, true);
        w.saw(set(&["W1"]));
        w.saw(set(&["W1"]));
        assert_eq!(w.reason(1001, 120), None);
    }

    #[test]
    fn an_opened_or_closed_workspace_tries_at_once_and_waits_for_a_claim() {
        let mut w = Watch::new(1000, 120);
        w.tried(1000, true);
        w.saw(set(&["W1"]));
        w.saw(set(&["W1", "W2"]));
        assert_eq!(w.reason(1010, 120), Some("workspaces"));
        // The stamp was not due: the change is kept and tried next pass.
        w.tried(1010, false);
        assert_eq!(w.reason(1012, 120), Some("workspaces"));
        w.tried(1012, true);
        assert_eq!(w.reason(1014, 120), None);
        w.saw(set(&["W2"]));
        assert_eq!(w.reason(1016, 120), Some("workspaces"), "a close counts too");
    }

    #[test]
    fn ids_come_from_the_registry_rows() {
        let t = r#"{"version":1,"workspaces":[{"id":"W1","title":"shop","cwd":"/w"},{"id":"W2"},{"title":"no id"}],"panes":[]}"#;
        assert_eq!(ids_of(t), Some(set(&["W1", "W2"])));
        assert_eq!(ids_of("{not json"), None);
        assert_eq!(ids_of(r#"{"version":1}"#), None);
    }

    #[test]
    fn the_registry_is_read_again_only_when_its_mtime_moves() {
        // A temp registry, never ~/.local/state (L8).
        let d = std::env::temp_dir().join(format!("sync-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("workspaces.json");
        let mut seen = None;
        assert_eq!(read_if_changed(&p, &mut seen), None, "no file yet");
        std::fs::write(&p, r#"{"workspaces":[{"id":"W1"}]}"#).unwrap();
        assert_eq!(read_if_changed(&p, &mut seen), Some(set(&["W1"])));
        assert_eq!(read_if_changed(&p, &mut seen), None, "same mtime");
        std::fs::write(&p, r#"{"workspaces":[{"id":"W1"},{"id":"W2"}]}"#).unwrap();
        // Past the clock's grain, so the mtime moves whatever the filesystem.
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
        assert_eq!(read_if_changed(&p, &mut seen), Some(set(&["W1", "W2"])));
        let _ = std::fs::remove_dir_all(&d);
    }
}
