//! The ranking: who needs you, in five tiers (crew/board/crew-board rank()).
//!
//!   attend   blocked on a human      a question, or a plan gate nobody opened
//!   wilt     broken                  failing CI, conflicts, a blocked increment
//!   running  mid-turn                working; informative, not urgent
//!   done     finished, needs closing merged and unreclaimed
//!   quiet    everything else         ranked last, rendered recessed
//!
//! Rows are built key by key in the Python's order, because `state --json`
//! prints them and a probe compares the bytes.

use serde_json::{json, Map, Value};

use crew_core::{costs, families, pyjson};

use crate::judgments;
use crate::pyval::{get, py_float, py_str, truthy};
use crate::state;

/// What each chip label does, so a signal offering the same verb is dropped.
fn chip_action(c: &str) -> Option<&'static str> {
    Some(match c {
        "jump" => "jump",
        "diff" => "diff",
        "pr" => "pr",
        "checks" => "checks",
        "plan" | "take the check" => "plan",
        "reclaim" => "reclaim",
        "close plan" => "close plan",
        "code" => "code",
        _ => return None,
    })
}

/// Drop signals that would repeat a chip, or the meta line.
pub fn dedupe(chips: &[String], sigs: Vec<Value>, has_plan: bool) -> Vec<Value> {
    let mut taken: Vec<(String, Option<String>)> = Vec::new();
    for c in chips {
        if let Some(a) = chip_action(c) {
            taken.push((a.into(), None));
        } else if let Some(n) = c.strip_prefix("go ").or_else(|| c.strip_prefix(PARENT_GOES)) {
            taken.push(("go".into(), Some(n.trim().to_string())));
        }
    }
    sigs.into_iter()
        .filter(|e| {
            if let Some(a) = e.get("a").and_then(Value::as_str).filter(|a| !a.is_empty()) {
                let x = e.get("x").map(py_str);
                if taken.iter().any(|(ta, tx)| ta == a && (tx.is_none() || *tx == x)) {
                    return false;
                }
            }
            !(has_plan && e["t"].as_str().unwrap_or("").starts_with('◈'))
        })
        .collect()
}

/// The value half of a `key:value` description token, or "".
pub fn token_value(desc: &str, key: &str) -> String {
    let pre = format!("{key}:");
    desc.split_whitespace()
        .find(|t| t.starts_with(&pre))
        .map(|t| t.split_once(':').map(|(_, v)| v.to_string()).unwrap_or_default())
        .unwrap_or_default()
}

fn has(desc: &str, token: &str) -> bool {
    desc.contains(token)
}

fn jira(state: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match state {
        "blocked" => ("⊘ blocked", "#F97066", "Jira: Blocked"),
        "in-review" => ("⊙ in review", "#F5A524", "Jira: In Review"),
        "in-progress" => ("⊙ in progress", "#60A5FA", "Jira: In Progress"),
        "ready" => ("⊙ ready", "#859289", "Jira: Ready for Development"),
        "done" => ("⊙ done", "#4ADE80", "Jira: Done"),
        _ => return None,
    })
}

