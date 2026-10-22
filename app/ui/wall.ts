import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reflow, type Block } from "./reflow";

/** One re-flowed paragraph: wraps at the window, hanging past its marker. */
function flowLine(b: Block): HTMLElement {
  const el = document.createElement("div");
  el.className = "ln";
  el.style.paddingLeft = `${b.start}ch`;
  el.style.textIndent = `-${b.hang}ch`;
  el.textContent = b.text || " ";
  return el;
}

// The shapes of wall.rs's Frame and Tile.
export type Tile = {
  surface: string;
  workspace: string;
  workspace_title: string;
  label: string;
  cwd: string;
  agent: string | null;
  state: string;
  lines: string[];
  error: string | null;
  /** The workspace's cmux colour, when it has one. */
  color: string | null;
  /** When the pane entered its current state (ms since the epoch). */
  since: number;
};
export type Frame = { tiles: Tile[]; error: string | null };

/** The list's order: who needs you (longest waiting first), then work, then rest. */
const RANK: Record<string, number> = { needs_input: 0, working: 1, idle: 2, ended: 3, shell: 4 };
const SECTION: Record<string, string> = {
  needs_input: "Needs you",
  working: "Working",
  idle: "Idle",
  ended: "Idle",
  shell: "Terminals",
};

function rank(a: Tile, b: Tile): number {
  const r = (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5);
  if (r) return r;
  // Needs you: the one waiting longest first. Elsewhere: cmux's own order.
  return a.state === "needs_input" ? a.since - b.since : 0;
}

/** A turn ended: the agent was working and now waits or rests. */
function finishedTurn(before: string | undefined, after: string): boolean {
  return before === "working" && (after === "needs_input" || after === "idle");
}

/** 45s, 4m, 1h 5m, 2d: how long, short. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "<1m";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const SVG = "http://www.w3.org/2000/svg";

/** Filled for needs-you, half for working, hollow for idle, a dash for a shell. */
function stateMark(state: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("class", "mark");
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  };
  if (state === "needs_input") shape("circle", { cx: "5", cy: "5", r: "4", class: "fill" });
  else if (state === "working") {
    shape("circle", { cx: "5", cy: "5", r: "3.5", class: "ring" });
    shape("path", { d: "M5 1.5a3.5 3.5 0 0 1 0 7z", class: "fill" });
  } else if (state === "shell") shape("path", { d: "M2.5 5h5", class: "ring" });
  else shape("circle", { cx: "5", cy: "5", r: "3.5", class: "ring" });
  return svg;
}

const STATE_WORDS: Record<string, string> = {
  needs_input: "needs you",
  working: "working",
  idle: "idle",
  ended: "ended",
  shell: "terminal",
};

function titleOf(t: Tile): string {
  return t.workspace_title || t.label || "terminal";
}
function subOf(t: Tile): string {
  return t.workspace_title && t.label !== t.workspace_title ? t.label : t.cwd;
}
/** A #RRGGBB the page can trust in a style, or "". */
function safeColor(c: string | null): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "";
}

/** One row in the list, kept across frames. */
class Row {
  el = document.createElement("button");
  private mark = document.createElement("span");
  private title = document.createElement("span");
  private sub = document.createElement("span");
  private wait = document.createElement("span");
  tile!: Tile;

  constructor(surface: string, pick: (surface: string) => void) {
    this.el.type = "button";
    this.el.className = "row";
    this.el.dataset.surface = surface;
    this.el.setAttribute("role", "option");
    this.mark.className = "state";
    this.title.className = "title";
    this.sub.className = "sub";
    this.wait.className = "wait";
    const names = document.createElement("span");
    names.className = "names";
    names.append(this.title, this.sub);
    this.el.append(this.mark, names, this.wait);
    this.el.addEventListener("click", () => pick(surface));
  }

