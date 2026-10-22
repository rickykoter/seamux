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
static GAPS: OnceLock<Arc<GapFill>> = OnceLock::new();

fn gaps() -> &'static Arc<GapFill> {
    GAPS.get_or_init(|| Arc::new(GapFill::default()))
}

/// The wall's poller calls this with each frame it sends.
pub fn observe(f: &Frame) {
    gaps().observe(&f.tiles, history::now_ms());
}

pub fn start<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let feed = Feed::new(Inputs::live());
        // The first frame should already carry the plans and the Wake.
        feed.prime(Duration::from_secs(20));
        let _ = history::prune(feed.history_dir(), history::now_ms(), history::KEEP_DAYS);
        let mut sent: Option<ViewsFrame> = None;
        // The panes last seen: the wall forgets its frame when an emit fails
        // (so it resends), and decisions must not vanish meanwhile.
        let mut tiles = Vec::new();
        loop {
            let now = history::now_ms();
            gaps().flush(feed.history_dir(), now);
            if let Some(f) = crate::wall_app::last_frame() {
                tiles = f.tiles;
            }
            let frame = feed.build(&tiles, now);
            if sent.as_ref() != Some(&frame) {
                *LAST.lock().unwrap() = Some(frame.clone());
                match app.emit("views:frame", &frame) {
                    Ok(()) => sent = Some(frame),
                    Err(e) => eprintln!("seamux: views frame not sent: {e}"),
                }
            }
            std::thread::sleep(EVERY);
        }
    });
}

/// The last views frame, for a page that loads after it was sent.
#[tauri::command]
pub fn views_frame() -> Option<ViewsFrame> {
    LAST.lock().unwrap().clone()
}
