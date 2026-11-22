//! `seamux bosun`: the Bosun, one long-running Claude session over the code
//! root, read-only on its files, kept off the board (its registry row is
//! marked `"kind": "bosun"`, which TmuxBackend's lists leave out).
//!
//! ```text
//! seamux bosun ensure [--json]   start it if it is not running: (workspace, pane)
//! seamux bosun status [--json]   where it is and which conversation it keeps
//! seamux bosun stop              end its pane; the next ensure resumes it
//! seamux bosun run               the pane's command: the supervisor
//! seamux bosun prime             the SessionStart hook (stdin: its payload)
//! seamux bosun send <text> [--source S]            queue a prompt
//! seamux bosun ask <question> [--from WHO] [--timeout S] | ask --id ID
//!                                print the answer (exit 3: still waiting)
//! seamux bosun answer <id>       an ask's answer, on stdin
//! seamux bosun log add           one entry on stdin | log list [--day D] [--json]
//! seamux bosun dispatch <repo> <branch> --brief <file> [--json]
//! seamux bosun loops [list] [--json] | loops run <id>
//!                                bosun.json's timed prompts (loops.rs)
//! seamux bosun precompact        the PreCompact hook (stdin: its payload)
//! seamux bosun recall            the SessionStart hook after a compaction
//! seamux bosun context radar|lookout [--json]
//!                                what the app's Radar and Lookout tabs show (read-only)
//! ```
//!
//! It runs on the app's tmux backend only. Exit 0 on success, 1 when it
//! could not, 2 on bad arguments.

pub mod compact;
pub mod config;
pub mod context;
pub mod dispatch;
pub mod launch;
pub mod log;
pub mod loops;
pub mod queue;
pub mod supervise;

use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};

use crate::backend::tmux::TmuxBackend;
use crate::backend::Backend;
use config::Config;

/// The registry kind that marks the Bosun's workspace.
pub const KIND: &str = "bosun";
/// Its workspace's title.
pub const TITLE: &str = "Bosun";

/// Where the Bosun is: its workspace and pane.
#[derive(Clone, Debug, PartialEq)]
pub struct Where {
    pub ws: String,
    pub pane: String,
    /// What `ensure` did: "running", "started", "restarted" or "opened".
    pub how: &'static str,
}

/// The command its pane runs.
pub fn run_line() -> String {
    format!("{} bosun run", crate::native::sh_quote(&launch::seamux_bin()))
}

/// Make sure the Bosun runs on `t`: its pane when it is live, a gone one
/// restarted, a new pane in its workspace, or a new workspace at the root.
pub fn ensure_at(t: &TmuxBackend, cfg: &Config) -> Result<Where, String> {
    let line = run_line();
    // One ensure at a time: two (the app and a doctor fix) must not each
    // start a pane.
    let _l = crate::status::lock_file(t.dir(), "bosun.lock");
    match t.kind_row(KIND)? {
        // A pane whose supervisor has returned is only a login shell: it is
        // replaced. One tmux or ps could not say about is left running.
        Some(r) if r.live.as_deref().is_some_and(|p| supervised(t, p) == Some(false)) => {
            let old = r.live.clone().unwrap_or_default();
            t.close_pane(&old)?;
            let pane = t.start_session(&r.ws, &r.cwd_or(&cfg.root), &line)?;
            Ok(Where { ws: r.ws, pane, how: "started" })
        }
        Some(r) if r.live.is_some() => Ok(Where { ws: r.ws, pane: r.live.unwrap_or_default(), how: "running" }),
        Some(r) if r.gone.is_some() => {
            let pane = r.gone.unwrap_or_default();
            t.restart(&pane, &line)?;
            Ok(Where { ws: r.ws, pane, how: "restarted" })
        }
        Some(r) => {
            let pane = t.start_session(&r.ws, &r.cwd_or(&cfg.root), &line)?;
            Ok(Where { ws: r.ws, pane, how: "started" })
        }
        None => {
            if !cfg.root.is_dir() {
                return Err(format!("the Bosun's root {} is not a folder", cfg.root.display()));
            }
            let (ws, pane) = t.open_kind(&cfg.root, &line, KIND, TITLE)?;
            Ok(Where { ws, pane, how: "opened" })
        }
    }
}

/// Whether the supervisor (`seamux bosun run`) still runs in pane `pane`:
/// None when tmux or ps could not say.
fn supervised(t: &TmuxBackend, pane: &str) -> Option<bool> {
    let target = t.target(pane).ok()??;
    let tty = crate::backend::tmux::pane_tty(&target)?;
    let out = std::process::Command::new("/bin/ps").args(["-t", &tty, "-o", "args="]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).lines().any(|l| l.contains(" bosun run")))
}

impl crate::backend::tmux::KindRow {
    /// Its folder when it is still there, else `root`.
    fn cwd_or(&self, root: &Path) -> String {
        if Path::new(&self.cwd).is_dir() { self.cwd.clone() } else { root.to_string_lossy().into_owned() }
    }
}

/// `ensure_at` on this machine's tmux backend.
pub fn ensure() -> Result<Where, String> {
    ensure_at(&TmuxBackend::default(), &Config::load())
}

