//! The app's watch on merges (plan landing). Every EVERY it reads each
//! workspace's PR list (crew-sync's, through crew_core::prs). A merged PR
//! with its merge commit, merged within the last day and not seen before,
//! is landed: the watcher fetches the repo's kept checkout, asks deep-plan
//! which land recipes the merge reaches (`deep-plan land plan`), and starts
//! them one after another as one detached process (`deep-plan land run`
//! each), in a process group of its own so it outlives the app (a recipe
//! may restart the app). One landing per repo runs at a time; the next
//! waits, in merge order.
//!
//! crew-sync re-reads a list only every CREW_GH_INTERVAL, so each tick also
//! re-reads, on a thread of its own, every list that holds an open PR and
//! is over a minute old (fast_due, prs::refresh_known). Where gh can listen
//! (gh event listen, 2.105+), each open PR also has a `lookout gh listen`
//! (Ears): a heard change re-reads that list at once and wakes the tick.
//!
//! What it knows is kept in <crew home>/landings/index.json, so a merge
//! lands once across restarts; every read-change-write of it holds INDEX.
//! Each tick reads the landings it has not finished telling about, and
//! posts one banner when a merge is done, failed, stopped (its process died
//! before it finished), or waits on the person.
//!
//! The UI acts on a landing through land_act: approve (the person's yes,
//! `deep-plan land approve --by human`, then the recipe runs on), skip, and
//! retry. It acts only on a merge the watcher knows, in that merge's repo,
//! on one of its planned recipes, and starts nothing while another landing
//! runs in the repo.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use crew_core::landing;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::notify_app;

pub const EVERY: Duration = Duration::from_secs(30);
/// Merges older than this when first seen are left alone (a day's catch-up).
pub const CATCH_UP_SECS: i64 = 24 * 3600;
/// A start that failed (offline, a fetch or plan timeout) is tried again,
/// waiting 1, 2, 4 and 8 minutes; the fifth failure is told and left.
pub const MAX_TRIES: u32 = 5;
/// Finished entries older than this are dropped from the index.
pub const KEEP_SECS: i64 = 14 * 24 * 3600;

/// Every load-change-save of the index, the watcher's and land_act's alike.
static INDEX: Mutex<()> = Mutex::new(());

/// This app run: its pid and start time, so a pid the system reuses for a
/// later app never passes for the run that planned an entry.
fn me() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| format!("{}-{}", std::process::id(), crew_core::history::now_ms()))
}

/// Whether `pid` is alive and a seamux app (another one, or this one).
fn app_alive(pid: u32) -> bool {
    if pid == 0 || (unsafe { libc::kill(pid as i32, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM)) {
        return false;
    }
    crew_core::py::run("ps", &["-p", &pid.to_string(), "-o", "comm="], Duration::from_secs(5))
        .is_some_and(|(code, out, _)| code == 0 && out.contains("seamux"))
}

/// One merge the watcher knows of.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Entry {
    pub repo: String,
    pub key: String,
    pub merge: String,
    pub pr: u64,
    pub url: String,
    pub title: String,
    pub ws: String,
    pub cwd: String,
    /// When it merged (epoch s).
    pub at: i64,
    /// Started (epoch s), 0 while it waits for its repo.
    pub started: i64,
    /// The detached process landing it.
    pub pid: u32,
    /// The app process fetching and planning it (pid 0 meanwhile), and
    /// that app run's token (its pid and start time): an entry whose planner
    /// is gone goes back to wait; one another live app plans holds its repo.
    pub planning: u32,
    pub planning_token: String,
    /// The recipes `land plan` gave.
    pub recipes: Vec<String>,
    /// The overall status last told in a banner (or "none", "error").
    pub told: String,
    /// For a told wait, its recipe and stage ("<recipe>@<stage>"), so a
    /// later wait at another recipe or stage is told too (plan
    /// landing-latency). Empty for any other status.
    pub told_wait: String,
    /// Why the last start failed; with `tries` and `next_try` (epoch s).
    pub error: String,
    pub tries: u32,
    pub next_try: i64,
    /// The person took a failed or stopped landing off the card.
    pub dismissed: bool,
}

pub type Index = BTreeMap<String, Entry>;

fn index_path(home: &Path) -> PathBuf {
    home.join("landings").join("index.json")
}

