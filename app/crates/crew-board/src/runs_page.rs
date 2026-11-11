//! /runs/<session>: every background run a session started, on one page
//! beside the terminal (crew/board/runs.html, drawn by crew/board/runs.js).
//!
//! `/runs/<session>` is the page, with this server's token in it.
//! `/runs/<session>/data?t=` is the session's report from every adapter: its
//! runs (in the seamux.run/1 model, transcript paths left out, as on the run
//! page), its notices and each adapter's summary line.
//! `/runs/<session>/events?t=` streams a `runs` event whenever that changes.
//! `POST /runs/<session>/open` with `{t, run, link}` opens one of a run's
//! links: a file in the session's worktree in VS Code at its line (through
//! crew-code), or an http(s) page. The page names the link by its run and
//! index, never by a path; the server finds it again in a fresh report and
//! opens a file only when it resolves inside the worktree. The data marks
//! each link `opens` so the page shows the rest as plain text.
//! A run's group (the prompt that launched it, or an adapter's own) is set by
//! crew_core::runs::host::report.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crew_core::runs::model::Link;
use crew_core::runs::Report;
use serde_json::{json, Map, Value};

use crate::run_page::{boot, public, stream};
use crate::server::{crew_file, ct_eq, log, Request};

const SLOT: &str = "__BOOT__";
const JS_SLOT: &str = "/*__RUNS_JS__*/";

/// What a /runs/ path asks for.
#[derive(Debug, PartialEq)]
pub enum Part {
    Page,
    Data,
    Events,
}

/// A session id as Claude Code makes them (a uuid): letters, digits, `-`
/// and `_`. The app's Dock, intent.js and render.js check the same.
pub fn session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn parse_path(path: &str) -> Option<(String, Part)> {
    let rest = path.strip_prefix("/runs/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let (s, part) = match parts.as_slice() {
        [s] => (*s, Part::Page),
        [s, "data"] => (*s, Part::Data),
        [s, "events"] => (*s, Part::Events),
        _ => return None,
    };
    session_id(s).then(|| (s.to_string(), part))
}

fn cwd_of(line: &str) -> Option<PathBuf> {
    if !line.contains("\"cwd\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    v.get("cwd").and_then(Value::as_str).filter(|c| c.starts_with('/')).map(PathBuf::from)
}

/// How far from its end a transcript is read for the session's folder now.
const TAIL: u64 = 256 * 1024;

/// The folder the session works in: the last `cwd` its transcript records
/// near its end (each line carries the folder at that moment), else the
/// first one near its start.
pub fn session_cwd(transcript: &Path) -> Option<PathBuf> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(transcript).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL);
    let mut tail = Vec::new();
    f.seek(SeekFrom::Start(from)).ok()?;
    f.take(TAIL).read_to_end(&mut tail).ok()?;
    let text = String::from_utf8_lossy(&tail);
    // The first line of a cut tail is partial: skip it.
    let lines = text.lines().skip(usize::from(from > 0));
    if let Some(c) = lines.filter_map(cwd_of).last() {
        return Some(c);
    }
    let f = std::fs::File::open(transcript).ok()?;
    BufReader::new(f).lines().map_while(Result::ok).take(200).find_map(|l| cwd_of(&l))
}

/// The worktree a folder is in: the nearest folder up holding `.git` (a
/// worktree's is a file), resolved through symlinks. Never the home folder
/// or one above it: a session started outside any project opens no files.
pub fn worktree_of(dir: &Path, home: &Path) -> Option<PathBuf> {
    let dir = std::fs::canonicalize(dir).ok()?;
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    dir.ancestors().find(|d| d.join(".git").exists())
        .filter(|root| !home.starts_with(root) && root.parent().is_some())
        .map(Path::to_path_buf)
}

/// What a link opens, once checked.
#[derive(Debug, PartialEq)]
pub enum Target {
    File(PathBuf, Option<u64>),
    Url(String),
}

