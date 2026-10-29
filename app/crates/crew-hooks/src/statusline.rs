//! `seamux statusline`: crew/claude/statusline.py in Rust. Claude Code's
//! status line: the worktree's colour, then whatever constrains you.
//!
//! ```text
//! ▊ my-project  ⏱ 42% of 5h window · 2h 10m left · ↗ 78% by reset
//! ▊ my-project  💰 $1,288 of $3,000 (43%) · → $2,576 by Sep 30   (CREW_BILLING=usage)
//! ```
//!
//! The same line, byte for byte: the workspace colour from cmux (cached 300 s
//! in the same file, the miss cached too), lifted for dark terminals with
//! Python's colorsys arithmetic; the window or month line from ccusage with
//! crew-core's pricing args (its answer cached 45 s per args and environment,
//! which the Python does not do: ccusage costs most of a second per render);
//! the cache segment from cache-facts or crew-core's read_facts. Where the
//! Python would raise, this prints nothing and exits 1, as the Python's
//! traceback does.
//!
//! One difference: the Python finds cmux through crew-cmux-bin or PATH; this
//! goes through the cmux crate (the socket live, CREW_CMUX under the probes),
//! with the crate's 10 s limit for the Python's 6 s.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crew_core::py::{env_or, home, now};
use serde_json::{json, Map, Value};

use crate::pyval::{self, str_of, strip, truthy};

const COLOR_TTL: f64 = 300.0;
/// How long one ccusage answer serves every session's status line: it costs
/// most of a second of CPU per run. CREW_CCUSAGE_TTL overrides (0: no cache).
const CCUSAGE_TTL: f64 = 45.0;
/// How old an answer may still be shown while another render refreshes it.
const CCUSAGE_STALE: f64 = 600.0;

/// What the Python would have raised: stderr gets it, stdout nothing, exit 1.
#[derive(Debug)]
struct Crash(String);

type R<T> = Result<T, Crash>;

fn crash<T>(msg: impl Into<String>) -> R<T> {
    Err(Crash(msg.into()))
}

fn colors_file() -> PathBuf {
    home().join(".claude/cache/cmux-colors.json")
}

/// Python's `x or 0`: the value when truthy, else 0. Nothing is checked
/// yet; the Python only fails once the value meets arithmetic.
fn or0(v: Option<&Value>) -> Value {
    v.filter(|x| truthy(x)).cloned().unwrap_or_else(|| json!(0))
}

/// A value at the point the Python does arithmetic or compares it with a
/// number: a number, bool or marked NaN/Infinity/big int, else the
/// TypeError Python would raise there (None included).
fn num(v: &Value) -> R<f64> {
    match v {
        Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => Ok(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => match pyval::marked(s) {
            Some("NaN") => Ok(f64::NAN),
            Some("Infinity") => Ok(f64::INFINITY),
            Some("-Infinity") => Ok(f64::NEG_INFINITY),
            Some(d) => Ok(d.parse::<f64>().unwrap_or(f64::INFINITY)),
            None => crash("TypeError: '>' not supported between instances of 'str' and 'int'"),
        },
        other => crash(format!("TypeError: unsupported operand type(s): '{}'", pyval::type_name(other))),
    }
}

/// `int(v)`: a number truncated, a string parsed as int() parses it. Held
/// as a float, since Python's int has no ceiling and every use here divides
/// it or prints a small one.
fn int_of(v: &Value) -> R<f64> {
    match v {
        Value::String(s) if pyval::marked(s).is_none() => match py_int(s) {
            Some(n) => int(n),
            None => crash(format!("ValueError: invalid literal for int() with base 10: {}", pyval::repr_str(s))),
        },
        Value::Null | Value::Array(_) | Value::Object(_) => crash(format!(
            "TypeError: int() argument must be a string, a bytes-like object or a real number, not '{}'",
            pyval::type_name(v)
        )),
        other => int(num(other)?),
    }
}

/// Python's `a > b` on two values.
fn gt(a: &Value, b: &Value) -> R<bool> {
    Ok(num(a)? > num(b)?)
}

fn get<'a>(v: &'a Value, key: &str) -> R<Option<&'a Value>> {
    match v {
        Value::Object(o) => Ok(o.get(key)),
        other => crash(format!("AttributeError: '{}' object has no attribute 'get'", pyval::type_name(other))),
    }
}

