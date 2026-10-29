//! The seamux app. cmux is the engine behind its socket; every call goes
//! through crates/cmux. Increment 1: connect at start and list the open
//! workspaces, or name why it can't, so a dead cmux never means a blank window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desk_app;
mod newws_app;
mod pane_app;
mod pty_app;
mod reclaim_app;
mod review_app;
mod shell;
mod term_app;
mod tuck_app;
mod views_app;
mod wake_app;
mod wall_app;

use serde::Serialize;
use serde_json::Value;

/// What the page shows on load: the connection, or why there is none.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Status {
    Connected {
        transport: String,
        access_mode: Option<String>,
        workspaces: Vec<Workspace>,
    },
    Failed {
        /// A short name the page can switch on.
        kind: String,
        /// cmux's own words, for the person reading.
        message: String,
    },
}

#[derive(Debug, Serialize, PartialEq)]
struct Workspace {
    id: String,
    r#ref: String,
    title: String,
}

fn failed(err: &cmux::Error) -> Status {
    let kind = match err {
        cmux::Error::Unavailable(_) | cmux::Error::Io(_) | cmux::Error::Closed => "unavailable",
        cmux::Error::Refused { code, .. } if code == "method_not_found" => "missing_method",
        cmux::Error::Refused { .. } => "refused",
        cmux::Error::Cli { .. } => "cli",
        cmux::Error::BadHandle(_) => "bad_handle",
        cmux::Error::Protocol(_) => "protocol",
    };
    Status::Failed { kind: kind.into(), message: err.to_string() }
}

