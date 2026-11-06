import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Decision } from "./decisions";
import { catSvg } from "./panecat";
import { FIELDS, rowsOf, search, type Field, type Hit, type Inputs, type Row, type TileIn } from "./search";
import { ago } from "./tiles";
import { say, type TuckRow } from "./tuck";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** `text` with the letters at `at` underlined, as nodes. */
function marked(text: string, at: number[] | undefined): Node[] {
  if (!at?.length) return [document.createTextNode(text)];
  const set = new Set(at);
  const out: Node[] = [];
  let run = "", on = false;
  const flush = () => {
    if (!run) return;
    out.push(on ? el("mark", "", run) : document.createTextNode(run));
    run = "";
  };
  // One UTF-16 unit at a time: fuzzy()'s indices count the same units.
  text.split("").forEach((c, i) => {
    if (set.has(i) !== on) { flush(); on = set.has(i); }
    run += c;
  });
  flush();
  return out;
}

/** A session's state as a small dot in the tier colours (no emoji). */
function dot(r: Row): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 10 10");
  s.setAttribute("class", `search-dot ${r.level ? "away" : r.state}`);
  s.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(ns, "circle");
  c.setAttribute("cx", "5"); c.setAttribute("cy", "5"); c.setAttribute("r", r.level ? "3.4" : "4");
  s.append(c);
  return s;
}

const STATE_SAID: Record<string, string> = { needs_input: "waiting on you", working: "working", idle: "idle", ended: "ended", shell: "terminal" };

type ViewsIn = { plans?: { ws: string; slug: string }[]; decisions?: Decision[]; tucked?: TuckRow[]; priority?: Record<string, number>; branches?: Record<string, string> };

/** Session search: every open session, tucked and muted ones below, ranked by
 *  match then priority (search.ts); a preview of the one selected beside the
 *  list. ⌘K (a shell.rs sheet key, so it works in a framed page too) or
 *  ⌥⇧Space from any app opens it; the Tucked chip in the strip does too. */
export class Palette {
  chip = el("button", "tuck-chip");
  private el = el("div", "palette");
  private card = el("div", "palette-card search");
  private input = el("input", "palette-q");
  private list = el("div", "palette-list");
  private preview = el("div", "search-preview");
  private foot = el("div", "palette-foot", "↵ jump · ⌘↵ bring back · ⇧⌘↵ unmute all · esc");
  private tiles: TileIn[] = [];
  private views: ViewsIn = {};
  private rows: Row[] = [];
  private shown: Hit[] = [];
  private sel = 0;
  /** The selected row's key: a frame that re-ranks the list keeps it selected. */
  private selKey = "";
  private home = "";
  /** Show a workspace's pane in the Dock (main.ts: tabs, then DockView.jump). */
  onJump: (ws: string, pane: string) => void = () => {};

