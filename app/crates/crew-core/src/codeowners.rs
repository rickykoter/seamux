//! GitHub CODEOWNERS: which team owns a path, for the Radar's ownership islands.
//!
//! GitHub reads the first of `.github/CODEOWNERS`, `CODEOWNERS` and
//! `docs/CODEOWNERS`. Each line is a pattern and its owners; the LAST line
//! whose pattern matches a path decides its owners, and a line with no owners
//! leaves the path unowned. Patterns follow gitignore with GitHub's limits:
//!
//! - a leading `/`, or a `/` before the last segment, anchors the pattern to
//!   the repo root; otherwise it matches at any depth (`*.js`, `apps/`);
//! - a trailing `/` matches a directory, so everything under it;
//! - `*` and `?` stay inside one path segment, `**` spans any number of them;
//! - a pattern that names a directory owns what is under it (`docs`,
//!   `/build/logs`), except one ending in `/*`, which GitHub documents as
//!   owning only that directory's own files, not nested ones;
//! - `!` negation and `[...]` ranges are not supported by GitHub and never match.

use std::collections::BTreeMap;

/// The places GitHub looks, in its order.
pub const LOCATIONS: [&str; 3] = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

#[derive(Clone, Debug, PartialEq)]
pub struct Rule {
    /// Pattern segments, with a leading `**` when the pattern floats.
    segs: Vec<String>,
    /// A trailing `/`: only directories match.
    dir_only: bool,
    /// Ends in `/*`: owns the directory's own files, not nested ones.
    shallow: bool,
    pub owners: Vec<String>,
}

/// The rules of a CODEOWNERS file, in file order. Lines GitHub would reject
/// (negation, character ranges) are skipped.
pub fn parse(text: &str) -> Vec<Rule> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = strip_comment(raw);
        let mut words = line.split_whitespace();
        let Some(pat) = words.next() else { continue };
        if pat.starts_with('!') || pat.contains('[') {
            continue;
        }
        let pat = pat.replace("\\#", "#");
        let owners: Vec<String> = words.map(str::to_string).collect();
        let dir_only = pat.ends_with('/') && pat.len() > 1;
        let body = pat.trim_end_matches('/');
        let anchored = body.starts_with('/') || body.trim_start_matches('/').contains('/');
        let body = body.trim_start_matches('/');
        let mut segs: Vec<String> = if body.is_empty() { vec!["**".into()] } else { body.split('/').map(str::to_string).collect() };
        if !anchored && segs.first().map(|s| s != "**").unwrap_or(false) {
            segs.insert(0, "**".into());
        }
        let shallow = !dir_only && segs.len() > 1 && segs.last().map(|s| s == "*").unwrap_or(false);
        out.push(Rule { segs, dir_only, shallow, owners });
    }
    out
}

/// A line without its comment: `#` starts one unless escaped as `\#`.
fn strip_comment(line: &str) -> &str {
    let b = line.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'#' && (i == 0 || b[i - 1] != b'\\') {
            return &line[..i];
        }
    }
    line
}

/// The owners of `path` (repo-relative, `/`-separated): the last matching
/// rule's, or empty when none matches or the last match names nobody.
pub fn owners_of<'a>(rules: &'a [Rule], path: &str) -> &'a [String] {
    let parts: Vec<&str> = path.trim_start_matches("./").trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    rules.iter().rev().find(|r| matches(r, &parts)).map(|r| r.owners.as_slice()).unwrap_or(&[])
}

/// Each path to its owners.
pub fn map(rules: &[Rule], paths: impl IntoIterator<Item = String>) -> BTreeMap<String, Vec<String>> {
    paths.into_iter().map(|p| {
        let o = owners_of(rules, &p).to_vec();
        (p, o)
    }).collect()
}

fn matches(r: &Rule, parts: &[&str]) -> bool {
    if parts.is_empty() {
        return false;
    }
    // The file itself (a directory-only rule never names a file).
    if !r.dir_only && seq(&r.segs, parts) {
        return true;
    }
    if r.shallow {
        return false;
    }
    // A directory above it: the rule owns everything beneath.
    (1..parts.len()).any(|n| seq(&r.segs, &parts[..n]))
}

