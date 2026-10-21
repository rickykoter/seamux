//! `crew-color`: one color per worktree, worn by cmux, the board and VS Code.
//!
//! The registry is `$XDG_CACHE_HOME/cmux-crew/colors/<md5 of root>`, one
//! shell-sourceable KEY=value file per worktree. cmux's `custom_color` is the
//! source of truth: a color a workspace already wears is adopted, never
//! overruled, and allocation prefers the root's hashed color, else the
//! least-used of cmux's sixteen. Peacock's keys go into
//! `<root>/.vscode/settings.json`. A deep-plan family is the one recolor:
//! children take shades of the parent and keep their old color as PREV.
//!
//! `--help` prints the Python's docstring (HELP), which is the full story.

use std::fs;
use std::path::Path;
use std::time::Duration;

use cmux::Cmux;
use crew_core::pyjson::{self, Opts};
use serde_json::{Map, Value};

use crate::pyval::{py_int, py_space, py_str, py_strip, truthy, universal};
use crate::{md5, pyerr, pypath};

/// cmux's own sixteen workspace colors, in cmux's order.
pub const PALETTE: [(&str, &str); 16] = [
    ("Red", "#C0392B"),
    ("Crimson", "#922B21"),
    ("Orange", "#A04000"),
    ("Amber", "#7D6608"),
    ("Olive", "#4A5C18"),
    ("Green", "#196F3D"),
    ("Teal", "#006B6B"),
    ("Aqua", "#0E6B8C"),
    ("Blue", "#1565C0"),
    ("Navy", "#1A5276"),
    ("Indigo", "#283593"),
    ("Purple", "#6A1B9A"),
    ("Magenta", "#AD1457"),
    ("Rose", "#880E4F"),
    ("Brown", "#7B3F00"),
    ("Charcoal", "#3E4B5E"),
];

fn by_hex(h: &str) -> Option<&'static str> {
    let up = h.to_uppercase();
    PALETTE.iter().find(|(_, x)| *x == up).map(|(n, _)| *n)
}

/// Why a command stopped early. Both exit 1; a family's Peacock follow
/// swallows a `Die` (the Python catches SystemExit there) but not a `Crash`.
#[derive(Debug)]
pub enum Stop {
    /// `die(msg)`: a red cross and the message on stderr.
    Die(String),
    /// An uncaught Python exception: its last traceback line.
    Crash(String),
}

impl Stop {
    /// Print as the Python would have, and give its exit code.
    pub fn report(&self) -> i32 {
        match self {
            Stop::Die(m) => {
                eprint!("\x1b[31m✗\x1b[0m {m}\n");
                1
            }
            Stop::Crash(m) => pyerr::crash(m),
        }
    }
}

/// Warnings off: crew-sync calls this module in-process where the Python ran
/// crew-color with its stderr captured.
static QUIET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_quiet(q: bool) {
    QUIET.store(q, std::sync::atomic::Ordering::Relaxed);
}

fn warn(msg: &str) {
    if !QUIET.load(std::sync::atomic::Ordering::Relaxed) {
        eprint!("{msg}");
    }
}

pub type R<T> = Result<T, Stop>;

fn die(msg: &str) -> Stop {
    Stop::Die(msg.to_string())
}

fn crash(msg: &str) -> Stop {
    Stop::Crash(msg.to_string())
}

// --- registry -------------------------------------------------------------------

fn reg() -> String {
    crew_core::home::xdg_cache().join("colors").to_string_lossy().into_owned()
}

fn entry_path(root: &str) -> String {
    pypath::join(&reg(), &md5::hex(root.as_bytes()))
}

/// One registry file: its KEY=value pairs in file order (a repeated key keeps
/// its first place and its last value, as a dict does).
#[derive(Debug, Clone, Default)]
pub struct Entry {
    kv: Vec<(String, String)>,
    file: String,
    live: bool,
}

impl Entry {
    fn get(&self, k: &str) -> Option<&str> {
        self.kv.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str())
    }

    /// `e.get(k)` when truthy (a non-empty string).
    fn val(&self, k: &str) -> Option<&str> {
        self.get(k).filter(|v| !v.is_empty())
    }

    fn root(&self) -> &str {
        self.get("ROOT").unwrap_or("")
    }

    fn color(&self) -> &str {
        self.get("COLOR").unwrap_or("")
    }
}

/// `read_entry`: None when unreadable or holding no `=` line.
fn read_entry(path: &str) -> Option<Entry> {
    let bytes = fs::read(path).ok()?;
    let text = universal(String::from_utf8(bytes).ok()?);
    let mut e = Entry::default();
    for line in text.split_inclusive('\n') {
        if let Some((k, v)) = line.split_once('=') {
            let (k, v) = (py_strip(k).to_string(), py_strip(v).to_string());
            match e.kv.iter_mut().find(|(key, _)| *key == k) {
                Some(slot) => slot.1 = v,
                None => e.kv.push((k, v)),
            }
        }
    }
    (!e.kv.is_empty()).then_some(e)
}

