// The launch banner at the top of the Dock: sessions on the other backend
// that can move onto this app's, and tmux panes that stopped with their
// server and can restart (crates/seamux-app/src/migrate_app.rs).
//
// It never blocks the app, and it is one line in the rail whatever it says:
// what waits, the one-click "all" button, Review and Later. Review opens the
// list in a popover anchored under the banner, floating over the rail and
// the terminal, so the board under the banner never moves. In the list a
// row is its own button (click, or Enter): it restarts, moves or brings back
// that one; a busy one (working, or waiting on you) is asked to move once
// idle instead, and the banner moves it when it gets there. × forgets a row.
// Later hides the banner until the next launch, and it hides itself once
// nothing is left to move (after a line on how it went). When all that is
// left failed, the line says so with Try again and Dismiss, and the list
// names each failure on its own row with its own Try again: a failed
// restart stays on offer (the registry keeps its gone pane), so trying again
// is the same apply.
import { invoke } from "@tauri-apps/api/core";

type Kind = "adopt" | "resume" | "restart" | "revive";
type Offer = { kind: Kind; pane: string; ws: string; title: string; cwd: string; claude: string; state: string; busy: boolean };

/** How often a queued busy session is looked at again. */
const POLL_MS = 3000;
/** How long the last result stays once nothing is left, before the banner goes. */
const DONE_MS = 4000;
/** A list row's height (migrate.css .migrate-row): the list is cut on whole rows. */
const ROW_H = 30;
/** The most rows the list shows before it scrolls. */
const MAX_ROWS = 6;
/** The "+N more" line's height (newws.css .migrate-more), kept out of the list's room. */
const MORE_H = 18;

