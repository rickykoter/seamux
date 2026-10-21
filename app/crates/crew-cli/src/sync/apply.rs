//! crew-sync's writes to cmux, every one through crates/cmux and every one a
//! no-op under --dry-run. A failed write is ignored, as the Python's `cmux()`
//! ignored it: the next sync sees the same wrong value and tries again.

use cmux::{Cmux, Notify, Transport, WorkspaceAction};
use serde_json::Value;

use crate::pyval::truthy;

pub struct Writer {
    /// The client every op goes through; None when cmux is unreachable.
    pub c: Option<Cmux>,
    /// The client for `workspace list`, which the Python ran with CMUX_QUIET=1.
    pub quiet: Option<Cmux>,
    pub dry: bool,
}

impl Writer {
    pub fn connect(dry: bool) -> Writer {
        Writer {
            c: Cmux::connect().ok(),
            quiet: Cmux::connect().ok().map(|c| c.with_cli_env("CMUX_QUIET", "1")),
            dry,
        }
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

    /// `workspace list --json`'s rows; [] when cmux does not answer.
    pub fn workspaces(&self) -> Vec<Value> {
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
        self.write(|c| c.workspace_action(ws, &a));
    }

    pub fn lane_auto(&self, ws: &str) {
        self.write(|c| c.workspace_status_set(ws, "auto"));
    }

    pub fn notify(&self, n: Notify) {
        self.write(|c| c.notify(&n));
    }
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
    use super::override_in;

    #[test]
    fn override_is_found_anywhere() {
        assert_eq!(override_in("override: review\n"), "review");
        assert_eq!(override_in("working\ninferred: working\noverride: none (auto)\n"), "none");
        assert_eq!(override_in("override:\n  needs-attention"), "needs-attention");
        assert_eq!(override_in("nothing here"), "");
    }
}
