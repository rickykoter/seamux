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
/// "" for every workspace), matching `q`. `dirs` adds directories read
/// together with `ws`: the sheet passes its workspace's page roots.
#[tauri::command]
pub async fn wake_data(ws: String, q: String, dirs: Option<Vec<String>>) -> Result<Value, String> {
    blocking(move || wake::wake_data_in(&ws, &dirs.unwrap_or_default(), &q, "")).await
}

/// The pull requests worktree `dir`'s sessions made, with their state and
/// checks, as crew-sync last read them (crew_core::prs): the Wake's
/// Pull requests block. Empty when there is no list yet.
#[tauri::command]
pub async fn wake_prs(dir: String) -> Result<Value, String> {
    blocking(move || Ok(Value::Array(if dir.is_empty() { Vec::new() } else { crew_core::prs::list(&dir) }))).await
}

/// lookout's reviews of worktree `dir`, each with the state lookout works out
/// by its own rules (`lookout list --json --root`, lookout/lib/summary.mjs):
/// stage, gate, round, open findings by severity, claims, whether only the
/// person can close a finding, and past. The Wake's Reviews shelf. The
/// answer is kept until a review file changes, so a refresh with nothing new
/// costs a directory listing, not a node start.
#[tauri::command]
pub async fn wake_reviews(dir: String) -> Result<Value, String> {
    blocking(move || {
        if dir.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        let stamp = folder_stamp(&crew_board::review::reviews_dir(), is_review_file);
        static CACHE: Cache = std::sync::OnceLock::new();
        if let Some(v) = cached(&CACHE, &dir, stamp) {
            return Ok(v);
        }
        // The engine the pointer file names, as the app's other lookout calls
        // find it (an app opened from Finder may not have the shim on PATH);
        // else `lookout` from PATH.
        let args = ["list", "--json", "--root", dir.as_str()];
        let ran = match crew_board::act::lookout_engine() {
            Some((node, engine)) => {
                let mut a = vec![engine.as_str()];
                a.extend_from_slice(&args);
                crew_core::py::run(&node, &a, std::time::Duration::from_secs(15))
            }
            None => crew_core::py::run("lookout", &args, std::time::Duration::from_secs(15)),
        };
        let (code, out, err) = ran.ok_or("lookout list did not run (no lookout engine, or it timed out)")?;
        if code != 0 {
            return Err(format!("lookout list failed: {}", err.trim().lines().last().unwrap_or("")));
        }
        let v: Value = serde_json::from_str(&out).map_err(|_| "lookout list printed no reviews".to_string())?;
        if !v.is_array() {
            return Err("lookout list printed no reviews".into());
        }
        store(&CACHE, dir, stamp, &v);
        Ok(v)
    })
    .await
}

type Cache = std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (u128, Value)>>>;

/// The answer kept for `key` while its folder's stamp has not moved. A
/// folder that could not be read has no stamp, and nothing is kept for it.
fn cached(cache: &Cache, key: &str, stamp: Option<u128>) -> Option<Value> {
    let stamp = stamp?;
    let map = cache.get_or_init(Default::default).lock().ok()?;
    map.get(key).filter(|(at, _)| *at == stamp).map(|(_, v)| v.clone())
}

fn store(cache: &Cache, key: String, stamp: Option<u128>, v: &Value) {
    if let (Some(stamp), Ok(mut map)) = (stamp, cache.get_or_init(Default::default).lock()) {
        map.insert(key, (stamp, v.clone()));
    }
}

/// A review's own file, not one lookout derives beside it (rows, seen
/// cursors, a reviewer's incoming findings), which change when no review did.
fn is_review_file(name: &str) -> bool {
    name.ends_with(".json") && ![".rows.json", ".seen.json", ".incoming.json"].iter().any(|x| name.ends_with(x))
}

/// A stamp that moves whenever a file `keep` names is written, added or
/// removed: the newest change time among them, and their count. lookout and
/// deep-plan rewrite their files in place, so the folder's own time is not
/// enough. None when the folder cannot be read.
fn folder_stamp(folder: &std::path::Path, keep: fn(&str) -> bool) -> Option<u128> {
    let entries = std::fs::read_dir(folder).ok()?;
    let (mut newest, mut n) = (0u128, 0u128);
    for e in entries.flatten() {
        if !keep(&e.file_name().to_string_lossy()) {
            continue;
        }
        n += 1;
        let t = e.metadata().and_then(|m| m.modified()).ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        newest = newest.max(t);
    }
    Some(newest.wrapping_mul(1_000_003).wrapping_add(n))
}

