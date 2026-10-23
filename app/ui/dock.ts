// The Dock view, the app's default: cmux's Dock (crew-board's page, served
// at /board) on the left, the chosen workspace's Claude terminal in the
// middle, and its Wake and open pages on the right.
//
// A row clicked in the board selects its workspace here (intent.js posts
// {crew: "select", ws} when framed) and cmux stays where it is; the board
// marks the workspace shown here ({crew: "selected", ws} back to it).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Decision } from "./desk";
import { Sheet } from "./sheet";
import { splitter } from "./splitter";
import type { Frame as WallFrame, Tile } from "./wall";

type IntentServer = { origin: string | null; up: boolean; reason: string | null };

export class DockView {
  private board = document.createElement("div");
  private frame: HTMLIFrameElement | null = null;
  /** When the board was last loaded: a page left from before a server
   *  restart has old code and a refused token, so it is loaded afresh. */
  private loadedAt = 0;
  private note = document.createElement("p");
  private sheet = new Sheet(true);
  private origin: string | null = null;
  /** The workspace shown; "" until one is picked or a default is found. */
  private ws = "";
  /** Picked in the board (or a family chip): kept, never replaced by a default. */
  private picked = false;
  private tiles: Tile[] = [];
  private decisions: Decision[] = [];
  private empty = document.createElement("p");

  constructor(private root: HTMLElement) {
    root.classList.add("dockview");
    this.board.className = "dock-board";
    this.note.className = "note";
    this.note.hidden = true;
    this.board.append(this.note);
    const grip = document.createElement("div");
    grip.className = "dock-grip";
    this.empty.className = "dock-empty";
    this.empty.textContent = "Pick a workspace in the Dock: its terminal and its Wake open here.";
    root.append(this.board, grip, this.sheet.el, this.empty);
    splitter(grip, {
      zone: "dock-board",
      axis: "x",
      from: (x) => x,
      min: 240,
      max: 720,
      initial: 340,
      step: 16,
      apply: (v) => root.style.setProperty("--board-w", `${Math.round(v)}px`),
      label: "Resize the Dock",
      measure: () => this.board.getBoundingClientRect().width,
    });
    this.sheet.onPlace = (ws) => this.select(ws, true);
    window.addEventListener("message", (e) => {
      if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== this.origin) return;
      const d = e.data as { crew?: string; ws?: unknown } | null;
      if (d?.crew === "select" && typeof d.ws === "string" && d.ws) this.select(d.ws, true);
      // The board's click handler is installed (its first push): mark ours.
      if (d?.crew === "ready") this.tell();
    });
    this.draw();
  }

  async start(): Promise<void> {
    await this.sheet.start();
    await listen<WallFrame>("wall:frame", (e) => {
      this.tiles = e.payload.tiles;
      this.fallback();
    });
    await listen<{ decisions?: Decision[] }>("views:frame", (e) => {
      this.decisions = e.payload.decisions ?? [];
      this.fallback();
    });
    const [w, v] = await Promise.all([invoke<WallFrame | null>("wall_frame"), invoke<{ decisions?: Decision[] } | null>("views_frame")]);
    if (w) this.tiles = w.tiles;
    if (v?.decisions) this.decisions = v.decisions;
    this.fallback();
    await this.frameBoard();
  }

  /** Called when the tab is shown (and on every summon): a board whose
   *  server moved, or that was loaded over a minute ago, loads again. */
  shown(): void {
    void this.frameBoard(Date.now() - this.loadedAt > 60_000);
  }

  private async frameBoard(fresh = false): Promise<void> {
    const server = await invoke<IntentServer>("intent_server").catch(() => null);
    if (!server?.up || !server.origin) {
      this.note.hidden = false;
      this.note.textContent = `The Dock comes from crew-board-intent, which isn't answering${server?.reason ? ` (${server.reason})` : ""}.`;
      this.frame?.remove();
      this.frame = null;
      this.origin = null;
      return;
    }
    if (this.frame && this.origin === server.origin) {
      if (!fresh) return;
      this.loadedAt = Date.now();
      this.frame.src = `${server.origin}/board`;
      return;
    }
    this.frame?.remove();
    this.note.hidden = true;
    this.origin = server.origin;
    const f = document.createElement("iframe");
    f.title = "Dock";
    f.src = `${server.origin}/board`;
    this.loadedAt = Date.now();
    f.addEventListener("load", () => this.tell());
    this.frame = f;
    this.board.append(f);
  }

  /** Until a workspace is picked: the one waiting longest on you, else an agent at work. */
  private fallback(): void {
    if (this.picked && this.tiles.some((t) => t.workspace === this.ws)) return;
    this.picked = false;
    const waiting = this.decisions.filter((d) => d.kind === "question" || d.kind === "asked").map((d) => d.ws);
    const agents = this.tiles.filter((t) => t.agent && t.state !== "ended");
    const order = [
      ...waiting,
      ...agents.filter((t) => t.state === "needs_input").map((t) => t.workspace),
      ...agents.filter((t) => t.state === "working").map((t) => t.workspace),
      ...agents.map((t) => t.workspace),
    ];
    const ws = order.find((w) => this.tiles.some((t) => t.workspace === w)) ?? "";
    if (ws && ws !== this.ws) this.select(ws, false);
    else if (!ws) this.draw();
  }

  private select(ws: string, picked: boolean): void {
    if (picked) this.picked = true;
    this.ws = ws;
    this.sheet.focusWorkspace(ws);
    this.draw();
    this.tell();
  }

  /** The board marks the workspace shown here. */
  private tell(): void {
    if (this.frame?.contentWindow && this.origin) this.frame.contentWindow.postMessage({ crew: "selected", ws: this.ws }, this.origin);
  }

  private draw(): void {
    this.sheet.el.hidden = !this.ws;
    this.empty.hidden = !!this.ws;
  }
}
