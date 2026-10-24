//! `crew-sweep`: walk the machine's finished and dormant workspaces, one card
//! at a time.
//!
//! ```text
//! crew-sweep              the wizard: one card, one key, next card
//! crew-sweep --json       the ordered queue, for scripts and the probe
//! crew-sweep --family-ok  also offer what deep-plan protects; a and r then
//!                         ask a y/N naming the family (a person only)
//! ```
//!
//! Machine-wide, as cmux is: every live workspace, every archive record and
//! every worktree of each repo those point at, keyed by worktree root. A card
//! is merged (the branch landed), dormant (idle past sweep.dormant_days, not
//! mid-turn) or orphaned (an archive record whose worktree is gone). A merged
//! or dormant worktree `deep-plan protects` is held back, merged or not, and
//! counted at the end; --family-ok offers it with the reason (ADR 0031). Jev orders the queue through crew-core's typesafe (ADR 0023), each
//! answer cached by transcript size; without it, orphaned and merged first,
//! then the longest idle. Each card takes one key; nothing here deletes
//! anything itself (crew-reclaim's guards and question do that).

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crew_core::workspaces::{self as w, Ws};
use crew_core::{py, pyjson, typesafe};
use serde_json::{json, Map, Value};

use crate::pypath::{basename, join};
use crate::pyval::{py_space, py_str, py_strip, truthy};
use crate::sync::facts::realpath;
use crate::{md5, proc, sibling, term};

const DAY: f64 = 86400.0;
const MAX_CHARS: usize = 4000;
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

fn tint(reason: &str) -> &'static str {
    match reason {
        "merged" => "\x1b[32m",
        "dormant" => "\x1b[33m",
        "orphaned" => "\x1b[35m",
        _ => "",
    }
}

/// The two System One questions, as the Python keeps them beside the code
/// that reads the answers.
fn questions() -> Value {
    json!({
        "finished": {
            "type": "noul",
            "instructions": "This is a software workspace an engineer left idle: a git worktree with an AI coding agent in it. `last_message` is the agent's final message, `last_prompt` the engineer's final request, and the other fields describe the branch. Is the work in this workspace finished, so that the workspace can be put away?",
            "criteria": {
                "true": "The task is done: the agent reports it complete, the branch merged or its pull request is up with nothing left to do, or the last exchange closes the work out.",
                "false": "Work remains: the agent is partway, asks something, reports a failure, or lists next steps that nobody has taken."
            }
        },
        "abandoned": {
            "type": "noul",
            "instructions": "This is a software workspace an engineer left idle: a git worktree with an AI coding agent in it. `last_message` is the agent's final message, `last_prompt` the engineer's final request, and the other fields describe the branch. Has the engineer abandoned this work, so that the workspace can be put away even though it is not finished?",
            "criteria": {
                "true": "The work was dropped: an experiment or spike that went nowhere, a question answered with no follow-up, a superseded approach, or a long idle stretch after an unanswered or dead-end exchange.",
                "false": "The work is live or finished: it was idle only briefly, it is waiting on review or another person, or it ended in a clear result."
            }
        }
    })
}

fn cache_dir() -> String {
    crew_core::home::xdg_cache().to_string_lossy().into_owned()
}

fn cache_path() -> String {
    join(&cache_dir(), "sweep-judgments.json")
}


/// workspaces.py's _git: (returncode, stdout stripped); (1, "") on a failure to run.
fn git(cwd: &str, args: &[&str]) -> (i32, String) {
    let mut argv = vec!["git", "-C", cwd];
    argv.extend_from_slice(args);
    match proc::run(&argv, None, &[], Some(Duration::from_secs(10))) {
        Some(o) if o.utf8 => (o.code, py_strip(&o.stdout).to_string()),
        _ => (1, String::new()),
    }
}

/// (primary checkout, linked worktree paths) of the repo cwd belongs to.
fn worktrees_of(cwd: &str) -> Vec<String> {
    let (rc, out) = git(cwd, &["worktree", "list", "--porcelain"]);
    if rc != 0 {
        return vec![];
    }
    let paths: Vec<String> =
        py::splitlines(&out).into_iter().filter_map(|l| l.strip_prefix("worktree ")).map(String::from).collect();
    paths.into_iter().skip(1).collect()
}

