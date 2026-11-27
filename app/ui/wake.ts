import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Sheet, Shown } from "./sheet";
import { openElsewhere } from "./panelinks";
import { dotsMenu, type MenuItem, type TuckRow } from "./tuck";
import { fileUrl, mediaOf, PREVIEW, previewable, thumbUrl, Viewer } from "./wakeview";
import { age, badgeOf, byUrl, groupOf, type Group, type Pr } from "./prs";
import { chipFor, readLandings, type Landing, type PrRow } from "./release";
import { backgroundTask, dayOf, lanesOf, needsOf, reviewName, SHELF_SAID, shelves, stageSaid, stepKey, turns, type Lane, type Need, type PlanRow, type ReviewSum, type ShelfId, type ShelfPr, type Turn } from "./wakeshelf";

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


export const KINDS = ["plan", "review", "ask", "artifact", "doc", "temp", "image", "video", "file", "commit", "turn", "pr", "issue"];

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
  private stats = el("span", "w-stats");
  private picker = el("select", "w-ws");
  private q = el("input", "w-q");
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
  private openGroups = new Set<string>();
  /** Days the person folded or opened by hand, over the default (older days
   *  fold when the list is long). */
  private dayFold = new Map<string, boolean>();
  /** The rows shown, in reading order: the preview strip flips through them. */
  private vis: Row[] = [];
  /** The picked item: a row, a pull request's lane, a review or a Needs you
   *  tile, by key (wakeshelf.ts). j and k walk the keys the page shows, in
   *  the order it shows them. */
  private selKey: string | null = null;
  /** What Enter, c and the rest do to each key drawn. */
  private acts = new Map<string, { row?: Row; open: (e?: MouseEvent | KeyboardEvent) => void; copy?: () => void }>();
  /** Shelves (the default) or Timeline, kept across launches. */
  private mode: "shelves" | "timeline" = (() => {
    try {
      return localStorage.getItem("seamux.wake.mode") === "timeline" ? "timeline" : "shelves";
    } catch {
      return "shelves";
    }
  })();
  private modeBtns = { shelves: button("Shelves", "w-seg-b"), timeline: button("Timeline", "w-seg-b") };
  /** lookout's reviews of the worktree, and its plans. */
  private reviews: ReviewSum[] = [];
  private plans: PlanRow[] = [];
  private sideWs = "";
  private sideAt = 0;
  /** The past reviews' search, and whether older ones and older lanes show. */
  private pastQ = "";
  private pastAll = false;
  private lanesAll = false;
  /** Shelves opened past their first page ("show N more"). */
  private shelfAll = new Set<ShelfId>();
  /** Gone rows the person unfolded: a shelf's id, or a card's "<turn>:<shelf>". */
  private goneOpen = new Set<string>();
  /** A card's sections opened past their first few: "<turn>:<shelf>". */
  private moreOpen = new Set<string>();
  /** Each row's turn, for Space's prompt on Shelves (built once per draw). */
  private turnIdx = new Map<number, Turn<Row>>();
  private cards: Turn<Row>[] = [];
  /** Needs you's keep-all, made once so its ask-then-confirm survives a redraw. */
  private riskKeep = button("", "w-act");
  /** Thumbnails by row id, kept across redraws so a picture is not fetched
   *  again: a search, a switch to Timeline and back, or a poll redraws them
   *  from here. Let go only when another worktree is shown. */
  private thumbs = new Map<number, HTMLElement>();
  private thumbsWs = "";
  /** Shelves: the turn prompt Space showed for the picked row, under the
   *  list; it follows the pick until Space or Esc closes it. */
  private turnP = el("div", "w-turnp");
  private turnOn = false;
  private turnRow = -1;
  /** Timeline: cards Space opened, latest last, for Esc to close in turn. */
  private spaceOpened: string[] = [];
  private home = "";
  private seq = 0;
  private lastTop = -1;
  /** Muted and tucked worktrees, from the views feed: tucked ones sink in the picker. */
  private tucked: TuckRow[] = [];
  /** The worktree's pull requests (crew-sync's list, wake_prs), for the
   *  Pull requests block and the pr rows' badges; when they were read. */
  private prs: Pr[] = [];
  /** Each merged PR's landing by its merge commit (land_watch.rs). */
  private lands = new Map<string, Landing | null>();
  /** `prs` by canonical URL, for the pr rows' badges: built once per read. */
  private prsByUrl = new Map<string, Pr>();
  private prsAt = 0;
  private prsWs = "";
  /** A group the Dock's pill asked for, and for which worktree ("" for the
   *  next one shown): scrolled to and marked once that worktree's block is drawn. */
  private prsFocus: Group | null = null;
  private prsFocusDir = "";
  /** The pill's group as it asked: "open" is every open group. */
  private prsAsk = "";
  /** The directory the sheet last asked for, as it spelled it: `ws` takes
   *  the store's realpath'd spelling once read, so a focus matches either. */
  private askedDir = "";

  /** The Wake is a tab of a sheet, `host`, and has no page of its own:
   *  what it opens goes there, beside it, for the workspace shown. */
  constructor(readonly root: HTMLElement, private host: Sheet) {
    root.classList.add("wake");
    this.picker.setAttribute("aria-label", "workspace");
    this.picker.addEventListener("change", () => {
      this.clearPreview();
      this.ws = this.picker.value;
      this.also = [];
      this.picked = true;
      this.selKey = null;
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
    const keys = button("keys", "w-act w-keys");
    keys.title = "the keyboard keys (?)";
    keys.addEventListener("click", () => (this.help.hidden = !this.help.hidden));
    this.help.hidden = true;
    // Grouped: moving, acting on the pick, the preview, and the app's pages.
    const groups: [string, [string, string][]][] = [
      ["Move", [["j k", "next · previous, shelf by shelf (a ▸ fold is a stop: Enter opens it)"], ["t", "Shelves or Timeline"], ["/", "search · Esc clears"]]],
      ["The picked item", [
        ["Enter", "preview a picture, video or page; open the rest (⌘ opens it outside the Wake)"],
        ["Space", "the whole prompt of its turn; again to hide it"],
        ["⇧K", "keep a file at risk"],
        ["c", "copy the path (a pull request's link)"],
        ["r", "copy the resume command"],
      ]],
      ["Preview", [["← → h l", "flip through the previews"], ["v", "beside · under the list"], ["f", "fill the Wake"]]],
      ["Close", [["Esc", "the keys, the preview, a prompt, then the search; then the window"], ["?", "these keys"]]],
      ["Pages beside the terminal", [
        ["⌘E", "the Wake, and again back to the page you were on"],
        ["⌘⇧P ⌘⇧L ⌘⇧A ⌘⇧O", "the plan, review, ask or other pages; again for the next"],
        ["⌘[ ⌘]", "the previous · next page"],
        ["⌘⇧E", "hide or show the column"],
      ]],
    ];
    this.help.append(
      el("h3", "", "Keys"),
      ...groups.flatMap(([g, rows]) => [
        el("h4", "", g),
        ...rows.map(([k, v]) => {
          const p = el("p");
          p.append(el("b", "", k), document.createTextNode(`  ${v}`));
          return p;
        }),
      ]),
    );
    this.help.addEventListener("click", () => (this.help.hidden = true));

    const head = el("header", "w-head");
    const ttl = el("div", "w-ttl");
    const sub = el("div", "w-sub");
    sub.append(this.stats);
    // The sheet already names the workspace.
    ttl.append(sub);
    const seg = el("div", "w-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "layout");
    for (const m of ["shelves", "timeline"] as const) {
      const b = this.modeBtns[m];
      b.title = m === "shelves" ? "what is here, by kind (t)" : "what each turn left, newest first (t)";
      b.addEventListener("click", () => this.setMode(m));
      seg.append(b);
    }
    head.append(ttl, this.picker, seg);
    const bar = el("div", "w-bar");
    bar.append(this.q, keys);
    this.toastEl.setAttribute("role", "status");
    const main = el("div", "w-main");
    this.turnP.hidden = true;
    this.turnP.setAttribute("role", "region");
    this.turnP.setAttribute("aria-label", "the turn's prompt");
    main.append(head, bar, this.list, this.turnP);
    this.viewer = new Viewer(root, {
      pick: (r) => this.reveal(r),
      openElsewhere: (r, e) => void this.open(r, "", e, true),
      closed: () => this.list.querySelector<HTMLElement>(".w-row.sel")?.scrollIntoView({ block: "nearest" }),
      when: (r) => {
        const d = local(r.created_at);
        const t = this.turnIdx.get(r.id);
        const bg = backgroundTask(r.prompt);
        const said = t?.prompt || (bg !== null ? `a background task: ${bg}` : r.prompt);
        return [r.kind, d ? `${dayLabel(d)} ${hm(d)}` : "", said || SOURCE[r.source] || ""].filter(Boolean).join(" · ");
      },
    });
    root.replaceChildren(main, this.viewer.gripX, this.viewer.gripY, this.viewer.el, this.help, this.toastEl);
    // A click in the Wake gives it the keys: a tab button or the Dock's
    // terminal focused elsewhere would keep j/k and ← → otherwise.
    root.addEventListener("pointerdown", () => {
      const at = document.activeElement;
      if (at instanceof HTMLElement && at !== document.body && !root.contains(at)) at.blur();
    });
    // Escape in the capture phase: the app's own listener (main.ts) hides
    // the window on any Escape not taken before it, and it is registered
    // first. Taken here, Esc closes the Wake's topmost open thing; with
    // nothing open it goes on, and the window hides. Other keys bubble.
    document.addEventListener("keydown", (e) => e.key === "Escape" && this.key(e), true);
    document.addEventListener("keydown", (e) => e.key !== "Escape" && this.key(e));
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
      if (this.visible() && Date.now() - this.sideAt > 30_000) void this.loadSide();
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

  /** Show the Wake of the worktree at `dir` (the sheet's workspace), fresh,
   *  with the rows filed under `also` too: the roots of the plans, reviews
   *  and asks that workspace has open, which may sit outside `dir`. */
  showDir(dir: string, also: string[] = []): void {
    this.picked = false;
    this.askedDir = dir;
    this.also = [...new Set(also.filter((d) => d && d !== dir))];
    if (dir && dir !== this.ws) {
      this.clearPreview();
      this.ws = dir;
      this.selKey = null;
      this.q.value = "";
      this.query = "";
      void this.load();
    } else void this.load(true);
  }

  /** Another workspace: the preview of the last one's file goes (a video
   *  stops), and full-size with it. Where it opens (beside or under the
   *  list) is a choice kept across workspaces. */
  clearPreview(): void {
    this.viewer.close();
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
  showPrs(group: string, dir = ""): void {
    const g: Group = group === "people" ? "people" : group === "draft" ? "draft" : group === "done" ? "done" : "open";
    this.prsFocus = g === "open" ? "you" : g;
    this.prsAsk = g;
    // Finished pull requests past the newest fold behind "older": asked for, they show.
    if (g === "done") this.lanesAll = true;
    // The lanes are on Shelves: shown there this once, the person's own
    // choice of layout left as it was.
    this.mode = "shelves";
    this.prsFocusDir = dir;
    if (!dir || this.focusHere(dir)) void this.loadPrs();
  }

  /** Whether `dir` (as the sheet spells it) is the worktree shown. */
  private focusHere(dir: string): boolean {
    const t = (d: string) => d.replace(/\/+$/, "");
    return !dir || t(dir) === t(this.ws) || (t(dir) === t(this.askedDir) && this.ws === this.prsWs);
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
      this.prsByUrl = byUrl(this.prs);
      const landsMoved = await readLandings(this.prs.map((p) => ({ cwd: ws, merge: p.merge })), this.lands,
        (cwd, merge) => invoke<Landing | null>("landing_get", { cwd, merge }));
      if (ws !== this.ws) return;
      this.prsWs = ws;
      const mine = this.prsFocus && this.focusHere(this.prsFocusDir);
      // A focus asked for a worktree with no PRs has nothing to scroll to.
      if (mine && !this.prs.length) this.prsFocus = null;
      if ((!same || mine || landsMoved) && this.data.workspaces.length) this.draw();
    } catch {
      /* no list: the block stays away */
    }
  }

  /** lookout's reviews and deep-plan's plans for the worktree: the Reviews
   *  shelf, Needs you's reviews and the turn cards' names. Redrawn on change. */
  private async loadSide(): Promise<void> {
    const ws = this.ws;
    this.sideAt = Date.now();
    if (!ws) return;
    const [reviews, plans] = await Promise.all([
      invoke<ReviewSum[]>("wake_reviews", { dir: ws }).catch(() => [] as ReviewSum[]),
      invoke<PlanRow[]>("wake_plans", { dir: ws }).catch(() => [] as PlanRow[]),
    ]);
    if (ws !== this.ws) return;
    const same = ws === this.sideWs && JSON.stringify([reviews, plans]) === JSON.stringify([this.reviews, this.plans]);
    this.reviews = Array.isArray(reviews) ? reviews : [];
    this.plans = Array.isArray(plans) ? plans : [];
    this.sideWs = ws;
    if (!same && this.data.workspaces.length) this.draw();
  }

  /** Shelves or Timeline; the pick stays where both show it. */
  private setMode(m: "shelves" | "timeline"): void {
    if (m === this.mode) return;
    this.mode = m;
    try {
      localStorage.setItem("seamux.wake.mode", m);
    } catch {
      /* kept for this run only */
    }
    this.draw();
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
      if (this.ws !== this.sideWs || Date.now() - this.sideAt > 30_000) void this.loadSide();
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

    const rows = this.data.rows;

    // Stats and keep all.
    const risk = rows.filter((r) => r.state === "risk").length;
    const kept = rows.filter((r) => r.state === "kept").length;
    const gone = rows.filter((r) => r.state === "gone").length;
    // What still exists leads; gone is a muted count; a read cut at its
    // limit says so against the picker's total.
    const here = rows.length - gone;
    const total = this.data.workspaces.find((w) => w.ws === this.ws)?.n ?? rows.length;
    const n = (x: number) => x.toLocaleString();
    const bits: (string | HTMLElement)[] = this.query
      ? [el("b", "", n(here)), ` for “${this.query}”`]
      : [el("b", "", n(here)), ` ${here === 1 ? "thing" : "things"} left behind`];
    if (risk) bits.push(" · ", el("span", "risk", `${n(risk)} at risk`));
    if (kept) bits.push(" · ", el("span", "kept", `${n(kept)} kept`));
    if (gone) bits.push(" · ", el("span", "w-gone-n", `${n(gone)} gone`));
    if (this.data.truncated) bits.push(el("span", "w-trunc", `newest ${n(this.data.limit)} of ${n(total)} read; search to reach older`));
    this.stats.replaceChildren(...bits);
    for (const m of ["shelves", "timeline"] as const) this.modeBtns[m].setAttribute("aria-pressed", String(this.mode === m));
    this.acts.clear();
    this.cards = turns(this.shelfInput());
    this.turnIdx = new Map(this.cards.flatMap((t) => t.sections.flatMap((sec) => sec.rows.map((r) => [r.id, t] as const))));
    if (this.mode === "shelves") return this.drawShelves();

    return this.drawTimeline();
  }

  // ------------------------------------------------------------ shelves

  /** The Shelves layout (the chart wake-landing v9): Needs you, or one calm
   *  line; Reviews; Plans and asks; Pull requests and landings; Pictures and
   *  recordings; Files; Commits. A shelf with nothing on it is left out. */
  private drawShelves(): void {
    // Read before the box below moves the search box (the move itself blurs it).
    const typing = document.activeElement === this.pastQEl ? this.pastQEl.selectionStart : null;
    const q = this.query.toLowerCase();
    const hit = (t: string) => !q || t.toLowerCase().includes(q);
    const s = shelves(this.shelfInput());
    const out: HTMLElement[] = [];
    const shelf = (id: ShelfId, count: string, ...body: HTMLElement[]) => out.push(this.shelfEl(id, count, ...body));
    // A long shelf shows its first page; the rest wait behind "show N more"
    // (a search shows every match).
    const page = (id: ShelfId, rows: Row[], n: number) => (q || this.shelfAll.has(id) ? rows : rows.slice(0, n));
    const more = (id: ShelfId, all: number, shown: number) =>
      all > shown ? [this.fold(`${all - shown} more`, () => this.shelfAll.add(id), false, `fold:more:${id}`)] : [];
    // Gone rows wait behind their own fold, after what still exists.
    const shownRows: Row[] = [];
    const goneFold = (key: string, gone: number) =>
      gone ? [this.fold(this.goneOpen.has(key) ? `hide ${gone} gone` : `${gone} gone`, () => (this.goneOpen.has(key) ? this.goneOpen.delete(key) : this.goneOpen.add(key)), this.goneOpen.has(key), `fold:gone:${key}`)] : [];
    const split = (rows: Row[]) => ({ here: rows.filter((r) => r.state !== "gone"), gone: rows.filter((r) => r.state === "gone") });
    const list = (id: ShelfId, rows: Row[]) => {
      const { here, gone } = split(rows);
      const shown = [...page(id, here, 12), ...(this.goneOpen.has(id) ? gone : [])];
      shownRows.push(...shown);
      const ul = el("ul", "w-rows w-box");
      // Two rows of one name show their folders, which tell them apart.
      const seen = new Map<string, number>();
      for (const r of shown) seen.set(r.title, (seen.get(r.title) ?? 0) + 1);
      for (const r of shown) {
        const li = this.row(r);
        li.classList.toggle("dup", (seen.get(r.title) ?? 0) > 1);
        ul.append(li);
      }
      return [...(shown.length ? [ul] : []), ...more(id, here.length, Math.min(here.length, page(id, here, 12).length)), ...goneFold(id, gone.length)];
    };
    // A shelf counts what is here; its fold says what is gone.
    const counted = (rows: Row[]) => String(rows.filter((r) => r.state !== "gone").length);
    // A search asks about things by name: Needs you steps aside.
    if (!q) out.push(this.needsBlock(s.needs));
    const live = s.reviews.live.filter((r) => hit(r.title));
    const pq = this.pastQ.toLowerCase();
    const past = s.reviews.past.filter((r) => hit(r.title) && (!pq || `${r.title} ${r.plan}`.toLowerCase().includes(pq)));
    if (live.length || s.reviews.past.length) {
      const body: HTMLElement[] = [];
      if (live.length) body.push(this.box("Live", null, live.map((r) => this.reviewRow(r))));
      if (s.reviews.past.length) {
        const shown = this.pastAll || pq ? past : past.slice(0, 2);
        const items = shown.map((r) => this.pastRow(r));
        if (past.length > shown.length) items.push(this.fold(`${past.length - shown.length} older review${past.length - shown.length === 1 ? "" : "s"}`, () => (this.pastAll = true), false, "fold:past"));
        if (!items.length) items.push(el("div", "w-none", `no past review matches “${this.pastQ || this.query}”`));
        body.push(this.box("Past", this.pastQEl, items));
      }
      shelf("reviews", `${live.length} live · ${q || pq ? past.length : s.reviews.past.length} past`, ...body);
    }
    const plans = s.plans;
    if (plans.length) shelf("plans", String(plans.length), ...list("plans", plans));
    const planRows = shownRows.splice(0);
    const lanes = s.lanes.filter((l) => hit(`#${l.pr.n} ${l.pr.title}`));
    if (lanes.length) {
      const shown = lanes.filter((l) => this.lanesAll || !l.fold || q);
      const t = el("div", "w-lanes w-box");
      const hd = el("div", "w-lane-hd");
      // Narrow, each stage keeps its first letter (wake.css).
      hd.append(el("span", "", "pull request"), ...["review", "checks", "merged", "landed"].map((x) => {
        const c = el("span", "", x);
        c.dataset.s = x[0].toUpperCase();
        return c;
      }));
      t.append(hd, ...shown.map((l) => this.laneRow(l)));
      const extra = lanes.length - shown.length;
      shelf("prs", String(lanes.length), t, ...(extra ? [this.fold(`${extra} older pull request${extra === 1 ? "" : "s"}`, () => (this.lanesAll = true), false, "fold:lanes")] : []));
    }
    const picSplit = split(s.pictures);
    const pics = [...page("pictures", picSplit.here, 12), ...(this.goneOpen.has("pictures") ? picSplit.gone : [])];
    if (s.pictures.length) {
      const g = el("div", "w-thumbs");
      for (const r of pics) g.append(this.thumb(r));
      shelf("pictures", counted(s.pictures), ...(pics.length ? [g] : []),
        ...more("pictures", picSplit.here.length, Math.min(picSplit.here.length, page("pictures", picSplit.here, 12).length)), ...goneFold("pictures", picSplit.gone.length));
    }
    if (s.files.length) shelf("files", counted(s.files), ...list("files", s.files));
    if (s.commits.length) shelf("commits", String(s.commits.length), ...list("commits", s.commits));
    // Thumbnails of rows gone from the worktree are let go; a search's
    // narrower list keeps the rest for when it clears.
    if (!this.query) {
      const ids = new Set(this.data.rows.map((r) => r.id));
      for (const id of [...this.thumbs.keys()]) if (!ids.has(id)) this.thumbs.delete(id);
    }
    if (!this.data.rows.length && !out.some((x) => x.classList.contains("w-shelf"))) {
      const e = el("div", "w-empty");
      e.textContent = this.query
        ? `nothing in the wake matches “${this.query}”`
        : this.ws
          ? "nothing in this workspace's wake yet. Each file, plan or commit a session makes shows up here when its turn ends."
          : "no workspace yet.";
      out.push(e);
    }
    // The preview strip flips through what the page shows, in its order.
    const [fileRows, commitRows] = [shownRows.filter((r) => s.files.includes(r)), shownRows.filter((r) => s.commits.includes(r))];
    this.vis = [...planRows, ...pics, ...fileRows, ...commitRows];
    this.list.classList.toggle("searching", !!this.query);
    // Moving the past reviews' search box blurs it: someone typing in it keeps
    // their focus and caret across the redraw their typing caused.
    this.list.replaceChildren(...out);
    if (typing !== null && this.pastQEl.isConnected) {
      this.pastQEl.focus();
      this.pastQEl.setSelectionRange(typing, typing);
    }
    // The Dock's PR pill asked for this worktree's pull requests.
    if (this.prsFocus && this.focusHere(this.prsFocusDir) && this.ws === this.prsWs) {
      const at = this.list.querySelector<HTMLElement>(".w-shelf.prs");
      // Kept until the shelf shows (a search can hide every lane); a worktree
      // with no pull requests lets it go in loadPrs.
      if (at) {
        // The first lane of the group asked for is picked, so j and k and
        // Enter start there; "open" is the first lane not finished.
        const want = this.prsAsk;
        const lane = s.lanes.find((l) => (want === "open" || !want ? l.pr.group !== "done" : l.pr.group === want));
        const laneEl = lane ? at.querySelector<HTMLElement>(`.w-lane[data-key="${CSS.escape(lane.key)}"]`) : null;
        at.classList.add("asked");
        if (laneEl && lane) {
          this.list.querySelectorAll(".sel[data-key]").forEach((x) => x.classList.remove("sel"));
          this.selKey = lane.key;
          at.scrollIntoView({ block: "start" });
          laneEl.scrollIntoView({ block: "nearest" });
        } else at.scrollIntoView({ block: "start" });
        this.prsFocus = null;
      }
    }
    this.restoreSel();
  }

  /** What the model reads: this worktree's rows, pull requests with their
   *  landings, and its reviews and plans once read for it (another
   *  worktree's wait for loadSide), with the asks waiting. */
  private shelfInput() {
    return {
      ws: this.ws,
      rows: this.data.rows,
      prs: this.shelfPrs(),
      reviews: this.sideWs === this.ws ? this.reviews : [],
      plans: this.sideWs === this.ws ? this.plans : [],
    };
  }

  private shelfPrs(): ShelfPr[] {
    const prs = this.ws === this.prsWs ? this.prs : [];
    return prs.map((p) => ({ ...p, group: groupOf(p), landing: p.merge ? this.lands.get(p.merge.sha) ?? null : null }));
  }

  private shelfEl(id: ShelfId, count: string, ...body: HTMLElement[]): HTMLElement {
    const sec = el("section", `w-shelf ${id}`);
    sec.dataset.shelf = id;
    sec.setAttribute("aria-label", SHELF_SAID[id]);
    const h = el("h2", "w-shelf-h");
    h.append(document.createTextNode(`${SHELF_SAID[id]} `), el("span", "w-n", count));
    sec.append(h, ...body);
    return sec;
  }

  /** Needs you's tiles, or one calm line when nothing waits. */
  private needsBlock(needs: Need[]): HTMLElement {
    // A failing pull request the board files elsewhere (a draft, say) is
    // named here, with a jump to its lane, whatever else waits.
    const red = needs.some((n) => n.kind === "pr") ? [] : this.shelfPrs().filter((p) => p.state !== "merged" && p.state !== "closed" && ((p.checks?.fail ?? 0) > 0 || p.conflict));
    const jump = () => {
      const go = button(red.length === 1 ? `#${red[0].n} is failing ↓` : `${red.length} pull requests are failing ↓`, "w-calm-red");
      go.title = "its lane on Pull requests and landings";
      go.addEventListener("click", () => this.selectKey(`pr:${red[0].n}`, true));
      return go;
    };
    if (needs.length) {
      const sec = this.shelfEl("needs", String(needs.length), this.needsGrid(needs));
      if (red.length) sec.append(jump());
      return sec;
    }
    const c = el("div", "w-calm");
    if (red.length) {
      c.classList.add("warn");
      c.append(jump(), document.createTextNode("Nothing else needs you."));
    } else c.append(el("span", "w-calm-ok", "✓"), document.createTextNode("Nothing needs you."));
    return c;
  }

  // ------------------------------------------------------------ timeline

  /** The Timeline layout (the chart's timeline mode): Needs you, then one
   *  card per turn, newest first, each split into the shelves' sections.
   *  Days past the newest fold to a count when the list is long; a search
   *  unfolds every match. */
  private drawTimeline(): void {
    const q = this.query;
    const input = this.shelfInput();
    const cards = this.cards;
    const reviews = new Map(input.reviews.map((r) => [r.id, r]));
    const lanes = new Map(lanesOf(input.prs).map((l) => [l.pr.n, l]));
    const out: HTMLElement[] = [];
    if (!q) out.push(this.needsBlock(needsOf(input)));
    const newest = cards[0]?.day ?? "";
    const per = new Map<string, number>();
    const risky = new Map<string, number>();
    for (const c of cards)
      for (const sec of c.sections) {
        per.set(c.day, (per.get(c.day) ?? 0) + sec.rows.filter((r) => r.state !== "gone").length);
        risky.set(c.day, (risky.get(c.day) ?? 0) + sec.rows.filter((r) => r.state === "risk").length);
      }
    let day = "";
    let dayEl: HTMLElement | null = null;
    let lastName: string | null = null;
    for (const c of cards) {
      if (c.day !== day) {
        day = c.day;
        const dk = day;
        const folded = !q && (this.dayFold.get(dk) ?? (dk !== newest && this.data.rows.length > 20));
        dayEl = el("section", `w-day${folded ? " folded" : ""}`);
        dayEl.dataset.day = dk;
        const n = per.get(dk) ?? 0;
        const tog = button(`${folded ? "▸" : "▾"} ${dayLabel(new Date(c.start))}${folded ? ` · ${n} thing${n === 1 ? "" : "s"}` : ""}`, "w-dayh");
        // A day's heading is a stop on the j/k walk; Enter folds or opens it.
        const dayKey = `fold:day:${dk}`;
        tog.dataset.key = dayKey;
        tog.classList.toggle("sel", dayKey === this.selKey);
        this.acts.set(dayKey, { open: () => tog.click() });
        lastName = null;
        // A folded day still says when something in it is at risk.
        const atRisk = risky.get(dk) ?? 0;
        if (folded && atRisk) tog.append(el("span", "w-dayrisk", ` · ${atRisk} at risk`));
        tog.setAttribute("aria-expanded", String(!folded));
        tog.addEventListener("click", () => {
          this.dayFold.set(dk, !folded);
          this.draw();
        });
        const h = el("h2", "");
        h.append(tog);
        dayEl.append(h);
        out.push(dayEl);
      }
      // The increment names the first of its run of turns; the rest lead
      // with their own prompts.
      dayEl!.append(this.card(c, reviews, lanes, !!c.name && c.name === lastName));
      lastName = c.name;
    }
    if (!cards.length) {
      const e = el("div", "w-empty");
      e.textContent = this.query
        ? `nothing in the wake matches “${this.query}”`
        : this.ws
          ? "nothing in this workspace's wake yet. Each file, plan or commit a session makes shows up here when its turn ends."
          : "no workspace yet.";
      out.push(e);
    }
    this.vis = this.cardRows.splice(0);
    this.list.classList.toggle("searching", !!this.query);
    this.list.replaceChildren(...out);
    this.restoreSel();
  }

  /** The rows the cards drew, in order, for the preview strip. */
  private cardRows: Row[] = [];

  /** One turn's card: its prompt (Space or a click opens it whole), the
   *  increment it belongs to, its time span and resume, then its sections.
   *  A pull request the worktree knows draws as its lane, a review lookout
   *  knows as its stage, as on the shelves. */
  private card(c: Turn<Row>, reviews: Map<string, ReviewSum>, lanes: Map<number, Lane>, again = false): HTMLElement {
    // One heading grammar: the increment the turn ran when there is one, else
    // the person's prompt; under it the time, background tasks and, under an
    // increment, the prompt itself, muted.
    const named = !!c.name && !again;
    const a = el("article", `w-card${this.openGroups.has(c.key) ? " open" : ""}${named ? " named" : ""}`);
    const first = c.sections[0]?.rows[0];
    const hd = el("div", "w-card-hd");
    const said = c.prompt || (c.background.length ? `a background task: ${c.background[0]}` : "");
    const prompt = el("span", `w-prompt${c.prompt ? "" : " none"}`);
    prompt.title = said;
    prompt.append(said ? marked(said, this.query) : document.createTextNode((first && SOURCE[first.source]) ?? "no prompt recorded"));
    a.dataset.turn = c.key;
    // A click anywhere on the heading opens or closes the card, but its buttons.
    hd.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, a")) return;
      this.toggleCard(c.key, a);
    });
    const meta = el("span", "w-card-m");
    if (c.name) meta.append(el("span", "w-card-n", c.name));
    const span = c.start === c.end ? hm(new Date(c.start)) : `${hm(new Date(c.start))}–${hm(new Date(c.end))}`;
    meta.append(el("time", "", span));
    // Background tasks that finished in this turn join it, as one muted count.
    if (c.prompt && c.background.length) {
      const b = el("span", "w-card-bg", `+${c.background.length} background task${c.background.length === 1 ? "" : "s"}`);
      b.title = c.background.join("\n");
      meta.append(b);
    }
    hd.append(prompt, meta);
    if (first?.session_id) {
      const sb = button("copy resume", "w-sess");
      sb.title = `copy the command that resumes session ${first.session_id.slice(0, 8)}`;
      sb.addEventListener("click", () => void this.copy(resumeCmd(first), "the resume command"));
      hd.append(sb);
    }
    // Opened (Space or a click on the prompt), the card shows its prompt
    // whole under its heading, however short, and its background tasks.
    const open = this.openGroups.has(c.key);
    prompt.setAttribute("role", "button");
    prompt.setAttribute("aria-expanded", String(open));
    // Reached by Tab too: Enter or Space on it opens or closes the card.
    prompt.tabIndex = 0;
    prompt.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      this.toggleCard(c.key, a);
    });
    const whole = el("div", "w-card-p");
    whole.hidden = !open;
    const wb = el("div", `w-turnp-b${c.prompt ? "" : " none"}`);
    wb.append(said ? marked(said, this.query) : document.createTextNode((first && SOURCE[first.source]) ?? "no prompt recorded"));
    const wh = el("div", "w-turnp-h");
    wh.append(el("b", "", "Prompt"), el("span", "w-turnp-esc", "Space or Esc closes"));
    whole.append(wh, wb);
    if (c.background.length) {
      const bl = el("div", "w-turnp-bg");
      bl.append(el("b", "", "Background tasks"), ...c.background.map((t) => el("div", "", t)));
      whole.append(bl);
    }
    a.dataset.rows = c.sections.flatMap((s) => s.rows.map((r) => r.id)).join(",");
    a.append(hd, whole);
    // A turn that left only what is gone is its heading and one fold.
    const here = c.sections.reduce((n, sec) => n + sec.rows.filter((r) => r.state !== "gone").length, 0);
    const keys = c.sections.map((sec) => `${c.key}:${sec.shelf}`);
    if (!here && !keys.some((k) => this.goneOpen.has(k))) {
      a.classList.add("stub");
      const total = c.sections.reduce((n, sec) => n + sec.rows.length, 0);
      a.append(this.fold(`${total} gone`, () => keys.forEach((k) => this.goneOpen.add(k)), false, `fold:stub:${c.key}`));
      return a;
    }
    for (const sec of c.sections) {
      const box = el("div", `w-sect ${sec.shelf}`);
      const h = el("h3", "w-sect-h");
      const gk = `${c.key}:${sec.shelf}`;
      const live = sec.rows.filter((r) => r.state !== "gone");
      const gone = sec.rows.filter((r) => r.state === "gone");
      // A card shows a few of each; the rest wait behind "N more".
      const cap = sec.shelf === "pictures" ? 4 : 5;
      const liveShown = this.query || this.moreOpen.has(gk) ? live : live.slice(0, cap);
      const rows = [...liveShown, ...(this.goneOpen.has(gk) ? gone : [])];
      this.cardRows.push(...rows);
      h.append(document.createTextNode(`${SHELF_SAID[sec.shelf]} `), el("span", "w-n", String(live.length)));
      box.append(h);
      const folds = [
        ...(live.length > liveShown.length ? [this.fold(`${live.length - liveShown.length} more`, () => this.moreOpen.add(gk), false, `fold:more:${gk}`)] : []),
        ...(gone.length
          ? [this.fold(this.goneOpen.has(gk) ? `hide ${gone.length} gone` : `${gone.length} gone`, () => (this.goneOpen.has(gk) ? this.goneOpen.delete(gk) : this.goneOpen.add(gk)), this.goneOpen.has(gk), `fold:gone:${gk}`)]
          : []),
      ];
      if (sec.shelf === "pictures") {
        const g = el("div", "w-thumbs");
        for (const r of rows) g.append(this.thumb(r));
        if (rows.length) box.append(g);
      } else {
        const ul = el("ul", "w-rows");
        for (const r of rows) {
          const gh = ghLink(r);
          const pr = sec.shelf === "prs" && gh ? this.prsByUrl.get(`https://github.com/${gh.repo}/pull/${gh.n}`) : undefined;
          const rv = sec.shelf === "reviews" ? reviews.get(r.locator) : undefined;
          const lane = pr ? lanes.get(pr.n) : undefined;
          if (lane) {
            ul.append(this.li(this.laneRow({ ...lane, fold: false }, c.key)));
            continue;
          }
          if (rv) {
            ul.append(this.li(this.reviewRow(rv, c.key)));
            continue;
          }
          ul.append(this.row(r));
        }
        if (rows.length) box.append(ul);
      }
      box.append(...folds);
      a.append(box);
    }
    return a;
  }

  /** Open or close a card's whole prompt. The latest opened is the first
   *  one Esc closes. */
  private toggleCard(key: string, a: HTMLElement): void {
    this.setCard(key, a, !this.openGroups.has(key));
  }

  private setCard(key: string, a: HTMLElement, open: boolean): void {
    if (open) this.openGroups.add(key);
    else this.openGroups.delete(key);
    this.spaceOpened = this.spaceOpened.filter((k) => k !== key);
    if (open) this.spaceOpened.push(key);
    a.classList.toggle("open", open);
    a.querySelector(".w-card-hd .w-prompt")?.setAttribute("aria-expanded", String(open));
    const whole = a.querySelector<HTMLElement>(".w-card-p");
    if (whole) whole.hidden = !open;
    if (open) (whole ?? a).scrollIntoView({ block: "nearest" });
  }

  /** The row a pick came from, for its turn: a row itself, or the row a
   *  pull request's lane, a review or a Needs you tile stands for. */
  private rowFor(key: string | null): Row | undefined {
    if (!key) return undefined;
    const direct = this.acts.get(key)?.row;
    if (direct) return direct;
    // A lane or review drawn inside a card carries "@turn:<id>".
    const k = key.replace(/@turn:[^@]*$/, "");
    const at = k.indexOf(":");
    const kind = at < 0 ? k : k.slice(0, at);
    const v = at < 0 ? "" : k.slice(at + 1);
    const rows = this.data.rows;
    if (kind === "pr" || kind === "needpr" || kind === "land") return rows.find((r) => r.kind === "pr" && ghLink(r)?.n === v);
    if (kind === "review" || kind === "needreview") return rows.find((r) => r.kind === "review" && r.locator === v);
    if (kind === "risk") return rows.find((r) => r.state === "risk");
    return undefined;
  }

  /** Timeline: the card that holds the pick, or the card of the turn the
   *  pick came from; with nothing picked, the first card. */
  private cardFor(key: string | null): HTMLElement | null {
    if (!key) return this.list.querySelector<HTMLElement>(".w-day:not(.folded) .w-card");
    const at = this.list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.closest<HTMLElement>(".w-card");
    if (at) return at;
    const r = this.rowFor(key);
    if (!r) return null;
    return [...this.list.querySelectorAll<HTMLElement>(".w-card")].find((c) => (c.dataset.rows ?? "").split(",").includes(String(r.id))) ?? null;
  }

  /** Shelves: the picked row's turn prompt under the list, while Space has
   *  it on and the pick is a row. Hidden on Timeline, where each card holds
   *  its own. */
  private showTurn(): void {
    const on = this.turnOn && this.mode === "shelves" && !!this.selKey && !this.selKey.startsWith("fold:");
    const r = on ? this.rowFor(this.selKey) : undefined;
    this.turnP.hidden = !on;
    if (!on) return;
    if (!r) {
      // A pick no turn in this Wake made (a pull request crew-sync found, a
      // review opened by hand): said so, rather than nothing.
      this.turnRow = -1;
      const at = this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(this.selKey!)}"]`);
      const name = (at?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const hd = el("div", "w-turnp-h");
      hd.append(el("b", "", "Prompt"), el("span", "w-turnp-m", name), el("span", "w-turnp-esc", "Space or Esc closes"));
      this.turnP.replaceChildren(hd, el("div", "w-turnp-b none", "no turn in this Wake made it, so there is no prompt to show"));
      return;
    }
    if (this.turnRow !== r.id) {
      this.turnRow = r.id;
      this.turnP.scrollTop = 0;
    }
    // The turn it came from, as its Timeline card names it: the increment,
    // the person's prompt (a background task's row takes the prompt before
    // it), and the background task that made it.
    const t = this.turnIdx.get(r.id);
    const bg = backgroundTask(r.prompt);
    const said = t ? t.prompt : bg === null ? r.prompt : "";
    const d = local(r.created_at);
    const hd = el("div", "w-turnp-h");
    hd.append(el("b", "", t?.name ?? "Prompt"), el("span", "w-turnp-m", [r.title, d ? `${dayLabel(d)} ${hm(d)}` : ""].filter(Boolean).join(" · ")), el("span", "w-turnp-esc", "Space or Esc closes"));
    const body = el("div", `w-turnp-b${said ? "" : " none"}`);
    body.append(said ? marked(said, this.query) : document.createTextNode(SOURCE[r.source] ?? "no prompt recorded"));
    const parts: HTMLElement[] = [hd, body];
    if (bg !== null) parts.push(el("div", "w-turnp-bg", `made by a background task: ${bg}`));
    this.turnP.replaceChildren(...parts);
  }

  /** The latest card opened that is open and drawn now, for Esc. */
  private openCard(): HTMLElement | null {
    for (let i = this.spaceOpened.length - 1; i >= 0; i--) {
      const k = this.spaceOpened[i];
      if (!this.openGroups.has(k)) continue;
      const a = this.list.querySelector<HTMLElement>(`.w-day:not(.folded) .w-card.open[data-turn="${CSS.escape(k)}"]`);
      if (a) return a;
    }
    return null;
  }

  /** A list item holding a lane or a review row inside a card's list. */
  private li(child: HTMLElement): HTMLElement {
    const li = el("li", "w-li");
    li.append(child);
    return li;
  }

  /** The past reviews' search box, made once so typing keeps its focus. */
  private pastQEl = (() => {
    const i = el("input", "w-pastq");
    i.type = "search";
    i.placeholder = "search past reviews";
    i.setAttribute("aria-label", "search past reviews");
    let t = 0;
    i.addEventListener("input", () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        this.pastQ = i.value.trim();
        this.draw();
      }, 140);
    });
    return i;
  })();

  private box(title: string, tool: HTMLElement | null, items: HTMLElement[]): HTMLElement {
    const b = el("div", "w-box");
    const hd = el("div", "w-boxhd");
    hd.append(el("b", "", title), el("span", "grow"));
    if (tool) hd.append(tool);
    b.append(hd, ...items);
    return b;
  }

  private fold(text: string, open: () => void, opened = false, key = ""): HTMLElement {
    const b = button(`${opened ? "▾" : "▸"} ${text}`, "w-daymore");
    b.setAttribute("aria-expanded", String(opened));
    // Keyed, a fold is a stop on the j/k walk and Enter opens it.
    if (key) {
      b.dataset.key = key;
      b.classList.toggle("sel", key === this.selKey);
      this.acts.set(key, { open: () => b.click() });
    }
    b.addEventListener("click", () => {
      // Opened from the walk, the first thing it shows takes the fold's place,
      // so the next j goes on from there rather than from the top.
      const at = key && this.selKey === key ? this.keysShown().indexOf(key) : -1;
      open();
      this.draw();
      if (at >= 0 && (!opened || this.selKey !== key)) {
        const now = this.keysShown();
        const next = now[Math.min(at, now.length - 1)];
        if (next) this.selectKey(next, true);
      }
    });
    return b;
  }

  /** "4 min", "1 h 4 min", "2 d": how long since `ms`. */
  private since(ms: number): string {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
    if (m < 60) return `${m} min`;
    if (m < 60 * 24) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
    return `${Math.floor(m / 1440)} d`;
  }

  private openUrl(url: string): void {
    void invoke("open_url", { url }).catch((err) => this.toast(String(err), true));
  }

  private openReview(id: string, title: string): void {
    void Promise.resolve(this.host.open({ path: `/review/${id}`, title, ...this.host.here() })).catch((err) => this.toast(String(err), true));
  }

  private needsGrid(needs: Need[]): HTMLElement {
    const g = el("div", "w-needs");
    for (const n of needs) g.append(this.needTile(n));
    return g;
  }

  /** A Needs you tile: what waits, and a click (or Enter) does it. */
  private needTile(n: Need): HTMLElement {
    // Prefixed: a bare "review" or "risk" class meets the app's global rules.
    const t = el("div", `w-need n-${n.kind}${n.key === this.selKey ? " sel" : ""}`);
    t.dataset.key = n.key;
    // The title truncates in its own span; the tile's button stays whole.
    const head = el("div", "w-need-t");
    head.append(el("span", "w-need-tt", n.title));
    head.title = n.title;
    const sub = el("div", "w-need-s");
    let open: () => void = () => undefined;
    if (n.kind === "landing") {
      sub.textContent = `${n.recipe || "its landing"} waits at ${n.stage || "a stage"}: approve or skip`;
      open = () => {
        const p = this.prs.find((x) => x.n === n.n);
        if (p?.merge) window.dispatchEvent(new CustomEvent("seamux:land-open", { detail: { cwd: this.ws, merge: p.merge.sha } }));
      };
    } else if (n.kind === "pr") {
      sub.textContent = n.why;
      open = () => {
        const p = this.prs.find((x) => x.n === n.n);
        if (p) this.openUrl(p.url);
      };
    } else if (n.kind === "review") {
      sub.textContent = `${n.why}${n.findings ? ` · ${n.findings} finding${n.findings === 1 ? "" : "s"}` : ""}`;
      open = () => this.openReview(n.id, n.title);
    } else if (n.kind === "risk") {
      const names = n.rows.slice(0, 3).map((r) => r.title).join(", ");
      sub.textContent = n.rows.length > 3 ? `${names} and ${n.rows.length - 3} more` : names;
      const one = n.rows.length === 1;
      // Made once: a redraw between its ask and its confirm keeps the ask.
      const b = this.riskKeep;
      if (!b.classList.contains("sure")) b.textContent = one ? "keep" : `keep all ${n.rows.length}`;
      b.title = "copy into ~/.claude/crew/kept before temp storage is cleared";
      b.onclick = (e) => {
        e.stopPropagation();
        if (one) void this.keep(n.rows[0] as Row);
        else void this.keepAll(b, n.rows.length);
      };
      head.append(b);
      // A click (or Enter) shows them, row by row on their shelves; keeping
      // them all is the button's alone.
      open = () => {
        this.shelfAll.add("files");
        this.shelfAll.add("pictures");
        if (this.mode !== "shelves") this.setMode("shelves");
        else this.draw();
        this.selectKey(`row:${n.rows[0].id}`, true);
      };
    }
    t.append(head, sub);
    t.addEventListener("click", () => {
      this.selectKey(n.key);
      open();
    });
    this.acts.set(n.key, { open });
    return t;
  }

  /** A live review: its stage, findings so far and gate. */
  /** `at` makes the key unique where the same review shows more than once
   *  (Timeline draws it in every turn that touched it). */
  private reviewRow(r: ReviewSum, at = ""): HTMLElement {
    const key = `review:${r.id}${at ? `@${at}` : ""}`;
    const d = el("div", `w-rv${key === this.selKey ? " sel" : ""}`);
    d.dataset.key = key;
    const top = el("div", "w-rv-top");
    const t = this.reviewTitle(r, "w-rv-t");
    top.append(t, el("span", `w-stage ${r.needsPerson ? "needs" : r.stage}`, stageSaid(r)));
    if (r.updatedAt) top.append(el("time", "w-rv-age", age(r.updatedAt)));
    const sub = el("div", "w-rv-sub");
    const sev = (["blocker", "major", "minor", "nit"] as const).filter((k) => r.counts[k]);
    for (const k of sev) sub.append(el("span", `w-sev ${k === "blocker" || k === "major" ? "hi" : ""}`, `${r.counts[k]} ${k}`));
    if (!sev.length && r.stage !== "finding") sub.append(el("span", "w-sev", "no open findings"));
    const gate = r.gate.code === 0 ? "gate open" : r.gate.code === 4 ? `gate shut · ${r.claims.unchecked} claim${r.claims.unchecked === 1 ? "" : "s"} unchecked`
      : r.gate.code === 1 ? "gate shut · a blocker or major is open" : "gate shut · no reviewer yet";
    const g = el("span", `w-gate ${r.gate.code === 0 ? "open" : "shut"}`, gate);
    g.title = r.gate.why;
    sub.append(g);
    if (r.reviewer === "panel") sub.append(el("span", "w-st", "panel"));
    d.append(top, sub);
    d.addEventListener("click", () => {
      this.selectKey(key);
      this.openReview(r.id, r.title);
    });
    this.acts.set(key, { open: () => this.openReview(r.id, r.title) });
    return d;
  }

  /** A review's name in two parts, so a narrow column cuts the plan and
   *  keeps "increment N": the part that tells reviews apart. */
  private reviewTitle(r: ReviewSum, cls: string): HTMLElement {
    const t = el("span", `${cls} w-rname`);
    t.title = r.title;
    if (!r.plan || r.inc === null || r.inc === undefined) {
      t.append(el("span", "w-rname-p", r.title));
      return t;
    }
    t.append(el("span", "w-rname-p", r.plan), el("span", "w-rname-i", `\u00a0· ${r.inc === "all" ? "delivery" : `increment ${r.inc}`}`));
    return t;
  }

  /** A past review: when it closed, what it was, how many rounds it took. */
  private pastRow(r: ReviewSum): HTMLElement {
    const key = `review:${r.id}`;
    const d = el("div", `w-past${key === this.selKey ? " sel" : ""}`);
    d.dataset.key = key;
    const when = r.closedAt ? new Date(r.closedAt) : null;
    d.append(
      el("time", "w-past-d", when ? `${MON[when.getMonth()]} ${when.getDate()}` : ""),
      this.reviewTitle(r, "w-past-t"),
      el("span", "w-past-v", r.round.sealed ? `${r.round.sealed} round${r.round.sealed === 1 ? "" : "s"}` : "one pass"),
      ...(r.reviewer === "panel" ? [el("span", "w-st", "panel")] : []),
    );
    d.addEventListener("click", () => {
      this.selectKey(key);
      this.openReview(r.id, r.title);
    });
    this.acts.set(key, { open: () => this.openReview(r.id, r.title) });
    return d;
  }

  /** A pull request's lane: review, checks, merged, landed, and a line on
   *  where it is. A click opens it on GitHub; its landing chip follows the
   *  landing in the Lookout tab. */
  /** `at` makes the key unique where the same pull request shows more than
   *  once (Timeline draws its lane in every turn that touched it). */
  private laneRow(l: Lane, at = ""): HTMLElement {
    const p = l.pr;
    const key = at ? `${l.key}@${at}` : l.key;
    const red = l.states.includes("failed");
    const d = el("div", `w-lane${red ? " bad" : l.states[3] === "needs" ? " attn" : ""}${key === this.selKey ? " sel" : ""}`);
    d.dataset.key = key;
    const who = el("span", "w-lane-who");
    who.append(el("span", "w-pr-n", `#${p.n}`), el("span", "w-lane-t", p.title || p.url));
    who.title = `${p.title}
${p.url}`;
    d.append(who, ...l.states.map((st, i) => {
      const c = el("span", "w-cell");
      const dot = el("span", `w-dot ${st}`);
      dot.title = `${["review", "checks", "merged", "landed"][i]}: ${st === "none" ? "not yet" : st}`;
      c.append(dot);
      return c;
    }));
    const note = el("div", "w-lane-note");
    const land = p.merge ? this.lands.get(p.merge.sha) ?? null : null;
    const chip = chipFor({ ...(p as Pr), cwd: this.ws, ws: "", ws_title: "" } as unknown as PrRow, land);
    if (chip) {
      const c = el(p.merge && land ? "button" : "span", `w-pr-land ${chip.cls}`, chip.text);
      if (c instanceof HTMLButtonElement && p.merge) {
        c.type = "button";
        c.title = "Follow this merge's landing in the Lookout tab";
        const merge = p.merge.sha, cwd = this.ws;
        c.addEventListener("click", (e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("seamux:land-open", { detail: { cwd, merge } }));
        });
      }
      note.append(c);
    }
    const full = this.prs.find((x) => x.n === p.n);
    const failing = full?.failing ?? [];
    note.append(el("span", "w-lane-s", failing.length ? `failing: ${failing.map((f) => f.name).join(", ")}`
      : p.review === "REVIEW_REQUIRED" ? "review asked" : p.updatedAt ? age(p.updatedAt) : ""));
    d.append(note);
    d.addEventListener("click", () => {
      this.selectKey(key);
      this.openUrl(p.url);
    });
    this.acts.set(key, { open: () => this.openUrl(p.url), copy: () => void this.copy(p.url, "the link") });
    return d;
  }

  /** A picture or recording on its shelf: a thumbnail made once per row and
   *  kept across redraws (a redraw must not fetch it again). */
  private thumb(r: Row): HTMLElement {
    const key = `row:${r.id}`;
    if (this.thumbsWs !== this.ws) {
      this.thumbs.clear();
      this.thumbsWs = this.ws;
    }
    let t = this.thumbs.get(r.id);
    if (!t) {
      t = el("div", "w-thumb");
      const pic = el("div", "w-thumb-pic");
      const tile = () => {
        const x = el("span", "w-thumb-tile", mediaOf(r.path) === "video" ? "▶" : (r.path.split(".").pop() || r.kind).slice(0, 5));
        return x;
      };
      if (mediaOf(r.path) === "image" && r.state !== "gone") {
        const img = el("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = "";
        img.src = thumbUrl(r);
        img.addEventListener("error", () => img.replaceWith(tile()));
        pic.append(img);
      } else if (mediaOf(r.path) === "video" && r.state !== "gone") pic.append(this.videoPoster(r, tile()));
      else pic.append(tile());
      // A recording saved in the worktree's folder says so, apart from one in
      // temp storage or a scratchpad. (Whether git tracks it is not known here.)
      const ws = this.ws.replace(/\/+$/, "");
      if (mediaOf(r.path) === "video" && ws && r.path.startsWith(ws + "/")) {
        const m = el("span", "w-repo", "repo");
        m.title = "saved in this worktree's folder";
        pic.append(m);
      }
      const cap = el("span", "w-thumb-cap", r.title);
      cap.title = r.path || r.title;
      t.append(pic, cap);
      const id = r.id;
      t.addEventListener("click", (e) => {
        const now = this.data.rows.find((x) => x.id === id);
        if (!now) return;
        this.selectKey(`row:${id}`);
        if (this.openable(now)) void this.open(now, "", e);
      });
      this.thumbs.set(r.id, t);
    }
    t.dataset.key = key;
    t.classList.toggle("sel", key === this.selKey);
    t.classList.toggle("risk", r.state === "risk");
    t.classList.toggle("gone", r.state === "gone");
    this.acts.set(key, { row: r, open: (e) => void this.open(r, "", e), copy: r.path ? () => void this.copy(r.path, "the path") : undefined });
    return t;
  }

  /** A video's poster: a muted frame of it, read only once its thumbnail
   *  scrolls into view (each read is a ranged request for the file), with
   *  its length when the file states it. A recording that does not (a
   *  canvas's, or some browsers' own webm) shows its frame alone: learning
   *  its length would mean reading the whole file. Until the frame is in,
   *  and for a video that will not load (after one retry), the play tile
   *  shows. */
  private videoPoster(r: Row, tile: HTMLElement): HTMLElement {
    const box = el("span", "w-thumb-vid");
    const v = el("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "none";
    v.tabIndex = -1;
    v.setAttribute("aria-hidden", "true");
    const dur = el("span", "w-dur");
    dur.hidden = true;
    box.append(tile, dur);
    const length = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    v.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        dur.textContent = length(v.duration);
        dur.hidden = false;
        v.currentTime = Math.min(1, v.duration / 10);
      } else v.currentTime = 0.1;
    });
    // The first frame seeked to swaps in for the tile, once.
    let swapped = false;
    v.addEventListener("seeked", () => {
      if (swapped) return;
      swapped = true;
      tile.replaceWith(v);
      box.append(el("span", "w-thumb-play", "▶"));
    });
    // One retry a moment later: a file still being written, or a source not
    // ready yet, often loads the second time.
    let retried = false;
    v.addEventListener("error", () => {
      if (retried || swapped) return;
      retried = true;
      window.setTimeout(() => {
        v.src = fileUrl(r);
      }, 1500);
    });
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((e) => e.isIntersecting)) return;
      io.disconnect();
      v.preload = "metadata";
      v.src = fileUrl(r);
    });
    io.observe(box);
    return box;
  }

  // ------------------------------------------------------------ selection

  /** The keys the page shows now, in the order it shows them. */
  private keysShown(): string[] {
    return [...this.list.querySelectorAll<HTMLElement>("[data-key]")]
      .filter((e) => e.classList.contains("w-dayh") || !e.closest(".w-day.folded"))
      .map((e) => e.dataset.key ?? "");
  }

  private selectKey(key: string | null, scroll = false): void {
    // A card's prompt holding the focus lets go: Space then acts on the pick.
    const f = document.activeElement;
    if (f instanceof HTMLElement && f.classList.contains("w-prompt") && this.list.contains(f)) f.blur();
    this.list.querySelectorAll(".sel[data-key]").forEach((x) => {
      x.classList.remove("sel");
      x.removeAttribute("aria-selected");
    });
    this.selKey = key;
    const at = key ? this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
    if (at) {
      at.classList.add("sel");
      at.setAttribute("aria-selected", "true");
      if (scroll) at.scrollIntoView({ block: "nearest" });
    }
    // An open pane, and a shown prompt, follow the pick.
    const r = key ? this.acts.get(key)?.row : undefined;
    if (this.viewer.open && r) this.viewer.show(this.vis.filter(previewable), r);
    this.showTurn();
  }

  /** j / k: the next item in reading order; k from the first lets go. */
  private step(by: 1 | -1): void {
    const keys = this.keysShown();
    if (by < 0 && this.selKey && keys[0] === this.selKey) return this.selectKey(null, true);
    const next = stepKey(keys, this.selKey && keys.includes(this.selKey) ? this.selKey : null, by);
    if (next) this.selectKey(next, true);
  }

  /** After a redraw, the pick stays when its item still shows. */
  private restoreSel(): void {
    if (this.selKey && !this.keysShown().includes(this.selKey)) this.selKey = null;
    if (this.selKey) this.list.querySelector(`[data-key="${CSS.escape(this.selKey)}"]`)?.classList.add("sel");
    if (this.viewer.open) this.viewer.setRows(this.vis.filter(previewable));
    this.showTurn();
  }

  /** Pick `r` in the list, opening its day if it was folded: the pane
   *  flipped to it. Its row stays in sight beside the pane. */
  private reveal(r: Row): void {
    const key = `row:${r.id}`;
    const at = this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!at) return this.viewer.render(r);
    if (at.closest(".w-day.folded")) {
      this.dayFold.set(dayOf(Date.parse(r.created_at)), false);
      this.draw();
    }
    this.selectKey(key, true);
  }

  private row(r: Row, tail?: HTMLElement): HTMLElement {
    const key = `row:${r.id}`;
    const li = el("li", `w-row ${r.state}${key === this.selKey ? " sel" : ""}`);
    li.dataset.key = key;
    this.acts.set(key, {
      row: r,
      open: (e) => {
        if (this.openable(r)) void this.open(r, "", e);
      },
      copy: r.path ? () => void this.copy(r.path, "the path") : undefined,
    });
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
    const mine = r.kind === "pr" && gh ? this.prsByUrl.get(`https://github.com/${gh.repo}/pull/${gh.n}`) : undefined;
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
      p.append(marked(shortPath(w), this.query));
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
        { label: "scenarios", title: "its sealed scenarios, in the sheet (the app adds the page's key)", run: (e) => void this.open(r, "scenarios", e) },
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
      this.selectKey(key);
      if (this.openable(r)) void this.open(r, "", e);
    });
    return li;
  }

  /** Whether the row has anything to open: a gone file has nothing, unless a URL or commit stands in. */
  private openable(r: Row): boolean {
    return r.kind === "plan" || r.state !== "gone" || !!r.url || r.kind === "commit";
  }

  /** Open row `r`. A picture, video or page previews in the pane, unless
   *  `elsewhere` (the pane's own "open in a tab") or ⌘ sends it on. */
  private async open(r: Row, sub: string, e?: MouseEvent | KeyboardEvent, elsewhere = false): Promise<void> {
    const file = !!r.path && r.state !== "gone" && !["plan", "review", "ask", "commit", "artifact"].includes(r.kind);
    // ⌘ and "open elsewhere", as a pane's link does: a file in VS Code; a page
    // beside the Dock's workspace (cmux, or the browser on tmux); anything
    // else (a commit, an artifact) the Wake's own way.
    const away = async () => {
      if (file) return await openElsewhere({ kind: "file", path: r.path });
      const o = await invoke<{ sheet: string | null; detail: string }>("wake_open", { id: r.id, sub, here: true });
      if (o.sheet) return await openElsewhere({ kind: "page", path: o.sheet, workspace: this.host.here().workspace });
      if (o.detail) this.toast(o.detail);
    };
    try {
      if (e?.metaKey) return await away();
      if (!elsewhere && !sub && previewable(r)) {
        if (this.selKey !== `row:${r.id}`) this.selectKey(`row:${r.id}`);
        this.viewer.show(this.vis.filter(previewable), r);
        // The pane took room from the list: keep the picked row in sight.
        requestAnimationFrame(() => this.list.querySelector(".sel[data-key]")?.scrollIntoView({ block: "nearest" }));
        return;
      }
      // Markdown renders in the Dock, as a pane's link to it does.
      if (file && /\.(md|markdown)$/i.test(r.path)) {
        const shown = await invoke<Shown>("link_file", { path: r.path }).catch(() => null);
        if (shown) return this.host.show(shown, { kind: "file", path: r.path }, this.host.here());
      }
      if (r.path && PREVIEW.test(r.path) && r.state !== "gone" && !["plan", "review", "ask", "commit", "artifact"].includes(r.kind)) {
        try {
          // A video streams from the app's wakefile: scheme, too big for a data: URL.
          const shown: Shown = mediaOf(r.path) === "video"
            ? { kind: "video", title: r.path.split("/").pop() || r.title, data: fileUrl(r) }
            : await invoke<Shown>("wake_file", { id: r.id });
          return this.host.show(shown, { kind: "file", path: r.path }, this.host.here());
        } catch (err) {
          this.toast(`${String(err)} · opening it elsewhere`, true);
          return await away();
        }
      }
      const o = await invoke<{ sheet: string | null; detail: string }>("wake_open", { id: r.id, sub, here: true });
      if (o.sheet) await this.host.open({ path: o.sheet, title: r.title || r.locator, ...this.host.here() });
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

  /** Keep every file at risk: the first click asks, a second within 3.5 s
   *  keeps. `b` is Needs you's button, `n` the files it names. */
  private async keepAll(b: HTMLButtonElement, n: number): Promise<void> {
    b.dataset.n = String(n);
    if (!b.classList.contains("sure")) {
      arm(b);
      b.classList.add("sure");
      b.textContent = `sure? copy ${this.data.truncated ? "at least " : ""}${b.dataset.n} files`;
      clearTimeout(Number(b.dataset.timer));
      b.dataset.timer = String(
        window.setTimeout(() => {
          b.classList.remove("sure");
          if (b.isConnected) b.textContent = `keep all ${b.dataset.n}`;
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
      } else if (!inQ && this.turnOn && !this.turnP.hidden) {
        this.turnOn = false;
        this.showTurn();
      } else if (!inQ && this.openCard()) {
        // The latest card opened, and drawn, closes first.
        const a = this.openCard()!;
        this.setCard(a.dataset.turn ?? "", a, false);
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
        this.selKey = null;
        this.step(1);
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
    const act = this.selKey ? this.acts.get(this.selKey) : undefined;
    const r = act?.row;
    if (e.metaKey) {
      if (e.key === "Enter" && act) {
        e.preventDefault();
        act.open(e);
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
        if (!act) this.toast("pick something first: j");
        if (act) {
          e.preventDefault();
          if (r && !this.openable(r)) this.toast("gone: nothing is left to open");
          else act.open();
        }
        break;
      case " ":
        e.preventDefault();
        if (this.mode === "timeline") {
          // The pick's card, or its turn's card; nothing picked, the first.
          const card = this.cardFor(this.selKey);
          if (card) this.toggleCard(card.dataset.turn ?? "", card);
          break;
        }
        // Nothing picked: the first item is picked and its prompt shows.
        const had = !!this.selKey;
        if (!had) this.step(1);
        if (this.selKey) {
          // Shelves have no cards: the row's turn prompt shows under the list.
          this.turnOn = had ? !this.turnOn : true;
          this.showTurn();
          // The panel takes room from the list: the pick stays in sight.
          this.list.querySelector<HTMLElement>(".sel[data-key]")?.scrollIntoView({ block: "nearest" });
        }
        break;
      case "K":
        if (!act) this.toast("pick something first: j");
        else if (r?.state === "risk") void this.keep(r);
        else this.toast(r?.state === "kept" ? "already kept" : "only a file at risk can be kept");
        break;
      case "c":
        if (act?.copy) act.copy();
        else this.toast(act ? "nothing to copy here" : "pick something first: j");
        break;
      case "t":
        this.setMode(this.mode === "shelves" ? "timeline" : "shelves");
        break;
      case "r":
        if (r?.session_id) void this.copy(resumeCmd(r), "the resume command");
        else this.toast(act ? "no session to resume from here" : "pick something first: j");
        break;
      case "?":
        this.help.hidden = !this.help.hidden;
        break;
    }
  }
}
