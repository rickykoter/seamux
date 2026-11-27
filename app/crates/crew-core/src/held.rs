//! A command bash-guard held for the person (ADRs 0094-0097): bash-guard
//! writes held-<pane>.json into crew's state folder when it refuses a command
//! in a pane of the app's tmux, and the pane's banner and the Dock card offer
//! it to run, copy or dismiss. This module reads a record, says whether it is
//! still live, clears it, and writes a session's force-push allow.
//!
//! The allow lives at allow/<session>.json and lists branches under
//! forcePush; guard_bash.sh lets a leased push to a listed branch through for
//! that session. It lists PRs under merge too (ship-and-land): a held `gh pr
//! merge` names its PR with its repository (owner/repo#n or owner/repo:branch),
//! and a merge of a listed PR then passes. Each write keeps the other list.
//! Only the app writes it, on the person's click.

use crate::status::Pane;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// The reasons a session allow can follow: bash-guard's force-push block,
/// and its hold on a PR merge.
pub const FORCE_PUSH: &str = "git push --force";
pub const MERGE: &str = "gh pr merge";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Held {
    pub pane: String,
    pub workspace: String,
    pub session: String,
    pub cwd: String,
    pub reason: String,
    /// "run" (a git block) or "copy" (any other); bash-guard writes no record
    /// for a block with nothing to offer.
    pub kind: String,
    pub command: String,
    /// The command was longer than the record keeps: it can only be copied.
    pub truncated: bool,
    /// A leased force push's destination, when bash-guard could name it.
    pub branch: Option<String>,
    /// A held merge's PR with its repository, when bash-guard could name it.
    pub pr: Option<String>,
    /// Seconds since the epoch, bash-guard's clock.
    pub at: u64,
}

impl Held {
    pub fn from_json(v: &Value) -> Option<Held> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let h = Held {
            pane: s("pane"),
            workspace: s("workspace"),
            session: s("session"),
            cwd: s("cwd"),
            reason: s("reason"),
            kind: s("kind"),
            command: s("command"),
            truncated: v.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            branch: v.get("branch").and_then(Value::as_str).filter(|b| branch_ok(b)).map(str::to_string),
            pr: v.get("pr").and_then(Value::as_str).filter(|p| pr_ok(p)).map(str::to_string),
            at: v.get("at").and_then(Value::as_u64).unwrap_or(0),
        };
        (!h.command.is_empty() && matches!(h.kind.as_str(), "run" | "copy")).then_some(h)
    }

    /// May be run at all: a git block, kept whole, on one line with no
    /// control characters. Both ways to run it type the text as keys (into
    /// Claude's prompt, or into the ⌘J shell, which refuses a second line),
    /// so a newline would send it early and any other control byte would be
    /// a key the banner never showed. Such a command can only be copied.
    pub fn runnable(&self) -> bool {
        self.kind == "run" && !self.truncated && !self.command.chars().any(|c| c.is_control())
    }

    /// May be typed into Claude's prompt as `!cmd`. The same as runnable
    /// now; kept as its own field for the banner and the card.
    pub fn chat(&self) -> bool {
        self.runnable()
    }

    /// The branch a "Run and allow" click would allow: a force push alone,
    /// with its branch named and a session to key the allow by.
    pub fn allowable(&self) -> Option<&str> {
        (self.runnable() && self.reason == FORCE_PUSH && session_ok(&self.session)).then_some(())?;
        self.branch.as_deref()
    }

    /// The PR a "Run and allow PR" click would allow: a merge alone, with its
    /// PR named and a session to key the allow by.
    pub fn merge_allowable(&self) -> Option<&str> {
        (self.runnable() && self.reason == MERGE && session_ok(&self.session)).then_some(())?;
        self.pr.as_deref()
    }

    /// What the banner and the Dock are told: `allow` names what a click
    /// would allow (a branch, or a PR), and `allowKind` which list it joins.
    pub fn to_json(&self) -> Value {
        let (allow, kind) = match (self.allowable(), self.merge_allowable()) {
            (Some(b), _) => (Some(b), Some("push")),
            (None, Some(p)) => (Some(p), Some("merge")),
            _ => (None, None),
        };
        json!({"pane": self.pane, "workspace": self.workspace, "session": self.session, "cwd": self.cwd,
               "reason": self.reason, "kind": self.kind, "command": self.command, "truncated": self.truncated,
               "branch": self.branch, "pr": self.pr, "at": self.at, "run": self.runnable(), "chat": self.chat(),
               "allow": allow, "allowKind": kind, "lines": self.command.lines().count().max(1)})
    }
}

