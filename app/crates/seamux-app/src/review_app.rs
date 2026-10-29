//! The Lookout tab's commands: paste a repo or branch, review it headlessly in
//! a throwaway worktree, then edit, comment or fix from what was found.
//!
//! A review is the same pipeline the lookout skill describes, run by the app
//! so no terminal is needed: `lookout open`, then ONE fresh reviewer (`claude
//! -p`) briefed with exactly `lookout prompt`. What leaves the machine (a
//! comment, a push) is a separate command the page calls after a click.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use seamux_app::review::{
    branch_ok, depth_guide, parse_target, remote_for, review_id, review_payload, What, DEPTHS,
    MODELS,
};

const REVIEW_TIME: Duration = Duration::from_secs(45 * 60);
const QUICK: Duration = Duration::from_secs(120);
const SLOW: Duration = Duration::from_secs(15 * 60);
const LOG_LINES: usize = 60;
/// How long a program's output may stay open after it exits (a tool it
/// started still holding the pipe) before its process group is killed.
const DRAIN_GRACE: Duration = Duration::from_millis(if cfg!(test) { 300 } else { 5000 });

/// The code under review is untrusted: a branch can carry text written to steer
/// the agent. So the agents get no general shell (no cat, no sed, no curl),
/// only lookout and read-only git, and what they read may not include the
/// places credentials live: a finding is posted to GitHub on a click.
///
/// The reviewer reads and reports; it writes nothing but through lookout.
const REVIEWER_TOOLS: &str = "Read,Grep,Glob,Bash(lookout:*),Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git blame:*)";
/// What an edit run adds: change files, and record it on the finding.
const EDITOR_TOOLS: &str = "Read,Grep,Glob,Edit,Write,Bash(lookout:*),Bash(git diff:*),Bash(git status:*),Bash(git log:*),Bash(git show:*)";
const COMMIT_TOOLS: &str = ",Bash(git add:*),Bash(git commit:*)";
const NEVER: &str = "Read(~/.ssh/**),Read(~/.aws/**),Read(~/.gnupg/**),Read(~/.config/gh/**),Read(~/.netrc),Read(~/.claude.json),Read(~/.claude/.credentials.json),Read(**/.env),Read(**/.env.*)";
/// How many times a reviewer whose reply lookout rejected gets it back to fix.
const REPLY_ROUNDS: usize = 2;

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Job {
    pub id: String,
    pub input: String,
    pub repo: String,
    /// The branch under review (a pull request's head branch).
    pub branch: String,
    pub pr: Option<u32>,
    pub base: String,
    /// A pull request from a fork: pushing is not ours to do.
    pub cross: bool,
    pub depth: String,
    pub model: String,
    /// resolving, cloning, fetching, opening, reviewing, ready or failed.
    pub status: String,
    pub detail: String,
    pub review_id: String,
    pub clone: String,
    pub wt: String,
    pub remote: String,
    pub head_sha: String,
    pub base_sha: String,
    /// The reviewer's session, resumed to make edits with what it learned.
    pub session: String,
    pub started: u64,
    /// What is running now (editing, fixing, commenting, pushing), or "".
    pub busy: String,
    pub log: Vec<String>,
    /// Open findings by severity.
    pub open: std::collections::BTreeMap<String, u32>,
    /// Commits in the worktree beyond the reviewed one, and uncommitted edits.
    pub ahead: u32,
    pub dirty: bool,
    /// How many files have uncommitted edits (untracked ones included).
    pub changed: u32,
    pub pushed: bool,
    /// The worktree's HEAD when it was pushed; commits are pushed only while
    /// HEAD is still this (an amend or rebase after a push is not).
    pub pushed_sha: String,
    /// The URL of the GitHub review the comments went out in.
    pub posted: String,
    /// When the current status began, for the tab's elapsed time.
    pub stage_at: u64,
    /// What a running agent did last ("reading shell.rs"), or "".
    pub activity: String,
    /// The process group of the agent running for this job now, or 0. Saved,
    /// so a group left running by a crashed app is not discarded under.
    pub pgid: i32,
}

static JOBS: OnceLock<Mutex<Vec<Job>>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

fn base_dir() -> PathBuf {
    crew_core::py::home().join(".cache/seamux/reviews")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn jobs_file() -> PathBuf {
    base_dir().join("jobs.json")
}

fn jobs() -> &'static Mutex<Vec<Job>> {
    JOBS.get_or_init(|| {
        let file = jobs_file();
        let text = std::fs::read_to_string(&file).ok();
        let mut v: Vec<Job> = match text.as_deref().map(serde_json::from_str) {
            Some(Ok(v)) => v,
            Some(Err(_)) => {
                // Kept aside, not overwritten by the next save: it names
                // worktrees that are still registered.
                let _ = std::fs::rename(&file, file.with_extension(format!("json.unreadable-{}", now())));
                Vec::new()
            }
            None => Vec::new(),
        };
        // A job that was mid-flight when the app quit: its agent was stopped
        // at quit, or, after a crash, may still run (its group is kept).
        for j in v.iter_mut() {
            if !group_alive(j.pgid) {
                j.pgid = 0;
            }
            if !matches!(j.status.as_str(), "ready" | "failed") {
                j.status = "failed".into();
                j.detail = "the app quit while this was running".into();
            }
            j.busy.clear();
        }
        Mutex::new(v)
    })
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app);
    let _ = jobs();
}

fn snapshot() -> Vec<Job> {
    let mut v = jobs().lock().map(|j| j.clone()).unwrap_or_default();
    v.sort_by(|a, b| b.started.cmp(&a.started));
    v
}

/// Save and show the jobs. Called with the jobs' lock held, so the last
/// change made is the last one saved and sent (never an older snapshot).
fn publish(all: &[Job]) {
    save_jobs(&jobs_file(), all);
    if let Some(app) = APP.get() {
        let _ = app.emit("review:frame", all);
    }
}

/// Written whole or not at all: a quit mid-write keeps the last save.
fn save_jobs(file: &Path, all: &[Job]) {
    if let Ok(text) = serde_json::to_string(all) {
        let _ = crew_core::py::write_atomic(file, text.as_bytes());
    }
}

fn update(id: &str, f: impl FnOnce(&mut Job)) {
    let Ok(mut g) = jobs().lock() else { return };
    if let Some(j) = g.iter_mut().find(|j| j.id == id) {
        f(j);
    }
    publish(&g);
}

fn get(id: &str) -> Result<Job, String> {
    jobs()
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|j| j.id == id)
        .cloned()
        .ok_or_else(|| "no such review".to_string())
}

fn note(id: &str, text: &str) {
    let t = text.trim().to_string();
    update(id, |j| {
        j.log.push(t);
        if j.log.len() > LOG_LINES {
            j.log.remove(0);
        }
    });
}

fn stage(id: &str, status: &str, detail: &str) {
    update(id, |j| {
        if j.status != status {
            j.stage_at = now();
        }
        j.status = status.into();
        j.detail = detail.into();
        j.activity.clear();
    });
    note(id, detail);
}

/// Mark `id` busy with `what`, or say what already is.
fn claim(id: &str, what: &str) -> Result<Job, String> {
    let mut g = jobs().lock().map_err(|e| e.to_string())?;
    let j = g.iter_mut().find(|j| j.id == id).ok_or("no such review")?;
    if j.status != "ready" {
        return Err("the review isn't ready yet".into());
    }
    if !j.busy.is_empty() {
        return Err(format!("still {}", j.busy));
    }
    j.busy = what.into();
    let mine = j.clone();
    publish(&g);
    Ok(mine)
}

