//! The workspace doctor: what is broken about the app's tmux workspaces, and
//! what would fix each thing (docs/adr: the engine lives in crew-core, behind
//! `seamux workspace-doctor`; the doctor covers the tmux backend only).
//!
//! ```text
//! seamux workspace-doctor           a summary, worst first
//! seamux workspace-doctor --json    the scan: {tmux, registry, findings}
//! ```
//!
//! A scan reads and never writes: the registry without its lock or a prune,
//! the sessions on the app's tmux.sock, one `ps` per live pane, crew's pane
//! and held files, Claude's transcripts and deep-plan's state. Each finding
//! has a stable id (its kind and subject), a class, and the fixes it offers:
//!
//! - `safe`: touches only files and records nothing runs from (Fix all safe)
//! - `confirm`: ends a session, drops a workspace record or types into a pane
//! - `report`: nothing to fix from here
//!
//! While tmux cannot be asked, no finding carries a fix: a failed call is no
//! proof a pane is gone.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::backend::tmux::{self, server_says, Server, TmuxBackend};
use crate::status;

/// How bold a fix is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Class {
    Confirm,
    Report,
    Safe,
}

impl Class {
    pub fn name(self) -> &'static str {
        match self {
            Class::Safe => "safe",
            Class::Confirm => "confirm",
            Class::Report => "report",
        }
    }
}

/// One fix a finding offers: what `fix` is asked (`verb`) and its button.
#[derive(Clone, Debug, PartialEq)]
pub struct Fix {
    pub verb: &'static str,
    pub label: String,
}

fn fix(verb: &'static str, label: impl Into<String>) -> Fix {
    Fix { verb, label: label.into() }
}

/// One thing wrong.
#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    /// `<kind>:<subject>`, the same on every scan while the state holds.
    pub id: String,
    pub kind: &'static str,
    pub class: Class,
    /// The workspace it is about ("" for none), its title and folder.
    pub ws: String,
    pub title: String,
    pub cwd: String,
    /// The pane it is about, or "".
    pub pane: String,
    /// One line, for the row.
    pub summary: String,
    /// What was seen, for the disclosure.
    pub detail: String,
    pub fixes: Vec<Fix>,
    /// The session id a resume would use, when there is one.
    pub session: String,
}

impl Finding {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "kind": self.kind, "class": self.class.name(),
            "ws": self.ws, "title": self.title, "cwd": self.cwd, "pane": self.pane,
            "summary": self.summary, "detail": self.detail, "session": self.session,
            "fixes": self.fixes.iter().map(|f| json!({"verb": f.verb, "label": f.label})).collect::<Vec<_>>(),
        })
    }
}

/// A scan: whether tmux and the registry could be read, and the findings.
#[derive(Clone, Debug, PartialEq)]
pub struct Scan {
    /// "ok", "gone" (no server: every pane was lost with it) or "unreachable".
    pub tmux: &'static str,
    /// "ok", or why the registry could not be read.
    pub registry: String,
    pub findings: Vec<Finding>,
}

impl Scan {
    pub fn to_json(&self) -> Value {
        json!({
            "tmux": self.tmux, "registry": self.registry,
            "findings": self.findings.iter().map(Finding::to_json).collect::<Vec<_>>(),
        })
    }

    pub fn find(&self, id: &str) -> Option<&Finding> {
        self.findings.iter().find(|f| f.id == id)
    }
}

/// Where the doctor looks. `Doctor::default()` is this machine's; tests
/// point every folder at a temp dir.
pub struct Doctor {
    pub tmux: TmuxBackend,
    /// Claude Code's transcripts: `~/.claude/projects`.
    pub projects: PathBuf,
    /// deep-plan's state files: `~/.claude/deep-plan/state`.
    pub plans: PathBuf,
    /// A second pane-file folder readers once used (home_cache), when it is
    /// not the one the hooks write: its pane files are reported.
    pub other_cache: Option<PathBuf>,
}

