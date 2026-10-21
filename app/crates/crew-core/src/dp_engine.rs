//! Where the deep-plan engine is, for crew processes that run outside Claude
//! (crew/board/dp_engine.py).
//!
//! The board, the intent server and the triage hook run with the cmux app's
//! environment and cannot see CLAUDE_PLUGIN_ROOT. The deep-plan plugin keeps
//! ~/.claude/deep-plan/engine.json pointing at its root. Resolution, first
//! that exists: $DEEP_PLAN_ENGINE, engine.json's root, ~/.claude/skills/deep-plan.
//! Read on every call, never cached: a plugin update moves the root under a
//! long-lived server.

use std::path::PathBuf;

use serde_json::Value;

use crate::py::home;

fn data() -> PathBuf {
    home().join(".claude/deep-plan")
}

fn legacy() -> PathBuf {
    home().join(".claude/skills/deep-plan")
}

fn pointer() -> serde_json::Map<String, Value> {
    std::fs::read_to_string(data().join("engine.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn pointer_str(key: &str) -> Option<String> {
    pointer().get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

/// The engine's directory (the one holding deep_plan.mjs).
pub fn root() -> PathBuf {
    let cands = [std::env::var("DEEP_PLAN_ENGINE").ok().filter(|s| !s.is_empty()), pointer_str("root")];
    for r in cands.into_iter().flatten() {
        let p = PathBuf::from(r);
        if p.join("deep_plan.mjs").is_file() {
            return p;
        }
    }
    legacy()
}

/// deep_plan.mjs, to run as `node <script> <verb> ...`.
pub fn script() -> PathBuf {
    root().join("deep_plan.mjs")
}

/// The pinned mermaid bundle the intent server serves, or the data-tree path
/// where `deep-plan setup` puts it when no copy exists anywhere yet.
pub fn mermaid() -> PathBuf {
    let home_copy = data().join("vendor/mermaid.min.js");
    let cands = [
        pointer_str("mermaid").map(PathBuf::from),
        Some(home_copy.clone()),
        Some(root().join("vendor/mermaid.min.js")),
        Some(legacy().join("vendor/mermaid.min.js")),
    ];
    cands.into_iter().flatten().find(|p| p.is_file()).unwrap_or(home_copy)
}
