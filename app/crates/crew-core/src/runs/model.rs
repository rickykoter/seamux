//! The run model, `seamux.run/1`: what an adapter prints and what the board,
//! the run page and the transcript page read. docs/RUNS.md is its reference.
//!
//! A document is `{"schema": "seamux.run/1", "runs": [...]}`. A run is one
//! background job a session started: a lone sub-agent, or an orchestrated
//! run of many agents (a Claude Code workflow, or anything an adapter
//! understands). Every field but a run's id and status and an agent's id and
//! state is optional; `parse_doc` fills defaults, trims what is too long and
//! refuses what it cannot read, naming the field.

use serde_json::{json, Map, Value};

pub const SCHEMA: &str = "seamux.run/1";
/// A run's status.
pub const RUN_STATUS: [&str; 5] = ["running", "done", "failed", "cancelled", "unknown"];
/// An agent's state.
pub const AGENT_STATES: [&str; 5] = ["queued", "running", "done", "failed", "cancelled"];
/// A result badge sits on a timeline bar: a few characters at most.
pub const BADGE_MAX: usize = 8;
/// Hover text, trimmed to this many characters.
pub const DETAIL_MAX: usize = 2_000;
/// Past these, the rest of a document is dropped: no page needs more.
pub const RUNS_MAX: usize = 50;
pub const AGENTS_MAX: usize = 500;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AgentResult {
    /// A few characters for the bar: a score, a verdict.
    pub badge: Option<String>,
    /// The longer text hover shows.
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Agent {
    pub id: String,
    pub label: String,
    pub phase: Option<String>,
    pub model: Option<String>,
    /// One of AGENT_STATES.
    pub state: String,
    /// Milliseconds since the epoch.
    pub start: Option<u64>,
    pub end: Option<u64>,
    /// The agent waits on the person.
    pub needs_you: bool,
    pub tokens: Option<u64>,
    pub result: Option<AgentResult>,
    /// The agent's transcript: an absolute path to a JSONL file.
    pub transcript: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Totals {
    pub agents: u64,
    pub done: u64,
    pub failed: u64,
    pub tokens: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Run {
    pub id: String,
    /// "agent" for a lone sub-agent, "workflow" for an orchestrated run, or
    /// the adapter's own word.
    pub kind: String,
    pub name: String,
    /// The adapter that produced it; the host sets it.
    pub source: String,
    /// The id of the Claude Code background task this run is, when known:
    /// it ties the run to the pane's background list.
    pub task: Option<String>,
    /// One of RUN_STATUS.
    pub status: String,
    pub start: Option<u64>,
    pub end: Option<u64>,
    /// How many agents may run at once, when the orchestrator says.
    pub cap: Option<u64>,
    /// Phase titles, in order.
    pub phases: Vec<String>,
    pub agents: Vec<Agent>,
    pub totals: Totals,
    pub summary: Option<String>,
    /// Something the adapter wants said about this run (a partial read, an
    /// unknown field it skipped).
    pub notice: Option<String>,
}

fn trim(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
    }
}

fn opt_str(o: &Map<String, Value>, k: &str) -> Option<String> {
    o.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn opt_u64(o: &Map<String, Value>, k: &str, at: &str) -> Result<Option<u64>, String> {
    match o.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
            .map(Some).ok_or_else(|| format!("{at}.{k}: expected a number, got {v}")),
    }
}

fn one_of(o: &Map<String, Value>, k: &str, allowed: &[&str], at: &str) -> Result<String, String> {
    let v = o.get(k).and_then(Value::as_str).ok_or_else(|| format!("{at}.{k}: missing"))?;
    if allowed.contains(&v) {
        Ok(v.to_string())
    } else {
        Err(format!("{at}.{k}: {v:?} is not one of {}", allowed.join(", ")))
    }
}

fn agent_of(v: &Value, at: &str) -> Result<Agent, String> {
    let o = v.as_object().ok_or_else(|| format!("{at}: expected an object"))?;
    let id = opt_str(o, "id").ok_or_else(|| format!("{at}.id: missing"))?;
    let result = match o.get("result") {
        None | Some(Value::Null) => None,
        Some(Value::Object(r)) => Some(AgentResult {
            badge: opt_str(r, "badge").map(|b| trim(&b, BADGE_MAX)),
            detail: opt_str(r, "detail").map(|d| trim(&d, DETAIL_MAX)),
        }).filter(|r| r.badge.is_some() || r.detail.is_some()),
        Some(other) => return Err(format!("{at}.result: expected an object, got {other}")),
    };
    let transcript = opt_str(o, "transcript");
    if let Some(t) = &transcript {
        if !t.starts_with('/') {
            return Err(format!("{at}.transcript: {t:?} is not an absolute path"));
        }
    }
    Ok(Agent {
        label: opt_str(o, "label").unwrap_or_else(|| id.clone()),
        phase: opt_str(o, "phase"),
        model: opt_str(o, "model"),
        state: one_of(o, "state", &AGENT_STATES, at)?,
        start: opt_u64(o, "start", at)?,
        end: opt_u64(o, "end", at)?,
        needs_you: o.get("needsYou").and_then(Value::as_bool).unwrap_or(false),
        tokens: opt_u64(o, "tokens", at)?,
        result,
        transcript,
        id,
    })
}

fn run_of(v: &Value, at: &str, source: &str) -> Result<Run, String> {
    let o = v.as_object().ok_or_else(|| format!("{at}: expected an object"))?;
    let id = opt_str(o, "id").ok_or_else(|| format!("{at}.id: missing"))?;
    let agents = match o.get("agents") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().take(AGENTS_MAX).enumerate()
            .map(|(i, a)| agent_of(a, &format!("{at}.agents[{i}]"))).collect::<Result<Vec<_>, _>>()?,
        Some(other) => return Err(format!("{at}.agents: expected a list, got {other}")),
    };
    let phases = match o.get("phases") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.iter().filter_map(|p| p.as_str().map(str::to_string)
            .or_else(|| p.get("title").and_then(Value::as_str).map(str::to_string))).collect(),
        Some(other) => return Err(format!("{at}.phases: expected a list, got {other}")),
    };
    let given = o.get("totals").and_then(Value::as_object);
    let summed: u64 = agents.iter().filter_map(|a| a.tokens).sum();
    let totals = Totals {
        agents: agents.len() as u64,
        done: agents.iter().filter(|a| a.state == "done").count() as u64,
        failed: agents.iter().filter(|a| a.state == "failed").count() as u64,
        tokens: match given {
            Some(g) => opt_u64(g, "tokens", &format!("{at}.totals"))?,
            None => None,
        }.or((summed > 0).then_some(summed)),
    };
    Ok(Run {
        kind: opt_str(o, "kind").unwrap_or_else(|| if agents.len() == 1 { "agent".into() } else { "workflow".into() }),
        name: opt_str(o, "name").unwrap_or_else(|| id.clone()),
        source: source.to_string(),
        task: opt_str(o, "task"),
        status: one_of(o, "status", &RUN_STATUS, at)?,
        start: opt_u64(o, "start", at)?,
        end: opt_u64(o, "end", at)?,
        cap: opt_u64(o, "cap", at)?,
        summary: opt_str(o, "summary").map(|s| trim(&s, DETAIL_MAX)),
        notice: opt_str(o, "notice").map(|s| trim(&s, 300)),
        phases,
        agents,
        totals,
        id,
    })
}

