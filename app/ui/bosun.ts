import { invoke } from "@tauri-apps/api/core";
import { TermSlot } from "./native";
import { follow, openFile } from "./panelinks";
import {
  daysToLoad, dropAct, freshIds, mood, rail, recheck, sourceTarget, tilde,
  type Card, type LogPage, type Mood, type Status,
} from "./bosun_model";

// The Bosun (crates/crew-core/src/bosun): one long-running, read-only
// Claude over the code root. Its ⌘4 tab is a rail of past answers beside
// its terminal; ⌘B drops the same terminal down over any view. There is
// one TermSlot, moved between the two, so only one tmux client ever types
// into the Bosun. The pages reach it only through bosun_app.rs's commands.

/** How often the Bosun's state and log are read while it shows. */
const EVERY = 4000;
/** How long a fresh answer's trill lasts. */
const TRILL_MS = 1400;
const FOLD_KEY = "seamux.bosun.railFolded";
const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** A brass bosun's call: the gun (the pipe) with its mouthpiece on the
 *  left, the buoy (the ball) on the right, the keel beneath, a ring on the
 *  keel. Sound arcs leave the buoy's hole when it pipes. */
export function whistle(): SVGSVGElement {
  const s = svg("svg", { viewBox: "0 0 40 24", class: "bosun-whistle", "aria-hidden": "true", "data-mood": "rest" });
  const body = svg("g", { class: "bw-body" }, s);
  svg("path", { class: "bw-keel", d: "M7 13.5 C 11 19, 19 19, 23 13.5" }, body);
  svg("circle", { class: "bw-ring", cx: 15, cy: 18.6, r: 1.8 }, body);
  svg("path", { class: "bw-gun", d: "M3 10.2 L 22 9.2 L 22 13.2 L 3 12.4 Z" }, body);
  svg("rect", { class: "bw-mouth", x: 2, y: 9.6, width: 2.6, height: 3.4, rx: 0.8 }, body);
  svg("circle", { class: "bw-buoy", cx: 25.5, cy: 11.2, r: 4.2 }, body);
  svg("circle", { class: "bw-hole", cx: 27.2, cy: 9.6, r: 1.1 }, body);
  svg("ellipse", { class: "bw-shine", cx: 24.2, cy: 9.6, rx: 1.2, ry: 0.7 }, body);
  const arcs = svg("g", { class: "bw-arcs" }, s);
  for (const [i, r] of [3.5, 6, 8.5].entries()) {
    svg("path", { class: `bw-arc bw-arc${i}`, d: `M${28 + r * 0.55} ${9.6 - r * 0.8} A ${r} ${r} 0 0 1 ${28 + r * 0.55} ${9.6 + r * 0.5}` }, arcs);
  }
  return s;
}

/** The ⌘4 tab and the ⌘B drop-down: one Bosun, two places to see it. */
export class BosunView {
  /** Told when the drop-down opens or closes (main.ts keeps no state of its own). */
  onDrop: (open: boolean) => void = () => {};

  private term = new TermSlot();
  private rail = el("aside", "bosun-rail");
  private railList = el("div", "bosun-list");
  private tabHost = el("div", "bosun-host");
  private tabHead = el("div", "bosun-head");
  private drop = el("div", "bosun-drop");
  private dropHead = el("div", "bosun-head");
  private dropHost = el("div", "bosun-host");
  private dim = el("div", "bosun-dim");
  private whistles: SVGSVGElement[] = [];
  private note = el("div", "bosun-note");

  private status: Status | null = null;
  private pages: LogPage[] = [];
  /** The entry ids seen so far; null until the first read, so the first look trills nothing. */
  private seen: Set<string> | null = null;
  private opened = new Set<string>();
  private queued = new Map<string, string>();
  private tabShown = false;
  private dropOpen = false;
  private timer = 0;
  private trillUntil = 0;
  private stateSince = 0;
  private lastState = "";
  /** The person asked for the Bosun (opened the tab or ⌘B) this page load, so a stopped one is started. */
  private asked = false;
  private ensuring = false;
  private ensureErr = "";
  private before: HTMLElement | null = null;

