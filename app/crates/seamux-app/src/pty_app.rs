//! The native terminal's commands: attach a page to a local-tmux session
//! through a PTY (seamux_app::pty), stream its bytes over a Channel, and take
//! keys, sizes and the detach back.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use seamux_app::pty::{start_native, target_for, Pty};
use tauri::ipc::{Channel, InvokeResponseBody};

/// A terminal: its PTY (locked for writes and resizes) and its client's pid,
/// outside that lock, so a detach never waits on a write that is stuck.
struct Live {
    pty: Mutex<Pty>,
    pid: u32,
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
    tauri::async_runtime::spawn_blocking(move || target_for(&surface_id).map(|t| t.is_some()))
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
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let pid = pty.pid();
        ptys().lock().unwrap().insert(id, Arc::new(Live { pty: Mutex::new(pty), pid }));
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
/// Off the main thread: a write to a full PTY waits.
#[tauri::command]
pub async fn pty_write(id: u32, data: Option<String>, raw: Option<Vec<u8>>) -> Result<(), String> {
    let live = get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut p = live.pty.lock().unwrap();
        if let Some(d) = data {
            p.write(d.as_bytes())?;
        }
        if let Some(b) = raw {
            p.write(&b)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
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
/// given): returns the new cmux pane's surface id.
#[tauri::command]
pub async fn native_session(workspace_id: String, cwd: String, resume: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || start_native(&workspace_id, &cwd, resume.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}
