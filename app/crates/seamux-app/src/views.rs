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
pub const WAKE_ROWS: usize = 120;
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
    /// A plan family's next step: the members that can go now and the ones
    /// still waiting on the parent.
    Family { ws: String, surface: String, since: u64, parent: String, members: Vec<FamilyMember> },
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
            | Decision::Family { since, .. }
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

/// One plan of a family, as the views show it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FamilyMember {
    pub slug: String,
    /// parent or child
    pub role: String,
    pub phase: String,
    pub done: u64,
    pub total: u64,
    /// The open increment, else the next one; 0 when neither.
    pub n: u64,
    pub open: bool,
    /// The live workspace working on it.
    pub ws: Option<String>,
    /// The parent increments its go still waits on.
    pub waits: Vec<u64>,
    /// Its next increment can go now, as the engine reports it: the gate
    /// shut, a next increment named, nothing in the family waited on.
    pub ready: bool,
    /// Who gives its go: "parent" for a delegated child, else "human".
    pub go: String,
    /// The hold its family's parent wrote on it, or "".
    pub held: String,
    /// Each increment's verdicts, from its family field.
    pub increments: Vec<FamilyInc>,
}

/// One member increment's verdicts, as status --json's family field has them.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FamilyInc {
    pub n: u64,
    pub title: String,
    pub status: String,
    /// Every check folded to one word: pass, fail, pending.
    pub checks: String,
    /// The lookout review check's status, "" when it has none.
    pub review: String,
    /// Who gave its go: human, parent, self, or "".
    pub by: String,
}

/// A family: its parent and every member.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FamilyBrief {
    pub parent: String,
    pub members: Vec<FamilyMember>,
    /// Members whose plan is done, of all members.
    pub done: u64,
    pub total: u64,
}

/// The families among deep-plan's status rows, each member placed in its
/// live workspace (its owner's, else the pane working in its root).
pub fn families(rows: &[Value], tiles: &[Tile]) -> Vec<FamilyBrief> {
    let panes = Panes::new(tiles);
    let mut order: Vec<String> = Vec::new();
    let mut by: HashMap<String, Vec<FamilyMember>> = HashMap::new();
    for p in rows {
        let Some(f) = p.get("family").filter(|f| f.is_object()) else { continue };
        let parent = s(f, "parent");
        if parent.is_empty() {
            continue;
        }
        let ws = plan_ws(&panes, p);
        let progress = p.get("progress").cloned().unwrap_or(Value::Null);
        let open = progress.get("open").and_then(Value::as_array).and_then(|a| a.first()).cloned();
        let next = progress.get("next").filter(|n| n.is_object()).cloned();
        let waits: Vec<u64> = f.get("waitingOn").and_then(Value::as_array).map(|a| a.iter().map(|w| u(w, "n")).collect()).unwrap_or_default();
        let phase = s(p, "phase");
        let slug = s(p, "slug");
        // The engine's own verdicts, read and not re-derived: its gate says
        // nothing is authorized, it reports nothing open (so a missing gate
        // field, read as shut, still cannot offer go beside an open
        // increment), it names the next increment and the family field lists
        // nothing waited on.
        let gate_shut = !p.get("gate").and_then(|g| g.get("allow")).and_then(Value::as_bool).unwrap_or(false);
        let me = f.get("members").and_then(Value::as_array)
            .and_then(|ms| ms.iter().find(|m| s(m, "slug") == slug)).cloned().unwrap_or(Value::Null);
        let increments = me.get("increments").and_then(Value::as_array).map(|a| a.iter().map(|i| FamilyInc {
            n: u(i, "n"), title: s(i, "title"), status: s(i, "status"),
            checks: s(i, "checks"), review: s(i, "review"), by: s(i, "by"),
        }).collect()).unwrap_or_default();
        let m = FamilyMember {
            role: s(f, "role"),
            n: open.as_ref().or(next.as_ref()).map(|x| u(x, "n")).unwrap_or(0),
            open: open.is_some(),
            ready: phase == "implementing" && gate_shut && open.is_none() && next.is_some() && waits.is_empty(),
            go: if s(f, "go") == "parent" { "parent".into() } else { "human".into() },
            held: f.get("holds").and_then(|h| h.get(&slug)).and_then(Value::as_str).unwrap_or("").to_string(),
            increments,
            slug,
            phase,
            done: u(&progress, "done"),
            total: u(&progress, "total"),
            ws,
            waits,
        };
        if !by.contains_key(&parent) {
            order.push(parent.clone());
        }
        by.entry(parent).or_default().push(m);
    }
    order
        .into_iter()
        .map(|parent| {
            let mut members = by.remove(&parent).unwrap_or_default();
            // The parent first, then the children as deep-plan lists them.
            members.sort_by_key(|m| m.role != "parent");
            let done = members.iter().filter(|m| m.phase == "done").count() as u64;
            FamilyBrief { total: members.len() as u64, done, parent, members }
        })
        .collect()
}

