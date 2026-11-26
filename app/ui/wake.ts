import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Sheet, Shown } from "./sheet";
import { openElsewhere } from "./panelinks";
import { dotsMenu, type MenuItem, type TuckRow } from "./tuck";
import { fileUrl, mediaOf, PREVIEW, previewable, thumbUrl, Viewer } from "./wakeview";
import { age, badgeOf, bar, byUrl, countsSaid, doneSaid, GROUP_SAID, grouped, groupOf, type Group, type Pr } from "./prs";
import { chipFor, readLandings, type Landing, type PrRow } from "./release";
import { SHELF_SAID, shelves, stageSaid, stepKey, type AskPage, type Lane, type Need, type PlanRow, type ReviewSum, type ShelfId } from "./wakeshelf";

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
  private keepAllBtn = button("", "w-act keepall");
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
  /** Long days the person asked to see in full ("show N more"). */
  private dayAll = new Set<string>();
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
  /** lookout's reviews of the worktree, its plans, and the asks waiting in it. */
  private reviews: ReviewSum[] = [];
  private plans: PlanRow[] = [];
  private asks: AskPage[] = [];
  private sideWs = "";
  private sideAt = 0;
  /** The past reviews' search, and whether older ones and older lanes show. */
  private pastQ = "";
  private pastAll = false;
  private lanesAll = false;
  /** Shelves opened past their first page ("show N more"). */
  private shelfAll = new Set<ShelfId>();
  /** Needs you's keep-all, made once so its ask-then-confirm survives a redraw. */
  private riskKeep = button("", "w-act");
  /** Thumbnails by row id, kept across redraws so a picture is not fetched again. */
  private thumbs = new Map<number, HTMLElement>();
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
  /** The done group is folded until opened; the rest are open. */
  private prsOpen = new Set<Group>(["you", "people", "draft", "open"]);
  /** PRs whose failing checks are listed; a red one that needs you starts open. */
  private prsShown = new Map<number, boolean>();
  /** A group the Dock's pill asked for, and for which worktree ("" for the
   *  next one shown): scrolled to and marked once that worktree's block is drawn. */
  private prsFocus: Group | null = null;
  private prsFocusDir = "";
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
        ["j k", "next · previous, shelf by shelf"],
        ["t", "Shelves or Timeline"],
        ["Enter", "preview a picture, video or page; open the rest (⌘ in cmux)"],
        ["← →", "flip through the previews"],
        ["v", "preview beside · under the list"],
        ["f", "fill the Wake with the preview"],
        ["Esc", "close the preview"],
        ["Space", "show the whole prompt"],
        ["K", "keep an at-risk file"],
        ["c", "copy the path (a pull request's link)"],
        ["r", "copy the resume command"],
        ["⌘E", "the Wake, and again back to the page you were on"],
        ["⌘⇧P ⌘⇧L ⌘⇧A ⌘⇧O", "the plan, review, ask or other pages; again for the next"],
        ["⌘[ ⌘]", "the previous · next page beside the terminal"],
        ["⌘⇧E", "hide or show the column beside the terminal"],
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
    main.append(head, bar, this.list);
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
    await listen<{ wake: { id: number }[]; tucked?: TuckRow[]; pages?: (AskPage & { kind: string })[] }>("views:frame", (e) => {
      this.takeAsks(e.payload.pages);
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
    // The feed sends a frame when something changes: the asks already
    // waiting come from the frame as it is now.
    const now = await invoke<{ pages?: (AskPage & { kind: string })[] } | null>("views_frame").catch(() => null);
    this.takeAsks(now?.pages);
    await this.load();
  }

  /** The asks waiting on the person, from the views feed's pages: Needs you
   *  shows the ones in this worktree. Redrawn when they change. */
  private takeAsks(pages: (AskPage & { kind: string })[] | undefined): void {
    const asks = (pages ?? []).filter((p) => p.kind === "ask").map(({ path, label, waiting, since, root }) => ({ path, label, waiting, since, root }));
    if (JSON.stringify(asks) === JSON.stringify(this.asks)) return;
    this.asks = asks;
    if (this.data.workspaces.length) this.draw();
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
    this.prsOpen.add(g);
    // The open pill scrolls to the first open group: needs you, if any.
    this.prsFocus = g === "open" ? "you" : g;
    this.prsOpen.add(this.prsFocus);
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
    const bits: (string | HTMLElement)[] = [el("b", "", String(rows.length)), this.query ? ` for “${this.query}”` : " things left behind"];
    if (risk) bits.push(" · ", el("span", "risk", `${risk} at risk`));
    if (kept) bits.push(" · ", el("span", "kept", `${kept} kept`));
    if (gone) bits.push(` · ${gone} gone`);
    if (this.data.truncated) bits.push(` · newest ${this.data.limit} shown; search to reach older`);
    this.stats.replaceChildren(...bits);
    // One at-risk file has its own keep button: keep all is for two or more.
    this.keepAllBtn.hidden = risk < 2 || !!this.query || this.mode === "shelves";
    if (!this.keepAllBtn.classList.contains("sure")) this.keepAllBtn.textContent = `keep all ${risk}`;
    this.keepAllBtn.dataset.n = String(risk);
    for (const m of ["shelves", "timeline"] as const) this.modeBtns[m].setAttribute("aria-pressed", String(this.mode === m));
    this.acts.clear();
    if (this.mode === "shelves") return this.drawShelves();

    // Rows by day, then by the prompt that made them.
    this.vis = rows;
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
      ul!.append(this.row(r, tail));
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
    const prsBlock = this.ws === this.prsWs && !this.query ? this.prsBlock() : null;
    if (prsBlock) out.unshift(prsBlock);
    this.list.classList.toggle("searching", !!this.query);
    this.list.replaceChildren(...out);
    if (prsBlock && this.prsFocus && this.focusHere(this.prsFocusDir)) {
      const at = prsBlock.querySelector<HTMLElement>(`[data-g="${this.prsFocus}"]`) ?? prsBlock;
      at.scrollIntoView({ block: "start" });
      at.classList.add("asked");
      this.prsFocus = null;
    }
    this.restoreSel();
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
    const prs = this.ws === this.prsWs ? this.prs : [];
    const s = shelves({
      ws: this.ws,
      rows: this.data.rows,
      prs: prs.map((p) => ({ ...p, group: groupOf(p), landing: p.merge ? this.lands.get(p.merge.sha) ?? null : null })),
      // Read for another worktree, they wait for this one's (loadSide).
      reviews: this.sideWs === this.ws ? this.reviews : [],
      asks: this.asks,
      plans: this.sideWs === this.ws ? this.plans : [],
    });
    const out: HTMLElement[] = [];
    const shelf = (id: ShelfId, count: string, ...body: HTMLElement[]) => {
      const sec = el("section", `w-shelf ${id}`);
      sec.dataset.shelf = id;
      sec.setAttribute("aria-label", SHELF_SAID[id]);
      const h = el("h2", "w-shelf-h");
      h.append(document.createTextNode(`${SHELF_SAID[id]} `), el("span", "w-n", count));
      sec.append(h, ...body);
      out.push(sec);
    };
    // A long shelf shows its first page; the rest wait behind "show N more"
    // (a search shows every match).
    const page = (id: ShelfId, rows: Row[], n: number) => (q || this.shelfAll.has(id) ? rows : rows.slice(0, n));
    const more = (id: ShelfId, all: number, shown: number) =>
      all > shown ? [this.fold(`show ${all - shown} more`, () => this.shelfAll.add(id))] : [];
    const list = (id: ShelfId, rows: Row[]) => {
      const shown = page(id, rows, 12);
      const ul = el("ul", "w-rows w-box");
      for (const r of shown) ul.append(this.row(r));
      return [ul, ...more(id, rows.length, shown.length)];
    };
    // A search asks about things by name: Needs you steps aside.
    if (!q) {
      if (s.needs.length) shelf("needs", String(s.needs.length), this.needsGrid(s.needs));
      else {
        const c = el("div", "w-calm");
        c.append(el("span", "w-calm-ok", "✓"), document.createTextNode("Nothing needs you."));
        out.push(c);
      }
    }
    const live = s.reviews.live.filter((r) => hit(r.title));
    const pq = this.pastQ.toLowerCase();
    const past = s.reviews.past.filter((r) => hit(r.title) && (!pq || `${r.title} ${r.plan}`.toLowerCase().includes(pq)));
    if (live.length || s.reviews.past.length) {
      const body: HTMLElement[] = [];
      if (live.length) body.push(this.box("Live", null, live.map((r) => this.reviewRow(r))));
      if (s.reviews.past.length) {
        const shown = this.pastAll || pq ? past : past.slice(0, 4);
        const items = shown.map((r) => this.pastRow(r));
        if (past.length > shown.length) items.push(this.fold(`${past.length - shown.length} older review${past.length - shown.length === 1 ? "" : "s"}`, () => (this.pastAll = true)));
        if (!items.length) items.push(el("div", "w-none", `no past review matches “${this.pastQ || this.query}”`));
        body.push(this.box("Past", this.pastQEl, items));
      }
      shelf("reviews", `${live.length} live · ${q || pq ? past.length : s.reviews.past.length} past`, ...body);
    }
    const plans = s.plans;
    if (plans.length) shelf("plans", String(plans.length), ...list("plans", plans));
    const lanes = s.lanes.filter((l) => hit(`#${l.pr.n} ${l.pr.title}`));
    if (lanes.length) {
      const shown = lanes.filter((l) => this.lanesAll || !l.fold || q);
      const t = el("div", "w-lanes w-box");
      const hd = el("div", "w-lane-hd");
      hd.append(el("span", "", "needs you first"), ...["review", "checks", "merged", "landed"].map((x) => el("span", "", x)));
      t.append(hd, ...shown.map((l) => this.laneRow(l)));
      const extra = lanes.length - shown.length;
      shelf("prs", String(lanes.length), t, ...(extra ? [this.fold(`${extra} older`, () => (this.lanesAll = true))] : []));
    }
    const pics = page("pictures", s.pictures, 24);
    if (s.pictures.length) {
      const g = el("div", "w-thumbs");
      for (const r of pics) g.append(this.thumb(r));
      shelf("pictures", String(s.pictures.length), g, ...more("pictures", s.pictures.length, pics.length));
    }
    if (s.files.length) shelf("files", String(s.files.length), ...list("files", s.files));
    if (s.commits.length) shelf("commits", String(s.commits.length), ...list("commits", s.commits));
    // Thumbnails of rows no longer here are let go.
    const ids = new Set(s.pictures.map((r) => r.id));
    for (const id of [...this.thumbs.keys()]) if (!ids.has(id)) this.thumbs.delete(id);
    if (!this.data.rows.length && !out.some((x) => x.classList.contains("w-shelf"))) {
      const e = el("div", "w-empty");
      e.textContent = this.query
        ? `nothing in the wake matches “${this.query}”`
        : this.ws
          ? "nothing in this workspace's wake yet. Each file, plan or commit a session makes shows up here when its turn ends."
          : "no workspace yet.";
      out.push(e);
    }
    this.vis = [...page("plans", s.plans, 12), ...pics, ...page("files", s.files, 12), ...page("commits", s.commits, 12)];
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
        at.scrollIntoView({ block: "start" });
        at.classList.add("asked");
        this.prsFocus = null;
      }
    }
    this.restoreSel();
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

  private fold(text: string, open: () => void): HTMLElement {
    const b = button(`▸ ${text}`, "w-daymore");
    b.addEventListener("click", () => {
      open();
      this.draw();
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
    const head = el("div", "w-need-t", n.title);
    head.title = n.title;
    const sub = el("div", "w-need-s");
    let open: () => void = () => undefined;
    if (n.kind === "ask") {
      sub.textContent = `ask · waiting ${this.since(n.since)}`;
      open = () => void Promise.resolve(this.host.open({ path: n.path, title: n.title, ...this.host.here() })).catch((e) => this.toast(String(e), true));
    } else if (n.kind === "landing") {
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
      open = () => b.click();
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
  private reviewRow(r: ReviewSum): HTMLElement {
    const key = `review:${r.id}`;
    const d = el("div", `w-rv${key === this.selKey ? " sel" : ""}`);
    d.dataset.key = key;
    const top = el("div", "w-rv-top");
    const t = el("span", "w-rv-t", r.title);
    t.title = r.title;
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

  /** A past review: when it closed, what it was, how many rounds it took. */
  private pastRow(r: ReviewSum): HTMLElement {
    const key = `review:${r.id}`;
    const d = el("div", `w-past${key === this.selKey ? " sel" : ""}`);
    d.dataset.key = key;
    const when = r.closedAt ? new Date(r.closedAt) : null;
    d.append(
      el("time", "w-past-d", when ? `${MON[when.getMonth()]} ${when.getDate()}` : ""),
      el("span", "w-past-t", r.title),
      el("span", "w-past-v", r.round.sealed ? `${r.round.sealed} round${r.round.sealed === 1 ? "" : "s"}` : "one pass"),
      el("span", "w-st", r.reviewer),
    );
    (d.children[1] as HTMLElement).title = r.title;
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
  private laneRow(l: Lane): HTMLElement {
    const p = l.pr;
    const key = l.key;
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
      } else pic.append(tile());
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

  // ------------------------------------------------------------ selection

  /** The keys the page shows now, in the order it shows them. */
  private keysShown(): string[] {
    return [...this.list.querySelectorAll<HTMLElement>("[data-key]")]
      .filter((e) => !e.closest(".w-day.folded, .w-grp.later"))
      .map((e) => e.dataset.key ?? "");
  }

  private selectKey(key: string | null, scroll = false): void {
    this.list.querySelectorAll(".sel[data-key]").forEach((x) => x.classList.remove("sel"));
    this.selKey = key;
    const at = key ? this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
    if (at) {
      at.classList.add("sel");
      if (scroll) at.scrollIntoView({ block: "nearest" });
    }
    // An open pane follows the pick.
    const r = key ? this.acts.get(key)?.row : undefined;
    if (this.viewer.open && r) this.viewer.show(this.vis.filter(previewable), r);
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
    // A merged PR's landing: where it is, and a click to follow it in the
    // Lookout tab at its Land stage.
    const land = p.merge ? this.lands.get(p.merge.sha) ?? null : null;
    const chip = p.merge ? chipFor({ ...p, cwd: this.ws, ws: "", ws_title: "" } as PrRow, land) : null;
    if (p.merge && land && chip) {
      const c = el("button", `w-pr-land ${chip.cls}`, chip.text);
      c.type = "button";
      c.title = "Follow this merge's landing in the Lookout tab";
      const merge = p.merge.sha, cwd = this.ws;
      c.addEventListener("click", (e) => {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("seamux:land-open", { detail: { cwd, merge } }));
      });
      li.append(c);
    }
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
    const key = `row:${r.id}`;
    const at = this.list.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!at) return this.viewer.render(r);
    if (at.closest(".w-day.folded, .w-grp.later")) {
      const dk = dayKey(local(r.created_at));
      this.dayFold.set(dk, false);
      this.dayAll.add(dk);
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
   *  keeps. `b` is the button asked from (the header's, or Needs you's). */
  private async keepAll(b: HTMLButtonElement = this.keepAllBtn, n = Number(this.keepAllBtn.dataset.n)): Promise<void> {
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
        if (act) {
          e.preventDefault();
          act.open();
        }
        break;
      case " ":
        if (r) {
          e.preventDefault();
          this.list.querySelector(`[data-key="${CSS.escape(this.selKey ?? "")}"]`)?.closest(".w-grp")?.querySelector<HTMLElement>(".w-prompt")?.click();
        }
        break;
      case "K":
        void this.keep(r);
        break;
      case "c":
        act?.copy?.();
        break;
      case "t":
        this.setMode(this.mode === "shelves" ? "timeline" : "shelves");
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
