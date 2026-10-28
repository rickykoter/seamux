//! A new worktree opened as a cmux workspace with Claude running, made with
//! no terminal: crew-worktree's steps (crew/bin/crew-worktree), for the app.
//!
//! Every input is given up front, so nothing here ever reads stdin. Each step
//! is reported as it starts and ends, so a caller can show progress. A step
//! that fails stops the rest and leaves what was already made (a worktree
//! that was added stays, and the error names it).
//!
//! The rules match the script's: repos are primary checkouts under the code
//! root (`.git` a directory, so a worktree is never a base), worktrees go in
//! `<repo>.worktrees/<branch without its owner prefix>`, a branch without a
//! `/` gets the prefix, and an existing branch is checked out, not made.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::py::{env_or, home};

/// Where repos are and how branches are named: the script's environment.
#[derive(Clone, Debug)]
pub struct Settings {
    /// CREW_CODE_ROOT, else ~/code.
    pub code_root: PathBuf,
    /// The monolith (CREW_MONOLITH, else the one `crew apply` baked into the
    /// installed crew-worktree), listed first.
    pub monolith: Option<PathBuf>,
    /// CREW_WORKTREES: the monolith's worktree dir, when set.
    pub monolith_trees: Option<PathBuf>,
    /// CREW_BRANCH_PREFIX, else `dev/`.
    pub prefix: String,
    /// CREW_REMOTE (default on): Claude starts with Remote Control.
    pub remote: bool,
    /// The installed crew bin dir, for crew-sandbox.
    pub bin: PathBuf,
}

impl Settings {
    pub fn from_env() -> Settings {
        let bin = crate::crew_home().join("bin");
        let monolith = env_or("CREW_MONOLITH").map(PathBuf::from).or_else(|| baked_monolith(&bin.join("crew-worktree")));
        Settings {
            code_root: env_or("CREW_CODE_ROOT").map(PathBuf::from).unwrap_or_else(|| home().join("code")),
            monolith,
            monolith_trees: env_or("CREW_WORKTREES").map(PathBuf::from),
            prefix: env_or("CREW_BRANCH_PREFIX").unwrap_or_else(|| "dev/".into()),
            remote: env_or("CREW_REMOTE").is_none_or(|v| v == "1"),
            bin,
        }
    }
}

/// The monolith `crew apply` wrote into the installed script, if it did.
fn baked_monolith(script: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(script).ok()?;
    let v = text.lines().find_map(|l| l.trim().strip_prefix("MONOLITH=\"${CREW_MONOLITH:-")?.strip_suffix("}\""))?;
    (v.starts_with('/') && !v.contains("__MAIN_REPO__")).then(|| PathBuf::from(v))
}

/// A primary checkout: `.git` is a directory (a worktree's is a file).
pub fn is_repo(p: &Path) -> bool {
    p.join(".git").is_dir()
}

/// A repo the form can offer.
#[derive(Clone, Debug, PartialEq)]
pub struct Repo {
    pub name: String,
    pub path: PathBuf,
    /// The branch a new worktree starts from by default.
    pub base: String,
}

/// Every primary checkout under the code root, the monolith first, then by name.
pub fn repos(s: &Settings) -> Vec<Repo> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&s.code_root)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| is_repo(p)).collect())
        .unwrap_or_default();
    paths.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    if let Some(m) = s.monolith.as_ref().filter(|m| is_repo(m)) {
        paths.retain(|p| p != m);
        paths.insert(0, m.clone());
    }
    paths.into_iter().map(|p| Repo { name: name_of(&p), base: default_base(&p), path: p }).collect()
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let o = Command::new("git").arg("-C").arg(repo).args(args).stdin(std::process::Stdio::null()).output().map_err(|e| format!("git: {e}"))?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&o.stderr);
        let err = err.trim();
        Err(if err.is_empty() { format!("git {} failed", args.join(" ")) } else { err.lines().last().unwrap_or(err).to_string() })
    }
}

/// origin/HEAD, else origin/main, else origin/master.
pub fn default_base(repo: &Path) -> String {
    if let Ok(h) = git(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) {
        if !h.is_empty() {
            return h;
        }
    }
    for b in ["origin/main", "origin/master"] {
        if git(repo, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/{b}")]).is_ok() {
            return b.into();
        }
    }
    "origin/master".into()
}

