//! One transcript's rows, collected before the transaction opens:
//! artifacts.py's Scan, Timeline, git facts and commit finding.
//!
//! The transcript is Claude Code's internal format. Every field is read
//! defensively and each extractor is fenced on its own, so a line that moved
//! shape costs that one row, never the run.

use crate::classify::{
    classify, commit_re, changed_re, git_commit_re, github_re, gs, oneline_re, prompt_of, splitext_ext,
    tmp_redirect_re, truthy, IMAGE_EXT,
};
use crate::paths::{basename, norm, wskey, Paths};
use crate::{iso, py_isspace};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::time::Duration;

pub const SCRATCH_CAP: usize = 400;
pub const SKIP_DIRS: [&str; 6] = [".git", "node_modules", "__pycache__", ".venv", "venv", ".cache"];

/// What one index pass shares across transcripts: the store's paths, git
/// facts per directory and parent transcripts' timelines (both are asked
/// once per pass, as the Python's module-level caches are).
pub struct Ctx {
    pub paths: Paths,
    git: HashMap<String, (String, String)>,
    timelines: HashMap<String, Timeline>,
}

impl Ctx {
    pub fn new(paths: Paths) -> Ctx {
        Ctx { paths, git: HashMap::new(), timelines: HashMap::new() }
    }

    /// (repo toplevel, GitHub web base) for a cwd. Empty strings when the
    /// directory is gone or not a git checkout.
    pub fn git_facts(&mut self, cwd: &str) -> (String, String) {
        if let Some(v) = self.git.get(cwd) {
            return v.clone();
        }
        let (mut top, mut web) = (String::new(), String::new());
        if !cwd.is_empty() && std::path::Path::new(cwd).is_dir() {
            let common = git(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
            if !common.is_empty() {
                top = if basename(&common) == ".git" { crate::paths::split(&common).0 } else { common };
            }
            if let Some(m) = github_re().captures(&git(cwd, &["remote", "get-url", "origin"])) {
                web = format!("https://github.com/{}/{}", &m[1], &m[2]);
            }
        }
        self.git.insert(cwd.to_string(), (top.clone(), web.clone()));
        (top, web)
    }
}

/// `git -C cwd args...`: stdout stripped when it exits 0, else "".
fn git(cwd: &str, args: &[&str]) -> String {
    let mut a = vec!["-C", cwd];
    a.extend_from_slice(args);
    match crew_core::py::run("git", &a, Duration::from_secs(5)) {
        Some((0, out, _)) => out.trim_matches(py_isspace).to_string(),
        _ => String::new(),
    }
}

fn is_dir(p: &str) -> bool {
    !p.is_empty() && std::path::Path::new(p).is_dir()
}

fn full_sha(cwd: &str, sha: &str) -> String {
    if !is_dir(cwd) {
        return String::new();
    }
    git(cwd, &["rev-parse", "--verify", "-q", &format!("{sha}^{{commit}}")])
}

fn commit_time(cwd: &str, sha: &str) -> Option<i64> {
    let out = git(cwd, &["show", "-s", "--format=%ct", &format!("{sha}^{{commit}}")]);
    if !out.is_empty() && out.bytes().all(|b| b.is_ascii_digit()) {
        out.parse().ok()
    } else {
        None
    }
}

/// The commit a `git commit -q` made, which prints no [branch sha] line.
/// First a `<sha> <subject>` line in the same output that names a commit
/// made in the two minutes before the result; else the commit HEAD gained
/// in those two minutes, asked while the worktree exists.
fn quiet_commit(cwd: &str, out: &str, ts: &str) -> Vec<(String, String)> {
    let Some(at) = crate::epoch19(ts) else { return vec![] };
    if !is_dir(cwd) {
        return vec![];
    }
    for line in crew_core::py::splitlines(out) {
        let l = line.trim_matches(py_isspace);
        if let Some(m) = oneline_re().captures(l) {
            if let Some(t) = commit_time(cwd, &m[1]) {
                if at - 120 <= t && t <= at + 5 {
                    return vec![(m[1].to_string(), m[2].trim_matches(py_isspace).to_string())];
                }
            }
        }
    }
    let Some((0, log, _)) = crew_core::py::run(
        "git",
        &["-C", cwd, "log", "-n", "5", "--format=%h%x09%ct%x09%s", "HEAD"],
        Duration::from_secs(5),
    ) else {
        return vec![];
    };
    let mut best: Option<(i64, String, String)> = None;
    for line in crew_core::py::splitlines(&log) {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() == 3 && !parts[1].is_empty() && parts[1].bytes().all(|b| b.is_ascii_digit()) {
            let t: i64 = parts[1].parse().unwrap_or(i64::MIN);
            if at - 120 <= t && t <= at + 5 && best.as_ref().is_none_or(|b| t > b.0) {
                best = Some((t, parts[0].to_string(), parts[2].to_string()));
            }
        }
    }
    best.map(|b| vec![(b.1, b.2)]).unwrap_or_default()
}

/// (timestamp, prompt) pairs for one transcript, in order; `at(ts)` is the
/// prompt in flight at that moment.
#[derive(Default, Clone)]
pub struct Timeline {
    v: Vec<(String, String)>,
}

impl Timeline {
    pub fn add(&mut self, ts: &str, text: &str) {
        if !ts.is_empty() && !text.is_empty() {
            let i = self.v.partition_point(|x| x.0.as_str() <= ts);
            self.v.insert(i, (ts.to_string(), text.to_string()));
        }
    }

