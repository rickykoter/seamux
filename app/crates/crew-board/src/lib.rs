//! The crew board in Rust (plan port-board): the ranking (`crew-board`) with
//! the notification log's last hours, the TypeSafe judgments cache, the cat poses, and the intent server
//! (`crew-board-intent`) with the served board and the Wake.
//!
//! Each module with a Python CLI is a `seamux <basename>` tool with the
//! Python's args, stdin, stdout, exit codes and files written, so the board's
//! probes drive either implementation. crew-board-diag and cat_from_swift.py
//! were not ported: the cutover deleted them with the Dock board.
//! crew-board's Dock commands are not ported either: `open` and `usage` open
//! the served pages instead, and the rest point at /board (state.rs).

pub mod act;
pub mod agents;
pub mod ask;
pub mod backend;
pub mod board_feed;
pub mod cmux_cli;
pub mod companion;
pub mod judgments;
pub mod plans;
pub mod proxy;
pub mod pyval;
pub mod rank;
pub mod review;
pub mod routes;
pub mod selftest;
pub mod server;
pub mod settle;
pub mod sprites;
pub mod state;
pub mod tucked;
pub mod usage;
pub mod wake;

/// The seamux tools this crate provides, by the Python script's basename.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[
    ("sprites", sprites::main),
    ("companion", companion::main),
    ("crew-board", state::main),
    ("crew-board-intent", server::main),
    ("judgments", judgments::main),
];
