//! `seamux bosun run`: the Bosun's pane runs this, not claude. It starts
//! Claude read-only, starts it again on the same conversation when it exits,
//! and, while Claude is idle, types in what is due: a fresh conversation
//! after the morning's reset hour. It lives in the tmux server, so it keeps
//! going while the app is closed (the bosun plan's ADR).

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use super::config::{self, Config};
use super::launch::{self, State};
use crate::backend::{tmux, Backend, Target};

/// How often the supervisor looks at the pane while Claude runs.
const TICK: Duration = Duration::from_secs(2);
/// A pane file must have said idle this long before anything is typed, so a
/// turn that just ended is not raced.
const SETTLE_MS: u64 = 1500;
/// After typing, how long to wait for the pane to leave idle before typing
/// again anyway.
const SENT_WAIT: Duration = Duration::from_secs(30);

/// What the supervisor does on a tick.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Start a fresh conversation: type /clear.
    Clear,
    /// Type the oldest queued item.
    Send(super::queue::Item),
}

/// Whether the pane file says Claude waits for a prompt: idle, nothing
/// asked, and settled.
pub fn idle(p: Option<&crate::status::Pane>, now_ms: u64) -> bool {
    p.is_some_and(|p| p.state == "idle" && p.question.is_none() && now_ms.saturating_sub(p.at) >= SETTLE_MS)
}

/// What is due now, given the kept state, the pane, the config and the
/// local day and hour. Nothing is typed into a busy Claude.
/// The morning's reset comes before anything queued, so a queued question
/// lands in the new day's conversation.
pub fn due(state: &State, pane_idle: bool, cfg: &Config, today: &str, hour: u32, queued: &[super::queue::Item]) -> Option<Action> {
    if !pane_idle {
        return None;
    }
    if launch::reset_due(&state.day, today, hour, cfg.reset_hour) {
        return Some(Action::Clear);
    }
    queued.first().cloned().map(Action::Send)
}

/// Type `text` into `t` and press Enter. Text with a newline goes in as a
/// paste, so Claude reads it as one prompt rather than several.
pub fn type_line(t: &Target, text: &str) -> Result<(), String> {
    if text.contains('\n') {
        let name = format!("bosun-{}", std::process::id());
        let set = tmux::tmux(&t.socket, &["set-buffer", "-b", &name, "--", text]).map_err(|e| e.to_string())?;
        if !set.status.success() {
            return Err(format!("tmux set-buffer: {}", String::from_utf8_lossy(&set.stderr).trim()));
        }
        let paste = tmux::tmux(&t.socket, &["paste-buffer", "-p", "-d", "-b", &name, "-t", &tmux::pane_of(t)]).map_err(|e| e.to_string())?;
        if !paste.status.success() {
            return Err(format!("tmux paste-buffer: {}", String::from_utf8_lossy(&paste.stderr).trim()));
        }
    } else {
        tmux::send_text(t, text)?;
    }
    thread::sleep(Duration::from_millis(150));
    tmux::send_text(t, "\r")
}

/// The file holding the day the supervisor last typed /clear.
const RESET_DAY: &str = "reset-day";

pub(crate) fn read_reset_day(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(RESET_DAY)).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// The later of two YYYY-MM-DD days ("" is earliest).
pub fn later_day(a: &str, b: &str) -> String {
    if b > a { b.to_string() } else { a.to_string() }
}

/// Print `msg` to the pane at most once per ten minutes for the same `key`:
/// the supervisor's terminal is Claude's screen, and a fault that repeats
/// every tick (a full disk, an unwritable queue) must not flood it.
pub fn warn(key: &str, msg: &str) {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static SEEN: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
    let mut g = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if m.get(key).is_some_and(|t| t.elapsed() < Duration::from_secs(600)) {
        return;
    }
    m.insert(key.to_string(), Instant::now());
    eprintln!("{msg}");
}

/// Whether Claude Code's prompt is empty, read from the pane's screen (tmux
/// capture-pane -e): the text after the last `❯` line's marker. A dim run
/// is the placeholder hint, and so is a "Try \"…" line. None when no prompt
/// line is found (the caller types anyway). Typing after a person's draft
/// (a stray `/`) turns the question into a slash command, so a draft waits.
pub fn input_empty(screen: &str) -> Option<bool> {
    input_text(screen).map(|t| t.is_empty())
}