    pub fn at(&self, ts: &str) -> &str {
        let i = self.v.partition_point(|x| x.0.as_str() <= ts);
        if i > 0 {
            &self.v[i - 1].1
        } else {
            ""
        }
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// `json.loads(raw)` for one transcript line. Python accepts a lone UTF-16
/// surrogate escape (`"\ud83d"`, an emoji cut in half) where serde_json
/// refuses the line, so a line that fails is tried once more with each
/// unpaired surrogate escape replaced by U+FFFD.
pub fn parse_line(raw: &[u8]) -> Option<Value> {
    match serde_json::from_slice::<Value>(raw) {
        Ok(v) => Some(v),
        Err(_) if contains(raw, b"\\u") => serde_json::from_slice(&mend_surrogates(raw)).ok(),
        Err(_) => None,
    }
}

fn hex4(b: &[u8]) -> Option<u16> {
    let s = std::str::from_utf8(b.get(..4)?).ok()?;
    u16::from_str_radix(s, 16).ok()
}

/// Every `\uD800`-`\uDFFF` escape that is not half of a high-low pair
/// becomes `�`. Other escapes (`\\`, `\"`, ...) are stepped over whole,
/// so an escaped backslash before a `u` is never read as an escape.
fn mend_surrogates(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != b'\\' || i + 1 >= raw.len() {
            out.push(raw[i]);
            i += 1;
            continue;
        }
        if raw[i + 1] != b'u' {
            out.extend_from_slice(&raw[i..i + 2]);
            i += 2;
            continue;
        }
        let Some(u) = hex4(&raw[i + 2..]) else {
            out.extend_from_slice(&raw[i..i + 2]);
            i += 2;
            continue;
        };
        let low_next = |j: usize| {
            raw.get(j) == Some(&b'\\') && raw.get(j + 1) == Some(&b'u')
                && hex4(&raw[(j + 2).min(raw.len())..]).is_some_and(|l| (0xDC00..=0xDFFF).contains(&l))
        };
        if (0xD800..=0xDBFF).contains(&u) && low_next(i + 6) {
            out.extend_from_slice(&raw[i..i + 12]);
            i += 12;
        } else if (0xD800..=0xDFFF).contains(&u) {
            out.extend_from_slice(b"\\ufffd");
            i += 6;
        } else {
            out.extend_from_slice(&raw[i..i + 6]);
            i += 6;
        }
    }
    out
}

/// A file's lines, read as iterating a binary file in Python gives them
/// (split on `\n`, the last one perhaps without it), streamed. `f` returns
/// false to stop reading.
fn each_line(path: &str, mut f: impl FnMut(usize, &[u8]) -> bool) {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else { return };
    let mut rd = std::io::BufReader::new(file);
    let mut buf = Vec::new();
    let mut n = 0;
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if !f(n, &buf) {
            return;
        }
        n += 1;
    }
}

/// Every prompt in a transcript. Only user lines are parsed.
pub fn full_timeline(path: &str) -> Timeline {
    let mut tl = Timeline::default();
    each_line(path, |_, raw| {
        // A byte-level prefilter: only user lines can be prompts.
        if contains(raw, b"\"user\"") && !contains(raw, b"\"tool_result\"") {
            if let Some(d) = parse_line(raw).filter(Value::is_object) {
                if let Some(p) = prompt_of(&d) {
                    tl.add(gs(&d, "timestamp").unwrap_or(""), &p);
                }
            }
        }
        true
    });
    tl
}

/// The first cwd a transcript records, reading at most its first 201 lines.
pub fn first_cwd(path: &str) -> String {
    let mut found = String::new();
    each_line(path, |n, raw| {
        if n > 200 {
            return false;
        }
        if contains(raw, b"\"cwd\"") {
            if let Some(c) = parse_line(raw).as_ref().and_then(|d| gs(d, "cwd")) {
                found = c.to_string();
                return false;
            }
        }
        true
    });
    found
}

/// A row before its prompt is known.
pub struct Draft {
    pub row: Map<String, Value>,
    ts: String,
    prompt: Option<String>,
}

impl Draft {
    pub fn finish(mut self) -> Map<String, Value> {
        self.row.insert("prompt".into(), Value::String(self.prompt.unwrap_or_default()));
        self.row
    }
}

pub struct Scan {
    pub path: String,
    pub rows: Vec<Draft>,
    /// (path, url): Artifact publishes to reconcile.
    pub links: Vec<(String, String)>,
    tl: Timeline,
    complete_tl: bool,
    tools: HashMap<String, (Value, Value)>,
    cwd: String,
    session: String,
    branch: String,
    subagent: bool,
    root: String,
    parent: String,
}

/// A tool_use id as a map key; any JSON value works, as any hashable does in
/// the Python.
fn key(v: Option<&Value>) -> String {
    v.map(|v| v.to_string()).unwrap_or_else(|| "null".into())
}

impl Scan {
    pub fn new(path: &str, offset: u64) -> Scan {
        let dir = crate::paths::split(path).0;
        let subagent = basename(&dir) == "subagents";
        // <proj>/<session>/subagents/agent-*.jsonl: the human's prompt is in
        // the parent's transcript, <proj>/<session>.jsonl.
        let parent = if subagent { format!("{}.jsonl", crate::paths::split(&dir).0) } else { String::new() };
        Scan {
            path: path.to_string(),
            rows: vec![],
            links: vec![],
            tl: Timeline::default(),
            complete_tl: offset == 0,
            tools: HashMap::new(),
            cwd: String::new(),
            session: String::new(),
            branch: String::new(),
            subagent,
            // The workspace is where the session started, not wherever a
            // Bash `cd` left it: the first cwd in the transcript.
            root: first_cwd(path),
            parent,
        }
    }

