//! The resume watcher: types continue into an armed session once the usage
//! limit that stopped it resets. It follows ADR 0003's read, type once,
//! confirm rule (the ADR "Typing continue unattended follows ADR 0003").
//!
//! Every 15 seconds, on either backend, it reads the pane files. A pane a
//! limit stopped (crew-hooks' stopfail wrote `limited`) is resumed only when
//! all of this holds:
//!
//! - its worktree is armed in resume.json, and the pane is live on the wall;
//! - its limit is due: the reset plus a minute, or on usage billing the next
//!   try (2, 5 and 15 minutes after each stop, then it gives up). A spend
//!   limit (billing_error) is never retried, and a stop with no known reset
//!   waits for you;
//! - the pane file still holds that stop, for the session it recorded, and
//!   the pane is not working;
//! - its screen, read through the backend's Runner, shows no turn running
//!   and no question.
//!
//! Then it types the resume text (crew-local's resumePrompt, default
//! "continue") once, checks the text is in the prompt, presses Enter once,
//! and waits up to 30 seconds for the pane's own hook to write working.
//! Anything short of that notifies and gives up: `gave_up` goes in the pane
//! file, the row says why, and nothing is typed again until a new stop.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crew_board::ask::Runner;
use crew_core::status::{self, Limited, Pane};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// How often the pane files are read.
pub const TICK: Duration = Duration::from_secs(15);
/// A subscription stop is resumed this long after its window resets.
pub const AFTER_RESET_MS: u64 = 60_000;
/// Usage billing's retries after a rate_limit stop, by try: then it gives up.
pub const RETRY_MS: [u64; 3] = [2 * 60_000, 5 * 60_000, 15 * 60_000];
/// How long the pane's hook has to write working after Enter.
pub const CONFIRM_MS: u64 = 30_000;
/// A stop this soon after the watcher resumed the same session counts as
/// that resume's next try.
pub const SAME_RUN_MS: u64 = 30 * 60_000;

/// What to do about one stopped pane now.
#[derive(Debug, PartialEq)]
pub enum Plan {
    /// Not due, or never unattended.
    Wait,
    /// Record when the next try is due (and how many came before).
    Schedule { tries: u32, next_try: u64 },
    /// Due: try now.
    Resume,
    /// Stop trying, for this reason.
    GiveUp(String),
}

/// What the watcher decides for an armed pane's stop at `now`. `usage` is
/// usage billing; `before` is how many resumes of this session the watcher
/// made in its current run of stops (each one stopped again).
pub fn plan(l: &Limited, usage: bool, before: u32, now: u64) -> Plan {
    if l.gave_up.is_some() || l.error == "billing_error" {
        return Plan::Wait;
    }
    let tries = l.tries.max(before);
    if tries as usize >= RETRY_MS.len() {
        return Plan::GiveUp(format!("{} tries did not get through", RETRY_MS.len()));
    }
    let due = if usage && l.window.is_none() {
        match l.next_try {
            Some(t) if l.tries == tries => t,
            _ => return Plan::Schedule { tries, next_try: l.at + RETRY_MS[tries as usize] },
        }
    } else {
        match l.resets_at {
            Some(r) => r + AFTER_RESET_MS,
            None => return Plan::Wait,
        }
    };
    if now >= due { Plan::Resume } else { Plan::Wait }
}

/// The text the watcher types: crew-local's resumePrompt, else "continue",
/// as one line (wall::reply_line's rules).
pub fn resume_text(cfg: &serde_json::Map<String, serde_json::Value>) -> String {
    cfg.get("resumePrompt")
        .and_then(|v| v.as_str())
        .and_then(|t| seamux_app::wall::reply_line(t).ok())
        .map(|t| t.trim().to_string())
        // A leading '-' would read as a flag to tmux's send-keys.
        .filter(|t| !t.starts_with('-'))
        .unwrap_or_else(|| "continue".into())
}

/// Whether `text` sits in the prompt box: the last line that starts with
/// Claude's prompt mark, and the lines a long prompt wraps onto, spaces
/// aside. The transcript above it does not count, so a "continue" Claude
/// wrote earlier is no proof the text was typed.
fn typed(text: &str, screen: &str) -> bool {
    let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let lines: Vec<&str> = screen.lines().collect();
    let Some(at) = lines.iter().rposition(|l| l.trim_start().starts_with(['❯', '>'])) else { return false };
    let mut box_text = lines[at].trim_start().trim_start_matches(['❯', '>']).to_string();
    for l in &lines[at + 1..] {
        if l.trim_start().starts_with('─') {
            break;
        }
        box_text.push_str(l);
    }
    squash(&box_text).contains(&squash(text))
}