  constructor(private panel: HTMLElement, stage: HTMLElement) {
    panel.classList.add("bosun");
    // The rail: a title with a fold, and the day groups.
    const railHead = el("div", "bosun-rail-head");
    const title = el("span", "bosun-rail-title", "Answers");
    const fold = el("button", "bosun-fold");
    fold.type = "button";
    fold.title = "Fold the answer rail";
    fold.setAttribute("aria-label", "Fold the answer rail");
    fold.textContent = "‹";
    fold.addEventListener("click", () => this.fold(!this.panel.classList.contains("folded")));
    railHead.append(title, fold);
    this.rail.append(railHead, this.railList);
    this.rail.setAttribute("aria-label", "The Bosun's answers");

    const main = el("section", "bosun-main");
    this.tabHead.append(this.mark(), el("span", "bosun-name", "Bosun"), el("span", "bosun-root"), el("span", "bosun-state"));
    main.append(this.tabHead, this.tabHost);
    panel.append(this.rail, main);
    try {
      if (localStorage.getItem(FOLD_KEY) === "1") this.fold(true, false);
    } catch {
      /* no storage: the rail starts open */
    }

    // The drop-down: over the top of the stage, the rest dimmed.
    this.drop.setAttribute("role", "dialog");
    this.drop.setAttribute("aria-label", "The Bosun");
    this.drop.hidden = true;
    this.dim.hidden = true;
    const key = el("span", "bosun-key", "⌘B");
    key.title = "⌘B puts the Bosun away";
    this.dropHead.append(this.mark(), el("span", "bosun-name", "Bosun"), el("span", "bosun-root"), el("span", "bosun-state"), key);
    this.drop.append(this.dropHead, this.dropHost);
    this.dim.addEventListener("click", () => this.setDrop(false));
    stage.append(this.dim, this.drop);

    this.term.onTrouble = () => this.draw();
  }

  private mark(): SVGSVGElement {
    const w = whistle();
    this.whistles.push(w);
    return w;
  }

  private fold(on: boolean, keep = true): void {
    this.panel.classList.toggle("folded", on);
    const b = this.rail.querySelector<HTMLButtonElement>(".bosun-fold")!;
    b.textContent = on ? "›" : "‹";
    b.title = on ? "Show the answer rail" : "Fold the answer rail";
    b.setAttribute("aria-label", b.title);
    if (keep) {
      try {
        localStorage.setItem(FOLD_KEY, on ? "1" : "0");
      } catch {
        /* the fold just isn't remembered */
      }
    }
  }

  /** The tab shows (true) or another view does. */
  setShown(on: boolean): void {
    this.tabShown = on;
    if (on && this.dropOpen) this.setDrop(false);
    if (on) this.ask();
    this.place();
    this.tick();
  }

  /** ⌘B: on the Bosun tab, focus its terminal; elsewhere drop it down or put it away. */
  key(tab: string): void {
    const act = dropAct(tab, this.dropOpen);
    if (act === "focus") this.term.focus();
    else this.setDrop(act === "open");
  }

  /** Whether the drop-down is down. */
  isDown(): boolean {
    return this.dropOpen;
  }

  setDrop(open: boolean): void {
    if (open === this.dropOpen) return;
    this.dropOpen = open;
    if (open) {
      this.before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.drop.hidden = this.dim.hidden = false;
      // Hidden, then shown, then the class: the slide runs from the top.
      requestAnimationFrame(() => {
        this.drop.classList.add("down");
        this.dim.classList.add("down");
      });
      this.ask();
    } else {
      this.drop.classList.remove("down");
      this.dim.classList.remove("down");
      const done = () => {
        if (!this.dropOpen) this.drop.hidden = this.dim.hidden = true;
      };
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
      else window.setTimeout(done, 200);
      this.before?.focus?.();
      this.before = null;
    }
    this.place();
    this.tick();
    this.onDrop(open);
    if (open) window.setTimeout(() => this.term.focus(), 60);
  }

  /** The person wants the Bosun: start it once this page load if it is not running. */
  private ask(): void {
    this.asked = true;
  }

