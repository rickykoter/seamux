//! `seamux merge_settings`: crew/claude/merge_settings.py in Rust. Points
//! Claude's status line at crew's and turns on the phone pushes.
//!
//! ```text
//! seamux merge_settings [--dry-run] [--settings PATH] [--remove]
//! ```
//!
//! The status line it writes is `python3 <crew>/claude/statusline.py`, the
//! Python's command, for as long as that file exists. Once the cutover has
//! deleted it, the same run writes `<seamux> statusline` instead, and either
//! spelling counts as crew's own for repointing and --remove. `<crew>` is crew-core's crew home, resolved through
//! symlinks as the Python resolves its own file. Same printed lines, same
//! backup names, same bytes written.

use std::path::{Path, PathBuf};

use crew_core::py::home;
use serde_json::{json, Map, Value};

use crate::pyval::{self, truthy};

struct Paths {
    statusline: String,
    legacy: String,
    command: String,
    /// No status line to point at: neither statusline.py nor a seamux.
    missing: bool,
}

/// The status line command. While crew/claude/statusline.py exists it is
/// the Python's, byte for byte. Once the cutover has deleted it, it is
/// `<seamux> statusline`: the ~/.local/bin link when there is one (a path
/// that survives upgrades), else this executable.
fn paths() -> Paths {
    let claude = crew_core::crew_home().join("claude");
    let claude = std::fs::canonicalize(&claude).unwrap_or(claude);
    let statusline = claude.join("statusline.py").to_string_lossy().into_owned();
    let legacy = home().join(".claude/statusline.py").to_string_lossy().into_owned();
    if Path::new(&statusline).exists() {
        return Paths { command: format!("python3 {statusline}"), legacy, statusline, missing: false };
    }
    let link = home().join(".local/bin/seamux");
    let seamux = if crate::spawn::is_executable(&link) { Some(link) } else { std::env::current_exe().ok() };
    match seamux {
        Some(s) => Paths { command: format!("{} statusline", s.display()), legacy, statusline, missing: false },
        None => Paths { command: format!("python3 {statusline}"), legacy, statusline, missing: true },
    }
}

/// Is this status line one crew set (here, or the old installer's)?
fn ours(p: &Paths, status_line: &Value) -> bool {
    let empty = Value::Object(Map::new());
    let text = pyval::dumps(if truthy(status_line) { status_line } else { &empty }, None);
    text.contains(&p.statusline)
        || text.contains(&p.legacy)
        || text.contains("/crew/claude/statusline.py")
        || text.contains("seamux statusline")
}

fn crash(msg: &str) -> i32 {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    eprintln!("Traceback (most recent call last):\n  File \"merge_settings.py\"\n{msg}");
    1
}

fn write_json(path: &Path, s: &Map<String, Value>) -> std::io::Result<()> {
    std::fs::write(path, pyval::dumps(&Value::Object(s.clone()), Some(2)) + "\n")
}

