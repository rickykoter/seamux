//! crew's bundled scout adapter (crew/adapters/scout), through the host,
//! with deep-plan's state and keys folders made up for the test. A test
//! binary of its own: it sets DEEP_PLAN_STATE_DIR and DEEP_PLAN_KEYS_DIR,
//! which the adapter's process inherits, and no other test runs beside it.

use std::fs;
use std::path::Path;

use crew_core::runs::host::{self, Adapter, Context};
use serde_json::json;

#[test]
fn scouts_go_under_their_plan_with_the_facts_and_risks_they_backed() {
    let root = std::env::temp_dir().join(format!("crew-scout-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let (state, keys) = (root.join("state"), root.join("keys"));
    fs::create_dir_all(&state).unwrap();
    fs::create_dir_all(&keys).unwrap();
    // The fixture's scouts start at 09:00 and 09:01 on 2026-11-09 (UTC); the
    // plan this session owns was rendered at 10:01, a plan of another
    // session's just after them.
    fs::write(state.join("demo.json"), json!({"slug": "demo", "root": "/w/repo", "session": "s-scout",
        "log": [{"at": 1794218500000u64}, {"at": 1794218600000u64}]}).to_string()).unwrap();
    fs::write(state.join("other.json"), json!({"slug": "other", "root": "/w/repo", "session": "s-else",
        "log": [{"at": 1794214900000u64}]}).to_string()).unwrap();
    fs::write(keys.join("demo.spec.json"), json!({"slug": "demo",
        "verifiedFacts": [
            {"claim": "a", "evidence": "app/crates/crew-core/src/runs/model.rs:62"},
            {"claim": "b", "evidence": "app/crates/crew-core/src/runs/host.rs:439"},
            {"claim": "c", "evidence": "app/crates/crew-core/src/runs/host.rs:183"}],
        "risks": ["Bundled adapters load in folder-name order (host.rs), so a rename could reorder them.",
                  {"risk": "Nothing about the card.", "disposition": "accept"}]}).to_string()).unwrap();
    std::env::set_var("DEEP_PLAN_STATE_DIR", &state);
    std::env::set_var("DEEP_PLAN_KEYS_DIR", &keys);
    std::env::set_var("XDG_CACHE_HOME", root.join("cache"));

    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crew/adapters");
    let (all, bad) = host::load(&dir);
    assert!(bad.is_empty(), "{bad:?}");
    let mut adapters = crew_core::runs::builtins();
    adapters.extend(all.into_iter().filter(|a| ["explore", "scout"].contains(&a.name())));
    assert_eq!(adapters.iter().map(Adapter::name).collect::<Vec<_>>(), vec!["claude-subagents", "claude-workflow", "explore", "scout"],
               "scout loads after explore, so its run takes the place of an Explore scout's");
    let session_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runs/projects/-w-repo/s-scout");
    let c = Context { session: "s-scout".into(), session_dir, cwd: "/w/repo".into(), ..Default::default() };
    let rep = host::report(&c, &adapters, true);
    assert!(rep.notices.is_empty(), "{:?}", rep.notices);
    let by = |id: &str| rep.runs.iter().find(|r| r.id == id).unwrap();
    let badge = |id: &str| by(id).agents[0].result.as_ref().and_then(|r| r.badge.clone());
    let metric = |id: &str, k: &str| by(id).metrics.iter().find(|m| m.label == k).map(|m| m.value.clone());

    let a = by("a5c0000000000000a");
    assert_eq!((a.source.as_str(), a.kind.as_str()), ("scout", "scout"), "an Explore scout is the scout adapter's");
    assert_eq!(a.group.as_ref().map(|g| (g.id.as_str(), g.label.as_str(), g.kind.as_deref())),
               Some(("plan:demo", "Scouts for demo", Some("plan"))), "under the plan this session owns, not the other session's");
    assert_eq!(badge("a5c0000000000000a").as_deref(), Some("2 facts"), "model.rs:62, and host.rs:437 is within 3 lines of host.rs:439");
    assert_eq!((metric("a5c0000000000000a", "facts").as_deref(), metric("a5c0000000000000a", "risks").as_deref()), (Some("2"), Some("1")));
    assert_eq!(badge("a5c0000000000000b").as_deref(), Some("1 risk"), "a general-purpose scout: no fact near host.rs:217, a risk naming host.rs");
    assert_eq!(by("a5c0000000000000b").links.iter().map(|l| l.line).collect::<Vec<_>>(), vec![Some(217)]);
    let explore = by("a5c0000000000000c");
    assert_eq!((explore.source.as_str(), explore.group.is_none()), ("explore", true), "an Explore agent that is no scout stays Explore's");
    assert_eq!(rep.summaries, vec![("scout".to_string(), "scouts: 2 facts, 1 risk in demo".to_string())],
               "each fact and risk counted once across scouts");

    // Before the spec is rendered, a scout's badge is its citations.
    fs::remove_file(keys.join("demo.spec.json")).unwrap();
    // The same context: the manifest watches the keys folder, so the cached
    // document goes once the 2 s freshness window has passed.
    std::thread::sleep(std::time::Duration::from_millis(host::FRESH_MS as u64 + 50));
    let scout = host::doc_of(&adapters[3], &c).unwrap();
    let a = scout.runs.iter().find(|r| r.id == "a5c0000000000000a").unwrap();
    assert_eq!(a.agents[0].result.as_ref().and_then(|r| r.badge.as_deref()), Some("3 cites"));
    assert!(scout.summary.is_none());

    // A plan this session finished before the scouts started is not theirs:
    // their own plan is not rendered yet. One still open is (a scout sent
    // while amending it).
    fs::remove_file(state.join("demo.json")).unwrap();
    fs::write(state.join("old.json"), json!({"slug": "old", "root": "/w/repo", "session": "s-scout", "phase": "done",
        "log": [{"at": 1794211200000u64}]}).to_string()).unwrap();
    let ungrouped = host::doc_of(&adapters[3], &Context { cwd: "/w/done".into(), ..c.clone() }).unwrap();
    assert!(ungrouped.runs.iter().all(|r| r.group.is_none()), "{:?}", ungrouped.runs.iter().map(|r| &r.group).collect::<Vec<_>>());
    fs::write(state.join("old.json"), json!({"slug": "old", "root": "/w/repo", "session": "s-scout", "phase": "implementing",
        "log": [{"at": 1794211200000u64}]}).to_string()).unwrap();
    let amending = host::doc_of(&adapters[3], &Context { cwd: "/w/open".into(), ..c.clone() }).unwrap();
    assert!(amending.runs.iter().all(|r| r.group.as_ref().is_some_and(|g| g.id == "plan:old")));
    let _ = fs::remove_dir_all(&root);
}