/// A git branch name as bash-guard's branch_re takes it, and no `..`.
pub fn branch_ok(b: &str) -> bool {
    let mut c = b.chars();
    c.next().is_some_and(|f| f.is_ascii_alphanumeric() || f == '_')
        && b.chars().all(|ch| ch.is_ascii_alphanumeric() || "._/-".contains(ch))
        && !b.contains("..")
        && b.len() <= 255
}

/// A PR as bash-guard names it: owner/repo#n, or owner/repo:branch.
pub fn pr_ok(p: &str) -> bool {
    let name = |s: &str| s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
    let repo = |s: &str| s.split_once('/').is_some_and(|(o, r)| name(o) && name(r));
    p.len() <= 300
        && match (p.split_once('#'), p.split_once(':')) {
            (Some((r, n)), None) => repo(r) && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()),
            (None, Some((r, b))) => repo(r) && branch_ok(b),
            _ => false,
        }
}

/// A session id as bash-guard keeps it.
pub fn session_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A pane key as bash-guard writes it into the file name.
fn key_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn path(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("held-{key}.json"))
}

/// Delete pane `key`'s held record, whatever it holds: its pane closed.
pub fn remove(dir: &Path, key: &str) {
    if key_ok(key) {
        let _ = fs::remove_file(path(dir, key));
    }
}

/// The pane's held record, if it has one that reads. Bytes are read lossily:
/// bash-guard's plain-shell fallback can cut a character in two.
pub fn read(dir: &Path, key: &str) -> Option<Held> {
    if !key_ok(key) {
        return None;
    }
    let bytes = fs::read(path(dir, key)).ok()?;
    Held::from_json(&serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?)
}

/// Whether a record still waits on the person: its pane is there, not ended,
/// and still runs the session that was refused (a new session is new work).
pub fn live(h: &Held, pane: Option<&Pane>) -> bool {
    pane.is_some_and(|p| p.state != "ended" && (h.session.is_empty() || p.session.is_empty() || p.session == h.session))
}

/// The pane's live record. One whose pane has moved on (ended, or another
/// session) is deleted, so it is never offered again. With no pane file yet
/// nothing is offered and nothing is deleted: the hooks may not have written
/// it when the block lands.
pub fn for_pane(dir: &Path, key: &str, pane: Option<&Pane>) -> Option<Held> {
    let h = read(dir, key)?;
    if live(&h, pane) {
        return Some(h);
    }
    if pane.is_some() {
        let _ = fs::remove_file(path(dir, key));
    }
    None
}

/// Delete the pane's record, but only the one the person saw (by its time):
/// a newer block that landed since stays on offer. The record is moved aside
/// before it is read, so a block bash-guard writes in between lands in the
/// empty place and is kept; one taken by mistake goes back unless a newer
/// one is there.
pub fn clear(dir: &Path, key: &str, at: u64) -> bool {
    if !key_ok(key) {
        return false;
    }
    let p = path(dir, key);
    let taken = dir.join(format!(".held-{key}.taking-{}", std::process::id()));
    if fs::rename(&p, &taken).is_err() {
        return false;
    }
    let seen = fs::read(&taken)
        .ok()
        .and_then(|b| serde_json::from_str::<Value>(&String::from_utf8_lossy(&b)).ok())
        .and_then(|v| v.get("at").and_then(Value::as_u64));
    if seen == Some(at) {
        return fs::remove_file(&taken).is_ok();
    }
    // Not the one seen: put it back, unless bash-guard wrote a newer one.
    if p.exists() {
        let _ = fs::remove_file(&taken);
    } else if fs::rename(&taken, &p).is_err() {
        let _ = fs::remove_file(&taken);
    }
    false
}

pub fn allow_path(dir: &Path, session: &str) -> PathBuf {
    dir.join("allow").join(format!("{session}.json"))
}

/// One list of a session's allow: `forcePush` (branches) or `merge` (PRs),
/// each item checked by `ok`.
fn listed(dir: &Path, session: &str, key: &str, ok: fn(&str) -> bool) -> Vec<String> {
    if !session_ok(session) {
        return Vec::new();
    }
    fs::read_to_string(allow_path(dir, session))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get(key).and_then(Value::as_array).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|b| b.as_str().filter(|b| ok(b)).map(str::to_string))
        .collect()
}

/// The branches a session's allow lists.
pub fn allowed(dir: &Path, session: &str) -> Vec<String> {
    listed(dir, session, "forcePush", branch_ok)
}

/// The PRs a session's allow lists for a merge.
pub fn allowed_merges(dir: &Path, session: &str) -> Vec<String> {
    listed(dir, session, "merge", pr_ok)
}

/// Add `branch` to the session's force-push allow, written whole.
pub fn allow(dir: &Path, session: &str, branch: &str, now_ms: u64) -> Result<(), String> {
    if !branch_ok(branch) {
        return Err(format!("not a branch name: {branch}"));
    }
    add(dir, session, "forcePush", branch, now_ms)
}

