import { invoke } from "@tauri-apps/api/core";
import "./tuck.css";

/** How a workspace is quieted: muted (dimmed, quiet until it asks) or tucked (hidden). */
export type Level = "mute" | "tuck";
export type Levels = Record<string, Level>;

/** A row of views:frame's tucked list (views.rs TuckRow). */
export type TuckRow = {
  path: string;
  level: Level;
  at: number;
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

const WORD: Record<Level, string> = { mute: "Muted", tuck: "Tucked away" };

/** Set `ws`'s level ("none" restores), with a note that can undo it. */
export async function setLevel(ws: string, name: string, level: Level | "none", was: Level | undefined): Promise<void> {
  try {
    await invoke("tuck_set", { workspace: ws, level });
    const back = was ?? "none";
    say(level === "none" ? `${name} is back` : `${WORD[level]}: ${name}`, { label: "Undo", run: () => void setLevel(ws, name, back, level === "none" ? undefined : level) });
  } catch (e) {
    say(String(e), undefined, true);
  }
}

/** The m / t keys: toggle mute or tuck on a workspace. */
export function toggle(ws: string, name: string, key: "m" | "t", was: Level | undefined): void {
  const want: Level = key === "m" ? "mute" : "tuck";
  void setLevel(ws, name, was === want ? "none" : want, was);
}

/** The ⋯ button and its menu for one workspace's card, tile or lane. */
export function menu(ws: string, name: string, level: Level | undefined): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "tuck-wrap";
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tuck-btn";
  b.setAttribute("aria-label", `${name}: mute or tuck away`);
  b.setAttribute("aria-haspopup", "menu");
  b.append(dots());
  const m = document.createElement("div");
  m.className = "tuck-menu";
  m.setAttribute("role", "menu");
  m.hidden = true;
  const item = (label: string, hint: string, to: Level | "none") => {
    const i = document.createElement("button");
    i.type = "button";
    i.className = "tuck-item";
    i.setAttribute("role", "menuitem");
    i.append(document.createTextNode(label));
    const k = document.createElement("kbd");
    k.textContent = hint;
    i.append(k);
    i.addEventListener("click", (e) => {
      e.stopPropagation();
      m.hidden = true;
      void setLevel(ws, name, to, level);
    });
    m.append(i);
  };
  if (level === "mute") item("Unmute", "m", "none");
  else item("Mute", "m", "mute");
  if (level === "tuck") item("Bring back", "t", "none");
  else item("Tuck away", "t", "tuck");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll<HTMLElement>(".tuck-menu").forEach((x) => x !== m && (x.hidden = true));
    m.hidden = !m.hidden;
  });
  wrap.append(b, m);
  return wrap;
}

// One click anywhere closes an open menu.
document.addEventListener("click", () => document.querySelectorAll<HTMLElement>(".tuck-menu").forEach((m) => (m.hidden = true)));
// Esc closes an open menu (and only that: the window stays), focus back on its button.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector<HTMLElement>(".tuck-menu:not([hidden])");
    if (!open) return;
    open.hidden = true;
    open.parentElement?.querySelector<HTMLElement>(".tuck-btn")?.focus();
    e.stopImmediatePropagation();
    e.preventDefault();
  },
  true,
);
