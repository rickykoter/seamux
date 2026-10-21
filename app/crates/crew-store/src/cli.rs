//! `seamux crew-artifacts`: crew/bin/crew-artifacts, byte for byte.
//!
//!   index | backfill | search <q> [--ws <cwd>] [--kind <k>] [--json] | keep <id>
//!
//! plus what only the Rust has, so the artifacts probe can drive this crate
//! where it calls the Python module in-process (the Python CLI is unchanged):
//!
//!   search ... --limit N        the module's limit (the CLI's default is 500)
//!   keep <id> --json            the result as the module returns it
//!   keep-all <ws> [--json]      keep_all(ws)
//!   row <id>                    row(id) as JSON, or null
//!   workspaces                  workspaces() as JSON

use crate::paths::{expanduser, realpath};
use crate::{keep, read, KeepResult};
use crew_core::pyjson::dumps_indent;
use serde_json::Value;
use std::io::Write;

const USAGE: &str = "    crew-artifacts index                       rescan changed transcripts (the Stop hook runs this)\n    crew-artifacts backfill                    index every transcript from the start\n    crew-artifacts search <q> [--ws <cwd>] [--kind <k>] [--json]\n    crew-artifacts keep <id>                   copy an at-risk temp file into ~/.claude/crew/kept/";

/// The Python's `take(args, flag)`: remove the flag and its value; a flag
/// with no value is removed and gives None.
fn take(args: &mut Vec<String>, flag: &str) -> Option<String> {
    let i = args.iter().position(|a| a == flag)?;
    if i + 1 < args.len() {
        let v = args.remove(i + 1);
        args.remove(i);
        Some(v)
    } else {
        args.remove(i);
        None
    }
}

/// `list.remove(x)` when present: true if it was there.
fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    match args.iter().position(|a| a == flag) {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    }
}

/// The store's UTC ISO time as this machine's local `YYYY-MM-DD HH:MM`.
pub fn local(iso: &str) -> String {
    let fallback = || crate::py_prefix(iso, 16).replace('T', " ");
    let b = iso.as_bytes();
    if b.len() < 19 {
        return fallback();
    }
    let num = |a: usize, z: usize| -> Option<i64> {
        let s = std::str::from_utf8(&b[a..z]).ok()?;
        if s.bytes().all(|c| c.is_ascii_digit()) { s.parse().ok() } else { None }
    };
    let parts = (|| {
        if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
            return None;
        }
        let (y, mo, d, h, mi, s) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
        // strptime refuses a day the month does not have (Feb 30, Apr 31).
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let days = match mo {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if !(1..=12).contains(&mo) || d < 1 || d > days || h > 23 || mi > 59 || s > 61 {
            return None;
        }
        Some((y, mo, d, h, mi, s))
    })();
    let Some((y, mo, d, h, mi, s)) = parts else { return fallback() };
    let t = crew_core::py::days_from_civil(y, mo as u32, d as u32) * 86400 + h * 3600 + mi * 60 + s;
    // SAFETY: localtime_r writes into tm, which lives on this frame.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        let tt = t as libc::time_t;
        if libc::localtime_r(&tt, &mut tm).is_null() {
            return fallback();
        }
        tm
    };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        tm.tm_year as i64 + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min
    )
}

/// `"%-Nd"` / `"%-Ns"`: left-justified to N characters.
fn ljust(s: &str, n: usize) -> String {
    let len = s.chars().count();
    if len >= n {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(n - len))
    }
}

/// One row as `crew-artifacts search` prints it.
pub fn line(r: &read::Row) -> String {
    let when = local(&r.created_at);
    let place = [&r.url, &r.path, &r.sha].into_iter().find(|x| !x.is_empty()).cloned().unwrap_or_default();
    let mut out = format!("{} {}  {} {}", ljust(&r.id.to_string(), 5), when, ljust(&r.kind, 8), r.title);
    if !place.is_empty() && place != r.title {
        out += "\n      ";
        out += &place;
    }
    if !r.prompt.is_empty() {
        out += "\n      > ";
        out += crate::py_prefix(&r.prompt, 160);
    }
    out
}

fn print_json(v: &Value) {
    let mut o = std::io::stdout().lock();
    let _ = o.write_all(dumps_indent(v, 1).as_bytes());
    let _ = o.write_all(b"\n");
}

fn fail(e: impl std::fmt::Display) -> i32 {
    eprintln!("crew-artifacts: {e}");
    1
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())
}

