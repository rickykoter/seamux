//! Did the turn that just ended leave a question sitting on you?
//! (crew/hooks/asked.py)
//!
//!   seamux asked available              exit 0 when TypeSafe is configured, 1 when not
//!   seamux asked judge < stop-payload   exit 0 asked, 1 not asked, 2 no judgment
//!
//! On a judgment stdout carries three lines: the probability, the question
//! for the banner, then the board's ranking answers as JSON. Any failure is
//! exit 2, never a guess. The question text stays here, next to the code that
//! consumes the answer; config and transport are typesafe.rs's.

use std::io::Read;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::py::{read_tail, splitlines};
use crate::{pyjson, typesafe};

const TAIL_BYTES: u64 = 512 * 1024;
const MAX_CHARS: usize = 4000;
const YES: i32 = 0;
const NO: i32 = 1;
const UNKNOWN: i32 = 2;

fn questions() -> Value {
    json!({
        "blocked_on_user": {
            "type": "noul",
            "instructions": "`last_message` is the final message an AI coding agent wrote before it stopped and handed control back to its user. Is the agent blocked on the user: does the message ask a question, request a decision, approval, or missing information that the agent needs before it can carry on with the task it was given?",
            "criteria": {
                "true": "The task is unfinished and waits on the user's answer: a direct question, a choice between options, a request to confirm a risky step, or a request for credentials, files or facts.",
                "false": "The task is finished or the message only reports results. A closing offer of optional further work (\"want me to open a PR?\", \"let me know if...\") does not block anything."
            }
        },
        "stuck": {
            "type": "noul",
            "instructions": "`last_message` is the final message an AI coding agent wrote before it stopped. Did the agent stop on a failure it could not resolve by itself — an error, missing dependency, or repeated failed attempts that left it unable to continue its task?",
            "criteria": {
                "true": "The agent stopped on an unresolved failure: an error it tried and could not fix, a missing tool, credential or dependency, or the same attempt failing repeatedly.",
                "false": "The agent finished, made progress, or stopped for an ordinary reason such as asking a question, offering options, or reporting results."
            }
        },
        "urgency": {
            "type": "score",
            "instructions": "`last_message` is the final message an AI coding agent wrote before it stopped. How urgently does this message need its human's attention?",
            "criteria": [
                "Routine progress or completion; nothing is requested, nothing failing.",
                "Optional follow-up or a minor preference; safe to leave either way.",
                "The task cannot proceed until the user answers or approves something.",
                "Something is failing or about to be lost: an error, a risky step awaiting confirmation, or work wasted without prompt action."
            ]
        }
    })
}

/// The text blocks of a message's content.
pub fn text_of(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .map(|b| b.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The final assistant text of the turn: the Stop payload's own field when
/// it has one, else the last assistant record with text in the transcript's tail.
pub fn last_assistant_text(payload: &Value) -> std::io::Result<String> {
    if let Some(Value::String(direct)) = payload.get("last_assistant_message") {
        if !direct.trim().is_empty() {
            return Ok(direct.trim().to_string());
        }
    }
    let path = payload.get("transcript_path").and_then(Value::as_str).unwrap_or("");
    if path.is_empty() {
        return Ok(String::new());
    }
    let tail = read_tail(Path::new(path), TAIL_BYTES)?;
    for line in splitlines(&tail).into_iter().rev() {
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        if rec.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let text = text_of(rec.get("message").unwrap_or(&Value::Null));
        let text = text.trim();
        if !text.is_empty() {
            return Ok(text.to_string());
        }
    }
    Ok(String::new())
}

/// `round(x, 3)`.
fn round3(x: f64) -> f64 {
    format!("{x:.3}").parse().unwrap_or(x)
}

/// (p_blocked, extras): extras carries the ranking answers, best-effort.
pub fn ask(key: &str, text: &str) -> Result<(f64, Map<String, Value>), String> {
    let chars: Vec<char> = text.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(MAX_CHARS)..].iter().collect();
    let answers = typesafe::ask(key, &json!({"last_message": tail}), &questions())?;
    let mut extras = Map::new();
    let stuck = answers.pointer("/stuck/noul").and_then(num);
    let urgency = answers.pointer("/urgency/score").and_then(num);
    // Both or neither, as the Python's one try block gives.
    if let (Some(s), Some(u)) = (stuck, urgency) {
        extras.insert("stuck".into(), pyjson::float(round3(s)));
        extras.insert("urgency".into(), pyjson::float(round3(u)));
    } else if let Some(s) = stuck {
        extras.insert("stuck".into(), pyjson::float(round3(s)));
    }
    let p = answers
        .pointer("/blocked_on_user/noul")
        .and_then(num)
        .ok_or_else(|| "KeyError: 'blocked_on_user'".to_string())?;
    Ok((p, extras))
}

/// Python's float(): numbers, numeric strings and bools.
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(*b as u8 as f64),
        _ => None,
    }
}

/// The banner's sentence: the last line ending in '?', else the last line.
pub fn banner_line(text: &str) -> String {
    let lines: Vec<&str> = splitlines(text).into_iter().map(str::trim).filter(|l| !l.is_empty()).collect();
    let take200 = |s: &str| s.chars().take(200).collect::<String>();
    for l in lines.iter().rev() {
        if l.ends_with('?') {
            return take200(l);
        }
    }
    take200(lines.last().copied().unwrap_or("Claude is waiting on you"))
}

const DOC: &str = "crew — did the turn that just ended leave a question sitting on you?

    asked.py available              exit 0 when TypeSafe is configured, 1 when not
    asked.py judge < stop-payload   exit 0 asked, 1 not asked, 2 no judgment
";

pub fn main(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("available") => {
            if typesafe::api_key().is_empty() {
                NO
            } else {
                YES
            }
        }
        Some("judge") => {
            let key = typesafe::api_key();
            if key.is_empty() {
                return UNKNOWN;
            }
            let mut input = String::new();
            let _ = std::io::stdin().read_to_string(&mut input);
            let run = || -> Result<Option<(f64, Map<String, Value>, String)>, String> {
                let payload: Value = serde_json::from_str(if input.is_empty() { "{}" } else { &input })
                    .map_err(|e| e.to_string())?;
                if !payload.is_object() {
                    return Err("the Stop payload must be a JSON object".into());
                }
                let text = last_assistant_text(&payload).map_err(|e| e.to_string())?;
                if text.is_empty() {
                    return Ok(None);
                }
                let (p, extras) = ask(&key, &text)?;
                Ok(Some((p, extras, text)))
            };
            match run() {
                Ok(None) => UNKNOWN,
                Err(e) => {
                    eprintln!("asked: {e}");
                    UNKNOWN
                }
                Ok(Some((p, extras, text))) => {
                    print!("{p:.3}\n{}\n{}\n", banner_line(&text), pyjson::dumps(&Value::Object(extras)));
                    if p >= typesafe::threshold("threshold", 0.7) {
                        YES
                    } else {
                        NO
                    }
                }
            }
        }
        _ => {
            eprint!("{DOC}");
            UNKNOWN
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banner() {
        assert_eq!(banner_line("Done.\nShould I take A or B?\nThanks"), "Should I take A or B?");
        assert_eq!(banner_line("all\nfinished  "), "finished");
        assert_eq!(banner_line(""), "Claude is waiting on you");
    }

    #[test]
    fn rounding() {
        assert_eq!(round3(0.12), 0.12);
        assert_eq!(round3(2.10049), 2.1);
    }
}
