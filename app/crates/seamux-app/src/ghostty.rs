//! cmux's terminal look, from its Ghostty config: the theme it names (one
//! for light and one for dark, or one for both), that theme's palette and
//! colors, and any colors or font the config sets itself. The native
//! terminal draws with it, so a pane looks the same here as in cmux.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// What the native terminal takes: colors as `#rrggbb`, palette 0-15.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub palette: BTreeMap<u8, String>,
    pub background: Option<String>,
    pub foreground: Option<String>,
    pub cursor: Option<String>,
    pub cursor_text: Option<String>,
    pub selection_background: Option<String>,
    pub selection_foreground: Option<String>,
    pub font_family: Option<String>,
    pub font_size: Option<f32>,
}

fn color(v: &str) -> Option<String> {
    let v = v.trim().trim_start_matches('#');
    (v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", v.to_ascii_lowercase()))
}

/// Lay `text`'s `key = value` lines over `look` (later lines win). Returns
/// the theme it names, if any.
pub fn apply(look: &mut Look, text: &str) -> Option<String> {
    let mut theme = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let (k, v) = (k.trim(), v.trim().trim_matches('"'));
        match k {
            "theme" => theme = Some(v.to_string()),
            "palette" => {
                if let Some((n, c)) = v.split_once('=') {
                    if let (Ok(n), Some(c)) = (n.trim().parse::<u8>(), color(c)) {
                        if n < 16 {
                            look.palette.insert(n, c);
                        }
                    }
                }
            }
            "background" => look.background = color(v).or(look.background.take()),
            "foreground" => look.foreground = color(v).or(look.foreground.take()),
            "cursor-color" => look.cursor = color(v).or(look.cursor.take()),
            "cursor-text" => look.cursor_text = color(v).or(look.cursor_text.take()),
            "selection-background" => look.selection_background = color(v).or(look.selection_background.take()),
            "selection-foreground" => look.selection_foreground = color(v).or(look.selection_foreground.take()),
            // Ghostty repeats font-family for fallbacks: the first is the face.
            "font-family" if look.font_family.is_none() && !v.is_empty() => look.font_family = Some(v.to_string()),
            "font-size" => look.font_size = v.parse().ok().filter(|s: &f32| (6.0..=40.0).contains(s)).or(look.font_size),
            _ => {}
        }
    }
    theme
}

/// The theme for this appearance: `light:A,dark:B` names one per mode.
pub fn pick(theme: &str, dark: bool) -> Option<String> {
    let mut plain = None;
    for part in theme.split(',') {
        let part = part.trim();
        match part.split_once(':') {
            Some(("light", n)) if !dark => return Some(n.trim().to_string()),
            Some(("dark", n)) if dark => return Some(n.trim().to_string()),
            Some(("light" | "dark", _)) => {}
            _ if !part.is_empty() => plain = Some(part.to_string()),
            _ => {}
        }
    }
    plain
}

/// A theme name is a file name, nothing more.
fn name_ok(n: &str) -> bool {
    !n.is_empty() && !n.contains('/') && !n.starts_with('.') && !n.chars().any(char::is_control)
}

/// cmux's app bundle: the one its CLI is in, else the newest in /Applications.
fn bundle() -> Option<PathBuf> {
    let cli = cmux::resolve_cli_bin().ok()?;
    let cli = std::fs::canonicalize(&cli).unwrap_or(cli);
    cli.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

/// cmux's look for this appearance: its config, the theme the config names,
/// then the config again (its own colors win over the theme's).
pub fn look(dark: bool) -> Look {
    let home = crew_core::py::home();
    let bundle = bundle();
    let nightly = bundle.as_ref().is_some_and(|b| b.to_string_lossy().contains("NIGHTLY"));
    let support = home.join("Library/Application Support");
    let mut configs = vec![home.join(".config/ghostty/config")];
    let (mine, other) = ("com.cmuxterm.app.nightly", "com.cmuxterm.app");
    let (first, second) = if nightly { (mine, other) } else { (other, mine) };
    // The running cmux's own config, else the other build's.
    if let Some(c) = [first, second].iter().map(|d| support.join(d).join("config.ghostty")).find(|p| p.is_file()) {
        configs.push(c);
    }
    let text: String = configs.iter().filter_map(|p| std::fs::read_to_string(p).ok()).collect::<Vec<_>>().join("\n");
    let mut probe = Look::default();
    let theme = apply(&mut probe, &text).and_then(|t| pick(&t, dark)).filter(|n| name_ok(n));
    let mut out = Look::default();
    if let Some(n) = theme {
        let mut dirs = vec![home.join(".config/ghostty/themes")];
        if let Some(b) = &bundle {
            dirs.push(b.join("Contents/Resources/ghostty/themes"));
        }
        if let Some(t) = dirs.iter().find_map(|d| std::fs::read_to_string(d.join(&n)).ok()) {
            apply(&mut out, &t);
        }
    }
    apply(&mut out, &text);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_theme_is_picked_per_appearance() {
        assert_eq!(pick("light:A B,dark:C", false).as_deref(), Some("A B"));
        assert_eq!(pick("light:A B,dark:C", true).as_deref(), Some("C"));
        assert_eq!(pick("Monokai Pro Machine", true).as_deref(), Some("Monokai Pro Machine"));
        assert_eq!(pick("light:A", true), None);
    }

    #[test]
    fn a_config_lays_its_colors_over_a_theme() {
        let mut l = Look::default();
        apply(&mut l, "palette = 1=#FF6D7E\npalette = 99=#000000\nbackground = #273136\nforeground = 2f2f2f\ncursor-color = nope");
        let theme = apply(&mut l, "# a comment\ntheme = light:X,dark:Y\nbackground = #000000\nfont-family = \"JetBrains Mono\"\nfont-family = Menlo\nfont-size = 13");
        assert_eq!(theme.as_deref(), Some("light:X,dark:Y"));
        assert_eq!(l.palette.get(&1).map(String::as_str), Some("#ff6d7e"));
        assert!(!l.palette.contains_key(&99));
        assert_eq!(l.background.as_deref(), Some("#000000"));
        assert_eq!(l.foreground.as_deref(), Some("#2f2f2f"));
        assert_eq!(l.cursor, None);
        assert_eq!(l.font_family.as_deref(), Some("JetBrains Mono"));
        assert_eq!(l.font_size, Some(13.0));
    }

    #[test]
    fn a_theme_name_cannot_leave_the_themes_folder() {
        assert!(name_ok("Monokai Pro Machine"));
        assert!(!name_ok("../../etc/passwd"));
        assert!(!name_ok(".hidden"));
    }
}
