//! deep-plan families on the board: members sit together, ordered as one
//! (crew/board/families.py).
//!
//! Every member of a family moves as one unit, placed where its most urgent
//! member would sort; inside it the parent leads, then the children by tier.
//! A quiet member joins its family; an all-quiet family stays in the quiet
//! list, grouped. A family whose parent has no row gets a `famlabel`. With no
//! family on the board, both lists come back untouched.
//!
//!   seamux families < {"rows": [...], "quiet": [...]}   -> the same, grouped

use std::cmp::Ordering;
use std::io::Read;

use serde_json::{json, Value};

use crate::pyjson;

const TIERS: [&str; 5] = ["attend", "wilt", "running", "done", "quiet"];
const QUIET: i64 = 4;

fn tier(r: &Value) -> i64 {
    let k = r.get("kind").and_then(Value::as_str).unwrap_or("");
    TIERS.iter().position(|t| *t == k).map(|i| i as i64).unwrap_or(9)
}

fn urgency(r: &Value) -> f64 {
    match r.get("urgency") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) if !s.is_empty() => s.trim().parse().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

fn family(r: &Value) -> Option<String> {
    match r.get("family") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// A row's own sort key, as rank() orders it: tier, then urgency, then gather order.
#[derive(Clone, Copy, PartialEq)]
struct Key(i64, f64, usize);

impl Key {
    fn cmp(&self, o: &Key) -> Ordering {
        self.0
            .cmp(&o.0)
            .then(o.1.partial_cmp(&self.1).unwrap_or(Ordering::Equal))
            .then(self.2.cmp(&o.2))
    }
}

pub fn group(rows: Vec<Value>, quiet: Vec<Value>) -> (Vec<Value>, Vec<Value>) {
    let n_rows = rows.len();
    let mut all: Vec<Value> = rows.into_iter().chain(quiet).collect();
    if !all.iter().any(|r| family(r).is_some()) {
        let quiet = all.split_off(n_rows);
        return (all, quiet);
    }
    let own = |i: usize, r: &Value| Key(tier(r), urgency(r), i);

    // Families in order of first appearance, members in gather order.
    let mut fams: Vec<(String, Vec<usize>)> = Vec::new();
    for (i, r) in all.iter().enumerate() {
        if let Some(f) = family(r) {
            match fams.iter_mut().find(|(n, _)| *n == f) {
                Some((_, m)) => m.push(i),
                None => fams.push((f, vec![i])),
            }
        }
    }

    let mut units: Vec<(Key, Vec<usize>)> = Vec::new();
    for i in 0..n_rows {
        if family(&all[i]).is_none() {
            units.push((own(i, &all[i]), vec![i]));
        }
    }
    for (fam, members) in &fams {
        let lead = members.iter().map(|&i| own(i, &all[i])).min_by(|a, b| a.cmp(b)).unwrap();
        let mut ordered = members.clone();
        ordered.sort_by(|&a, &b| {
            let pa = all[a].get("famrole").and_then(Value::as_str) != Some("parent");
            let pb = all[b].get("famrole").and_then(Value::as_str) != Some("parent");
            pa.cmp(&pb).then(own(a, &all[a]).cmp(&own(b, &all[b])))
        });
        let famtier = TIERS.get(lead.0 as usize).copied().unwrap_or("quiet");
        for &i in &ordered {
            let kid = all[i].get("famrole").and_then(Value::as_str) == Some("child");
            if let Some(o) = all[i].as_object_mut() {
                o.insert("famtier".into(), json!(famtier));
                o.insert("famkid".into(), json!(kid));
            }
        }
        let first = ordered[0];
        if all[first].get("famrole").and_then(Value::as_str) != Some("parent") {
            if let Some(o) = all[first].as_object_mut() {
                o.insert("famlabel".into(), json!(fam));
            }
        }
        units.push((lead, ordered));
    }
    for i in n_rows..all.len() {
        if family(&all[i]).is_none() {
            units.push((own(i, &all[i]), vec![i]));
        }
    }

    units.sort_by(|a, b| a.0.cmp(&b.0));
    let (mut out_rows, mut out_quiet) = (Vec::new(), Vec::new());
    for (key, members) in units {
        for i in members {
            let r = std::mem::take(&mut all[i]);
            if key.0 == QUIET {
                out_quiet.push(r);
            } else {
                out_rows.push(r);
            }
        }
    }
    (out_rows, out_quiet)
}

pub fn main(_args: &[String]) -> i32 {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    let data: Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("families: {e}");
            return 1;
        }
    };
    let list = |k: &str| data.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let (r, q) = group(list("rows"), list("quiet"));
    print!("{}", pyjson::dumps(&json!({"rows": r, "quiet": q})));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_family_is_untouched() {
        let rows = vec![json!({"kind": "done"}), json!({"kind": "attend"})];
        let (r, q) = group(rows.clone(), vec![]);
        assert_eq!(r, rows);
        assert!(q.is_empty());
    }

    #[test]
    fn a_child_pulls_its_family_up() {
        let rows = vec![
            json!({"id": "a", "kind": "attend"}),
            json!({"id": "p", "kind": "done", "family": "f", "famrole": "parent"}),
            json!({"id": "c", "kind": "attend", "urgency": 3, "family": "f", "famrole": "child"}),
        ];
        let quiet = vec![json!({"id": "c2", "kind": "quiet", "family": "f", "famrole": "child"})];
        let (r, q) = group(rows, quiet);
        let ids: Vec<&str> = r.iter().map(|x| x["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["p", "c", "c2", "a"]);
        assert!(q.is_empty());
        assert_eq!(r[0]["famtier"], "attend");
        assert_eq!(r[1]["famkid"], true);
    }

    #[test]
    fn a_family_without_its_parent_gets_a_label() {
        let rows = vec![json!({"id": "c", "kind": "running", "family": "f", "famrole": "child"})];
        let (r, _) = group(rows, vec![]);
        assert_eq!(r[0]["famlabel"], "f");
    }
}