    fn prompt_at(&mut self, ctx: &mut Ctx, ts: &str) -> String {
        if self.subagent {
            let tl = ctx.timelines.entry(self.parent.clone()).or_insert_with(|| full_timeline(&self.parent));
            return tl.at(ts).to_string();
        }
        if !self.complete_tl {
            // The chunk started mid-transcript: the prompt in flight may sit
            // before the offset. Read the whole file's prompts once.
            let mut whole = full_timeline(&self.path);
            for (t, x) in &self.tl.v {
                whole.add(t, x);
            }
            self.tl = whole;
            self.complete_tl = true;
        }
        self.tl.at(ts).to_string()
    }

    #[allow(clippy::too_many_arguments)]
    fn add(&mut self, ctx: &mut Ctx, d: &Value, kind: &str, locator: &str, title: &str, path: &str, url: &str, sha: &str) {
        let cwd = if !self.root.is_empty() {
            self.root.clone()
        } else {
            gs(d, "cwd").map(str::to_string).unwrap_or_else(|| self.cwd.clone())
        };
        let ts = gs(d, "timestamp").unwrap_or("").to_string();
        let (repo, _) = ctx.git_facts(&cwd);
        let mut r = Map::new();
        for (k, v) in [
            ("ws", wskey(&cwd)),
            ("repo", repo),
            ("kind", kind.to_string()),
            ("title", title.to_string()),
            ("locator", locator.to_string()),
            ("path", path.to_string()),
            ("url", url.to_string()),
            ("sha", sha.to_string()),
            ("created_at", ts.clone()),
            ("updated_at", ts.clone()),
            ("session_id", gs(d, "sessionId").map(str::to_string).unwrap_or_else(|| self.session.clone())),
            ("branch", gs(d, "gitBranch").map(str::to_string).unwrap_or_else(|| self.branch.clone())),
            ("source", self.path.clone()),
        ] {
            r.insert(k.into(), Value::String(v));
        }
        self.rows.push(Draft { row: r, ts, prompt: None });
    }