const STATE: Record<string, string> = {
  working: "working",
  needs_input: "needs you",
  idle: "idle",
  ended: "ended",
  "": "stopped",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** A circular arrow: these sessions can come back. */
function mark(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("class", "migrate-mark");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.6");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  s.append(p);
  return s;
}

function button(text: string, cls = ""): HTMLButtonElement {
  const b = el("button", `sheet-btn${cls ? " " + cls : ""}`, text);
  b.type = "button";
  return b;
}

const key = (o: Offer) => `${o.kind}:${o.pane.toUpperCase()}`;
const nameOf = (o: Offer) => o.title || o.cwd.split("/").pop() || o.pane.slice(0, 8);

/** What waits, by kind. `short` is the banner's own line, where the rail is
 *  narrow ("8 sessions stopped"); the long form ("... with tmux") is its
 *  tooltip and the popover's heading. */
export function summary(offers: Offer[], short = false): string {
  const n = (k: Kind) => offers.filter((o) => o.kind === k).length;
  const s = (c: number, one: string, many: string) => (c === 1 ? one : many.replace("#", String(c)));
  const parts: string[] = [];
  if (n("adopt")) parts.push(s(n("adopt"), "1 cmux session can move here", "# cmux sessions can move here"));
  if (n("resume")) parts.push(s(n("resume"), "1 session can move to cmux", "# sessions can move to cmux"));
  if (n("restart")) parts.push(short ? s(n("restart"), "1 session stopped", "# sessions stopped") : s(n("restart"), "1 session stopped with tmux", "# sessions stopped with tmux"));
  if (n("revive")) parts.push(s(n("revive"), "1 cmux workspace can come back here", "# cmux workspaces can come back here"));
  return parts.join(" · ");
}

function verb(o: Offer): string {
  return o.kind === "restart" ? "Restart" : o.kind === "revive" ? "Bring back" : "Move";
}

export class MigrateBanner {
  readonly el = el("section", "migrate");
  private line = el("span", "migrate-line");
  /** The list, floating: on the body, so opening it moves nothing in the rail. */
  private pop = el("div", "migrate-pop");
  private popHead = el("p", "migrate-pop-head");
  private list = el("div", "migrate-list");
  private say = el("p", "migrate-say");
  /** Under the list while rows wait below it: how many. */
  private more = el("p", "migrate-more");
  private offers: Offer[] = [];
  /** Hidden from this launch's list: declined with ×. */
  private skipped = new Set<string>();
  /** Busy ones asked to move once idle. */
  private queued = new Set<string>();
  /** Moving now: its row stays disabled. */
  private running = new Set<string>();
  private open = false;
  /** The line's words, long and short (say). */
  private words: [string, string] = ["", ""];
  private timer = 0;
  private doneTimer = 0;
  /** How many moved this launch, by what was done to them, for the closing line. */
  private moved = new Map<string, number>();
  /** What failed this run, by session, kept so a later success cannot hide
   *  it; a retry replaces its entry, and a retry that works clears it. */
  private failed = new Map<string, string>();
  /** The offers that failed, kept to try them again. */
  private failedOffers = new Map<string, Offer>();
  /** Later was pressed: the banner stays away until the next launch. */
  private closed = false;
  private review = button("Review", "migrate-review");
  private later = button("Later", "migrate-later");
  /** Failed: the failed ones again. */
  private retry = button("Try again", "migrate-retry");
  /** The banner line's one-click button: every idle one at once. */
  private all = button("", "migrate-all");

  constructor() {
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Sessions that can move");
    this.all.addEventListener("click", () => {
      for (const o of this.idle()) void this.apply(o);
    });
    const review = this.review;
    review.setAttribute("aria-expanded", "false");
    review.setAttribute("aria-haspopup", "dialog");
    review.addEventListener("click", () => this.toggle(!this.open));
    this.retry.addEventListener("click", () => {
      for (const o of this.retryable()) void this.apply(o);
    });
    this.later.addEventListener("click", () => this.close());
    const acts = el("div", "migrate-acts");
    acts.append(this.all, this.retry, review, this.later);
    this.el.append(mark(), this.line, acts);

    this.pop.hidden = true;
    this.pop.setAttribute("role", "dialog");
    this.pop.setAttribute("aria-label", "Sessions to restart");
    this.say.hidden = true;
    this.more.hidden = true;
    this.more.setAttribute("aria-hidden", "true");
    this.list.setAttribute("role", "list");
    this.list.addEventListener("scroll", () => this.fade());
    this.pop.append(this.popHead, this.list, this.more, this.say);
    this.pop.addEventListener("keydown", (e) => this.key(e));
    document.body.append(this.pop);
    // Esc anywhere, and a click outside, close the list. A click in the
    // board's frame never reaches this document; the window's blur says it.
    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.open || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        this.toggle(false, true);
      },
      true,
    );
    document.addEventListener(
      "mousedown",
      (e) => {
        const t = e.target as Node;
        if (this.open && !this.pop.contains(t) && !this.review.contains(t)) this.toggle(false);
      },
      true,
    );
    window.addEventListener("blur", () => this.open && this.toggle(false));
    // The rail is resized by its grip, not the window: follow the banner.
    new ResizeObserver(() => {
      this.fit();
      if (this.open) this.place();
    }).observe(this.el);
    window.addEventListener("resize", () => this.open && this.place());
  }

  /** Ask once at launch; nothing shows when nothing waits. */
  async start(): Promise<void> {
    await this.refresh();
  }

  private toggle(open: boolean, refocus = false): void {
    this.open = open;
    this.review.setAttribute("aria-expanded", String(open));
    this.review.classList.toggle("on", open);
    this.draw();
    if (open) this.list.querySelector<HTMLElement>(".migrate-go:not([aria-disabled='true'])")?.focus();
    else if (refocus) this.review.focus();
  }

  private async refresh(): Promise<void> {
    try {
      this.offers = (await invoke<Offer[] | null>("migrate_offers")) ?? [];
    } catch (e) {
      this.offers = [];
      console.error("migrate", e);
    }
    this.draw();
    // Queued busy ones that went idle: move them now.
    for (const o of this.offers) if (this.queued.has(key(o)) && !o.busy) void this.apply(o);
    window.clearTimeout(this.timer);
    if (this.queued.size) this.timer = window.setTimeout(() => void this.refresh(), POLL_MS);
  }

  private shown(): Offer[] {
    return this.offers.filter((o) => !this.skipped.has(key(o)));
  }

  private idle(): Offer[] {
    return this.shown().filter((o) => !o.busy && !this.running.has(key(o)) && !this.failed.has(key(o)));
  }

  /** The failed ones that can be tried again: the fresh offer when it is
   *  still listed, else the one kept from the failure. */
  private retryable(): Offer[] {
    return [...this.failedOffers].filter(([k]) => !this.skipped.has(k) && !this.running.has(k)).map(([k, o]) => this.offers.find((x) => key(x) === k) ?? o);
  }

  /** The list's rows: every offer still shown, and any failure the backend
   *  no longer lists (kept to try again). */
  private rows(): Offer[] {
    const offers = this.shown();
    const listed = new Set(offers.map(key));
    const gone = [...this.failedOffers].filter(([k]) => !listed.has(k) && !this.skipped.has(k)).map(([, o]) => o);
    return [...offers, ...gone];
  }

  private close(): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.doneTimer);
    this.queued.clear();
    this.closed = true;
    this.el.hidden = true;
    this.shut();
  }

  /** The list goes, without a redraw. */
  private shut(): void {
    if (!this.open && this.pop.hidden) return;
    this.open = false;
    this.pop.hidden = true;
    this.review.setAttribute("aria-expanded", "false");
    this.review.classList.remove("on");
  }

  /** A run is over (the banner went): its tally starts again. */
  private reset(): void {
    this.moved.clear();
    this.failed.clear();
    this.failedOffers.clear();
    this.say.textContent = "";
    this.say.hidden = true;
    this.el.classList.remove("done", "failed");
  }

  /** The line's words, or `short` when the rail is too narrow for them: the
   *  line is one line at any width. The long words stay in its tooltip. */
  private setLine(text: string, short: string): void {
    this.words = [text, short];
    this.fit();
  }

  private fit(): void {
    const [text, short] = this.words;
    if (!text) return;
    this.line.textContent = text;
    if (this.line.scrollWidth > this.line.clientWidth) this.line.textContent = short;
  }

  /** Which buttons the line shows; the rest are hidden. */
  private acts(...on: HTMLButtonElement[]): void {
    for (const b of [this.all, this.retry, this.review, this.later]) b.hidden = !on.includes(b);
    this.fit();
  }

  private draw(): void {
    const offers = this.shown();
    window.clearTimeout(this.doneTimer);
    // Later means later, even for moves still finishing in the background.
    if (this.closed) {
      this.el.hidden = true;
      this.shut();
      return;
    }
    // Nothing left but what failed (and nothing still running): say so,
    // with Try again and Dismiss; Review lists each failure.
    const left = offers.filter((o) => !this.failed.has(key(o)));
    if (!left.length && this.failed.size && !this.running.size) {
      this.el.hidden = false;
      this.el.classList.remove("done");
      this.el.classList.add("failed");
      this.setLine(this.failed.size === 1 ? "1 did not come back" : `${this.failed.size} did not come back`, `${this.failed.size} failed`);
      this.line.title = [...this.failed.values()].join("\n");
      this.later.textContent = "Dismiss";
      this.later.title = "Hide this until the app starts again";
      const retry = this.retryable().length;
      this.retry.textContent = retry > 1 ? "Try all again" : "Try again";
      this.acts(...(retry ? [this.retry] : []), this.review, this.later);
      this.drawList();
      return;
    }
    this.later.textContent = "Later";
    this.later.title = "Hide until the app starts again";
    if (!offers.length && this.running.size) {
      // Trying again one the backend no longer lists: wait for its answer.
      this.setLine("Trying again…", "Trying again…");
      this.line.title = "";
      this.acts(this.review);
      this.drawList();
      return;
    }
    if (!offers.length) {
      // Nothing left: a clean run shows briefly, then the banner goes. With
      // nothing said, it goes at once.
      // Done means something moved this run (the tally), not that a message
      // is left over: dismissing every offer with × moves nothing and hides.
      this.shut();
      if (!this.moved.size || this.el.hidden) {
        this.reset();
        this.el.hidden = true;
        return;
      }
      this.el.classList.remove("failed");
      this.el.classList.add("done");
      // One line for the whole run: "8 restarted".
      const run = [...this.moved].map(([v, n]) => `${n} ${v}`).join(" · ");
      this.setLine(run, run);
      this.line.title = "";
      this.acts();
      this.doneTimer = window.setTimeout(() => {
        this.reset();
        this.el.hidden = true;
      }, DONE_MS);
      return;
    }
    this.el.hidden = false;
    this.el.classList.remove("done", "failed");
    this.setLine(summary(offers, true), offers.length === offers.filter((o) => o.kind === "restart").length ? `${offers.length} stopped` : `${offers.length} waiting`);
    this.line.title = summary(offers);
    const idle = this.idle();
    this.acts(...(idle.length ? [this.all] : []), this.review, this.later);
    if (idle.length) {
      const same = idle.every((o) => verb(o) === verb(idle[0]));
      const v = same ? verb(idle[0]) : "Do";
      this.all.textContent = idle.length === 1 ? v : same ? `${v} all` : "Do all";
      this.all.title = idle.length === offers.length ? `${v} all ${idle.length}` : `${v} the ${idle.length} idle: ${offers.length - idle.length} busy or failed wait in Review`;
    }
    this.fit();
    this.drawList();
  }

  /** The popover's rows, drawn again in place; the focus stays on its row. */
  private drawList(): void {
    if (!this.open || this.el.hidden) {
      this.pop.hidden = true;
      return;
    }
    const had = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(".migrate-row")?.dataset.key;
    const rows = this.rows();
    const fails = rows.filter((o) => this.failed.has(key(o))).length;
    this.popHead.textContent = fails && fails === rows.length ? (fails === 1 ? "1 did not come back" : `${fails} did not come back`) : summary(rows.filter((o) => !this.failed.has(key(o)))) + (fails ? ` · ${fails} did not come back` : "");
    // A row's state shows only where they differ (a busy one among idle
    // ones): ten rows of "idle" say nothing.
    const said = rows.map((o) => STATE[o.state] ?? o.state);
    const alike = said.every((t) => t === said[0]);
    this.list.replaceChildren(...rows.map((o, i) => this.row(o, !alike || o.busy ? said[i] : "")));
    this.pop.hidden = false;
    this.place();
    if (had) {
      const again = this.list.querySelector<HTMLElement>(`.migrate-row[data-key="${CSS.escape(had)}"] .migrate-go`) ?? this.list.querySelector<HTMLElement>(".migrate-go");
      again?.focus({ preventScroll: true });
    }
  }

  /** Beside the rail, level with the banner, over the terminal: the rail
   *  stays in view, so the card that needs you is never covered. Where the
   *  window is too narrow for that, under the banner instead. The list is
   *  cut on whole rows to fit the window. */
  private place(): void {
    const r = this.el.getBoundingClientRect();
    const board = this.el.closest(".dock-board");
    const rail = board ? board.getBoundingClientRect() : null;
    // Wide enough for a failure's reason beside its name.
    const want = this.failed.size ? 560 : 420;
    // Beside only a rail that is there and measured; else under the banner.
    const beside = !!rail && rail.width > 0 && window.innerWidth - rail.right - 16 >= Math.min(want, 360);
    const left = beside && rail ? rail.right + 8 : r.left;
    const top = beside ? r.top : r.bottom + 4;
    const w = Math.min(beside ? want : Math.max(r.width, want), window.innerWidth - left - 8);
    this.pop.style.left = `${Math.round(left)}px`;
    this.pop.style.top = `${Math.round(top)}px`;
    this.pop.style.width = `${Math.round(w)}px`;
    const room = window.innerHeight - top - 16 - this.popHead.offsetHeight - (this.say.hidden ? 0 : this.say.offsetHeight) - 16;
    // A list that cannot show every row gives up the "+N more" line's room.
    const n = this.list.children.length;
    const cut = n > Math.min(MAX_ROWS, Math.floor(room / ROW_H));
    const fit = Math.max(2, Math.min(MAX_ROWS, Math.floor((room - (cut ? MORE_H + 4 : 0)) / ROW_H)));
    this.list.style.maxHeight = `${fit * ROW_H}px`;
    this.fade();
  }

  /** The list's foot fades while more rows wait below it, and a muted line
   *  under it counts them; at the bottom both go. */
  private fade(): void {
    const l = this.list;
    const foot = l.scrollTop + l.clientHeight;
    const below = [...l.children].filter((c) => (c as HTMLElement).offsetTop - l.offsetTop + ROW_H / 2 > foot).length;
    l.classList.toggle("more", below > 0);
    this.more.hidden = below === 0;
    this.more.textContent = below ? `+${below} more` : "";
  }

  /** ↑ and ↓ walk the rows; Enter and Space act on the one in focus. */
  private key(e: KeyboardEvent): void {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".migrate-go");
    if (!row || e.target !== row) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...this.list.querySelectorAll<HTMLElement>(".migrate-go")];
      const at = all.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1);
      all[Math.max(0, Math.min(all.length - 1, at))]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
    }
  }

  private row(o: Offer, said: string): HTMLElement {
    const k = key(o);
    const bad = this.failed.get(k);
    // A list item holding two controls side by side: the row's action (the
    // name, its state and a quiet hint, all one target) and the ×. Never a
    // button inside a button.
    const row = el("div", `migrate-row${bad ? " bad" : ""}`);
    row.dataset.key = k;
    row.setAttribute("role", "listitem");
    const r = el("div", "migrate-go");
    r.setAttribute("role", "button");
    r.tabIndex = 0;
    row.append(r);
    const name = el("b", "", nameOf(o));
    name.title = o.cwd;
    r.append(name);
    // What the row does, said quietly at its right edge: on hover or focus
    // for a ready one, always for a failure or a wait.
    let hint = verb(o).toLowerCase();
    let act: (() => void) | null = () => void this.apply(o);
    let always = false;
    if (bad) {
      // One failure a line: its reason, cut to the row (whole in the tooltip).
      const why = el("span", "migrate-why", bad.slice(nameOf(o).length + 2) || bad);
      why.title = bad;
      r.append(why);
      hint = "try again";
      always = true;
    } else {
      if (said) r.append(el("span", `migrate-state${o.busy ? " busy" : ""}`, said));
      // Where it moves; a restart's heading already says why it stopped.
      if (o.kind !== "restart") {
        const where = el("span", "migrate-where", o.kind === "resume" ? "to cmux" : "from cmux");
        where.title = o.kind === "revive" ? "Resumes its last conversation in this app's own terminal" : "";
        r.append(where);
      }
    }
    if (this.running.has(k)) {
      hint = `${o.kind === "restart" ? "restarting" : o.kind === "revive" ? "bringing back" : "moving"}…`;
      act = null;
      always = true;
    } else if (!bad && o.busy && this.queued.has(k)) {
      hint = "moves when idle";
      act = null;
      always = true;
    } else if (!bad && o.busy) {
      hint = "move when idle";
      r.title = "It is busy now: it moves as soon as it goes idle";
      act = () => {
        this.queued.add(k);
        void this.refresh();
      };
    }
    r.append(el("span", `migrate-hint${always ? " on" : ""}`, hint));
    r.setAttribute("aria-label", `${nameOf(o)}: ${hint}. Delete forgets it.`);
    if (act) {
      const go = act;
      r.addEventListener("click", () => go());
    } else r.setAttribute("aria-disabled", "true");
    const no = button("×", "migrate-no");
    no.title = o.kind === "restart" ? "Don't restart it, and forget it" : o.kind === "revive" ? "Leave it in cmux" : "Leave it where it is";
    no.setAttribute("aria-label", no.title);
    no.addEventListener("click", () => void this.decline(o));
    // One Tab stop a row: the row's action. Delete or Backspace on it does
    // what × does, so the keyboard can forget a session too.
    no.tabIndex = -1;
    r.setAttribute("aria-keyshortcuts", "Delete");
    // What a click does is the row's own hint (restart, move, bring back, try
    // again…), so the tooltip says that rather than a fixed verb.
    if (!r.title) r.title = act ? `Enter or a click: ${hint} · Delete forgets it` : "Delete forgets it";
    r.addEventListener("keydown", (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void this.decline(o);
      }
    });
    row.append(no);
    return row;
  }

  private async apply(o: Offer): Promise<void> {
    const k = key(o);
    if (this.running.has(k)) return;
    this.running.add(k);
    this.draw();
    try {
      await invoke<string>("migrate_apply", { kind: o.kind, pane: o.pane });
      const v = o.kind === "restart" ? "restarted" : o.kind === "revive" ? "brought back" : "moved";
      this.moved.set(v, (this.moved.get(v) ?? 0) + 1);
      this.failed.delete(k);
      this.failedOffers.delete(k);
      this.queued.delete(k);
    } catch (e) {
      // Busy again (it started a turn): back in the queue.
      if (String(e).includes("busy")) this.queued.add(k);
      else {
        const name = nameOf(o);
        // Its name leads the line once; the error need not say it again.
        // Only the title as a whole word, never inside another word or a
        // path, and never a title too short to tell apart ("a").
        const esc = o.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const why = o.title.length >= 3 ? String(e).replace(new RegExp(`(?<![\\w./-])${esc}(?![\\w./-])`, "g"), "it") : String(e);
        this.failed.set(k, `${name}: ${why}`);
        this.failedOffers.set(k, o);
      }
    } finally {
      this.running.delete(k);
    }
    await this.refresh();
  }

  private async decline(o: Offer): Promise<void> {
    this.skipped.add(key(o));
    this.queued.delete(key(o));
    // Given up on: its failure no longer needs saying.
    this.failed.delete(key(o));
    this.failedOffers.delete(key(o));
    if (o.kind === "restart") {
      try {
        await invoke("migrate_forget", { pane: o.pane });
      } catch (e) {
        this.tell(String(e));
      }
    }
    this.draw();
  }

  /** A word under the list: what went wrong forgetting one. */
  private tell(text: string): void {
    this.say.textContent = text;
    this.say.hidden = false;
  }
}
