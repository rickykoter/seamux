//! The cmux backend: workspaces and panes are cmux's, and a native pane is a
//! cmux local-tmux session (crate::native) that cmux and the app both attach
//! to.

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

use super::{Backend, Kind, PaneRow, Target, WorkspaceRow};
use crate::native::{cmux_json, cmux_ok, tmux_bin};

pub struct CmuxBackend;

fn client() -> Result<::cmux::Cmux, String> {
    ::cmux::Cmux::connect().map_err(|e| format!("cmux: {e}"))
}

impl Backend for CmuxBackend {
    fn kind(&self) -> Kind {
        Kind::Cmux
    }

    fn workspaces(&self) -> Result<Vec<WorkspaceRow>, String> {
        let v = client()?.workspace_list(None).map_err(|e| format!("cmux: {e}"))?;
        Ok(workspace_rows(&v))
    }

    fn panes(&self, ws: Option<&str>) -> Result<Vec<PaneRow>, String> {
        let v = client()?.current_list(None).map_err(|e| format!("cmux: {e}"))?;
        Ok(pane_rows(&v).into_iter().filter(|p| ws.is_none_or(|w| p.workspace.eq_ignore_ascii_case(w))).collect())
    }

    fn open_workspace(&self, cwd: &Path, cmd: &str) -> Result<(String, Option<String>), String> {
        crate::native::open_native_workspace(cwd, cmd)
    }

    fn start_session(&self, ws: &str, cwd: &str, claude: &str) -> Result<String, String> {
        crate::native::start_native_with(ws, cwd, claude)
    }

    fn target(&self, pane: &str) -> Result<Option<Target>, String> {
        target_for(pane)
    }

    fn close_pane(&self, pane: &str) -> Result<(), String> {
        cmux_ok(&["close-surface", "--surface", pane, "--force"]).map(|_| ())
    }
}

/// workspace.list's rows, whichever transport answered: the socket wraps
/// them in `{"workspaces": [...]}`, the CLI may not.
pub fn workspace_rows(v: &Value) -> Vec<WorkspaceRow> {
    let rows = v.get("workspaces").unwrap_or(v);
    let s = |w: &Value, k: &str| w.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    rows.as_array()
        .map(|a| a.iter().map(|w| WorkspaceRow { id: s(w, "id"), title: s(w, "title"), cwd: s(w, "current_directory") }).collect())
        .unwrap_or_default()
}

/// current.list's running terminals, as panes.
pub fn pane_rows(current: &Value) -> Vec<PaneRow> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    current
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|i| s(i, "kind") == "terminal" && s(i, "lifecycle") == "running")
        .filter_map(|i| {
            let p = i.get("projections")?.as_array()?.first()?;
            let id = s(p, "panel_id");
            ::cmux::is_uuid(&id).then(|| PaneRow { id, workspace: s(p, "workspace_id"), cwd: s(i, "cwd"), label: s(i, "label") })
        })
        .collect()
}

/// The live sessions `cmux local-tmux list --json` names: (session name, socket).
pub fn live_sessions(list: &Value) -> Vec<(String, String)> {
    let top = list.get("socket_path").and_then(Value::as_str).unwrap_or("");
    list.get("sessions")
        .and_then(Value::as_array)
        .map(|ss| {
            ss.iter()
                .filter(|s| s.get("live").and_then(Value::as_bool).unwrap_or(false))
                .filter_map(|s| {
                    let name = s.get("session_name").and_then(Value::as_str)?.to_string();
                    let sock = s.get("socket_path").and_then(Value::as_str).filter(|p| !p.is_empty()).unwrap_or(top).to_string();
                    (!name.is_empty() && !sock.is_empty()).then_some((name, sock))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The cmux surface a session's client is, from `status <name> --json`.
pub fn client_surface(status: &Value) -> String {
    status.get("surface_id").and_then(Value::as_str).unwrap_or("").to_string()
}

/// A session name tmux takes as is: what `cmux local-tmux` itself allows.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
}

/// The session cmux's local-tmux registry (`sessions.json`) records for a
/// client surface: its name and socket. The registry is cmux's own file;
/// `target_for` falls back to the CLI when it cannot be read.
pub fn registry_target(registry: &Value, surface: &str) -> Option<Target> {
    registry.get("sessions")?.as_array()?.iter().find_map(|s| {
        let sid = s.get("surfaceID").and_then(Value::as_str)?;
        if !sid.eq_ignore_ascii_case(surface) {
            return None;
        }
        let session = s.get("name").and_then(Value::as_str)?.to_string();
        let socket = s.get("socketPath").and_then(Value::as_str)?.to_string();
        (name_ok(&session) && !socket.is_empty()).then_some(Target { socket, session })
    })
}

/// Whether tmux still has `t`: the registry can outlive a session.
pub fn live(t: &Target) -> bool {
    Command::new(tmux_bin())
        .args(["-S", &t.socket, "has-session", "-t", &format!("={}", t.session)])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The local-tmux session whose cmux client is `surface`, if it is one: from
/// the registry (a file read and one tmux call, ~20ms), else from the CLI
/// (`local-tmux list` and `status`, ~1.3s a call).
pub fn target_for(surface: &str) -> Result<Option<Target>, String> {
    let file = crate::py::home().join(".cmux/local-tmux/sessions.json");
    if let Some(reg) = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        return Ok(registry_target(&reg, surface).filter(live));
    }
    let list = cmux_json(&["local-tmux", "list", "--json"])?;
    for (name, socket) in live_sessions(&list) {
        if !name_ok(&name) {
            continue;
        }
        let Ok(st) = cmux_json(&["local-tmux", "status", &name, "--json"]) else { continue };
        if client_surface(&st).eq_ignore_ascii_case(surface) {
            return Ok(Some(Target { socket, session: name }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_rows_read_either_transport() {
        let row = json!({"id": "W1", "title": "t", "current_directory": "/x"});
        let want = vec![WorkspaceRow { id: "W1".into(), title: "t".into(), cwd: "/x".into() }];
        assert_eq!(workspace_rows(&json!({"workspaces": [row.clone()]})), want);
        assert_eq!(workspace_rows(&json!([row])), want);
        assert!(workspace_rows(&json!({})).is_empty());
    }

    #[test]
    fn pane_rows_are_running_terminals_with_a_uuid() {
        let id = "0B7C1F00-0000-4000-8000-000000000000";
        let v = json!({"items": [
            {"kind": "terminal", "lifecycle": "running", "cwd": "/a", "label": "zsh",
             "projections": [{"panel_id": id, "workspace_id": "W1"}]},
            {"kind": "terminal", "lifecycle": "exited", "projections": [{"panel_id": id, "workspace_id": "W1"}]},
            {"kind": "browser", "lifecycle": "running", "projections": [{"panel_id": id, "workspace_id": "W1"}]},
            {"kind": "terminal", "lifecycle": "running", "projections": [{"panel_id": "nope", "workspace_id": "W1"}]},
        ]});
        assert_eq!(pane_rows(&v), vec![PaneRow { id: id.into(), workspace: "W1".into(), cwd: "/a".into(), label: "zsh".into() }]);
    }
}
