//! `crew-resume`: find a workspace, live or not, and get back into it.
//!
//! ```text
//! crew-resume              finder, this repo first
//! crew-resume --all        finder, every project
//! crew-resume <query>      finder, pre-filtered
//! crew-resume --reindex    force a full rebuild of the transcript cache
//! crew-resume --family-ok  ^A may archive what deep-plan protects, after a
//!                          y/N naming the family (ADR 0031)
//! crew-resume --rows-json  the finder's rows as JSON, in the order it would
//!                          show them for the query and scope, then exit
//! ```
//!
//! One row per workspace directory, in one of four states: live (open in
//! cmux; ⏎ jumps), archived (⏎ restores), past (⏎ resumes its latest
//! session), gone (⏎ prints the transcript path). → opens a row's sessions.
//! Search is a fuzzy score per term (subsequence, with bonuses for
//! consecutive and word-start letters), then state, then recency. Nothing
//! here touches the network.

use std::path::Path;

use crew_core::workspaces::{self as w, Ws};
use crew_core::{py, pyjson};
use serde_json::{json, Map, Value};

use crate::pypath::basename;
use crate::pyval::{head, py_str, truthy};
use crate::term::{Key, Screen, Style};

const STATES: [&str; 4] = ["live", "archived", "past", "gone"];
const WORD_START: &str = " /-_.:#";

fn mark(state: &str) -> &'static str {
    match state {
        "live" => "●",
        "archived" => "◒",
        "past" => "○",
        _ => "✕",
    }
}

fn tint(state: &str) -> u8 {
    match state {
        "live" => 2,
        "archived" => 5,
        "past" => 7,
        _ => 1,
    }
}

/// How long ago, as the finder prints it: 5m, 3h, 2d, then "Oct 3".
fn ago(ts: f64) -> String {
    let d = py::now() - ts;
    if d < 3600.0 {
        return format!("{}m", (d / 60.0).floor() as i64);
    }
    if d < 86400.0 {
        return format!("{}h", (d / 3600.0).floor() as i64);
    }
    if d < 86400.0 * 14.0 {
        return format!("{}d", (d / 86400.0).floor() as i64);
    }
    let t = ts as libc::time_t;
    // SAFETY: localtime_r fills tm, which we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{} {}", months[tm.tm_mon.clamp(0, 11) as usize], tm.tm_mday)
}

fn repo_of(cwd: &str) -> String {
    if cwd.is_empty() {
        "?".into()
    } else {
        basename(cwd.trim_end_matches('/')).to_string()
    }
}

/// The branch without its owner prefix (dev/, claude/).
fn short_branch(b: &str) -> String {
    if b.is_empty() || b == "HEAD" {
        return String::new();
    }
    b.split_once('/').map(|(_, r)| r.to_string()).unwrap_or_else(|| b.to_string())
}

/// One finder row.
#[derive(Clone, Debug)]
pub struct Row {
    pub cwd: String,
    pub state: &'static str,
    pub ws: Option<Ws>,
    pub rec: Option<Value>,
    pub sessions: Vec<Value>,
    pub title: String,
    pub latest: String,
    pub branch: String,
    /// The newest of the latest session's mtime and the archive time, as the
    /// JSON value it was (0 when there is neither).
    pub when: Value,
    pub exists: bool,
}

impl Row {
    fn when(&self) -> f64 {
        self.when.as_f64().unwrap_or(0.0)
    }
}

fn num(v: Option<&Value>) -> Value {
    v.filter(|x| truthy(Some(x))).cloned().unwrap_or(json!(0))
}

