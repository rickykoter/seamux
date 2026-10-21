//! Run the wall's poller against live cmux for a few seconds and print, per
//! frame, when it went out and the last line of every pane whose text
//! matches a pattern. With a pane printing `date +"CLOCK %H:%M:%S"` each
//! second, the gap between the two times is the wall's lag.
//!
//!     cargo run -p seamux-app --example wall_trace -- CLOCK 8

use std::sync::{mpsc, Arc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use seamux_app::wall::{Source, Wall};

fn clock() -> String {
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    // Local time without a date crate: ask the system once for the offset.
    let offset: i64 = std::process::Command::new("date")
        .arg("+%z")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|z| {
            let z = z.trim();
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let h: i64 = z.get(1..3)?.parse().ok()?;
            let m: i64 = z.get(3..5)?.parse().ok()?;
            Some(sign * (h * 3600 + m * 60))
        })
        .unwrap_or(0);
    let secs = (ms / 1000) as i64 + offset;
    format!("{:02}:{:02}:{:02}.{:03}", (secs / 3600) % 24, (secs / 60) % 60, secs % 60, ms % 1000)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let pattern = args.next().unwrap_or_else(|| "CLOCK".into());
    let secs: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(8);
    let pool: Vec<Arc<dyn Source>> = (0..4).map(|_| Arc::new(cmux::Cmux::connect().expect("cmux")) as Arc<dyn Source>).collect();
    let wall = Arc::new(Wall::new(pool, Duration::from_secs(1)));
    let (tx, rx) = mpsc::channel::<String>();
    let w = wall.clone();
    let runner = std::thread::spawn(move || {
        w.run(rx, |f| {
            let n = f.tiles.len();
            for t in f.tiles.iter().filter(|t| t.lines.iter().any(|l| l.contains(&pattern))) {
                let last = t.lines.iter().rev().find(|l| l.contains(&pattern)).cloned().unwrap_or_default();
                println!("frame at {}  tiles={n}  {last}", clock());
            }
            true
        })
    });
    std::thread::sleep(Duration::from_secs(secs));
    drop(tx);
    runner.join().unwrap();
}
