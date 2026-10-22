//! Row actions: what a click on the board does (crew-board-intent act()).
//!
//! A click names a row id and a verb; the row comes from the collector's
//! snapshot (board-targets.json), never from the URL. Anything that touches a
//! worktree or deletes goes through the same `crew:*` notification RPC the
//! Swift sidebar used, so hooks/triage.py stays the one place that decides
//! what those verbs do, including its "ask before deleting" gate.

use std::collections::HashSet;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::cmux_cli::client;
use crate::plans::{plan_page, uuid_ok};
use crate::server::{crew_file, current, log, quote};
use crate::state::state_dir;

pub const ACTIONS: [&str; 22] = [
    "jump", "row", "diff", "pr", "issue", "jira", "checks", "plan", "take the check",
    "review", "code", "reclaim", "archive", "sync", "go", "close plan", "ask",
    "sandbox-up", "sandbox-down", "feed-allow", "feed-deny", "wake",
];

/// Run a child to completion within `timeout`: Some((code, stdout, stderr)),
/// or None when it could not start or ran out of time (then killed).
pub fn spawn_wait(mut cmd: Command, timeout: Duration) -> Option<(i32, String, String)> {
    use std::io::Read;
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Ok(Some(st)) = child.try_wait() {
            break st;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let o = String::from_utf8_lossy(&ro.join().ok()?).into_owned();
    let e = String::from_utf8_lossy(&re.join().ok()?).into_owned();
    Some((status.code().unwrap_or(-1), o, e))
}

/// The Python's `run(argv, cwd)`: fire a command, no shell, 20s, a failure logged.
pub fn run_ok(program: &str, args: &[&str], cwd: Option<&str>) -> bool {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        cmd.current_dir(c);
    }
    match spawn_wait(cmd, Duration::from_secs(20)) {
        Some((0, _, _)) => true,
        Some((rc, _, err)) => {
            log(&format!("FAIL {:?} rc={rc} {}", args.iter().take(3).collect::<Vec<_>>(),
                         err.trim().chars().take(160).collect::<String>()));
            false
        }
        None => {
            log(&format!("FAIL {:?} did not run or timed out", args.iter().take(3).collect::<Vec<_>>()));
            false
        }
    }
}

/// A cmux verb through the client: ok when it exited 0.
pub fn cmux_ok(argv: &[&str]) -> bool {
    let Some(c) = client() else {
        log(&format!("FAIL {:?} cmux is not reachable", argv.iter().take(3).collect::<Vec<_>>()));
        return false;
    };
    match c.cli(argv) {
        Ok(o) if o.ok() => true,
        Ok(o) => {
            log(&format!("FAIL {:?} rc={} {}", argv.iter().take(3).collect::<Vec<_>>(), o.status,
                         o.stderr.trim().chars().take(160).collect::<String>()));
            false
        }
        Err(e) => {
            crate::cmux_cli::failed();
            log(&format!("FAIL {:?} {e}", argv.iter().take(3).collect::<Vec<_>>()));
            false
        }
    }
}

/// (returncode, stdout + stderr) of a cmux verb; a failure is a reason.
pub fn cmux_out(argv: &[&str]) -> (i32, String) {
    let Some(c) = client() else { return (1, "cmux could not run: not reachable".into()) };
    match c.cli(argv) {
        Ok(o) => (o.status, format!("{}{}", o.stdout, o.stderr)),
        Err(e) => {
            crate::cmux_cli::failed();
            (1, format!("cmux could not run: {e}"))
        }
    }
}

fn select(ws: &str) -> bool {
    match client() {
        Some(c) => match c.workspace_select(ws) {
            Ok(()) => true,
            Err(e) => {
                crate::cmux_cli::failed();
                log(&format!("FAIL [\"workspace\", \"select\", {ws:?}] {e}"));
                false
            }
        },
        None => false,
    }
}

