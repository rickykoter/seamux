//! The intent server's backend, picked once (crew_core::backend::pick): the
//! app starts the server with SEAMUX_BACKEND set, so the two agree.

use std::sync::OnceLock;

use crew_core::backend::{Backend, Kind};

static PICKED: OnceLock<(Kind, Option<Box<dyn Backend>>)> = OnceLock::new();

fn picked() -> &'static (Kind, Option<Box<dyn Backend>>) {
    PICKED.get_or_init(|| {
        let (k, b) = crew_core::backend::pick();
        (k, b.ok())
    })
}

/// Which backend this server reads.
pub fn kind() -> Kind {
    picked().0
}

/// The tmux backend, when that is this server's: cmux is read through
/// cmux_cli as before.
pub fn tmux() -> Option<&'static dyn Backend> {
    match picked() {
        (Kind::Tmux, Some(b)) => Some(b.as_ref()),
        _ => None,
    }
}
