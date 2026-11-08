//! Print the font a Ghostty or cmux config names, as the native terminal gets it: `term_look`.
fn main() {
    println!("{}", serde_json::to_string_pretty(&seamux_app::ghostty::look()).unwrap());
}
