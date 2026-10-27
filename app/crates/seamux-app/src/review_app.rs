//! The Lookout tab's commands: paste a repo or branch, review it headlessly in
//! a throwaway worktree, then edit, comment or fix from what was found.
//!
//! A review is the same pipeline the lookout skill describes, run by the app
//! so no terminal is needed: `lookout open`, then ONE fresh reviewer (`claude
//! -p`) briefed with exactly `lookout prompt`. What leaves the machine (a
//! comment, a push) is a separate command the page calls after a click.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
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
    pub pushed: bool,
    /// The URL of the GitHub review the comments went out in.
    pub posted: String,
    /// When the current status began, for the tab's elapsed time.
    pub stage_at: u64,
    /// What a running agent did last ("reading shell.rs"), or "".
    pub activity: String,
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

fn jobs() -> &'static Mutex<Vec<Job>> {
    JOBS.get_or_init(|| {
        let mut v: Vec<Job> = std::fs::read_to_string(base_dir().join("jobs.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        // A job that was mid-flight when the app quit has no process left.
        for j in v
            .iter_mut()
            .filter(|j| !matches!(j.status.as_str(), "ready" | "failed"))
        {
            j.status = "failed".into();
            j.detail = "the app quit while this was running".into();
        }
        for j in v.iter_mut() {
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

fn publish(all: &[Job]) {
    let _ = std::fs::create_dir_all(base_dir());
    let _ = std::fs::write(
        base_dir().join("jobs.json"),
        serde_json::to_string(all).unwrap_or_default(),
    );
    if let Some(app) = APP.get() {
        let _ = app.emit("review:frame", all);
    }
}

fn update(id: &str, f: impl FnOnce(&mut Job)) {
    let all = {
        let Ok(mut g) = jobs().lock() else { return };
        if let Some(j) = g.iter_mut().find(|j| j.id == id) {
            f(j);
        }
        g.clone()
    };
    publish(&all);
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
    let all = {
        let mut g = jobs().lock().map_err(|e| e.to_string())?;
        let j = g.iter_mut().find(|j| j.id == id).ok_or("no such review")?;
        if j.status != "ready" {
            return Err("the review isn't ready yet".into());
        }
        if !j.busy.is_empty() {
            return Err(format!("still {}", j.busy));
        }
        j.busy = what.into();
        g.clone()
    };
    publish(&all);
    get(id)
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
    exec_lines(program, args, cwd, stdin, limit, None)
}

/// `exec`, with each line of stdout also handed to `on_line` as it arrives.
fn exec_lines(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    stdin: Option<&str>,
    limit: Duration,
    on_line: Option<LineFn>,
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
        .stderr(Stdio::piped());
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    let mut child = c
        .spawn()
        .map_err(|e| format!("couldn't start {program}: {e}"))?;
    if let (Some(text), Some(mut si)) = (stdin, child.stdin.take()) {
        let text = text.to_string();
        std::thread::spawn(move || {
            let _ = si.write_all(text.as_bytes());
        });
    }
    let so = child.stdout.take().ok_or("no stdout")?;
    let ho = match on_line {
        Some(f) => drain_lines(so, f),
        None => drain(so),
    };
    let he = drain(child.stderr.take().ok_or("no stderr")?);
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Ok(Some(s)) = child.try_wait() {
            break s;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{program} took longer than {} minutes and was stopped",
                limit.as_secs() / 60
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    Ok(Out {
        code: status.code().unwrap_or(-1),
        out: ho.join().unwrap_or_default(),
        err: he.join().unwrap_or_default(),
    })
}

fn drain_lines<R: Read + Send + 'static>(r: R, mut f: LineFn) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut all = String::new();
        for line in BufReader::new(r).lines().map_while(Result::ok) {
            f(&line);
            all.push_str(&line);
            all.push('\n');
        }
        all
    })
}

fn drain<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = r.read_to_end(&mut b);
        String::from_utf8_lossy(&b).into_owned()
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
    let o = exec_lines("claude", &args, Some(wt), Some(prompt), limit, on_line)?;
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

/// Re-read what the worktree and the store now say.
fn refresh(id: &str) {
    let Ok(j) = get(id) else { return };
    let wt = PathBuf::from(&j.wt);
    let ahead = git(
        &wt,
        &["rev-list", "--count", &format!("{}..HEAD", j.head_sha)],
    )
    .ok()
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(0);
    let dirty = git(&wt, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
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
        j.ahead = ahead;
        j.dirty = dirty;
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

#[tauri::command]
pub fn review_start(input: String, depth: String, model: String) -> Result<String, String> {
    let t = parse_target(&input)?;
    if t.what == What::Default {
        return Err("name a branch or a pull request: owner/repo@branch, owner/repo#123, or a /tree/ or /pull/ URL".into());
    }
    if !DEPTHS.contains(&depth.as_str()) || !MODELS.contains(&model.as_str()) {
        return Err("unknown depth or model".into());
    }
    // One card per branch or pull request: reviewing it again replaces the
    // old run (its worktree too), unless that run has work not yet pushed.
    let same: Vec<Job> = snapshot()
        .into_iter()
        .filter(|j| same_target(j, &t))
        .collect();
    for j in &same {
        if !j.busy.is_empty() || !matches!(j.status.as_str(), "ready" | "failed") {
            return Err("that one is still running".into());
        }
        if j.dirty || (j.ahead > 0 && !j.pushed) {
            return Err("its last review has fixes that are not pushed: push them, or remove that review first".into());
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
    let all = {
        let mut g = jobs().lock().map_err(|e| e.to_string())?;
        g.retain(|x| !same.iter().any(|o| o.id == x.id));
        g.push(job);
        g.clone()
    };
    publish(&all);
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
        let r = git(
            Path::new(&j.wt),
            &["push", &j.remote, &format!("HEAD:refs/heads/{}", j.branch)],
        );
        match r {
            Ok(_) => {
                note(
                    &j.id,
                    &format!("pushed {} commit(s) to {}", j.ahead, j.branch),
                );
                update(&j.id, |x| x.pushed = true);
            }
            Err(e) => note(&j.id, &e),
        }
        release(&j.id);
    });
    Ok(())
}

/// Forget a review and delete its worktree. Unpushed commits go with it.
#[tauri::command]
pub fn review_remove(id: String) -> Result<(), String> {
    let j = get(&id)?;
    if !j.busy.is_empty() || !matches!(j.status.as_str(), "ready" | "failed") {
        return Err("it is still running".into());
    }
    discard(&j);
    let all = {
        let mut g = jobs().lock().map_err(|e| e.to_string())?;
        g.retain(|x| x.id != id);
        g.clone()
    };
    publish(&all);
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
