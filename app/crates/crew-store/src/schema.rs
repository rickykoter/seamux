//! The schema, connect and migrate: artifacts.py's, statement for statement.
//! The SQL text is the Python's, so a database either side creates is the
//! same database.

use crate::paths::{wskey, Paths};
use crate::Result;
use rusqlite::{Connection, OptionalExtension};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::time::Duration;

pub const VERSION: i64 = 2;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY,
  ws TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', locator TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  sha TEXT NOT NULL DEFAULT '', was_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  kept_at TEXT,
  UNIQUE(ws, kind, locator));
CREATE INDEX IF NOT EXISTS artifacts_ws ON artifacts(ws, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  title, path, url, prompt, content='artifacts', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, title, path, url, prompt)
  VALUES (new.id, new.title, new.path, new.url, new.prompt);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, path, url, prompt)
  VALUES ('delete', old.id, old.title, old.path, old.url, old.prompt);
END;
CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, title, path, url, prompt)
  VALUES ('delete', old.id, old.title, old.path, old.url, old.prompt);
  INSERT INTO artifacts_fts(rowid, title, path, url, prompt)
  VALUES (new.id, new.title, new.path, new.url, new.prompt);
END;
CREATE TABLE IF NOT EXISTS cursors(
  transcript TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, mtime REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL);
";

/// The row columns an upsert writes, in the Python's FIELDS order.
pub const FIELDS: [&str; 14] = [
    "ws", "repo", "kind", "title", "locator", "path", "url", "sha",
    "created_at", "updated_at", "session_id", "branch", "prompt", "source",
];

/// The upsert: it never blanks what an earlier pass learned, a kept row
/// keeps its copy's path, and a kept file written again at its temp path is
/// at risk (and keepable) again.
pub const UPSERT: &str = "
INSERT INTO artifacts(ws, repo, kind, title, locator, path, url, sha,
                      created_at, updated_at, session_id, branch, prompt, source)
VALUES (:ws, :repo, :kind, :title, :locator, :path, :url, :sha,
        :created_at, :updated_at, :session_id, :branch, :prompt, :source)
ON CONFLICT(ws, kind, locator) DO UPDATE SET
  repo = CASE WHEN excluded.repo <> '' THEN excluded.repo ELSE repo END,
  title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
  path = CASE WHEN kept_at IS NULL AND excluded.path <> '' THEN excluded.path
              WHEN kept_at IS NOT NULL AND excluded.path = was_path AND excluded.updated_at > kept_at
              THEN excluded.path ELSE path END,
  url = CASE WHEN excluded.url <> '' THEN excluded.url ELSE url END,
  sha = CASE WHEN excluded.sha <> '' THEN excluded.sha ELSE sha END,
  created_at = CASE WHEN created_at = '' OR (excluded.created_at <> ''
                    AND excluded.created_at < created_at)
               THEN excluded.created_at ELSE created_at END,
  updated_at = CASE WHEN excluded.updated_at > updated_at
               THEN excluded.updated_at ELSE updated_at END,
  session_id = CASE WHEN session_id = '' THEN excluded.session_id ELSE session_id END,
  branch = CASE WHEN branch = '' THEN excluded.branch ELSE branch END,
  prompt = CASE WHEN prompt = '' THEN excluded.prompt ELSE prompt END,
  source = CASE WHEN source = '' THEN excluded.source ELSE source END,
  was_path = CASE WHEN kept_at IS NOT NULL AND excluded.path = was_path
                  AND excluded.updated_at > kept_at THEN '' ELSE was_path END,
  kept_at = CASE WHEN kept_at IS NOT NULL AND excluded.path = was_path
                 AND excluded.updated_at > kept_at THEN NULL ELSE kept_at END
";

/// `os.makedirs(d, mode=0o700, exist_ok=True)`.
pub(crate) fn makedirs_0700(d: &str) -> std::io::Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(d)
}

/// Open (and create or migrate) the store. The directory is 0700: the db
/// holds prompt excerpts and kept/ holds copies of temp files.
pub fn connect() -> Result<Connection> {
    connect_at(&Paths::from_env())
}

pub(crate) fn connect_at(p: &Paths) -> Result<Connection> {
    makedirs_0700(&p.crew_home)?;
    let _ = std::fs::set_permissions(&p.crew_home, std::fs::Permissions::from_mode(0o700));
    let db = Connection::open(&p.db)?;
    db.busy_timeout(Duration::from_secs(30))?;
    // journal_mode answers with a row; query it rather than execute it.
    let _: String = db.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    migrate(&db)?;
    Ok(db)
}

fn version(db: &Connection) -> i64 {
    db.query_row("SELECT version FROM meta", [], |r| r.get::<_, i64>(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// Migrations by meta.version, inside one transaction that re-reads the
/// version, so two first connects do not both migrate.
///
/// 1  the first schema.
/// 2  ws became the session's starting directory, resolved. Derived rows are
///    dropped with every cursor, so the next index rebuilds them; kept rows
///    stay and are re-keyed.
pub fn migrate(db: &Connection) -> Result<()> {
    if version(db) >= VERSION {
        return Ok(());
    }
    db.execute_batch("BEGIN IMMEDIATE")?;
    let res = (|| -> Result<()> {
        let have = version(db);
        if have >= VERSION {
            return Ok(());
        }
        db.execute_batch(SCHEMA)?;
        if (1..2).contains(&have) {
            db.execute("DELETE FROM artifacts WHERE kept_at IS NULL", [])?;
            db.execute("DELETE FROM cursors", [])?;
            let rows: Vec<(i64, String)> = db
                .prepare("SELECT id, ws FROM artifacts")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (id, ws) in rows {
                db.execute("UPDATE OR IGNORE artifacts SET ws = ? WHERE id = ?", (wskey(&ws), id))?;
            }
        }
        db.execute("DELETE FROM meta", [])?;
        db.execute("INSERT INTO meta(version) VALUES (?)", [VERSION])?;
        Ok(())
    })();
    match res {
        Ok(()) => {
            db.execute_batch("COMMIT")?;
            Ok(())
        }
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// `write_rows`: upsert each row that has a ws and a locator. Values missing
/// from a row are written as ''.
pub fn write_rows(db: &Connection, rows: &[serde_json::Map<String, serde_json::Value>]) -> Result<()> {
    let mut st = db.prepare_cached(UPSERT)?;
    for r in rows {
        // `r.get(k) or ""`, bound to a TEXT column: a falsy value is '', and
        // anything else is stored as SQLite's text affinity spells it.
        let get = |k: &str| {
            use serde_json::Value;
            match r.get(k) {
                None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
                Some(Value::Bool(true)) => "1".to_string(),
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
                Some(Value::Number(n)) => match (n.as_i64(), n.as_f64()) {
                    (Some(i), _) => i.to_string(),
                    (None, Some(f)) => crew_core::pyjson::float_repr(f),
                    _ => n.to_string(),
                },
                Some(Value::Array(a)) if a.is_empty() => String::new(),
                Some(Value::Object(o)) if o.is_empty() => String::new(),
                Some(v) => v.to_string(),
            }
        };
        if get("ws").is_empty() || get("locator").is_empty() {
            continue;
        }
        let vals: Vec<(String, String)> = FIELDS.iter().map(|k| (format!(":{k}"), get(k))).collect();
        let params: Vec<(&str, &dyn rusqlite::ToSql)> =
            vals.iter().map(|(k, v)| (k.as_str(), v as &dyn rusqlite::ToSql)).collect();
        st.execute(params.as_slice())?;
    }
    Ok(())
}