/// How Claude is set up inside a sandbox (crew-sandbox's --claude=).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SandboxMode {
    Link,
    Isolated,
}

impl SandboxMode {
    pub fn parse(s: &str) -> Result<SandboxMode, String> {
        match s {
            "link" => Ok(SandboxMode::Link),
            "isolated" => Ok(SandboxMode::Isolated),
            _ => Err(format!("sandbox must be 'link' or 'isolated' (got {s:?})")),
        }
    }
    fn flag(self) -> &'static str {
        match self {
            SandboxMode::Link => "--claude=link",
            SandboxMode::Isolated => "--claude=isolated",
        }
    }
}

/// What to make.
#[derive(Clone, Debug, Default)]
pub struct Request {
    /// A repo name under the code root, or an absolute path.
    pub repo: String,
    /// `dev/foo`, `foo` (gets the prefix), or a bare ticket.
    pub branch: String,
    /// The start point; the repo's default base when empty.
    pub base: Option<String>,
    /// Claude's first message, when given.
    pub prompt: Option<String>,
    pub sandbox: Option<SandboxMode>,
    /// Remote Control; the settings' default when not given.
    pub remote: Option<bool>,
}

/// Where it goes, worked out before anything is made.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub repo: PathBuf,
    pub trees: PathBuf,
    /// Fully qualified, prefix and all.
    pub branch: String,
    pub base: String,
    pub path: PathBuf,
    /// The branch is there already: it is checked out, not made.
    pub existing: bool,
}

/// Resolve a request into a plan, refusing what the script would refuse.
pub fn plan(s: &Settings, r: &Request) -> Result<Plan, String> {
    let want = r.repo.trim();
    if want.is_empty() {
        return Err("no repo given".into());
    }
    let repo = if want.starts_with('/') {
        PathBuf::from(want)
    } else if let Some(rest) = want.strip_prefix("~/") {
        home().join(rest)
    } else if want.contains('/') {
        return Err(format!("not a repo name or an absolute path: {want}"));
    } else {
        s.code_root.join(want)
    };
    if !is_repo(&repo) {
        return Err(format!("not a git checkout: {}", repo.display()));
    }
    let branch = r.branch.trim();
    if branch.is_empty() {
        return Err("no branch given".into());
    }
    let full = if branch.contains('/') { branch.to_string() } else { format!("{}{branch}", s.prefix) };
    if git(&repo, &["check-ref-format", "--branch", &full]).is_err() {
        return Err(format!("not a valid branch name: {full}"));
    }
    let trees = match (&s.monolith, &s.monolith_trees) {
        (Some(m), Some(t)) if *m == repo => t.clone(),
        _ => PathBuf::from(format!("{}.worktrees", repo.display())),
    };
    // The directory is the branch without its owner prefix.
    let dir = full.split_once('/').map(|(_, d)| d).unwrap_or(&full);
    let path = trees.join(dir);
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    let base = r.base.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string).unwrap_or_else(|| default_base(&repo));
    let existing = git(&repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{full}")]).is_ok();
    Ok(Plan { repo, trees, branch: full, base, path, existing })
}

/// `s` as one shell word.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+=:".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The workspace's command: Claude (named for Remote Control, opening with
/// the prompt), or crew-sandbox's attach when sandboxed.
pub fn command(s: &Settings, p: &Plan, r: &Request) -> String {
    if r.sandbox.is_some() {
        return format!("{} attach {}", sh_quote(&s.bin.join("crew-sandbox").to_string_lossy()), sh_quote(&p.path.to_string_lossy()));
    }
    let mut cmd = String::from("claude");
    if r.remote.unwrap_or(s.remote) {
        // An optional-value flag: the name is always given, so the prompt
        // after it is never taken for the name.
        cmd.push_str(&format!(" --remote-control {}", sh_quote(&format!("{}/{}", name_of(&p.repo), p.branch))));
    }
    if let Some(text) = r.prompt.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        // `--` ends the options: a prompt that starts with `-` stays a prompt.
        cmd.push_str(&format!(" -- {}", sh_quote(text)));
    }
    cmd
}

/// The steps, in order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Fetch,
    Worktree,
    Fixups,
    Sandbox,
    Workspace,
}

