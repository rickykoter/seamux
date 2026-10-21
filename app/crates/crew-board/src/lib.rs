//! The crew board in Rust (plan port-board): the board's news, its TypeSafe
//! judgments cache and its cat poses, then the ranking and the intent
//! server as later increments land.
//!
//! Each module with a Python CLI is a `seamux <basename>` tool with the
//! Python's args, stdin, stdout, exit codes and files written, so the board's
//! probes drive either implementation. crew-board-diag, cat_from_swift.py
//! and crew-board's Dock commands are not ported: the family's cutover
//! deletes them with the Dock board.

pub mod cat_poses;
pub mod cmux_cli;
pub mod judgments;
pub mod news;
pub mod pyval;
pub mod rank;
pub mod state;

/// The seamux tools this crate provides, by the Python script's basename.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[
    ("cat_poses", cat_poses::main),
    ("crew-board", state::main),
    ("judgments", judgments::main),
    ("news", news::main),
];
