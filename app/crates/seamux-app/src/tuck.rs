//! Muted and tucked worktrees: what the views quiet or put away.
//!
//! ```text
//! ~/.claude/crew/tucked.json   (CREW_DURABLE_DIR overrides ~/.claude/crew)
//! {"version": 1, "entries": [{"path": "~/code/x", "level": "mute", "at": 1792627200000, "name": "x"}]}
//! ```
//!
//! One entry per worktree root: every workspace whose pane works in that
//! worktree is muted or tucked with it, across cmux restarts. Mute dims a
//! workspace until it asks (an ask newer than the mute clears it); tuck hides
//! it from Desk, Mosaic and Timeline until it is restored. Nothing here
//! touches cmux: the workspace and its agent keep running.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

/// How a worktree is quieted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Mute,
    Tuck,
}

impl Level {
    pub fn parse(s: &str) -> Option<Level> {
        match s {
            "mute" => Some(Level::Mute),
            "tuck" => Some(Level::Tuck),
            _ => None,
        }
    }
}

/// One quieted worktree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    /// The worktree root (`root_of`).
    pub path: String,
    pub level: Level,
    /// When it was muted or tucked (ms since the epoch).
    pub at: u64,
    /// The workspace's title when it was quieted, for the palette.
    #[serde(default)]
    pub name: String,
}

/// One change to the store at a time in this process (the app is its only
/// writer): a read-modify-write must not lose another's entry.
static WRITE: Mutex<()> = Mutex::new(());
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The store file.
pub struct Store {
    pub file: PathBuf,
}

impl Store {
    /// crew's durable dir (~/.claude/crew, or CREW_DURABLE_DIR)/tucked.json.
    pub fn live() -> Store {
        Store { file: PathBuf::from(crew_store::Paths::from_env().crew_home).join("tucked.json") }
    }

    /// Every entry; a missing or unreadable file is no entries, and one
    /// malformed entry is skipped rather than costing the rest.
    pub fn load(&self) -> Vec<Entry> {
        let Ok(text) = std::fs::read_to_string(&self.file) else { return Vec::new() };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return Vec::new() };
        v.get("entries")
            .and_then(|e| e.as_array())
            .map(|a| a.iter().filter_map(|e| serde_json::from_value::<Entry>(e.clone()).ok()).collect())
            .unwrap_or_default()
    }

    /// Write every entry, whole: a reader never sees half a file.
    pub fn save(&self, entries: &[Entry]) -> Result<(), String> {
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

    /// Mute or tuck `root` (replacing its entry), or with `None` restore it.
    pub fn set(&self, root: &str, level: Option<Level>, name: &str, at: u64) -> Result<(), String> {
        if root.is_empty() {
            return Err("no worktree to quiet".into());
        }
        let _held = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        let mut entries: Vec<Entry> = self.load().into_iter().filter(|e| e.path != root).collect();
        if let Some(level) = level {
            entries.push(Entry { path: root.to_string(), level, at, name: name.to_string() });
        }
        self.save(&entries)
    }

    /// Unmute every muted worktree; tucked ones stay. Returns how many.
    pub fn unmute_all(&self) -> Result<usize, String> {
        let _held = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        let entries = self.load();
        let before = entries.len();
        let kept: Vec<Entry> = entries.into_iter().filter(|e| e.level != Level::Mute).collect();
        let n = before - kept.len();
        self.save(&kept)?;
        Ok(n)
    }

    /// Drop the entries `gone` names, under the write lock, keeping any
    /// entry written meanwhile. Returns whether anything changed.
    pub fn remove(&self, gone: &[Entry]) -> Result<bool, String> {
        let _held = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        let entries = self.load();
        let kept: Vec<Entry> = entries.iter().filter(|e| !gone.contains(e)).cloned().collect();
        if kept.len() == entries.len() {
            return Ok(false);
        }
        self.save(&kept).map(|_| true)
    }
}

static ROOTS: Mutex<Option<HashMap<String, (String, Instant)>>> = Mutex::new(None);
/// How long a cwd's root is trusted: a worktree rarely moves.
const ROOT_TTL: Duration = Duration::from_secs(300);

/// The worktree a pane works in: `git rev-parse --show-toplevel` of its cwd,
/// else the cwd itself, symlinks resolved as crew-store keys workspaces.
/// Cached per cwd, so a build costs one git call per new directory.
pub fn root_of(cwd: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    {
        let roots = ROOTS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((r, at)) = roots.as_ref().and_then(|m| m.get(cwd)) {
            if at.elapsed() < ROOT_TTL {
                return r.clone();
            }
        }
    } // git runs without the lock held
    let run = crew_core::py::run("git", &["-C", cwd, "rev-parse", "--show-toplevel"], Duration::from_secs(3));
    let top = run
        .as_ref()
        .filter(|(code, _, _)| *code == 0)
        .map(|(_, out, _)| out.trim().to_string())
        .filter(|t| !t.is_empty() && Path::new(t).is_dir());
    let root = crew_store::wskey(top.as_deref().unwrap_or(cwd));
    // Cache an answer git gave (a root, or "not a repository"); a git that
    // did not run or timed out is asked again next time.
    if run.is_some() {
        let mut roots = ROOTS.lock().unwrap_or_else(|p| p.into_inner());
        roots.get_or_insert_with(HashMap::new).insert(cwd.to_string(), (root.clone(), Instant::now()));
    }
    root
}