pub fn load(home: &Path) -> Index {
    std::fs::read_to_string(index_path(home)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(home: &Path, idx: &Index) {
    let p = index_path(home);
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(home));
    let tmp = p.with_extension(format!("tmp-{}", std::process::id()));
    if let Ok(t) = serde_json::to_string_pretty(idx) {
        if std::fs::write(&tmp, t).is_ok() && std::fs::rename(&tmp, &p).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Change the index under INDEX and an flock on index.lock beside it (two
/// apps can run at once, each with its own INDEX): loaded, changed, saved
/// when it changed. The flock goes with the file descriptor, so a crash
/// gives it back.
fn with_index<T>(home: &Path, f: impl FnOnce(&mut Index) -> T) -> T {
    use std::os::unix::io::AsRawFd;
    let _held = INDEX.lock().unwrap_or_else(|p| p.into_inner());
    let dir = home.join("landings");
    let _ = std::fs::create_dir_all(&dir);
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("index.lock")).ok();
    if let Some(l) = &lock {
        unsafe { libc::flock(l.as_raw_fd(), libc::LOCK_EX) };
    }
    let mut idx = load(home);
    let before = idx.clone();
    let out = f(&mut idx);
    if idx != before {
        save(home, &idx);
    }
    out
}

/// Whether `pid` is a landing this app started: alive, and running
/// `deep-plan ... land run` (a pid the system reused for something else is
/// not one).
fn ours(pid: u32) -> bool {
    if pid == 0 || (unsafe { libc::kill(pid as i32, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM)) {
        return false;
    }
    crew_core::py::run("ps", &["-p", &pid.to_string(), "-o", "command="], Duration::from_secs(5))
        .is_some_and(|(code, out, _)| code == 0 && out.contains("land run"))
}

/// A merged PR a workspace made, as the watcher sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Seen {
    pub ws: String,
    pub cwd: String,
    pub pr: u64,
    pub url: String,
    pub title: String,
    pub merge: String,
    pub at: i64,
}

/// The merges in `prs` (one workspace's list) worth landing at `now`:
/// merged, with a merge commit, within CATCH_UP_SECS.
pub fn merges_in(ws: &str, cwd: &str, prs: &[Value], now: i64) -> Vec<Seen> {
    prs.iter()
        .filter_map(|p| {
            let m = crew_core::prs::merge_of(p)?;
            let at = landing::iso_secs(&m.at)?;
            (now - at <= CATCH_UP_SECS && at <= now + 300).then(|| Seen {
                ws: ws.into(), cwd: cwd.into(), pr: crew_core::prs::number(p),
                url: p.get("url").and_then(Value::as_str).unwrap_or("").into(),
                title: p.get("title").and_then(Value::as_str).unwrap_or("").into(),
                merge: m.sha, at,
            })
        })
        .collect()
}

/// Whether an entry is being planned now: by this app run (its token), or
/// by another seamux app that is alive.
fn planning_now(e: &Entry, token: &str, app_alive: &dyn Fn(u32) -> bool) -> bool {
    e.started > 0 && e.pid == 0 && e.told.is_empty() && e.error.is_empty() && (e.planning_token == token || app_alive(e.planning))
}

/// Whether an entry holds its repo now: a landing of ours running, or a
/// live app fetching and planning it.
pub fn holds(e: &Entry, token: &str, ours: &dyn Fn(u32) -> bool, app_alive: &dyn Fn(u32) -> bool) -> bool {
    if e.pid > 0 { ours(e.pid) } else { planning_now(e, token, app_alive) }
}

/// An entry whose planner is gone (an app that quit mid-fetch or mid-plan)
/// goes back to wait, so it is started again. One another live app is
/// planning is left to it.
pub fn unstick(idx: &mut Index, token: &str, app_alive: &dyn Fn(u32) -> bool) {
    for e in idx.values_mut().filter(|e| e.started > 0 && e.pid == 0 && e.told.is_empty() && e.error.is_empty()) {
        if !planning_now(e, token, app_alive) {
            e.started = 0;
            e.planning = 0;
            e.planning_token.clear();
        }
    }
}

/// The repos with a landing running now.
pub fn busy<'a>(idx: &'a Index, running: &dyn Fn(&Entry) -> bool) -> BTreeSet<&'a str> {
    idx.values().filter(|e| e.started > 0 && running(e)).map(|e| e.repo.as_str()).collect()
}

/// Which waiting entries start now: the oldest merge of each repo with no
/// landing running, at most one per repo, a failed start once its wait is
/// over and while it has tries left.
pub fn due(idx: &Index, running: &dyn Fn(&Entry) -> bool, now: i64) -> Vec<String> {
    let busy = busy(idx, running);
    let mut waiting: Vec<&Entry> = idx.values().filter(|e| e.started == 0 && e.tries < MAX_TRIES && e.next_try <= now).collect();
    waiting.sort_by_key(|e| e.at);
    let mut taken: BTreeSet<&str> = BTreeSet::new();
    waiting.into_iter()
        .filter(|e| !busy.contains(e.repo.as_str()) && taken.insert(e.repo.as_str()))
        .map(|e| format!("{}/{}", e.key, e.merge))
        .collect()
}

/// How a merge is named in a banner: #PR, else its short commit.
fn label(e: &Entry) -> String {
    if e.pr > 0 { format!("#{}", e.pr) } else { e.merge.chars().take(7).collect() }
}

/// A wait's place: its recipe and stage.
fn wait_key(o: &landing::Overall) -> String {
    format!("{}@{}", o.recipe, o.stage)
}

/// Whether a landing's status now is news against what was last told. A
/// running landing never is. A wait is news when its recipe and stage
/// differ from the last wait told, even when no tick saw the landing run
/// between the two; any other status is news once.
pub fn is_news(e: &Entry, o: &landing::Overall) -> bool {
    match o.status {
        "landing" => false,
        "awaiting" => e.told != "awaiting" || e.told_wait != wait_key(o),
        s => s != e.told,
    }
}

/// Record that `o` was told.
pub fn mark_told(e: &mut Entry, o: &landing::Overall) {
    e.told = o.status.to_string();
    e.told_wait = if o.status == "awaiting" { wait_key(o) } else { String::new() };
}

/// What a finished telling looks like: a banner's title and body for an
/// overall status, or None for one that is not news.
pub fn banner(e: &Entry, o: &landing::Overall) -> Option<(String, String)> {
    let pr = label(e);
    let what = if e.title.is_empty() { String::new() } else { format!(" {}", e.title) };
    match o.status {
        "done" => Some((format!("{pr} is live"), format!("{pr}{what} landed{}", if o.live { ", and the live version is the merge" } else { "" }))),
        "failed" => Some((format!("{pr} · landing failed"), format!("{} failed at {}", o.recipe, o.stage))),
        "awaiting" => Some((format!("{pr} · landing needs you"), format!("{} waits at {}: approve or skip it", o.recipe, o.stage))),
        "stopped" => Some((format!("{pr} · landing stopped"), format!("{} stopped{}: retry it to go on", o.recipe,
                                                                         if o.stage.is_empty() { String::new() } else { format!(" at {}", o.stage) }))),
        _ => None,
    }
}

/// What a merge's landing says now: its state file read against the
/// recipes planned, and "stopped" when it is still landing but no process
/// of ours is running it (it died, or the machine restarted).
pub fn status_of(e: &Entry, state: Option<&Value>, running: bool) -> landing::Overall {
    let o = match state {
        Some(s) => landing::overall_of(s, &e.recipes),
        None => landing::Overall { status: "landing", stage: String::new(), recipe: e.recipes.first().cloned().unwrap_or_default(), live: false },
    };
    if o.status == "landing" && !running {
        return landing::Overall { status: "stopped", ..o };
    }
    o
}

/// Single-quoted for sh.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// deep-plan, run as the person: never with CLAUDECODE, whatever the app
/// was started from (land approve refuses inside a Claude session).
fn node_dp(args: &[&str], timeout: Duration) -> Result<String, String> {
    let script = crew_core::dp_engine::script();
    let mut all = vec!["-u".to_string(), "CLAUDECODE".into(), "node".into(), script.to_string_lossy().into_owned()];
    all.extend(args.iter().map(|a| a.to_string()));
    let refs: Vec<&str> = all.iter().map(String::as_str).collect();
    let (code, out, err) = crew_core::py::run("env", &refs, timeout).ok_or("deep-plan did not run (no node, or it timed out)")?;
    if code == 0 { Ok(out) } else { Err(err.trim().lines().last().unwrap_or("deep-plan failed").to_string()) }
}

/// The PATH a landing runs with: the person's login shell's first, then the
/// app's. A landing runs as the person, and a recipe's tools (cargo for
/// install.sh --app, gh, jq) live where their terminal finds them; an app
/// opened from Finder has launchd's PATH plus node's folder (main.rs
/// adopt_login_path), which has none of them. Asked of the shell once.
fn run_path() -> String {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = crew_core::py::env_or("SHELL").unwrap_or_else(|| "/bin/zsh".into());
        // An interactive login shell, since asdf and nvm hook in from .zshrc;
        // the last line, since a shell may print a banner before it.
        let login = crew_core::py::run(&shell, &["-ilc", "printf '%s' \"$PATH\""], Duration::from_secs(5))
            .filter(|(code, _, _)| *code == 0)
            .and_then(|(_, out, _)| out.lines().last().map(|l| l.trim().to_string()))
            .unwrap_or_default();
        join_path(&login, &std::env::var("PATH").unwrap_or_default())
    })
    .clone()
}