impl Default for Doctor {
    fn default() -> Self {
        let home = crate::py::home();
        let (hc, xc) = (crate::home::home_cache(), crate::home::xdg_cache());
        Doctor {
            tmux: TmuxBackend::default(),
            projects: home.join(".claude/projects"),
            plans: home.join(".claude/deep-plan/state"),
            other_cache: (hc != xc).then_some(hc),
        }
    }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn list(reg: &Value, k: &str) -> Vec<Value> {
    reg.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn up(x: &str) -> String {
    x.to_ascii_uppercase()
}

/// A short id for a line a person reads.
fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

/// A pane on the registry, as the scan saw it.
struct Seen {
    rec: Value,
    id: String,
    ws: String,
    /// Its session exists.
    alive: bool,
    /// A claude process runs on its terminal; None when tmux or ps did not say.
    claude: Option<bool>,
    file: Option<status::Pane>,
}

impl Doctor {
    /// Whether a transcript for Claude session `sid` exists anywhere.
    fn has_transcript(&self, sid: &str) -> bool {
        crate::backend::migrate::transcript_cwd(&self.projects, sid).is_some()
            || std::fs::read_dir(&self.projects)
                .map(|rd| rd.flatten().any(|d| d.path().join(format!("{sid}.jsonl")).is_file()))
                .unwrap_or(false)
    }

    /// The newest transcript Claude stored for `cwd`: its session id.
    pub fn newest_session(&self, cwd: &str) -> Option<String> {
        let dir = self.projects.join(crate::home::project_dir(Path::new("/"), cwd).file_name()?);
        std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let id = p.file_stem()?.to_str()?.to_string();
                if p.extension()? != "jsonl" || !cmux::is_uuid(&id) {
                    return None;
                }
                Some((e.metadata().ok()?.modified().ok()?, id))
            })
            .max()
            .map(|(_, id)| id)
    }

    /// The sessions on the app's tmux.sock, by name; None when tmux cannot say.
    fn sessions(&self) -> Option<Vec<String>> {
        let o = tmux::tmux(&self.tmux.socket(), &["list-sessions", "-F", "#{session_name}"]).ok()?;
        if o.status.success() {
            return Some(String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect());
        }
        tmux::server_gone(&String::from_utf8_lossy(&o.stderr)).then(Vec::new)
    }

