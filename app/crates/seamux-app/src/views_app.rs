//! The views' feed inside the app: a thread that rebuilds the decisions,
//! Wake rows and history every couple of seconds and sends `views:frame`
//! when they change, and the gap filler fed from the wall's frames.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crew_core::history;
use seamux_app::views::{Feed, GapFill, Inputs, ViewsFrame};
use seamux_app::wall::Frame;
use tauri::{AppHandle, Emitter, Runtime};

/// How often the feed is rebuilt. Files are cheap to read; deep-plan
/// status is cached inside the feed.
const EVERY: Duration = Duration::from_secs(2);

static LAST: Mutex<Option<ViewsFrame>> = Mutex::new(None);
/// Wakes the feed before its next tick: a mute or tuck shows at once.
static NUDGE: OnceLock<Mutex<std::sync::mpsc::Sender<()>>> = OnceLock::new();

/// Rebuild the views frame now rather than on the next tick.
pub fn nudge() {
    if let Some(tx) = NUDGE.get() {
        let _ = tx.lock().unwrap().send(());
    }
}
static GAPS: OnceLock<Arc<GapFill>> = OnceLock::new();

fn gaps() -> &'static Arc<GapFill> {
    GAPS.get_or_init(|| Arc::new(GapFill::default()))
}

/// The wall's poller calls this with each frame it sends.
pub fn observe(f: &Frame) {
    gaps().observe(&f.tiles, history::now_ms());
}

pub fn start<R: Runtime>(app: AppHandle<R>) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let _ = NUDGE.set(Mutex::new(tx));
    std::thread::spawn(move || {
        let feed = Feed::new(Inputs::live());
        // The first frame should already carry the plans and the Wake.
        feed.prime(Duration::from_secs(20));
        let _ = history::prune(feed.history_dir(), history::now_ms(), history::KEEP_DAYS);
        let mut sent: Option<ViewsFrame> = None;
        // The panes last seen: the wall forgets its frame when an emit fails
        // (so it resends), and decisions must not vanish meanwhile.
        let mut tiles = Vec::new();
        let mut pruned = std::time::Instant::now();
        loop {
            let now = history::now_ms();
            gaps().flush(feed.history_dir(), now);
            if pruned.elapsed() >= Duration::from_secs(3600) {
                let _ = history::prune(feed.history_dir(), now, history::KEEP_DAYS);
                pruned = std::time::Instant::now();
            }
            if let Some(f) = crate::wall_app::last_frame() {
                tiles = f.tiles;
            }
            // The window moves in whole minutes: an open span's end and the
            // window's start would otherwise change every build, and every
            // frame would go out (and every view redraw) every two seconds.
            let frame = feed.build(&tiles, now - now % 60_000);
            if sent.as_ref() != Some(&frame) {
                *LAST.lock().unwrap() = Some(frame.clone());
                match app.emit("views:frame", &frame) {
                    Ok(()) => sent = Some(frame),
                    Err(e) => eprintln!("seamux: views frame not sent: {e}"),
                }
            }
            // The next tick, or sooner when a command nudges.
            if rx.recv_timeout(EVERY).is_ok() {
                while rx.try_recv().is_ok() {}
            }
        }
    });
}

/// The last views frame, for a page that loads after it was sent.
#[tauri::command]
pub fn views_frame() -> Option<ViewsFrame> {
    LAST.lock().unwrap().clone()
}
