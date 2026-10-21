//! Reviews: lookout writes reviews/<id>.json (the record) and .html (the
//! page). This serves the page with the token injected, the record to a
//! holder of the token, and takes the human's comments and closes as POST.
//! A comment is stored as data; nothing here types into a terminal.
//!
//! Writes take lookout's lock (a file contract, ADR 0004, with withLock in
//! lookout/lib/store.mjs): a <id>.lock directory made atomically, stale after
//! 10s, broken through a <id>.lock-break guard, one breaker at a time.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Map, Value};

use crew_core::pyjson;

use crate::plans::{realpath, slug_ok};
use crate::server::{iso_now, plans_dir, token_hex};

pub const REVIEW_JS: &str = include_str!("inject/review.js");
pub const MAX_BODY: usize = 64 * 1024;
const MAX_TEXT: usize = 4000;
const OPS: [&str; 5] = ["comment", "resolve", "dismiss", "reopen", "answer"];
const LOCK_STALE: f64 = 10.0;

/// LOOKOUT_REVIEWS_DIR first, as lookout's store resolves it.
pub fn reviews_dir() -> PathBuf {
    match std::env::var("LOOKOUT_REVIEWS_DIR").ok().filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => plans_dir().join("reviews"),
    }
}

pub fn review_path(rid: &str, ext: &str) -> Option<PathBuf> {
    if !slug_ok(rid) {
        return None;
    }
    let base = realpath(&reviews_dir());
    let target = realpath(&reviews_dir().join(format!("{rid}{ext}")));
    if !target.starts_with(&base) || target == base {
        return None;
    }
    target.is_file().then_some(target)
}

// The probe's scheduler jitter: a pause of up to 2ms after every stat, which
// widens the gap two stale-lock breakers race in. Off unless --lock-test asks.
static JITTER: AtomicBool = AtomicBool::new(false);

fn stat(p: &Path) -> std::io::Result<std::fs::Metadata> {
    let r = std::fs::metadata(p);
    if JITTER.load(Ordering::Relaxed) {
        let mut b = [0u8; 1];
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            use std::io::Read;
            let _ = f.read_exact(&mut b);
        }
        std::thread::sleep(Duration::from_micros(b[0] as u64 * 2000 / 255));
    }
    r
}

/// Stale: older than LOCK_STALE. Err when it cannot be stat'ed.
fn stale(p: &Path) -> std::io::Result<bool> {
    let m = stat(p)?.modified()?;
    let age = SystemTime::now().duration_since(m).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    Ok(age > LOCK_STALE)
}

/// Remove a stale lock, one breaker at a time; true when it is gone.
fn break_stale(lock: &Path) -> bool {
    let guard = PathBuf::from(format!("{}-break", lock.display()));
    match stale(lock) {
        Ok(false) => return false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
        Err(_) => return false,
        Ok(true) => {}
    }
    match std::fs::create_dir(&guard) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // A guard as old as a stale lock is a crashed breaker's.
            if let Ok(true) = stale(&guard) {
                let _ = std::fs::remove_dir(&guard);
            }
            return false;
        }
        Err(_) => return false,
    }
    let gone = match stale(lock) {
        Ok(false) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
        Ok(true) => match std::fs::remove_dir(lock) {
            Ok(()) => true,
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        },
    };
    let _ = std::fs::remove_dir(&guard);
    gone
}

/// lookout's lock, held until dropped.
pub struct Lock(PathBuf);

