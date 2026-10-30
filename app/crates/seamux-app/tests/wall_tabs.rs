//! A native Claude's cmux tab takes "worktree · topic" once Claude gives the
//! conversation a topic, and is asked to only once per name.

use std::collections::HashMap;

use seamux_app::wall::{pane_name, tab_renames, Tile};

fn tile(surface: &str, cwd: &str, root: &str, label: &str, topic: Option<&str>) -> Tile {
    Tile {
        surface: surface.into(),
        workspace: "WS".into(),
        workspace_title: "t".into(),
        label: label.into(),
        cwd: cwd.into(),
        agent: Some("claude".into()),
        state: "working".into(),
        lines: Vec::new(),
        error: None,
        color: None,
        since: 0,
        running: None,
        bell: false,
        topic: topic.map(str::to_string),
        root: root.into(),
        owner: None,
        outside: false,
    }
}

#[test]
fn the_name_is_the_worktree_then_the_topic() {
    let t = tile("S", "/w/board-buttons/app", "/w/board-buttons", "board-buttons · main", Some("Fix Dock button sizes"));
    assert_eq!(pane_name(&t).as_deref(), Some("board-buttons · Fix Dock button sizes"));
    let no_root = tile("S", "/w/seamux", "", "x", Some("Shift+Enter"));
    assert_eq!(pane_name(&no_root).as_deref(), Some("seamux · Shift+Enter"));
    assert_eq!(pane_name(&tile("S", "/w/a", "", "x", None)), None, "no topic yet: crew's own name stays");
}

#[test]
fn each_name_is_asked_once() {
    let mut applied = HashMap::new();
    let t = tile("S", "/w/a", "", "a · main", Some("Topic"));
    assert_eq!(tab_renames(&[t.clone()], &mut applied), vec![("S".into(), "WS".into(), "a · Topic".into())]);
    assert!(tab_renames(&[t.clone()], &mut applied).is_empty(), "asked already");
    let shown = tile("S", "/w/a", "", "a · New", Some("New"));
    assert!(tab_renames(&[shown], &mut applied).is_empty(), "cmux shows it already");
    let moved = tile("S", "/w/a", "", "a · Topic", Some("Other"));
    assert_eq!(tab_renames(&[moved], &mut applied).len(), 1, "a new topic renames again");
    let mut ended = tile("E", "/w/a", "", "x", Some("T"));
    ended.state = "ended".into();
    assert!(tab_renames(&[ended], &mut applied).is_empty());
}
