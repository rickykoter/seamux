//! The overlay shell: one frameless, always-on-top window that a global hotkey
//! shows and hides on every Space, a tray icon, and where the unported pages
//! live (crew-board-intent's own origin, read from its port file).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// The hotkey, as the global-shortcut plugin spells it and as the tray shows it.
pub const HOTKEY: &str = "Control+Alt+Space";
pub const HOTKEY_LABEL: &str = "⌃⌥Space";

/// Where crew-board-intent writes its port (crew/board/crew-board-intent:60).
fn port_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".cache/cmux-crew/board-intent.port"))
}

/// The intent server's origin, and whether it answered /health just now.
#[derive(Debug, Serialize, PartialEq)]
pub struct IntentServer {
    pub origin: Option<String>,
    pub up: bool,
    /// Why it is down, for the tab to say.
    pub reason: Option<String>,
}

pub fn parse_port(text: &str) -> Option<u16> {
    text.trim().parse::<u16>().ok().filter(|p| *p > 0)
}

/// A response's status line and Server header, from GET `path` on loopback.
#[derive(Debug, PartialEq)]
pub struct Head {
    pub code: u16,
    pub server: String,
}

/// How long /health may take: it answers at once when the server is up.
pub const HEALTH_WAIT: Duration = Duration::from_millis(800);
/// How long a page may take to start answering: /usage runs ccusage first
/// (about 1.3 s here), so a page gets far longer than /health.
pub const PAGE_WAIT: Duration = Duration::from_secs(20);

/// GET `path` on loopback, waiting at most `wait` for an answer, reading until
/// the headers end (or 8 KB), so a status line split across reads still parses.
pub fn http_head(port: u16, path: &str, wait: Duration) -> Result<Head, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(wait)).ok();
    // One write: write! on a stream sends each formatted piece separately.
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 8192 {
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            // A read that timed out reports WouldBlock (os error 35 on macOS).
            Err(e) if buf.is_empty() && matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                return Err(format!("no answer within {} s", wait.as_secs_f32()));
            }
            Err(e) if buf.is_empty() => return Err(e.to_string()),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let status = lines.next().unwrap_or("");
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| format!("answered {status:?}"))?;
    let server = lines
        .take_while(|l| !l.is_empty())
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("server")).map(|(_, v)| v.trim().to_string()))
        .unwrap_or_default();
    Ok(Head { code, server })
}

/// Both servers (the Python crew-board-intent and port-board's Rust one) name
/// themselves this way; anything else on the port is not the intent server.
pub fn is_intent_server(head: &Head) -> bool {
    head.server.starts_with("crew-board-intent")
}

/// A page's status, but only from the intent server itself.
pub fn http_status(port: u16, path: &str, wait: Duration) -> Result<u16, String> {
    let head = http_head(port, path, wait)?;
    if !is_intent_server(&head) {
        return Err(format!("port {port} is held by {:?}, not crew-board-intent", head.server));
    }
    Ok(head.code)
}

/// /health answering 200 means up.
pub fn health(port: u16) -> Result<(), String> {
    match http_status(port, "/health", HEALTH_WAIT)? {
        200 => Ok(()),
        code => Err(format!("/health answered {code}")),
    }
}

pub fn intent_server_at(port_text: Option<String>) -> IntentServer {
    let Some(text) = port_text else {
        return IntentServer { origin: None, up: false, reason: Some("no port file: crew-board-intent has not started".into()) };
    };
    let Some(port) = parse_port(&text) else {
        return IntentServer { origin: None, up: false, reason: Some(format!("port file holds {:?}", text.trim())) };
    };
    let origin = Some(format!("http://127.0.0.1:{port}"));
    match health(port) {
        Ok(()) => IntentServer { origin, up: true, reason: None },
        Err(e) => IntentServer { origin, up: false, reason: Some(format!("not answering on {port}: {e}")) },
    }
}

