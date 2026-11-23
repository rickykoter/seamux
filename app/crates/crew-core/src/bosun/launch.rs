//! What the Bosun's Claude starts with: its settings (read-only on the root),
//! its brief, and the claude command line, plus the state that names the
//! conversation it resumes.
//!
//! Read-only is two layers (the bosun plan's ADR): an Edit deny on the root,
//! which no allow rule of the person's can override, and Claude Code's own
//! sandbox refusing Bash writes under it, subprocesses included, with no
//! retry outside the sandbox.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::config::Config;

/// The Bosun's brief, given to Claude with --append-system-prompt-file.
pub const BRIEF: &str = include_str!("brief.md");

/// The seamux CLI the pane and the hooks run: SEAMUX_BIN, else this process
/// when it is seamux, else ~/.local/bin/seamux.
pub fn seamux_bin() -> String {
    if let Some(b) = crate::py::env_or("SEAMUX_BIN") {
        return b;
    }
    let me = std::env::current_exe().ok().and_then(|p| fs::canonicalize(p).ok());
    if let Some(p) = me.filter(|p| p.file_name().is_some_and(|n| n == "seamux")) {
        return p.to_string_lossy().into_owned();
    }
    crate::py::home().join(".local/bin/seamux").to_string_lossy().into_owned()
}

/// A permission rule's path: `//` anchors it at the filesystem root.
fn rule_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    format!("/{}/**", s.trim_end_matches('/'))
}

/// The files in the Bosun's folder that steer it: its config (root, sandbox
/// lists, loops), the settings and brief made from it, and the state the
/// supervisor and its hooks keep. The Bosun may write the rest of its folder
/// (queue, answers, log, drafts), never these: rewriting bosun.json would
/// let a prompt injected through a ticket or a page widen its own sandbox on
/// the next restart. The hooks and the supervisor run outside the sandbox.
pub const PROTECTED: &[&str] = &["bosun.json", "settings.json", "brief.md", "state.json", "reset-day"];

/// The ways Claude may write the seamux command: as `seamux` and as the
/// full path the Bosun's prompts name.
fn dispatch_forms(seamux: &str) -> Vec<String> {
    let mut v = vec!["seamux".to_string()];
    if seamux != "seamux" {
        v.push(seamux.to_string());
    }
    v
}

/// macOS's bundled certificate roots, a PEM file.
const MACOS_CERTS: &str = "/etc/ssl/cert.pem";

/// The certificate file sandboxed commands check TLS against: `inherited`
/// (the supervisor's own SSL_CERT_FILE), else macOS's bundled roots, each
/// only when `exists` finds it: a stale path would leave Go with no roots. The sandbox refuses the trust service,
/// com.apple.trustd.agent, so Go programs like gh can't check a certificate
/// without this. Opening the trust service would weaken the sandbox, and a
/// file leaves it as it is (the bosun-gh-tls plan's ADR).
fn cert_file(inherited: Option<String>, exists: impl Fn(&Path) -> bool) -> Option<String> {
    inherited.into_iter().chain([MACOS_CERTS.to_string()]).find(|f| exists(Path::new(f)))
}

/// The settings passed with --settings. `dir` is the Bosun's own folder, the
/// one place it writes.
pub fn settings(cfg: &Config, dir: &Path, seamux: &str) -> Value {
    settings_with(cfg, dir, seamux, cert_file(crate::py::env_or("SSL_CERT_FILE"), Path::is_file))
}