/// A muted or tucked worktree, as the palette lists it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct TuckRow {
    pub path: String,
    pub level: crate::tuck::Level,
    pub at: u64,
    pub name: String,
    pub branch: String,
    /// The live workspaces working in it.
    pub workspaces: Vec<String>,
    /// One of them has a question or an asked turn open.
    pub waiting: bool,
    /// Its newest state change in the history, else when it was quieted.
    pub last: u64,
}

/// A workspace's plan, in brief.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct PlanBrief {
    pub ws: String,
    pub slug: String,
    pub phase: String,
    pub done: u64,
    pub total: u64,
    /// The open increment, else the next one; 0 when neither.
    pub n: u64,
    /// Whether `n` is open (authorized or working) rather than next.
    pub open: bool,
    pub title: String,
    pub touched: u64,
}

/// A workspace's newest lookout review, in brief.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ReviewBrief {
    pub ws: String,
    pub id: String,
    pub plan: String,
    pub inc: u64,
    pub open: u64,
    pub addressed: u64,
    /// Resolved or dismissed.
    pub closed: u64,
    pub since: u64,
}

/// A page a workspace has open now, for the chat sheet's tabs: its newest
/// plan, each lookout review not yet closed, and an ask still unanswered.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct NowPage {
    pub ws: String,
    /// "plan", "review" or "ask".
    pub kind: String,
    /// The intent server path: /plan/<slug>[.review.html], /review/<id>, /ask/<id>.
    pub path: String,
    pub label: String,
    /// A few words on where it stands: "working inc 2/5", "3 open", "waiting".
    pub state: String,
    /// It waits on the person: an ask, or a review with addressed findings.
    pub waiting: bool,
    pub since: u64,
}

/// The `views:frame` payload.
#[derive(Clone, Debug, Serialize, PartialEq, Default)]
pub struct ViewsFrame {
    pub decisions: Vec<Decision>,
    pub wake: Vec<WakeRow>,
    pub history: Vec<Change>,
    /// Each live workspace's plan, waiting or not: Mosaic's increment bars.
    pub plans: Vec<PlanBrief>,
    /// Each live workspace's newest lookout review: Mosaic's review line.
    pub reviews: Vec<ReviewBrief>,
    /// Timeline: one lane per live agent workspace over the last two hours.
    pub lanes: Vec<Lane>,
    /// Muted and tucked worktrees, for the chip and the palette.
    pub tucked: Vec<TuckRow>,
    /// Plan families: their parent, members and waits.
    pub families: Vec<FamilyBrief>,
    /// Each live workspace's open pages, plan first, then reviews, then asks.
    pub pages: Vec<NowPage>,
    /// Each live workspace that is muted or tucked: "mute" or "tuck".
    pub levels: std::collections::BTreeMap<String, String>,
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
    /// deep-plan's per-plan state files (when each increment went and finished).
    pub dp_state_dir: PathBuf,
    /// Muted and tucked worktrees (tuck.rs).
    pub tuck_file: PathBuf,
    /// crew-board's ask pages and their records.
    pub asks_dir: PathBuf,
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
            dp_state_dir: crew_board::server::dp_state(),
            tuck_file: crate::tuck::Store::live().file,
            asks_dir: crew_board::ask::asks_dir(),
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

    /// Whether a pane of `ws` works in `dir` or under it.
    fn ws_in_dir(&self, ws: &str, dir: &str) -> bool {
        if dir.is_empty() {
            return false;
        }
        let d = canon(dir);
        self.tiles.iter().zip(&self.cwds).any(|(t, c)| t.workspace.eq_ignore_ascii_case(ws) && (*c == d || c.starts_with(&format!("{d}/"))))
    }

