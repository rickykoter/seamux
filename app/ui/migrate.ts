// The launch banner at the top of the Dock: sessions on the other backend
// that can move onto this app's, and tmux panes that stopped with their
// server and can restart (crates/seamux-app/src/migrate_app.rs).
//
// It never blocks the app. Review opens (and closes) a short list, each one
// with its own button; a busy one (working, or waiting on you) can be asked
// to move once idle, and the banner moves it when it gets there. The
// one-click "all" button sits on the banner's own line. Later hides the
// banner until the next launch, and it hides itself once nothing is left to
// move (after showing how the last one went). When all that is left failed,
// it says so with Try again and Dismiss: a failed restart stays on offer
// (the registry keeps its gone pane), so trying again is the same apply.
import { invoke } from "@tauri-apps/api/core";

type Kind = "adopt" | "resume" | "restart" | "revive";
type Offer = { kind: Kind; pane: string; ws: string; title: string; cwd: string; claude: string; state: string; busy: boolean };

/** How often a queued busy session is looked at again. */
const POLL_MS = 3000;
/** How long the last result stays once nothing is left, before the banner goes. */
const DONE_MS = 4000;

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

/** The banner's one line: what waits, by kind. */
export function summary(offers: Offer[]): string {
  const n = (k: Kind) => offers.filter((o) => o.kind === k).length;
  const s = (c: number, one: string, many: string) => (c === 1 ? one : many.replace("#", String(c)));
  const parts: string[] = [];
  if (n("adopt")) parts.push(s(n("adopt"), "1 cmux session can move here", "# cmux sessions can move here"));
  if (n("resume")) parts.push(s(n("resume"), "1 session can move to cmux", "# sessions can move to cmux"));
  if (n("restart")) parts.push(s(n("restart"), "1 session stopped with tmux", "# sessions stopped with tmux"));
  if (n("revive")) parts.push(s(n("revive"), "1 cmux workspace can come back here", "# cmux workspaces can come back here"));
  return parts.join(" · ");
}

function verb(o: Offer): string {
  return o.kind === "restart" ? "Restart" : o.kind === "revive" ? "Bring back" : "Move";
}

export class MigrateBanner {
  readonly el = el("section", "migrate");
  private line = el("span", "migrate-line");
  private list = el("div", "migrate-list");
  private say = el("p", "migrate-say");
  private offers: Offer[] = [];
  /** Hidden from this launch's list: declined with ×. */
  private skipped = new Set<string>();
  /** Busy ones asked to move once idle. */
  private queued = new Set<string>();
  /** Moving now: its button stays disabled. */
  private running = new Set<string>();
  private open = false;
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
  private review = button("Review ▾", "migrate-review");
  private later = button("Later");
  /** Failed: the failed ones again. */
  private retry = button("Try again", "migrate-retry");
  /** The banner line's one-click button: every idle one at once. */
  private all = button("", "migrate-all");

  constructor() {
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Sessions that can move");
    const head = el("div", "migrate-head");
    const review = this.review;
    this.all.addEventListener("click", () => {
      for (const o of this.idle()) void this.apply(o);
    });
    review.setAttribute("aria-expanded", "false");
    review.addEventListener("click", () => {
      this.open = !this.open;
      review.textContent = this.open ? "Review ▴" : "Review ▾";
      review.setAttribute("aria-expanded", String(this.open));
      this.draw();
    });
    this.retry.addEventListener("click", () => {
      for (const o of this.retryable()) void this.apply(o);
    });
    const later = this.later;
    later.addEventListener("click", () => this.close());
    // The line on its own row, the buttons under it: beside them, at rail
    // width, the line wrapped a word at a time.
    const acts = el("div", "migrate-acts");
    acts.append(this.all, this.retry, review, later);
    head.append(mark(), this.line, acts);
    this.say.hidden = true;
    this.el.append(head, this.list, this.say);
  }

  /** Ask once at launch; nothing shows when nothing waits. */
  async start(): Promise<void> {
    await this.refresh();
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
    return this.shown().filter((o) => !o.busy && !this.running.has(key(o)));
  }

  /** The failed ones that can be tried again: the fresh offer when it is
   *  still listed, else the one kept from the failure. */
  private retryable(): Offer[] {
    return [...this.failedOffers].filter(([k]) => !this.skipped.has(k) && !this.running.has(k)).map(([k, o]) => this.offers.find((x) => key(x) === k) ?? o);
  }