const SCREEN_LINES: &str = "60";

/// Type the resume into `surface` and prove it landed: Ok when the pane's
/// hook wrote working after Enter. `working` reads whether it has, since a
/// time (ms). Never sends Enter unless the text is on screen.
pub fn resume(surface: &str, text: &str, runner: &dyn Runner, working: &dyn Fn(u64) -> bool,
              now: &dyn Fn() -> u64, confirm_ms: u64, gap: Duration) -> Result<(), String> {
    let (rc, screen) = runner.run(&["read-screen", "--surface", surface, "--lines", SCREEN_LINES]);
    if rc != 0 || screen.trim().is_empty() {
        return Err("its screen could not be read".into());
    }
    if status::screen_busy(&screen) {
        return Err("a turn was already running".into());
    }
    if status::screen_asks(&screen) {
        return Err("it was asking you something".into());
    }
    let (rc, out) = runner.run(&["send", "--surface", surface, text]);
    if rc != 0 {
        return Err(format!("typing failed ({})", out.trim().chars().take(80).collect::<String>()));
    }
    let mut seen = false;
    for attempt in 0..=crew_board::ask::CONFIRM_TRIES {
        if attempt > 0 {
            std::thread::sleep(gap);
        }
        let (rc, screen) = runner.run(&["read-screen", "--surface", surface, "--lines", SCREEN_LINES]);
        if rc == 0 && typed(text, &screen) {
            seen = true;
            break;
        }
    }
    if !seen {
        return Err(format!("“{text}” did not show in its prompt, so Enter was not pressed"));
    }
    let sent = now();
    let (rc, out) = runner.run(&["send-key", "--surface", surface, "enter"]);
    if rc != 0 {
        return Err(format!("Enter did not send ({})", out.trim().chars().take(80).collect::<String>()));
    }
    while now() < sent + confirm_ms {
        if working(sent) {
            return Ok(());
        }
        std::thread::sleep(gap);
    }
    if working(sent) { Ok(()) } else { Err("its turn did not start within 30 seconds".into()) }
}

/// Whether the pane's own hook has written working since `since`.
fn worked_since(dir: &Path, key: &str, since: u64) -> bool {
    status::read(dir, key).is_some_and(|p| p.state == "working" && p.at >= since)
}

/// The Runner for a pane on the app's backend.
fn runner_for(surface: &str) -> Option<Box<dyn Runner>> {
    use crew_core::backend::Backend;
    if seamux_app::backend::kind() == crew_core::backend::Kind::Tmux {
        let target = crew_core::backend::tmux::TmuxBackend::default().target(surface).ok().flatten()?;
        Some(Box::new(crew_board::ask::Tmux { target }))
    } else {
        Some(Box::new(crew_board::ask::Cmux))
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).sound("Basso").show();
}

/// The stopped panes worth a look: idle, with a limit stop the app has not
/// given up on.
fn stopped(dir: &Path) -> Vec<(Pane, Limited)> {
    status::all(dir).into_iter()
        .filter(|p| p.state == "idle" && !p.surface.is_empty())
        .filter_map(|p| { let l = p.limited.clone()?; Some((p, l)) })
        .filter(|(_, l)| l.gave_up.is_none())
        .collect()
}