    /// The workspace a session was started for (its SEAMUX_WORKSPACE_ID).
    fn session_ws(&self, session: &str) -> String {
        tmux::tmux(&self.tmux.socket(), &["show-environment", "-t", &format!("={session}"), "SEAMUX_WORKSPACE_ID"])
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().strip_prefix("SEAMUX_WORKSPACE_ID=").map(str::to_string))
            .unwrap_or_default()
    }

    /// Look. Reads only.
    pub fn scan(&self) -> Scan {
        let reg = match self.tmux.registry() {
            Ok(r) => r,
            Err(e) => {
                return Scan {
                    tmux: "unreachable",
                    registry: e.clone(),
                    findings: vec![Finding {
                        id: "registry:unreadable".into(),
                        kind: "registry-unreadable",
                        class: Class::Report,
                        ws: String::new(),
                        title: String::new(),
                        cwd: String::new(),
                        pane: String::new(),
                        summary: "the workspace registry cannot be read".into(),
                        detail: format!("{e}. Nothing reads or writes it until it parses again; move it aside to start over."),
                        fixes: vec![],
                        session: String::new(),
                    }],
                };
            }
        };
        let server = server_says(&self.tmux.socket());
        let tmux_state = match server {
            Server::Up => "ok",
            Server::Gone => "gone",
            Server::Unknown => "unreachable",
        };
        let mut out = Vec::new();
        self.look(&reg, server, &mut out);
        if server == Server::Unknown {
            for f in &mut out {
                f.fixes.clear();
                f.class = Class::Report;
            }
        }
        out.sort_by(|a, b| (a.class, a.title.to_lowercase(), a.kind, &a.id).cmp(&(b.class, b.title.to_lowercase(), b.kind, &b.id)));
        Scan { tmux: tmux_state, registry: "ok".into(), findings: out }
    }

    fn look(&self, reg: &Value, server: Server, out: &mut Vec<Finding>) {
        let files_dir = self.tmux.pane_files();
        let files: HashMap<String, status::Pane> = status::all(&files_dir).into_iter().map(|p| (up(p.key()), p)).collect();
        let workspaces = list(reg, "workspaces");
        let by_ws: HashMap<String, &Value> = workspaces.iter().map(|w| (up(&s(w, "id")), w)).collect();
        let title_of = |ws: &str| by_ws.get(&up(ws)).map(|w| s(w, "title")).unwrap_or_default();
        let cwd_of = |ws: &str| by_ws.get(&up(ws)).map(|w| s(w, "cwd")).unwrap_or_default();
        let base = |kind: &'static str, subject: &str, class: Class, ws: &str| Finding {
            id: format!("{kind}:{}", up(subject)),
            kind,
            class,
            ws: ws.to_string(),
            title: title_of(ws),
            cwd: cwd_of(ws),
            pane: String::new(),
            summary: String::new(),
            detail: String::new(),
            fixes: vec![],
            session: String::new(),
        };

        // The registry's panes, as tmux and ps see them now.
        let seen: Vec<Seen> = list(reg, "panes")
            .into_iter()
            .map(|rec| {
                let t = self.tmux.target_of(&rec);
                let alive = server != Server::Unknown && self.tmux.has_session(&t);
                let claude = if alive { tmux::claude_on(&t) } else { None };
                let id = s(&rec, "id");
                Seen { file: files.get(&up(&id)).cloned(), ws: s(&rec, "ws"), id, alive, claude, rec }
            })
            .collect();
        let gone = list(reg, "gone");
        let live_ids: HashSet<String> = seen.iter().filter(|p| p.alive).map(|p| up(&p.id)).collect();
        let known_ids: HashSet<String> = seen.iter().map(|p| up(&p.id)).chain(gone.iter().map(|g| up(&s(g, "id")))).collect();
        let running_sessions: HashMap<String, String> = seen
            .iter()
            .filter(|p| p.alive && p.claude != Some(false))
            .filter_map(|p| p.file.as_ref().filter(|f| !f.session.is_empty() && f.state != "ended").map(|f| (f.session.clone(), p.id.clone())))
            .collect();

        // Panes lost with their server, and which of them can restart: a
        // session to resume, its folder and workspace still there, its
        // transcript kept, and no other pane running it.
        let lost: Vec<Value> = if server == Server::Gone { list(reg, "panes").into_iter().chain(gone.clone()).collect() } else { gone.clone() };
        let session_of = |id: &str| files.get(&up(id)).map(|f| f.session.clone()).unwrap_or_default();
        let why_not = |g: &Value| -> Option<&'static str> {
            let (sid, cwd, ws) = (session_of(&s(g, "id")), s(g, "cwd"), s(g, "ws"));
            if sid.is_empty() {
                Some("it has no Claude session to resume")
            } else if !Path::new(&cwd).is_dir() {
                Some("its folder is gone")
            } else if !by_ws.contains_key(&up(&ws)) {
                Some("its workspace is gone")
            } else if running_sessions.contains_key(&sid) {
                Some("its session runs in another pane")
            } else if !self.has_transcript(&sid) {
                Some("its session has no transcript")
            } else {
                None
            }
        };
        let restartable: HashSet<String> = lost.iter().filter(|g| why_not(g).is_none()).map(|g| up(&s(g, "ws"))).collect();

        // Workspaces: a folder that went, two records for one folder, none
        // with a pane (or only lost ones that can never restart), a merged
        // branch still open.
        let mut by_cwd: HashMap<String, Vec<&Value>> = HashMap::new();
        for w in &workspaces {
            by_cwd.entry(s(w, "cwd")).or_default().push(w);
        }
        for w in &workspaces {
            let (id, cwd) = (s(w, "id"), s(w, "cwd"));
            let panes: Vec<&Seen> = seen.iter().filter(|p| p.ws.eq_ignore_ascii_case(&id)).collect();
            let live = panes.iter().filter(|p| p.alive).count();
            let lost = restartable.contains(&up(&id));
            if !cwd.is_empty() && !Path::new(&cwd).is_dir() {
                let mut f = base("missing-worktree", &id, Class::Confirm, &id);
                f.summary = "its worktree was deleted".into();
                f.detail = format!("{cwd} is not a folder any more{}.", if live > 0 { format!("; {live} pane(s) still run in the workspace") } else { String::new() });
                f.fixes = vec![fix("forget", "Close and forget")];
                out.push(f);
                continue;
            }
            let twins = by_cwd.get(&cwd).map(|v| v.len()).unwrap_or(0);
            if twins > 1 && live == 0 && server == Server::Up {
                let mut f = base("duplicate-workspace", &id, Class::Confirm, &id);
                f.summary = format!("registered {twins} times for one folder");
                f.detail = format!("Another workspace record holds {cwd}; this one ({}) has no pane.", short(&id));
                f.fixes = vec![fix("forget", "Remove this record")];
                out.push(f);
                continue;
            }
            if live == 0 && !lost && server != Server::Unknown {
                let mut f = base("empty-workspace", &id, Class::Confirm, &id);
                f.summary = "open, but has no pane".into();
                f.detail = "The registry keeps it, so it counts as open, but the Dock shows nothing for it.".into();
                let label = match self.newest_session(&cwd) {
                    Some(sid) => {
                        f.session = sid.clone();
                        format!("Reopen, resuming {}", short(&sid))
                    }
                    None => "Reopen with a new Claude".to_string(),
                };
                f.fixes = vec![fix("reopen", label), fix("archive", "Archive")];
                out.push(f);
            }
            let merged = w.get("pr").and_then(|p| p.get("state")).and_then(Value::as_str) == Some("MERGED");
            if merged && live > 0 {
                let n = w.get("pr").and_then(|p| p.get("n")).and_then(Value::as_u64).unwrap_or(0);
                let mut f = base("merged-live", &id, Class::Confirm, &id);
                f.summary = format!("PR #{n} merged; the workspace is still open");
                f.detail = "Its branch has landed. Reclaim checks what would be lost, then closes it and removes the worktree.".into();
                f.fixes = vec![fix("reclaim", "Reclaim…")];
                out.push(f);
            }
        }

        // Live panes: a Claude that is gone, a file that still says working,
        // two panes on one session.
        let mut by_session: HashMap<String, Vec<&Seen>> = HashMap::new();
        for p in seen.iter().filter(|p| p.alive) {
            let sid = p.file.as_ref().map(|f| f.session.clone()).unwrap_or_default();
            if p.claude == Some(false) {
                let mut f = base("claude-exited", &p.id, Class::Confirm, &p.ws);
                f.pane = p.id.clone();
                f.summary = "Claude exited; the pane is a bare shell".into();
                if !sid.is_empty() && self.has_transcript(&sid) && !running_sessions.contains_key(&sid) {
                    f.session = sid.clone();
                    f.detail = format!("No claude runs on pane {}. Its last session was {}.", short(&p.id), short(&sid));
                    f.fixes = vec![fix("resume", format!("Resume {}", short(&sid))), fix("fresh", "New Claude")];
                } else {
                    f.detail = if sid.is_empty() {
                        format!("No claude runs on pane {}, and it has no session to resume.", short(&p.id))
                    } else if running_sessions.contains_key(&sid) {
                        format!("No claude runs on pane {}. Its session {} runs in another pane.", short(&p.id), short(&sid))
                    } else {
                        format!("No claude runs on pane {}. Its session {} has no transcript.", short(&p.id), short(&sid))
                    };
                    f.fixes = vec![fix("fresh", "New Claude")];
                }
                out.push(f);
                if let Some(file) = p.file.as_ref().filter(|x| matches!(x.state.as_str(), "working" | "needs_input")) {
                    let mut f = base("stuck-working", &p.id, Class::Safe, &p.ws);
                    f.pane = p.id.clone();
                    f.summary = format!("says {} with no Claude", file.state.replace('_', " "));
                    f.detail = "Its pane file was never told the session ended, so the workspace reads as busy.".into();
                    f.fixes = vec![fix("end", "Mark ended")];
                    out.push(f);
                }
            }
            if p.claude != Some(false) && !sid.is_empty() && p.file.as_ref().is_some_and(|x| x.state != "ended") {
                by_session.entry(sid).or_default().push(p);
            }
        }
        for (sid, panes) in by_session.iter().filter(|(_, v)| v.len() > 1) {
            let ws = panes[0].ws.clone();
            let mut f = base("shared-session", sid, Class::Report, &ws);
            f.session = sid.clone();
            f.summary = format!("{} panes run one Claude session", panes.len());
            f.detail = format!(
                "Session {} is open in panes {}; their writes to one transcript interleave. Close all but one.",
                short(sid),
                panes.iter().map(|p| short(&p.id).to_string()).collect::<Vec<_>>().join(", ")
            );
            out.push(f);
        }

        // Panes on the registry whose session ended while the server runs:
        // the next locked read drops them.
        if server == Server::Up {
            for p in seen.iter().filter(|p| !p.alive) {
                let mut f = base("dead-pane", &p.id, Class::Safe, &p.ws);
                f.pane = p.id.clone();
                f.summary = "its session ended".into();
                f.detail = format!("Pane {} is on the registry but tmux has no {}.", short(&p.id), s(&p.rec, "session"));
                f.fixes = vec![fix("drop", "Drop it")];
                out.push(f);
            }
        }

        // Panes lost with their server: restartable, or never.
        for g in &lost {
            let (id, ws) = (s(g, "id"), s(g, "ws"));
            let sid = session_of(&id);
            let why = why_not(g);
            if why.is_none() {
                let mut f = base("lost-pane", &id, Class::Confirm, &ws);
                f.pane = id.clone();
                f.session = sid.clone();
                f.summary = "lost with its tmux server".into();
                f.detail = format!("Pane {} ran session {} until its server went (a restart or kill-server).", short(&id), short(&sid));
                f.fixes = vec![fix("restart", format!("Restart, resuming {}", short(&sid)))];
                out.push(f);
            } else {
                let why = why.unwrap_or_default();
                let mut f = base("dead-gone", &id, Class::Safe, &ws);
                f.pane = id.clone();
                f.summary = "a lost pane that can never restart".into();
                f.detail = format!("Pane {} was lost with its server, and {why}.", short(&id));
                f.fixes = vec![fix("forget", "Forget it")];
                out.push(f);
            }
        }

        // Sessions on tmux.sock the registry does not know.
        if let Some(names) = self.sessions() {
            for name in names {
                let Some(id) = name.strip_prefix("seamux-").filter(|i| cmux::is_uuid(i)) else { continue };
                if known_ids.contains(&up(id)) {
                    continue;
                }
                let ws = self.session_ws(&name);
                let home = by_ws.contains_key(&up(&ws));
                let mut f = base("orphan-session", id, Class::Confirm, if home { &ws } else { "" });
                f.pane = id.to_string();
                f.summary = "a pane the registry lost track of".into();
                f.detail = format!("tmux runs {name}, but no workspace lists it{}.", if home { "; it was started for this workspace" } else { "" });
                f.fixes = if home { vec![fix("adopt", "Adopt"), fix("kill", "End it")] } else { vec![fix("kill", "End it")] };
                out.push(f);
            }
        }

        // Leftover files: pane and held files with no pane behind them.
        for (key, p) in &files {
            if known_ids.contains(key) || !by_ws.contains_key(&up(&p.ws)) {
                // A pane we know, or a workspace that is not ours (cmux's).
                continue;
            }
            let mut f = base("orphan-pane-file", key, Class::Safe, &p.ws);
            f.pane = p.key().to_string();
            f.summary = "a pane file with no pane".into();
            f.detail = format!("pane-{}.json says {}, but its workspace has no such pane.", p.key(), p.state);
            f.fixes = vec![fix("delete", "Delete it")];
            out.push(f);
        }
        if let Ok(rd) = std::fs::read_dir(&files_dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(key) = name.strip_prefix("held-").and_then(|n| n.strip_suffix(".json")) else { continue };
                if files.contains_key(&up(key)) || live_ids.contains(&up(key)) {
                    continue;
                }
                let mut f = base("orphan-held", key, Class::Safe, "");
                f.pane = key.to_string();
                f.summary = "a held command whose pane is gone".into();
                f.detail = format!("{name} waits on a pane that has no file and does not run.");
                f.fixes = vec![fix("delete", "Delete it")];
                out.push(f);
            }
        }

        // Registry temp files a writer that died left behind.
        if let Ok(rd) = std::fs::read_dir(self.tmux.dir()) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let Some(pid) = name.strip_prefix("workspaces.json.").and_then(|n| n.strip_suffix(".tmp")).and_then(|p| p.parse::<i64>().ok()) else {
                    continue;
                };
                if status::pid_alive(pid) {
                    continue;
                }
                let mut f = base("registry-tmp", &name, Class::Safe, "");
                f.summary = "a half-written registry copy".into();
                f.detail = format!("{name} was left by process {pid}, which is gone.");
                f.fixes = vec![fix("delete", "Delete it")];
                out.push(f);
            }
        }

        // Open plans whose owner pane is gone: every other Claude is a guest.
        if let Ok(rd) = std::fs::read_dir(&self.plans) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                let Some(v) = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
                let phase = s(&v, "phase");
                if matches!(phase.as_str(), "" | "done" | "closed") {
                    continue;
                }
                let owner = v.get("owner").cloned().unwrap_or(Value::Null);
                let (surface, ws) = (s(&owner, "surface"), s(&owner, "workspace"));
                if surface.is_empty() || !by_ws.contains_key(&up(&ws)) || live_ids.contains(&up(&surface)) {
                    continue;
                }
                let slug = s(&v, "slug");
                let mut f = base("gone-owner", &slug, Class::Report, &ws);
                f.summary = format!("plan {slug} is owned by a pane that is gone");
                f.detail = format!("Its owner was pane {}. Another Claude is a guest of the plan until one writes to it from its own pane.", short(&surface));
                out.push(f);
            }
        }

        // A second pane-file folder that some reader once used.
        if let Some(other) = self.other_cache.as_ref().filter(|o| **o != files_dir) {
            let n = status::all(other).len();
            if n > 0 {
                let mut f = base("cache-split", &other.to_string_lossy(), Class::Report, "");
                f.summary = format!("{n} pane file(s) in a second cache folder");
                f.detail = format!(
                    "XDG_CACHE_HOME is set, so the hooks write to {} while {} also holds pane files. Readers now use the first; the second is left from before.",
                    files_dir.display(),
                    other.display()
                );
                out.push(f);
            }
        }
    }
}

