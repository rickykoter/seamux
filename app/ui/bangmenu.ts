// The menu a `!` command in a pane shows on hover (bang.ts finds them): run
// it in the chat, as Claude's bash mode would, or in the ⌘J shell, or copy
// it. native.ts says how each is done.

export type BangActions = { chat: (cmd: string) => void; shell: (cmd: string) => void; copy: (cmd: string) => void };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class BangMenu {
  el = el("div", "pane-bang");
  private cmd = "";
  private showTimer = 0;
  private hideTimer = 0;
  private codeEl = el("code", "pb-cmd");

  constructor(private host: HTMLElement, act: BangActions) {
    this.el.hidden = true;
    this.el.setAttribute("role", "menu");
    const head = el("div", "pb-head");
    head.append(el("span", "pb-label", "Run"), this.codeEl);
    const row = el("div", "pb-row");
    const button = (label: string, title: string, go: (cmd: string) => void) => {
      const b = el("button", "pb-btn");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.title = title;
      b.textContent = label;
      b.addEventListener("click", () => {
        const c = this.cmd;
        this.hide();
        if (c) go(c);
      });
      return b;
    };
    row.append(
      button("In chat", "Type it into Claude's prompt as a ! command and send it: its output joins the conversation", act.chat),
      button("In ⌘J shell", "Run it in the companion shell under Claude: its output stays out of the conversation", act.shell),
      button("Copy", "Copy the command", act.copy),
    );
    this.el.append(head, row);
    // The pointer on the menu keeps it; off it, the menu goes.
    this.el.addEventListener("mouseenter", () => clearTimeout(this.hideTimer));
    this.el.addEventListener("mouseleave", () => this.leave());
    // Its clicks are its own, never tmux's.
    this.el.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    host.append(this.el);
  }

  /** The pointer is on a command: the menu in a moment. */
  hover(cmd: string, e: MouseEvent): void {
    clearTimeout(this.hideTimer);
    if (!this.el.hidden && this.cmd === cmd) return;
    clearTimeout(this.showTimer);
    const at = this.at(e);
    this.showTimer = window.setTimeout(() => this.draw(cmd, at), 280);
  }

  /** A click on the command: the menu at once. */
  pin(cmd: string, e?: MouseEvent): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.draw(cmd, e ? this.at(e) : { x: 24, y: this.host.clientHeight / 2 });
  }

  /** The pointer left the command: the menu goes unless it moves onto it. */
  leave(): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), 260);
  }

  hide(): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.el.hidden = true;
    this.cmd = "";
  }

  private at(e: MouseEvent): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private draw(cmd: string, at: { x: number; y: number }): void {
    this.cmd = cmd;
    this.codeEl.textContent = cmd;
    this.codeEl.title = cmd;
    this.el.hidden = false;
    // Under the pointer where it fits (so the move onto it is short), else above.
    const w = this.host.clientWidth;
    const mw = Math.min(380, w - 16);
    this.el.style.maxWidth = `${mw}px`;
    const ew = Math.min(this.el.offsetWidth, mw);
    this.el.style.left = `${Math.max(8, Math.min(at.x - 16, w - ew - 8))}px`;
    const h = this.el.offsetHeight;
    this.el.style.top = `${at.y + 10 + h <= this.host.clientHeight - 4 ? at.y + 10 : Math.max(4, at.y - h - 10)}px`;
  }
}
