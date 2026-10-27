// The native terminal: a pane that is a cmux local-tmux client, drawn by
// xterm.js from its own tmux client in a PTY (pty_app.rs). tmux owns the
// session and its history; cmux and the app are both clients of it.
//
// TermSlot puts it where a pane is tmux-backed and the snapshot terminal
// (term.ts) everywhere else, so the sheet and the wall preview need not know.
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon, type ClipboardSelectionType } from "@xterm/addon-clipboard";
import "@xterm/xterm/css/xterm.css";
import "./pane.css";
import { Term } from "./term";
import { follow, HoverCard, pathLinks, type Hovered } from "./panelinks";

// A page that starts (or reloads) owns no terminal yet: any its last life
// left attached would keep its tmux client, and its size, for nothing.
void invoke("pty_reset").catch(() => {});

/** The terminal font when cmux names none (Ghostty's own default is
 *  bundled, so the system's monospace stands in for it). */
const FONT = "ui-monospace, Menlo, monospace";

type Look = {
  palette: Record<string, string>;
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  fontFamily?: string;
  fontSize?: number;
};

/** cmux's look for the page's appearance, asked once per appearance. */
const looks = new Map<boolean, Promise<Look | null>>();
function cmuxLook(): Promise<Look | null> {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  if (!looks.has(dark)) looks.set(dark, invoke<Look>("term_look", { dark }).catch(() => null));
  return looks.get(dark)!;
}

/** Command keys a Mac terminal turns into line editing, as iTerm and
 *  Ghostty do: start and end of line, and delete to its start. */
