//! The Wake: the Artifact Log's page (crew-board-intent's Wake). crew-store
//! owns the store; this serves /artifacts (the page, token injected),
//! /artifacts/data (rows as JSON), /artifacts/open (a click), POST
//! /artifacts/keep and /artifacts/publish, and opens the Wake in its own tab
//! group at the right of the workspace in front.
//!
//! The page names row ids, never paths: what gets opened is resolved here
//! from the row the id names, so a page cannot point this server at a file
//! the indexer never recorded.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::act::{cmux_ok, cmux_out, run_ok, spawn_wait, targets, which};
use crate::plans::{plan_asset, realpath, slug_ok, uuid_ok};
use crate::server::{crew_file, log, quote};
use crate::state::state_dir;

pub const WAKE_VIEW: &str = "wake-view"; // the tab files and pages open in, beside the Wake
pub const WAKE_TAB: &str = "wake"; // the tab the Wake itself lives in
pub const WAKE_LIMIT: usize = 2000; // rows per answer; the page says when it is cut
const VIEW_IN_WAKE: [&str; 9] = [".html", ".htm", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"];
const BROWSER_HOSTS: [&str; 2] = ["claude.ai", "github.com"];
const ARTIFACTS_SLOT: &str = r#"<script id="boot" type="application/json">__BOOT__</script>"#;
const PUBLISHABLE: [&str; 10] = [".html", ".htm", ".md", ".markdown", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const PUBLISH_KINDS: [&str; 4] = ["temp", "image", "doc", "file"];

pub(crate) fn is_uuid_token(t: &str) -> bool {
    t.chars().count() == 36 && t.matches('-').count() == 4
}

/// A cmux call's stdout as JSON, with UUIDs for ids, or None.
pub(crate) fn cmux_json(argv: &[&str]) -> Option<Value> {
    let c = crate::cmux_cli::client()?;
    let mut full = vec!["--id-format", "uuids"];
    full.extend_from_slice(argv);
    let o = c.cli(&full).ok()?;
    if !o.ok() {
        return None;
    }
    serde_json::from_str(&o.stdout).ok()
}

/// (main-area width, panes with a frame) of a workspace. Dock panes carry a
/// dock_scope and no frame; a workspace not on screen has no frames at all.
pub(crate) fn main_panes(ws: &str) -> (f64, Vec<Value>) {
    let d = cmux_json(&["list-panes", "--workspace", ws, "--json"]).unwrap_or(Value::Null);
    let width = d.get("container_frame").and_then(|f| f.get("width")).and_then(Value::as_f64).unwrap_or(0.0);
    let panes = d.get("panes").and_then(Value::as_array).cloned().unwrap_or_default()
        .into_iter()
        .filter(|p| crate::pyval::truthy(p.get("pixel_frame").unwrap_or(&Value::Null))
                && !crate::pyval::truthy(p.get("dock_scope").unwrap_or(&Value::Null)))
        .collect();
    (width, panes)
}

pub(crate) fn pane_of<'a>(panes: &'a [Value], sid: &str) -> Option<&'a Value> {
    if sid.is_empty() {
        return None;
    }
    panes.iter().find(|p| p.get("surface_ids").and_then(Value::as_array)
        .map(|ids| ids.iter().any(|i| i.as_str() == Some(sid))).unwrap_or(false))
}

pub(crate) fn frame(p: &Value, k: &str) -> f64 {
    p.get("pixel_frame").and_then(|f| f.get(k)).and_then(Value::as_f64).unwrap_or(0.0)
}

