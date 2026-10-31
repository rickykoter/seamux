//! A native pane's links: which file paths in its text exist, opening one in
//! VS Code at its line, the workspace a pane belongs to, and GitHub hover
//! cards. The pure parts live in seamux_app::pane.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use seamux_app::pane::{card, gh_ref, resolve, vscode_url, workspace_of, Card, ISSUE_FIELDS, PR_FIELDS};
use seamux_app::pty::{main_pane, tmux_bin, Target};
use serde_json::Value;

/// The folder Claude works in, as tmux knows it: its own pane's, never the
/// companion shell's, whichever has the keys.
pub fn pane_cwd(t: &Target) -> Option<PathBuf> {
    let id = main_pane(t)?;
    let o = Command::new(tmux_bin())
        .args(["-S", &t.socket, "display-message", "-p", "-t", &id, "#{pane_current_path}"])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (o.status.success() && s.starts_with('/')).then(|| PathBuf::from(s))
}

/// Of `cands` (path-like text in the pane), each as the existing absolute
/// path it names, or None.
pub fn existing(t: &Target, cands: &[String]) -> Vec<Option<String>> {
    let Some(cwd) = pane_cwd(t) else { return vec![None; cands.len()] };
    let home = crew_core::py::home();
    cands.iter().map(|c| resolve(&cwd, &home, c).map(|p| p.to_string_lossy().into_owned())).collect()
}

/// The cmux workspace the session belongs to.
pub fn workspace(t: &Target) -> Option<String> {
    let file = crew_core::py::home().join(".cmux/local-tmux/sessions.json");
    let reg: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    workspace_of(&reg, &t.session)
}

