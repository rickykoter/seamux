//! Python's value and string rules, for ports that read JSON written by
//! someone else and must decide exactly as the Python did.

use crew_core::pyjson;
use serde_json::Value;

/// `bool(v)`.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// `str(v)` for a JSON value in an f-string.
pub fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Null => "None".into(),
        Value::Number(n) if n.is_f64() => pyjson::float_repr(n.as_f64().unwrap_or(0.0)),
        Value::Number(n) => n.to_string(),
        other => py_repr(other),
    }
}

/// `repr(v)` for a JSON value as Python holds it: lists and dicts in Python's
/// own spelling (single-quoted strings, True/False/None).
pub fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, x)| format!("{}: {}", repr_str(k), py_repr(x))).collect::<Vec<_>>().join(", ")),
        other => py_str(other),
    }
}

/// `repr(str)`: single quotes unless the text holds one and no double quote;
/// backslash, the quote, \n \r \t and other control characters escaped.
fn repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(q);
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
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if (0x80..0xa0).contains(&(c as u32)) => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// `str.isspace` for one character.
pub fn py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// `str.strip()`.
pub fn py_strip(s: &str) -> &str {
    s.trim_matches(py_space)
}

/// Text mode's universal newlines: CRLF and a lone CR read as LF.
pub fn universal(text: String) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text
    }
}

/// `open(path).read()`: None on an OSError or bytes that are not UTF-8 (both
/// land in the Python's `except Exception`), newlines translated.
pub fn read_text(path: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok().map(universal)
}

/// `json.load(open(path))`, None on any failure.
pub fn read_json(path: &str) -> Option<Value> {
    serde_json::from_str(&read_text(path)?).ok()
}

/// `int(s)` for a decimal string, or None where Python raises ValueError.
pub fn py_int(s: &str) -> Option<i128> {
    let s = py_strip(s);
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let b = digits.as_bytes();
    if b.is_empty() || !b[0].is_ascii_digit() || !b[b.len() - 1].is_ascii_digit() || digits.contains("__") {
        return None;
    }
    if !b.iter().all(|c| c.is_ascii_digit() || *c == b'_') {
        return None;
    }
    let v: i128 = digits.replace('_', "").parse().ok()?;
    Some(if neg { -v } else { v })
}

/// `s[:n]`, by code points.
pub fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn str_of_containers_is_their_python_repr() {
        let v: Value = serde_json::from_str(r#"{"command": "ls 'x'", "n": [1, 2.5, true, null], "s": "a\nb"}"#).unwrap();
        // python3 -c 'print(str({"command": "ls \'x\'", "n": [1, 2.5, True, None], "s": "a\nb"}))'
        assert_eq!(py_str(&v), r#"{'command': "ls 'x'", 'n': [1, 2.5, True, None], 's': 'a\nb'}"#);
        assert_eq!(py_str(&serde_json::json!(["a", {}])), "['a', {}]");
    }

    #[test]
    fn py_int_takes_what_python_takes() {
        assert_eq!(py_int(" 12 "), Some(12));
        assert_eq!(py_int("1_000"), Some(1000));
        assert_eq!(py_int("-3"), Some(-3));
        assert_eq!(py_int("1__0"), None);
        assert_eq!(py_int("_1"), None);
        assert_eq!(py_int("1e3"), None);
        assert_eq!(py_int(""), None);
    }
}
