//! Where the app's sessions live: cmux, or the app's own tmux.
//!
//! One backend per process, picked at launch (`pick`): SEAMUX_BACKEND when
//! it says cmux or tmux, else cmux when its socket answers, else tmux.
//! Starting or quitting cmux later changes nothing until the process
//! restarts. Every backend's sessions are tmux sessions, so the app draws
//! them the same way: `target` names the socket and session to attach to.

pub mod cmux;
pub mod tmux;

use std::path::Path;

/// Which backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Cmux,
    Tmux,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Cmux => "cmux",
            Kind::Tmux => "tmux",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        match s.trim().to_ascii_lowercase().as_str() {
            "cmux" => Some(Kind::Cmux),
            "tmux" => Some(Kind::Tmux),
            _ => None,
        }
    }
}

/// A tmux session, as tmux addresses it: what the app's terminal attaches to.
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub socket: String,
    pub session: String,
}

/// A workspace: a group of panes, usually one worktree.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceRow {
    pub id: String,
    pub title: String,
    pub cwd: String,
}

/// A terminal pane in a workspace.
#[derive(Clone, Debug, PartialEq)]
pub struct PaneRow {
    pub id: String,
    pub workspace: String,
    pub cwd: String,
    pub label: String,
}

/// cmux's current.list shape for a backend's panes: running terminals, each
/// with one Claude agent in the state `state(pane id)` says. What reads
/// current.list (the app's wall, the board) reads these the same way.
pub fn current_list_of(panes: &[PaneRow], state: &dyn Fn(&str) -> String) -> serde_json::Value {
    let items: Vec<serde_json::Value> = panes
        .iter()
        .map(|p| {
            serde_json::json!({
                "kind": "terminal",
                "lifecycle": "running",
                "label": p.label,
                "cwd": p.cwd,
                "projections": [{"panel_id": p.id, "workspace_id": p.workspace}],
                "agents": [{"kind": "claude", "state": state(&p.id)}],
            })
        })
        .collect();
    serde_json::json!({ "items": items })
}

/// What a pane's agent is doing, from its pane file in crew's `state_dir`:
/// the hooks' last word, `idle` until they have written one.
pub fn pane_state(state_dir: &Path, pane: &str) -> String {
    crate::status::read(state_dir, pane).map(|p| p.state).filter(|s| !s.is_empty()).unwrap_or_else(|| "idle".into())
}

/// What the app asks of wherever its sessions live.
pub trait Backend: Send + Sync {
    fn kind(&self) -> Kind;
    /// Every workspace.
    fn workspaces(&self) -> Result<Vec<WorkspaceRow>, String>;
    /// The terminal panes of `ws`, or of every workspace.
    fn panes(&self, ws: Option<&str>) -> Result<Vec<PaneRow>, String>;
    /// A new workspace at `cwd` running `cmd` (Claude and its first prompt),
    /// in worktree::create's opener shape: its ref, and its id when known.
    fn open_workspace(&self, cwd: &Path, cmd: &str) -> Result<(String, Option<String>), String>;
    /// A new pane in `ws` at `cwd` running `claude` (a shell command line):
    /// the new pane's id.
    fn start_session(&self, ws: &str, cwd: &str, claude: &str) -> Result<String, String>;
    /// The tmux session behind `pane`, when it has one.
    fn target(&self, pane: &str) -> Result<Option<Target>, String>;
    /// Close `pane` and what runs in it.
    fn close_pane(&self, pane: &str) -> Result<(), String>;
}

/// Which backend this process uses, from its environment: SEAMUX_BACKEND
/// when it names one, else cmux when `cmux_answers()`, else tmux.
pub fn pick_kind(get: &dyn Fn(&str) -> Option<String>, cmux_answers: &dyn Fn() -> bool) -> Kind {
    pick_kind_waiting(get, cmux_answers, &|| false, std::time::Duration::ZERO, &|_| {})
}

