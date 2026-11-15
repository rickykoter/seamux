// The seamux CLI's build stamps the commit it was built from
// (SEAMUX_BUILD_SHA), which `seamux --version` prints (plan landing). The
// app stamps itself the same way (seamux-app/build.rs).
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let o = Command::new("git").args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn main() {
    let sha = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    // --no-optional-locks: status must not take the index lock to refresh it,
    // or a build would race the person's own git commands in this checkout.
    let dirty = git(&["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
    println!("cargo:rustc-env=SEAMUX_BUILD_SHA={sha}{}", if dirty && sha != "unknown" { "-dirty" } else { "" });
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        for f in ["HEAD", "logs/HEAD", "index"] {
            println!("cargo:rerun-if-changed={dir}/{f}");
        }
    }
}
