//! The run model, the adapter host and the two Claude Code adapters, on
//! trimmed real files (tests/fixtures/runs, from Claude Code 2.1.319).

use std::fs;
use std::path::{Path, PathBuf};

use crew_core::runs::host::{self, Adapter, Context};
use crew_core::runs::model::{badge_of, parse_doc};
use crew_core::status::Background;
use serde_json::json;

fn fixture(session: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runs/projects/-w-repo").join(session)
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("crew-runs-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn ctx(session: &str, background: Vec<Background>) -> Context {
    Context { session: session.into(), session_dir: fixture(session), cwd: "/w/repo".into(), background, ..Default::default() }
}

fn task(kind: &str, id: &str, label: &str) -> Background {
    Background { kind: kind.into(), id: id.into(), label: label.into(), at: 1, ..Default::default() }
}

/// A command adapter in its own folder: `sh run.sh` with this body.
fn command_adapter(root: &Path, name: &str, recognizes: &[&str], timeout_ms: u64, body: &str) -> PathBuf {
    let d = root.join(name);
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("adapter.json"), json!({"schema": "seamux.adapter/1", "name": name, "recognizes": recognizes,
        "command": ["sh", "run.sh"], "timeoutMs": timeout_ms}).to_string()).unwrap();
    fs::write(d.join("run.sh"), body).unwrap();
    d
}

#[test]
fn the_fixtures_parse_into_runs() {
    let rep = host::report(&ctx("s-done", vec![]), &crew_core::runs::builtins(), true);
    assert!(rep.notices.is_empty(), "{:?}", rep.notices);
    assert_eq!(rep.runs.len(), 2, "the background agent and the workflow; the foreground agent is not a run");

    let wf = rep.runs.iter().find(|r| r.kind == "workflow").unwrap();
    assert_eq!((wf.name.as_str(), wf.source.as_str(), wf.status.as_str()), ("spike-wf", "claude-workflow", "done"));
    assert_eq!(wf.task.as_deref(), Some("w1yenxe1b"), "the run file ties it to the background task");
    assert_eq!(wf.phases, vec!["Say".to_string()]);
    assert_eq!(wf.end.zip(wf.start).map(|(e, s)| e - s), Some(3056));
    assert_eq!((wf.totals.agents, wf.totals.done, wf.totals.tokens), (2, 2, Some(21558)));
    let labels: Vec<(&str, Option<&str>, Option<&str>)> = wf.agents.iter()
        .map(|a| (a.label.as_str(), a.phase.as_deref(), a.result.as_ref().and_then(|r| r.badge.as_deref()))).collect();
    assert_eq!(labels, vec![("judge 0", Some("Say"), Some("7")), ("judge 1", Some("Say"), Some("8"))], "a returned score is the badge");
    assert!(wf.agents.iter().all(|a| a.transcript.as_deref().is_some_and(|t| t.ends_with(&format!("agent-{}.jsonl", a.id)))));

    let sub = rep.runs.iter().find(|r| r.kind == "agent").unwrap();
    assert_eq!((sub.name.as_str(), sub.status.as_str(), sub.task.as_deref()), ("spike sleeper", "done", Some("afbf7fe6ed7060d9e")));
    let a = &sub.agents[0];
    assert_eq!((a.state.as_str(), a.model.as_deref()), ("done", Some("claude-haiku-5-5")));
    assert_eq!(a.result.as_ref().map(|r| (r.badge.clone(), r.detail.clone())), Some((None, Some("done".into()))), "no badge field, no badge");
    assert!(a.tokens.is_some_and(|t| t > 0) && a.start < a.end);
}

#[test]
fn a_live_workflow_is_read_from_its_script_journal_and_agents() {
    let rep = host::report(&ctx("s-live", vec![task("workflow", "w9", "spike-wf")]), &crew_core::runs::builtins(), false);
    assert!(rep.notices.is_empty(), "{:?}", rep.notices);
    let [wf] = rep.runs.as_slice() else { panic!("{:?}", rep.runs) };
    assert_eq!((wf.name.as_str(), wf.status.as_str(), wf.task.as_deref()), ("spike-wf", "running", Some("w9")));
    assert_eq!(wf.phases, vec!["Say".to_string()], "the script's meta gives the phases");
    let states: Vec<(&str, &str)> = wf.agents.iter().map(|a| (a.label.as_str(), a.state.as_str())).collect();
    assert_eq!(states, vec![("judge 0", "done"), ("judge 1", "running")]);
    assert_eq!(wf.agents[0].result.as_ref().and_then(|r| r.badge.as_deref()), Some("7"));
    assert!(wf.agents[1].end.is_none() && wf.agents[1].start.is_some());
}

