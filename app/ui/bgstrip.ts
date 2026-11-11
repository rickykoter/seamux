// A pane's background shells (bg_app.rs): a slim strip under the terminal
// while any runs or lately ended ("2 running · npm run dev · pytest"), and
// a list above it on click, with each one's last output and Stop.
import { invoke } from "@tauri-apps/api/core";

type Shell = {
  id: string;
  command: string;
  label: string;
  /** running, done, failed, cancelled, or unknown: gone without a word (bgshells::board_state). */
  state: string;
  exit: number | null;
  at: number;
  ended: number | null;
  tail?: string;
};

const POLL_MS = 3000;
/** How long a Stop's button waits for the shell's end to show before it can be pressed again. */
const STOP_WAIT_MS = 8000;
const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A state's mark: a turning arc while it runs, a tick, a cross, a dash. */
function mark(state: string): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 12 12");
  s.setAttribute("width", "11");
  s.setAttribute("height", "11");
  s.setAttribute("aria-hidden", "true");
  s.classList.add("bg-mark", state);
  const path = (d: string) => {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    s.append(p);
  };
  if (state === "running") path("M6 1.5a4.5 4.5 0 1 1-4.5 4.5");
  else if (state === "done") path("M2.5 6.2l2.3 2.3 4.7-5");
  else if (state === "failed") path("M3 3l6 6M9 3l-6 6");
  else path("M3 6h6");
  return s;
}

/** How long, as "12s", "4m" or "1h 05m". */
function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const name = (s: Shell) => s.label || s.command;

export class BgStrip {
  /** The strip, under the terminal. */
  el = el("div", "pane-bgstrip");
  /** The list, over the terminal's bottom, while open. */
  list = el("div", "pane-bglist");
  /** Shown or hidden: the pane fits its terminal again. */
  onChange: () => void = () => {};
  private summary = el("button", "bg-summary");
  private surface = "";
  private shells: Shell[] = [];
  private timer = 0;
  private open = false;
  /** Outputs the person opened, by shell id. */
  private showing = new Set<string>();
  /** Shells sent a Stop, by id, and when: their button waits a moment for the end to show. */
  private stopping = new Map<string, number>();
  /** What the list last drew: a poll that brings nothing new leaves it be. */
  private drawn = "";
  private gen = 0;

