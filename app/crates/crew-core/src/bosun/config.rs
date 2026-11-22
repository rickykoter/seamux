//! The Bosun's folder and its config, `bosun.json`.
//!
//! ```text
//! ~/.claude/crew/bosun/            (CREW_DURABLE_DIR/bosun)
//!   bosun.json       {root, resetHour, sandbox: {allowWrite, allowedDomains}, loops}
//!   state.json       {session, day}: the conversation the supervisor resumes
//!   settings.json    written at each launch, passed to claude --settings
//!   brief.md         written at each launch, --append-system-prompt-file
//! ```
//!
//! Every key is optional. `root` is where the Bosun works and the folder it
//! may not write in; it defaults to the code root (CREW_CODE_ROOT, else
//! ~/code). `loops` belongs to bosun-routines and is not read here.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::py::{env_or, home};

/// The hour (local, 0-23) after which a new day's first idle turn starts a
/// fresh conversation, when bosun.json does not say.
pub const RESET_HOUR: u32 = 4;

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub root: PathBuf,
    pub reset_hour: u32,
    /// More folders a sandboxed command may write in (a CLI's cache).
    pub allow_write: Vec<String>,
    /// Hosts a sandboxed command may reach without asking.
    pub allowed_domains: Vec<String>,
}

/// The Bosun's folder: CREW_DURABLE_DIR/bosun, else ~/.claude/crew/bosun.
pub fn dir() -> PathBuf {
    env_or("CREW_DURABLE_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".claude/crew")).join("bosun")
}

/// `~/x` as a path under home; anything else as it is.
pub fn expand(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None if p == "~" => home(),
        None => PathBuf::from(p),
    }
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

impl Config {
    /// The config in `v` (bosun.json's object), defaults filling what it
    /// leaves out. `code_root` is the default root.
    pub fn from_value(v: &Value, code_root: &Path) -> Config {
        let root = v.get("root").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(expand).unwrap_or_else(|| code_root.to_path_buf());
        let reset_hour = v.get("resetHour").and_then(Value::as_u64).filter(|h| *h < 24).map(|h| h as u32).unwrap_or(RESET_HOUR);
        let sandbox = v.get("sandbox");
        Config {
            root,
            reset_hour,
            allow_write: strings(sandbox.and_then(|s| s.get("allowWrite"))),
            allowed_domains: strings(sandbox.and_then(|s| s.get("allowedDomains"))),
        }
    }

    /// bosun.json in `dir`, or the defaults when it is missing or unreadable.
    pub fn load_from(dir: &Path) -> Config {
        let v = fs::read_to_string(dir.join("bosun.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!({}));
        Config::from_value(&v, &crate::worktree::Settings::from_env().code_root)
    }

    pub fn load() -> Config {
        Config::load_from(&dir())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_an_empty_config() {
        let c = Config::from_value(&json!({}), Path::new("/u/code"));
        assert_eq!(c.root, PathBuf::from("/u/code"));
        assert_eq!(c.reset_hour, RESET_HOUR);
        assert!(c.allow_write.is_empty() && c.allowed_domains.is_empty());
    }

    #[test]
    fn keys_are_read_and_bad_ones_ignored() {
        let v = json!({"root": "/w/src", "resetHour": 6, "sandbox": {"allowWrite": ["/x", ""], "allowedDomains": ["github.com", 3]}});
        let c = Config::from_value(&v, Path::new("/u/code"));
        assert_eq!(c.root, PathBuf::from("/w/src"));
        assert_eq!(c.reset_hour, 6);
        assert_eq!(c.allow_write, vec!["/x"]);
        assert_eq!(c.allowed_domains, vec!["github.com"]);
        let bad = Config::from_value(&json!({"resetHour": 30, "root": ""}), Path::new("/u/code"));
        assert_eq!((bad.reset_hour, bad.root), (RESET_HOUR, PathBuf::from("/u/code")));
    }
}
