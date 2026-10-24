//! Plan pages and their two actions: resolving /plan/ URLs to files under
//! ~/.claude/plans, opening a plan's file in the editor (/open), and running
//! a tracker transition (/inc).
//!
//! A slug or id reaches here from a URL and is about to be joined onto a
//! path, so it is anchored and character-limited, and every resolved path is
//! checked to land inside the directory it names.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use crate::server::{crew_file, dp_state, log, plans_dir, unquote};

pub fn slug_ok(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9._-]{0,120}$").unwrap()).is_match(s)
}

pub fn uuid_ok(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$").unwrap()).is_match(s)
}

/// A review page's inlined mermaid, swapped for the shared copy when served.
pub fn swap_mermaid(html: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r#"src="data:text/javascript;base64,[A-Za-z0-9+/=]+""#).unwrap());
    r.replacen(html, 1, r#"src="/mermaid.min.js""#).into_owned()
}

pub fn has_inlined_mermaid(html: &str) -> bool {
    swap_mermaid(html).len() != html.len()
}

/// `os.path.realpath`: symlinks resolved as far as the path exists, the rest
/// joined and normalized lexically.
pub fn realpath(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    for c in abs.components() {
        match c {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => {
                out.push(n);
                if let Ok(real) = std::fs::canonicalize(&out) {
                    out = real;
                }
            }
        }
    }
    out
}

/// `target == base or target under base`.
pub fn within(target: &Path, base: &Path) -> bool {
    target == base || target.starts_with(base)
}

/// The live working surface, else the frozen review; None for a bad slug.
pub fn plan_page(slug: &str) -> Option<PathBuf> {
    if !slug_ok(slug) {
        return None;
    }
    [".working.html", ".review.html"]
        .iter()
        .map(|sfx| plans_dir().join(format!("{slug}{sfx}")))
        .find(|p| p.exists())
}

/// A /plan/ URL segment to a real file: a bare slug, or an internal link
/// ending .html or .md that resolves inside the plans directory.
pub fn plan_asset(rel: &str) -> Option<PathBuf> {
    let rel = unquote(rel).trim().to_string();
    if rel.is_empty() || rel.starts_with('/') {
        return None;
    }
    if !(rel.ends_with(".html") || rel.ends_with(".md")) {
        return plan_page(&rel);
    }
    let base = realpath(&plans_dir());
    let target = realpath(&plans_dir().join(&rel));
    if !within(&target, &base) {
        return None;
    }
    target.is_file().then_some(target)
}

/// The worktree a plan guards, from its tracker state file.
pub fn plan_root(slug: &str) -> Option<String> {
    if !slug_ok(slug) {
        return None;
    }
    let v: Value = serde_json::from_str(&std::fs::read_to_string(dp_state().join(format!("{slug}.json"))).ok()?).ok()?;
    v.get("root").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

/// Open one file of a plan's worktree in the editor, through crew-code-open.
/// The page proposes a relative path; the root comes from the tracker.
pub fn open_file(slug: &str, rel: &str) -> (bool, String) {
    let Some(root) = plan_root(slug) else {
        return (false, format!("no worktree recorded for {}", if slug.is_empty() { "?" } else { slug }));
    };
    let rel = unquote(rel).trim().to_string();
    if rel.is_empty() || rel.starts_with('/') {
        return (false, "not a relative path".into());
    }
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"^(.*?)((?::\d+){1,2})$").unwrap());
    let (bare, suffix) = match r.captures(&rel) {
        Some(c) => (c[1].to_string(), c[2].to_string()),
        None => (rel.clone(), String::new()),
    };
    let base = realpath(Path::new(&root));
    let target = realpath(&base.join(&bare));
    if !within(&target, &base) {
        return (false, "outside the worktree".into());
    }
    if !target.exists() {
        return (false, format!("not created yet: {bare}"));
    }
    let arg = format!("{}{}", target.display(), suffix);
    let ok = crate::act::run_ok("bash", &[&crew_file("bin/crew-code-open").to_string_lossy(), &arg], None);
    (ok, if ok { format!("opened {rel}") } else { format!("crew-code-open refused {rel}") })
}

pub const INC_ACTIONS: [&str; 5] = ["go", "start", "done", "block", "reset"];

/// One tracker transition through the deep-plan engine.
pub fn increment(slug: &str, n: &str, action: &str, why: &str) -> (bool, String) {
    if !slug_ok(slug) {
        return (false, "bad slug".into());
    }
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return (false, "bad increment".into());
    }
    if !INC_ACTIONS.contains(&action) {
        return (false, "bad transition".into());
    }
    let script = crew_core::dp_engine::script().to_string_lossy().into_owned();
    let mut args = vec![script.as_str(), action, slug, n];
    let why = if why.is_empty() { "blocked from the plan surface" } else { why };
    if action == "block" {
        args.push(why);
    }
    // A go from here is a person's click (the Desk's family card, the plan
    // page). Said so, a delegated child's go is not refused as its own, and
    // the log records who gave it.
    if action == "go" {
        args.extend(["--by", "human"]);
    }
    if crate::act::which("node").is_none() {
        log(&format!("FAIL inc {action} {slug} {n}: node is not on PATH"));
        return (false, "node is not on this server's PATH, so deep-plan cannot run".into());
    }
    let Some((code, out, err)) = crew_core::py::run("node", &args, Duration::from_secs(90)) else {
        log(&format!("FAIL inc {action} {slug} {n}: timed out"));
        return (false, "deep-plan did not finish in 90s".into());
    };
    let all = format!("{out}{err}");
    let detail: String = all.trim().split('\n').last().unwrap_or("").chars().take(160).collect();
    if code != 0 {
        log(&format!("FAIL inc {action} {slug} {n}: {detail}"));
        return (false, if detail.is_empty() { "deep-plan refused it".into() } else { detail });
    }
    (true, format!("{action} {slug} {n}"))
}

