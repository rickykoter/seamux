//! The live agent wall: every terminal pane in cmux, its agent's state and
//! its last lines, refreshed once a second, with reply and jump.
//!
//! cmux has no screen-changed event and read_text has no follow mode, so the
//! wall polls: current.list for the panes and their agents, then every
//! terminal's text in parallel over a small pool of connections (a `Cmux`
//! serializes calls on its own connection). An event that names a known
//! surface pulls that surface's read forward. The page gets a `wall:frame` event
//! only when something it shows changed.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

/// Lines of scrollback asked for: enough that, with Claude's prompt box and
/// footer cut, the preview still has a screenful of the agent's own words.
pub const READ_LINES: u32 = 160;
/// Lines kept per tile: enough to fill a tall window's preview.
pub const TILE_LINES: usize = 120;
/// A reply longer than this is refused rather than typed into an agent.
pub const REPLY_MAX: usize = 4000;
/// One surface is re-read on an event at most this often.
pub const PULL_GAP: Duration = Duration::from_millis(250);

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

/// Workspace UUID to its cmux colour (custom_color), from workspace.list;
/// only workspaces that have one.
pub fn colors(workspaces: &Value) -> HashMap<String, String> {
    let rows = workspaces.get("workspaces").unwrap_or(workspaces);
    rows.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|w| {
                    let id = w.get("id")?.as_str()?.to_string();
                    let c = w.get("custom_color")?.as_str()?.trim().to_string();
                    (!c.is_empty()).then_some((id, c))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A full-width rule Claude Code draws around its prompt box.
fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.chars().count() >= 20 && t.chars().all(|c| c == '─')
}

/// Notices Claude Code prints over its prompt box, not the agent's words.
fn is_notice(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("Update available!") || t.starts_with("new task? /clear")
}

/// An agent pane's last `n` lines of its own words. Claude Code ends the
/// screen with its prompt box (a rule, the `❯` input line, a rule) and the
/// status lines under it; all of that is cut, so is a notice above the box,
/// and runs of blank lines fold to one. A box that does not start with `❯`
/// is a question being asked (its options), and stays: that is what the
/// person needs to see. A plain shell keeps its tail as is.
pub fn clean(text: &str, agent: bool, n: usize) -> Vec<String> {
    if !agent {
        return tail(text, n);
    }
    let mut lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let rules: Vec<usize> = lines.iter().enumerate().filter(|(_, l)| is_rule(l)).map(|(i, _)| i).collect();
    if rules.len() >= 2 {
        let (top, bottom) = (rules[rules.len() - 2], rules[rules.len() - 1]);
        let first = lines.get(top + 1).map(|l| l.trim_start()).unwrap_or("");
        if bottom > top + 1 && first.starts_with('❯') {
            lines.truncate(top);
        }
    }
    let mut out: Vec<&str> = Vec::new();
    for l in lines {
        if is_notice(l) {
            continue;
        }
        if l.trim().is_empty() && out.last().is_none_or(|p| p.trim().is_empty()) {
            continue;
        }
        out.push(l);
    }
    tail(&out.join("\n"), n)
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
    /// The workspace's cmux colour (`#RRGGBB`), when it has one.
    pub color: Option<String>,
    /// When this pane entered its current state, as the wall first saw it
    /// (ms since the epoch): how long a needs-you agent has waited.
    pub since: u64,
}

/// The `wall:frame` payload: every tile, in current.list's order.
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
    colors: HashMap<String, String>,
    /// Per surface: the state last seen, and when it was first seen.
    since: HashMap<String, (String, u64)>,
    text: HashMap<String, Result<Vec<String>, String>>,
    error: Option<String>,
    sent: Option<Frame>,
}

pub struct Wall {
    pool: Vec<Arc<dyn Source>>,
    /// Reply and jump use their own connection, so a click never queues
    /// behind a tick's reads (a Cmux serializes calls on its connection).
    actions: Arc<dyn Source>,
    pub interval: Duration,
    state: Mutex<State>,
    pulled: Mutex<HashMap<String, Instant>>,
}

impl Wall {
    /// `pool` holds one source per parallel reader; at least one.
    pub fn new(pool: Vec<Arc<dyn Source>>, interval: Duration) -> Wall {
        assert!(!pool.is_empty(), "the wall needs a source");
        let actions = pool[0].clone();
        Wall::with_actions(pool, actions, interval)
    }

    /// As `new`, with a separate source for reply and jump.
    pub fn with_actions(pool: Vec<Arc<dyn Source>>, actions: Arc<dyn Source>, interval: Duration) -> Wall {
        assert!(!pool.is_empty(), "the wall needs a source");
        Wall { pool, actions, interval, state: Mutex::new(State::default()), pulled: Mutex::default() }
    }

