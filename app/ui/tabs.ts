import { invoke } from "@tauri-apps/api/core";

// The shapes of shell.rs's commands.
type IntentServer = { origin: string | null; up: boolean; reason: string | null };

/** A tab: one of the app's own views, or an intent-server page it frames. */
export type Tab = {
  id: string;
  label: string;
  /** A path on crew-board-intent's origin; absent for the app's own views. */
  path?: string;
  /** Said when the server is up but the page isn't served yet. */
  missing?: string;
};

/** The views, in the strip, Command-1 to Command-3. */
export const TABS: Tab[] = [
  { id: "dock", label: "Dock" },
  { id: "wake", label: "Wake" },
  { id: "review", label: "Lookout" },
];

/** The pages behind the ⋯ menu, framed from the intent server. */
export const MENU: Tab[] = [
  { id: "usage", label: "Usage", path: "/usage" },
  {
    id: "board",
    label: "Board",
    path: "/board",
    missing: "The intent server doesn't serve the board yet; it arrives with the port-board plan.",
  },
];

export const DEFAULT_TAB = "dock";

const SVG = "http://www.w3.org/2000/svg";

/** Three dots, drawn: the menu button's mark. */
function dots(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const cx of [3.5, 8, 12.5]) {
    const c = document.createElementNS(SVG, "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", "8");
    c.setAttribute("r", "1.4");
    svg.append(c);
  }
  return svg;
}

/** Builds the strip, the menu and the panels, and frames a page only once it is known to load. */
export class Tabs {
  private panels = new Map<string, HTMLElement>();
  private buttons = new Map<string, HTMLButtonElement>();
  private more = document.createElement("button");
  private moreLabel = document.createElement("span");
  private menu = document.createElement("div");
  /** The origin each framed tab loaded from; a server that moved reloads it. */
  private loaded = new Map<string, string>();
  private loading = new Set<string>();
  current = "";
  /** Called after a tab is selected. */
  onSelect: (id: string) => void = () => {};

  constructor(
    private strip: HTMLElement,
    private stage: HTMLElement,
    own: Map<string, HTMLElement>,
  ) {
    for (const tab of TABS) {
      const b = document.createElement("button");
      b.className = "tab";
      b.type = "button";
      b.textContent = tab.label;
      b.addEventListener("click", () => this.select(tab.id));
      this.strip.append(b);
      this.buttons.set(tab.id, b);
    }
    this.more.type = "button";
    this.more.className = "tab more";
    this.more.setAttribute("aria-label", "More pages");
    this.more.setAttribute("aria-haspopup", "menu");
    this.more.setAttribute("aria-expanded", "false");
    this.moreLabel.className = "more-label";
    this.more.append(this.moreLabel, dots());
    this.more.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });
    this.menu.className = "menu";
    this.menu.setAttribute("role", "menu");
    this.menu.hidden = true;
    for (const tab of MENU) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-item";
      item.setAttribute("role", "menuitem");
      item.textContent = tab.label;
      item.addEventListener("click", () => {
        this.toggleMenu(false);
        this.select(tab.id);
      });
      this.menu.append(item);
    }
    const wrap = document.createElement("div");
    wrap.className = "more-wrap";
    wrap.append(this.more, this.menu);
    this.strip.append(wrap);
    document.addEventListener("click", () => this.toggleMenu(false));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.menu.hidden) {
        this.toggleMenu(false);
        e.stopImmediatePropagation();
      }
    });

    for (const tab of [...TABS, ...MENU]) {
      const panel = own.get(tab.id) ?? document.createElement("section");
      panel.classList.add("panel");
      panel.hidden = true;
      if (!panel.parentElement) this.stage.append(panel);
      this.panels.set(tab.id, panel);
    }
  }

  private toggleMenu(open = this.menu.hidden): void {
    this.menu.hidden = !open;
    this.more.setAttribute("aria-expanded", String(open));
  }

  select(id: string): void {
    const tab = [...TABS, ...MENU].find((t) => t.id === id);
    if (!tab) return;
    this.current = id;
    for (const [tid, b] of this.buttons) b.classList.toggle("on", tid === id);
    const inMenu = MENU.some((t) => t.id === id);
    this.more.classList.toggle("on", inMenu);
    this.moreLabel.textContent = inMenu ? tab.label : "";
    for (const [tid, p] of this.panels) p.hidden = tid !== id;
    if (tab.path) void this.ensure(tab);
    this.onSelect(id);
  }

  /** Command-1 to Command-3 pick the views. */
  selectIndex(i: number): void {
    const tab = TABS[i];
    if (tab) this.select(tab.id);
  }

  /** Frame the tab's page unless it is loading or already framed from the live origin. */
  private async ensure(tab: Tab): Promise<void> {
    if (this.loading.has(tab.id)) return;
    const was = this.loaded.get(tab.id);
    if (was) {
      const server = await invoke<IntentServer>("intent_server");
      if (server.up && server.origin === was) return;
      this.loaded.delete(tab.id);
    }
    await this.load(tab);
  }

  private async load(tab: Tab): Promise<void> {
    if (this.loading.has(tab.id)) return;
    this.loading.add(tab.id);
    try {
      await this.loadOnce(tab);
    } finally {
      this.loading.delete(tab.id);
    }
  }

  private async loadOnce(tab: Tab): Promise<void> {
    const panel = this.panels.get(tab.id)!;
    note(panel, "Loading…");
    const server = await invoke<IntentServer>("intent_server");
    if (!server.up || !server.origin) {
      return this.down(tab, `The intent server is down: ${server.reason ?? "no answer"}.`);
    }
    let code = 0;
    try {
      code = await invoke<number>("intent_page", { path: tab.path });
    } catch (e) {
      return this.down(tab, `Couldn't ask the intent server: ${String(e)}.`);
    }
    if (code === 404) return this.down(tab, tab.missing ?? `The intent server has no ${tab.path}.`);
    if (code !== 200) return this.down(tab, `The intent server answered ${code} for ${tab.path}.`);
    const frame = document.createElement("iframe");
    frame.src = server.origin + tab.path;
    frame.title = tab.label;
    panel.replaceChildren(frame);
    this.loaded.set(tab.id, server.origin);
  }

  private down(tab: Tab, why: string): void {
    const panel = this.panels.get(tab.id)!;
    const box = note(panel, why);
    const retry = document.createElement("button");
    retry.className = "retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => void this.load(tab));
    box.append(retry);
  }
}

export function note(panel: HTMLElement, text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "note";
  const p = document.createElement("p");
  p.textContent = text;
  box.append(p);
  panel.replaceChildren(box);
  return box;
}
