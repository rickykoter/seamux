//! The Bosun's answer log: one JSON line per answer, a file per local day.
//!
//! ```text
//! <bosun>/log/<YYYY-MM-DD>.jsonl
//!   {id, at, question, answer, sources: [{kind, ref, label}], asker}
//! ```
//!
//! Written only by `seamux bosun log add`; the app's rail reads it with
//! `list`. `kind` is free text the Bosun picks: file, command, query, ticket,
//! dashboard, url, workspace.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub fn log_dir(dir: &Path) -> PathBuf {
    dir.join("log")
}

fn day_ok(day: &str) -> bool {
    day.len() == 10 && day.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
}

/// The entry `v` as it is kept: required fields checked, id and time filled
/// in when missing, unknown fields dropped.
pub fn normalize(v: &Value, now_ms: u64) -> Result<Value, String> {
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let question = text("question").ok_or("an entry needs a question")?;
    let answer = text("answer").ok_or("an entry needs an answer")?;
    let sources = match v.get("sources") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|s| {
                let f = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                if f("ref").is_empty() {
                    return Err("a source needs a ref".to_string());
                }
                Ok(json!({"kind": f("kind"), "ref": f("ref"), "label": f("label")}))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("sources is a list of {kind, ref, label}".into()),
    };
    let id = text("id").unwrap_or_else(|| crate::backend::tmux::new_id().to_ascii_lowercase());
    if !super::queue::valid_id(&id) {
        return Err(format!("not an id: {id:?}"));
    }
    let at = v.get("at").and_then(Value::as_u64).unwrap_or(now_ms);
    Ok(json!({"id": id, "at": at, "question": question, "answer": answer, "sources": sources, "asker": text("asker").unwrap_or_default()}))
}

/// Append `entry` to today's file: the entry as kept.
pub fn add(dir: &Path, entry: &Value) -> Result<Value, String> {
    let now = crate::history::now_ms();
    let e = normalize(entry, now)?;
    let (day, _) = super::launch::local_day_hour((now / 1000) as i64);
    let d = log_dir(dir);
    fs::create_dir_all(&d).map_err(|err| format!("{}: {err}", d.display()))?;
    let mut f = OpenOptions::new().create(true).append(true).open(d.join(format!("{day}.jsonl"))).map_err(|err| err.to_string())?;
    // One write per line, so two writers never interleave inside a line.
    f.write_all(format!("{e}\n").as_bytes()).map_err(|err| err.to_string())?;
    Ok(e)
}

/// The entries of `day` (YYYY-MM-DD), oldest first; a bad line is skipped.
pub fn list(dir: &Path, day: &str) -> Result<Vec<Value>, String> {
    if !day_ok(day) {
        return Err(format!("not a day: {day:?} (YYYY-MM-DD)"));
    }
    let text = fs::read_to_string(log_dir(dir).join(format!("{day}.jsonl"))).unwrap_or_default();
    Ok(text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object).collect())
}

/// The days that have a log, newest first.
pub fn days(dir: &Path) -> Vec<String> {
    let mut d: Vec<String> = fs::read_dir(log_dir(dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".jsonl").map(str::to_string))
        .filter(|d| day_ok(d))
        .collect();
    d.sort();
    d.reverse();
    d
}

/// Up to `n` of the latest entries across the newest days, newest last.
pub fn recent(dir: &Path, n: usize) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for day in days(dir) {
        let mut e = list(dir, &day).unwrap_or_default();
        e.append(&mut out);
        out = e;
        if out.len() >= n {
            break;
        }
    }
    let skip = out.len().saturating_sub(n);
    out.split_off(skip)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_needs_a_question_an_answer_and_refs() {
        assert!(normalize(&json!({"answer": "a"}), 1).is_err());
        assert!(normalize(&json!({"question": "q"}), 1).is_err());
        assert!(normalize(&json!({"question": "q", "answer": "a", "sources": [{"kind": "file"}]}), 1).is_err());
        assert!(normalize(&json!({"question": "q", "answer": "a", "sources": "x"}), 1).is_err());
        let e = normalize(&json!({"question": " q ", "answer": "a", "sources": [{"kind": "file", "ref": "a.rs:3"}], "extra": 1}), 7).unwrap();
        assert_eq!((e["question"].as_str(), e["at"].as_u64(), e.get("extra")), (Some("q"), Some(7), None));
        assert_eq!(e["sources"][0], json!({"kind": "file", "ref": "a.rs:3", "label": ""}));
        assert!(super::super::queue::valid_id(e["id"].as_str().unwrap()));
    }

    #[test]
    fn entries_are_added_listed_and_recent() {
        let d = std::env::temp_dir().join(format!("bosun-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        add(&d, &json!({"id": "e1", "question": "q1", "answer": "a1"})).unwrap();
        add(&d, &json!({"id": "e2", "question": "q2", "answer": "a2"})).unwrap();
        let day = days(&d).remove(0);
        let all = list(&d, &day).unwrap();
        assert_eq!(all.iter().map(|e| e["id"].as_str().unwrap()).collect::<Vec<_>>(), ["e1", "e2"]);
        assert_eq!(recent(&d, 1)[0]["id"], "e2");
        assert!(list(&d, "../x").is_err());
        assert!(list(&d, "2001-01-01").unwrap().is_empty());
        let _ = fs::remove_dir_all(&d);
    }
}
