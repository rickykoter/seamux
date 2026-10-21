//! The live agent wall: every terminal pane in cmux, its agent's state and
//! its last lines, refreshed once a second, with reply and jump.
//!
//! cmux has no screen-changed event and read_text has no follow mode, so the
//! wall polls: current.list for the panes and their agents, then every
//! terminal's text in parallel over a small pool of connections (a `Cmux`
//! serializes calls on its own connection). An event that names a known
//! surface pulls that surface's read forward. The page gets a `wall.frame`
//! only when something it shows changed.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// Lines of scrollback asked for; the page shows the last few of them.
pub const READ_LINES: u32 = 40;
/// Lines kept per tile.
pub const TILE_LINES: usize = 14;

/// What the wall needs from cmux. `cmux::Cmux` is the live one; tests pass a fake.
pub trait Source: Send + Sync {
    fn current(&self) -> Result<Value, cmux::Error>;
    fn workspaces(&self) -> Result<Value, cmux::Error>;
    fn read(&self, surface: &str, lines: u32) -> Result<String, cmux::Error>;
    /// Type `text` into `surface` exactly as given: no escapes applied.
    fn send_raw(&self, surface: &str, text: &str) -> Result<(), cmux::Error>;
    fn select_workspace(&self, workspace: &str) -> Result<(), cmux::Error>;
    fn focus(&self, surface: &str, workspace: &str) -> Result<(), cmux::Error>;
}

impl Source for cmux::Cmux {
    fn current(&self) -> Result<Value, cmux::Error> {
        self.current_list(None)
    }
    fn workspaces(&self) -> Result<Value, cmux::Error> {
        self.workspace_list(None)
    }
    fn read(&self, surface: &str, lines: u32) -> Result<String, cmux::Error> {
        self.read_text(surface, Some(lines))
    }
    fn send_raw(&self, surface: &str, text: &str) -> Result<(), cmux::Error> {
        // Not send_text: it turns a typed backslash-n into Enter, so a reply
        // could not carry one. The v2 method types the text as given.
        cmux::check_handle("surface", surface)?;
        self.rpc("surface.send_text", json!({"surface_id": surface, "text": text})).map(|_| ())
    }
    fn select_workspace(&self, workspace: &str) -> Result<(), cmux::Error> {
        self.workspace_select(workspace)
    }
    fn focus(&self, surface: &str, workspace: &str) -> Result<(), cmux::Error> {
        self.surface_focus(surface, Some(workspace))
    }
}

/// A terminal pane, as current.list describes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Terminal {
    pub surface: String,
    pub workspace: String,
    pub label: String,
    pub cwd: String,
    /// The agent's kind (`claude`, ...), when one runs in the pane.
    pub agent: Option<String>,
    /// The agent's state (`working`, `needs_input`, `idle`, `ended`), or
    /// `shell` for a terminal with no agent.
    pub state: String,
}

/// The running terminal panes in a current.list result. A pane's surface
/// UUID is its projection's panel_id: what read_text and send_text take.
pub fn terminals(current: &Value) -> Vec<Terminal> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let items = current.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    items
        .iter()
        .filter(|i| s(i, "kind") == "terminal" && s(i, "lifecycle") == "running")
        .filter_map(|i| {
            let p = i.get("projections")?.as_array()?.first()?;
            let surface = s(p, "panel_id");
            if !cmux::is_uuid(&surface) {
                return None;
            }
            let agent = i.get("agents").and_then(Value::as_array).and_then(|a| a.first());
            Some(Terminal {
                surface,
                workspace: s(p, "workspace_id"),
                label: s(i, "label"),
                cwd: s(i, "cwd"),
                agent: agent.map(|a| s(a, "kind")).filter(|k| !k.is_empty()),
                state: agent.map(|a| s(a, "state")).filter(|k| !k.is_empty()).unwrap_or_else(|| "shell".into()),
            })
        })
        .collect()
}

