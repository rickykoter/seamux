//! Asks: `deep-plan ask` writes asks/<id>.json and .html under the plans
//! directory; this serves the page at /ask/<id> and, on a pick, types the
//! option number into the ONE surface the ask recorded, never one the request
//! names. Enter is sent only after the screen shows that number selected;
//! otherwise the page says which key to press. Verify, then commit.

use std::path::PathBuf;
use std::sync::Mutex;

use regex::Regex;
use serde_json::{json, Value};

use crew_core::pyjson;

use crate::cmux_cli::client;
use crate::plans::{realpath, slug_ok};
use crate::server::{local_time, log, plans_dir};

pub const ASK_JS: &str = include_str!("inject/ask.js");

pub fn asks_dir() -> PathBuf {
    plans_dir().join("asks")
}

/// An ask id to its .json or .html, or None: anchored, and inside asks/.
pub fn ask_path(ask_id: &str, ext: &str) -> Option<PathBuf> {
    if !slug_ok(ask_id) {
        return None;
    }
    let base = realpath(&asks_dir());
    let target = realpath(&asks_dir().join(format!("{ask_id}{ext}")));
    if !target.starts_with(&base) || target == base {
        return None;
    }
    target.is_file().then_some(target)
}

/// The one seam through which delivery touches cmux; the selftest swaps it.
pub trait Runner {
    /// (returncode, output) of a cmux verb: read-screen, send, send-key.
    fn run(&self, argv: &[&str]) -> (i32, String);
}

/// The real terminal, through crates/cmux's typed ops where there are some.
pub struct Cmux;

impl Runner for Cmux {
    fn run(&self, argv: &[&str]) -> (i32, String) {
        let Some(c) = client() else { return (1, "cmux is not reachable".into()) };
        let res = match argv {
            ["read-screen", "--surface", s, "--lines", n] => c.read_text(s, n.parse().ok()),
            ["send", "--surface", s, text] => c.send_text(s, text).map(|_| "OK".into()),
            _ => c.cli(argv).map(|o| format!("{}{}", o.stdout, o.stderr)),
        };
        match res {
            Ok(t) => (0, t),
            Err(e) => {
                crate::cmux_cli::failed();
                (1, e.to_string())
            }
        }
    }
}

/// Is the option label visible? Whitespace-insensitive: prompts wrap labels.
fn on_screen(label: &str, screen: &str) -> bool {
    let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    squash(screen).contains(&squash(label))
}

/// What the screen shows after the number: the prompt resolved to "→ label"
/// (CREW_ASK_RESOLVED_RE, %s = the label), or the pointer moved to n without
/// resolving (CREW_ASK_SELECTED_RE, %d = n).
/// A pattern built the Python's way (`pattern % value`: the first %s or %d
/// replaced, %% a literal %). The Rust regex crate has no lookaround, so an
/// override that does not compile is logged rather than silently never matching.
fn compile(name: &str, pat: &str, slot: &str, value: &str) -> Option<Regex> {
    let filled = pat.replacen(slot, value, 1).replace("%%", "%");
    match Regex::new(&filled) {
        Ok(r) => Some(r),
        Err(e) => {
            log(&format!("FAIL {name} does not compile as a Rust regex: {e}"));
            None
        }
    }
}

fn resolved_re(label: &str) -> Option<Regex> {
    let pat = std::env::var("CREW_ASK_RESOLVED_RE").ok().filter(|s| !s.is_empty())
        .unwrap_or_else(|| r"→\s*%s\s*$".into());
    compile("CREW_ASK_RESOLVED_RE", &pat, "%s", &regex::escape(label))
}

fn selected_re(n: u32) -> Option<Regex> {
    let pat = std::env::var("CREW_ASK_SELECTED_RE").ok().filter(|s| !s.is_empty())
        .unwrap_or_else(|| r"^\s*[❯›>]\s*%d[.)]".into());
    // re.match: anchored at the start of the line.
    let pat = if pat.starts_with('^') { pat } else { format!("^(?:{pat})") };
    compile("CREW_ASK_SELECTED_RE", &pat, "%d", &n.to_string())
}