    pub fn line(&mut self, ctx: &mut Ctx, d: &Value) {
        if !d.is_object() {
            return;
        }
        if let Some(c) = gs(d, "cwd") {
            self.cwd = c.to_string();
        }
        if let Some(s) = gs(d, "sessionId") {
            self.session = s.to_string();
        }
        if let Some(b) = gs(d, "gitBranch") {
            self.branch = b.to_string();
        }
        let ts = gs(d, "timestamp").unwrap_or("").to_string();
        if let Some(p) = prompt_of(d) {
            self.tl.add(&ts, &p);
            return;
        }
        self.tool_uses(ctx, d);
        self.tool_result(ctx, d);
    }

    fn tool_uses(&mut self, ctx: &mut Ctx, d: &Value) {
        if d.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let Some(items) = d.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) else {
            return;
        };
        for c in items {
            if !(c.is_object() && c.get("type").and_then(Value::as_str) == Some("tool_use")) {
                continue;
            }
            let name = c.get("name").cloned().unwrap_or(Value::Null);
            let inp = match c.get("input") {
                Some(v) if truthy(Some(v)) => v.clone(),
                _ => Value::Object(Map::new()),
            };
            self.tools.insert(key(c.get("id")), (name.clone(), inp.clone()));
            let n = name.as_str().unwrap_or("");
            if n != "Write" && n != "Bash" {
                continue;
            }
            // The Python reads input with .get(): an input that is not an
            // object ends this line's extraction there.
            if !inp.is_object() {
                return;
            }
            if n == "Write" {
                if let Some(fp) = inp.get("file_path").and_then(Value::as_str) {
                    self.file(ctx, d, fp);
                }
            } else if let Some(cmd) = inp.get("command").and_then(Value::as_str) {
                let found: Vec<String> =
                    tmp_redirect_re().captures_iter(cmd).map(|m| m[1].to_string()).collect();
                for f in found {
                    self.file(ctx, d, &f);
                }
            }
        }
    }

    fn file(&mut self, ctx: &mut Ctx, d: &Value, raw: &str) {
        let p = norm(raw);
        let cwd = gs(d, "cwd").map(str::to_string).unwrap_or_else(|| self.cwd.clone());
        let root = self.root.clone();
        if let Some(kind) = classify(&ctx.paths, &p, &cwd, &root) {
            self.add(ctx, d, kind, &p, basename(&p), &p, "", "");
        }
    }

