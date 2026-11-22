//! The board's diff chip, framed in the Dock on the app's own tmux: the app
//! makes the review here, through crew-board in-process, and the Dock then
//! brings the workspace forward and opens the review beside its terminal
//! (dock.ts; plan board-tmux-chips). From the intent server the review would
//! have no pane to show beside, which is why the server's chip did nothing
//! visible on tmux.

/// A lookout review of workspace `ws`'s worktree: its id, for the Dock to
/// open as /review/<id>. The folder is the workspace's own, from the
/// backend, never a pane's current directory (a pane may have cd'd away).
#[tauri::command]
pub async fn board_diff(ws: String) -> Result<String, String> {
    if !seamux_app::reclaim::ws_ok(&ws) {
        return Err(format!("not a workspace: {ws:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let rows = seamux_app::backend::get()?.workspaces()?;
        let cwd = rows
            .iter()
            .find(|w| w.id.eq_ignore_ascii_case(&ws))
            .map(|w| w.cwd.clone())
            .filter(|c| c.starts_with('/') && std::path::Path::new(c).is_dir())
            .ok_or_else(|| format!("no worktree folder for workspace {ws}"))?;
        crew_board::act::lookout_review(&cwd, &ws)
    })
    .await
    .map_err(|e| format!("the review did not finish: {e}"))?
}
