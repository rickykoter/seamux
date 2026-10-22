// A live terminal: a cmux pane's screen as cmux renders it, with keys back
// to it. term_app.rs serves the frames (terminal.replay's render grid) and
// sends input (terminal.input / terminal.paste).
import { invoke } from "@tauri-apps/api/core";

type Span = { row: number; column: number; cell_width: number; style_id: number; text: string };
type Style = {
  id: number;
  foreground: string;
  background: string;
  background_source?: string;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean | string;
  strikethrough: boolean;
  inverse: boolean;
  invisible: boolean;
};
type Grid = {
  row_spans: Span[];
  styles: Style[];
  cursor: { row: number; column: number; visible: boolean; style: string };
  terminal_theme?: { background?: string; foreground?: string; cursor?: string };
  active_screen?: string;
};
type Frame = { stamp: string; rows: number; columns: number; grid: Grid };

/** The bytes a terminal sends for a key, or null when the app keeps the key. */
export function keyBytes(e: KeyboardEvent): string | null {
  if (e.metaKey) return null; // ⌘ keys are the app's (⌘E, ⌘[, ⌘], ⌘V via paste)
  const k = e.key;
  if (e.ctrlKey && !e.altKey && k.length === 1) {
    const c = k.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // ⌃A … ⌃Z
    if (k === "[") return "\x1b";
    if (k === "\\") return "\x1c";
    if (k === "]") return "\x1d";
    return null;
  }
  const esc = (s: string) => (e.altKey ? "\x1b" : "") + s;
  switch (k) {
    case "Enter":
      return esc("\r");
    case "Backspace":
      return esc("\x7f");
    case "Tab":
      return e.shiftKey ? "\x1b[Z" : "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return esc("\x1b[A");
    case "ArrowDown":
      return esc("\x1b[B");
    case "ArrowRight":
      return esc("\x1b[C");
    case "ArrowLeft":
      return esc("\x1b[D");
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
    case "Delete":
      return "\x1b[3~";
  }
  if (k.length === 1) return esc(k);
  return null;
}

/** A live view of one pane. Polls while it is on screen; focused, it takes the keys. */
export class Term {
  el = document.createElement("div");
  private screen = document.createElement("div");
  private cursor = document.createElement("div");
  private status = document.createElement("div");
  private surface = "";
  private stamp = "";
  private timer = 0;
  private busy = false;
  private cols = 80;
  private rows = 24;
  private failures = 0;

  constructor() {
    this.el.className = "term";
    this.el.tabIndex = 0;
    this.el.setAttribute("role", "textbox");
    this.el.setAttribute("aria-label", "The agent's terminal: click to type into it");
    this.screen.className = "term-screen";
    this.cursor.className = "term-cursor";
    this.status.className = "term-status";
    this.screen.append(this.cursor);
    this.el.append(this.screen, this.status);
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.el.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      e.preventDefault();
      if (text && this.surface) void invoke("term_paste", { surfaceId: this.surface, text }).catch((err) => this.say(String(err)));
    });
    this.el.addEventListener("focus", () => this.el.classList.add("focused"));
    this.el.addEventListener("blur", () => this.el.classList.remove("focused"));
    new ResizeObserver(() => this.fit()).observe(this.el);
  }

  /** Mirror `surface` (a cmux surface id); "" stops. */
  show(surface: string): void {
    if (surface === this.surface) return;
    this.surface = surface;
    this.stamp = "";
    this.failures = 0;
    this.tick();
  }

  stop(): void {
    this.surface = "";
    clearTimeout(this.timer);
  }

  private visible(): boolean {
    return this.el.isConnected && this.el.offsetParent !== null;
  }

  private tick(): void {
    clearTimeout(this.timer);
    if (!this.surface) return;
    // Faster while typing into it, slower when only watched, idle off screen.
    const next = document.activeElement === this.el ? 70 : 160;
    this.timer = window.setTimeout(() => this.tick(), this.visible() ? next : 600);
    if (!this.visible() || this.busy || document.hidden) return;
    this.busy = true;
    const surface = this.surface;
    invoke<Frame | null>("term_frame", { surfaceId: surface, seen: this.stamp })
      .then((f) => {
        this.failures = 0;
        if (f && surface === this.surface) this.draw(f);
      })
      .catch((err) => {
        if (++this.failures === 3) this.say(`can't read this pane: ${String(err)}`);
      })
      .finally(() => (this.busy = false));
  }

  private draw(f: Frame): void {
    this.stamp = f.stamp;
    this.say("");
    const g = f.grid;
    const theme = g.terminal_theme ?? {};
    this.el.style.setProperty("--t-bg", theme.background ?? "#1e1e1e");
    this.el.style.setProperty("--t-fg", theme.foreground ?? "#ddd");
    this.el.style.setProperty("--t-cursor", theme.cursor ?? theme.foreground ?? "#ddd");
    if (f.columns !== this.cols || f.rows !== this.rows) {
      this.cols = f.columns;
      this.rows = f.rows;
      this.fit();
    }
    const styles = new Map(g.styles.map((s) => [s.id, s]));
    const lines: HTMLElement[] = [];
    for (let r = 0; r < f.rows; r++) {
      const ln = document.createElement("div");
      ln.className = "term-row";
      lines.push(ln);
    }
    // Spans arrive by row and column; gaps between them are blank cells.
    const at = new Array<number>(f.rows).fill(0);
    for (const sp of g.row_spans) {
      const ln = lines[sp.row];
      if (!ln) continue;
      if (sp.column > at[sp.row]) ln.append(" ".repeat(sp.column - at[sp.row]));
      const st = styles.get(sp.style_id);
      const span = document.createElement("span");
      span.textContent = sp.text;
      if (st) paint(span, st);
      // Wide characters keep their cells, so the columns after them line up.
      if (sp.cell_width !== [...sp.text].length) {
        span.style.display = "inline-block";
        span.style.width = `${sp.cell_width}ch`;
      }
      ln.append(span);
      at[sp.row] = sp.column + sp.cell_width;
    }
    this.screen.replaceChildren(...lines, this.cursor);
    const c = g.cursor;
    this.cursor.hidden = !c.visible;
    this.cursor.className = `term-cursor ${c.style}`;
    this.cursor.style.transform = `translate(${c.column}ch, calc(${c.row} * var(--t-line)))`;
  }

  /** Scale the pane's columns to the width we have: the pane keeps its own size. */
  private fit(): void {
    const w = this.el.clientWidth - 16;
    if (w <= 0) return;
    // ui-monospace's advance is about 0.6em.
    const px = Math.max(7, Math.min(13, w / (this.cols * 0.6)));
    this.el.style.setProperty("--t-size", `${px.toFixed(2)}px`);
  }

  private key(e: KeyboardEvent): void {
    const bytes = keyBytes(e);
    if (bytes === null || !this.surface) return;
    // The key is the agent's: not Desk's, not the sheet's, not the window's.
    e.preventDefault();
    e.stopPropagation();
    void invoke("term_input", { surfaceId: this.surface, text: bytes })
      .then(() => {
        this.stamp = ""; // the next frame draws whatever the key did
        this.tick();
      })
      .catch((err) => this.say(String(err)));
  }

  private say(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }
}

function paint(span: HTMLElement, st: Style): void {
  let fg = st.foreground;
  let bg = st.background_source === "default" ? "" : st.background;
  if (st.inverse) [fg, bg] = [bg || "var(--t-bg)", fg];
  if (fg) span.style.color = fg;
  if (bg) span.style.background = bg;
  if (st.bold) span.style.fontWeight = "700";
  if (st.faint) span.style.opacity = "0.6";
  if (st.italic) span.style.fontStyle = "italic";
  const deco = [st.underline ? "underline" : "", st.strikethrough ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) span.style.textDecoration = deco;
  if (st.invisible) span.style.visibility = "hidden";
}
