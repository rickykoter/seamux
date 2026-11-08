//! Notifications on the tmux backend (docs/adr/0050, 0054). Under cmux, cmux
//! posts them from the hooks; here nothing would, since hooks are separate
//! processes that cannot reach the app. So once a second the app reads the
//! pane-status files and posts when a pane starts waiting on you, finishes a
//! turn (working to idle), or has waited on you for REMIND_MS without an
//! answer. bash-guard's blocks arrive as blocked-<key>.json files in the same
//! folder: each is posted once and deleted.
//!
//! The first look only learns the states: a pane already waiting when the
//! app starts is not announced as if it had just asked.
//!
//! What a banner carries:
//! - the workspace's color as a dot (crew-color's registry, else the palette
//!   color crew-color would hash it to) and a sound per kind;
//! - the question itself, when the pane's file holds one;
//! - on a finished turn, whether it left work to review.
//!
//! What it does not do: post about the pane you are looking at (its terminal
//! has focus and the app is in front), or post twice when two things land
//! together. A finished turn is held for SETTLE_MS so a question right after
//! it replaces it, and banners of one kind due in the same tick become one.
//!
//! A click on a banner brings the app forward on that pane. A banner for a
//! single-choice AskUserQuestion also offers its options; picking one types
//! the number into the pane through crew-board's `ask::deliver`, which first
//! checks the question is still on screen.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crew_core::backend::tmux::TmuxBackend;
use crew_core::backend::{Backend, Kind};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::{Action, ActionType, NotificationExt};

/// A finished turn waits this long for a question to replace it, and for
/// other panes finishing with it to share one banner.
pub const SETTLE_MS: u64 = 3_000;
/// However busy, held finished turns are posted by this long after the first.
pub const SETTLE_MAX_MS: u64 = 10_000;
/// One reminder when a pane has waited on you this long.
pub const REMIND_MS: u64 = 5 * 60_000;

/// What a banner is about. Each has its own sound (macOS system sounds).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum NoteKind {
    Waiting,
    Reminder,
    Finished,
    Blocked,
}

impl NoteKind {
    /// The log's kind (crew_core::notifications).
    pub fn key(self) -> &'static str {
        match self {
            NoteKind::Waiting => "waiting",
            NoteKind::Reminder => "reminder",
            NoteKind::Finished => "finished",
            NoteKind::Blocked => "blocked",
        }
    }

    pub fn sound(self) -> &'static str {
        match self {
            NoteKind::Waiting => "Ping",
            NoteKind::Reminder => "Purr",
            NoteKind::Finished => "Glass",
            NoteKind::Blocked => "Basso",
        }
    }
}

/// One pane, as a tick sees it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PaneView {
    pub id: String,
    pub ws: String,
    /// The workspace's title.
    pub title: String,
    /// The workspace's color dot (an emoji), or "".
    pub dot: String,
    pub state: String,
    pub question: Option<Value>,
    pub asked: Option<String>,
    pub review: bool,
}

impl PaneView {
    fn label(&self) -> String {
        let t = if self.title.is_empty() { "a workspace" } else { &self.title };
        if self.dot.is_empty() { t.to_string() } else { format!("{} {t}", self.dot) }
    }
}

/// One banner to post.
#[derive(Clone, Debug, PartialEq)]
pub struct Note {
    pub kind: NoteKind,
    pub title: String,
    pub body: String,
    /// The pane a click goes to.
    pub pane: String,
    pub ws: String,
    /// A single-choice question's option labels, whole: the buttons clip
    /// them, but the answer looks for the whole label on screen.
    pub options: Vec<String>,
    /// When the question was asked (its record's `at`), so a late pick can
    /// tell the question it answers is still the open one.
    pub asked_at: Option<u64>,
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>().trim_end())
    }
}

/// The open question's text, at most 160 characters, and how many more follow.
fn question_text(p: &PaneView) -> Option<String> {
    if let Some(q) = &p.question {
        let qs = q.get("questions").and_then(Value::as_array);
        let first = qs.and_then(|a| a.first()).and_then(|q| q.get("question")).and_then(Value::as_str).unwrap_or("").trim();
        if !first.is_empty() {
            let more = qs.map(|a| a.len()).unwrap_or(1).saturating_sub(1);
            let text = clip(first, 160);
            return Some(if more > 0 { format!("{text} (+{more} more)") } else { text });
        }
    }
    p.asked.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(|a| clip(a, 160))
}