    /// Forget the last frame sent, so the next poll sends it again (the page
    /// missed it: emit failed).
    pub fn resend(&self) {
        self.state.lock().unwrap().sent = None;
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
        let listing = self.pool[0].workspaces().ok();
        let titles = listing.as_ref().map(titles);
        let colors = listing.as_ref().map(colors);
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
        if let Some(c) = colors {
            st.colors = c;
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
        {
            let mut pulled = self.pulled.lock().unwrap();
            let now = Instant::now();
            if pulled.get(surface).is_some_and(|t| now.duration_since(*t) < PULL_GAP) {
                return None;
            }
            pulled.insert(surface.to_string(), now);
        }
        let agent = self.state.lock().unwrap().terms.iter().any(|t| t.surface == surface && t.agent.is_some());
        let read = self.pool[0].read(surface, READ_LINES).map(|t| clean(&t, agent, TILE_LINES)).map_err(|e| e.to_string());
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
                                let r = src
                                    .read(&t.surface, READ_LINES)
                                    .map(|x| clean(&x, t.agent.is_some(), TILE_LINES))
                                    .map_err(|e| e.to_string());
                                (t.surface.clone(), r)
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .zip(terms.chunks(chunk))
                .flat_map(|(h, part)| {
                    h.join().unwrap_or_else(|_| {
                        // A reader panicked: say so on each of its tiles rather
                        // than show them blank.
                        part.iter().map(|t| (t.surface.clone(), Err("reader failed".to_string()))).collect()
                    })
                })
                .collect()
        })
    }

    fn frame_if_changed(&self, st: &mut State) -> Option<Frame> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let live: HashSet<&str> = st.terms.iter().map(|t| t.surface.as_str()).collect();
        st.since.retain(|s, _| live.contains(s.as_str()));
        for t in &st.terms {
            let keep = st.since.get(&t.surface).is_some_and(|(s, _)| *s == t.state);
            if !keep {
                st.since.insert(t.surface.clone(), (t.state.clone(), now));
            }
        }
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
                    color: st.colors.get(&t.workspace).cloned(),
                    since: st.since.get(&t.surface).map(|(_, at)| *at).unwrap_or(now),
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
        let now = self.actions.current().map_err(|e| e.to_string())?;
        terminals(&now)
            .into_iter()
            .find(|t| t.surface == surface)
            .ok_or_else(|| format!("{surface} is not a live terminal"))
    }

    /// Type `text` into the agent's pane and press Enter. Only an agent's pane
    /// takes a reply: in a plain shell the text would run as a command.
    pub fn reply(&self, surface: &str, text: &str) -> Result<(), String> {
        let line = reply_line(text)?;
        let t = self.live(surface)?;
        if t.agent.is_none() || t.state == "ended" {
            return Err(format!("{} has no running agent to reply to", t.surface));
        }
        self.actions.send_raw(&t.surface, &format!("{line}\r")).map_err(|e| e.to_string())
    }

    /// Bring the pane to the front in cmux: its workspace, then the pane.
    pub fn jump(&self, surface: &str) -> Result<(), String> {
        let t = self.live(surface)?;
        self.actions.select_workspace(&t.workspace).map_err(|e| e.to_string())?;
        self.actions.focus(&t.surface, &t.workspace).map_err(|e| e.to_string())
    }

    /// Poll every `interval`, and re-read a surface as soon as its id comes in
    /// on `pulls`. Each changed frame goes to `emit`, which says whether the
    /// page got it. Returns when `pulls` closes.
    pub fn run(&self, pulls: Receiver<String>, emit: impl Fn(Frame) -> bool) {
        let send = |f: Frame| {
            if !emit(f) {
                self.resend();
            }
        };
        let mut next = Instant::now();
        loop {
            // A tick that is due runs first, so a steady stream of events can
            // never starve the poll.
            if Instant::now() >= next {
                if let Some(f) = self.tick() {
                    send(f);
                }
                next = Instant::now() + self.interval;
            }
            let wait = next.saturating_duration_since(Instant::now());
            match pulls.recv_timeout(wait) {
                Ok(first) => {
                    // Take what else is queued, so a burst of events is one read each.
                    let mut want: HashSet<String> = HashSet::from([first]);
                    want.extend(pulls.try_iter());
                    for s in want {
                        if let Some(f) = self.pull(&s) {
                            send(f);
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

/// A reply as one typed line: line breaks and tabs become spaces, every other
/// control character (Ctrl-C, Escape and so a bracketed-paste end marker) is
/// dropped, and an empty or over-long reply is refused.
pub fn reply_line(text: &str) -> Result<String, String> {
    let line: String = text
        .chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    if line.trim().is_empty() {
        return Err("empty reply".into());
    }
    if line.chars().count() > REPLY_MAX {
        return Err(format!("reply is longer than {REPLY_MAX} characters"));
    }
    Ok(line)
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
    fn reply_line_drops_control_characters() {
        assert_eq!(reply_line("yes\x03\x04 \x1b[201~go\tnow\nok").unwrap(), "yes [201~go now ok");
        assert!(reply_line("\x1b\x03").is_err());
        assert!(reply_line(&"x".repeat(REPLY_MAX + 1)).is_err());
    }

    #[test]
    fn tail_drops_trailing_blanks() {
        assert_eq!(tail("a\nb\n\n  \n", 1), vec!["b"]);
    }

    #[test]
    fn an_agent_pane_loses_its_prompt_box_and_footer() {
        let rule = "─".repeat(60);
        let pane = format!(
            "\n\nNext step: review PR #56.\n\n\n\nAll done.\n              Update available! Run: brew upgrade\n{rule}\n❯ \n{rule}\n  ⚠ seamux-mods: x\n  ⏵⏵ auto mode on"
        );
        assert_eq!(clean(&pane, true, 10), vec!["Next step: review PR #56.", "", "All done."]);
        // A plain shell keeps everything.
        assert_eq!(clean(&pane, false, 3), vec![rule.clone(), "  ⚠ seamux-mods: x".to_string(), "  ⏵⏵ auto mode on".to_string()]);
    }

    #[test]
    fn a_question_box_is_kept() {
        let rule = "─".repeat(60);
        let pane = format!("Which one?\n{rule}\n  1. A\n  2. B\n{rule}\nEnter to select");
        assert_eq!(clean(&pane, true, 10), vec!["Which one?", &rule, "  1. A", "  2. B", &rule, "Enter to select"]);
        assert_eq!(tail("", 3), Vec::<String>::new());
    }
}
