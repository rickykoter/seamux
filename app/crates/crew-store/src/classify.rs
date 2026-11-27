//! The indexer's text rules: the retired artifacts.py's regexes, the human's prompt as
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
/// The recordings the Wake plays (wakeview.ts mediaOf, wake_app.rs show_kind).
pub const VIDEO_EXT: [&str; 4] = [".mp4", ".m4v", ".mov", ".webm"];
/// How far outside a Bash call's run a media file's mtime may fall and
/// still count as written by it: the transcript's timestamps are read to
/// the second, and a filesystem's mtime may round too.
pub const MEDIA_SLACK: f64 = 2.0;

/// Whether `path` is a BPMN diagram: `.bpmn`, or `.bpmn20.xml` as Flowable
/// and Activiti name theirs. A diagram is a document to look at, not
/// source: the Wake renders it.
pub fn is_bpmn(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".bpmn") || p.ends_with(".bpmn20.xml")
}

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
// `gh pr create`, however it is called: the pull request it prints is made here.
re!(gh_pr_create_re, r"\bgh\s+pr\s+create\b");
// gh commands that print other PRs: beside one, a create's output is not its own.
re!(gh_pr_reader_re, r"\bgh\s+(?:pr\s+(?:list|view|status|checks)|search\s+prs|api)\b");
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
    if VIDEO_EXT.contains(&ext.as_str()) {
        return Some("video");
    }
    if [cwd, root].iter().any(|c| !c.is_empty() && under(path, &crate::paths::norm(c))) {
        return if DOC_EXT.contains(&ext.as_str()) || is_bpmn(path) { Some("doc") } else { None };
    }
    if p.is_temp(path) {
        return Some("temp");
    }
    if under(path, &p.home) {
        return Some("file");
    }
    None
}

/// Whether `path` names an image or a video, by its extension.
pub fn is_media(path: &str) -> bool {
    let ext = splitext_ext(path).to_lowercase();
    IMAGE_EXT.contains(&ext.as_str()) || VIDEO_EXT.contains(&ext.as_str())
}

