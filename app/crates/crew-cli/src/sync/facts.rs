//! What crew-sync reads: cmux's session store, git, gh, Jira, sandboxes,
//! deep-plan's state and the task lists. Every reader degrades to "nothing
//! known" the way the Python's `except Exception` does; none writes to cmux.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::Duration;

use crew_core::{py, pyjson};
use serde_json::{json, Map, Value};

use crate::proc::{self, Out};
use crate::pypath::{self, join};
use crate::pyval::{py_str, py_strip, read_json, read_text, truthy};
use crate::{color, md5};

/// Where everything lives, resolved once per run, as the Python resolves its
/// module constants.
pub struct Paths {
    pub home: String,
    pub state: String,
    pub store: String,
    pub tasks: String,
    pub sbx: String,
    pub sandbox_reg: String,
    pub projects: String,
    pub deep_active: String,
    pub deep_state: String,
    pub deep_plans: String,
    pub chime: String,
}

impl Paths {
    pub fn from_env() -> Paths {
        let home = pypath::home();
        // os.environ.get("XDG_CACHE_HOME", default): set-but-empty counts as set.
        let xdg = std::env::var("XDG_CACHE_HOME").unwrap_or_else(|_| join(&home, ".cache"));
        let state = join(&xdg, "cmux-crew");
        let env_or = |k: &str, d: String| py::env_or(k).unwrap_or(d);
        Paths {
            store: join(&home, ".cmuxterm/claude-hook-sessions.json"),
            tasks: join(&home, ".claude/tasks"),
            sbx: env_or("CREW_SBX", "/opt/homebrew/bin/sbx".into()),
            sandbox_reg: join(&state, "sandbox/roots"),
            projects: join(&home, ".claude/projects"),
            deep_active: join(&home, ".claude/deep-plan/active"),
            deep_state: env_or("DEEP_PLAN_STATE_DIR", join(&home, ".claude/deep-plan/state")),
            deep_plans: env_or("DEEP_PLAN_PLANS_DIR", join(&home, ".claude/plans")),
            chime: join(&home, ".config/ghostty/whimsy/sounds/chime.wav"),
            state,
            home,
        }
    }
}

fn secs(n: u64) -> Option<Duration> {
    Some(Duration::from_secs(n))
}

pub fn git(args: &[&str], timeout: u64) -> Option<Out> {
    let mut argv = vec!["git"];
    argv.extend_from_slice(args);
    proc::run(&argv, None, &[], secs(timeout))
}

/// `os.listdir(dir)` in directory order; None when it cannot be listed.
pub fn listdir(dir: &str) -> Option<Vec<String>> {
    let rd = fs::read_dir(dir).ok()?;
    Some(rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
}

/// `os.path.realpath` (non-strict): symlinks resolved component by component
/// with lstat and readlink, the rest kept lexically, letter case as given (a
/// case-insensitive volume does not fold it, unlike realpath(3)).
pub fn realpath(p: &str) -> String {
    fn split(path: &str) -> (String, String) {
        match path.rfind('/') {
            Some(i) => {
                let head = &path[..=i];
                let head = if head.chars().all(|c| c == '/') { head.to_string() } else { head.trim_end_matches('/').to_string() };
                (head, path[i + 1..].to_string())
            }
            None => (String::new(), path.to_string()),
        }
    }
    fn walk(mut path: String, rest: &str, seen: &mut HashMap<String, Option<String>>) -> (String, bool) {
        let mut rest = rest.to_string();
        if rest.starts_with('/') {
            rest = rest[1..].to_string();
            path = "/".into();
        }
        while !rest.is_empty() {
            let (name, tail) = match rest.split_once('/') {
                Some((n, t)) => (n.to_string(), t.to_string()),
                None => (rest.clone(), String::new()),
            };
            rest = tail;
            if name.is_empty() || name == "." {
                continue;
            }
            if name == ".." {
                if !path.is_empty() {
                    let (head, last) = split(&path);
                    path = head;
                    if last == ".." {
                        path = join(&join(&path, ".."), "..");
                    }
                } else {
                    path = "..".into();
                }
                continue;
            }
            let newpath = join(&path, &name);
            let is_link = fs::symlink_metadata(&newpath).map(|m| m.file_type().is_symlink()).unwrap_or(false);
            if !is_link {
                path = newpath;
                continue;
            }
            if let Some(known) = seen.get(&newpath) {
                match known {
                    Some(resolved) => {
                        path = resolved.clone();
                        continue;
                    }
                    None => return (join(&newpath, &rest), false), // a loop
                }
            }
            seen.insert(newpath.clone(), None);
            let target = fs::read_link(&newpath).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
            let (p2, ok) = walk(path, &target, seen);
            if !ok {
                return (join(&p2, &rest), false);
            }
            path = p2;
            seen.insert(newpath, Some(path.clone()));
        }
        (path, true)
    }
    let (out, _) = walk(String::new(), p, &mut HashMap::new());
    pypath::abspath(&out)
}

/// `os.path.relpath(path, start)`.
pub fn relpath(path: &str, start: &str) -> String {
    let parts = |p: &str| -> Vec<String> {
        pypath::abspath(p).split('/').filter(|x| !x.is_empty()).map(String::from).collect()
    };
    let (s, p) = (parts(start), parts(path));
    let i = s.iter().zip(&p).take_while(|(a, b)| a == b).count();
    let mut rel: Vec<String> = vec!["..".into(); s.len() - i];
    rel.extend(p[i..].iter().cloned());
    if rel.is_empty() {
        ".".into()
    } else {
        rel.join("/")
    }
}

// --- the session store --------------------------------------------------------

/// (activeSessionsByWorkspace, sessions), each `{}` when unreadable.
pub fn sessions(p: &Paths) -> (Value, Value) {
    let Some(d) = read_json(&p.store) else { return (json!({}), json!({})) };
    let pick = |k: &str| match d.get(k) {
        Some(v) if truthy(Some(v)) => v.clone(),
        _ => json!({}),
    };
    if !d.is_object() {
        return (json!({}), json!({}));
    }
    (pick("activeSessionsByWorkspace"), pick("sessions"))
}

/// `os.kill(int(pid), 0)` succeeded.
pub fn alive(pid: Option<&Value>) -> bool {
    if !truthy(pid) {
        return false;
    }
    let n: Option<i64> = match pid {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f.trunc() as i64)),
        Some(Value::Bool(b)) => Some(*b as i64),
        Some(Value::String(s)) => crate::pyval::py_int(s).and_then(|v| i64::try_from(v).ok()),
        _ => None,
    };
    let Some(n) = n.and_then(|n| libc::pid_t::try_from(n).ok()) else { return false };
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    unsafe { libc::kill(n, 0) == 0 }
}

