//! The app's tucked.json (seamux-app's tuck.rs writes it): which worktrees
//! the person quieted, and how. Parsed here so the board (crew-board's
//! tucked.rs, which lays it over rows) and crew-sync (which skips hidden
//! worktrees' PR lists) read it one way. Each reader finds the file itself:
//! it lives in crew's durable dir, which crew-store resolves.

use std::collections::HashMap;

use serde_json::Value;

/// How a worktree is quieted: "mute" (until it needs you) | "snooze" (until
/// `until`, ms since the epoch) | "tuck" (until the person brings it back).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quiet {
    pub level: String,
    pub until: Option<u64>,
}

impl Quiet {
    /// Hidden from view outright: snoozed or tucked. A muted worktree still
    /// shows when it needs you, so it is not.
    pub fn hidden(&self) -> bool {
        matches!(self.level.as_str(), "snooze" | "tuck")
    }
}

/// worktree root -> its level, from `text` (tucked.json's contents), at
/// `now_ms`: a snooze without an end, or whose end has passed, is left out.
pub fn levels(text: &str, now_ms: u64) -> HashMap<String, Quiet> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return HashMap::new() };
    v.get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let path = e.get("path")?.as_str()?;
            let level = e.get("level")?.as_str()?;
            let until = match level {
                "mute" | "tuck" => None,
                "snooze" => Some(e.get("until")?.as_u64().filter(|u| *u > now_ms)?),
                _ => return None,
            };
            Some((path.to_string(), Quiet { level: level.to_string(), until }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_keep_known_levels_and_live_snoozes() {
        let text = r#"{"version":1,"entries":[{"path":"/w/a","level":"tuck","at":1},{"path":"/w/b","level":"mute","at":1},{"path":"/w/c","level":"loud"},{"path":"/w/d","level":"snooze","until":100},{"path":"/w/e","level":"snooze"},{"path":"/w/f","level":"snooze","until":50}]}"#;
        let lv = levels(text, 50);
        let mut keys: Vec<_> = lv.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["/w/a", "/w/b", "/w/d"], "an unknown level, a snooze without an end or past it: left out");
        assert_eq!(lv["/w/d"].until, Some(100));
        assert!(levels("not json", 0).is_empty());
    }

    #[test]
    fn snoozed_and_tucked_are_hidden_and_muted_is_not() {
        let q = |l: &str| Quiet { level: l.into(), until: None };
        assert!(q("tuck").hidden() && q("snooze").hidden());
        assert!(!q("mute").hidden(), "muted shows when it needs you");
    }
}
