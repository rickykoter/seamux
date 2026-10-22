//! The companion pane: one browser split per cmux workspace, at the right of
//! the agent's terminal, holding every page the house opens there (an ask,
//! a plan's working page, a lookout review, the Wake) as a tab per page.
//!
//! ```text
//! seamux companion open <url> --key <key> [--workspace ws] [--surface s] [--focus]
//! ```
//!
//! The pane is made once and reused; a key's tab is navigated, never stacked.
//! It is sized to SHARE of the workspace's main area so the chat keeps the
//! rest. An agent's open gives the keyboard back to the surface it came from;
//! a person's (`--focus`) moves it to the page.

use std::time::Duration;

use serde_json::Value;

use crate::act::{cmux_ok, cmux_out};
use crate::wake::{front, frame, frame_width, is_uuid_token, main_panes, pane_of, read_keep, settle, write_keep};

/// The companion's share of the workspace's main area: the chat keeps 60%.
pub const SHARE: f64 = 0.4;
/// The keep-file namespace: companion-<key>-<ws> holds the key's tab, and
/// companion-pane-<ws> the pane.
const NS: &str = "companion";

/// A key names a page's tab: lower case, digits, `.`, `_`, `-`, after a letter.
/// `pane` and `fit` are the pane's own keep names, so no tab may take them.
pub fn key_ok(key: &str) -> bool {
    let mut c = key.chars();
    key != "pane" && key != "fit"
        && c.next().is_some_and(|f| f.is_ascii_lowercase())
        && key.len() <= 96
        && key.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ".-_".contains(ch))
}

/// The keep file a key's tab is remembered in. The Wake's two keys keep the
/// names they had before the companion, so a Wake tab already open is reused.
fn keep_name(key: &str) -> String {
    if key == crate::wake::WAKE_TAB || key == crate::wake::WAKE_VIEW {
        key.to_string()
    } else {
        format!("{NS}-{key}")
    }
}

/// A page the companion may show: one the intent server serves on loopback
/// (`http://127.0.0.1:<port>/…` or `localhost`), or a local file. The host is
/// read up to the path, so `http://127.0.0.1:80@elsewhere/` is refused.
pub fn url_ok(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("file://") {
        return rest.starts_with('/');
    }
    let Some(rest) = url.strip_prefix("http://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let Some((name, port)) = host.split_once(':') else { return false };
    (name == "127.0.0.1" || name == "localhost") && !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())
}

/// A tab that is one of seamux's own pages: served by the intent server.
fn seamux_page(url: &str) -> bool {
    let port = std::fs::read_to_string(crew_core::py::home().join(".cache/cmux-crew/board-intent.port")).unwrap_or_default();
    let port = port.trim();
    !port.is_empty()
        && (url.starts_with(&format!("http://127.0.0.1:{port}/")) || url.starts_with(&format!("http://localhost:{port}/")))
        && url_ok(url)
}

/// How far, in points, the companion's left border must move to reach SHARE
/// of `width`: positive widens it (resize -L), negative narrows it (-R).
pub fn resize_by(width: f64, companion: f64) -> i64 {
    if width <= 0.0 {
        return 0;
    }
    let want = (SHARE * width).round();
    (want - companion).round() as i64
}

