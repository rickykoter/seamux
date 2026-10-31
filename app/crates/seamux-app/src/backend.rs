//! The app's backend, picked when the app starts (crew_core::backend):
//! SEAMUX_BACKEND, else cmux when its socket answers, else tmux.
//!
//! A pick that opened a backend is kept for the life of the process. A pick
//! that could not open one is not: the next call picks again, so a backend
//! that comes up later is still found.

use std::sync::OnceLock;

use crew_core::backend::{Backend, Kind};

static PICKED: OnceLock<(Kind, &'static dyn Backend)> = OnceLock::new();

fn picked() -> Result<&'static (Kind, &'static dyn Backend), (Kind, String)> {
    if let Some(p) = PICKED.get() {
        return Ok(p);
    }
    let (kind, b) = crew_core::backend::pick();
    match b {
        // Leaked once: the backend lives as long as the app.
        Ok(b) => Ok(PICKED.get_or_init(|| (kind, Box::leak(b)))),
        Err(e) => Err((kind, e)),
    }
}

/// Which backend the app runs on (or would, when it could not open one).
pub fn kind() -> Kind {
    match picked() {
        Ok((k, _)) => *k,
        Err((k, _)) => k,
    }
}

/// The app's backend, or why there is none yet.
pub fn get() -> Result<&'static dyn Backend, String> {
    picked().map(|(_, b)| *b).map_err(|(_, e)| e)
}