/// [{t,c,h,a?,x?}] for one workspace's description tokens, in reading order.
pub fn signals(d: &str, has_pr: bool, jira_link: Option<&str>, now: i64) -> Vec<Value> {
    let mut out = Vec::new();
    let mut sig = |t: &str, c: &str, h: &str, a: Option<&str>, x: Option<&str>| {
        let mut e = Map::new();
        e.insert("t".into(), json!(t));
        e.insert("c".into(), json!(c));
        e.insert("h".into(), json!(h));
        if let Some(a) = a.filter(|a| !a.is_empty()) {
            e.insert("a".into(), json!(a));
            if let Some(x) = x {
                e.insert("x".into(), json!(x));
            }
        }
        out.push(Value::Object(e));
    };
    if has_pr {
        if has(d, "ci:fail") {
            sig("✗ CI", "#F97066", "Open the failing checks in your default browser", Some("checks"), None);
        } else if has(d, "ci:run") {
            sig("● CI", "#F5A524", "Open the running checks in your default browser", Some("checks"), None);
        } else if has(d, "ci:pass") {
            sig("✓ CI", "#4ADE80", "Open the passing checks in your default browser", Some("checks"), None);
        }
    }
    if has(d, "review:approved") {
        sig("✓ approved", "#4ADE80", "A reviewer approved this PR", None, None);
    }
    if has(d, "review:changes") {
        sig("↻ changes", "#F97066", "A reviewer asked for changes", None, None);
    }
    if has(d, "pr:conflict") {
        sig("⚠ conflicts", "#F97066", "This branch conflicts with its base", None, None);
    }
    if has(d, "pr:draft") {
        sig("draft", "#859289", "The PR is still a draft", None, None);
    }
    if has(d, "stack:blocked") {
        sig("⇣ parent open", "#F5A524", "Stacked on a branch that has not merged yet", None, None);
    }
    if has(d, "stack:ready") {
        sig("⇣ stacked", "#859289", "Stacked on a branch that has already merged", None, None);
    }
    if let Some(j) = jira(&token_value(d, "jira")) {
        match jira_link {
            Some(key) => {
                let icon = j.0.split(' ').next().unwrap_or("");
                sig(&format!("{icon} {key}"), j.1, &format!("{} — open {key} in Jira", j.2), Some("jira"), Some(key));
            }
            None => sig(j.0, j.1, j.2, None, None),
        }
    }
    if has(d, "sandbox:running") {
        sig("▣ sandbox", "#60A5FA", "Running in a Docker sandbox — click to stop it", Some("sandbox-down"), None);
    }
    if has(d, "sandbox:stopped") {
        sig("▢ sandbox", "#8E8E93", "Sandbox is stopped — click to start it", Some("sandbox-up"), None);
    }
    let inc = token_value(d, "planinc");
    if !inc.is_empty() {
        let c = if has(d, "plan:gate") { "#F5A524" } else { "#A78BFA" };
        sig(&format!("◈ {inc}"), c, "Increments done in this plan", None, None);
    }
    let nxt = token_value(d, "plannext");
    if !nxt.is_empty() {
        sig(&format!("go {nxt}"), "#F5A524",
            &format!("Authorize increment {nxt} — until you do, nothing in this worktree can be edited"),
            Some("go"), Some(&nxt));
    }
    if !token_value(d, "planpath").is_empty() {
        sig("plan →", "#A78BFA", "Open this plan's live page", Some("plan"), None);
    }
    let by = token_value(d, "feedby");
    let left = if !by.is_empty() && by.chars().all(|c| c.is_ascii_digit()) {
        by.parse::<i64>().unwrap_or(0) - now
    } else {
        0
    };
    if left > 0 {
        let gate = token_value(d, "feedgate");
        if gate == "allow" {
            sig("allow", "#4ADE80", "Approve what the agent asked for", Some("feed-allow"), None);
        }
        sig("deny", "#F97066", "Refuse it; the agent keeps waiting", Some("feed-deny"), None);
        if gate == "read" {
            sig("read it →", "#F5A524", "Too long to answer from here — jump to the workspace", Some("jump"), None);
        }
    }
    out
}

/// The row's place in a deep-plan family, from status --json's `family`.
pub fn fam_fields(plan: Option<&Value>) -> Vec<(String, Value)> {
    let f = plan.map(|p| get(p, "family")).filter(|f| truthy(f));
    match f {
        Some(f) if truthy(get(f, "parent")) => vec![
            ("family".into(), f["parent"].clone()),
            ("famrole".into(), f.get("role").cloned().unwrap_or(json!(""))),
            ("famgo".into(), f.get("go").cloned().unwrap_or(json!(""))),
        ],
        _ => Vec::new(),
    }
}

