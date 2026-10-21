//! Plan, review and ask rows from their own stores (~/.claude/deep-plan/state,
//! ~/.claude/plans/reviews, ~/.claude/plans/asks), keyed by root or cwd, and
//! the fingerprint that says when to read them again.

use crate::classify::truthy;
use crate::paths::wskey;
use crate::scan::Ctx;
use crate::{iso, py_isspace};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

pub const STORE_KEY: &str = "store:plans,reviews,asks";
/// A review's or ask's files beside its record; the record is <id>.json.
pub const SIDECARS: [&str; 3] = [".rows.json", ".seen.json", ".incoming.json"];

/// The lookout reviews the Wake makes itself to show a commit.
fn wake_review() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^wake-[0-9a-f]{7,12}\.json$").expect("static regex"))
}

fn join(a: &str, b: &str) -> String {
    format!("{}/{}", a.trim_end_matches('/'), b)
}

/// `sorted(os.listdir(d))`, empty when the directory cannot be read.
fn listdir(d: &str) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(d)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

/// (entries, newest mtime) over the deep-plan state, review and ask dirs.
pub fn fingerprint(ctx: &Ctx) -> (i64, f64) {
    let p = &ctx.paths;
    let (mut n, mut newest) = (0i64, 0.0f64);
    for d in [p.dp_state.clone(), join(&p.plans, "reviews"), join(&p.plans, "asks")] {
        for name in listdir(&d) {
            if !name.ends_with(".json") {
                continue;
            }
            let Ok(m) = std::fs::metadata(join(&d, &name)) else { continue };
            n += 1;
            newest = newest.max(crew_core::py::mtime(&m));
        }
    }
    (n, newest)
}

/// `json.load` of a file that must hold an object.
fn load(path: &str) -> Option<Value> {
    let data = std::fs::read(path).ok()?;
    let v: Value = crate::scan::parse_line(&data)?;
    v.is_object().then_some(v)
}

/// `_heading(md)`: the first `# ` heading of a markdown file read in text
/// mode, so lines end at `\n`, `\r\n` or `\r`; "" when the file cannot be
/// opened. Err where Python's UTF-8 decoder raises before the heading is
/// returned (that error escapes _heading and the plan row is skipped). The
/// decoder works in 8192-byte chunks, so bad bytes in the chunk that ends
/// the heading's line raise too.
fn heading(md: &str) -> Result<String, ()> {
    const CHUNK: usize = 8192;
    let Ok(data) = std::fs::read(md) else { return Ok(String::new()) };
    let bad = std::str::from_utf8(&data).err().map(|e| e.valid_up_to());
    let text = std::str::from_utf8(&data[..bad.unwrap_or(data.len())]).unwrap_or("");
    let b = text.as_bytes();
    let mut start = 0;
    while start < b.len() {
        let mut end = start;
        while end < b.len() && b[end] != b'\n' && b[end] != b'\r' {
            end += 1;
        }
        // The line's terminator, which the reader must see before returning it.
        let term = if end + 1 < b.len() && b[end] == b'\r' && b[end + 1] == b'\n' { 2 } else { usize::from(end < b.len()) };
        if let Some(h) = text[start..end].strip_prefix("# ") {
            let seen = end + term;
            return match bad {
                Some(at) if at < seen.div_ceil(CHUNK).max(1) * CHUNK => Err(()),
                _ => Ok(h.trim_matches(py_isspace).to_string()),
            };
        }
        start = end + term;
        if term == 0 {
            break;
        }
    }
    if bad.is_some() {
        Err(())
    } else {
        Ok(String::new())
    }
}

/// `_ms_iso`: epoch milliseconds (a number, or a string Python's float()
/// reads) as the store's ISO form.
fn ms_iso(ms: &Value) -> String {
    let f = match ms {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim_matches(py_isspace).parse::<f64>().ok(),
        _ => None,
    };
    f.filter(|f| f.is_finite()).map(|f| iso(f / 1000.0)).unwrap_or_default()
}

fn exists(p: &str) -> bool {
    std::path::Path::new(p).exists()
}