/// A single-choice question's option labels, and when it was asked; no
/// labels for several questions or a multi-select (one digit answers neither).
fn options_of(p: &PaneView) -> (Vec<String>, Option<u64>) {
    let Some(q) = &p.question else { return (Vec::new(), None) };
    let at = q.get("at").and_then(Value::as_u64);
    let Some([only]) = q.get("questions").and_then(Value::as_array).map(Vec::as_slice) else { return (Vec::new(), at) };
    if only.get("multiSelect").and_then(Value::as_bool).unwrap_or(false) {
        return (Vec::new(), at);
    }
    let labels: Vec<String> = only
        .get("options")
        .and_then(Value::as_array)
        .map(|o| o.iter().map(|o| o.get("label").and_then(Value::as_str).unwrap_or("").trim().to_string()).collect())
        .unwrap_or_default();
    (if labels.iter().any(String::is_empty) { Vec::new() } else { labels }, at)
}

fn note(kind: NoteKind, p: &PaneView, title: String, body: String) -> Note {
    Note { kind, title, body, pane: p.id.clone(), ws: p.ws.clone(), options: Vec::new(), asked_at: None }
}

pub fn waiting(p: &PaneView) -> Note {
    let body = question_text(p).unwrap_or_else(|| "Claude is waiting on you".into());
    let mut n = note(NoteKind::Waiting, p, format!("{} · waiting on you", p.label()), body);
    (n.options, n.asked_at) = options_of(p);
    n
}

pub fn reminder(p: &PaneView, waited_ms: u64) -> Note {
    let mins = (waited_ms / 60_000).max(1);
    let what = question_text(p).unwrap_or_else(|| "Claude is waiting on you".into());
    let mut n = note(NoteKind::Reminder, p, format!("{} · still waiting", p.label()), format!("{mins} min · {what}"));
    (n.options, n.asked_at) = options_of(p);
    n
}

pub fn finished(p: &PaneView) -> Note {
    let body = if p.review { "Finished its turn · changes to review" } else { "Finished its turn · nothing new to review" };
    note(NoteKind::Finished, p, format!("{} · done", p.label()), body.into())
}

/// A blocked-<key>.json from bash-guard, as a notification. `pane` finds the
/// pane it names, for the label and the click.
pub fn blocked_note(v: &Value, pane: &dyn Fn(&str) -> Option<PaneView>) -> Option<Note> {
    let reason = v.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty())?;
    let cmd = v.get("command").and_then(Value::as_str).unwrap_or("");
    let id = v.get("pane").and_then(Value::as_str).unwrap_or("");
    let p = pane(id).unwrap_or_else(|| PaneView { id: id.into(), ..Default::default() });
    let who = if p.title.is_empty() { "Claude".to_string() } else { p.label() };
    Some(note(NoteKind::Blocked, &p, format!("{who} · blocked: {reason}"), clip(cmd, 200)))
}

/// Post every blocked file in `dir` once: read, post, delete. A file that
/// cannot be read is deleted too, so it is never retried forever.
pub fn take_blocked(dir: &Path, pane: &dyn Fn(&str) -> Option<PaneView>) -> Vec<Note> {
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("blocked-") && n.ends_with(".json")))
        .collect();
    files.sort();
    files
        .into_iter()
        .filter_map(|p| {
            let note = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| blocked_note(&v, pane));
            let _ = std::fs::remove_file(&p);
            note
        })
        .collect()
}