/// The plans rooted at worktree `dir`, as `deep-plan status --json` gives
/// them (each with its title and every increment's go and done times): the
/// Wake names a turn after the increment whose window holds it.
#[tauri::command]
pub async fn wake_plans(dir: String) -> Result<Value, String> {
    blocking(move || {
        if dir.is_empty() {
            return Ok(Value::Array(Vec::new()));
        }
        // A row comes from a plan's state file and, for its title, its
        // archived spec (deep-plan's keys folder), so the answer is kept until
        // a file in either is written. Each folder as deep-plan resolves it.
        let folder = |var: &str, name: &str| {
            std::env::var_os(var).filter(|s| !s.is_empty()).map(std::path::PathBuf::from)
                .unwrap_or_else(|| crew_core::py::home().join(".claude/deep-plan").join(name))
        };
        let stamp = match (
            folder_stamp(&folder("DEEP_PLAN_STATE_DIR", "state"), |n| n.ends_with(".json")),
            folder_stamp(&folder("DEEP_PLAN_KEYS_DIR", "keys"), |n| n.ends_with(".spec.json")),
        ) {
            (Some(a), Some(b)) => Some(a.wrapping_mul(31).wrapping_add(b)),
            (Some(a), None) => Some(a),
            _ => None,
        };
        static CACHE: Cache = std::sync::OnceLock::new();
        if let Some(v) = cached(&CACHE, &dir, stamp) {
            return Ok(v);
        }
        let script = crew_core::dp_engine::script();
        let node = crew_board::act::node().unwrap_or_else(|| "node".into());
        let (code, out, err) = crew_core::py::run(&node, &[&script.to_string_lossy(), "status", "--json"], std::time::Duration::from_secs(15))
            .ok_or("deep-plan status did not run (no node, or it timed out)")?;
        if code != 0 {
            return Err(format!("deep-plan status failed: {}", err.trim().lines().last().unwrap_or("")));
        }
        let rows: Vec<Value> = serde_json::from_str(&out).map_err(|_| "deep-plan status printed no plans".to_string())?;
        let v = Value::Array(plans_rooted(rows, &dir));
        store(&CACHE, dir, stamp, &v);
        Ok(v)
    })
    .await
}

/// The rows whose root is `dir`, compared with symlinks resolved and
/// without a trailing slash (a plan rooted at /tmp/x matches /private/tmp/x).
fn plans_rooted(rows: Vec<Value>, dir: &str) -> Vec<Value> {
    let canon = |p: &str| {
        let t = if p.len() > 1 { p.trim_end_matches('/') } else { p };
        std::fs::canonicalize(t).map(|c| c.to_string_lossy().into_owned()).unwrap_or_else(|_| t.to_string())
    };
    let want = canon(dir);
    rows.into_iter()
        .filter(|r| {
            let root = r.get("realRoot").and_then(Value::as_str).filter(|s| !s.is_empty())
                .or_else(|| r.get("root").and_then(Value::as_str)).unwrap_or("");
            !root.is_empty() && canon(root) == want
        })
        .collect()
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
        // A file the app draws (BPMN) opens in the editor there, with no page to serve.
        let needs_server = match &t {
            Target::Page(_) => true,
            Target::File(f) => !wake::app_draws(f),
            _ => false,
        };
        let port = match port() {
            Some(p) => p,
            None if needs_server => return Err("the intent server has not started, so cmux has no page to open".into()),
            None => 0,
        };
        // cmux, the browser or VS Code comes forward and keeps the focus.
        crate::shell::allow_focus_away();
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
    /// image, video, html, pdf or bpmn (the XML, drawn by the page)
    pub kind: &'static str,
    pub title: String,
    pub data: String,
}