// --- git ------------------------------------------------------------------------

pub fn branch(cwd: &str) -> String {
    git(&["-C", cwd, "branch", "--show-current"], 5).map(|o| py_strip(&o.stdout).to_string()).unwrap_or_default()
}

pub fn toplevel(cwd: &str) -> String {
    git(&["-C", cwd, "rev-parse", "--show-toplevel"], 5).map(|o| py_strip(&o.stdout).to_string()).unwrap_or_default()
}

fn letters(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphabetic())
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `^[A-Za-z]+-\d+$`
fn is_ticket(s: &str) -> bool {
    match s.split_once('-') {
        Some((a, b)) => letters(a) && digits(b),
        None => false,
    }
}

/// "PROJ-961 · body" from a branch name, or "".
pub fn ticket_label(b: &str) -> String {
    if b.is_empty() || b == "HEAD" {
        return String::new();
    }
    let rest = b.split_once('/').map(|(_, r)| r).unwrap_or(b);
    // ^(.+)-([A-Za-z]+-\d+)$ : greedy body, so the last split that works.
    let dashes: Vec<usize> = rest.match_indices('-').map(|(i, _)| i).collect();
    let mut found: Option<(String, String)> = None;
    for &p in dashes.iter().rev() {
        if p >= 1 && is_ticket(&rest[p + 1..]) {
            found = Some((rest[p + 1..].to_string(), rest[..p].to_string()));
            break;
        }
    }
    // ^([A-Za-z]+-\d+)-(.+)$
    if found.is_none() {
        if let Some((a, r)) = rest.split_once('-') {
            let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
            let body = &r[d.len()..];
            if letters(a) && !d.is_empty() && body.len() >= 2 && body.starts_with('-') {
                found = Some((format!("{a}-{d}"), body[1..].to_string()));
            }
        }
    }
    // ^([A-Za-z]+-\d+)$
    if found.is_none() && is_ticket(rest) {
        found = Some((rest.to_string(), String::new()));
    }
    match found {
        Some((tick, body)) if body.is_empty() => tick.to_uppercase(),
        Some((tick, body)) => format!("{} · {body}", tick.to_uppercase()),
        None => String::new(),
    }
}

pub fn ticket_key(b: &str) -> String {
    ticket_label(b).split(' ').next().unwrap_or("").to_string()
}

/// `^[A-Z]+-\d+( · |$)` on a title (`$` also before a trailing newline).
pub fn crew_named(t: &str) -> bool {
    let up: String = t.chars().take_while(|c| c.is_ascii_uppercase()).collect();
    if up.is_empty() {
        return false;
    }
    let r = &t[up.len()..];
    let Some(r) = r.strip_prefix('-') else { return false };
    let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
    if d.is_empty() {
        return false;
    }
    let r = &r[d.len()..];
    r.is_empty() || r == "\n" || r.starts_with(" · ")
}

pub fn desired_name(cwd: &str) -> String {
    let mut label = ticket_label(&branch(cwd));
    if label.is_empty() {
        return label;
    }
    let top = toplevel(cwd);
    if !top.is_empty() && realpath(cwd) != realpath(&top) {
        label.push_str(&format!(" / {}", relpath(cwd, &top)));
    }
    label
}