/// Workspace UUID to title, from workspace.list.
pub fn titles(workspaces: &Value) -> HashMap<String, String> {
    let rows = workspaces.get("workspaces").unwrap_or(workspaces);
    rows.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|w| {
                    let id = w.get("id")?.as_str()?.to_string();
                    let title = w.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                    Some((id, title))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The last `n` lines of a read, with trailing blank lines dropped.
pub fn tail(text: &str, n: usize) -> Vec<String> {
    let mut lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(n);
    lines[start..].iter().map(|l| l.to_string()).collect()
}

/// One pane on the wall.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Tile {
    pub surface: String,
    pub workspace: String,
    pub workspace_title: String,
    pub label: String,
    pub cwd: String,
    pub agent: Option<String>,
    pub state: String,
    pub lines: Vec<String>,
    /// Why the text could not be read this time.
    pub error: Option<String>,
}

/// The `wall.frame` payload: every tile, in current.list's order.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Frame {
    pub tiles: Vec<Tile>,
    /// Set when current.list itself failed; the tiles are the last ones seen.
    pub error: Option<String>,
}

#[derive(Default)]
struct State {
    terms: Vec<Terminal>,
    titles: HashMap<String, String>,
    text: HashMap<String, Result<Vec<String>, String>>,
    error: Option<String>,
    sent: Option<Frame>,
}

pub struct Wall {
    pool: Vec<Arc<dyn Source>>,
    pub interval: Duration,
    state: Mutex<State>,
}

impl Wall {
    /// `pool` holds one source per parallel reader; at least one.
    pub fn new(pool: Vec<Arc<dyn Source>>, interval: Duration) -> Wall {
        assert!(!pool.is_empty(), "the wall needs a source");
        Wall { pool, interval, state: Mutex::new(State::default()) }
    }

    /// The last frame sent, for a page that loads after it went out.
    pub fn last(&self) -> Option<Frame> {
        self.state.lock().unwrap().sent.clone()
    }

    /// Whether `surface` is a terminal on the wall now (for event pull-forward).
    pub fn knows(&self, surface: &str) -> bool {
        self.state.lock().unwrap().terms.iter().any(|t| t.surface == surface)
    }

    /// Re-list the panes and read every terminal, in parallel. Returns the
    /// frame when it differs from the last one returned.
    pub fn tick(&self) -> Option<Frame> {
        let listed = self.pool[0].current();
        let titles = self.pool[0].workspaces().map(|w| titles(&w)).ok();
        let terms = match &listed {
            Ok(v) => terminals(v),
            Err(_) => self.state.lock().unwrap().terms.clone(),
        };
        let reads = self.read_all(&terms);
        let mut st = self.state.lock().unwrap();
        st.error = listed.err().map(|e| e.to_string());
        if let Some(t) = titles {
            st.titles = t;
        }
        st.terms = terms;
        st.text = reads;
        self.frame_if_changed(&mut st)
    }

    /// Re-read one surface now (an event named it). Returns the frame when
    /// it changed.
    pub fn pull(&self, surface: &str) -> Option<Frame> {
        if !self.knows(surface) {
            return None;
        }
        let read = self.pool[0].read(surface, READ_LINES).map(|t| tail(&t, TILE_LINES)).map_err(|e| e.to_string());
        let mut st = self.state.lock().unwrap();
        st.text.insert(surface.to_string(), read);
        self.frame_if_changed(&mut st)
    }