/// `settings` with the certificate file given: none leaves out the env block.
fn settings_with(cfg: &Config, dir: &Path, seamux: &str, certs: Option<String>) -> Value {
    let root = cfg.root.to_string_lossy().into_owned();
    let own = dir.to_string_lossy().into_owned();
    let mut allow_write = vec![own.clone()];
    allow_write.extend(cfg.allow_write.iter().map(|p| super::config::expand(p).to_string_lossy().into_owned()));
    let mut network = json!({});
    if !cfg.allowed_domains.is_empty() {
        network["allowedDomains"] = json!(cfg.allowed_domains);
    }
    let prime = format!("{} bosun prime", crate::native::sh_quote(seamux));
    // bosun-routines: what a compaction keeps, and that index again after it.
    let precompact = format!("{} bosun precompact", crate::native::sh_quote(seamux));
    let recall = format!("{} bosun recall", crate::native::sh_quote(seamux));
    // Dispatch is the one command let out of the sandbox, and only with the
    // person's yes each time: an ask rule prompts even in auto mode. Rules
    // match the command as typed, so the bare name and the full path each
    // get one; any other form (a wrapper, sh -c) stays sandboxed and fails.
    let dispatch: Vec<String> = dispatch_forms(seamux).iter().map(|c| format!("{c} bosun dispatch *")).collect();
    let protected: Vec<String> = PROTECTED.iter().map(|f| dir.join(f).to_string_lossy().into_owned()).collect();
    let mut deny = vec![format!("Edit({})", rule_path(&cfg.root))];
    deny.extend(protected.iter().map(|p| format!("Edit(/{p})")));
    let mut deny_write = vec![root];
    deny_write.extend(protected.iter().cloned());
    let mut s = json!({
        "permissions": {
            "deny": deny,
            "ask": dispatch.iter().map(|d| format!("Bash({d})")).collect::<Vec<_>>(),
            "allow": [format!("Edit({})", rule_path(dir)), format!("Read({})", rule_path(dir))],
            // A working directory too: shell input redirection reads only from
            // those, so `bosun answer <id> < <dir>/drafts/<id>.md` works.
            "additionalDirectories": [own.clone()],
        },
        "sandbox": {
            "enabled": true,
            "failIfUnavailable": true,
            "allowUnsandboxedCommands": false,
            "excludedCommands": dispatch,
            "filesystem": {"denyWrite": deny_write, "allowWrite": allow_write},
            "network": network,
        },
        "hooks": {
            "SessionStart": [
                {"hooks": [{"type": "command", "command": prime, "timeout": 10}]},
                {"matcher": "compact", "hooks": [{"type": "command", "command": recall, "timeout": 10}]},
            ],
            "PreCompact": [{"hooks": [{"type": "command", "command": precompact, "timeout": 10}]}],
        },
    });
    // Claude Code passes env to every command it runs, sandboxed or not.
    if let Some(f) = certs {
        s["env"] = json!({"SSL_CERT_FILE": f});
    }
    s
}

/// The conversation the supervisor keeps: its session id and the local day
/// it started on.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub session: String,
    pub day: String,
}

impl State {
    pub fn load(dir: &Path) -> State {
        let v = fs::read_to_string(dir.join("state.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!({}));
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        State { session: s("session"), day: s("day") }
    }

    /// Written whole, through a temporary file and a rename.
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!("state.json.{}.tmp", std::process::id()));
        fs::write(&tmp, serde_json::to_string_pretty(&json!({"session": self.session, "day": self.day})).unwrap_or_default()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, dir.join("state.json")).map_err(|e| e.to_string())
    }
}

/// Whether Claude keeps a transcript for `session` under `projects`
/// (~/.claude/projects). Each project folder is looked in, rather than the
/// root's folder name worked out, since Claude Code shortens long ones.
pub fn has_transcript(projects: &Path, session: &str) -> bool {
    let name = format!("{session}.jsonl");
    fs::read_dir(projects).into_iter().flatten().flatten().any(|e| e.path().join(&name).is_file())
}

/// claude's arguments: resume the kept session when its transcript is
/// there, else start `fresh` (a new id the caller saves).
pub fn claude_args(settings: &Path, brief: &Path, resume: Option<&str>, fresh: &str) -> Vec<String> {
    let mut a = match resume {
        Some(id) => vec!["--resume".to_string(), id.to_string()],
        None => vec!["--session-id".to_string(), fresh.to_string()],
    };
    a.extend(["--settings".to_string(), settings.to_string_lossy().into_owned()]);
    a.extend(["--append-system-prompt-file".to_string(), brief.to_string_lossy().into_owned()]);
    a
}