/// probe() until it answers, for up to `timeout`: cmux applies a select, a
/// new pane and a resize after it has answered the call.
pub(crate) fn settle<T: Default + PartialEq>(mut probe: impl FnMut() -> T, timeout: Duration) -> T {
    let end = Instant::now() + timeout;
    loop {
        let got = probe();
        if got != T::default() || Instant::now() >= end {
            return got;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(crate) fn frame_width(ws: &str, sid: &str) -> f64 {
    let (_, panes) = main_panes(ws);
    pane_of(&panes, sid).map(|p| frame(p, "width")).unwrap_or(0.0)
}

/// Its own namespace, one file per workspace; no ws is the single file an
/// older crew kept, for one Dock tab.
pub fn keep_path(name: &str, ws: &str) -> std::path::PathBuf {
    state_dir().join(format!("wake-surface-{name}{}", if ws.is_empty() { String::new() } else { format!("-{ws}") }))
}

pub(crate) fn read_keep(name: &str, ws: &str) -> String {
    std::fs::read_to_string(keep_path(name, ws)).map(|s| s.trim().to_string()).unwrap_or_default()
}

pub(crate) fn write_keep(name: &str, ws: &str, sid: &str) {
    let _ = std::fs::create_dir_all(state_dir());
    let _ = std::fs::write(keep_path(name, ws), format!("{sid}\n"));
}

/// The one Wake tab an older crew kept, in the Dock: closed, and its file
/// dropped. One that is already a split in this workspace becomes its own.
fn adopt_legacy(ws: &str) {
    for name in [WAKE_TAB, WAKE_VIEW] {
        let sid = read_keep(name, "");
        if sid.is_empty() {
            continue;
        }
        if pane_of(&main_panes(ws).1, &sid).is_some() {
            write_keep(name, ws, &sid);
        } else if cmux_out(&["browser", "--surface", &sid, "get", "url"]).0 == 0 {
            let d = cmux_json(&["list-panes", "--workspace", ws, "--json"]).unwrap_or(Value::Null);
            let in_dock = d.get("panes").and_then(Value::as_array).into_iter().flatten().any(|p| {
                crate::pyval::truthy(p.get("dock_scope").unwrap_or(&Value::Null))
                    && p.get("surface_ids").and_then(Value::as_array).map(|ids| ids.iter().any(|i| i.as_str() == Some(sid.as_str()))).unwrap_or(false)
            });
            if in_dock {
                cmux_ok(&["close-surface", "--surface", &sid]);
            } else {
                continue; // a split in another workspace adopts it there
            }
        }
        let _ = std::fs::remove_file(keep_path(name, ""));
    }
}

/// The workspace in front, from tree's "active".
pub(crate) fn front() -> String {
    cmux_json(&["tree", "--json"]).as_ref()
        .and_then(|t| t.get("active")).and_then(|a| a.get("workspace_id"))
        .map(crate::pyval::str_or_empty).unwrap_or_default()
}

/// Show url in the Wake's own tab group in the workspace in front (or in
/// `select`, switched to first): one split at the right holding the Wake and
/// a tab for what it opens. Focused and widened; a second click navigates,
/// never stacks.
pub fn wake_tab(keep_name: &str, url: &str, select: &str) -> (bool, String) {
    let ws = if !select.is_empty() {
        let (rc, out) = cmux_out(&["--id-format", "uuids", "workspace", "select", select]);
        let target = out.split_whitespace().find(|t| is_uuid_token(t)).unwrap_or("").to_string();
        if rc != 0 || target.is_empty() {
            return (false, format!("could not switch to {select}"));
        }
        // "active" follows a select a moment later.
        if !settle(|| front() == target, Duration::from_millis(1500)) {
            return (false, format!("cmux did not switch to {select}"));
        }
        target
    } else {
        front()
    };
    if ws.is_empty() {
        return (false, "cmux did not say which workspace is in front".into());
    }
    adopt_legacy(&ws);
    // The Wake and what it opens are tabs in the workspace's companion
    // (companion.rs): one pane beside the chat, at its share, not a split of
    // their own. Opened by a click, so the page takes the keyboard.
    match crate::companion::open(url, keep_name, &ws, "", true) {
        Ok(sid) => (true, format!("focused {sid}")),
        Err(e) => (false, e),
    }
}

/// A claude.ai or GitHub URL in the default browser; nothing else.
/// A URL a browser cannot read differently from this check: https, no
/// backslash, whitespace, control character or userinfo, and a host on the
/// allowlist. Rows come from transcripts, so their URLs are not trusted.
pub fn browser_url_ok(url: &str) -> bool {
    if url.chars().any(|c| c == '\\' || c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    let host = authority.split(':').next().unwrap_or("").to_lowercase();
    BROWSER_HOSTS.contains(&host.as_str())
}

fn browser(url: &str) -> (bool, String) {
    let ok_url = browser_url_ok(url);
    if !ok_url {
        return (false, "not a claude.ai or GitHub URL".into());
    }
    let ok = run_ok("open", &[url], None);
    (ok, if ok { format!("opened {url}") } else { "the browser did not open".into() })
}

/// One commit's view-only lookout review, built in the workspace it was made
/// in but opened nowhere: the review id, or "" when lookout is missing or failed.
fn lookout_commit(ws: &str, sha: &str) -> String {
    let Some((node, engine)) = crate::act::lookout_engine() else { return String::new() };
    let rid = format!("wake-{}", sha.chars().take(12).collect::<String>());
    let mut cmd = std::process::Command::new(node);
    cmd.args([engine.as_str(), "open", "--range", &format!("{sha}^..{sha}"), "--view-only", "--at", ws, "--id", &rid, "--no-open"])
        .current_dir(ws);
    match spawn_wait(cmd, Duration::from_secs(90)) {
        Some((0, _, _)) => rid,
        Some((_, out, err)) => {
            let why = if err.trim().is_empty() { out } else { err };
            let tail: String = why.trim().chars().rev().take(160).collect::<Vec<_>>().into_iter().rev().collect();
            log(&format!("FAIL lookout open {}: {tail}", sha.chars().take(7).collect::<String>()));
            String::new()
        }
        None => String::new(),
    }
}

const CODE_APP: &str = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

/// A file in an editor: crew-code-open (a repo's own window), then VS Code on
/// the bare file, then the default TEXT editor. Never plain `open`.
fn open_in_editor(path: &str) -> (bool, String) {
    let mut cmd = std::process::Command::new("bash");
    cmd.args([crew_file("bin/crew-code-open").to_string_lossy().as_ref(), path]);
    if let Some((0, _, _)) = spawn_wait(cmd, Duration::from_secs(20)) {
        return (true, format!("opened {path}"));
    }
    let code = crew_core::py::env_or("CREW_CODE_BIN").or_else(|| {
        use std::os::unix::fs::PermissionsExt;
        let exec = std::fs::metadata(CODE_APP).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false);
        if exec { Some(CODE_APP.to_string()) } else { which("code") }
    });
    if let Some(c) = code {
        if run_ok(&c, &[path], None) {
            return (true, format!("opened {path} in VS Code"));
        }
    }
    if run_ok("open", &["-t", path], None) {
        return (true, format!("opened {path} in the text editor"));
    }
    (false, format!("no editor would open {path}"))
}

fn has_commit(ws: &str, sha: &str) -> bool {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["-C", ws, "cat-file", "-e", &format!("{sha}^{{commit}}")]);
    matches!(spawn_wait(cmd, Duration::from_secs(5)), Some((0, _, _)))
}

fn ext(path: &str) -> String {
    Path::new(path).extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default()
}

fn publishable(r: &crew_store::Row) -> bool {
    PUBLISH_KINDS.contains(&r.kind.as_str()) && PUBLISHABLE.contains(&ext(&r.path).as_str()) && Path::new(&r.path).is_file()
}

/// A row as the page sees it: the store's fields plus its state now.
fn wake_row(r: &crew_store::Row) -> Value {
    let present = !r.path.is_empty() && Path::new(&r.path).exists();
    let state = if r.kept_at.as_deref().map(|k| !k.is_empty()).unwrap_or(false) {
        if present { "kept" } else { "gone" }
    } else if r.kind == "commit" || r.kind == "artifact" {
        "ok"
    } else if !r.path.is_empty() && !present {
        "gone"
    } else if present && crew_store::is_temp(&r.path) {
        "risk"
    } else {
        "ok"
    };
    let mut m = Map::new();
    m.insert("id".into(), json!(r.id));
    m.insert("kind".into(), json!(r.kind));
    m.insert("title".into(), json!(r.title));
    m.insert("path".into(), json!(r.path));
    m.insert("was_path".into(), json!(r.was_path));
    m.insert("url".into(), json!(r.url));
    m.insert("sha".into(), json!(r.sha.chars().take(7).collect::<String>()));
    m.insert("created_at".into(), json!(r.created_at));
    m.insert("session_id".into(), json!(r.session_id));
    m.insert("branch".into(), json!(r.branch));
    m.insert("prompt".into(), json!(r.prompt));
    m.insert("source".into(), json!(r.source));
    m.insert("locator".into(), json!(if ["plan", "review", "ask"].contains(&r.kind.as_str()) { r.locator.clone() } else { String::new() }));
    m.insert("state".into(), json!(state));
    m.insert("published".into(), json!(r.url.starts_with("https://claude.ai/")));
    m.insert("publishable".into(), json!(state != "gone" && publishable(r)));
    m.insert("ws".into(), json!(r.ws));
    Value::Object(m)
}

pub fn wake_data(ws: &str, q: &str, kind: &str) -> Result<Value, String> {
    let rows = crew_store::search(q, (!ws.is_empty()).then_some(ws), (!kind.is_empty()).then_some(kind), WAKE_LIMIT)
        .map_err(|e| e.to_string())?;
    let wss = crew_store::workspaces().map_err(|e| e.to_string())?;
    let key = if ws.is_empty() { String::new() } else { crew_store::wskey(ws) };
    Ok(json!({
        "ws": key,
        "rows": rows.iter().map(wake_row).collect::<Vec<_>>(),
        "limit": WAKE_LIMIT,
        "truncated": rows.len() >= WAKE_LIMIT,
        "workspaces": wss.iter().map(|w| {
            let base = w.ws.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            json!({"ws": w.ws, "n": w.n, "last": w.last.clone().unwrap_or_default(),
                   "name": if base.is_empty() { w.ws.clone() } else { base },
                   "here": Path::new(&w.ws).is_dir()})
        }).collect::<Vec<_>>(),
    }))
}

fn row_by(rid: &str) -> Result<crew_store::Row, (bool, String)> {
    let Some(id) = crate::pyval::parse_int(rid) else { return Err((false, "bad id".into())) };
    match crew_store::row(id) {
        Ok(Some(r)) => Ok(r),
        Ok(None) => Err((false, "no such row".into())),
        Err(e) => Err((false, format!("could not open: {e}"))),
    }
}

/// What a row opens to: a page on this server, a file shown in the Wake's
/// tab, a URL for the browser, or a file for the editor.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// A path on the intent server: /plan/<slug>[suffix], /review/<id>, /ask/<id>.
    Page(String),
    /// A local file the Wake's tab can show (HTML, SVG, an image, a PDF).
    File(String),
    Browser(String),
    Editor(String),
}

/// Where a row leads, by kind, without opening anything. `sub` picks a
/// plan's surface: "" or "working", "review", "md".
pub fn resolve_row(r: &crew_store::Row, sub: &str) -> Result<Target, String> {
    let loc = r.locator.as_str();
    match r.kind.as_str() {
        "plan" => {
            let suffix = match sub {
                "" | "working" => Some(""),
                "review" => Some(".review.html"),
                "md" => Some(".md"),
                _ => None,
            };
            let Some(suffix) = suffix.filter(|_| slug_ok(loc)) else { return Err("unknown plan surface".into()) };
            if !suffix.is_empty() && plan_asset(&format!("{loc}{suffix}")).is_none() {
                return Err(format!("no {sub} for {loc}"));
            }
            Ok(Target::Page(format!("/plan/{loc}{suffix}")))
        }
        "review" => match crate::review::review_path(loc, ".html") {
            Some(_) => Ok(Target::Page(format!("/review/{loc}"))),
            None => Err("the review page is gone".into()),
        },
        "ask" => match crate::ask::ask_path(loc, ".html") {
            Some(_) => Ok(Target::Page(format!("/ask/{loc}"))),
            None => Err("the ask page is gone".into()),
        },
        "commit" => {
            let sha = if r.sha.is_empty() { loc.to_string() } else { r.sha.clone() };
            let ws = r.ws.as_str();
            let sha_ok = (7..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
            if !ws.is_empty() && Path::new(ws).is_dir() && sha_ok && has_commit(ws, &sha) && has_commit(ws, &format!("{sha}^")) {
                let rid = lookout_commit(ws, &sha);
                if !rid.is_empty() && crate::review::review_path(&rid, ".html").is_some() {
                    return Ok(Target::Page(format!("/review/{rid}")));
                }
            }
            if !r.url.is_empty() {
                return Ok(Target::Browser(r.url.clone()));
            }
            Err("the worktree is gone and no GitHub remote was recorded".into())
        }
        "artifact" => Ok(Target::Browser(r.url.clone())),
        _ => {
            if !r.path.is_empty() && Path::new(&r.path).is_file() {
                if VIEW_IN_WAKE.contains(&ext(&r.path).as_str()) {
                    return Ok(Target::File(r.path.clone()));
                }
                return Ok(Target::Editor(r.path.clone()));
            }
            if !r.url.is_empty() {
                return Ok(Target::Browser(r.url.clone()));
            }
            Err(format!("gone: {}", if r.path.is_empty() { loc } else { r.path.as_str() }))
        }
    }
}

/// `resolve_row` for the row an id names.
pub fn resolve_artifact(rid: &str, sub: &str) -> Result<Target, (bool, String)> {
    let r = row_by(rid)?;
    resolve_row(&r, sub).map_err(|e| (false, e))
}

/// Open what a row leads to, in cmux: pages and viewable files in the Wake's
/// tab, URLs in the browser, other files in the editor.
pub fn open_target(t: &Target, port: u16) -> (bool, String) {
    let base = format!("http://127.0.0.1:{port}");
    match t {
        Target::Page(p) => wake_tab(WAKE_VIEW, &format!("{base}{p}"), ""),
        Target::File(f) => wake_tab(WAKE_VIEW, &format!("file://{}", quote(f, "/")), ""),
        Target::Browser(u) => browser(u),
        Target::Editor(f) => open_in_editor(f),
    }
}

/// Open the row an id names, by kind.
pub fn open_artifact(rid: &str, port: u16, sub: &str) -> (bool, String) {
    match resolve_artifact(rid, sub) {
        Ok(t) => open_target(&t, port),
        Err(e) => e,
    }
}

/// The cmux workspace the board lists for a directory, or "".
fn workspace_for(ws: &str) -> String {
    let want = realpath(Path::new(ws));
    for (wid, row) in targets() {
        if let Some(cwd) = row.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            if realpath(Path::new(cwd)) == want {
                return wid;
            }
        }
    }
    String::new()
}

/// `shlex.quote`.
fn shlex_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Publish one row's file to claude.ai: a terminal in the row's workspace
/// runs an interactive claude limited to Artifact and Read, prompt given.
pub fn publish_artifact(rid: i64) -> (bool, String) {
    let r = match crew_store::row(rid) {
        Ok(Some(r)) => r,
        Ok(None) => return (false, "no such row".into()),
        Err(e) => return (false, format!("publish failed: {e}")),
    };
    if !publishable(&r) {
        return (false, "only a present HTML, markdown or image file can be published".into());
    }
    let path = r.path.as_str();
    if path.chars().any(|c| (c as u32) < 32) {
        return (false, "a path with control characters is not sent to a terminal".into());
    }
    let cwd = if !r.ws.is_empty() && Path::new(&r.ws).is_dir() { r.ws.clone() } else { crew_core::py::home().to_string_lossy().into_owned() };
    let prompt = format!("Publish the file {path} to claude.ai with the Artifact tool, exactly as it is: read it \
first and do not edit or rewrite it. Then reply with only the URL.");
    let cmd = format!("claude --tools Artifact Read --strict-mcp-config {}", shlex_quote(&prompt));
    let wid = workspace_for(&cwd);
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // A native session in the row's workspace, as every new session starts;
    // cmux's own terminal when there is none or the native start fails.
    if cmux::is_uuid(&wid) {
        if let Ok(surface) = crew_core::native::start_native_with(&wid, &cwd, &cmd) {
            let _ = cmux_out(&["focus-panel", "--panel", &surface, "--workspace", &wid]);
            return (true, format!("publishing {name} in a terminal; the URL lands here when it finishes"));
        }
    }
    let mut argv = vec!["new-surface", "--type", "terminal", "--working-directory", &cwd, "--command", &cmd, "--focus", "true"];
    if !wid.is_empty() {
        argv.extend(["--workspace", wid.as_str()]);
    }
    let (rc, out) = cmux_out(&argv);
    if rc != 0 {
        return (false, format!("could not open a terminal: {}", out.trim().chars().take(160).collect::<String>()));
    }
    (true, format!("publishing {name} in a terminal; the URL lands here when it finishes"))
}

/// POST /artifacts/keep {t, id} | {t, ws, all: true}: (code, reply).
pub fn keep(body: &Map<String, Value>) -> (u16, Value) {
    if body.get("all") == Some(&Value::Bool(true)) {
        let Some(ws) = body.get("ws").and_then(Value::as_str).filter(|w| !w.is_empty()) else {
            return (400, json!({"error": "no workspace"}));
        };
        return match crew_store::keep_all(ws) {
            Ok(res) => {
                let kept = res.iter().filter(|r| r.ok).count();
                log(&format!("OK   artifacts keep all {ws}: {kept} kept, {} refused", res.len() - kept));
                (200, json!({"ok": true, "results": res.iter().map(|r| r.to_json()).collect::<Vec<_>>()}))
            }
            Err(e) => {
                log(&format!("FAIL artifacts keep: {e}"));
                (500, json!({"error": format!("keep failed: {e}")}))
            }
        };
    }
    let Some(rid) = body.get("id").and_then(|v| if v.is_i64() || v.is_u64() { v.as_i64() } else { None }) else {
        return (400, json!({"error": "bad id"}));
    };
    match crew_store::keep(rid) {
        Ok(res) => {
            log(&format!("{} artifacts keep {rid}: {}", if res.ok { "OK  " } else { "FAIL" },
                         res.path.clone().filter(|p| !p.is_empty()).or(res.why.clone()).unwrap_or_default()));
            (if res.ok { 200 } else { 400 }, res.to_json())
        }
        Err(e) => {
            log(&format!("FAIL artifacts keep: {e}"));
            (500, json!({"error": format!("keep failed: {e}")}))
        }
    }
}

/// The Wake's page: the template with the token and workspace in its boot block.
pub fn wake_page(ws: &str, token: &str) -> std::io::Result<String> {
    let tmpl = std::fs::read_to_string(crew_file("board/artifacts.tmpl.html"))?;
    let boot = crew_core::pyjson::dumps(&json!({"t": token, "ws": ws}))
        .replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026");
    Ok(tmpl.replace(ARTIFACTS_SLOT, &ARTIFACTS_SLOT.replace("__BOOT__", &boot)))
}

/// The wake chip: the Wake for a row's workspace, in its own tab.
pub fn for_row(cwd: &str, wsid: &str, r: &str, port: u16) -> (bool, String) {
    let url = format!("http://127.0.0.1:{port}/artifacts?ws={}", quote(cwd, ""));
    wake_tab(WAKE_TAB, &url, if uuid_ok(wsid) { wsid } else { r })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_claude_and_github_urls_open() {
        assert!(browser_url_ok("https://claude.ai/public/artifacts/x") && browser_url_ok("https://github.com/o/r/pull/1"));
        assert!(!browser_url_ok("https://evil.example\\@claude.ai/x"));
        assert!(!browser_url_ok("https://user@claude.ai/x") && !browser_url_ok("http://claude.ai/x"));
        assert!(!browser_url_ok("https://claude.ai.evil.example/x") && !browser_url_ok("https://claude.ai/a b"));
    }

    #[test]
    fn shlex_quotes_like_python() {
        assert_eq!(shlex_quote("plain-word_1.txt"), "plain-word_1.txt");
        assert_eq!(shlex_quote("it's here"), "'it'\"'\"'s here'");
        assert_eq!(shlex_quote(""), "''");
    }

    fn row(kind: &str, locator: &str, path: &str, url: &str) -> crew_store::Row {
        crew_store::Row {
            id: 1,
            ws: String::new(),
            repo: String::new(),
            kind: kind.into(),
            title: String::new(),
            locator: locator.into(),
            path: path.into(),
            url: url.into(),
            sha: String::new(),
            was_path: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            session_id: String::new(),
            branch: String::new(),
            prompt: String::new(),
            source: String::new(),
            kept_at: None,
        }
    }

    /// resolve_row names what open_artifact opens, for every row kind,
    /// without opening anything.
    #[test]
    fn a_row_resolves_to_what_it_opens() {
        let dir = std::env::temp_dir().join(format!("crew-board-resolve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let html = dir.join("page.html");
        let code = dir.join("main.rs");
        std::fs::write(&html, "<p>x</p>").unwrap();
        std::fs::write(&code, "fn main() {}").unwrap();
        let (h, c) = (html.to_string_lossy().into_owned(), code.to_string_lossy().into_owned());

        assert_eq!(resolve_row(&row("plan", "seamux-views", "", ""), ""), Ok(Target::Page("/plan/seamux-views".into())));
        assert_eq!(resolve_row(&row("plan", "seamux-views", "", ""), "working"), Ok(Target::Page("/plan/seamux-views".into())));
        assert!(resolve_row(&row("plan", "../x", "", ""), "").is_err());
        assert!(resolve_row(&row("plan", "p", "", ""), "pdf").is_err());
        assert!(resolve_row(&row("review", "no-such-review-xyz", "", ""), "").unwrap_err().contains("gone"));
        assert_eq!(resolve_row(&row("artifact", "a", "", "https://claude.ai/a/1"), ""), Ok(Target::Browser("https://claude.ai/a/1".into())));
        assert_eq!(resolve_row(&row("image", "i", &h, ""), ""), Ok(Target::File(h.clone())));
        assert_eq!(resolve_row(&row("file", "f", &c, ""), ""), Ok(Target::Editor(c.clone())));
        assert_eq!(resolve_row(&row("doc", "d", "/no/such/file.md", "https://example.com/d"), ""), Ok(Target::Browser("https://example.com/d".into())));
        assert!(resolve_row(&row("doc", "d", "/no/such/file.md", ""), "").unwrap_err().starts_with("gone"));
        assert!(resolve_row(&row("commit", "abc", "", ""), "").is_err(), "no worktree and no remote");
        assert_eq!(resolve_row(&row("commit", "abc", "", "https://github.com/o/r/commit/abc"), ""), Ok(Target::Browser("https://github.com/o/r/commit/abc".into())));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
