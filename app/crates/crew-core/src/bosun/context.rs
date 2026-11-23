//! `seamux bosun context radar|lookout [--json]`: what the app's Radar and
//! Lookout tabs show, read without the app and without writing anything.
//!
//! Radar: the workspaces in the tmux backend's registry, less any row with a
//! `kind` (the Bosun's own) and the worktrees tucked away in tucked.json,
//! through the same scan, plan read and assembly the tab runs (crate::radar).
//! The registry is read as on disk, as doctor reads it: TmuxBackend's lists
//! take its lock and write it back, which the Bosun's sandbox refuses. So a
//! pane whose session ended but that the app has not pruned yet still
//! shows. Git runs with --no-optional-locks, so a read takes no index lock.
//!
//! Lookout: the app's own review runs (~/.cache/seamux/reviews/jobs.json)
//! and the newest reviews opened from a terminal (lookout's reviews folder,
//! LOOKOUT_REVIEWS_DIR else ~/.claude/plans/reviews), as the tab lists them.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::backend::tmux::{has_kind, TmuxBackend};
use crate::backend::{PaneRow, WorkspaceRow};
use crate::py::{env_or, home};
use crate::radar::{self, Frame, Seat};

/// How many terminal reviews are shown, newest first (as the tab does).
const OTHERS: usize = 12;

/// A worktree root as the Radar tab keys it: git's top level, real path, no trailing slash.
fn root_of(cwd: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    let top = crate::py::run("git", &["--no-optional-locks", "-C", cwd, "rev-parse", "--show-toplevel"], Duration::from_secs(3))
        .filter(|(code, _, _)| *code == 0)
        .map(|(_, out, _)| out.trim().to_string())
        .filter(|t| !t.is_empty());
    real(top.as_deref().unwrap_or(cwd))
}

fn real(p: &str) -> String {
    let p = super::config::expand(p);
    let r = fs::canonicalize(&p).unwrap_or(p).to_string_lossy().into_owned();
    let t = r.trim_end_matches('/');
    if t.is_empty() { "/".into() } else { t.to_string() }
}

