//! How the board's Python reads a JSON value, so the Rust reads it the same:
//! truthiness (`x or ""`), `str(x)` and `float(x)`. Rows and fixtures arrive
//! loosely typed, and the Python never checked a type it could coerce.

use serde_json::Value;

use crew_core::pyjson;

/// Python's `bool(x)` for a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(true, |f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `r.get(k)` with a missing key read as None.
pub fn get<'a>(r: &'a Value, k: &str) -> &'a Value {
    r.get(k).unwrap_or(&Value::Null)
}

/// `str(x or "")`: "" for anything falsy, else Python's str() of the value.
pub fn str_or_empty(v: &Value) -> String {
    if !truthy(v) {
        return String::new();
    }
    py_str(v)
}

/// Python's `str(x)` for a JSON value (repr-like for containers, which no
/// board field holds in practice).
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => pyjson::float_repr(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => s.clone(),
        other => pyjson::dumps(other),
    }
}

/// Python's `float(x)`, or None where it raises (None, a container, a string
/// that is not a number).
pub fn py_float(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_float(s),
        _ => None,
    }
}

/// `float(s)` on a string: surrounding whitespace, `inf`/`nan` in any case,
/// and `_` between digits, as Python accepts them.
pub fn parse_float(s: &str) -> Option<f64> {
    let t = s.trim();
    let lower = t.to_ascii_lowercase();
    let (sign, body) = match lower.strip_prefix('-') {
        Some(b) => (-1.0, b),
        None => (1.0, lower.strip_prefix('+').unwrap_or(&lower)),
    };
    match body {
        "inf" | "infinity" => return Some(sign * f64::INFINITY),
        "nan" => return Some(f64::NAN),
        _ => {}
    }
    if t.contains("__") || t.starts_with('_') || t.ends_with('_') {
        return None;
    }
    let cleaned: String = t.chars().filter(|c| *c != '_').collect();
    if cleaned.is_empty() || cleaned.chars().any(|c| c.is_alphabetic() && !matches!(c, 'e' | 'E')) {
        return None;
    }
    cleaned.parse::<f64>().ok()
}

/// Python's `int(x)` for the CLI's size argument: a decimal integer string
/// (whitespace and `_` allowed), or None where it raises.
pub fn parse_int(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() || t.contains("__") || t.starts_with('_') || t.ends_with('_') {
        return None;
    }
    t.chars().filter(|c| *c != '_').collect::<String>().parse::<i64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_parse_as_python_does() {
        assert_eq!(parse_float(" 0.5 "), Some(0.5));
        assert_eq!(parse_float("1_000"), Some(1000.0));
        assert_eq!(parse_float("1e3"), Some(1000.0));
        assert!(parse_float("-Infinity").unwrap().is_infinite());
        assert_eq!(parse_float("abc"), None);
        assert_eq!(parse_float(""), None);
        assert_eq!(py_float(&json!(null)), None);
        assert_eq!(py_float(&json!(true)), Some(1.0));
    }

    #[test]
    fn str_is_pythons() {
        assert_eq!(str_or_empty(&json!(null)), "");
        assert_eq!(str_or_empty(&json!(0)), "");
        assert_eq!(py_str(&json!(5)), "5");
        assert_eq!(py_str(&json!(5.0)), "5.0");
        assert_eq!(py_str(&json!(true)), "True");
    }

    #[test]
    fn ints_parse_as_python_does() {
        assert_eq!(parse_int(" 111 "), Some(111));
        assert_eq!(parse_int("1_0"), Some(10));
        assert_eq!(parse_int("1.5"), None);
    }
}
