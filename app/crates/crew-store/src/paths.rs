//! Where the store's files are, and how a path is spelled as a key.
//!
//! `realpath` and `norm` are Python's `os.path.realpath` and artifacts.py's
//! `norm`, not `fs::canonicalize`: they must also resolve paths that no
//! longer exist (a temp file already gone, a deleted worktree), the way the
//! Python resolves whatever prefix still exists.

use std::path::PathBuf;

/// The store's paths, resolved from the environment as artifacts.py does at
/// import time.
#[derive(Debug, Clone)]
pub struct Paths {
    pub home: String,
    /// ~/.claude/crew, or CREW_DURABLE_DIR.
    pub crew_home: String,
    pub db: String,
    pub lock: String,
    pub again: String,
    pub kept: String,
    pub projects: String,
    pub plans: String,
    pub dp_state: String,
    pub scratch_base: String,
    pub temp_roots: Vec<String>,
}

fn s(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

fn join(a: &str, b: &str) -> String {
    if a.ends_with('/') {
        format!("{a}{b}")
    } else {
        format!("{a}/{b}")
    }
}

impl Paths {
    pub fn from_env() -> Paths {
        let home = s(crew_core::py::home());
        let crew_home = crew_core::py::env_or("CREW_DURABLE_DIR")
            .unwrap_or_else(|| join(&join(&home, ".claude"), "crew"));
        let lock = join(&crew_home, "index.lock");
        let claude = join(&home, ".claude");
        // SAFETY: getuid cannot fail.
        let uid = unsafe { libc::getuid() };
        let scratch_base = crew_core::py::env_or("CREW_SCRATCH_BASE")
            .unwrap_or_else(|| format!("/private/tmp/claude-{uid}"));
        // Python keeps empty pieces of the split (an empty root matches
        // everything), so this does too.
        let temp_roots = match crew_core::py::env_or("CREW_TEMP_ROOTS") {
            Some(v) => v.split(':').map(str::to_string).collect(),
            None => ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"]
                .iter()
                .map(|x| x.to_string())
                .collect(),
        };
        Paths {
            db: join(&crew_home, "artifacts.db"),
            again: format!("{lock}.again"),
            lock,
            kept: join(&crew_home, "kept"),
            projects: join(&claude, "projects"),
            plans: join(&claude, "plans"),
            dp_state: join(&join(&claude, "deep-plan"), "state"),
            crew_home,
            home,
            scratch_base,
            temp_roots,
        }
    }

    pub fn is_temp(&self, path: &str) -> bool {
        self.temp_roots.iter().any(|r| path.starts_with(r.as_str()))
    }
}

/// `os.path.expanduser`: `~` and `~/...` from HOME, `~user` and `~user/...`
/// from the passwd entry; an unknown user leaves the path as written.
pub fn expanduser(p: &str) -> String {
    if p == "~" || p.starts_with("~/") {
        return s(crew_core::py::expand_user(p));
    }
    let Some(rest) = p.strip_prefix('~') else { return p.to_string() };
    let (user, tail) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    match user_home(user) {
        Some(h) => {
            let h = h.trim_end_matches('/');
            format!("{}{}", if h.is_empty() { "/" } else { h }, tail)
        }
        None => p.to_string(),
    }
}

fn user_home(user: &str) -> Option<String> {
    use std::ffi::{CStr, CString};
    let name = CString::new(user).ok()?;
    // SAFETY: getpwnam_r fills pwd from buf, both owned here; dir is copied
    // out before either goes out of scope.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwnam_r(name.as_ptr(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut out);
        if rc != 0 || out.is_null() || pwd.pw_dir.is_null() {
            return None;
        }
        Some(CStr::from_ptr(pwd.pw_dir).to_string_lossy().into_owned())
    }
}

fn cwd() -> String {
    std::env::current_dir().map(s).unwrap_or_else(|_| "/".to_string())
}

/// `os.path.normpath`: lexical, for POSIX. Keeps a leading `//` as Python does.
pub fn normpath(p: &str) -> String {
    if p.is_empty() {
        return ".".to_string();
    }
    let initial = if p.starts_with("//") && !p.starts_with("///") {
        2
    } else if p.starts_with('/') {
        1
    } else {
        0
    };
    let mut out: Vec<&str> = Vec::new();
    for c in p.split('/') {
        if c.is_empty() || c == "." {
            continue;
        }
        if c != ".." || (initial == 0 && out.is_empty()) || out.last() == Some(&"..") {
            out.push(c);
        } else if !out.is_empty() {
            out.pop();
        }
    }
    let body = out.join("/");
    let s = format!("{}{}", "/".repeat(initial), body);
    if s.is_empty() {
        ".".to_string()
    } else {
        s
    }
}