impl Step {
    pub fn key(self) -> &'static str {
        match self {
            Step::Fetch => "fetch",
            Step::Worktree => "worktree",
            Step::Fixups => "fixups",
            Step::Sandbox => "sandbox",
            Step::Workspace => "workspace",
        }
    }
}

/// A step's news.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    Start,
    Done,
    /// Finished, with a note worth showing (a fixup that could not be made).
    Warn,
    Failed,
}

/// What was made.
#[derive(Clone, Debug, PartialEq)]
pub struct Made {
    pub path: PathBuf,
    pub branch: String,
    /// cmux's `workspace:N`.
    pub workspace_ref: String,
    /// The workspace's UUID, when cmux's list had it.
    pub workspace_id: Option<String>,
}

/// Opens the workspace: (cwd, command) -> (ref, id). cmux in the app; a fake in tests.
pub type Opener<'a> = dyn Fn(&Path, &str) -> Result<(String, Option<String>), String> + 'a;

/// Make it: fetch, add the worktree, make it able to commit, sandbox it when
/// asked, then open the workspace. `tell` hears every step's start and end.
pub fn create(s: &Settings, r: &Request, open: &Opener, tell: &mut dyn FnMut(Step, Phase, &str)) -> Result<Made, String> {
    let p = plan(s, r)?;
    let mut step = |st: Step, f: &mut dyn FnMut() -> Result<String, String>| -> Result<String, String> {
        tell(st, Phase::Start, "");
        match f() {
            Ok(note) if note.starts_with('!') => {
                tell(st, Phase::Warn, note.trim_start_matches('!'));
                Ok(note)
            }
            Ok(note) => {
                tell(st, Phase::Done, &note);
                Ok(note)
            }
            Err(e) => {
                tell(st, Phase::Failed, &e);
                Err(e)
            }
        }
    };

    step(Step::Fetch, &mut || git(&p.repo, &["fetch", "--quiet", "origin"]).map(|_| format!("origin, for {}", p.base)).map_err(|e| format!("fetch failed: {e}")))?;

    let path_s = p.path.to_string_lossy().into_owned();
    step(Step::Worktree, &mut || {
        if p.existing {
            git(&p.repo, &["worktree", "add", &path_s, &p.branch])?;
            Ok(format!("{} (existing branch) at {}", p.branch, p.path.display()))
        } else {
            git(&p.repo, &["worktree", "add", "-b", &p.branch, &path_s, &p.base])?;
            Ok(format!("{} off {} at {}", p.branch, p.base, p.path.display()))
        }
    })?;

    // From here a failure leaves the worktree; the error says where it is.
    let kept = |e: String| format!("{e} (the worktree is kept at {})", p.path.display());

    step(Step::Fixups, &mut || fixups(&p.repo, &p.path)).map_err(kept)?;

    if let Some(mode) = r.sandbox {
        let bin = s.bin.join("crew-sandbox");
        step(Step::Sandbox, &mut || {
            if !bin.is_file() {
                return Err(format!("crew-sandbox not found at {}", bin.display()));
            }
            let o = Command::new(&bin).args([mode.flag(), "up", &path_s]).stdin(std::process::Stdio::null()).output().map_err(|e| e.to_string())?;
            if o.status.success() {
                Ok("up".into())
            } else {
                let err = String::from_utf8_lossy(&o.stderr);
                Err(format!("sandbox create failed: {}", err.trim().lines().last().unwrap_or("?")))
            }
        })
        .map_err(kept)?;
    }

    let cmd = command(s, &p, r);
    let mut opened = None;
    step(Step::Workspace, &mut || {
        let (wref, id) = open(&p.path, &cmd)?;
        let note = wref.clone();
        opened = Some((wref, id));
        Ok(note)
    })
    .map_err(kept)?;
    let (workspace_ref, workspace_id) = opened.unwrap_or_default();
    Ok(Made { path: p.path, branch: p.branch, workspace_ref, workspace_id })
}

