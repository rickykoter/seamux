//! The Dock's pane feed on the tmux backend: the wall's poller, fed from the
//! app's own registry and crew's pane files instead of cmux.
//!
//! `TmuxSource` answers the wall's `Source` in cmux's shapes (current.list,
//! workspace.list), so the poller, its state overlay and the frame it emits
//! stay one code path. Tiles carry status only: no screen text is read, and
//! replies and jumps are refused (the Dock's terminal is the pane itself).

use std::path::{Path, PathBuf};

use crew_core::backend::{Backend, WorkspaceRow};
use serde_json::{json, Value};

use crate::wall::Source;

pub use crew_core::backend::current_list_of as current_of;
use crew_core::backend::pane_state as agent_state;

/// workspace.list's shape for the backend's workspaces.
pub fn workspaces_of(rows: &[WorkspaceRow]) -> Value {
    json!({ "workspaces": rows.iter().map(|w| json!({"id": w.id, "title": w.title, "current_directory": w.cwd})).collect::<Vec<_>>() })
}

/// The wall's source on the tmux backend.
pub struct TmuxSource {
    backend: &'static dyn Backend,
    state_dir: PathBuf,
}

impl TmuxSource {
    pub fn new(backend: &'static dyn Backend, state_dir: PathBuf) -> TmuxSource {
        TmuxSource { backend, state_dir }
    }
}

fn no_cmux(what: &str) -> cmux::Error {
    cmux::Error::Unavailable(format!("{what} needs cmux; this app runs on its own tmux"))
}

impl Source for TmuxSource {
    fn current(&self) -> Result<Value, cmux::Error> {
        let panes = self.backend.panes(None).map_err(cmux::Error::Unavailable)?;
        Ok(current_of(&panes, &|p| agent_state(&self.state_dir, p)))
    }
    fn workspaces(&self) -> Result<Value, cmux::Error> {
        self.backend.workspaces().map(|w| workspaces_of(&w)).map_err(cmux::Error::Unavailable)
    }
    /// Status only: the Dock's terminal shows the pane itself.
    fn read(&self, _surface: &str, _lines: u32) -> Result<String, cmux::Error> {
        Ok(String::new())
    }
    fn send_raw(&self, _surface: &str, _text: &str) -> Result<(), cmux::Error> {
        Err(no_cmux("a reply from the Dock"))
    }
    fn select_workspace(&self, _workspace: &str) -> Result<(), cmux::Error> {
        Err(no_cmux("jumping to a workspace"))
    }
    fn focus(&self, _surface: &str, _workspace: &str) -> Result<(), cmux::Error> {
        Err(no_cmux("jumping to a pane"))
    }
}

/// Claude Code's folder for a working directory's transcripts:
/// `~/.claude/projects/<cwd, every character but a letter or digit a dash>`.
pub fn project_dir(home: &Path, cwd: &str) -> PathBuf {
    let slug: String = cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    home.join(".claude/projects").join(slug)
}

