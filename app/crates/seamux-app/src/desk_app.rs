//! Desk's commands: answer an agent's question in place, go to a plan's
//! next increment, record a check the person observed. The logic is in the
//! library (`seamux_app::actions`, crew-board's plans) so it is tested there.

use seamux_app::actions;
use seamux_app::wall::terminals;

/// Whether `surface` is a running terminal in cmux right now.
fn live(surface: &str) -> bool {
    cmux::Cmux::connect()
        .and_then(|c| c.current_list(None))
        .map(|v| terminals(&v).iter().any(|t| t.surface.eq_ignore_ascii_case(surface)))
        .unwrap_or(false)
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// Type option `n` into the open question in `workspace`, after its label
/// shows on that pane's screen. Ok is what the screen showed after.
#[tauri::command]
pub async fn desk_answer(workspace: String, n: u32) -> Result<String, String> {
    blocking(move || actions::answer(&crew_core::home::xdg_cache(), &workspace, n, &crew_board::ask::Cmux, &live)).await
}

/// `deep-plan go <slug> <n>`: the person's go-ahead for increment `n`.
#[tauri::command]
pub async fn plan_go(slug: String, n: u32) -> Result<String, String> {
    blocking(move || match crew_board::plans::increment(&slug, &n.to_string(), "go", "") {
        (true, d) => Ok(d),
        (false, d) => Err(d),
    })
    .await
}

/// `deep-plan check pass|fail <slug> <n> <id> <note>`: what the person saw.
#[tauri::command]
pub async fn plan_check(slug: String, n: u32, id: String, verdict: String, note: String) -> Result<String, String> {
    blocking(move || match crew_board::plans::check_record(&slug, &n.to_string(), &id, &verdict, &note) {
        (true, d) => Ok(d),
        (false, d) => Err(d),
    })
    .await
}
