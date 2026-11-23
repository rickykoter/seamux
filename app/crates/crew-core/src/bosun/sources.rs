//! Which of a report's sources work, checked by the supervisor before it
//! types a run (reports.rs), outside the Bosun's sandbox.
//!
//! ```text
//! via  "mcp:<word>"   up when a `claude mcp list` row named <word> says Connected
//!      "cmd:<name>"   up when <name> is an executable on PATH, and the
//!                     sandbox lets out the host it needs (HOSTS)
//! ```
//!
//! A row matches when its name, the part after its last `:`, or the part
//! after `claude.ai ` equals the word, case ignored: `mcp:datadog` finds
//! `plugin:engineering:datadog`, and `mcp:claude docs` finds
//! `claude.ai Claude Docs`. A row with any other status is down, with that
//! status as the why. `claude mcp list` connects to every server, so it runs
//! once per run, with a time limit.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The hosts a vendor CLI needs the Bosun's sandbox to let out, for CLIs
/// that call one fixed API host on nearly every command. Network is opt-in
/// (the bosun-gh-tls plan's ADRs), so a section says which host is missing
/// instead of the Bosun trying the CLI and being refused. Not here: a CLI
/// whose host depends on the account, region or a self-hosted install (aws,
/// gcloud, az, acli, snowsql, kubectl, glab, sentry-cli), and one that often
/// runs with no network at all (npm, terraform). Their sections name their
/// hosts.
const HOSTS: &[(&str, &[&str])] = &[
    ("gh", &["api.github.com"]),
    ("vercel", &["api.vercel.com"]),
    ("netlify", &["api.netlify.com"]),
    ("flyctl", &["api.fly.io"]),
    ("fly", &["api.fly.io"]),
    ("heroku", &["api.heroku.com"]),
    ("doctl", &["api.digitalocean.com"]),
    ("stripe", &["api.stripe.com"]),
    ("circleci", &["circleci.com"]),
];

/// The built-in hosts for command `c` (case ignored, as macOS's disk
/// ignores it): none for a CLI not in HOSTS.
fn known_hosts(c: &str) -> Vec<String> {
    HOSTS.iter().find(|(name, _)| name.eq_ignore_ascii_case(c)).map(|(_, h)| h.iter().map(|x| x.to_string()).collect()).unwrap_or_default()
}

/// "a is", "a and b are", "a, b and c are".
fn hosts_are(hosts: &[String]) -> String {
    match hosts {
        [one] => format!("{one} is"),
        [rest @ .., last] => format!("{} and {last} are", rest.join(", ")),
        [] => String::new(),
    }
}

/// Whether an allowedDomains `entry` lets out `host` on 443: the host
/// itself, `*.<parent>`, or `*`, with no port or :443.
fn covers(entry: &str, host: &str) -> bool {
    let e = entry.trim().to_ascii_lowercase();
    let e = match e.rsplit_once(':') {
        Some((h, "443")) => h.to_string(),
        Some((_, port)) if port.chars().all(|c| c.is_ascii_digit()) => return false,
        _ => e,
    };
    e == "*" || e == host || e.strip_prefix("*.").is_some_and(|parent| host.ends_with(&format!(".{parent}")))
}

/// How long `claude mcp list` may take before every mcp: source counts as down.
pub const MCP_LIST_LIMIT: Duration = Duration::from_secs(60);
/// How long the login shell may take to say its PATH.
const LOGIN_PATH_LIMIT: Duration = Duration::from_secs(5);

/// One source a section reads.
#[derive(Clone, Debug, PartialEq)]
pub enum Via {
    Mcp(String),
    Cmd(String),
}