  private close(): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.doneTimer);
    this.queued.clear();
    this.closed = true;
    this.el.hidden = true;
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

  private draw(): void {
    const offers = this.shown();
    window.clearTimeout(this.doneTimer);
    // Later means later, even for moves still finishing in the background.
    if (this.closed) {
      this.el.hidden = true;
      return;
    }
    // Nothing left but what failed (and nothing still running): say so,
    // with Try again and Dismiss.
    const left = offers.filter((o) => !this.failed.has(key(o)));
    if (!left.length && this.failed.size && !this.running.size) {
      this.el.hidden = false;
      this.el.classList.add("done", "failed");
      this.line.textContent = this.failed.size === 1 ? "1 did not come back" : `${this.failed.size} did not come back`;
      this.tell([...this.failed.values()].join(" · "), true);
      this.all.hidden = true;
      this.review.hidden = true;
      this.retry.hidden = !this.retryable().length;
      this.later.hidden = false;
      this.later.textContent = "Dismiss";
      this.later.title = "Hide this until the app starts again";
      this.list.hidden = true;
      return;
    }
    this.retry.hidden = true;
    this.later.textContent = "Later";
    this.later.title = "Hide until the app starts again";
    if (!offers.length && this.running.size) {
      // Trying again one the backend no longer lists: wait for its answer.
      this.line.textContent = "Trying again…";
      this.retry.hidden = true;
      this.later.hidden = true;
      return;
    }
    if (!offers.length) {
      // Nothing left: a clean run shows briefly, then the banner goes. With
      // nothing said, it goes at once.
      // Done means something moved this run (the tally), not that a message
      // is left over: dismissing every offer with × moves nothing and hides.
      if (!this.moved.size || this.el.hidden) {
        this.reset();
        this.el.hidden = true;
        return;
      }
      this.el.classList.add("done");
      this.line.textContent = "All done";
      // One line for the whole run, not the last one's: "5 restarted".
      this.tell([...this.moved].map(([v, n]) => `${n} ${v}`).join(" · "));
      this.all.hidden = true;
      this.review.hidden = true;
      this.later.hidden = true;
      this.list.hidden = true;
      this.doneTimer = window.setTimeout(() => {
        this.reset();
        this.el.hidden = true;
      }, DONE_MS);
      return;
    }
    this.el.hidden = false;
    this.el.classList.remove("done", "failed");
    this.review.hidden = false;
    this.later.hidden = false;
    this.line.textContent = summary(offers);
    this.list.hidden = !this.open;
    // A row's state shows only where they differ (a busy one among idle
    // ones): ten rows of "idle" say nothing.
    const said = offers.map((o) => this.stateOf(o));
    const alike = said.every((t) => t === said[0]);
    this.list.replaceChildren(...offers.map((o, i) => this.row(o, !alike || o.busy ? said[i] : "")));
    const idle = this.idle();
    this.all.hidden = !idle.length;
    if (idle.length) {
      const same = idle.every((o) => verb(o) === verb(idle[0]));
      const v = same ? verb(idle[0]) : "Do";
      this.all.textContent = idle.length === 1 ? v : same ? `${v} all ${idle.length}` : `Do all ${idle.length}`;
      this.all.title = idle.length === offers.length ? "" : `${offers.length - idle.length} busy: those wait for Review`;
    }
  }

  private stateOf(o: Offer): string {
    return this.failed.has(key(o)) ? "didn't start" : (STATE[o.state] ?? o.state);
  }

  private row(o: Offer, said: string): HTMLElement {
    const k = key(o);
    const r = el("div", "migrate-row");
    const name = el("b", "", o.title || o.cwd.split("/").pop() || o.pane.slice(0, 8));
    name.title = o.cwd;
    r.append(name);
    if (said) r.append(el("span", `migrate-state${o.busy ? " busy" : ""}${this.failed.has(k) ? " bad" : ""}`, said));
    // Where it moves; a restart's banner line already says why it stopped.
    if (o.kind !== "restart") {
      const where = el("span", "migrate-where", o.kind === "resume" ? "to cmux" : "from cmux");
      where.title = o.kind === "revive" ? "Resumes its last conversation in this app's own terminal" : "";
      r.append(where);
    }
    if (this.running.has(k)) {
      r.append(el("span", "migrate-wait", `${o.kind === "restart" ? "restarting" : o.kind === "revive" ? "bringing back" : "moving"}…`));
    } else if (o.busy && this.queued.has(k)) {
      r.append(el("span", "migrate-wait", "moves when idle"));
    } else if (o.busy) {
      const when = button("Move when idle");
      when.title = "It is busy now: it moves as soon as it goes idle";
      when.addEventListener("click", () => {
        this.queued.add(k);
        void this.refresh();
      });
      r.append(when);
    } else {
      const go = button(verb(o), "migrate-go");
      go.addEventListener("click", () => void this.apply(o));
      r.append(go);
    }
    const no = button("×", "migrate-no");
    no.title = o.kind === "restart" ? "Don't restart it, and forget it" : o.kind === "revive" ? "Leave it in cmux" : "Leave it where it is";
    no.setAttribute("aria-label", no.title);
    no.addEventListener("click", () => void this.decline(o));
    r.append(no);
    return r;
  }

  private async apply(o: Offer): Promise<void> {
    const k = key(o);
    if (this.running.has(k)) return;
    this.running.add(k);
    this.draw();
    try {
      const done = await invoke<string>("migrate_apply", { kind: o.kind, pane: o.pane });
      this.tell(done);
      const v = o.kind === "restart" ? "restarted" : o.kind === "revive" ? "brought back" : "moved";
      this.moved.set(v, (this.moved.get(v) ?? 0) + 1);
      this.failed.delete(k);
      this.failedOffers.delete(k);
      this.queued.delete(k);
    } catch (e) {
      // Busy again (it started a turn): back in the queue.
      if (String(e).includes("busy")) this.queued.add(k);
      else {
        const name = o.title || o.pane.slice(0, 8);
        // Its name leads the line once; the error need not say it again.
        // Only the title as a whole word, never inside another word or a
        // path, and never a title too short to tell apart ("a").
        const esc = o.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const why = o.title.length >= 3 ? String(e).replace(new RegExp(`(?<![\\w./-])${esc}(?![\\w./-])`, "g"), "it") : String(e);
        this.failed.set(k, `${name}: ${why}`);
        this.failedOffers.set(k, o);
        this.tell(`${name}: ${why}`, true);
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
        this.tell(String(e), true);
      }
    }
    this.draw();
  }

  private tell(text: string, bad = false): void {
    this.say.textContent = text;
    this.say.className = `migrate-say${bad ? " bad" : ""}`;
    this.say.hidden = false;
  }
}
