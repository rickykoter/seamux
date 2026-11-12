//! A worktree's pull requests, as crew-sync last read them (plan
//! dock-many-prs): the PRs its sessions made plus its branch's PR, each with
//! its state and check buckets from `lookout gh prs`. crew-sync writes the
//! file; the board's rows and the app's Wake read it through here, so the
//! file has one shape on cmux and tmux alike.
//!
//!   $XDG_CACHE_HOME/cmux-crew/prs-<md5 of the worktree>.json
//!   { "at": <epoch s>, "prs": [ { n, url, title, state, review, conflict,
//!     checks: { fail, run, pass, gate, unseen } | null, failing, gating, … } ] }
//!
//! `state` is open, draft, merged or closed; a merged or closed PR has no
//! checks. `failing` and `gating` are [{ name, url }].

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::home::xdg_cache;
use crate::md5;

/// The list file for worktree `cwd` ($CREW_PRS_DIR, for a test, else the
/// crew cache). Named by the resolved path, trailing slash trimmed, so
/// crew-sync, the board and the Wake (which holds the store's realpath'd
/// key) name one file however each spells the worktree.
pub fn path(cwd: &str) -> PathBuf {
    let dir = crate::py::env_or("CREW_PRS_DIR").filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(xdg_cache);
    dir.join(format!("prs-{}.json", md5::hex(key(cwd).as_bytes())))
}

/// `cwd` resolved (symlinks, /var vs /private/var), trailing slash trimmed;
/// as given when it does not exist.
pub fn key(cwd: &str) -> String {
    let real = std::fs::canonicalize(cwd).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| cwd.to_string());
    let t = real.trim_end_matches('/');
    if t.is_empty() { "/".into() } else { t.to_string() }
}

/// The file as written, or None when there is none (or it does not parse).
pub fn read(cwd: &str) -> Option<Value> {
    let text = std::fs::read_to_string(path(cwd)).ok()?;
    serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
}

/// The worktree's PRs, newest made first; empty without a file.
pub fn list(cwd: &str) -> Vec<Value> {
    read(cwd).and_then(|v| v.get("prs").and_then(Value::as_array).cloned()).unwrap_or_default()
}

fn s<'a>(pr: &'a Value, k: &str) -> &'a str {
    pr.get(k).and_then(Value::as_str).unwrap_or("")
}

/// One bucket's count on a PR, 0 for a done PR or a missing bucket.
pub fn count(pr: &Value, bucket: &str) -> u64 {
    pr.get("checks").and_then(|c| c.get(bucket)).and_then(Value::as_u64).unwrap_or(0)
}

/// The PR's number, 0 when it has none.
pub fn number(pr: &Value) -> u64 {
    pr.get("n").and_then(Value::as_u64).unwrap_or(0)
}

/// Where the Wake files a PR: "you" (an open PR that is red, has changes
/// asked or conflicts), "people" (waiting on a gate or a required review),
/// "draft", "open", or "done" (merged or closed). A red draft stays a draft:
/// its bar shows the red.
pub fn group(pr: &Value) -> &'static str {
    let state = s(pr, "state");
    if state == "merged" || state == "closed" {
        return "done";
    }
    let draft = state == "draft";
    let red = count(pr, "fail") > 0;
    let conflict = pr.get("conflict").and_then(Value::as_bool).unwrap_or(false);
    if !draft && (red || conflict || s(pr, "review") == "CHANGES_REQUESTED") {
        return "you";
    }
    if draft && red {
        return "draft";
    }
    // A draft is always waiting on review: only a gate check says people.
    if count(pr, "gate") > 0 || (!draft && s(pr, "review") == "REVIEW_REQUIRED") {
        return "people";
    }
    if draft { "draft" } else { "open" }
}

/// The worst of a PR's checks: "fail", "run", "pass", or "" with none.
pub fn worst(pr: &Value) -> &'static str {
    if count(pr, "fail") > 0 {
        "fail"
    } else if count(pr, "run") > 0 {
        "run"
    } else if count(pr, "pass") > 0 || count(pr, "gate") > 0 {
        "pass"
    } else {
        ""
    }
}

/// One state's tally for the Dock: how many, their numbers, how many are
/// red, and the worst CI among them.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Tally {
    pub n: usize,
    pub nums: Vec<u64>,
    pub fail: usize,
    pub worst: &'static str,
}

impl Tally {
    fn add(&mut self, pr: &Value) {
        self.n += 1;
        self.nums.push(number(pr));
        if count(pr, "fail") > 0 {
            self.fail += 1;
        }
        let w = worst(pr);
        let rank = |w: &str| ["", "pass", "run", "fail"].iter().position(|x| *x == w).unwrap_or(0);
        if rank(w) > rank(self.worst) {
            self.worst = w;
        }
    }

