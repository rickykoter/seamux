import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { answerable, type Decision, type ViewsFrame } from "./desk";
import { reflow } from "./reflow";
import type { Frame as WallFrame, Tile } from "./wall";
import { ago, WallView } from "./wall";
import { levelOf, menu, toggle } from "./tuck";
import { primeTheme } from "./term";
import { familyOf, grouped, header as familyHeader, waitText } from "./family";

type PlanBrief = { ws: string; slug: string; phase: string; done: number; total: number; n: number; open: boolean; title: string };
type ReviewBrief = { ws: string; id: string; plan: string; inc: number; open: number; addressed: number; closed: number; since: number };
type Views = ViewsFrame & { plans: PlanBrief[]; reviews: ReviewBrief[] };

/** A tile's size by how much it needs you. */
export type Size = "large" | "medium" | "small";

export function sizeOf(t: Tile): Size | null {
  if (t.state === "needs_input") return "large";
  if (t.state === "working") return "medium";
  if (t.state === "shell") return null; // folded into a count
  return "small";
}

/** Needs you first (longest waiting), then working, then idle; cmux's order within. */
export function order(tiles: Tile[]): Tile[] {
  const rank: Record<Size, number> = { large: 0, medium: 1, small: 2 };
  return tiles
    .filter((t) => sizeOf(t))
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const r = rank[sizeOf(a.t)!] - rank[sizeOf(b.t)!];
      if (r) return r;
      if (a.t.state === "needs_input") return a.t.since - b.t.since;
      return a.i - b.i;
    })
    .map((x) => x.t);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function safeColor(c: string | null): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "";
}

const STILL = String.raw`
   /\_/\
  ( -.- )  z z
   > ~ <
  no agents running`;

/** Mosaic: every pane as a tile sized by urgency; a click opens it large. */
export class Mosaic {
  private grid = el("div", "mosaic-grid");
  private still = el("pre", "mosaic-still", STILL);
  private detail = el("div", "mosaic-detail");
  private back = el("button", "d-btn mosaic-back", "← Mosaic");
  private tiles: Tile[] = [];
  private views: Views = { decisions: [], wake: [], history: [], problems: [], plans: [], reviews: [] };
  private drafts = new Map<string, string>();
  private notes = new Map<string, { text: string; bad: boolean }>();
  private expanded = false;
  private drawn = "";