impl Lock {
    pub fn take(rid: &str) -> Result<Lock, String> {
        let path = reviews_dir().join(format!("{rid}.lock"));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Lock(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.to_string()),
            }
            let gone = break_stale(&path);
            if Instant::now() > deadline {
                return Err("the review is locked by another writer".into());
            }
            if !gone {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// `--lock-test RID N [--jitter]`: take the lock once (N=0), or N times
/// incrementing <RID>.json's "n" under it, 2ms apart; {took, s} or
/// {took: false, err, s}. The board probe races this against lookout's writers.
pub fn lock_test(rid: &str, n: i64, jitter: bool) -> i32 {
    JITTER.store(jitter, Ordering::Relaxed);
    let t = Instant::now();
    for i in 0..n.max(1) {
        let held = match Lock::take(rid) {
            Ok(l) => l,
            Err(e) => {
                JITTER.store(false, Ordering::Relaxed);
                println!("{}", pyjson::dumps(&json!({"took": false, "err": e, "s": pyjson::float(t.elapsed().as_secs_f64())})));
                return 0;
            }
        };
        if n > 0 {
            let p = reviews_dir().join(format!("{rid}.json"));
            let mut r: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_default()).unwrap_or(json!({}));
            let next = r.get("n").and_then(Value::as_i64).unwrap_or(0) + 1;
            r["n"] = json!(next);
            let tmp = format!("{}.tmp-{}-{i}", p.display(), std::process::id());
            let _ = std::fs::write(&tmp, pyjson::dumps(&r));
            let _ = std::fs::rename(&tmp, &p);
        }
        drop(held);
        if n > 0 {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    JITTER.store(false, Ordering::Relaxed);
    println!("{}", pyjson::dumps(&json!({"took": true, "s": pyjson::float(t.elapsed().as_secs_f64())})));
    0
}

fn next_id(items: &[Value], prefix: &str) -> String {
    let mut n: u64 = 0;
    for x in items {
        let id = x.get("id").map(crate::pyval::py_str).unwrap_or_default();
        if let Some(tail) = id.strip_prefix(prefix) {
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                n = n.max(tail.parse().unwrap_or(0));
            }
        }
    }
    format!("{prefix}{}", n + 1)
}

fn message(msgs: &mut Vec<Value>, text: &str, extra: &[(&str, Value)]) {
    let mut m = Map::new();
    m.insert("id".into(), json!(next_id(msgs, "m")));
    m.insert("by".into(), json!("human"));
    m.insert("at".into(), json!(iso_now()));
    m.insert("text".into(), json!(text));
    for (k, v) in extra {
        m.insert((*k).into(), v.clone());
    }
    msgs.push(Value::Object(m));
}

fn setdefault_list<'a>(o: &'a mut Map<String, Value>, k: &str) -> &'a mut Vec<Value> {
    if !o.contains_key(k) {
        o.insert(k.into(), json!([]));
    }
    if !o[k].is_array() {
        o.insert(k.into(), json!([]));
    }
    o.get_mut(k).and_then(Value::as_array_mut).unwrap()
}

fn int_not_bool(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Number(n)) => n.as_i64(),
        _ => None,
    }
}

fn id_is(v: &Value, id: &str) -> bool {
    v.get("id").and_then(Value::as_str) == Some(id)
}