/// `first`'s folders, then `then`'s not already in it, in order.
pub fn join_path(first: &str, then: &str) -> String {
    let mut seen = BTreeSet::new();
    first.split(':').chain(then.split(':')).filter(|d| !d.is_empty() && seen.insert(*d)).collect::<Vec<_>>().join(":")
}

/// Start `deep-plan land run` for each recipe, one after another, as one
/// detached process in its own process group (it outlives the app). The
/// pid, or None when it could not start.
pub fn spawn_runs(repo: &str, merge: &str, pr: u64, recipes: &[String]) -> Option<u32> {
    let script = crew_core::dp_engine::script();
    let line = recipes
        .iter()
        .map(|r| {
            let mut c = format!("node {} land run --repo {} --merge {} --recipe {}", shq(&script.to_string_lossy()), shq(repo), shq(merge), shq(r));
            if pr > 0 {
                c.push_str(&format!(" --pr {pr}"));
            }
            c
        })
        .collect::<Vec<_>>()
        .join("; ");
    let mut child = Command::new("sh")
        .args(["-c", &line])
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // A landing is the person's, run as them, never as a Claude session.
        .env_remove("CLAUDECODE")
        .env("PATH", run_path())
        .process_group(0)
        .spawn()
        .ok()?;
    let pid = child.id();
    // Reaped while the app runs; after it quits, launchd adopts it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Some(pid)
}

/// Fetch and plan one landing: the recipes, or why not. Run outside the
/// index lock (it can take a minute).
fn plan(e: &Entry) -> Result<Vec<String>, String> {
    let _ = crew_core::py::run("git", &["-C", &e.repo, "fetch", "--quiet", "origin"], Duration::from_secs(90));
    let out = node_dp(&["land", "plan", "--repo", &e.repo, "--merge", &e.merge, "--json"], Duration::from_secs(60))?;
    let p = serde_json::from_str::<Value>(&out).map_err(|_| "land plan printed no JSON".to_string())?;
    Ok(p.get("recipes").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|r| r.get("key").and_then(Value::as_str).map(String::from)).collect())
}

fn tick(app: &AppHandle, keys: &mut HashMap<String, (String, String)>) {
    let home = landing::home();
    let now = crew_core::history::now_ms() as i64 / 1000;
    let rows = crew_core::backend::open(seamux_app::backend::kind()).and_then(|b| b.workspaces()).unwrap_or_default();
    let lists: Vec<(String, Option<Value>)> = rows.iter().filter(|w| !w.cwd.is_empty()).map(|w| (w.cwd.clone(), crew_core::prs::read(&w.cwd))).collect();
    listen(&lists);
    let hot: Vec<String> = std::mem::take(&mut EARS.lock().unwrap_or_else(|p| p.into_inner()).hot).into_iter().collect();
    fast_refresh(fast_due(&lists, now), hot);
    let mut seen: Vec<(String, Entry)> = Vec::new();
    for w in rows.iter().filter(|w| !w.cwd.is_empty()) {
        for s in merges_in(&w.id, &w.cwd, &crew_core::prs::list(&w.cwd), now) {
            // The repo's kept checkout and its key, once per worktree.
            let (repo, key) = match keys.get(&s.cwd) {
                Some(v) => v.clone(),
                None => {
                    let Ok((_, repo, _)) = crew_core::workspace_open::worktree_facts(Path::new(&s.cwd)) else { continue };
                    let v = (repo.to_string_lossy().into_owned(), landing::repo_key(&repo));
                    keys.insert(s.cwd.clone(), v.clone());
                    v
                }
            };
            let id = format!("{key}/{}", s.merge);
            seen.push((id, Entry { repo, key, merge: s.merge, pr: s.pr, url: s.url, title: s.title, ws: s.ws, cwd: s.cwd, at: s.at, ..Default::default() }));
        }
    }
    // New merges join; one per idle repo is marked started and saved before
    // anything runs, so a restart mid-tick never starts it twice.
    let starting: Vec<Entry> = with_index(&home, |idx| {
        for (id, e) in seen {
            idx.entry(id).or_insert(e);
        }
        idx.retain(|_, e| now - e.at <= KEEP_SECS || (e.started > 0 && ours(e.pid)));
        unstick(idx, me(), &app_alive);
        let mut out = Vec::new();
        for id in due(idx, &|e| holds(e, me(), &ours, &app_alive), now) {
            if let Some(e) = idx.get_mut(&id) {
                e.started = now;
                e.planning = std::process::id();
                e.planning_token = me().to_string();
                out.push(e.clone());
            }
        }
        out
    });
    for e in starting {
        let id = format!("{}/{}", e.key, e.merge);
        let planned = plan(&e);
        let pid = match &planned {
            Ok(r) if !r.is_empty() => spawn_runs(&e.repo, &e.merge, e.pr, r),
            _ => None,
        };
        let note = with_index(&home, |idx| {
            let Some(x) = idx.get_mut(&id) else { return None };
            match planned {
                Ok(r) if r.is_empty() => { x.recipes = r; x.told = "none".into(); None }
                Ok(r) => {
                    x.recipes = r;
                    match pid {
                        Some(p) => { x.pid = p; x.error.clear(); None }
                        None => fail(x, "could not start deep-plan land run", now),
                    }
                }
                Err(err) => fail(x, &err, now),
            }
        });
        if let Some(n) = note {
            notify_app::post_note(app, &n);
        }
    }
    // Tell what changed: once per overall status, once per wait, and never
    // while it runs.
    let home2 = home.clone();
    let notes: Vec<notify_app::Note> = with_index(&home, |idx| {
        let mut out = Vec::new();
        for e in idx.values_mut().filter(|e| e.started > 0 && e.pid > 0 && e.told != "none") {
            let state = landing::read(&home2, &e.key, &e.merge);
            let o = status_of(e, state.as_ref(), ours(e.pid));
            if !is_news(e, &o) {
                continue;
            }
            if let Some((title, body)) = banner(e, &o) {
                out.push(notify_app::landing_note(&e.ws, title, body));
            }
            mark_told(e, &o);
        }
        out
    });
    for n in notes {
        notify_app::post_note(app, &n);
    }
}

