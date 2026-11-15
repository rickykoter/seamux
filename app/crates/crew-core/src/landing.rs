//! A merge's landing, as deep-plan's land run records it (plan landing):
//! where its state file is, what it says, and one status for the whole
//! merge that the app's watcher, the Dock and the Lookout tab show.
//!
//!   <crew home>/landings/<repo key>/<merge>.json
//!   { repo, key, pr, merge, recipes: { <key>: { key, id, name, hash,
//!     status: running|awaiting|done|failed|skipped, stages: [{ name,
//!     status, start, end }], version: { expect, live, match }, links,
//!     log, error, tail } } }
//!
//! The crew home is CREW_DURABLE_DIR, else ~/.claude/crew. The repo key is
//! deep-plan's (lib/land.mjs repoKey): owner__name from the checkout's
//! origin when it is on GitHub, else the checkout's folder name.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    crate::py::env_or("CREW_DURABLE_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::py::home().join(".claude").join("crew"))
}

fn safe(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    if t.is_empty() { "repo".into() } else { t }
}

/// The repo key for an origin URL and the checkout's folder, as land.mjs
/// makes it.
pub fn repo_key_for(origin: &str, folder: &str) -> String {
    let o = origin.trim().trim_end_matches('/');
    let tail = o.split("github.com").nth(1).map(|t| t.trim_start_matches([':', '/']));
    if let Some(t) = tail {
        let mut it = t.split('/');
        if let (Some(owner), Some(name), None) = (it.next(), it.next(), it.next()) {
            let name = name.strip_suffix(".git").unwrap_or(name);
            if !owner.is_empty() && !name.is_empty() {
                return safe(&format!("{owner}__{name}"));
            }
        }
    }
    safe(folder)
}

