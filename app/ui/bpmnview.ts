// A BPMN diagram drawn in the app: the Wake's preview, a sheet tab, and the
// Dock (a pane's link to a .bpmn file). The XML comes from wake_file or
// link_file as a data: URL; bpmn-js (bpmn.io's viewer, pinned in
// package.json) draws it as SVG in the app's own DOM. The viewer only lays
// out shapes and sets label text, so the diagram runs no code of its own.
// Its script loads on first use, so pages with no diagram never pay for it.

import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";

/** The XML a `data:application/xml;base64,…` URL carries. */
export function xmlOf(data: string): string {
  const bin = atob(data.slice(data.indexOf(",") + 1));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

type Box = { x: number; y: number; width: number; height: number };
type Canvas = { zoom(to: "fit-viewport" | number, center?: "auto"): number; viewbox(to?: Box): Box };
type Viewer = {
  importXML(xml: string): Promise<{ warnings: unknown[] }>;
  get(name: "canvas"): Canvas;
  destroy(): void;
};

let load: Promise<new (o: object) => Viewer> | null = null;
function viewerClass(): Promise<new (o: object) => Viewer> {
  load ??= import("bpmn-js/lib/NavigatedViewer").then((m) => m.default as unknown as new (o: object) => Viewer);
  return load;
}

/** The app's colours, read now: the diagram follows light and dark. */
function colours(): { fill: string; stroke: string } {
  const css = getComputedStyle(document.documentElement);
  return {
    fill: css.getPropertyValue("--ef-bg").trim() || "#fdf6e3",
    stroke: css.getPropertyValue("--ef-fg").trim() || "#5c6a72",
  };
}

/** A viewer for `xml` in `box`, in the colours of now. bpmn-js bakes the
 *  colours into each shape, so a theme change needs a new viewer. */
async function viewerFor(box: HTMLElement, xml: string): Promise<Viewer> {
  const Viewer = await viewerClass();
  const { fill, stroke } = colours();
  const v = new Viewer({ container: box, bpmnRenderer: { defaultFillColor: fill, defaultStrokeColor: stroke, defaultLabelColor: stroke } });
  try {
    await v.importXML(xml);
  } catch (e) {
    v.destroy();
    throw new Error(e instanceof Error ? e.message.split("\n")[0] : String(e));
  }
  return v;
}

/** Draw `xml` into `host` (emptied first), fitted to it. Drag pans, the
 *  wheel scrolls, ⌘/ctrl-wheel zooms. Throws, with bpmn-js's reason, when
 *  the XML is not a diagram. A double-click fits it again. */
export async function drawBpmn(host: HTMLElement, xml: string): Promise<void> {
  const box = document.createElement("div");
  box.className = "bpmn-box";
  box.style.cssText = "width: 100%; height: 100%;";
  host.replaceChildren(box);
  let v: Viewer;
  try {
    v = await viewerFor(box, xml);
  } catch (e) {
    box.remove();
    throw e;
  }
  const fit = () => {
    try {
      v.get("canvas").zoom("fit-viewport", "auto");
    } catch {
      /* not laid out yet */
    }
  };
  fit();
  box.addEventListener("dblclick", fit);
  // The pane resizes (a splitter, full screen): fit again until the person zooms.
  let zoomed = false;
  box.addEventListener("wheel", (e) => (zoomed ||= e.ctrlKey || e.metaKey), { passive: true });
  const ro = new ResizeObserver(() => !zoomed && fit());
  ro.observe(box);
  // The app's appearance changes (its own setting, or the system's): draw
  // again in the new colours, at the place the reader had panned and zoomed to.
  let redraw = Promise.resolve();
  const recolour = () => {
    redraw = redraw.then(async () => {
      if (!box.isConnected) return;
      const at = v.get("canvas").viewbox();
      const next = await viewerFor(box, xml).catch(() => null);
      if (!next) return;
      // Taken off the page while it drew: the gone observer already let `v` go.
      if (!box.isConnected) return next.destroy();
      v.destroy();
      v = next;
      v.get("canvas").viewbox(at);
    });
  };
  const themeAttr = new MutationObserver(recolour);
  themeAttr.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  system.addEventListener("change", recolour);
  // Taken off the page (another pick, a closed tab): let the viewer go.
  const gone = new MutationObserver(() => {
    if (box.isConnected) return;
    ro.disconnect();
    gone.disconnect();
    themeAttr.disconnect();
    system.removeEventListener("change", recolour);
    v.destroy();
  });
  gone.observe(document.body, { childList: true, subtree: true });
}
