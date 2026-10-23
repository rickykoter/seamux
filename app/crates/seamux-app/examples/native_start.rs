//! Start Claude as a native session, as the sheet's buttons do:
//!
//!     cargo run -p seamux-app --example native_start -- <workspace-uuid> <cwd> [resume-session-id]
//!
//! Prints the new cmux pane's surface id.

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 2 {
        eprintln!("usage: native_start <workspace-uuid> <cwd> [resume-session-id]");
        std::process::exit(2);
    }
    match seamux_app::pty::start_native(&a[0], &a[1], a.get(2).map(String::as_str)) {
        Ok(surface) => println!("{surface}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
