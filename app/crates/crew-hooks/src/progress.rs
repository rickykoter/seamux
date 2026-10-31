//! The task event's publishing: crew/hooks/progress.sh in Rust.
//!
//! Reads the plan Claude Code persists at ~/.claude/tasks/<session_id>/<n>.json
//! and publishes the completed/total bar (set-progress), the whole checklist
//! (todo set) and a pill naming the task in flight (set-status), with the
//! argv progress.sh sends.

use std::path::Path;

use crew_core::pyjson;
use serde_json::{json, Value};

use crate::events::{line, strip_newlines, Hook};
use crate::pyval;

/// The sort key progress.sh gives a task file: its number, else last.
fn order(name: &str) -> u64 {
    let stem = &name[..name.len() - 5];
    if !stem.is_empty() && stem.chars().all(|c| crate::unicode::decimal(c).is_some()) {
        stem.chars().fold(0u64, |n, c| n.saturating_mul(10).saturating_add(crate::unicode::decimal(c).unwrap() as u64))
    } else {
        1 << 30
    }
}

/// `x[:n]` for what a task's subject or active form can be; None where
/// Python's slice raises (which ends the whole script, publishing nothing).
fn slice(v: &Value, n: usize) -> Option<Value> {
    match v {
        Value::String(s) => Some(Value::String(s.chars().take(n).collect())),
        Value::Array(a) => Some(Value::Array(a.iter().take(n).cloned().collect())),
        _ => None,
    }
}

/// The three lines the Python printed (fraction, label, todo JSON), or None
/// when it printed nothing.
pub fn render(tasks_dir: &Path) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(tasks_dir)
        .ok()?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json") && !n.starts_with('.'))
        .collect();
    // sorted() is stable: equal keys keep the directory's order, as glob gave it.
    names.sort_by_key(|n| order(n));

    let (mut done, mut total) = (0u64, 0u64);
    let mut active: Option<Value> = None;
    let mut items = Vec::new();
    for name in names {
        let Ok(Ok(text)) = pyval::read_text(&tasks_dir.join(&name)) else { continue };
        let Ok(Value::Object(t)) = pyval::loads(&text) else { continue };
        if !t.contains_key("subject") {
            continue;
        }
        let status = t.get("status").filter(|s| pyval::truthy(s)).cloned().unwrap_or_else(|| json!("pending"));
        if matches!(status, Value::Array(_) | Value::Object(_)) {
            return None; // STATE.get(<unhashable>) raises
        }
        total += 1;
        let pick = |k: &str| t.get(k).filter(|v| pyval::truthy(v)).cloned();
        if status == json!("completed") {
            done += 1;
        } else if status == json!("in_progress") && active.as_ref().is_none_or(|a| !pyval::truthy(a)) {
            active = Some(pick("activeForm").or_else(|| pick("subject")).unwrap_or_else(|| json!("")));
        }
        let subject = pick("subject").unwrap_or_else(|| json!(""));
        let text = slice(&subject, 200)?;
        let state = match status.as_str() {
            Some("completed") => "completed",
            Some("in_progress") => "in-progress",
            _ => "pending",
        };
        items.push(json!({"text": text, "state": state}));
    }
    if total == 0 {
        return None;
    }
    let active = active.filter(pyval::truthy);
    let label = match &active {
        Some(a) => format!("{done}/{total} · {}", pyval::str_of(a)),
        None => format!("{done}/{total}"),
    };
    let label: String = label.chars().take(120).collect();
    let frac = format!("{:.4}", done as f64 / total as f64);
    let todos = pyjson::dumps_with(&Value::Array(items), pyjson::Opts { compact: true, ..Default::default() });
    Some(format!("{frac}\n{label}\n{todos}"))
}

/// crew_publish_progress.
pub fn publish(h: &Hook) {
    let sid = h.json("session_id");
    if sid.is_empty() {
        return;
    }
    let tasks = crew_core::py::home().join(".claude/tasks").join(&sid);
    if !tasks.is_dir() {
        return;
    }
    let Some(out) = render(&tasks) else { return };
    let out = strip_newlines(&out).to_string();
    let (frac, label, todos) = (line(&out, 1), line(&out, 2), line(&out, 3));
    if frac.is_empty() {
        return;
    }
    // The sidebar's progress is cmux's alone.
    let Some(c) = &h.cmux else { return };
    let _ = c.cli(&["set-progress", &frac, "--label", &label]);
    if !todos.is_empty() {
        let _ = c.cli(&["todo", "set", &todos]);
    }
    // The pill: everything after the first "N/M · ".
    if let Some(i) = label.find(" · ") {
        let active = &label[i + " · ".len()..];
        if !active.is_empty() {
            let _ = c.cli(&["set-status", "claude", active, "--icon", "list.bullet", "--color", "#4C8DFF"]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_like_progress_sh() {
        let d = std::env::temp_dir().join(format!("crew-progress-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let put = |n: &str, v: Value| std::fs::write(d.join(n), v.to_string()).unwrap();
        put("10.json", json!({"subject": "ten", "status": "pending"}));
        put("2.json", json!({"subject": "two", "status": "in_progress", "activeForm": "Doing two"}));
        put("1.json", json!({"subject": "one", "status": "completed"}));
        put("x.json", json!({"no": "subject"}));
        std::fs::write(d.join("bad.json"), "{").unwrap();
        let out = render(&d).unwrap();
        assert_eq!(
            out,
            "0.3333\n1/3 · Doing two\n[{\"text\":\"one\",\"state\":\"completed\"},{\"text\":\"two\",\"state\":\"in-progress\"},{\"text\":\"ten\",\"state\":\"pending\"}]"
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
