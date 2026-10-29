//! The intent server: a loopback HTTP server that serves the plan, review,
//! ask and usage pages and turns a click into a cmux command
//! (crew/board/crew-board-intent).
//!
//! Security, as the Python's: bound to 127.0.0.1; every acting route needs
//! the per-machine token from board-intent.token (0600, reused across
//! restarts); the Host header must name this server, so a DNS-rebound page
//! cannot read a served token; actions are an allowlist and rows are looked
//! up in the collector's snapshot, never taken from the URL; nothing passes
//! through a shell.
//!
//! HTTP/1.0, one response per connection, a thread per request: what
//! Python's ThreadingHTTPServer with BaseHTTPRequestHandler does.
//!
//!   seamux crew-board-intent             serve (or leave a live one alone)
//!   seamux crew-board-intent --status    {"running", "port", "cmux"}
//!   seamux crew-board-intent --selftest  offline checks
//!   --usage-json | --lock-test RID N [--jitter]   probe entry points

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crew_core::{py, pyjson};

use crate::state::state_dir;

// ------------------------------------------------------------------- paths

pub fn token_file() -> PathBuf {
    state_dir().join("board-intent.token")
}
pub fn port_file() -> PathBuf {
    state_dir().join("board-intent.port")
}
pub fn log_file() -> PathBuf {
    state_dir().join("board-intent.log")
}
pub fn plans_dir() -> PathBuf {
    py::home().join(".claude").join("plans")
}
pub fn dp_state() -> PathBuf {
    py::home().join(".claude").join("deep-plan").join("state")
}
/// A file of crew's own, beside the board as installed: crew_home()/<rel>.
pub fn crew_file(rel: &str) -> PathBuf {
    crew_core::crew_home().join(rel)
}

/// One line in board-intent.log, timestamped like the Python's.
pub fn log(msg: &str) {
    let _ = std::fs::create_dir_all(state_dir());
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_file()) {
        let _ = writeln!(f, "{} {}", local_time("%H:%M:%S"), msg);
    }
}

/// strftime on local time.
pub fn local_time(fmt: &str) -> String {
    let cfmt = std::ffi::CString::new(fmt).unwrap_or_default();
    // SAFETY: localtime_r and strftime write only into buffers we own.
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        let mut buf = [0u8; 128];
        let n = libc::strftime(buf.as_mut_ptr() as *mut libc::c_char, buf.len(), cfmt.as_ptr(), &tm);
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }
}

/// `datetime.now(timezone.utc).isoformat(timespec="milliseconds")` with Z,
/// the shape of JavaScript's toISOString().
pub fn iso_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (y, m, day) = py::civil_from_days(secs.div_euclid(86400));
    let s = secs.rem_euclid(86400);
    format!("{y:04}-{m:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", s / 3600, s / 60 % 60, s % 60, d.subsec_millis())
}

