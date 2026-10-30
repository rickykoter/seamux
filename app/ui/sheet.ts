import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reflow } from "./reflow";
import type { Frame as WallFrame, Tile } from "./wall";
import { Wake } from "./wake";
import { TermSlot } from "./native";
import { splitter } from "./splitter";
import { familyOf, memberState, type FamilyBrief } from "./family";

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

/** Where the chat's share of the width was kept before splitter.ts. */
const SPLIT_KEY = "seamux.sheet.chat";

/** sessions.rs SessionRow. */
type SessionRow = { id: string; cwd: string; updated: number; active: boolean; label: string };

const ageOf = (secs: number): string => {
  const d = Math.max(0, Date.now() / 1000 - secs);
  return d < 3600 ? `${Math.floor(d / 60)}m` : d < 86400 ? `${Math.floor(d / 3600)}h` : `${Math.floor(d / 86400)}d`;
};

/** What a pane's tab says: a Claude by its state (and how long it has
 *  waited), a terminal by what it runs. */
function tabView(p: Tile): { cls: string; name: string; state: string; tip: string } {
  if (p.agent && p.state !== "ended") {
    const who = p.agent === "claude" ? "Claude" : p.agent;
    const waiting = p.state === "needs_input";
    const wait = waiting && p.since > 0 ? ageOf(p.since / 1000) : "";
    const st = waiting ? (wait ? `waiting ${wait}` : "waiting") : "";
    const said = p.state === "needs_input" ? "waiting on you" : p.state.replace("_", " ");
    return { cls: `agent ${p.state}`, name: who, state: st, tip: `${who} · ${said}${wait ? " for " + wait : ""}${p.topic ? " · " + p.topic : ""}` };
  }
  // cmux's stock title says nothing; the folder it is in does.
  const dir = p.cwd.replace(/\/+$/, "").split("/").pop() || "";
  const runs = p.running || (p.label && p.label !== "Terminal" ? p.label : "") || dir || "terminal";
  return { cls: `term${p.bell ? " bell" : ""}`, name: runs, state: "", tip: `Terminal · ${runs}${p.cwd ? " · " + p.cwd : ""}` };
}

/** The agent's chat beside a page: its pane, live, with Jump (and a reply
 *  box when the live pane fails). */
class Chat {
  el = document.createElement("section");
  private name = document.createElement("b");
  private state = document.createElement("span");
  private body = document.createElement("div");
  /** The pane itself, live: click into it and keys go to the agent. */
  /** The pane, live: native where it is tmux-backed, snapshots otherwise. */
  private term = new TermSlot();
  private input = document.createElement("input");
  private note = document.createElement("span");
  surface = "";
  private last = "";
  /** Claude sessions of the shown workspace: resume the newest in a shell, swap to another in Claude. */
  private bar = document.createElement("div");
  private sessions: SessionRow[] = [];
  private sessKey = "";
  private sessAt = 0;
  private pickOpen = false;
  /** A native session is starting: its buttons wait. */
  private starting = false;
  /** The tile last shown, to redraw the session bar when the pane's kind is known. */
  private shown: Tile | null = null;
  /** One tab per live pane in the workspace, in the order they first showed up. */
  private tabsEl = document.createElement("div");
  private panes: Tile[] = [];
  private order: string[] = [];
  private tabSig = "";
  /** A tab was opened: the sheet shows that pane. */
  onPick: (surface: string) => void = () => {};

