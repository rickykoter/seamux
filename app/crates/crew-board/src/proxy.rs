//! The plan, ask, check and review routes are the plugins' own now: deep-plan
//! serve and lookout serve (deep-plan/lib/serve.mjs, lookout/lib/serve.mjs)
//! implement them, and this forwards to them so every page keeps this
//! server's origin. The seamux app, the Dock URLs and the board's thumbnails
//! all assume one origin (ADR 0040), so a redirect would break them where a
//! proxy does not.
//!
//! Each plugin records its server in ~/.claude/<plugin>/serve.json. A record
//! is trusted only when its pid answers /health as that plugin; otherwise the
//! plugin's own CLI starts one (`serve`). Host and Origin are rewritten to the
//! plugin's; the body, the status and the page's own token pass through. The
//! token check is the plugin's: its page carries its token, not this one.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::server::{log, Request};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Plugin {
    DeepPlan,
    Lookout,
}

impl Plugin {
    fn name(self) -> &'static str {
        match self {
            Plugin::DeepPlan => "deep-plan",
            Plugin::Lookout => "lookout",
        }
    }

    fn serve_file(self) -> PathBuf {
        let (var, dir) = match self {
            Plugin::DeepPlan => ("DEEP_PLAN_SERVE_FILE", "deep-plan"),
            Plugin::Lookout => ("LOOKOUT_SERVE_FILE", "lookout"),
        };
        match std::env::var(var).ok().filter(|s| !s.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => crew_core::py::home().join(".claude").join(dir).join("serve.json"),
        }
    }

    /// (node, the plugin's CLI script), when both are on this machine.
    fn cli(self) -> Option<(String, String)> {
        match self {
            Plugin::Lookout => crate::act::lookout_engine(),
            Plugin::DeepPlan => {
                let script = crew_core::dp_engine::script();
                let node = crate::act::node()?;
                script.is_file().then(|| (node, script.to_string_lossy().into_owned()))
            }
        }
    }
}

/// Which plugin serves a GET path, if any.
pub fn owner_get(path: &str) -> Option<Plugin> {
    const DEEP_PLAN: [&str; 9] = ["/mermaid.min.js", "/plan-stamp", "/open", "/answer", "/inc",
        "/check/run", "/check/answer", "/check/tab", "/check/evidence"];
    if DEEP_PLAN.contains(&path) || path == "/check/proof"
        || ["/plan/", "/plan-evidence/", "/ask/"].iter().any(|p| path.starts_with(p)) {
        return Some(Plugin::DeepPlan);
    }
    path.starts_with("/review/").then_some(Plugin::Lookout)
}

/// One plain HTTP/1.0 exchange with a plugin server: (status, headers, body).
pub(crate) fn exchange(port: u16, method: &str, target: &str, headers: &[(&str, String)], body: &[u8], timeout: Duration)
    -> std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800))?;
    s.set_read_timeout(Some(timeout))?;
    s.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut head = format!("{method} {target} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    s.write_all(head.as_bytes())?;
    s.write_all(body)?;
    s.flush()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw)?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "no header end"))?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "no status"))?;
    let hdrs = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
    Ok((status, hdrs, raw[split + 4..].to_vec()))
}

/// The plugin's live server port: its record's pid answers /health as it.
/// A server that accepts the connection but is slow to answer (busy under a
/// review's lock) is still the live one: starting another would hand the
/// open pages a new token.
fn live_port(p: Plugin) -> Option<u16> {
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(p.serve_file()).ok()?).ok()?;
    let port = rec.get("port").and_then(Value::as_u64)? as u16;
    let pid = rec.get("pid").and_then(Value::as_i64)?;
    match exchange(port, "GET", "/health", &[], b"", Duration::from_secs(5)) {
        Ok((code, _, body)) => {
            let h: Value = serde_json::from_slice(&body).ok()?;
            (code == 200 && h.get("server").and_then(Value::as_str) == Some(p.name())
                && h.get("pid").and_then(Value::as_i64) == Some(pid)).then_some(port)
        }
        // Connected, then timed out: alive and busy, if the pid is.
        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
            && pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0 => Some(port),
        Err(_) => None,
    }
}