/// Size the pane holding `sid` to SHARE: a few passes, since a resize can
/// land a moment after cmux answers and one divider moves at a time. A new
/// pane is fitted both ways; once fitted it is only widened back to SHARE,
/// so a companion the person made wider stays as they left it. One that
/// could not be measured (its workspace off screen) is fitted on a later open.
fn fit(ws: &str, sid: &str) {
    let pane_id = |panes: &[Value]| pane_of(panes, sid).and_then(|p| p.get("id")).map(crate::pyval::py_str).unwrap_or_default();
    let (_, panes) = main_panes(ws);
    let pid = pane_id(&panes);
    let fitted = !pid.is_empty() && read_keep(&format!("{NS}-fit"), ws) == pid;
    settle(|| frame_width(ws, sid), Duration::from_millis(1500));
    for _ in 0..4 {
        let (width, panes) = main_panes(ws);
        let Some(me) = pane_of(&panes, sid) else { return };
        let w = frame(me, "width");
        if width <= 0.0 {
            return;
        }
        let by = resize_by(width, w);
        if by.abs() < 8 || (fitted && by < 0) {
            write_keep(&format!("{NS}-fit"), ws, &pane_id(&panes));
            return;
        }
        if by < 0 {
            // Narrowing: cmux has no border to the right of the rightmost
            // pane, so the pane at its left grows into it (-R moves that
            // pane's right border right).
            let x = frame(me, "x");
            let left = panes
                .iter()
                .filter(|p| frame(p, "x") < x && (frame(p, "x") + frame(p, "width") - x).abs() < 4.0)
                .max_by(|a, b| frame(a, "x").partial_cmp(&frame(b, "x")).unwrap_or(std::cmp::Ordering::Equal));
            let Some(left) = left else { return };
            let lid = left.get("id").map(crate::pyval::py_str).unwrap_or_default();
            cmux_ok(&["resize-pane", "--pane", &lid, "--workspace", ws, "-R", "--amount", &(-by).to_string()]);
            if !settle(|| (frame_width(ws, sid) - w).abs() > 1.0, Duration::from_millis(600)) {
                return;
            }
            continue;
        }
        // Widening: resize-pane moves one divider and passes nothing on, so
        // once the companion's own left edge is spent, the pane beside it
        // moves its edge, nearest first.
        let x = frame(me, "x");
        let mut beside: Vec<&Value> = panes.iter().filter(|p| {
            let px = frame(p, "x");
            0.0 < px && px < x
        }).collect();
        beside.sort_by(|a, b| frame(b, "x").partial_cmp(&frame(a, "x")).unwrap_or(std::cmp::Ordering::Equal));
        let mut moved = false;
        for p in std::iter::once(me).chain(beside) {
            let pid = p.get("id").map(crate::pyval::py_str).unwrap_or_default();
            cmux_ok(&["resize-pane", "--pane", &pid, "--workspace", ws, "-L", "--amount", &by.to_string()]);
            if settle(|| frame_width(ws, sid) > w + 1.0, Duration::from_millis(600)) {
                moved = true;
                break;
            }
        }
        if !moved {
            return; // nothing moved: leave it
        }
    }
}

/// The companion pane of `ws`, if it is still there: the kept pane, or the
/// Wake's group from before the companion (adopted, so a workspace never gets two).
fn companion_pane(ws: &str, panes: &[Value], caller: &str) -> Option<Value> {
    let kept = read_keep(&format!("{NS}-pane"), ws);
    if !kept.is_empty() {
        if let Some(p) = panes.iter().find(|p| p.get("id").and_then(Value::as_str) == Some(kept.as_str())) {
            return Some(p.clone());
        }
    }
    for older in [crate::wake::WAKE_TAB, crate::wake::WAKE_VIEW] {
        if let Some(p) = pane_of(panes, &read_keep(older, ws)) {
            return Some(p.clone());
        }
    }
    // A pane of pages already at the right (tabs opened before there was a
    // companion): adopt it rather than split a second one beside it.
    let pages = adoptable(ws, panes, caller)?;
    if let Some(id) = pages.get("id").and_then(Value::as_str) {
        write_keep(&format!("{NS}-pane"), ws, id);
    }
    Some(pages)
}

/// The rightmost main pane, not the caller's, whose every surface is one of
/// seamux's own pages (a person's own browser split is never taken); None
/// when cmux cannot list the surfaces' types.
fn adoptable(ws: &str, panes: &[Value], caller: &str) -> Option<Value> {
    let listed = crate::wake::cmux_json(&["list-panels", "--workspace", ws, "--json"])?;
    let surfaces = listed.get("surfaces")?.as_array()?.clone();
    let all_pages = |pane: &Value| {
        let id = pane.get("id").and_then(Value::as_str).unwrap_or("");
        let mine: Vec<&Value> = surfaces.iter().filter(|s| s.get("pane_id").and_then(Value::as_str) == Some(id)).collect();
        !mine.is_empty()
            && mine.iter().all(|s| {
                let sref = s.get("id").or_else(|| s.get("ref")).map(crate::pyval::py_str).unwrap_or_default();
                s.get("type").and_then(Value::as_str) == Some("browser")
                    && seamux_page(&cmux_out(&["browser", "--surface", &sref, "url"]).1.trim().to_string())
            })
    };
    let callers = pane_of(panes, caller).and_then(|p| p.get("id")).cloned();
    panes
        .iter()
        .filter(|p| Some(p.get("id").cloned().unwrap_or(Value::Null)) != callers && all_pages(p))
        .max_by(|a, b| (frame(a, "x") + frame(a, "width")).partial_cmp(&(frame(b, "x") + frame(b, "width"))).unwrap_or(std::cmp::Ordering::Equal))
        .cloned()
}

