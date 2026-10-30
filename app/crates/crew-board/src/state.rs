//! The board's state: gather, rank, compose the news (crew/board/crew-board).
//!
//!   seamux crew-board state [--json] [--fast] [--screens] [--selected ID]
//!   seamux crew-board state --json --fixture FILE   rank {plans, workspaces} from a file
//!                                                   (+ current, pane_files: the cards' panes)
//!   seamux crew-board write-targets [FILE]          the click table from a state
//!
//! open, push, watch, tidy, close and usage drove the Dock surface the cutover
//! retired. The board is now the page the intent server serves at /board, live
//! on its own: `open` and `usage` open the served pages in a cmux tab, and the
//! others say where the board went rather than send anyone to the Python.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crew_core::{dp_engine, py, pyjson};

use crate::cmux_cli::{self, cmux};
use crate::pyval::{get, py_str, truthy};
use crate::{news, rank};

/// A fast pass will not trust a cached sidebar-state row older than this.
const FAST_MAX_AGE: i64 = 300;

/// crew-board's docstring, which the Python prints for an unknown subcommand.
const DOC: &str = "crew-board — the agent board: who needs you, ranked, in a cmux Dock browser surface.\n\n    crew-board open            create the Dock surface and load the board\n    crew-board push            gather, rank, push one update into the page\n    crew-board push --fast     the same, reusing cached branch/PR (~190ms vs ~2.1s)\n    crew-board watch [secs]    event-driven; [secs] is the backstop heartbeat (30s)\n    crew-board state [--json]  the ranked state, without touching cmux\n    crew-board tidy            close duplicate board surfaces\n    crew-board close           close the surface\n    crew-board usage           open the spend dashboard (ccusage) as a Dock tab\n\n    crew-board state --json --fixture FILE   rank {\"plans\", \"workspaces\"} from FILE\n    crew-board write-targets [FILE]          the click table from a state (stdin if no FILE)\n\nThe last two are for probes: they let a probe drive the ranking and the click\ntable through the command line, so the same probe can run against the Python\nand the Rust board (`seamux crew-board`) alike.\n\nWhy a browser surface rather than the sidebar: the custom-sidebar interpreter has no\n@State, no text input, and can only bind cmux's own workspace data -- so it cannot host\na ranked list built from deep-plan state and agent output. A Dock browser surface has\nnone of those limits, and `cmux browser addscript` pushes state into a page that is\nalready open, so the surface never reloads and nothing stateful is lost.\n\nClickable. Rows and chips dispatch through crew-board-intent, a loopback HTTP server, and\nintent.js is pushed alongside the renderer on every update. See board/README.md for why a\nserver rather than the four routes that do not work. A click carries only (row id, action);\ncrew-board-intent resolves the target from the snapshot write_targets() leaves behind.\n\nStill not trusted to act unilaterally: `go N` and `reclaim` post the same `crew:*`\nnotification RPC the Swift sidebar used, and hooks/triage.py gates them -- including its\nconfirm-before-delete on reclaim. The board asks; it does not authorize.\n\nWhimsy carry-over: the four row states are whimsy's shader events -- EV_ATTEND,\nEV_RUNNING, EV_FAILURE (wilt), EV_SUCCESS (ripple) -- with its Everforest constants and,\nmost importantly, its principle: nothing animates unless something is happening. The\ncat in the header states the same thing in one word, the ranking animates when it\nactually changes, and a board with nothing on it is completely still.";

pub fn state_dir() -> PathBuf {
    py::home().join(".cache").join("cmux-crew")
}

pub fn targets_file() -> PathBuf {
    state_dir().join("board-targets.json")
}

/// The workspace's root: pin (crew-core's worktree), if it has one.
fn pin_of(w: &Value) -> Option<String> {
    crew_core::worktree::root_of(get(w, "description").as_str().unwrap_or("")).filter(|r| std::path::Path::new(r).is_dir())
}