/// Banners of one kind that are due together, as one: "3 agents finished",
/// naming them. A lone banner passes through unchanged.
pub fn merge(notes: Vec<Note>) -> Vec<Note> {
    let mut by: Vec<(NoteKind, Vec<Note>)> = Vec::new();
    for n in notes {
        match by.iter_mut().find(|(k, _)| *k == n.kind) {
            Some((_, v)) => v.push(n),
            None => by.push((n.kind, vec![n])),
        }
    }
    by.sort_by_key(|(k, _)| *k);
    by.into_iter()
        .map(|(kind, mut v)| {
            if v.len() == 1 {
                return v.remove(0);
            }
            let count = v.len();
            let title = match kind {
                NoteKind::Waiting => format!("{count} agents are waiting on you"),
                NoteKind::Reminder => format!("{count} agents are still waiting"),
                NoteKind::Finished => format!("{count} agents finished"),
                NoteKind::Blocked => format!("bash-guard blocked {count} commands"),
            };
            // Each one's label is the part of its title before " · ".
            let mut names: Vec<&str> = Vec::new();
            for n in &v {
                let name = n.title.split(" · ").next().unwrap_or("");
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            let body = names.join(", ");
            let first = v.remove(0);
            Note { kind, title, body, options: Vec::new(), asked_at: None, ..first }
        })
        .collect()
}

/// A pane waiting on you: since when, and whether its reminder went.
#[derive(Clone, Copy, Debug)]
struct Wait {
    since: u64,
    reminded: bool,
}

/// The notifier's memory between ticks. `tick` depends on nothing else, so
/// the rules are tested without tmux or a window.
#[derive(Default)]
pub struct Notifier {
    before: Option<HashMap<String, String>>,
    waits: HashMap<String, Wait>,
    /// Finished turns held for SETTLE_MS, and when the first and last came.
    held: Vec<Note>,
    held_first: u64,
    held_last: u64,
    /// Banners not posted because their pane was on screen, for the log;
    /// `take_skipped` empties it.
    skipped: Vec<Note>,
}

impl Notifier {
    /// What to post at `now` (ms) for these panes. `looking` is the pane on
    /// screen in the app while it is in front: it is never posted about.
    pub fn tick(&mut self, now: u64, panes: &[PaneView], looking: Option<&str>) -> Vec<Note> {
        let seen = |id: &str| looking.is_some_and(|l| l.eq_ignore_ascii_case(id));
        let states: HashMap<String, String> = panes.iter().map(|p| (p.id.clone(), p.state.clone())).collect();
        let Some(before) = self.before.replace(states) else {
            // The first look: learn, announce nothing, remind about nothing.
            for p in panes.iter().filter(|p| p.state == "needs_input") {
                self.waits.insert(p.id.clone(), Wait { since: now, reminded: true });
            }
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut sorted: Vec<&PaneView> = panes.iter().collect();
        sorted.sort_by(|a, b| a.id.cmp(&b.id));
        for p in sorted {
            let was = before.get(&p.id).map(String::as_str);
            if p.state == "needs_input" {
                if was.is_some_and(|w| w != "needs_input") {
                    self.waits.insert(p.id.clone(), Wait { since: now, reminded: false });
                    // A question right after a finished turn says it all.
                    self.held.retain(|n| n.pane != p.id);
                    if seen(&p.id) {
                        self.skipped.push(waiting(p));
                    } else {
                        out.push(waiting(p));
                    }
                } else if let Some(w) = self.waits.get_mut(&p.id) {
                    if !w.reminded && now.saturating_sub(w.since) >= REMIND_MS && !seen(&p.id) {
                        w.reminded = true;
                        out.push(reminder(p, now - w.since));
                    }
                }
            } else {
                self.waits.remove(&p.id);
                // Back at work before its finish was posted: that turn is old news.
                if p.state == "working" {
                    self.held.retain(|n| n.pane != p.id);
                }
                if p.state == "idle" && was == Some("working") && seen(&p.id) {
                    self.held.retain(|n| n.pane != p.id);
                    self.skipped.push(finished(p));
                } else if p.state == "idle" && was == Some("working") {
                    if self.held.is_empty() {
                        self.held_first = now;
                    }
                    self.held_last = now;
                    self.held.retain(|n| n.pane != p.id);
                    self.held.push(finished(p));
                }
            }
        }
        self.waits.retain(|id, _| panes.iter().any(|p| &p.id == id));
        // Looked at while held: you saw it finish.
        let (looked, kept): (Vec<Note>, Vec<Note>) = std::mem::take(&mut self.held).into_iter().partition(|n| seen(&n.pane));
        self.held = kept;
        self.skipped.extend(looked);
        if !self.held.is_empty()
            && (now.saturating_sub(self.held_last) >= SETTLE_MS || now.saturating_sub(self.held_first) >= SETTLE_MAX_MS)
        {
            out.append(&mut self.held);
        }
        out
    }

    /// The banners skipped since the last call (a pane on screen), oldest first.
    pub fn take_skipped(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.skipped)
    }
}

/// The log's line for a note: shown, or skipped because its pane was on screen.
pub fn entry(n: &Note, shown: bool) -> crew_core::notifications::Entry {
    crew_core::notifications::Entry {
        at: 0,
        ws: n.ws.clone(),
        pane: n.pane.clone(),
        kind: n.kind.key().into(),
        title: n.title.clone(),
        body: n.body.clone(),
        shown,
        why: if shown { String::new() } else { crew_core::notifications::ON_SCREEN.into() },
        source: "app".into(),
    }
}

/// The option a performed action picked: its leading number (macOS reports
/// a button by its title, "2. Pears"; elsewhere by its id, "2"). None is a
/// click on the banner itself, or on Open.
pub fn picked(action: &str) -> Option<u32> {
    let digits: String = action.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|n| *n >= 1)
}

/// The buttons of a banner with options. Open goes first: on macOS a click
/// on the Options menu's own button reports the first action, and that must
/// never answer the question.
pub fn actions_of(n: &Note) -> Vec<Action> {
    let mut v = vec![Action::builder("open", "Open").build()];
    for (i, l) in n.options.iter().enumerate() {
        let id = (i + 1).to_string();
        v.push(Action::builder(id.clone(), format!("{id}. {}", clip(l, 60))).build());
    }
    v
}

