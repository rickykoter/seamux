//! The workspace doctor: what is broken about the app's tmux workspaces, and
//! what would fix each thing (docs/adr: the engine lives in crew-core, behind
//! `seamux workspace-doctor`; the doctor covers the tmux backend only).
//!
//! ```text
//! seamux workspace-doctor           a summary, worst first
//! seamux workspace-doctor --json    the scan: {tmux, registry, findings}
//! seamux workspace-doctor --fix <id> [--verb v] [--dry-run]
//! seamux workspace-doctor --fix-safe [--dry-run]
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
    /// What the id names, as it was spelled (a pane id, a file name).
    pub subject: String,
    /// The pane file's `at` the scan saw (0 for none): a fix of it acts
    /// only while no hook has written since.
    pub seen_at: u64,
}

impl Finding {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "kind": self.kind, "class": self.class.name(),
            "ws": self.ws, "title": self.title, "cwd": self.cwd, "pane": self.pane,
            "summary": self.summary, "detail": self.detail, "session": self.session, "subject": self.subject,
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
    /// The archive an archive fix records into (crew-resume's).
    pub archive: PathBuf,
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
            archive: crate::workspaces::archive_path(),
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
    /// Only whether the file is there: a transcript can be tens of MB.
    fn has_transcript(&self, sid: &str) -> bool {
        std::fs::read_dir(&self.projects).map(|rd| rd.flatten().any(|d| d.path().join(format!("{sid}.jsonl")).is_file())).unwrap_or(false)
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
                        subject: String::new(),
                        seen_at: 0,
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
            subject: subject.to_string(),
            seen_at: 0,
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
            if !files.contains_key(&up(&s(g, "id"))) {
                Some("no pane file for it was found")
            } else if sid.is_empty() {
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
        // Of two or more records for one folder, the one kept: one with a
        // live pane, else one with a lost pane that can restart, else the
        // oldest. Only the others are duplicates.
        let live_in = |id: &str| seen.iter().any(|p| p.alive && p.ws.eq_ignore_ascii_case(id));
        let kept: HashMap<String, String> = by_cwd
            .iter()
            .filter(|(_, v)| v.len() > 1)
            .filter_map(|(cwd, v)| {
                let k = v
                    .iter()
                    .find(|w| live_in(&s(w, "id")))
                    .or_else(|| v.iter().find(|w| restartable.contains(&up(&s(w, "id")))))
                    .or_else(|| v.iter().min_by_key(|w| w.get("created").and_then(Value::as_u64).unwrap_or(u64::MAX)))?;
                Some((cwd.clone(), s(k, "id")))
            })
            .collect();
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
            let is_kept = kept.get(&cwd).is_none_or(|k| k.eq_ignore_ascii_case(&id));
            if twins > 1 && live == 0 && !is_kept && !restartable.contains(&up(&id)) && server == Server::Up {
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
                    f.seen_at = file.at;
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
                // No pane file at all may only mean it is in another cache
                // folder (a shell that sets XDG_CACHE_HOME): a person decides.
                let unsure = !files.contains_key(&up(&id));
                let mut f = base("dead-gone", &id, if unsure { Class::Confirm } else { Class::Safe }, &ws);
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
            let mut f = base("orphan-pane-file", p.key(), Class::Safe, &p.ws);
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

/// The shells a pane is left in when its Claude exits: only into one of
/// these is a line typed, never into a command the person started.
const SHELLS: [&str; 9] = ["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login-sh"];

/// One fix's outcome, for `fix_safe` and the tab.
#[derive(Clone, Debug, PartialEq)]
pub struct Done {
    pub id: String,
    pub verb: String,
    pub result: Result<String, String>,
}

impl Done {
    pub fn to_json(&self) -> Value {
        match &self.result {
            Ok(m) => json!({"id": self.id, "verb": self.verb, "ok": true, "message": m}),
            Err(e) => json!({"id": self.id, "verb": self.verb, "ok": false, "message": e}),
        }
    }
}

impl Doctor {
    /// Carry out fix `verb` on finding `id`. The doctor scans again and acts
    /// only on a finding that scan found, and only with a fix it offers: a
    /// state that changed since the page drew is refused with the reason.
    pub fn fix(&self, id: &str, verb: &str, dry: bool) -> Result<String, String> {
        let scan = self.scan();
        if scan.tmux == "unreachable" {
            return Err("tmux could not be asked: nothing is fixed until it answers".into());
        }
        let f = scan.find(id).ok_or("that is no longer the case: scan again")?;
        if !f.fixes.iter().any(|x| x.verb == verb) {
            return Err(format!("{} offers no {verb:?} fix", f.kind));
        }
        if dry {
            return Ok(format!("would {verb}: {}", describe(f)));
        }
        self.apply(f, verb)
    }

    /// Every safe finding's first fix, from one scan; refused when tmux
    /// cannot be asked. `dry` says what it would do.
    pub fn fix_safe(&self, dry: bool) -> Result<Vec<Done>, String> {
        let scan = self.scan();
        if scan.tmux == "unreachable" {
            return Err("tmux could not be asked: nothing is fixed until it answers".into());
        }
        Ok(scan
            .findings
            .iter()
            .filter(|f| f.class == Class::Safe)
            .filter_map(|f| f.fixes.first().map(|x| (f, x.verb)))
            .map(|(f, verb)| Done {
                id: f.id.clone(),
                verb: verb.to_string(),
                result: if dry { Ok(format!("would {verb}: {}", describe(f))) } else { self.apply(f, verb) },
            })
            .collect())
    }

    fn apply(&self, f: &Finding, verb: &str) -> Result<String, String> {
        let t = &self.tmux;
        let files = t.pane_files();
        let name = if f.title.is_empty() { short(&f.subject).to_string() } else { f.title.clone() };
        // The Bosun's pane is started only by its own ensure, with its
        // read-only flags; a plain claude line would drop them.
        let bosun = (!f.pane.is_empty() && t.kind_of_pane(&f.pane) == crate::bosun::KIND) || (!f.ws.is_empty() && t.kind_of_ws(&f.ws) == crate::bosun::KIND);
        if bosun && matches!((f.kind, verb), ("lost-pane", _) | ("claude-exited", _) | ("empty-workspace", "reopen")) {
            let w = crate::bosun::ensure_at(t, &crate::bosun::config::Config::load())?;
            return Ok(format!("the Bosun is {} (pane {})", w.how, short(&w.pane)));
        }
        match (f.kind, verb) {
            ("missing-worktree" | "duplicate-workspace", "forget") => {
                t.close_workspace(&f.ws)?;
                Ok(format!("forgot {name}"))
            }
            ("empty-workspace", "reopen") => {
                let line = crate::native::claude_line(Some(&f.session).filter(|x| !x.is_empty()).map(String::as_str))?;
                use crate::backend::Backend;
                let pane = t.start_session(&f.ws, &f.cwd, &line)?;
                Ok(format!("reopened {name} in pane {}", short(&pane)))
            }
            ("empty-workspace", "archive") => self.archive(f),
            ("merged-live", "reclaim") => Err(format!("reclaim checks what would be lost first: open the reclaim wizard, or run crew-reclaim {}", f.ws)),
            ("claude-exited", "resume" | "fresh") => {
                use crate::backend::Backend;
                let target = t.target(&f.pane)?.ok_or("its session is gone")?;
                // Every process on the pane's terminal, not tmux's foreground
                // (a shell without job control keeps its child in its own
                // group, and tmux then names the shell).
                let others = non_shells(&target).ok_or("could not tell what runs in the pane: nothing was typed")?;
                if !others.is_empty() {
                    return Err(format!("pane {} runs {}, not only its shell: nothing was typed", short(&f.pane), others.join(", ")));
                }
                let line = crate::native::claude_line(if verb == "resume" { Some(f.session.as_str()) } else { None })?;
                // Clear whatever is half-typed at the prompt, then the line.
                let _ = tmux::tmux(&target.socket, &["send-keys", "-t", &tmux::pane_of(&target), "C-u"]);
                tmux::send_text(&target, &format!("{line}\r"))?;
                Ok(format!("started {line} in {name}"))
            }
            ("stuck-working", "end") => {
                // The write the scan saw: a hook that wrote since wins.
                if status::end_stale(&files, &f.pane, f.seen_at) {
                    Ok(format!("marked pane {} ended", short(&f.pane)))
                } else {
                    Err("its pane file changed meanwhile".into())
                }
            }
            ("dead-pane", "drop") => {
                use crate::backend::Backend;
                t.workspaces()?;
                let still = list(&t.registry()?, "panes").iter().any(|p| s(p, "id").eq_ignore_ascii_case(&f.pane));
                if still {
                    return Err(format!("pane {} is still on the registry: tmux may not have answered", short(&f.pane)));
                }
                Ok(format!("dropped pane {}", short(&f.pane)))
            }
            ("dead-gone", "forget") => {
                t.forget(&f.pane)?;
                Ok(format!("forgot pane {}", short(&f.pane)))
            }
            ("lost-pane", "restart") => {
                t.restart(&f.pane, &crate::native::claude_line(Some(&f.session))?)?;
                Ok(format!("restarted pane {} in {name}", short(&f.pane)))
            }
            ("orphan-session", "adopt") => {
                let session = format!("seamux-{}", f.pane);
                t.adopt(&f.ws, &f.title, &f.cwd, &f.pane, &t.socket(), &session)?;
                Ok(format!("adopted {session} into {name}"))
            }
            ("orphan-session", "kill") => {
                let o = tmux::tmux(&t.socket(), &["kill-session", "-t", &format!("=seamux-{}", f.pane)]).map_err(|e| e.to_string())?;
                if !o.status.success() {
                    return Err(format!("tmux kill-session: {}", String::from_utf8_lossy(&o.stderr).trim()));
                }
                Ok(format!("ended seamux-{}", short(&f.pane)))
            }
            ("orphan-pane-file", "delete") => {
                status::remove(&files, &f.subject);
                crate::held::remove(&files, &f.subject);
                for left in [status::path(&files, &f.subject), crate::held::path(&files, &f.subject)] {
                    if left.exists() {
                        return Err(format!("could not delete {}", left.display()));
                    }
                }
                Ok(format!("deleted pane-{}.json", short(&f.subject)))
            }
            ("orphan-held", "delete") => {
                crate::held::remove(&files, &f.subject);
                if crate::held::path(&files, &f.subject).exists() {
                    return Err(format!("could not delete held-{}.json", f.subject));
                }
                Ok(format!("deleted held-{}.json", short(&f.subject)))
            }
            ("registry-tmp", "delete") => {
                std::fs::remove_file(t.dir().join(&f.subject)).map_err(|e| e.to_string())?;
                Ok(format!("deleted {}", f.subject))
            }
            (kind, verb) => Err(format!("no {verb:?} fix for {kind}")),
        }
    }

    /// Archive an empty workspace: remember it as crew-resume's archive does
    /// (restore reopens it under its old id, resuming its newest session),
    /// then close it. deep-plan's guard is asked first and is not overridden.
    fn archive(&self, f: &Finding) -> Result<String, String> {
        if f.cwd.is_empty() {
            return Err("it has no folder to remember".into());
        }
        let name = if f.title.is_empty() { f.cwd.clone() } else { f.title.clone() };
        let (ok, why) = crate::workspaces::guard(&f.cwd, &name, false);
        if !ok {
            return Err(why);
        }
        let rec = json!({
            "cwd": f.cwd, "title": f.title, "color": "",
            "branch": if Path::new(&f.cwd).is_dir() { crate::workspaces::branch(&f.cwd) } else { String::new() },
            "session_id": f.session,
            "sessions": if f.session.is_empty() { json!([]) } else { json!([f.session]) },
            "workspace_id": f.ws,
            "archived_at": crate::pyjson::float(crate::py::now()),
        });
        let mut rec = rec;
        let before = crate::workspaces::update_at(&self.archive, |recs| {
            // An earlier archive of this folder: its sessions carry on, as
            // archive_with keeps them.
            let prev = recs.get(&f.cwd).cloned();
            if let Some(p) = prev.as_ref() {
                let mut all = rec["sessions"].as_array().cloned().unwrap_or_default();
                for x in p.get("sessions").and_then(Value::as_array).into_iter().flatten() {
                    if !all.contains(x) {
                        all.push(x.clone());
                    }
                }
                rec["sessions"] = Value::Array(all);
                if rec["session_id"].as_str().unwrap_or("").is_empty() {
                    rec["session_id"] = p.get("session_id").cloned().unwrap_or(json!(""));
                }
            }
            recs.insert(f.cwd.clone(), rec);
            prev
        })
        .map_err(|e| format!("could not write the archive ({e})"))?;
        if let Err(e) = self.tmux.close_workspace(&f.ws) {
            let _ = crate::workspaces::update_at(&self.archive, |recs| match before {
                Some(b) => recs.insert(f.cwd.clone(), b),
                None => recs.remove(&f.cwd),
            });
            return Err(e);
        }
        Ok(format!("archived {name}"))
    }
}

/// What runs on `t`'s terminal besides a shell, by name; None when tmux or
/// ps does not say.
fn non_shells(t: &crate::backend::Target) -> Option<Vec<String>> {
    let tty = tmux::pane_tty(t)?;
    let ps = crate::py::env_or("CREW_PS").unwrap_or_else(|| "/bin/ps".into());
    let out = std::process::Command::new(ps).args(["-t", &tty, "-o", "comm="]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().trim_start_matches('-').rsplit('/').next().unwrap_or("").to_string())
            .filter(|n| !n.is_empty() && !SHELLS.contains(&n.as_str()))
            .collect(),
    )
}

fn describe(f: &Finding) -> String {
    let who = if f.title.is_empty() { short(&f.subject).to_string() } else { f.title.clone() };
    format!("{who} ({})", f.summary)
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
    let has = |f: &str| args.iter().any(|a| a == f);
    let value = |f: &str| args.iter().position(|a| a == f).map(|i| args.get(i + 1).filter(|v| !v.starts_with("--")).cloned());
    if has("-h") || has("--help") {
        println!(
            "seamux workspace-doctor [--json]          what is broken, worst first
seamux workspace-doctor --fix <id> [--verb <verb>] [--dry-run]
                                          one finding's fix (its first, or --verb)
seamux workspace-doctor --fix-safe [--dry-run]
                                          every safe finding's fix

What is broken about the app's tmux workspaces, and what would fix it. A fix
scans again first and acts only on a finding that scan found."
        );
        return 0;
    }
    let d = Doctor::default();
    let (json_out, dry) = (has("--json"), has("--dry-run"));
    if has("--fix-safe") {
        let done = match d.fix_safe(dry) {
            Ok(done) => done,
            Err(e) => {
                eprintln!("workspace-doctor: {e}");
                return 1;
            }
        };
        if json_out {
            println!("{}", serde_json::to_string_pretty(&done.iter().map(Done::to_json).collect::<Vec<_>>()).unwrap_or_default());
        } else if done.is_empty() {
            println!("nothing safe to fix");
        } else {
            for x in &done {
                match &x.result {
                    Ok(m) => println!("✓ {m}"),
                    Err(e) => println!("✗ {}: {e}", x.id),
                }
            }
        }
        return if done.iter().all(|x| x.result.is_ok()) { 0 } else { 1 };
    }
    if let Some(id) = value("--fix") {
        let Some(id) = id else {
            eprintln!("workspace-doctor: --fix takes a finding id (see --json)");
            return 1;
        };
        let verb = match value("--verb") {
            Some(Some(v)) => v,
            Some(None) => {
                eprintln!("workspace-doctor: --verb takes a fix's verb");
                return 1;
            }
            None => match d.scan().find(&id).and_then(|f| f.fixes.first().map(|x| x.verb.to_string())) {
                Some(v) => v,
                None => {
                    eprintln!("workspace-doctor: {id} is not a finding with a fix now");
                    return 1;
                }
            },
        };
        return match d.fix(&id, &verb, dry) {
            Ok(m) => {
                println!("✓ {m}");
                0
            }
            Err(e) => {
                eprintln!("workspace-doctor: {e}");
                1
            }
        };
    }
    let scan = d.scan();
    if json_out {
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
            let archive = root.join("cache/archive.json");
            Fx { d: Doctor { tmux, projects: root.join("projects"), plans: root.join("plans"), other_cache: None, archive }, root }
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
        // Two records with no pane for one folder: the oldest stays.
        let pair = f.wt("pair");
        let (o1, _) = t.open_workspace(&pair, "sleep 600").unwrap();
        let (o2, _) = t.open_workspace(&pair, "sleep 600").unwrap();
        for w in [&o1, &o2] {
            t.close_pane(&t.panes(Some(w)).unwrap()[0].id).unwrap();
        }
        let scan = f.d.scan();
        let pd: Vec<_> = scan.findings.iter().filter(|x| x.kind == "duplicate-workspace" && x.cwd == pair.to_string_lossy()).collect();
        assert_eq!(pd.len(), 1, "only one of the pair is a duplicate: {pd:?}");
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
        assert_eq!(scan.find(&format!("dead-gone:{}", b.to_uppercase())).map(|x| x.class), Some(Class::Confirm), "no pane file at all: a person decides");
        f.pane_file(&b, &ws, "", "idle");
        assert_eq!(f.d.scan().find(&format!("dead-gone:{}", b.to_uppercase())).map(|x| x.class), Some(Class::Safe), "a file with no session is safe to forget");
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
        assert!(f.d.fix_safe(true).unwrap_err().contains("could not be asked"), "refused, not 'nothing to fix'");
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

    fn ids(scan: &Scan, kind: &str) -> Vec<String> {
        scan.findings.iter().filter(|x| x.kind == kind).map(|x| x.id.clone()).collect()
    }

    fn screen(t: &crate::backend::Target) -> String {
        tmux::tmux(&t.socket, &["capture-pane", "-p", "-t", &tmux::pane_of(t)]).map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
    }

    #[test]
    fn a_fix_acts_only_on_a_finding_the_fresh_scan_found() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("stale");
        let t = &f.d.tmux;
        let (ws, _) = t.open_workspace(&f.wt("s"), "sleep 600").unwrap();
        t.close_pane(&t.panes(Some(&ws)).unwrap()[0].id).unwrap();
        let id = format!("empty-workspace:{}", ws.to_uppercase());
        assert!(f.d.scan().find(&id).is_some());
        assert!(f.d.fix(&id, "kill", false).unwrap_err().contains("offers no"), "a verb it does not offer");
        assert!(f.d.fix(&id, "reopen", true).unwrap().starts_with("would reopen"));
        assert!(f.d.scan().find(&id).is_some(), "a dry run changes nothing");
        f.d.fix(&id, "reopen", false).unwrap();
        assert_eq!(t.panes(Some(&ws)).unwrap().len(), 1, "reopened with a pane");
        let e = f.d.fix(&id, "reopen", false).unwrap_err();
        assert!(e.contains("no longer"), "the second click finds it fixed: {e}");
        assert!(f.d.fix("empty-workspace:NOPE", "reopen", false).is_err());
    }

    #[test]
    fn a_resume_is_typed_only_into_a_bare_shell() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("type");
        let t = &f.d.tmux;
        let wt = f.wt("t");
        let cwd = wt.to_string_lossy().into_owned();
        let (ws, _) = t.open_workspace(&wt, "true").unwrap();
        let shell = t.panes(Some(&ws)).unwrap()[0].id.clone();
        let busy = t.start_session(&ws, &cwd, "sleep 600").unwrap();
        let sid = "cccccccc-2222-4333-8444-555555555555";
        f.pane_file(&shell, &ws, sid, "idle");
        f.transcript(&wt, sid);
        std::thread::sleep(std::time::Duration::from_millis(1200));
        // sleep is the foreground of the second pane: nothing is typed there.
        let e = f.d.fix(&format!("claude-exited:{}", busy.to_uppercase()), "fresh", false).unwrap_err();
        assert!(e.contains("sleep") && e.contains("nothing was typed"), "{e}");
        f.d.fix(&format!("claude-exited:{}", shell.to_uppercase()), "resume", false).unwrap();
        let target = t.target(&shell).unwrap().unwrap();
        let mut seen = String::new();
        for _ in 0..30 {
            seen = screen(&target);
            if seen.contains(&format!("claude --resume {sid}")) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(seen.contains(&format!("claude --resume {sid}")), "typed into the shell: {seen}");
    }

    #[test]
    fn fix_all_safe_cleans_leftovers_and_leaves_the_rest() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("safe");
        let t = &f.d.tmux;
        let wt = f.wt("x");
        let cwd = wt.to_string_lossy().into_owned();
        let (ws, _) = t.open_workspace(&wt, "true").unwrap();
        let stuck = t.panes(Some(&ws)).unwrap()[0].id.clone();
        f.pane_file(&stuck, &ws, "", "working");
        let lost = t.start_session(&ws, &cwd, "sleep 600").unwrap();
        let orphan = "CCCCCCCC-2222-4333-8444-555555555555";
        f.pane_file(orphan, &ws, "", "working");
        fs::write(t.pane_files().join("held-EEEEEEEE-2222-4333-8444-555555555555.json"), "{}").unwrap();
        fs::write(t.dir().join("workspaces.json.999999.tmp"), "{}").unwrap();
        // The second pane is lost with no session: it can never restart.
        tmux::tmux(&t.socket(), &["kill-session", "-t", &format!("=seamux-{lost}")]).unwrap();
        let before = f.d.scan();
        let safe: Vec<&Finding> = before.findings.iter().filter(|x| x.class == Class::Safe).collect();
        assert!(safe.len() >= 4, "{:?}", before.findings);
        let dry = f.d.fix_safe(true).unwrap();
        assert_eq!(dry.len(), safe.len());
        assert_eq!(f.d.scan(), before, "a dry run changes nothing");
        let done = f.d.fix_safe(false).unwrap();
        assert!(done.iter().all(|x| x.result.is_ok()), "{done:?}");
        let after = f.d.scan();
        assert!(after.findings.iter().all(|x| x.class != Class::Safe), "{:?}", after.findings);
        assert_eq!(ids(&after, "claude-exited").len(), 1, "a confirm finding is left for a person");
        assert_eq!(status::read(&t.pane_files(), &stuck).map(|p| p.state), Some("ended".into()));
        assert!(status::read(&t.pane_files(), orphan).is_none());
        assert!(!t.dir().join("workspaces.json.999999.tmp").exists());
    }

    #[test]
    fn archive_forget_adopt_and_kill() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("conf");
        let t = &f.d.tmux;
        // An empty workspace with a transcript: archived, resumable.
        let wt = f.wt("arch");
        let (ws, _) = t.open_workspace(&wt, "sleep 600").unwrap();
        t.close_pane(&t.panes(Some(&ws)).unwrap()[0].id).unwrap();
        let sid = "dddddddd-2222-4333-8444-555555555555";
        f.transcript(&wt, sid);
        // An earlier archive of the same folder: its session is kept.
        let old = "99999999-2222-4333-8444-555555555555";
        let key = wt.to_string_lossy().into_owned();
        crate::workspaces::update_at(&f.d.archive, |r| r.insert(key.clone(), json!({"cwd": key, "session_id": old, "sessions": [old]}))).unwrap();
        f.d.fix(&format!("empty-workspace:{}", ws.to_uppercase()), "archive", false).unwrap();
        let rec = crate::workspaces::load_archive_at(&f.d.archive).get(&wt.to_string_lossy().into_owned()).cloned().expect("archived");
        assert_eq!((rec["session_id"].as_str(), rec["workspace_id"].as_str()), (Some(sid), Some(ws.as_str())));
        assert_eq!(rec["sessions"], json!([sid, old]), "the earlier archive's session carries on");
        use crate::backend::Backend;
        assert!(t.workspaces().unwrap().iter().all(|w| w.id != ws), "closed");
        // A deleted worktree, forgotten.
        let gone = f.wt("gone");
        let (g, _) = t.open_workspace(&gone, "sleep 600").unwrap();
        fs::remove_dir_all(&gone).unwrap();
        f.d.fix(&format!("missing-worktree:{}", g.to_uppercase()), "forget", false).unwrap();
        assert!(t.workspaces().unwrap().iter().all(|w| w.id != g));
        // Two stray sessions: one adopted into its workspace, one ended.
        let keep = f.wt("keep");
        let (k, _) = t.open_workspace(&keep, "sleep 600").unwrap();
        let (a, b) = (tmux::new_id(), tmux::new_id());
        for id in [&a, &b] {
            let env = format!("SEAMUX_WORKSPACE_ID={k}");
            tmux::tmux(&t.socket(), &["new-session", "-d", "-s", &format!("seamux-{id}"), "-e", &env, "sleep 600"]).unwrap();
        }
        f.d.fix(&format!("orphan-session:{}", a.to_uppercase()), "adopt", false).unwrap();
        f.d.fix(&format!("orphan-session:{}", b.to_uppercase()), "kill", false).unwrap();
        assert!(t.panes(Some(&k)).unwrap().iter().any(|p| p.id == a), "adopted");
        assert!(ids(&f.d.scan(), "orphan-session").is_empty());
        // Reclaim is the wizard's, never done here.
        assert!(f.d.apply(&Finding { kind: "merged-live", ..f.d.scan().findings[0].clone() }, "reclaim").unwrap_err().contains("reclaim wizard"));
    }

    #[test]
    fn of_two_records_the_one_with_a_pane_to_restart_is_kept() {
        if !have_tmux() {
            return;
        }
        let f = Fx::new("dupgone");
        let t = &f.d.tmux;
        let wt = f.wt("d");
        // The older record is empty; the newer one's pane is lost with its
        // server and could restart.
        let (old, _) = t.open_workspace(&wt, "sleep 600").unwrap();
        t.close_pane(&t.panes(Some(&old)).unwrap()[0].id).unwrap();
        let (new, _) = t.open_workspace(&wt, "sleep 600").unwrap();
        let pane = t.panes(Some(&new)).unwrap()[0].id.clone();
        let sid = "eeeeeeee-2222-4333-8444-555555555555";
        f.pane_file(&pane, &new, sid, "idle");
        f.transcript(&wt, sid);
        tmux::tmux(&t.socket(), &["kill-server"]).unwrap();
        // A server again (another workspace), the pane now in gone[].
        t.open_workspace(&f.wt("other"), "sleep 600").unwrap();
        let scan = f.d.scan();
        assert!(scan.find(&format!("lost-pane:{}", pane.to_uppercase())).is_some(), "{:?}", scan.findings);
        assert!(scan.find(&format!("duplicate-workspace:{}", new.to_uppercase())).is_none(), "the record with a pane to restart stays");
        assert!(scan.find(&format!("duplicate-workspace:{}", old.to_uppercase())).is_some(), "the empty one is the duplicate");
    }
}