/// What a fresh worktree needs to commit, from the primary checkout: husky's
/// generated `.husky/_` and a `node_modules` link. Ok("!…") is a warning.
fn fixups(main: &Path, path: &Path) -> Result<String, String> {
    let mut did = vec![];
    let husky = main.join(".husky/_");
    let mut warn = None;
    if husky.is_dir() {
        std::fs::create_dir_all(path.join(".husky")).map_err(|e| e.to_string())?;
        let o = Command::new("cp").arg("-R").arg(&husky).arg(path.join(".husky/_")).output().map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(format!("could not copy .husky/_: {}", String::from_utf8_lossy(&o.stderr).trim()));
        }
        did.push(".husky/_ copied");
    } else if main.join(".husky").is_dir() {
        warn = Some(format!("no {}/.husky/_ — run npm install in the primary checkout", main.display()));
    }
    let nm = main.join("node_modules");
    let link = path.join("node_modules");
    if nm.is_dir() && std::fs::symlink_metadata(&link).is_err() {
        std::os::unix::fs::symlink(&nm, &link).map_err(|e| format!("could not link node_modules: {e}"))?;
        did.push("node_modules linked");
    }
    if let Some(w) = warn {
        return Ok(format!("!{w}"));
    }
    Ok(if did.is_empty() { "nothing to do".into() } else { did.join(", ") })
}

/// Open `cwd` as a new cmux workspace with cmux's own shell in it, left in
/// the background (the Dock shows it): its `workspace:N` and, from cmux's
/// lists, its UUID. The caller starts Claude there.
pub fn create_workspace(cwd: &Path) -> Result<(String, Option<String>), String> {
    let c = cmux::Cmux::connect().map_err(|e| format!("cmux: {e}"))?;
    let argv = create_argv(cwd);
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    let out = c.cli(&argv).map_err(|e| format!("cmux: {e}"))?;
    if !out.ok() {
        let err = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
        return Err(format!("cmux did not open the workspace: {}", err.lines().last().unwrap_or("?")));
    }
    let wref = out.stdout.split_whitespace().find(|t| t.starts_with("workspace:")).unwrap_or("").to_string();
    // The workspace's window is not named, so every window's list is looked in.
    let mut id = c.workspace_list(None).ok().and_then(|l| workspace_id(&l, &wref, cwd));
    if id.is_none() {
        for w in c.window_list().unwrap_or_default() {
            let Some(wid) = w.get("id").or_else(|| w.get("ref")).and_then(|v| v.as_str()) else { continue };
            id = c.workspace_list(Some(wid)).ok().and_then(|l| workspace_id(&l, &wref, cwd));
            if id.is_some() {
                break;
            }
        }
    }
    Ok((wref, id))
}

/// `cmux workspace create` for a worktree: in the background, and pinned to
/// it by a root: token in its description.
pub fn create_argv(cwd: &Path) -> Vec<String> {
    let cwd_s = cwd.to_string_lossy().into_owned();
    ["workspace", "create", "--cwd", &cwd_s, "--focus", "false", "--description", &root_tok(&cwd_s)].iter().map(|s| s.to_string()).collect()
}

// ---- the workspace's pinned worktree ------------------------------------------
//
// A workspace is pinned to one worktree by a `root:<path>` token in its cmux
// description, written when the workspace is made (create_argv) or, for one
// made elsewhere, by its first SessionStart; nothing overwrites it. Readers
// take a workspace's worktree from it, and fall back to current_directory
// (which follows the focused pane) only when it is missing. Description
// tokens split on whitespace, so the path's spaces and percent signs are
// escaped.

/// The `root:<path>` token for a worktree path.
pub fn root_tok(path: &str) -> String {
    format!("root:{}", path.replace('%', "%25").replace(' ', "%20").replace('\t', "%09").replace('\n', "%0A"))
}

/// The pinned worktree in a description, if it has a root: token.
pub fn root_of(desc: &str) -> Option<String> {
    let t = desc.split_whitespace().find_map(|t| t.strip_prefix("root:")).filter(|v| !v.is_empty())?;
    Some(t.replace("%20", " ").replace("%09", "\t").replace("%0A", "\n").replace("%25", "%"))
}

/// A workspace's worktree: its pin, else the directory cmux reports.
pub fn root_or(desc: &str, current_directory: &str) -> String {
    root_of(desc).unwrap_or_else(|| current_directory.to_string())
}

