// The Dock view, the app's default: cmux's Dock (crew-board's page, served
// at /board) on the left, the chosen workspace's Claude terminal in the
// middle, and its Wake and open pages on the right.
//
// A row clicked in the board selects its workspace here (intent.js posts
// {crew: "select", ws} when framed) and cmux stays where it is; the board
// marks the workspace shown here ({crew: "selected", ws} back to it).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Decision } from "./decisions";
import { MigrateBanner } from "./migrate";
import { NewWorkspace } from "./newws";
import { sprite } from "./panecat";
import { ReclaimWizard } from "./reclaim";
import { setDockSheet, Sheet } from "./sheet";
import { splitter } from "./splitter";
import { Tray } from "./tray";

/** A sub-agent's transcript page or a run's page, as the board names them. */
const AGENT_PAGE = /^\/(agent|run)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$|^\/runs\/[A-Za-z0-9_-]+$/;
import { setLevel, setResume, type Levels } from "./tuck";
import type { Frame as WallFrame, Tile } from "./tiles";

type IntentServer = { origin: string | null; up: boolean; reason: string | null };

export class DockView {
  private board = document.createElement("div");
  private frame: HTMLIFrameElement | null = null;
  /** The workspace ⌘. jumped to, while it is still the one shown: the board
   *  opens its card for the visit without keeping that as a choice. */
  private peek = "";
  /** Each workspace's priority from the turn-end judgments (views:frame). */
  private priority: Record<string, number> = {};
  private note = document.createElement("p");
  private sheet = new Sheet(true);
  private origin: string | null = null;
  /** The workspace shown; "" until one is picked or a default is found. */
  private ws = "";
  /** Picked in the board (or a family chip): kept, never replaced by a default. */
  private picked = false;
  private tiles: Tile[] = [];
  private decisions: Decision[] = [];
  /** Muted and tucked workspaces, for the board's ⋯ menu (its Undo). */
  private levels: Levels = {};
  private empty = document.createElement("p");
  /** The New workspace form, opened from the bar above the board (or ⌘N). */
  private newws = new NewWorkspace();
  /** The board's reclaim chip, asked here rather than in a cmux terminal. */
  private reclaim = new ReclaimWizard();
  /** Sessions on the other backend that can move here, asked at launch. */
  private migrate = new MigrateBanner();
  /** The shelf's sprites, opened by a click on the board's shelf. */
  private tray = new Tray();
  /** A workspace just made here, and until when it is kept while cmux's
   *  frames catch up (it is not in them for a second or two). */
  private fresh: { ws: string; until: number } | null = null;