    fn to_json(&self) -> Value {
        json!({"n": self.n, "nums": self.nums, "fail": self.fail, "worst": self.worst})
    }
}

/// A worktree's PRs summed up for its Dock row.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Summary {
    pub open: Tally,
    pub draft: Tally,
    /// Open or draft PRs waiting on people (the "people" group).
    pub people: Tally,
    pub merged: Tally,
    pub closed: Tally,
    /// Open or draft PRs with a failing check, by number: they wilt the row.
    pub failing: Vec<u64>,
}

impl Summary {
    pub fn of(prs: &[Value]) -> Summary {
        let mut out = Summary::default();
        for pr in prs {
            match s(pr, "state") {
                "merged" => out.merged.add(pr),
                "closed" => out.closed.add(pr),
                st => {
                    if st == "draft" { out.draft.add(pr) } else { out.open.add(pr) }
                    if group(pr) == "people" {
                        out.people.add(pr);
                    }
                    if count(pr, "fail") > 0 {
                        out.failing.push(number(pr));
                    }
                }
            }
        }
        out
    }

    /// Whether PR `n` is in the list, in any state.
    pub fn has(&self, n: u64) -> bool {
        [&self.open, &self.draft, &self.merged, &self.closed].iter().any(|t| t.nums.contains(&n))
    }

    /// Open and draft PRs.
    pub fn live(&self) -> usize {
        self.open.n + self.draft.n
    }

    /// Whether the row shows pills: two or more live PRs, or any done one.
    /// Otherwise it keeps its one PR chip, as before.
    pub fn pills(&self) -> bool {
        self.live() >= 2 || self.merged.n + self.closed.n > 0
    }

    pub fn to_json(&self) -> Value {
        json!({
            "open": self.open.to_json(), "draft": self.draft.to_json(), "people": self.people.to_json(),
            "merged": self.merged.to_json(), "closed": self.closed.to_json(),
            "failing": self.failing, "pills": self.pills(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(n: u64, state: &str, review: &str, c: Option<[u64; 4]>) -> Value {
        json!({"n": n, "state": state, "review": review, "conflict": false,
               "checks": c.map(|[f, r, p, g]| json!({"fail": f, "run": r, "pass": p, "gate": g, "unseen": 0}))})
    }

    #[test]
    fn groups_follow_the_plan() {
        assert_eq!(group(&pr(1, "open", "", Some([1, 0, 3, 0]))), "you");
        assert_eq!(group(&pr(2, "open", "CHANGES_REQUESTED", Some([0, 0, 3, 0]))), "you");
        assert_eq!(group(&pr(3, "open", "", Some([0, 0, 3, 1]))), "people");
        assert_eq!(group(&pr(4, "open", "REVIEW_REQUIRED", Some([0, 0, 3, 0]))), "people");
        assert_eq!(group(&pr(5, "draft", "REVIEW_REQUIRED", Some([0, 1, 3, 0]))), "draft", "a draft waits on review anyway");
        assert_eq!(group(&pr(6, "draft", "", Some([2, 0, 0, 0]))), "draft", "a red draft stays a draft");
        assert_eq!(group(&pr(7, "draft", "", Some([0, 0, 1, 1]))), "people", "a draft's gate check is people");
        assert_eq!(group(&pr(8, "open", "APPROVED", Some([0, 0, 3, 0]))), "open");
        assert_eq!(group(&pr(9, "merged", "", None)), "done");
        let mut c = pr(10, "open", "", Some([0, 0, 1, 0]));
        c["conflict"] = json!(true);
        assert_eq!(group(&c), "you");
    }

    #[test]
    fn the_summary_counts_states_and_red() {
        let prs = vec![
            pr(1, "open", "", Some([1, 0, 3, 0])),
            pr(2, "open", "", Some([0, 0, 3, 1])),
            pr(3, "open", "APPROVED", Some([0, 0, 3, 0])),
            pr(4, "draft", "", Some([0, 2, 1, 0])),
            pr(5, "draft", "", Some([1, 0, 0, 0])),
            pr(6, "merged", "", None),
            pr(7, "closed", "", None),
        ];
        let s = Summary::of(&prs);
        assert_eq!((s.open.n, s.open.fail, s.open.worst), (3, 1, "fail"));
        assert_eq!((s.draft.n, s.draft.fail, s.draft.worst), (2, 1, "fail"));
        assert_eq!(s.people.nums, vec![2]);
        assert_eq!((s.merged.n, s.closed.n), (1, 1));
        assert_eq!(s.failing, vec![1, 5]);
        assert!(s.pills());
        let one = Summary::of(&prs[..1]);
        assert!(!one.pills(), "one live PR and none done keeps today's chip");
        assert_eq!(Summary::of(&[]).to_json()["pills"], json!(false));
    }
}
