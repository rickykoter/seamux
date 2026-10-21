//! Python's `json.dumps(v)` with its defaults: `", "` and `": "` separators,
//! non-ASCII escaped as `\uXXXX`, keys in insertion order. The crew Python
//! passes `json.dumps(params)` to `cmux rpc`, and fakecmux logs that argv, so
//! the Rust has to print the same bytes. crew-core carries the full writer
//! (indent and compact variants) for the ports; this is the one form cmux needs.

use serde_json::Value;

pub(crate) fn dumps(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                string(k, out);
                out.push_str(": ");
                write(x, out);
            }
            out.push('}');
        }
    }
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
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_python_defaults() {
        // python3 -c 'import json; print(json.dumps({"title":"crew","n":[1,2],"s":"a·b\n"}))'
        let v = json!({"title": "crew", "n": [1, 2], "s": "a\u{b7}b\n"});
        assert_eq!(dumps(&v), "{\"title\": \"crew\", \"n\": [1, 2], \"s\": \"a\\u00b7b\\n\"}");
    }

    #[test]
    fn astral_chars_are_surrogate_pairs() {
        assert_eq!(dumps(&json!("\u{1F600}")), "\"\\ud83d\\ude00\"");
    }

    #[test]
    fn delete_is_escaped_like_python() {
        // json.dumps("\x7f") == '"\\u007f"'
        assert_eq!(dumps(&json!("\u{7f}")), r#""\u007f""#);
    }
}
