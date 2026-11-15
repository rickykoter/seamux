//! What is running: the running app writes the commit it was built from
//! (build.rs's SEAMUX_BUILD_SHA) to app-build.json in crew's state folder at
//! start, so a land recipe can wait until the app that runs is the merge
//! (plan landing). `seamux --version` names the binary on disk; this names
//! the process, which outlives an install until the app restarts.
//!
//!   $XDG_CACHE_HOME/cmux-crew/app-build.json
//!   { "sha": "<40 hex>[-dirty]" | "unknown", "version": "0.3.0", "pid": 123, "at": <epoch ms> }

use serde_json::{json, Value};
use std::path::Path;

/// The commit this build came from.
pub const SHA: &str = env!("SEAMUX_BUILD_SHA");

pub fn stamp(pid: u32, at_ms: u64) -> Value {
    json!({"sha": SHA, "version": env!("CARGO_PKG_VERSION"), "pid": pid, "at": at_ms})
}

/// Write the stamp into `dir`, whole (a temp file moved into place). A
/// failure is not the app's: a landing then waits and times out, and says so.
pub fn write(dir: &Path) {
    write_with(dir, &stamp(std::process::id(), crew_core::history::now_ms()));
}

fn write_with(dir: &Path, v: &Value) {
    let _ = std::fs::create_dir_all(dir);
    let p = dir.join("app-build.json");
    let tmp = dir.join(format!(".app-build.json.{}", std::process::id()));
    if std::fs::write(&tmp, format!("{v}\n")).is_ok() && std::fs::rename(&tmp, &p).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stamp_names_this_build_and_is_written_whole() {
        assert!(SHA == "unknown" || SHA.len() >= 40, "{SHA}");
        let d = std::env::temp_dir().join(format!("build-stamp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        write_with(&d, &stamp(42, 7));
        let v: Value = serde_json::from_str(&std::fs::read_to_string(d.join("app-build.json")).unwrap()).unwrap();
        assert_eq!((v["sha"].as_str(), v["pid"].as_u64(), v["at"].as_u64()), (Some(SHA), Some(42), Some(7)));
        assert!(std::fs::read_dir(&d).unwrap().count() == 1, "no temp file left");
        let _ = std::fs::remove_dir_all(&d);
    }
}
