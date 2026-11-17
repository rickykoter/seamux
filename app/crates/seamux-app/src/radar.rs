//! The Radar tab: per repo, the files each workspace that isn't tucked away is
//! editing now and the files its open deep-plan says it will touch, so two
//! workspaces heading for the same file can see each other before they collide.
//!
//! Editing is what the branch has committed since it left the base branch,
//! plus what `git status` shows (changed and untracked files; a new folder
//! is one "dir/" entry). Planned is the file list of each increment the workspace's
//! plan has not finished (its spec's deliverable of the same number).
//! Workspaces group into repos by git's common dir, so worktrees of one
//! checkout share a scope.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// One workspace on a repo's scope.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Contact {
    /// The cmux workspace id (the Dock jumps by it).
    pub ws: String,
    /// A pane in it, the agent's when it has one.
    pub pane: String,
    pub title: String,
    pub root: String,
    pub branch: String,
    pub color: Option<String>,
    /// The agent's state ("working", "needs_input", "idle"), or "" with none.
    pub state: String,
    /// Repo-relative paths changed since the base branch, and untracked ones.
    pub editing: Vec<String>,
    pub planned: Vec<Planned>,
    /// A git call on this worktree timed out or failed, so `editing` may be
    /// missing files: it holds the last good reading where there was one.
    pub partial: bool,
}

/// A file a plan's unfinished increment will touch.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Planned {
    pub path: String,
    pub plan: String,
    pub inc: u64,
    pub title: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Repo {
    pub name: String,
    pub common: String,
    pub contacts: Vec<Contact>,
    /// Paths two or more contacts are on, editing or planned.
    pub collisions: Vec<String>,
    /// Each path on the scope to its CODEOWNERS owners ([] for none); absent
    /// when the repo has no CODEOWNERS file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Frame {
    pub repos: Vec<Repo>,
}

/// What git says about one worktree. The last scan's Tree is handed back to
/// `read_tree`, which reuses its committed files and the base branch's
/// CODEOWNERS while HEAD and the base stay put.
#[derive(Clone, Debug, Default)]
pub struct Tree {
    pub common: String,
    pub branch: String,
    pub editing: Vec<String>,
    /// The CODEOWNERS text this worktree's repo uses (the base branch's, else the worktree's).
    pub codeowners: Option<String>,
    /// Some git call timed out or failed; see `Contact::partial`.
    pub partial: bool,
    /// HEAD and the base branch's commit the committed side was read at, set
    /// only when that read worked.
    pub key: Option<(String, String)>,
    /// Files changed between the fork point and HEAD.
    pub committed: Vec<String>,
    /// What `git status` listed: changed tracked files and untracked ones.
    pub working: Vec<String>,
    /// The base branch's CODEOWNERS, cached with `committed`.
    pub base_codeowners: Option<String>,
}

/// An open plan: its worktree and its unfinished increments' files.
#[derive(Clone, Debug)]
pub struct Plan {
    pub root: String,
    pub planned: Vec<Planned>,
}

/// A workspace as the wall sees it, reduced to what the radar needs.
#[derive(Clone, Debug)]
pub struct Seat {
    pub ws: String,
    pub pane: String,
    pub title: String,
    pub root: String,
    pub color: Option<String>,
    pub state: String,
}

/// The repo's name from its common dir: `…/seamux/.git` is "seamux".
pub fn repo_name(common: &str) -> String {
    let p = Path::new(common.trim_end_matches('/'));
    let p = if p.file_name().map(|n| n == ".git").unwrap_or(false) { p.parent().unwrap_or(p) } else { p };
    let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    n.strip_suffix(".git").map(str::to_string).unwrap_or(n)
}