pub fn default_base(cwd: &str) -> Option<String> {
    let r = git(&["-C", cwd, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 5)?;
    if r.code == 0 && !py_strip(&r.stdout).is_empty() {
        return Some(py_strip(&r.stdout).to_string());
    }
    for b in ["origin/main", "origin/master"] {
        let r = git(&["-C", cwd, "show-ref", "--verify", "--quiet", &format!("refs/remotes/{b}")], 5)?;
        if r.code == 0 {
            return Some(b.into());
        }
    }
    None
}

pub fn merged_already(cwd: &str) -> bool {
    let b = branch(cwd);
    if b.is_empty() || b == "master" || b == "main" {
        return false;
    }
    let Some(base) = default_base(cwd) else { return false };
    git(&["-C", cwd, "merge-base", "--is-ancestor", "HEAD", &base], 10).is_some_and(|r| r.code == 0)
}

// --- json caches ----------------------------------------------------------------

/// `json.dump(obj, open(tmp, "w"))` then `os.replace`: the Python's default
/// separators, through a per-pid temp file.
pub fn write_json(path: &str, obj: &Value) -> bool {
    let tmp = format!("{path}.{}.tmp", std::process::id());
    let ok = fs::write(&tmp, pyjson::dumps(obj)).and_then(|_| fs::rename(&tmp, path)).is_ok();
    if Path::new(&tmp).exists() {
        let _ = fs::remove_file(&tmp);
    }
    ok
}

/// `int(os.environ.get(name, default))`; None where int() would raise.
pub fn env_int(name: &str, default: i64) -> Option<i64> {
    match std::env::var(name) {
        Ok(v) => crate::pyval::py_int(&v).and_then(|n| i64::try_from(n).ok()),
        Err(_) => Some(default),
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        None => Some(0.0),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(*b as i64 as f64),
        _ => None,
    }
}

// --- Jira -------------------------------------------------------------------------

/// {KEY: [name, category]} for every ticket, batched through acli and cached.
pub fn jira_status(p: &Paths, keys: &[String], ttl: i64) -> HashMap<String, (String, String)> {
    let keys: Vec<String> = keys.iter().filter(|k| !k.is_empty()).cloned().collect::<BTreeSet<_>>().into_iter().collect();
    if keys.is_empty() {
        return HashMap::new();
    }
    let cache = join(&p.state, "jira.json");
    let now = py::now();
    let as_map = |c: &Value| -> Option<HashMap<String, (String, String)>> {
        let st = match c.get("status") {
            Some(v) if truthy(Some(v)) => v.as_object()?.clone(),
            _ => Map::new(),
        };
        let mut out = HashMap::new();
        for (k, v) in st {
            // tuple(v): the name is v[0]; the category, when there is one, v[1].
            let a = v.as_array()?;
            let name = a.first()?;
            out.insert(k, (py_str(name), a.get(1).map(py_str).unwrap_or_default()));
        }
        Some(out)
    };
    if let Some(c) = read_json(&cache).filter(Value::is_object) {
        let fresh = num(c.get("at")).is_some_and(|at| now - at < ttl as f64);
        let have: HashSet<String> = match c.get("keys") {
            Some(Value::Array(a)) => a.iter().map(py_str).collect(),
            _ => HashSet::new(),
        };
        if fresh && keys.iter().all(|k| have.contains(k)) {
            if let Some(m) = as_map(&c) {
                return m;
            }
        }
    }
    let mut out: Vec<(String, (String, String))> = Vec::new();
    let jql = format!("key in ({})", keys.join(","));
    if let Some(r) = proc::run(
        &["acli", "jira", "workitem", "search", "--jql", &jql, "--fields", "status", "--json"],
        None,
        &[],
        secs(60),
    ) {
        if r.code == 0 && !py_strip(&r.stdout).is_empty() {
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&r.stdout) {
                for item in &items {
                    let Some(o) = item.as_object() else { break };
                    let k = o.get("key").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
                    let st = o.get("fields").and_then(|f| f.get("status")).cloned().unwrap_or(json!({}));
                    if !k.is_empty() && truthy(st.get("name")) {
                        let cat = st.get("statusCategory").and_then(|c| c.get("key")).filter(|v| truthy(Some(v)));
                        out.push((k, (py_str(&st["name"]), cat.map(py_str).unwrap_or_default())));
                    }
                }
            }
        }
    }
    if out.is_empty() {
        // A failed poll must not read as "the ticket has no status".
        return read_json(&cache).and_then(|c| as_map(&c)).unwrap_or_default();
    }
    let mut status = Map::new();
    for (k, (n, c)) in &out {
        status.insert(k.clone(), json!([n, c]));
    }
    let _ = fs::create_dir_all(&p.state);
    write_json(&cache, &json!({"at": pyjson::float(now), "keys": keys, "status": status}));
    out.into_iter().collect()
}

/// `jira:<slug>`, slugged so the board can match it with .contains().
pub fn jira_token(entry: Option<&(String, String)>) -> String {
    let Some((name, _)) = entry else { return String::new() };
    let mut slug = String::new();
    let mut gap = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    if slug.is_empty() {
        String::new()
    } else {
        format!("jira:{slug}")
    }
}

// --- gh ---------------------------------------------------------------------------

pub const SIGNAL_PREFIXES: [&str; 6] = ["ci:", "review:", "pr:", "stack:", "gone:", "issue:"];
const GH_FIELDS: &str =
    "number,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,url,closingIssuesReferences";
