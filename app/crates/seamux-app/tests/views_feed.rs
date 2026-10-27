//! The views feed against fixture files: decisions merged oldest first from
//! the crew hooks' question and asked files, deep-plan status rows and lookout
//! reviews; Wake rows mapped to live workspaces; the history window; and the
//! poll filling only the changes no hook reported.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crew_core::history::{self, Entry};
use seamux_app::views::{spans_of, Decision, Feed, GapFill, Inputs, Span, GAP_GRACE};
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
        for d in ["state", "reviews", "history", "dp-state", "asks", "work/a", "work/b"] {
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
        running: None,
        bell: false,
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
        dp_state_dir: f.p("dp-state"),
        tuck_file: f.p("tucked.json"),
        asks_dir: f.p("asks"),
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
            Decision::Family { .. } => ("family", d.since()),
        })
        .collect();
    // Briefs for Mosaic: every live workspace's newest plan (done ones too)
    // and newest review, whether or not it waits on the person.
    let plans: Vec<(&str, &str, u64, bool)> = frame.plans.iter().map(|p| (p.ws.as_str(), p.slug.as_str(), p.n, p.open)).collect();
    assert_eq!(plans, vec![("11111111-2222-3333-4444-555555555555", "ux", 2, false), (WS_A, "inv", 3, true)]);
    assert_eq!(frame.reviews.len(), 1, "one per workspace");
    assert_eq!(frame.reviews[0].id, "quiet", "the newer one (its file time, now)");
    assert_eq!(frame.reviews[0].closed, 1);
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
            Decision::Family { .. } => panic!("no family in this fixture"),
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

fn at(at: u64, state: &str, source: &str) -> Entry {
    Entry { at, ws: WS_A.into(), surface: SURF_A.into(), state: state.into(), source: source.into(), detail: String::new() }
}

#[test]
fn spans_start_from_the_state_before_the_window_and_merge_repeats() {
    let m = 60_000;
    let start = NOW - 40 * m;
    let entries = vec![
        at(start - 10 * m, "working", "hook"),
        at(start + 5 * m, "needs_input", "hook"),
        at(start + 5 * m + 12_000, "needs_input", "poll"), // the poll saw the same ask
        at(start + 20 * m, "working", "hook"),
        at(start + 30 * m, "idle", "hook"),
    ];
    let span = |state: &str, a: u64, b: u64| Span { state: state.into(), start: a, end: b };
    assert_eq!(
        spans_of(&entries, start, NOW),
        vec![
            span("working", start, start + 5 * m),
            span("needs_input", start + 5 * m, start + 20 * m),
            span("working", start + 20 * m, start + 30 * m),
            span("idle", start + 30 * m, NOW),
        ]
    );
    // Nothing recorded: no spans. Everything before the window: one span of the last state.
    assert!(spans_of(&[], start, NOW).is_empty());
    assert_eq!(spans_of(&entries[..1], start, NOW), vec![span("working", start, NOW)]);
}

#[test]
fn lanes_carry_spans_increment_marks_and_reviews() {
    let f = Fixture::new("lanes");
    let a = f.dir("work/a");
    let m = 60_000;
    history::append(&f.p("history"), &at(NOW - 3 * 3600_000, "working", "hook")).unwrap();
    history::append(&f.p("history"), &at(NOW - 30 * m, "needs_input", "hook")).unwrap();
    f.write(
        "dp-state/inv.json",
        &json!({"increments": [
            {"n": 2, "title": "Old", "authorizedAt": NOW - 5 * 3600_000, "doneAt": NOW - 4 * 3600_000},
            {"n": 3, "title": "Cutover", "authorizedAt": NOW - 50 * m}]}).to_string(),
    );
    f.write(
        "reviews/inv-inc3.json",
        &json!({"id": "inv-inc3", "title": "inc 3", "updatedAt": "2026-10-21T19:19:35.194Z", "source": {"root": a, "inc": 3}, "findings": []}).to_string(),
    );
    let plans = json!([{"slug": "inv", "root": a, "phase": "implementing", "touchedAt": 1, "owner": {"workspace": WS_A},
        "progress": {"open": [{"n": 3, "title": "Cutover"}]}, "increments": []}]);
    let mut shell = tile(SURF_B, WS_B, &a, "shell");
    shell.agent = None;
    let frame = primed(inputs(&f, plans, vec![])).build(&[tile(SURF_A, WS_A, &a, "needs_input"), shell], NOW);
    assert_eq!(frame.lanes.len(), 1, "a shell gets no lane");
    let lane = &frame.lanes[0];
    let states: Vec<&str> = lane.spans.iter().map(|s| s.state.as_str()).collect();
    assert_eq!(states, vec!["working", "needs_input"]);
    assert_eq!(lane.spans[0].start, NOW - 2 * 3600_000, "clipped to the window");
    let kinds: Vec<(&str, u64)> = lane.marks.iter().map(|k| (k.kind.as_str(), k.n)).collect();
    // Increment 2 went and finished before the window; the review's updatedAt
    // (2026-10-21T19:19Z) is outside it too. Only increment 3's go is in.
    assert_eq!(kinds, vec![("go", 3)]);

    // An agent with no history in the window still gets a lane span: the
    // wall's state from when it first saw it.
    let mut b = tile(SURF_B, WS_B, &f.dir("work/b"), "needs_input");
    b.since = NOW - 10 * m;
    let frame = primed(inputs(&f, json!([]), vec![])).build(&[b], NOW);
    assert_eq!(frame.lanes[0].spans, vec![Span { state: "needs_input".into(), start: NOW - 10 * m, end: NOW }]);
}

