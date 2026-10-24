//! `seamux triage`: crew/hooks/triage.py in Rust, the cmux notification hook.
//!
//! cmux pipes a notification policy in and applies the policy printed back.
//! `crew:turn` keeps the sidebar but loses the banner and the sound. The
//! board's nine verbs (`crew:sync-now`, `reclaim`, `archive`, `code`,
//! `sandbox-up`/`-down`, `feed-allow`/`-deny`, `plan-go`) are RPCs: each runs
//! its command and every effect is switched off. Anything else is printed
//! back as cmux proposed it, and on any error the input is echoed unchanged.
//!
//! Where the Python spawned a crew tool by path, this spawns `seamux <tool>`
//! when seamux registers it and the tool's path otherwise; crew-code,
//! crew-sandbox and crew-reclaim are bash and stay paths. cmux is reached
//! through the cmux crate. triage.log keeps the Python's lines.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Instant;

use cmux::{Cmux, NewPane, Notify};
use crew_core::workspaces::{self, Ws};
use serde_json::Value;

use crate::pyval::{self, str_of, truthy};

const HOOK_LIMIT: f64 = 10.0;
const CLOSE_SETTLE: f64 = 1.5;

const VERBS: &[&str] = &[
    "crew:sync-now",
    "crew:reclaim",
    "crew:archive",
    "crew:code",
    "crew:sandbox-up",
    "crew:sandbox-down",
    "crew:feed-allow",
    "crew:feed-deny",
    "crew:plan-go",
];

/// deep-plan's go-ahead, through a login shell (see triage.py's PLAN_GO for
/// why), then crew-sync so the chip shows the change.
fn plan_go(cwd_q: &str, sync_q: &str) -> String {
    format!(
        "PATH=\"$HOME/.local/bin:$PATH\"; \
         if command -v deep-plan >/dev/null 2>&1; then deep-plan go --at {cwd_q} next; \
         else R=$(sed -n 's/^  \"root\": \"\\(.*\\)\",\\{{0,1\\}}$/\\1/p' \
         \"$HOME/.claude/deep-plan/engine.json\" 2>/dev/null); \
         [ -f \"$R/deep_plan.mjs\" ] || R=\"$HOME/.claude/skills/deep-plan\"; \
         node \"$R/deep_plan.mjs\" go --at {cwd_q} next; fi; \
         exec {sync_q}"
    )
}

/// `shlex.quote`.
pub fn shquote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    if s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&b)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

struct Ctx {
    cmux: Option<Cmux>,
    bin: PathBuf,
    budget: f64,
    /// The workspace id was not a string: Python's Popen raised TypeError on
    /// any argv holding it, so every fire that carries it fails and is logged.
    bad_ws: Option<String>,
}

impl Ctx {
    /// argv for a crew tool: `seamux <name>` when registered, else its path.
    fn tool(&self, name: &str) -> Vec<String> {
        crate::spawn::tool(name, &[]).argv
    }

    fn say(&self, subtitle: &str, body: &str) {
        if let Some(c) = &self.cmux {
            let _ = c.notify(&Notify {
                title: "crew".into(),
                subtitle: Some(subtitle.into()),
                body: Some(body.into()),
                workspace: None,
            });
        }
    }

    /// A workspace id's directory, resolved here in the hook (see triage.py's
    /// ws_cwd: a fired child cannot ask cmux).
    fn ws_cwd(&self, ws: &str) -> String {
        // A non-string id fails the Python's subprocess call, which ws_cwd catches.
        if ws.is_empty() || self.bad_ws.is_some() {
            return String::new();
        }
        let Some(c) = &self.cmux else { return String::new() };
        let Ok(out) = c.sidebar_state(ws) else { return String::new() };
        for line in crew_core::py::splitlines(&out) {
            if let Some(p) = line.strip_prefix("cwd=") {
                let p = pyval::strip(p);
                return if !p.is_empty() && p != "unknown" && Path::new(p).is_dir() { p.to_string() } else { String::new() };
            }
        }
        String::new()
    }