/// One look at every stopped pane. `resumed` carries, per session, how many
/// resumes the watcher made in its current run of stops and when the last
/// was.
fn tick(app: &AppHandle, dir: &Path, resumed: &mut HashMap<String, (u32, u64)>) {
    let now = crew_core::history::now_ms();
    resumed.retain(|_, (_, at)| now.saturating_sub(*at) < SAME_RUN_MS);
    let panes = stopped(dir);
    if panes.is_empty() {
        return;
    }
    let Some(frame) = crate::wall_app::last_frame() else { return };
    let store = crate::resume::Store::live();
    let usage = crew_board::usage::billing_mode() == "usage";
    for (p, l) in panes {
        let Some(tile) = frame.tiles.iter().find(|t| t.surface.eq_ignore_ascii_case(&p.surface)) else { continue };
        if tile.agent.is_none() || tile.state == "ended" || !store.armed(&seamux_app::tuck::root_of(&tile.cwd)) {
            continue;
        }
        let name = if tile.workspace_title.is_empty() { tile.label.clone() } else { tile.workspace_title.clone() };
        // A stop soon after this watcher resumed the session is that resume's next try.
        let before = resumed.get(&l.session).filter(|(_, at)| l.at.saturating_sub(*at) < SAME_RUN_MS).map(|(n, _)| *n).unwrap_or(0);
        let key = p.key().to_string();
        let give_up = |why: String| {
            if status::update_limited(dir, &key, &l, |x| x.gave_up = Some(why.clone())) {
                notify(app, &format!("{name} · didn't resume"), &format!("It waits for you: {why}."));
            }
        };
        match plan(&l, usage, before, now) {
            Plan::Wait => {}
            Plan::Schedule { tries, next_try } => {
                status::update_limited(dir, &key, &l, |x| { x.tries = tries; x.next_try = Some(next_try); });
            }
            Plan::GiveUp(why) => give_up(why),
            Plan::Resume => {
                // The stop must still be the one read, for its own session.
                let still = status::read(dir, &key).is_some_and(|f| f.state == "idle" && f.session == l.session
                    && f.limited.as_ref().is_some_and(|x| x.at == l.at && x.gave_up.is_none()));
                if !still {
                    continue;
                }
                // A pane tmux cannot find this tick is tried again on the next.
                let Some(runner) = runner_for(&p.surface) else { continue };
                let text = resume_text(&crew_board::usage::crew_local());
                let res = resume(&p.surface, &text, runner.as_ref(), &|since| worked_since(dir, &key, since),
                                 &crew_core::history::now_ms, CONFIRM_MS, crew_board::ask::CONFIRM_GAP);
                match res {
                    Ok(()) => {
                        resumed.insert(l.session.clone(), (before + 1, crew_core::history::now_ms()));
                    }
                    Err(why) => give_up(why),
                }
            }
        }
    }
}