fn release(id: &str) {
    update(id, |j| j.busy.clear());
}

/// PATH with the places lookout and gh are installed.
fn tool_path() -> String {
    let home = crew_core::py::home();
    let mut dirs = vec![
        home.join(".local/bin").to_string_lossy().into_owned(),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    dirs.push(std::env::var("PATH").unwrap_or_default());
    dirs.join(":")
}

/// Called with each line of a program's stdout as it arrives.
type LineFn = Box<dyn FnMut(&str) + Send>;

struct Out {
    code: i32,
    out: String,
    err: String,
}

/// Run a program to completion, its stdin fed `stdin`, killed after `limit`.
fn exec(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    stdin: Option<&str>,
    limit: Duration,
) -> Result<Out, String> {
    exec_lines(program, args, cwd, stdin, limit, None, None)
}

/// The process groups the reviews run now, each program in its own: what
/// `stop_all` stops when the app quits.
static RUNNING: Mutex<Vec<i32>> = Mutex::new(Vec::new());

/// A running program's process group, tracked while this lives, and saved on
/// the job it runs for (`owner`) so a crash leaves a trace of it.
struct Group {
    pgid: i32,
    owner: Option<String>,
}

impl Group {
    fn track(pgid: i32, owner: Option<&str>) -> Group {
        if let Ok(mut r) = RUNNING.lock() {
            r.push(pgid);
        }
        if let Some(id) = owner {
            update(id, |j| j.pgid = pgid);
        }
        Group { pgid, owner: owner.map(str::to_string) }
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        if let Ok(mut r) = RUNNING.lock() {
            r.retain(|p| *p != self.pgid);
        }
        if let Some(id) = &self.owner {
            let pgid = self.pgid;
            update(id, |j| {
                if j.pgid == pgid {
                    j.pgid = 0;
                }
            });
        }
    }
}

/// Whether process group `pgid` has a process in it that we may signal.
fn group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only asks whether the group exists.
    pgid > 1 && unsafe { libc::killpg(pgid, 0) == 0 }
}

/// SIGTERM the groups, then SIGKILL whatever is left after `grace`.
fn stop_groups(groups: &[i32], grace: Duration) {
    for &g in groups.iter().filter(|g| **g > 1) {
        // SAFETY: a group this app started (see Group).
        unsafe { libc::killpg(g, libc::SIGTERM) };
    }
    let until = Instant::now() + grace;
    while groups.iter().any(|g| group_alive(*g)) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    for &g in groups.iter().filter(|g| group_alive(**g)) {
        // SAFETY: as above.
        unsafe { libc::killpg(g, libc::SIGKILL) };
    }
}

/// Stop every program the reviews are running: the app is quitting, and an
/// agent left behind would go on editing a worktree no card owns.
pub fn stop_all() {
    let groups = RUNNING.lock().map(|r| r.clone()).unwrap_or_default();
    stop_groups(&groups, Duration::from_millis(1500));
}

/// Why job `j`'s worktree may not be discarded: an agent from before the
/// app last quit (a crash) still runs in its process group.
fn orphan(j: &Job) -> Option<String> {
    group_alive(j.pgid).then(|| {
        format!(
            "an agent from before the app last quit may still be working in its worktree (process group {}, see `ps -g {}`); wait for it to finish, then try again",
            j.pgid, j.pgid
        )
    })
}

/// `exec`, with each line of stdout also handed to `on_line` as it arrives,
/// and the process group recorded on job `owner` while it runs.
fn exec_lines(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    stdin: Option<&str>,
    limit: Duration,
    on_line: Option<LineFn>,
    owner: Option<&str>,
) -> Result<Out, String> {
    let mut c = Command::new(program);
    c.args(args)
        .env("PATH", tool_path())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own group: a timeout or a quit stops what it started too.
        .process_group(0);
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("couldn't start {program}: {e}"))?;
    let pgid = child.id() as i32;
    let _group = Group::track(pgid, owner);
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) {
        let text = text.to_string();
        std::thread::spawn(move || {
            let _ = si.write_all(text.as_bytes());
        });
    }
    let (out, err) = (Arc::new(Mutex::new(String::new())), Arc::new(Mutex::new(String::new())));
    let ho = drain(child.stdout.take().ok_or("no stdout")?, out.clone(), on_line);
    let he = drain(child.stderr.take().ok_or("no stderr")?, err.clone(), None);
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Ok(Some(s)) = child.try_wait() {
            break s;
        }
        if Instant::now() > deadline {
            stop_groups(&[pgid], Duration::from_secs(2));
            let _ = child.wait();
            return Err(format!(
                "{program} took longer than {} minutes and was stopped",
                limit.as_secs() / 60
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    // It exited; something it started may still hold its output open. Give
    // that a moment, then stop the group so the card is not busy forever.
    let drained = || ho.is_finished() && he.is_finished();
    let until = Instant::now() + DRAIN_GRACE;
    while !drained() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    if !drained() {
        stop_groups(&[pgid], Duration::from_secs(1));
        let until = Instant::now() + Duration::from_secs(1);
        while !drained() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    // Whatever was read by now (a pipe held by a process outside the group
    // is left to its reader thread).
    let take = |b: &Arc<Mutex<String>>| b.lock().map(|s| s.clone()).unwrap_or_default();
    Ok(Out {
        code: status.code().unwrap_or(-1),
        out: take(&out),
        err: take(&err),
    })
}

/// Read `r` into `buf` a line at a time, handing each line (without its end)
/// to `on_line` as it arrives.
fn drain<R: Read + Send + 'static>(
    r: R,
    buf: Arc<Mutex<String>>,
    mut on_line: Option<LineFn>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut r = BufReader::new(r);
        let mut line = Vec::new();
        loop {
            line.clear();
            match r.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line);
                    if let Some(f) = on_line.as_mut() {
                        f(text.trim_end_matches(['\n', '\r']));
                    }
                    if let Ok(mut b) = buf.lock() {
                        b.push_str(&text);
                    }
                }
            }
        }
    })
}

fn ok(o: Result<Out, String>, what: &str) -> Result<String, String> {
    let o = o?;
    if o.code == 0 {
        Ok(o.out)
    } else {
        let why = if o.err.trim().is_empty() {
            o.out.trim()
        } else {
            o.err.trim()
        };
        Err(format!(
            "{what}: {}",
            why.chars().take(400).collect::<String>()
        ))
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    ok(
        exec("git", args, Some(dir), None, SLOW),
        &format!("git {}", args.first().unwrap_or(&"")),
    )
}

fn gh(args: &[&str], stdin: Option<&str>) -> Result<String, String> {
    ok(
        exec("gh", args, None, stdin, QUICK),
        &format!("gh {}", args.first().unwrap_or(&"")),
    )
}

fn lookout(wt: &Path, args: &[&str]) -> Result<Out, String> {
    exec("lookout", args, Some(wt), None, SLOW)
}

/// A clone of `repo` already on disk: a checkout (not a worktree) under the
/// roots people keep code in, whose remote is that repository.
fn find_local(repo: &str) -> Option<(PathBuf, String)> {
    let roots: Vec<PathBuf> = match std::env::var("SEAMUX_REVIEW_ROOTS") {
        Ok(v) if !v.is_empty() => v.split(':').map(PathBuf::from).collect(),
        _ => vec![crew_core::py::home().join("code")],
    };
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.join(".git").is_dir() {
                continue;
            }
            if let Ok(v) = git(&p, &["remote", "-v"]) {
                if let Some(r) = remote_for(&v, repo) {
                    return Some((p, r));
                }
            }
        }
    }
    None
}