  update(t: Tile, now: number): void {
    const before = this.tile?.state;
    this.tile = t;
    this.el.dataset.state = t.state;
    const c = safeColor(t.color);
    this.el.style.setProperty("--ws", c || "transparent");
    this.mark.replaceChildren(stateMark(t.state));
    this.title.textContent = titleOf(t);
    this.sub.textContent = subOf(t);
    this.tick(now);
    // Newly waiting on you: a seam stitches down the row's edge, once.
    if (before !== undefined && before !== "needs_input" && t.state === "needs_input") {
      this.el.classList.remove("arrived");
      void this.el.offsetWidth;
      this.el.classList.add("arrived");
    }
  }

  tick(now: number): void {
    const waiting = this.tile.state === "needs_input";
    this.wait.textContent = waiting ? ago(now - this.tile.since) : "";
    this.wait.title = waiting ? `waiting since ${new Date(this.tile.since).toLocaleTimeString()}` : "";
  }
}

/** The selected pane, large: header, its last words, reply and jump. */
class Preview {
  el = document.createElement("article");
  private titleEl = document.createElement("span");
  private subEl = document.createElement("span");
  private stateEl = document.createElement("span");
  private body = document.createElement("pre");
  private form = document.createElement("form");
  private input = document.createElement("input");
  private send = document.createElement("button");
  private jumpBtn = document.createElement("button");
  private note = document.createElement("span");
  private surface = "";
  private lastText = "";
  private lastState = "";
  /** Unsent replies by surface: switching agents keeps each one's draft. */
  private drafts = new Map<string, string>();

  constructor() {
    this.el.className = "preview";
    const head = document.createElement("header");
    const names = document.createElement("div");
    names.className = "names";
    this.titleEl.className = "title";
    this.subEl.className = "sub";
    names.append(this.titleEl, this.subEl);
    this.stateEl.className = "state";
    head.append(names, this.stateEl);

    this.input.type = "text";
    this.input.placeholder = "Reply…";
    this.input.spellcheck = false;
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // the list's keys and ⌘1…⌘4 stay out of a reply
      if (e.key === "Escape") this.input.blur();
    });
    this.input.addEventListener("input", () => {
      this.send.hidden = !this.input.value.trim();
      this.drafts.set(this.surface, this.input.value);
    });
    this.send.type = "submit";
    this.send.className = "send";
    this.send.textContent = "Send";
    this.send.hidden = true;
    this.form.className = "reply";
    this.form.append(this.input, this.send);
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.reply();
    });
    this.jumpBtn.type = "button";
    this.jumpBtn.className = "jump";
    this.jumpBtn.title = "Show this pane in cmux (J)";
    this.jumpBtn.append(document.createTextNode("Jump "));
    const arrow = document.createElementNS(SVG, "svg");
    arrow.setAttribute("viewBox", "0 0 10 10");
    arrow.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", "M3 7 7 3M4 3h3v3");
    arrow.append(p);
    this.jumpBtn.append(arrow);
    this.jumpBtn.addEventListener("click", () => void this.jump());
    this.note.className = "note-line";
    const foot = document.createElement("footer");
    foot.append(this.form, this.jumpBtn, this.note);
    this.el.append(head, this.body, foot);
  }

  get current(): string {
    return this.surface;
  }

  show(t: Tile, now: number): void {
    const switched = t.surface !== this.surface;
    if (switched) {
      this.drafts.set(this.surface, this.input.value);
      this.surface = t.surface;
      this.input.value = this.drafts.get(t.surface) ?? "";
      this.send.hidden = !this.input.value.trim();
      this.note.textContent = "";
      this.lastText = "";
    }
    this.el.dataset.state = t.state;
    this.el.style.setProperty("--ws", safeColor(t.color) || "var(--line)");
    this.titleEl.textContent = titleOf(t);
    this.subEl.textContent = subOf(t);
    const waited = t.state === "needs_input" ? ` · ${ago(now - t.since)}` : "";
    this.stateEl.replaceChildren(stateMark(t.state), document.createTextNode((STATE_WORDS[t.state] ?? t.state) + waited));
    // Wall::reply refuses a pane without a running agent; so does the page.
    this.form.hidden = !t.agent || t.state === "ended";
    if (t.error) {
      this.body.textContent = `Couldn't read this pane: ${t.error}`;
      this.body.classList.add("err");
      this.lastText = "";
    } else {
      this.body.classList.remove("err");
      const text = t.lines.join("\n");
      if (text !== this.lastText) {
        // Follow the newest lines, unless the person scrolled up to read:
        // then an update leaves them where they are.
        const b = this.body;
        const atEnd = switched || b.scrollHeight - b.scrollTop - b.clientHeight < 24;
        if (t.agent && text) {
          // An agent's prose re-flows to the window; a shell keeps the
          // terminal's own layout.
          b.classList.add("flow");
          b.replaceChildren(...reflow(t.lines).map(flowLine));
        } else {
          b.classList.remove("flow");
          b.textContent = text || "(nothing on screen yet)";
        }
        this.lastText = text;
        if (atEnd) requestAnimationFrame(() => (b.scrollTop = b.scrollHeight));
      }
    }
    if (!switched && finishedTurn(this.lastState, t.state)) this.stitch();
    this.lastState = t.state;
  }

  focusReply(): void {
    if (!this.form.hidden) this.input.focus();
  }

  /** The seam runs across the preview's top edge once. */
  private stitch(): void {
    this.el.classList.remove("stitched");
    void this.el.offsetWidth;
    this.el.classList.add("stitched");
  }

  private say(text: string, bad = false): void {
    this.note.textContent = text;
    this.note.classList.toggle("bad", bad);
    if (!bad) setTimeout(() => this.note.textContent === text && (this.note.textContent = ""), 2500);
  }

  private async reply(): Promise<void> {
    const text = this.input.value;
    const surface = this.surface;
    if (!text.trim()) return;
    this.input.disabled = true;
    this.send.disabled = true;
    this.say("Sending…");
    try {
      await invoke("wall_reply", { surfaceId: surface, text });
      this.drafts.delete(surface);
      if (this.surface === surface) {
        this.input.value = "";
        this.send.hidden = true;
      }
      this.say("Sent");
    } catch (e) {
      this.say(String(e), true);
    } finally {
      this.input.disabled = false;
      this.send.disabled = false;
      const at = document.activeElement;
      if (!at || at === document.body || at === this.input) this.input.focus();
    }
  }

  async jump(): Promise<void> {
    try {
      await invoke("wall_jump", { surfaceId: this.surface });
      await invoke("hide_overlay");
    } catch (e) {
      this.say(String(e), true);
    }
  }
}

