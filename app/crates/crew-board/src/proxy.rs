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
                let node = crate::act::which("node").or_else(|| {
                    ["/opt/homebrew/bin/node", "/usr/local/bin/node"].iter()
                        .find(|c| std::path::Path::new(c).exists()).map(|c| c.to_string())
                })?;
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
fn exchange(port: u16, method: &str, target: &str, headers: &[(&str, String)], body: &[u8], timeout: Duration)
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

/// The plugin's server, started through its CLI when none answers.
pub fn ensure(p: Plugin) -> Result<u16, String> {
    if let Some(port) = live_port(p) {
        return Ok(port);
    }
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

fn relay(req: &mut Request, p: Plugin, out: std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)>) {
    match out {
        Ok((code, headers, body)) => {
            let keep: Vec<(&str, String)> = headers.iter()
                .filter(|(k, _)| ["content-type", "cache-control", "location"].contains(&k.to_ascii_lowercase().as_str()))
                .map(|(k, v)| (k.as_str(), v.clone()))
                .collect();
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
