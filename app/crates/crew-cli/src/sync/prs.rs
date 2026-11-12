//! A worktree's PR list (crew_core::prs's file): the PRs its sessions made
//! (crew-store's `made`) plus the branch's PR, read through `lookout gh
//! prs` in one GitHub query per repo (ADR: GitHub reads live in lookout).
//! Merged and closed PRs already in the file are kept and never asked about
//! again. Without lookout, or with no PRs, nothing is written.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use crew_core::py;
use serde_json::{json, Map, Value};

use crate::proc;

/// owner/repo and number of a github.com pull request URL.
pub fn parse_url(url: &str) -> Option<(String, u64)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let mut it = rest.split('/');
    let (owner, repo, pull, n) = (it.next()?, it.next()?, it.next()?, it.next()?);
    if owner.is_empty() || repo.is_empty() || pull != "pull" {
        return None;
    }
    Some((format!("{owner}/{repo}"), n.parse().ok().filter(|n: &u64| *n > 0)?))
}

/// Merged is final; a closed PR can be reopened, so it is read again.
fn merged(pr: &Value) -> bool {
    pr.get("state").and_then(Value::as_str) == Some("merged")
}

/// The most made PRs a list reads: the newest, so a long-lived worktree's
/// read stays a few GitHub queries.
pub const MADE_CAP: usize = 60;

/// A PR's place in the list: repo (lower case, as GitHub matches it) and number.
fn key_of(repo: &str, n: u64) -> (String, u64) {
    (repo.to_ascii_lowercase(), n)
}

fn key_of_pr(pr: &Value) -> Option<(String, u64)> {
    let (repo, n) = parse_url(pr.get("url").and_then(Value::as_str).unwrap_or(""))?;
    Some(key_of(&repo, n))
}

/// The new list and whether every PR in it was read this time. `wanted`:
/// PR URLs, the branch's first, then made ones newest first. `prev`: the
/// file's list. `ask(repo, numbers)` is lookout's answer: { prs, missing,
/// unread } or { skipped } or { error } (None when it could not run). Each
/// repo's answer stands alone: one that fails keeps the file's entries for
/// that repo. None means nothing was read: keep the file as it is.
pub fn gather(wanted: &[String], prev: &[Value], ask: &mut dyn FnMut(&str, &[u64]) -> Option<Value>) -> Option<(Vec<Value>, bool)> {
    let prev_by: HashMap<(String, u64), &Value> = prev.iter().filter_map(|p| Some((key_of_pr(p)?, p))).collect();
    let mut order: Vec<(String, u64)> = Vec::new();
    let mut seen: HashSet<(String, u64)> = HashSet::new();
    // Keyed by the repo as first spelled, so lookout is asked as the URL said.
    let mut by_repo: BTreeMap<String, Vec<u64>> = BTreeMap::new();
    for u in wanted {
        let Some((repo, n)) = parse_url(u) else { continue };
        let k = key_of(&repo, n);
        if !seen.insert(k.clone()) {
            continue;
        }
        order.push(k.clone());
        if prev_by.get(&k).is_some_and(|p| merged(p)) {
            continue;
        }
        let spelled = by_repo.keys().find(|r| r.eq_ignore_ascii_case(&repo)).cloned().unwrap_or(repo);
        by_repo.entry(spelled).or_default().push(n);
    }
    if order.is_empty() {
        return None;
    }
    let mut fresh: HashMap<(String, u64), Value> = HashMap::new();
    let mut gone: HashSet<(String, u64)> = HashSet::new();
    let mut read_any = by_repo.is_empty();
    let mut complete = true;
    for (repo, ns) in &by_repo {
        let r = ask(repo, ns);
        let Some(list) = r.as_ref().and_then(|r| r.get("prs")).and_then(Value::as_array) else {
            // Backing off, asked moments ago, an error or no answer: what the
            // file had for this repo stands, and the next tick asks again.
            complete = false;
            continue;
        };
        read_any = true;
        // Matched by the number asked within this repo, not by the URL
        // GitHub returns: a renamed or re-cased repo still finds its PR.
        for p in list {
            if let Some(n) = p.get("n").and_then(Value::as_u64) {
                let mut p = p.clone();
                p["group"] = json!(crew_core::prs::group(&p));
                fresh.insert(key_of(repo, n), p);
            }
        }
        let r = r.as_ref().unwrap();
        for n in r.get("missing").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_u64) {
            gone.insert(key_of(repo, n));
        }
        if r.get("unread").and_then(Value::as_array).is_some_and(|u| !u.is_empty()) {
            complete = false;
        }
    }
    if !read_any {
        return None;
    }
    let out: Vec<Value> = order
        .iter()
        .filter(|k| !gone.contains(*k))
        .filter_map(|k| fresh.remove(k).or_else(|| prev_by.get(k).map(|p| (*p).clone())))
        .collect();
    Some((out, complete))
}

