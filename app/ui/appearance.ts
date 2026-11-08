// The app's appearance: follow the system, or always light, or always dark.
// One button in the top bar cycles them (system → light → dark), for a person
// who moves between indoors and out.
//
// It sets the window's own theme (Tauri setTheme), and on macOS everything in
// the window then reports that scheme through prefers-color-scheme: the app's
// pages, every framed page (the Dock's rail, deep-plan, lookout) and the
// terminals (native.ts listens for the change). The same choice also goes on
// this page's root as data-theme, so the page follows it where the window
// cannot be themed (the demo in a browser).
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Appearance = "system" | "light" | "dark";

const KEY = "seamux.appearance";
/** The system's own look, as last seen while following it (the window's
 *  theme hides it otherwise). Dark until seen. */
let sysDark = true;

/** What a click goes to: the look that changes the screen first, then the
 *  other, then back to the system. Following a dark system: light, dark,
 *  system; a light one: dark, light, system. No click is a no-op. */
export function next(a: Appearance, systemIsDark = sysDark): Appearance {
  const other: Appearance = systemIsDark ? "light" : "dark";
  const same: Appearance = systemIsDark ? "dark" : "light";
  return a === "system" ? other : a === other ? same : "system";
}

/** What the look is in force now: the system's, when following it. */
function systemDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/** The button's tooltip: the choice, the look it gives now, and what a click
 *  does. Claude Code draws some of its own colours in the terminal (a
 *  selected answer, the prompt border, diffs) from its own theme, which
 *  seamux never sets, so the tooltip names the seamux-mods themes to pick in
 *  /theme: foam follows this button, dark and light fit one mode each. */
export function said(a: Appearance, dark: boolean): string {
  const then0 = next(a);
  const now = a === "system" ? `follows the system (${dark ? "dark" : "light"} now)` : a;
  const then = then0 === "system" ? "to follow the system" : `for ${then0}`;
  return `Appearance: ${now}. Click ${then}. To match Claude Code's colours, pick a theme in its /theme: seamux foam follows this button, and seamux ${dark ? "dark" : "light"} fits this mode.`;
}

/** The short word shown beside the icon after a click. */
function word(a: Appearance, dark: boolean): string {
  return a === "system" ? `System · ${dark ? "dark" : "light"}` : a === "light" ? "Light" : "Dark";
}

/** How long that word stays. */
const SAY_MS = 1500;

function saved(): Appearance {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function save(a: Appearance): void {
  try {
    if (a === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, a);
  } catch {
    // Storage refused: the choice lasts until the app restarts.
  }
}

/** Put the choice in force: the window's theme, and this page's root. */
function apply(a: Appearance): void {
  const root = document.documentElement;
  if (a === "system") delete root.dataset.theme;
  else root.dataset.theme = a;
  void getCurrentWindow()
    .setTheme(a === "system" ? null : a)
    .catch(() => {});
}

const NS = "http://www.w3.org/2000/svg";
/** The button's mark: a half-filled circle (system), a sun (light), a moon (dark). */
function icon(a: Appearance): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  const path = (d: string, fill = false) => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", fill ? "currentColor" : "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.4");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    s.append(p);
  };
  if (a === "system") {
    path("M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z");
    path("M8 2.5a5.5 5.5 0 0 1 0 11z", true);
  } else if (a === "light") {
    path("M8 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6z");
    path("M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06");
  } else {
    path("M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z");
  }
  return s;
}

/** The top bar's button. The choice is in force before it returns. After a
 *  click a word beside the icon says the new look for a moment, so a flip
 *  made outdoors, at a glance, is confirmed. */
export function appearanceButton(): HTMLButtonElement {
  let now = saved();
  // Before the window takes a theme, the media query shows the system's own
  // look: read it now, so an explicit choice at launch still cycles right.
  sysDark = systemDark();
  apply(now);
  const b = document.createElement("button");
  b.type = "button";
  b.id = "appearance";
  const tag = document.createElement("span");
  tag.className = "appearance-said";
  tag.setAttribute("aria-live", "polite");
  let timer = 0;
  const draw = () => {
    // Following the system, the media query shows its look: remember it for
    // the cycle, since an explicit choice hides it.
    if (now === "system") sysDark = systemDark();
    b.replaceChildren(icon(now), tag);
    b.title = said(now, systemDark());
    b.setAttribute("aria-label", b.title);
  };
  b.addEventListener("click", () => {
    now = next(now);
    save(now);
    apply(now);
    draw();
    // The window's theme lands a moment later; read the look once it has.
    window.requestAnimationFrame(() => {
      draw();
      tag.textContent = word(now, systemDark());
      b.classList.add("saying");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        b.classList.remove("saying");
        tag.textContent = "";
      }, SAY_MS);
    });
  });
  // The system flips (sunset, or by hand): the tooltip says the new look.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    draw();
    if (tag.textContent) tag.textContent = word(now, systemDark());
  });
  draw();
  return b;
}
