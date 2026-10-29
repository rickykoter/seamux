//! A live terminal in the app: a cmux pane's screen as cmux renders it
//! (`terminal.replay`'s render grid: styled spans, cursor, theme), and raw
//! keys back to it (`terminal.input`). A mirror of the pane cmux runs, not a
//! second terminal: nothing is relaunched, and the pane keeps its own size.

use std::sync::OnceLock;

use serde_json::{json, Value};

static CLIENT: OnceLock<Option<cmux::Cmux>> = OnceLock::new();

/// One socket client for every frame: a fresh connect per frame would cost
/// more than the frame.
fn client() -> Result<&'static cmux::Cmux, String> {
    CLIENT
        .get_or_init(|| cmux::Cmux::connect().ok())
        .as_ref()
        .ok_or_else(|| "cmux is not answering".to_string())
}

/// The frame to draw, or None when the screen has not changed since `seen`
/// (the stamp the last frame carried). Each replay renders afresh, so its
/// render_revision moves every call; the stamp is a hash of what it shows.
pub fn frame(c: &cmux::Cmux, surface: &str, seen: &str) -> Result<Option<Value>, String> {
    let d = c.call("terminal.replay", json!({"surface_id": surface})).map_err(|e| e.to_string())?;
    let g = d.get("render_grid").cloned().unwrap_or(Value::Null);
    let stamp = stamp_of(&d, &g);
    if stamp == seen {
        return Ok(None);
    }
    Ok(Some(json!({
        "stamp": stamp,
        "rows": d.get("rows").cloned().unwrap_or(Value::Null),
        "columns": d.get("columns").cloned().unwrap_or(Value::Null),
        "grid": g,
    })))
}

/// What a frame shows: its size, spans, cursor, styles and theme. cmux sends
/// object keys in no fixed order, so the hash walks them sorted.
fn stamp_of(d: &Value, g: &Value) -> String {
    use std::hash::Hasher;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for v in [&d["rows"], &d["columns"], &g["row_spans"], &g["scrollback_spans"], &g["cursor"], &g["styles"], &g["terminal_theme"], &g["active_screen"], &g["modes"]] {
        hash_value(v, &mut h);
    }
    format!("{:016x}", h.finish())
}

fn hash_value(v: &Value, h: &mut impl std::hash::Hasher) {
    use std::hash::Hash;
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            for k in keys {
                k.hash(h);
                hash_value(&m[k], h);
            }
            '}'.hash(h);
        }
        Value::Array(a) => {
            for x in a {
                hash_value(x, h);
            }
            ']'.hash(h);
        }
        other => other.to_string().hash(h),
    }
}

// ---- links in a pane ----

