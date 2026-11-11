//! Which prompt launched each background run, read from the session's own
//! transcript, so the session page can group runs under the person's words.
//!
//! When Claude Code launches a background agent or workflow, the tool result
//! line it writes carries the prompt's `promptId` and a `toolUseResult` with
//! the launched ids: `agentId` for an agent, `runId` and `taskId` for a
//! workflow. The first user line with that promptId holds the person's text.
//! A turn started by a background task finishing has a promptId of its own
//! and no text of the person's, so its launches go under the person's last
//! prompt before it. (Seen with Claude Code 2.1.319; undocumented. A change
//! loses grouping only.)

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::model::{Group, GROUP_LABEL_MAX};

/// A prompt the person typed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Prompt {
    pub id: String,
    /// Its first line, trimmed.
    pub text: String,
    /// Milliseconds since the epoch.
    pub at: Option<u64>,
}

impl Prompt {
    pub fn group(&self) -> Group {
        Group { id: self.id.clone(), label: self.text.clone(), kind: Some("prompt".into()), at: self.at }
    }
}

/// Each launched id (agent, workflow run, background task) and the prompt it
/// ran under.
pub type Launches = HashMap<String, Prompt>;

fn first_line(s: &str) -> String {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() <= GROUP_LABEL_MAX {
        line.to_string()
    } else {
        line.chars().take(GROUP_LABEL_MAX - 1).collect::<String>() + "…"
    }
}

/// The tags Claude Code opens the user lines it writes itself with: a
/// background task's finish, a slash command and its output, a reminder.
const OWN_TAGS: [&str; 5] = ["<task-notification", "<command-", "<local-command-", "<system-reminder", "<bash-stdout"];

/// Whether a text block is one Claude Code wrote around the person's words
/// (an opened file or a selection in the IDE, a hook's note): a single tag
/// from start to end, like `<ide_opened_file>...</ide_opened_file>`.
fn wrapped(t: &str) -> bool {
    let Some(rest) = t.strip_prefix('<') else { return false };
    let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    !name.is_empty() && t.trim_end().ends_with(&format!("</{name}>"))
}

/// The person's text on a user line: a plain string, or the first text block
/// of a list with no tool result in it that Claude Code did not write. A line
/// Claude Code wrote itself starts with one of OWN_TAGS; a prompt the person
/// began with `<` still counts. So does a `!` command, shown as `! <command>`.
/// A line Claude Code marks as its own (`isMeta`, or `promptSource` "system",
/// as on a background agent's hand-back) is not the person's.
fn typed(v: &Value) -> Option<String> {
    if v.get("isMeta").and_then(Value::as_bool) == Some(true)
        || v.get("promptSource").and_then(Value::as_str) == Some("system")
    {
        return None;
    }
    let c = v.get("message")?.get("content")?;
    let text = match c {
        Value::String(s) => s.clone(),
        Value::Array(bs) => {
            if bs.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            bs.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .find(|t| !wrapped(t.trim()))?.to_string()
        }
        _ => return None,
    };
    let t = text.trim();
    if let Some(cmd) = t.strip_prefix("<bash-input>").and_then(|r| r.split("</bash-input>").next()) {
        return Some(first_line(&format!("! {}", cmd.trim())));
    }
    (!t.is_empty() && !OWN_TAGS.iter().any(|tag| t.starts_with(tag))).then(|| first_line(t))
}

/// A transcript read so far. Claude Code only appends to a transcript, so a
/// reader picks up where it stopped: a live session's transcript changes on
/// every turn, and reading it from the top each time grows with the session.
#[derive(Clone, Debug, Default)]
pub struct Reader {
    /// The bytes read: up to the end of the last whole line.
    offset: u64,
    prompts: HashMap<String, Prompt>,
    /// A promptId with no text of the person's: the prompt it falls under.
    alias: HashMap<String, String>,
    last: Option<String>,
    launched: Vec<(String, String)>,
}

