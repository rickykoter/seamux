//! The spend dashboard's data, from ccusage (crew-board-intent usage_data).
//!
//! Windows and budgets, in tokens: on a subscription the constraint is the
//! 5h usage window and the week. On usage billing (CREW_BILLING=usage, or
//! crew-local/config.json's "billing") the month leads, in dollars. Budgets
//! come from the environment, else the largest window or week on record.

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crew_core::{costs, pricing, py, pyjson};

use crate::act::{spawn_wait, which};
use crate::pyval::{get, py_float, py_str, truthy};

pub const USAGE_SLOT: &str = r#"<script id="data" type="application/json">__DATA__</script>"#;

/// Machine-local settings from crew-local/config.json, or {}.
pub fn crew_local() -> Map<String, Value> {
    let base = py::env_or("CREW_LOCAL").map(std::path::PathBuf::from)
        .unwrap_or_else(|| py::home().join(".config").join("cmux").join("crew-local"));
    std::fs::read_to_string(base.join("config.json")).ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub fn billing_mode() -> String {
    let raw = match py::env_or("CREW_BILLING") {
        Some(s) => s,
        None => crew_local().get("billing").filter(|v| truthy(v)).map(py_str).unwrap_or_default(),
    };
    raw.trim().to_lowercase()
}

fn month_budget() -> f64 {
    let raw = match std::env::var("CREW_MONTH_BUDGET").ok().filter(|s| !s.is_empty()) {
        Some(s) => json!(s),
        None => crew_local().get("monthBudget").cloned().unwrap_or(json!("")),
    };
    if !truthy(&raw) {
        return 0.0;
    }
    py_float(&raw).unwrap_or(0.0)
}

fn env_budget(name: &str) -> i64 {
    std::env::var(name).ok().filter(|s| !s.is_empty())
        .and_then(|s| crate::pyval::parse_int(&s)).unwrap_or(0)
}

/// `x or default`, keeping x's own JSON value.
fn or(v: &Value, default: Value) -> Value {
    if truthy(v) { v.clone() } else { default }
}

/// Python's max() over JSON numbers: the first largest element, as given.
fn max_num(vals: impl Iterator<Item = Value>, default: Value) -> Value {
    let mut best: Option<Value> = None;
    for v in vals {
        let f = py_float(&v).unwrap_or(0.0);
        if best.as_ref().map(|b| f > py_float(b).unwrap_or(0.0)).unwrap_or(true) {
            best = Some(v);
        }
    }
    best.unwrap_or(default)
}

/// Python's round(x, 2): correctly rounded on the float's exact value.
fn round2(x: f64) -> f64 {
    format!("{x:.2}").parse().unwrap_or(x)
}

/// Python's round(x) to an int, half to even.
fn round_half_even(x: f64) -> i64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && (r as i64) % 2 != 0 {
        (r - x.signum()) as i64
    } else {
        r as i64
    }
}

fn unpriced_of(row: &Value) -> Value {
    let mut names = BTreeSet::new();
    for b in get(row, "modelBreakdowns").as_array().into_iter().flatten() {
        if b.is_object() && truthy(get(b, "missingPricing")) {
            names.insert(match get(b, "modelName") {
                v if truthy(v) => py_str(v),
                _ => "?".into(),
            });
        }
    }
    json!(names.into_iter().collect::<Vec<_>>())
}

fn window_minutes(x: &Value) -> i64 {
    let ts = |k: &str| py::iso_timestamp(get(x, k).as_str().unwrap_or(""));
    match (ts("startTime"), ts("endTime")) {
        (Some(s), Some(e)) => round_half_even((e - s) / 60.0).max(0),
        _ => 0,
    }
}