/// One op from the page, as the human: (http code, reply).
pub fn apply(rid: &str, body: &Map<String, Value>) -> (u16, Value) {
    let op = body.get("op").and_then(Value::as_str).unwrap_or("");
    if !OPS.contains(&op) {
        return (400, json!({"error": "unknown op"}));
    }
    let text: String = crate::pyval::str_or_empty(body.get("text").unwrap_or(&Value::Null)).trim().chars().take(MAX_TEXT).collect();
    let mut item_id = crate::pyval::str_or_empty(body.get("item").unwrap_or(&Value::Null));
    let path = reviews_dir().join(format!("{rid}.json"));

    let _held = match Lock::take(rid) {
        Ok(l) => l,
        Err(e) => return (409, json!({"error": e})),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (404, json!({"error": "no such review"})),
        Err(e) => return (409, json!({"error": e.to_string()})),
    };
    let mut review: Map<String, Value> = match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(o)) => o,
        Ok(_) => return (409, json!({"error": "the review record is not an object"})),
        Err(e) => return (409, json!({"error": e.to_string()})),
    };
    setdefault_list(&mut review, "findings");
    setdefault_list(&mut review, "threads");

    // Where the item lives: ("findings" | "threads", index).
    let mut item: Option<(&str, usize)> = None;
    if op == "answer" {
        let quiz_on = review.get("policy").and_then(|p| p.get("quiz")).map(crate::pyval::truthy).unwrap_or(false);
        if !quiz_on {
            return (400, json!({"error": "this review has no quiz"}));
        }
        let pick = body.get("pick");
        let notes = review.get_mut("notes").and_then(Value::as_array_mut);
        let note = notes.and_then(|ns| ns.iter_mut().find(|n| id_is(n, &item_id)));
        let quiz = note.and_then(|n| n.get_mut("quiz")).filter(|q| q.is_object());
        let Some(quiz) = quiz else {
            return (404, json!({"error": format!("no question on note {item_id}")}));
        };
        let n_opts = quiz.get("options").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0) as i64;
        let pick = match int_not_bool(pick) {
            Some(p) if p >= 0 && p < n_opts => p,
            _ => return (400, json!({"error": "pick is an option's index as written"})),
        };
        if quiz.get("answered").map(crate::pyval::truthy).unwrap_or(false) {
            return (409, json!({"error": "already answered", "review": Value::Object(review.clone())}));
        }
        let correct = quiz.get("answer").and_then(Value::as_f64) == Some(pick as f64);
        quiz["answered"] = json!({"pick": pick, "correct": correct, "at": iso_now(), "by": "human"});
    } else if !item_id.is_empty() {
        if let Some(i) = review["findings"].as_array().unwrap().iter().position(|f| id_is(f, &item_id)) {
            item = Some(("findings", i));
        } else if let Some(i) = review["threads"].as_array().unwrap().iter().position(|t| id_is(t, &item_id)) {
            item = Some(("threads", i));
        } else {
            return (404, json!({"error": format!("no finding or thread {item_id}")}));
        }
    }

    if op == "comment" {
        if text.is_empty() {
            return (400, json!({"error": "an empty comment says nothing"}));
        }
        match item {
            Some((list, i)) => {
                let it = review.get_mut(list).unwrap().as_array_mut().unwrap()[i].as_object_mut();
                let Some(it) = it else { return (400, json!({"error": "the item is not an object"})) };
                let msgs = setdefault_list(it, if list == "findings" { "thread" } else { "messages" });
                message(msgs, &text, &[]);
            }
            None => {
                let f = crate::pyval::str_or_empty(body.get("file").unwrap_or(&Value::Null));
                let side = body.get("side").filter(|s| crate::pyval::truthy(s)).cloned().unwrap_or(json!("new"));
                let in_review = review.get("files").and_then(Value::as_array)
                    .map(|fs| fs.iter().any(|x| x.get("path").and_then(Value::as_str) == Some(f.as_str())))
                    .unwrap_or(false);
                if !in_review {
                    return (400, json!({"error": "file is not in this review"}));
                }
                let line = int_not_bool(body.get("line"));
                let side_ok = side == "new" || side == "old";
                let Some(line) = line.filter(|l| *l >= 1 && side_ok) else {
                    return (400, json!({"error": "a comment needs a line and a side"}));
                };
                let threads = review.get_mut("threads").unwrap().as_array_mut().unwrap();
                let id = next_id(threads, "t");
                let mut t = Map::new();
                t.insert("id".into(), json!(id));
                t.insert("file".into(), json!(f));
                t.insert("line".into(), json!(line));
                t.insert("side".into(), side);
                t.insert("status".into(), json!("open"));
                t.insert("by".into(), json!("human"));
                t.insert("createdAt".into(), json!(iso_now()));
                let mut msgs = Vec::new();
                message(&mut msgs, &text, &[]);
                t.insert("messages".into(), Value::Array(msgs));
                threads.push(Value::Object(t));
                item_id = id;
            }
        }
    } else if op != "answer" {
        let Some((list, i)) = item else { return (400, json!({"error": format!("{op} needs an item")})) };
        let mut to = match op { "resolve" => "resolved", "dismiss" => "dismissed", _ => "open" };
        if list == "threads" && to == "dismissed" {
            to = "resolved";
        }
        let it = review.get_mut(list).unwrap().as_array_mut().unwrap()[i].as_object_mut();
        let Some(it) = it else { return (400, json!({"error": "the item is not an object"})) };
        let frm = it.get("status").filter(|s| crate::pyval::truthy(s)).cloned().unwrap_or(json!("open"));
        it.insert("status".into(), json!(to));
        it.insert("statusBy".into(), json!("human"));
        it.insert("statusAt".into(), json!(iso_now()));
        let msgs = setdefault_list(it, if list == "findings" { "thread" } else { "messages" });
        message(msgs, &text, &[("kind", json!("status")), ("from", frm), ("to", json!(to))]);
    }

    review.insert("updatedAt".into(), json!(iso_now()));
    let review = Value::Object(review);
    let tmp = format!("{}.tmp-{}-{}", path.display(), std::process::id(), token_hex(3));
    let wrote = std::fs::write(&tmp, format!("{}\n", pyjson::dumps_indent(&review, 2)))
        .and_then(|_| std::fs::rename(&tmp, &path));
    if let Err(e) = wrote {
        return (409, json!({"error": e.to_string()}));
    }
    drop(_held);
    sync(rid);
    (200, json!({"ok": true, "item": item_id, "review": review}))
}

/// Have lookout re-rank and redraw the review in the background; best-effort.
pub fn sync(rid: &str) {
    let Some((node, engine)) = crate::act::lookout_engine() else { return };
    let mut cmd = std::process::Command::new(node);
    cmd.args([engine.as_str(), "sync", rid])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // start_new_session: the sync outlives this request and the server.
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    // Reaped on a thread of its own, so a long-lived server leaves no zombies.
    if let Ok(mut child) = cmd.spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_count_up_from_the_highest() {
        let items = vec![json!({"id": "m1"}), json!({"id": "m7"}), json!({"id": "mx"}), json!({"id": 3})];
        assert_eq!(next_id(&items, "m"), "m8");
        assert_eq!(next_id(&[], "t"), "t1");
    }
}