fn pipeline(id: &str, input: &str) -> Result<(), String> {
    let t = parse_target(input)?;
    let job = get(id)?;
    stage(
        id,
        "resolving",
        "asking GitHub which branch and base this is",
    );
    let (branch, pr, base, cross) = match &t.what {
        What::Pr(n) => {
            let v = gh(
                &[
                    "pr",
                    "view",
                    &n.to_string(),
                    "-R",
                    &t.repo,
                    "--json",
                    "headRefName,baseRefName,isCrossRepository,state",
                ],
                None,
            )?;
            let v: Value = serde_json::from_str(&v).map_err(|e| e.to_string())?;
            let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            if s("state") != "OPEN" {
                note(
                    id,
                    &format!(
                        "pull request {n} is {}; reviewing its head anyway",
                        s("state").to_lowercase()
                    ),
                );
            }
            (
                s("headRefName"),
                Some(*n),
                s("baseRefName"),
                v.get("isCrossRepository")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        }
        What::Branch(b) => {
            let v = gh(
                &[
                    "pr",
                    "list",
                    "-R",
                    &t.repo,
                    "--head",
                    b,
                    "--state",
                    "open",
                    "--json",
                    "number,baseRefName",
                    "--limit",
                    "1",
                ],
                None,
            )?;
            let v: Value = serde_json::from_str(&v).map_err(|e| e.to_string())?;
            match v.get(0) {
                Some(p) => (
                    b.clone(),
                    p.get("number").and_then(Value::as_u64).map(|n| n as u32),
                    p.get("baseRefName")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    false,
                ),
                None => {
                    let d = gh(
                        &[
                            "repo",
                            "view",
                            &t.repo,
                            "--json",
                            "defaultBranchRef",
                            "--jq",
                            ".defaultBranchRef.name",
                        ],
                        None,
                    )?;
                    (b.clone(), None, d.trim().to_string(), false)
                }
            }
        }
        What::Default => {
            return Err(
                "name a branch or a pull request: owner/repo@branch or owner/repo#123".into(),
            )
        }
    };
    if !branch_ok(&branch) || !branch_ok(&base) {
        return Err(format!(
            "GitHub returned a branch name git won't take: {branch} / {base}"
        ));
    }
    update(id, |j| {
        j.repo = t.repo.clone();
        j.branch = branch.clone();
        j.pr = pr;
        j.base = base.clone();
        j.cross = cross;
    });

    stage(id, "cloning", "looking for a local clone");
    let (clone, remote) = match find_local(&t.repo) {
        Some((p, r)) => (p, r),
        None => {
            let dir = base_dir().join("clones").join(t.repo.replace('/', "__"));
            if !dir.join(".git").is_dir() {
                stage(
                    id,
                    "cloning",
                    &format!("no local clone: cloning {}", t.repo),
                );
                std::fs::create_dir_all(dir.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
                ok(
                    exec(
                        "gh",
                        &["repo", "clone", &t.repo, &dir.to_string_lossy()],
                        None,
                        None,
                        SLOW,
                    ),
                    "gh repo clone",
                )?;
            }
            (dir, "origin".to_string())
        }
    };
    note(id, &format!("using {} (remote {remote})", clone.display()));

    stage(id, "fetching", "fetching the branch and its base");
    let head_ref = match pr {
        Some(n) if cross => format!("refs/pull/{n}/head"),
        _ => format!("refs/heads/{branch}"),
    };
    let (kh, kb) = (
        format!("refs/seamux/{id}/head"),
        format!("refs/seamux/{id}/base"),
    );
    git(
        &clone,
        &["fetch", "--quiet", &remote, &format!("+{head_ref}:{kh}")],
    )?;
    git(
        &clone,
        &[
            "fetch",
            "--quiet",
            &remote,
            &format!("+refs/heads/{base}:{kb}"),
        ],
    )?;
    let head_sha = git(&clone, &["rev-parse", &kh])?.trim().to_string();
    let base_sha = git(&clone, &["rev-parse", &kb])?.trim().to_string();
    let wt = base_dir().join(id).join("wt");
    std::fs::create_dir_all(wt.parent().unwrap_or(&wt)).map_err(|e| e.to_string())?;
    git(
        &clone,
        &[
            "worktree",
            "add",
            "--detach",
            &wt.to_string_lossy(),
            &head_sha,
        ],
    )?;
    let rid = review_id(
        &t.repo,
        &match pr {
            Some(n) => format!("pr{n}"),
            None => branch.clone(),
        },
    );
    update(id, |j| {
        j.clone = clone.to_string_lossy().into_owned();
        j.wt = wt.to_string_lossy().into_owned();
        j.remote = remote.clone();
        j.head_sha = head_sha.clone();
        j.base_sha = base_sha.clone();
        j.review_id = rid.clone();
    });

    stage(id, "opening", "opening the review");
    let title = format!(
        "{} · {}",
        t.repo,
        pr.map(|n| format!("PR #{n}")).unwrap_or(branch.clone())
    );
    let o = lookout(
        &wt,
        &[
            "open",
            "--no-open",
            "--id",
            &rid,
            "--base",
            &base_sha,
            "--title",
            &title,
        ],
    )?;
    if o.code != 0 {
        return Err(format!(
            "lookout open: {}",
            o.err.trim().chars().take(400).collect::<String>()
        ));
    }
    note(id, o.out.trim());
    // --reply: the reviewer has no file tool, and Claude Code refuses JSON
    // inside a Bash command, so it answers with the JSON and the app ingests it.
    let brief = ok(
        Ok(lookout(&wt, &["prompt", &rid, "--reply"])?),
        "lookout prompt",
    )?;

    stage(
        id,
        "reviewing",
        &format!("a fresh reviewer is reading the diff ({} depth)", job.depth),
    );
    let (session, mut said) = claude(
        &wt,
        &brief,
        &job.model,
        &job.depth,
        REVIEWER_TOOLS,
        Some(depth_guide(&job.depth)),
        None,
        REVIEW_TIME,
        Some(id),
    )?;
    update(id, |j| j.session = session.clone());
    let mut round = 0;
    let heard = loop {
        stage(id, "ingesting", "saving the reviewer's findings");
        let o = exec(
            "lookout",
            &["findings", "add", &rid, "-"],
            Some(&wt),
            Some(&said),
            QUICK,
        )?;
        let heard = format!("{}\n{}", o.out.trim(), o.err.trim())
            .trim()
            .to_string();
        note(id, &heard.chars().take(600).collect::<String>());
        let clean = o.code == 0
            && !heard.contains("rejected item")
            && !heard.contains("rejected note")
            && !heard.contains("rejected edge")
            && !heard.contains("still owed");
        if clean || round == REPLY_ROUNDS || session.is_empty() {
            break heard;
        }
        round += 1;
        stage(
            id,
            "reviewing",
            "lookout rejected part of the reply; the reviewer is fixing it",
        );
        let ask = format!(
            "lookout findings add said:\n\n{heard}\n\nFix what it names and reply with the whole corrected JSON object again, and nothing else."
        );
        said = claude(
            &wt,
            &ask,
            &job.model,
            &job.depth,
            REVIEWER_TOOLS,
            Some(depth_guide(&job.depth)),
            Some(&session),
            SLOW,
            Some(id),
        )?
        .1;
    };
    // Exit 3: no reviewer ever reported. The run ended without findings.
    let gate = lookout(&wt, &["gate", &rid])?;
    if gate.code == 3 {
        return Err(format!(
            "the reviewer's findings were not accepted: {}",
            heard.chars().take(300).collect::<String>()
        ));
    }
    refresh(id);
    stage(id, "ready", "review done");
    Ok(())
}

/// One headless Claude turn in `wt`. Returns its session id and final text.
/// With `watch`, each tool call it makes is shown on that job as it happens.
#[allow(clippy::too_many_arguments)]
fn claude(
    wt: &Path,
    prompt: &str,
    model: &str,
    effort: &str,
    tools: &str,
    guide: Option<&str>,
    resume: Option<&str>,
    limit: Duration,
    watch: Option<&str>,
) -> Result<(String, String), String> {
    let mut args: Vec<&str> = vec![
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--allowedTools",
        tools,
        "--disallowedTools",
        NEVER,
    ];
    if !model.is_empty() {
        args.extend(["--model", model]);
    }
    if DEPTHS.contains(&effort) {
        args.extend(["--effort", effort]);
    }
    if let Some(g) = guide {
        args.extend(["--append-system-prompt", g]);
    }
    if let Some(s) = resume {
        args.extend(["--resume", s]);
    }
    let on_line: Option<LineFn> = watch.map(|id| {
        let id = id.to_string();
        Box::new(move |line: &str| {
            if let Some(a) = serde_json::from_str::<Value>(line)
                .ok()
                .as_ref()
                .and_then(activity_of)
            {
                update(&id, |j| j.activity = a);
            }
        }) as LineFn
    });
    let o = exec_lines("claude", &args, Some(wt), Some(prompt), limit, on_line, watch)?;
    if let Some(id) = watch {
        update(id, |j| j.activity.clear());
    }
    // The last event is the result: {"type":"result","result":..,"session_id":..}.
    let v = o
        .out
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("type").and_then(Value::as_str) == Some("result"))
        .ok_or_else(|| {
            format!(
                "claude said something unreadable: {}",
                o.err.trim().chars().take(300).collect::<String>()
            )
        })?;
    let text = v
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if o.code != 0 || v.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(format!(
            "claude stopped: {}",
            text.chars().take(400).collect::<String>()
        ));
    }
    Ok((
        v.get("session_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        text,
    ))
}

/// A stream-json event's last tool call, in a few words: "reading shell.rs".
fn activity_of(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let call = v
        .pointer("/message/content")?
        .as_array()?
        .iter()
        .rev()
        .find(|c| c.get("type").and_then(Value::as_str) == Some("tool_use"))?;
    let input = call.get("input").cloned().unwrap_or(Value::Null);
    let arg = |k: &str| {
        input
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let base = |p: String| p.rsplit('/').next().unwrap_or("").to_string();
    let short = |t: String| {
        let t = t.lines().next().unwrap_or("").to_string();
        if t.chars().count() > 70 {
            format!("{}…", t.chars().take(70).collect::<String>())
        } else {
            t
        }
    };
    Some(
        match call.get("name").and_then(Value::as_str).unwrap_or("") {
            "Read" => format!("reading {}", base(arg("file_path"))),
            "Edit" | "MultiEdit" => format!("editing {}", base(arg("file_path"))),
            "Write" => format!("writing {}", base(arg("file_path"))),
            "Grep" => format!("searching for {}", short(arg("pattern"))),
            "Glob" => format!("looking for {}", short(arg("pattern"))),
            "Bash" => format!("running {}", short(arg("command"))),
            other => format!("using {other}"),
        },
    )
}

/// What a review's worktree holds beyond the reviewed commit, read from git.
#[derive(Debug, Default, Clone, PartialEq)]
struct Work {
    /// Commits after `head_sha`.
    ahead: u32,
    /// Files with uncommitted edits, untracked ones included.
    changed: u32,
    /// The worktree's HEAD sha, or "" when there is no worktree.
    head: String,
}

/// Read `wt`'s commits past `head_sha` and its uncommitted files. A worktree
/// that is not there holds nothing; one git can't read is an error, so a
/// caller about to delete it stops rather than guess.
fn work_in(wt: &Path, head_sha: &str) -> Result<Work, String> {
    if wt.as_os_str().is_empty() || !wt.join(".git").exists() {
        return Ok(Work::default());
    }
    let head = git(wt, &["rev-parse", "HEAD"])?.trim().to_string();
    let ahead = if head_sha.is_empty() {
        0
    } else {
        let n = git(wt, &["rev-list", "--count", &format!("{head_sha}..HEAD")])?;
        n.trim()
            .parse()
            .map_err(|_| format!("git rev-list: not a count: {}", n.trim()))?
    };
    let changed = git(wt, &["status", "--porcelain", "--untracked-files=all"])?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count() as u32;
    Ok(Work { ahead, changed, head })
}

/// Whether `j`'s push still covers `head`.
fn still_pushed(j: &Job, head: &str) -> bool {
    j.pushed && !j.pushed_sha.is_empty() && j.pushed_sha == head
}

/// Copy `w` onto the card. Once HEAD moves off what was pushed (new commits,
/// an amend, a rebase), it is not pushed any more.
fn apply(x: &mut Job, w: &Work) {
    if !w.head.is_empty() && !still_pushed(x, &w.head) {
        x.pushed = false;
    }
    x.ahead = w.ahead;
    x.changed = w.changed;
    x.dirty = w.changed > 0;
}

/// Commits in `w` that are not on the branch yet.
fn unpushed(j: &Job, w: &Work) -> u32 {
    if still_pushed(j, &w.head) {
        0
    } else {
        w.ahead
    }
}

/// "3 files with uncommitted edits and 1 unpushed commit", or "" for none.
fn at_stake_text(changed: u32, unpushed: u32) -> String {
    let s = |n: u32| if n == 1 { "" } else { "s" };
    let mut parts = Vec::new();
    if changed > 0 {
        parts.push(format!("{changed} file{} with uncommitted edits", s(changed)));
    }
    if unpushed > 0 {
        parts.push(format!("{unpushed} unpushed commit{}", s(unpushed)));
    }
    parts.join(" and ")
}

/// What deleting `j`'s worktree would lose, read from git now rather than the
/// card (which only a pipeline or a fix refreshes). The card is updated too,
/// so the page shows it. Returns (changed files, unpushed commits), or why git
/// couldn't read the worktree.
fn at_stake(j: &Job) -> Result<(u32, u32), String> {
    let w = work_in(Path::new(&j.wt), &j.head_sha)?;
    let lost = unpushed(j, &w);
    update(&j.id, |x| apply(x, &w));
    Ok((w.changed, lost))
}

/// Why `remove_review` won't delete yet, given what git found (`found`: changed
/// files and unpushed commits, or why it couldn't read the worktree) and what
/// the person confirmed losing. None: go ahead.
fn refuse_remove(
    found: &Result<(u32, u32), String>,
    files: u32,
    commits: u32,
    unreadable: bool,
) -> Option<String> {
    match found {
        Err(e) if !unreadable => Some(format!(
            "{UNREADABLE} ({e}), so nothing was deleted. Remove again to delete it and whatever it holds."
        )),
        Err(_) => None,
        Ok((changed, lost)) if *changed > files || *lost > commits => Some(format!(
            "nothing was removed: its worktree has {}. Remove again to delete them.",
            at_stake_text(*changed, *lost)
        )),
        Ok(_) => None,
    }
}

/// How an unreadable worktree's refusal starts; the page looks for it.
const UNREADABLE: &str = "couldn't read its worktree";

/// Re-read what the worktree and the store now say.
fn refresh(id: &str) {
    let Ok(j) = get(id) else { return };
    let w = work_in(Path::new(&j.wt), &j.head_sha).unwrap_or_default();
    let mut open = std::collections::BTreeMap::new();
    if let Ok(v) = findings_of(&j) {
        for f in v.iter().filter(|f| is_open(f)) {
            *open
                .entry(
                    f.get("severity")
                        .and_then(Value::as_str)
                        .unwrap_or("minor")
                        .to_string(),
                )
                .or_insert(0) += 1;
        }
    }
    update(id, |j| {
        apply(j, &w);
        j.open = open;
    });
}

fn is_open(f: &Value) -> bool {
    !matches!(
        f.get("status").and_then(Value::as_str),
        Some("resolved" | "dismissed")
    )
}

fn findings_of(j: &Job) -> Result<Vec<Value>, String> {
    let s = ok(
        Ok(lookout(
            Path::new(&j.wt),
            &["findings", "list", &j.review_id, "--json"],
        )?),
        "lookout findings",
    )?;
    let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    Ok(v.get("findings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

// ----------------------------------------------------------------- commands

#[tauri::command]
pub fn review_jobs() -> Vec<Job> {
    snapshot()
}

/// Async: it reads and deletes worktrees, which is too slow for the main thread.
#[tauri::command]
pub async fn review_start(input: String, depth: String, model: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || start_review(input, depth, model))
        .await
        .map_err(|e| e.to_string())?
}

fn start_review(input: String, depth: String, model: String) -> Result<String, String> {
    let t = parse_target(&input)?;
    if t.what == What::Default {
        return Err("name a branch or a pull request: owner/repo@branch, owner/repo#123, or a /tree/ or /pull/ URL".into());
    }
    if !DEPTHS.contains(&depth.as_str()) || !MODELS.contains(&model.as_str()) {
        return Err("unknown depth or model".into());
    }
    // One card per branch or pull request: reviewing it again replaces the
    // old run (its worktree too), unless that run has work not yet pushed,
    // as git says now: edits made after the last fix are not on the card.
    let same: Vec<Job> = snapshot()
        .into_iter()
        .filter(|j| same_target(j, &t))
        .collect();
    for j in &same {
        if !j.busy.is_empty() || !matches!(j.status.as_str(), "ready" | "failed") {
            return Err("that one is still running".into());
        }
        if let Some(why) = orphan(j) {
            return Err(why);
        }
    }
    for j in &same {
        let (changed, lost) = at_stake(j).map_err(|e| {
            format!("couldn't read its last review's worktree ({e}). Remove that review first (Remove asks before deleting it).")
        })?;
        if changed > 0 || lost > 0 {
            return Err(format!(
                "its last review's worktree has {}. Commit and push them, or remove that review first (Remove asks before deleting them).",
                at_stake_text(changed, lost)
            ));
        }
    }
    for j in &same {
        discard(j);
    }
    let id = same.last().map(|j| j.id.clone()).unwrap_or_else(|| {
        format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    });
    let job = Job {
        id: id.clone(),
        input: input.trim().to_string(),
        repo: t.repo.clone(),
        depth,
        model,
        status: "resolving".into(),
        started: now(),
        stage_at: now(),
        ..Default::default()
    };
    {
        let mut g = jobs().lock().map_err(|e| e.to_string())?;
        g.retain(|x| !same.iter().any(|o| o.id == x.id));
        g.push(job);
        publish(&g);
    }
    let (jid, text) = (id.clone(), input);
    std::thread::spawn(move || {
        if let Err(e) = pipeline(&jid, &text) {
            stage(&jid, "failed", &e);
        }
    });
    Ok(id)
}

/// The review's findings, as lookout stores them.
#[tauri::command]
pub async fn review_findings(id: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || findings_of(&get(&id)?))
        .await
        .map_err(|e| e.to_string())?
}

/// Have the reviewer's session fix findings (`ids`, or every open blocker and
/// major when empty): left as edits in the worktree, or, with `commit`, as
/// commits. Nothing is pushed.
#[tauri::command]
pub fn review_fix(id: String, ids: Vec<String>, commit: bool) -> Result<(), String> {
    if ids
        .iter()
        .any(|i| !i.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return Err("bad finding id".into());
    }
    let j = claim(&id, if commit { "fixing" } else { "editing" })?;
    std::thread::spawn(move || {
        let which = if ids.is_empty() {
            "every open blocker and major finding".to_string()
        } else {
            format!("findings {}", ids.join(", "))
        };
        let end = if commit {
            "Make one commit per fix, its message naming the finding. Do not push."
        } else {
            "Do not commit; leave the changes in the working tree."
        };
        let prompt = format!(
            "Fix {which} of review {rid} in this worktree. For each, make the smallest change that fixes it, then run `lookout address {rid} <id> \"<what changed>\"`. \
             If a finding is wrong, say so with `lookout reply {rid} <id> \"<why>\"` and change nothing. Never resolve or dismiss a finding. {end}",
            rid = j.review_id
        );
        let tools = format!("{EDITOR_TOOLS}{}", if commit { COMMIT_TOOLS } else { "" });
        let resume = (!j.session.is_empty()).then_some(j.session.as_str());
        match claude(
            Path::new(&j.wt),
            &prompt,
            &j.model,
            &j.depth,
            &tools,
            None,
            resume,
            REVIEW_TIME,
            Some(&j.id),
        ) {
            Ok((s, said)) => {
                note(&j.id, &said.chars().take(600).collect::<String>());
                update(&j.id, |x| {
                    if !s.is_empty() {
                        x.session = s;
                    }
                });
            }
            Err(e) => note(&j.id, &e),
        }
        refresh(&j.id);
        release(&j.id);
    });
    Ok(())
}

/// Post findings `ids` as one GitHub review on the pull request, pinned to the
/// commit that was reviewed. A line GitHub won't take falls back to one body.
#[tauri::command]
pub fn review_post(id: String, ids: Vec<String>) -> Result<(), String> {
    let j = get(&id)?;
    let Some(pr) = j.pr else {
        return Err("this branch has no open pull request to comment on".into());
    };
    if ids.is_empty() {
        return Err("pick at least one finding".into());
    }
    let j = claim(&id, "commenting")?;
    std::thread::spawn(move || {
        let run = || -> Result<String, String> {
            let all = findings_of(&j)?;
            let picked: Vec<Value> = all
                .into_iter()
                .filter(|f| {
                    f.get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|i| ids.iter().any(|x| x == i))
                })
                .collect();
            if picked.is_empty() {
                return Err("none of those findings exist any more".into());
            }
            let intro = format!(
                "Lookout review ({} depth): {} finding(s).",
                j.depth,
                picked.len()
            );
            let path = format!("repos/{}/pulls/{pr}/reviews", j.repo);
            let post = |folded: bool| {
                exec(
                    "gh",
                    &["api", "-X", "POST", &path, "--input", "-"],
                    None,
                    Some(&review_payload(&picked, &j.head_sha, &intro, folded).to_string()),
                    QUICK,
                )
            };
            let mut o = post(false)?;
            if o.code != 0 && (o.err.contains("422") || o.out.contains("Unprocessable")) {
                note(&j.id, "GitHub refused a line comment (not in the diff); posting the findings in one body");
                o = post(true)?;
            }
            if o.code != 0 {
                return Err(format!(
                    "gh api: {}",
                    format!("{}{}", o.out, o.err)
                        .trim()
                        .chars()
                        .take(400)
                        .collect::<String>()
                ));
            }
            let v: Value = serde_json::from_str(&o.out).unwrap_or(Value::Null);
            Ok(v.get("html_url")
                .and_then(Value::as_str)
                .unwrap_or("posted")
                .to_string())
        };
        match run() {
            Ok(url) => {
                note(&j.id, &format!("posted: {url}"));
                update(&j.id, |x| x.posted = url);
            }
            Err(e) => note(&j.id, &e),
        }
        release(&j.id);
    });
    Ok(())
}

/// Push the fix commits to the branch they came from. Never forced: a branch
/// that moved since the review refuses it and says so.
#[tauri::command]
pub fn review_push(id: String) -> Result<(), String> {
    let j = get(&id)?;
    if j.cross {
        return Err("this pull request is from a fork; the fixes stay local".into());
    }
    if j.ahead == 0 {
        return Err("there are no fix commits to push".into());
    }
    if j.dirty {
        return Err("there are uncommitted edits; commit them (Fix) or discard them first".into());
    }
    let j = claim(&id, "pushing")?;
    std::thread::spawn(move || {
        // Push the sha read here, so what is recorded is what went out.
        let r = git(Path::new(&j.wt), &["rev-parse", "HEAD"]).and_then(|sha| {
            let sha = sha.trim().to_string();
            git(
                Path::new(&j.wt),
                &["push", &j.remote, &format!("{sha}:refs/heads/{}", j.branch)],
            )
            .map(|_| sha)
        });
        match r {
            Ok(sha) => {
                note(
                    &j.id,
                    &format!("pushed {} commit(s) to {}", j.ahead, j.branch),
                );
                update(&j.id, |x| {
                    x.pushed = true;
                    x.pushed_sha = sha;
                });
            }
            Err(e) => note(&j.id, &e),
        }
        release(&j.id);
    });
    Ok(())
}

/// Forget a review and delete its worktree. `files` and `commits` are the
/// uncommitted files and unpushed commits the person's confirm named;
/// `unreadable`, that they confirmed deleting a worktree git couldn't read.
/// If git now finds more than they confirmed, nothing is removed and the card
/// is updated so they can confirm again with it named.
#[tauri::command]
pub async fn review_remove(
    id: String,
    files: u32,
    commits: u32,
    unreadable: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_review(&id, files, commits, unreadable))
        .await
        .map_err(|e| e.to_string())?
}

fn remove_review(id: &str, files: u32, commits: u32, unreadable: bool) -> Result<(), String> {
    let j = get(id)?;
    if !j.busy.is_empty() || !matches!(j.status.as_str(), "ready" | "failed") {
        return Err("it is still running".into());
    }
    if let Some(why) = orphan(&j) {
        return Err(why);
    }
    if let Some(why) = refuse_remove(&at_stake(&j), files, commits, unreadable) {
        return Err(why);
    }
    discard(&j);
    let mut g = jobs().lock().map_err(|e| e.to_string())?;
    g.retain(|x| x.id != id);
    publish(&g);
    Ok(())
}

/// Whether job `j` reviews what `t` names: the same pull request, or branch.
fn same_target(j: &Job, t: &seamux_app::review::Target) -> bool {
    if !j.repo.eq_ignore_ascii_case(&t.repo) {
        return false;
    }
    match &t.what {
        What::Pr(n) => j.pr == Some(*n),
        What::Branch(b) => {
            j.branch == *b
                || (j.branch.is_empty() && parse_target(&j.input).is_ok_and(|o| o.what == t.what))
        }
        What::Default => false,
    }
}

/// Delete a job's worktree, its fetched refs and its folder. Not the review.
fn discard(j: &Job) {
    if !j.wt.is_empty() && !j.clone.is_empty() {
        let _ = git(
            Path::new(&j.clone),
            &["worktree", "remove", "--force", &j.wt],
        );
    }
    if !j.clone.is_empty() {
        for k in ["head", "base"] {
            let _ = git(
                Path::new(&j.clone),
                &["update-ref", "-d", &format!("refs/seamux/{}/{k}", j.id)],
            );
        }
    }
    let _ = std::fs::remove_dir_all(base_dir().join(&j.id));
}

/// Something to review, offered under the input.
#[derive(Clone, Serialize)]
pub struct Pick {
    /// What goes in the input: owner/repo#12 or owner/repo@branch.
    pub input: String,
    pub repo: String,
    pub title: String,
    /// Unix seconds of the last change.
    pub updated: u64,
}

#[derive(Serialize, Default)]
pub struct Picks {
    /// Open pull requests waiting on your review, newest five.
    pub requested: Vec<Pick>,
    /// Your own open pull requests, newest five.
    pub mine: Vec<Pick>,
    /// Pushed branches in local clones, newest five.
    pub branches: Vec<Pick>,
    /// Why GitHub could not be asked, when it could not.
    pub problem: String,
}

/// Unix seconds of a UTC ISO time ("2026-10-26T12:21:17Z"; GitHub's and lookout's).
fn iso_secs(t: &str) -> u64 {
    crew_store::epoch19(t).map(|s| s.max(0) as u64).unwrap_or(0)
}

fn search_prs(who: &str) -> Result<Vec<Pick>, String> {
    let s = gh(
        &[
            "search",
            "prs",
            who,
            "--state=open",
            "--sort=updated",
            "--limit",
            "5",
            "--json",
            "number,title,repository,updatedAt",
        ],
        None,
    )?;
    let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    Ok(v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let repo = p
                        .pointer("/repository/nameWithOwner")?
                        .as_str()?
                        .to_string();
                    let n = p.get("number")?.as_u64()?;
                    Some(Pick {
                        input: format!("{repo}#{n}"),
                        title: p
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        updated: iso_secs(p.get("updatedAt").and_then(Value::as_str).unwrap_or("")),
                        repo,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Branches with an upstream on a GitHub remote, across the local clones.
fn recent_branches() -> Vec<Pick> {
    let roots: Vec<PathBuf> = match std::env::var("SEAMUX_REVIEW_ROOTS") {
        Ok(v) if !v.is_empty() => v.split(':').map(PathBuf::from).collect(),
        _ => vec![crew_core::py::home().join("code")],
    };
    let mut out: Vec<Pick> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.join(".git").is_dir() {
                continue;
            }
            let Ok(remotes) = git(&p, &["remote", "-v"]) else {
                continue;
            };
            let Ok(refs) = git(
                &p,
                &[
                    "for-each-ref",
                    "--sort=-committerdate",
                    "--count=8",
                    "--format=%(committerdate:unix)\t%(upstream:remotename)\t%(upstream:lstrip=3)\t%(subject)",
                    "refs/heads",
                ],
            ) else {
                continue;
            };
            for line in refs.lines() {
                let f: Vec<&str> = line.splitn(4, '\t').collect();
                let [when, remote, branch, subject] = f[..] else {
                    continue;
                };
                if remote.is_empty() || branch.is_empty() || matches!(branch, "main" | "master") {
                    continue;
                }
                let Some(repo) = github_repo(&remotes, remote) else {
                    continue;
                };
                out.push(Pick {
                    input: format!("{repo}@{branch}"),
                    repo,
                    title: subject.to_string(),
                    updated: when.parse().unwrap_or(0),
                });
            }
        }
    }
    out.sort_by_key(|o| std::cmp::Reverse(o.updated));
    out.dedup_by(|a, b| a.input == b.input);
    out.truncate(5);
    out
}

/// owner/repo of `remote` in `git remote -v` output, when it is on GitHub.
fn github_repo(remotes: &str, remote: &str) -> Option<String> {
    remotes.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        if it.next()? != remote {
            return None;
        }
        let url = it.next()?;
        let rest = url
            .strip_prefix("https://github.com/")
            .or_else(|| url.strip_prefix("git@github.com:"))
            .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
        let r = rest.trim_end_matches('/').trim_end_matches(".git");
        (r.split('/').count() == 2).then(|| r.to_string())
    })
}

#[tauri::command]
pub async fn review_suggest() -> Picks {
    tauri::async_runtime::spawn_blocking(|| {
        let mut p = Picks::default();
        match search_prs("--review-requested=@me") {
            Ok(v) => p.requested = v,
            Err(e) => p.problem = e,
        }
        if let Ok(v) = search_prs("--author=@me") {
            p.mine = v;
        }
        p.branches = recent_branches();
        p
    })
    .await
    .unwrap_or_default()
}

/// A lookout review the app did not run: one opened from a terminal session.
#[derive(Clone, Serialize)]
pub struct Other {
    pub id: String,
    pub title: String,
    /// The checkout it was opened in, and its branch.
    pub root: String,
    pub branch: String,
    /// Unix seconds of its last change.
    pub updated: u64,
    /// Findings not resolved or dismissed, by severity.
    pub open: std::collections::BTreeMap<String, u32>,
}

/// The newest terminal reviews. Each record is re-read only when it changes.
#[tauri::command]
pub async fn review_others() -> Vec<Other> {
    tauri::async_runtime::spawn_blocking(others)
        .await
        .unwrap_or_default()
}

fn others() -> Vec<Other> {
    type Seen = std::collections::HashMap<PathBuf, (std::time::SystemTime, Option<Other>)>;
    static SEEN: OnceLock<Mutex<Seen>> = OnceLock::new();
    let dir = crew_board::review::reviews_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mine: std::collections::HashSet<String> =
        snapshot().into_iter().map(|j| j.review_id).collect();
    let app_wts = base_dir().to_string_lossy().into_owned();
    let mut cache = SEEN
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if id.ends_with(".rows")
            || id.ends_with(".seen")
            || id.ends_with(".incoming")
            || id.starts_with("wake-")
            || mine.contains(id)
        {
            continue;
        }
        let path = e.path();
        let Ok(mtime) = e.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if !matches!(cache.get(&path), Some((t, _)) if *t == mtime) {
            let o = read_other(&path, id).filter(|o| !o.root.starts_with(&app_wts));
            cache.insert(path.clone(), (mtime, o));
        }
        if let Some((_, Some(o))) = cache.get(&path) {
            out.push(o.clone());
        }
    }
    out.sort_by_key(|o| std::cmp::Reverse(o.updated));
    out.truncate(12);
    out
}