fn basename(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn os_crash(e: &std::io::Error, p: &Path) -> i32 {
    crash(&crew_core::py::os_error(e, p))
}

pub fn main(args: &[String]) -> i32 {
    let has = |f: &str| args.iter().any(|a| a == f);
    let dry = has("--dry-run");
    let mut path = home().join(".claude/settings.json");
    if let Some(i) = args.iter().position(|a| a == "--settings") {
        match args.get(i + 1) {
            Some(p) => path = PathBuf::from(p),
            None => return crash("IndexError: list index out of range"),
        }
    }
    let p = paths();

    let mut s = Map::new();
    if path.exists() {
        let text = match pyval::read_text(&path) {
            Ok(Ok(t)) => t,
            Ok(Err(decode)) => return crash(&format!("UnicodeDecodeError: {decode}")),
            Err(e) => return os_crash(&e, &path),
        };
        match pyval::loads(&text) {
            Ok(Value::Object(o)) => s = o,
            Ok(other) => {
                return crash(&format!("AttributeError: '{}' object has no attribute 'get'", pyval::type_name(&other)));
            }
            Err(m) => return crash(&format!("json.decoder.JSONDecodeError: {m}")),
        }
    }

    let mut changes: Vec<String> = Vec::new();

    if has("--remove") {
        if s.get("statusLine").is_some_and(|v| truthy(v) && ours(&p, v)) {
            s.shift_remove("statusLine");
            changes.push("removed: statusLine".into());
        }
        if changes.is_empty() {
            println!("  nothing of ours found in {}", path.display());
        }
        for c in &changes {
            println!("  {c}");
        }
        if dry {
            println!("\n--dry-run: nothing written");
        } else if !changes.is_empty() {
            let bak = PathBuf::from(format!("{}.pre-uninstall.{}.bak", path.display(), pyval::stamp()));
            if let Err(e) = pyval::copy2(&path, &bak) {
                return os_crash(&e, &path);
            }
            if let Err(e) = write_json(&path, &s) {
                return os_crash(&e, &path);
            }
            println!("\nbacked up -> {}, wrote {}", basename(&bak), path.display());
        }
        return 0;
    }

    let current = s.get("statusLine").cloned().unwrap_or(Value::Null);
    if p.missing {
        changes.push(format!("SKIPPED: no {}", p.statusline));
    } else if !truthy(&current) {
        s.insert("statusLine".into(), json!({"type": "command", "command": p.command}));
        changes.push("statusLine -> crew's statusline.py".into());
    } else {
        let Value::Object(cur) = &current else {
            return crash(&format!("AttributeError: '{}' object has no attribute 'get'", pyval::type_name(&current)));
        };
        if cur.get("command").and_then(Value::as_str) == Some(p.command.as_str()) {
            changes.push("already set: statusLine".into());
        } else if ours(&p, &current) {
            let mut repointed = cur.clone();
            repointed.insert("type".into(), json!("command"));
            repointed.insert("command".into(), json!(p.command));
            s.insert("statusLine".into(), Value::Object(repointed));
            changes.push("statusLine -> crew's statusline.py (repointed from the old copy)".into());
        } else {
            changes.push(format!(
                "LEFT ALONE: you already have a status line — set it to `{}` by hand if you want this one",
                p.command
            ));
        }
    }

    // Phone pushes for the board's "attend" tier. Only ever set to true when
    // absent; an explicit false is the user's choice.
    for key in ["agentPushNotifEnabled", "inputNeededNotifEnabled"] {
        if !s.contains_key(key) {
            s.insert(key.into(), json!(true));
            changes.push(format!("{key} -> true (phone push via Remote Control)"));
        } else {
            changes.push(format!("already set: {key}"));
        }
    }

    for c in &changes {
        println!("  {c}");
    }

    let wrote = changes.iter().any(|c| {
        c.starts_with("statusLine ->") || c.starts_with("agentPushNotifEnabled ->") || c.starts_with("inputNeededNotifEnabled ->")
    });
    if dry {
        println!("\n--dry-run: nothing written");
    } else if wrote {
        if path.exists() {
            let bak = PathBuf::from(format!("{}.pre-crew-dock.{}.bak", path.display(), pyval::stamp()));
            if let Err(e) = pyval::copy2(&path, &bak) {
                return os_crash(&e, &path);
            }
            println!("\nbacked up -> {}", basename(&bak));
        }
        let dir = path.parent().unwrap_or(Path::new(""));
        if dir.as_os_str().is_empty() {
            // os.makedirs("") raises
            return crash("FileNotFoundError: [Errno 2] No such file or directory: ''");
        }
        if let Err(e) = std::fs::create_dir_all(dir) {
            return os_crash(&e, dir);
        }
        if let Err(e) = write_json(&path, &s) {
            return os_crash(&e, &path);
        }
        println!("wrote {}", path.display());
        println!("New Claude sessions pick these up; existing ones do not.");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ours_matches_the_three_spellings() {
        let p = Paths {
            statusline: "/a/crew/claude/statusline.py".into(),
            legacy: "/h/.claude/statusline.py".into(),
            command: String::new(),
            missing: false,
        };
        assert!(ours(&p, &json!({"command": "/h/.local/bin/seamux statusline"})));
        assert!(ours(&p, &json!({"command": "python3 /h/.claude/statusline.py"})));
        assert!(ours(&p, &json!({"command": "python3 /elsewhere/crew/claude/statusline.py"})));
        assert!(!ours(&p, &json!({"command": "ccusage statusline"})));
    }
}
