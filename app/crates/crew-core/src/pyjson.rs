//! Python's `json.dumps`, byte for byte, for every crew tool that prints or
//! writes JSON a Python reader (or a probe comparing bytes) will see.
//!
//! The defaults are Python's: `", "` and `": "` separators, everything outside
//! printable ASCII escaped as `\uXXXX`, keys in insertion order (serde_json's
//! `preserve_order`), floats as Python's `repr`. `indent` switches to
//! `","` item separators and one member per line, as Python does.

use serde_json::{Number, Value};

/// How to print, mirroring json.dumps' keyword arguments.
#[derive(Debug, Clone, Copy, Default)]
pub struct Opts {
    pub indent: Option<usize>,
    pub sort_keys: bool,
    /// separators=(",", ":"), Python's most compact form.
    pub compact: bool,
}

/// `json.dumps(v)`.
pub fn dumps(v: &Value) -> String {
    dumps_with(v, Opts::default())
}

/// `json.dumps(v, indent=n)`.
pub fn dumps_indent(v: &Value, n: usize) -> String {
    dumps_with(v, Opts { indent: Some(n), ..Opts::default() })
}

pub fn dumps_with(v: &Value, o: Opts) -> String {
    let mut out = String::new();
    write(v, o, 0, &mut out);
    out
}

/// A Python float as a JSON value (NaN and infinities, which Python would
/// print as bare NaN/Infinity, become null).
pub fn float(f: f64) -> Value {
    Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

fn write(v: &Value, o: Opts, depth: usize, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => number(n, out),
        Value::String(s) => string(s, out),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep(o));
                }
                newline(o, depth + 1, out);
                write(x, o, depth + 1, out);
            }
            newline(o, depth, out);
            out.push(']');
        }
        Value::Object(m) => {
            if m.is_empty() {
                out.push_str("{}");
                return;
            }
            let mut keys: Vec<&String> = m.keys().collect();
            if o.sort_keys {
                keys.sort();
            }
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep(o));
                }
                newline(o, depth + 1, out);
                string(k, out);
                out.push_str(if o.compact { ":" } else { ": " });
                write(&m[*k], o, depth + 1, out);
            }
            newline(o, depth, out);
            out.push('}');
        }
    }
}

fn item_sep(o: Opts) -> &'static str {
    if o.compact || o.indent.is_some() {
        ","
    } else {
        ", "
    }
}

fn newline(o: Opts, depth: usize, out: &mut String) {
    if let Some(n) = o.indent {
        out.push('\n');
        for _ in 0..n * depth {
            out.push(' ');
        }
    }
}

fn number(n: &Number, out: &mut String) {
    if n.is_f64() {
        out.push_str(&float_repr(n.as_f64().unwrap_or(0.0)));
    } else {
        out.push_str(&n.to_string());
    }
}

/// Python's `repr(float)`: the shortest digits that round-trip, positional
/// when the exponent is in [-4, 16), else `d.ddde±XX`; integral values keep
/// a trailing `.0`.
pub fn float_repr(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    // Rust's {:e} is the shortest round-trip form, as Python's repr is.
    let e = format!("{:e}", f);
    let (mant, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let neg = mant.starts_with('-');
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    if (-4..16).contains(&exp) {
        let point = exp + 1; // digits before the decimal point
        if point <= 0 {
            s.push_str("0.");
            for _ in 0..-point {
                s.push('0');
            }
            s.push_str(&digits);
        } else if point as usize >= digits.len() {
            s.push_str(&digits);
            for _ in 0..(point as usize - digits.len()) {
                s.push('0');
            }
            s.push_str(".0");
        } else {
            s.push_str(&digits[..point as usize]);
            s.push('.');
            s.push_str(&digits[point as usize..]);
        }
    } else {
        s.push_str(&digits[..1]);
        if digits.len() > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        s.push('e');
        s.push(if exp < 0 { '-' } else { '+' });
        s.push_str(&format!("{:02}", exp.abs()));
    }
    s
}

fn string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (' '..='~').contains(&c) => out.push(c),
            c => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Expected strings below are what python3 prints for the same value.
    #[test]
    fn float_repr_matches_python() {
        let cases = [
            (1.5, "1.5"), (0.0, "0.0"), (3.0, "3.0"), (0.1, "0.1"), (1e-05, "1e-05"),
            (0.0001, "0.0001"), (1e16, "1e+16"), (1e15, "1000000000000000.0"),
            (1.5e16, "1.5e+16"), (3.5000000000000004, "3.5000000000000004"),
            (1792582420.678, "1792582420.678"), (-2.5e-07, "-2.5e-07"), (123456.789, "123456.789"),
        ];
        for (f, want) in cases {
            assert_eq!(float_repr(f), want, "{f}");
        }
    }

    #[test]
    fn default_dumps() {
        let v = json!({"a": [1, 2.0, "x\u{b7}"], "b": {}, "c": [], "d": null});
        assert_eq!(dumps(&v), "{\"a\": [1, 2.0, \"x\\u00b7\"], \"b\": {}, \"c\": [], \"d\": null}");
    }

    #[test]
    fn indent_and_sort_keys() {
        // json.dumps({"b": 1, "a": {"y": [1, 2], "x": {}}}, sort_keys=True, indent=1)
        let v = json!({"b": 1, "a": {"y": [1, 2], "x": {}}});
        let want = "{\n \"a\": {\n  \"x\": {},\n  \"y\": [\n   1,\n   2\n  ]\n },\n \"b\": 1\n}";
        assert_eq!(dumps_with(&v, Opts { indent: Some(1), sort_keys: true, compact: false }), want);
    }

    #[test]
    fn compact() {
        let v = json!([{"title": "a", "state": "done"}]);
        assert_eq!(dumps_with(&v, Opts { compact: true, ..Opts::default() }), r#"[{"title":"a","state":"done"}]"#);
    }
}
