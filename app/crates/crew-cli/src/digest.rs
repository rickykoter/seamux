//! `crew-digest`: what happened while you were away.
//!
//! ```text
//! crew-digest              since 17:00 yesterday (the overnight window)
//! crew-digest --hours 4    an arbitrary lookback
//! crew-digest --week       since Monday
//! crew-digest --notify     also post a one-line summary as a notification
//! crew-digest --paragraph  only where things stand, as one plain paragraph
//! ```
//!
//! Every section degrades to silence rather than failing the run: the board's
//! news (crew-board state), commits across the main checkout and its
//! worktrees, PRs from gh, sessions still waiting, and worktrees that shipped.
//! Times are naive local wall-clock, as the Python's datetime.now() is.

use std::time::Duration;

use cmux::{Cmux, Notify};
use crew_core::py::{civil_from_days, days_from_civil, percent_g, splitlines};
use serde_json::Value;

use crate::pypath::{basename, join};
use crate::pyval::{head, py_str, py_strip, truthy};
use crate::{proc, sibling};

const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const RESET: &str = "\x1b[0m";
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const AMBER: &str = "\x1b[33m";
const VIOLET: &str = "\x1b[35m";

/// `sh()`: stdout when the command ran and exited 0, else "".
fn sh(argv: &[&str], cwd: Option<&str>, timeout: u64) -> String {
    match proc::run(argv, cwd, &[], Some(Duration::from_secs(timeout))) {
        // text=True: output that is not UTF-8 raises, and sh() gives ""
        Some(o) if o.code == 0 && o.utf8 => o.stdout,
        _ => String::new(),
    }
}

/// The repo the digest reports on: CREW_MONOLITH, else the one `crew apply`
/// baked into the crew home's bin/crew, else the placeholder (nothing found).
fn main_repo() -> String {
    if let Ok(m) = std::env::var("CREW_MONOLITH") {
        return m;
    }
    let crew = sibling::home_path("bin/crew");
    if let Ok(text) = std::fs::read_to_string(crew) {
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("MONOLITH=\"${CREW_MONOLITH:-").and_then(|r| r.strip_suffix("}\"")) {
                return v.to_string();
            }
        }
    }
    concat!("__MAIN_", "REPO__").to_string()
}

/// The board's news ({hours, lede, items}) from `crew-board state --fast --json`.
fn board_news() -> Option<Value> {
    let mut argv: Vec<String> = match sibling::own("crew-board") {
        Some(h) => h,
        None => vec![sibling::home_path("board/crew-board").to_string_lossy().into_owned()],
    };
    argv.extend(["state", "--fast", "--json"].map(String::from));
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let out = sh(&refs, None, 30);
    let v: Value = serde_json::from_str(&out).ok()?;
    let news = v.get("news").filter(|n| truthy(Some(n)))?.clone();
    truthy(news.get("items")).then_some(news)
}

fn plain(text: &str) -> String {
    text.replace("{{", "").replace("}}", "").replace('`', "")
}

fn text_of(it: &Value) -> String {
    it.get("text").map(py_str).unwrap_or_default()
}

// --- naive local time ------------------------------------------------------------

/// A naive local datetime as microseconds since 1970-01-01T00:00 wall time.
type Naive = i128;

const US: i128 = 1_000_000;
const DAY: i128 = 86_400 * US;

fn now_local() -> Naive {
    let now = crew_core::py::now();
    let secs = now.floor() as libc::time_t;
    let micros = ((now - now.floor()) * 1e6) as i128;
    // SAFETY: localtime_r fills tm, which we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    let days = days_from_civil(tm.tm_year as i64 + 1900, tm.tm_mon as u32 + 1, tm.tm_mday as u32) as i128;
    days * DAY + ((tm.tm_hour * 3600 + tm.tm_min * 60 + tm.tm_sec) as i128) * US + micros
}

fn parts(t: Naive) -> (i64, u32, u32, i128, i128, i128, i128) {
    let days = t.div_euclid(DAY);
    let rem = t.rem_euclid(DAY);
    let (y, m, d) = civil_from_days(days as i64);
    (y, m, d, rem / (3600 * US), rem / (60 * US) % 60, rem / US % 60, rem % US)
}

/// `datetime.isoformat()`: microseconds only when there are some.
fn isoformat(t: Naive) -> String {
    let (y, m, d, h, mi, s, us) = parts(t);
    let mut out = format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}");
    if us != 0 {
        out.push_str(&format!(".{us:06}"));
    }
    out
}

fn weekday(t: Naive) -> usize {
    // 1970-01-01 was a Thursday; 0 is Monday, as datetime.weekday() counts.
    (t.div_euclid(DAY) + 3).rem_euclid(7) as usize
}

