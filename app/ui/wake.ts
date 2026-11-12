import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sheet, type Sheet, type Shown } from "./sheet";
import { dotsMenu, type MenuItem, type TuckRow } from "./tuck";
import { fileUrl, mediaOf, PREVIEW, previewable, Viewer } from "./wakeview";
import { age, badgeOf, bar, byUrl, countsSaid, doneSaid, GROUP_SAID, grouped, type Group, type Pr } from "./prs";

// A row as crew-board's wake_data serves it (wake.rs's wake_row).
export type Row = {
  id: number;
  kind: string;
  title: string;
  path: string;
  was_path: string;
  url: string;
  sha: string;
  created_at: string;
  session_id: string;
  branch: string;
  prompt: string;
  source: string;
  locator: string;
  state: "ok" | "risk" | "kept" | "gone";
  published: boolean;
  publishable: boolean;
  ws: string;
};
type Ws = { ws: string; n: number; last: string; name: string; here: boolean };
type Data = { ws: string; rows: Row[]; limit: number; truncated: boolean; workspaces: Ws[] };


export const KINDS = ["plan", "review", "ask", "artifact", "doc", "temp", "image", "file", "commit", "turn", "pr", "issue"];

/** A pull request's or issue's URL: owner/repo, and its number. */
function ghLink(r: Row): { repo: string; n: string } | null {
  if (r.kind !== "pr" && r.kind !== "issue") return null;
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(r.url || r.locator);
  return m ? { repo: m[1], n: m[2] } : null;
}
const SOURCE: Record<string, string> = { "deep-plan": "deep-plan", lookout: "lookout review", ask: "deep-plan ask" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, cls = "w-act"): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  return b;
}

const pad = (n: number) => (n < 10 ? "0" : "") + n;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function local(iso: string): Date | null {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
export function dayKey(d: Date | null): string {
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "undated";
}
export function dayLabel(d: Date | null, now = new Date()): string {
  if (!d) return "undated";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const base = `${MON[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : ""}`;
  if (dayKey(d) === dayKey(now)) return `today · ${base}`;
  if (dayKey(d) === dayKey(y)) return `yesterday · ${base}`;
  return `${DOW[d.getDay()]} · ${base}`;
}
const hm = (d: Date | null) => (d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "");

/** `cd <ws> && claude --resume <id>`, quoted for the shell. */
export function resumeCmd(r: Row): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return `cd ${q(r.ws)} && claude --resume ${q(r.session_id)}`;
}