  constructor() {
    this.chip.type = "button";
    this.chip.hidden = true;
    this.chip.title = "Search sessions, tucked and muted ones too (⌘K)";
    this.chip.addEventListener("click", () => this.open());
    this.el.hidden = true;
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-label", "Search sessions");
    this.input.type = "search";
    this.input.placeholder = "search sessions: name, branch, topic, plan, question";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "search sessions");
    this.input.setAttribute("aria-controls", "search-list");
    this.input.addEventListener("input", () => { this.sel = 0; this.selKey = ""; this.draw(); });
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.list.id = "search-list";
    this.list.setAttribute("role", "listbox");
    this.preview.setAttribute("aria-live", "polite");
    const body = el("div", "search-body");
    body.append(this.list, this.preview);
    this.card.append(this.input, body, this.foot);
    this.el.append(this.card);
    this.el.addEventListener("click", (e) => e.target === this.el && this.close());
    document.body.append(this.el);
    // ⌘K from the app's own views; shell.rs's sheet key covers a framed page.
    document.addEventListener(
      "keydown",
      (e) => {
        // While open, the palette has every key: none reaches the view behind.
        if (!this.el.hidden && !this.card.contains(e.target as Node) && !(e.metaKey && e.key.toLowerCase() === "k")) {
          e.stopImmediatePropagation();
          e.preventDefault();
          if (e.key === "Escape") this.close();
          else this.input.focus();
          return;
        }
        if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.toggle();
        }
      },
      true,
    );
  }

  async start(): Promise<void> {
    try {
      this.home = await invoke<string>("home_dir");
    } catch {
      this.home = "";
    }
    await listen<{ tiles?: TileIn[] }>("wall:frame", (e) => { this.tiles = e.payload.tiles ?? []; this.refresh(); });
    await listen<ViewsIn>("views:frame", (e) => { this.views = e.payload; this.refresh(); });
    // ⌘K while focus is in a framed page or a terminal (a shell.rs sheet key).
    await listen<string>("sheet:key", (e) => { if (e.payload === "search") this.toggle(); });
    // ⌥⇧Space from anywhere: shell.rs has already brought the window up.
    await listen("search:open", () => this.open());
    const [w, v] = await Promise.all([invoke<{ tiles?: TileIn[] } | null>("wall_frame"), invoke<ViewsIn | null>("views_frame")]);
    if (w) this.tiles = w.tiles ?? [];
    if (v) this.views = v;
    this.refresh();
  }

  private inputs(): Inputs {
    const asks = (this.views.decisions ?? []).flatMap((d) =>
      d.kind === "question" ? [{ ws: d.ws, text: d.questions.map((q) => q.question).join(" ") }]
      : d.kind === "asked" ? [{ ws: d.ws, text: d.question }] : []);
    return {
      tiles: this.tiles, plans: this.views.plans ?? [], asks, tucked: this.views.tucked ?? [],
      priority: this.views.priority ?? {}, branches: this.views.branches ?? {},
    };
  }

  /** A frame came in: the chip always follows; the rows are rebuilt only
   *  while the search is open (open() builds them afresh). */
  private refresh(): void {
    const tucked = this.views.tucked ?? [];
    const waiting = tucked.some((r) => r.level === "tuck" && r.waiting);
    this.chip.hidden = tucked.length === 0;
    this.chip.replaceChildren(document.createTextNode(`Tucked · ${tucked.length}`));
    if (waiting) {
      const d = el("i", "tuck-dot");
      d.setAttribute("aria-label", "a tucked workspace is waiting on you");
      this.chip.append(d);
    }
    this.chip.classList.toggle("waiting", waiting);
    if (!this.el.hidden) {
      this.rows = rowsOf(this.inputs());
      this.draw();
    }
  }

  toggle(): void {
    if (this.el.hidden) this.open();
    else this.close();
  }

  open(): void {
    this.el.hidden = false;
    this.input.value = "";
    this.sel = 0;
    this.selKey = "";
    this.rows = rowsOf(this.inputs());
    this.draw();
    this.input.focus();
  }

  close(): void {
    this.el.hidden = true;
    this.input.blur();
  }

  private tilde(p: string): string {
    return this.home && p.startsWith(this.home + "/") ? "~" + p.slice(this.home.length) : p;
  }

  private draw(): void {
    this.shown = search(this.rows, this.input.value);
    // The selection follows its row through a re-rank; a row that left the
    // list leaves the selection where it was, kept in range.
    const kept = this.selKey ? this.shown.findIndex((h) => h.row.key === this.selKey) : -1;
    this.sel = kept >= 0 ? kept : Math.min(this.sel, Math.max(0, this.shown.length - 1));
    this.selKey = this.shown[this.sel]?.row.key ?? "";
    if (!this.shown.length) {
      const empty = el("div", "search-empty");
      const cat = el("div", "search-cat");
      cat.innerHTML = catSvg("perk");
      empty.append(cat, el("p", "", this.rows.length ? "nobody by that name" : "no sessions open yet"));
      this.list.replaceChildren(empty);
      this.preview.replaceChildren();
      return;
    }
    const kids: Node[] = [];
    let tuckedYet = false;
    this.shown.forEach((h, i) => {
      if (h.row.level && !tuckedYet) {
        tuckedYet = true;
        kids.push(el("div", "search-sect", "tucked and muted"));
      }
      kids.push(this.rowEl(h, i));
    });
    this.list.replaceChildren(...kids);
    this.list.querySelector(".palette-row.sel")?.scrollIntoView({ block: "nearest" });
    this.drawPreview(this.shown[this.sel]);
  }

  private rowEl(h: Hit, i: number): HTMLElement {
    const r = h.row;
    const row = el("div", `palette-row search-row${i === this.sel ? " sel" : ""}${r.level ? " away" : ""}`);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(i === this.sel));
    const name = el("span", "palette-name");
    const b = el("b");
    b.append(...marked(r.name, h.marks.name));
    name.append(dot(r), b);
    const meta = el("span", "palette-meta");
    const second = this.secondLine(h);
    meta.append(...second);
    const when = el("span", "palette-when", r.level ? (r.level === "tuck" ? "tucked" : "muted") : ago(Date.now() - r.since));
    row.append(name, when, meta);
    row.addEventListener("mousemove", () => {
      if (this.sel !== i) { this.sel = i; this.selKey = r.key; this.draw(); }
    });
    row.addEventListener("click", () => { this.sel = i; this.selKey = r.key; void this.choose(false); });
    return row;
  }

  /** The row's second line: the field the query matched, else the branch,
   *  else where it lives. */
  private secondLine(h: Hit): Node[] {
    const r = h.row;
    const f: Field = (FIELDS.filter((x) => x !== "name").find((x) => h.marks[x]?.length) as Field | undefined)
      ?? (r.branch ? "branch" : "path");
    const text = f === "path" ? this.tilde(r.path) : r[f];
    // A tilde shortens the path, so its marks no longer line up: plain then.
    return marked(text, f === "path" && text !== r.path ? undefined : h.marks[f]);
  }

  private drawPreview(h: Hit | undefined): void {
    if (!h) { this.preview.replaceChildren(); return; }
    const r = h.row;
    const head = el("div", "search-p-head");
    const t = el("b");
    t.append(...marked(r.name, h.marks.name));
    head.append(dot(r), t);
    const bits: Node[] = [head];
    const line = (label: string, text: string, f?: Field) => {
      if (!text) return;
      const p = el("p", "search-p-line");
      p.append(el("span", "search-p-k", label));
      const v = el("span", "search-p-v");
      v.append(...marked(text, f && f !== "path" ? h.marks[f] : undefined));
      p.append(v);
      bits.push(p);
    };
    line("state", `${r.level ? (r.level === "tuck" ? "tucked · " : "muted · ") : ""}${STATE_SAID[r.state] ?? r.state} · ${ago(Date.now() - r.since)}`);
    line("branch", r.branch, "branch");
    line("plan", r.plan, "plan");
    line("about", r.topic, "topic");
    line("where", this.tilde(r.path), "path");
    if (r.ask) {
      const q = el("blockquote", "search-p-ask");
      q.append(...marked(r.ask, h.marks.ask));
      bits.push(q);
    }
    const tail = r.lines.slice(-8).join("\n").trim();
    if (tail) bits.push(el("pre", "search-p-lines", tail));
    else if (!r.ws) bits.push(el("p", "search-p-none", "Nothing open here. ⌘↵ brings the worktree back."));
    this.preview.replaceChildren(...bits);
  }

  /** Enter: jump to the session (a tucked worktree with nothing open is
   *  brought back instead). `restore`: ⌘Enter, bring a tucked or muted one
   *  back, then jump when it has a session. */
  private async choose(restore: boolean): Promise<void> {
    const r = this.shown[this.sel]?.row;
    if (!r) return;
    if (r.tuckPath && (restore || !r.ws)) {
      try {
        await invoke("tuck_restore", { path: r.tuckPath });
        say(`${r.name} is back`);
      } catch (e) {
        say(String(e), undefined, true);
        return;
      }
    }
    this.close();
    if (r.ws) this.onJump(r.ws, r.pane);
  }

  private key(e: KeyboardEvent): void {
    e.stopPropagation(); // the views' keys stay out of the search box
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.sel = Math.max(0, Math.min(this.shown.length - 1, this.sel + (e.key === "ArrowDown" ? 1 : -1)));
      this.selKey = this.shown[this.sel]?.row.key ?? "";
      this.draw();
    } else if (e.key === "Enter" && e.metaKey && e.shiftKey) {
      e.preventDefault();
      void (async () => {
        try {
          const n = await invoke<number>("tuck_unmute_all");
          say(n === 1 ? "1 workspace unmuted" : `${n} workspaces unmuted`);
        } catch (err) {
          say(String(err), undefined, true);
        }
      })();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void this.choose(e.metaKey);
    }
  }
}
