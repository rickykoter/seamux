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

/** What a key sends: a named key for cmux to encode (it knows the keyboard
 *  protocol the program turned on, so Shift+Tab reaches Claude as Claude
 *  expects), or plain text; null when the app keeps the key. */
export type KeyAction = { key: string } | { text: string };

const NAMED: Record<string, string> = {
  Enter: "enter", Escape: "escape", Tab: "tab", Backspace: "backspace", Delete: "delete",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};

export function keyAction(e: KeyboardEvent): KeyAction | null {
  if (e.metaKey) return null; // ⌘ keys are the app's (⌘E, ⌘[, ⌘], ⌘V via paste)
  const mods = (shift: boolean) => (e.ctrlKey ? "ctrl+" : "") + (e.altKey ? "alt+" : "") + (shift && e.shiftKey ? "shift+" : "");
  const named = NAMED[e.key];
  if (named) return { key: mods(true) + named };
  if (e.key.length !== 1) return null; // Shift, Control, F-keys: nothing to send
  if (e.ctrlKey || e.altKey) return { key: mods(false) + e.key.toLowerCase() };
  return { text: e.key };
}

/** A live view of one pane. Polls while it is on screen. Focused, it takes
 *  the keys and holds the pane at the size that fits here (term_hold), so the
 *  agent redraws at a readable 12px; blurred, the pane gets its own size back. */
export class Term {
  /** Frames failed three times running (true) or came back (false). */
  onTrouble: (bad: boolean) => void = () => {};
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
  /** The surface held at this view's size, if any. */
  private held = "";
  private holdTimer = 0;
  private probe = document.createElement("span");

  constructor() {
    this.el.className = "term";
    this.el.tabIndex = 0;
    this.el.setAttribute("role", "textbox");
    this.el.setAttribute("aria-label", "The agent's terminal: click to type into it");
    this.screen.className = "term-screen";
    this.cursor.className = "term-cursor";
    this.status.className = "term-status";
    this.screen.append(this.cursor);
    // One cell's size, measured, for how many columns and rows fit.
    this.probe.className = "term-probe";
    this.probe.textContent = "M".repeat(10);
    this.probe.setAttribute("aria-hidden", "true");
    this.el.append(this.screen, this.status, this.probe);
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.el.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      e.preventDefault();
      if (text && this.surface) void invoke("term_paste", { surfaceId: this.surface, text }).catch((err) => this.say(String(err)));
    });
    this.el.addEventListener("focus", () => {
      this.el.classList.add("focused");
      this.hold();
      this.tick();
    });
    this.el.addEventListener("blur", () => {
      this.el.classList.remove("focused");
      this.release();
    });
    new ResizeObserver(() => {
      if (document.activeElement !== this.el) return;
      clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => this.hold(), 250);
    }).observe(this.el);
  }

  /** How many columns and rows of 12px cells fit here. */
  private fits(): { cols: number; rows: number } {
    const cell = this.probe.getBoundingClientRect();
    const cw = cell.width / 10 || 7.2;
    const lh = cell.height || 15;
    const cs = getComputedStyle(this.el);
    const w = this.el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = this.el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return { cols: Math.floor(w / cw), rows: Math.floor(h / lh) };
  }

  private hold(): void {
    if (!this.surface) return;
    const { cols, rows } = this.fits();
    if (cols < 20 || rows < 5) return;
    const surface = this.surface;
    this.held = surface;
    void invoke("term_hold", { surfaceId: surface, cols, rows })
      .then(() => {
        this.stamp = "";
        this.tick();
      })
      .catch((err) => this.say(`can't size the pane here: ${String(err)}`));
  }

  private release(): void {
    clearTimeout(this.holdTimer);
    const s = this.held;
    this.held = "";
    if (s) void invoke("term_release", { surfaceId: s }).catch(() => {});
  }

  /** Mirror `surface` (a cmux surface id); "" stops. */
  show(surface: string): void {
    if (surface === this.surface) return;
    this.release();
    this.surface = surface;
    this.stamp = "";
    this.failures = 0;
    this.tick();
  }

  stop(): void {
    this.release();
    if (document.activeElement === this.el) this.el.blur();
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
        if (this.failures >= 3) this.onTrouble(false);
        this.failures = 0;
        if (f && surface === this.surface) this.draw(f);
      })
      .catch((err) => {
        if (++this.failures === 3) {
          this.say(`can't read this pane live: ${String(err)}`);
          this.onTrouble(true);
        }
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
    this.cols = f.columns;
    this.rows = f.rows;
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
    // Follow the bottom, as a terminal does, unless the person scrolled up.
    const follow = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 24;
    this.screen.replaceChildren(...lines, this.cursor);
    if (follow) this.el.scrollTop = this.el.scrollHeight;
    const c = g.cursor;
    this.cursor.hidden = !c.visible;
    this.cursor.className = `term-cursor ${c.style}`;
    this.cursor.style.transform = `translate(${c.column}ch, calc(${c.row} * var(--t-line)))`;
  }

  private key(e: KeyboardEvent): void {
    // ⌘Esc leaves the terminal: plain Esc is the agent's.
    if (e.metaKey && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.el.blur();
      return;
    }
    const act = keyAction(e);
    if (act === null || !this.surface) return;
    // The key is the agent's: not Desk's, not the sheet's, not the window's.
    e.preventDefault();
    e.stopPropagation();
    const sent = "key" in act ? invoke("term_key", { surfaceId: this.surface, key: act.key }) : invoke("term_input", { surfaceId: this.surface, text: act.text });
    void sent
      .then(() => {
        this.tick(); // the next frame draws whatever the key did
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