    fn tool_result(&mut self, ctx: &mut Ctx, d: &Value) {
        let Some(r) = d.get("toolUseResult").filter(|r| r.is_object()) else { return };
        if let Some(url) = r.get("url").and_then(Value::as_str).filter(|u| u.starts_with("https://claude.ai/")) {
            let url = url.to_string();
            let path = r.get("path").and_then(Value::as_str).unwrap_or("").to_string();
            let title = gs(r, "title")
                .map(str::to_string)
                .or_else(|| Some(basename(&path).to_string()).filter(|b| !b.is_empty()))
                .unwrap_or_else(|| url.clone());
            self.add(ctx, d, "artifact", &url, &title, &path, &url, "");
            if !path.is_empty() {
                self.links.push((norm(&path), url));
            }
            return;
        }
        let Some(out) = r.get("stdout").and_then(Value::as_str) else { return };
        let mut use_: Option<(Value, Value)> = None;
        if let Some(items) = d.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) {
            for c in items {
                if c.is_object() && c.get("type").and_then(Value::as_str) == Some("tool_result") {
                    use_ = self.tools.get(&key(c.get("tool_use_id"))).cloned();
                }
            }
        }
        let cmd = match &use_ {
            Some((n, inp)) if n.as_str() == Some("Bash") => {
                if !inp.is_object() {
                    return;
                }
                inp.get("command").and_then(Value::as_str).unwrap_or("").to_string()
            }
            _ => String::new(),
        };
        let committed = git_commit_re().is_match(&cmd);
        if !(committed || (out.contains("] ") && changed_re().is_match(out))) {
            return;
        }
        let cwd = gs(d, "cwd").map(str::to_string).unwrap_or_else(|| self.cwd.clone());
        let mut found: Vec<(String, String)> = commit_re()
            .captures_iter(out)
            .map(|m| (m[2].to_string(), m[3].trim_matches(py_isspace).to_string()))
            .collect();
        if found.is_empty() && committed && !truthy(r.get("interrupted")) {
            found = quiet_commit(&cwd, out, gs(d, "timestamp").unwrap_or(""));
        }
        let (_, web) = ctx.git_facts(&cwd);
        for (short, subject) in found {
            let full = full_sha(&cwd, &short);
            if !committed && full.is_empty() {
                continue; // a [branch sha] line from a test fixture, not this repo's commit
            }
            let sha = if full.is_empty() { short.clone() } else { full };
            let url = if web.is_empty() { String::new() } else { format!("{web}/commit/{sha}") };
            // Seven characters, however many git printed: one commit, one row.
            let loc: String = short.chars().take(7).collect();
            self.add(ctx, d, "commit", &loc, &subject, "", &url, &sha);
        }
    }

    /// Every file in this session's scratchpad, dated by birth time. Files
    /// not touched since the last pass (`since`, the cursor's mtime) are
    /// already rows and are skipped, so an incremental pass stays cheap.
    pub fn scratchpad(&mut self, ctx: &mut Ctx, since: f64) {
        if self.subagent {
            return;
        }
        // The session id is the transcript's own name, so a pass whose chunk
        // had no complete line still knows whose scratchpad to list.
        let session = if self.session.is_empty() {
            let b = basename(&self.path);
            b.strip_suffix(".jsonl").unwrap_or(b).to_string()
        } else {
            self.session.clone()
        };
        let proj = basename(&crate::paths::split(&self.path).0).to_string();
        let root = format!("{}/{}/{}/scratchpad", ctx.paths.scratch_base.trim_end_matches('/'), proj, session);
        if !std::path::Path::new(&root).is_dir() {
            return;
        }
        let root = norm(&root);
        // Lazily, as os.walk is: the walk stops at the cap instead of listing
        // a scratchpad that holds a whole node_modules-less repo.
        let mut files: Vec<(String, std::fs::Metadata)> = Vec::new();
        let mut n = 0;
        walk(&root, &mut |p| {
            if n >= SCRATCH_CAP {
                return false;
            }
            if let Ok(st) = std::fs::metadata(&p) {
                n += 1;
                files.push((p, st));
            }
            true
        });
        for (p, st) in files {
            let mtime = crew_core::py::mtime(&st);
            let born = birth(&st);
            if since != 0.0 && mtime.max(born) < since - 2.0 {
                continue;
            }
            let ext = splitext_ext(basename(&p)).to_lowercase();
            let kind = if IMAGE_EXT.contains(&ext.as_str()) { "image" } else { "temp" };
            let d = serde_json::json!({
                "cwd": self.cwd, "timestamp": iso(born), "sessionId": session, "gitBranch": self.branch,
            });
            let rel = p.strip_prefix(&format!("{root}/")).unwrap_or(&p).to_string();
            self.add(ctx, &d, kind, &p, &rel, &p, "", "");
            if let Some(last) = self.rows.last_mut() {
                last.row.insert("updated_at".into(), Value::String(iso(mtime)));
            }
        }
    }

    /// Give every row the prompt in flight at its time.
    pub fn finish(&mut self, ctx: &mut Ctx) {
        let mut drafts = std::mem::take(&mut self.rows);
        for r in drafts.iter_mut() {
            if r.prompt.is_none() {
                let ts = r.ts.clone();
                r.prompt = Some(if ts.is_empty() { String::new() } else { self.prompt_at(ctx, &ts) });
            }
        }
        self.rows = drafts;
    }
}