/// Python's `float(s)`: decimal, exponent, inf and nan, underscores between digits.
fn py_float(s: &str) -> Option<f64> {
    let t = py_strip(s);
    let b = t.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if c == b'_' && !(i > 0 && b[i - 1].is_ascii_digit() && b.get(i + 1).is_some_and(u8::is_ascii_digit)) {
            return None;
        }
    }
    let t = t.replace('_', "");
    let lower = t.to_ascii_lowercase();
    let body = lower.trim_start_matches(['+', '-']);
    if ["inf", "infinity", "nan"].contains(&body) {
        return t.parse::<f64>().ok().or_else(|| if lower.starts_with('-') { Some(f64::NEG_INFINITY) } else { Some(f64::INFINITY) });
    }
    if !body.bytes().all(|c| c.is_ascii_digit() || b".eE+-".contains(&c)) || body.is_empty() {
        return None;
    }
    t.parse().ok()
}

/// The window's start and its label.
fn window(args: &[String]) -> (Naive, String) {
    let now = now_local();
    if args.iter().any(|a| a == "--week") {
        let start = (now.div_euclid(DAY) - weekday(now) as i128) * DAY;
        return (start, "this week".into());
    }
    if let Some(i) = args.iter().position(|a| a == "--hours") {
        if let Some(h) = args.get(i + 1).and_then(|a| py_float(a)) {
            // timedelta(hours=h) rounds to the microsecond; out of datetime's
            // range (or not finite) Python raises, and the overnight window holds.
            let us = (h * 3_600_000_000.0).round_ties_even();
            let min = days_from_civil(1, 1, 1) as i128 * DAY;
            let max = (days_from_civil(9999, 12, 31) as i128 + 1) * DAY;
            if us.is_finite() && us.abs() < 1e18 {
                let start = now - us as i128;
                if (min..max).contains(&start) {
                    return (start, format!("the last {}h", percent_g(h)));
                }
            }
        }
    }
    let mut cut = now.div_euclid(DAY) * DAY + 17 * 3600 * US;
    if parts(now).3 < 17 {
        cut -= DAY;
    }
    let names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let (_, _, _, h, mi, _, _) = parts(cut);
    (cut, format!("since {} {h:02}:{mi:02}", names[weekday(cut)]))
}

// --- git --------------------------------------------------------------------------

