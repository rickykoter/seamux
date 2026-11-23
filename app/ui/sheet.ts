import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reflow } from "./reflow";
import type { Frame as WallFrame, Tile } from "./tiles";
import { Wake } from "./wake";
import { TermSlot } from "./native";
import { splitter } from "./splitter";
import { familyOf, memberState, type FamilyBrief } from "./family";
import { face, GROUPS, groupOf, jump, ordered, round, WAKE, type GroupId } from "./sheetgroups";
import { placeFor } from "./linkroute";
import { awayLabel, openElsewhere, openFramed, type Away } from "./panelinks";

type IntentServer = { origin: string | null; up: boolean; reason: string | null };

/** An intent-server page: a plan, a review, an ask, a sub-agent's transcript or a run. */
export type Page = {
  /** /plan/<slug>, /review/<id>, /ask/<id>, /agent/<session>/<id> or /run/<session>/<id>. */
  path: string;
  title: string;
  /** The cmux workspace it belongs to: its agent's chat shows beside the page, and open elsewhere goes there. */
  workspace?: string;
  /** A worktree directory, when the workspace is not known (a Wake row): the pane working in it. */
  dir?: string;
};

/** A file the sheet shows itself: an image, a sandboxed HTML page or a PDF. */
export type Shown = { kind: "image" | "video" | "html" | "pdf"; title: string; data: string };

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
    // A working Claude with a task list says how far it is ("3/5").
    const done = p.state === "working" && p.progress ? p.progress.split(" · ")[0] : "";
    const st = waiting ? (wait ? `needs you · ${wait}` : "needs you") : done;
    const said = p.state === "needs_input" ? "needs you" : p.state.replace("_", " ");
    const tasks = p.progress ? " · " + p.progress : "";
    return { cls: `agent ${p.state}`, name: who, state: st, tip: `${who} · ${said}${wait ? " for " + wait : ""}${tasks}${p.topic ? " · " + p.topic : ""}` };
  }
  // cmux's stock title says nothing; the folder it is in does.
  const dir = p.cwd.replace(/\/+$/, "").split("/").pop() || "";
  const runs = p.running || (p.label && p.label !== "Terminal" ? p.label : "") || dir || "terminal";
  // A watcher or server that died: what ran, how it ended, and when.
  if (p.exited && !p.running) {
    const ended = `${p.exited.command} exited${p.exited.code !== null ? " " + p.exited.code : ""}, ${ageOf(p.exited.at / 1000)} ago`;
    return { cls: "term bell exited", name: ended, state: "", tip: `Terminal · ${ended}${p.cwd ? " · " + p.cwd : ""}` };
  }
  return { cls: `term${p.bell ? " bell" : ""}`, name: runs, state: "", tip: `Terminal · ${runs}${p.cwd ? " · " + p.cwd : ""}` };
}

/** The agent's chat beside a page: its pane, live, with Jump (and a reply
 *  box when the live pane fails). */
class Chat {
  el = document.createElement("section");
  /** Its worktree in VS Code and its pane in cmux: the end of the tab row. */
  private icons: HTMLElement[] = [];
  /** The Dock's sheet header, moved into this row (sheet.ts Sheet): one row of tools. */
  private extra: HTMLElement[] = [];

  /** Take the sheet's own tools into the tab row. Its cmux button replaces
   *  this row's jump, so there is one way to cmux, not two. */
  adopt(tools: HTMLElement[]): void {
    this.extra = tools;
    // VS Code stays; the pane's cmux jump gives way to the sheet's one cmux icon.
    this.icons = this.icons.filter((x) => !x.classList.contains("sheet-chat-jump"));
    if (!this.bar.hidden && this.shown) this.drawSessions(this.shown);
  }

  /** Keys to the pane: its live terminal, or the reply box when the pane
   *  shows as plain text. False while neither is up yet. */
  focusTerm(): boolean {
    if (this.term.isNative()) {
      this.term.focus();
      return this.term.el.contains(document.activeElement);
    }
    if (!this.input.isConnected || this.input.offsetParent === null) return false;
    this.input.focus();
    return document.activeElement === this.input;
  }

  /** Its worktree in VS Code (the Dock's "Open in" menu). */
  openCode(): void {
    void openInVSCode(this.shown?.cwd ?? "", (m) => (this.note.textContent = m));
  }

