//! Sub-agent and run rows on a card: the background work each pane's
//! session runs, from crew_core::runs, drawn under that pane (render.js).
//!
//! A row starts from the pane file's background list, which the hooks keep,
//! so it shows the moment a task starts. The adapters' report adds the
//! detail once a worker thread has read it: adapters are user code with a
//! timeout of seconds, so they never run on the feed's own thread. The
//! worker pokes the feed when a report changes.
//!
//! Only coarse fields go on a card (state, start, end, phase, k of n, the
//! badge): the elapsed time is drawn by the page, so a run's ticking tokens
//! never re-push the board. A finished row stays until the pane's next
//! prompt (crew's history says when that was).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crew_core::runs::{host, Context, Report, Run};
use crew_core::status::{Background, Pane};
use serde_json::{json, Value};

/// Rows on one card at most; the rest are "+N more".
pub const ROWS_MAX: usize = 4;
/// A session nobody asked about for this long drops out of the worker.
const WANTED_MS: u64 = 60_000;
/// How far back crew's history is read for a pane's last prompt.
const HISTORY_MS: u64 = 12 * 3_600_000;

struct Shared {
    /// Session id: its context and when the board last asked.
    wanted: HashMap<String, (Context, bool, u64)>,
    reports: HashMap<String, Report>,
}

fn shared() -> &'static Mutex<Shared> {
    static S: OnceLock<Mutex<Shared>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Shared { wanted: HashMap::new(), reports: HashMap::new() }))
}

/// The worker: every second, a report for each session the board asked
/// about recently. A changed report wakes the feed.
fn worker() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new().name("crew-board-runs".into()).spawn(|| loop {
            let now = crew_core::history::now_ms();
            let todo: Vec<(String, Context, bool)> = {
                let mut s = shared().lock().unwrap_or_else(|p| p.into_inner());
                s.wanted.retain(|_, (_, _, at)| now.saturating_sub(*at) < WANTED_MS);
                let keep: Vec<String> = s.wanted.keys().cloned().collect();
                s.reports.retain(|k, _| keep.contains(k));
                s.wanted.iter().map(|(k, (c, all, _))| (k.clone(), c.clone(), *all)).collect()
            };
            let mut changed = false;
            if !todo.is_empty() {
                let (adapters, _) = host::adapters();
                for (k, ctx, all) in todo {
                    let rep = host::report(&ctx, &adapters, all);
                    let mut s = shared().lock().unwrap_or_else(|p| p.into_inner());
                    if s.reports.get(&k) != Some(&rep) {
                        s.reports.insert(k, rep);
                        changed = true;
                    }
                }
            }
            if changed {
                crate::board_feed::feed().poke();
            }
            std::thread::sleep(Duration::from_secs(1));
        });
    });
}

/// Ask for a session's report: the last one the worker made, if any.
fn report_for(ctx: Context, all: bool) -> Option<Report> {
    worker();
    let mut s = shared().lock().unwrap_or_else(|p| p.into_inner());
    let k = ctx.session.clone();
    s.wanted.insert(k.clone(), (ctx, all, crew_core::history::now_ms()));
    s.reports.get(&k).cloned()
}

/// Per pane surface (upper-cased): its last prompt, and whether a turn
/// since left background work. From crew's history, read again only when
/// the newest history file changes.
fn turns() -> HashMap<String, (u64, bool)> {
    static CACHE: Mutex<Option<(Option<std::time::SystemTime>, HashMap<String, (u64, bool)>)>> = Mutex::new(None);
    let dir = crew_core::history::dir();
    let now = crew_core::history::now_ms();
    let stamp = std::fs::metadata(crew_core::history::file_for(&dir, now)).and_then(|m| m.modified()).ok();
    let mut c = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((s, m)) = c.as_ref() {
        if *s == stamp && stamp.is_some() {
            return m.clone();
        }
    }
    let mut m: HashMap<String, (u64, bool)> = HashMap::new();
    for e in crew_core::history::read_since(&dir, now.saturating_sub(HISTORY_MS)) {
        let k = e.surface.to_uppercase();
        let t = m.entry(k).or_insert((0, false));
        match e.detail.as_str() {
            "prompt" if e.at >= t.0 => *t = (e.at, false),
            "background" if e.at >= t.0 => t.1 = true,
            _ => {}
        }
    }
    *c = Some((stamp, m.clone()));
    m
}

