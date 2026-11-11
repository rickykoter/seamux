// Where a native pane's links go:
//   - seamux's own pages (plans, reviews, asks, agents, runs), on the intent
//     server or a plugin's own port, open in the Dock;
//   - other localhost pages (a dev server) open as a tab in the Dock;
//   - images, PDFs and Markdown files open in the Dock, other files in VS
//     Code at their line (Shift-click sends any file to VS Code);
//   - every other web link opens in the browser, and GitHub pull requests
//     and issues show a card on hover.
// native.ts finds the links; this follows them.
import { invoke } from "@tauri-apps/api/core";
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { findBangs } from "./bang";
import { DOCK_FILE, route } from "./linkroute";
import { openPage, sheet, type Shown } from "./sheet";

/** A link under the pointer: the text it shows on its row, and how to
 *  follow it (`e` is the click, for its modifier keys). */
export type Hovered = { y: number; label: string; uri: string; go: (e?: MouseEvent) => void };

/** The workspace a pane's terminal is in, for a page or tab it opens. */
async function placeOf(id: number | null): Promise<string | undefined> {
  if (id === null) return undefined;
  return (await invoke<string | null>("pty_workspace", { id }).catch(() => null)) ?? undefined;
}

/** Open a file a pane links to: in the Dock if it is one to look at,
 *  else (or with Shift) in VS Code at its line. */
export async function openFile(path: string, at: { line?: number; col?: number }, id: number | null, e?: MouseEvent): Promise<void> {
  const editor = () => invoke("open_in_editor", { path, line: at.line ?? null, col: at.col ?? null }).catch(() => {});
  if (e?.shiftKey || !DOCK_FILE.test(path)) return void (await editor());
  const shown = await invoke<Shown>("link_file", { path }).catch(() => null);
  if (!shown) return void (await editor());
  sheet().show(shown, editor, { workspace: await placeOf(id) });
}

/** Path-like text: led by /, ~/, ./ or ../, or a name with a dot extension,
 *  then an optional :line and :col. What is not on disk never becomes a link. */
const PATH_RE = /(?<![\w./~@+-])((?:~\/|\.{1,2}\/|\/)[\w@.+-]+(?:\/[\w@.+-]+)*|(?:[\w@+-][\w@.+-]*\/)*[\w@+-][\w@+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d+)(?::(\d+))?)?/g;

/** A row's text, and each character's column (1-based): wide characters
 *  take two cells, so text offsets are not columns. */
function rowText(line: IBufferLine, cols: number): { text: string; col: number[] } {
  const r = rowCells(line, cols);
  return { text: r.text, col: r.col };
}

/** A row's text with, per character, its column (1-based), its colour (as
 *  a key), and the offset from which everything shown is dim (a
 *  placeholder's), or -1. */
export function rowCells(line: IBufferLine, cols: number): { text: string; col: number[]; style: string[]; dimFrom: number } {
  let text = "";
  const col: number[] = [];
  const style: string[] = [];
  let dimFrom = -1;
  for (let x = 0; x < cols; x++) {
    const c = line.getCell(x);
    if (!c || c.getWidth() === 0) continue;
    const ch = c.getChars() || " ";
    const key = `${c.getFgColorMode()}:${c.getFgColor()}`;
    if (ch !== " ") {
      if (c.isDim()) {
        if (dimFrom < 0) dimFrom = text.length;
      } else dimFrom = -1;
    }
    for (let i = 0; i < ch.length; i++) {
      col.push(x + 1);
      style.push(key);
    }
    text += ch;
  }
  return { text, col, style, dimFrom };
}

/** Rows `from` to `to` (0-based buffer lines) as text, with their dim offsets. */
export function screenRows(term: Terminal, from: number, to: number): { rows: string[]; dim: number[] } {
  const rows: string[] = [];
  const dim: number[] = [];
  for (let y = from; y < to; y++) {
    const line = term.buffer.active.getLine(y);
    const r = line ? rowCells(line, term.cols) : { text: "", dimFrom: -1 };
    rows.push(r.text);
    dim.push(r.dimFrom);
  }
  return { rows, dim };
}

/** `!` commands in the pane's text, as links that show the run menu.
 *  `promptRow` is the buffer row (1-based) of Claude's prompt, which the
 *  pane offers its own way, or -1. */