    /// The workspace to put a terminal in: the selected one, never `avoid`.
    fn host_workspace(&self, avoid: &str) -> String {
        // cmux_json(): only this call runs with CMUX_QUIET=1, as in the Python.
        let Some(c) = crate::spawn::connect().map(|c| c.with_cli_env("CMUX_QUIET", "1")) else { return String::new() };
        let rows = match c.workspace_list(None) {
            Ok(Value::Object(o)) => o.get("workspaces").filter(|w| truthy(w)).cloned().unwrap_or(Value::Null),
            _ => Value::Null,
        };
        let rows = rows.as_array().cloned().unwrap_or_default();
        let field = |w: &Value, k: &str| w.get(k).cloned().unwrap_or(Value::Null);
        let usable: Vec<&Value> = rows
            .iter()
            .filter(|w| {
                truthy(&field(w, "id"))
                    && field(w, "id").as_str() != Some(avoid)
                    && field(w, "ref").as_str() != Some(avoid)
            })
            .collect();
        let id = |w: &Value| str_of(&field(w, "id"));
        usable.iter().find(|w| truthy(&field(w, "selected"))).or(usable.first()).map(|w| id(w)).unwrap_or_default()
    }

    /// Split a terminal into `ws` and run argv there, keeping the pane open.
    fn open_terminal(&self, ws: &str, argv: &[String], title: &str) -> bool {
        if ws.is_empty() {
            return false;
        }
        let Some(c) = &self.cmux else { return false };
        let cmd = argv.iter().map(|a| shquote(a)).collect::<Vec<_>>().join(" ") + "; exec \"${SHELL:-/bin/zsh}\" -l";
        let pane = NewPane {
            kind: "terminal".into(),
            direction: Some("down".into()),
            workspace: Some(ws.into()),
            url: None,
            focus: Some(true),
        };
        let Ok(surface) = c.new_pane(&pane) else { return false };
        if c.respawn_pane(&surface, &cmd).is_err() {
            return false;
        }
        // After respawn, not before: respawn resets the title.
        let _ = c.rename_tab(&surface, title);
        true
    }

    /// Run a crew command detached from this hook, and log it.
    /// `carries_ws`: the argv holds the notification's workspace id.
    fn fire(&self, argv: &[String], carries_ws: bool) {
        let shown = argv.iter().take(4).cloned().collect::<Vec<_>>().join(" ");
        if let (true, Some(ty)) = (carries_ws, &self.bad_ws) {
            tlog(&format!("fire FAILED: {shown}: expected str, bytes or os.PathLike object, not {ty}"));
            return;
        }
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // SAFETY: setsid() in the child, before exec: start_new_session=True.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        match cmd.spawn() {
            Ok(_) => tlog(&format!("fire: {shown}")),
            Err(e) => tlog(&format!("fire FAILED: {shown}: {}", pyval::os_error(&e, Path::new(&argv[0])))),
        }
    }

    /// Archive the board row's workspace, in the hook when it fits cmux's
    /// 10 s limit, else from a terminal. -> what happened, for the log.
    fn archive_in_hook(&self, ws: &str) -> String {
        let t0 = Instant::now();
        let live = workspaces::live_workspaces();
        let took = t0.elapsed().as_secs_f64();
        let Some(live) = live else {
            self.say("archive", "cmux did not list its workspaces — nothing was archived");
            return "no live list".into();
        };
        let Some(found) = workspaces::find_live(ws, Some(&live)) else {
            // A second tap on a row that already went: the first one worked.
            if workspaces::load_archive().values().any(|r| r.get("workspace_id").and_then(Value::as_str) == Some(ws)) {
                return "already archived".into();
            }
            self.say("archive", "that workspace is no longer open");
            return "not open".into();
        };
        // The plan guard first, on either path: a refusal handed to a terminal
        // would never reach a banner, and its deep-plan call is hook time too,
        // so it counts against the budget. A chip never passes the override.
        let t1 = Instant::now();
        let name = if found.title.is_empty() { found.r#ref.clone() } else { found.title.clone() };
        let (ok, why) = workspaces::guard(&found.cwd, &name, false);
        let asked = t1.elapsed().as_secs_f64();
        if !ok {
            self.say("archive", &why);
            return why;
        }
        let calls = 1.0 + windows(&live) as f64;
        let per = took / calls;
        if took + asked + per * (3.0 + calls) + CLOSE_SETTLE > self.budget {
            if took + asked + per * 5.0 > HOOK_LIMIT - 1.0 {
                self.say("archive", "cmux is too slow to archive from the board — use crew-resume");
                return format!("slow cmux ({per:.1}s a call): refused");
            }
            // `seamux workspaces archive`, or workspaces.py when run by path.
            let mut argv = self.tool("workspaces");
            argv.extend(["archive".to_string(), ws.to_string()]);
            if self.open_terminal(&self.host_workspace(ws), &argv, "archive") {
                return format!("slow cmux ({per:.1}s a call): archiving in a terminal");
            }
            self.say("archive", "cmux is slow and no terminal would open — archive it from crew-resume");
            return "slow cmux, no terminal".into();
        }
        let (ok, msg) = workspaces::archive_with(ws, Some(&live), None, workspaces::Guard::Asked);
        if !ok {
            self.say("archive", &msg);
        }
        msg
    }
}

