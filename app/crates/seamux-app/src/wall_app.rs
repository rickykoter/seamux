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

/// Connect the pool and start polling. Until cmux answers, the wall stays
/// empty and the page shows cmux_status's named error.
pub fn start<R: Runtime>(app: AppHandle<R>) {
    // cmux may start after the app (a login item, or a cmux restart): keep
    // trying, with a growing pause, until the readers connect.
    std::thread::spawn(move || {
        let mut pause = Duration::from_secs(1);
        let pool = loop {
            let pool: Vec<Arc<dyn Source>> = (0..READERS)
                .map_while(|_| cmux::Cmux::connect().ok().map(|c| Arc::new(c) as Arc<dyn Source>))
                .collect();
            if !pool.is_empty() {
                break pool;
            }
            std::thread::sleep(pause);
            pause = (pause * 2).min(Duration::from_secs(30));
        };
        run_wall(app, pool);
    });
}

fn run_wall<R: Runtime>(app: AppHandle<R>, pool: Vec<Arc<dyn Source>>) {
    // Reply and jump get a connection of their own, so a click never waits
    // behind a tick's reads.
    let actions: Arc<dyn Source> = match cmux::Cmux::connect() {
        Ok(c) => Arc::new(c),
        Err(_) => pool[0].clone(),
    };
    let wall = Arc::new(Wall::with_actions(pool, actions, Duration::from_secs(1)));
    let _ = WALL.set(wall.clone());
    let (tx, rx) = mpsc::channel::<String>();

    // Events that name a terminal on the wall pull its read forward. The
    // stream reconnects by itself; when it cannot start or ends, try again
    // with a growing pause, so pull-forward comes back after cmux restarts.
    {
        let wall = wall.clone();
        std::thread::spawn(move || {
            let mut pause = Duration::from_secs(1);
            loop {
                match cmux::Cmux::connect().and_then(|c| {
                    let opts = cmux::EventOptions { names: Vec::new(), cursor_file: None, reconnect: true };
                    c.events(opts)
                }) {
                    Ok(stream) => {
                        let mut errors = 0u32;
                        for ev in stream {
                            match ev {
                                Ok(ev) => {
                                    errors = 0;
                                    pause = Duration::from_secs(1);
                                    if let Some(s) = ev.get("surface_id").and_then(|v| v.as_str()) {
                                        if wall.knows(s) && tx.send(s.to_string()).is_err() {
                                            return; // the poller is gone
                                        }
                                    }
                                }
                                Err(e) => {
                                    errors += 1;
                                    if errors == 1 {
                                        eprintln!("seamux: wall event stream: {e}");
                                    }
                                    if errors >= 20 {
                                        break; // a stream that only fails: start over
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => eprintln!("seamux: wall events unavailable, retrying in {pause:?}: {e}"),
                }
                std::thread::sleep(pause);
                pause = (pause * 2).min(Duration::from_secs(60));
            }
        });
    }

    // run_wall is already on its own thread; poll here.
    wall.run(rx, move |f: Frame| match app.emit("wall:frame", f) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("seamux: wall frame not sent: {e}");
            false
        }
    });
}

fn wall() -> Result<&'static Arc<Wall>, String> {
    WALL.get().ok_or_else(|| "the wall is not connected to cmux yet".to_string())
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
