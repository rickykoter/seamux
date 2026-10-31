//! Live: the board on the tmux backend, with a real tmux. Ignored by default
//! (it starts a tmux server in a temporary folder); run on purpose:
//!   cargo test -p crew-board --test tmux_live -- --ignored --nocapture

use std::path::PathBuf;

use crew_core::backend::Backend;

#[test]
#[ignore]
fn the_board_lists_tmux_workspaces_and_a_waiting_pane() {
    // Before anything picks: this process is the tmux backend, in its own folders.
    let t = PathBuf::from(format!("/tmp/sx-board-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&t);
    std::fs::create_dir_all(t.join("work")).unwrap();
    std::env::set_var("SEAMUX_BACKEND", "tmux");
    // The board's state folder is always ~/.cache/cmux-crew: a home of its own.
    std::env::set_var("HOME", &t);
    std::env::remove_var("XDG_STATE_HOME");
    std::env::remove_var("XDG_CACHE_HOME");
    assert_eq!(crew_board::backend::kind(), crew_core::backend::Kind::Tmux);

    let b = crew_core::backend::tmux::TmuxBackend::default();
    let (ws, _) = b.open_workspace(&t.join("work"), "sleep 600").unwrap();
    let pane = b.panes(Some(&ws)).unwrap()[0].id.clone();
    let dir = crew_board::state::state_dir();
    assert!(dir.starts_with(&t), "{dir:?}");
    crew_core::status::update(&dir, &ws, &pane, "s-1", crew_core::history::now_ms(), |p| p.state = "needs_input".into());

    let d = crew_board::state::build(&crew_board::state::Opts { screens: false, fast: false, selected: None, fixture: None, fixture_panes: None });
    let rows = d["rows"].as_array().cloned().unwrap_or_default();
    println!("stale={} quiet={:?}", d["stale"], d["quiet"]);
    for r in &rows {
        println!("row {} {} panes={}", r["id"], r["name"], r["panes"]);
    }
    let _ = crew_core::backend::tmux::tmux(&b.socket(), &["kill-server"]);
    let _ = std::fs::remove_dir_all(&t);
    assert_eq!(d["stale"], false, "the registry's workspace is a row");
    let row = rows.iter().find(|r| r["id"] == ws.as_str()).expect("the workspace's row");
    assert_eq!(row["name"], "work");
    let p = &row["panes"][0];
    assert_eq!((p["surface"].as_str(), p["state"].as_str()), (Some(pane.as_str()), Some("needs_input")));
}
