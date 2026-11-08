import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Shown } from "./sheet";
import { splitter } from "./splitter";
import type { Row } from "./wake";

// The Wake's preview pane: the picked row's picture, video or page, beside
// the list or under it, with a strip of the rest to flip through. It never
// leaves the Wake: the list keeps its place, and the pick follows the pane.

/** The files the pane shows (wake_app.rs show_kind). */
export const PREVIEW = /\.(png|jpe?g|gif|webp|svg|html?|pdf|mp4|m4v|mov|webm)$/i;
/** Kinds that open their own way (a page, a review, a browser), whatever the path says. */
const OWN_WAY = ["plan", "review", "ask", "commit", "artifact"];

export type Media = "image" | "video" | "html" | "pdf";

export function mediaOf(path: string): Media | null {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["mp4", "m4v", "mov", "webm"].includes(ext)) return "video";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "pdf") return "pdf";
  return null;
}

/** Whether the pane can show this row itself. */
export function previewable(r: Row): boolean {
  return !!r.path && PREVIEW.test(r.path) && r.state !== "gone" && !OWN_WAY.includes(r.kind);
}

/** Where an image or video streams from: wake_app.rs's scheme, by row id. */
export function fileUrl(r: Row): string {
  return convertFileSrc(String(r.id), "wakefile");
}

/** The same, for the strip: the app refuses a big file, and the strip shows a tile. */
function thumbUrl(r: Row): string {
  const u = fileUrl(r);
  return u.startsWith("data:") ? u : `${u}?thumb`;
}

/** "side": the pane right of the list. "below": under it. */
type Layout = "side" | "below";
const LAYOUT_KEY = "seamux.wake.view";
/** Narrower than this, an unset layout puts the pane below. */
const SIDE_MIN = 760;

function kept(): Layout | null {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === "side" || v === "below" ? v : null;
  } catch {
    return null;
  }
}

function keep(v: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, v);
  } catch {
    /* a private window: the layout is only for now */
  }
}

