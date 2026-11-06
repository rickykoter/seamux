//! Settled rows: merged work nobody has reclaimed, gone quiet. A done row
//! settles when it carries gone:merged (rank's "merged" badge), no pane in
//! its workspace is working, and its panes' newest write is older than
//! settleHours (crew-local config, default 2). It is worked out on every
//! push and never stored, so any new pane write brings the row back. A row
//! with no pane file is not settled: no write time is not an old one.

use serde_json::Value;

use crate::pyval::{get, py_str};

/// The default idle time before a merged row settles.
pub const DEFAULT_HOURS: f64 = 2.0;

/// settleHours from crew-local/config.json, else `DEFAULT_HOURS`.
pub fn hours() -> f64 {
    let v = crate::usage::crew_local().get("settleHours").cloned().unwrap_or(Value::Null);
    let h = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()));
    h.filter(|h| h.is_finite() && *h > 0.0).unwrap_or(DEFAULT_HOURS)
}

/// Mark each merged row whose panes have been idle `hours` by `now_ms`:
/// `"settled": true`. `panes` gives a workspace id's panes.
pub fn mark(rows: &mut [Value], now_ms: u64, hours: f64, panes: impl Fn(&str) -> Vec<crew_core::status::Pane>) {
    let idle_ms = (hours * 3_600_000.0) as u64;
    for r in rows.iter_mut() {
        if get(r, "kind").as_str() != Some("done") || get(r, "badge").as_str() != Some("merged") {
            continue;
        }
        let ps = panes(&py_str(get(r, "id")));
        let Some(newest) = ps.iter().map(|p| p.at).max() else { continue };
        if ps.iter().any(|p| p.state == "working") || now_ms.saturating_sub(newest) < idle_ms {
            continue;
        }
        if let Some(o) = r.as_object_mut() {
            o.insert("settled".into(), Value::Bool(true));
        }
    }
}

/// `files` (the pane files state.rs read, dead panes already ended), laid
/// over `rows` now.
pub fn mark_live(rows: &mut [Value], files: &[crew_core::status::Pane]) {
    let of = |ws: &str| files.iter().filter(|p| p.ws.eq_ignore_ascii_case(ws)).cloned().collect();
    mark(rows, crew_core::history::now_ms(), hours(), of);
}

/// A row put away (snoozed) or finished (settled): it stays off the news.
pub fn away(r: &Value) -> bool {
    get(r, "tuck").as_str() == Some("snooze") || get(r, "settled").as_bool() == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const H: u64 = 3_600_000;

    fn pane(ws: &str, state: &str, at: u64) -> crew_core::status::Pane {
        let mut p = crew_core::status::Pane::new(ws, &format!("{ws}-s"));
        p.state = state.into();
        p.at = at;
        p
    }

    #[test]
    fn a_merged_row_settles_once_its_panes_are_idle_long_enough() {
        let now = 10 * H;
        let mut rows = vec![
            json!({"id": "old", "kind": "done", "badge": "merged"}),
            json!({"id": "fresh", "kind": "done", "badge": "merged"}),
            json!({"id": "busy", "kind": "done", "badge": "merged"}),
            json!({"id": "nofile", "kind": "done", "badge": "merged"}),
            json!({"id": "plan", "kind": "done", "badge": "plan done"}),
            json!({"id": "edge", "kind": "done", "badge": "merged"}),
        ];
        let panes = |ws: &str| match ws {
            "old" => vec![pane(ws, "idle", now - 3 * H), pane(ws, "idle", now - 5 * H)],
            "fresh" => vec![pane(ws, "idle", now - 5 * H), pane(ws, "idle", now - H)],
            "busy" => vec![pane(ws, "working", now - 5 * H)],
            "plan" => vec![pane(ws, "idle", now - 5 * H)],
            "edge" => vec![pane(ws, "idle", now - 2 * H)],
            _ => vec![],
        };
        mark(&mut rows, now, 2.0, panes);
        let got: Vec<_> = rows.iter().map(|r| r.get("settled").is_some()).collect();
        assert_eq!(got, vec![true, false, false, false, false, true]);
        assert!(away(&rows[0]) && !away(&rows[1]));
        assert!(away(&json!({"tuck": "snooze"})) && !away(&json!({"tuck": "mute"})));
    }
}
