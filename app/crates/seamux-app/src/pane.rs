//! What a native pane's links lead to: file paths found in its text (resolved
//! against the pane's folder), editor URLs for them, and GitHub pull requests
//! and issues as hover cards. Pure functions; pane_app.rs runs the commands.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// `cand` as an existing path: absolute, `~/`-led, or relative to `cwd`.
/// None when nothing is there.
pub fn resolve(cwd: &Path, home: &Path, cand: &str) -> Option<PathBuf> {
    if cand.is_empty() || cand.len() > 1024 || cand.contains('\0') {
        return None;
    }
    let p = if let Some(rest) = cand.strip_prefix("~/") {
        home.join(rest)
    } else if cand.starts_with('/') {
        PathBuf::from(cand)
    } else {
        cwd.join(cand)
    };
    p.exists().then(|| p.canonicalize().unwrap_or(p))
}

/// A `vscode://file` URL for `path`, at `line` and `col` when given.
pub fn vscode_url(path: &Path, line: Option<u32>, col: Option<u32>) -> String {
    let mut u = String::from("vscode://file");
    for b in path.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
            u.push(b as char);
        } else {
            u.push_str(&format!("%{b:02X}"));
        }
    }
    if let Some(l) = line {
        u.push_str(&format!(":{l}"));
        if let Some(c) = col {
            u.push_str(&format!(":{c}"));
        }
    }
    u
}

/// The workspace (cmux's UUID) a local-tmux session belongs to, from cmux's
/// registry (`sessions.json`).
pub fn workspace_of(reg: &Value, session: &str) -> Option<String> {
    reg.get("sessions")?.as_array()?.iter().find_map(|s| {
        (s.get("name")?.as_str()? == session).then(|| s.get("workspaceID")?.as_str().map(str::to_string)).flatten()
    })
}

/// A GitHub pull request or issue link: ("pr" | "issue", its canonical URL).
pub fn gh_ref(url: &str) -> Option<(&'static str, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = rest.split(['/', '#', '?']).collect();
    let [owner, repo, kind, num, ..] = parts[..] else { return None };
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !ok(owner) || !ok(repo) || num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let kind = match kind {
        "pull" => "pr",
        "issues" => "issue",
        _ => return None,
    };
    let path = if kind == "pr" { "pull" } else { "issues" };
    Some((kind, format!("https://github.com/{owner}/{repo}/{path}/{num}")))
}

/// The fields `gh pr view --json` is asked for.
pub const PR_FIELDS: &str = "number,title,state,isDraft,author,headRefName,statusCheckRollup,reviewDecision,additions,deletions,body,labels";
/// The fields `gh issue view --json` is asked for.
pub const ISSUE_FIELDS: &str = "number,title,state,author,body,labels";

/// A pull request or issue as the hover card shows it.
#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Card {
    pub kind: String,
    pub number: u64,
    pub title: String,
    /// open, draft, merged or closed.
    pub state: String,
    pub author: String,
    /// A pull request's branch.
    pub branch: Option<String>,
    /// A pull request's checks: passed, failed, still running.
    pub checks: Option<[u32; 3]>,
    /// APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or none.
    pub review: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    /// The description's first paragraph, cut short.
    pub excerpt: String,
    pub labels: Vec<String>,
}