/// The Bosun's status: {ws, pane, live, state, session, day, root}.
pub fn status_at(t: &TmuxBackend, dir: &Path) -> Result<Value, String> {
    let cfg = Config::load_from(dir);
    let st = launch::State::load(dir);
    let row = t.kind_row(KIND)?;
    let pane = row.as_ref().and_then(|r| r.live.clone().or(r.gone.clone())).unwrap_or_default();
    let live = row.as_ref().is_some_and(|r| r.live.is_some());
    let state = if live { crate::status::read(&crate::status::pane_dir(), &pane).map(|p| p.state).unwrap_or_default() } else { String::new() };
    Ok(json!({
        "ws": row.as_ref().map(|r| r.ws.clone()).unwrap_or_default(),
        "pane": pane, "live": live, "state": state,
        "session": st.session, "day": st.day, "root": cfg.root.to_string_lossy(),
    }))
}

/// The note a new conversation starts with (the SessionStart hook's stdout).
pub fn prime_note(cfg: &Config, today: &str, source: &str) -> String {
    let why = match source {
        "clear" => "A new day's conversation has started.",
        "compact" => "The conversation was just compacted.",
        "resume" => "The Bosun's Claude was restarted on the same conversation.",
        _ => "The Bosun has started.",
    };
    format!("Bosun session note. {why} Today is {today}. You work from {} and are read-only there.\n", cfg.root.display())
}

/// The prime note with the latest answers from the log, so a new day's
/// conversation knows what came before.
pub fn prime_with_log(cfg: &Config, dir: &Path, today: &str, source: &str) -> String {
    let mut note = prime_note(cfg, today, source);
    let recent = log::recent(dir, 10);
    if !recent.is_empty() {
        note.push_str("Recent answers in your log (seamux bosun log list):\n");
        for e in &recent {
            let q: String = e["question"].as_str().unwrap_or("").chars().take(160).collect();
            note.push_str(&format!("- {} ({})\n", q.replace('\n', " "), e["id"].as_str().unwrap_or("")));
        }
    }
    let waiting = queue::waiting(dir).len();
    if waiting > 0 {
        note.push_str(&format!("{waiting} queued prompt(s) will be typed in as you go idle.\n"));
    }
    note
}

/// The text after the subcommand, flags (and their values) left out.
fn words(args: &[String], valued: &[&str]) -> (String, Vec<(String, String)>) {
    let mut text = Vec::new();
    let mut flags = Vec::new();
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        if valued.contains(&a.as_str()) {
            flags.push((a.clone(), it.next().cloned().unwrap_or_default()));
        } else if a.starts_with("--") {
            flags.push((a.clone(), String::new()));
        } else {
            text.push(a.clone());
        }
    }
    (text.join(" "), flags)
}

fn flag<'a>(flags: &'a [(String, String)], name: &str) -> Option<&'a str> {
    flags.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

fn stdin_text() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s
}

fn fail(what: &str, e: impl std::fmt::Display) -> i32 {
    eprintln!("bosun {what}: {e}");
    1
}

fn usage() -> i32 {
    eprintln!("usage: seamux bosun ensure|status [--json] | stop | run | prime | send | ask | answer <id> | log add|list | dispatch | loops [list|run <id>] | precompact | recall | context radar|lookout");
    2
}