/// "claude-haiku-5-5" → "haiku": the word a row has room for.
pub fn short_model(m: &str) -> String {
    let m = m.strip_prefix("claude-").unwrap_or(m);
    m.split(['-', '[', '@']).next().unwrap_or(m).to_string()
}

/// A run's card row: coarse fields only.
pub fn entry(run: &Run, surface: &str, session: &str) -> Value {
    let workflow = run.agents.len() != 1 || run.kind == "workflow";
    let phase = run.agents.iter().filter(|a| a.state == "running").filter_map(|a| a.phase.clone()).last()
        .or_else(|| run.agents.iter().filter_map(|a| a.phase.clone()).last());
    let one = run.agents.first().filter(|_| !workflow);
    let model = one.and_then(|a| a.model.as_deref()).map(short_model);
    let badge = one.and_then(|a| a.result.as_ref()).and_then(|r| r.badge.clone());
    let mut v = json!({
        "surface": surface, "session": session, "id": run.id, "kind": if workflow { "workflow" } else { "agent" },
        "label": run.name, "state": run.status, "start": run.start, "end": run.end,
    });
    if let Some(m) = model {
        v["model"] = json!(m);
    }
    if let Some(b) = badge {
        v["badge"] = json!(b);
    }
    if workflow {
        v["k"] = json!(run.totals.done + run.totals.failed);
        v["n"] = json!(run.totals.agents);
        if run.totals.failed > 0 {
            v["failed"] = json!(run.totals.failed);
        }
        if let Some(p) = phase {
            v["phase"] = json!(p);
        }
    }
    v
}

/// A background task no run covers yet: its row from the hooks alone.
pub fn pending(b: &Background, surface: &str, session: &str) -> Value {
    json!({"surface": surface, "session": session, "id": b.id, "kind": if b.kind == "workflow" { "workflow" } else { "agent" },
           "label": b.label, "state": "running", "start": b.at, "end": null, "task": true})
}

/// One pane's rows: its running tasks first, oldest first, then what
/// finished since its last prompt, newest first.
pub fn rows_for(p: &Pane, rep: Option<&Report>, since: u64) -> Vec<Value> {
    let runs: &[Run] = rep.map(|r| r.runs.as_slice()).unwrap_or(&[]);
    let mut live: Vec<Value> = Vec::new();
    for b in &p.background {
        match runs.iter().find(|r| r.task.as_deref() == Some(b.id.as_str()) || r.id == b.id) {
            Some(r) => live.push(entry(r, &p.surface, &p.session)),
            None => {
                // A workflow's run is often read before its task id is known.
                match runs.iter().find(|r| r.status == "running" && r.task.is_none() && r.name == b.label) {
                    Some(r) => live.push(entry(r, &p.surface, &p.session)),
                    None => live.push(pending(b, &p.surface, &p.session)),
                }
            }
        }
    }
    let shown = |v: &Value| v["id"].as_str().map(str::to_string);
    let have: Vec<String> = live.iter().filter_map(shown).collect();
    let mut done: Vec<Value> = runs.iter()
        .filter(|r| !have.contains(&r.id) && r.status != "running")
        .filter(|r| r.end.or(r.start).unwrap_or(0) >= since && since > 0)
        .map(|r| entry(r, &p.surface, &p.session)).collect();
    live.sort_by_key(|v| v["start"].as_u64().unwrap_or(0));
    done.sort_by_key(|v| std::cmp::Reverse(v["end"].as_u64().or(v["start"].as_u64()).unwrap_or(0)));
    live.extend(done);
    live
}