/// `(v.get(key) or {})`: the value when truthy, else an empty object.
fn get_or_empty(v: &Value, key: &str) -> R<Value> {
    Ok(get(v, key)?.filter(|x| truthy(x)).cloned().unwrap_or_else(|| json!({})))
}

// ---- the workspace colour --------------------------------------------------

/// (hex, title) for the workspace this session runs in.
fn workspace_color() -> R<(Option<Value>, Option<Value>)> {
    let Some(wsid) = env_or("CMUX_WORKSPACE_ID") else { return Ok((None, None)) };
    let path = colors_file();
    let mut cache = match pyval::read_text(&path) {
        Ok(Ok(t)) => pyval::loads(&t).unwrap_or_else(|_| json!({})),
        _ => json!({}),
    };
    let hit = get(&cache, &wsid)?.cloned().unwrap_or(Value::Null);
    if truthy(&hit) {
        let at = match get(&hit, "at")? {
            None => 0.0,
            Some(v) => num(v)?,
        };
        if now() - at < COLOR_TTL {
            return Ok(pick(&hit));
        }
    }

    // No cmux at all is (None, None), uncached, as the Python's "no cmux"
    // is; a cmux that is there but does not answer is a cached miss below.
    let Some(cmux) = crate::spawn::connect() else { return Ok((None, None)) };
    // Cache the miss too, or a cmux that is down costs a timeout per render.
    let listed = match cmux.workspace_list(None) {
        Ok(Value::Object(o)) => match o.get("workspaces") {
            Some(w) if truthy(w) => w.clone(),
            _ => json!([]),
        },
        _ => json!([]),
    };
    let stamp = now() as i64;
    let Value::Object(entries) = &mut cache else { unreachable!("get() refused a non-object") };
    let rows: Vec<Value> = match listed {
        Value::Array(a) => a,
        Value::Object(o) => o.keys().map(|k| Value::String(k.clone())).collect(),
        Value::String(s) => s.chars().map(|c| Value::String(c.to_string())).collect(),
        other => return crash(format!("TypeError: '{}' object is not iterable", pyval::type_name(&other))),
    };
    for w in &rows {
        let Some(wid) = get(w, "id")?.filter(|v| truthy(v)) else { continue };
        let title = match get(w, "title")? {
            Some(t) if truthy(t) => match t {
                Value::String(s) => strip(s).to_string(),
                other => {
                    return crash(format!("AttributeError: '{}' object has no attribute 'strip'", pyval::type_name(other)))
                }
            },
            _ => String::new(),
        };
        let color = get(w, "custom_color")?.filter(|v| truthy(v)).cloned().unwrap_or_else(|| json!(""));
        entries.insert(key_of(wid), json!({"at": stamp, "color": color, "title": title}));
    }
    entries.entry(wsid.clone()).or_insert_with(|| json!({"at": stamp, "color": "", "title": ""}));
    // Per-pid temp file: every session's status line writes this file.
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_ok() {
            let _ = crew_core::py::write_atomic(&path, pyval::dumps(&cache, None).as_bytes());
        }
    }
    let e = cache.get(&wsid).cloned().filter(|v| truthy(v)).unwrap_or_else(|| json!({}));
    Ok(pick(&e))
}

fn pick(e: &Value) -> (Option<Value>, Option<Value>) {
    let f = |k: &str| e.get(k).filter(|v| truthy(v)).cloned();
    (f("color"), f("title"))
}

/// A JSON key as json.dump writes a Python dict key.
fn key_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        other => pyval::dumps(other, None),
    }
}

// ---- colour arithmetic, as Python's colorsys computes it ---------------------

const ONE_THIRD: f64 = 1.0 / 3.0;
const ONE_SIXTH: f64 = 1.0 / 6.0;
const TWO_THIRD: f64 = 2.0 / 3.0;

/// Python's float `%` with a positive divisor.
fn pymod1(x: f64) -> f64 {
    let m = x % 1.0;
    if m != 0.0 && m < 0.0 {
        m + 1.0
    } else if m == 0.0 {
        0.0
    } else {
        m
    }
}

fn rgb_to_hls(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let maxc = r.max(g).max(b);
    let minc = r.min(g).min(b);
    let sumc = maxc + minc;
    let rangec = maxc - minc;
    let l = sumc / 2.0;
    if minc == maxc {
        return (0.0, l, 0.0);
    }
    let s = if l <= 0.5 { rangec / sumc } else { rangec / (2.0 - maxc - minc) };
    let rc = (maxc - r) / rangec;
    let gc = (maxc - g) / rangec;
    let bc = (maxc - b) / rangec;
    let h = if r == maxc {
        bc - gc
    } else if g == maxc {
        2.0 + rc - bc
    } else {
        4.0 + gc - rc
    };
    (pymod1(h / 6.0), l, s)
}

