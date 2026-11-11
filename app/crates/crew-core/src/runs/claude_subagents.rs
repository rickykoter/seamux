//! The built-in adapter for Claude Code's background sub-agents.
//!
//! Each `<session>/subagents/agent-<id>.meta.json` that Claude Code wrote
//! for a background launch (requestShape "background") is one run of one
//! agent. Claude Code writes the meta file at launch and adds
//! `"finished": true` when the agent ends; the transcript beside it,
//! `agent-<id>.jsonl`, gives times, the model, tokens and the last reply.
//! The agent id is the background task's id on the pane's list.
//! (Layout seen with Claude Code 2.1.319; it is undocumented.)

use serde_json::{json, Value};

use super::host::Context;
use super::model::{badge_of, detail_of, SCHEMA};

/// The newest this many sub-agents are reported.
pub const MAX: usize = 50;

pub fn adapter(ctx: &Context) -> Value {
    let dir = ctx.session_dir.join("subagents");
    let mut runs: Vec<(u64, Value)> = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else { return json!({"schema": SCHEMA, "runs": []}) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_prefix("agent-").and_then(|n| n.strip_suffix(".meta.json")) else { continue };
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let Ok(meta) = serde_json::from_str::<Value>(&text) else { continue };
        let s = |k: &str| meta.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        if s("requestShape") != "background" {
            continue;
        }
        let transcript = dir.join(format!("agent-{id}.jsonl"));
        let f = super::facts(&transcript);
        let finished = meta.get("finished").and_then(Value::as_bool).unwrap_or(false);
        let listed = ctx.background.iter().any(|b| b.id == id);
        let touched = super::mtime_ms(&transcript).or_else(|| super::mtime_ms(&e.path())).unwrap_or(0);
        let now = crate::history::now_ms();
        let status = if finished {
            "done"
        } else if listed || now.saturating_sub(touched) < super::STALE_MS {
            "running"
        } else {
            "unknown"
        };
        let label = [s("description"), s("agentType")].into_iter().find(|l| !l.is_empty()).unwrap_or_else(|| id.to_string());
        let model = f.model.clone().or_else(|| meta.get("model").and_then(Value::as_str).map(str::to_string))
            .or_else(|| meta.get("pickedEffortModel").and_then(Value::as_str).map(str::to_string));
        let reply = f.last_text.clone().map(Value::String).unwrap_or(Value::Null);
        let result = if finished {
            json!({"badge": badge_of(&reply), "detail": detail_of(&reply)})
        } else {
            Value::Null
        };
        let start = f.start.or_else(|| super::mtime_ms(&e.path()));
        let end = if finished { f.end } else { None };
        // The hooks marked it stopped on a permission prompt.
        let needs_you = !finished && ctx.background.iter().any(|b| b.waiting.iter().any(|w| w == id));
        let agent = json!({
            "id": id, "label": label, "model": model, "state": if finished { "done" } else { "running" }, "needsYou": needs_you,
            "start": start, "end": end, "tokens": f.tokens, "result": result,
            "transcript": transcript.is_file().then(|| transcript.display().to_string()),
        });
        runs.push((start.unwrap_or(0), json!({
            "id": id, "kind": "agent", "name": label, "task": id, "status": status,
            "start": start, "end": end, "agents": [agent],
        })));
    }
    runs.sort_by(|a, b| b.0.cmp(&a.0));
    json!({"schema": SCHEMA, "runs": runs.into_iter().take(MAX).map(|(_, r)| r).collect::<Vec<_>>()})
}
