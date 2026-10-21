//! The index lock: flock on ~/.claude/crew/index.lock, the very file and call
//! artifacts.py uses, so a Python run and a Rust run exclude each other.
//!
//! A run that finds the lock held leaves index.lock.again and exits at once
//! (Busy): the holder may have read this turn's transcript before its last
//! lines landed, so it goes round once more instead of anyone waiting.
//! Backfill waits instead.

use crate::paths::Paths;
use crate::schema::makedirs_0700;
use crate::{Error, Result};
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;

/// Held for the lock; dropping it closes the file, which releases the flock.
pub struct IndexLock(#[allow(dead_code)] File);

fn open_append(p: &str) -> std::io::Result<File> {
    OpenOptions::new().append(true).create(true).open(p)
}

impl IndexLock {
    /// `_lock()`: non-blocking; Busy (after leaving the marker) when held.
    pub fn try_take(p: &Paths) -> Result<IndexLock> {
        makedirs_0700(&p.crew_home)?;
        let f = open_append(&p.lock)?;
        // SAFETY: f's descriptor is open for the duration of the call.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            drop(f);
            let _ = open_append(&p.again);
            return Err(Error::Busy);
        }
        Ok(IndexLock(f))
    }

    /// `index(wait=True)`: block until the lock is free.
    pub fn wait(p: &Paths) -> Result<IndexLock> {
        makedirs_0700(&p.crew_home)?;
        let f = open_append(&p.lock)?;
        loop {
            // SAFETY: as above.
            if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(IndexLock(f));
            }
            let e = std::io::Error::last_os_error();
            if e.raw_os_error() != Some(libc::EINTR) {
                return Err(e.into());
            }
        }
    }
}
