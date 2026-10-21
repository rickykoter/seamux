//! crates/cmux on the CLI transport, driving the real crew/tools/fakecmux.py,
//! as every probe will under CREW_IMPL=rust. The argv each op sends must be
//! the line crew's Python leaves in fakecmux's cmux.log today.
//!
//! One test function: fakecmux reads FAKE_CMUX_DIR from the environment, and
//! the environment is process-wide.

use std::path::PathBuf;

use cmux::{Cmux, Transport, WorkspaceAction};
use serde_json::{json, Value};

fn fakecmux() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../crew/tools/fakecmux.py").canonicalize().unwrap()
}

#[test]
fn ops_through_fakecmux() {
    let dir = std::env::temp_dir().join(format!("cmux-fake-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("workspaces.json"),
        json!([{"id": "W-1", "ref": "workspace:1", "title": "one", "current_directory": "/x", "claude": "Running"}]).to_string(),
    )
    .unwrap();
    std::env::set_var("FAKE_CMUX_DIR", &dir);

    let c = Cmux::open(Transport::Cli(fakecmux())).unwrap();
    assert_eq!(c.access_mode(), None);

    let v = c.workspace_list(None).unwrap();
    assert_eq!(v["workspaces"][0]["ref"], "workspace:1");

    c.workspace_action("workspace:1", &WorkspaceAction::SetColor("#00BDBD".into())).unwrap();
    c.workspace_action("workspace:1", &WorkspaceAction::SetDescription("plan:gate synced:1".into())).unwrap();
    let rows: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("workspaces.json")).unwrap()).unwrap();
    assert_eq!(rows[0]["custom_color"], "#00BDBD", "fakecmux applied the action");
    assert_eq!(rows[0]["description"], "plan:gate synced:1");

    let side = c.sidebar_state("workspace:1").unwrap();
    assert!(side.starts_with("cwd=/x"), "{side}");
    assert!(side.contains("claude_code=Running"));

    assert_eq!(
        c.new_pane(&cmux::NewPane { kind: "terminal".into(), direction: Some("down".into()), workspace: Some("workspace:1".into()), url: None, focus: Some(true) })
            .unwrap(),
        "surface:900"
    );
    c.set_progress("workspace:1", 0.25, "inc 1/4").unwrap();
    c.todo_set("workspace:1", r#"[{"title":"a","state":"done"}]"#).unwrap();
    c.rpc("feed.list", json!({"limit": 5})).unwrap();
    c.workspace_select("W-1").unwrap();
    c.workspace_status_set("workspace:1", "auto").unwrap();
    c.clear_progress("workspace:1").unwrap();

    let log = std::fs::read_to_string(dir.join("cmux.log")).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(
        lines,
        vec![
            "workspace list --json",
            "workspace-action --action set-color --color #00BDBD --workspace workspace:1",
            "workspace-action --action set-description --description plan:gate synced:1 --workspace workspace:1",
            "sidebar-state --workspace workspace:1",
            "new-pane --type terminal --direction down --workspace workspace:1 --focus true",
            "set-progress 0.2500 --label inc 1/4 --workspace workspace:1",
            r#"todo set [{"title":"a","state":"done"}] --workspace workspace:1"#,
            r#"rpc feed.list {"limit": 5}"#,
            "workspace select W-1",
            "workspace status set auto --workspace workspace:1",
            "clear-progress --workspace workspace:1",
        ]
    );

    // On the CLI transport no handle check applies: the CLI resolves its own.
    std::fs::remove_file(dir.join("cmux.log")).unwrap();
    c.workspace_select("1").unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("cmux.log")).unwrap(), "workspace select 1\n");
}