/// The workspace rows from `workspace.list`, whichever transport answered:
/// the socket wraps them in `{"workspaces": [...]}`, the CLI may not.
fn workspaces_from(v: &Value) -> Vec<Workspace> {
    let rows = v.get("workspaces").unwrap_or(v);
    let field = |w: &Value, k: &str| w.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    rows.as_array()
        .map(|a| {
            a.iter()
                .map(|w| Workspace { id: field(w, "id"), r#ref: field(w, "ref"), title: field(w, "title") })
                .collect()
        })
        .unwrap_or_default()
}

fn status_of(conn: Result<cmux::Cmux, cmux::Error>) -> Status {
    let c = match conn {
        Ok(c) => c,
        Err(e) => return failed(&e),
    };
    match c.workspace_list(None) {
        Ok(v) => Status::Connected {
            transport: match c.transport() {
                cmux::Transport::Socket(_) => "socket".into(),
                cmux::Transport::Cli(_) => "cli".into(),
            },
            access_mode: c.access_mode(),
            workspaces: workspaces_from(&v),
        },
        Err(e) => failed(&e),
    }
}

/// Async so Tauri runs it off the main thread, and the socket I/O goes to a
/// blocking worker: a hung cmux must not freeze the window it would report on.
#[tauri::command]
async fn cmux_status() -> Status {
    tauri::async_runtime::spawn_blocking(|| status_of(cmux::Cmux::connect()))
        .await
        .unwrap_or_else(|e| Status::Failed { kind: "app".into(), message: e.to_string() })
}

/// Where node usually is when launchd's PATH lacks it: asdf, volta,
/// Homebrew (both prefixes), and ~/.local/bin for seamux's own links.
const NODE_DIRS: [&str; 5] = ["~/.asdf/shims", "~/.volta/bin", "/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin"];

/// An app opened from Finder gets launchd's PATH (/usr/bin:/bin:...), where
/// node, git's helpers and the cmux CLI may be missing; the in-process crew
/// calls need them. Once, before any thread: the usual places first, and
/// only if node is in none of them, the login shell's PATH (an interactive
/// shell, since asdf and nvm hook in from .zshrc), capped at two seconds.
fn adopt_login_path() {
    let old = std::env::var("PATH").unwrap_or_default();
    let has_node = |path: &str| path.split(':').any(|d| std::path::Path::new(d).join("node").is_file());
    if has_node(&old) {
        return;
    }
    let home = crew_core::py::home();
    let known: Vec<String> = NODE_DIRS
        .iter()
        .map(|d| d.strip_prefix("~/").map(|r| home.join(r).to_string_lossy().into_owned()).unwrap_or_else(|| d.to_string()))
        .filter(|d| std::path::Path::new(d).is_dir() && !old.split(':').any(|o| o == d))
        .collect();
    let with_known = [known.join(":"), old.clone()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(":");
    if has_node(&with_known) {
        std::env::set_var("PATH", with_known);
        return;
    }
    let shell = crew_core::py::env_or("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let Some((0, out, _)) = crew_core::py::run(&shell, &["-ilc", "printf '%s' \"$PATH\""], std::time::Duration::from_secs(2)) else {
        return;
    };
    // The last line: a login shell may print a banner before it.
    let login = out.lines().last().unwrap_or("").trim();
    if !login.is_empty() {
        std::env::set_var("PATH", if old.is_empty() { login.to_string() } else { format!("{login}:{old}") });
    }
}

/// An app opened from Finder gets no locale either. cmux's `local-tmux start`
/// cannot verify the session it made without a UTF-8 one, and Claude in that
/// session would draw its UI wrong. Once, before any thread, as above.
fn adopt_utf8_locale() {
    let set = |k: &str| std::env::var(k).is_ok_and(|v| !v.is_empty());
    if !["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| set(k)) {
        std::env::set_var("LANG", "en_US.UTF-8");
    }
}

fn main() {
    adopt_login_path();
    adopt_utf8_locale();
    tauri::Builder::default()
        .setup(|app| {
            shell::install(app)?;
            wall_app::start(app.handle().clone());
            views_app::start(app.handle().clone());
            review_app::start(app.handle().clone());
            term_app::restore_at_start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmux_status,
            shell::intent_server,
            shell::intent_page,
            shell::hide_overlay,
            wall_app::wall_frame,
            wall_app::wall_reply,
            wall_app::wall_jump,
            wall_app::move_native,
            wall_app::workspace_sessions,
            wall_app::session_resume,
            wall_app::desk_cleanup_plan,
            wall_app::desk_cleanup_run,
            review_app::review_jobs,
            review_app::review_start,
            review_app::review_findings,
            review_app::review_fix,
            review_app::review_post,
            review_app::review_push,
            review_app::review_remove,
            review_app::review_suggest,
            review_app::review_others,
            term_app::term_frame,
            term_app::term_input,
            term_app::term_key,
            term_app::term_paste,
            term_app::term_hold,
            term_app::term_release,
            term_app::open_url,
            term_app::copy_text,
            term_app::open_in_vscode,
            term_app::term_look,
            pty_app::pty_native,
            pty_app::pty_attach,
            pty_app::pty_write,
            pty_app::pty_resize,
            pty_app::pty_detach,
            pty_app::pty_leave_scroll,
            pty_app::pty_paths,
            pty_app::pty_scroll,
            pty_app::pty_seen,
            pty_app::pty_shell,
            pty_app::pty_line_key,
            pty_app::pty_workspace,
            pane_app::open_in_editor,
            pane_app::gh_card,
            reclaim_app::reclaim_check,
            reclaim_app::reclaim_run,
            pty_app::pty_reset,
            pty_app::native_session,
            views_app::views_frame,
            shell::open_in_cmux,
            desk_app::desk_answer,
            desk_app::plan_go,
            desk_app::plan_check,
            wake_app::wake_data,
            wake_app::wake_open,
            wake_app::wake_keep,
            wake_app::wake_keep_all,
            wake_app::wake_publish,
            wake_app::home_dir,
            wake_app::wake_file,
            tuck_app::tuck_set,
            tuck_app::tuck_restore,
            tuck_app::tuck_unmute_all,
            newws_app::new_ws_options,
            newws_app::new_ws_create
        ])
        .build(tauri::generate_context!())
        .expect("seamux app failed to start")
        .run(|_, e| {
            // A clean quit stops a review's agents. A crash or SIGKILL skips
            // this; the saved pgid and its start time catch that next launch.
            if let tauri::RunEvent::Exit = e {
                review_app::stop_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_from_the_socket_shape() {
        let v = json!({"workspaces": [{"id": "A-1", "ref": "workspace:1", "title": "one", "extra": 1}]});
        assert_eq!(
            workspaces_from(&v),
            vec![Workspace { id: "A-1".into(), r#ref: "workspace:1".into(), title: "one".into() }]
        );
    }

    #[test]
    fn rows_from_a_bare_array() {
        let v = json!([{"id": "B", "ref": "workspace:2"}]);
        assert_eq!(workspaces_from(&v)[0].title, "");
        assert_eq!(workspaces_from(&json!({})), vec![]);
    }

    #[test]
    fn errors_are_named() {
        let down = failed(&cmux::Error::Unavailable("no socket at /tmp/x".into()));
        assert!(matches!(down, Status::Failed { ref kind, .. } if kind == "unavailable"));
        let missing = failed(&cmux::Error::Refused { code: "method_not_found".into(), message: "workspace.list".into() });
        assert!(matches!(missing, Status::Failed { ref kind, .. } if kind == "missing_method"));
    }

    #[test]
    fn status_through_fakecmux() {
        // The CLI transport, handed fakecmux directly: the whole
        // connect-and-list path with no cmux app and no process-wide env.
        let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../crew/tools/fakecmux.py");
        let dir = std::env::temp_dir().join(format!("seamux-app-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = cmux::Cmux::open(cmux::Transport::Cli(fake))
            .map(|c| c.with_cli_env("FAKE_CMUX_DIR", dir.to_str().unwrap()));
        let s = status_of(conn);
        let _ = std::fs::remove_dir_all(&dir);
        match s {
            Status::Connected { transport, .. } => assert_eq!(transport, "cli"),
            Status::Failed { kind, message } => panic!("fakecmux status failed: {kind}: {message}"),
        }
    }
}
