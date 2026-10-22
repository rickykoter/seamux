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