/// The round emoji nearest a crew-color hex, or "" for one that is not hex.
pub fn dot(hex: &str) -> &'static str {
    let h = hex.trim().trim_start_matches('#');
    let c = |i: usize| h.get(i..i + 2).and_then(|s| u8::from_str_radix(s, 16).ok()).map(|v| v as f64 / 255.0);
    let (Some(r), Some(g), Some(b)) = (c(0), c(2), c(4)) else { return "" };
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let (l, d) = ((max + min) / 2.0, max - min);
    let s = if d == 0.0 { 0.0 } else { d / (1.0 - (2.0 * l - 1.0).abs()) };
    if s < 0.25 || d < 0.08 {
        return if l > 0.85 { "⚪" } else { "⚫" };
    }
    let hue = 60.0
        * if max == r {
            ((g - b) / d).rem_euclid(6.0)
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
    match hue {
        h if !(15.0..345.0).contains(&h) => "🔴",
        h if h < 45.0 => {
            if l < 0.28 {
                "🟤"
            } else {
                "🟠"
            }
        }
        h if h < 70.0 => "🟡",
        h if h < 165.0 => "🟢",
        h if h < 265.0 => "🔵",
        _ => "🟣",
    }
}

// --- the app ------------------------------------------------------------------

/// The pane whose terminal has focus in the app, as the page last said.
fn looking() -> &'static Mutex<Option<String>> {
    static L: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

/// The page says which pane's terminal has focus (None when none does).
#[tauri::command]
pub fn notify_looking(pane: Option<String>) {
    *looking().lock().unwrap_or_else(|p| p.into_inner()) = pane.filter(|p| !p.is_empty());
}

/// What each posted banner points at, by its notification id.
fn posted() -> &'static Mutex<HashMap<i32, Note>> {
    static P: OnceLock<Mutex<HashMap<i32, Note>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

static NEXT_ID: AtomicI32 = AtomicI32::new(1);

fn post(app: &AppHandle, n: &Note) {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    {
        let mut p = posted().lock().unwrap_or_else(|p| p.into_inner());
        // Old banners are long off screen: keep the last hundred.
        if p.len() >= 100 {
            if let Some(&old) = p.keys().min() {
                p.remove(&old);
            }
        }
        p.insert(id, n.clone());
    }
    let mut b = app.notification().builder().id(id).title(&n.title).body(&n.body).sound(n.kind.sound());
    if !n.options.is_empty() {
        // One type per pane, replaced each time: a banner reads its type's
        // actions when it is shown, and the plugin never forgets a type.
        let ty = format!("ask-{}", n.pane);
        let _ = app.notification().register_action_types(vec![ActionType::builder(ty.clone()).actions(actions_of(n)).build()]);
        b = b.action_type_id(ty);
    }
    let _ = b.show();
}

/// Bring the app forward on the note's pane.
fn jump(app: &AppHandle, n: &Note) {
    crate::shell::summon(app);
    let _ = app.emit("notify:jump", serde_json::json!({"ws": n.ws, "pane": n.pane}));
}

/// Answer the note's question with option `k` if it is still the open one.
/// Otherwise, or when the answer cannot be confirmed on screen, go to the
/// pane and say why.
fn answer(app: &AppHandle, n: &Note, k: u32) {
    let fail = |why: String| {
        jump(app, n);
        let label = n.title.split(" · ").next().unwrap_or("Claude");
        let title = format!("{label} · couldn't answer");
        let note = Note { kind: NoteKind::Blocked, title, body: why, options: Vec::new(), asked_at: None, ..n.clone() };
        crew_core::notifications::record(entry(&note, true));
        post(app, &note);
    };
    let Some(label) = n.options.get(k as usize - 1) else { return fail(format!("there is no option {k}")) };
    let open = crew_core::status::read(&crew_core::home::home_cache(), &n.pane)
        .filter(|p| p.state == "needs_input")
        .and_then(|p| p.question)
        .and_then(|q| q.get("at").and_then(Value::as_u64));
    if open.is_none() || open != n.asked_at {
        return fail("That question is no longer open".into());
    }
    let Some(target) = TmuxBackend::default().target(&n.pane).ok().flatten() else {
        return fail("The pane's session is gone".into());
    };
    let (ok, detail) = crew_board::ask::deliver(&n.pane, k, label, &crew_board::ask::Tmux { target });
    if !ok {
        fail(detail);
    }
}

