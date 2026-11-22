//! The Bosun's loops: timed prompts from bosun.json's `loops`, queued for
//! the supervisor to type in. bosun-routines fills this in; the supervisor
//! already calls `tick` once per poll, so nothing else needs to change for
//! a loop to run.

use std::path::Path;

/// Queue whatever loop is due at `now_secs` (local time from
/// launch::local_day_hour). It only enqueues (queue::enqueue with a
/// `loop:<id>` source); the supervisor's idle drain types the items.
pub fn tick(_dir: &Path, _now_secs: i64) {}
