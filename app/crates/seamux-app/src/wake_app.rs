//! The Wake's commands: the same crew-board functions /artifacts calls, run
//! in this process, so the two pages cannot drift in what they show or do.

use serde::Serialize;
use serde_json::{json, Map, Value};

use crew_board::wake::{self, Target};

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// The intent server's port, when it has written one (pages open from it).
fn port() -> Option<u16> {
    let home = std::env::var_os("HOME")?;
    let text = std::fs::read_to_string(std::path::Path::new(&home).join(".cache/cmux-crew/board-intent.port")).ok()?;
    crate::shell::parse_port(&text)
}

/// Rows, workspaces and the truncation flag for `ws` (a worktree path, or
/// "" for every workspace), matching `q`.
#[tauri::command]
pub async fn wake_data(ws: String, q: String) -> Result<Value, String> {
    blocking(move || wake::wake_data(&ws, &q, "")).await
}

/// What opening a row did: a page for the app's sheet, or what cmux did.
#[derive(Serialize)]
pub struct Opened {
    /// A path on the intent server to show in the sheet, when `here`.
    sheet: Option<String>,
    detail: String,
}

/// Open row `id` (`sub` picks a plan's surface). With `here`, a page comes
/// back for the sheet; anything else, and every row without `here`, opens
/// in cmux as /artifacts opens it.
#[tauri::command]
pub async fn wake_open(id: i64, sub: String, here: bool) -> Result<Opened, String> {
    blocking(move || {
        let t = wake::resolve_artifact(&id.to_string(), &sub).map_err(|(_, e)| e)?;
        if let (true, Target::Page(p)) = (here, &t) {
            return Ok(Opened { sheet: Some(p.clone()), detail: String::new() });
        }
        let needs_server = matches!(t, Target::Page(_) | Target::File(_));
        let port = match port() {
            Some(p) => p,
            None if needs_server => return Err("the intent server has not started, so cmux has no page to open".into()),
            None => 0,
        };
        match wake::open_target(&t, port) {
            (true, detail) => Ok(Opened { sheet: None, detail }),
            (false, detail) => Err(detail),
        }
    })
    .await
}

/// Keep one at-risk row's file (copy it into ~/.claude/crew/kept).
#[tauri::command]
pub async fn wake_keep(id: i64) -> Result<Value, String> {
    blocking(move || {
        let mut body = Map::new();
        body.insert("id".into(), json!(id));
        match wake::keep(&body) {
            (200, v) => Ok(v),
            (_, v) => Err(v.get("why").or(v.get("error")).and_then(Value::as_str).unwrap_or("refused").to_string()),
        }
    })
    .await
}

/// Keep every at-risk file of workspace `ws`.
#[tauri::command]
pub async fn wake_keep_all(ws: String) -> Result<Value, String> {
    blocking(move || {
        let mut body = Map::new();
        body.insert("ws".into(), json!(ws));
        body.insert("all".into(), json!(true));
        match wake::keep(&body) {
            (200, v) => Ok(v),
            (_, v) => Err(v.get("error").and_then(Value::as_str).unwrap_or("refused").to_string()),
        }
    })
    .await
}

/// Publish row `id`'s file to claude.ai through a tools-limited claude in a
/// cmux terminal. The page confirms first: this sends a file off the machine.
#[tauri::command]
pub async fn wake_publish(id: i64) -> Result<String, String> {
    blocking(move || match wake::publish_artifact(id) {
        (true, d) => Ok(d),
        (false, d) => Err(d),
    })
    .await
}

/// The home directory, so the page can show paths as ~/...
#[tauri::command]
pub fn home_dir() -> String {
    crew_core::py::home().to_string_lossy().into_owned()
}

/// The most a file shown in the sheet may weigh: it travels as a data: URL.
pub const SHOW_MAX: u64 = 12 * 1024 * 1024;

/// A Wake file for the sheet, as a data: URL and how to show it.
#[derive(Serialize)]
pub struct Shown {
    /// image, html or pdf
    kind: &'static str,
    title: String,
    data: String,
}

/// How the sheet shows a file, by its extension, and its media type.
pub fn show_kind(path: &str) -> Option<(&'static str, &'static str)> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        "html" | "htm" => ("html", "text/html"),
        "pdf" => ("pdf", "application/pdf"),
        _ => return None,
    })
}

/// Row `id`'s file, when it is one the Wake views (the row names the path;
/// the page never does).
#[tauri::command]
pub async fn wake_file(id: i64) -> Result<Shown, String> {
    use base64::Engine;
    blocking(move || {
        let Target::File(path) = wake::resolve_artifact(&id.to_string(), "").map_err(|(_, e)| e)? else {
            return Err("this row is not a file the Wake shows".into());
        };
        let (kind, mime) = show_kind(&path).ok_or("this file is not one the sheet shows")?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > SHOW_MAX {
            return Err(format!("{} MB is too big for the sheet: open it in cmux", meta.len() / (1024 * 1024)));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let title = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let data = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        Ok(Shown { kind, title, data })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sheet_shows_images_html_and_pdfs_only() {
        assert_eq!(show_kind("/a/b.PNG"), Some(("image", "image/png")));
        assert_eq!(show_kind("x.svg"), Some(("image", "image/svg+xml")));
        assert_eq!(show_kind("x.htm"), Some(("html", "text/html")));
        assert_eq!(show_kind("x.pdf"), Some(("pdf", "application/pdf")));
        assert_eq!(show_kind("x.rs"), None);
        assert_eq!(show_kind("noext"), None);
    }
}