#[test]
fn tuck_two_workspaces_in_one_worktree_go_together_and_a_tucked_ask_marks_waiting() {
    use seamux_app::tuck::{Level, Store};
    let f = Fixture::new("tuck-two");
    let a = f.dir("work/a");
    // A real worktree: a pane in a subdirectory shares its root.
    fs::create_dir_all(f.p("work/a/sub")).unwrap();
    let git = std::process::Command::new("git").args(["init", "-q"]).current_dir(f.p("work/a")).status();
    if !git.map(|s| s.success()).unwrap_or(false) {
        return; // no git on this machine: nothing to group by
    }
    let store = Store { file: f.p("tucked.json") };
    let root = seamux_app::tuck::root_of(&a);
    store.set(&root, Some(Level::Tuck), "a", NOW - 60_000).unwrap();
    f.write(&format!("state/asked-{WS_B}"), "Ship it?");
    let tiles = [tile(SURF_A, WS_A, &a, "idle"), tile(SURF_B, WS_B, &format!("{a}/sub"), "needs_input")];
    let frame = primed(inputs(&f, json!([]), vec![])).build(&tiles, NOW);
    assert_eq!(frame.levels.get(WS_A).map(String::as_str), Some("tuck"));
    assert_eq!(frame.levels.get(WS_B).map(String::as_str), Some("tuck"), "same worktree, same tuck");
    assert_eq!(frame.tucked.len(), 1);
    let row = &frame.tucked[0];
    assert_eq!((row.path.as_str(), row.level, row.waiting), (root.as_str(), Level::Tuck, true));
    assert_eq!(row.workspaces.len(), 2);
    // A tuck holds through an ask.
    assert_eq!(store.load().len(), 1);
}

#[test]
fn tuck_a_newer_ask_clears_a_mute_and_an_older_one_does_not() {
    use seamux_app::tuck::{Level, Store};
    let f = Fixture::new("tuck-mute");
    let a = f.dir("work/a");
    let store = Store { file: f.p("tucked.json") };
    let root = seamux_app::tuck::root_of(&a);
    let asked = f.p(&format!("state/asked-{WS_A}"));
    f.write(&format!("state/asked-{WS_A}"), "Ready?");
    set_mtime(&asked, NOW - 10 * 60_000);
    let tiles = [tile(SURF_A, WS_A, &a, "needs_input")];

    // Muted after the ask was raised: the old ask does not undo the mute.
    store.set(&root, Some(Level::Mute), "a", NOW - 5 * 60_000).unwrap();
    let frame = primed(inputs(&f, json!([]), vec![])).build(&tiles, NOW);
    assert_eq!(frame.levels.get(WS_A).map(String::as_str), Some("mute"));
    assert_eq!(store.load().len(), 1);

    // A new ask after the mute: unmuted, and saved so.
    set_mtime(&asked, NOW - 60_000);
    let frame = primed(inputs(&f, json!([]), vec![])).build(&tiles, NOW);
    assert!(frame.levels.is_empty());
    assert!(frame.tucked.is_empty());
    assert!(store.load().is_empty());
}

fn family_rows(a: &str, b: &str) -> serde_json::Value {
    let fam = |role: &str, waits: serde_json::Value| json!({"role": role, "parent": "auth", "waitingOn": waits, "members": []});
    json!([
        {"slug": "auth", "root": "/nowhere/auth", "phase": "implementing", "touchedAt": 10, "family": fam("parent", json!([])),
         "progress": {"total": 3, "done": 1, "open": [{"n": 2, "title": "Contract"}], "next": null}, "increments": []},
        {"slug": "auth-api", "root": a, "phase": "implementing", "touchedAt": 20, "owner": {"workspace": WS_A}, "family": fam("child", json!([])),
         "progress": {"total": 2, "done": 0, "open": [], "next": {"n": 1, "title": "Endpoints"}}, "increments": []},
        {"slug": "auth-ui", "root": b, "phase": "implementing", "touchedAt": 30, "family": fam("child", json!([{"n": 2, "title": "Contract", "status": "working"}])),
         "progress": {"total": 2, "done": 0, "open": [], "next": {"n": 1, "title": "Screens"}}, "increments": []},
        {"slug": "solo", "root": "/nowhere/solo", "phase": "implementing", "touchedAt": 5, "progress": {"open": [], "next": {"n": 1, "title": "x"}}, "increments": []}
    ])
}