/// A delegated child's go chip (see crew-board's PARENT_GOES): a person can
/// still press it, and intent.js reads the number off the label.
pub const PARENT_GOES: &str = "parent goes \u{00b7} inc ";

fn family_of(plan: Option<&Value>) -> Option<&Value> {
    plan.map(|p| get(p, "family")).filter(|f| truthy(f))
}

fn parent_goes(plan: Option<&Value>) -> bool {
    family_of(plan).is_some_and(|f| get(f, "go") == "parent")
}

/// The gate-shut row's go chip: `go N`, or `parent goes · inc N` when the
/// family's parent owns this plan's go.
pub fn go_chip(plan: Option<&Value>, n: &str) -> String {
    if parent_goes(plan) { format!("{PARENT_GOES}{n}") } else { format!("go {n}") }
}

/// The gate-shut row's sentence; `why` is None on the plans-only path.
pub fn go_said(plan: Option<&Value>, title: &str, why: Option<&str>) -> String {
    match family_of(plan) {
        Some(f) if get(f, "go") == "parent" => format!(
            "{{{{{title}}}}} waits on its go from the parent, {}. You can still give it.",
            get_s(f, "parent", "?")),
        _ => match why {
            Some(w) => format!("{{{{{title}}}}} needs your go-ahead. {w}"),
            None => format!("{{{{{title}}}}} needs your go-ahead."),
        },
    }
}

/// A parent row's written holds, one meta bit each: `held <child>: <reason>`.
pub fn hold_bits(plan: Option<&Value>) -> Vec<String> {
    let Some(f) = family_of(plan).filter(|f| get(f, "role") == "parent") else { return Vec::new() };
    let mut out: Vec<(String, String)> = get(f, "holds").as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), py_str(v))).collect())
        .unwrap_or_default();
    out.sort();
    out.into_iter().map(|(k, r)| format!("held {k}: {r}")).collect()
}

/// The first outstanding check whose verdict is fail or lost.
pub fn failed_check(plan: Option<&Value>) -> Option<&Value> {
    let plan = plan.filter(|p| truthy(p))?;
    if get(plan, "phase") == "done" {
        return None;
    }
    get(plan, "checksOutstanding").as_array()?.iter().find(|c| {
        matches!(c.get("status").and_then(Value::as_str), Some("fail") | Some("lost"))
    })
}

/// `d.get(k, default)` printed with %s.
fn get_s(d: &Value, k: &str, default: &str) -> String {
    d.get(k).map(py_str).unwrap_or_else(|| default.to_string())
}

pub fn failed_subject(c: &Value) -> String {
    format!("increment {} \u{00b7} {}", get_s(c, "n", "?"), get_s(c, "id", "?"))
}

/// `"%d" % x` for a JSON number (Python truncates a float).
fn pct_d(v: &Value) -> String {
    match v {
        Value::Number(n) => n.as_i64().map(|i| i.to_string())
            .unwrap_or_else(|| (n.as_f64().unwrap_or(0.0).trunc() as i64).to_string()),
        Value::Bool(b) => (*b as i64).to_string(),
        other => py_str(other),
    }
}

fn progress(plan: &Value) -> &Value {
    get(plan, "progress")
}

/// done/total as a float, or None when total is 0.
fn frac(plan: Option<&Value>) -> Value {
    let Some(p) = plan else { return Value::Null };
    let total = py_float(get(progress(p), "total")).unwrap_or(0.0);
    if total == 0.0 {
        return Value::Null;
    }
    pyjson::float(py_float(get(progress(p), "done")).unwrap_or(0.0) / total)
}

fn incs(plan: &Value) -> String {
    format!("{}/{} increments", pct_d(get(progress(plan), "done")), pct_d(get(progress(plan), "total")))
}