const GH_FIELDS_OLD: &str =
    "number,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,url";

pub fn gh_cache_path(p: &Paths, cwd: &str) -> String {
    join(&p.state, &format!("gh-{}.json", md5::hex(cwd.as_bytes())))
}

fn upper(v: Option<&Value>) -> Option<String> {
    match v {
        None => Some(String::new()),
        Some(x) if !truthy(Some(x)) => Some(String::new()),
        Some(Value::String(s)) => Some(s.to_uppercase()),
        Some(_) => None, // .upper() on a non-string raises
    }
}

/// gh's answer reduced to crew's PR facts; None where the Python's parse raised.
fn pr_facts(d: &Value) -> Option<Map<String, Value>> {
    let d = d.as_object()?;
    let roll: Vec<Value> = match d.get("statusCheckRollup") {
        Some(Value::Array(a)) => a.clone(),
        Some(v) if truthy(Some(v)) => return None,
        _ => vec![],
    };
    let (mut bad, mut pending) = (Vec::new(), 0);
    for c in &roll {
        let c = c.as_object()?;
        let first = ["conclusion", "state"].iter().find_map(|k| c.get(*k).filter(|v| truthy(Some(v))));
        let verdict = upper(first)?;
        if ["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR"].contains(&verdict.as_str()) {
            let name = ["name", "context"].iter().find_map(|k| c.get(*k).filter(|v| truthy(Some(v)))).cloned();
            bad.push(name.unwrap_or(json!("check")));
        } else if ["", "PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].contains(&verdict.as_str()) {
            pending += 1;
        }
    }
    let or_empty = |k: &str| d.get(k).filter(|v| truthy(Some(v))).cloned().unwrap_or(json!(""));
    let issue = match d.get("closingIssuesReferences") {
        Some(Value::Array(a)) if !a.is_empty() => a[0].as_object()?.get("number").cloned().unwrap_or(Value::Null),
        Some(v) if truthy(Some(v)) => return None,
        _ => Value::Null,
    };
    let mut out = Map::new();
    out.insert("pr".into(), d.get("number").cloned().unwrap_or(Value::Null));
    out.insert("url".into(), or_empty("url"));
    out.insert("base".into(), or_empty("baseRefName"));
    out.insert("prState".into(), json!(upper(d.get("state"))?));
    out.insert("draft".into(), json!(truthy(d.get("isDraft"))));
    out.insert("review".into(), json!(upper(d.get("reviewDecision"))?));
    out.insert("mergeable".into(), json!(upper(d.get("mergeable"))?));
    out.insert("mergeState".into(), json!(upper(d.get("mergeStateStatus"))?));
    out.insert("ciFail".into(), Value::Array(bad));
    out.insert("ciPending".into(), json!(pending));
    out.insert("ciTotal".into(), json!(roll.len()));
    out.insert("issue".into(), issue);
    Some(out)
}

/// Cached PR state for a worktree; `{}`-like when there is no PR. A probe
/// that could not tell carries the previous answer and never earns a fresh `at`.
pub fn gh_state(p: &Paths, cwd: &str, ttl: i64) -> Map<String, Value> {
    let path = gh_cache_path(p, cwd);
    let now = py::now();
    if Path::new(&path).exists() {
        if let Some(Value::Object(c)) = read_json(&path) {
            if num(c.get("at")).is_some_and(|at| now - at < ttl as f64) {
                return c;
            }
        }
    }
    let mut out = Map::new();
    let mut answered = false;
    let run = |fields: &str| proc::run(&["gh", "pr", "view", "--json", fields], Some(cwd), &[], secs(30));
    if let Some(mut r) = run(GH_FIELDS) {
        let mut ok = true;
        if r.code != 0 && r.stderr.contains("closingIssuesReferences") {
            match run(GH_FIELDS_OLD) {
                Some(r2) => r = r2,
                None => ok = false,
            }
        }
        if ok {
            let no_pr = r.stderr.to_lowercase().contains("no pull requests found");
            answered = r.code == 0 || no_pr;
            if !no_pr && r.code == 0 && !py_strip(&r.stdout).is_empty() {
                if let Some(o) = serde_json::from_str::<Value>(&r.stdout).ok().as_ref().and_then(pr_facts) {
                    out = o;
                }
            }
        }
    }
    let prev = match read_json(&path) {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    };
    if !answered && !prev.is_empty() {
        out = prev.iter().filter(|(k, _)| !["at", "notified", "fresh"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    }
    let at = if answered {
        pyjson::float(now)
    } else {
        // max(prev.get("at", 0), now - GH_TTL + 60), keeping the winner's type.
        let floor = now - ttl as f64 + 60.0;
        match prev.get("at") {
            Some(v) if num(Some(v)).is_some_and(|a| a >= floor) => v.clone(),
            None if 0.0 >= floor => json!(0),
            _ => pyjson::float(floor),
        }
    };
    out.insert("at".into(), at);
    out.insert("fresh".into(), json!(answered));
    out.insert("notified".into(), prev.get("notified").cloned().unwrap_or(json!({})));
    let _ = fs::create_dir_all(&p.state);
    write_json(&path, &Value::Object(out.clone()));
    out
}

// --- sandboxes --------------------------------------------------------------------

/// `shlex.split(s)` (POSIX); None where it raises (an unclosed quote).
fn shlex_split(s: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut have = false;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            // shlex's whitespace: space, tab, CR and LF only
            ' ' | '\t' | '\r' | '\n' => {
                if have {
                    out.push(std::mem::take(&mut cur));
                    have = false;
                }
            }
            '\\' => {
                have = true;
                cur.push(it.next()?);
            }
            '\'' => {
                have = true;
                loop {
                    match it.next()? {
                        '\'' => break,
                        x => cur.push(x),
                    }
                }
            }
            '"' => {
                have = true;
                loop {
                    match it.next()? {
                        '"' => break,
                        '\\' => match it.peek() {
                            Some('"') | Some('\\') => cur.push(it.next()?),
                            _ => cur.push('\\'),
                        },
                        x => cur.push(x),
                    }
                }
            }
            c => {
                have = true;
                cur.push(c);
            }
        }
    }
    if have {
        out.push(cur);
    }
    Some(out)
}