impl Via {
    /// `mcp:<word>` or `cmd:<name>`, or why not.
    pub fn parse(s: &str) -> Result<Via, String> {
        let s = s.trim();
        let (kind, name) = s.split_once(':').ok_or(format!("via {s:?}: use mcp:<server> or cmd:<command>"))?;
        let name = name.trim();
        if name.is_empty() {
            return Err(format!("via {s:?}: no name after {kind}:"));
        }
        match kind.trim() {
            "mcp" => Ok(Via::Mcp(name.to_string())),
            // A bare command name: no path, no arguments, nothing a shell would read.
            "cmd" if name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) => Ok(Via::Cmd(name.to_string())),
            "cmd" => Err(format!("via {s:?}: cmd: takes a bare command name")),
            other => Err(format!("via {s:?}: {other}: is not a source kind (mcp or cmd)")),
        }
    }

    /// As written in bosun.json.
    pub fn text(&self) -> String {
        match self {
            Via::Mcp(w) => format!("mcp:{w}"),
            Via::Cmd(c) => format!("cmd:{c}"),
        }
    }
}

/// One row of `claude mcp list`.
#[derive(Clone, Debug, PartialEq)]
pub struct Server {
    pub name: String,
    /// Its status without the mark: "Connected", "Needs authentication".
    pub status: String,
}

impl Server {
    pub fn up(&self) -> bool {
        self.status.eq_ignore_ascii_case("connected")
    }

    /// Whether `word` names this server.
    pub fn named(&self, word: &str) -> bool {
        let w = word.trim().to_lowercase();
        let n = self.name.trim().to_lowercase();
        let last = n.rsplit(':').next().unwrap_or("").trim().to_string();
        let web = n.strip_prefix("claude.ai ").unwrap_or("").trim().to_string();
        !w.is_empty() && (n == w || last == w || web == w)
    }
}

/// The rows of `claude mcp list`'s output: `<name>: <target> - <mark> <status>`.
/// Lines without that shape (the "Checking…" header) are left out.
pub fn parse_mcp_list(text: &str) -> Vec<Server> {
    text.lines()
        .filter_map(|l| {
            let (name, rest) = l.split_once(": ")?;
            let (_, status) = rest.rsplit_once(" - ")?;
            let status = status.trim_start_matches(|c: char| !c.is_alphanumeric()).trim();
            (!name.trim().is_empty() && !status.is_empty()).then(|| Server { name: name.trim().to_string(), status: status.to_string() })
        })
        .collect()
}

/// Run `claude mcp list` in `root` (project servers count) and read its rows,
/// killing it past `limit`.
pub fn mcp_list(root: &Path, limit: Duration) -> Result<Vec<Server>, String> {
    let mut cmd = Command::new("claude");
    cmd.args(["mcp", "list"]).current_dir(root);
    Ok(parse_mcp_list(&output_within(cmd, limit, "claude mcp list")?))
}

/// The PATH a login shell of the person's ($SHELL -lc) sets up, which the
/// Bosun's Bash tool may see and this process may not; "" when it can't
/// be read within `limit`.
pub fn login_path(limit: Duration) -> String {
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/sh".into());
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", "printf %s \"$PATH\""]);
    output_within(cmd, limit, "the login shell").unwrap_or_default().trim().to_string()
}

/// `cmd`'s stdout, killing it past `limit`; `what` names it in errors.
fn output_within(mut cmd: Command, limit: Duration, what: &str) -> Result<String, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {what}: {e}"))?;
    // Read on a thread, so a long listing can't fill the pipe and hang it.
    let mut out = child.stdout.take().ok_or(format!("{what}: no output"))?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = out_tx.send(s);
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{what} did not finish in {}s", limit.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("{what}: {e}")),
        }
    };
    // A grandchild can keep the pipe open after claude exits: wait a moment
    // for the rest of the output, never for good.
    // An output that never finishes is an error, not an empty listing: empty
    // would read as "no MCP server named …" for every source.
    let text = out_rx.recv_timeout(Duration::from_secs(2)).map_err(|_| format!("{what} exited but its output did not finish"))?;
    drop(reader);
    if !status.success() {
        return Err(format!("{what} exited with {status}"));
    }
    Ok(text)
}