/// A link checked against the session's worktree: a file must exist and
/// resolve, symlinks and `..` followed, inside `root`; a URL must be http(s).
pub fn resolve(link: &Link, root: Option<&Path>) -> Result<Target, String> {
    if let Some(u) = &link.url {
        return if u.starts_with("https://") || u.starts_with("http://") { Ok(Target::Url(u.clone())) }
            else { Err("only http and https links open".into()) };
    }
    let f = link.file.as_deref().ok_or("the link names nothing to open")?;
    let root = root.ok_or("this session's worktree is not known")?;
    let real = std::fs::canonicalize(f).map_err(|_| format!("{f} is not there"))?;
    if !real.starts_with(root) || !real.is_file() {
        return Err(format!("{f} is outside this session's worktree"));
    }
    Ok(Target::File(real, link.line))
}

/// The session's worktree, from its transcript; read again only when the
/// transcript changed, since the page's feed asks every second.
fn root_of(session: &str) -> Option<PathBuf> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    type Seen = (u128, u64, Option<PathBuf>);
    static CACHE: Mutex<Option<HashMap<String, Seen>>> = Mutex::new(None);
    let t = crew_core::runs::session_dir(session)?.with_extension("jsonl");
    let md = std::fs::metadata(&t).ok()?;
    let mtime = md.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    if let Some((m, l, root)) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|c| c.get(session)) {
        if *m == mtime && *l == md.len() {
            return root.clone();
        }
    }
    let root = session_cwd(&t).and_then(|c| worktree_of(&c, &crew_core::py::home()));
    let mut c = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let map = c.get_or_insert_with(HashMap::new);
    if map.len() > 64 {
        map.clear();
    }
    map.insert(session.to_string(), (mtime, md.len(), root.clone()));
    root
}

/// What the page showed for a link, which an open must name again: the file
/// and line, or the URL.
pub fn shown(link: &Link) -> String {
    match (&link.file, &link.url) {
        (Some(f), _) => format!("{f}:{}", link.line.unwrap_or(0)),
        (None, Some(u)) => u.clone(),
        _ => String::new(),
    }
}

/// The report as the page reads it, each link marked with whether it opens.
pub fn public_report(rep: &Report, session: &str, root: Option<&Path>) -> Value {
    let runs: Vec<Value> = rep.runs.iter().map(|r| {
        let mut v = public(r, session);
        if let Some(ls) = v.get_mut("links").and_then(Value::as_array_mut) {
            for (l, out) in r.links.iter().zip(ls.iter_mut()) {
                out["opens"] = json!(resolve(l, root).is_ok());
                out["shown"] = json!(shown(l));
            }
        }
        v
    }).collect();
    json!({
        "session": session,
        "runs": runs,
        "notices": rep.notices.iter().map(|n| json!({"kind": n.kind, "text": n.text()})).collect::<Vec<_>>(),
        "summaries": rep.summaries.iter().map(|(a, t)| json!({"source": a, "text": t})).collect::<Vec<_>>(),
    })
}

/// Every adapter's report on the session, finished runs included.
fn report_of(session: &str) -> Result<Report, String> {
    let ctx = crew_core::runs::context_for(session, "").ok_or("no such session")?;
    let (adapters, bad) = crew_core::runs::host::adapters();
    let mut rep = crew_core::runs::host::report(&ctx, &adapters, true);
    rep.notices.extend(bad);
    Ok(rep)
}

fn now(session: &str) -> String {
    match report_of(session) {
        Ok(rep) => public_report(&rep, session, root_of(session).as_deref()).to_string(),
        Err(e) => json!({"error": e}).to_string(),
    }
}

/// The session a `POST /runs/<session>/open` names.
pub fn open_path(path: &str) -> Option<String> {
    let s = path.strip_prefix("/runs/")?.strip_suffix("/open")?;
    session_id(s).then(|| s.to_string())
}

