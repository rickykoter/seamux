//! Where crew's files are.
//!
//! The Python finds its siblings relative to its own file (`crew/hooks/..`).
//! A Rust binary has no such anchor, so the crew home is resolved once, for
//! every port: CREW_HOME, else the live tree at ~/.config/cmux/crew. The
//! probes set CREW_HOME to the checkout's crew/ (crew_impl.env does it).

use std::path::PathBuf;

use crate::py::{env_or, home};

/// The crew tree: CREW_HOME, else ~/.config/cmux/crew.
pub fn crew_home() -> PathBuf {
    env_or("CREW_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config/cmux/crew"))
}

/// This machine's own crew settings: CREW_LOCAL, else ~/.config/cmux/crew-local.
pub fn crew_local() -> PathBuf {
    env_or("CREW_LOCAL").map(PathBuf::from).unwrap_or_else(|| home().join(".config/cmux/crew-local"))
}

/// ~/.cache/cmux-crew, as costs, pricing and cachefacts spell it (HOME, not
/// XDG_CACHE_HOME: those modules never read XDG, and the files are shared).
pub fn home_cache() -> PathBuf {
    home().join(".cache/cmux-crew")
}

/// $XDG_CACHE_HOME/cmux-crew, as workspaces.py spells it.
pub fn xdg_cache() -> PathBuf {
    env_or("XDG_CACHE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".cache")).join("cmux-crew")
}