/// `os.walk(root)` top-down, sorted, SKIP_DIRS pruned, symlinked
/// directories listed but not entered: each non-directory goes to `f`, in
/// walk order, until `f` returns false. Returns false once stopped.
fn walk(dir: &str, f: &mut dyn FnMut(String) -> bool) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return true };
    let mut dirs: Vec<(String, bool)> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        // scandir's is_dir(): the entry's own type, followed only for a link.
        let Ok(ft) = e.file_type() else {
            files.push(name);
            continue;
        };
        let link = ft.is_symlink();
        let is_dir = if link { std::fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false) } else { ft.is_dir() };
        if is_dir {
            dirs.push((name, link));
        } else {
            files.push(name);
        }
    }
    files.sort();
    dirs.retain(|d| !SKIP_DIRS.contains(&d.0.as_str()));
    dirs.sort();
    for name in files {
        if !f(format!("{dir}/{name}")) {
            return false;
        }
    }
    for (d, link) in dirs {
        if !link && !walk(&format!("{dir}/{d}"), f) {
            return false;
        }
    }
    true
}

/// `st_birthtime or st_mtime`, as a float the way CPython computes it.
fn birth(st: &std::fs::Metadata) -> f64 {
    #[cfg(target_os = "macos")]
    {
        use std::os::darwin::fs::MetadataExt;
        let b = st.st_birthtime() as f64 + st.st_birthtime_nsec() as f64 * 1e-9;
        if b != 0.0 {
            return b;
        }
    }
    crew_core::py::mtime(st)
}

/// Read complete lines from `offset`; return the scan and the new offset.
pub fn scan_transcript(ctx: &mut Ctx, path: &str, offset: u64) -> std::io::Result<(Scan, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut sc = Scan::new(path, offset);
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut data = Vec::new();
    f.read_to_end(&mut data)?;
    let Some(cut) = data.iter().rposition(|b| *b == b'\n') else { return Ok((sc, offset)) };
    let end = offset + cut as u64 + 1;
    for raw in data[..cut].split(|b| *b == b'\n') {
        if raw.iter().all(|b| crate::py_bytes_space(*b)) {
            continue;
        }
        if let Some(d) = parse_line(raw) {
            sc.line(ctx, &d);
        }
    }
    Ok((sc, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogates_are_mended_like_python_reads_them() {
        let v = parse_line(br#"{"t": "a\ud83d", "u": "\ud83d\ude00", "w": "\\ud83d", "x": "\udc00z"}"#).unwrap();
        assert_eq!(v["t"], "a\u{fffd}");
        assert_eq!(v["u"], "\u{1f600}");
        assert_eq!(v["w"], "\\ud83d");
        assert_eq!(v["x"], "\u{fffd}z");
        assert!(parse_line(b"{not json").is_none());
    }

    #[test]
    fn timeline_is_bisect_right() {
        let mut t = Timeline::default();
        t.add("2020-01-01T10:00:05Z", "b");
        t.add("2020-01-01T10:00:00Z", "a");
        t.add("", "ignored");
        assert_eq!(t.at("2020-01-01T09:00:00Z"), "");
        assert_eq!(t.at("2020-01-01T10:00:00Z"), "a");
        assert_eq!(t.at("2020-01-01T10:00:04Z"), "a");
        assert_eq!(t.at("2099"), "b");
    }
}
