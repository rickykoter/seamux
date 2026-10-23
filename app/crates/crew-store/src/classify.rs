//! The indexer's text rules: artifacts.py's regexes, the human's prompt as
//! a row carries it, and what kind of artifact a written file is.
//!
//! The regex crate has no backreferences, so REMINDER_RE (which closes its
//! tag with \1) is four alternatives, one per tag; leftmost-first matching
//! makes that the same substitution.

use crate::paths::Paths;
use crate::{py_isspace, py_prefix, py_split};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

pub const PROMPT_MAX: usize = 500;
pub const IMAGE_EXT: [&str; 9] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic", ".bmp", ".tiff"];
pub const DOC_EXT: [&str; 4] = [".md", ".markdown", ".html", ".htm"];

macro_rules! re {
    ($name:ident, $pat:expr) => {
        pub fn $name() -> &'static Regex {
            static R: OnceLock<Regex> = OnceLock::new();
            R.get_or_init(|| Regex::new($pat).expect("static regex"))
        }
    };
}

re!(commit_re, r"(?m)^\[([^\]\n]+?) ([0-9a-f]{7,40})\] (.+)$");
re!(changed_re, r"\b\d+ files? changed\b");
// `git commit`, `git -C dir commit`, `git -c k=v commit`: commit as the
// subcommand, not a word anywhere in a git command (git log --grep commit).
re!(git_commit_re, r"\bgit(?:\s+-[Cc]\s+\S+|\s+--?[A-Za-z][\w-]*(?:=\S+)?)*\s+commit\b");
re!(oneline_re, r"^([0-9a-f]{7,40}) (.+)$");
re!(tmp_redirect_re, r#"(?:>>?|\btee(?:\s+-a)?)\s*((?:/private)?/tmp/[^\s;|&<>'"`$()]+)"#);
re!(
    reminder_re,
    r"(?s)<system-reminder>.*?</system-reminder>|<local-command-caveat>.*?</local-command-caveat>|<local-command-stdout>.*?</local-command-stdout>|<local-command-stderr>.*?</local-command-stderr>"
);
re!(tag_re, r"</?[a-z][a-z0-9-]*>");
re!(command_re, r"(?s)<command-name>(.*?)</command-name>");
re!(command_args_re, r"(?s)<command-args>(.*?)</command-args>");
re!(github_re, r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$");
// A GitHub pull request or issue link, wherever it sits in text: owner, repo,
// pull|issues, number. What follows the number (/files, #comment) is not kept.
re!(gh_link_re, r"https://github\.com/([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)/(pull|issues)/([0-9]+)");
// `gh pr create ... --title "x"` (or `gh issue create`): the title it was given.
re!(gh_create_title_re, r#"\bgh\s+(?:pr|issue)\s+create\b[^\n]*?(?:--title|-t)(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))"#);

/// Python truthiness for a JSON value.
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

/// `d.get(k)` when it is a non-empty string: what `d.get(k) or x` keeps.
pub fn gs<'a>(d: &'a Value, k: &str) -> Option<&'a str> {
    d.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The human's words: reminders and command scaffolding stripped,
/// whitespace folded, 500 characters.
pub fn clean_prompt(text: &str) -> String {
    let mut t: String = text.to_string();
    if let Some(m) = command_re().captures(&t) {
        // A slash command reads as what was typed: /name args.
        let name = m.get(1).map(|g| g.as_str()).unwrap_or("").trim_matches(py_isspace).to_string();
        let args = command_args_re()
            .captures(&t)
            .and_then(|a| a.get(1).map(|g| g.as_str().to_string()))
            .unwrap_or_default();
        t = format!("{name} {args}");
    }
    let t = reminder_re().replace_all(&t, " ");
    let t = tag_re().replace_all(&t, " ");
    let t = py_split(&t).join(" ");
    py_prefix(&t, PROMPT_MAX).to_string()
}

/// A user line's prompt text, or None when the line is not a prompt (a tool
/// result, a meta line, a compaction summary). A line whose message is not
/// an object reads as no prompt.
pub fn prompt_of(d: &Value) -> Option<String> {
    if d.get("type").and_then(Value::as_str) != Some("user")
        || truthy(d.get("isMeta"))
        || truthy(d.get("isCompactSummary"))
    {
        return None;
    }
    let content = d.get("message").and_then(|m| m.get("content"))?;
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let mut parts: Vec<&str> = Vec::new();
            for c in items {
                if !c.is_object() {
                    continue;
                }
                match c.get("type").and_then(Value::as_str) {
                    Some("tool_result") => return None,
                    Some("text") => parts.push(c.get("text").and_then(Value::as_str).unwrap_or("")),
                    _ => {}
                }
            }
            parts.join("\n")
        }
        _ => return None,
    };
    let t = clean_prompt(&text);
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// `os.path.splitext(p)[1]`: the last dot in the basename, unless the
/// basename is only dots before it (`.bashrc` has none).
pub fn splitext_ext(p: &str) -> &str {
    let sep = p.rfind('/').map(|i| i as isize).unwrap_or(-1);
    let Some(dot) = p.rfind('.') else { return "" };
    if (dot as isize) <= sep {
        return "";
    }
    let start = (sep + 1) as usize;
    if p[start..dot].bytes().any(|b| b != b'.') {
        &p[dot..]
    } else {
        ""
    }
}

pub fn under(path: &str, root: &str) -> bool {
    let r = format!("{}/", root.trim_end_matches('/'));
    path.starts_with(&r)
}

/// A written file's kind, or None when it is not an artifact: source code in
/// the workspace (git records it) and Claude Code's own transcripts. Inside
/// means inside the line's cwd or the session's starting directory.
pub fn classify(p: &Paths, path: &str, cwd: &str, root: &str) -> Option<&'static str> {
    if under(path, &p.projects) {
        return None;
    }
    let ext = splitext_ext(path).to_lowercase();
    if IMAGE_EXT.contains(&ext.as_str()) {
        return Some("image");
    }
    if [cwd, root].iter().any(|c| !c.is_empty() && under(path, &crate::paths::norm(c))) {
        return if DOC_EXT.contains(&ext.as_str()) { Some("doc") } else { None };
    }
    if p.is_temp(path) {
        return Some("temp");
    }
    if under(path, &p.home) {
        return Some("file");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prompts_are_cleaned_like_python() {
        let raw = "<system-reminder>secret\ncontext</system-reminder>Draft  the\tguide <b>now</b>";
        assert_eq!(clean_prompt(raw), "Draft the guide now");
        assert_eq!(
            clean_prompt("<command-message>x</command-message><command-name>/deep-plan</command-name><command-args>plan it</command-args>"),
            "/deep-plan plan it"
        );
        // A mismatched close does not end a reminder: the backreference's job.
        assert_eq!(clean_prompt("<system-reminder>a</local-command-stdout>b"), "a b");
        let long = format!("é{}", " word".repeat(200));
        assert_eq!(clean_prompt(&long).chars().count(), 500);
    }

    #[test]
    fn prompt_of_skips_what_is_not_a_prompt() {
        assert_eq!(prompt_of(&json!({"type": "user", "message": {"content": "hi"}})).as_deref(), Some("hi"));
        assert_eq!(prompt_of(&json!({"type": "user", "isMeta": true, "message": {"content": "hi"}})), None);
        assert_eq!(
            prompt_of(&json!({"type": "user", "message": {"content": [{"type": "tool_result"}, {"type": "text", "text": "x"}]}})),
            None
        );
        assert_eq!(
            prompt_of(&json!({"type": "user", "message": {"content": [{"type": "text", "text": "a"}, 3, {"type": "text", "text": "b"}]}})).as_deref(),
            Some("a b")
        );
        assert_eq!(prompt_of(&json!({"type": "user", "message": {"content": 42}})), None);
    }

    #[test]
    fn regexes_on_the_probes_strings() {
        assert!(git_commit_re().is_match("git add . && git commit -q -m x"));
        assert!(git_commit_re().is_match("git -C . commit -q -F -"));
        assert!(!git_commit_re().is_match("git log --grep commit --oneline -1"));
        assert!(!git_commit_re().is_match("git show HEAD~2 --oneline -s && echo commit"));
        let c = commit_re().captures("x\n[main (root-commit) 1a2b3c4] init\n 1 file changed").unwrap();
        assert_eq!((&c[1], &c[2], &c[3]), ("main (root-commit)", "1a2b3c4", "init"));
        let t: Vec<&str> = tmp_redirect_re()
            .captures_iter("echo hi > /tmp/artprobe-out.log; echo x > $S/hidden.txt; tee -a /private/tmp/b.txt")
            .map(|c| c.get(1).unwrap().as_str())
            .collect();
        assert_eq!(t, vec!["/tmp/artprobe-out.log", "/private/tmp/b.txt"]);
        let g = github_re().captures("git@github.com:octo/shop.git").unwrap();
        assert_eq!((&g[1], &g[2]), ("octo", "shop"));
        let g = github_re().captures("https://github.com/octo/shop/").unwrap();
        assert_eq!((&g[1], &g[2]), ("octo", "shop"));
    }

    #[test]
    fn splitext_like_python() {
        assert_eq!(splitext_ext("/a/b.PNG"), ".PNG");
        assert_eq!(splitext_ext("/a/.bashrc"), "");
        assert_eq!(splitext_ext("/a.d/b"), "");
        assert_eq!(splitext_ext("/a/..x.md"), ".md");
        assert_eq!(splitext_ext("/a/x."), ".");
    }
}
