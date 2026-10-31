//! The seamux app's library side: what the binary and its integration tests
//! share. The window and its commands live in main.rs and shell.rs.

pub mod actions;
pub mod backend;
pub mod ghostty;
pub mod pane;
pub mod pty;
pub mod reclaim;
pub mod review;
pub mod sessions;
pub mod tuck;
pub mod views;
pub mod wall;
