//! /run/<session>/<id>: one run's page beside the terminal, swimlane first
//! (crew/board/run.html, drawn by crew/board/run.js).
//!
//! `/run/<session>/<id>` is the page, with this server's token in it.
//! `/run/<session>/<id>/data?t=` is the run as the adapters report it, in
//! the seamux.run/1 model with transcript paths left out (a bar opens a
//! transcript through /agent, which checks it). `/run/<session>/<id>/events?t=`
//! is a server-sent event stream: a `run` event whenever the run changes,
//! a comment every 15 seconds otherwise. The adapters' results are cached
//! (crew_core::runs::host), so a quiet run costs a file walk per second.

use std::time::{Duration, Instant};

use crew_core::runs::Run;
use serde_json::{json, Value};

use crate::server::{crew_file, ct_eq, log, Request};

const SLOT: &str = "__BOOT__";
const JS_SLOT: &str = "/*__RUN_JS__*/";
/// How often the event stream asks the adapters again.
const TICK: Duration = Duration::from_secs(1);
const PING: Duration = Duration::from_secs(15);

fn plain_id(x: &str) -> bool {
    !x.is_empty() && x.len() <= 128 && !x.starts_with('.') && x.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// What a /run/ path asks for.
#[derive(Debug, PartialEq)]
pub enum Part {
    Page,
    Data,
    Events,
}

pub fn parse_path(path: &str) -> Option<(String, String, Part)> {
    let rest = path.strip_prefix("/run/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let (s, id, part) = match parts.as_slice() {
        [s, id] => (*s, *id, Part::Page),
        [s, id, "data"] => (*s, *id, Part::Data),
        [s, id, "events"] => (*s, *id, Part::Events),
        _ => return None,
    };
    (plain_id(s) && plain_id(id)).then(|| (s.to_string(), id.to_string(), part))
}

/// The run as the page reads it: the model, each agent's transcript path
/// replaced by whether it has one.
pub fn public(run: &Run, session: &str) -> Value {
    let mut v = run.to_json();
    v["session"] = json!(session);
    if let Some(agents) = v.get_mut("agents").and_then(Value::as_array_mut) {
        for a in agents {
            let has = a.get("transcript").is_some_and(|t| t.is_string());
            a["transcript"] = json!(has);
        }
    }
    v
}

/// The run with this id in the session, as every adapter reports it.
fn run_of(session: &str, id: &str) -> Result<Option<Run>, String> {
    let ctx = crew_core::runs::context_for(session, "").ok_or("no such session")?;
    let (adapters, _) = crew_core::runs::host::adapters();
    let rep = crew_core::runs::host::report(&ctx, &adapters, true);
    Ok(rep.runs.into_iter().find(|r| r.id == id))
}

fn boot(token: &str, session: &str, id: &str) -> String {
    crew_core::pyjson::dumps(&json!({"t": token, "session": session, "id": id}))
        .replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026")
}

fn events(req: &mut Request, session: &str, id: &str) {
    req.set_write_timeout(Duration::from_secs(30));
    req.start_stream("text/event-stream");
    let mut out = req.push(b"retry: 3000\n\n");
    let mut last = String::new();
    let mut pinged = Instant::now();
    while out.is_ok() {
        let now = match run_of(session, id) {
            Ok(Some(r)) => public(&r, session).to_string(),
            Ok(None) => json!({"gone": true}).to_string(),
            Err(e) => json!({"error": e}).to_string(),
        };
        if now != last {
            out = req.push(format!("event: run\ndata: {now}\n\n").as_bytes());
            last = now;
            pinged = Instant::now();
        } else if pinged.elapsed() >= PING {
            out = req.push(b": ping\n\n");
            pinged = Instant::now();
        }
        std::thread::sleep(TICK);
    }
}

/// GET /run/... : true when the path was this route's.
pub fn get(req: &mut Request) -> bool {
    let Some((session, id, part)) = parse_path(&req.path.clone()) else { return false };
    if part != Part::Page && !ct_eq(&req.one("t"), &req.token) {
        log("DENY bad token on /run data from 127.0.0.1");
        req.json(403, &json!({"error": "bad token"}));
        return true;
    }
    match part {
        Part::Events => events(req, &session, &id),
        Part::Data => match run_of(&session, &id) {
            Ok(Some(r)) => req.json(200, &public(&r, &session)),
            Ok(None) => req.json(404, &json!({"error": "no adapter reports that run"})),
            Err(e) => req.json(404, &json!({"error": e})),
        },
        Part::Page => {
            let read = |rel: &str| std::fs::read_to_string(crew_file(rel)).map_err(|e| crate::routes::os_err(&e, &crew_file(rel)));
            match (read("board/run.html"), read("board/run.js")) {
                (Ok(html), Ok(js)) => {
                    let html = html.replace(SLOT, &boot(&req.token, &session, &id)).replacen(JS_SLOT, &js, 1);
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
    use crew_core::runs::model::parse_doc;

    #[test]
    fn only_a_plain_session_and_id_are_a_route() {
        assert_eq!(parse_path("/run/s-1/wf_f7b371f3-6f2"), Some(("s-1".into(), "wf_f7b371f3-6f2".into(), Part::Page)));
        assert_eq!(parse_path("/run/s-1/r/data").map(|p| p.2), Some(Part::Data));
        assert_eq!(parse_path("/run/s-1/r/events").map(|p| p.2), Some(Part::Events));
        for bad in ["/run/s", "/run/../r", "/run/s/r/other", "/run/s/.r", "/runs/s/r", "/run//r/data"] {
            assert_eq!(parse_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_page_never_sees_a_transcript_path() {
        let runs = parse_doc(&json!({"schema": "seamux.run/1", "runs": [{"id": "r", "status": "running", "agents": [
            {"id": "a", "state": "done", "transcript": "/w/.claude/projects/p/s/a.jsonl"}, {"id": "b", "state": "running"}]}]}), "x").unwrap();
        let v = public(&runs[0], "s-1");
        assert_eq!((v["session"].as_str(), v["agents"][0]["transcript"].as_bool(), v["agents"][1]["transcript"].as_bool()),
                   (Some("s-1"), Some(true), Some(false)));
        assert!(!v.to_string().contains(".jsonl"));
    }
}
