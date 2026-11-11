//! A paste into a native pane, read from the Mac pasteboard itself.
//!
//! Claude Code reads an image off the clipboard on Ctrl-V with AppleScript's
//! `«class PNGf»`, which takes whatever PNG is there: for a file copied in
//! Finder that is the file's icon, and an app that offers only TIFF (or a
//! picture the webview offers in its own form) comes back blank. So the pane
//! never leaves it to Claude: files on the pasteboard paste as their paths,
//! and an image is written to a PNG file whose path is pasted. Claude Code
//! takes a pasted path to an image as an attachment, as it does a drop.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

/// What the pasteboard holds, as the pane should paste it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Clip {
    /// Files copied in Finder (or another app that copies files): their paths.
    Files { paths: Vec<String> },
    /// An image with no file behind it, written to `path`.
    Image { path: String },
    /// Text: the pane pastes it as any terminal does.
    Text { text: String },
    Empty,
}

/// Where pasted images are written, and how long they stay.
fn paste_dir() -> PathBuf {
    std::env::temp_dir().join("seamux-paste")
}
const KEEP: Duration = Duration::from_secs(24 * 3600);

/// Images pasted more than a day ago: Claude has long since read them.
fn sweep(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|d| d > KEEP);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// A file:// URL as the local path it names (percent-decoded), else None.
pub fn file_url_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let b = rest.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    let p = String::from_utf8(out).ok()?;
    // A folder's URL ends in a slash; its path does not need one.
    Some(if p.len() > 1 { p.trim_end_matches('/').to_string() } else { p })
}

/// A new file name for a pasted image, unique within the second.
fn image_name(n: u32) -> String {
    let ms = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("pasted-{ms}-{n}.png")
}

/// TIFF bytes as PNG bytes, by sips (every Mac has it).
fn tiff_to_png(tiff: &[u8], dir: &Path) -> Result<Vec<u8>, String> {
    let src = dir.join(format!(".{}.tiff", image_name(0)));
    let dst = src.with_extension("png");
    std::fs::write(&src, tiff).map_err(|e| e.to_string())?;
    let st = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(&src)
        .arg("--out")
        .arg(&dst)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let _ = std::fs::remove_file(&src);
    let out = std::fs::read(&dst).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&dst);
    match st {
        Ok(s) if s.success() => out,
        Ok(s) => Err(format!("sips exited {s}")),
        Err(e) => Err(e.to_string()),
    }
}

/// What the pasteboard holds now, read in the order that is right for a
/// terminal: files first (Finder puts their icon and name on too), then text
/// (a spreadsheet's cells come with a picture of themselves), then an image.
#[cfg(target_os = "macos")]
fn read() -> Result<Clip, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF};

    let pb = NSPasteboard::generalPasteboard();
    let mut paths = Vec::new();
    if let Some(items) = pb.pasteboardItems() {
        for item in items.iter() {
            if let Some(u) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
                if let Some(p) = file_url_path(&u.to_string()) {
                    paths.push(p);
                }
            }
        }
    }
    if !paths.is_empty() {
        return Ok(Clip::Files { paths });
    }
    if let Some(s) = pb.stringForType(unsafe { NSPasteboardTypeString }) {
        let text = s.to_string();
        if !text.is_empty() {
            return Ok(Clip::Text { text });
        }
    }
    let png = pb.dataForType(unsafe { NSPasteboardTypePNG }).map(|d| d.to_vec());
    let tiff = if png.is_none() { pb.dataForType(unsafe { NSPasteboardTypeTIFF }).map(|d| d.to_vec()) } else { None };
    if png.is_none() && tiff.is_none() {
        return Ok(Clip::Empty);
    }
    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    sweep(&dir);
    let bytes = match (png, tiff) {
        (Some(p), _) => p,
        (None, Some(t)) => tiff_to_png(&t, &dir)?,
        (None, None) => unreachable!(),
    };
    if bytes.is_empty() {
        return Ok(Clip::Empty);
    }
    let path = dir.join(image_name(1));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(Clip::Image { path: path.to_string_lossy().into_owned() })
}

#[cfg(not(target_os = "macos"))]
fn read() -> Result<Clip, String> {
    Ok(Clip::Empty)
}

/// The pasteboard, as a native pane should paste it (see Clip).
#[tauri::command]
pub async fn clip_read() -> Result<Clip, String> {
    // AppKit's pasteboard is safe off the main thread for reading.
    tauri::async_runtime::spawn_blocking(read).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_url_is_its_decoded_path() {
        assert_eq!(file_url_path("file:///Users/me/My%20Shot.png").as_deref(), Some("/Users/me/My Shot.png"));
        assert_eq!(file_url_path("file://localhost/tmp/a").as_deref(), Some("/tmp/a"));
        assert_eq!(file_url_path("file:///Users/me/dir/").as_deref(), Some("/Users/me/dir"));
        assert_eq!(file_url_path("file:///").as_deref(), Some("/"));
        assert_eq!(file_url_path("file:///caf%C3%A9.txt").as_deref(), Some("/café.txt"));
        assert_eq!(file_url_path("https://example.com/a"), None);
        assert_eq!(file_url_path("file://host/a"), None);
    }

    #[test]
    fn a_stray_percent_stays() {
        assert_eq!(file_url_path("file:///a%zz").as_deref(), Some("/a%zz"));
        assert_eq!(file_url_path("file:///a%2").as_deref(), Some("/a%2"));
    }

    #[test]
    fn old_pastes_are_swept() {
        let d = std::env::temp_dir().join(format!("seamux-clip-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("x.png");
        std::fs::write(&f, b"x").unwrap();
        sweep(&d);
        assert!(f.exists(), "a fresh paste stays");
        let _ = std::fs::remove_dir_all(&d);
    }
}
