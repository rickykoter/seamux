//! The one cmux client for seamux. No other crate talks to cmux.
//!
//! `Cmux::connect()` picks the transport from the environment (`cli_seam.rs`):
//! the socket in live use, the cmux CLI when `CREW_CMUX` is set or
//! `CREW_CMUX_TRANSPORT=cli`, which is how probes put fakecmux.py in front of
//! every tool. The typed ops live in `verbs.rs`; `cli()` is the raw call for a
//! verb no op covers; `events()` follows the event stream (`events.rs`).
//!
//! A `Cmux` holds one socket connection and serializes calls on it. A caller
//! that wants reads in parallel (the app's wall poller) opens one per thread.

mod cli_seam;
mod events;
mod pyjson;
mod socket;
mod verbs;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

pub use cli_seam::{resolve_cli_bin, CLI_TIMEOUT, resolve_cli_bin_with, run_cli, wants_cli, CliOutput, Env, Transport};
pub use events::{EventOptions, EventStream};
pub use verbs::{NewPane, Notify, WorkspaceAction, CLI_ONLY_OPS, SOCKET_OPS};

/// Why a cmux call did not happen.
#[derive(Debug)]
pub enum Error {
    /// cmux is not reachable: no socket, no CLI, or a refused connection.
    Unavailable(String),
    /// cmux answered `ok: false`.
    Refused { code: String, message: String },
    /// The CLI ran and exited non-zero.
    Cli { status: i32, stderr: String },
    /// A handle that is neither a UUID nor a `kind:N` ref. The socket resolves
    /// an unknown handle to some other workspace instead of refusing it, so the
    /// client refuses it first (docs/FINDINGS.md).
    BadHandle(String),
    /// A frame or output that did not parse.
    Protocol(String),
    /// The socket closed.
    Closed,
    Io(std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unavailable(m) => write!(f, "cmux unavailable: {m}"),
            Error::Refused { code, message } => write!(f, "cmux refused ({code}): {message}"),
            Error::Cli { status, stderr } => write!(f, "cmux exited {status}: {}", stderr.trim()),
            Error::BadHandle(h) => write!(f, "not a cmux handle: {h:?}"),
            Error::Protocol(m) => write!(f, "cmux protocol: {m}"),
            Error::Closed => write!(f, "cmux closed the socket"),
            Error::Io(e) => write!(f, "cmux socket: {e}"),
        }
    }
}

impl std::error::Error for Error {}

/// A client on one transport.
pub struct Cmux {
    transport: Transport,
    conn: Option<Mutex<Option<socket::Conn>>>,
    methods: HashSet<String>,
    capabilities: Value,
    cli_override: Option<PathBuf>,
    cli_env: Vec<(String, String)>,
}

impl Cmux {
    /// Connect the way this process's environment asks (see `cli_seam.rs`).
    pub fn connect() -> Result<Cmux, Error> {
        Cmux::open(Transport::from_env()?)
    }

    /// Connect on a given transport. On the socket this reads
    /// `system.capabilities` once, so `has_method` can route each op.
    pub fn open(transport: Transport) -> Result<Cmux, Error> {
        match &transport {
            Transport::Cli(_) => Ok(Cmux {
                transport,
                conn: None,
                methods: HashSet::new(),
                capabilities: Value::Null,
                cli_override: None,
                cli_env: Vec::new(),
            }),
            Transport::Socket(path) => {
                let mut conn = socket::Conn::open(path)?;
                let caps = conn.call("system.capabilities", json!({}))?;
                let methods = caps
                    .get("methods")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                Ok(Cmux {
                    transport,
                    conn: Some(Mutex::new(Some(conn))),
                    methods,
                    capabilities: caps,
                    cli_override: None,
                    cli_env: Vec::new(),
                })
            }
        }
    }

    /// Use this CLI for verbs the socket lacks, instead of resolving one from
    /// the environment. For tests and for a caller that already knows its cmux.
    pub fn with_cli_bin(mut self, bin: PathBuf) -> Cmux {
        self.cli_override = Some(bin);
        self
    }

    /// Set an environment variable on every CLI run this client makes (for
    /// example CMUX_QUIET=1, which workspaces.py passes to each call).
    pub fn with_cli_env(mut self, key: &str, value: &str) -> Cmux {
        self.cli_env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn transport(&self) -> &Transport {
        &self.transport
    }

    /// True on the socket when `system.capabilities` lists the method.
    pub fn has_method(&self, method: &str) -> bool {
        self.methods.contains(method)
    }

    /// True on the socket when `system.capabilities` lists the capability
    /// (for example `events.v1`).
    pub fn has_capability(&self, name: &str) -> bool {
        self.capabilities
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|a| a.iter().any(|c| c.as_str() == Some(name)))
            .unwrap_or(false)
    }