/// Builds the frame from seats, git's view of each root, and open plans.
/// A seat whose root git could not read (no common dir) is left out.
pub fn assemble(seats: &[Seat], trees: &BTreeMap<String, Tree>, plans: &[Plan]) -> Frame {
    let mut repos: BTreeMap<String, Vec<Contact>> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for s in seats {
        let Some(t) = trees.get(&s.root).filter(|t| !t.common.is_empty()) else { continue };
        if !seen.insert(s.root.clone()) {
            continue;
        }
        let mut planned: Vec<Planned> = plans.iter().filter(|p| p.root == s.root).flat_map(|p| p.planned.clone()).collect();
        // Spec paths are written by hand: "./a.rs" and "/a.rs" are a.rs, the form git prints.
        for p in &mut planned {
            p.path = norm(&p.path);
        }
        planned.sort_by(|a, b| (&a.path, &a.plan, a.inc).cmp(&(&b.path, &b.plan, b.inc)));
        planned.dedup_by(|a, b| a.path == b.path && a.plan == b.plan);
        let mut editing = t.editing.clone();
        editing.sort();
        editing.dedup();
        repos.entry(t.common.clone()).or_default().push(Contact {
            ws: s.ws.clone(),
            pane: s.pane.clone(),
            title: s.title.clone(),
            root: s.root.clone(),
            branch: t.branch.clone(),
            color: s.color.clone(),
            state: s.state.clone(),
            editing,
            planned,
            partial: t.partial,
        });
    }
    let mut out: Vec<Repo> = repos
        .into_iter()
        .map(|(common, mut contacts)| {
            contacts.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
            // A planned directory ("app/ui/") meets whatever another workspace has under it: files it
            // edits, files it plans, and directories it plans inside this one ("app/" meets a
            // planned "app/ui/" there). It stands for those paths, and stays as itself when nothing
            // of anyone else's is under it, so two plans of the same directory still meet on it.
            let others: Vec<(usize, Vec<String>)> = contacts
                .iter()
                .enumerate()
                .map(|(i, c)| (i, c.editing.iter().cloned().chain(c.planned.iter().map(|p| p.path.clone())).collect()))
                .collect();
            let under = |i: usize, dir: &str| -> BTreeSet<String> {
                others
                    .iter()
                    .filter(|(j, _)| *j != i)
                    .flat_map(|(_, e)| e.iter())
                    .filter(|e| e.len() > dir.len() && e.starts_with(dir))
                    .cloned()
                    .collect()
            };
            for (i, c) in contacts.iter_mut().enumerate() {
                let mut grown = Vec::new();
                c.planned.retain(|p| {
                    if !p.path.ends_with('/') {
                        return true;
                    }
                    let u = under(i, &p.path);
                    grown.extend(u.iter().map(|e| Planned { path: e.clone(), ..p.clone() }));
                    u.is_empty()
                });
                c.planned.extend(grown);
                c.planned.sort_by(|a, b| (&a.path, &a.plan, a.inc).cmp(&(&b.path, &b.plan, b.inc)));
                c.planned.dedup_by(|a, b| a.path == b.path && a.plan == b.plan);
                // An untracked folder ("dir/", how git status lists a new one) meets what others have under it the same way.
                let mut grown = Vec::new();
                c.editing.retain(|d| {
                    if !d.ends_with('/') {
                        return true;
                    }
                    let u = under(i, d);
                    grown.extend(u.iter().cloned());
                    u.is_empty()
                });
                c.editing.extend(grown);
                c.editing.sort();
                c.editing.dedup();
            }
            let mut by_path: BTreeMap<&str, BTreeSet<usize>> = BTreeMap::new();
            for (i, c) in contacts.iter().enumerate() {
                for p in c.editing.iter().chain(c.planned.iter().map(|p| &p.path)) {
                    by_path.entry(p.as_str()).or_default().insert(i);
                }
            }
            let collisions = by_path.iter().filter(|(_, who)| who.len() > 1).map(|(p, _)| p.to_string()).collect();
            // Ownership from the first contact's worktree that has a CODEOWNERS file.
            let owners = contacts.iter().find_map(|c| trees.get(&c.root).and_then(|t| t.codeowners.as_deref())).map(|text| {
                let rules = crate::codeowners::parse(text);
                crate::codeowners::map(&rules, by_path.keys().map(|p| p.to_string()))
            });
            Repo { name: repo_name(&common), common, contacts, collisions, owners }
        })
        .collect();
    // Busiest scopes first: collisions, then contacts.
    out.sort_by(|a, b| (b.collisions.len(), b.contacts.len(), &a.name).cmp(&(a.collisions.len(), a.contacts.len(), &b.name)));
    Frame { repos: out }
}

