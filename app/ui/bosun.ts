import { invoke } from "@tauri-apps/api/core";
import { TermSlot } from "./native";
import { follow, openFile } from "./panelinks";
import {
  ago, askAgain, card as toCard, chipTitle, daysToLoad, dayLabel, dropAct, filterRail, freshIds, hits, kindLabel, landed, matchedWhere, mdBlocks, mdInline, detailRepeatsLine, mood, newerAnswers, olderDays,
  needsCount, pendingNote, rail, reportExtra, sourceRow, sourceTarget, statusLabel, tilde,
  type Card, type Chip, type Entry, type LogPage, type Mood, type ReportRun, type SectionStatus, type Span, type Status,
} from "./bosun_model";

// The Bosun (crates/crew-core/src/bosun): one long-running, read-only
// Claude over the code root. Its ⌘4 tab is a rail of past answers beside
// its terminal; a card opens in a reading pane over the terminal. ⌘B drops
// the same terminal down over any view. There is one TermSlot, moved
// between the two, so only one tmux client ever types into the Bosun. The
// pages reach it only through bosun_app.rs's commands.

/** How often the Bosun's state and log are read while it shows. */
const EVERY = 4000;
/** How often only its state is read while neither place shows (the tab's dot). */
const EVERY_HIDDEN = 15000;
/** How long a fresh answer's trill lasts. */
const TRILL_MS = 1400;
/** How long a re-check waits for its answer before the card lets it go. */
const PENDING_MS = 30 * 60e3;
/** The days the rail loads at first, and how many more each "Show older" adds. */
const SPAN = 4;
const MORE = 7;
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

function button(cls: string, text = "", title = ""): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  return b;
}

/** Small line icons, drawn in currentColor: a chevron, a cross, an arrow
 *  leaving a box (a web page), a page (a file), a magnifier, two sheets (copy). */
type Icon = "left" | "right" | "x" | "web" | "file" | "find" | "copy" | "up" | "check" | "report";
function icon(name: Icon, size = 12): SVGSVGElement {
  const s = svg("svg", { viewBox: "0 0 12 12", width: size, height: size, class: `bosun-ico i-${name}`, "aria-hidden": "true" });
  const line = { fill: "none", stroke: "currentColor", "stroke-width": 1.3, "stroke-linecap": "round", "stroke-linejoin": "round" };
  const d: Record<Icon, string[]> = {
    left: ["M7.5 2.5 4 6l3.5 3.5"],
    right: ["M4.5 2.5 8 6 4.5 9.5"],
    up: ["M6 10V2.5M2.8 5.6 6 2.4l3.2 3.2"],
    x: ["M3 3l6 6M9 3 3 9"],
    web: ["M6.5 2H10v3.5M10 2 5.5 6.5", "M8.5 7.5V10h-6.5V3.5H4.5"],
    file: ["M3 1.5h4l2.5 2.5v6.5H3z", "M7 1.5V4h2.5"],
    find: ["M5.2 8.6a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Z", "M7.7 7.7 10.5 10.5"],
    copy: ["M4 4h6v6.5H4z", "M2 8V1.5h6"],
    check: ["M2.5 6.3 5 8.8l4.5-5.3"],
    report: ["M2 1.5h8v9H2z", "M4 4h4M4 6h4M4 8h2.5"],
  };
  for (const p of d[name]) svg("path", { d: p, ...line }, s);
  return s;
}

/** A report section's dot: amber and filled when it needs you, a hollow
 *  ring when fine, a dotted ring when not checked. Its words are the label. */