  /** The terminal lives in the drop-down while it is down, else in the tab. */
  private place(): void {
    const host = this.dropOpen ? this.dropHost : this.tabHost;
    if (this.term.el.parentElement !== host) host.prepend(this.term.el);
    if (this.note.parentElement !== host) host.append(this.note);
  }

  private visible(): boolean {
    return this.tabShown || this.dropOpen;
  }

  /** Read now, and on a timer while either place shows. */
  private tick(): void {
    window.clearTimeout(this.timer);
    if (!this.visible()) return;
    void this.read().finally(() => {
      if (this.visible()) this.timer = window.setTimeout(() => this.tick(), EVERY);
    });
  }

  private async read(): Promise<void> {
    let s = await invoke<Status>("bosun_status").catch((e) => ({ backend: "", tmux: false, known: false, live: false, why: String(e) }) as Status);
    if (s.tmux && !s.live && this.asked && !this.ensuring && !this.ensureErr) {
      this.ensuring = true;
      this.draw(s);
      try {
        s = await invoke<Status>("bosun_ensure");
      } catch (e) {
        this.ensureErr = String(e);
      } finally {
        this.ensuring = false;
      }
    }
    this.status = s;
    await this.readLog();
    this.draw(s);
  }

  private async readLog(): Promise<void> {
    const first = await invoke<LogPage>("bosun_log").catch(() => null);
    if (!first) return;
    const more = await Promise.all(
      daysToLoad(first.today, first.days).filter((d) => d !== first.day).map((d) => invoke<LogPage>("bosun_log", { day: d }).catch(() => null)),
    );
    this.pages = [first, ...more.filter((p): p is LogPage => !!p)];
    const ids = this.pages.flatMap((p) => p.entries.map((e) => e.id));
    if (freshIds(this.seen, ids).length) this.trillUntil = performance.now() + TRILL_MS;
    this.seen = new Set(ids);
  }

  private draw(s: Status | null = this.status): void {
    // The header: where it works and what it is doing.
    const root = s?.root ? tilde(s.root) : "";
    const said = !s ? "" : !s.tmux ? "" : this.ensuring ? "starting…" : s.live ? (s.state === "working" ? "working" : s.state === "needs_input" ? "needs you" : "idle") : "not running";
    for (const head of [this.tabHead, this.dropHead]) {
      head.querySelector(".bosun-root")!.textContent = root ? `· ${root}` : "";
      const st = head.querySelector<HTMLElement>(".bosun-state")!;
      st.textContent = said;
      st.dataset.state = s?.live ? s.state ?? "" : "off";
    }
    const state = s?.live ? s.state ?? "" : "";
    if (state !== this.lastState) {
      this.lastState = state;
      this.stateSince = Date.now();
    }
    const m: Mood = mood(state, performance.now() < this.trillUntil);
    for (const w of this.whistles) w.dataset.mood = m;
    if (m === "trill") window.setTimeout(() => this.draw(), TRILL_MS + 20);
    document.body.dataset.bosun = state === "working" ? "working" : "";

    // The terminal, or why there is none.
    if (s && s.tmux && s.live && s.pane) {
      this.term.show(s.pane);
      this.term.agentState(state, this.stateSince);
      this.term.el.hidden = false;
      this.note.hidden = true;
    } else {
      this.term.stop();
      this.term.el.hidden = true;
      this.note.hidden = false;
      this.drawNote(s);
    }
    this.drawRail();
  }

  private drawNote(s: Status | null): void {
    this.note.replaceChildren();
    if (!s) {
      this.note.append(el("p", "", "Looking for the Bosun…"));
      return;
    }
    if (!s.tmux) {
      this.note.append(
        el("p", "bosun-note-t", "The Bosun needs the tmux backend."),
        el("p", "", `It runs on the app's own tmux sessions, and this app is on ${s.backend || "another backend"}. Start the app with SEAMUX_BACKEND=tmux to use it.`),
      );
      return;
    }
    if (this.ensuring) {
      this.note.append(el("p", "", "Starting the Bosun…"));
      return;
    }
    this.note.append(el("p", "bosun-note-t", this.ensureErr ? "The Bosun didn't start." : "The Bosun isn't running."));
    if (this.ensureErr) this.note.append(el("p", "bosun-err", this.ensureErr));
    const b = el("button", "retry", this.ensureErr ? "Try again" : "Start the Bosun");
    b.type = "button";
    b.addEventListener("click", () => {
      this.ensureErr = "";
      this.asked = true;
      this.tick();
    });
    this.note.append(b);
  }