/// `git branch --show-current` ("none" when detached or not a repo) and
/// whether `git status --porcelain` lists anything, in `dir`.
fn git_state(dir: &str) -> (String, bool) {
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let branch = run(&["branch", "--show-current"]).filter(|b| !b.is_empty()).unwrap_or_else(|| "none".into());
    let dirty = run(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    (branch, dirty)
}

fn sidebar_cache_file() -> PathBuf {
    state_dir().join("board-sidebar.json")
}

// ------------------------------------------------------------------ gather

/// deep-plan's tracked plans, keyed by worktree root. Works with cmux down.
pub fn plans() -> Map<String, Value> {
    let script = dp_engine::script();
    let node = crate::act::node().unwrap_or_else(|| "node".into());
    let (ok, out) = cmux_cli::run(&node, &[&script.to_string_lossy(), "status", "--json"], Duration::from_secs(15));
    if !ok || out.is_empty() {
        return Map::new();
    }
    match serde_json::from_str::<Value>(&out) {
        Ok(Value::Array(rows)) => by_root(rows),
        _ => Map::new(),
    }
}

fn by_root(rows: Vec<Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for p in rows {
        if truthy(get(&p, "root")) {
            out.insert(py_str(get(&p, "root")), p);
        }
    }
    out
}

static SLUGS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// "owner/repo" for a worktree, from its git remote. Cached per process.
pub fn remote_slug(cwd: &str) -> String {
    if cwd.is_empty() || !std::path::Path::new(cwd).is_dir() {
        return String::new();
    }
    if let Some(s) = SLUGS.lock().unwrap().get_or_insert_with(HashMap::new).get(cwd) {
        return s.clone();
    }
    let (ok, out) = cmux_cli::run("git", &["-C", cwd, "remote", "get-url", "origin"], Duration::from_secs(5));
    let mut slug = String::new();
    if ok && !out.is_empty() {
        let mut u = out.trim().to_string();
        if u.starts_with("git@") {
            u = u.split_once(':').map(|(_, r)| r.to_string()).unwrap_or(u);
        } else if let Some((_, rest)) = u.split_once("://") {
            u = rest.split_once('/').map(|(_, r)| r.to_string()).unwrap_or_else(|| rest.to_string());
        }
        slug = u.strip_suffix(".git").unwrap_or(&u).trim_matches('/').to_string();
    }
    SLUGS.lock().unwrap().get_or_insert_with(HashMap::new).insert(cwd.to_string(), slug.clone());
    slug
}

/// [{at, s}] for this worktree's own commits in the news window, newest first.
pub fn recent_commits(cwd: &str) -> Vec<Value> {
    if cwd.is_empty() || !std::path::Path::new(cwd).is_dir() {
        return Vec::new();
    }
    let since = format!("--since={}.minutes", (news::hours() * 60.0) as i64);
    let (ok, out) = cmux_cli::run(
        "git",
        &["-C", cwd, "log", "HEAD", "--not", "origin/HEAD", &since, "--no-merges", "-n", "20", "--format=%ct%x09%s"],
        Duration::from_secs(5),
    );
    if !ok {
        return Vec::new();
    }
    py::splitlines(&out)
        .into_iter()
        .filter_map(|line| {
            let (at, subj) = line.split_once('\t').unwrap_or((line, ""));
            if !at.is_empty() && at.chars().all(|c| c.is_ascii_digit()) {
                let s: String = subj.chars().take(120).collect();
                Some(json!({"at": at.parse::<i64>().unwrap_or(0), "s": s}))
            } else {
                None
            }
        })
        .collect()
}

fn load_sidebar_cache() -> Map<String, Value> {
    std::fs::read_to_string(sidebar_cache_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn save_json(path: &PathBuf, v: &Value) {
    let _ = std::fs::create_dir_all(state_dir());
    let _ = py::write_atomic(path, pyjson::dumps(v).as_bytes());
}

fn s_or(v: &Value, default: Value) -> Value {
    if truthy(v) { v.clone() } else { default }
}

/// [{id, title, cwd, desc, running, branch, pr, ...}]. Empty when cmux is down.
pub fn workspaces(fast: bool, forced: Option<&str>) -> Vec<Value> {
    let Some(c) = cmux_cli::client() else { return Vec::new() };
    let listed = match c.workspace_list(None) {
        Ok(v) => get(&v, "workspaces").as_array().cloned().unwrap_or_default(),
        Err(_) => {
            cmux_cli::failed();
            return Vec::new();
        }
    };
    let mut cache = load_sidebar_cache();
    let now = py::now() as i64;
    let mut rows: Vec<Value> = Vec::new();
    for w in &listed {
        let r = s_or(get(w, "ref"), s_or(get(w, "id"), json!("")));
        if !truthy(&r) {
            continue;
        }
        let rs = py_str(&r);
        let wid = s_or(get(w, "id"), r.clone());
        let wid_s = py_str(&wid);
        let title_raw = get(w, "title").as_str().unwrap_or("").trim().to_string();
        let title = if title_raw.is_empty() { r.clone() } else { json!(title_raw) };
        let hit = if fast { cache.get(&wid_s).cloned() } else { None };
        if let Some(hit) = hit.filter(|h| truthy(h)) {
            let at = hit.get("at").and_then(Value::as_f64).unwrap_or(0.0) as i64;
            if now - at < FAST_MAX_AGE {
                let mut row = get(&hit, "row").as_object().cloned().unwrap_or_default();
                let cached_cwd = row.get("cwd").cloned().unwrap_or(json!(""));
                row.insert("id".into(), wid.clone());
                row.insert("ref".into(), r.clone());
                row.insert("title".into(), title);
                row.insert("cwd".into(), match pin_of(w) {
                    Some(pin) => json!(pin),
                    None => s_or(get(w, "current_directory"), cached_cwd),
                });
                row.insert("desc".into(), s_or(get(w, "description"), json!("")));
                row.insert("color".into(), s_or(get(w, "custom_color"), json!("")));
                let sel = match forced {
                    Some(f) => get(w, "id").as_str() == Some(f),
                    None => truthy(get(w, "selected")),
                };
                row.insert("selected".into(), json!(sel));
                rows.push(Value::Object(row));
                continue;
            }
        }
        let st = c.cli(&["sidebar-state", "--workspace", &rs]);
        let (ok2, st) = match st {
            Ok(o) => (o.ok(), cmux_cli::text(&o.stdout, &o.stderr)),
            Err(e) => (false, e.to_string()),
        };
        let mut f: HashMap<String, String> = HashMap::new();
        if ok2 {
            for l in py::splitlines(&st) {
                if let Some((k, v)) = l.trim().split_once('=') {
                    f.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
        }
        let pr_raw = f.get("pr").cloned().unwrap_or_default();
        let pr_parts: Vec<&str> = pr_raw.split_whitespace().collect();
        let pr_num = if !pr_parts.is_empty() && pr_raw != "none" { pr_parts[0].to_string() } else { "none".into() };
        let pr_state = pr_parts.get(1).copied().unwrap_or("").to_string();
        let pr_url_direct = pr_parts.iter().find(|t| t.starts_with("http")).map(|t| t.to_string()).unwrap_or_default();
        let br_raw: Vec<String> = f.get("git_branch").map(|b| b.split_whitespace().map(String::from).collect()).unwrap_or_default();
        let mut branch = br_raw.first().cloned().unwrap_or_else(|| "none".into());
        let mut dirty = br_raw.len() > 1 && br_raw[1] != "clean";
        let mut cwd = s_or(get(w, "current_directory"), json!(f.get("cwd").cloned().unwrap_or_default()));
        // A pinned workspace is about its pinned worktree, whatever pane has
        // focus: cmux's directory and git state follow the focused pane, so
        // when they point elsewhere the pin's own branch and status are read.
        if let Some(pin) = pin_of(w) {
            // A directory inside the pin is the same worktree: cmux's git
            // state is right there, and no git runs.
            let here = cwd.as_str().unwrap_or("");
            if here != pin && !here.starts_with(&format!("{}/", pin.trim_end_matches('/'))) {
                let (b, d) = git_state(&pin);
                branch = b;
                dirty = d;
            }
            cwd = json!(pin);
        }
        let selected = match forced {
            Some(fd) => wid_s == fd,
            None => truthy(get(w, "selected")),
        };
        let mut row = Map::new();
        row.insert("id".into(), s_or(get(w, "id"), r.clone()));
        row.insert("title".into(), title);
        row.insert("cwd".into(), cwd.clone());
        row.insert("desc".into(), s_or(get(w, "description"), json!("")));
        row.insert("branch".into(), json!(branch));
        row.insert("pr".into(), json!(pr_num));
        row.insert("dirty".into(), json!(dirty));
        row.insert("running".into(), json!(ok2 && st.contains("claude_code=Running")));
        row.insert("raw".into(), json!(if ok2 { st.clone() } else { String::new() }));
        row.insert("ref".into(), r.clone());
        row.insert("color".into(), s_or(get(w, "custom_color"), json!("")));
        row.insert("selected".into(), json!(selected));
        row.insert("pr_state".into(), json!(pr_state));
        let cwd_s = cwd.as_str().unwrap_or("").to_string();
        let pr_url = if !pr_url_direct.is_empty() {
            pr_url_direct
        } else {
            let slug = if pr_num != "" && pr_num != "none" { remote_slug(&cwd_s) } else { String::new() };
            if slug.is_empty() { String::new() } else {
                format!("https://github.com/{}/pull/{}", slug, pr_num.trim_start_matches('#'))
            }
        };
        row.insert("pr_url".into(), json!(pr_url));
        row.insert("commits".into(), Value::Array(recent_commits(&cwd_s)));
        let row = Value::Object(row);
        if ok2 {
            cache.insert(wid_s.clone(), json!({"at": now, "row": row.clone()}));
        }
        rows.push(row);
    }
    let live: Vec<String> = listed.iter().map(|w| py_str(&s_or(get(w, "id"), get(w, "ref").clone()))).collect();
    cache.retain(|k, _| live.contains(k));
    save_json(&sidebar_cache_file(), &Value::Object(cache));
    rows
}

/// The last non-empty thing the agent said; one cmux call, so opt-in.
pub fn last_line(ws_id: &str) -> String {
    let (ok, out) = cmux(&["read-screen", "--workspace", ws_id, "--lines", "4"]);
    if !ok {
        return String::new();
    }
    for l in py::splitlines(&out).into_iter().rev() {
        let s = l.trim();
        let furniture = ["╭", "│", "╰", "▐", ">", "?"].iter().any(|p| s.starts_with(p));
        if !s.is_empty() && !furniture && s.chars().count() > 8 {
            return s.chars().take(180).collect();
        }
    }
    String::new()
}

// ------------------------------------------------------------------- build

fn local_hms() -> String {
    // SAFETY: localtime_r writes only into the tm we hand it.
    unsafe {
        let t = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        format!("{:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec)
    }
}

/// Options parsed from the argument list, as the Python reads sys.argv.
pub struct Opts {
    pub screens: bool,
    pub fast: bool,
    pub selected: Option<String>,
    pub fixture: Option<(Map<String, Value>, Vec<Value>)>,
    /// A fixture's panes: cmux's current.list and crew's pane files. Rows
    /// from a fixture list panes only when it has them.
    pub fixture_panes: Option<(Vec<LivePane>, Vec<crew_core::status::Pane>)>,
}

/// A fixture's `current` (a current.list result) and `pane_files` (crew's
/// pane files, as written), when it has either.
pub fn load_fixture_panes(path: &str) -> Option<(Vec<LivePane>, Vec<crew_core::status::Pane>)> {
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    if fx.get("current").is_none() && fx.get("pane_files").is_none() {
        return None;
    }
    let files = get(&fx, "pane_files").as_array().into_iter().flatten().filter_map(crew_core::status::Pane::from_json).collect();
    Some((live_panes_of(get(&fx, "current")), files))
}

/// `{"plans": {root: plan} or [plan], "workspaces": [...]}` from a file.
pub fn load_fixture(path: &str) -> Result<(Map<String, Value>, Vec<Value>), String> {
    let fx: Value = std::fs::read_to_string(path)
        .map_err(|e| py::os_error(&e, std::path::Path::new(path)))
        .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("{path}: {e}")))?;
    let ps = s_or(get(&fx, "plans"), json!({}));
    let plans = match ps {
        Value::Array(a) => by_root(a),
        Value::Object(o) => o,
        _ => Map::new(),
    };
    let wss = s_or(get(&fx, "workspaces"), json!([])).as_array().cloned().unwrap_or_default();
    Ok((plans, wss))
}

/// A running terminal pane, as cmux's current.list describes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LivePane {
    pub ws: String,
    pub surface: String,
    pub cwd: String,
    /// The pane's title: what the terminal says it is running.
    pub label: String,
    /// The agent cmux sees in the pane (`claude`, ...), if any.
    pub agent: Option<String>,
    /// That agent's state as cmux reports it (`unknown` when it gets no
    /// lifecycle hooks from the agent).
    pub state: String,
}

/// The running terminal panes in a current.list result, in its order.
pub fn live_panes_of(v: &Value) -> Vec<LivePane> {
    let sv = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    get(v, "items")
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| sv(i, "kind") == "terminal" && sv(i, "lifecycle") == "running")
        .filter_map(|i| {
            let p = i.get("projections")?.as_array()?.first()?;
            let agent = i.get("agents").and_then(Value::as_array).and_then(|a| a.first());
            Some(LivePane {
                ws: sv(p, "workspace_id"),
                surface: sv(p, "panel_id"),
                cwd: sv(i, "cwd"),
                label: sv(i, "label"),
                agent: agent.map(|a| sv(a, "kind")).filter(|k| !k.is_empty()),
                state: agent.map(|a| sv(a, "state")).unwrap_or_default(),
            })
        })
        .filter(|p| !p.surface.is_empty())
        .collect()
}

/// Every running terminal pane, from cmux's current.list; empty when cmux
/// does not answer.
fn live_panes() -> Vec<LivePane> {
    let Some(c) = cmux_cli::client() else { return Vec::new() };
    c.current_list(None).map(|v| live_panes_of(&v)).unwrap_or_default()
}

/// A pane file left by a Claude that is gone (it crashed, or was killed,
/// before its hooks wrote "ended") becomes "ended", so its pane reads as the
/// shell it is. Only a pane cmux sees no agent in is a suspect. `alive` is
/// crew_core::status::liveness: by the file's own session, found in the
/// session store by id, whether that process still runs. A suspect is ended
/// only when its record is there and its process is not; a native pane's
/// live Claude stays, and a session the store does not know proves nothing.
/// It is a file read and a process check per pane, never a cmux call, and
/// None (no readable store) leaves every file as it is.
pub fn drop_gone(files: &mut [crew_core::status::Pane], live: &[LivePane], alive: impl FnOnce() -> Option<std::collections::HashMap<String, (bool, String)>>) {
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    let suspect = |f: &crew_core::status::Pane| {
        f.state != "ended" && !f.session.is_empty() && live.iter().any(|p| same(&p.surface, &f.surface) && p.agent.is_none())
    };
    if !files.iter().any(suspect) {
        return;
    }
    let Some(alive) = alive() else { return };
    for f in files.iter_mut().filter(|f| suspect(f)) {
        if alive.get(&f.surface.to_uppercase()).is_some_and(|(a, _)| !a) {
            f.state = "ended".into();
        }
    }
}

/// Each workspace's panes, as its card lists them. A row gets `panes`, one
/// entry per running terminal in its workspace:
///
/// ```text
/// {"surface", "kind": "claude"|<agent>|"term", "state", "since": ms|0,
///  "asked": bool, "what": <title>, "plan": <slug>?, "outside": true?}
/// ```
///
/// A pane's state is what crew's hooks last wrote for it (`files`, the same
/// pane files the card's roll-up reads), else what cmux sees, else `shell`
/// for a terminal with no agent. `since` is when the hooks last wrote, so
/// "waiting 4m" means four minutes since the pane asked. Agents come first,
/// the one that needs you on top, then terminals in cmux's order.
///
/// Without cmux's list (`live` empty) a row lists only its open plans'
/// owner panes, with no state. A row with no panes gets no `panes` key.
pub fn mark_panes(rows: &mut [Value], plans: &Map<String, Value>, wss: &[Value], live: &[LivePane], files: &[crew_core::status::Pane]) {
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    let pins: std::collections::HashMap<String, String> =
        wss.iter().filter_map(|w| Some((py_str(get(w, "id")).to_uppercase(), pin_of(w)?))).collect();
    let real = |p: &str| std::fs::canonicalize(p).map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string());
    // Open plans' owner panes: (workspace, surface, slug).
    let owners: Vec<(String, String, String)> = plans
        .values()
        .filter(|p| !matches!(get(p, "phase").as_str().unwrap_or(""), "done" | "closed"))
        .filter_map(|p| {
            let o = get(p, "owner");
            let (ws, surface) = (get(o, "workspace").as_str()?, get(o, "surface").as_str()?);
            (!surface.is_empty()).then(|| (ws.to_string(), surface.to_string(), py_str(get(p, "slug"))))
        })
        .collect();
    // A pane's surface is unique, so its plans are found by surface alone.
    let slugs = |surface: &str| -> Option<String> {
        let mut s: Vec<&str> = owners.iter().filter(|(_, x, _)| same(x, surface)).map(|(_, _, g)| g.as_str()).collect();
        s.sort();
        (!s.is_empty()).then(|| s.join(", "))
    };
    for r in rows.iter_mut() {
        let id = py_str(get(r, "id"));
        if id.is_empty() {
            continue;
        }
        let mut out: Vec<(usize, Value)> = Vec::new();
        if live.is_empty() {
            for (_, surface, _) in owners.iter().filter(|(w, _, _)| same(w, &id)) {
                if out.iter().any(|(_, v)| same(v["surface"].as_str().unwrap_or(""), surface)) {
                    continue;
                }
                let mut m = json!({"surface": surface, "kind": "claude", "state": "", "since": 0, "asked": false, "what": ""});
                if let Some(s) = slugs(surface) {
                    m["plan"] = json!(s);
                }
                out.push((0, m));
            }
        }
        // The pin as a real path: a symlinked spelling of the tree is inside.
        let pin = pins.get(&id.to_uppercase()).map(|p| real(p.trim_end_matches('/')).trim_end_matches('/').to_string());
        for p in live.iter().filter(|p| same(&p.ws, &id)) {
            // A pane whose hooks say its Claude ended is a terminal again,
            // unless cmux still sees an agent there.
            let file = files.iter().find(|f| same(&f.surface, &p.surface));
            let (kind, state, since, asked) = match (file, &p.agent) {
                (Some(f), _) if f.state != "ended" => {
                    (p.agent.clone().unwrap_or_else(|| "claude".into()), f.state.clone(), f.at, f.asked.is_some())
                }
                (_, Some(a)) => (a.clone(), if p.state == "unknown" { String::new() } else { p.state.clone() }, 0, false),
                _ => ("term".to_string(), "shell".to_string(), 0, false),
            };
            let mut m = json!({"surface": p.surface, "kind": kind, "state": state, "since": since, "asked": asked, "what": p.label});
            if let Some(s) = slugs(&p.surface) {
                m["plan"] = json!(s);
            }
            if let Some(pin) = &pin {
                let c = real(&p.cwd);
                if !p.cwd.is_empty() && !(c == *pin || c.starts_with(&format!("{pin}/"))) {
                    m["outside"] = json!(true);
                }
            }
            // needs_input, or asked, first; then working, idle, ended; terminals last.
            let rank = if kind == "term" {
                9
            } else if asked {
                0
            } else {
                crew_core::status::RANK.iter().position(|x| *x == state).unwrap_or(4)
            };
            out.push((rank, m));
        }
        out.sort_by_key(|(k, _)| *k);
        if !out.is_empty() {
            if let Some(m) = r.as_object_mut() {
                m.insert("panes".into(), Value::Array(out.into_iter().map(|(_, v)| v).collect()));
            }
        }
    }
}

pub fn build(o: &Opts) -> Value {
    let (plan_by_root, wss) = match &o.fixture {
        Some((p, w)) => (p.clone(), w.clone()),
        None => (plans(), workspaces(o.fast, o.selected.as_deref())),
    };
    let stale = wss.is_empty();
    let (rows, quiet) = if stale {
        (rank::rank_plans_only(&plan_by_root), Vec::new())
    } else {
        rank::rank(&wss, &plan_by_root, o.screens)
    };
    let mut all: Vec<Value> = rows.into_iter().chain(quiet.iter().cloned()).collect();
    // The app's muted and tucked worktrees (fixtures stay as given).
    if o.fixture.is_none() {
        crate::tucked::mark_live(&mut all);
        // Each workspace's panes: what each is doing, which owns the plan,
        // which has wandered past the pin.
        let live = live_panes();
        let mut files = crew_core::status::all(&state_dir());
        drop_gone(&mut files, &live, || crew_core::status::liveness_now(&state_dir()));
        mark_panes(&mut all, &plan_by_root, &wss, &live, &files);
    } else if let Some((live, files)) = &o.fixture_panes {
        mark_panes(&mut all, &plan_by_root, &wss, live, files);
    }
    let news = news::compose_now(&all);
    let n = plan_by_root.len();
    let mut d = Map::new();
    d.insert("rows".into(), Value::Array(all));
    d.insert("quietCount".into(), json!(quiet.len()));
    d.insert("quiet".into(), json!(if !quiet.is_empty() { "" }
        else if stale { "cmux unreachable — plan state only, no workspaces" }
        else { "nothing else in flight" }));
    d.insert("stamp".into(), json!(local_hms()));
    d.insert("stale".into(), json!(stale));
    d.insert("src".into(), json!(format!("{} plan{}", n, if n == 1 { "" } else { "s" })));
    d.insert("news".into(), news);
    Value::Object(d)
}

/// Persist the row -> action-target map crew-board-intent resolves clicks from.
pub fn write_targets(d: &Value) {
    let mut targets = Map::new();
    for r in get(d, "rows").as_array().into_iter().flatten() {
        let mut t = Map::new();
        for k in ["id", "ref", "cwd", "pr_url", "slug", "name", "issue_url", "panes"] {
            t.insert(k.into(), r.get(k).cloned().unwrap_or(json!("")));
        }
        let key = match get(r, "id") {
            Value::Null => "null".to_string(),
            Value::Bool(b) => b.to_string(),
            v => py_str(v),
        };
        targets.insert(key, Value::Object(t));
    }
    save_json(&targets_file(), &Value::Object(targets));
}

fn print_state(d: &Value) {
    println!("{} · {}", py_str(get(d, "stamp")), py_str(get(d, "src")));
    for r in get(d, "rows").as_array().into_iter().flatten() {
        let name: String = py_str(get(r, "name")).chars().take(26).collect();
        let said: String = py_str(get(r, "said")).chars().take(76).collect();
        println!("  {:<8} {:<26} {}", py_str(get(r, "kind")), name, said);
    }
    if truthy(get(d, "quiet")) {
        println!("  {:<8} {}", "quiet", py_str(get(d, "quiet")));
    }
    let news = get(d, "news");
    let items = get(news, "items").as_array().cloned().unwrap_or_default();
    if !items.is_empty() {
        let h = crate::pyval::py_float(get(news, "hours")).unwrap_or(0.0);
        println!("news · last {}h", py::percent_g(h));
        for it in items {
            let text = py_str(get(&it, "text")).replace("{{", "").replace("}}", "").replace('`', "");
            println!("  {:<8} {}", py_str(get(&it, "tier")), text);
        }
    }
}

fn flag(args: &[String], f: &str) -> bool {
    args.iter().any(|a| a == f)
}

fn after(args: &[String], f: &str) -> Option<String> {
    let i = args.iter().position(|a| a == f)?;
    args.get(i + 1).cloned()
}

fn cmd_state(args: &[String]) -> i32 {
    let fixture = if flag(args, "--fixture") {
        let Some(path) = after(args, "--fixture") else {
            eprintln!("crew-board: --fixture needs a file");
            return 1;
        };
        match load_fixture(&path) {
            Ok(fx) => Some(fx),
            Err(e) => {
                eprintln!("crew-board: {e}");
                return 1;
            }
        }
    } else {
        None
    };
    let o = Opts {
        screens: flag(args, "--screens"),
        fast: flag(args, "--fast"),
        // Python's `if forced`: an empty id is no override.
        selected: after(args, "--selected").filter(|s| !s.is_empty()),
        fixture_panes: after(args, "--fixture").filter(|_| fixture.is_some()).and_then(|p| load_fixture_panes(&p)),
        fixture,
    };
    let d = build(&o);
    if flag(args, "--json") {
        println!("{}", pyjson::dumps_indent(&d, 2));
    } else {
        print_state(&d);
    }
    0
}

fn cmd_write_targets(args: &[String]) -> i32 {
    let mut body = String::new();
    let read = match args.get(1) {
        Some(p) => std::fs::read_to_string(p).map(|s| body = s),
        None => std::io::stdin().read_to_string(&mut body).map(|_| ()),
    };
    if let Err(e) = read {
        eprintln!("crew-board: {e}");
        return 1;
    }
    match serde_json::from_str::<Value>(&body) {
        Ok(d) => {
            write_targets(&d);
            0
        }
        Err(e) => {
            eprintln!("crew-board: the state is not JSON: {e}");
            1
        }
    }
}

/// A served page's URL: the running server's port, else the pin it will take.
fn page_url(path: &str) -> String {
    let port = crate::server::current().map(|c| c.0).unwrap_or_else(|| {
        std::env::var("CREW_INTENT_PORT").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(7345)
    });
    format!("http://127.0.0.1:{port}{path}")
}

/// What a Dock verb says now that the Dock board is gone.
fn retired(sub: &str, url: &str) -> String {
    format!(
        "seamux crew-board: `{sub}` drove the Dock board, which the cutover retired. \
         The board is served live at {url}: the seamux app's Board tab, cmux's \
         \"Crew board\" command, or `crew-board open`. There is nothing to {sub}."
    )
}

/// Start the intent server unless one answers, and wait briefly for it. It
/// runs from $HOME, detached: a server left in a worktree's directory outlives
/// the worktree, and every node child it starts then dies on a missing cwd.
fn ensure_server() -> bool {
    if crate::server::current().is_some() {
        return true;
    }
    // Its stderr goes to the server log, where a failure below sends people:
    // the reasons it cannot start (no port, no token file) are printed there.
    if crate::server::spawn_server(None).is_err() {
        return false;
    }
    // One deadline for the whole wait; each look gets a short timeout of its
    // own, so a slow answer cannot stretch it.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if crate::server::current_within(left.min(Duration::from_millis(300)).max(Duration::from_millis(50))).is_some() {
            return true;
        }
    }
    false
}

