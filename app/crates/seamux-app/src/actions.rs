//! What Desk does in place: answer an agent's AskUserQuestion, and move a
//! deep-plan increment along (go, record a check). Everything runs in this
//! process through crew-board, so it works while the intent server is down.
//!
//! An answer types a digit into a terminal, which answers whatever prompt
//! is showing, so it goes through crew-board's `deliver`: the option's label
//! must be on that surface's screen before the digit is typed, and the
//! resolved line must show after. The surface is the one the ask hook
//! recorded, never one the page names, and the question is re-read from the
//! hook's file at the moment of answering.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crew_board::ask::{deliver, Runner};
use serde_json::Value;

/// One answer at a time in this process, and each ask answered once: the
/// asks already delivered, by workspace and the ask's `at`. Until the
/// answered hook removes the file, a second press would otherwise find the
/// label on screen again (in the resolved "→ label" line) and type the
/// digit into whatever prompt follows.
static ANSWERED: Mutex<Vec<(String, u64)>> = Mutex::new(Vec::new());

/// The hook's question file for `ws`, matched without case.
fn question_file(state_dir: &Path, ws: &str) -> Option<PathBuf> {
    let want = format!("question-{ws}.json");
    std::fs::read_dir(state_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&want))
        .map(|e| e.path())
}

/// What an answer will type, worked out from the hook's file: the surface,
/// and the label of option `n`. Refuses anything one digit cannot answer.
pub fn plan_answer(state_dir: &Path, ws: &str, n: u32) -> Result<(String, String), String> {
    plan_answer_at(state_dir, ws, n).map(|(s, l, _)| (s, l))
}

/// `plan_answer`, with the ask's `at` (its identity across presses).
fn plan_answer_at(state_dir: &Path, ws: &str, n: u32) -> Result<(String, String, u64), String> {
    if !cmux::is_uuid(ws) {
        return Err(format!("not a workspace UUID: {ws:?}"));
    }
    let path = question_file(state_dir, ws).ok_or("that question is no longer open")?;
    let marker = path.with_extension("");
    if !marker.exists() {
        return Err("that question was answered".into());
    }
    let v: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or("the question file could not be read")?;
    let qs = v.get("questions").and_then(Value::as_array).cloned().unwrap_or_default();
    let [q] = qs.as_slice() else {
        return Err(format!("this ask has {} questions: answer it in the pane", qs.len()));
    };
    if q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false) {
        return Err("a multi-select question is answered in the pane".into());
    }
    let options = q.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    if n < 1 || n as usize > options.len() || n > 9 {
        return Err(format!("option {n} is not one of the {}", options.len()));
    }
    let label = options[n as usize - 1].get("label").and_then(Value::as_str).unwrap_or("").to_string();
    if label.trim().is_empty() {
        return Err("that option has no label to look for on screen".into());
    }
    let surface = v.get("surface").and_then(Value::as_str).unwrap_or("").to_string();
    if !cmux::is_uuid(&surface) {
        return Err(format!("the ask recorded no terminal: press {n} in the pane"));
    }
    Ok((surface, label, v.get("at").and_then(Value::as_u64).unwrap_or(0)))
}

