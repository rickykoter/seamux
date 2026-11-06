//! What crew-sync last published for a workspace, read from files and never
//! from cmux or the network: the board's sidebar cache on cmux
//! (board-sidebar.json in crew's state dir), else the tmux backend's
//! registry. asked_hook reads a workspace's tokens from here, and the app's
//! views:frame reads every workspace's PR and CI.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// A workspace's published facts: its description tokens (ci:, review:,
/// pr:, phase: and the rest) and its pull request.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Published {
    pub desc: String,
    pub pr: Option<Pr>,
}

/// A pull request as crew-sync published it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pr {
    /// Its number, without a leading '#'.
    pub n: String,
    /// open, merged, closed or draft as published; "" when not known.
    pub state: String,
    /// "" when not known.
    pub url: String,
}

impl Published {
    /// The description token after `prefix` ("ci:" gives "fail"), or "".
    pub fn token(&self, prefix: &str) -> String {
        self.desc.split_whitespace().find_map(|t| t.strip_prefix(prefix)).unwrap_or("").to_string()
    }

    /// The ci:, review: and pr: tokens, in the order published.
    pub fn signals(&self) -> Vec<String> {
        self.desc.split_whitespace().filter(|t| ["pr:", "ci:", "review:"].iter().any(|p| t.starts_with(p))).map(String::from).collect()
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// A sidebar cache row's PR: `pr` is its number or "none".
fn sidebar_pr(row: &Value) -> Option<Pr> {
    let n = text(row.get("pr"));
    let n = n.trim_start_matches('#');
    (!n.is_empty() && n != "none").then(|| Pr { n: n.to_string(), state: text(row.get("pr_state")).to_ascii_lowercase(), url: text(row.get("pr_url")) })
}

/// A tmux registry PR: {n, state, url}, or null.
fn registry_pr(v: &Value) -> Option<Pr> {
    let n = text(v.get("n"));
    let n = n.trim_start_matches('#');
    (!n.is_empty()).then(|| Pr { n: n.to_string(), state: text(v.get("state")).to_ascii_lowercase(), url: text(v.get("url")) })
}

/// A sidebar cache entry's facts; None for an entry with no row or no
/// description, which leaves the workspace to the tmux registry.
fn sidebar_entry(e: &Value) -> Option<Published> {
    let row = e.get("row")?;
    let desc = row.get("desc").and_then(Value::as_str)?;
    Some(Published { desc: desc.to_string(), pr: sidebar_pr(row) })
}

fn sidebar_cache(state_dir: &Path) -> serde_json::Map<String, Value> {
    match std::fs::read_to_string(state_dir.join("board-sidebar.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

/// Every workspace's published facts, by upper-case id: the sidebar cache
/// in `state_dir`, then the tmux registry in `tmux_dir` for any workspace
/// the cache does not hold. A missing or unreadable file adds nothing.
pub fn all(state_dir: &Path, tmux_dir: &Path) -> BTreeMap<String, Published> {
    let mut out = BTreeMap::new();
    for (id, e) in sidebar_cache(state_dir) {
        if let Some(p) = sidebar_entry(&e) {
            out.insert(id.to_ascii_uppercase(), p);
        }
    }
    if let Ok(facts) = crate::backend::tmux::TmuxBackend::at(tmux_dir.to_path_buf()).facts() {
        for (id, desc, pr) in facts {
            out.entry(id.to_ascii_uppercase()).or_insert(Published { desc, pr: registry_pr(&pr) });
        }
    }
    out
}

/// Workspace `ws`'s published facts (see `all`), building only its own:
/// the registry is read only when the cache does not hold it. Empty when
/// neither file knows it.
pub fn of(state_dir: &Path, tmux_dir: &Path, ws: &str) -> Published {
    let cached = sidebar_cache(state_dir).iter().find(|(k, _)| k.eq_ignore_ascii_case(ws)).and_then(|(_, e)| sidebar_entry(e));
    cached.or_else(|| {
        crate::backend::tmux::TmuxBackend::at(tmux_dir.to_path_buf()).facts().ok()?
            .into_iter().find(|(id, _, _)| id.eq_ignore_ascii_case(ws)).map(|(_, desc, pr)| Published { desc, pr: registry_pr(&pr) })
    }).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("crew-published-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_sidebar_cache_comes_first_and_the_registry_fills_the_rest() {
        let (state, tmux) = (dir("s"), dir("t"));
        std::fs::write(state.join("board-sidebar.json"), json!({
            "w1": {"at": 1, "row": {"desc": "ci:fail review:approved phase:working", "pr": "12", "pr_state": "open", "pr_url": "https://x/12"}},
            "W2": {"at": 1, "row": {"desc": "ci:pass", "pr": "none"}},
            "W5": {"at": 1, "row": {"desc": "pr:draft", "pr": "#5", "pr_state": "OPEN"}},
            "W3": {"at": 1, "row": {"pr": "none"}},
        }).to_string()).unwrap();
        std::fs::write(tmux.join("workspaces.json"), json!({"workspaces": [
            {"id": "W1", "description": "ci:pass", "pr": {"n": 99, "state": "OPEN", "url": "u"}},
            {"id": "w3", "description": "ci:run pr:draft", "pr": {"n": 7, "state": "OPEN", "url": "https://x/7"}},
            {"id": "W4", "description": "", "pr": null},
        ], "panes": []}).to_string()).unwrap();
        let all = all(&state, &tmux);
        let w1 = &all["W1"];
        assert_eq!(w1.pr, Some(Pr { n: "12".into(), state: "open".into(), url: "https://x/12".into() }));
        assert_eq!((w1.token("ci:"), w1.token("review:")), ("fail".into(), "approved".into()));
        assert_eq!(all["W2"].pr, None);
        assert_eq!(all["W3"].pr, Some(Pr { n: "7".into(), state: "open".into(), url: "https://x/7".into() }));
        assert_eq!(all["W3"].signals(), vec!["ci:run".to_string(), "pr:draft".to_string()]);
        assert_eq!(all["W4"], Published::default());
        // The cache's state in any case reads lower case, as the registry's does.
        assert_eq!(all["W5"].pr.as_ref().map(|p| (p.n.as_str(), p.state.as_str())), Some(("5", "open")));
        // A cache entry with no description leaves the workspace to the registry.
        assert_eq!(of(&state, &tmux, "W3").token("ci:"), "run");
        assert_eq!(of(&state, &tmux, "w3").token("ci:"), "run");
        assert_eq!(of(&state, &tmux, "W9"), Published::default());
    }

    #[test]
    fn no_files_is_nothing_published() {
        let (state, tmux) = (dir("ns"), dir("nt"));
        assert!(all(&state, &tmux).is_empty());
    }
}