/// How the sheet shows a file, by its extension, and its media type.
pub fn show_kind(path: &str) -> Option<(&'static str, &'static str)> {
    if crew_store::classify::is_bpmn(path) {
        return Some(("bpmn", "application/xml"));
    }
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "gif" => ("image", "image/gif"),
        "webp" => ("image", "image/webp"),
        "svg" => ("image", "image/svg+xml"),
        "html" | "htm" => ("html", "text/html"),
        "pdf" => ("pdf", "application/pdf"),
        "mp4" => ("video", "video/mp4"),
        "m4v" => ("video", "video/x-m4v"),
        "mov" => ("video", "video/quicktime"),
        "webm" => ("video", "video/webm"),
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
        if kind == "video" {
            return Err(format!("a video streams from {SCHEME}:, not as a data: URL"));
        }
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

/// The URL scheme a Wake row's image or video streams from:
/// `wakefile://localhost/<row id>` (`http://wakefile.localhost/<id>` off macOS).
pub const SCHEME: &str = "wakefile";

/// The most one ranged answer carries: a video plays on, asking for the next.
const CHUNK: u64 = 4 * 1024 * 1024;

/// The bytes a Range header asks of a file `len` long, as (first, last),
/// at most CHUNK of them. None: no usable range, so the whole file.
/// Err: a range past the end (416).
pub fn byte_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else { return Ok(None) };
    // One range only: a list is read as its first.
    let spec = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = spec.split_once('-') else { return Ok(None) };
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return Err(());
    }
    let (first, last) = if a.is_empty() {
        // The last `b` bytes.
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let first: u64 = a.parse().map_err(|_| ())?;
        let last = if b.is_empty() { len - 1 } else { b.parse::<u64>().map_err(|_| ())?.min(len - 1) };
        (first, last)
    };
    if first >= len || last < first {
        return Err(());
    }
    Ok(Some((first, last.min(first + CHUNK - 1))))
}

/// The most a whole-file answer (no Range) reads into memory: a picture or
/// PDF past it is opened elsewhere; a video plays in ranges and never needs it.
const WHOLE_MAX: u64 = 64 * 1024 * 1024;
/// The most a strip thumbnail (`?thumb`) loads: past it the strip shows a tile.
const THUMB_MAX: u64 = 4 * 1024 * 1024;

/// What the scheme serves: images, videos and PDFs, never HTML (a page from
/// this origin would run its scripts).
fn served_type(path: &str) -> Option<&'static str> {
    show_kind(path).filter(|(k, _)| !matches!(*k, "html" | "bpmn")).map(|(_, m)| m)
}

