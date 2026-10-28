//! `crew-sync`: reconcile every workspace against what is actually true.
//!
//! ```text
//! crew-sync            reconcile once
//! crew-sync --dry-run  say what would change, change nothing
//! crew-sync --prune    also drop stale crew state files
//! ```
//!
//! Hooks publish crew's signals, so anything that stops events arriving (a
//! killed agent, an abandoned plan, a branch switch) leaves them pinned. This
//! reads what is true regardless of hooks (cmux's session store, the task
//! lists, git, gh, Jira, sandboxes, deep-plan's state) and writes only where
//! cmux's current value is wrong, so a converged board costs no writes.
//!
//! `facts` reads, `apply` writes through crates/cmux. One run at a time: the
//! same flock on the same `sync.lock` the Python takes.

pub mod apply;
pub mod facts;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use cmux::{Notify, WorkspaceAction};
use crew_core::pyjson::{self, Opts};
use serde_json::{json, Map, Value};

use crate::pypath::{basename, join};
use crate::pyval::{py_space, py_str, truthy};
use crate::{color, pyerr};
use apply::Writer;
use facts::{Paths, SIGNAL_PREFIXES};

const FEED_KEYS: [&str; 5] = ["feed", "feedby", "feedgate", "feedreq", "feedws"];
const SYNC_LOCK_WAIT: f64 = 60.0;

fn words(s: &str) -> impl Iterator<Item = &str> {
    s.split(py_space).filter(|t| !t.is_empty())
}

/// `desc` minus the freshness stamp, for comparing real signal content.
fn without_stamp(desc: &str) -> String {
    words(desc).filter(|t| !t.starts_with("synced:")).collect::<Vec<_>>().join(" ")
}

/// crew-feed's tokens, carried as found: not this tool's to judge.
fn feed_tokens(desc: &str) -> Vec<String> {
    words(desc).filter(|t| FEED_KEYS.contains(&t.split(':').next().unwrap_or(""))).map(String::from).collect()
}

/// `w.get(k) or ""` as a string.
fn field(w: &Value, k: &str) -> String {
    match w.get(k) {
        Some(v) if truthy(Some(v)) => py_str(v),
        _ => String::new(),
    }
}

/// `w.get("custom_title") or w.get("title") or ""`.
fn title_of(w: &Value) -> String {
    let t = field(w, "custom_title");
    if t.is_empty() {
        field(w, "title")
    } else {
        t
    }
}

/// sidebar-state's text: top-level `k=v` lines, and indented ones as pills.
#[derive(Default)]
struct SideState {
    vals: HashMap<String, String>,
    pills: HashSet<String>,
}

fn parse_state(out: &str) -> SideState {
    let mut d = SideState::default();
    for line in crew_core::py::splitlines(out) {
        if line.starts_with("  ") && line.contains('=') {
            let k = crate::pyval::py_strip(line).split('=').next().unwrap_or("").to_string();
            d.pills.insert(k);
        } else if let Some((k, v)) = line.split_once('=') {
            d.vals.insert(crate::pyval::py_strip(k).into(), crate::pyval::py_strip(v).into());
        }
    }
    d
}

