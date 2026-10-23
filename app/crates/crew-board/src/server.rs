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
    headers: Vec<(String, String)>,
    reader: BufReader<TcpStream>,
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

    /// A page or file, never cached unless `cache` says otherwise.
    pub fn send(&mut self, code: u16, ctype: &str, cache: &str, body: &[u8]) {
        self.write(code, &[("Content-Type", ctype.into()), ("Cache-Control", cache.into()),
                           ("Content-Length", body.len().to_string())], body);
    }
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
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
fn read_capped(reader: &mut BufReader<TcpStream>) -> Result<Option<String>, ()> {
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

fn refuse(reader: BufReader<TcpStream>, code: u16, why: &str) {
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

fn handle(stream: TcpStream, port: u16, token: String) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = BufReader::new(stream);
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
    let rel = target_path(parts.get(1).copied().unwrap_or(""));
    let (path, query) = rel.split_once('?').unwrap_or((rel, ""));
    let mut req = Request {
        method: parts.first().copied().unwrap_or("").to_string(),
        path: path.to_string(),
        query: parse_qs(query),
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

/// (port, token) of a server that is actually answering, else None.
pub fn current() -> Option<(u16, String)> {
    let port: u16 = std::fs::read_to_string(port_file()).ok()?.trim().parse().ok()?;
    let token = std::fs::read_to_string(token_file()).ok()?.trim().to_string();
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok().map(|_| (port, token))
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
        if let Ok(l) = TcpListener::bind(("127.0.0.1", want)) {
            return Ok(l);
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

fn write_token(path: &Path, token: &str) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(token.as_bytes())
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
    if current().is_some() {
        return 0;
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
    if let Err(e) = write_token(&token_file(), &token) {
        eprintln!("crew-board-intent: cannot write the token: {e}");
        return 1;
    }
    let _ = std::fs::write(port_file(), port.to_string());
    log(&format!("listening on 127.0.0.1:{port}"));
    // An install replaced this binary: leave, so the new code serves (crew-listen
    // starts it again within seconds; the token and the port carry over).
    let started = std::time::SystemTime::now();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        if crew_core::upgrade::replaced_since(started) {
            log("a newer binary is installed: exiting so it can take over");
            std::process::exit(0);
        }
    });
    for stream in listener.incoming().flatten() {
        let token = token.clone();
        std::thread::spawn(move || handle(stream, port, token));
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
    fn tokens_are_urlsafe() {
        let t = token_urlsafe(24);
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(ct_eq("abc", "abc") && !ct_eq("abc", "abd") && !ct_eq("abc", "ab"));
    }
}