fn read_other(path: &Path, id: &str) -> Option<Other> {
    let d: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let src = d.get("source")?;
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut open = std::collections::BTreeMap::new();
    for f in d
        .get("findings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|f| is_open(f))
    {
        *open.entry(s(f, "severity")).or_insert(0) += 1;
    }
    let title = s(&d, "title");
    Some(Other {
        id: id.to_string(),
        title: if title.is_empty() {
            id.to_string()
        } else {
            title
        },
        root: s(src, "root"),
        branch: s(src, "branch"),
        updated: iso_secs(&s(&d, "updatedAt")),
        open,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("seamux-review-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn pid_alive(pid: i32) -> bool {
        // SAFETY: signal 0 only asks.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn jobs_are_saved_whole_with_no_temp_file_left() {
        let d = scratch("save");
        let file = d.join("jobs.json");
        std::fs::write(&file, "[{\"id\":\"old\"}]").unwrap();
        let jobs = vec![Job { id: "a".into(), pgid: 42, ..Default::default() }, Job { id: "b".into(), ..Default::default() }];
        save_jobs(&file, &jobs);
        let back: Vec<Job> = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back.iter().map(|j| (j.id.as_str(), j.pgid)).collect::<Vec<_>>(), [("a", 42), ("b", 0)]);
        let names: Vec<String> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["jobs.json"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_tool_left_holding_the_output_does_not_hold_the_run() {
        let d = scratch("linger");
        let pidf = d.join("pid");
        let script = format!("sleep 30 & echo $! > {}; echo hi", pidf.display());
        let t = Instant::now();
        let o = exec_lines("sh", &["-c", &script], None, None, Duration::from_secs(20), None, None).unwrap();
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        assert_eq!((o.code, o.out.as_str()), (0, "hi\n"));
        let pid: i32 = std::fs::read_to_string(&pidf).unwrap().trim().parse().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!pid_alive(pid), "the lingering sleep was stopped with its group");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_timeout_stops_the_whole_process_group() {
        let d = scratch("timeout");
        let pidf = d.join("pid");
        let script = format!("sleep 30 & echo $! > {}; wait", pidf.display());
        let e = exec_lines("sh", &["-c", &script], None, None, Duration::from_millis(400), None, None).err().unwrap();
        assert!(e.contains("was stopped"), "{e}");
        let pid: i32 = std::fs::read_to_string(&pidf).unwrap().trim().parse().unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!pid_alive(pid), "the agent's tool died with it");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn lines_reach_the_watcher_without_their_ends() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let f: LineFn = Box::new(move |l: &str| s2.lock().unwrap().push(l.to_string()));
        let o = exec_lines("printf", &["a\\r\\nb\\nc"], None, None, Duration::from_secs(5), Some(f), None).unwrap();
        assert_eq!(o.out, "a\r\nb\nc");
        assert_eq!(*seen.lock().unwrap(), ["a", "b", "c"]);
    }

    #[test]
    fn a_dead_group_is_no_orphan() {
        assert!(orphan(&Job::default()).is_none());
        assert!(orphan(&Job { pgid: 1, ..Default::default() }).is_none());
        // Our own group is alive: a card naming it is refused.
        // SAFETY: getpgrp has no preconditions.
        let me = unsafe { libc::getpgrp() };
        assert!(orphan(&Job { pgid: me, ..Default::default() }).is_some_and(|w| w.contains("still be working")));
    }

    #[test]
    fn activity_names_the_last_tool_call() {
        let v: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[
                {"type":"text","text":"looking"},
                {"type":"tool_use","name":"Read","input":{"file_path":"/w/app/src/shell.rs"}}]}}"#,
        )
        .unwrap();
        assert_eq!(activity_of(&v).as_deref(), Some("reading shell.rs"));
        let bash: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git diff HEAD~1\nmore"}}]}}"#,
        )
        .unwrap();
        assert_eq!(activity_of(&bash).as_deref(), Some("running git diff HEAD~1"));
        let text: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#,
        )
        .unwrap();
        assert_eq!(activity_of(&text), None);
        assert_eq!(activity_of(&serde_json::json!({"type": "result"})), None);
    }

    #[test]
    fn github_repo_reads_https_and_ssh_remotes() {
        let r = "origin\tgit@github.com:rickykoter/seamux.git (fetch)\n\
                 fork\thttps://github.com/someone/seamux (fetch)\n\
                 other\thttps://gitlab.com/a/b.git (fetch)\n";
        assert_eq!(github_repo(r, "origin").as_deref(), Some("rickykoter/seamux"));
        assert_eq!(github_repo(r, "fork").as_deref(), Some("someone/seamux"));
        assert_eq!(github_repo(r, "other"), None);
        assert_eq!(github_repo(r, "missing"), None);
    }

    #[test]
    fn iso_secs_reads_github_and_lookout_times() {
        assert_eq!(iso_secs("1970-01-02T00:00:00Z"), 86400);
        assert_eq!(iso_secs("1970-01-02T00:00:00.500Z"), 86400);
        assert_eq!(iso_secs("not a time"), 0);
    }

    /// A repo with one commit and a worktree of it, like a review's.
    fn repo_with_worktree(name: &str) -> (PathBuf, PathBuf, String) {
        let d = std::env::temp_dir().join(format!("seamux-review-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let (clone, wt) = (d.join("clone"), d.join("wt"));
        std::fs::create_dir_all(&clone).unwrap();
        let g = |dir: &Path, args: &[&str]| git(dir, args).unwrap();
        g(&clone, &["init", "-q", "-b", "main"]);
        std::fs::write(clone.join("a.txt"), "one\n").unwrap();
        g(&clone, &["add", "a.txt"]);
        g(&clone, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
        let head = g(&clone, &["rev-parse", "HEAD"]).trim().to_string();
        g(&clone, &["worktree", "add", "-q", "--detach", wt.to_str().unwrap(), &head]);
        (d, wt, head)
    }

    #[test]
    fn work_in_reads_edits_and_commits_from_git_now() {
        let (d, wt, head) = repo_with_worktree("work");
        let w = work_in(&wt, &head).unwrap();
        assert_eq!((w.ahead, w.changed, w.head.as_str()), (0, 0, head.as_str()));
        // Edits made by hand (say in an editor), never seen by refresh().
        std::fs::write(wt.join("a.txt"), "two\n").unwrap();
        std::fs::create_dir_all(wt.join("new")).unwrap();
        std::fs::write(wt.join("new/b.txt"), "b\n").unwrap();
        assert_eq!(work_in(&wt, &head).unwrap().changed, 2);
        git(&wt, &["add", "-A"]).unwrap();
        git(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fix"]).unwrap();
        let w = work_in(&wt, &head).unwrap();
        assert_eq!((w.ahead, w.changed), (1, 0));
        assert_ne!(w.head, head);
        // A reviewed sha git doesn't have is an error, not "nothing ahead".
        assert!(work_in(&wt, "0123456789abcdef0123456789abcdef01234567").is_err());
        // No worktree (never made, or already gone): nothing to lose.
        assert_eq!(work_in(&d.join("missing"), &head).unwrap(), Work::default());
        assert_eq!(work_in(Path::new(""), &head).unwrap(), Work::default());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unpushed_counts_commits_made_after_a_push() {
        let (d, wt, head) = repo_with_worktree("push");
        let commit = |args: &[&str]| {
            let mut a = vec!["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q"];
            a.extend_from_slice(args);
            git(&wt, &a).unwrap();
        };
        std::fs::write(wt.join("a.txt"), "fix\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        commit(&["-m", "fix"]);
        let w = work_in(&wt, &head).unwrap();
        // As review_push leaves it.
        let mut j = Job { ahead: 1, pushed: true, pushed_sha: w.head.clone(), ..Default::default() };
        assert_eq!(unpushed(&j, &w), 0);
        apply(&mut j, &w);
        assert!(j.pushed);
        // An amend keeps the count at 1 but is not what was pushed.
        std::fs::write(wt.join("a.txt"), "fix, amended\n").unwrap();
        git(&wt, &["add", "-A"]).unwrap();
        commit(&["--amend", "-m", "fix"]);
        let w = work_in(&wt, &head).unwrap();
        assert_eq!(w.ahead, 1);
        assert_eq!(unpushed(&j, &w), 1);
        apply(&mut j, &w);
        assert!(!j.pushed);
        // A card pushed before pushed_sha existed counts as unpushed.
        let old = Job { ahead: 1, pushed: true, ..Default::default() };
        assert_eq!(unpushed(&old, &w), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn remove_refuses_more_than_was_confirmed() {
        // Confirmed exactly what is there, or more: go ahead.
        assert_eq!(refuse_remove(&Ok((0, 0)), 0, 0, false), None);
        assert_eq!(refuse_remove(&Ok((2, 1)), 2, 1, false), None);
        // Edits made after the confirm was drawn.
        let why = refuse_remove(&Ok((3, 1)), 2, 1, false).unwrap();
        assert!(why.starts_with("nothing was removed"), "{why}");
        assert!(why.contains("3 files with uncommitted edits"), "{why}");
        assert!(refuse_remove(&Ok((0, 2)), 0, 1, false).is_some());
        // An unreadable worktree: refused until confirmed as such.
        let bad: Result<(u32, u32), String> = Err("git status: corrupt".into());
        let why = refuse_remove(&bad, 0, 0, false).unwrap();
        assert!(why.starts_with(UNREADABLE) && why.contains("corrupt"), "{why}");
        assert_eq!(refuse_remove(&bad, 0, 0, true), None);
        // `unreadable` alone does not cover work git can read.
        assert!(refuse_remove(&Ok((1, 0)), 0, 0, true).is_some());
    }

    #[test]
    fn at_stake_text_names_what_is_lost() {
        assert_eq!(at_stake_text(0, 0), "");
        assert_eq!(at_stake_text(1, 0), "1 file with uncommitted edits");
        assert_eq!(at_stake_text(3, 2), "3 files with uncommitted edits and 2 unpushed commits");
    }

    #[test]
    fn same_target_matches_a_pr_or_its_branch() {
        let j = Job {
            repo: "rickykoter/seamux".into(),
            pr: Some(100),
            branch: "app-open-at-login".into(),
            ..Default::default()
        };
        let t = |s: &str| parse_target(s).unwrap();
        assert!(same_target(&j, &t("rickykoter/seamux#100")));
        assert!(same_target(&j, &t("RickyKoter/seamux@app-open-at-login")));
        assert!(!same_target(&j, &t("rickykoter/seamux#101")));
        assert!(!same_target(&j, &t("rickykoter/other#100")));
    }
}