/// `os.path.realpath(p)` (non-strict): absolute, every symlink in the part
/// that exists resolved, the rest kept as written.
pub fn realpath(p: &str) -> String {
    let abs = if p.starts_with('/') { p.to_string() } else { join(&cwd(), p) };
    let mut todo: std::collections::VecDeque<String> =
        abs.split('/').filter(|c| !c.is_empty()).map(str::to_string).collect();
    let mut out: Vec<String> = Vec::new();
    let mut hops = 0;
    while let Some(name) = todo.pop_front() {
        if name == "." {
            continue;
        }
        if name == ".." {
            out.pop();
            continue;
        }
        let cand = format!("/{}", out.iter().chain(std::iter::once(&name)).cloned().collect::<Vec<_>>().join("/"));
        match std::fs::read_link(&cand) {
            Ok(target) if hops < 40 => {
                hops += 1;
                let t = s(target);
                if t.starts_with('/') {
                    out.clear();
                }
                for c in t.split('/').filter(|c| !c.is_empty()).rev() {
                    todo.push_front(c.to_string());
                }
            }
            _ => out.push(name),
        }
    }
    format!("/{}", out.join("/"))
}

/// `os.path.split`: (head with trailing slashes stripped unless all slashes, tail).
pub fn split(p: &str) -> (String, String) {
    let i = p.rfind('/').map(|i| i + 1).unwrap_or(0);
    let (head, tail) = (&p[..i], &p[i..]);
    let trimmed = head.trim_end_matches('/');
    let head = if trimmed.is_empty() { head } else { trimmed };
    (head.to_string(), tail.to_string())
}

/// artifacts.py `norm`: absolute, the directory's symlinks resolved (/tmp is
/// /private/tmp here), so one file is one locator.
pub fn norm(path: &str) -> String {
    let p = normpath(&expanduser(path));
    let (d, b) = split(&p);
    join(&realpath(&d), &b)
}

/// artifacts.py `wskey`: a workspace as the store keys it: absolute,
/// symlinks resolved, no trailing slash.
pub fn wskey(ws: &str) -> String {
    if ws.is_empty() {
        return String::new();
    }
    let r = realpath(&expanduser(ws));
    let t = r.trim_end_matches('/');
    if t.is_empty() {
        "/".to_string()
    } else {
        t.to_string()
    }
}

/// artifacts.py `is_temp`, against this process's temp roots.
pub fn is_temp(path: &str) -> bool {
    Paths::from_env().is_temp(path)
}

/// `os.path.basename`.
pub fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normpath_like_python() {
        assert_eq!(normpath("/a//b/./c/../d/"), "/a/b/d");
        assert_eq!(normpath("a/../../b"), "../b");
        assert_eq!(normpath("//x/y"), "//x/y");
        assert_eq!(normpath("///x"), "/x");
        assert_eq!(normpath("/.."), "/");
    }

    #[test]
    fn split_like_python() {
        assert_eq!(split("/a/b"), ("/a".into(), "b".into()));
        assert_eq!(split("/b"), ("/".into(), "b".into()));
        assert_eq!(split("b"), ("".into(), "b".into()));
        assert_eq!(split("/a//b"), ("/a".into(), "b".into()));
    }

    #[test]
    fn realpath_resolves_tmp_and_missing_tails() {
        let r = realpath("/tmp/surely-not-here-xyz/f");
        assert!(r.ends_with("/tmp/surely-not-here-xyz/f"), "{r}");
        assert!(r.starts_with("/private/tmp/") || r.starts_with("/tmp/"), "{r}");
        assert_eq!(wskey("/"), "/");
    }

    #[test]
    fn expanduser_like_python() {
        assert_eq!(expanduser("~root/x"), format!("{}/x", user_home("root").unwrap().trim_end_matches('/')));
        assert_eq!(expanduser("~no-such-user-xyz/x"), "~no-such-user-xyz/x");
        assert_eq!(expanduser("a/~b"), "a/~b");
        assert_eq!(wskey(""), "");
    }
}