    fn read_all(&self, terms: &[Terminal]) -> HashMap<String, Result<Vec<String>, String>> {
        let n = self.pool.len().min(terms.len()).max(1);
        let chunk = terms.len().div_ceil(n).max(1);
        std::thread::scope(|scope| {
            let handles: Vec<_> = terms
                .chunks(chunk)
                .zip(self.pool.iter())
                .map(|(part, src)| {
                    scope.spawn(move || {
                        part.iter()
                            .map(|t| {
                                let r = src.read(&t.surface, READ_LINES).map(|x| tail(&x, TILE_LINES)).map_err(|e| e.to_string());
                                (t.surface.clone(), r)
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        })
    }

    fn frame_if_changed(&self, st: &mut State) -> Option<Frame> {
        let tiles = st
            .terms
            .iter()
            .map(|t| {
                let (lines, error) = match st.text.get(&t.surface) {
                    Some(Ok(l)) => (l.clone(), None),
                    Some(Err(e)) => (Vec::new(), Some(e.clone())),
                    None => (Vec::new(), None),
                };
                Tile {
                    surface: t.surface.clone(),
                    workspace: t.workspace.clone(),
                    workspace_title: st.titles.get(&t.workspace).cloned().unwrap_or_default(),
                    label: t.label.clone(),
                    cwd: t.cwd.clone(),
                    agent: t.agent.clone(),
                    state: t.state.clone(),
                    lines,
                    error,
                }
            })
            .collect();
        let frame = Frame { tiles, error: st.error.clone() };
        if st.sent.as_ref() == Some(&frame) {
            return None;
        }
        st.sent = Some(frame.clone());
        Some(frame)
    }

    /// The live terminal `surface` names, checked against a fresh current.list:
    /// the page's copy may be a second old, and a closed pane's UUID must not
    /// reach send_text.
    fn live(&self, surface: &str) -> Result<Terminal, String> {
        if !cmux::is_uuid(surface) {
            return Err(format!("reply and jump take a surface UUID, not {surface:?}"));
        }
        let now = self.pool[0].current().map_err(|e| e.to_string())?;
        terminals(&now)
            .into_iter()
            .find(|t| t.surface == surface)
            .ok_or_else(|| format!("{surface} is not a live terminal"))
    }

    /// Type `text` into the agent's pane and press Enter. Line breaks in the
    /// text become spaces, so one reply is one submitted line.
    pub fn reply(&self, surface: &str, text: &str) -> Result<(), String> {
        let line: String = text.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
        if line.trim().is_empty() {
            return Err("empty reply".into());
        }
        let t = self.live(surface)?;
        self.pool[0].send_raw(&t.surface, &format!("{line}\r")).map_err(|e| e.to_string())
    }

    /// Bring the pane to the front in cmux: its workspace, then the pane.
    pub fn jump(&self, surface: &str) -> Result<(), String> {
        let t = self.live(surface)?;
        self.pool[0].select_workspace(&t.workspace).map_err(|e| e.to_string())?;
        self.pool[0].focus(&t.surface, &t.workspace).map_err(|e| e.to_string())
    }

    /// Poll every `interval`, and re-read a surface as soon as its id comes in
    /// on `pulls`. Each changed frame goes to `emit`. Returns when `pulls`
    /// closes.
    pub fn run(&self, pulls: Receiver<String>, emit: impl Fn(Frame)) {
        let mut next = Instant::now();
        loop {
            let wait = next.saturating_duration_since(Instant::now());
            match pulls.recv_timeout(wait) {
                Ok(first) => {
                    // Take what else is queued, so a burst of events is one read each.
                    let mut want: HashSet<String> = HashSet::from([first]);
                    want.extend(pulls.try_iter());
                    for s in want {
                        if let Some(f) = self.pull(&s) {
                            emit(f);
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(f) = self.tick() {
                        emit(f);
                    }
                    next = Instant::now() + self.interval;
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminals_skip_browsers_and_bad_ids() {
        let v = json!({"items": [
            {"kind": "browser", "lifecycle": "running", "projections": [{"panel_id": "B6C5E9B3-E485-4858-9D7A-1D634B52406B"}]},
            {"kind": "terminal", "lifecycle": "running", "label": "x", "cwd": "/w",
             "agents": [{"kind": "claude", "state": "needs_input"}],
             "projections": [{"panel_id": "088AC8B3-C1B1-4EB9-9A88-1DA89CDBFF76", "workspace_id": "68A92708-B9BD-4D9D-9043-A55FD88A17AA"}]},
            {"kind": "terminal", "lifecycle": "running", "agents": [], "projections": [{"panel_id": "surface:3"}]},
            {"kind": "terminal", "lifecycle": "running", "agents": [], "projections": [{"panel_id": "7C47DD0A-7A85-4389-A705-ACEF3DD0A71E"}]}
        ]});
        let t = terminals(&v);
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].agent.as_deref(), t[0].state.as_str()), (Some("claude"), "needs_input"));
        assert_eq!((t[1].agent.as_deref(), t[1].state.as_str()), (None, "shell"));
    }

    #[test]
    fn tail_drops_trailing_blanks() {
        assert_eq!(tail("a\nb\n\n  \n", 1), vec!["b"]);
        assert_eq!(tail("", 3), Vec::<String>::new());
    }
}
