//! Python's view of a JSON value, for the tools that test options the way the
//! Python did: `str(v)`, `repr(v)`, truthiness, `str.strip()`, `float(s)` and
//! `int(f)`. Plus the bits of `os` and `time` the settings writers print.

use std::path::Path;

use crew_core::pyjson::float_repr;
use serde_json::Value;

/// `bool(v)`: null, false, 0, 0.0, "", [] and {} are false.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(), // a marked number is never zero
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `str(v)`.
pub fn str_of(v: &Value) -> String {
    match v {
        Value::String(s) if marked(s).is_none() => s.clone(),
        other => repr(other),
    }
}

/// The JSON text of a number serde cannot hold (see `loads`), when `s` is
/// one: digits past 64 bits, `NaN`, `Infinity` or `-Infinity`.
pub fn marked(s: &str) -> Option<&str> {
    s.strip_prefix(MARK_OPEN).and_then(|r| r.strip_suffix(MARK_CLOSE))
}

/// Python's name for a value's type, as its error messages print it.
pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(s) => match marked(s) {
            Some(m) if m.bytes().all(|b| b.is_ascii_digit() || b == b'-') => "int",
            Some(_) => "float",
            None => "str",
        },
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `str(v or default)`.
pub fn str_or(v: Option<&Value>, default: &str) -> String {
    match v {
        Some(v) if truthy(v) => str_of(v),
        _ => default.to_string(),
    }
}

/// `repr(v)` for what json.load returns.
pub fn repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                n.to_string()
            } else {
                float_repr(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => match marked(s) {
            Some("NaN") => "nan".into(),
            Some("Infinity") => "inf".into(),
            Some("-Infinity") => "-inf".into(),
            Some(digits) => digits.into(),
            None => repr_str(s),
        },
        Value::Array(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter().map(|(k, v)| format!("{}: {}", repr_str(k), repr(v))).collect::<Vec<_>>().join(", ")
        ),
    }
}

/// `repr(s)`: single quotes unless the text has one and no double quote.
pub fn repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if !crate::unicode::printable(c) => {
                let n = c as u32;
                if n <= 0xff {
                    out.push_str(&format!("\\x{n:02x}"));
                } else if n <= 0xffff {
                    out.push_str(&format!("\\u{n:04x}"));
                } else {
                    out.push_str(&format!("\\U{n:08x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// `str.strip()`: Unicode whitespace plus the four ASCII separators Python counts.
pub fn strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c))
}

/// `float(s)` on an already stripped string; None where Python raises.
pub fn parse_float(s: &str) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    // Python takes an underscore between two digits and nowhere else.
    let b = s.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if c == b'_' && !(i > 0 && b[i - 1].is_ascii_digit() && b.get(i + 1).is_some_and(u8::is_ascii_digit)) {
            return None;
        }
    }
    // float() reads any Unicode decimal digit as its ASCII twin.
    let t: String = s
        .chars()
        .filter(|&c| c != '_')
        .map(|c| match crate::unicode::decimal(c) {
            Some(d) if !c.is_ascii() => char::from(b'0' + d as u8),
            _ => c,
        })
        .collect();
    if !t.is_ascii() {
        return None;
    }
    let body = t.trim_start_matches(['+', '-']);
    if t.len() - body.len() > 1 {
        return None;
    }
    let lower = body.to_ascii_lowercase();
    if matches!(lower.as_str(), "inf" | "infinity" | "nan") {
        return t.parse::<f64>().ok().or(Some(if lower == "nan" { f64::NAN } else { f64::INFINITY }));
    }
    // Rust and Python agree on the rest of the grammar, except that Rust
    // spells infinity several more ways, which the check above settles.
    if !body.bytes().next().is_some_and(|c| c.is_ascii_digit() || c == b'.') {
        return None;
    }
    t.parse::<f64>().ok()
}

/// `int(f)` as exact decimal digits (truncated toward zero); None for NaN and
/// the infinities, where Python raises.
pub fn int_digits(f: f64) -> Option<String> {
    if !f.is_finite() {
        return None;
    }
    let t = f.trunc();
    if t.abs() < 9.0e15 {
        return Some(format!("{}", t as i64));
    }
    // Large: mantissa * 2^exp, done in base 1e9 limbs.
    let bits = t.abs().to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i64 - 1075;
    let mant = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
    let mut limbs: Vec<u64> = vec![mant % 1_000_000_000, mant / 1_000_000_000 % 1_000_000_000, mant / 1_000_000_000_000_000_000];
    for _ in 0..exp.max(0) {
        let mut carry = 0u64;
        for l in limbs.iter_mut() {
            let v = *l * 2 + carry;
            *l = v % 1_000_000_000;
            carry = v / 1_000_000_000;
        }
        if carry > 0 {
            limbs.push(carry);
        }
    }
    while limbs.len() > 1 && *limbs.last().unwrap() == 0 {
        limbs.pop();
    }
    let mut s = String::new();
    if t < 0.0 {
        s.push('-');
    }
    s.push_str(&limbs.last().unwrap().to_string());
    for l in limbs.iter().rev().skip(1) {
        s.push_str(&format!("{l:09}"));
    }
    Some(s)
}