#[tauri::command]
pub async fn intent_server() -> IntentServer {
    tauri::async_runtime::spawn_blocking(|| {
        intent_server_at(port_file().and_then(|p| std::fs::read_to_string(p).ok()))
    })
    .await
    .unwrap_or(IntentServer { origin: None, up: false, reason: Some("check failed".into()) })
}

/// Whether the intent server serves `path` (a tab asks before it frames a page
/// that may not exist yet, such as /board before port-board lands it).
#[tauri::command]
pub async fn intent_page(path: String) -> Result<u16, String> {
    if !path.starts_with('/') || path.contains(char::is_whitespace) {
        return Err(format!("not a path: {path:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let text = port_file().and_then(|p| std::fs::read_to_string(p).ok()).ok_or("no port file")?;
        let port = parse_port(&text).ok_or("bad port file")?;
        http_status(port, &path, PAGE_WAIT)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn hide_overlay<R: Runtime>(window: WebviewWindow<R>) {
    hide(&window);
}

/// Make the window a non-activating panel that joins every Space, including
/// another app's full-screen one. An ordinary NSWindow from an accessory app
/// stays off a full-screen Space even with FullScreenAuxiliary set (seen with
/// cmux full screen: isOnActiveSpace stayed false after orderFrontRegardless);
/// Spotlight-style overlays are NSPanels with the non-activating style.
#[cfg(target_os = "macos")]
fn join_full_screen_spaces<R: Runtime>(w: &WebviewWindow<R>) {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{sel, ClassType};
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};

    /// Like tao's TaoWindow: key and main status follow its `focusable` ivar,
    /// so tao's set_focusable keeps working after the swap.
    extern "C-unwind" fn focusable(this: &AnyObject, _: Sel) -> Bool {
        let cls = this.class();
        match cls.instance_variable(c"focusable") {
            // SAFETY: the ivar is declared Bool on this class.
            Some(ivar) => unsafe { *ivar.load::<Bool>(this) },
            None => Bool::YES,
        }
    }

    /// NSPanel, but carrying TaoWindow's `focusable` ivar at the same offset
    /// (tao reads and writes it by name) and able to take keyboard focus
    /// without a title bar, which the wall's reply box needs.
    fn panel_class() -> &'static AnyClass {
        static CLASS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
        let ptr = *CLASS.get_or_init(|| {
            let name = c"SeamuxOverlayPanel";
            let cls = AnyClass::get(name).unwrap_or_else(|| {
                let mut b = ClassBuilder::new(name, NSPanel::class()).expect("class name is free");
                b.add_ivar::<Bool>(c"focusable");
                // SAFETY: the signatures match canBecomeKeyWindow/MainWindow.
                unsafe {
                    b.add_method(sel!(canBecomeKeyWindow), focusable as extern "C-unwind" fn(_, _) -> _);
                    b.add_method(sel!(canBecomeMainWindow), focusable as extern "C-unwind" fn(_, _) -> _);
                }
                b.register()
            });
            cls as *const AnyClass as usize
        });
        // SAFETY: a registered class lives for the whole process.
        unsafe { &*(ptr as *const AnyClass) }
    }

    /// The swap is sound only if the instance's storage fits the new class:
    /// same size, and `focusable` at the same offset as on the current class.
    fn layout_matches(current: &AnyClass, panel: &AnyClass) -> bool {
        let off = |c: &AnyClass| c.instance_variable(c"focusable").map(|i| i.offset());
        current.instance_size() == panel.instance_size() && off(current).is_some() && off(current) == off(panel)
    }

    let Ok(ptr) = w.ns_window() else { return };
    // SAFETY: Tauri hands back this window's live NSWindow, and setup runs on
    // the main thread.
    let obj: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
    let panel = panel_class();
    if layout_matches(obj.class(), panel) {
        // SAFETY: checked above that the instance's layout is the panel
        // class's, so tao's ivar stays where tao reads it. This is the
        // swap tauri-nspanel does.
        unsafe {
            objc2::ffi::object_setClass(ptr as *mut AnyObject, panel);
        }
    } else {
        eprintln!("seamux: window class layout differs from the panel's; staying a plain window (no full-screen Spaces)");
    }
    let win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    win.setStyleMask(win.styleMask() | NSWindowStyleMask::NonactivatingPanel);
    win.setCollectionBehavior(
        win.collectionBehavior()
            | NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    );
}

/// Whether the window is on the Space in front. A visible window can sit on
/// another Space (the desktop, while a full-screen app is in front); the
/// hotkey must bring it here then, not hide it.
#[cfg(target_os = "macos")]
fn on_active_space<R: Runtime>(w: &WebviewWindow<R>) -> bool {
    let Ok(ptr) = w.ns_window() else { return true };
    // SAFETY: as in join_full_screen_spaces; the shortcut handler runs on the
    // main thread.
    let win: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
    win.isOnActiveSpace()
}

#[cfg(not(target_os = "macos"))]
fn on_active_space<R: Runtime>(_: &WebviewWindow<R>) -> bool {
    true
}

fn toggle<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        if visible && on_active_space(&w) {
            hide(&w);
        } else {
            if visible {
                // Order it out so macOS re-places it on the Space in front.
                hide(&w);
            }
            show(&w);
        }
    }
}

