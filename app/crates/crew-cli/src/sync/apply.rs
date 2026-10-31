//! crew-sync's writes to cmux, every one through crates/cmux and every one a
//! no-op under --dry-run. A failed write is ignored, as the Python's `cmux()`
//! ignored it: the next sync sees the same wrong value and tries again.
//!
//! With no cmux, the app's tmux backend stands in when its registry has
//! workspaces: they are the rows, and the description and pull request are
//! written to their registry records, where the board reads them. Every
//! other write is cmux's sidebar and has nowhere to go there.

use cmux::{Cmux, Notify, Transport, WorkspaceAction};
use crew_core::backend::tmux::TmuxBackend;
use crew_core::backend::Backend;
use serde_json::{json, Value};

use crate::pyval::truthy;

pub struct Writer {
    /// The client every op goes through; None when cmux is unreachable.
    pub c: Option<Cmux>,
    /// The client for `workspace list`, which the Python ran with CMUX_QUIET=1.
    pub quiet: Option<Cmux>,
    pub dry: bool,
    /// The app's tmux backend, when there is no cmux and it has workspaces.
    pub tmux: Option<TmuxBackend>,
}

impl Writer {
    pub fn connect(dry: bool) -> Writer {
        let c = Cmux::connect().ok();
        let tmux = if c.is_some() { None } else { Some(TmuxBackend::default()).filter(|b| b.facts().is_ok_and(|f| !f.is_empty())) };
        Writer { c, quiet: Cmux::connect().ok().map(|c| c.with_cli_env("CMUX_QUIET", "1")), dry, tmux }
    }

    fn write(&self, f: impl FnOnce(&Cmux) -> Result<(), cmux::Error>) {
        if self.dry {
            return;
        }
        if let Some(c) = &self.c {
            let _ = f(c);
        }
    }

    // --- reads (made under --dry-run too) -------------------------------------

    /// `workspace list --json`'s rows; [] when cmux does not answer. On the
    /// tmux backend, its registry's workspaces in that shape.
    pub fn workspaces(&self) -> Vec<Value> {
        if let (None, Some(t)) = (&self.quiet, &self.tmux) {
            return tmux_rows(t);
        }
        let Some(c) = &self.quiet else { return vec![] };
        match c.workspace_list(None) {
            Ok(v) => match v.get("workspaces") {
                Some(Value::Array(a)) => a.clone(),
                _ => vec![],
            },
            Err(_) => vec![],
        }
    }

    /// This workspace's description as cmux has it now, or None if unknown.
    pub fn live_description(&self, ws: &str) -> Option<String> {
        for w in self.workspaces() {
            if w.get("id").and_then(Value::as_str) == Some(ws) {
                return Some(match w.get("description") {
                    Some(v) if truthy(Some(v)) => crate::pyval::py_str(v),
                    _ => String::new(),
                });
            }
        }
        None
    }

    /// `sidebar-state --workspace W`'s text, "" when it failed.
    pub fn sidebar_state(&self, ws: &str) -> String {
        self.c.as_ref().and_then(|c| c.sidebar_state(ws).ok()).unwrap_or_default()
    }

    /// The pinned lane, "" when automatic. On the CLI this reads the text with
    /// crew-sync's own pattern (`override:\s*(\S+)` anywhere), so a stand-in
    /// that prints only that line reads the same as cmux.
    pub fn lane(&self, ws: &str) -> String {
        let Some(c) = &self.c else { return String::new() };
        let lane = match c.transport() {
            Transport::Cli(_) => {
                let out = c.cli(&["workspace", "status", "--workspace", ws]).map(|o| o.stdout).unwrap_or_default();
                override_in(&out)
            }
            Transport::Socket(_) => c
                .workspace_status(ws)
                .ok()
                .and_then(|v| v.get("override").and_then(Value::as_str).map(String::from))
                .unwrap_or_default(),
        };
        if lane == "none" {
            String::new()
        } else {
            lane
        }
    }

    // --- writes -------------------------------------------------------------------

    pub fn rename(&self, ws: &str, title: &str) {
        self.write(|c| c.rename_workspace(ws, title));
    }

    pub fn set_progress(&self, ws: &str, frac: f64, label: &str) {
        self.write(|c| c.set_progress(ws, frac, label));
    }

    pub fn todo_set(&self, ws: &str, items_json: &str) {
        self.write(|c| c.todo_set(ws, items_json));
    }

    pub fn clear_progress(&self, ws: &str) {
        self.write(|c| c.clear_progress(ws));
    }

    pub fn clear_status(&self, key: &str, ws: &str) {
        self.write(|c| c.clear_status(key, Some(ws)));
    }

