import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { say, type TuckRow } from "./tuck";
import { ago } from "./tiles";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Rows matching every word of `q` in their name, branch or path. */
export function filter(rows: TuckRow[], q: string): TuckRow[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    const hay = `${r.name} ${r.branch} ${r.path}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Waiting first, then tucked before muted, then most recent first. */
export function sorted(rows: TuckRow[]): TuckRow[] {
  return [...rows].sort((a, b) => Number(b.waiting) - Number(a.waiting) || (a.level === b.level ? 0 : a.level === "tuck" ? -1 : 1) || b.last - a.last);
}

/** The Tucked chip in the tab strip and the Command-K palette that brings workspaces back. */
export class Palette {
  chip = el("button", "tuck-chip");
  private el = el("div", "palette");
  private card = el("div", "palette-card");
  private input = el("input", "palette-q");
  private list = el("div", "palette-list");
  private foot = el("div", "palette-foot", "↵ restore · ⌘↵ unmute all · esc");
  private rows: TuckRow[] = [];
  private shown: TuckRow[] = [];
  private sel = 0;
  private home = "";

  constructor() {
    this.chip.type = "button";
    this.chip.hidden = true;
    this.chip.title = "Muted and tucked workspaces (⌘K)";
    this.chip.addEventListener("click", () => this.open());
    this.el.className = "palette";
    this.el.hidden = true;
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-label", "Bring back a workspace");
    this.input.type = "search";
    this.input.placeholder = "search muted and tucked workspaces";
    this.input.spellcheck = false;
    this.input.setAttribute("aria-label", "search muted and tucked workspaces");
    this.input.addEventListener("input", () => {
      this.sel = 0;
      this.draw();
    });
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.list.setAttribute("role", "listbox");
    this.card.append(this.input, this.list, this.foot);
    this.el.append(this.card);
    this.el.addEventListener("click", (e) => e.target === this.el && this.close());
    document.body.append(this.el);
    // Command-K from any of the app's own views (a framed page keeps its keys).
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
          if (this.el.hidden) this.open();
          else this.close();
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
    await listen<{ tucked?: TuckRow[] }>("views:frame", (e) => this.setRows(e.payload.tucked ?? []));
    const v = await invoke<{ tucked?: TuckRow[] } | null>("views_frame");
    if (v) this.setRows(v.tucked ?? []);
  }

  private setRows(rows: TuckRow[]): void {
    this.rows = rows;
    const waiting = rows.some((r) => r.level === "tuck" && r.waiting);
    this.chip.hidden = rows.length === 0;
    this.chip.replaceChildren(document.createTextNode(`Tucked · ${rows.length}`));
    if (waiting) {
      const dot = el("i", "tuck-dot");
      dot.setAttribute("aria-label", "a tucked workspace is waiting on you");
      this.chip.append(dot);
    }
    this.chip.classList.toggle("waiting", waiting);
    if (!this.el.hidden) this.draw();
  }

  open(): void {
    this.el.hidden = false;
    this.input.value = "";
    this.sel = 0;
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
    this.shown = sorted(filter(this.rows, this.input.value));
    this.sel = Math.min(this.sel, Math.max(0, this.shown.length - 1));
    if (!this.shown.length) {
      this.list.replaceChildren(el("p", "palette-empty", this.rows.length ? "nothing matches" : "nothing is muted or tucked"));
      return;
    }
    this.list.replaceChildren(
      ...this.shown.map((r, i) => {
        const row = el("div", `palette-row${i === this.sel ? " sel" : ""}`);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === this.sel));
        const name = el("span", "palette-name");
        name.append(el("b", "", r.name));
        if (r.waiting) name.append(el("i", "tuck-dot"));
        const meta = el("span", "palette-meta", [r.branch, this.tilde(r.path)].filter(Boolean).join("  ·  "));
        const lvl = el("span", `palette-level ${r.level}`, r.level === "tuck" ? "tucked" : "muted");
        const when = el("span", "palette-when", ago(Date.now() - r.last));
        const back = el("button", "palette-back", r.level === "tuck" ? "Bring back" : "Unmute");
        back.type = "button";
        back.addEventListener("click", () => void this.restore(r));
        row.append(name, meta, lvl, when, back);
        row.addEventListener("mousemove", () => {
          if (this.sel !== i) {
            this.sel = i;
            this.draw();
          }
        });
        return row;
      }),
    );
  }

  private async restore(r: TuckRow): Promise<void> {
    try {
      await invoke("tuck_restore", { path: r.path });
      say(`${r.name} is back`);
      this.rows = this.rows.filter((x) => x.path !== r.path);
      this.setRows(this.rows);
      if (!this.rows.length) this.close();
    } catch (e) {
      say(String(e), undefined, true);
    }
  }

  private key(e: KeyboardEvent): void {
    e.stopPropagation(); // the views' keys stay out of the search box
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.sel = Math.max(0, Math.min(this.shown.length - 1, this.sel + (e.key === "ArrowDown" ? 1 : -1)));
      this.draw();
    } else if (e.key === "Enter" && e.metaKey) {
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
      const r = this.shown[this.sel];
      if (r) void this.restore(r);
    }
  }
}
