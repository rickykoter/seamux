//! crew-store against artifacts.py on one database: Python writes, Rust
//! reads, and the other way round; Keep's refusals and copies; the store's
//! directory and its env overrides; the version 1 to 2 migration.
//!
//! The store reads its paths from the environment, which is process-wide,
//! so every test holds ENV for its whole run.

use serde_json::{json, Map, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

static ENV: Mutex<()> = Mutex::new(());

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
}

/// A throwaway HOME, durable dir and temp root, set in this process's env.
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let base = std::env::temp_dir().canonicalize().unwrap();
        let root = base.join(format!("crew-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("faketmp")).unwrap();
        std::env::set_var("HOME", root.join("home"));
        std::env::set_var("CREW_DURABLE_DIR", root.join("crew"));
        std::env::set_var("CREW_TEMP_ROOTS", format!("{}/", root.join("faketmp").display()));
        std::env::remove_var("CREW_HOME");
        Fixture { root }
    }

    fn p(&self, rel: &str) -> String {
        self.root.join(rel).to_string_lossy().into_owned()
    }

    /// Run Python against artifacts.py, with this process's env; returns stdout.
    fn py(&self, code: &str) -> String {
        let board = repo().join("crew/board");
        let out = Command::new("python3")
            .arg("-c")
            .arg(format!("import sys, json; sys.path.insert(0, {:?}); import artifacts as A\n{code}", board.to_str().unwrap()))
            .output()
            .expect("python3");
        assert!(out.status.success(), "python failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn row(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn python_writes_rust_reads() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("py2rs");
    let ws = f.p("home/code/shop");
    std::fs::create_dir_all(&ws).unwrap();
    f.py(&format!(
        "db = A.connect(); db.execute('BEGIN IMMEDIATE')\n\
         mk = lambda **k: dict(dict.fromkeys(A.FIELDS, ''), ws={ws:?}, **k)\n\
         A.write_rows(db, [mk(kind='doc', locator='/d/guide.md', path='/d/guide.md', title='guide.md', prompt='Draft the shop guide', created_at='2020-01-01T10:00:00.000Z'),\n\
                           mk(kind='commit', locator='abc1234', title='Add guide', sha='abc1234', created_at='2020-01-02T10:00:00.000Z'),\n\
                           mk(kind='temp', locator='/t/n.md', path='/t/n.md', title='n.md', prompt='keep scratch notes héllo', created_at='2020-01-03T10:00:00.000Z')])\n\
         db.execute('COMMIT')"
    ));
    let all = crew_store::search("", None, None, 1000).unwrap();
    assert_eq!(all.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["n.md", "Add guide", "guide.md"]);
    let hits = crew_store::search("scratch héllo", None, None, 500).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "n.md");
    assert!(crew_store::search("guide", Some("/nowhere"), None, 500).unwrap().is_empty());
    assert_eq!(crew_store::search("guide", Some(&format!("{ws}/")), Some("commit"), 500).unwrap().len(), 1);
    assert!(crew_store::search("\"oops* OR (NEAR", None, None, 500).is_ok());
    let w = crew_store::workspaces().unwrap();
    assert_eq!((w[0].ws.as_str(), w[0].n), (ws.as_str(), 3));
    assert_eq!(crew_store::count(&ws).unwrap(), 3);
    // Row JSON is the Python's dict(row), key for key.
    let id = all[0].id;
    let py: Value = serde_json::from_str(&f.py(&format!("print(json.dumps(A.row({id})))"))).unwrap();
    assert_eq!(crew_store::row(id).unwrap().unwrap().to_json(), py);
    assert_eq!(crew_store::row(99999).unwrap(), None);
    let pys: Value = serde_json::from_str(&f.py("print(json.dumps(A.search(limit=1000)))")).unwrap();
    assert_eq!(Value::Array(all.iter().map(|r| r.to_json()).collect()), pys);
}

#[test]
fn rust_writes_python_reads() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("rs2py");
    let db = crew_store::connect().unwrap();
    let mode = std::fs::metadata(f.p("crew")).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    crew_store::schema::write_rows(
        &db,
        &[row(json!({"ws": "/w/a", "kind": "doc", "locator": "/w/a/x.md", "path": "/w/a/x.md",
                     "title": "x.md", "prompt": "write the release notes"})),
          row(json!({"ws": "", "kind": "doc", "locator": "/skipped"}))],
    )
    .unwrap();
    db.execute_batch("COMMIT").unwrap();
    drop(db);
    let out = f.py("print(json.dumps([(r['title'], r['ws']) for r in A.search('release')]))");
    assert_eq!(out.trim(), r#"[["x.md", "/w/a"]]"#);
    let v = f.py("db = A.connect(); print(db.execute('SELECT version FROM meta').fetchone()[0])");
    assert_eq!(v.trim(), "2");
}

#[test]
fn crew_home_is_not_the_store() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("crewhome");
    std::env::remove_var("CREW_DURABLE_DIR");
    std::env::set_var("CREW_HOME", f.p("checkout-crew"));
    crew_store::connect().unwrap();
    assert!(Path::new(&f.p("home/.claude/crew/artifacts.db")).exists());
    assert!(!Path::new(&f.p("checkout-crew")).exists());
    std::env::remove_var("CREW_HOME");
}

