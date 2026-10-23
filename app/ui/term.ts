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
  /** The rows above the screen (a shell's history), in row_spans' shape. */
  scrollback_spans?: Span[];
  modes?: { code: number; on: boolean; ansi?: boolean }[];
};

/** What the pane's program asked of the mouse, and which screen it is on. */
type MouseModes = { report: boolean; alt: boolean };

function mouseModes(g: Grid): MouseModes {
  const on = (code: number) => !!g.modes?.some((m) => m.ansi === false && m.code === code && m.on);
  return { report: on(1000) || on(1002) || on(1003), alt: g.active_screen === "alternate" };
}
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
  if (e.ctrlKey) {
    // The control bytes cmux has no name for go as the bytes themselves.
    const raw: Record<string, string> = { "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f" };
    if (!e.altKey && raw[e.key]) return { text: raw[e.key] };
    if (e.key === " ") return { key: mods(false) + "space" };
  }
  // A letter or digit with ⌃ or ⌥: by its key (⌥ on a Mac composes "å" from A),
  // shift kept.
  const base = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase() ?? /^Digit([0-9])$/.exec(e.code)?.[1];
  if ((e.ctrlKey || e.altKey) && base) return { key: mods(true) + base };
  if (e.ctrlKey) return null;
  return { text: e.key };
}

/** Below this a pane drawn at its own width is too small to read. */
const READABLE = 10.5;

/** Which view sizes each pane: one at a time, so two never fight over it. */
const holders = new Map<string, Term>();

