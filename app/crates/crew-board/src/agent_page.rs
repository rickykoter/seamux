//! /agent/<session>/<id>: a sub-agent's transcript, read-only, beside the
//! terminal (crew/board/agent.html).
//!
//! The route takes a session id and an agent id, never a path. It asks the
//! adapters for the session's runs (crew_core::runs) and serves a transcript
//! only when one of them lists that agent with that transcript, and only a
//! file under Claude Code's projects folder. Anything else is a 404.
//!
//! `/agent/<session>/<id>` is the page, with this server's token in it;
//! `/agent/<session>/<id>/data?t=` is its view as JSON, which the page asks
//! for again every few seconds while the agent runs. A Claude Code JSONL
//! transcript becomes the prompt, the steps (text and tool calls, each
//! tool's result attached) and the answer; any other file is shown as text.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crew_core::runs::{host, Agent, Run};
use serde_json::{json, Value};

use crate::server::{crew_file, log, Request};

/// The page's slot for its boot data.
const SLOT: &str = "__BOOT__";
/// The most steps a page gets: the newest are kept.
pub const STEPS_MAX: usize = 1_500;
const TEXT_MAX: usize = 6_000;
const PROMPT_MAX: usize = 12_000;
const RESULT_MAX: usize = 800;
/// A transcript in no known format: its last this many bytes, as text.
const PLAIN_MAX: u64 = 256 * 1024;

