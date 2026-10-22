//! crates/cmux against a fake cmux socket: which ops go by socket, which fall
//! back to the CLI, handle checks, and the event stream with its fallback.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use cmux::{Cmux, Error, EventOptions, Transport, WorkspaceAction};
use serde_json::{json, Value};

struct Fake {
    dir: PathBuf,
    sock: PathBuf,
    cli: PathBuf,
    seen: Arc<Mutex<Vec<Value>>>,
}

impl Fake {
    fn cli_log(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("cli.log"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }
    fn methods_seen(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|r| r["method"].as_str().unwrap().to_string()).collect()
    }
}

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cmux-t-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A fake CLI: logs its argv; `events` prints two event frames.
fn write_cli(dir: &Path) -> PathBuf {
    let p = dir.join("fakecli");
    std::fs::write(
        &p,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\n\
             if [ \"$1\" = events ]; then\n\
             echo '{{\"type\":\"event\",\"seq\":7,\"name\":\"a\"}}'\n\
             echo '{{\"type\":\"event\",\"seq\":8,\"name\":\"b\"}}'\nfi\n",
            dir.join("cli.log").display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

/// A fake socket listing `methods`. `events.stream` answers an ack and two
/// events after `after_seq`, then hangs up, unless `stream` is false, when it
/// is refused like an unknown method.
fn start(tag: &str, methods: &[&str], stream: bool) -> Fake {
    start_dropping(tag, methods, stream, None)
}

/// As start, but the `drop`-th connection (0-based) is closed unanswered, the
/// way a socket looks while cmux restarts.
fn start_dropping(tag: &str, methods: &[&str], stream: bool, drop: Option<usize>) -> Fake {
    let dir = tmpdir(tag);
    let sock = dir.join("s.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let methods: Vec<String> = methods.iter().map(|m| m.to_string()).collect();
    let seen2 = seen.clone();
    std::thread::spawn(move || {
        for (i, conn) in listener.incoming().enumerate() {
            let Ok(conn) = conn else { return };
            if Some(i) == drop {
                continue; // dropped: closed without a word
            }
            let (seen, methods) = (seen2.clone(), methods.clone());
            std::thread::spawn(move || {
                let mut w = conn.try_clone().unwrap();
                for line in BufReader::new(conn).lines() {
                    let Ok(line) = line else { return };
                    let req: Value = serde_json::from_str(&line).unwrap();
                    seen.lock().unwrap().push(req.clone());
                    let id = req["id"].clone();
                    let m = req["method"].as_str().unwrap();
                    let reply = match m {
                        "system.capabilities" => json!({"id": id, "ok": true, "result": {
                            "access_mode": "automation", "protocol": "cmux-socket", "version": 2,
                            "capabilities": ["events.v1"], "methods": methods}}),
                        "events.stream" if stream => {
                            let after = req["params"]["after_seq"].as_i64().unwrap_or(0);
                            let frames = [
                                json!({"type": "ack", "protocol": "cmux-events"}),
                                json!({"type": "heartbeat"}),
                                json!({"type": "event", "seq": after + 1, "name": "workspace.selected"}),
                                json!({"type": "event", "seq": after + 2, "name": "workspace.selected"}),
                            ];
                            for f in frames {
                                writeln!(w, "{f}").unwrap();
                            }
                            return; // hang up
                        }
                        "workspace.list" => json!({"id": id, "ok": true, "result": {"workspaces": [{"ref": "workspace:1", "title": "one"}]}}),
                        "surface.read_text" => json!({"id": id, "ok": true, "result": {"text": "hello\n", "surface_ref": "surface:3"}}),
                        "workspace.status.get" => json!({"id": id, "ok": true, "result": {"effective": "review", "inferred": "working", "override": {"status": "review", "inferred_at_override": "working"}, "signals": {}}}),
                        m if methods.iter().any(|x| x == m) => json!({"id": id, "ok": true, "result": {}}),
                        _ => json!({"id": id, "ok": false, "error": {"code": "method_not_found", "message": "Unknown method"}}),
                    };
                    writeln!(w, "{reply}").unwrap();
                }
            });
        }
    });
    let cli = write_cli(&dir);
    Fake { dir, sock, cli, seen }
}

fn open(f: &Fake) -> Cmux {
    Cmux::open(Transport::Socket(f.sock.clone())).unwrap().with_cli_bin(f.cli.clone())
}

const LISTED: &[&str] = &[
    "system.ping", "workspace.list", "surface.read_text", "workspace.status.get",
    "workspace.action", "workspace.select", "surface.close",
];

#[test]
fn listed_ops_go_by_socket_with_cli_params() {
    let f = start("listed", LISTED, true);
    let c = open(&f);
    assert_eq!(c.access_mode().as_deref(), Some("automation"));
    assert!(c.has_capability("events.v1"));
    c.ping().unwrap();
    let v = c.workspace_list(None).unwrap();
    assert_eq!(v["workspaces"][0]["ref"], "workspace:1");
    assert_eq!(c.read_text("surface:3", Some(60)).unwrap(), "hello\n");
    c.workspace_action("workspace:1", &WorkspaceAction::SetColor("#FF0000".into())).unwrap();
    let st = c.workspace_status("workspace:1").unwrap();
    assert_eq!(st, json!({"effective": "review", "inferred": "working", "override": "review"}));

    let seen = f.seen.lock().unwrap().clone();
    let read = seen.iter().find(|r| r["method"] == "surface.read_text").unwrap();
    assert_eq!(read["params"], json!({"surface_id": "surface:3", "lines": 60, "scrollback": true}));
    let act = seen.iter().find(|r| r["method"] == "workspace.action").unwrap();
    assert_eq!(
        act["params"],
        json!({"workspace_id": "workspace:1", "force": false, "action": "set_color", "color": "#FF0000"})
    );
    assert!(f.cli_log().is_empty(), "nothing listed should touch the CLI: {:?}", f.cli_log());
}

#[test]
fn a_bad_handle_never_reaches_the_socket() {
    let f = start("handle", LISTED, true);
    let c = open(&f);
    let before = f.methods_seen().len();
    assert!(matches!(c.workspace_select("nope"), Err(Error::BadHandle(_))));
    assert!(matches!(c.close_surface("workspace:1"), Err(Error::BadHandle(_))));
    assert_eq!(f.methods_seen().len(), before);
}

#[test]
fn an_unlisted_method_falls_back_to_the_cli_argv() {
    // workspace.status.set and workspace.rename are not listed here.
    let f = start("unlisted", LISTED, true);
    let c = open(&f);
    c.workspace_status_set("workspace:1", "auto").unwrap();
    c.rename_workspace("workspace:1", "PROJ-1 · thing").unwrap();
    assert_eq!(
        f.cli_log(),
        vec![
            "workspace status set auto --workspace workspace:1",
            "rename-workspace --workspace workspace:1 PROJ-1 · thing",
        ]
    );
    assert!(!f.methods_seen().iter().any(|m| m == "workspace.status.set"));
}

#[test]
fn cli_only_ops_run_the_cli_on_the_socket_transport() {
    let f = start("clionly", LISTED, true);
    let c = open(&f);
    c.set_progress("workspace:1", 0.5, "inc 2/4").unwrap();
    c.clear_status("claude", Some("workspace:1")).unwrap();
    c.notify(&cmux::Notify {
        title: "crew".into(),
        subtitle: Some("crew:pr".into()),
        body: Some("#3 merged".into()),
        workspace: Some("workspace:1".into()),
    })
    .unwrap();
    assert_eq!(
        f.cli_log(),
        vec![
            "set-progress 0.5000 --label inc 2/4 --workspace workspace:1",
            "clear-status claude --workspace workspace:1",
            "notify --title crew --subtitle crew:pr --body #3 merged --workspace workspace:1",
        ]
    );
}

#[test]
fn events_stream_on_the_socket_and_keep_the_cursor() {
    let f = start("events", LISTED, true);
    let c = open(&f);
    let cursor = f.dir.join("events.seq");
    std::fs::write(&cursor, "40").unwrap();
    let mut st = c
        .events(EventOptions { names: vec!["workspace.selected".into()], cursor_file: Some(cursor.clone()), reconnect: false })
        .unwrap();
    assert!(st.on_socket());
    let seqs: Vec<i64> = st.by_ref().map(|f| f.unwrap()["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![41, 42], "ack and heartbeat are skipped; resumes after the cursor");
    assert_eq!(std::fs::read_to_string(&cursor).unwrap(), "42");
    let req = f.seen.lock().unwrap().iter().find(|r| r["method"] == "events.stream").cloned().unwrap();
    assert_eq!(req["params"]["after_seq"], 40);
    assert_eq!(req["params"]["names"], json!(["workspace.selected"]));
}

#[test]
fn a_refused_stream_falls_back_to_a_cmux_events_child() {
    let f = start("evfallback", LISTED, false);
    let c = open(&f);
    let cursor = f.dir.join("events.seq");
    let st = c
        .events(EventOptions { names: vec!["a".into(), "b".into()], cursor_file: Some(cursor.clone()), reconnect: false })
        .unwrap();
    assert!(!st.on_socket());
    let names: Vec<String> = st.map(|f| f.unwrap()["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["a", "b"]);
    assert_eq!(
        f.cli_log(),
        vec![format!("events --cursor-file {} --no-ack --no-heartbeat --name a --name b", cursor.display())]
    );
}

#[test]
fn rpc_goes_straight_to_the_socket() {
    let f = start("rpc", &["feed.list"], true);
    let c = open(&f);
    c.rpc("feed.list", json!({"limit": 5})).unwrap();
    let req = f.seen.lock().unwrap().iter().find(|r| r["method"] == "feed.list").cloned().unwrap();
    assert_eq!(req["params"], json!({"limit": 5}));
}

#[test]
fn reconnect_survives_a_failed_reopen_and_resumes_from_the_cursor() {
    // Connection 0 is the capabilities read, 1 the first stream, 2 the first
    // reopen (dropped), 3 the retry.
    let f = start_dropping("reconnect", LISTED, true, Some(2));
    let c = open(&f);
    let cursor = f.dir.join("events.seq");
    std::fs::write(&cursor, "10").unwrap();
    let st = c
        .events(EventOptions { names: vec![], cursor_file: Some(cursor.clone()), reconnect: true })
        .unwrap();
    let seqs: Vec<i64> = st.take(4).map(|f| f.unwrap()["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs, vec![11, 12, 13, 14]);
    let afters: Vec<i64> = f.seen.lock().unwrap().iter()
        .filter(|r| r["method"] == "events.stream")
        .map(|r| r["params"]["after_seq"].as_i64().unwrap())
        .collect();
    assert_eq!(afters, vec![10, 12], "the retry resumes after the last event seen");
    assert_eq!(std::fs::read_to_string(&cursor).unwrap(), "14");
}

#[test]
fn a_call_on_a_connection_cmux_hung_up_goes_again_on_a_fresh_one() {
    // The first connection answers the capabilities read and is closed (cmux
    // restarted); the write on it then fails with a broken pipe, before cmux
    // sees a byte, so the call is sent once more on a new connection.
    let dir = tmpdir("stale");
    let sock = dir.join("s.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen2 = seen.clone();
    std::thread::spawn(move || {
        for (i, conn) in listener.incoming().enumerate() {
            let Ok(conn) = conn else { return };
            let seen = seen2.clone();
            std::thread::spawn(move || {
                let mut w = conn.try_clone().unwrap();
                for line in BufReader::new(conn).lines() {
                    let Ok(line) = line else { return };
                    let req: Value = serde_json::from_str(&line).unwrap();
                    seen.lock().unwrap().push(req["method"].as_str().unwrap().to_string());
                    let result = match req["method"].as_str().unwrap() {
                        "system.capabilities" => json!({"methods": ["system.ping"]}),
                        _ => json!({"pong": true}),
                    };
                    writeln!(w, "{}", json!({"id": req["id"], "ok": true, "result": result})).unwrap();
                    if i == 0 {
                        return; // hang up after the first answer
                    }
                }
            });
        }
    });
    let c = Cmux::open(Transport::Socket(sock)).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(100)); // let the hang-up land
    assert_eq!(c.call("system.ping", json!({})).unwrap(), json!({"pong": true}));
    assert_eq!(seen.lock().unwrap().iter().filter(|m| *m == "system.ping").count(), 1, "sent once, not twice");
}
