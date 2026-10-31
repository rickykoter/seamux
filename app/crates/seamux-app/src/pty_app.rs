//! The native terminal's commands: attach a page to a local-tmux session
//! through a PTY (seamux_app::pty), stream its bytes over a Channel, and take
//! keys, sizes and the detach back.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use seamux_app::pty::{bell_seen, leave_scroll, scroll_state, send_line_key, target_for, toggle_shell, Pty, Target};
use tauri::ipc::{Channel, InvokeResponseBody};

/// A terminal: its PTY (locked for resizes and closing), its client's pid
/// outside that lock (a detach never waits), and the queue its writer thread
/// takes keys from, one after another, in the order they came.
struct Live {
    pty: Mutex<Pty>,
    pid: u32,
    target: Target,
    keys: Mutex<std::sync::mpsc::Sender<Vec<u8>>>,
}

fn ptys() -> &'static Mutex<HashMap<u32, Arc<Live>>> {
    static P: OnceLock<Mutex<HashMap<u32, Arc<Live>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

static NEXT: AtomicU32 = AtomicU32::new(1);

fn get(id: u32) -> Result<Arc<Live>, String> {
    ptys().lock().unwrap().get(&id).cloned().ok_or_else(|| format!("no terminal {id}"))
}

/// Whether `surface_id` is a cmux client of a local-tmux session, so the page
/// can draw it natively.
#[tauri::command]
pub async fn pty_native(surface_id: String) -> Result<bool, String> {
    // No backend yet is no native pane, not an error.
    tauri::async_runtime::spawn_blocking(move || Ok(target_for(&surface_id).ok().flatten().is_some()))
        .await
        .map_err(|e| e.to_string())?
}

/// Attach to the session behind `surface_id` at cols x rows. Its bytes go to
/// `on_data` as they come; when the client ends, one last JSON message
/// `{"exit": true}` says so. Returns the terminal's id.
#[tauri::command]
pub async fn pty_attach(surface_id: String, cols: u16, rows: u16, on_data: Channel) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = target_for(&surface_id)?.ok_or("this pane is not a local-tmux session")?;
        let pty = Pty::attach(&t, cols, rows)?;
        let mut r = pty.reader()?;
        let mut w = pty.writer()?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let pid = pty.pid();
        // Keys are written by one thread, in order; a full PTY makes it wait,
        // not the app. It ends when the terminal goes (the queue closes).
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            use std::io::Write;
            while let Ok(b) = rx.recv() {
                if w.write_all(&b).is_err() {
                    break;
                }
            }
        });
        ptys().lock().unwrap().insert(id, Arc::new(Live { pty: Mutex::new(pty), pid, target: t, keys: Mutex::new(tx) }));
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match r.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                            break; // the page went away
                        }
                    }
                }
            }
            let _ = on_data.send(InvokeResponseBody::Json(r#"{"exit":true}"#.into()));
            ptys().lock().unwrap().remove(&id);
        });
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keys: text as xterm.js gives it, or raw bytes (mouse reports in X10 form).
/// A sync command (they run one after another, in the order they came) that
/// only queues them: the terminal's writer thread writes them, in order.
#[tauri::command]
pub fn pty_write(id: u32, data: Option<String>, raw: Option<Vec<u8>>) -> Result<(), String> {
    let live = get(id)?;
    let mut b = data.map(String::into_bytes).unwrap_or_default();
    b.extend(raw.unwrap_or_default());
    let sent = live.keys.lock().unwrap().send(b);
    sent.map_err(|_| "the terminal is closing".to_string())
}

/// Out of tmux's copy mode, before the first key after a wheel scroll: in
/// that mode tmux would take the keys instead of Claude.
#[tauri::command]
pub async fn pty_leave_scroll(id: u32) -> Result<(), String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || leave_scroll(&live.target)).await.map_err(|e| e.to_string())?
}

/// A line-editing key (C-a, C-e, C-u) for the pane, past any tmux prefix.
#[tauri::command]
pub async fn pty_line_key(id: u32, key: String) -> Result<(), String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || send_line_key(&live.target, &key)).await.map_err(|e| e.to_string())?
}

/// Show or hide the companion shell under Claude. Returns whether it shows.
#[tauri::command]
pub async fn pty_shell(id: u32) -> Result<bool, String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || toggle_shell(&live.target)).await.map_err(|e| e.to_string())?
}

/// The pane was looked at (attached on screen, or focused): its bell is heard.
#[tauri::command]
pub async fn pty_seen(id: u32) -> Result<(), String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || bell_seen(&live.target)).await.map_err(|e| e.to_string())?
}

/// How far tmux's copy mode has the pane scrolled back:
/// `{"scrolled": bool, "up": lines, "history": lines}`.
#[tauri::command]
pub async fn pty_scroll(id: u32) -> Result<serde_json::Value, String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (on, up, history) = scroll_state(&live.target).unwrap_or((false, 0, 0));
        serde_json::json!({ "scrolled": on, "up": up, "history": history })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Of `paths` (path-like text in the pane), each as the existing absolute
/// path it names from the pane's folder, or null.
#[tauri::command]
pub async fn pty_paths(id: u32, paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    if paths.len() > 200 {
        return Err("too many paths".into());
    }
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || crate::pane_app::existing(&live.target, &paths)).await.map_err(|e| e.to_string())
}

/// The cmux workspace the terminal's session belongs to, if cmux says.
#[tauri::command]
pub async fn pty_workspace(id: u32) -> Result<Option<String>, String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || crate::pane_app::workspace(&live.target)).await.map_err(|e| e.to_string())
}

/// Every terminal a page left behind: called when a page starts, so a
/// reloaded window does not keep its old tmux clients (and their sizes).
#[tauri::command]
pub async fn pty_reset() {
    let all: Vec<Arc<Live>> = ptys().lock().unwrap().drain().map(|(_, l)| l).collect();
    for l in &all {
        // SAFETY: kill(2) on our own children's pids; each is reaped below.
        unsafe {
            libc::kill(l.pid as libc::pid_t, libc::SIGKILL);
        }
    }
    let _ = tauri::async_runtime::spawn_blocking(move || {
        for l in all {
            l.pty.lock().unwrap().close();
        }
    })
    .await;
}

#[tauri::command]
pub async fn pty_resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || live.pty.lock().unwrap().resize(cols, rows))
        .await
        .map_err(|e| e.to_string())?
}

/// Detach: the client ends, the session lives on in tmux. The map's lock is
/// let go before anything waits, and the client is signalled by pid, so a
/// write stuck under the PTY's lock fails instead of holding this up. (At
/// quit nothing is needed: the PTYs close with the process and each client
/// hangs up.)
#[tauri::command]
pub async fn pty_detach(id: u32) {
    let Some(live) = ptys().lock().unwrap().remove(&id) else { return };
    // SAFETY: kill(2) on our own child's pid; it is reaped below.
    unsafe {
        libc::kill(live.pid as libc::pid_t, libc::SIGKILL);
    }
    let _ = tauri::async_runtime::spawn_blocking(move || live.pty.lock().unwrap().close()).await;
}

/// Start Claude as a native session in a workspace (resuming `resume` when
/// given), on the app's backend: returns the new pane's id.
#[tauri::command]
pub async fn native_session(workspace_id: String, cwd: String, resume: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let claude = seamux_app::pty::claude_line(resume.as_deref())?;
        seamux_app::backend::get()?.start_session(&workspace_id, &cwd, &claude)
    })
        .await
        .map_err(|e| e.to_string())?
}