/// Type option n into `surface` and prove it landed before claiming so.
pub fn deliver(surface: &str, n: u32, label: &str, runner: &dyn Runner) -> (bool, String) {
    if surface.is_empty() {
        return (false, format!("the ask recorded no terminal surface — press {n} in the terminal"));
    }
    // Look before typing: the number answers whatever prompt is showing.
    let (rc, screen) = runner.run(&["read-screen", "--surface", surface, "--lines", "60"]);
    if !label.is_empty() && (rc != 0 || !on_screen(label, &screen)) {
        return (false, format!("the terminal is not showing this question — switch to it, then press {n}"));
    }
    let (rc, out) = runner.run(&["send", "--surface", surface, &n.to_string()]);
    if rc != 0 {
        return (false, format!("cmux send failed ({}) — press {n} in the terminal", out.trim().chars().take(80).collect::<String>()));
    }
    let (rc, screen) = runner.run(&["read-screen", "--surface", surface, "--lines", "60"]);
    let lines: Vec<&str> = if rc == 0 { crew_core::py::splitlines(&screen) } else { Vec::new() };
    if !label.is_empty() {
        if let Some(re) = resolved_re(label) {
            if lines.iter().any(|l| re.is_match(l)) {
                return (true, format!("delivered {n} — the prompt took it"));
            }
        }
    }
    if let Some(re) = selected_re(n) {
        if lines.iter().any(|l| re.is_match(l)) {
            let (rc, out) = runner.run(&["send-key", "--surface", surface, "enter"]);
            if rc != 0 {
                return (false, format!("{n} is selected; Enter did not send ({}) — press Enter",
                                       out.trim().chars().take(80).collect::<String>()));
            }
            return (true, format!("delivered {n} — selected, then Enter"));
        }
    }
    (false, format!("typed {n} but could not confirm it on screen — check the terminal"))
}

// One answer at a time: a double submit must type the digit once.
static ANSWER: Mutex<()> = Mutex::new(());

/// Record and deliver one answer: (ok, delivered, detail).
pub fn answer(ask_id: &str, n_raw: &str, runner: &dyn Runner) -> (bool, bool, String) {
    let _held = ANSWER.lock().unwrap_or_else(|p| p.into_inner());
    let Some(jp) = ask_path(ask_id, ".json") else { return (false, false, "no such ask".into()) };
    let mut ask: Value = match std::fs::read_to_string(&jp).map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => return (false, false, format!("unreadable ask: {e}")),
    };
    if n_raw.is_empty() || !n_raw.chars().all(|c| c.is_ascii_digit()) {
        return (false, false, "bad option".into());
    }
    let n: u64 = n_raw.parse().unwrap_or(0);
    let options = ask.get("options").and_then(Value::as_array).cloned().unwrap_or_default();
    if n < 1 || n as usize > options.len() {
        return (false, false, format!("option {n} is not one of {}", options.len()));
    }
    if let Some(a) = ask.get("answer").filter(|a| crate::pyval::truthy(a)) {
        return (false, false, format!("already answered: {}", crate::pyval::py_str(a.get("n").unwrap_or(&json!(0)))));
    }
    let label = options[n as usize - 1].get("label").map(crate::pyval::str_or_empty).unwrap_or_default();
    let surface = ask.get("surface").map(crate::pyval::str_or_empty).unwrap_or_default();
    let (delivered, detail) = deliver(&surface, n as u32, &label, runner);
    if let Some(o) = ask.as_object_mut() {
        o.insert("answer".into(), json!({"n": n, "at": local_time("%Y-%m-%dT%H:%M:%S"), "delivered": delivered}));
    }
    if let Err(e) = std::fs::write(&jp, format!("{}\n", pyjson::dumps_indent(&ask, 2))) {
        return (false, delivered, format!("recorded nothing: {e}"));
    }
    log(&format!("ask {ask_id} answered {n} ({})", if delivered { "typed" } else { "shown" }));
    (true, delivered, detail)
}
