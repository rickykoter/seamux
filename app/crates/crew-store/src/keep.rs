//! Keep: copy an at-risk temp file into ~/.claude/crew/kept/<workspace>/ and
//! repoint its row. artifacts.py's refusals, in its order, with its words.

use crate::paths::{basename, norm, wskey, Paths};
use crate::read::{row_in, Row};
use crate::schema::{connect_at, makedirs_0700};
use crate::{iso, Result};
use regex::Regex;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::os::unix::fs::MetadataExt;

pub const KEEP_MAX: u64 = 50 * 1024 * 1024;
pub const KEEP_ALL_MAX: u64 = 500 * 1024 * 1024;
pub const KEEP_KINDS: [&str; 4] = ["temp", "image", "doc", "file"];

/// One Keep's outcome: `{ok, id, path, was}` or `{ok: false, id, why}`.
#[derive(Debug, Clone, PartialEq)]
pub struct KeepResult {
    pub ok: bool,
    pub id: i64,
    pub path: Option<String>,
    pub was: Option<String>,
    pub why: Option<String>,
}

impl KeepResult {
    fn refused(id: i64, why: impl Into<String>) -> KeepResult {
        KeepResult { ok: false, id, path: None, was: None, why: Some(why.into()) }
    }

    /// The Python's dict, keys in its order.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(self.ok));
        m.insert("id".into(), self.id.into());
        if let Some(w) = &self.why {
            m.insert("why".into(), Value::String(w.clone()));
        }
        if let Some(p) = &self.path {
            m.insert("path".into(), Value::String(p.clone()));
        }
        if let Some(w) = &self.was {
            m.insert("was".into(), Value::String(w.clone()));
        }
        Value::Object(m)
    }
}

/// kept/<workspace>/: the workspace's name, plus a short hash of its path so
/// two checkouts called `app` do not share a folder.
pub fn kept_dir(ws: &str) -> String {
    kept_dir_at(&Paths::from_env(), ws)
}

fn kept_dir_at(p: &Paths, ws: &str) -> String {
    let base = basename(ws.trim_end_matches('/'));
    let base = if base.is_empty() { "root" } else { base };
    let re = Regex::new(r"[^A-Za-z0-9._-]+").expect("static regex");
    let name = re.replace_all(base, "-");
    let name = name.trim_matches('-');
    let name = if name.is_empty() { "ws" } else { name };
    let name: String = name.chars().take(60).collect();
    let h = sha1_smol::Sha1::from(ws.as_bytes()).digest().to_string();
    format!("{}/{}-{}", p.kept, name, &h[..6])
}

/// `str(OSError)`: `[Errno N] message: 'path'`.
fn os_str(e: &std::io::Error, path: &str) -> String {
    let full = crew_core::py::os_error(e, std::path::Path::new(path));
    match full.find(": ") {
        Some(i) if e.raw_os_error().is_some() => full[i + 2..].to_string(),
        _ => e.to_string(),
    }
}

/// `shutil.copy2`: the bytes, the mode, and the access and modify times. A
/// named pipe is refused before it is opened, as copyfile does (opening one
/// would block until a writer appears).
fn copy2(src: &str, dst: &str) -> std::result::Result<(), String> {
    use std::os::unix::fs::FileTypeExt;
    if std::fs::metadata(src).map(|m| m.file_type().is_fifo()).unwrap_or(false) {
        return Err(format!("`{src}` is a named pipe"));
    }
    copy2_io(src, dst).map_err(|e| os_str(&e, src))
}

