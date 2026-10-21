//! `crew-overlay <overlay.json> [display-name]`: merge a machine-local overlay
//! into a rendered crew config. JSONC on stdin, strict JSON (indent 2) out.
//!
//! `controls` lists merge by `id` (base order first, new ids appended); every
//! other list replaces wholesale; dicts merge key by key; anything else takes
//! the overlay. Comments are stripped character by character, never by a
//! regex, because the configs hold "https://" inside strings.

use std::io::Read;
use std::path::Path;

use crew_core::pyjson;
use serde_json::{Map, Value};

use crate::pyerr;

const USAGE: &str = "usage: crew-overlay <overlay.json> [display-name]  (template on stdin)";

pub fn main(args: &[String]) -> i32 {
    if !(1..=2).contains(&args.len()) {
        eprintln!("{USAGE}");
        return 2;
    }
    // crew passes the overlay through a process substitution (a /dev/fd path),
    // so the second argument names the file to blame in an error.
    let shown = args.get(1).unwrap_or(&args[0]);
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    let template = match String::from_utf8(raw) {
        Ok(t) => t,
        Err(e) => {
            let msg = pyerr::decode_error(&e.utf8_error(), e.as_bytes());
            return pyerr::crash(&format!("UnicodeDecodeError: {msg}"));
        }
    };
    let base = match parse(&template) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("crew-overlay: the rendered template is not valid JSONC: {e}");
            return 1;
        }
    };
    // Never ship an unmerged config silently: a typo in the overlay would look
    // exactly like "my overlay is being ignored".
    let over = match read_overlay(&args[0]) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("crew-overlay: cannot read overlay {shown}: {e}");
            return 1;
        }
    };
    match merge(base, over) {
        Ok(v) => {
            println!("{}", pyjson::dumps_indent(&v, 2));
            0
        }
        Err(m) => pyerr::crash(&m),
    }
}

fn read_overlay(path: &str) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| pyerr::os_error(&e, Path::new(path)))?;
    let text = String::from_utf8(bytes).map_err(|e| pyerr::decode_error(&e.utf8_error(), e.as_bytes()))?;
    parse(&text)
}

fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(&strip_jsonc(text)).map_err(|e| e.to_string())
}

