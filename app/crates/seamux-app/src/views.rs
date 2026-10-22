//! What the views show beyond the panes: every decision waiting on the
//! person, oldest first, recent Wake rows, and the state history.
//!
//! The decisions come from files other tools keep, read fresh each build:
//! - an agent's AskUserQuestion: question-<ws>.json beside the question-<ws>
//!   marker, both written by the crew ask hook;
//! - a turn that ended on a question: asked-<ws>, its text the question;
//! - a deep-plan increment with checks only the person can record, or a plan
//!   waiting for its next go (`deep-plan status --json`);
//! - a lookout review with findings addressed and left for the person to close.
//!
//! Only decisions in a workspace with a live pane are shown: a plan or a
//! review whose worktree has no agent any more is not waiting on anyone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use crew_core::history::{self, Entry};
use serde::Serialize;
use serde_json::Value;

use crate::wall::Tile;

/// How far back the frame's history reaches: Timeline's window.
pub const HISTORY_WINDOW: Duration = Duration::from_secs(2 * 3600);
/// Wake rows in a frame.
pub const WAKE_ROWS: usize = 40;
/// How long a poll-seen change waits for a hook to report it before the
/// poll records it itself.
pub const GAP_GRACE: Duration = Duration::from_secs(5);
/// A hook line this close to a poll-seen change is the same change.
pub const GAP_MATCH_MS: u64 = 15_000;

/// One option of an agent's question.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Opt {
    pub label: String,
    pub description: String,
}

/// One question of an AskUserQuestion call.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Question {
    pub question: String,
    pub header: String,
    #[serde(rename = "multiSelect")]
    pub multi_select: bool,
    pub options: Vec<Opt>,
}

/// A check on a plan increment that only the person can record.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Check {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub status: String,
}

/// Something waiting on the person. `ws` and `surface` name the pane it
/// belongs to; `since` is when it started waiting (ms since the epoch).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Decision {
    /// An agent's AskUserQuestion, open in its pane.
    Question { ws: String, surface: String, since: u64, questions: Vec<Question> },
    /// A turn ended on a question in prose.
    Asked { ws: String, surface: String, since: u64, question: String },
    /// A deep-plan increment whose checks are the person's, or a plan waiting for go.
    Gate {
        ws: String,
        surface: String,
        since: u64,
        slug: String,
        /// The open increment, or the next one when none is open.
        n: u64,
        title: String,
        done: u64,
        total: u64,
        /// The open increment's checks still waiting on the person.
        checks: Vec<Check>,
        /// No increment is open and one is next: go next is the person's.
        ready: bool,
    },
    /// A lookout review with findings addressed and left to close.
    Review {
        ws: String,
        surface: String,
        since: u64,
        id: String,
        title: String,
        plan: String,
        inc: u64,
        addressed: u64,
        open: u64,
    },
}

impl Decision {
    pub fn since(&self) -> u64 {
        match self {
            Decision::Question { since, .. }
            | Decision::Asked { since, .. }
            | Decision::Gate { since, .. }
            | Decision::Review { since, .. } => *since,
        }
    }
}

/// A Wake row, for the away strip and Timeline's ticks.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct WakeRow {
    pub id: i64,
    pub kind: String,
    pub title: String,
    /// The row's worktree directory.
    pub dir: String,
    /// The live workspace that directory is open in, when there is one.
    pub ws: Option<String>,
    /// ms since the epoch, or 0 when the row's time does not parse.
    pub at: u64,
}

/// One history line, as the page gets it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Change {
    pub at: u64,
    pub ws: String,
    pub surface: String,
    pub state: String,
    pub source: String,
    pub detail: String,
}

impl From<&Entry> for Change {
    fn from(e: &Entry) -> Change {
        Change {
            at: e.at,
            ws: e.ws.clone(),
            surface: e.surface.clone(),
            state: e.state.clone(),
            source: e.source.clone(),
            detail: e.detail.clone(),
        }
    }
}

/// The `views:frame` payload.
#[derive(Clone, Debug, Serialize, PartialEq, Default)]
pub struct ViewsFrame {
    pub decisions: Vec<Decision>,
    pub wake: Vec<WakeRow>,
    pub history: Vec<Change>,
    /// What could not be read this time, for the page to say.
    pub problems: Vec<String>,
}

/// Where the feed reads. `live()` is this machine's; tests point at fixtures.
pub struct Inputs {
    /// The crew hooks' state dir (~/.cache/cmux-crew).
    pub state_dir: PathBuf,
    /// lookout's reviews dir.
    pub reviews_dir: PathBuf,
    pub history_dir: PathBuf,
    /// `deep-plan status --json`'s rows.
    pub plans: Box<dyn Fn() -> Result<Vec<Value>, String> + Send + Sync>,
    /// The Artifact Log's newest rows.
    pub wake: Box<dyn Fn(usize) -> Result<Vec<crew_store::Row>, String> + Send + Sync>,
}

