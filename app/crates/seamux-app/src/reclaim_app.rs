//! The reclaim wizard's commands: crew-reclaim's report (`--json`, a dry
//! run that changes nothing) and the reclaim itself (`--yes`, after the
//! person has read that report and pressed Reclaim). crew-reclaim keeps every
//! guard and re-checks them before it deletes; the app only shows and asks.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use seamux_app::reclaim::{steps, ws_ok, Step};
use serde::Serialize;
use serde_json::Value;

fn reclaim_bin() -> PathBuf {
    crew_core::home::crew_home().join("bin/crew-reclaim")
}

/// crew-reclaim for `ws`, run from the home folder (never inside the worktree
/// it removes) with nobody at stdin.
fn run(args: &[&str], ws: &str) -> Result<std::process::Output, String> {
    if !ws_ok(ws) {
        return Err(format!("not a workspace: {ws:?}"));
    }
    let bin = reclaim_bin();
    if !bin.is_file() {
        return Err(format!("crew-reclaim is not installed at {} (crew apply)", bin.display()));
    }
    Command::new(&bin)
        .args(args)
        .arg("--")
        .arg(ws)
        .current_dir(crew_core::py::home())
        // The app is in no workspace: ids it inherited must not trip the
        // "this terminal is in the workspace it closes" guard.
        .env_remove("CMUX_WORKSPACE_ID")
        .env_remove("SEAMUX_WORKSPACE_ID")
        .env_remove("SEAMUX_PANE_ID")
        // The backend the app runs on is the one whose workspaces it reads.
        .env("SEAMUX_BACKEND", seamux_app::backend::kind().name())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("crew-reclaim: {e}"))
}

/// What reclaiming `ws` would do: crew-reclaim's report, every guard checked,
/// nothing changed. Its JSON as is (see crew-reclaim --json).
#[tauri::command]
pub async fn reclaim_check(ws: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let o = run(&["--json"], &ws)?;
        serde_json::from_slice::<Value>(&o.stdout).map_err(|_| {
            let err = String::from_utf8_lossy(&o.stderr);
            let last = err.lines().rev().map(|l| seamux_app::reclaim::strip_ansi(l).trim().to_string()).find(|l| !l.is_empty());
            last.map(|l| l.trim_start_matches("✗ ").to_string()).unwrap_or_else(|| "crew-reclaim gave no report (is crew up to date? crew apply)".into())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Reclaimed {
    ok: bool,
    steps: Vec<Step>,
}

/// Reclaim `ws`: close its workspace, remove its worktree and safe-delete its
/// branch. crew-reclaim checks every guard again first and refuses if one
/// fails; `steps` says what it did, or what stopped it.
#[tauri::command]
pub async fn reclaim_run(ws: String) -> Result<Reclaimed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let o = run(&["--yes"], &ws)?;
        let s = steps(&String::from_utf8_lossy(&o.stdout), &String::from_utf8_lossy(&o.stderr));
        Ok(Reclaimed { ok: o.status.success(), steps: s })
    })
    .await
    .map_err(|e| e.to_string())?
}
