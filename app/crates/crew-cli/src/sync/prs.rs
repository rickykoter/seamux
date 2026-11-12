//! A worktree's PR list (crew_core::prs's file): the PRs its sessions made
//! (crew-store's `made`) plus the branch's PR, read through `lookout gh
//! prs` in one GitHub query per repo (ADR: GitHub reads live in lookout).
//! Merged and closed PRs already in the file are kept and never asked about
//! again. Without lookout, or with no PRs, nothing is written.

use std::collections::BTreeMap;
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

fn done(pr: &Value) -> bool {
    matches!(pr.get("state").and_then(Value::as_str), Some("merged" | "closed"))
}

fn url_of(pr: &Value) -> String {
    pr.get("url").and_then(Value::as_str).unwrap_or("").to_string()
}

/// The new list. `wanted`: PR URLs, the branch's first, then made ones
/// newest first. `prev`: the file's list. `ask(repo, numbers)` is lookout's
/// answer: { prs, missing, unread } or { skipped } or { error } (None when
/// it could not run). None means keep the file as it is.
pub fn gather(wanted: &[String], prev: &[Value], ask: &mut dyn FnMut(&str, &[u64]) -> Option<Value>) -> Option<Vec<Value>> {
    let prev_by: BTreeMap<String, &Value> = prev.iter().map(|p| (url_of(p), p)).collect();
    let mut order: Vec<String> = Vec::new();
    let mut by_repo: BTreeMap<String, Vec<u64>> = BTreeMap::new();
    for u in wanted {
        let Some((repo, n)) = parse_url(u) else { continue };
        let canon = format!("https://github.com/{repo}/pull/{n}");
        if order.contains(&canon) {
            continue;
        }
        order.push(canon.clone());
        // Done is done: a merged or closed PR is not asked about again.
        if prev_by.get(&canon).is_some_and(|p| done(p)) {
            continue;
        }
        by_repo.entry(repo).or_default().push(n);
    }
    if order.is_empty() {
        return None;
    }
    let mut fresh: BTreeMap<String, Value> = BTreeMap::new();
    let mut gone: Vec<String> = Vec::new();
    let mut asked_any = by_repo.is_empty();
    for (repo, ns) in &by_repo {
        let r = ask(repo, ns)?;
        if r.get("skipped").is_some() || r.get("prs").is_none() {
            // Backing off, asked moments ago, or an error: what the file
            // had for this repo stands.
            continue;
        }
        asked_any = true;
        for p in r.get("prs").and_then(Value::as_array).into_iter().flatten() {
            fresh.insert(url_of(p), p.clone());
        }
        for n in r.get("missing").and_then(Value::as_array).into_iter().flatten() {
            if let Some(n) = n.as_u64() {
                gone.push(format!("https://github.com/{repo}/pull/{n}"));
            }
        }
    }
    if !asked_any {
        return None;
    }
    let out: Vec<Value> = order
        .iter()
        .filter(|u| !gone.contains(u))
        .filter_map(|u| fresh.get(u).cloned().or_else(|| prev_by.get(u).map(|p| (*p).clone())))
        .collect();
    Some(out)
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
    let r = proc::run(&args, Some(cwd), &[], Some(Duration::from_secs(90)))?;
    serde_json::from_str::<Value>(&r.stdout).ok().filter(Value::is_object)
}

/// Refresh worktree `cwd`'s list when it is older than `ttl` seconds.
/// `gh` is crew-sync's branch PR facts (gh_state), for its url.
pub fn refresh(cwd: &str, ttl: i64, gh: &Map<String, Value>) {
    let now = py::now();
    let prev = crew_core::prs::read(cwd);
    if prev.as_ref().and_then(|v| v.get("at")).and_then(Value::as_f64).is_some_and(|at| now - at < ttl as f64) {
        return;
    }
    let mut wanted: Vec<String> = Vec::new();
    if let Some(u) = gh.get("url").and_then(Value::as_str).filter(|u| parse_url(u).is_some()) {
        wanted.push(u.to_string());
    }
    // The store is read only where it already is: a probe never makes one.
    if Path::new(&crew_store::Paths::from_env().db).exists() {
        wanted.extend(crew_store::made_prs(cwd).unwrap_or_default());
    }
    let prev_list: Vec<Value> = prev.as_ref().and_then(|v| v.get("prs")).and_then(Value::as_array).cloned().unwrap_or_default();
    if wanted.is_empty() && prev_list.is_empty() {
        return;
    }
    let Some(bin) = lookout_bin() else { return };
    let Some(list) = gather(&wanted, &prev_list, &mut |repo, ns| ask_lookout(&bin, cwd, repo, ns)) else { return };
    let path = crew_core::prs::path(cwd);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let body = crew_core::pyjson::dumps(&json!({"at": now, "prs": list}));
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

    #[test]
    fn urls_parse_to_repo_and_number() {
        assert_eq!(parse_url("https://github.com/o/r/pull/12"), Some(("o/r".into(), 12)));
        assert_eq!(parse_url("https://github.com/o/r/issues/12"), None);
        assert_eq!(parse_url("https://example.com/o/r/pull/12"), None);
    }

    #[test]
    fn done_prs_are_kept_and_never_asked_again() {
        let prev = vec![pr(1, "merged"), pr(2, "open")];
        let mut asked: Vec<Vec<u64>> = Vec::new();
        let got = gather(&[u(3), u(2), u(1)], &prev, &mut |_, ns| {
            asked.push(ns.to_vec());
            Some(json!({"prs": [pr(3, "draft"), pr(2, "closed")], "missing": [], "unread": []}))
        })
        .unwrap();
        assert_eq!(asked, vec![vec![3, 2]]);
        let states: Vec<&str> = got.iter().map(|p| p["state"].as_str().unwrap()).collect();
        assert_eq!(states, vec!["draft", "closed", "merged"], "branch PR first, then made order; merged #1 carried");
    }

    #[test]
    fn a_skip_keeps_the_file_and_unread_prs_keep_their_last_read() {
        let prev = vec![pr(2, "open"), pr(3, "open")];
        assert_eq!(gather(&[u(2), u(3)], &prev, &mut |_, _| Some(json!({"skipped": "backoff"}))), None);
        assert_eq!(gather(&[u(2)], &prev, &mut |_, _| None), None, "no lookout answer: keep the file");
        let got = gather(&[u(2), u(3)], &prev, &mut |_, _| Some(json!({"prs": [pr(2, "draft")], "missing": [], "unread": [3]}))).unwrap();
        assert_eq!(got.iter().map(|p| p["state"].as_str().unwrap()).collect::<Vec<_>>(), vec!["draft", "open"]);
    }

    #[test]
    fn a_pr_github_cannot_find_drops_out() {
        let got = gather(&[u(2), u(9)], &[], &mut |_, _| Some(json!({"prs": [pr(2, "open")], "missing": [9], "unread": []}))).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(gather(&[], &[], &mut |_, _| unreachable!()), None);
    }
}
