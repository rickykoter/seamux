//! Did the turn that just ended leave a question sitting on you?
//! (the former crew/hooks/asked.py)
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

/// What the other fields of the state are, said once to each question.
const CONTEXT: &str = " The other fields are context for judging it: `last_prompt` is what the user last asked, `workspace_label` and `branch` name the work, `plan_phase` is its plan's phase (\"none\" without one), and `signals` holds the workspace's pull request, CI and review state as tokens such as ci:fail or review:changes.";

fn questions() -> Value {
    json!({
        "blocked_on_user": {
            "type": "noul",
            "instructions": format!("{}{}", "`last_message` is the final message an AI coding agent wrote before it stopped and handed control back to its user. Is the agent blocked on the user: does the message ask a question, request a decision, approval, or missing information that the agent needs before it can carry on with the task it was given?", CONTEXT),
            "criteria": {
                "true": "The task is unfinished and waits on the user's answer: a direct question, a choice between options, a request to confirm a risky step, or a request for credentials, files or facts.",
                "false": "The task is finished or the message only reports results. A closing offer of optional further work (\"want me to open a PR?\", \"let me know if...\") does not block anything."
            }
        },
        "stuck": {
            "type": "noul",
            "instructions": format!("{}{}", "`last_message` is the final message an AI coding agent wrote before it stopped. Did the agent stop on a failure it could not resolve by itself — an error, missing dependency, or repeated failed attempts that left it unable to continue its task?", CONTEXT),
            "criteria": {
                "true": "The agent stopped on an unresolved failure: an error it tried and could not fix, a missing tool, credential or dependency, or the same attempt failing repeatedly.",
                "false": "The agent finished, made progress, or stopped for an ordinary reason such as asking a question, offering options, or reporting results."
            }
        },
        "urgency": {
            "type": "score",
            "instructions": format!("{}{}", "`last_message` is the final message an AI coding agent wrote before it stopped. How urgently does this message need its human's attention?", CONTEXT),
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

/// The person's last prompt of the turn: the newest user record in the
/// transcript's tail whose content is their own text. Not a tool's result,
/// and not what Claude Code writes as a user line itself (meta lines, a
/// compaction summary, an interrupt notice, a slash command's or reminder's
/// tag block), as crew-store's prompt_of reads prompts. A prompt more than
/// the tail back is not found, and the state says "" for it.
pub fn last_user_text(payload: &Value) -> String {
    let path = payload.get("transcript_path").and_then(Value::as_str).unwrap_or("");
    if path.is_empty() {
        return String::new();
    }
    let Ok(tail) = read_tail(Path::new(path), TAIL_BYTES) else { return String::new() };
    for line in splitlines(&tail).into_iter().rev() {
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        let flag = |k: &str| rec.get(k).and_then(Value::as_bool) == Some(true);
        if rec.get("type").and_then(Value::as_str) != Some("user") || flag("isMeta") || flag("isCompactSummary") {
            continue;
        }
        let msg = rec.get("message").unwrap_or(&Value::Null);
        if msg.get("content").and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))) {
            continue;
        }
        let text = text_of(msg);
        let text = text.trim();
        // Claude Code's own blocks, not the person's words: a slash command,
        // its output, a hook's or a reminder's tag, an interrupt notice. A
        // prompt that only starts with "<" (a diff, an HTML snippet) stays.
        const OWN: [&str; 6] = ["<command-", "<local-command-", "<system-reminder>", "<user-prompt-submit-hook>", "<bash-", "[Request interrupted"];
        if OWN.iter().any(|p| text.starts_with(p)) {
            continue;
        }
        if !text.is_empty() {
            return text.to_string();
        }
    }
    String::new()
}

/// The last MAX_CHARS characters of `s`.
fn tail_chars(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(MAX_CHARS)..].iter().collect()
}

/// What Jev is shown at turn end, the shape the sweep uses (ADR: the
/// turn-end judgment sees the turn's context): the last message and prompt,
/// the branch and the plan phase from the payload's cwd, and what the hook
/// adds as `crew_context` (the workspace's label and its pr:, ci: and
/// review: tokens). Tool output and earlier turns are not sent.
pub fn state_of(payload: &Value, text: &str) -> Value {
    let cwd = payload.get("cwd").and_then(Value::as_str).unwrap_or("");
    let ctx = payload.get("crew_context").cloned().unwrap_or(Value::Null);
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let branch = if cwd.is_empty() { String::new() } else { crate::workspaces::branch(cwd) };
    let phase = if cwd.is_empty() { String::new() } else { crate::workspaces::protects(cwd).phase };
    json!({
        "last_message": tail_chars(text),
        "last_prompt": tail_chars(&last_user_text(payload)),
        "workspace_label": s(&ctx, "label"),
        "branch": if branch.is_empty() { "none".to_string() } else { branch },
        "plan_phase": if phase.is_empty() { "none".to_string() } else { phase },
        "signals": s(&ctx, "signals"),
    })
}

/// `round(x, 3)`.
fn round3(x: f64) -> f64 {
    format!("{x:.3}").parse().unwrap_or(x)
}

/// (p_blocked, extras): extras carries the ranking answers, best-effort.
/// `state` is `state_of`'s, or any object with a `last_message`.
pub fn ask(key: &str, state: &Value) -> Result<(f64, Map<String, Value>), String> {
    let answers = typesafe::ask(key, state, &questions())?;
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
                let (p, extras) = ask(&key, &state_of(&payload, &text))?;
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

    #[test]
    fn the_state_carries_the_last_prompt_and_the_hooks_context() {
        let dir = std::env::temp_dir().join(format!("asked-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let t = dir.join("t.jsonl");
        let mut lines = vec![
            json!({"type": "user", "message": {"content": "first ask"}}),
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "ship the retry fix"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}]}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "exit 0"}]}}),
            json!({"type": "user", "isMeta": true, "message": {"content": "Caveat: a meta line"}}),
            json!({"type": "user", "message": {"content": "[Request interrupted by user]"}}),
            json!({"type": "user", "message": {"content": "<command-name>/compact</command-name>"}}),
        ];
        let write = |lines: &[Value]| std::fs::write(&t, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        write(&lines);
        let payload = json!({"transcript_path": t, "crew_context": {"label": "PROJ-3", "signals": "ci:fail review:changes"}});
        let s = state_of(&payload, "Want me to retry?");
        assert_eq!(s["last_message"], "Want me to retry?");
        assert_eq!(s["last_prompt"], "ship the retry fix", "a tool's result, a meta line, an interrupt or a command block is not the person's prompt");
        lines.push(json!({"type": "user", "message": {"content": "<div> is not closed in the page"}}));
        write(&lines);
        assert_eq!(state_of(&payload, "x")["last_prompt"], "<div> is not closed in the page", "a prompt that starts with < is still the person's");
        assert_eq!((s["workspace_label"].as_str(), s["signals"].as_str()), (Some("PROJ-3"), Some("ci:fail review:changes")));
        assert_eq!((s["branch"].as_str(), s["plan_phase"].as_str()), (Some("none"), Some("none")), "no cwd: none");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