fn new_id(out: &str) -> String {
    out.split_whitespace().find(|t| is_uuid_token(t)).unwrap_or("").to_string()
}

/// Show `url` in `ws`'s companion under `key`. `caller` is the surface the
/// open came from (it gets the keyboard back unless `focus`). Returns the
/// tab's surface id.
pub fn open(url: &str, key: &str, ws: &str, caller: &str, focus: bool) -> Result<String, String> {
    if !key_ok(key) {
        return Err(format!("not a companion key: {key:?}"));
    }
    let ws = if ws.is_empty() { front() } else { ws.to_string() };
    if ws.is_empty() {
        return Err("cmux did not say which workspace is in front".into());
    }
    let (_, panes) = main_panes(&ws);
    let pane = companion_pane(&ws, &panes, caller);
    let kept = read_keep(&keep_name(key), &ws);
    let give_back = |sid: &str| {
        if focus {
            cmux_ok(&["focus-panel", "--panel", sid, "--workspace", &ws]);
        } else if !caller.is_empty() {
            // Selecting the tab takes the keyboard; the caller gets it back.
            cmux_ok(&["focus-panel", "--panel", sid, "--workspace", &ws]);
            cmux_ok(&["focus-panel", "--panel", caller, "--workspace", &ws]);
        }
    };

    // This key's tab is still in the companion: navigate it.
    if let Some(p) = &pane {
        let has = p.get("surface_ids").and_then(Value::as_array).map(|ids| ids.iter().any(|i| i.as_str() == Some(kept.as_str()))).unwrap_or(false);
        if has && !kept.is_empty() {
            cmux_ok(&["browser", "--surface", &kept, "goto", url]);
            give_back(&kept);
            fit(&ws, &kept);
            return Ok(kept);
        }
    }

    let argv: Vec<String> = match &pane {
        // A new tab in the companion.
        Some(p) => {
            let id = p.get("id").map(crate::pyval::py_str).unwrap_or_default();
            ["new-surface", "--type", "browser", "--pane", &id, "--workspace", &ws, "--url", url].iter().map(|s| s.to_string()).collect()
        }
        // No companion yet: split one off to the right of the caller's pane
        // (else the rightmost pane); new-pane splits the focused one.
        None => {
            let anchor = if !caller.is_empty() && pane_of(&panes, caller).is_some() {
                caller.to_string()
            } else {
                panes
                    .iter()
                    .max_by(|a, b| (frame(a, "x") + frame(a, "width")).partial_cmp(&(frame(b, "x") + frame(b, "width"))).unwrap_or(std::cmp::Ordering::Equal))
                    .and_then(|r| r.get("selected_surface_id"))
                    .map(crate::pyval::str_or_empty)
                    .unwrap_or_default()
            };
            if !anchor.is_empty() {
                cmux_ok(&["focus-panel", "--panel", &anchor, "--workspace", &ws]);
            }
            ["new-pane", "--type", "browser", "--direction", "right", "--workspace", &ws, "--url", url].iter().map(|s| s.to_string()).collect()
        }
    };
    let mut full: Vec<&str> = vec!["--id-format", "uuids"];
    full.extend(argv.iter().map(String::as_str));
    let (rc, out) = cmux_out(&full);
    let sid = if rc == 0 { new_id(&out) } else { String::new() };
    if sid.is_empty() {
        return Err(format!("could not open the companion: {}", out.trim().chars().take(160).collect::<String>()));
    }
    write_keep(&keep_name(key), &ws, &sid);
    // Remember the pane: the surface's pane once cmux has laid it out.
    let pid = settle(
        || {
            let (_, panes) = main_panes(&ws);
            pane_of(&panes, &sid).and_then(|p| p.get("id")).map(crate::pyval::py_str).unwrap_or_default()
        },
        Duration::from_millis(1500),
    );
    if !pid.is_empty() {
        write_keep(&format!("{NS}-pane"), &ws, &pid);
    }
    give_back(&sid);
    fit(&ws, &sid);
    Ok(sid)
}

