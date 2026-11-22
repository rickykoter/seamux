import { invoke } from "@tauri-apps/api/core";
import { askText, type AskContext } from "./bosun_model";

// Ask the Bosun, from a Radar row or a Lookout review: a small box under
// the button with the row's context as a chip and a question to start
// from. Enter queues it (bosun_send) with the context written into the
// text, and the ⌘B drop-down comes down so the person can watch it answer
// (main.ts hears seamux:bosun-asked). Hidden on cmux (bosun.css).

let box: HTMLElement | null = null;
let closeBox: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** An "Ask ▾" button that opens the box for `ctx` (read when clicked). */
export function askButton(ctx: () => AskContext, cls: string): HTMLButtonElement {
  const b = el("button", `${cls} bosun-ask-btn`, "Ask ▾");
  b.type = "button";
  b.title = "Ask the Bosun about this";
  b.setAttribute("aria-haspopup", "dialog");
  b.addEventListener("click", (e) => {
    // The row under it opens on a click of its own.
    e.stopPropagation();
    if (box && b.getAttribute("aria-expanded") === "true") return closeAsk();
    openAsk(b, ctx());
  });
  b.addEventListener("keydown", (e) => e.stopPropagation());
  return b;
}

/** Close the box, if one is open. */
export function closeAsk(): void {
  closeBox?.();
}

/** Open the box under `anchor` (an element, or where one was before a redraw took it). */
export function openAsk(anchor: HTMLElement | DOMRect, ctx: AskContext): void {
  closeAsk();
  const at = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
  const owner = anchor instanceof HTMLElement ? anchor : null;
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const b = el("div", "bosun-askbox");
  b.setAttribute("role", "dialog");
  b.setAttribute("aria-label", "Ask the Bosun");
  const head = el("div", "bosun-askbox-head");
  const chip = el("span", "bosun-askbox-chip", ctx.chip);
  chip.title = `Sent with the question: ${ctx.facts.join("; ")}`;
  head.append(el("span", "bosun-askbox-t", "Ask the Bosun"), chip);
  const q = el("textarea", "bosun-askbox-q");
  q.rows = 3;
  q.value = ctx.suggest;
  q.setAttribute("aria-label", "Your question");
  const err = el("p", "bosun-askbox-err");
  err.hidden = true;
  const foot = el("div", "bosun-askbox-foot");
  const hint = el("span", "bosun-askbox-hint", "Esc to close · ⇧↵ new line");
  const send = el("button", "bosun-askbox-send", "Ask ↵");
  send.type = "button";
  foot.append(hint, send);
  b.append(head, q, err, foot);

  const go = async () => {
    const text = q.value.trim();
    if (!text) return q.focus();
    send.disabled = q.disabled = true;
    send.textContent = "Asking…";
    try {
      await invoke<string>("bosun_send", { text: askText(ctx, text) });
      close(false);
      window.dispatchEvent(new CustomEvent("seamux:bosun-asked"));
    } catch (e) {
      send.disabled = q.disabled = false;
      send.textContent = "Ask ↵";
      err.textContent = `Couldn't queue it: ${String(e)}`;
      err.hidden = false;
    }
  };
  send.addEventListener("click", () => void go());
  // Keys stay in the box: the views under it have shortcuts, and the
  // shell's Escape would hide the window.
  b.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.target === q) {
      e.preventDefault();
      void go();
    }
  });
  b.addEventListener("click", (e) => e.stopPropagation());
  const outside = (e: MouseEvent) => {
    if (!b.contains(e.target as Node)) close(false);
  };

  function close(refocus: boolean): void {
    b.remove();
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("resize", onResize);
    owner?.setAttribute("aria-expanded", "false");
    if (box === b) {
      box = null;
      closeBox = null;
    }
    if (refocus && back?.isConnected) back.focus();
  }
  const onResize = () => close(false);

  document.body.append(b);
  // Under the button, its right edge on the button's, kept in the window.
  const w = b.offsetWidth, h = b.offsetHeight;
  const left = Math.max(8, Math.min(at.right - w, window.innerWidth - w - 8));
  const below = at.bottom + 6;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, at.top - h - 6) : below;
  b.style.left = `${left}px`;
  b.style.top = `${top}px`;
  owner?.setAttribute("aria-expanded", "true");
  box = b;
  closeBox = () => close(false);
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("resize", onResize);
  q.focus();
  q.select();
}
