//! The built-in adapter for Claude Code workflow runs.
//!
//! A run `<run>` (an id like `wf_f7b371f3-6f2`) leaves these files under the
//! session's folder (layout seen with Claude Code 2.1.319; undocumented):
//!
//! - `workflows/scripts/<name>-<run>.js`, written at the start: its `meta`
//!   gives the name and phase titles.
//! - `subagents/workflows/<run>/journal.jsonl`, appended as it goes:
//!   `started` {agentId, label, phase} and `result` {agentId, result}.
//! - `subagents/workflows/<run>/agent-<id>.{jsonl,meta.json}`, one pair per
//!   agent: its transcript, and its model.
//! - `workflows/<run>.json`, written only when the run ends: the status,
//!   the background task id (taskId), every agent's state and times, the
//!   totals and the summary.
//!
//! A run with its run file is read from that file, with each agent's full
//! result from the journal. A live run is read from the script, the journal
//! and the agent files; it is running while the pane's background list
//! names its workflow, or while its files are fresh.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::host::Context;
use super::model::{badge_of, detail_of, SCHEMA};

/// The newest this many runs are reported.
pub const MAX: usize = 50;

/// The quoted value after `key:` in `text`, from `from` on: enough of
/// JavaScript to read a meta literal's strings.
fn quoted_after(text: &str, key: &str, from: usize) -> Option<(String, usize)> {
    let mut at = from;
    while let Some(i) = text[at..].find(key) {
        let k = at + i;
        at = k + key.len();
        let before = text[..k].chars().next_back();
        if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
            continue;
        }
        let rest = text[at..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else { continue };
        let rest = rest.trim_start();
        let q = rest.chars().next()?;
        if !matches!(q, '\'' | '"' | '`') {
            continue;
        }
        let body = &rest[1..];
        let end = body.find(q)?;
        let start = text.len() - rest.len() + 1;
        return Some((body[..end].to_string(), start + end + 1));
    }
    None
}

/// A script's `export const meta = {...}`: its name and phase titles.
pub fn script_meta(text: &str) -> (Option<String>, Vec<String>) {
    let Some(m) = text.find("export const meta").or_else(|| text.find("const meta")) else { return (None, Vec::new()) };
    // The meta literal ends at its matching brace; braces inside strings
    // do not count.
    let open = text[m..].find('{').map(|i| m + i);
    let close = open.and_then(|o| {
        let mut depth = 0i32;
        let mut quote: Option<char> = None;
        let mut escaped = false;
        // "//" to the line's end, "/*" to "*/": an apostrophe in a comment
        // opens no string.
        let mut line_comment = false;
        let mut block_comment = false;
        let mut prev = '\0';
        for (i, c) in text[o..].char_indices() {
            let last = std::mem::replace(&mut prev, c);
            if line_comment {
                line_comment = c != '\n';
                continue;
            }
            if block_comment {
                if last == '*' && c == '/' {
                    block_comment = false;
                    prev = '\0';
                }
                continue;
            }
            if quote.is_none() && last == '/' && (c == '/' || c == '*') {
                line_comment = c == '/';
                block_comment = c == '*';
                prev = '\0';
                continue;
            }
            if let Some(q) = quote {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
                continue;
            }
            match c {
                '\'' | '"' | '`' => quote = Some(c),
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(o + i + 1);
                    }
                }
                _ => {}
            }
        }
        None
    });
    let (Some(o), Some(c)) = (open, close) else { return (None, Vec::new()) };
    let lit = &text[o..c];
    let phases_at = lit.find("phases");
    let name = quoted_after(lit, "name", 0).map(|(n, _)| n);
    let mut phases = Vec::new();
    if let Some(p) = phases_at {
        let mut at = p;
        while let Some((t, end)) = quoted_after(lit, "title", at) {
            phases.push(t);
            at = end;
        }
    }
    (name, phases)
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// The journal's agents in start order: (id, label, phase), and each
/// result by agent id.
fn journal(dir: &Path) -> (Vec<(String, String, Option<String>)>, Map<String, Value>) {
    let mut started = Vec::new();
    let mut results = Map::new();
    let Ok(text) = std::fs::read_to_string(dir.join("journal.jsonl")) else { return (started, results) };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match s("type").as_str() {
            "started" if !s("agentId").is_empty() => {
                if !started.iter().any(|(id, _, _)| *id == s("agentId")) {
                    started.push((s("agentId"), s("label"), Some(s("phase")).filter(|p| !p.is_empty())));
                }
            }
            "result" if !s("agentId").is_empty() => {
                results.insert(s("agentId"), v.get("result").cloned().unwrap_or(Value::Null));
            }
            _ => {}
        }
    }
    (started, results)
}