enum Lock {
    Held(#[allow(dead_code)] fs::File),
    Busy,
    Unlocked,
}

/// One sync at a time, polled so a hung run never stalls the rest; a lock
/// file that cannot be opened runs unlocked rather than never syncing.
fn take_run_lock(p: &Paths) -> Lock {
    use std::os::unix::io::AsRawFd;
    let opened = fs::create_dir_all(&p.state)
        .and_then(|_| fs::OpenOptions::new().append(true).create(true).open(join(&p.state, "sync.lock")));
    let Ok(f) = opened else { return Lock::Unlocked };
    let deadline = crew_core::py::now() + SYNC_LOCK_WAIT;
    loop {
        // SAFETY: flock on a descriptor we own; the kernel drops it on close or death.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Lock::Held(f);
        }
        if crew_core::py::now() >= deadline {
            return Lock::Busy;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// One worktree's probe result: tokens, gh facts, and whether it finished.
type Probe = (Vec<String>, Map<String, Value>, bool);

/// `signals` for every (wsid, cwd, is_repo) on eight threads, each result
/// waited for up to 90s in turn, as the Python's pool did.
fn probe_all(p: &Paths, targets: &[(String, String, bool)], ttl: i64) -> HashMap<String, Probe> {
    let n = targets.len();
    let mut out: HashMap<String, Probe> = HashMap::new();
    if n == 0 {
        return out;
    }
    let next = AtomicUsize::new(0);
    std::thread::scope(|s| {
        let (tx, rx) = mpsc::channel::<(usize, Option<(Vec<String>, Map<String, Value>)>)>();
        for _ in 0..8.min(n) {
            let tx = tx.clone();
            let next = &next;
            s.spawn(move || loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= n {
                    break;
                }
                let (_, cwd, is_repo) = &targets[i];
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| facts::signals(p, cwd, *is_repo, ttl))).ok();
                let _ = tx.send((i, r));
            });
        }
        drop(tx);
        let mut got: HashMap<usize, Option<(Vec<String>, Map<String, Value>)>> = HashMap::new();
        for (i, (wsid, _, _)) in targets.iter().enumerate() {
            let deadline = Instant::now() + Duration::from_secs(90);
            while !got.contains_key(&i) {
                let left = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(left) {
                    Ok((j, r)) => {
                        got.insert(j, r);
                    }
                    Err(_) => break,
                }
            }
            let probe = match got.get(&i) {
                Some(Some((t, raw))) => (t.clone(), raw.clone(), true),
                _ => (vec![], Map::new(), false),
            };
            out.insert(wsid.clone(), probe);
        }
    });
    out
}