/// `d.get(k) or ""` as the value a row carries.
fn or_blank(d: &Value, k: &str) -> Value {
    match d.get(k) {
        Some(v) if truthy(Some(v)) => v.clone(),
        _ => Value::String(String::new()),
    }
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

/// One store row: every field '', then these, then repo from git and ws keyed.
fn mk(ctx: &mut Ctx, ws: &str, fields: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut r = Map::new();
    for k in crate::schema::FIELDS {
        r.insert(k.into(), s(""));
    }
    for (k, v) in fields {
        r.insert(k.into(), v);
    }
    let repo = if ws.is_empty() { String::new() } else { ctx.git_facts(ws).0 };
    r.insert("repo".into(), s(&repo));
    r.insert("ws".into(), s(&wskey(ws)));
    r
}

/// Plan, review and ask rows, keyed by root or cwd.
pub fn store_rows(ctx: &mut Ctx) -> Vec<Map<String, Value>> {
    let mut rows = Vec::new();
    let (dp_state, plans) = (ctx.paths.dp_state.clone(), ctx.paths.plans.clone());

    for n in listdir(&dp_state) {
        let Some(slug_default) = n.strip_suffix(".json") else { continue };
        let Some(d) = load(&join(&dp_state, &n)) else { continue };
        let Some(root) = d.get("root").and_then(Value::as_str) else { continue };
        let slug = match d.get("slug") {
            Some(v) if truthy(Some(v)) => match v.as_str() {
                Some(x) => x.to_string(),
                None => continue, // the Python's join raises on a non-string slug
            },
            _ => slug_default.to_string(),
        };
        let ats: Vec<&Value> = d
            .get("log")
            .and_then(Value::as_array)
            .map(|log| log.iter().filter_map(|e| e.get("at").filter(|a| truthy(Some(a)))).collect())
            .unwrap_or_default();
        // min()/max() over mixed types raise in Python, which skips the row.
        let nums: Option<Vec<f64>> = ats.iter().map(|a| a.as_f64()).collect();
        let (created, updated) = match (&nums, ats.is_empty()) {
            (_, true) => (String::new(), String::new()),
            (Some(v), false) => {
                let lo = v.iter().cloned().fold(f64::INFINITY, f64::min);
                let hi = v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                (ms_iso(&crew_core::pyjson::float(lo)), ms_iso(&crew_core::pyjson::float(hi)))
            }
            (None, false) => {
                let strs: Option<Vec<&str>> = ats.iter().map(|a| a.as_str()).collect();
                let Some(mut v) = strs else { continue };
                v.sort();
                (ms_iso(&s(v[0])), ms_iso(&s(v[v.len() - 1])))
            }
        };
        let md = join(&plans, &format!("{slug}.md"));
        let title = match heading(&md) {
            Ok(h) if !h.is_empty() => h,
            Ok(_) => slug.clone(),
            Err(()) => continue,
        };
        let row = mk(
            ctx,
            root,
            vec![
                ("kind", s("plan")),
                ("locator", s(&slug)),
                ("title", s(&title)),
                ("path", s(if exists(&md) { &md } else { "" })),
                ("created_at", s(&created)),
                ("updated_at", s(&updated)),
                ("session_id", or_blank(&d, "session")),
                ("source", s("deep-plan")),
            ],
        );
        rows.push(row);
    }

    let rdir = join(&plans, "reviews");
    for n in listdir(&rdir) {
        if !n.ends_with(".json") || SIDECARS.iter().any(|x| n.ends_with(x)) || wake_review().is_match(&n) {
            continue;
        }
        let Some(d) = load(&join(&rdir, &n)) else { continue };
        let Some(src) = d.get("source").filter(|v| v.is_object()) else { continue };
        let Some(root) = src.get("root").and_then(Value::as_str) else { continue };
        let rid = &n[..n.len() - 5];
        let html = join(&rdir, &format!("{rid}.html"));
        let title = match d.get("title") {
            Some(v) if truthy(Some(v)) => v.clone(),
            _ => s(rid),
        };
        let row = mk(
            ctx,
            root,
            vec![
                ("kind", s("review")),
                ("locator", s(rid)),
                ("title", title),
                ("path", s(if exists(&html) { &html } else { "" })),
                ("created_at", or_blank(&d, "createdAt")),
                ("updated_at", or_blank(&d, "updatedAt")),
                ("branch", or_blank(src, "branch")),
                ("source", s("lookout")),
            ],
        );
        rows.push(row);
    }

    let adir = join(&plans, "asks");
    for n in listdir(&adir) {
        if !n.ends_with(".json") || SIDECARS.iter().any(|x| n.ends_with(x)) {
            continue;
        }
        let Some(d) = load(&join(&adir, &n)) else { continue };
        let Some(cwd) = d.get("cwd").and_then(Value::as_str) else { continue };
        let aid = &n[..n.len() - 5];
        let html = join(&adir, &format!("{aid}.html"));
        let q = d.get("question").and_then(Value::as_str).unwrap_or("");
        let head = d.get("header").and_then(Value::as_str).unwrap_or("");
        let title = if !head.is_empty() && !q.is_empty() {
            format!("{head}: {q}")
        } else if !q.is_empty() {
            q.to_string()
        } else if !head.is_empty() {
            head.to_string()
        } else {
            aid.to_string()
        };
        let created = or_blank(&d, "created");
        let row = mk(
            ctx,
            cwd,
            vec![
                ("kind", s("ask")),
                ("locator", s(aid)),
                ("title", s(&title)),
                ("path", s(if exists(&html) { &html } else { "" })),
                ("created_at", created.clone()),
                ("updated_at", created),
                ("source", s("ask")),
            ],
        );
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, body: &[u8]) -> String {
        let p = std::env::temp_dir().join(format!("crew-store-heading-{}-{name}", std::process::id()));
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn heading_like_pythons_text_mode() {
        assert_eq!(heading(&tmp("a", b"intro\r# Title  \r\nrest")), Ok("Title".into()));
        assert_eq!(heading(&tmp("b", b"no heading\n")), Ok(String::new()));
        assert_eq!(heading("/no/such/file.md"), Ok(String::new()));
        // Bad bytes in the heading's chunk raise; far past it they are never read.
        assert_eq!(heading(&tmp("c", b"# T\n\xff")), Err(()));
        let mut far = b"# Far\n".to_vec();
        far.extend(std::iter::repeat(b'x').take(20000));
        far.push(0xff);
        assert_eq!(heading(&tmp("d", &far)), Ok("Far".into()));
        assert_eq!(heading(&tmp("e", b"\xff\n# T\n")), Err(()));
    }
}
