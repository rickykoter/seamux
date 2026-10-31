//! `seamux crew-board-intent --selftest`: offline checks on what breaks
//! silently (crew doctor runs it). Route resolution and its refusals, the
//! mermaid swap, /open's refusals, the usage template's contract, billing
//! mode from a file, token and port reuse, and ask delivery against a fake
//! terminal. No server or cmux needed; it reads the real plans directory.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::ask::{self, Runner};
use crate::plans::{has_inlined_mermaid, open_file, plan_asset, plan_root, realpath};
use crate::server::{crew_file, dp_state, plans_dir, token_hex};
use crate::usage::{billing_mode, USAGE_SLOT};

struct T {
    ok: usize,
    bad: usize,
}

impl T {
    fn check(&mut self, name: &str, cond: bool, detail: &str) {
        if cond {
            self.ok += 1;
            println!("  ok   {name}");
        } else {
            self.bad += 1;
            println!("  FAIL {name}{}", if detail.is_empty() { String::new() } else { format!(" — {detail}") });
        }
    }
}

fn glob(dir: &Path, suffix: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().map(|n| n.to_string_lossy().ends_with(suffix) && !n.to_string_lossy().starts_with('.')).unwrap_or(false))
        .collect();
    v.sort();
    v
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Run `f` with HOME (and so every state path) pointed at a throwaway dir.
fn in_temp_home<R>(f: impl FnOnce(&Path) -> R) -> R {
    let saved = std::env::var_os("HOME");
    let dir = std::env::temp_dir().join(format!("crew-intent-selftest-{}-{}", std::process::id(), token_hex(3)));
    let _ = std::fs::create_dir_all(&dir);
    std::env::set_var("HOME", &dir);
    let r = f(&dir);
    match saved {
        Some(h) => std::env::set_var("HOME", h),
        None => std::env::remove_var("HOME"),
    }
    let _ = std::fs::remove_dir_all(&dir);
    r
}

struct Fake {
    before: String,
    after: String,
    calls: RefCell<Vec<String>>,
}

impl Runner for Fake {
    fn run(&self, argv: &[&str]) -> (i32, String) {
        self.calls.borrow_mut().push(argv[0].to_string());
        if argv[0] == "read-screen" {
            let n = self.calls.borrow().iter().filter(|c| *c == "read-screen").count();
            return (0, if n == 1 { self.before.clone() } else { self.after.clone() });
        }
        (0, "OK".into())
    }
}

const PROMPT: &str = "  1. a\n❯ 2. b\n  3. c\n";

fn fake(after: &str, before: &str) -> Fake {
    Fake { before: before.into(), after: after.into(), calls: RefCell::new(Vec::new()) }
}