/// A link from a pane the app will hand to the browser: http or https only,
/// with no whitespace or control characters, and of a sane length. Anything
/// else (file:, a custom scheme, text that only looks like a URL) is refused.
pub fn url_ok(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty())
        && url.len() <= 4096
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Open a link found in a pane in the default browser (macOS `open`, no shell).
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !url_ok(&url) {
        return Err(format!("not a link the app opens: {url:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let st = std::process::Command::new("/usr/bin/open").arg(&url).status().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(format!("open {url} exited {st}")) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put `text` on the clipboard (macOS `pbcopy`, no shell): a terminal's copy,
/// which tmux hands over after the mouse is let go, too late for the page's
/// own clipboard (WebKit wants a click in progress).
#[tauri::command]
pub async fn copy_text(text: String) -> Result<(), String> {
    if text.len() > 8 << 20 {
        return Err("too much to copy".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let mut c = std::process::Command::new("/usr/bin/pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        c.stdin.take().ok_or("pbcopy has no stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        let st = c.wait().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(format!("pbcopy exited {st}")) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The worktree a pane's directory is in (git's top level), else the
/// directory itself.
fn worktree_of(dir: &str) -> String {
    std::process::Command::new("/usr/bin/git")
        .args(["-C", dir, "rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|t| t.starts_with('/'))
        .unwrap_or_else(|| dir.to_string())
}

fn git(root: &str, args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("/usr/bin/git").arg("-C").arg(root).args(args).output().ok()
}

/// Whether Peacock's file may be written in `root`, making sure git never
/// sees it: refused where the repo tracks .vscode/settings.json (it would show
/// as a change); where git would list it as new, it goes in the repo's own
/// exclude file (info/exclude, shared by its worktrees, never committed).
fn settings_ok(root: &str) -> Result<(), String> {
    const FILE: &str = ".vscode/settings.json";
    if !git(root, &["rev-parse", "--is-inside-work-tree"]).is_some_and(|o| o.status.success()) {
        return Ok(()); // not git: nothing to dirty
    }
    if git(root, &["ls-files", "--error-unmatch", FILE]).is_some_and(|o| o.status.success()) {
        return Err("this repo tracks .vscode/settings.json, so it was left uncolored".into());
    }
    if git(root, &["check-ignore", "-q", FILE]).is_some_and(|o| o.status.success()) {
        return Ok(());
    }
    let out = git(root, &["rev-parse", "--git-path", "info/exclude"]).filter(|o| o.status.success()).ok_or("git did not say where its exclude file is")?;
    let rel = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let path = if rel.starts_with('/') { std::path::PathBuf::from(rel) } else { std::path::Path::new(root).join(rel) };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let had = std::fs::read_to_string(&path).unwrap_or_default();
    let line = format!("/{FILE}");
    if !had.lines().any(|l| l.trim() == line) {
        let sep = if had.is_empty() || had.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&path, format!("{had}{sep}# seamux: Peacock's colors for VS Code\n{line}\n")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The seamux CLI beside this app (in its bundle), else the one on the usual path.
fn seamux_cli() -> std::path::PathBuf {
    let bundled = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.parent()?.join("Resources/bin/seamux")));
    bundled.filter(|p| p.is_file()).unwrap_or_else(|| crew_core::py::home().join(".local/bin/seamux"))
}

/// Give the worktree its color in VS Code, as on the Dock: crew-color's
/// one color per worktree, written as Peacock's settings.
fn paint(root: &str) -> Result<(), String> {
    settings_ok(root)?;
    let out = std::process::Command::new(seamux_cli()).args(["crew-color", "apply", root]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(crew_color_why(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// crew-color's refusal as a note for the page: its last line, without the
/// terminal colors and the red cross it prints it with.
fn crew_color_why(stderr: &str) -> String {
    let line = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut plain = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // CSI: ESC [ ... final byte in @..~
            for d in chars.by_ref() {
                if ('@'..='~').contains(&d) && d != '[' {
                    break;
                }
            }
        } else {
            plain.push(c);
        }
    }
    let plain = plain.trim().trim_start_matches('✗').trim();
    if plain.is_empty() { "crew-color failed".into() } else { plain.to_string() }
}

/// What opening a worktree in VS Code did: the folder, and why it is not
/// colored, if it is not.
#[derive(serde::Serialize)]
pub struct Opened {
    folder: String,
    note: Option<String>,
}

/// Open the worktree a pane works in, in VS Code (by its bundle id, so it
/// needs no `code` on the app's PATH), wearing the worktree's color first.
#[tauri::command]
pub async fn open_in_vscode(dir: String) -> Result<Opened, String> {
    if !dir.starts_with('/') || !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a folder: {dir:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = worktree_of(&dir);
        // Colored before it opens, so VS Code reads the colors as it starts.
        let note = paint(&root).err();
        let st = std::process::Command::new("/usr/bin/open")
            .args(["-b", "com.microsoft.VSCode"])
            .arg(&root)
            .status()
            .map_err(|e| e.to_string())?;
        if st.success() { Ok(Opened { folder: root, note }) } else { Err("VS Code did not open (is it installed?)".into()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod url_tests {
    use super::url_ok;

    #[test]
    fn crew_color_refusal_reads_plainly() {
        let err = "\x1b[31m✗\x1b[0m /w/.vscode/settings.json has comments, which rewriting it would drop\n";
        assert_eq!(super::crew_color_why(err), "/w/.vscode/settings.json has comments, which rewriting it would drop");
        assert_eq!(super::crew_color_why(""), "crew-color failed");
    }

    #[test]
    fn open_url_takes_web_links_only() {
        assert!(url_ok("https://github.com/rickykoter/seamux/pull/76"));
        assert!(url_ok("HTTP://127.0.0.1:7345/plan/x?y=1#z"));
        assert!(!url_ok("file:///etc/passwd"));
        assert!(!url_ok("javascript:alert(1)"));
        assert!(!url_ok("https://"));
        assert!(!url_ok("https://a b"));
        assert!(!url_ok("https://a\nb"));
        assert!(!url_ok(&format!("https://{}", "a".repeat(5000))));
    }
}

// ---- holding a pane at the app's size ----

/// A pane's size policy as cmux reports it, saved before a hold.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Saved {
    pub mode: String,
    /// The fixed size, when the policy had one in force (mode "fixed").
    pub fixed: Option<(u64, u64)>,
}

/// What the holds need from cmux: a pane's policy, and setting one.
pub trait Policy {
    fn get(&self, surface: &str) -> Result<Saved, String>;
    /// `fixed` is the size for mode "fixed"; other modes ignore it.
    fn set(&self, surface: &str, mode: &str, fixed: Option<(u64, u64)>) -> Result<(), String>;
}

impl Policy for cmux::Cmux {
    fn get(&self, surface: &str) -> Result<Saved, String> {
        let d = self.call("terminal.size_state", json!({"surface_id": surface})).map_err(|e| e.to_string())?;
        let p = &d["size_state"]["policy"];
        // A shape we do not know is a refusal, never a guess saved as the pane's own.
        let mode = p["mode"].as_str().filter(|m| !m.is_empty()).ok_or("cmux did not say the pane's size policy")?.to_string();
        let fixed = if mode == "fixed" {
            Some((
                p["fixed"]["cols"].as_u64().ok_or("cmux gave a fixed policy with no size")?,
                p["fixed"]["rows"].as_u64().ok_or("cmux gave a fixed policy with no size")?,
            ))
        } else {
            None
        };
        Ok(Saved { mode, fixed })
    }

    fn set(&self, surface: &str, mode: &str, fixed: Option<(u64, u64)>) -> Result<(), String> {
        let mut params = json!({"surface_id": surface, "mode": mode});
        if let (Some((c, r)), true) = (fixed, mode == "fixed") {
            params["fixed_cols"] = json!(c);
            params["fixed_rows"] = json!(r);
        }
        self.call("terminal.size_policy.set", params).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// The panes the app holds and what each had before, kept in a file too so a
/// crash cannot leave a pane at the app's size. The file is read when the
/// holds are made, so what a crash left is never written over.
pub struct Holds {
    pub file: std::path::PathBuf,
    held: std::sync::Mutex<std::collections::BTreeMap<String, Saved>>,
}

/// A pane cmux no longer knows: its policy went with it.
fn gone(err: &str) -> bool {
    err.contains("not_found") || err.contains("not found")
}

impl Holds {
    pub fn new(file: std::path::PathBuf) -> Holds {
        let held = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Holds { file, held: std::sync::Mutex::new(held) }
    }

    pub fn live() -> Holds {
        Holds::new(crew_core::py::home().join(".cache/seamux/term-holds.json"))
    }

    fn save(&self, held: &std::collections::BTreeMap<String, Saved>) {
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension(format!("tmp.{}", std::process::id()));
        if std::fs::write(&tmp, serde_json::to_string(held).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.file);
        }
    }

    /// Fix `surface` at cols x rows, saving its own policy the first time.
    /// The lock is never held across a cmux call.
    pub fn hold(&self, p: &dyn Policy, surface: &str, cols: u64, rows: u64) -> Result<(), String> {
        if cols < 20 || rows < 5 {
            return Err(format!("{cols}x{rows} is too small to hold a pane at"));
        }
        let known = self.held.lock().unwrap().contains_key(surface);
        if !known {
            let was = p.get(surface)?;
            let mut held = self.held.lock().unwrap();
            // Saved before the change: a crash after this is put right at start.
            held.entry(surface.to_string()).or_insert(was);
            self.save(&held);
        }
        p.set(surface, "fixed", Some((cols, rows)))
    }

    /// Give `surface` back the policy it had before the first hold. A failed
    /// set keeps the record (for the next release or the next start) unless
    /// cmux says the pane is gone.
    pub fn release(&self, p: &dyn Policy, surface: &str) -> Result<(), String> {
        let Some(was) = self.held.lock().unwrap().get(surface).cloned() else { return Ok(()) };
        let res = p.set(surface, &was.mode, was.fixed);
        if res.as_ref().is_ok() || res.as_ref().is_err_and(|e| gone(e)) {
            let mut held = self.held.lock().unwrap();
            held.remove(surface);
            self.save(&held);
            return Ok(());
        }
        res
    }

    pub fn release_all(&self, p: &dyn Policy) {
        let surfaces: Vec<String> = self.held.lock().unwrap().keys().cloned().collect();
        for s in surfaces {
            let _ = self.release(p, &s);
        }
    }

    /// What is still held (a crash's leftovers at start, or failed releases).
    pub fn pending(&self) -> usize {
        self.held.lock().unwrap().len()
    }
}

static HOLDS: OnceLock<Holds> = OnceLock::new();

pub fn holds() -> &'static Holds {
    HOLDS.get_or_init(Holds::live)
}

/// Release every hold: the window hid or the app is quitting.
pub fn release_all() {
    if let Ok(c) = client() {
        holds().release_all(c);
    }
}

/// At quit: release, but never let a hung cmux keep the app from quitting.
pub fn release_all_briefly() {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        release_all();
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_millis(1500));
}

/// At start, in the background: holds a crash left behind, retried while
/// cmux is not answering yet (the file keeps them meanwhile).
pub fn restore_at_start() {
    std::thread::spawn(|| {
        for _ in 0..60 {
            if holds().pending() == 0 {
                return;
            }
            if let Ok(c) = client() {
                holds().release_all(c);
            } else {
                // The client is made once; a cmux not up yet is asked again directly.
                if let Ok(c) = cmux::Cmux::connect() {
                    holds().release_all(&c);
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

#[tauri::command]
pub async fn term_hold(surface_id: String, cols: u64, rows: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || holds().hold(client()?, &surface_id, cols, rows))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn term_release(surface_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || holds().release(client()?, &surface_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn term_frame(surface_id: String, seen: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || frame(client()?, &surface_id, &seen))
        .await
        .map_err(|e| e.to_string())?
}

/// Raw input, as a terminal would send it: text, or a key's escape sequence.
#[tauri::command]
pub async fn term_input(surface_id: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        client()?.call("terminal.input", json!({"surface_id": surface_id, "text": text})).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A named key ("enter", "shift+tab", "ctrl+c"), which cmux encodes for the
/// keyboard protocol the program in the pane asked for.
#[tauri::command]
pub async fn term_key(surface_id: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        client()?.call("surface.send_key", json!({"surface_id": surface_id, "key": key})).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A paste, so the agent sees it as one (bracketed) paste.
#[tauri::command]
pub async fn term_paste(surface_id: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        client()?.call("terminal.paste", json!({"surface_id": surface_id, "text": text})).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    /// Live: TERM_SURFACE=<uuid> cargo test -- --ignored live_hold
    #[test]
    #[ignore]
    fn live_hold() {
        use super::Policy;
        let s = std::env::var("TERM_SURFACE").unwrap();
        let c = cmux::Cmux::connect().unwrap();
        let h = super::Holds::new(std::env::temp_dir().join("seamux-live-hold.json"));
        let before = c.get(&s).unwrap();
        h.hold(&c, &s, 60, 20).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(400));
        let f = super::frame(&c, &s, "").unwrap().unwrap();
        println!("held: {}x{} policy {:?}", f["columns"], f["rows"], c.get(&s).unwrap());
        h.release(&c, &s).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(400));
        let f = super::frame(&c, &s, "").unwrap().unwrap();
        println!("released: {}x{} policy {:?} (before {:?})", f["columns"], f["rows"], c.get(&s).unwrap(), before);
    }

    /// A live check, not a unit test: TERM_SURFACE=<uuid> cargo test -- --ignored live_frame
    #[test]
    #[ignore]
    fn live_frame() {
        let s = std::env::var("TERM_SURFACE").unwrap();
        let c = cmux::Cmux::connect().unwrap();
        let t = std::time::Instant::now();
        let f = super::frame(&c, &s, "").unwrap().unwrap();
        let first = t.elapsed();
        let stamp = f["stamp"].as_str().unwrap().to_string();
        let t = std::time::Instant::now();
        let again = super::frame(&c, &s, &stamp).unwrap();
        println!("first {:?}, unchanged {:?} (none: {}), {} spans", first, t.elapsed(), again.is_none(), f["grid"]["row_spans"].as_array().map(|a| a.len()).unwrap_or(0));
    }
}

#[cfg(test)]
mod stamp_tests {
    use serde_json::json;

    #[test]
    fn a_frame_stamp_ignores_key_order() {
        let a = json!({"rows": 2, "columns": 3, "render_grid": {"cursor": {"row": 1, "column": 2}, "row_spans": [{"text": "x", "row": 0}]}});
        let b = json!({"columns": 3, "rows": 2, "render_grid": {"row_spans": [{"row": 0, "text": "x"}], "cursor": {"column": 2, "row": 1}}});
        assert_eq!(super::stamp_of(&a, &a["render_grid"]), super::stamp_of(&b, &b["render_grid"]));
        let c = json!({"rows": 2, "columns": 3, "render_grid": {"cursor": {"row": 1, "column": 3}, "row_spans": [{"text": "x", "row": 0}]}});
        assert_ne!(super::stamp_of(&a, &a["render_grid"]), super::stamp_of(&c, &c["render_grid"]), "a moved cursor is a new frame");
    }
}

#[cfg(test)]
mod hold_tests {
    use super::{Holds, Policy, Saved};
    use std::cell::RefCell;

    /// A pane's policy, and every set made on it.
    struct Fake {
        now: RefCell<Saved>,
        sets: RefCell<Vec<(String, Option<(u64, u64)>)>>,
    }

    impl Fake {
        fn new(mode: &str, fixed: Option<(u64, u64)>) -> Fake {
            Fake { now: RefCell::new(Saved { mode: mode.into(), fixed }), sets: RefCell::default() }
        }
    }

    impl Policy for Fake {
        fn get(&self, _: &str) -> Result<Saved, String> {
            Ok(self.now.borrow().clone())
        }
        fn set(&self, _: &str, mode: &str, fixed: Option<(u64, u64)>) -> Result<(), String> {
            self.sets.borrow_mut().push((mode.into(), fixed));
            *self.now.borrow_mut() = Saved { mode: mode.into(), fixed: if mode == "fixed" { fixed } else { None } };
            Ok(())
        }
    }

    fn file(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("seamux-holds-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn term_hold_saves_the_policy_once_and_release_puts_it_back() {
        let f = file("once");
        let h = Holds::new(f.clone());
        let pane = Fake::new("smallest", None);
        h.hold(&pane, "S", 80, 30).unwrap();
        assert!(std::fs::read_to_string(&f).unwrap().contains("smallest"), "saved before the change");
        h.hold(&pane, "S", 90, 30).unwrap();
        assert_eq!(*pane.now.borrow(), Saved { mode: "fixed".into(), fixed: Some((90, 30)) }, "a second hold only resizes");
        h.release(&pane, "S").unwrap();
        assert_eq!(*pane.now.borrow(), Saved { mode: "smallest".into(), fixed: None }, "its own policy, not the fixed one");
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{}");
        h.release(&pane, "S").unwrap();
        assert_eq!(pane.sets.borrow().len(), 3, "a second release does nothing");
    }

    #[test]
    fn term_hold_keeps_a_pane_that_was_already_fixed_at_its_size() {
        let h = Holds::new(file("fixed"));
        let pane = Fake::new("fixed", Some((120, 40)));
        h.hold(&pane, "S", 80, 30).unwrap();
        h.release(&pane, "S").unwrap();
        assert_eq!(*pane.now.borrow(), Saved { mode: "fixed".into(), fixed: Some((120, 40)) });
    }

    #[test]
    fn term_holds_a_crash_left_are_restored_at_start() {
        let f = file("crash");
        let pane = Fake::new("latest", None);
        Holds::new(f.clone()).hold(&pane, "S", 80, 30).unwrap();
        // The app died here; a new one starts.
        let again = Holds::new(f.clone());
        assert_eq!(again.pending(), 1, "read from the file when made");
        again.release_all(&pane);
        assert_eq!(*pane.now.borrow(), Saved { mode: "latest".into(), fixed: None });
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{}");
    }

    /// A Fake whose sets fail with `err` (one shot each) while `failing` holds.
    struct Flaky {
        inner: Fake,
        err: RefCell<Option<String>>,
    }

    impl Policy for Flaky {
        fn get(&self, s: &str) -> Result<Saved, String> {
            self.inner.get(s)
        }
        fn set(&self, s: &str, mode: &str, fixed: Option<(u64, u64)>) -> Result<(), String> {
            if mode != "fixed" {
                if let Some(e) = self.err.borrow_mut().take() {
                    return Err(e);
                }
            }
            self.inner.set(s, mode, fixed)
        }
    }

    #[test]
    fn term_hold_a_failed_release_keeps_the_record_unless_the_pane_is_gone() {
        let f = file("flaky");
        let h = Holds::new(f.clone());
        let pane = Flaky { inner: Fake::new("latest", None), err: RefCell::new(Some("timed out".into())) };
        h.hold(&pane, "S", 80, 30).unwrap();
        assert!(h.release(&pane, "S").is_err());
        assert_eq!(h.pending(), 1, "kept for the next try");
        assert!(Holds::new(f.clone()).pending() == 1, "and in the file, for the next start");
        h.release(&pane, "S").unwrap();
        assert_eq!(*pane.inner.now.borrow(), Saved { mode: "latest".into(), fixed: None });

        let gone = Flaky { inner: Fake::new("latest", None), err: RefCell::new(Some("not_found: Terminal surface not found".into())) };
        h.hold(&gone, "G", 80, 30).unwrap();
        assert!(h.release(&gone, "G").is_ok());
        assert_eq!(h.pending(), 0, "a gone pane's record goes with it");
    }

    #[test]
    fn term_hold_leftovers_survive_a_start_when_cmux_is_not_up() {
        let f = file("notup");
        let pane = Fake::new("latest", None);
        Holds::new(f.clone()).hold(&pane, "OLD", 80, 30).unwrap();
        // A new start: cmux not answering, so nothing is released; then a new hold.
        let again = Holds::new(f.clone());
        again.hold(&pane, "NEW", 70, 20).unwrap();
        let text = std::fs::read_to_string(&f).unwrap();
        assert!(text.contains("OLD") && text.contains("NEW"), "the crash's record is not written over: {text}");
    }

    #[test]
    fn term_hold_refuses_a_size_too_small_to_use() {
        let h = Holds::new(file("small"));
        let pane = Fake::new("smallest", None);
        assert!(h.hold(&pane, "S", 3, 2).is_err());
        assert!(pane.sets.borrow().is_empty());
    }
}

/// cmux's terminal look (theme palette, colors, font) for the light or dark
/// appearance: the native terminal draws with it.
#[tauri::command]
pub async fn term_look(dark: bool) -> seamux_app::ghostty::Look {
    tauri::async_runtime::spawn_blocking(move || seamux_app::ghostty::look(dark)).await.unwrap_or_default()
}

#[cfg(test)]
mod worktree_tests {
    #[test]
    fn a_folder_inside_a_repo_opens_at_its_top_level() {
        let here = env!("CARGO_MANIFEST_DIR");
        let top = super::worktree_of(&format!("{here}/src"));
        assert!(std::path::Path::new(&top).join(".git").exists(), "{top}");
        assert_eq!(super::worktree_of("/"), "/");
    }
}

#[cfg(test)]
mod settings_tests {
    use std::process::Command;

    fn repo(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("seamux-peacock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let d = d.to_string_lossy().into_owned();
        Command::new("/usr/bin/git").args(["-C", &d, "init", "-q"]).status().unwrap();
        d
    }

    #[test]
    fn an_untracked_settings_file_is_kept_out_of_git() {
        let d = repo("excl");
        super::settings_ok(&d).unwrap();
        super::settings_ok(&d).unwrap(); // a second time adds nothing
        let ex = std::fs::read_to_string(format!("{d}/.git/info/exclude")).unwrap();
        assert_eq!(ex.matches("/.vscode/settings.json").count(), 1, "{ex}");
        std::fs::create_dir_all(format!("{d}/.vscode")).unwrap();
        std::fs::write(format!("{d}/.vscode/settings.json"), "{}").unwrap();
        let st = Command::new("/usr/bin/git").args(["-C", &d, "status", "--porcelain"]).output().unwrap();
        assert!(String::from_utf8_lossy(&st.stdout).trim().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_tracked_settings_file_is_left_alone() {
        let d = repo("tracked");
        std::fs::create_dir_all(format!("{d}/.vscode")).unwrap();
        std::fs::write(format!("{d}/.vscode/settings.json"), "{}").unwrap();
        Command::new("/usr/bin/git").args(["-C", &d, "add", ".vscode/settings.json"]).status().unwrap();
        assert!(super::settings_ok(&d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
