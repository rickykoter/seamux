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
