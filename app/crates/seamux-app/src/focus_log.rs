//! The focus log: one JSON line each time the window loses focus (which app
//! took it, the tab, each guard and what the app did) and each time the app
//! hides it (who asked), in ~/Library/Logs/seamux/focus.jsonl. Only the last
//! KEEP lines are kept. Nothing parses it: people read it, in Console.app or
//! a terminal, to tell a lost focus from a hidden window.

use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

/// How many lines the log keeps.
pub const KEEP: usize = 500;
const FILE: &str = "focus.jsonl";

/// The tab the page last said was selected (focus_tab).
static TAB: Mutex<String> = Mutex::new(String::new());
/// One writer at a time, so two lines never interleave or undo a trim.
static WRITE: Mutex<()> = Mutex::new(());

/// The page selected a tab: remember it for the next line.
#[tauri::command]
pub fn focus_tab(tab: String) {
    if let Ok(mut t) = TAB.lock() {
        *t = tab;
    }
}

fn tab() -> String {
    TAB.lock().map(|t| t.clone()).unwrap_or_default()
}

/// ~/Library/Logs/seamux, where macOS keeps an app's logs. Nowhere on other
/// systems: the log is for the macOS window's focus.
fn dir() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Logs/seamux"))
}

/// The one thread that writes the log, fed in the order lines are recorded,
/// so a hide's line always comes before the lost focus it caused.
fn writer(dir: PathBuf) -> &'static Sender<Value> {
    static TX: OnceLock<Sender<Value>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        std::thread::spawn(move || {
            for line in rx {
                if let Err(e) = append(&dir, &line, KEEP) {
                    eprintln!("seamux: focus log: {e}");
                }
            }
        });
        tx
    })
}

/// Append `line` to `dir`'s focus.jsonl, keeping the last `keep` lines.
/// The file is small (a few hundred short lines), so it is rewritten whole,
/// through a temp file, rather than trimmed in place.
pub fn append(dir: &Path, line: &Value, keep: usize) -> std::io::Result<()> {
    let _one = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir)?;
    let path = dir.join(FILE);
    let old = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<&str> = old.lines().filter(|l| !l.is_empty()).collect();
    let new = line.to_string();
    lines.push(&new);
    let from = lines.len().saturating_sub(keep);
    let mut text = lines[from..].join("\n");
    text.push('\n');
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)
}

/// Write a line off the calling thread (the main thread, often), stamped
/// with the time and the tab. A log that cannot be written is not worth
/// failing anything for.
fn record(mut line: Value) {
    let Some(dir) = dir() else { return };
    if let Value::Object(m) = &mut line {
        m.insert("at".into(), json!(super::shell::now_ms()));
        m.insert("tab".into(), json!(tab()));
    }
    let _ = writer(dir).send(line);
}

/// The window lost focus: what the guard saw and what it did.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn lost(seen: &super::shell::Seen, verdict: super::shell::Verdict) {
    record(json!({ "kind": "lost", "seen": seen, "verdict": verdict }));
}

/// The app hid the window; `by` is who asked.
pub fn hid(by: &str) {
    record(json!({ "kind": "hid", "by": by }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seamux-focus-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn appends_one_json_line_each() {
        let d = temp("append");
        append(&d, &json!({ "kind": "hid", "by": "hotkey" }), KEEP).unwrap();
        append(&d, &json!({ "kind": "lost", "verdict": "took back" }), KEEP).unwrap();
        let text = std::fs::read_to_string(d.join(FILE)).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["by"], "hotkey");
        assert_eq!(lines[1]["verdict"], "took back");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keeps_only_the_last_lines() {
        let d = temp("cap");
        for n in 0..12 {
            append(&d, &json!({ "n": n }), 5).unwrap();
        }
        let text = std::fs::read_to_string(d.join(FILE)).unwrap();
        let ns: Vec<i64> = text.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["n"].as_i64().unwrap()).collect();
        assert_eq!(ns, vec![7, 8, 9, 10, 11]);
        assert!(!d.join(format!("{FILE}.tmp")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn focus_tab_is_stamped_on_the_next_line() {
        focus_tab("radar".into());
        assert_eq!(tab(), "radar");
    }
}
