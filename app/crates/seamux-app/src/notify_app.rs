//! Notifications on the tmux backend (ADR 5). Under cmux, cmux posts them
//! from the hooks; here nothing would, since hooks are separate processes
//! that cannot reach the app. So once a second the app reads the pane-status
//! files and posts when a pane starts waiting on you, or finishes a turn
//! (working to idle). bash-guard's blocks arrive as blocked-<key>.json files
//! in the same folder: each is posted once and deleted.
//!
//! The first look only learns the states: a pane already waiting when the
//! app starts is not announced as if it had just asked.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crew_core::backend::tmux::TmuxBackend;
use crew_core::backend::{Backend, Kind};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// One notification: its title and body.
#[derive(Debug, PartialEq)]
pub struct Note {
    pub title: String,
    pub body: String,
}

/// What to post for panes whose state went from `before` to `now`
/// (pane id → state). `name` gives a pane's "workspace · pane" label.
pub fn transitions(before: &HashMap<String, String>, now: &HashMap<String, String>, name: &dyn Fn(&str) -> String) -> Vec<Note> {
    let mut out: Vec<(String, Note)> = now
        .iter()
        .filter_map(|(pane, st)| {
            let was = before.get(pane)?;
            let body = name(pane);
            if st == "needs_input" && was != "needs_input" {
                Some((pane.clone(), Note { title: "Claude is waiting on you".into(), body }))
            } else if st == "idle" && was == "working" {
                Some((pane.clone(), Note { title: "Claude finished its turn".into(), body }))
            } else {
                None
            }
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, n)| n).collect()
}

/// A blocked-<key>.json from bash-guard, as a notification.
pub fn blocked_note(v: &Value, name: &dyn Fn(&str) -> String) -> Option<Note> {
    let reason = v.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty())?;
    let cmd = v.get("command").and_then(Value::as_str).unwrap_or("");
    let pane = v.get("pane").and_then(Value::as_str).unwrap_or("");
    let who = if pane.is_empty() { String::new() } else { format!("{} · ", name(pane)) };
    Some(Note { title: format!("Claude · blocked: {reason}"), body: format!("{who}{cmd}") })
}

/// Post every blocked file in `dir` once: read, post, delete. A file that
/// cannot be read is deleted too, so it is never retried forever.
pub fn take_blocked(dir: &Path, name: &dyn Fn(&str) -> String) -> Vec<Note> {
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("blocked-") && n.ends_with(".json")))
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|p| {
            let note = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| blocked_note(&v, name));
            let _ = std::fs::remove_file(&p);
            note
        })
        .collect()
}

/// The notifier's loop, started at launch; it returns at once unless the
/// app runs on the tmux backend.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if seamux_app::backend::kind() != Kind::Tmux {
            return;
        }
        let state = crew_core::home::home_cache();
        let t = TmuxBackend::default();
        let mut before: Option<HashMap<String, String>> = None;
        loop {
            let titles: HashMap<String, String> = t.workspaces().unwrap_or_default().into_iter().map(|w| (w.id.to_ascii_uppercase(), w.title)).collect();
            let panes = t.panes(None).unwrap_or_default();
            let ws_of: HashMap<String, String> = panes.iter().map(|p| (p.id.clone(), p.workspace.to_ascii_uppercase())).collect();
            let name = |pane: &str| {
                let ws = ws_of.get(pane).and_then(|w| titles.get(w)).cloned().unwrap_or_else(|| "a workspace".into());
                format!("{ws} · Claude")
            };
            let now: HashMap<String, String> = panes
                .iter()
                .filter_map(|p| crew_core::status::read(&state, &p.id).map(|s| (p.id.clone(), s.state)))
                .collect();
            let mut notes = before.as_ref().map(|b| transitions(b, &now, &name)).unwrap_or_default();
            notes.extend(take_blocked(&state, &name));
            for n in notes {
                let _ = app.notification().builder().title(&n.title).body(&n.body).show();
            }
            before = Some(now);
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(v: &[(&str, &str)]) -> HashMap<String, String> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    fn name(p: &str) -> String {
        format!("shop · {p}")
    }

    #[test]
    fn needs_input_posts_and_idle_to_idle_does_not() {
        let n = transitions(&map(&[("P1", "working"), ("P2", "idle")]), &map(&[("P1", "needs_input"), ("P2", "idle")]), &name);
        assert_eq!(n, vec![Note { title: "Claude is waiting on you".into(), body: "shop · P1".into() }]);
        assert!(transitions(&map(&[("P1", "needs_input")]), &map(&[("P1", "needs_input")]), &name).is_empty(), "still waiting: once");
        let done = transitions(&map(&[("P1", "working")]), &map(&[("P1", "idle")]), &name);
        assert_eq!(done[0].title, "Claude finished its turn");
        assert!(transitions(&map(&[("P1", "needs_input")]), &map(&[("P1", "idle")]), &name).is_empty(), "answered, not finished");
        assert!(transitions(&map(&[]), &map(&[("P1", "needs_input")]), &name).is_empty(), "a pane first seen waiting is not news");
    }

    #[test]
    fn a_blocked_file_is_posted_once_and_deleted() {
        let dir = std::env::temp_dir().join(format!("seamux-notify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("blocked-P1.json");
        std::fs::write(&f, json!({"pane": "P1", "workspace": "W1", "reason": "force push", "command": "git push -f"}).to_string()).unwrap();
        std::fs::write(dir.join("blocked-bad.json"), "not json").unwrap();
        std::fs::write(dir.join("pane-P1.json"), "{}").unwrap();
        let n = take_blocked(&dir, &name);
        assert_eq!(n, vec![Note { title: "Claude · blocked: force push".into(), body: "shop · P1 · git push -f".into() }]);
        assert!(!f.exists() && !dir.join("blocked-bad.json").exists(), "both taken");
        assert!(dir.join("pane-P1.json").exists(), "only blocked files");
        assert!(take_blocked(&dir, &name).is_empty(), "posted once");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
