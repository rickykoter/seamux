//! The Artifact Log's store, ported from crew/board/artifacts.py: what each
//! workspace's sessions made, in one SQLite file, ~/.claude/crew/artifacts.db.
//!
//! The Python and this crate open the same file with the same schema, so
//! either can read what the other wrote. The public functions mirror the
//! Python module's one for one (search, workspaces, row, count, keep,
//! keep_all, wskey, is_temp, ...), and rows serialize with the store's own
//! column names, so the board's Wake routes port without translation.
//!
//! Paths are read from the environment on every call, the way the Python
//! reads them at import: CREW_DURABLE_DIR (the store's directory; never
//! CREW_HOME, which crew_impl points at the checkout's crew/),
//! CREW_SCRATCH_BASE and CREW_TEMP_ROOTS exist for the probes only.

pub mod cli;
pub mod keep;
pub mod paths;
pub mod read;
pub mod schema;

pub use keep::{keep, keep_all, kept_dir, KeepResult};
pub use paths::{is_temp, norm, realpath, wskey, Paths};
pub use read::{count, fts_query, row, search, workspaces, Row, WsCount};
pub use schema::{connect, VERSION};

/// What `seamux` runs: `seamux crew-artifacts ...`.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[("crew-artifacts", cli::main)];

/// Every error the store can raise. `Busy` is the Python's `Busy`: another
/// index run holds the lock.
#[derive(Debug)]
pub enum Error {
    Db(rusqlite::Error),
    Io(std::io::Error),
    Busy,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Db(e) => write!(f, "{e}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Busy => write!(f, "another index run holds the lock"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Db(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// `iso(ts)`: epoch seconds as the transcript's own UTC form,
/// `YYYY-MM-DDTHH:MM:SS.mmmZ`, milliseconds truncated, so strings sort.
pub fn iso(ts: f64) -> String {
    let secs = ts.floor();
    let ms = ((ts % 1.0) * 1000.0) as i64;
    let s = secs as i64;
    let days = s.div_euclid(86400);
    let rem = s.rem_euclid(86400);
    let (y, m, d) = crew_core::py::civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms
    )
}

/// `str.isspace()` for one character: Unicode White_Space plus the four
/// information separators Python also counts (U+001C..U+001F).
pub fn py_isspace(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `s.split()`: runs of Python whitespace, no empty pieces.
pub fn py_split(s: &str) -> Vec<&str> {
    s.split(py_isspace).filter(|w| !w.is_empty()).collect()
}

/// `s[:n]` by characters, as Python slices a str.
pub fn py_prefix(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_python() {
        // python3 -c "import artifacts as A; print(A.iso(1600000000.1239))"
        assert_eq!(iso(1600000000.1239), "2020-09-13T12:26:40.123Z");
        assert_eq!(iso(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(4070908800.999), "2099-01-01T00:00:00.999Z");
    }

    #[test]
    fn python_whitespace_and_slices() {
        assert_eq!(py_split(" a\u{1c}b\u{3000}c \n"), vec!["a", "b", "c"]);
        assert_eq!(py_prefix("héllo", 2), "hé");
        assert_eq!(py_prefix("hi", 5), "hi");
    }
}
