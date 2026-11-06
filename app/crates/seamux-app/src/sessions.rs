//! A workspace's Claude sessions, for the picker that resumes or swaps one.
//! The records are cmux's own (`sessions list`); the label is the first thing
//! the person asked, read from the session's transcript.

use std::io::{BufRead, BufReader};

use serde::Serialize;
use serde_json::Value;

/// How much of a transcript to read looking for the first prompt.
const SCAN_LINES: usize = 60;
const LABEL_CHARS: usize = 80;

#[derive(Debug, Serialize, PartialEq)]
pub struct SessionRow {
    pub id: String,
    pub cwd: String,
    /// Seconds since the epoch.
    pub updated: f64,
    /// The session cmux says is this workspace's current one.
    pub active: bool,
    pub label: String,
}

/// The Claude sessions of `workspace` (its UUID), the active one first and
/// then newest first.
pub fn rows(records: &[Value], workspace: &str) -> Vec<SessionRow> {
    let str_of = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mine = crew_core::workspaces::sessions_for(workspace, "", records);
    mine.iter()
        .filter(|r| r.get("agent").and_then(Value::as_str).is_none_or(|a| a == "claude"))
        .filter(|r| cmux::is_uuid(&str_of(r, "session_id")))
        .map(|r| SessionRow {
            id: str_of(r, "session_id"),
            cwd: ["cwd", "launch_working_directory"].iter().map(|k| str_of(r, k)).find(|c| !c.is_empty()).unwrap_or_default(),
            updated: r.get("updated_at_unix").and_then(Value::as_f64).unwrap_or(0.0),
            active: r.get("active_for_workspace").and_then(Value::as_bool).unwrap_or(false),
            label: first_prompt(&str_of(r, "transcript_path")),
        })
        .collect()
}

/// How much of the last prompt and the last reply the preview gets.
const EXCHANGE_CHARS: usize = 600;

/// A session's last exchange, for the session search's preview.
#[derive(Debug, Serialize, PartialEq)]
pub struct LastExchange {
    /// The person's last prompt, capped; "" when the tail has none.
    pub prompt: String,
    /// Claude's last reply, capped; "" when the tail has none.
    pub reply: String,
    pub session: String,
    /// Seconds since the epoch the session was last updated.
    pub at: f64,
}

fn capped(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() <= EXCHANGE_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(EXCHANGE_CHARS).collect();
    out.truncate(out.trim_end().len());
    out.push('…');
    out
}

/// The last exchange of `workspace`'s active session, else its newest: the
/// person's last prompt and Claude's last reply, read from the transcript's
/// tail (crew_core::asked). None with no Claude session or a transcript
/// that holds neither.
pub fn last_exchange(records: &[Value], workspace: &str) -> Option<LastExchange> {
    let str_of = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mine = crew_core::workspaces::sessions_for(workspace, "", records);
    // The active session first, then newest: the first whose transcript
    // holds a prompt or a reply (one deleted or not yet written is passed over).
    mine.iter()
        .filter(|r| r.get("agent").and_then(Value::as_str).is_none_or(|a| a == "claude"))
        .filter(|r| cmux::is_uuid(&str_of(r, "session_id")) && !str_of(r, "transcript_path").is_empty())
        .find_map(|r| {
            let (prompt, reply) = exchange_of(&str_of(r, "transcript_path"))?;
            Some(LastExchange { prompt, reply, session: str_of(r, "session_id"), at: r.get("updated_at_unix").and_then(Value::as_f64).unwrap_or(0.0) })
        })
}

/// A transcript's last prompt and reply, capped; None when it holds neither
/// or cannot be read. The page asks again on every frame, so the answer is
/// kept while the file's size and mtime stay the same.
fn exchange_of(path: &str) -> Option<(String, String)> {
    type Seen = (String, u64, std::time::SystemTime, Option<(String, String)>);
    static LAST: std::sync::Mutex<Vec<Seen>> = std::sync::Mutex::new(Vec::new());
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    let (len, mtime) = (meta.len(), meta.modified().ok()?);
    if let Some((_, _, _, x)) = LAST.lock().unwrap().iter().find(|(p, l, m, _)| p == path && *l == len && *m == mtime) {
        return x.clone();
    }
    let payload = serde_json::json!({"transcript_path": path});
    let prompt = capped(&crew_core::asked::last_user_text(&payload));
    let reply = capped(&crew_core::asked::last_assistant_text(&payload).unwrap_or_default());
    let x = (!prompt.is_empty() || !reply.is_empty()).then_some((prompt, reply));
    let mut last = LAST.lock().unwrap();
    last.retain(|(p, ..)| p != path);
    last.push((path.to_string(), len, mtime, x.clone()));
    // A few sessions' worth: the selection moves among a handful of rows.
    if last.len() > 8 {
        last.remove(0);
    }
    x
}

