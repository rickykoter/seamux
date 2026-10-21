//! The little pieces of Python's behaviour the ported modules lean on, so a
//! Rust tool prints and parses what the Python did: `%g`, `str.splitlines`,
//! `time.time()`, `date.today()`, `datetime.fromisoformat(...).timestamp()`,
//! `os.path.getmtime`, and the atomic `tmp.<pid>` + rename writes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// `"%g" % v`: six significant digits, trailing zeros dropped, exponent form
/// below 1e-4 or from 1e6, with at least two exponent digits.
pub fn percent_g(v: f64) -> String {
    if v == 0.0 {
        return if v.is_sign_negative() { "-0".into() } else { "0".into() };
    }
    if !v.is_finite() {
        return if v.is_nan() { "nan".into() } else if v > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let e = format!("{:.5e}", v);
    let (mant, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if (-4..6).contains(&exp) {
        let decimals = (5 - exp).max(0) as usize;
        strip_zeros(format!("{:.*}", decimals, v))
    } else {
        let m = strip_zeros(mant.to_string());
        format!("{}e{}{:02}", m, if exp < 0 { '-' } else { '+' }, exp.abs())
    }
}

fn strip_zeros(s: String) -> String {
    if !s.contains('.') {
        return s;
    }
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// `str.splitlines()`: every Unicode line boundary Python knows, `\r\n` as one.
pub fn splitlines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let boundary = matches!(
            c,
            '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}'
        );
        if boundary {
            out.push(&s[start..i]);
            let mut next = i + c.len_utf8();
            if c == '\r' {
                if let Some(&(j, '\n')) = it.peek() {
                    it.next();
                    next = j + 1;
                }
            }
            start = next;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// `time.time()`.
pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// `os.path.getmtime(p)` as Python computes it: seconds + nanoseconds * 1e-9.
pub fn mtime(meta: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime() as f64 + meta.mtime_nsec() as f64 * 1e-9
}

/// The local calendar date `days_back` days before today, as `date.today()
/// - timedelta(days=days_back)` gives it. Returns (y, m, d).
pub fn local_date(days_back: i64) -> (i64, u32, u32) {
    let t = now() as libc::time_t;
    // SAFETY: localtime_r writes only into tm, which we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    let days = days_from_civil(tm.tm_year as i64 + 1900, tm.tm_mon as u32 + 1, tm.tm_mday as u32) - days_back;
    civil_from_days(days)
}

/// `date.isoformat()` of local_date.
pub fn local_date_iso(days_back: i64) -> String {
    let (y, m, d) = local_date(days_back);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()`, or None
/// where Python raises. Handles the forms transcripts carry: a date, an
/// optional `T` or space time with optional seconds and fraction, and an
/// optional `Z` or `±HH:MM` offset. A naive time is local, as in Python.
pub fn iso_timestamp(s: &str) -> Option<f64> {
    let s = s.replace('Z', "+00:00");
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = s.get(r)?;
        if t.is_empty() || !t.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        t.parse().ok()
    };
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)? as u32, num(8..10)? as u32);
    if !(1..=12).contains(&mo) || d == 0 || d > days_in_month(y, mo) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut micros) = (0i64, 0i64, 0i64, 0i64);
    let mut offset: Option<i64> = None;
    let mut i = 10;
    if i < b.len() {
        if b[i] != b'T' && b[i] != b' ' {
            return None;
        }
        i += 1;
        h = num(i..i + 2)?;
        i += 2;
        if b.get(i) != Some(&b':') {
            return None;
        }
        mi = num(i + 1..i + 3)?;
        i += 3;
        if b.get(i) == Some(&b':') {
            sec = num(i + 1..i + 3)?;
            i += 3;
            if b.get(i) == Some(&b'.') || b.get(i) == Some(&b',') {
                let start = i + 1;
                let mut end = start;
                while end < b.len() && b[end].is_ascii_digit() {
                    end += 1;
                }
                if end == start {
                    return None;
                }
                let frac = &s[start..end];
                let six: String = frac.chars().chain(std::iter::repeat('0')).take(6).collect();
                micros = six.parse().ok()?;
                i = end;
            }
        }
        if i < b.len() {
            let sign = match b[i] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let oh = num(i + 1..i + 3)?;
            if b.get(i + 3) != Some(&b':') {
                return None;
            }
            let om = num(i + 4..i + 6)?;
            if i + 6 != b.len() {
                return None;
            }
            offset = Some(sign * (oh * 3600 + om * 60));
        }
        if h > 23 || mi > 59 || sec > 59 {
            return None;
        }
    }
    let days = days_from_civil(y, mo, d);
    let wall = days * 86400 + h * 3600 + mi * 60 + sec;
    let secs = match offset {
        Some(off) => wall - off,
        None => local_to_epoch(y, mo, d, h, mi, sec)?,
    };
    Some((secs * 1_000_000 + micros) as f64 / 1e6)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

fn local_to_epoch(y: i64, mo: u32, d: u32, h: i64, mi: i64, s: i64) -> Option<i64> {
    // SAFETY: mktime reads and normalizes tm, which we own.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = (y - 1900) as i32;
    tm.tm_mon = mo as i32 - 1;
    tm.tm_mday = d as i32;
    tm.tm_hour = h as i32;
    tm.tm_min = mi as i32;
    tm.tm_sec = s as i32;
    tm.tm_isdst = -1;
    let t = unsafe { libc::mktime(&mut tm) };
    (t != -1).then_some(t as i64)
}

/// Python's `"%s.tmp.%d" % (path, os.getpid())` then `os.replace`: two
/// writers never share a temp file, and a reader never sees half a file.
pub fn write_atomic(path: &Path, body: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = PathBuf::from(format!("{}.tmp.{}", path.display(), std::process::id()));
    let res = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(body)?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

/// An exclusive flock on `path` (created if missing), held until dropped:
/// Python's `fcntl.flock(open(path, "a"), LOCK_EX)`.
pub struct Flock(#[allow(dead_code)] fs::File); // held for the lock, released on drop

impl Flock {
    pub fn exclusive(path: &Path) -> std::io::Result<Flock> {
        use std::os::unix::io::AsRawFd;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let f = fs::OpenOptions::new().append(true).create(true).open(path)?;
        // SAFETY: flock on a descriptor we own; the kernel releases it on close.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Flock(f))
    }
}

/// `os.path.expanduser("~")`: HOME, else the passwd entry's home directory
/// (a launchd job or a scrubbed hook environment may carry no HOME).
pub fn home() -> PathBuf {
    if let Some(h) = std::env::var_os("HOME") {
        return PathBuf::from(h);
    }
    passwd_home().unwrap_or_else(|| PathBuf::from("~"))
}

fn passwd_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: getpwuid_r fills pwd from buf, both owned here; dir is read
    // before either goes out of scope.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut out);
        if rc != 0 || out.is_null() || pwd.pw_dir.is_null() {
            return None;
        }
        let dir = CStr::from_ptr(pwd.pw_dir).to_bytes();
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(dir)))
    }
}

/// Python's `os.environ.get(name) or default` (an empty value counts as unset).
pub fn env_or(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// An OSError as Python prints `"%s: %s" % (exc.__class__.__name__, exc)`:
/// `PermissionError: [Errno 13] Permission denied: '/path'`.
pub fn os_error(e: &std::io::Error, path: &Path) -> String {
    let Some(errno) = e.raw_os_error() else { return format!("OSError: {e}") };
    let class = match errno {
        libc::EACCES | libc::EPERM => "PermissionError",
        libc::ENOENT => "FileNotFoundError",
        libc::EISDIR => "IsADirectoryError",
        libc::ENOTDIR => "NotADirectoryError",
        libc::EEXIST => "FileExistsError",
        _ => "OSError",
    };
    // SAFETY: strerror returns a static string for any errno.
    let msg = unsafe { std::ffi::CStr::from_ptr(libc::strerror(errno)) }.to_string_lossy().into_owned();
    format!("{class}: [Errno {errno}] {msg}: '{}'", path.display())
}

/// `os.path.expanduser(p)` for `~` and `~/...`.
pub fn expand_user(p: &str) -> PathBuf {
    if p == "~" {
        return home();
    }
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(p),
    }
}

/// `subprocess.run(argv, capture_output=True, text=True, timeout=t)`:
/// Some((returncode, stdout, stderr)), or None where Python would raise
/// (cannot start, or the timeout passed, after which the child is killed).
pub fn run(program: &str, args: &[&str], timeout: std::time::Duration) -> Option<(i32, String, String)> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        if let Ok(Some(st)) = child.try_wait() {
            break st;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    let o = String::from_utf8_lossy(&ro.join().ok()?).into_owned();
    let e = String::from_utf8_lossy(&re.join().ok()?).into_owned();
    Some((status.code().unwrap_or(-1), o, e))
}

/// Read a file's bytes from `max(0, size - tail)` to the end, decoded the way
/// Python's `.decode("utf-8", "replace")` does.
pub fn read_tail(path: &Path, tail: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path)?;
    let size = f.seek(SeekFrom::End(0))?;
    f.seek(SeekFrom::Start(size.saturating_sub(tail)))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_g_matches_python() {
        // python3 -c 'print(["%g" % v for v in (...)])'
        let cases = [
            (3e-06, "3e-06"), (1.5e-05, "1.5e-05"), (0.0001, "0.0001"), (123456.0, "123456"),
            (1234567.0, "1.23457e+06"), (5.0, "5"), (0.25, "0.25"), (9.0, "9"), (3.3e-06, "3.3e-06"),
        ];
        for (v, want) in cases {
            assert_eq!(percent_g(v), want, "{v}");
        }
    }

    #[test]
    fn splitlines_like_python() {
        assert_eq!(splitlines("a\nb\r\nc\rd\u{2028}e\n"), vec!["a", "b", "c", "d", "e"]);
        assert_eq!(splitlines(""), Vec::<&str>::new());
        assert_eq!(splitlines("x\n\ny"), vec!["x", "", "y"]);
    }

    #[test]
    fn iso_timestamps() {
        // datetime.fromisoformat("2026-10-21T11:09:25.723+00:00").timestamp()
        assert_eq!(iso_timestamp("2026-10-21T11:09:25.723Z"), Some(1792580965.723));
        assert_eq!(iso_timestamp("2026-10-21T11:09:25+02:00"), Some(1792573765.0));
        assert_eq!(iso_timestamp("t0"), None);
        assert_eq!(iso_timestamp("2026-02-30T00:00:00Z"), None);
    }

    #[test]
    fn os_errors_print_like_python() {
        // python3 -c "open('/nope/x')" -> FileNotFoundError: [Errno 2] No such file or directory: '/nope/x'
        let e = std::fs::read("/nope/x").unwrap_err();
        assert_eq!(os_error(&e, Path::new("/nope/x")), "FileNotFoundError: [Errno 2] No such file or directory: '/nope/x'");
        let e = std::fs::read("/").unwrap_err();
        assert_eq!(os_error(&e, Path::new("/")), "IsADirectoryError: [Errno 21] Is a directory: '/'");
    }

    #[test]
    fn civil_round_trip() {
        for d in [-1000, 0, 1, 365, 20000, 20747] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }
}