/// Open one of a run's links, found again in a fresh report.
pub fn open(session: &str, body: &Map<String, Value>) -> (u16, Value) {
    let run = body.get("run").and_then(Value::as_str).unwrap_or("");
    let Some(i) = body.get("link").and_then(Value::as_u64) else { return (400, json!({"ok": false, "detail": "bad link"})) };
    let rep = match report_of(session) {
        Ok(r) => r,
        Err(e) => return (404, json!({"ok": false, "detail": e})),
    };
    let Some(link) = rep.runs.iter().find(|r| r.id == run).and_then(|r| r.links.get(i as usize)) else {
        return (404, json!({"ok": false, "detail": "no adapter lists that link"}));
    };
    // The report may have changed since the page drew: open only the link
    // the person saw.
    if body.get("shown").and_then(Value::as_str) != Some(shown(link).as_str()) {
        return (409, json!({"ok": false, "detail": "that link changed since the page showed it; try again"}));
    }
    let root = root_of(session);
    let (ok, detail) = match resolve(link, root.as_deref()) {
        Err(e) => (false, e),
        Ok(Target::Url(u)) => (crate::act::run_ok("open", &[&u], None), format!("opened {u}")),
        Ok(Target::File(f, line)) => {
            let at = match line { Some(n) => format!("{}:{n}", f.display()), None => f.display().to_string() };
            let root = root.unwrap_or_default();
            let mut cmd = std::process::Command::new("bash");
            cmd.arg(crew_file("bin/crew-code")).arg(&root).arg("--goto").arg(&at);
            match crate::act::spawn_wait(cmd, Duration::from_secs(20)) {
                Some((0, _, _)) => (true, format!("opened {at}")),
                Some((rc, _, err)) => (false, format!("crew-code exited {rc}: {}", err.trim().lines().last().unwrap_or(""))),
                None => (false, "crew-code did not finish".into()),
            }
        }
    };
    log(&format!("{} runs open {session} {run}#{i}: {detail}", if ok { "OK  " } else { "FAIL" }));
    (if ok { 200 } else { 400 }, json!({"ok": ok, "detail": detail}))
}

