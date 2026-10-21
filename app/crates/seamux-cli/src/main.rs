//! `seamux <tool> [args...]`: run a ported crew tool.
//!
//!   seamux --tools      the registered tool names, one per line
//!   seamux --version    the version
//!
//! An unknown tool exits 127, as a shell does for a missing command, so a
//! caller can tell "not ported" from "the tool failed". Linked under a tool's
//! name, the binary runs that tool: `crew-sync args` is `seamux crew-sync args`.

mod cmux_tool;
mod registry;

const USAGE: &str = "usage: seamux <tool> [args...]   (seamux --tools lists them)\n";

fn main() {
    let mut argv = std::env::args();
    let name = argv.next().unwrap_or_default();
    let args: Vec<String> = argv.collect();
    std::process::exit(run_as(&name, &args));
}

/// Run as the name this binary was started by. Linked as a tool's name
/// (`~/.local/bin/crew-sync -> seamux`, as crew apply links them), it runs that
/// tool, busybox-style, so the commands people type keep working at the cutover.
fn run_as(argv0: &str, args: &[String]) -> i32 {
    let base = std::path::Path::new(argv0).file_name().and_then(|n| n.to_str()).unwrap_or("");
    if base != "seamux" {
        if let Some((_, run)) = registry::find(base) {
            return run(args);
        }
    }
    run(args)
}

fn run(args: &[String]) -> i32 {
    let Some(first) = args.first() else {
        eprint!("{USAGE}");
        return 2;
    };
    match first.as_str() {
        "--tools" => {
            for (name, _) in registry::all() {
                println!("{name}");
            }
            0
        }
        "--version" => {
            println!("seamux {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "-h" | "--help" => {
            print!("{USAGE}");
            0
        }
        name => match registry::find(name) {
            Some((_, run)) => run(&args[1..]),
            None => {
                eprintln!("seamux: no tool named {name:?} (seamux --tools lists them)");
                127
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tool_is_127() {
        assert_eq!(run(&["no-such-tool".to_string()]), 127);
    }

    #[test]
    fn no_args_is_usage() {
        assert_eq!(run(&[]), 2);
    }

    #[test]
    fn linked_as_a_tool_runs_it() {
        // `cmux transport` needs no cmux; linked as "cmux" the binary runs it.
        assert_eq!(run_as("/some/bin/cmux", &["transport".to_string()]), run(&["cmux".to_string(), "transport".to_string()]));
        // An unknown link name falls back to the argument form.
        assert_eq!(run_as("/x/not-a-tool", &[]), 2);
    }
}
