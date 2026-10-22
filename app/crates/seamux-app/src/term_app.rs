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
    for v in [&d["rows"], &d["columns"], &g["row_spans"], &g["cursor"], &g["styles"], &g["terminal_theme"], &g["active_screen"]] {
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
        let mode = p["mode"].as_str().unwrap_or("smallest").to_string();
        let fixed = (mode == "fixed")
            .then(|| Some((p["fixed"]["cols"].as_u64()?, p["fixed"]["rows"].as_u64()?)))
            .flatten();
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
/// crash cannot leave a pane at the app's size.
pub struct Holds {
    pub file: std::path::PathBuf,
    held: std::sync::Mutex<std::collections::BTreeMap<String, Saved>>,
}

impl Holds {
    pub fn new(file: std::path::PathBuf) -> Holds {
        Holds { file, held: std::sync::Mutex::default() }
    }

    pub fn live() -> Holds {
        Holds::new(crew_core::py::home().join(".cache/seamux/term-holds.json"))
    }

    fn load(&self) -> std::collections::BTreeMap<String, Saved> {
        std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
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
    pub fn hold(&self, p: &dyn Policy, surface: &str, cols: u64, rows: u64) -> Result<(), String> {
        if cols < 20 || rows < 5 {
            return Err(format!("{cols}x{rows} is too small to hold a pane at"));
        }
        let mut held = self.held.lock().unwrap();
        if !held.contains_key(surface) {
            let was = p.get(surface)?;
            held.insert(surface.to_string(), was);
            // Saved before the change: a crash after this line is put right at start.
            self.save(&held);
        }
        p.set(surface, "fixed", Some((cols, rows)))
    }

    /// Give `surface` back the policy it had before the first hold.
    pub fn release(&self, p: &dyn Policy, surface: &str) -> Result<(), String> {
        let mut held = self.held.lock().unwrap();
        let Some(was) = held.get(surface).cloned() else { return Ok(()) };
        let res = p.set(surface, &was.mode, was.fixed);
        // A pane cmux no longer knows is gone with its policy: drop it either way.
        held.remove(surface);
        self.save(&held);
        res
    }

    pub fn release_all(&self, p: &dyn Policy) {
        let surfaces: Vec<String> = self.held.lock().unwrap().keys().cloned().collect();
        for s in surfaces {
            let _ = self.release(p, &s);
        }
    }

    /// At start: what a crash left held, put back.
    pub fn restore_leftovers(&self, p: &dyn Policy) {
        let left = self.load();
        if left.is_empty() {
            return;
        }
        *self.held.lock().unwrap() = left;
        self.release_all(p);
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

/// At start, in the background: holds a crash left behind.
pub fn restore_at_start() {
    std::thread::spawn(|| {
        if let Ok(c) = client() {
            holds().restore_leftovers(c);
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
        again.restore_leftovers(&pane);
        assert_eq!(*pane.now.borrow(), Saved { mode: "latest".into(), fixed: None });
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{}");
    }

    #[test]
    fn term_hold_refuses_a_size_too_small_to_use() {
        let h = Holds::new(file("small"));
        let pane = Fake::new("smallest", None);
        assert!(h.hold(&pane, "S", 3, 2).is_err());
        assert!(pane.sets.borrow().is_empty());
    }
}