fn v(m1: f64, m2: f64, hue: f64) -> f64 {
    let hue = pymod1(hue);
    if hue < ONE_SIXTH {
        return m1 + (m2 - m1) * hue * 6.0;
    }
    if hue < 0.5 {
        return m2;
    }
    if hue < TWO_THIRD {
        return m1 + (m2 - m1) * (TWO_THIRD - hue) * 6.0;
    }
    m1
}

fn hls_to_rgb(h: f64, l: f64, s: f64) -> (f64, f64, f64) {
    if s == 0.0 {
        return (l, l, l);
    }
    let m2 = if l <= 0.5 { l * (1.0 + s) } else { l + s - (l * s) };
    let m1 = 2.0 * l - m2;
    (v(m1, m2, h + ONE_THIRD), v(m1, m2, h), v(m1, m2, h - ONE_THIRD))
}

/// Lift a Peacock colour into something readable as foreground text.
fn for_text(r: i64, g: i64, b: i64) -> (i64, i64, i64) {
    let (h, l, s) = rgb_to_hls(r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
    let (r, g, b) = hls_to_rgb(h, l.max(0.62), s.max(0.45));
    ((r * 255.0) as i64, (g * 255.0) as i64, (b * 255.0) as i64)
}

/// `int(s, 16)` for a slice of the hex: Python strips whitespace, takes a
/// sign and reads any Unicode digit.
fn hex_pair(s: &str) -> Option<i64> {
    let s = strip(s);
    let (neg, body) = match s.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    if body.is_empty() {
        return None;
    }
    let mut n = 0i64;
    for c in body.chars() {
        let d = c.to_digit(16).or_else(|| crate::unicode::decimal(c))? as i64;
        n = n * 16 + d;
    }
    Some(if neg { -n } else { n })
}

/// `text` in 24-bit colour, or as is when the hex is not one.
fn tint(hexcolor: &Value, text: &str) -> R<String> {
    let raw = match hexcolor {
        Value::String(s) => s.as_str(),
        Value::Null => "",
        other if !truthy(other) => "",
        other => return crash(format!("AttributeError: '{}' object has no attribute 'lstrip'", pyval::type_name(other))),
    };
    let h: Vec<char> = raw.trim_start_matches('#').chars().collect();
    if h.len() != 6 {
        return Ok(text.to_string());
    }
    let part = |i: usize| hex_pair(&h[i..i + 2].iter().collect::<String>());
    let (Some(r), Some(g), Some(b)) = (part(0), part(2), part(4)) else { return Ok(text.to_string()) };
    let (r, g, b) = for_text(r, g, b);
    Ok(format!("\x1b[38;2;{r};{g};{b}m{text}\x1b[0m"))
}

// ---- figures -----------------------------------------------------------------

/// Python's `f"{x:.{p}f}"`: both round the exact binary value half to even.
fn fixed(x: f64, p: usize) -> String {
    format!("{x:.p$}")
}

/// `int(x)` for a float or int: truncated toward zero.
fn int(x: f64) -> R<f64> {
    if x.is_nan() {
        return crash("ValueError: cannot convert float NaN to integer");
    }
    if x.is_infinite() {
        return crash("OverflowError: cannot convert float infinity to integer");
    }
    Ok(x.trunc())
}

fn fmt_tokens(n: &Value) -> R<String> {
    let n = int_of(&or0(Some(n)))?;
    Ok(if n >= 1_000_000.0 {
        format!("{}M", fixed(n / 1_000_000.0, 1))
    } else if n >= 1_000.0 {
        format!("{}k", fixed(n / 1_000.0, 0))
    } else {
        format!("{}", n as i64)
    })
}

/// `f"{n:,.0f}"`.
fn grouped(n: f64) -> String {
    let s = fixed(n, 0);
    let (sign, digits) = match s.strip_prefix('-') {
        Some(d) => ("-", d),
        None => ("", s.as_str()),
    };
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    format!("{sign}{out}")
}

fn fmt_usd(n: f64) -> String {
    if n >= 1000.0 {
        format!("${}", grouped(n))
    } else if n >= 100.0 {
        format!("${}", fixed(n, 0))
    } else {
        format!("${}", fixed(n, 2))
    }
}

// ---- ccusage -------------------------------------------------------------------

/// `shutil.which(name)`: PATH (or CS_PATH when unset), access(X_OK),
/// not a directory; an empty entry is the current directory.
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
    if path.is_empty() {
        return None;
    }
    let mut seen = Vec::new();
    for d in path.split(':') {
        if seen.contains(&d) {
            continue;
        }
        seen.push(d);
        let cand = if d.is_empty() { PathBuf::from(name) } else { Path::new(d).join(name) };
        let Ok(c) = std::ffi::CString::new(cand.as_os_str().as_encoded_bytes()) else { continue };
        // SAFETY: access() reads the NUL-terminated path we own.
        let ok = unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0;
        if ok && !cand.is_dir() {
            return Some(cand);
        }
    }
    None
}