/// The text in Claude Code's prompt ("" when empty or showing its hint),
/// or None when no prompt line is found.
pub fn input_text(screen: &str) -> Option<String> {
    let line = screen.lines().rev().find(|l| l.contains('❯'))?;
    let after = &line[line.find('❯')? + '❯'.len_utf8()..];
    let after = after.trim_start_matches(|c: char| c == '\u{a0}' || c == ' ');
    if after.starts_with("\x1b[2m") {
        return Some(String::new());
    }
    let mut plain = String::new();
    let mut chars = after.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // An escape sequence: CSI runs to its final letter.
            for d in chars.by_ref() {
                if d.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            plain.push(c);
        }
    }
    let plain = plain.trim_matches(|c: char| c.is_whitespace() || c == '\u{a0}');
    Some(if plain.starts_with("Try \"") { String::new() } else { plain.to_string() })
}

/// Whether the prompt holds the start of `item`'s text: what a paste whose
/// Enter was lost leaves behind (and what is ours to press Enter on).
pub fn holds_item(input: &str, item: &str) -> bool {
    // Claude Code shows a long or multi-line paste collapsed, as
    // "[Pasted text #1 +4 lines]": a multi-line item left unsent reads so.
    if item.contains('\n') && input.trim_start().starts_with("[Pasted text") {
        return true;
    }
    let want: String = item.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(24).collect();
    let have: String = input.split_whitespace().collect::<Vec<_>>().join(" ");
    want.len() >= 4 && (have.starts_with(&want) || want.starts_with(&have) && have.len() >= 4)
}

