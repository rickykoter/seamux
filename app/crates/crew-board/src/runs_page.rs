//! /runs/<session>: every background run a session started, on one page
//! beside the terminal (crew/board/runs.html, drawn by crew/board/runs.js).
//!
//! `/runs/<session>` is the page, with this server's token in it.
//! `/runs/<session>/data?t=` is the session's report from every adapter: its
//! runs (in the seamux.run/1 model, transcript paths left out, as on the run
//! page), its notices and each adapter's summary line.
//! `/runs/<session>/events?t=` streams a `runs` event whenever that changes.
//! A run's group (the prompt that launched it, or an adapter's own) is set by
//! crew_core::runs::host::report.

use crew_core::runs::Report;
use serde_json::{json, Value};

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

/// The report as the page reads it.
pub fn public_report(rep: &Report, session: &str) -> Value {
    json!({
        "session": session,
        "runs": rep.runs.iter().map(|r| public(r, session)).collect::<Vec<_>>(),
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
        Ok(rep) => public_report(&rep, session).to_string(),
        Err(e) => json!({"error": e}).to_string(),
    }
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
            Ok(rep) => req.json(200, &public_report(&rep, &session)),
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
        let v = public_report(&rep, "s-1");
        assert_eq!((v["runs"][0]["group"]["label"].as_str(), v["runs"][0]["metrics"][0]["value"].as_str()), (Some("review the branch"), Some("3")));
        assert_eq!(v["runs"][0]["agents"][0]["transcript"].as_bool(), Some(true));
        assert_eq!(v["summaries"][0]["text"].as_str(), Some("lookout: clean"));
        assert_eq!(v["notices"][0]["text"].as_str(), Some("1 background task from teammate: no adapter"));
        assert!(!v.to_string().contains(".jsonl"));
    }
}
