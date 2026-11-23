//! `seamux bosun dispatch <repo> <branch> --brief-text TEXT`: hand work found in
//! the Bosun to a new workspace. It is the New workspace form's steps
//! (worktree::create) on the app's tmux backend, with the brief as Claude's
//! first message.
//!
//! It is the one command the Bosun's settings let out of the sandbox, and an
//! ask rule makes the person approve every run (the bosun plan's decision).
//! The brief is given inline, never as a file, so the permission prompt
//! shows the person the whole first message they are approving: the Bosun
//! writes it after reading untrusted text, and the new session runs with the
//! person's own permissions.

use std::path::Path;

use serde_json::{json, Value};

use crate::backend::Backend;
use crate::worktree::{self, Request, Settings};

/// What the CLI was asked for.
#[derive(Debug, Default, PartialEq)]
pub struct Args {
    pub repo: String,
    pub branch: String,
    pub brief: String,
    pub json: bool,
}

pub fn parse(args: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut words = Vec::new();
    let mut it = args.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--brief-text" => a.brief = it.next().ok_or("--brief-text wants the brief")?.clone(),
            "--brief" => return Err("--brief <file> is gone: pass the brief inline with --brief-text, so the person sees it in the prompt".into()),
            "--json" => a.json = true,
            f if f.starts_with("--") => return Err(format!("unknown flag {f}")),
            w => words.push(w.to_string()),
        }
    }
    match words.as_slice() {
        [repo, branch] => {
            a.repo = repo.clone();
            a.branch = branch.clone();
        }
        _ => return Err("dispatch <repo> <branch> --brief-text TEXT".into()),
    }
    if a.brief.trim().is_empty() {
        return Err("--brief-text TEXT: the new session's first message".into());
    }
    Ok(a)
}

/// Make the worktree and open its workspace with the brief: {path, branch, workspace}.
pub fn run(a: &Args) -> Result<Value, String> {
    let brief = a.brief.clone();
    let s = Settings::from_env();
    let r = Request { repo: a.repo.clone(), branch: a.branch.clone(), prompt: Some(brief), ..Default::default() };
    let t = crate::backend::tmux::TmuxBackend::default();
    let open = |cwd: &Path, cmd: &str| t.open_workspace(cwd, cmd);
    let made = worktree::create(&s, &r, &open, &mut |step, phase, note| {
        eprintln!("dispatch: {} {phase:?}{}", step.key(), if note.is_empty() { String::new() } else { format!(": {note}") });
    })?;
    Ok(json!({"path": made.path.to_string_lossy(), "branch": made.branch, "workspace": made.workspace_id.unwrap_or(made.workspace_ref)}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn it_takes_a_repo_a_branch_and_a_brief() {
        let a = parse(&v(&["shop", "fix-x", "--json", "--brief-text", "From the Bosun, log a1.\nDo x."])).unwrap();
        assert_eq!((a.repo.as_str(), a.branch.as_str(), a.brief.as_str(), a.json), ("shop", "fix-x", "From the Bosun, log a1.\nDo x.", true));
        assert!(parse(&v(&["shop", "fix-x"])).is_err(), "no brief");
        assert!(parse(&v(&["shop", "fix-x", "--brief", "/t/b.md"])).is_err(), "a brief file is refused: the prompt must show it");
        assert!(parse(&v(&["shop", "--brief-text", "b"])).is_err(), "no branch");
        assert!(parse(&v(&["shop", "x", "--brief-text", "b", "--nope"])).is_err());
    }
}
