//! A native pane's links: which file paths in its text exist, opening one in
//! VS Code at its line, the workspace a pane belongs to, and GitHub hover
//! cards. The pure parts live in seamux_app::pane.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use seamux_app::pane::{card, gh_ref, resolve, vscode_url, workspace_of, Card, ISSUE_FIELDS, PR_FIELDS};
use seamux_app::pty::{tmux_bin, Target};
use serde_json::Value;

/// The folder the pane's program works in, as tmux knows it.
pub fn pane_cwd(t: &Target) -> Option<PathBuf> {
    let o = Command::new(tmux_bin())
        .args(["-S", &t.socket, "display-message", "-p", "-t", &format!("={}:", t.session), "#{pane_current_path}"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (o.status.success() && s.starts_with('/')).then(|| PathBuf::from(s))
}

/// Of `cands` (path-like text in the pane), each as the existing absolute
/// path it names, or None.
pub fn existing(t: &Target, cands: &[String]) -> Vec<Option<String>> {
    let Some(cwd) = pane_cwd(t) else { return vec![None; cands.len()] };
    let home = crew_core::py::home();
    cands.iter().map(|c| resolve(&cwd, &home, c).map(|p| p.to_string_lossy().into_owned())).collect()
}

/// The cmux workspace the session belongs to.
pub fn workspace(t: &Target) -> Option<String> {
    let file = crew_core::py::home().join(".cmux/local-tmux/sessions.json");
    let reg: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    workspace_of(&reg, &t.session)
}

/// Open `path` (absolute, existing) in VS Code at `line` and `col`.
#[tauri::command]
pub async fn open_in_editor(path: String, line: Option<u32>, col: Option<u32>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.exists() {
        return Err(format!("not a file here: {path:?}"));
    }
    let url = vscode_url(p, line, col);
    tauri::async_runtime::spawn_blocking(move || {
        let st = Command::new("/usr/bin/open").arg(&url).status().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err("VS Code did not open (is it installed?)".into()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// gh, from PATH or the usual places.
fn gh_bin() -> String {
    let home = crew_core::py::home();
    let local = home.join(".local/bin").to_string_lossy().into_owned();
    for dir in std::env::var("PATH").unwrap_or_default().split(':').chain([local.as_str(), "/opt/homebrew/bin", "/usr/local/bin"]) {
        let p = Path::new(dir).join("gh");
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    "gh".into()
}

/// A GitHub pull request or issue link as a hover card, from gh. None for
/// a link that is neither.
#[tauri::command]
pub async fn gh_card(url: String) -> Result<Option<Card>, String> {
    let Some((kind, url)) = gh_ref(&url) else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || {
        let (sub, fields) = if kind == "pr" { ("pr", PR_FIELDS) } else { ("issue", ISSUE_FIELDS) };
        let o = Command::new(gh_bin()).args([sub, "view", &url, "--json", fields]).stdin(Stdio::null()).output().map_err(|e| format!("gh: {e}"))?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
        }
        let v: Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
        Ok(Some(card(kind, &v)))
    })
    .await
    .map_err(|e| e.to_string())?
}
