//! The terminal, drawn by hand on crossterm (no widget framework): what
//! crew-resume's curses finder and crew-sweep's one raw key need.

use std::io::{Read, Write};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::style::{Attribute, Color, Print, SetAttribute, SetForegroundColor};
use crossterm::{cursor, execute, queue, terminal};

/// A key as the finder reads it (curses' get_wch, decoded).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Up,
    Down,
    Left,
    Right,
    PageUp,
    PageDown,
    Enter,
    Tab,
    Backspace,
    Esc,
    /// A control letter: Ctrl(b'a') is ^A, delivered as "\x01" by curses.
    Ctrl(u8),
    /// The window changed size: redraw.
    Resize,
    /// ^C, which curses (cbreak) turns into KeyboardInterrupt.
    Interrupt,
}

/// curses' colour pairs as crew-resume sets them: pair i is colour i on the
/// default background.
pub fn pair(i: u8) -> Color {
    match i {
        1 => Color::DarkRed,
        2 => Color::DarkGreen,
        3 => Color::DarkYellow,
        4 => Color::DarkBlue,
        5 => Color::DarkMagenta,
        6 => Color::DarkCyan,
        7 => Color::Grey,
        _ => Color::Reset,
    }
}

/// Python's `str.isprintable()` for one character: no control characters
/// and no space other than the ASCII one (NBSP is not printable).
pub fn printable(c: char) -> bool {
    !c.is_control() && (c == ' ' || !c.is_whitespace()) && !matches!(c, '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{feff}')
}

#[derive(Clone, Copy, Default)]
pub struct Style {
    pub bold: bool,
    pub reverse: bool,
    pub color: Option<u8>,
}

impl Style {
    pub fn bold() -> Style {
        Style { bold: true, ..Style::default() }
    }
    pub fn color(c: u8) -> Style {
        Style { color: Some(c), ..Style::default() }
    }
    pub fn with(mut self, other: Style) -> Style {
        self.bold |= other.bold;
        self.reverse |= other.reverse;
        self.color = other.color.or(self.color);
        self
    }
}

/// Text as curses draws it: a control character shows in caret notation
/// (ESC as ^[, BEL as ^G, DEL as ^?), never reaching the terminal raw, so a
/// title or prompt holding escape codes cannot act on the screen.
pub fn visible(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c as u32 {
            0..=0x1f => {
                out.push('^');
                out.push(char::from_u32(c as u32 + 0x40).unwrap_or('?'));
            }
            0x7f => out.push_str("^?"),
            0x80..=0x9f => {
                out.push('~');
                out.push(char::from_u32(c as u32 - 0x40).unwrap_or('?'));
            }
            _ => out.push(c),
        }
    }
    out
}

/// The terminal settings from before raw mode, for a signal handler that
/// must put them back with only async-signal-safe calls.
static SAVED: std::sync::OnceLock<libc::termios> = std::sync::OnceLock::new();

fn save_termios() {
    // SAFETY: tcgetattr fills a termios we own.
    unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut t) == 0 {
            let _ = SAVED.set(t);
        }
    }
}

/// Only the terminal's mode back (cooked), for a handler that never drew a
/// full screen. Async-signal-safe.
pub fn restore_mode() {
    // SAFETY: tcsetattr is async-signal-safe; SAVED is set before raw mode.
    unsafe {
        if let Some(t) = SAVED.get() {
            libc::tcsetattr(0, libc::TCSANOW, t);
        }
    }
}

/// Put the terminal back from a signal handler or a panic: cooked mode, the
/// main screen, the cursor. Only async-signal-safe calls.
pub fn restore_raw() {
    const SEQ: &[u8] = b"\x1b[0m\x1b[?25h\x1b[?1049l";
    // SAFETY: write and tcsetattr are async-signal-safe; SAVED is set before
    // any handler can run.
    unsafe {
        libc::write(1, SEQ.as_ptr() as *const libc::c_void, SEQ.len());
        if let Some(t) = SAVED.get() {
            libc::tcsetattr(0, libc::TCSANOW, t);
        }
    }
}

/// A panic inside the full screen: put the terminal back, then report, so
/// the message is not drawn into the alternate screen and erased with it.
pub fn restore_on_panic() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_raw();
        prev(info);
    }));
}

/// The full-screen session: raw mode, the alternate screen, no cursor;
/// all of it put back on drop, as curses.wrapper does.
pub struct Screen {
    out: std::io::Stdout,
}

impl Screen {
    pub fn open() -> std::io::Result<Screen> {
        save_termios();
        terminal::enable_raw_mode()?;
        let mut out = std::io::stdout();
        execute!(out, terminal::EnterAlternateScreen, cursor::Hide)?;
        Ok(Screen { out })
    }

    /// (rows, columns), as getmaxyx.
    pub fn size(&self) -> (usize, usize) {
        // A terminal that reports no size (0x0) draws as the default 80x24.
        let (w, h) = terminal::size().ok().filter(|(w, h)| *w > 0 && *h > 0).unwrap_or((80, 24));
        (h as usize, w as usize)
    }

    pub fn erase(&mut self) {
        let _ = queue!(self.out, terminal::Clear(terminal::ClearType::All));
    }

