//! `seamux workspace-open`: open a workspace for a worktree that already
//! exists, with Claude started in it, on whichever backend this machine runs
//! (cmux, or the seamux app's own tmux). It is the app's "+ New workspace"
//! form minus the worktree: deep-plan's `family open` calls it for each
//! workstream, and anyone can from a shell.
//!
//! ```text
//! seamux workspace-open <worktree> [--prompt TEXT] [--no-remote] [--if-missing] [--json]
//! ```
//!
//! `--if-missing` opens nothing when a workspace already works in that
//! worktree, and says which. Exit 0 when a workspace is open at the end
//! (made now or already there), 1 when none could be, 2 on bad arguments.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::json;

use crate::backend::Backend;
use crate::worktree::{claude_command, name_of, Settings};

/// What one call did.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// A new workspace: its ref and, when the backend knows it, its id.
    Opened { workspace: String, id: Option<String> },
    /// One was already open there (`--if-missing`).
    Already { workspace: String },
}

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub path: PathBuf,
    pub prompt: Option<String>,
    pub remote: Option<bool>,
    pub if_missing: bool,
    pub json: bool,
}

pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut path = None;
    let mut it = args.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--prompt" => a.prompt = Some(it.next().ok_or("--prompt wants the text")?.clone()),
            "--no-remote" => a.remote = Some(false),
            "--remote" => a.remote = Some(true),
            "--if-missing" => a.if_missing = true,
            "--json" => a.json = true,
            f if f.starts_with("--") => return Err(format!("unknown flag {f}")),
            p if path.is_none() => path = Some(PathBuf::from(p)),
            p => return Err(format!("one worktree only, not also {p}")),
        }
    }
    a.path = path.ok_or("which worktree? workspace-open <path>")?;
    Ok(a)
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let o = Command::new("git").arg("-C").arg(dir).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| format!("git: {e}"))?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&o.stderr).trim().lines().last().unwrap_or("git failed").to_string())
    }
}

