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
const ORDER: Appearance[] = ["system", "light", "dark"];
const SAID: Record<Appearance, string> = {
  system: "Appearance: follows the system",
  light: "Appearance: light",
  dark: "Appearance: dark",
};

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

/** The top bar's button. The choice is in force before it returns. */
export function appearanceButton(): HTMLButtonElement {
  let now = saved();
  apply(now);
  const b = document.createElement("button");
  b.type = "button";
  b.id = "appearance";
  const draw = () => {
    const next = ORDER[(ORDER.indexOf(now) + 1) % ORDER.length];
    b.replaceChildren(icon(now));
    b.title = `${SAID[now]} (click for ${next === "system" ? "the system's" : next})`;
    b.setAttribute("aria-label", b.title);
  };
  b.addEventListener("click", () => {
    now = ORDER[(ORDER.indexOf(now) + 1) % ORDER.length];
    save(now);
    apply(now);
    draw();
  });
  draw();
  return b;
}