/// Everything the usage dashboard shows; never computed here, only asked of ccusage.
pub fn usage_data(days: usize) -> Value {
    let Some(exe) = which("ccusage") else {
        return json!({"error": "ccusage is not installed — npm i -g ccusage"});
    };
    let cfg = pricing::config_args(None);
    let ask = |args: &[&str]| -> Value {
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(args).args(&cfg).arg("--json");
        match spawn_wait(cmd, Duration::from_secs(45)) {
            Some((0, out, _)) if !out.trim().is_empty() => serde_json::from_str(&out).unwrap_or(Value::Null),
            _ => Value::Null,
        }
    };
    let mut out = Map::new();

    let blocks: Vec<Value> = get(&ask(&["blocks"]), "blocks").as_array().cloned().unwrap_or_default()
        .into_iter().filter(|b| !truthy(get(b, "isGap"))).collect();
    let env_block = env_budget("CREW_BLOCK_BUDGET");
    let block_budget = if env_block != 0 { json!(env_block) }
        else { max_num(blocks.iter().map(|b| or(get(b, "totalTokens"), json!(0))), json!(0)) };
    let wm = blocks.iter().rev().map(window_minutes).find(|m| *m != 0).unwrap_or(300);
    out.insert("windowMinutes".into(), json!(wm));

    if let Some(b) = blocks.iter().find(|x| truthy(get(x, "isActive"))) {
        let proj = or(get(b, "projection"), json!({}));
        let own = window_minutes(b);
        let mut blk = Map::new();
        blk.insert("tokens".into(), or(get(b, "totalTokens"), json!(0)));
        blk.insert("budget".into(), block_budget.clone());
        blk.insert("projected".into(), or(get(&proj, "totalTokens"), json!(0)));
        blk.insert("remainingMinutes".into(), or(get(&proj, "remainingMinutes"), json!(0)));
        blk.insert("burnPerMinute".into(), or(get(&or(get(b, "burnRate"), json!({})), "tokensPerMinute"), json!(0)));
        blk.insert("entries".into(), or(get(b, "entries"), json!(0)));
        blk.insert("models".into(), or(get(b, "models"), json!([])));
        blk.insert("active".into(), json!(true));
        blk.insert("startTime".into(), or(get(b, "startTime"), json!("")));
        blk.insert("endTime".into(), or(get(b, "endTime"), json!("")));
        blk.insert("windowMinutes".into(), json!(if own != 0 { own } else { wm }));
        out.insert("block".into(), Value::Object(blk));
    }
    out.insert("blockBudget".into(), block_budget);
    out.insert("budgetSource".into(), json!(if env_block != 0 { "env" } else { "largest 5h window on record" }));

    let mut rows: Vec<Value> = get(&ask(&["daily"]), "daily").as_array().cloned().unwrap_or_default()
        .into_iter().filter(|r| truthy(get(r, "period"))).collect();
    rows.sort_by(|a, b| py_str(get(a, "period")).cmp(&py_str(get(b, "period"))));
    let from = rows.len().saturating_sub(days);
    out.insert("daily".into(), json!(rows[from..].iter().map(|r| json!({
        "period": r["period"], "tokens": or(get(r, "totalTokens"), json!(0)),
        "cost": or(get(r, "totalCost"), json!(0)), "unpriced": unpriced_of(r),
    })).collect::<Vec<_>>()));

    let mut wrows: Vec<(Value, Value)> = get(&ask(&["weekly"]), "weekly").as_array().cloned().unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            let p = or(get(&r, "week"), get(&r, "period").clone());
            truthy(&p).then_some((p, r))
        })
        .collect();
    wrows.sort_by(|a, b| py_str(&a.0).cmp(&py_str(&b.0)));
    if let Some((p, cur)) = wrows.last() {
        let env_week = env_budget("CREW_WEEK_BUDGET");
        let week_budget = if env_week != 0 { json!(env_week) }
            else { max_num(wrows.iter().map(|(_, r)| or(get(r, "totalTokens"), json!(0))), json!(0)) };
        let mut models: Vec<(String, f64, Value)> = Vec::new();
        for m in get(cur, "modelBreakdowns").as_array().into_iter().flatten() {
            let name = py_str(&or(get(m, "modelName"), or(get(m, "model"), json!("?")))).replace("claude-", "");
            let tok = or(get(m, "totalTokens"), Value::Null);
            let tok = if truthy(&tok) { tok } else {
                let sum: f64 = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"]
                    .iter().map(|k| py_float(&or(get(m, k), json!(0))).unwrap_or(0.0)).sum();
                json!(sum as i64)
            };
            match models.iter_mut().find(|(n, _, _)| *n == name) {
                Some(e) => {
                    e.1 += py_float(&tok).unwrap_or(0.0);
                    e.2 = add_num(&e.2, &tok);
                }
                None => models.push((name, py_float(&tok).unwrap_or(0.0), add_num(&json!(0), &tok))),
            }
        }
        models.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut wk = Map::new();
        wk.insert("label".into(), json!(format!("week of {}", py_str(p))));
        wk.insert("tokens".into(), or(get(cur, "totalTokens"), json!(0)));
        wk.insert("cost".into(), or(get(cur, "totalCost"), json!(0)));
        wk.insert("unpriced".into(), unpriced_of(cur));
        wk.insert("budget".into(), week_budget);
        wk.insert("models".into(), json!(models.into_iter().map(|(n, _, v)| json!({"name": n, "tokens": v})).collect::<Vec<_>>()));
        out.insert("week".into(), Value::Object(wk));
    }

    let usage_billing = billing_mode() == "usage";
    out.insert("billing".into(), json!(if usage_billing { "usage" } else { "subscription" }));
    if usage_billing {
        let monthly = ask(&["monthly"]);
        let period = crate::server::local_time("%Y-%m");
        let cur_m = get(&monthly, "monthly").as_array().into_iter().flatten()
            .find(|r| get(r, "period").as_str() == Some(period.as_str())).cloned().unwrap_or(Value::Null);
        let day: i64 = crate::server::local_time("%d").parse().unwrap_or(1);
        let (y, m): (i64, u32) = (crate::server::local_time("%Y").parse().unwrap_or(1970), crate::server::local_time("%m").parse().unwrap_or(1));
        let next = if m == 12 { py::days_from_civil(y + 1, 1, 1) } else { py::days_from_civil(y, m + 1, 1) };
        let days_in = next - py::days_from_civil(y, m, 1);
        let spent = or(get(&cur_m, "totalCost"), json!(0));
        let projected = if day > 1 { pyjson::float(py_float(&spent).unwrap_or(0.0) / day as f64 * days_in as f64) } else { json!(0) };
        let mut mo = Map::new();
        mo.insert("label".into(), json!(crate::server::local_time("%B %Y")));
        mo.insert("spent".into(), spent);
        mo.insert("unpriced".into(), unpriced_of(&cur_m));
        mo.insert("budget".into(), pyjson::float(month_budget()));
        mo.insert("daysElapsed".into(), json!(day));
        mo.insert("daysInMonth".into(), json!(days_in));
        mo.insert("projected".into(), projected);
        out.insert("month".into(), Value::Object(mo));
    }

    // Per-workspace dollars, from the costs cache the board rows read.
    let mut by_cwd: Map<String, Value> = Map::new();
    for v in crate::act::targets().values() {
        let cwd = get(v, "cwd");
        if truthy(cwd) {
            let c = py_str(cwd);
            let base = c.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            let base = if c.ends_with('/') { String::new() } else { base };
            by_cwd.insert(c, or(get(v, "name"), json!(base)));
        }
    }
    let cwds: Vec<String> = by_cwd.keys().cloned().collect();
    let cm = costs::costs_for(&cwds);
    let mut rows_c: Vec<Value> = Vec::new();
    for (c, v) in &cm {
        if !(truthy(get(v, "week")) || truthy(get(v, "today")) || truthy(get(v, "unpriced"))) {
            continue;
        }
        let Some(name) = by_cwd.get(c) else { continue };
        rows_c.push(json!({
            "name": name,
            "today": pyjson::float(round2(py_float(get(v, "today")).unwrap_or(0.0))),
            "week": pyjson::float(round2(py_float(get(v, "week")).unwrap_or(0.0))),
            "unpricedToday": or(get(v, "unpricedToday"), json!([])),
            "unpriced": or(get(v, "unpriced"), json!([])),
        }));
    }
    if !rows_c.is_empty() {
        rows_c.sort_by(|a, b| py_float(&b["week"]).partial_cmp(&py_float(&a["week"])).unwrap_or(std::cmp::Ordering::Equal));
        out.insert("costs".into(), json!(rows_c));
    }

    if let Some(cache) = cache_rewrites() {
        out.insert("cache".into(), cache);
    }
    Value::Object(out)
}

