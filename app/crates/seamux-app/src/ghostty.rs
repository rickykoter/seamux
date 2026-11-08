//! The terminal font a Ghostty or cmux config names: the one thing the
//! native terminal takes from it. Its colours are seamux's own (the --term-*
//! tokens in theme/everforest.css), whatever theme the config names.

use std::path::PathBuf;

use serde::Serialize;

/// What the native terminal takes from the config: the font, if it names one.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub font_family: Option<String>,
    pub font_size: Option<f32>,
}

/// Lay `text`'s `key = value` lines over `look` (later lines win).
pub fn apply(look: &mut Look, text: &str) {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim().trim_matches('"'));
        match k {
            // Ghostty repeats font-family for fallbacks: the first is the face.
            "font-family" if look.font_family.is_none() && !v.is_empty() => look.font_family = Some(v.to_string()),
            "font-size" => look.font_size = v.parse().ok().filter(|s: &f32| (6.0..=40.0).contains(s)).or(look.font_size),
            _ => {}
        }
    }
}

/// The configs that can name a font: Ghostty's own, then cmux's (the
/// running build's, else the other's).
fn configs() -> Vec<PathBuf> {
    let home = crew_core::py::home();
    let nightly = cmux::resolve_cli_bin()
        .ok()
        .map(|c| std::fs::canonicalize(&c).unwrap_or(c))
        .is_some_and(|c| c.to_string_lossy().contains("NIGHTLY"));
    let support = home.join("Library/Application Support");
    let (mine, other) = ("com.cmuxterm.app.nightly", "com.cmuxterm.app");
    let (first, second) = if nightly { (mine, other) } else { (other, mine) };
    let mut out = vec![home.join(".config/ghostty/config")];
    if let Some(c) = [first, second].iter().map(|d| support.join(d).join("config.ghostty")).find(|p| p.is_file()) {
        out.push(c);
    }
    out
}

/// The font the configs name.
pub fn look() -> Look {
    let mut out = Look::default();
    for p in configs() {
        if let Ok(text) = std::fs::read_to_string(p) {
            apply(&mut out, &text);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_names_the_font_and_nothing_else_is_kept() {
        let mut l = Look::default();
        apply(&mut l, "theme = light:X,dark:Y\nbackground = #000000\npalette = 1=#ff6d7e");
        assert_eq!(l, Look::default());
        apply(&mut l, "# a comment\nfont-family = \"JetBrains Mono\"\nfont-family = Menlo\nfont-size = 13");
        assert_eq!(l.font_family.as_deref(), Some("JetBrains Mono"));
        assert_eq!(l.font_size, Some(13.0));
        apply(&mut l, "font-size = 99");
        assert_eq!(l.font_size, Some(13.0));
    }
}
