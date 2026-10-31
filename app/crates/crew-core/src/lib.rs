//! crew's shared modules, ported from the Python every port calls into:
//! pricing, costs, typesafe, workspaces, cachefacts, families, dp_engine and
//! asked, plus where crew's files are (`home`) and the Python-compatible
//! output (`pyjson`, `py`) every port prints with.
//!
//! Each module with a Python CLI is a `seamux <basename>` tool (`TOOLS`) with
//! the Python's args, stdin, stdout, exit codes and files written. The Python
//! stays until the family's cutover; the probes run either implementation.

pub mod asked;
pub mod backend;
pub mod cachefacts;
pub mod costs;
pub mod dp_engine;
pub mod families;
pub mod history;
pub mod home;
pub mod ident;
pub mod native;
pub mod pricing;
pub mod py;
pub mod pyjson;
pub mod status;
pub mod typesafe;
pub mod upgrade;
pub mod workspaces;
pub mod worktree;

pub use home::{crew_home, crew_local};

/// The seamux tools this crate provides, by the Python script's basename.
pub const TOOLS: &[(&str, fn(&[String]) -> i32)] = &[
    ("asked", asked::main),
    ("cachefacts", cachefacts::main),
    ("costs", costs::main),
    ("crew-native", native::main),
    ("families", families::main),
    ("pricing", pricing::main),
    ("typesafe", typesafe::main),
    ("workspaces", workspaces::main),
];
