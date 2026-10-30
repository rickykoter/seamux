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

/// One look at the native panes, kept at most 5 seconds (a tmux call per
/// session and a process table); `fresh` looks now, for the moment before
/// something is typed into a pane.
type NativeLook = (std::collections::HashSet<String>, std::collections::HashMap<String, seamux_app::pty::PaneSignals>);
fn native_look(fresh: bool) -> NativeLook {
    static CACHE: std::sync::Mutex<Option<(std::time::Instant, NativeLook)>> = std::sync::Mutex::new(None);
    let mut c = CACHE.lock().unwrap();
    if !fresh {
        if let Some((at, look)) = c.as_ref() {
            if at.elapsed() < Duration::from_secs(5) {
                return look.clone();
            }
        }
    }
    let look = seamux_app::pty::native_now();
    *c = Some((std::time::Instant::now(), look.clone()));
    look
}

/// The surfaces holding a native Claude.
fn native_surfaces(fresh: bool) -> std::collections::HashSet<String> {
    native_look(fresh).0
}

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
    // cmux reports a session's state as `unknown` when it gets no lifecycle
    // hooks from it: a session whose process is gone (cmux restarted under
    // it) is a terminal now; one that runs takes the last hook state crew
    // recorded for its pane.
    let cache: std::sync::Mutex<Option<(std::time::Instant, std::collections::HashMap<String, String>)>> = Default::default();
    wall.set_state_hint(Box::new(move || {
        let mut c = cache.lock().unwrap();
        if let Some((at, m)) = c.as_ref() {
            if at.elapsed() < Duration::from_secs(5) {
                return m.clone();
            }
        }
        let since = crew_core::history::now_ms().saturating_sub(6 * 3600 * 1000);
        let mut m: std::collections::HashMap<String, String> =
            crew_core::history::read_since(&crew_core::history::dir(), since)
                .into_iter()
                .filter(|e| !e.surface.is_empty())
                .map(|e| (e.surface.to_uppercase(), e.state))
                .collect();
        if let Some(records) = crew_core::workspaces::agent_sessions() {
            // A native pane's recorded process is the old one; its Claude is
            // in tmux, so it is not gone.
            let native = native_surfaces(false);
            for s in seamux_app::sessions::gone_surfaces(&records).into_iter().filter(|s| !native.contains(s)) {
                m.insert(s, "shell".into());
            }
        }
        *c = Some((std::time::Instant::now(), m.clone()));
        m
    }));
    // Each pane's own status (crew's pane files and the session store), over
    // cmux's: read at most every 3 seconds, one store read each time.
    let truth: std::sync::Mutex<Option<(std::time::Instant, std::collections::HashMap<String, String>)>> = Default::default();
    wall.set_truth_probe(Box::new(move || {
        let mut c = truth.lock().unwrap();
        if let Some((at, m)) = c.as_ref() {
            if at.elapsed() < Duration::from_secs(3) {
                return m.clone();
            }
        }
        let m = crew_core::status::live_states_now(&crew_board::state::state_dir()).unwrap_or_default();
        *c = Some((std::time::Instant::now(), m.clone()));
        m
    }));
    wall.set_native_probe(Box::new(|| native_surfaces(false)));
    wall.set_signals_probe(Box::new(|| native_look(false).1));
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
    // A native Claude's cmux tab takes its name (worktree · topic) once
    // Claude has given the conversation a topic: the Dock and the Wall
    // read the tab's title.
    let named: std::sync::Mutex<std::collections::HashMap<String, seamux_app::wall::Asked>> = Default::default();
    wall.run(rx, move |f: Frame| {
        crate::views_app::observe(&f);
        let renames = seamux_app::wall::tab_renames(&f.tiles, &mut named.lock().unwrap(), crew_core::history::now_ms());
        if !renames.is_empty() {
            std::thread::spawn(move || {
                // A failed rename is asked again after RENAME_RETRY_MS; say why here.
                let c = match cmux::Cmux::connect() {
                    Ok(c) => c,
                    Err(e) => return eprintln!("seamux: tab names not set: {e}"),
                };
                for (surface, ws, name) in renames {
                    match c.cli(&["rename-tab", "--surface", &surface, "--workspace", &ws, &name]) {
                        Ok(out) if out.ok() => {}
                        Ok(out) => eprintln!("seamux: rename-tab {surface}: {}", out.stderr.trim()),
                        Err(e) => eprintln!("seamux: rename-tab {surface}: {e}"),
                    }
                }
            });
        }
        match app.emit("wall:frame", f) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("seamux: wall frame not sent: {e}");
                false
            }
        }
    });
}

