//! Moving sessions between backends at launch (docs/adr/0051), and restarting tmux
//! panes lost with their server.
//!
//! The app picks one backend. Sessions still running on the other one are
//! offered a move:
//!
//! - picked tmux, a native cmux session: adopted in place. Its tmux session
//!   keeps running on cmux's socket; the registry records it under cmux's
//!   own ids, which a native session already carries as its SEAMUX ids, so
//!   its hooks keep writing the same pane file.
//! - picked cmux, a tmux-backend session: resumed. `claude --resume` starts
//!   in a native cmux session in a workspace for its folder, then the tmux
//!   session closes. One that was adopted from cmux (it runs on cmux's own
//!   tmux server) is handed back instead: its record goes, and cmux, which
//!   never stopped running it, keeps it.
//!
//! On tmux, a pane lost with its tmux server (a reboot) is offered a restart:
//! `claude --resume` in a new session that keeps the pane's id.
//!
//! A session that is working or waiting on an answer is offered but marked
//! busy: the move waits until it is idle, and `apply` refuses it until then.

use std::path::Path;

use serde_json::{json, Value};

use super::tmux::TmuxBackend;
use super::{Backend, Target};
use crate::status::Pane;

/// What a move does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Move {
    /// A native cmux session, recorded in the tmux registry where it runs.
    Adopt,
    /// A tmux-backend session, resumed in cmux and then closed.
    Resume,
    /// A tmux pane lost with its server, started again with its id.
    Restart,
}

/// One session the app can move or restart.
#[derive(Clone, Debug, PartialEq)]
pub struct Offer {
    pub kind: Move,
    /// The pane: cmux's surface id (adopt) or the registry's pane id.
    pub pane: String,
    pub ws: String,
    pub title: String,
    pub cwd: String,
    /// The Claude session id from the pane's file, "" when there is none.
    pub claude: String,
    /// The pane file's state: working, needs_input, idle, ended, or "".
    pub state: String,
    /// Working or waiting on an answer: the move waits.
    pub busy: bool,
    /// The tmux session an adopt records (cmux's socket and name).
    pub target: Option<Target>,
}

impl Move {
    pub fn name(self) -> &'static str {
        match self {
            Move::Adopt => "adopt",
            Move::Resume => "resume",
            Move::Restart => "restart",
        }
    }
}

impl Offer {
    /// What the app's page gets: everything but the tmux target.
    pub fn to_json(&self) -> Value {
        json!({"kind": self.kind.name(), "pane": self.pane, "ws": self.ws, "title": self.title, "cwd": self.cwd,
               "claude": self.claude, "state": self.state, "busy": self.busy})
    }
}

fn busy(state: &str) -> bool {
    matches!(state, "working" | "needs_input")
}

fn str_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// Native cmux sessions to adopt, from cmux's local-tmux `sessions.json`:
/// each live one with a Claude (a pane file) that the registry lacks.
pub fn adopt_offers(
    sessions: &Value,
    pane: &dyn Fn(&str) -> Option<Pane>,
    live: &dyn Fn(&Target) -> bool,
    known: &dyn Fn(&str) -> bool,
) -> Vec<Offer> {
    let Some(all) = sessions.get("sessions").and_then(Value::as_array) else { return Vec::new() };
    all.iter()
        .filter_map(|s| {
            let surface = str_of(s, "surfaceID");
            let ws = str_of(s, "workspaceID");
            let t = super::cmux::registry_target(sessions, &surface)?;
            if !::cmux::is_uuid(&surface) || !::cmux::is_uuid(&ws) || known(&surface) || !live(&t) {
                return None;
            }
            let p = pane(&surface)?;
            Some(Offer {
                kind: Move::Adopt,
                pane: surface,
                ws,
                title: str_of(s, "workspaceTitle"),
                cwd: str_of(s, "cwd"),
                claude: p.session.clone(),
                busy: busy(&p.state),
                state: p.state,
                target: Some(t),
            })
        })
        .collect()
}

/// tmux-backend panes to resume in cmux: each live one with a Claude session.
pub fn resume_offers(b: &dyn Backend, titles: &dyn Fn(&str) -> String, pane: &dyn Fn(&str) -> Option<Pane>) -> Vec<Offer> {
    b.panes(None)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            let p = pane(&r.id)?;
            let target = b.target(&r.id).ok().flatten();
            (!p.session.is_empty()).then(|| Offer {
                kind: Move::Resume,
                target,
                title: titles(&r.workspace),
                pane: r.id,
                ws: r.workspace,
                cwd: r.cwd,
                claude: p.session.clone(),
                busy: busy(&p.state),
                state: p.state,
            })
        })
        .collect()
}

