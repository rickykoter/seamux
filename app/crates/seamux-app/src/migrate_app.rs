//! The launch prompt's commands: which sessions on the other backend can
//! move onto this app's, which tmux panes lost with their server can
//! restart, and carrying one out (crew_core::backend::migrate).
//!
//! An apply names an offer by kind and pane; the offers are read again and
//! only one the app found itself is carried out, so the page cannot ask for
//! a move the app did not offer.

use std::collections::HashMap;

use crew_core::backend::migrate::{self, Move, Offer};
use crew_core::backend::tmux::TmuxBackend;
use crew_core::backend::{Backend, Kind};
use serde_json::Value;

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

/// Every offer for the backend this app picked.
fn offers() -> Vec<Offer> {
    let t = TmuxBackend::default();
    let state = crew_core::home::home_cache();
    let pane = |id: &str| crew_core::status::read(&state, id);
    let titles: HashMap<String, String> = t.workspaces().unwrap_or_default().into_iter().map(|w| (w.id.to_ascii_uppercase(), w.title)).collect();
    let title = |ws: &str| titles.get(&ws.to_ascii_uppercase()).cloned().unwrap_or_default();
    match seamux_app::backend::kind() {
        Kind::Tmux => {
            let file = crew_core::py::home().join(".cmux/local-tmux/sessions.json");
            let sessions = std::fs::read_to_string(file).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
            let known: Vec<String> = t.panes(None).unwrap_or_default().into_iter().map(|p| p.id.to_ascii_uppercase()).collect();
            let mut o = migrate::adopt_offers(&sessions, &pane, &crew_core::backend::cmux::live, &|s| known.contains(&s.to_ascii_uppercase()));
            o.extend(migrate::restart_offers(&t.gone().unwrap_or_default(), &title, &pane));
            o
        }
        Kind::Cmux => migrate::resume_offers(&t, &title, &pane),
    }
}

/// What the launch prompt lists; [] when nothing waits.
#[tauri::command]
pub async fn migrate_offers() -> Result<Vec<Value>, String> {
    blocking(|| Ok(offers().iter().map(Offer::to_json).collect())).await
}

/// Carry out the offer of `kind` for `pane`. Err says why not (busy, gone).
#[tauri::command]
pub async fn migrate_apply(kind: String, pane: String) -> Result<String, String> {
    blocking(move || {
        let o = offers()
            .into_iter()
            .find(|o| o.kind.name() == kind && o.pane.eq_ignore_ascii_case(&pane))
            .ok_or_else(|| "that session is no longer on offer".to_string())?;
        migrate::apply(&TmuxBackend::default(), &o)
    })
    .await
}

/// Decline a restart: the gone pane is forgotten and not offered again.
/// A declined move needs nothing: the session stays where it runs.
#[tauri::command]
pub async fn migrate_forget(pane: String) -> Result<(), String> {
    blocking(move || {
        if !offers().iter().any(|o| o.kind == Move::Restart && o.pane.eq_ignore_ascii_case(&pane)) {
            return Err("that pane is not waiting for a restart".into());
        }
        TmuxBackend::default().forget(&pane)
    })
    .await
}