/// The wall's last frame, for the views feed.
pub fn last_frame() -> Option<Frame> {
    WALL.get().and_then(|w| w.last())
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

/// The Claude sessions of a workspace, for the picker.
#[tauri::command]
pub async fn workspace_sessions(workspace: String) -> Result<Vec<seamux_app::sessions::SessionRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let records = crew_core::workspaces::agent_sessions().ok_or("cmux did not list its sessions")?;
        Ok(seamux_app::sessions::rows(&records, &workspace))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The dead sessions Desk's cleanup would bring back, one per terminal.
#[tauri::command]
pub async fn desk_cleanup_plan() -> Result<Vec<seamux_app::sessions::Revival>, String> {
    let w = wall()?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let records = crew_core::workspaces::agent_sessions().ok_or("cmux did not list its sessions")?;
        let native = native_surfaces(true);
        let panes: Vec<(String, String)> = w
            .last()
            .map(|f| f.tiles)
            .unwrap_or_default()
            .into_iter()
            .filter(|t| !native.contains(&t.surface.to_uppercase()))
            .map(|t| (t.surface, t.workspace))
            .collect();
        Ok(seamux_app::sessions::revivals(&records, &panes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resume each chosen session in its pane, one after another: starting a
/// dozen Claudes at once would stall the machine. One line per session: Ok
/// when it was typed, else why not. Each is checked fresh against cmux's
/// records, so a pane whose Claude came back meanwhile is left alone.
#[tauri::command]
pub async fn desk_cleanup_run(picks: Vec<(String, String, String)>) -> Result<Vec<Result<(), String>>, String> {
    let w = wall()?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for (surface, session, cwd) in picks {
            let records = crew_core::workspaces::agent_sessions().ok_or("cmux did not list its sessions")?;
            out.push(if seamux_app::sessions::claude_alive(&records, &surface) || native_surfaces(true).contains(&surface.to_uppercase()) {
                Err("Claude is running there now".to_string())
            } else {
                w.resume(&surface, &session, &cwd, false)
            });
            std::thread::sleep(Duration::from_millis(600));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resume (in a shell) or swap to (in an idle Claude) a session in a pane.
#[tauri::command]
pub async fn session_resume(surface_id: String, session_id: String, cwd: String) -> Result<(), String> {
    let w = wall()?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Asked fresh: the answer decides whether `/resume` or a shell command is typed.
        let records = crew_core::workspaces::agent_sessions().ok_or("cmux did not list its sessions")?;
        let alive = seamux_app::sessions::claude_alive(&records, &surface_id) || native_surfaces(true).contains(&surface_id.to_uppercase());
        w.resume(&surface_id, &session_id, &cwd, alive)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move the pane's running Claude to a native session (see pty::move_native).
/// Returns the new pane's surface id.
#[tauri::command]
pub async fn move_native(surface_id: String) -> Result<String, String> {
    let w = wall()?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (state, ws) = w.state_of(&surface_id)?;
        if state == "working" {
            return Err("Claude is mid-turn here; move it when it is idle".into());
        }
        let records = crew_core::workspaces::agent_sessions().ok_or("cmux did not list its sessions")?;
        let run = seamux_app::pty::running_on(&records, &surface_id).ok_or("no running Claude in this pane")?;
        seamux_app::pty::move_native(&ws, &surface_id, &run)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wall_jump(surface_id: String) -> Result<(), String> {
    let w = wall()?.clone();
    // A jump goes to the pane in cmux: it may come forward.
    crate::shell::allow_cmux_focus();
    let r = tauri::async_runtime::spawn_blocking(move || w.jump(&surface_id)).await.map_err(|e| e.to_string())?;
    // Counted from when cmux has been asked, however long that took.
    crate::shell::allow_cmux_focus();
    r
}