/// Each row's agents, agentsMore and agentNotices, from its panes' files.
/// `report` gives a pane's report (the worker's, outside tests).
pub fn mark_with(rows: &mut [Value], files: &[Pane], turns: &HashMap<String, (u64, bool)>,
                 report: &mut dyn FnMut(&Pane, bool) -> Option<Report>) {
    let now = crew_core::history::now_ms();
    for r in rows.iter_mut() {
        let surfaces: Vec<String> = r.get("panes").and_then(Value::as_array).into_iter().flatten()
            .filter_map(|p| p.get("surface").and_then(Value::as_str).map(str::to_uppercase)).collect();
        if surfaces.is_empty() {
            continue;
        }
        let mut all: Vec<Value> = Vec::new();
        let mut notices: Vec<Value> = Vec::new();
        for p in files.iter().filter(|f| surfaces.contains(&f.surface.to_uppercase()) && !f.session.is_empty()) {
            let (prompt, had) = turns.get(&p.surface.to_uppercase()).copied().unwrap_or((0, false));
            let busy = p.state == "working" && !p.background.is_empty();
            // A pane with nothing running asks for its finished runs only
            // when a turn since its last prompt left background work.
            if !busy && !had {
                continue;
            }
            let rep = report(p, !busy);
            let since = prompt.max(now.saturating_sub(HISTORY_MS));
            all.extend(rows_for(p, rep.as_ref(), since));
            for n in rep.iter().flat_map(|r| r.notices.iter()) {
                notices.push(json!({"surface": p.surface, "session": p.session, "kind": n.kind, "text": n.text(),
                                    "taskType": n.task_type, "adapter": n.adapter, "why": n.why, "count": n.count}));
            }
        }
        let Some(m) = r.as_object_mut() else { continue };
        if all.len() > ROWS_MAX {
            m.insert("agentsMore".into(), json!(all.len() - ROWS_MAX));
            all.truncate(ROWS_MAX);
        }
        if !all.is_empty() {
            m.insert("agents".into(), Value::Array(all));
        }
        if !notices.is_empty() {
            m.insert("agentNotices".into(), Value::Array(notices));
        }
    }
}