/// The image and video paths a Bash command names, resolved: what a
/// recorder or script may have written itself (ffmpeg, playwright, a node
/// script). Only a guess at what was written: the caller counts a path only
/// when the file's mtime falls inside the command's run.
///
/// The command is cut into segments at `&&`, `||`, `;`, `|`, `&` and line
/// ends, and each segment into words at blanks, quotes and brackets. A
/// `cd <dir>` segment moves where later relative paths resolve. A git
/// segment names files it checks out or restores, not ones it made, and is
/// skipped; so is a word holding `$`, a glob or a `~user`, which only the
/// shell can resolve. A path with a blank in it is missed.
pub fn media_paths(cmd: &str, cwd: &str, home: &str) -> Vec<String> {
    let resolve = |w: &str, dir: &str| -> Option<String> {
        let w = w.strip_prefix("file://").unwrap_or(w);
        if w.is_empty() || w.contains(['$', '*', '?', '[', '{', '\\']) {
            return None;
        }
        let abs = if w.starts_with('/') {
            w.to_string()
        } else if w == "~" || w.starts_with("~/") {
            if home.is_empty() {
                return None;
            }
            format!("{}{}", home.trim_end_matches('/'), &w[1..])
        } else if w.starts_with('~') || dir.is_empty() {
            return None;
        } else {
            format!("{}/{}", dir.trim_end_matches('/'), w)
        };
        Some(crate::paths::normpath(&abs))
    };
    let mut dir = cwd.to_string();
    let mut out: Vec<String> = Vec::new();
    for seg in cmd.split(['\n', ';', '&', '|']) {
        // The program: the first word after any VAR=value assignments.
        let mut raw = seg.split_whitespace().skip_while(|w| {
            w.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        });
        let Some(prog) = raw.next() else { continue };
        match prog.trim_matches(['"', '\'', '(', ')']) {
            "cd" => {
                // `cd`, `cd -` or a dir only the shell can resolve: later
                // relative paths are not guessed at.
                dir = raw.next().map(|w| w.trim_matches(['"', '\''])).filter(|w| *w != "-").and_then(|w| resolve(w, &dir)).unwrap_or_default();
                continue;
            }
            "git" => continue,
            _ => {}
        }
        for w in seg.split(|c: char| c.is_whitespace() || "'\"`()<>,{}[]=".contains(c)) {
            if is_media(w) {
                if let Some(p) = resolve(w, &dir) {
                    if !out.contains(&p) {
                        out.push(p);
                    }
                }
            }
        }
    }
    out
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
    fn bpmn_is_either_name_flowable_uses() {
        assert!(is_bpmn("/a/loan.bpmn"));
        assert!(is_bpmn("/a/task-need.v1.BPMN20.xml"));
        assert!(!is_bpmn("/a/pom.xml"));
        assert!(!is_bpmn("/a/bpmn20.xml.bak"));
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

    fn paths_at(root: &str) -> Paths {
        let home = format!("{root}/hm");
        Paths {
            crew_home: format!("{home}/.claude/crew"),
            db: format!("{home}/.claude/crew/artifacts.db"),
            lock: format!("{home}/.claude/crew/index.lock"),
            again: format!("{home}/.claude/crew/index.lock.again"),
            kept: format!("{home}/.claude/crew/kept"),
            projects: format!("{home}/.claude/projects"),
            plans: format!("{home}/.claude/plans"),
            dp_state: format!("{home}/.claude/deep-plan/state"),
            chartroom: format!("{home}/.claude/chartroom"),
            scratch_base: format!("{root}/tmp/claude-501"),
            temp_roots: vec![format!("{root}/tmp/")],
            home,
        }
    }

    #[test]
    fn a_video_is_a_video_wherever_it_is() {
        let p = paths_at("/r");
        let ws = "/r/hm/code/shop";
        // In the workspace, where only docs were kept before.
        assert_eq!(classify(&p, "/r/hm/code/shop/docs/demo/media/walk.webm", ws, ws), Some("video"));
        assert_eq!(classify(&p, "/r/hm/code/shop/out/Demo.MP4", ws, ws), Some("video"));
        assert_eq!(classify(&p, "/r/hm/code/shop/src/app.py", ws, ws), None);
        // In a temp directory and a session's scratchpad.
        assert_eq!(classify(&p, "/r/tmp/rec.mov", ws, ws), Some("video"));
        assert_eq!(classify(&p, "/r/tmp/claude-501/-proj/sess/scratchpad/clip.m4v", ws, ws), Some("video"));
        // Under ~, and never Claude Code's own files.
        assert_eq!(classify(&p, "/r/hm/Movies/take.mp4", ws, ws), Some("video"));
        assert_eq!(classify(&p, "/r/hm/.claude/projects/x/clip.mp4", ws, ws), None);
        assert_eq!(classify(&p, "/r/tmp/rec.mkv", ws, ws), Some("temp"), "only the kinds the Wake plays");
    }

    #[test]
    fn media_paths_reads_what_a_command_names() {
        let got = |cmd: &str| media_paths(cmd, "/w", "/h");
        // Relative to the cwd, absolute and ~ as written; other files ignored.
        assert_eq!(
            got("ffmpeg -y -i in.mov -c:v libvpx out/walk.webm 2>&1 | tail -3; ls /tmp/x.log"),
            vec!["/w/in.mov", "/w/out/walk.webm"]
        );
        assert_eq!(got("screencapture -v -V 5 ~/Movies/take.mov"), vec!["/h/Movies/take.mov"]);
        // A cd moves later relative paths; one the shell must resolve stops them.
        assert_eq!(got("cd docs/demo && node rec.mjs --out media/x.mp4"), vec!["/w/docs/demo/media/x.mp4"]);
        assert_eq!(got("cd \"$D\" && node rec.mjs media/x.mp4 /abs/y.png"), vec!["/abs/y.png"]);
        // Quoted, in a script's text, after = and file://, each once.
        assert_eq!(
            got("node -e \"page.screenshot({path: 'shots/a.png'}); v.saveAs('file:///tmp/v.webm')\" --out=shots/a.png"),
            vec!["/w/shots/a.png", "/tmp/v.webm"]
        );
        assert_eq!(got("FPS=30 ./rec.sh ./a/../b.mp4"), vec!["/w/b.mp4"]);
        // What git touches, shell variables and globs are not guessed at.
        assert!(got("git checkout -- docs/shot.png && git add demo.mp4").is_empty());
        assert!(got("ffmpeg -i $S/in.mp4 *.webm ~bob/x.mov").is_empty());
        assert!(media_paths("ffmpeg -i a.mp4", "", "/h").is_empty(), "no cwd: no relative path");
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