/// The repo key of the kept checkout at `repo`.
pub fn repo_key(repo: &Path) -> String {
    let origin = std::process::Command::new("git")
        .args(["-C", &repo.to_string_lossy(), "remote", "get-url", "origin"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    repo_key_for(&origin, &repo.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default())
}

pub fn state_path(home: &Path, key: &str, merge: &str) -> PathBuf {
    home.join("landings").join(safe(key)).join(format!("{}.json", safe(merge)))
}

pub fn read(home: &Path, key: &str, merge: &str) -> Option<Value> {
    let t = std::fs::read_to_string(state_path(home, key, merge)).ok()?;
    serde_json::from_str::<Value>(&t).ok().filter(Value::is_object)
}

/// A merge's landing in one word, worst first: a recipe waiting on the
/// person (awaiting), one failed, one still running (landing, with the
/// stage it is on), every recipe done or skipped (done), or no recipe at
/// all (none).
#[derive(Clone, Debug, PartialEq)]
pub struct Overall {
    pub status: &'static str,
    /// The stage running or waiting, or the one that failed.
    pub stage: String,
    /// The recipe it belongs to.
    pub recipe: String,
    /// Whether every recipe with a version reports its live version as the
    /// one expected.
    pub live: bool,
}

pub fn overall(state: &Value) -> Overall {
    overall_of(state, &[])
}

/// overall, knowing the recipes the merge was planned to land: one that has
/// not started yet (the runs go one after another) keeps the merge landing,
/// so it never reads as done before its last recipe ran.
pub fn overall_of(state: &Value, expected: &[String]) -> Overall {
    let o = overall_now(state);
    let started = state.get("recipes").and_then(Value::as_object);
    let missing = expected.iter().find(|k| !started.is_some_and(|m| m.contains_key(k.as_str())));
    match (o.status, missing) {
        ("done" | "none", Some(k)) => Overall { status: "landing", stage: String::new(), recipe: k.clone(), live: false },
        _ => o,
    }
}

fn overall_now(state: &Value) -> Overall {
    let recipes: Vec<&Value> = state.get("recipes").and_then(Value::as_object).map(|m| m.values().collect()).unwrap_or_default();
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let stage_of = |r: &Value, want: &str| {
        r.get("stages").and_then(Value::as_array).and_then(|a| a.iter().find(|x| x.get("status").and_then(Value::as_str) == Some(want)))
            .map(|x| s(x, "name")).unwrap_or_default()
    };
    for (want, word, st) in [("awaiting", "awaiting", "awaiting"), ("failed", "failed", "failed"), ("running", "landing", "running")] {
        if let Some(r) = recipes.iter().find(|r| s(r, "status") == want) {
            return Overall { status: word, stage: stage_of(r, st), recipe: s(r, "key"), live: false };
        }
    }
    if recipes.is_empty() {
        return Overall { status: "none", stage: String::new(), recipe: String::new(), live: false };
    }
    let versions: Vec<bool> = recipes.iter().filter_map(|r| r.get("version")).map(|v| v.get("match").and_then(Value::as_bool) == Some(true)).collect();
    Overall { status: "done", stage: String::new(), recipe: String::new(), live: !versions.is_empty() && versions.iter().all(|m| *m) }
}

/// Seconds since the epoch for an ISO 8601 UTC time as GitHub writes it
/// (2026-11-13T07:31:00Z), or None.
pub fn iso_secs(t: &str) -> Option<i64> {
    let b = t.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || !t.ends_with('Z') {
        return None;
    }
    let n = |a: usize, z: usize| t.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    // Days from the civil date (Howard Hinnant's algorithm).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400 + h * 3600 + mi * 60 + s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_repo_key_is_deep_plans() {
        assert_eq!(repo_key_for("https://github.com/rickykoter/seamux.git", "seamux"), "rickykoter__seamux");
        assert_eq!(repo_key_for("git@github.com:o/r.git", "x"), "o__r");
        assert_eq!(repo_key_for("https://github.com/o/r/", "x"), "o__r");
        assert_eq!(repo_key_for("https://gitlab.com/o/r", "my repo"), "my_repo");
        assert_eq!(repo_key_for("", ""), "repo");
    }

    #[test]
    fn a_merge_reads_as_its_worst_recipe() {
        let r = |k: &str, st: &str, stages: serde_json::Value| json!({"key": k, "status": st, "stages": stages});
        let st = |rs: Vec<Value>| json!({"recipes": rs.into_iter().map(|r| (r["key"].as_str().unwrap().to_string(), r)).collect::<serde_json::Map<_, _>>()});
        let o = overall(&st(vec![r("a", "done", json!([])), r("b", "running", json!([{"name": "install", "status": "running"}]))]));
        assert_eq!((o.status, o.stage.as_str(), o.recipe.as_str()), ("landing", "install", "b"));
        let o = overall(&st(vec![r("a", "failed", json!([{"name": "deploy", "status": "failed"}])), r("b", "awaiting", json!([{"name": "nb", "status": "awaiting"}]))]));
        assert_eq!((o.status, o.stage.as_str()), ("awaiting", "nb"), "waiting on the person comes first");
        assert_eq!(overall(&json!({"recipes": {}})).status, "none");
        let mut done = r("a", "done", json!([]));
        done["version"] = json!({"expect": "x", "live": "x", "match": true});
        let o = overall(&st(vec![done.clone(), r("b", "skipped", json!([]))]));
        assert_eq!((o.status, o.live), ("done", true));
        done["version"]["match"] = json!(false);
        assert!(!overall(&st(vec![done.clone()])).live);
        // A planned recipe not started yet keeps the merge landing.
        let o = overall_of(&st(vec![done.clone()]), &["a".into(), "later".into()]);
        assert_eq!((o.status, o.recipe.as_str()), ("landing", "later"));
        assert_eq!(overall_of(&st(vec![done]), &["a".into()]).status, "done");
    }

    #[test]
    fn iso_times_read_as_github_writes_them() {
        assert_eq!(iso_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_secs("2026-11-13T07:31:00Z"), Some(1794555060));
        assert_eq!(iso_secs("2024-02-29T12:00:00Z"), Some(1709208000));
        assert_eq!(iso_secs("2026-11-13"), None);
    }
}
