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
import "@xterm/xterm/css/xterm.css";
import { Term } from "./term";

// A page that starts (or reloads) owns no terminal yet: any its last life
// left attached would keep its tmux client, and its size, for nothing.
void invoke("pty_reset").catch(() => {});

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
  /** The link under the pointer, and its buffer row (1-based), if any. */
  private link: { uri: string; y: number } | null = null;
  /** Keys go out one after another: the next waits for the last. */
  private keys: Promise<unknown> = Promise.resolve();

  constructor() {
    this.el.className = "native-term";
    this.term = new Terminal({
      fontFamily: "ui-monospace, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      // tmux keeps the history; this is only what scrolled by while attached.
      scrollback: 1000,
      macOptionIsMeta: true,
      // tmux has the mouse: Option-drag selects here, as in other terminals.
      macOptionClickForcesSelection: true,
    });
    this.term.loadAddon(this.fit);
    // Links: tmux has the mouse, so xterm.js alone opens one only on a
    // Command-click; a plain click on the link under the pointer opens it too,
    // before tmux sees the click.
    const open = (uri: string) => void invoke("open_url", { url: uri }).catch(() => {});
    this.term.loadAddon(
      new WebLinksAddon((_e, uri) => open(uri), {
        hover: (_e, uri, range) => (this.link = { uri, y: range?.start.y ?? 0 }),
        leave: () => (this.link = null),
      }),
    );
    this.el.addEventListener(
      "mousedown",
      (e) => {
        if (!this.link || e.button !== 0 || e.metaKey || e.altKey) return;
        // The screen may have moved under a still pointer: only a link still
        // on its row opens; otherwise the click is tmux's.
        const row = this.term.buffer.active.getLine(this.link.y - 1)?.translateToString(true) ?? "";
        if (!row.includes(this.link.uri.slice(0, 24))) {
          this.link = null;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        open(this.link.uri);
      },
      true,
    );
    this.term.onData((d) => this.send({ data: d }));
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

  private send(k: { data?: string; raw?: number[] }): void {
    const id = this.id;
    if (id === null) return;
    this.keys = this.keys.then(() => invoke("pty_write", { id, ...k })).catch(() => {});
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

  private theme(): void {
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue("--pane-bg").trim() || "#1e1e1e";
    const fg = cs.getPropertyValue("--pane-fg").trim() || "#dddddd";
    this.term.options.theme = { background: bg, foreground: fg, cursor: fg, selectionBackground: "#5a6a7a" };
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

  /** The app's keys stay the app's: Command keys (⌘Esc leaves), and a
   *  second Esc within a moment (two would open Claude's Rewind). */
  private key(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    if (e.metaKey) {
      if (e.key === "Escape") this.term.blur();
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
    this.mode = mode;
  }
}