/// {worktree root: sandbox name} from crew-sandbox's registry.
pub fn sandbox_registry(p: &Paths) -> Vec<(String, String)> {
    let mut roots: Vec<(String, String)> = Vec::new();
    for f in listdir(&p.sandbox_reg).unwrap_or_default() {
        let Some(txt) = read_text(&join(&p.sandbox_reg, &f)) else { continue };
        let (mut name, mut root) = (String::new(), String::new());
        for line in py::splitlines(&txt) {
            if let Some(v) = line.strip_prefix("NAME=") {
                name = py_strip(v).to_string();
            } else if let Some(v) = line.strip_prefix("ROOT=") {
                root = py_strip(v).to_string();
                if let Some(parts) = shlex_split(&root) {
                    if parts.len() == 1 {
                        root = parts[0].clone();
                    }
                }
            }
        }
        if !name.is_empty() && !root.is_empty() {
            match roots.iter_mut().find(|(r, _)| *r == root) {
                Some(slot) => slot.1 = name,
                None => roots.push((root, name)),
            }
        }
    }
    roots
}

/// {sandbox name: status} from one `sbx ls --json`.
pub fn sandbox_states(p: &Paths) -> HashMap<String, String> {
    let mut states = HashMap::new();
    let Some(r) = proc::run(&[&p.sbx, "ls", "--json"], None, &[], secs(15)) else { return states };
    let Ok(d) = serde_json::from_str::<Value>(&r.stdout) else { return states };
    let rows = match &d {
        Value::Object(o) => o.get("sandboxes").cloned().unwrap_or(d.clone()),
        other => other.clone(),
    };
    let Value::Array(rows) = rows else { return states };
    for r in rows {
        if let Some(o) = r.as_object() {
            if truthy(o.get("name")) {
                let st = ["status", "state"].iter().find_map(|k| o.get(*k).filter(|v| truthy(Some(v))));
                let st = st.map(|v| py_str(v).to_lowercase()).unwrap_or_default();
                states.insert(py_str(&o["name"]), st);
            }
        }
    }
    states
}

/// The sandbox covering this cwd, longest root wins, or "".
pub fn sandbox_for(cwd: &str, roots: &[(String, String)]) -> String {
    let (mut best, mut name) = (String::new(), String::new());
    for (root, nm) in roots {
        let r = root.trim_end_matches('/');
        if (cwd == r || cwd.starts_with(&format!("{r}/"))) && r.chars().count() > best.chars().count() {
            best = r.to_string();
            name = nm.clone();
        }
    }
    name
}

pub fn sandbox_token(name: &str, states: &HashMap<String, String>) -> Vec<String> {
    if name.is_empty() {
        return vec![];
    }
    match states.get(name) {
        Some(st) if !st.is_empty() && st.contains("running") => vec!["sandbox:running".into()],
        _ => vec!["sandbox:stopped".into()],
    }
}

/// "working" if this sandbox's agent wrote a transcript in the last 90s.
pub fn sandbox_phase(p: &Paths, name: &str) -> String {
    fn walk(dir: &Path, newest: &mut f64) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let path = e.path();
            // os.walk does not follow a symlinked directory
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&path, newest);
            } else if !ft.is_symlink() || fs::metadata(&path).is_ok_and(|m| !m.is_dir()) {
                if !e.file_name().to_string_lossy().ends_with(".jsonl") {
                    continue;
                }
                if let Ok(m) = fs::metadata(&path) {
                    *newest = newest.max(py::mtime(&m));
                }
            }
        }
    }
    let mut newest = 0.0;
    walk(Path::new(&join(&p.state, &format!("sandbox/claude/{name}/projects"))), &mut newest);
    if newest != 0.0 && py::now() - newest < 90.0 {
        "working".into()
    } else {
        String::new()
    }
}

// --- signals ----------------------------------------------------------------------