fn plain_id(x: &str) -> bool {
    !x.is_empty() && x.len() <= 128 && !x.starts_with('.') && x.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `/agent/<session>/<id>[/data]` split, each part a plain id.
pub fn parse_path(path: &str) -> Option<(String, String, bool)> {
    let rest = path.strip_prefix("/agent/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let (s, id, data) = match parts.as_slice() {
        [s, id] => (*s, *id, false),
        [s, id, "data"] => (*s, *id, true),
        _ => return None,
    };
    (plain_id(s) && plain_id(id)).then(|| (s.to_string(), id.to_string(), data))
}

/// The agent an adapter listed under this id, with its run.
pub fn find(runs: &[Run], id: &str) -> Option<(Run, Agent)> {
    runs.iter().find_map(|r| r.agents.iter().find(|a| a.id == id).map(|a| (r.clone(), a.clone())))
}

/// The transcript, when it is a file under `root` (both resolved, so a
/// symlink cannot lead out).
pub fn allowed(transcript: &str, root: &Path) -> Option<PathBuf> {
    let t = std::fs::canonicalize(transcript).ok()?;
    let r = std::fs::canonicalize(root).ok()?;
    (t.starts_with(&r) && t.is_file()).then_some(t)
}

fn trim(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

fn ts(v: &Value) -> Option<u64> {
    v.get("timestamp").and_then(Value::as_str).and_then(crew_core::py::iso_timestamp).map(|t| (t * 1000.0) as u64)
}

/// Paths under the home folder, written from `~`.
pub fn tilde(t: &str) -> String {
    let home = crew_core::py::home().display().to_string();
    if home.len() > 1 { t.replace(&format!("{home}/"), "~/") } else { t.to_string() }
}

/// A shell command's first step that does something: a leading `cd`, a
/// variable set or a function defined first is setup, not the step.
pub fn first_command(cmd: &str) -> String {
    // Lines are steps too: setup on a line of its own is skipped the same way.
    let joined = cmd.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("; ");
    let first_line = joined.as_str();
    let mut rest = first_line;
    loop {
        let cut = [" && ", "; ", ";"].iter().filter_map(|sep| rest.find(sep).map(|i| (i, sep.len()))).min_by_key(|x| x.0);
        let head = cut.map(|(i, _)| &rest[..i]).unwrap_or(rest).trim();
        let setup = head.starts_with("cd ") || head == "cd" || head.starts_with("export ")
            || (!head.contains(' ') && head.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')))
            || (head.contains("()") && head.contains('{'));
        match cut {
            Some((i, n)) if setup => {
                // A function body runs to its closing brace: skip past it.
                if head.contains("()") && head.contains('{') && !head.contains('}') {
                    match rest.find('}') {
                        Some(j) => rest = rest[j + 1..].trim_start_matches([';', ' ', '&']),
                        None => return head.to_string(),
                    }
                } else {
                    rest = rest[i + n..].trim_start();
                }
            }
            _ => return if head.is_empty() { first_line.to_string() } else { head.to_string() },
        }
    }
}

/// A tool call in one line: what it ran, read or looked for. A call's own
/// description says it best; a shell command shows its first real step.
pub fn summary(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty());
    let one = match name {
        "Bash" => s("description").map(str::to_string).or_else(|| s("command").map(first_command)).map(|x| x.to_string()),
        "SubagentHandback" => s("message").map(str::to_string),
        "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => s("file_path").or(s("notebook_path")).map(str::to_string),
        "Grep" | "Glob" => s("pattern").map(str::to_string),
        "WebFetch" => s("url").map(str::to_string),
        "WebSearch" => s("query").map(str::to_string),
        "Agent" | "Task" => s("description").map(str::to_string),
        "Skill" => s("skill").map(str::to_string),
        _ => None,
    }
    .or_else(|| s("description").map(str::to_string))
    .or_else(|| ["command", "file_path", "path", "pattern", "query", "url", "prompt"].iter().find_map(|k| s(k)).map(str::to_string))
    .unwrap_or_else(|| {
        let t = input.to_string();
        if t == "{}" || t == "null" { String::new() } else { t }
    });
    trim(&tilde(one.lines().next().unwrap_or("")), 200)
}

/// What a call was given, in full, for its opened step: the command, the
/// file, or the input as JSON.
pub fn input_text(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let t = match name {
        "Bash" => s("command"),
        "Read" | "Write" | "Edit" | "MultiEdit" => s("file_path"),
        _ => None,
    }.unwrap_or_else(|| serde_json::to_string_pretty(input).unwrap_or_default());
    trim(&tilde(t.trim()), RESULT_MAX * 2)
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => b.get("text").and_then(Value::as_str).map(str::to_string),
            _ => None,
        }).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// A Claude Code JSONL transcript as the page's prompt, steps and answer.
pub fn claude_view(path: &Path) -> Option<Value> {
    let f = std::fs::File::open(path).ok()?;
    let mut prompt: Option<String> = None;
    let mut steps: Vec<Value> = Vec::new();
    let mut by_tool: HashMap<String, usize> = HashMap::new();
    let mut last_text: Option<String> = None;
    // An agent hands its report back through SubagentHandback: that, when
    // it has one, is its answer rather than whatever it said last.
    let mut handback: Option<String> = None;
    let mut known = false;
    // Read lossily, line by line: one line that is not UTF-8 is skipped,
    // never the end of the transcript.
    let mut r = BufReader::new(f);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match r.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&raw);
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let Some(m) = v.get("message") else { continue };
        known = true;
        let at = ts(&v);
        let content = m.get("content").cloned().unwrap_or(Value::Null);
        match kind {
            "user" => {
                if prompt.is_none() {
                    let t = text_of(&content);
                    if !t.trim().is_empty() {
                        prompt = Some(trim(t.trim(), PROMPT_MAX));
                        continue;
                    }
                }
                for b in content.as_array().into_iter().flatten() {
                    if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    let Some(&i) = by_tool.get(id) else { continue };
                    let out = text_of(b.get("content").unwrap_or(&Value::Null));
                    steps[i]["result"] = json!(trim(&tilde(out.trim()), RESULT_MAX));
                    steps[i]["error"] = json!(b.get("is_error").and_then(Value::as_bool).unwrap_or(false));
                    steps[i]["done"] = json!(at);
                }
            }
            "assistant" => {
                for b in content.as_array().into_iter().flatten() {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let t = b.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                            if t.is_empty() {
                                continue;
                            }
                            last_text = Some(t.clone());
                            steps.push(json!({"kind": "text", "at": at, "text": trim(&t, TEXT_MAX)}));
                        }
                        Some("tool_use") => {
                            let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            if !id.is_empty() && by_tool.contains_key(&id) {
                                continue;
                            }
                            let name = b.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            if name == "SubagentHandback" {
                                if let Some(m) = input.get("message").and_then(Value::as_str).filter(|m| !m.trim().is_empty()) {
                                    handback = Some(m.trim().to_string());
                                }
                            }
                            by_tool.insert(id, steps.len());
                            steps.push(json!({"kind": "tool", "at": at, "name": name, "summary": summary(&name, &input),
                                              "input": input_text(&name, &input)}));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if !known {
        return None;
    }
    // Each step keeps its place in the whole transcript (n), so a page keys
    // its rows by it even once the oldest are dropped.
    for (i, st) in steps.iter_mut().enumerate() {
        st["n"] = json!(i);
    }
    let dropped = steps.len().saturating_sub(STEPS_MAX);
    let steps: Vec<Value> = steps.into_iter().skip(dropped).collect();
    Some(json!({"format": "claude-jsonl", "prompt": prompt, "steps": steps, "dropped": dropped,
                "lastText": handback.or(last_text).map(|t| trim(&t, TEXT_MAX))}))
}

/// Any other file: its last PLAIN_MAX bytes.
fn plain_view(path: &Path) -> Value {
    let mut text = String::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let from = len.saturating_sub(PLAIN_MAX);
        let _ = f.seek(SeekFrom::Start(from));
        let mut buf = Vec::new();
        let _ = f.take(PLAIN_MAX).read_to_end(&mut buf);
        text = String::from_utf8_lossy(&buf).into_owned();
    }
    json!({"format": "text", "text": text})
}

type ViewCache = HashMap<PathBuf, (std::time::SystemTime, u64, Value)>;

/// The view of a transcript, parsed again only when the file changes.
pub fn view_of(path: &Path) -> Value {
    static CACHE: Mutex<Option<ViewCache>> = Mutex::new(None);
    let md = std::fs::metadata(path).ok();
    let stamp = md.as_ref().and_then(|m| m.modified().ok()).zip(md.as_ref().map(|m| m.len()));
    if let Some((t, n)) = stamp {
        if let Some((_, _, v)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(path)).filter(|(a, b, _)| *a == t && *b == n) {
            return v.clone();
        }
    }
    let looks_claude = path.extension().is_some_and(|e| e == "jsonl");
    let v = looks_claude.then(|| claude_view(path)).flatten().unwrap_or_else(|| plain_view(path));
    if let Some((t, n)) = stamp {
        let mut c = CACHE.lock().unwrap();
        let m = c.get_or_insert_with(HashMap::new);
        if m.len() > 64 {
            m.clear();
        }
        m.insert(path.to_path_buf(), (t, n, v.clone()));
    }
    v
}

/// What the page shows: the header from the run model, and the view, with
/// only the steps from `since` on (a page asks for those it has not drawn
/// or whose result it still waits on).
pub fn data(run: &Run, agent: &Agent, transcript: &Path, since: usize) -> Value {
    let mut v = view_of(transcript);
    if since > 0 {
        if let Some(st) = v.get_mut("steps").and_then(Value::as_array_mut) {
            st.retain(|x| x["n"].as_u64().unwrap_or(0) as usize >= since);
        }
        v["since"] = json!(since);
    }
    v["agent"] = agent.to_json();
    v["agent"]["transcript"] = Value::Null;
    v["run"] = json!({"id": run.id, "kind": run.kind, "name": run.name, "source": run.source, "status": run.status});
    v
}

/// The session's runs from every adapter, as the run page reads them.
fn runs_for(session: &str) -> Result<Vec<Run>, String> {
    let ctx = crew_core::runs::context_for(session, "").ok_or("no such session")?;
    let (adapters, _) = host::adapters();
    Ok(host::report(&ctx, &adapters, true).runs)
}

fn boot(token: &str, session: &str, id: &str, title: &str) -> String {
    crew_core::pyjson::dumps(&json!({"t": token, "session": session, "id": id, "title": title}))
        .replace('<', "\\u003c").replace('>', "\\u003e").replace('&', "\\u0026")
}

/// GET /agent/... : true when the path was this route's.
pub fn get(req: &mut Request) -> bool {
    let Some((session, id, is_data)) = parse_path(&req.path.clone()) else { return false };
    if is_data && !crate::server::ct_eq(&req.one("t"), &req.token) {
        log("DENY bad token on /agent data from 127.0.0.1");
        req.json(403, &json!({"error": "bad token"}));
        return true;
    }
    let found = runs_for(&session).ok().and_then(|runs| find(&runs, &id));
    let listed = found.and_then(|(run, agent)| {
        let t = agent.transcript.clone()?;
        allowed(&t, &crew_core::workspaces::projects()).map(|p| (run, agent, p))
    });
    let Some((run, agent, path)) = listed else {
        log(&format!("DENY /agent {session}/{id}: no adapter lists that transcript"));
        req.json(404, &json!({"error": "no adapter lists a transcript for that agent"}));
        return true;
    };
    if is_data {
        let since = req.one("since").parse::<usize>().unwrap_or(0);
        req.json(200, &data(&run, &agent, &path, since));
        return true;
    }
    let f = crew_file("board/agent.html");
    match std::fs::read_to_string(&f) {
        Ok(html) => {
            let html = html.replace(SLOT, &boot(&req.token, &session, &id, &agent.label));
            req.send(200, "text/html; charset=utf-8", "no-store", html.as_bytes());
        }
        Err(e) => req.json(500, &json!({"error": crate::routes::os_err(&e, &f)})),
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crew_core::runs::model::parse_doc;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../crew-core/tests/fixtures/runs/projects")
    }

    #[test]
    fn only_a_plain_session_and_id_are_a_route() {
        assert_eq!(parse_path("/agent/s-1/a1"), Some(("s-1".into(), "a1".into(), false)));
        assert_eq!(parse_path("/agent/s-1/wf_1.x/data"), Some(("s-1".into(), "wf_1.x".into(), true)));
        for bad in ["/agent/s-1", "/agent/../x", "/agent/s/../../etc", "/agent/s/a/b/c", "/agent/s/.a", "/agent//a", "/agents/s/a"] {
            assert_eq!(parse_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_listed_transcript_is_served_an_unlisted_id_and_a_path_are_refused() {
        let root = fixture();
        let t = root.join("-w-repo/s-done/subagents/agent-afbf7fe6ed7060d9e.jsonl");
        let doc = json!({"schema": "seamux.run/1", "runs": [
            {"id": "afbf7fe6ed7060d9e", "status": "done", "agents": [{"id": "afbf7fe6ed7060d9e", "state": "done", "transcript": t.display().to_string()}]},
            {"id": "evil", "status": "done", "agents": [{"id": "evil", "state": "done", "transcript": "/etc/hosts"}]},
            {"id": "climb", "status": "done", "agents": [{"id": "climb", "state": "done", "transcript": format!("{}/../../runs.rs", root.display())}]}]});
        let runs = parse_doc(&doc, "test").unwrap();
        let (_, a) = find(&runs, "afbf7fe6ed7060d9e").unwrap();
        assert!(allowed(a.transcript.as_deref().unwrap(), &root).is_some(), "listed and under the projects folder");
        assert!(find(&runs, "not-listed").is_none());
        let (_, evil) = find(&runs, "evil").unwrap();
        assert!(allowed(evil.transcript.as_deref().unwrap(), &root).is_none(), "a listed path outside the projects folder");
        let (_, climb) = find(&runs, "climb").unwrap();
        assert!(allowed(climb.transcript.as_deref().unwrap(), &root).is_none(), "a path that climbs out");
    }

    #[test]
    fn a_claude_transcript_becomes_prompt_steps_and_answer() {
        let t = fixture().join("-w-repo/s-done/subagents/agent-afbf7fe6ed7060d9e.jsonl");
        let v = claude_view(&t).unwrap();
        assert!(v["prompt"].as_str().unwrap().contains("sleep 15"), "{}", v["prompt"]);
        let steps = v["steps"].as_array().unwrap();
        let tool = steps.iter().find(|s| s["kind"] == "tool").unwrap();
        assert_eq!((tool["name"].as_str(), tool["summary"].as_str(), tool["input"].as_str()), (Some("Bash"), Some("Sleep for 15 seconds"), Some("sleep 15")), "its description, and the command when opened");
        assert_eq!(tool["result"], "(Bash completed with no output)");
        assert_eq!(tool["error"], false);
        assert_eq!(v["lastText"], "done");
        assert!(steps.iter().enumerate().all(|(i, s)| s["n"] == i), "each step carries its place");
    }

    #[test]
    fn a_line_that_is_not_utf8_is_skipped_not_the_end() {
        let d = std::env::temp_dir().join(format!("agent-page-utf-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("t.jsonl");
        let mut b = br#"{"type":"user","message":{"content":"go"}}"#.to_vec();
        b.extend_from_slice(b"\n\xff\xfe not text\n");
        b.extend_from_slice(br#"{"type":"assistant","message":{"content":[{"type":"text","text":"after"}]}}"#);
        std::fs::write(&f, b).unwrap();
        assert_eq!(claude_view(&f).unwrap()["lastText"], "after");
    }

    #[test]
    fn any_other_file_is_shown_as_text() {
        let d = std::env::temp_dir().join(format!("agent-page-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("log.txt");
        std::fs::write(&f, "step one\nstep two\n").unwrap();
        assert_eq!(view_of(&f), json!({"format": "text", "text": "step one\nstep two\n"}));
        let j = d.join("other.jsonl");
        std::fs::write(&j, "{\"event\": \"x\"}\n").unwrap();
        assert_eq!(view_of(&j)["format"], "text", "JSONL that is not Claude Code's");
    }

    #[test]
    fn a_shell_commands_setup_is_skipped_and_a_handback_is_the_answer() {
        assert_eq!(first_command("cd /w/repo; git show HEAD:a.rs | sed -n 1,9p"), "git show HEAD:a.rs | sed -n 1,9p");
        assert_eq!(first_command("cd /w && N=abc; s(){ git show \"$N:$1\"; }; s app/x.rs"), "s app/x.rs");
        assert_eq!(first_command("cargo test -p x"), "cargo test -p x");
        assert_eq!(first_command("cd /w\nexport X=1\ncargo test"), "cargo test", "setup on lines of its own");
        assert_eq!(first_command("RUST_LOG=debug cargo run && echo ok"), "RUST_LOG=debug cargo run", "an env-prefixed command is the step");
        assert_eq!(summary("Bash", &json!({"command": "cd /w; ls", "description": "List files"})), "List files");
        let home = crew_core::py::home().display().to_string();
        assert_eq!(summary("Read", &json!({"file_path": format!("{home}/code/a.rs")})), "~/code/a.rs");
        let d = std::env::temp_dir().join(format!("agent-page-hb-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("t.jsonl");
        std::fs::write(&f, [
            r#"{"type":"user","message":{"content":"review it"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"SubagentHandback","input":{"message":"Findings: blocker 0, major 2"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"a stray remark"}]}}"#,
        ].join("\n")).unwrap();
        let v = claude_view(&f).unwrap();
        assert_eq!(v["lastText"], "Findings: blocker 0, major 2", "the handback is the answer, not the last thing said");
    }

    #[test]
    fn a_tool_call_is_summed_up_in_one_line() {
        assert_eq!(summary("Bash", &json!({"command": "cargo test\n  -p x"})), "cargo test");
        assert_eq!(summary("Read", &json!({"file_path": "/w/a.rs"})), "/w/a.rs");
        assert_eq!(summary("Mystery", &json!({"description": "does a thing"})), "does a thing");
        assert_eq!(summary("Mystery", &json!({})), "");
    }
}