fn agent_state(s: &str) -> &'static str {
    match s {
        "done" | "completed" | "succeeded" => "done",
        "failed" | "error" | "errored" => "failed",
        "cancelled" | "canceled" | "killed" | "aborted" => "cancelled",
        "queued" | "pending" | "waiting" => "queued",
        _ => "running",
    }
}

fn run_status(s: &str) -> &'static str {
    match s {
        "completed" | "done" | "succeeded" => "done",
        "failed" | "error" | "errored" => "failed",
        "cancelled" | "canceled" | "killed" | "aborted" => "cancelled",
        "running" => "running",
        _ => "unknown",
    }
}

fn result_json(r: Option<&Value>) -> Value {
    match r.filter(|r| !r.is_null()) {
        Some(r) => json!({"badge": badge_of(r), "detail": detail_of(r)}),
        None => Value::Null,
    }
}

fn transcript_of(dir: &Path, id: &str) -> Option<PathBuf> {
    Some(dir.join(format!("agent-{id}.jsonl"))).filter(|p| p.is_file())
}

/// A finished run, from its run file.
fn finished(file: &Value, dir: &Path) -> Value {
    let s = |k: &str| file.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let n = |k: &str| file.get(k).and_then(Value::as_u64);
    let (_, results) = journal(dir);
    let start = n("startTime");
    let agents: Vec<Value> = file.get("workflowProgress").and_then(Value::as_array).into_iter().flatten()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("workflow_agent"))
        .filter_map(|p| {
            let g = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let id = g("agentId");
            if id.is_empty() {
                return None;
            }
            let state = agent_state(&g("state"));
            let started = p.get("startedAt").and_then(Value::as_u64);
            let ended = match (started, p.get("durationMs").and_then(Value::as_u64)) {
                (Some(s), Some(d)) if state != "running" && state != "queued" => Some(s + d),
                _ => None,
            };
            // A failed agent's error is its hover text.
            let full = results.get(&id).cloned().or_else(|| p.get("resultPreview").cloned())
                .or_else(|| p.get("error").filter(|_| state == "failed").cloned());
            Some(json!({
                "id": id, "label": Some(g("label")).filter(|l| !l.is_empty()).unwrap_or_else(|| id.clone()),
                "phase": Some(g("phaseTitle")).filter(|t| !t.is_empty()),
                "model": Some(g("model")).filter(|m| !m.is_empty()), "state": state,
                "start": started, "end": ended, "tokens": p.get("tokens").and_then(Value::as_u64),
                "result": result_json(full.as_ref()),
                "transcript": transcript_of(dir, &id).map(|t| t.display().to_string()),
            }))
        }).collect();
    let phases: Vec<String> = file.get("phases").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|p| p.get("title").and_then(Value::as_str).map(str::to_string)).collect();
    json!({
        "id": s("runId"), "kind": "workflow", "name": Some(s("workflowName")).filter(|x| !x.is_empty()).unwrap_or_else(|| s("runId")),
        "task": Some(s("taskId")).filter(|t| !t.is_empty()), "status": run_status(&s("status")),
        "start": start, "end": match (start, n("durationMs")) { (Some(a), Some(d)) => Some(a + d), _ => None },
        "phases": phases, "agents": agents, "totals": {"tokens": n("totalTokens")},
        "summary": Some(s("summary")).filter(|x| !x.is_empty()),
    })
}