/// A constant-time string compare: a timing oracle on a local port is still one.
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // Every byte of the longer one is looked at, whatever the lengths.
    let mut diff = u8::from(a.len() != b.len());
    for i in 0..a.len().max(b.len()) {
        diff |= a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

/// n bytes from the kernel's CSPRNG. arc4random_buf cannot fail, so a token
/// is never silently a constant.
fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    // SAFETY: writes exactly buf.len() bytes into buf.
    unsafe { libc::arc4random_buf(buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    buf
}

/// `secrets.token_urlsafe(n)`: n random bytes, base64url, unpadded.
pub fn token_urlsafe(n: usize) -> String {
    let buf = random_bytes(n);
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in buf.chunks(3) {
        let v = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            out.push(A[(v >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// `secrets.token_hex(n)`.
pub fn token_hex(n: usize) -> String {
    random_bytes(n).iter().map(|b| format!("{b:02x}")).collect()
}

// --------------------------------------------------------------- url bits

fn hexval(c: u8) -> Option<u8> {
    (c as char).to_digit(16).map(|d| d as u8)
}

/// `urllib.parse.unquote`: %XX as UTF-8, invalid sequences replaced.
pub fn unquote(s: &str) -> String {
    unquote_bytes(s.as_bytes(), false)
}

fn unquote_bytes(b: &[u8], plus: bool) -> String {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => match (hexval(b[i + 1]), hexval(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
                _ => out.push(b'%'),
            },
            b'+' if plus => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `urllib.parse.quote(s, safe=...)`.
pub fn quote(s: &str, safe: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || "_.-~".contains(c) || safe.contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `urllib.parse.parse_qs(q)`: blank values dropped, + is a space.
pub fn parse_qs(q: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for part in q.split('&') {
        let Some((k, v)) = part.split_once('=') else { continue };
        if v.is_empty() {
            continue;
        }
        out.entry(unquote_bytes(k.as_bytes(), true)).or_default().push(unquote_bytes(v.as_bytes(), true));
    }
    out
}

// ------------------------------------------------------------------- http

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, Vec<String>>,
    /// The query as it came, for forwarding it unchanged (proxy.rs).
    pub raw_query: String,
    headers: Vec<(String, String)>,
    reader: BufReader<Conn>,
    pub port: u16,
    pub token: String,
}

impl Request {
    /// `self.headers.get(name)`: the first header of that name, case-insensitive.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    /// `(q.get(k) or [""])[0]`.
    pub fn one(&self, k: &str) -> String {
        self.query.get(k).and_then(|v| v.first()).cloned().unwrap_or_default()
    }

    pub fn read_body(&mut self, n: usize) -> Vec<u8> {
        let mut b = vec![0u8; n];
        let mut got = 0;
        while got < n {
            match self.reader.read(&mut b[got..]) {
                Ok(0) | Err(_) => break,
                Ok(k) => got += k,
            }
        }
        b.truncate(got);
        b
    }

    fn write(&mut self, code: u16, headers: &[(&str, String)], body: &[u8]) {
        let mut out = format!("HTTP/1.0 {code} {}\r\nServer: crew-board-intent\r\nDate: {}\r\n", reason(code), http_date());
        for (k, v) in headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        // Every page, this server's own or a plugin's passed through, says who
        // may frame it: a page that acts on a click must not be framed by any
        // site (the Host check passes for a frame), only by the app and itself.
        if is_html(headers) {
            out.push_str(&format!("Content-Security-Policy: frame-ancestors {}\r\n", frame_ancestors(self.port)));
        }
        out.push_str("\r\n");
        let s = self.reader.get_mut();
        let _ = s.write_all(out.as_bytes());
        let _ = s.write_all(body);
        let _ = s.flush();
    }

    /// The Python's `_reply`: JSON with an open CORS header, for the chip routes
    /// a file:// page calls.
    /// Close after the reply: shut the write side, then drain what the client
    /// still sends (a body this server refused unread), bounded, so the close
    /// is not a reset that loses the reply on the client's side.
    fn finish(&mut self) {
        let _ = self.reader.get_ref().shutdown(std::net::Shutdown::Write);
        let _ = self.reader.get_ref().set_read_timeout(Some(Duration::from_secs(1)));
        let mut sink = [0u8; 8192];
        let mut total = 0usize;
        while total < 1 << 20 {
            match self.reader.read(&mut sink) {
                Ok(0) | Err(_) => break,
                Ok(n) => total += n,
            }
        }
    }

    pub fn reply(&mut self, code: u16, body: &[u8]) {
        self.write(code, &[("Access-Control-Allow-Origin", "*".into()),
                           ("Content-Type", "application/json".into()),
                           ("Content-Length", body.len().to_string())], body);
    }

    pub fn reply_json(&mut self, code: u16, v: &Value) {
        let b = pyjson::dumps(v);
        self.reply(code, b.as_bytes());
    }

    /// The Python's `_json`: no CORS header, never cached: for pages this
    /// server served, not for any origin that asks.
    pub fn json(&mut self, code: u16, v: &Value) {
        let b = pyjson::dumps(v);
        self.write(code, &[("Content-Type", "application/json".into()),
                           ("Cache-Control", "no-store".into()),
                           ("Content-Length", b.len().to_string())], b.as_bytes());
    }

    pub fn set_write_timeout(&mut self, t: Duration) {
        let _ = self.reader.get_ref().set_write_timeout(Some(t));
    }

    /// A response with no length that the caller keeps writing to (SSE).
    pub fn start_stream(&mut self, ctype: &str) {
        self.write(200, &[("Content-Type", ctype.into()), ("Cache-Control", "no-store".into())], b"");
    }

    /// One more piece of a stream; an error means the client has gone.
    pub fn push(&mut self, b: &[u8]) -> std::io::Result<()> {
        let s = self.reader.get_mut();
        s.write_all(b)?;
        s.flush()
    }

    /// A plugin server's reply passed through (proxy.rs): its status and the
    /// headers it kept, with this server's length.
    pub fn relay(&mut self, code: u16, headers: &[(&str, String)], body: &[u8]) {
        let mut h: Vec<(&str, String)> = headers.to_vec();
        h.push(("Content-Length", body.len().to_string()));
        self.write(code, &h, body);
    }

    /// A page or file, never cached unless `cache` says otherwise.
    pub fn send(&mut self, code: u16, ctype: &str, cache: &str, body: &[u8]) {
        self.write(code, &[("Content-Type", ctype.into()), ("Cache-Control", cache.into()),
                           ("Content-Length", body.len().to_string())], body);
    }
}

/// Whether a response's Content-Type is a page.
fn is_html(headers: &[(&str, String)]) -> bool {
    headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v.trim_start().to_ascii_lowercase().starts_with("text/html"))
}

/// The origins that frame these pages besides this server itself: the seamux
/// app's webview (tauri://localhost on macOS and Linux, http(s)://tauri.localhost
/// on Windows), plus any CREW_INTENT_FRAME_ANCESTORS names (space-separated
/// origins). The app's Vite dev server is not trusted by default, since
/// any local program could hold its port: a developer running the app under
/// Vite sets CREW_INTENT_FRAME_ANCESTORS=http://localhost:5173 for the intent
/// server (as does a demo harness on another port).
/// cmux's browser pane loads a page top-level, which frame-ancestors does not
/// touch. intent.js posts to and accepts messages from these same origins.
pub fn parent_origins() -> Vec<String> {
    let mut out: Vec<String> = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
        .iter().map(|s| s.to_string()).collect();
    for o in std::env::var("CREW_INTENT_FRAME_ANCESTORS").unwrap_or_default().split_whitespace() {
        if origin_ok(o) && !out.iter().any(|x| x == o) {
            out.push(o.to_string());
        }
    }
    out
}

/// scheme://host[:port], nothing else: it goes into a header and a script.
fn origin_ok(o: &str) -> bool {
    let Some((scheme, rest)) = o.split_once("://") else { return false };
    !scheme.is_empty() && scheme.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && scheme.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+.-".contains(c))
        && !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c))
}

/// CSP frame-ancestors for a page this server answers on `port`. 'self' and
/// its two loopback names are for a page that frames another of these pages.
/// No X-Frame-Options: SAMEORIGIN would refuse the app's frame in any engine
/// that honoured it over CSP, and every engine the app and cmux use reads
/// frame-ancestors.
pub fn frame_ancestors(port: u16) -> String {
    let mut v = vec!["'self'".to_string(), format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")];
    // Both tauri://localhost and the scheme-source tauri: (a CSP-only form, so
    // not in parent_origins, which intent.js posts to): WebKit may match a
    // custom-scheme origin by scheme alone. If the app's origin is not in this
    // list, the app's Dock (and every page it frames) goes blank.
    let mut parents = parent_origins();
    parents.insert(1, "tauri:".into());
    v.extend(parents);
    v.join(" ")
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        302 => "Found",
        405 => "Method Not Allowed",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        411 => "Length Required",
        413 => "Request Entity Too Large",
        414 => "Request-URI Too Long",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "Unknown",
    }
}

fn http_date() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86400);
    let (y, m, d) = py::civil_from_days(days);
    let s = secs.rem_euclid(86400);
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MO: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{}, {:02} {} {} {:02}:{:02}:{:02} GMT", WD[days.rem_euclid(7) as usize], d, MO[(m - 1) as usize], y,
            s / 3600, s / 60 % 60, s % 60)
}

/// The longest request or header line accepted, and the most headers: what
/// Python's BaseHTTPRequestHandler allows (it answers 414 and 431 past them).
const MAX_LINE: u64 = 65536;
const MAX_HEADERS: usize = 100;

/// One line of at most MAX_LINE bytes: Ok(None) at EOF, Err(()) when longer.
fn read_capped(reader: &mut BufReader<Conn>) -> Result<Option<String>, ()> {
    let mut buf = Vec::new();
    let n = reader.by_ref().take(MAX_LINE + 1).read_until(b'\n', &mut buf).map_err(|_| ())?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() as u64 > MAX_LINE {
        return Err(());
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

fn refuse(reader: BufReader<Conn>, code: u16, why: &str) {
    let mut s = reader.into_inner();
    let body = why.as_bytes();
    let head = format!("HTTP/1.0 {code} {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n", reason(code), body.len());
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
}

/// The path of a request-target, as urlparse reads it: absolute only when a
/// scheme comes before any '/', so a URL inside the query is not mistaken
/// for one.
pub fn target_path(target: &str) -> &str {
    let rel = match target.find("://") {
        Some(i) if !target.starts_with('/') && !target[..i].contains('/') => {
            let rest = &target[i + 3..];
            rest.find('/').map(|j| &rest[j..]).unwrap_or("/")
        }
        _ => target,
    };
    rel.split('#').next().unwrap_or("")
}

/// How long a connection may take to send its request line and headers, in
/// all: short, so sockets that send nothing (or a byte now and then) do not
/// hold the connection cap.
const HEAD_WAIT: Duration = Duration::from_secs(5);

/// A connection whose reads share one deadline while it is set: every read
/// waits only for what is left of it, and fails once it has passed.
pub struct Conn {
    s: TcpStream,
    deadline: Option<std::time::Instant>,
}

impl std::ops::Deref for Conn {
    type Target = TcpStream;
    fn deref(&self) -> &TcpStream {
        &self.s
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if let Some(d) = self.deadline {
            let left = d.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "request head took too long"));
            }
            self.s.set_read_timeout(Some(left))?;
        }
        self.s.read(buf)
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.s.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.s.flush()
    }
}

fn handle(stream: TcpStream, port: u16, token: String) {
    let mut reader = BufReader::new(Conn { s: stream, deadline: Some(std::time::Instant::now() + HEAD_WAIT) });
    let line = match read_capped(&mut reader) {
        Ok(Some(l)) => l,
        Ok(None) => return,
        Err(()) => return refuse(reader, 414, "request line too long"),
    };
    let parts: Vec<&str> = line.split_whitespace().collect();
    let mut headers = Vec::new();
    loop {
        let h = match read_capped(&mut reader) {
            Ok(Some(h)) => h,
            Ok(None) => break,
            Err(()) => return refuse(reader, 431, "header line too long"),
        };
        let h = h.trim_end_matches(['\r', '\n']);
        if h.is_empty() {
            break;
        }
        if headers.len() >= MAX_HEADERS {
            return refuse(reader, 431, "too many headers");
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    // The head is in: a body (a POST's) may take longer to arrive.
    reader.get_mut().deadline = None;
    let _ = reader.get_ref().set_read_timeout(Some(Duration::from_secs(30)));
    let rel = target_path(parts.get(1).copied().unwrap_or(""));
    let (path, query) = rel.split_once('?').unwrap_or((rel, ""));
    let mut req = Request {
        method: parts.first().copied().unwrap_or("").to_string(),
        path: path.to_string(),
        query: parse_qs(query),
        raw_query: query.to_string(),
        headers,
        reader,
        port,
        token,
    };
    if parts.len() < 2 {
        req.send(400, "text/plain", "no-store", b"bad request line");
        return;
    }
    match req.method.as_str() {
        "GET" => crate::routes::get(&mut req),
        "POST" => crate::routes::post(&mut req),
        _ => req.send(501, "text/plain", "no-store", b"unsupported method"),
    }
    req.finish();
}

// ------------------------------------------------------------- port, token

/// What /health answers: enough for a client to tell this server from
/// another program that holds the port.
pub fn health_body() -> String {
    pyjson::dumps(&json!({"ok": true, "server": "crew-board-intent", "pid": std::process::id()}))
}

/// Ok when what answers on `port` is a crew-board-intent: its Server header
/// (the Python's too, and what the app checks) or /health's body names it,
/// whatever the status, so a busy server answering 503 at its connection cap
/// still counts. Up to ~3s for the answer. Err says what is there instead.
pub fn identify(port: u16) -> Result<(), String> {
    let (code, headers, body) = health_head(port, IDENTIFY_WAIT, IDENTIFY_CAP)
        .map_err(|e| format!("nothing answers /health on {port} ({e})"))?;
    let server = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("server")).map(|(_, v)| v.as_str()).unwrap_or("");
    let named = serde_json::from_slice::<Value>(&body).ok()
        .and_then(|v| v.get("server").and_then(Value::as_str).map(String::from)).unwrap_or_default();
    if server.starts_with("crew-board-intent") || named == "crew-board-intent" {
        return Ok(());
    }
    Err(format!("port {port} is held by something else ({code}, server {server:?})"))
}

/// identify()'s whole wait, and the most of the answer it reads: a program
/// streaming on the recorded port must not hold it.
const IDENTIFY_WAIT: Duration = Duration::from_secs(3);
const IDENTIFY_CAP: usize = 8 * 1024;

/// GET /health with one overall deadline and a size cap: (status, headers,
/// body so far). Err when no header block arrived in time.
fn health_head(port: u16, wait: Duration, cap: usize) -> std::io::Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let deadline = std::time::Instant::now() + wait;
    let left = || deadline.saturating_duration_since(std::time::Instant::now());
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, left().min(Duration::from_millis(800)).max(Duration::from_millis(1)))?;
    s.set_write_timeout(Some(left().max(Duration::from_millis(1))))?;
    s.write_all(format!("GET /health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").as_bytes())?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 2048];
    while raw.len() < cap {
        let rest = left();
        if rest.is_zero() {
            break;
        }
        s.set_read_timeout(Some(rest))?;
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n.min(cap - raw.len())]),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
            Err(e) => return Err(e),
        }
    }
    let bad = |m: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, m.to_string());
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| bad("no answer in time"))?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let code = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok()).ok_or_else(|| bad("no status"))?;
    let hdrs = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
    Ok((code, hdrs, raw[split + 4..].to_vec()))
}

