//! The Doctor tab's commands (app/ui/doctor.ts): crew_core::doctor's scan
//! and its fixes. A fix names a finding by id; the doctor scans again and
//! acts only on a finding it found itself, so the page cannot ask for a
//! repair the scan did not offer.

use crew_core::doctor::{Doctor, Done};
use serde_json::Value;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// What is broken: the scan, {tmux, registry, findings}. On cmux, null:
/// the doctor covers the app's tmux only.
#[tauri::command]
pub async fn doctor_scan() -> Result<Value, String> {
    blocking(|| {
        if seamux_app::backend::kind() != crew_core::backend::Kind::Tmux {
            return Ok(Value::Null);
        }
        Ok(Doctor::default().scan().to_json())
    })
    .await
}

/// Carry out fix `verb` on finding `id`: what it did, or why not.
#[tauri::command]
pub async fn doctor_fix(id: String, verb: String) -> Result<String, String> {
    blocking(move || Doctor::default().fix(&id, &verb, false)).await
}

/// Every safe finding's fix, each one's outcome.
#[tauri::command]
pub async fn doctor_fix_safe() -> Result<Vec<Value>, String> {
    blocking(|| Ok(Doctor::default().fix_safe(false)?.iter().map(Done::to_json).collect())).await
}

// --- All workspaces: crew-resume's rows, and archive, restore, forget,
// resume. Each acts only on a row the rows read again still hold, in the
// state the page drew it in.

/// The row at `cwd` now, if it is in `state`.
fn row_in(cwd: &str, state: &str) -> Result<Value, String> {
    let rows = crew_cli::resume::app_rows();
    rows["rows"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["cwd"] == cwd).cloned())
        .filter(|r| r["state"] == state)
        .ok_or_else(|| format!("{cwd} is no longer {state}: look again"))
}

/// Every workspace directory, live, archived, past or gone.
#[tauri::command]
pub async fn doctor_rows() -> Result<Value, String> {
    blocking(|| Ok(crew_cli::resume::app_rows())).await
}

/// Archive the live workspace at `cwd`: closed and remembered. deep-plan's
/// guard is asked and not overridden; a mid-turn Claude is refused.
#[tauri::command]
pub async fn doctor_archive(cwd: String) -> Result<String, String> {
    blocking(move || {
        let row = row_in(&cwd, "live")?;
        let ws = row["ws"].as_str().unwrap_or("").to_string();
        let (ok, msg) = crew_core::workspaces::archive_with(&ws, None, None, crew_core::workspaces::Guard::Ask { family_ok: false });
        if ok { Ok(msg) } else { Err(msg) }
    })
    .await
}

/// Reopen the archived workspace at `cwd`, resuming its Claude.
#[tauri::command]
pub async fn doctor_restore(cwd: String) -> Result<String, String> {
    blocking(move || {
        row_in(&cwd, "archived")?;
        let (ok, msg) = crew_core::workspaces::restore(&cwd);
        if ok { Ok(msg) } else { Err(msg) }
    })
    .await
}

/// Drop the archive record at `cwd`.
#[tauri::command]
pub async fn doctor_forget(cwd: String) -> Result<String, String> {
    blocking(move || {
        row_in(&cwd, "archived")?;
        if crew_core::workspaces::forget(&cwd) { Ok(format!("forgot {cwd}")) } else { Err(format!("nothing archived at {cwd}")) }
    })
    .await
}

/// Resume the past workspace at `cwd`'s latest session in a new workspace.
#[tauri::command]
pub async fn doctor_resume(cwd: String) -> Result<String, String> {
    blocking(move || {
        row_in(&cwd, "past")?;
        crew_cli::resume::resume_latest(&cwd)
    })
    .await
}
