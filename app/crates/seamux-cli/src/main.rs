//! `seamux <tool> [args...]`: run a ported crew tool.
//!
//!   seamux --tools      the registered tool names, one per line
//!   seamux --version    the version
//!
//! An unknown tool exits 127, as a shell does for a missing command, so a
//! caller can tell "not ported" from "the tool failed".

mod cmux_tool;
mod registry;

const USAGE: &str = "usage: seamux <tool> [args...]   (seamux --tools lists them)\n";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(&args));
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
}
