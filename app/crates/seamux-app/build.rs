// The app's build stamps the commit it was built from (SEAMUX_BUILD_SHA),
// which the running app writes to app-build.json at start, so a landing can
// tell that the app now running is the merge (plan landing). The same code
// stamps the seamux CLI (seamux-cli/build.rs).
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let o = Command::new("git").args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn main() {
    // `<sha>`, `<sha>-dirty` when tracked files differ from it, or `unknown`
    // outside a git checkout (a source tarball).
    let sha = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    // --no-optional-locks: status must not take the index lock to refresh it,
    // or a build would race the person's own git commands in this checkout.
    let dirty = git(&["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
    println!("cargo:rustc-env=SEAMUX_BUILD_SHA={sha}{}", if dirty && sha != "unknown" { "-dirty" } else { "" });
    // Built again when HEAD moves (a pull, a checkout, a commit) or the index
    // changes, even when no file of this crate did: a stale stamp would never
    // match the merge it was built from.
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        for f in ["HEAD", "logs/HEAD", "index"] {
            println!("cargo:rerun-if-changed={dir}/{f}");
        }
    }
    tauri_build::build()
}
