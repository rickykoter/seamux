//! The board's news: where the fleet stands, as sentences, in priority order
//! (crew/board/news.py).
//!
//!   compose(rows, now, hours) -> {"hours", "lede", "items": [{id, tier, family, text}]}
//!   seamux news --compose FIXTURE.json      pure composition over a fixture
//!
//! Rows in, sentences out, in the order rank() put them; nothing here
//! re-ranks. Deterministic: no model writes it. Text uses render.js's two
//! affordances, {{bold}} and `code`, and names and subjects are stripped of
//! both markers first, so a branch or a subject cannot open one.

use serde_json::{json, Map, Value};

use crew_core::{py, pyjson};

use crate::pyval::{get, py_float, str_or_empty, truthy};

pub const HOURS_DEFAULT: f64 = 5.0;

const DOC: &str = "The board's news: where the fleet stands, as sentences, in priority order.

    compose(rows, now, hours) -> {\"hours\", \"lede\", \"items\": [{id, tier, family, text}]}
    news.py --compose FIXTURE.json      pure composition over a fixture, for the probe
";

/// The lookback window, from CREW_NEWS_HOURS; a bad value falls back.
pub fn hours() -> f64 {
    match std::env::var("CREW_NEWS_HOURS") {
        Err(_) => HOURS_DEFAULT,
        Ok(s) => match crate::pyval::parse_float(&s) {
            Some(h) if h > 0.0 => h,
            _ => HOURS_DEFAULT,
        },
    }
}

/// Text from a name, branch or subject, with the markup markers removed.
fn plain(v: &Value) -> String {
    str_or_empty(v).replace("{{", "").replace("}}", "").replace('`', "").trim().to_string()
}

/// `(d, t)` from rank()'s "d/t increments" in meta: the first match of
/// `(\d+)/(\d+) increments`.
fn progress(r: &Value) -> Option<(String, String)> {
    let meta = match get(r, "meta") {
        Value::String(s) => s.as_str(),
        _ => return None,
    };
    let c: Vec<char> = meta.chars().collect();
    let digits = |from: usize| {
        let mut j = from;
        while j < c.len() && c[j].is_ascii_digit() {
            j += 1;
        }
        j
    };
    for i in 0..c.len() {
        if !c[i].is_ascii_digit() {
            continue;
        }
        let j = digits(i);
        if j >= c.len() || c[j] != '/' {
            continue;
        }
        let k = digits(j + 1);
        if k == j + 1 {
            continue;
        }
        let rest: String = c[k..].iter().collect();
        if rest.starts_with(" increments") {
            return Some((c[i..j].iter().collect(), c[j + 1..k].iter().collect()));
        }
    }
    None
}

fn at(c: &Value) -> Option<f64> {
    if !c.is_object() {
        return None;
    }
    match c.get("at") {
        None => Some(0.0),
        Some(v) => py_float(v),
    }
}

/// The row's commits inside the window, newest first.
pub fn recent(r: &Value, now: f64, h: f64) -> Vec<Value> {
    let cut = now - h * 3600.0;
    let mut out: Vec<(f64, Value)> = Vec::new();
    if let Some(cs) = get(r, "commits").as_array() {
        for c in cs {
            if let Some(a) = at(c) {
                if a >= cut {
                    out.push((a, c.clone()));
                }
            }
        }
    }
    // sorted(key=-at) is stable: equal times keep their order.
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().map(|(_, c)| c).collect()
}

fn commits_clause(r: &Value, now: f64, h: f64) -> String {
    let cs = recent(r, now, h);
    if cs.is_empty() {
        return String::new();
    }
    let n = cs.len();
    let latest: String = plain(get(&cs[0], "s")).chars().take(72).collect();
    format!(
        "{} commit{} in the last {}h{}",
        n,
        if n == 1 { "" } else { "s" },
        py::percent_g(h),
        if latest.is_empty() { String::new() } else { format!(", latest “{latest}”") }
    )
}

/// What this row's badge means, as a predicate with no subject and no stop.
pub fn state(r: &Value) -> String {
    let b = match get(r, "badge") {
        Value::String(s) => s.as_str(),
        _ => "",
    };
    let subj = plain(get(r, "subject"));
    let prog = progress(r);
    let with = |pre: &str, bare: &str| if subj.is_empty() { bare.to_string() } else { format!("{pre} {subj}") };
    match b {
        "asked you" => "is waiting on your answer".into(),
        "review" => {
            let n = prog.as_ref().map(|p| p.1.clone()).unwrap_or_default();
            if n.is_empty() || n == "0" {
                "needs its alignment check taken".into()
            } else {
                format!(
                    "needs its alignment check taken; {} increment{} locked behind it",
                    n,
                    if n == "1" { " is" } else { "s are" }
                )
            }
        }
        "gate shut" => with("needs your go-ahead on", "needs your go-ahead"),
        "ci failed" => {
            let br = plain(get(r, "branch"));
            if br.is_empty() { "is red on CI".into() } else { format!("is red on CI on `{br}`") }
        }
        "check failed" => {
            if subj.is_empty() { "failed a check".into() } else { format!("failed a check ({subj})") }
        }
        "conflicts" => "conflicts with its base".into(),
        "changes" => "has review changes requested".into(),
        "blocked" => with("is blocked on", "is blocked"),
        "stuck" => "ended its last turn on an error it could not get past".into(),
        "working" => {
            let s = with("is working on", "is working");
            match prog {
                Some((d, t)) => format!("{s} ({d}/{t} increments)"),
                None => s,
            }
        }
        "merged" => "merged and can be reclaimed".into(),
        "plan done" => "finished every increment; its plan can be closed".into(),
        _ => String::new(),
    }
}

/// One row's full sentence, or "" when it has nothing to say.
fn sentence(r: &Value, now: f64, h: f64) -> String {
    let mut name = plain(get(r, "name"));
    if name.is_empty() {
        name = plain(get(r, "id"));
    }
    let st = if get(r, "kind") != "quiet" { state(r) } else { String::new() };
    let cc = commits_clause(r, now, h);
    match (st.is_empty(), cc.is_empty()) {
        (false, false) => format!("{{{{{name}}}}} {st}, with {cc}."),
        (false, true) => format!("{{{{{name}}}}} {st}."),
        (true, false) => format!("{{{{{name}}}}} is quiet, with {cc}."),
        (true, true) => String::new(),
    }
}

/// `x or default`, keeping x's own JSON value when it is truthy.
fn or_value(v: &Value, default: Value) -> Value {
    if truthy(v) { v.clone() } else { default }
}

/// The news over rows in board order. `h_raw` is echoed as given (an int
/// stays an int), as Python echoes whatever number it was handed.
pub fn compose(rows: &[Value], now: f64, h: f64, h_raw: Value) -> Value {
    let mut items: Vec<Value> = Vec::new();
    let (mut quiet_n, mut i) = (0usize, 0usize);
    while i < rows.len() {
        let r = &rows[i];
        let fam = get(r, "family");
        if truthy(fam) {
            let mut members = Vec::new();
            while i < rows.len() && get(&rows[i], "family") == fam {
                members.push(&rows[i]);
                i += 1;
            }
            let (mut parts, mut idle) = (Vec::new(), 0usize);
            for m in &members {
                let s = sentence(m, now, h);
                if s.is_empty() {
                    idle += 1;
                } else {
                    parts.push(s.trim_end_matches('.').to_string());
                }
            }
            if parts.is_empty() {
                quiet_n += members.len();
                continue;
            }
            if idle > 0 {
                parts.push(format!("{} more {} quiet", idle, if idle == 1 { "is" } else { "are" }));
            }
            let lead = members[0];
            let tier = or_value(get(lead, "famtier"), or_value(get(lead, "kind"), json!("quiet")));
            let fam_s = crate::pyval::py_str(fam);
            let mut item = Map::new();
            item.insert("id".into(), json!(format!("family:{fam_s}")));
            item.insert("tier".into(), tier);
            item.insert("family".into(), fam.clone());
            item.insert("text".into(), json!(format!("Family {{{{{}}}}}: {}.", plain(fam), parts.join("; "))));
            items.push(Value::Object(item));
            continue;
        }
        i += 1;
        let s = sentence(r, now, h);
        if s.is_empty() {
            quiet_n += 1;
            continue;
        }
        let mut item = Map::new();
        item.insert("id".into(), r.get("id").cloned().unwrap_or(json!("")));
        item.insert("tier".into(), or_value(get(r, "kind"), json!("quiet")));
        item.insert("family".into(), json!(""));
        item.insert("text".into(), json!(s));
        items.push(Value::Object(item));
    }
    if quiet_n > 0 {
        items.push(json!({"id": "quiet", "tier": "quiet", "family": "",
            "text": format!("{} other workspace{} quiet.", quiet_n, if quiet_n == 1 { " is" } else { "s are" })}));
    }
    let lede = items.first().map(|it| it["text"].clone()).unwrap_or(json!(""));
    let mut out = Map::new();
    out.insert("hours".into(), h_raw);
    out.insert("lede".into(), lede);
    out.insert("items".into(), Value::Array(items));
    Value::Object(out)
}

/// compose() with the defaults the collector uses: now, and CREW_NEWS_HOURS.
pub fn compose_now(rows: &[Value]) -> Value {
    let h = hours();
    compose(rows, py::now(), h, pyjson::float(h))
}

/// The items as one plain paragraph, markers removed, for a terminal.
pub fn paragraph(news: &Value) -> String {
    get(news, "items")
        .as_array()
        .map(|a| a.iter().map(|it| plain(get(it, "text"))).collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

pub fn main(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("--compose") && args.len() >= 2 {
        let fx: Value = match std::fs::read_to_string(&args[1]).map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        {
            Ok(v) => v,
            Err(e) => {
                eprintln!("news: {}: {e}", args[1]);
                return 1;
            }
        };
        let rows = or_value(get(&fx, "rows"), json!([]));
        let rows = rows.as_array().cloned().unwrap_or_default();
        let now = match get(&fx, "now") {
            Value::Null => py::now(),
            v => py_float(v).unwrap_or(0.0),
        };
        let (h, h_raw) = match get(&fx, "hours") {
            Value::Null => {
                let h = hours();
                (h, pyjson::float(h))
            }
            v => (py_float(v).unwrap_or(0.0), v.clone()),
        };
        println!("{}", pyjson::dumps(&compose(&rows, now, h, h_raw)));
        return 0;
    }
    eprint!("{DOC}");
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, kind: &str, badge: &str) -> Value {
        json!({"id": id, "name": id, "kind": kind, "badge": badge, "said": "", "meta": ""})
    }

    #[test]
    fn rows_become_sentences_in_order() {
        let rows = vec![row("gate", "attend", "gate shut"), row("q", "quiet", "")];
        let n = compose(&rows, 1000.0, 5.0, json!(5));
        assert_eq!(n["items"][0]["text"], "{{gate}} needs your go-ahead.");
        assert_eq!(n["items"][1]["text"], "1 other workspace is quiet.");
        assert_eq!(n["lede"], n["items"][0]["text"]);
        assert_eq!(n["hours"], json!(5));
    }

    #[test]
    fn commits_inside_the_window_newest_named() {
        let mut r = row("b", "running", "working");
        r["meta"] = json!("2/5 increments · b");
        r["commits"] = json!([{"at": 9000.0, "s": "older"}, {"at": 9990.0, "s": "newest {{x}}"}, {"at": 1.0, "s": "old"}]);
        let n = compose(&[r], 10000.0, 0.5, json!(0.5));
        assert_eq!(n["items"][0]["text"],
            "{{b}} is working (2/5 increments), with 2 commits in the last 0.5h, latest “newest x”.");
    }

    #[test]
    fn a_family_is_one_item() {
        let mut p = row("par", "running", "working");
        p["family"] = json!("F");
        p["famtier"] = json!("attend");
        let mut k = row("kid", "attend", "review");
        k["family"] = json!("F");
        let mut q = row("q", "quiet", "");
        q["family"] = json!("F");
        let n = compose(&[p, k, q], 1000.0, 5.0, json!(5.0));
        assert_eq!(n["items"][0]["id"], "family:F");
        assert_eq!(n["items"][0]["tier"], "attend");
        assert_eq!(n["items"][0]["text"],
            "Family {{F}}: {{par}} is working; {{kid}} needs its alignment check taken; 1 more is quiet.");
    }

    #[test]
    fn progress_is_the_first_match() {
        assert_eq!(progress(&json!({"meta": "x 12/40 increments · s"})), Some(("12".into(), "40".into())));
        assert_eq!(progress(&json!({"meta": "1/2 things"})), None);
    }
}
