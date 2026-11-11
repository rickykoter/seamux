//! A native pane's background shells (crew_core::bgshells), for the strip
//! along its bottom: the list, each one's last output, and Stop.

use crew_core::bgshells::{self, Shell};
use serde_json::{json, Value};

/// How long a finished shell stays in the strip's list.
const KEEP_MS: u64 = 10 * 60_000;
/// How much of a shell's output the list shows.
const TAIL_BYTES: u64 = 3 * 1024;

/// The session a pane's Claude runs, from its pane file.
fn session_of(surface: &str) -> Option<String> {
    let dir = crew_core::home::xdg_cache();
    [surface.to_string(), surface.to_uppercase(), surface.to_lowercase()]
        .iter()
        .find_map(|k| crew_core::status::read(&dir, k))
        .map(|p| p.session)
        .filter(|s| !s.is_empty())
}

fn shells(surface: &str) -> Vec<Shell> {
    let Some(session) = session_of(surface) else { return Vec::new() };
    let now = crew_core::history::now_ms();
    bgshells::of_session(&crew_core::py::home(), &session)
        .into_iter()
        .filter(|s| s.status == "running" || s.ended.unwrap_or(s.at) + KEEP_MS >= now)
        .collect()
}

/// The pane's background shells, newest first; with `tails`, each one's
/// last output too.
#[tauri::command]
pub async fn bg_shells(surface: String, tails: bool) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = shells(&surface);
        list.reverse();
        list.iter()
            .map(|s| {
                let mut v = s.to_json();
                v["state"] = json!(bgshells::board_state(s));
                if tails {
                    v["tail"] = json!(s.output.as_deref().map(|o| bgshells::tail(std::path::Path::new(o), TAIL_BYTES)).unwrap_or_default());
                }
                v
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Stop a running background shell of the pane's: what writes its output
/// is sent SIGTERM. Claude Code hears it end, as if it stopped it itself.
#[tauri::command]
pub async fn bg_stop(surface: String, id: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = shells(&surface).into_iter().find(|s| s.id == id).ok_or("no such background shell")?;
        if s.status != "running" {
            return Err("it has already ended".into());
        }
        let out = s.output.ok_or("Claude did not say where its output goes")?;
        bgshells::stop(std::path::Path::new(&out))
    })
    .await
    .map_err(|e| e.to_string())?
}