/// One start at a time per plugin: requests that find no server while one is
/// starting wait for that start instead of each running `serve` (these routes
/// are reachable without a token, so a burst would otherwise be a fork bomb).
fn start_lock(p: Plugin) -> std::sync::MutexGuard<'static, ()> {
    static DEEP_PLAN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static LOOKOUT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    match p {
        Plugin::DeepPlan => &DEEP_PLAN,
        Plugin::Lookout => &LOOKOUT,
    }
    .lock()
    .unwrap_or_else(|e| e.into_inner())
}

/// A start that failed, and why: requests that waited on it (or come within
/// FAILED_FOR) answer with it rather than each running `serve` again.
const FAILED_FOR: Duration = Duration::from_secs(10);

fn failed(p: Plugin) -> &'static std::sync::Mutex<Option<(std::time::Instant, String)>> {
    static DEEP_PLAN: std::sync::Mutex<Option<(std::time::Instant, String)>> = std::sync::Mutex::new(None);
    static LOOKOUT: std::sync::Mutex<Option<(std::time::Instant, String)>> = std::sync::Mutex::new(None);
    match p {
        Plugin::DeepPlan => &DEEP_PLAN,
        Plugin::Lookout => &LOOKOUT,
    }
}

/// The plugin's server, started through its CLI when none answers.
pub fn ensure(p: Plugin) -> Result<u16, String> {
    if let Some(port) = live_port(p) {
        return Ok(port);
    }
    let _start = start_lock(p);
    // Whoever held the lock before us may have just started it.
    if let Some(port) = live_port(p) {
        return Ok(port);
    }
    if let Some((at, why)) = failed(p).lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if at.elapsed() < FAILED_FOR {
            return Err(why.clone());
        }
    }
    let out = start(p);
    *failed(p).lock().unwrap_or_else(|e| e.into_inner()) = out.as_ref().err().map(|e| (std::time::Instant::now(), e.clone()));
    out
}

/// One `<cli> serve`, and the port it then answers on.
fn start(p: Plugin) -> Result<u16, String> {
    let Some((node, cli)) = p.cli() else {
        return Err(format!("{} is not installed here (no engine pointer, or no node)", p.name()));
    };
    match crew_core::py::run(&node, &[cli.as_str(), "serve"], Duration::from_secs(20)) {
        Some((0, _, _)) => {}
        Some((_, out, err)) => {
            let last: String = format!("{out}{err}").trim().lines().last().unwrap_or("").chars().take(160).collect();
            // An engine from before `serve` existed answers with its unknown-
            // verb message: say what that means rather than echo it.
            if last.contains("extension verb") || last.contains("unknown verb") {
                return Err(format!("{} at {cli} has no serve verb: the plugin is older than this app, so update it", p.name()));
            }
            return Err(format!("{} serve did not start: {last}", p.name()));
        }
        None => return Err(format!("{} serve did not start in 20s", p.name())),
    }
    live_port(p).ok_or_else(|| format!("{} serve started but does not answer", p.name()))
}

/// Request target as the plugin should see it: path plus the raw query.
fn target(req: &Request) -> String {
    if req.raw_query.is_empty() { req.path.clone() } else { format!("{}?{}", req.path, req.raw_query) }
}

/// The plugin's headers passed through. Its X-Frame-Options and any
/// frame-ancestors are dropped: this server's own frame-ancestors (added to
/// every page by Request::write) is the one that applies, and X-Frame-Options
/// would refuse the app's frame. The rest of a plugin's CSP is kept, as a
/// second policy beside this server's.
fn kept_headers(headers: &[(String, String)]) -> Vec<(&str, String)> {
    headers.iter().filter_map(|(k, v)| match k.to_ascii_lowercase().as_str() {
        "content-type" | "cache-control" | "location" => Some((k.as_str(), v.clone())),
        "content-security-policy" => without_frame_ancestors(v).map(|c| (k.as_str(), c)),
        _ => None,
    }).collect()
}

/// A CSP with its frame-ancestors directive taken out; None when nothing is left.
fn without_frame_ancestors(csp: &str) -> Option<String> {
    let rest: Vec<&str> = csp.split(';').map(str::trim)
        .filter(|d| !d.is_empty() && !d.split_whitespace().next().unwrap_or("").eq_ignore_ascii_case("frame-ancestors"))
        .collect();
    (!rest.is_empty()).then(|| rest.join("; "))
}

