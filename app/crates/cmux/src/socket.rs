//! v2 JSON lines on the cmux socket.
//!
//! One request per line: `{"id": n, "method": "...", "params": {...}}`. One
//! response per line: `{"id": n, "ok": true, "result": ...}` or
//! `{"id": n, "ok": false, "error": {"code": "...", "message": "..."}}`.
//! Observed on cmux 0.64.25 (docs/FINDINGS.md).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::cli_seam::Env;
use crate::Error;

/// Where the socket is: CMUX_SOCKET_PATH, then CMUX_SOCKET, then the newest
/// /tmp/cmux*.sock. cmux sets the first two in its own terminals; the app and
/// a launchd job have neither, so they look in /tmp the way the CLI does.
pub(crate) fn resolve_socket_path(env: Env) -> Option<PathBuf> {
    for name in ["CMUX_SOCKET_PATH", "CMUX_SOCKET"] {
        if let Some(v) = env(name).filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(v));
        }
    }
    newest_socket(Path::new("/tmp"))
}

/// /tmp is world-writable, so a socket there counts only when this user owns
/// it: another user could plant a /tmp/cmux-x.sock newer than the real one and
/// collect every call, workspace text and typed input included.
fn newest_socket(dir: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    // SAFETY: getuid has no preconditions and cannot fail.
    let me = unsafe { libc::getuid() };
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("cmux") && name.ends_with(".sock")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.file_type().is_socket() || meta.uid() != me {
            continue;
        }
        let Ok(mtime) = meta.modified() else { continue };
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, entry.path()));
        }
    }
    best.map(|(_, p)| p)
}

/// One open connection. Requests on it are sequential.
pub(crate) struct Conn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_id: u64,
}

pub(crate) const TIMEOUT: Duration = Duration::from_secs(10);

impl Conn {
    pub(crate) fn open(path: &Path) -> Result<Conn, Error> {
        let stream = UnixStream::connect(path)
            .map_err(|e| Error::Unavailable(format!("cannot connect to {}: {e}", path.display())))?;
        stream.set_read_timeout(Some(TIMEOUT)).ok();
        stream.set_write_timeout(Some(TIMEOUT)).ok();
        let writer = stream.try_clone().map_err(Error::Io)?;
        Ok(Conn { reader: BufReader::new(stream), writer, next_id: 1 })
    }

    /// Send one request and wait for the response with its id.
    pub(crate) fn call(&mut self, method: &str, params: Value) -> Result<Value, Error> {
        let id = self.next_id;
        self.next_id += 1;
        let mut line = json!({"id": id, "method": method, "params": params}).to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).map_err(Error::Io)?;
        loop {
            let resp = read_frame(&mut self.reader)?;
            // A response for an earlier, abandoned request is skipped.
            if resp.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            return unwrap_response(resp);
        }
    }

    /// Send a streaming request; the caller then reads frames with `frame`.
    pub(crate) fn start_stream(&mut self, method: &str, params: Value) -> Result<(), Error> {
        let id = self.next_id;
        self.next_id += 1;
        let mut line = json!({"id": id, "method": method, "params": params}).to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).map_err(Error::Io)
    }

    pub(crate) fn frame(&mut self) -> Result<Value, Error> {
        read_frame(&mut self.reader)
    }

    pub(crate) fn set_read_timeout(&self, t: Option<Duration>) {
        self.reader.get_ref().set_read_timeout(t).ok();
    }
}

fn read_frame(reader: &mut BufReader<UnixStream>) -> Result<Value, Error> {
    let mut buf = String::new();
    let n = reader.read_line(&mut buf).map_err(Error::Io)?;
    if n == 0 {
        return Err(Error::Closed);
    }
    // cmux answers a peer its socket mode refuses with a plain-text line, not
    // JSON; carry that text so the refusal reads as one.
    serde_json::from_str(buf.trim_end()).map_err(|_| {
        let line: String = buf.trim().chars().take(200).collect();
        Error::Protocol(format!("cmux sent a non-JSON line: {line}"))
    })
}

/// `{"ok": true, "result": r}` gives r; `{"ok": false, "error": …}` an Error.
pub(crate) fn unwrap_response(resp: Value) -> Result<Value, Error> {
    if resp.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
    }
    let err = resp.get("error").cloned().unwrap_or(Value::Null);
    Err(Error::Refused {
        code: err.get("code").and_then(Value::as_str).unwrap_or("error").to_string(),
        message: err.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}