#[test]
fn keep_refuses_and_copies_like_python() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("keep");
    let ws = f.p("home/code/shop");
    let sp = f.p("faketmp/sp");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(format!("{sp}/adir")).unwrap();
    std::fs::write(format!("{sp}/notes.md"), "notes").unwrap();
    std::fs::write(f.p("home/todo.txt"), "todo").unwrap();
    std::os::unix::fs::symlink(f.p("home/todo.txt"), format!("{sp}/link.txt")).unwrap();
    let big = std::fs::File::create(format!("{sp}/big.bin")).unwrap();
    big.set_len(51 * 1024 * 1024).unwrap();
    // A known mtime, to see copy2's survive.
    let c = std::ffi::CString::new(format!("{sp}/notes.md")).unwrap();
    let t = [libc::timespec { tv_sec: 1600000000, tv_nsec: 0 }; 2];
    assert_eq!(unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), t.as_ptr(), 0) }, 0);
    f.py(&format!(
        "db = A.connect(); db.execute('BEGIN IMMEDIATE')\n\
         mk = lambda p, kind='temp': dict(dict.fromkeys(A.FIELDS, ''), ws={ws:?}, kind=kind, locator=p, path=p, title=p.split('/')[-1])\n\
         A.write_rows(db, [mk({n:?}), mk({d:?}), mk({l:?}), mk({b:?}), mk({g:?}), mk({o:?}, 'file'),\n\
                           dict(mk({n:?}, 'artifact'), url='https://claude.ai/artifact/z')])\n\
         db.execute('COMMIT')",
        n = format!("{sp}/notes.md"),
        d = format!("{sp}/adir"),
        l = format!("{sp}/link.txt"),
        b = format!("{sp}/big.bin"),
        g = format!("{sp}/gone.txt"),
        o = f.p("home/todo.txt"),
    ));
    let id = |title: &str, kind: &str| {
        crew_store::search("", Some(&ws), Some(kind), 100).unwrap().into_iter().find(|r| r.title == title).unwrap().id
    };
    let why = |i: i64| crew_store::keep(i).unwrap().why.unwrap_or_default();
    assert_eq!(why(id("adir", "temp")), "a directory");
    assert_eq!(why(id("link.txt", "temp")), "a symlink");
    assert_eq!(why(id("big.bin", "temp")), "over 50MB");
    assert_eq!(why(id("gone.txt", "temp")), "the file is gone");
    assert_eq!(why(id("todo.txt", "file")), "not in a temp directory");
    assert_eq!(why(99999), "no such row");

    // A named pipe is refused without opening it (opening would hang), in
    // Python's words.
    let fifo = format!("{sp}/pipe");
    let cf = std::ffi::CString::new(fifo.clone()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(cf.as_ptr(), 0o600) }, 0);
    f.py(&format!(
        "db = A.connect(); db.execute('BEGIN IMMEDIATE')\n\
         A.write_rows(db, [dict(dict.fromkeys(A.FIELDS, ''), ws={ws:?}, kind='temp', locator={fifo:?}, path={fifo:?}, title='pipe')])\n\
         db.execute('COMMIT')"
    ));
    let pid = id("pipe", "temp");
    let py_why = f.py(&format!("print(A.keep({pid})['why'])"));
    assert_eq!(why(pid), py_why.trim());
    std::fs::remove_file(&fifo).unwrap();

    let nid = id("notes.md", "temp");
    let res = crew_store::keep(nid).unwrap();
    assert!(res.ok, "{res:?}");
    let dest = res.path.clone().unwrap();
    let py_dir = f.py(&format!("print(A.kept_dir({ws:?}))"));
    assert_eq!(Path::new(&dest).parent().unwrap().to_str().unwrap(), py_dir.trim());
    assert_eq!(crew_store::kept_dir(&ws), py_dir.trim());
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "notes");
    let m = std::fs::metadata(&dest).unwrap();
    assert_eq!(std::os::unix::fs::MetadataExt::mtime(&m), 1600000000);
    let dm = std::fs::metadata(Path::new(&dest).parent().unwrap()).unwrap().permissions().mode() & 0o777;
    assert_eq!(dm, 0o700);
    assert_eq!(why(nid), "already kept");
    // Python sees the kept row exactly as Rust wrote it.
    let k: Value = serde_json::from_str(&f.py(&format!("print(json.dumps(A.row({nid})))"))).unwrap();
    assert_eq!(k["path"], json!(dest));
    assert_eq!(k["was_path"], json!(format!("{sp}/notes.md")));
    assert!(k["kept_at"].is_string());

    // keep all: one result per at-risk row, refusals included; the gone
    // file, the kept row and the artifact row are not offered.
    let all = crew_store::keep_all(&ws).unwrap();
    let mut whys: Vec<String> = all.iter().filter(|r| !r.ok).map(|r| r.why.clone().unwrap()).collect();
    whys.sort();
    assert_eq!(whys, vec!["a directory", "a symlink", "over 50MB"]);
    assert!(all.iter().all(|r| r.id != nid));
    assert_eq!(all[0].to_json().as_object().unwrap().keys().collect::<Vec<_>>(), vec!["ok", "id", "why"]);
}