fn on_action(app: &AppHandle, id: Option<i32>, action: &str) {
    let Some(n) = id.and_then(|id| posted().lock().unwrap_or_else(|p| p.into_inner()).get(&id).cloned()) else { return };
    match picked(action).filter(|_| !n.options.is_empty()) {
        Some(k) => answer(app, &n, k),
        None => jump(app, &n),
    }
}

/// A workspace's dot, from its folder: the color crew-color gave it, else
/// the one crew-color would hash it to.
fn dot_for(cwd: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    // crew-color keys a worktree by its git top-level, not the folder it was opened in.
    let root = crew_cli::color::resolve_root(Some(cwd)).unwrap_or_else(|_| cwd.to_string());
    let hex = crew_cli::color::peek(&root).unwrap_or_else(|| crew_cli::color::hashed(&root).to_string());
    dot(&hex).to_string()
}

/// The notifier's loop, started at launch; it returns at once unless the
/// app runs on the tmux backend.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if seamux_app::backend::kind() != Kind::Tmux {
            return;
        }
        // UNUserNotificationCenter posts nothing until the person allows it:
        // the first launch asks once; later launches return the saved answer.
        #[cfg(target_os = "macos")]
        if let Err(e) = notify_rust::request_auth_blocking() {
            eprintln!("seamux: notifications not authorized: {e}");
        }
        let handle = app.clone();
        let _ = app.notification().on_action(move |a| {
            let (h, id, action) = (handle.clone(), a.notification().map(|n| n.id()), a.action_id().to_string());
            // Off the plugin's thread: an answer reads the screen and waits.
            std::thread::spawn(move || on_action(&h, id, &action));
        });
        let state = crew_core::home::home_cache();
        let t = TmuxBackend::default();
        let mut n = Notifier::default();
        let mut dots: HashMap<String, String> = HashMap::new();
        for tick in 0u64.. {
            // Colors change rarely: the registry is read again once a minute.
            if tick % 60 == 0 {
                dots.clear();
            }
            let ws: HashMap<String, (String, String)> = t
                .workspaces()
                .unwrap_or_default()
                .into_iter()
                .map(|w| {
                    let d = dots.entry(w.cwd.clone()).or_insert_with(|| dot_for(&w.cwd)).clone();
                    (w.id.to_ascii_uppercase(), (w.title, d))
                })
                .collect();
            let views: Vec<PaneView> = t
                .panes(None)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|p| {
                    let s = crew_core::status::read(&state, &p.id)?;
                    let (title, dot) = ws.get(&p.workspace.to_ascii_uppercase()).cloned().unwrap_or_default();
                    Some(PaneView { id: p.id, ws: p.workspace, title, dot, state: s.state, question: s.question, asked: s.asked, review: s.review })
                })
                .collect();
            let on_screen = looking().lock().unwrap_or_else(|p| p.into_inner()).clone().filter(|_| crate::shell::in_front(&app));
            let mut notes = n.tick(crew_core::history::now_ms(), &views, on_screen.as_deref());
            let mut skipped = n.take_skipped();
            let find = |id: &str| views.iter().find(|v| v.id.eq_ignore_ascii_case(id)).cloned();
            let here = |n: &Note| on_screen.as_deref().is_some_and(|l| l.eq_ignore_ascii_case(&n.pane));
            let (seen, blocked): (Vec<Note>, Vec<Note>) = take_blocked(&state, &find).into_iter().partition(|n| here(n));
            notes.extend(blocked);
            skipped.extend(seen);
            // One line per pane, before merge: "3 agents finished" is three.
            for note in &skipped {
                crew_core::notifications::record(entry(note, false));
            }
            for note in &notes {
                crew_core::notifications::record(entry(note, true));
            }
            for note in merge(notes) {
                post(&app, &note);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pane(id: &str, state: &str) -> PaneView {
        PaneView { id: id.into(), ws: format!("W{id}"), title: format!("shop-{id}"), dot: "🟢".into(), state: state.into(), ..Default::default() }
    }

    fn ask(p: PaneView, q: Value) -> PaneView {
        PaneView { question: Some(q), ..p }
    }

    fn one_question() -> Value {
        json!({"at": 42, "surface": "P1", "questions": [{"question": "Which fruit?", "multiSelect": false,
               "options": [{"label": "Apples"}, {"label": "Pears"}]}]})
    }

    /// A notifier that has had its first look at `panes`.
    fn primed(panes: &[PaneView]) -> Notifier {
        let mut n = Notifier::default();
        assert!(n.tick(0, panes, None).is_empty(), "the first look announces nothing");
        n
    }

    #[test]
    fn a_question_posts_with_its_text_options_and_sound() {
        let mut n = primed(&[pane("P1", "working")]);
        let out = n.tick(1_000, &[ask(pane("P1", "needs_input"), one_question())], None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "🟢 shop-P1 · waiting on you");
        assert_eq!(out[0].body, "Which fruit?");
        assert_eq!(out[0].options, ["Apples", "Pears"]);
        assert_eq!(out[0].asked_at, Some(42));
        assert_eq!(out[0].kind.sound(), "Ping");
        assert!(n.tick(2_000, &[ask(pane("P1", "needs_input"), one_question())], None).is_empty(), "still waiting: once");
    }

    #[test]
    fn several_questions_or_multiselect_offer_no_buttons() {
        let two = json!({"questions": [{"question": "A?", "options": [{"label": "x"}]}, {"question": "B?", "options": []}]});
        let w = waiting(&ask(pane("P1", "needs_input"), two));
        assert_eq!(w.body, "A? (+1 more)");
        assert!(w.options.is_empty());
        let multi = json!({"questions": [{"question": "Pick", "multiSelect": true, "options": [{"label": "x"}, {"label": "y"}]}]});
        assert!(waiting(&ask(pane("P1", "needs_input"), multi)).options.is_empty());
        let asked = PaneView { asked: Some("Ship it?".into()), ..pane("P1", "needs_input") };
        assert_eq!(waiting(&asked).body, "Ship it?");
        assert_eq!(waiting(&pane("P1", "needs_input")).body, "Claude is waiting on you");
    }

    #[test]
    fn a_finished_turn_waits_to_settle_and_says_whether_there_is_review() {
        let mut n = primed(&[pane("P1", "working")]);
        let done = PaneView { review: true, ..pane("P1", "idle") };
        assert!(n.tick(1_000, &[done.clone()], None).is_empty(), "held");
        assert!(n.tick(3_000, &[done.clone()], None).is_empty(), "still settling");
        let out = n.tick(4_000, &[done], None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "🟢 shop-P1 · done");
        assert_eq!(out[0].body, "Finished its turn · changes to review");
        assert_eq!(out[0].kind.sound(), "Glass");
        assert!(finished(&pane("P1", "idle")).body.contains("nothing new"));
    }

    #[test]
    fn a_question_right_after_a_finished_turn_replaces_it() {
        let mut n = primed(&[pane("P1", "working")]);
        assert!(n.tick(1_000, &[pane("P1", "idle")], None).is_empty());
        let asked = PaneView { asked: Some("Merge now?".into()), ..pane("P1", "needs_input") };
        let out = n.tick(2_500, &[asked.clone()], None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoteKind::Waiting);
        assert!(n.tick(10_000, &[asked], None).is_empty(), "the finished turn is never posted");
    }

    #[test]
    fn panes_finishing_together_share_one_banner() {
        let ps = |s: &str| vec![pane("P1", s), pane("P2", s), pane("P3", s)];
        let mut n = primed(&ps("working"));
        assert!(n.tick(1_000, &[pane("P1", "idle"), pane("P2", "working"), pane("P3", "idle")], None).is_empty());
        assert!(n.tick(2_000, &ps("idle"), None).is_empty(), "a new one restarts the settle");
        let out = merge(n.tick(5_000, &ps("idle"), None));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].title, "3 agents finished");
        assert_eq!(out[0].body, "🟢 shop-P1, 🟢 shop-P3, 🟢 shop-P2", "in the order they finished");
        assert_eq!(out[0].pane, "P1", "a click goes to the first");
    }

    #[test]
    fn a_steady_stream_of_finishes_still_posts_by_the_cap() {
        let ids: Vec<String> = (0..12).map(|i| format!("P{i:02}")).collect();
        let mut n = primed(&ids.iter().map(|i| pane(i, "working")).collect::<Vec<_>>());
        let mut posted = Vec::new();
        for t in 0..12usize {
            // One more pane finishes every second, so the settle never runs out.
            let now: Vec<PaneView> = ids.iter().enumerate().map(|(i, id)| pane(id, if i <= t { "idle" } else { "working" })).collect();
            posted.push((t, n.tick(1_000 + t as u64 * 1_000, &now, None)));
        }
        let first = posted.iter().find(|(_, out)| !out.is_empty()).expect("posted by SETTLE_MAX_MS");
        assert_eq!(first.0, 10, "ten seconds after the first finish");
        assert_eq!(first.1.len(), 11, "all of them, in one go");
    }

    #[test]
    fn nothing_is_posted_about_the_pane_on_screen() {
        let mut n = primed(&[pane("P1", "working"), pane("P2", "working")]);
        let out = n.tick(1_000, &[pane("P1", "needs_input"), pane("P2", "needs_input")], Some("p1"));
        assert_eq!(out.iter().map(|n| n.pane.as_str()).collect::<Vec<_>>(), ["P2"]);
        let mut n = primed(&[pane("P1", "working")]);
        assert!(n.tick(1_000, &[pane("P1", "idle")], None).is_empty());
        assert!(n.tick(2_000, &[pane("P1", "idle")], Some("P1")).is_empty(), "looked at while held");
        assert!(n.tick(9_000, &[pane("P1", "idle")], None).is_empty(), "and dropped");
    }

    #[test]
    fn what_is_skipped_on_screen_is_kept_for_the_log_and_what_is_superseded_is_not() {
        // An ask on screen and a finish on screen are skipped; one off screen is posted.
        let mut n = primed(&[pane("P1", "working"), pane("P2", "working")]);
        let out = n.tick(1_000, &[pane("P1", "needs_input"), pane("P2", "idle")], Some("P1"));
        assert!(out.is_empty());
        let s = n.take_skipped();
        assert_eq!(s.iter().map(|n| (n.pane.as_str(), n.kind)).collect::<Vec<_>>(), [("P1", NoteKind::Waiting)]);
        assert!(n.take_skipped().is_empty(), "taken once");
        // Held, then looked at: skipped.
        assert!(n.tick(1_500, &[pane("P1", "needs_input"), pane("P2", "idle")], Some("P2")).is_empty());
        assert_eq!(n.take_skipped().iter().map(|n| n.kind).collect::<Vec<_>>(), [NoteKind::Finished]);
        // Finished while on screen: skipped at once.
        let mut n = primed(&[pane("P1", "working")]);
        n.tick(1_000, &[pane("P1", "idle")], Some("P1"));
        assert_eq!(n.take_skipped().iter().map(|n| n.kind).collect::<Vec<_>>(), [NoteKind::Finished]);
        // Superseded by a question, or back to work: neither posted nor kept.
        let mut n = primed(&[pane("P1", "working")]);
        n.tick(1_000, &[pane("P1", "idle")], None);
        n.tick(1_500, &[pane("P1", "working")], None);
        assert!(n.tick(20_000, &[pane("P1", "working")], None).is_empty());
        assert!(n.take_skipped().is_empty());
        // A reminder while you look is retried, not kept.
        let mut n = primed(&[pane("P1", "working")]);
        n.tick(0, &[pane("P1", "needs_input")], None);
        n.tick(REMIND_MS, &[pane("P1", "needs_input")], Some("P1"));
        assert!(n.take_skipped().is_empty());
    }

    #[test]
    fn a_note_logs_as_its_kind_shown_or_skipped_on_screen() {
        let w = waiting(&ask(pane("P1", "needs_input"), one_question()));
        let e = entry(&w, true);
        assert_eq!((e.kind.as_str(), e.pane.as_str(), e.shown, e.why.as_str(), e.source.as_str()), ("waiting", "P1", true, "", "app"));
        assert_eq!(e.title, w.title);
        let s = entry(&w, false);
        assert_eq!((s.shown, s.why.as_str()), (false, "on screen"));
    }

    #[test]
    fn a_long_wait_is_reminded_once() {
        let mut n = primed(&[pane("P1", "working")]);
        let w = ask(pane("P1", "needs_input"), one_question());
        assert_eq!(n.tick(1_000, &[w.clone()], None).len(), 1);
        assert!(n.tick(1_000 + REMIND_MS - 1, &[w.clone()], None).is_empty());
        let out = n.tick(1_000 + REMIND_MS, &[w.clone()], None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, NoteKind::Reminder);
        assert_eq!(out[0].title, "🟢 shop-P1 · still waiting");
        assert_eq!(out[0].body, "5 min · Which fruit?");
        assert_eq!(out[0].options, ["Apples", "Pears"]);
        assert_eq!(out[0].kind.sound(), "Purr");
        assert!(n.tick(1_000 + 3 * REMIND_MS, &[w], None).is_empty(), "once");
    }

    #[test]
    fn a_reminder_waits_while_you_look_and_a_pane_waiting_at_launch_gets_none() {
        let mut n = primed(&[pane("P1", "working")]);
        let w = pane("P1", "needs_input");
        assert_eq!(n.tick(0, &[w.clone()], None).len(), 1);
        assert!(n.tick(REMIND_MS, &[w.clone()], Some("P1")).is_empty(), "on screen");
        assert_eq!(n.tick(REMIND_MS + 1_000, &[w.clone()], None).len(), 1, "after you look away");
        let mut n = primed(&[w.clone()]);
        assert!(n.tick(REMIND_MS * 2, &[w], None).is_empty());
    }

    #[test]
    fn an_answer_resets_the_wait() {
        let mut n = primed(&[pane("P1", "working")]);
        n.tick(0, &[pane("P1", "needs_input")], None);
        n.tick(1_000, &[pane("P1", "working")], None);
        n.tick(2_000, &[pane("P1", "needs_input")], None);
        assert!(n.tick(REMIND_MS + 1_000, &[pane("P1", "needs_input")], None).is_empty(), "counted from the new ask");
        assert_eq!(n.tick(REMIND_MS + 2_000, &[pane("P1", "needs_input")], None).len(), 1);
    }

    #[test]
    fn a_long_label_is_clipped_on_its_button_but_kept_whole_for_the_answer() {
        let long = "x".repeat(80);
        let q = json!({"at": 1, "questions": [{"question": "Q?", "options": [{"label": long}, {"label": "b"}]}]});
        let w = waiting(&ask(pane("P1", "needs_input"), q));
        assert_eq!(w.options[0], long, "deliver looks for this on screen");
        let title = actions_of(&w)[1].title().to_string();
        assert!(title.ends_with('…') && title.chars().count() == 63, "{title}");
    }

    #[test]
    fn back_at_work_inside_the_settle_drops_the_finish() {
        let mut n = primed(&[pane("P1", "working")]);
        assert!(n.tick(1_000, &[pane("P1", "idle")], None).is_empty());
        assert!(n.tick(2_000, &[pane("P1", "working")], None).is_empty());
        assert!(n.tick(9_000, &[pane("P1", "working")], None).is_empty(), "never posted");
    }

    #[test]
    fn merge_keeps_kinds_apart_and_lone_notes_whole() {
        let a = waiting(&ask(pane("P1", "needs_input"), one_question()));
        let b = waiting(&pane("P2", "needs_input"));
        let c = finished(&pane("P3", "idle"));
        let out = merge(vec![c.clone(), a.clone(), b]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "2 agents are waiting on you");
        assert!(out[0].options.is_empty(), "a merged banner answers nothing");
        assert_eq!(out[1], c);
        assert_eq!(merge(vec![a.clone()]), vec![a]);
    }

    #[test]
    fn options_become_buttons_after_open_and_picks_read_either_way() {
        let a = waiting(&ask(pane("P1", "needs_input"), one_question()));
        let acts: Vec<(String, String)> = actions_of(&a).iter().map(|x| (x.id().to_string(), x.title().to_string())).collect();
        let want: Vec<(String, String)> = [("open", "Open"), ("1", "1. Apples"), ("2", "2. Pears")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        assert_eq!(acts, want);
        assert_eq!(picked("2. Pears"), Some(2));
        assert_eq!(picked("2"), Some(2));
        assert_eq!(picked("Open"), None);
        assert_eq!(picked("tap"), None);
        assert_eq!(picked("0"), None);
    }

    #[test]
    fn crew_colors_map_to_their_dots() {
        let got: Vec<&str> = crew_cli::color::PALETTE.iter().map(|(_, h)| dot(h)).collect();
        assert_eq!(got, ["🔴", "🔴", "🟠", "🟡", "🟢", "🟢", "🔵", "🔵", "🔵", "🔵", "🔵", "🟣", "🟣", "🟣", "🟤", "⚫"]);
        assert_eq!(dot("#28B262"), "🟢", "a family shade");
        assert_eq!(dot("nope"), "");
    }

    #[test]
    fn a_blocked_file_is_posted_once_and_deleted() {
        let dir = std::env::temp_dir().join(format!("seamux-notify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("blocked-P1.json");
        std::fs::write(&f, json!({"pane": "P1", "workspace": "W1", "reason": "force push", "command": "git push -f"}).to_string()).unwrap();
        std::fs::write(dir.join("blocked-bad.json"), "not json").unwrap();
        std::fs::write(dir.join("pane-P1.json"), "{}").unwrap();
        let find = |id: &str| (id == "P1").then(|| pane("P1", "working"));
        let n = take_blocked(&dir, &find);
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].title, "🟢 shop-P1 · blocked: force push");
        assert_eq!(n[0].body, "git push -f");
        assert_eq!(n[0].pane, "P1");
        assert_eq!(n[0].kind.sound(), "Basso");
        assert!(!f.exists() && !dir.join("blocked-bad.json").exists(), "both taken");
        assert!(dir.join("pane-P1.json").exists(), "only blocked files");
        assert!(take_blocked(&dir, &find).is_empty(), "posted once");
        let _ = std::fs::remove_dir_all(&dir);
        let unknown = blocked_note(&json!({"pane": "PX", "reason": "rm -rf"}), &|_| None).unwrap();
        assert_eq!(unknown.title, "Claude · blocked: rm -rf");
    }
}