/// The board's compact tokens for one worktree, and the gh facts behind them.
pub fn signals(p: &Paths, cwd: &str, is_repo: bool, ttl: i64) -> (Vec<String>, Map<String, Value>) {
    let mut tok: Vec<String> = Vec::new();
    let gh = if is_repo { gh_state(p, cwd, ttl) } else { Map::new() };
    let g = |k: &str| gh.get(k);
    if truthy(g("ciFail")) {
        tok.push("ci:fail".into());
    } else if truthy(g("ciPending")) {
        tok.push("ci:run".into());
    } else if truthy(g("ciTotal")) {
        tok.push("ci:pass".into());
    }
    let rev = g("review").filter(|v| truthy(Some(v))).cloned().unwrap_or(json!(""));
    if rev == "APPROVED" {
        tok.push("review:approved".into());
    } else if rev == "CHANGES_REQUESTED" {
        tok.push("review:changes".into());
    }
    if truthy(g("draft")) {
        tok.push("pr:draft".into());
    }
    if g("mergeable") == Some(&json!("CONFLICTING")) {
        tok.push("pr:conflict".into());
    }
    let base = g("base").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
    if !base.is_empty() && base != "master" && base != "main" {
        let target = default_base(cwd).unwrap_or_else(|| "origin/master".into());
        let parent_in =
            git(&["-C", cwd, "merge-base", "--is-ancestor", &format!("origin/{base}"), &target], 10).is_some_and(|r| r.code == 0);
        tok.push(if parent_in { "stack:ready" } else { "stack:blocked" }.into());
    }
    let state = g("prState");
    if state == Some(&json!("MERGED")) || state == Some(&json!("CLOSED")) || merged_already(cwd) {
        tok.push("gone:merged".into());
    }
    let mut n = g("issue").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
    if n.is_empty() {
        let b = branch(cwd);
        let rest = b.split_once('/').map(|(_, r)| r).unwrap_or(&b);
        // ^(?:issue-)?(\d{1,6})-
        let r = rest.strip_prefix("issue-").filter(|r| r.starts_with(|c: char| c.is_ascii_digit())).unwrap_or(rest);
        let d: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        if (1..=6).contains(&d.len()) && r[d.len()..].starts_with('-') {
            n = d;
        }
    }
    if !n.is_empty() {
        tok.push(format!("issue:{n}"));
    }
    (tok, gh)
}

// --- planning -----------------------------------------------------------------------

/// The session's transcript: PROJECTS/*/<sid>.jsonl, the first glob hit.
fn transcript_for(p: &Paths, sid: &str) -> String {
    if sid.is_empty() {
        return String::new();
    }
    for d in listdir(&p.projects).unwrap_or_default() {
        if d.starts_with('.') {
            continue;
        }
        let f = join(&join(&p.projects, &d), &format!("{sid}.jsonl"));
        if fs::symlink_metadata(&f).is_ok() {
            return f;
        }
    }
    String::new()
}

/// The session's current permission mode from the last 256KB of its transcript.
pub fn permission_mode(p: &Paths, sid: &str) -> String {
    let path = transcript_for(p, sid);
    if path.is_empty() {
        return String::new();
    }
    // Tail-read: transcripts reach 8MB+, and the last entry sits near the end.
    let chunk = {
        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut f) = fs::File::open(&path) else { return String::new() };
        let Ok(size) = f.seek(SeekFrom::End(0)) else { return String::new() };
        let mut b = Vec::new();
        if f.seek(SeekFrom::Start(size.saturating_sub(262144))).is_err() || f.read_to_end(&mut b).is_err() {
            return String::new();
        }
        b
    };
    let chunk = &chunk[..];
    let needle = br#""type":"permission-mode""#;
    let Some(i) = chunk.windows(needle.len()).rposition(|w| w == needle) else { return String::new() };
    let start = chunk[..i].iter().rposition(|&b| b == b'\n').map(|n| n + 1).unwrap_or(0);
    let line = &chunk[start..];
    let line = match line.iter().position(|&b| b == b'\n') {
        Some(nl) => &line[..nl],
        None => line,
    };
    let Ok(text) = std::str::from_utf8(line) else { return String::new() };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(o)) => o.get("permissionMode").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default(),
        _ => String::new(),
    }
}

/// (roots, sessions) with a deep-plan rendered and not yet signed off.
pub fn deep_plan_markers(p: &Paths) -> (HashSet<String>, HashSet<String>) {
    let (mut roots, mut sids) = (HashSet::new(), HashSet::new());
    for n in listdir(&p.deep_active).unwrap_or_default() {
        let Some(txt) = read_text(&join(&p.deep_active, &n)) else { continue };
        for line in txt.split_inclusive('\n') {
            let (k, v) = line.split_once('=').unwrap_or((line, ""));
            let (k, v) = (py_strip(k), py_strip(v));
            if k == "CWD" && !v.is_empty() {
                roots.insert(v.to_string());
            } else if k == "SESSION" && !v.is_empty() {
                sids.insert(v.to_string());
            }
        }
    }
    (roots, sids)
}