#[test]
fn family_briefs_place_members_and_say_what_each_waits_on() {
    let f = Fixture::new("family");
    let (a, b) = (f.dir("work/a"), f.dir("work/b"));
    let tiles = [tile(SURF_A, WS_A, &a, "idle"), tile(SURF_B, WS_B, &b, "idle")];
    let frame = primed(inputs(&f, family_rows(&a, &b), vec![])).build(&tiles, NOW);
    assert_eq!(frame.families.len(), 1, "a plan with no family is not one");
    let fam = &frame.families[0];
    assert_eq!(fam.parent, "auth");
    assert_eq!(fam.members.iter().map(|m| m.slug.as_str()).collect::<Vec<_>>(), vec!["auth", "auth-api", "auth-ui"], "parent first");
    let api = &fam.members[1];
    assert_eq!((api.ws.as_deref(), api.ready, api.waits.len()), (Some(WS_A), true, 0));
    let ui = &fam.members[2];
    assert_eq!((ui.ws.as_deref(), ui.ready, ui.waits.clone()), (Some(WS_B), false, vec![2]), "waits on the parent's increment 2");
    assert_eq!(fam.members[0].ws, None, "the parent has no live pane here");
    assert_eq!((fam.done, fam.total), (0, 3));
}

#[test]
fn family_next_step_is_one_decision_and_members_lose_their_ready_gates() {
    let f = Fixture::new("family-step");
    let (a, b) = (f.dir("work/a"), f.dir("work/b"));
    let tiles = [tile(SURF_A, WS_A, &a, "idle"), tile(SURF_B, WS_B, &b, "idle")];
    let frame = primed(inputs(&f, family_rows(&a, &b), vec![])).build(&tiles, NOW);
    let fams: Vec<&Decision> = frame.decisions.iter().filter(|d| matches!(d, Decision::Family { .. })).collect();
    assert_eq!(fams.len(), 1);
    match fams[0] {
        Decision::Family { parent, members, since, ws, .. } => {
            assert_eq!(parent, "auth");
            assert_eq!(members.iter().filter(|m| m.ready).count(), 1);
            assert_eq!(*since, 30, "the family's newest change");
            assert_eq!(ws, WS_A, "no live parent: the first live member's workspace");
        }
        _ => unreachable!(),
    }
    // auth-api's ready go is on the family card, not a gate of its own.
    assert!(!frame.decisions.iter().any(|d| matches!(d, Decision::Gate { slug, .. } if slug == "auth-api")));
}

#[test]
fn family_with_nothing_ready_is_no_decision() {
    let f = Fixture::new("family-wait");
    let (a, b) = (f.dir("work/a"), f.dir("work/b"));
    let tiles = [tile(SURF_A, WS_A, &a, "working"), tile(SURF_B, WS_B, &b, "idle")];
    let mut rows = family_rows(&a, &b);
    // auth-api is mid increment and auth-ui waits on the parent: nothing to go.
    rows[1]["progress"] = json!({"total": 2, "done": 0, "open": [{"n": 1, "title": "Endpoints"}], "next": null});
    let frame = primed(inputs(&f, rows, vec![])).build(&tiles, NOW);
    assert_eq!(frame.families.len(), 1, "the family is still drawn in the views");
    assert!(!frame.decisions.iter().any(|d| matches!(d, Decision::Family { .. })), "but no card waits on the person");
}

