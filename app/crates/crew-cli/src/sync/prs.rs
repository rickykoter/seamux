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

fn ask_lookout(bin: &str, cwd: &str, repo: &str, ns: &[u64], force: bool) -> Option<Value> {
    let mut argv: Vec<String> = vec![bin.into(), "gh".into(), "prs".into(), repo.into()];
    argv.extend(ns.iter().map(u64::to_string));
    argv.extend(["--cwd".into(), cwd.into(), "--json".into()]);
    if force {
        argv.push("--force".into());
    }
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
    let Some((list, complete)) = gather(&wanted, &prev_list, &mut |repo, ns| ask_lookout(&bin, cwd, repo, ns, false)) else { return };
    write_list(cwd, &json!({"at": if complete { now } else { prev_at.unwrap_or(0.0) }, "prs": list}));
}

/// Whether a list (the file's `prs`) holds a PR that can still merge: one
/// that is open or a draft.
pub fn has_open(list: &[Value]) -> bool {
    list.iter().any(|p| matches!(p.get("state").and_then(Value::as_str), Some("open" | "draft")))
}

/// The URLs of a list's PRs that can still merge (open or a draft): what
/// the land watcher listens on.
pub fn open_urls(list: &[Value]) -> Vec<String> {
    list.iter()
        .filter(|p| matches!(p.get("state").and_then(Value::as_str), Some("open" | "draft")))
        .filter_map(|p| p.get("url").and_then(Value::as_str))
        .filter(|u| parse_url(u).is_some())
        .map(String::from)
        .collect()
}

/// The PR URLs a list holds, in its order: what refresh_known asks about.
pub fn known_urls(list: &[Value]) -> Vec<String> {
    list.iter().filter_map(|p| p.get("url").and_then(Value::as_str)).filter(|u| parse_url(u).is_some()).map(String::from).collect()
}

/// Refresh worktree `cwd`'s list from the PRs it already holds, when one of
/// them is open or a draft and the list is older than `ttl` seconds (the
/// land watcher's minute re-read, plan landing-latency). It asks about the
/// list's own PRs, since gather keeps only what it asks about: a refresh
/// without crew-sync's gh facts would drop the branch's PR. crew-sync's run
/// still adds newly made PRs: this re-read stamps `fast_at` and leaves
/// `at`, crew-sync's stamp, alone, so crew-sync's refresh still comes due
/// (review f4). `force` asks past lookout's 45s floor: the land watcher's
/// listener heard this list's PR change state. True when it wrote the list.
pub fn refresh_known(cwd: &str, ttl: i64, force: bool) -> bool {
    let now = py::now();
    let Some(prev) = crew_core::prs::read(cwd) else { return false };
    if now - last_read(&prev) < ttl as f64 {
        return false;
    }
    let prev_list: Vec<Value> = prev.get("prs").and_then(Value::as_array).cloned().unwrap_or_default();
    if !has_open(&prev_list) {
        return false;
    }
    let Some(bin) = lookout_bin() else { return false };
    let Some((list, complete)) = gather(&known_urls(&prev_list), &prev_list, &mut |repo, ns| ask_lookout(&bin, cwd, repo, ns, force)) else {
        return false;
    };
    // crew-sync may have written while lookout answered (a PR it just
    // added): its list stands, and the next tick re-reads that one.
    if !unchanged(&prev, crew_core::prs::read(cwd).as_ref()) {
        return false;
    }
    write_list(cwd, &known_body(&prev, list, complete, now))
}

/// When a list's PRs were last read, by crew-sync (`at`) or by a fast
/// re-read (`fast_at`): the later of the two, 0 for neither.
pub fn last_read(file: &Value) -> f64 {
    let at = |k: &str| file.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    at("at").max(at("fast_at"))
}

/// A fast re-read's file: crew-sync's `at` as it was, `fast_at` moved to
/// `now` only by a complete read (a partial one is retried next tick).
fn known_body(prev: &Value, list: Vec<Value>, complete: bool, now: f64) -> Value {
    let mut body = json!({"at": prev.get("at").cloned().unwrap_or(json!(0.0)), "prs": list});
    let fast = if complete { Some(json!(now)) } else { prev.get("fast_at").cloned() };
    if let Some(f) = fast {
        body["fast_at"] = f;
    }
    body
}

/// Whether the file still holds what was read before asking lookout.
fn unchanged(before: &Value, now: Option<&Value>) -> bool {
    now == Some(before)
}