/// A locked plan's tokens, keyed by git root and by session id.
pub fn deep_plan_states(p: &Paths) -> (HashMap<String, Vec<String>>, HashMap<String, Vec<String>>) {
    let (mut by_root, mut by_sid) = (HashMap::new(), HashMap::new());
    let Some(names) = listdir(&p.deep_state) else { return (by_root, by_sid) };
    for n in names.into_iter().filter(|n| n.ends_with(".json")) {
        let Some(st) = read_json(&join(&p.deep_state, &n)) else { continue };
        let st = if truthy(Some(&st)) { st } else { json!({}) };
        let Some(o) = st.as_object() else { continue };
        let phase = o.get("phase").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
        if phase == "done" {
            continue;
        }
        let incs: Vec<Value> = match o.get("increments") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        let status = |i: &Value| i.get("status").cloned().unwrap_or(Value::Null);
        let done = incs.iter().filter(|i| status(i) == "done").count();
        let open = incs.iter().any(|i| status(i) == "authorized" || status(i) == "working");
        let nxt = incs.iter().find(|i| status(i) == "pending");
        let review = phase == "review";
        let slug = o.get("slug").map(py_str).unwrap_or_else(|| "None".into());
        let page = join(&p.deep_plans, &format!("{slug}.{}.html", if review { "review" } else { "working" }));
        let mut toks = Vec::new();
        if review {
            toks.push("plan:deep".to_string());
        } else if o.get("gate") == Some(&json!("open")) || open {
            toks.push("plan:work".into());
        } else {
            toks.push("plan:gate".into());
        }
        if !incs.is_empty() {
            toks.push(format!("planinc:{done}/{}", incs.len()));
        }
        if !review && !open {
            if let Some(nx) = nxt {
                let n = match nx.get("n") {
                    None => 0,
                    Some(Value::Number(x)) => x.as_i64().unwrap_or_else(|| x.as_f64().unwrap_or(0.0).trunc() as i64),
                    Some(Value::Bool(b)) => *b as i64,
                    Some(_) => continue,
                };
                toks.push(format!("plannext:{n}"));
            }
        }
        if Path::new(&page).is_file() && !page.contains(' ') {
            toks.push(format!("planpath:{page}"));
        }
        let field = |k: &str| o.get(k).filter(|v| truthy(Some(v))).map(|v| py_strip(&py_str(v)).to_string()).unwrap_or_default();
        let (root, sid) = (field("root"), field("session"));
        if !root.is_empty() {
            by_root.insert(root, toks.clone());
        }
        if !sid.is_empty() {
            by_sid.insert(sid, toks);
        }
    }
    (by_root, by_sid)
}

/// Live families: (parent slug, parent root, [(slug, role, root)]).
pub fn deep_plan_families(p: &Paths) -> Vec<(String, String, Vec<(String, String, String)>)> {
    let mut out = Vec::new();
    let fdir = join(&p.deep_state, "families");
    let Some(mut names) = listdir(&fdir) else { return out };
    names.sort();
    for n in names {
        let Some(idx) = read_json(&join(&fdir, &format!("{n}/index.json"))) else { continue };
        let idx = if truthy(Some(&idx)) { idx } else { json!({}) };
        let Some(io) = idx.as_object() else { continue };
        let parent = io.get("parent").map(py_str).unwrap_or_default();
        let Some(pst) = read_json(&join(&p.deep_state, &format!("{parent}.json"))) else { continue };
        if pst.get("phase") == Some(&json!("closed")) {
            continue;
        }
        let members: Vec<(String, String, String)> = match io.get("members") {
            Some(Value::Array(a)) => a
                .iter()
                .filter(|m| truthy(m.get("root")))
                .map(|m| {
                    let f = |k: &str| m.get(k).map(py_str).unwrap_or_default();
                    (f("slug"), f("role"), f("root"))
                })
                .collect(),
            _ => vec![],
        };
        let proot = members.iter().find(|(_, role, _)| role == "parent").map(|(_, _, r)| r.clone()).unwrap_or_default();
        if !proot.is_empty() {
            out.push((parent, proot, members));
        }
    }
    out
}

/// Family tokens, colours to wear and colours to restore, keyed by real root.
pub struct FamilySignals {
    pub toks: HashMap<String, Vec<String>>,
    pub wear: HashMap<String, String>,
    pub restore: HashMap<String, String>,
}

pub fn family_signals(p: &Paths, dry: bool) -> FamilySignals {
    let mut fs_ = FamilySignals { toks: HashMap::new(), wear: HashMap::new(), restore: HashMap::new() };
    let fams = deep_plan_families(p);
    for (parent, proot, members) in &fams {
        for (_, role, root) in members {
            fs_.toks.insert(realpath(root), vec![format!("family:{parent}"), format!("famrole:{role}")]);
        }
        if dry {
            continue;
        }
        let kids: Vec<String> = members.iter().filter(|(_, r, _)| r == "child").map(|(_, _, r)| r.clone()).collect();
        // crew-color, in process: what its `family` would have printed (it
        // refuses a family with no child, printing nothing).
        if kids.is_empty() {
            continue;
        }
        if let Ok(lines) = color::family(proot, &kids) {
            for (root, hexv) in lines {
                if hexv.starts_with('#') {
                    fs_.wear.insert(realpath(&root), hexv);
                }
            }
        }
    }
    if !dry {
        let live: Vec<String> = fams.iter().map(|(_, pr, _)| pr.clone()).collect();
        let (done, _) = color::unfamily_stale(&live);
        for (root, hexv) in done {
            if !root.is_empty() {
                fs_.restore.insert(realpath(&root), hexv);
            }
        }
    }
    fs_
}

