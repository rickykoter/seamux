//! Reviews: lookout writes reviews/<id>.json (the record) and .html (the
//! page). The /review/ routes are lookout serve's own, forwarded by proxy.rs;
//! what stays here is where reviews live, for the Wake and the app, and
//! lookout's lock, which `--lock-test` races against lookout's writers.
//!
//! The lock (a file contract, ADR 0004, with withLock in
//! lookout/lib/store.mjs): a <id>.lock directory made atomically, stale after
//! 10s, broken through a <id>.lock-break guard, one breaker at a time. The
//! holder writes a nonce to <id>.lock/owner and removes the lock only while
//! it is still its own: a holder slower than the stale window must not remove
//! the lock the writer who broke its lock now holds.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use crew_core::pyjson;

use crate::plans::{realpath, slug_ok};
use crate::server::plans_dir;

pub const MAX_BODY: usize = 64 * 1024;
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

/// The file in a lock directory naming its holder.
const OWNER: &str = "owner";

/// Remove a lock directory: its owner file, then the directory. Anything else
/// in it stays, and so does the lock (ENOTEMPTY): it is not one of ours.
fn remove_lock(lock: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(lock.join(OWNER));
    std::fs::remove_dir(lock)
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
        Ok(true) => match remove_lock(lock) {
            Ok(()) => true,
            Err(e) => e.kind() == std::io::ErrorKind::NotFound,
        },
    };
    let _ = std::fs::remove_dir(&guard);
    gone
}

/// lookout's lock, held until dropped.
pub struct Lock {
    path: PathBuf,
    nonce: String,
}

impl Lock {
    pub fn take(rid: &str) -> Result<Lock, String> {
        let path = reviews_dir().join(format!("{rid}.lock"));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::create_dir(&path) {
                Ok(()) => {
                    let nonce = format!("{}-{}", std::process::id(), crate::server::token_hex(8));
                    if let Err(e) = std::fs::write(path.join(OWNER), &nonce) {
                        let _ = std::fs::remove_dir(&path);
                        return Err(e.to_string());
                    }
                    return Ok(Lock { path, nonce });
                }
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
    /// Released only while it is still ours: a lock broken as stale and taken
    /// by another writer carries that writer's nonce, and stays.
    fn drop(&mut self) {
        if still_ours(&self.path, &self.nonce) {
            let _ = remove_lock(&self.path);
        }
    }
}

fn still_ours(lock: &Path, nonce: &str) -> bool {
    std::fs::read_to_string(lock.join(OWNER)).is_ok_and(|s| s == nonce)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_broken_and_retaken_is_not_released_by_its_first_holder() {
        let dir = std::env::temp_dir().join(format!("crew-review-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("r.lock");
        let first = Lock { path: lock.clone(), nonce: "first".into() };
        std::fs::create_dir(&lock).unwrap();
        std::fs::write(lock.join(OWNER), "first").unwrap();
        // Broken as stale, then taken by a second writer.
        remove_lock(&lock).unwrap();
        std::fs::create_dir(&lock).unwrap();
        std::fs::write(lock.join(OWNER), "second").unwrap();
        drop(first);
        assert!(lock.is_dir(), "the first holder removed the second writer's lock");
        assert!(still_ours(&lock, "second"));
        let second = Lock { path: lock.clone(), nonce: "second".into() };
        drop(second);
        assert!(!lock.exists());
        // A lock with anything else in it is not ours to remove.
        std::fs::create_dir(&lock).unwrap();
        std::fs::write(lock.join("x"), "").unwrap();
        assert!(remove_lock(&lock).is_err() && lock.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
