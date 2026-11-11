// Over a native pane whose turn an API error stopped (stop_app.rs): what
// happened, the countdown to the app's next try (resume_watch.rs retries an
// overload, a server fault or a dropped connection), and what you can do:
// try now, stop the retries, or log in again.
import { invoke } from "@tauri-apps/api/core";

type Stop = {
  error: string;
  label: string;
  detail: string | null;
  api: boolean;
  retry: boolean;
  login: boolean;
  next_try: number | null;
  tries: number;
  gave_up: string | null;
  at: number;
};

/** What the banner's buttons do in the pane. */
export type StopActions = { type: (line: string) => void; say: (text: string) => void };

const POLL_MS = 3000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "0:24", "4:05". */
function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class StopBanner {
  el = el("div", "pane-stop");
  private surface = "";
  private stop: Stop | null = null;
  /** The stop (by its time) the person closed: hidden until a new one. */
  private closed = 0;
  private poller = 0;
  private ticker = 0;
  private gen = 0;
  private text = el("span", "ps-text");
  private when = el("span", "ps-when");
  private buttons = el("span", "ps-btns");

  constructor(private act: StopActions) {
    this.el.hidden = true;
    this.el.setAttribute("role", "status");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 14 14");
    icon.setAttribute("width", "13");
    icon.setAttribute("height", "13");
    icon.setAttribute("aria-hidden", "true");
    icon.classList.add("ps-icon");
    icon.innerHTML = '<path d="M7 1.8 12.6 11.6H1.4z"/><path d="M7 5.6v2.8M7 10v.1"/>';
    const close = el("button", "ps-close");
    close.type = "button";
    close.setAttribute("aria-label", "Hide this until the next stop");
    close.innerHTML = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    close.addEventListener("click", () => {
      this.closed = this.stop?.at ?? 0;
      this.draw();
    });
    this.el.append(icon, this.text, this.when, this.buttons, close);
    this.el.addEventListener("mousedown", (e) => e.stopPropagation(), true);
  }

  /** Watch `surface` ("" stops). */
  watch(surface: string): void {
    if (surface === this.surface) return;
    this.surface = surface;
    this.gen++;
    this.stop = null;
    this.draw();
    clearTimeout(this.poller);
    if (surface) void this.poll();
  }

  private async poll(): Promise<void> {
    const gen = this.gen;
    const seen = this.el.isConnected && !document.hidden;
    const got = seen ? await invoke<Stop | null>("pane_stop", { surface: this.surface }).catch(() => undefined) : undefined;
    if (gen !== this.gen) return;
    if (got !== undefined) {
      const was = JSON.stringify(this.stop);
      this.stop = got;
      if (JSON.stringify(got) !== was) this.draw();
    }
    clearTimeout(this.poller);
    this.poller = window.setTimeout(() => void this.poll(), POLL_MS);
  }

  private button(label: string, title: string, go: () => void, main = false): HTMLButtonElement {
    const b = el("button", main ? "ps-btn main" : "ps-btn", label);
    b.type = "button";
    b.title = title;
    b.addEventListener("click", go);
    return b;
  }

  private draw(): void {
    clearInterval(this.ticker);
    const s = this.stop;
    // A limit has its own place (the board's pill and the resume chip): the
    // banner is for the other API errors.
    if (!s || !s.api || s.at === this.closed) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.el.dataset.kind = s.login ? "login" : s.retry && !s.gave_up ? "retry" : "stuck";
    this.text.textContent = `Claude stopped: ${s.label}${s.detail ? ` (${s.detail})` : ""}`;
    this.text.title = `Claude Code's error: ${s.error}${s.detail ? ` — ${s.detail}` : ""}`;
    const btns: HTMLButtonElement[] = [];
    if (s.login) {
      btns.push(this.button("Log in", "Type /login into Claude", () => this.act.type("/login"), true));
    } else {
      btns.push(this.button(s.retry ? "Retry now" : "Continue", "Type continue into Claude's prompt and send it", () => this.act.type("continue"), true));
    }
    if (s.retry && !s.gave_up) {
      btns.push(
        this.button("Don't retry", "Stop the app trying this turn again: it waits for you", () => {
          void invoke<boolean>("pane_stop_cancel", { surface: this.surface }).then(
            () => void this.poll(),
            (err) => this.act.say(`Couldn't: ${err}`),
          );
        }),
      );
    }
    this.buttons.replaceChildren(...btns);
    const tick = () => {
      if (s.retry && !s.gave_up) {
        const left = s.next_try ? s.next_try - Date.now() : 0;
        const nth = s.tries > 0 ? ` (try ${s.tries + 1} of 3)` : "";
        this.when.textContent = s.next_try && left > 0 ? `· trying again in ${countdown(left)}${nth}` : `· trying again shortly${nth}`;
      } else if (s.gave_up) {
        this.when.textContent = `· not retrying: ${s.gave_up}`;
      } else {
        this.when.textContent = s.login ? "· log in again to go on" : "";
      }
    };
    tick();
    if (s.retry && !s.gave_up) this.ticker = window.setInterval(tick, 1000);
  }
}