/// A summary for a person, worst first.
pub fn summary(scan: &Scan) -> String {
    let mut out = String::new();
    match scan.tmux {
        "unreachable" => out.push_str("tmux could not be asked: nothing is fixed until it answers.\n"),
        "gone" => out.push_str("The app's tmux server is not running: its panes were lost with it.\n"),
        _ => {}
    }
    if scan.findings.is_empty() {
        out.push_str("Every workspace looks healthy.\n");
        return out;
    }
    for f in &scan.findings {
        let who = if f.title.is_empty() { f.pane.chars().take(8).collect::<String>() } else { f.title.clone() };
        out.push_str(&format!("{:<7} {:<28} {}\n", f.class.name(), who, f.summary));
    }
    let safe = scan.findings.iter().filter(|f| f.class == Class::Safe).count();
    out.push_str(&format!("\n{} finding(s), {safe} safe. --json for the details.\n", scan.findings.len()));
    out
}

/// `seamux workspace-doctor`.
pub fn main(args: &[String]) -> i32 {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("seamux workspace-doctor [--json]\n\nWhat is broken about the app's tmux workspaces, and what would fix it.");
        return 0;
    }
    let scan = Doctor::default().scan();
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string_pretty(&scan.to_json()).unwrap_or_default());
    } else {
        print!("{}", summary(&scan));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn have_tmux() -> bool {
        let ok = Command::new(crate::native::tmux_bin()).arg("-V").output().map(|o| o.status.success()).unwrap_or(false);
        if !ok && std::env::var("SEAMUX_REQUIRE_TMUX").is_ok_and(|v| v == "1") {
            panic!("tmux is not installed and SEAMUX_REQUIRE_TMUX=1");
        }
        ok
    }

    /// A doctor whose every folder is under a short temp dir, with its own
    /// tmux server (lessons L8: no test reads or writes the person's stores).
    struct Fx {
        d: Doctor,
        root: PathBuf,
    }

    impl Fx {
        fn new(tag: &str) -> Fx {
            let root = PathBuf::from(format!("/tmp/sd-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            for sub in ["state", "cache", "projects", "plans", "wt"] {
                fs::create_dir_all(root.join(sub)).unwrap();
            }
            let sh = root.join("login-sh");
            fs::write(&sh, "#!/bin/sh\nif [ \"$1\" = -lc ]; then exec /bin/sh -c \"$2\"; fi\nexec /bin/sh -i\n").unwrap();
            fs::set_permissions(&sh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
            let tmux = TmuxBackend::at(root.join("state")).with_shell(&sh.to_string_lossy()).with_pane_files(&root.join("cache"));
            Fx { d: Doctor { tmux, projects: root.join("projects"), plans: root.join("plans"), other_cache: None }, root }
        }

        fn wt(&self, name: &str) -> PathBuf {
            let p = self.root.join("wt").join(name);
            fs::create_dir_all(&p).unwrap();
            p
        }

        fn pane_file(&self, pane: &str, ws: &str, session: &str, state: &str) {
            let p = status::Pane { session: session.into(), state: state.into(), at: 1, ..status::Pane::new(ws, pane) };
            status::write(&self.d.tmux.pane_files(), &p);
        }

        fn transcript(&self, cwd: &Path, sid: &str) {
            let dir = self.d.projects.join(crate::home::project_dir(Path::new("/"), &cwd.to_string_lossy()).file_name().unwrap());
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("{sid}.jsonl")), format!("{{\"cwd\":\"{}\"}}\n", cwd.display())).unwrap();
        }

        fn kinds(&self) -> Vec<(&'static str, String)> {
            self.d.scan().findings.into_iter().map(|f| (f.kind, f.title)).collect()
        }
    }

    impl Drop for Fx {
        fn drop(&mut self) {
            let _ = tmux::tmux(&self.d.tmux.socket(), &["kill-server"]);
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    use crate::backend::Backend;

    #[test]
    fn a_healthy_registry_has_no_findings() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("ok");
        let wt = f.wt("a");
        let (ws, _) = f.d.tmux.open_workspace(&wt, "sleep 600").unwrap();
        let pane = f.d.tmux.panes(Some(&ws)).unwrap()[0].id.clone();
        f.pane_file(&pane, &ws, "", "idle");
        // sleep is not claude: the pane reads as a bare shell, so name the
        // healthy case by what is absent.
        let scan = f.d.scan();
        assert_eq!(scan.tmux, "ok");
        assert_eq!(scan.registry, "ok");
        assert!(scan.findings.iter().all(|x| x.kind == "claude-exited"), "{:?}", scan.findings);
    }

    #[test]
    fn workspace_level_states_are_found() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("ws");
        let t = &f.d.tmux;
        // One live, merged; one empty with a transcript; one whose folder
        // went; two records for one folder.
        let (live, _) = t.open_workspace(&f.wt("live"), "sleep 600").unwrap();
        t.set_facts(&live, None, Some(json!({"n": 7, "state": "MERGED", "url": ""}))).unwrap();
        let empty = f.wt("empty");
        let (e, _) = t.open_workspace(&empty, "sleep 600").unwrap();
        t.close_pane(&t.panes(Some(&e)).unwrap()[0].id).unwrap();
        f.transcript(&empty, "11111111-2222-4333-8444-555555555555");
        let gone = f.wt("gone");
        let (g, _) = t.open_workspace(&gone, "sleep 600").unwrap();
        t.close_pane(&t.panes(Some(&g)).unwrap()[0].id).unwrap();
        fs::remove_dir_all(&gone).unwrap();
        let twin = f.wt("twin");
        t.open_workspace(&twin, "sleep 600").unwrap();
        let (t2, _) = t.open_workspace(&twin, "sleep 600").unwrap();
        t.close_pane(&t.panes(Some(&t2)).unwrap()[0].id).unwrap();

        let scan = f.d.scan();
        let by = |kind: &str| scan.findings.iter().filter(|x| x.kind == kind).collect::<Vec<_>>();
        assert_eq!(by("merged-live").len(), 1);
        assert_eq!(by("merged-live")[0].fixes[0].verb, "reclaim");
        let em = by("empty-workspace");
        assert_eq!(em.len(), 1, "{:?}", scan.findings);
        assert_eq!(em[0].title, "empty");
        assert_eq!(em[0].session, "11111111-2222-4333-8444-555555555555", "reopen resumes the newest transcript");
        assert_eq!(by("missing-worktree").len(), 1);
        assert_eq!(by("missing-worktree")[0].title, "gone", "a deleted folder is that, not an empty workspace");
        let dup = by("duplicate-workspace");
        assert_eq!(dup.len(), 1);
        assert_eq!(dup[0].ws, t2, "the record without a pane is the one to drop");
        assert!(scan.findings.iter().all(|x| x.class != Class::Safe || !x.fixes.is_empty()));
    }

    #[test]
    fn a_bare_shell_and_a_stuck_file_are_found() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("pane");
        let wt = f.wt("p");
        let (ws, _) = f.d.tmux.open_workspace(&wt, "true").unwrap();
        let pane = f.d.tmux.panes(Some(&ws)).unwrap()[0].id.clone();
        let sid = "aaaaaaaa-2222-4333-8444-555555555555";
        f.pane_file(&pane, &ws, sid, "working");
        f.transcript(&wt, sid);
        let scan = f.d.scan();
        let ex = scan.find(&format!("claude-exited:{}", pane.to_uppercase())).expect("claude-exited");
        assert_eq!(ex.session, sid);
        assert_eq!(ex.fixes.iter().map(|x| x.verb).collect::<Vec<_>>(), vec!["resume", "fresh"]);
        let st = scan.find(&format!("stuck-working:{}", pane.to_uppercase())).expect("stuck-working");
        assert_eq!(st.class, Class::Safe);
        // Without its transcript only a new Claude is offered.
        fs::remove_dir_all(&f.d.projects).unwrap();
        let ex = f.d.scan().findings.into_iter().find(|x| x.kind == "claude-exited").unwrap();
        assert_eq!(ex.fixes.iter().map(|x| x.verb).collect::<Vec<_>>(), vec!["fresh"]);
    }

    #[test]
    fn lost_panes_split_into_restartable_and_never() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("lost");
        let t = &f.d.tmux;
        let wt = f.wt("l");
        let cwd = wt.to_string_lossy().into_owned();
        let (ws, _) = t.open_workspace(&wt, "sleep 600").unwrap();
        let a = t.panes(Some(&ws)).unwrap()[0].id.clone();
        let b = t.start_session(&ws, &cwd, "sleep 600").unwrap();
        let sid = "bbbbbbbb-2222-4333-8444-555555555555";
        f.pane_file(&a, &ws, sid, "idle");
        f.transcript(&wt, sid);
        tmux::tmux(&t.socket(), &["kill-server"]).unwrap();
        // Before any read moves them, the scan already counts them lost.
        let scan = f.d.scan();
        assert_eq!(scan.tmux, "gone");
        assert_eq!(scan.find(&format!("lost-pane:{}", a.to_uppercase())).map(|x| x.class), Some(Class::Confirm));
        assert_eq!(scan.find(&format!("dead-gone:{}", b.to_uppercase())).map(|x| x.class), Some(Class::Safe), "no session to resume");
        assert!(scan.findings.iter().all(|x| x.kind != "empty-workspace"), "a workspace with a pane to restart is not empty");
        // With only the pane that can never restart left, it is empty now.
        // (The forget's locked read moves both to gone first.)
        f.d.tmux.forget(&a).unwrap();
        let scan = f.d.scan();
        assert!(scan.find(&format!("dead-gone:{}", b.to_uppercase())).is_some());
        assert!(scan.find(&format!("empty-workspace:{}", ws.to_uppercase())).is_some(), "{:?}", scan.findings);
    }

    #[test]
    fn orphans_and_leftovers_are_found_and_cmux_files_are_left_alone() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("orph");
        let t = &f.d.tmux;
        let wt = f.wt("o");
        let (ws, _) = t.open_workspace(&wt, "sleep 600").unwrap();
        // A session started for this workspace that the registry never wrote.
        let stray = tmux::new_id();
        let env = format!("SEAMUX_WORKSPACE_ID={ws}");
        tmux::tmux(&t.socket(), &["new-session", "-d", "-s", &format!("seamux-{stray}"), "-e", &env, "sleep 600"]).unwrap();
        // A pane file of this workspace with no pane, one of a cmux
        // workspace, a held record with nothing behind it, a dead temp file.
        f.pane_file("CCCCCCCC-2222-4333-8444-555555555555", &ws, "", "working");
        f.pane_file("DDDDDDDD-2222-4333-8444-555555555555", "NOT-OURS", "", "working");
        fs::write(t.pane_files().join("held-EEEEEEEE-2222-4333-8444-555555555555.json"), "{}").unwrap();
        fs::write(t.dir().join("workspaces.json.999999.tmp"), "{}").unwrap();
        let scan = f.d.scan();
        let o = scan.find(&format!("orphan-session:{}", stray.to_uppercase())).expect("orphan session");
        assert_eq!(o.fixes.iter().map(|x| x.verb).collect::<Vec<_>>(), vec!["adopt", "kill"]);
        assert!(scan.find("orphan-pane-file:CCCCCCCC-2222-4333-8444-555555555555").is_some());
        assert!(scan.find("orphan-pane-file:DDDDDDDD-2222-4333-8444-555555555555").is_none(), "a cmux workspace's file is not ours");
        assert!(scan.find("orphan-held:EEEEEEEE-2222-4333-8444-555555555555").is_some());
        assert!(scan.find("registry-tmp:WORKSPACES.JSON.999999.TMP").is_some());
    }

    #[test]
    fn a_plan_owned_by_a_gone_pane_is_reported() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("plan");
        let (ws, _) = f.d.tmux.open_workspace(&f.wt("pl"), "sleep 600").unwrap();
        let plan = json!({"slug": "s1", "phase": "implementing", "owner": {"surface": "FFFFFFFF-2222-4333-8444-555555555555", "workspace": ws}});
        fs::write(f.d.plans.join("s1.json"), plan.to_string()).unwrap();
        fs::write(f.d.plans.join("s2.json"), json!({"slug": "s2", "phase": "done", "owner": plan["owner"]}).to_string()).unwrap();
        let kinds = f.kinds();
        assert_eq!(kinds.iter().filter(|(k, _)| *k == "gone-owner").count(), 1, "{kinds:?}");
    }

    #[test]
    fn nothing_is_fixable_while_tmux_cannot_be_asked() {
        let f = Fx::new("noask");
        // A plain file where the socket should be: tmux fails with "Socket
        // operation on non-socket", which says nothing about the server.
        let reg = json!({"version": 1, "workspaces": [{"id": "W", "title": "w", "cwd": "/nope"}], "panes": []});
        fs::write(f.d.tmux.dir().join("workspaces.json"), reg.to_string()).unwrap();
        fs::write(f.d.tmux.socket(), "").unwrap();
        let scan = f.d.scan();
        assert_eq!(scan.tmux, "unreachable");
        assert!(scan.findings.iter().all(|x| x.fixes.is_empty() && x.class == Class::Report));
        assert!(summary(&scan).contains("could not be asked"));
    }

    #[test]
    fn an_unreadable_registry_is_one_report() {
        let f = Fx::new("unread");
        fs::write(f.d.tmux.dir().join("workspaces.json"), "{not json").unwrap();
        let scan = f.d.scan();
        assert_ne!(scan.registry, "ok");
        assert_eq!(scan.findings.len(), 1);
        assert_eq!(scan.findings[0].kind, "registry-unreadable");
    }
}
