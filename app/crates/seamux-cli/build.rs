// The seamux CLI's build stamps the commit it was built from
// (SEAMUX_BUILD_SHA), which `seamux --version` prints (plan landing). The
// app stamps itself the same way (seamux-app/build.rs).
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let o = Command::new("git").args(args).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn main() {
    // A build of an exported commit (install.sh --app --from <commit>) has no
    // git to ask, so the installer names the commit in SEAMUX_BUILD_SHA.
    println!("cargo:rerun-if-env-changed=SEAMUX_BUILD_SHA");
    let given = std::env::var("SEAMUX_BUILD_SHA").ok().filter(|s| !s.trim().is_empty());
    if let Some(sha) = given {
        println!("cargo:rustc-env=SEAMUX_BUILD_SHA={}", sha.trim());
    } else {
        // `<sha>`, `<sha>-dirty` when tracked files differ from it, or `unknown`
        // outside a git checkout (a source tarball).
        let sha = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
        // --no-optional-locks: status must not take the index lock to refresh it,
        // or a build would race the person's own git commands in this checkout.
        let dirty = git(&["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty());
        println!("cargo:rustc-env=SEAMUX_BUILD_SHA={sha}{}", if dirty && sha != "unknown" { "-dirty" } else { "" });
    }
    if let Some(dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        for f in ["HEAD", "logs/HEAD", "index"] {
            println!("cargo:rerun-if-changed={dir}/{f}");
        }
    }
}
