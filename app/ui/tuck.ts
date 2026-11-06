import { invoke } from "@tauri-apps/api/core";
import "./tuck.css";

/** How a workspace is quieted: muted (dimmed, quiet until it asks), snoozed
 *  (hidden until a time or until it asks) or tucked (hidden). */
export type Level = "mute" | "snooze" | "tuck";
export type Levels = Record<string, Level>;

/** A row of views:frame's tucked list (views.rs TuckRow). */
export type TuckRow = {
  path: string;
  level: Level;
  at: number;
  /** When a snooze ends (ms since the epoch). */
  until?: number;
  name: string;
  branch: string;
  workspaces: string[];
  waiting: boolean;
  last: number;
};

export function levelOf(levels: Levels | undefined, ws: string): Level | undefined {
  return levels?.[ws];
}

const SVG = "http://www.w3.org/2000/svg";

/** Three dots, drawn: the menu's mark. */
function dots(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const cx of [3.5, 8, 12.5]) {
    const c = document.createElementNS(SVG, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", "8");
    c.setAttribute("r", "1.3");
    svg.append(c);
  }
  return svg;
}

let note: HTMLElement | null = null;
let noteTimer = 0;

/** A note at the bottom of the window, with an action (Undo) for a while. */
export function say(text: string, action?: { label: string; run: () => void }, bad = false): void {
  if (!note) {
    note = document.createElement("div");
    note.className = "tuck-note";
    note.setAttribute("role", "status");
    document.body.append(note);
  }
  note.replaceChildren(document.createTextNode(text));
  note.classList.toggle("bad", bad);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      note?.classList.remove("on");
      action.run();
    });
    note.append(b);
  }
  note.classList.add("on");
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => note?.classList.remove("on"), 6000);
}

const WORD: Record<Level, string> = { mute: "Muted", snooze: "Snoozed", tuck: "Tucked away" };

/** The snooze presets, as both ⋯ menus offer them (crew/board/intent.js
 *  keeps the same four). */
export type Snooze = "1h" | "3h" | "tomorrow" | "monday";
export const SNOOZES: { key: Snooze; label: string }[] = [
  { key: "1h", label: "Snooze 1h" },
  { key: "3h", label: "Snooze 3h" },
  { key: "tomorrow", label: "Until tomorrow 9am" },
  { key: "monday", label: "Until Monday 9am" },
];

/** When a snooze preset taken at `now` ends (ms since the epoch, local time). */
export function snoozeUntil(key: Snooze, now: Date): number {
  if (key === "1h" || key === "3h") return now.getTime() + (key === "1h" ? 1 : 3) * 3_600_000;
  const d = new Date(now.getTime());
  // Tomorrow, or the next Monday after today (a week on, on a Monday).
  d.setDate(d.getDate() + (key === "tomorrow" ? 1 : (8 - d.getDay()) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

/** "3:00 PM" today, else "Mon 9:00 AM": when a snooze ends. */
export function wakesAt(until: number, now = new Date()): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Set `ws`'s level ("none" restores), with a note that can undo it. A
 *  snooze takes `until`; undoing back to a snooze is not offered, since its
 *  end is not known here. */
export async function setLevel(ws: string, name: string, level: Level | "none", was: Level | undefined, until?: number): Promise<void> {
  try {
    await invoke("tuck_set", { workspace: ws, level, until: level === "snooze" ? until : undefined });
    const back = was ?? "none";
    const text = level === "none" ? `${name} is back` : level === "snooze" && until ? `Snoozed until ${wakesAt(until)}: ${name}` : `${WORD[level]}: ${name}`;
    say(text, back === "snooze" ? undefined : { label: "Undo", run: () => void setLevel(ws, name, back, level === "none" ? undefined : level) });
  } catch (e) {
    say(String(e), undefined, true);
  }
}

/** The m / t keys: toggle mute or tuck on a workspace. */
export function toggle(ws: string, name: string, key: "m" | "t", was: Level | undefined): void {
  const want: "mute" | "tuck" = key === "m" ? "mute" : "tuck";
  void setLevel(ws, name, was === want ? "none" : want, was);
}

/** One entry of a ⋯ menu: its words, an optional key hint, what it does. */
export type MenuItem = { label: string; hint?: string; title?: string; run: (e: MouseEvent, b: HTMLButtonElement) => void };

/** A ⋯ button and its menu. One click elsewhere or Esc closes it (below). */
export function dotsMenu(label: string, items: MenuItem[]): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "tuck-wrap";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tuck-btn";
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.append(dots());
  const m = document.createElement("div");
  m.className = "tuck-menu";
  m.setAttribute("role", "menu");
  m.hidden = true;
  for (const it of items) {
    const i = document.createElement("button");
    i.type = "button";
    i.className = "tuck-item";
    i.setAttribute("role", "menuitem");
    if (it.title) i.title = it.title;
    i.append(document.createTextNode(it.label));
    if (it.hint) {
      const k = document.createElement("kbd");
      k.textContent = it.hint;
      i.append(k);
    }
    i.addEventListener("click", (e) => {
      e.stopPropagation();
      m.hidden = true;
      b.setAttribute("aria-expanded", "false");
      it.run(e, i);
    });
    m.append(i);
  }
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll<HTMLElement>(".tuck-menu").forEach((x) => x !== m && (x.hidden = true));
    m.hidden = !m.hidden;
    b.setAttribute("aria-expanded", String(!m.hidden));
    if (!m.hidden) flip(m);
  });
  wrap.append(b, m);
  return wrap;
}

/** Open upward when the menu would run past the bottom of what scrolls it. */
function flip(m: HTMLElement): void {
  m.classList.remove("up");
  let box: HTMLElement | null = m.parentElement;
  while (box && !/(auto|scroll|hidden)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  const floor = box ? box.getBoundingClientRect().bottom : window.innerHeight;
  if (m.getBoundingClientRect().bottom > floor) m.classList.add("up");
}

/** The ⋯ button and its menu for one workspace's card, tile or lane. */
export function menu(ws: string, name: string, level: Level | undefined): HTMLElement {
  const to = (t: Level | "none") => () => void setLevel(ws, name, t, level);
  const snooze: MenuItem[] = level === "snooze"
    ? [{ label: "Wake now", run: to("none") }]
    : SNOOZES.map((s) => ({ label: s.label, run: () => void setLevel(ws, name, "snooze", level, snoozeUntil(s.key, new Date())) }));
  return dotsMenu(`${name}: mute, snooze or tuck away`, [
    level === "mute" ? { label: "Unmute", hint: "m", run: to("none") } : { label: "Mute", hint: "m", run: to("mute") },
    ...snooze,
    level === "tuck" ? { label: "Bring back", hint: "t", run: to("none") } : { label: "Tuck away", hint: "t", run: to("tuck") },
  ]);
}

// One click anywhere closes an open menu.
const shut = (m: HTMLElement) => {
  m.hidden = true;
  m.parentElement?.querySelector(".tuck-btn")?.setAttribute("aria-expanded", "false");
};
document.addEventListener("click", () => document.querySelectorAll<HTMLElement>(".tuck-menu:not([hidden])").forEach(shut));
// Esc closes an open menu (and only that: the window stays), focus back on its button.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector<HTMLElement>(".tuck-menu:not([hidden])");
    if (!open) return;
    shut(open);
    open.parentElement?.querySelector<HTMLElement>(".tuck-btn")?.focus();
    e.stopImmediatePropagation();
    e.preventDefault();
  },
  true,
);
