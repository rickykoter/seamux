//! crew's command-line tools, ported from crew/bin. Each is `seamux <name>`
//! with the Python's args, stdin, stdout, exit codes and files written, so
//! crew/tools/cli_probe.py runs either implementation (CREW_IMPL=rust).
//!
//! Output goes through crew-core's `pyjson` and `py`, the family's one
//! Python-compatible writer. The Python stays until the family's cutover.

pub mod frame;
pub mod overlay;
pub mod plugin_root;
mod pyerr;

/// The seamux tools this crate provides, by the Python script's basename.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[
    ("crew-frame", frame::main),
    ("crew-overlay", overlay::main),
    ("crew-plugin-root", plugin_root::main),
];
