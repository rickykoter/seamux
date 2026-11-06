//! Arming a worktree to resume at a limit's reset (resume.rs): the command
//! the board's and the views' ⋯ menus call, and the armed list the views'
//! menus label themselves from. Each change nudges the views feed.

use crate::resume::Store;

/// The worktree root and title of a live workspace, from the wall's last frame.
fn root_and_name(workspace: &str) -> Result<(String, String), String> {
    let frame = crate::wall_app::last_frame().ok_or("the app has not seen the panes yet")?;
    let in_ws = || frame.tiles.iter().filter(|t| t.workspace.eq_ignore_ascii_case(workspace));
    let t = in_ws().find(|t| t.agent.is_some()).or_else(|| in_ws().next()).ok_or("that workspace has no live pane")?;
    let root = seamux_app::tuck::root_of(&t.cwd);
    let name = if t.workspace_title.is_empty() { t.label.clone() } else { t.workspace_title.clone() };
    Ok((root, name))
}

/// Arm `workspace`'s worktree to resume when its limit resets (`on`), or
/// disarm it. Returns the worktree root.
#[tauri::command]
pub async fn resume_set(workspace: String, on: bool) -> Result<String, String> {
    let out = tauri::async_runtime::spawn_blocking(move || {
        let (root, name) = root_and_name(&workspace)?;
        Store::live().set(&root, on, &name, crew_core::history::now_ms())?;
        Ok::<String, String>(root)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::views_app::nudge();
    Ok(out)
}

/// The live workspaces whose worktree is armed, by id.
#[tauri::command]
pub async fn resume_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let armed: std::collections::HashSet<String> = Store::live().load().into_iter().map(|e| e.path).collect();
        if armed.is_empty() {
            return Vec::new();
        }
        let Some(frame) = crate::wall_app::last_frame() else { return Vec::new() };
        let mut out: Vec<String> = frame.tiles.iter()
            .filter(|t| !t.cwd.is_empty() && armed.contains(&seamux_app::tuck::root_of(&t.cwd)))
            .map(|t| t.workspace.clone())
            .collect();
        out.sort();
        out.dedup();
        out
    })
    .await
    .map_err(|e| e.to_string())
}