fn relay(req: &mut Request, p: Plugin, out: std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)>) {
    match out {
        Ok((code, headers, body)) => {
            let keep = kept_headers(&headers);
            req.relay(code, &keep, &body);
        }
        Err(e) => {
            log(&format!("FAIL proxy {} {}: {e}", p.name(), req.path));
            req.json(502, &json!({"error": format!("{} serve did not answer: {e}", p.name())}));
        }
    }
}

/// A GET for a forwarded route. Proofs can take minutes, so reads wait long.
pub fn get(req: &mut Request, p: Plugin) {
    let port = match ensure(p) {
        Ok(port) => port,
        Err(e) => {
            log(&format!("FAIL proxy {}: {e}", req.path));
            return req.json(502, &json!({"error": e}));
        }
    };
    let out = exchange(port, "GET", &target(req), &[], b"", Duration::from_secs(330));
    relay(req, p, out);
}

/// A review POST: this server's own Origin, JSON and size guards first, so a
/// page from anywhere else never reaches the plugin; then the body as it came,
/// with Origin rewritten to the plugin's. The token inside it is the plugin's
/// to check.
pub fn post(req: &mut Request, p: Plugin, max_body: usize) {
    let want = [format!("http://127.0.0.1:{}", req.port), format!("http://localhost:{}", req.port)];
    if !req.header("Origin").map(|o| want.iter().any(|w| w == o)).unwrap_or(false) {
        log(&format!("DENY POST {} from origin {:?}", req.path, req.header("Origin").unwrap_or("None")));
        return req.json(403, &json!({"error": "cross-origin request refused"}));
    }
    let ctype = req.header("Content-Type").unwrap_or("").to_string();
    if ctype.split(';').next().unwrap_or("").trim().to_lowercase() != "application/json" {
        return req.json(415, &json!({"error": "JSON only"}));
    }
    let length: i64 = req.header("Content-Length").map(|v| v.trim().parse().unwrap_or(-1)).unwrap_or(-1);
    if length < 0 {
        return req.json(411, &json!({"error": "length required"}));
    }
    if length as usize > max_body {
        return req.json(413, &json!({"error": "too large"}));
    }
    let body = req.read_body(length as usize);
    let port = match ensure(p) {
        Ok(port) => port,
        Err(e) => return req.json(502, &json!({"error": e})),
    };
    let headers = [("Origin", format!("http://127.0.0.1:{port}")), ("Content-Type", ctype),
                   ("Content-Length", body.len().to_string())];
    let out = exchange(port, "POST", &target(req), &headers, &body, Duration::from_secs(30));
    relay(req, p, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plugins_framing_headers_give_way_to_this_servers() {
        let h = |k: &str, v: &str| (k.to_string(), v.to_string());
        let headers = vec![h("Content-Type", "text/html"), h("X-Frame-Options", "SAMEORIGIN"),
            h("Content-Security-Policy", "default-src 'self'; Frame-Ancestors 'none'; img-src data:"),
            h("content-security-policy", "frame-ancestors *"), h("Set-Cookie", "a=b")];
        let kept = kept_headers(&headers);
        assert_eq!(kept, vec![("Content-Type", "text/html".to_string()),
            ("Content-Security-Policy", "default-src 'self'; img-src data:".to_string())]);
    }

    #[test]
    fn each_forwarded_route_has_one_owner() {
        for p in ["/plan/x", "/plan/x.review.html", "/plan-stamp", "/plan-evidence/x/inc1-a-1/frame-0001.png",
                  "/inc", "/open", "/answer", "/ask/20260101-000000-abcd", "/mermaid.min.js",
                  "/check/run", "/check/answer", "/check/tab", "/check/evidence", "/check/proof"] {
            assert_eq!(owner_get(p), Some(Plugin::DeepPlan), "{p}");
        }
        assert_eq!(owner_get("/review/demo"), Some(Plugin::Lookout));
        assert_eq!(owner_get("/review/demo.json"), Some(Plugin::Lookout));
        for p in ["/board", "/usage", "/do", "/artifacts", "/health", "/check/", "/check/pass", "/planx"] {
            assert_eq!(owner_get(p), None, "{p}");
        }
    }
}