/// The UUID of the workspace `wref` (cmux's `workspace list --json`), else
/// of the one whose directory is `cwd`.
pub fn workspace_id(list: &serde_json::Value, wref: &str, cwd: &Path) -> Option<String> {
    let ws = list.get("workspaces")?.as_array()?;
    let str_of = |w: &serde_json::Value, k: &str| w.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cwd = cwd.to_string_lossy();
    ws.iter()
        .find(|w| !wref.is_empty() && str_of(w, "ref") == wref)
        .or_else(|| ws.iter().find(|w| str_of(w, "current_directory") == cwd))
        .map(|w| str_of(w, "id"))
        .filter(|id| cmux::is_uuid(id))
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_root_token_round_trips_and_pins_the_new_workspace() {
        use super::*;
        let p = "/home/dev/code/my repo%x.worktrees/a";
        let t = root_tok(p);
        assert!(!t.contains(' '));
        assert_eq!(root_of(&format!("ci:green {t} phase:working")).as_deref(), Some(p));
        assert_eq!(root_of("ci:green root:"), None);
        assert_eq!(root_or("ci:green", "/cwd"), "/cwd");
        assert_eq!(root_or("root:/pin", "/cwd"), "/pin");
        let argv = create_argv(Path::new("/w/t"));
        assert_eq!(argv, ["workspace", "create", "--cwd", "/w/t", "--focus", "false", "--description", "root:/w/t"]);
    }

    use super::*;
    use std::cell::RefCell;

    fn sh(dir: &Path, args: &[&str]) {
        let o = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }

    /// A code root holding `app` (a clone of a bare origin with a main
    /// branch) and a worktree of it that must never be offered.
    fn fixture(name: &str) -> (PathBuf, Settings) {
        let root = std::env::temp_dir().join(format!("crew-worktree-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let code = root.join("code");
        std::fs::create_dir_all(&code).unwrap();
        let origin = root.join("origin.git");
        sh(&root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
        let seed = root.join("seed");
        sh(&root, &["init", "-q", "-b", "main", seed.to_str().unwrap()]);
        sh(&seed, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one"]);
        sh(&seed, &["push", "-q", origin.to_str().unwrap(), "main"]);
        sh(&root, &["clone", "-q", origin.to_str().unwrap(), code.join("app").to_str().unwrap()]);
        std::fs::create_dir_all(code.join("app/node_modules")).unwrap();
        std::fs::create_dir_all(code.join("zed")).unwrap();
        sh(&code.join("zed"), &["init", "-q"]);
        sh(&code.join("app"), &["worktree", "add", "-q", "-b", "dev/old", code.join("app-old").to_str().unwrap(), "origin/main"]);
        let s = Settings {
            code_root: code,
            monolith: Some(root.join("code/zed")),
            monolith_trees: None,
            prefix: "dev/".into(),
            remote: true,
            bin: root.join("bin"),
        };
        (root, s)
    }

    #[test]
    fn repos_are_primary_checkouts_monolith_first() {
        let (root, s) = fixture("repos");
        let names: Vec<String> = repos(&s).into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["zed", "app"]);
        assert_eq!(repos(&s)[1].base, "origin/main");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn plan_prefixes_and_places_like_the_script() {
        let (root, s) = fixture("plan");
        let r = Request { repo: "app".into(), branch: "dock-thing".into(), ..Default::default() };
        let p = plan(&s, &r).unwrap();
        assert_eq!(p.branch, "dev/dock-thing");
        assert_eq!(p.base, "origin/main");
        assert_eq!(p.path, PathBuf::from(format!("{}/code/app.worktrees/dock-thing", root.display())));
        assert!(!p.existing);
        let p = plan(&s, &Request { branch: "fix/x".into(), ..r.clone() }).unwrap();
        assert_eq!(p.path.file_name().unwrap(), "x");
        assert!(plan(&s, &Request { branch: "bad..name".into(), ..r.clone() }).unwrap_err().contains("not a valid branch"));
        assert!(plan(&s, &Request { repo: "app-old".into(), ..r.clone() }).unwrap_err().contains("not a git checkout"));
        assert!(plan(&s, &Request { branch: " ".into(), ..r.clone() }).unwrap_err().contains("no branch"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn command_names_the_session_and_carries_the_prompt() {
        let (root, s) = fixture("cmd");
        let p = plan(&s, &Request { repo: "app".into(), branch: "x".into(), ..Default::default() }).unwrap();
        let mut r = Request { prompt: Some("fix the -flag, it's broken".into()), ..Default::default() };
        assert_eq!(command(&s, &p, &r), r"claude --remote-control app/dev/x -- 'fix the -flag, it'\''s broken'");
        r.remote = Some(false);
        r.prompt = Some("  ".into());
        assert_eq!(command(&s, &p, &r), "claude");
        r.sandbox = Some(SandboxMode::Link);
        assert!(command(&s, &p, &r).ends_with(&format!("crew-sandbox attach {}", p.path.display())));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn create_runs_every_step_and_opens_the_workspace() {
        let (root, s) = fixture("create");
        let seen = RefCell::new(vec![]);
        let open = |cwd: &Path, cmd: &str| {
            seen.borrow_mut().push((cwd.to_path_buf(), cmd.to_string()));
            Ok(("workspace:7".to_string(), Some("0E560759-0416-40C7-BC72-5AC8F6BE7C07".to_string())))
        };
        let mut steps = vec![];
        let r = Request { repo: "app".into(), branch: "new-one".into(), prompt: Some("hi".into()), ..Default::default() };
        let made = create(&s, &r, &open, &mut |st, ph, _| steps.push((st, ph))).unwrap();
        assert!(made.path.join(".git").is_file());
        assert!(std::fs::symlink_metadata(made.path.join("node_modules")).unwrap().file_type().is_symlink());
        assert_eq!(made.workspace_ref, "workspace:7");
        assert_eq!(seen.borrow()[0].1, "claude --remote-control app/dev/new-one -- hi");
        let order: Vec<Step> = steps.iter().filter(|(_, ph)| *ph == Phase::Done).map(|(st, _)| *st).collect();
        assert_eq!(order, [Step::Fetch, Step::Worktree, Step::Fixups, Step::Workspace]);
        // The same branch again: its path is taken.
        assert!(create(&s, &r, &open, &mut |_, _, _| {}).unwrap_err().contains("already exists"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_failed_open_keeps_the_worktree_and_says_where() {
        let (root, s) = fixture("fail");
        let open = |_: &Path, _: &str| Err::<(String, Option<String>), String>("cmux is not running".into());
        let mut failed = vec![];
        let r = Request { repo: "app".into(), branch: "dev/keep".into(), ..Default::default() };
        let e = create(&s, &r, &open, &mut |st, ph, _| {
            if ph == Phase::Failed {
                failed.push(st)
            }
        })
        .unwrap_err();
        assert!(e.contains("cmux is not running") && e.contains("worktree is kept at"), "{e}");
        assert_eq!(failed, [Step::Workspace]);
        assert!(root.join("code/app.worktrees/keep/.git").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_id_by_ref_then_by_directory() {
        let list = serde_json::json!({"workspaces": [
            {"ref": "workspace:1", "id": "0E560759-0416-40C7-BC72-5AC8F6BE7C07", "current_directory": "/a"},
            {"ref": "workspace:2", "id": "1E560759-0416-40C7-BC72-5AC8F6BE7C07", "current_directory": "/b"},
        ]});
        assert_eq!(workspace_id(&list, "workspace:2", Path::new("/x")).unwrap(), "1E560759-0416-40C7-BC72-5AC8F6BE7C07");
        assert_eq!(workspace_id(&list, "", Path::new("/a")).unwrap(), "0E560759-0416-40C7-BC72-5AC8F6BE7C07");
        assert!(workspace_id(&list, "workspace:9", Path::new("/z")).is_none());
    }

    #[test]
    fn the_baked_monolith_is_read_and_the_placeholder_is_not() {
        let d = std::env::temp_dir().join(format!("crew-worktree-baked-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a"), "MONOLITH=\"${CREW_MONOLITH:-/opt/code/big}\"\n").unwrap();
        std::fs::write(d.join("b"), "MONOLITH=\"${CREW_MONOLITH:-__MAIN_REPO__}\"\n").unwrap();
        assert_eq!(baked_monolith(&d.join("a")).unwrap(), PathBuf::from("/opt/code/big"));
        assert!(baked_monolith(&d.join("b")).is_none());
        let _ = std::fs::remove_dir_all(d);
    }
}