/// Gone tmux panes to restart: each with a Claude session id to resume.
/// A gone pane runs nothing, so none is busy.
pub fn restart_offers(gone: &[(String, String, String)], titles: &dyn Fn(&str) -> String, pane: &dyn Fn(&str) -> Option<Pane>) -> Vec<Offer> {
    gone.iter()
        .filter_map(|(id, ws, cwd)| {
            let p = pane(id)?;
            (!p.session.is_empty()).then(|| Offer {
                kind: Move::Restart,
                pane: id.clone(),
                ws: ws.clone(),
                title: titles(ws),
                cwd: cwd.clone(),
                claude: p.session.clone(),
                state: String::new(),
                busy: false,
                target: None,
            })
        })
        .collect()
}

/// The `claude --resume` line for an offer, refusing an id that is not one.
pub fn resume_line(o: &Offer) -> Result<String, String> {
    crate::native::claude_line(Some(&o.claude))
}

/// Carry out one offer. `t` is the app's tmux backend. A busy session is
/// refused (the caller asks again once it is idle).
pub fn apply(t: &TmuxBackend, o: &Offer) -> Result<String, String> {
    if o.busy {
        return Err(format!("{} is busy ({}): it moves once it is idle", o.title, o.state));
    }
    match o.kind {
        Move::Adopt => {
            let target = o.target.as_ref().ok_or("no tmux session to adopt")?;
            t.adopt(&o.ws, &o.title, &o.cwd, &o.pane, &target.socket, &target.session)?;
            Ok(format!("adopted {} where it runs", o.title))
        }
        Move::Resume if o.target.as_ref().is_some_and(|x| x.socket != t.socket()) => {
            // Adopted from cmux: it runs on cmux's server, which keeps it.
            t.release(&o.pane)?;
            Ok(format!("handed {} back to cmux", o.title))
        }
        Move::Resume => {
            let line = resume_line(o)?;
            if !Path::new(&o.cwd).is_dir() {
                return Err(format!("its folder is gone: {}", o.cwd));
            }
            let (_, ws) = crate::worktree::create_workspace(Path::new(&o.cwd))?;
            let ws = ws.ok_or("cmux opened the workspace but did not say its id")?;
            crate::native::start_native_with(&ws, &o.cwd, &line)?;
            // Only once cmux runs it: the tmux session closes.
            t.close_pane(&o.pane)?;
            Ok(format!("resumed {} in cmux", o.title))
        }
        Move::Restart => {
            t.restart(&o.pane, &resume_line(o)?)?;
            Ok(format!("restarted {}", o.title))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{PaneRow, WorkspaceRow};

    const S1: &str = "F78F1E8A-F94E-4422-8F8B-B15387C90726";
    const S2: &str = "0AEE75E6-5F6B-4515-B674-AF22A01CE166";
    const W1: &str = "C2D4A7B2-568F-4F00-9E7D-2370D7200176";
    const C1: &str = "68223d51-cb14-450c-b001-044899829c24";

    fn pane(state: &str) -> Pane {
        Pane::from_json(&json!({"ws": W1, "surface": S1, "session": C1, "state": state})).unwrap()
    }

    fn sessions() -> Value {
        json!({"version": 1, "sessions": [
            {"name": "claude-a", "socketPath": "/c/server.sock", "surfaceID": S1, "workspaceID": W1, "workspaceTitle": "shop", "cwd": "/w"},
            {"name": "claude-b", "socketPath": "/c/server.sock", "surfaceID": S2, "workspaceID": W1, "workspaceTitle": "shop", "cwd": "/w"},
        ]})
    }

    #[test]
    fn adopt_keeps_the_panes_ids_and_skips_known_dead_and_claudeless_ones() {
        let only_s1 = |s: &str| (s == S1).then(|| pane("idle"));
        let o = adopt_offers(&sessions(), &only_s1, &|_| true, &|_| false);
        assert_eq!(o.len(), 1, "S2 has no pane file: no Claude");
        assert_eq!((o[0].kind, o[0].pane.as_str(), o[0].ws.as_str(), o[0].claude.as_str()), (Move::Adopt, S1, W1, C1));
        assert_eq!(o[0].target, Some(Target { socket: "/c/server.sock".into(), session: "claude-a".into() }));
        assert!(!o[0].busy);
        assert!(adopt_offers(&sessions(), &only_s1, &|_| true, &|s| s == S1).is_empty(), "already in the registry");
        assert!(adopt_offers(&sessions(), &only_s1, &|_| false, &|_| false).is_empty(), "its tmux session is gone");
    }

    #[test]
    fn a_working_session_is_offered_busy_and_apply_leaves_it_alone() {
        let o = adopt_offers(&sessions(), &|s| (s == S1).then(|| pane("working")), &|_| true, &|_| false);
        assert!(o[0].busy);
        let dir = std::path::PathBuf::from(format!("/tmp/sx-mig-busy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let t = TmuxBackend::at(dir.clone());
        assert!(apply(&t, &o[0]).unwrap_err().contains("busy"));
        assert!(!dir.join("workspaces.json").exists(), "nothing written");
        let waiting = adopt_offers(&sessions(), &|s| (s == S1).then(|| pane("needs_input")), &|_| true, &|_| false);
        assert!(waiting[0].busy, "waiting on an answer counts as busy");
    }

    #[test]
    fn adopt_records_the_session_where_it_runs() {
        let dir = std::path::PathBuf::from(format!("/tmp/sx-mig-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t = TmuxBackend::at(dir.clone());
        let o = adopt_offers(&sessions(), &|s| (s == S1).then(|| pane("idle")), &|_| true, &|_| false);
        apply(&t, &o[0]).unwrap();
        let reg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("workspaces.json")).unwrap()).unwrap();
        assert_eq!(reg["workspaces"][0]["id"], W1);
        let p = &reg["panes"][0];
        assert_eq!((p["id"].as_str(), p["ws"].as_str(), p["session"].as_str(), p["socket"].as_str()),
                   (Some(S1), Some(W1), Some("claude-a"), Some("/c/server.sock")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    struct Fake;
    impl Backend for Fake {
        fn kind(&self) -> crate::backend::Kind {
            crate::backend::Kind::Tmux
        }
        fn workspaces(&self) -> Result<Vec<WorkspaceRow>, String> {
            Ok(vec![])
        }
        fn panes(&self, _: Option<&str>) -> Result<Vec<PaneRow>, String> {
            Ok(vec![
                PaneRow { id: S1.into(), workspace: W1.into(), cwd: "/w".into(), label: "Claude".into() },
                PaneRow { id: S2.into(), workspace: W1.into(), cwd: "/w".into(), label: "Claude".into() },
            ])
        }
        fn open_workspace(&self, _: &Path, _: &str) -> Result<(String, Option<String>), String> {
            Err("no".into())
        }
        fn start_session(&self, _: &str, _: &str, _: &str) -> Result<String, String> {
            Err("no".into())
        }
        fn target(&self, _: &str) -> Result<Option<Target>, String> {
            Ok(None)
        }
        fn close_pane(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn resume_builds_claude_resume_for_each_live_pane_with_a_session() {
        let o = resume_offers(&Fake, &|_| "shop".into(), &|s| (s == S1).then(|| pane("idle")));
        assert_eq!(o.len(), 1);
        assert_eq!((o[0].kind, o[0].title.as_str()), (Move::Resume, "shop"));
        assert_eq!(resume_line(&o[0]).unwrap(), format!("claude --resume {C1}"));
        let mut bad = o[0].clone();
        bad.claude = "x; rm -rf /".into();
        assert!(resume_line(&bad).is_err(), "only a session id reaches the command line");
    }

    #[test]
    fn an_adopted_session_is_handed_back_to_cmux_not_resumed_twice() {
        let dir = std::path::PathBuf::from(format!("/tmp/sx-mig-back-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t = TmuxBackend::at(dir.clone());
        t.adopt(W1, "shop", "/w", S1, "/c/server.sock", "claude-a").unwrap();
        let o = Offer { kind: Move::Resume, pane: S1.into(), ws: W1.into(), title: "shop".into(), cwd: "/w".into(),
                        claude: C1.into(), state: "idle".into(), busy: false,
                        target: Some(Target { socket: "/c/server.sock".into(), session: "claude-a".into() }) };
        assert_eq!(apply(&t, &o).unwrap(), "handed shop back to cmux");
        let reg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("workspaces.json")).unwrap()).unwrap();
        assert_eq!(reg["panes"], json!([]), "the record went; the session was not touched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dead_registry_pane_is_offered_a_resume_from_its_pane_file() {
        let gone = vec![(S1.to_string(), W1.to_string(), "/w".to_string()), (S2.to_string(), W1.to_string(), "/w".to_string())];
        let o = restart_offers(&gone, &|_| "shop".into(), &|s| (s == S1).then(|| pane("idle")));
        assert_eq!(o.len(), 1, "S2 has no session id to resume");
        assert_eq!((o[0].kind, o[0].pane.as_str(), o[0].busy), (Move::Restart, S1, false));
        assert_eq!(resume_line(&o[0]).unwrap(), format!("claude --resume {C1}"));
    }
}
