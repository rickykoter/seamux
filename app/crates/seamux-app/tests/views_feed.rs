//! The views feed against fixture files: decisions merged oldest first from
//! the crew hooks' question and asked files, deep-plan status rows and lookout
//! reviews; Wake rows mapped to live workspaces; the history window; and the
//! poll filling only the changes no hook reported.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crew_core::history::{self, Entry};
use seamux_app::views::{Decision, Feed, GapFill, Inputs, GAP_GRACE};
use seamux_app::wall::Tile;
use serde_json::json;

const WS_A: &str = "68A92708-B9BD-4D9D-9043-A55FD88A17AA";
const WS_B: &str = "11111111-2222-3333-4444-555555555555";
const WS_GONE: &str = "99999999-8888-7777-6666-555555555555";
const SURF_A: &str = "088AC8B3-C1B1-4EB9-9A88-1DA89CDBFF76";
const SURF_B: &str = "7C47DD0A-7A85-4389-A705-ACEF3DD0A71E";
const NOW: u64 = 1_792_627_200_000;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!("seamux-views-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for d in ["state", "reviews", "history", "work/a", "work/b"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        Fixture { root }
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }
    fn dir(&self, rel: &str) -> String {
        self.p(rel).to_string_lossy().into_owned()
    }
    fn write(&self, rel: &str, text: &str) {
        fs::write(self.p(rel), text).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn tile(surface: &str, ws: &str, cwd: &str, state: &str) -> Tile {
    Tile {
        surface: surface.into(),
        workspace: ws.into(),
        workspace_title: "t".into(),
        label: "l".into(),
        cwd: cwd.into(),
        agent: Some("claude".into()),
        state: state.into(),
        lines: Vec::new(),
        error: None,
        color: None,
        since: 0,
    }
}

fn row(id: i64, ws: &str, kind: &str, title: &str, created: &str) -> crew_store::Row {
    crew_store::Row {
        id,
        ws: ws.into(),
        repo: String::new(),
        kind: kind.into(),
        title: title.into(),
        locator: format!("loc{id}"),
        path: String::new(),
        url: String::new(),
        sha: String::new(),
        was_path: String::new(),
        created_at: created.into(),
        updated_at: String::new(),
        session_id: String::new(),
        branch: String::new(),
        prompt: String::new(),
        source: String::new(),
        kept_at: None,
    }
}

fn inputs(f: &Fixture, plans: serde_json::Value, wake: Vec<crew_store::Row>) -> Inputs {
    Inputs {
        state_dir: f.p("state"),
        reviews_dir: f.p("reviews"),
        history_dir: f.p("history"),
        plans: Box::new(move || Ok(plans.as_array().cloned().unwrap_or_default())),
        wake: Box::new(move |n| Ok(wake.iter().take(n).cloned().collect())),
    }
}

/// A feed whose slow sources (deep-plan status, the Wake log) have answered.
fn primed(i: Inputs) -> Feed {
    let f = Feed::new(i);
    f.prime(Duration::from_secs(5));
    f
}

fn set_mtime(p: &Path, ms: u64) {
    let t = std::time::UNIX_EPOCH + Duration::from_millis(ms);
    fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
}

#[test]
fn decisions_merge_oldest_first_from_every_source() {
    let f = Fixture::new("merge");
    let (a, b) = (f.dir("work/a"), f.dir("work/b"));
    let tiles = vec![tile(SURF_A, WS_A, &a, "needs_input"), tile(SURF_B, WS_B, &format!("{b}/sub"), "idle")];

    // An open AskUserQuestion in A (its marker too), and one left over
    // without a marker, and one in a workspace with no pane.
    f.write(&format!("state/question-{WS_A}"), "");
    f.write(
        &format!("state/question-{WS_A}.json"),
        &json!({"at": NOW - 9 * 60_000, "surface": SURF_A.to_lowercase(), "questions": [
            {"question": "How?", "header": "Checks", "multiSelect": false,
             "options": [{"label": "Re-enable", "description": "rec"}, {"label": "Now", "description": ""}]}]})
        .to_string(),
    );
    f.write(&format!("state/question-{WS_B}.json"), &json!({"at": 1, "questions": [{"question": "stale"}]}).to_string());
    f.write(&format!("state/question-{WS_GONE}"), "");
    f.write(&format!("state/question-{WS_GONE}.json"), &json!({"at": 1, "questions": [{"question": "gone"}]}).to_string());
    // A turn in B ended on a question, 4 minutes ago; payload and log files are not asks.
    f.write(&format!("state/asked-{WS_B}"), "Should I push and open the PR?\n");
    set_mtime(&f.p(&format!("state/asked-{WS_B}")), NOW - 4 * 60_000);
    f.write(&format!("state/asked-payload-{WS_B}"), "{}");
    f.write("state/asked.log", "x");

    // deep-plan: A's plan has an open increment with a manual check pending
    // (and a passed one); B's plan waits for go; a done plan and one with no
    // live worktree are not decisions.
    let plans = json!([
        {"slug": "inv", "root": a, "phase": "implementing", "touchedAt": NOW - 20 * 60_000,
         "owner": {"workspace": WS_A},
         "progress": {"total": 4, "done": 2, "open": [{"n": 3, "title": "Cutover"}], "next": {"n": 4, "title": "Probes"}},
         "increments": [{"n": 3, "checks": [
            {"id": "manual-live", "kind": "manual", "name": "live switch", "status": "pending"},
            {"id": "manual-ok", "kind": "manual", "name": "done", "status": "pass"},
            {"id": "test-x", "kind": "test", "name": "unit", "status": "pending"}]}]},
        {"slug": "ux", "root": b, "phase": "implementing", "touchedAt": NOW - 2 * 60_000, "owner": null,
         "progress": {"total": 3, "done": 1, "open": [], "next": {"n": 2, "title": "Desk"}}, "increments": []},
        {"slug": "old", "root": a, "phase": "done", "touchedAt": 5, "progress": {"open": [], "next": null}},
        {"slug": "far", "root": "/nowhere", "phase": "implementing", "touchedAt": 6,
         "progress": {"open": [], "next": {"n": 1, "title": "x"}}}
    ]);

    // lookout: a review in A with two addressed findings; one with none; lookout's side files.
    f.write(
        "reviews/inv-inc3.json",
        &json!({"id": "inv-inc3", "title": "inc 3", "updatedAt": "2026-10-21T19:19:35.194Z",
                "source": {"root": a, "plan": "inv", "inc": 3},
                "findings": [{"status": "addressed"}, {"status": "addressed"}, {"status": "open"}, {"status": "resolved"}]})
        .to_string(),
    );
    f.write("reviews/quiet.json", &json!({"id": "quiet", "source": {"root": a}, "findings": [{"status": "resolved"}]}).to_string());
    f.write("reviews/inv-inc3.incoming.json", "{}");
    f.write("reviews/inv-inc3.rows.json", "{}");

    let feed = primed(inputs(&f, plans, vec![]));
    let frame = feed.build(&tiles, NOW);
    assert!(frame.problems.is_empty(), "{:?}", frame.problems);
    let kinds: Vec<(&str, u64)> = frame
        .decisions
        .iter()
        .map(|d| match d {
            Decision::Question { .. } => ("question", d.since()),
            Decision::Asked { .. } => ("asked", d.since()),
            Decision::Gate { slug, .. } => (if slug == "inv" { "gate-inv" } else { "gate-ux" }, d.since()),
            Decision::Review { .. } => ("review", d.since()),
        })
        .collect();
    let names: Vec<&str> = kinds.iter().map(|k| k.0).collect();
    // The review's updatedAt (2026-10-21T19:19:35Z) is before every other since.
    assert_eq!(names, vec!["review", "gate-inv", "question", "asked", "gate-ux"]);
    assert!(kinds.windows(2).all(|w| w[0].1 <= w[1].1));

    for d in &frame.decisions {
        match d {
            Decision::Question { ws, surface, questions, .. } => {
                assert_eq!((ws.as_str(), surface.as_str()), (WS_A, SURF_A), "the live surface, as cmux spells it");
                assert_eq!(questions[0].options.len(), 2);
                assert_eq!(questions[0].options[0].label, "Re-enable");
            }
            Decision::Asked { ws, surface, question, since } => {
                assert_eq!((ws.as_str(), surface.as_str()), (WS_B, SURF_B));
                assert_eq!(question, "Should I push and open the PR?");
                assert_eq!(*since, NOW - 4 * 60_000);
            }
            Decision::Gate { slug, n, checks, ready, ws, .. } if slug == "inv" => {
                assert_eq!((ws.as_str(), *n, *ready), (WS_A, 3, false));
                assert_eq!(checks.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["manual-live"]);
            }
            Decision::Gate { ws, n, ready, checks, .. } => {
                // No owner: matched by the root holding B's pane's cwd.
                assert_eq!((ws.as_str(), *n, *ready, checks.len()), (WS_B, 2, true, 0));
            }
            Decision::Review { ws, addressed, open, plan, inc, .. } => {
                assert_eq!((ws.as_str(), *addressed, *open, plan.as_str(), *inc), (WS_A, 2, 1, "inv", 3));
            }
        }
    }
}

#[test]
fn an_increment_with_only_the_agents_checks_is_not_a_decision() {
    let f = Fixture::new("agent-checks");
    let a = f.dir("work/a");
    let plans = json!([{"slug": "p", "root": a, "phase": "implementing", "touchedAt": 1,
        "progress": {"open": [{"n": 1, "title": "x"}], "next": null},
        "increments": [{"n": 1, "checks": [{"id": "t", "kind": "test", "status": "pending"},
                                           {"id": "r", "kind": "review", "status": "pending"}]}]}]);
    let feed = primed(inputs(&f, plans, vec![]));
    assert!(feed.build(&[tile(SURF_A, WS_A, &a, "working")], NOW).decisions.is_empty());
}

#[test]
fn a_plan_status_failure_is_named_and_the_rest_still_shows() {
    let f = Fixture::new("plans-fail");
    let a = f.dir("work/a");
    f.write(&format!("state/asked-{WS_A}"), "Ready?");
    let mut inp = inputs(&f, json!([]), vec![]);
    inp.plans = Box::new(|| Err("deep-plan status did not run".into()));
    inp.wake = Box::new(|_| Err("no such table".into()));
    let frame = primed(inp).build(&[tile(SURF_A, WS_A, &a, "idle")], NOW);
    assert_eq!(frame.decisions.len(), 1);
    assert_eq!(frame.problems.len(), 2);
    assert!(frame.problems[1].contains("Wake"));
}

#[test]
fn wake_rows_find_their_live_workspace() {
    let f = Fixture::new("wake");
    let (a, b) = (f.dir("work/a"), f.dir("work/b"));
    let rows = vec![
        row(3, &format!("{a}/"), "commit", "fix it", "2026-10-21T15:40:00+00:00"),
        row(2, &b, "plan", "", "not a date"),
        row(1, "/elsewhere", "pr", "PR #57", "2026-10-21T15:00:00Z"),
    ];
    let feed = primed(inputs(&f, json!([]), rows));
    let frame = feed.build(&[tile(SURF_A, WS_A, &a, "idle")], NOW);
    assert_eq!(frame.wake.len(), 3);
    assert_eq!(frame.wake[0].ws.as_deref(), Some(WS_A), "a trailing slash still matches");
    assert_eq!(frame.wake[0].at, 1_792_597_200_000);
    assert_eq!(frame.wake[1].title, "loc2", "an untitled row shows its locator");
    assert_eq!(frame.wake[1].at, 0);
    assert_eq!(frame.wake[2].ws, None);
}

#[test]
fn the_frame_carries_the_history_window() {
    let f = Fixture::new("history");
    let h = f.p("history");
    let e = |at, state: &str| Entry { at, ws: WS_A.into(), surface: SURF_A.into(), state: state.into(), source: "hook".into(), detail: "x".into() };
    history::append(&h, &e(NOW - 3 * 3600_000, "working")).unwrap();
    history::append(&h, &e(NOW - 3600_000, "needs_input")).unwrap();
    history::append(&h, &e(NOW - 60_000, "working")).unwrap();
    let frame = primed(inputs(&f, json!([]), vec![])).build(&[], NOW);
    assert_eq!(frame.history.iter().map(|c| c.state.as_str()).collect::<Vec<_>>(), vec!["needs_input", "working"]);
}

#[test]
fn the_poll_records_only_what_no_hook_reported() {
    let f = Fixture::new("gaps");
    let h = f.p("history");
    let grace = GAP_GRACE.as_millis() as u64;
    let gaps = GapFill::default();
    let a = f.dir("work/a");
    let mut shell = tile(SURF_B, WS_B, &a, "shell");
    shell.agent = None;

    // First sight is no change; a shell never counts.
    gaps.observe(&[tile(SURF_A, WS_A, &a, "needs_input"), shell.clone()], NOW);
    assert_eq!(gaps.flush(&h, NOW + grace), 0);

    // The person replied in the pane (no hook): working, seen by the poll.
    gaps.observe(&[tile(SURF_A, WS_A, &a, "working"), shell.clone()], NOW + 1000);
    assert_eq!(gaps.flush(&h, NOW + 1000 + grace - 1), 0, "still within the grace");
    assert_eq!(gaps.flush(&h, NOW + 1000 + grace), 1);

    // An ask the hook reported a moment after cmux showed it: not doubled.
    gaps.observe(&[tile(SURF_A, WS_A, &a, "needs_input")], NOW + 60_000);
    let hook = Entry { at: NOW + 60_400, ws: WS_A.into(), surface: SURF_A.into(), state: "needs_input".into(), source: "hook".into(), detail: "ask".into() };
    history::append(&h, &hook).unwrap();
    assert_eq!(gaps.flush(&h, NOW + 60_000 + grace), 0);

    let lines = history::read_since(&h, 0);
    let poll: Vec<&Entry> = lines.iter().filter(|e| e.source == "poll").collect();
    assert_eq!(poll.len(), 1);
    assert_eq!((poll[0].state.as_str(), poll[0].at), ("working", NOW + 1000));
}

#[test]
fn a_hook_files_workspace_matches_in_any_case() {
    let f = Fixture::new("case");
    let a = f.dir("work/a");
    f.write(&format!("state/asked-{}", WS_A.to_lowercase()), "Go?");
    let frame = primed(inputs(&f, json!([]), vec![])).build(&[tile(SURF_A, WS_A, &a, "idle")], NOW);
    match frame.decisions.as_slice() {
        [Decision::Asked { ws, surface, .. }] => assert_eq!((ws.as_str(), surface.as_str()), (WS_A, SURF_A), "cmux's spelling"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn another_panes_hook_line_does_not_hide_this_panes_change() {
    let f = Fixture::new("two-panes");
    let h = f.p("history");
    let a = f.dir("work/a");
    let grace = GAP_GRACE.as_millis() as u64;
    let gaps = GapFill::default();
    let (pa, pb) = (tile(SURF_A, WS_A, &a, "working"), tile(SURF_B, WS_A, &a, "working"));
    gaps.observe(&[pa.clone(), pb.clone()], NOW);
    // Pane A's stop hook says idle; pane B goes idle too, seen only by the poll.
    let hook = Entry { at: NOW + 500, ws: WS_A.into(), surface: SURF_A.into(), state: "idle".into(), source: "hook".into(), detail: "stop".into() };
    history::append(&h, &hook).unwrap();
    let (mut a2, mut b2) = (pa, pb);
    a2.state = "idle".into();
    b2.state = "idle".into();
    gaps.observe(&[a2, b2], NOW + 1000);
    assert_eq!(gaps.flush(&h, NOW + 1000 + grace), 1, "only B's change is new");
    let poll: Vec<Entry> = history::read_since(&h, 0).into_iter().filter(|e| e.source == "poll").collect();
    assert_eq!(poll[0].surface, SURF_B);
}
