//! `seamux cmux`: check the cmux connection from any process.
//!
//!   seamux cmux transport        how this process reaches cmux
//!   seamux cmux ping             exit 0 when cmux answers
//!   seamux cmux mode             the socket's access mode (automation, cmuxOnly, ...)
//!   seamux cmux capabilities     system.capabilities as JSON
//!   seamux cmux workspaces       one line per workspace: ref, then title
//!
//! Run from launchd (`launchctl submit`) it proves automation mode admits a
//! process outside cmux's own tree.

use cmux::{Cmux, Transport};

pub const TOOLS: &[crate::registry::Tool] = &[("cmux", main)];

const USAGE: &str = "usage: seamux cmux <transport|ping|mode|capabilities|workspaces>\n";

fn main(args: &[String]) -> i32 {
    let Some(cmd) = args.first().map(String::as_str) else {
        eprint!("{USAGE}");
        return 2;
    };
    if cmd == "transport" {
        return match Transport::from_env() {
            Ok(Transport::Socket(p)) => {
                println!("socket {}", p.display());
                0
            }
            Ok(Transport::Cli(p)) => {
                println!("cli {}", p.display());
                0
            }
            Err(e) => {
                eprintln!("seamux cmux: {e}");
                1
            }
        };
    }
    let c = match Cmux::connect() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("seamux cmux: {e}");
            return 1;
        }
    };
    let res = match cmd {
        "ping" => c.ping().map(|_| println!("ok")),
        "mode" => {
            println!("{}", c.access_mode().unwrap_or_else(|| "(cli transport)".into()));
            Ok(())
        }
        "capabilities" => {
            println!("{}", serde_json::to_string_pretty(c.capabilities()).unwrap_or_default());
            Ok(())
        }
        "workspaces" => c.workspace_list(None).map(|v| {
            for w in v.get("workspaces").and_then(|a| a.as_array()).into_iter().flatten() {
                let r = w.get("ref").and_then(|x| x.as_str()).unwrap_or("?");
                let t = w.get("title").and_then(|x| x.as_str()).unwrap_or("");
                println!("{r}\t{t}");
            }
        }),
        _ => {
            eprint!("{USAGE}");
            return 2;
        }
    };
    match res {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("seamux cmux: {e}");
            1
        }
    }
}