/** Where a row lives, as the page shows it. */
function where(r: Row, home: string): string {
  const tilde = (p: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  // A commit's repo is the workspace's: the same line on every commit said nothing.
  if (r.kind === "commit") return "";
  if (r.kind === "artifact") return r.url.replace(/^https:\/\//, "") + (r.path ? `  ← ${tilde(r.path)}` : "");
  const gh = ghLink(r);
  if (gh) return `github.com/${gh.repo}`;
  return tilde(r.path || "");
}

/** A long path shortened by whole folders: its first two and its last two
 *  (the file's folder and the file), "…" between. */
export function shortPath(p: string, max = 72): string {
  if (p.length <= max || p.includes("://")) return p;
  const lead = p.startsWith("/") ? "/" : "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 4) return p;
  return `${lead}${parts.slice(0, 2).join("/")}/…/${parts.slice(-2).join("/")}`;
}

/** `text` with the search's words marked. */
function marked(text: string, q: string): DocumentFragment {
  const f = document.createDocumentFragment();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    f.append(text);
    return f;
  }
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  for (const part of text.split(re)) {
    if (!part) continue;
    if (words.includes(part.toLowerCase())) f.append(el("mark", "", part));
    else f.append(part);
  }
  return f;
}

/** The Wake: what each workspace left behind, as /artifacts shows it, in the app. */
/** A confirming click this soon after the one that asked is the same double-click. */
const CONFIRM_AFTER_MS = 400;

function arm(b: HTMLElement): void {
  b.dataset.armedAt = String(Date.now());
}

function tooSoon(b: HTMLElement): boolean {
  return Date.now() - Number(b.dataset.armedAt ?? 0) < CONFIRM_AFTER_MS;
}

export class Wake {
  private title = el("h1", "w-title");
  private stats = el("span", "w-stats");
  private keepAllBtn = button("", "w-act keepall");
  private picker = el("select", "w-ws");
  private q = el("input", "w-q");
  private chipsEl = el("div", "w-chips");
  private list = el("div", "w-list");
  private toastEl = el("div", "w-toast");
  private help = el("div", "w-help");
  /** The preview pane, beside or under the list. */
  private viewer: Viewer;
  private data: Data = { ws: "", rows: [], limit: 0, truncated: false, workspaces: [] };
  private ws = "";
  /** More directories read with `ws`: the sheet's workspace's page roots.
   *  The picker still names `ws` alone; picking one drops these. */
  private also: string[] = [];
  /** The person picked a directory in the picker since the sheet last set
   *  one: a change in the sheet's page roots then leaves the Wake alone. */
  private picked = false;
  private query = "";
  private kinds = new Set<string>();
  /** The kind chips past the five busiest, shown after "more". */
  private allChips = false;
  private openGroups = new Set<string>();
  /** Days the person folded or opened by hand, over the default (older days
   *  fold when the list is long). */
  private dayFold = new Map<string, boolean>();
  /** Long days the person asked to see in full ("show N more"). */
  private dayAll = new Set<string>();
  private vis: Row[] = [];
  private sel = -1;
  private home = "";
  private seq = 0;
  private lastTop = -1;
  /** Muted and tucked worktrees, from the views feed: tucked ones sink in the picker. */
  private tucked: TuckRow[] = [];
  /** The worktree's pull requests (crew-sync's list, wake_prs), for the
   *  Pull requests block and the pr rows' badges; when they were read. */
  private prs: Pr[] = [];
  private prsAt = 0;
  private prsWs = "";
  /** The done group is folded until opened; the rest are open. */
  private prsOpen = new Set<Group>(["you", "people", "draft", "open"]);
  /** PRs whose failing checks are listed; a red one that needs you starts open. */
  private prsShown = new Map<number, boolean>();
  /** A group the Dock's pill asked for: scrolled to and marked once drawn. */
  private prsFocus: Group | null = null;

  /** Embedded: the copy in the chat sheet, which has the keys while the sheet is open. */
  private embedded: boolean;
  /** The sheet this Wake is a tab of: what it opens goes there, beside it,
   *  for the workspace shown (the Dock view stays). Else the app's sheet. */
  private host: Sheet | null;

  constructor(readonly root: HTMLElement, opts: { embedded?: boolean; host?: Sheet } = {}) {
    this.embedded = !!opts.embedded;
    this.host = opts.host ?? null;
    root.classList.add("wake");
    if (this.embedded) root.classList.add("embedded");
    this.picker.setAttribute("aria-label", "workspace");
    this.picker.addEventListener("change", () => {
      this.ws = this.picker.value;
      this.also = [];
      this.picked = true;
      this.kinds.clear();
      this.sel = -1;
      void this.load();
    });
    this.q.type = "search";
    this.q.placeholder = "search titles, paths and prompts";
    this.q.spellcheck = false;
    this.q.setAttribute("aria-label", "search");
    let t = 0;
    this.q.addEventListener("input", () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        this.query = this.q.value.trim();
        void this.load();
      }, 140);
    });
    this.keepAllBtn.hidden = true;
    this.keepAllBtn.addEventListener("click", () => void this.keepAll());
    const keys = button("keys", "w-act w-keys");
    keys.title = "the keyboard keys (?)";
    keys.addEventListener("click", () => (this.help.hidden = !this.help.hidden));
    this.help.hidden = true;
    this.help.append(
      el("h3", "", "keys"),
      ...[
        ["/", "search · Esc clears"],
        ["j k", "next · previous row"],
        ["Enter", "preview a picture, video or page; open the rest (⌘ in cmux)"],
        ["← →", "flip through the previews"],
        ["v", "preview beside · under the list"],
        ["f", "fill the Wake with the preview"],
        ["Esc", "close the preview"],
        ["Space", "show the whole prompt"],
        ["K", "keep an at-risk file"],
        ["c", "copy the path"],
        ["r", "copy the resume command"],
      ].map(([k, v]) => {
        const p = el("p");
        p.append(el("b", "", k), document.createTextNode(`  ${v}`));
        return p;
      }),
    );
    this.help.addEventListener("click", () => (this.help.hidden = true));

    const head = el("header", "w-head");
    const ttl = el("div", "w-ttl");
    const sub = el("div", "w-sub");
    sub.append(this.stats, this.keepAllBtn);
    // In the Dock the sheet already names the workspace.
    if (this.embedded) ttl.append(sub);
    else ttl.append(this.title, sub);
    head.append(ttl, this.picker);
    const bar = el("div", "w-bar");
    bar.append(this.q, keys);
    this.toastEl.setAttribute("role", "status");
    const main = el("div", "w-main");
    main.append(head, bar, this.chipsEl, this.list);
    this.viewer = new Viewer(root, {
      pick: (r) => this.reveal(r),
      openElsewhere: (r, e) => void this.open(r, "", e, true),
      closed: () => this.list.querySelector<HTMLElement>(".w-row.sel")?.scrollIntoView({ block: "nearest" }),
      when: (r) => {
        const d = local(r.created_at);
        return [r.kind, d ? `${dayLabel(d)} ${hm(d)}` : "", r.prompt || SOURCE[r.source] || ""].filter(Boolean).join(" · ");
      },
    });
    root.replaceChildren(main, this.viewer.gripX, this.viewer.gripY, this.viewer.el, this.help, this.toastEl);
    this.chipsEl.addEventListener("click", (e) => this.chip(e));
    // A click in the Wake gives it the keys: a tab button or the Dock's
    // terminal focused elsewhere would keep j/k and ← → otherwise.
    root.addEventListener("pointerdown", () => {
      const at = document.activeElement;
      if (at instanceof HTMLElement && at !== document.body && !root.contains(at)) at.blur();
    });
    document.addEventListener("keydown", (e) => this.key(e));
  }

  async start(): Promise<void> {
    try {
      this.home = await invoke<string>("home_dir");
    } catch {
      this.home = "";
    }
    // New rows land at each turn's end; the views feed says when.
    await listen<{ wake: { id: number }[]; tucked?: TuckRow[] }>("views:frame", (e) => {
      const tucked = (e.payload.tucked ?? []).filter((r) => r.level === "tuck");
      if (JSON.stringify(tucked.map((r) => r.path)) !== JSON.stringify(this.tucked.map((r) => r.path))) {
        this.tucked = tucked;
        if (this.data.workspaces.length) this.draw();
      }
      if (this.visible() && Date.now() - this.prsAt > 30_000) void this.loadPrs();
      const top = e.payload.wake?.[0]?.id ?? -1;
      if (top !== this.lastTop) {
        this.lastTop = top;
        if (this.visible()) void this.load(true);
      }
    });
    await this.load();
  }

  private visible(): boolean {
    return this.root.offsetParent !== null;
  }

  /** Called when the tab is shown: fresh rows. */
  shown(): void {
    void this.load(true);
  }

  /** Show the Wake of the worktree at `dir` (the sheet's workspace), fresh,
   *  with the rows filed under `also` too: the roots of the plans, reviews
   *  and asks that workspace has open, which may sit outside `dir`. */
  showDir(dir: string, also: string[] = []): void {
    this.picked = false;
    this.also = [...new Set(also.filter((d) => d && d !== dir))];
    if (dir && dir !== this.ws) {
      this.ws = dir;
      this.kinds.clear();
      this.sel = -1;
      this.q.value = "";
      this.query = "";
      void this.load();
    } else void this.load(true);
  }

  /** The sheet's workspace opened or closed a page: read its roots too,
   *  keeping the directory, search and filters shown. Not once the person
   *  picked another directory, which reads that one alone. */
  setAlso(dir: string, also: string[]): void {
    if (this.picked) return;
    this.also = [...new Set(also.filter((d) => d && d !== dir))];
    void this.load(true);
  }

  /** The Dock's PR pill: this Wake, on `group` (open, draft, people, done),
   *  its group opened and scrolled to. "open" is every open group. */
  showPrs(group: string): void {
    const g: Group = group === "people" ? "people" : group === "draft" ? "draft" : group === "done" ? "done" : "open";
    this.prsOpen.add(g);
    this.prsFocus = g === "open" ? (this.prs.some((p) => p.state === "open" && grouped([p]).get("you")!.length) ? "you" : "open") : g;
    void this.loadPrs();
  }

  /** Read the worktree's PR list and redraw when it changed. */
  private async loadPrs(): Promise<void> {
    const ws = this.ws;
    this.prsAt = Date.now();
    try {
      const prs = ws ? await invoke<Pr[]>("wake_prs", { dir: ws }) : [];
      if (ws !== this.ws) return;
      const same = ws === this.prsWs && JSON.stringify(prs) === JSON.stringify(this.prs);
      this.prs = Array.isArray(prs) ? prs : [];
      this.prsWs = ws;
      if ((!same || this.prsFocus) && this.data.workspaces.length) this.draw();
    } catch {
      /* no list: the block stays away */
    }
  }

  private toast(text: string, bad = false): void {
    this.toastEl.textContent = text;
    this.toastEl.className = `w-toast on${bad ? " bad" : ""}`;
    clearTimeout((this as unknown as { th: number }).th);
    (this as unknown as { th: number }).th = window.setTimeout(() => (this.toastEl.className = "w-toast"), 2600);
  }

  async load(quiet = false): Promise<void> {
    const seq = ++this.seq;
    try {
      const d = await invoke<Data>("wake_data", { ws: this.ws, q: this.query, dirs: this.also });
      if (seq !== this.seq) return; // a newer search or workspace is in flight
      this.data = d;
      if (d.ws && d.ws !== this.ws) this.ws = d.ws;
      if (!this.ws && d.workspaces.length) {
        this.ws = d.workspaces[0].ws; // the most recent workspace
        return this.load(quiet);
      }
      this.draw();
      if (this.ws !== this.prsWs || Date.now() - this.prsAt > 30_000) void this.loadPrs();
    } catch (e) {
      if (!quiet) this.toast(`the Wake log could not be read: ${String(e)}`, true);
    }
  }

  private draw(): void {
    // The picker: names, with the parent folder where two share one.
    const names = new Map<string, number>();
    for (const w of this.data.workspaces) names.set(w.name, (names.get(w.name) ?? 0) + 1);
    const option = (w: Ws) => {
      const o = el("option", "", `${(names.get(w.name) ?? 0) > 1 ? w.ws.split("/").slice(-2).join("/") : w.name} (${w.n})${w.here ? "" : " — gone"}`);
      o.value = w.ws;
      o.selected = w.ws === this.ws;
      return o;
    };
    // Tucked worktrees stay pickable (the Wake is history), after the rest.
    // The exact worktree: a nested worktree under a tucked one is its own.
    const isTucked = (w: Ws) => this.tucked.some((t) => w.ws === t.path);
    const opts: HTMLElement[] = this.data.workspaces.filter((w) => !isTucked(w)).map(option);
    const tuckedOpts = this.data.workspaces.filter(isTucked).map(option);
    if (tuckedOpts.length) {
      const g = el("optgroup");
      g.label = "Hidden";
      g.append(...tuckedOpts);
      opts.push(g);
    }
    if (this.ws && !this.data.workspaces.some((w) => w.ws === this.ws)) {
      const o = el("option", "", `${this.ws.split("/").pop()} (0)`);
      o.value = this.ws;
      o.selected = true;
      opts.unshift(o);
    }
    this.picker.replaceChildren(...opts);
    // The picker beside it names the workspace.
    this.title.replaceChildren(document.createTextNode("the wake"));

    // Chips: all, then each kind with its count.
    const rows = this.data.rows;
    const n = new Map<string, number>();
    for (const r of rows) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
    const all = button("", `w-chip${this.kinds.size ? "" : " on"}`);
    all.dataset.k = "";
    all.append(document.createTextNode("all "), el("span", "", String(rows.length)));
    // The five busiest kinds show; the rest wait behind "more" (a picked one
    // always shows), so the filter row stays one short line.
    const busy = KINDS.filter((k) => n.get(k)).sort((a, b) => (n.get(b) ?? 0) - (n.get(a) ?? 0));
    // Six or fewer fit on the line: all show. Past that, the five busiest.
    const top = new Set(busy.length > 6 ? busy.slice(0, 5) : busy);
    // Only the kinds "more" actually hides: a picked kind always shows.
    const extra = busy.filter((k) => !top.has(k) && !this.kinds.has(k)).length;
    const more = button(this.allChips ? "fewer" : `more ${extra}`, "w-chip w-more");
    more.dataset.k = "\u0000more";
    more.hidden = extra <= 0;
    this.chipsEl.replaceChildren(
      all,
      ...KINDS.map((k) => {
        const b = button("", `w-chip${this.kinds.has(k) ? " on" : ""}`);
        // A kind with nothing in it is no filter: hidden, unless it is the one picked.
        b.hidden = (!n.get(k) || (!this.allChips && !top.has(k))) && !this.kinds.has(k);
        b.dataset.k = k;
        b.append(document.createTextNode(`${k} `), el("span", "", String(n.get(k) ?? 0)));
        return b;
      }),
      more,
    );

    // Stats and keep all.
    const risk = rows.filter((r) => r.state === "risk").length;
    const kept = rows.filter((r) => r.state === "kept").length;
    const gone = rows.filter((r) => r.state === "gone").length;
    const bits: (string | HTMLElement)[] = [el("b", "", String(rows.length)), this.query ? ` for “${this.query}”` : " things left behind"];
    if (risk) bits.push(" · ", el("span", "risk", `${risk} at risk`));
    if (kept) bits.push(" · ", el("span", "kept", `${kept} kept`));
    if (gone) bits.push(` · ${gone} gone`);
    if (this.data.truncated) bits.push(` · newest ${this.data.limit} shown; search to reach older`);
    this.stats.replaceChildren(...bits);
    // One at-risk file has its own keep button: keep all is for two or more.
    this.keepAllBtn.hidden = risk < 2 || !!this.query;
    if (!this.keepAllBtn.classList.contains("sure")) this.keepAllBtn.textContent = `keep all ${risk}`;
    this.keepAllBtn.dataset.n = String(risk);

    // Rows by day, then by the prompt that made them.
    const keepId = this.vis[this.sel]?.id;
    this.vis = rows.filter((r) => !this.kinds.size || this.kinds.has(r.kind));
    const out: HTMLElement[] = [];
    let day = "";
    let group = "";
    let section: HTMLElement | null = null;
    let ul: HTMLElement | null = null;
    let tail: HTMLElement | undefined;
    // The branch and session of the group above: a header that repeats them
    // shows them only on hover, so each card leads with its prompt.
    let lastBr = "";
    let shownToday = 0;
    let lastSess = "";
    const keyOf = (r: Row) => {
      const dk = dayKey(local(r.created_at));
      return `${dk}|${r.session_id}|${r.prompt}|${r.prompt ? "" : r.kind}`;
    };
    // How many rows each card holds (a run of rows with one key; the same
    // prompt later in the day is a new card): a card of one drops its band.
    const perDay = new Map<string, number>();
    const riskPerDay = new Map<string, number>();
    for (const r of this.vis) {
      const k = dayKey(local(r.created_at));
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
      if (r.state === "risk") riskPerDay.set(k, (riskPerDay.get(k) ?? 0) + 1);
    }
    const newest = this.vis.length ? dayKey(local(this.vis[0].created_at)) : "";
    const runs: number[] = [];
    // Whether each card holds a row at risk: such a card never folds away.
    const runRisk: boolean[] = [];
    this.vis.forEach((r, i) => {
      if (i > 0 && keyOf(r) === keyOf(this.vis[i - 1])) runs[runs.length - 1]++;
      else {
        runs.push(1);
        runRisk.push(false);
      }
      if (r.state === "risk") runRisk[runRisk.length - 1] = true;
    });
    let run = -1;
    this.vis.forEach((r, i) => {
      const d = local(r.created_at);
      const dk = dayKey(d);
      const gk = keyOf(r);
      if (dk !== day) {
        // A long list folds older days to a count; a search never folds (its
        // matches are the point). A click toggles.
        // A long list (over 20 things) folds every day but the newest.
        const folded = !this.query && (this.dayFold.get(dk) ?? (dk !== newest && this.vis.length > 20));
        section = el("section", `w-day${folded ? " folded" : ""}`);
        section.dataset.day = dk;
        const h = el("h2", "");
        const n = perDay.get(dk) ?? 0;
        const tog = button(`${folded ? "▸" : "▾"} ${dayLabel(d)}${folded ? ` · ${n} thing${n === 1 ? "" : "s"}` : ""}`, "w-dayh");
        // A folded day still says when something in it is at risk.
        const atRisk = riskPerDay.get(dk) ?? 0;
        if (folded && atRisk) tog.append(el("span", "w-dayrisk", ` · ${atRisk} at risk`));
        tog.setAttribute("aria-expanded", String(!folded));
        tog.addEventListener("click", () => {
          this.dayFold.set(dk, !folded);
          this.draw();
        });
        h.append(tog);
        section.append(h);
        out.push(section);
        day = dk;
        shownToday = 0;
        group = "";
        lastBr = "";
        lastSess = "";
      }
      if (gk !== group) {
        run++;
        const solo = runs[run] === 1;
        // A long day (over 15 things) shows its newest groups up to about 10
        // rows; the rest are "later", behind a "show N more" at the day's end.
        // A card with a row at risk is never later, wherever it sits: only
        // safe cards fold.
        const later = !this.query && !runRisk[run] && (perDay.get(dk) ?? 0) > 15 && shownToday >= 10 && !this.dayAll.has(dk);
        const g = el("div", `w-grp${later ? " later" : ""}${this.openGroups.has(gk) ? " open" : ""}`);
        const ph = el("div", "w-ph");
        // A card of one row whose prompt is its title says it once.
        const same = solo && !!r.prompt && r.prompt.trim() === (r.title ?? "").trim();
        const prompt = el("span", `w-prompt${r.prompt ? "" : " none"}${same ? " same" : ""}`);
        prompt.title = r.prompt;
        prompt.append(r.prompt ? marked(r.prompt, this.query) : document.createTextNode(SOURCE[r.source] ?? "no prompt recorded"));
        prompt.addEventListener("click", () => {
          if (this.openGroups.has(gk)) this.openGroups.delete(gk);
          else this.openGroups.add(gk);
          g.classList.toggle("open");
        });
        // Every group is a caption over its rows, so titles line up down the
        // column: the caption's time in the kind column, its prompt at the
        // titles' edge. Branch and session wait for hover, focus or the pick
        // (wake.css). A caption that would be only a time is dropped: its
        // time, branch and session sit at the end of the row instead.
        const cap = same ? el("span", "w-tm") : ph;
        if (!same) ph.append(el("time", "", hm(d)), prompt);
        if (r.branch) cap.append(el("span", `w-br${r.branch === lastBr ? " rep" : ""}`, r.branch));
        if (r.session_id) {
          // Said as what it does: a bare id read as a commit's sha.
          const s = button("copy resume", `w-sess${r.session_id === lastSess ? " rep" : ""}`);
          s.title = `copy the command that resumes session ${r.session_id.slice(0, 8)}`;
          s.addEventListener("click", () => void this.copy(resumeCmd(r), "the resume command"));
          cap.append(s);
        }
        if (same) cap.append(el("time", "", hm(d)));
        tail = same ? cap : undefined;
        lastBr = r.branch ?? "";
        lastSess = r.session_id ?? "";
        ul = el("ul", "w-rows");
        if (same) g.append(ul);
        else g.append(ph, ul);
        section!.append(g);
        group = gk;
      }
      ul!.append(this.row(r, i, r.id === keepId, tail));
      tail = undefined;
      if (!ul!.parentElement?.classList.contains("later")) shownToday++;
    });
    if (!this.vis.length) {
      const e = el("div", "w-empty");
      e.textContent = this.query
        ? `nothing in the wake matches “${this.query}”`
        : this.ws
          ? "nothing in this workspace's wake yet. Each file, plan or commit a session makes shows up here when its turn ends."
          : "no workspace yet.";
      out.push(e);
    }
    // A long day's later groups wait behind one "show N more" at its end.
    for (const sec of out) {
      const hid = sec.querySelectorAll(".w-grp.later .w-row").length;
      if (!hid) continue;
      // Not "w-more": that is the kind chips' own "more N".
      // Never at risk: a card holding a row at risk is never later.
      const more = button(`show ${hid} more`, "w-daymore");
      const dk = sec.dataset.day ?? "";
      more.addEventListener("click", () => {
        this.dayAll.add(dk);
        this.draw();
      });
      sec.append(more);
    }
    // The worktree's pull requests, pinned above the days: not while a
    // search or a kind other than pr is picked, which ask about rows.
    const prsBlock = this.ws === this.prsWs && !this.query && (!this.kinds.size || this.kinds.has("pr")) ? this.prsBlock() : null;
    if (prsBlock) out.unshift(prsBlock);
    this.list.classList.toggle("searching", !!this.query);
    this.list.replaceChildren(...out);
    if (prsBlock && this.prsFocus) {
      const at = prsBlock.querySelector<HTMLElement>(`[data-g="${this.prsFocus}"]`) ?? prsBlock;
      at.scrollIntoView({ block: "start" });
      at.classList.add("asked");
      this.prsFocus = null;
    }
    this.sel = keepId === undefined ? -1 : this.vis.findIndex((r) => r.id === keepId);
    // A pick whose day was just folded is out of sight: Enter must not open it.
    if (this.sel >= 0 && this.list.querySelectorAll(".w-row")[this.sel]?.closest(".w-day.folded, .w-grp.later")) this.sel = -1;
    if (this.viewer.open) this.viewer.setRows(this.vis.filter(previewable));
  }

  /** The Pull requests block: groups needs you, needs people, draft, open,
   *  then done folded to its counts. Null with no PRs. */
  private prsBlock(): HTMLElement | null {
    if (!this.prs.length) return null;
    const sec = el("section", "w-prs");
    sec.setAttribute("aria-label", "pull requests");
    const h = el("h2", "w-prs-h");
    h.append(document.createTextNode("Pull requests "), el("span", "", String(this.prs.length)));
    sec.append(h);
    for (const [g, list] of grouped(this.prs)) {
      if (!list.length) continue;
      const box = el("div", `w-prs-g ${g}`);
      box.dataset.g = g;
      const open = this.prsOpen.has(g);
      const head = button("", "w-prs-gh");
      head.setAttribute("aria-expanded", String(open));
      head.append(el("span", "w-prs-tw", open ? "▾" : "▸"), document.createTextNode(` ${GROUP_SAID[g]} `),
        el("span", "w-prs-gn", g === "done" ? doneSaid(list) : String(list.length)));
      head.addEventListener("click", () => {
        if (this.prsOpen.has(g)) this.prsOpen.delete(g);
        else this.prsOpen.add(g);
        this.draw();
      });
      box.append(head);
      if (open) {
        const ul = el("ul", "w-prs-l");
        for (const p of list) ul.append(this.prLine(p, g));
        box.append(ul);
      }
      sec.append(box);
    }
    return sec;
  }

  private prLine(p: Pr, g: Group): HTMLElement {
    const li = el("li", `w-pr ${p.state}`);
    const link = (text: string, url: string, cls: string): HTMLElement => {
      const a = el("a", cls, text);
      a.href = url;
      a.title = url;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void invoke("open_url", { url }).catch((err) => this.toast(String(err), true));
      });
      return a;
    };
    li.append(link(`#${p.n}`, p.url, "w-pr-n"));
    const b = el("span", "w-pr-bar");
    const segs = bar(p.checks);
    b.title = countsSaid(p.checks);
    for (const s of segs) {
      const seg = el("span", `seg ${s.kind}`);
      seg.style.flexGrow = String(s.cells);
      b.append(seg);
    }
    if (!segs.length) b.classList.add("none");
    li.append(b);
    const t = el("span", "w-pr-t", p.title || p.url);
    if (p.state === "draft" && g !== "draft") t.prepend(el("span", "w-pr-tag", "draft "));
    li.append(t, el("time", "w-pr-age", age(p.updatedAt)));
    const failing = p.failing ?? [];
    if (failing.length) {
      const shown = this.prsShown.get(p.n) ?? g === "you";
      li.classList.add("has-fails");
      li.setAttribute("aria-expanded", String(shown));
      li.title = shown ? "hide the failing checks" : `show the ${failing.length} failing check${failing.length === 1 ? "" : "s"}`;
      li.addEventListener("click", () => {
        this.prsShown.set(p.n, !shown);
        this.draw();
      });
      if (shown) {
        const fl = el("ul", "w-pr-fails");
        for (const c of failing) {
          const fi = el("li", "");
          fi.append(c.url ? link(`✗ ${c.name}`, c.url, "w-pr-f") : el("span", "w-pr-f", `✗ ${c.name}`));
          fl.append(fi);
        }
        li.append(fl);
      }
    }
    return li;
  }

  /** Pick `r` in the list, opening its day if it was folded: the pane
   *  flipped to it. Its row stays in sight beside the pane. */
  private reveal(r: Row): void {
    let i = this.vis.findIndex((x) => x.id === r.id);
    if (i < 0) return this.viewer.render(r);
    if (this.list.querySelectorAll(".w-row")[i]?.closest(".w-day.folded, .w-grp.later")) {
      const dk = dayKey(local(r.created_at));
      this.dayFold.set(dk, false);
      this.dayAll.add(dk);
      this.draw();
      i = this.vis.findIndex((x) => x.id === r.id);
    }
    this.select(i, true);
  }

  private row(r: Row, i: number, sel: boolean, tail?: HTMLElement): HTMLElement {
    const li = el("li", `w-row ${r.state}${sel ? " sel" : ""}`);
    li.dataset.i = String(i);
    li.append(el("span", "w-k", r.kind));
    const t = el("span", "w-t");
    const gh = ghLink(r);
    // A link made with a title shows it; one only named shows owner/repo #n.
    const title = r.title || (gh ? `${gh.repo} #${gh.n}` : r.locator);
    t.title = gh ? r.url : title;
    t.append(marked(title, this.query));
    li.append(t);
    const badges = el("span", "w-badges");
    // At risk is a state, said in red; its keep button is a plain action.
    if (r.state === "risk") badges.append(el("span", "w-st risk", "at risk"));
    else if (r.state === "kept") badges.append(el("span", "w-st kept", "kept"));
    else if (r.state === "gone") badges.append(el("span", "w-st", "gone"));
    if (r.published) badges.append(el("span", "w-st pub", "claude.ai"));
    if (r.kind === "commit" && r.sha) {
      // The sha waits for hover, focus or the pick (wake.css), unless a search matched it.
      const hit = this.query.toLowerCase().split(/\s+/).some((w) => !!w && r.sha.toLowerCase().includes(w));
      const sha = el("span", `w-st w-sha${hit ? " hit" : ""}`);
      sha.append(marked(r.sha, this.query));
      badges.append(sha);
    }
    if (gh && r.title) badges.append(el("span", "w-st", `#${gh.n}`));
    // A PR this worktree made: its state, red when a check failed.
    const mine = r.kind === "pr" && gh ? byUrl(this.prs).get(`https://github.com/${gh.repo}/pull/${gh.n}`) : undefined;
    if (mine) {
      const s = badgeOf(mine);
      badges.append(el("span", `w-st pr-${s.cls}`, s.text));
    }
    li.append(badges);
    const w = where(r, this.home);
    // The path shows on the picked row (wake.css); the title's tooltip has it always.
    if (w) t.title += `\n${w}`;
    if (w) {
      // Cut by whole folders, the full path on hover; a search shows it whole.
      const p = el("span", `w-p${this.query && w.toLowerCase().includes(this.query.toLowerCase()) ? " hit" : ""}`);
      p.title = w;
      p.append(marked(this.query ? w : shortPath(w), this.query));
      li.append(p);
    }
    if (r.was_path) {
      const p = el("span", "w-p was");
      p.title = r.was_path;
      p.append(el("bdi", "", `was ${r.was_path}`));
      li.append(p);
    }
    // At most one button, the one thing this row asks for: keep a file at
    // risk, or publish one that is not out yet. The rest is in the ⋯ menu.
    const acts = el("span", "w-acts");
    const items: MenuItem[] = [];
    // "main", not "sure": publish() reads .sure as the confirming second click.
    const shown = (label: string, title: string, run: (b: HTMLButtonElement) => void) => {
      const b = button(label, "w-act main");
      b.title = title;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        run(b);
      });
      acts.prepend(b);
      return b;
    };
    const pubLabel = r.published ? "publish again" : "publish";
    const pubTitle = "publish this file to claude.ai";
    const keep: MenuItem = { label: "keep", hint: "K", title: "copy it into ~/.claude/crew/kept and point this row there", run: () => void this.keep(r) };
    // From the menu, publishing still asks first: its confirm needs a button
    // that stays on screen, so the row gets one, already asking.
    const publish: MenuItem = {
      label: pubLabel,
      title: pubTitle,
      run: () => {
        let b = acts.querySelector<HTMLButtonElement>(".w-act.pub");
        if (!b) {
          const made = shown(pubLabel, pubTitle, (x) => void this.publish(r, x));
          // Made only to confirm: gone again once its 4s ask lapses unanswered.
          window.setTimeout(() => {
            if (made.isConnected && !made.disabled && !made.classList.contains("sure")) made.remove();
          }, 4100);
          b = made;
        }
        b.classList.add("pub");
        void this.publish(r, b);
      },
    };
    const primary = r.state === "risk" ? keep : r.publishable && !r.published ? publish : null;
    // Keep is a plain button: the row's "at risk" pill is the signal.
    // Keep sits with the "at risk" pill, by the title, not at the row's far end.
    if (primary === keep) {
      const b = button(keep.label, "w-act");
      b.title = keep.title ?? "";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.keep(r);
      });
      badges.append(b);
    }
    else if (primary === publish) shown(pubLabel, pubTitle, (b) => void this.publish(r, b)).classList.add("pub");
    if (r.kind === "plan") {
      items.push(
        { label: "working", title: "in the sheet; ⌘-click in cmux", run: (e) => void this.open(r, "working", e) },
        { label: "review", run: (e) => void this.open(r, "review", e) },
        { label: "markdown", run: (e) => void this.open(r, "md", e) },
      );
    } else if (this.openable(r)) {
      items.push({ label: "open", hint: "↵", title: "pages in the sheet; ⌘-click opens in cmux", run: (e) => void this.open(r, "", e) });
    }
    if (r.publishable && primary !== publish) items.push(publish);
    if (r.path) items.push({ label: "copy path", hint: "c", run: () => void this.copy(r.path, "the path") });
    if (r.session_id) items.push({ label: "copy resume", hint: "r", run: () => void this.copy(resumeCmd(r), "the resume command") });
    if (items.length) acts.append(dotsMenu(`${title}: more`, items));
    // A group of one whose caption was dropped: its time at the row's end.
    if (tail) li.append(tail);
    li.append(acts);
    // A click opens the row, as Enter does; the arrows still only select.
    li.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, a, .tuck-wrap")) return;
      // A drag that selected some text ends in a click: that is a copy, not an open.
      const s = window.getSelection();
      if (s && !s.isCollapsed && li.contains(s.anchorNode)) return;
      this.select(i);
      if (this.openable(r)) void this.open(r, "", e);
    });
    return li;
  }

  /** Whether the row has anything to open: a gone file has nothing, unless a URL or commit stands in. */
  private openable(r: Row): boolean {
    return r.kind === "plan" || r.state !== "gone" || !!r.url || r.kind === "commit";
  }

  private chip(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".w-chip");
    if (!b) return;
    const k = b.dataset.k ?? "";
    if (k === "\u0000more") {
      this.allChips = !this.allChips;
      this.draw();
      return;
    }
    if (!k) this.kinds.clear();
    else if (e.shiftKey) {
      if (this.kinds.has(k)) this.kinds.delete(k);
      else this.kinds.add(k);
    } else {
      const only = this.kinds.has(k) && this.kinds.size === 1;
      this.kinds.clear();
      if (!only) this.kinds.add(k);
    }
    this.sel = -1;
    this.draw();
  }

  /** j / k: the next row in that direction that shows. A folded day's rows
   *  are in the list but hidden, so they are stepped over. */
  private step(by: 1 | -1): void {
    const els = this.list.querySelectorAll<HTMLElement>(".w-row");
    let i = this.sel + by;
    while (i >= 0 && i < els.length && els[i].closest(".w-day.folded, .w-grp.later")) i += by;
    if (i < 0 && by < 0) return this.select(-1, true);
    if (i >= els.length) return;
    this.select(i, true);
  }

  private select(i: number, scroll = false): void {
    const els = this.list.querySelectorAll<HTMLElement>(".w-row");
    els.forEach((x) => x.classList.remove("sel"));
    this.sel = Math.max(-1, Math.min(i, this.vis.length - 1));
    const at = els[this.sel];
    if (at) {
      at.classList.add("sel");
      if (scroll) at.scrollIntoView({ block: "nearest" });
    }
    // An open pane follows the pick.
    if (this.viewer.open) this.viewer.show(this.vis.filter(previewable), this.vis[this.sel] ?? null);
  }

  /** Open row `r`. A picture, video or page previews in the pane, unless
   *  `elsewhere` (the pane's own "open in a tab") or ⌘ sends it on. */
  private async open(r: Row, sub: string, e?: MouseEvent | KeyboardEvent, elsewhere = false): Promise<void> {
    // Open in cmux, as /artifacts does: beside the workspace in front.
    const toCmux = async () => {
      const o = await invoke<{ detail: string }>("wake_open", { id: r.id, sub, here: false });
      if (o.detail) this.toast(o.detail);
    };
    try {
      if (e?.metaKey) return await toCmux();
      if (!elsewhere && !sub && previewable(r)) {
        const i = this.vis.findIndex((x) => x.id === r.id);
        if (i >= 0 && i !== this.sel) this.select(i);
        this.viewer.show(this.vis.filter(previewable), r);
        // The pane took room from the list: keep the picked row in sight.
        requestAnimationFrame(() => this.list.querySelector(".w-row.sel")?.scrollIntoView({ block: "nearest" }));
        return;
      }
      if (r.path && PREVIEW.test(r.path) && r.state !== "gone" && !["plan", "review", "ask", "commit", "artifact"].includes(r.kind)) {
        try {
          // A video streams from the app's wakefile: scheme, too big for a data: URL.
          const shown: Shown = mediaOf(r.path) === "video"
            ? { kind: "video", title: r.path.split("/").pop() || r.title, data: fileUrl(r) }
            : await invoke<Shown>("wake_file", { id: r.id });
          return this.host ? this.host.show(shown, toCmux, this.host.here()) : sheet().show(shown, toCmux, { dir: r.ws });
        } catch (err) {
          this.toast(`${String(err)} · opening it in cmux`, true);
          return await toCmux();
        }
      }
      const o = await invoke<{ sheet: string | null; detail: string }>("wake_open", { id: r.id, sub, here: true });
      if (o.sheet && this.host) await this.host.open({ path: o.sheet, title: r.title || r.locator, toCmux, ...this.host.here() });
      else if (o.sheet) await sheet().open({ path: o.sheet, title: r.title || r.locator, toCmux, dir: r.ws });
      else if (o.detail) this.toast(o.detail);
    } catch (err) {
      this.toast(String(err), true);
    }
  }

  private async keep(r: Row | undefined): Promise<void> {
    if (!r || r.state !== "risk") return;
    try {
      const j = await invoke<{ path?: string }>("wake_keep", { id: r.id });
      this.toast(`kept → ${j.path ?? ""}`);
      void this.load(true);
    } catch (e) {
      this.toast(`not kept: ${String(e)}`, true);
    }
  }

  /** The first click asks, naming the file and where it goes; a second within 4 s sends. */
  private async publish(r: Row, b: HTMLButtonElement): Promise<void> {
    if (b.disabled) return;
    const label = r.published ? "publish again" : "publish";
    if (!b.classList.contains("sure")) {
      arm(b);
      b.classList.add("sure");
      b.textContent = `send ${r.path.split("/").pop()} to claude.ai?`;
      const t = window.setTimeout(() => {
        if (b.isConnected && !b.disabled) {
          b.classList.remove("sure");
          b.textContent = label;
        }
      }, 4000);
      b.dataset.timer = String(t);
      return;
    }
    if (tooSoon(b)) return;
    clearTimeout(Number(b.dataset.timer));
    b.classList.remove("sure");
    b.disabled = true;
    b.textContent = "publishing…";
    try {
      this.toast(await invoke<string>("wake_publish", { id: r.id }));
      b.textContent = "sent to a terminal";
    } catch (e) {
      this.toast(String(e), true);
      b.textContent = label;
      b.disabled = false;
    }
  }

  private async keepAll(): Promise<void> {
    const b = this.keepAllBtn;
    if (!b.classList.contains("sure")) {
      arm(b);
      b.classList.add("sure");
      b.textContent = `sure? copy ${this.data.truncated ? "at least " : ""}${b.dataset.n} files`;
      clearTimeout(Number(b.dataset.timer));
      b.dataset.timer = String(
        window.setTimeout(() => {
          b.classList.remove("sure");
          b.textContent = `keep all ${b.dataset.n}`;
        }, 3500),
      );
      return;
    }
    if (tooSoon(b)) return;
    clearTimeout(Number(b.dataset.timer));
    b.classList.remove("sure");
    try {
      const j = await invoke<{ results?: { ok: boolean; why?: string }[] }>("wake_keep_all", { ws: this.ws });
      const res = j.results ?? [];
      const ok = res.filter((x) => x.ok).length;
      const no = res.length - ok;
      this.toast(`kept ${ok}${no ? ` · refused ${no}` : ""}`, !!no);
      void this.load(true);
    } catch (e) {
      this.toast(String(e), true);
    }
  }

  private async copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(`copied ${what}`);
    } catch {
      this.toast(`could not copy ${what}`, true);
    }
  }

  private key(e: KeyboardEvent): void {
    if (!this.visible() || e.ctrlKey || e.altKey) return;
    // The Wake tab yields to the sheet; the sheet's own Wake has the keys there.
    // Only an overlay sheet counts: the Dock's own sheet is always there,
    // hidden or not by its view, and visible() already covers that.
    const overlay = document.querySelector(".sheet:not(.embedded):not([hidden])");
    if (overlay ? !overlay.contains(this.root) : false) return;
    // Only keys meant for the Wake: focus in it, or nowhere in particular.
    // The Dock's terminal (a textarea), a framed page or any other control
    // keeps its own keys, so Space and j/k typed there stay there.
    const at = document.activeElement;
    if (at && at !== document.body && !this.root.contains(at)) return;
    const inQ = document.activeElement === this.q;
    if (e.key === "Escape") {
      if (!this.help.hidden) {
        this.help.hidden = true;
      } else if (this.viewer.open && !inQ) {
        this.viewer.close();
      } else if (this.q.value || inQ) {
        this.q.value = "";
        this.query = "";
        this.q.blur();
        void this.load();
      } else return; // nothing of the Wake's open: Escape hides the window
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
    if (inQ) {
      if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        this.q.blur();
        this.select(0, true);
      }
      return;
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLSelectElement || focused instanceof HTMLInputElement) return;
    // A focused button takes its own Enter and Space; a video its own arrows.
    if (focused instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
    if (focused instanceof HTMLMediaElement) return;
    if (this.viewer.open && !e.metaKey && !e.shiftKey) {
      const flip = e.key === "ArrowLeft" || e.key === "h" ? -1 : e.key === "ArrowRight" || e.key === "l" ? 1 : 0;
      if (flip) {
        e.preventDefault();
        return this.viewer.step(flip);
      }
      if (e.key === "f") return this.viewer.toggleFull();
      if (e.key === "v") return this.viewer.flipLayout();
    }
    const r = this.vis[this.sel];
    if (e.metaKey) {
      if (e.key === "Enter" && r) {
        e.preventDefault();
        void this.open(r, "", e);
      }
      return;
    }
    switch (e.key) {
      case "/":
        e.preventDefault();
        this.q.focus();
        this.q.select();
        break;
      case "j":
      case "ArrowDown":
        e.preventDefault();
        this.step(1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        this.step(-1);
        break;
      case "Enter":
        if (r) {
          e.preventDefault();
          void this.open(r, "");
        }
        break;
      case " ":
        if (r) {
          e.preventDefault();
          this.list.querySelectorAll(".w-row")[this.sel]?.closest(".w-grp")?.querySelector<HTMLElement>(".w-prompt")?.click();
        }
        break;
      case "K":
        void this.keep(r);
        break;
      case "c":
        if (r?.path) void this.copy(r.path, "the path");
        break;
      case "r":
        if (r?.session_id) void this.copy(resumeCmd(r), "the resume command");
        break;
      case "?":
        this.help.hidden = !this.help.hidden;
        break;
    }
  }
}
