//! A long-running process notices when an install replaced its binary: it
//! keeps running the code it started with, so it must leave (or re-exec) to
//! pick up the new one. `crew doctor` reads the same signal: the installed
//! binary newer than the process's start.

use std::path::PathBuf;
use std::time::SystemTime;

/// This process's binary, through any symlink (~/.local/bin/seamux points
/// into the app bundle, which an install replaces).
pub fn exe() -> Option<PathBuf> {
    std::env::current_exe().ok().map(|p| std::fs::canonicalize(&p).unwrap_or(p))
}

/// Whether the binary at `path` was written after `since`.
pub fn newer_than(path: &std::path::Path, since: SystemTime) -> bool {
    std::fs::metadata(path).and_then(|m| m.modified()).is_ok_and(|t| t > since)
}

/// Whether an install replaced this process's binary after `since`.
pub fn replaced_since(since: SystemTime) -> bool {
    exe().is_some_and(|p| newer_than(&p, since))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_binary_written_after_the_start_is_newer() {
        let dir = std::env::temp_dir().join(format!("crew-upgrade-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("bin");
        std::fs::write(&bin, "old").unwrap();
        let started = SystemTime::now() + Duration::from_millis(5);
        assert!(!newer_than(&bin, started));
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&bin, "new").unwrap();
        assert!(newer_than(&bin, started));
        assert!(!newer_than(&dir.join("missing"), started));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