/// The main checkout plus every worktree git knows about.
fn worktrees(main: &str) -> Vec<String> {
    let mut out = vec![main.to_string()];
    for line in splitlines(&sh(&["git", "-C", main, "worktree", "list", "--porcelain"], None, 30)) {
        if let Some(p) = line.strip_prefix("worktree ") {
            if !out.iter().any(|o| o == p) && std::path::Path::new(p).is_dir() {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// One `git log --all` for the repository, grouped by the ref on each commit.
fn commits_by_branch(main: &str, since: &str, me: &str) -> Vec<(String, Vec<(String, String)>)> {
    let since = format!("--since={since}");
    let author = format!("--author={me}");
    let log = sh(&["git", "-C", main, "log", "--all", "--no-merges", &since, &author, "--pretty=%h\t%D\t%s"], None, 60);
    let mut groups: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in splitlines(&log) {
        let p: Vec<&str> = line.splitn(3, '\t').collect();
        if p.len() < 3 {
            continue;
        }
        let names: Vec<String> = p[1]
            .split(',')
            .filter(|r| !py_strip(r).is_empty())
            .map(|r| py_strip(r).replace("HEAD -> ", ""))
            .filter(|n| !n.is_empty() && !n.starts_with("tag:") && n != "HEAD")
            .collect();
        let local: Vec<&String> = names.iter().filter(|n| !n.starts_with("origin/")).collect();
        let branch = local.first().map(|s| s.to_string()).or_else(|| names.first().cloned()).unwrap_or_else(|| "(no ref)".into());
        let entry = (p[0].to_string(), p[2].to_string());
        match groups.iter_mut().find(|(b, _)| *b == branch) {
            Some(g) => g.1.push(entry),
            None => groups.push((branch, vec![entry])),
        }
    }
    groups
}

fn bad_checks(pr: &Value) -> Option<Vec<Value>> {
    let roll = match pr.get("statusCheckRollup") {
        Some(Value::Array(a)) => a.clone(),
        Some(v) if truthy(Some(v)) => return None,
        _ => vec![],
    };
    let mut bad = Vec::new();
    pr.as_object()?;
    for c in roll {
        c.as_object()?; // c.get on anything else raises
        let v = ["conclusion", "state"].iter().find_map(|k| c.get(*k).filter(|x| truthy(Some(x))));
        let verdict = match v {
            None => String::new(),
            Some(Value::String(s)) => s.to_uppercase(),
            Some(_) => return None,
        };
        if ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR"].contains(&verdict.as_str()) {
            bad.push(c);
        }
    }
    Some(bad)
}

/// `pr['k']`: None where the Python's KeyError would stop the section.
fn key(pr: &Value, k: &str) -> Option<String> {
    pr.get(k).map(py_str)
}

/// `pr['title']`, sliced: only a string slices (None or a number raises).
fn title(pr: &Value) -> Option<String> {
    pr.get("title").and_then(Value::as_str).map(String::from)
}

/// `f"{s[:n]:n}"`: cut and pad to n characters.
fn cell(s: &str, n: usize) -> String {
    format!("{:<n$}", head(s, n))
}

fn run(args: &[String]) -> i32 {
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--paragraph") {
        let Some(news) = board_news() else { return 1 };
        let items = news["items"].as_array().cloned().unwrap_or_default();
        println!("{}", items.iter().map(|it| plain(&text_of(it))).collect::<Vec<_>>().join(" "));
        return 0;
    }
    let main = main_repo();
    let (start, label) = window(args);
    let since_iso = isoformat(start);
    let notify = has("--notify");
    let me = {
        let a = py_strip(&sh(&["git", "-C", &main, "config", "user.email"], None, 30)).to_string();
        if a.is_empty() {
            py_strip(&sh(&["git", "config", "user.email"], None, 30)).to_string()
        } else {
            a
        }
    };
    println!("\n{BOLD}crew digest{RESET}  {DIM}{label}{RESET}\n");

    // --- where things stand -----------------------------------------------------
    if let Some(news) = board_news() {
        let hours = news.get("hours").and_then(Value::as_f64).unwrap_or(5.0);
        println!("{BOLD}where things stand{RESET}  {DIM}commits: last {}h{RESET}", percent_g(hours));
        for it in news["items"].as_array().cloned().unwrap_or_default() {
            let text = text_of(&it).replace("{{", BOLD).replace("}}", RESET).replace('`', "");
            let ink = match it.get("tier").and_then(Value::as_str) {
                Some("attend") => AMBER,
                Some("wilt") => RED,
                Some("running") => "\x1b[36m",
                Some("done") => GREEN,
                _ => DIM,
            };
            println!("  {ink}●{RESET} {text}");
        }
        println!();
    }

    // --- commits ------------------------------------------------------------------
    let trees = worktrees(&main);
    let mut per_tree = commits_by_branch(&main, &since_iso, &me);
    let total: usize = per_tree.iter().map(|(_, r)| r.len()).sum();
    if total > 0 {
        println!("{BOLD}{GREEN}✓ {total} commit(s){RESET}");
        per_tree.sort_by_key(|(_, r)| std::cmp::Reverse(r.len()));
        for (br, rows) in &per_tree {
            println!("  {DIM}{br}{RESET}");
            for (h, subj) in rows.iter().take(6) {
                println!("    {AMBER}{h}{RESET}  {}", head(subj, 76));
            }
            if rows.len() > 6 {
                println!("    {DIM}… {} more{RESET}", rows.len() - 6);
            }
        }
        println!();
    } else {
        println!("{DIM}no commits {label}{RESET}\n");
    }

    // --- pull requests --------------------------------------------------------------
    let (y, m, d, ..) = parts(start);
    let day = format!("merged:>={y:04}-{m:02}-{d:02}");
    let merged = sh(
        &["gh", "pr", "list", "--author", "@me", "--state", "merged", "--search", &day, "--limit", "30", "--json", "number,title,headRefName"],
        Some(&main),
        45,
    );
    let opened = sh(
        &["gh", "pr", "list", "--author", "@me", "--state", "open", "--limit", "40", "--json", "number,title,isDraft,reviewDecision,statusCheckRollup"],
        Some(&main),
        45,
    );
    let parse = |s: &str| serde_json::from_str::<Value>(if s.is_empty() { "[]" } else { s }).ok();
    let merged_v = parse(&merged);
    if let Some(Value::Array(prs)) = &merged_v {
        let mut ok = true;
        for pr in prs {
            match (key(pr, "number"), title(pr)) {
                (Some(n), Some(t)) => println!("{GREEN}⇢ merged{RESET}  #{n}  {}", head(&t, 66)),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok && !prs.is_empty() {
            println!();
        }
    }
    if let Some(Value::Array(prs)) = parse(&opened) {
        let mut classified = Some((Vec::new(), Vec::new(), 0usize));
        for pr in &prs {
            let (Some(bad), Some((red, approved, waiting))) = (bad_checks(pr), classified.as_mut()) else {
                classified = None;
                break;
            };
            if !bad.is_empty() {
                red.push((pr.clone(), bad));
            } else if pr.get("reviewDecision") == Some(&Value::String("APPROVED".into())) {
                approved.push(pr.clone());
            } else if !truthy(pr.get("isDraft")) {
                *waiting += 1;
            }
        }
        if let Some((red, approved, waiting)) = classified {
            let mut stopped = false;
            if !red.is_empty() {
                println!("{BOLD}{RED}✗ {} PR(s) red{RESET}", red.len());
                for (pr, bad) in red.iter().take(6) {
                    // ", ".join raises on a name that is not a string
                    let names: Option<Vec<String>> = bad
                        .iter()
                        .take(2)
                        .map(|c| match ["name", "context"].iter().find_map(|k| c.get(*k).filter(|x| truthy(Some(x)))) {
                            None => Some("?".to_string()),
                            Some(Value::String(s)) => Some(s.clone()),
                            Some(_) => None,
                        })
                        .collect();
                    let (Some(names), Some(n), Some(t)) = (names, key(pr, "number"), title(pr)) else {
                        stopped = true;
                        break;
                    };
                    println!("  #{n}  {}  {DIM}{}{RESET}", head(&t, 52), names.join(", "));
                }
                if !stopped {
                    println!();
                }
            }
            if !stopped && !approved.is_empty() {
                println!("{GREEN}✓ {} approved, ready to merge{RESET}", approved.len());
                for pr in approved.iter().take(6) {
                    let (Some(n), Some(t)) = (key(pr, "number"), title(pr)) else {
                        stopped = true;
                        break;
                    };
                    println!("  #{n}  {}", head(&t, 66));
                }
                if !stopped {
                    println!();
                }
            }
            if !stopped && waiting > 0 {
                println!("{DIM}{waiting} open PR(s) awaiting review{RESET}\n");
            }
        }
    }

    // --- sessions still waiting ----------------------------------------------------------
    let store = join(&crate::pypath::home(), ".cmuxterm/claude-hook-sessions.json");
    if let Some(Value::Object(st)) = crate::pyval::read_json(&store) {
        let sessions = match st.get("sessions") {
            Some(Value::Object(o)) => Some(o.clone()),
            Some(v) if truthy(Some(v)) => None,
            _ => Some(Default::default()),
        };
        let mut stuck: Option<Vec<(f64, String, String)>> = sessions.as_ref().map(|_| Vec::new());
        for (sid, rec) in sessions.iter().flatten() {
            let Some(list) = stuck.as_mut() else { break };
            let Some(r) = rec.as_object() else {
                stuck = None;
                break;
            };
            if r.get("agentLifecycle") != Some(&Value::String("needsInput".into())) {
                continue;
            }
            let cwd = r.get("cwd").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
            let updated = match r.get("updatedAt").filter(|v| truthy(Some(v))) {
                None => 0.0,
                Some(v) => match v.as_f64() {
                    Some(f) => f,
                    None => {
                        stuck = None;
                        break;
                    }
                },
            };
            let name = Some(basename(&cwd).to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| head(sid, 8));
            // time.time() per record, as the Python reads it: equal ages break
            // toward the later record.
            list.push((crew_core::py::now() - updated, name, cwd));
        }
        if let Some(mut stuck) = stuck.filter(|s| !s.is_empty()) {
            println!("{BOLD}{AMBER}⏳ {} session(s) waiting on you{RESET}", stuck.len());
            stuck.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(b.1.cmp(&a.1)).then(b.2.cmp(&a.2)));
            for (aged, name, _) in &stuck {
                let h = (aged / 3600.0).floor() as i64;
                let m = (aged.rem_euclid(3600.0) / 60.0).floor() as i64;
                let ago = if h != 0 { format!("{h}h {m}m") } else { format!("{m}m") };
                println!("  {} {DIM}{ago}{RESET}", cell(name, 44));
            }
            println!();
        }
    }

    // --- reclaimable worktrees ----------------------------------------------------
    let cand: Vec<String> = trees.iter().filter(|p| **p != main).cloned().collect();
    // Ten at a time, results in worktree order, as the Python's pool.map.
    let check = |p: &String| -> Option<String> {
        let anc = proc::run(&["git", "-C", p, "merge-base", "--is-ancestor", "HEAD", "origin/master"], None, &[], None);
        if !anc.is_some_and(|r| r.code == 0) {
            return None;
        }
        let st = sh(&["git", "-C", p, "status", "--porcelain", "--untracked-files=no"], None, 30);
        py_strip(&st).is_empty().then(|| p.clone())
    };
    let mut ripe: Vec<String> = Vec::new();
    for chunk in cand.chunks(10) {
        let got: Vec<Option<String>> = std::thread::scope(|s| {
            let hs: Vec<_> = chunk.iter().map(|p| s.spawn(move || check(p))).collect();
            hs.into_iter().map(|h| h.join().ok().flatten()).collect()
        });
        ripe.extend(got.into_iter().flatten());
    }
    if !ripe.is_empty() {
        let mut tot = String::new();
        if has("--size") {
            let mut argv = vec!["du", "-shc"];
            argv.extend(ripe.iter().map(String::as_str));
            let out = sh(&argv, None, 120);
            let lines = splitlines(py_strip(&out));
            if let Some(last) = lines.last() {
                tot = format!(" ({})", last.split_whitespace().next().unwrap_or(""));
            }
        }
        println!("{VIOLET}♻ {} worktree(s) shipped and reclaimable{RESET}{DIM}{tot}{RESET}", ripe.len());
        for p in ripe.iter().take(8) {
            let br = py_strip(&sh(&["git", "-C", p, "branch", "--show-current"], None, 30)).to_string();
            println!("  {} {DIM}{br}{RESET}", cell(basename(p), 44));
        }
        println!("  {DIM}crew-reclaim <path>   (refuses unless clean + merged){RESET}\n");
    }

    if notify {
        let mut bits = Vec::new();
        if total > 0 {
            bits.push(format!("{total} commits"));
        }
        if let Some(Value::Array(m)) = &merged_v {
            if !m.is_empty() {
                bits.push(format!("{} merged", m.len()));
            }
        }
        if !ripe.is_empty() {
            bits.push(format!("{} reclaimable", ripe.len()));
        }
        if !bits.is_empty() {
            if let Ok(c) = Cmux::connect() {
                let _ = c.notify(&Notify {
                    title: "crew digest".into(),
                    subtitle: Some("crew:digest".into()),
                    body: Some(bits.join(" · ")),
                    workspace: None,
                });
            }
        }
    }
    0
}

extern "C" fn on_interrupt(_: libc::c_int) {
    // KeyboardInterrupt exits 130, as the Python's main does.
    unsafe { libc::_exit(130) }
}

pub fn main(args: &[String]) -> i32 {
    // SAFETY: the handler only calls _exit.
    unsafe {
        libc::signal(libc::SIGINT, on_interrupt as *const () as libc::sighandler_t);
    }
    run(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floats_as_python_reads_them() {
        assert_eq!(py_float("24"), Some(24.0));
        assert_eq!(py_float(" 1.5 "), Some(1.5));
        assert_eq!(py_float("1e1"), Some(10.0));
        assert_eq!(py_float("1_0"), Some(10.0));
        assert_eq!(py_float("_1"), None);
        assert_eq!(py_float("abc"), None);
        assert_eq!(py_float("inf"), Some(f64::INFINITY));
        assert!(py_float("nan").unwrap().is_nan());
        assert_eq!(py_float(""), None);
    }

    #[test]
    fn iso_and_weekday() {
        let t = days_from_civil(2026, 10, 21) as i128 * DAY + (13 * 3600 + 5 * 60 + 9) as i128 * US;
        assert_eq!(isoformat(t), "2026-10-21T13:05:09");
        assert_eq!(isoformat(t + 42), "2026-10-21T13:05:09.000042");
        assert_eq!(weekday(t), 2); // a Wednesday
    }

    #[test]
    fn grouping_by_ref() {
        // commits_by_branch's parse, through the same rules on a canned log
        let names = |refs: &str| -> String {
            let names: Vec<String> = refs
                .split(',')
                .filter(|r| !py_strip(r).is_empty())
                .map(|r| py_strip(r).replace("HEAD -> ", ""))
                .filter(|n| !n.is_empty() && !n.starts_with("tag:") && n != "HEAD")
                .collect();
            let local: Vec<&String> = names.iter().filter(|n| !n.starts_with("origin/")).collect();
            local.first().map(|s| s.to_string()).or_else(|| names.first().cloned()).unwrap_or_else(|| "(no ref)".into())
        };
        assert_eq!(names("HEAD -> dev/x, origin/dev/x"), "dev/x");
        assert_eq!(names("origin/master, tag: v1"), "origin/master");
        assert_eq!(names(""), "(no ref)");
        assert_eq!(names("HEAD"), "(no ref)");
    }
}
