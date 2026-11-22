//! The board's diff chip, framed in the Dock on the app's own tmux: the app
//! makes the review here, through crew-board in-process, and the Dock then
//! brings the workspace forward and opens the review beside its terminal
//! (dock.ts; plan board-tmux-chips). From the intent server the review would
//! have no pane to show beside, which is why the server's chip did nothing
//! visible on tmux.

/// A lookout review of `cwd`'s branch for workspace `ws`: its id, for the
/// Dock to open as /review/<id>.
#[tauri::command]
pub async fn board_diff(cwd: String, ws: String) -> Result<String, String> {
    if !cwd.starts_with('/') || !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("no worktree at {cwd:?}"));
    }
    if !ws.is_empty() && !ws.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!("not a workspace: {ws:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || crew_board::act::lookout_review(&cwd, &ws))
        .await
        .map_err(|e| format!("the review did not finish: {e}"))?
}
