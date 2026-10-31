// The launch banner at the top of the Dock: sessions on the other backend
// that can move onto this app's, and tmux panes that stopped with their
// server and can restart (crates/seamux-app/src/migrate_app.rs).
//
// It never blocks the app. Review lists each one with its own button; a
// busy one (working, or waiting on you) can be asked to move once idle, and
// the banner moves it when it gets there. Later hides the banner until the
// next launch.
import { invoke } from "@tauri-apps/api/core";

type Kind = "adopt" | "resume" | "restart" | "revive";
type Offer = { kind: Kind; pane: string; ws: string; title: string; cwd: string; claude: string; state: string; busy: boolean };

/** How often a queued busy session is looked at again. */
const POLL_MS = 3000;

const STATE: Record<string, string> = {
  working: "working",
  needs_input: "waiting on you",
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

  constructor() {
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Sessions that can move");
    const head = el("div", "migrate-head");
    const review = button("Review", "migrate-review");
    review.addEventListener("click", () => {
      this.open = !this.open;
      review.textContent = this.open ? "Hide" : "Review";
      this.draw();
    });
    const later = button("Later");
    later.title = "Hide until the app starts again";
    later.addEventListener("click", () => this.close());
    head.append(this.line, review, later);
    this.say.hidden = true;
    this.el.append(head, this.list, this.say);
  }

  /** Ask once at launch; nothing shows when nothing waits. */
  async start(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.offers = await invoke<Offer[]>("migrate_offers");
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

  private close(): void {
    window.clearTimeout(this.timer);
    this.queued.clear();
    this.el.hidden = true;
  }

  private draw(): void {
    const offers = this.shown();
    if (!offers.length && !this.say.textContent) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.line.textContent = offers.length ? summary(offers) : "Done";
    this.list.hidden = !this.open || !offers.length;
    this.list.replaceChildren(...offers.map((o) => this.row(o)));
    const idle = offers.filter((o) => !o.busy && !this.running.has(key(o)));
    if (this.open && idle.length > 1) {
      const all = button(idle[0].kind === "revive" ? "Bring back all" : `${verb(idle[0])} all idle`, "migrate-all");
      if (idle.some((o) => verb(o) !== verb(idle[0]))) all.textContent = "Do all of them";
      all.addEventListener("click", () => {
        for (const o of idle) void this.apply(o);
      });
      this.list.append(all);
    }
  }

  private row(o: Offer): HTMLElement {
    const k = key(o);
    const r = el("div", "migrate-row");
    const name = el("b", "", o.title || o.cwd.split("/").pop() || o.pane.slice(0, 8));
    name.title = o.cwd;
    const state = el("span", `migrate-state${o.busy ? " busy" : ""}`, STATE[o.state] ?? o.state);
    const where = el("span", "migrate-where", o.kind === "resume" ? "to cmux" : o.kind === "adopt" || o.kind === "revive" ? "from cmux" : "after a restart");
    where.title = o.kind === "revive" ? "Resumes its last conversation in this app's own terminal" : "";
    r.append(name, state, where);
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
      this.queued.delete(k);
    } catch (e) {
      // Busy again (it started a turn): back in the queue.
      if (String(e).includes("busy")) this.queued.add(k);
      else this.tell(String(e), true);
    } finally {
      this.running.delete(k);
    }
    await this.refresh();
  }

  private async decline(o: Offer): Promise<void> {
    this.skipped.add(key(o));
    this.queued.delete(key(o));
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