impl Inputs {
    pub fn live() -> Inputs {
        Inputs {
            state_dir: crew_core::home::xdg_cache(),
            reviews_dir: crew_board::review::reviews_dir(),
            history_dir: history::dir(),
            plans: Box::new(plans_now),
            wake: Box::new(|n| crew_store::search("", None, None, n).map_err(|e| e.to_string())),
        }
    }
}

/// `deep-plan status --json`, through the engine crew resolves.
fn plans_now() -> Result<Vec<Value>, String> {
    let script = crew_core::dp_engine::script();
    let (code, out, err) = crew_core::py::run("node", &[&script.to_string_lossy(), "status", "--json"], Duration::from_secs(15))
        .ok_or("deep-plan status did not run (no node, or it timed out)")?;
    if code != 0 {
        return Err(format!("deep-plan status failed: {}", err.trim().lines().last().unwrap_or("")));
    }
    match serde_json::from_str::<Value>(&out) {
        Ok(Value::Array(rows)) => Ok(rows),
        _ => Err("deep-plan status printed no plans".into()),
    }
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).map(ms).unwrap_or(0)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// `/a/b/` and `/a/b` as one path, symlinks resolved in the longest part
/// that exists (a worktree's subdirectory may be gone while its root is
/// not, and /var is /private/var).
fn canon(p: &str) -> String {
    let p = Path::new(p.trim_end_matches('/'));
    let mut rest = Vec::new();
    let mut at = p;
    loop {
        if let Ok(c) = std::fs::canonicalize(at) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out.to_string_lossy().into_owned();
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                at = parent;
            }
            _ => return p.to_string_lossy().into_owned(),
        }
    }
}

/// The live panes, as the merge needs them.
struct Panes<'a> {
    tiles: &'a [Tile],
    /// Each tile's cwd, canonical.
    cwds: Vec<String>,
}