/// Whether a Claude process runs on `surface` by cmux's records: one whose
/// stored process still exists. (Unknown counts as alive: type nothing risky.)
pub fn claude_alive(records: &[Value], surface: &str) -> bool {
    records.iter().any(|r| {
        r.get("agent").and_then(Value::as_str).is_none_or(|a| a == "claude")
            && r.get("surface_id").and_then(Value::as_str).is_some_and(|s| s.eq_ignore_ascii_case(surface))
            && r.get("stored_pid_exists").and_then(Value::as_bool) != Some(false)
    })
}

/// The surfaces (upper case) that have session records and none of them has a
/// live process: their agent is gone and the pane is a terminal.
pub fn gone_surfaces(records: &[Value]) -> Vec<String> {
    let mut gone = std::collections::BTreeSet::new();
    let mut live = std::collections::BTreeSet::new();
    for r in records.iter().filter(|r| r.get("agent").and_then(Value::as_str).is_none_or(|a| a == "claude")) {
        let Some(s) = r.get("surface_id").and_then(Value::as_str).map(str::to_uppercase) else { continue };
        if r.get("stored_pid_exists").and_then(Value::as_bool) == Some(false) {
            gone.insert(s);
        } else {
            live.insert(s);
        }
    }
    gone.difference(&live).cloned().collect()
}

/// One dead session to bring back in the pane it died in.
#[derive(Debug, Serialize, PartialEq)]
pub struct Revival {
    pub surface: String,
    pub workspace: String,
    pub session: String,
    pub cwd: String,
    pub updated: f64,
    pub label: String,
}