  constructor(private say: (text: string) => void) {
    this.el.hidden = true;
    this.list.hidden = true;
    this.list.setAttribute("role", "dialog");
    this.list.setAttribute("aria-label", "Background shells");
    this.summary.type = "button";
    this.summary.addEventListener("click", () => this.toggle());
    this.el.append(this.summary);
    for (const e of [this.el, this.list]) e.addEventListener("mousedown", (ev) => ev.stopPropagation(), true);
    this.list.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.toggle(false);
      }
    });
  }

  /** Watch `surface`'s shells ("" stops). */
  watch(surface: string): void {
    if (surface === this.surface) return;
    this.surface = surface;
    this.gen++;
    this.shells = [];
    this.showing.clear();
    this.toggle(false);
    this.draw();
    clearTimeout(this.timer);
    if (surface) void this.poll();
  }

  private async poll(): Promise<void> {
    const gen = this.gen;
    const surface = this.surface;
    // An unseen pane does not ask; it looks again on the next tick.
    const seen = this.el.isConnected && !document.hidden;
    const got = seen ? await invoke<Shell[]>("bg_shells", { surface, tails: this.open }).catch(() => null) : null;
    if (gen !== this.gen) return;
    if (got) {
      this.shells = got;
      this.draw();
    }
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.poll(), POLL_MS);
  }

  private toggle(to = !this.open): void {
    this.open = to && this.shells.length > 0;
    this.list.hidden = !this.open;
    this.summary.setAttribute("aria-expanded", String(this.open));
    if (this.open) {
      // Its output now, not at the next tick.
      clearTimeout(this.timer);
      void this.poll();
    }
    this.drawList();
  }

  private draw(): void {
    const was = !this.el.hidden;
    const running = this.shells.filter((s) => s.state === "running");
    const failed = this.shells.filter((s) => s.state === "failed");
    this.el.hidden = this.shells.length === 0;
    if (this.el.hidden && this.open) this.toggle(false);
    const parts: (string | Node)[] = [];
    const lead = running.length ? "running" : failed.length ? "failed" : "done";
    parts.push(mark(lead));
    const words = running.length
      ? `${running.length} running`
      : failed.length
        ? `${failed.length} failed`
        : `${this.shells.length} finished`;
    parts.push(el("span", "bg-count", words));
    const names = (running.length ? running : this.shells).slice(0, 3).map(name);
    for (const n of names) parts.push(el("span", "bg-dot", "·"), el("span", "bg-name", n));
    if (running.length && failed.length) parts.push(el("span", "bg-dot", "·"), el("span", "bg-bad", `${failed.length} failed`));
    this.summary.replaceChildren(...parts);
    this.summary.title = `Background shells Claude started: ${this.shells.map((s) => `${name(s)} (${s.state})`).join(", ")}. Click for their output and Stop.`;
    this.el.dataset.lead = lead;
    if (this.open) this.drawList();
    if (was !== !this.el.hidden) this.onChange();
  }

  private drawList(): void {
    if (!this.open) {
      this.drawn = "";
      return this.list.replaceChildren();
    }
    const now = Date.now();
    for (const [id, at] of this.stopping) if (now - at > STOP_WAIT_MS) this.stopping.delete(id);
    // Redrawn only when something shown changed: a redraw would move the
    // output a person scrolled up in, and the button they were about to press.
    const sig = JSON.stringify([this.shells, [...this.showing], [...this.stopping.keys()], Math.floor(now / 60_000)]);
    if (sig === this.drawn) return;
    this.drawn = sig;
    // Each open output's place: kept where it was scrolled up, else at the newest line.
    const kept = new Map<string, number | null>();
    for (const pre of this.list.querySelectorAll<HTMLPreElement>("pre[data-id]")) {
      const bottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 4;
      kept.set(pre.dataset.id!, bottom ? null : pre.scrollTop);
    }
    const rows = this.shells.map((s) => {
      const row = el("div", `bg-row ${s.state}`);
      const head = el("div", "bg-head");
      const what = el("span", "bg-what", name(s));
      what.title = s.command;
      const when = el(
        "span",
        "bg-when",
        s.state === "running" ? took(now - s.at) : s.state === "unknown" ? "ended without a word" : `${s.state} ${took((s.ended ?? now) - s.at)}`,
      );
      if (s.state === "unknown") when.title = "Nothing writes its output any more, and Claude never said how it ended";
      head.append(mark(s.state), what, when);
      if (s.exit !== null && s.exit !== 0) head.append(el("span", "bg-exit", `exit ${s.exit}`));
      const out = el("button", "bg-btn", this.showing.has(s.id) ? "Hide output" : "Output");
      out.type = "button";
      out.addEventListener("click", () => {
        if (this.showing.has(s.id)) this.showing.delete(s.id);
        else this.showing.add(s.id);
        this.drawList();
      });
      head.append(out);
      if (s.state === "running") {
        const stop = el("button", "bg-btn bg-stop", this.stopping.has(s.id) ? "Stopping…" : "Stop");
        stop.type = "button";
        stop.disabled = this.stopping.has(s.id);
        stop.addEventListener("click", () => {
          this.stopping.set(s.id, Date.now());
          this.drawList();
          const again = () => {
            this.stopping.delete(s.id);
            this.drawList();
          };
          void invoke<number>("bg_stop", { surface: this.surface, id: s.id }).then(
            (n) => {
              if (n) this.say(`Sent stop to ${name(s)} (${n} process${n === 1 ? "" : "es"})`);
              else {
                this.say("Found no process of it to stop");
                again();
              }
            },
            (err) => {
              this.say(`Couldn't stop it: ${err}`);
              again();
            },
          );
        });
        head.append(stop);
      }
      row.append(head);
      if (s.label && s.label !== s.command) row.append(el("code", "bg-cmd", s.command));
      if (this.showing.has(s.id)) {
        const pre = el("pre", "bg-tail", s.tail?.trimEnd() || "(no output yet)");
        pre.dataset.id = s.id;
        row.append(pre);
        const at = kept.get(s.id);
        requestAnimationFrame(() => (pre.scrollTop = at ?? pre.scrollHeight));
      }
      return row;
    });
    this.list.replaceChildren(...rows);
  }
}