/// gh's JSON for a pull request or issue, as a Card.
pub fn card(kind: &str, v: &Value) -> Card {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut state = s("state").to_ascii_lowercase();
    if v.get("isDraft").and_then(Value::as_bool) == Some(true) && state == "open" {
        state = "draft".into();
    }
    let checks = v.get("statusCheckRollup").and_then(Value::as_array).map(|a| {
        let mut n = [0u32; 3];
        for c in a {
            let get = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
            let verdict = if c.get("state").is_some() { get("state") } else { get("conclusion") };
            let i = match verdict.as_str() {
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => 0,
                "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => 1,
                _ => 2,
            };
            n[i] += 1;
        }
        n
    });
    let body = s("body");
    let para = body.split("\n\n").map(str::trim).find(|p| !p.is_empty() && !p.starts_with('#')).unwrap_or("");
    let flat = para.split_whitespace().collect::<Vec<_>>().join(" ");
    let excerpt = if flat.chars().count() > 180 { format!("{}…", flat.chars().take(179).collect::<String>().trim_end()) } else { flat };
    Card {
        kind: kind.into(),
        number: v.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: s("title"),
        state,
        author: v.pointer("/author/login").and_then(Value::as_str).unwrap_or("").into(),
        branch: v.get("headRefName").and_then(Value::as_str).map(str::to_string),
        checks,
        review: v.get("reviewDecision").and_then(Value::as_str).filter(|r| !r.is_empty()).map(str::to_string),
        additions: v.get("additions").and_then(Value::as_u64),
        deletions: v.get("deletions").and_then(Value::as_u64),
        excerpt,
        labels: v.get("labels").and_then(Value::as_array).map(|a| a.iter().filter_map(|l| l.get("name")?.as_str().map(str::to_string)).collect()).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_only_what_exists() {
        let d = std::env::temp_dir().join(format!("pane-test-{}", std::process::id()));
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/a.rs"), "").unwrap();
        let home = Path::new("/nonexistent-home");
        assert!(resolve(&d, home, "src/a.rs").is_some());
        assert!(resolve(&d, home, "src/b.rs").is_none());
        assert!(resolve(&d, home, &d.join("src/a.rs").to_string_lossy()).is_some());
        assert!(resolve(&d, home, "").is_none());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn vscode_urls_escape_and_place() {
        assert_eq!(vscode_url(Path::new("/a b/c.rs"), Some(4), Some(2)), "vscode://file/a%20b/c.rs:4:2");
        assert_eq!(vscode_url(Path::new("/x.rs"), None, Some(2)), "vscode://file/x.rs");
    }

    #[test]
    fn finds_a_sessions_workspace() {
        let reg = json!({"sessions": [{"name": "claude-1", "workspaceID": "W1"}, {"name": "claude-2"}]});
        assert_eq!(workspace_of(&reg, "claude-1").as_deref(), Some("W1"));
        assert_eq!(workspace_of(&reg, "claude-2"), None);
        assert_eq!(workspace_of(&reg, "x"), None);
    }

    #[test]
    fn github_refs() {
        assert_eq!(gh_ref("https://github.com/o/r/pull/12#discussion"), Some(("pr", "https://github.com/o/r/pull/12".into())));
        assert_eq!(gh_ref("https://github.com/o/r/issues/3"), Some(("issue", "https://github.com/o/r/issues/3".into())));
        assert_eq!(gh_ref("https://github.com/o/r/tree/main"), None);
        assert_eq!(gh_ref("https://github.com/o/r/pull/x"), None);
        assert_eq!(gh_ref("https://example.com/o/r/pull/1"), None);
        assert_eq!(gh_ref("https://github.com/o;rm/r/pull/1"), None);
    }

    #[test]
    fn cards_count_checks_and_cut_the_body() {
        let v = json!({
            "number": 103, "title": "T", "state": "OPEN", "isDraft": false, "author": {"login": "me"},
            "headRefName": "dev/x", "reviewDecision": "", "additions": 8, "deletions": 6,
            "statusCheckRollup": [
                {"conclusion": "SUCCESS", "status": "COMPLETED"},
                {"conclusion": "FAILURE", "status": "COMPLETED"},
                {"conclusion": "", "status": "IN_PROGRESS"},
                {"state": "SUCCESS"}
            ],
            "body": "## Heading\n\nFirst   para\nwraps.\n\nSecond.",
            "labels": [{"name": "ux"}]
        });
        let c = card("pr", &v);
        assert_eq!(c.checks, Some([2, 1, 1]));
        assert_eq!(c.state, "open");
        assert_eq!(c.review, None);
        assert_eq!(c.excerpt, "First para wraps.");
        assert_eq!(c.labels, vec!["ux"]);
        let d = card("pr", &json!({"state": "OPEN", "isDraft": true}));
        assert_eq!(d.state, "draft");
        assert_eq!(d.checks, None);
    }
}