/// mark_with on the live board: crew's history and the worker's reports.
pub fn mark_agents(rows: &mut [Value], files: &[Pane]) {
    let t = turns();
    mark_with(rows, files, &t, &mut |p, all| {
        let ctx = crew_core::runs::context_for(&p.session, "").map(|mut c| {
            c.background = p.background.clone();
            c
        })?;
        report_for(ctx, all)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_core::runs::model::parse_doc;

    fn pane(surface: &str, bg: &[(&str, &str, &str)]) -> Pane {
        let mut p = Pane::new("W1", surface);
        p.session = "s1".into();
        p.state = if bg.is_empty() { "idle".into() } else { "working".into() };
        p.background = bg.iter().map(|(k, id, l)| Background { kind: k.to_string(), id: id.to_string(), label: l.to_string(), at: 100 }).collect();
        p
    }

    fn report(doc: Value) -> Report {
        Report { runs: parse_doc(&doc, "claude-workflow").unwrap(), notices: Vec::new() }
    }

    #[test]
    fn rows_come_from_the_hooks_first_and_gain_detail_from_the_report() {
        let p = pane("S1", &[("subagent", "a1", "Lookout review"), ("workflow", "w1", "review-changes")]);
        let bare = rows_for(&p, None, 0);
        assert_eq!(bare.iter().map(|v| (v["label"].as_str().unwrap(), v["state"].as_str().unwrap())).collect::<Vec<_>>(),
                   vec![("Lookout review", "running"), ("review-changes", "running")]);
        let rep = report(json!({"schema": "seamux.run/1", "runs": [
            {"id": "a1", "kind": "agent", "name": "Lookout review", "task": "a1", "status": "running", "start": 200,
             "agents": [{"id": "a1", "state": "running", "model": "claude-sonnet-5-5", "tokens": 999}]},
            {"id": "wf_1", "kind": "workflow", "name": "review-changes", "status": "running", "start": 150, "phases": ["Review", "Verify"],
             "agents": [{"id": "x", "state": "done", "phase": "Review"}, {"id": "y", "state": "running", "phase": "Verify"}, {"id": "z", "state": "queued"}]},
            {"id": "old", "kind": "agent", "name": "earlier", "status": "done", "start": 10, "end": 20, "agents": [{"id": "old", "state": "done"}]},
            {"id": "b2", "kind": "agent", "name": "judge", "status": "done", "start": 300, "end": 400,
             "agents": [{"id": "b2", "state": "done", "result": {"badge": "8"}}]}]}));
        let rows = rows_for(&p, Some(&rep), 250);
        let wf = &rows[0];
        assert_eq!((wf["id"].as_str(), wf["phase"].as_str(), wf["k"].as_u64(), wf["n"].as_u64()), (Some("wf_1"), Some("Verify"), Some(1), Some(3)),
                   "a workflow without its task id yet is matched by name; oldest running first");
        assert_eq!((rows[1]["model"].as_str(), rows[1].get("tokens")), (Some("sonnet"), None), "coarse fields only");
        assert_eq!((rows[2]["label"].as_str(), rows[2]["badge"].as_str()), (Some("judge"), Some("8")), "finished since the prompt stays");
        assert_eq!(rows.len(), 3, "a run that ended before the prompt is gone");
    }

    #[test]
    fn a_card_shows_four_rows_then_more_and_says_when_no_adapter_reads_the_work() {
        let bg: Vec<(String, String, String)> = (0..6).map(|i| ("subagent".to_string(), format!("a{i}"), format!("agent {i}"))).collect();
        let refs: Vec<(&str, &str, &str)> = bg.iter().map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str())).collect();
        let files = vec![pane("S1", &refs), pane("S2", &[("teammate", "t1", "helper")]), pane("S3", &[("subagent", "q", "elsewhere")])];
        let mut rows = vec![json!({"id": "W1", "panes": [{"surface": "s1"}, {"surface": "S2"}]})];
        let mut asked = Vec::new();
        mark_with(&mut rows, &files, &HashMap::new(), &mut |p, all| {
            asked.push((p.surface.clone(), all));
            (p.surface == "S2").then(|| Report { runs: vec![], notices: vec![host::Notice {
                kind: "missing".into(), adapter: None, task_type: Some("teammate".into()), count: 1, why: "no adapter".into() }] })
        });
        assert_eq!(asked, vec![("S1".to_string(), false), ("S2".to_string(), false)], "only this card's panes, and only busy ones");
        let r = &rows[0];
        assert_eq!(r["agents"].as_array().map(Vec::len), Some(ROWS_MAX));
        assert_eq!(r["agentsMore"], 3);
        assert_eq!(r["agentNotices"][0]["text"], "1 background task from teammate: no adapter");
        assert_eq!(r["agentNotices"][0]["surface"], "S2");
    }

    #[test]
    fn an_idle_pane_asks_for_its_finished_runs_only_after_a_turn_left_background_work() {
        let files = vec![pane("S1", &[]), pane("S2", &[])];
        let mut rows = vec![json!({"id": "W1", "panes": [{"surface": "S1"}, {"surface": "S2"}]})];
        let mut t = HashMap::new();
        t.insert("S2".to_string(), (crew_core::history::now_ms() - 5_000, true));
        let mut asked = Vec::new();
        mark_with(&mut rows, &files, &t, &mut |p, all| { asked.push((p.surface.clone(), all)); None });
        assert_eq!(asked, vec![("S2".to_string(), true)]);
        assert!(rows[0].get("agents").is_none());
    }

    #[test]
    fn models_are_shortened_to_their_family() {
        assert_eq!(short_model("claude-haiku-5-5"), "haiku");
        assert_eq!(short_model("claude-opus-5-5[1m]"), "opus");
        assert_eq!(short_model("gpt-5"), "gpt");
    }
}
