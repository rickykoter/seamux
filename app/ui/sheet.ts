import { invoke } from "@tauri-apps/api/core";

type IntentServer = { origin: string | null; up: boolean; reason: string | null };

/** An intent-server page: a plan, a review or an ask. */
export type Page = {
  /** /plan/<slug>, /review/<id> or /ask/<id>. */
  path: string;
  title: string;
  /** The cmux workspace it belongs to, for Open in cmux. */
  workspace?: string;
};

const SVG = "http://www.w3.org/2000/svg";

function mark(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  svg.append(p);
  return svg;
}

/** A sheet over the current view that frames one page; Escape closes it. */
export class Sheet {
  el = document.createElement("div");
  private card = document.createElement("div");
  private titleEl = document.createElement("span");
  private body = document.createElement("div");
  private say = document.createElement("span");
  private page: Page | null = null;

  constructor() {
    this.el.className = "sheet";
    this.el.hidden = true;
    this.card.className = "sheet-card";
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-modal", "true");
    const head = document.createElement("header");
    this.titleEl.className = "sheet-title";
    this.say.className = "sheet-say";
    const cmux = document.createElement("button");
    cmux.type = "button";
    cmux.className = "sheet-btn";
    cmux.title = "Open beside its terminal in cmux (⌘-click does this too)";
    cmux.append(document.createTextNode("Open in cmux "), mark("M3 7 7 3M4 3h3v3"));
    cmux.addEventListener("click", () => void this.toCmux());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "sheet-btn icon";
    close.setAttribute("aria-label", "Close");
    close.append(mark("M2.5 2.5l5 5M7.5 2.5l-5 5"));
    close.addEventListener("click", () => this.close());
    head.append(this.titleEl, this.say, cmux, close);
    this.body.className = "sheet-body";
    this.card.append(head, this.body);
    this.el.append(this.card);
    // A click on the dimmed backdrop closes; one inside the card does not.
    this.el.addEventListener("click", (e) => e.target === this.el && this.close());
    // Capture, so the window's own Escape (hide) waits for the sheet.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !this.el.hidden) {
          this.close();
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  async open(p: Page): Promise<void> {
    this.page = p;
    this.titleEl.textContent = p.title;
    this.say.textContent = "";
    this.el.hidden = false;
    const server = await invoke<IntentServer>("intent_server");
    if (this.page !== p) return;
    if (!server.up || !server.origin) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = `The intent server is down (${server.reason ?? "no answer"}), so this page can't be shown here. Open in cmux may still work once it is back.`;
      this.body.replaceChildren(n);
      return;
    }
    const frame = document.createElement("iframe");
    frame.src = server.origin + p.path;
    frame.title = p.title;
    this.body.replaceChildren(frame);
  }

  close(): void {
    this.el.hidden = true;
    this.page = null;
    this.body.replaceChildren();
  }

  private async toCmux(): Promise<void> {
    if (!this.page) return;
    try {
      await openInCmux(this.page);
      this.close();
    } catch (e) {
      this.say.textContent = String(e);
    }
  }
}

export function openInCmux(p: Page): Promise<void> {
  return invoke("open_in_cmux", { path: p.path, workspace: p.workspace ?? null });
}

let shared: Sheet | null = null;

/** The app's one sheet, made on first use and put over the stage. */
export function sheet(): Sheet {
  if (!shared) {
    shared = new Sheet();
    document.body.append(shared.el);
  }
  return shared;
}

/** Open a page: in the sheet, or in cmux on a ⌘-click. Returns an error to show, if any. */
export async function openPage(p: Page, e?: MouseEvent | KeyboardEvent): Promise<string | null> {
  if (e?.metaKey) {
    try {
      await openInCmux(p);
      return null;
    } catch (err) {
      return String(err);
    }
  }
  await sheet().open(p);
  return null;
}
