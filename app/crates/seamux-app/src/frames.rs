//! Whole frames for a native terminal. tmux, told the client has the `sync`
//! feature, wraps each redraw in `ESC [?2026h` … `ESC [?2026l`; a macOS PTY
//! hands it over in reads of at most 1024 bytes, so one of Claude's frames
//! comes in many pieces. The gate holds a frame's pieces until its end
//! marker, so the page writes it to xterm.js at once and never draws half.
//! Bytes outside a frame pass straight through.
//!
//! A frame that never ends (a lost marker, a program that stopped halfway)
//! goes out at its deadline: the gate can delay a frame, never keep it.

use std::time::{Duration, Instant};

const MARK: &[u8] = b"\x1b[?2026";
/// The longest a frame is held for its end.
pub const FRAME_WAIT: Duration = Duration::from_millis(50);
/// The longest a trailing piece of what may be a begin marker is held.
pub const TAIL_WAIT: Duration = Duration::from_millis(4);
/// A frame held past this size goes out as it is.
const FRAME_MAX: usize = 4 << 20;

#[derive(Default)]
pub struct FrameGate {
    buf: Vec<u8>,
    open: bool,
    held: Option<Instant>,
}

impl FrameGate {
    /// Take bytes read at `now`: the bytes that may go out now (maybe none).
    pub fn feed(&mut self, data: &[u8], now: Instant) -> Vec<u8> {
        self.buf.extend_from_slice(data);
        // Everything before `ready` goes out: the start of the first frame
        // not yet ended, or all of it. A held frame starts with its begin
        // marker, so looking again from the start finds it, already open.
        let mut ready = if self.open { 0 } else { self.buf.len() };
        let mut i = 0;
        while let Some(k) = find(&self.buf[i..], MARK) {
            let p = i + k;
            let Some(&last) = self.buf.get(p + MARK.len()) else {
                // The marker's last byte is still to come.
                if !self.open {
                    ready = p;
                }
                break;
            };
            match last {
                b'h' if !self.open => {
                    self.open = true;
                    ready = p;
                }
                b'l' if self.open => {
                    self.open = false;
                    ready = self.buf.len();
                }
                _ => {}
            }
            i = p + 1;
        }
        if !self.open {
            // A tail that may be the start of a begin marker waits for the rest.
            let from = self.buf.len().saturating_sub(MARK.len());
            if let Some(e) = (from..self.buf.len()).find(|&e| self.buf[e] == 0x1b && MARK.starts_with(&self.buf[e..])) {
                ready = ready.min(e);
            }
        } else if self.buf.len() > FRAME_MAX {
            return self.flush();
        }
        let out: Vec<u8> = self.buf.drain(..ready).collect();
        if self.buf.is_empty() {
            self.held = None;
        } else if !out.is_empty() || self.held.is_none() {
            // What is held now started being held now.
            self.held = Some(now);
        }
        out
    }

    /// When the held bytes must go out, if any are held.
    pub fn deadline(&self) -> Option<Instant> {
        self.held.map(|t| t + if self.open { FRAME_WAIT } else { TAIL_WAIT })
    }

    /// Everything held, at once: its deadline passed, or the output ended.
    pub fn flush(&mut self) -> Vec<u8> {
        self.open = false;
        self.held = None;
        std::mem::take(&mut self.buf)
    }
}

