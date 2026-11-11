//! The mute, snooze and tuck commands. Each rewrites the store (tuck.rs) and nudges
//! the views feed, so every view hears the change in its next frame.

use seamux_app::tuck::{root_of, Level, Store};

fn now_ms() -> u64 {
    crew_core::history::now_ms()
}

/// The worktree root and title of a workspace: from the wall's last frame
/// when it has a pane, else from the board's row for it (a workspace with no
/// terminal open still has a row, and the row knows its cwd).
fn root_and_name(workspace: &str) -> Result<(String, String), String> {
    if let Some(frame) = crate::wall_app::last_frame() {
        let in_ws = || frame.tiles.iter().filter(|t| t.workspace.eq_ignore_ascii_case(workspace));
        if let Some(t) = in_ws().find(|t| t.agent.is_some()).or_else(|| in_ws().next()) {
            let name = if t.workspace_title.is_empty() { t.label.clone() } else { t.workspace_title.clone() };
            return Ok((root_of(&t.cwd), name));
        }
    }
    let text = std::fs::read_to_string(crew_board::state::targets_file()).unwrap_or_default();
    from_targets(&text, workspace).ok_or_else(|| "that workspace has no live pane and no board row".into())
}

/// `workspace`'s (root, name) from the board's targets file, by id (any case).
fn from_targets(text: &str, workspace: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let (_, row) = v.as_object()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(workspace))?;
    let cwd = row.get("cwd").and_then(|c| c.as_str()).filter(|c| !c.is_empty())?;
    let name = row.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty()).unwrap_or(cwd);
    Some((root_of(cwd), name.to_string()))
}

/// Mute, snooze or tuck `workspace`'s worktree, or with "none" restore it.
/// A snooze takes `until` (ms since the epoch), which must be in the future.
#[tauri::command]
pub async fn tuck_set(workspace: String, level: String, until: Option<u64>) -> Result<String, String> {
    let lvl = match level.as_str() {
        "none" => None,
        other => Some(Level::parse(other).ok_or(format!("not a level: {other:?}"))?),
    };
    let out = tauri::async_runtime::spawn_blocking(move || {
        let (root, name) = root_and_name(&workspace)?;
        Store::live().set_until(&root, lvl, &name, now_ms(), until)?;
        Ok::<String, String>(root)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::views_app::nudge();
    Ok(out)
}

/// Restore the worktree at `path` (a palette row, live or not).
#[tauri::command]
pub async fn tuck_restore(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || Store::live().set(&path, None, "", 0))
        .await
        .map_err(|e| e.to_string())??;
    crate::views_app::nudge();
    Ok(())
}

/// Unmute every muted worktree; tucked ones stay. Returns how many.
#[tauri::command]
pub async fn tuck_unmute_all() -> Result<usize, String> {
    let n = tauri::async_runtime::spawn_blocking(|| Store::live().unmute_all()).await.map_err(|e| e.to_string())??;
    crate::views_app::nudge();
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_with_no_pane_is_found_by_its_board_row() {
        let text = r#"{"F7C77CFC-3416-43EA-BD60-2CEB74953A19": {"id": "F7C77CFC-3416-43EA-BD60-2CEB74953A19", "cwd": "/nowhere/w", "name": "shop"},
                       "AB": {"id": "AB", "cwd": "", "name": "x"}}"#;
        let (root, name) = from_targets(text, "f7c77cfc-3416-43ea-bd60-2ceb74953a19").unwrap();
        assert_eq!((root.as_str(), name.as_str()), (root_of("/nowhere/w").as_str(), "shop"));
        assert_eq!(from_targets(text, "AB"), None, "a row with no cwd names no worktree");
        assert_eq!(from_targets(text, "CD"), None);
        assert_eq!(from_targets("not json", "AB"), None);
    }
}