/// Read an adapter's document, every run tagged with `source`.
pub fn parse_doc(v: &Value, source: &str) -> Result<Vec<Run>, String> {
    let o = v.as_object().ok_or("expected a JSON object")?;
    match o.get("schema").and_then(Value::as_str) {
        Some(SCHEMA) => {}
        Some(other) => return Err(format!("schema: {other:?}, expected {SCHEMA:?}")),
        None => return Err(format!("schema: missing, expected {SCHEMA:?}")),
    }
    let runs = o.get("runs").and_then(Value::as_array).ok_or("runs: expected a list")?;
    runs.iter().take(RUNS_MAX).enumerate().map(|(i, r)| run_of(r, &format!("runs[{i}]"), source)).collect()
}

impl Agent {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "label": self.label, "phase": self.phase, "model": self.model,
            "state": self.state, "start": self.start, "end": self.end, "needsYou": self.needs_you,
            "tokens": self.tokens, "transcript": self.transcript,
            "result": self.result.as_ref().map(|r| json!({"badge": r.badge, "detail": r.detail})),
        })
    }
}

impl Run {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "kind": self.kind, "name": self.name, "source": self.source, "task": self.task,
            "status": self.status, "start": self.start, "end": self.end, "cap": self.cap,
            "phases": self.phases, "agents": self.agents.iter().map(Agent::to_json).collect::<Vec<_>>(),
            "totals": {"agents": self.totals.agents, "done": self.totals.done, "failed": self.totals.failed,
                       "tokens": self.totals.tokens},
            "summary": self.summary, "notice": self.notice,
        })
    }
}

/// The badge convention: an agent that returns an object (or a string
/// holding one) with a badge, score or verdict field gets that as its badge.
/// Anything else has none, and hover shows the first lines.
pub fn badge_of(result: &Value) -> Option<String> {
    let parsed;
    let obj = match result {
        Value::Object(o) => o,
        Value::String(s) => {
            let t = s.trim();
            let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).map(|t| t.trim_end_matches('`').trim()).unwrap_or(t);
            parsed = serde_json::from_str::<Value>(t).ok()?;
            parsed.as_object()?
        }
        _ => return None,
    };
    ["badge", "score", "verdict"].iter().find_map(|k| match obj.get(*k)? {
        Value::String(s) if !s.trim().is_empty() => Some(trim(s.trim(), BADGE_MAX)),
        Value::Number(n) => Some(trim(&n.to_string(), BADGE_MAX)),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

/// A result's hover text: the string itself, or the object as JSON.
pub fn detail_of(result: &Value) -> Option<String> {
    let s = match result {
        Value::Null => return None,
        Value::String(s) => s.trim().to_string(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    (!s.is_empty()).then(|| trim(&s, DETAIL_MAX))
}