/// Tauri's hide does not take the window off screen once its class is the
/// panel subclass (seen: hide ran, the window stayed on screen), so order it
/// out directly as well.
fn hide<R: Runtime>(w: &WebviewWindow<R>) {
    let _ = w.hide();
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = w.ns_window() {
        // SAFETY: as in join_full_screen_spaces; callers run on the main thread.
        let win: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
        win.orderOut(None);
    }
}

fn show<R: Runtime>(w: &WebviewWindow<R>) {
    // Minimized with the yellow button: showing alone would leave it in the Dock.
    if w.is_minimized().unwrap_or(false) {
        let _ = w.unminimize();
    }
    let _ = w.show();
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = w.ns_window() {
        // SAFETY: as in join_full_screen_spaces; callers run on the main thread.
        let win: &objc2_app_kit::NSWindow = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
        // An accessory app is not active when the hotkey fires; this places
        // the window in front on the Space in front anyway.
        win.orderFrontRegardless();
    }
    let _ = w.set_focus();
}

/// Window behaviour, the hotkey and the tray. Called once from setup.
pub fn install<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
    // An accessory app has no Dock icon and may draw over other apps'
    // full-screen Spaces, which a regular app's window cannot.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_visible_on_all_workspaces(true);
        let _ = w.set_always_on_top(true);
        #[cfg(target_os = "macos")]
        join_full_screen_spaces(&w);
        // The window starts hidden (tauri.conf.json) so its first placement
        // already carries the Space flags; macOS reads them only on placement.
        show(&w);
    }

    let shortcut: Shortcut = HOTKEY.parse().expect("HOTKEY parses");
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, s, event| {
                if *s == shortcut && event.state() == ShortcutState::Pressed {
                    toggle(app);
                }
            })
            .build(),
    )?;
    let hotkey_label = match app.global_shortcut().register(shortcut) {
        Ok(()) => format!("Hotkey: {HOTKEY_LABEL}"),
        Err(e) => {
            // Another app holds the hotkey; the tray is then the way back in,
            // and says so.
            eprintln!("seamux: could not register {HOTKEY}: {e}");
            format!("Hotkey {HOTKEY_LABEL} is taken by another app")
        }
    };

    let show_item = MenuItemBuilder::with_id("show", "Show seamux").build(app)?;
    let key_item = MenuItemBuilder::with_id("hotkey", hotkey_label).enabled(false).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit seamux").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show_item, &key_item]).separator().item(&quit_item).build()?;
    // Closing the window (Cmd+W, or a close from the system) hides it: the
    // app lives in the tray, and the hotkey needs the window to exist.
    if let Some(w) = app.get_webview_window("main") {
        let w2 = w.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                hide(&w2);
            }
        });
    }
    let mut tray = TrayIconBuilder::with_id("seamux").tooltip("seamux").menu(&menu).on_menu_event(|app, e| {
        match e.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    show(&w);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        }
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn port_file_text() {
        assert_eq!(parse_port("7345\n"), Some(7345));
        assert_eq!(parse_port(" 0 "), None);
        assert_eq!(parse_port("x"), None);
    }

    #[test]
    fn no_port_file_says_so() {
        let s = intent_server_at(None);
        assert!(!s.up && s.origin.is_none());
        assert!(s.reason.unwrap().contains("no port file"));
    }

    #[test]
    fn down_server_keeps_its_origin() {
        // Port 1 is privileged and unused on a dev machine, so the connect is
        // refused (a freed ephemeral port could be taken by a parallel test).
        let port = 1u16;
        let s = intent_server_at(Some(port.to_string()));
        assert_eq!(s.origin, Some(format!("http://127.0.0.1:{port}")));
        assert!(!s.up);
    }

    #[test]
    fn up_server_answers_health() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 256];
            let n = c.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /health "));
            c.write_all(b"HTTP/1.0 200 OK\r\nServer: crew-board-intent Python/3.14\r\n\r\nok").unwrap();
        });
        let s = intent_server_at(Some(format!("{port}\n")));
        t.join().unwrap();
        assert!(s.up, "{:?}", s.reason);
    }

    #[test]
    fn status_code_of_a_page() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 256];
            let _ = c.read(&mut buf).unwrap();
            c.write_all(b"HTTP/1.0 404 Not Found\r\nServer: crew-board-intent\r\n\r\n").unwrap();
        });
        assert_eq!(http_status(port, "/board", PAGE_WAIT), Ok(404));
        t.join().unwrap();
    }

    fn serve_once(reply: Vec<&'static [u8]>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut buf = [0u8; 256];
            let _ = c.read(&mut buf);
            for part in reply {
                c.write_all(part).unwrap();
                c.flush().unwrap();
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        port
    }

    #[test]
    fn another_server_on_the_port_is_refused() {
        let port = serve_once(vec![b"HTTP/1.0 200 OK\r\nServer: SimpleHTTP/0.6\r\n\r\n"]);
        let err = http_status(port, "/health", HEALTH_WAIT).unwrap_err();
        assert!(err.contains("not crew-board-intent"), "{err}");
    }

    #[test]
    fn a_status_line_split_across_reads_parses() {
        let port = serve_once(vec![b"HTTP/1.0 ", b"200 OK\r\nServer: crew-board-intent\r\n\r\n"]);
        assert_eq!(http_status(port, "/health", HEALTH_WAIT), Ok(200));
    }

    /// /usage runs ccusage before it answers (about 1.3 s): a page gets the
    /// long wait, and a slow answer is reported as such, not as os error 35.
    #[test]
    fn a_slow_page_still_answers_and_a_timeout_says_so() {
        let slow = |delay: u64| {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let (mut c, _) = l.accept().unwrap();
                let mut buf = [0u8; 256];
                let _ = c.read(&mut buf);
                std::thread::sleep(Duration::from_millis(delay));
                let _ = c.write_all(b"HTTP/1.0 200 OK\r\nServer: crew-board-intent\r\n\r\n");
            });
            port
        };
        assert_eq!(http_status(slow(1500), "/usage", PAGE_WAIT), Ok(200));
        let err = http_status(slow(1500), "/usage", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("no answer within"), "{err}");
    }

    #[test]
    fn hotkey_parses() {
        let _: Shortcut = HOTKEY.parse().unwrap();
    }
}