/// The session picker's records for a workspace on the tmux backend: every
/// conversation Claude stored for its folder, in the shape of cmux's session
/// records, the ones a live pane runs marked active.
pub fn session_records(home: &Path, ws: &str, cwd: &str, live: &[String]) -> Vec<Value> {
    let dir = project_dir(home, cwd);
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let id = path.file_stem()?.to_str()?.to_string();
            if path.extension()?.to_str()? != "jsonl" || !cmux::is_uuid(&id) {
                return None;
            }
            let updated = e.metadata().ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64();
            Some(json!({
                "session_id": id,
                "workspace_id": ws,
                "agent": "claude",
                "cwd": cwd,
                "updated_at_unix": updated,
                "active_for_workspace": live.iter().any(|l| l.eq_ignore_ascii_case(&id)),
                "transcript_path": path.to_string_lossy(),
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_core::backend::PaneRow;

    #[test]
    fn the_registry_reads_as_cmux_shapes_the_wall_parses() {
        let id = "0B7C1F00-0000-4000-8000-000000000001";
        let panes = vec![PaneRow { id: id.into(), workspace: "W1".into(), cwd: "/w".into(), label: "Claude".into() }];
        let cur = current_of(&panes, &|p| if p == id { "needs_input".into() } else { "idle".into() });
        let t = crate::wall::terminals(&cur);
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].surface.as_str(), t[0].workspace.as_str(), t[0].state.as_str()), (id, "W1", "needs_input"));
        assert_eq!(t[0].agent.as_deref(), Some("claude"));
        let ws = workspaces_of(&[WorkspaceRow { id: "W1".into(), title: "shop".into(), cwd: "/w".into() }]);
        assert_eq!(crate::wall::titles(&ws).get("W1").map(String::as_str), Some("shop"));
    }

    /// A backend with one workspace and two panes, from memory.
    struct Fake;
    impl Backend for Fake {
        fn kind(&self) -> crew_core::backend::Kind {
            crew_core::backend::Kind::Tmux
        }
        fn workspaces(&self) -> Result<Vec<WorkspaceRow>, String> {
            Ok(vec![WorkspaceRow { id: "W1".into(), title: "shop".into(), cwd: "/w".into() }])
        }
        fn panes(&self, _ws: Option<&str>) -> Result<Vec<PaneRow>, String> {
            Ok(["0B7C1F00-0000-4000-8000-0000000000A1", "0B7C1F00-0000-4000-8000-0000000000A2"]
                .iter()
                .map(|id| PaneRow { id: id.to_string(), workspace: "W1".into(), cwd: "/w".into(), label: "Claude".into() })
                .collect())
        }
        fn open_workspace(&self, _: &Path, _: &str) -> Result<(String, Option<String>), String> {
            Err("not here".into())
        }
        fn start_session(&self, _: &str, _: &str, _: &str) -> Result<String, String> {
            Err("not here".into())
        }
        fn target(&self, _: &str) -> Result<Option<crew_core::backend::Target>, String> {
            Ok(None)
        }
        fn close_pane(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn the_wall_frames_tmux_panes_with_their_pane_file_state_and_no_lines() {
        let dir = std::env::temp_dir().join(format!("sx-feed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crew_core::status::update(&dir, "W1", "0B7C1F00-0000-4000-8000-0000000000A1", "s", 1, |p| p.state = "needs_input".into());
        let src: std::sync::Arc<dyn Source> = std::sync::Arc::new(TmuxSource::new(Box::leak(Box::new(Fake)), dir.clone()));
        let wall = crate::wall::Wall::with_actions(vec![src.clone()], src, std::time::Duration::from_secs(1));
        let f = wall.tick().expect("a first frame");
        assert_eq!(f.tiles.len(), 2);
        let by = |id: &str| f.tiles.iter().find(|t| t.surface == id).unwrap();
        assert_eq!(by("0B7C1F00-0000-4000-8000-0000000000A1").state, "needs_input");
        assert_eq!(by("0B7C1F00-0000-4000-8000-0000000000A2").state, "idle", "no pane file yet: idle");
        assert!(f.tiles.iter().all(|t| t.lines.is_empty() && t.workspace_title == "shop"), "status only, titled");
        assert!(wall.reply("0B7C1F00-0000-4000-8000-0000000000A1", "hi").is_err(), "no reply without cmux");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_dirs_follow_claude_codes_naming() {
        let home = Path::new("/Users/u");
        assert_eq!(project_dir(home, "/Users/u/code/my.repo"), Path::new("/Users/u/.claude/projects/-Users-u-code-my-repo"));
    }

    #[test]
    fn a_workspaces_sessions_are_its_folders_transcripts() {
        let home = std::env::temp_dir().join(format!("sx-sess-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = project_dir(&home, "/w/x");
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = ("0B7C1F00-0000-4000-8000-00000000000A", "0B7C1F00-0000-4000-8000-00000000000B");
        for id in [a, b] {
            std::fs::write(dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
        }
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        let recs = session_records(&home, "W1", "/w/x", &[b.to_string()]);
        assert_eq!(recs.len(), 2);
        let rows = crate::sessions::rows(&recs, "W1");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, b, "the live one first");
        assert!(rows[0].active && !rows[1].active);
        let _ = std::fs::remove_dir_all(&home);
    }
}
