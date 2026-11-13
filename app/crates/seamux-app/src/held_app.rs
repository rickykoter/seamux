//! A command bash-guard held in a native pane (crew_core::held), for the
//! banner over Claude's prompt and the Dock card: what it is, and the
//! person's answer. Running it is the page's own act (it types `!cmd` into
//! Claude's prompt, or into the ⌘J shell); this side only reads the record,
//! clears it once acted on, and writes a session's force-push allow (ADR 0096).
//!
//! The command always comes from the file (ADR 0094): held_act names a record
//! by its pane and its time, never by its text.

use crew_core::{held, status};
use serde_json::Value;
use std::path::Path;

/// `surface` as given and in either case: the hooks and bash-guard key their
/// files by the pane id as tmux gave it.
fn keys(surface: &str) -> [String; 3] {
    [surface.to_string(), surface.to_uppercase(), surface.to_lowercase()]
}

/// The pane's live record in `dir`, under the key it was found by, and the
/// pane's file.
fn held_of(dir: &Path, surface: &str) -> Option<(String, held::Held, Option<status::Pane>)> {
    let pane = keys(surface).iter().find_map(|k| status::read(dir, k));
    keys(surface).into_iter().find_map(|k| held::for_pane(dir, &k, pane.as_ref()).map(|h| (k, h, pane.clone())))
}

/// The pane's held command, or None. `idle` says whether Claude's turn is
/// over: Run in chat waits for it, since typing while it works queues a
/// message instead of running the command.
pub fn view(dir: &Path, surface: &str) -> Option<Value> {
    let (_, h, pane) = held_of(dir, surface)?;
    let mut v = h.to_json();
    v["idle"] = Value::Bool(pane.is_some_and(|p| p.state != "working"));
    Some(v)
}

/// What the person did with the record seen at `at`: ran it ("ran"),
/// dismissed it, or ran it and allowed its branch for the session ("allow").
/// The record goes in each case. A record that is gone or newer than the one
/// seen is left alone and the call says so.
pub fn act(dir: &Path, surface: &str, at: u64, what: &str) -> Result<bool, String> {
    let (key, h, _) = held_of(dir, surface).ok_or("nothing is held in this pane now")?;
    if h.at != at {
        return Err("a newer command was held since: look again".into());
    }
    match what {
        "ran" | "dismiss" => {}
        "allow" => {
            let branch = h.allowable().ok_or("this command can't be allowed for the session")?;
            held::allow(dir, &h.session, branch, crew_core::history::now_ms())?;
        }
        _ => return Err(format!("unknown answer: {what}")),
    }
    Ok(held::clear(dir, &key, at))
}

#[tauri::command]
pub async fn pane_held(surface: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || view(&crew_core::home::xdg_cache(), &surface)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn held_act(surface: String, at: u64, act: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || self::act(&crew_core::home::xdg_cache(), &surface, at, &act))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A state folder of its own, never the live one (lesson L8).
    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("held-app-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn setup(d: &Path, state: &str, reason: &str, branch: Option<&str>) {
        let mut p = status::Pane::new("W1", "P1");
        p.session = "s1".into();
        p.state = state.into();
        status::write(d, &p);
        let rec = json!({"pane": "P1", "workspace": "W1", "session": "s1", "cwd": "/w", "reason": reason, "kind": "run",
                         "command": "git push --force-with-lease origin dev/x", "truncated": false, "branch": branch, "at": 7});
        std::fs::write(held::path(d, "P1"), rec.to_string()).unwrap();
    }

    #[test]
    fn the_banner_is_told_the_record_and_whether_claude_is_idle() {
        let d = dir("view");
        setup(&d, "idle", held::FORCE_PUSH, Some("dev/x"));
        let v = view(&d, "p1").unwrap();
        assert_eq!((v["idle"].as_bool(), v["allow"].as_str(), v["at"].as_u64()), (Some(true), Some("dev/x"), Some(7)));
        setup(&d, "working", held::FORCE_PUSH, Some("dev/x"));
        assert_eq!(view(&d, "P1").unwrap()["idle"].as_bool(), Some(false));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_answer_names_the_record_it_saw() {
        let d = dir("act");
        setup(&d, "idle", held::FORCE_PUSH, Some("dev/x"));
        assert!(act(&d, "P1", 6, "ran").is_err(), "an older record's answer is refused");
        assert!(act(&d, "P1", 7, "rm").is_err());
        assert!(held::path(&d, "P1").exists());
        assert_eq!(act(&d, "P1", 7, "allow"), Ok(true));
        assert_eq!(held::allowed(&d, "s1"), vec!["dev/x".to_string()]);
        assert!(!held::path(&d, "P1").exists(), "the record goes");
        assert!(act(&d, "P1", 7, "dismiss").is_err(), "nothing is held now");
        // A block beside the push: no allow, and the record stays.
        setup(&d, "idle", "git reset --hard; push", Some("dev/x"));
        assert!(act(&d, "P1", 7, "allow").is_err());
        assert!(held::path(&d, "P1").exists());
        assert_eq!(act(&d, "P1", 7, "dismiss"), Ok(true));
        let _ = std::fs::remove_dir_all(&d);
    }
}