/// Python's `\b([A-Z][A-Z0-9]+-\d+)\b`, first match.
pub fn jira_key(s: &str) -> Option<String> {
    let c: Vec<char> = s.chars().collect();
    let word = |ch: char| ch.is_alphanumeric() || ch == '_';
    for i in 0..c.len() {
        if !c[i].is_ascii_uppercase() || (i > 0 && word(c[i - 1])) {
            continue;
        }
        let mut j = i + 1;
        while j < c.len() && (c[j].is_ascii_uppercase() || c[j].is_ascii_digit()) {
            j += 1;
        }
        if j == i + 1 || j >= c.len() || c[j] != '-' {
            continue;
        }
        let mut k = j + 1;
        while k < c.len() && c[k].is_ascii_digit() {
            k += 1;
        }
        if k == j + 1 || (k < c.len() && word(c[k])) {
            continue;
        }
        return Some(c[i..k].iter().collect());
    }
    None
}

fn none_blank(v: &Value) -> Value {
    match v.as_str() {
        Some("") | Some("none") => json!(""),
        _ => v.clone(),
    }
}

fn is_none_str(v: &Value) -> bool {
    matches!(v.as_str(), Some("") | Some("none"))
}

struct Ctx {
    cost_map: Map<String, Value>,
    jmap: Map<String, Value>,
    stuck_t: f64,
    ghi_on: bool,
    jira_site: String,
    now: i64,
}

impl Ctx {
    fn cost(&self, cwd: &Value) -> (Value, Value) {
        let e = cwd.as_str().and_then(|c| self.cost_map.get(c)).filter(|e| truthy(e));
        let today = e.map(|e| get(e, "today")).filter(|v| truthy(v)).cloned().unwrap_or(json!(0));
        let unpriced = e.map(|e| get(e, "unpricedToday")).filter(|v| truthy(v)).cloned().unwrap_or(json!([]));
        (today, unpriced)
    }

    fn issue_fields(&self, w: &Value) -> Vec<(String, Value)> {
        if !self.ghi_on {
            return Vec::new();
        }
        let n = token_value(get(w, "desc").as_str().unwrap_or(""), "issue");
        if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
            return Vec::new();
        }
        let cwd = get(w, "cwd").as_str().unwrap_or("");
        let slug = if cwd.is_empty() { String::new() } else { state::remote_slug(cwd) };
        vec![
            ("issue".into(), json!(format!("#{n}"))),
            ("issue_url".into(), json!(if slug.is_empty() { String::new() } else {
                format!("https://github.com/{slug}/issues/{n}") })),
        ]
    }

    fn jira_link(&self, w: &Value) -> Option<String> {
        if self.jira_site.is_empty() {
            return None;
        }
        jira_key(get(w, "title").as_str().unwrap_or(""))
            .or_else(|| jira_key(&get(w, "branch").as_str().unwrap_or("").to_uppercase()))
    }
}