/// (worktree root, linked?) by real path; None outside a checkout.
fn toplevel(path: &str) -> Option<(String, bool)> {
    let (rc, out) = git(path, &["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
    let parts: Vec<&str> = if rc == 0 { py::splitlines(&out) } else { vec![] };
    if parts.len() != 3 {
        return None;
    }
    Some((realpath(parts[0]), realpath(parts[1]) != realpath(parts[2])))
}

/// crew-sync's cached PR facts for a worktree; {} when it never looked.
fn gh_cache(cwd: &str) -> Map<String, Value> {
    let p = join(&cache_dir(), &format!("gh-{}.json", md5::hex(cwd.as_bytes())));
    match crate::pyval::read_json(&p) {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

fn last_commit_at(cwd: &str) -> f64 {
    let (rc, out) = git(cwd, &["log", "-1", "--format=%ct"]);
    if rc != 0 {
        return 0.0;
    }
    out.trim().parse().unwrap_or(0.0)
}

fn num(v: Option<&Value>) -> f64 {
    v.filter(|x| truthy(Some(x))).and_then(Value::as_f64).unwrap_or(0.0)
}

/// One candidate card.
#[derive(Clone, Debug)]
pub struct Card {
    pub cwd: String,
    pub ws: Option<Ws>,
    pub rec: Option<Value>,
    pub title: String,
    pub branch: String,
    pub linked: bool,
    pub idle_days: Option<f64>,
    pub life: String,
    pub plan: String,
    /// deep-plan's reason it protects this worktree, "" when it does not.
    pub protected: String,
    /// Protected and not offered: counted, never shown (no --family-ok).
    pub held: bool,
    pub pr: Value,
    pub pr_state: String,
    pub session: Value,
    pub said: String,
    pub last: String,
    pub merged: bool,
    pub reason: String,
    pub jev: Option<(f64, f64)>,
}

/// Why this is on the sweep, or "" when it is not.
fn classify(c: &Card, days: i64) -> String {
    if c.rec.is_some() && !Path::new(&c.cwd).is_dir() {
        return "orphaned".into();
    }
    if c.life == "running" || c.life == "unknown" {
        return String::new(); // never offer to put away a turn in progress
    }
    if c.merged {
        return "merged".into();
    }
    if c.idle_days.is_some_and(|d| d >= days as f64) {
        return "dormant".into();
    }
    String::new()
}

/// Every candidate on the machine, unordered; None when cmux did not list
/// its workspaces (a sweep that cannot see what is open offers nothing). One
/// deep-plan protects carries `protected` and, unless family_ok, `held`.
pub fn gather(family_ok: bool) -> Option<Vec<Card>> {
    let now = py::now();
    let live = w::live_workspaces()?;
    let records = w::agent_sessions();
    let archived = w::load_archive();
    let (sessions, _) = w::build_index(false);
    let mut by_cwd: Vec<(String, Vec<Value>)> = Vec::new();
    for s in sessions {
        let cwd = s.get("cwd").filter(|v| truthy(Some(v))).map(py_str);
        if let Some(cwd) = cwd {
            match by_cwd.iter_mut().find(|(c, _)| *c == cwd) {
                Some(slot) => slot.1.push(s),
                None => by_cwd.push((cwd, vec![s])),
            }
        }
    }
    let by_mtime = |ss: &mut Vec<Value>| {
        ss.sort_by(|a, b| num(b.get("mtime")).partial_cmp(&num(a.get("mtime"))).unwrap_or(std::cmp::Ordering::Equal))
    };
    for (_, ss) in by_cwd.iter_mut() {
        by_mtime(ss);
    }

    // Keyed by worktree root: a subdirectory workspace, its record and the
    // worktree git lists are one card.
    let mut roots: HashMap<String, String> = HashMap::new();
    let mut linked_of: HashMap<String, bool> = HashMap::new();
    let mut root_of = |path: &str| -> String {
        if let Some(r) = roots.get(path) {
            return r.clone();
        }
        let (top, linked) = if Path::new(path).is_dir() { toplevel(path).unwrap_or((String::new(), false)) } else { (String::new(), false) };
        let r = if top.is_empty() { path.to_string() } else { top };
        roots.insert(path.to_string(), r.clone());
        linked_of.insert(r.clone(), linked);
        r
    };
    let mut open_at: Vec<(String, Ws)> = Vec::new();
    for ws in &live {
        if !ws.cwd.is_empty() {
            let r = root_of(&ws.cwd);
            if !open_at.iter().any(|(k, _)| *k == r) {
                open_at.push((r, ws.clone()));
            }
        }
    }
    let mut rec_at: Vec<(String, Value)> = Vec::new();
    for (k, rec) in &archived {
        let r = root_of(k);
        if !rec_at.iter().any(|(x, _)| *x == r) {
            rec_at.push((r, rec.clone()));
        }
    }
    let mut cwds: Vec<String> = Vec::new();
    for c in open_at.iter().map(|(k, _)| k).chain(rec_at.iter().map(|(k, _)| k)) {
        if !cwds.contains(c) {
            cwds.push(c.clone());
        }
    }
    for c in cwds.clone() {
        if Path::new(&c).is_dir() {
            for p in worktrees_of(&c) {
                if Path::new(&p).is_dir() {
                    let r = root_of(&p);
                    if !cwds.contains(&r) {
                        cwds.push(r);
                    }
                }
            }
        }
    }
    // A session in a subdirectory, or on a symlinked path, joins its
    // worktree's card; where roots nest, the deepest one takes it.
    let strays: Vec<String> = by_cwd.iter().map(|(c, _)| c.clone()).filter(|c| !cwds.contains(c)).collect();
    for c in strays {
        let real = realpath(&c);
        let under = |r: &String| {
            let base = format!("{}/", r.trim_end_matches('/'));
            real == *r || real.starts_with(&base) || c.starts_with(&base)
        };
        if let Some(r) = cwds.iter().filter(|r| under(r)).max_by_key(|r| r.len()).cloned() {
            let moved = by_cwd.iter().find(|(k, _)| *k == c).map(|(_, v)| v.clone()).unwrap_or_default();
            match by_cwd.iter_mut().find(|(k, _)| *k == r) {
                Some(slot) => slot.1.extend(moved),
                None => by_cwd.push((r, moved)),
            }
        }
    }
    for (_, ss) in by_cwd.iter_mut() {
        by_mtime(ss);
    }
    let days = w::dormant_days();
    cwds.sort();

    let mut out = Vec::new();
    for cwd in cwds {
        let ws = open_at.iter().find(|(k, _)| *k == cwd).map(|(_, v)| v.clone());
        let rec = rec_at.iter().find(|(k, _)| *k == cwd).map(|(_, v)| v.clone());
        let exists = Path::new(&cwd).is_dir();
        if !exists && rec.is_none() {
            continue; // a worktree git still lists, removed by hand
        }
        let ss = by_cwd.iter().find(|(k, _)| *k == cwd).map(|(_, v)| v.clone()).unwrap_or_default();
        let latest = ss.first().cloned().unwrap_or(json!({}));
        let gh = if exists { gh_cache(&cwd) } else { Map::new() };
        let rec_v = rec.clone().unwrap_or(json!({}));
        let when = [num(latest.get("mtime")), num(rec_v.get("archived_at")), if exists { last_commit_at(&cwd) } else { 0.0 }]
            .into_iter()
            .fold(0.0, f64::max);
        let field = |v: &Value, k: &str| v.get(k).filter(|x| truthy(Some(x))).map(py_str);
        let title = ws
            .as_ref()
            .map(|w| w.title.clone())
            .filter(|t| !t.is_empty())
            .or_else(|| field(&rec_v, "title"))
            .unwrap_or_else(|| basename(&cwd).to_string());
        let branch = Some(if exists { w::branch(&cwd) } else { String::new() })
            .filter(|b| !b.is_empty())
            .or_else(|| field(&rec_v, "branch"))
            .unwrap_or_default();
        let life = match &ws {
            Some(x) => w::lifecycle_of(&x.id, &x.r#ref, records.as_deref()).to_string(),
            None => "none".into(),
        };
        let pr_state = gh.get("prState").filter(|v| truthy(Some(v))).map(|v| py_str(v).to_lowercase()).unwrap_or_default();
        let said = field(&latest, "said").or_else(|| ws.as_ref().map(|x| x.last_message.clone()).filter(|m| !m.is_empty())).unwrap_or_default();
        let last = field(&latest, "last").or_else(|| field(&latest, "prompt")).unwrap_or_default();
        let mut c = Card {
            linked: exists && linked_of.get(&cwd).copied().unwrap_or(false),
            idle_days: (when != 0.0).then(|| (now - when) / DAY),
            plan: String::new(),
            protected: String::new(),
            held: false,
            pr: gh.get("pr").cloned().unwrap_or(Value::Null),
            merged: false,
            reason: String::new(),
            jev: None,
            session: latest,
            cwd: cwd.clone(),
            ws,
            rec,
            title,
            branch,
            life,
            pr_state,
            said,
            last,
        };
        c.merged = exists && (c.pr_state == "merged" || w::merged(&cwd));
        c.reason = classify(&c, days);
        if c.reason == "merged" || c.reason == "dormant" {
            // Asked only of what would be offered, and before the card exists,
            // so a merged child is held like any other.
            let p = w::protects(&cwd);
            if p.protected {
                c.protected = if p.error { w::refusal(&c.title, &p) } else { p.why.clone() };
                c.plan = if p.phase.is_empty() { "open".into() } else { p.phase.clone() };
                c.held = !family_ok;
            }
        }
        if !c.reason.is_empty() {
            out.push(c);
        }
    }
    Some(out)
}

// --- judging -------------------------------------------------------------------------

fn load_cache() -> Map<String, Value> {
    match crate::pyval::read_json(&cache_path()) {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

/// Merge fresh judgments into the cache, under an flock on its sidecar.
fn save(entries: Map<String, Value>) {
    let path = cache_path();
    let Ok(_lock) = py::Flock::exclusive(Path::new(&format!("{path}.lock"))) else { return };
    let mut cache = load_cache();
    cache.extend(entries);
    let _ = py::write_atomic(Path::new(&path), pyjson::dumps(&Value::Object(cache)).as_bytes());
}

/// Python's round(x, n): the exact value, ties to even.
fn round(x: f64, n: usize) -> f64 {
    format!("{x:.n$}").parse().unwrap_or(x)
}

/// What Jev is shown (ADR 0023: the prompt and title may leave the machine).
fn state_of(c: &Card) -> Value {
    let tail = |s: &str| {
        let ch: Vec<char> = s.chars().collect();
        ch[ch.len().saturating_sub(MAX_CHARS)..].iter().collect::<String>()
    };
    json!({
        "last_message": tail(&c.said),
        "last_prompt": tail(&c.last),
        "workspace_title": c.title,
        "branch": c.branch,
        "pr_state": if !c.pr_state.is_empty() { c.pr_state.clone() } else if c.merged { "merged".into() } else { "none".to_string() },
        "idle_days": match c.idle_days { Some(d) => pyjson::float(round(d, 1)), None => json!(-1) },
        "plan_phase": if c.plan.is_empty() { "none".to_string() } else { c.plan.clone() },
    })
}

/// Fill c.jev where TypeSafe answers, within the judging deadline; a failure
/// leaves a card unjudged, never guessed. True when any card was judged.
fn judge(cands: &mut [Card]) -> Result<bool, i32> {
    let key = typesafe::api_key();
    if key.is_empty() {
        return Ok(false);
    }
    let deadline = match std::env::var("CREW_SWEEP_JUDGE_SECONDS") {
        Ok(v) => match py_strip(&v).parse::<f64>() {
            Ok(f) => f,
            Err(_) => return Err(crate::pyerr::crash(&format!("ValueError: could not convert string to float: {}", crate::pyerr::repr(&v)))),
        },
        Err(_) => 20.0,
    };
    let now = py::now();
    let cache = load_cache();
    let mut ask: Vec<(usize, i64)> = Vec::new();
    for (i, c) in cands.iter_mut().enumerate() {
        if c.reason == "orphaned" {
            continue; // nothing left to judge: the tree is gone
        }
        let size = c.session.get("size").and_then(Value::as_i64).unwrap_or(0);
        let hit = cache.get(&c.cwd);
        let cached = hit.filter(|h| h.get("transcript_size").and_then(Value::as_i64).unwrap_or(-1) == size && h.get("finished").is_some());
        match cached.and_then(|h| Some((h.get("finished")?.as_f64()?, h.get("abandoned")?.as_f64()?))) {
            Some(j) => c.jev = Some(j),
            None => ask.push((i, size)),
        }
    }
    if !ask.is_empty() && term::stdout_tty() {
        println!("{DIM}→ asking Jev about {}{RESET}", ask.len());
    }
    let (tx, rx) = mpsc::channel::<(usize, i64, Option<(f64, f64)>)>();
    // First in, first out, eight at a time; once the deadline passes nothing
    // more is asked (the Python cancels what has not started).
    let queue = std::sync::Arc::new(std::sync::Mutex::new(
        ask.iter().map(|(i, size)| (*i, *size, state_of(&cands[*i]))).collect::<std::collections::VecDeque<_>>(),
    ));
    let end = Instant::now() + Duration::from_secs_f64(deadline.max(0.0));
    for _ in 0..8.min(ask.len()) {
        let (tx, queue, key) = (tx.clone(), queue.clone(), key.clone());
        std::thread::spawn(move || loop {
            if Instant::now() >= end {
                break;
            }
            let Some((i, size, state)) = queue.lock().ok().and_then(|mut q| q.pop_front()) else { break };
            let v = typesafe::ask(&key, &state, &questions()).ok().and_then(|a| {
                let f = a.get("finished")?.get("noul")?.as_f64()?;
                let b = a.get("abandoned")?.get("noul")?.as_f64()?;
                Some((round(f, 3), round(b, 3)))
            });
            let _ = tx.send((i, size, v));
        });
    }
    drop(tx);
    let mut fresh = Map::new();
    for _ in 0..ask.len() {
        match rx.recv_timeout(end.saturating_duration_since(Instant::now())) {
            Ok((i, size, Some((f, a)))) => {
                cands[i].jev = Some((f, a));
                fresh.insert(
                    cands[i].cwd.clone(),
                    json!({"finished": pyjson::float(f), "abandoned": pyjson::float(a), "at": pyjson::float(now), "transcript_size": size}),
                );
            }
            Ok(_) => {}
            Err(_) => break, // the rest keep the fallback order
        }
    }
    if !fresh.is_empty() {
        save(fresh);
    }
    Ok(cands.iter().any(|c| c.jev.is_some()))
}

/// Jev's rank first; then orphaned and merged, then the longest idle.
fn order(mut cands: Vec<Card>) -> Vec<Card> {
    let key = |c: &Card| -> (i32, f64, i32, f64) {
        let idle = c.idle_days.unwrap_or(-1.0);
        let tier = if c.reason == "orphaned" { 0 } else if c.merged { 1 } else { 2 };
        if c.reason == "orphaned" {
            return (0, 0.0, tier, -idle);
        }
        match c.jev {
            Some((f, a)) => (1, -f.max(a), tier, -idle),
            None => (2, 0.0, tier, -idle),
        }
    };
    cands.sort_by(|a, b| key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal));
    cands
}

/// The keys this card takes, in display order.
fn keys_for(c: &Card) -> Vec<&'static str> {
    let mut ks = Vec::new();
    if c.linked && Path::new(&c.cwd).is_dir() {
        ks.push("r");
    }
    if c.ws.is_some() {
        ks.push("a");
    }
    if c.rec.is_some() && c.ws.is_none() {
        ks.push("f");
    }
    ks.push("s");
    if c.ws.is_some() {
        ks.push("o");
    }
    ks.push("q");
    ks
}

fn label(k: &str) -> &'static str {
    match k {
        "r" => "[r]eclaim",
        "a" => "[a]rchive",
        "f" => "[f]orget",
        "s" => "[s]kip",
        "o" => "[o]pen",
        _ => "[q]uit",
    }
}

/// The text without its colour escapes.
fn plain(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' && it.peek() == Some(&'[') {
            let rest: String = it.clone().collect();
            let body: String = rest.chars().skip(1).take_while(|x| x.is_ascii_digit() || *x == ';').collect();
            if rest.chars().nth(1 + body.chars().count()) == Some('m') {
                for _ in 0..(2 + body.chars().count()) {
                    it.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// A line cut to `width` columns on what shows, never inside an escape, and
/// always ending its colour.
fn fit(s: &str, width: usize) -> String {
    let ch: Vec<char> = s.chars().collect();
    let (mut out, mut shown, mut i) = (String::new(), 0usize, 0usize);
    while i < ch.len() {
        if ch[i] == '\x1b' {
            let j = ch[i..].iter().position(|&c| c == 'm').map(|p| i + p).unwrap_or(ch.len() - 1);
            out.extend(&ch[i..=j]);
            i = j + 1;
            continue;
        }
        if shown + 1 == width && plain(&ch[i..].iter().collect::<String>()).chars().count() > 1 {
            out.push('…');
            break;
        }
        out.push(ch[i]);
        shown += 1;
        i += 1;
    }
    out + RESET
}

/// The card's lines, each at most `width` columns.
pub fn card(c: &Card, i: usize, n: usize, width: usize) -> Vec<String> {
    let repo = {
        let r = basename(c.cwd.split(".worktrees").next().unwrap_or("").trim_end_matches('/')).to_string();
        if r.is_empty() { c.title.clone() } else { r }
    };
    let where_ = format!("{repo} · {}", if c.branch.is_empty() { &c.title } else { &c.branch });
    let mut facts = vec![match c.idle_days {
        Some(d) => format!("idle {}d", d.trunc() as i64),
        None => "no activity on record".into(),
    }];
    if truthy(Some(&c.pr)) {
        facts.push(format!("PR #{} {}", py_str(&c.pr), c.pr_state));
    } else if c.merged {
        facts.push("merged".into());
    }
    if !c.plan.is_empty() {
        facts.push(format!("plan {}", c.plan));
    }
    if c.ws.is_none() {
        facts.push(if c.rec.is_some() { "archived" } else { "not open" }.into());
    }
    let mut lines = vec![fit(&format!(" {i}/{n}  {BOLD}{where_}{RESET}   {DIM}{}{RESET}", facts.join(" · ")), width)];
    let mut head = format!(" {}{}{RESET}", tint(&c.reason), c.reason);
    if c.reason == "orphaned" {
        head.push_str(&format!("{DIM}  the worktree is gone; only the record is left{RESET}"));
    }
    lines.push(fit(&head, width));
    if !c.protected.is_empty() {
        lines.push(fit(&format!(" \x1b[31mprotected:\x1b[0m {}", c.protected), width));
    }
    let src = if c.said.is_empty() { &c.last } else { &c.said };
    let said = src.split(py_space).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ");
    if !said.is_empty() {
        lines.push(fit(&format!(" last: \"{said}\""), width));
    }
    if let Some((f, a)) = c.jev {
        lines.push(fit(&format!(" jev: finished {f:.2} · abandoned {a:.2}"), width));
    }
    lines.push(fit(&format!(" {}", keys_for(c).iter().map(|k| label(k)).collect::<Vec<_>>().join(" ")), width));
    lines
}

// --- the wizard -----------------------------------------------------------------------

/// Run one key: (tally word, keep going).
fn act(k: &str, c: &Card) -> (Option<&'static str>, bool) {
    match k {
        "r" => {
            // crew-reclaim asks only when it has a terminal; down a pipe r must
            // not become a delete nobody was asked about.
            if !(term::stdin_tty() && term::stdout_tty()) {
                println!("  ✗ reclaim needs a terminal for crew-reclaim's question — skipped");
                return (None, true);
            }
            let target = c.ws.as_ref().map(|w| w.id.clone()).unwrap_or_else(|| c.cwd.clone());
            let reclaim = sibling::home_path("bin/crew-reclaim");
            let mut cmd = std::process::Command::new(&reclaim);
            if !c.protected.is_empty() {
                cmd.arg("--family-ok");
            }
            let rc = cmd.arg(&target).status().map(|s| s.code().unwrap_or(1)).unwrap_or(1);
            if rc == 0 {
                if let Some(rec) = &c.rec {
                    let cwd = rec.get("cwd").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_else(|| c.cwd.clone());
                    w::forget(&cwd);
                }
            }
            (if rc == 0 { Some("reclaimed") } else { None }, true)
        }
        "a" => {
            let id = c.ws.as_ref().map(|w| w.id.clone()).unwrap_or_default();
            let (ok, msg) = w::archive(&id, !c.protected.is_empty());
            println!("{}{msg}", if ok { "  ✓ " } else { "  ✗ " });
            (ok.then_some("archived"), true)
        }
        "f" => {
            let cwd = c.rec.as_ref().and_then(|r| r.get("cwd").filter(|v| truthy(Some(v))).map(py_str)).unwrap_or_else(|| c.cwd.clone());
            w::forget(&cwd);
            println!("  ✓ forgot {}", c.title);
            (Some("forgot"), true)
        }
        "o" => {
            if let Some(ws) = &c.ws {
                w::select(&ws.id);
            }
            (None, false)
        }
        "q" => (None, false),
        _ => (Some("skipped"), true),
    }
}

fn wizard(queue: &[Card]) {
    let mut tally: Vec<(&'static str, usize)> = Vec::new();
    let n = queue.len();
    let width = term::stdout_columns().unwrap_or(80).clamp(40, 120);
    for (i, c) in queue.iter().enumerate() {
        println!();
        for line in card(c, i + 1, n, width) {
            println!("{line}");
        }
        let ks = keys_for(c);
        let mut k = String::new();
        while !ks.contains(&k.as_str()) {
            k = term::sweep_key();
        }
        let (word, more) = act(&k, c);
        if let Some(word) = word {
            match tally.iter_mut().find(|(w, _)| *w == word) {
                Some(slot) => slot.1 += 1,
                None => tally.push((word, 1)),
            }
        }
        if !more {
            break;
        }
    }
    println!();
    let said = tally.iter().map(|(k, v)| format!("{v} {k}")).collect::<Vec<_>>().join(", ");
    println!("{DIM}swept: {}{RESET}", if said.is_empty() { "nothing".into() } else { said });
}

fn run(args: &[String]) -> i32 {
    let as_json = args.iter().any(|a| a == "--json");
    let family_ok = args.iter().any(|a| a == "--family-ok");
    if !as_json {
        println!("{DIM}→ looking at every workspace and worktree on this machine{RESET}");
    }
    let Some(all) = gather(family_ok) else {
        eprintln!("crew-sweep: cmux did not list its workspaces — nothing to sweep against");
        return 1;
    };
    let (mut held, mut cands): (Vec<Card>, Vec<Card>) = all.into_iter().partition(|c| c.held);
    held.sort_by(|a, b| a.cwd.cmp(&b.cwd));
    let on = match judge(&mut cands) {
        Ok(on) => on,
        Err(code) => return code,
    };
    let queue = order(cands);
    if as_json {
        let rows: Vec<Value> = queue
            .iter()
            .map(|c| {
                json!({
                    "cwd": c.cwd, "title": c.title, "branch": c.branch, "reason": c.reason, "merged": c.merged,
                    "linked": c.linked, "life": c.life, "plan": c.plan, "protected": c.protected,
                    "pr": c.pr, "pr_state": c.pr_state,
                    "idle_days": c.idle_days.map(|d| pyjson::float(round(d, 1))).unwrap_or(Value::Null),
                    "jev": c.jev.map(|(f, a)| json!({"finished": pyjson::float(f), "abandoned": pyjson::float(a)})).unwrap_or(Value::Null),
                    "ws": c.ws.as_ref().map(|w| json!(w.id)).unwrap_or(Value::Null),
                    "keys": keys_for(c),
                })
            })
            .collect();
        let held_rows: Vec<Value> = held
            .iter()
            .map(|c| json!({"cwd": c.cwd, "title": c.title, "reason": c.reason, "why": c.protected}))
            .collect();
        let out = json!({"typesafe": on, "dormant_days": w::dormant_days(), "queue": rows, "held": held_rows});
        println!("{}", pyjson::dumps_indent(&out, 1));
        return 0;
    }
    if queue.is_empty() {
        println!("nothing to sweep: no merged, dormant ({}d) or orphaned workspaces", w::dormant_days());
    } else {
        let how = if on { "in Jev's order" } else { "merged first, then longest idle (TypeSafe is off)" };
        println!("{DIM}{} to look at, {how}{RESET}", queue.len());
        wizard(&queue);
    }
    if !held.is_empty() {
        let width = term::stdout_columns().unwrap_or(80).clamp(40, 120);
        let mut names = held.iter().map(|c| c.title.as_str()).collect::<Vec<_>>().join(", ");
        if names.chars().count() > width - 8 {
            names = names.chars().take(width - 9).collect::<String>() + "…";
        }
        let them = if held.len() == 1 { "it" } else { "them" };
        println!("{DIM}{} held back by live plan or family work — --family-ok offers {them}{RESET}", held.len());
        println!("{DIM} held: {names}{RESET}");
    }
    0
}

extern "C" fn on_interrupt(_: libc::c_int) {
    // KeyboardInterrupt exits 130, as the Python's main does; a raw terminal
    // is put back first.
    crate::term::restore_mode();
    // SAFETY: _exit is async-signal-safe.
    unsafe { libc::_exit(130) }
}

pub fn main(args: &[String]) -> i32 {
    // SAFETY: the handler restores the terminal and exits.
    unsafe {
        libc::signal(libc::SIGINT, on_interrupt as *const () as libc::sighandler_t);
    }
    run(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card_of(branch: &str, said: &str) -> Card {
        Card {
            cwd: "/r/stale".into(),
            ws: Some(Ws {
                id: "w".into(),
                r#ref: "w".into(),
                title: "t".into(),
                cwd: "/r/stale".into(),
                color: String::new(),
                description: String::new(),
                selected: false,
                window: String::new(),
                last_message: String::new(),
            }),
            rec: None,
            title: "t".into(),
            branch: branch.into(),
            linked: true,
            idle_days: Some(3.0),
            life: "idle".into(),
            plan: String::new(),
            protected: String::new(),
            held: false,
            pr: Value::Null,
            pr_state: String::new(),
            session: json!({}),
            said: said.into(),
            last: String::new(),
            merged: false,
            reason: "dormant".into(),
            jev: None,
        }
    }

    /// workspaces_probe's in-process check, held here: a cut card line is
    /// measured on what shows, and still ends its colour.
    #[test]
    fn a_protected_card_says_why() {
        let mut c = card_of("dev/kid", "hi");
        c.protected = "plan kid is implementing; kid is a workstream of the fam family, which is not done".into();
        let lines = card(&c, 1, 1, 200);
        assert!(lines.iter().any(|l| plain(l).starts_with(" protected: plan kid") && plain(l).contains("the fam family")));
        assert!(!card(&card_of("dev/x", "hi"), 1, 1, 80).iter().any(|l| plain(l).contains("protected:")));
    }

    #[test]
    fn card_lines_fit_and_end_their_colour() {
        let c = card_of(&format!("dev/{}", "x".repeat(200)), &"y".repeat(300));
        for width in [40, 60, 80] {
            for line in card(&c, 1, 9, width) {
                assert!(plain(&line).chars().count() <= width, "{width}: {}", plain(&line).chars().count());
                assert!(line.ends_with(RESET));
            }
        }
        let short = card(&card_of("dev/x", "hi"), 2, 3, 80);
        assert_eq!(plain(&short[0]), " 2/3  stale · dev/x   idle 3d");
        assert_eq!(plain(&short[1]), " dormant");
        assert_eq!(plain(&short[2]), " last: \"hi\"");
        // no [r]eclaim: /r/stale is not a directory here (the Python prints the same four lines)
        assert_eq!(plain(&short[3]), " [a]rchive [s]kip [o]pen [q]uit");
    }

    #[test]
    fn fit_cuts_on_what_shows() {
        // python3: card's fit(" \x1b[1mabcdef\x1b[0m", 5) == " \x1b[1mabc…" + RESET
        assert_eq!(fit(" \x1b[1mabcdef\x1b[0m", 5), " \x1b[1mabc…\x1b[0m");
        assert_eq!(fit("abcde", 5), "abcde\x1b[0m");
        assert_eq!(fit("abcdef", 5), "abcd…\x1b[0m");
    }

    #[test]
    fn rounding_is_pythons() {
        assert_eq!(round(0.1234, 3), 0.123);
        assert_eq!(round(2.675, 2), 2.67); // the double is just under 2.675
        assert_eq!(round(29.95, 1), 29.9);
    }
}
