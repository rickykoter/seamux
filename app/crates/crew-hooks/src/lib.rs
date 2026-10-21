//! crew's Claude-side tools in Rust: the settings writers now; the status
//! line, notification triage and the hook events as they port.
//!
//! Each tool is `seamux <name>`, named for the Python script it replaces,
//! with that script's args, stdin, stdout, exit codes and files written.
//! The Python stays until the family's cutover; hooks_probe runs either.

pub mod merge_settings;
pub mod options;
pub mod pyval;
pub mod unicode;

/// The seamux tools this crate provides, by the Python script's basename.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[
    ("merge_settings", merge_settings::main),
    ("options", options::main),
];
