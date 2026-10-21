//! `crew-frame`: paint the focused pane's frame with the selected workspace's
//! own colour.
//!
//! ```text
//! crew-frame                     follow the selection (reloads only on change)
//! crew-frame --workspace <id>    use THAT workspace's colour (the listener
//!                                passes it from the event, dodging the lag
//!                                before `workspace list` reports a selection)
//! crew-frame --color #RRGGBB     force a hex
//! crew-frame --off               back to no border
//! crew-frame --status            what is set now, and what would be set
//! ```
//!
//! cmux's `activePaneBorderColor` is global, so following the workspace means
//! rewriting that one value on each switch and reloading, skipped when nothing
//! changed. The edit touches only that value, in place on the same inode
//! (cmux watches the path), so the comments `crew apply` rendered into
//! cmux.json survive. CREW_FRAME=0 turns it off.

use std::path::{Path, PathBuf};

use cmux::{Cmux, Transport};
use crew_core::py::expand_user;
use crew_core::pyjson;
use serde_json::{json, Value};

use crate::pyerr;
use crate::pyval::truthy;

const KEY: &str = "activePaneBorderColor";

fn cmux_json() -> PathBuf {
    expand_user("~/.config/cmux/cmux.json")
}

pub fn main(args: &[String]) -> i32 {
    let after = |flag: &str| -> Result<Option<String>, i32> {
        match args.iter().position(|a| a == flag) {
            None => Ok(None),
            Some(i) => args
                .get(i + 1)
                .cloned()
                .map(Some)
                .ok_or_else(|| pyerr::crash("IndexError: list index out of range")),
        }
    };
    let has = |flag: &str| args.iter().any(|a| a == flag);
    // An empty id is no id, as Python's `if wsid` reads it: follow the selection.
    let wsid = match after("--workspace") {
        Ok(w) => w.filter(|w| !w.is_empty()),
        Err(code) => return code,
    };
    let path = cmux_json();
    if has("--status") {
        let set = match current(&path) {
            Ok(v) => v.map(Value::String).unwrap_or(Value::Null),
            Err(m) => return pyerr::crash(&m),
        };
        let v = json!({
            "set": set,
            "selected_workspace_color": selected_color(wsid.as_deref()),
            "config": path.to_string_lossy(),
        });
        println!("{}", pyjson::dumps_indent(&v, 2));
        return 0;
    }
    if std::env::var("CREW_FRAME").as_deref() == Ok("0") {
        return 0; // kill switch, for a machine that hates it
    }
    let want = if has("--off") {
        "null".to_string()
    } else if has("--color") {
        let want = match after("--color") {
            Ok(w) => w.unwrap_or_default(),
            Err(code) => return code,
        };
        if !is_hex(&want) {
            eprintln!("crew-frame: --color needs #RRGGBB");
            return 2;
        }
        want
    } else {
        Some(selected_color(wsid.as_deref())).filter(|c| !c.is_empty()).unwrap_or_else(|| "null".into())
    };
    let now = match current(&path) {
        Ok(Some(now)) => now,
        Ok(None) => {
            eprintln!("crew-frame: {KEY} is not in cmux.json — run: crew apply");
            return 1;
        }
        Err(m) => return pyerr::crash(&m),
    };
    // Switching between two worktrees that share a colour touches nothing.
    if now == want {
        return 0;
    }
    match write(&path, &want) {
        Ok(true) => reload(),
        Ok(false) => {}
        Err(m) => return pyerr::crash(&m),
    }
    0
}