/// One row per directory: every live workspace, archive record and session
/// cwd. Live beats archived, archived beats past; gone is a past whose
/// directory went. Rows come in directory order (the Python's set order is
/// arbitrary, so ties after the sort were never fixed there).
pub fn build_rows(sessions: &[Value], live: &[Ws], archived: &Map<String, Value>, isdir: &dyn Fn(&str) -> bool) -> Vec<Row> {
    let mut by_cwd: Vec<(String, Vec<Value>)> = Vec::new();
    for s in sessions {
        if let Some(cwd) = s.get("cwd").filter(|v| truthy(Some(v))).map(py_str) {
            match by_cwd.iter_mut().find(|(c, _)| *c == cwd) {
                Some(slot) => slot.1.push(s.clone()),
                None => by_cwd.push((cwd, vec![s.clone()])),
            }
        }
    }
    for (_, ss) in by_cwd.iter_mut() {
        let m = |s: &Value| num(s.get("mtime")).as_f64().unwrap_or(0.0);
        ss.sort_by(|a, b| m(b).partial_cmp(&m(a)).unwrap_or(std::cmp::Ordering::Equal));
    }
    let mut open_at: Vec<(String, Ws)> = Vec::new();
    for ws in live {
        if !ws.cwd.is_empty() && !open_at.iter().any(|(c, _)| *c == ws.cwd) {
            open_at.push((ws.cwd.clone(), ws.clone()));
        }
    }
    let mut cwds: Vec<String> = by_cwd
        .iter()
        .map(|(c, _)| c.clone())
        .chain(open_at.iter().map(|(c, _)| c.clone()))
        .chain(archived.keys().cloned())
        .collect();
    cwds.sort();
    cwds.dedup();
    cwds.into_iter()
        .map(|cwd| {
            let ss = by_cwd.iter().find(|(c, _)| *c == cwd).map(|(_, v)| v.clone()).unwrap_or_default();
            let ws = open_at.iter().find(|(c, _)| *c == cwd).map(|(_, v)| v.clone());
            let rec = archived.get(&cwd).cloned();
            let state = if ws.is_some() {
                "live"
            } else if rec.is_some() {
                "archived"
            } else if isdir(&cwd) {
                "past"
            } else {
                "gone"
            };
            let latest = ss.first().cloned();
            let rv = rec.clone().unwrap_or(json!({}));
            // max([mtime or 0, archived_at or 0]): the first of equals
            let (a, b) = (num(latest.as_ref().and_then(|l| l.get("mtime"))), num(rv.get("archived_at")));
            let when = if b.as_f64().unwrap_or(0.0) > a.as_f64().unwrap_or(0.0) { b } else { a };
            let field = |v: &Value, k: &str| v.get(k).filter(|x| truthy(Some(x))).map(py_str);
            let title = ws
                .as_ref()
                .map(|w| w.title.clone())
                .filter(|t| !t.is_empty())
                .or_else(|| field(&rv, "title"))
                .unwrap_or_else(|| repo_of(&cwd));
            let branch = latest
                .as_ref()
                .and_then(|l| field(l, "branch"))
                .or_else(|| field(&rv, "branch"))
                .unwrap_or_default();
            Row {
                exists: state != "gone" && (state != "archived" || isdir(&cwd)),
                latest: latest.as_ref().map(w::label).unwrap_or_default(),
                sessions: ss,
                cwd,
                state,
                ws,
                rec,
                title,
                branch,
                when,
            }
        })
        .collect()
}

/// How well `term` reads as a subsequence of `text`; None when it does not.
/// Every start for the first letter is tried, the rest placed greedily; a
/// letter scores 1, +3 right after the last match, +2 at a word start.
pub fn fuzzy(term: &str, text: &str) -> Option<i64> {
    let term: Vec<char> = term.to_lowercase().chars().collect();
    let low: Vec<char> = text.to_lowercase().chars().collect();
    if term.is_empty() {
        return Some(0);
    }
    let find = |c: char, from: usize| low.iter().skip(from).position(|&x| x == c).map(|p| p + from);
    let mut best: Option<i64> = None;
    let mut start = find(term[0], 0);
    while let Some(st) = start {
        let (mut score, mut prev, mut i): (Option<i64>, i64, usize) = (Some(0), -2, st);
        for &ch in &term {
            match find(ch, i) {
                None => {
                    score = None;
                    break;
                }
                Some(at) => {
                    let ws = at == 0 || WORD_START.contains(low[at - 1]);
                    *score.as_mut().unwrap() += 1 + if at as i64 == prev + 1 { 3 } else { 0 } + if ws { 2 } else { 0 };
                    prev = at as i64;
                    i = at + 1;
                }
            }
        }
        let Some(s) = score else { break }; // a later start cannot match either
        best = Some(best.map_or(s, |b| b.max(s)));
        start = find(term[0], st + 1);
    }
    best
}