/// The sessions to resume after cmux restarted under them: for each live
/// terminal (`panes`: surface, workspace UUID) whose Claude process is gone,
/// the newest session record that ran in it. Newest first.
pub fn revivals(records: &[Value], panes: &[(String, String)]) -> Vec<Revival> {
    let gone = gone_surfaces(records);
    let text = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut out: Vec<Revival> = panes
        .iter()
        .filter(|(surface, _)| gone.contains(&surface.to_uppercase()))
        .filter_map(|(surface, workspace)| {
            let best = records
                .iter()
                .filter(|r| r.get("agent").and_then(Value::as_str).is_none_or(|a| a == "claude"))
                .filter(|r| text(r, "surface_id").eq_ignore_ascii_case(surface) && cmux::is_uuid(&text(r, "session_id")))
                .max_by(|a, b| {
                    let t = |r: &Value| r.get("updated_at_unix").and_then(Value::as_f64).unwrap_or(0.0);
                    t(a).partial_cmp(&t(b)).unwrap_or(std::cmp::Ordering::Equal)
                })?;
            let cwd = ["cwd", "launch_working_directory"].iter().map(|k| text(best, k)).find(|c| !c.is_empty()).unwrap_or_default();
            Some(Revival {
                surface: surface.clone(),
                workspace: workspace.clone(),
                session: text(best, "session_id"),
                cwd,
                updated: best.get("updated_at_unix").and_then(Value::as_f64).unwrap_or(0.0),
                label: first_prompt(&text(best, "transcript_path")),
            })
        })
        .collect();
    out.sort_by(|a, b| b.updated.partial_cmp(&a.updated).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// The first thing the person typed in a transcript: its text, one line,
/// cut short. Empty when the file is missing or holds no prompt yet.
pub fn first_prompt(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let Ok(f) = std::fs::File::open(path) else { return String::new() };
    for line in BufReader::new(f).lines().take(SCAN_LINES).map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("type").and_then(Value::as_str) != Some("user") || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let content = v.pointer("/message/content");
        let text = match content {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        // Tags are harness lines (a slash command's echo, a caveat), not a prompt.
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() || text.starts_with('<') {
            continue;
        }
        return text.chars().take(LABEL_CHARS).collect();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "4d1720f1-de6f-498e-b58e-cc8b66b09027";
    const B: &str = "5a825732-7355-47e5-bb54-7ce18a6b7eb3";

    #[test]
    fn rows_are_this_workspaces_claude_sessions_active_then_newest() {
        let recs = vec![
            json!({"session_id": B, "workspace_id": "W1", "agent": "claude", "updated_at_unix": 20.0, "active_for_workspace": false, "cwd": "/b"}),
            json!({"session_id": A, "workspace_id": "W1", "agent": "claude", "updated_at_unix": 10.0, "active_for_workspace": true, "cwd": "/a"}),
            json!({"session_id": B, "workspace_id": "W2", "agent": "claude", "updated_at_unix": 30.0}),
            json!({"session_id": A, "workspace_id": "W1", "agent": "codex", "updated_at_unix": 40.0}),
        ];
        let got: Vec<_> = rows(&recs, "W1").into_iter().map(|r| (r.id, r.active, r.cwd)).collect();
        assert_eq!(got, vec![(A.into(), true, "/a".into()), (B.into(), false, "/b".into())]);
    }

    #[test]
    fn a_surface_whose_claude_process_is_gone_is_a_terminal() {
        let recs = vec![
            json!({"agent": "claude", "surface_id": "aaa", "stored_pid_exists": false}),
            json!({"agent": "claude", "surface_id": "bbb", "stored_pid_exists": false}),
            json!({"agent": "claude", "surface_id": "BBB", "stored_pid_exists": true}),
            json!({"agent": "claude", "surface_id": "ccc"}),
        ];
        assert_eq!(gone_surfaces(&recs), vec!["AAA".to_string()]);
        assert!(!claude_alive(&recs, "AAA"));
        assert!(claude_alive(&recs, "bbb"));
        assert!(claude_alive(&recs, "ccc"));
        assert!(!claude_alive(&recs, "zzz"));
    }

    #[test]
    fn revivals_pick_the_newest_dead_session_of_each_live_pane() {
        let recs = vec![
            json!({"surface_id": "aaa", "session_id": A, "stored_pid_exists": false, "updated_at_unix": 5.0, "cwd": "/old"}),
            json!({"surface_id": "AAA", "session_id": B, "stored_pid_exists": false, "updated_at_unix": 9.0, "cwd": "/new"}),
            json!({"surface_id": "bbb", "session_id": A, "stored_pid_exists": true, "updated_at_unix": 7.0}),
            json!({"surface_id": "ccc", "session_id": A, "stored_pid_exists": false, "updated_at_unix": 1.0}),
        ];
        // ccc has no live pane (closed); bbb's Claude is alive.
        let panes = vec![("aaa".to_string(), "W1".to_string()), ("bbb".to_string(), "W1".to_string())];
        let got: Vec<_> = revivals(&recs, &panes).into_iter().map(|r| (r.surface, r.session, r.cwd)).collect();
        assert_eq!(got, vec![("aaa".to_string(), B.to_string(), "/new".to_string())]);
    }

    #[test]
    fn the_last_exchange_is_the_active_sessions_last_prompt_and_reply() {
        let dir = std::env::temp_dir().join(format!("seamux-exchange-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, lines: &[Value]| {
            let p = dir.join(name);
            std::fs::write(&p, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
            p.to_string_lossy().into_owned()
        };
        let long = "y".repeat(700);
        let active = write("a.jsonl", &[
            json!({"type": "user", "message": {"content": "first ask"}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "first answer"}]}}),
            json!({"type": "user", "message": {"content": "add the preview"}}),
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}),
            json!({"type": "assistant", "message": {"content": [{"type": "text", "text": long}]}}),
        ]);
        let older = write("b.jsonl", &[json!({"type": "user", "message": {"content": "old"}})]);
        let ws = "68A92708-B9BD-4D9D-9043-A55FD88A17AA";
        let rec = |sid: &str, path: &str, active: bool, at: f64| json!({
            "workspace_id": ws, "agent": "claude", "session_id": sid, "transcript_path": path,
            "active_for_workspace": active, "updated_at_unix": at,
        });
        let records = [
            rec("11111111-1111-4111-8111-111111111111", &older, false, 200.0),
            rec("22222222-2222-4222-8222-222222222222", &active, true, 100.0),
        ];
        let x = last_exchange(&records, ws).unwrap();
        assert_eq!((x.prompt.as_str(), x.session.as_str(), x.at), ("add the preview", "22222222-2222-4222-8222-222222222222", 100.0));
        assert_eq!(x.reply.chars().count(), EXCHANGE_CHARS + 1, "capped, with an ellipsis");
        assert!(x.reply.ends_with('…'));
        assert_eq!(last_exchange(&records, "99999999-8888-7777-6666-555555555555"), None);
        let empty = write("c.jsonl", &[json!({"type": "summary"})]);
        assert_eq!(last_exchange(&[rec("33333333-3333-4333-8333-333333333333", &empty, true, 1.0)], ws), None);
        // An active session whose transcript is gone or empty gives way to the next.
        let gone = dir.join("gone.jsonl").to_string_lossy().into_owned();
        let next = [rec("44444444-4444-4444-8444-444444444444", &gone, true, 300.0), records[0].clone()];
        assert_eq!(last_exchange(&next, ws).map(|x| x.prompt), Some("old".into()));
        // A transcript that grew is read again.
        std::fs::write(&older, [json!({"type": "user", "message": {"content": "newer"}}).to_string()].join("\n")).unwrap();
        assert_eq!(last_exchange(&next, ws).map(|x| x.prompt), Some("newer".into()));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn first_prompt_skips_harness_lines_and_reads_block_content() {
        let dir = std::env::temp_dir().join(format!("seamux-sessions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.jsonl");
        let lines = [
            json!({"type": "summary"}),
            json!({"type": "user", "isMeta": true, "message": {"content": "caveat"}}),
            json!({"type": "user", "message": {"content": "<command-name>/clear</command-name>"}}),
            json!({"type": "user", "message": {"content": [{"type": "text", "text": "fix the\n  wall"}]}}),
        ];
        std::fs::write(&p, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        assert_eq!(first_prompt(p.to_str().unwrap()), "fix the wall");
        assert_eq!(first_prompt("/no/such/file"), "");
        std::fs::remove_dir_all(dir).ok();
    }
}
