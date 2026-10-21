//! `seamux asked-hook <size>`: crew/hooks/asked.sh in Rust. The turn-end
//! follow-up that promotes "turn complete" to "waiting on you" when the
//! turn really ended on a question.
//!
//! ```text
//! seamux asked-hook <transcript-size-at-stop>  < stop-payload
//! ```
//!
//! Spawned detached by the stop event. It asks `asked judge` (TypeSafe), drops
//! the answer if the transcript moved on since the stop, records the ranking
//! extras through judgments --record, and on "asked" sets the lane, the
//! phase, the marker the next tool use clears, and the banner.

use crate::events::{self, line, Hook};
use crate::spawn;

pub fn main(args: &[String]) -> i32 {
    use std::io::Write;
    let Some((cmux, ws, state)) = events::guard() else { return 0 };
    let mut h = Hook::new(cmux, ws, state, events::read_payload());
    let size_at_stop = args.first().cloned().unwrap_or_default();
    let log = h.state.join("asked.log");

    let judge = spawn::tool("asked", &["judge"]);
    let Some((rc, out)) = spawn::run(&judge.argv, Some(&h.payload), Some(&log)) else { return 0 };
    let out = events::strip_newlines(&out).to_string();
    // 0 = asked, 1 = not asked: both carry a judgment worth caching.
    if rc != 0 && rc != 1 {
        return 0;
    }

    let transcript = h.json("transcript_path");
    if !transcript.is_empty() && !size_at_stop.is_empty() {
        let now = std::fs::metadata(&transcript).ok().filter(|m| m.is_file()).map(|m| m.len().to_string()).unwrap_or_default();
        if now != size_at_stop {
            return 0; // the conversation moved on: the answer is stale
        }
    }

    let (first, question, extras) = (line(&out, 1), line(&out, 2), line(&out, 3));
    let stamp = crate::pyval::stamp();
    let hms = format!("{}:{}:{}", &stamp[9..11], &stamp[11..13], &stamp[13..15]);
    // `${extras:-{\}}`: inside double quotes the backslash stays.
    let shown = if extras.is_empty() { "{\\}".to_string() } else { extras.clone() };
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&log) {
        let _ = writeln!(f, "{hms} {} p={first} extras={shown}", h.ws);
    }

    // The board's ranking cache, keyed by cwd. Best-effort.
    if !extras.is_empty() {
        let cwd = h.cwd();
        let size = if size_at_stop.is_empty() { "0".to_string() } else { size_at_stop.clone() };
        let t = spawn::tool("judgments", &["--record", &cwd, &size, &first]);
        let _ = spawn::run(&t.argv, Some(&extras), Some(&log));
    }

    if rc != 0 {
        return 0;
    }
    h.lane_set("needs-attention");
    h.phase("waiting on you");
    let _ = std::fs::write(h.state.join(format!("asked-{}", h.ws)), "");
    let body = if question.is_empty() { "Claude is waiting on you".to_string() } else { question };
    h.notify("crew:blocked", &body);
    0
}
