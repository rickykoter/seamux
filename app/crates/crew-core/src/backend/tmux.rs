//! The tmux backend: the app's own sessions, with no cmux.
//!
//! ```text
//! $XDG_STATE_HOME/seamux/        (~/.local/state/seamux)
//!   tmux.sock         the app's tmux server
//!   workspaces.json   {"version": 1,
//!                      "workspaces": [{"id", "title", "cwd", "created"}],
//!                      "panes": [{"id", "ws", "session", "cwd", "created", "socket"?}]}
//!   workspaces.lock   held while the registry is read, changed and written
//! ```
//!
//! A workspace is a record; each pane is its own tmux session, named
//! `seamux-<pane id>` and started with SEAMUX_WORKSPACE_ID, SEAMUX_PANE_ID and
//! SEAMUX_BACKEND=tmux, and with no CMUX_* variable at all. Ids are UUIDs. A
//! pane whose session has gone is dropped when the registry is read. A pane
//! may carry its own `socket` (a session adopted from elsewhere); the rest
//! use tmux.sock.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};

use super::{Backend, Kind, PaneRow, Target, WorkspaceRow};
use crate::native::{has_extkeys, sh_quote, tmux_bin, EXTKEYS_FEATURE};

pub struct TmuxBackend {
    dir: PathBuf,
}