/// GET /runs/... : true when the path was this route's.
pub fn get(req: &mut Request) -> bool {
    let Some((session, part)) = parse_path(&req.path.clone()) else { return false };
    if part != Part::Page && !ct_eq(&req.one("t"), &req.token) {
        log("DENY bad token on /runs data from 127.0.0.1");
        req.json(403, &json!({"error": "bad token"}));
        return true;
    }
    match part {
        Part::Events => stream(req, "runs", &|| now(&session)),
        Part::Data => match report_of(&session) {
            Ok(rep) => req.json(200, &public_report(&rep, &session, root_of(&session).as_deref())),
            Err(e) => req.json(404, &json!({"error": e})),
        },
        Part::Page => {
            let read = |rel: &str| std::fs::read_to_string(crew_file(rel)).map_err(|e| crate::routes::os_err(&e, &crew_file(rel)));
            match (read("board/runs.html"), read("board/runs.js")) {
                (Ok(html), Ok(js)) => {
                    let html = html.replace(SLOT, &boot(&req.token, &session, "")).replacen(JS_SLOT, &js, 1);
                    req.send(200, "text/html; charset=utf-8", "no-store", html.as_bytes());
                }
                (Err(e), _) | (_, Err(e)) => req.json(500, &json!({"error": e})),
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_core::runs::model::parse_document;

    #[test]
    fn only_a_plain_session_is_a_route() {
        assert_eq!(parse_path("/runs/s-1"), Some(("s-1".into(), Part::Page)));
        assert_eq!(parse_path("/runs/s-1/data").map(|p| p.1), Some(Part::Data));
        assert_eq!(parse_path("/runs/s-1/events").map(|p| p.1), Some(Part::Events));
        for bad in ["/runs/", "/runs/..", "/runs/.s", "/runs/s/other", "/runs/s/r/data", "/run/s", "/runs//data", "/runs/s.1"] {
            assert_eq!(parse_path(bad), None, "{bad}");
        }
    }

    fn link(file: Option<&str>, url: Option<&str>) -> Link {
        Link { label: "x".into(), file: file.map(str::to_string), line: Some(3), url: url.map(str::to_string) }
    }

    #[test]
    fn a_link_opens_only_a_file_inside_the_worktree_or_a_web_page() {
        let base = std::env::temp_dir().join(format!("crew-runs-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let wt = base.join("wt");
        std::fs::create_dir_all(wt.join("src/deep")).unwrap();
        std::fs::write(wt.join(".git"), "gitdir: /elsewhere\n").unwrap();
        std::fs::write(wt.join("src/a.rs"), "x").unwrap();
        std::fs::write(base.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(base.join("secret"), wt.join("src/out")).unwrap();
        let root = worktree_of(&wt.join("src/deep"), Path::new("/nowhere-home")).unwrap();
        // A .git at or above the home folder is no worktree to open files in.
        assert_eq!(worktree_of(&wt.join("src/deep"), &wt.join("src")), None, "the root would hold the home folder");
        assert_eq!(worktree_of(&wt.join("src/deep"), &wt), None, "the root is the home folder");
        assert_eq!(root, std::fs::canonicalize(&wt).unwrap(), "the nearest folder holding .git, a worktree's file included");
        let s = |p: &Path| p.display().to_string();
        assert_eq!(resolve(&link(Some(&s(&wt.join("src/a.rs"))), None), Some(&root)),
                   Ok(Target::File(root.join("src/a.rs"), Some(3))));
        for bad in [s(&base.join("secret")), s(&wt.join("src/../../secret")), s(&wt.join("src/out")), s(&wt.join("src")), s(&wt.join("nope.rs"))] {
            assert!(resolve(&link(Some(&bad), None), Some(&root)).is_err(), "{bad}");
        }
        assert!(resolve(&link(Some(&s(&wt.join("src/a.rs"))), None), None).is_err(), "no worktree known, no file opens");
        assert_eq!(resolve(&link(None, Some("https://example.test/r")), None), Ok(Target::Url("https://example.test/r".into())));
        assert!(resolve(&link(None, Some("file:///etc/hosts")), None).is_err());
        // The transcript's first cwd is the session's folder.
        let t = base.join("s.jsonl");
        std::fs::write(&t, format!("{{\"type\":\"x\"}}\n{{\"cwd\":\"{}\"}}\n{{\"cwd\":\"{}\"}}\n", s(&base), s(&wt))).unwrap();
        assert_eq!(session_cwd(&t), Some(wt.clone()), "the folder it is in now, the last one recorded");
        assert_eq!(shown(&link(Some("/w/a.rs"), None)), "/w/a.rs:3");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_a_plain_session_has_an_open_route() {
        assert_eq!(open_path("/runs/s-1/open").as_deref(), Some("s-1"));
        for bad in ["/runs/s-1", "/runs/../open", "/runs/s.1/open", "/runs/s/x/open", "/runs//open"] {
            assert_eq!(open_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_page_gets_groups_summaries_and_notices_but_no_transcript_path() {
        let doc = parse_document(&json!({"schema": "seamux.run/1", "summary": "lookout: clean", "runs": [{"id": "r", "status": "done",
            "group": {"id": "p1", "label": "review the branch", "kind": "prompt"},
            "metrics": [{"label": "read", "value": 3}],
            "agents": [{"id": "a", "state": "done", "transcript": "/w/.claude/projects/p/s/a.jsonl"}]}]}), "lookout").unwrap();
        let rep = Report {
            runs: doc.runs,
            notices: vec![crew_core::runs::Notice { kind: "missing".into(), adapter: None, task_type: Some("teammate".into()), count: 1, why: "no adapter".into() }],
            summaries: vec![("lookout".into(), doc.summary.unwrap())],
        };
        let v = public_report(&rep, "s-1", None);
        assert_eq!((v["runs"][0]["group"]["label"].as_str(), v["runs"][0]["metrics"][0]["value"].as_str()), (Some("review the branch"), Some("3")));
        assert_eq!(v["runs"][0]["agents"][0]["transcript"].as_bool(), Some(true));
        assert_eq!(v["summaries"][0]["text"].as_str(), Some("lookout: clean"));
        assert_eq!(v["notices"][0]["text"].as_str(), Some("1 background task from teammate: no adapter"));
        assert!(!v.to_string().contains(".jsonl"));
    }
}
