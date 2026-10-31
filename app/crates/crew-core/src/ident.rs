//! Which workspace and pane this process belongs to.
//!
//! A backend sets SEAMUX_WORKSPACE_ID and SEAMUX_PANE_ID in every session it
//! starts: cmux's own ids for a native session in cmux, the app's for one on
//! the tmux backend. A plain cmux pane has only CMUX_WORKSPACE_ID and
//! CMUX_SURFACE_ID, so those are read next and its keys stay what they were.

/// The workspace: SEAMUX_WORKSPACE_ID, else CMUX_WORKSPACE_ID.
pub fn workspace_id() -> Option<String> {
    workspace_id_in(&env)
}

/// The pane: SEAMUX_PANE_ID, else CMUX_SURFACE_ID, else "".
pub fn pane_id() -> String {
    pane_id_in(&env)
}

/// Whether this process runs in a cmux pane, so cmux is there to decorate.
pub fn in_cmux() -> bool {
    in_cmux_in(&env)
}

/// `in_cmux`, reading variables through `get`. A session the tmux backend
/// started says SEAMUX_BACKEND=tmux: a CMUX_WORKSPACE_ID it inherited (the
/// app launched from a cmux terminal) is not a cmux pane.
pub fn in_cmux_in(get: &dyn Fn(&str) -> Option<String>) -> bool {
    get("CMUX_WORKSPACE_ID").is_some() && get("SEAMUX_BACKEND").as_deref() != Some("tmux")
}

fn env(k: &str) -> Option<String> {
    crate::py::env_or(k)
}

/// `workspace_id`, reading variables through `get` (tests pass a map).
pub fn workspace_id_in(get: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    get("SEAMUX_WORKSPACE_ID").or_else(|| get("CMUX_WORKSPACE_ID"))
}

/// `pane_id`, reading variables through `get`.
pub fn pane_id_in(get: &dyn Fn(&str) -> Option<String>) -> String {
    get("SEAMUX_PANE_ID").or_else(|| get("CMUX_SURFACE_ID")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).filter(|v| !v.is_empty()).cloned()
    }

    #[test]
    fn seamux_ids_come_first() {
        let g = with(&[("SEAMUX_WORKSPACE_ID", "W1"), ("SEAMUX_PANE_ID", "P1"), ("CMUX_WORKSPACE_ID", "W2"), ("CMUX_SURFACE_ID", "P2")]);
        assert_eq!(workspace_id_in(&g).as_deref(), Some("W1"));
        assert_eq!(pane_id_in(&g), "P1");
    }

    #[test]
    fn a_plain_cmux_pane_keeps_its_cmux_ids() {
        let g = with(&[("CMUX_WORKSPACE_ID", "W2"), ("CMUX_SURFACE_ID", "P2")]);
        assert_eq!(workspace_id_in(&g).as_deref(), Some("W2"));
        assert_eq!(pane_id_in(&g), "P2");
    }

    #[test]
    fn a_tmux_backend_pane_is_not_in_cmux_even_with_a_stale_cmux_id() {
        assert!(in_cmux_in(&with(&[("CMUX_WORKSPACE_ID", "W2")])));
        assert!(in_cmux_in(&with(&[("CMUX_WORKSPACE_ID", "W2"), ("SEAMUX_BACKEND", "cmux")])));
        assert!(!in_cmux_in(&with(&[("CMUX_WORKSPACE_ID", "W2"), ("SEAMUX_BACKEND", "tmux"), ("SEAMUX_WORKSPACE_ID", "W1")])));
        assert!(!in_cmux_in(&with(&[("SEAMUX_WORKSPACE_ID", "W1")])));
    }

    #[test]
    fn no_ids_is_no_workspace() {
        let g = with(&[("SEAMUX_WORKSPACE_ID", "")]);
        assert_eq!(workspace_id_in(&g), None);
        assert_eq!(pane_id_in(&g), "");
    }
}
