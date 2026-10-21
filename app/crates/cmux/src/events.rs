//! Following cmux's event stream.
//!
//! On the socket: `events.stream` with `after_seq` from the cursor file. cmux
//! 0.64.25 serves it (the CLI's own `cmux events` uses it) although
//! `system.capabilities` leaves it out of the method list, so the stream is
//! tried and not gated on the list. If cmux refuses it, or the transport is
//! the CLI, a `cmux events` child does the same job with the argv crew-listen
//! uses today. Either way the caller sees the same frames: `{"type": "event",
//! "seq": n, "name": ..., ...}`, and the cursor file holds the last seq.

use std::io::{BufRead, BufReader, Lines};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

use crate::socket::Conn;
use crate::{Cmux, Error, Transport};

/// What to follow.
#[derive(Debug, Clone, Default)]
pub struct EventOptions {
    /// Event names to keep (`--name`); empty keeps everything.
    pub names: Vec<String>,
    /// Read the starting seq from here, and write each event's seq back.
    pub cursor_file: Option<PathBuf>,
    /// Reopen the stream when cmux restarts or the socket drops, resuming
    /// from the last seq, instead of ending the iterator.
    pub reconnect: bool,
}

enum Source {
    Socket(Conn),
    Child(Child, Lines<BufReader<ChildStdout>>),
    Done,
}

/// An iterator of event frames. Errors other than a dropped stream end it.
pub struct EventStream {
    opts: EventOptions,
    socket: Option<PathBuf>,
    bin: Option<PathBuf>,
    source: Source,
    last_seq: Option<i64>,
}

/// No frame (not even a heartbeat, which cmux sends every 15 s) for this long
/// means the stream is dead.
const SILENCE: Duration = Duration::from_secs(60);
const BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

impl Cmux {
    /// Follow cmux's events. See the module docs for which path it takes.
    pub fn events(&self, opts: EventOptions) -> Result<EventStream, Error> {
        let last_seq = opts.cursor_file.as_ref().and_then(|f| read_cursor(f));
        let socket = match self.transport() {
            Transport::Socket(p) => Some(p.clone()),
            Transport::Cli(_) => None,
        };
        let mut st = EventStream { opts, socket, bin: self.cli_bin().ok(), source: Source::Done, last_seq };
        st.source = st.open()?;
        Ok(st)
    }
}

impl EventStream {
    /// True while the stream comes over the socket (false: a `cmux events` child).
    pub fn on_socket(&self) -> bool {
        matches!(self.source, Source::Socket(_))
    }

    fn open(&mut self) -> Result<Source, Error> {
        if let Some(path) = self.socket.clone() {
            match self.open_socket(&path) {
                Ok(conn) => return Ok(Source::Socket(conn)),
                // Refused: this cmux does not serve the stream. Fall back for good.
                Err(Error::Refused { .. }) => self.socket = None,
                Err(e) => return Err(e),
            }
        }
        self.spawn_child()
    }

    fn open_socket(&self, path: &std::path::Path) -> Result<Conn, Error> {
        let mut conn = Conn::open(path)?;
        let mut params = json!({"include_heartbeats": true});
        if let Some(seq) = self.last_seq {
            params["after_seq"] = json!(seq);
        }
        if !self.opts.names.is_empty() {
            params["names"] = json!(self.opts.names);
        }
        conn.start_stream("events.stream", params)?;
        let first = conn.frame()?;
        if first.get("ok").and_then(Value::as_bool) == Some(false) {
            return crate::socket::unwrap_response(first).map(|_| conn);
        }
        conn.set_read_timeout(Some(SILENCE));
        Ok(conn)
    }

    /// crew-listen's argv: events --cursor-file F --no-ack --no-heartbeat
    /// [--name N]... [--reconnect].
    fn child_argv(&self) -> Vec<String> {
        let mut a = vec!["events".to_string()];
        if let Some(f) = &self.opts.cursor_file {
            a.extend(["--cursor-file".to_string(), f.display().to_string()]);
        }
        a.extend(["--no-ack".to_string(), "--no-heartbeat".to_string()]);
        for n in &self.opts.names {
            a.extend(["--name".to_string(), n.clone()]);
        }
        if self.opts.reconnect {
            a.push("--reconnect".to_string());
        }
        a
    }

    fn spawn_child(&mut self) -> Result<Source, Error> {
        let bin = self.bin.clone().ok_or_else(|| Error::Unavailable("no cmux CLI for events".into()))?;
        let mut child = Command::new(&bin)
            .args(self.child_argv())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Unavailable(format!("cannot run {} events: {e}", bin.display())))?;
        let out = child.stdout.take().expect("piped stdout");
        Ok(Source::Child(child, BufReader::new(out).lines()))
    }

    fn record(&mut self, frame: &Value) {
        if let Some(seq) = frame.get("seq").and_then(Value::as_i64) {
            self.last_seq = Some(seq);
            // The child writes the cursor itself; the socket path writes it here.
            if matches!(self.source, Source::Socket(_)) {
                if let Some(f) = &self.opts.cursor_file {
                    let _ = std::fs::write(f, seq.to_string());
                }
            }
        }
    }

    /// The stream ended. Without reconnect, finish. With it, reopen from the
    /// last seq, waiting 1 s and doubling to 30 s between failed attempts, for
    /// as long as it takes: a cmux restart or a socket that is briefly gone
    /// must not end an always-on listener.
    fn reopen(&mut self) {
        if let Source::Child(child, _) = &mut self.source {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.source = Source::Done;
        if !self.opts.reconnect {
            return;
        }
        let mut wait = BACKOFF;
        loop {
            std::thread::sleep(wait);
            if let Ok(s) = self.open() {
                self.source = s;
                return;
            }
            wait = (wait * 2).min(MAX_BACKOFF);
        }
    }
}

impl Iterator for EventStream {
    type Item = Result<Value, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let got: Result<Option<Value>, Error> = match &mut self.source {
                Source::Done => return None,
                Source::Socket(conn) => match conn.frame() {
                    Ok(f) => Ok(Some(f)),
                    Err(Error::Closed) | Err(Error::Io(_)) => Ok(None),
                    Err(e) => Err(e),
                },
                Source::Child(_, lines) => match lines.next() {
                    Some(Ok(l)) if l.trim().is_empty() => continue,
                    Some(Ok(l)) => serde_json::from_str(&l)
                        .map(Some)
                        .map_err(|e| Error::Protocol(format!("bad event line: {e}"))),
                    Some(Err(_)) | None => Ok(None),
                },
            };
            match got {
                Ok(Some(frame)) => {
                    let ty = frame.get("type").and_then(Value::as_str).unwrap_or("event");
                    if ty != "event" {
                        continue; // ack and heartbeat frames
                    }
                    self.record(&frame);
                    return Some(Ok(frame));
                }
                // The stream ended: reconnect when asked, else finish.
                Ok(None) => {
                    self.reopen();
                    if matches!(self.source, Source::Done) {
                        return None;
                    }
                }
                Err(e) => return Some(Err(e)),
            }
        }
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        if let Source::Child(child, _) = &mut self.source {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn read_cursor(f: &std::path::Path) -> Option<i64> {
    std::fs::read_to_string(f).ok()?.trim().parse().ok()
}
