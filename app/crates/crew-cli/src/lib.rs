//! crew's command-line tools, ported from crew/bin. Each is `seamux <name>`
//! with the Python's args, stdin, stdout, exit codes and files written, so
//! crew/tools/cli_probe.py runs either implementation (CREW_IMPL=rust).
//!
//! Output goes through crew-core's `pyjson` and `py`, the family's one
//! Python-compatible writer. The Python stays until the family's cutover.

pub mod color;
pub mod digest;
pub mod feed;
pub mod frame;
pub mod listen;
mod md5;
pub mod overlay;
pub mod plugin_root;
mod proc;
mod pyerr;
mod pypath;
mod pyval;
mod sibling;
pub mod sync;

/// The seamux tools this crate provides, by the Python script's basename.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[
    ("crew-color", color::main),
    ("crew-digest", digest::main),
    ("crew-feed", feed::main),
    ("crew-frame", frame::main),
    ("crew-listen", listen::main),
    ("crew-overlay", overlay::main),
    ("crew-plugin-root", plugin_root::main),
    ("crew-sync", sync::main),
];
