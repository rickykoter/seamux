//! The typed ops every port asked for (port-cli's and port-hooks' published
//! lists, plus the app's reads).
//!
//! Each op has two encodings. The CLI one is the argv crew's Python sends
//! today, byte for byte, because fakecmux logs it and the probes assert on the
//! log. The socket one is used when the transport is the socket and
//! `system.capabilities` lists the method. An op is socket-encoded only where
//! the CLI's request is a plain mapping of its flags (read from cmux's CLI
//! source); where the CLI does real work client-side, the op stays on the CLI
//! so the two can never disagree. The two tables below are that record.
//!
//! For a verb with no op here, callers use `Cmux::cli(argv)`.

use serde_json::{json, Map, Value};

use crate::{check_handle, parse_cli_json, Cmux, Error};

/// Ops that use the socket when cmux lists the method: (op, method).
pub const SOCKET_OPS: &[(&str, &str)] = &[
    ("ping", "system.ping"),
    ("workspace_list", "workspace.list"),
    ("current_list", "current.list"),
    ("read_text", "surface.read_text"),
    ("send_text", "surface.send_text"),
    ("surface_focus", "surface.focus"),
    ("workspace_select", "workspace.select"),
    ("workspace_status", "workspace.status.get"),
    ("workspace_status_set", "workspace.status.set"),
    ("workspace_action", "workspace.action"),
    ("rename_workspace", "workspace.rename"),
    ("close_surface", "surface.close"),
    ("rpc", "(the named method)"),
    ("events", "events.stream"),
];

/// Ops that always run the CLI verb, and why (cmux 0.64.25).
pub const CLI_ONLY_OPS: &[(&str, &str)] = &[
    ("sidebar_state", "no socket method"),
    ("set_progress", "no socket method"),
    ("clear_progress", "no socket method"),
    ("set_status", "no socket method"),
    ("clear_status", "no socket method"),
    ("reload_config", "no socket method; the CLI also reloads Ghostty's config"),
    ("todo_set", "the CLI parses the items argument client-side"),
    ("notify", "the CLI targets the caller's own surface client-side"),
    ("rename_tab", "the CLI resolves the tab from the surface client-side"),
    ("new_pane", "callers parse the CLI's `OK surface:N pane:N` line"),
    ("respawn_pane", "the CLI builds the command and environment client-side"),
];

/// `workspace-action` edits crew makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceAction {
    SetColor(String),
    ClearColor,
    SetDescription(String),
    ClearDescription,
}

/// A `notify` call. Flags are passed in the order crew's Python passes them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Notify {
    pub title: String,
    pub subtitle: Option<String>,
    pub body: Option<String>,
    pub workspace: Option<String>,
}

/// A `new-pane` call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewPane {
    /// terminal or browser
    pub kind: String,
    pub direction: Option<String>,
    pub workspace: Option<String>,
    pub url: Option<String>,
    pub focus: Option<bool>,
}

fn s(v: &str) -> String {
    v.to_string()
}

impl Cmux {
    /// Route one op: the socket method when allowed and listed, else the CLI.
    /// `handles` are checked before anything reaches the socket.
    fn route(
        &self,
        socket: Option<(&str, Value)>,
        handles: &[(&str, &str)],
        argv: Vec<String>,
    ) -> Result<Routed, Error> {
        if let Some((method, params)) = socket {
            if self.has_method(method) {
                for (kind, h) in handles {
                    check_handle(kind, h)?;
                }
                return self.call(method, params).map(Routed::Socket);
            }
        }
        self.cli_checked(&argv).map(|o| Routed::Cli(o.stdout))
    }

    pub fn ping(&self) -> Result<(), Error> {
        self.route(Some(("system.ping", json!({}))), &[], vec![s("ping")]).map(|_| ())
    }

    /// `workspace list --json`, as cmux prints it (`{"window_ref", "workspaces": [...]}`).
    pub fn workspace_list(&self, window: Option<&str>) -> Result<Value, Error> {
        let mut argv = vec![s("workspace"), s("list"), s("--json")];
        let mut params = Map::new();
        if let Some(w) = window {
            argv.extend([s("--window"), s(w)]);
            params.insert("window_id".into(), json!(w));
        }
        self.route(Some(("workspace.list", Value::Object(params))), &[], argv)?.json()
    }