/// The run, returning the exit code.
pub fn main(args: &[String]) -> i32 {
    let has = |f: &str| args.iter().any(|a| a == f);
    let dry = has("--dry-run");
    let prune = has("--prune");
    let verbose = dry || has("-v") || has("--verbose");
    let (Some(gh_ttl), Some(jira_ttl)) =
        (facts::env_int("CREW_GH_INTERVAL", 300), facts::env_int("CREW_JIRA_INTERVAL", 900))
    else {
        return pyerr::crash("ValueError: invalid literal for int() with base 10");
    };
    let p = Paths::from_env();
    // crew-color runs in process here; the Python ran it with stderr captured.
    color::set_quiet(true);

    let _lock = if dry {
        Lock::Unlocked
    } else {
        match take_run_lock(&p) {
            Lock::Busy => {
                eprintln!(
                    "crew-sync: another sync has run for {}s and still holds the lock; skipping this one",
                    SYNC_LOCK_WAIT as i64
                );
                return 0;
            }
            l => l,
        }
    };

    let mut changes: Vec<(String, String)> = Vec::new();
    let note = |changes: &mut Vec<(String, String)>, ws: &str, what: String| {
        changes.push((crate::pyval::head(ws, 8), what));
    };

    let out = Writer::connect(dry);
    let by_ws = facts::sessions_by_ws(&p);
    // A workspace's worktree is its root: pin, else its current_directory.
    let dir_of = |w: &Value| crew_core::worktree::root_or(&field(w, "description"), &field(w, "current_directory"));
    let rows = out.workspaces();
    if let Some(bad) = rows.iter().find(|w| !w.is_object()) {
        return pyerr::crash(&format!("AttributeError: '{}' object has no attribute 'get'", py_str(bad)));
    }
    let mut taken: HashSet<String> = rows.iter().map(title_of).collect();

    let state_by_ws: HashMap<String, SideState> =
        rows.iter().map(|w| (field(w, "id"), parse_state(&out.sidebar_state(&field(w, "id"))))).collect();

    let jira = facts::jira_status(
        &p,
        &rows.iter().map(|w| facts::ticket_key(&facts::branch(&dir_of(w)))).collect::<Vec<_>>(),
        jira_ttl,
    );
    let sb_roots = facts::sandbox_registry(&p);
    let sb_states = if sb_roots.is_empty() { HashMap::new() } else { facts::sandbox_states(&p) };
    let (deep_roots, deep_sids) = facts::deep_plan_markers(&p);
    let (plan_roots, plan_sids) = facts::deep_plan_states(&p);
    let fam = facts::family_signals(&p, dry);

    // The freshness stamp rides on one workspace, the lowest id, so it costs
    // one write per sync rather than one per workspace.
    let stamp_ws = rows.iter().map(|w| field(w, "id")).min().unwrap_or_default();
    let stamp_now = crew_core::py::now() as i64;

    let mut roots: HashMap<String, String> = HashMap::new();
    for w in &rows {
        let cwd = dir_of(w);
        roots.insert(field(w, "id"), if cwd.is_empty() { String::new() } else { facts::toplevel(&cwd) });
    }
    let targets: Vec<(String, String, bool)> = rows
        .iter()
        .filter(|w| !dir_of(w).is_empty())
        .map(|w| {
            let id = field(w, "id");
            let repo = roots.get(&id).is_some_and(|r| !r.is_empty());
            (id, dir_of(w), repo)
        })
        .collect();
    let probes = probe_all(&p, &targets, gh_ttl);

    for w in &rows {
        let ws = field(w, "id");
        let title = title_of(w);
        let cwd = dir_of(w);
        let empty = SideState::default();
        let st = state_by_ws.get(&ws).unwrap_or(&empty);

        // Every Claude in the workspace, not only its active one: the
        // workspace is live while any of them lives, and its state is theirs
        // together (a waiting one first, then a working one).
        let none = Vec::new();
        let recs = by_ws.get(&ws).unwrap_or(&none);
        let live_recs: Vec<&(String, Value)> = recs.iter().filter(|(_, r)| facts::alive(r.get("pid"))).collect();
        let live = !live_recs.is_empty();
        let in_state = |st: &str| live_recs.iter().find(|(_, r)| field(r, "agentLifecycle") == st);
        let any_needs = in_state("needsInput").is_some();
        let any_running = in_state("running").is_some();
        // The session that speaks for the workspace: a working one, else a
        // waiting one, else the first live one, else the active record.
        let (sid, rec) = in_state("running")
            .or_else(|| in_state("needsInput"))
            .or_else(|| live_recs.first())
            .map(|(s, r)| (s.clone(), r.clone()))
            .or_else(|| recs.first().cloned())
            .unwrap_or_else(|| (String::new(), json!({})));
        let lifecycle = field(&rec, "agentLifecycle");
        let sids: Vec<&String> = recs.iter().map(|(s, _)| s).collect();

        // --- name ---------------------------------------------------------------
        let want = if cwd.is_empty() { String::new() } else { facts::desired_name(&cwd) };
        let may_rename = !truthy(w.get("has_custom_title")) || facts::crew_named(&title_of(w));
        if !want.is_empty() && want != title && may_rename {
            if taken.contains(&want) {
                if verbose {
                    note(&mut changes, &ws, format!("skipped name '{want}' (already used by another workspace)"));
                }
            } else {
                out.rename(&ws, &want);
                taken.insert(want.clone());
                note(&mut changes, &ws, format!("name -> {want}"));
            }
        }

        // --- plan / progress / pill -----------------------------------------------
        let plan = if sid.is_empty() { None } else { facts::plan(&p, &sid) };
        let has_progress = st.vals.get("progress").map(String::as_str).unwrap_or("none") != "none";
        if let Some(pl) = &plan {
            if st.vals.get("progress").map(String::as_str).unwrap_or("") != format!("{:.2} {}", pl.frac, pl.label) {
                out.set_progress(&ws, pl.frac, &pl.label);
                let items = pyjson::dumps_with(&Value::Array(pl.items.clone()), Opts { compact: true, ..Opts::default() });
                out.todo_set(&ws, &items);
                note(&mut changes, &ws, format!("progress -> {}", crate::pyval::head(&pl.label, 48)));
            }
        } else if has_progress {
            out.clear_progress(&ws);
            note(&mut changes, &ws, "cleared stale progress (no plan)".into());
        }
        let working = live && any_running && plan.as_ref().is_some_and(|pl| !pl.active.is_empty());
        if st.pills.contains("claude") && !working {
            out.clear_status("claude", &ws);
            let who = if lifecycle.is_empty() { "no session" } else { &lifecycle };
            note(&mut changes, &ws, format!("cleared stale task pill ({who})"));
        }

        // --- phase and signals --------------------------------------------------
        let mut tok: Vec<String> = Vec::new();
        let mut have_desc = field(w, "description");
        let root = roots.get(&ws).cloned().unwrap_or_default();
        let asking = Path::new(&join(&p.state, &format!("question-{ws}"))).exists();
        // One Claude waiting outranks another working, as the hooks' roll-up ranks them.
        if live && (asking || any_needs) && have_desc.contains("phase:waiting") {
            tok.push("phase:waiting".into());
        } else if live && any_running {
            tok.push("phase:working".into());
        }
        // "I could not find out" is never published as "there is nothing".
        let probe = probes.get(&ws);
        let mut probed: Vec<String> = probe.map(|(t, _, _)| t.clone()).unwrap_or_default();
        let fresh_false = probe.and_then(|(_, raw, _)| raw.get("fresh")) == Some(&Value::Bool(false));
        let blind = probe.is_some_and(|(_, _, ok)| !ok) || (!root.is_empty() && fresh_false);
        if blind {
            let carried: Vec<String> = words(&have_desc)
                .filter(|t| SIGNAL_PREFIXES.iter().any(|p| t.starts_with(p)) && !probed.iter().any(|x| x == t))
                .map(String::from)
                .collect();
            if !carried.is_empty() {
                note(&mut changes, &ws, format!("probe blind; kept {}", carried.join(" ")));
            }
            probed.extend(carried);
        }
        tok.extend(probed);
        let sb_name = if sb_roots.is_empty() { String::new() } else { facts::sandbox_for(&cwd, &sb_roots) };
        let sb_tok = facts::sandbox_token(&sb_name, &sb_states);
        tok.extend(sb_tok.iter().cloned());
        if sb_tok.iter().any(|t| t == "sandbox:running") && !tok.iter().any(|t| t.starts_with("phase:")) {
            let ph = facts::sandbox_phase(&p, &sb_name);
            if !ph.is_empty() {
                tok.push(format!("phase:{ph}"));
            }
        }
        // --- planning -----------------------------------------------------------
        let tracked = plan_roots.get(&root).or_else(|| sids.iter().find_map(|s| plan_sids.get(*s)));
        if let Some(t) = tracked {
            tok.extend(t.iter().cloned());
        } else if (!root.is_empty() && deep_roots.contains(&root)) || sids.iter().any(|s| deep_sids.contains(*s)) {
            tok.push("plan:deep".into());
        } else if live && facts::permission_mode(&p, &sid) == "plan" {
            tok.push("plan:mode".into());
        }
        if !root.is_empty() {
            tok.extend(fam.toks.get(&facts::realpath(&root)).cloned().unwrap_or_default());
        }
        let jt = facts::jira_token(jira.get(&facts::ticket_key(&facts::branch(&cwd))));
        if !jt.is_empty() {
            tok.push(jt);
        }
        // The pin rides through the rewrite: it is set once and never moved.
        if let Some(pin) = crew_core::worktree::root_of(&have_desc) {
            tok.push(crew_core::worktree::root_tok(&pin));
        }
        if !ws.is_empty() && ws == stamp_ws {
            tok.push(format!("synced:{stamp_now}"));
        }
        // Canonical order for the signal tokens, in their own slots.
        let rank = |t: &str| SIGNAL_PREFIXES.iter().position(|p| t.starts_with(p)).unwrap_or(usize::MAX);
        let idx: Vec<usize> = (0..tok.len()).filter(|&i| rank(&tok[i]) != usize::MAX).collect();
        if !idx.is_empty() {
            let mut ordered: Vec<String> = idx.iter().map(|&i| tok[i].clone()).collect();
            ordered.sort_by(|a, b| (rank(a), a.as_str()).cmp(&(rank(b), b.as_str())));
            for (slot, t) in idx.into_iter().zip(ordered) {
                tok[slot] = t;
            }
        }

        // The feed tokens, and a pin a SessionStart wrote since the rows were
        // read, come from the description `d`.
        let joined = |d: &str| {
            let pin = if tok.iter().any(|t| t.starts_with("root:")) {
                None
            } else {
                crew_core::worktree::root_of(d).map(|r| crew_core::worktree::root_tok(&r))
            };
            tok.iter().cloned().chain(pin).chain(feed_tokens(d)).collect::<Vec<_>>().join(" ")
        };
        let mut want_desc = joined(&have_desc);
        // A feed publish during this run must survive the write: take the feed
        // tokens from a fresh read, as crew-feed itself merges.
        if want_desc != have_desc && !dry {
            if let Some(fresh) = out.live_description(&ws) {
                want_desc = joined(&fresh);
                have_desc = fresh;
            }
        }
        if want_desc != have_desc {
            if want_desc.is_empty() {
                out.action(&ws, WorkspaceAction::ClearDescription);
            } else {
                out.action(&ws, WorkspaceAction::SetDescription(want_desc.clone()));
            }
            if without_stamp(&want_desc) != without_stamp(&have_desc) {
                let s = without_stamp(&want_desc);
                note(&mut changes, &ws, format!("signals -> {}", if s.is_empty() { "(cleared)".into() } else { s }));
            }
        }

        // --- identity color -------------------------------------------------------
        let real = if root.is_empty() { String::new() } else { facts::realpath(&root) };
        let have = field(w, "custom_color").to_uppercase();
        if let Some(c) = fam.wear.get(&real) {
            if have != c.to_uppercase() {
                out.action(&ws, WorkspaceAction::SetColor(c.clone()));
                note(&mut changes, &ws, format!("color -> {c} (family shade)"));
            }
        } else if let Some(back) = fam.restore.get(&real) {
            if !back.is_empty() && have != back.to_uppercase() {
                out.action(&ws, WorkspaceAction::SetColor(back.clone()));
                note(&mut changes, &ws, format!("color -> {back} (restored after its family)"));
            } else if back.is_empty() && !have.is_empty() {
                out.action(&ws, WorkspaceAction::ClearColor);
                note(&mut changes, &ws, "color cleared (it had none before its family)".into());
            }
        } else if !root.is_empty() && have.is_empty() {
            let hexv = color::color_for(&root, dry);
            if !hexv.is_empty() {
                out.action(&ws, WorkspaceAction::SetColor(hexv.clone()));
                note(&mut changes, &ws, format!("color -> {hexv}"));
            }
        }

        // --- lane -------------------------------------------------------------------
        let lane = out.lane(&ws);
        let who = if lifecycle.is_empty() { "no session".to_string() } else { lifecycle.clone() };
        if !lane.is_empty() && !live {
            out.lane_auto(&ws);
            note(&mut changes, &ws, format!("released stuck lane '{lane}' (session gone)"));
        } else if lane == "needs-attention" && !want_desc.contains("phase:waiting") {
            out.lane_auto(&ws);
            note(&mut changes, &ws, format!("released 'needs-attention' ({who}, not blocked)"));
        }
    }

    // --- transition notifications: only on change -----------------------------------
    for w in &rows {
        let ws = field(w, "id");
        let cwd = dir_of(w);
        let Some((_, raw, _)) = probes.get(&ws) else { continue };
        if !truthy(raw.get("pr")) || dry {
            continue;
        }
        let mut raw = raw.clone();
        let jira_entry = jira.get(&facts::ticket_key(&facts::branch(&cwd)));
        let ci = if truthy(raw.get("ciFail")) {
            "fail"
        } else if truthy(raw.get("ciPending")) {
            "run"
        } else {
            "pass"
        };
        let or_empty = |k: &str| raw.get(k).filter(|v| truthy(Some(v))).cloned().unwrap_or(json!(""));
        let mut sig = Map::new();
        sig.insert("jira".into(), json!(facts::jira_token(jira_entry)));
        sig.insert("ci".into(), json!(ci));
        sig.insert("review".into(), or_empty("review"));
        sig.insert("conflict".into(), json!(raw.get("mergeable") == Some(&json!("CONFLICTING"))));
        sig.insert("state".into(), or_empty("prState"));
        let prev = raw.get("notified").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!({}));
        let sig_v = Value::Object(sig.clone());
        if prev == sig_v {
            continue;
        }
        let pg = |k: &str| prev.get(k);
        let label = {
            let t = title_of(w);
            if t.is_empty() {
                basename(&cwd).to_string()
            } else {
                t
            }
        };
        let mut msgs: Vec<String> = Vec::new();
        if Some(&sig["ci"]) != pg("ci") {
            if ci == "fail" {
                let fails: Vec<String> = match raw.get("ciFail") {
                    Some(Value::Array(a)) => a.iter().take(3).map(py_str).collect(),
                    _ => vec![],
                };
                msgs.push(format!("CI red: {}", fails.join(", ")));
            } else if ci == "pass" && pg("ci") == Some(&json!("fail")) {
                msgs.push("CI green again".into());
            }
        }
        if Some(&sig["review"]) != pg("review") {
            if sig["review"] == "APPROVED" {
                msgs.push("approved".into());
            } else if sig["review"] == "CHANGES_REQUESTED" {
                msgs.push("changes requested".into());
            }
        }
        if Some(&sig["jira"]) != pg("jira") && truthy(pg("jira")) {
            if let Some((name, _)) = jira_entry {
                msgs.push(format!("Jira → {name}"));
            }
        }
        if sig["conflict"] == true && !truthy(pg("conflict")) {
            msgs.push("merge conflicts".into());
        }
        let state = py_str(&sig["state"]);
        if (state == "MERGED" || state == "CLOSED") && Some(&sig["state"]) != pg("state") {
            msgs.push(format!("PR {} — worktree can go", state.to_lowercase()));
        }
        if !msgs.is_empty() && truthy(Some(&prev)) {
            let body = format!("#{} {}", raw.get("pr").map(py_str).unwrap_or_default(), msgs.join(" · "));
            out.notify(Notify {
                title: label,
                subtitle: Some("crew:pr".into()),
                body: Some(body),
                workspace: Some(ws.clone()),
            });
            note(&mut changes, &ws, format!("notified: {}", msgs.join(" · ")));
            // Chime on good news only.
            let good = (ci == "pass" && pg("ci") == Some(&json!("fail")))
                || (sig["review"] == "APPROVED" && pg("review") != Some(&json!("APPROVED")))
                || (sig["state"] == "MERGED" && pg("state") != Some(&json!("MERGED")));
            if good && !dry && Path::new(&p.chime).exists() {
                crate::proc::spawn_quiet(&["afplay", &p.chime]);
            }
        }
        raw.insert("notified".into(), sig_v);
        facts::write_json(&facts::gh_cache_path(&p, &cwd), &Value::Object(raw));
    }

    // Pane state files whose workspace is gone, or whose Claude died without
    // a session-end hook, would hold their workspace's roll-up: they go, and
    // the workspace's question and asked markers are rolled up again.
    // Not on a run where cmux listed nothing (it was restarting): that is no
    // proof any workspace is gone.
    if !dry && !rows.is_empty() && Path::new(&p.state).is_dir() {
        let live_ws: HashSet<String> = rows.iter().map(|w| field(w, "id")).collect();
        let dir = Path::new(&p.state);
        let recs: HashMap<&str, &Value> = by_ws.values().flatten().map(|(s, r)| (s.as_str(), r)).collect();
        let day_ms = 86_400_000u64;
        let now_ms = crew_core::history::now_ms();
        let mut touched: HashSet<String> = HashSet::new();
        for pane in crew_core::status::all(dir) {
            let why = if !live_ws.contains(&pane.ws) {
                Some("workspace gone")
            } else {
                match recs.get(pane.session.as_str()) {
                    Some(r) if pane.state != "ended" && truthy(r.get("pid")) && !facts::alive(r.get("pid")) => Some("its Claude is gone"),
                    // An unreadable store lists no sessions at all: no proof either.
                    None if !recs.is_empty() && now_ms.saturating_sub(pane.at) > day_ms => Some("no session for a day"),
                    _ => None,
                }
            };
            if let Some(why) = why {
                crew_core::status::remove(dir, pane.key());
                touched.insert(pane.ws.clone());
                changes.push((crate::pyval::head(&pane.ws, 8), format!("pruned pane {} ({why})", crate::pyval::head(&pane.surface, 8))));
            }
        }
        for ws in touched.iter().filter(|w| live_ws.contains(*w)) {
            crew_core::status::write_markers(dir, ws, &crew_core::status::rollup(dir, ws));
        }
    }

    if prune {
        let live_ws: HashSet<String> = rows.iter().map(|w| field(w, "id")).collect();
        if Path::new(&p.state).is_dir() {
            for name in facts::listdir(&p.state).unwrap_or_default() {
                if let Some(id) = name.strip_prefix("lane-") {
                    if !live_ws.contains(id) {
                        if !dry {
                            let _ = fs::remove_file(join(&p.state, &name));
                        }
                        changes.push((id.chars().take(8).collect(), "pruned stale lane marker".into()));
                    }
                }
            }
        }
    }

    if !changes.is_empty() {
        for (ws, what) in &changes {
            println!("  {ws}  {what}");
        }
    } else if verbose {
        println!("  already in sync");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidebar_state_parses_pills_and_values() {
        let st = parse_state("progress=0.50 1/2\n  claude=Running\nlabel = x \n");
        assert_eq!(st.vals.get("progress").map(String::as_str), Some("0.50 1/2"));
        assert_eq!(st.vals.get("label").map(String::as_str), Some("x"));
        assert!(st.pills.contains("claude"));
    }

    #[test]
    fn feed_tokens_and_stamp() {
        assert_eq!(feed_tokens("ci:pass feed:perm feedby:9 x feedx:1"), vec!["feed:perm", "feedby:9"]);
        assert_eq!(without_stamp("a synced:12 b"), "a b");
    }
}