#[test]
fn migrates_version_1() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("migrate");
    let real = f.p("home/code/app");
    std::fs::create_dir_all(&real).unwrap();
    let link = f.p("home/app-link");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    std::fs::create_dir_all(f.p("crew")).unwrap();
    {
        let db = rusqlite::Connection::open(f.p("crew/artifacts.db")).unwrap();
        db.execute_batch(crew_store::schema::SCHEMA).unwrap();
        db.execute_batch("INSERT INTO meta(version) VALUES (1)").unwrap();
        db.execute(
            "INSERT INTO artifacts(ws, kind, locator, kept_at) VALUES (?, 'temp', '/k', '2020-01-01'), (?, 'temp', '/d', NULL)",
            (format!("{link}/"), &link),
        )
        .unwrap();
        db.execute("INSERT INTO cursors(transcript) VALUES ('/x.jsonl')", []).unwrap();
    }
    let rows = crew_store::search("", None, None, 100).unwrap();
    assert_eq!(rows.len(), 1, "derived rows dropped, kept rows stay");
    assert_eq!(rows[0].ws, real, "re-keyed through wskey");
    let db = crew_store::connect().unwrap();
    let n: i64 = db.query_row("SELECT COUNT(*) FROM cursors", [], |r| r.get(0)).unwrap();
    let v: i64 = db.query_row("SELECT version FROM meta", [], |r| r.get(0)).unwrap();
    assert_eq!((n, v), (0, 2));
}
