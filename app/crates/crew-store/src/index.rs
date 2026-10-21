//! index and backfill: rescan every transcript whose size or mtime moved
//! since its cursor, then the plan, review and ask stores when their
//! fingerprint moved. artifacts.py's index(), pass for pass.

use crate::lock::IndexLock;
use crate::paths::Paths;
use crate::scan::{scan_transcript, Ctx};
use crate::schema::{connect_at, write_rows};
use crate::stores::{fingerprint, store_rows, STORE_KEY};
use crate::{Error, Result};
use rusqlite::{Connection, OptionalExtension};

fn listdir(d: &str) -> std::io::Result<Vec<String>> {
    Ok(std::fs::read_dir(d)?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
}

/// Every session transcript and its subagents' transcripts, sorted.
pub fn transcripts(p: &Paths) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(projects) = listdir(&p.projects) else { return out };
    for proj in projects {
        let pd = format!("{}/{}", p.projects, proj);
        let Ok(names) = listdir(&pd) else { continue };
        for n in names {
            let path = format!("{pd}/{n}");
            if n.ends_with(".jsonl") {
                out.push(path);
            } else {
                let sub = format!("{path}/subagents");
                if std::path::Path::new(&sub).is_dir() {
                    if let Ok(subs) = listdir(&sub) {
                        out.extend(subs.into_iter().filter(|s| s.ends_with(".jsonl")).map(|s| format!("{sub}/{s}")));
                    }
                }
            }
        }
    }
    out.sort();
    out
}

/// Run `f` inside BEGIN IMMEDIATE ... COMMIT, rolling back on an error.
fn immediate<T>(db: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    match f() {
        Ok(v) => {
            db.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// An Artifact publish names the file it sent: that file's own rows gain the
/// URL (how a Publish from the page lands even if its run's stdout was lost).
fn reconcile(db: &Connection, links: &[(String, String)]) -> Result<()> {
    for (path, url) in links {
        db.execute(
            "UPDATE artifacts SET url = ? WHERE kind <> 'artifact' AND url = '' \
             AND (path = ? OR locator = ? OR was_path = ?)",
            (url, path, path, path),
        )?;
    }
    Ok(())
}

/// One transcript, if its size or mtime moved since its cursor.
fn index_transcript(ctx: &mut Ctx, db: &Connection, path: &str) -> Result<usize> {
    let Ok(st) = std::fs::metadata(path) else { return Ok(0) };
    let size = st.len() as i64;
    let mtime = crew_core::py::mtime(&st);
    let cur: Option<(i64, i64, f64)> = db
        .query_row("SELECT offset, size, mtime FROM cursors WHERE transcript = ?", [path], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    let mut offset = 0i64;
    if let Some((o, s, m)) = cur {
        if s == size && m == mtime {
            return Ok(0);
        }
        offset = if o <= size { o } else { 0 };
    }
    let since = match cur {
        Some((_, _, m)) if offset != 0 => m,
        _ => 0.0,
    };
    let Ok((mut sc, end)) = scan_transcript(ctx, path, offset.max(0) as u64) else { return Ok(0) };
    if cur.is_some() && end as i64 == offset {
        // Nothing complete to read yet (a line mid-flush): leave the cursor,
        // so the next pass's scratchpad cut-off does not move past files
        // this pass never listed.
        return Ok(0);
    }
    sc.scratchpad(ctx, since);
    sc.finish(ctx);
    let rows: Vec<_> = std::mem::take(&mut sc.rows).into_iter().map(|d| d.finish()).collect();
    let n = rows.len();
    immediate(db, || {
        write_rows(db, &rows)?;
        reconcile(db, &sc.links)?;
        db.execute(
            "INSERT INTO cursors(transcript, offset, size, mtime) VALUES (?,?,?,?) \
             ON CONFLICT(transcript) DO UPDATE SET offset = excluded.offset, \
             size = excluded.size, mtime = excluded.mtime",
            (path, end as i64, size, mtime),
        )?;
        Ok(())
    })?;
    Ok(n)
}

fn index_once(p: &Paths) -> Result<usize> {
    let mut ctx = Ctx::new(p.clone());
    let db = connect_at(p)?;
    let mut n = 0;
    for path in transcripts(p) {
        match index_transcript(&mut ctx, &db, &path) {
            Ok(k) => n += k,
            Err(Error::Db(e)) => return Err(Error::Db(e)),
            Err(_) => continue,
        }
    }
    // The stores change rarely and every turn end runs this: rewrite their
    // rows only when a fingerprint of the three directories moved (kept as a
    // cursors row, keyed so it can never be a transcript path).
    let fp = fingerprint(&ctx);
    let cur: Option<(i64, f64)> = db
        .query_row("SELECT size, mtime FROM cursors WHERE transcript = ?", [STORE_KEY], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    if cur == Some(fp) {
        return Ok(n);
    }
    let rows = store_rows(&mut ctx);
    immediate(&db, || {
        write_rows(&db, &rows)?;
        db.execute(
            "INSERT INTO cursors(transcript, offset, size, mtime) VALUES (?, 0, ?, ?) \
             ON CONFLICT(transcript) DO UPDATE SET size = excluded.size, mtime = excluded.mtime",
            (STORE_KEY, fp.0, fp.1),
        )?;
        Ok(())
    })?;
    Ok(n + rows.len())
}

fn index_with(p: &Paths, lk: IndexLock) -> Result<usize> {
    let mut n = index_once(p)?;
    for _ in 0..3 {
        if !std::path::Path::new(&p.again).exists() {
            break;
        }
        let _ = std::fs::remove_file(&p.again);
        n += index_once(p)?;
    }
    drop(lk);
    Ok(n)
}

/// Rescan every transcript whose size or mtime moved, then the stores.
/// Another run holding the lock means this one has nothing to add: it
/// leaves a marker and returns Busy at once, and the holder goes round again.
pub fn index() -> Result<usize> {
    let p = Paths::from_env();
    let lk = IndexLock::try_take(&p)?;
    index_with(&p, lk)
}

/// Forget every cursor and index everything, waiting for the lock. Rows are
/// upserted, so a second backfill changes nothing it already knew.
pub fn backfill() -> Result<usize> {
    let p = Paths::from_env();
    {
        let db = connect_at(&p)?;
        db.execute("DELETE FROM cursors", [])?;
    }
    let lk = IndexLock::wait(&p)?;
    index_with(&p, lk)
}
