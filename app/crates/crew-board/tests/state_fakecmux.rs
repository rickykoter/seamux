//! The board's state built end to end through crates/cmux with fakecmux in
//! front (CREW_CMUX), the way every probe drives it: workspace list and
//! sidebar-state go through the client, the rows rank, the sidebar cache and
//! the click table land in the state directory.
//!
//! One test function: the environment is process-wide, and the board's cmux
//! client is made once per process.

use std::path::PathBuf;

use serde_json::{json, Value};

fn fakecmux() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../crew/tools/fakecmux.py").canonicalize().unwrap()
}

#[test]
fn state_through_fakecmux() {
    let dir = std::env::temp_dir().join(format!("crew-board-fake-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let wt = dir.join("wt");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(
        dir.join("workspaces.json"),
        json!([
            {"id": "W-1", "ref": "workspace:1", "title": "busy", "current_directory": wt, "claude": "Running",
             "description": "phase:working"},
            {"id": "W-2", "ref": "workspace:2", "title": "  ", "current_directory": "/nowhere", "description": "gone:merged"},
            {"id": "W-3", "ref": "workspace:3", "title": "still", "current_directory": "/nowhere/else"},
        ])
        .to_string(),
    )
    .unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var("FAKE_CMUX_DIR", &dir);
    std::env::set_var("CREW_CMUX", fakecmux());
    std::env::set_var("CREW_COSTS_TTL", "0");
    std::env::set_var("PATH", "/usr/bin:/bin"); // no ccusage, no node: costs and plans come back empty

    let o = crew_board::state::Opts { screens: false, fast: false, selected: None, fixture: None };
    let d = crew_board::state::build(&o);
    let rows = d["rows"].as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["W-1", "W-2", "W-3"], "working, then merged, then quiet: {d}");
    assert_eq!(rows[0]["kind"], "running");
    assert_eq!(rows[0]["badge"], "working");
    assert_eq!(rows[1]["kind"], "done", "an untitled workspace is named after its ref");
    assert_eq!(rows[1]["name"], "workspace:2");
    assert_eq!(rows[2]["kind"], "quiet");
    assert_eq!(rows[2]["chips"], json!(["jump", "archive", "wake"]));
    assert_eq!(d["stale"], false);
    assert_eq!(d["src"], "0 plans");

    // Every cmux call went through fakecmux: the list, then sidebar-state per row.
    let log = std::fs::read_to_string(dir.join("cmux.log")).unwrap();
    let calls: Vec<&str> = log.lines().collect();
    assert_eq!(calls[0], "workspace list --json", "{log}");
    for r in ["workspace:1", "workspace:2", "workspace:3"] {
        assert!(calls.contains(&format!("sidebar-state --workspace {r}").as_str()), "{log}");
    }

    // The sidebar cache keeps each successful read, keyed by workspace id.
    let cache: Value = serde_json::from_str(
        &std::fs::read_to_string(home.join(".cache/cmux-crew/board-sidebar.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(cache["W-1"]["row"]["running"], true);

    // A fast pass reads the cache instead of asking sidebar-state again.
    std::fs::write(dir.join("cmux.log"), "").unwrap();
    let fast = crew_board::state::build(&crew_board::state::Opts { fast: true, ..o });
    assert_eq!(fast["rows"], d["rows"]);
    let log = std::fs::read_to_string(dir.join("cmux.log")).unwrap();
    // No sidebar-state: only the list, and the one current list the pane
    // marks read ([outside] needs each pane's cwd).
    assert_eq!(log.trim(), "workspace list --json\ncurrent --json", "{log}");

    // The click table, as crew-board-intent reads it.
    crew_board::state::write_targets(&d);
    let t: Value = serde_json::from_str(
        &std::fs::read_to_string(home.join(".cache/cmux-crew/board-targets.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(t["W-1"]["ref"], "workspace:1");
    assert_eq!(t["W-1"].as_object().unwrap().keys().collect::<Vec<_>>(),
               ["id", "ref", "cwd", "pr_url", "slug", "name", "issue_url", "panes"]);
    let _ = std::fs::remove_dir_all(&dir);
}