    /// The live surface a question file names, else the workspace's agent pane.
    fn surface_or(&self, ws: &str, named: &str) -> String {
        match self.tiles.iter().find(|t| !named.is_empty() && t.workspace.eq_ignore_ascii_case(ws) && t.surface.eq_ignore_ascii_case(named)) {
            Some(t) => t.surface.clone(),
            None => self.surface_in(ws),
        }
    }
}

/// The live workspace a plan is worked in: its owner's when that works in
/// the plan's root, else the pane working in its root (the session that
/// rendered a plan may sit elsewhere), else the owner's when it is live.
fn plan_ws(panes: &Panes, p: &Value) -> Option<String> {
    let owner = p.get("owner").map(|o| s(o, "workspace")).unwrap_or_default();
    let owner_pane = p.get("owner").map(|o| s(o, "surface")).unwrap_or_default();
    let root = s(p, "root");
    // The owner's pane, where it lives; then a workspace pinned to the root.
    let by_pane = panes.tiles.iter().find(|t| !owner_pane.is_empty() && t.surface.eq_ignore_ascii_case(&owner_pane)).map(|t| t.workspace.clone());
    let pinned = || panes.tiles.iter().find(|t| !t.root.is_empty() && !root.is_empty() && canon(&t.root) == canon(&root)).map(|t| t.workspace.clone());
    by_pane
        .or_else(pinned)
        .or_else(|| panes.live_ws(&owner).filter(|w| panes.ws_in_dir(w, &root)))
        .or_else(|| panes.ws_for_dir(&root))
        .or_else(|| panes.live_ws(&owner))
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
            // The pane that was asked: its own state file says so.
            let asker = crew_core::status::panes(dir, &named).into_iter().filter(|p| p.asked.is_some()).max_by_key(|p| p.at).map(|p| p.surface).unwrap_or_default();
            out.push(Decision::Asked { surface: panes.surface_or(&ws, &asker), ws, since: mtime_ms(&path), question });
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
        let ws = plan_ws(&panes, p);
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
    closed: u64,
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
        closed: count("resolved") + count("dismissed"),
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
                // A fetch that panics must not leave the source busy for good.
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fetch()))
                    .unwrap_or_else(|_| Err("the source panicked; it is tried again".into()));
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
    dp_state_dir: PathBuf,
    asks_dir: PathBuf,
    tuck: crate::tuck::Store,
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
            dp_state_dir: inputs.dp_state_dir,
            asks_dir: inputs.asks_dir,
            tuck: crate::tuck::Store { file: inputs.tuck_file },
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

    /// Every review whose worktree has a live pane, with that workspace.
    fn live_reviews(&self, panes: &Panes) -> Vec<(String, ReviewSummary)> {
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
            let Some(ws) = panes.ws_for_dir(&r.root) else { continue };
            out.push((ws, r.clone()));
        }
        cache.retain(|p, _| seen.contains(p));
        out
    }

    /// Every decision, the Wake rows and the history window, for `tiles` at `now_ms`.
    pub fn build(&self, tiles: &[Tile], now_ms: u64) -> ViewsFrame {
        let panes = Panes::new(tiles);
        let mut problems = Vec::new();
        let mut decisions = hook_decisions(&self.state_dir, &panes);
        let mut plans = Vec::new();
        let mut fams = Vec::new();
        match self.plans.get() {
            Some(Ok(rows)) => {
                fams = families(&rows, tiles);
                // A family member's go is offered on its family's card, not
                // as a gate of its own; a gate for checks the person owes stays.
                let in_family = |slug: &str| fams.iter().any(|f| f.members.iter().any(|m| m.slug == slug));
                decisions.extend(gate_decisions(&rows, &panes).into_iter().filter(|d| match d {
                    Decision::Gate { slug, ready: true, .. } => !in_family(slug),
                    _ => true,
                }));
                for f in &fams {
                    let live: Vec<&FamilyMember> = f.members.iter().filter(|m| m.ws.is_some()).collect();
                    // A card only when a member can go: a member that only
                    // waits says so on its tile and in the next card.
                    if !f.members.iter().any(|m| m.ready) || live.is_empty() {
                        continue;
                    }
                    let home = f.members.iter().find(|m| m.role == "parent" && m.ws.is_some()).or(live.first().copied()).and_then(|m| m.ws.clone()).unwrap_or_default();
                    let since = rows
                        .iter()
                        .filter(|r| f.members.iter().any(|m| m.slug == s(r, "slug")))
                        .map(|r| u(r, "touchedAt"))
                        .max()
                        .unwrap_or(0);
                    decisions.push(Decision::Family { surface: panes.surface_in(&home), ws: home, since, parent: f.parent.clone(), members: f.members.clone() });
                }
                plans = plan_briefs(&rows, &panes);
            }
            Some(Err(e)) => problems.push(e),
            None => {} // the first answer is on its way
        }
        let live_reviews = self.live_reviews(&panes);
        for (ws, r) in live_reviews.iter().filter(|(_, r)| r.addressed > 0) {
            decisions.push(Decision::Review {
                surface: panes.surface_in(ws),
                ws: ws.clone(),
                since: r.since,
                id: r.id.clone(),
                title: r.title.clone(),
                plan: r.plan.clone(),
                inc: r.inc,
                addressed: r.addressed,
                open: r.open,
            });
        }
        decisions.sort_by_key(|d| d.since());
        let start = now_ms.saturating_sub(HISTORY_WINDOW.as_millis() as u64);
        // One read: a day back, so each lane knows its state at the window's start.
        let recent = history::read_since(&self.history_dir, start.saturating_sub(24 * 3600 * 1000));
        let lanes = self.lanes(&panes, &plans, &live_reviews, &recent, start, now_ms);
        let pages = self.pages(&panes, &plans, &live_reviews);
        let reviews = review_briefs(live_reviews);

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

        let history = recent.iter().filter(|e| e.at >= start).map(Change::from).collect();
        let (tucked, levels) = self.tucks(tiles, &decisions, &recent, &mut problems);
        ViewsFrame { decisions, wake, history, plans, reviews, lanes, tucked, families: fams, pages, levels, problems }
    }

    /// Each live workspace's open pages: its plan (the review surface while
    /// the plan is in review), its lookout reviews with findings not yet
    /// closed (newest first), and its unanswered asks whose terminal is live.
    fn pages(&self, panes: &Panes, plans: &[PlanBrief], reviews: &[(String, ReviewSummary)]) -> Vec<NowPage> {
        let mut out = Vec::new();
        for p in plans {
            let review = p.phase == "review";
            let state = if review {
                "in review".to_string()
            } else if p.phase == "done" || (p.total > 0 && p.done == p.total) {
                "done".to_string()
            } else if p.open {
                format!("working inc {}/{}", p.n, p.total)
            } else if p.n > 0 {
                format!("next inc {}/{}", p.n, p.total)
            } else {
                p.phase.clone()
            };
            out.push(NowPage {
                ws: p.ws.clone(),
                kind: "plan".into(),
                path: if review { format!("/plan/{}.review.html", p.slug) } else { format!("/plan/{}", p.slug) },
                label: p.slug.clone(),
                state,
                waiting: review,
                since: p.touched,
            });
        }
        let mut revs: Vec<&(String, ReviewSummary)> = reviews.iter().filter(|(_, r)| r.open + r.addressed > 0).collect();
        revs.sort_by(|a, b| b.1.since.cmp(&a.1.since));
        for (ws, r) in revs {
            let state = match (r.open, r.addressed) {
                (o, 0) => format!("{o} open"),
                (0, a) => format!("{a} to close"),
                (o, a) => format!("{o} open · {a} to close"),
            };
            out.push(NowPage {
                ws: ws.clone(),
                kind: "review".into(),
                path: format!("/review/{}", r.id),
                label: if r.inc > 0 && !r.plan.is_empty() { format!("{} inc {}", r.plan, r.inc) } else if r.title.is_empty() { r.id.clone() } else { r.title.clone() },
                state,
                waiting: r.addressed > 0,
                since: r.since,
            });
        }
        let mut asks = Vec::new();
        for e in std::fs::read_dir(&self.asks_dir).into_iter().flatten().filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json") else { continue };
            if !self.asks_dir.join(format!("{id}.html")).exists() {
                continue;
            }
            let Some(v) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
            if v.get("answer").is_some_and(|a| !a.is_null()) {
                continue;
            }
            // Only while the terminal that asked is still there.
            let surface = s(&v, "surface");
            let Some(ws) = panes.live_ws(&s(&v, "workspace")) else { continue };
            if surface.is_empty() || !panes.tiles.iter().any(|t| t.surface.eq_ignore_ascii_case(&surface)) {
                continue;
            }
            let since = e.metadata().and_then(|m| m.modified()).map(ms).unwrap_or(0);
            let q = s(&v, "header");
            asks.push(NowPage {
                ws,
                kind: "ask".into(),
                path: format!("/ask/{id}"),
                label: if q.is_empty() { "ask".into() } else { q },
                state: "waiting".into(),
                waiting: true,
                since,
            });
        }
        asks.sort_by(|a, b| b.since.cmp(&a.since));
        out.extend(asks);
        out
    }

    /// The quieted worktrees and each live workspace's level. A muted
    /// worktree whose workspace asked after the mute is unmuted (and saved).
    fn tucks(&self, tiles: &[Tile], decisions: &[Decision], recent: &[Entry], problems: &mut Vec<String>) -> (Vec<TuckRow>, std::collections::BTreeMap<String, String>) {
        use crate::tuck::{branch_of, root_of, Level};
        let mut entries = self.tuck.load();
        if entries.is_empty() {
            return (Vec::new(), Default::default());
        }
        // A workspace's worktree is its root: pin; without one, its first
        // agent pane's, else its first pane's: the same pane tuck_set picks.
        let mut root: HashMap<String, String> = HashMap::new();
        for t in tiles.iter().filter(|t| !t.root.is_empty()).chain(tiles.iter().filter(|t| t.agent.is_some())).chain(tiles.iter().filter(|t| t.agent.is_none())) {
            if !root.contains_key(&t.workspace) {
                root.insert(t.workspace.clone(), if t.root.is_empty() { root_of(&t.cwd) } else { t.root.clone() });
            }
        }
        let under = |path: &str| -> Vec<String> {
            let mut w: Vec<String> = root.iter().filter(|(_, r)| r.as_str() == path).map(|(ws, _)| ws.clone()).collect();
            w.sort();
            w
        };
        let asks = |ws: &[String]| -> Vec<u64> {
            decisions
                .iter()
                .filter_map(|d| match d {
                    Decision::Question { ws: w, since, .. } | Decision::Asked { ws: w, since, .. }
                        if ws.iter().any(|x| x.eq_ignore_ascii_case(w)) =>
                    {
                        Some(*since)
                    }
                    _ => None,
                })
                .collect()
        };
        let (gone, kept): (Vec<_>, Vec<_>) =
            entries.drain(..).partition(|e| e.level == Level::Mute && asks(&under(&e.path)).iter().any(|at| *at > e.at));
        entries = kept;
        if !gone.is_empty() {
            // Under the store's lock, so a mute set meanwhile is not lost.
            if let Err(e) = self.tuck.remove(&gone) {
                problems.push(format!("could not save the unmute: {e}"));
            }
        }
        let mut levels = std::collections::BTreeMap::new();
        let rows = entries
            .iter()
            .map(|e| {
                let ws = under(&e.path);
                for w in &ws {
                    levels.insert(w.clone(), match e.level { Level::Mute => "mute", Level::Tuck => "tuck" }.to_string());
                }
                let last = recent.iter().filter(|h| ws.iter().any(|w| w.eq_ignore_ascii_case(&h.ws))).map(|h| h.at).max().unwrap_or(e.at);
                TuckRow {
                    path: e.path.clone(),
                    level: e.level,
                    at: e.at,
                    name: if e.name.is_empty() { e.path.rsplit('/').next().unwrap_or("").to_string() } else { e.name.clone() },
                    branch: branch_of(&e.path),
                    waiting: !asks(&ws).is_empty(),
                    workspaces: ws,
                    last,
                }
            })
            .collect();
        (rows, levels)
    }

    /// One lane per live workspace with an agent: its spans over the window
    /// and its marks (increments going and finishing, lookout reviews).
    fn lanes(&self, panes: &Panes, plans: &[PlanBrief], reviews: &[(String, ReviewSummary)], recent: &[Entry], start: u64, now: u64) -> Vec<Lane> {
        let mut by_ws: HashMap<String, Vec<Entry>> = HashMap::new();
        for e in recent {
            if let Some(ws) = panes.live_ws(&e.ws) {
                by_ws.entry(ws).or_default().push(e.clone());
            }
        }
        let mut wss: Vec<String> = panes.tiles.iter().filter(|t| t.agent.is_some()).map(|t| t.workspace.clone()).collect();
        let mut seen = std::collections::HashSet::new();
        wss.retain(|w| seen.insert(w.clone()));
        wss.into_iter()
            .map(|ws| {
                let entries = by_ws.get(&ws).map(Vec::as_slice).unwrap_or(&[]);
                // One sub-row per Claude pane, from the history lines it wrote.
                let rows: Vec<LanePane> = panes
                    .tiles
                    .iter()
                    .filter(|t| t.workspace == ws && t.agent.is_some())
                    .map(|t| {
                        let mine: Vec<Entry> = entries.iter().filter(|e| e.surface.eq_ignore_ascii_case(&t.surface)).cloned().collect();
                        let mut spans = spans_of(&mine, start, now);
                        if spans.is_empty() && history::STATES.contains(&t.state.as_str()) {
                            // No history yet (it began after this pane's state
                            // did): the state the wall sees, since it first saw it.
                            spans.push(Span { state: t.state.clone(), start: t.since.clamp(start, now), end: now });
                        }
                        LanePane { surface: t.surface.clone(), label: t.label.clone(), spans, owner: t.owner.clone(), outside: t.outside }
                    })
                    .collect();
                // The head is the panes' roll-up, with lines no pane named
                // (written before hooks knew their surface) under them.
                let unnamed: Vec<Entry> = entries.iter().filter(|e| !rows.iter().any(|r| e.surface.eq_ignore_ascii_case(&r.surface))).cloned().collect();
                let mut all: Vec<Vec<Span>> = rows.iter().map(|r| r.spans.clone()).collect();
                all.push(spans_of(&unnamed, start, now));
                let spans = rollup_spans(&all);
                let mut marks = Vec::new();
                let plan = plans.iter().find(|p| p.ws == ws);
                if let Some(p) = plan {
                    marks.extend(increment_marks(&self.dp_state_dir, &p.slug, start, now));
                }
                // A review of a plan sits on that plan's lane; any other on
                // the lane of the workspace working in its worktree.
                let mine = |(w, r): &&(String, ReviewSummary)| match plans.iter().find(|p| !r.plan.is_empty() && p.slug == r.plan) {
                    Some(p) => p.ws == ws,
                    None => *w == ws,
                };
                for (_, r) in reviews.iter().filter(mine).filter(|(_, r)| r.since >= start && r.since <= now) {
                    marks.push(Mark { kind: "review".into(), at: r.since, n: r.inc, label: r.title.clone() });
                }
                marks.sort_by_key(|m| m.at);
                Lane { ws, spans, marks, panes: rows }
            })
            .collect()
    }
}

