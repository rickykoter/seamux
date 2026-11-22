//! The seamux app's library side: what the binary and its integration tests
//! share. The window and its commands live in main.rs and shell.rs.

pub mod actions;
pub mod build_stamp;
pub mod backend;
// Radar's reading lives in crew-core, so the seamux CLI runs it too
// (`seamux bosun context radar`); these paths stay for the app's callers.
pub use crew_core::codeowners;
pub mod frames;
pub mod ghostty;
pub mod pane;
pub mod pty;
pub use crew_core::radar;
pub mod reclaim;
pub mod review;
pub mod sessions;
pub mod tmux_feed;
pub mod tuck;
pub mod views;
pub mod wall;
