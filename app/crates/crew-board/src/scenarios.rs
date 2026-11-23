//! A deep-plan plan's sealed scenarios (deep-plan/lib/scenarios.mjs), as the
//! app sees them: whether a plan has them, where they stand, and the key
//! their page asks for.
//!
//! The key goes to the app's own webview only (seamux-app's scenarios_key
//! command, which the Sheet calls to open the page), never into an HTTP
//! reply: crew's intent server answers any caller on this machine, the
//! building Claude session included, and that session must never see the
//! scenarios. The gate refuses the session's reads of this folder; the app
//! is the person's.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::plans::slug_ok;
use crew_core::py;

/// deep-plan's sealed folder: DEEP_PLAN_SEALED_DIR, else
/// ~/.claude/deep-plan/sealed (lib/state.mjs SEALED_DIR).
pub fn sealed_dir() -> PathBuf {
    std::env::var_os("DEEP_PLAN_SEALED_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| py::home().join(".claude").join("deep-plan").join("sealed"))
}

/// Where a plan's scenarios stand, for the Dock's tab: how many, whether
/// they wait on the person (revisions proposed after an amend, or a mark to
/// confirm), whether an amend left them stale before the writer ran, and
/// whether the last judging failed. No scenario text.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Standing {
    pub count: usize,
    pub waiting: usize,
    pub confirm: bool,
    pub stale: bool,
    pub failing: bool,
}

fn json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// The plan's standing in `dir` (the sealed folder), or None when it has no
/// scenarios (or the slug is not one).
pub fn standing_in(dir: &Path, slug: &str) -> Option<Standing> {
    if !slug_ok(slug) {
        return None;
    }
    let d = dir.join(slug);
    let doc = json(&d.join("scenarios.json"))?;
    let count = doc.get("scenarios").and_then(|s| s.as_array()).map(|a| a.len()).unwrap_or(0);
    let mut s = Standing { count, ..Standing::default() };
    if let Some(rev) = json(&d.join("revisions.json")) {
        if rev.get("stale").map(|v| !v.is_null()).unwrap_or(false) {
            match rev.get("proposals").and_then(|p| p.as_array()) {
                Some(ps) if ps.is_empty() => s.confirm = true,
                Some(ps) => s.waiting = ps.len(),
                None => s.stale = true,
            }
        }
    }
    if let Some(v) = json(&d.join("verdicts.json")) {
        s.failing = v.get("last").and_then(|l| l.get("pass")).and_then(|p| p.as_bool()) == Some(false);
    }
    Some(s)
}

pub fn standing(slug: &str) -> Option<Standing> {
    standing_in(&sealed_dir(), slug)
}

impl Standing {
    /// It needs the person: proposals to answer, or a mark to confirm.
    pub fn needs_person(&self) -> bool {
        self.waiting > 0 || self.confirm
    }
    /// A few words for the tab.
    pub fn state(&self) -> String {
        if self.waiting > 0 {
            format!("{} revision{} wait", self.waiting, if self.waiting == 1 { "" } else { "s" })
        } else if self.confirm {
            "confirm after an amend".into()
        } else if self.stale {
            "stale after an amend".into()
        } else if self.failing {
            "last run failed".into()
        } else {
            format!("{} scenario{}", self.count, if self.count == 1 { "" } else { "s" })
        }
    }
}

fn key_ok(k: &str) -> bool {
    k.len() == 48 && k.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The page's key from `dir`, made the way deep-plan makes it (24 random
/// bytes as hex, 0600) when the plan has scenarios and no key yet. None for
/// a plan without scenarios.
pub fn page_key_in(dir: &Path, slug: &str) -> Result<String, String> {
    if !slug_ok(slug) {
        return Err(format!("not a plan slug: {slug}"));
    }
    let d = dir.join(slug);
    if !d.join("scenarios.json").is_file() {
        return Err(format!("{slug} has no sealed scenarios yet: deep-plan scenarios write {slug}"));
    }
    let f = d.join("page.key");
    if let Ok(k) = fs::read_to_string(&f) {
        let k = k.trim().to_string();
        if key_ok(&k) {
            return Ok(k);
        }
    }
    let mut buf = [0u8; 24];
    fs::File::open("/dev/urandom").and_then(|mut r| r.read_exact(&mut buf)).map_err(|e| format!("no randomness for the key: {e}"))?;
    let k: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = d.join(format!("page.key.{}.tmp", std::process::id()));
    write_private(&tmp, &format!("{k}\n")).map_err(|e| format!("could not write the key: {e}"))?;
    fs::rename(&tmp, &f).map_err(|e| format!("could not write the key: {e}"))?;
    Ok(k)
}

pub fn page_key(slug: &str) -> Result<String, String> {
    page_key_in(&sealed_dir(), slug)
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(text.as_bytes())
}
#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("scn-rs-{}-{}", std::process::id(), rand_suffix()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }
    fn put(dir: &Path, slug: &str, name: &str, body: &str) {
        fs::create_dir_all(dir.join(slug)).unwrap();
        fs::write(dir.join(slug).join(name), body).unwrap();
    }

    #[test]
    fn a_plan_without_scenarios_has_no_standing_and_no_key() {
        let d = tmp();
        assert_eq!(standing_in(&d, "p"), None);
        assert!(page_key_in(&d, "p").is_err());
        assert_eq!(standing_in(&d, "../x"), None);
    }

    #[test]
    fn standing_counts_and_reads_revisions_and_the_last_verdict() {
        let d = tmp();
        put(&d, "p", "scenarios.json", r#"{"scenarios":[{"id":"s1"},{"id":"s2"}]}"#);
        let s = standing_in(&d, "p").unwrap();
        assert_eq!((s.count, s.needs_person(), s.state()), (2, false, "2 scenarios".to_string()));
        put(&d, "p", "verdicts.json", r#"{"last":{"pass":false}}"#);
        assert_eq!(standing_in(&d, "p").unwrap().state(), "last run failed");
        put(&d, "p", "revisions.json", r#"{"stale":{"seq":1},"proposals":null}"#);
        assert_eq!(standing_in(&d, "p").unwrap().state(), "stale after an amend");
        put(&d, "p", "revisions.json", r#"{"stale":{"seq":1},"proposals":[{"pid":"p1"},{"pid":"p2"}]}"#);
        let s = standing_in(&d, "p").unwrap();
        assert!(s.needs_person());
        assert_eq!(s.state(), "2 revisions wait");
        put(&d, "p", "revisions.json", r#"{"stale":{"seq":2},"proposals":[]}"#);
        assert!(standing_in(&d, "p").unwrap().needs_person());
        put(&d, "p", "revisions.json", r#"{"stale":null,"proposals":null}"#);
        assert!(!standing_in(&d, "p").unwrap().needs_person());
    }

    #[test]
    fn the_key_is_read_or_made_once_at_0600() {
        let d = tmp();
        put(&d, "p", "scenarios.json", r#"{"scenarios":[]}"#);
        let k = page_key_in(&d, "p").unwrap();
        assert!(key_ok(&k));
        assert_eq!(page_key_in(&d, "p").unwrap(), k);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(d.join("p").join("page.key")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        put(&d, "q", "scenarios.json", r#"{"scenarios":[]}"#);
        put(&d, "q", "page.key", &format!("{}\n", "a".repeat(48)));
        assert_eq!(page_key_in(&d, "q").unwrap(), "a".repeat(48));
    }
}
