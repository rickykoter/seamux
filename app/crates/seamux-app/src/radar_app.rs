//! The Radar tab's command: the wall's workspaces that aren't tucked away,
//! read through git and deep-plan (seamux_app::radar).

use std::collections::BTreeMap;

use seamux_app::radar::{self, Frame, Seat};
use seamux_app::tuck::{root_of, Level, Store};

/// Every repo's scope, built fresh: one git pass per worktree, in parallel.
#[tauri::command]
pub async fn radar_frame() -> Result<Frame, String> {
    tauri::async_runtime::spawn_blocking(build).await.map_err(|e| e.to_string())
}

fn build() -> Frame {
    let Some(frame) = crate::wall_app::last_frame() else { return Frame::default() };
    let tucked: Vec<String> = Store::live().load().into_iter().filter(|e| e.level == Level::Tuck).map(|e| e.path).collect();
    // One seat per workspace: its agent pane when it has one.
    let mut seats: Vec<Seat> = Vec::new();
    let mut tiles = frame.tiles.clone();
    tiles.sort_by_key(|t| t.agent.is_none());
    for t in &tiles {
        if seats.iter().any(|s| s.ws == t.workspace) {
            continue;
        }
        let root = root_of(if t.root.is_empty() { &t.cwd } else { &t.root });
        if root.is_empty() || tucked.contains(&root) {
            continue;
        }
        let title = if t.workspace_title.is_empty() { t.label.clone() } else { t.workspace_title.clone() };
        let state = if t.agent.is_some() { t.state.clone() } else { String::new() };
        seats.push(Seat { ws: t.workspace.clone(), pane: t.surface.clone(), title, root, color: t.color.clone(), state });
    }
    let mut roots: Vec<String> = seats.iter().map(|s| s.root.clone()).collect();
    roots.sort();
    roots.dedup();
    let trees: BTreeMap<String, radar::Tree> = std::thread::scope(|sc| {
        let hs: Vec<_> = roots.iter().map(|r| (r.clone(), sc.spawn(move || radar::read_tree(r)))).collect();
        hs.into_iter().map(|(r, h)| (r, h.join().unwrap_or_default())).collect()
    });
    let paths = crew_store::Paths::from_env();
    let state = std::path::PathBuf::from(&paths.dp_state);
    let keys = std::env::var_os("DEEP_PLAN_KEYS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| state.parent().map(|p| p.join("keys")).unwrap_or_default());
    let plans = radar::read_plans(&state, &keys, root_of);
    radar::assemble(&seats, &trees, &plans)
}