/// Drop `//` and `/* */` comments that are not inside a string.
pub fn strip_jsonc(t: &str) -> String {
    let c: Vec<char> = t.chars().collect();
    let n = c.len();
    let mut out = String::with_capacity(t.len());
    let (mut i, mut in_str, mut esc) = (0, false, false);
    while i < n {
        let ch = c[i];
        if in_str {
            out.push(ch);
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if ch == '"' {
            in_str = true;
            out.push(ch);
            i += 1;
            continue;
        }
        if ch == '/' && i + 1 < n && c[i + 1] == '/' {
            while i < n && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if ch == '/' && i + 1 < n && c[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(c[i] == '*' && c[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// A control's `id` as a Python dict key: 1, 1.0 and true are one key, and
/// ints compare exactly (2**53 + 1 is not 2**53).
enum Id {
    Null,
    Int(i128),
    Float(f64),
    Str(String),
}

impl PartialEq for Id {
    fn eq(&self, other: &Id) -> bool {
        // An int equals a float only when the float is that exact integer.
        let int_float = |i: i128, f: f64| f.fract() == 0.0 && f.abs() < 1.7e38 && f as i128 == i;
        match (self, other) {
            (Id::Null, Id::Null) => true,
            (Id::Int(a), Id::Int(b)) => a == b,
            (Id::Float(a), Id::Float(b)) => a == b,
            (Id::Int(i), Id::Float(f)) | (Id::Float(f), Id::Int(i)) => int_float(*i, *f),
            (Id::Str(a), Id::Str(b)) => a == b,
            _ => false,
        }
    }
}

fn id_of(c: &Value) -> Result<Option<Id>, String> {
    let Value::Object(o) = c else { return Ok(None) };
    match o.get("id") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Id::Null)),
        Some(Value::Bool(b)) => Ok(Some(Id::Int(*b as i128))),
        Some(Value::Number(n)) => Ok(Some(match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => Id::Int(i as i128),
            (_, Some(u)) => Id::Int(u as i128),
            _ => Id::Float(n.as_f64().unwrap_or(f64::NAN)),
        })),
        Some(Value::String(s)) => Ok(Some(Id::Str(s.clone()))),
        Some(Value::Array(_)) => Err("TypeError: unhashable type: 'list'".into()),
        Some(Value::Object(_)) => Err("TypeError: unhashable type: 'dict'".into()),
    }
}

/// Merge two control lists by `id`: base order first, extras appended.
/// Entries that are not objects with an `id` drop out, as in the Python.
fn merge_controls(base: &[Value], over: &[Value]) -> Result<Vec<Value>, String> {
    let mut by_id: Vec<(Id, Map<String, Value>)> = Vec::new();
    let mut order: Vec<usize> = Vec::new();
    let slot = |by_id: &Vec<(Id, Map<String, Value>)>, id: &Id| by_id.iter().position(|(k, _)| k == id);
    for c in base {
        if let Some(id) = id_of(c)? {
            let m = c.as_object().cloned().unwrap_or_default();
            let at = match slot(&by_id, &id) {
                Some(at) => {
                    by_id[at].1 = m;
                    at
                }
                None => {
                    by_id.push((id, m));
                    by_id.len() - 1
                }
            };
            order.push(at);
        }
    }
    for c in over {
        let Some(id) = id_of(c)? else { continue };
        let m = c.as_object().cloned().unwrap_or_default();
        match slot(&by_id, &id) {
            Some(at) => by_id[at].1.extend(m),
            None => {
                by_id.push((id, m));
                order.push(by_id.len() - 1);
            }
        }
    }
    Ok(order.into_iter().map(|at| Value::Object(by_id[at].1.clone())).collect())
}

pub fn merge(base: Value, over: Value) -> Result<Value, String> {
    match (base, over) {
        (Value::Object(mut out), Value::Object(over)) => {
            for (k, v) in over {
                let merged = match (k.as_str(), out.get(&k), &v) {
                    ("controls", Some(Value::Array(b)), Value::Array(o)) => Value::Array(merge_controls(b, o)?),
                    (_, Some(b), _) => merge(b.clone(), v)?,
                    _ => v,
                };
                out.insert(k, merged);
            }
            Ok(Value::Object(out))
        }
        // scalars and lists replace; dict-vs-scalar mismatches take the overlay
        (_, over) => Ok(over),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_comments_but_not_urls_in_strings() {
        let t = "{\n // a comment\n \"u\": \"https://x/*y*/\", /* block */ \"q\": \"a\\\"//b\"\n}";
        let v: Value = serde_json::from_str(&strip_jsonc(t)).unwrap();
        assert_eq!(v, json!({"u": "https://x/*y*/", "q": "a\"//b"}));
    }

    #[test]
    fn controls_merge_by_id_and_drop_idless_entries() {
        let base = json!({"controls": [{"id": "a", "x": 1}, "junk", {"id": "b"}], "list": [1, 2], "d": {"k": 1, "j": 2}});
        let over = json!({"controls": [{"id": "b", "y": 2}, {"id": "c"}], "list": [3], "d": {"j": 3, "n": 4}, "new": true});
        let out = merge(base, over).unwrap();
        assert_eq!(
            pyjson::dumps(&out),
            r#"{"controls": [{"id": "a", "x": 1}, {"id": "b", "y": 2}, {"id": "c"}], "list": [3], "d": {"k": 1, "j": 3, "n": 4}, "new": true}"#
        );
    }

    #[test]
    fn numeric_ids_are_one_key_as_in_python() {
        let out = merge_controls(&[json!({"id": 1, "a": 1})], &[json!({"id": 1.0, "b": 2}), json!({"id": true, "c": 3})]).unwrap();
        assert_eq!(out, vec![json!({"id": true, "a": 1, "b": 2, "c": 3})]);
    }

    #[test]
    fn big_int_ids_stay_apart_as_in_python() {
        let out = merge_controls(&[json!({"id": 9007199254740993u64})], &[json!({"id": 9007199254740992u64})]).unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn a_duplicate_base_id_appears_twice_with_the_last_body() {
        let out = merge_controls(&[json!({"id": "a", "v": 1}), json!({"id": "a", "v": 2})], &[]).unwrap();
        assert_eq!(out, vec![json!({"id": "a", "v": 2}), json!({"id": "a", "v": 2})]);
    }

    #[test]
    fn an_unhashable_id_raises() {
        assert!(merge_controls(&[json!({"id": [1]})], &[]).is_err());
    }
}
