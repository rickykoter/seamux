//! The Rust indexer against artifacts.py's on one fixture: a session in a
//! real git checkout writes a scratchpad note, a doc, source, a file under
//! ~, an image and a /tmp redirect, commits (printed and quiet), publishes,
//! runs a subagent and leaves plan, review and ask records. Python indexes
//! into one database and Rust into another, and every row and cursor must
//! match; then an appended chunk, and the shared lock.

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

static ENV: Mutex<()> = Mutex::new(());

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

struct Fx {
    root: PathBuf,
    ws: String,
    tr: String,
    sp: String,
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn git(ws: &str, args: &[&str]) -> String {
    let o = Command::new("git").arg("-C").arg(ws).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap().trim().to_string()
}

fn jl(path: &str, lines: &[Value]) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

fn now_iso(offset: i64) -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as f64;
    crew_store::iso(t + offset as f64)
}

fn fixture(name: &str) -> Fx {
    let base = std::env::temp_dir().canonicalize().unwrap();
    let root = base.join(format!("crew-store-ix-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let faketmp = root.join("faketmp");
    let scratch = faketmp.join("claude-501");
    std::env::set_var("HOME", &home);
    std::env::set_var("CREW_SCRATCH_BASE", &scratch);
    std::env::set_var("CREW_TEMP_ROOTS", format!("{}/:/private/tmp/", s(&faketmp)));
    std::env::set_var("GIT_CONFIG_GLOBAL", "/dev/null");
    std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    std::env::remove_var("CREW_DURABLE_DIR");
    std::env::remove_var("CREW_HOME");

    let ws = s(&home.join("code/shop"));
    std::fs::create_dir_all(format!("{ws}/docs")).unwrap();
    std::fs::create_dir_all(home.join("notes")).unwrap();
    git(&ws, &["init", "-q", "-b", "main"]);
    git(&ws, &["config", "user.email", "probe@example.com"]);
    git(&ws, &["config", "user.name", "probe"]);
    std::fs::write(format!("{ws}/docs/guide.md"), "# Guide\n").unwrap();
    git(&ws, &["add", "."]);
    git(&ws, &["commit", "-q", "-m", "Add guide"]);
    let sha = git(&ws, &["rev-parse", "HEAD"]);
    git(&ws, &["remote", "add", "origin", "git@github.com:octo/shop.git"]);

    let proj = "-probe-code-shop";
    let sess = "11111111-2222-3333-4444-555555555555";
    let pdir = home.join(".claude/projects").join(proj);
    std::fs::create_dir_all(pdir.join(sess).join("subagents")).unwrap();
    let sp = s(&scratch.join(proj).join(sess).join("scratchpad"));
    std::fs::create_dir_all(format!("{sp}/repo/.git")).unwrap();
    std::fs::write(format!("{sp}/notes.md"), "notes").unwrap();
    std::fs::write(format!("{sp}/stray.py"), "print(1)").unwrap();
    std::fs::write(format!("{sp}/shot.png"), "png").unwrap();
    std::fs::write(format!("{sp}/repo/.git/HEAD"), "ref").unwrap();
    let tr = s(&pdir.join(format!("{sess}.jsonl")));

    let base = json!({"cwd": ws, "sessionId": sess, "gitBranch": "main"});
    let with = |extra: Value| {
        let mut b = base.clone();
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    };
    let user = |ts: &str, text: Value| with(json!({"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}));
    let use_ = |ts: &str, id: &str, name: &str, inp: Value| {
        with(json!({"type": "assistant", "timestamp": ts, "message": {"role": "assistant",
            "content": [{"type": "tool_use", "id": id, "name": name, "input": inp}]}}))
    };
    let result = |ts: &str, id: &str, tur: Value| {
        with(json!({"type": "user", "timestamp": ts, "toolUseResult": tur, "message": {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": id, "content": "ok"}]}}))
    };
    let p1 = format!("<system-reminder>secret</system-reminder>Draft the shop guide, notes ✓{}", " word".repeat(200));
    jl(&tr, &[
        user("2020-01-01T10:00:00.000Z", json!(p1)),
        use_("2020-01-01T10:00:01.000Z", "u1", "Write", json!({"file_path": format!("{sp}/notes.md"), "content": "x"})),
        use_("2020-01-01T10:00:02.000Z", "u2", "Write", json!({"file_path": format!("{ws}/docs/guide.md"), "content": "x"})),
        use_("2020-01-01T10:00:03.000Z", "u3", "Write", json!({"file_path": format!("{ws}/src/app.py"), "content": "x"})),
        use_("2020-01-01T10:00:04.000Z", "u4", "Write", json!({"file_path": s(&home.join("notes/todo.txt")), "content": "x"})),
        use_("2020-01-01T10:00:05.000Z", "u5", "Write", json!({"file_path": s(&pdir.join("memo.md")), "content": "x"})),
        use_("2020-01-01T10:00:06.000Z", "u6", "Write", json!({"file_path": format!("{ws}/shot.PNG"), "content": "x"})),
        use_("2020-01-01T10:00:07.000Z", "u7", "Bash", json!({"command": "echo hi > /tmp/ix-out.log; echo x > $S/hidden.txt"})),
        json!("a bare string line"),
        with(json!({"type": "assistant", "timestamp": "2020-01-01T10:00:09.000Z",
            "message": {"content": [{"type": "tool_use", "id": "u8", "name": "Write", "input": "not a dict"}]}})),
        use_("2020-01-01T10:00:10.000Z", "u9", "Bash", json!({"command": "git commit -m 'Add guide'"})),
        result("2020-01-01T10:00:11.000Z", "u9", json!({"stdout": format!("[main {}] Add guide\n 1 file changed, 1 insertion(+)\n", &sha[..7]), "stderr": ""})),
        use_("2020-01-01T10:00:12.000Z", "u10", "Bash", json!({"command": "python3 fixture_probe.py"})),
        result("2020-01-01T10:00:13.000Z", "u10", json!({"stdout": "[main (root-commit) 1a2b3c4] init\n 1 file changed\n", "stderr": ""})),
        user("2099-01-01T10:00:00.000Z", json!([{"type": "text", "text": "<command-name>/publish</command-name><command-args>the guide</command-args>"}])),
        use_("2099-01-01T10:00:01.000Z", "u11", "Artifact", json!({"file_path": format!("{ws}/docs/guide.md")})),
        result("2099-01-01T10:00:02.000Z", "u11", json!({"url": "https://claude.ai/code/artifact/abc-123", "path": format!("{ws}/docs/guide.md"), "title": "Shop guide"})),
    ]);
    // The malformed line, raw.
    std::fs::OpenOptions::new().append(true).open(&tr).unwrap().write_all(b"{not json\n").unwrap();
    jl(&s(&pdir.join(sess).join("subagents/agent-a1.jsonl")), &[
        with(json!({"type": "user", "timestamp": "2020-01-01T10:05:00.000Z", "isSidechain": true, "message": {"content": "subagent task"}})),
        use_("2020-01-01T10:05:01.000Z", "s1", "Write", json!({"file_path": format!("{sp}/summary.txt"), "content": "x"})),
    ]);

    let dp = home.join(".claude/deep-plan/state");
    std::fs::create_dir_all(&dp).unwrap();
    std::fs::write(dp.join("shop-guide.json"), json!({"slug": "shop-guide", "root": ws, "session": sess,
        "log": [{"at": 1600000000123i64}, {"at": 1600000500000i64}, {"what": "no at"}]}).to_string()).unwrap();
    std::fs::write(dp.join("broken.json"), "{oops").unwrap();
    let plans = home.join(".claude/plans");
    std::fs::create_dir_all(plans.join("reviews")).unwrap();
    std::fs::create_dir_all(plans.join("asks")).unwrap();
    std::fs::write(plans.join("shop-guide.md"), "intro\n# Write the shop guide  \n").unwrap();
    std::fs::write(plans.join("reviews/shop-inc1.json"), json!({"title": "shop · 1", "createdAt": "2020-02-01T00:00:00.000Z",
        "source": {"root": ws, "branch": "main"}}).to_string()).unwrap();
    std::fs::write(plans.join("reviews/shop-inc1.html"), "<p>").unwrap();
    std::fs::write(plans.join("reviews/shop-inc1.rows.json"), "{}").unwrap();
    std::fs::write(plans.join("reviews/wake-abcdef1.json"), json!({"source": {"root": ws}}).to_string()).unwrap();
    std::fs::write(plans.join("asks/a1.json"), json!({"cwd": ws, "created": "2020-03-01T00:00:00.000Z",
        "header": "Scope", "question": "Which pages?"}).to_string()).unwrap();
    std::fs::write(plans.join("asks/a2.json"), json!({"cwd": ws, "question": 5}).to_string()).unwrap();

    Fx { root, ws, tr, sp }
}

/// Every row (minus id) and cursor of a database, as comparable JSON.
fn dump(db: &str) -> (Vec<Value>, Vec<Value>) {
    let c = rusqlite::Connection::open(db).unwrap();
    let mut st = c.prepare("SELECT * FROM artifacts ORDER BY ws, kind, locator").unwrap();
    let rows = st
        .query_map([], |r| {
            let mut v = crew_store::Row::from_sql(r)?.to_json();
            v.as_object_mut().unwrap().remove("id");
            Ok(v)
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut st = c.prepare("SELECT transcript, offset, size, mtime FROM cursors ORDER BY transcript").unwrap();
    let curs = st
        .query_map([], |r| {
            Ok(json!([r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, f64>(3)?]))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    (rows, curs)
}

fn py_index(dir: &str) -> String {
    let o = Command::new("python3")
        .arg(repo().join("crew/bin/crew-artifacts"))
        .arg("index")
        .env("CREW_DURABLE_DIR", dir)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap()
}

fn rs_index(dir: &str) -> usize {
    std::env::set_var("CREW_DURABLE_DIR", dir);
    let n = crew_store::index().unwrap();
    std::env::remove_var("CREW_DURABLE_DIR");
    n
}

fn assert_same(a: &str, b: &str) {
    let (ra, ca) = dump(&format!("{a}/artifacts.db"));
    let (rb, cb) = dump(&format!("{b}/artifacts.db"));
    assert_eq!(ra.len(), rb.len(), "row counts");
    for (x, y) in ra.iter().zip(rb.iter()) {
        assert_eq!(x, y);
    }
    assert_eq!(ca, cb, "cursors");
}

#[test]
fn rust_indexes_what_python_indexes() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = fixture("same");
    let (pa, pb) = (s(&f.root.join("py")), s(&f.root.join("rs")));
    let out = py_index(&pa);
    let n = rs_index(&pb);
    assert_eq!(out.trim(), format!("indexed {n} rows"));
    assert_same(&pa, &pb);
    let (rows, _) = dump(&format!("{pb}/artifacts.db"));
    let kinds: Vec<&str> = rows.iter().map(|r| r["kind"].as_str().unwrap()).collect();
    for k in ["temp", "doc", "file", "image", "commit", "artifact", "plan", "review", "ask"] {
        assert!(kinds.contains(&k), "no {k} row in {kinds:?}");
    }
    assert!(rows.iter().all(|r| !r["locator"].as_str().unwrap().ends_with("1a2b3c4")), "a fixture's commit line is not a commit");

    // An appended chunk: the prompt in flight before the offset, a quiet
    // commit found by HEAD's time, a kept-then-rewritten temp file.
    std::fs::write(format!("{}/docs/q.md", f.ws), "q").unwrap();
    git(&f.ws, &["add", "."]);
    git(&f.ws, &["commit", "-q", "-m", "Quiet and silent"]);
    let now = now_iso(0);
    let base = json!({"cwd": f.ws, "sessionId": "11111111-2222-3333-4444-555555555555", "gitBranch": "main"});
    let mut a = base.clone();
    a["type"] = json!("assistant");
    a["timestamp"] = json!(now);
    a["message"] = json!({"content": [{"type": "tool_use", "id": "u20", "name": "Bash", "input": {"command": "git -C . commit -q -F -"}}]});
    let mut r = base.clone();
    r["type"] = json!("user");
    r["timestamp"] = json!(now);
    r["toolUseResult"] = json!({"stdout": "", "stderr": ""});
    r["message"] = json!({"content": [{"type": "tool_result", "tool_use_id": "u20"}]});
    let mut w = base.clone();
    w["type"] = json!("assistant");
    w["timestamp"] = json!(now);
    w["message"] = json!({"content": [{"type": "tool_use", "id": "u21", "name": "Write", "input": {"file_path": format!("{}/docs/later.md", f.ws)}}]});
    jl(&f.tr, &[a, r, w]);
    std::fs::write(format!("{}/late.txt", f.sp), "late").unwrap();
    py_index(&pa);
    rs_index(&pb);
    assert_same(&pa, &pb);
    let (rows, _) = dump(&format!("{pb}/artifacts.db"));
    assert!(rows.iter().any(|r| r["title"] == "Quiet and silent"));
    let later = rows.iter().find(|r| r["locator"].as_str().unwrap().ends_with("later.md")).unwrap();
    // Written now, between the 2020 prompt and the 2099 one: the 2020 prompt
    // was in flight, and it sits before the cursor's offset.
    assert!(later["prompt"].as_str().unwrap().starts_with("Draft the shop guide, notes ✓ word"));
    let publish = rows.iter().find(|r| r["kind"] == "artifact").unwrap();
    assert_eq!(publish["prompt"], "/publish the guide");

    // Nothing moved: each reads nothing on the other's database.
    assert_eq!(rs_index(&pa), 0);
    assert_eq!(py_index(&pb).trim(), "indexed 0 rows");
    assert_same(&pa, &pb);

    // Backfill keeps every row and id.
    let before = dump(&format!("{pb}/artifacts.db")).0;
    std::env::set_var("CREW_DURABLE_DIR", &pb);
    crew_store::backfill().unwrap();
    std::env::remove_var("CREW_DURABLE_DIR");
    assert_eq!(dump(&format!("{pb}/artifacts.db")).0, before);
}

#[test]
fn a_lock_python_holds_makes_rust_busy() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = fixture("lock");
    let dir = s(&f.root.join("crew"));
    std::fs::create_dir_all(&dir).unwrap();
    // Python takes the lock and holds it until stdin closes.
    let mut holder = Command::new("python3")
        .arg("-c")
        .arg("import fcntl, sys; f = open(sys.argv[1], 'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); sys.stdin.read()")
        .arg(format!("{dir}/index.lock"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(holder.stdout.take().unwrap()), &mut line).unwrap();
    assert_eq!(line.trim(), "held");
    std::env::set_var("CREW_DURABLE_DIR", &dir);
    assert!(matches!(crew_store::index(), Err(crew_store::Error::Busy)));
    assert!(Path::new(&format!("{dir}/index.lock.again")).exists());
    drop(holder.stdin.take());
    holder.wait().unwrap();
    // The next run takes the lock and consumes the marker.
    crew_store::index().unwrap();
    assert!(!Path::new(&format!("{dir}/index.lock.again")).exists());
    std::env::remove_var("CREW_DURABLE_DIR");
}