/// The watcher's loop, started at launch on both backends.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let dir = crew_core::home::xdg_cache();
        let mut resumed: HashMap<String, (u32, u64)> = HashMap::new();
        loop {
            std::thread::sleep(TICK);
            tick(&app, &dir, &mut resumed);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn lim(window: Option<&str>, resets_at: Option<u64>) -> Limited {
        Limited { error: "rate_limit".into(), session: "s".into(), at: 1_000, window: window.map(String::from),
                  resets_at, tries: 0, next_try: None, gave_up: None }
    }

    #[test]
    fn a_subscription_stop_resumes_a_minute_after_its_reset_and_never_without_one() {
        let l = lim(Some("five_hour"), Some(100_000));
        assert_eq!(plan(&l, false, 0, 100_000 + AFTER_RESET_MS - 1), Plan::Wait);
        assert_eq!(plan(&l, false, 0, 100_000 + AFTER_RESET_MS), Plan::Resume);
        assert_eq!(plan(&lim(None, None), false, 0, u64::MAX), Plan::Wait, "no reset known: it waits for you");
        let spend = Limited { error: "billing_error".into(), ..lim(Some("spend_limit"), Some(1)) };
        assert_eq!(plan(&spend, false, 0, u64::MAX), Plan::Wait, "a spend limit is never retried");
        let done = Limited { gave_up: Some("x".into()), ..l.clone() };
        assert_eq!(plan(&done, false, 0, u64::MAX), Plan::Wait, "given up: until a new stop");
        assert!(matches!(plan(&l, false, 3, u64::MAX), Plan::GiveUp(_)), "three resumes that each stopped again");
    }

    #[test]
    fn usage_billing_retries_at_two_five_and_fifteen_minutes_then_gives_up() {
        let l = lim(None, None);
        assert_eq!(plan(&l, true, 0, 0), Plan::Schedule { tries: 0, next_try: 1_000 + 2 * 60_000 });
        let set = Limited { next_try: Some(121_000), ..l.clone() };
        assert_eq!(plan(&set, true, 0, 120_999), Plan::Wait);
        assert_eq!(plan(&set, true, 0, 121_000), Plan::Resume);
        // The resume stopped again: a new stop, the watcher's count carried.
        assert_eq!(plan(&l, true, 1, 0), Plan::Schedule { tries: 1, next_try: 1_000 + 5 * 60_000 });
        assert_eq!(plan(&l, true, 2, 0), Plan::Schedule { tries: 2, next_try: 1_000 + 15 * 60_000 });
        assert_eq!(plan(&l, true, 3, 0), Plan::GiveUp("3 tries did not get through".into()));
        // A next_try scheduled before the count was known is scheduled again.
        assert_eq!(plan(&set, true, 1, 0), Plan::Schedule { tries: 1, next_try: 1_000 + 5 * 60_000 });
    }

    #[test]
    fn the_resume_text_is_one_line_from_crew_local() {
        let cfg = |v: serde_json::Value| v.as_object().cloned().unwrap();
        assert_eq!(resume_text(&cfg(serde_json::json!({}))), "continue");
        assert_eq!(resume_text(&cfg(serde_json::json!({"resumePrompt": "go on\npls"}))), "go on pls");
        assert_eq!(resume_text(&cfg(serde_json::json!({"resumePrompt": "  "}))), "continue");
        assert_eq!(resume_text(&cfg(serde_json::json!({"resumePrompt": "-x"}))), "continue", "never a flag");
    }

    /// A terminal that answers each read with the next screen, and logs
    /// what was typed.
    struct Fake {
        screens: RefCell<Vec<String>>,
        sent: RefCell<Vec<String>>,
    }

    impl Runner for Fake {
        fn run(&self, argv: &[&str]) -> (i32, String) {
            match argv {
                ["read-screen", ..] => {
                    let mut s = self.screens.borrow_mut();
                    (0, if s.len() > 1 { s.remove(0) } else { s.first().cloned().unwrap_or_default() })
                }
                ["send", _, _, text] => { self.sent.borrow_mut().push(text.to_string()); (0, "OK".into()) }
                ["send-key", _, _, key] => { self.sent.borrow_mut().push(format!("<{key}>")); (0, "OK".into()) }
                _ => (1, "no".into()),
            }
        }
    }

    fn fake(screens: &[&str]) -> Fake {
        Fake { screens: RefCell::new(screens.iter().map(|s| s.to_string()).collect()), sent: RefCell::new(Vec::new()) }
    }

    const IDLE: &str = "  ⎿  You've hit your limit\n\n✻ Worked for 2m\n\n────\n❯ \n────";
    const TYPED: &str = "  ⎿  You've hit your limit\n\n✻ Worked for 2m\n\n────\n❯ continue\n────";
    const BUSY: &str = "✽ Bloviating… (34s · ↓ 1.9k tokens)\n────\n❯ \n────";
    const ASKS: &str = " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel";

    fn run(f: &Fake, works: bool) -> Result<(), String> {
        let t = RefCell::new(0u64);
        let now = || { *t.borrow_mut() += 1_000; *t.borrow() };
        resume("S1", "continue", f, &|_| works, &now, 5_000, Duration::ZERO)
    }

    #[test]
    fn it_types_once_presses_enter_once_and_counts_only_a_turn_that_started() {
        let f = fake(&[IDLE, TYPED]);
        assert_eq!(run(&f, true), Ok(()));
        assert_eq!(*f.sent.borrow(), ["continue", "<enter>"]);
        let f = fake(&[IDLE, TYPED]);
        assert!(run(&f, false).unwrap_err().contains("did not start"), "no hook wrote working");
        assert_eq!(*f.sent.borrow(), ["continue", "<enter>"], "and it was not typed again");
    }

    #[test]
    fn it_refuses_a_busy_asking_or_unreadable_screen_and_never_sends_enter_blind() {
        for (screen, why) in [(BUSY, "turn"), (ASKS, "asking"), ("  \n", "read")] {
            let f = fake(&[screen]);
            let e = run(&f, true).unwrap_err();
            assert!(e.contains(why), "{e}");
            assert!(f.sent.borrow().is_empty(), "nothing typed into {screen:?}");
        }
        let f = fake(&[IDLE, IDLE]);
        assert!(run(&f, true).unwrap_err().contains("Enter was not pressed"));
        // "continue" in the transcript above an empty prompt is no proof.
        let said = "⏺ I'll continue once the limit resets.\n────\n❯ \n────";
        let f = fake(&[IDLE, said]);
        assert!(run(&f, true).unwrap_err().contains("Enter was not pressed"));
        assert_eq!(*f.sent.borrow(), ["continue"], "typed, but no Enter");
    }
}
