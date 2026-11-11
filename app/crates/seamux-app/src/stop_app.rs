//! Why a native pane's turn stopped (an API error or a limit, which the
//! hooks write as `limited`), for the banner over the pane: what happened,
//! when the app tries again, and a way to stop it trying.

use crew_core::status::{self, Pane};
use serde_json::{json, Value};

/// The pane file of `surface`, as the hooks keyed it.
fn pane_of(surface: &str) -> Option<Pane> {
    let dir = crew_core::home::xdg_cache();
    [surface.to_string(), surface.to_uppercase(), surface.to_lowercase()].iter().find_map(|k| status::read(&dir, k))
}

/// The banner's facts, or None while the pane is not stopped.
pub fn banner(p: &Pane) -> Option<Value> {
    let l = p.limited.as_ref().filter(|_| p.state == "idle")?;
    let api = status::API_ERRORS.contains(&l.error.as_str());
    let label = if api { status::error_label(&l.error).to_string() } else {
        l.window.as_deref().map(crew_core::limits::window_label).unwrap_or(status::error_label(&l.error)).to_string()
    };
    Some(json!({"error": l.error, "label": label, "detail": l.detail, "api": api,
                "retry": status::RETRY_ERRORS.contains(&l.error.as_str()), "login": l.error == "authentication_failed",
                "next_try": l.next_try, "tries": l.tries, "gave_up": l.gave_up, "resets_at": l.resets_at, "at": l.at}))
}

#[tauri::command]
pub async fn pane_stop(surface: String) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || pane_of(&surface).as_ref().and_then(banner)).await.map_err(|e| e.to_string())
}

/// Stop the app trying the pane's turn again: it waits for you.
#[tauri::command]
pub async fn pane_stop_cancel(surface: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = pane_of(&surface).ok_or("no pane file")?;
        let l = p.limited.clone().ok_or("the pane is not stopped")?;
        Ok(status::update_limited(&crew_core::home::xdg_cache(), p.key(), &l, |x| x.gave_up = Some("you stopped the retries".into())))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stopped(error: &str) -> Pane {
        let mut p = Pane::new("W", "S");
        p.limited = Some(status::Limited { error: error.into(), session: "s".into(), at: 1, window: None, resets_at: None, tries: 1,
                                           next_try: Some(5), gave_up: None, detail: Some("Overloaded".into()) });
        p
    }

    #[test]
    fn a_stopped_pane_says_why_and_what_comes_next() {
        let b = banner(&stopped("overloaded")).unwrap();
        assert_eq!((b["label"].as_str(), b["retry"].as_bool(), b["login"].as_bool()), (Some("API overloaded"), Some(true), Some(false)));
        assert_eq!((b["detail"].as_str(), b["next_try"].as_u64()), (Some("Overloaded"), Some(5)));
        let b = banner(&stopped("authentication_failed")).unwrap();
        assert_eq!((b["retry"].as_bool(), b["login"].as_bool()), (Some(false), Some(true)));
        let b = banner(&stopped("rate_limit")).unwrap();
        assert_eq!((b["label"].as_str(), b["api"].as_bool()), (Some("rate limited"), Some(false)));
    }

    #[test]
    fn a_pane_at_work_again_has_no_banner() {
        let mut p = stopped("overloaded");
        p.state = "working".into();
        assert!(banner(&p).is_none());
        assert!(banner(&Pane::new("W", "S")).is_none());
    }
}
