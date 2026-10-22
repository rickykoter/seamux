import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPage } from "./sheet";
import type { Frame as WallFrame, Tile } from "./wall";
import { ago } from "./wall";
import { levelOf, menu, toggle, type Levels, type TuckRow } from "./tuck";
import { familyOf, grouped, header as familyHeader, memberState, type FamilyBrief, type FamilyMember } from "./family";

// The shapes of views.rs's ViewsFrame.
export type Opt = { label: string; description: string };
export type Question = { question: string; header: string; multiSelect: boolean; options: Opt[] };
export type Check = { id: string; kind: string; name: string; status: string };
export type Decision =
  | { kind: "question"; ws: string; surface: string; since: number; questions: Question[] }
  | { kind: "asked"; ws: string; surface: string; since: number; question: string }
  | {
      kind: "gate";
      ws: string;
      surface: string;
      since: number;
      slug: string;
      n: number;
      title: string;
      done: number;
      total: number;
      checks: Check[];
      ready: boolean;
    }
  | { kind: "family"; ws: string; surface: string; since: number; parent: string; members: FamilyMember[] }
  | {
      kind: "review";
      ws: string;
      surface: string;
      since: number;
      id: string;
      title: string;
      plan: string;
      inc: number;
      addressed: number;
      open: number;
    };
export type WakeRow = { id: number; kind: string; title: string; dir: string; ws: string | null; at: number };
export type Change = { at: number; ws: string; surface: string; state: string; source: string; detail: string };
export type ViewsFrame = { decisions: Decision[]; wake: WakeRow[]; history: Change[]; problems: string[]; levels?: Levels; tucked?: TuckRow[]; families?: FamilyBrief[] };

const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls = "d-btn"): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  return b;
}

/** The little arrow cmux's Jump and Open wear. */
function arrow(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", "M3 7 7 3M4 3h3v3");
  svg.append(p);
  return svg;
}

/** A #RRGGBB the page can trust in a style, or "". */
function safeColor(c: string | null | undefined): string {
  return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "";
}

/** A decision's identity across frames, so a card keeps its draft and place. */
export function keyOf(d: Decision): string {
  switch (d.kind) {
    case "question":
    case "asked":
      return `${d.kind}:${d.ws}`;
    case "gate":
      return `gate:${d.slug}`;
    case "review":
      return `review:${d.id}`;
    case "family":
      return `family:${d.parent}`;
  }
}

/** One question a single digit can answer in place. */
export function answerable(d: Decision): boolean {
  return d.kind === "question" && d.questions.length === 1 && !d.questions[0].multiSelect && d.questions[0].options.length > 0;
}

const SLEEPING_CAT = String.raw`
   /\_/\
  ( ^.^ )   nothing is waiting on you
   > ~ <`;

type Ws = { title: string; color: string };

/** Desk: every decision waiting on you, oldest first, answered in place. */
export class Desk {
  private main = el("div", "desk-main");
  private side = el("aside", "desk-side");
  private head = el("div", "desk-head");
  private count = el("span", "desk-count");
  private hint = el("span", "desk-hint", "oldest first · 1–9 picks an option · j/k move · ↵ reply · J jumps · O opens · m mutes · t tucks away");
  private problems = el("p", "desk-problems");
  private list = el("div", "desk-list");
  private empty = el("pre", "desk-empty", SLEEPING_CAT);
  private away = el("div", "desk-away");
  private working = el("div", "desk-working");
  private tally = el("div", "desk-tally");
  private frame: ViewsFrame = { decisions: [], wake: [], history: [], problems: [] };
  private tiles: Tile[] = [];
  /** The selected card, by its key: frames reorder cards (a mute, an Undo, a
   * new ask), and keys must act on the card the person chose, not on
   * whatever card took its place. */
  private selectedKey = "";
  /** The card an m or t just hid, and until when: if an Undo brings it back,
   * it is selected again, so the next key acts on it and not its neighbour. */
  private actedKey = "";
  private actedUntil = 0;
  /** Where the selected card is now; recomputed from selectedKey. */
  private selected = 0;
  /** Unsent replies and check notes, by card key. */
  private drafts = new Map<string, string>();
  /** A card's last message, kept across redraws for a few seconds. */
  private notes = new Map<string, { text: string; bad: boolean; at: number }>();
  /** The card a check form is open on, and which check. */
  private recording: { key: string; id: string } | null = null;
  /** Cards with an action in flight (go next, a check, an answer). */
  private busy = new Set<string>();
  private drawn = "";