/// (port, token) of a crew-board-intent that is actually answering, else None.
/// A connect alone is not enough: another program on the recorded port would
/// be sent the token with every click.
pub fn current() -> Option<(u16, String)> {
    let port: u16 = std::fs::read_to_string(port_file()).ok()?.trim().parse().ok()?;
    let token = std::fs::read_to_string(token_file()).ok()?.trim().to_string();
    identify(port).ok().map(|_| (port, token))
}

/// The pinned port (CREW_INTENT_PORT, default 7345), then last time's, then any:
/// a restart that keeps its port keeps every pushed page's URLs working.
fn bind() -> std::io::Result<TcpListener> {
    let mut candidates = vec![std::env::var("CREW_INTENT_PORT").ok().filter(|s| !s.is_empty())
        .map(|s| s.trim().parse::<u16>().unwrap_or(7345)).unwrap_or(7345)];
    if let Some(p) = std::fs::read_to_string(port_file()).ok().and_then(|s| s.trim().parse::<u16>().ok()) {
        candidates.push(p);
    }
    for want in candidates {
        match TcpListener::bind(("127.0.0.1", want)) {
            Ok(l) => return Ok(l),
            Err(e) => log(&format!("port {want} is not free ({e}); trying the next")),
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
}

/// The persisted token when its file is not readable by others, else a fresh one.
fn token() -> String {
    let path = token_file();
    let tight = std::fs::metadata(&path).map(|m| m.permissions().mode() & 0o077 == 0).unwrap_or(false);
    let old = if tight { std::fs::read_to_string(&path).map(|s| s.trim().to_string()).unwrap_or_default() } else { String::new() };
    if old.is_empty() { token_urlsafe(24) } else { old }
}

/// Written to a 0600 temp file and renamed over: a reader never sees it empty.
fn write_token(path: &Path, token: &str) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp.{}", path.display(), std::process::id()));
    let res = (|| {
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        f.write_all(token.as_bytes())?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Start `<this binary> crew-board-intent` detached, from $HOME, its stderr
/// in the server log. `takeover` (the old server's pid) makes it a successor:
/// it waits for the lock, names itself in board-intent.takeover, and binds
/// only once that pid has gone (see serve()).
pub fn spawn_server(takeover: Option<u32>) -> std::io::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    let exe = crew_core::upgrade::exe().ok_or_else(|| std::io::Error::other("cannot find this binary"))?;
    let _ = std::fs::create_dir_all(state_dir());
    let err = std::fs::OpenOptions::new().append(true).create(true).open(log_file())
        .map(std::process::Stdio::from).unwrap_or_else(|_| std::process::Stdio::null());
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("crew-board-intent").current_dir(py::home())
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(err);
    if let Some(pid) = takeover {
        cmd.env("CREW_INTENT_TAKEOVER", pid.to_string());
    } else {
        cmd.env_remove("CREW_INTENT_TAKEOVER");
    }
    // SAFETY: setsid is async-signal-safe and touches only the child.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()
}

fn takeover_file() -> PathBuf {
    state_dir().join("board-intent.takeover")
}

/// How often a server looks for an installed upgrade (CREW_INTENT_UPGRADE_CHECK
/// seconds, 10 by default; the probe shortens it).
fn upgrade_check() -> Duration {
    let s = std::env::var("CREW_INTENT_UPGRADE_CHECK").ok().and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(10.0);
    Duration::from_secs_f64(if s.is_finite() && s > 0.0 { s.clamp(0.2, 3600.0) } else { 10.0 })
}

/// Whether the successor took over within `wait`: it holds the lock and named
/// itself in board-intent.takeover. False as soon as it exits.
fn handed_off(child: &mut std::process::Child, wait: Duration) -> bool {
    let deadline = std::time::Instant::now() + wait;
    let me = child.id().to_string();
    while std::time::Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        if std::fs::read_to_string(takeover_file()).is_ok_and(|s| s.trim() == me) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the pid exists.
    pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0
}

/// The server lock: at once, or (taking over from a server that is about to
/// exit) waiting up to 15s for it to go.
fn server_lock(wait: bool) -> std::io::Result<Option<py::Flock>> {
    let path = state_dir().join("board-intent.lock");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match py::Flock::try_exclusive(&path)? {
            Some(l) => return Ok(Some(l)),
            None if wait && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            None => return Ok(None),
        }
    }
}

/// The most connections served at once (each a thread; an open board's feed
/// holds one): past it, a connection is answered 503 at once.
const MAX_CONNS: usize = 256;
static CONNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// How long too_busy may spend on one refused connection, all told.
const BUSY_WAIT: Duration = Duration::from_millis(200);

/// Runs on the accept thread, so it never blocks past BUSY_WAIT in all, however
/// slowly the client sends: read what the client already sent, answer, shut
/// the write side and drain, so the close is not a reset that loses the 503.
fn too_busy(mut s: TcpStream) {
    let deadline = std::time::Instant::now() + BUSY_WAIT;
    // Each read waits only for what is left of the one deadline.
    let left = || deadline.saturating_duration_since(std::time::Instant::now()).max(Duration::from_millis(1));
    let mut sink = [0u8; 8192];
    let _ = s.set_write_timeout(Some(Duration::from_millis(100)));
    let _ = s.set_read_timeout(Some(left()));
    let _ = s.read(&mut sink);
    let body = b"too many connections";
    let head = format!("HTTP/1.0 503 {}\r\nServer: crew-board-intent\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n",
        reason(503), body.len());
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
    let _ = s.shutdown(std::net::Shutdown::Write);
    let mut total = 0;
    while total < 64 * 1024 && std::time::Instant::now() < deadline {
        let _ = s.set_read_timeout(Some(left()));
        match s.read(&mut sink) {
            Ok(0) | Err(_) => break,
            Ok(n) => total += n,
        }
    }
}

/// The token serve() would use now (for the selftest).
pub(crate) fn selftest_token() -> String {
    token()
}

/// The port serve() would take now (for the selftest).
pub(crate) fn selftest_bind_port() -> Option<u16> {
    bind().ok().and_then(|l| l.local_addr().ok()).map(|a| a.port())
}

/// Start the server, or leave a live one alone.
pub fn serve() -> i32 {
    let _ = std::fs::create_dir_all(state_dir());
    // One server at a time, held for its life. crew-listen, `crew-board open`
    // and cmux's "Crew board" command can each start one at the same moment;
    // without the lock both pass the check below, the loser binds a random
    // port and rewrites the port and token files under the winner's pages.
    // Read once and removed, so nothing this server starts inherits it.
    let takeover: Option<u32> = std::env::var("CREW_INTENT_TAKEOVER").ok().and_then(|v| v.trim().parse().ok());
    std::env::remove_var("CREW_INTENT_TAKEOVER");
    let lock = match server_lock(takeover.is_some()) {
        Ok(Some(l)) => l,
        Ok(None) => {
            eprintln!("crew-board-intent: another server holds board-intent.lock; not starting a second");
            log(&format!("not starting (pid {}): another server holds board-intent.lock", std::process::id()));
            return 0;
        }
        Err(e) => {
            eprintln!("crew-board-intent: cannot take the server lock: {e}");
            log(&format!("not starting: cannot take the server lock: {e}"));
            return 1;
        }
    };
    // A successor: say so (the old server waits for this before it leaves),
    // then wait for the old one to go, so its port is free to take.
    if let Some(old) = takeover {
        if let Err(e) = py::write_atomic(&takeover_file(), std::process::id().to_string().as_bytes()) {
            log(&format!("not taking over: cannot write the takeover file: {e}"));
            return 1;
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        while alive(old) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::fs::remove_file(takeover_file());
        if alive(old) {
            log(&format!("not taking over: the old server (pid {old}) is still running"));
            return 0;
        }
    }
    // One from before the lock existed may still serve: leave it be, but
    // only when it is one. Anything else on the recorded port is ignored and
    // a port bound afresh, so the port file never names another program.
    if let Some(port) = std::fs::read_to_string(port_file()).ok().and_then(|s| s.trim().parse::<u16>().ok()) {
        match identify(port) {
            Ok(()) => {
                log(&format!("not starting (pid {}): a crew-board-intent already answers on {port}", std::process::id()));
                return 0;
            }
            Err(why) if takeover.is_none() => log(&format!("the port file names {port}, but {why}: binding afresh")),
            Err(_) => {}
        }
    }
    let token = token();
    let listener = match bind() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("crew-board-intent: cannot listen: {e}");
            return 1;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // Serve from $HOME whoever started it: deep-plan serve, lookout serve and
    // deep-plan status run under this directory, and node dies at startup
    // (uv_cwd ENOENT) when it is a worktree that has since been reclaimed.
    let _ = std::env::set_current_dir(py::home());
    if let Err(e) = write_token(&token_file(), &token) {
        eprintln!("crew-board-intent: cannot write the token: {e}");
        return 1;
    }
    if let Err(e) = py::write_atomic(&port_file(), port.to_string().as_bytes()) {
        eprintln!("crew-board-intent: cannot write the port file: {e}");
        return 1;
    }
    log(&format!("listening on 127.0.0.1:{port} (pid {})", std::process::id()));
    // An install replaced this binary: start the new one, hand it the lock,
    // and leave only once it has taken it (it then waits for this process to
    // go and binds the same port; the token carries over). A successor that
    // does not take over in 10s, or exits, leaves this one serving the old
    // code rather than none.
    let started = std::time::SystemTime::now();
    let held = std::sync::Arc::new(std::sync::Mutex::new(Some(lock)));
    let cell = held.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(upgrade_check());
        if !crew_core::upgrade::replaced_since(started) {
            continue;
        }
        let mut child = match spawn_server(Some(std::process::id())) {
            Ok(c) => c,
            Err(e) => {
                log(&format!("a newer binary is installed, but it would not start ({e}): serving on with this one"));
                return;
            }
        };
        let pid = child.id();
        drop(cell.lock().unwrap_or_else(|e| e.into_inner()).take());
        if handed_off(&mut child, Duration::from_secs(10)) {
            log(&format!("a newer binary is installed: pid {pid} took over; exiting"));
            std::process::exit(0);
        }
        let why = match child.try_wait() {
            Ok(Some(st)) => format!("it exited ({st})"),
            _ => "it did not take the lock in 10s".to_string(),
        };
        match server_lock(false) {
            Ok(Some(l)) => {
                *cell.lock().unwrap_or_else(|e| e.into_inner()) = Some(l);
                let _ = child.kill();
                log(&format!("a newer binary is installed, but pid {pid} did not take over ({why}): serving on with this one"));
                return;
            }
            _ => {
                // Someone has the lock now: if it is the successor, late, it is
                // waiting for this process to go.
                if handed_off(&mut child, Duration::from_millis(500)) {
                    log(&format!("a newer binary is installed: pid {pid} took over late; exiting"));
                    std::process::exit(0);
                }
                log(&format!("a newer binary is installed, but pid {pid} did not take over ({why}); the lock is another's: serving on"));
                return;
            }
        }
    });
    for stream in listener.incoming().flatten() {
        use std::sync::atomic::Ordering;
        if CONNS.fetch_add(1, Ordering::SeqCst) >= MAX_CONNS {
            CONNS.fetch_sub(1, Ordering::SeqCst);
            too_busy(stream);
            continue;
        }
        let token = token.clone();
        let spawned = std::thread::Builder::new().spawn(move || {
            struct Done;
            impl Drop for Done {
                fn drop(&mut self) {
                    CONNS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
            let _done = Done;
            handle(stream, port, token)
        });
        if spawned.is_err() {
            CONNS.fetch_sub(1, Ordering::SeqCst);
        }
    }
    0
}

pub fn status() -> i32 {
    let cur = current();
    let cmux = cmux::resolve_cli_bin().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "cmux".into());
    println!("{}", pyjson::dumps_indent(&json!({
        "running": cur.is_some(),
        "port": cur.map(|c| json!(c.0)).unwrap_or(Value::Null),
        "cmux": cmux,
    }), 2));
    0
}

pub fn main(args: &[String]) -> i32 {
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--usage-json") {
        println!("{}", pyjson::dumps(&crate::usage::usage_data(21)));
        return 0;
    }
    if let Some(i) = args.iter().position(|a| a == "--lock-test") {
        let (Some(rid), Some(n)) = (args.get(i + 1), args.get(i + 2).and_then(|n| n.parse::<i64>().ok())) else {
            eprintln!("crew-board-intent: --lock-test RID N [--jitter]");
            return 2;
        };
        return crate::review::lock_test(rid, n, has("--jitter"));
    }
    if let Some(i) = args.iter().position(|a| a == "--wake-tab") {
        // --wake-tab NAME URL [--select WS]: the Wake's tab group, as /do and
        // /artifacts/open drive it.
        let (Some(name), Some(url)) = (args.get(i + 1), args.get(i + 2)) else {
            eprintln!("crew-board-intent: --wake-tab NAME URL [--select WS]");
            return 2;
        };
        let select = args.iter().position(|a| a == "--select").and_then(|j| args.get(j + 1)).cloned().unwrap_or_default();
        let (ok, detail) = crate::wake::wake_tab(name, url, &select);
        println!("{}", pyjson::dumps(&json!({"ok": ok, "detail": detail})));
        return 0;
    }
    if has("--selftest") {
        return crate::selftest::run();
    }
    if has("--status") {
        return status();
    }
    serve()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_parse_as_python_does() {
        let q = parse_qs("t=a%2Bb&x=&a=go+3&a=two&bad");
        assert_eq!(q["t"], vec!["a+b"]);
        assert!(!q.contains_key("x"));
        assert_eq!(q["a"], vec!["go 3", "two"]);
        assert_eq!(unquote("..%2Fdemo"), "../demo");
        assert_eq!(unquote("%zz%2"), "%zz%2");
    }

    #[test]
    fn a_url_in_the_query_is_not_the_target() {
        assert_eq!(target_path("/inc?why=see+https://example.com/x"), "/inc?why=see+https://example.com/x");
        assert_eq!(target_path("http://127.0.0.1:7345/do?a=jump"), "/do?a=jump");
        assert_eq!(target_path("/plan/x#frag"), "/plan/x");
    }

    #[test]
    fn pages_name_who_may_frame_them() {
        let fa = frame_ancestors(7345);
        assert!(fa.starts_with("'self' http://127.0.0.1:7345 http://localhost:7345 tauri://localhost tauri: "), "{fa}");
        assert!(!fa.contains('*'));
        assert!(is_html(&[("Content-Type", "text/html; charset=utf-8".into())]));
        assert!(!is_html(&[("Content-Type", "application/json".into())]));
        assert!(origin_ok("http://127.0.0.1:5199") && origin_ok("tauri://localhost"));
        for bad in ["*", "http://x\r\nSet-Cookie: a", "http://", "javascript:alert(1)", "http://a/b", "'self'", "\"x\""] {
            assert!(!origin_ok(bad), "{bad}");
        }
    }

    #[test]
    fn another_program_on_the_port_is_not_the_server() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\nServer: SimpleHTTP/0.6\r\nContent-Length: 2\r\n\r\nok");
            }
        });
        let e = identify(port).unwrap_err();
        assert!(e.contains("held by something else"), "{e}");
        t.join().unwrap();
    }

    #[test]
    fn a_busy_server_at_its_cap_is_still_ours() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                let mut buf = [0u8; 1024];
                let mut s2 = s.try_clone().unwrap();
                let _ = s2.read(&mut buf);
                too_busy(s);
            }
        });
        assert!(identify(port).is_ok());
        t.join().unwrap();
    }

    #[test]
    fn a_trickling_client_cannot_hold_the_accept_thread() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
            // One byte every 50ms for 3s: each read alone would come back in time.
            for _ in 0..60 {
                if c.write_all(b"x").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let (s, _) = l.accept().unwrap();
        let t = std::time::Instant::now();
        too_busy(s);
        assert!(t.elapsed() < Duration::from_millis(400), "held for {:?}", t.elapsed());
        client.join().unwrap();
    }

    #[test]
    fn a_program_streaming_on_the_port_cannot_hold_identify() {
        // Headers that never end, a byte at a time: given up at the deadline.
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\nX: ");
                while s.write_all(b"y").is_ok() {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        });
        let t = std::time::Instant::now();
        assert!(health_head(port, Duration::from_millis(500), IDENTIFY_CAP).is_err());
        assert!(t.elapsed() < Duration::from_millis(900), "held for {:?}", t.elapsed());
        // A flood after the headers: read up to the cap, and still identified.
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = l.accept() {
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\nServer: crew-board-intent\r\n\r\n");
                let junk = [b'z'; 4096];
                while s.write_all(&junk).is_ok() {}
            }
        });
        let t = std::time::Instant::now();
        let (code, _, body) = health_head(port, Duration::from_secs(3), IDENTIFY_CAP).unwrap();
        assert!(code == 200 && body.len() < IDENTIFY_CAP && t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn the_vite_dev_server_is_not_trusted_by_default() {
        std::env::remove_var("CREW_INTENT_FRAME_ANCESTORS");
        assert!(!parent_origins().iter().any(|o| o.contains("5173")));
        assert!(!frame_ancestors(7345).contains("5173"));
    }

    #[test]
    fn a_trickled_request_head_is_cut_off_at_one_deadline() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
            // A byte every 50ms, a request line that never ends.
            for _ in 0..40 {
                if c.write_all(b"G").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let (s, _) = l.accept().unwrap();
        let mut r = BufReader::new(Conn { s, deadline: Some(std::time::Instant::now() + Duration::from_millis(300)) });
        let t = std::time::Instant::now();
        assert!(read_capped(&mut r).is_err());
        assert!(t.elapsed() < Duration::from_millis(600), "held for {:?}", t.elapsed());
        client.join().unwrap();
    }

    #[test]
    fn tokens_are_urlsafe() {
        let t = token_urlsafe(24);
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(ct_eq("abc", "abc") && !ct_eq("abc", "abd") && !ct_eq("abc", "ab"));
    }
}