/// lookout, as the app finds it: $CREW_LOOKOUT, else on PATH or in
/// ~/.local/bin, /opt/homebrew/bin, /usr/local/bin.
pub fn lookout_bin() -> Option<String> {
    if let Some(b) = py::env_or("CREW_LOOKOUT") {
        return (!b.is_empty() && Path::new(&b).exists()).then_some(b);
    }
    let home = py::home();
    let mut dirs: Vec<String> = std::env::var("PATH").unwrap_or_default().split(':').map(String::from).collect();
    dirs.extend([home.join(".local/bin").to_string_lossy().into_owned(), "/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
    dirs.into_iter().filter(|d| !d.is_empty()).map(|d| format!("{d}/lookout")).find(|p| Path::new(p).is_file())
}

fn ask_lookout(bin: &str, cwd: &str, repo: &str, ns: &[u64]) -> Option<Value> {
    let mut argv: Vec<String> = vec![bin.into(), "gh".into(), "prs".into(), repo.into()];
    argv.extend(ns.iter().map(u64::to_string));
    argv.extend(["--cwd".into(), cwd.into(), "--json".into()]);
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let chunks = ns.len().div_ceil(25).max(1) as u64;
    let r = proc::run(&args, Some(cwd), &[], Some(Duration::from_secs(30 * chunks)))?;
    serde_json::from_str::<Value>(&r.stdout).ok().filter(Value::is_object)
}

/// Refresh worktree `cwd`'s list when it is older than `ttl` seconds.
/// `gh` is crew-sync's branch PR facts (gh_state), for its url. A list read
/// only in part keeps its old `at`, so the next tick reads the rest.
pub fn refresh(cwd: &str, ttl: i64, gh: &Map<String, Value>) {
    let now = py::now();
    let prev = crew_core::prs::read(cwd);
    let prev_at = prev.as_ref().and_then(|v| v.get("at")).and_then(Value::as_f64);
    if prev_at.is_some_and(|at| now - at < ttl as f64) {
        return;
    }
    let mut wanted: Vec<String> = Vec::new();
    if let Some(u) = gh.get("url").and_then(Value::as_str).filter(|u| parse_url(u).is_some()) {
        wanted.push(u.to_string());
    }
    // The store is read only where it already is: a probe never makes one.
    if Path::new(&crew_store::Paths::from_env().db).exists() {
        wanted.extend(crew_store::made_prs(cwd).unwrap_or_default().into_iter().take(MADE_CAP));
    }
    let prev_list: Vec<Value> = prev.as_ref().and_then(|v| v.get("prs")).and_then(Value::as_array).cloned().unwrap_or_default();
    if wanted.is_empty() && prev_list.is_empty() {
        return;
    }
    let Some(bin) = lookout_bin() else { return };
    let Some((list, complete)) = gather(&wanted, &prev_list, &mut |repo, ns| ask_lookout(&bin, cwd, repo, ns)) else { return };
    let path = crew_core::prs::path(cwd);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let at = if complete { now } else { prev_at.unwrap_or(0.0) };
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let body = crew_core::pyjson::dumps(&json!({"at": at, "prs": list}));
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(n: u64, state: &str) -> Value {
        json!({"n": n, "url": format!("https://github.com/o/r/pull/{n}"), "state": state})
    }

    fn u(n: u64) -> String {
        format!("https://github.com/o/r/pull/{n}")
    }

    fn states(v: &[Value]) -> Vec<&str> {
        v.iter().map(|p| p["state"].as_str().unwrap()).collect()
    }

    #[test]
    fn urls_parse_to_repo_and_number() {
        assert_eq!(parse_url("https://github.com/o/r/pull/12"), Some(("o/r".into(), 12)));
        assert_eq!(parse_url("https://github.com/o/r/issues/12"), None);
        assert_eq!(parse_url("https://example.com/o/r/pull/12"), None);
    }

    #[test]
    fn merged_prs_are_kept_and_never_asked_again_closed_ones_are() {
        let prev = vec![pr(1, "merged"), pr(2, "open"), pr(4, "closed")];
        let mut asked: Vec<Vec<u64>> = Vec::new();
        let (got, complete) = gather(&[u(3), u(2), u(1), u(4)], &prev, &mut |_, ns| {
            asked.push(ns.to_vec());
            Some(json!({"prs": [pr(3, "draft"), pr(2, "closed"), pr(4, "open")], "missing": [], "unread": []}))
        })
        .unwrap();
        assert_eq!(asked, vec![vec![3, 2, 4]], "a closed PR can be reopened, so it is asked");
        assert_eq!(states(&got), vec!["draft", "closed", "merged", "open"], "branch PR first, then made order; merged #1 carried");
        assert!(complete);
        assert_eq!(got[0]["group"], json!("draft"), "crew-sync writes each PR's group");
    }

    #[test]
    fn a_skip_keeps_the_file_and_unread_prs_keep_their_last_read() {
        let prev = vec![pr(2, "open"), pr(3, "open")];
        assert_eq!(gather(&[u(2), u(3)], &prev, &mut |_, _| Some(json!({"skipped": "backoff"}))), None);
        assert_eq!(gather(&[u(2)], &prev, &mut |_, _| None), None, "no lookout answer: keep the file");
        let (got, complete) = gather(&[u(2), u(3)], &prev, &mut |_, _| Some(json!({"prs": [pr(2, "draft")], "missing": [], "unread": [3]}))).unwrap();
        assert_eq!(states(&got), vec!["draft", "open"]);
        assert!(!complete, "a partial read is retried next tick");
    }

    #[test]
    fn each_repo_stands_alone() {
        let other = |n: u64| format!("https://github.com/x/y/pull/{n}");
        let prev = vec![json!({"n": 8, "url": other(8), "state": "open"})];
        let (got, complete) = gather(&[u(2), other(8)], &prev, &mut |repo, _| {
            if repo == "o/r" { Some(json!({"prs": [pr(2, "draft")], "missing": [], "unread": []})) } else { None }
        })
        .unwrap();
        assert_eq!(states(&got), vec!["draft", "open"], "o/r's read stands; x/y keeps its last");
        assert!(!complete);
    }

    #[test]
    fn a_renamed_or_recased_repo_still_finds_its_pr() {
        let (got, _) = gather(&["https://github.com/Org/Repo/pull/5".into()], &[], &mut |repo, ns| {
            assert_eq!((repo, ns), ("Org/Repo", &[5][..]));
            Some(json!({"prs": [{"n": 5, "url": "https://github.com/org/renamed/pull/5", "state": "open"}], "missing": [], "unread": []}))
        })
        .unwrap();
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn a_pr_github_cannot_find_drops_out() {
        let (got, _) = gather(&[u(2), u(9)], &[], &mut |_, _| Some(json!({"prs": [pr(2, "open")], "missing": [9], "unread": []}))).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(gather(&[], &[], &mut |_, _| unreachable!()), None);
    }
}