  constructor(private root: HTMLElement) {
    root.classList.add("dockview");
    this.board.className = "dock-board";
    this.note.className = "note";
    this.note.hidden = true;
    // A thin strip across the top of the Dock: the New workspace form.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "dock-new";
    add.title = "New worktree and workspace, with Claude running";
    const plus = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    plus.setAttribute("viewBox", "0 0 10 10");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M5 1.5v7M1.5 5h7");
    plus.append(path);
    const label = document.createElement("span");
    label.textContent = "New workspace";
    const key = document.createElement("kbd");
    key.textContent = "⌘N";
    add.append(plus, label, key);
    add.addEventListener("click", () => void this.newws.open());
    this.board.append(add, this.migrate.el, this.note, this.tray.el);
    // A sprite picked in the Tray: the board's shelf shows it too.
    sprite.listen(() => this.tell());
    this.newws.onMade = (ws) => {
      this.fresh = { ws, until: Date.now() + 20_000 };
      this.select(ws, true);
    };
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
    // A link in the Dock's terminal opens its page here, beside it.
    setDockSheet(this.sheet);
    // A reclaimed workspace is gone: show another.
    // "Sort it out with Claude": show its new pane.
    this.reclaim.onClaude = (ws, pane) => this.select(ws, true, "any", pane);
    this.reclaim.onReclaimed = (ws) => {
      if (this.ws !== ws) return;
      this.ws = "";
      this.picked = false;
      this.fallback();
    };
    window.addEventListener("message", (e) => {
      if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== this.origin) return;
      const d = e.data as { crew?: string; ws?: unknown; show?: unknown; pane?: unknown } | null;
      // A pane row names its pane: the sheet shows that pane's terminal.
      if (d?.crew === "select" && typeof d.ws === "string" && d.ws) {
        this.select(d.ws, true, typeof d.show === "string" ? d.show : "any", typeof d.pane === "string" ? d.pane : "");
      }
      // A PR pill: that workspace's Wake, on the pill's group of its PRs.
      const pg = d as { group?: unknown } | null;
      if (d?.crew === "prs" && typeof d.ws === "string" && d.ws) {
        this.select(d.ws, true, "wake");
        this.sheet.showPrs(typeof pg?.group === "string" ? pg.group : "");
      }
      // The board's ⋯ menu: mute, snooze, tuck away or bring back, as the
      // views do. A snooze carries its end (ms since the epoch).
      const t = d as { level?: unknown; name?: unknown; until?: unknown } | null;
      const until = typeof t?.until === "number" && Number.isFinite(t.until) ? t.until : undefined;
      const lvl = t?.level === "snooze" ? (until ? "snooze" : null) : t?.level === "mute" || t?.level === "tuck" || t?.level === "none" ? t.level : null;
      if (d?.crew === "tuck" && typeof d.ws === "string" && d.ws && lvl) {
        void setLevel(d.ws, typeof t?.name === "string" ? t.name : d.ws, lvl, this.levels[d.ws], until);
      }
      // The board's "Resume when the limit resets" (its ⋯ menu) and the armed chip's disarm.
      const u = d as { on?: unknown; name?: unknown } | null;
      if (d?.crew === "resume" && typeof d.ws === "string" && d.ws && typeof u?.on === "boolean") {
        void setResume(d.ws, typeof u.name === "string" ? u.name : d.ws, u.on);
      }
      // A sub-agent or run row: its page in the Sheet, beside that
      // workspace's terminal; All agents and +N more: the session's page.
      // Only an /agent/, /run/ or /runs/ path is opened; the intent server
      // serves it only for an agent an adapter listed.
      const g = d as { path?: unknown; title?: unknown } | null;
      if (d?.crew === "page" && typeof d.ws === "string" && d.ws && typeof g?.path === "string" && AGENT_PAGE.test(g.path)) {
        const ws = d.ws;
        this.select(ws, true);
        void this.sheet.open({ path: g.path, title: typeof g.title === "string" && g.title ? g.title : "Agent", workspace: ws });
      }
      // The board's reclaim chip: what would go, and a yes, in the wizard.
      const r = d as { name?: unknown } | null;
      if (d?.crew === "reclaim" && typeof d.ws === "string" && d.ws) this.reclaim.open(d.ws, typeof r?.name === "string" ? r.name : d.ws);
      // The board's shelf: its Tray, just under the shelf's 30px.
      if (d?.crew === "sprites" && this.frame) this.tray.toggle(this.frame.offsetTop + 32);
      // The board's click handler is installed (its first push): mark ours.
      if (d?.crew === "ready") this.tell();
    });
    this.draw();
  }

  async start(): Promise<void> {
    void this.migrate.start();
    await this.sheet.start();
    await listen<WallFrame>("wall:frame", (e) => {
      this.tiles = e.payload.tiles;
      this.fallback();
    });
    await listen<{ decisions?: Decision[]; levels?: Levels; priority?: Record<string, number> }>("views:frame", (e) => {
      this.decisions = e.payload.decisions ?? [];
      this.levels = e.payload.levels ?? {};
      this.priority = e.payload.priority ?? {};
      this.fallback();
    });
    const [w, v] = await Promise.all([invoke<WallFrame | null>("wall_frame"), invoke<{ decisions?: Decision[]; priority?: Record<string, number> } | null>("views_frame")]);
    if (w) this.tiles = w.tiles;
    if (v?.decisions) this.decisions = v.decisions;
    if (v?.priority) this.priority = v.priority;
    this.fallback();
    await this.frameBoard();
  }

  /** ⌘.: the next workspace that needs the person, after the one shown,
   *  wrapping. Asked first (a question, a pane waiting on you), then a
   *  command that died, then an agent working for over ten minutes, then a
   *  failed check. Within each, the higher priority first (the turn-end
   *  judgment's, from views:frame), then the oldest. False when none needs you. */
  nextAttention(): boolean {
    const now = Date.now();
    const agents = this.tiles.filter((t) => t.agent && t.state !== "ended");
    const pri = (ws: string) => this.priority[ws] ?? 0;
    const byAge = <T extends { ws: string; since: number }>(xs: T[]) => [...xs].sort((a, b) => pri(b.ws) - pri(a.ws) || a.since - b.since);
    const asked = [
      ...this.decisions.filter((d) => d.kind === "question" || d.kind === "asked"),
      ...agents.filter((t) => t.state === "needs_input").map((t) => ({ ws: t.workspace, since: t.since })),
    ];
    const died = this.tiles.filter((t) => t.exited && !t.running).map((t) => ({ ws: t.workspace, since: t.exited!.at }));
    const silent = agents.filter((t) => t.state === "working" && now - t.since > 10 * 60_000).map((t) => ({ ws: t.workspace, since: t.since }));
    const failed = this.decisions.filter((d) => d.kind === "gate" && d.checks.some((c) => c.status === "fail" || c.status === "lost"));
    const order: string[] = [];
    for (const group of [asked, died, silent, failed])
      for (const x of byAge(group)) if (x.ws && !order.includes(x.ws) && this.tiles.some((t) => t.workspace === x.ws)) order.push(x.ws);
    if (!order.length) return false;
    const next = order[(order.indexOf(this.ws) + 1) % order.length];
    this.select(next, true, "any", "", true);
    return true;
  }

  /** A click on a notification: show its workspace and pane. */
  jump(ws: string, pane: string): void {
    if (ws) this.select(ws, true, "any", pane);
  }

  /** Called when the tab is shown (and on every summon): a board whose
   *  server moved loads again. One that is only old stays, folds and all: a
   *  page left from before a server restart reloads itself when its feed is
   *  refused (crates/crew-board/src/inject/board.js). */
  shown(): void {
    void this.frameBoard();
  }

  private async frameBoard(): Promise<void> {
    const server = await invoke<IntentServer>("intent_server").catch(() => null);
    if (!server?.up || !server.origin) {
      this.note.hidden = false;
      this.note.textContent = `The Dock comes from crew-board-intent, which isn't answering${server?.reason ? ` (${server.reason})` : ""}.`;
      this.frame?.remove();
      this.frame = null;
      this.origin = null;
      return;
    }
    if (this.frame && this.origin === server.origin) return;
    this.frame?.remove();
    this.note.hidden = true;
    this.origin = server.origin;
    const f = document.createElement("iframe");
    f.title = "Dock";
    f.src = `${server.origin}/board`;
    f.addEventListener("load", () => this.tell());
    this.frame = f;
    this.board.append(f);
  }

  /** Until one is shown: the one waiting longest on you, else an agent at work. */
  private fallback(): void {
    // What is shown stays while its workspace lives, picked or not: choosing
    // again on every frame flips between whichever is waiting or working now.
    if (this.ws && this.tiles.some((t) => t.workspace === this.ws)) return;
    // One just made here stays while the frames catch up to it.
    if (this.fresh && this.fresh.ws === this.ws && Date.now() < this.fresh.until) return;
    this.fresh = null;
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

  /** `peek`: ⌘. chose it, so the board opens its card only for the visit. */
  private select(ws: string, picked: boolean, show = "any", pane = "", peek = false): void {
    if (picked) this.picked = true;
    this.peek = peek ? ws : "";
    this.ws = ws;
    this.sheet.focusWorkspace(ws, show, pane);
    this.draw();
    this.tell();
  }

  /** The board marks the workspace shown here, learns what the app does
   *  itself (its reclaim chip then asks here, not in a cmux terminal, and its
   *  shelf opens the Tray), and shows the sprite chosen here.
   *  `peek`: ⌘. brought it here, so its card opens for the visit only. */
  private tell(): void {
    const peek = !!this.peek && this.peek === this.ws;
    if (this.frame?.contentWindow && this.origin)
      this.frame.contentWindow.postMessage({ crew: "selected", ws: this.ws, can: ["reclaim", "sprites", "agents", "prs"], peek, sprite: sprite.get() }, this.origin);
  }

  private draw(): void {
    this.sheet.el.hidden = !this.ws;
    this.empty.hidden = !!this.ws;
  }
}
