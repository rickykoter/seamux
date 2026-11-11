//! A file a native pane links to, shown in the Dock instead of VS Code when
//! it is something to look at: an image, a PDF, or Markdown (rendered here,
//! shown with scripts off). panelinks.ts decides which links come here.

use base64::Engine;

use crate::wake_app::{show_kind, Shown, SHOW_MAX};

/// Markdown as a whole HTML page, in the app's light and dark colours.
pub fn markdown_page(title: &str, md: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let opts = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_FOOTNOTES;
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(md, opts));
    let title = title.replace('&', "&amp;").replace('<', "&lt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title><style>\
:root{{--bg:#fdf6e3;--fg:#5c6a72;--mute:#939f91;--line:#e6e2cc;--code:#f4f0d9;--link:#3a94c5}}\
@media (prefers-color-scheme:dark){{:root{{--bg:#2d353b;--fg:#d3c6aa;--mute:#859289;--line:#475258;--code:#343f44;--link:#7fbbb3}}}}\
body{{background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,system-ui,sans-serif;max-width:52em;margin:0 auto;padding:20px 24px}}\
h1,h2{{border-bottom:1px solid var(--line);padding-bottom:.3em}}a{{color:var(--link)}}\
code,pre{{font:12.5px ui-monospace,Menlo,monospace;background:var(--code);border-radius:4px}}code{{padding:.1em .3em}}\
pre{{padding:10px 12px;overflow:auto}}pre code{{padding:0;background:none}}\
blockquote{{margin:0;padding-left:1em;border-left:3px solid var(--line);color:var(--mute)}}\
table{{border-collapse:collapse}}td,th{{border:1px solid var(--line);padding:4px 8px}}img{{max-width:100%}}\
</style></head><body>{body}</body></html>"
    )
}

/// How the Dock shows `path`, if it shows it at all: image, pdf or
/// markdown. Anything else stays VS Code's.
pub fn dock_kind(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if matches!(ext.as_str(), "md" | "markdown") {
        return Some("markdown");
    }
    match show_kind(path)? {
        ("image", _) => Some("image"),
        ("pdf", _) => Some("pdf"),
        _ => None,
    }
}

/// The file at `path` (absolute, found by pty_paths), for the Dock.
#[tauri::command]
pub async fn link_file(path: String) -> Result<Shown, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let kind = dock_kind(&path).ok_or("the Dock does not show this kind of file")?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > SHOW_MAX {
            return Err(format!("{} MB is too big to show here", meta.len() / (1024 * 1024)));
        }
        let title = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        if kind == "markdown" {
            let md = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let page = markdown_page(&title, &md);
            return Ok(Shown { kind: "html", title, data: format!("data:text/html;base64,{}", b64(page.as_bytes())) });
        }
        let (kind, mime) = show_kind(&path).ok_or("not shown")?;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(Shown { kind, title, data: format!("data:{mime};base64,{}", b64(&bytes)) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dock_shows_images_pdfs_and_markdown() {
        assert_eq!(dock_kind("/a/shot.PNG"), Some("image"));
        assert_eq!(dock_kind("/a/spec.pdf"), Some("pdf"));
        assert_eq!(dock_kind("/a/README.md"), Some("markdown"));
        assert_eq!(dock_kind("/a/main.rs"), None);
        assert_eq!(dock_kind("/a/page.html"), None, "HTML source is code to edit");
        assert_eq!(dock_kind("/a/clip.mov"), None);
    }

    #[test]
    fn markdown_renders_with_its_title_escaped() {
        let p = markdown_page("a<b", "# Hi\n\n| x |\n|---|\n| 1 |\n");
        assert!(p.contains("<h1>Hi</h1>"));
        assert!(p.contains("<table>"));
        assert!(p.contains("<title>a&lt;b</title>"));
    }

    #[test]
    fn raw_script_in_markdown_is_left_to_the_sandbox() {
        // pulldown-cmark passes raw HTML through; the Dock frames the page
        // with sandbox="" (no scripts), as sheet.ts does for every HTML file.
        let p = markdown_page("x", "<script>alert(1)</script>");
        assert!(p.contains("<script>"));
    }
}