    /// `current --json`: per-agent state (working, needs_input, ended).
    pub fn current_list(&self, limit: Option<u32>) -> Result<Value, Error> {
        let mut argv = vec![s("current"), s("--json")];
        let mut params = Map::new();
        if let Some(n) = limit {
            argv.extend([s("--limit"), n.to_string()]);
            params.insert("limit".into(), json!(n));
        }
        self.route(Some(("current.list", Value::Object(params))), &[], argv)?.json()
    }

    /// The text on a surface (`read-screen`), with the last `lines` of scrollback.
    pub fn read_text(&self, surface: &str, lines: Option<u32>) -> Result<String, Error> {
        let mut argv = vec![s("read-screen"), s("--surface"), s(surface)];
        let mut params = json!({"surface_id": surface});
        if let Some(n) = lines {
            argv.extend([s("--lines"), n.to_string()]);
            params["lines"] = json!(n);
            params["scrollback"] = json!(true);
        }
        match self.route(Some(("surface.read_text", params)), &[("surface", surface)], argv)? {
            Routed::Socket(v) => Ok(v.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
            Routed::Cli(out) => Ok(out),
        }
    }

    /// Type text into a surface, with `cmux send`'s escapes on both paths: a
    /// literal `\n` or `\r` (backslash, letter) is Enter and `\t` a tab. The
    /// CLI applies them itself; the socket path applies the same rule here,
    /// so a caller gets one meaning whatever the transport.
    pub fn send_text(&self, surface: &str, text: &str) -> Result<(), Error> {
        let argv = vec![s("send"), s("--surface"), s(surface), s(text)];
        let params = json!({"surface_id": surface, "text": unescape_send_text(text)});
        self.route(Some(("surface.send_text", params)), &[("surface", surface)], argv).map(|_| ())
    }

    /// `focus-panel --panel S [--workspace W]`.
    pub fn surface_focus(&self, surface: &str, workspace: Option<&str>) -> Result<(), Error> {
        let mut argv = vec![s("focus-panel"), s("--panel"), s(surface)];
        let mut params = json!({"surface_id": surface});
        let mut handles = vec![("surface", surface)];
        if let Some(ws) = workspace {
            argv.extend([s("--workspace"), s(ws)]);
            params["workspace_id"] = json!(ws);
            handles.push(("workspace", ws));
        }
        self.route(Some(("surface.focus", params)), &handles, argv).map(|_| ())
    }

    /// `workspace select W`.
    pub fn workspace_select(&self, workspace: &str) -> Result<(), Error> {
        let argv = vec![s("workspace"), s("select"), s(workspace)];
        let params = json!({"workspace_id": workspace});
        self.route(Some(("workspace.select", params)), &[("workspace", workspace)], argv).map(|_| ())
    }

    /// The workspace's lane: `{"effective", "inferred", "override"}`, override
    /// null when automatic. The CLI path parses `cmux workspace status`'s text,
    /// whose argv crew-sync sends today.
    pub fn workspace_status(&self, workspace: &str) -> Result<Value, Error> {
        let argv = vec![s("workspace"), s("status"), s("--workspace"), s(workspace)];
        let params = json!({"workspace_id": workspace});
        match self.route(Some(("workspace.status.get", params)), &[("workspace", workspace)], argv)? {
            // The socket's override is an object ({"status", "inferred_at_override"})
            // or null; the CLI prints only its status. Both become the status.
            Routed::Socket(v) => Ok(json!({
                "effective": v.get("effective").cloned().unwrap_or(Value::Null),
                "inferred": v.get("inferred").cloned().unwrap_or(Value::Null),
                "override": match v.get("override") {
                    Some(Value::Object(o)) => o.get("status").cloned().unwrap_or(Value::Null),
                    Some(Value::String(s)) => json!(s),
                    _ => Value::Null,
                },
            })),
            Routed::Cli(out) => Ok(parse_status_text(&out)),
        }
    }

    /// `workspace status set <lane|auto> --workspace W`.
    pub fn workspace_status_set(&self, workspace: &str, status: &str) -> Result<(), Error> {
        let argv = vec![s("workspace"), s("status"), s("set"), s(status), s("--workspace"), s(workspace)];
        let params = json!({"workspace_id": workspace, "status": status});
        self.route(Some(("workspace.status.set", params)), &[("workspace", workspace)], argv).map(|_| ())
    }

    /// `workspace-action --action <a> [--color C | --description D] --workspace W`.
    pub fn workspace_action(&self, workspace: &str, action: &WorkspaceAction) -> Result<(), Error> {
        let mut argv = vec![s("workspace-action"), s("--action")];
        let mut params = json!({"workspace_id": workspace, "force": false});
        match action {
            WorkspaceAction::SetColor(c) => {
                argv.extend([s("set-color"), s("--color"), c.clone()]);
                params["action"] = json!("set_color");
                params["color"] = json!(c);
            }
            WorkspaceAction::ClearColor => {
                argv.push(s("clear-color"));
                params["action"] = json!("clear_color");
            }
            WorkspaceAction::SetDescription(d) => {
                argv.extend([s("set-description"), s("--description"), d.clone()]);
                params["action"] = json!("set_description");
                params["description"] = json!(d);
            }
            WorkspaceAction::ClearDescription => {
                argv.push(s("clear-description"));
                params["action"] = json!("clear_description");
            }
        }
        argv.extend([s("--workspace"), s(workspace)]);
        self.route(Some(("workspace.action", params)), &[("workspace", workspace)], argv).map(|_| ())
    }

    /// `rename-workspace --workspace W <title>`.
    pub fn rename_workspace(&self, workspace: &str, title: &str) -> Result<(), Error> {
        let argv = vec![s("rename-workspace"), s("--workspace"), s(workspace), s(title)];
        let params = json!({"workspace_id": workspace, "title": title});
        self.route(Some(("workspace.rename", params)), &[("workspace", workspace)], argv).map(|_| ())
    }

    /// `close-surface --surface S`.
    pub fn close_surface(&self, surface: &str) -> Result<(), Error> {
        let argv = vec![s("close-surface"), s("--surface"), s(surface)];
        let params = json!({"surface_id": surface, "force": false});
        self.route(Some(("surface.close", params)), &[("surface", surface)], argv).map(|_| ())
    }

    /// `cmux rpc <method> <json>`: any v2 method (feed.list, feed.reply,
    /// notification.create, ...). The socket path calls it directly.
    pub fn rpc(&self, method: &str, params: Value) -> Result<Value, Error> {
        self.call(method, params)
    }

    // ---- CLI-only ops ------------------------------------------------------

    /// `sidebar-state --workspace W`: cmux's text, as crew parses it today.
    pub fn sidebar_state(&self, workspace: &str) -> Result<String, Error> {
        Ok(self.cli_checked(&[s("sidebar-state"), s("--workspace"), s(workspace)])?.stdout)
    }

    /// `set-progress <frac> --label L --workspace W`, frac printed `{:.4}` as
    /// crew-sync prints it.
    pub fn set_progress(&self, workspace: &str, frac: f64, label: &str) -> Result<(), Error> {
        let argv = vec![s("set-progress"), format!("{frac:.4}"), s("--label"), s(label), s("--workspace"), s(workspace)];
        self.cli_checked(&argv).map(|_| ())
    }

    /// `clear-progress --workspace W`.
    pub fn clear_progress(&self, workspace: &str) -> Result<(), Error> {
        self.cli_checked(&[s("clear-progress"), s("--workspace"), s(workspace)]).map(|_| ())
    }

    /// `todo set <items-json> --workspace W`; items as crew-sync encodes them.
    pub fn todo_set(&self, workspace: &str, items_json: &str) -> Result<(), Error> {
        self.cli_checked(&[s("todo"), s("set"), s(items_json), s("--workspace"), s(workspace)]).map(|_| ())
    }

    /// `set-status <key> <value> [--icon I] [--color C] [--workspace W]`.
    pub fn set_status(
        &self,
        key: &str,
        value: &str,
        icon: Option<&str>,
        color: Option<&str>,
        workspace: Option<&str>,
    ) -> Result<(), Error> {
        let mut argv = vec![s("set-status"), s(key), s(value)];
        for (flag, v) in [("--icon", icon), ("--color", color), ("--workspace", workspace)] {
            if let Some(v) = v {
                argv.extend([s(flag), s(v)]);
            }
        }
        self.cli_checked(&argv).map(|_| ())
    }

    /// `clear-status <key> [--workspace W]`.
    pub fn clear_status(&self, key: &str, workspace: Option<&str>) -> Result<(), Error> {
        let mut argv = vec![s("clear-status"), s(key)];
        if let Some(ws) = workspace {
            argv.extend([s("--workspace"), s(ws)]);
        }
        self.cli_checked(&argv).map(|_| ())
    }

    /// `notify --title T [--subtitle S] [--body B] [--workspace W]`.
    pub fn notify(&self, n: &Notify) -> Result<(), Error> {
        let mut argv = vec![s("notify"), s("--title"), n.title.clone()];
        for (flag, v) in [("--subtitle", &n.subtitle), ("--body", &n.body), ("--workspace", &n.workspace)] {
            if let Some(v) = v {
                argv.extend([s(flag), v.clone()]);
            }
        }
        self.cli_checked(&argv).map(|_| ())
    }

    /// `reload-config`: cmux.json and Ghostty's config.
    pub fn reload_config(&self) -> Result<(), Error> {
        self.cli_checked(&[s("reload-config")]).map(|_| ())
    }

    /// `rename-tab --surface S <title>`.
    pub fn rename_tab(&self, surface: &str, title: &str) -> Result<(), Error> {
        self.cli_checked(&[s("rename-tab"), s("--surface"), s(surface), s(title)]).map(|_| ())
    }

    /// `new-pane --type K [--direction D] [--workspace W] [--url U] [--focus B]`.
    /// Returns the new surface's ref from cmux's `OK surface:N pane:N ...` line.
    pub fn new_pane(&self, p: &NewPane) -> Result<String, Error> {
        let mut argv = vec![s("new-pane"), s("--type"), p.kind.clone()];
        for (flag, v) in [("--direction", &p.direction), ("--workspace", &p.workspace), ("--url", &p.url)] {
            if let Some(v) = v {
                argv.extend([s(flag), v.clone()]);
            }
        }
        if let Some(f) = p.focus {
            argv.extend([s("--focus"), s(if f { "true" } else { "false" })]);
        }
        let out = self.cli_checked(&argv)?.stdout;
        out.split_whitespace()
            .find(|t| t.starts_with("surface:"))
            .map(String::from)
            .ok_or_else(|| Error::Protocol(format!("new-pane printed no surface: {}", out.trim())))
    }

    /// `respawn-pane --surface S --command C`.
    pub fn respawn_pane(&self, surface: &str, command: &str) -> Result<(), Error> {
        self.cli_checked(&[s("respawn-pane"), s("--surface"), s(surface), s("--command"), s(command)]).map(|_| ())
    }
}

enum Routed {
    Socket(Value),
    Cli(String),
}

impl Routed {
    fn json(self) -> Result<Value, Error> {
        match self {
            Routed::Socket(v) => Ok(v),
            Routed::Cli(out) => parse_cli_json(&out),
        }
    }
}

/// The CLI's `unescapeSendText` (cmux CLI/cmux.swift): `\n` and `\r` become
/// a carriage return (Enter), `\t` a tab, applied in that order.
pub(crate) fn unescape_send_text(t: &str) -> String {
    t.replace("\\n", "\r").replace("\\r", "\r").replace("\\t", "\t")
}

/// `cmux workspace status` prints
/// ```text
/// working
/// inferred: working
/// override: none (auto)
/// ```
pub(crate) fn parse_status_text(out: &str) -> Value {
    let mut lines = out.lines().map(str::trim).filter(|l| !l.is_empty());
    let effective = lines.next().map(String::from);
    let mut inferred = None;
    let mut override_ = None;
    for l in lines {
        if let Some(v) = l.strip_prefix("inferred:") {
            inferred = v.split_whitespace().next().map(String::from);
        } else if let Some(v) = l.strip_prefix("override:") {
            override_ = v.split_whitespace().next().filter(|v| *v != "none").map(String::from);
        }
    }
    json!({"effective": effective, "inferred": inferred, "override": override_})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_text_parses_like_the_socket() {
        let v = parse_status_text("working\ninferred: working\noverride: none (auto)\n");
        assert_eq!(v, json!({"effective": "working", "inferred": "working", "override": null}));
        let v = parse_status_text("review\ninferred: working\noverride: review\n");
        assert_eq!(v["override"], json!("review"));
    }

    #[test]
    fn send_text_escapes_match_the_cli() {
        assert_eq!(unescape_send_text("ls\\n"), "ls\r");
        assert_eq!(unescape_send_text("a\\tb\\r"), "a\tb\r");
        assert_eq!(unescape_send_text("real\nnewline"), "real\nnewline");
    }

    #[test]
    fn every_op_is_in_one_table() {
        let all: Vec<&str> = SOCKET_OPS.iter().chain(CLI_ONLY_OPS).map(|(o, _)| *o).collect();
        let mut dedup = all.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(all.len(), dedup.len(), "an op is in both tables");
    }
}