/// `seamux crew-artifacts <args>`: the exit code, output written here.
pub fn main(argv: &[String]) -> i32 {
    let mut args: Vec<String> = argv.to_vec();
    let cmd = if args.is_empty() { String::new() } else { args.remove(0) };
    match cmd.as_str() {
        "index" | "backfill" => {
            eprintln!("crew-artifacts: {cmd} is not ported to seamux yet (the indexer is port-store increment 2)");
            1
        }
        "search" => {
            let as_json = take_flag(&mut args, "--json");
            let ws = take(&mut args, "--ws");
            let kind = take(&mut args, "--kind");
            let limit = match take(&mut args, "--limit") {
                None => 500,
                Some(v) if is_digits(&v) => v.parse().unwrap_or(500),
                Some(_) => {
                    eprintln!("usage: crew-artifacts search <q> [--ws <cwd>] [--kind <k>] [--json] [--limit N]");
                    return 2;
                }
            };
            let ws = ws.filter(|w| !w.is_empty()).map(|w| realpath(&expanduser(&w)));
            let q = args.join(" ");
            let rows = match read::search(&q, ws.as_deref(), kind.as_deref(), limit) {
                Ok(r) => r,
                Err(e) => return fail(e),
            };
            if as_json {
                print_json(&Value::Array(rows.iter().map(|r| r.to_json()).collect()));
            } else {
                let mut o = std::io::stdout().lock();
                for r in &rows {
                    let _ = writeln!(o, "{}", line(r));
                }
                if rows.is_empty() {
                    let _ = writeln!(o, "no rows");
                }
            }
            0
        }
        "keep" => {
            let as_json = take_flag(&mut args, "--json");
            if args.is_empty() || !is_digits(&args[0]) {
                eprintln!("usage: crew-artifacts keep <id>");
                return 2;
            }
            let id: i64 = match args[0].parse() {
                Ok(n) => n,
                Err(_) => return fail("id out of range"),
            };
            let res: KeepResult = match keep::keep(id) {
                Ok(r) => r,
                Err(e) => return fail(e),
            };
            if as_json {
                print_json(&res.to_json());
            } else if res.ok {
                println!("kept -> {}", res.path.as_deref().unwrap_or(""));
            } else {
                eprintln!("refused: {}", res.why.as_deref().unwrap_or("unknown"));
            }
            if res.ok { 0 } else { 1 }
        }
        "keep-all" => {
            take_flag(&mut args, "--json");
            let Some(ws) = args.first().filter(|w| !w.is_empty()) else {
                eprintln!("usage: crew-artifacts keep-all <ws> [--json]");
                return 2;
            };
            match keep::keep_all(ws) {
                Ok(v) => {
                    print_json(&Value::Array(v.iter().map(|r| r.to_json()).collect()));
                    0
                }
                Err(e) => fail(e),
            }
        }
        "row" => {
            let Some(id) = args.first().filter(|a| is_digits(a)).and_then(|a| a.parse::<i64>().ok()) else {
                eprintln!("usage: crew-artifacts row <id>");
                return 2;
            };
            match read::row(id) {
                Ok(r) => {
                    print_json(&r.map(|r| r.to_json()).unwrap_or(Value::Null));
                    0
                }
                Err(e) => fail(e),
            }
        }
        "workspaces" => match read::workspaces() {
            Ok(v) => {
                print_json(&Value::Array(v.iter().map(|w| w.to_json()).collect()));
                0
            }
            Err(e) => fail(e),
        },
        _ => {
            println!("{USAGE}");
            if matches!(cmd.as_str(), "-h" | "--help" | "help") { 0 } else { 2 }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_like_python() {
        let mut a: Vec<String> = ["x", "--ws", "/w", "y", "--kind"].iter().map(|s| s.to_string()).collect();
        assert_eq!(take(&mut a, "--ws").as_deref(), Some("/w"));
        assert_eq!(take(&mut a, "--kind"), None);
        assert_eq!(a, vec!["x", "y"]);
    }

    #[test]
    fn local_falls_back_like_python() {
        assert_eq!(local(""), "");
        assert_eq!(local("garbageTtext-here"), "garbage text-her");
        assert_eq!(local("2020-13-01T00:00:00.000Z"), "2020-13-01 00:00");
        assert_eq!(local("2021-02-29T10:00:00.000Z"), "2021-02-29 10:00");
        assert_eq!(local("2021-04-31T10:00:00.000Z"), "2021-04-31 10:00");    }

    #[test]
    fn line_shape() {
        let r = read::Row {
            id: 7, ws: "/w".into(), repo: "".into(), kind: "doc".into(), title: "a.md".into(),
            locator: "/w/a.md".into(), path: "/w/a.md".into(), url: "".into(), sha: "".into(),
            was_path: "".into(), created_at: "".into(), updated_at: "".into(), session_id: "".into(),
            branch: "".into(), prompt: "p".repeat(200), source: "".into(), kept_at: None,
        };
        let l = line(&r);
        // "%-5d %s  %-8s %s" with an empty time: "7" + 4 + 1 + 2 spaces.
        assert!(l.starts_with("7       doc      a.md\n      /w/a.md\n      > "), "{l:?}");
        assert_eq!(l.lines().last().unwrap().len(), 8 + 160);
    }
}