/// Whether `name` is an executable file in one of `path`'s folders.
pub fn on_path(name: &str, path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    // An empty entry would mean the current folder: not a place to trust.
    std::env::split_paths(path).filter(|d| d.is_absolute()).any(|d| std::fs::metadata(d.join(name)).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// What one check found: the servers (or why they could not be read), the
/// PATH searched, and the hosts the running Bosun's sandbox lets out
/// (launch::launched_domains).
#[derive(Clone, Debug)]
pub struct Found {
    pub servers: Result<Vec<Server>, String>,
    pub path: String,
    pub domains: Vec<String>,
}

impl Found {
    /// Look now: `claude mcp list` in `root`, and this process's PATH with
    /// the login shell's after it (the Bosun's Bash tool sources the
    /// person's shell setup, which may add folders this process lacks).
    /// `domains` is what the running sandbox lets out.
    pub fn look(root: &Path, domains: &[String]) -> Found {
        let mut path = std::env::var("PATH").unwrap_or_default();
        let login = login_path(LOGIN_PATH_LIMIT);
        if !login.is_empty() {
            path = if path.is_empty() { login } else { format!("{path}:{login}") };
        }
        Found { servers: mcp_list(root, MCP_LIST_LIMIT), path, domains: domains.to_vec() }
    }

    /// Ok when `via` works, else why not, in words for "Not checked: <why>".
    pub fn check(&self, via: &Via) -> Result<(), String> {
        match via {
            Via::Cmd(c) if !on_path(c, &self.path) => Err(format!("{c} is not on PATH")),
            Via::Cmd(c) => self.let_out(&known_hosts(c)),
            Via::Mcp(w) => {
                let servers = self.servers.as_ref().map_err(|e| format!("could not read claude mcp list ({e})"))?;
                // Two rows can name one service (a plugin's unconfigured copy
                // beside a connected one): a working row wins, then a set-up one.
                let named: Vec<&Server> = servers.iter().filter(|s| s.named(w)).collect();
                let best = named.iter().find(|s| s.up()).or_else(|| named.iter().find(|s| !s.status.eq_ignore_ascii_case("not configured"))).or(named.first());
                match best.copied() {
                    Some(s) if s.up() => Ok(()),
                    Some(s) => Err(format!("{w} {}", lower_first(&s.status))),
                    None => Err(format!("no MCP server named {w} in claude mcp list")),
                }
            }
        }
    }

    /// Ok when the running sandbox lets out every one of `hosts`, else
    /// which it does not.
    pub fn let_out(&self, hosts: &[String]) -> Result<(), String> {
        let missing: Vec<String> = hosts.iter().filter(|h| !self.domains.iter().any(|d| covers(d, &h.to_ascii_lowercase()))).cloned().collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(format!("{} not in sandbox.allowedDomains (bosun.json, read when the Bosun starts)", hosts_are(&missing)))
        }
    }

    /// Whether a server named `word` is set up at all (listed, and not "Not
    /// configured"): what the starter reports are built from.
    pub fn has(&self, word: &str) -> bool {
        self.servers.as_ref().is_ok_and(|s| s.iter().any(|s| s.named(word) && !s.status.eq_ignore_ascii_case("not configured")))
    }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_lowercase().chain(c).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `claude mcp list` as it printed on 2026-11-22 (targets shortened).
    const LISTED: &str = "Checking MCP server health…\n\n\
claude.ai Claude Docs: https://mcp.example/docs - \u{2714} Connected\n\
claude.ai Gmail: https://mcp.example/gmail - \u{2714} Connected\n\
plugin:engineering:datadog: https://mcp.example/dd (HTTP) - ! Needs authentication\n\
plugin:engineering:atlassian: https://mcp.example/jira (HTTP) - ! Needs authentication\n\
plugin:engineering:google calendar:  (HTTP) - - Not configured\n\
splunk: npx -y splunk-mcp - \u{2717} Failed to connect\n";

    fn found(path: &str) -> Found {
        Found { servers: Ok(parse_mcp_list(LISTED)), path: path.into(), domains: vec![] }
    }

    #[test]
    fn rows_are_read_and_the_header_is_not() {
        let s = parse_mcp_list(LISTED);
        assert_eq!(s.len(), 6);
        assert_eq!(s[0], Server { name: "claude.ai Claude Docs".into(), status: "Connected".into() });
        assert_eq!(s[2].name, "plugin:engineering:datadog");
        assert_eq!(s[2].status, "Needs authentication");
        assert_eq!(s[4].status, "Not configured");
        assert_eq!(s[5].status, "Failed to connect");
        assert!(parse_mcp_list("No MCP servers configured. Use `claude mcp add` to add a server.\n").is_empty());
    }

    #[test]
    fn a_word_finds_its_server_by_name_last_part_or_web_name() {
        let s = parse_mcp_list(LISTED);
        assert!(s[2].named("datadog") && s[2].named("DataDog") && s[2].named("plugin:engineering:datadog"));
        assert!(s[0].named("claude docs"));
        assert!(s[4].named("google calendar"));
        assert!(!s[2].named("dog") && !s[2].named("engineering") && !s[0].named(""));
    }

    #[test]
    fn only_connected_is_up_and_each_down_says_why() {
        let f = found("");
        assert_eq!(f.check(&Via::Mcp("claude docs".into())), Ok(()));
        assert_eq!(f.check(&Via::Mcp("datadog".into())), Err("datadog needs authentication".into()));
        assert_eq!(f.check(&Via::Mcp("splunk".into())), Err("splunk failed to connect".into()));
        assert_eq!(f.check(&Via::Mcp("sentry".into())), Err("no MCP server named sentry in claude mcp list".into()));
        let broken = Found { servers: Err("claude mcp list did not finish in 60s".into()), path: String::new(), domains: vec![] };
        assert_eq!(broken.check(&Via::Mcp("datadog".into())), Err("could not read claude mcp list (claude mcp list did not finish in 60s)".into()));
    }

    #[test]
    fn a_working_row_wins_over_another_for_the_same_service() {
        let both = "plugin:engineering:gmail:  (HTTP) - - Not configured\nclaude.ai Gmail: https://x - \u{2714} Connected\n";
        let f = Found { servers: Ok(parse_mcp_list(both)), path: String::new(), domains: vec![] };
        assert_eq!(f.check(&Via::Mcp("gmail".into())), Ok(()));
        let neither = "plugin:engineering:gmail:  (HTTP) - - Not configured\nclaude.ai Gmail: https://x - ! Needs authentication\n";
        let f = Found { servers: Ok(parse_mcp_list(neither)), path: String::new(), domains: vec![] };
        assert_eq!(f.check(&Via::Mcp("gmail".into())), Err("gmail needs authentication".into()));
    }

    #[test]
    fn has_counts_a_listed_server_but_not_an_unconfigured_one() {
        let f = found("");
        assert!(f.has("datadog") && f.has("atlassian") && f.has("splunk"));
        assert!(!f.has("google calendar") && !f.has("sentry"));
    }

    #[test]
    fn a_command_is_up_only_when_executable_on_path() {
        let d = std::env::temp_dir().join(format!("bosun-sources-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("gh"), "#!/bin/sh\n").unwrap();
        std::fs::write(d.join("plain"), "").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(d.join("gh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let f = Found { domains: vec!["api.github.com".into()], ..found(&format!("/nowhere:{}", d.display())) };
        assert_eq!(f.check(&Via::Cmd("gh".into())), Ok(()));
        assert_eq!(f.check(&Via::Cmd("plain".into())), Err("plain is not on PATH".into()), "not executable");
        assert_eq!(f.check(&Via::Cmd("jq".into())), Err("jq is not on PATH".into()));
        assert!(!on_path("gh", &format!(":{}", "relative/dir")), "empty and relative entries are skipped");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn gh_on_path_is_down_until_the_sandbox_lets_out_api_github_com() {
        let d = std::env::temp_dir().join(format!("bosun-sources-gh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        use std::os::unix::fs::PermissionsExt;
        for c in ["gh", "jq"] {
            std::fs::write(d.join(c), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(d.join(c), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let f = found(&d.to_string_lossy());
        let missing = Err("api.github.com is not in sandbox.allowedDomains (bosun.json, read when the Bosun starts)".to_string());
        assert_eq!(f.check(&Via::Cmd("gh".into())), missing.clone(), "GitHub is opt-in: no hosts, no gh");
        assert_eq!(f.check(&Via::Cmd("jq".into())), Ok(()), "a command with no host keeps the PATH check alone");
        for ok in [&["api.github.com"][..], &["GitHub.com", "*.github.com"], &["*"], &["api.github.com:443"]] {
            let f = Found { domains: ok.iter().map(|s| s.to_string()).collect(), ..found(&d.to_string_lossy()) };
            assert_eq!(f.check(&Via::Cmd("gh".into())), Ok(()), "{ok:?}");
        }
        for no in [&["github.com"][..], &["api.github.com:8443"], &["*.githubusercontent.com"], &["xapi.github.com"]] {
            let f = Found { domains: no.iter().map(|s| s.to_string()).collect(), ..found(&d.to_string_lossy()) };
            assert_eq!(f.check(&Via::Cmd("gh".into())), missing.clone(), "{no:?}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_known_vendor_cli_is_down_until_its_hosts_are_let_out() {
        let d = std::env::temp_dir().join(format!("bosun-sources-vendor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        use std::os::unix::fs::PermissionsExt;
        for c in ["glab", "vercel", "heroku", "GH"] {
            std::fs::write(d.join(c), "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(d.join(c), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let none = found(&d.to_string_lossy());
        assert_eq!(none.check(&Via::Cmd("vercel".into())), Err("api.vercel.com is not in sandbox.allowedDomains (bosun.json, read when the Bosun starts)".into()));
        assert_eq!(none.check(&Via::Cmd("GH".into())), Err("api.github.com is not in sandbox.allowedDomains (bosun.json, read when the Bosun starts)".into()), "case ignored, as the disk ignores it");
        assert_eq!(none.check(&Via::Cmd("glab".into())), Ok(()), "self-hosted GitLab is common: its section names the host");
        let open = Found { domains: vec!["api.vercel.com".into(), "api.heroku.com".into()], ..found(&d.to_string_lossy()) };
        assert_eq!(open.check(&Via::Cmd("vercel".into())), Ok(()));
        assert_eq!(open.check(&Via::Cmd("heroku".into())), Ok(()));
        let two = Found { domains: vec![], ..found("") };
        assert_eq!(two.let_out(&["a.example".into(), "b.example".into()]), Err("a.example and b.example are not in sandbox.allowedDomains (bosun.json, read when the Bosun starts)".into()));
        assert_eq!(two.let_out(&[]), Ok(()), "no hosts, nothing to let out");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn via_takes_mcp_and_bare_cmd_names_only() {
        assert_eq!(Via::parse(" mcp:datadog "), Ok(Via::Mcp("datadog".into())));
        assert_eq!(Via::parse("mcp:claude docs"), Ok(Via::Mcp("claude docs".into())));
        assert_eq!(Via::parse("cmd:gh"), Ok(Via::Cmd("gh".into())));
        for bad in ["gh", "cmd:", "cmd:/usr/bin/gh", "cmd:gh auth status", "http:x", "mcp: "] {
            assert!(Via::parse(bad).is_err(), "{bad}");
        }
        assert_eq!(Via::Mcp("datadog".into()).text(), "mcp:datadog");
    }

    #[test]
    fn the_login_shells_path_is_read() {
        // Whatever this machine's shell adds, it says a PATH with folders in it.
        let p = login_path(Duration::from_secs(10));
        assert!(p.contains('/'), "{p:?}");
    }

    #[test]
    fn a_missing_claude_is_an_error_not_an_empty_list() {
        // A folder that is not there: the spawn fails, it does not read as "no servers".
        assert!(mcp_list(Path::new("/nowhere/at/all"), Duration::from_secs(5)).is_err());
    }
}