/// `str(OSError)`: `[Errno 13] Permission denied: '/path'`.
pub fn os_error(e: &std::io::Error, path: &Path) -> String {
    match e.raw_os_error() {
        Some(errno) => {
            // SAFETY: strerror returns a static string for any errno.
            let msg = unsafe { std::ffi::CStr::from_ptr(libc::strerror(errno)) }.to_string_lossy().into_owned();
            format!("[Errno {errno}] {msg}: {}", repr_str(&path.to_string_lossy()))
        }
        None => e.to_string(),
    }
}

/// `time.strftime('%Y%m%d-%H%M%S')`, local time.
pub fn stamp() -> String {
    let t = crew_core::py::now() as libc::time_t;
    // SAFETY: localtime_r writes only into tm, which we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// `shutil.copy2`: the bytes, the mode and the access and modified times.
pub fn copy2(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::copy(from, to)?;
    let meta = std::fs::metadata(from)?;
    let times = std::fs::FileTimes::new().set_accessed(meta.accessed()?).set_modified(meta.modified()?);
    std::fs::OpenOptions::new().write(true).open(to)?.set_times(times)
}

/// Python's text-mode read: UTF-8, with `\r\n` and `\r` read as `\n`.
pub fn read_text(path: &Path) -> std::io::Result<Result<String, String>> {
    let bytes = std::fs::read(path)?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => Ok(s.replace("\r\n", "\n").replace('\r', "\n")),
        Err(e) => {
            let at = e.utf8_error().valid_up_to();
            let byte = e.as_bytes()[at];
            Err(format!("'utf-8' codec can't decode byte 0x{byte:02x} in position {at}: invalid start byte"))
        }
    })
}

/// A JSON parse failure in json.loads' words, as far as serde can tell them:
/// the message, then `line L column C (char N)`.
pub fn json_error(text: &str, e: &serde_json::Error) -> String {
    let (line, col) = (e.line(), e.column());
    let char_at: usize = text.split('\n').take(line.saturating_sub(1)).map(|l| l.chars().count() + 1).sum::<usize>()
        + col.saturating_sub(1);
    let what = match e.classify() {
        serde_json::error::Category::Eof => "Expecting value",
        _ => {
            let m = e.to_string();
            if m.starts_with("key must be a string") {
                "Expecting property name enclosed in double quotes"
            } else if m.starts_with("expected `:`") {
                "Expecting ':' delimiter"
            } else if m.starts_with("expected `,` or `}`") {
                "Expecting ',' delimiter"
            } else if m.starts_with("trailing characters") {
                "Extra data"
            } else {
                "Expecting value"
            }
        }
    };
    format!("{what}: line {line} column {col} (char {char_at})")
}

const MARK_OPEN: &str = "\u{0}json:";
const MARK_CLOSE: &str = "\u{0}";

/// json.loads, losing nothing Python keeps. serde_json holds a number in 64
/// bits and refuses NaN and Infinity; Python keeps an integer of any size and
/// takes those literals (a float too large for f64 is `inf`). Each such token
/// is read as a marked string instead, which `dumps` prints back as Python
/// would, so a file round-trips byte for byte.
pub fn loads(text: &str) -> Result<Value, String> {
    let (marked_text, any) = mark_numbers(text);
    if !any {
        return serde_json::from_str(text).map_err(|e| json_error(text, &e));
    }
    serde_json::from_str(&marked_text).map_err(|_| match serde_json::from_str::<Value>(text) {
        Err(e) => json_error(text, &e),
        Ok(_) => "Expecting value: line 1 column 1 (char 0)".to_string(),
    })
}