    pub fn action(&self, ws: &str, a: WorkspaceAction) {
        if let (None, Some(t), false) = (&self.c, &self.tmux, self.dry) {
            match &a {
                WorkspaceAction::SetDescription(d) => {
                    let _ = t.set_facts(ws, Some(d), None);
                }
                WorkspaceAction::ClearDescription => {
                    let _ = t.set_facts(ws, Some(""), None);
                }
                _ => {}
            }
            return;
        }
        self.write(|c| c.workspace_action(ws, &a));
    }

    /// The workspace's pull request from its probe ({n, state, url}, or
    /// null with none), for the board's PR chip on the tmux backend. cmux
    /// shows its own, so this writes only there.
    pub fn pr(&self, ws: &str, raw: &serde_json::Map<String, Value>) {
        let (Some(t), false) = (&self.tmux, self.dry) else { return };
        let pr = match raw.get("pr").filter(|v| truthy(Some(v))) {
            Some(n) => json!({"n": n, "state": raw.get("prState").cloned().unwrap_or(Value::Null),
                              "url": raw.get("url").cloned().unwrap_or(Value::Null)}),
            None => Value::Null,
        };
        let _ = t.set_facts(ws, None, Some(pr));
    }

    pub fn lane_auto(&self, ws: &str) {
        self.write(|c| c.workspace_status_set(ws, "auto"));
    }

    pub fn notify(&self, n: Notify) {
        self.write(|c| c.notify(&n));
    }
}

/// The tmux registry's workspaces in workspace.list's shape, each with the
/// description crew-sync last wrote. Their titles are the app's own, never
/// renamed here.
fn tmux_rows(t: &TmuxBackend) -> Vec<Value> {
    let desc: std::collections::HashMap<String, String> = t.facts().unwrap_or_default().into_iter().map(|(id, d, _)| (id, d)).collect();
    t.workspaces()
        .unwrap_or_default()
        .into_iter()
        .map(|w| json!({"id": w.id, "title": w.title, "current_directory": w.cwd,
                        "description": desc.get(&w.id).cloned().unwrap_or_default(), "has_custom_title": true}))
        .collect()
}

/// `re.search(r"override:\s*(\S+)", out)`'s group, or "".
fn override_in(out: &str) -> String {
    let mut rest = out;
    while let Some(i) = rest.find("override:") {
        let after = rest[i + "override:".len()..].trim_start_matches(char::is_whitespace);
        let word: String = after.chars().take_while(|c| !c.is_whitespace()).collect();
        if !word.is_empty() {
            return word;
        }
        rest = &rest[i + 1..];
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_tmux_rows_come_from_the_registry_and_only_facts_are_written() {
        let dir = std::path::PathBuf::from(format!("/tmp/sx-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("workspaces.json"),
            r#"{"version":1,"workspaces":[{"id":"W1","title":"shop","cwd":"/w","description":"ci:run"}],"panes":[]}"#).unwrap();
        let w = Writer { c: None, quiet: None, dry: false, tmux: Some(TmuxBackend::at(dir.clone())) };
        let rows = w.workspaces();
        assert_eq!(rows, vec![json!({"id": "W1", "title": "shop", "current_directory": "/w", "description": "ci:run", "has_custom_title": true})]);
        assert_eq!(w.live_description("W1").as_deref(), Some("ci:run"));
        // Sidebar writes have nowhere to go; the description and the PR do.
        w.rename("W1", "other");
        w.action("W1", WorkspaceAction::SetColor("#FF0000".into()));
        w.action("W1", WorkspaceAction::SetDescription("ci:fail pr:draft".into()));
        let mut raw = serde_json::Map::new();
        raw.insert("pr".into(), json!(9));
        raw.insert("prState".into(), json!("OPEN"));
        raw.insert("url".into(), json!("https://x/9"));
        w.pr("W1", &raw);
        let t = TmuxBackend::at(dir.clone());
        let f = t.facts().unwrap();
        assert_eq!(f[0].1, "ci:fail pr:draft");
        assert_eq!(f[0].2, json!({"n": 9, "state": "OPEN", "url": "https://x/9"}));
        assert_eq!(t.workspaces().unwrap()[0].title, "shop", "no rename on tmux");
        // A dry run writes nothing.
        let dry = Writer { dry: true, ..w };
        dry.action("W1", WorkspaceAction::ClearDescription);
        assert_eq!(t.facts().unwrap()[0].1, "ci:fail pr:draft");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn override_is_found_anywhere() {
        assert_eq!(override_in("override: review\n"), "review");
        assert_eq!(override_in("working\ninferred: working\noverride: none (auto)\n"), "none");
        assert_eq!(override_in("override:\n  needs-attention"), "needs-attention");
        assert_eq!(override_in("nothing here"), "");
    }
}
