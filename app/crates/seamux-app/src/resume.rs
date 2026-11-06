//! Worktrees armed to resume when a usage limit resets (ADR 0070).
//!
//! ```text
//! ~/.claude/crew/resume.json   (CREW_DURABLE_DIR overrides ~/.claude/crew)
//! {"version": 1, "entries": [{"path": "~/code/x", "at": 1792627200000, "name": "x"}]}
//! ```
//!
//! tucked.json's shape, one entry per worktree root, and the app is its only
//! writer. An armed worktree stays armed until you disarm it: every limit
//! stop in it is resumed, by the resume watcher, once its limit resets.
//! crew-board reads the file to draw the "resumes 3:04pm" chip and to leave
//! an armed stopped row in its tier.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;

/// One armed worktree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// The worktree root (seamux_app::tuck::root_of).
    pub path: String,
    /// When it was armed (ms since the epoch).
    pub at: u64,
    /// The workspace's title when it was armed.
    #[serde(default)]
    pub name: String,
}

/// One change to the store at a time in this process.
static WRITE: Mutex<()> = Mutex::new(());
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub struct Store {
    pub file: PathBuf,
}

impl Store {
    /// crew's durable dir (~/.claude/crew, or CREW_DURABLE_DIR)/resume.json.
    pub fn live() -> Store {
        Store { file: PathBuf::from(crew_store::Paths::from_env().crew_home).join("resume.json") }
    }

    /// Every entry; a missing or unreadable file is none, and a malformed
    /// entry is skipped.
    pub fn load(&self) -> Vec<Entry> {
        let Ok(text) = std::fs::read_to_string(&self.file) else { return Vec::new() };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
        v.get("entries")
            .and_then(|e| e.as_array())
            .map(|a| a.iter().filter_map(|e| serde_json::from_value::<Entry>(e.clone()).ok()).collect())
            .unwrap_or_default()
    }

    /// Whether the worktree at `root` is armed (the resume watcher asks).
    #[allow(dead_code)]
    pub fn armed(&self, root: &str) -> bool {
        !root.is_empty() && self.load().iter().any(|e| e.path == root)
    }

    /// Write every entry, whole: a reader never sees half a file.
    fn save(&self, entries: &[Entry]) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(&json!({"version": 1, "entries": entries})).map_err(|e| e.to_string())?;
        let n = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self.file.with_extension(format!("json.tmp-{}-{n}", std::process::id()));
        std::fs::write(&tmp, format!("{text}\n")).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.file).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
    }

    /// Arm `root` (`on`), keeping its first arming time, or disarm it.
    pub fn set(&self, root: &str, on: bool, name: &str, at: u64) -> Result<(), String> {
        if root.is_empty() {
            return Err("no worktree to arm".into());
        }
        let _held = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        let entries = self.load();
        let had = entries.iter().find(|e| e.path == root).cloned();
        let mut kept: Vec<Entry> = entries.into_iter().filter(|e| e.path != root).collect();
        if on {
            kept.push(had.unwrap_or(Entry { path: root.to_string(), at, name: name.to_string() }));
        }
        self.save(&kept)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> Store {
        let d = std::env::temp_dir().join(format!("seamux-resume-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        Store { file: d.join("resume.json") }
    }

    #[test]
    fn arming_stays_until_disarmed_and_keeps_its_first_time() {
        let s = store("arm");
        assert!(!s.armed("/w/a") && s.load().is_empty(), "no file: nothing armed");
        s.set("/w/a", true, "a", 1).unwrap();
        s.set("/w/b", true, "b", 2).unwrap();
        s.set("/w/a", true, "a again", 9).unwrap();
        assert!(s.armed("/w/a") && s.armed("/w/b") && !s.armed("/w/c") && !s.armed(""));
        assert_eq!(s.load().iter().find(|e| e.path == "/w/a").map(|e| (e.at, e.name.as_str())), Some((1, "a")));
        s.set("/w/a", false, "", 3).unwrap();
        assert!(!s.armed("/w/a") && s.armed("/w/b"));
        assert!(s.set("", true, "", 0).is_err());
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&s.file).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["entries"][0]["path"], "/w/b");
    }

    #[test]
    fn a_malformed_entry_costs_only_itself() {
        let s = store("bad");
        std::fs::create_dir_all(s.file.parent().unwrap()).unwrap();
        std::fs::write(&s.file, r#"{"version":1,"entries":[{"path":"/w/a","at":1},{"at":"x"}]}"#).unwrap();
        assert_eq!(s.load().len(), 1);
        std::fs::write(&s.file, "not json").unwrap();
        assert!(s.load().is_empty());
    }
}
