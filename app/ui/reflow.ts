// Re-flow a Claude pane's text to the preview's width.
//
// Claude Code wraps its replies at the terminal's width, so a wide window
// shows an 80-column strip. A line that ran to (near) that width and is
// followed by a line at the same indent was wrapped there, not ended there:
// join the two, and let the browser wrap the paragraph to the window. A new
// bullet, a blank line, a short line and anything laid out in columns (a
// table, a box) stays exactly as it was.

export type Block = {
  /** Columns before the line's own text (a bullet's text, past its marker). */
  start: number;
  /** Columns the first line hangs left of `start` (the marker's width). */
  hang: number;
  text: string;
};

/** A list or transcript marker: -, *, •, ●, ⏺, ※, ✻, ⎿, ❯, or "1." / "1)". */
const MARK = /^(\s*)(?:[-*•●⏺※✻⎿❯]|\d+[.)])\s+/;
/** Laid out in columns: box drawing, or a run of 3+ spaces inside the text. */
const COLUMNS = /[│┃┆╎├┤┌┐└┘╭╮╰╯]|\S {3,}\S/;

const len = (s: string) => [...s].length;
const lead = (s: string) => len(s) - len(s.trimStart());

function textStart(line: string): number {
  const m = line.match(MARK);
  return m ? len(m[0]) : lead(line);
}

export function reflow(lines: string[]): Block[] {
  const width = Math.max(0, ...lines.map(len));
  // A wrapped line ends within a long word of the width; below 40 columns
  // nothing reads as wrapped.
  const near = (l: string) => width >= 40 && len(l) >= width - 16;
  const out: Block[] = [];
  let last: { block: Block; line: string } | null = null;
  for (const line of lines) {
    if (!line.trim()) {
      out.push({ start: 0, hang: 0, text: "" });
      last = null;
      continue;
    }
    const joins =
      last !== null &&
      near(last.line) &&
      !MARK.test(line) &&
      lead(line) === last.block.start &&
      !COLUMNS.test(line) &&
      !COLUMNS.test(last.line);
    if (joins && last) {
      last.block.text += " " + line.trim();
      last.line = line;
      continue;
    }
    const start = textStart(line);
    const block = { start, hang: start - lead(line), text: line.slice(line.length - line.trimStart().length) };
    out.push(block);
    last = { block, line };
  }
  return out;
}
