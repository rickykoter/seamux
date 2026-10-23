//! Print cmux's terminal look as the native terminal gets it: `term_look [dark]`.
fn main() {
    let dark = std::env::args().nth(1).is_some_and(|a| a == "dark");
    println!("{}", serde_json::to_string_pretty(&seamux_app::ghostty::look(dark)).unwrap());
}
