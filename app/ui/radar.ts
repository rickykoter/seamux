import { invoke } from "@tauri-apps/api/core";

// The shape of radar_frame (crates/seamux-app/src/radar.rs).
type Planned = { path: string; plan: string; inc: number; title: string };
type Contact = {
  ws: string; pane: string; title: string; root: string; branch: string;
  color: string | null; state: string; editing: string[]; planned: Planned[];
};
/** `owners`: each file on the scope to its CODEOWNERS owners ([] when no rule names one); absent when the repo has no CODEOWNERS. */
type Repo = { name: string; common: string; contacts: Contact[]; collisions: string[]; owners?: Record<string, string[]> };
type Frame = { repos: Repo[] };

/** Who is on one file: each contact's index and whether it edits or plans it. */
type Mark = { c: number; editing: boolean; planned: Planned[] };
/** A file on the scope. `risk`: 2 two or more edit it now, 1 they meet in a plan, 0 one workspace alone. */
type FileDot = { path: string; wedge: string; a: number; r: number; marks: Mark[]; risk: 0 | 1 | 2 };
/** Two workspaces that share files, for the card's "who to talk to". */
type Pair = { a: number; b: number; files: string[]; now: number };
type Focus = { kind: "file" | "wedge" | "contact" | "team"; key: string };

const SVG = "http://www.w3.org/2000/svg";
/** One turn of the sweep, ms. */
const PERIOD = 8000;
/** How often the scope is read while the tab shows. */
const EVERY = 5000;
/** A collision counts as new (it throbs, and says "new") for this long after it first shows. */
const NEW_FOR = 90_000;
const R = 92;
/** Rings by risk: colliding now innermost, colliding in a plan next, lone files outermost. A crowded
 * wedge spreads a band's files over its rows, the outer rows first since they have the most room. */
const ROWS_NOW = [40, 30, 20], ROWS_PLAN = [60, 51], ROWS_LONE = [72, 84];
/** The room a collision needs along its row (star plus its tag), in scope units. */
const STAR_ROOM = 15;
/** Past this many files a lone file is a small quiet dot: the collisions are what matter. */
const BUSY = 60;
/** Rows the card shows before "Show all". */
const TALK_SHOWN = 5, PEOPLE_SHOWN = 6;
/** A folder with more collisions than this bundles them into one numbered marker until opened. */
const CLUSTER = 3;
/** Contact hues (oklch) when cmux gives none, spread apart and clear of the collision red (~25). */
const HUES = [240, 150, 300, 85, 200, 270, 120, 180, 330, 60, 135, 255];

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Makes `e` a keyboard button: focusable, Enter and Space act. */
function act(e: Element, label: string, fn: () => void): void {
  e.setAttribute("tabindex", "0");
  e.setAttribute("role", "button");
  if (label) e.setAttribute("aria-label", label);
  e.addEventListener("click", fn);
  e.addEventListener("keydown", (ev) => {
    const k = (ev as KeyboardEvent).key;
    if ((k === "Enter" || k === " ") && ev.target === e) {
      ev.preventDefault();
      ev.stopPropagation();
      fn();
    }
  });
}

/** A point at radius r, angle a degrees clockwise from twelve o'clock. */
function pt(r: number, a: number): [number, number] {
  const t = (a * Math.PI) / 180;
  return [r * Math.sin(t), -r * Math.cos(t)];
}

const wedgeOf = (p: string) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "·");
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** A path that may break after each slash. */
function pathText(p: string): HTMLSpanElement {
  const s = h("span", "radar-path");
  p.split("/").forEach((seg, k, all) => {
    s.append(document.createTextNode(seg + (k < all.length - 1 ? "/" : "")));
    if (k < all.length - 1) s.append(h("wbr"));
  });
  s.title = p;
  return s;
}

/** Every file of a repo with who is on it. */
function marksOf(repo: Repo): Map<string, Mark[]> {
  const files = new Map<string, Mark[]>();
  repo.contacts.forEach((c, i) => {
    const add = (path: string, editing: boolean, p?: Planned) => {
      if (!files.has(path)) files.set(path, []);
      const marks = files.get(path)!;
      let m = marks.find((x) => x.c === i);
      if (!m) marks.push((m = { c: i, editing: false, planned: [] }));
      if (editing) m.editing = true;
      if (p) m.planned.push(p);
    };
    for (const p of c.editing) add(p, true);
    for (const p of c.planned) add(p.path, false, p);
  });
  return files;
}

const riskOf = (marks: Mark[]): 0 | 1 | 2 => (marks.length < 2 ? 0 : marks.filter((m) => m.editing).length >= 2 ? 2 : 1);

/** Lay a repo's files out: a wedge per top folder, sized by its files with collisions weighted up, and a band per risk. */
/** The team that owns a path: its first CODEOWNERS owner, or "" for nobody. */
const teamOf = (repo: Repo, p: string) => repo.owners?.[p]?.[0] ?? "";
/** Team tints (oklch hues), apart from the collision red and quieter than the workspace colours. */
const TEAM_HUES = [215, 105, 295, 65, 165, 250, 135, 330];

/** A slice of a wedge one sub-group (a team, with the Islands overlay) holds. */
export type Sub = { wedge: string; key: string; a0: number; a1: number; n: number };

/** Lay a repo's files out: a wedge per `keyOf` group (a top folder, or a team), sized by its files
 * with collisions weighted up, and a band per risk. With `subOf`, each wedge splits further into one
 * contiguous slice per sub-group, so a team's files inside a folder sit together as one island. */