  constructor(private root: HTMLElement) {
    root.classList.add("desk");
    this.head.append(this.count, this.hint);
    this.problems.hidden = true;
    this.main.append(this.head, this.problems, this.list, this.empty);
    const awayHead = el("h2", "", "While you were away · Wake");
    this.side.append(awayHead, this.away, el("span", "grow"), this.working, this.tally);
    root.replaceChildren(this.main, this.side);
    document.addEventListener("keydown", (e) => this.key(e));
    // Waiting times move without a frame.
    setInterval(() => this.draw(true), 30_000);
  }

  async start(): Promise<void> {
    await listen<ViewsFrame>("views:frame", (e) => this.setViews(e.payload));
    await listen<WallFrame>("wall:frame", (e) => this.setTiles(e.payload.tiles));
    const [v, w] = await Promise.all([invoke<ViewsFrame | null>("views_frame"), invoke<WallFrame | null>("wall_frame")]);
    if (w) this.setTiles(w.tiles);
    if (v) this.setViews(v);
  }

  private setViews(f: ViewsFrame): void {
    this.frame = f;
    this.draw();
  }

  private setTiles(t: Tile[]): void {
    this.tiles = t;
    this.draw();
  }

  private ws(id: string | null, dir = ""): Ws {
    const t = id ? this.tiles.find((x) => x.workspace === id) : undefined;
    const base = dir.replace(/\/+$/, "").split("/").pop() ?? "";
    return { title: t?.workspace_title || t?.label || base || "workspace", color: safeColor(t?.color) };
  }

  private visible(): boolean {
    return this.root.offsetParent !== null;
  }

  /** The decisions Desk shows: tucked workspaces left out, muted ones last. */
  private decisions(): Decision[] {
    const lv = this.frame.levels;
    const shown = this.frame.decisions.filter((d) => levelOf(lv, d.ws) !== "tuck");
    // A family's cards sit together, where its first card falls.
    const fam = (d: Decision) => (d.kind === "family" ? d.parent : familyOf(this.frame.families, d.ws)?.fam.parent ?? "");
    const together = (ds: Decision[]) => grouped(ds, fam).flatMap((g) => g.items);
    return [...together(shown.filter((d) => !levelOf(lv, d.ws))), ...together(shown.filter((d) => levelOf(lv, d.ws) === "mute"))];
  }

  /** Redraw, unless the person is typing in a card (then wait for the blur). */
  private draw(force = false): void {
    const at = document.activeElement;
    const typing = (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement) && this.root.contains(at);
    // Only what Desk shows: the lanes and history change every minute.
    const shown = [this.frame.decisions, this.frame.wake.slice(0, 40), this.frame.problems, this.frame.levels ?? {}, this.frame.families ?? []];
    const shape = JSON.stringify([shown, this.tiles.map((t) => [t.workspace, t.workspace_title, t.color, t.state]), this.recording, this.selectedKey]);
    if (typing || (!force && shape === this.drawn)) {
      if (typing) at!.addEventListener("blur", () => setTimeout(() => this.draw(), 0), { once: true });
      return;
    }
    this.drawn = shape;
    const ds = this.decisions();
    if (this.actedKey && Date.now() < this.actedUntil && ds.some((d) => keyOf(d) === this.actedKey)) {
      this.selectedKey = this.actedKey; // back from an Undo
      this.actedKey = "";
    }
    const kept = ds.findIndex((d) => keyOf(d) === this.selectedKey);
    // The chosen card is gone (answered, tucked): stay at its place in the list.
    this.selected = kept >= 0 ? kept : Math.min(this.selected, Math.max(0, ds.length - 1));
    this.selectedKey = ds[this.selected] ? keyOf(ds[this.selected]) : "";
    // Muted workspaces are out of the count.
    const n = ds.filter((d) => !levelOf(this.frame.levels, d.ws)).length;
    this.count.textContent = n === 1 ? "1 decision waiting" : `${n} decisions waiting`;
    this.problems.hidden = !this.frame.problems.length;
    this.problems.textContent = this.frame.problems.join(" · ");
    this.list.replaceChildren(...ds.map((d, i) => this.card(d, i === this.selected)));
    this.empty.hidden = ds.length > 0;
    this.drawSide();
  }