const SLEEPING_CAT = String.raw`
     /\_/\
    ( -.- )  z z
     > ~ <
  no agents running`;

/** The wall: a ranked list of every pane, and the selected one large. */
export class WallView {
  private rows = new Map<string, Row>();
  private list = document.createElement("nav");
  private preview = new Preview();
  private split = document.createElement("div");
  private empty = document.createElement("pre");
  private status = document.createElement("p");
  private order: string[] = [];
  /** The list's sections, order and counts as last drawn. */
  private shape = "";
  private selected = "";
  /** Set once the person picks a row, so a new arrival does not steal the view. */
  private pinned = false;

  constructor(private root: HTMLElement) {
    this.status.className = "wall-status";
    this.status.hidden = true;
    this.empty.className = "empty";
    this.empty.textContent = SLEEPING_CAT;
    this.empty.hidden = true;
    this.list.className = "list";
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "Agents");
    this.split.className = "split";
    this.split.hidden = true;
    this.split.append(this.list, this.preview.el);
    root.append(this.status, this.empty, this.split);
    // Wait times move without a frame.
    setInterval(() => this.tickTimes(), 15_000);
    document.addEventListener("keydown", (e) => this.key(e));
  }

  async start(): Promise<void> {
    await listen<Frame>("wall:frame", (e) => this.render(e.payload));
    const last = await invoke<Frame | null>("wall_frame");
    if (last) this.render(last);
  }

  /** Shown above the list when cmux can't be reached. */
  problem(text: string | null): void {
    this.status.hidden = !text;
    this.status.textContent = text ?? "";
  }

  private visible(): boolean {
    return this.root.offsetParent !== null && !this.split.hidden;
  }

  /** ↑/↓ or k/j move, Return replies, J jumps; never while typing. */
  private key(e: KeyboardEvent): void {
    if (!this.visible() || e.metaKey || e.ctrlKey || e.altKey) return;
    const at = document.activeElement;
    if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement) return;
    const i = this.order.indexOf(this.selected);
    const move = (d: number) => {
      const next = this.order[Math.min(this.order.length - 1, Math.max(0, i + d))];
      if (next) this.pick(next);
      e.preventDefault();
    };
    if (e.key === "ArrowDown" || e.key === "j") move(1);
    else if (e.key === "ArrowUp" || e.key === "k") move(-1);
    else if (e.key === "Enter") {
      this.preview.focusReply();
      e.preventDefault();
    } else if (e.key === "J") {
      void this.preview.jump();
      e.preventDefault();
    }
  }

  private pick(surface: string): void {
    this.pinned = true;
    this.select(surface);
  }

  /** Show `surface` large, as if the person picked its row (Mosaic's expand). */
  open(surface: string): void {
    if (this.rows.has(surface)) this.pick(surface);
  }

  private select(surface: string): void {
    const moved = surface !== this.selected;
    this.selected = surface;
    for (const [id, row] of this.rows) {
      const on = id === surface;
      row.el.classList.toggle("on", on);
      row.el.setAttribute("aria-selected", String(on));
    }
    const row = this.rows.get(surface);
    if (row) {
      this.preview.show(row.tile, Date.now());
      if (moved) row.el.scrollIntoView({ block: "nearest" });
    }
  }

  private tickTimes(): void {
    const now = Date.now();
    for (const row of this.rows.values()) if (row.tile) row.tick(now);
    const sel = this.rows.get(this.selected);
    if (sel) this.preview.show(sel.tile, now);
  }

  render(f: Frame): void {
    this.problem(f.error ? `cmux didn't answer the last poll (${f.error}); showing what it said before.` : null);
    const now = Date.now();
    const tiles = [...f.tiles].sort(rank);
    const seen = new Set<string>();
    for (const t of tiles) {
      seen.add(t.surface);
      let row = this.rows.get(t.surface);
      if (!row) {
        row = new Row(t.surface, (s) => this.pick(s));
        this.rows.set(t.surface, row);
      }
      row.update(t, now);
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }
    // The list, with a quiet label wherever the section changes.
    const order = tiles.map((t) => t.surface);
    const els: HTMLElement[] = [];
    let section = "";
    for (const t of tiles) {
      const s = SECTION[t.state] ?? "Terminals";
      if (s !== section) {
        section = s;
        const n = tiles.filter((x) => (SECTION[x.state] ?? "Terminals") === s).length;
        const h = document.createElement("h2");
        h.textContent = s;
        const c = document.createElement("span");
        c.className = "count";
        c.textContent = ` ${n}`;
        h.append(c);
        els.push(h);
      }
      els.push(this.rows.get(t.surface)!.el);
    }
    // Redraw only when the sections, order or counts moved, so a frame that
    // just changes text leaves the list (and its scroll) alone.
    const shape = els.map((e) => (e.tagName === "H2" ? `#${e.textContent}` : (e as HTMLElement).dataset.surface ?? "")).join("|");
    if (shape !== this.shape) {
      this.list.replaceChildren(...els);
      this.shape = shape;
    }
    this.order = order;

    this.empty.hidden = tiles.length > 0;
    this.split.hidden = tiles.length === 0;
    if (!tiles.length) return;
    // Keep the person's pick while it lives; otherwise follow the top of the list.
    const keep = this.rows.has(this.selected) && (this.pinned || this.selected === order[0]);
    if (!this.rows.has(this.selected)) this.pinned = false;
    this.select(keep ? this.selected : order[0]);
  }
}
