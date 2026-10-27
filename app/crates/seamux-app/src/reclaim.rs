//! The reclaim wizard's reading of crew-reclaim: which workspace refs it may
//! be handed, and what a real run did, from its terminal output. The report
//! itself comes as JSON (`crew-reclaim --json`); the run has no JSON form, so
//! its own lines are read here. reclaim_app.rs runs it.

use serde::Serialize;

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
/// lines from "reclaiming …" on count, and any ✗ it died with.
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
    for line in stdout.lines() {
        if strip_ansi(line).starts_with("→ reclaiming ") {
            acting = true;
        }
        take(line, &mut out, !acting);
    }
    for line in stderr.lines() {
        take(line, &mut out, true);
    }
    out
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
    }
}