/// How many windows the live list spans: len({w["window"]} or {""}).
fn windows(live: &[Ws]) -> usize {
    let mut seen: Vec<&str> = live.iter().map(|w| w.window.as_str()).collect();
    seen.sort_unstable();
    seen.dedup();
    seen.len().max(1)
}

/// One line in ~/.cache/cmux-crew/triage.log.
fn tlog(msg: &str) {
    use std::io::Write;
    let path = crew_core::py::home().join(".cache/cmux-crew/triage.log");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&path) {
        let _ = f.write_all(format!("{} {msg}\n", hms()).as_bytes());
    }
}

/// `time.strftime("%H:%M:%S")`, local time.
fn hms() -> String {
    let s = pyval::stamp();
    // stamp is YYYYmmdd-HHMMSS
    format!("{}:{}:{}", &s[9..11], &s[11..13], &s[13..15])
}

/// The verb's work. Err means the Python would have raised, and the input
/// is echoed back.
fn handle(policy: &mut Value) -> Result<(), ()> {
    let Value::Object(p) = policy else { return Err(()) };
    let note = p.get("notification").filter(|n| truthy(n)).cloned().unwrap_or_else(|| Value::Object(Default::default()));
    let Value::Object(note) = note else { return Err(()) };
    let subtitle = note.get("subtitle").filter(|s| truthy(s)).cloned().unwrap_or_else(|| Value::String(String::new()));
    let subtitle = subtitle.as_str().unwrap_or("");

    if VERBS.contains(&subtitle) {
        let ws_v = note
            .get("workspaceId")
            .filter(|v| truthy(v))
            .or_else(|| note.get("workspace_id").filter(|v| truthy(v)))
            .cloned()
            .unwrap_or_else(|| Value::String(String::new()));
        let ws = str_of(&ws_v);
        let mut ctx = context()?;
        if !ws_v.is_string() {
            ctx.bad_ws = Some(pyval::type_name(&ws_v).to_string());
        }
        match subtitle {
            "crew:sync-now" => ctx.fire(&ctx.tool("crew-sync"), false),
            "crew:reclaim" => {
                // The one button that deletes: it opens a terminal with the
                // dry run and a y/N, and never falls back to running it.
                let argv = vec![ctx.bin.join("crew-reclaim").display().to_string(), ws.clone()];
                let host = ctx.host_workspace(&ws);
                if ctx.bad_ws.is_some() {
                    // shlex.quote(<int>) fails the terminal, then the banner's
                    // "..." + ws raises: the Python echoes its input.
                    return Err(());
                }
                if !ctx.open_terminal(&host, &argv, "reclaim") {
                    let cwd = ctx.ws_cwd(&ws);
                    let target = if cwd.is_empty() { ws.clone() } else { cwd };
                    ctx.say("reclaim", &format!("could not open a terminal — run: crew-reclaim {target}"));
                }
            }
            "crew:archive" => {
                let what = if truthy(&ws_v) { ctx.archive_in_hook(&ws) } else { "no workspace".into() };
                tlog(&format!("archive {ws}: {what}"));
            }
            "crew:code" => {
                let cwd = ctx.ws_cwd(&ws);
                let code = ctx.bin.join("crew-code").display().to_string();
                if !cwd.is_empty() {
                    ctx.fire(&[code, cwd], false);
                } else {
                    ctx.fire(&[code, "--workspace".into(), ws], true);
                }
            }
            "crew:plan-go" => {
                let cwd = ctx.ws_cwd(&ws);
                if !cwd.is_empty() {
                    let q = shquote(&cwd);
                    let sync = ctx.tool("crew-sync").iter().map(|a| shquote(a)).collect::<Vec<_>>().join(" ");
                    ctx.fire(&["/bin/sh".into(), "-lc".into(), plan_go(&q, &sync)], false);
                } else {
                    tlog(&format!("plan-go DROPPED: no cwd (ws={})", pyval::repr(&ws_v)));
                }
            }
            "crew:sandbox-up" | "crew:sandbox-down" => {
                let verb = if subtitle.ends_with("up") { "up" } else { "down" };
                let cwd = ctx.ws_cwd(&ws);
                let sandbox = ctx.bin.join("crew-sandbox").display().to_string();
                if !cwd.is_empty() {
                    ctx.fire(&[sandbox, verb.into(), cwd], false);
                } else {
                    ctx.fire(&[sandbox, "--workspace".into(), ws, verb.into()], true);
                }
            }
            _ => {
                // Replies go through crew-feed, which re-validates the window
                // and writes the audit line.
                let mode = if subtitle.ends_with("allow") { "once" } else { "deny" };
                let mut argv = ctx.tool("crew-feed");
                argv.extend(["reply".to_string(), mode.to_string(), ws]);
                ctx.fire(&argv, true);
            }
        }
        if let Some(Value::Object(effects)) = p.get_mut("effects") {
            for v in effects.values_mut() {
                *v = Value::Bool(false);
            }
        }
        return Ok(());
    }

    if subtitle == "crew:turn" {
        if let Some(Value::Object(effects)) = p.get_mut("effects") {
            effects.insert("desktop".into(), Value::Bool(false));
            effects.insert("sound".into(), Value::Bool(false));
            // record, markUnread and reorderWorkspace stay: the sidebar is the point.
        }
    }
    Ok(())
}