/// A run with no run file yet: from its script, journal and agent files.
fn live(ctx: &Context, run: &str, dir: &Path, script: Option<&Path>, taken: &mut Vec<String>) -> Value {
    let (name, phases) = script.and_then(|p| std::fs::read_to_string(p).ok()).map(|t| script_meta(&t)).unwrap_or((None, Vec::new()));
    let name = name.unwrap_or_else(|| run.to_string());
    let (started, results) = journal(dir);
    let task = ctx.background.iter().find(|b| b.kind == "workflow" && b.label == name && !taken.contains(&b.id));
    if let Some(t) = task {
        taken.push(t.id.clone());
    }
    let mut newest = script.and_then(super::mtime_ms).unwrap_or(0).max(super::mtime_ms(&dir.join("journal.jsonl")).unwrap_or(0));
    let agents: Vec<Value> = started.iter().map(|(id, label, phase)| {
        let tr = transcript_of(dir, id);
        let f = tr.as_deref().map(super::facts).unwrap_or_default();
        if let Some(t) = tr.as_deref().and_then(super::mtime_ms) {
            newest = newest.max(t);
        }
        let meta = read_json(&dir.join(format!("agent-{id}.meta.json")));
        let model = f.model.clone().or_else(|| meta.as_ref().and_then(|m| m.get("model").and_then(Value::as_str).map(str::to_string)));
        let done = results.get(id);
        // The hooks marked this agent stopped on a permission prompt.
        let needs_you = done.is_none() && ctx.background.iter().any(|b| b.waiting.iter().any(|w| w == id));
        json!({
            "id": id, "label": if label.is_empty() { id.clone() } else { label.clone() }, "phase": phase, "needsYou": needs_you,
            "model": model, "state": if done.is_some() { "done" } else { "running" },
            "start": f.start, "end": done.and(f.end), "tokens": f.tokens, "result": result_json(done),
            "transcript": tr.map(|t| t.display().to_string()),
        })
    }).collect();
    let now = crate::history::now_ms();
    let status = if task.is_some() || now.saturating_sub(newest) < super::STALE_MS { "running" } else { "unknown" };
    let start = script.and_then(super::mtime_ms);
    json!({
        "id": run, "kind": "workflow", "name": name, "task": task.map(|t| t.id.clone()), "status": status,
        "start": start, "phases": phases, "agents": agents,
    })
}

pub fn adapter(ctx: &Context) -> Value {
    let flows = ctx.session_dir.join("workflows");
    let agents_root = ctx.session_dir.join("subagents/workflows");
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: String| if !id.is_empty() && !ids.contains(&id) { ids.push(id) };
    for e in std::fs::read_dir(&agents_root).into_iter().flatten().flatten() {
        if e.path().is_dir() {
            add(e.file_name().to_string_lossy().into_owned());
        }
    }
    for e in std::fs::read_dir(&flows).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if let Some(id) = n.strip_suffix(".json").filter(|_| n.starts_with("wf_")) {
            add(id.to_string());
        }
    }
    let scripts: Vec<PathBuf> = std::fs::read_dir(flows.join("scripts")).into_iter().flatten().flatten().map(|e| e.path()).collect();
    for p in &scripts {
        let n = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if let Some(i) = n.rfind("-wf_").filter(|_| n.ends_with(".js")) {
            add(n[i + 1..n.len() - 3].to_string());
        }
    }
    // Newest first, by a cheap start (the run file's startTime, else the
    // script's or the journal's mtime), and cut to MAX before any
    // transcript is read.
    let script_of = |id: &str| scripts.iter().find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(&format!("-{id}.js")))).cloned();
    let mut order: Vec<(u64, String, Option<Value>)> = ids.into_iter().map(|id| {
        let file = read_json(&flows.join(format!("{id}.json")));
        let start = file.as_ref().and_then(|f| f.get("startTime").and_then(Value::as_u64))
            .or_else(|| script_of(&id).as_deref().and_then(super::mtime_ms))
            .or_else(|| super::mtime_ms(&agents_root.join(&id).join("journal.jsonl")))
            .unwrap_or(0);
        (start, id, file)
    }).collect();
    order.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    // A background task names its workflow, not its run: only the newest
    // live run of that name is it.
    let mut taken: Vec<String> = Vec::new();
    let runs: Vec<Value> = order.into_iter().take(MAX).map(|(_, id, file)| {
        let dir = agents_root.join(&id);
        match file {
            Some(file) => finished(&file, &dir),
            None => live(ctx, &id, &dir, script_of(&id).as_deref(), &mut taken),
        }
    }).collect();
    json!({"schema": SCHEMA, "runs": runs})
}

#[cfg(test)]
mod tests {
    use super::script_meta;

    #[test]
    fn a_scripts_meta_gives_its_name_and_phases() {
        let s = "// meta comes first\nexport const meta = { name: 'review-changes', description: \"a } b\", phases: [{ title: 'Review' }, { title: \"Verify\", detail: 'x' }] }\nconst x = { name: 'other' }";
        assert_eq!(script_meta(s), (Some("review-changes".into()), vec!["Review".into(), "Verify".into()]));
        assert_eq!(script_meta("export const meta = {\n  phases: [{ title: 'A' }],\n  name: `late`,\n}"), (Some("late".into()), vec!["A".into()]));
        assert_eq!(script_meta("no meta here"), (None, vec![]));
        let commented = "export const meta = {\n  // don't count this } brace\n  name: 'x', /* it's { here */ phases: [{ title: 'P' }],\n}";
        assert_eq!(script_meta(commented), (Some("x".into()), vec!["P".into()]), "comments open no strings");
    }
}