function statusDot(s: SectionStatus): SVGSVGElement {
  const d = svg("svg", { viewBox: "0 0 10 10", width: 10, height: 10, class: `bosun-dot s-${s}`, role: "img", "aria-label": statusLabel(s) });
  svg("title", {}, d).textContent = statusLabel(s);
  if (s === "needs") svg("circle", { cx: 5, cy: 5, r: 4, class: "fill" }, d);
  else svg("circle", { cx: 5, cy: 5, r: 3.6, fill: "none", "stroke-width": 1.3, class: "ring", ...(s === "unchecked" ? { "stroke-dasharray": "1.4 1.6" } : {}) }, d);
  return d;
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

/** A re-check on its way: being sent, sent and waiting for its answer (by
 *  its queue id), or stopped, with what to say about it. */
type Pending = { state: "sending" | "waiting" | "failed"; since: number; question: string; qid?: string; err?: string };

/** How long a re-check may take to reach the Bosun's queue before it counts as failed. */
const SEND_MS = 15000;
/** After an answer lands and the rail moves, how long a click on it is held back (it may have been aimed at the card that moved). */
const SETTLE_MS = 600;

/** The ⌘4 tab and the ⌘B drop-down: one Bosun, two places to see it. */
export class BosunView {
  /** Told when the drop-down opens or closes (main.ts keeps no state of its own). */
  onDrop: (open: boolean) => void = () => {};
  /** The drop-down's "Answers" button: main.ts shows the Bosun tab. */
  onAnswers: () => void = () => {};

  private term = new TermSlot();
  private rail = el("aside", "bosun-rail");
  private railList = el("div", "bosun-list");
  private find = el("input", "bosun-find-q");
  private found = el("p", "bosun-found");
  /** Said to a screen reader, not shown: a copy's result. */
  private live = el("p", "bosun-live");
  private foldDot = el("span", "bosun-fold-dot");
  private tabHost = el("div", "bosun-host");
  private tabHead = el("div", "bosun-head");
  private reader = el("div", "bosun-reader");
  private drop = el("div", "bosun-drop");
  private dropHead = el("div", "bosun-head");
  private dropHost = el("div", "bosun-host");
  private dim = el("div", "bosun-dim");
  private whistles: SVGSVGElement[] = [];
  private note = el("div", "bosun-note");

  private status: Status | null = null;
  /** Each logged day read so far. Today is read on every tick; an older day once. */
  private pages = new Map<string, LogPage>();
  private today = "";
  private days: string[] = [];
  /** How many days the rail shows while nothing is typed in the filter. */
  private span = SPAN;
  private query = "";
  /** The entry ids seen so far; null until the first read, so the first look trills nothing. */
  private seen: Set<string> | null = null;
  /** Answers that landed while the page was open and have not been read yet. */
  private fresh = new Set<string>();
  /** The answer in the reading pane, by id (kept, so a filter that hides its card does not close it). */
  private reading: Entry | null = null;
  private pending = new Map<string, Pending>();
  /** A re-checked answer's id, to the answer it came back as (however the Bosun worded it). */
  private answered = new Map<string, string>();
  private settleUntil = 0;
  /** A Copy button showing "Copied": its resting children, and the timer that puts them back. */
  private copyRest = new WeakMap<HTMLButtonElement, { was: ChildNode[]; timer: number }>();
  /** An Ask went out from Radar or Lookout: until then, the log is read from any tab so its answer can light the tab. */
  private watchUntil = 0;
  private dropNew = el("span", "bosun-drop-new");
  /** A card to bring into view on the next draw (a re-check's answer, or a newer answer asked for). */
  private scrollTo = "";
  private railKey = "";
  private readerKey = "";
  /** The report sections opened in the reading pane: "<run>\n<title>". */
  private openSections = new Set<string>();
  private tabShown = false;
  private dropOpen = false;
  private timer = 0;
  /** Counts ticks, so only the newest schedules the next. */
  private ticks = 0;
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
    // The rail: a title with a fold, the filter, and the day groups.
    const railHead = el("div", "bosun-rail-head");
    const title = el("h2", "bosun-rail-title", "Answers");
    const fold = button("bosun-fold", "", "Fold the answer rail");
    fold.append(icon("left"));
    fold.addEventListener("click", () => this.fold(!this.panel.classList.contains("folded")));
    // Folded, the rail is a strip: its name on its side, and a dot when an answer is new.
    const side = button("bosun-fold-side", "", "Show the answer rail");
    side.append(icon("right"), el("span", "bosun-fold-word", "Answers"), this.foldDot);
    side.addEventListener("click", () => this.fold(false));
    railHead.append(title, fold);

    const findRow = el("label", "bosun-find");
    this.find.type = "search";
    this.find.placeholder = "Filter answers";
    this.find.setAttribute("aria-label", "Filter answers: words in the question, the answer, who asked or a source");
    this.find.spellcheck = false;
    this.find.addEventListener("input", () => this.setQuery(this.find.value));
    this.find.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.find.value) {
        // Esc clears the filter first; on an empty one it goes on up (main.ts hides the window).
        e.preventDefault();
        this.find.value = "";
        this.setQuery("");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.railList.querySelector<HTMLElement>(".bosun-card-main")?.focus();
      }
    });
    const slash = el("kbd", "bosun-find-key", "/");
    slash.title = "Press / to filter (from the rail or the reading pane; in the terminal, / goes to the Bosun)";
    findRow.append(icon("find"), this.find, slash);
    this.found.setAttribute("aria-live", "polite");
    this.rail.append(railHead, side, findRow, this.found, this.railList);
    this.rail.setAttribute("aria-label", "The Bosun's answers");
    this.railList.addEventListener("keydown", (e) => this.railKeys(e));

    const main = el("section", "bosun-main");
    const hint = el("span", "bosun-hint");
    hint.append(el("kbd", "", "⌘B"), document.createTextNode(" from any tab"));
    hint.title = "⌘B drops the Bosun down over any tab";
    this.tabHead.append(this.mark(), el("span", "bosun-name", "Bosun"), this.stateEl(), el("span", "bosun-root"), hint);
    this.reader.hidden = true;
    this.reader.setAttribute("role", "region");
    this.reader.setAttribute("aria-label", "The answer");
    this.tabHost.append(this.reader);
    main.append(this.tabHead, this.tabHost);
    this.live.setAttribute("aria-live", "polite");
    panel.append(this.rail, main, this.live);
    // Esc in the reading pane goes back to the terminal (not to main.ts, which would hide the window).
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || !this.reading) return;
      if (this.term.el.contains(e.target as Node) || e.target === this.find) return;
      e.preventDefault();
      this.closeReader(true);
    });
    try {
      if (localStorage.getItem(FOLD_KEY) === "1") this.fold(true, false);
    } catch {
      /* no storage: the rail starts open */
    }

    // The drop-down: over the top of the stage, the rest dimmed.
    this.drop.setAttribute("role", "dialog");
    this.drop.setAttribute("aria-modal", "true");
    this.drop.setAttribute("aria-label", "The Bosun");
    this.drop.hidden = true;
    this.dim.hidden = true;
    const answers = button("bosun-drop-btn", "", "Show the Bosun's answers (⌘4)");
    this.dropNew.hidden = true;
    answers.append(document.createTextNode("Answers"), this.dropNew, el("kbd", "", "⌘4"));
    answers.addEventListener("click", () => this.onAnswers());
    const close = button("bosun-drop-btn bosun-drop-x", "", "Put the Bosun away (Esc or ⌘B). ⇧Esc sends Esc to the Bosun");
    close.append(el("kbd", "", "Esc"), icon("x"));
    close.addEventListener("click", () => this.setDrop(false));
    this.dropHead.append(this.mark(), el("span", "bosun-name", "Bosun"), this.stateEl(), el("span", "bosun-root"), answers, close);
    this.drop.append(this.dropHead, this.dropHost);
    // Esc puts the drop-down away before the terminal sees it: a glance
    // should never cancel the Bosun's turn. On the ⌘4 tab Esc stays the Bosun's.
    this.drop.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          this.setDrop(false);
        }
      },
      true,
    );
    this.dim.addEventListener("click", () => this.setDrop(false));
    stage.append(this.dim, this.drop);

    // "/" filters the answers, from anywhere on the tab but its terminal and fields.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || !this.tabShown || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [contenteditable]") || this.term.el.contains(t))) return;
      e.preventDefault();
      if (this.panel.classList.contains("folded")) this.fold(false);
      this.find.focus();
      this.find.select();
    });

    this.term.onTrouble = () => this.draw();
  }

  private mark(): SVGSVGElement {
    const w = whistle();
    this.whistles.push(w);
    return w;
  }

  private stateEl(): HTMLElement {
    const s = el("span", "bosun-state");
    s.append(el("span", "bosun-state-dot"), el("span", "bosun-state-t"));
    return s;
  }

  private fold(on: boolean, keep = true): void {
    this.panel.classList.toggle("folded", on);
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
    // Leaving the tab: what was new there has been seen.
    if (!on && this.tabShown) {
      this.fresh.clear();
      this.railKey = "";
    }
    this.tabShown = on;
    if (on && this.dropOpen) this.setDrop(false);
    if (on) this.ask();
    this.place();
    this.tick();
  }

  /** ⌘B: on the Bosun tab, back to its terminal; elsewhere drop it down or put it away. */
  key(tab: string): void {
    const act = dropAct(tab, this.dropOpen);
    if (act === "focus") {
      this.closeReader(false);
      this.term.focus();
    } else this.setDrop(act === "open");
  }

  /** Whether the drop-down is down. */
  isDown(): boolean {
    return this.dropOpen;
  }

  setDrop(open: boolean): void {
    if (open === this.dropOpen) return;
    this.dropOpen = open;
    // What lies under the drop-down takes no keys or clicks while it is down.
    for (const c of this.drop.parentElement?.children ?? []) if (c !== this.drop && c !== this.dim) (c as HTMLElement).inert = open;
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
    if (this.note.parentElement !== host) host.insertBefore(this.note, this.term.el.nextSibling);
  }

  private visible(): boolean {
    return this.tabShown || this.dropOpen;
  }

  /** Read now, then again on a timer. One polling chain: a tick that a newer one overtook schedules nothing. While
   *  neither place shows, only the state is read, slowly, so the tab's dot goes out when the Bosun stops. */
  private tick(): void {
    window.clearTimeout(this.timer);
    const g = ++this.ticks;
    const shown = this.visible();
    // A re-check waiting on its answer is read for at the shown pace even from another tab, so the tab can say it landed.
    const waiting = [...this.pending.values()].some((p) => p.state === "waiting") || performance.now() < this.watchUntil;
    void (shown ? this.read() : this.readState(waiting)).finally(() => {
      if (g === this.ticks) this.timer = window.setTimeout(() => this.tick(), this.visible() || waiting ? EVERY : EVERY_HIDDEN);
    });
  }

  /** The state, for the tab's dot (and the log too while a re-check waits): no ensure, nothing drawn. */
  private async readState(log = false): Promise<void> {
    const s = await invoke<Status>("bosun_status").catch(() => null);
    if (!s) return;
    if (log) {
      this.status = s;
      await this.readLog();
    }
    this.tabDot(s.live ? s.state ?? "" : "");
  }

  /** The tab's dot: working, waiting on the person, or a new answer not yet seen there. */
  private tabDot(state: string): void {
    const fresh = !this.tabShown && this.fresh.size > 0;
    document.body.dataset.bosun = state === "working" ? "working" : state === "needs_input" ? "needs" : fresh ? "new" : "";
    // The dot says it in words too, for a tooltip and a screen reader.
    const tab = document.querySelector<HTMLElement>('.tab[data-tab="bosun"]');
    if (tab) {
      const n = this.fresh.size;
      const said =
        state === "working" ? "Bosun: working" : state === "needs_input" ? "Bosun: needs you" : fresh ? `Bosun: ${n} new answer${n === 1 ? "" : "s"}` : "";
      if (said) tab.setAttribute("aria-label", said);
      else tab.removeAttribute("aria-label");
      tab.title = `${said || "Bosun (⌘4)"} · ⌘B drops it over any tab`;
    }
    // The drop-down's Answers button counts them too.
    this.dropNew.textContent = this.fresh.size ? `${this.fresh.size} new` : "";
    this.dropNew.hidden = !this.fresh.size;
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

  /** Today's page, and each older day the rail needs that has not been read:
   *  the newest few, or every logged day while the filter has words in it. */
  private async readLog(): Promise<void> {
    const first = await invoke<LogPage>("bosun_log").catch(() => null);
    if (!first) return;
    this.today = first.today;
    this.days = first.days;
    this.pages.set(first.day, first);
    const want = this.query.trim() ? [first.today, ...first.days] : daysToLoad(first.today, first.days, this.span);
    const missing = [...new Set(want)].filter((d) => d !== first.day && !this.pages.has(d));
    const more = await Promise.all(missing.map((d) => invoke<LogPage>("bosun_log", { day: d }).catch(() => null)));
    for (const p of more) if (p) this.pages.set(p.day, p);

    const all = this.entries();
    // New answers land only in today's log: an older day read for the first
    // time (Show older, a filter) holds nothing new, only things not yet seen.
    const fresh = freshIds(this.seen, first.entries.map((e) => e.id));
    if (fresh.length) this.trillUntil = performance.now() + TRILL_MS;
    for (const id of fresh) this.fresh.add(id);
    this.seen = new Set([...(this.seen ?? []), ...all.map((e) => e.id)]);
    // A re-check whose answer is logged (even one that timed out on the
    // way): the answer is new, comes into view, and the old card links to it.
    for (const [id, p] of this.pending) {
      if (p.state === "sending") continue;
      const got = landed(p.question, p.since, all, p.qid);
      if (got && got !== id) {
        this.pending.delete(id);
        this.fresh.add(got);
        this.answered.set(id, got);
        this.scrollTo = got;
        this.settleUntil = performance.now() + SETTLE_MS;
        const q = all.find((x) => x.id === got)?.question.trim() ?? "";
        this.live.textContent = `New answer: ${q}`;
      } else if (p.state === "waiting" && Date.now() - p.since > PENDING_MS) {
        Object.assign(p, { state: "failed", err: "No new answer was logged in 30 minutes." });
      }
    }
  }

  /** Each answer's newer one: asked again with the same words, or the answer its re-check came back as. */
  private newer(): Map<string, string> {
    const m = newerAnswers(this.entries());
    for (const [old, got] of this.answered) if (!m.has(old)) m.set(old, got);
    return m;
  }

  /** Every entry read so far. */
  private entries(): Entry[] {
    return [...this.pages.values()].flatMap((p) => p.entries);
  }

  /** The pages the rail shows: the newest `span` days, or all of them while filtering. */
  private shownPages(): LogPage[] {
    if (this.query.trim()) return [...this.pages.values()];
    const want = new Set(daysToLoad(this.today, this.days, this.span));
    return [...this.pages.values()].filter((p) => want.has(p.day));
  }

  private setQuery(q: string): void {
    this.query = q;
    this.drawRail();
    // A filter reaches every logged day: read the ones not read yet.
    if (q.trim() && this.days.some((d) => !this.pages.has(d))) void this.readLog().then(() => this.drawRail());
  }

  private draw(s: Status | null = this.status): void {
    // The header: what it is doing and where it works.
    const root = s?.root ? tilde(s.root) : "";
    const off = !!s && (!s.tmux || !s.live);
    const said = !s ? "" : !s.tmux ? "can't run here" : this.ensuring ? "starting…" : s.live ? (s.state === "working" ? "working" : s.state === "needs_input" ? "needs you" : "idle") : "not running";
    for (const head of [this.tabHead, this.dropHead]) {
      head.querySelector(".bosun-root")!.textContent = root;
      const st = head.querySelector<HTMLElement>(".bosun-state")!;
      st.querySelector(".bosun-state-t")!.textContent = said;
      st.hidden = !said;
      st.dataset.state = s?.live ? s.state ?? "" : this.ensuring ? "starting" : "off";
    }
    const state = s?.live ? s.state ?? "" : "";
    if (state !== this.lastState) {
      this.lastState = state;
      this.stateSince = Date.now();
    }
    const m: Mood = mood(state, performance.now() < this.trillUntil);
    for (const w of this.whistles) {
      w.dataset.mood = m;
      w.classList.toggle("off", off && !this.ensuring);
    }
    if (m === "trill") window.setTimeout(() => this.draw(), TRILL_MS + 20);
    this.tabDot(state);

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
    this.drawReader();
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
        el("p", "", `It runs on the app's own tmux sessions, and this app is on ${s.backend || "another backend"}. ${this.dropOpen ? "Its past answers are on the Bosun tab (⌘4)." : "Its past answers still show on the left."}`),
      );
      const how = el("p", "bosun-note-how");
      how.append("To run it, start the app on the tmux backend: ", el("code", "", "SEAMUX_BACKEND=tmux"), ".");
      this.note.append(how);
      return;
    }
    if (this.ensuring) {
      this.note.append(el("p", "", "Starting the Bosun…"));
      return;
    }
    this.note.append(el("p", "bosun-note-t", this.ensureErr ? "The Bosun didn't start." : "The Bosun isn't running."));
    if (this.ensureErr) this.note.append(el("p", "bosun-err", this.ensureErr));
    const b = button("retry", this.ensureErr ? "Try again" : "Start the Bosun");
    b.addEventListener("click", () => {
      this.ensureErr = "";
      this.asked = true;
      this.tick();
    });
    this.note.append(b);
  }

  /** Whether Re-check can go out now, and if not, why. */
  private canAsk(): { ok: boolean; why: string } {
    if (!this.status) return { ok: false, why: "Looking for the Bosun…" };
    if (!this.status.tmux) return { ok: false, why: "Re-check needs the Bosun, which runs on the tmux backend" };
    if (this.ensureErr) return { ok: false, why: "Re-check is off: the Bosun didn't start. Use Try again, beside the answers" };
    return { ok: true, why: "Ask the Bosun the same question again; its new answer lands at the top" };
  }

  /** The rail, drawn again only when something it shows changed: a poll
   *  that read nothing new leaves focus, selection and scroll alone. */
  private drawRail(): void {
    const newer = this.newer();
    const { days, shown, total } = filterRail(rail(this.shownPages()), this.query);
    const key = JSON.stringify([
      days.map((d) => [d.day, d.label, d.cards.map((c) => c.id)]), this.query, this.reading?.id ?? "", [...this.fresh], [...this.pending],
      [...newer], this.status?.tmux ?? null, this.status?.live ?? null, this.status?.state ?? "", this.span, this.days.length, total, this.ensureErr,
    ]);
    this.foldDot.hidden = !this.fresh.size;
    // A card asked to come into view is taken up by this draw, drawn or not
    // (a filter may hide it): a later draw must not jump to it.
    const target = this.scrollTo;
    this.scrollTo = "";
    if (key === this.railKey && !target) return;
    this.railKey = key;

    // Keep keyboard focus on the same card's same control across the redraw.
    const a = document.activeElement as HTMLElement | null;
    const keep = a && this.railList.contains(a) ? { id: a.closest<HTMLElement>("[data-id]")?.dataset.id, act: a.dataset.act } : null;

    this.railList.replaceChildren();
    const q = this.query.trim();
    this.found.textContent = q ? (shown ? `${shown} of ${total} answers` : "") : "";
    this.found.hidden = !q || !shown;
    if (!total) {
      this.railList.append(this.empty());
      return;
    }
    if (q && !shown) {
      const p = el("div", "bosun-empty");
      p.append(el("p", "", `No answers match “${q}”.`));
      const clear = button("bosun-older", "Clear the filter");
      clear.addEventListener("click", () => {
        this.find.value = "";
        this.setQuery("");
        this.find.focus();
      });
      p.append(clear);
      this.railList.append(p);
      return;
    }
    // Re-check is off on every card for one reason: say it once, where it shows.
    const can = this.canAsk();
    if (this.status?.tmux && !can.ok) this.railList.append(el("p", "bosun-railnote", `${can.why}.`));
    for (const d of days) {
      if (!d.cards.length) continue;
      const g = el("section", "bosun-day");
      g.append(el("h3", "bosun-day-t", d.label));
      for (const c of d.cards) g.append(this.card(c, newer.get(c.id)));
      this.railList.append(g);
    }
    if (!q) {
      const older = olderDays(this.today, this.days, this.span);
      if (older) {
        const more = button("bosun-older", `Show older answers (${older} more day${older === 1 ? "" : "s"})`);
        more.dataset.act = "older";
        more.addEventListener("click", () => {
          this.span += MORE;
          // Keys stay on the rail: on the next Show older, or the first card it brought in.
          const before = new Set(this.entries().map((x) => x.id));
          void this.readLog().then(() => {
            this.drawRail();
            const next = this.railList.querySelector<HTMLElement>('[data-act="older"]');
            const added = [...this.railList.querySelectorAll<HTMLElement>(".bosun-card")].find((c) => !before.has(c.dataset.id ?? ""));
            (next ?? added?.querySelector<HTMLElement>(".bosun-card-main"))?.focus();
          });
        });
        this.railList.append(more);
      }
    }
    if (keep?.id) {
      const sel = `[data-id="${CSS.escape(keep.id)}"] [data-act="${CSS.escape(keep.act ?? "open")}"]`;
      this.railList.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true });
    } else if (keep?.act === "older") this.railList.querySelector<HTMLElement>('[data-act="older"]')?.focus({ preventScroll: true });
    if (target) this.railList.querySelector(`[data-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private empty(): HTMLElement {
    const p = el("div", "bosun-empty");
    if (this.status?.tmux === false) {
      p.append(el("p", "", "No answers here: the Bosun runs on tmux."));
      return p;
    }
    p.append(
      el("p", "bosun-empty-t", "No answers yet."),
      el("p", "", "Ask the Bosun in its terminal, or with Ask on a Radar row or a Lookout review. Each answer lands here, newest first, with the sources behind it."),
    );
    return p;
  }

  private chipRow(cs: Chip[]): HTMLElement {
    const row = el("span", "bosun-chips");
    for (const ch of cs) {
      const c = el("span", `bosun-chip k-${ch.label}`, ch.n > 1 ? `${ch.label} ${ch.n}` : ch.label);
      c.title = chipTitle(ch);
      // Its full name for a screen reader too, not only for a mouse.
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", chipTitle(ch));
      row.append(c);
    }
    return row;
  }

  private card(c: Card, newer?: string): HTMLElement {
    if (c.report) return this.reportCard(c, c.report);
    const reading = this.reading?.id === c.id;
    const fresh = this.fresh.has(c.id);
    const a = el("article", `bosun-card${reading ? " reading" : ""}${fresh ? " new" : ""}`);
    a.dataset.id = c.id;
    // The card's body opens it in the reading pane.
    const open = el("button", "bosun-card-main");
    open.type = "button";
    open.dataset.act = "open";
    open.setAttribute("aria-pressed", String(reading));
    open.title = reading ? "Close the reading pane" : "Read the answer and its sources";
    const top = el("span", "bosun-card-top");
    top.append(el("span", "bosun-time", c.time));
    if (c.from) top.append(el("span", "bosun-from", c.from));
    if (fresh) top.append(el("span", "bosun-new", "new"));
    const q = this.marked(el("span", "bosun-q"), c.question);
    q.title = c.question;
    open.append(top, q);
    open.append(c.first ? this.marked(el("span", "bosun-first"), c.first) : el("span", "bosun-first none", "The Bosun logged no answer text."));
    // While filtering, say where a card matched when what it shows doesn't.
    const why = this.query.trim() ? matchedWhere(c.entry, this.query) : "";
    if (why) open.append(this.marked(el("span", "bosun-why"), `Matched in ${why}`));
    a.append(open);

    const foot = el("div", "bosun-card-foot");
    foot.append(this.chipRow(c.chips));
    // Where the Bosun can never run, Re-check is left off the cards (the reading pane says why).
    if (this.status?.tmux !== false) foot.append(this.recheckButton(c.entry, "bosun-act"));
    a.append(foot);
    const line = this.pendingLine(c.entry);
    if (line) a.append(line);
    // A loop asks the same thing on purpose: its older runs don't each point at the newest.
    if (newer && !c.entry.asker.startsWith("loop:") && !c.entry.asker.startsWith("report:")) a.append(this.newerLink(newer));
    open.addEventListener("click", () => {
      if (this.settling()) return;
      if (reading) this.closeReader(false);
      else this.openReader(c.entry);
    });
    return a;
  }

  /** A report run's card (the person's pick, 2026-11-22): its title, time
   *  and doc link on top, one line per section with its dot, then Run again.
   *  The body opens the reading pane like any card. */
  private reportCard(c: Card, r: ReportRun): HTMLElement {
    const reading = this.reading?.id === c.id;
    const fresh = this.fresh.has(c.id);
    const n = needsCount(r);
    const a = el("article", `bosun-card report${n ? " needs" : ""}${reading ? " reading" : ""}${fresh ? " new" : ""}`);
    a.dataset.id = c.id;
    const open = el("button", "bosun-card-main");
    open.type = "button";
    open.dataset.act = "open";
    open.setAttribute("aria-pressed", String(reading));
    open.title = reading ? "Close the reading pane" : "Read the report and its sources";
    const top = el("span", "bosun-rep-head");
    top.append(icon("report", 12));
    top.append(this.marked(el("span", "bosun-rep-title"), r.title));
    top.append(el("span", "bosun-time", c.time));
    if (fresh) top.append(el("span", "bosun-new", "new"));
    open.append(top);
    const lines = el("span", "bosun-rep-lines");
    // A screen reader hears how the run went before its lines.
    const sum = [n ? `${n} need${n === 1 ? "s" : ""} you` : "", `${r.sections.length} section${r.sections.length === 1 ? "" : "s"}`].filter(Boolean).join(", ");
    lines.setAttribute("role", "group");
    lines.setAttribute("aria-label", sum);
    for (const s of r.sections) {
      const row = el("span", `bosun-rep-line s-${s.status}`);
      row.append(statusDot(s.status), this.marked(el("span", "bosun-rep-sec"), s.title), this.marked(el("span", "bosun-rep-text"), s.line));
      row.title = `${s.title}: ${statusLabel(s.status)}. ${s.line}`;
      lines.append(row);
    }
    open.append(lines);
    const why = this.query.trim() ? matchedWhere(c.entry, this.query) : "";
    if (why) open.append(this.marked(el("span", "bosun-why"), `Matched in ${why}`));
    a.append(open);
    // The doc link sits over the card's corner, outside the button (a link may not sit in one).
    if (r.doc) {
      const doc = el("a", "bosun-rep-doc");
      doc.href = r.doc;
      doc.title = `Open the ${r.title} doc`;
      doc.append(document.createTextNode("Doc"), icon("web", 10));
      doc.addEventListener("click", (ev) => {
        ev.preventDefault();
        void follow(r.doc!, null, ev);
      });
      a.append(doc);
    }
    // The foot only when it holds something: why there is no doc, or Run again.
    const docWhy = !r.doc && r.docWhy ? `No doc: ${r.docWhy}` : "";
    const canRun = this.status?.tmux !== false;
    if (docWhy || canRun) {
      const foot = el("div", "bosun-card-foot");
      const why = el("span", "bosun-rep-docwhy", docWhy);
      if (docWhy) why.title = docWhy;
      foot.append(why);
      if (canRun) foot.append(this.recheckButton(c.entry, "bosun-act", "Run again"));
      a.append(foot);
    } else open.classList.add("alone");
    const line = this.pendingLine(c.entry);
    if (line) a.append(line);
    open.addEventListener("click", () => {
      if (this.settling()) return;
      if (reading) this.closeReader(false);
      else this.openReader(c.entry);
    });
    return a;
  }

  /** Text with the filter's words marked. */
  private marked<T extends HTMLElement>(into: T, text: string): T {
    for (const h of hits(text, this.query.trim())) into.append(h.hit ? el("mark", "bosun-hit", h.s) : document.createTextNode(h.s));
    return into;
  }

  /** The rail just moved under the pointer (an answer landed): a click now was aimed at something else. */
  private settling(): boolean {
    return performance.now() < this.settleUntil;
  }

  private recheckButton(e: Entry, cls: string, label = "Re-check"): HTMLButtonElement {
    const p = this.pending.get(e.id);
    const busy = p?.state === "sending" || p?.state === "waiting";
    const can = this.canAsk();
    const b = button(cls, busy ? (label === "Re-check" ? "Re-checking" : "Running") : p?.state === "failed" ? "Retry" : label);
    b.dataset.act = "recheck";
    b.title = busy ? "Already asked again; the new answer lands at the top" : can.why;
    // aria-disabled, not disabled: the button keeps focus across a redraw, and its reason stays reachable.
    const off = busy || !can.ok;
    b.setAttribute("aria-disabled", String(off));
    b.addEventListener("click", () => {
      if (!off && !this.settling()) void this.recheck(e);
    });
    return b;
  }

  /** A re-check's line on its card: on its way, waiting (and why), or stopped (and why, with a dismiss). */
  private pendingLine(e: Entry): HTMLElement | null {
    const p = this.pending.get(e.id);
    if (!p) return null;
    const line = el("div", `bosun-pending s-${p.state}`);
    line.setAttribute("role", "status");
    const text = el("span", "bosun-pending-t");
    if (p.state === "failed") text.textContent = p.err ?? "Couldn't re-check.";
    else {
      line.append(el("span", "bosun-spin"));
      text.textContent = p.state === "sending" ? "Sending to the Bosun…" : pendingNote(!!this.status?.live, this.status?.state, !!e.report);
    }
    line.append(text);
    // Waiting on the person's answer while the reading pane covers the prompt: a way to it.
    if (p.state === "waiting" && this.status?.state === "needs_input" && this.reading) {
      const go = button("bosun-inline", "Show the prompt");
      go.addEventListener("click", () => this.closeReader(true));
      line.append(go);
    }
    if (p.state === "failed") {
      const x = button("bosun-inline x", "", "Dismiss");
      x.append(icon("x", 10));
      x.addEventListener("click", () => {
        this.pending.delete(e.id);
        this.redraw();
      });
      line.append(x);
    }
    return line;
  }

  private newerLink(id: string): HTMLElement {
    const b = button("bosun-newer", "", "Show the newer answer to this question");
    b.dataset.act = "newer";
    const n = this.entries().find((x) => x.id === id);
    b.append(icon("up", 10), document.createTextNode(n ? `Newer answer · ${ago(n.at, Date.now())}` : "Newer answer"));
    b.addEventListener("click", () => {
      const e = this.entries().find((x) => x.id === id);
      if (!e) return;
      this.scrollTo = id;
      this.openReader(e);
    });
    return b;
  }

  private async recheck(e: Entry): Promise<void> {
    if (!this.canAsk().ok) return;
    // Its answer is logged after this moment; a little slack for the two clocks.
    const mine: Pending = { state: "sending", since: Date.now() - 5000, question: e.question };
    this.pending.set(e.id, mine);
    this.redraw();
    let slow = 0;
    // A report run asks for its report again, through the supervisor's source check.
    const again = askAgain(e);
    const send = invoke<string>(again.cmd, again.args);
    const refused = (err: unknown) => {
      const said = String(err).replace(/\.$/, "");
      // The Bosun's pane is the one thing a person can do something about: say it in their words.
      const why = /\bpane\b/i.test(said) ? "Couldn't send it: the Bosun stopped. Start it again beside the answers, then Retry." : `Couldn't send it: ${said}.`;
      Object.assign(mine, { state: "failed", err: why });
      this.live.textContent = why;
      console.error("bosun re-check", err);
    };
    try {
      const qid = await Promise.race([send, new Promise<never>((_, no) => (slow = window.setTimeout(() => no("timeout"), SEND_MS)))]);
      Object.assign(mine, { state: "waiting", qid });
      this.live.textContent = "Re-check queued.";
    } catch (err) {
      if (err === "timeout") {
        // The queue was slow to say so, but the question may well be in it:
        // keep waiting (found by its words) rather than offer a Retry that asks twice.
        mine.state = "waiting";
        this.live.textContent = "Re-check sent; the queue was slow to confirm it.";
        // The send still answers later: its queue id, or the refusal it was.
        send.then(
          (qid) => {
            if (this.pending.get(e.id) === mine && mine.state === "waiting") mine.qid = qid;
          },
          (late) => {
            if (this.pending.get(e.id) !== mine || mine.state !== "waiting") return;
            refused(late);
            this.redraw();
          },
        );
      } else refused(err);
    } finally {
      window.clearTimeout(slow);
    }
    // Only if this is still the re-check on that card (a dismiss or a retry may have replaced it).
    if (this.pending.get(e.id) === mine) this.redraw();
  }

  private redraw(): void {
    this.drawRail();
    this.drawReader();
  }

  // ---- the reading pane ----

  private openReader(e: Entry): void {
    this.reading = e;
    this.fresh.delete(e.id);
    this.redraw();
    this.reader.querySelector<HTMLElement>(".bosun-reader-body")?.focus({ preventScroll: true });
  }

  /** Back to the terminal; `focus` puts the keys there too (Esc, the Terminal button). */
  private closeReader(focus: boolean): void {
    if (!this.reading) return;
    this.reading = null;
    this.redraw();
    if (focus) this.term.focus();
  }

  /** The reading pane, drawn again only when what it shows changed (so a poll leaves a selection alone). */
  private drawReader(): void {
    const e = this.reading;
    const newer = e ? this.newer().get(e.id) : undefined;
    const key = JSON.stringify([
      e?.id ?? "", e?.answer.length ?? 0, e ? this.pending.get(e.id) ?? null : null, newer ?? "",
      this.status?.tmux ?? null, this.status?.live ?? null, this.status?.state ?? "", this.ensureErr,
    ]);
    if (key === this.readerKey) return;
    this.readerKey = key;
    this.tabHost.classList.toggle("reading", !!e);
    this.reader.hidden = !e;
    if (!e) {
      this.reader.replaceChildren();
      return;
    }
    const scroll = this.reader.querySelector(".bosun-reader-body")?.scrollTop ?? 0;
    const same = this.reader.dataset.id === e.id;
    this.reader.dataset.id = e.id;

    const bar = el("div", "bosun-reader-bar");
    const back = button("bosun-back", "", "Back to the terminal (Esc)");
    back.append(icon("left"), document.createTextNode("Terminal"), el("kbd", "", "Esc"));
    back.addEventListener("click", () => this.closeReader(true));
    bar.append(back, el("span", "bosun-bar-gap"));
    // Nothing to copy, nothing offered.
    if (e.answer.trim()) {
      const copy = button("bosun-tool", "", "Copy the answer as text");
      copy.append(icon("copy"), el("span", "bosun-tool-t", "Copy"));
      copy.addEventListener("click", () => void this.copy(copy, e.answer));
      bar.append(copy);
    }
    // Where the Bosun can never run, no Re-check (as on the cards). Once a
    // newer answer exists, reading that comes first: Re-check steps down.
    if (this.status?.tmux !== false) bar.append(this.recheckButton(e, newer ? "bosun-tool" : "bosun-tool primary", e.report ? "Run again" : "Re-check"));

    const body = el("div", "bosun-reader-body");
    body.tabIndex = -1;
    const col = el("article", "bosun-reader-col");
    const page = [...this.pages.values()].find((p) => p.entries.some((x) => x.id === e.id));
    const c = toCard(e);
    const meta = el("p", "bosun-reader-meta");
    meta.append([page ? dayLabel(page.day, page.today) : "", c.time].filter(Boolean).join(" "));
    // Past a day, the age says the answer may be out of date.
    const old = Date.now() - e.at > 86400e3;
    meta.append(el("span", `bosun-age${old ? " old" : ""}`, ` (${ago(e.at, Date.now())}${old ? ", may be out of date" : ""})`));
    if (c.report) meta.append(" · a scheduled report");
    else if (c.from) meta.append(` · asked by ${c.from}`);
    col.append(meta, el("h2", "bosun-reader-q", e.question.trim()));
    const line = this.pendingLine(e);
    if (line) col.append(line);
    const can = this.canAsk();
    if (!can.ok && this.status) {
      const off = el("p", "bosun-pending s-off", `${can.why}.`);
      // Try again sits beside the terminal, under this pane: a way to it.
      if (this.ensureErr) {
        const go = button("bosun-inline", "Show Try again");
        go.addEventListener("click", () => this.closeReader(false));
        off.append(go);
      }
      col.append(off);
    }
    if (newer) col.append(this.newerLink(newer));
    const r = c.report;
    if (r) {
      col.append(this.reportSections(r));
      // Only what the answer says beyond the section lines above.
      const extra = reportExtra(e, r);
      if (extra) col.append(this.answerText(extra));
    } else col.append(this.answerText(e.answer));

    const src = el("section", "bosun-reader-src");
    const n = e.sources.length;
    src.append(el("h3", "bosun-reader-h", n ? `Sources (${n})` : "Sources"));
    if (!n) src.append(el("p", "bosun-quiet", "The Bosun logged no sources for this answer."));
    else {
      const ul = el("ul", "bosun-sources");
      for (const s of e.sources) ul.append(this.sourceItem(s));
      src.append(ul);
    }
    col.append(src);
    body.append(col);
    this.reader.replaceChildren(bar, body);
    if (same) body.scrollTop = scroll;
  }

  /** A report run's sections in the reading pane: each with its dot, status
   *  and line, and why one was not checked; then its doc, or why it has none. */
  private reportSections(r: ReportRun): HTMLElement {
    const box = el("section", "bosun-rep-full");
    const ul = el("ul", "bosun-rep-list");
    const folds: HTMLDetailsElement[] = [];
    for (const s of r.sections) {
      const li = el("li", `bosun-rep-item s-${s.status}`);
      const head = el("p", "bosun-rep-item-h");
      head.append(statusDot(s.status), el("strong", "", s.title), el("span", "bosun-rep-st", statusLabel(s.status)));
      const line = this.spans(el("p", "bosun-rep-item-t"), mdInline(s.line));
      // Why it was not checked, when the line does not already say it.
      const why = s.why && !s.line.includes(s.why) ? el("p", "bosun-rep-item-why", `Why: ${s.why}`) : null;
      if (!s.detail) {
        li.append(head, line);
        if (why) li.append(why);
        ul.append(li);
        continue;
      }
      // A section with more to say opens in place; which ones are open is
      // kept per run, so a poll's redraw leaves them as they were.
      const key = `${r.run}\n${s.title}`;
      const fold = document.createElement("details");
      // When the detail opens with the line itself (the whole of a line cut
      // to fit, say), the open section shows it once, in full.
      fold.className = `bosun-rep-fold${detailRepeatsLine(s.line, s.detail) ? " repeats" : ""}`;
      fold.open = this.openSections.has(key);
      const sum = document.createElement("summary");
      // The why stays in sight with the line, open or closed.
      sum.append(head, line);
      if (why) sum.append(why);
      fold.append(sum);
      fold.append(this.mdInto(el("div", "bosun-md bosun-rep-detail"), s.detail));
      fold.addEventListener("toggle", () => {
        if (fold.open) this.openSections.add(key);
        else this.openSections.delete(key);
        sync();
      });
      folds.push(fold);
      li.classList.add("has-detail");
      li.append(fold);
      ul.append(li);
    }
    // Open or close every section with more to say at once.
    const all = button("bosun-inline", "");
    const sync = () => {
      all.textContent = folds.every((f) => f.open) ? "Collapse all" : "Expand all";
    };
    all.addEventListener("click", () => {
      const open = !folds.every((f) => f.open);
      for (const f of folds) f.open = open;
    });
    if (folds.length) {
      sync();
      const bar = el("p", "bosun-rep-tools");
      bar.append(all);
      box.append(bar);
    }
    box.append(ul);
    if (r.doc) {
      const p = el("p", "bosun-rep-docline");
      const a = el("a", "bosun-link", `Open the ${r.title} doc`);
      a.href = r.doc;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        void follow(r.doc!, null, ev);
      });
      p.append(a);
      box.append(p);
    } else if (r.docWhy) box.append(el("p", "bosun-quiet", `The doc was not updated: ${r.docWhy}.`));
    return box;
  }

  private answerText(text: string): HTMLElement {
    const box = el("div", "bosun-md");
    if (!text.trim()) {
      box.append(el("p", "bosun-quiet", "The Bosun logged no answer text."));
      return box;
    }
    return this.mdInto(box, text);
  }

  /** Inline spans as elements (never HTML): links open through `follow`. */
  private spans<T extends HTMLElement>(into: T, ss: Span[]): T {
    for (const s of ss) {
      if (s.t === "text") into.append(s.s);
      else if (s.t === "code") into.append(el("code", "", s.s));
      else if (s.t === "b") into.append(el("strong", "", s.s));
      else if (s.t === "i") into.append(el("em", "", s.s));
      else {
        const href = s.t === "link" ? s.href : s.s;
        const a = el("a", "bosun-link", s.s);
        a.href = href;
        a.title = href;
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          void follow(href, null, ev);
        });
        into.append(a);
      }
    }
    return into;
  }

  /** Markdown drawn into `box` as plain elements: headings, paragraphs,
   *  lists, fenced code, and tables (in a box that scrolls sideways). */
  private mdInto<T extends HTMLElement>(box: T, text: string): T {
    for (const b of mdBlocks(text)) {
      if (b.t === "h") box.append(this.spans(el(b.level <= 2 ? "h3" : "h4", "bosun-md-h"), b.spans));
      else if (b.t === "p") box.append(this.spans(el("p"), b.spans));
      else if (b.t === "pre") box.append(el("pre", "", b.s));
      else if (b.t === "table") {
        const wrap = el("div", "bosun-md-table");
        const table = el("table");
        const tr = el("tr");
        for (const c of b.head) tr.append(this.spans(el("th"), c));
        table.append(el("thead"), el("tbody"));
        table.tHead!.append(tr);
        for (const row of b.rows) {
          const r = el("tr");
          for (const c of row) r.append(this.spans(el("td"), c));
          table.tBodies[0].append(r);
        }
        wrap.append(table);
        box.append(wrap);
      } else {
        const list = el(b.t);
        for (const it of b.items) list.append(this.spans(el("li"), it));
        box.append(list);
      }
    }
    return box;
  }

  private sourceItem(s: Entry["sources"][number]): HTMLElement {
    const li = el("li", "bosun-src-row");
    const { label, name } = kindLabel(s.kind);
    const k = el("span", `bosun-chip k-${label}`, label);
    k.title = name;
    li.append(k);
    const root = this.status?.root ?? "";
    const row = sourceRow(s, root);
    const t = sourceTarget(s, root);
    if (t) {
      const link = el("a", "bosun-src");
      link.href = "url" in t ? t.url : "#";
      link.title = "url" in t ? `Open ${t.url}` : `Open ${tilde(t.path)}${t.line ? `:${t.line}` : ""} (⇧-click: in the editor)`;
      link.append(el("span", "bosun-src-name", row.name), icon(row.to === "web" ? "web" : "file", 11));
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        if ("url" in t) void follow(t.url, null, ev);
        else void openFile(t.path, { line: t.line }, null, ev);
      });
      li.append(link);
      if (row.where) li.append(el("span", "bosun-src-where", row.where));
    } else {
      // A ticket key, a query, a workspace: shown whole, with a copy.
      const box = el("div", "bosun-src-ref");
      if (s.label && s.label !== s.ref) box.append(el("span", "bosun-src-name", s.label));
      // The copy sits right after what it copies.
      const val = el("span", "bosun-src-val");
      const short = s.ref.length > 24 ? `${s.ref.slice(0, 23)}…` : s.ref;
      const cp = button("bosun-tool small", "", `Copy “${short}”`);
      cp.append(icon("copy"), el("span", "bosun-tool-t", "Copy"));
      cp.addEventListener("click", () => void this.copy(cp, s.ref));
      val.append(el("code", "", s.ref), cp);
      box.append(val);
      li.append(box);
    }
    return li;
  }

  /** Copy, and say so on the button itself for a moment: a check and "Copied", or "Couldn't copy". */
  private async copy(b: HTMLButtonElement, text: string): Promise<void> {
    // The button's resting look is taken once: a second click while it
    // says "Copied" must not keep "Copied" as the look to go back to.
    const rest = this.copyRest.get(b) ?? { was: [...b.childNodes], timer: 0 };
    this.copyRest.set(b, rest);
    window.clearTimeout(rest.timer);
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false;
    }
    b.classList.toggle("done", ok);
    b.classList.toggle("bad", !ok);
    b.replaceChildren(icon(ok ? "check" : "x"), el("span", "bosun-tool-t", ok ? "Copied" : "Couldn't copy"));
    this.live.textContent = ok ? "Copied." : "Couldn't copy.";
    rest.timer = window.setTimeout(() => {
      b.classList.remove("done", "bad");
      b.replaceChildren(...rest.was);
      this.copyRest.delete(b);
      this.live.textContent = "";
    }, 1400);
  }

  /** ↑/↓ move between cards, Enter opens one (the buttons' own). */
  private railKeys(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [...this.railList.querySelectorAll<HTMLElement>(".bosun-card-main")];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0) return this.find.focus();
    all[Math.max(0, Math.min(all.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  /** An Ask was queued (bosun_ask.ts): drop the Bosun down to watch it answer, or read now on its tab. */
  afterAsk(): void {
    this.asked = true;
    // Its answer may land after the drop-down is put away: read for it from any tab for a while.
    this.watchUntil = performance.now() + PENDING_MS;
    if (!this.tabShown) this.setDrop(true);
    else {
      this.closeReader(false);
      this.tick();
    }
  }

  /** A Bosun banner's click (main.ts, notify:bosun): its report card, open
   *  in the reading pane. Today's log is read again first, since the run
   *  may have landed after the last poll. */
  async openEntry(id: string): Promise<void> {
    if (!this.entries().some((e) => e.id === id)) await this.readLog();
    // A run from a day the rail has not read (its banner sat a while):
    // read the logged days, newest first, until it turns up.
    for (const day of this.days) {
      if (this.entries().some((e) => e.id === id)) break;
      if (this.pages.has(day)) continue;
      const p = await invoke<LogPage>("bosun_log", { day }).catch(() => null);
      if (p) this.pages.set(p.day, p);
    }
    const e = this.entries().find((x) => x.id === id);
    if (!e) return;
    // Its day shows in the rail, so the card it opens is there too.
    const page = [...this.pages.values()].find((p) => p.entries.some((x) => x.id === id));
    if (page && !this.shownPages().includes(page)) this.span = Math.max(this.span, daysToLoad(this.today, this.days, 400).indexOf(page.day) + 1);
    this.scrollTo = id;
    this.openReader(e);
  }

  /** Keyboard focus in the view's main area, its terminal (main.ts, on picking the tab). */
  focusMain(): void {
    window.setTimeout(() => (this.reading ? this.reader.querySelector<HTMLElement>(".bosun-reader-body")?.focus() : this.term.focus()), 60);
  }
}
