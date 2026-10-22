import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reflow } from "./reflow";
import type { Frame as WallFrame, Tile } from "./wall";

type IntentServer = { origin: string | null; up: boolean; reason: string | null };

/** An intent-server page: a plan, a review or an ask. */
export type Page = {
  /** /plan/<slug>, /review/<id> or /ask/<id>. */
  path: string;
  title: string;
  /** The cmux workspace it belongs to: its agent's chat shows beside the page, and Open in cmux goes there. */
  workspace?: string;
  /** A worktree directory, when the workspace is not known (a Wake row): the pane working in it. */
  dir?: string;
  /** What Open in cmux does instead of open_in_cmux (the Wake opens its rows its own way). */
  toCmux?: () => Promise<unknown>;
};

/** A file the sheet shows itself: an image, a sandboxed HTML page or a PDF. */
export type Shown = { kind: "image" | "html" | "pdf"; title: string; data: string };

const SVG = "http://www.w3.org/2000/svg";

function mark(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}

/** Where the page sits beside the chat: the chat's share of the width. */
const SPLIT_KEY = "seamux.sheet.chat";
function savedSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v > 0.15 && v < 0.75 ? v : 0.38;
  } catch {
    return 0.38;
  }
}

/** The agent's chat beside a page: its last words, live, with reply and Jump. */
class Chat {
  el = document.createElement("section");
  private name = document.createElement("b");
  private state = document.createElement("span");
  private body = document.createElement("div");
  private input = document.createElement("input");
  private note = document.createElement("span");
  surface = "";
  private last = "";

  constructor() {
    this.el.className = "sheet-chat";
    const head = document.createElement("header");
    head.append(this.name, this.state);
    this.body.className = "sheet-chat-body";
    const form = document.createElement("form");
    form.className = "sheet-chat-reply";
    this.input.type = "text";
    this.input.placeholder = "Reply…";
    this.input.spellcheck = false;
    this.input.addEventListener("keydown", (e) => e.stopPropagation());
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "sheet-btn";
    jump.textContent = "Jump ↗";
    jump.addEventListener("click", async () => {
      try {
        await invoke("wall_jump", { surfaceId: this.surface });
        await invoke("hide_overlay");
      } catch (e) {
        this.note.textContent = String(e);
      }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = this.input.value;
      if (!text.trim()) return;
      try {
        await invoke("wall_reply", { surfaceId: this.surface, text });
        this.input.value = "";
        this.note.textContent = "Sent";
      } catch (err) {
        this.note.textContent = String(err);
      }
    });
    this.note.className = "sheet-chat-note";
    form.append(this.input, jump);
    this.el.append(head, this.body, form, this.note);
  }

  show(t: Tile): void {
    this.surface = t.surface;
    this.name.textContent = t.workspace_title || t.label;
    this.state.textContent = t.state.replace("_", " ");
    this.state.className = `sheet-chat-state ${t.state}`;
    const text = t.lines.join("\n");
    if (text === this.last) return;
    this.last = text;
    const b = this.body;
    const atEnd = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
    b.replaceChildren(
      ...reflow(t.lines.slice(-80)).map((x) => {
        const ln = document.createElement("div");
        ln.className = "ln";
        ln.style.paddingLeft = `${x.start}ch`;
        ln.style.textIndent = `-${x.hang}ch`;
        ln.textContent = x.text || " ";
        return ln;
      }),
    );
    if (atEnd) requestAnimationFrame(() => (b.scrollTop = b.scrollHeight));
  }
}

/** A sheet over the current view: the page, beside its agent's live chat
 * when it has one. Escape closes it. */
export class Sheet {
  el = document.createElement("div");
  private card = document.createElement("div");
  private titleEl = document.createElement("span");
  private body = document.createElement("div");
  private pageEl = document.createElement("div");
  private divider = document.createElement("div");
  private chat = new Chat();
  private say = document.createElement("span");
  private page: Page | null = null;
  private toCmuxFn: (() => Promise<unknown>) | null = null;
  private tiles: Tile[] = [];
  /** The page's workspace and directory, for the chat beside it. */
  private place: { workspace?: string; dir?: string } = {};