/// A list that holds a PR still able to merge is re-read this often, so a
/// merge starts landing within about two minutes rather than waiting on
/// crew-sync's CREW_GH_INTERVAL (plan landing-latency).
pub const FAST_SECS: i64 = 60;

/// The worktrees whose PR lists are due a fast re-read at `now`: each list
/// holds a PR that is open or a draft and was read (by crew-sync or a fast
/// re-read, prs::last_read) over FAST_SECS ago. A
/// worktree with no list is crew-sync's to start. Each once, in order.
pub fn fast_due(lists: &[(String, Option<Value>)], now: i64) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (cwd, list) in lists {
        let Some(l) = list else { continue };
        let at = crew_cli::sync::prs::last_read(l);
        let prs = l.get("prs").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        if now as f64 - at > FAST_SECS as f64 && crew_cli::sync::prs::has_open(prs) && !out.contains(cwd) {
            out.push(cwd.clone());
        }
    }
    out
}

/// Re-read the due lists on a thread of its own, one run at a time: a slow
/// GitHub never piles runs up or holds the tick. The next tick reads what
/// it wrote. crew-sync (sync_watch on tmux, crew-listen on cmux) still owns
/// the full refresh; lookout's own floor keeps the two from asking twice.
/// `hot` lists, whose PR a listener heard change, are read at once and past
/// that floor, and then the watcher is woken to land what they say.
fn fast_refresh(due: Vec<String>, hot: Vec<String>) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if (due.is_empty() && hot.is_empty()) || RUNNING.swap(true, Ordering::SeqCst) {
        // A hot list a running pass missed waits for the next tick.
        let mut ears = EARS.lock().unwrap_or_else(|p| p.into_inner());
        ears.hot.extend(hot);
        return;
    }
    std::thread::spawn(move || {
        for cwd in &hot {
            let _ = std::panic::catch_unwind(|| crew_cli::sync::prs::refresh_known(cwd, 0, true));
        }
        if !hot.is_empty() {
            wake();
        }
        for cwd in due.iter().filter(|c| !hot.contains(c)) {
            let _ = std::panic::catch_unwind(|| crew_cli::sync::prs::refresh_known(cwd, FAST_SECS, false));
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------- listen

/// The most open PRs heard at once: one `lookout gh listen` (one gh) each.
pub const LISTEN_MAX: usize = 12;
/// How long one listen runs before the next tick starts it afresh.
const LISTEN_SECS: u64 = 600;
/// Failures in a row that may pass before listening goes off for this run.
pub const LISTEN_TRANSIENT_MAX: u32 = 3;

/// The watcher's listeners on open PRs (plan landing-latency): `lookout gh
/// listen`, which waits on gh event listen (gh 2.105+). Where gh cannot
/// listen, listening goes off for this app run and the minute re-read
/// carries on alone.
#[derive(Debug, Default)]
pub struct Ears {
    /// PR URLs with a listener running.
    pub live: BTreeSet<String>,
    /// Worktrees whose PR a listener heard change: re-read at once.
    pub hot: BTreeSet<String>,
    /// Why listening is off for this app run; empty while it is on.
    pub off: String,
    /// Failures in a row that may pass.
    pub transient: u32,
}

static EARS: Mutex<Ears> = Mutex::new(Ears { live: BTreeSet::new(), hot: BTreeSet::new(), off: String::new(), transient: 0 });

impl Ears {
    /// The open PRs to start listening on now, as (url, worktree): each
    /// open or draft PR in the lists not heard yet, up to LISTEN_MAX in all.
    pub fn wanted(&self, lists: &[(String, Option<Value>)]) -> Vec<(String, String)> {
        if !self.off.is_empty() {
            return Vec::new();
        }
        let mut out: Vec<(String, String)> = Vec::new();
        for (cwd, list) in lists {
            let prs = list.as_ref().and_then(|l| l.get("prs")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            for url in crew_cli::sync::prs::open_urls(prs) {
                if self.live.len() + out.len() >= LISTEN_MAX {
                    return out;
                }
                if !self.live.contains(&url) && !out.iter().any(|(u, _)| *u == url) {
                    out.push((url, cwd.clone()));
                }
            }
        }
        out
    }

    /// One listener on `url` (in worktree `cwd`) ended with lookout's exit
    /// `code`: 0 heard a change, 2 heard none in time, 3 gh cannot listen
    /// here, anything else a failure that may pass. A line to log once when
    /// this turns listening off.
    pub fn ended(&mut self, url: &str, cwd: &str, code: Option<i32>, why: &str) -> Option<String> {
        self.live.remove(url);
        match code {
            Some(0) => {
                self.transient = 0;
                self.hot.insert(cwd.to_string());
                None
            }
            Some(2) => {
                self.transient = 0;
                None
            }
            Some(3) => self.turn_off(why),
            _ => {
                self.transient += 1;
                if self.transient >= LISTEN_TRANSIENT_MAX { self.turn_off(why) } else { None }
            }
        }
    }

    fn turn_off(&mut self, why: &str) -> Option<String> {
        if !self.off.is_empty() {
            return None;
        }
        self.off = if why.is_empty() { "lookout gh listen failed".into() } else { why.to_string() };
        Some(format!("land_watch: not listening for merges ({}); the minute re-read goes on", self.off))
    }
}

/// Start a listener for each open PR not heard yet, each on a thread that
/// waits on its `lookout gh listen` and records how it ended.
fn listen(lists: &[(String, Option<Value>)]) {
    let wanted = EARS.lock().unwrap_or_else(|p| p.into_inner()).wanted(lists);
    if wanted.is_empty() {
        return;
    }
    let Some(bin) = crew_cli::sync::prs::lookout_bin() else { return };
    for (url, cwd) in wanted {
        let child = Command::new(&bin)
            .args(["gh", "listen", &url, "--timeout", &LISTEN_SECS.to_string(), "--cwd", &cwd, "--json"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .env_remove("CLAUDECODE")
            .env("PATH", run_path())
            .spawn();
        let Ok(child) = child else { continue };
        EARS.lock().unwrap_or_else(|p| p.into_inner()).live.insert(url.clone());
        std::thread::spawn(move || {
            let (code, why) = match child.wait_with_output() {
                Ok(o) => (o.status.code(), String::from_utf8_lossy(&o.stderr).trim().trim_start_matches("lookout gh listen: ").to_string()),
                Err(e) => (None, e.to_string()),
            };
            let (log, heard) = {
                let mut ears = EARS.lock().unwrap_or_else(|p| p.into_inner());
                (ears.ended(&url, &cwd, code, &why), code == Some(0))
            };
            if let Some(line) = log {
                eprintln!("{line}");
            }
            if heard {
                wake();
            }
        });
    }
}

/// The watcher's sleep between ticks, which a heard change cuts short.
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

fn wake() {
    let (m, cv) = &WAKE;
    *m.lock().unwrap_or_else(|p| p.into_inner()) = true;
    cv.notify_all();
}

/// Sleep up to `d`, or until woken.
fn nap(d: Duration) {
    let (m, cv) = &WAKE;
    let g = m.lock().unwrap_or_else(|p| p.into_inner());
    let (mut g, _) = cv.wait_timeout_while(g, d, |woke| !*woke).unwrap_or_else(|p| p.into_inner());
    *g = false;
}

/// A failed start: tried again after a growing wait, and told (once) when
/// it has no tries left. The banner to post, if any.
fn fail(e: &mut Entry, why: &str, now: i64) -> Option<notify_app::Note> {
    e.error = why.to_string();
    e.tries += 1;
    e.started = 0;
    e.next_try = now + 60 * (1 << (e.tries.min(4) - 1)) as i64;
    (e.tries >= MAX_TRIES).then(|| {
        e.told = "error".into();
        notify_app::landing_note(&e.ws, format!("{} · couldn't land", label(e)), why.to_string())
    })
}

pub fn start_watch(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(25));
        let mut keys = HashMap::new();
        loop {
            tick(&app, &mut keys);
            nap(EVERY);
        }
    });
}

// ---------------------------------------------------------------- commands

/// A worktree's kept checkout and repo key, asked of git once per worktree:
/// the Lookout tab and the Wake read every merged PR's landing often.
fn repo_of(cwd: &str) -> Result<(PathBuf, String), String> {
    static FACTS: Mutex<BTreeMap<String, (PathBuf, String)>> = Mutex::new(BTreeMap::new());
    if let Some(v) = FACTS.lock().unwrap_or_else(|p| p.into_inner()).get(cwd) {
        return Ok(v.clone());
    }
    let (_, repo, _) = crew_core::workspace_open::worktree_facts(Path::new(cwd)).map_err(|e| e.to_string())?;
    let v = (repo.clone(), landing::repo_key(&repo));
    FACTS.lock().unwrap_or_else(|p| p.into_inner()).insert(cwd.to_string(), v.clone());
    Ok(v)
}

/// The index entry for `merge` whose repo is `cwd`'s, if the watcher knows it.
fn known(cwd: &str, merge: &str) -> Result<(PathBuf, Entry), String> {
    let (repo, key) = repo_of(cwd)?;
    let id = format!("{key}/{merge}");
    let e = load(&landing::home()).remove(&id).ok_or("the app has not landed that merge")?;
    if Path::new(&e.repo) != repo {
        return Err("that merge belongs to another checkout".into());
    }
    Ok((repo, e))
}

/// A merge's landing for the UI: its state file and its overall status, or
/// null when none was started. `cwd` is any worktree of the repo.
pub fn landing_of(cwd: &str, merge: &str) -> Option<Value> {
    let (repo, key) = repo_of(cwd).ok()?;
    let state = landing::read(&landing::home(), &key, merge)?;
    let entry = load(&landing::home()).remove(&format!("{key}/{merge}"));
    let o = match &entry {
        Some(e) => status_of(e, Some(&state), ours(e.pid)),
        None => landing::overall(&state),
    };
    Some(json!({"state": state, "overall": {"status": o.status, "stage": o.stage, "recipe": o.recipe, "live": o.live},
                "repo": repo, "key": key}))
}

/// The person's answer to a recipe's landing: approve (their yes for its
/// writing steps, then it runs on), skip, or retry. Only for a merge the
/// watcher knows, in its own repo, on one of its planned recipes; nothing
/// starts while another landing runs in that repo.
pub fn act(cwd: &str, merge: &str, recipe: &str, what: &str) -> Result<String, String> {
    if !merge.chars().all(|c| c.is_ascii_hexdigit()) || merge.len() != 40 {
        return Err("not a merge commit".into());
    }
    let (repo, e) = known(cwd, merge)?;
    if what == "dismiss" {
        let id = format!("{}/{}", e.key, e.merge);
        with_index(&landing::home(), |idx| {
            if let Some(x) = idx.get_mut(&id) {
                x.dismissed = true;
            }
        });
        return Ok("taken off the card".into());
    }
    if !e.recipes.iter().any(|r| r == recipe) {
        return Err(format!("{recipe} is not one of this merge's recipes"));
    }
    let repo = repo.to_string_lossy().into_owned();
    let id = format!("{}/{}", e.key, e.merge);
    let run = |label: &str| -> Result<String, String> {
        let home = landing::home();
        with_index(&home, |idx| {
            if busy(idx, &|x| holds(x, me(), &ours, &app_alive)).contains(repo.as_str()) {
                return Err("another landing is running in this repo: try again when it ends".to_string());
            }
            let pid = spawn_runs(&repo, merge, e.pr, &[recipe.to_string()]).ok_or("could not start the run")?;
            if let Some(x) = idx.get_mut(&id) {
                // Tracked like the watcher's own, told afresh, and back on the card.
                x.pid = pid;
                x.told.clear();
                x.told_wait.clear();
                x.dismissed = false;
            }
            Ok(label.to_string())
        })
    };
    match what {
        "approve" => {
            node_dp(&["land", "approve", "--repo", &repo, "--merge", merge, "--recipe", recipe, "--by", "human"], Duration::from_secs(30))?;
            run(&format!("approved {recipe}; it runs on"))
        }
        "retry" => run(&format!("retrying {recipe}")),
        "skip" => node_dp(&["land", "skip", "--repo", &repo, "--merge", merge, "--recipe", recipe], Duration::from_secs(30)).map(|_| format!("skipped {recipe}")),
        _ => Err(format!("unknown answer: {what}")),
    }
}

/// Every workspace's pull requests (crew-sync's lists), each with the
/// worktree and workspace it came from: the Lookout tab's rows for PRs no
/// review covers, and how it finds a review's merge.
pub fn workspace_prs() -> Vec<Value> {
    let rows = crew_core::backend::open(seamux_app::backend::kind()).and_then(|b| b.workspaces()).unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for w in rows.iter().filter(|w| !w.cwd.is_empty()) {
        for mut p in crew_core::prs::list(&w.cwd) {
            let url = p.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            if url.is_empty() || !seen.insert(url) {
                continue;
            }
            p["cwd"] = json!(w.cwd);
            p["ws"] = json!(w.id);
            p["ws_title"] = json!(w.title);
            out.push(p);
        }
    }
    out
}

/// The last lines of a recipe's land log. The path is the state file's, and
/// is read only inside crew's landings folder.
pub fn log_of(cwd: &str, merge: &str, recipe: &str) -> Result<String, String> {
    let v = landing_of(cwd, merge).ok_or("no landing for that merge")?;
    let log = v["state"]["recipes"][recipe]["log"].as_str().ok_or("no log for that recipe")?.to_string();
    let base = landing::home().join("landings");
    let p = std::fs::canonicalize(&log).map_err(|e| e.to_string())?;
    if !p.starts_with(std::fs::canonicalize(&base).map_err(|e| e.to_string())?) {
        return Err("that log is not a landing's".into());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = text.lines().collect();
    Ok(lines[lines.len().saturating_sub(300)..].join("\n"))
}

#[tauri::command]
pub async fn landing_prs() -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(workspace_prs).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn landing_log(cwd: String, merge: String, recipe: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || log_of(&cwd, &merge, &recipe)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn landing_get(cwd: String, merge: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || landing_of(&cwd, &merge)).await.map_err(|e| e.to_string())
}

/// What `deep-plan ship` would do for the worktree at `cwd`: the change's
/// level on the repo policy (read from the base branch) and the gates ship
/// waits on, for the Merge stage. A dry run: it opens, readies and merges
/// nothing. Run as the person, with their login PATH, since it asks gh.
fn ship_of(cwd: &str) -> Result<Value, String> {
    let path = format!("PATH={}", run_path());
    let script = crew_core::dp_engine::script().to_string_lossy().into_owned();
    let args = ["-u", "CLAUDECODE", path.as_str(), "node", script.as_str(), "ship", "--at", cwd, "--dry-run", "--json"];
    let (code, out, err) = crew_core::py::run("env", &args, Duration::from_secs(45)).ok_or("deep-plan did not run (no node, or it timed out)")?;
    if code != 0 {
        return Err(err.trim().lines().last().unwrap_or("deep-plan ship failed").to_string());
    }
    serde_json::from_str(out.trim()).map_err(|e| format!("deep-plan ship's verdict was not JSON: {e}"))
}

#[tauri::command]
pub async fn ship_view(cwd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || ship_of(&cwd)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn land_act(cwd: String, merge: String, recipe: String, act: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || self::act(&cwd, &merge, &recipe, &act)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(n: u64, state: &str, sha: &str, at: &str) -> Value {
        json!({"n": n, "state": state, "url": format!("https://github.com/o/r/pull/{n}"), "title": format!("pr {n}"),
               "merge": {"sha": sha, "at": at, "base": "main"}})
    }
    const NOW: i64 = 1794555060 + 3600; // an hour after 2026-11-13T07:31:00Z

    #[test]
    fn only_recent_merges_with_a_commit_are_landed() {
        let a = "a".repeat(40);
        let prs = vec![pr(1, "merged", &a, "2026-11-13T07:31:00Z"), pr(2, "merged", &a, "2026-11-11T07:31:00Z"),
                       pr(3, "open", &a, "2026-11-13T07:31:00Z"), pr(4, "merged", "abc", "2026-11-13T07:31:00Z")];
        let got = merges_in("W", "/w", &prs, NOW);
        assert_eq!(got.iter().map(|s| s.pr).collect::<Vec<_>>(), vec![1], "two days old, open, and a short sha are left");
        assert_eq!((got[0].ws.as_str(), got[0].merge.as_str(), got[0].at), ("W", a.as_str(), 1794555060));
    }

    fn entry(repo: &str, merge: &str, at: i64, started: i64, pid: u32) -> Entry {
        Entry { repo: repo.into(), key: format!("k{repo}"), merge: merge.into(), at, started, pid, ..Default::default() }
    }

    #[test]
    fn one_landing_per_repo_at_a_time_oldest_first() {
        let mut idx = Index::new();
        for e in [entry("r1", "m2", 20, 0, 0), entry("r1", "m1", 10, 0, 0), entry("r2", "m3", 30, 0, 0), entry("r3", "m4", 5, 0, 0), entry("r3", "m0", 1, 100, 77)] {
            idx.insert(format!("{}/{}", e.key, e.merge), e);
        }
        let running = |e: &Entry| e.pid == 77;
        assert_eq!(due(&idx, &running, 0), vec!["kr1/m1".to_string(), "kr2/m3".to_string()], "r3 is busy; r1 starts its oldest");
        let none = |_: &Entry| false;
        assert!(due(&idx, &none, 0).contains(&"kr3/m4".to_string()), "a finished run frees its repo");
    }

    #[test]
    fn a_failed_start_is_tried_again_later_then_told_once() {
        let mut e = entry("r", "m", 1, 50, 0);
        let mut told = Vec::new();
        for k in 1..=MAX_TRIES {
            if let Some(n) = fail(&mut e, "offline", 1000) {
                told.push(n.title);
            }
            assert_eq!((e.tries, e.started), (k, 0));
        }
        assert_eq!(told, vec!["m · couldn't land".to_string()], "one banner, at the last try; a merge with no PR is its short commit");
        let mut idx = Index::new();
        let mut w = entry("r2", "m2", 1, 0, 0);
        fail(&mut w, "timeout", 1000);
        idx.insert("kr2/m2".into(), w.clone());
        let none = |_: &Entry| false;
        assert!(due(&idx, &none, 1000).is_empty(), "it waits out its minute");
        assert_eq!(due(&idx, &none, 1060), vec!["kr2/m2".to_string()]);
        idx.insert("kr/m".into(), e);
        assert!(!due(&idx, &none, 99_999).contains(&"kr/m".to_string()), "no tries left: left alone");
    }

    #[test]
    fn a_landing_whose_process_died_reads_as_stopped() {
        let e = Entry { recipes: vec!["seamux".into()], pr: 228, ..Default::default() };
        let running = json!({"recipes": {"seamux": {"key": "seamux", "status": "running", "stages": [{"name": "install", "status": "running"}]}}});
        assert_eq!(status_of(&e, Some(&running), true).status, "landing");
        let o = status_of(&e, Some(&running), false);
        assert_eq!((o.status, o.stage.as_str()), ("stopped", "install"));
        assert_eq!(banner(&e, &o).unwrap().0, "#228 · landing stopped");
        assert_eq!(status_of(&e, None, false).status, "stopped", "died before writing anything");
        let done = json!({"recipes": {"seamux": {"key": "seamux", "status": "done", "stages": []}}});
        assert_eq!(status_of(&e, Some(&done), false).status, "done");
    }

    fn listed(prs: &[(u64, &str)]) -> Option<Value> {
        Some(json!({"at": 0.0, "prs": prs.iter().map(|(n, st)| json!({"n": n, "url": format!("https://github.com/o/r/pull/{n}"), "state": st})).collect::<Vec<_>>()}))
    }

    #[test]
    fn the_ears_hear_each_open_pr_once_up_to_the_cap() {
        let u = |n: u64| format!("https://github.com/o/r/pull/{n}");
        let lists = vec![("/w/a".to_string(), listed(&[(1, "open"), (2, "merged"), (3, "draft")])), ("/w/b".to_string(), listed(&[(1, "open"), (4, "closed")])),
                         ("/w/c".to_string(), None)];
        let mut ears = Ears::default();
        assert_eq!(ears.wanted(&lists), vec![(u(1), "/w/a".to_string()), (u(3), "/w/a".to_string())], "open and draft only, each PR once");
        ears.live.insert(u(1));
        assert_eq!(ears.wanted(&lists), vec![(u(3), "/w/a".to_string())], "a PR already heard is not heard twice");
        let many: Vec<(u64, &str)> = (10..40).map(|n| (n, "open")).collect();
        assert_eq!(Ears::default().wanted(&[("/w/m".to_string(), listed(&many))]).len(), LISTEN_MAX);
        ears.off = "gh too old".into();
        assert!(ears.wanted(&lists).is_empty(), "off: no new listeners");
    }

    #[test]
    fn a_heard_change_is_hot_and_a_refusal_or_three_failures_turn_listening_off() {
        let mut ears = Ears::default();
        ears.live.insert("u1".into());
        assert_eq!(ears.ended("u1", "/w/a", Some(0), ""), None);
        assert!(ears.hot.contains("/w/a") && ears.live.is_empty(), "heard: re-read /w/a at once");
        assert_eq!(ears.ended("u2", "/w/b", Some(2), ""), None);
        assert!(!ears.hot.contains("/w/b"), "no change in time: nothing to re-read");
        assert_eq!(ears.ended("u3", "/w/b", Some(1), "HTTP 502"), None);
        assert_eq!(ears.ended("u3", "/w/b", Some(2), ""), None, "a quiet end clears the count");
        assert_eq!(ears.ended("u3", "/w/b", Some(1), "HTTP 502"), None);
        assert_eq!(ears.ended("u3", "/w/b", Some(1), "HTTP 502"), None);
        assert!(ears.ended("u3", "/w/b", None, "HTTP 502").unwrap().contains("HTTP 502"), "the third failure in a row turns it off, said once");
        let mut old = Ears::default();
        assert!(old.ended("u", "/w", Some(3), "unknown command \"event\" for \"gh\"").unwrap().contains("unknown command"));
        assert_eq!(old.ended("u", "/w", Some(3), "again"), None, "off is said once");
        assert_eq!(old.off, "unknown command \"event\" for \"gh\"");
    }

    #[test]
    fn every_new_wait_is_told_once_and_a_running_landing_never() {
        let o = |status: &'static str, recipe: &str, stage: &str| landing::Overall { status, stage: stage.into(), recipe: recipe.into(), live: false };
        let mut e = Entry { pr: 9, ..Default::default() };
        let mut told = Vec::new();
        // Ticks: A waits, A still waits, B waits (A ran and finished between
        // two ticks, so no tick saw it run), B runs, B waits at a recut
        // stage, done, done again.
        for x in [o("awaiting", "a", "notebook"), o("awaiting", "a", "notebook"), o("awaiting", "b", "deploy"), o("landing", "b", "deploy"),
                  o("awaiting", "b", "live"), o("done", "", ""), o("done", "", "")] {
            if is_news(&e, &x) {
                told.push(format!("{} {}", x.status, wait_key(&x)));
                mark_told(&mut e, &x);
            }
        }
        assert_eq!(told, vec!["awaiting a@notebook", "awaiting b@deploy", "awaiting b@live", "done @"]);
        assert!(e.told_wait.is_empty(), "only a wait keeps its place");
    }

    #[test]
    fn an_older_index_entry_reads_with_no_told_wait() {
        let e: Entry = serde_json::from_value(json!({"merge": "m", "told": "awaiting"})).unwrap();
        assert_eq!((e.told.as_str(), e.told_wait.as_str()), ("awaiting", ""));
        let o = landing::Overall { status: "awaiting", stage: "nb".into(), recipe: "r".into(), live: false };
        assert!(is_news(&e, &o), "an entry from before told_wait tells its wait once more, then keeps it");
    }

    #[test]
    fn banners_say_live_failed_or_needs_you_and_nothing_while_running() {
        let e = Entry { pr: 228, title: "bash-guard".into(), ..Default::default() };
        let o = |status: &'static str, live: bool| landing::Overall { status, stage: "install".into(), recipe: "seamux".into(), live };
        assert_eq!(banner(&e, &o("done", true)).unwrap().0, "#228 is live");
        assert!(banner(&e, &o("done", true)).unwrap().1.contains("the live version is the merge"));
        assert_eq!(banner(&e, &o("failed", false)).unwrap(), ("#228 · landing failed".into(), "seamux failed at install".into()));
        assert!(banner(&e, &o("awaiting", false)).unwrap().0.contains("needs you"));
        assert!(banner(&e, &o("landing", false)).is_none());
    }

    #[test]
    fn the_index_round_trips_whole_and_reads_older_entries() {
        let d = std::env::temp_dir().join(format!("land-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let mut idx = Index::new();
        idx.insert("k/m".into(), entry("r", "m", 1, 2, 3));
        save(&d, &idx);
        assert_eq!(load(&d), idx);
        std::fs::write(index_path(&d), r#"{"k/m": {"repo": "r", "merge": "m"}}"#).unwrap();
        assert_eq!(load(&d)["k/m"].tries, 0, "a field it lacks takes its default");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_planning_entry_holds_its_repo_and_one_left_by_a_quit_app_waits_again() {
        let not_ours = |_: u32| false;
        let mut planning = entry("r", "m1", 1, 100, 0);
        planning.planning = 4242;
        planning.planning_token = "4242-1".into();
        let mut idx = Index::new();
        idx.insert("kr/m1".into(), planning.clone());
        idx.insert("kr/m0".into(), entry("r", "m0", 0, 0, 0));
        // This app run planning it: the repo is busy, an older merge waits.
        let none_alive = |_: u32| false;
        assert!(holds(&planning, "4242-1", &not_ours, &none_alive));
        assert!(due(&idx, &|e| holds(e, "4242-1", &not_ours, &none_alive), 0).is_empty());
        // Another seamux app, alive, planning it: left to it, and busy.
        let alive_4242 = |p: u32| p == 4242;
        let mut other = idx.clone();
        unstick(&mut other, "9999-5", &alive_4242);
        assert_eq!(other["kr/m1"].started, 100, "a live app's planning is left alone");
        assert!(due(&other, &|e| holds(e, "9999-5", &not_ours, &alive_4242), 0).is_empty());
        // Its planner gone (quit, or its pid reused by something else): back to wait.
        let mut after = idx.clone();
        unstick(&mut after, "9999-5", &none_alive);
        assert_eq!((after["kr/m1"].started, after["kr/m1"].planning, after["kr/m1"].planning_token.as_str()), (0, 0, ""));
        assert_eq!(due(&after, &|e| holds(e, "9999-5", &not_ours, &none_alive), 0), vec!["kr/m0".to_string()], "oldest first again");
        // A new app that got the old pid has another token: not taken for the planner.
        assert!(!holds(&planning, "4242-77", &not_ours, &none_alive));
    }

    #[test]
    fn a_pid_that_is_not_a_landing_is_not_ours() {
        assert!(!ours(0));
        assert!(!ours(std::process::id()), "the test runner is alive but no landing");
    }

    /// Live: the detached run lands a recipe in a throwaway repo, through
    /// this worktree's deep-plan, with every store under a temp folder (L8).
    #[test]
    fn a_detached_run_lands_and_the_ui_reads_it() {
        let engine = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../deep-plan");
        if Command::new("node").arg("--version").output().is_err() || !engine.join("deep_plan.mjs").is_file() {
            return;
        }
        let d = std::env::temp_dir().join(format!("land-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let repo = d.join("r");
        std::fs::create_dir_all(repo.join(".seamux")).unwrap();
        std::fs::create_dir_all(repo.join("app")).unwrap();
        std::fs::write(repo.join(".seamux/verify.json"), r#"{"recipes": [{"id": "ship", "kind": "land", "match": ["app/**"],
            "steps": [{"stage": "deploy", "run": "echo v-$MERGE_SHA", "export": "LIVE"}],
            "outputs": {"version": {"expect": "v-$MERGE_SHA", "live": "$LIVE"}}}]}"#).unwrap();
        std::fs::write(repo.join("app/a.txt"), "a").unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(["-c", "user.email=p@x", "-c", "user.name=p"]).args(args).current_dir(&repo).output().unwrap().status.success());
        git(&["init", "-q", "-b", "main"]);
        git(&["add", "-A"]);
        git(&["commit", "-q", "-m", "one"]);
        std::fs::write(repo.join("app/a.txt"), "b").unwrap();
        git(&["commit", "-q", "-am", "two"]);
        let merge = String::from_utf8(Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&repo).output().unwrap().stdout).unwrap().trim().to_string();
        // The engine is this worktree's; its pointer and state stay in d.
        std::env::set_var("DEEP_PLAN_ENGINE", &engine);
        std::env::set_var("DEEP_PLAN_ENGINE_FILE", d.join("engine.json"));
        std::env::set_var("DEEP_PLAN_STATE_DIR", d.join("dp-state"));
        std::env::set_var("CREW_DURABLE_DIR", d.join("crew"));
        let pid = spawn_runs(&repo.to_string_lossy(), &merge, 7, &["ship".to_string()]).expect("started");
        assert!(pid > 0);
        let mut got = None;
        for _ in 0..100 {
            got = landing_of(&repo.to_string_lossy(), &merge).filter(|v| v["overall"]["status"] == "done");
            if got.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let v = got.expect("landed within ten seconds");
        assert_eq!(v["state"]["recipes"]["ship"]["version"]["live"].as_str(), Some(format!("v-{merge}").as_str()));
        assert_eq!((v["overall"]["live"].as_bool(), v["state"]["pr"].as_str()), (Some(true), Some("7")));
        // land_act answers only for a merge the watcher knows.
        assert_eq!(act(&repo.to_string_lossy(), &merge, "ship", "retry"), Err("the app has not landed that merge".to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_list_with_an_open_pr_is_due_a_minute_after_its_read_and_others_never() {
        let l = |at: f64, states: &[&str]| -> Option<Value> {
            Some(json!({"at": at, "prs": states.iter().enumerate().map(|(i, s)| json!({"n": i + 1, "state": s})).collect::<Vec<_>>()}))
        };
        let lists = vec![
            ("/w/open".to_string(), l(1000.0, &["merged", "open"])),
            ("/w/draft".to_string(), l(1000.0, &["draft"])),
            ("/w/fresh".to_string(), l(1000.0 + 30.0, &["open"])),
            ("/w/done".to_string(), l(0.0, &["merged", "closed"])),
            ("/w/none".to_string(), None),
            ("/w/open".to_string(), l(1000.0, &["open"])),
            ("/w/fast".to_string(), Some(json!({"at": 0.0, "fast_at": 1000.0 + 30.0, "prs": [{"n": 1, "state": "open"}]}))),
        ];
        assert_eq!(fast_due(&lists, 1000 + FAST_SECS), Vec::<String>::new(), "exactly a minute old is not yet due");
        assert_eq!(fast_due(&lists, 1000 + FAST_SECS + 1), vec!["/w/open", "/w/draft"], "open or draft, over a minute old, each once");
        assert_eq!(fast_due(&lists, 1000 + FAST_SECS + 31), vec!["/w/open", "/w/draft", "/w/fresh", "/w/fast"], "a fast re-read's own stamp counts");
    }

    #[test]
    fn a_landing_path_puts_the_login_shells_folders_first_once_each() {
        assert_eq!(join_path("/h/.cargo/bin:/usr/bin", "/usr/bin:/bin:/h/.cargo/bin"), "/h/.cargo/bin:/usr/bin:/bin");
        assert_eq!(join_path("", "/usr/bin:/bin"), "/usr/bin:/bin", "no login PATH: the app's alone");
        assert_eq!(join_path("/a::/b", ""), "/a:/b");
    }

    #[test]
    fn a_runs_command_line_quotes_what_it_is_given() {
        assert_eq!(shq("it's"), "'it'\\''s'");
    }
}