#[test]
fn the_board_runs_only_the_adapters_its_background_tasks_need() {
    let rep = host::report(&ctx("s-done", vec![task("subagent", "afbf7fe6ed7060d9e", "spike sleeper")]), &crew_core::runs::builtins(), false);
    assert_eq!(rep.runs.iter().map(|r| r.source.as_str()).collect::<Vec<_>>(), vec!["claude-subagents"]);
}

#[test]
fn unknown_types_give_a_notice() {
    let bg = vec![task("teammate", "t1", "helper"), task("teammate", "t2", "helper"), task("subagent", "x", "y")];
    let rep = host::report(&ctx("s-done", bg), &crew_core::runs::builtins(), false);
    let [n] = rep.notices.as_slice() else { panic!("{:?}", rep.notices) };
    assert_eq!((n.kind.as_str(), n.task_type.as_deref(), n.count), ("missing", Some("teammate"), 2));
    assert_eq!(n.text(), "2 background tasks from teammate: no adapter");
}

#[test]
fn a_command_adapter_is_run_validated_and_cached() {
    let root = tmp("cmd");
    let count = root.join("count");
    let body = format!(
        "cat > \"{0}/stdin.json\"\necho x >> \"{1}\"\nprintf '%s' '{{\"schema\":\"seamux.run/1\",\"runs\":[{{\"id\":\"r1\",\"name\":\"mine\",\"status\":\"running\",\"cap\":4,\"agents\":[{{\"id\":\"a\",\"state\":\"running\",\"result\":{{\"badge\":\"far-too-long\"}}}}]}}]}}'\n",
        root.display(), count.display());
    command_adapter(&root, "teams", &["teammate"], 2_000, &body);
    let (adapters, bad) = host::load(&root);
    assert!(bad.is_empty(), "{bad:?}");
    let c = Context { session_dir: tmp("cmd-session"), session: "s".into(), background: vec![task("teammate", "t1", "helper")], ..Default::default() };
    let rep = host::report(&c, &adapters, false);
    assert!(rep.notices.is_empty(), "{:?}", rep.notices);
    let [r] = rep.runs.as_slice() else { panic!("{:?}", rep.runs) };
    assert_eq!((r.name.as_str(), r.source.as_str(), r.cap), ("mine", "teams", Some(4)));
    assert_eq!(r.agents[0].result.as_ref().and_then(|x| x.badge.as_deref()), Some("far-too…"), "a badge is a few characters");
    let sent: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join("stdin.json")).unwrap()).unwrap();
    assert_eq!((sent["schema"].as_str(), sent["session"].as_str(), sent["background"][0]["kind"].as_str()),
               (Some("seamux.context/1"), Some("s"), Some("teammate")), "the context arrives on stdin");
    // Nothing changed: the second ask is the cache's. A new file in the
    // session's folder runs it again.
    host::report(&c, &adapters, false);
    assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 1);
    // Past the freshness window, a new file in the session's folder runs it.
    std::thread::sleep(std::time::Duration::from_millis(host::FRESH_MS as u64 + 50));
    fs::write(c.session_dir.join("new"), "x").unwrap();
    host::report(&c, &adapters, false);
    assert_eq!(fs::read_to_string(&count).unwrap().lines().count(), 2);
}

