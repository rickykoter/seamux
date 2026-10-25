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

/// What the plan page may ask of a browser or claiming check. Each is one
/// deep-plan verb; none of them can pass a check (the verdict stays the
/// run's exit code).
pub const CHECK_VERBS: [&str; 4] = ["run", "answer", "tab", "evidence"];

/// A claim's export name, as the engine's --set takes it.
pub fn env_name_ok(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[A-Z_][A-Z0-9_]{0,63}$").unwrap()).is_match(s)
}

/// The argv for one check action, or why not. `run` and `answer` detach, so
/// the request returns as soon as the run has started (or the answer has
/// been handed to the run in flight).
pub fn check_action_args(verb: &str, slug: &str, n: &str, id: &str, name: &str, value: &str) -> Result<Vec<String>, String> {
    if !CHECK_VERBS.contains(&verb) {
        return Err("bad check action".into());
    }
    if !slug_ok(slug) {
        return Err("bad slug".into());
    }
    if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
        return Err("bad increment".into());
    }
    if !check_id_ok(id) {
        return Err("bad check id".into());
    }
    let script = crew_core::dp_engine::script().to_string_lossy().into_owned();
    let mut a: Vec<String> = [script.as_str(), "check"].iter().map(|s| s.to_string()).collect();
    match verb {
        "run" => a.extend(["run", slug, n, id, "--detach"].map(String::from)),
        "tab" => a.extend(["tab", slug, n, id].map(String::from)),
        "evidence" => a.extend(["evidence", slug, n, id, "--json"].map(String::from)),
        _ => {
            if !env_name_ok(name) {
                return Err("the answer needs the claim's variable name".into());
            }
            let value = value.trim();
            if value.is_empty() {
                return Err("an empty answer is no answer".into());
            }
            if value.chars().count() > 200 || value.chars().any(char::is_control) {
                return Err("the answer is too long or carries control characters".into());
            }
            a.extend(["run", slug, n, id, "--detach", "--set"].map(String::from));
            a.push(format!("{name}={value}"));
        }
    }
    Ok(a)
}

/// Run one check action. Ok carries the engine's stdout (the evidence JSON,
/// for `evidence`); Err its last line, or why it never ran.
pub fn check_action(verb: &str, slug: &str, n: &str, id: &str, name: &str, value: &str) -> Result<String, String> {
    let args = check_action_args(verb, slug, n, id, name, value)?;
    if crate::act::which("node").is_none() {
        return Err("node is not on this server's PATH, so deep-plan cannot run".into());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let Some((code, out, err)) = crew_core::py::run("node", &argv, Duration::from_secs(60)) else {
        log(&format!("FAIL check {verb} {slug} {n} {id}: node did not finish"));
        return Err("deep-plan did not finish in 60s".into());
    };
    if code != 0 {
        let detail: String = format!("{out}{err}").trim().lines().last().unwrap_or("").chars().take(200).collect();
        log(&format!("FAIL check {verb} {slug} {n} {id}: {detail}"));
        return Err(if detail.is_empty() { "deep-plan refused it".into() } else { detail });
    }
    Ok(out)
}

/// One file of a check's browser evidence: `<run dir>/<frame|replay|trace>`
/// inside the plan's runs directory, and nothing else. The run dir is named
/// inc<n>-<id>-<ms>, as the engine makes it.
pub fn evidence_file(slug: &str, rel: &str) -> Option<PathBuf> {
    evidence_file_in(&plans_dir(), slug, rel)
}

/// evidence_file against a given plans directory (tests pass their own).
pub fn evidence_file_in(plans: &Path, slug: &str, rel: &str) -> Option<PathBuf> {
    if !slug_ok(slug) {
        return None;
    }
    static R: OnceLock<Regex> = OnceLock::new();
    let r = R.get_or_init(|| Regex::new(r"^inc\d+-[A-Za-z0-9._-]+-\d+/(frame-\d{1,6}\.png|run\.png|trace\.jsonl)$").unwrap());
    let rel = unquote(rel);
    if !r.is_match(&rel) {
        return None;
    }
    let base = realpath(&plans.join(format!("{slug}.runs")));
    let target = realpath(&base.join(&rel));
    (within(&target, &base) && target.is_file()).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_actions_name_one_engine_verb_and_refuse_bad_input() {
        let a = check_action_args("run", "browser-checks", "3", "flow", "", "").unwrap();
        assert_eq!(&a[1..], ["check", "run", "browser-checks", "3", "flow", "--detach"]);
        let a = check_action_args("answer", "p", "2", "qa", "QA_ENV", " qa-2 ").unwrap();
        assert_eq!(&a[1..], ["check", "run", "p", "2", "qa", "--detach", "--set", "QA_ENV=qa-2"]);
        assert_eq!(&check_action_args("tab", "p", "2", "qa", "", "").unwrap()[1..], ["check", "tab", "p", "2", "qa"]);
        assert_eq!(&check_action_args("evidence", "p", "2", "qa", "", "").unwrap()[1..], ["check", "evidence", "p", "2", "qa", "--json"]);
        assert!(check_action_args("pass", "p", "2", "qa", "", "").is_err(), "nothing here can pass a check");
        assert!(check_action_args("run", "../p", "2", "qa", "", "").is_err());
        assert!(check_action_args("run", "p", "2a", "qa", "", "").is_err());
        assert!(check_action_args("run", "p", "2", "Q A", "", "").is_err());
        assert!(check_action_args("answer", "p", "2", "qa", "qa_env", "x").is_err());
        assert!(check_action_args("answer", "p", "2", "qa", "QA_ENV", "   ").is_err());
        assert!(check_action_args("answer", "p", "2", "qa", "QA_ENV", "a\u{1b}[2J").is_err());
        assert!(check_action_args("answer", "p", "2", "qa", "QA_ENV", &"x".repeat(201)).is_err());
    }

    #[test]
    fn evidence_files_stay_inside_the_plans_runs_dir() {
        let plans = std::env::temp_dir().join(format!("crew-board-ev-{}", std::process::id()));
        let runs = plans.join("p1.runs/inc1-flow-123");
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::write(runs.join("frame-0001.png"), b"png").unwrap();
        std::fs::write(runs.join("progress.jsonl"), b"{}").unwrap();
        std::fs::write(plans.join("p1.runs/inc1-flow-123.log"), b"log").unwrap();
        std::fs::write(plans.join("p1.json"), b"{}").unwrap();
        let found = evidence_file_in(&plans, "p1", "inc1-flow-123/frame-0001.png");
        let log = evidence_file_in(&plans, "p1", "inc1-flow-123.log");
        let up = evidence_file_in(&plans, "p1", "inc1-flow-123/../../p1.json");
        let other = evidence_file_in(&plans, "p1", "inc1-flow-123/progress.jsonl");
        let missing = evidence_file_in(&plans, "p1", "inc1-flow-123/run.png");
        let bad_slug = evidence_file_in(&plans, "../p1", "inc1-flow-123/frame-0001.png");
        std::fs::remove_dir_all(&plans).ok();
        assert!(found.is_some(), "a frame of a run is served");
        assert!(log.is_none() && up.is_none() && other.is_none(), "only frames, the replay and the trace");
        assert!(missing.is_none(), "a file that is not there is not served");
        assert!(bad_slug.is_none());
    }

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