/// Answer a `wakefile:` request: the file of the row its path names, when
/// that row is a file the Wake shows. The page names a row, never a path.
pub fn wakefile(req: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::{header, Response, StatusCode};
    let fail = |code: StatusCode, why: String| {
        Response::builder().status(code).header(header::CONTENT_TYPE, "text/plain").body(why.into_bytes()).unwrap_or_default()
    };
    let id = req.uri().path().trim_matches('/');
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return fail(StatusCode::BAD_REQUEST, "not a row id".into());
    }
    let path = match wake::resolve_artifact(id, "") {
        Ok(Target::File(p)) => p,
        Ok(_) => return fail(StatusCode::NOT_FOUND, "not a file the Wake shows".into()),
        Err((_, e)) => return fail(StatusCode::NOT_FOUND, e),
    };
    let Some(mime) = served_type(&path) else { return fail(StatusCode::FORBIDDEN, "not an image, video or PDF".into()) };
    let mut f = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(e) => return fail(StatusCode::NOT_FOUND, e.to_string()),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let thumb = req.uri().query().is_some_and(|q| q.split('&').any(|k| k == "thumb"));
    if thumb && len > THUMB_MAX {
        return fail(StatusCode::PAYLOAD_TOO_LARGE, "too big for a thumbnail".into());
    }
    let asked = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let b = Response::builder().header(header::CONTENT_TYPE, mime).header(header::ACCEPT_RANGES, "bytes");
    match byte_range(asked, len) {
        Err(()) => b
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .body(Vec::new())
            .unwrap_or_default(),
        Ok(Some((first, last))) => {
            let mut buf = vec![0; (last - first + 1) as usize];
            if let Err(e) = f.seek(SeekFrom::Start(first)).and_then(|_| f.read_exact(&mut buf)) {
                return fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            b.status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {first}-{last}/{len}"))
                .header(header::CONTENT_LENGTH, buf.len())
                .body(buf)
                .unwrap_or_default()
        }
        Ok(None) if len > WHOLE_MAX => fail(StatusCode::PAYLOAD_TOO_LARGE, format!("{} MB is too big to preview: open it elsewhere", len / (1024 * 1024))),
        Ok(None) => {
            let mut buf = Vec::with_capacity(len as usize);
            if let Err(e) = f.read_to_end(&mut buf) {
                return fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            b.status(StatusCode::OK).header(header::CONTENT_LENGTH, buf.len()).body(buf).unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_rooted_keeps_the_worktrees_plans_only() {
        let d = std::env::temp_dir().join(format!("wake-plans-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let ds = d.to_string_lossy().into_owned();
        let rows = vec![
            json!({"slug": "mine", "root": format!("{ds}/"), "realRoot": ""}),
            json!({"slug": "real", "root": "/nowhere", "realRoot": ds}),
            json!({"slug": "other", "root": "/elsewhere", "realRoot": "/elsewhere"}),
            json!({"slug": "rootless", "root": ""}),
        ];
        let kept: Vec<String> = plans_rooted(rows, &ds).iter().map(|r| r["slug"].as_str().unwrap().to_string()).collect();
        assert_eq!(kept, vec!["mine", "real"]);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn reviews_stamp_moves_when_a_review_is_rewritten_or_added() {
        let d = std::env::temp_dir().join(format!("wake-stamp-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let stamp = |d: &std::path::Path| folder_stamp(d, is_review_file);
        assert_eq!(stamp(&d.join("missing")), None, "an unreadable folder has no stamp");
        std::fs::write(d.join("a.json"), "{}").unwrap();
        let one = stamp(&d);
        std::fs::write(d.join("b.json"), "{}").unwrap();
        let two = stamp(&d);
        assert_ne!(one, two, "a new review moves the stamp");
        std::fs::write(d.join("notes.txt"), "x").unwrap();
        std::fs::write(d.join("a.rows.json"), "[]").unwrap();
        std::fs::write(d.join("a.seen.json"), "[]").unwrap();
        std::fs::write(d.join("a.incoming.json"), "[]").unwrap();
        assert_eq!(two, stamp(&d), "files that are not reviews leave it");
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(d.join("a.json"), "{\"x\":1}").unwrap();
        assert_ne!(two, stamp(&d), "a review rewritten in place moves it");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_cache_keeps_an_answer_only_while_its_stamp_holds() {
        static C: Cache = std::sync::OnceLock::new();
        store(&C, "w".into(), Some(7), &json!([1]));
        assert_eq!(cached(&C, "w", Some(7)), Some(json!([1])));
        assert_eq!(cached(&C, "w", Some(8)), None, "a moved stamp misses");
        assert_eq!(cached(&C, "w", None), None, "an unreadable folder never hits");
        store(&C, "x".into(), None, &json!([2]));
        assert_eq!(cached(&C, "x", None), None, "nothing is kept without a stamp");
    }

    #[test]
    fn the_sheet_shows_images_html_and_pdfs_only() {
        assert_eq!(show_kind("/a/b.PNG"), Some(("image", "image/png")));
        assert_eq!(show_kind("x.svg"), Some(("image", "image/svg+xml")));
        assert_eq!(show_kind("x.htm"), Some(("html", "text/html")));
        assert_eq!(show_kind("x.pdf"), Some(("pdf", "application/pdf")));
        assert_eq!(show_kind("x.rs"), None);
        assert_eq!(show_kind("noext"), None);
        assert_eq!(show_kind("demo.MOV"), Some(("video", "video/quicktime")));
        assert_eq!(show_kind("demo.mp4"), Some(("video", "video/mp4")));
        assert_eq!(show_kind("flow.BPMN"), Some(("bpmn", "application/xml")));
        assert_eq!(show_kind("task-need.v1.bpmn20.xml"), Some(("bpmn", "application/xml")));
        assert_eq!(show_kind("pom.xml"), None);
    }

    #[test]
    fn the_scheme_never_serves_html() {
        assert_eq!(served_type("a.html"), None);
        assert_eq!(served_type("a.bpmn"), None, "BPMN travels as XML to the page, never by the scheme");
        assert_eq!(served_type("p.bpmn20.xml"), None);
        assert_eq!(served_type("a.png"), Some("image/png"));
        assert_eq!(served_type("a.webm"), Some("video/webm"));
        assert_eq!(served_type("a.pdf"), Some("application/pdf"));
    }

    #[test]
    fn ranges_are_read_clamped_and_capped() {
        assert_eq!(byte_range(None, 100), Ok(None));
        assert_eq!(byte_range(Some("items=0-1"), 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-1"), 100), Ok(Some((0, 1))));
        assert_eq!(byte_range(Some("bytes=10-"), 100), Ok(Some((10, 99))));
        assert_eq!(byte_range(Some("bytes=90-500"), 100), Ok(Some((90, 99))));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(byte_range(Some("bytes=-500"), 100), Ok(Some((0, 99))));
        assert_eq!(byte_range(Some("bytes=0-1, 5-6"), 100), Ok(Some((0, 1))));
        assert_eq!(byte_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=5-2"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=0-"), 0), Err(()));
        let big = 100 * 1024 * 1024;
        assert_eq!(byte_range(Some("bytes=0-"), big), Ok(Some((0, CHUNK - 1))));
    }
}