  constructor() {
    this.el.className = "sheet";
    this.el.hidden = true;
    this.card.className = "sheet-card";
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-modal", "true");
    const head = document.createElement("header");
    this.titleEl.className = "sheet-title";
    this.say.className = "sheet-say";
    const cmux = document.createElement("button");
    cmux.type = "button";
    cmux.className = "sheet-btn";
    cmux.title = "Open beside its terminal in cmux (⌘-click does this too)";
    cmux.append(document.createTextNode("Open in cmux "), mark("M3 7 7 3M4 3h3v3"));
    cmux.addEventListener("click", () => void this.toCmux());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "sheet-btn icon";
    close.setAttribute("aria-label", "Close");
    close.append(mark("M2.5 2.5l5 5M7.5 2.5l-5 5"));
    close.addEventListener("click", () => this.close());
    head.append(this.titleEl, this.say, cmux, close);
    this.body.className = "sheet-body";
    this.pageEl.className = "sheet-page";
    this.divider.className = "sheet-divider";
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-label", "Drag to resize the chat");
    this.divider.addEventListener("pointerdown", (e) => this.drag(e));
    this.body.append(this.chat.el, this.divider, this.pageEl);
    this.body.style.setProperty("--chat", String(savedSplit()));
    this.card.append(head, this.body);
    this.el.append(this.card);
    // A click on the dimmed backdrop closes; one inside the card does not.
    this.el.addEventListener("click", (e) => e.target === this.el && this.close());
    // Capture, so the window's own Escape (hide) waits for the sheet.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !this.el.hidden) {
          this.close();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Follow the panes, so the chat beside a page stays live. */
  async start(): Promise<void> {
    await listen<WallFrame>("wall:frame", (e) => {
      this.tiles = e.payload.tiles;
      if (!this.el.hidden) this.drawChat();
    });
    const f = await invoke<WallFrame | null>("wall_frame");
    if (f) this.tiles = f.tiles;
  }

  /** The agent pane for the page's workspace (or the one working in its directory). */
  private tile(): Tile | undefined {
    const { workspace, dir } = this.place;
    const agents = this.tiles.filter((t) => t.agent && t.state !== "ended");
    if (workspace) return agents.find((t) => t.workspace === workspace);
    if (dir) {
      const d = dir.replace(/\/+$/, "");
      return agents.find((t) => t.cwd === d || t.cwd.startsWith(d + "/"));
    }
    return undefined;
  }

  private drawChat(): void {
    const t = this.tile();
    this.body.classList.toggle("with-chat", !!t);
    if (t) this.chat.show(t);
  }

  private drag(e: PointerEvent): void {
    e.preventDefault();
    const box = this.body.getBoundingClientRect();
    const move = (m: PointerEvent) => {
      const share = Math.min(0.7, Math.max(0.2, (m.clientX - box.left) / box.width));
      this.body.style.setProperty("--chat", String(share));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(SPLIT_KEY, this.body.style.getPropertyValue("--chat"));
      } catch {
        /* a private window: the split is only for now */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /** Show a file's content: images as an image, HTML with scripts off, PDFs framed. */
  show(s: Shown, toCmux: () => Promise<unknown>, place: { workspace?: string; dir?: string } = {}): void {
    this.page = null;
    this.toCmuxFn = toCmux;
    this.place = place;
    this.drawChat();
    this.titleEl.textContent = s.title;
    this.say.textContent = "";
    this.el.hidden = false;
    if (s.kind === "image") {
      const img = document.createElement("img");
      img.className = "sheet-img";
      img.alt = s.title;
      img.src = s.data;
      const box = document.createElement("div");
      box.className = "sheet-imgbox";
      box.append(img);
      this.pageEl.replaceChildren(box);
    } else {
      const frame = document.createElement("iframe");
      frame.title = s.title;
      if (s.kind === "html") {
        // No scripts, no forms, no top navigation: a page to look at.
        frame.setAttribute("sandbox", "");
        const bin = atob(s.data.slice(s.data.indexOf(",") + 1));
        frame.srcdoc = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      } else frame.src = s.data;
      this.pageEl.replaceChildren(frame);
    }
  }

  async open(p: Page): Promise<void> {
    this.page = p;
    this.toCmuxFn = p.toCmux ?? null;
    this.place = { workspace: p.workspace, dir: p.dir };
    this.drawChat();
    this.titleEl.textContent = p.title;
    this.say.textContent = "";
    this.el.hidden = false;
    const server = await invoke<IntentServer>("intent_server");
    if (this.page !== p) return;
    if (!server.up || !server.origin) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = `The intent server is down (${server.reason ?? "no answer"}), so this page can't be shown here. Open in cmux may still work once it is back.`;
      this.pageEl.replaceChildren(n);
      return;
    }
    const frame = document.createElement("iframe");
    frame.src = server.origin + p.path;
    frame.title = p.title;
    this.pageEl.replaceChildren(frame);
  }

  close(): void {
    this.el.hidden = true;
    this.page = null;
    this.toCmuxFn = null;
    this.place = {};
    this.pageEl.replaceChildren();
  }

  private async toCmux(): Promise<void> {
    if (!this.page && !this.toCmuxFn) return;
    try {
      if (this.toCmuxFn) await this.toCmuxFn();
      else if (this.page) await openInCmux(this.page);
      this.close();
    } catch (e) {
      this.say.textContent = String(e);
    }
  }
}

export function openInCmux(p: Page): Promise<void> {
  return invoke("open_in_cmux", { path: p.path, workspace: p.workspace ?? null });
}

let shared: Sheet | null = null;

/** The app's one sheet, made on first use and put over the stage. */
export function sheet(): Sheet {
  if (!shared) {
    shared = new Sheet();
    document.body.append(shared.el);
    void shared.start();
  }
  return shared;
}

/** Open a page: in the sheet, or in cmux on a ⌘-click. Returns an error to show, if any. */
export async function openPage(p: Page, e?: MouseEvent | KeyboardEvent): Promise<string | null> {
  if (e?.metaKey) {
    try {
      await openInCmux(p);
      return null;
    } catch (err) {
      return String(err);
    }
  }
  await sheet().open(p);
  return null;
}
