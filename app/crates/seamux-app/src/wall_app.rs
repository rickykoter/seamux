//! The wall inside the app: the poller and event threads, and the page's
//! commands. The wall's logic is in the library (`seamux_app::wall`) so its
//! integration tests can drive it with a fake cmux.

use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use seamux_app::wall::{Frame, Source, Wall};
use tauri::{AppHandle, Emitter, Runtime};

/// Parallel readers. Eight terminals read in ~50ms over four connections.
const READERS: usize = 4;

static WALL: OnceLock<Arc<Wall>> = OnceLock::new();

/// Connect the pool and start polling. When cmux is down the wall stays
/// empty; the page reports cmux_status's named error.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    let mut pool: Vec<Arc<dyn Source>> = Vec::new();
    for _ in 0..READERS {
        match cmux::Cmux::connect() {
            Ok(c) => pool.push(Arc::new(c)),
            Err(e) => {
                eprintln!("seamux: wall reader could not connect: {e}");
                break;
            }
        }
    }
    if pool.is_empty() {
        return;
    }
    let wall = Arc::new(Wall::new(pool, Duration::from_secs(1)));
    let _ = WALL.set(wall.clone());
    let (tx, rx) = mpsc::channel::<String>();

    // Events that name a terminal on the wall pull its read forward. The
    // stream reconnects on its own; it ends only when the app does.
    {
        let wall = wall.clone();
        std::thread::spawn(move || {
            let Ok(c) = cmux::Cmux::connect() else { return };
            let opts = cmux::EventOptions { names: Vec::new(), cursor_file: None, reconnect: true };
            let Ok(stream) = c.events(opts) else { return };
            for ev in stream.flatten() {
                if let Some(s) = ev.get("surface_id").and_then(|v| v.as_str()) {
                    if wall.knows(s) && tx.send(s.to_string()).is_err() {
                        return;
                    }
                }
            }
        });
    }

    std::thread::spawn(move || {
        wall.run(rx, move |f: Frame| {
            if let Err(e) = app.emit("wall:frame", f) {
                eprintln!("seamux: wall frame not sent: {e}");
            }
        })
    });
}

fn wall() -> Result<&'static Arc<Wall>, String> {
    WALL.get().ok_or_else(|| "the wall is not connected to cmux".to_string())
}

/// The last frame, for a page that loads after it was sent.
#[tauri::command]
pub fn wall_frame() -> Option<Frame> {
    WALL.get().and_then(|w| w.last())
}

#[tauri::command]
pub async fn wall_reply(surface_id: String, text: String) -> Result<(), String> {
    let w = wall()?.clone();
    tauri::async_runtime::spawn_blocking(move || w.reply(&surface_id, &text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wall_jump(surface_id: String) -> Result<(), String> {
    let w = wall()?.clone();
    tauri::async_runtime::spawn_blocking(move || w.jump(&surface_id)).await.map_err(|e| e.to_string())?
}
