//! The intent server's routes (crew-board-intent's do_GET and do_POST).
//!
//! Every request first passes the Host check. The routes that act (/do,
//! /open, /answer, /inc, /check/*, a review's record and its POST) need the token;
//! pages this server serves carry it injected, and their data routes answer
//! without an open CORS header.

use serde_json::{json, Value};

use crate::server::{ct_eq, crew_file, log, Request};
use crate::{act, ask, plans, review, usage};

pub const PLAN_JS: &str = include_str!("inject/plan.js");

/// Refuse any Host but this server's own loopback name and port: a
/// DNS-rebound page would otherwise be same-origin with a served token.
fn host_ok(req: &mut Request) -> bool {
    let want = [format!("127.0.0.1:{}", req.port), format!("localhost:{}", req.port)];
    let host = req.header("Host").map(String::from);
    if host.as_deref().map(|h| want.iter().any(|w| w == h)).unwrap_or(false) {
        return true;
    }
    log(&format!("DENY host {}", match &host { Some(h) => format!("{h:?}").replace('"', "'"), None => "None".into() }));
    req.json(403, &json!({"error": "unknown host"}));
    false
}

fn token_ok(req: &Request, t: &str) -> bool {
    ct_eq(t, &req.token)
}

/// Insert a boot script before the first `</body>`, or append it.
fn inject_first(html: &str, boot: &str) -> String {
    match html.find("</body>") {
        Some(i) => format!("{}{}{}", &html[..i], boot, &html[i..]),
        None => format!("{html}{boot}"),
    }
}

/// An OSError as Python's str(exc) gives it: "[Errno 2] No such file or directory: '/path'".
pub fn os_err(e: &std::io::Error, p: &std::path::Path) -> String {
    let full = crew_core::py::os_error(e, p);
    full.split_once(": ").map(|(_, rest)| rest.to_string()).unwrap_or(full)
}

fn read_lossy(p: &std::path::Path) -> std::io::Result<String> {
    std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned())
}