fn context() -> Result<Ctx, ()> {
    Ok(Ctx {
        cmux: crate::spawn::connect(),
        bin: crew_core::crew_home().join("bin"),
        budget: archive_budget().map_err(|_| ())?,
        bad_ws: None,
    })
}

/// CREW_ARCHIVE_BUDGET as float(), default 7. Err: the Python's import-time
/// ValueError.
fn archive_budget() -> Result<f64, String> {
    match std::env::var("CREW_ARCHIVE_BUDGET") {
        Err(_) => Ok(7.0),
        Ok(s) => pyval::parse_float(pyval::strip(&s))
            .ok_or_else(|| format!("ValueError: could not convert string to float: {}", pyval::repr_str(&s))),
    }
}

pub fn main(_args: &[String]) -> i32 {
    use std::io::{Read, Write};
    // The Python reads CREW_ARCHIVE_BUDGET at import: a bad one fails before stdin.
    if let Err(m) = archive_budget() {
        eprintln!("Traceback (most recent call last):\n  File \"triage.py\"\n{m}");
        return 1;
    }
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    // Bytes that are not UTF-8 go back exactly as they came. The Python
    // crashed on them under a UTF-8 locale and kept them under C's
    // surrogateescape; either way the safe answer is cmux's own policy.
    let raw_text = match String::from_utf8(raw) {
        Ok(t) => t,
        Err(e) => {
            let mut so = std::io::stdout();
            let _ = so.write_all(e.as_bytes());
            let _ = so.flush();
            return 0;
        }
    };
    let text = raw_text.replace("\r\n", "\n").replace('\r', "\n");
    let out = match pyval::loads(&text) {
        Ok(mut policy) => match handle(&mut policy) {
            Ok(()) => pyval::dumps(&policy, None),
            Err(()) => text,
        },
        Err(_) => text,
    };
    let mut so = std::io::stdout();
    let _ = so.write_all(out.as_bytes());
    let _ = so.flush();
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_as_shlex() {
        assert_eq!(shquote("/a/b-c_d.e"), "/a/b-c_d.e");
        assert_eq!(shquote(""), "''");
        assert_eq!(shquote("it's"), "'it'\"'\"'s'");
        assert_eq!(shquote("a b"), "'a b'");
        assert_eq!(shquote("é"), "'é'");
    }

    #[test]
    fn plan_go_matches_the_python_template() {
        // python3 -c "import triage; print(triage.PLAN_GO % ('/w', '/w', '/s'))"
        let want = "PATH=\"$HOME/.local/bin:$PATH\"; if command -v deep-plan >/dev/null 2>&1; then deep-plan go --at /w next; else R=$(sed -n 's/^  \"root\": \"\\(.*\\)\",\\{0,1\\}$/\\1/p' \"$HOME/.claude/deep-plan/engine.json\" 2>/dev/null); [ -f \"$R/deep_plan.mjs\" ] || R=\"$HOME/.claude/skills/deep-plan\"; node \"$R/deep_plan.mjs\" go --at /w next; fi; exec /s";
        assert_eq!(plan_go("/w", "/s"), want);
    }
}
