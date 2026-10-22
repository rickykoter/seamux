//! The Lookout tab's pure parts: what a pasted repo or branch means, the
//! reviewer's depth, and the GitHub review a set of findings becomes. The
//! processes that act on them live in review_app.rs.

use serde_json::{json, Value};

/// What was pasted: a repository and the branch or pull request in it.
#[derive(Debug, PartialEq, Clone)]
pub struct Target {
    /// `owner/name`.
    pub repo: String,
    pub what: What,
}

#[derive(Debug, PartialEq, Clone)]
pub enum What {
    /// The repository alone: nothing to diff, so the caller asks for a branch.
    Default,
    Branch(String),
    Pr(u32),
}

const WHAT: &str = "paste a GitHub URL (repo, /tree/<branch> or /pull/<n>), or owner/repo@branch, or owner/repo#123";

fn repo_ok(r: &str) -> bool {
    let mut it = r.split('/');
    let part = |p: Option<&str>| {
        p.is_some_and(|p| {
            !p.is_empty()
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    };
    part(it.next()) && part(it.next()) && it.next().is_none()
}

/// A branch name safe to hand to git as a ref: no control characters, no
/// leading dash, none of the sequences git itself refuses.
pub fn branch_ok(b: &str) -> bool {
    !b.is_empty()
        && !b.starts_with('-')
        && !b.starts_with('/')
        && !b.ends_with('/')
        && !b.ends_with(".lock")
        && !b.contains("..")
        && !b.contains("//")
        && !b.contains("@{")
        && !b.chars().any(|c| c.is_control() || " ~^:?*[\\".contains(c))
}

pub fn parse_target(input: &str) -> Result<Target, String> {
    let s = input.trim();
    let bad = || format!("couldn't read \"{s}\": {WHAT}");
    if s.is_empty() {
        return Err(bad());
    }
    let strip = |u: &str| {
        [
            "https://github.com/",
            "http://github.com/",
            "git@github.com:",
            "github.com/",
        ]
        .iter()
        .find_map(|p| u.strip_prefix(p))
        .map(str::to_string)
    };
    if let Some(path) = strip(s) {
        // Drop a query or fragment, then walk owner/name[/pull/N | /tree/<branch...>].
        let path = path
            .split(['?', '#'])
            .next()
            .unwrap_or("")
            .trim_end_matches('/');
        let segs: Vec<&str> = path.split('/').collect();
        if segs.len() < 2 {
            return Err(bad());
        }
        let repo = format!("{}/{}", segs[0], segs[1].trim_end_matches(".git"));
        if !repo_ok(&repo) {
            return Err(bad());
        }
        let what = match segs.get(2).copied() {
            None => What::Default,
            Some("pull") => What::Pr(segs.get(3).and_then(|n| n.parse().ok()).ok_or_else(bad)?),
            Some("tree") | Some("commits") if segs.len() > 3 => What::Branch(segs[3..].join("/")),
            Some(_) => What::Default,
        };
        if let What::Branch(b) = &what {
            if !branch_ok(b) {
                return Err(bad());
            }
        }
        return Ok(Target { repo, what });
    }
    if let Some((repo, n)) = s.split_once('#') {
        return match (repo_ok(repo), n.parse::<u32>()) {
            (true, Ok(n)) => Ok(Target {
                repo: repo.into(),
                what: What::Pr(n),
            }),
            _ => Err(bad()),
        };
    }
    if let Some((repo, branch)) = s.split_once('@') {
        return if repo_ok(repo) && branch_ok(branch) {
            Ok(Target {
                repo: repo.into(),
                what: What::Branch(branch.into()),
            })
        } else {
            Err(bad())
        };
    }
    if repo_ok(s) {
        Ok(Target {
            repo: s.into(),
            what: What::Default,
        })
    } else {
        Err(bad())
    }
}

/// A lookout review id (lowercase letters, digits, `._-`) for a repository
/// and what is being reviewed in it. Stable, so a second review of the same
/// branch keeps what was said on the first.
pub fn review_id(repo: &str, label: &str) -> String {
    let slug = |t: &str| {
        let s: String = t
            .to_lowercase()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        s.trim_matches('-').to_string()
    };
    let id = format!("gh-{}-{}", slug(repo), slug(label));
    id.chars()
        .take(80)
        .collect::<String>()
        .trim_end_matches(['-', '.'])
        .to_string()
}

pub const DEPTHS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
pub const MODELS: [&str; 5] = ["", "haiku", "sonnet", "opus", "fable"];

/// How much the reviewer should report. It goes in the system prompt, so the
/// brief `lookout prompt` prints reaches the reviewer exactly as written.
pub fn depth_guide(depth: &str) -> &'static str {
    match depth {
        "low" => "Report only blocker and major findings that you traced through the code. Leave out everything else.",
        "medium" => "Report blocker, major and minor findings you are confident in. Leave out nits.",
        "high" => "Report every finding the code supports, minors included. Mark one PLAUSIBLE when you did not trace it.",
        "xhigh" => "Be thorough: read whole files and their callers before judging, and report every supported finding. Nits only when they matter.",
        _ => "Be exhaustive: trace each high-risk group end to end across files, and report uncertain findings too, marked PLAUSIBLE.",
    }
}

/// One finding as a line comment's text.
fn comment_text(f: &Value) -> String {
    let s = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("");
    let sev = s("severity");
    let scenario = s("failure_scenario");
    let mut t = format!(
        "**{}** · {} — {}",
        if sev.is_empty() { "finding" } else { sev },
        s("category"),
        s("summary")
    );
    if !scenario.is_empty() {
        t.push_str("\n\n");
        t.push_str(scenario);
    }
    t
}

/// The body of `POST /repos/{o}/{r}/pulls/{n}/reviews` for `findings`, pinned
/// to the commit that was reviewed. `folded` puts every finding in the body
/// instead of on a line, the retry for a line GitHub says is not in the diff.
pub fn review_payload(findings: &[Value], sha: &str, intro: &str, folded: bool) -> Value {
    let at = |f: &Value| {
        let file = f.get("file").and_then(Value::as_str).unwrap_or("");
        format!(
            "`{}:{}`",
            file,
            f.get("line").and_then(Value::as_u64).unwrap_or(0)
        )
    };
    if folded {
        let list: Vec<String> = findings
            .iter()
            .map(|f| format!("- {} {}", at(f), comment_text(f).replace('\n', "\n  ")))
            .collect();
        return json!({"commit_id": sha, "event": "COMMENT", "body": format!("{intro}\n\n{}", list.join("\n"))});
    }
    let comments: Vec<Value> = findings
        .iter()
        .map(|f| {
            json!({
                "path": f.get("file").and_then(Value::as_str).unwrap_or(""),
                "line": f.get("line").and_then(Value::as_u64).unwrap_or(1),
                "side": if f.get("side").and_then(Value::as_str) == Some("old") { "LEFT" } else { "RIGHT" },
                "body": comment_text(f),
            })
        })
        .collect();
    json!({"commit_id": sha, "event": "COMMENT", "body": intro, "comments": comments})
}

/// The name of the git remote in `remote -v` output whose URL is GitHub's
/// `repo` (any case, https or ssh, with or without `.git`), `origin` first.
pub fn remote_for(remote_v: &str, repo: &str) -> Option<String> {
    let want = repo.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    for line in remote_v.lines() {
        let mut f = line.split_whitespace();
        let (Some(name), Some(url)) = (f.next(), f.next()) else {
            continue;
        };
        let u = url.to_lowercase();
        let path = [
            "https://github.com/",
            "http://github.com/",
            "ssh://git@github.com/",
            "git@github.com:",
        ]
        .iter()
        .find_map(|p| u.strip_prefix(p));
        if path.is_some_and(|p| p.trim_end_matches('/').trim_end_matches(".git") == want)
            && !hits.iter().any(|h| h == name)
        {
            hits.push(name.to_string());
        }
    }
    hits.iter()
        .find(|n| *n == "origin")
        .or(hits.first())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(repo: &str, what: What) -> Result<Target, String> {
        Ok(Target {
            repo: repo.into(),
            what,
        })
    }

    #[test]
    fn a_pasted_repo_branch_or_pull_request_is_read() {
        assert_eq!(
            parse_target("https://github.com/acme/app"),
            t("acme/app", What::Default)
        );
        assert_eq!(
            parse_target("https://github.com/acme/app.git"),
            t("acme/app", What::Default)
        );
        assert_eq!(
            parse_target("https://github.com/acme/app/pull/42/files?w=1"),
            t("acme/app", What::Pr(42))
        );
        assert_eq!(
            parse_target("https://github.com/acme/app/tree/feat/x-y"),
            t("acme/app", What::Branch("feat/x-y".into()))
        );
        assert_eq!(
            parse_target("git@github.com:acme/app.git"),
            t("acme/app", What::Default)
        );
        assert_eq!(
            parse_target("acme/app@fix/it"),
            t("acme/app", What::Branch("fix/it".into()))
        );
        assert_eq!(parse_target("  acme/app#7 "), t("acme/app", What::Pr(7)));
        assert_eq!(parse_target("acme/app"), t("acme/app", What::Default));
    }

    #[test]
    fn what_is_not_a_repo_is_refused_and_says_what_to_paste() {
        for bad in [
            "",
            "acme",
            "https://github.com/acme",
            "acme/app#x",
            "acme/app@-rf",
            "acme/app@a..b",
            "a b/c",
            "https://github.com/a/b/pull/x",
            "x/y/z",
        ] {
            assert!(
                parse_target(bad)
                    .unwrap_err()
                    .contains("paste a GitHub URL"),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_review_id_is_one_lookout_accepts() {
        let id = review_id("Acme/App", "feat/Add Thing");
        assert_eq!(id, "gh-acme-app-feat-add-thing");
        assert!(id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c)));
        assert!(review_id("a/b", &"x".repeat(200)).len() <= 80);
    }

    #[test]
    fn a_remote_is_found_by_its_github_repo_in_any_spelling() {
        let v = "up\thttps://github.com/Acme/App.git (fetch)\nup\thttps://github.com/Acme/App.git (push)\nmine\tgit@github.com:acme/app (fetch)\n\
                 other\tgit@github.com:acme/app-two.git (fetch)\n";
        assert_eq!(remote_for(v, "acme/app"), Some("up".into()));
        assert_eq!(
            remote_for(
                &format!("origin\tgit@github.com:acme/app.git (fetch)\n{v}"),
                "acme/app"
            ),
            Some("origin".into())
        );
        assert_eq!(remote_for(v, "acme/ap"), None);
        assert_eq!(remote_for("", "acme/app"), None);
    }

    #[test]
    fn every_depth_has_its_own_guidance() {
        let all: std::collections::BTreeSet<_> = DEPTHS.iter().map(|d| depth_guide(d)).collect();
        assert_eq!(all.len(), DEPTHS.len());
    }

    #[test]
    fn findings_become_line_comments_or_one_folded_body() {
        let fs = vec![
            json!({"file": "a.rs", "line": 3, "severity": "major", "category": "correctness", "summary": "bad", "failure_scenario": "x -> y"}),
            json!({"file": "b.rs", "line": 9, "side": "old", "severity": "nit", "summary": "meh"}),
        ];
        let p = review_payload(&fs, "abc", "Reviewed by Lookout", false);
        assert_eq!(p["commit_id"], "abc");
        assert_eq!(p["event"], "COMMENT");
        assert_eq!(p["comments"][0]["side"], "RIGHT");
        assert_eq!(p["comments"][1]["side"], "LEFT");
        assert!(p["comments"][0]["body"]
            .as_str()
            .unwrap()
            .contains("x -> y"));
        let f = review_payload(&fs, "abc", "Reviewed by Lookout", true);
        assert!(f.get("comments").is_none());
        assert!(f["body"].as_str().unwrap().contains("`b.rs:9`"));
    }
}