/// `json.loads(subprocess.run([exe, *args], timeout=t).stdout).get(key) or []`,
/// or the name of the exception the Python would catch.
fn ccusage(exe: &Path, args: &[String], key: &str, timeout: Duration) -> Result<Value, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => "FileNotFoundError",
            std::io::ErrorKind::PermissionDenied => "PermissionError",
            _ => "OSError",
        })?;
    // communicate(timeout=t): the deadline covers reading both pipes to EOF,
    // which a grandchild holding them open can delay past the child's exit.
    let (tx, rx) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    for (is_out, mut r) in [
        (true, Box::new(child.stdout.take().expect("piped stdout")) as Box<dyn Read + Send>),
        (false, Box::new(child.stderr.take().expect("piped stderr"))),
    ] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = r.read_to_end(&mut b);
            let _ = tx.send((is_out, b));
        });
    }
    drop(tx);
    let deadline = std::time::Instant::now() + timeout;
    let mut bytes = None;
    let mut open = 2;
    while open > 0 {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok((is_out, b)) => {
                open -= 1;
                if is_out {
                    bytes = Some(b);
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("TimeoutExpired".into());
            }
        }
    }
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("TimeoutExpired".into());
            }
        }
    }
    let bytes = bytes.unwrap_or_default();
    let text = String::from_utf8(bytes).map_err(|_| "UnicodeDecodeError".to_string())?;
    let v = pyval::loads(&text).map_err(|_| "JSONDecodeError".to_string())?;
    let Value::Object(o) = v else { return Err("AttributeError".into()) };
    Ok(o.get(key).filter(|x| truthy(x)).cloned().unwrap_or_else(|| json!([])))
}

/// ccusage's answer for `args`, from the cache while it is young. When it
/// has expired, one render (the one holding the lock) asks ccusage again and
/// the others keep showing the last answer meanwhile. A cache that is
/// unreadable, from other args, or from the future is simply a miss.
fn ccusage_cached(exe: &Path, args: &[String], key: &str, timeout: Duration) -> Result<Value, String> {
    let ttl = env_or("CREW_CCUSAGE_TTL").and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(CCUSAGE_TTL);
    if ttl.is_nan() || ttl <= 0.0 {
        return ccusage(exe, args, key, timeout);
    }
    let file = home().join(".claude/cache").join(format!("ccusage-{key}.json"));
    let id = ccusage_key(exe, args, std::env::vars(), std::env::current_dir().ok().as_deref());
    let t = now();
    if let Some(v) = cache_get(&file, &id, ttl, t) {
        return Ok(v);
    }
    match crew_core::py::Flock::try_exclusive(&file.with_extension("lock")) {
        Ok(Some(_held)) => {
            let got = ccusage(exe, args, key, timeout);
            if let Ok(v) = &got {
                cache_put(&file, &id, now(), v);
            }
            got
        }
        _ => cache_get(&file, &id, CCUSAGE_STALE, t).map_or_else(|| ccusage(exe, args, key, timeout), Ok),
    }
}