impl Reader {
    fn line(&mut self, line: &str) {
        if !line.contains("\"promptId\"") {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { return };
        if v.get("type").and_then(Value::as_str) != Some("user") {
            return;
        }
        let Some(pid) = v.get("promptId").and_then(Value::as_str).map(str::to_string) else { return };
        if !self.prompts.contains_key(&pid) && !self.alias.contains_key(&pid) {
            match typed(&v) {
                Some(text) => {
                    let at = v.get("timestamp").and_then(Value::as_str).and_then(crate::py::iso_timestamp).map(|t| (t * 1000.0) as u64);
                    self.prompts.insert(pid.clone(), Prompt { id: pid.clone(), text, at });
                    self.last = Some(pid.clone());
                }
                None => {
                    if let Some(l) = &self.last {
                        self.alias.insert(pid.clone(), l.clone());
                    }
                }
            }
        }
        if let Some(r) = v.get("toolUseResult").filter(|r| r.is_object()) {
            for k in ["agentId", "runId", "taskId"] {
                if let Some(id) = r.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    self.launched.push((id.to_string(), pid.clone()));
                }
            }
        }
    }

    /// Read what was added since the last call. A file shorter than what was
    /// read was rewritten: start again.
    pub fn feed(&mut self, path: &Path) {
        use std::io::{Seek, SeekFrom};
        let Ok(mut file) = std::fs::File::open(path) else { return };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            *self = Reader::default();
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut r = BufReader::new(file);
        // Bytes, not a String: a line that is not UTF-8 is passed over
        // rather than stopping every later read.
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                // A line still being written: read it whole next time.
                Ok(_) if buf.last() != Some(&b'\n') => break,
                Ok(n) => {
                    self.offset += n as u64;
                    if let Ok(line) = std::str::from_utf8(&buf) {
                        self.line(line);
                    }
                }
            }
        }
    }

    pub fn launches(&self) -> Launches {
        let mut out = Launches::new();
        for (id, pid) in &self.launched {
            let owner = if self.prompts.contains_key(pid) { Some(pid) } else { self.alias.get(pid) };
            if let Some(p) = owner.and_then(|o| self.prompts.get(o)) {
                out.insert(id.clone(), p.clone());
            }
        }
        out
    }
}

/// Read a transcript once, from the top.
pub fn read(path: &Path) -> Launches {
    let mut r = Reader::default();
    r.feed(path);
    r.launches()
}

type Cached = (u128, u64, Reader, Arc<Launches>);
static CACHE: Mutex<Option<HashMap<PathBuf, Cached>>> = Mutex::new(None);