  private drawRail(): void {
    const days = rail(this.pages);
    this.railList.replaceChildren();
    if (!days.length || days.every((d) => !d.cards.length)) {
      this.railList.append(el("p", "bosun-empty", this.status?.tmux === false ? "No answers here: the Bosun runs on tmux." : "No answers yet. What the Bosun answers shows here, newest first."));
      return;
    }
    for (const d of days) {
      if (!d.cards.length) continue;
      const g = el("section", "bosun-day");
      g.append(el("h3", "bosun-day-t", d.label));
      for (const c of d.cards) g.append(this.card(c));
      this.railList.append(g);
    }
  }

  private card(c: Card): HTMLElement {
    const open = this.opened.has(c.id);
    const a = el("article", `bosun-card${open ? " open" : ""}`);
    const top = el("div", "bosun-card-top", c.from ? `${c.time} · ${c.from}` : c.time);
    const q = el("p", "bosun-q", c.question);
    a.append(top, q);
    if (open) {
      a.append(el("div", "bosun-answer", c.entry.answer.trim()));
      if (c.entry.sources.length) {
        const ul = el("ul", "bosun-sources");
        for (const s of c.entry.sources) {
          const li = el("li");
          const t = sourceTarget(s);
          const label = s.label || s.ref;
          if (t) {
            const link = el("a", "bosun-src", label);
            link.href = "url" in t ? t.url : "#";
            link.title = s.ref;
            link.addEventListener("click", (e) => {
              e.preventDefault();
              if ("url" in t) void follow(t.url, null, e);
              else void openFile(t.path, { line: t.line }, null, e);
            });
            li.append(el("span", "bosun-src-k", s.kind || "link"), link);
          } else {
            li.append(el("span", "bosun-src-k", s.kind || "ref"), el("code", "bosun-src-ref", label === s.ref ? s.ref : `${label}: ${s.ref}`));
          }
          ul.append(li);
        }
        a.append(ul);
      }
    } else if (c.first) {
      a.append(el("p", "bosun-first", c.first));
    }
    if (c.chips.length) {
      const row = el("div", "bosun-chips");
      for (const ch of c.chips) row.append(el("span", `bosun-chip k-${ch.label}`, ch.n > 1 ? `${ch.label} ${ch.n}` : ch.label));
      a.append(row);
    }
    const acts = el("div", "bosun-acts");
    const re = el("button", "bosun-act", open ? "Close" : "Reopen");
    re.type = "button";
    re.addEventListener("click", () => {
      if (open) this.opened.delete(c.id);
      else this.opened.add(c.id);
      this.drawRail();
    });
    const said = this.queued.get(c.id);
    const again = el("button", "bosun-act", said ?? "Re-check");
    again.type = "button";
    again.title = "Ask the Bosun the same question again";
    again.disabled = !!said || this.status?.tmux === false;
    again.addEventListener("click", () => void this.recheck(c));
    acts.append(re, again);
    a.append(acts);
    return a;
  }

  private async recheck(c: Card): Promise<void> {
    this.queued.set(c.id, "Queuing…");
    this.drawRail();
    try {
      await invoke<string>("bosun_send", { text: recheck(c.entry) });
      this.queued.set(c.id, "Queued");
    } catch (e) {
      this.queued.set(c.id, "Couldn't queue");
      console.error("bosun re-check", e);
    }
    this.drawRail();
    window.setTimeout(() => {
      this.queued.delete(c.id);
      this.drawRail();
    }, 4000);
  }

  /** An Ask was queued (bosun_ask.ts): drop the Bosun down to watch it answer, or read now on its tab. */
  afterAsk(): void {
    this.asked = true;
    if (!this.tabShown) this.setDrop(true);
    else this.tick();
  }

  /** Keyboard focus in the view's main area, its terminal (main.ts, on picking the tab). */
  focusMain(): void {
    window.setTimeout(() => this.term.focus(), 60);
  }
}
