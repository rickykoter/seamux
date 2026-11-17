//! The Radar tab: per repo, the files each workspace that isn't tucked away is
//! editing now and the files its open deep-plan says it will touch, so two
//! workspaces heading for the same file can see each other before they collide.
//!
//! Editing is the worktree's diff against where it left the base branch, plus
//! untracked files. Planned is the file list of each increment the workspace's
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
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Frame {
    pub repos: Vec<Repo>,
}

/// What git says about one worktree.
#[derive(Clone, Debug, Default)]
pub struct Tree {
    pub common: String,
    pub branch: String,
    pub editing: Vec<String>,
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
        });
    }
    let mut out: Vec<Repo> = repos
        .into_iter()
        .map(|(common, mut contacts)| {
            contacts.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
            let mut by_path: BTreeMap<&str, BTreeSet<usize>> = BTreeMap::new();
            for (i, c) in contacts.iter().enumerate() {
                for p in c.editing.iter().chain(c.planned.iter().map(|p| &p.path)) {
                    by_path.entry(p.as_str()).or_default().insert(i);
                }
            }
            let collisions = by_path.into_iter().filter(|(_, who)| who.len() > 1).map(|(p, _)| p.to_string()).collect();
            Repo { name: repo_name(&common), common, contacts, collisions }
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
        if let Some(p) = plan_of(slug, &st, spec.as_ref(), &root_of) {
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

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let mut a = vec!["-C", dir];
    a.extend_from_slice(args);
    crew_core::py::run("git", &a, Duration::from_secs(5)).filter(|(code, _, _)| *code == 0).map(|(_, out, _)| out)
}

fn lines(s: Option<String>) -> Vec<String> {
    s.unwrap_or_default().lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// Git's view of worktree `root`: its repo, branch and changed files.
pub fn read_tree(root: &str) -> Tree {
    let common = git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map(|s| s.trim().to_string()).unwrap_or_default();
    if common.is_empty() {
        return Tree::default();
    }
    let branch = git(root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    // The base: origin's default branch, else a local main or master.
    let base = git(root, &["rev-parse", "--abbrev-ref", "origin/HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "origin/HEAD")
        .or_else(|| ["main", "master"].iter().find(|b| git(root, &["rev-parse", "--verify", "--quiet", b]).is_some()).map(|b| b.to_string()));
    let fork = base.and_then(|b| git(root, &["merge-base", "HEAD", &b])).map(|s| s.trim().to_string()).unwrap_or_else(|| "HEAD".into());
    let mut editing = lines(git(root, &["diff", "--name-only", "--no-renames", &fork]));
    editing.extend(lines(git(root, &["ls-files", "--others", "--exclude-standard"])));
    Tree { common, branch, editing }
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
        trees.insert("/a".into(), Tree { common: "/r/.git".into(), branch: "dev/a".into(), editing: vec!["x.rs".into(), "y.rs".into()] });
        trees.insert("/b".into(), Tree { common: "/r/.git".into(), branch: "dev/b".into(), editing: vec!["z.rs".into()] });
        trees.insert("/c".into(), Tree { common: "/other/.git".into(), branch: "main".into(), editing: vec!["x.rs".into()] });
        let plans = vec![Plan { root: "/b".into(), planned: vec![Planned { path: "x.rs".into(), plan: "p".into(), inc: 2, title: "t".into() }] }];
        let f = assemble(&[seat("A", "/a"), seat("B", "/b"), seat("C", "/c"), seat("A2", "/a")], &trees, &plans);
        assert_eq!(f.repos.len(), 2);
        let r = &f.repos[0];
        assert_eq!(r.name, "r");
        assert_eq!(r.contacts.len(), 2, "a second pane on /a is the same contact");
        assert_eq!(r.collisions, vec!["x.rs".to_string()]);
        assert!(f.repos[1].collisions.is_empty(), "the same path in another repo is no collision");
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
