//! The read side: search, workspaces, row and count, as artifacts.py has them.

use crate::paths::wskey;
use crate::schema::connect;
use crate::{py_split, Result};
use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

/// One row of the artifacts table, every column. `to_json` gives the
/// Python's `dict(row)`: the store's column names, in table order.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: i64,
    pub ws: String,
    pub repo: String,
    pub kind: String,
    pub title: String,
    pub locator: String,
    pub path: String,
    pub url: String,
    pub sha: String,
    pub was_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub session_id: String,
    pub branch: String,
    pub prompt: String,
    pub source: String,
    pub kept_at: Option<String>,
}

/// A text column as the Python reads it, whatever SQLite stored there.
fn text(r: &rusqlite::Row, i: usize) -> rusqlite::Result<String> {
    Ok(match r.get_ref(i)? {
        ValueRef::Null => String::new(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(f) => crew_core::pyjson::float_repr(f),
        ValueRef::Text(t) | ValueRef::Blob(t) => String::from_utf8_lossy(t).into_owned(),
    })
}

impl Row {
    /// From a `SELECT *` (or `SELECT a.*`) row.
    pub fn from_sql(r: &rusqlite::Row) -> rusqlite::Result<Row> {
        Ok(Row {
            id: r.get(0)?,
            ws: text(r, 1)?,
            repo: text(r, 2)?,
            kind: text(r, 3)?,
            title: text(r, 4)?,
            locator: text(r, 5)?,
            path: text(r, 6)?,
            url: text(r, 7)?,
            sha: text(r, 8)?,
            was_path: text(r, 9)?,
            created_at: text(r, 10)?,
            updated_at: text(r, 11)?,
            session_id: text(r, 12)?,
            branch: text(r, 13)?,
            prompt: text(r, 14)?,
            source: text(r, 15)?,
            kept_at: match r.get_ref(16)? {
                ValueRef::Null => None,
                _ => Some(text(r, 16)?),
            },
        })
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), self.id.into());
        for (k, v) in [
            ("ws", &self.ws),
            ("repo", &self.repo),
            ("kind", &self.kind),
            ("title", &self.title),
            ("locator", &self.locator),
            ("path", &self.path),
            ("url", &self.url),
            ("sha", &self.sha),
            ("was_path", &self.was_path),
            ("created_at", &self.created_at),
            ("updated_at", &self.updated_at),
            ("session_id", &self.session_id),
            ("branch", &self.branch),
            ("prompt", &self.prompt),
            ("source", &self.source),
        ] {
            m.insert(k.into(), Value::String(v.clone()));
        }
        m.insert("kept_at".into(), self.kept_at.clone().map(Value::String).unwrap_or(Value::Null));
        Value::Object(m)
    }
}

/// One workspace in the store: its key, its row count, its newest row's time.
#[derive(Debug, Clone, PartialEq)]
pub struct WsCount {
    pub ws: String,
    pub n: i64,
    pub last: Option<String>,
}

impl WsCount {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ws".into(), Value::String(self.ws.clone()));
        m.insert("n".into(), self.n.into());
        m.insert("last".into(), self.last.clone().map(Value::String).unwrap_or(Value::Null));
        Value::Object(m)
    }
}

/// User text to an FTS5 query: each word a quoted prefix term, all
/// required. Quotes inside a word are doubled, so nothing is syntax.
pub fn fts_query(q: &str) -> String {
    py_split(q)
        .iter()
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Rows newest first. `q` is matched over title, path, URL and prompt; an
/// empty `ws` or `kind` filters nothing, as in the Python.
pub fn search(q: &str, ws: Option<&str>, kind: Option<&str>, limit: usize) -> Result<Vec<Row>> {
    let db = connect()?;
    let mut wheres: Vec<&str> = Vec::new();
    let mut args: Vec<String> = Vec::new();
    if let Some(w) = ws.filter(|w| !w.is_empty()) {
        wheres.push("a.ws = ?");
        args.push(wskey(w));
    }
    if let Some(k) = kind.filter(|k| !k.is_empty()) {
        wheres.push("a.kind = ?");
        args.push(k.to_string());
    }
    let fq = fts_query(q);
    let mut sql;
    if !fq.is_empty() {
        sql = "SELECT a.* FROM artifacts_fts f JOIN artifacts a ON a.id = f.rowid \
               WHERE artifacts_fts MATCH ?"
            .to_string();
        args.insert(0, fq);
        if !wheres.is_empty() {
            sql += " AND ";
            sql += &wheres.join(" AND ");
        }
    } else {
        sql = "SELECT a.* FROM artifacts a".to_string();
        if !wheres.is_empty() {
            sql += " WHERE ";
            sql += &wheres.join(" AND ");
        }
    }
    sql += " ORDER BY a.created_at DESC, a.id DESC LIMIT ?";
    let mut params: Vec<Box<dyn rusqlite::ToSql>> =
        args.into_iter().map(|a| Box::new(a) as Box<dyn rusqlite::ToSql>).collect();
    params.push(Box::new(limit as i64));
    let mut st = db.prepare(&sql)?;
    let rows = st
        .query_map(rusqlite::params_from_iter(params.iter().map(|b| b.as_ref())), Row::from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn count(ws: &str) -> Result<i64> {
    let db = connect()?;
    Ok(db.query_row("SELECT COUNT(*) FROM artifacts WHERE ws = ?", [wskey(ws)], |r| r.get(0))?)
}

/// Every workspace in the store, with counts, the most recent first.
pub fn workspaces() -> Result<Vec<WsCount>> {
    let db = connect()?;
    let mut st = db.prepare(
        "SELECT ws, COUNT(*) AS n, MAX(created_at) AS last FROM artifacts \
         GROUP BY ws ORDER BY last DESC",
    )?;
    let v = st
        .query_map([], |r| {
            Ok(WsCount {
                ws: text(r, 0)?,
                n: r.get(1)?,
                last: match r.get_ref(2)? {
                    ValueRef::Null => None,
                    _ => Some(text(r, 2)?),
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(v)
}

/// One row by id.
pub fn row(id: i64) -> Result<Option<Row>> {
    let db = connect()?;
    row_in(&db, id)
}

pub(crate) fn row_in(db: &rusqlite::Connection, id: i64) -> Result<Option<Row>> {
    use rusqlite::OptionalExtension;
    Ok(db
        .query_row("SELECT * FROM artifacts WHERE id = ?", [id], Row::from_sql)
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_query_quotes_everything() {
        assert_eq!(fts_query("  scratch notes "), "\"scratch\"* \"notes\"*");
        assert_eq!(fts_query("\"oops* OR (NEAR"), "\"\"\"oops*\"* \"OR\"* \"(NEAR\"*");
        assert_eq!(fts_query(""), "");
    }
}