pub fn main(args: &[String]) -> i32 {
    let json_out = args.iter().any(|a| a == "--json");
    let sub = args.first().map(String::as_str).filter(|a| !a.starts_with("--")).unwrap_or("");
    let dir = config::dir();
    let t = TmuxBackend::default();
    match sub {
        "ensure" => match ensure() {
            Ok(w) => {
                if json_out {
                    println!("{}", json!({"state": w.how, "ws": w.ws, "pane": w.pane}));
                } else {
                    println!("bosun {}: workspace {} pane {}", w.how, w.ws, w.pane);
                }
                0
            }
            Err(e) => {
                eprintln!("bosun ensure: {e}");
                1
            }
        },
        "status" => match status_at(&t, &config::dir()) {
            Ok(v) => {
                if json_out {
                    println!("{v}");
                } else {
                    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
                    println!("bosun: {} (pane {}, conversation {} from {})", if v["live"] == true { "running" } else { "not running" }, s("pane"), s("session"), s("day"));
                }
                0
            }
            Err(e) => {
                eprintln!("bosun status: {e}");
                1
            }
        },
        "stop" => {
            let row = match t.kind_row(KIND) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("bosun stop: {e}");
                    return 1;
                }
            };
            match row.and_then(|r| r.live) {
                Some(p) => match t.close_pane(&p) {
                    Ok(()) => {
                        println!("bosun stopped; `seamux bosun ensure` resumes its conversation");
                        0
                    }
                    Err(e) => {
                        eprintln!("bosun stop: {e}");
                        1
                    }
                },
                None => {
                    println!("bosun is not running");
                    0
                }
            }
        }
        "run" => supervise::run(),
        "prime" => {
            let mut payload = String::new();
            let _ = std::io::stdin().read_to_string(&mut payload);
            print!("{}", supervise::prime(&payload, &config::dir()));
            0
        }
        "send" => {
            let (text, flags) = words(args, &["--source"]);
            match queue::enqueue(&dir, &text, flag(&flags, "--source").unwrap_or("send")) {
                Ok(i) => {
                    println!("{}", if json_out { json!({"id": i.id}).to_string() } else { format!("queued {}", i.id) });
                    0
                }
                Err(e) => fail("send", e),
            }
        }
        "ask" => {
            let (text, flags) = words(args, &["--from", "--timeout", "--id"]);
            let timeout = std::time::Duration::from_secs(flag(&flags, "--timeout").and_then(|t| t.parse().ok()).unwrap_or(900));
            let id = match flag(&flags, "--id") {
                Some(id) => id.to_string(),
                None => {
                    let who = flag(&flags, "--from").map(str::to_string).unwrap_or_else(|| {
                        crate::py::env_or("SEAMUX_WORKSPACE_ID").map(|w| format!("workspace {w}")).unwrap_or_else(|| "a shell".into())
                    });
                    if text.trim().is_empty() {
                        return fail("ask", "what is the question?");
                    }
                    let id = crate::backend::tmux::new_id().to_ascii_lowercase();
                    let prompt = queue::ask_prompt(&id, &who, text.trim(), &launch::seamux_bin());
                    if let Err(e) = queue::enqueue_as(&dir, &id, &prompt, &format!("ask:{who}")) {
                        return fail("ask", e);
                    }
                    eprintln!("bosun ask {id}: queued; waiting up to {}s for the answer", timeout.as_secs());
                    id
                }
            };
            match queue::wait_answer(&dir, &id, timeout) {
                Some(a) => {
                    print!("{}", if json_out { json!({"id": id, "answer": a}).to_string() + "\n" } else { a });
                    0
                }
                None => {
                    eprintln!("bosun ask {id}: no answer yet; `seamux bosun ask --id {id}` waits again");
                    3
                }
            }
        }
        "answer" => match args.get(1) {
            Some(id) => match queue::answer(&dir, id, &stdin_text()) {
                Ok(p) => {
                    println!("answered {id} ({})", p.display());
                    0
                }
                Err(e) => fail("answer", e),
            },
            None => usage(),
        },
        "log" => match args.get(1).map(String::as_str) {
            Some("add") => {
                let v: Value = match serde_json::from_str(&stdin_text()) {
                    Ok(v) => v,
                    Err(e) => return fail("log add", format!("stdin is not one JSON entry: {e}")),
                };
                match log::add(&dir, &v) {
                    Ok(e) => {
                        println!("{}", if json_out { e.to_string() } else { format!("logged {}", e["id"].as_str().unwrap_or("")) });
                        0
                    }
                    Err(e) => fail("log add", e),
                }
            }
            Some("list") => {
                let (_, flags) = words(&args[1..], &["--day"]);
                let day = flag(&flags, "--day").map(str::to_string).unwrap_or_else(|| launch::local_day_hour(launch::now_secs()).0);
                match log::list(&dir, &day) {
                    Ok(es) if json_out => {
                        println!("{}", json!({"day": day, "entries": es}));
                        0
                    }
                    Ok(es) => {
                        for e in es {
                            println!("{}  {}", e["id"].as_str().unwrap_or(""), e["question"].as_str().unwrap_or(""));
                        }
                        0
                    }
                    Err(e) => fail("log list", e),
                }
            }
            _ => usage(),
        },
        "dispatch" => match dispatch::parse(&args[1..]) {
            Ok(a) => match dispatch::run(&a) {
                Ok(v) => {
                    if a.json {
                        println!("{v}");
                    } else {
                        println!("dispatched {} in {} (workspace {})", v["branch"].as_str().unwrap_or(""), v["path"].as_str().unwrap_or(""), v["workspace"].as_str().unwrap_or(""));
                    }
                    0
                }
                Err(e) => fail("dispatch", e),
            },
            Err(e) => {
                eprintln!("bosun dispatch: {e}");
                2
            }
        },
        "loops" => loops::main(&args[1..], &dir),
        "context" => context::main(&args[1..]),
        "precompact" | "recall" => {
            let since = compact::conversation_day(&dir);
            let (today, _) = launch::local_day_hour(launch::now_secs());
            let out = if sub == "precompact" { compact::precompact(&stdin_text(), &dir, &since, &today) } else { compact::recall(&dir, &since, &today) };
            print!("{out}");
            0
        }
        _ => usage(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_note_names_the_day_and_the_root() {
        let cfg = Config { root: PathBuf::from("/u/code"), reset_hour: 4, allow_write: vec![], allowed_domains: vec![] };
        let n = prime_note(&cfg, "2026-11-22", "clear");
        assert!(n.contains("2026-11-22") && n.contains("/u/code") && n.contains("new day"));
    }

    #[test]
    fn bad_arguments_exit_2() {
        assert_eq!(main(&["nope".to_string()]), 2);
        assert_eq!(main(&[]), 2);
    }
}