/// json.dumps (indent None or Some(n)), printing `loads`' marked numbers back
/// as their JSON text.
pub fn dumps(v: &Value, indent: Option<usize>) -> String {
    let text = crew_core::pyjson::dumps_with(v, crew_core::pyjson::Opts { indent, ..Default::default() });
    if !text.contains("\\u0000json:") {
        return text;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(i) = rest.find("\"\\u0000json:") {
        out.push_str(&rest[..i]);
        let after = &rest[i + "\"\\u0000json:".len()..];
        match after.find("\\u0000\"") {
            Some(j) => {
                out.push_str(&after[..j]);
                rest = &after[j + "\\u0000\"".len()..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_int_literal(tok: &str) -> bool {
    let digits = tok.strip_prefix('-').unwrap_or(tok);
    !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit())
}

/// An integer of any size as a JSON value: a plain number when it fits in 64
/// bits, else marked for `dumps` to print as digits.
pub fn big_int(digits: &str) -> Value {
    digits
        .parse::<i64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(format!("{MARK_OPEN}{digits}{MARK_CLOSE}")))
}

/// Rewrite every number token serde would lose, outside strings, as a marked
/// string. Returns the text and whether anything was marked.
fn mark_numbers(text: &str) -> (String, bool) {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut last, mut any) = (0, 0, false);
    while i < b.len() {
        match b[i] {
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
            }
            c if c == b'-' || c.is_ascii_digit() || c == b'N' || c == b'I' => {
                let start = i;
                let tok = if text[i..].starts_with("NaN") {
                    "NaN"
                } else if text[i..].starts_with("Infinity") {
                    "Infinity"
                } else if text[i..].starts_with("-Infinity") {
                    "-Infinity"
                } else {
                    let mut j = i + 1;
                    while j < b.len() && matches!(b[j], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-') {
                        j += 1;
                    }
                    &text[i..j]
                };
                i += tok.len().max(1);
                let keep = if matches!(tok, "NaN" | "Infinity" | "-Infinity") {
                    Some(tok.to_string())
                } else if is_int_literal(tok) {
                    (tok.parse::<i64>().is_err() && tok.parse::<u64>().is_err()).then(|| tok.to_string())
                } else {
                    // A float: one past f64's range is Python's inf.
                    match tok.parse::<f64>() {
                        Ok(f) if f.is_infinite() => Some(if f < 0.0 { "-Infinity" } else { "Infinity" }.to_string()),
                        _ => None,
                    }
                };
                if let Some(k) = keep {
                    out.push_str(&text[last..start]);
                    out.push('"');
                    out.push_str(&serde_json::to_string(&format!("{MARK_OPEN}{k}{MARK_CLOSE}")).unwrap()[1..]);
                    last = i;
                    any = true;
                }
            }
            _ => i += 1,
        }
    }
    out.push_str(&text[last..]);
    (out, any)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn str_and_truth() {
        assert_eq!(str_of(&json!(true)), "True");
        assert_eq!(str_of(&json!(1.0)), "1.0");
        assert_eq!(str_of(&json!(9)), "9");
        assert_eq!(str_of(&json!(["a", null, {"k": "it's"}])), "['a', None, {'k': \"it's\"}]");
        assert!(!truthy(&json!(0)) && !truthy(&json!("")) && truthy(&json!("0")));
        assert_eq!(str_or(Some(&json!(false)), "none"), "none");
    }

    #[test]
    fn floats_parse_as_python_does() {
        assert_eq!(parse_float("9.7"), Some(9.7));
        assert_eq!(parse_float("1_0"), Some(10.0));
        assert_eq!(parse_float("1__0"), None);
        assert_eq!(parse_float("_1"), None);
        assert_eq!(parse_float(".5"), Some(0.5));
        assert_eq!(parse_float("5."), Some(5.0));
        assert!(parse_float("-Infinity").unwrap().is_infinite());
        assert_eq!(parse_float("+-1"), None);
        assert_eq!(parse_float("None"), None);
        assert_eq!(parse_float("0x10"), None);
        assert_eq!(parse_float(""), None);
    }

    #[test]
    fn int_digits_are_exact() {
        assert_eq!(int_digits(9.99).as_deref(), Some("9"));
        assert_eq!(int_digits(-2.5).as_deref(), Some("-2"));
        assert_eq!(int_digits(1e16).as_deref(), Some("10000000000000000"));
        assert_eq!(int_digits(1e22).as_deref(), Some("10000000000000000000000"));
        assert_eq!(int_digits(2f64.powi(70)).as_deref(), Some("1180591620717411303424"));
        assert_eq!(int_digits(f64::INFINITY), None);
    }

    #[test]
    fn json_keeps_what_python_keeps() {
        let src = r#"{"big": 123456789012345678901234567890, "neg": -98765432109876543210, "n": NaN, "i": -Infinity, "f": 1e400, "s": "1e400 NaN", "ok": [1, 2.5, -3]}"#;
        let v = loads(src).unwrap();
        assert_eq!(
            dumps(&v, None),
            r#"{"big": 123456789012345678901234567890, "neg": -98765432109876543210, "n": NaN, "i": -Infinity, "f": Infinity, "s": "1e400 NaN", "ok": [1, 2.5, -3]}"#
        );
        assert_eq!(str_of(&v["big"]), "123456789012345678901234567890");
        assert_eq!(str_of(&v["f"]), "inf");
        assert_eq!(type_name(&v["n"]), "float");
        assert_eq!(type_name(&v["big"]), "int");
        assert!(loads("{bad").unwrap_err().starts_with("Expecting property name"));
    }

    #[test]
    fn repr_escapes_what_python_cannot_print() {
        assert_eq!(repr_str("a\u{a0}b\u{3000}\u{200b}é"), "'a\\xa0b\\u3000\\u200bé'");
    }

    #[test]
    fn unicode_digits_are_digits() {
        assert_eq!(parse_float("\u{663}"), Some(3.0));
        assert_eq!(parse_float("\u{ff11}\u{ff12}"), Some(12.0));
        assert_eq!(parse_float("\u{b2}"), None); // superscript two is not Nd
    }

    #[test]
    fn strip_takes_python_whitespace() {
        assert_eq!(strip("\x1c a \u{3000}"), "a");
    }
}
