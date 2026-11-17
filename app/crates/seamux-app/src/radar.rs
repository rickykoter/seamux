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
    /// Each path on the scope to its CODEOWNERS owners ([] for none); absent
    /// when the repo has no CODEOWNERS file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owners: Option<BTreeMap<String, Vec<String>>>,
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
    /// The CODEOWNERS text this worktree's repo uses (the base branch's, else the worktree's).
    pub codeowners: Option<String>,
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
            for (i, c) in contacts.iter_mut().enumerate() {
                let mut grown = Vec::new();
                c.planned.retain(|p| {
                    if !p.path.ends_with('/') {
                        return true;
                    }
                    let under: BTreeSet<&String> = others
                        .iter()
                        .filter(|(j, _)| *j != i)
                        .flat_map(|(_, e)| e.iter())
                        .filter(|e| e.len() > p.path.len() && e.starts_with(&p.path))
                        .collect();
                    grown.extend(under.iter().map(|e| Planned { path: (*e).clone(), ..p.clone() }));
                    under.is_empty()
                });
                c.planned.extend(grown);
                c.planned.sort_by(|a, b| (&a.path, &a.plan, a.inc).cmp(&(&b.path, &b.plan, b.inc)));
                c.planned.dedup_by(|a, b| a.path == b.path && a.plan == b.plan);
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

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let mut a = vec!["-C", dir];
    a.extend_from_slice(args);
    crew_core::py::run("git", &a, Duration::from_secs(5)).filter(|(code, _, _)| *code == 0).map(|(_, out, _)| out)
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

/// Untracked files the scope takes at most: a build folder git doesn't ignore must not flood it.
pub const UNTRACKED_MAX: usize = 200;

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
    let fork = base.as_deref().and_then(|b| git(root, &["merge-base", "HEAD", b])).map(|s| s.trim().to_string()).unwrap_or_else(|| "HEAD".into());
    let mut editing = zpaths(git(root, &["diff", "--name-only", "--no-renames", "-z", &fork]));
    editing.extend(zpaths(git(root, &["ls-files", "--others", "--exclude-standard", "-z"])).into_iter().take(UNTRACKED_MAX));
    // CODEOWNERS as the base branch has it (what GitHub enforces), else the worktree's own.
    let codeowners = crate::codeowners::LOCATIONS.iter().find_map(|loc| {
        base.as_deref()
            .and_then(|b| git(root, &["show", &format!("{b}:{loc}")]))
            .or_else(|| std::fs::read_to_string(std::path::Path::new(root).join(loc)).ok())
    });
    Tree { common, branch, editing, codeowners }
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
        Tree { common: common.into(), branch: "b".into(), editing: editing.iter().map(|s| s.to_string()).collect(), codeowners: codeowners.map(str::to_string) }
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
        std::fs::create_dir_all(d.join("junk")).unwrap();
        for k in 0..UNTRACKED_MAX + 50 {
            std::fs::write(d.join(format!("junk/{k}.tmp")), "").unwrap();
        }
        let t = read_tree(root);
        assert!(t.common.ends_with(".git"), "{}", t.common);
        assert_eq!(t.branch, "dev");
        assert!(t.editing.contains(&"odd name \u{e9}.rs".to_string()), "{:?}", &t.editing[..3.min(t.editing.len())]);
        assert_eq!(t.editing.iter().filter(|p| p.starts_with("junk/")).count(), UNTRACKED_MAX);
        assert_eq!(t.codeowners.as_deref(), Some("* @base\n"));
        let _ = std::fs::remove_dir_all(&d);
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