export function layout(repo: Repo, keyOf: (p: string) => string = wedgeOf, subOf?: (p: string) => string): { dots: FileDot[]; wedges: { name: string; a0: number; a1: number; n: number; hot: number }[]; subs: Sub[] } {
  const all = marksOf(repo);
  const by = new Map<string, string[]>();
  for (const p of all.keys()) {
    const w = keyOf(p);
    if (!by.has(w)) by.set(w, []);
    by.get(w)!.push(p);
  }
  const last = (a: string) => a === "·" || a === "";
  const order = (a: string, b: string) => (last(a) ? 1 : last(b) ? -1 : a.localeCompare(b));
  const names = [...by.keys()].sort(order);
  const weigh = (ps: string[]) => ps.reduce((s, p) => s + (riskOf(all.get(p)!) ? 8 : 1), 0);
  const total = names.reduce((s, n) => s + weigh(by.get(n)!), 0);
  const floor = names.length ? Math.min(20, 360 / names.length / 2) : 0;
  const spare = 360 - floor * names.length;
  const wedges: { name: string; a0: number; a1: number; n: number; hot: number }[] = [];
  const subs: Sub[] = [];
  const dots: FileDot[] = [];
  let a = 0;
  for (const name of names) {
    const paths = by.get(name)!.sort();
    const span = floor + (total ? (spare * weigh(paths)) / total : 0);
    // The wedge's slices: one per sub-group, sized by weight with a small floor so none vanishes.
    const groups = new Map<string, string[]>();
    for (const p of paths) {
      const k = subOf ? subOf(p) : "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    }
    const keys = [...groups.keys()].sort(order);
    const gFloor = Math.min(6, span / keys.length / 2);
    const gSpare = span - gFloor * keys.length;
    const gTotal = keys.reduce((s, k) => s + weigh(groups.get(k)!), 0);
    let g0 = a;
    for (const key of keys) {
      const list = groups.get(key)!;
      const gSpan = gFloor + (gTotal ? (gSpare * weigh(list)) / gTotal : 0);
      const pad = Math.min(subOf ? 2 : 4, gSpan / 6);
      const arc = ((gSpan - 2 * pad) * Math.PI) / 180;
      // Each band spreads across the whole slice. Files go on as few rows as fit, outer rows first;
      // with more than one row, neighbours alternate rows so no two sit side by side on one.
      const spread = (band: string[], rows: number[], room: number) => {
        let n = 1;
        while (n < rows.length && band.length * room > rows.slice(0, n).reduce((s, r) => s + arc * r, 0)) n++;
        band.forEach((path, k) => {
          const marks = all.get(path)!;
          dots.push({ path, wedge: name, a: g0 + pad + ((k + 0.5) / band.length) * (gSpan - 2 * pad), r: rows[k % n], marks, risk: riskOf(marks) });
        });
      };
      spread(list.filter((p) => riskOf(all.get(p)!) === 2), ROWS_NOW, STAR_ROOM);
      spread(list.filter((p) => riskOf(all.get(p)!) === 1), ROWS_PLAN, STAR_ROOM);
      spread(list.filter((p) => riskOf(all.get(p)!) === 0), ROWS_LONE, 99);
      subs.push({ wedge: name, key, a0: g0, a1: g0 + gSpan, n: list.length });
      g0 += gSpan;
    }
    wedges.push({ name, a0: a, a1: a + span, n: paths.length, hot: paths.filter((p) => riskOf(all.get(p)!) > 0).length });
    a += span;
  }
  return { dots, wedges, subs };
}

/** Pairs of workspaces that share a file, most urgent first. */
export function pairs(repo: Repo): Pair[] {
  const out = new Map<string, Pair>();
  for (const [path, marks] of marksOf(repo)) {
    if (marks.length < 2) continue;
    for (let x = 0; x < marks.length; x++)
      for (let y = x + 1; y < marks.length; y++) {
        const [a, b] = [marks[x].c, marks[y].c].sort((p, q) => p - q);
        const key = `${a}:${b}`;
        if (!out.has(key)) out.set(key, { a, b, files: [], now: 0 });
        const p = out.get(key)!;
        p.files.push(path);
        if (marks[x].editing && marks[y].editing) p.now++;
      }
  }
  // The pair to act on first: someone in it is waiting on you, then editing now, then most files.
  const waits = (p: Pair) => Number(repo.contacts[p.a].state === "needs_input" || repo.contacts[p.b].state === "needs_input");
  return [...out.values()].sort((p, q) => waits(q) - waits(p) || q.now - p.now || q.files.length - p.files.length || p.a - q.a || p.b - q.b);
}

/** One workspace's collisions, by partner. */
type Talk = { c: number; with: { other: number; files: string[]; now: number }[]; now: number };

/** The workspaces in a collision, each once, the one to talk to first at the top: someone waiting
 * on you, then the most files edited alongside another now, then the most shared files. */
export function people(repo: Repo, ps: Pair[]): Talk[] {
  const by = new Map<number, Talk>();
  const add = (c: number, other: number, p: Pair) => {
    if (!by.has(c)) by.set(c, { c, with: [], now: 0 });
    by.get(c)!.with.push({ other, files: p.files, now: p.now });
  };
  for (const p of ps) {
    add(p.a, p.b, p);
    add(p.b, p.a, p);
  }
  const all = marksOf(repo);
  for (const t of by.values()) {
    // Files this workspace edits while another edits them too: counted once however many partners.
    t.now = [...new Set(t.with.flatMap((w) => w.files))].filter((f) => {
      const m = all.get(f)!;
      return m.some((x) => x.c === t.c && x.editing) && m.filter((x) => x.editing).length >= 2;
    }).length;
    const waits = (i: number) => Number(repo.contacts[i].state === "needs_input");
    t.with.sort((p, q) => waits(q.other) - waits(p.other) || q.now - p.now || q.files.length - p.files.length || p.other - q.other);
  }
  const waits = (t: Talk) => Number(repo.contacts[t.c].state === "needs_input");
  const shared = (t: Talk) => new Set(t.with.flatMap((w) => w.files)).size;
  return [...by.values()].sort((p, q) => waits(q) - waits(p) || q.now - p.now || shared(q) - shared(p) || p.c - q.c);
}

/** The mascot: a small submarine with a periscope, drawn. */
function submarine(parent: Element, x: number, y: number, s: number): SVGGElement {
  const g = el("g", { class: "sub", transform: `translate(${x} ${y}) scale(${s})`, "aria-hidden": "true" }, parent);
  const bob = el("g", { class: "sub-bob" }, g);
  el("path", { class: "sub-hull", d: "M-18 2 Q-18 -6 -8 -6 L10 -6 Q20 -6 22 2 Q20 9 10 9 L-8 9 Q-18 9 -18 2 Z" }, bob);
  el("path", { class: "sub-hull", d: "M-4 -6 L-2 -12 L7 -12 L8 -6 Z" }, bob);
  el("path", { class: "sub-scope", d: "M3 -12 V-18 H7" }, bob);
  for (const cx of [-8, 0, 8]) el("circle", { class: "sub-port", cx, cy: 1.5, r: 2.2 }, bob);
  el("path", { class: "sub-hull", d: "M-18 2 L-24 -3 L-24 7 Z" }, bob);
  for (const [cx, cy, r] of [[-28, -2, 1.2], [-31, -7, 0.9], [-29, -12, 0.6]]) el("circle", { class: "sub-bubble", cx, cy, r }, g);
  return g;
}

/** A small scope drawn for the selected or a hot repo's chip. */
function miniScope(hot: boolean): SVGSVGElement {
  const s = el("svg", { viewBox: "-10 -10 20 20", class: "mini", "aria-hidden": "true" });
  el("circle", { r: 8.5, class: "mini-ring" }, s);
  el("circle", { r: 4.5, class: "mini-ring" }, s);
  el("path", { d: "M0 0 L0 -8.5 A8.5 8.5 0 0 1 6 -6 Z", class: "mini-sweep" }, s);
  if (hot) el("circle", { cx: 3, cy: 4, r: 1.8, class: "mini-hot" }, s);
  return s;
}

/** The collision mark as a small inline icon. */
function starIcon(): SVGSVGElement {
  const s = el("svg", { viewBox: "-6 -6 12 12", class: "radar-star-i", "aria-hidden": "true" });
  el("path", { d: star(5.5, 2.2), class: "radar-star" }, s);
  return s;
}

export class RadarView {
  /** Called with a workspace and pane to show in the Dock. */
  onJump: (ws: string, pane: string) => void = () => {};
  private frame: Frame = { repos: [] };
  private last = "";
  private repo = "";
  private timer: number | undefined;
  private t0 = performance.now();
  /** When each collision (repo + path) first showed; 0 for the first reading's, which are old news. */
  private since = new Map<string, number>();
  /** No reading with workspaces in it yet: the first one is the baseline, not news. */
  private first = true;
  /** A read is in flight (the next tick waits for it), and whether the tab is showing. */
  private reading = false;
  private shown = false;
  private failed = "";
  private retrying = false;
  /** What the side card shows: the overview, a file, a wedge or a contact. */
  private focus: Focus | null = null;
  private allTalk = false;
  private allPeople = false;
  private open = new Set<string>();
  private chips = h("div", "radar-repos");
  /** The CODEOWNERS overlay: off, islands drawn over the folder wedges, or wedges regrouped by team. */
  private owners: "off" | "folders" | "teams" = (() => {
    try { return (localStorage.getItem("radar.owners") as "off" | "folders" | "teams") || "off"; } catch { return "off"; }
  })();
  private tools = h("div", "radar-tools");
  private scope = h("div", "radar-scope");
  private card = h("aside", "radar-card");

  constructor(private root: HTMLElement) {
    const body = h("div", "radar-body");
    // The card comes first in the DOM, so Tab reaches "who to talk to" before the scope's marks.
    body.append(this.card, this.scope);
    this.tools.setAttribute("role", "toolbar");
    this.tools.setAttribute("aria-label", "Overlays");
    this.chips.setAttribute("role", "toolbar");
    this.chips.setAttribute("aria-label", "Repos");
    root.append(this.chips, this.tools, body);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.focus) {
        e.stopPropagation();
        this.pick(null);
      }
    });
  }

  setShown(on: boolean): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.shown = on;
    if (!on) return;
    void this.read();
    this.timer = window.setInterval(() => void this.read(), EVERY);
  }

  private async read(): Promise<void> {
    // A slow git pass must not stack up behind the next tick.
    if (this.reading) return;
    this.reading = true;
    let f: Frame;
    try {
      f = await invoke<Frame>("radar_frame");
    } catch (e) {
      this.reading = false;
      if (!this.shown) return;
      // The next good read must redraw even if it matches the last one.
      this.last = "";
      this.failed = String(e);
      this.retrying = false;
      this.draw();
      return;
    }
    this.reading = false;
    // A read that lands after the tab hid draws nothing; the next show reads again.
    if (!this.shown) return;
    const json = JSON.stringify(f);
    const was = this.failed;
    this.failed = "";
    this.retrying = false;
    const now = Date.now();
    // Same data: redraw only when a collision has just stopped being new.
    const aged = [...this.since.values()].some((t) => t && now - t >= NEW_FOR && now - t < NEW_FOR + EVERY);
    if (json === this.last && !was && !aged) return;
    this.last = json;
    this.frame = f;
    // When each collision first showed. One that has cleared is forgotten, so if it comes back it is new again.
    const live = new Set(f.repos.flatMap((r) => r.collisions.map((p) => r.common + "\0" + p)));
    for (const k of [...this.since.keys()]) if (!live.has(k)) this.since.delete(k);
    for (const k of live) if (!this.since.has(k)) this.since.set(k, this.first ? 0 : now);
    // The baseline is the first reading with workspaces in it: an empty frame before the wall has
    // one must not make everything after it look new.
    if (f.repos.length) this.first = false;
    if (!f.repos.some((r) => r.common === this.repo)) this.repo = f.repos[0]?.common ?? "";
    this.draw();
  }

  /** A collision that showed up in the last NEW_FOR ms (never one from the first reading). */
  private isNew(repo: Repo, path: string): boolean {
    const t = this.since.get(repo.common + "\0" + path) ?? 0;
    return t > 0 && Date.now() - t < NEW_FOR;
  }

  private current(): Repo | undefined {
    return this.frame.repos.find((r) => r.common === this.repo);
  }

  private colour(c: Contact, i: number): string {
    return c.color || `oklch(var(--radar-l) var(--radar-ch) ${HUES[i % HUES.length]})`;
  }

  /** What groups files into wedges: their top folder, or with the team layout their owning team. */
  private keyOf(repo: Repo): (p: string) => string {
    return this.owners === "teams" && repo.owners ? (p: string) => teamOf(repo, p) : wedgeOf;
  }

  /** Every team in the repo, in a stable order, with its tint. */
  private teams(repo: Repo): Map<string, string> {
    const names = [...new Set(Object.values(repo.owners ?? {}).map((o) => o[0]).filter(Boolean))].sort();
    return new Map(names.map((n, i) => [n, `oklch(var(--radar-isl-l) var(--radar-isl-ch) ${TEAM_HUES[i % TEAM_HUES.length]})`]));
  }

  private drawTools(repo: Repo | undefined): void {
    this.tools.replaceChildren();
    const has = !!repo?.owners;
    const seg = (mode: "off" | "folders" | "teams", label: string, tip: string) => {
      const b = h("button", "radar-tool", label);
      b.type = "button";
      b.title = has ? tip : "This repo has no CODEOWNERS file";
      b.disabled = !has && mode !== "off";
      b.setAttribute("aria-pressed", String(this.owners === mode));
      b.addEventListener("click", () => {
        this.owners = mode;
        try { localStorage.setItem("radar.owners", mode); } catch { /* per-viewer nicety only */ }
        this.focus = null;
        this.draw();
      });
      return b;
    };
    this.tools.append(h("span", "radar-tool-l", "Owners"),
      seg("off", "Off", "Hide CODEOWNERS teams"),
      seg("folders", "Islands", "Tint each team's files over the folder layout"),
      seg("teams", "By team", "Group the scope's wedges by owning team"));
  }

  private draw(): void {
    this.drawTools(this.current());
    this.drawChips();
    this.drawScope();
    this.drawCard();
  }

  private drawChips(): void {
    this.chips.replaceChildren();
    this.chips.hidden = this.frame.repos.length < 2;
    for (const r of this.frame.repos) {
      const b = h("button", "radar-repo");
      b.type = "button";
      const on = r.common === this.repo, hot = r.collisions.length > 0;
      b.classList.toggle("on", on);
      b.classList.toggle("hot", hot);
      b.setAttribute("aria-pressed", String(on));
      const say = `${r.name}: ${plural(r.contacts.length, "workspace")}, ${plural(r.collisions.length, "collision")}`;
      b.title = say;
      b.setAttribute("aria-label", say);
      if (on || hot) b.append(miniScope(hot));
      b.append(h("span", "radar-repo-name", r.name), h("span", "radar-repo-n", String(r.contacts.length)));
      if (hot) {
        const n = h("span", "radar-repo-hot");
        n.append(starIcon(), document.createTextNode(String(r.collisions.length)));
        b.append(n);
      }
      b.addEventListener("click", () => {
        this.repo = r.common;
        this.focus = null;
        this.allTalk = this.allPeople = false;
        this.open.clear();
        this.draw();
      });
      this.chips.append(b);
    }
  }

  private drawScope(): void {
    const repo = this.current();
    const narrow = this.root.clientWidth > 0 && this.root.clientWidth < 520;
    const svg = el("svg", { viewBox: narrow ? "-150 -112 300 224" : "-134 -116 268 232", class: "radar-svg", role: "img" });
    svg.setAttribute("aria-label", repo ? `${repo.name}: ${plural(repo.contacts.length, "workspace")}, ${plural(repo.collisions.length, "collision")}` : "No workspaces");
    const defs = el("defs", {}, svg);
    const grad = el("linearGradient", { id: "radar-sweep-g", x1: "0", y1: "0", x2: "1", y2: "0" }, defs);
    el("stop", { offset: "0", "stop-color": "var(--radar-line)", "stop-opacity": "0" }, grad);
    el("stop", { offset: "1", "stop-color": "var(--radar-line)", "stop-opacity": "0.35" }, grad);

    const live = !!repo && repo.contacts.length > 0;
    el("circle", { r: R, class: "radar-ground" }, svg);
    const cut1 = (ROWS_NOW[0] + ROWS_PLAN[1]) / 2, cut2 = (ROWS_PLAN[0] + ROWS_LONE[0]) / 2;
    if (live && repo.collisions.length) {
      el("circle", { r: cut2, class: "radar-zone" }, svg);
      el("circle", { r: cut1, class: "radar-zone" }, svg);
    }
    for (const r of [cut1, cut2]) el("circle", { r, class: "radar-ring" }, svg);
    el("circle", { r: R, class: "radar-rim" }, svg);
    for (let a = 0; a < 360; a += 10) {
      const [x1, y1] = pt(R, a), [x2, y2] = pt(R + (a % 30 ? 2 : 4), a);
      el("line", { x1, y1, x2, y2, class: "radar-tick" }, svg);
    }

    // The sweep: a trailing wedge and its leading edge, turning once a PERIOD.
    const phase = ((performance.now() - this.t0) % PERIOD) / PERIOD;
    // The sweep runs only while there is something live to scan, and goes quiet when crowded.
    const sweep = el("g", { class: live && !this.failed ? "radar-sweep" : "radar-sweep off" }, svg);
    sweep.style.animationDelay = `${-phase * PERIOD}ms`;
    const [ex, ey] = pt(R, 0), [sx, sy] = pt(R, -30);
    el("path", { d: `M0 0 L${sx} ${sy} A${R} ${R} 0 0 1 ${ex} ${ey} Z`, class: "radar-trail" }, sweep);
    el("line", { x1: 0, y1: 0, x2: ex, y2: ey, class: "radar-beam" }, sweep);

    const parts: Element[] = [];
    if (this.failed) {
      // In the flow above the scope, so it never covers what it says is stale.
      const f = h("div", "radar-error");
      f.setAttribute("role", "alert");
      const retry = h("button", "radar-jump", this.retrying ? "Retrying…" : "Retry now");
      retry.type = "button";
      retry.disabled = this.retrying;
      retry.addEventListener("click", () => {
        this.retrying = true;
        retry.textContent = "Retrying…";
        retry.disabled = true;
        void this.read();
      });
      const msg = h("span", "radar-error-msg");
      msg.append(h("strong", "", "Couldn't read the workspaces."), document.createTextNode(` Trying again every ${EVERY / 1000}s.`));
      msg.title = this.failed;
      f.append(msg, retry);
      parts.push(f);
    }
    this.scope.classList.toggle("stale", !!this.failed);

    if (!live) {
      submarine(svg, 0, -6, 1.6).classList.add("idle");
      el("text", { x: 0, y: 34, class: "radar-empty" }, svg).textContent = this.failed ? "No reading yet" : "Nothing on the scope";
      this.scope.replaceChildren(...parts, svg);
      return;
    }

    const own = this.owners !== "off" && !!repo.owners;
    const tints = this.teams(repo);
    // Islands: folder wedges, each split into one slice per owning team. By team: the wedges are the teams.
    const { dots, wedges, subs } = layout(repo, this.keyOf(repo), own && this.owners === "folders" ? (p) => teamOf(repo, p) : undefined);
    const busy = dots.length > BUSY;
    if (busy) sweep.classList.add("quiet");
    for (const w of wedges) {
      if (wedges.length > 1) {
        const [x, y] = pt(R, w.a0);
        el("line", { x1: 0, y1: 0, x2: x, y2: y, class: "radar-spoke" }, svg);
      }
      const mid = wedges.length > 1 ? (w.a0 + w.a1) / 2 : 0;
      const [lx, ly] = pt(narrow ? R + 6 : R + 9, mid);
      const anchor = Math.abs(lx) < 12 ? "middle" : lx > 0 ? "start" : "end";
      const full = w.name === "·" ? "top level" : w.name === "" ? "no owner" : w.name;
      const max = narrow ? 8 : 16;
      const t = el("text", { x: lx, y: ly + 2.5, "text-anchor": anchor, class: "radar-label" }, svg);
      t.textContent = full.length > max ? full.slice(0, max - 1) + "…" : full;
      if (w.hot) t.classList.add("hot");
      el("title", {}, t).textContent = `${full}: ${plural(w.n, "file")}${w.hot ? `, ${plural(w.hot, "collision")}` : ""}`;
      t.classList.toggle("on", this.focus?.kind === "wedge" && this.focus.key === w.name);
      act(t, `${full} folder: ${plural(w.n, "file")}, ${plural(w.hot, "collision")}`, () => this.pick({ kind: "wedge", key: w.name }));
      // Islands: the folder's owning teams on a second line under its name, each in its tint.
      if (own && this.owners === "folders") {
        const ts = subs.filter((u) => u.wedge === w.name && u.key).map((u) => u.key);
        if (ts.length) {
          const tl = el("text", { x: lx, y: ly + (narrow ? 10 : 8.5), "text-anchor": anchor, class: "radar-label-teams" }, svg);
          ts.slice(0, 2).forEach((team, k) => {
            if (k) el("tspan", {}, tl).textContent = " ";
            const sp = el("tspan", {}, tl);
            sp.textContent = team;
            sp.style.setProperty("--t", tints.get(team)!);
          });
          if (ts.length > 2) el("tspan", { class: "radar-who-sep" }, tl).textContent = ` +${ts.length - 2}`;
        }
      }
    }

    // Ownership islands sit under everything else: a run of neighbouring files one team owns,
    // from the hub out to the rim, tinted in the team's colour with a dashed coast.
    if (own) {
      const isl = el("g", { class: "radar-islands" }, svg);
      const runs = this.owners === "teams" ? wedges.map((w) => ({ key: w.name, a0: w.a0, a1: w.a1, n: w.n })) : subs;
      for (const r of runs) {
        if (!r.key) continue;
        const g = el("path", { d: sector(6, R - 2, r.a0 + 0.5, r.a1 - 0.5), class: "radar-island" }, isl);
        g.style.setProperty("--t", tints.get(r.key)!);
        g.dataset.team = r.key;
        el("title", {}, g).textContent = `${r.key}: ${plural(r.n, "file")} here`;
      }
    }

    const blips = el("g", { class: busy ? "radar-blips busy" : "radar-blips" }, svg);
    // An open folder card keeps that folder lit and the rest dim.
    if (this.focus?.kind === "wedge") blips.classList.add("dim");
    // Lone files first, so collisions always draw on top.
    const order = [...dots].sort((p, q) => p.risk - q.risk);
    // Where stars and tags already sit, so a tag can step clear of them.
    const stars = dots.filter((d) => d.risk).map((d) => pt(d.r, d.a));
    const tags: [number, number, number][] = [];
    const clear = (x: number, y: number, w: number, self: [number, number]) =>
      stars.every(([sx, sy]) => (sx === self[0] && sy === self[1]) || Math.abs(sx - (x + w / 2)) > w / 2 + 5 || Math.abs(sy - y) > 6) &&
      tags.every(([tx, ty, tw]) => x + w < tx - 1 || x > tx + tw + 1 || Math.abs(ty - y) > 5.5);
    // Folders with many collisions bundle them: one numbered marker, opened on hover, on focus,
    // by a card row that lights files inside, or by the folder's own card.
    const clusters = new Map<string, SVGGElement>();
    const hotIn = (w: string) => dots.filter((d) => d.wedge === w && d.risk);
    for (const w of wedges) {
      const hot = hotIn(w.name);
      if (hot.length <= CLUSTER) continue;
      const wrap = el("g", { class: "radar-cluster" });
      wrap.dataset.wedge = w.name;
      if (this.focus?.kind === "wedge" && this.focus.key === w.name) wrap.classList.add("open", "held");
      if (this.focus?.kind === "file" && hot.some((d) => d.path === this.focus!.key)) wrap.classList.add("open", "held");
      clusters.set(w.name, wrap);
    }
    const parentOf = (d: FileDot): SVGGElement => (d.risk && clusters.get(d.wedge)?.querySelector<SVGGElement>(".radar-cluster-files")) || blips;
    let placed = false;
    for (const d of order) {
      if (d.risk && !placed) {
        // Bundles draw above lone files, below nothing: their files sit inside them.
        for (const [name, wrap] of clusters) {
          blips.append(wrap);
          this.clusterBadge(wrap, repo, name, hotIn(name), wedges.find((w) => w.name === name)!, (x, y, w) => tags.push([x, y, w]));
          el("g", { class: "radar-cluster-files" }, wrap);
        }
        placed = true;
      }
      const [x, y] = pt(d.r, d.a);
      const g = el("g", { class: "radar-file", transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` }, parentOf(d));
      g.dataset.path = d.path;
      g.dataset.who = d.marks.map((m) => m.c).join(",");
      g.classList.toggle("on", this.focus?.kind === "file" && this.focus.key === d.path);
      if (this.focus?.kind === "wedge" && d.wedge === this.focus.key) g.classList.add("lit");
      const delay = ((((d.a / 360 - phase) % 1) + 1) % 1) * PERIOD - PERIOD;
      g.style.setProperty("--flash", `${delay}ms`);
      const who = d.marks.map((m) => `${letter(m.c)} ${repo.contacts[m.c].title} ${m.editing ? "editing" : "planned"}`).join(", ");
      el("title", {}, g).textContent = `${d.path}\n${who}`;
      if (d.risk) {
        g.classList.add("hot", d.risk === 2 ? "now" : "later");
        // Only a new collision moves: a ripple when it lands, then a throb until it is no longer new.
        if (this.isNew(repo, d.path)) {
          g.classList.add("new");
          el("circle", { r: 4, class: "radar-ping" }, g);
          el("circle", { r: 6.5, class: "radar-pulse" }, g);
        }
        el("path", { d: star(5.4, 2.2), class: "radar-star" }, g);
      }
      const m = d.marks.length;
      d.marks.forEach((mk, k) => {
        // Blips fan out around the star on the side away from the hub.
        const [ox, oy] = m > 1 ? pt(6.8, d.a + (k - (m - 1) / 2) * (m > 3 ? 50 : 70)) : [0, 0];
        const c = repo.contacts[mk.c];
        const small = busy && !d.risk;
        const b = el("circle", { cx: ox.toFixed(2), cy: oy.toFixed(2), r: small ? 1.4 : mk.editing ? 2.2 : 2.3, class: mk.editing ? "radar-blip" : "radar-blip planned" }, g);
        b.style.setProperty("--c", this.colour(c, mk.c));
      });
      if (d.risk) {
        // One tag per collision naming who is on it ("A·J"): outward first, then around the
        // star, then further out, wherever it clears other stars and tags; a leader line ties it back.
        const w = (d.marks.length * 2 - 1) * 2.9;
        let tx = 0, ty = 0, found = false;
        for (const dist of [12, 17, 22]) {
          for (const turn of [0, 70, -70, 140, -140, 180]) {
            const [ux, uy] = pt(dist, d.a + turn);
            const left = ux > 2 ? ux : ux < -2 ? ux - w : ux - w / 2;
            if (clear(x + left, y + uy, w, [x, y])) {
              [tx, ty, found] = [ux, uy, true];
              break;
            }
          }
          if (found) break;
        }
        if (!found) [tx, ty] = pt(12, d.a);
        const left = tx > 2 ? tx : tx < -2 ? tx - w : tx - w / 2;
        tags.push([x + left, y + ty, w]);
        if (Math.hypot(tx, ty) > 13) el("line", { x1: (tx * 0.45).toFixed(2), y1: (ty * 0.45).toFixed(2), x2: (tx * 0.8).toFixed(2), y2: (ty * 0.8).toFixed(2), class: "radar-leader" }, g);
        const t = el("text", { x: tx.toFixed(2), y: (ty + 1.6).toFixed(2), class: "radar-who-l" }, g);
        t.setAttribute("text-anchor", tx > 2 ? "start" : tx < -2 ? "end" : "middle");
        d.marks.forEach((mk, k) => {
          if (k) el("tspan", { class: "radar-who-sep" }, t).textContent = "·";
          const s = el("tspan", {}, t);
          s.textContent = letter(mk.c);
          s.style.setProperty("--c", this.colour(repo.contacts[mk.c], mk.c));
        });
      }
      el("circle", { r: d.risk ? 9 : 5, class: "radar-hit" }, g);
      if (d.risk) act(g, `${d.path}: ${who}`, () => this.pick({ kind: "file", key: d.path }));
      else g.addEventListener("click", () => this.pick({ kind: "file", key: d.path }));
    }

    el("circle", { r: 2.5, class: "radar-hub" }, svg);
    // All clear: the submarine cruises the middle of the scope and says so.
    if (!repo.collisions.length) {
      submarine(svg, 0, -4, 0.9);
      el("text", { x: 0, y: 16, class: "radar-clear" }, svg).textContent = "all clear";
    }
    this.scope.replaceChildren(...parts, svg);
  }

  /** A folder's bundle of collisions: a numbered marker at the folder's middle with who is in it. */
  private clusterBadge(wrap: SVGGElement, repo: Repo, name: string, hot: FileDot[], w: { a0: number; a1: number }, reserve: (x: number, y: number, w: number) => void): void {
    const mid = (w.a0 + w.a1) / 2;
    const r = hot.reduce((s, d) => s + d.r, 0) / hot.length;
    const [x, y] = pt(r, mid);
    const now = hot.some((d) => d.risk === 2);
    const who = [...new Set(hot.flatMap((d) => d.marks.map((m) => m.c)))].sort((p, q) => p - q);
    const full = name === "·" ? "top level" : name;
    const b = el("g", { class: now ? "radar-cluster-badge now" : "radar-cluster-badge", transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` }, wrap);
    if (hot.some((d) => this.isNew(repo, d.path))) {
      el("circle", { r: 7, class: "radar-ping" }, b);
      el("circle", { r: 10, class: "radar-pulse" }, b);
    }
    el("path", { d: star(10, 4.2), class: "radar-star" }, b);
    el("text", { x: 0, y: 2.3, class: "radar-cluster-n" }, b).textContent = String(hot.length);
    // Who is in the bundle, outward from the hub: up to five letters, then "+N".
    const shown = who.slice(0, 5);
    const [tx, ty] = pt(16, mid);
    const t = el("text", { x: tx.toFixed(2), y: (ty + 1.6).toFixed(2), class: "radar-who-l" }, b);
    t.setAttribute("text-anchor", tx > 2 ? "start" : tx < -2 ? "end" : "middle");
    shown.forEach((c, k) => {
      if (k) el("tspan", { class: "radar-who-sep" }, t).textContent = " ";
      const s = el("tspan", {}, t);
      s.textContent = letter(c);
      s.style.setProperty("--c", this.colour(repo.contacts[c], c));
    });
    if (who.length > shown.length) el("tspan", { class: "radar-who-sep" }, t).textContent = ` +${who.length - shown.length}`;
    const tw = (shown.length * 2 - 1) * 2.9 + (who.length > shown.length ? 9 : 0);
    reserve(x + (tx > 2 ? tx : tx < -2 ? tx - tw : tx - tw / 2), y + ty, tw);
    el("title", {}, b).textContent = `${full}: ${plural(hot.length, "collision")} between ${who.map((c) => `${letter(c)} ${repo.contacts[c].title}`).join(", ")}. Hover to open, click for the folder.`;
    el("circle", { r: 12, class: "radar-hit" }, b);
    act(b, `${full}: ${plural(hot.length, "collision")} between ${plural(who.length, "workspace")}. Open the folder`, () => this.pick({ kind: "wedge", key: name }));
    const set = (on: boolean) => wrap.classList.toggle("open", on || wrap.classList.contains("held") || !!wrap.querySelector(".radar-file.lit"));
    wrap.addEventListener("mouseenter", () => set(true));
    wrap.addEventListener("mouseleave", () => set(false));
    wrap.addEventListener("focusin", () => set(true));
    wrap.addEventListener("focusout", (e) => set(wrap.contains((e as FocusEvent).relatedTarget as Node)));
  }

  private pick(f: Focus | null): void {
    this.focus = f && this.focus?.kind === f.kind && this.focus.key === f.key ? null : f;
    this.drawScope();
    this.drawCard();
    this.card.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }

  /** Lights some contacts' files, or some files, on the scope and dims the rest, without redrawing. */
  private light(who: number[] | null, paths?: string[]): void {
    const blips = this.scope.querySelector(".radar-blips");
    if (!blips) return;
    const any = who !== null || paths !== undefined;
    // Leaving a row while a folder card is open goes back to that folder's own lighting.
    if (!any && this.focus?.kind === "wedge") return void this.drawScope();
    blips.classList.toggle("dim", any);
    for (const g of blips.querySelectorAll<SVGGElement>(".radar-file")) {
      const on = paths ? paths.includes(g.dataset.path ?? "") : !!who && (g.dataset.who ?? "").split(",").some((c) => who.includes(Number(c)));
      g.classList.toggle("lit", any && on);
    }
    for (const i of this.scope.querySelectorAll<SVGPathElement>(".radar-island")) i.classList.toggle("lit", any && !!paths && [...blips.querySelectorAll<SVGGElement>(".radar-file.lit")].some((g) => teamOf(this.current()!, g.dataset.path ?? "") === i.dataset.team));
    // A bundle opens while a row lights files inside it, so the lit files are visible.
    for (const c of blips.querySelectorAll<SVGGElement>(".radar-cluster"))
      c.classList.toggle("open", c.classList.contains("held") || !!c.querySelector(".radar-file.lit"));
  }

  private hover(e: HTMLElement, who: number[] | null, paths?: string[]): void {
    e.addEventListener("mouseenter", () => this.light(who, paths));
    e.addEventListener("mouseleave", () => this.light(null));
    e.addEventListener("focus", () => this.light(who, paths));
    e.addEventListener("blur", () => this.light(null));
  }

  private jumpButton(c: Contact, label = "Open in Dock", cls = "radar-jump"): HTMLButtonElement {
    const b = h("button", cls, label);
    b.type = "button";
    b.title = `Show ${c.title} in the Dock`;
    b.setAttribute("aria-label", `Open ${c.title} in the Dock`);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onJump(c.ws, c.pane);
    });
    b.addEventListener("keydown", (e) => e.stopPropagation());
    return b;
  }

  /** A workspace's badge: its colour with its letter, hollow when it only plans the file. */
  private badge(i: number, planned = false): HTMLSpanElement {
    const c = this.current()!.contacts[i];
    const s = h("span", planned ? "radar-sw planned" : "radar-sw", letter(i));
    s.style.setProperty("--c", this.colour(c, i));
    s.title = `${c.title}${planned ? " (planned)" : ""}`;
    s.setAttribute("aria-hidden", "true");
    return s;
  }

  private row(cls: string, label: string, fn: () => void): HTMLLIElement {
    const li = h("li", "radar-row " + cls);
    act(li, label, fn);
    return li;
  }

  private showMore(n: number, shown: number, all: boolean, word: string, flip: () => void): HTMLButtonElement | null {
    if (n <= shown) return null;
    const more = h("button", "radar-more", all ? "Show fewer" : `Show all ${n} ${word}`);
    more.type = "button";
    more.addEventListener("click", () => {
      flip();
      this.drawCard();
    });
    return more;
  }

  private drawCard(): void {
    const repo = this.current();
    this.card.replaceChildren();
    if (!repo) {
      const h2 = h("h2", "", "Radar");
      h2.tabIndex = -1;
      this.card.append(
        h2,
        h("p", "radar-dim", this.failed
          ? "No reading yet. The scope fills in once the workspaces can be read."
          : "No workspaces are open in a git repo. Open one in the Dock and it shows up here. Tucked-away workspaces stay off the scope."),
      );
      return;
    }
    if (this.focus) {
      const back = h("button", "radar-back", "‹ Overview");
      back.type = "button";
      back.title = "Back to the overview (Esc)";
      back.addEventListener("click", () => this.pick(null));
      this.card.append(back);
      if (this.focus.kind === "file") this.fileCard(repo, this.focus.key);
      else if (this.focus.kind === "wedge") this.wedgeCard(repo, this.focus.key);
      else if (this.focus.kind === "team") this.teamCard(repo, this.focus.key);
      else this.contactCard(repo, repo.contacts.findIndex((c) => c.ws === this.focus!.key));
      return;
    }
    const files = marksOf(repo);
    const ps = pairs(repo);
    const talk = people(repo, ps);
    const h2 = h("h2", "", repo.name);
    h2.tabIndex = -1;
    this.card.append(h2, h("p", "radar-dim", `${plural(repo.contacts.length, "workspace")} · ${plural(files.size, "file")}`));
    // The one line a glance needs: how bad, and who is waiting.
    const nowPairs = ps.filter((p) => p.now).length;
    const waiting = repo.contacts.filter((c) => c.state === "needs_input").length;
    const status = h("p", "radar-status");
    if (!repo.collisions.length) status.append(h("span", "radar-ok", "All clear: no two workspaces share a file."));
    else {
      // One unit leads, workspaces, so this line and "Show all N workspaces" agree.
      const later = ps.length - nowPairs;
      status.append(h("span", nowPairs ? "radar-bad" : "radar-warn", `${plural(talk.length, "workspace")} share files`));
      status.append(document.createTextNode(`: ${nowPairs ? `${plural(nowPairs, "pair")} editing the same file now` : ""}${nowPairs && later ? ", " : ""}${later ? `${plural(later, "pair")} meet${later === 1 ? "s" : ""} a plan` : ""}`));
    }
    if (waiting) status.append(document.createTextNode(" · "), h("span", "radar-ask-t", `${waiting} need${waiting === 1 ? "s" : ""} you`));
    this.card.append(status);

    if (talk.length) {
      const head = h("h3", "radar-hot-h");
      head.append(starIcon(), document.createTextNode(" Who to talk to"));
      this.card.append(head);
      const ul = h("ul", "radar-list");
      for (const t of this.allTalk ? talk : talk.slice(0, TALK_SHOWN)) ul.append(this.personRow(repo, t, files));
      this.card.append(ul);
      const more = this.showMore(talk.length, TALK_SHOWN, this.allTalk, "workspaces", () => (this.allTalk = !this.allTalk));
      if (more) this.card.append(more);
    }

    if (this.owners !== "off" && repo.owners) this.card.append(...this.teamSection(repo, files));

    // Everyone else, once: the workspaces that share nothing.
    const sharing = new Set(talk.map((t) => t.c));
    const rest = repo.contacts.map((_, i) => i).filter((i) => !sharing.has(i)).sort((x, y) =>
      Number(repo.contacts[y].state === "needs_input") - Number(repo.contacts[x].state === "needs_input") || x - y);
    if (rest.length) {
      this.card.append(h("h3", "", talk.length ? "Working alone" : "Workspaces"));
      const ul = h("ul", "radar-list key");
      for (const i of this.allPeople ? rest : rest.slice(0, PEOPLE_SHOWN)) {
        const c = repo.contacts[i];
        const li = this.row("contact", `${letter(i)}: ${c.title}, ${c.branch}`, () => this.pick({ kind: "contact", key: c.ws }));
        const top = h("div", "radar-row-top");
        const name = h("span", "radar-name", c.title);
        name.title = `${c.title} · ${c.branch} · ${c.editing.length} editing · ${c.planned.length} planned`;
        top.append(this.badge(i), name);
        if (c.state === "needs_input") top.append(h("span", "radar-ask", "needs you"));
        top.append(h("span", "radar-count", plural(c.editing.length + c.planned.length, "file")));
        li.append(top);
        this.hover(li, [i]);
        ul.append(li);
      }
      this.card.append(ul);
      const more = this.showMore(rest.length, PEOPLE_SHOWN, this.allPeople, "workspaces", () => (this.allPeople = !this.allPeople));
      if (more) this.card.append(more);
    }
    this.card.append(this.legend(repo.collisions.length > 0));
  }

  /** One workspace to talk to: who it collides with, how urgent, a jump to it, and each partner's files on demand. */
  private personRow(repo: Repo, t: Talk, files: Map<string, Mark[]>): HTMLLIElement {
    const c = repo.contacts[t.c];
    // Keyed by workspace id, not list position: a refresh that reorders workspaces keeps it open.
    const key = c.ws;
    const opened = this.open.has(key);
    const all = [...new Set(t.with.flatMap((p) => p.files))];
    const isNew = all.some((f) => this.isNew(repo, f));
    const li = this.row("person" + (t.now ? " now" : ""), `${c.title}: shares files with ${t.with.map((p) => repo.contacts[p.other].title).join(", ")}${opened ? ", expanded" : ""}`, () => {
      if (opened) this.open.delete(key);
      else this.open.add(key);
      this.drawCard();
    });
    li.setAttribute("aria-expanded", String(opened));
    const top = h("div", "radar-row-top");
    const name = h("span", "radar-name", c.title);
    name.title = `${c.title} · ${c.branch}`;
    top.append(this.badge(t.c), name);
    if (c.state === "needs_input") top.append(h("span", "radar-ask", "needs you"));
    const open = this.jumpButton(c, "Open", "radar-open");
    if (c.state === "needs_input") open.classList.add("keep");
    top.append(open);
    // Who it collides with, by badge: the first four, then "+N".
    const withRow = h("div", "radar-with");
    const caret = h("span", "radar-caret", opened ? "▾" : "▸");
    caret.setAttribute("aria-hidden", "true");
    withRow.append(caret, h("span", "radar-with-l", "with"));
    for (const p of t.with.slice(0, 4)) {
      const b = this.badge(p.other);
      if (repo.contacts[p.other].state === "needs_input") b.classList.add("waits");
      withRow.append(b);
    }
    if (t.with.length > 4) withRow.append(h("span", "radar-with-l", `+${t.with.length - 4}`));
    const first = repo.contacts[t.with[0].other];
    withRow.append(h("span", "radar-with-name", t.with.length === 1 ? first.title : `${first.title} and ${plural(t.with.length - 1, "other")}`));
    const meta = h("div", "radar-meta");
    if (t.now) meta.append(h("span", "radar-tag now", `${plural(t.now, "file")} editing now`));
    if (all.length > t.now) meta.append(h("span", "radar-tag", `${all.length - t.now} in plans`));
    if (isNew) meta.append(h("span", "radar-tag new", "new"));
    li.append(top, withRow, meta);
    if (this.owners !== "off" && repo.owners) {
      // The teams whose code this workspace touches: who else to bring in.
      const ts = [...new Set([...c.editing, ...c.planned.map((p) => p.path)].map((p) => teamOf(repo, p)).filter(Boolean))].sort();
      if (ts.length) {
        const tl = h("div", "radar-teams-of");
        tl.append(h("span", "radar-with-l", "touches"));
        for (const t of ts.slice(0, 3)) tl.append(this.teamChip(repo, t));
        if (ts.length > 3) tl.append(h("span", "radar-with-l", `+${ts.length - 3}`));
        li.append(tl);
      }
    }
    this.hover(li, null, all);
    if (opened) {
      const fl = h("ul", "radar-list sub");
      for (const p of t.with) {
        const o = repo.contacts[p.other];
        const pr = h("li", "radar-partner");
        const head = h("div", "radar-row-top");
        const n = h("span", "radar-name", o.title);
        n.title = o.title;
        head.append(this.badge(p.other), n);
        if (o.state === "needs_input") head.append(h("span", "radar-ask", "needs you"));
        head.append(this.jumpButton(o, "Open", "radar-open keep"));
        pr.append(head);
        this.hover(pr, null, p.files);
        const ful = h("ul", "radar-list");
        for (const f of p.files) {
          const fr = this.row("file", f, () => this.pick({ kind: "file", key: f }));
          const w = h("span", "radar-who");
          for (const m of files.get(f)!) w.append(this.badge(m.c, !m.editing));
          fr.append(pathText(f), w);
          this.hover(fr, null, [f]);
          fr.addEventListener("click", (e) => e.stopPropagation());
          ful.append(fr);
        }
        pr.append(ful);
        pr.addEventListener("click", (e) => e.stopPropagation());
        fl.append(pr);
      }
      li.append(fl);
    }
    return li;
  }

  private legend(hot: boolean): HTMLElement {
    const d = h("details", "radar-legend");
    const ed = h("span", "radar-sw dot"), pl = h("span", "radar-sw dot planned");
    for (const x of [ed, pl]) x.style.setProperty("--c", "var(--muted)");
    const item = (mark: Element, text: string) => {
      const i = h("span", "radar-legend-i");
      i.append(mark, document.createTextNode(text));
      return i;
    };
    const row = h("div", "radar-legend-row");
    const hollow = starIcon();
    hollow.classList.add("later");
    row.append(item(ed, "editing"), item(pl, "planned"), item(starIcon(), "both editing"), item(hollow, "meets a plan"));
    d.append(h("summary", "", "Key"), row,
      h("p", "radar-legend-note", "Center: files two workspaces edit now. Middle band: one edits, another plans to. Outer band: files only one workspace touches. Letters name the workspaces."));
    d.open = hot;
    return d;
  }

  private teamChip(repo: Repo, team: string): HTMLSpanElement {
    const s = h("span", "radar-team", team);
    s.style.setProperty("--t", this.teams(repo).get(team) ?? "var(--muted)");
    return s;
  }

  /** Teams to involve: each team whose files the workspaces touch, worst first, with who is in its code. */
  private teamSection(repo: Repo, files: Map<string, Mark[]>): HTMLElement[] {
    const rows = [...this.teams(repo).keys()].map((team) => {
      const paths = [...files.keys()].filter((p) => teamOf(repo, p) === team);
      const who = [...new Set(paths.flatMap((p) => files.get(p)!.map((m) => m.c)))].sort((a, b) => a - b);
      const hot = paths.filter((p) => files.get(p)!.length > 1).length;
      return { team, paths, who, hot };
    }).filter((r) => r.who.length).sort((a, b) => b.hot - a.hot || b.who.length - a.who.length || a.team.localeCompare(b.team));
    const unowned = [...files.keys()].filter((p) => !teamOf(repo, p));
    if (!rows.length && !unowned.length) return [];
    const head = h("h3", "", "Teams to involve");
    const ul = h("ul", "radar-list");
    for (const r of rows) {
      const li = this.row("team" + (r.hot ? " hot" : ""), `${r.team}: ${plural(r.who.length, "workspace")} in its code, ${plural(r.hot, "collision")}`, () => this.pick({ kind: "team", key: r.team }));
      const top = h("div", "radar-row-top");
      top.append(this.teamChip(repo, r.team));
      const w = h("span", "radar-who");
      for (const c of r.who.slice(0, 6)) w.append(this.badge(c));
      if (r.who.length > 6) w.append(h("span", "radar-with-l", `+${r.who.length - 6}`));
      top.append(w);
      const meta = h("div", "radar-meta", `${plural(r.paths.length, "file")} touched`);
      if (r.hot) meta.append(h("span", "radar-tag now", `${plural(r.hot, "collision")} in its code`));
      li.append(top, meta);
      this.hover(li, null, r.paths);
      ul.append(li);
    }
    const out: HTMLElement[] = [head, ul];
    if (unowned.length) out.push(h("p", "radar-dim radar-unowned", `${plural(unowned.length, "touched file")} ${unowned.length === 1 ? "has" : "have"} no owner in CODEOWNERS.`));
    return out;
  }

  /** A team's card: its files the workspaces touch, in bands, and who to bring in. */
  private teamCard(repo: Repo, team: string): void {
    const head = h("div", "radar-row-top");
    const h2 = h("h2", "", team || "No owner");
    h2.tabIndex = -1;
    head.append(h2);
    this.card.append(head);
    const all = marksOf(repo);
    const paths = [...all.keys()].filter((p) => teamOf(repo, p) === team);
    const who = [...new Set(paths.flatMap((p) => all.get(p)!.map((m) => m.c)))];
    this.card.append(h("p", "radar-dim", `${plural(who.length, "workspace")} in its code · ${plural(paths.length, "file")}`));
    this.banded(paths, all);
  }

  private fileCard(repo: Repo, path: string): void {
    const h2 = h("h2", "radar-path-h");
    h2.append(pathText(path));
    h2.tabIndex = -1;
    this.card.append(h2);
    if (repo.owners) {
      const o = repo.owners[path] ?? [];
      const p = h("p", "radar-owned");
      if (o.length) {
        p.append(document.createTextNode("Owned by "));
        o.forEach((t, k) => { if (k) p.append(document.createTextNode(" ")); p.append(this.teamChip(repo, t)); });
      } else p.append(document.createTextNode("No owner in CODEOWNERS"));
      this.card.append(p);
    }
    const on = repo.contacts.map((c, i) => ({ c, i, ed: c.editing.includes(path), pl: c.planned.filter((p) => p.path === path) })).filter((x) => x.ed || x.pl.length);
    const editing = on.filter((x) => x.ed).length;
    if (on.length > 1)
      this.card.append(h("p", "radar-hot-p", editing > 1 ? `${editing} workspaces are editing this file now.` : `${on.length} workspaces meet here: one edits it, another plans to.`));
    const ul = h("ul", "radar-list");
    for (const { c, i, ed, pl } of on) {
      const li = h("li", "radar-row static");
      const top = h("div", "radar-row-top");
      const name = h("span", "radar-name", c.title);
      name.title = c.title;
      top.append(this.badge(i, !ed), name);
      if (c.state === "needs_input") top.append(h("span", "radar-ask", "needs you"));
      li.append(top);
      if (ed) li.append(h("div", "radar-meta", `editing on ${c.branch}`));
      for (const p of pl) li.append(h("div", "radar-meta", `planned in ${p.plan}, increment ${p.inc}${p.title ? `: ${p.title}` : ""}`));
      li.append(this.jumpButton(c));
      ul.append(li);
    }
    this.card.append(ul);
  }

  /** Files grouped by band, the way the scope draws them; lone files fold away when there are many. */
  private banded(paths: string[], all: Map<string, Mark[]>, self?: number): void {
    const bands: [string, (m: Mark[]) => boolean][] = [
      ["Editing now with another", (m) => riskOf(m) === 2],
      ["Meets another's plan", (m) => riskOf(m) === 1],
      ["Only one workspace", (m) => riskOf(m) === 0],
    ];
    bands.forEach(([label, test], b) => {
      const list = paths.filter((p) => test(all.get(p)!)).sort();
      if (!list.length) return;
      const box = h("details", "radar-band");
      box.open = b < 2 || list.length <= 8;
      box.append(h("summary", "", `${label} (${list.length})`));
      const ul = h("ul", "radar-list");
      for (const p of list) {
        const marks = all.get(p)!;
        const shown = self === undefined ? marks : marks.filter((m) => m.c !== self);
        const li = this.row(marks.length > 1 ? "hot" : "", p, () => this.pick({ kind: "file", key: p }));
        li.append(pathText(p));
        if (shown.length) {
          const w = h("span", "radar-who");
          for (const m of shown) w.append(this.badge(m.c, !m.editing));
          li.append(w);
        }
        this.hover(li, null, [p]);
        ul.append(li);
      }
      box.append(ul);
      this.card.append(box);
    });
  }

  private wedgeCard(repo: Repo, wedge: string): void {
    // With the team layout a wedge is a team.
    if (this.owners === "teams" && repo.owners) return this.teamCard(repo, wedge);
    const h2 = h("h2", "", wedge === "·" ? "Top level" : `${wedge}/`);
    h2.tabIndex = -1;
    this.card.append(h2);
    const all = marksOf(repo);
    const paths = [...all.keys()].filter((p) => wedgeOf(p) === wedge);
    this.card.append(h("p", "radar-dim", `${plural(paths.length, "file")}, ${plural(paths.filter((p) => all.get(p)!.length > 1).length, "collision")}`));
    this.banded(paths, all);
  }

  private contactCard(repo: Repo, i: number): void {
    const c = repo.contacts[i];
    if (!c) return;
    const head = h("div", "radar-row-top");
    const h2 = h("h2", "", c.title);
    h2.tabIndex = -1;
    head.append(this.badge(i), h2);
    if (c.state === "needs_input") head.append(h("span", "radar-ask", "needs you"));
    this.card.append(head, h("p", "radar-dim", `branch ${c.branch}`), h("p", "radar-dim", `worktree ${c.root}`), this.jumpButton(c));
    this.banded([...new Set([...c.editing, ...c.planned.map((p) => p.path)])], marksOf(repo), i);
  }
}

/** An annular sector from radius r0 to r1 between angles a0 and a1 (degrees clockwise from twelve). */
function sector(r0: number, r1: number, a0: number, a1: number): string {
  if (a1 - a0 >= 359.9) return `M0 ${-r1} A${r1} ${r1} 0 1 1 0 ${r1} A${r1} ${r1} 0 1 1 0 ${-r1} Z M0 ${-r0} A${r0} ${r0} 0 1 0 0 ${r0} A${r0} ${r0} 0 1 0 0 ${-r0} Z`;
  const big = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r1} ${r1} 0 ${big} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${r0} ${r0} 0 ${big} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

/** A four-point star, the collision's mark. */
function star(outer: number, inner: number): string {
  const p: string[] = [];
  for (let k = 0; k < 8; k++) {
    const [x, y] = pt(k % 2 ? inner : outer, k * 45);
    p.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${p.join(" L")} Z`;
}