  private drawSide(): void {
    // What landed, not the scratch files a session wrote along the way.
    const landed = this.frame.wake.filter((r) => r.kind !== "temp" && !(r.ws && levelOf(this.frame.levels, r.ws) === "tuck"));
    const rows = landed.slice(0, 8).map((r) => {
      const w = this.ws(r.ws, r.dir);
      const row = el("div", "away-row");
      const edge = el("span", "edge");
      edge.style.setProperty("--ws", w.color || "var(--line)");
      const text = el("span", "away-text");
      text.append(el("b", "", w.title), document.createTextNode(` ${r.kind} · ${r.title}`));
      row.title = r.at ? new Date(r.at).toLocaleString() : "";
      row.append(edge, text);
      return row;
    });
    this.away.replaceChildren(...(rows.length ? rows : [el("p", "muted", "Nothing new in the Wake.")]));
    // The counts leave out what is muted or tucked.
    const by = (s: string) => this.tiles.filter((t) => t.state === s && !levelOf(this.frame.levels, t.workspace));
    const working = by("working");
    this.working.replaceChildren(
      ...working.slice(0, 4).map((t) => {
        const r = el("div", "working-row");
        r.append(el("span", "dot"), document.createTextNode(`working: ${t.workspace_title || t.label}`));
        return r;
      }),
    );
    const idle = by("idle").length + by("ended").length;
    const shells = by("shell").length;
    this.tally.textContent = `working ${working.length} · idle ${idle} · terminals ${shells}`;
  }

  private say(key: string, text: string, bad = false): void {
    this.notes.set(key, { text, bad, at: Date.now() });
    this.draw(true);
    if (!bad) {
      setTimeout(() => {
        const n = this.notes.get(key);
        if (n && n.text === text) {
          this.notes.delete(key);
          this.draw(true);
        }
      }, 4000);
    }
  }

  private card(d: Decision, on: boolean): HTMLElement {
    const key = keyOf(d);
    const w = this.ws(d.ws);
    const level = levelOf(this.frame.levels, d.ws);
    const c = el("article", `d-card ${d.kind}${on ? " on" : ""}${level === "mute" ? " muted" : ""}`);
    c.dataset.key = key;
    c.addEventListener("click", () => {
      const i = this.decisions().findIndex((x) => keyOf(x) === key);
      if (i >= 0 && i !== this.selected) {
        this.selected = i;
        this.selectedKey = key;
        this.draw(true);
      }
    });
    const head = el("header", "d-head");
    const mark = el("span", "ws-mark");
    mark.style.setProperty("--ws", w.color || "var(--muted)");
    const chip = el("span", `chip ${d.kind}`, { question: "question", asked: "asked", gate: "deep-plan gate", review: "lookout", family: "family" }[d.kind]);
    const when = el("span", "d-when");
    head.append(mark, el("span", "d-name", d.kind === "family" ? d.parent : w.title), chip);
    if (level === "mute") head.append(el("span", "chip status", "muted"));
    const kin = d.kind === "family" ? undefined : familyOf(this.frame.families, d.ws);
    if (kin) head.append(el("span", "chip fam", `family · ${kin.fam.parent}`));
    head.append(el("span", "grow"), when, menu(d.ws, w.title, level));
    c.append(head);

    if (d.kind === "question") {
      when.textContent = `waiting ${ago(Date.now() - d.since)}`;
      this.questionBody(c, d, key);
    } else if (d.kind === "asked") {
      when.textContent = `waiting ${ago(Date.now() - d.since)}`;
      this.askedBody(c, d, key);
    } else if (d.kind === "gate") {
      when.textContent = d.ready ? `inc ${d.n} is next` : `inc ${d.n}/${d.total} · ${d.checks.length} ${d.checks.length === 1 ? "check is" : "checks are"} yours`;
      this.gateBody(c, d, key);
    } else if (d.kind === "family") {
      const fam = (this.frame.families ?? []).find((f) => f.parent === d.parent);
      when.textContent = fam ? `${fam.done}/${fam.total} plans done` : "";
      this.familyBody(c, d, fam, key);
    } else {
      when.textContent = d.plan ? `${d.plan} · inc ${d.inc}` : "";
      this.reviewBody(c, d);
    }

    const note = this.notes.get(key);
    if (note) c.append(el("p", `d-note${note.bad ? " bad" : ""}`, note.text));
    return c;
  }

