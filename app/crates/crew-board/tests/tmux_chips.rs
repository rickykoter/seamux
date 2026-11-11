//! The board's code and sandbox chips on the tmux backend run crew's own
//! scripts with the row's worktree, as triage does on cmux. A fake crew home
//! stands in for the scripts: each writes the arguments it was given.
//! (Its own process, so SEAMUX_BACKEND is read before anything picks.)

use std::path::Path;
use std::time::{Duration, Instant};

fn script(dir: &Path, name: &str, out: &Path) {
    let p = dir.join("bin").join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", out.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn wait_for(p: &Path) -> String {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(10) {
        if let Ok(s) = std::fs::read_to_string(p) {
            if !s.is_empty() {
                return s;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{} was never written", p.display());
}

#[test]
fn code_and_sandbox_chips_run_crews_scripts_on_tmux() {
    let tmp = std::env::temp_dir().join(format!("tmux-chips-{}", std::process::id()));
    let home = tmp.join("crew");
    let worktree = tmp.join("wt");
    std::fs::create_dir_all(&worktree).unwrap();
    let (code_out, sandbox_out) = (tmp.join("code.args"), tmp.join("sandbox.args"));
    script(&home, "crew-code", &code_out);
    script(&home, "crew-sandbox", &sandbox_out);
    // SAFETY: set before any thread of this test process reads them.
    unsafe {
        std::env::set_var("SEAMUX_BACKEND", "tmux");
        std::env::set_var("CREW_HOME", &home);
        std::env::set_var("XDG_CACHE_HOME", tmp.join("cache"));
    }
    let wt = worktree.to_string_lossy().into_owned();
    let row: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(serde_json::json!({"id": "F7C77CFC-3416-43EA-BD60-2CEB74953A19", "cwd": wt, "name": "wt"})).unwrap();

    let (ok, why) = crew_board::act::act("code", &row, "");
    assert!(ok, "{why}");
    assert_eq!(wait_for(&code_out).trim(), wt);

    let (ok, why) = crew_board::act::act("sandbox-up", &row, "");
    assert!(ok, "{why}");
    assert_eq!(wait_for(&sandbox_out).lines().collect::<Vec<_>>(), vec!["up", wt.as_str()]);

    // Reclaim still asks first, in the app's own wizard.
    let (ok, why) = crew_board::act::act("reclaim", &row, "");
    assert!(!ok && why.contains("wizard"), "{why}");
    let _ = std::fs::remove_dir_all(&tmp);
}