/// The hosts the running Bosun's sandbox lets out: settings.json's list in
/// `dir`, written when its Claude started, so an edit to bosun.json counts
/// only once a restart has picked it up. Before the first launch (no
/// settings.json), bosun.json's.
pub fn launched_domains(dir: &Path) -> Vec<String> {
    let written = fs::read_to_string(dir.join("settings.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    match written {
        Some(v) => v["sandbox"]["network"]["allowedDomains"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
        None => Config::load_from(dir).allowed_domains,
    }
}

/// Writes settings.json and brief.md into `dir`: (settings, brief).
pub fn write_files(cfg: &Config, dir: &Path, seamux: &str) -> Result<(PathBuf, PathBuf), String> {
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let settings_path = dir.join("settings.json");
    let brief_path = dir.join("brief.md");
    let text = serde_json::to_string_pretty(&settings(cfg, dir, seamux)).unwrap_or_default();
    fs::write(&settings_path, text).map_err(|e| e.to_string())?;
    fs::write(&brief_path, BRIEF.replace("{root}", &cfg.root.to_string_lossy()).replace("{dir}", &dir.to_string_lossy())).map_err(|e| e.to_string())?;
    Ok((settings_path, brief_path))
}

/// The local date (YYYY-MM-DD) and hour at `secs` since the epoch.
pub fn local_day_hour(secs: i64) -> (String, u32) {
    // One reading of local time (loops.rs), so the loops' day is the supervisor's.
    let l = super::loops::local(secs);
    (l.day, l.minute / 60)
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Whether the kept conversation is from before today's reset: the day it
/// started is not today, and the reset hour has passed.
pub fn reset_due(state_day: &str, today: &str, hour: u32, reset_hour: u32) -> bool {
    !state_day.is_empty() && state_day != today && hour >= reset_hour
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Config {
        Config { root: PathBuf::from("/u/code"), reset_hour: 4, allow_write: vec!["/u/.cache/gh".into()], allowed_domains: vec!["github.com".into()] }
    }

    #[test]
    fn settings_deny_edits_on_the_root_and_sandbox_its_writes() {
        let s = settings(&cfg(), Path::new("/u/.claude/crew/bosun"), "/bin/seamux");
        assert_eq!(s["permissions"]["deny"][0], "Edit(//u/code/**)");
        assert!(s["permissions"]["deny"].as_array().unwrap().contains(&json!("Edit(//u/.claude/crew/bosun/bosun.json)")), "its own config is not its to edit");
        assert_eq!(s["permissions"]["allow"][0], "Edit(//u/.claude/crew/bosun/**)");
        assert_eq!(s["permissions"]["additionalDirectories"], json!(["/u/.claude/crew/bosun"]), "its folder is a working directory");
        assert_eq!(s["sandbox"]["enabled"], true);
        assert_eq!(s["sandbox"]["allowUnsandboxedCommands"], false, "no retry outside the sandbox");
        assert_eq!(s["sandbox"]["failIfUnavailable"], true, "no Bosun without its sandbox");
        let dw = s["sandbox"]["filesystem"]["denyWrite"].as_array().unwrap().clone();
        assert_eq!(dw[0], "/u/code");
        for f in PROTECTED {
            assert!(dw.contains(&json!(format!("/u/.claude/crew/bosun/{f}"))), "{f} is denied to Bash");
        }
        assert_eq!(s["sandbox"]["filesystem"]["allowWrite"], json!(["/u/.claude/crew/bosun", "/u/.cache/gh"]));
        assert_eq!(s["sandbox"]["network"]["allowedDomains"], json!(["github.com"]));
        assert_eq!(s["hooks"]["SessionStart"][0]["hooks"][0]["command"], "/bin/seamux bosun prime");
        assert_eq!(s["hooks"]["SessionStart"][1]["matcher"], "compact");
        assert_eq!(s["hooks"]["SessionStart"][1]["hooks"][0]["command"], "/bin/seamux bosun recall");
        assert_eq!(s["hooks"]["PreCompact"][0]["hooks"][0]["command"], "/bin/seamux bosun precompact");
        let out = json!(["seamux bosun dispatch *", "/bin/seamux bosun dispatch *"]);
        assert_eq!(s["sandbox"]["excludedCommands"], out, "dispatch alone leaves the sandbox");
        assert_eq!(s["permissions"]["ask"], json!(["Bash(seamux bosun dispatch *)", "Bash(/bin/seamux bosun dispatch *)"]), "and asks every time");
    }

    #[test]
    fn settings_point_gh_at_a_certificate_file() {
        // The sandbox refuses com.apple.trustd.agent, so gh (Go) can't check
        // a certificate unless SSL_CERT_FILE names a file it can read.
        let s = settings(&cfg(), Path::new("/d"), "seamux");
        if Path::new("/etc/ssl/cert.pem").is_file() || crate::py::env_or("SSL_CERT_FILE").is_some() {
            assert!(s["env"]["SSL_CERT_FILE"].as_str().is_some_and(|f| !f.is_empty()), "no certificate file for gh: {}", s["env"]);
        }
    }

    #[test]
    fn the_supervisors_own_certificate_file_wins_and_the_sandbox_is_unchanged() {
        let yes = |_: &Path| true;
        let no = |_: &Path| false;
        assert_eq!(cert_file(Some("/corp/ca.pem".into()), yes).as_deref(), Some("/corp/ca.pem"), "a corporate bundle is kept");
        assert_eq!(cert_file(None, yes).as_deref(), Some("/etc/ssl/cert.pem"));
        assert_eq!(cert_file(None, no), None, "no file, no variable");
        let only_macos = |p: &Path| p == Path::new("/etc/ssl/cert.pem");
        assert_eq!(cert_file(Some("/gone/ca.pem".into()), only_macos).as_deref(), Some("/etc/ssl/cert.pem"), "a stale inherited path falls back");
        let with = settings_with(&cfg(), Path::new("/d"), "seamux", Some("/etc/ssl/cert.pem".into()));
        let without = settings_with(&cfg(), Path::new("/d"), "seamux", None);
        assert_eq!(with["env"], json!({"SSL_CERT_FILE": "/etc/ssl/cert.pem"}));
        assert!(without.get("env").is_none());
        assert_eq!(with["sandbox"], without["sandbox"], "the certificate file leaves the sandbox as it is");
        assert_eq!(with["permissions"], without["permissions"]);
        assert!(with["sandbox"].get("enableWeakerNetworkIsolation").is_none() && with["sandbox"]["network"].get("allowMachLookup").is_none(), "the trust service stays shut");
    }

    #[test]
    fn the_running_sandboxs_hosts_come_from_the_settings_it_launched_with() {
        let d = std::env::temp_dir().join(format!("bosun-launched-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("bosun.json"), r#"{"sandbox": {"allowedDomains": ["api.github.com"]}}"#).unwrap();
        assert_eq!(launched_domains(&d), vec!["api.github.com"], "no launch yet: bosun.json's");
        let mut c = cfg();
        c.allowed_domains.clear();
        write_files(&c, &d, "seamux").unwrap();
        assert!(launched_domains(&d).is_empty(), "added after the launch: not let out until a restart");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn no_domains_means_no_allow_list() {
        let mut c = cfg();
        c.allowed_domains.clear();
        let s = settings(&c, Path::new("/d"), "seamux");
        assert_eq!(s["sandbox"]["network"], json!({}));
    }

    #[test]
    fn args_resume_a_kept_session_or_name_a_fresh_one() {
        let (st, br) = (Path::new("/d/settings.json"), Path::new("/d/brief.md"));
        assert_eq!(claude_args(st, br, Some("S1"), "S2")[..2], ["--resume".to_string(), "S1".to_string()]);
        let fresh = claude_args(st, br, None, "S2");
        assert_eq!(fresh[..2], ["--session-id".to_string(), "S2".to_string()]);
        assert!(fresh.windows(2).any(|w| w[0] == "--settings" && w[1] == "/d/settings.json"));
        assert!(fresh.windows(2).any(|w| w[0] == "--append-system-prompt-file" && w[1] == "/d/brief.md"));
    }

    #[test]
    fn the_reset_waits_for_a_new_day_and_the_hour() {
        assert!(reset_due("2026-11-21", "2026-11-22", 4, 4));
        assert!(!reset_due("2026-11-21", "2026-11-22", 3, 4), "before the hour");
        assert!(!reset_due("2026-11-22", "2026-11-22", 9, 4), "same day");
        assert!(!reset_due("", "2026-11-22", 9, 4), "no conversation yet");
    }

    #[test]
    fn a_transcript_is_found_in_any_project_folder() {
        let d = std::env::temp_dir().join(format!("bosun-proj-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("-u-a-very-long-folder-abc123")).unwrap();
        fs::write(d.join("-u-a-very-long-folder-abc123/S1.jsonl"), "{}").unwrap();
        assert!(has_transcript(&d, "S1"));
        assert!(!has_transcript(&d, "S2"));
        assert!(!has_transcript(&d.join("missing"), "S1"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn state_round_trips() {
        let d = std::env::temp_dir().join(format!("bosun-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let s = State { session: "S".into(), day: "2026-11-22".into() };
        s.save(&d).unwrap();
        assert_eq!(State::load(&d), s);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn local_day_is_a_date() {
        let (d, h) = local_day_hour(0);
        assert_eq!(d.len(), 10);
        assert!(h < 24);
    }
}