/// A run of one state in a lane, [start, end) in ms.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Span {
    pub state: String,
    pub start: u64,
    pub end: u64,
}

/// A point on a lane: an increment going (`go`) or finishing (`done`), or a
/// lookout review (`review`).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Mark {
    pub kind: String,
    pub at: u64,
    pub n: u64,
    pub label: String,
}

/// One workspace's row on Timeline: its head is the roll-up of its panes.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Lane {
    pub ws: String,
    pub spans: Vec<Span>,
    pub marks: Vec<Mark>,
    /// One sub-row per Claude pane in the workspace.
    pub panes: Vec<LanePane>,
}

/// One Claude pane's sub-row in a lane.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LanePane {
    pub surface: String,
    pub label: String,
    pub spans: Vec<Span>,
    /// The plan this pane owns, by slug.
    pub owner: Option<String>,
    /// Its cwd has left the workspace's pinned worktree.
    pub outside: bool,
}

/// The state rank a roll-up keeps: crew-core's status ranking.
fn rank_of(state: &str) -> usize {
    crew_core::status::RANK.iter().position(|s| *s == state).unwrap_or(crew_core::status::RANK.len())
}

/// Several rows of spans as one: at each moment the highest-ranked state any
/// row is in (needs_input > working > idle > ended), runs of one state merged.
pub fn rollup_spans(rows: &[Vec<Span>]) -> Vec<Span> {
    let mut cuts: Vec<u64> = rows.iter().flatten().flat_map(|s| [s.start, s.end]).collect();
    cuts.sort_unstable();
    cuts.dedup();
    let mut out: Vec<Span> = Vec::new();
    for w in cuts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let best = rows.iter().flatten().filter(|s| s.start <= a && s.end >= b).min_by_key(|s| rank_of(&s.state));
        let Some(best) = best else { continue };
        match out.last_mut() {
            Some(l) if l.state == best.state && l.end == a => l.end = b,
            _ => out.push(Span { state: best.state.clone(), start: a, end: b }),
        }
    }
    out
}

