// Over Claude's prompt in a native pane, while bash-guard holds a command it
// refused there (held_app.rs, ADRs 0094-0097): the command, why, and what you
// can do. A git block can run in the chat (typed as `!cmd`, so its output
// joins the conversation) or in the ⌘J shell; a force push can also be
// allowed for its branch for the rest of the session. Every other block is
// copy only. The command shown and run is always the record's, read again
// from the app before anything is typed.
import { invoke } from "@tauri-apps/api/core";

export type Held = {
  pane: string;
  reason: string;
  kind: "run" | "copy";
  command: string;
  truncated: boolean;
  branch: string | null;
  at: number;
  run: boolean;
  chat: boolean;
  allow: string | null;
  lines: number;
  idle: boolean;
};

/** How the pane runs a command. `chat` types `!cmd` into Claude's empty
 *  prompt and says whether it could; `shell` runs it in the ⌘J shell. */
export type HeldActions = {
  /** Claude's prompt is on screen and empty (says why not). */
  ready: () => boolean;
  chat: (cmd: string) => boolean;
  shell: (cmd: string) => Promise<boolean>;
  copy: (cmd: string) => void;
  say: (text: string) => void;
};

export type HeldAct = "chat" | "shell" | "copy" | "dismiss" | "allow";

const POLL_MS = 2000;
/** Lines shown before the command folds. */
const FOLD = 3;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class HeldBanner {
  el = el("div", "pane-held");
  /** Told when a record comes or goes, so the pane can place the banner. */
  onChange: () => void = () => {};
  private surface = "";
  private held: Held | null = null;
  private poller = 0;
  private gen = 0;
  private open = false;
  private busy = false;
  private why = el("span", "ph-why");
  private cmd = el("pre", "ph-cmd");
  private more = el("button", "ph-more");
  private buttons = el("div", "ph-btns");

  constructor(private act: HeldActions) {
    this.el.hidden = true;
    this.el.setAttribute("role", "alertdialog");
    this.el.setAttribute("aria-label", "bash-guard held a command");
    const head = el("div", "ph-head");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 14 14");
    icon.setAttribute("width", "13");
    icon.setAttribute("height", "13");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("ph-icon");
    // A circle with a bar through it: held, not failed.
    icon.innerHTML = '<circle cx="7" cy="7" r="5.6"/><path d="M3.1 10.9 10.9 3.1"/>';
    const title = el("span", "ph-title", "bash-guard held a command");
    const close = el("button", "ph-close");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss: Claude goes on without it");
    close.title = "Dismiss: Claude goes on without it";
    close.innerHTML = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    close.addEventListener("click", () => void this.answer("dismiss"));
    head.append(icon, title, this.why, close);
    this.more.type = "button";
    this.more.addEventListener("click", () => {
      this.open = !this.open;
      this.draw();
    });
    this.el.append(head, this.cmd, this.more, this.buttons);
    // Its clicks are its own, never tmux's.
    this.el.addEventListener("mousedown", (e) => e.stopPropagation(), true);
  }

  /** The record on show, if any. */
  get current(): Held | null {
    return this.held;
  }

  /** Watch `surface` ("" stops). */
  watch(surface: string): void {
    if (surface === this.surface) return;
    this.surface = surface;
    this.gen++;
    this.held = null;
    this.open = false;
    this.draw();
    clearTimeout(this.poller);
    if (surface) void this.poll();
  }

  /** Read the record now (after a block the Dock pointed at, say). */
  async refresh(): Promise<Held | null> {
    const got = await invoke<Held | null>("pane_held", { surface: this.surface }).catch(() => undefined);
    if (got !== undefined) this.take(got);
    return this.held;
  }

  private async poll(): Promise<void> {
    const gen = this.gen;
    // Only a pane on screen polls; one kept off screen reads its record when
    // it shows again, or when the Dock answers for it (refresh).
    const seen = this.el.isConnected && !document.hidden && (this.el.parentElement?.getClientRects().length ?? 0) > 0;
    const got = seen ? await invoke<Held | null>("pane_held", { surface: this.surface }).catch(() => undefined) : undefined;
    if (gen !== this.gen) return;
    if (got !== undefined) this.take(got);
    clearTimeout(this.poller);
    this.poller = window.setTimeout(() => void this.poll(), POLL_MS);
  }

  private take(got: Held | null): void {
    const was = JSON.stringify(this.held);
    if (got?.at !== this.held?.at) this.open = false;
    this.held = got;
    if (JSON.stringify(got) !== was) this.draw();
  }

  /** Answer the record on show: run it, copy it, dismiss it, or run it and
   *  allow its branch. The record is read again first, so what runs is what
   *  bash-guard held, and a newer block is never answered by an old click. */
  async answer(what: HeldAct, seenAt?: number): Promise<boolean> {
    // Taken before the first await: a double click, or the banner and the
    // Dock at once, must not type the command twice.
    if (this.busy) return false;
    this.busy = true;
    try {
      const shown = this.held;
      const h = await this.refresh();
      // bash-guard's clock has whole seconds, so two blocks can share a time:
      // the command must be the one shown too.
      if (!h || (shown && (shown.at !== h.at || shown.command !== h.command)) || (seenAt !== undefined && seenAt !== h.at)) {
        this.act.say(h ? "A newer command was held: look again" : "Nothing is held here now");
        return false;
      }
      switch (what) {
        case "copy":
          this.act.copy(h.command);
          return true;
        case "dismiss":
          return await this.done(h, "dismiss");
        case "chat":
          if (!h.chat) return this.no(h.run ? "It's more than one line: run it in the ⌘J shell" : "This one is copy only");
          if (!h.idle) return this.no("Claude is still working: run it once its turn ends");
          if (!this.act.chat(h.command)) return false;
          return await this.done(h, "ran");
        case "allow":
          if (!h.allow || !h.chat) return this.no("This one can't be allowed for the session");
          if (!h.idle) return this.no("Claude is still working: run it once its turn ends");
          // The push first: nothing is recorded unless it was typed. A `!`
          // line runs in bash mode, which no hook sees, so this push does
          // not wait on the allow; the allow is for the next one.
          if (!this.act.chat(h.command)) return false;
          if (!(await this.done(h, "allow"))) {
            this.act.say(`Ran it, but couldn't allow ${h.allow} for the session`);
            return false;
          }
          return true;
        case "shell":
          if (!h.run) return this.no("This one is copy only");
          if (!(await this.act.shell(h.command))) return false;
          return await this.done(h, "ran");
      }
    } finally {
      this.busy = false;
    }
  }

  private no(why: string): boolean {
    this.act.say(why);
    return false;
  }

  private async done(h: Held, what: "ran" | "dismiss" | "allow"): Promise<boolean> {
    const ok = await invoke<boolean>("held_act", { surface: this.surface, at: h.at, act: what }).then(
      () => true,
      (err) => {
        this.act.say(`Couldn't: ${err}`);
        return false;
      },
    );
    await this.refresh();
    return ok;
  }

  private button(label: string, title: string, what: HeldAct, opts: { main?: boolean; off?: string } = {}): HTMLButtonElement {
    const b = el("button", opts.main ? "ph-btn main" : "ph-btn", label);
    b.type = "button";
    b.title = opts.off ?? title;
    if (opts.off) b.setAttribute("aria-disabled", "true");
    b.addEventListener("click", () => void this.answer(what));
    return b;
  }

  private draw(): void {
    const h = this.held;
    const was = !this.el.hidden;
    if (!h) {
      this.el.hidden = true;
      if (was) this.onChange();
      return;
    }
    this.el.hidden = false;
    this.el.dataset.kind = h.kind;
    this.why.textContent = h.reason;
    this.why.title = h.reason;
    const long = h.lines > FOLD;
    this.cmd.textContent = long && !this.open ? h.command.split("\n").slice(0, FOLD).join("\n") + "\n…" : h.command;
    this.cmd.title = h.truncated ? "Only the start of a longer command was kept: it can be copied, not run" : "";
    this.more.hidden = !long;
    this.more.textContent = this.open ? "Fold" : `Show all ${h.lines} lines`;
    const busy = h.idle ? undefined : "Claude is still working: this runs once its turn ends";
    const btns: HTMLButtonElement[] = [];
    if (h.run && h.chat) {
      btns.push(this.button("Run in chat", "Type it into Claude's prompt as a ! command: it runs as you, and its output joins the conversation", "chat", { main: true, off: busy }));
    }
    if (h.allow) {
      btns.push(this.button(`Run and allow ${h.allow} this session`, `Run it in the chat, and let a leased force push to ${h.allow} through for the rest of this Claude session`, "allow", { off: busy }));
    }
    if (h.run) {
      btns.push(this.button("Run in ⌘J", h.chat ? "Run it in the companion shell: its output stays out of the conversation" : "Run it in the companion shell (more than one line, so not in the chat)", "shell", { main: !h.chat }));
    }
    btns.push(this.button("Copy", h.run ? "Copy the command" : "Copy the command: bash-guard offers this kind only to paste yourself", "copy", { main: !h.run }));
    this.buttons.replaceChildren(...btns);
    if (!was) this.onChange();
  }
}
