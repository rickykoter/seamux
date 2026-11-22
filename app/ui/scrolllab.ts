// The scroll lab: three switches for how a native pane draws and scrolls,
// and what the last scroll cost, to compare them by feel and by number.
// ⌥⌘L in a pane shows it; the demo's side-by-side page (docs/demo/app,
// /scroll-lab) shows one per side.
//
//   renderer  webgl: xterm.js draws with the GPU. dom: a DOM row per line.
//   frames    whole: tmux marks each redraw and the app passes it on in one
//             piece (frames.rs). raw: every PTY read as it came (1 KB each).
//   wheel     batch: wheel reports that gather while a write is in flight go
//             in one write. serial: one write per report, each after the last.

export type Lab = { renderer: "webgl" | "dom"; frames: "whole" | "raw"; wheel: "batch" | "serial" };
export const LAB_DEFAULT: Lab = { renderer: "webgl", frames: "whole", wheel: "batch" };

const CHOICES: { [K in keyof Lab]: { label: string; opts: [Lab[K], string, string][] } } = {
  renderer: { label: "Renderer", opts: [["webgl", "WebGL", "Draw with the GPU"], ["dom", "DOM", "Draw with a DOM row per line (before)"]] },
  frames: { label: "Frames", opts: [["whole", "Whole", "Pass each of tmux's redraws on in one piece"], ["raw", "Raw", "Pass each PTY read on as it came (before)"]] },
  wheel: { label: "Wheel", opts: [["batch", "Batch", "Send reports that gather while a write is in flight in one write"], ["serial", "Serial", "One write per wheel report, each after the last (before)"]] },
};

function valid(v: unknown): Partial<Lab> {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: Partial<Lab> = {};
  for (const k of Object.keys(CHOICES) as (keyof Lab)[]) {
    if (CHOICES[k].opts.some(([x]) => x === o[k])) (out as Record<string, unknown>)[k] = o[k];
  }
  return out;
}

/** A lab's settings and who listens to them. The app's own is kept per
 *  machine (`key`); the demo page's two are not kept. */
export class LabStore {
  private v: Lab;
  private subs = new Set<(now: Lab, was: Lab) => void>();

  constructor(init: Partial<Lab> = {}, private key: string | null = null) {
    let saved: Partial<Lab> = {};
    if (key) {
      try {
        saved = valid(JSON.parse(localStorage.getItem(key) ?? "null"));
      } catch {
        /* nothing kept */
      }
    }
    this.v = { ...LAB_DEFAULT, ...init, ...saved };
  }

  get(): Lab {
    return this.v;
  }

  set(p: Partial<Lab>): void {
    const was = this.v;
    this.v = { ...was, ...valid(p) };
    if (this.key) {
      try {
        localStorage.setItem(this.key, JSON.stringify(this.v));
      } catch {
        /* kept for this session only */
      }
    }
    for (const f of this.subs) f(this.v, was);
  }

  on(f: (now: Lab, was: Lab) => void): () => void {
    this.subs.add(f);
    return () => this.subs.delete(f);
  }
}

/** The app's lab: every native pane follows it. */
export const labStore = new LabStore({}, "seamux.scrollLab");

/** One scroll, from its first wheel event to the last redraw it caused. */
export type Burst = {
  ms: number;
  /** xterm.js renders. */
  redraws: number;
  /** Frames the page took over 25 ms to give back (a 60 Hz frame is 16.7). */
  slow: number;
  worst: number;
  /** Messages of output from the PTY. */
  pieces: number;
  /** Wheel reports sent, and the writes that carried them. */
  reports: number;
  writes: number;
};

/** A scroll ends this long after the last thing it caused. */
const QUIET_MS = 300;
const SLOW_MS = 25;

/** Measures each scroll: started by a wheel event, kept open by what it
 *  causes (output, renders, writes), ended by a quiet moment. */
export class ScrollStats {
  onBurst: (b: Burst) => void = () => {};
  private b: Burst | null = null;
  private t0 = 0;
  private last = 0;
  private frameAt = 0;
  private raf = 0;