/// The roots tucked away in `crew_dir`/tucked.json.
pub fn tucked(crew_dir: &Path) -> Vec<String> {
    let v: Value = fs::read_to_string(crew_dir.join("tucked.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    v.get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|e| e.get("level").and_then(Value::as_str) == Some("tuck"))
        .filter_map(|e| e.get("path").and_then(Value::as_str))
        .map(real)
        .collect()
}

/// The registry's workspaces and their panes, less any row with a `kind`
/// (the Bosun's) and the panes in one.
pub fn rows_of(reg: &Value) -> (Vec<WorkspaceRow>, Vec<PaneRow>) {
    let arr = |k: &str| reg.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let ws: Vec<WorkspaceRow> = arr("workspaces")
        .iter()
        .filter(|w| !has_kind(w))
        .map(|w| WorkspaceRow { id: s(w, "id"), title: s(w, "title"), cwd: s(w, "cwd") })
        .filter(|w| !w.id.is_empty())
        .collect();
    let panes = arr("panes")
        .iter()
        .filter(|p| ws.iter().any(|w| w.id.eq_ignore_ascii_case(&s(p, "ws"))))
        .map(|p| PaneRow { id: s(p, "id"), workspace: s(p, "ws"), cwd: s(p, "cwd"), label: "Claude".into() })
        .collect();
    (ws, panes)
}

/// One seat per workspace: its agent pane (one with a pane file) when it
/// has one, else its first pane.
pub fn seats(reg: &Value, pane_files: &Path, tucked: &[String], root_of: &dyn Fn(&str) -> String) -> Vec<Seat> {
    let (workspaces, panes) = rows_of(reg);
    let mut out = Vec::new();
    for w in workspaces {
        let mine: Vec<_> = panes.iter().filter(|p| p.workspace.eq_ignore_ascii_case(&w.id)).collect();
        let agent = mine.iter().find_map(|p| crate::status::read(pane_files, &p.id).map(|f| (*p, f.state)));
        let (pane, state) = match &agent {
            Some((p, st)) => (p.id.clone(), st.clone()),
            None => (mine.first().map(|p| p.id.clone()).unwrap_or_default(), String::new()),
        };
        let cwd = agent.as_ref().map(|(p, _)| p.cwd.clone()).or_else(|| mine.first().map(|p| p.cwd.clone())).filter(|c| !c.is_empty()).unwrap_or(w.cwd.clone());
        let root = root_of(&cwd);
        if root.is_empty() || tucked.contains(&root) {
            continue;
        }
        out.push(Seat { ws: w.id, pane, title: w.title, root, color: None, state });
    }
    out
}

fn dp_state() -> PathBuf {
    home().join(".claude/deep-plan/state")
}

fn dp_keys(state: &Path) -> PathBuf {
    env_or("DEEP_PLAN_KEYS_DIR").map(PathBuf::from).unwrap_or_else(|| state.parent().map(|p| p.join("keys")).unwrap_or_default())
}

/// What the Radar tab shows, from `seats`.
pub fn radar_of(seats: &[Seat], state: &Path, keys: &Path) -> Frame {
    let mut roots: Vec<String> = seats.iter().map(|s| s.root.clone()).collect();
    roots.sort();
    roots.dedup();
    let trees = radar::scan(&roots, &BTreeMap::new(), radar::SCAN_WORKERS);
    let plans = radar::read_plans(state, keys, root_of);
    radar::assemble(seats, &trees, &plans)
}

/// Radar on this machine's tmux backend.
pub fn radar_here() -> Result<Frame, String> {
    let crew = env_or("CREW_DURABLE_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude/crew"));
    let reg = TmuxBackend::default().registry()?;
    let s = seats(&reg, &crate::status::pane_dir(), &tucked(&crew), &root_of);
    let state = dp_state();
    Ok(radar_of(&s, &state, &dp_keys(&state)))
}

fn radar_text(f: &Frame) -> String {
    if f.repos.is_empty() {
        return "Radar: no workspaces on the scope.\n".into();
    }
    let mut out = String::new();
    for r in &f.repos {
        out.push_str(&format!("{} ({} workspaces)\n", r.name, r.contacts.len()));
        for c in &r.contacts {
            let state = if c.state.is_empty() { String::new() } else { format!(", {}", c.state) };
            out.push_str(&format!("  {} [{}{state}]{}\n", c.title, c.branch, if c.partial { " (git read partial)" } else { "" }));
            if !c.editing.is_empty() {
                out.push_str(&format!("    editing: {}\n", c.editing.join(", ")));
            }
            for p in &c.planned {
                out.push_str(&format!("    planned: {} ({} inc {}: {})\n", p.path, p.plan, p.inc, p.title));
            }
        }
        if !r.collisions.is_empty() {
            out.push_str(&format!("  collisions: {}\n", r.collisions.join(", ")));
        }
    }
    out
}

// ------------------------------------------------------------------ lookout

fn is_open(f: &Value) -> bool {
    !matches!(f.get("status").and_then(Value::as_str), Some("resolved" | "dismissed"))
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// A review record's pull request, from its github block.
fn pr_of(d: &Value) -> Value {
    let Some(g) = d.get("github") else { return Value::Null };
    let Some(pr) = g.get("pr").and_then(Value::as_u64) else { return Value::Null };
    let url = s(g, "url");
    json!({"repo": s(g, "repo"), "pr": pr, "state": s(g, "state"), "url": if url.starts_with("https://github.com/") { url } else { String::new() }})
}

/// The app's review runs in `jobs_file`, newest first.
pub fn app_reviews(jobs_file: &Path) -> Vec<Value> {
    let v: Value = fs::read_to_string(jobs_file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let mut out: Vec<Value> = v
        .as_array()
        .into_iter()
        .flatten()
        .map(|j| {
            json!({
                "id": s(j, "id"), "input": s(j, "input"), "repo": s(j, "repo"), "branch": s(j, "branch"),
                "pr": j.get("pr").cloned().unwrap_or(Value::Null), "status": s(j, "status"), "detail": s(j, "detail"),
                "review": s(j, "review_id"), "open": j.get("open").cloned().unwrap_or(json!({})),
                "started": j.get("started").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect();
    out.sort_by_key(|j| std::cmp::Reverse(j["started"].as_u64().unwrap_or(0)));
    out
}

/// The newest reviews in `dir` the app did not run (`skip` holds the app's
/// review ids, `app_base` its worktrees), newest first.
pub fn terminal_reviews(dir: &Path, skip: &[String], app_base: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if id.ends_with(".rows") || id.ends_with(".seen") || id.ends_with(".incoming") || id.starts_with("wake-") || skip.iter().any(|x| x == id) {
            continue;
        }
        let Some(d) = fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let Some(src) = d.get("source") else { continue };
        let root = s(src, "root");
        if !app_base.is_empty() && (root == app_base || root.starts_with(&format!("{}/", app_base.trim_end_matches('/')))) {
            continue;
        }
        let mut open: BTreeMap<String, u32> = BTreeMap::new();
        for f in d.get("findings").and_then(Value::as_array).into_iter().flatten().filter(|f| is_open(f)) {
            *open.entry(s(f, "severity")).or_insert(0) += 1;
        }
        let title = s(&d, "title");
        out.push(json!({
            "id": id, "title": if title.is_empty() { id.to_string() } else { title },
            "root": root, "branch": s(src, "branch"), "updatedAt": s(&d, "updatedAt"),
            "open": open, "pr": pr_of(&d),
        }));
    }
    // ISO times sort as text.
    out.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    out.truncate(OTHERS);
    out
}

/// What the Lookout tab shows: {app, terminal}.
pub fn lookout_at(jobs_file: &Path, reviews_dir: &Path, app_base: &str) -> Value {
    let app = app_reviews(jobs_file);
    let skip: Vec<String> = app.iter().map(|j| s(j, "review")).filter(|r| !r.is_empty()).collect();
    json!({"app": app, "terminal": terminal_reviews(reviews_dir, &skip, app_base)})
}

pub fn lookout_here() -> Value {
    let base = home().join(".cache/seamux/reviews");
    let reviews = env_or("LOOKOUT_REVIEWS_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude/plans/reviews"));
    lookout_at(&base.join("jobs.json"), &reviews, &base.to_string_lossy())
}

fn open_text(open: &Value) -> String {
    let m = open.as_object().cloned().unwrap_or_default();
    let parts: Vec<String> = m.iter().filter(|(_, n)| n.as_u64().unwrap_or(0) > 0).map(|(k, n)| format!("{n} {k}")).collect();
    if parts.is_empty() { "no open findings".into() } else { format!("open: {}", parts.join(", ")) }
}

fn lookout_text(v: &Value) -> String {
    let mut out = String::new();
    let app = v["app"].as_array().cloned().unwrap_or_default();
    let term = v["terminal"].as_array().cloned().unwrap_or_default();
    if app.is_empty() && term.is_empty() {
        return "Lookout: no reviews.\n".into();
    }
    if !app.is_empty() {
        out.push_str("Reviews the app ran:\n");
        for j in &app {
            let pr = j["pr"].as_u64().map(|n| format!(" #{n}")).unwrap_or_default();
            out.push_str(&format!("  {} {}{pr} [{}]: {}\n", s(j, "repo"), s(j, "branch"), s(j, "status"), open_text(&j["open"])));
        }
    }
    if !term.is_empty() {
        out.push_str("Reviews opened from a terminal:\n");
        for r in &term {
            let pr = match r["pr"]["url"].as_str().filter(|u| !u.is_empty()) {
                Some(u) => format!(" {u}"),
                None => String::new(),
            };
            out.push_str(&format!("  {} ({}, {}){pr}: {}\n", s(r, "title"), s(r, "root"), s(r, "branch"), open_text(&r["open"])));
        }
    }
    out
}

/// `seamux bosun context radar|lookout [--json]`.
pub fn main(args: &[String]) -> i32 {
    let json_out = args.iter().any(|a| a == "--json");
    match args.iter().map(String::as_str).find(|a| !a.starts_with("--")) {
        Some("radar") => match radar_here() {
            Ok(f) => {
                if json_out {
                    println!("{}", serde_json::to_string(&f).unwrap_or_default());
                } else {
                    print!("{}", radar_text(&f));
                }
                0
            }
            Err(e) => {
                eprintln!("bosun context radar: {e}");
                1
            }
        },
        Some("lookout") => {
            let v = lookout_here();
            if json_out {
                println!("{v}");
            } else {
                print!("{}", lookout_text(&v));
            }
            0
        }
        _ => {
            eprintln!("usage: seamux bosun context radar|lookout [--json]");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bosun-ctx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn seats_take_the_agent_pane_and_skip_tucked_roots() {
        let d = tmp("seats");
        let files = d.join("cache");
        fs::create_dir_all(&files).unwrap();
        fs::write(crate::status::path(&files, "P2"), json!({"ws": "W1", "state": "working", "at": 1}).to_string()).unwrap();
        let reg = json!({"version": 1,
            "workspaces": [{"id": "W1", "title": "t-W1", "cwd": "/r/a"}, {"id": "W2", "title": "t-W2", "cwd": "/r/b"},
                           {"id": "W3", "title": "t-W3", "cwd": "/r/c"}, {"id": "WB", "title": "Bosun", "cwd": "/r", "kind": "bosun"}],
            "panes": [{"id": "P1", "ws": "W1", "cwd": "/r/a/sub"}, {"id": "P2", "ws": "w1", "cwd": "/r/a"},
                      {"id": "P3", "ws": "W2", "cwd": "/r/b"}, {"id": "PB", "ws": "WB", "cwd": "/r"}]});
        let (w, p) = rows_of(&reg);
        assert!(w.iter().all(|w| w.id != "WB") && p.iter().all(|p| p.id != "PB"), "the Bosun's row and pane are left out");
        let root = |c: &str| c.trim_end_matches("/sub").to_string();
        let got = seats(&reg, &files, &["/r/b".to_string()], &root);
        assert_eq!(got.len(), 2, "W2 is tucked");
        assert_eq!((got[0].pane.as_str(), got[0].state.as_str(), got[0].root.as_str()), ("P2", "working", "/r/a"));
        assert_eq!((got[1].ws.as_str(), got[1].pane.as_str(), got[1].root.as_str(), got[1].state.as_str()), ("W3", "", "/r/c", ""));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn tucked_reads_only_tuck_entries() {
        let d = tmp("tuck");
        let a = d.join("a");
        fs::create_dir_all(&a).unwrap();
        fs::write(d.join("tucked.json"), json!({"version": 1, "entries": [
            {"path": a.to_string_lossy(), "level": "tuck", "at": 1},
            {"path": "/x/muted", "level": "mute", "at": 1}]}).to_string()).unwrap();
        assert_eq!(tucked(&d), vec![real(&a.to_string_lossy())]);
        assert!(tucked(&d.join("missing")).is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").arg("-C").arg(dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
        assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
    }

    #[test]
    fn radar_shows_two_worktrees_on_one_file() {
        let d = tmp("radar");
        let main = d.join("repo");
        fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base"]);
        let wt = d.join("wt");
        git(&main, &["worktree", "add", "-q", "-b", "dev/x", &wt.to_string_lossy()]);
        fs::write(main.join("shared.rs"), "a").unwrap();
        fs::write(wt.join("shared.rs"), "b").unwrap();
        let seat = |id: &str, root: &Path| Seat { ws: id.into(), pane: format!("p{id}"), title: id.into(), root: real(&root.to_string_lossy()), color: None, state: String::new() };
        let f = radar_of(&[seat("A", &main), seat("B", &wt)], &d.join("no-state"), &d.join("no-keys"));
        assert_eq!(f.repos.len(), 1, "{f:?}");
        assert_eq!(f.repos[0].contacts.len(), 2);
        assert_eq!(f.repos[0].collisions, vec!["shared.rs"]);
        let text = radar_text(&f);
        assert!(text.contains("collisions: shared.rs") && text.contains("[dev/x]"), "{text}");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn lookout_lists_app_runs_and_terminal_reviews() {
        let d = tmp("lookout");
        let reviews = d.join("reviews");
        fs::create_dir_all(&reviews).unwrap();
        fs::write(d.join("jobs.json"), json!([
            {"id": "j1", "input": "o/r#5", "repo": "o/r", "branch": "feat", "pr": 5, "status": "ready", "review_id": "r-app", "open": {"major": 1}, "started": 10}
        ]).to_string()).unwrap();
        let rec = |title: &str, root: &str, at: &str, findings: Value, gh: Value| json!({"title": title, "source": {"root": root, "branch": "dev/y"}, "updatedAt": at, "findings": findings, "github": gh}).to_string();
        fs::write(reviews.join("r1.json"), rec("Add retries", "/w/one", "2026-11-22T10:00:00Z",
            json!([{"severity": "minor", "status": "open"}, {"severity": "minor", "status": "resolved"}, {"severity": "blocker"}]),
            json!({"repo": "o/r", "pr": 7, "url": "https://github.com/o/r/pull/7", "state": "OPEN"}))).unwrap();
        fs::write(reviews.join("r2.json"), rec("Newer", "/w/two", "2026-11-22T11:00:00Z", json!([]), Value::Null)).unwrap();
        fs::write(reviews.join("r-app.json"), rec("the app's", "/w/x", "2026-11-22T12:00:00Z", json!([]), Value::Null)).unwrap();
        fs::write(reviews.join("r3.json"), rec("in an app worktree", "/base/wt", "2026-11-22T12:00:00Z", json!([]), Value::Null)).unwrap();
        fs::write(reviews.join("r1.rows.json"), "{}").unwrap();
        fs::write(reviews.join("wake-1.json"), "{}").unwrap();
        let v = lookout_at(&d.join("jobs.json"), &reviews, "/base");
        assert_eq!(v["app"][0]["review"], "r-app");
        assert_eq!(v["app"][0]["open"], json!({"major": 1}));
        let ids: Vec<&str> = v["terminal"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["r2", "r1"], "newest first; the app's own, rows files and wake records left out");
        assert_eq!(v["terminal"][1]["open"], json!({"blocker": 1, "minor": 1}));
        assert_eq!(v["terminal"][1]["pr"]["url"], "https://github.com/o/r/pull/7");
        let text = lookout_text(&v);
        assert!(text.contains("o/r feat #5 [ready]: open: 1 major"), "{text}");
        assert!(text.contains("Add retries (/w/one, dev/y) https://github.com/o/r/pull/7: open: 1 blocker, 1 minor"), "{text}");
        assert_eq!(lookout_text(&lookout_at(&d.join("none.json"), &d.join("none"), "")), "Lookout: no reviews.\n");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn bad_arguments_exit_2() {
        assert_eq!(main(&[]), 2);
        assert_eq!(main(&["nope".to_string()]), 2);
    }
}
