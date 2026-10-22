import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reflow } from "./reflow";
import type { Frame as WallFrame, Tile } from "./wall";
import { Wake } from "./wake";

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

/** views.rs NowPage: a page a workspace has open now. */
export type NowPage = { ws: string; kind: string; path: string; label: string; state: string; waiting: boolean; since: number };

/** One tab on the sheet's page side: the Wake, a page, or a file shown here. */
type Tab = {
  key: string;
  kind: string;
  label: string;
  state: string;
  waiting: boolean;
  /** From the workspace's open pages, rather than opened by hand. */
  now: boolean;
  /** Made on first show and kept, so a swap is instant and keeps its scroll. */
  el: HTMLElement | null;
  page?: Page;
  shown?: Shown;
  toCmux?: (() => Promise<unknown>) | null;
};

const WAKE = "wake";

/** A sheet over the current view: the page beside its agent's live chat.
 *  The page side has tabs: the workspace's Wake, then its open plan, lookout
 *  reviews and asks, then anything else opened here. ⌘E shows the Wake and
 *  goes back; ⌘] and ⌘[ step through the tabs; 1–9 pick one. Escape closes. */
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
  private tabsEl = document.createElement("div");
  private stack = document.createElement("div");
  private tabs: Tab[] = [];
  private active = "";
  /** The tab before the Wake, for ⌘E to go back to. */
  private back = "";
  private pages: NowPage[] = [];
  private wake: Wake | null = null;
  private origin: string | null = null;

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
    this.tabsEl.className = "sheet-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.stack.className = "sheet-stack";
    this.pageEl.append(this.tabsEl, this.stack);
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

  /** Follow the panes, so the chat beside a page stays live, and each
   *  workspace's open pages, for the tabs. */
  async start(): Promise<void> {
    await listen<WallFrame>("wall:frame", (e) => {
      this.tiles = e.payload.tiles;
      if (!this.el.hidden) this.drawChat();
    });
    await listen<{ pages?: NowPage[] }>("views:frame", (e) => {
      const pages = e.payload.pages ?? [];
      if (JSON.stringify(pages) === JSON.stringify(this.pages)) return;
      this.pages = pages;
      if (!this.el.hidden) this.syncTabs();
    });
    // shell.rs's keys: they work with focus in a framed page too.
    await listen<string>("sheet:key", (e) => {
      if (this.el.hidden) return;
      if (e.payload === "wake") this.toggleWake();
      else this.step(e.payload === "next" ? 1 : -1);
    });
    // 1–9 pick a page tab while focus is in the shell (a framed page keeps its own keys).
    document.addEventListener("keydown", (e) => {
      if (this.el.hidden || e.metaKey || e.ctrlKey || e.altKey || !(e.key >= "1" && e.key <= "9")) return;
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || at instanceof HTMLSelectElement) return;
      const t = this.tabs.filter((x) => x.key !== WAKE)[Number(e.key) - 1];
      if (t) {
        this.select(t.key);
        e.preventDefault();
      }
    });
    // Frames go out only on change: start from the latest one.
    const [f, v] = await Promise.all([invoke<WallFrame | null>("wall_frame"), invoke<{ pages?: NowPage[] } | null>("views_frame")]);
    if (f) this.tiles = f.tiles;
    if (v?.pages) this.pages = v.pages;
    if (!this.el.hidden) {
      this.drawChat();
      this.syncTabs();
    }
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

  /** The cmux workspace the sheet is for: named, or the agent's in its directory. */
  private workspace(): string {
    return this.place.workspace ?? this.tile()?.workspace ?? "";
  }

  /** The worktree directory, for the Wake: named, else the agent's cwd. */
  private dir(): string {
    return this.place.dir ?? this.tile()?.cwd ?? "";
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
    this.enter(place);
    const key = `file:${s.title}`;
    this.drop(key);
    this.tabs.push({ key, kind: "file", label: s.title, state: "", waiting: false, now: false, el: null, shown: s, toCmux });
    this.select(key);
  }

  async open(p: Page): Promise<void> {
    this.enter({ workspace: p.workspace, dir: p.dir });
    const t = this.tabs.find((x) => x.key === p.path);
    if (t) {
      t.page = p;
      t.toCmux = p.toCmux ?? null;
    } else this.tabs.push({ key: p.path, kind: kindOf(p.path), label: p.title, state: "", waiting: false, now: false, el: null, page: p, toCmux: p.toCmux ?? null });
    this.select(p.path);
  }

  /** Open the sheet for a place: another place starts its tabs afresh. */
  private enter(place: { workspace?: string; dir?: string }): void {
    // The same workspace is the same place, however a caller names it.
    const where = () => this.workspace() || this.dir();
    const was = this.el.hidden ? null : where();
    this.place = place;
    if (was !== where()) this.reset();
    this.drawChat();
    this.say.textContent = "";
    this.el.hidden = false;
    this.syncTabs();
  }

  private drop(key: string): void {
    const t = this.tabs.find((x) => x.key === key);
    t?.el?.remove();
    this.tabs = this.tabs.filter((x) => x.key !== key);
  }

  private reset(): void {
    for (const t of this.tabs) if (t.key !== WAKE) t.el?.remove();
    this.tabs = this.tabs.filter((t) => t.key === WAKE);
    this.active = "";
    this.back = "";
  }

  /** The tabs: the Wake, this workspace's open pages, then the rest opened here. */
  private syncTabs(): void {
    const ws = this.workspace();
    const wake: Tab = this.tabs.find((t) => t.key === WAKE) ?? { key: WAKE, kind: WAKE, label: "Wake", state: "", waiting: false, now: false, el: null };
    const live = this.pages
      .filter((p) => p.ws === ws)
      .map((p): Tab => {
        const had = this.tabs.find((t) => t.key === p.path);
        return {
          key: p.path, kind: p.kind, label: p.label, state: p.state, waiting: p.waiting, now: true, el: had?.el ?? null,
          page: had?.page ?? { path: p.path, title: p.label, workspace: ws }, toCmux: had?.toCmux ?? null,
        };
      });
    // A page that left the list (answered, closed) keeps its tab while it is shown.
    const rest = this.tabs.filter((t) => t.key !== WAKE && !live.some((l) => l.key === t.key) && (!t.now || t.key === this.active));
    for (const t of this.tabs) if (t.key !== WAKE && !live.some((l) => l.key === t.key) && !rest.includes(t)) t.el?.remove();
    this.tabs = [wake, ...live, ...rest.map((t) => ({ ...t, waiting: false }))];
    this.drawTabs();
  }

  private drawTabs(): void {
    let n = 0;
    this.tabsEl.replaceChildren(
      ...this.tabs.map((t) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `sheet-tab tk-${t.kind}` + (t.key === this.active ? " on" : "") + (t.waiting ? " waiting" : "");
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(t.key === this.active));
        const key = document.createElement("kbd");
        key.textContent = t.key === WAKE ? "⌘E" : ++n <= 9 ? String(n) : "";
        b.append(key);
        if (t.key !== WAKE) {
          const kind = document.createElement("span");
          kind.className = "sheet-tab-kind";
          kind.textContent = t.kind === "review" ? "lookout" : t.kind;
          b.append(kind);
        }
        const name = document.createElement("span");
        name.className = "sheet-tab-name";
        name.textContent = t.label;
        b.append(name);
        if (t.state) {
          const st = document.createElement("span");
          st.className = "sheet-tab-state";
          st.textContent = t.state;
          b.append(st);
        }
        if (t.waiting) {
          const dot = document.createElement("i");
          dot.className = "sheet-tab-dot";
          dot.setAttribute("aria-label", "waiting on you");
          b.append(dot);
        }
        b.title = t.key === WAKE ? "This workspace's Wake (⌘E)" : `${t.label}${t.state ? " · " + t.state : ""}`;
        b.addEventListener("click", () => this.select(t.key));
        return b;
      }),
    );
  }

  /** ⌘E: the Wake, or back to the tab before it. */
  private toggleWake(): void {
    if (this.active === WAKE) {
      const back = this.tabs.find((t) => t.key === this.back) ?? this.tabs.find((t) => t.key !== WAKE);
      if (back) this.select(back.key);
    } else this.select(WAKE);
  }

  private step(by: number): void {
    if (!this.tabs.length) return;
    const i = Math.max(0, this.tabs.findIndex((t) => t.key === this.active));
    this.select(this.tabs[(i + by + this.tabs.length) % this.tabs.length].key);
  }

  private select(key: string): void {
    const t = this.tabs.find((x) => x.key === key);
    if (!t) return;
    if (key === WAKE && this.active && this.active !== WAKE) this.back = this.active;
    this.active = key;
    this.page = t.page ?? null;
    this.toCmuxFn = t.toCmux ?? null;
    this.titleEl.textContent = t.key === WAKE ? `the wake · ${this.dir().split("/").pop() ?? ""}` : t.label;
    this.say.textContent = "";
    // A page that could not load (the server was down) tries again.
    if (t.el?.dataset.failed) {
      t.el.remove();
      t.el = null;
    }
    if (!t.el) this.build(t);
    for (const x of this.tabs) if (x.el) x.el.hidden = x.key !== key;
    if (key === WAKE) this.wakeView().showDir(this.dir());
    this.drawTabs();
  }

  private wakeView(): Wake {
    if (!this.wake) {
      const root = document.createElement("div");
      root.className = "sheet-wake";
      this.wake = new Wake(root, { embedded: true });
      void this.wake.start();
      this.stack.append(root);
    }
    const t = this.tabs.find((x) => x.key === WAKE);
    if (t) t.el = this.wake.root;
    return this.wake;
  }

  /** Make a tab's content: the Wake, a framed page, or a file shown here. */
  private build(t: Tab): void {
    if (t.key === WAKE) {
      this.wakeView();
      return;
    }
    const box = document.createElement("div");
    box.className = "sheet-pane";
    t.el = box;
    this.stack.append(box);
    const s = t.shown;
    if (s) {
      if (s.kind === "image") {
        const img = document.createElement("img");
        img.className = "sheet-img";
        img.alt = s.title;
        img.src = s.data;
        const ib = document.createElement("div");
        ib.className = "sheet-imgbox";
        ib.append(img);
        box.append(ib);
      } else {
        const frame = document.createElement("iframe");
        frame.title = s.title;
        if (s.kind === "html") {
          // No scripts, no forms, no top navigation: a page to look at.
          frame.setAttribute("sandbox", "");
          const bin = atob(s.data.slice(s.data.indexOf(",") + 1));
          frame.srcdoc = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        } else frame.src = s.data;
        box.append(frame);
      }
      return;
    }
    const frame = (origin: string) => {
      const f = document.createElement("iframe");
      f.src = origin + t.key;
      f.title = t.label;
      box.append(f);
    };
    if (this.origin) return frame(this.origin);
    void invoke<IntentServer>("intent_server").then((server) => {
      if (!server.up || !server.origin) {
        const n = document.createElement("p");
        n.className = "note";
        n.textContent = `The intent server is down (${server.reason ?? "no answer"}), so this page can't be shown here. Open in cmux may still work once it is back.`;
        box.append(n);
        box.dataset.failed = "1";
        return;
      }
      this.origin = server.origin;
      frame(server.origin);
    });
  }

  close(): void {
    this.el.hidden = true;
    this.page = null;
    this.toCmuxFn = null;
    this.reset();
    this.place = {};
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

function kindOf(path: string): string {
  return path.startsWith("/review/") ? "review" : path.startsWith("/ask/") ? "ask" : path.startsWith("/plan/") ? "plan" : "page";
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