/// `$XDG_STATE_HOME/seamux`, else `~/.local/state/seamux`.
pub fn state_dir() -> PathBuf {
    crate::py::env_or("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::py::home().join(".local/state"))
        .join("seamux")
}

impl Default for TmuxBackend {
    fn default() -> Self {
        TmuxBackend::at(state_dir())
    }
}

/// A random (version 4) UUID, upper case as cmux's are.
pub fn new_id() -> String {
    let mut b = [0u8; 16];
    let read = fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b));
    if read.is_err() {
        // Never two alike in one process, even without /dev/urandom.
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let n = t ^ ((std::process::id() as u128) << 64);
        b = n.to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// The registry's `key` list, or [].
fn list(reg: &Value, key: &str) -> Vec<Value> {
    reg.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The variables a tmux call drops: cmux's, and an outer tmux's.
pub fn scrubbed(name: &str) -> bool {
    name.starts_with("CMUX_") || name == "TMUX" || name == "TMUX_PANE"
}

/// tmux on `sock`, with no cmux (or outer tmux) in its environment: a server
/// it starts must never hand a session cmux's ids.
pub fn tmux(sock: &str, args: &[&str]) -> std::io::Result<Output> {
    let mut c = Command::new(tmux_bin());
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy();
        if scrubbed(&k) {
            c.env_remove(k.as_ref());
        }
    }
    c.arg("-S").arg(sock).args(args).stdin(Stdio::null()).output()
}

fn tmux_ok(sock: &str, args: &[&str]) -> Result<String, String> {
    let o = tmux(sock, args).map_err(|e| format!("tmux: {e}"))?;
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).into_owned())
    } else {
        Err(format!("tmux {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&o.stderr).trim()))
    }
}

impl TmuxBackend {
    /// The backend whose socket and registry live in `dir`.
    pub fn at(dir: PathBuf) -> TmuxBackend {
        TmuxBackend { dir }
    }

    pub fn socket(&self) -> String {
        self.dir.join("tmux.sock").to_string_lossy().into_owned()
    }

    fn registry_path(&self) -> PathBuf {
        self.dir.join("workspaces.json")
    }

    /// The registry as on disk; an empty one when there is no file yet. A
    /// file that is there but cannot be read is an error, so nothing writes
    /// an empty registry over it.
    fn read(&self) -> Result<Value, String> {
        let path = self.registry_path();
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"version": 1, "workspaces": [], "panes": []})),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        serde_json::from_str::<Value>(&text)
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| format!("{} is not a registry this app can read; it was left as it is", path.display()))
    }

    /// Written whole, through a temporary file and a rename.
    fn write(&self, reg: &Value) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = self.dir.join(format!("workspaces.json.{}.tmp", std::process::id()));
        fs::write(&tmp, serde_json::to_string_pretty(reg).unwrap_or_default()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.registry_path()).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })
    }

    /// Read, change and write the registry under its lock. Panes whose
    /// session has gone are dropped first.
    fn update<T>(&self, change: impl FnOnce(&mut Value) -> Result<T, String>) -> Result<T, String> {
        let _l = self.lock();
        let mut reg = self.read()?;
        let before = list(&reg, "panes").len();
        self.prune(&mut reg);
        let pruned = list(&reg, "panes").len() != before;
        match change(&mut reg) {
            Ok(t) => {
                self.write(&reg)?;
                Ok(t)
            }
            Err(e) => {
                if pruned {
                    let _ = self.write(&reg);
                }
                Err(e)
            }
        }
    }

    fn lock(&self) -> crate::status::Lock {
        crate::status::lock_file(&self.dir, "workspaces.lock")
    }

    /// The live registry: read under the lock, dead panes dropped (and
    /// written back when there were any).
    fn snapshot(&self) -> Result<Value, String> {
        self.update(|reg| Ok(reg.clone()))
    }

    fn pane_target(&self, p: &Value) -> Target {
        let socket = Some(s(p, "socket")).filter(|x| !x.is_empty()).unwrap_or_else(|| self.socket());
        Target { socket, session: s(p, "session") }
    }

    fn alive(&self, t: &Target) -> bool {
        tmux(&t.socket, &["has-session", "-t", &format!("={}", t.session)]).map(|o| o.status.success()).unwrap_or(false)
    }

    /// Drop panes whose session has gone. One lost with its whole tmux
    /// server (a reboot, a kill-server) moves to `gone`, where the app offers
    /// to restart it; one that ended while its server ran (its shell exited)
    /// is simply dropped.
    fn prune(&self, reg: &mut Value) {
        let (live, dead): (Vec<Value>, Vec<Value>) = list(reg, "panes").into_iter().partition(|p| self.alive(&self.pane_target(p)));
        if dead.is_empty() {
            return;
        }
        let mut gone = list(reg, "gone");
        for p in dead {
            let sock = self.pane_target(&p).socket;
            let server_up = tmux(&sock, &["list-sessions"]).map(|o| o.status.success()).unwrap_or(false);
            if !server_up && !gone.iter().any(|g| s(g, "id").eq_ignore_ascii_case(&s(&p, "id"))) {
                gone.push(p);
            }
        }
        reg["panes"] = Value::Array(live);
        reg["gone"] = Value::Array(gone);
    }

    /// Panes lost with their tmux server, kept for a restart: (pane id,
    /// workspace id, cwd).
    pub fn gone(&self) -> Result<Vec<(String, String, String)>, String> {
        let reg = self.snapshot()?;
        Ok(list(&reg, "gone").iter().map(|p| (s(p, "id"), s(p, "ws"), s(p, "cwd"))).collect())
    }

    /// Start a gone pane again, running `claude` in a new session that keeps
    /// the pane's id (so its pane file and SEAMUX ids carry on).
    pub fn restart(&self, pane: &str, claude: &str) -> Result<(), String> {
        let mut made = None;
        self.update(|reg| {
            let gone = list(reg, "gone");
            let p = gone.iter().find(|g| s(g, "id").eq_ignore_ascii_case(pane)).ok_or_else(|| format!("no gone pane {pane:?}"))?.clone();
            self.start_as(reg, &s(&p, "ws"), &s(&p, "cwd"), claude, &s(&p, "id"), &mut made)?;
            reg["gone"] = Value::Array(gone.into_iter().filter(|g| !s(g, "id").eq_ignore_ascii_case(pane)).collect());
            Ok(())
        })
        .map_err(|e| self.unmake(made.take(), e))
    }

    /// Drop pane `pane`'s record and leave its session running: an adopted
    /// cmux session handed back to cmux.
    pub fn release(&self, pane: &str) -> Result<(), String> {
        self.update(|reg| {
            let panes = list(reg, "panes");
            reg["panes"] = Value::Array(panes.into_iter().filter(|p| !s(p, "id").eq_ignore_ascii_case(pane)).collect());
            Ok(())
        })
    }

    /// Forget a gone pane: its restart was declined.
    pub fn forget(&self, pane: &str) -> Result<(), String> {
        self.update(|reg| {
            let gone = list(reg, "gone");
            reg["gone"] = Value::Array(gone.into_iter().filter(|g| !s(g, "id").eq_ignore_ascii_case(pane)).collect());
            Ok(())
        })
    }

    /// The server's own settings, once a session exists: no bar or prefix
    /// (Claude Code uses Ctrl-B), focus events, modified keys through, and
    /// no exit when the last session ends.
    fn configure(&self, session: &str) -> Result<(), String> {
        let sock = self.socket();
        tmux_ok(&sock, &["set-option", "-t", session, "status", "off"])?;
        tmux_ok(&sock, &["set-option", "-t", session, "prefix", "None"])?;
        tmux_ok(&sock, &["set-option", "-t", session, "prefix2", "None"])?;
        tmux_ok(&sock, &["set-option", "-s", "focus-events", "on"])?;
        // The server outlives its last session, so a server that is gone was
        // killed or the machine restarted: prune keeps those panes for a
        // restart, and drops one whose own session ended.
        tmux_ok(&sock, &["set-option", "-s", "exit-empty", "off"])?;
        tmux_ok(&sock, &["set-option", "-s", "extended-keys", "on"])?;
        tmux_ok(&sock, &["set-option", "-s", "extended-keys-format", "csi-u"])?;
        let features = tmux_ok(&sock, &["show-options", "-s", "terminal-features"]).unwrap_or_default();
        if !has_extkeys(&features) {
            tmux_ok(&sock, &["set-option", "-as", "terminal-features", EXTKEYS_FEATURE])?;
        }
        Ok(())
    }

    /// A new pane (tmux session) in workspace `ws` at `cwd` running `claude`,
    /// recorded. `$SHELL -l` runs it, so PATH is a login shell's, and stays
    /// after it so the pane outlives Claude.
    fn start(&self, reg: &mut Value, ws: &str, cwd: &str, claude: &str, made: &mut Option<String>) -> Result<String, String> {
        self.start_as(reg, ws, cwd, claude, &new_id(), made)
    }

    /// `start`, for a pane whose id is `id` (a restart keeps it).
    fn start_as(&self, reg: &mut Value, ws: &str, cwd: &str, claude: &str, id: &str, made: &mut Option<String>) -> Result<String, String> {
        if !::cmux::is_uuid(id) {
            return Err(format!("not a pane id: {id:?}"));
        }
        if !list(reg, "workspaces").iter().any(|w| s(w, "id").eq_ignore_ascii_case(ws)) {
            return Err(format!("no workspace {ws:?} in {}", self.registry_path().display()));
        }
        if !cwd.starts_with('/') || !Path::new(cwd).is_dir() {
            return Err(format!("not a directory: {cwd:?}"));
        }
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let id = id.to_string();
        let session = format!("seamux-{id}");
        let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
        let run = format!("{claude}; exec {} -l", sh_quote(&shell));
        let program = format!("{} -lc {}", sh_quote(&shell), sh_quote(&run));
        let (wenv, penv) = (format!("SEAMUX_WORKSPACE_ID={ws}"), format!("SEAMUX_PANE_ID={id}"));
        tmux_ok(
            &self.socket(),
            &[
                "new-session", "-d", "-s", &session, "-c", cwd, "-x", "160", "-y", "48",
                "-e", &wenv, "-e", &penv, "-e", "SEAMUX_BACKEND=tmux",
                "-e", "COLORTERM=truecolor", "-e", "CLAUDE_CODE_TMUX_TRUECOLOR=1",
                &program,
            ],
        )?;
        *made = Some(session.clone());
        if let Err(e) = self.configure(&session) {
            let _ = tmux(&self.socket(), &["kill-session", "-t", &format!("={session}")]);
            return Err(e);
        }
        let panes = reg["panes"].as_array_mut().ok_or("the registry has no panes list")?;
        panes.push(json!({"id": id, "ws": ws, "session": session, "cwd": cwd, "created": now_secs()}));
        Ok(id)
    }

    /// A session started for a record that was then not written: ended, so
    /// nothing runs that the registry does not know of. Passes `e` on.
    fn unmake(&self, session: Option<String>, e: String) -> String {
        if let Some(s) = session {
            let _ = tmux(&self.socket(), &["kill-session", "-t", &format!("={s}")]);
        }
        e
    }

    /// What crew-sync last published for each workspace, by id: its
    /// description tokens and its pull request ({n, state, url}, or null).
    /// They live in the registry because there is no cmux sidebar to hold them.
    pub fn facts(&self) -> Result<Vec<(String, String, Value)>, String> {
        let reg = self.read()?;
        Ok(list(&reg, "workspaces")
            .iter()
            .map(|w| (s(w, "id"), s(w, "description"), w.get("pr").cloned().unwrap_or(Value::Null)))
            .collect())
    }

    /// Set workspace `ws`'s description ("" clears it) and/or pull request
    /// (Null clears it); None leaves that one as it is. Unknown workspaces
    /// are an error.
    pub fn set_facts(&self, ws: &str, description: Option<&str>, pr: Option<Value>) -> Result<(), String> {
        self.update(|reg| {
            let all = reg["workspaces"].as_array_mut().ok_or("the registry has no workspaces list")?;
            let w = all
                .iter_mut()
                .find(|w| s(w, "id").eq_ignore_ascii_case(ws))
                .ok_or_else(|| format!("no workspace {ws:?}"))?;
            if let Some(d) = description {
                w["description"] = json!(d);
            }
            if let Some(p) = pr {
                w["pr"] = p;
            }
            Ok(())
        })
    }

    /// Whether the registry holds a live pane: someone uses this backend now.
    pub fn in_use(&self) -> bool {
        self.panes(None).map(|p| !p.is_empty()).unwrap_or(false)
    }

    /// A workspace record at `cwd`, titled by its folder: its id.
    fn add_workspace(&self, reg: &mut Value, cwd: &str) -> Result<String, String> {
        let id = new_id();
        let title = Path::new(cwd).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| cwd.to_string());
        let ws = reg["workspaces"].as_array_mut().ok_or("the registry has no workspaces list")?;
        ws.push(json!({"id": id, "title": title, "cwd": cwd, "created": now_secs()}));
        Ok(id)
    }

    /// Record `session` on `socket` (started elsewhere) as a pane of `ws`
    /// with id `id`: the migrator adopts a session where it runs.
    pub fn adopt(&self, ws: &str, title: &str, cwd: &str, id: &str, socket: &str, session: &str) -> Result<(), String> {
        self.update(|reg| {
            if !list(reg, "workspaces").iter().any(|w| s(w, "id").eq_ignore_ascii_case(ws)) {
                reg["workspaces"].as_array_mut().ok_or("no workspaces list")?.push(json!({"id": ws, "title": title, "cwd": cwd, "created": now_secs()}));
            }
            if list(reg, "panes").iter().any(|p| s(p, "id").eq_ignore_ascii_case(id)) {
                return Ok(());
            }
            reg["panes"].as_array_mut().ok_or("no panes list")?.push(json!({"id": id, "ws": ws, "session": session, "cwd": cwd, "created": now_secs(), "socket": socket}));
            Ok(())
        })
    }
}

