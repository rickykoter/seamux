//! The mute and tuck commands. Each rewrites the store (tuck.rs) and nudges
//! the views feed, so every view hears the change in its next frame.

use seamux_app::tuck::{root_of, Level, Store};

fn now_ms() -> u64 {
    crew_core::history::now_ms()
}

/// The worktree root and title of a live workspace, from the wall's last frame.
fn root_and_name(workspace: &str) -> Result<(String, String), String> {
    let frame = crate::wall_app::last_frame().ok_or("the app has not seen cmux's panes yet")?;
    let in_ws = || frame.tiles.iter().filter(|t| t.workspace.eq_ignore_ascii_case(workspace));
    let t = in_ws().find(|t| t.agent.is_some()).or_else(|| in_ws().next()).ok_or("that workspace has no live pane")?;
    let root = root_of(&t.cwd);
    let name = if t.workspace_title.is_empty() { t.label.clone() } else { t.workspace_title.clone() };
    Ok((root, name))
}

/// Mute or tuck `workspace`'s worktree, or with "none" restore it.
#[tauri::command]
pub async fn tuck_set(workspace: String, level: String) -> Result<String, String> {
    let lvl = match level.as_str() {
        "none" => None,
        other => Some(Level::parse(other).ok_or(format!("not a level: {other:?}"))?),
    };
    let out = tauri::async_runtime::spawn_blocking(move || {
        let (root, name) = root_and_name(&workspace)?;
        Store::live().set(&root, lvl, &name, now_ms())?;
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