export function bangLinks(term: Terminal, promptRow: () => number, hover: (h: Hovered | null, cmd: string, e?: MouseEvent) => void, pin: (cmd: string, e?: MouseEvent) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line || y === promptRow()) return callback(undefined);
      const { text, col, style } = rowCells(line, term.cols);
      if (!text.includes("!")) return callback(undefined);
      const links: ILink[] = findBangs(text, style).map((b) => {
        const label = text.slice(b.start, b.end);
        const go = (e?: MouseEvent) => pin(b.cmd, e);
        return {
          range: { start: { x: col[b.start], y }, end: { x: col[b.end - 1], y } },
          text: label,
          decorations: { underline: true, pointerCursor: true },
          activate: (e) => go(e),
          hover: (e) => hover({ y, label, uri: b.cmd, go }, b.cmd, e),
          leave: () => hover(null, b.cmd),
        };
      });
      callback(links.length ? links : undefined);
    },
  };
}

/** What pty_paths said of a candidate, kept a little while (the pane's
 *  folder can change). Keyed by terminal and text: two panes in different
 *  folders read the same text differently. */
const known = new Map<string, { abs: string | null; at: number }>();
const KNOWN_MS = 15_000;

/** File paths in the pane's text, as links that open in VS Code. `id` is
 *  the pane's terminal (null while detached); `hover` hears the pointer. */
export function pathLinks(term: Terminal, id: () => number | null, hover: (h: Hovered | null) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const tid = id();
      const line = term.buffer.active.getLine(y - 1);
      if (tid === null || !line) return callback(undefined);
      const { text, col } = rowText(line, term.cols);
      const found: { start: number; end: number; path: string; line?: number; col?: number }[] = [];
      for (const m of text.matchAll(PATH_RE)) {
        const path = m[1].replace(/\.+$/, "");
        // A web address's tail (host.tld/...) is the web link's, not a path.
        if (!path || /:\/\/$/.test(text.slice(0, m.index))) continue;
        const shown = m[0].slice(0, m[1].length === path.length ? undefined : path.length);
        found.push({ start: m.index, end: m.index + shown.length, path, line: m[2] ? +m[2] : undefined, col: m[3] ? +m[3] : undefined });
      }
      if (!found.length) return callback(undefined);
      const now = performance.now();
      const key = (p: string) => `${tid}\u0000${p}`;
      const ask = [...new Set(found.map((f) => f.path))].filter((p) => !(known.get(key(p)) && now - known.get(key(p))!.at < KNOWN_MS));
      const ready = ask.length
        ? invoke<(string | null)[]>("pty_paths", { id: tid, paths: ask }).then((r) => ask.forEach((p, i) => known.set(key(p), { abs: r[i] ?? null, at: now })))
        : Promise.resolve();
      void ready
        .catch(() => {})
        .then(() => {
          const links: ILink[] = [];
          for (const f of found) {
            const abs = known.get(key(f.path))?.abs;
            if (!abs) continue;
            const label = text.slice(f.start, f.end);
            const go = (e?: MouseEvent) => void openFile(abs, { line: f.line, col: f.col }, tid, e);
            links.push({
              range: { start: { x: col[f.start], y }, end: { x: col[f.end - 1], y } },
              text: label,
              decorations: { underline: true, pointerCursor: true },
              activate: (e) => go(e),
              hover: () => hover({ y, label, uri: abs, go }),
              leave: () => hover(null),
            });
          }
          callback(links.length ? links : undefined);
        });
    },
  };
}

/** The intent server's origin (seamux's pages), asked once it is up. */
let origin: string | null = null;
async function intentOrigin(): Promise<string | null> {
  if (origin) return origin;
  const s = await invoke<{ origin: string | null; up: boolean }>("intent_server").catch(() => null);
  if (s?.up && s.origin) origin = s.origin.replace("//localhost:", "//127.0.0.1:");
  return origin;
}

/** Follow a link the pane shows (see the top of this file). `id` names its
 *  terminal, for the workspace a page belongs to; `e` is the click. */