  wheel(): void {
    const now = performance.now();
    if (!this.b) {
      this.b = { ms: 0, redraws: 0, slow: 0, worst: 0, pieces: 0, reports: 0, writes: 0 };
      this.t0 = now;
      this.frameAt = now;
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
    this.last = now;
  }

  render(): void {
    if (!this.b) return;
    this.b.redraws++;
    this.last = performance.now();
  }

  piece(): void {
    if (!this.b) return;
    this.b.pieces++;
    this.last = performance.now();
  }

  wrote(reports: number): void {
    if (!this.b) return;
    this.b.reports += reports;
    this.b.writes++;
    this.last = performance.now();
  }

  private frame(t: number): void {
    const b = this.b;
    if (!b) return;
    const gap = t - this.frameAt;
    this.frameAt = t;
    if (gap > SLOW_MS) b.slow++;
    b.worst = Math.max(b.worst, gap);
    if (performance.now() - this.last > QUIET_MS) {
      b.ms = this.last - this.t0;
      this.b = null;
      this.onBurst(b);
      return;
    }
    this.raf = requestAnimationFrame((x) => this.frame(x));
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.b = null;
  }
}

const fmt = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "–");

/** The lab's panel: the three switches, and the last scroll's numbers. */
export class LabPanel {
  el = document.createElement("div");
  private stats = document.createElement("dl");
  private hint = document.createElement("p");
  private btns = new Map<string, HTMLButtonElement>();

  constructor(
    private store: LabStore,
    opts: { title?: string; closable?: boolean } = {},
  ) {
    this.el.className = "scroll-lab";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", opts.title ?? "Scroll lab");
    // The panel's own clicks and keys never reach the terminal under it.
    for (const k of ["mousedown", "mouseup", "click", "wheel", "keydown"]) this.el.addEventListener(k, (e) => e.stopPropagation());
    const head = document.createElement("div");
    head.className = "sl-head";
    const title = document.createElement("span");
    title.textContent = opts.title ?? "Scroll lab";
    head.append(title);
    if (opts.closable !== false) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "sl-close";
      close.setAttribute("aria-label", "Close the scroll lab (⌥⌘L)");
      close.innerHTML = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      close.addEventListener("click", () => this.toggle(false));
      head.append(close);
    }
    this.el.append(head);
    for (const k of Object.keys(CHOICES) as (keyof Lab)[]) {
      const row = document.createElement("div");
      row.className = "sl-row";
      const name = document.createElement("span");
      name.textContent = CHOICES[k].label;
      const seg = document.createElement("div");
      seg.className = "sl-seg";
      for (const [v, label, tip] of CHOICES[k].opts) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = tip;
        b.addEventListener("click", () => store.set({ [k]: v } as Partial<Lab>));
        this.btns.set(`${k}=${v}`, b);
        seg.append(b);
      }
      row.append(name, seg);
      this.el.append(row);
    }
    this.hint.className = "sl-hint";
    this.hint.textContent = "Scroll the pane to measure.";
    this.stats.className = "sl-stats";
    this.stats.hidden = true;
    this.el.append(this.hint, this.stats);
    store.on(() => this.mark());
    this.mark();
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  toggle(on = this.el.hidden): void {
    this.el.hidden = !on;
  }

  private mark(): void {
    const v = this.store.get();
    for (const [key, b] of this.btns) {
      const [k, x] = key.split("=");
      b.setAttribute("aria-pressed", String(v[k as keyof Lab] === x));
    }
  }

  /** The last scroll's numbers. */
  show(b: Burst): void {
    const secs = Math.max(b.ms, 1) / 1000;
    const rows: [string, string, string][] = [
      ["Scroll", `${fmt(secs, 1)} s`, "From the first wheel event to the last redraw it caused"],
      ["Redraws", `${fmt(b.redraws / secs)}/s`, "xterm.js renders per second"],
      ["Slow frames", `${b.slow}${b.slow ? ` · worst ${fmt(b.worst)} ms` : ""}`, `Frames over ${SLOW_MS} ms: the page was busy and the scroll stuttered`],
      ["Pieces/redraw", fmt(b.redraws ? b.pieces / b.redraws : NaN, 1), "PTY messages per render; over 1 means a frame can be drawn half-written"],
      ["Reports/write", fmt(b.writes ? b.reports / b.writes : NaN, 1), "Wheel reports per write to the pane; over 1 means they were batched"],
    ];
    this.stats.replaceChildren(
      ...rows.flatMap(([k, v, tip]) => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        dt.title = tip;
        const dd = document.createElement("dd");
        dd.textContent = v;
        dd.title = tip;
        if (k === "Slow frames" && b.slow) dd.className = "bad";
        return [dt, dd];
      }),
    );
    this.stats.hidden = false;
    this.hint.hidden = true;
  }
}
