// Plan families in the views: a parent plan and its children, kept together
// under one header, and a child waiting on its parent saying so.

/** views.rs FamilyMember / FamilyBrief. */
export type FamilyMember = {
  slug: string;
  role: string;
  phase: string;
  done: number;
  total: number;
  n: number;
  open: boolean;
  ws: string | null;
  waits: number[];
  ready: boolean;
};
export type FamilyBrief = { parent: string; members: FamilyMember[]; done: number; total: number };

/** The family a workspace works in, and which member it is. */
export function familyOf(fams: FamilyBrief[] | undefined, ws: string): { fam: FamilyBrief; member: FamilyMember } | undefined {
  for (const fam of fams ?? []) {
    const member = fam.members.find((m) => m.ws === ws);
    if (member) return { fam, member };
  }
  return undefined;
}

/** "waits on auth inc 2" (or incs 2, 3), or "" when it waits on nothing. */
export function waitText(fam: FamilyBrief, m: FamilyMember): string {
  if (!m.waits.length) return "";
  return `waits on ${fam.parent} inc${m.waits.length > 1 ? "s" : ""} ${m.waits.join(", ")}`;
}

/** What a member is doing, in a few words. */
export function memberState(fam: FamilyBrief, m: FamilyMember): string {
  if (m.phase === "done") return "done";
  const w = waitText(fam, m);
  if (w) return w;
  if (m.open) return `working inc ${m.n}/${m.total}`;
  if (m.ready) return `can go: inc ${m.n}`;
  return m.phase;
}

const SVG = "http://www.w3.org/2000/svg";

/** A small drawn tree: a parent node with two children. */
function mark(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "fam-mark");
  const add = (tag: string, attrs: Record<string, string>) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    svg.append(e);
  };
  add("path", { d: "M7 4v3M7 7H3.5v3M7 7h3.5v3", fill: "none", stroke: "currentColor", "stroke-width": "1.2" });
  add("circle", { cx: "7", cy: "3", r: "1.6" });
  add("circle", { cx: "3.5", cy: "11", r: "1.6" });
  add("circle", { cx: "10.5", cy: "11", r: "1.6" });
  return svg;
}

/** "family · auth · 1/3 done": the header a family's items sit under. */
export function header(fam: FamilyBrief, cls = "fam-head"): HTMLElement {
  const h = document.createElement("div");
  h.className = cls;
  const name = document.createElement("b");
  name.textContent = fam.parent;
  const roll = document.createElement("span");
  roll.className = "fam-roll";
  roll.textContent = `${fam.done}/${fam.total} done`;
  h.append(mark(), document.createTextNode("family "), name, roll);
  return h;
}

/** Items in their order, but a family's together where its first one falls. */
export function grouped<T>(items: T[], familyKey: (t: T) => string): { key: string; items: T[] }[] {
  const out: { key: string; items: T[] }[] = [];
  const at = new Map<string, number>();
  for (const t of items) {
    const k = familyKey(t);
    if (!k) {
      out.push({ key: "", items: [t] });
      continue;
    }
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push({ key: k, items: [t] });
    } else out[i].items.push(t);
  }
  return out;
}