export async function follow(uri: string, id: number | null, e?: MouseEvent): Promise<void> {
  const o = await intentOrigin();
  const how = (() => {
    try {
      return route(uri, o);
    } catch {
      return "browser" as const;
    }
  })();
  if (how === "file") {
    try {
      const u = new URL(uri);
      if (u.host && u.host !== "localhost") return;
      await openFile(decodeURIComponent(u.pathname), {}, id, e);
    } catch {
      /* not a file here */
    }
    return;
  }
  // ⌘-click or Shift-click: the browser, always.
  if (how !== "browser" && !e?.shiftKey && !e?.metaKey) {
    const workspace = await placeOf(id);
    if (how === "page") {
      const u = new URL(uri);
      await openPage({ path: u.pathname + u.search, title: decodeURIComponent(u.pathname.split("/")[2] ?? ""), workspace });
      return;
    }
    sheet().openWeb(uri, { workspace });
    return;
  }
  await invoke("open_url", { url: uri }).catch(() => {});
}

type Card = {
  kind: "pr" | "issue";
  number: number;
  title: string;
  state: string;
  author: string;
  branch: string | null;
  checks: [number, number, number] | null;
  review: string | null;
  additions: number | null;
  deletions: number | null;
  excerpt: string;
  labels: string[];
};

const GH_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+/;
/** Cards fetched, kept a minute: a pull request's checks move. */
const cards = new Map<string, { card: Promise<Card | null>; at: number }>();
const CARD_MS = 60_000;

function cardFor(url: string): Promise<Card | null> {
  const key = url.match(GH_RE)?.[0] ?? url;
  const c = cards.get(key);
  if (c && performance.now() - c.at < CARD_MS) return c.card;
  const card = invoke<Card | null>("gh_card", { url: key }).catch(() => null);
  cards.set(key, { card, at: performance.now() });
  return card;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

/** The hover card for GitHub pull requests and issues, over the pane. */
export class HoverCard {
  el = el("div", "pane-card");
  private timer = 0;
  private url = "";

  constructor(private host: HTMLElement) {
    this.el.hidden = true;
    this.el.setAttribute("role", "tooltip");
    host.append(this.el);
  }

  /** The pointer is on `url` at (x, y) in the page: a card in a moment, if
   *  it is a pull request or issue. */
  hover(url: string, e: MouseEvent): void {
    if (!GH_RE.test(url)) return;
    this.url = url;
    clearTimeout(this.timer);
    const r = this.host.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.timer = window.setTimeout(() => {
      void cardFor(url).then((c) => c && this.url === url && this.draw(c, at));
    }, 400);
  }

  hide(): void {
    clearTimeout(this.timer);
    this.url = "";
    this.el.hidden = true;
  }

  private draw(c: Card, at: { x: number; y: number }): void {
    const head = el("div", "pc-head");
    head.append(el("span", `pc-state ${c.state}`, c.state), el("span", "pc-num", `#${c.number}`));
    const parts: HTMLElement[] = [head, el("div", "pc-title", c.title)];
    const who = [c.author, c.branch].filter(Boolean).join(" · ");
    if (who) parts.push(el("div", "pc-who", who));
    const facts: string[] = [];
    if (c.checks) {
      const [ok, bad, wait] = c.checks;
      const total = ok + bad + wait;
      if (total) facts.push(bad ? `✗ ${bad} of ${total} checks failed` : wait ? `${wait} of ${total} checks running` : `✓ ${total} checks`);
    }
    if (c.review && REVIEW[c.review]) facts.push(REVIEW[c.review]);
    if (c.additions !== null && c.deletions !== null) facts.push(`+${c.additions} −${c.deletions}`);
    if (facts.length) {
      const f = el("div", "pc-facts", facts.join(" · "));
      if (c.checks?.[1]) f.classList.add("bad");
      parts.push(f);
    }
    if (c.excerpt) parts.push(el("div", "pc-body", c.excerpt));
    if (c.labels.length) {
      const l = el("div", "pc-labels");
      for (const n of c.labels.slice(0, 6)) l.append(el("span", "pc-label", n));
      parts.push(l);
    }
    this.el.replaceChildren(...parts);
    this.el.hidden = false;
    // Above the pointer where it fits, else below; inside the pane.
    const w = this.host.clientWidth;
    const cw = Math.min(360, w - 16);
    this.el.style.width = `${cw}px`;
    this.el.style.left = `${Math.max(8, Math.min(at.x - 24, w - cw - 8))}px`;
    const h = this.el.offsetHeight;
    this.el.style.top = `${at.y - h - 14 >= 4 ? at.y - h - 14 : at.y + 18}px`;
  }
}