fn add_num(a: &Value, b: &Value) -> Value {
    match (a.as_i64(), b.as_i64()) {
        (Some(x), Some(y)) => json!(x + y),
        _ => pyjson::float(py_float(a).unwrap_or(0.0) + py_float(b).unwrap_or(0.0)),
    }
}

/// Cache re-writes from the per-session facts files the Stop hook writes.
fn cache_rewrites() -> Option<Value> {
    let now = py::now();
    let (day_ago, week_ago) = (now - 86400.0, now - 7.0 * 86400.0);
    let dir = py::home().join(".cache").join("cmux-crew").join("cache-facts");
    let (mut t_day, mut t_week, mut n_day, mut n_week) = (json!(0), json!(0), 0i64, 0i64);
    let mut causes: Vec<(String, i64)> = Vec::new();
    let mut sessions: Vec<(Value, f64, i64, String)> = Vec::new();
    for e in std::fs::read_dir(&dir).ok()?.flatten() {
        let p = e.path();
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !name.ends_with(".json") || name.starts_with('.') {
            continue;
        }
        let Some(f) = std::fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) else { continue };
        let (mut s_tok, mut s_n) = (json!(0), 0i64);
        for b in get(&f, "breaks").as_array().into_iter().flatten() {
            let Some(at) = py::iso_timestamp(&py_str(get(b, "ts"))) else { continue };
            let tok = or(get(b, "recachedTokens"), json!(0));
            if at > week_ago {
                t_week = add_num(&t_week, &tok);
                n_week += 1;
                s_tok = add_num(&s_tok, &tok);
                s_n += 1;
                let c = py_str(&or(get(b, "cause"), json!("unknown")));
                match causes.iter_mut().find(|(k, _)| *k == c) {
                    Some(e) => e.1 += 1,
                    None => causes.push((c, 1)),
                }
            }
            if at > day_ago {
                t_day = add_num(&t_day, &tok);
                n_day += 1;
            }
        }
        if truthy(&s_tok) {
            let sid = name.trim_end_matches(".json").to_string();
            let label = or(get(&f, "label"), json!(sid.chars().take(8).collect::<String>()));
            let st = py_float(&s_tok).unwrap_or(0.0);
            sessions.push((label, st, s_n, s_tok.to_string()));
            let last = sessions.last_mut().unwrap();
            last.3 = pyjson::dumps(&s_tok);
        }
    }
    if n_week == 0 {
        return None;
    }
    sessions.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    causes.sort_by(|a, b| b.1.cmp(&a.1));
    let mut cm = Map::new();
    for (k, n) in causes {
        cm.insert(k, json!(n));
    }
    Some(json!({
        "today": {"breaks": n_day, "tokens": t_day},
        "week": {"breaks": n_week, "tokens": t_week},
        "causes": cm,
        "sessions": sessions.into_iter().take(5).map(|(n, _, b, t)| json!({
            "name": n, "tokens": serde_json::from_str::<Value>(&t).unwrap_or(json!(0)), "breaks": b,
        })).collect::<Vec<_>>(),
    }))
}

/// The /usage page: the template with the data in its slot, < > & escaped so
/// a title holding "</script>" cannot end the data block.
pub fn page(tmpl: &str) -> String {
    let data = pyjson::dumps(&usage_data(21)).replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026");
    tmpl.replace(USAGE_SLOT, &USAGE_SLOT.replace("__DATA__", &data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_is_pythons() {
        assert_eq!(round2(2.675), 2.67);
        assert_eq!(round2(1.005), 1.0);
        assert_eq!(round_half_even(2.5), 2);
        assert_eq!(round_half_even(3.5), 4);
        assert_eq!(round_half_even(299.6), 300);
    }

    #[test]
    fn max_keeps_the_value_as_given() {
        assert_eq!(max_num(vec![json!(3), json!(7.0), json!(7)].into_iter(), json!(0)), json!(7.0));
        assert_eq!(max_num(std::iter::empty(), json!(0)), json!(0));
    }
}