/// Pattern segments against path segments, `**` taking zero or more.
fn seq(pat: &[String], parts: &[&str]) -> bool {
    match pat.split_first() {
        None => parts.is_empty(),
        Some((p, rest)) if p == "**" => (0..=parts.len()).any(|k| seq(rest, &parts[k..])),
        Some((p, rest)) => !parts.is_empty() && seg(p.as_bytes(), parts[0].as_bytes()) && seq(rest, &parts[1..]),
    }
}

/// One segment: `*` any run, `?` one character.
fn seg(p: &[u8], s: &[u8]) -> bool {
    match p.split_first() {
        None => s.is_empty(),
        Some((b'*', rest)) => (0..=s.len()).any(|k| seg(rest, &s[k..])),
        Some((b'?', rest)) => !s.is_empty() && seg(rest, &s[1..]),
        Some((c, rest)) => s.first() == Some(c) && seg(rest, &s[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GitHub's documented example file, trimmed to the cases that differ.
    const FIXTURE: &str = r"
# Default owners for everything.
*       @global-owner1 @global-owner2

*.js    @js-owner #This is an inline comment.
*.go docs@example.com
*.txt @octo-org/octocats

/build/logs/ @doctocat
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
/scripts/ @doctocat @octocat
**/logs @octocat

# No owners: this path stays unowned.
/apps/github
/apps/  @octocat
/apps/github
\#hash.md @hash-owner
!negated @nobody
";

    fn who(path: &str) -> Vec<String> {
        owners_of(&parse(FIXTURE), path).to_vec()
    }

    #[test]
    fn codeowners_default_and_extension_rules() {
        assert_eq!(who("README.md"), vec!["@global-owner1", "@global-owner2"]);
        assert_eq!(who("src/index.js"), vec!["@js-owner"], "the inline comment is not an owner");
        assert_eq!(who("cmd/main.go"), vec!["docs@example.com"]);
    }

    #[test]
    fn codeowners_last_match_wins_and_empty_rule_unowns() {
        assert_eq!(who("apps/web/x.js"), vec!["@octocat"], "/apps/ comes after *.js");
        assert!(who("apps/github/app.rb").is_empty(), "the last /apps/github line names nobody");
    }

    #[test]
    fn codeowners_anchoring_and_directories() {
        assert_eq!(who("build/logs/a.log"), vec!["@octocat"], "**/logs is later than /build/logs/");
        assert_eq!(who("deep/build/logs/a.txt"), vec!["@octocat"]);
        assert_eq!(who("scripts/x/y.sh"), vec!["@doctocat", "@octocat"]);
        assert_eq!(who("other/scripts/y.sh"), vec!["@global-owner1", "@global-owner2"], "/scripts/ is anchored");
    }

    #[test]
    fn codeowners_slash_star_is_shallow() {
        // docs/* owns docs' own files; /docs/ (later) owns everything under docs, so check a
        // file only docs/* can reach by putting the rules alone.
        let rules = parse("docs/* @a\n");
        assert_eq!(owners_of(&rules, "docs/intro.md"), ["@a"]);
        assert!(owners_of(&rules, "docs/build/trouble.md").is_empty());
    }

    #[test]
    fn codeowners_escapes_and_unsupported_lines() {
        assert_eq!(who("#hash.md"), vec!["@hash-owner"]);
        assert_eq!(parse(FIXTURE).iter().filter(|r| r.owners == ["@nobody"]).count(), 0, "negation is skipped");
        assert!(owners_of(&parse("[ab].md @x\n"), "a.md").is_empty(), "ranges are skipped");
    }

    #[test]
    fn codeowners_globs() {
        let rules = parse("src/**/test_*.rs @t\n/a?c @q\n");
        assert_eq!(owners_of(&rules, "src/test_x.rs"), ["@t"]);
        assert_eq!(owners_of(&rules, "src/a/b/test_y.rs"), ["@t"]);
        assert!(owners_of(&rules, "src/a/b/x.rs").is_empty());
        assert_eq!(owners_of(&rules, "abc/z"), ["@q"]);
        assert!(owners_of(&rules, "x/abc").is_empty(), "/a?c is anchored");
    }
}