#[test]
fn a_broken_adapter_and_a_timeout_are_reported() {
    let root = tmp("broken");
    command_adapter(&root, "crashes", &["teammate"], 2_000, "echo 'no module named thing' >&2\nexit 3\n");
    command_adapter(&root, "hangs", &["teammate"], 300, "sleep 4.5 &\necho $! > sleeper.pid\nwait\n");
    command_adapter(&root, "babbles", &["teammate"], 2_000, "echo not json\n");
    command_adapter(&root, "wrong", &["teammate"], 2_000, "echo '{\"schema\":\"seamux.run/1\",\"runs\":[{\"id\":\"r\",\"status\":\"sleeping\"}]}'\n");
    fs::create_dir_all(root.join("halfmade")).unwrap();
    fs::write(root.join("halfmade/adapter.json"), "{\"schema\": \"seamux.adapter/1\", \"name\": \"halfmade\"}").unwrap();
    let (adapters, bad) = host::load(&root);
    assert_eq!(bad.iter().map(|n| (n.adapter.as_deref(), n.why.as_str())).collect::<Vec<_>>(),
               vec![(Some("halfmade"), "adapter.json: command must be a non-empty list")]);
    let c = Context { session_dir: tmp("broken-session"), session: "s".into(), background: vec![task("teammate", "t1", "x")], ..Default::default() };
    let started = std::time::Instant::now();
    let rep = host::report(&c, &adapters, false);
    assert!(started.elapsed() < std::time::Duration::from_secs(3), "the hang is cut off at its timeout");
    let why = |name: &str| rep.notices.iter().find(|n| n.adapter.as_deref() == Some(name)).map(|n| n.text()).unwrap_or_default();
    assert_eq!(why("crashes"), "adapter crashes failed: exited with 3: no module named thing");
    assert_eq!(why("hangs"), "adapter hangs failed: timed out after 300 ms");
    let pid = fs::read_to_string(root.join("hangs/sleeper.pid")).unwrap().trim().to_string();
    let alive = || std::process::Command::new("kill").args(["-0", &pid]).output().unwrap().status.success();
    let gone = (0..20).any(|_| { std::thread::sleep(std::time::Duration::from_millis(50)); !alive() });
    assert!(gone, "the timeout ended what the adapter started");
    assert!(why("babbles").starts_with("adapter babbles failed: printed no JSON document"), "{}", why("babbles"));
    assert_eq!(why("wrong"), "adapter wrong failed: runs[0].status: \"sleeping\" is not one of running, done, failed, cancelled, unknown");
    assert!(rep.runs.is_empty());
}