const SVG = "http://www.w3.org/2000/svg";
function icon(d: string, fill = false): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  if (fill) svg.classList.add("fill");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}
const ICON = {
  prev: "M7.5 2.5 4 6l3.5 3.5",
  next: "M4.5 2.5 8 6l-3.5 3.5",
  side: "M1.5 2.5h9v7h-9zM6.5 2.5v7",
  below: "M1.5 2.5h9v7h-9zM1.5 6.5h9",
  full: "M2 4.5V2h2.5M7.5 2H10v2.5M10 7.5V10H7.5M4.5 10H2V7.5",
  unfull: "M4.5 2v2.5H2M10 4.5H7.5V2M7.5 10V7.5H10M2 7.5h2.5V10",
  tab: "M5 2.5H2.5v7h7V7M7 2.5h2.5V5M9.5 2.5 5.5 6.5",
  close: "M3 3l6 6M9 3 3 9",
  play: "M4 2.5v7l5.5-3.5z",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function tool(label: string, d: string, run: () => void): HTMLButtonElement {
  const b = el("button", "wv-btn");
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.append(icon(d));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

/** A strip button with no picture: a play mark for a video, and the extension. */
function tile(b: HTMLElement, kind: Media | null, file: string): void {
  b.classList.add("tile");
  if (kind === "video") b.append(icon(ICON.play, true));
  b.append(el("span", "", (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? kind ?? "").toLowerCase()));
}

export type ViewerHost = {
  /** The pane moved to `r` (a flip or a strip click): pick it in the list. */
  pick: (r: Row) => void;
  /** Open `r` as before the pane: a tab of the sheet, or cmux with ⌘. */
  openElsewhere: (r: Row, e?: MouseEvent) => void;
  closed: () => void;
  /** A line under the time: the row's prompt. */
  when: (r: Row) => string;
};

export class Viewer {
  readonly el = el("section", "wv");
  /** The handles between the list and the pane, one per layout. */
  readonly gripX = el("div", "wv-grip x");
  readonly gripY = el("div", "wv-grip y");
  private count = el("span", "wv-count");
  private name = el("span", "wv-name");
  private layoutBtn: HTMLButtonElement;
  private fullBtn: HTMLButtonElement;
  private stage = el("div", "wv-stage");
  private meta = el("div", "wv-meta");
  private strip = el("div", "wv-strip");
  private rows: Row[] = [];
  private stripSig = "";
  /** The row shown, kept even after a reload drops it from the list. */
  private cur: Row | null = null;
  private seq = 0;
  private layout: Layout | null = kept();
  private full = false;
  private fit = true;
  open = false;

  constructor(private root: HTMLElement, private host: ViewerHost) {
    this.el.setAttribute("aria-label", "preview");
    this.el.hidden = true;
    const prev = tool("previous (←)", ICON.prev, () => this.step(-1));
    const next = tool("next (→)", ICON.next, () => this.step(1));
    this.layoutBtn = tool("", ICON.side, () => this.flipLayout());
    this.fullBtn = tool("", ICON.full, () => this.toggleFull());
    const tab = tool("open in a tab (⌘-click: cmux)", ICON.tab, () => {});
    tab.addEventListener("click", (e) => this.cur && this.host.openElsewhere(this.cur, e));
    const close = tool("close the preview (Esc)", ICON.close, () => this.close());
    const bar = el("header", "wv-bar");
    bar.append(prev, this.count, next, this.name, this.layoutBtn, this.fullBtn, tab, close);
    this.strip.setAttribute("role", "listbox");
    this.strip.setAttribute("aria-label", "previews");
    // A wheel flips the strip sideways: it has no other way to scroll.
    this.strip.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      this.strip.scrollLeft += e.deltaY;
      e.preventDefault();
    });
    this.el.append(bar, this.stage, this.meta, this.strip);
    this.gripX.hidden = this.gripY.hidden = true;
    const frac = (v: number) => `${Math.round(v * 1000) / 10}%`;
    splitter(this.gripX, {
      zone: "wake-view-x", axis: "x", label: "the preview's width", min: 0.25, max: 0.8, initial: 0.55, step: 0.02,
      from: (x) => -x / Math.max(1, this.root.clientWidth),
      apply: (v) => this.root.style.setProperty("--wv-x", frac(v)),
      measure: () => this.el.offsetWidth / Math.max(1, this.root.clientWidth),
    });
    splitter(this.gripY, {
      zone: "wake-view-y", axis: "y", label: "the preview's height", min: 0.25, max: 0.85, initial: 0.55, step: 0.02,
      from: (y) => -y / Math.max(1, this.root.clientHeight),
      apply: (v) => this.root.style.setProperty("--wv-y", frac(v)),
      measure: () => this.el.offsetHeight / Math.max(1, this.root.clientHeight),
    });
    // An unset layout follows the width: side when there is room, else below.
    new ResizeObserver(() => this.open && !this.layout && this.applyLayout()).observe(root);
  }

  /** Show `r`, with `rows` (the list's previewable rows, in its order) in the strip. */
  show(rows: Row[], r: Row | null): void {
    const was = this.open;
    this.open = true;
    this.el.hidden = false;
    this.root.classList.add("viewing");
    if (!was) this.applyLayout();
    this.setRows(rows);
    this.render(r);
  }

  /** The list redrew: the strip follows it, the shown row stays. */
  setRows(rows: Row[]): void {
    this.rows = rows;
    const sig = rows.map((r) => r.id).join(",");
    if (sig !== this.stripSig) {
      this.stripSig = sig;
      this.drawStrip();
    }
    this.mark();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.seq++;
    this.el.hidden = true;
    this.gripX.hidden = this.gripY.hidden = true;
    this.root.classList.remove("viewing", "side", "below", "full");
    this.full = false;
    this.stage.replaceChildren(); // a playing video stops
    this.cur = null;
    this.host.closed();
  }

  /** The next or previous previewable row, wrapping. */
  step(by: 1 | -1): void {
    if (!this.rows.length) return;
    const i = this.cur ? this.rows.findIndex((r) => r.id === this.cur!.id) : -1;
    const to = i < 0 ? (by > 0 ? 0 : this.rows.length - 1) : (i + by + this.rows.length) % this.rows.length;
    this.host.pick(this.rows[to]);
  }

  toggleFull(): void {
    this.full = !this.full;
    this.applyLayout();
  }

  flipLayout(): void {
    this.layout = this.side() ? "below" : "side";
    keep(this.layout);
    this.applyLayout();
  }

  private side(): boolean {
    return (this.layout ?? (this.root.clientWidth >= SIDE_MIN ? "side" : "below")) === "side";
  }

  private applyLayout(): void {
    const side = this.side();
    this.root.classList.toggle("side", side);
    this.root.classList.toggle("below", !side);
    this.root.classList.toggle("full", this.full);
    this.gripX.hidden = !side || this.full;
    this.gripY.hidden = side || this.full;
    const to = side ? "below" : "beside";
    this.layoutBtn.title = `put the preview ${to} the list (v)`;
    this.layoutBtn.setAttribute("aria-label", this.layoutBtn.title);
    this.layoutBtn.replaceChildren(icon(side ? ICON.below : ICON.side));
    this.fullBtn.title = this.full ? "show the list again (f)" : "fill the Wake with the preview (f)";
    this.fullBtn.setAttribute("aria-label", this.fullBtn.title);
    this.fullBtn.replaceChildren(icon(this.full ? ICON.unfull : ICON.full));
  }

  /** Draw `r` on the stage; a row with no preview says how to open it. */
  render(r: Row | null): void {
    // The same row again keeps what is shown, unless that was a note (a
    // failure or "loading…"): picking it again retries.
    if (r && this.cur && r.id === this.cur.id && this.stage.childElementCount && !this.stage.querySelector(".wv-note")) return this.mark();
    const seq = ++this.seq;
    this.cur = r;
    this.fit = true;
    this.mark();
    if (!r) {
      this.name.textContent = "";
      this.meta.textContent = "";
      this.stage.replaceChildren(el("p", "wv-note", "Pick a row to preview it here. ← and → flip through the pictures, videos and pages."));
      return;
    }
    const file = r.path.split("/").pop() || r.title;
    this.name.textContent = r.title || file;
    this.name.title = r.path;
    this.meta.textContent = this.host.when(r);
    this.meta.title = r.prompt;
    if (!previewable(r)) {
      const n = el("p", "wv-note", r.state === "gone" ? `${file} is gone.` : `No preview for ${/^[aeiou]/.test(r.kind) ? "an" : "a"} ${r.kind}. Enter opens it.`);
      this.stage.replaceChildren(n);
      return;
    }
    const failed = (why: string) => {
      if (seq !== this.seq) return;
      const n = el("p", "wv-note", `${file} could not be shown here (${why}). `);
      const b = el("button", "w-act", "open it elsewhere");
      b.type = "button";
      b.addEventListener("click", (e) => this.host.openElsewhere(r, e));
      n.append(b);
      this.stage.replaceChildren(n);
    };
    const kind = mediaOf(r.path);
    if (kind === "image") {
      const img = el("img", "wv-img");
      img.alt = file;
      img.decoding = "async";
      img.src = fileUrl(r);
      img.addEventListener("error", () => failed("it did not load"));
      // A click swaps fitting the pane for the picture's own size.
      img.addEventListener("click", () => {
        this.fit = !this.fit;
        this.stage.classList.toggle("actual", !this.fit);
      });
      this.stage.classList.remove("actual");
      this.stage.replaceChildren(img);
    } else if (kind === "video") {
      const v = el("video", "wv-video");
      v.controls = true;
      v.preload = "metadata";
      v.playsInline = true;
      v.src = fileUrl(r);
      v.addEventListener("error", () => failed("this video's format may not play in the app"));
      this.stage.classList.remove("actual");
      this.stage.replaceChildren(v);
    } else {
      // Pages travel as a data: URL, framed with scripts off (as the sheet does).
      this.stage.classList.remove("actual");
      this.stage.replaceChildren(el("p", "wv-note", "loading…"));
      invoke<Shown>("wake_file", { id: r.id }).then((s) => {
        if (seq !== this.seq) return;
        const f = el("iframe", "wv-frame");
        f.title = file;
        if (s.kind === "html") {
          f.setAttribute("sandbox", "");
          const bin = atob(s.data.slice(s.data.indexOf(",") + 1));
          f.srcdoc = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        } else f.src = s.data;
        this.stage.replaceChildren(f);
      }, (e) => failed(String(e)));
    }
  }

  private drawStrip(): void {
    this.strip.replaceChildren(
      ...this.rows.map((r) => {
        const b = el("button", "wv-thumb");
        b.type = "button";
        b.dataset.id = String(r.id);
        b.setAttribute("role", "option");
        const file = r.path.split("/").pop() || r.title;
        b.title = file;
        const kind = mediaOf(r.path);
        if (kind === "image") {
          const img = el("img");
          img.loading = "lazy";
          img.decoding = "async";
          img.alt = "";
          img.src = thumbUrl(r);
          // Too big for a thumbnail (or unreadable): the tile instead.
          img.addEventListener("error", () => {
            img.remove();
            tile(b, kind, file);
          });
          b.append(img);
        } else tile(b, kind, file);
        b.addEventListener("click", () => this.host.pick(r));
        return b;
      }),
    );
    this.strip.hidden = this.rows.length < 2;
  }

  /** The counter and the strip's pick, for the row shown. */
  private mark(): void {
    const i = this.cur ? this.rows.findIndex((r) => r.id === this.cur!.id) : -1;
    this.count.textContent = `${i < 0 ? "–" : i + 1} / ${this.rows.length}`;
    for (const t of this.strip.querySelectorAll<HTMLElement>(".wv-thumb")) {
      const on = !!this.cur && t.dataset.id === String(this.cur.id);
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
      if (on) t.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
}