/// The pane's screen with its colours, for `input_empty`.
fn screen(t: &Target) -> Option<String> {
    let o = tmux::tmux(&t.socket, &["capture-pane", "-e", "-p", "-t", &tmux::pane_of(t)]).ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

fn now_ms() -> u64 {
    crate::history::now_ms()
}

/// The ticker: while `running`, act on what is due in the pane `pane`.
fn tick_loop(pane: String, dir: std::path::PathBuf, running: Arc<AtomicBool>) {
    let files = crate::status::pane_dir();
    let mut sent: Option<Instant> = None;
    // An item typed and not yet started on: it stays queued until the pane
    // leaves idle, so a prompt Claude never ran is typed again.
    let mut pending: Option<(super::queue::Item, Instant)> = None;
    while running.load(Ordering::SeqCst) {
        thread::sleep(TICK);
        let p = crate::status::read(&files, &pane);
        let is_idle = idle(p.as_ref(), now_ms());
        if let Some((item, at)) = &pending {
            if !is_idle {
                super::queue::done(item);
                pending = None;
            } else if at.elapsed() >= SENT_WAIT {
                // A paste whose Enter was lost leaves our own text in the
                // prompt, and nothing would ever type after it: press Enter.
                let target = tmux::TmuxBackend::default().target(&pane).ok().flatten();
                if let Some(t) = &target {
                    if screen(t).as_deref().and_then(input_text).is_some_and(|i| holds_item(&i, &item.text)) {
                        // Each Enter is a try too, so one that never submits
                        // still ends in queue/failed.
                        if super::queue::bump(item) >= super::queue::MAX_TRIES {
                            eprintln!("bosun: {} sat unsent in the prompt after {} Enters; it is in queue/failed", item.id, super::queue::MAX_TRIES);
                            super::queue::fail(item);
                            pending = None;
                            continue;
                        }
                        let _ = tmux::send_text(t, "\r");
                        pending = Some((item.clone(), Instant::now()));
                        continue;
                    }
                }
                if super::queue::bump(item) >= super::queue::MAX_TRIES {
                    eprintln!("bosun: {} was typed {} times and never started; it is in queue/failed", item.id, super::queue::MAX_TRIES);
                    super::queue::fail(item);
                }
                pending = None;
            }
            continue;
        }
        if let Some(at) = sent {
            // Typed a moment ago: wait for the turn to start (or give up waiting).
            if is_idle && at.elapsed() < SENT_WAIT {
                continue;
            }
            sent = None;
        }
        let cfg = Config::load_from(&dir);
        let mut state = State::load(&dir);
        // state.json is prime's to write (it holds the session id a /clear
        // makes); the supervisor keeps the day it last typed /clear apart,
        // and the later of the two is the conversation's day.
        state.day = later_day(&state.day, &read_reset_day(&dir));
        let now = launch::now_secs();
        // bosun-routines' loops queue what is due; the drain below types it.
        super::loops::tick(&dir, now);
        let (today, hour) = launch::local_day_hour(now);
        let queued = if is_idle { super::queue::waiting(&dir) } else { Vec::new() };
        let Some(action) = due(&state, is_idle, &cfg, &today, hour, &queued) else { continue };
        let Ok(Some(target)) = tmux::TmuxBackend::default().target(&pane) else { continue };
        // A person's half-typed prompt is never typed after (or wiped): wait.
        if screen(&target).as_deref().and_then(input_empty) == Some(false) {
            continue;
        }
        let typed = match action {
            // Marked once typed (a failed type is tried again next tick), so
            // a /clear that prime never hears of is not typed again on every one.
            Action::Clear => type_line(&target, "/clear").inspect(|()| {
                let _ = std::fs::write(dir.join(RESET_DAY), &today);
            }),
            // Out of the queue once the Bosun starts on it (above).
            Action::Send(item) => type_line(&target, &item.text).inspect(|()| pending = Some((item.clone(), Instant::now()))),
        };
        match typed {
            Ok(()) if pending.is_none() => sent = Some(Instant::now()),
            Ok(()) => {}
            Err(e) => warn("type", &format!("bosun: could not type into the pane: {e}")),
        }
    }
}

/// Run Claude in the pane until `seamux bosun stop` ends it: start it,
/// and start it again on the same conversation whenever it exits.
pub fn run() -> i32 {
    let Some(pane) = crate::py::env_or("SEAMUX_PANE_ID") else {
        eprintln!("bosun run: no SEAMUX_PANE_ID: this runs in the Bosun's pane (seamux bosun ensure starts it)");
        return 2;
    };
    let dir = config::dir();
    let seamux = launch::seamux_bin();
    let mut quick = 0;
    loop {
        let cfg = Config::load_from(&dir);
        let (settings, brief) = match launch::write_files(&cfg, &dir, &seamux) {
            Ok(x) => x,
            Err(e) => {
                eprintln!("bosun: {e}");
                return 1;
            }
        };
        let mut state = State::load(&dir);
        // Claude Code keeps transcripts under CLAUDE_CONFIG_DIR when set.
        let projects = crate::py::env_or("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| crate::py::home().join(".claude")).join("projects");
        let resume = Some(state.session.clone()).filter(|s| !s.is_empty() && launch::has_transcript(&projects, s));
        let fresh = tmux::new_id().to_ascii_lowercase();
        if resume.is_none() {
            state = State { session: fresh.clone(), day: launch::local_day_hour(launch::now_secs()).0 };
            let _ = state.save(&dir);
        }
        let args = launch::claude_args(&settings, &brief, resume.as_deref(), &fresh);
        let running = Arc::new(AtomicBool::new(true));
        let ticker = {
            let (pane, dir, running) = (pane.clone(), dir.clone(), running.clone());
            thread::spawn(move || tick_loop(pane, dir, running))
        };
        let started = Instant::now();
        let status = Command::new("claude").args(&args).current_dir(&cfg.root).status();
        running.store(false, Ordering::SeqCst);
        let _ = ticker.join();
        if let Err(e) = status {
            eprintln!("bosun: could not start claude: {e}");
            return 1;
        }
        // Three quick exits in a row is a Claude that cannot start: wait for
        // a person rather than spin.
        quick = if started.elapsed() < Duration::from_secs(10) { quick + 1 } else { 0 };
        if quick >= 3 {
            eprintln!("\nThe Bosun's Claude exited three times in a row. Press Enter to start it again.");
            let mut line = String::new();
            let _ = std::io::stdin().read_line(&mut line);
            quick = 0;
        } else {
            eprintln!("\nThe Bosun's Claude exited; starting it again.");
            thread::sleep(Duration::from_secs(1));
        }
    }
}

/// `seamux bosun prime`: the SessionStart hook. Keeps the conversation's
/// session id (a /clear or a compaction makes a new one) and prints the
/// note Claude starts the conversation with.
pub fn prime(payload: &str, dir: &Path) -> String {
    let v: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
    let sid = v.get("session_id").and_then(|s| s.as_str()).unwrap_or("");
    let source = v.get("source").and_then(|s| s.as_str()).unwrap_or("");
    let (today, _) = launch::local_day_hour(launch::now_secs());
    let mut state = State::load(dir);
    if !sid.is_empty() {
        state.session = sid.to_string();
    }
    if matches!(source, "startup" | "clear") || state.day.is_empty() {
        state.day = today.clone();
    }
    let _ = state.save(dir);
    let cfg = Config::load_from(dir);
    super::prime_with_log(&cfg, dir, &today, source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn pane(state: &str, at: u64) -> crate::status::Pane {
        let mut p = crate::status::Pane::new("W", "P");
        p.state = state.into();
        p.at = at;
        p
    }

    fn cfg() -> Config {
        Config { root: PathBuf::from("/u/code"), reset_hour: 4, allow_write: vec![], allowed_domains: vec![] }
    }

    #[test]
    fn idle_means_settled_with_nothing_asked() {
        assert!(idle(Some(&pane("idle", 1_000)), 10_000));
        assert!(!idle(Some(&pane("idle", 9_500)), 10_000), "just went idle");
        assert!(!idle(Some(&pane("working", 1_000)), 10_000));
        let mut asked = pane("idle", 1_000);
        asked.question = Some(serde_json::json!({}));
        assert!(!idle(Some(&asked), 10_000), "an open question waits on the person");
        assert!(!idle(None, 10_000), "no pane file yet");
    }

    #[test]
    fn a_new_day_clears_only_when_idle_and_past_the_hour() {
        let old = State { session: "S".into(), day: "2026-11-21".into() };
        assert_eq!(due(&old, true, &cfg(), "2026-11-22", 9, &[]), Some(Action::Clear));
        assert_eq!(due(&old, false, &cfg(), "2026-11-22", 9, &[]), None, "busy");
        assert_eq!(due(&old, true, &cfg(), "2026-11-22", 2, &[]), None, "before the hour");
        let today = State { session: "S".into(), day: "2026-11-22".into() };
        assert_eq!(due(&today, true, &cfg(), "2026-11-22", 9, &[]), None);
    }

    #[test]
    fn the_queue_drains_oldest_first_after_the_reset() {
        let item = |id: &str| super::super::queue::Item { id: id.into(), at: 1, text: "t".into(), source: "send".into(), path: PathBuf::from("/q") };
        let q = [item("a"), item("b")];
        let today = State { session: "S".into(), day: "2026-11-22".into() };
        assert_eq!(due(&today, true, &cfg(), "2026-11-22", 9, &q), Some(Action::Send(item("a"))));
        assert_eq!(due(&today, false, &cfg(), "2026-11-22", 9, &q), None, "never into a busy Bosun");
        let old = State { session: "S".into(), day: "2026-11-21".into() };
        assert_eq!(due(&old, true, &cfg(), "2026-11-22", 9, &q), Some(Action::Clear), "the reset first");
    }

    #[test]
    fn a_lost_enter_is_told_from_a_persons_draft() {
        assert!(holds_item("[Ask q1 from ws] is X", "[Ask q1 from ws]\nis X true?\n\nAnswer it"));
        assert!(!holds_item("/", "[Ask q1 from ws] is X"));
        assert!(!holds_item("hello there", "[Ask q1 from ws] is X"));
        assert!(holds_item("[Pasted text #1 +4 lines]", "[Ask q1 from ws]\nis X?\n\nAnswer it"), "a collapsed paste is ours");
        assert!(!holds_item("[Pasted text #1 +4 lines]", "one line"), "only a multi-line item collapses");
        let e = "\x1b[39m\u{276f}\u{a0}";
        assert_eq!(input_text(&format!("{e}[Ask q1 from")).as_deref(), Some("[Ask q1 from"));
    }

    #[test]
    fn a_draft_in_the_prompt_is_not_typed_after() {
        let e = "\x1b[39m\u{276f}\u{a0}";
        assert_eq!(input_empty(&format!("x\n{e}\n")), Some(true));
        assert_eq!(input_empty(&format!("x\n{e}/\n")), Some(false), "a stray slash waits");
        assert_eq!(input_empty(&format!("x\n{e}hello\x1b[0m\n")), Some(false));
        assert_eq!(input_empty(&format!("{e}\x1b[2mTry \"how does it work?\"\x1b[22m")), Some(true), "the dim hint");
        assert_eq!(input_empty("\u{276f} Try \"how does x work?\""), Some(true));
        assert_eq!(input_empty("\u{276f} /old message\nother\n\u{276f}\u{a0}\n"), Some(true), "the last prompt line counts");
        assert_eq!(input_empty("no prompt here"), None);
    }

    #[test]
    fn the_later_day_wins() {
        assert_eq!(later_day("2026-11-21", "2026-11-22"), "2026-11-22");
        assert_eq!(later_day("2026-11-22", ""), "2026-11-22");
        assert_eq!(later_day("", ""), "");
    }

    #[test]
    fn prime_keeps_the_new_session_and_moves_the_day_on_a_clear() {
        let d = std::env::temp_dir().join(format!("bosun-prime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        State { session: "OLD".into(), day: "2026-01-01".into() }.save(&d).unwrap();
        let note = prime(r#"{"session_id":"NEW","source":"clear"}"#, &d);
        let s = State::load(&d);
        assert_eq!(s.session, "NEW");
        assert_ne!(s.day, "2026-01-01");
        assert!(note.contains("Bosun"));
        prime(r#"{"session_id":"NEWER","source":"compact"}"#, &d);
        assert_eq!(State::load(&d).day, s.day, "a compaction keeps the day");
        let _ = std::fs::remove_dir_all(&d);
    }
}
