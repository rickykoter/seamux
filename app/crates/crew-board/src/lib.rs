//! The crew board in Rust (plan port-board): the ranking (`crew-board`), its
//! news, the TypeSafe judgments cache, the cat poses, and the intent server
//! (`crew-board-intent`) with the served board and the Wake.
//!
//! Each module with a Python CLI is a `seamux <basename>` tool with the
//! Python's args, stdin, stdout, exit codes and files written, so the board's
//! probes drive either implementation. crew-board-diag, cat_from_swift.py
//! and crew-board's Dock commands are not ported: the family's cutover
//! deletes them with the Dock board.

pub mod act;
pub mod ask;
pub mod board_feed;
pub mod cat_poses;
pub mod cmux_cli;
pub mod companion;
pub mod judgments;
pub mod news;
pub mod plans;
pub mod proxy;
pub mod pyval;
pub mod rank;
pub mod review;
pub mod routes;
pub mod selftest;
pub mod server;
pub mod state;
pub mod tucked;
pub mod usage;
pub mod wake;

/// The seamux tools this crate provides, by the Python script's basename.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[
    ("cat_poses", cat_poses::main),
    ("companion", companion::main),
    ("crew-board", state::main),
    ("crew-board-intent", server::main),
    ("judgments", judgments::main),
    ("news", news::main),
];