  private jumpButton(surface: string, key: string): HTMLButtonElement {
    const b = button("Jump ");
    b.title = "Show this pane in cmux (J)";
    b.append(arrow());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.jump(surface, key);
    });
    return b;
  }

  private async jump(surface: string, key: string): Promise<void> {
    try {
      await invoke("wall_jump", { surfaceId: surface });
      await invoke("hide_overlay");
    } catch (e) {
      this.say(key, String(e), true);
    }
  }

  private questionBody(c: HTMLElement, d: Extract<Decision, { kind: "question" }>, key: string): void {
    const can = answerable(d);
    for (const q of d.questions) {
      c.append(el("p", "d-q", q.question));
      const opts = el("div", "d-opts");
      q.options.forEach((o, i) => {
        const b = button("", "d-opt");
        b.append(el("b", "", String(i + 1)), document.createTextNode(`  ${o.label}`));
        if (o.description) b.append(el("span", "muted", ` — ${o.description}`));
        b.disabled = !can;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.answer(d, i + 1);
        });
        opts.append(b);
      });
      c.append(opts);
    }
    const foot = el("footer", "d-foot");
    foot.append(
      el("span", "d-fine", can ? "The pick is typed into the agent's dialog once its options show on screen." : "One key can't answer this one: answer it in the pane."),
      el("span", "grow"),
      this.jumpButton(d.surface, key),
    );
    c.append(foot);
  }

  private async answer(d: Extract<Decision, { kind: "question" }>, n: number): Promise<void> {
    const key = keyOf(d);
    if (!answerable(d)) return this.say(key, "Answer this one in the pane (J jumps).", true);
    this.say(key, `Typing ${n}…`);
    try {
      const detail = await invoke<string>("desk_answer", { workspace: d.ws, n });
      this.say(key, detail);
    } catch (e) {
      this.say(key, `${String(e)} · J jumps to the pane`, true);
    }
  }

  private askedBody(c: HTMLElement, d: Extract<Decision, { kind: "asked" }>, key: string): void {
    c.append(el("p", "d-q", d.question || "The turn ended on a question."));
    const form = el("form", "d-reply");
    const yes = button("Yes", "d-btn primary");
    const input = el("input");
    input.type = "text";
    input.placeholder = "Reply…";
    input.spellcheck = false;
    input.value = this.drafts.get(key) ?? "";
    input.addEventListener("input", () => this.drafts.set(key, input.value));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") input.blur();
    });
    const send = button("Send");
    send.type = "submit";
    yes.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.reply(d.surface, key, "yes");
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.trim()) void this.reply(d.surface, key, input.value);
    });
    form.append(yes, input, send, this.jumpButton(d.surface, key));
    c.append(form);
  }

  private async reply(surface: string, key: string, text: string): Promise<void> {
    try {
      await invoke("wall_reply", { surfaceId: surface, text });
      this.drafts.delete(key);
      (document.activeElement as HTMLElement | null)?.blur?.();
      this.say(key, "Sent");
    } catch (e) {
      this.say(key, String(e), true);
    }
  }

  private gateBody(c: HTMLElement, d: Extract<Decision, { kind: "gate" }>, key: string): void {
    const bar = el("div", "d-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${d.done} of ${d.total} increments done`);
    for (let i = 1; i <= d.total; i++) {
      bar.append(el("span", i <= d.done ? "done" : i === d.n && !d.ready ? "now" : ""));
    }
    const what = el("span", "d-fine", `${d.slug} · ${d.title}`);
    const line = el("div", "d-barline");
    line.append(bar, what);
    c.append(line);

    for (const ch of d.checks) {
      const row = el("div", "d-check");
      row.append(el("span", `chip status ${ch.status}`, ch.status), el("span", "d-check-name", ch.name || ch.id));
      const rec = button("Record…");
      rec.addEventListener("click", (e) => {
        e.stopPropagation();
        this.recording = this.recording?.id === ch.id ? null : { key, id: ch.id };
        this.draw(true);
      });
      row.append(rec);
      c.append(row);
      if (this.recording?.key === key && this.recording.id === ch.id) c.append(this.checkForm(d, ch, key));
    }

    const foot = el("footer", "d-foot");
    const open = button("Open the plan ");
    open.title = "In a sheet here; ⌘-click opens it in cmux";
    open.append(arrow());
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.open({ path: `/plan/${d.slug}`, title: d.slug, workspace: d.ws }, key, e);
    });
    const go = button(d.ready ? `go next · inc ${d.n}` : "go next (after the checks)", d.ready ? "d-btn primary" : "d-btn");
    go.disabled = !d.ready || this.busy.has(key);
    go.addEventListener("click", async (e) => {
      e.stopPropagation();
      // One go at a time: a second click while the engine runs is dropped.
      if (this.busy.has(key)) return;
      this.busy.add(key);
      go.disabled = true;
      try {
        this.say(key, await invoke<string>("plan_go", { slug: d.slug, n: d.n }));
      } catch (err) {
        this.say(key, String(err), true);
      } finally {
        this.busy.delete(key);
        this.draw(true);
      }
    });
    foot.append(open, go, el("span", "grow"), this.jumpButton(d.surface, key));
    c.append(foot);
  }

  private checkForm(d: Extract<Decision, { kind: "gate" }>, ch: Check, key: string): HTMLElement {
    const f = el("form", "d-checkform");
    const dk = `${key}:${ch.id}`;
    const label = el("label", "d-fine", "What you saw (the check's only evidence)");
    const ta = el("textarea");
    ta.rows = 3;
    ta.value = this.drafts.get(dk) ?? "";
    ta.addEventListener("input", () => this.drafts.set(dk, ta.value));
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") ta.blur();
    });
    label.append(ta);
    const record = (verdict: "pass" | "fail") => async (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const out = await invoke<string>("plan_check", { slug: d.slug, n: d.n, id: ch.id, verdict, note: ta.value });
        this.drafts.delete(dk);
        this.recording = null;
        this.say(key, out);
      } catch (err) {
        this.say(key, String(err), true);
      }
    };
    const pass = button("Pass", "d-btn primary");
    pass.addEventListener("click", record("pass"));
    const fail = button("Fail");
    fail.addEventListener("click", record("fail"));
    const row = el("div", "d-foot");
    row.append(pass, fail);
    f.append(label, row);
    setTimeout(() => ta.focus(), 0);
    return f;
  }

  /** A family's next step: each member's state, a go for those that can go now. */
  private familyBody(c: HTMLElement, d: Extract<Decision, { kind: "family" }>, fam: FamilyBrief | undefined, key: string): void {
    const f = fam ?? { parent: d.parent, members: d.members, done: 0, total: d.members.length };
    c.append(familyHeader(f, "fam-head in-card"));
    for (const m of d.members) {
      const row = el("div", `fam-member${m.waits.length ? " waiting" : ""}${m.ready ? " ready" : ""}`);
      row.append(el("span", "fam-role", m.role === "parent" ? "parent" : "child"), el("b", "", m.slug), el("span", "fam-state", memberState(f, m)), el("span", "grow"));
      const open = button("Plan ");
      open.append(arrow());
      open.title = "In a sheet here; ⌘-click opens it in cmux";
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.open({ path: `/plan/${m.slug}`, title: m.slug, workspace: m.ws ?? d.ws }, key, e);
      });
      row.append(open);
      if (m.ready) {
        const go = button(`go · inc ${m.n}`, "d-btn primary");
        go.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (this.busy.has(`${key}:${m.slug}`)) return;
          this.busy.add(`${key}:${m.slug}`);
          go.disabled = true;
          try {
            this.say(key, await invoke<string>("plan_go", { slug: m.slug, n: m.n }));
          } catch (err) {
            this.say(key, String(err), true);
          } finally {
            this.busy.delete(`${key}:${m.slug}`);
            this.draw(true);
          }
        });
        row.append(go);
      }
      c.append(row);
    }
  }

  private reviewBody(c: HTMLElement, d: Extract<Decision, { kind: "review" }>): void {
    const key = keyOf(d);
    const text = `${d.title || d.id} · ${d.addressed} ${d.addressed === 1 ? "finding" : "findings"} addressed, waiting for you to close${d.open ? ` · ${d.open} still open` : ""}`;
    c.append(el("p", "d-q small", text));
    const foot = el("footer", "d-foot");
    const open = button("Open the review ");
    open.title = "In a sheet here; ⌘-click opens it in cmux";
    open.append(arrow());
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.open({ path: `/review/${d.id}`, title: d.title || d.id, workspace: d.ws }, key, e);
    });
    foot.append(open, el("span", "grow"), this.jumpButton(d.surface, key));
    c.append(foot);
  }

  private async open(p: { path: string; title: string; workspace: string }, key: string, e?: MouseEvent | KeyboardEvent): Promise<void> {
    const err = await openPage(p, e);
    if (err) this.say(key, err, true);
  }

  /** 1–9 answer, j/k or ↑/↓ move, Return replies, J jumps, O opens; never while typing. */
  private key(e: KeyboardEvent): void {
    if (!this.visible() || e.ctrlKey || e.altKey) return;
    if (document.querySelector(".sheet:not([hidden])")) return; // the sheet has the keys
    const at = document.activeElement;
    if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement) return;
    const d = this.decisions()[this.selected];
    if (e.metaKey) {
      if (e.key.toLowerCase() === "o" && d) {
        // ⌘O: the selected card's page, in cmux.
        if (d.kind === "gate") void this.open({ path: `/plan/${d.slug}`, title: d.slug, workspace: d.ws }, keyOf(d), e);
        if (d.kind === "review") void this.open({ path: `/review/${d.id}`, title: d.title, workspace: d.ws }, keyOf(d), e);
        e.preventDefault();
      }
      return;
    }
    const move = (by: number) => {
      this.actedKey = ""; // moving on: an Undo no longer takes the selection back
      const n = this.decisions().length;
      if (!n) return;
      this.selected = Math.min(n - 1, Math.max(0, this.selected + by));
      this.selectedKey = keyOf(this.decisions()[this.selected]);
      this.draw(true);
      this.list.querySelector(".d-card.on")?.scrollIntoView({ block: "nearest" });
      e.preventDefault();
    };
    if (e.key === "j" || e.key === "ArrowDown") return move(1);
    if (e.key === "k" || e.key === "ArrowUp") return move(-1);
    if (!d) return;
    if (e.key === "m" || e.key === "t") {
      // Mute or tuck the selected card's workspace (again to undo).
      e.preventDefault();
      this.actedKey = keyOf(d);
      this.actedUntil = Date.now() + 8000; // the note offers Undo for 6 s
      toggle(d.ws, this.ws(d.ws).title, e.key, levelOf(this.frame.levels, d.ws));
      return;
    }
    if (/^[1-9]$/.test(e.key) && d.kind === "question") {
      e.preventDefault();
      void this.answer(d, Number(e.key));
    } else if (e.key === "J") {
      e.preventDefault();
      void this.jump(d.surface, keyOf(d));
    } else if (e.key === "Enter" && d.kind === "asked") {
      e.preventDefault();
      this.list.querySelector<HTMLInputElement>(".d-card.on input")?.focus();
    } else if (e.key === "o" || e.key === "O") {
      e.preventDefault();
      if (d.kind === "gate") void this.open({ path: `/plan/${d.slug}`, title: d.slug, workspace: d.ws }, keyOf(d));
      if (d.kind === "review") void this.open({ path: `/review/${d.id}`, title: d.title, workspace: d.ws }, keyOf(d));
    }
  }
}
