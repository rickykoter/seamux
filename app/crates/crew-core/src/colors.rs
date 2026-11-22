//! The colour crew-color gave a worktree, read from its registry: one file
//! per worktree root under `<cache>/colors`, named by the root's md5, holding
//! KEY=value lines, COLOR among them. crew-color (crew-cli) writes it; this
//! only reads, so crew-board's tmux rows and crew-cli's own `peek` share one
//! reader (plan board-tmux-chips).

use std::path::{Path, PathBuf};

/// crew-color's registry folder.
pub fn registry() -> PathBuf {
    crate::home::xdg_cache().join("colors")
}

/// The colour crew-color registered for `root`, allocating nothing. None when
/// it registered none, or the entry has no COLOR.
pub fn peek(root: &str) -> Option<String> {
    peek_in(&registry(), root)
}

/// `peek`, in a given registry folder (tests pass a temp one).
pub fn peek_in(dir: &Path, root: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(crate::md5::hex(root.as_bytes()))).ok()?;
    // Universal newlines, as the Python read it; the last COLOR wins, as a dict's would.
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    text.lines()
        .filter_map(|l| l.split_once('='))
        .filter(|(k, _)| k.trim() == "COLOR")
        .map(|(_, v)| v.trim().to_string())
        .last()
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        // A temp registry, never the person's cache.
        let d = std::env::temp_dir().join(format!("crew-colors-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_the_color_crew_color_registered_for_a_root() {
        let d = dir("read");
        let root = "/w/shop";
        std::fs::write(d.join(crate::md5::hex(root.as_bytes())), "NAME=teal\nROOT=/w/shop\nCOLOR=#2aa198\nCREATED=1\n").unwrap();
        assert_eq!(peek_in(&d, root).as_deref(), Some("#2aa198"));
        assert_eq!(peek_in(&d, "/w/other"), None, "another root has no entry");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_empty_color_crlf_lines_and_a_repeated_key_read_as_the_python_did() {
        let d = dir("edge");
        let f = |root: &str| d.join(crate::md5::hex(root.as_bytes()));
        std::fs::write(f("/a"), "COLOR=\nROOT=/a\n").unwrap();
        assert_eq!(peek_in(&d, "/a"), None, "an empty COLOR is none");
        std::fs::write(f("/b"), "ROOT=/b\r\nCOLOR = #111111 \r\nCOLOR=#222222\r\n").unwrap();
        assert_eq!(peek_in(&d, "/b").as_deref(), Some("#222222"), "trimmed, last one wins");
        std::fs::write(f("/c"), "no equals sign here\n").unwrap();
        assert_eq!(peek_in(&d, "/c"), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