const USAGE: &str = "usage: seamux companion open <url> --key <key> [--workspace ws] [--surface s] [--focus]";

/// `seamux companion open <url> --key K [--workspace W] [--surface S] [--focus]`.
/// Exit 0 with the tab's surface id; 1 with the reason; 2 on usage.
pub fn main(args: &[String]) -> i32 {
    let mut it = args.iter();
    if it.next().map(String::as_str) != Some("open") {
        eprintln!("{USAGE}");
        return 2;
    }
    let (mut url, mut key, mut ws, mut surface, mut focus) = (String::new(), String::new(), String::new(), String::new(), false);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--key" => key = it.next().cloned().unwrap_or_default(),
            "--workspace" => ws = it.next().cloned().unwrap_or_default(),
            "--surface" => surface = it.next().cloned().unwrap_or_default(),
            "--focus" => focus = true,
            other if url.is_empty() && !other.starts_with("--") => url = other.to_string(),
            _ => {
                eprintln!("{USAGE}");
                return 2;
            }
        }
    }
    if url.is_empty() || key.is_empty() {
        eprintln!("{USAGE}");
        return 2;
    }
    if !url_ok(&url) {
        eprintln!("seamux companion: only loopback pages and local files open in the companion, not {url:?}");
        return 1;
    }
    // The caller's own workspace and pane when it runs in cmux.
    if ws.is_empty() {
        ws = crew_core::py::env_or("CMUX_WORKSPACE_ID").unwrap_or_default();
    }
    if surface.is_empty() && !focus {
        surface = crew_core::py::env_or("CMUX_SURFACE_ID").unwrap_or_default();
    }
    match open(&url, &key, &ws, &surface, focus) {
        Ok(sid) => {
            println!("{sid}");
            0
        }
        Err(e) => {
            eprintln!("seamux companion: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn companion_keys_name_a_page() {
        for k in ["ask-20261022-031500-ab12", "plan-seamux-views", "review-seamux-views-inc1", "wake", "wake-view"] {
            assert!(key_ok(k), "{k}");
        }
        for k in ["", "Plan-x", "plan/x", "../x", "-x", "plan x", &"x".repeat(97)] {
            assert!(!key_ok(k), "{k}");
        }
        assert!(!key_ok("pane") && !key_ok("fit"), "the pane's own keep names");
        assert_eq!(keep_name("plan-a"), "companion-plan-a");
        assert_eq!(keep_name("wake"), "wake", "the Wake's tab keeps its old name");
    }

    #[test]
    fn companion_resize_targets_forty_percent() {
        // A fresh 50/50 split of 1000 points narrows by 100 (-R); a 300 one widens by 100.
        assert_eq!(resize_by(1000.0, 500.0), -100);
        assert_eq!(resize_by(1000.0, 300.0), 100);
        assert_eq!(resize_by(1000.0, 400.0), 0);
        assert_eq!(resize_by(0.0, 300.0), 0, "a workspace off screen has no width to fit");
    }

    #[test]
    fn companion_cli_refuses_usage_and_remote_urls() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(main(&s(&[])), 2);
        assert_eq!(main(&s(&["open", "--key", "plan-a"])), 2, "no url");
        assert_eq!(main(&s(&["open", "http://127.0.0.1:1/plan/a"])), 2, "no key");
        assert_eq!(main(&s(&["open", "https://evil.example/x", "--key", "plan-a"])), 1);
        assert_eq!(main(&s(&["open", "http://127.0.0.1:80@evil.example/x", "--key", "plan-a"])), 1, "userinfo");
        for ok in ["http://127.0.0.1:7345/plan/a", "http://localhost:1/ask/x?t=1", "file:///tmp/plan.html"] {
            assert!(url_ok(ok), "{ok}");
        }
        for bad in ["http://127.0.0.1.evil.example:80/", "http://127.0.0.1:80@h/", "http://127.0.0.1/", "http://127.0.0.1:x/", "file:relative", "https://127.0.0.1:1/"] {
            assert!(!url_ok(bad), "{bad}");
        }
    }
}