/// Read `r` until it ends, handing `send` what to write. With `whole`, a
/// FrameGate holds each frame until it ends (or its deadline passes);
/// without, every read goes out as it came. Stops early when `send` says
/// the page went away (returns false).
pub fn pump(mut r: std::fs::File, whole: bool, mut send: impl FnMut(Vec<u8>) -> bool) {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    let mut buf = vec![0u8; 64 * 1024];
    let mut gate = FrameGate::default();
    loop {
        if let Some(due) = gate.deadline() {
            let wait = due.saturating_duration_since(Instant::now());
            let mut fd = libc::pollfd { fd: r.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: poll(2) on one valid pollfd for at most `wait`.
            let n = unsafe { libc::poll(&mut fd, 1, wait.as_millis().min(i32::MAX as u128) as i32) };
            if n == 0 {
                // Nothing more came in time: what is held goes out as it is.
                let out = gate.flush();
                if !out.is_empty() && !send(out) {
                    return;
                }
                continue;
            }
        }
        let n = match r.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let out = if whole { gate.feed(&buf[..n], Instant::now()) } else { buf[..n].to_vec() };
        if !out.is_empty() && !send(out) {
            return;
        }
    }
    let rest = gate.flush();
    if !rest.is_empty() {
        send(rest);
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    const B: &[u8] = b"\x1b[?2026h";
    const E: &[u8] = b"\x1b[?2026l";

    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    #[test]
    fn bytes_outside_a_frame_pass_straight_through() {
        let mut g = FrameGate::default();
        let now = Instant::now();
        assert_eq!(g.feed(b"hello", now), b"hello");
        assert_eq!(g.deadline(), None);
    }

    #[test]
    fn a_frame_in_pieces_goes_out_whole_at_its_end() {
        let mut g = FrameGate::default();
        let now = Instant::now();
        assert_eq!(g.feed(&cat(&[b"before", B, b"row 1 "]), now), b"before");
        assert!(g.deadline().is_some(), "a frame is held");
        assert_eq!(g.feed(b"row 2 ", now), b"");
        assert_eq!(g.feed(&cat(&[b"row 3", E, b"after"]), now), cat(&[B, b"row 1 row 2 row 3", E, b"after"]));
        assert_eq!(g.deadline(), None);
    }

    #[test]
    fn a_marker_split_across_reads_is_still_found() {
        let mut g = FrameGate::default();
        let now = Instant::now();
        // The begin marker split after its ESC, then in its middle.
        assert_eq!(g.feed(b"x\x1b", now), b"x");
        assert_eq!(g.feed(b"[?20", now), b"");
        assert_eq!(g.feed(b"26hframe\x1b[?20", now), b"");
        assert_eq!(g.feed(b"26l", now), cat(&[B, b"frame", E]));
    }

    #[test]
    fn two_frames_in_one_read_go_out_each_whole() {
        let mut g = FrameGate::default();
        let now = Instant::now();
        let both = cat(&[B, b"one", E, b"mid", B, b"tw"]);
        assert_eq!(g.feed(&both, now), cat(&[B, b"one", E, b"mid"]));
        assert_eq!(g.feed(&cat(&[b"o", E]), now), cat(&[B, b"two", E]));
    }

    #[test]
    fn an_escape_that_is_not_a_marker_waits_only_a_moment() {
        let mut g = FrameGate::default();
        let now = Instant::now();
        assert_eq!(g.feed(b"a\x1b[", now), b"a");
        assert_eq!(g.deadline(), Some(now + TAIL_WAIT));
        assert_eq!(g.feed(b"1mb", now), b"\x1b[1mb");
        // Another escape sequence, whole in one read, passes at once.
        assert_eq!(g.feed(b"\x1b[0m", now), b"\x1b[0m");
    }

    /// Through a real pipe: a frame written in pieces arrives as one write,
    /// and one whose end never comes arrives at its deadline.
    #[test]
    fn pump_sends_a_frame_once_and_a_stuck_one_at_its_deadline() {
        use std::io::Write;
        use std::os::fd::FromRawFd;
        let mut fds = [0; 2];
        // SAFETY: pipe(2) fills two descriptors, each owned by one File below.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (r, mut w) = unsafe { (std::fs::File::from_raw_fd(fds[0]), std::fs::File::from_raw_fd(fds[1])) };
        let (tx, rx) = std::sync::mpsc::channel::<(Vec<u8>, Instant)>();
        let t = std::thread::spawn(move || pump(r, true, |b| tx.send((b, Instant::now())).is_ok()));
        for part in [B, b"row 1 ", b"row 2", E] {
            w.write_all(part).unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        let (got, _) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(got, cat(&[B, b"row 1 row 2", E]), "the frame came in one piece");
        let sent = Instant::now();
        w.write_all(&cat(&[B, b"stuck"])).unwrap();
        let (got, at) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(got, cat(&[B, b"stuck"]));
        assert!(at.duration_since(sent) >= FRAME_WAIT - Duration::from_millis(5), "held until its deadline");
        drop(w);
        t.join().unwrap();
    }

    #[test]
    fn a_frame_that_never_ends_goes_out_at_its_deadline() {
        let mut g = FrameGate::default();
        let now = Instant::now();
        assert_eq!(g.feed(&cat(&[B, b"stuck"]), now), b"");
        assert_eq!(g.deadline(), Some(now + FRAME_WAIT));
        assert_eq!(g.flush(), cat(&[B, b"stuck"]));
        // Its late end, alone, passes through.
        assert_eq!(g.feed(E, now), E);
    }
}