  constructor(
    private root: HTMLElement,
    private wallEl: HTMLElement,
    private wall: WallView,
  ) {
    root.classList.add("mosaic");
    this.back.type = "button";
    this.back.title = "Back to every pane (Esc)";
    this.back.addEventListener("click", () => this.collapse());
    const bar = el("div", "mosaic-bar");
    bar.append(this.back, el("span", "d-fine", "↑/↓ pick a pane · ↵ replies · J jumps"));
    this.detail.append(bar, wallEl);
    this.detail.hidden = true;
    this.still.hidden = true;
    root.replaceChildren(this.grid, this.still, this.detail);
    // Escape returns to the mosaic before it hides the window.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || !this.expanded || this.root.offsetParent === null) return;
        if (document.querySelector(".sheet:not([hidden]), .palette:not([hidden])")) return;
        const at = document.activeElement;
        if (at instanceof HTMLInputElement && this.wallEl.contains(at)) return; // the reply box blurs first
        this.collapse();
        e.stopImmediatePropagation();
        e.preventDefault();
      },
      true,
    );
    setInterval(() => this.draw(true), 30_000);
  }

  async start(): Promise<void> {
    await listen<WallFrame>("wall:frame", (e) => this.setTiles(e.payload.tiles));
    await listen<Views>("views:frame", (e) => this.setViews(e.payload));
    const [w, v] = await Promise.all([invoke<WallFrame | null>("wall_frame"), invoke<Views | null>("views_frame")]);
    if (w) this.setTiles(w.tiles);
    if (v) this.setViews(v);
  }

  private setTiles(t: Tile[]): void {
    this.tiles = t;
    // The tiles' text wears the terminal's theme from the first frame on.
    primeTheme(t.find((x) => x.surface)?.surface ?? "");
    this.draw();
  }

  private setViews(v: Views): void {
    this.views = { ...v, plans: v.plans ?? [], reviews: v.reviews ?? [] };
    this.draw();
  }

  private expand(surface: string): void {
    this.expanded = true;
    this.grid.hidden = true;
    this.still.hidden = true;
    this.detail.hidden = false;
    this.wall.open(surface);
  }

  private collapse(): void {
    this.expanded = false;
    this.detail.hidden = true;
    this.draw(true);
  }

  private say(surface: string, text: string, bad = false): void {
    this.notes.set(surface, { text, bad });
    this.draw(true);
    if (!bad) setTimeout(() => this.notes.get(surface)?.text === text && (this.notes.delete(surface), this.draw(true)), 4000);
  }

  private draw(force = false): void {
    if (this.expanded) return;
    const at = document.activeElement;
    const typing = at instanceof HTMLInputElement && this.grid.contains(at);
    const shape = JSON.stringify([this.tiles, this.views.decisions, this.views.plans, this.views.reviews, this.views.wake.slice(0, 40), [...this.notes], this.views.levels ?? {}, this.views.families ?? []]);
    if (typing || (!force && shape === this.drawn)) {
      if (typing) at!.addEventListener("blur", () => setTimeout(() => this.draw(), 0), { once: true });
      return;
    }
    this.drawn = shape;
    // Tucked workspaces are left out; muted ones come last, small.
    const lv = this.views.levels;
    const ranked = order(this.tiles.filter((t) => levelOf(lv, t.workspace) !== "tuck"));
    const shown = [...ranked.filter((t) => !levelOf(lv, t.workspace)), ...ranked.filter((t) => levelOf(lv, t.workspace) === "mute")];
    const shells = this.tiles.filter((t) => t.state === "shell" && levelOf(lv, t.workspace) !== "tuck").length;
    // A family's tiles sit together under its header, where its first tile falls.
    const fams = this.views.families;
    // Each family is a section of its own, packed densely under its header;
    // the tiles between families pack together, so no group leaves holes.
    const els: HTMLElement[] = [];
    let loose: HTMLElement | null = null;
    const section = () => el("div", "m-sec");
    for (const g of grouped(shown, (t) => familyOf(fams, t.workspace)?.fam.parent ?? "")) {
      const fam = g.key ? fams?.find((f) => f.parent === g.key) : undefined;
      if (fam) {
        loose = null;
        const sec = section();
        sec.append(...g.items.map((t) => this.tile(t)));
        els.push(familyHeader(fam, "fam-head m-fam"), sec);
      } else {
        if (!loose) els.push((loose = section()));
        loose.append(...g.items.map((t) => this.tile(t)));
      }
    }
    if (shells) {
      if (!loose) els.push((loose = section()));
      loose.append(el("div", "m-tile small folded", `+ ${shells} terminal${shells === 1 ? "" : "s"}`));
    }
    this.grid.replaceChildren(...els);
    this.grid.hidden = false;
    this.still.hidden = this.tiles.length > 0;
  }

  /** When the pane entered its state: the start of its current run in the
   * history (which outlives the app) when that is earlier than the wall saw. */
  private since(t: Tile): number {
    let start = 0;
    let last = "";
    for (const c of this.views.history) {
      if (c.ws !== t.workspace || (c.surface && c.surface.toUpperCase() !== t.surface.toUpperCase())) continue;
      if (c.state !== last) start = c.at;
      last = c.state;
    }
    return last === t.state && start && start < t.since ? start : t.since;
  }

  private decisionFor(t: Tile): Decision | undefined {
    return this.views.decisions.find((d) => (d.kind === "question" || d.kind === "asked") && d.ws === t.workspace);
  }

  private tile(t: Tile): HTMLElement {
    const level = levelOf(this.views.levels, t.workspace);
    const size = level === "mute" ? "small" : sizeOf(t)!;
    const box = el("article", `m-tile ${size}${level === "mute" ? " muted" : ""}`);
    box.style.setProperty("--ws", safeColor(t.color) || "var(--line)");
    box.tabIndex = 0;
    box.setAttribute("aria-label", `${t.workspace_title || t.label}: ${t.state.replace("_", " ")}`);
    box.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, input, form")) return;
      this.expand(t.surface);
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === box) this.expand(t.surface);
      if ((e.key === "m" || e.key === "t") && e.target === box && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        toggle(t.workspace, t.workspace_title || t.label, e.key, level);
      }
    });
    const plan = this.views.plans.find((p) => p.ws === t.workspace);
    const review = this.views.reviews.find((r) => r.ws === t.workspace);
    const name = t.workspace_title || t.label || "terminal";

    const head = el("header", "m-head");
    head.append(el("span", "m-name", name));
    const state = el("span", `m-state ${t.state}`);
    const d = this.decisionFor(t);
    if (t.state === "needs_input") state.textContent = `${d?.kind === "question" ? "question" : "needs you"} · ${ago(Date.now() - this.since(t))}`;
    else if (t.state === "working") state.textContent = `working · ${ago(Date.now() - this.since(t))}`;
    else state.textContent = t.state === "ended" ? "ended" : "idle";
    // A child waiting on its parent says so, rather than looking idle.
    const kin = familyOf(this.views.families, t.workspace);
    const waits = kin ? waitText(kin.fam, kin.member) : "";
    if (waits && t.state !== "needs_input") state.textContent = waits;
    if (level === "mute") state.textContent += " · muted";
    head.append(state, el("span", "grow"));
    if (plan && size !== "small") head.append(el("span", "m-plan", plan.phase === "done" ? `plan done · ${plan.done}/${plan.total}` : `inc ${plan.n}/${plan.total}`));
    head.append(menu(t.workspace, name, level)); // the menu always last, in every tile
    box.append(head);

    if (size === "small") {
      const bits = [plan ? (plan.phase === "done" ? `plan ${plan.done}/${plan.total} · delivered` : `plan ${plan.done}/${plan.total}`) : ""].filter(Boolean);
      if (bits.length) box.append(el("span", "m-sub", bits.join(" · ")));
      const wake = this.views.wake.find((r) => r.ws === t.workspace && r.kind !== "temp");
      if (wake) box.append(el("span", "m-wake", `Wake: ${wake.title}`));
      return box;
    }

    if (plan && plan.total > 0) {
      const bar = el("div", "m-bar");
      for (let i = 1; i <= plan.total; i++) bar.append(el("span", i <= plan.done ? "done" : i === plan.n && plan.open ? "now" : ""));
      box.append(bar);
    }

    const keep = size === "large" ? 9 : 4;
    const tail = el("div", "m-tail");
    if (t.error) tail.textContent = `Couldn't read this pane: ${t.error}`;
    else {
      const lines = t.lines.slice(-keep * 3);
      const blocks = t.agent ? reflow(lines).slice(-keep) : lines.slice(-keep).map((x) => ({ start: 0, hang: 0, text: x }));
      for (const b of blocks) {
        const ln = el("div", "ln", b.text || " ");
        ln.style.paddingLeft = `${b.start}ch`;
        ln.style.textIndent = `-${b.hang}ch`;
        tail.append(ln);
      }
    }
    box.append(tail);

    if (review && size === "medium") {
      const left = review.open + review.addressed;
      box.append(el("span", "m-look", `lookout · ${review.plan ? `inc${review.inc} ` : ""}review: ${left ? `${left} open` : `${review.closed} closed`}`));
    }

    if (size === "large") box.append(this.actions(t, d));
    const note = this.notes.get(t.surface);
    if (note) box.append(el("p", `d-note${note.bad ? " bad" : ""}`, note.text));
    return box;
  }

  /** A needs-you tile's answer: the question's options, else Yes and a reply. */
  private actions(t: Tile, d: Decision | undefined): HTMLElement {
    if (d && d.kind === "question" && answerable(d)) {
      const opts = el("div", "m-opts");
      const q = d.questions[0];
      opts.append(el("p", "m-q", q.question));
      q.options.forEach((o, i) => {
        const b = el("button", "d-opt");
        b.type = "button";
        b.append(el("b", "", String(i + 1)), document.createTextNode(`  ${o.label}`));
        b.addEventListener("click", async () => {
          this.say(t.surface, `Typing ${i + 1}…`);
          try {
            this.say(t.surface, await invoke<string>("desk_answer", { workspace: d.ws, n: i + 1 }));
          } catch (e) {
            this.say(t.surface, String(e), true);
          }
        });
        opts.append(b);
      });
      return opts;
    }
    const form = el("form", "d-reply");
    if (!t.agent || t.state === "ended") return form;
    const yes = el("button", "d-btn primary", "Yes");
    yes.type = "button";
    const input = el("input");
    input.type = "text";
    input.placeholder = d?.kind === "question" ? "Answer it in the pane, or reply…" : "Reply…";
    input.spellcheck = false;
    input.value = this.drafts.get(t.surface) ?? "";
    input.addEventListener("input", () => this.drafts.set(t.surface, input.value));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") input.blur();
    });
    const send = async (text: string) => {
      try {
        await invoke("wall_reply", { surfaceId: t.surface, text });
        this.drafts.delete(t.surface);
        input.blur();
        this.say(t.surface, "Sent");
      } catch (e) {
        this.say(t.surface, String(e), true);
      }
    };
    yes.addEventListener("click", () => void send("yes"));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.trim()) void send(input.value);
    });
    form.append(yes, input);
    return form;
  }
}