/// The open plans in deep-plan's state dir, with each unfinished increment's
/// files from the archived spec in `keys`. Closed and done plans are left out.
pub fn read_plans(state_dir: &Path, keys_dir: &Path, root_of: impl Fn(&str) -> String) -> Vec<Plan> {
    let Ok(rd) = std::fs::read_dir(state_dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(slug) = name.strip_suffix(".json") else { continue };
        if slug.contains('.') {
            continue;
        }
        let Some(st) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let spec = std::fs::read_to_string(keys_dir.join(format!("{slug}.spec.json"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        if let Some(mut p) = plan_of(slug, &st, spec.as_ref(), &root_of) {
            // A spec may name a directory without its trailing "/": the worktree says which it is.
            for f in &mut p.planned {
                f.path = dir_slash(Path::new(&p.root), &f.path);
            }
            out.push(p);
        }
    }
    out
}

/// One plan from its state and spec, or None when it is closed, done or has no root.
pub fn plan_of(slug: &str, st: &Value, spec: Option<&Value>, root_of: &impl Fn(&str) -> String) -> Option<Plan> {
    let phase = st.get("phase").and_then(Value::as_str).unwrap_or("");
    if matches!(phase, "closed" | "done") {
        return None;
    }
    let root = st.get("root").and_then(Value::as_str).filter(|r| !r.is_empty())?;
    let deliverables = spec.and_then(|s| s.get("deliverables")).and_then(Value::as_array);
    let mut planned = Vec::new();
    for inc in st.get("increments").and_then(Value::as_array).into_iter().flatten() {
        if inc.get("status").and_then(Value::as_str) == Some("done") {
            continue;
        }
        let Some(n) = inc.get("n").and_then(Value::as_u64).filter(|n| *n > 0) else { continue };
        let title = inc.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(d) = deliverables.and_then(|ds| ds.get(n as usize - 1)) else { continue };
        for f in d.get("files").and_then(Value::as_array).into_iter().flatten() {
            let path = f.as_str().or_else(|| f.get("path").and_then(Value::as_str)).unwrap_or("").trim();
            if !path.is_empty() {
                planned.push(Planned { path: path.to_string(), plan: slug.to_string(), inc: n, title: title.clone() });
            }
        }
    }
    Some(Plan { root: root_of(root), planned })
}

/// How one git call ended: its output, a non-zero exit (an answer, like "no such file"),
/// or no answer at all (killed at the timeout, or git would not start).
enum Git {
    Out(String),
    Failed,
    Lost,
}

/// Each git call's limit; a call past it is killed and its worktree marked partial.
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Runs git in `dir`. `--no-optional-locks` keeps `git status` from writing the
/// index in the background, which would race the person's own `git add` for index.lock.
fn git_run(dir: &str, args: &[&str]) -> Git {
    let mut a = vec!["--no-optional-locks", "-C", dir];
    a.extend_from_slice(args);
    match crew_core::py::run("git", &a, GIT_TIMEOUT) {
        Some((0, out, _)) => Git::Out(out),
        Some(_) => Git::Failed,
        None => Git::Lost,
    }
}

fn git(dir: &str, args: &[&str]) -> Option<String> {
    match git_run(dir, args) {
        Git::Out(s) => Some(s),
        _ => None,
    }
}

/// `path` with a trailing "/" when it names a directory under `root`, so it is matched as one.
pub fn dir_slash(root: &Path, path: &str) -> String {
    let clean = norm(path);
    if !clean.is_empty() && !clean.ends_with('/') && root.join(&clean).is_dir() {
        format!("{clean}/")
    } else {
        clean
    }
}

/// A repo-relative path as git prints it: no "./" or leading "/".
fn norm(p: &str) -> String {
    let mut p = p.trim();
    while let Some(rest) = p.strip_prefix("./") {
        p = rest;
    }
    p.trim_start_matches('/').to_string()
}

/// NUL-separated paths (`git … -z`): exact bytes, so spaces, quotes and non-ASCII survive.
fn zpaths(s: Option<String>) -> Vec<String> {
    s.unwrap_or_default().split('\0').filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// Untracked entries the scope takes at most: a build folder git doesn't ignore must not flood it.
pub const UNTRACKED_MAX: usize = 200;

/// The paths in `git status --porcelain=v1 -z --no-renames` output: changed tracked
/// files, then at most UNTRACKED_MAX untracked ones (a new folder is one "dir/").
pub fn status_paths(s: &str) -> Vec<String> {
    let (mut tracked, mut untracked) = (Vec::new(), Vec::new());
    for e in s.split('\0') {
        // "XY path": two ASCII status letters and a space.
        let Some(path) = e.get(3..).filter(|p| !p.is_empty()) else { continue };
        match &e[..2] {
            "??" => untracked.push(path.to_string()),
            "!!" => {}
            _ => tracked.push(path.to_string()),
        }
    }
    tracked.extend(untracked.into_iter().take(UNTRACKED_MAX));
    tracked
}

/// The base branch from `for-each-ref` rows (refname, commit, symref, NUL-separated):
/// origin's default branch, else a local main or master. Its short name and commit.
pub fn pick_base(refs: &str) -> Option<(String, String)> {
    let rows: Vec<Vec<&str>> = refs.lines().map(|l| l.split('\0').collect()).collect();
    let find = |name: &str| rows.iter().find(|r| r.first() == Some(&name)).cloned();
    if let Some(r) = find("refs/remotes/origin/HEAD") {
        if let (Some(sha), Some(short)) = (r.get(1).filter(|s| !s.is_empty()), r.get(2).and_then(|s| s.strip_prefix("refs/remotes/"))) {
            return Some((short.to_string(), sha.to_string()));
        }
    }
    ["main", "master"].iter().find_map(|b| {
        let r = find(&format!("refs/heads/{b}"))?;
        r.get(1).filter(|s| !s.is_empty()).map(|sha| (b.to_string(), sha.to_string()))
    })
}

/// Git's view of worktree `root`: its repo, branch and changed files. `prev` is
/// the last scan's reading of it: while HEAD and the base branch haven't moved
/// its committed files and CODEOWNERS are reused, so an unchanged worktree
/// costs three quick calls (rev-parse, for-each-ref, and a status that
/// fsmonitor and the untracked cache make cheap where they are on). A call
/// that gets no answer leaves the last reading's part in place and marks the
/// tree partial.
pub fn read_tree(root: &str, prev: Option<&Tree>) -> Tree {
    let mut partial = false;
    let (common, head, branch) = match git_run(root, &["rev-parse", "--path-format=absolute", "--git-common-dir", "HEAD", "--abbrev-ref", "HEAD"]) {
        Git::Out(s) => {
            let mut l = s.lines().map(|x| x.trim().to_string());
            (l.next().unwrap_or_default(), l.next().unwrap_or_default(), l.next().unwrap_or_default())
        }
        Git::Lost => {
            if let Some(p) = prev {
                return Tree { partial: true, ..p.clone() };
            }
            // No last reading: the repo alone, if git can name it, so the workspace stays on the scope marked partial.
            let common = git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map(|s| s.trim().to_string()).unwrap_or_default();
            return if common.is_empty() { Tree::default() } else { Tree { common, partial: true, ..Default::default() } };
        }
        // A branch with no commit yet has no HEAD to name: the repo alone.
        Git::Failed => {
            let common = git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map(|s| s.trim().to_string()).unwrap_or_default();
            (common, String::new(), String::new())
        }
    };
    if common.is_empty() {
        return Tree::default();
    }
    let base = match git_run(root, &["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"]) {
        Git::Out(s) => pick_base(&s),
        Git::Lost => {
            partial = true;
            None
        }
        Git::Failed => None,
    };

    // The committed side: files changed from the fork point to HEAD, and the base's CODEOWNERS.
    let (mut committed, mut base_codeowners, mut key) = (Vec::new(), None, None);
    if partial {
        // The base went unread: keep the last reading's committed side.
        if let Some(p) = prev {
            committed = p.committed.clone();
            base_codeowners = p.base_codeowners.clone();
        }
    }
    if let Some((_, sha)) = &base {
        let want = (head.clone(), sha.clone());
        if let Some(p) = prev.filter(|p| p.key.as_ref() == Some(&want)) {
            committed = p.committed.clone();
            base_codeowners = p.base_codeowners.clone();
            key = Some(want);
        } else {
            let mut lost = false;
            match git_run(root, &["merge-base", "HEAD", sha]) {
                Git::Out(fork) => match git_run(root, &["diff", "--name-only", "--no-renames", "-z", fork.trim(), "HEAD"]) {
                    Git::Out(s) => committed = zpaths(Some(s)),
                    Git::Lost => lost = true,
                    Git::Failed => {}
                },
                Git::Lost => lost = true,
                // No HEAD yet, or no history shared with the base: nothing committed to count.
                Git::Failed => {}
            }
            // CODEOWNERS as the base branch has it: what GitHub enforces.
            for loc in crate::codeowners::LOCATIONS {
                match git_run(root, &["show", &format!("{sha}:{loc}")]) {
                    Git::Out(s) => {
                        base_codeowners = Some(s);
                        break;
                    }
                    Git::Lost => {
                        lost = true;
                        break;
                    }
                    Git::Failed => {}
                }
            }
            if lost {
                // Keep the last reading's and ask again next scan.
                partial = true;
                if let Some(p) = prev {
                    committed = p.committed.clone();
                    base_codeowners = p.base_codeowners.clone();
                }
            } else {
                key = Some(want);
            }
        }
    }

    let working = match git_run(root, &["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames"]) {
        Git::Out(s) => status_paths(&s),
        _ => {
            partial = true;
            prev.map(|p| p.working.clone()).unwrap_or_default()
        }
    };
    // The worktree's own CODEOWNERS when the base has none.
    let codeowners = base_codeowners
        .clone()
        .or_else(|| crate::codeowners::LOCATIONS.iter().find_map(|loc| std::fs::read_to_string(Path::new(root).join(loc)).ok()));
    let editing = committed.iter().chain(&working).cloned().collect();
    Tree { common, branch, editing, codeowners, partial, key, committed, working, base_codeowners }
}

/// Worktrees `scan` reads at once. One thread per worktree had thirty git runs
/// fighting over the disk until each outlasted its timeout.
pub const SCAN_WORKERS: usize = 6;

/// Reads every root with `workers` threads, each handed its last reading from `prev`.
pub fn scan(roots: &[String], prev: &BTreeMap<String, Tree>, workers: usize) -> BTreeMap<String, Tree> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    let next = AtomicUsize::new(0);
    let out = Mutex::new(BTreeMap::new());
    std::thread::scope(|sc| {
        for _ in 0..workers.clamp(1, roots.len().max(1)) {
            sc.spawn(|| {
                while let Some(r) = roots.get(next.fetch_add(1, Ordering::Relaxed)) {
                    let t = read_tree(r, prev.get(r));
                    out.lock().unwrap_or_else(|e| e.into_inner()).insert(r.clone(), t);
                }
            });
        }
    });
    out.into_inner().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seat(ws: &str, root: &str) -> Seat {
        Seat { ws: ws.into(), pane: format!("{ws}-p"), title: ws.into(), root: root.into(), color: None, state: String::new() }
    }

    #[test]
    fn radar_repo_name_strips_dot_git() {
        assert_eq!(repo_name("/u/code/seamux/.git"), "seamux");
        assert_eq!(repo_name("/u/code/bare.git"), "bare");
        assert_eq!(repo_name("/u/code/seamux/.git/"), "seamux");
    }

    #[test]
    fn radar_groups_worktrees_by_repo_and_finds_collisions() {
        let mut trees = BTreeMap::new();
        trees.insert("/a".into(), Tree { common: "/r/.git".into(), branch: "dev/a".into(), editing: vec!["x.rs".into(), "y.rs".into()], ..Default::default() });
        trees.insert("/b".into(), Tree { common: "/r/.git".into(), branch: "dev/b".into(), editing: vec!["z.rs".into()], ..Default::default() });
        trees.insert("/c".into(), Tree { common: "/other/.git".into(), branch: "main".into(), editing: vec!["x.rs".into()], ..Default::default() });
        let plans = vec![Plan { root: "/b".into(), planned: vec![Planned { path: "x.rs".into(), plan: "p".into(), inc: 2, title: "t".into() }] }];
        let f = assemble(&[seat("A", "/a"), seat("B", "/b"), seat("C", "/c"), seat("A2", "/a")], &trees, &plans);
        assert_eq!(f.repos.len(), 2);
        let r = &f.repos[0];
        assert_eq!(r.name, "r");
        assert_eq!(r.contacts.len(), 2, "a second pane on /a is the same contact");
        assert_eq!(r.collisions, vec!["x.rs".to_string()]);
        assert!(f.repos[1].collisions.is_empty(), "the same path in another repo is no collision");
    }

    fn tree(common: &str, editing: &[&str], codeowners: Option<&str>) -> Tree {
        Tree { common: common.into(), branch: "b".into(), editing: editing.iter().map(|s| s.to_string()).collect(), codeowners: codeowners.map(str::to_string), ..Default::default() }
    }
    fn plan(root: &str, paths: &[&str]) -> Plan {
        Plan { root: root.into(), planned: paths.iter().map(|p| Planned { path: p.to_string(), plan: "p".into(), inc: 1, title: "t".into() }).collect() }
    }

    #[test]
    fn radar_planned_paths_are_normalized_before_matching() {
        let mut trees = BTreeMap::new();
        trees.insert("/a".into(), tree("/r/.git", &["src/x.rs"], None));
        trees.insert("/b".into(), tree("/r/.git", &[], None));
        let f = assemble(&[seat("A", "/a"), seat("B", "/b")], &trees, &[plan("/b", &["./src/x.rs"])]);
        assert_eq!(f.repos[0].collisions, vec!["src/x.rs".to_string()]);
    }

    #[test]
    fn radar_planned_directory_meets_files_edited_under_it() {
        let mut trees = BTreeMap::new();
        trees.insert("/a".into(), tree("/r/.git", &["app/ui/tabs.ts", "docs/x.md"], None));
        trees.insert("/b".into(), tree("/r/.git", &[], None));
        trees.insert("/c".into(), tree("/r/.git", &[], None));
        let f = assemble(&[seat("A", "/a"), seat("B", "/b"), seat("C", "/c")], &trees, &[plan("/b", &["app/ui/"]), plan("/c", &["lib/"])]);
        let r = &f.repos[0];
        assert_eq!(r.collisions, vec!["app/ui/tabs.ts".to_string()]);
        let c = r.contacts.iter().find(|c| c.ws == "C").unwrap();
        assert_eq!(c.planned[0].path, "lib/", "a directory nobody edits under stays as itself");
    }

    #[test]
    fn radar_planned_directory_meets_planned_files_and_directories() {
        let mut trees = BTreeMap::new();
        for r in ["/a", "/b", "/c", "/d"] {
            trees.insert(r.into(), tree("/r/.git", &[], None));
        }
        let seats = [seat("A", "/a"), seat("B", "/b"), seat("C", "/c"), seat("D", "/d")];
        // A plans a folder, B plans a file in it: they meet on the file.
        let f = assemble(&seats[..2], &trees, &[plan("/a", &["app/ui/"]), plan("/b", &["app/ui/tabs.ts"])]);
        assert_eq!(f.repos[0].collisions, vec!["app/ui/tabs.ts".to_string()]);
        // C plans app/ and D plans app/ui/: they meet on the narrower folder.
        let f = assemble(&seats[2..], &trees, &[plan("/c", &["app/"]), plan("/d", &["app/ui/"])]);
        assert_eq!(f.repos[0].collisions, vec!["app/ui/".to_string()]);
        // Two plans of the same folder meet on it.
        let f = assemble(&seats[..2], &trees, &[plan("/a", &["lib/"]), plan("/b", &["lib/"])]);
        assert_eq!(f.repos[0].collisions, vec!["lib/".to_string()]);
    }

    #[test]
    fn radar_dir_slash_marks_real_directories() {
        let d = std::env::temp_dir().join(format!("seamux-radar-dirs-{}", std::process::id()));
        std::fs::create_dir_all(d.join("app/ui")).unwrap();
        std::fs::write(d.join("app/ui/tabs.ts"), "").unwrap();
        assert_eq!(dir_slash(&d, "app/ui"), "app/ui/");
        assert_eq!(dir_slash(&d, "./app/ui/"), "app/ui/");
        assert_eq!(dir_slash(&d, "app/ui/tabs.ts"), "app/ui/tabs.ts");
        assert_eq!(dir_slash(&d, "not/there"), "not/there");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn radar_owners_come_from_codeowners() {
        let mut trees = BTreeMap::new();
        trees.insert("/a".into(), tree("/r/.git", &["app/x.ts", "README.md"], Some("* @all\n/app/ @web\n")));
        trees.insert("/o".into(), tree("/o/.git", &["y"], None));
        let f = assemble(&[seat("A", "/a"), seat("O", "/o")], &trees, &[]);
        let r = f.repos.iter().find(|r| r.name == "r").unwrap();
        let o = r.owners.as_ref().unwrap();
        assert_eq!(o["app/x.ts"], vec!["@web".to_string()]);
        assert_eq!(o["README.md"], vec!["@all".to_string()]);
        assert!(f.repos.iter().find(|r| r.name == "o").unwrap().owners.is_none(), "no CODEOWNERS, no owners");
    }

    #[test]
    fn radar_zpaths_keep_odd_names() {
        assert_eq!(zpaths(Some("a b.rs\0caf\u{e9}.md\0".into())), vec!["a b.rs".to_string(), "caf\u{e9}.md".to_string()]);
        assert_eq!(norm("././x/y"), "x/y");
        assert_eq!(norm("/x"), "x");
    }

    #[test]
    fn radar_read_tree_on_a_real_repo() {
        let d = std::env::temp_dir().join(format!("seamux-radar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".github")).unwrap();
        let root = d.to_str().unwrap();
        let sh = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(root).args(args).output().unwrap().status.success(), "{args:?}");
        sh(&["init", "-q", "-b", "main"]);
        sh(&["config", "user.email", "t@t"]);
        sh(&["config", "user.name", "t"]);
        std::fs::write(d.join(".github/CODEOWNERS"), "* @base\n").unwrap();
        std::fs::write(d.join("a.rs"), "1").unwrap();
        sh(&["add", "-A"]);
        sh(&["commit", "-q", "-m", "base"]);
        sh(&["checkout", "-q", "-b", "dev"]);
        // The worktree's CODEOWNERS differs: the base branch's is the one read.
        std::fs::write(d.join(".github/CODEOWNERS"), "* @branch\n").unwrap();
        std::fs::write(d.join("odd name \u{e9}.rs"), "x").unwrap();
        sh(&["add", "-A"]);
        sh(&["commit", "-q", "-m", "dev"]);
        // A new folder is one entry; loose untracked files are capped.
        std::fs::create_dir_all(d.join("junk")).unwrap();
        std::fs::write(d.join("junk/0.tmp"), "").unwrap();
        for k in 0..UNTRACKED_MAX + 50 {
            std::fs::write(d.join(format!("u{k}.tmp")), "").unwrap();
        }
        // An edit not yet committed counts too.
        std::fs::write(d.join("a.rs"), "2").unwrap();
        let t = read_tree(root, None);
        assert!(t.common.ends_with(".git"), "{}", t.common);
        assert_eq!(t.branch, "dev");
        assert!(!t.partial);
        assert!(t.editing.contains(&"odd name \u{e9}.rs".to_string()), "{:?}", &t.editing[..3.min(t.editing.len())]);
        assert!(t.editing.contains(&"a.rs".to_string()));
        assert!(t.editing.contains(&"junk/".to_string()));
        assert!(!t.editing.iter().any(|p| p.starts_with("junk/0")));
        assert_eq!(t.editing.iter().filter(|p| p.ends_with(".tmp")).count(), UNTRACKED_MAX - 1, "junk/ takes one of the untracked slots");
        assert_eq!(t.codeowners.as_deref(), Some("* @base\n"));
        assert!(t.key.is_some(), "a full read is cached");

        // HEAD unmoved: the committed side comes from the last reading, not git.
        let mut fake = t.clone();
        fake.committed = vec!["from-cache.rs".into()];
        let again = read_tree(root, Some(&fake));
        assert!(again.editing.contains(&"from-cache.rs".to_string()));
        assert!(!again.editing.contains(&"odd name \u{e9}.rs".to_string()));
        // A commit moves HEAD: the committed side is read again.
        sh(&["add", "a.rs"]);
        sh(&["commit", "-q", "-m", "a"]);
        let moved = read_tree(root, Some(&fake));
        assert!(!moved.editing.contains(&"from-cache.rs".to_string()));
        assert!(moved.editing.contains(&"odd name \u{e9}.rs".to_string()) && moved.editing.contains(&"a.rs".to_string()));

        // The bounded scan reads every root, with a worker count that doesn't divide it evenly.
        let roots: Vec<String> = vec![root.to_string(), "/nowhere/at/all".into(), root.to_string()];
        let all = scan(&roots, &BTreeMap::new(), 2);
        assert_eq!(all.len(), 2);
        assert!(all["/nowhere/at/all"].common.is_empty());
        assert_eq!(all[root].branch, "dev");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn radar_status_paths_and_base() {
        let s = " M a.rs\0M  b.rs\0D  gone.rs\0?? new/\0?? x y.rs\0!! ignored\0";
        assert_eq!(status_paths(s), vec!["a.rs", "b.rs", "gone.rs", "new/", "x y.rs"]);
        assert!(status_paths("").is_empty());
        let refs = "refs/heads/master\0aaa\0\nrefs/remotes/origin/HEAD\0bbb\0refs/remotes/origin/main\n";
        assert_eq!(pick_base(refs), Some(("origin/main".into(), "bbb".into())));
        assert_eq!(pick_base("refs/heads/master\0aaa\0\n"), Some(("master".into(), "aaa".into())));
        assert_eq!(pick_base("refs/heads/main\0m\0\nrefs/heads/master\0aaa\0\n"), Some(("main".into(), "m".into())));
        assert_eq!(pick_base(""), None);
    }

    #[test]
    fn radar_untracked_folder_meets_files_under_it() {
        let mut trees = BTreeMap::new();
        trees.insert("/a".into(), tree("/r/.git", &["app/new/"], None));
        trees.insert("/b".into(), tree("/r/.git", &["app/new/x.rs"], None));
        trees.insert("/c".into(), tree("/r/.git", &["lib/"], None));
        let f = assemble(&[seat("A", "/a"), seat("B", "/b"), seat("C", "/c")], &trees, &[]);
        let r = &f.repos[0];
        assert_eq!(r.collisions, vec!["app/new/x.rs".to_string()]);
        assert_eq!(r.contacts.iter().find(|c| c.ws == "C").unwrap().editing, vec!["lib/".to_string()]);
    }

    #[test]
    fn radar_partial_reaches_the_contact() {
        let mut trees = BTreeMap::new();
        trees.insert("/a".into(), Tree { partial: true, ..tree("/r/.git", &["x"], None) });
        let f = assemble(&[seat("A", "/a")], &trees, &[]);
        assert!(f.repos[0].contacts[0].partial);
    }

    #[test]
    fn radar_skips_roots_git_cannot_read() {
        let trees = BTreeMap::new();
        assert!(assemble(&[seat("A", "/nowhere")], &trees, &[]).repos.is_empty());
    }

    #[test]
    fn radar_plan_takes_unfinished_increments_files() {
        let st = json!({"phase": "delivery", "root": "/w", "increments": [
            {"n": 1, "title": "one", "status": "done"},
            {"n": 2, "title": "two", "status": "pending"},
        ]});
        let spec = json!({"deliverables": [{"files": ["a.rs"]}, {"files": ["b.rs", {"path": "c.rs", "change": "remove"}]}]});
        let p = plan_of("s", &st, Some(&spec), &|r: &str| r.to_string()).unwrap();
        let paths: Vec<_> = p.planned.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, vec!["b.rs", "c.rs"]);
        assert_eq!(p.planned[0].inc, 2);
        let closed = json!({"phase": "closed", "root": "/w"});
        assert!(plan_of("s", &closed, Some(&spec), &|r: &str| r.to_string()).is_none());
    }
}