    /// curses' addnstr: at most `n` characters of `s` at (y, x), clipped to
    /// the window rather than raising at its edge.
    pub fn put(&mut self, y: usize, x: usize, s: &str, n: usize, st: Style) {
        let (h, w) = self.size();
        if y >= h || x >= w {
            return;
        }
        let room = (w - x).min(n);
        let text: String = visible(s).chars().take(room).collect();
        if text.is_empty() {
            return;
        }
        let _ = queue!(self.out, cursor::MoveTo(x as u16, y as u16));
        if st.bold {
            let _ = queue!(self.out, SetAttribute(Attribute::Bold));
        }
        if st.reverse {
            let _ = queue!(self.out, SetAttribute(Attribute::Reverse));
        }
        if let Some(c) = st.color {
            let _ = queue!(self.out, SetForegroundColor(pair(c)));
        }
        let _ = queue!(self.out, Print(text), SetAttribute(Attribute::Reset));
    }

    pub fn refresh(&mut self) {
        let _ = self.out.flush();
    }

    /// The next key, as curses would hand it over.
    pub fn key(&mut self) -> Key {
        loop {
            match event::read() {
                Ok(Event::Resize(..)) => return Key::Resize,
                Ok(Event::Key(KeyEvent { code, modifiers, kind, .. })) => {
                    if kind == KeyEventKind::Release {
                        continue;
                    }
                    // Alt reaches curses as ESC then the key; the ESC is what
                    // the finder acts on.
                    if modifiers.contains(KeyModifiers::ALT) {
                        return Key::Esc;
                    }
                    if modifiers.contains(KeyModifiers::CONTROL) {
                        if let KeyCode::Char(c) = code {
                            let c = c.to_ascii_lowercase();
                            if c == 'c' {
                                return Key::Interrupt;
                            }
                            if c.is_ascii_lowercase() {
                                return Key::Ctrl(c as u8);
                            }
                            // ^\, ^Space and the like: control bytes curses
                            // hands over and the finder ignores
                            continue;
                        }
                    }
                    return match code {
                        KeyCode::Up => Key::Up,
                        KeyCode::Down => Key::Down,
                        KeyCode::Left => Key::Left,
                        KeyCode::Right => Key::Right,
                        KeyCode::PageUp => Key::PageUp,
                        KeyCode::PageDown => Key::PageDown,
                        KeyCode::Enter => Key::Enter,
                        KeyCode::Tab => Key::Tab,
                        KeyCode::Backspace => Key::Backspace,
                        KeyCode::Esc => Key::Esc,
                        KeyCode::Char(c) => Key::Char(c),
                        _ => continue,
                    };
                }
                Ok(_) => continue,
                Err(_) => return Key::Interrupt,
            }
        }
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        let _ = execute!(self.out, SetAttribute(Attribute::Reset), cursor::Show, terminal::LeaveAlternateScreen);
        let _ = terminal::disable_raw_mode();
    }
}

fn isatty(fd: i32) -> bool {
    // SAFETY: isatty only inspects the descriptor.
    unsafe { libc::isatty(fd) == 1 }
}

pub fn stdin_tty() -> bool {
    isatty(0)
}

pub fn stdout_tty() -> bool {
    isatty(1)
}

/// `os.get_terminal_size().columns`: the size of stdout itself, None when
/// stdout is not a terminal (COLUMNS is not consulted, as Python's is not).
pub fn stdout_columns() -> Option<usize> {
    // SAFETY: TIOCGWINSZ fills a winsize we own.
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        (libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) == 0).then_some(ws.ws_col as usize)
    }
}

/// One character from stdin, decoded as UTF-8: `sys.stdin.read(1)`. None at EOF.
pub fn read_char() -> Option<char> {
    let mut stdin = std::io::stdin().lock();
    let mut buf = [0u8; 4];
    stdin.read_exact(&mut buf[..1]).ok()?;
    let len = match buf[0] {
        b if b < 0x80 => 1,
        b if b >= 0xf0 => 4,
        b if b >= 0xe0 => 3,
        _ => 2,
    };
    if len > 1 && stdin.read_exact(&mut buf[1..len]).is_err() {
        return Some(char::REPLACEMENT_CHARACTER);
    }
    std::str::from_utf8(&buf[..len]).ok().and_then(|s| s.chars().next()).or(Some(char::REPLACEMENT_CHARACTER))
}

/// One keypress for the sweep: raw on a terminal (^C, ^D and esc read as q,
/// letters folded to lower case), one character a key down a pipe ("" is q).
pub fn sweep_key() -> String {
    if !stdin_tty() {
        return read_char().map(String::from).unwrap_or_else(|| "q".into());
    }
    save_termios();
    let raw = terminal::enable_raw_mode().is_ok();
    let ch = read_char();
    if raw {
        let _ = terminal::disable_raw_mode();
    }
    match ch {
        None | Some('\x03') | Some('\x04') | Some('\x1b') => "q".into(),
        Some(c) => c.to_lowercase().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_characters_show_as_curses_shows_them() {
        assert_eq!(visible("a\x1b]0;evil\x07b"), "a^[]0;evil^Gb");
        assert_eq!(visible("x\x7f\u{9b}y"), "x^?~[y");
        assert_eq!(visible("plain é"), "plain é");
    }

    #[test]
    fn printable_as_python() {
        assert!(printable('a') && printable(' ') && printable('é'));
        assert!(!printable('\u{a0}') && !printable('\t') && !printable('\u{200b}'));
    }
}