fn integrations() -> Value {
    std::fs::read_to_string(crew_core::crew_home().join("integrations.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// rank(): the tiered rows and the quiet ones, families grouped.
pub fn rank(wss: &[Value], plan_by_root: &Map<String, Value>, screens: bool) -> (Vec<Value>, Vec<Value>) {
    let cwds: Vec<String> = wss.iter()
        .filter(|w| truthy(get(w, "cwd")))
        .map(|w| py_str(get(w, "cwd")))
        .collect();
    let integ = integrations();
    let gh = get(&integ, "github_issues");
    let j = get(&integ, "jira");
    let ctx = Ctx {
        cost_map: costs::costs_for(&cwds),
        jmap: judgments::fresh_map(None, None),
        stuck_t: judgments::stuck_threshold(),
        ghi_on: truthy(get(gh, "enabled")),
        jira_site: if truthy(get(j, "enabled")) { crate::pyval::str_or_empty(get(j, "site")) } else { String::new() },
        now: crew_core::py::now() as i64,
    };

    let (mut rows, mut quiet): (Vec<Value>, Vec<Value>) = (Vec::new(), Vec::new());
    for w in wss {
        let d = get(w, "desc").as_str().unwrap_or("");
        let plan = get(w, "cwd").as_str().and_then(|c| plan_by_root.get(c)).filter(|p| truthy(p));
        let failed = failed_check(plan);
        let running = truthy(get(w, "running"));
        let branch = get(w, "branch");
        let pr = get(w, "pr");
        let mut kind: Option<&str> = None;
        let mut badge = "";
        let mut said = String::new();
        let mut chips: Vec<String> = Vec::new();
        let mut subject = json!("");
        let mut meta_bits = Vec::new();
        if let Some(p) = plan {
            meta_bits.push(incs(p));
            meta_bits.extend(hold_bits(plan));
        }
        let phase = plan.map(|p| get(p, "phase").clone()).unwrap_or(Value::Null);
        let gate_allow = plan.map(|p| truthy(get(get(p, "gate"), "allow"))).unwrap_or(true);
        let blocked = plan.map(|p| get(progress(p), "blocked")).filter(|b| truthy(b));

        if has(d, "phase:waiting") {
            (kind, badge) = (Some("attend"), "asked you");
            said = "Waiting on an answer.".into();
            chips = vec!["jump".into()];
        } else if plan.is_some() && phase == "review" {
            (kind, badge) = (Some("attend"), "review");
            said = format!("{{{{Alignment check not taken.}}}} {} increments are locked behind it — \
nothing in this worktree can be edited until it passes.", pct_d(get(progress(plan.unwrap()), "total")));
            chips = vec!["take the check".into(), "plan".into()];
        } else if plan.is_some() && !gate_allow {
            let p = plan.unwrap();
            let nxt = get(progress(p), "next");
            let nxt = if truthy(nxt) { nxt.clone() } else { json!({}) };
            (kind, badge) = (Some("attend"), "gate shut");
            subject = nxt.get("title").cloned().unwrap_or(json!(""));
            said = go_said(plan, &get_s(&nxt, "title", "The next increment"),
                           Some(&py_str(get(get(p, "gate"), "why"))));
            chips = vec![go_chip(plan, &get_s(&nxt, "n", "?")), "diff".into(), "jump".into()];
        } else if has(d, "ci:fail") {
            (kind, badge) = (Some("wilt"), "ci failed");
            said = if is_none_str(branch) { "Checks are red.".into() }
                   else { format!("Checks are red on `{}`.", py_str(branch)) };
            chips = vec!["checks".into(), "diff".into(), "jump".into()];
        } else if let Some(f) = failed {
            (kind, badge) = (Some("wilt"), "check failed");
            subject = json!(failed_subject(f));
            let how = if get(f, "status") == "lost" { "lost its runner" } else { "failed" };
            said = format!("{{{{Increment {}'s check `{}` {}.}}}} It cannot close until the check passes.",
                           py_str(get(f, "n")), py_str(get(f, "id")), how);
            chips = vec!["plan".into(), "jump".into()];
        } else if has(d, "pr:conflict") {
            (kind, badge) = (Some("wilt"), "conflicts");
            said = "This branch conflicts with its base.".into();
            chips = vec!["diff".into(), "jump".into()];
        } else if has(d, "review:changes") {
            (kind, badge) = (Some("wilt"), "changes");
            said = "A reviewer asked for changes.".into();
            chips = vec!["pr".into(), "jump".into()];
        } else if let Some(b) = blocked {
            let b = &b[0];
            (kind, badge) = (Some("wilt"), "blocked");
            subject = b.get("title").cloned().unwrap_or(json!(""));
            said = format!("{{{{{}}}}} is blocked: {}", get_s(b, "title", "An increment"),
                           get_s(b, "note", "no reason recorded"));
            chips = vec!["jump".into()];
        } else if judgments::stuck_for(w, &ctx.jmap, Some(ctx.stuck_t)) {
            (kind, badge) = (Some("wilt"), "stuck");
            said = "Last turn ended on an error the agent could not get past.".into();
            chips = vec!["jump".into(), "diff".into()];
        } else if running || has(d, "phase:working") {
            (kind, badge) = (Some("running"), "working");
            let open = plan.map(|p| get(progress(p), "open")).filter(|o| truthy(o)).and_then(Value::as_array);
            match open.and_then(|o| o.first()) {
                Some(o0) => {
                    subject = o0["title"].clone();
                    said = format!("{{{{{}}}}} in progress.", py_str(&o0["title"]));
                }
                None => said = "Mid-turn.".into(),
            }
            chips = vec!["diff".into(), "jump".into()];
        } else if has(d, "gone:merged") {
            (kind, badge) = (Some("done"), "merged");
            said = "Merged. The worktree can be reclaimed.".into();
            chips = vec!["reclaim".into(), "jump".into()];
        } else if plan.is_some() && phase == "done" {
            (kind, badge) = (Some("done"), "plan done");
            said = "Every increment is done; the gate has retired.".into();
            chips = vec!["close plan".into()];
        }

        let (cost, unpriced) = ctx.cost(get(w, "cwd"));
        let tail = |r: &mut Map<String, Value>, signals: Vec<Value>, feedby: Value, feedgate: Value, subject: Value| {
            for (k, v) in ctx.issue_fields(w) {
                r.insert(k, v);
            }
            r.insert("branch".into(), none_blank(branch));
            r.insert("dirty".into(), json!(truthy(get(w, "dirty"))));
            r.insert("pr".into(), none_blank(pr));
            r.insert("pr_state".into(), w.get("pr_state").cloned().unwrap_or(json!("")));
            r.insert("color".into(), w.get("color").cloned().unwrap_or(json!("")));
            r.insert("selected".into(), json!(truthy(get(w, "selected"))));
            r.insert("signals".into(), Value::Array(signals));
            r.insert("feedby".into(), feedby);
            r.insert("feedgate".into(), feedgate);
            r.insert("ref".into(), w.get("ref").cloned().unwrap_or(json!("")));
            r.insert("cwd".into(), get(w, "cwd").clone());
            r.insert("pr_url".into(), w.get("pr_url").cloned().unwrap_or(json!("")));
            r.insert("slug".into(), plan.and_then(|p| p.get("slug")).cloned().unwrap_or(json!("")));
            r.insert("subject".into(), subject);
            let commits = get(w, "commits");
            r.insert("commits".into(), if truthy(commits) { commits.clone() } else { json!([]) });
            for (k, v) in fam_fields(plan) {
                r.insert(k, v);
            }
        };

        let Some(kind) = kind else {
            let qbadge = if plan.is_some() { "plan idle" }
                else if !is_none_str(pr) { "pr open" }
                else if truthy(get(w, "dirty")) { "uncommitted" }
                else { "idle" };
            let mut qmeta = plan.map(incs).into_iter().collect::<Vec<_>>();
            qmeta.extend(hold_bits(plan));
            let mut qchips = vec!["jump".to_string()];
            if truthy(get(w, "dirty")) {
                qchips.push("diff".into());
            }
            if !is_none_str(pr) {
                qchips.push("pr".into());
            }
            if !running {
                qchips.push("archive".into());
            }
            qchips.push("wake".into());
            let mut r = Map::new();
            r.insert("id".into(), get(w, "id").clone());
            r.insert("name".into(), get(w, "title").clone());
            r.insert("kind".into(), json!("quiet"));
            r.insert("badge".into(), json!(qbadge));
            r.insert("said".into(), json!(""));
            r.insert("chips".into(), json!(qchips));
            r.insert("frac".into(), frac(plan));
            r.insert("meta".into(), json!(qmeta.join(" · ")));
            r.insert("cost".into(), cost);
            r.insert("cost_unpriced".into(), unpriced);
            tail(&mut r, Vec::new(), json!(0), json!(""), json!(""));
            quiet.push(Value::Object(r));
            continue;
        };

        chips.push("wake".into());
        if screens && matches!(kind, "attend" | "running" | "wilt") {
            let live = state::last_line(&py_str(get(w, "id")));
            if !live.is_empty() {
                said = format!("`{live}`");
            }
        }
        let jl = ctx.jira_link(w);
        let sigs = dedupe(&chips, signals(d, !is_none_str(pr), jl.as_deref(), ctx.now), plan.is_some());
        let feedby = token_value(d, "feedby");
        let feedby = if feedby.is_empty() { 0 } else { crate::pyval::parse_int(&feedby).unwrap_or(0) };
        let mut r = Map::new();
        r.insert("id".into(), get(w, "id").clone());
        r.insert("name".into(), get(w, "title").clone());
        r.insert("kind".into(), json!(kind));
        r.insert("badge".into(), json!(badge));
        r.insert("said".into(), json!(said));
        r.insert("chips".into(), json!(chips));
        r.insert("frac".into(), frac(plan));
        r.insert("meta".into(), json!(meta_bits.join(" · ")));
        r.insert("urgency".into(), pyjson::float(judgments::urgency_for(w, &ctx.jmap)));
        r.insert("cost".into(), cost);
        r.insert("cost_unpriced".into(), unpriced);
        tail(&mut r, sigs, json!(feedby), json!(token_value(d, "feedgate")), subject);
        rows.push(Value::Object(r));
    }

    sort_tiers(&mut rows, true);
    families::group(rows, quiet)
}

fn tier(r: &Value) -> i64 {
    match r.get("kind").and_then(Value::as_str) {
        Some("attend") => 0,
        Some("wilt") => 1,
        Some("running") => 2,
        Some("done") => 3,
        Some("quiet") => 4,
        _ => 9,
    }
}

/// Stable sort by tier, then (with urgency) the higher urgency first.
fn sort_tiers(rows: &mut [Value], by_urgency: bool) {
    rows.sort_by(|a, b| {
        let t = tier(a).cmp(&tier(b));
        if !by_urgency {
            return t;
        }
        let ua = a.get("urgency").and_then(py_float).unwrap_or(0.0);
        let ub = b.get("urgency").and_then(py_float).unwrap_or(0.0);
        t.then((-ua).partial_cmp(&-ub).unwrap_or(std::cmp::Ordering::Equal))
    });
}

/// The same tiers from plan state alone, for when cmux is down.
pub fn rank_plans_only(plan_by_root: &Map<String, Value>) -> Vec<Value> {
    let mut rows: Vec<Value> = Vec::new();
    for (root, plan) in plan_by_root {
        let pr = progress(plan);
        let total = pct_d(get(pr, "total"));
        let base = root.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let name = if base.is_empty() { plan["slug"].clone() } else { json!(base) };
        let meta = std::iter::once(format!("{}/{} increments · {}", pct_d(get(pr, "done")), total, py_str(get(plan, "slug"))))
            .chain(hold_bits(Some(plan))).collect::<Vec<_>>().join(" · ");
        let mut r = Map::new();
        r.insert("id".into(), get(plan, "slug").clone());
        r.insert("name".into(), name);
        let mut put = |kind: &str, badge: &str, said: String, subject: Option<Value>, chips: Vec<String>| {
            r.insert("kind".into(), json!(kind));
            r.insert("badge".into(), json!(badge));
            r.insert("said".into(), json!(said));
            if let Some(s) = subject {
                r.insert("subject".into(), s);
            }
            r.insert("chips".into(), json!(chips));
            r.insert("frac".into(), frac(Some(plan)));
            r.insert("meta".into(), json!(meta.clone()));
        };
        let phase = get(plan, "phase");
        let blocked = get(pr, "blocked");
        if phase == "review" {
            put("attend", "review", format!("{{{{Alignment check not taken.}}}} {total} increments are locked behind it."),
                None, vec!["take the check".into(), "plan".into()]);
        } else if !truthy(get(get(plan, "gate"), "allow")) {
            let nxt = get(pr, "next");
            let nxt = if truthy(nxt) { nxt.clone() } else { json!({}) };
            put("attend", "gate shut",
                go_said(Some(plan), &get_s(&nxt, "title", "The next increment"), None),
                Some(nxt.get("title").cloned().unwrap_or(json!(""))),
                vec![go_chip(Some(plan), &get_s(&nxt, "n", "?")), "plan".into()]);
        } else if let Some(f) = failed_check(Some(plan)) {
            put("wilt", "check failed",
                format!("{{{{Increment {}'s check `{}` failed.}}}}", py_str(get(f, "n")), py_str(get(f, "id"))),
                Some(json!(failed_subject(f))), vec!["plan".into()]);
        } else if truthy(blocked) {
            let b = &blocked[0];
            put("wilt", "blocked",
                format!("{{{{{}}}}} is blocked: {}", get_s(b, "title", "An increment"), get_s(b, "note", "no reason recorded")),
                Some(b.get("title").cloned().unwrap_or(json!(""))), vec!["plan".into()]);
        } else if phase == "done" {
            put("done", "plan done", "Every increment is done; the gate has retired.".into(), None, vec!["close plan".into()]);
        } else {
            let open = get(pr, "open");
            let first = if truthy(open) { open.get(0) } else { None };
            let (said, subj) = match first {
                Some(o) => (format!("{{{{{}}}}} in progress.", py_str(&o["title"])), o["title"].clone()),
                None => ("Implementing.".to_string(), json!("")),
            };
            put("running", "working", said, Some(subj), vec!["plan".into()]);
        }
        for (k, v) in fam_fields(Some(plan)) {
            r.insert(k, v);
        }
        // Python's setdefault chain, in its order: present keys keep their place.
        let defaults: [(&str, Value); 19] = [
            ("slug", r["id"].clone()), ("ref", json!("")), ("cwd", json!("")), ("pr_url", json!("")),
            ("branch", json!("")), ("dirty", json!(false)), ("pr", json!("")), ("pr_state", json!("")),
            ("color", json!("")), ("signals", json!([])), ("feedby", json!(0)), ("feedgate", json!("")),
            ("selected", json!(false)), ("cost", json!(0)), ("cost_unpriced", json!([])),
            ("issue", json!("")), ("issue_url", json!("")), ("subject", json!("")), ("commits", json!([])),
        ];
        for (k, v) in defaults {
            if !r.contains_key(k) {
                r.insert(k.into(), v);
            }
        }
        rows.push(Value::Object(r));
    }
    sort_tiers(&mut rows, false);
    families::group(rows, Vec::new()).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jira_keys_match_pythons_regex() {
        assert_eq!(jira_key("fix PROJ-1039 prelim"), Some("PROJ-1039".into()));
        assert_eq!(jira_key("DEV/PROJ-12-X"), Some("PROJ-12".into()));
        assert_eq!(jira_key("xPROJ-1"), None);
        assert_eq!(jira_key("PROJ-1a"), None);
        assert_eq!(jira_key("P-1"), None);
    }

    #[test]
    fn a_chip_drops_the_signal_with_its_verb() {
        let sigs = vec![json!({"t": "✗ CI", "c": "", "h": "", "a": "checks"}),
                        json!({"t": "go 3", "c": "", "h": "", "a": "go", "x": "3"}),
                        json!({"t": "◈ 2/4", "c": "", "h": ""})];
        let out = dedupe(&["checks".into(), "go 3".into()], sigs, true);
        assert!(out.is_empty());
    }

    #[test]
    fn tokens_read_their_value() {
        assert_eq!(token_value("ci:fail planinc:2/4 jira:in-review", "planinc"), "2/4");
        assert_eq!(token_value("x", "planinc"), "");
    }
}
