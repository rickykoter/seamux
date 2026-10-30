//! A native Claude's cmux tab takes "worktree · topic" once Claude gives the
//! conversation a topic, and is asked to only once per name.

use std::collections::HashMap;

use seamux_app::wall::{pane_name, tab_renames, Tile, RENAME_RETRY_MS};

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
fn each_name_is_asked_once_until_the_tab_changes() {
    let mut applied = HashMap::new();
    let t = tile("S", "/w/a", "", "a · main", Some("Topic"));
    assert_eq!(tab_renames(std::slice::from_ref(&t), &mut applied, 0), vec![("S".into(), "WS".into(), "a · Topic".into())]);
    assert!(tab_renames(std::slice::from_ref(&t), &mut applied, 1_000).is_empty(), "asked already");
    let shown = tile("S", "/w/a", "", "a · Topic", Some("Topic"));
    assert!(tab_renames(&[shown], &mut applied, 2_000).is_empty(), "cmux shows it");
    // crew's SessionStart hook (a compaction) names the tab again: ask again.
    let renamed = tile("S", "/w/a", "", "a · main again", Some("Topic"));
    assert_eq!(tab_renames(std::slice::from_ref(&renamed), &mut applied, 3_000).len(), 1);
    assert!(tab_renames(std::slice::from_ref(&renamed), &mut applied, 4_000).is_empty());
    // A rename that never showed up is asked again after the retry time.
    assert_eq!(tab_renames(&[renamed], &mut applied, 3_000 + RENAME_RETRY_MS).len(), 1);
    let moved = tile("S", "/w/a", "", "a · main again", Some("Other"));
    assert_eq!(tab_renames(&[moved], &mut applied, 70_000).len(), 1, "a new topic renames again");
}

#[test]
fn ended_and_gone_panes_are_skipped_and_forgotten() {
    let mut applied = HashMap::new();
    assert_eq!(tab_renames(&[tile("S", "/w/a", "", "x", Some("T"))], &mut applied, 0).len(), 1);
    let mut ended = tile("S", "/w/a", "", "x", Some("T"));
    ended.state = "ended".into();
    assert!(tab_renames(&[ended], &mut applied, 1).is_empty());
    assert!(applied.is_empty(), "an ended pane is forgotten");
    tab_renames(&[tile("S", "/w/a", "", "x", Some("T"))], &mut applied, 2);
    tab_renames(&[], &mut applied, 3);
    assert!(applied.is_empty(), "a pane gone from the wall is forgotten");
}
