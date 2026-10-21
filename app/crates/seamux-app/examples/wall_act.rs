//! Run the wall's reply or jump against live cmux, as the page's buttons do.
//!
//!     cargo run -p seamux-app --example wall_act -- reply <surface-uuid> <text>
//!     cargo run -p seamux-app --example wall_act -- jump <surface-uuid>

use std::sync::Arc;
use std::time::Duration;

use seamux_app::wall::{Source, Wall};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let src: Arc<dyn Source> = Arc::new(cmux::Cmux::connect().expect("cmux"));
    let wall = Wall::new(vec![src], Duration::from_secs(1));
    let r = match args.first().map(String::as_str) {
        Some("reply") => wall.reply(&args[1], &args[2..].join(" ")),
        Some("jump") => wall.jump(&args[1]),
        _ => Err("usage: wall_act reply|jump <surface-uuid> [text]".into()),
    };
    match r {
        Ok(()) => println!("ok"),
        Err(e) => {
            println!("error: {e}");
            std::process::exit(1);
        }
    }
}