static BRANCHES: Mutex<Option<HashMap<String, (String, Instant)>>> = Mutex::new(None);
const BRANCH_TTL: Duration = Duration::from_secs(60);

/// The branch checked out at `root`, or "" (cached for a minute).
pub fn branch_of(root: &str) -> String {
    {
        let b = BRANCHES.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((br, at)) = b.as_ref().and_then(|m| m.get(root)) {
            if at.elapsed() < BRANCH_TTL {
                return br.clone();
            }
        }
    } // git runs without the lock held
    let br = crew_core::py::run("git", &["-C", root, "branch", "--show-current"], Duration::from_secs(3))
        .filter(|(code, _, _)| *code == 0)
        .map(|(_, out, _)| out.trim().to_string())
        .unwrap_or_default();
    let mut b = BRANCHES.lock().unwrap_or_else(|p| p.into_inner());
    b.get_or_insert_with(HashMap::new).insert(root.to_string(), (br.clone(), Instant::now()));
    br
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> Store {
        let d = std::env::temp_dir().join(format!("seamux-tuck-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        Store { file: d.join("tucked.json") }
    }

    #[test]
    fn tuck_one_bad_entry_does_not_cost_the_rest() {
        let s = store("bad");
        std::fs::create_dir_all(s.file.parent().unwrap()).unwrap();
        std::fs::write(&s.file, r#"{"version": 1, "entries": [{"path": "/w/a", "level": "mute", "at": 1}, {"path": "/w/b", "level": "loud"}]}"#).unwrap();
        assert_eq!(s.load().len(), 1);
        s.set("/w/c", Some(Level::Tuck), "c", 2).unwrap();
        assert_eq!(s.load().iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["/w/a", "/w/c"]);
        let a = s.load()[0].clone();
        assert!(s.remove(&[a]).unwrap());
        assert_eq!(s.load().len(), 1);
        let _ = std::fs::remove_dir_all(s.file.parent().unwrap());
    }

    #[test]
    fn tuck_store_round_trip_and_a_broken_file() {
        let s = store("rt");
        assert!(s.load().is_empty(), "missing file: no entries");
        s.set("/w/a", Some(Level::Mute), "a", 5).unwrap();
        s.set("/w/b", Some(Level::Tuck), "b", 6).unwrap();
        s.set("/w/a", Some(Level::Tuck), "a", 7).unwrap(); // replaces, not adds
        let e = s.load();
        assert_eq!(e.len(), 2);
        assert_eq!(e.iter().find(|x| x.path == "/w/a").unwrap().level, Level::Tuck);
        s.set("/w/b", None, "", 0).unwrap();
        assert_eq!(s.load().len(), 1);
        s.set("/w/c", Some(Level::Mute), "c", 8).unwrap();
        assert_eq!(s.unmute_all().unwrap(), 1);
        assert_eq!(s.load().iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), vec!["/w/a"]);
        std::fs::write(&s.file, "{not json").unwrap();
        assert!(s.load().is_empty(), "a broken file is read as empty");
        assert!(s.set("", Some(Level::Mute), "", 0).is_err());
        let _ = std::fs::remove_dir_all(s.file.parent().unwrap());
    }

    #[test]
    fn tuck_roots_are_the_git_toplevel_with_symlinks_resolved() {
        let d = std::env::temp_dir().join(format!("seamux-tuck-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("repo/sub/deep")).unwrap();
        std::fs::create_dir_all(d.join("plain")).unwrap();
        let ok = std::process::Command::new("git").args(["init", "-q"]).current_dir(d.join("repo")).status().map(|s| s.success()).unwrap_or(false);
        let repo = crew_store::wskey(&d.join("repo").to_string_lossy());
        if ok {
            assert_eq!(root_of(&d.join("repo/sub/deep").to_string_lossy()), repo);
            assert_eq!(root_of(&format!("{}/", d.join("repo").to_string_lossy())), repo);
        }
        // Not in git: the directory itself (under /var → /private/var on macOS).
        assert_eq!(root_of(&d.join("plain").to_string_lossy()), crew_store::wskey(&d.join("plain").to_string_lossy()));
        assert_eq!(root_of(""), "");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tuck_levels_parse() {
        assert_eq!(Level::parse("mute"), Some(Level::Mute));
        assert_eq!(Level::parse("tuck"), Some(Level::Tuck));
        assert_eq!(Level::parse("none"), None);
        assert_eq!(serde_json::to_string(&Level::Tuck).unwrap(), "\"tuck\"");
    }
}