/// What ccusage's answer depends on besides its args: the environment it
/// reads (where Claude's logs are, its config and caches, the time zone and
/// every CCUSAGE_ setting; read from the strings in ccusage 20's binary) and
/// a project config in the cwd. Sessions that differ in any of it never
/// share an answer.
fn ccusage_key(exe: &Path, args: &[String], env: impl Iterator<Item = (String, String)>, cwd: Option<&Path>) -> String {
    const READS: [&str; 6] = ["HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TZ", "LOG_LEVEL"];
    let mut vars: Vec<(String, String)> = env.filter(|(k, _)| READS.contains(&k.as_str()) || k.starts_with("CCUSAGE_")).collect();
    vars.sort();
    let mut id = format!("{}\0{}", exe.display(), args.join("\0"));
    for (k, v) in vars {
        id += &format!("\0{k}={v}");
    }
    if let Some(local) = cwd.map(|d| d.join(".ccusage/ccusage.json")).filter(|p| p.is_file()) {
        id += &format!("\0config={}", local.display());
    }
    id
}

/// The cached answer in `file` for `id`, if it is younger than `ttl` at `t`.
fn cache_get(file: &Path, id: &str, ttl: f64, t: f64) -> Option<Value> {
    let v = pyval::loads(&std::fs::read_to_string(file).ok()?).ok()?;
    let at = v.get("at")?.as_f64()?;
    (v.get("id")?.as_str()? == id && at <= t && t - at < ttl).then(|| v.get("value").cloned()).flatten()
}

fn cache_put(file: &Path, id: &str, at: f64, value: &Value) {
    let body = pyval::dumps(&json!({"id": id, "at": at, "value": value}), None);
    let _ = crew_core::py::write_atomic(file, body.as_bytes());
}

