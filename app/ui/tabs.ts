import { invoke } from "@tauri-apps/api/core";

// The shapes of shell.rs's commands.
type IntentServer = { origin: string | null; up: boolean; reason: string | null };

/** A tab: the wall (the app's own page) or one unported intent-server page. */
export type Tab = {
  id: string;
  label: string;
  /** A path on crew-board-intent's origin; absent for the app's own pages. */
  path?: string;
  /** Said when the server is up but the page isn't served yet. */
  missing?: string;
};

export const TABS: Tab[] = [
  { id: "wall", label: "Wall" },
  { id: "wake", label: "Wake", path: "/artifacts" },
  { id: "usage", label: "Usage", path: "/usage" },
  {
    id: "board",
    label: "Board",
    path: "/board",
    missing: "The intent server doesn't serve the board yet; it arrives with the port-board plan.",
  },
];

/** Builds the strip and panels, and frames a page only once it is known to load. */
export class Tabs {
  private panels = new Map<string, HTMLElement>();
  private buttons = new Map<string, HTMLButtonElement>();
  /** The origin each framed tab loaded from; a server that moved reloads it. */
  private loaded = new Map<string, string>();
  private loading = new Set<string>();
  current = "";

  constructor(
    private strip: HTMLElement,
    private stage: HTMLElement,
    own: Map<string, HTMLElement>,
  ) {
    for (const tab of TABS) {
      const b = document.createElement("button");
      b.className = "tab";
      b.textContent = tab.label;
      b.addEventListener("click", () => this.select(tab.id));
      this.strip.append(b);
      this.buttons.set(tab.id, b);
      const panel = own.get(tab.id) ?? document.createElement("section");
      panel.classList.add("panel");
      panel.hidden = true;
      this.stage.append(panel);
      this.panels.set(tab.id, panel);
    }
  }

  select(id: string): void {
    const tab = TABS.find((t) => t.id === id);
    if (!tab) return;
    this.current = id;
    for (const [tid, b] of this.buttons) b.classList.toggle("on", tid === id);
    for (const [tid, p] of this.panels) p.hidden = tid !== id;
    if (tab.path) void this.ensure(tab);
  }

  /** Cycle with ⌘1…⌘4 from the shell. */
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

function note(panel: HTMLElement, text: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "note";
  const p = document.createElement("p");
  p.textContent = text;
  box.append(p);
  panel.replaceChildren(box);
  return box;
}
