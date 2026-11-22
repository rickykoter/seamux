// A stand-in for Claude in fullscreen, for the scroll lab (/scroll-lab):
// the alternate screen, the mouse taken, a long transcript the wheel
// scrolls, and every redraw a whole screen, as tmux sends one to its client.
//
// It answers the way the real chain does, to the degree a page can:
//   frames "whole"  each redraw is one message, wrapped in the 2026 markers
//                   (tmux with the sync feature, frames.rs passing it on)
//   frames "raw"    each redraw is cut into 1 KB messages, one per task,
//                   with no markers (a macOS PTY read is at most 1 KB)
//   one write in, one redraw out: Claude reads what came and draws once,
//   so wheel reports that come in one write cost one redraw
// It is a model: the real app's ⌥⌘L lab measures the real thing.

const ESC = "\x1b";
const rgb = (r, g, b) => `${ESC}[38;2;${r};${g};${b}m`;
const bg = (r, g, b) => `${ESC}[48;2;${r};${g};${b}m`;
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;

const WORDS = "the pane draws each frame whole so a scroll never shows half of one and the wheel reports go out together while a write is in flight".split(" ");

/** A transcript long enough to scroll through: prompts, replies, tool calls
 *  and diffs, coloured the way Claude colours them (truecolor runs). */
function transcript(cols) {
  const out = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const words = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" ");
  const wrap = (text, pad) => {
    const lines = [];
    let line = "";
    for (const w of text.split(" ")) {
      if ((line + " " + w).length > cols - pad - 2) {
        lines.push(line);
        line = w;
      } else line = line ? line + " " + w : w;
    }
    if (line) lines.push(line);
    return lines;
  };
  for (let turn = 1; turn <= 40; turn++) {
    out.push("");
    out.push(`${bg(46, 56, 60)}${rgb(211, 198, 170)}> ${words(6 + Math.floor(rand() * 8))}${ESC}[K${RESET}`);
    out.push("");
    for (const l of wrap(words(30 + Math.floor(rand() * 40)), 2)) out.push(`${rgb(211, 198, 170)}  ${l}${RESET}`);
    out.push("");
    out.push(`${rgb(167, 192, 128)}⏺${RESET} ${BOLD}Bash${RESET}(cargo test -p seamux-app frames)`);
    for (let i = 0; i < 3 + Math.floor(rand() * 4); i++) out.push(`  ${DIM}⎿${RESET}  ${rgb(133, 146, 137)}test frames::tests::case_${turn}_${i} ... ${rgb(167, 192, 128)}ok${RESET}`);
    out.push("");
    out.push(`${rgb(167, 192, 128)}⏺${RESET} ${BOLD}Update${RESET}(app/ui/native.ts)`);
    for (let i = 0; i < 6 + Math.floor(rand() * 6); i++) {
      const add = rand() > 0.45;
      const n = String(100 + turn * 7 + i).padStart(4);
      const text = `${n} ${add ? "+" : "-"}   ${words(5 + Math.floor(rand() * 5))}`.slice(0, cols - 4);
      out.push(`  ${add ? bg(40, 58, 42) + rgb(167, 192, 128) : bg(64, 38, 40) + rgb(230, 126, 128)}${text.padEnd(cols - 4)}${RESET}`);
    }
  }
  return out;
}

export class FakeClaude {
  /** @param {{cols: number, rows: number, frames: "whole" | "raw", send: (b: Uint8Array) => void, speed?: number}} o */
  constructor(o) {
    this.cols = o.cols;
    this.rows = o.rows;
    this.frames = o.frames;
    this.send = o.send;
    this.speed = o.speed ?? 1;
    this.lines = transcript(this.cols);
    this.top = Math.max(0, this.lines.length - this.area());
    this.enc = new TextEncoder();
    this.queue = [];
    this.port = new MessageChannel();
    this.port.port1.onmessage = () => this.drain();
    // Fullscreen: the alternate screen, every mouse event, SGR reports.
    this.out(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`, true);
    this.draw();
  }

  area() {
    return Math.max(1, this.rows - 4);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows ?? this.rows;
    this.lines = transcript(this.cols);
    this.top = Math.min(this.top, Math.max(0, this.lines.length - this.area()));
    this.draw();
  }

  /** What the pane was sent: wheel reports move the view, then one redraw. */
  write(data) {
    let moved = 0;
    for (const m of data.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)) {
      const b = Number(m[1]);
      if (b === 64) moved -= this.speed;
      else if (b === 65) moved += this.speed;
    }
    if (!moved) return;
    const max = Math.max(0, this.lines.length - this.area());
    const top = Math.max(0, Math.min(max, this.top + moved));
    if (top === this.top) return;
    this.top = top;
    this.draw();
  }

  draw() {
    const rows = [];
    const area = this.area();
    for (let r = 0; r < area; r++) rows.push(this.lines[this.top + r] ?? "");
    const rule = `${DIM}${"─".repeat(this.cols)}${RESET}`;
    rows.push(rule, `${rgb(211, 198, 170)}> ${RESET}`, rule);
    const pct = Math.round((100 * this.top) / Math.max(1, this.lines.length - area));
    rows.push(`${DIM}  scroll lab · ${this.lines.length} lines · ${pct}%${RESET}`);
    let s = "";
    rows.forEach((l, i) => (s += `${ESC}[${i + 1};1H${l}${ESC}[K`));
    s += `${ESC}[${area + 2};3H`;
    this.out(s);
  }

  out(s, now = false) {
    const b = this.enc.encode(this.frames === "whole" ? `${ESC}[?2026h${s}${ESC}[?2026l` : s);
    if (now || this.frames === "whole") {
      this.queue.push(b);
    } else {
      for (let i = 0; i < b.length; i += 1024) this.queue.push(b.subarray(i, i + 1024));
    }
    this.port.port2.postMessage(0);
  }

  /** One message per task, as a PTY's reads reach the page one by one. */
  drain() {
    const b = this.queue.shift();
    if (b) this.send(b);
    if (this.queue.length) this.port.port2.postMessage(0);
  }

  close() {
    this.port.port1.close();
    this.queue = [];
  }
}