/// The worktree's top level, its repo's primary checkout and its branch.
pub fn worktree_facts(path: &Path) -> Result<(PathBuf, PathBuf, String), String> {
    if !path.is_dir() {
        return Err(format!("no such directory: {}", path.display()));
    }
    let top = PathBuf::from(git(path, &["rev-parse", "--show-toplevel"]).map_err(|_| format!("{} is not in a git worktree", path.display()))?);
    let common = PathBuf::from(git(&top, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?);
    let repo = if common.file_name().is_some_and(|n| n == ".git") { common.parent().map(Path::to_path_buf).unwrap_or(common.clone()) } else { common };
    let branch = git(&top, &["symbolic-ref", "--short", "-q", "HEAD"]).unwrap_or_default();
    Ok((top, repo, branch))
}

fn same_dir(a: &str, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    !a.is_empty() && canon(Path::new(a)) == canon(b)
}

/// Open (or with `if_missing`, find) the workspace for worktree `top`.
pub fn open_for(b: &dyn Backend, top: &Path, cmd: &str, if_missing: bool) -> Result<Outcome, String> {
    if if_missing {
        let rows = b.workspaces()?;
        if let Some(w) = rows.iter().find(|w| same_dir(&w.cwd, top)) {
            return Ok(Outcome::Already { workspace: w.id.clone() });
        }
    }
    let (workspace, id) = b.open_workspace(top, cmd)?;
    Ok(Outcome::Opened { workspace, id })
}

pub fn main(args: &[String]) -> i32 {
    let a = match parse(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("workspace-open: {e}");
            return 2;
        }
    };
    let run = || -> Result<(Outcome, PathBuf, &'static str), String> {
        let (top, repo, branch) = worktree_facts(&a.path)?;
        let s = Settings::from_env();
        let name = a.remote.unwrap_or(s.remote).then(|| format!("{}/{}", name_of(&repo), if branch.is_empty() { name_of(&top) } else { branch.clone() }));
        let cmd = claude_command(name.as_deref(), a.prompt.as_deref());
        let (kind, b) = crate::backend::pick();
        let b = b?;
        let out = open_for(b.as_ref(), &top, &cmd, a.if_missing)?;
        Ok((out, top, kind.name()))
    };
    match run() {
        Ok((out, top, kind)) => {
            let path = top.to_string_lossy().into_owned();
            let (state, ws, id) = match &out {
                Outcome::Opened { workspace, id } => ("opened", workspace.clone(), id.clone()),
                Outcome::Already { workspace } => ("already", workspace.clone(), None),
            };
            if a.json {
                println!("{}", json!({"state": state, "workspace": ws, "id": id, "path": path, "backend": kind}));
            } else if state == "opened" {
                println!("opened {ws} for {path} ({kind})");
            } else {
                println!("already open: {ws} works in {path} ({kind})");
            }
            0
        }
        Err(e) => {
            if a.json {
                println!("{}", json!({"state": "failed", "error": e, "path": a.path.to_string_lossy()}));
            } else {
                eprintln!("workspace-open: {e}");
            }
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{Kind, PaneRow, Target, WorkspaceRow};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        rows: Vec<WorkspaceRow>,
        opened: Mutex<Vec<(PathBuf, String)>>,
    }

    impl Backend for Fake {
        fn kind(&self) -> Kind {
            Kind::Tmux
        }
        fn workspaces(&self) -> Result<Vec<WorkspaceRow>, String> {
            Ok(self.rows.clone())
        }
        fn panes(&self, _: Option<&str>) -> Result<Vec<PaneRow>, String> {
            Ok(Vec::new())
        }
        fn open_workspace(&self, cwd: &Path, cmd: &str) -> Result<(String, Option<String>), String> {
            self.opened.lock().unwrap().push((cwd.to_path_buf(), cmd.to_string()));
            Ok(("W9".into(), Some("W9".into())))
        }
        fn start_session(&self, _: &str, _: &str, _: &str) -> Result<String, String> {
            Err("unused".into())
        }
        fn target(&self, _: &str) -> Result<Option<Target>, String> {
            Ok(None)
        }
        fn close_pane(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_a_path_and_its_flags() {
        let a = parse(&s(&["/w/x", "--prompt", "hi there", "--if-missing", "--no-remote"])).unwrap();
        assert_eq!(a.path, PathBuf::from("/w/x"));
        assert_eq!(a.prompt.as_deref(), Some("hi there"));
        assert!(a.if_missing && a.remote == Some(false) && !a.json);
        assert!(parse(&s(&[])).is_err());
        assert!(parse(&s(&["/a", "/b"])).is_err());
        assert!(parse(&s(&["/a", "--prompt"])).is_err());
        assert!(parse(&s(&["/a", "--bogus"])).is_err());
    }

    #[test]
    fn opens_with_the_command_it_is_given() {
        let tmp = std::env::temp_dir().join(format!("wsopen-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = Fake::default();
        let out = open_for(&f, &tmp, "claude -- go", true).unwrap();
        assert_eq!(out, Outcome::Opened { workspace: "W9".into(), id: Some("W9".into()) });
        assert_eq!(f.opened.lock().unwrap().as_slice(), &[(tmp.clone(), "claude -- go".to_string())]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn if_missing_finds_a_workspace_already_there() {
        let tmp = std::env::temp_dir().join(format!("wsopen-there-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = Fake { rows: vec![WorkspaceRow { id: "W1".into(), title: "x".into(), cwd: tmp.to_string_lossy().into_owned() }], ..Default::default() };
        assert_eq!(open_for(&f, &tmp, "claude", true).unwrap(), Outcome::Already { workspace: "W1".into() });
        assert!(f.opened.lock().unwrap().is_empty());
        // Without --if-missing a second one opens.
        assert!(matches!(open_for(&f, &tmp, "claude", false).unwrap(), Outcome::Opened { .. }));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn worktree_facts_name_the_primary_checkout_and_branch() {
        let base = std::env::temp_dir().join(format!("wsopen-git-{}", std::process::id()));
        let main = base.join("repo");
        std::fs::create_dir_all(&main).unwrap();
        let g = |d: &Path, a: &[&str]| assert!(Command::new("git").arg("-C").arg(d).args(a).output().unwrap().status.success(), "git {a:?}");
        g(&main, &["init", "-q", "-b", "main"]);
        g(&main, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one"]);
        let wt = base.join("wt");
        g(&main, &["worktree", "add", "-q", "-b", "dev/x", wt.to_str().unwrap()]);
        let (top, repo, branch) = worktree_facts(&wt).unwrap();
        let c = |p: &Path| std::fs::canonicalize(p).unwrap();
        assert_eq!(c(&top), c(&wt));
        assert_eq!(c(&repo), c(&main));
        assert_eq!(branch, "dev/x");
        assert!(worktree_facts(&base.join("nope")).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