/// Answer the open question in `ws` with option `n`. `live` says whether a
/// surface is a running terminal now. Ok carries what the screen showed.
pub fn answer(state_dir: &Path, ws: &str, n: u32, runner: &dyn Runner, live: &dyn Fn(&str) -> bool) -> Result<String, String> {
    // Claim the ask under the lock, then deliver without it: one ask is
    // answered once, and another agent's answer need not wait on this one's
    // screen checks.
    let (surface, label, id) = {
        let mut answered = ANSWERED.lock().unwrap_or_else(|p| p.into_inner());
        let (surface, label, at) = plan_answer_at(state_dir, ws, n)?;
        let id = (ws.to_ascii_uppercase(), at);
        if answered.contains(&id) {
            return Err("already answered from here".into());
        }
        answered.push(id.clone());
        let keep = answered.len().saturating_sub(64);
        answered.drain(..keep);
        (surface, label, id)
    };
    let release = || ANSWERED.lock().unwrap_or_else(|p| p.into_inner()).retain(|x| *x != id);
    if !live(&surface) {
        release();
        return Err("that pane is gone".into());
    }
    match deliver(&surface, n, &label, runner) {
        (true, detail) => Ok(detail),
        (false, detail) => {
            release(); // not typed: the person may try again
            Err(detail)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const WS: &str = "68A92708-B9BD-4D9D-9043-A55FD88A17AA";
    const SURF: &str = "088AC8B3-C1B1-4EB9-9A88-1DA89CDBFF76";

    /// A terminal that shows `before` until a digit is sent, then `after`.
    struct Screen {
        before: String,
        after: String,
        sent: RefCell<Vec<String>>,
    }

    impl Runner for Screen {
        fn run(&self, argv: &[&str]) -> (i32, String) {
            match argv {
                ["read-screen", ..] => (0, if self.sent.borrow().is_empty() { self.before.clone() } else { self.after.clone() }),
                ["send", "--surface", s, text] => {
                    self.sent.borrow_mut().push(format!("{s}:{text}"));
                    (0, "OK".into())
                }
                ["send-key", ..] => (0, "OK".into()),
                _ => (1, "unexpected".into()),
            }
        }
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seamux-actions-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ask(d: &Path, questions: Value, surface: &str) {
        std::fs::write(d.join(format!("question-{WS}")), "").unwrap();
        // Each fixture ask is a new ask: answered-once is keyed by `at`.
        static AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let at = AT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let v = serde_json::json!({"at": at, "surface": surface, "questions": questions});
        std::fs::write(d.join(format!("question-{WS}.json")), v.to_string()).unwrap();
    }

    fn colour() -> Value {
        serde_json::json!([{"question": "Pick a colour", "multiSelect": false,
            "options": [{"label": "Red"}, {"label": "Blue"}]}])
    }

    #[test]
    fn the_digit_goes_to_the_recorded_pane_only_when_its_option_shows() {
        let d = dir("deliver");
        ask(&d, colour(), SURF);
        let screen = Screen { before: "Pick a colour\n❯ 1. Red\n  2. Blue".into(), after: "  → Blue".into(), sent: RefCell::default() };
        let ok = answer(&d, WS, 2, &screen, &|s| s == SURF).unwrap();
        assert!(ok.contains("delivered 2"), "{ok}");
        assert_eq!(screen.sent.borrow().as_slice(), [format!("{SURF}:2")]);
        // A second press before the answered hook removes the file: the
        // resolved line still shows "Blue", but nothing more is typed.
        let again = Screen { before: "  → Blue".into(), after: "  → Blue".into(), sent: RefCell::default() };
        assert!(answer(&d, WS, 2, &again, &|_| true).unwrap_err().contains("already answered"));
        assert!(again.sent.borrow().is_empty());

        // A new ask, but the pane moved on to another prompt: nothing is typed.
        ask(&d, colour(), SURF);
        let other = Screen { before: "Run the tests? (y/n)".into(), after: String::new(), sent: RefCell::default() };
        let err = answer(&d, WS, 1, &other, &|_| true).unwrap_err();
        assert!(err.contains("not showing this question"), "{err}");
        assert!(other.sent.borrow().is_empty());
        // Nothing was typed, so the same ask can be tried again once it shows.
        let back = Screen { before: "Pick a colour\n❯ 1. Red\n  2. Blue".into(), after: "  → Red".into(), sent: RefCell::default() };
        assert!(answer(&d, WS, 1, &back, &|_| true).unwrap().contains("delivered 1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn what_one_digit_cannot_answer_is_refused() {
        let d = dir("refuse");
        let screen = Screen { before: "Red Blue".into(), after: String::new(), sent: RefCell::default() };
        let live = |_: &str| true;
        assert!(answer(&d, WS, 1, &screen, &live).unwrap_err().contains("no longer open"));
        ask(&d, colour(), SURF);
        assert!(answer(&d, WS, 3, &screen, &live).unwrap_err().contains("not one of the 2"));
        assert!(answer(&d, "workspace:1", 1, &screen, &live).is_err());
        assert!(answer(&d, WS, 1, &screen, &|_| false).unwrap_err().contains("gone"));
        ask(&d, serde_json::json!([{"question": "a", "options": [{"label": "x"}]}, {"question": "b", "options": [{"label": "y"}]}]), SURF);
        assert!(answer(&d, WS, 1, &screen, &live).unwrap_err().contains("2 questions"));
        ask(&d, serde_json::json!([{"question": "a", "multiSelect": true, "options": [{"label": "x"}]}]), SURF);
        assert!(answer(&d, WS, 1, &screen, &live).unwrap_err().contains("multi-select"));
        ask(&d, colour(), "");
        assert!(answer(&d, WS, 1, &screen, &live).unwrap_err().contains("recorded no terminal"));
        // Answered (the marker went): the .json alone is not an open question.
        ask(&d, colour(), SURF);
        std::fs::remove_file(d.join(format!("question-{WS}"))).unwrap();
        assert!(answer(&d, WS, 1, &screen, &live).unwrap_err().contains("answered"));
        assert!(screen.sent.borrow().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_workspace_matches_in_any_case() {
        let d = dir("case");
        ask(&d, colour(), SURF);
        assert_eq!(plan_answer(&d, &WS.to_lowercase(), 1).unwrap(), (SURF.to_string(), "Red".to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }
}