const CMD_KEYS: Record<string, string> = { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" };

/** Each wheel report moves tmux's history 5 lines (and Claude's view a few):
 *  one goes out per this many rows of wheel travel. */
const ROWS_PER_REPORT = 4;

/** Wheel events this page made itself, which xterm.js may turn into reports. */
const paced = new WeakSet<Event>();

/** A mouse report xterm.js sends as text (SGR or X10 form). */
const isMouseReport = (d: string) => d.startsWith("\x1b[<") || d.startsWith("\x1b[M");

/** How long an unseen terminal stays attached: a tab flick keeps it. */
const DETACH_AFTER = 1500;

export class NativeTerm {
  /** The tmux client ended (the session closed, or it never attached). */
  onExit: () => void = () => {};
  el = document.createElement("div");
  private term: Terminal;
  private fit = new FitAddon();
  private opened = false;
  private surface = "";
  private id: number | null = null;
  private attaching = false;
  private hiddenSince = 0;
  /** When Esc last went to the pane, so a second one leaves instead. */
  private escAt = 0;
  private fitTimer = 0;
  /** Bumped by every attach and detach: a channel answers only for the
   *  attach that made it, so the exit a detach provokes, or bytes a killed
   *  client left in flight, are never taken for this one's. */
  private gen = 0;
  /** The link under the pointer, if any. */
  private link: Hovered | null = null;
  private card: HoverCard;
  /** The wheel went to tmux since the last key: it may be in copy mode. */
  private scrolled = false;
  /** Wheel travel not yet sent, in pixels, and when the wheel last moved. */
  private wheelLeft = 0;
  private wheelAt = 0;
  /** Keys go out one after another: the next waits for the last. */
  private keys: Promise<unknown> = Promise.resolve();

  constructor() {
    const open = (uri: string) => void follow(uri, this.id);
    const hovered = (e: MouseEvent, uri: string, y: number, label: string) => {
      this.link = { uri, y, label, go: () => open(uri) };
      this.card.hover(uri, e);
    };
    const left = () => {
      this.link = null;
      this.card.hide();
    };
    this.el.className = "native-term";
    this.card = new HoverCard(this.el);
    this.term = new Terminal({
      fontFamily: FONT,
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      // tmux keeps the history; this is only what scrolled by while attached.
      scrollback: 1000,
      macOptionIsMeta: true,
      // tmux has the mouse: Option-drag selects here, as in other terminals.
      macOptionClickForcesSelection: true,
      // Links a program marks (OSC 8, as Claude prints them): tmux passes
      // them on (the client says it can), and a click opens them as below.
      linkHandler: {
        activate: (_e, uri) => open(uri),
        hover: (e, uri, range) => hovered(e, uri, range.start.y, this.textAt(range)),
        leave: left,
      },
    });
    this.term.loadAddon(this.fit);
    // tmux's copy (a drag, let go) comes as OSC 52: onto the clipboard. A
    // program never reads the clipboard back.
    this.term.loadAddon(
      new ClipboardAddon({
        readText: () => "",
        writeText: (_sel: ClipboardSelectionType, text: string) => void invoke("copy_text", { text }).catch(() => {}),
      }),
    );
    // Links: tmux has the mouse, so xterm.js alone opens one only on a
    // Command-click; a plain click on the link under the pointer opens it too,
    // before tmux sees the click.
    this.term.loadAddon(
      new WebLinksAddon((_e, uri) => open(uri), {
        hover: (e, uri, range) => hovered(e, uri, range?.start.y ?? 0, uri),
        leave: left,
      }),
    );
    // File paths: those on disk, from the pane's folder, open in VS Code.
    this.term.registerLinkProvider(pathLinks(this.term, () => this.id, (h) => (this.link = h)));
    this.el.addEventListener(
      "mousedown",
      (e) => {
        if (!this.link || e.button !== 0 || e.metaKey || e.altKey) return;
        // The screen may have moved under a still pointer: only a link still
        // on its row opens; otherwise the click is tmux's.
        const row = this.term.buffer.active.getLine(this.link.y - 1)?.translateToString(true) ?? "";
        if (!this.link.label || !row.includes(this.link.label.slice(0, 24))) {
          this.link = null;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.card.hide();
        this.link.go();
      },
      true,
    );
    this.term.onData((d) => this.send({ data: d }, !isMouseReport(d)));
    this.term.attachCustomWheelEventHandler((e) => this.wheel(e));
    this.term.onBinary((b) => this.send({ raw: Array.from(b, (c) => c.charCodeAt(0)) }));
    this.term.onResize(({ cols, rows }) => this.id !== null && void invoke("pty_resize", { id: this.id, cols, rows }).catch(() => {}));
    this.term.attachCustomKeyEventHandler((e) => this.key(e));
    new ResizeObserver(() => {
      clearTimeout(this.fitTimer);
      this.fitTimer = window.setTimeout(() => this.visible() && this.fit.fit(), 40);
    }).observe(this.el);
    // Attach while on screen, let go a moment after it is not.
    setInterval(() => this.check(), 400);
  }

  /** Bytes to the pane, in order. A typed key after a wheel scroll first
   *  takes tmux out of copy mode, so it reaches Claude, not tmux. */
  private send(k: { data?: string; raw?: number[] }, typed = false): void {
    const id = this.id;
    if (id === null) return;
    if (typed && this.scrolled) {
      this.scrolled = false;
      this.keys = this.keys.then(() => invoke("pty_leave_scroll", { id })).catch(() => {});
    }
    this.keys = this.keys.then(() => invoke("pty_write", { id, ...k })).catch(() => {});
  }

  /** The text a link range shows, on its first row. */
  private textAt(r: { start: { x: number; y: number }; end: { x: number; y: number } }): string {
    const row = this.term.buffer.active.getLine(r.start.y - 1)?.translateToString(true) ?? "";
    return row.slice(r.start.x - 1, r.end.y === r.start.y ? r.end.x : undefined);
  }

  /** The wheel, paced: while the program (tmux) takes the mouse, a
   *  trackpad's stream of events becomes one report per few rows of travel,
   *  not one per event. A short flick still sends one. */
  private wheel(e: WheelEvent): boolean {
    if (paced.has(e)) return true;
    if (this.term.modes.mouseTrackingMode === "none" || !e.deltaY) return true;
    e.preventDefault();
    this.scrolled = true;
    const rowPx = this.el.clientHeight / Math.max(1, this.term.rows);
    const dy = e.deltaMode === 1 ? e.deltaY * rowPx : e.deltaMode === 2 ? e.deltaY * this.el.clientHeight : e.deltaY;
    const step = rowPx * ROWS_PER_REPORT;
    const now = performance.now();
    const fresh = now - this.wheelAt > 250 || Math.sign(dy) !== Math.sign(this.wheelLeft || dy);
    this.wheelAt = now;
    this.wheelLeft = fresh ? Math.sign(dy) * step : this.wheelLeft + dy;
    let n = Math.trunc(this.wheelLeft / step);
    this.wheelLeft -= n * step;
    for (; n !== 0; n -= Math.sign(n)) {
      const ev = new WheelEvent("wheel", {
        deltaY: Math.sign(n),
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: e.clientX,
        clientY: e.clientY,
        bubbles: true,
        cancelable: true,
      });
      paced.add(ev);
      e.target?.dispatchEvent(ev);
    }
    return false;
  }

  show(surface: string): void {
    if (surface === this.surface) return;
    this.detach();
    this.surface = surface;
    if (this.opened) this.term.reset();
    this.check();
  }

  stop(): void {
    this.detach();
    this.surface = "";
  }

  focus(): void {
    this.term.focus();
  }

  private visible(): boolean {
    return this.el.isConnected && this.el.offsetParent !== null && !document.hidden;
  }

  private check(): void {
    if (!this.surface) return;
    if (this.visible()) {
      this.hiddenSince = 0;
      if (!this.opened) {
        this.term.open(this.el);
        // The textarea exists only once the terminal is open.
        this.term.textarea?.addEventListener("focus", () => this.el.classList.add("focused"));
        this.term.textarea?.addEventListener("blur", () => this.el.classList.remove("focused"));
        this.opened = true;
      }
      if (this.id === null && !this.attaching) void this.attach();
    } else if (this.id !== null) {
      if (!this.hiddenSince) this.hiddenSince = performance.now();
      else if (performance.now() - this.hiddenSince > DETACH_AFTER) this.detach();
    }
  }

  /** cmux's look: its theme's palette and colors, and its font if it sets
   *  one; the page's pane colors until it comes, or if it cannot. */
  private theme(): void {
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue("--pane-bg").trim() || "#1e1e1e";
    const fg = cs.getPropertyValue("--pane-fg").trim() || "#dddddd";
    if (!this.term.options.theme?.background) this.term.options.theme = { background: bg, foreground: fg, cursor: fg, selectionBackground: "#5a6a7a" };
    void cmuxLook().then((l) => {
      if (!l) return;
      const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
      const theme: Record<string, string> = {
        background: l.background ?? bg,
        foreground: l.foreground ?? fg,
        cursor: l.cursor ?? l.foreground ?? fg,
        selectionBackground: l.selectionBackground ?? "#5a6a7a",
      };
      if (l.cursorText) theme.cursorAccent = l.cursorText;
      if (l.selectionForeground) theme.selectionForeground = l.selectionForeground;
      for (const [n, c] of Object.entries(l.palette)) {
        const i = Number(n);
        if (i < 16) theme[i < 8 ? names[i] : "bright" + names[i - 8][0].toUpperCase() + names[i - 8].slice(1)] = c;
      }
      this.term.options.theme = theme;
      this.el.style.background = theme.background;
      if (l.fontFamily) this.term.options.fontFamily = `"${l.fontFamily.replace(/"/g, "")}", ${FONT}`;
      if (l.fontSize) this.term.options.fontSize = Math.min(l.fontSize, 13);
      if (this.visible()) this.fit.fit();
    });
  }

  private async attach(): Promise<void> {
    this.attaching = true;
    const surface = this.surface;
    const gen = ++this.gen;
    try {
      this.theme();
      this.fit.fit();
      const [cols, rows] = [this.term.cols, this.term.rows];
      const ch = new Channel<unknown>((m) => this.data(m, gen));
      const id = await invoke<number>("pty_attach", { surfaceId: surface, cols, rows, onData: ch });
      if (gen !== this.gen || surface !== this.surface || !this.visible()) {
        void invoke("pty_detach", { id });
        return;
      }
      this.id = id;
      // Resized while it attached: tell tmux the size it has now.
      if (this.term.cols !== cols || this.term.rows !== rows) void invoke("pty_resize", { id, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    } catch {
      if (gen === this.gen && surface === this.surface) this.onExit();
    } finally {
      this.attaching = false;
    }
  }

  private data(m: unknown, gen: number): void {
    if (gen !== this.gen) return;
    if (m instanceof ArrayBuffer) this.term.write(new Uint8Array(m));
    else if (m instanceof Uint8Array) this.term.write(m);
    else if (Array.isArray(m)) this.term.write(Uint8Array.from(m as number[]));
    else if (m && typeof m === "object" && (m as { exit?: boolean }).exit) {
      this.id = null;
      this.onExit();
    }
  }

  private detach(): void {
    this.gen++;
    if (this.id !== null) void invoke("pty_detach", { id: this.id }).catch(() => {});
    this.id = null;
    this.hiddenSince = 0;
  }

  /** The app's keys stay the app's: Command keys (⌘Esc leaves) but the
   *  line-editing ones (CMD_KEYS), and a
   *  second Esc within a moment (two would open Claude's Rewind). */
  private key(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    if (e.metaKey) {
      if (e.key === "Escape") this.term.blur();
      const seq = !e.ctrlKey && !e.altKey && !e.shiftKey ? CMD_KEYS[e.key] : undefined;
      if (seq) {
        e.preventDefault();
        this.send({ data: seq }, true);
      }
      return false;
    }
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const now = performance.now();
      if (e.repeat || now - this.escAt < 600) {
        this.escAt = 0;
        this.term.blur();
        e.preventDefault();
        return false;
      }
      this.escAt = now;
    }
    return true;
  }
}

/** Whether a surface is tmux-backed, kept for a moment: it changes only when
 *  a session is started or closed. */
const nativeCache = new Map<string, { v: boolean; at: number }>();
const CACHE_MS = 10_000;

async function isNative(surface: string): Promise<boolean> {
  const c = nativeCache.get(surface);
  if (c && performance.now() - c.at < CACHE_MS) return c.v;
  const v = await invoke<boolean>("pty_native", { surfaceId: surface }).catch(() => false);
  nativeCache.set(surface, { v, at: performance.now() });
  return v;
}

/** One pane's terminal: native where it is tmux-backed, the snapshot
 *  terminal otherwise. Term's surface, so callers swap it in as is. */
export class TermSlot {
  onTrouble: (bad: boolean) => void = () => {};
  /** It switched between native and snapshots. */
  onMode: () => void = () => {};
  el = document.createElement("div");
  private snap = new Term();
  private native = new NativeTerm();
  private mode: "" | "snap" | "native" = "";
  private surface = "";
  private gen = 0;

  constructor() {
    this.el.className = "term-slot";
    // On snapshots, look again now and then: a pane can become tmux-backed
    // (a session attached there) or come back from a failed attach.
    setInterval(() => {
      if (this.mode !== "snap" || !this.surface || this.el.offsetParent === null) return;
      const g = this.gen;
      void isNative(this.surface).then((v) => v && g === this.gen && this.mode === "snap" && this.use("native"));
    }, CACHE_MS);
    this.snap.onTrouble = (bad) => this.mode === "snap" && this.onTrouble(bad);
    // The client ended (the session closed): the snapshot terminal takes over.
    this.native.onExit = () => {
      nativeCache.set(this.surface, { v: false, at: performance.now() });
      if (this.mode === "native") this.use("snap");
    };
  }

  show(surface: string): void {
    if (surface === this.surface) return;
    this.surface = surface;
    const g = ++this.gen;
    void isNative(surface).then((v) => g === this.gen && this.use(v ? "native" : "snap"));
  }

  stop(): void {
    this.gen++;
    this.snap.stop();
    this.native.stop();
    this.mode = "";
    this.surface = "";
  }

  /** Whether the pane is drawn natively (a tmux-backed session). */
  isNative(): boolean {
    return this.mode === "native";
  }

  /** Whether the pane's kind is known yet. */
  ready(): boolean {
    return this.mode !== "";
  }

  focus(): void {
    if (this.mode === "native") this.native.focus();
    else this.snap.el.focus();
  }

  private use(mode: "snap" | "native"): void {
    if (mode === "native") {
      this.snap.stop();
      if (this.mode !== "native") this.el.replaceChildren(this.native.el);
      this.native.show(this.surface);
      this.onTrouble(false);
    } else {
      this.native.stop();
      if (this.mode !== "snap") this.el.replaceChildren(this.snap.el);
      this.snap.show(this.surface);
    }
    const was = this.mode;
    this.mode = mode;
    if (was !== mode) this.onMode();
  }
}