/// The launches in a transcript: the cached answer while it is unchanged,
/// and only its new lines read when it grew.
pub fn of(path: &Path) -> Arc<Launches> {
    let md = std::fs::metadata(path).ok();
    let mtime = md.as_ref().and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    let len = md.map(|m| m.len()).unwrap_or(0);
    let mut reader = match CACHE.lock().unwrap().as_ref().and_then(|c| c.get(path)) {
        Some((m, l, _, got)) if *m == mtime && *l == len => return got.clone(),
        Some((_, _, r, _)) => r.clone(),
        None => Reader::default(),
    };
    reader.feed(path);
    let got = Arc::new(reader.launches());
    let mut c = CACHE.lock().unwrap();
    let map = c.get_or_insert_with(HashMap::new);
    if map.len() > 64 {
        map.clear();
    }
    map.insert(path.to_path_buf(), (mtime, len, reader, got.clone()));
    got
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_launch_goes_under_its_prompt_and_a_notification_turn_under_the_last_one() {
        let d = std::env::temp_dir().join(format!("crew-launches-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let t = d.join("s.jsonl");
        let lines = [
            json!({"type": "user", "promptId": "p1", "timestamp": "2026-11-08T20:00:00.000Z", "message": {"role": "user", "content": "review the branch\nand more"}}),
            json!({"type": "user", "promptId": "p1", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1"}]}, "toolUseResult": {"status": "async_launched", "agentId": "a1"}}),
            json!({"type": "user", "promptId": "p2", "message": {"content": "<task-notification>\n<task-id>a1</task-id>"}}),
            json!({"type": "user", "promptId": "p2", "message": {"content": [{"type": "tool_result"}]}, "toolUseResult": {"status": "async_launched", "taskId": "w9", "runId": "wf_1"}}),
            json!({"type": "user", "promptId": "p3", "timestamp": "2026-11-08T20:05:00.000Z", "message": {"content": [{"type": "text", "text": "next"}]}}),
        ];
        std::fs::write(&t, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
        let l = read(&t);
        let of = |id: &str| l.get(id).map(|p| (p.id.as_str(), p.text.as_str()));
        assert_eq!(of("a1"), Some(("p1", "review the branch")));
        assert_eq!(of("wf_1"), Some(("p1", "review the branch")), "launched in a notification's turn");
        assert_eq!(of("w9"), Some(("p1", "review the branch")));
        assert_eq!(l.get("a1").and_then(|p| p.at), Some(1794168000000));
        assert_eq!(l.len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_hand_back_is_no_prompt_and_a_bang_command_reads_as_one() {
        let d = std::env::temp_dir().join(format!("crew-launches-peer-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let t = d.join("s.jsonl");
        let launch = |pid: &str, aid: &str| json!({"type": "user", "promptId": pid, "message": {"content": [{"type": "tool_result"}]}, "toolUseResult": {"status": "async_launched", "agentId": aid}});
        let lines = [
            json!({"type": "user", "promptId": "p1", "promptSource": "typed", "message": {"content": "plan the page"}}),
            launch("p1", "a1"),
            json!({"type": "user", "promptId": "p2", "isMeta": true, "promptSource": "system", "turnOrigin": "peer",
                   "message": {"content": "Another Claude session sent a message:\n<agent-message from=\"a1\">"}}),
            launch("p2", "a2"),
            json!({"type": "user", "promptId": "p3", "promptSource": "system", "message": {"content": "a system turn"}}),
            launch("p3", "a3"),
            json!({"type": "user", "promptId": "p4", "message": {"content": "<bash-input>deep-plan go demo next</bash-input>"}}),
            launch("p4", "a4"),
        ];
        std::fs::write(&t, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
        let l = read(&t);
        let text = |id: &str| l.get(id).map(|p| p.text.clone());
        assert_eq!(text("a2").as_deref(), Some("plan the page"), "a hand-back's turn falls under the last prompt");
        assert_eq!(text("a3").as_deref(), Some("plan the page"));
        assert_eq!(text("a4").as_deref(), Some("! deep-plan go demo next"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_reader_reads_only_what_was_added_and_waits_for_a_whole_line() {
        let d = std::env::temp_dir().join(format!("crew-launches-feed-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let t = d.join("s.jsonl");
        let prompt = json!({"type": "user", "promptId": "p1", "message": {"content": "<div> is misaligned, fix it"}}).to_string();
        let launch = json!({"type": "user", "promptId": "p1", "message": {"content": [{"type": "tool_result"}]}, "toolUseResult": {"agentId": "a1"}}).to_string();
        std::fs::write(&t, format!("{prompt}\n{}", &launch[..20])).unwrap();
        let mut r = Reader::default();
        r.feed(&t);
        assert!(r.launches().is_empty(), "half a line is not read");
        assert_eq!(r.offset as usize, prompt.len() + 1);
        std::fs::write(&t, format!("{prompt}\n{launch}\n")).unwrap();
        r.feed(&t);
        assert_eq!(r.launches().get("a1").map(|p| p.text.as_str()), Some("<div> is misaligned, fix it"), "a prompt may start with <");
        // A line that is not UTF-8 is passed over, and the next is read.
        let mut bytes = format!("{prompt}\n").into_bytes();
        bytes.extend_from_slice(b"\xff\xfe not text\n");
        bytes.extend_from_slice(format!("{launch}\n").as_bytes());
        std::fs::write(&t, &bytes).unwrap();
        let mut r2 = Reader::default();
        r2.feed(&t);
        assert!(r2.launches().contains_key("a1"), "past a bad line");
        // An IDE block ahead of the words is not the heading.
        let ide = json!({"type": "user", "promptId": "p9", "message": {"content": [
            {"type": "text", "text": "<ide_opened_file>The user opened /w/a.rs</ide_opened_file>"},
            {"type": "text", "text": "why does this fail"}]}});
        assert_eq!(typed(&ide).as_deref(), Some("why does this fail"));
        // A rewritten, shorter file is read again from the top.
        std::fs::write(&t, format!("{prompt}\n")).unwrap();
        r.feed(&t);
        assert!(r.launches().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