impl<'a> Panes<'a> {
    fn new(tiles: &'a [Tile]) -> Panes<'a> {
        Panes { tiles, cwds: tiles.iter().map(|t| canon(&t.cwd)).collect() }
    }

    /// The workspace as cmux spells it now, when a pane lives in it. UUIDs
    /// compare without case: a hook may have seen another spelling.
    fn live_ws(&self, ws: &str) -> Option<String> {
        if ws.is_empty() {
            return None;
        }
        self.tiles.iter().find(|t| t.workspace.eq_ignore_ascii_case(ws)).map(|t| t.workspace.clone())
    }

    /// The agent pane in `ws` (the first one), else any pane there.
    fn surface_in(&self, ws: &str) -> String {
        let in_ws = || self.tiles.iter().filter(|t| t.workspace.eq_ignore_ascii_case(ws));
        in_ws().find(|t| t.agent.is_some()).or_else(|| in_ws().next()).map(|t| t.surface.clone()).unwrap_or_default()
    }

    /// The workspace whose pane works in `dir` or under it; an agent pane wins.
    fn ws_for_dir(&self, dir: &str) -> Option<String> {
        if dir.is_empty() {
            return None;
        }
        let d = canon(dir);
        let under = |c: &str| c == d || c.starts_with(&format!("{d}/"));
        let hits: Vec<&Tile> = self.tiles.iter().zip(&self.cwds).filter(|(_, c)| under(c)).map(|(t, _)| t).collect();
        hits.iter().find(|t| t.agent.is_some()).or(hits.first()).map(|t| t.workspace.clone())
    }

    /// The live surface a question file names, else the workspace's agent pane.
    fn surface_or(&self, ws: &str, named: &str) -> String {
        match self.tiles.iter().find(|t| !named.is_empty() && t.workspace.eq_ignore_ascii_case(ws) && t.surface.eq_ignore_ascii_case(named)) {
            Some(t) => t.surface.clone(),
            None => self.surface_in(ws),
        }
    }
}

/// The workspace a hook file names: `<prefix><ws>`, the rest a UUID.
fn ws_of(name: &str, prefix: &str, suffix: &str) -> Option<String> {
    let ws = name.strip_prefix(prefix)?.strip_suffix(suffix)?;
    cmux::is_uuid(ws).then(|| ws.to_string())
}

fn questions_of(v: &Value) -> Vec<Question> {
    v.get("questions")
        .and_then(Value::as_array)
        .map(|qs| {
            qs.iter()
                .map(|q| Question {
                    question: s(q, "question"),
                    header: s(q, "header"),
                    multi_select: q.get("multiSelect").and_then(Value::as_bool).unwrap_or(false),
                    options: q
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().map(|o| Opt { label: s(o, "label"), description: s(o, "description") }).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Open questions and asked turns from the hooks' state dir.
fn hook_decisions(dir: &Path, panes: &Panes) -> Vec<Decision> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        if let Some(named) = ws_of(&name, "question-", ".json") {
            // The marker is the ask's truth (answered removes it); a .json
            // without it is left over.
            if !dir.join(format!("question-{named}")).exists() {
                continue;
            }
            let Some(ws) = panes.live_ws(&named) else { continue };
            let Some(v) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
                continue;
            };
            let questions = questions_of(&v);
            if questions.is_empty() {
                continue;
            }
            let since = match u(&v, "at") {
                0 => mtime_ms(&path),
                at => at,
            };
            out.push(Decision::Question { surface: panes.surface_or(&ws, &s(&v, "surface")), ws, since, questions });
        } else if let Some(named) = ws_of(&name, "asked-", "") {
            let Some(ws) = panes.live_ws(&named) else { continue };
            let question = std::fs::read_to_string(&path).unwrap_or_default().trim().to_string();
            out.push(Decision::Asked { surface: panes.surface_in(&ws), ws, since: mtime_ms(&path), question });
        }
    }
    out
}

/// Gates from deep-plan's status rows.
fn gate_decisions(plans: &[Value], panes: &Panes) -> Vec<Decision> {
    let mut out = Vec::new();
    for p in plans {
        if s(p, "phase") != "implementing" {
            continue;
        }
        let owner = p.get("owner").map(|o| s(o, "workspace")).unwrap_or_default();
        let ws = panes.live_ws(&owner).or_else(|| panes.ws_for_dir(&s(p, "root")));
        let Some(ws) = ws else { continue };
        let progress = p.get("progress").cloned().unwrap_or(Value::Null);
        let open = progress.get("open").and_then(Value::as_array).and_then(|a| a.first()).cloned();
        let next = progress.get("next").filter(|n| n.is_object()).cloned();
        let incs = p.get("increments").and_then(Value::as_array).cloned().unwrap_or_default();
        let (n, title, checks, ready) = match (open, next) {
            (Some(o), _) => {
                let n = u(&o, "n");
                let inc = incs.iter().find(|i| u(i, "n") == n).cloned().unwrap_or(Value::Null);
                let checks: Vec<Check> = inc
                    .get("checks")
                    .and_then(Value::as_array)
                    .map(|cs| {
                        cs.iter()
                            .filter(|c| matches!(s(c, "kind").as_str(), "manual" | "observability"))
                            .filter(|c| s(c, "status") != "pass")
                            .map(|c| Check { id: s(c, "id"), kind: s(c, "kind"), name: s(c, "name"), status: s(c, "status") })
                            .collect()
                    })
                    .unwrap_or_default();
                if checks.is_empty() {
                    continue; // the agent's to prove, not the person's
                }
                (n, s(&o, "title"), checks, false)
            }
            (None, Some(nx)) => (u(&nx, "n"), s(&nx, "title"), Vec::new(), true),
            (None, None) => continue,
        };
        out.push(Decision::Gate {
            surface: panes.surface_in(&ws),
            ws,
            since: u(p, "touchedAt"),
            slug: s(p, "slug"),
            n,
            title,
            done: u(&progress, "done"),
            total: u(&progress, "total"),
            checks,
            ready,
        });
    }
    out
}

/// One review file's summary, kept while its mtime holds.
#[derive(Clone)]
struct ReviewSummary {
    id: String,
    title: String,
    root: String,
    plan: String,
    inc: u64,
    addressed: u64,
    open: u64,
    since: u64,
}

fn summarize_review(text: &str, path: &Path) -> Option<ReviewSummary> {
    let v: Value = serde_json::from_str(text).ok()?;
    let src = v.get("source").cloned().unwrap_or(Value::Null);
    let findings = v.get("findings").and_then(Value::as_array).cloned().unwrap_or_default();
    let count = |st: &str| findings.iter().filter(|f| s(f, "status") == st).count() as u64;
    let updated = s(&v, "updatedAt");
    let since = crew_core::py::iso_timestamp(&updated).map(|t| (t * 1000.0) as u64).unwrap_or_else(|| mtime_ms(path));
    Some(ReviewSummary {
        id: s(&v, "id"),
        title: s(&v, "title"),
        root: s(&src, "root"),
        plan: s(&src, "plan"),
        inc: u(&src, "inc"),
        addressed: count("addressed"),
        open: count("open"),
        since,
    })
}

/// How long a `deep-plan status` answer is reused: it starts node.
pub const PLANS_TTL: Duration = Duration::from_secs(5);
/// How long the Wake rows are reused: the store opens SQLite and may wait
/// on the indexer's lock.
pub const WAKE_TTL: Duration = Duration::from_secs(15);

type Fetch<T> = Arc<dyn Fn() -> Result<T, String> + Send + Sync>;

#[derive(Default)]
struct SlowState<T> {
    last: Option<(Instant, Result<T, String>)>,
    busy: bool,
}

/// A source too slow for the feed's thread: `get` answers at once with the
/// last result, and when that is older than `ttl` starts one refresh on a
/// thread of its own. A hung source then holds back only itself.
struct Slow<T> {
    fetch: Fetch<T>,
    ttl: Duration,
    state: Arc<Mutex<SlowState<T>>>,
}

impl<T: Clone + Send + 'static> Slow<T> {
    fn new(fetch: Fetch<T>, ttl: Duration) -> Slow<T> {
        Slow { fetch, ttl, state: Arc::new(Mutex::new(SlowState { last: None, busy: false })) }
    }

    /// The last result, or None before the first one lands.
    fn get(&self) -> Option<Result<T, String>> {
        let mut st = self.state.lock().unwrap();
        let stale = st.last.as_ref().is_none_or(|(at, _)| at.elapsed() >= self.ttl);
        if stale && !st.busy {
            st.busy = true;
            let (fetch, state) = (self.fetch.clone(), self.state.clone());
            std::thread::spawn(move || {
                let r = fetch();
                let mut st = state.lock().unwrap();
                st.last = Some((Instant::now(), r));
                st.busy = false;
            });
        }
        st.last.as_ref().map(|(_, r)| r.clone())
    }

    /// Block until no refresh is running (at most `limit`). For tests.
    fn settle(&self, limit: Duration) {
        let end = Instant::now() + limit;
        while self.state.lock().unwrap().busy && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// The feed: builds a frame from its inputs and the live panes.
pub struct Feed {
    state_dir: PathBuf,
    reviews_dir: PathBuf,
    history_dir: PathBuf,
    reviews: Mutex<HashMap<PathBuf, (SystemTime, Option<ReviewSummary>)>>,
    plans: Slow<Vec<Value>>,
    wake: Slow<Vec<crew_store::Row>>,
}

impl Feed {
    pub fn new(inputs: Inputs) -> Feed {
        let wake = inputs.wake;
        Feed {
            state_dir: inputs.state_dir,
            reviews_dir: inputs.reviews_dir,
            history_dir: inputs.history_dir,
            reviews: Mutex::default(),
            plans: Slow::new(Arc::from(inputs.plans), PLANS_TTL),
            wake: Slow::new(Arc::new(move || wake(WAKE_ROWS)), WAKE_TTL),
        }
    }

    pub fn history_dir(&self) -> &Path {
        &self.history_dir
    }

    /// Start the slow sources and wait until they have answered (at most
    /// `limit`): the next build sees them. Tests and the first frame use it.
    pub fn prime(&self, limit: Duration) {
        let _ = (self.plans.get(), self.wake.get());
        self.plans.settle(limit);
        self.wake.settle(limit);
    }

    fn review_decisions(&self, panes: &Panes) -> Vec<Decision> {
        let Ok(rd) = std::fs::read_dir(&self.reviews_dir) else { return Vec::new() };
        let mut cache = self.reviews.lock().unwrap();
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            // The record only: not lookout's .incoming.json or .rows.json.
            if !name.ends_with(".json") || name.matches('.').count() != 1 {
                continue;
            }
            let path = e.path();
            let Ok(mtime) = e.metadata().and_then(|m| m.modified()) else { continue };
            seen.push(path.clone());
            let fresh = cache.get(&path).is_some_and(|(m, _)| *m == mtime);
            if !fresh {
                let sum = std::fs::read_to_string(&path).ok().and_then(|t| summarize_review(&t, &path));
                cache.insert(path.clone(), (mtime, sum));
            }
            let Some((_, Some(r))) = cache.get(&path) else { continue };
            if r.addressed == 0 {
                continue;
            }
            let Some(ws) = panes.ws_for_dir(&r.root) else { continue };
            out.push(Decision::Review {
                surface: panes.surface_in(&ws),
                ws,
                since: r.since,
                id: r.id.clone(),
                title: r.title.clone(),
                plan: r.plan.clone(),
                inc: r.inc,
                addressed: r.addressed,
                open: r.open,
            });
        }
        cache.retain(|p, _| seen.contains(p));
        out
    }

    /// Every decision, the Wake rows and the history window, for `tiles` at `now_ms`.
    pub fn build(&self, tiles: &[Tile], now_ms: u64) -> ViewsFrame {
        let panes = Panes::new(tiles);
        let mut problems = Vec::new();
        let mut decisions = hook_decisions(&self.state_dir, &panes);
        match self.plans.get() {
            Some(Ok(rows)) => decisions.extend(gate_decisions(&rows, &panes)),
            Some(Err(e)) => problems.push(e),
            None => {} // the first answer is on its way
        }
        decisions.extend(self.review_decisions(&panes));
        decisions.sort_by_key(|d| d.since());

        let wake = match self.wake.get() {
            None => Vec::new(),
            Some(Ok(rows)) => rows
                .iter()
                .map(|r| WakeRow {
                    id: r.id,
                    kind: r.kind.clone(),
                    title: if r.title.is_empty() { r.locator.clone() } else { r.title.clone() },
                    dir: r.ws.clone(),
                    ws: panes.ws_for_dir(&r.ws),
                    at: crew_core::py::iso_timestamp(&r.created_at).map(|t| (t * 1000.0) as u64).unwrap_or(0),
                })
                .collect(),
            Some(Err(e)) => {
                problems.push(format!("the Wake log: {e}"));
                Vec::new()
            }
        };

        let since = now_ms.saturating_sub(HISTORY_WINDOW.as_millis() as u64);
        let history = history::read_since(&self.history_dir, since).iter().map(Change::from).collect();
        ViewsFrame { decisions, wake, history, problems }
    }
}

/// Records the state changes the wall's poll sees that no hook reported
/// (a reply typed into a pane fires no hook, and cmux may notice a state
/// before the hook that causes it runs).
#[derive(Default)]
pub struct GapFill {
    /// Per surface: the state last seen.
    seen: Mutex<HashMap<String, String>>,
    /// Changes waiting out GAP_GRACE: (ws, surface, state, at).
    pending: Mutex<Vec<(String, String, String, u64)>>,
}

impl GapFill {
    /// Note the tiles' states; a change joins the pending list. The first
    /// sight of a pane is not a change.
    pub fn observe(&self, tiles: &[Tile], now_ms: u64) {
        let mut seen = self.seen.lock().unwrap();
        let mut pending = self.pending.lock().unwrap();
        for t in tiles.iter().filter(|t| t.agent.is_some() && history::STATES.contains(&t.state.as_str())) {
            let was = seen.insert(t.surface.clone(), t.state.clone());
            if was.is_some_and(|w| w != t.state) {
                pending.push((t.workspace.clone(), t.surface.clone(), t.state.clone(), now_ms));
            }
        }
        let live: Vec<&str> = tiles.iter().map(|t| t.surface.as_str()).collect();
        seen.retain(|s, _| live.contains(&s.as_str()));
    }

    /// Record each pending change older than GAP_GRACE unless a hook line
    /// for the same workspace and state lies within GAP_MATCH_MS of it.
    /// Returns how many lines the poll wrote.
    pub fn flush(&self, dir: &Path, now_ms: u64) -> usize {
        let grace = GAP_GRACE.as_millis() as u64;
        let due: Vec<(String, String, String, u64)> = {
            let mut pending = self.pending.lock().unwrap();
            let (due, wait): (Vec<_>, Vec<_>) = pending.drain(..).partition(|p| now_ms >= p.3 + grace);
            *pending = wait;
            due
        };
        if due.is_empty() {
            return 0;
        }
        let first = due.iter().map(|p| p.3).min().unwrap_or(now_ms);
        let known = history::read_since(dir, first.saturating_sub(GAP_MATCH_MS));
        let mut wrote = 0;
        for (ws, surface, state, at) in due {
            // A hook line names its pane when it knew it; then only that
            // pane's line counts, so another agent in the workspace does not
            // hide this one's change.
            let same_pane = |e: &Entry| e.surface.is_empty() || e.surface.eq_ignore_ascii_case(&surface);
            let reported = known.iter().any(|e| {
                e.ws.eq_ignore_ascii_case(&ws) && same_pane(e) && e.state == state && e.at.abs_diff(at) <= GAP_MATCH_MS
            });
            if reported {
                continue;
            }
            let e = Entry { at, ws, surface, state, source: "poll".into(), detail: "seen".into() };
            if history::append(dir, &e).is_ok() {
                wrote += 1;
            }
        }
        wrote
    }
}
