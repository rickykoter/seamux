//! Python's `os.path` string functions, POSIX, for paths the tools print or
//! key files by: lexical, as Python's are, never touching the disk.

/// `os.path.join(a, b)` for two parts.
pub fn join(a: &str, b: &str) -> String {
    if b.starts_with('/') || a.is_empty() {
        b.to_string()
    } else if a.ends_with('/') {
        format!("{a}{b}")
    } else {
        format!("{a}/{b}")
    }
}

/// `os.path.normpath`: keeps a leading `//`, collapses `.` and `..`.
pub fn normpath(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let lead = if p.starts_with("//") && !p.starts_with("///") {
        2
    } else if p.starts_with('/') {
        1
    } else {
        0
    };
    let mut parts: Vec<&str> = Vec::new();
    for c in p.split('/') {
        if c.is_empty() || c == "." {
            continue;
        }
        if c != ".." || (lead == 0 && parts.is_empty()) || parts.last() == Some(&"..") {
            parts.push(c);
        } else if !parts.is_empty() {
            parts.pop();
        }
    }
    let out = "/".repeat(lead) + &parts.join("/");
    if out.is_empty() {
        ".".into()
    } else {
        out
    }
}

/// `os.path.abspath`: joined to the working directory, then normalized.
pub fn abspath(p: &str) -> String {
    if p.starts_with('/') {
        return normpath(p);
    }
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    normpath(&join(&cwd, p))
}

/// `os.path.basename`: everything after the last `/`.
pub fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// `os.path.expanduser("~")` as a string: HOME without its trailing `/`
/// (`/` when that leaves nothing), else the passwd entry.
pub fn home() -> String {
    let h = crew_core::py::home().to_string_lossy().into_owned();
    let t = h.trim_end_matches('/');
    if t.is_empty() {
        "/".into()
    } else {
        t.to_string()
    }
}

/// `p.replace(os.path.expanduser("~"), "~")`, every occurrence, as the Python
/// spells a path for display.
pub fn tilde(p: &str) -> String {
    p.replace(&home(), "~")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normpath_matches_posixpath() {
        for (i, o) in [
            ("", "."),
            ("/", "/"),
            ("//", "//"),
            ("///", "/"),
            ("a/./b/../c", "a/c"),
            ("../a", "../a"),
            ("/../a", "/a"),
            ("a/../..", ".."),
            ("/x/y/", "/x/y"),
            ("//x/../y", "//y"),
        ] {
            assert_eq!(normpath(i), o, "{i}");
        }
    }

    #[test]
    fn join_matches_os_path_join() {
        assert_eq!(join("", "x"), "x");
        assert_eq!(join("/a/", "x"), "/a/x");
        assert_eq!(join("/a", "/abs"), "/abs");
    }

    #[test]
    fn basename_matches() {
        assert_eq!(basename("/a/b"), "b");
        assert_eq!(basename("/a/b/"), "");
        assert_eq!(basename("b"), "b");
    }
}