/// What `for x in v` walks, for a value ccusage handed back.
fn items(v: Value) -> R<Vec<Value>> {
    match v {
        Value::Array(a) => Ok(a),
        Value::Object(o) => Ok(o.keys().map(|k| Value::String(k.clone())).collect()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        other => crash(format!("TypeError: '{}' object is not iterable", pyval::type_name(&other))),
    }
}

fn pricing_args() -> Vec<String> {
    std::panic::catch_unwind(|| crew_core::pricing::config_args(None)).unwrap_or_default()
}

const NO_CCUSAGE: &str = "ccusage not installed — npm i -g ccusage";

fn window_line() -> R<String> {
    let Some(exe) = which("ccusage") else { return Ok(NO_CCUSAGE.into()) };
    let mut args = vec!["blocks".to_string(), "--json".to_string()];
    args.extend(pricing_args());
    let blocks = match ccusage_cached(&exe, &args, "blocks", Duration::from_secs(10)) {
        Ok(b) => items(b)?,
        Err(name) => return Ok(format!("ccusage: {name}")),
    };
    let mut real = Vec::new();
    for b in blocks {
        if !get(&b, "isGap")?.is_some_and(truthy) {
            real.push(b);
        }
    }
    let mut budget = json!(env_or("CREW_BLOCK_BUDGET").and_then(|s| py_int(&s)).unwrap_or(0.0));
    if !truthy(&budget) {
        // max(..., default=0): the first item, replaced only by a greater one,
        // so a NaN first stays (and a NaN later never wins).
        let mut best: Option<Value> = None;
        for b in &real {
            let x = or0(get(b, "totalTokens")?);
            best = Some(match best {
                None => x,
                Some(cur) => {
                    if gt(&x, &cur)? {
                        x
                    } else {
                        cur
                    }
                }
            });
        }
        budget = best.unwrap_or_else(|| json!(0));
    }
    if !truthy(&budget) || num(&budget).is_ok_and(|b| b == 0.0) {
        return Ok("⏱ no usage history yet".into());
    }
    let mut active = None;
    for b in &real {
        if get(b, "isActive")?.is_some_and(truthy) {
            active = Some(b);
            break;
        }
    }
    let Some(active) = active else { return Ok(format!("⏱ window quiet · budget {}", fmt_tokens(&budget)?)) };

    let used = or0(get(active, "totalTokens")?);
    let pct = num(&used)? / num(&budget)? * 100.0;
    let proj = get_or_empty(active, "projection")?;
    let left = int_of(&or0(get(&proj, "remainingMinutes")?))? as i64;
    let mut bits = vec![format!("⏱ {}% of 5h window ({}/{})", fixed(pct, 0), fmt_tokens(&used)?, fmt_tokens(&budget)?)];
    if left != 0 {
        bits.push(if left >= 60 { format!("{}h {:02}m left", left / 60, left % 60) } else { format!("{left}m left") });
    }
    let ptok = or0(get(&proj, "totalTokens")?);
    if gt(&ptok, &used)? {
        bits.push(format!("↗ {}% by reset", fixed(num(&ptok)? / num(&budget)? * 100.0, 0)));
    }
    Ok(bits.join(" · "))
}

/// `int(s)` for an environment string, as a float; None where Python raises.
fn py_int(s: &str) -> Option<f64> {
    let t = strip(s);
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body.is_empty() || body.starts_with('_') || body.ends_with('_') || body.contains("__") {
        return None;
    }
    let mut digits = String::new();
    for c in body.chars() {
        match c {
            '_' => {}
            c => digits.push(char::from(b'0' + crate::unicode::decimal(c)? as u8)),
        }
    }
    let n: f64 = digits.parse().ok()?;
    Some(if t.starts_with('-') { -n } else { n })
}

fn crew_local_cfg() -> Map<String, Value> {
    let path = crew_core::crew_local().join("config.json");
    match pyval::read_text(&path) {
        Ok(Ok(t)) => match pyval::loads(&t) {
            Ok(Value::Object(o)) => o,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}

fn billing_mode() -> String {
    let cfg = crew_local_cfg();
    let raw = env_or("CREW_BILLING")
        .map(Value::String)
        .or_else(|| cfg.get("billing").filter(|v| truthy(v)).cloned())
        .unwrap_or_else(|| json!(""));
    strip(&str_of(&raw)).to_lowercase()
}

fn month_budget() -> f64 {
    let raw = match env_or("CREW_MONTH_BUDGET") {
        Some(s) => Value::String(s),
        None => crew_local_cfg().get("monthBudget").cloned().unwrap_or_else(|| json!("")),
    };
    if !truthy(&raw) {
        return 0.0;
    }
    match &raw {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::String(s) => match pyval::marked(s) {
            Some(_) => num(&raw).unwrap_or(0.0),
            None => pyval::parse_float(strip(s)).unwrap_or(0.0),
        },
        _ => 0.0,
    }
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn days_in_month(y: i64, m: u32) -> i64 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    crew_core::py::days_from_civil(ny, nm, 1) - crew_core::py::days_from_civil(y, m, 1)
}

fn month_line() -> R<String> {
    let Some(exe) = which("ccusage") else { return Ok(NO_CCUSAGE.into()) };
    let mut args = vec!["monthly".to_string(), "--json".to_string()];
    args.extend(pricing_args());
    let rows = match ccusage_cached(&exe, &args, "monthly", Duration::from_secs(15)) {
        Ok(r) => items(r)?,
        Err(name) => return Ok(format!("ccusage: {name}")),
    };
    let (y, m, d) = crew_core::py::local_date(0);
    let period = format!("{y:04}-{m:02}");
    let mut cur = None;
    for r in &rows {
        if get(r, "period")?.and_then(Value::as_str) == Some(period.as_str()) {
            cur = Some(r);
            break;
        }
    }
    let Some(cur) = cur else { return Ok("💰 nothing billed this month yet".into()) };

    let spent = num(&or0(get(cur, "totalCost")?))?;
    let budget = month_budget();
    let breakdowns = get(cur, "modelBreakdowns")?.filter(|v| truthy(v)).cloned().unwrap_or_else(|| json!([]));
    let floor = match breakdowns {
        Value::Array(a) => a.iter().any(|b| b.is_object() && b.get("missingPricing").is_some_and(truthy)),
        Value::Object(_) | Value::String(_) => false,
        other => return crash(format!("TypeError: '{}' object is not iterable", pyval::type_name(&other))),
    };
    let floor = if floor { "+" } else { "" };

    let days_in = days_in_month(y, m) as f64;
    let elapsed = d as f64;
    let projected = spent / elapsed * days_in;
    let mut bits = vec![if budget > 0.0 {
        format!("💰 {}{floor} of {} ({}%)", fmt_usd(spent), fmt_usd(budget), fixed(spent / budget * 100.0, 0))
    } else {
        format!("💰 {}{floor} this month", fmt_usd(spent))
    }];
    if elapsed > 1.0 && projected > spent {
        let arrow = if budget == 0.0 || projected > budget { "↗" } else { "→" };
        bits.push(format!("{arrow} {} by {} {}", fmt_usd(projected), MONTHS[m as usize - 1], days_in as i64));
    }
    Ok(bits.join(" · "))
}

fn usage_line() -> R<String> {
    if billing_mode() == "usage" {
        month_line()
    } else {
        window_line()
    }
}

// ---- the cache segment -----------------------------------------------------------

fn cache_facts(p: &Value) -> R<Option<Value>> {
    if let Some(sid) = get(p, "session_id")?.filter(|v| truthy(v)) {
        let Value::String(sid) = sid else {
            return crash(format!("TypeError: unsupported operand type(s) for +: '{}' and 'str'", pyval::type_name(sid)));
        };
        let path = crew_core::cachefacts::facts_dir().join(format!("{sid}.json"));
        if let Ok(Ok(t)) = pyval::read_text(&path) {
            if let Ok(v) = pyval::loads(&t) {
                return Ok(Some(v));
            }
        }
    }
    match get(p, "transcript_path")?.filter(|v| truthy(v)) {
        Some(Value::String(tp)) if Path::new(tp).exists() => {
            Ok(crew_core::cachefacts::read_facts(Path::new(tp), None, false).ok().map(Value::Object))
        }
        // An int or bool is a file descriptor to os.path.exists, and
        // read_facts' open() of it fails inside the Python's try.
        Some(Value::String(_)) | Some(Value::Number(_)) | Some(Value::Bool(_)) | None => Ok(None),
        Some(other) => crash(format!(
            "TypeError: stat: path should be string, bytes, os.PathLike or integer, not {}",
            pyval::type_name(other)
        )),
    }
}

fn cache_line(payload: &str) -> R<String> {
    let Ok(p) = pyval::loads(if payload.is_empty() { "{}" } else { payload }) else { return Ok(String::new()) };
    if !p.is_object() {
        return Ok(String::new());
    }
    let facts = cache_facts(&p)?;

    // A break visible in the live payload beats everything.
    let cur = get_or_empty(&get_or_empty(&p, "context_window")?, "current_usage")?;
    let creation = or0(get(&cur, "cache_creation_input_tokens")?);
    let read = or0(get(&cur, "cache_read_input_tokens")?);
    if gt(&creation, &json!(20_000))? && num(&read)? < num(&creation)? * 0.5 {
        return Ok(format!("🧊 broke: {} re-cached", fmt_tokens(&creation)?));
    }

    let Some(facts) = facts.filter(truthy) else { return Ok(String::new()) };
    let ttl = or0(get(&facts, "ttl")?);
    let mut last = json!(0.0);
    if let Some(Value::String(tp)) = get(&p, "transcript_path")?.filter(|v| truthy(v)) {
        if let Ok(meta) = std::fs::metadata(tp) {
            last = pyval_float(crew_core::py::mtime(&meta));
        }
    }
    // max(last, x): x replaces last only when greater.
    let req = or0(get(&facts, "lastRequestAt")?);
    if gt(&req, &last)? {
        last = req;
    }
    if !truthy(&ttl) || !truthy(&last) {
        return Ok(String::new());
    }
    let remaining = int(num(&last)? + num(&ttl)? - now())? as i64;
    Ok(if remaining <= 0 {
        "🧊 cache cold".into()
    } else if remaining < 120 {
        format!("🧊 stale in {remaining}s")
    } else {
        format!("🧊 {}m", remaining / 60)
    })
}

fn pyval_float(f: f64) -> Value {
    crew_core::pyjson::float(f)
}

fn render(payload: &str) -> R<String> {
    let mut lead = String::new();
    let (color, title) = workspace_color()?;
    if let Some(color) = &color {
        lead = tint(color, "▊")? + " ";
        if let Some(title) = &title {
            lead += &(tint(color, &str_of(title))? + "  ");
        }
    }
    let mut line = usage_line()?;
    let cache = cache_line(payload)?;
    if !cache.is_empty() {
        line += " · ";
        line += &cache;
    }
    Ok(lead + &line)
}

pub fn main(_args: &[String]) -> i32 {
    use std::io::Read;
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    let Ok(payload) = String::from_utf8(raw) else {
        eprintln!("Traceback (most recent call last):\n  File \"statusline.py\"\nUnicodeDecodeError: 'utf-8' codec can't decode the payload");
        return 1;
    };
    let payload = payload.replace("\r\n", "\n").replace('\r', "\n");
    match render(&payload) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(Crash(msg)) => {
            eprintln!("Traceback (most recent call last):\n  File \"statusline.py\"\n{msg}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifts_like_colorsys() {
        // python3 -c "import colorsys as c; ..." for #196F3D and #922B21
        assert_eq!(for_text(0x19, 0x6f, 0x3d), (96, 219, 148));
        assert_eq!(for_text(0x92, 0x2b, 0x21), (219, 107, 96));
        assert_eq!(for_text(0x80, 0x80, 0x80), (201, 114, 114));
    }

    #[test]
    fn hex_pairs_read_as_int_does() {
        assert_eq!(hex_pair("ff"), Some(255));
        assert_eq!(hex_pair(" f"), Some(15));
        assert_eq!(hex_pair("-f"), Some(-15));
        assert_eq!(hex_pair("zz"), None);
        assert_eq!(hex_pair("+ "), None);
    }

    #[test]
    fn ccusage_cache_hits_while_young_and_misses_after() {
        let d = std::env::temp_dir().join(format!("statusline-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let file = d.join("ccusage-blocks.json");
        // Nothing cached, or a file that is not ours to read: a miss.
        assert_eq!(cache_get(&file, "id", 45.0, 100.0), None);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(cache_get(&file, "id", 45.0, 100.0), None);
        std::fs::write(&file, r#"{"id": "id", "at": "soon", "value": []}"#).unwrap();
        assert_eq!(cache_get(&file, "id", 45.0, 100.0), None);
        let v = json!([{"isActive": true, "totalTokens": 420000, "costUSD": 1.2345678901234567}]);
        cache_put(&file, "id", 100.0, &v);
        assert_eq!(cache_get(&file, "id", 45.0, 100.0), Some(v.clone()));
        assert_eq!(cache_get(&file, "id", 45.0, 144.9), Some(v.clone()));
        // Expired, asked with other args, or written in the future.
        assert_eq!(cache_get(&file, "id", 45.0, 145.0), None);
        assert_eq!(cache_get(&file, "other", 45.0, 120.0), None);
        assert_eq!(cache_get(&file, "id", 45.0, 99.0), None);
        // Still young enough to show while another render refreshes it.
        assert_eq!(cache_get(&file, "id", CCUSAGE_STALE, 300.0), Some(v));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ccusage_key_tells_environments_apart() {
        let exe = Path::new("/bin/ccusage");
        let args = vec!["blocks".to_string(), "--json".to_string()];
        let env = |kv: &[(&str, &str)]| kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>().into_iter();
        let base = ccusage_key(exe, &args, env(&[("HOME", "/h"), ("PATH", "/a")]), None);
        // Variables ccusage does not read change nothing; order never does.
        assert_eq!(base, ccusage_key(exe, &args, env(&[("PATH", "/b"), ("HOME", "/h")]), None));
        for other in [
            env(&[("HOME", "/other")]).collect::<Vec<_>>(),
            env(&[("HOME", "/h"), ("CLAUDE_CONFIG_DIR", "/work")]).collect(),
            env(&[("HOME", "/h"), ("CCUSAGE_MODEL_ALIASES", "x")]).collect(),
            env(&[("HOME", "/h"), ("TZ", "UTC")]).collect(),
        ] {
            assert_ne!(base, ccusage_key(exe, &args, other.into_iter(), None));
        }
        let d = std::env::temp_dir().join(format!("statusline-key-{}", std::process::id()));
        std::fs::create_dir_all(d.join(".ccusage")).unwrap();
        assert_eq!(base, ccusage_key(exe, &args, env(&[("HOME", "/h")]), Some(&d)));
        std::fs::write(d.join(".ccusage/ccusage.json"), "{}").unwrap();
        assert_ne!(base, ccusage_key(exe, &args, env(&[("HOME", "/h")]), Some(&d)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn figures() {
        assert_eq!(fmt_tokens(&json!(420_000)).unwrap(), "420k");
        assert_eq!(fmt_tokens(&json!(1_000_000)).unwrap(), "1.0M");
        assert_eq!(fmt_tokens(&json!(999.9)).unwrap(), "999");
        assert_eq!(fmt_tokens(&json!(2_500)).unwrap(), "2k"); // half to even, as Python
        assert_eq!(fmt_tokens(&json!("1500")).unwrap(), "2k");
        assert_eq!(fmt_tokens(&json!({})).unwrap(), "0");
        assert_eq!(fmt_usd(1288.4), "$1,288");
        assert_eq!(fmt_usd(1234567.5), "$1,234,568");
        assert_eq!(fmt_usd(150.5), "$150");
        assert_eq!(fmt_usd(12.345), "$12.35");
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2026, 12), 31);
        assert_eq!(py_int(" 1_000 "), Some(1000.0));
        assert_eq!(py_int("1.5"), None);
    }
}
