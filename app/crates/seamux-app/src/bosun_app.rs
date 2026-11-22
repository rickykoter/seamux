//! The Bosun's commands for the app's pages (bosun.ts: the ⌘4 tab, its rail
//! and the ⌘B drop-down; bosun_ask.ts: Ask the Bosun on Radar and Lookout).
//! Each wraps crew_core::bosun, so no page reads the Bosun's files itself.
//!
//! The Bosun runs on the tmux backend only. On cmux, status says so and
//! ensure and send refuse with the reason; the log is only files, so it
//! reads on either.

use std::path::Path;

use crew_core::backend::tmux::TmuxBackend;
use crew_core::backend::Kind;
use crew_core::bosun::{self, launch, log, queue};
use serde_json::{json, Value};

/// What ensure and send say on cmux.
pub const NEEDS_TMUX: &str = "The Bosun runs on the app's tmux backend; this app runs on cmux.";

/// Who an app-queued prompt is from, in its queue item.
const SOURCE: &str = "app";

/// The Bosun as the page sees it: crew_core::bosun::status_at's {ws, pane,
/// live, state, session, day, root}, plus the backend and whether the Bosun
/// has a row at all (`known`). On cmux, only {backend, tmux: false}.
fn status_in(kind: Kind, t: &TmuxBackend, dir: &Path) -> Result<Value, String> {
    if kind != Kind::Tmux {
        return Ok(json!({"backend": kind.name(), "tmux": false, "known": false, "live": false, "why": NEEDS_TMUX}));
    }
    let mut v = bosun::status_at(t, dir)?;
    let known = v["ws"].as_str().is_some_and(|w| !w.is_empty());
    v["backend"] = json!(kind.name());
    v["tmux"] = json!(true);
    v["known"] = json!(known);
    Ok(v)
}

/// Whether the app should start the Bosun at launch: only once it has a
/// row (the person started it once) and no live pane. A Bosun never
/// started stays unstarted until the tab or ⌘B asks for it.
fn wants_revive(status: &Value) -> bool {
    status["tmux"] == true && status["known"] == true && status["live"] != true
}

/// One day of the answer log, and the days that have one (newest first),
/// so the rail can ask for the day before.
fn log_in(dir: &Path, day: Option<&str>) -> Result<Value, String> {
    let day = day.map(str::to_string).unwrap_or_else(today);
    let entries = log::list(dir, &day)?;
    Ok(json!({"day": day, "today": today(), "days": log::days(dir), "entries": entries}))
}

fn send_in(kind: Kind, dir: &Path, text: &str) -> Result<String, String> {
    if kind != Kind::Tmux {
        return Err(NEEDS_TMUX.into());
    }
    if text.trim().is_empty() {
        return Err("nothing to ask".into());
    }
    queue::enqueue(dir, text.trim(), SOURCE).map(|i| i.id)
}

fn today() -> String {
    launch::local_day_hour(launch::now_secs()).0
}

fn status_now() -> Result<Value, String> {
    status_in(seamux_app::backend::kind(), &TmuxBackend::default(), &bosun::config::dir())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Where the Bosun is and what it is doing.
#[tauri::command]
pub async fn bosun_status() -> Result<Value, String> {
    blocking(status_now).await
}

/// Start the Bosun if it is not running, then its status.
#[tauri::command]
pub async fn bosun_ensure() -> Result<Value, String> {
    blocking(|| {
        if seamux_app::backend::kind() != Kind::Tmux {
            return Err(NEEDS_TMUX.to_string());
        }
        bosun::ensure()?;
        status_now()
    })
    .await
}

/// A day of the answer log (today when `day` is absent).
#[tauri::command]
pub async fn bosun_log(day: Option<String>) -> Result<Value, String> {
    blocking(move || log_in(&bosun::config::dir(), day.as_deref())).await
}

/// Queue `text` for the Bosun; the supervisor types it at its next idle
/// turn. Returns the queue item's id.
#[tauri::command]
pub async fn bosun_send(text: String) -> Result<String, String> {
    blocking(move || send_in(seamux_app::backend::kind(), &bosun::config::dir(), &text)).await
}

/// At launch, on its own thread: bring back a Bosun that was started once
/// and is gone now (a reboot, a tmux kill-server), so its loops run again.
pub fn start() {
    std::thread::spawn(|| {
        let Ok(s) = status_now() else { return };
        if wants_revive(&s) {
            if let Err(e) = bosun::ensure() {
                eprintln!("seamux: could not bring the Bosun back: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway folder for the Bosun's files and the tmux registry:
    /// never the person's own (L10).
    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bosun-app-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn on_cmux_status_says_tmux_and_send_refuses() {
        let d = temp("cmux");
        let s = status_in(Kind::Cmux, &TmuxBackend::at(d.join("tmux")), &d).unwrap();
        assert_eq!(s["tmux"], false);
        assert_eq!(s["why"], NEEDS_TMUX);
        assert!(!wants_revive(&s));
        assert_eq!(send_in(Kind::Cmux, &d, "anything?").unwrap_err(), NEEDS_TMUX);
        assert!(queue::waiting(&d).is_empty());
    }

    #[test]
    fn a_bosun_never_started_is_not_started_at_launch() {
        let d = temp("unknown");
        let s = status_in(Kind::Tmux, &TmuxBackend::at(d.join("tmux")), &d).unwrap();
        assert_eq!(s["known"], false);
        assert!(!wants_revive(&s));
    }

    #[test]
    fn only_a_known_bosun_with_no_live_pane_is_revived() {
        let gone = json!({"tmux": true, "known": true, "live": false});
        let live = json!({"tmux": true, "known": true, "live": true});
        assert!(wants_revive(&gone));
        assert!(!wants_revive(&live));
    }

    #[test]
    fn send_queues_for_the_app_and_skips_blank_text() {
        let d = temp("send");
        assert!(send_in(Kind::Tmux, &d, "  \n").is_err());
        let id = send_in(Kind::Tmux, &d, " is PROJ-9 still blocked? ").unwrap();
        let w = queue::waiting(&d);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].id, id);
        assert_eq!(w[0].text, "is PROJ-9 still blocked?");
        assert_eq!(w[0].source, "app");
    }

    #[test]
    fn the_log_reads_a_day_and_names_the_days_there_are() {
        let d = temp("log");
        let e = json!({"question": "what's open?", "answer": "3 PRs", "sources": [{"kind": "gh", "ref": "o/r#812", "label": "PR 812"}], "asker": "app"});
        let added = log::add(&d, &e).unwrap();
        let day = log::days(&d).first().cloned().unwrap();
        let v = log_in(&d, Some(&day)).unwrap();
        assert_eq!(v["day"], day);
        assert_eq!(v["entries"][0]["id"], added["id"]);
        assert_eq!(v["days"], json!([day]));
        assert!(log_in(&d, Some("not-a-day")).is_err());
    }
}
