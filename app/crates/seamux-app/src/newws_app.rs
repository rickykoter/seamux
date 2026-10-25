//! The Dock's New workspace form: what it can offer, and making one with no
//! terminal (crew_core::worktree), each step streamed back over a Channel.
//! Claude starts as a native session (pty.rs), as the Dock's own button does.

use crew_core::worktree::{self, Phase, Request, SandboxMode, Settings, Step};
use seamux_app::pty::open_native_workspace;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Serialize)]
pub struct RepoRow {
    name: String,
    path: String,
    base: String,
}

#[derive(Serialize)]
pub struct Options {
    repos: Vec<RepoRow>,
    /// Put before a branch name without a `/`.
    prefix: String,
    /// Remote Control's default.
    remote: bool,
    /// crew-sandbox is installed.
    sandbox: bool,
}

/// The repos to offer and the defaults the form starts from.
#[tauri::command]
pub async fn new_ws_options() -> Result<Options, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let s = Settings::from_env();
        let repos = worktree::repos(&s)
            .into_iter()
            .map(|r| RepoRow { name: r.name, path: r.path.to_string_lossy().into_owned(), base: r.base })
            .collect();
        Options { repos, prefix: s.prefix.clone(), remote: s.remote, sandbox: s.bin.join("crew-sandbox").is_file() }
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    repo: String,
    branch: String,
    base: Option<String>,
    prompt: Option<String>,
    /// "link" or "isolated"; none for no sandbox.
    sandbox: Option<String>,
    remote: Option<bool>,
}

/// One step's news, as the form draws it.
#[derive(Clone, Serialize)]
pub struct StepMsg {
    step: &'static str,
    /// start, done, warn or failed.
    phase: &'static str,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Made {
    path: String,
    branch: String,
    workspace_ref: String,
    workspace_id: Option<String>,
}

/// Make the worktree and its workspace. Every step's start and end reach
/// `on_step`; the result is what was made, or the step's error.
#[tauri::command]
pub async fn new_ws_create(form: Form, on_step: Channel<StepMsg>) -> Result<Made, String> {
    let sandbox = form.sandbox.as_deref().filter(|m| !m.is_empty()).map(SandboxMode::parse).transpose()?;
    if sandbox.is_some() && form.prompt.as_deref().is_some_and(|p| !p.trim().is_empty()) {
        return Err("a sandboxed workspace cannot take a first prompt yet".into());
    }
    let req = Request { repo: form.repo, branch: form.branch, base: form.base, prompt: form.prompt, sandbox, remote: form.remote };
    tauri::async_runtime::spawn_blocking(move || {
        let s = Settings::from_env();
        let mut tell = |st: Step, ph: Phase, detail: &str| {
            let phase = match ph {
                Phase::Start => "start",
                Phase::Done => "done",
                Phase::Warn => "warn",
                Phase::Failed => "failed",
            };
            let _ = on_step.send(StepMsg { step: st.key(), phase, detail: detail.to_string() });
        };
        worktree::create(&s, &req, &open_native_workspace, &mut tell).map(|m| Made {
            path: m.path.to_string_lossy().into_owned(),
            branch: m.branch,
            workspace_ref: m.workspace_ref,
            workspace_id: m.workspace_id,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