#[test]
fn family_members_carry_the_go_owner_holds_and_verdicts_from_status() {
    let f = Fixture::new("family-owner");
    let (a, b) = (f.dir("work/a"), f.dir("work/b"));
    let tiles = [tile(SURF_A, WS_A, &a, "idle"), tile(SURF_B, WS_B, &b, "idle")];
    let mut rows = family_rows(&a, &b);
    let members = json!([
        {"slug": "auth", "role": "parent", "go": "human", "held": "", "increments": []},
        {"slug": "auth-api", "role": "child", "go": "parent", "held": "wait for the schema", "increments": [
            {"n": 1, "title": "Endpoints", "status": "done", "checks": "pass", "review": "fail", "by": "parent"},
            {"n": 2, "title": "Docs", "status": "pending", "checks": "pending", "review": "", "by": ""}]}]);
    for r in rows.as_array_mut().unwrap().iter_mut().take(3) {
        r["family"]["members"] = members.clone();
        r["family"]["holds"] = json!({"auth-api": "wait for the schema"});
    }
    rows[1]["family"]["go"] = json!("parent");
    // auth-ui's gate, as the engine reports it, is open: not ready either way.
    rows[2]["gate"] = json!({"allow": true, "why": ""});
    let frame = primed(inputs(&f, rows, vec![])).build(&tiles, NOW);
    let fam = &frame.families[0];
    let api = fam.members.iter().find(|m| m.slug == "auth-api").unwrap();
    assert_eq!((api.go.as_str(), api.held.as_str(), api.ready), ("parent", "wait for the schema", true));
    assert_eq!(api.increments.iter().map(|i| (i.n, i.checks.as_str(), i.review.as_str(), i.by.as_str())).collect::<Vec<_>>(),
        vec![(1, "pass", "fail", "parent"), (2, "pending", "", "")]);
    let parent = fam.members.iter().find(|m| m.slug == "auth").unwrap();
    assert_eq!((parent.go.as_str(), parent.held.as_str()), ("human", ""));
    let ui = fam.members.iter().find(|m| m.slug == "auth-ui").unwrap();
    assert!(!ui.ready && ui.increments.is_empty(), "a member missing from the family list has no verdicts");
}

#[test]
fn plan_owner_working_in_its_root_keeps_the_plan() {
    let f = Fixture::new("plan-owner");
    let a = f.dir("work/a");
    // Two workspaces in the plan's root; the owner, WS_B, is the second.
    let tiles = [tile(SURF_A, WS_A, &a, "idle"), tile(SURF_B, WS_B, &a, "idle")];
    let mut rows = family_rows(&a, &a);
    rows[1]["owner"] = json!({"workspace": WS_B});
    let frame = primed(inputs(&f, rows, vec![])).build(&tiles, NOW);
    let api = frame.families[0].members.iter().find(|m| m.slug == "auth-api").unwrap();
    assert_eq!(api.ws.as_deref(), Some(WS_B), "the owner's workspace, not the first pane in the root");
}

#[test]
fn pages_list_a_workspaces_plan_open_reviews_and_unanswered_asks() {
    let f = Fixture::new("pages");
    let (a, b) = (f.dir("work/a"), f.dir("work/b"));
    let tiles = [tile(SURF_A, WS_A, &a, "needs_input"), tile(SURF_B, WS_B, &b, "idle")];
    let plans = json!([
        {"slug": "inv", "root": a, "phase": "implementing", "touchedAt": 20,
         "progress": {"total": 5, "done": 1, "open": [{"n": 2, "title": "x"}], "next": null}, "increments": []},
        {"slug": "ux", "root": b, "phase": "review", "touchedAt": 30, "progress": {"total": 3, "done": 0, "open": [], "next": null}, "increments": []}
    ]);
    f.write("reviews/inv-inc1.json", &json!({"id": "inv-inc1", "updatedAt": "2026-10-21T10:00:00.000Z",
        "source": {"root": a, "plan": "inv", "inc": 1}, "findings": [{"status": "open"}]}).to_string());
    f.write("reviews/inv-inc2.json", &json!({"id": "inv-inc2", "updatedAt": "2026-10-21T11:00:00.000Z",
        "source": {"root": a, "plan": "inv", "inc": 2}, "findings": [{"status": "addressed"}]}).to_string());
    f.write("reviews/closed.json", &json!({"id": "closed", "source": {"root": a}, "findings": [{"status": "resolved"}]}).to_string());
    let ask = |id: &str, surface: &str, answer: serde_json::Value| {
        f.write(&format!("asks/{id}.json"), &json!({"id": id, "header": "Pick", "workspace": WS_A, "surface": surface, "answer": answer}).to_string());
        f.write(&format!("asks/{id}.html"), "<p>");
    };
    ask("open1", SURF_A, serde_json::Value::Null);
    ask("answered", SURF_A, json!({"n": 1}));
    ask("gone", "00000000-0000-0000-0000-000000000000", serde_json::Value::Null);

    let frame = primed(inputs(&f, plans, vec![])).build(&tiles, NOW);
    let of = |ws: &str| frame.pages.iter().filter(|p| p.ws == ws).map(|p| (p.kind.as_str(), p.path.as_str(), p.state.as_str(), p.waiting)).collect::<Vec<_>>();
    assert_eq!(of(WS_A), vec![
        ("plan", "/plan/inv", "working inc 2/5", false),
        ("review", "/review/inv-inc2", "1 to close", true),
        ("review", "/review/inv-inc1", "1 open", false),
        ("ask", "/ask/open1", "waiting", true),
    ], "plan, then reviews newest first (a closed one left out), then the live unanswered ask");
    assert_eq!(of(WS_B), vec![("plan", "/plan/ux.review.html", "in review", true)], "a plan in review opens its review surface");
}