/// Write `cwd`'s list whole: a temp file, then a rename, so crew-sync and
/// the app writing at once never leave half of either. The temp name is
/// this process's and this write's, so two threads never share one.
fn write_list(cwd: &str, body: &Value) -> bool {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = crew_core::prs::path(cwd);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.tmp-{}-{seq}", std::process::id()));
    let body = crew_core::pyjson::dumps(body);
    std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, &path).is_ok()
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
    fn a_merged_prs_merge_commit_is_written_as_lookout_read_it() {
        let mut merged = pr(5, "merged");
        merged["merge"] = json!({"sha": "a".repeat(40), "at": "2026-11-13T07:31:00Z", "base": "main"});
        let (got, _) = gather(&[u(5)], &[], &mut |_, _| Some(json!({"prs": [merged.clone()], "missing": [], "unread": []}))).unwrap();
        assert_eq!(got[0]["merge"], merged["merge"], "the landing watcher reads it from the file");
        assert_eq!(crew_core::prs::merge_of(&got[0]).map(|m| m.base), Some("main".to_string()));
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
    fn a_known_refresh_asks_every_pr_the_list_holds_and_keeps_them_all() {
        let prev = vec![pr(7, "open"), pr(1, "merged"), pr(3, "draft")];
        assert!(has_open(&prev));
        assert!(!has_open(&[pr(1, "merged"), pr(2, "closed")]), "nothing left to merge: no fast re-read");
        let mut asked: Vec<Vec<u64>> = Vec::new();
        let (got, complete) = gather(&known_urls(&prev), &prev, &mut |_, ns| {
            asked.push(ns.to_vec());
            Some(json!({"prs": [pr(7, "merged"), pr(3, "draft")], "missing": [], "unread": []}))
        })
        .unwrap();
        assert_eq!(asked, vec![vec![7, 3]], "the merged one is not asked again");
        assert_eq!(states(&got), vec!["merged", "merged", "draft"], "the branch PR (first) stays, in the list's order");
        assert!(complete);
    }

    #[test]
    fn a_known_refresh_waits_for_its_ttl_and_needs_an_open_pr() {
        let dir = std::env::temp_dir().join(format!("prs-known-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Lists live under a temp CREW_PRS_DIR, never the person's cache (L10),
        // and no lookout answers: CREW_LOOKOUT names a file that is not there.
        std::env::set_var("CREW_PRS_DIR", &dir);
        std::env::set_var("CREW_LOOKOUT", dir.join("no-lookout"));
        let cwd = "/tmp/prs-known-worktree";
        assert!(!refresh_known(cwd, 60, false), "no list: nothing to re-read");
        assert!(write_list(cwd, &json!({"at": py::now(), "prs": [pr(7, "open")]})));
        assert!(!refresh_known(cwd, 60, false), "younger than its ttl");
        assert!(write_list(cwd, &json!({"at": py::now() - 400.0, "fast_at": py::now(), "prs": [pr(7, "open")]})));
        assert!(!refresh_known(cwd, 60, false), "a fast re-read just ran");
        assert!(write_list(cwd, &json!({"at": py::now() - 120.0, "prs": [pr(7, "open")]})));
        assert!(!refresh_known(cwd, 60, false), "due, but with no lookout the file stands");
        assert_eq!(crew_core::prs::list(cwd).len(), 1);
        std::env::remove_var("CREW_PRS_DIR");
        std::env::remove_var("CREW_LOOKOUT");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fast_re_read_moves_fast_at_and_never_crew_syncs_at() {
        let prev = json!({"at": 1000.0, "prs": [pr(7, "open")]});
        let done = known_body(&prev, vec![pr(7, "merged")], true, 1400.0);
        assert_eq!((done["at"].as_f64(), done["fast_at"].as_f64()), (Some(1000.0), Some(1400.0)), "crew-sync's refresh still comes due at at + ttl");
        assert_eq!(last_read(&done), 1400.0);
        let part = known_body(&done, vec![pr(7, "open")], false, 1500.0);
        assert_eq!(part["fast_at"].as_f64(), Some(1400.0), "a partial read is retried next tick");
        assert_eq!(last_read(&json!({"prs": []})), 0.0);
    }

    #[test]
    fn a_list_crew_sync_wrote_meanwhile_is_not_overwritten() {
        let before = json!({"at": 1000.0, "prs": [pr(7, "open")]});
        assert!(unchanged(&before, Some(&before.clone())));
        let added = json!({"at": 1290.0, "prs": [pr(7, "open"), pr(8, "open")]});
        assert!(!unchanged(&before, Some(&added)), "crew-sync added #8: its list stands");
        assert!(!unchanged(&before, None), "the list went away: write nothing");
    }

    #[test]
    fn a_pr_github_cannot_find_drops_out() {
        let (got, _) = gather(&[u(2), u(9)], &[], &mut |_, _| Some(json!({"prs": [pr(2, "open")], "missing": [9], "unread": []}))).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(gather(&[], &[], &mut |_, _| unreachable!()), None);
    }
}