    /// The socket's access mode (`automation`, `cmuxOnly`, ...); None on the CLI.
    pub fn access_mode(&self) -> Option<String> {
        self.capabilities.get("access_mode").and_then(Value::as_str).map(String::from)
    }

    /// The `system.capabilities` answer read at connect; Null on the CLI.
    pub fn capabilities(&self) -> &Value {
        &self.capabilities
    }

    /// A raw v2 call. On the CLI transport it runs `cmux rpc <method> <json>`
    /// and parses what it prints, so the probes see an `rpc` line in cmux.log.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        match &self.transport {
            Transport::Socket(path) => {
                let conn = self.conn.as_ref().expect("socket transport has a connection");
                let mut guard = conn.lock().unwrap_or_else(|p| p.into_inner());
                if guard.is_none() {
                    *guard = Some(socket::Conn::open(path)?);
                }
                let res = guard.as_mut().unwrap().call(method, params);
                // A dead connection is reopened on the next call, never retried
                // here: a retried mutation could land twice.
                if matches!(res, Err(Error::Closed) | Err(Error::Io(_))) {
                    *guard = None;
                }
                res
            }
            Transport::Cli(_) => {
                let argv = vec!["rpc".to_string(), method.to_string(), pyjson::dumps(&params)];
                let out = self.cli_checked(&argv)?;
                parse_cli_json(&out.stdout)
            }
        }
    }

    /// Run the cmux CLI with argv, whatever the transport. For a verb no typed
    /// op covers. A non-zero exit comes back in the output, not as an error.
    pub fn cli<S: AsRef<str>>(&self, argv: &[S]) -> Result<CliOutput, Error> {
        let argv: Vec<String> = argv.iter().map(|a| a.as_ref().to_string()).collect();
        cli_seam::run_cli_env(&self.cli_bin()?, &argv, &self.cli_env, cli_seam::CLI_TIMEOUT)
    }

    /// The CLI this client runs: the transport's own on the CLI path, else the
    /// resolver's (for verbs the socket has no method for).
    pub fn cli_bin(&self) -> Result<PathBuf, Error> {
        match (&self.transport, &self.cli_override) {
            (Transport::Cli(bin), _) => Ok(bin.clone()),
            (Transport::Socket(_), Some(bin)) => Ok(bin.clone()),
            (Transport::Socket(_), None) => resolve_cli_bin(),
        }
    }

    pub(crate) fn cli_checked(&self, argv: &[String]) -> Result<CliOutput, Error> {
        let out = cli_seam::run_cli_env(&self.cli_bin()?, argv, &self.cli_env, cli_seam::CLI_TIMEOUT)?;
        if !out.ok() {
            return Err(Error::Cli { status: out.status, stderr: out.stderr });
        }
        Ok(out)
    }
}

/// CLI output as JSON; empty output (a stand-in that only logs) is Null.
pub(crate) fn parse_cli_json(stdout: &str) -> Result<Value, Error> {
    let t = stdout.trim();
    if t.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(t).map_err(|e| Error::Protocol(format!("cmux CLI printed non-JSON: {e}")))
}

/// A workspace or surface handle the socket can be trusted with: a UUID or a
/// `kind:N` ref. Anything else is refused before it reaches cmux.
pub fn check_handle(kind: &str, h: &str) -> Result<(), Error> {
    if is_uuid(h) {
        return Ok(());
    }
    if let Some(n) = h.strip_prefix(kind).and_then(|r| r.strip_prefix(':')) {
        if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) {
            return Ok(());
        }
    }
    Err(Error::BadHandle(h.to_string()))
}

pub fn is_uuid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts.iter().zip(lens).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles() {
        assert!(check_handle("workspace", "900E133A-68A2-4D5E-AE53-F61629DF32E7").is_ok());
        assert!(check_handle("workspace", "workspace:12").is_ok());
        assert!(check_handle("workspace", "surface:12").is_err());
        assert!(check_handle("workspace", "nope").is_err());
        assert!(check_handle("workspace", "workspace:").is_err());
        assert!(check_handle("surface", "surface:7").is_ok());
    }
}