  /** This pane in cmux: the Dock's one cmux button, when no page is up. */
  async jumpToPane(): Promise<void> {
    try {
      await invoke("wall_jump", { surfaceId: this.surface });
      await invoke("hide_overlay");
    } catch (e) {
      this.note.textContent = String(e);
    }
  }
  private body = document.createElement("div");
  /** The pane, live where it is tmux-backed: click into it and keys go to the agent. */
  private term = new TermSlot();
  /** For a pane the app cannot draw (not tmux-backed): why, Move to native, Open in cmux. */
  private plain = document.createElement("div");
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
  /** The pane the row last scrolled to, so a redraw for another pane's state leaves the scroll alone. */
  private scrolledTo = "";
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
    this.body.className = "sheet-chat-body";
    const form = document.createElement("form");
    // Replies and jumps go through cmux: hidden on the tmux backend (index.html).
    form.className = "sheet-chat-reply cmux-only";
    this.input.type = "text";
    this.input.placeholder = "Reply…";
    this.input.spellcheck = false;
    this.input.addEventListener("keydown", (e) => e.stopPropagation());
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "sheet-btn icon sheet-chat-jump cmux-only";
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
    // No header of its own: the pane tab says the state, the sheet the workspace.
    this.icons = [code, jump];
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
    this.term.onMode = () => {
      if (!this.shown) return;
      this.drawSessions(this.shown);
      this.drawPlain(this.shown);
    };
    this.plain.className = "sheet-chat-plain";
    this.plain.hidden = true;
    this.el.append(this.bar, this.term.el, this.plain, this.body, form, this.note);
  }

  /** A pane that is not tmux-backed has no live terminal here: say so, and
   *  offer to move its Claude to a native session or to open it in cmux. */
  private drawPlain(t: Tile): void {
    const on = this.term.ready() && !this.term.isNative();
    this.plain.hidden = !on;
    if (!on) return;
    const say = document.createElement("p");
    say.textContent = "This pane isn't a native session, so it can't be drawn here.";
    const parts: HTMLElement[] = [say];
    if (t.agent === "claude" && t.state !== "ended") {
      const busy = t.state === "working";
      const move = document.createElement("button");
      move.type = "button";
      // Moves a Claude out of a cmux pane: cmux only.
      move.className = "sheet-btn primary cmux-only";
      move.textContent = "Move to native";
      move.title = busy ? "Claude is mid-turn: move it when it is idle"
        : "Stop Claude here and resume this conversation in a native session; this pane closes";
      move.disabled = busy || this.starting;
      move.addEventListener("click", () => void this.moveNative(t));
      parts.push(move);
    }
    const cmux = document.createElement("button");
    cmux.type = "button";
    cmux.className = "sheet-btn";
    cmux.textContent = "Open in cmux";
    cmux.classList.add("cmux-only");
    cmux.addEventListener("click", async () => {
      try {
        await invoke("wall_jump", { surfaceId: t.surface });
        await invoke("hide_overlay");
      } catch (e) {
        this.note.textContent = String(e);
      }
    });
    parts.push(cmux);
    this.plain.replaceChildren(...parts);
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
      this.term.recheck();
    } catch (e) {
      this.note.textContent = String(e);
    }
    this.starting = false;
    this.drawSessions(t);
    this.drawPlain(t);
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
    if (sig === this.tabSig) return this.scrollShown();
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
    this.scrollShown();
    this.clip();
  }

  /** Many panes scroll rather than crush. The shown tab is brought into view
   *  once when it changes, not on every redraw (a row scrolled sideways by
   *  hand stays put), and only once it exists in a row that is laid out. */
  private scrollShown(): void {
    if (this.scrolledTo === this.surface) return;
    const on = this.tabsEl.querySelector(".on");
    if (!on || this.tabsEl.clientWidth === 0) return;
    this.scrolledTo = this.surface;
    on.scrollIntoView({ inline: "nearest", block: "nearest" });
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
    // A running Claude in a pane the app cannot draw can move to a native session.
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
      // The redraw replaced this button: focus goes to the menu, or back to History.
      (this.pickOpen && this.bar.querySelector<HTMLButtonElement>(".sheet-chat-sess-list button:not(:disabled)") ||
        this.bar.querySelector<HTMLButtonElement>(".sheet-chat-hist"))?.focus();
    });
    tools.push(hist);
    const parts: HTMLElement[] = [...tools, ...this.icons, ...this.extra];
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
    // The tab row stays attached: moving it would drop a tab's focus and scroll.
    if (this.tabsEl.parentElement !== this.bar) this.bar.prepend(this.tabsEl);
    while (this.tabsEl.nextSibling) this.tabsEl.nextSibling.remove();
    this.bar.append(...parts);
    this.drawTabs();
  }

  /** Show `t`, with a tab for each of `panes`, the workspace's live panes. */
  show(t: Tile, panes: Tile[] = [t]): void {
    this.shown = t;
    this.surface = t.surface;
    this.panes = panes.some((p) => p.surface === t.surface) ? panes : [t, ...panes];
    // The row carries the tabs and icons: draw it now, sessions fill in when they load.
    if (this.bar.hidden) this.drawSessions(t);
    else this.drawTabs();
    this.term.show(t.surface);
    this.term.agentState(t.state, t.since);
    this.drawPlain(t);
    this.loadSessions(t);
    // The workspace, then what Claude says the conversation is about.
    const base = t.workspace_title || t.label;
    this.bar.title = t.topic ? `${base} · ${t.topic}` : base;
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
export type NowPage = { ws: string; kind: string; path: string; label: string; state: string; waiting: boolean; since: number; root: string };

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
  /** A local web page's URL, framed as it is (openWeb). */
  web?: string;
  /** Where the side column's icon sends it (panelinks.ts openElsewhere). */
  away?: Away | null;
};

/** Whether the Dock shows the Wake beside the terminal when no page is up.
 *  Off by default, so the terminal gets the width; ⌘E (or the header's Wake
 *  button) opens it, and the choice is remembered on this machine. */