fn copy2_io(src: &str, dst: &str) -> std::io::Result<()> {
    std::fs::copy(src, dst)?;
    let m = std::fs::metadata(src)?;
    let times = [
        libc::timespec { tv_sec: m.atime() as libc::time_t, tv_nsec: m.atime_nsec() as libc::c_long },
        libc::timespec { tv_sec: m.mtime() as libc::time_t, tv_nsec: m.mtime_nsec() as libc::c_long },
    ];
    let c = std::ffi::CString::new(dst).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    // SAFETY: c is a valid C string and times a two-element array, as utimensat requires.
    if unsafe { libc::utimensat(libc::AT_FDCWD, c.as_ptr(), times.as_ptr(), 0) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn now_stamp() -> String {
    let t = crew_core::py::now();
    // iso() is UTC; %Y%m%d-%H%M%S is its digits without the separators.
    let i = iso(t);
    format!("{}{}{}-{}{}{}", &i[0..4], &i[5..7], &i[8..10], &i[11..13], &i[14..16], &i[17..19])
}

/// `_keep_one`: copy one at-risk row's file into kept/ and repoint the row.
pub(crate) fn keep_one(db: &Connection, p: &Paths, r: &Row) -> Result<KeepResult> {
    let id = r.id;
    let path = r.path.as_str();
    if r.kept_at.as_deref().is_some_and(|k| !k.is_empty()) {
        return Ok(KeepResult::refused(id, "already kept"));
    }
    if path.is_empty() || !p.is_temp(&norm(path)) {
        return Ok(KeepResult::refused(id, "not in a temp directory"));
    }
    if std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Ok(KeepResult::refused(id, "a symlink"));
    }
    if std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false) {
        return Ok(KeepResult::refused(id, "a directory"));
    }
    let st = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return Ok(KeepResult::refused(id, "the file is gone")),
    };
    if st.len() > KEEP_MAX {
        return Ok(KeepResult::refused(id, "over 50MB"));
    }
    let d = kept_dir_at(p, &r.ws);
    makedirs_0700(&d)?;
    let stamp = now_stamp();
    let base = basename(path);
    let mut dest = format!("{d}/{stamp}-{base}");
    let mut n = 1;
    while std::path::Path::new(&dest).exists() {
        n += 1;
        dest = format!("{d}/{stamp}-{n}-{base}");
    }
    let tmp = format!("{dest}.part");
    let copied = copy2(path, &tmp).and_then(|_| std::fs::rename(&tmp, &dest).map_err(|e| os_str(&e, &tmp)));
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&tmp);
        return Ok(KeepResult::refused(id, format!("copy failed: {e}")));
    }
    let changed = db.execute(
        "UPDATE artifacts SET path = ?, was_path = ?, kept_at = ?, updated_at = ? \
         WHERE id = ? AND kept_at IS NULL",
        (&dest, path, iso(crew_core::py::now()), iso(crew_core::py::now()), id),
    )?;
    if changed != 1 {
        let _ = std::fs::remove_file(&dest);
        return Ok(KeepResult::refused(id, "kept meanwhile by another click"));
    }
    Ok(KeepResult { ok: true, id, path: Some(dest), was: Some(path.to_string()), why: None })
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

/// Keep one row, in one transaction.
pub fn keep(id: i64) -> Result<KeepResult> {
    let p = Paths::from_env();
    let db = connect_at(&p)?;
    immediate(&db, || match row_in(&db, id)? {
        Some(r) => keep_one(&db, &p, &r),
        None => Ok(KeepResult::refused(id, "no such row")),
    })
}

/// Keep every at-risk row in a workspace: each file row in a temp directory
/// whose file is still there, not yet kept, up to 500MB in all. One result
/// per row, refusals included.
pub fn keep_all(ws: &str) -> Result<Vec<KeepResult>> {
    let p = Paths::from_env();
    let db = connect_at(&p)?;
    let rows: Vec<Row> = {
        let mut st = db.prepare(
            "SELECT * FROM artifacts WHERE ws = ? AND kept_at IS NULL AND path <> '' \
             AND kind IN (?,?,?,?) ORDER BY created_at",
        )?;
        let k = KEEP_KINDS;
        let v = st
            .query_map((wskey(ws), k[0], k[1], k[2], k[3]), Row::from_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        v
    };
    let mut out = Vec::new();
    let mut total: u64 = 0;
    for r in rows {
        let present = std::fs::symlink_metadata(&r.path).is_ok();
        if !(p.is_temp(&norm(&r.path)) && present) {
            continue;
        }
        let size = match std::fs::metadata(&r.path) {
            Ok(m) if m.is_file() => m.len(),
            _ => 0,
        };
        if size <= KEEP_MAX && total + size > KEEP_ALL_MAX {
            out.push(KeepResult::refused(r.id, "over keep all's 500MB"));
            continue;
        }
        let res = immediate(&db, || keep_one(&db, &p, &r))?;
        if res.ok {
            total += size;
        }
        out.push(res);
    }
    Ok(out)
}
