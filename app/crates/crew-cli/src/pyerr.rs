//! How the Python's failures read, for the paths a port has to fail on too.

use std::path::Path;

/// Python's `repr(str)` for a path in an error: single quotes unless the
/// path holds one and no double quote.
pub fn repr(s: &str) -> String {
    if s.contains('\'') && !s.contains('"') {
        format!("\"{s}\"")
    } else {
        format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
    }
}

/// `str(OSError)`: `[Errno 2] No such file or directory: '/path'`.
pub fn os_error(e: &std::io::Error, path: &Path) -> String {
    match e.raw_os_error() {
        Some(errno) => {
            // SAFETY: strerror returns a static string for any errno.
            let msg = unsafe { std::ffi::CStr::from_ptr(libc::strerror(errno)) }.to_string_lossy().into_owned();
            format!("[Errno {errno}] {msg}: {}", repr(&path.to_string_lossy()))
        }
        None => e.to_string(),
    }
}

/// `str(UnicodeDecodeError)` for bytes that are not UTF-8.
pub fn decode_error(e: &std::str::Utf8Error, bytes: &[u8]) -> String {
    let at = e.valid_up_to();
    let byte = bytes.get(at).copied().unwrap_or(0);
    let why = if e.error_len().is_none() {
        "unexpected end of data"
    } else if (0x80..0xc2).contains(&byte) || byte >= 0xf5 {
        "invalid start byte"
    } else {
        "invalid continuation byte"
    };
    format!("'utf-8' codec can't decode byte 0x{byte:02x} in position {at}: {why}")
}

/// Where the Python would raise and exit 1 with a traceback: the last line
/// of one, on stderr.
pub fn crash(msg: &str) -> i32 {
    eprintln!("Traceback (most recent call last):\n{msg}");
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_error_reads_like_python() {
        let e = std::io::Error::from_raw_os_error(libc::ENOENT);
        assert_eq!(os_error(&e, Path::new("/no/such")), "[Errno 2] No such file or directory: '/no/such'");
    }

    #[test]
    fn repr_switches_quotes() {
        assert_eq!(repr("it's"), "\"it's\"");
        assert_eq!(repr("plain"), "'plain'");
    }

    #[test]
    fn decode_error_names_the_byte() {
        let b: Vec<u8> = vec![b'a', b'b', 0xff, b'c', b'd'];
        let e = std::str::from_utf8(&b).unwrap_err();
        assert_eq!(decode_error(&e, &b),"'utf-8' codec can't decode byte 0xff in position 2: invalid start byte");
    }
}