  constructor() {
    this.el.className = "sheet-chat";
    this.bar.className = "sheet-chat-sessions";
    this.bar.hidden = true;
    this.tabsEl.className = "sheet-chat-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.tabsEl.setAttribute("aria-label", "Panes in this workspace");
    this.tabsEl.addEventListener("keydown", (e) => this.tabKey(e));
    this.tabsEl.addEventListener("scroll", () => this.clip(), { passive: true });
    // A mouse wheel scrolls the row sideways: it has no other way to.
    this.tabsEl.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || this.tabsEl.scrollWidth <= this.tabsEl.clientWidth) return;
      this.tabsEl.scrollLeft += e.deltaY;
      e.preventDefault();
    });
    const head = document.createElement("header");
    this.body.className = "sheet-chat-body";
    const form = document.createElement("form");
    form.className = "sheet-chat-reply";
    this.input.type = "text";
    this.input.placeholder = "Reply…";
    this.input.spellcheck = false;
    this.input.addEventListener("keydown", (e) => e.stopPropagation());
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "sheet-btn icon sheet-chat-jump";
    jump.title = "Jump to this pane in cmux";
    jump.setAttribute("aria-label", jump.title);
    jump.append(mark("M3 7 7 3M4 3h3v3"));
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
    // Its worktree in VS Code, beside Jump.
    const code = document.createElement("button");
    code.type = "button";
    code.className = "sheet-btn icon sheet-chat-code";
    code.title = "Open this worktree in VS Code";
    code.setAttribute("aria-label", code.title);
    code.append(mark("M3.5 2.5 1 5l2.5 2.5M6.5 2.5 9 5 6.5 7.5"));
    code.addEventListener("click", () => void openInVSCode(this.shown?.cwd ?? "", (m) => (this.note.textContent = m)));
    head.append(this.name, this.state, code, jump);
    form.append(this.input);
    // Live by default; the plain text and its reply box only when frames fail.
    const live = (on: boolean) => {
      this.term.el.hidden = !on;
      this.body.hidden = on;
      form.hidden = on;
      if (!on) this.last = "";
    };
    live(true);
    this.term.onTrouble = (bad) => live(!bad);
    this.term.onMode = () => this.shown && this.drawSessions(this.shown);
    this.el.append(head, this.bar, this.term.el, this.body, form, this.note);
  }

  stopTerm(): void {
    this.term.stop();
  }

  /** Load the workspace's sessions when the pane or what it runs changes, and now and then. */
  private loadSessions(t: Tile): void {
    const key = `${t.workspace}|${t.surface}|${t.agent && t.state !== "ended" ? (t.state === "working" ? "busy" : "agent") : "shell"}`;
    if (key === this.sessKey && Date.now() - this.sessAt < 15000) return;
    this.sessKey = key;
    this.sessAt = Date.now();
    this.pickOpen = false;
    void invoke<SessionRow[]>("workspace_sessions", { workspace: t.workspace }).then(
      (rows) => {
        if (this.sessKey !== key) return;
        this.sessions = rows;
        this.drawSessions(t);
      },
      () => {
        this.sessions = [];
        this.drawSessions(t);
      },
    );
  }

  private async resume(t: Tile, r: SessionRow): Promise<void> {
    try {
      await invoke("session_resume", { surfaceId: t.surface, sessionId: r.id, cwd: r.cwd });
      this.note.textContent = `Resuming ${r.id.slice(0, 8)}…`;
      this.pickOpen = false;
      this.sessAt = 0;
    } catch (e) {
      this.note.textContent = String(e);
    }
    this.drawSessions(t);
  }

  /** Start Claude as a native session (local-tmux, drawn by xterm.js here)
   *  in this workspace, resuming `r` when given. */
  private async native(t: Tile, r?: SessionRow): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.drawSessions(t);
    this.note.textContent = r ? `Resuming ${r.id.slice(0, 8)} natively…` : "Starting a native session…";
    try {
      await invoke<string>("native_session", { workspaceId: t.workspace, cwd: r?.cwd || t.cwd, resume: r?.id ?? null });
      this.note.textContent = r ? `Resumed ${r.id.slice(0, 8)} as a native session` : "Started a native session";
      this.pickOpen = false;
      this.sessAt = 0;
    } catch (e) {
      this.note.textContent = String(e);
    }
    this.starting = false;
    this.drawSessions(t);
  }

  /** Move the pane's running Claude to a native session: it stops here and
   *  resumes in a new native pane, and this pane closes. */
  private async moveNative(t: Tile): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.drawSessions(t);
    this.note.textContent = "Moving Claude to a native session…";
    try {
      await invoke<string>("move_native", { surfaceId: t.surface });
      this.note.textContent = "Moved to a native session";
      this.sessAt = 0;
    } catch (e) {
      this.note.textContent = String(e);
    }
    this.starting = false;
    this.drawSessions(t);
  }

  /** The pane tabs: each Claude with its state dot (and how long it has
   *  waited), each terminal with what it runs. Redrawn only when one of them
   *  changes, so a tab keeps focus across frames. */
  private drawTabs(): void {
    for (const p of this.panes) if (!this.order.includes(p.surface)) this.order.push(p.surface);
    const live = new Set(this.panes.map((p) => p.surface));
    this.order = this.order.filter((s) => live.has(s));
    const panes = [...this.panes].sort((a, b) => this.order.indexOf(a.surface) - this.order.indexOf(b.surface));
    const views = panes.map((p) => ({ p, ...tabView(p) }));
    const sig = JSON.stringify([this.surface, views.map((v) => [v.p.surface, v.cls, v.name, v.state, v.tip])]);
    if (sig === this.tabSig) return;
    this.tabSig = sig;
    const focused = (document.activeElement as HTMLElement | null)?.closest?.(".sheet-chat-tab") as HTMLElement | null;
    const keep = focused && this.tabsEl.contains(focused) ? focused.dataset.surface : null;
    this.tabsEl.replaceChildren(
      ...views.map((v) => {
        const on = v.p.surface === this.surface;
        const b = document.createElement("button");
        b.type = "button";
        b.className = `sheet-chat-tab ${v.cls}` + (on ? " on" : "");
        b.dataset.surface = v.p.surface;
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(on));
        b.tabIndex = on ? 0 : -1;
        b.title = v.tip;
        if (v.cls.startsWith("term")) b.append(mark("M3.5 2.5 6 5 3.5 7.5"));
        else {
          const dot = document.createElement("i");
          dot.className = "sheet-chat-tab-dot";
          b.append(dot);
        }
        const name = document.createElement("span");
        name.className = "sheet-chat-tab-name";
        name.textContent = v.name;
        b.append(name);
        if (v.state) {
          const st = document.createElement("span");
          st.className = "sheet-chat-tab-state";
          st.textContent = v.state;
          b.append(st);
        }
        b.addEventListener("click", () => this.onPick(v.p.surface));
        return b;
      }),
    );
    if (keep) this.tabsEl.querySelector<HTMLElement>(`[data-surface="${CSS.escape(keep)}"]`)?.focus();
    // Many panes scroll rather than crush; the shown one stays in view.
    this.tabsEl.querySelector(".on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
    this.clip();
  }

  /** Arrows move between tabs, Home and End to the ends; Return or Space opens one. */
  private tabKey(e: KeyboardEvent): void {
    const tabs = [...this.tabsEl.querySelectorAll<HTMLButtonElement>(".sheet-chat-tab")];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const to = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    tabs[i].tabIndex = -1;
    tabs[to].tabIndex = 0;
    tabs[to].focus();
    tabs[to].scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  /** Fade the edge the row runs past, so a clipped tab reads as more to scroll to. */
  private clip(): void {
    const el = this.tabsEl;
    el.classList.toggle("clip-l", el.scrollLeft > 1);
    el.classList.toggle("clip-r", el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  /** The tab row's tools: + (a new native session), History ▾ (the workspace's
   *  stored conversations), and Resume Claude on a shell with one to resume. */
  private drawSessions(t: Tile): void {
    const inShell = !t.agent || t.state === "ended";
    const rows = this.sessions;
    const name = (r: SessionRow) => `${r.label || r.id.slice(0, 8)} · ${ageOf(r.updated)}`;
    this.bar.hidden = false;
    // A native session (a real terminal here, in tmux) can always be started.
    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.className = "sheet-btn icon sheet-chat-new";
    fresh.title = "New native session: Claude in local tmux, a real terminal here and a pane in cmux";
    fresh.setAttribute("aria-label", fresh.title);
    fresh.append(mark("M5 2v6M2 5h6"));
    fresh.addEventListener("click", () => void this.native(t));
    // A start takes seconds: one at a time.
    fresh.disabled = this.starting;
    const tools: HTMLElement[] = [fresh];
    // What the history menu holds besides the conversations.
    const items: HTMLButtonElement[] = [];
    const item = (label: string, title: string, run: () => void, off = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sheet-chat-sess act";
      b.setAttribute("role", "menuitem");
      b.textContent = label;
      b.title = title;
      b.disabled = off;
      b.addEventListener("click", run);
      items.push(b);
    };
    // A running Claude drawn from snapshots can move to a native session.
    if (t.agent === "claude" && t.state !== "ended" && !this.term.isNative() && this.term.ready()) {
      const busy = t.state === "working";
      item("Move to native", busy ? "Claude is mid-turn: move it when it is idle"
        : "Stop Claude here and resume this conversation in a native session (a real terminal here); this pane closes",
        () => void this.moveNative(t), this.starting || busy);
    }
    if (inShell && rows.length) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "sheet-btn primary sheet-chat-resume";
      go.textContent = "Resume Claude";
      go.title = `claude --resume ${rows[0].id} (${name(rows[0])})`;
      go.addEventListener("click", () => void this.resume(t, rows[0]));
      tools.push(go);
      item(`Resume natively · ${name(rows[0])}`, `claude --resume ${rows[0].id}, in a local-tmux session: a real terminal here`,
        () => void this.native(t, rows[0]), this.starting);
    }
    const hist = document.createElement("button");
    hist.type = "button";
    hist.className = "sheet-btn sheet-chat-hist";
    hist.setAttribute("aria-haspopup", "menu");
    hist.setAttribute("aria-expanded", String(this.pickOpen));
    hist.append(document.createTextNode(rows.length ? `History (${rows.length})` : "History"), mark("M2.5 4 5 6.5 7.5 4"));
    hist.title = rows.length ? "This workspace's Claude conversations: resume one in the shown pane" : "No stored conversations in this workspace yet";
    hist.disabled = !rows.length && !items.length;
    hist.addEventListener("click", () => {
      this.pickOpen = !this.pickOpen;
      this.drawSessions(t);
      if (this.pickOpen) this.bar.querySelector<HTMLButtonElement>(".sheet-chat-sess-list button:not(:disabled)")?.focus();
    });
    tools.push(hist);
    const parts: HTMLElement[] = [this.tabsEl, ...tools];
    if (this.pickOpen && !hist.disabled) {
      const list = document.createElement("div");
      list.className = "sheet-chat-sess-list";
      list.setAttribute("role", "menu");
      list.append(...items);
      const busy = !inShell && t.state === "working";
      for (const r of rows) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sheet-chat-sess" + (r.active ? " active" : "");
        b.setAttribute("role", "menuitem");
        b.textContent = (r.active ? "● " : "") + name(r);
        b.title = busy ? "Claude is mid-turn in this pane: resume another when it is idle" : `${r.id}\n${r.cwd}`;
        b.disabled = busy;
        b.addEventListener("click", () => void this.resume(t, r));
        list.append(b);
      }
      // Escape closes the menu and goes back to its button; arrows walk it.
      list.addEventListener("keydown", (e) => {
        const its = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const i = its.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.pickOpen = false;
          this.drawSessions(t);
          this.bar.querySelector<HTMLButtonElement>(".sheet-chat-hist")?.focus();
        } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && its.length) {
          e.preventDefault();
          its[(i + (e.key === "ArrowDown" ? 1 : -1) + its.length) % its.length].focus();
        }
      });
      parts.push(list);
    }
    this.bar.replaceChildren(...parts);
    this.drawTabs();
  }

  /** Show `t`, with a tab for each of `panes`, the workspace's live panes. */
  show(t: Tile, panes: Tile[] = [t]): void {
    this.shown = t;
    this.surface = t.surface;
    this.panes = panes.some((p) => p.surface === t.surface) ? panes : [t, ...panes];
    if (!this.bar.hidden) this.drawTabs();
    this.term.show(t.surface);
    this.term.agentState(t.state, t.since);
    this.loadSessions(t);
    // The workspace, then what Claude says the conversation is about.
    const base = t.workspace_title || t.label;
    this.name.textContent = t.topic ? `${base} · ${t.topic}` : base;
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
  /** The pane picked in the chat's tabs; "" is the default (an agent's). */
  private picked = "";
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
  /** Plan families, for the strip that gets from a parent to its children. */
  private families: FamilyBrief[] = [];
  private kin = document.createElement("div");
  /** The workspace changed here (a family chip): the Dock view follows. */
  onPlace: (ws: string) => void = () => {};

  /** `embedded`: a view's own columns (the Dock view's terminal and pages),
   *  always there, rather than the overlay over the stage that closes. */
  constructor(private embedded = false) {
    this.el.className = embedded ? "sheet embedded" : "sheet";
    this.kin.className = "sheet-kin";
    this.kin.hidden = true;
    this.el.hidden = !embedded;
    this.card.className = "sheet-card";
    if (!embedded) {
      this.card.setAttribute("role", "dialog");
      this.card.setAttribute("aria-modal", "true");
    }
    const head = document.createElement("header");
    if (!embedded) head.setAttribute("data-tauri-drag-region", "");
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
    close.hidden = embedded;
    head.append(this.titleEl, this.say, cmux, close);
    this.body.className = "sheet-body";
    this.pageEl.className = "sheet-page";
    this.tabsEl.className = "sheet-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.stack.className = "sheet-stack";
    this.pageEl.append(this.tabsEl, this.stack);
    this.divider.className = "sheet-divider";
    this.chat.onPick = (surface) => {
      this.picked = surface;
      this.drawChat();
    };
    this.body.append(this.chat.el, this.divider, this.pageEl);
    // The chat's share of the width, beside the page.
    splitter(this.divider, {
      zone: "sheet-chat",
      legacyKey: SPLIT_KEY,
      axis: "x",
      from: (x) => {
        const b = this.body.getBoundingClientRect();
        return (x - b.left) / b.width;
      },
      min: 0.2,
      max: 0.7,
      initial: 0.5,
      step: 0.02,
      apply: (v) => this.body.style.setProperty("--chat", String(v)),
      label: "Resize the chat",
    });
    this.card.append(head, this.kin, this.body);
    this.el.append(this.card);
    if (embedded) return;
    // A click on the dimmed backdrop closes; one inside the card does not.
    this.el.addEventListener("click", (e) => e.target === this.el && this.close());
    // Capture, so the window's own Escape (hide) waits for the sheet.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !this.el.hidden && !(document.activeElement as HTMLElement | null)?.closest(".term")) {
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

  /** Keys are this sheet's: the overlay while it is open; an embedded one
   *  while its view is on screen and no overlay is open over it. */
  private keysHere(): boolean {
    if (!this.embedded) return !this.el.hidden;
    return this.el.getClientRects().length > 0 && !document.querySelector(".sheet:not(.embedded):not([hidden])");
  }

  /** Show a workspace: its terminal, and the Wake unless a page is up. */
  /** The place shown: a page opened for it joins its tabs. */
  here(): { workspace?: string; dir?: string } {
    return { ...this.place };
  }

  /** `show`: "wake" or "plan" go to that tab even when the workspace is already up. */
  focusWorkspace(ws: string, show = "any"): void {
    if (ws !== this.workspace() || !this.active) {
      this.enter({ workspace: ws });
      if (!this.active) this.select(WAKE);
    }
    if (show === "wake") this.select(WAKE);
    else if (show === "plan") {
      const plan = this.tabs.find((t) => t.kind === "plan");
      if (plan) this.select(plan.key);
    }
  }

  /** Follow the panes, so the chat beside a page stays live, and each
   *  workspace's open pages, for the tabs. */
  async start(): Promise<void> {
    await listen<WallFrame>("wall:frame", (e) => {
      this.tiles = e.payload.tiles;
      if (!this.el.hidden) this.drawChat();
    });
    await listen<{ pages?: NowPage[]; families?: FamilyBrief[] }>("views:frame", (e) => {
      const fams = e.payload.families ?? [];
      if (JSON.stringify(fams) !== JSON.stringify(this.families)) {
        this.families = fams;
        if (!this.el.hidden) this.drawKin();
      }
      const pages = e.payload.pages ?? [];
      if (JSON.stringify(pages) === JSON.stringify(this.pages)) return;
      this.pages = pages;
      if (!this.el.hidden) {
        this.syncTabs();
        // The sheet was entered before its pages were known: start on one now.
        if (!this.active) this.pickTab();
      }
    });
    // shell.rs's keys: they work with focus in a framed page too.
    await listen<string>("sheet:key", (e) => {
      if (!this.keysHere()) return;
      if (e.payload === "wake") this.toggleWake();
      else this.step(e.payload === "next" ? 1 : -1);
    });
    // 1–9 pick a page tab while focus is in the shell (a framed page keeps its own keys).
    document.addEventListener("keydown", (e) => {
      if (!this.keysHere() || e.metaKey || e.ctrlKey || e.altKey || !(e.key >= "1" && e.key <= "9")) return;
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || at instanceof HTMLSelectElement) return;
      const t = this.tabs.filter((x) => x.key !== WAKE)[Number(e.key) - 1];
      if (t) {
        this.select(t.key);
        e.preventDefault();
      }
    });
    // Frames go out only on change: start from the latest one.
    const [f, v] = await Promise.all([invoke<WallFrame | null>("wall_frame"), invoke<{ pages?: NowPage[]; families?: FamilyBrief[] } | null>("views_frame")]);
    if (f) this.tiles = f.tiles;
    if (v?.pages) this.pages = v.pages;
    if (v?.families) this.families = v.families;
    if (!this.el.hidden) {
      this.drawChat();
      this.syncTabs();
    }
  }

  /** The agent pane for the page's workspace (or the one working in its directory). */
  private tile(): Tile | undefined {
    const { workspace, dir } = this.place;
    // An agent's pane first; else the workspace's terminal (an agent cmux has
    // not recognised yet, at a trust prompt say, is still worth showing live).
    const agents = this.tiles.filter((t) => t.agent && t.state !== "ended");
    const d = (dir ?? "").replace(/\/+$/, "");
    const here = (t: Tile) => (workspace ? t.workspace === workspace : !!d && (t.cwd === d || t.cwd.startsWith(d + "/")));
    const picked = this.picked ? this.tiles.find((t) => t.surface === this.picked && here(t)) : undefined;
    return picked ?? agents.find(here) ?? this.tiles.find(here);
  }

  /** Every live pane of the page's workspace, for the chat's tabs. */
  private paneTiles(): Tile[] {
    const t = this.tile();
    return t ? this.tiles.filter((x) => x.workspace === t.workspace) : [];
  }

  /** The cmux workspace the sheet is for: named, or the agent's in its directory. */
  private workspace(): string {
    return this.place.workspace ?? this.tile()?.workspace ?? "";
  }

  /** The worktree directory, for the Wake: named, else the agent's cwd. */
  private dir(): string {
    return this.place.dir ?? this.tile()?.cwd ?? "";
  }

  /** The family strip: the parent and every child, each a click to its workspace. */
  private drawKin(): void {
    const ws = this.workspace();
    const kin = ws ? familyOf(this.families, ws) : undefined;
    this.kin.hidden = !kin;
    if (!kin) return;
    const { fam, member } = kin;
    const label = document.createElement("span");
    label.className = "sheet-kin-label";
    label.textContent = `family · ${fam.parent} · ${fam.done}/${fam.total} done`;
    const chips = fam.members.map((m, i) => {
      const b = document.createElement("button");
      b.type = "button";
      const here = m === member || m.slug === member.slug;
      b.className = `sheet-kin-chip${here ? " here" : ""}${m.phase === "done" ? " done" : ""}`;
      const name = document.createElement("b");
      name.textContent = m.role === "parent" ? `${m.slug} (parent)` : m.slug;
      const state = document.createElement("span");
      state.textContent = memberState(fam, m);
      b.append(name, state);
      b.title = m.ws ? `${m.slug} · ${state.textContent}` : `${m.slug} has no open workspace`;
      b.disabled = !m.ws || here;
      b.setAttribute("aria-current", here ? "true" : "false");
      b.addEventListener("click", () => {
        if (!m.ws) return;
        this.enter({ workspace: m.ws });
        this.onPlace(m.ws);
      });
      b.dataset.n = String(i);
      return b;
    });
    this.kin.replaceChildren(label, ...chips);
  }

  private drawChat(): void {
    const t = this.tile();
    this.body.classList.toggle("with-chat", !!t);
    if (t) this.chat.show(t, this.paneTiles());
  }

  /** Show a file's content: images as an image, HTML with scripts off, PDFs framed. */
  show(s: Shown, toCmux: () => Promise<unknown>, place: { workspace?: string; dir?: string } = {}): void {
    this.enter(place, false);
    const key = `file:${s.title}`;
    this.drop(key);
    this.tabs.push({ key, kind: "file", label: s.title, state: "", waiting: false, now: false, el: null, shown: s, toCmux });
    this.select(key);
  }

  async open(p: Page): Promise<void> {
    this.enter({ workspace: p.workspace, dir: p.dir }, false);
    const t = this.tabs.find((x) => x.key === p.path);
    if (t) {
      t.page = p;
      t.toCmux = p.toCmux ?? null;
    } else this.tabs.push({ key: p.path, kind: kindOf(p.path), label: p.title, state: "", waiting: false, now: false, el: null, page: p, toCmux: p.toCmux ?? null });
    this.select(p.path);
  }

  /** Open the sheet for a place: another place starts its tabs afresh. */
  private enter(place: { workspace?: string; dir?: string }, pick = true): void {
    // The same workspace is the same place, however a caller names it.
    const where = () => this.workspace() || this.dir();
    const was = this.el.hidden ? null : where();
    this.place = place;
    if (was !== where()) this.reset();
    this.drawChat();
    this.drawKin();
    this.say.textContent = "";
    this.el.hidden = false;
    this.syncTabs();
    if (pick) this.pickTab();
  }

  /** A new place starts on a page, not blank: its plan, else what waits on you, else the Wake. */
  private pickTab(): void {
    if (this.active && this.tabs.some((t) => t.key === this.active)) return;
    const pages = this.tabs.filter((t) => t.key !== WAKE);
    const t = pages.find((x) => x.kind === "plan") ?? pages.find((x) => x.waiting) ?? pages[0];
    this.select((t ?? this.tabs.find((x) => x.key === WAKE))?.key ?? WAKE);
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
    this.picked = "";
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
    // Many tabs scroll rather than crush; the current one stays in view.
    this.tabsEl.querySelector(".on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
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
      this.wake = new Wake(root, { embedded: true, host: this });
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
    // Asked each time a page is framed: the server can come back on a new port.
    const down = (why: string) => {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = `The intent server is down (${why}), so this page can't be shown here. Open in cmux may still work once it is back. `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "sheet-btn";
      retry.textContent = "Retry";
      // Selecting a page that failed builds it again (see select).
      retry.addEventListener("click", () => this.select(t.key));
      n.append(retry);
      box.replaceChildren(n);
      box.dataset.failed = "1";
    };
    invoke<IntentServer>("intent_server").then((server) => {
      if (!server.up || !server.origin) return down(server.reason ?? "no answer");
      const f = document.createElement("iframe");
      f.src = server.origin + t.key;
      f.title = t.label;
      box.append(f);
    }, (e) => down(String(e)));
  }

  close(): void {
    this.el.hidden = true;
    this.chat.stopTerm();
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
      if (!this.embedded) this.close();
    } catch (e) {
      this.say.textContent = String(e);
    }
  }
}

function kindOf(path: string): string {
  return path.startsWith("/review/") ? "review" : path.startsWith("/ask/") ? "ask" : path.startsWith("/plan/") ? "plan" : "page";
}

/** Open the worktree `dir` is in, in VS Code; `say` gets an error to show. */
export async function openInVSCode(dir: string, say: (m: string) => void): Promise<void> {
  if (!dir) return say("this pane has no folder yet");
  try {
    const o = await invoke<{ folder: string; note: string | null }>("open_in_vscode", { dir });
    // Opened; the note says why it is not wearing its color, if it is not.
    say(o.note ? `Opened in VS Code · ${o.note}` : "");
  } catch (e) {
    say(String(e));
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
