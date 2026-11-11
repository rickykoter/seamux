//! Runs: the background sub-agents and orchestrated runs a session started,
//! read by adapters into the neutral `seamux.run/1` model (docs/RUNS.md).
//!
//! `model` is the schema and its validation, `host` finds and runs adapters,
//! and the two Claude Code adapters are built in: `claude_subagents` reads
//! a session's background sub-agents, `claude_workflow` its workflow runs.
//! Hooks say whether background work runs (crew_core::status); these files
//! only add the detail, so a change in Claude Code's undocumented layout
//! loses detail and never status.
//!
//! ```text
//! seamux runs <session-id> [--all] [--cwd DIR]
//! ```
//!
//! prints the session's report: its runs and any notices. Without --all
//! only adapters for the pane's background tasks run.

pub mod claude_subagents;
pub mod claude_workflow;
pub mod draft;
pub mod host;
pub mod launches;
pub mod model;

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

pub use host::{Adapter, Context, Notice, Report};
pub use model::{Agent, AgentResult, Run};

/// The two adapters seamux ships, ahead of any command adapter.
pub fn builtins() -> Vec<Adapter> {
    vec![
        Adapter::Builtin { name: "claude-subagents", recognizes: &["subagent"], watch: &["subagents"], run: claude_subagents::adapter },
        Adapter::Builtin { name: "claude-workflow", recognizes: &["workflow"], watch: &["workflows", "subagents/workflows"], run: claude_workflow::adapter },
    ]
}

/// Claude Code's folder for a session: the `<session>` folder or transcript
/// beside it, in whichever project folder holds it.
pub fn session_dir(session: &str) -> Option<PathBuf> {
    // A session id is a uuid: letters, digits and dashes, nothing a path
    // could climb with.
    if session.is_empty() || !session.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    let root = crate::workspaces::projects();
    std::fs::read_dir(&root).ok()?.flatten().map(|e| e.path()).find_map(|p| {
        let d = p.join(session);
        (d.is_dir() || p.join(format!("{session}.jsonl")).is_file()).then_some(d)
    })
}

/// The context for a session: its folder, and the background list of the
/// pane that runs it (none when no pane file names the session).
pub fn context_for(session: &str, cwd: &str) -> Option<Context> {
    let dir = session_dir(session)?;
    let transcript = dir.with_extension("jsonl");
    let pane = crate::status::all(&crate::home::xdg_cache()).into_iter().find(|p| p.session == session);
    Some(Context {
        session: session.to_string(),
        transcript: transcript.is_file().then_some(transcript),
        session_dir: dir,
        cwd: cwd.to_string(),
        background: pane.map(|p| p.background).unwrap_or_default(),
    })
}

/// What a transcript says of the agent that wrote it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    pub start: Option<u64>,
    pub end: Option<u64>,
    pub model: Option<String>,
    /// Input, output and cache tokens, each API message counted once.
    pub tokens: Option<u64>,
    /// The last assistant text.
    pub last_text: Option<String>,
}

fn ts_ms(v: &Value) -> Option<u64> {
    v.get("timestamp").and_then(Value::as_str).and_then(crate::py::iso_timestamp).map(|t| (t * 1000.0) as u64)
}

/// Read a JSONL transcript once, line by line.
pub fn facts(path: &Path) -> Facts {
    let mut f = Facts::default();
    let Ok(file) = std::fs::File::open(path) else { return f };
    let mut seen: Vec<String> = Vec::new();
    let mut tokens = 0u64;
    let mut handed = false;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if !line.contains("\"timestamp\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(t) = ts_ms(&v) {
            f.start = Some(f.start.map_or(t, |s| s.min(t)));
            f.end = Some(f.end.map_or(t, |e| e.max(t)));
        }
        if v.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(m) = v.get("message") else { continue };
        if let Some(model) = m.get("model").and_then(Value::as_str).filter(|s| !s.starts_with('<')) {
            f.model = Some(model.to_string());
        }
        let id = m.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(u) = m.get("usage").filter(|_| id.is_empty() || !seen.contains(&id)) {
            for k in ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] {
                tokens += u.get(k).and_then(Value::as_u64).unwrap_or(0);
            }
            if !id.is_empty() {
                seen.push(id);
            }
        }
        let text: Vec<&str> = m.get("content").and_then(Value::as_array).map(|c| c.iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str)).collect()).unwrap_or_default();
        if !text.is_empty() && !handed {
            f.last_text = Some(text.join("\n"));
        }
        // An agent hands its report back through SubagentHandback: that is
        // its result, whatever it says after.
        for b in m.get("content").and_then(Value::as_array).into_iter().flatten() {
            if b.get("type").and_then(Value::as_str) == Some("tool_use") && b.get("name").and_then(Value::as_str) == Some("SubagentHandback") {
                if let Some(msg) = b.get("input").and_then(|i| i.get("message")).and_then(Value::as_str).filter(|x| !x.trim().is_empty()) {
                    f.last_text = Some(msg.trim().to_string());
                    handed = true;
                }
            }
        }
    }
    f.tokens = (tokens > 0).then_some(tokens);
    f
}

/// A file's modification time in ms.
pub fn mtime_ms(p: &Path) -> Option<u64> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64)
}

/// A run nothing has written to for this long, and no background task
/// names, reads as unknown rather than running: it was likely killed.
pub const STALE_MS: u64 = 10 * 60_000;

pub fn main(args: &[String]) -> i32 {
    let mut session = None;
    let mut all = false;
    let mut cwd = String::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--all" => all = true,
            "--cwd" => cwd = it.next().cloned().unwrap_or_default(),
            "-h" | "--help" => {
                println!("usage: seamux runs <session-id> [--all] [--cwd DIR]");
                return 0;
            }
            s if session.is_none() && !s.starts_with('-') => session = Some(s.to_string()),
            other => {
                eprintln!("seamux runs: unexpected argument {other:?}");
                return 2;
            }
        }
    }
    let Some(session) = session else {
        eprintln!("usage: seamux runs <session-id> [--all] [--cwd DIR]");
        return 2;
    };
    let Some(ctx) = context_for(&session, &cwd) else {
        eprintln!("seamux runs: no Claude Code session {session:?} under {}", crate::workspaces::projects().display());
        return 1;
    };
    let (adapters, mut bad) = host::adapters();
    let mut rep = host::report(&ctx, &adapters, all);
    rep.notices.append(&mut bad);
    println!("{}", serde_json::to_string_pretty(&rep.to_json()).unwrap_or_default());
    0
}
