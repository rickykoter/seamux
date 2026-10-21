//! How crew-hooks starts another crew tool.
//!
//! A tool seamux registers runs as `seamux <tool>` on this executable; one it
//! does not yet register runs from the crew tree by path, as the bash and
//! Python did (`bin/crew-sync`, `python3 hooks/cachefacts.py`, ...). crew-code,
//! crew-sandbox and crew-reclaim are bash and always run by path.
//!
//! `SEAMUX_TOOLS_BY_PATH=1` runs every tool by path. hooks_probe sets it: its
//! copied crew tree holds logging stubs for the tools a hook spawns, and a
//! self-exec would go past them. crew-hooks' own tools (options, asked-hook)
//! always self-exec, since their parity is what the probe is testing.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

/// This crate's own tools: never run by path.
const OWN: &[&str] = &["options", "merge_settings", "statusline", "triage", "crew-hook", "asked-hook"];

/// Where each tool lives in the crew tree, and whether python3 runs it.
fn path_of(name: &str) -> (&'static str, bool) {
    match name {
        "cachefacts" => ("hooks/cachefacts.py", true),
        "asked" => ("hooks/asked.py", true),
        "workspaces" => ("hooks/workspaces.py", true),
        "options" => ("hooks/options.py", true),
        "judgments" => ("board/judgments.py", true),
        "crew-sync" => ("bin/crew-sync", false),
        "crew-feed" => ("bin/crew-feed", false),
        "crew-color" => ("bin/crew-color", false),
        "crew-listen" => ("bin/crew-listen", false),
        "crew-artifacts" => ("bin/crew-artifacts", false),
        "crew-code" => ("bin/crew-code", false),
        "crew-sandbox" => ("bin/crew-sandbox", false),
        "crew-reclaim" => ("bin/crew-reclaim", false),
        _ => ("", false),
    }
}

fn exe() -> Option<&'static PathBuf> {
    static E: OnceLock<Option<PathBuf>> = OnceLock::new();
    // Through links to the real binary: a tool name linked to seamux must
    // self-exec seamux, not the link (which would run that tool instead).
    E.get_or_init(|| std::env::current_exe().ok().map(|e| std::fs::canonicalize(&e).unwrap_or(e))).as_ref()
}

/// The names `seamux --tools` lists, asked once per process.
fn registered() -> &'static [String] {
    static R: OnceLock<Vec<String>> = OnceLock::new();
    R.get_or_init(|| {
        let Some(exe) = exe() else { return Vec::new() };
        // `--tools` only prints a list; 2 s is generous, and a hook cannot
        // afford the 5 s it would otherwise get.
        match crew_core::py::run(&exe.display().to_string(), &["--tools"], std::time::Duration::from_secs(2)) {
            Some((0, out, _)) => out.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect(),
            _ => Vec::new(),
        }
    })
}

/// The cmux client: the socket (or the CLI the environment asks for), else
/// the cmux CLI when the socket cannot be reached, which is what the Python
/// and bash, CLI-only, would still have run.
pub fn connect() -> Option<cmux::Cmux> {
    match cmux::Cmux::connect() {
        Ok(c) => Some(c),
        Err(_) => cmux::resolve_cli_bin().ok().and_then(|b| cmux::Cmux::open(cmux::Transport::Cli(b)).ok()),
    }
}

fn by_path() -> bool {
    std::env::var("SEAMUX_TOOLS_BY_PATH").is_ok_and(|v| v == "1")
}

/// A crew tool, resolved.
pub struct Tool {
    pub argv: Vec<String>,
    /// The file, when it runs by path (the bash checks `-x` on these).
    pub file: Option<PathBuf>,
}

impl Tool {
    /// False for a by-path tool whose file is missing or not executable,
    /// which the bash skips (`[ -x "$bin" ] || return 0`).
    pub fn runnable(&self) -> bool {
        match &self.file {
            None => true,
            Some(f) => is_executable(f),
        }
    }
}

pub fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// The argv that runs crew tool `name`, then `args`.
pub fn tool(name: &str, args: &[&str]) -> Tool {
    let own = OWN.contains(&name);
    if let Some(exe) = exe() {
        if own || (!by_path() && registered().iter().any(|t| t == name)) {
            let mut argv = vec![exe.display().to_string(), name.to_string()];
            argv.extend(args.iter().map(|a| a.to_string()));
            return Tool { argv, file: None };
        }
    }
    let (rel, python) = path_of(name);
    let file = crew_core::crew_home().join(if rel.is_empty() { name } else { rel });
    let mut argv = Vec::new();
    if python {
        argv.push("python3".to_string());
    }
    argv.push(file.display().to_string());
    argv.extend(args.iter().map(|a| a.to_string()));
    // python3 runs a .py whether or not it is executable; -x is the bash's
    // test for the shell tools only.
    Tool { argv, file: (!python).then_some(file) }
}

/// Start argv detached (`( nohup cmd >/dev/null 2>&1 & )`): a new session,
/// stdin from `stdin` or /dev/null, output to `out` or /dev/null.
pub fn detach(argv: &[String], stdin: Option<&Path>, out: Option<&Path>) -> std::io::Result<()> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.stdin(match stdin {
        Some(p) => Stdio::from(std::fs::File::open(p)?),
        None => Stdio::null(),
    });
    match out {
        Some(p) => {
            let f = std::fs::OpenOptions::new().append(true).create(true).open(p)?;
            cmd.stdout(Stdio::from(f.try_clone()?)).stderr(Stdio::from(f));
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            Ok(())
        });
    }
    cmd.spawn().map(|_| ())
}

/// Run argv to completion: (exit code, stdout). stdin from `input` (or
/// /dev/null), stderr to `err` (appended) or /dev/null. None when it could
/// not start.
pub fn run(argv: &[String], input: Option<&str>, err: Option<&Path>) -> Option<(i32, String)> {
    use std::io::Write;
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).stdout(Stdio::piped());
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    match err.and_then(|p| std::fs::OpenOptions::new().append(true).create(true).open(p).ok()) {
        Some(f) => cmd.stderr(Stdio::from(f)),
        None => cmd.stderr(Stdio::null()),
    };
    let mut child = cmd.spawn().ok()?;
    if let Some(text) = input {
        let mut si = child.stdin.take()?;
        let text = text.to_string();
        // A writer thread, so a child that never reads cannot stall us on a full pipe.
        std::thread::spawn(move || {
            let _ = si.write_all(text.as_bytes());
        });
    }
    let out = child.wait_with_output().ok()?;
    Some((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned()))
}