/// Python's `re.match(r"^#[0-9A-Fa-f]{6}$", s)`: `$` also matches before one
/// trailing newline.
fn is_hex(s: &str) -> bool {
    let s = s.strip_suffix('\n').unwrap_or(s);
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The first `"activePaneBorderColor": null|"#RRGGBB"` in `src`: the byte range
/// of the value, and the value as the Python reports it (`null` or the hex).
fn find(src: &str) -> Option<(usize, usize, String)> {
    let needle = format!("\"{KEY}\"");
    let mut from = 0;
    while let Some(at) = src[from..].find(&needle) {
        let start = from + at;
        from = start + 1;
        let rest = &src[start + needle.len()..];
        let rest_t = rest.trim_start_matches(char::is_whitespace);
        let Some(rest_c) = rest_t.strip_prefix(':') else { continue };
        let val = rest_c.trim_start_matches(char::is_whitespace);
        let vstart = src.len() - val.len();
        if val.starts_with("null") {
            return Some((vstart, vstart + 4, "null".into()));
        }
        let b = val.as_bytes();
        if b.len() >= 9 && b[0] == b'"' && b[1] == b'#' && b[2..8].iter().all(u8::is_ascii_hexdigit) && b[8] == b'"' {
            return Some((vstart, vstart + 9, val[1..8].to_string()));
        }
    }
    None
}

/// `open(path).read()` in text mode: None on an OSError, newlines translated
/// (CRLF and a lone CR read as LF, so the rewrite writes LF, as Python's
/// does), and Err where Python raises UnicodeDecodeError.
fn read_text(path: &Path) -> Result<Option<String>, String> {
    let Ok(bytes) = std::fs::read(path) else { return Ok(None) };
    let text = String::from_utf8(bytes)
        .map_err(|e| format!("UnicodeDecodeError: {}", pyerr::decode_error(&e.utf8_error(), e.as_bytes())))?;
    Ok(Some(if text.contains('\r') { text.replace("\r\n", "\n").replace('\r', "\n") } else { text }))
}

/// The hex in cmux.json, "null", or None when the key is missing or unreadable.
fn current(path: &Path) -> Result<Option<String>, String> {
    Ok(read_text(path)?.and_then(|src| find(&src).map(|(_, _, v)| v)))
}

/// custom_color for `wsid`, or for whichever workspace reports itself selected;
/// "" when cmux does not answer.
fn selected_color(wsid: Option<&str>) -> String {
    let Ok(c) = Cmux::connect() else { return String::new() };
    let Ok(list) = c.workspace_list(None) else { return String::new() };
    let workspaces = list.get("workspaces").and_then(Value::as_array).cloned().unwrap_or_default();
    for w in &workspaces {
        let hit = match wsid {
            Some(id) => w.get("id").and_then(Value::as_str) == Some(id),
            None => truthy(w.get("selected")),
        };
        if hit {
            return w.get("custom_color").and_then(Value::as_str).unwrap_or("").trim().to_string();
        }
    }
    String::new()
}

/// Replace the one value in place. True when the file changed.
fn write(path: &Path, value: &str) -> Result<bool, String> {
    let Some(src) = read_text(path)? else { return Ok(false) };
    let Some((a, b, _)) = find(&src) else {
        eprintln!("crew-frame: {KEY} is not in cmux.json — run: crew apply");
        return Ok(false);
    };
    let repl = if value.is_empty() || value == "null" { "null".to_string() } else { format!("\"{value}\"") };
    let new = format!("{}{}{}", &src[..a], repl, &src[b..]);
    if new == src {
        return Ok(false);
    }
    // Same-inode rewrite, not temp-and-rename: a replaced inode is a deleted
    // file to a watcher holding the old one.
    std::fs::write(path, new).map(|_| true).map_err(|e| pyerr::os_error(&e, path))
}

/// `cmux reload-config`, always through the CLI, as the Python runs it.
fn reload() {
    if let Ok(bin) = cmux::resolve_cli_bin() {
        if let Ok(c) = Cmux::open(Transport::Cli(bin)) {
            let _ = c.reload_config();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_value_past_comments_and_spacing() {
        let src = "{\n  // \"activePaneBorderColor\" is global\n  \"activePaneBorderColor\" :\n   \"#1565c0\", \"x\": 1\n}";
        let (a, b, v) = find(src).unwrap();
        assert_eq!(v, "#1565c0");
        assert_eq!(&src[a..b], "\"#1565c0\"");
        let src = "{\"activePaneBorderColor\": null}";
        assert_eq!(find(src).unwrap().2, "null");
        assert!(find("{\"activePaneBorderColor\": \"blue\"}").is_none());
        assert!(find("{}").is_none());
    }

    #[test]
    fn hex_takes_a_trailing_newline_as_python_does() {
        assert!(is_hex("#A1b2C3"));
        assert!(is_hex("#a1b2c3\n"));
        assert!(!is_hex("#a1b2c"));
        assert!(!is_hex("blue"));
    }

    #[test]
    fn write_keeps_comments_and_reports_no_change() {
        let d = std::env::temp_dir().join(format!("crew-cli-frame-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("cmux.json");
        let src = "{\n  // keep me\n  \"activePaneBorderColor\": null, // and me\n}\n";
        std::fs::write(&p, src).unwrap();
        assert_eq!(write(&p, "#1565C0"), Ok(true));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), src.replace("null", "\"#1565C0\""));
        assert_eq!(write(&p, "#1565C0"), Ok(false));
        assert_eq!(write(&p, "null"), Ok(true));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), src);
        // CRLF reads as LF and the rewrite writes LF, as Python's text mode does.
        std::fs::write(&p, src.replace('\n', "\r\n")).unwrap();
        assert_eq!(write(&p, "#1565C0"), Ok(true));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), src.replace("null", "\"#1565C0\""));
        let _ = std::fs::remove_dir_all(&d);
    }
}