pub fn run() -> i32 {
    let mut t = T { ok: 0, bad: 0 };
    let plans = plans_dir();

    let review = glob(&plans, ".review.html");
    let working = glob(&plans, ".working.html");
    if review.is_empty() {
        println!("  --   no plans on this machine; route checks skipped");
    } else {
        let slug = name_of(&review[0]).trim_end_matches(".review.html").to_string();
        t.check("a bare slug resolves to a page", plan_asset(&slug).is_some(), "");
        t.check("<slug>.review.html resolves — the way back to the review of record",
                plan_asset(&format!("{slug}.review.html")) == Some(realpath(&plans.join(format!("{slug}.review.html")))), "");
        if plans.join(format!("{slug}.md")).exists() {
            t.check("<slug>.md resolves", plan_asset(&format!("{slug}.md")).is_some(), "");
        }
        let sub = std::fs::read_dir(&plans).into_iter().flatten().flatten()
            .map(|e| e.path()).filter(|p| name_of(p).ends_with(".cutover") && p.is_dir())
            .flat_map(|d| glob(&d, ".epic.html")).next();
        if let Some(s) = sub {
            let rel = s.strip_prefix(&plans).unwrap_or(&s).to_string_lossy().into_owned();
            t.check("a link into a .cutover subdirectory resolves", plan_asset(&rel).is_some(), "");
        }
    }
    for probe in ["../deep-plan/keys/x.key.json", "../../.ssh/id_rsa", "%2e%2e%2fetc%2fpasswd", "/etc/passwd",
                  "a.cutover/../../deep-plan/keys/x.key.json"] {
        t.check(&format!("refused: {probe}"), plan_asset(probe).is_none(), "");
    }
    if let Some(j) = glob(&plans, ".json").first() {
        t.check("refused: a .json artifact in the plans directory", plan_asset(&name_of(j)).is_none(), "");
    }

    let inlined = review.iter().chain(working.iter())
        .find(|f| std::fs::read(f).map(|b| has_inlined_mermaid(&String::from_utf8_lossy(&b))).unwrap_or(false));
    if inlined.is_some() {
        t.check("the mermaid swap still matches a real page", true, "");
    } else {
        println!("  --   no inlined page found; swap check skipped");
    }

    let tracked = glob(&dp_state(), ".json").into_iter()
        .filter(|f| !name_of(f).ends_with(".pre-repair.json"))
        .map(|f| name_of(&f).trim_end_matches(".json").to_string())
        .find(|s| plan_root(s).is_some());
    match tracked {
        Some(sl) => {
            for (probe, why) in [("../../../etc/passwd", "traversal"), ("/etc/passwd", "absolute"),
                                 ("a/../../../../etc/passwd", "traversal through a subdir")] {
                let (ok, detail) = open_file(&sl, probe);
                t.check(&format!("/open refuses {why}"), !ok, &detail);
            }
            let missing = format!("does/not/exist-{}.rb", token_hex(4));
            let (ok, detail) = open_file(&sl, &missing);
            t.check("/open refuses missing file", !ok, &detail);
            t.check("/open refuses an unknown plan", !open_file("no-such-plan-xyz", "a.rb").0, "");
        }
        None => println!("  --   no tracked plan with a root; /open checks skipped"),
    }

    match std::fs::read_to_string(crew_file("board/usage.tmpl.html")) {
        Ok(tmpl) => {
            t.check("the usage template has its data placeholder", tmpl.contains(USAGE_SLOT), "");
            t.check("...and a table twin for the chart", tmpl.contains(r#"id="tbl""#), "");
            // The synced palette block names every hue, the board's gold and
            // red included; what the page itself paints with is what follows it.
            let own = without_palette(&tmpl);
            t.check("...and does not reuse a board status colour for the series",
                    (own.contains("#e69875") || own.contains("--data:var(--ef-orange)"))
                        && !["#dfa000", "#e67e80", "var(--ef-red)", "var(--ef-bad)", "var(--ef-yellow)", "var(--ef-warn)"]
                            .iter().any(|c| own.contains(c)),
                    "gold and red are 'needs you' and 'broken' on the board");
            t.check("...and the window card offers both views", tmpl.contains(r#"id="vtoggle""#) && tmpl.contains(r#"id="blockbody""#), "");
            t.check("...and remembers which one, across the 60s reload",
                    tmpl.contains("crew.usage.blockView") && tmpl.contains("localStorage"), "");
            t.check("...and counts down from the block's end time, not a served number",
                    tmpl.contains("endTime") && tmpl.contains("leftMin"), "a snapshot's remainingMinutes is stale the moment it is written");
            t.check("...and reads its window length from the data, not a hardcoded 5h",
                    tmpl.contains("windowMinutes") && tmpl.contains("winLabel"), "ccusage blocks --session-length is a real option");
            t.check("...and leads with the month on usage-based billing",
                    tmpl.contains(r#"D.billing === "usage""#) && tmpl.contains("D.month"), "");
            t.check("...and renders cache re-writes only when facts exist",
                    tmpl.contains("D.cache") && tmpl.contains("cache-facts"), "");
            t.check("...and marks a dollar figure ccusage could not fully price",
                    tmpl.contains("plus(") && tmpl.contains("unpricedNote(") && tmpl.contains(".unpriced"),
                    "usage_data() hands each figure an `unpriced` list");
            t.check("...and carries one unit per mode, not tokens beside dollars",
                    tmpl.contains("var money = ") && tmpl.contains("fmtVal"),
                    "daily bars, the axis, the table twin and the tooltip all follow it");
        }
        Err(e) => t.check("the usage template is readable", false, &e.to_string()),
    }

    // Billing mode survives a respawn: read from a file, not only the environment.
    let saved: Vec<(&str, Option<std::ffi::OsString>)> =
        ["CREW_LOCAL", "CREW_BILLING"].iter().map(|k| (*k, std::env::var_os(k))).collect();
    let tmpcfg = std::env::temp_dir().join(format!("crew-local-selftest-{}", token_hex(3)));
    let _ = std::fs::create_dir_all(&tmpcfg);
    let _ = std::fs::write(tmpcfg.join("config.json"), json!({"billing": "selftest-mode"}).to_string());
    std::env::set_var("CREW_LOCAL", &tmpcfg);
    std::env::remove_var("CREW_BILLING");
    t.check("billing mode is read from a file, not just the environment", billing_mode() == "selftest-mode",
            "an inherited env var reverts on the next respawn");
    let _ = std::fs::remove_dir_all(&tmpcfg);
    for (k, v) in saved {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
    let cfgdir = crew_core::py::env_or("CREW_LOCAL").map(PathBuf::from)
        .unwrap_or_else(|| crew_core::py::home().join(".config").join("cmux").join("crew-local"));
    let cfgp = cfgdir.join("config.json");
    if cfgp.exists() {
        match std::fs::read_to_string(&cfgp).map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
        {
            Ok(_) => t.check("...and this machine's crew-local/config.json parses", true, ""),
            Err(e) => t.check("crew-local/config.json is readable JSON", false, &e),
        }
    } else {
        t.check("...and no config.json here, so the default applies", true, "");
    }

    // A restart reuses the persisted token (a tight file) and replaces a loose one.
    let (reused, replaced) = in_temp_home(|home| {
        use std::os::unix::fs::PermissionsExt;
        let dir = home.join(".cache").join("cmux-crew");
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("board-intent.token");
        let _ = std::fs::write(&f, "kept-token\n");
        let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600));
        let a = crate::server::selftest_token() == "kept-token";
        let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644));
        let b = crate::server::selftest_token() != "kept-token";
        (a, b)
    });
    t.check("a restart reuses the persisted token", reused && replaced,
            "crew apply restarts this server; a fresh token 403s every chip");
    // The port: the pin is taken when it is free.
    let saved_pin = std::env::var_os("CREW_INTENT_PORT");
    let pin = std::net::TcpListener::bind(("127.0.0.1", 0)).ok().and_then(|l| l.local_addr().ok()).map(|a| a.port()).unwrap_or(0);
    std::env::set_var("CREW_INTENT_PORT", pin.to_string());
    let got = in_temp_home(|_| crate::server::selftest_bind_port());
    t.check("...and the port, via the pin", got == Some(pin), "a moved port orphans the URLs already in the pushed page");
    match saved_pin {
        Some(v) => std::env::set_var("CREW_INTENT_PORT", v),
        None => std::env::remove_var("CREW_INTENT_PORT"),
    }
    t.check("ccusage is installed", crate::act::which("ccusage").is_some(), "npm i -g ccusage — the status line and /usage both need it");

    // Asks: containment, then delivery through a fake terminal.
    in_temp_home(|_| {
        let asks = ask::asks_dir();
        let _ = std::fs::create_dir_all(&asks);
        let aid = "20260917-120000-abcd";
        let write = |label_b: &str, surface: &str| {
            let a = json!({"id": aid, "options": [{"label": "a"}, {"label": label_b}, {"label": "c"}],
                           "surface": surface, "answer": null});
            let _ = std::fs::write(asks.join(format!("{aid}.json")), a.to_string());
        };
        write("b", "SURF-1");
        let _ = std::fs::write(asks.join(format!("{aid}.html")), "<html><body>x</body></html>");
        t.check("an ask id resolves to its page", ask::ask_path(aid, ".html").is_some(), "");
        for probe in ["../x", "%2e%2e", "/etc/passwd", "a/../../b"] {
            t.check(&format!("ask refused: {probe}"), ask::ask_path(probe, ".html").is_none(), "");
        }
        let nobody = fake("", "");
        t.check("answer refuses an option out of range", !ask::answer(aid, "4", &nobody).0, "");
        t.check("answer refuses a non-number", !ask::answer(aid, "x", &nobody).0, "");

        let f = fake("  What should it do? → b\n❯ \n", PROMPT);
        let (ok, delivered, detail) = ask::answer(aid, "2", &f);
        t.check("resolved line proves delivery: look, send, read-screen, no Enter",
                ok && delivered && *f.calls.borrow() == ["read-screen", "send", "read-screen"], &detail);
        let rec: serde_json::Value = std::fs::read_to_string(asks.join(format!("{aid}.json"))).ok()
            .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        t.check("the answer is recorded as delivered", rec["answer"]["delivered"] == true, "");
        t.check("a second answer is refused", !ask::answer(aid, "1", &f).0, "");

        // Two submits at once: one keystroke, not two.
        write("b", "SURF-1");
        let f = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        struct Slow(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
        impl Runner for Slow {
            fn run(&self, argv: &[&str]) -> (i32, String) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let mut c = self.0.lock().unwrap();
                c.push(argv[0].into());
                if argv[0] == "read-screen" {
                    let n = c.iter().filter(|x| *x == "read-screen").count();
                    return (0, if n % 2 == 1 { PROMPT.into() } else { "  What should it do? → b\n❯ \n".into() });
                }
                (0, "OK".into())
            }
        }
        let both: Vec<_> = (0..2).map(|_| {
            let r = Slow(f.clone());
            std::thread::spawn(move || ask::answer(aid, "2", &r))
        }).collect();
        for h in both {
            let _ = h.join();
        }
        let sends = f.lock().unwrap().iter().filter(|c| *c == "send").count();
        t.check("a double submit types the option once", sends == 1, &f.lock().unwrap().join(" "));

        write("b", "SURF-1");
        let f = fake("  1. a\n❯ 2. b\n  3. c\n", PROMPT);
        let (ok, delivered, detail) = ask::answer(aid, "2", &f);
        t.check("pointer moved but unresolved: Enter is sent",
                ok && delivered && *f.calls.borrow() == ["read-screen", "send", "read-screen", "send-key"], &detail);

        write("b", "SURF-1");
        let f = fake("  1. a\n  2. b\n❯ 3. c\n", PROMPT);
        let (ok, delivered, detail) = ask::answer(aid, "2", &f);
        // It looks again after typing, a few times, before giving up.
        let mut want = vec!["read-screen", "send"];
        want.extend(std::iter::repeat_n("read-screen", ask::CONFIRM_TRIES as usize + 1));
        t.check("unconfirmed: recorded, no Enter sent, the human is told",
                ok && !delivered && *f.calls.borrow() == want && detail.contains("check the terminal"), &detail);

        write("b", "SURF-1");
        let f = fake("", "  1. red\n❯ 2. green\n");
        let (ok, delivered, detail) = ask::answer(aid, "2", &f);
        t.check("option not on screen: nothing typed, the human is told to switch",
                ok && !delivered && *f.calls.borrow() == ["read-screen"] && detail.contains("not showing this question"), &detail);

        write("a much longer label that wraps", "SURF-1");
        let f = fake("  ? → a much longer label that wraps\n", "  1. a\n❯ 2. a much longer label\n     that wraps\n  3. c\n");
        let (ok, delivered, detail) = ask::answer(aid, "2", &f);
        t.check("a wrapped label is still found on screen", ok && delivered, &detail);

        write("b", "");
        let f = fake("", PROMPT);
        let (ok, delivered, detail) = ask::answer(aid, "2", &f);
        t.check("no recorded surface: nothing typed, recorded as shown", ok && !delivered && f.calls.borrow().is_empty(), &detail);
    });

    let color = if t.bad > 0 { "\x1b[31m" } else { "\x1b[32m" };
    println!("\n{color} intent selftest: {} passed, {} failed\x1b[0m", t.ok, t.bad);
    i32::from(t.bad > 0)
}

/// A page with its synced Everforest block (tools/theme_sync.py) cut out.
fn without_palette(page: &str) -> String {
    const START: &str = "/* everforest:start */";
    const END: &str = "/* everforest:end */";
    match (page.find(START), page.find(END)) {
        (Some(a), Some(b)) if b > a => format!("{}{}", &page[..a], &page[b + END.len()..]),
        _ => page.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::without_palette;

    #[test]
    fn the_palette_block_is_cut_and_the_page_kept() {
        let page = "a{color:#e69875}\n/* everforest:start */\n:root{--ef-red:#e67e80}\n/* everforest:end */\nb{x:1}";
        let own = without_palette(page);
        assert!(!own.contains("#e67e80"));
        assert!(own.contains("#e69875") && own.contains("b{x:1}"));
        assert_eq!(without_palette("no block"), "no block");
    }

    #[test]
    fn the_shipped_usage_template_paints_its_series_orange_only() {
        let t = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../crew/board/usage.tmpl.html")).unwrap();
        let own = without_palette(&t);
        assert!(own.contains("--data:var(--ef-orange)"));
        assert!(!["#dfa000", "#e67e80", "var(--ef-red)", "var(--ef-yellow)"].iter().any(|c| own.contains(c)));
    }
}
