import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
};
export type Frame = { tiles: Tile[]; error: string | null };

type Group = { id: string; title: string; states: string[] };

/** Waiting agents float to the top; plain terminals sink to the bottom. */
const GROUPS: Group[] = [
  { id: "needs", title: "Needs you", states: ["needs_input"] },
  { id: "working", title: "Working", states: ["working"] },
  { id: "idle", title: "Idle", states: ["idle", "ended"] },
  { id: "shell", title: "Terminals", states: [] },
];

function groupOf(t: Tile): Group {
  return GROUPS.find((g) => g.states.includes(t.state)) ?? GROUPS[GROUPS.length - 1];
}

/** A turn ended: the agent was working and now waits or rests. */
function finishedTurn(before: string | undefined, after: string): boolean {
  return before === "working" && (after === "needs_input" || after === "idle");
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

/** One card, kept across frames so a reply being typed survives updates. */
class Card {
  el = document.createElement("article");
  private head = document.createElement("header");
  private title = document.createElement("span");
  private sub = document.createElement("span");
  private stateEl = document.createElement("span");
  private body = document.createElement("pre");
  private foot = document.createElement("footer");
  private form = document.createElement("form");
  private send = document.createElement("button");
  private input = document.createElement("input");
  private note = document.createElement("span");
  state = "";

  constructor(private surface: string) {
    this.el.className = "card";
    this.title.className = "title";
    this.sub.className = "sub";
    this.stateEl.className = "state";
    const names = document.createElement("div");
    names.className = "names";
    names.append(this.title, this.sub);
    this.head.append(this.stateEl, names);

    this.input.type = "text";
    this.input.placeholder = "Reply…";
    this.input.spellcheck = false;
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep ⌘1…⌘4 and the like out of the shell while typing
      if (e.key === "Escape") this.input.blur();
    });
    this.input.addEventListener("input", () => (this.send.hidden = !this.input.value.trim()));
    // A form, so Return submits natively; the Send button is the same path.
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
    const jump = document.createElement("button");
    jump.className = "jump";
    jump.title = "Show this pane in cmux";
    jump.append(document.createTextNode("Jump "));
    const arrow = document.createElementNS(SVG, "svg");
    arrow.setAttribute("viewBox", "0 0 10 10");
    arrow.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", "M3 7 7 3M4 3h3v3");
    arrow.append(p);
    jump.append(arrow);
    jump.addEventListener("click", () => void this.jump());
    this.note.className = "note-line";
    this.foot.append(this.form, jump, this.note);
    this.el.append(this.head, this.body, this.foot);
  }

  update(t: Tile): void {
    const before = this.state;
    this.state = t.state;
    this.el.dataset.state = t.state;
    this.title.textContent = t.workspace_title || t.label || "terminal";
    this.sub.textContent = t.workspace_title && t.label !== t.workspace_title ? t.label : t.cwd;
    this.stateEl.replaceChildren(stateMark(t.state), document.createTextNode(STATE_WORDS[t.state] ?? t.state));
    this.form.hidden = !t.agent;
    if (t.error) {
      this.body.textContent = `Couldn't read this pane: ${t.error}`;
      this.body.classList.add("err");
    } else {
      this.body.classList.remove("err");
      const text = t.lines.join("\n");
      if (this.body.textContent !== text) {
        this.body.textContent = text;
        this.body.scrollTop = this.body.scrollHeight;
      }
    }
    if (finishedTurn(before, t.state)) this.stitch();
  }

  /** The seam runs across the card's top edge once. */
  private stitch(): void {
    this.el.classList.remove("stitched");
    void this.el.offsetWidth; // restart the animation
    this.el.classList.add("stitched");
  }

  private say(text: string, bad = false): void {
    this.note.textContent = text;
    this.note.classList.toggle("bad", bad);
    if (!bad) setTimeout(() => this.note.textContent === text && (this.note.textContent = ""), 2500);
  }

  private async reply(): Promise<void> {
    const text = this.input.value;
    if (!text.trim()) return;
    this.input.disabled = true;
    this.send.disabled = true;
    this.say("Sending…");
    try {
      await invoke("wall_reply", { surfaceId: this.surface, text });
      this.input.value = "";
      this.send.hidden = true;
      this.say("Sent");
    } catch (e) {
      this.say(String(e), true);
    } finally {
      this.input.disabled = false;
      this.send.disabled = false;
      this.input.focus();
    }
  }

  private async jump(): Promise<void> {
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

/** The wall: groups of cards, updated in place from each wall:frame event. */
export class WallView {
  private cards = new Map<string, Card>();
  private groups = new Map<string, { box: HTMLElement; grid: HTMLElement; count: HTMLElement }>();
  private empty = document.createElement("pre");
  private status = document.createElement("p");

  constructor(private root: HTMLElement) {
    this.status.className = "wall-status";
    this.status.hidden = true;
    this.empty.className = "empty";
    this.empty.textContent = SLEEPING_CAT;
    this.empty.hidden = true;
    root.append(this.status, this.empty);
    for (const g of GROUPS) {
      const box = document.createElement("section");
      box.className = `group group-${g.id}`;
      const h = document.createElement("h2");
      const count = document.createElement("span");
      count.className = "count";
      h.append(document.createTextNode(g.title), count);
      const grid = document.createElement("div");
      grid.className = "grid";
      box.append(h, grid);
      box.hidden = true;
      root.append(box);
      this.groups.set(g.id, { box, grid, count });
    }
  }

  async start(): Promise<void> {
    await listen<Frame>("wall:frame", (e) => this.render(e.payload));
    const last = await invoke<Frame | null>("wall_frame");
    if (last) this.render(last);
  }

  /** Shown above the cards when cmux can't be reached. */
  problem(text: string | null): void {
    this.status.hidden = !text;
    this.status.textContent = text ?? "";
  }

  render(f: Frame): void {
    this.problem(f.error ? `cmux didn't answer the last poll (${f.error}); showing what it said before.` : null);
    const seen = new Set<string>();
    const placed = new Map<string, HTMLElement[]>();
    for (const t of f.tiles) {
      seen.add(t.surface);
      let card = this.cards.get(t.surface);
      if (!card) {
        card = new Card(t.surface);
        this.cards.set(t.surface, card);
      }
      card.update(t);
      const g = groupOf(t).id;
      placed.set(g, [...(placed.get(g) ?? []), card.el]);
    }
    for (const [id, card] of this.cards) {
      if (!seen.has(id)) {
        card.el.remove();
        this.cards.delete(id);
      }
    }
    for (const g of GROUPS) {
      const slot = this.groups.get(g.id)!;
      const els = placed.get(g.id) ?? [];
      // Re-append only when the order changed, so a focused reply box stays focused.
      const now = Array.from(slot.grid.children);
      if (now.length !== els.length || now.some((el, i) => el !== els[i])) {
        const active = document.activeElement as HTMLElement | null;
        slot.grid.replaceChildren(...els);
        if (active && active.isConnected) active.focus();
      }
      slot.box.hidden = els.length === 0;
      slot.count.textContent = els.length ? ` ${els.length}` : "";
    }
    this.empty.hidden = f.tiles.length > 0;
  }
}