/// Every registry entry, oldest CREATED first. Dead roots are reported, not hidden.
fn all_entries() -> R<Vec<Entry>> {
    let dir = reg();
    let Ok(rd) = fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut names: Vec<String> = rd.filter_map(|d| d.ok()).map(|d| d.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let mut out = Vec::new();
    for n in names {
        if n.contains(".crew-tmp.") || n.ends_with(".tmp") {
            continue; // a write in flight
        }
        let file = pypath::join(&dir, &n);
        if let Some(mut e) = read_entry(&file) {
            if e.val("ROOT").is_some() && e.val("COLOR").is_some() {
                e.live = Path::new(e.root()).is_dir();
                e.file = file;
                out.push(e);
            }
        }
    }
    let mut keyed = Vec::with_capacity(out.len());
    for e in out {
        let created = e.val("CREATED").unwrap_or("0");
        let Some(k) = py_int(created) else {
            return Err(crash(&format!("ValueError: invalid literal for int() with base 10: {}", pyerr::repr(created))));
        };
        keyed.push((k, e));
    }
    keyed.sort_by_key(|(k, _)| *k);
    Ok(keyed.into_iter().map(|(_, e)| e).collect())
}

/// Through a per-pid temp file and a rename; a failed write leaves the old file.
fn write_atomic(path: &str, text: &str) -> R<()> {
    let tmp = format!("{path}.crew-tmp.{}", std::process::id());
    let res = fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, path));
    if Path::new(&tmp).exists() {
        let _ = fs::remove_file(&tmp);
    }
    res.map_err(|e| crash(&format!("OSError: {}", pyerr::os_error(&e, Path::new(path)))))
}

/// `extra` carries keys beyond the four every entry has (FAMILY, PREV).
fn write_entry(root: &str, name: &str, hexv: &str, extra: &[(&str, &str)]) -> R<()> {
    let dir = reg();
    fs::create_dir_all(&dir).map_err(|e| crash(&format!("OSError: {}", pyerr::os_error(&e, Path::new(&dir)))))?;
    let now = crew_core::py::now() as i64;
    let mut text = format!("ROOT={root}\nCOLOR={hexv}\nNAME={name}\nCREATED={now}\n");
    for (k, v) in extra {
        text.push_str(&format!("{k}={v}\n"));
    }
    write_atomic(&entry_path(root), &text)
}

fn remove(path: &str) -> R<()> {
    fs::remove_file(path).map_err(|e| crash(&format!("FileNotFoundError: {}", pyerr::os_error(&e, Path::new(path)))))
}

// --- allocation -----------------------------------------------------------------

/// The rolling hash crew_ticket_color uses, so the flavour matches.
fn hash_index(root: &str) -> usize {
    let mut s: u64 = 0;
    for ch in root.chars() {
        s = (s * 31 + ch as u64) % 100003;
    }
    (s % PALETTE.len() as u64) as usize
}

/// `workspace list --json`'s rows, or [] when cmux does not answer.
fn workspace_rows() -> Vec<Value> {
    let Ok(c) = Cmux::connect() else { return vec![] };
    let Ok(list) = c.workspace_list(None) else { return vec![] };
    match list.get("workspaces") {
        Some(Value::Array(a)) => a.clone(),
        _ => vec![],
    }
}