const WAKE_OPEN_KEY = "seamux.dock.wakeOpen";
function wakeOpenPref(): boolean {
  try {
    return localStorage.getItem(WAKE_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The Dock's columns: a workspace's live terminal, and beside it its
 *  Wake and open pages. There is one, the Dock's: no page opens over the
 *  stage, so a link in a pane always lands beside that pane.
 *  The page side has tabs, grouped by kind: the workspace's Wake, then one
 *  chip each for its plan, reviews, asks, and anything else opened
 *  here; a chip holding several lists them. ⌘E shows the Wake and goes
 *  back; ⌘⇧P, ⌘⇧L, ⌘⇧A and ⌘⇧O jump to a group (again: its next tab);
 *  ⌘] and ⌘[ step through every tab; ⌘⇧E hides the side column. */
export class Sheet {
  el = document.createElement("div");
  private card = document.createElement("div");
  private body = document.createElement("div");
  private pageEl = document.createElement("div");
  private divider = document.createElement("div");
  private chat = new Chat();
  private say = document.createElement("span");
  private page: Page | null = null;
  /** Where the shown tab goes elsewhere, and the icon that sends it there. */
  private away: Away | null = null;
  private awayBtn = document.createElement("button");
  private lookoutBtn = document.createElement("button");
  private tiles: Tile[] = [];
  /** The pane picked in the chat's tabs; "" is the default (an agent's). */
  private picked = "";
  /** The page's workspace and directory, for the chat beside it. */
  private place: { workspace?: string; dir?: string } = {};
  private tabsEl = document.createElement("div");
  private stack = document.createElement("div");
  private tabs: Tab[] = [];
  private active = "";
  /** The directory the Wake tab was last pointed at. */
  private wakeDir = "";
  /** The page roots the Wake was last shown with (pageRoots). */
  private wakeRoots: string[] = [];
  /** The tab before the Wake, for ⌘E to go back to. */
  private back = "";
  /** Each group's tab last shown: its chip stands for it, and its key goes back to it. */
  private lastIn = new Map<GroupId, string>();
  /** A group's list of its tabs, open under its chip. */
  private groupMenu = document.createElement("div");
  /** What opened the list, for Escape to give focus back to. */
  private menuFrom: HTMLElement | null = null;
  /** The list last closed, and when: a click on its own count closes it by
   *  taking focus first, and must not open it again straight after. */
  private menuShut = { group: "", at: 0 };
  /** The strip's own word after a key that found nothing (flash). */
  private noteEl = document.createElement("span");
  /** The list is being redrawn: the item that had focus goes, and that is no leaving. */
  private refilling = false;
  /** Each group's tabs as its chip was last drawn, for an open list to follow a redraw. */
  private groupTabs = new Map<string, Tab[]>();
  /** The tab shown when the strip was last drawn (drawTabs's focus). */
  private drawnActive = "";
  private sayTimer = 0;
  /** The active tab was picked by the person (a click, a key, a page they
   *  opened), not by the sheet itself: a new page never comes forward over it. */
  private byHand = false;
  /** The Dock's Wake beside the terminal: shown, or folded away (wakeOpenPref). */
  private wakeOpen = wakeOpenPref();
  private wakeBtn = document.createElement("button");
  /** The Dock's side column hidden by hand while a page is up (the Wake's
   *  own open state is wakeOpen). Cleared by a new page or another workspace. */
  private pageHidden = false;
  private pages: NowPage[] = [];
  /** Every page seen so far, as ws + path: a page not in it just opened. */
  private seen = new Set<string>();
  private seeded = false;
  private wake: Wake | null = null;
  /** Plan families, for the strip that gets from a parent to its children. */
  private families: FamilyBrief[] = [];
  private kin = document.createElement("div");
  /** The workspace changed here (a family chip): the Dock view follows. */
  onPlace: (ws: string) => void = () => {};

  constructor() {
    this.el.className = "sheet";
    this.kin.className = "sheet-kin";
    this.kin.hidden = true;
    this.card.className = "sheet-card";
    this.say.className = "sheet-say";
    // The Dock folds the Wake away until asked: this brings it back.
    this.wakeBtn.type = "button";
    this.wakeBtn.className = "sheet-btn sheet-wake-btn";
    this.wakeBtn.title = "Show or hide the side column beside the terminal (⌘⇧E)";
    // An icon (a column beside a pane): what it shows or hides is in its tooltip.
    this.wakeBtn.classList.add("icon");
    this.wakeBtn.append(mark("M1.5 2h7v6h-7zM5.5 2v6"));
    this.wakeBtn.hidden = true;
    this.wakeBtn.addEventListener("click", () => this.toggleSide());
    // No header row of its own: its tools join the terminal's tab row, as
    // icons so the row stays short: VS Code (the chat's own), the side
    // column (⌘⇧E), and one way to cmux (the page beside its terminal, or
    // this pane; hidden on the tmux backend).
    // Open elsewhere: its tooltip names where (drawAway), on either backend.
    const toAway = this.awayBtn;
    toAway.type = "button";
    toAway.className = "sheet-btn icon sheet-away";
    toAway.append(mark("M3 7 7 3M4 3h3v3"));
    toAway.addEventListener("click", () => void this.elsewhere());
    // A review beside the work moves to its other home, the Lookout tab.
    const inLookout = this.lookoutBtn;
    inLookout.type = "button";
    inLookout.className = "sheet-btn quiet sheet-in-lookout";
    inLookout.textContent = "Show in Lookout";
    inLookout.title = "Show this review in the Lookout tab";
    inLookout.hidden = true;
    inLookout.addEventListener("click", () => {
      const id = this.page?.path.startsWith("/review/") ? this.page.path.slice("/review/".length).split(/[?#]/)[0] : "";
      if (id) window.dispatchEvent(new CustomEvent("seamux:review-in-lookout", { detail: { id } }));
    });
    this.chat.adopt([this.say, this.wakeBtn, inLookout, toAway]);
    this.body.className = "sheet-body";
    this.pageEl.className = "sheet-page";
    this.tabsEl.className = "sheet-tabs";
    this.tabsEl.setAttribute("role", "tablist");
    this.stack.className = "sheet-stack";
    this.groupMenu.className = "sheet-tabmenu";
    this.groupMenu.setAttribute("role", "menu");
    this.groupMenu.hidden = true;
    this.groupMenu.addEventListener("click", (e) => e.stopPropagation());
    this.groupMenu.addEventListener("keydown", (e) => {
      const its = [...this.groupMenu.querySelectorAll<HTMLButtonElement>("button")];
      const i = its.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        this.closeGroupMenu(true);
        e.stopImmediatePropagation();
        e.preventDefault();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && its.length) {
        e.preventDefault();
        its[(i + (e.key === "ArrowDown" ? 1 : -1) + its.length) % its.length].focus();
      } else if ((e.key === "Home" || e.key === "End") && its.length) {
        e.preventDefault();
        its[e.key === "Home" ? 0 : its.length - 1].focus();
      }
    });
    // Away on a click elsewhere, focus leaving it (Tab, a framed page), or the window going.
    document.addEventListener("click", () => this.closeGroupMenu());
    this.groupMenu.addEventListener("focusout", (e) => {
      if (this.refilling) return;
      if (!this.groupMenu.contains(e.relatedTarget as Node | null)) this.closeGroupMenu();
    });
    window.addEventListener("blur", () => this.closeGroupMenu());
    this.tabsEl.addEventListener("scroll", () => this.closeGroupMenu(), { passive: true });
    this.tabsEl.addEventListener("keydown", (e) => this.stripKey(e));
    // A page framed here asks for its GitHub links to open (lookout's
    // review page: the webview opens no windows). Only from a frame of this
    // sheet, at the intent server's origin, and only a github.com link.
    window.addEventListener("message", (e) => {
      const d = e.data as { lookout?: unknown; url?: unknown } | null;
      if (!d || typeof d !== "object" || d.lookout !== "open" || typeof d.url !== "string") return;
      if (!/^https:\/\/github\.com\//.test(d.url)) return;
      const f = [...this.stack.querySelectorAll("iframe")].find((x) => x.contentWindow === e.source);
      if (!f || e.origin !== new URL(f.src, location.href).origin) return;
      void invoke("open_url", { url: d.url }).catch((err) => (this.say.textContent = String(err)));
    });
    // Any seamux page framed here hands over its other links (deep-plan's
    // plan page: its trace and proof): a frame of this sheet, and
    // openFramed takes it only from the intent server's origin.
    window.addEventListener("message", (e) => {
      const d = e.data as { seamux?: unknown } | null;
      if (!d || typeof d !== "object" || d.seamux !== "open") return;
      if (![...this.stack.querySelectorAll("iframe")].some((x) => x.contentWindow === e.source)) return;
      void openFramed(d, e.origin);
    });
    this.noteEl.className = "sheet-tabs-note";
    this.noteEl.setAttribute("role", "status");
    this.pageEl.append(this.tabsEl, this.stack, this.groupMenu);
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
    this.card.append(this.kin, this.body);
    this.el.append(this.card);
  }

  /** Keys are this sheet's while the Dock is on screen. */
  private keysHere(): boolean {
    return this.el.getClientRects().length > 0;
  }

  /** Show a workspace: its terminal, and the Wake unless a page is up. */
  /** The place shown: a page opened for it joins its tabs. */
  here(): { workspace?: string; dir?: string } {
    return { ...this.place };
  }

  /** The workspace a link belongs to, from the panes and pages this sheet
   *  holds (linkroute.ts placeFor). */
  placeOfLink(target: { page?: string; file?: string }): string | undefined {
    return placeFor(target, this.tiles, this.pages);
  }

  /** Show workspace `ws` in the Dock, as a family chip does: the sheet
   *  enters it and the Dock follows (onPlace). */
  goTo(ws: string): void {
    if (ws === this.workspace() && this.active) return;
    this.enter({ workspace: ws });
    this.onPlace(ws);
  }

  /** The Dock's tab was selected: keys go to the shown pane (main.ts). */
  focusMain(): boolean {
    return !this.el.hidden && this.chat.focusTerm();
  }

  /** `show`: "wake" or "plan" go to that tab even when the workspace is
   *  already up. `pane`: show that pane's terminal (a pane row on the board). */
  focusWorkspace(ws: string, show = "any", pane = ""): void {
    if (ws !== this.workspace() || !this.active) {
      this.enter({ workspace: ws });
      if (!this.active) this.select(WAKE);
    }
    if (pane) {
      this.picked = pane;
      this.drawChat();
    }
    if (show === "wake") this.select(WAKE, true);
    else if (show === "plan") {
      const plan = this.tabs.find((t) => t.kind === "plan");
      if (plan) this.select(plan.key, true);
    }
  }

  /** Follow the panes, so the chat beside a page stays live, and each
   *  workspace's open pages, for the tabs. */
  async start(): Promise<void> {
    await listen<WallFrame>("wall:frame", (e) => {
      this.tiles = e.payload.tiles;
      if (!this.el.hidden) {
        this.drawChat();
        this.followDir();
      }
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
      const fresh = this.noteSeen(pages);
      if (!this.el.hidden) {
        this.syncTabs();
        // A page opened or closed: the Wake reads its root, or stops.
        this.followDir();
        // The sheet was entered before its pages were known: start on one now.
        if (!this.active) this.pickTab();
        // A page that just opened comes forward over the Wake, and one that
        // waits on you (an ask) over a tab the sheet picked by itself; never
        // over a page the person picked.
        else if (this.active === WAKE) this.raise(fresh);
        else if (!this.byHand) this.raise(fresh.filter((p) => p.waiting));
      }
    });
    // shell.rs's keys: they work with focus in a framed page too.
    await listen<string>("sheet:key", (e) => {
      if (!this.keysHere()) return;
      // ⌘E goes to the Wake and back (in the Dock, bringing a hidden column
      // back too); ⌘⇧E hides the Dock's column; ⌘⇧ and a letter, a group.
      if (e.payload === "wake") this.wakeKey();
      else if (e.payload === "hide") this.toggleSide();
      else if (e.payload === "next" || e.payload === "prev") this.step(e.payload === "next" ? 1 : -1);
      else if (e.payload.startsWith("group:")) this.jumpTo(e.payload.slice("group:".length) as GroupId);
    });
    // Frames go out only on change: start from the latest one.
    const [f, v] = await Promise.all([invoke<WallFrame | null>("wall_frame"), invoke<{ pages?: NowPage[]; families?: FamilyBrief[] } | null>("views_frame")]);
    if (f) this.tiles = f.tiles;
    if (v?.pages) this.pages = v.pages;
    this.noteSeen(this.pages);
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
    this.fold();
    if (t) this.chat.show(t, this.paneTiles());
  }

  /** Show a file's content: images as an image, HTML with scripts off, PDFs framed. */
  show(s: Shown, away: Away | null, place: { workspace?: string; dir?: string } = {}): void {
    this.enter(place, false);
    this.pageHidden = false;
    // Keyed by its path, so two README.md files keep a tab each.
    const key = `file:${away?.kind === "file" ? away.path : s.title}`;
    this.drop(key);
    this.addTab({ key, kind: "file", label: s.title, state: "", waiting: false, now: false, el: null, shown: s, away });
    this.select(key, true);
  }

  /** A local web page (a dev server on localhost) framed as a tab, with a
   *  way out to the browser for one that will not be framed. */
  openWeb(url: string, place: { workspace?: string; dir?: string } = {}): void {
    this.enter(place, false);
    // Opened by a click: seen, even if the side column was folded away.
    this.pageHidden = false;
    const key = `web:${url}`;
    this.drop(key);
    let label = url;
    try {
      const u = new URL(url);
      label = u.host + (u.pathname === "/" ? "" : u.pathname);
    } catch {
      /* shown as written */
    }
    this.addTab({ key, kind: "web", label, state: "", waiting: false, now: false, el: null, web: url, away: { kind: "web", url } });
    this.select(key, true);
  }

  async open(p: Page): Promise<void> {
    this.enter({ workspace: p.workspace, dir: p.dir }, false);
    this.pageHidden = false;
    // A page's tab is its path without the query (lookout's ?t=, the runs
    // page's ?back=), so it reuses the workspace's live tab; the query stays
    // in the frame's address (page.path).
    const key = bareOf(p.path);
    const t = this.tabs.find((x) => x.key === key);
    const away: Away = { kind: "page", path: p.path, workspace: p.workspace };
    if (t) {
      // A frame already drawn keeps the address it loaded from.
      t.page = t.el && t.page ? { ...p, path: t.page.path } : p;
      t.away = away;
    } else this.addTab({ key, kind: kindOf(key), label: p.title, state: "", waiting: false, now: false, el: null, page: p, away });
    this.select(key, true);
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

  /** Remember these pages as seen; return the ones that were not. The first
   *  call only remembers: pages open before the app looked are not new. */
  private noteSeen(pages: NowPage[]): NowPage[] {
    const key = (p: NowPage) => `${p.ws}\n${p.path}`;
    const fresh = this.seeded ? pages.filter((p) => !this.seen.has(key(p))) : [];
    this.seeded = true;
    for (const p of pages) this.seen.add(key(p));
    return fresh;
  }

  /** Bring forward the newest of these pages that is this workspace's:
   *  its plan, else one waiting on you, else any. */
  private raise(fresh: NowPage[]): void {
    const ws = this.workspace();
    const mine = fresh.filter((p) => p.ws === ws && this.tabs.some((t) => t.key === p.path));
    const p = mine.find((x) => x.kind === "plan") ?? mine.find((x) => x.waiting) ?? mine[0];
    if (p) {
      // A new page wants to be seen, even if the side column was hidden.
      this.pageHidden = false;
      this.select(p.path);
    }
  }

  /** A new place starts on a page, not blank: its plan, else what waits on you, else the Wake. */
  private pickTab(): void {
    if (this.active && this.tabs.some((t) => t.key === this.active)) return;
    const pages = this.tabs.filter((t) => t.key !== WAKE);
    const t = pages.find((x) => x.kind === "plan") ?? pages.find((x) => x.waiting) ?? pages[0];
    this.select((t ?? this.tabs.find((x) => x.key === WAKE))?.key ?? WAKE);
  }

  /** A tab opened here joins its kind's place in the strip, so ⌘] and ⌘[
   *  step through the tabs in the order the strip draws them. */
  private addTab(t: Tab): void {
    this.tabs = ordered([...this.tabs, t]);
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
    this.lastIn.clear();
    this.closeGroupMenu();
    // Another workspace: its Wake starts without the last one's preview.
    this.wake?.clearPreview();
    this.byHand = false;
    this.picked = "";
    this.pageHidden = false;
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
          page: had?.page ?? { path: p.path, title: p.label, workspace: ws }, away: had?.away ?? { kind: "page", path: p.path, workspace: ws },
        };
      });
    // A page that left the list (answered, closed) keeps its tab while it is shown.
    const rest = this.tabs.filter((t) => t.key !== WAKE && !live.some((l) => l.key === t.key) && (!t.now || t.key === this.active));
    for (const t of this.tabs) if (t.key !== WAKE && !live.some((l) => l.key === t.key) && !rest.includes(t)) t.el?.remove();
    this.tabs = ordered([wake, ...live, ...rest.map((t) => ({ ...t, waiting: false }))]);
    this.drawTabs();
  }

  /** The strip: the Wake, then one chip per group that has a tab. A chip
   *  at rest names only its kind (with a count, and a dot when one of its
   *  pages waits on you), so every kind fits; the chip shown also names its
   *  page. A kind with several lists them from its count. */
  private drawTabs(): void {
    const chips: HTMLElement[] = [];
    this.groupTabs.clear();
    const wake = this.tabs.find((t) => t.key === WAKE);
    if (wake) chips.push(this.chip(wake, "Wake", [wake], "⌘E", "This workspace's Wake (⌘E, and again to go back)"));
    for (const g of GROUPS) {
      const its = round(this.tabs.filter((t) => groupOf(t.kind) === g.id));
      if (!its.length) continue;
      const k = face(this.tabs, g.id, this.active, this.lastIn.get(g.id) ?? "");
      const t = its.find((x) => x.key === k) ?? its[0];
      const waits = its.filter((x) => x.waiting).length;
      const tip = [
        `${g.label}: ${t.label}${t.state ? " · " + t.state : ""}`,
        waits ? `${waits} waiting on you` : "",
        `⌘⇧${g.key}${its.length > 1 ? `, again for the next of ${its.length}` : ""}`,
      ].filter(Boolean).join(" · ");
      chips.push(this.chip(t, g.label, its, `⌘⇧${g.key}`, tip, g.id));
    }
    // Roving focus, as in the pane row: one Tab stop, arrows between chips.
    const on = chips.find((c) => c.classList.contains("on")) ?? chips[0];
    for (const c of chips) c.querySelector<HTMLButtonElement>(".sheet-tab")!.tabIndex = c === on ? 0 : -1;
    // A redraw (a page's state moved on) keeps the chip that had focus.
    // If the page shown changed meanwhile (a key), focus follows it, so a
    // ring never marks a chip that is not the one shown.
    const had = (document.activeElement as HTMLElement | null)?.closest?.(".sheet-grp") as HTMLElement | null;
    const hadKind = had && this.tabsEl.contains(had) ? (this.drawnActive === this.active ? had.dataset.kind : on.dataset.kind) : undefined;
    this.drawnActive = this.active;
    // An open list stays open over a redraw, rebuilt from the new chip, on the item that had focus.
    const listFor = this.groupMenu.hidden ? "" : this.groupMenu.dataset.for ?? "";
    const listAt = [...this.groupMenu.querySelectorAll("button")].indexOf(document.activeElement as HTMLButtonElement);
    this.tabsEl.replaceChildren(...chips, this.noteEl);
    if (listFor) {
      const chip = chips.find((c) => c.dataset.group === listFor);
      const its = chip ? this.groupTabs.get(listFor) : undefined;
      if (chip && its && its.length > 1) this.fillGroupMenu(chip, its, chip.querySelector<HTMLElement>(".sheet-tab")!, listAt);
      else this.closeGroupMenu();
    }
    if (hadKind) {
      const b = chips.find((c) => c.dataset.kind === hadKind)?.querySelector<HTMLButtonElement>(".sheet-tab");
      if (b) {
        for (const c of chips) c.querySelector<HTMLButtonElement>(".sheet-tab")!.tabIndex = -1;
        b.tabIndex = 0;
        b.focus();
      }
    }
    this.tabsEl.querySelector(".on")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  /** One chip: a button for tab `t`, and for a group of several, a count
   *  that lists them. A click on the chip of the group shown lists them too. */
  private chip(t: Tab, kind: string, its: Tab[], key: string, tip: string, group?: GroupId): HTMLElement {
    const on = its.some((x) => x.key === this.active);
    const waiting = its.some((x) => x.waiting);
    const wrap = document.createElement("span");
    wrap.className = "sheet-grp" + (on ? " on" : "") + (waiting ? " waiting" : "") + (t.key === WAKE ? " wake" : "");
    wrap.dataset.kind = group ?? WAKE;
    wrap.setAttribute("role", "presentation");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sheet-tab" + (on ? " on" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(on));
    // A kind's key: its letter, with ⌘⇧ before it where the column has room.
    const k = document.createElement("kbd");
    if (key.startsWith("⌘⇧")) {
      const mod = document.createElement("span");
      mod.className = "mod";
      mod.textContent = "⌘⇧";
      k.append(mod, key.slice(2));
    } else k.textContent = key;
    const kindEl = document.createElement("span");
    kindEl.className = "sheet-tab-kind";
    kindEl.textContent = kind;
    b.append(k, kindEl);
    // The dot sits by the kind it belongs to, before any name that may clip.
    if (waiting) b.append(needsYou(its.filter((x) => x.waiting).length));
    // Only the chip shown names its page; the Wake's name is the workspace's, above.
    if (on && t.key !== WAKE) b.append(...tabWords(t));
    b.title = tip;
    b.setAttribute("aria-label", tip);
    const many = !!group && its.length > 1;
    b.addEventListener("click", (e) => {
      if (on && many) {
        e.stopPropagation();
        this.toggleGroupMenu(wrap, its, b);
      } else {
        this.pageHidden = false;
        this.select(t.key, true);
      }
    });
    if (many) {
      // ↓ on a chip lists its pages, as its count does.
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown") return;
        e.preventDefault();
        e.stopPropagation();
        this.toggleGroupMenu(wrap, its, b);
      });
    }
    wrap.append(b);
    if (many) {
      wrap.dataset.group = group;
      this.groupTabs.set(group!, its);
      const more = document.createElement("button");
      more.type = "button";
      more.tabIndex = -1;
      more.className = "sheet-tab-more";
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.title = `All ${its.length} ${kind.toLowerCase()} pages`;
      more.setAttribute("aria-label", more.title);
      // On the chip shown, where it is in the round: "2/3".
      // Beside a badge of how many wait, a second bare number would read as
      // one; there the count is the caret alone, and its tooltip says it.
      const at = its.findIndex((x) => x.key === this.active);
      const badge = its.filter((x) => x.waiting).length > 1;
      const n = document.createElement("span");
      n.textContent = at >= 0 ? `${at + 1}/${its.length}` : badge ? "" : String(its.length);
      more.append(n, mark("M3 4.5 5 6.5 7 4.5"));
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleGroupMenu(wrap, its, b);
      });
      wrap.append(more);
    }
    return wrap;
  }

  /** ← → Home End move between the chips; Enter or Space picks one. */
  private stripKey(e: KeyboardEvent): void {
    const tabs = [...this.tabsEl.querySelectorAll<HTMLButtonElement>(".sheet-tab")];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const to = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    for (const t of tabs) t.tabIndex = -1;
    tabs[to].tabIndex = 0;
    tabs[to].focus();
  }

  /** The list of a group's tabs under its chip, the one shown marked; or
   *  away, when it is already open for that chip. `from`: what opened it,
   *  where Escape puts focus back. */
  private toggleGroupMenu(chip: HTMLElement, its: Tab[], from: HTMLElement): void {
    const g = chip.dataset.group ?? "";
    if (!this.groupMenu.hidden && this.groupMenu.dataset.for === g) return this.closeGroupMenu();
    if (this.menuShut.group === g && Date.now() - this.menuShut.at < 300) return;
    this.closeGroupMenu();
    this.fillGroupMenu(chip, its, from, "shown");
  }

  /** Draw the list under `chip`. `focus`: "shown" puts focus on the tab
   *  shown (or the first); a number, on that item (a redraw keeping its
   *  place); -1 leaves focus where it is. */
  private fillGroupMenu(chip: HTMLElement, its: Tab[], from: HTMLElement, focus: "shown" | number): void {
    const g = chip.dataset.group ?? "";
    this.menuFrom = from;
    this.groupMenu.dataset.for = g;
    this.refilling = true;
    this.groupMenu.replaceChildren(
      ...its.map((t) => {
        const i = document.createElement("button");
        i.type = "button";
        i.className = "sheet-tabmenu-item" + (t.key === this.active ? " on" : "");
        i.setAttribute("role", "menuitemradio");
        i.setAttribute("aria-checked", String(t.key === this.active));
        if (t.waiting) i.append(needsYou());
        i.append(...tabWords(t));
        i.title = `${t.label}${t.state ? " · " + t.state : ""}${t.waiting ? " · waiting on you" : ""}`;
        i.addEventListener("click", () => {
          this.closeGroupMenu();
          this.pageHidden = false;
          this.select(t.key, true);
        });
        return i;
      }),
    );
    // Fixed, under the chip: the strip scrolls sideways and would clip it.
    const r = chip.getBoundingClientRect();
    this.groupMenu.hidden = false;
    const w = this.groupMenu.offsetWidth;
    this.groupMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    this.groupMenu.style.top = `${r.bottom + 4}px`;
    chip.querySelector(".sheet-tab-more")?.setAttribute("aria-expanded", "true");
    const items = [...this.groupMenu.querySelectorAll<HTMLButtonElement>("button")];
    this.refilling = false;
    if (focus === "shown") (items.find((i) => i.classList.contains("on")) ?? items[0])?.focus();
    else if (focus >= 0) items[Math.min(focus, items.length - 1)]?.focus();
  }

  private closeGroupMenu(refocus = false): void {
    if (this.groupMenu.hidden) return;
    const g = this.groupMenu.dataset.for ?? "";
    this.groupMenu.hidden = true;
    this.groupMenu.dataset.for = "";
    this.menuShut = { group: g, at: Date.now() };
    [...this.tabsEl.querySelectorAll<HTMLElement>(".sheet-grp")]
      .find((x) => x.dataset.group === g)
      ?.querySelector(".sheet-tab-more")
      ?.setAttribute("aria-expanded", "false");
    const from = this.menuFrom;
    this.menuFrom = null;
    if (refocus && from?.isConnected) from.focus();
  }

  /** ⌘⇧ and a group's letter: that group's tab, or its next one when it is
   *  shown already (sheetgroups.ts's jump). Picking by key means to see it,
   *  so a hidden column comes back. */
  private jumpTo(group: GroupId): void {
    const g = GROUPS.find((x) => x.id === group);
    if (!g) return;
    this.closeGroupMenu();
    const key = jump(this.tabs, group, this.active, this.lastIn.get(group) ?? "");
    if (!key) return this.flash(group === "other" ? "nothing else open here" : `no ${g.label.toLowerCase()} open here`);
    this.pageHidden = false;
    this.select(key, true);
  }

  /** A quiet word at the end of the strip, where the eye is after a key,
   *  that goes again after a moment. With the column hidden, the strip is
   *  too: it goes in the terminal's row instead. */
  /** A failed open, said where the sheet says its own errors (the tab
   *  strip's note, or the chat row's when the page side is folded), for a
   *  few seconds and not dimmed. */
  notice(text: string): void {
    const at = this.isFolded() ? this.say : this.noteEl;
    at.textContent = text;
    at.classList.remove("quiet");
    clearTimeout(this.sayTimer);
    this.sayTimer = window.setTimeout(() => {
      if (at.textContent === text) at.textContent = "";
    }, 6000);
  }

  private flash(text: string): void {
    const at = this.isFolded() ? this.say : this.noteEl;
    at.textContent = text;
    at.classList.add("quiet");
    clearTimeout(this.sayTimer);
    this.sayTimer = window.setTimeout(() => {
      if (at.textContent === text) at.textContent = "";
      at.classList.remove("quiet");
    }, 2500);
  }

  /** ⌘E in the Dock: the Wake, with the column brought back if it was
   *  hidden; on the Wake already, back to the page before it. (⌘⇧E hides
   *  the column.) */
  private wakeKey(): void {
    if (this.active === WAKE && !this.isFolded()) {
      // The page before the Wake; if it has closed, the first page open.
      const back = this.tabs.find((t) => t.key === this.back && t.key !== WAKE) ?? this.tabs.find((t) => t.key !== WAKE);
      if (back) {
        this.pageHidden = false;
        this.select(back.key, true);
      } else this.flash("no page to go back to");
      return;
    }
    this.pageHidden = false;
    // Asked for by key: the Wake stays open beside the terminal from now on.
    if (this.body.classList.contains("with-chat") && !this.wakeOpen) {
      this.wakeOpen = true;
      try {
        localStorage.setItem(WAKE_OPEN_KEY, "1");
      } catch {
        // A private window: the choice lasts this session.
      }
    }
    this.select(WAKE, true);
  }

  private setWakeOpen(on: boolean): void {
    this.wakeOpen = on;
    try {
      localStorage.setItem(WAKE_OPEN_KEY, on ? "1" : "0");
    } catch {
      // A private window: the choice lasts this session.
    }
    this.fold();
  }

  /** The Dock's side column folds away and the terminal takes the width:
   *  the Wake while it is closed (the remembered choice), a page (a plan, a
   *  review, an ask) while it is hidden by hand. */
  private isFolded(): boolean {
    // With no terminal to widen (a workspace before its first pane), the column stays.
    if (!this.body.classList.contains("with-chat")) return false;
    return this.active === WAKE ? !this.wakeOpen : this.pageHidden;
  }

  private fold(): void {
    const folded = this.isFolded();
    this.body.classList.toggle("page-folded", folded);
    this.drawAway(folded);
    // One button, always there in the Dock: it says what it brings back, or hides.
    const t = this.tabs.find((x) => x.key === this.active);
    const what = this.active === WAKE || !t ? "Wake" : t.kind === "page" ? "page" : t.kind;
    this.wakeBtn.title = folded ? `Show the ${what} beside the terminal${this.active === WAKE ? " (⌘E)" : ""}` : "Hide the side column (⌘⇧E)";
    // Hidden, the column cannot show a page that waits on you: its button does.
    const waits = folded ? this.tabs.filter((x) => x.waiting).length : 0;
    if (waits) this.wakeBtn.title += ` · ${waits} waiting on you`;
    this.wakeBtn.classList.toggle("waiting", waits > 0);
    this.wakeBtn.setAttribute("aria-label", this.wakeBtn.title);
    this.wakeBtn.classList.toggle("on", !folded);
    this.wakeBtn.hidden = !this.body.classList.contains("with-chat");
  }

  /** ⌘⇧E in the Dock (and its column button): the side column away, or back, whatever it holds. */
  private toggleSide(): void {
    // No terminal to widen (a workspace before its first pane): nothing folds,
    // so nothing to change or remember.
    if (!this.body.classList.contains("with-chat")) return;
    const show = this.isFolded();
    if (this.active === WAKE) this.setWakeOpen(show);
    else {
      this.pageHidden = !show;
      this.fold();
    }
  }

  private step(by: number): void {
    if (!this.tabs.length) return;
    const i = Math.max(0, this.tabs.findIndex((t) => t.key === this.active));
    // Stepping to a tab means to see it: a hidden column comes back.
    this.pageHidden = false;
    this.select(this.tabs[(i + by + this.tabs.length) % this.tabs.length].key, true);
  }

  /** Show tab `key`. `hand`: the person picked it, so no new page jumps over it. */
  private select(key: string, hand = false): void {
    const t = this.tabs.find((x) => x.key === key);
    if (!t) return;
    if (key === WAKE && this.active && this.active !== WAKE) this.back = this.active;
    const g = groupOf(t.kind);
    if (g !== WAKE) this.lastIn.set(g, key);
    this.closeGroupMenu();
    this.active = key;
    this.byHand = hand;
    this.page = t.page ?? null;
    this.away = t.away ?? null;
    this.say.textContent = "";
    // A page that could not load (the server was down) tries again.
    if (t.el?.dataset.failed) {
      t.el.remove();
      t.el = null;
    }
    if (!t.el) this.build(t);
    for (const x of this.tabs) if (x.el) x.el.hidden = x.key !== key;
    if (key === WAKE) {
      this.wakeDir = this.dir();
      this.wakeRoots = this.pageRoots();
      this.wakeView().showDir(this.wakeDir, this.wakeRoots);
    }
    this.drawTabs();
    this.fold();
  }

  /** A workspace picked before its first tile came (a new one) has no
   *  directory yet: once a frame brings it, the Wake shown moves there. */
  private followDir(): void {
    if (this.active !== WAKE || !this.wake) return;
    const d = this.dir();
    const roots = this.pageRoots();
    if (!d) return;
    if (d === this.wakeDir) {
      // Only the pages changed: their roots join the rows, the view stays.
      if (roots.join("\n") === this.wakeRoots.join("\n")) return;
      this.wakeRoots = roots;
      this.wake.setAlso(d, roots);
      return;
    }
    this.wakeDir = d;
    this.wakeRoots = roots;
    this.wake.showDir(d, roots);
  }

  /** Where this workspace's open pages are filed in the Wake: a plan's or a
   *  review's root, an ask's cwd. A pane may work outside them. */
  private pageRoots(): string[] {
    const ws = this.workspace();
    return [...new Set(this.pages.filter((p) => p.ws === ws && p.root).map((p) => p.root))].sort();
  }

  /** The Dock's PR pill: the Wake (already shown for the workspace) on
   *  that group of its pull requests. */
  showPrs(group: string): void {
    // For this workspace's directory: a Wake still on the last workspace
    // keeps the focus until it moves here.
    this.wakeView().showPrs(group, this.dir());
  }

  private wakeView(): Wake {
    if (!this.wake) {
      const root = document.createElement("div");
      root.className = "sheet-wake";
      this.wake = new Wake(root, this);
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
    if (t.web) {
      const url = t.web;
      const bar = document.createElement("div");
      bar.className = "sheet-webbar";
      const where = document.createElement("span");
      where.className = "sheet-weburl";
      where.textContent = url;
      where.title = url;
      const reload = document.createElement("button");
      reload.type = "button";
      reload.className = "sheet-btn";
      reload.textContent = "Reload";
      const out = document.createElement("button");
      out.type = "button";
      out.className = "sheet-btn";
      out.textContent = "Open in browser";
      out.addEventListener("click", () => void invoke("open_url", { url }).catch(() => {}));
      bar.append(where, reload, out);
      const frame = document.createElement("iframe");
      frame.title = t.label;
      // A dev server's page runs its scripts and forms in its own origin, but
      // never navigates the app's window or reaches past its frame.
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.src = url;
      reload.addEventListener("click", () => (frame.src = url));
      box.classList.add("web");
      box.append(bar, frame);
      return;
    }
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
      } else if (s.kind === "video") {
        const v = document.createElement("video");
        v.className = "sheet-img";
        v.controls = true;
        v.preload = "metadata";
        v.src = s.data;
        const ib = document.createElement("div");
        ib.className = "sheet-imgbox";
        ib.append(v);
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
    const down = (why: string, text?: string) => {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = text ?? `The intent server is down (${why}), so this page can't be shown here. Open in cmux may still work once it is back. `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "sheet-btn";
      retry.textContent = "Retry";
      // Selecting a page that failed builds it again (see select).
      retry.addEventListener("click", () => this.select(t.key, true));
      n.append(retry);
      box.replaceChildren(n);
      box.dataset.failed = "1";
    };
    invoke<IntentServer>("intent_server").then(async (server) => {
      if (!server.up || !server.origin) return down(server.reason ?? "no answer");
      // The page's own address, query and all (a lookout ?t=); the tab is its bare path.
      let src = server.origin + (t.page?.path ?? t.key);
      // A plan's scenarios page asks for its key, which only the app reads
      // (shell.rs scenarios_key): the intent server never hands it out.
      const scn = /^\/scenarios\/([a-z0-9][a-z0-9._-]*)$/.exec(t.key);
      if (scn) {
        try {
          src += "?k=" + encodeURIComponent(await invoke<string>("scenarios_key", { slug: scn[1] }));
        } catch (e) {
          return down(String(e), `This plan's scenarios page can't be opened: ${String(e)}. `);
        }
      }
      const f = document.createElement("iframe");
      f.src = src;
      f.title = t.label;
      box.append(f);
    }, (e) => down(String(e)));
  }

  /** The icon says where the shown tab goes elsewhere. With the page side
   *  folded it is the pane, which only cmux can take; on tmux there is then
   *  nowhere else, and the icon hides. */
  private drawAway(folded = this.body.classList.contains("page-folded")): void {
    const tmux = document.body.dataset.backend === "tmux";
    const label = folded ? (tmux ? "" : "Open this pane in cmux") : awayLabel(this.away ?? (this.page ? { kind: "page", path: this.page.path, workspace: this.page.workspace } : null));
    this.awayBtn.hidden = !label;
    this.lookoutBtn.hidden = folded || !this.page?.path.startsWith("/review/");
    this.awayBtn.title = label;
    this.awayBtn.setAttribute("aria-label", label);
  }

  private async elsewhere(): Promise<void> {
    // The Dock with no page up: the pane itself, in cmux.
    if (this.body.classList.contains("page-folded")) {
      if (document.body.dataset.backend !== "tmux") return this.chat.jumpToPane();
      return;
    }
    const a = this.away ?? (this.page ? { kind: "page" as const, path: this.page.path, workspace: this.page.workspace } : null);
    if (!a) return;
    try {
      await openElsewhere(a);
    } catch (e) {
      this.say.textContent = String(e);
    }
  }
}

/** A tab's name and state, as its chip and its group's list show them. */
function tabWords(t: { label: string; state: string }): HTMLElement[] {
  const name = document.createElement("span");
  name.className = "sheet-tab-name";
  name.textContent = t.label;
  if (!t.state) return [name];
  const st = document.createElement("span");
  st.className = "sheet-tab-state";
  st.textContent = t.state;
  return [name, st];
}

/** The dot on a tab that waits on you (an ask); with several waiting, a
 *  badge with their number, so it is not said by colour alone. */
function needsYou(n = 1): HTMLElement {
  const dot = document.createElement("i");
  dot.className = "sheet-tab-dot" + (n > 1 ? " count" : "");
  if (n > 1) dot.textContent = String(n);
  dot.setAttribute("aria-label", n > 1 ? `${n} waiting on you` : "waiting on you");
  return dot;
}

/** A page path without its query or fragment: the tab it is. */
function bareOf(path: string): string {
  return path.split("#")[0].split("?")[0];
}

function kindOf(path: string): string {
  return path.startsWith("/review/") ? "review" : path.startsWith("/ask/") ? "ask" : path.startsWith("/plan/") ? "plan"
    : path.startsWith("/scenarios/") ? "scenarios"
    : path.startsWith("/agent/") ? "agent" : path.startsWith("/run/") ? "run" : path.startsWith("/runs/") ? "agents" : "page";
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

/** The Dock's own sheet, its side column, once the Dock has made it. */
let docked: Sheet | null = null;

/** The Dock says which sheet is its side column (dock.ts). */
export function setDockSheet(s: Sheet): void {
  docked = s;
}

/** Where a pane's link opens a page: the Dock's side column, beside the
 *  terminal and in the workspace it shows. With another view up (Lookout)
 *  the Dock comes forward first (main.ts): a page never opens anywhere else. */
/** Say a failed open in the Dock's side column (Sheet.notice). */
export function noticeInDock(text: string): void {
  docked?.notice(text);
}

/** The workspace a link belongs to, without moving the Dock. */
export function peekPlace(target: { page?: string; file?: string }): string | undefined {
  return docked?.placeOfLink(target);
}

export function linkSheet(place: { workspace?: string; dir?: string }, target: { page?: string; file?: string } = {}): { sheet: Sheet; place: { workspace?: string; dir?: string } } | null {
  if (!docked) return null;
  // The Dock comes forward, and the Bosun's drop-down goes away (main.ts),
  // before the link opens: what opens is then in view and keeps the focus.
  window.dispatchEvent(new CustomEvent("seamux:show-dock"));
  // The link's own workspace, then the pane's it came from; else the Dock's.
  const own = docked.placeOfLink(target) ?? place.workspace;
  if (own) {
    docked.goTo(own);
    return { sheet: docked, place: { workspace: own } };
  }
  const here = docked.here();
  return { sheet: docked, place: here.workspace || here.dir ? here : place };
}