/// How long a launch waits for an installed cmux that does not answer yet:
/// an app started at login can be up before cmux is.
pub const CMUX_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// `pick_kind`, except that when SEAMUX_BACKEND is unset and cmux is
/// `installed()` but not answering, it asks again every half second for up
/// to `wait` before choosing tmux. `sleep` is the pause (tests pass a fake).
pub fn pick_kind_waiting(
    get: &dyn Fn(&str) -> Option<String>,
    cmux_answers: &dyn Fn() -> bool,
    installed: &dyn Fn() -> bool,
    wait: std::time::Duration,
    sleep: &dyn Fn(std::time::Duration),
) -> Kind {
    if let Some(k) = get("SEAMUX_BACKEND").as_deref().and_then(Kind::parse) {
        return k;
    }
    if cmux_answers() {
        return Kind::Cmux;
    }
    if installed() {
        let step = std::time::Duration::from_millis(500);
        let mut waited = std::time::Duration::ZERO;
        while waited < wait {
            sleep(step);
            waited += step;
            if cmux_answers() {
                return Kind::Cmux;
            }
        }
    }
    Kind::Tmux
}

/// The backend for `kind`.
pub fn open(kind: Kind) -> Result<Box<dyn Backend>, String> {
    match kind {
        Kind::Cmux => Ok(Box::new(cmux::CmuxBackend)),
        Kind::Tmux => Ok(Box::new(tmux::TmuxBackend::default())),
    }
}

/// This process's backend, picked from its environment (see `pick_kind`).
pub fn pick() -> (Kind, Result<Box<dyn Backend>, String>) {
    let kind = pick_kind_waiting(
        &|k| crate::py::env_or(k),
        &|| ::cmux::Cmux::connect().is_ok(),
        // Waiting is for a cmux that is coming up: not when the tmux backend
        // already has live panes, which means someone uses it.
        &|| ::cmux::resolve_cli_bin().is_ok() && !tmux::TmuxBackend::default().in_use(),
        CMUX_WAIT,
        &std::thread::sleep,
    );
    (kind, open(kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(v: Option<&str>) -> impl Fn(&str) -> Option<String> {
        let v = v.map(String::from);
        move |k| (k == "SEAMUX_BACKEND").then(|| v.clone()).flatten()
    }

    #[test]
    fn seamux_backend_wins_over_a_live_cmux() {
        assert_eq!(pick_kind(&env(Some("tmux")), &|| true), Kind::Tmux);
        assert_eq!(pick_kind(&env(Some("CMUX")), &|| false), Kind::Cmux);
    }

    #[test]
    fn without_it_cmux_when_its_socket_answers_else_tmux() {
        assert_eq!(pick_kind(&env(None), &|| true), Kind::Cmux);
        assert_eq!(pick_kind(&env(None), &|| false), Kind::Tmux);
    }

    #[test]
    fn an_unknown_value_is_ignored() {
        assert_eq!(pick_kind(&env(Some("screen")), &|| true), Kind::Cmux);
        assert_eq!(pick_kind(&env(Some("")), &|| false), Kind::Tmux);
    }

    #[test]
    fn an_installed_cmux_that_comes_up_late_is_waited_for() {
        use std::cell::Cell;
        let asked = Cell::new(0);
        let answers = || {
            asked.set(asked.get() + 1);
            asked.get() > 4
        };
        let slept = Cell::new(std::time::Duration::ZERO);
        let k = pick_kind_waiting(&env(None), &answers, &|| true, CMUX_WAIT, &|d| slept.set(slept.get() + d));
        assert_eq!(k, Kind::Cmux);
        assert_eq!(slept.get(), std::time::Duration::from_secs(2));
    }

    #[test]
    fn an_installed_cmux_that_never_answers_falls_back_to_tmux_after_the_wait() {
        use std::cell::Cell;
        let slept = Cell::new(std::time::Duration::ZERO);
        let k = pick_kind_waiting(&env(None), &|| false, &|| true, CMUX_WAIT, &|d| slept.set(slept.get() + d));
        assert_eq!(k, Kind::Tmux);
        assert_eq!(slept.get(), CMUX_WAIT);
    }

    #[test]
    fn no_cmux_installed_is_tmux_at_once_and_seamux_backend_never_waits() {
        let never = |_: std::time::Duration| panic!("no wait expected");
        assert_eq!(pick_kind_waiting(&env(None), &|| false, &|| false, CMUX_WAIT, &never), Kind::Tmux);
        assert_eq!(pick_kind_waiting(&env(Some("tmux")), &|| false, &|| true, CMUX_WAIT, &never), Kind::Tmux);
    }

    #[test]
    fn kinds_round_trip_their_names() {
        for k in [Kind::Cmux, Kind::Tmux] {
            assert_eq!(Kind::parse(k.name()), Some(k));
        }
    }
}