/// Open `path` (absolute, existing) in VS Code at `line` and `col`.
#[tauri::command]
pub async fn open_in_editor(path: String, line: Option<u32>, col: Option<u32>) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() || !p.exists() {
        return Err(format!("not a file here: {path:?}"));
    }
    let url = vscode_url(p, line, col);
    tauri::async_runtime::spawn_blocking(move || {
        let st = Command::new("/usr/bin/open").arg(&url).status().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err("VS Code did not open (is it installed?)".into()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// gh, from PATH or the usual places.
fn gh_bin() -> String {
    let home = crew_core::py::home();
    let local = home.join(".local/bin").to_string_lossy().into_owned();
    for dir in std::env::var("PATH").unwrap_or_default().split(':').chain([local.as_str(), "/opt/homebrew/bin", "/usr/local/bin"]) {
        let p = Path::new(dir).join("gh");
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    "gh".into()
}

/// A GitHub pull request or issue link as a hover card, from gh. None for
/// a link that is neither.
#[tauri::command]
pub async fn gh_card(url: String) -> Result<Option<Card>, String> {
    let Some((kind, url)) = gh_ref(&url) else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || {
        let (sub, fields) = if kind == "pr" { ("pr", PR_FIELDS) } else { ("issue", ISSUE_FIELDS) };
        let o = Command::new(gh_bin()).args([sub, "view", &url, "--json", fields]).stdin(Stdio::null()).output().map_err(|e| format!("gh: {e}"))?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
        }
        let v: Value = serde_json::from_slice(&o.stdout).map_err(|e| e.to_string())?;
        Ok(Some(card(kind, &v)))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- links in a pane ----

/// A link from a pane the app will hand to the browser: http or https only,
/// with no whitespace or control characters, and of a sane length. Anything
/// else (file:, a custom scheme, text that only looks like a URL) is refused.
pub fn url_ok(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
    rest.is_some_and(|r| !r.is_empty())
        && url.len() <= 4096
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Open a link found in a pane in the default browser (macOS `open`, no shell).
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !url_ok(&url) {
        return Err(format!("not a link the app opens: {url:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let st = std::process::Command::new("/usr/bin/open").arg(&url).status().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(format!("open {url} exited {st}")) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put `text` on the clipboard (macOS `pbcopy`, no shell): a terminal's copy,
/// which tmux hands over after the mouse is let go, too late for the page's
/// own clipboard (WebKit wants a click in progress).
#[tauri::command]
pub async fn copy_text(text: String) -> Result<(), String> {
    if text.len() > 8 << 20 {
        return Err("too much to copy".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let mut c = std::process::Command::new("/usr/bin/pbcopy").stdin(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        c.stdin.take().ok_or("pbcopy has no stdin")?.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        let st = c.wait().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(format!("pbcopy exited {st}")) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The worktree a pane's directory is in (git's top level), else the
/// directory itself.
fn worktree_of(dir: &str) -> String {
    std::process::Command::new("/usr/bin/git")
        .args(["-C", dir, "rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|t| t.starts_with('/'))
        .unwrap_or_else(|| dir.to_string())
}

fn git(root: &str, args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("/usr/bin/git").arg("-C").arg(root).args(args).output().ok()
}

/// Whether Peacock's file may be written in `root`, making sure git never
/// sees it: refused where the repo tracks .vscode/settings.json (it would show
/// as a change); where git would list it as new, it goes in the repo's own
/// exclude file (info/exclude, shared by its worktrees, never committed).
fn settings_ok(root: &str) -> Result<(), String> {
    const FILE: &str = ".vscode/settings.json";
    if !git(root, &["rev-parse", "--is-inside-work-tree"]).is_some_and(|o| o.status.success()) {
        return Ok(()); // not git: nothing to dirty
    }
    if git(root, &["ls-files", "--error-unmatch", FILE]).is_some_and(|o| o.status.success()) {
        return Err("this repo tracks .vscode/settings.json, so it was left uncolored".into());
    }
    if git(root, &["check-ignore", "-q", FILE]).is_some_and(|o| o.status.success()) {
        return Ok(());
    }
    let out = git(root, &["rev-parse", "--git-path", "info/exclude"]).filter(|o| o.status.success()).ok_or("git did not say where its exclude file is")?;
    let rel = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let path = if rel.starts_with('/') { std::path::PathBuf::from(rel) } else { std::path::Path::new(root).join(rel) };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let had = std::fs::read_to_string(&path).unwrap_or_default();
    let line = format!("/{FILE}");
    if !had.lines().any(|l| l.trim() == line) {
        let sep = if had.is_empty() || had.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&path, format!("{had}{sep}# seamux: Peacock's colors for VS Code\n{line}\n")).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The seamux CLI beside this app (in its bundle), else the one on the usual path.
/// The seamux CLI: the one in the bundle, else ~/.local/bin/seamux. Never
/// this app's own binary (see crew_board::server::serves).
pub(crate) fn seamux_cli() -> std::path::PathBuf {
    let bundled = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.parent()?.join("Resources/bin/seamux")));
    bundled.filter(|p| p.is_file()).unwrap_or_else(|| crew_core::py::home().join(".local/bin/seamux"))
}

/// Give the worktree its color in VS Code, as on the Dock: crew-color's
/// one color per worktree, written as Peacock's settings.
fn paint(root: &str) -> Result<(), String> {
    settings_ok(root)?;
    let out = std::process::Command::new(seamux_cli()).args(["crew-color", "apply", root]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(crew_color_why(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// crew-color's refusal as a note for the page: its last line, without the
/// terminal colors and the red cross it prints it with.
fn crew_color_why(stderr: &str) -> String {
    let line = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let mut plain = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // CSI: ESC [ ... final byte in @..~
            for d in chars.by_ref() {
                if ('@'..='~').contains(&d) && d != '[' {
                    break;
                }
            }
        } else {
            plain.push(c);
        }
    }
    let plain = plain.trim().trim_start_matches('✗').trim();
    if plain.is_empty() { "crew-color failed".into() } else { plain.to_string() }
}

/// What opening a worktree in VS Code did: the folder, and why it is not
/// colored, if it is not.
#[derive(serde::Serialize)]
pub struct Opened {
    folder: String,
    note: Option<String>,
}

/// Open the worktree a pane works in, in VS Code (by its bundle id, so it
/// needs no `code` on the app's PATH), wearing the worktree's color first.
#[tauri::command]
pub async fn open_in_vscode(dir: String) -> Result<Opened, String> {
    if !dir.starts_with('/') || !std::path::Path::new(&dir).is_dir() {
        return Err(format!("not a folder: {dir:?}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = worktree_of(&dir);
        // Colored before it opens, so VS Code reads the colors as it starts.
        let note = paint(&root).err();
        let st = std::process::Command::new("/usr/bin/open")
            .args(["-b", "com.microsoft.VSCode"])
            .arg(&root)
            .status()
            .map_err(|e| e.to_string())?;
        if st.success() { Ok(Opened { folder: root, note }) } else { Err("VS Code did not open (is it installed?)".into()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod url_tests {
    use super::url_ok;

    #[test]
    fn crew_color_refusal_reads_plainly() {
        let err = "\x1b[31m✗\x1b[0m /w/.vscode/settings.json has comments, which rewriting it would drop\n";
        assert_eq!(super::crew_color_why(err), "/w/.vscode/settings.json has comments, which rewriting it would drop");
        assert_eq!(super::crew_color_why(""), "crew-color failed");
    }

    #[test]
    fn open_url_takes_web_links_only() {
        assert!(url_ok("https://github.com/rickykoter/seamux/pull/76"));
        assert!(url_ok("HTTP://127.0.0.1:7345/plan/x?y=1#z"));
        assert!(!url_ok("file:///etc/passwd"));
        assert!(!url_ok("javascript:alert(1)"));
        assert!(!url_ok("https://"));
        assert!(!url_ok("https://a b"));
        assert!(!url_ok("https://a\nb"));
        assert!(!url_ok(&format!("https://{}", "a".repeat(5000))));
    }
}


/// cmux's terminal look (theme palette, colors, font) for the light or dark
/// appearance: the native terminal draws with it.
#[tauri::command]
pub async fn term_look(dark: bool) -> seamux_app::ghostty::Look {
    tauri::async_runtime::spawn_blocking(move || seamux_app::ghostty::look(dark)).await.unwrap_or_default()
}

#[cfg(test)]
mod worktree_tests {
    #[test]
    fn a_folder_inside_a_repo_opens_at_its_top_level() {
        let here = env!("CARGO_MANIFEST_DIR");
        let top = super::worktree_of(&format!("{here}/src"));
        assert!(std::path::Path::new(&top).join(".git").exists(), "{top}");
        assert_eq!(super::worktree_of("/"), "/");
    }
}

#[cfg(test)]
mod settings_tests {
    use std::process::Command;

    fn repo(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("seamux-peacock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let d = d.to_string_lossy().into_owned();
        Command::new("/usr/bin/git").args(["-C", &d, "init", "-q"]).status().unwrap();
        d
    }

    #[test]
    fn an_untracked_settings_file_is_kept_out_of_git() {
        let d = repo("excl");
        super::settings_ok(&d).unwrap();
        super::settings_ok(&d).unwrap(); // a second time adds nothing
        let ex = std::fs::read_to_string(format!("{d}/.git/info/exclude")).unwrap();
        assert_eq!(ex.matches("/.vscode/settings.json").count(), 1, "{ex}");
        std::fs::create_dir_all(format!("{d}/.vscode")).unwrap();
        std::fs::write(format!("{d}/.vscode/settings.json"), "{}").unwrap();
        let st = Command::new("/usr/bin/git").args(["-C", &d, "status", "--porcelain"]).output().unwrap();
        assert!(String::from_utf8_lossy(&st.stdout).trim().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_tracked_settings_file_is_left_alone() {
        let d = repo("tracked");
        std::fs::create_dir_all(format!("{d}/.vscode")).unwrap();
        std::fs::write(format!("{d}/.vscode/settings.json"), "{}").unwrap();
        Command::new("/usr/bin/git").args(["-C", &d, "add", ".vscode/settings.json"]).status().unwrap();
        assert!(super::settings_ok(&d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