impl Backend for TmuxBackend {
    fn kind(&self) -> Kind {
        Kind::Tmux
    }

    fn workspaces(&self) -> Result<Vec<WorkspaceRow>, String> {
        let reg = self.snapshot()?;
        Ok(list(&reg, "workspaces").iter().map(|w| WorkspaceRow { id: s(w, "id"), title: s(w, "title"), cwd: s(w, "cwd") }).collect())
    }

    fn panes(&self, ws: Option<&str>) -> Result<Vec<PaneRow>, String> {
        let reg = self.snapshot()?;
        Ok(list(&reg, "panes")
            .iter()
            .filter(|p| ws.is_none_or(|w| s(p, "ws").eq_ignore_ascii_case(w)))
            .map(|p| PaneRow { id: s(p, "id"), workspace: s(p, "ws"), cwd: s(p, "cwd"), label: "Claude".into() })
            .collect())
    }

    fn open_workspace(&self, cwd: &Path, cmd: &str) -> Result<(String, Option<String>), String> {
        let cwd = cwd.to_string_lossy().into_owned();
        let mut made = None;
        let id = self
            .update(|reg| {
                let ws = self.add_workspace(reg, &cwd)?;
                self.start(reg, &ws, &cwd, cmd, &mut made)?;
                Ok(ws)
            })
            .map_err(|e| self.unmake(made.take(), e))?;
        Ok((id.clone(), Some(id)))
    }