/// Sum of each term's best field; None unless every term matches somewhere.
/// Short fields match as subsequences; the latest title and the path only as
/// written; a session id prefix of four or more finds its row.
pub fn score(terms: &[String], row: &Row) -> Option<i64> {
    let short = [row.title.clone(), repo_of(&row.cwd), short_branch(&row.branch)];
    let prose = [row.latest.to_lowercase(), row.cwd.to_lowercase()];
    let ids: Vec<String> = row.sessions.iter().map(|s| s.get("id").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default()).collect();
    let mut total = 0;
    for t in terms {
        let n = t.chars().count() as i64;
        let mut hits: Vec<i64> = short.iter().filter(|f| !f.is_empty()).filter_map(|f| fuzzy(t, f)).collect();
        hits.extend(prose.iter().filter(|f| f.contains(t.as_str())).map(|_| n));
        if n >= 4 && ids.iter().any(|i| i.starts_with(t.as_str())) {
            hits.push(6 * n);
        }
        total += hits.into_iter().max()?;
    }
    Some(total)
}

/// The rows that match, by score, then state, then recency.
pub fn order(rows: &[Row], terms: &[String]) -> Vec<Row> {
    let mut scored: Vec<(i64, &Row)> = rows
        .iter()
        .filter_map(|r| if terms.is_empty() { Some((0, r)) } else { score(terms, r).map(|s| (s, r)) })
        .collect();
    let rank = |r: &Row| STATES.iter().position(|s| *s == r.state).unwrap_or(9);
    scored.sort_by(|(sa, a), (sb, b)| {
        sb.cmp(sa).then(rank(a).cmp(&rank(b))).then(b.when().partial_cmp(&a.when()).unwrap_or(std::cmp::Ordering::Equal))
    });
    scored.into_iter().map(|(_, r)| r.clone()).collect()
}

fn terms_of(query: &str) -> Vec<String> {
    query.to_lowercase().split(crate::pyval::py_space).filter(|t| !t.is_empty()).map(String::from).collect()
}

fn scoped<'a>(rows: &'a [Row], scope_root: &str) -> Vec<Row> {
    if scope_root.is_empty() {
        rows.to_vec()
    } else {
        rows.iter().filter(|r| r.cwd.starts_with(scope_root)).cloned().collect()
    }
}