/// (fraction, label, todo items, active) for a session's task list.
pub struct Plan {
    pub frac: f64,
    pub label: String,
    pub items: Vec<Value>,
    pub active: String,
}

pub fn plan(p: &Paths, sid: &str) -> Option<Plan> {
    let d = join(&p.tasks, sid);
    if !Path::new(&d).is_dir() {
        return None;
    }
    let mut names = listdir(&d).unwrap_or_default();
    let key = |n: &String| -> u64 {
        let stem: String = n.chars().take(n.chars().count().saturating_sub(5)).collect();
        if !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) {
            stem.parse().unwrap_or(1 << 30)
        } else {
            1 << 30
        }
    };
    names.sort_by_key(key);
    let (mut done, mut total) = (0usize, 0usize);
    let mut active = String::new();
    let mut items = Vec::new();
    for name in names {
        if !name.ends_with(".json") {
            continue;
        }
        let Some(t) = read_json(&join(&d, &name)) else { continue };
        let Some(o) = t.as_object() else { continue };
        if !o.contains_key("subject") {
            continue;
        }
        let st = o.get("status").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_else(|| "pending".into());
        total += 1;
        if st == "completed" {
            done += 1;
        } else if st == "in_progress" && active.is_empty() {
            active = ["activeForm", "subject"]
                .iter()
                .find_map(|k| o.get(*k).filter(|v| truthy(Some(v))).map(py_str))
                .unwrap_or_default();
        }
        let subject = o.get("subject").filter(|v| truthy(Some(v))).map(py_str).unwrap_or_default();
        let state = match st.as_str() {
            "completed" => "completed",
            "in_progress" => "in-progress",
            _ => "pending",
        };
        items.push(json!({"text": crate::pyval::head(&subject, 200), "state": state}));
    }
    if total == 0 {
        return None;
    }
    let mut label = format!("{done}/{total}");
    if !active.is_empty() {
        label.push_str(&format!(" · {active}"));
    }
    Some(Plan { frac: done as f64 / total as f64, label: crate::pyval::head(&label, 120), items, active })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_labels_match_the_python_regexes() {
        for (b, want) in [
            ("dev/graphql-db-schema-updates-proj-961", "PROJ-961 · graphql-db-schema-updates"),
            ("proj-12-fix-thing", "PROJ-12 · fix-thing"),
            ("feature/ABC-7", "ABC-7"),
            ("a-b-c-1", "C-1 · a-b"),
            ("x-1-y-2", "Y-2 · x-1"),
            ("HEAD", ""),
            ("", ""),
            ("main", ""),
            ("dev/port-cli", ""),
            ("abc-12-", ""),
            ("abc-12-x", "ABC-12 · x"),
            ("-abc-1", ""),
        ] {
            assert_eq!(ticket_label(b), want, "{b}");
        }
    }

    #[test]
    fn crew_named_titles() {
        assert!(crew_named("PROJ-1"));
        assert!(crew_named("PROJ-1 · body"));
        assert!(!crew_named("proj-1"));
        assert!(!crew_named("PROJ-1x"));
        assert!(!crew_named("PROJ-"));
    }

    #[test]
    fn jira_slugs() {
        let e = ("In Progress!".to_string(), String::new());
        assert_eq!(jira_token(Some(&e)), "jira:in-progress");
        let e = ("--Done--".to_string(), String::new());
        assert_eq!(jira_token(Some(&e)), "jira:done");
        let e = ("!!".to_string(), String::new());
        assert_eq!(jira_token(Some(&e)), "");
    }

    #[test]
    fn shlex_unquotes_printf_q() {
        assert_eq!(shlex_split(r"/a/by\ stander"), Some(vec!["/a/by stander".to_string()]));
        assert_eq!(shlex_split("'x y'"), Some(vec!["x y".to_string()]));
        assert_eq!(shlex_split("\"a\\\"b\""), Some(vec!["a\"b".to_string()]));
        assert_eq!(shlex_split("'open"), None);
    }

    #[test]
    fn realpath_resolves_links_and_keeps_case() {
        let d = std::env::temp_dir().join(format!("crew-cli-rp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("Real/sub")).unwrap();
        std::os::unix::fs::symlink(d.join("Real"), d.join("link")).unwrap();
        let base = realpath(&d.to_string_lossy());
        assert_eq!(realpath(&format!("{base}/link/sub")), format!("{base}/Real/sub"));
        assert_eq!(realpath(&format!("{base}/link/missing/x")), format!("{base}/Real/missing/x"));
        // as typed, even where the volume would match "real" case-insensitively
        assert_eq!(realpath(&format!("{base}/real/sub")), format!("{base}/real/sub"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn relpath_matches() {
        assert_eq!(relpath("/a/b/c", "/a"), "b/c");
        assert_eq!(relpath("/a", "/a/b"), "..");
        assert_eq!(relpath("/a", "/a"), ".");
    }
}