/// A check id as deep-plan derives one: lower-case words joined by `-`.
pub fn check_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 120 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The argv for recording a manual or observability check by hand, or why not.
pub fn check_record_args(slug: &str, n: &str, id: &str, verdict: &str, note: &str) -> Result<Vec<String>, String> {
    if !slug_ok(slug) {
        return Err("bad slug".into());
    }
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return Err("bad increment".into());
    }
    if !check_id_ok(id) {
        return Err("bad check id".into());
    }
    if verdict != "pass" && verdict != "fail" {
        return Err("a check passes or fails".into());
    }
    let note = note.trim();
    if note.is_empty() {
        return Err("say what you saw: the note is the check's only evidence".into());
    }
    if note.chars().count() > 2000 || note.chars().any(|c| c.is_control() && c != '\n') {
        return Err("the note is too long or carries control characters".into());
    }
    // The note is a positional argument: one that starts like a flag
    // (`--force`) could be read as one by the engine.
    if note.starts_with('-') {
        return Err("a note can't start with '-'".into());
    }
    let script = crew_core::dp_engine::script().to_string_lossy().into_owned();
    Ok([script.as_str(), "check", verdict, slug, n, id, note].iter().map(|s| s.to_string()).collect())
}

/// Record a check the person observed: `deep-plan check pass|fail`.
pub fn check_record(slug: &str, n: &str, id: &str, verdict: &str, note: &str) -> (bool, String) {
    let args = match check_record_args(slug, n, id, verdict, note) {
        Ok(a) => a,
        Err(e) => return (false, e),
    };
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let Some((code, out, err)) = crew_core::py::run("node", &argv, Duration::from_secs(60)) else {
        log(&format!("FAIL check {verdict} {slug} {n} {id}: node did not finish"));
        return (false, "deep-plan did not run (no node, or it timed out)".into());
    };
    let detail: String = format!("{out}{err}").trim().lines().last().unwrap_or("").chars().take(160).collect();
    if code != 0 {
        log(&format!("FAIL check {verdict} {slug} {n} {id}: {detail}"));
        return (false, if detail.is_empty() { "deep-plan refused it".into() } else { detail });
    }
    (true, format!("recorded {verdict} for {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_record_names_the_engine_verb_and_refuses_bad_input() {
        let a = check_record_args("seamux-views", "3", "manual-live", "pass", " saw it land \n").unwrap();
        assert_eq!(&a[1..], ["check", "pass", "seamux-views", "3", "manual-live", "saw it land"]);
        assert!(a[0].ends_with("deep_plan.mjs"), "{}", a[0]);
        assert!(check_record_args("../x", "3", "m", "pass", "n").is_err());
        assert!(check_record_args("p", "3a", "m", "pass", "n").is_err());
        assert!(check_record_args("p", "3", "Manual Live", "pass", "n").is_err());
        assert!(check_record_args("p", "3", "m", "done", "n").is_err());
        assert!(check_record_args("p", "3", "m", "fail", "   ").is_err());
        assert!(check_record_args("p", "3", "m", "fail", "a\u{1b}[2J").is_err());
        assert!(check_record_args("p", "3", "m", "pass", "--force").is_err());
        assert!(check_record_args("p", "3", "m", "pass", "  -x saw").is_err());
        assert!(check_record_args("p", "3", "m", "pass", "saw it, no --force needed").is_ok());
    }

    #[test]
    fn slugs_and_uuids() {
        assert!(slug_ok("port-board") && slug_ok("a.b_c-1"));
        assert!(!slug_ok("../x") && !slug_ok("Upper") && !slug_ok(""));
        assert!(uuid_ok("8B5F643D-E94F-41B8-945C-EBCB4DF64FB1") && !uuid_ok("workspace:9"));
    }

    #[test]
    fn realpath_normalizes_what_does_not_exist() {
        let r = realpath(Path::new("/nonexistent-crew/a/../b/./c"));
        assert_eq!(r, PathBuf::from("/nonexistent-crew/b/c"));
        assert!(!within(&realpath(Path::new("/nonexistent-crew/../etc")), Path::new("/nonexistent-crew")));
    }

    #[test]
    fn the_mermaid_swap() {
        let h = r#"<script src="data:text/javascript;base64,QUJD+/="></script>"#;
        assert_eq!(swap_mermaid(h), r#"<script src="/mermaid.min.js"></script>"#);
        assert!(has_inlined_mermaid(h) && !has_inlined_mermaid("<p>"));
    }
}