pub fn get(req: &mut Request) {
    if !host_ok(req) {
        return;
    }
    let path = req.path.clone();
    match path.as_str() {
        "/health" => return req.reply(200, br#"{"ok":true}"#),
        // One cached copy for every plan page; public, so no token.
        "/mermaid.min.js" => {
            return match std::fs::read(crew_core::dp_engine::mermaid()) {
                Ok(body) => req.send(200, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable", &body),
                Err(_) => req.reply(404, br#"{"error":"no vendored mermaid"}"#),
            };
        }
        "/usage" => {
            // Read per request: editing the dashboard needs no restart.
            let f = crew_file("board/usage.tmpl.html");
            return match std::fs::read_to_string(&f) {
                Ok(tmpl) => req.send(200, "text/html; charset=utf-8", "no-store", usage::page(&tmpl).as_bytes()),
                Err(e) => req.reply_json(500, &json!({"error": os_err(&e, &f)})),
            };
        }
        "/plan-stamp" => {
            let mt = plans::plan_asset(&req.one("slug"))
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| crew_core::py::mtime(&m) as i64)
                .unwrap_or(0);
            return req.reply_json(200, &json!({"mtime": mt}));
        }
        "/open" => {
            if !token_ok(req, &req.one("t")) {
                log("DENY bad token on /open from 127.0.0.1");
                return req.reply(403, br#"{"error":"bad token"}"#);
            }
            let (ok, detail) = plans::open_file(&req.one("slug"), &req.one("path"));
            log(&format!("{} open {detail}", if ok { "OK  " } else { "FAIL" }));
            return req.reply_json(if ok { 200 } else { 500 }, &json!({"ok": ok, "detail": detail}));
        }
        "/answer" => {
            if !token_ok(req, &req.one("t")) {
                log("DENY bad token on /answer from 127.0.0.1");
                return req.reply(403, br#"{"error":"bad token"}"#);
            }
            let id = req.one("id");
            let (ok, delivered, detail) = ask::answer(&id, &req.one("n"), &ask::Cmux);
            log(&format!("{} answer {id}: {detail}", if ok { "OK  " } else { "FAIL" }));
            return req.reply_json(if ok { 200 } else { 400 }, &json!({"ok": ok, "delivered": delivered, "detail": detail}));
        }
        "/inc" => {
            if !token_ok(req, &req.one("t")) {
                log("DENY bad token on /inc from 127.0.0.1");
                return req.reply(403, br#"{"error":"bad token"}"#);
            }
            let (ok, detail) = plans::increment(&req.one("slug"), &req.one("n"), &req.one("a"), &req.one("why"));
            log(&format!("{} inc {detail}", if ok { "OK  " } else { "FAIL" }));
            return req.reply_json(if ok { 200 } else { 500 }, &json!({"ok": ok, "detail": detail}));
        }
        // The Wake. The page carries the token, like /plan/ and /review/; the
        // data and open routes answer without an open CORS header.
        "/artifacts" => {
            return match crate::wake::wake_page(&req.one("ws"), &req.token) {
                Ok(html) => req.send(200, "text/html; charset=utf-8", "no-store", html.as_bytes()),
                Err(e) => req.json(500, &json!({"error": os_err(&e, &crew_file("board/artifacts.tmpl.html"))})),
            };
        }
        "/artifacts/data" => {
            if !token_ok(req, &req.one("t")) {
                log("DENY bad token on /artifacts/data from 127.0.0.1");
                return req.json(403, &json!({"error": "bad token"}));
            }
            return match crate::wake::wake_data(&req.one("ws"), &req.one("q"), &req.one("kind")) {
                Ok(v) => req.json(200, &v),
                Err(e) => {
                    log(&format!("FAIL artifacts data: {e}"));
                    req.json(500, &json!({"error": format!("the artifact store could not be read: {e}")}))
                }
            };
        }
        "/artifacts/open" => {
            if !token_ok(req, &req.one("t")) {
                log("DENY bad token on /artifacts/open from 127.0.0.1");
                return req.json(403, &json!({"error": "bad token"}));
            }
            let id = req.one("id");
            let (ok, detail) = crate::wake::open_artifact(&id, req.port, &req.one("s"));
            log(&format!("{} artifacts open {id}: {detail}", if ok { "OK  " } else { "FAIL" }));
            return req.json(if ok { 200 } else { 400 }, &json!({"ok": ok, "detail": detail}));
        }
        // A browser or claiming check, from the plan page: run it, answer
        // its claim, bring its tab forward, or read its evidence. Token-checked
        // like /inc; none of them can pass a check.
        "/check/run" | "/check/answer" | "/check/tab" | "/check/evidence" | "/check/proof" => {
            let mut verb = path.trim_start_matches("/check/").to_string();
            // Proof is built locally; with attach=1 it goes on the PR (the page
            // asked the person first).
            if verb == "proof" && req.one("attach") == "1" {
                verb = "attach".into();
            }
            if !token_ok(req, &req.one("t")) {
                log(&format!("DENY bad token on /check/{verb} from 127.0.0.1"));
                return req.reply(403, br#"{"error":"bad token"}"#);
            }
            let (slug, n, id) = (req.one("slug"), req.one("n"), req.one("id"));
            return match plans::check_action(&verb, &slug, &n, &id, &req.one("name"), &req.one("value")) {
                Ok(out) if verb == "evidence" || verb == "proof" => match serde_json::from_str::<Value>(&out) {
                    Ok(v) => req.reply_json(200, &v),
                    Err(_) => req.reply_json(500, &json!({"ok": false, "detail": "deep-plan's evidence was not JSON"})),
                },
                Ok(out) => {
                    let detail: String = out.trim().lines().last().unwrap_or("").chars().take(200).collect();
                    log(&format!("OK   check {verb} {slug} {n} {id}"));
                    req.reply_json(200, &json!({"ok": true, "detail": detail}))
                }
                Err(e) => req.reply_json(400, &json!({"ok": false, "detail": e})),
            };
        }
        "/do" => return do_action(req),
        "/board" => return board_page(req),
        "/board/events" => return board_events(req),
        _ => {}
    }
    if let Some(rest) = path.strip_prefix("/plan/") {
        return plan(req, rest);
    }
    // A browser run's frames, replay and trace, for the plan page's filmstrip
    // and the board's thumbnails. Read-only and confined to the plan's runs
    // directory, like the plan pages themselves; no token.
    if let Some(rest) = path.strip_prefix("/plan-evidence/") {
        let Some((slug, rel)) = rest.split_once('/') else { return req.reply(404, br#"{"error":"no such evidence"}"#) };
        let Some(file) = plans::evidence_file(slug, rel) else { return req.reply(404, br#"{"error":"no such evidence"}"#) };
        let ctype = if rel.ends_with(".png") { "image/png" } else { "text/plain; charset=utf-8" };
        return match std::fs::read(&file) {
            // Not cached: a frame copied while the recorder was still writing it
            // is copied again, and the trace grows while a run goes on.
            Ok(body) => req.send(200, ctype, "no-store", &body),
            Err(e) => req.reply_json(500, &json!({"error": os_err(&e, &file)})),
        };
    }
    if let Some(rest) = path.strip_prefix("/review/") {
        return review_get(req, rest);
    }
    if let Some(rest) = path.strip_prefix("/ask/") {
        let Some(page) = ask::ask_path(rest, ".html") else { return req.reply(404, br#"{"error":"no such ask"}"#) };
        return match read_lossy(&page) {
            Ok(html) => {
                let html = plans::swap_mermaid(&html);
                let boot = ask::ASK_JS.replace("__TOKEN__", &req.token).replace("__ID__", rest);
                req.send(200, "text/html; charset=utf-8", "no-store", inject_first(&html, &boot).as_bytes())
            }
            Err(e) => req.reply_json(500, &json!({"error": e.to_string()})),
        };
    }
    req.reply(404, br#"{"error":"no such path"}"#)
}

/// A plan's live surface with its buttons wired, or its markdown as text.
fn plan(req: &mut Request, slug: &str) {
    let Some(page) = plans::plan_asset(slug) else { return req.reply(404, br#"{"error":"no such plan page"}"#) };
    let html = match read_lossy(&page) {
        Ok(h) => h,
        Err(e) => return req.reply_json(500, &json!({"error": e.to_string()})),
    };
    if page.to_string_lossy().ends_with(".md") {
        return req.send(200, "text/plain; charset=utf-8", "no-store", html.as_bytes());
    }
    let html = plans::swap_mermaid(&html);
    let boot = PLAN_JS.replace("__TOKEN__", &req.token).replace("__SLUG__", slug);
    req.send(200, "text/html; charset=utf-8", "no-store", inject_first(&html, &boot).as_bytes())
}

fn review_get(req: &mut Request, rest: &str) {
    if let Some(rid) = rest.strip_suffix(".json") {
        if !token_ok(req, &req.one("t")) {
            log("DENY bad token on /review json from 127.0.0.1");
            return req.json(403, &json!({"error": "bad token"}));
        }
        let Some(page) = review::review_path(rid, ".json") else { return req.json(404, &json!({"error": "no such review"})) };
        return match std::fs::read(page) {
            Ok(body) => req.send(200, "application/json", "no-store", &body),
            Err(e) => req.json(500, &json!({"error": e.to_string()})),
        };
    }
    let Some(page) = review::review_path(rest, ".html") else { return req.json(404, &json!({"error": "no such review"})) };
    let html = match read_lossy(&page) {
        Ok(h) => h,
        Err(e) => return req.json(500, &json!({"error": e.to_string()})),
    };
    let boot = review::REVIEW_JS.replace("__TOKEN__", &req.token).replace("__ID__", rest);
    // Before the LAST </body>, as the Python does for a review page.
    let out = match html.rfind("</body>") {
        Some(i) => format!("{}{}{}", &html[..i], boot, &html[i..]),
        None => format!("{html}{boot}"),
    };
    req.send(200, "text/html; charset=utf-8", "no-store", out.as_bytes())
}

fn do_action(req: &mut Request) {
    if !token_ok(req, &req.one("t")) {
        log("DENY bad token from 127.0.0.1");
        return req.reply(403, br#"{"error":"bad token"}"#);
    }
    let (action, rid, extra) = (req.one("a"), req.one("r"), req.one("x"));
    if !act::ACTIONS.contains(&action.as_str()) {
        return req.reply(400, br#"{"error":"unknown action"}"#);
    }
    let row = act::targets().get(&rid).and_then(Value::as_object).cloned().unwrap_or_default();
    if row.is_empty() && action != "sync" {
        return req.reply(404, br#"{"error":"unknown row"}"#);
    }
    let (ok, detail) = act::act(&action, &row, &extra);
    log(&format!("{} {action} {detail}", if ok { "OK  " } else { "FAIL" }));
    req.reply_json(if ok { 200 } else { 500 }, &json!({"ok": ok, "detail": detail}))
}

/// Every POST's guards, in order: this server's own Origin, a JSON body
/// under the cap, the token inside it. None after replying with the refusal.
fn post_body(req: &mut Request) -> Option<serde_json::Map<String, Value>> {
    let want = [format!("http://127.0.0.1:{}", req.port), format!("http://localhost:{}", req.port)];
    if !req.header("Origin").map(|o| want.iter().any(|w| w == o)).unwrap_or(false) {
        log(&format!("DENY POST {} from origin {:?}", req.path, req.header("Origin").unwrap_or("None")));
        req.json(403, &json!({"error": "cross-origin request refused"}));
        return None;
    }
    let ctype = req.header("Content-Type").unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
    if ctype != "application/json" {
        req.json(415, &json!({"error": "JSON only"}));
        return None;
    }
    let length: i64 = req.header("Content-Length").map(|v| v.trim().parse().unwrap_or(-1)).unwrap_or(-1);
    if length < 0 {
        req.json(411, &json!({"error": "length required"}));
        return None;
    }
    if length as usize > review::MAX_BODY {
        req.json(413, &json!({"error": "too large"}));
        return None;
    }
    let raw = req.read_body(length as usize);
    let parsed: Result<Value, _> = if raw.is_empty() { Ok(json!({})) } else { serde_json::from_slice(&raw) };
    let body = match parsed {
        Ok(Value::Object(o)) => o,
        Ok(_) => {
            req.json(400, &json!({"error": "not a JSON object"}));
            return None;
        }
        Err(_) => {
            req.json(400, &json!({"error": "not JSON"}));
            return None;
        }
    };
    let t = body.get("t").map(crate::pyval::str_or_empty).unwrap_or_default();
    if !token_ok(req, &t) {
        log(&format!("DENY bad token on POST {} from 127.0.0.1", req.path));
        req.json(403, &json!({"error": "bad token"}));
        return None;
    }
    Some(body)
}

pub fn post(req: &mut Request) {
    if !host_ok(req) {
        return;
    }
    let path = req.path.clone();
    let wake = path == "/artifacts/keep" || path == "/artifacts/publish";
    if !(path.starts_with("/review/") || wake) {
        return req.json(404, &json!({"error": "no such path"}));
    }
    let Some(body) = post_body(req) else { return };
    if path == "/artifacts/keep" {
        let (code, out) = crate::wake::keep(&body);
        return req.json(code, &out);
    }
    if path == "/artifacts/publish" {
        let Some(rid) = body.get("id").and_then(|v| if v.is_i64() || v.is_u64() { v.as_i64() } else { None }) else {
            return req.json(400, &json!({"error": "bad id"}));
        };
        let (ok, detail) = crate::wake::publish_artifact(rid);
        log(&format!("{} artifacts publish {rid}: {detail}", if ok { "OK  " } else { "FAIL" }));
        return req.json(if ok { 200 } else { 400 }, &json!({"ok": ok, "detail": detail}));
    }
    let rid = &path["/review/".len()..];
    if review::review_path(rid, ".json").is_none() {
        return req.json(404, &json!({"error": "no such review"}));
    }
    let (code, out) = review::apply(rid, &body);
    let what = out.get("error").or_else(|| out.get("item")).map(crate::pyval::py_str).unwrap_or_default();
    log(&format!("{} review {rid} {} {what}", if code == 200 { "OK  " } else { "FAIL" },
                 body.get("op").map(crate::pyval::py_str).unwrap_or("None".into())));
    req.json(code, &out)
}

/// board.html with render.js, intent.js and the feed's boot script: the board
/// as a page this server serves, for the app's tab or any cmux browser pane.
fn board_page(req: &mut Request) {
    let read = |rel: &str| {
        let f = crew_file(rel);
        std::fs::read(&f).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| os_err(&e, &f))
    };
    let (html, render, intent) = match (read("board/board.html"), read("board/render.js"), read("board/intent.js")) {
        (Ok(h), Ok(r), Ok(i)) => (h, r, i),
        (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return req.json(500, &json!({"error": e})),
    };
    let boot = format!("<script>\n{render}\n</script>\n<script>\n{intent}\n</script>\n{}",
        crate::board_feed::BOARD_JS.replace("__TOKEN__", &req.token).replace("__PORT__", &req.port.to_string()));
    req.send(200, "text/html; charset=utf-8", "no-store", inject_first(&html, &boot).as_bytes())
}

/// The ranked state as server-sent events: one `state` event per change, the
/// latest at once on connect, a comment every 15s to find a closed client.
fn board_events(req: &mut Request) {
    if !token_ok(req, &req.one("t")) {
        log("DENY bad token on /board/events from 127.0.0.1");
        return req.json(403, &json!({"error": "bad token"}));
    }
    // A reader that stops reading (a suspended tab) ends its stream after
    // 30s of a blocked write, rather than holding the worker up for ever.
    req.set_write_timeout(std::time::Duration::from_secs(30));
    req.start_stream("text/event-stream");
    let feed = crate::board_feed::feed();
    let q = feed.subscribe();
    let mut out = req.push(b"retry: 3000\n\n");
    while out.is_ok() {
        out = match feed.wait(&q, std::time::Duration::from_secs(15)) {
            Some(line) => req.push(format!("event: state\ndata: {line}\n\n").as_bytes()),
            None => req.push(b": ping\n\n"),
        };
    }
    feed.unsubscribe(&q);
}