/** A live view of one pane. Polls while it is on screen. Focused, it takes
 *  the keys and holds the pane at the size that fits here (term_hold), so the
 *  agent redraws at a readable 12px. Unfocused, the pane keeps its own size
 *  and the view scales to show all of it, unless that would drop below
 *  READABLE: then it holds the pane here while it is on screen, and gives
 *  the pane its own size back once it is not. */
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
  /** Why it is held: typing into it, or too small to read at the pane's own size. */
  private reason: "" | "focus" | "view" = "";
  /** The pane's own width, from frames while no view holds it. */
  private ownCols = 0;
  private holdTimer = 0;
  private probe = document.createElement("span");
  /** Holds and releases run one after another, in the order they were asked. */
  private sizing: Promise<unknown> = Promise.resolve();
  private drawnOnce = false;
  private mouse: MouseModes = { report: false, alt: false };
  /** Last frame's rows by what they show, for the next frame to reuse. */
  private rowCache: RowCache = new Map();
  /** Rows of history drawn above the screen. */
  private sbRows = 0;
  /** The links on screen and in the history drawn here, found in the text. */
  private links: Link[] = [];
  /** The link under the pointer, underlined. */
  private hover: Link | null = null;
  private underline = document.createElement("div");
  /** Where a press started, so a drag to select text never opens a link. */
  private downAt: { x: number; y: number } | null = null;
  /** When Esc last went to the pane, so a second one leaves instead. */
  private escAt = 0;
  /** Wheel travel not yet sent as a page. */
  private wheelLeft = 0;
  /** Pages sent and not yet answered: a long flick never queues up. */
  private paging = 0;
  /** When the wheel last moved, for where a gesture starts. */
  private wheelAt = 0;
  /** Poll fast until then: input just went to the pane, its answer is coming. */
  private burstUntil = 0;
  /** Pages go to the pane one after another, in order. */
  private pages: Promise<unknown> = Promise.resolve();

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
    this.el.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    // Links: underlined under the pointer, opened by a click (not a drag).
    this.underline.className = "term-links";
    this.el.addEventListener("mousemove", (e) => this.hoverAt(e));
    this.el.addEventListener("mouseleave", () => this.setHover(null));
    this.el.addEventListener("pointerdown", (e) => (this.downAt = { x: e.clientX, y: e.clientY }));
    this.el.addEventListener("click", (e) => this.clickAt(e));
    this.el.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      e.preventDefault();
      if (text && this.surface) void invoke("term_paste", { surfaceId: this.surface, text }).catch((err) => this.say(String(err)));
    });
    this.el.addEventListener("focus", () => {
      this.el.classList.add("focused");
      this.scale();
      this.hold("focus");
      this.tick();
    });
    this.el.addEventListener("blur", () => {
      this.el.classList.remove("focused");
      // Still too small to read at the pane's own size: keep the hold, so
      // the pane does not jump back and forth.
      if (this.holding() && this.wantsView()) this.reason = "view";
      else this.release();
      this.scale();
    });
    // Back from a hide (which released every hold): hold again as before.
    window.addEventListener("focus", () => {
      if (this.reason) this.hold(this.reason);
    });
    new ResizeObserver(() => {
      clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => (this.holding() ? this.hold(this.reason || "view") : this.manage()), 250);
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

  /** This view sizes its pane now. */
  private holding(): boolean {
    return !!this.held && holders.get(this.held) === this;
  }

  /** The font the pane's own width would be drawn at here, unfocused. */
  private fitPx(cols: number): number {
    const cs = getComputedStyle(this.el);
    const w = this.el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const cell = this.probe.getBoundingClientRect().width / 10 || 7.2; // at 12px
    return w > 0 && cols > 0 ? Math.min(12, (12 * w) / (cols * cell)) : 12;
  }

  /** On screen, and its pane's own width would be drawn too small to read. */
  private wantsView(): boolean {
    return this.visible() && !document.hidden && this.ownCols > 0 && this.fitPx(this.ownCols) < READABLE;
  }

  /** Unfocused: hold the pane while it would be unreadable here, else let it go. */
  private manage(): void {
    if (!this.surface || document.activeElement === this.el) return;
    const want = this.wantsView();
    if (want && !this.holding()) this.hold("view");
    else if (!want && this.reason === "view") this.release();
  }

  private hold(reason: "focus" | "view"): void {
    if (!this.surface) return;
    // Another view sizes this pane: a focus takes it over, a look does not.
    const other = holders.get(this.surface);
    if (reason === "view" && other && other !== this) return;
    const { cols, rows } = this.fits();
    if (cols < 20 || rows < 5) return;
    const surface = this.surface;
    this.held = surface;
    this.reason = reason;
    holders.set(surface, this);
    this.sizing = this.sizing
      .then(() => invoke("term_hold", { surfaceId: surface, cols, rows }))
      .then(() => this.tick())
      .catch((err) => this.say(`can't size the pane here: ${String(err)}`));
  }

  private release(): void {
    clearTimeout(this.holdTimer);
    const s = this.held;
    this.held = "";
    this.reason = "";
    // Only the view that sizes the pane gives it back; another may have taken it over.
    if (!s || holders.get(s) !== this) return;
    holders.delete(s);
    this.sizing = this.sizing.then(() => invoke("term_release", { surfaceId: s })).catch(() => {});
  }

  /** Mirror `surface` (a cmux surface id); "" stops. */
  show(surface: string): void {
    if (surface === this.surface) return;
    // Keys typed for one pane must never land in another.
    if (document.activeElement === this.el) this.el.blur();
    this.release();
    this.surface = surface;
    this.ownCols = 0;
    this.rowCache = new Map();
    this.drawnOnce = false;
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
    const next = performance.now() < this.burstUntil ? 30 : document.activeElement === this.el ? 70 : 160;
    // In trouble the terminal is hidden behind its fallback; it keeps asking
    // (slowly) while that fallback is on screen, so it can come back.
    const shown = this.visible() || (this.failures >= 3 && this.el.isConnected && (this.el.parentElement?.offsetParent ?? null) !== null);
    this.timer = window.setTimeout(() => this.tick(), this.visible() ? next : this.failures >= 3 && shown ? 1000 : 600);
    this.manage();
    if (!shown || this.busy || document.hidden) return;
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
    paneTheme(theme);
    this.cols = f.columns;
    this.rows = f.rows;
    // While a view holds the pane, its frames show that view's size, not the pane's own.
    if (!holders.has(this.surface)) this.ownCols = f.columns;
    this.scale();
    this.manage();
    this.mouse = mouseModes(g);
    const styles = new Map(g.styles.map((s) => [s.id, s]));
    // A shell's history sits above its screen; the alternate screen keeps none.
    const back = this.mouse.alt ? [] : (g.scrollback_spans ?? []);
    const sbRows = back.reduce((n, sp) => Math.max(n, sp.row + 1), 0);
    const now: RowCache = new Map();
    const lines = [...rowsOf(back, sbRows, styles, this.rowCache, now), ...rowsOf(g.row_spans, f.rows, styles, this.rowCache, now)];
    this.links = findLinks([...cellsOf(back, sbRows), ...cellsOf(g.row_spans, f.rows)], f.columns);
    this.rowCache = now;
    // Follow the bottom, as a terminal does, unless the person scrolled up
    // into the history: then the view stays where they are reading.
    const follow = !this.drawnOnce || this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 24;
    // Scrolled up, the rows being read are found again after the redraw: at
    // the history's cap the oldest rows drop off the top and everything moves up.
    const lh = parseFloat(getComputedStyle(this.el).getPropertyValue("--t-line")) || 15;
    const old = this.screen.querySelectorAll<HTMLElement>(".term-row");
    const at = Math.floor(this.el.scrollTop / lh);
    const sig = follow ? "" : [0, 1, 2].map((i) => old[at + i]?.textContent ?? "").join("\n");
    this.drawnOnce = true;
    this.sbRows = sbRows;
    this.screen.replaceChildren(...lines, this.cursor, this.underline);
    if (this.hover) this.setHover(this.links.find((l) => l.url === this.hover?.url) ?? null);
    if (follow) this.el.scrollTop = this.el.scrollHeight;
    else if (sig.trim()) {
      const same = (i: number) => [0, 1, 2].map((k) => lines[i + k]?.textContent ?? "").join("\n") === sig;
      for (let d = 0; d <= 240; d++) {
        if (same(at - d)) {
          if (d) this.el.scrollTop -= d * lh;
          break;
        }
      }
    }
    const c = g.cursor;
    this.cursor.hidden = !c.visible;
    this.cursor.className = `term-cursor ${c.style}`;
    this.cursor.style.transform = `translate(${c.column}ch, calc(${c.row + sbRows} * var(--t-line)))`;
  }

  /** The link at a mouse event's cell, if any. */
  private linkAt(e: MouseEvent): Link | null {
    if (!this.links.length) return null;
    const r = this.screen.getBoundingClientRect();
    const cs = getComputedStyle(this.el);
    const px = parseFloat(cs.getPropertyValue("--t-size")) || 12;
    const lh = parseFloat(cs.getPropertyValue("--t-line")) || 15;
    const cw = ((this.probe.getBoundingClientRect().width / 10) || 7.2) * (px / 12);
    const col = Math.floor((e.clientX - r.left) / cw);
    const row = Math.floor((e.clientY - r.top) / lh);
    return this.links.find((l) => l.segs.some((s) => s.row === row && col >= s.c0 && col <= s.c1)) ?? null;
  }

  private hoverAt(e: MouseEvent): void {
    this.setHover(this.linkAt(e));
  }

  private setHover(l: Link | null): void {
    this.hover = l;
    this.el.classList.toggle("on-link", !!l);
    this.el.title = l ? `${l.url}\nClick to open` : "";
    this.underline.replaceChildren(
      ...(l?.segs ?? []).map((s) => {
        const u = document.createElement("i");
        u.style.transform = `translate(${s.c0}ch, calc(${s.row + 1} * var(--t-line) - 2px))`;
        u.style.width = `${s.c1 - s.c0 + 1}ch`;
        return u;
      }),
    );
  }

  /** A click on a link opens it in the browser; a drag (selecting) does not. */
  private clickAt(e: MouseEvent): void {
    const d = this.downAt;
    this.downAt = null;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    if (String(window.getSelection() ?? "").trim()) return;
    const l = this.linkAt(e);
    if (!l) return;
    e.preventDefault();
    void invoke("open_url", { url: l.url }).catch((err) => this.say(String(err)));
  }

  /** The wheel: to the program when it takes the mouse or is on the
   *  alternate screen (Claude scrolls its own transcript), as PageUp and
   *  PageDown that cmux encodes. Not as mouse reports: Claude reads the ESC
   *  that starts each one as Esc, and two within a moment open its Rewind.
   *  Otherwise the view scrolls through the history drawn here. */
  private wheel(e: WheelEvent): void {
    const takes = this.mouse.report || this.mouse.alt;
    if (!this.surface || !takes || e.deltaY === 0) return;
    e.preventDefault();
    const lh = parseFloat(getComputedStyle(this.el).getPropertyValue("--t-line")) || 15;
    const dy = e.deltaMode === 1 ? e.deltaY * lh : e.deltaMode === 2 ? e.deltaY * this.el.clientHeight : e.deltaY;
    const now = performance.now();
    // A gesture's first movement (after a pause, or turning back) pages at
    // once, so a small scroll is never lost; after that a page per six lines.
    const step = lh * 6;
    const fresh = now - this.wheelAt > 250 || Math.sign(dy) !== Math.sign(this.wheelLeft || dy);
    this.wheelAt = now;
    if (fresh) this.wheelLeft = Math.sign(dy) * step;
    else this.wheelLeft += dy;
    const n = Math.trunc(this.wheelLeft / step);
    if (!n) return;
    this.wheelLeft -= n * step;
    const surface = this.surface;
    const key = n < 0 ? "pageup" : "pagedown";
    for (let i = 0; i < Math.min(3, Math.abs(n)) && this.paging < 3; i++) {
      this.paging++;
      this.burstUntil = performance.now() + 600;
      this.pages = this.pages
        .then(() => invoke("term_key", { surfaceId: surface, key }))
        .then(() => this.tick())
        .catch((err) => this.say(String(err)))
        .finally(() => this.paging--);
    }
  }

  /** Holding the pane at this view's size (focused, or too small to read
   *  otherwise): 12px. Otherwise the pane keeps its own width, so the view
   *  scales to show all of it. */
  private scale(): void {
    let px = 12;
    if (document.activeElement !== this.el && !this.holding()) {
      const cs = getComputedStyle(this.el);
      const w = this.el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const cell = this.probe.getBoundingClientRect().width / 10 || 7.2; // at 12px
      if (w > 0 && this.cols > 0) px = Math.max(8, Math.min(12, (12 * w) / (this.cols * cell)));
    }
    const size = `${px.toFixed(2)}px`;
    if (this.el.style.getPropertyValue("--t-size") === size) return;
    // A view at the bottom stays there through a change of size.
    const atEnd = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 24;
    this.el.style.setProperty("--t-size", size);
    this.el.style.setProperty("--t-line", `${(px * 1.25).toFixed(2)}px`);
    if (atEnd) this.el.scrollTop = this.el.scrollHeight;
  }

  private key(e: KeyboardEvent): void {
    // ⌘Esc leaves the terminal: plain Esc is the agent's.
    if (e.metaKey && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.el.blur();
      return;
    }
    // One Esc is the agent's (it interrupts Claude). A second within a
    // moment would open Claude's Rewind, which pressing Esc to get out of
    // the app's terminal never means: it leaves the terminal instead.
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const now = performance.now();
      if (e.repeat || now - this.escAt < 600) {
        e.preventDefault();
        e.stopPropagation();
        this.escAt = 0;
        this.el.blur();
        return;
      }
      this.escAt = now;
    }
    const act = keyAction(e);
    if (act === null || !this.surface) return;
    // The key is the agent's: not Desk's, not the sheet's, not the window's.
    e.preventDefault();
    e.stopPropagation();
    this.burstUntil = performance.now() + 600;
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

/** cmux's terminal theme, app-wide: every text drawing of a pane (Mosaic's
 *  tiles, the fallbacks) wears the colours the live terminal does. */
function paneTheme(theme: Grid["terminal_theme"]): void {
  const root = document.documentElement.style;
  if (theme?.background && root.getPropertyValue("--pane-bg") !== theme.background) root.setProperty("--pane-bg", theme.background);
  if (theme?.foreground && root.getPropertyValue("--pane-fg") !== theme.foreground) root.setProperty("--pane-fg", theme.foreground);
}

let primed = false;
/** Fetch the theme once from any pane, before a live terminal is shown. */
export function primeTheme(surface: string): void {
  if (primed || !surface) return;
  primed = true;
  invoke<Frame | null>("term_frame", { surfaceId: surface, seen: "" })
    .then((f) => (f ? paneTheme(f.grid.terminal_theme) : (primed = false)))
    .catch(() => (primed = false));
}

/** A link found in a pane's text: its URL and the cells it covers, a
 *  segment a row (a URL the pane wrapped runs on into the next row). */
type Link = { url: string; segs: { row: number; c0: number; c1: number }[] };

/** Each row's cells: one string a cell, "" for the cells a wide character covers. */
function cellsOf(spans: Span[], n: number): string[][] {
  const rows: string[][] = Array.from({ length: n }, () => []);
  for (const sp of spans) {
    const row = rows[sp.row];
    if (!row) continue;
    const chars = [...sp.text];
    const wide = sp.cell_width !== chars.length;
    for (let i = 0; i < sp.cell_width; i++) row[sp.column + i] = wide ? (i === 0 ? sp.text : "") : (chars[i] ?? " ");
  }
  return rows.map((r) => Array.from(r, (c) => c ?? " "));
}

const URL_RE = /https?:\/\/[^\s<>"'`|\u2502]+/g;
/** Not part of a URL when it ends one: closing punctuation around it in prose. */
const TRAIL = /[.,;:!?'")\]}>]+$/;

/** The http(s) links in a pane's rows. A row whose text runs to (or one
 *  short of) the last column, followed by a row that starts within a few
 *  spaces of the margin, is one line the program wrapped (Claude leaves a
 *  column at the edge, and its prompt box hangs its lines by two): a link
 *  may continue there, past those leading spaces. */
export function findLinks(rows: string[][], cols: number): Link[] {
  const out: Link[] = [];
  let r = 0;
  while (r < rows.length) {
    // A logical line: rows joined while one fills to the edge and the next goes on at column 0.
    const at: { row: number; col: number }[] = [];
    let text = "";
    let k = r;
    let from = 0;
    for (;;) {
      const cells = rows[k];
      for (let c = from; c < cells.length; c++) {
        if (cells[c] === "") continue;
        at.push({ row: k, col: c });
        text += cells[c].length === 1 ? cells[c] : cells[c][0];
      }
      let end = cells.length - 1;
      while (end >= 0 && (cells[end] === " " || cells[end] === undefined)) end--;
      const next = rows[k + 1];
      // Up to two columns short of the edge: Claude's margin, its prompt box's padding.
      if (!next || end < cols - 3) break;
      let lead = 0;
      while (lead < next.length && next[lead] === " ") lead++;
      if (lead >= next.length || lead > 4) break;
      // The text above ran to the edge: drop what the pane padded it with.
      while (text.endsWith(" ")) {
        text = text.slice(0, -1);
        at.pop();
      }
      // The terminal's own wrap (to the last column, on at column 0) splits
      // anywhere: the two rows are one run of text. A program's word wrap (a
      // margin, a hanging indent) splits a word only when it cannot fit on a
      // line by itself; when the two pieces would fit, they are two words.
      const soft = end === cols - 1 && lead === 0;
      if (!soft) {
        const tail = (/\S+$/.exec(text) ?? [""])[0].length;
        let head = 0;
        while (lead + head < next.length && next[lead + head] !== " " && next[lead + head] !== undefined) head++;
        if (tail + head <= cols - lead - 2) {
          text += " ";
          at.push({ row: k, col: -1 });
        }
      }
      k++;
      from = lead;
    }
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(TRAIL, "");
      if (url.length < "https://x".length - 1) continue;
      const segs: Link["segs"] = [];
      for (let i = m.index ?? 0; i < (m.index ?? 0) + url.length; i++) {
        const p = at[i];
        if (!p) break;
        const last = segs[segs.length - 1];
        if (last && last.row === p.row && p.col === last.c1 + 1) last.c1 = p.col;
        else segs.push({ row: p.row, c0: p.col, c1: p.col });
      }
      out.push({ url, segs });
    }
    r = k + 1;
  }
  return out;
}

/** Rows drawn last frame, by what they show: a row whose cells are the same
 *  this frame (history that moved up a line, say) keeps its node. */
type RowCache = Map<string, HTMLElement[]>;

/** `n` rows of cells from spans that arrive by row and column; the gaps
 *  between them are blank cells. Nodes come from `was` when a row is
 *  unchanged; every row drawn goes into `now`. */
function rowsOf(spans: Span[], n: number, styles: Map<number, Style>, was: RowCache, now: RowCache): HTMLElement[] {
  const byRow: Span[][] = Array.from({ length: n }, () => []);
  for (const sp of spans) byRow[sp.row]?.push(sp);
  const look = new Map<number, string>();
  const styleKey = (id: number) => {
    let k = look.get(id);
    if (k === undefined) {
      const st = styles.get(id);
      k = st ? JSON.stringify({ ...st, id: 0 }) : "";
      look.set(id, k);
    }
    return k;
  };
  return byRow.map((row) => {
    const key = row.map((sp) => `${sp.column}:${sp.cell_width}:${styleKey(sp.style_id)}:${sp.text}`).join("\u0000");
    let ln = was.get(key)?.pop();
    if (!ln) ln = drawRow(row, styles);
    const list = now.get(key);
    if (list) list.push(ln);
    else now.set(key, [ln]);
    return ln;
  });
}

function drawRow(row: Span[], styles: Map<number, Style>): HTMLElement {
  const ln = document.createElement("div");
  ln.className = "term-row";
  let at = 0;
  for (const sp of row) {
    if (sp.column > at) ln.append(" ".repeat(sp.column - at));
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
    at = sp.column + sp.cell_width;
  }
  return ln;
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
