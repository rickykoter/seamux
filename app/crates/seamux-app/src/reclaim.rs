//! The reclaim wizard's reading of crew-reclaim: which workspace refs it may
//! be handed, and what a real run did, from its terminal output. The report
//! itself comes as JSON (`crew-reclaim --json`); the run has no JSON form, so
//! its own lines are read here. reclaim_app.rs runs it.

use serde::{Deserialize, Serialize};

/// A workspace as the board names it: a UUID, or a ref like `workspace:4`.
/// Never led by a dash, so it can never be read as one of crew-reclaim's
/// options (`--yes`).
pub fn ws_ok(ws: &str) -> bool {
    ws.len() <= 64
        && ws.starts_with(|c: char| c.is_ascii_alphanumeric())
        && ws.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ':')
}

/// `s` without its terminal colour codes (CSI sequences).
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' && it.peek() == Some(&'[') {
            it.next();
            for d in it.by_ref() {
                if ('@'..='~').contains(&d) {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// One thing the run did or said: done (✓), a note (→), or what stopped it (✗).
#[derive(Serialize, Debug, PartialEq)]
pub struct Step {
    pub kind: &'static str,
    pub text: String,
}

/// What a `crew-reclaim --yes` run did. Its report is printed again first
/// (indented, and already shown by the wizard), so only its own top-level
/// lines from "reclaiming …" on count, and any ✗ it died with. A run that
/// never got that far was refused by a guard that failed since the check:
/// its failed guards (the report's indented ✗ lines) and the blocker count
/// say which.
pub fn steps(stdout: &str, stderr: &str) -> Vec<Step> {
    let mut out = Vec::new();
    let mut acting = false;
    let take = |line: &str, out: &mut Vec<Step>, only_errors: bool| {
        let l = strip_ansi(line);
        if l.starts_with(' ') || l.trim().is_empty() {
            return;
        }
        let (kind, text) = match l.split_once(' ') {
            Some(("✓", t)) => ("done", t),
            Some(("→", t)) => ("note", t),
            Some(("✗", t)) => ("error", t),
            _ => return,
        };
        if only_errors && kind != "error" {
            return;
        }
        out.push(Step { kind, text: text.trim().to_string() });
    };
    let mut refused: Vec<Step> = Vec::new();
    for line in stdout.lines() {
        let l = strip_ansi(line);
        if l.starts_with("→ reclaiming ") {
            acting = true;
        }
        if !acting {
            if let Some(t) = l.trim_start().strip_prefix("✗ ").filter(|_| l.starts_with(' ')) {
                refused.push(Step { kind: "error", text: t.trim().to_string() });
            } else if l.contains("blocker(s)") {
                refused.push(Step { kind: "note", text: l.trim().to_string() });
            }
        }
        take(line, &mut out, !acting);
    }
    if !acting {
        out.extend(refused);
    }
    for line in stderr.lines() {
        take(line, &mut out, true);
    }
    out
}

/// The fixes crew-reclaim's `--fix` takes; the wizard may ask for no other.
pub const FIXES: &[&str] = &["stash", "discard", "aside", "delete-ignored", "sandbox-down", "close-others"];

pub fn fix_ok(action: &str) -> bool {
    FIXES.contains(&action)
}

/// What a `crew-reclaim --fix` run said: every top-level ✓, → and ✗ line,
/// on either stream (it prints no report).
pub fn fix_steps(stdout: &str, stderr: &str) -> Vec<Step> {
    let mut out = Vec::new();
    for line in stdout.lines().chain(stderr.lines()) {
        let l = strip_ansi(line);
        if l.starts_with(' ') {
            continue;
        }
        let kind = match l.split_once(' ') {
            Some(("✓", _)) => "done",
            Some(("→", _)) => "note",
            Some(("✗", _)) => "error",
            _ => continue,
        };
        out.push(Step { kind, text: l.split_once(' ').map(|x| x.1).unwrap_or("").trim().to_string() });
    }
    out
}

/// A guard that failed, as the wizard hands it to Claude.
#[derive(Deserialize, Debug)]
pub struct Blocker {
    pub text: String,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub items: Vec<String>,
}

/// The first prompt of a Claude asked to clear what blocks a reclaim: what
/// each guard said, and the rules. It may investigate and fix, but asks
/// before anything that loses work, and never reclaims: the person does that
/// from the wizard, which checks every guard again.
pub fn claude_prompt(branch: Option<&str>, worktree: &str, blockers: &[Blocker]) -> String {
    let mut s = format!(
        "I want to reclaim this worktree ({worktree}{}): close its workspace, remove the worktree and delete its branch. \
         crew-reclaim refused, and these guards failed:\n",
        branch.map(|b| format!(", branch {b}")).unwrap_or_default()
    );
    for b in blockers {
        s.push_str(&format!("\n- {}", b.text.trim()));
        if let Some(h) = b.hint.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
            s.push_str(&format!(" ({h})"));
        }
        for i in b.items.iter().take(30) {
            s.push_str(&format!("\n    {}", i.trim_end()));
        }
        if b.items.len() > 30 {
            s.push_str(&format!("\n    … {} more", b.items.len() - 30));
        }
    }
    s.push_str(
        "\n\nLook into each one and tell me what you find: what the changes or files are, and whether anything here is work worth keeping. \
         Then help me clear them. Ask me before you discard, delete, commit, push or close anything. \
         Never run crew-reclaim --yes or remove the worktree yourself: when the guards should pass, tell me, and I will re-check and reclaim from the wizard.",
    );
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_refs() {
        assert!(ws_ok("AB79E681-B8EF-45FA-90AD-1AE7CC0E2456"));
        assert!(ws_ok("workspace:4"));
        assert!(!ws_ok(""));
        assert!(!ws_ok("--yes"));
        assert!(!ws_ok("-n"));
        assert!(!ws_ok("a b"));
        assert!(!ws_ok("../x"));
    }

    #[test]
    fn strips_colour() {
        assert_eq!(strip_ansi("\u{1b}[32m✓\u{1b}[0m removed"), "✓ removed");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn a_run_reads_as_what_it_did_not_its_report() {
        let out = "\u{1b}[2m→\u{1b}[0m checking /w/x\n\n\u{1b}[1mreclaim dev/x\u{1b}[0m\n  \u{1b}[32m✓\u{1b}[0m merged: HEAD is an ancestor of origin/main\n\
                   \u{1b}[1mWould remove\u{1b}[0m\n  \u{1b}[2m·\u{1b}[0m worktree   /w/x (2.1G)\n\
                   \u{1b}[2m→\u{1b}[0m reclaiming /w/x (dev/x, 2.1G)\n\u{1b}[32m✓\u{1b}[0m closed workspace x\n\
                   \u{1b}[32m✓\u{1b}[0m removed worktree /w/x\n\u{1b}[2m→\u{1b}[0m kept branch dev/x (git declined a safe delete)\n\u{1b}[32m✓\u{1b}[0m reclaimed 2.1G\n";
        let s = steps(out, "");
        assert_eq!(
            s.iter().map(|x| (x.kind, x.text.as_str())).collect::<Vec<_>>(),
            vec![
                ("note", "reclaiming /w/x (dev/x, 2.1G)"),
                ("done", "closed workspace x"),
                ("done", "removed worktree /w/x"),
                ("note", "kept branch dev/x (git declined a safe delete)"),
                ("done", "reclaimed 2.1G"),
            ]
        );
        let s = steps("\u{1b}[2m→\u{1b}[0m checking /w/x\n", "\u{1b}[31m✗\u{1b}[0m an agent started a turn in x while you were deciding — refusing\n");
        assert_eq!(s, vec![Step { kind: "error", text: "an agent started a turn in x while you were deciding — refusing".into() }]);
        // A guard that failed since the check: the run stops at its report.
        let s = steps("  \u{1b}[32m✓\u{1b}[0m clean tree, nothing uncommitted\n  \u{1b}[31m✗\u{1b}[0m an agent is mid-turn in x — let the turn end first\n\n\u{1b}[31m1 blocker(s) — nothing was changed.\u{1b}[0m\n", "");
        assert_eq!(
            s.iter().map(|x| (x.kind, x.text.as_str())).collect::<Vec<_>>(),
            vec![("error", "an agent is mid-turn in x — let the turn end first"), ("note", "1 blocker(s) — nothing was changed.")]
        );
    }

    #[test]
    fn fixes_are_a_closed_list() {
        assert!(fix_ok("stash") && fix_ok("delete-ignored"));
        assert!(!fix_ok("--yes") && !fix_ok("") && !fix_ok("rm"));
    }

    #[test]
    fn a_fix_reads_as_what_it_said() {
        let s = fix_steps(
            "\u{1b}[32m✓\u{1b}[0m stashed 2 change(s) as \"crew-reclaim: dev/x\"\n\u{1b}[2m→\u{1b}[0m the stash is in the shared repo\n",
            "\u{1b}[31m✗\u{1b}[0m w:2 did not close (busy)\n",
        );
        assert_eq!(
            s.iter().map(|x| (x.kind, x.text.as_str())).collect::<Vec<_>>(),
            vec![("done", "stashed 2 change(s) as \"crew-reclaim: dev/x\""), ("note", "the stash is in the shared repo"), ("error", "w:2 did not close (busy)")]
        );
    }

    #[test]
    fn the_prompt_names_every_blocker_and_its_items() {
        let b = vec![
            Blocker { text: "2 uncommitted change(s)".into(), hint: None, items: vec!["M a.ts".into(), "?? b.md".into()] },
            Blocker { text: "1 ignored file(s) would be deleted with it: .env".into(), hint: Some("move them out".into()), items: (0..32).map(|i| format!("f{i}")).collect() },
        ];
        let p = claude_prompt(Some("dev/x"), "/w/x", &b);
        assert!(p.contains("/w/x, branch dev/x"));
        assert!(p.contains("- 2 uncommitted change(s)\n    M a.ts\n    ?? b.md"));
        assert!(p.contains("(move them out)") && p.contains("f29") && !p.contains("f30\n") && p.contains("… 2 more"));
        assert!(p.contains("Never run crew-reclaim --yes"));
    }
}