/// A workspace's history as runs of one state over [start, now): the state
/// at `start` is the last one recorded before it; a repeat of the same state
/// (a hook and the poll both saw it) does not start a new run.
pub fn spans_of(entries: &[Entry], start: u64, now: u64) -> Vec<Span> {
    let mut sorted: Vec<&Entry> = entries.iter().filter(|e| e.at < now).collect();
    sorted.sort_by_key(|e| e.at);
    let mut out: Vec<Span> = Vec::new();
    let mut cur: Option<(String, u64)> = None;
    for e in sorted {
        let at = e.at.max(start);
        match &cur {
            Some((state, _)) if *state == e.state => continue,
            Some((state, from)) => {
                if at > *from {
                    out.push(Span { state: state.clone(), start: *from, end: at });
                }
            }
            None => {}
        }
        cur = Some((e.state.clone(), at));
    }
    if let Some((state, from)) = cur {
        if now > from {
            out.push(Span { state, start: from, end: now });
        }
    }
    // A run that ended before the window opened left a zero-width span at start.
    out.retain(|s| s.end > start);
    out
}

/// When each of a plan's increments went and finished inside [start, now],
/// from deep-plan's state file.
fn increment_marks(dir: &Path, slug: &str, start: u64, now: u64) -> Vec<Mark> {
    let Some(v) = std::fs::read_to_string(dir.join(format!("{slug}.json"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for inc in v.get("increments").and_then(Value::as_array).into_iter().flatten() {
        let n = u(inc, "n");
        for (key, kind) in [("authorizedAt", "go"), ("doneAt", "done")] {
            let at = u(inc, key);
            if at >= start && at <= now && at > 0 {
                out.push(Mark { kind: kind.into(), at, n, label: format!("{slug} · {}", s(inc, "title")) });
            }
        }
    }
    out
}

/// Each live workspace's plan, the one touched last when it has several.
fn plan_briefs(rows: &[Value], panes: &Panes) -> Vec<PlanBrief> {
    let mut by_ws: HashMap<String, PlanBrief> = HashMap::new();
    for p in rows {
        let Some(ws) = plan_ws(&panes, p) else { continue };
        let progress = p.get("progress").cloned().unwrap_or(Value::Null);
        let open = progress.get("open").and_then(Value::as_array).and_then(|a| a.first()).cloned();
        let next = progress.get("next").filter(|n| n.is_object()).cloned();
        let (n, title) = match (open.as_ref(), next.as_ref()) {
            (Some(o), _) => (u(o, "n"), s(o, "title")),
            (None, Some(nx)) => (u(nx, "n"), s(nx, "title")),
            _ => (0, String::new()),
        };
        let b = PlanBrief {
            ws: ws.clone(),
            slug: s(p, "slug"),
            phase: s(p, "phase"),
            done: u(&progress, "done"),
            total: u(&progress, "total"),
            n,
            open: open.is_some(),
            title,
            touched: u(p, "touchedAt"),
        };
        if by_ws.get(&ws).is_none_or(|was| was.touched <= b.touched) {
            by_ws.insert(ws, b);
        }
    }
    let mut out: Vec<PlanBrief> = by_ws.into_values().collect();
    out.sort_by(|a, b| a.ws.cmp(&b.ws));
    out
}

/// Each live workspace's newest review.
fn review_briefs(live: Vec<(String, ReviewSummary)>) -> Vec<ReviewBrief> {
    let mut by_ws: HashMap<String, ReviewBrief> = HashMap::new();
    for (ws, r) in live {
        let b = ReviewBrief { ws: ws.clone(), id: r.id, plan: r.plan, inc: r.inc, open: r.open, addressed: r.addressed, closed: r.closed, since: r.since };
        if by_ws.get(&ws).is_none_or(|was| was.since <= b.since) {
            by_ws.insert(ws, b);
        }
    }
    let mut out: Vec<ReviewBrief> = by_ws.into_values().collect();
    out.sort_by(|a, b| a.ws.cmp(&b.ws));
    out
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
