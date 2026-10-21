//! The seamux app. cmux is the engine behind its socket; every call goes
//! through crates/cmux. Increment 1: connect at start and list the open
//! workspaces, or name why it can't, so a dead cmux never means a blank window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shell;
mod wall_app;

use serde::Serialize;
use serde_json::Value;

/// What the page shows on load: the connection, or why there is none.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Status {
    Connected {
        transport: String,
        access_mode: Option<String>,
        workspaces: Vec<Workspace>,
    },
    Failed {
        /// A short name the page can switch on.
        kind: String,
        /// cmux's own words, for the person reading.
        message: String,
    },
}

#[derive(Debug, Serialize, PartialEq)]
struct Workspace {
    id: String,
    r#ref: String,
    title: String,
}

fn failed(err: &cmux::Error) -> Status {
    let kind = match err {
        cmux::Error::Unavailable(_) | cmux::Error::Io(_) | cmux::Error::Closed => "unavailable",
        cmux::Error::Refused { code, .. } if code == "method_not_found" => "missing_method",
        cmux::Error::Refused { .. } => "refused",
        cmux::Error::Cli { .. } => "cli",
        cmux::Error::BadHandle(_) => "bad_handle",
        cmux::Error::Protocol(_) => "protocol",
    };
    Status::Failed { kind: kind.into(), message: err.to_string() }
}

/// The workspace rows from `workspace.list`, whichever transport answered:
/// the socket wraps them in `{"workspaces": [...]}`, the CLI may not.
fn workspaces_from(v: &Value) -> Vec<Workspace> {
    let rows = v.get("workspaces").unwrap_or(v);
    let field = |w: &Value, k: &str| w.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    rows.as_array()
        .map(|a| {
            a.iter()
                .map(|w| Workspace { id: field(w, "id"), r#ref: field(w, "ref"), title: field(w, "title") })
                .collect()
        })
        .unwrap_or_default()
}

fn status_of(conn: Result<cmux::Cmux, cmux::Error>) -> Status {
    let c = match conn {
        Ok(c) => c,
        Err(e) => return failed(&e),
    };
    match c.workspace_list(None) {
        Ok(v) => Status::Connected {
            transport: match c.transport() {
                cmux::Transport::Socket(_) => "socket".into(),
                cmux::Transport::Cli(_) => "cli".into(),
            },
            access_mode: c.access_mode(),
            workspaces: workspaces_from(&v),
        },
        Err(e) => failed(&e),
    }
}

/// Async so Tauri runs it off the main thread, and the socket I/O goes to a
/// blocking worker: a hung cmux must not freeze the window it would report on.
#[tauri::command]
async fn cmux_status() -> Status {
    tauri::async_runtime::spawn_blocking(|| status_of(cmux::Cmux::connect()))
        .await
        .unwrap_or_else(|e| Status::Failed { kind: "app".into(), message: e.to_string() })
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            shell::install(app)?;
            wall_app::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![cmux_status, shell::intent_server, shell::intent_page, shell::hide_overlay, wall_app::wall_frame, wall_app::wall_reply, wall_app::wall_jump])
        .run(tauri::generate_context!())
        .expect("seamux app failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_from_the_socket_shape() {
        let v = json!({"workspaces": [{"id": "A-1", "ref": "workspace:1", "title": "one", "extra": 1}]});
        assert_eq!(
            workspaces_from(&v),
            vec![Workspace { id: "A-1".into(), r#ref: "workspace:1".into(), title: "one".into() }]
        );
    }

    #[test]
    fn rows_from_a_bare_array() {
        let v = json!([{"id": "B", "ref": "workspace:2"}]);
        assert_eq!(workspaces_from(&v)[0].title, "");
        assert_eq!(workspaces_from(&json!({})), vec![]);
    }

    #[test]
    fn errors_are_named() {
        let down = failed(&cmux::Error::Unavailable("no socket at /tmp/x".into()));
        assert!(matches!(down, Status::Failed { ref kind, .. } if kind == "unavailable"));
        let missing = failed(&cmux::Error::Refused { code: "method_not_found".into(), message: "workspace.list".into() });
        assert!(matches!(missing, Status::Failed { ref kind, .. } if kind == "missing_method"));
    }

    #[test]
    fn status_through_fakecmux() {
        // The CLI transport, handed fakecmux directly: the whole
        // connect-and-list path with no cmux app and no process-wide env.
        let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crew/tools/fakecmux.py");
        let dir = std::env::temp_dir().join(format!("seamux-app-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = cmux::Cmux::open(cmux::Transport::Cli(fake))
            .map(|c| c.with_cli_env("FAKE_CMUX_DIR", dir.to_str().unwrap()));
        let s = status_of(conn);
        let _ = std::fs::remove_dir_all(&dir);
        match s {
            Status::Connected { transport, .. } => assert_eq!(transport, "cli"),
            Status::Failed { kind, message } => panic!("fakecmux status failed: {kind}: {message}"),
        }
    }
}
