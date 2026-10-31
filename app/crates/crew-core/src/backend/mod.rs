//! Where the app's sessions live: cmux, or the app's own tmux.
//!
//! One backend per process, picked at launch (`pick`): SEAMUX_BACKEND when
//! it says cmux or tmux, else cmux when its socket answers, else tmux.
//! Starting or quitting cmux later changes nothing until the process
//! restarts. Every backend's sessions are tmux sessions, so the app draws
//! them the same way: `target` names the socket and session to attach to.

pub mod cmux;

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
    if let Some(k) = get("SEAMUX_BACKEND").as_deref().and_then(Kind::parse) {
        return k;
    }
    if cmux_answers() {
        Kind::Cmux
    } else {
        Kind::Tmux
    }
}

/// The backend for `kind`.
pub fn open(kind: Kind) -> Result<Box<dyn Backend>, String> {
    match kind {
        Kind::Cmux => Ok(Box::new(cmux::CmuxBackend)),
        Kind::Tmux => Err("the tmux backend is not built yet".into()),
    }
}

/// This process's backend, picked from its environment (see `pick_kind`).
pub fn pick() -> (Kind, Result<Box<dyn Backend>, String>) {
    let kind = pick_kind(&|k| crate::py::env_or(k), &|| ::cmux::Cmux::connect().is_ok());
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
    fn kinds_round_trip_their_names() {
        for k in [Kind::Cmux, Kind::Tmux] {
            assert_eq!(Kind::parse(k.name()), Some(k));
        }
    }
}