#[test]
fn a_leftover_child_or_a_flood_of_output_cannot_hang_the_host() {
    let root = tmp("flood");
    // Exits at once, leaving a sleeper that holds its stdout open.
    command_adapter(&root, "leaves", &["teammate"], 500, "sleep 5 &
echo '{\"schema\":\"seamux.run/1\",\"runs\":[]}'
");
    // Prints more than the host keeps, then exits.
    command_adapter(&root, "floods", &["teammate"], 5_000, "head -c 6000000 /dev/zero | tr '\\0' x
");
    let (adapters, _) = host::load(&root);
    let c = Context { session_dir: tmp("flood-session"), session: "s".into(), background: vec![task("teammate", "t1", "x")], ..Default::default() };
    let started = std::time::Instant::now();
    let rep = host::report(&c, &adapters, false);
    assert!(started.elapsed() < std::time::Duration::from_secs(4), "{:?}", started.elapsed());
    let why = |name: &str| rep.notices.iter().find(|n| n.adapter.as_deref() == Some(name)).map(|n| n.why.clone()).unwrap_or_default();
    assert_eq!(why("leaves"), "exited, but something it started kept its output open");
    assert_eq!(why("floods"), format!("printed more than {} bytes", host::OUTPUT_MAX));
}

#[test]
fn adapter_names_are_unique_and_session_ids_are_plain() {
    let root = tmp("names");
    command_adapter(&root, "a-first", &["teammate"], 500, "true
");
    let d = command_adapter(&root, "b-second", &["teammate"], 500, "true
");
    fs::write(d.join("adapter.json"), json!({"schema": "seamux.adapter/1", "name": "a-first", "recognizes": ["teammate"], "command": ["true"]}).to_string()).unwrap();
    command_adapter(&root, "claude-workflow", &["workflow"], 500, "true
");
    let (adapters, bad) = host::load(&root);
    assert_eq!(adapters.iter().map(|a| a.name().to_string()).collect::<Vec<_>>(), vec!["a-first"]);
    assert_eq!(bad.len(), 2, "a second a-first and a claude-workflow beside the built-in: {bad:?}");
    for id in [".", "..", "a/b", "", "x y"] {
        assert_eq!(crew_core::runs::session_dir(id), None, "{id:?}");
    }
}

#[test]
fn the_model_refuses_what_it_cannot_read_and_fills_the_rest() {
    assert_eq!(parse_doc(&json!({"runs": []}), "x"), Err("schema: missing, expected \"seamux.run/1\"".into()));
    assert_eq!(parse_doc(&json!({"schema": "seamux.run/2", "runs": []}), "x"), Err("schema: \"seamux.run/2\", expected \"seamux.run/1\"".into()));
    assert_eq!(parse_doc(&json!({"schema": "seamux.run/1", "runs": [{"id": "r", "status": "done", "agents": [{"id": "a", "state": "done", "transcript": "rel/path.jsonl"}]}]}), "x"),
               Err("runs[0].agents[0].transcript: \"rel/path.jsonl\" is not an absolute path".into()));
    let runs = parse_doc(&json!({"schema": "seamux.run/1", "runs": [{"id": "r", "status": "done", "agents": [
        {"id": "a", "state": "done", "tokens": 5}, {"id": "b", "state": "failed", "tokens": 7}]}]}), "x").unwrap();
    let r = &runs[0];
    assert_eq!((r.name.as_str(), r.kind.as_str(), r.agents[0].label.as_str()), ("r", "workflow", "a"), "names default to ids");
    assert_eq!((r.totals.agents, r.totals.done, r.totals.failed, r.totals.tokens), (2, 1, 1, Some(12)));
}

#[test]
fn the_badge_convention_reads_badge_score_or_verdict() {
    assert_eq!(badge_of(&json!({"score": 9.5})), Some("9.5".into()));
    assert_eq!(badge_of(&json!({"verdict": "pass", "score": 3})), Some("3".into()), "score is read before verdict");
    assert_eq!(badge_of(&json!("```json\n{\"badge\": \"A+\"}\n```")), Some("A+".into()));
    assert_eq!(badge_of(&json!("Looks fine to me.")), None);
    assert_eq!(badge_of(&json!({"findings": []})), None);
}

#[test]
fn the_builtins_are_adapters_like_any_other() {
    let names: Vec<String> = crew_core::runs::builtins().iter().map(|a| a.name().to_string()).collect();
    assert_eq!(names, vec!["claude-subagents", "claude-workflow"]);
    assert!(matches!(&crew_core::runs::builtins()[1], Adapter::Builtin { recognizes, .. } if recognizes == &["workflow"]));
}

#[test]
fn the_template_adapters_output_validates() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crew/adapters");
    let (all, bad) = host::load(&dir);
    assert!(bad.is_empty(), "{bad:?}");
    let adapters: Vec<Adapter> = all.into_iter().filter(|a| a.name() == "template").collect();
    assert_eq!(adapters.len(), 1);
    let c = Context { session_dir: fixture("s-done"), session: "s-done".into(), background: vec![task("teammate", "t1", "helper")], ..Default::default() };
    let rep = host::report(&c, &adapters, false);
    assert!(rep.notices.is_empty(), "{:?}", rep.notices);
    let [r] = rep.runs.as_slice() else { panic!("{:?}", rep.runs) };
    assert_eq!((r.name.as_str(), r.source.as_str(), r.task.as_deref(), r.agents[0].state.as_str()),
               ("helper", "template", Some("t1"), "running"));
}

#[test]
fn the_drafted_prompt_carries_the_sample() {
    let c = Context { session_dir: fixture("s-done"), session: "s-done".into(),
                      background: vec![task("teammate", "t1", "helper"), task("subagent", "a9", "other")], ..Default::default() };
    let missing = host::Notice { kind: "missing".into(), adapter: None, task_type: Some("teammate".into()), count: 1, why: "no adapter".into() };
    let p = crew_core::runs::draft::prompt(&c, &missing, Path::new("/crew/adapters/template"));
    assert!(p.contains("background work of type `teammate` that no seamux adapter reads"), "{p}");
    assert!(p.contains("docs/adapters.md") && p.contains("docs/RUNS.md") && p.contains("/crew/adapters/template"));
    assert!(p.contains("~/.config/seamux/adapters/teammate/") && p.contains("[\"teammate\"]"));
    assert!(p.contains(r#""id":"t1""#) && !p.contains(r#""id":"a9""#), "only the type's tasks: {p}");
    assert!(p.contains("workflows/wf_f7b371f3-6f2.json") && p.contains("subagents/"), "the folder listing: {p}");
    assert!(p.contains("seamux runs s-done --all"));
    let failed = host::Notice { kind: "failed".into(), adapter: Some("mine".into()), task_type: None, count: 1,
                                why: "runs[0].status: \"x\" is not one of running".into() };
    let f = crew_core::runs::draft::prompt(&c, &failed, Path::new("/t"));
    assert!(f.starts_with("The seamux adapter `mine` failed: runs[0].status"), "a broken adapter's prompt names the check: {f}");
    assert!(crew_core::runs::draft::listing(&fixture("s-done")).len() <= crew_core::runs::draft::LIST_MAX + 1);
}

#[test]
fn the_lookout_adapter_replaces_a_reviewers_row_with_its_findings() {
    // A session with one background sub-agent whose brief names a lookout
    // review, and that review's store with a finding made while it ran.
    let root = tmp("lookout");
    let session = root.join("s-lk");
    let sub = session.join("subagents");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("agent-r1.meta.json"), json!({"agentType": "general-purpose", "description": "Lookout review of x",
        "requestShape": "background", "finished": true}).to_string()).unwrap();
    let lines = [
        json!({"type": "user", "timestamp": "2026-11-08T20:00:00.000Z", "message": {"content": "Read the brief"}}),
        json!({"type": "user", "timestamp": "2026-11-08T20:00:05.000Z", "message": {"content": [{"type": "tool_result",
            "content": "Then ingest it:\n\n  lookout findings add rv-1 /tmp/x.json"}]}}),
        json!({"type": "assistant", "timestamp": "2026-11-08T20:01:00.000Z", "message": {"id": "m1", "model": "claude-sonnet-5-5",
            "usage": {"input_tokens": 10, "output_tokens": 5}, "content": [{"type": "text", "text": "done"}]}}),
    ];
    fs::write(sub.join("agent-r1.jsonl"), lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    let store = root.join("reviews");
    fs::create_dir_all(&store).unwrap();
    fs::write(store.join("rv-1.json"), json!({"title": "x", "reviewedAt": "2026-11-08T20:00:40.000Z", "findings": [
        {"id": "f1", "severity": "major", "file": "a/b.rs", "line": 9, "short_summary": "it breaks", "createdAt": "2026-11-08T20:00:30.000Z"},
        {"id": "f0", "severity": "blocker", "file": "a/c.rs", "line": 1, "short_summary": "an earlier round's", "createdAt": "2026-11-08T19:00:00.000Z"},
        {"id": "f2", "severity": "blocker", "file": "a/d.rs", "line": 2, "short_summary": "a person's", "by": "human", "createdAt": "2026-11-08T20:00:31.000Z"}]}).to_string()).unwrap();
    // The bundled adapter, run with its store pointed here through its own
    // command (no process-wide variable).
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crew/adapters/lookout/adapter.py");
    let wrap = root.join("adapters/lookout");
    fs::create_dir_all(&wrap).unwrap();
    fs::write(wrap.join("adapter.json"), json!({"schema": "seamux.adapter/1", "name": "lookout", "recognizes": ["subagent"],
        "command": ["env", format!("SEAMUX_LOOKOUT_REVIEWS={}", store.display()), "python3", script.display().to_string()]}).to_string()).unwrap();
    let (bundled, bad) = host::load(&root.join("adapters"));
    assert!(bad.is_empty(), "{bad:?}");
    let mut adapters = crew_core::runs::builtins();
    adapters.extend(bundled);
    let c = Context { session_dir: session.clone(), session: "s-lk".into(), background: vec![task("subagent", "r1", "Lookout review of x")], ..Default::default() };
    let rep = host::report(&c, &adapters, false);
    assert!(rep.notices.is_empty(), "{:?}", rep.notices);
    let [r] = rep.runs.as_slice() else { panic!("one run, the lookout one replacing the built-in's: {:?}", rep.runs) };
    let res = r.agents[0].result.clone().unwrap();
    assert_eq!((r.source.as_str(), res.badge.as_deref()), ("lookout", Some("1 major")), "only this reviewer's finding counts");
    assert!(res.detail.as_deref().is_some_and(|d| d.contains("major   f1   b.rs:9  it breaks") && !d.contains("f0") && !d.contains("f2")),
            "not another round's, not a person's: {:?}", res.detail);
    assert_eq!(r.agents[0].model.as_deref(), Some("claude-sonnet-5-5"));
}