/// Open a served page (/board, /usage) in a cmux browser tab.
fn open_page(path: &str) -> i32 {
    if !ensure_server() {
        eprintln!("seamux crew-board: the intent server did not start; see {}", crate::server::log_file().display());
        return 1;
    }
    let url = page_url(path);
    let (ok, text) = cmux(&["open", &url]);
    if ok {
        println!("{url}");
        0
    } else {
        eprintln!("seamux crew-board: cmux could not open {url}: {text}");
        1
    }
}

pub fn main(args: &[String]) -> i32 {
    match args.first().map(String::as_str).unwrap_or("state") {
        "state" => cmd_state(args),
        "write-targets" => cmd_write_targets(args),
        "open" => open_page("/board"),
        "usage" => open_page("/usage"),
        sub @ ("push" | "watch" | "close" | "tidy") => {
            eprintln!("{}", retired(sub, &page_url("/board")));
            2
        }
        _ => {
            println!("{DOC}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(ws: &str, surface: &str, cwd: &str, label: &str, agent: Option<(&str, &str)>) -> LivePane {
        LivePane {
            ws: ws.into(),
            surface: surface.into(),
            cwd: cwd.into(),
            label: label.into(),
            agent: agent.map(|a| a.0.to_string()),
            state: agent.map(|a| a.1.to_string()).unwrap_or_default(),
        }
    }

    fn file(ws: &str, surface: &str, state: &str, at: u64) -> crew_core::status::Pane {
        crew_core::status::Pane { state: state.into(), at, ..crew_core::status::Pane::new(ws, surface) }
    }

    #[test]
    fn a_row_lists_two_claudes_and_a_terminal() {
        // A pin whose directory exists: a dead one is not followed.
        let one = std::env::temp_dir().join(format!("board-pin-{}", std::process::id()));
        std::fs::create_dir_all(one.join("sub")).unwrap();
        let one = std::fs::canonicalize(&one).unwrap().to_string_lossy().into_owned();
        let mut rows = vec![json!({"id": "W1"}), json!({"id": "W2"}), json!({"id": "W3"})];
        let mut plans = Map::new();
        plans.insert("/w/one".into(), json!({"slug": "p", "phase": "implementing", "owner": {"workspace": "w1", "surface": "s-own"}}));
        plans.insert("/w/old".into(), json!({"slug": "q", "phase": "done", "owner": {"workspace": "W2", "surface": "S-X"}}));
        let wss = vec![json!({"id": "W1", "description": format!("ci:green root:{one}")}), json!({"id": "W2", "description": ""})];
        let live = vec![
            live("W1", "S-TERM", "/elsewhere", "cargo test", None),
            live("W1", "S-OWN", &format!("{one}/sub"), "Claude Code", Some(("claude", "idle"))),
            live("W1", "S-TWO", &one, "Claude Code", Some(("claude", "working"))),
            live("W2", "S-X", "/anywhere", "Claude Code", Some(("claude", "unknown"))),
        ];
        // The owner's hooks say it waits on you, and cmux's idle loses to them;
        // S-TWO has no file, so cmux's working stands.
        let files = vec![file("W1", "S-OWN", "needs_input", 1_000), file("W9", "S-GONE", "working", 5)];
        mark_panes(&mut rows, &plans, &wss, &live, &files);
        assert_eq!(
            rows[0]["panes"],
            json!([
                {"surface": "S-OWN", "kind": "claude", "state": "needs_input", "since": 1000, "asked": false,
                 "what": "Claude Code", "plan": "p"},
                {"surface": "S-TWO", "kind": "claude", "state": "working", "since": 0, "asked": false, "what": "Claude Code"},
                {"surface": "S-TERM", "kind": "term", "state": "shell", "since": 0, "asked": false, "what": "cargo test",
                 "outside": true},
            ])
        );
        // A done plan tags nothing, and a workspace with no pin has no outside.
        assert_eq!(
            rows[1]["panes"],
            json!([{"surface": "S-X", "kind": "claude", "state": "", "since": 0, "asked": false, "what": "Claude Code"}])
        );
        // A workspace with no running pane lists none.
        assert!(rows[2].get("panes").is_none());
    }

    #[test]
    fn an_asked_pane_leads_and_an_ended_claude_is_a_terminal() {
        let mut rows = vec![json!({"id": "W1"})];
        let live = vec![
            live("W1", "A", "", "Claude Code", Some(("claude", "working"))),
            live("W1", "B", "", "zsh", None),
            live("W1", "C", "", "Claude Code", Some(("claude", "idle"))),
        ];
        let mut asked = file("W1", "C", "idle", 7);
        asked.asked = Some("Ship it?".into());
        // B's Claude exited; its pane is a shell now.
        let files = vec![asked, file("W1", "B", "ended", 3)];
        mark_panes(&mut rows, &Map::new(), &[], &live, &files);
        let got: Vec<(&str, &str, &str)> = rows[0]["panes"].as_array().unwrap().iter()
            .map(|p| (p["surface"].as_str().unwrap(), p["kind"].as_str().unwrap(), p["state"].as_str().unwrap()))
            .collect();
        assert_eq!(got, [("C", "claude", "idle"), ("A", "claude", "working"), ("B", "term", "shell")]);
        assert_eq!(rows[0]["panes"][0]["asked"], true);
    }

    #[test]
    fn a_crashed_claudes_pane_file_reads_as_a_shell() {
        let live = vec![
            live("W", "S-DEAD", "", "zsh", None),
            live("W", "S-NAT", "", "zsh", None),
            live("W", "S-NOREC", "", "zsh", None),
            live("W", "S-CMUX", "", "", Some(("claude", "idle"))),
        ];
        let f = |s: &str, sess: &str| crew_core::status::Pane { session: sess.into(), ..file("W", s, "working", 1) };
        let mut files = vec![f("S-DEAD", "old"), f("S-NAT", "new"), f("S-NOREC", "x"), f("S-CMUX", "y")];
        // By each file's own session: S-DEAD's process is gone; S-NAT is a native
        // pane whose live session is newer than the one the store has active on
        // that surface; the store has no record of S-NOREC's session.
        let alive = || {
            Some(std::collections::HashMap::from([
                ("S-DEAD".to_string(), (false, "working".to_string())),
                ("S-NAT".to_string(), (true, "working".to_string())),
            ]))
        };
        drop_gone(&mut files, &live, alive);
        let st: Vec<&str> = files.iter().map(|f| f.state.as_str()).collect();
        assert_eq!(st, ["ended", "working", "working", "working"]);
        // With no suspect, the store is not read.
        let mut files = vec![f("S-CMUX", "y")];
        drop_gone(&mut files, &live, || panic!("no suspect, no store read"));
        // No readable store proves nothing: the file stands.
        let mut files = vec![f("S-DEAD", "old")];
        drop_gone(&mut files, &live, || None);
        assert_eq!(files[0].state, "working");
    }


    #[test]
    fn without_cmux_a_row_lists_its_plan_owners() {
        let mut rows = vec![json!({"id": "W1"})];
        let mut plans = Map::new();
        plans.insert("/w/a".into(), json!({"slug": "a", "phase": "implementing", "owner": {"workspace": "W1", "surface": "S"}}));
        plans.insert("/w/b".into(), json!({"slug": "b", "phase": "planning", "owner": {"workspace": "W1", "surface": "S"}}));
        mark_panes(&mut rows, &plans, &[], &[], &[]);
        assert_eq!(
            rows[0]["panes"],
            json!([{"surface": "S", "kind": "claude", "state": "", "since": 0, "asked": false, "what": "", "plan": "a, b"}])
        );
    }

    #[test]
    fn live_panes_come_from_running_terminals() {
        let v = json!({"items": [
            {"kind": "terminal", "lifecycle": "running", "cwd": "/w", "label": "cargo test",
             "projections": [{"workspace_id": "W", "panel_id": "S1"}], "agents": []},
            {"kind": "terminal", "lifecycle": "running", "cwd": "/w", "label": "Claude Code",
             "projections": [{"workspace_id": "W", "panel_id": "S2"}], "agents": [{"kind": "claude", "state": "unknown"}]},
            {"kind": "terminal", "lifecycle": "exited", "projections": [{"workspace_id": "W", "panel_id": "S3"}]},
            {"kind": "browser", "lifecycle": "running", "projections": [{"workspace_id": "W", "panel_id": "S4"}]},
        ]});
        let got = live_panes_of(&v);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].label.as_str(), got[0].agent.clone()), ("cargo test", None));
        assert_eq!((got[1].agent.as_deref(), got[1].state.as_str()), (Some("claude"), "unknown"));
    }
}