/// Post a marked notification: the RPC channel hooks/triage.py dispatches.
/// snake_case only: cmux refuses the whole call over an unknown key.
pub fn notify(subtitle: &str, body: &str, workspace_id: Option<&str>) -> bool {
    let mut p = Map::new();
    p.insert("title".into(), json!("crew"));
    p.insert("subtitle".into(), json!(subtitle));
    p.insert("body".into(), json!(body));
    if let Some(w) = workspace_id.filter(|w| !w.is_empty()) {
        p.insert("workspace_id".into(), json!(w));
    }
    match client() {
        Some(c) => match c.rpc("notification.create", Value::Object(p)) {
            Ok(_) => true,
            Err(e) => {
                crate::cmux_cli::failed();
                log(&format!("FAIL [\"notification.create\"] {e}"));
                false
            }
        },
        None => false,
    }
}

/// The collector's click table.
pub fn targets() -> Map<String, Value> {
    std::fs::read_to_string(crate::state::targets_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn surface_keep(name: &str) -> std::path::PathBuf {
    state_dir().join(format!("plan-surface-{name}"))
}

/// Show a URL in the Dock in the tab kept under `keep`, navigating it in
/// place when it is still there rather than stacking another.
fn dock_tab(keep: &str, url: &str) -> (bool, String) {
    let path = surface_keep(keep);
    let sid = std::fs::read_to_string(&path).map(|s| s.trim().to_string()).unwrap_or_default();
    if !sid.is_empty() && cmux_out(&["browser", "--surface", &sid, "get", "url"]).0 == 0 {
        cmux_ok(&["browser", "--surface", &sid, "goto", url]);
        cmux_ok(&["focus-panel", "--panel", &sid]);
        return (true, format!("focused {sid}"));
    }
    let (rc, out) = cmux_out(&["new-surface", "--type", "browser", "--placement", "dock", "--url", url]);
    if rc != 0 {
        return (false, format!("could not open a Dock surface: {}", out.trim().chars().take(160).collect::<String>()));
    }
    if let Some(new) = out.split_whitespace().find(|t| t.chars().count() == 36 && t.matches('-').count() == 4) {
        let _ = std::fs::create_dir_all(state_dir());
        let _ = std::fs::write(&path, format!("{new}\n"));
    }
    (true, url.to_string())
}

/// A plan in the Dock, served over this server's origin, in its own tab.
pub fn open_plan(slug: &str, port: u16) -> (bool, String) {
    dock_tab(slug, &format!("http://127.0.0.1:{port}/plan/{slug}"))
}

/// A plan beside its workspace's chat, in the companion, when the row names
/// the workspace; the Dock otherwise (a row with no workspace).
pub fn open_plan_in(slug: &str, port: u16, wsid: &str) -> (bool, String) {
    if !crate::plans::uuid_ok(wsid) {
        return open_plan(slug, port);
    }
    match crate::companion::open(&format!("http://127.0.0.1:{port}/plan/{slug}"), &format!("plan-{slug}"), wsid, "", true) {
        Ok(sid) => (true, format!("focused {sid}")),
        Err(e) => (false, e),
    }
}

/// An ask in the Dock: one tab per workspace, navigated in place.
pub fn open_ask(ask_id: &str, port: u16, wsid: &str) -> (bool, String) {
    let key = format!("ask-{}", if wsid.is_empty() { "any" } else { wsid });
    dock_tab(&key, &format!("http://127.0.0.1:{port}/ask/{ask_id}"))
}

/// (node, lookout.mjs) from the pointer lookout's setup wrote, or None.
pub fn lookout_engine() -> Option<(String, String)> {
    let ptr = crew_core::py::home().join(".claude").join("lookout").join("engine.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(ptr).ok()?).ok()?;
    let root = v.get("root").and_then(Value::as_str).unwrap_or("");
    let engine = Path::new(root).join("lookout.mjs");
    let node = which("node").or_else(|| {
        ["/opt/homebrew/bin/node", "/usr/local/bin/node"].iter().find(|c| Path::new(c).exists()).map(|c| c.to_string())
    })?;
    engine.is_file().then(|| (node, engine.to_string_lossy().into_owned()))
}

pub fn which(name: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    std::env::var("PATH").ok()?.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| {
        p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }).map(|p| p.to_string_lossy().into_owned())
}

static DIFF_BUSY: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// The diff chip: this branch against its base as lookout's review beside the
/// row's terminal. One build per worktree at a time; a second press says so.
pub fn lookout_diff(cwd: &str, wsid: &str) -> (bool, String) {
    let Some((node, engine)) = lookout_engine() else { return (false, "lookout is not installed".into()) };
    {
        let mut busy = DIFF_BUSY.lock().unwrap_or_else(|p| p.into_inner());
        let set = busy.get_or_insert_with(HashSet::new);
        if set.contains(cwd) {
            return (true, format!("lookout already opening {cwd}"));
        }
        set.insert(cwd.to_string());
    }
    let res = lookout_diff_run(&node, &engine, cwd, wsid);
    DIFF_BUSY.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashSet::new).remove(cwd);
    res
}

fn lookout_diff_run(node: &str, engine: &str, cwd: &str, wsid: &str) -> (bool, String) {
    let mut cmd = Command::new(node);
    cmd.args([engine, "open", "--view-only", "--at", cwd]).current_dir(cwd).env_remove("CMUX_WORKSPACE_ID");
    if !wsid.is_empty() {
        cmd.env("CMUX_WORKSPACE_ID", wsid);
    }
    match spawn_wait(cmd, Duration::from_secs(90)) {
        None => {
            log(&format!("FAIL lookout diff {cwd}: did not run or timed out"));
            (false, "lookout did not run".into())
        }
        Some((0, _, _)) => (true, format!("lookout {cwd}")),
        Some((_, out, err)) => {
            let why = if err.trim().is_empty() { out } else { err };
            let tail: String = why.trim().chars().rev().take(160).collect::<Vec<_>>().into_iter().rev().collect();
            log(&format!("FAIL lookout diff {cwd}: {tail}"));
            (false, "lookout refused it".into())
        }
    }
}

fn s(row: &Map<String, Value>, k: &str) -> String {
    match row.get(k) {
        Some(Value::String(s)) => s.clone(),
        Some(v) if crate::pyval::truthy(v) => crate::pyval::py_str(v),
        _ => String::new(),
    }
}

fn integrations_jira_site() -> String {
    let v: Value = std::fs::read_to_string(crew_file("integrations.json")).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let j = v.get("jira").cloned().unwrap_or(Value::Null);
    if crate::pyval::truthy(j.get("enabled").unwrap_or(&Value::Null)) {
        crate::pyval::str_or_empty(j.get("site").unwrap_or(&Value::Null))
    } else {
        String::new()
    }
}

fn jira_key_ok(k: &str) -> bool {
    let mut parts = k.splitn(2, '-');
    let (a, b) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let mut ac = a.chars();
    matches!(ac.next(), Some(c) if c.is_ascii_uppercase())
        && a.len() >= 2
        && ac.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && !b.is_empty()
        && b.chars().all(|c| c.is_ascii_digit())
}

/// One click. Returns (ok, detail) for the reply and the log.
pub fn act(action: &str, row: &Map<String, Value>, extra: &str) -> (bool, String) {
    let r = s(row, "ref");
    let wsid = s(row, "id");
    let cwd = s(row, "cwd");
    let pr_url = s(row, "pr_url");
    let mut slug = s(row, "slug");
    let title = s(row, "name");

    match action {
        "jump" | "row" => {
            if r.is_empty() {
                return (false, "no workspace ref".into());
            }
            // By uuid first: a workspace:N ref is renumbered when cmux restarts.
            if uuid_ok(&wsid) && select(&wsid) {
                return (true, format!("select {wsid}"));
            }
            (select(&r), format!("select {r}"))
        }
        "diff" => {
            if cwd.is_empty() || !Path::new(&cwd).is_dir() {
                return (false, "no worktree for this row".into());
            }
            let sel = if uuid_ok(&wsid) { wsid.clone() } else { r.clone() };
            let (ok, why) = lookout_diff(&cwd, &sel);
            if ok {
                if !sel.is_empty() {
                    select(&sel);
                }
                return (true, why);
            }
            if run_ok("bash", &[&crew_file("bin/crew-diff").to_string_lossy(), "branch"], Some(&cwd)) {
                return (true, format!("diff branch in {cwd}"));
            }
            if !r.is_empty() {
                return (cmux_ok(&["diff", "--workspace", &r]), format!("diff --workspace {r}"));
            }
            (false, "no diff available".into())
        }
        "pr" => {
            if pr_url.is_empty() {
                return (false, "no PR on this row".into());
            }
            (run_ok("open", &[&pr_url], None), pr_url)
        }
        "issue" => {
            let u = s(row, "issue_url");
            if u.is_empty() {
                return (false, "no linked issue on this row".into());
            }
            (run_ok("open", &[&u], None), u)
        }
        "jira" => {
            let key = extra.trim();
            if !jira_key_ok(key) {
                return (false, "not a ticket key".into());
            }
            let site = integrations_jira_site();
            if site.is_empty() {
                return (false, "no Jira site configured".into());
            }
            let base = if site.starts_with("http") { site } else { format!("https://{site}") };
            let url = format!("{}/browse/{key}", base.trim_end_matches('/'));
            (run_ok("open", &[&url], None), url)
        }
        "checks" => {
            if pr_url.is_empty() {
                return (false, "no PR on this row".into());
            }
            let u = format!("{pr_url}/checks");
            (run_ok("open", &[&u], None), u)
        }
        "plan" | "take the check" | "review" => {
            if slug.is_empty() {
                slug = extra.trim().to_string();
            }
            if slug.is_empty() {
                return (false, "no plan on this row".into());
            }
            if plan_page(&slug).is_none() {
                return (false, format!("no plan page for {slug}"));
            }
            match current() {
                Some((port, _)) => open_plan_in(&slug, port, &wsid),
                None => (false, "intent server not answering".into()),
            }
        }
        "wake" => {
            // The Wake for this row's workspace, in one tab kept like a plan's:
            // a tap on another row moves it there, switching workspace with it.
            if cwd.is_empty() {
                return (false, "no workspace directory on this row".into());
            }
            match current() {
                Some((port, _)) => crate::wake::for_row(&cwd, &wsid, &r, port),
                None => (false, "intent server not answering".into()),
            }
        }
        "ask" => {
            let ask_id = extra.trim();
            if crate::ask::ask_path(ask_id, ".html").is_none() {
                return (false, "no such ask".into());
            }
            let Some((port, _)) = current() else { return (false, "intent server not answering".into()) };
            let key = if !r.is_empty() { r.clone() } else { cwd.clone() };
            let key: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
            open_ask(ask_id, port, &key)
        }
        "code" => {
            let what = if cwd.is_empty() { title.clone() } else { cwd.clone() };
            (notify("crew:code", &what, Some(&wsid)), format!("code {what}"))
        }
        "reclaim" => (notify("crew:reclaim", &title, Some(&wsid)), format!("reclaim {title}")),
        "archive" => {
            if wsid.is_empty() {
                return (false, "no workspace on this row".into());
            }
            (notify("crew:archive", &title, Some(&wsid)), format!("archive {title}"))
        }
        "sandbox-up" | "sandbox-down" => {
            let what = if cwd.is_empty() { title.clone() } else { cwd.clone() };
            (notify(&format!("crew:{action}"), &what, Some(&wsid)), format!("{action} {what}"))
        }
        "feed-allow" | "feed-deny" => (notify(&format!("crew:{action}"), &title, Some(&wsid)), format!("{action} {title}")),
        "sync" => (notify("crew:sync-now", "refresh", None), "sync".into()),
        "go" => {
            if slug.is_empty() {
                return (false, "no plan on this row".into());
            }
            let n: String = extra.chars().filter(|c| c.is_ascii_digit()).collect();
            if n.is_empty() {
                return (false, "no increment number".into());
            }
            (notify("crew:plan-go", &format!("{slug} {n}"), Some(&wsid)), format!("go {slug} {n}"))
        }
        "close plan" => {
            if slug.is_empty() {
                return (false, "no plan on this row".into());
            }
            let script = crew_core::dp_engine::script().to_string_lossy().into_owned();
            (run_ok("node", &[&script, "close", &slug], None), format!("close {slug}"))
        }
        _ => (false, format!("unknown action: {action}")),
    }
}

/// `urllib.parse.quote(x, safe="")`, for a URL this module builds.
pub fn q(x: &str) -> String {
    quote(x, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jira_keys_are_checked_like_the_python() {
        assert!(jira_key_ok("PROJ-1039") && jira_key_ok("A1-2"));
        assert!(!jira_key_ok("P-1") && !jira_key_ok("proj-1") && !jira_key_ok("PROJ-") && !jira_key_ok("PROJ-1a"));
    }
}