/// What the picker would list first, for scripts and the probe.
fn rows_json(rows: &[Row], query: &str, scope_root: &str, live_known: bool) -> Value {
    let shown = order(&scoped(rows, scope_root), &terms_of(query));
    json!({
        "scope": scope_root,
        "total": rows.len(),
        "rows": shown.iter().map(|r| json!({
            "cwd": r.cwd, "state": r.state, "title": r.title, "latest": r.latest, "branch": r.branch,
            "when": r.when, "exists": r.exists,
            "ws": r.ws.as_ref().map(|w| w.id.clone()).unwrap_or_default(),
            "sessions": r.sessions.iter().map(|s| s.get("id").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default()).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "live_known": live_known,
    })
}

/// The repo family a directory belongs to: a worktree scopes to its siblings
/// and the primary checkout.
fn scope_of(cwd: &str) -> String {
    let Some(o) = crate::proc::run(&["git", "-C", cwd, "rev-parse", "--show-toplevel"], None, &[], None) else { return String::new() };
    if o.code != 0 || !o.utf8 {
        return String::new();
    }
    let top = crate::pyval::py_strip(&o.stdout);
    let top = top.split(".worktrees").next().unwrap_or("");
    top.split("/.claude/worktrees").next().unwrap_or("").to_string()
}

// --- the picker -------------------------------------------------------------------------

struct Ui {
    query: String,
    scoped: bool,
    sel: i64,
    top: i64,
    flash: String,
}

fn draw_list(scr: &mut Screen, ui: &mut Ui, rows: &[Row], total: usize, scope_root: &str) -> i64 {
    let (h, w) = scr.size();
    let body = h as i64 - 4;
    ui.sel = ui.sel.min(rows.len() as i64 - 1).max(0);
    if ui.sel < ui.top {
        ui.top = ui.sel;
    } else if ui.sel >= ui.top + body {
        ui.top = ui.sel - body + 1;
    }
    scr.erase();
    let is_scoped = ui.scoped && !scope_root.is_empty();
    let scope_txt = if is_scoped { format!("this repo ({})", repo_of(scope_root)) } else { "all projects".into() };
    let wi = w.saturating_sub(1);
    scr.put(0, 0, "  crew resume", wi, Style::bold());
    scr.put(0, 15, &format!("{}/{} workspaces · {scope_txt}", rows.len(), total), w.saturating_sub(16), Style::color(7));
    scr.put(1, 0, &format!("  search: {}", ui.query), wi, Style::bold());
    scr.put(1, (w.saturating_sub(2)).min(10 + ui.query.chars().count()), "▏", 1, Style::color(6));
    if !ui.flash.is_empty() {
        scr.put(2, 2, &head(&ui.flash, w.saturating_sub(3)), w.saturating_sub(3), Style::color(3));
    }
    let shown = rows.iter().skip(ui.top.max(0) as usize).take(body.max(0) as usize);
    for (i, r) in shown.enumerate() {
        let y = i + 3;
        let attr = Style { reverse: ui.top + i as i64 == ui.sel, ..Style::default() };
        scr.put(y, 0, &" ".repeat(wi), wi, attr);
        scr.put(y, 2, mark(r.state), 1, attr.with(Style::color(tint(r.state))));
        let age = if r.when() != 0.0 { ago(r.when()) } else { String::new() };
        scr.put(y, 4, &format!("{age:>6}"), 6, attr.with(Style::color(7)));
        // Inside one repo the branch is the useful half; across repos the directory.
        let loc = if is_scoped {
            Some(short_branch(&r.branch)).filter(|b| !b.is_empty()).unwrap_or_else(|| repo_of(&r.cwd))
        } else {
            repo_of(&r.cwd)
        };
        scr.put(y, 12, &format!("{:<26}", head(&loc, 26)), 26, attr.with(Style::color(if r.exists { 4 } else { 1 })));
        let mut text = if r.title != loc { r.title.clone() } else { String::new() };
        if !r.latest.is_empty() {
            text = if text.is_empty() { r.latest.clone() } else { format!("{text} — {}", r.latest) };
        }
        let tw = w.saturating_sub(41);
        scr.put(y, 40, &head(&text, tw), tw, attr);
    }
    let here = match rows.get(ui.sel.max(0) as usize).map(|r| r.state) {
        Some("live") => "⏎ jump · ^A archive",
        Some("archived") => "⏎ restore · ^X forget",
        Some("past") => "⏎ resume latest",
        Some(_) => "⏎ transcript",
        None => "",
    };
    let hint = format!("  ↑↓ · {here} · ^T resume here · → sessions · ⇥ scope · ^R reindex · esc");
    scr.put(h.saturating_sub(1), 0, &head(&hint, wi), wi, Style::color(7));
    scr.refresh();
    body
}

fn draw_sessions(scr: &mut Screen, row: &Row, sel: i64) {
    let (h, w) = scr.size();
    let body = h as i64 - 4;
    let top = (sel - body + 1).max(0);
    scr.erase();
    scr.put(0, 0, &format!("  {}", row.title), w.saturating_sub(1), Style::bold());
    scr.put(1, 2, &format!("{} session(s) · {}", row.sessions.len(), row.cwd), w.saturating_sub(3), Style::color(7));
    for (i, s) in row.sessions.iter().skip(top as usize).take(body.max(0) as usize).enumerate() {
        let y = i + 3;
        let attr = Style { reverse: top + i as i64 == sel, ..Style::default() };
        let wi = w.saturating_sub(1);
        scr.put(y, 0, &" ".repeat(wi), wi, attr);
        let mtime = s.get("mtime").and_then(Value::as_f64).unwrap_or(0.0);
        scr.put(y, 2, &format!("{:>6}", ago(mtime)), 6, attr.with(Style::color(7)));
        let id = s.get("id").map(py_str).unwrap_or_default();
        scr.put(y, 10, &head(&id, 8), 8, attr.with(Style::color(4)));
        let tw = w.saturating_sub(21);
        scr.put(y, 20, &head(&w::label(s), tw), tw, attr);
    }
    let hint = "  ↑↓ · ⏎ resume in new workspace · ^T resume here · ← back";
    scr.put(h.saturating_sub(1), 0, &head(hint, w.saturating_sub(1)), w.saturating_sub(1), Style::color(7));
    scr.refresh();
}

enum Pick {
    Reindex,
    Open(Row),
    Archive(Row),
    Forget(Row),
    /// Resume a session in a new workspace ("workspace") or here ("here").
    Resume(&'static str, Value),
}

fn sessions_view(scr: &mut Screen, row: &Row) -> Option<Pick> {
    let mut sel: i64 = 0;
    loop {
        draw_sessions(scr, row, sel);
        match scr.key() {
            Key::Interrupt | Key::Esc | Key::Left => return None,
            Key::Up | Key::Ctrl(b'p') => sel = (sel - 1).max(0),
            Key::Down | Key::Ctrl(b'n') => sel = (sel + 1).min(row.sessions.len() as i64 - 1),
            Key::Enter | Key::Ctrl(b'j') | Key::Ctrl(b'm') => return Some(Pick::Resume("workspace", row.sessions[sel as usize].clone())),
            Key::Ctrl(b't') => return Some(Pick::Resume("here", row.sessions[sel as usize].clone())),
            _ => {}
        }
    }
}

fn picker(scr: &mut Screen, rows: &[Row], ui: &mut Ui, scope_root: &str) -> Option<Pick> {
    loop {
        let pool = if ui.scoped { scoped(rows, scope_root) } else { rows.to_vec() };
        let shown = order(&pool, &terms_of(&ui.query));
        let body = draw_list(scr, ui, &shown, rows.len(), scope_root);
        let k = scr.key();
        let cur = shown.get(ui.sel.max(0) as usize).filter(|_| !shown.is_empty()).cloned();
        if k != Key::Ctrl(b'r') {
            ui.flash.clear();
        }
        let none_for = |r: &Row| format!("no Claude sessions recorded for {}", r.title);
        match k {
            Key::Interrupt | Key::Esc => return None,
            Key::Up | Key::Ctrl(b'p') => ui.sel -= 1,
            Key::Down | Key::Ctrl(b'n') => ui.sel += 1,
            Key::PageDown => ui.sel += body,
            Key::PageUp => ui.sel -= body,
            Key::Tab | Key::Ctrl(b'i') => {
                ui.scoped = !ui.scoped;
                ui.sel = 0;
                ui.top = 0;
            }
            Key::Ctrl(b'r') => return Some(Pick::Reindex),
            Key::Right => match &cur {
                Some(r) if !r.sessions.is_empty() => {
                    if let Some(p) = sessions_view(scr, r) {
                        return Some(p);
                    }
                }
                Some(r) => ui.flash = none_for(r),
                None => {}
            },
            Key::Enter | Key::Ctrl(b'j') | Key::Ctrl(b'm') => {
                if let Some(r) = cur {
                    return Some(Pick::Open(r));
                }
            }
            Key::Ctrl(b't') => match &cur {
                Some(r) if !r.sessions.is_empty() => return Some(Pick::Resume("here", r.sessions[0].clone())),
                Some(r) => ui.flash = none_for(r),
                None => {}
            },
            Key::Ctrl(b'a') => match cur {
                Some(r) if r.state == "live" => return Some(Pick::Archive(r)),
                Some(_) => ui.flash = "only a live workspace can be archived".into(),
                None => {}
            },
            Key::Ctrl(b'x') => match cur {
                Some(r) if r.state == "archived" => return Some(Pick::Forget(r)),
                Some(_) => ui.flash = "only an archived record can be forgotten".into(),
                None => {}
            },
            Key::Backspace | Key::Ctrl(b'h') => {
                ui.query.pop();
                ui.sel = 0;
            }
            Key::Char(c) if crate::term::printable(c) => {
                ui.query.push(c);
                ui.sel = 0;
            }
            _ => {}
        }
        ui.sel = ui.sel.max(0);
    }
}

// --- what a pick does ----------------------------------------------------------------------

fn cmux() -> Option<cmux::Cmux> {
    cmux::Cmux::connect().ok()
}

/// The tab a cmux action spawned to host this picker is litter once the pick
/// lives in its own workspace; only when the action set the flag.
fn close_ephemeral() {
    if std::env::var("CREW_EPHEMERAL").as_deref() == Ok("1") {
        if let Some(surface) = py::env_or("CMUX_SURFACE_ID") {
            if let Some(c) = cmux() {
                let _ = c.close_surface(&surface);
            }
        }
    }
}

fn resume(mode: &str, s: &Value) -> i32 {
    let cwd = s.get("cwd").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
    let id = s.get("id").map(py_str).unwrap_or_default();
    if !Path::new(&cwd).is_dir() {
        // Claude keys sessions by project directory; resuming from elsewhere is
        // not reliably the same session, so say where it was instead.
        let shown = if cwd.is_empty() { "(unknown cwd)".to_string() } else { cwd.clone() };
        eprintln!("crew-resume: {shown} no longer exists — that worktree was removed.");
        eprintln!("  transcript: {}", s.get("path").map(py_str).unwrap_or_default());
        eprintln!("  to read it anyway:  claude --resume {id}   (from a checkout of the same repo)");
        return 1;
    }
    let cmd = format!("claude --resume {id}");
    if mode == "here" {
        println!("→ {cwd}");
        println!("→ {cmd}");
        let _ = std::env::set_current_dir(&cwd);
        return std::process::Command::new("claude").args(["--resume", &id]).status().map(|s| s.code().unwrap_or(1)).unwrap_or(1);
    }
    // The cmux CLI itself, waited on for as long as it takes (no kill that
    // could leave a half-made workspace), stdout dropped, stderr shown.
    let bin = cmux().and_then(|c| c.cli_bin().ok()).or_else(|| cmux::resolve_cli_bin().ok());
    let rc = match bin {
        Some(bin) => std::process::Command::new(&bin)
            .args(["new-workspace", "--cwd", &cwd, "--command", &cmd, "--focus", "true"])
            .env("CMUX_QUIET", "1")
            .stdout(std::process::Stdio::null())
            .status()
            .map(|s| s.code().unwrap_or(1))
            .unwrap_or_else(|e| {
                eprintln!("crew-resume: cannot run {}: {e}", bin.display());
                1
            }),
        None => {
            eprintln!("crew-resume: no cmux to open a workspace with");
            1
        }
    };
    if rc == 0 {
        println!("✓ resumed {} in a new workspace — {}", head(&id, 8), head(&w::label(s), 60));
        close_ephemeral(); // "here" never closes: Claude has taken this very tab
    }
    rc
}

/// ⏎ on a workspace row, by its state.
fn open_row(r: &Row) -> i32 {
    match r.state {
        "live" => {
            let id = r.ws.as_ref().map(|w| w.id.clone()).unwrap_or_default();
            if !w::select(&id) {
                eprintln!("crew-resume: cmux would not switch to {}", r.title);
                return 1;
            }
            println!("✓ {}", r.title);
            close_ephemeral();
            0
        }
        "archived" => {
            let (ok, msg) = w::restore(&r.cwd);
            if ok {
                println!("✓ {msg}");
                close_ephemeral();
                0
            } else {
                eprintln!("crew-resume: {msg}");
                1
            }
        }
        _ => match r.sessions.first() {
            None => {
                eprintln!("crew-resume: no Claude session recorded at {}", r.cwd);
                1
            }
            Some(s) => resume("workspace", s),
        },
    }
}

fn run(args: &[String]) -> i32 {
    let mut force = args.iter().any(|a| a == "--reindex");
    let show_all = args.iter().any(|a| a == "--all");
    let family_ok = args.iter().any(|a| a == "--family-ok");
    let rows_only = args.iter().any(|a| a == "--rows-json");
    let query = args.iter().filter(|a| !a.starts_with("--")).cloned().collect::<Vec<_>>().join(" ");
    if !w::projects().is_dir() {
        eprintln!("crew-resume: no ~/.claude/projects");
        return 1;
    }
    let scope_root = if show_all {
        String::new()
    } else {
        std::env::current_dir().map(|d| scope_of(&d.to_string_lossy())).unwrap_or_default()
    };
    let mut ui = Ui { query: query.clone(), scoped: true, sel: 0, top: 0, flash: String::new() };
    loop {
        let t0 = py::now();
        let (sessions, seen) = w::build_index(force);
        if force {
            let line = format!("indexed {seen} transcripts in {:.1}s", py::now() - t0);
            if rows_only {
                eprintln!("{line}");
            } else {
                println!("{line}");
            }
        }
        force = false;
        let live = w::live_workspaces();
        if live.is_none() && ui.flash.is_empty() {
            // "Could not tell" is not "nothing is open".
            ui.flash = "✗ cmux did not list its workspaces — open ones show as past or archived".into();
        }
        let rows = build_rows(&sessions, live.as_deref().unwrap_or(&[]), &w::load_archive(), &|p| Path::new(p).is_dir());
        if rows_only {
            println!("{}", pyjson::dumps_indent(&rows_json(&rows, &query, &scope_root, live.is_some()), 1));
            return 0;
        }
        IN_PICKER.store(true, std::sync::atomic::Ordering::SeqCst);
        let pick = match Screen::open() {
            Ok(mut scr) => picker(&mut scr, &rows, &mut ui, &scope_root),
            Err(e) => {
                eprintln!("crew-resume: no terminal ({e})");
                return 1;
            }
        };
        IN_PICKER.store(false, std::sync::atomic::Ordering::SeqCst);
        match pick {
            None => return 0,
            Some(Pick::Reindex) => force = true,
            Some(Pick::Archive(r)) => {
                let id = r.ws.as_ref().map(|w| w.id.clone()).unwrap_or_default();
                if std::env::var("CMUX_WORKSPACE_ID").ok().as_deref() == Some(id.as_str()) {
                    ui.flash = "that is this terminal's workspace — archive it from elsewhere".into();
                } else {
                    // The picker is down: a --family-ok y/N reads the plain terminal.
                    let (ok, msg) = w::archive(&id, family_ok);
                    ui.flash = format!("{}{msg}", if ok { "✓ " } else { "✗ " });
                }
            }
            Some(Pick::Forget(r)) => {
                w::forget(&r.cwd);
                ui.flash = format!("✓ forgot {}", r.title);
            }
            Some(Pick::Open(r)) => return open_row(&r),
            Some(Pick::Resume(mode, s)) => return resume(mode, &s),
        }
    }
}

/// The full screen is up: an interrupt there ends the picker (exit 0, as
/// curses.wrapper's KeyboardInterrupt does), anywhere else exits 130.
static IN_PICKER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

extern "C" fn on_interrupt(_: libc::c_int) {
    // SAFETY: only async-signal-safe calls (write, tcsetattr, _exit).
    if IN_PICKER.load(std::sync::atomic::Ordering::SeqCst) {
        crate::term::restore_raw();
        unsafe { libc::_exit(0) }
    }
    unsafe { libc::_exit(130) }
}

pub fn main(args: &[String]) -> i32 {
    crate::term::restore_on_panic();
    // SAFETY: the handler makes only async-signal-safe calls.
    unsafe {
        libc::signal(libc::SIGINT, on_interrupt as *const () as libc::sighandler_t);
    }
    run(args)
}

#[cfg(test)]
mod tests {
    //! workspaces_probe's in-process finder checks, held here for the Rust.
    use super::*;

    fn s(i: &str, cwd: &str, t: &str, mtime: f64, branch: &str) -> Value {
        json!({"id": i, "path": format!("/p/{i}"), "cwd": cwd, "title": t, "prompt": "", "branch": branch, "mtime": mtime})
    }

    fn ws(id: &str, cwd: &str, title: &str) -> Ws {
        Ws {
            id: id.into(),
            r#ref: format!("workspace:{id}"),
            title: title.into(),
            cwd: cwd.into(),
            color: String::new(),
            description: String::new(),
            selected: false,
            window: String::new(),
            last_message: String::new(),
        }
    }

    fn row(t: &str, st: &'static str, when: f64, cwd: Option<&str>) -> Row {
        Row {
            cwd: cwd.map(String::from).unwrap_or_else(|| format!("/r/{t}")),
            state: st,
            ws: None,
            rec: None,
            sessions: vec![],
            title: t.into(),
            latest: String::new(),
            branch: String::new(),
            when: json!(when),
            exists: true,
        }
    }

    fn t(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn rows_one_per_directory_with_their_states() {
        let here = ["/r/live", "/r/arch", "/r/past", "/r/both"];
        let mut archived = Map::new();
        archived.insert("/r/arch".into(), json!({"cwd": "/r/arch", "title": "arch-one", "archived_at": 50}));
        archived.insert("/r/both".into(), json!({"cwd": "/r/both", "title": "stale", "archived_at": 1}));
        let rows = build_rows(
            &[
                s("1", "/r/live", "older talk", 10.0, ""),
                s("2", "/r/live", "newest talk", 20.0, ""),
                s("3", "/r/past", "past talk", 30.0, "dev/past-work"),
                s("4", "/r/gone", "gone talk", 40.0, ""),
                s("5", "/r/both", "both", 5.0, ""),
            ],
            &[ws("w1", "/r/live", "live-one"), ws("w2", "/r/both", "both")],
            &archived,
            &|p| here.contains(&p),
        );
        let by = |c: &str| rows.iter().find(|r| r.cwd == c).unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(by("/r/live").sessions.len(), 2);
        assert_eq!(
            ["/r/live", "/r/arch", "/r/past", "/r/gone"].map(|c| by(c).state),
            ["live", "archived", "past", "gone"]
        );
        assert_eq!(by("/r/both").state, "live");
        assert_eq!(by("/r/live").latest, "newest talk");
        assert_eq!(by("/r/live").title, "live-one");
        assert_eq!(by("/r/arch").title, "arch-one");
    }

    #[test]
    fn the_fuzzy_scorer() {
        assert!(fuzzy("dkorg", "dock-organization").is_some());
        assert!(fuzzy("xq", "dock-organization").is_none() && fuzzy("od", "do").is_none());
        assert!(fuzzy("dock", "dock-organization") > fuzzy("dock", "d-o-c-k"));
        assert!(fuzzy("o", "dock-org") > fuzzy("o", "docko"));
        assert_eq!(fuzzy("org", "xo-organization"), fuzzy("org", "organization"));
    }

    #[test]
    fn scoring_and_order() {
        assert!(score(&t(&["org", "dock"]), &row("dock-organization", "past", 0.0, None)).is_some());
        let lat = |r: Row| Row { latest: "xylophone".into(), ..r };
        assert!(score(&t(&["kx"]), &lat(row("dock", "past", 0.0, None))).is_none());
        assert!(score(&t(&["phone"]), &lat(row("dock", "past", 0.0, None))).is_some());
        assert!(score(&t(&["xlpn"]), &lat(row("dock", "past", 0.0, None))).is_none());
        assert!(score(&t(&["hmc"]), &row("dock", "past", 0.0, Some("/home/someone/code/dock"))).is_none());
        let with_id = Row { sessions: vec![json!({"id": "8f3a2b11-0000"})], ..row("dock", "past", 0.0, None) };
        assert!(score(&t(&["8f3a2b"]), &with_id).is_some());
        let got: Vec<String> = order(
            &[row("dorg-z", "gone", 0.0, None), row("dock-organization", "past", 0.0, None), row("dorg", "live", 1.0, None), row("dorg", "archived", 9.0, None)],
            &t(&["dorg"]),
        )
        .into_iter()
        .map(|r| r.title)
        .collect();
        assert_eq!(&got[..2], ["dorg", "dorg"]);
        assert_eq!(got.last().unwrap(), "dock-organization");
        let same: Vec<String> =
            order(&[row("a", "past", 1.0, None), row("b", "past", 9.0, None), row("c", "live", 0.0, None)], &[]).into_iter().map(|r| r.title).collect();
        assert_eq!(same, ["c", "b", "a"]);
    }

    #[test]
    fn small_helpers() {
        assert_eq!(short_branch("dev/x/y"), "x/y");
        assert_eq!(short_branch("HEAD"), "");
        assert_eq!(repo_of("/a/b/"), "b");
        assert_eq!(repo_of(""), "?");
    }
}