/// Add `pr` (owner/repo#n or owner/repo:branch) to the session's merge allow.
pub fn allow_merge(dir: &Path, session: &str, pr: &str, now_ms: u64) -> Result<(), String> {
    if !pr_ok(pr) {
        return Err(format!("not a PR as bash-guard names one: {pr}"));
    }
    add(dir, session, "merge", pr, now_ms)
}

/// Add `item` to one list of the session's allow, keeping the other: the
/// file is written whole, with both lists.
fn add(dir: &Path, session: &str, key: &str, item: &str, now_ms: u64) -> Result<(), String> {
    if !session_ok(session) {
        return Err("no session to allow it for".into());
    }
    let mut push = allowed(dir, session);
    let mut merge = allowed_merges(dir, session);
    let list = if key == "merge" { &mut merge } else { &mut push };
    if !list.iter().any(|b| b == item) {
        list.push(item.to_string());
    }
    let p = allow_path(dir, session);
    let parent = p.parent().ok_or("no allow folder")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = p.with_extension(format!("tmp-{}", std::process::id()));
    let text = format!("{}\n", json!({"session": session, "forcePush": push, "merge": merge, "at": now_ms}));
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own per test: they run side by side.
    fn tmp() -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("held-test-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn rec(kind: &str, reason: &str, command: &str, branch: Option<&str>) -> Value {
        json!({"pane": "P1", "workspace": "W1", "session": "s1", "cwd": "/w", "reason": reason, "kind": kind,
               "command": command, "truncated": false, "branch": branch, "at": 100})
    }

    fn pane(session: &str, state: &str) -> Pane {
        let mut p = Pane::new("W1", "P1");
        p.session = session.into();
        p.state = state.into();
        p
    }

    #[test]
    fn a_record_says_what_it_offers() {
        let h = Held::from_json(&rec("run", FORCE_PUSH, "git push --force-with-lease origin dev/x", Some("dev/x"))).unwrap();
        assert!(h.runnable() && h.chat());
        assert_eq!(h.allowable(), Some("dev/x"));
        let v = h.to_json();
        assert_eq!((v["run"].as_bool(), v["chat"].as_bool(), v["allow"].as_str()), (Some(true), Some(true), Some("dev/x")));

        // Two lines, or any control byte: copy only. Both ways to run it
        // type keys, and the ⌘J shell refuses a second line.
        let h = Held::from_json(&rec("run", "git reset --hard", "git reset --hard\ngit clean -f", None)).unwrap();
        assert!(!h.runnable() && !h.chat());
        assert_eq!(h.allowable(), None);
        for c in ["git reset --hard\r", "git reset --hard\x1b[A", "git reset\t--hard", "git reset --hard\x7f"] {
            assert!(!Held::from_json(&rec("run", "git reset --hard", c, None)).unwrap().runnable(), "{c:?}");
        }
        // Copy only.
        let h = Held::from_json(&rec("copy", "curl | sh", "curl x | sh", None)).unwrap();
        assert!(!h.runnable() && !h.chat());
        // A cut command is never run, and offers no allow.
        let mut v = rec("run", FORCE_PUSH, "git push --force-with-lease origin dev/x", Some("dev/x"));
        v["truncated"] = json!(true);
        let h = Held::from_json(&v).unwrap();
        assert!(!h.runnable() && h.allowable().is_none());
        // Another reason beside the push: no allow.
        let h = Held::from_json(&rec("run", "git push --force; git reset --hard", "x", Some("dev/x"))).unwrap();
        assert_eq!(h.allowable(), None);
        // A bad branch is dropped; an unknown kind or no command is no record.
        assert_eq!(Held::from_json(&rec("run", FORCE_PUSH, "x", Some("../main"))).unwrap().branch, None);
        assert!(Held::from_json(&rec("none", "x", "x", None)).is_none());
        assert!(Held::from_json(&rec("run", "x", "", None)).is_none());
    }

    #[test]
    fn a_record_lives_until_its_session_moves_on() {
        let dir = tmp();
        fs::write(path(&dir, "P1"), rec("run", "git reset --hard", "git reset --hard", None).to_string()).unwrap();
        assert!(for_pane(&dir, "P1", Some(&pane("s1", "idle"))).is_some());
        assert!(for_pane(&dir, "P1", Some(&pane("", "working"))).is_some(), "a pane with no session yet keeps it");
        assert!(for_pane(&dir, "P1", Some(&pane("s2", "idle"))).is_none(), "a new session drops it");
        assert!(!path(&dir, "P1").exists(), "and deletes it");
        fs::write(path(&dir, "P1"), rec("run", "x", "x", None).to_string()).unwrap();
        assert!(for_pane(&dir, "P1", Some(&pane("s1", "ended"))).is_none());
        fs::write(path(&dir, "P1"), rec("run", "x", "x", None).to_string()).unwrap();
        assert!(for_pane(&dir, "P1", None).is_none(), "no pane file, nothing offered");
        assert!(path(&dir, "P1").exists(), "and nothing deleted: the pane file may come later");
        assert!(read(&dir, "../x").is_none(), "a key is a plain name");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_takes_only_the_record_the_person_saw() {
        let dir = tmp();
        fs::write(path(&dir, "P1"), rec("run", "x", "x", None).to_string()).unwrap();
        assert!(!clear(&dir, "P1", 99), "a newer block stays");
        assert!(read(&dir, "P1").is_some_and(|h| h.at == 100), "put back whole");
        assert!(clear(&dir, "P1", 100));
        assert!(!path(&dir, "P1").exists());
        assert!(!clear(&dir, "P1", 100), "nothing to clear");
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains("taking")), "no file left aside");
        // Lossy read: a cut character does not lose the record.
        let mut bytes = br#"{"pane":"P1","kind":"copy","command":"echo "#.to_vec();
        bytes.extend_from_slice(&[0xE2, 0x82]);
        bytes.extend_from_slice(br#"","at":1}"#);
        fs::write(path(&dir, "P1"), bytes).unwrap();
        assert!(read(&dir, "P1").is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_allow_adds_one_branch_for_one_session() {
        let dir = tmp();
        allow(&dir, "s1", "dev/x", 1).unwrap();
        allow(&dir, "s1", "dev/x", 2).unwrap();
        allow(&dir, "s1", "feat/y", 3).unwrap();
        assert_eq!(allowed(&dir, "s1"), vec!["dev/x".to_string(), "feat/y".to_string()]);
        assert!(allowed(&dir, "s2").is_empty());
        let text = fs::read_to_string(allow_path(&dir, "s1")).unwrap();
        // The shape guard_bash.sh reads: a forcePush array of quoted names.
        assert!(text.contains(r#""forcePush":["dev/x","feat/y"]"#), "{text}");
        assert!(allow(&dir, "../s", "dev/x", 1).is_err());
        assert!(allow(&dir, "s1", "a..b", 1).is_err());
        assert!(allow(&dir, "", "dev/x", 1).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_merge_allow_keeps_the_push_allow_and_the_reverse() {
        let dir = tmp();
        allow(&dir, "s1", "dev/x", 1).unwrap();
        allow_merge(&dir, "s1", "o/r#12", 2).unwrap();
        allow_merge(&dir, "s1", "o/r#12", 3).unwrap();
        allow_merge(&dir, "s1", "o/r:feat/y", 4).unwrap();
        allow(&dir, "s1", "feat/z", 5).unwrap();
        assert_eq!(allowed(&dir, "s1"), vec!["dev/x".to_string(), "feat/z".to_string()]);
        assert_eq!(allowed_merges(&dir, "s1"), vec!["o/r#12".to_string(), "o/r:feat/y".to_string()]);
        let text = fs::read_to_string(allow_path(&dir, "s1")).unwrap();
        // The shape guard_bash.sh reads: quoted names in each array.
        assert!(text.contains(r#""merge":["o/r#12","o/r:feat/y"]"#) && text.contains(r#""forcePush":["dev/x","feat/z"]"#), "{text}");
        for bad in ["12", "o/r", "o/r#", "o/r#1x", "o/r:a..b", "../r#1", "o/r#1:b"] {
            assert!(allow_merge(&dir, "s1", bad, 6).is_err(), "{bad}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_held_merge_offers_its_pr() {
        let mut v = rec("run", MERGE, "gh pr merge 12 --squash", None);
        v["pr"] = json!("o/r#12");
        let h = Held::from_json(&v).unwrap();
        assert_eq!((h.allowable(), h.merge_allowable()), (None, Some("o/r#12")));
        let j = h.to_json();
        assert_eq!((j["allow"].as_str(), j["allowKind"].as_str(), j["pr"].as_str()), (Some("o/r#12"), Some("merge"), Some("o/r#12")));
        // Beside another reason, or with a PR bash-guard would not name: no allow.
        let mut v2 = rec("run", "gh pr merge; git reset --hard", "x", None);
        v2["pr"] = json!("o/r#12");
        assert_eq!(Held::from_json(&v2).unwrap().merge_allowable(), None);
        let mut v3 = rec("run", MERGE, "gh pr merge 12", None);
        v3["pr"] = json!("12");
        assert_eq!(Held::from_json(&v3).unwrap().pr, None);
        // An approval is copy only: nothing to allow.
        let h = Held::from_json(&rec("copy", "gh pr review --approve", "gh pr review 12 --approve", None)).unwrap();
        assert!(h.to_json()["allow"].is_null());
    }
}