fn field<'a>(w: &'a Value, k: &str) -> &'a str {
    w.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Colors other cmux workspaces already wear, by any means (a hand-picked
/// color has no registry entry but is just as taken). Best effort.
fn cmux_colors(root: &str) -> Vec<String> {
    workspace_rows()
        .iter()
        .filter(|w| w.is_object())
        .filter_map(|w| {
            let c = field(w, "custom_color");
            (!c.is_empty() && field(w, "current_directory") != root).then(|| c.to_uppercase())
        })
        .collect()
}

/// The hash-preferred color when free, else the least-used one.
fn pick(root: &str) -> R<(&'static str, &'static str)> {
    let mut used: Vec<(String, usize)> = Vec::new();
    let mut bump = |c: String| match used.iter_mut().find(|(k, _)| *k == c) {
        Some(slot) => slot.1 += 1,
        None => used.push((c, 1)),
    };
    for e in all_entries()? {
        if e.live && e.root() != root {
            bump(e.color().to_uppercase());
        }
    }
    for c in cmux_colors(root) {
        bump(c);
    }
    let count = |h: &str| used.iter().find(|(k, _)| k == h).map(|(_, n)| *n).unwrap_or(0);
    let pref = PALETTE[hash_index(root)];
    if count(pref.1) == 0 {
        return Ok(pref);
    }
    Ok(*PALETTE.iter().enumerate().min_by_key(|(i, p)| (count(p.1), *i)).map(|(_, p)| p).unwrap())
}

pub fn resolve_root(arg: Option<&str>) -> R<String> {
    let start = match arg.filter(|a| !a.is_empty()) {
        Some(a) => a.to_string(),
        None => std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .map_err(|e| crash(&format!("FileNotFoundError: {e}")))?,
    };
    if !Path::new(&start).is_dir() {
        return Err(die(&format!("no such directory: {start}")));
    }
    if let Some((0, out, _)) =
        crew_core::py::run("git", &["-C", &start, "rev-parse", "--show-toplevel"], Duration::from_secs(10))
    {
        let top = py_strip(&out);
        if !top.is_empty() {
            return Ok(top.to_string());
        }
    }
    Ok(pypath::abspath(&start))
}

/// The color a cmux workspace on this exact root already wears.
fn worn_color(root: &str) -> String {
    for w in workspace_rows().iter().filter(|w| w.is_object()) {
        if field(w, "current_directory") == root && truthy(w.get("custom_color")) {
            return py_str(&w["custom_color"]);
        }
    }
    String::new()
}

/// Idempotent: an existing entry wins, a color cmux already shows is adopted,
/// and only then is one allocated. Returns (name, hex).
pub fn assign(root: &str) -> R<(String, String)> {
    if let Some(e) = read_entry(&entry_path(root)) {
        if let Some(c) = e.val("COLOR") {
            let name = e.val("NAME").map(String::from).unwrap_or_else(|| by_hex(c).unwrap_or("?").to_string());
            return Ok((name, c.to_string()));
        }
    }
    let worn = worn_color(root);
    if !worn.is_empty() {
        let name = by_hex(&worn).unwrap_or("custom");
        write_entry(root, name, &worn, &[])?;
        return Ok((name.to_string(), worn));
    }
    let (name, hexv) = pick(root)?;
    write_entry(root, name, hexv, &[])?;
    Ok((name.to_string(), hexv.to_string()))
}

/// The allocated color, allocating nothing (`crew-sync --dry-run`'s read).
pub fn peek(root: &str) -> Option<String> {
    read_entry(&entry_path(root)).and_then(|e| e.val("COLOR").map(String::from))
}

// --- color math (Peacock's, reimplemented) ----------------------------------------

type Rgb = (f64, f64, f64);

/// `int(s, 16)` for a slice of at most two characters.
fn py_hex_int(s: &str) -> Option<i64> {
    let s = py_strip(s);
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = i64::from_str_radix(digits, 16).ok()?;
    Some(if neg { -v } else { v })
}

fn to_rgb(h: &str) -> R<Rgb> {
    let h: Vec<char> = h.trim_start_matches('#').chars().collect();
    let mut c = [0f64; 3];
    for (slot, i) in [0usize, 2, 4].iter().enumerate() {
        let part: String = h.iter().skip(*i).take(2).collect();
        let v = py_hex_int(&part).ok_or_else(|| {
            crash(&format!("ValueError: invalid literal for int() with base 16: {}", pyerr::repr(&part)))
        })?;
        c[slot] = v as f64;
    }
    Ok((c[0], c[1], c[2]))
}

fn to_hex(rgb: Rgb) -> String {
    let ch = |c: f64| c.round_ties_even().clamp(0.0, 255.0) as i64;
    format!("#{:02X}{:02X}{:02X}", ch(rgb.0), ch(rgb.1), ch(rgb.2))
}

/// tinycolor's YIQ brightness test, which Peacock uses.
fn is_light(h: &str) -> R<bool> {
    let (r, g, b) = to_rgb(h)?;
    Ok((r * 299.0 + g * 587.0 + b * 114.0) / 1000.0 > 127.5)
}

/// Lighten (pct > 0) or darken (pct < 0) by HSL lightness, like tinycolor.
fn adjust(h: &str, pct: f64) -> R<String> {
    let (r, g, b) = to_rgb(h)?;
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let mx = r.max(g).max(b);
    let mn = r.min(g).min(b);
    let mut l = (mx + mn) / 2.0;
    let (hue, sat) = if mx == mn {
        (0.0, 0.0)
    } else {
        let d = mx - mn;
        let sat = if l > 0.5 { d / (2.0 - mx - mn) } else { d / (mx + mn) };
        let hue = if mx == r {
            ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
        } else if mx == g {
            ((b - r) / d + 2.0) / 6.0
        } else {
            ((r - g) / d + 4.0) / 6.0
        };
        (hue, sat)
    };
    l = 0f64.max(1f64.min(l + pct / 100.0));
    let chan = |p: f64, q: f64, t: f64| {
        let t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 1.0 / 2.0 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    let rgb = if sat == 0.0 {
        (l, l, l)
    } else {
        let q = if l < 0.5 { l * (1.0 + sat) } else { l + sat - l * sat };
        let p = 2.0 * l - q;
        (chan(p, q, hue + 1.0 / 3.0), chan(p, q, hue), chan(p, q, hue - 1.0 / 3.0))
    };
    Ok(to_hex((rgb.0 * 255.0, rgb.1 * 255.0, rgb.2 * 255.0)))
}

fn lightness(h: &str) -> R<f64> {
    let (r, g, b) = to_rgb(h)?;
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    Ok((r.max(g).max(b) + r.min(g).min(b)) / 2.0)
}

/// Children's shades: alternately lighter and darker, widening, skipping a
/// step that would push lightness off either end.
const SHADE_STEPS: [i32; 12] = [16, -16, 30, -30, 44, -44, 8, -8, 22, -22, 37, -37];

pub fn shades(hexv: &str, n: usize) -> R<Vec<String>> {
    let l = lightness(hexv)?;
    let mut ok: Vec<i32> = SHADE_STEPS.iter().copied().filter(|s| (0.12..=0.88).contains(&(l + *s as f64 / 100.0))).collect();
    if ok.is_empty() {
        ok = vec![8, -8];
    }
    (0..n).map(|i| adjust(hexv, ok[i % ok.len()] as f64)).collect()
}

const DARK_FG: &str = "#15202b";
const LIGHT_FG: &str = "#e7e7e7";

fn fg_for(bg: &str) -> R<&'static str> {
    Ok(if is_light(bg)? { DARK_FG } else { LIGHT_FG })
}

/// Peacock's default elements (activityBar, titleBar, statusBar), in its order.
fn customizations(hexv: &str) -> R<Vec<(&'static str, String)>> {
    let ab = adjust(hexv, 5.0)?;
    let ab_fg = fg_for(&ab)?;
    let sb_fg = fg_for(hexv)?;
    let tb_fg = sb_fg;
    let badge = adjust(&ab, 25.0)?;
    Ok(vec![
        ("activityBar.activeBackground", adjust(&ab, 10.0)?),
        ("activityBar.background", ab.clone()),
        ("activityBar.foreground", ab_fg.into()),
        ("activityBar.inactiveForeground", format!("{ab_fg}99")),
        ("activityBarBadge.background", badge.clone()),
        ("activityBarBadge.foreground", fg_for(&badge)?.into()),
        ("statusBar.background", hexv.into()),
        ("statusBar.foreground", sb_fg.into()),
        ("statusBarItem.hoverBackground", adjust(hexv, 10.0)?),
        ("statusBarItem.remoteBackground", hexv.into()),
        ("statusBarItem.remoteForeground", sb_fg.into()),
        ("titleBar.activeBackground", hexv.into()),
        ("titleBar.activeForeground", tb_fg.into()),
        ("titleBar.inactiveBackground", format!("{hexv}99")),
        ("titleBar.inactiveForeground", format!("{tb_fg}99")),
    ])
}

/// The keys `customizations` owns, whatever the color.
const PEACOCK_KEYS: [&str; 15] = [
    "activityBar.activeBackground",
    "activityBar.background",
    "activityBar.foreground",
    "activityBar.inactiveForeground",
    "activityBarBadge.background",
    "activityBarBadge.foreground",
    "statusBar.background",
    "statusBar.foreground",
    "statusBarItem.hoverBackground",
    "statusBarItem.remoteBackground",
    "statusBarItem.remoteForeground",
    "titleBar.activeBackground",
    "titleBar.activeForeground",
    "titleBar.inactiveBackground",
    "titleBar.inactiveForeground",
];

// --- the Peacock settings file ----------------------------------------------------

/// Comments and trailing commas out, so a hand-edited settings.json parses.
/// Strings are copied whole, so a "//" or ",}" inside one survives.
fn strip_jsonc(text: &str) -> String {
    let t: Vec<char> = text.chars().collect();
    let n = t.len();
    let starts = |i: usize, s: &str| s.chars().enumerate().all(|(k, c)| t.get(i + k) == Some(&c));
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < n {
        let c = t[i];
        if c == '"' {
            let mut j = i + 1;
            while j < n {
                if t[j] == '\\' {
                    j += 2;
                    continue;
                }
                if t[j] == '"' {
                    break;
                }
                j += 1;
            }
            out.push(t[i..(j + 1).min(n)].iter().collect());
            i = j + 1;
            continue;
        }
        if starts(i, "//") {
            while i < n && t[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if starts(i, "/*") {
            i = (i + 2..n.saturating_sub(1)).find(|&k| t[k] == '*' && t[k + 1] == '/').map(|k| k + 2).unwrap_or(n);
            continue;
        }
        if c == '}' || c == ']' {
            let mut k = out.len();
            while k > 0 && !out[k - 1].is_empty() && out[k - 1].chars().all(py_space) {
                k -= 1;
            }
            if k > 0 && out[k - 1] == "," {
                out.remove(k - 1);
            }
        }
        out.push(c.to_string());
        i += 1;
    }
    out.concat()
}

/// `load_settings`: (the object, had comments); None for a file that does not
/// parse. A missing or blank file is an empty object.
fn load_settings(path: &str) -> R<(Option<Value>, bool)> {
    let p = Path::new(path);
    if !p.exists() {
        return Ok((Some(Value::Object(Map::new())), false));
    }
    let bytes = fs::read(p).map_err(|e| crash(&format!("OSError: {}", pyerr::os_error(&e, p))))?;
    let raw = match String::from_utf8(bytes) {
        Ok(t) => universal(t),
        Err(e) => return Err(crash(&format!("UnicodeDecodeError: {}", pyerr::decode_error(&e.utf8_error(), e.as_bytes())))),
    };
    if py_strip(&raw).is_empty() {
        return Ok((Some(Value::Object(Map::new())), false));
    }
    // An integer past 64 bits would come back as a float and be rewritten as
    // 1e+20; a file that cannot round-trip is refused (read as unparseable)
    // rather than changed behind the user's back.
    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
        return Ok((if has_wide_int(&raw) { None } else { Some(v) }, false));
    }
    let stripped = strip_jsonc(&raw);
    match serde_json::from_str::<Value>(&stripped) {
        Ok(v) if !has_wide_int(&stripped) => Ok((Some(v), true)),
        _ => Ok((None, false)),
    }
}

/// True when the JSON text holds an integer literal outside i64/u64, which
/// serde_json (without arbitrary precision) reads as a lossy float.
fn has_wide_int(text: &str) -> bool {
    let b = text.as_bytes();
    let (mut i, mut in_str) = (0, false);
    while i < b.len() {
        let c = b[i];
        if in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == b'"' {
            in_str = true;
            i += 1;
            continue;
        }
        if c == b'-' || c.is_ascii_digit() {
            let start = i;
            while i < b.len() && (b[i].is_ascii_digit() || b"-+.eE".contains(&b[i])) {
                i += 1;
            }
            let lit = &text[start..i];
            if !lit.contains(['.', 'e', 'E']) && lit.parse::<i64>().is_err() && lit.parse::<u64>().is_err() {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}

/// `dict(v)` for the settings object; anything else is a TypeError.
fn as_dict(v: &Value) -> R<Map<String, Value>> {
    match v {
        Value::Object(o) => Ok(o.clone()),
        // dict([]) and dict("") are both {}.
        Value::Array(a) if a.is_empty() => Ok(Map::new()),
        Value::String(s) if s.is_empty() => Ok(Map::new()),
        other => Err(crash(&format!("TypeError: cannot convert {} to a dict", pyjson::dumps(other)))),
    }
}

fn dumps_settings(v: &Value) -> String {
    pyjson::dumps_with(v, Opts { indent: Some(2), sort_keys: true, compact: false }) + "\n"
}

const CC: &str = "workbench.colorCustomizations";

/// Merge Peacock's keys into <root>/.vscode/settings.json, keeping the rest.
fn apply(root: &str, hexv: &str) -> R<bool> {
    let vsdir = pypath::join(root, ".vscode");
    let path = pypath::join(&vsdir, "settings.json");
    let (cur, had_comments) = load_settings(&path)?;
    let Some(cur) = cur else {
        return Err(die(&format!("{path} is not parseable as JSON — refusing to overwrite it")));
    };
    let want = customizations(hexv)?;
    let mut merged = as_dict(&cur)?;
    merged.insert("peacock.color".into(), Value::String(hexv.into()));
    let mut cc = match merged.get(CC) {
        Some(v) if truthy(Some(v)) => as_dict(v)?,
        _ => Map::new(),
    };
    for (k, v) in want {
        cc.insert(k.into(), Value::String(v));
    }
    merged.insert(CC.into(), Value::Object(cc));
    let merged = Value::Object(merged);
    if merged == cur {
        return Ok(false);
    }
    fs::create_dir_all(&vsdir).map_err(|e| crash(&format!("OSError: {}", pyerr::os_error(&e, Path::new(&vsdir)))))?;
    write_atomic(&path, &dumps_settings(&merged))?;
    if had_comments {
        warn(&format!("\x1b[33m!\x1b[0m {path} had comments; they were dropped when the file was rewritten\n"));
    }
    Ok(true)
}

fn unapply(root: &str) -> R<bool> {
    let path = pypath::join(root, ".vscode/settings.json");
    let (cur, _) = load_settings(&path)?;
    let Some(cur) = cur.filter(|c| truthy(Some(c))) else { return Ok(false) };
    let mut merged = as_dict(&cur)?;
    merged.shift_remove("peacock.color");
    let mut cc = match merged.get(CC) {
        Some(v) if truthy(Some(v)) => as_dict(v)?,
        _ => Map::new(),
    };
    for k in PEACOCK_KEYS {
        cc.shift_remove(k);
    }
    if cc.is_empty() {
        merged.shift_remove(CC);
    } else {
        merged.insert(CC.into(), Value::Object(cc));
    }
    let merged_v = Value::Object(merged.clone());
    if merged_v == cur {
        return Ok(false);
    }
    if merged.is_empty() {
        // Nothing of ours and nothing of anyone else's: leave no empty file.
        remove(&path)?;
    } else {
        write_atomic(&path, &dumps_settings(&merged_v))?;
    }
    Ok(true)
}

/// Recolor VS Code only where Peacock already colors this worktree.
fn peacock_follow(root: &str, hexv: &str) -> R<()> {
    let (cur, _) = load_settings(&pypath::join(root, ".vscode/settings.json"))?;
    let Some(cur) = cur.filter(|c| truthy(Some(c))) else { return Ok(()) };
    let Value::Object(o) = &cur else {
        return Err(crash("AttributeError: object has no attribute 'get'"));
    };
    if truthy(o.get("peacock.color")) {
        match apply(root, hexv) {
            Ok(_) | Err(Stop::Die(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

// --- commands ---------------------------------------------------------------------

fn cmd_assign(path: Option<&str>) -> R<()> {
    let root = resolve_root(path)?;
    let (_, hexv) = assign(&root)?;
    println!("{hexv}");
    Ok(())
}

fn cmd_peek(path: Option<&str>) -> R<()> {
    if let Some(c) = peek(&resolve_root(path)?) {
        println!("{c}");
    }
    Ok(())
}

fn cmd_show(path: Option<&str>) -> R<()> {
    let root = resolve_root(path)?;
    let e = read_entry(&entry_path(&root));
    println!("  root       {}", pypath::tilde(&root));
    let Some(e) = e else {
        println!("  color      none (crew-color assign gives it one)");
        return Ok(());
    };
    let Some(color) = e.get("COLOR") else {
        return Err(crash("KeyError: 'COLOR'"));
    };
    println!("  color      {color}  {}", e.val("NAME").unwrap_or(""));
    let vs = pypath::join(&root, ".vscode/settings.json");
    let (cur, _) = load_settings(&vs)?;
    let live = match cur.filter(|c| truthy(Some(c))) {
        None => false,
        Some(Value::Object(o)) => match o.get("peacock.color") {
            None => color.is_empty(),
            Some(Value::String(s)) => s.to_uppercase() == color.to_uppercase(),
            Some(_) => return Err(crash("AttributeError: object has no attribute 'upper'")),
        },
        Some(_) => return Err(crash("AttributeError: object has no attribute 'get'")),
    };
    println!("  peacock    {}  {}", if live { "applied" } else { "not applied" }, pypath::tilde(&vs));
    Ok(())
}

fn cmd_list() -> R<()> {
    let entries = all_entries()?;
    let mut by: Vec<(String, Vec<&Entry>)> = Vec::new();
    for e in &entries {
        let k = e.color().to_uppercase();
        match by.iter_mut().find(|(h, _)| *h == k) {
            Some(slot) => slot.1.push(e),
            None => by.push((k, vec![e])),
        }
    }
    let rows_of = |h: &str| by.iter().find(|(k, _)| k == h).map(|(_, v)| v.clone()).unwrap_or_default();

    // cmux workspaces wearing a color crew has no entry for: set by hand.
    let mut manual: Vec<(String, Vec<String>)> = Vec::new();
    for w in workspace_rows() {
        let Value::Object(_) = w else { break };
        let c = match w.get("custom_color") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.to_uppercase(),
            Some(v) if !truthy(Some(v)) => String::new(),
            Some(_) => break, // .upper() raises inside the try: the rest is skipped
        };
        let cwd = field(&w, "current_directory").to_string();
        if c.is_empty() {
            continue;
        }
        if rows_of(&c).iter().any(|e| e.root() == cwd) {
            continue;
        }
        let label = ["custom_title", "title"]
            .iter()
            .find_map(|k| w.get(*k).filter(|v| truthy(Some(v))).map(py_str))
            .unwrap_or(cwd);
        match manual.iter_mut().find(|(h, _)| *h == c) {
            Some(slot) => slot.1.push(label),
            None => manual.push((c, vec![label])),
        }
    }

    let held = entries.iter().filter(|e| e.live).count();
    println!(
        "  {held} live of {} entries, {} hand-set, {} colors\n",
        entries.len(),
        manual.len(),
        PALETTE.len()
    );
    for (name, hexv) in PALETTE {
        let rows = rows_of(hexv);
        let live = rows.iter().filter(|r| r.live).count();
        let hands = manual.iter().find(|(h, _)| h == hexv).map(|(_, v)| v.clone()).unwrap_or_default();
        let mark = if live > 0 || !hands.is_empty() { "●" } else { "○" };
        let extra = if live + hands.len() > 1 { "  \x1b[31m(shared)\x1b[0m" } else { "" };
        println!("  {mark} {hexv}  {name:<9}{extra}");
        for r in &rows {
            let tag = if r.live { "" } else { "  \x1b[2m(gone)\x1b[0m" };
            println!("        {}{tag}", pypath::basename(r.root()));
        }
        for t in &hands {
            println!("        {t}  \x1b[2m(hand-set)\x1b[0m");
        }
    }
    let dead = entries.iter().filter(|e| !e.live).count();
    if dead > 0 {
        println!(
            "\n  {dead} dead entr{} — crew-color prune frees those colors",
            if dead == 1 { "y" } else { "ies" }
        );
    }
    Ok(())
}

fn cmd_apply(path: Option<&str>) -> R<()> {
    let root = resolve_root(path)?;
    let (name, hexv) = assign(&root)?;
    let changed = apply(&root, &hexv)?;
    println!(
        "\x1b[32m✓\x1b[0m {name} {hexv} {} {}/.vscode/settings.json",
        if changed { "written to" } else { "already in" },
        pypath::tilde(&root)
    );
    Ok(())
}

fn cmd_free(path: Option<&str>) -> R<()> {
    let root = resolve_root(path)?;
    unapply(&root)?;
    let p = entry_path(&root);
    if Path::new(&p).exists() {
        remove(&p)?;
    }
    println!("\x1b[32m✓\x1b[0m released {}", pypath::tilde(&root));
    Ok(())
}

/// A deep-plan family: the parent keeps its color, each child takes a shade
/// of it and keeps its color from before as PREV. Returns (root, hex) per member.
pub fn family(parent: &str, kids: &[String]) -> R<Vec<(String, String)>> {
    let (name, hexv) = assign(parent)?;
    let mut out = vec![(parent.to_string(), hexv.clone())];
    let pe = read_entry(&entry_path(parent)).unwrap_or_default();
    if pe.get("FAMILY") != Some(parent) {
        write_entry(parent, &name, &hexv, &[("FAMILY", parent), ("PREV", &hexv)])?;
    }
    let shade_name = format!("{name} shade");
    for (root, shade) in kids.iter().zip(shades(&hexv, kids.len())?) {
        let e = read_entry(&entry_path(root)).unwrap_or_default();
        let prev = if e.get("FAMILY") == Some(parent) {
            e.get("PREV").unwrap_or("").to_string()
        } else {
            // Joining: whatever it wore before is what leaving gives back.
            e.val("COLOR").map(String::from).unwrap_or_else(|| worn_color(root))
        };
        if e.get("COLOR").unwrap_or("").to_uppercase() != shade.to_uppercase() || e.get("FAMILY") != Some(parent) {
            write_entry(root, &shade_name, &shade, &[("FAMILY", parent), ("PREV", &prev)])?;
            peacock_follow(root, &shade)?;
        }
        out.push((root.clone(), shade));
    }
    Ok(out)
}

fn cmd_family(args: &[String]) -> R<()> {
    if args.len() < 2 {
        return Err(die("family <parent-root> <child-root>..."));
    }
    for (root, h) in family(&args[0], &args[1..])? {
        println!("{root}\t{h}");
    }
    Ok(())
}

/// Back to the color from before the family; None when not in one.
pub fn unfamily(root: &str) -> R<Option<String>> {
    let Some(e) = read_entry(&entry_path(root)) else { return Ok(None) };
    if e.val("FAMILY").is_none() {
        return Ok(None);
    }
    let prev = e.get("PREV").unwrap_or("").to_string();
    if prev.is_empty() {
        remove(&entry_path(root))?;
    } else {
        let name = by_hex(&prev).unwrap_or("custom");
        write_entry(root, name, &prev, &[])?;
        peacock_follow(root, &prev)?;
    }
    Ok(Some(prev))
}

/// `unfamily --stale`: every member of a family not in `live` gets its colour
/// from before. Returns the (root, prev) pairs done, and the error that
/// stopped the sweep, if one did (the Python had printed the earlier lines).
pub fn unfamily_stale(live: &[String]) -> (Vec<(String, String)>, Option<Stop>) {
    let mut done = Vec::new();
    let entries = match all_entries() {
        Ok(e) => e,
        Err(stop) => return (done, Some(stop)),
    };
    for e in entries {
        if let Some(fam) = e.val("FAMILY") {
            if !live.iter().any(|l| l == fam) {
                match unfamily(e.root()) {
                    Ok(Some(prev)) => done.push((e.root().to_string(), prev)),
                    Ok(None) => {}
                    Err(stop) => return (done, Some(stop)),
                }
            }
        }
    }
    (done, None)
}

/// What `crew-color assign|peek <root>` prints, as crew-sync reads it: the
/// hex, or "" when it is not one or the run failed.
pub fn color_for(root: &str, peek_only: bool) -> String {
    let hexv = resolve_root(Some(root)).and_then(|r| {
        if peek_only {
            Ok(peek(&r).unwrap_or_default())
        } else {
            assign(&r).map(|(_, h)| h)
        }
    });
    match hexv {
        Ok(h) if py_strip(&h).starts_with('#') => py_strip(&h).to_string(),
        _ => String::new(),
    }
}

fn cmd_unfamily(args: &[String]) -> R<()> {
    if args.first().map(String::as_str) == Some("--stale") {
        let (done, stop) = unfamily_stale(&args[1..]);
        for (root, prev) in done {
            println!("{root}\t{prev}");
        }
        return stop.map_or(Ok(()), Err);
    }
    let Some(root) = args.first() else {
        return Err(die("unfamily <root> | unfamily --stale [<live-parent-root>...]"));
    };
    if let Some(prev) = unfamily(root)? {
        println!("{root}\t{prev}");
    }
    Ok(())
}

fn cmd_prune() -> R<()> {
    let mut n = 0;
    for e in all_entries()? {
        if !e.live {
            remove(&e.file)?;
            n += 1;
        }
    }
    println!("\x1b[32m✓\x1b[0m pruned {n}");
    Ok(())
}

/// The Python's docstring, verbatim: `crew-color --help` prints it trimmed.
const HELP: &str = r##"crew-color — one color per worktree, worn by cmux, the board, and VS Code.

The point is recognition. With twenty worktrees open, "which window is this?" is
a question you should be able to answer from across the room instead of reading a
title bar. So every worktree gets a color and then wears it in all three places
you look at it:

    cmux workspace   custom_color, set by crew-sync via `workspace-action`
    crew board       a vertical sliver on the row, read from `w.color`
    VS Code window   Peacock, via <root>/.vscode/settings.json

WHY cmux's custom_color IS THE SOURCE OF TRUTH
----------------------------------------------
The board could have carried the color in a `description` token like every other
crew signal — and that was the plan until `cmux workspace list --json` turned out
to expose a first-class `custom_color` field, writable through
`workspace-action set-color`, and the sidebar DSL turned out to bind it as
`w.color` already. So the board needs no token, no crew-sync round trip, and no
parsing: it reads the same field cmux itself paints the workspace strip with.
That also means the color is right in cmux's *native* sidebar for free.

Verified, because none of it is documented together:
  - `--color '#1565C0'` is stored verbatim. Nothing snaps it to a named color.
  - `--color Amber` resolves to `#7D6608` — and cmux's sixteen names resolve to
    exactly the sixteen hexes already hard-coded in `crew_ticket_color`
    (hooks/lib.sh), which is why PALETTE below is that same list with the names
    attached rather than a new invention.
  - it reads back on both `sidebar-state` (`color=`) and `workspace list --json`
    (`custom_color`), and `clear-color` returns it to none.

WHY .vscode/settings.json IS SAFE TO WRITE
------------------------------------------
`.vscode/` is gitignored by the monolith itself (.gitignore:67), inside worktrees
too — checked with `git check-ignore`. So Peacock's settings never dirty the tree
and never show up as a stray file on the board's dirty dot. This is the whole
reason the Peacock half is even reasonable; if that directory were tracked, every
colored worktree would read as modified.

TWENTY WORKTREES, SIXTEEN COLORS
--------------------------------
There is no free-slot guarantee to be had, so allocation degrades on purpose
rather than pretending. `pick()` prefers the hash-preferred color when it is
free — so a given worktree tends to keep its color across a prune-and-return —
and otherwise takes the *least-used* one. Past sixteen, colors are shared as
evenly as possible instead of piling onto whatever the hash happened to like.

Usage:
  crew-color assign [path]     idempotent; allocate if needed, print the hex
  crew-color peek   [path]     print the hex only if already allocated
  crew-color show   [path]     hex and name for this worktree, if any
  crew-color list              the map: every color and what holds it
  crew-color apply  [path]     write Peacock settings into <root>/.vscode
  crew-color free   [path]     release the color and remove Peacock settings
  crew-color prune             drop entries whose worktree is gone
  crew-color family <parent-root> <child-root>...
                               a deep-plan family: the parent keeps its color,
                               each child takes a shade of it; a member's color
                               from before is kept (PREV) and the family noted
                               (FAMILY). Prints "root<TAB>hex" per member.
  crew-color unfamily <root> | --stale [<live-parent-root>...]
                               put a member's color from before back; --stale
                               does it for every member of a family not named.
                               Prints "root<TAB>hex" ("" when there was none).

FAMILIES, THE ONE EXCEPTION TO "NEVER MOVES ON ITS OWN"
-------------------------------------------------------
A deep-plan family (a parent plan and the child plans it coordinates) reads as
one thing when its worktrees wear one hue: the parent's color, and a lighter or
darker shade of it on each child. Joining a family is an explicit act, so it is
the one time crew recolors a worktree that already has a color -- and it keeps
that color as PREV, so leaving the family (or the family closing) puts it back.
Shades are not palette colors, so they never use up one of the sixteen.
"##;

pub fn main(args: &[String]) -> i32 {
    let cmd = args.first().map(String::as_str).unwrap_or("show");
    let arg = args.get(1).map(String::as_str);
    let res = match cmd {
        "-h" | "--help" => {
            println!("{}", HELP.trim());
            Ok(())
        }
        "assign" => cmd_assign(arg),
        "peek" => cmd_peek(arg),
        "show" => cmd_show(arg),
        "list" => cmd_list(),
        "apply" => cmd_apply(arg),
        "free" => cmd_free(arg),
        "prune" => cmd_prune(),
        "family" => cmd_family(&args[1..]),
        "unfamily" => cmd_unfamily(&args[1..]),
        other if Path::new(other).is_dir() => cmd_show(Some(other)),
        other => Err(die(&format!("unknown '{other}' (try --help)"))),
    };
    match res {
        Ok(()) => 0,
        Err(stop) => stop.report(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_index_matches_the_python() {
        // python3: s = (s * 31 + ord(c)) % 100003 over the root, then s % 16
        assert_eq!(hash_index("/r/a"), 8);
        assert_eq!(hash_index("~/code/repo"), 2);
        assert_eq!(hash_index("é/x"), 12);
    }

    #[test]
    fn a_wide_int_is_seen_and_strings_are_skipped() {
        assert!(has_wide_int(r#"{"n": 100000000000000000000}"#));
        assert!(has_wide_int(r#"{"n": -9223372036854775809}"#));
        assert!(!has_wide_int(r#"{"n": 18446744073709551615, "f": 1e400, "s": "99999999999999999999"}"#));
        assert!(!has_wide_int(r#"{"s": "a\"99999999999999999999"}"#));
    }

    #[test]
    fn strip_jsonc_drops_comments_and_trailing_commas_outside_strings() {
        let t = "{\n // c\n \"a\": \"x//y,}\", /* b */ \"l\": [1, 2, ],\n}";
        let v: Value = serde_json::from_str(&strip_jsonc(t)).unwrap();
        assert_eq!(v, serde_json::json!({"a": "x//y,}", "l": [1, 2]}));
    }
}
