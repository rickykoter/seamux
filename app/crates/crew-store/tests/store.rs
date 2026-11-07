//! crew-store on a throwaway database: rows written and read back, search,
//! row JSON's keys, Keep's refusals and copies, the store's directory and its
//! env overrides, and the version 1 to 2 migration.
//!
//! The store reads its paths from the environment, which is process-wide,
//! so every test holds ENV for its whole run.

use serde_json::{json, Map, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static ENV: Mutex<()> = Mutex::new(());

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

    /// Write rows through the store's own upsert, in one transaction.
    fn write(&self, rows: Vec<Value>) {
        let db = crew_store::connect().unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        crew_store::schema::write_rows(&db, &rows.into_iter().map(row).collect::<Vec<_>>()).unwrap();
        db.execute_batch("COMMIT").unwrap();
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
fn written_rows_read_back() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("rows");
    let ws = f.p("home/code/shop");
    std::fs::create_dir_all(&ws).unwrap();
    f.write(vec![
        json!({"ws": ws, "kind": "doc", "locator": "/d/guide.md", "path": "/d/guide.md", "title": "guide.md",
               "prompt": "Draft the shop guide", "created_at": "2020-01-01T10:00:00.000Z"}),
        json!({"ws": ws, "kind": "commit", "locator": "abc1234", "title": "Add guide", "sha": "abc1234",
               "created_at": "2020-01-02T10:00:00.000Z"}),
        json!({"ws": ws, "kind": "temp", "locator": "/t/n.md", "path": "/t/n.md", "title": "n.md",
               "prompt": "keep scratch notes héllo", "created_at": "2020-01-03T10:00:00.000Z"}),
    ]);
    let all = crew_store::search("", None, None, 1000).unwrap();
    assert_eq!(all.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["n.md", "Add guide", "guide.md"]);
    let hits = crew_store::search("scratch héllo", None, None, 500).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].title, "n.md");
    assert!(crew_store::search("guide", Some("/nowhere"), None, 500).unwrap().is_empty());
    assert_eq!(crew_store::search("guide", Some(&format!("{ws}/")), Some("commit"), 500).unwrap().len(), 1);
    assert!(crew_store::search("\"oops* OR (NEAR", None, None, 500).is_ok());
    // search_in reads several workspaces at once; an empty or repeated one changes nothing.
    assert_eq!(crew_store::search_in("", &[ws.as_str(), "/nowhere"], None, 500).unwrap().len(), 3);
    assert_eq!(crew_store::search_in("", &["/nowhere"], None, 500).unwrap().len(), 0);
    assert_eq!(crew_store::search_in("guide", &[&format!("{ws}/"), ws.as_str(), ""], Some("commit"), 500).unwrap().len(), 1);
    assert_eq!(crew_store::search_in("", &[], None, 500).unwrap().len(), all.len(), "no directory filters nothing");
    let w = crew_store::workspaces().unwrap();
    assert_eq!((w[0].ws.as_str(), w[0].n), (ws.as_str(), 3));
    assert_eq!(crew_store::count(&ws).unwrap(), 3);
    // Row JSON keeps the store's column order, key for key, as the CLI and
    // the Wake print it (crew/tools/golden/artifacts/module-row-*.json).
    let id = all[0].id;
    let j = crew_store::row(id).unwrap().unwrap().to_json();
    assert_eq!(
        j.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["id", "ws", "repo", "kind", "title", "locator", "path", "url", "sha", "was_path", "created_at",
             "updated_at", "session_id", "branch", "prompt", "source", "kept_at"]
    );
    assert_eq!((j["title"].as_str(), j["prompt"].as_str(), &j["kept_at"]), (Some("n.md"), Some("keep scratch notes héllo"), &Value::Null));
    assert_eq!(crew_store::row(99999).unwrap(), None);
    assert_eq!(all.iter().map(|r| r.to_json()).collect::<Vec<_>>()[0], j, "search's rows are row()'s");
}

#[test]
fn a_write_skips_a_row_without_ws_and_the_store_is_version_2() {
    let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("write");
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
    let hits: Vec<(String, String)> =
        crew_store::search("release", None, None, 500).unwrap().into_iter().map(|r| (r.title, r.ws)).collect();
    assert_eq!(hits, vec![("x.md".to_string(), "/w/a".to_string())]);
    assert_eq!(crew_store::search("", None, None, 500).unwrap().len(), 1, "the row with no ws is not written");
    let v: i64 = db.query_row("SELECT version FROM meta", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 2);
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
fn keep_refuses_and_copies() {
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
    let mk = |p: String, kind: &str| {
        let title = p.rsplit('/').next().unwrap().to_string();
        json!({"ws": ws, "kind": kind, "locator": p, "path": p, "title": title})
    };
    let mut art = mk(format!("{sp}/notes.md"), "artifact");
    art["url"] = json!("https://claude.ai/artifact/z");
    f.write(vec![
        mk(format!("{sp}/notes.md"), "temp"), mk(format!("{sp}/adir"), "temp"), mk(format!("{sp}/link.txt"), "temp"),
        mk(format!("{sp}/big.bin"), "temp"), mk(format!("{sp}/gone.txt"), "temp"), mk(f.p("home/todo.txt"), "file"), art,
    ]);
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
    // the words shutil.copyfile used.
    let fifo = format!("{sp}/pipe");
    let cf = std::ffi::CString::new(fifo.clone()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(cf.as_ptr(), 0o600) }, 0);
    f.write(vec![json!({"ws": ws, "kind": "temp", "locator": fifo, "path": fifo, "title": "pipe"})]);
    let pid = id("pipe", "temp");
    assert_eq!(why(pid), format!("copy failed: `{fifo}` is a named pipe"));
    std::fs::remove_file(&fifo).unwrap();

    let nid = id("notes.md", "temp");
    let res = crew_store::keep(nid).unwrap();
    assert!(res.ok, "{res:?}");
    let dest = res.path.clone().unwrap();
    // kept/<name>-<first 6 of sha1(ws)>: two checkouts called shop keep apart.
    let want_dir = format!("{}/shop-{}", f.p("crew/kept"), &sha1_smol::Sha1::from(ws.as_bytes()).digest().to_string()[..6]);
    assert_eq!(Path::new(&dest).parent().unwrap().to_str().unwrap(), want_dir);
    assert_eq!(crew_store::kept_dir(&ws), want_dir);
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "notes");
    let m = std::fs::metadata(&dest).unwrap();
    assert_eq!(std::os::unix::fs::MetadataExt::mtime(&m), 1600000000);
    let dm = std::fs::metadata(Path::new(&dest).parent().unwrap()).unwrap().permissions().mode() & 0o777;
    assert_eq!(dm, 0o700);
    assert_eq!(why(nid), "already kept");
    // The kept row points at the copy and remembers where it was.
    let k = crew_store::row(nid).unwrap().unwrap().to_json();
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