    fn start_session(&self, ws: &str, cwd: &str, claude: &str) -> Result<String, String> {
        let mut made = None;
        self.update(|reg| self.start(reg, ws, cwd, claude, &mut made)).map_err(|e| self.unmake(made.take(), e))
    }

    fn target(&self, pane: &str) -> Result<Option<Target>, String> {
        let reg = self.read()?;
        Ok(list(&reg, "panes")
            .iter()
            .find(|p| s(p, "id").eq_ignore_ascii_case(pane))
            .map(|p| self.pane_target(p))
            .filter(|t| self.alive(t)))
    }

    fn close_pane(&self, pane: &str) -> Result<(), String> {
        self.update(|reg| {
            let panes = list(reg, "panes");
            let Some(p) = panes.iter().find(|p| s(p, "id").eq_ignore_ascii_case(pane)) else {
                return Err(format!("no pane {pane:?}"));
            };
            // The session first, the record last: a stop halfway leaves a
            // record the next read drops anyway.
            let t = self.pane_target(p);
            let _ = tmux(&t.socket, &["kill-session", "-t", &format!("={}", t.session)]);
            reg["panes"] = Value::Array(panes.iter().filter(|q| !s(q, "id").eq_ignore_ascii_case(pane)).cloned().collect());
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tmux is needed; CI sets SEAMUX_REQUIRE_TMUX=1 so a missing one fails
    /// there instead of skipping.
    fn have_tmux() -> bool {
        let ok = Command::new(tmux_bin()).arg("-V").output().map(|o| o.status.success()).unwrap_or(false);
        if !ok && std::env::var("SEAMUX_REQUIRE_TMUX").is_ok_and(|v| v == "1") {
            panic!("tmux is not installed and SEAMUX_REQUIRE_TMUX=1");
        }
        if !ok {
            eprintln!("skipped: no tmux");
        }
        ok
    }

    /// A backend in a short temporary dir (a unix socket path has a length
    /// limit), its server killed when the test ends.
    struct Fixture(TmuxBackend, PathBuf);
    impl Fixture {
        fn new(tag: &str) -> Fixture {
            let dir = PathBuf::from(format!("/tmp/sx-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Fixture(TmuxBackend::at(dir.clone()), dir)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = tmux(&self.0.socket(), &["kill-server"]);
            let _ = fs::remove_dir_all(&self.1);
        }
    }

    #[test]
    fn a_killed_server_keeps_its_panes_for_a_restart_with_the_same_id() {
        if !have_tmux() {
            return;
        }
        let f = Fixture::new("gone");
        let b = &f.0;
        let (ws, _) = b.open_workspace(&f.1, "sleep 600").unwrap();
        let cwd = f.1.to_string_lossy().into_owned();
        let p1 = b.start_session(&ws, &cwd, "sleep 600").unwrap();
        // One session ends while its server runs: dropped, not kept.
        let ended = b.target(&p1).unwrap().unwrap();
        tmux(&ended.socket, &["kill-session", "-t", &format!("={}", ended.session)]).unwrap();
        assert_eq!(b.panes(None).unwrap().len(), 1);
        assert!(b.gone().unwrap().is_empty(), "a session that ended is not offered a restart");
        let id = b.panes(None).unwrap()[0].id.clone();
        // The whole server goes (a reboot): its pane is kept as gone.
        tmux(&b.socket(), &["kill-server"]).unwrap();
        assert!(b.panes(None).unwrap().is_empty());
        let gone = b.gone().unwrap();
        assert_eq!(gone, vec![(id.clone(), ws.clone(), cwd.clone())]);
        b.restart(&id, "sleep 600").unwrap();
        assert_eq!(b.panes(None).unwrap().iter().map(|p| p.id.clone()).collect::<Vec<_>>(), vec![id.clone()], "same pane id");
        assert!(b.gone().unwrap().is_empty());
        assert!(b.restart(&id, "sleep 600").is_err(), "no longer gone");
        tmux(&b.socket(), &["kill-server"]).unwrap();
        let _ = b.panes(None);
        b.forget(&id).unwrap();
        assert!(b.gone().unwrap().is_empty(), "a declined restart is forgotten");
    }

    #[test]
    fn facts_round_trip_through_the_registry_without_tmux() {
        let dir = PathBuf::from(format!("/tmp/sx-facts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let b = TmuxBackend::at(dir.clone());
        fs::write(dir.join("workspaces.json"), r#"{"version":1,"workspaces":[{"id":"W1","title":"shop","cwd":"/w"}],"panes":[]}"#).unwrap();
        assert_eq!(b.facts().unwrap(), vec![("W1".into(), String::new(), Value::Null)]);
        b.set_facts("w1", Some("ci:fail pr:draft"), Some(json!({"n": 7, "state": "OPEN", "url": "https://x/7"}))).unwrap();
        b.set_facts("W1", Some("ci:fail pr:draft"), None).unwrap();
        let f = b.facts().unwrap();
        assert_eq!((f[0].1.as_str(), &f[0].2["n"]), ("ci:fail pr:draft", &json!(7)));
        assert_eq!(b.workspaces().unwrap()[0].title, "shop", "the record keeps its other fields");
        assert!(b.set_facts("W9", Some(""), None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_are_v4_uuids_and_differ() {
        let (a, b) = (new_id(), new_id());
        assert_ne!(a, b);
        assert!(::cmux::is_uuid(&a), "{a}");
        assert_eq!(&a[14..15], "4");
    }

    #[test]
    fn a_workspace_and_its_pane_round_trip_through_the_registry() {
        if !have_tmux() {
            return;
        }
        let f = Fixture::new("rt");
        let b = &f.0;
        let cwd = f.1.to_string_lossy().into_owned();
        let (wref, id) = b.open_workspace(&f.1, "sleep 600").unwrap();
        assert_eq!(Some(wref.clone()), id);
        let ws = b.workspaces().unwrap();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].id, wref);
        assert_eq!(ws[0].cwd, cwd);
        let panes = b.panes(Some(&wref)).unwrap();
        assert_eq!(panes.len(), 1);
        let t = b.target(&panes[0].id).unwrap().expect("a live session");
        assert_eq!(t.socket, b.socket());
        // A second pane in the same workspace is its own session.
        let p2 = b.start_session(&wref, &cwd, "sleep 600").unwrap();
        assert_eq!(b.panes(Some(&wref)).unwrap().len(), 2);
        assert_ne!(b.target(&p2).unwrap().unwrap().session, t.session);
        b.close_pane(&p2).unwrap();
        assert!(b.target(&p2).unwrap().is_none());
        assert_eq!(b.panes(None).unwrap().len(), 1);
    }

    #[test]
    fn a_dead_session_is_dropped_on_read() {
        if !have_tmux() {
            return;
        }
        let f = Fixture::new("dead");
        let b = &f.0;
        let (ws, _) = b.open_workspace(&f.1, "sleep 600").unwrap();
        let pane = b.panes(Some(&ws)).unwrap()[0].id.clone();
        let t = b.target(&pane).unwrap().unwrap();
        tmux(&t.socket, &["kill-session", "-t", &format!("={}", t.session)]).unwrap();
        assert!(b.panes(None).unwrap().is_empty());
        assert!(!fs::read_to_string(b.registry_path()).unwrap().contains(&pane), "written back without it");
        assert_eq!(b.workspaces().unwrap().len(), 1, "the workspace stays");
    }

    #[test]
    fn a_session_carries_the_seamux_ids_and_no_cmux_ones() {
        if !have_tmux() {
            return;
        }
        let f = Fixture::new("env");
        let b = &f.0;
        // Run from a cmux pane, this process has CMUX_* of its own: the
        // session must still have none (scrubbed() is tested by itself too).
        let (ws, _) = b.open_workspace(&f.1, "env > env.txt; sleep 600").unwrap();
        let pane = b.panes(Some(&ws)).unwrap()[0].id.clone();
        let file = f.1.join("env.txt");
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !file.exists() || fs::read_to_string(&file).unwrap_or_default().is_empty() {
            assert!(std::time::Instant::now() < end, "the session never wrote its environment");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        let env = fs::read_to_string(&file).unwrap();
        assert!(env.contains(&format!("SEAMUX_WORKSPACE_ID={ws}")), "{env}");
        assert!(env.contains(&format!("SEAMUX_PANE_ID={pane}")), "{env}");
        assert!(env.contains("SEAMUX_BACKEND=tmux"), "{env}");
        assert!(!env.lines().any(|l| l.starts_with("CMUX_")), "{env}");
    }

    /// Live: a real Claude on the tmux backend asks a question, and its pane
    /// file (written by the installed crew hooks, run by $SEAMUX_LIVE_BIN)
    /// says needs_input. Real model spend: run it on purpose, from a trusted
    /// folder ($SEAMUX_LIVE_CWD).
    #[test]
    #[ignore]
    fn live_claude_on_the_tmux_backend_asks_and_its_pane_says_so() {
        let bin = std::env::var("SEAMUX_LIVE_BIN").expect("SEAMUX_LIVE_BIN: a seamux built from this tree");
        let cwd = std::env::var("SEAMUX_LIVE_CWD").expect("SEAMUX_LIVE_CWD: a folder Claude already trusts");
        let f = Fixture::new("live");
        let b = &f.0;
        let ask = "Use the AskUserQuestion tool once to ask me: red or blue? Do nothing else.";
        let cmd = format!("SEAMUX_BIN={} claude {}", sh_quote(&bin), sh_quote(ask));
        let (ws, _) = b.open_workspace(Path::new(&cwd), &cmd).unwrap();
        let pane = b.panes(Some(&ws)).unwrap()[0].id.clone();
        let t = b.target(&pane).unwrap().unwrap();
        let ls = tmux_ok(&t.socket, &["ls", "-F", "#{session_name}"]).unwrap();
        println!("tmux -S {} ls: {}", t.socket, ls.trim());
        assert!(ls.lines().any(|l| l == format!("seamux-{pane}")), "{ls}");
        let file = crate::home::xdg_cache().join(format!("pane-{pane}.json"));
        let end = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let state = loop {
            let st = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| s(&v, "state")).unwrap_or_default();
            if st == "needs_input" || std::time::Instant::now() > end {
                break st;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        };
        let screen = tmux_ok(&t.socket, &["capture-pane", "-p", "-t", &format!("={}", t.session)]).unwrap_or_default();
        println!("pane {pane} state {state:?}\n--- screen ---\n{}", screen.trim_end());
        let _ = fs::remove_file(&file);
        assert_eq!(state, "needs_input", "{file:?}");
    }

    #[test]
    fn the_scrub_drops_cmux_and_outer_tmux_and_keeps_the_rest() {
        for k in ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_SOCKET_PATH", "TMUX", "TMUX_PANE"] {
            assert!(scrubbed(k), "{k}");
        }
        for k in ["PATH", "HOME", "SEAMUX_WORKSPACE_ID", "TMUX_TMPDIR", "XCMUX_X"] {
            assert!(!scrubbed(k), "{k}");
        }
    }

    #[test]
    fn an_unreadable_registry_is_an_error_and_is_left_alone() {
        let f = Fixture::new("bad");
        let path = f.1.join("workspaces.json");
        fs::write(&path, "{not json").unwrap();
        let e = f.0.workspaces().unwrap_err();
        assert!(e.contains("left as it is"), "{e}");
        let cwd = f.1.to_string_lossy().into_owned();
        assert!(f.0.open_workspace(&f.1, "true").is_err());
        assert!(f.0.start_session("X", &cwd, "true").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not json", "never overwritten");
    }

    #[test]
    fn adopting_a_pane_twice_records_it_once() {
        let f = Fixture::new("adopt");
        let cwd = f.1.to_string_lossy().into_owned();
        for _ in 0..2 {
            f.0.adopt("W1", "t", &cwd, "P1", "/tmp/nowhere.sock", "s1").unwrap();
        }
        let reg = f.0.read().unwrap();
        assert_eq!(list(&reg, "panes").len(), 1);
        assert_eq!(list(&reg, "workspaces").len(), 1);
    }

    #[test]
    fn a_pane_in_an_unknown_workspace_is_refused() {
        let f = Fixture::new("unk");
        let cwd = f.1.to_string_lossy().into_owned();
        let e = f.0.start_session("NOPE", &cwd, "true").unwrap_err();
        assert!(e.contains("no workspace"), "{e}");
    }
}
