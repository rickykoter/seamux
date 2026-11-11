import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// A job as review_app.rs serves it.
/** What review_app's orphan() refusal says: an agent from the last session still runs there. */
const ORPHAN = "may still be working in its worktree";

type Job = {
  id: string;
  input: string;
  repo: string;
  branch: string;
  pr: number | null;
  base: string;
  cross: boolean;
  depth: string;
  model: string;
  /** "agent" (or "", from before panels) or "panel". */
  reviewer: string;
  status: string;
  detail: string;
  review_id: string;
  session: string;
  started: number;
  stage_at: number;
  activity: string;
  busy: string;
  log: string[];
  open: Record<string, number>;
  ahead: number;
  dirty: boolean;
  /** Files with uncommitted edits. */
  changed: number;
  pushed: boolean;
  posted: string;
};
/** A review's pull request, as review.rs gh_summary reads its record. */
type GhSummary = { repo: string; pr: number; url: string; state: string; draft: boolean; behind: number | null; pass: number; fail: number; pending: number; stale: number; unposted: number };
/** A lookout review opened from a terminal session. */
type Other = { id: string; title: string; root: string; branch: string; updated: number; open: Record<string, number>; gh: GhSummary | null };
type Pick = { input: string; repo: string; title: string; updated: number };
type Picks = { requested: Pick[]; mine: Pick[]; branches: Pick[]; problem: string };
type Finding = { id: string; file: string; line: number; severity: string; summary: string; status?: string };
type IntentServer = { origin: string | null; up: boolean; reason: string | null };
/**
 * What the framed page's tools row shows, as the page posts it
 * (lookout/page/review.js postState): the header row draws it instead.
 */
type PageState = {
  gate: { cls: string; text: string; title: string; go: boolean };
  mode: { cls: string; text: string; title: string };
  layout: string;
  /** The page draws unified because its diff column is too narrow for split; `layout` is still the saved choice. */
  auto?: boolean;
  overview: boolean;
  map: boolean;
  hasMap: boolean;
  keys: boolean;
  /** Whether the page's file list shows its own Overview row. */
  ovRow?: boolean;
  /** Open findings by severity, the set the gate pill counts. */
  open?: Record<string, number>;
};
/**
 * How the header row gives up width when it runs short, one step at a time:
 * the GitHub link folds into ⋯, the View ▾ menu's items (Overview, Map,
 * Split or Unified, keyboard shortcuts) move to the top of ⋯, and "N
 * findings · M picked ▾" shortens to an icon and "M/N ▾". The title keeps
 * TITLE_MIN until every step is taken, and never goes under 12ch before
 * that (review.css .r-name); only then may it shrink further. The gate pill
 * and the findings button never leave the row. Live is only its dot at
 * every width, so it takes no step. While the page draws unified because it
 * is too narrow for split, Split and Unified are not in the View menu at
 * all; a View menu left with one item is no menu: the item goes in ⋯.
 */
const FOLDS = ["github", "view", "findings"] as const;
type Fold = (typeof FOLDS)[number];
/** How long a banner's target waits for its review's page to be ready. */
const FOCUS_WAIT_MS = 90_000;
/** The title keeps this much width before anything folds. */
const TITLE_MIN = 160;

// Short names: the side is narrow. What each depth means is the select's title.
const DEPTHS: [string, string][] = [
  ["low", "Low depth"],
  ["medium", "Medium depth"],
  ["high", "High depth"],
  ["xhigh", "Extra high"],
  ["max", "Max depth"],
];
const DEPTH_MEANS: Record<string, string> = {
  low: "Low: blockers and majors only",
  medium: "Medium: everything but nits",
  high: "High: everything the diff supports",
  xhigh: "Extra high: reads whole files and their callers",
  max: "Max: exhaustive",
};
// One fresh reviewer, or lookout's review panel: a lead, three finders and a
// skeptic on each blocker or major, several times the tokens.
const REVIEWERS: [string, string][] = [
  ["agent", "One reviewer"],
  ["panel", "Panel"],
];
const MODELS: [string, string][] = [
  ["", "Default"],
  ["haiku", "Haiku"],
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["fable", "Fable"],
];
const SEVERITIES = ["blocker", "major", "minor", "nit"];
const RUNNING = new Set(["resolving", "cloning", "fetching", "opening", "reviewing", "ingesting"]);
/** A running review's steps, each with the statuses that belong to it. */
const STEPS: [string[], string][] = [
  [["resolving"], "Find it on GitHub"],
  [["cloning", "fetching"], "Fetch the code"],
  [["opening"], "Open the diff"],
  [["reviewing"], "Review"],
  [["ingesting"], "Save the findings"],
];
const SEL_KEY = "seamux.lookout.selected";
/** "shown" when the reader opened the review list beside an open review; folded otherwise. */
const LIST_KEY = "seamux.lookout.list";
const SVG = "http://www.w3.org/2000/svg";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(text: string, onClick: () => void, cls = "r-btn"): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

function select(options: [string, string][], value: string): HTMLSelectElement {
  const s = el("select", "r-select");
  for (const [v, label] of options) s.append(new Option(label, v));
  s.value = value;
  return s;
}

/** A small check mark, for a finished step. */
function check(): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 12 12");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", "M2.5 6.5 5 9l4.5-6");
  s.append(p);
  return s;
}

/** A small cross, for failed checks. */
function cross(): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 12 12");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", "r-cross");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", "M3 3l6 6M9 3l-6 6");
  s.append(p);
  return s;
}

/** Three dots, for the menu that holds what is used less. */
function dots(): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  for (const x of [3.5, 8, 12.5]) {
    const c = document.createElementNS(SVG, "circle");
    c.setAttribute("cx", String(x));
    c.setAttribute("cy", "8");
    c.setAttribute("r", "1.4");
    s.append(c);
  }
  return s;
}

/** Three short lines, for the Findings button when the row is short of width. */
function listIcon(): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", "r-icon");
  for (const y of [4, 8, 12]) {
    const l = document.createElementNS(SVG, "path");
    l.setAttribute("d", `M3 ${y}h10`);
    s.append(l);
  }
  return s;
}

/** The gate as `lookout gate` reads it: an open blocker or major blocks. */
function verdict(open: Record<string, number>): "blocked" | "pass" {
  return (open.blocker ?? 0) + (open.major ?? 0) > 0 ? "blocked" : "pass";
}

/** 0:42, 3:07, 1:02:09. */
function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** "just now", "5m ago", "3h ago", "2d ago". */
function ago(secs: number): string {
  if (!secs) return "";
  const d = Date.now() / 1000 - secs;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 60 * 86400) return `${Math.floor(d / 86400)}d ago`;
  if (d < 365 * 86400) return `${Math.floor(d / (30 * 86400))}mo ago`;
  return `${Math.floor(d / (365 * 86400))}y ago`;
}

/** A live elapsed-time span; the tab's ticker keeps it current. */
function since(t: number, cls = "r-clock"): HTMLElement {
  const s = el("span", cls, clock(Date.now() / 1000 - t));
  s.dataset.since = String(t);
  return s;
}

/**
 * Open findings by severity, worded as the page's gate pill words them
 * (lookout/page/review.js gateText): "1 blocker, 1 major open".
 */
/** "3 open", as the gate pill says it; openSummary is the breakdown for its tooltip. */
function openCount(open: Record<string, number>): string {
  const n = SEVERITIES.reduce((t, s) => t + (open[s] ?? 0), 0);
  return n ? `${n} open` : "no open findings";
}

function openSummary(open: Record<string, number>): string {
  const parts = SEVERITIES.filter((s) => open[s]).map((s) => `${open[s]} ${s}`);
  return parts.length ? `${parts.join(", ")} open` : "no open findings";
}

/** Which run of a job this is: Re-review keeps the id and restarts the clock. */
function runOf(j: Job): string {
  return `${j.started}|${j.review_id}`;
}

function stepOf(status: string): number {
  return STEPS.findIndex(([ss]) => ss.includes(status));
}

/** The Lookout tab: reviews on the left, the one picked filling the right. */
export class ReviewView {
  private jobs: Job[] = [];
  private others: Other[] = [];
  private picks: Picks | null = null;
  private picksAt = 0;
  private selected: string | null = null;
  /** Whether the review list shows beside an open review. With none open it always shows. */
  private listShown = false;
  /** The review whose frame couldn't load: its header keeps the verdict chip. */
  private frameDown = "";
  /** The framed page's tools, once it posts them; its origin, to talk back. */
  private pageState: PageState | null = null;
  private pageOrigin = "";
  /** The picked ids last posted to the framed page, so it is told only of a change. */
  private sentPicks = "";
  /** How many of FOLDS the header row has folded into its ⋯ menu, and the width it fitted. */
  private fold = 0;
  private fitWidth = 0;

  private side = el("aside", "r-side");
  private main = el("section", "r-main");
  private input = el("input", "r-input");
  private pickBox = el("div", "r-picks");
  private depth = select(DEPTHS, "high");
  private model = select(MODELS, "");
  private reviewer = select(REVIEWERS, "agent");
  private go = el("button", "r-btn primary", "Review");
  private err = el("p", "r-err");
  private list = el("div", "r-list");
  private head = el("header", "r-mhead");
  private ctl = el("div", "r-ctl");
  private frameBox = el("div", "r-frame");
  /** What the head and controls, and the frame, last drew. */
  private drawn = "";
  private framed = "";

  private findings = new Map<string, { key: string; rows: Finding[]; loaded?: boolean }>();
  /**
   * What a done post or a Re-review asks of the reader, for the review it
   * was done on (`sel`): shown in that review's detail line, not as an
   * error, and dropped when another review is picked.
   */
  private note: { sel: string; text: string; link?: string; code?: string } | null = null;
  /** Per job: the ticked findings (the picks) and a pending confirm. */
  private ticked = new Map<string, Set<string>>();
  /** The job whose ⋯ menu is open, if any. */
  private moreOpen: string | null = null;
  /** Logs the reader opened or closed, so a redraw keeps them that way. */
  private logOpen = new Map<string, boolean>();
  private confirm = new Map<string, "post" | "push" | "remove" | "remove-unreadable" | "orphan" | "stop-orphan">();
  /** Whether the Lookout tab is the one in view (main.ts says). */
  private shown = false;
  /** A banner's target, waiting for its review's page to say it is ready. */
  private pendingFocus: { review: string; item: string; at: number } | null = null;
  /** The review last told to the notifier as on screen. */
  private told: string | null | undefined = undefined;
  /** The terminal review whose findings are being posted, or "". */
  private posting = "";
  /** Per job: the run its ticks, findings and confirm belong to. */
  private runs = new Map<string, string>();

  constructor(private root: HTMLElement) {
    this.root.className = "review";
    try {
      this.selected = localStorage.getItem(SEL_KEY);
      this.listShown = localStorage.getItem(LIST_KEY) === "shown";
    } catch {
      /* no storage: start with nothing picked */
    }

    this.input.type = "text";
    this.input.placeholder = "owner/repo#123 · owner/repo@branch · a GitHub URL";
    this.input.setAttribute("aria-label", "GitHub repo, branch or pull request");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.addEventListener("focus", () => void this.showPicks());
    this.input.addEventListener("input", () => this.drawPicks());
    this.input.addEventListener("blur", () => (this.pickBox.hidden = true));
    this.input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // Not the document's Escape, which hides the whole window: the first
      // closes the suggestions, the next leaves the input.
      e.stopPropagation();
      if (this.pickBox.hidden) this.input.blur();
      else this.pickBox.hidden = true;
    });
    this.pickBox.hidden = true;
    // Keep focus in the input while a pick is clicked.
    this.pickBox.addEventListener("mousedown", (e) => e.preventDefault());
    this.go.type = "submit";
    this.depth.setAttribute("aria-label", "Depth");
    this.model.setAttribute("aria-label", "Model");
    this.model.title = "Model (Default is Claude Code's own)";
    this.reviewer.setAttribute("aria-label", "Reviewer");
    this.reviewer.title = "One fresh reviewer, or a panel: a lead and three finders, then a skeptic on each blocker or major (several times the tokens)";
    const means = () => (this.depth.title = DEPTH_MEANS[this.depth.value] ?? "");
    means();
    this.depth.addEventListener("change", means);

    const form = el("form", "r-form");
    const field = el("div", "r-field");
    field.append(this.input, this.pickBox);
    const opts = el("div", "r-opts");
    opts.append(this.depth, this.model, this.reviewer, this.go);
    form.append(el("span", "r-title", "New review"), field, opts, this.err);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.start(this.input.value.trim(), this.depth.value, this.model.value, this.reviewer.value);
    });
    this.side.append(form, this.list);
    this.main.append(this.head, this.ctl, this.frameBox);
    this.root.append(this.side, this.main);

    // A click anywhere but the ⋯ menu closes it. A click in the framed page
    // never reaches this document, but it takes focus: the window blurs.
    // Closed in place, not by redrawing the header: a redraw on mousedown
    // replaced the button under the pointer, so that press never clicked.
    const closeMore = () => {
      if (!this.moreOpen) return;
      this.moreOpen = null;
      this.head.querySelector(".r-menu")?.remove();
      this.head.querySelector(".r-more-btn")?.setAttribute("aria-expanded", "false");
    };
    document.addEventListener("mousedown", (e) => {
      if (!(e.target instanceof Element && e.target.closest(".r-more"))) closeMore();
    });
    window.addEventListener("blur", closeMore);

    // A narrower window folds the header's lesser tools into ⋯; a wider one
    // brings them back. Only a change of width refits.
    // One refit a frame while the window is dragged, not one per resize event.
    let fitFrame = 0;
    new ResizeObserver(() => {
      if (fitFrame) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0;
        const w = this.head.clientWidth;
        if (w && w !== this.fitWidth) this.render(true);
      });
    }).observe(this.head);
    // The page's keys work from the header too, for a tool folded into ⋯
    // after the reader clicked a header button (the page has the keys otherwise).
    this.head.addEventListener("keydown", (e) => {
      const p = this.pageState;
      if (!p || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as Element).tagName)) return;
      const op = ({ o: "overview", m: "map", v: "layout", "?": "keys" } as Record<string, string>)[e.key];
      if (!op || (op === "map" && !p.hasMap)) return;
      e.preventDefault();
      this.tell(op, op === "layout" ? { layout: p.layout === "split" ? "unified" : "split" } : {});
    });

    // The framed page's tools come up onto the header row: the page says
    // hello, this answers "host", and the page then hides its own row and
    // posts what it would show. Only from the frame shown, at its origin.
    window.addEventListener("message", (e) => {
      const f = this.frameBox.querySelector("iframe");
      if (!f || e.source !== f.contentWindow || e.origin !== this.pageOrigin) return;
      const d = e.data as { lookout?: string; gate?: unknown; mode?: unknown } | null;
      if (!d || typeof d !== "object") return;
      if (d.lookout === "hello") {
        // A page that says hello is new (or reloaded itself): it holds no
        // picks, so the next render sends them again.
        this.sentPicks = "";
        f.contentWindow?.postMessage({ lookout: "host" }, this.pageOrigin);
      }
      else if (d.lookout === "rereview") this.rereview();
      // The page's GitHub links: the webview opens no windows, so the app's
      // open_url hands them to the browser. Only github.com, as the page sends.
      else if (d.lookout === "open") {
        const url = (d as { url?: unknown }).url;
        if (typeof url === "string" && /^https:\/\/github\.com\//.test(url)) void invoke("open_url", { url }).catch((err) => (this.err.textContent = String(err)));
      }
      else if (d.lookout === "state" && d.gate && typeof d.gate === "object" && d.mode && typeof d.mode === "object") {
        this.pageState = d as unknown as PageState;
        this.flushFocus();
        this.render();
      }
    });

    // The tab's own new-tab links (GitHub, a posted review) open in the
    // browser through open_url, which takes web links only.
    this.root.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[target="_blank"]') as HTMLAnchorElement | null;
      if (!a || !/^https?:\/\//.test(a.href)) return;
      e.preventDefault();
      void invoke("open_url", { url: a.href }).catch((err) => (this.err.textContent = String(err)));
    });

    window.setInterval(() => {
      const now = Date.now() / 1000;
      for (const s of this.root.querySelectorAll<HTMLElement>("[data-since]")) s.textContent = clock(now - Number(s.dataset.since));
    }, 1000);
  }

  async begin(): Promise<void> {
    await listen<Job[]>("review:frame", (e) => this.take(e.payload));
    this.take(await invoke<Job[]>("review_jobs"));
    void this.loadOthers();
    window.setInterval(() => void this.loadOthers(), 30_000);
  }

  /**
   * The framed page's Re-review (its PR strip offers it when the PR's head
   * has moved past the review). A pasted review runs again from the new
   * head; a terminal review's reviewer belongs to its session.
   */
  private rereview(): void {
    const sel = this.selected ?? "";
    const job = this.jobs.find((j) => `job:${j.id}` === sel);
    if (job) {
      if (!RUNNING.has(job.status) && !job.busy) void this.start(job.input, job.depth, job.model, job.reviewer || "agent", job);
      return;
    }
    const o = this.others.find((x) => `other:${x.id}` === sel);
    if (!o) return;
    this.note = { sel, text: "Re-review from its session:", code: `lookout prompt ${o.id}` };
    this.render(true);
  }

  /** main.ts: the Lookout tab came into view, or left it. */
  setShown(on: boolean): void {
    this.shown = on;
    this.tellLooking();
  }

  /**
   * The notifier skips a PR banner for the review on screen
   * (notify_app.rs notify_review_looking): say which that is, on a change.
   */
  private tellLooking(): void {
    const now = this.shown && this.framed ? this.framed : null;
    if (now === this.told) return;
    this.told = now;
    void invoke("notify_review_looking", { review: now }).catch(() => {});
  }

  /**
   * A PR banner's click: show review `review` (a pasted one's review id, or
   * a terminal review's) and have its page go to `item`, once the page has
   * said it is ready. A terminal review past the list's newest twelve is
   * looked for once more before giving up.
   */
  async focus(review: string, item: string): Promise<void> {
    const find = () => {
      const j = this.jobs.find((x) => x.review_id === review);
      if (j) return `job:${j.id}`;
      const o = this.others.find((x) => x.id === review);
      return o ? `other:${o.id}` : null;
    };
    let sel = find();
    if (!sel) {
      await this.loadOthers();
      sel = find();
    }
    if (!sel) {
      this.err.textContent = `That review (${review}) is no longer listed.`;
      return;
    }
    this.pendingFocus = { review, item, at: Date.now() };
    if (this.selected !== sel) this.pick(sel);
    this.flushFocus();
  }

  /** Hands a waiting banner target to the framed page, once it is that review's and ready. */
  private flushFocus(): void {
    const p = this.pendingFocus;
    // A target waits only for its own review's page, and not for long: the
    // reader may have moved on, and a page should not jump unasked later.
    if (p && (Date.now() - p.at > FOCUS_WAIT_MS || (this.framed && this.framed !== p.review && this.pageState))) this.pendingFocus = null;
    if (!p || this.pendingFocus !== p || this.framed !== p.review || !this.pageState) return;
    this.pendingFocus = null;
    this.tell("focus", { item: p.item });
  }

  // ---- data ----

  private take(jobs: Job[]): void {
    this.jobs = jobs;
    // Re-review keeps the job's id but starts a new run, and lookout numbers
    // findings per review (f1, f2…): ticks kept from the last run would name
    // other findings in this one.
    for (const j of jobs) {
      const run = runOf(j);
      const was = this.runs.get(j.id);
      if (was !== undefined && was !== run) this.forget(j.id);
      this.runs.set(j.id, run);
    }
    this.render();
  }

  /** Drops what the picker and confirms held for a job's last run. */
  private forget(id: string): void {
    this.ticked.delete(id);
    this.findings.delete(id);
    this.confirm.delete(id);
    if (this.moreOpen === id || this.moreOpen === `find:${id}`) this.moreOpen = null;
  }

  private async loadOthers(): Promise<void> {
    try {
      this.others = await invoke<Other[]>("review_others");
      this.render();
    } catch (e) {
      console.error("review_others", e);
    }
  }

  private async loadPicks(): Promise<void> {
    if (this.picks && Date.now() - this.picksAt < 5 * 60_000) return;
    this.picksAt = Date.now();
    try {
      this.picks = await invoke<Picks>("review_suggest");
    } catch (e) {
      this.picks = { requested: [], mine: [], branches: [], problem: String(e) };
    }
    this.drawPicks();
  }

  private async loadFindings(j: Job): Promise<void> {
    // The framed page's counts move first when the reader resolves one there:
    // the list reloads then, so the button and the gate pill say the same number.
    // Only the framed job's page posts counts; another job's key leaves them out.
    const pageOpen = j.review_id && j.review_id === this.framed ? this.pageState?.open ?? null : null;
    const key = `${runOf(j)}|${JSON.stringify(j.open)}|${JSON.stringify(pageOpen)}|${j.busy}|${j.ahead}`;
    if (this.findings.get(j.id)?.key === key) return;
    this.findings.set(j.id, { key, rows: this.findings.get(j.id)?.rows ?? [] });
    try {
      const all = await invoke<Finding[]>("review_findings", { id: j.id });
      const rows = all.filter((f) => f.status !== "resolved" && f.status !== "dismissed");
      // A newer run, or a newer state of this one, asked since: its answer stands.
      if (this.findings.get(j.id)?.key !== key) return;
      this.findings.set(j.id, { key, rows });
      // Blockers and majors start picked; Edit, Fix and Post act while anything is.
      if (!this.ticked.has(j.id)) this.ticked.set(j.id, new Set(rows.filter((f) => f.severity === "blocker" || f.severity === "major").map((f) => f.id)));
      this.render();
    } catch (e) {
      this.err.textContent = String(e);
    }
  }

  // ---- actions ----

  /** `again`: the card being reviewed again, when it is a Re-review. */
  private async start(input: string, depth: string, model: string, reviewer: string, again?: Job): Promise<void> {
    this.err.textContent = "";
    if (!input) return;
    this.go.disabled = true;
    try {
      const id = await invoke<string>("review_start", { input, depth, model, reviewer });
      this.forget(id);
      if (input === this.input.value.trim()) this.input.value = "";
      this.pickBox.hidden = true;
      this.pick(`job:${id}`);
    } catch (e) {
      this.err.textContent = String(e);
      if (again) this.offerStop(again, e);
    } finally {
      this.go.disabled = false;
    }
  }

  private async run(j: Job, cmd: string, args: Record<string, unknown>): Promise<void> {
    this.err.textContent = "";
    try {
      await invoke(cmd, { id: j.id, ...args });
    } catch (e) {
      this.err.textContent = String(e);
      this.offerStop(j, e);
    }
    this.render(true);
  }

  /** A refusal over an agent left running from the last session: offer to stop it. */
  private offerStop(j: Job, e: unknown): void {
    if (!String(e).includes(ORPHAN)) return;
    this.confirm.set(j.id, "orphan");
    this.render(true);
  }

  private async stopOrphan(j: Job): Promise<void> {
    this.err.textContent = "";
    try {
      await invoke("review_stop_orphan", { id: j.id });
    } catch (e) {
      this.err.textContent = String(e);
    }
    this.render(true);
  }

  /**
   * `files` and `commits`: the uncommitted files and unpushed commits the
   * confirm named. `unreadable`: it said git couldn't read the worktree.
   */
  private async remove(j: Job, files: number, commits: number, unreadable: boolean): Promise<void> {
    this.err.textContent = "";
    try {
      await invoke("review_remove", { id: j.id, files, commits, unreadable });
      if (this.selected === `job:${j.id}`) this.pick(null);
    } catch (e) {
      // Git found more than the confirm named (the card now has it), or
      // couldn't read the worktree: ask again, saying so.
      const why = String(e);
      this.err.textContent = why;
      if (why.includes(ORPHAN)) this.confirm.set(j.id, "orphan");
      else if (why.includes("nothing was removed")) this.confirm.set(j.id, "remove");
      else if (why.includes("couldn't read its worktree")) this.confirm.set(j.id, "remove-unreadable");
      this.render(true);
    }
  }

  private pick(sel: string | null): void {
    // Picking another review drops a banner target still waiting for its own.
    const p = this.pendingFocus;
    if (p && sel !== `job:${this.jobs.find((j) => j.review_id === p.review)?.id}` && sel !== `other:${p.review}`) this.pendingFocus = null;
    if (sel !== this.selected) this.note = null;
    this.selected = sel;
    try {
      if (sel) localStorage.setItem(SEL_KEY, sel);
      else localStorage.removeItem(SEL_KEY);
    } catch {
      /* a convenience only */
    }
    this.render(true);
  }

  // ---- drawing ----

  private render(force = false): void {
    this.drawList();
    this.drawMain(force);
  }

  /** A review is open: one picked that is still there. */
  private hasOpen(): boolean {
    const sel = this.selected;
    return !!sel && (this.jobs.some((j) => `job:${j.id}` === sel) || this.others.some((o) => `other:${o.id}` === sel));
  }

  private toggleList(): void {
    this.listShown = !this.listShown;
    try {
      localStorage.setItem(LIST_KEY, this.listShown ? "shown" : "folded");
    } catch {
      /* a convenience only */
    }
    this.render(true);
  }

  private title(j: Job): string {
    const name = j.repo.split("/").pop() || j.repo || j.input;
    return `${name} · ${j.pr ? `PR #${j.pr}` : j.branch || j.input}`;
  }

  private drawList(): void {
    const items: HTMLElement[] = [];
    const row = (sel: string, name: string, line: HTMLElement, dot: string) => {
      const b = el("button", `r-item${this.selected === sel ? " on" : ""}`);
      b.type = "button";
      b.setAttribute("aria-current", this.selected === sel ? "true" : "false");
      const top = el("span", "r-item-top");
      top.append(el("span", `r-dot ${dot}`), el("span", "r-item-name", name));
      b.append(top, line);
      b.addEventListener("click", () => this.pick(sel));
      return b;
    };

    items.push(el("h3", "r-sec", "Reviewed here"));
    if (!this.jobs.length) items.push(el("p", "r-none", "Nothing yet. Paste a pull request above."));
    for (const j of [...this.jobs].reverse()) {
      const line = el("span", "r-item-line");
      let dot = j.status;
      if (RUNNING.has(j.status)) {
        dot = "running";
        line.append(`${STEPS[stepOf(j.status)]?.[1] ?? j.status} · `, since(j.started));
      } else if (j.busy) {
        dot = "running";
        line.textContent = j.busy;
      } else if (j.status === "failed") line.textContent = "failed";
      else line.textContent = openSummary(j.open);
      items.push(row(`job:${j.id}`, this.title(j), line, dot));
    }

    if (this.others.length) {
      items.push(el("h3", "r-sec", "From terminals"));
      for (const o of this.others) {
        const n = Object.values(o.open).reduce((a, b) => a + b, 0);
        const line = el("span", "r-item-line", `${n ? `${n} open` : "all closed"}${o.gh ? ` · PR #${o.gh.pr}` : ""}`);
        // Failed checks in words, a red cross before them: not a bare glyph.
        if (o.gh?.fail) {
          const f = el("span", "r-fail");
          f.append(cross(), `${o.gh.fail} check${o.gh.fail === 1 ? "" : "s"} failed`);
          line.append(" · ", f);
        }
        if (o.updated) line.append(` · updated ${ago(o.updated)}`);
        items.push(row(`other:${o.id}`, o.title, line, n ? "open" : "closed"));
      }
    }
    this.list.replaceChildren(...items);
  }

  private drawMain(force: boolean): void {
    // An open review gets the width: the list folds away unless the reader opened it.
    const folded = this.hasOpen() && !this.listShown;
    this.root.classList.toggle("folded", folded);
    this.side.hidden = folded;
    const sel = this.selected;
    const job = sel?.startsWith("job:") ? this.jobs.find((j) => `job:${j.id}` === sel) : undefined;
    const other = sel?.startsWith("other:") ? this.others.find((o) => `other:${o.id}` === sel) : undefined;

    // The page is drawn once per review and kept: moving or redrawing an
    // iframe reloads it, losing the reader's place. A new page posts its own
    // tools; until it does, the header shows none.
    const page = job && job.status === "ready" && job.review_id ? job.review_id : other ? other.id : "";
    if (page !== this.framed) {
      this.framed = page;
      this.pageState = null;
      this.frameBox.replaceChildren();
      this.frameBox.hidden = !page;
      if (page) this.showFrame(page, job ? this.title(job) : other?.title ?? page);
    }
    this.tellLooking();

    const key = JSON.stringify([sel, folded, this.frameDown, job, other, this.note, this.confirm.get(job?.id ?? ""), [...(this.ticked.get(job?.id ?? "") ?? [])], this.moreOpen, this.findings.get(job?.id ?? "")?.rows.length, this.pageState, this.logOpen.get(job?.id ?? "")]);
    if (force || key !== this.drawn) {
      this.drawn = key;
      const draw = () => (job ? this.drawJob(job) : other ? this.drawOther(other) : this.drawEmpty());
      // From nothing folded, fold one more tool into ⋯ until the row fits.
      this.fold = 0;
      draw();
      while (this.fold < FOLDS.length && this.overflows()) {
        this.fold++;
        draw();
      }
      // Every step taken and still short: only now may the title go under 12ch.
      const row = this.head.querySelector<HTMLElement>(".r-mhead-row");
      if (row && this.overflows()) row.classList.add("tight");
      // A cut title is shown whole as the ⋯ menu's first line.
      const name = row?.querySelector<HTMLElement>(".r-name");
      if (row && name) row.classList.toggle("cut", name.scrollWidth > name.clientWidth);
      this.fitWidth = this.head.clientWidth;
    }
    if (job?.status === "ready") void this.loadFindings(job);
    this.syncPicks(job);
  }

  /**
   * Tells the framed page which findings are picked (the Act set), so its
   * cards can show a check; the page's own "current" card is a different
   * thing. Only once the page has answered as hosted, and only on a change.
   */
  private syncPicks(job: Job | undefined): void {
    const f = this.frameBox.querySelector("iframe");
    if (!this.pageState || !f || !this.pageOrigin) {
      this.sentPicks = "";
      return;
    }
    const rows = job ? (this.findings.get(job.id)?.rows ?? []) : [];
    const ids = job ? [...(this.ticked.get(job.id) ?? [])].filter((id) => rows.some((r) => r.id === id)) : [];
    const key = JSON.stringify(ids);
    if (key === this.sentPicks) return;
    this.sentPicks = key;
    f.contentWindow?.postMessage({ lookout: "do", op: "picks", ids }, this.pageOrigin);
  }

  /** Whether the header row has taken this step (FOLDS) to fit. */
  private folds(f: Fold): boolean {
    return FOLDS.indexOf(f) < this.fold;
  }

  /**
   * The header row is one line: it overflows when its content runs past its
   * width, or when the title is squeezed under TITLE_MIN while it still has
   * more to show.
   */
  private overflows(): boolean {
    const row = this.head.querySelector<HTMLElement>(".r-mhead-row");
    if (!row) return false;
    const name = row.querySelector<HTMLElement>(".r-name");
    const squeezed = !!name && name.scrollWidth > name.clientWidth && name.clientWidth < TITLE_MIN;
    return row.scrollWidth > row.clientWidth + 1 || squeezed;
  }

  private drawEmpty(): void {
    const msg = el("div", "r-empty");
    msg.append(el("p", "", this.jobs.length || this.others.length ? "Pick a review on the left." : "Start a review on the left: paste a pull request, or pick one of yours."));
    this.head.replaceChildren();
    this.ctl.replaceChildren(msg);
  }

  /**
   * The one header row: the name, its state, then what can be done, then the
   * framed page's tools (its gate pill beside the state, its View ▾ menu by
   * the ⋯). `more` is the ⋯ menu's key and items; it also takes whatever
   * the row folds (FOLDS, `this.fold` of them) when the width runs short.
   * `meta` shows inline unless there is a ⋯ menu to hold it.
   */
  private headOf(name: string, chip: HTMLElement | null, meta: string, link: string | null, buttons: HTMLElement[], more: { key: string; items: HTMLElement[] } | null = null, status: HTMLElement | null = null): void {
    const h = el("div", "r-mhead-row");
    const folds = new Set<Fold>(FOLDS.slice(0, this.fold));
    const tools = this.pageTools();
    const shown = this.listShown;
    const list = btn(shown ? "◂ Reviews" : "Reviews ▸", () => this.toggleList(), "r-btn quiet r-list-btn");
    list.setAttribute("aria-expanded", String(shown));
    list.title = shown ? "Hide the review list" : "Show the review list";
    h.append(list);
    const n = el("h2", "r-name", name);
    n.title = meta;
    h.append(n);
    if (chip) h.append(chip);
    h.append(...tools.state);
    if (status) h.append(status);
    // What folded goes at the top of ⋯, in the row's order.
    const folded: HTMLElement[] = [];
    if (link) {
      const a = el("a", folds.has("github") ? "r-btn quiet" : "r-link", folds.has("github") ? "Open on GitHub" : "GitHub");
      a.href = link;
      a.target = "_blank";
      a.rel = "noreferrer";
      if (folds.has("github")) folded.push(a);
      else h.append(a);
    }
    // The view tools sit in one View ▾ menu; short of width they join ⋯, and
    // so does a lone one (under 900px only the keys are left): a menu of one
    // item is a click for nothing.
    const viewInMore = tools.view.length === 1 || folds.has("view");
    if (tools.view.length && viewInMore) folded.push(...tools.view);
    const items = [...folded, ...(folded.length && more?.items.length ? [el("div", "r-menu-sep")] : []), ...(more?.items ?? [])];
    const menu = items.length ? this.more(more?.key ?? "head", meta, items, name) : null;
    if (!menu) h.append(el("span", "r-meta", meta));
    const acts = el("div", "r-acts");
    acts.append(...buttons);
    if (tools.view.length && !viewInMore) acts.append(this.viewMenu(tools.view));
    if (menu) acts.append(menu);
    h.append(acts);
    this.head.replaceChildren(h);
  }

  /** Tells the framed page to act as its own button would, and hands it the keys. */
  private tell(op: string, extra: Record<string, string> = {}): void {
    const f = this.frameBox.querySelector("iframe");
    if (!f || !this.pageOrigin) return;
    f.contentWindow?.postMessage({ lookout: "do", op, ...extra }, this.pageOrigin);
    f.focus();
  }

  /**
   * The framed page's tools as the page posted them: the gate pill and live
   * state, for beside the name, and the View menu's items: Overview, Map,
   * Split and Unified, and the keyboard shortcuts, each with its key. No
   * Overview item while the page's file list shows its own Overview row
   * (o still opens it). None until the page posts them.
   */
  private pageTools(): { state: HTMLElement[]; view: HTMLElement[] } {
    const p = this.pageState;
    if (!p) return { state: [], view: [] };
    const gate = btn(p.gate.text, () => this.tell("gate"), `r-gate ${p.gate.cls}`);
    // The arrow says the pill goes somewhere: to the first blocking finding.
    if (p.gate.go) {
      const go = el("span", "r-go", "↓");
      go.setAttribute("aria-hidden", "true");
      gate.append(go);
    }
    gate.disabled = !p.gate.go;
    gate.title = p.gate.title;
    // Live (or disconnected) is only its dot at every width; the words are in the tooltip.
    const dot = p.mode.cls === "live" || p.mode.cls === "down";
    const mode = el("span", `r-mode ${p.mode.cls}${dot ? " only" : ""}`, dot ? "" : p.mode.text);
    mode.title = dot ? `${p.mode.text}. ${p.mode.title}` : p.mode.title;
    if (dot) {
      mode.setAttribute("role", "img");
      mode.setAttribute("aria-label", p.mode.text);
    }
    // A View menu item: a check while it is on, its key at the end.
    const item = (text: string, key: string, onClick: () => void, on: boolean | null = null, role = "menuitemcheckbox") => {
      const b = btn("", onClick, "r-btn quiet r-menu-tool");
      const mark = el("span", "r-check");
      if (on) mark.append(check());
      b.append(mark, el("span", "r-tool-name", text), el("kbd", "r-kbd", key));
      if (on === null) b.setAttribute("role", "menuitem");
      else {
        b.setAttribute("role", role);
        b.setAttribute("aria-checked", String(on));
      }
      return b;
    };
    const view: HTMLElement[] = [];
    if (!p.ovRow) view.push(item("Overview", "o", () => this.tell("overview"), p.overview));
    if (p.hasMap) view.push(item("Map", "m", () => this.tell("map"), p.map));
    // Too narrow for split, the page draws unified whatever is picked: no choice then.
    if (!p.auto) {
      for (const [v, label] of [["split", "Split diff"], ["unified", "Unified diff"]]) view.push(item(label, "v", () => this.tell("layout", { layout: v }), p.layout === v, "menuitemradio"));
    }
    view.push(item("Keyboard shortcuts", "?", () => this.tell("keys"), p.keys));
    return { state: [gate, mode], view };
  }

  /** The View ▾ menu: how the framed page shows the diff, each tool with its key. */
  private viewMenu(items: HTMLElement[]): HTMLElement {
    const b = el("button", "r-btn quiet r-view-btn", "View ▾");
    b.title = "Overview, map, split or unified, and keys (o, m, v, ?)";
    return this.menu("view", b, items);
  }

  /**
   * A small menu for what is used less: the review's settings, Re-review,
   * Remove, and what the row folded. `name` is the title, the menu's first
   * line while the row cuts it (review.css .cut).
   */
  private more(key: string, meta: string, items: HTMLElement[], name = ""): HTMLElement {
    const b = el("button", "r-btn quiet r-more-btn");
    b.append(dots());
    b.setAttribute("aria-label", "More");
    return this.menu(key, b, items, meta, name ? [el("p", "r-menu-title", name)] : []);
  }

  /**
   * A button that opens a small menu under it. One menu is open at a time,
   * `this.moreOpen` holding its key; a click elsewhere or Escape closes it.
   * `top` goes above the items and stays open while used: the findings
   * panel's picker. That panel is a dialog (`role`), not a menu, since it
   * holds checkboxes; `cls` and `label` name it. Opening focuses the first
   * thing in it that can act.
   */
  private menu(key: string, b: HTMLButtonElement, items: HTMLElement[], meta = "", top: HTMLElement[] = [], opts: { role?: "menu" | "dialog"; cls?: string; label?: string } = {}): HTMLElement {
    const wrap = el("div", "r-more");
    const open = this.moreOpen === key;
    const role = opts.role ?? "menu";
    b.type = "button";
    b.setAttribute("aria-haspopup", role);
    b.setAttribute("aria-expanded", String(open));
    b.addEventListener("click", () => {
      // The current state, not the one drawn: the menu may have closed in place.
      this.moreOpen = this.moreOpen === key ? null : key;
      this.render(true);
      if (this.moreOpen) this.head.querySelector<HTMLElement>(".r-menu :is(button, input, a):not(:disabled)")?.focus();
    });
    wrap.append(b);
    if (open) {
      const m = el("div", `r-menu${opts.cls ? ` ${opts.cls}` : ""}`);
      m.setAttribute("role", role);
      if (opts.label) m.setAttribute("aria-label", opts.label);
      m.append(...top);
      if (meta) m.append(el("p", "r-menu-meta", meta));
      for (const it of items) {
        if (it.classList.contains("r-menu-sep")) {
          it.setAttribute("role", "separator");
          m.append(it);
          continue;
        }
        // A View item says itself whether it is a checkbox or radio.
        if (!it.getAttribute("role") && role === "menu") it.setAttribute("role", "menuitem");
        // Closed before the item acts; redrawn after, for an item that draws nothing.
        it.addEventListener("click", () => {
          this.moreOpen = null;
          queueMicrotask(() => this.render(true));
        }, { capture: true });
        m.append(it);
      }
      wrap.append(m);
    }
    // Not the document's Escape, which hides the whole window.
    wrap.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.moreOpen) return;
      e.stopPropagation();
      this.moreOpen = null;
      this.render(true);
    });
    return wrap;
  }

  private drawOther(o: Other): void {
    const dir = o.root.split("/").filter(Boolean).pop() ?? o.root;
    const g = o.gh;
    const key = `other:${o.id}`;
    // The framed page's PR strip owns the PR's number, state and checks:
    // the meta says only where the review came from, and when. The branch
    // once: not again when the title already names it.
    const branch = o.branch && !o.title.includes(o.branch) ? ` · ${o.branch}` : "";
    const meta = `from a terminal · ${dir}${branch}${o.updated ? ` · updated ${ago(o.updated)}` : ""}`;
    const buttons: HTMLElement[] = [];
    const below: HTMLElement[] = [];
    const got = this.findings.get(key);
    const rows = (got?.rows ?? []).filter((f) => !(f as Finding & { github?: { postedAt?: string } }).github?.postedAt);
    // A linked review posts from here, as a pasted one does; edits and fixes
    // stay with the session that opened it. No Findings menu while none is
    // left to post, nor on a merged or closed PR: it takes nothing more.
    const ended = !!g && ["merged", "closed"].includes(g.state.toLowerCase());
    if (g && rows.length && !ended) {
      const ticked = this.ticked.get(key) ?? new Set<string>();
      const picked = [...ticked].filter((id) => rows.some((r) => r.id === id));
      const n = picked.length;
      const busy = this.posting === o.id;
      const toggle = el("button", `r-btn pickbtn${n ? " primary" : ""}`, `Findings${n ? ` · ${n} picked` : ""} ▾`);
      toggle.title = "Pick findings to post as one review on the pull request";
      const post = btn(busy ? "Posting…" : "Post comments", () => {
        this.confirm.set(key, "post");
        this.render(true);
      }, "r-btn quiet");
      post.disabled = busy || !n;
      post.title = n ? `The ${n} picked as one review on PR #${g.pr}` : "Pick findings first";
      const sep = el("div", "r-menu-sep");
      sep.setAttribute("role", "separator");
      buttons.push(this.menu(`find:${key}`, toggle, [post], "", [this.picker(key, rows, ticked, busy), sep], { role: "dialog", cls: "r-find-panel", label: "Findings" }));
      if (this.confirm.get(key) === "post")
        below.push(this.confirmBox(key, `Post ${n} finding${n === 1 ? "" : "s"} as one review on ${g.repo} PR #${g.pr}? Everyone watching the pull request is notified, and the text is the reviewer's, not yours.`, "Post", () => void this.postOther(o, picked)));
    }
    this.headOf(o.title, null, meta, g?.url || null, buttons, { key, items: [] });
    // The detail line says what can be done, as the Findings menu can do it.
    const parts = [openSummary(o.open)];
    if (g?.stale) parts.push(`${g.stale} stale`);
    let say: string;
    if (!g) say = `${parts.join(" · ")}. Not linked to a pull request: edit, fix and post from the session that opened it.`;
    else if (ended) say = `${parts.join(" · ")}. PR #${g.pr} is ${g.state.toLowerCase()}: nothing more goes to GitHub. Edit and fix from the session that opened it.`;
    else if (rows.length) say = `${parts.join(" · ")}. ${rows.length} finding${rows.length === 1 ? "" : "s"} not on GitHub: post ${rows.length === 1 ? "it" : "them"} from Findings ▾. Edit and fix from the session that opened it.`;
    else {
      if (got?.loaded && Object.values(o.open).some((c) => c > 0)) parts.push("all posted");
      say = `${parts.join(" · ")}. Edit and fix from the session that opened it.`;
    }
    this.ctl.replaceChildren(el("p", "r-detail", say), ...this.noteFor(key), ...below);
    if (g) void this.loadOtherFindings(o);
  }

  /** The note for review `sel`, if it has one: its words, a link, and a command with Copy. */
  private noteFor(sel: string): HTMLElement[] {
    const n = this.note;
    if (!n || n.sel !== sel) return [];
    const p = el("p", "r-note", n.text);
    if (n.link) {
      const a = el("a", "r-link", "↗");
      a.href = n.link;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.setAttribute("aria-label", "Open on GitHub");
      p.append(" ", a);
    }
    if (n.code) {
      const code = n.code;
      const copy = btn("Copy", () => {
        void navigator.clipboard.writeText(code).then(() => (copy.textContent = "Copied"), (e) => (this.err.textContent = String(e)));
      }, "r-btn quiet r-copy");
      p.append(" ", el("code", "r-code", code), " ", copy);
    }
    return [p];
  }

  private async loadOtherFindings(o: Other): Promise<void> {
    const key = `other:${o.id}`;
    const stamp = `${o.updated}|${JSON.stringify(o.open)}|${o.gh?.unposted}`;
    if (this.findings.get(key)?.key === stamp) return;
    this.findings.set(key, { key: stamp, rows: this.findings.get(key)?.rows ?? [] });
    try {
      const all = await invoke<Finding[]>("review_other_findings", { id: o.id });
      if (this.findings.get(key)?.key !== stamp) return;
      this.findings.set(key, { key: stamp, rows: all.filter((f) => f.status !== "resolved" && f.status !== "dismissed"), loaded: true });
      this.render(true);
    } catch (e) {
      this.err.textContent = String(e);
    }
  }

  private async postOther(o: Other, ids: string[]): Promise<void> {
    this.err.textContent = "";
    this.posting = o.id;
    this.render(true);
    try {
      const url = await invoke<string>("review_other_post", { id: o.id, ids });
      this.ticked.delete(`other:${o.id}`);
      this.findings.delete(`other:${o.id}`);
      const pr = o.gh ? ` to PR #${o.gh.pr}` : "";
      this.note = { sel: `other:${o.id}`, text: `Posted ${ids.length} finding${ids.length === 1 ? "" : "s"}${pr}`, link: /^https:\/\/github\.com\//.test(url) ? url : undefined };
    } catch (e) {
      this.err.textContent = String(e);
    }
    this.posting = "";
    await this.loadOthers();
  }

  private drawJob(j: Job): void {
    const running = RUNNING.has(j.status);
    // A finished review shows the gate's verdict, the word the page uses.
    const state = j.busy ? "running" : running ? "running" : j.status === "ready" ? verdict(j.open) : j.status;
    // Framed, the page's gate pill carries the verdict and its counts: no
    // second one here. Unframed or down, this chip says both.
    const framed = j.status === "ready" && !!j.review_id && this.frameDown !== j.review_id;
    const chip = state === "blocked" || state === "pass" ? (framed ? null : el("span", `r-chip ${state}`, `${state} · ${openCount(j.open)}`)) : el("span", `r-chip ${state}`, j.busy || (running ? "reviewing" : state));
    if (chip && !framed && (state === "blocked" || state === "pass")) chip.title = openSummary(j.open);
    const meta = `${j.depth} · ${j.model || "default model"}${j.reviewer === "panel" ? " · panel" : ""}${j.base ? ` · against ${j.base}` : ""}`;
    // The ⋯ menu: Re-review and Remove once it is idle, and the log any time.
    const items: HTMLButtonElement[] = [];
    if (!running && !j.busy) {
      const again = btn("Re-review", () => void this.start(j.input, j.depth, j.model, j.reviewer || "agent", j), "r-btn quiet");
      again.title = "Review it again from its latest commit. This replaces this run and its worktree.";
      const remove = btn("Remove", () => {
        this.confirm.set(j.id, "remove");
        this.render(true);
      }, "r-btn quiet");
      items.push(again, remove);
    }
    if (j.log.length) {
      const log = btn(`Log (${j.log.length})`, () => {
        this.logOpen.set(j.id, true);
        this.render(true);
      }, "r-btn quiet");
      log.title = "What the review did, step by step";
      items.push(log);
    }
    const more = { key: j.id, items };
    // A fix or post underway says what it is doing on the header row.
    let status: HTMLElement | null = null;
    if (j.busy) {
      status = el("span", "r-now r-busy", j.activity || "starting");
      status.title = `${j.busy}: ${j.activity || "starting"}`;
    }
    const link = j.repo ? `https://github.com/${j.repo}${j.pr ? `/pull/${j.pr}` : j.branch ? `/tree/${j.branch}` : ""}` : null;
    const acts = !running && j.status !== "failed" ? this.actions(j) : { buttons: [], below: [] };
    this.headOf(this.title(j), chip, meta, link, acts.buttons, more, status);

    const parts: HTMLElement[] = [];
    if (this.confirm.get(j.id) === "remove") {
      const changed = j.dirty ? Math.max(j.changed ?? 0, 1) : 0;
      const commits = j.ahead > 0 && !j.pushed ? j.ahead : 0;
      const edits = changed ? ` Uncommitted edits to ${changed} file${changed === 1 ? "" : "s"} are deleted.` : "";
      const unpushed = commits ? ` Its ${commits} unpushed commit${commits === 1 ? " is" : "s are"} lost.` : "";
      parts.push(this.confirmBox(j.id, `Remove this review and its worktree?${edits}${unpushed}`, "Remove", () => void this.remove(j, changed, commits, false)));
    } else if (this.confirm.get(j.id) === "remove-unreadable") {
      parts.push(this.confirmBox(j.id, "Git couldn't read this review's worktree, so what it holds is unknown. Remove the review and delete the worktree anyway, with whatever is in it?", "Delete anyway", () => void this.remove(j, 0, 0, true)));
    } else if (this.confirm.get(j.id) === "orphan") {
      const c = el("div", "r-confirm");
      c.append(
        el("span", "", "An agent from the last session is still running in this worktree."),
        btn("Stop old agent", () => {
          this.confirm.set(j.id, "stop-orphan");
          this.render(true);
        }, "r-btn primary"),
        btn("Cancel", () => {
          this.confirm.delete(j.id);
          this.render(true);
        }, "r-btn quiet"),
      );
      parts.push(c);
    } else if (this.confirm.get(j.id) === "stop-orphan") {
      parts.push(this.confirmBox(j.id, "Stop the agent still running from the last session in this worktree?", "Stop it", () => void this.stopOrphan(j)));
    }
    if (running) parts.push(this.progress(j));
    else if (j.status === "failed") {
      parts.push(el("p", "r-detail bad", j.detail || "it failed"));
      parts.push(el("p", "r-detail", "Re-review runs it again from the start."));
    } else parts.push(...acts.below);
    if (j.log.length && this.logOpen.get(j.id)) parts.push(this.logBox(j));
    this.ctl.replaceChildren(...parts);
  }

  /** The steps of a running review, the current one timed. */
  private progress(j: Job): HTMLElement {
    const box = el("div", "r-progress");
    const at = stepOf(j.status);
    const ol = el("ol", "r-steps");
    STEPS.forEach(([, label], i) => {
      const li = el("li", i < at ? "done" : i === at ? "now" : "todo");
      const mark = el("span", "r-mark");
      if (i < at) mark.append(check());
      li.append(mark, el("span", "r-step", label));
      if (i === at) li.append(since(j.stage_at || j.started));
      ol.append(li);
    });
    const total = el("p", "r-detail");
    total.append("Running for ", since(j.started), `. ${j.depth} depth reviews often take several minutes.`);
    const now = el("p", "r-now", j.activity || j.detail);
    box.append(ol, now, total);
    return box;
  }

  /** The log, opened from the ⋯ menu; closed until asked for (a failed run says why above it). */
  private logBox(j: Job): HTMLElement {
    const box = el("div", "r-log");
    const head = el("div", "r-log-head");
    head.append(el("span", "", `Log (${j.log.length})`), btn("Close", () => {
      this.logOpen.delete(j.id);
      this.render(true);
    }, "r-btn quiet"));
    const pre = el("pre", "", j.log.join("\n"));
    box.append(head, pre);
    // Newest at the bottom, in view.
    requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
    return box;
  }

  /** Asks where the intent server is each time: it can come back on a new port. */
  private showFrame(rid: string, title: string): void {
    const down = (why: string) => {
      if (this.framed !== rid) return;
      // No gate pill to read: the header shows the verdict again.
      if (this.frameDown !== rid) {
        this.frameDown = rid;
        this.pageState = null;
        this.render(true);
      }
      // Plain words on the page; what went wrong goes in the tooltip and console.
      console.warn(`lookout: review ${rid} not framed: intent server down (${why})`);
      const p = el("p", "r-detail bad", "This review isn't available right now. ");
      p.title = `The intent server is down (${why}).`;
      p.append(btn("Retry", () => this.showFrame(rid, title), "r-btn quiet"));
      this.frameBox.replaceChildren(p);
    };
    invoke<IntentServer>("intent_server").then((s) => {
      if (!s.up || !s.origin) return down(s.reason ?? "no answer");
      if (this.framed !== rid) return;
      this.pageOrigin = new URL(s.origin).origin;
      if (this.frameDown === rid) {
        this.frameDown = "";
        this.render(true);
      }
      const f = el("iframe");
      // embed=app: the page leaves the title to this tab's header.
      f.src = `${s.origin}/review/${encodeURIComponent(rid)}?embed=app`;
      f.title = title;
      this.frameBox.replaceChildren(f);
    }, (e) => down(String(e)));
  }

  /**
   * The header's one control for findings, "N open ▾" ("N open · M picked
   * ▾" once some are picked), and what goes under the header row. N is the
   * set the gate pill counts ("blocked · N open"): every finding not
   * resolved or dismissed. It
   * opens one panel: the picker on top (Pick all, Blockers and majors,
   * Clear, then the list), and below it Edit, Fix with commits and Post
   * comments, acting on the picks, and Push. It is the header's one filled
   * primary only while something is picked; otherwise outlined.
   */
  private actions(j: Job): { buttons: HTMLElement[]; below: HTMLElement[] } {
    const out: HTMLElement[] = [];
    const rows = this.findings.get(j.id)?.rows ?? [];
    const ticked = this.ticked.get(j.id) ?? new Set<string>();
    const picked = [...ticked].filter((id) => rows.some((r) => r.id === id));
    const n = picked.length;
    const total = rows.length;
    const busy = !!j.busy;
    const canPush = j.ahead > 0 || j.dirty;

    if (j.cross) out.push(el("p", "r-detail bad", "From a fork: its code is untrusted. Editing and fixing run an agent over it; read the diff before trusting a result."));

    // The same word and set as the gate pill: "N open"; its tooltip gives
    // the breakdown by severity, as the pill's does. Short of width, an icon and "M/N".
    const bySev: Record<string, number> = {};
    for (const f of rows) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
    const words = total ? `${total} open${n ? ` · ${n} picked` : ""}` : "No open findings";
    const short = this.folds("findings");
    const toggle = el("button", `r-btn pickbtn${n ? " primary" : ""}${short ? " short" : ""}`);
    if (short) {
      toggle.append(listIcon(), `${n ? `${n}/${total}` : total} ▾`);
      toggle.setAttribute("aria-label", words);
    } else toggle.textContent = `${words} ▾`;
    toggle.disabled = !total && !canPush;
    toggle.title = (total ? `${openSummary(bySev)}. ` : "") + (n ? `Edit, fix or post the ${n} picked, or pick others` : total ? "Pick findings to edit, fix or post" : "Push the fixes' commits");

    const acts: HTMLButtonElement[] = [];
    const none = "Pick findings first";
    const edit = btn("Edit", () => void this.run(j, "review_fix", { ids: picked, commit: false }), "r-btn quiet");
    edit.title = n ? `The reviewer's session changes files in the worktree for the ${n} picked. Nothing is committed.` : none;
    const fix = btn("Fix with commits", () => void this.run(j, "review_fix", { ids: picked, commit: true }), "r-btn quiet");
    fix.title = n ? "Same, one commit per fix. Nothing is pushed." : none;
    const post = btn("Post comments", () => {
      this.confirm.set(j.id, "post");
      this.render(true);
    }, "r-btn quiet");
    post.title = !j.pr ? "This branch has no open pull request" : n ? `The ${n} picked as one review on PR #${j.pr}` : none;
    edit.disabled = fix.disabled = busy || !n;
    post.disabled = busy || !j.pr || !n;
    if (total) acts.push(edit, fix, post);
    if (canPush) {
      const push = btn(`Push ${j.ahead} commit${j.ahead === 1 ? "" : "s"}`, () => {
        this.confirm.set(j.id, "push");
        this.render(true);
      }, "r-btn quiet");
      push.disabled = busy || j.cross || j.dirty || !j.ahead || j.pushed;
      push.title = j.cross ? "A pull request from a fork: the fixes stay local" : j.dirty ? "Uncommitted edits: commit them with Fix, or leave them" : `To ${j.branch}`;
      acts.push(push);
    }
    const top: HTMLElement[] = [];
    if (total) {
      const sep = el("div", "r-menu-sep");
      sep.setAttribute("role", "separator");
      top.push(this.picker(j.id, rows, ticked, busy), sep, el("p", "r-menu-meta", n ? `Acts on the ${n} picked` : "Pick findings to act on them"));
    }
    const bar = [this.menu(`find:${j.id}`, toggle, acts, "", top, { role: "dialog", cls: "r-find-panel", label: "Findings" })];

    const state: string[] = [];
    if (j.ahead) state.push(`${j.ahead} local commit${j.ahead === 1 ? "" : "s"}${j.pushed ? " (pushed)" : ""}`);
    if (j.dirty) state.push("uncommitted edits in the worktree");
    if (j.posted) state.push("comments posted");
    if (state.length) out.push(el("p", "r-detail", state.join(" · ")));
    if (j.posted) {
      const a = el("a", "r-link", j.posted);
      a.href = j.posted;
      a.target = "_blank";
      a.rel = "noreferrer";
      out.push(a);
    }

    const pending = this.confirm.get(j.id);
    if (pending === "post" || pending === "push") {
      const say = pending === "post" ? `Post ${n} finding${n === 1 ? "" : "s"} as one review on ${j.repo} PR #${j.pr}? Everyone watching the pull request is notified, and the text is the reviewer's, not yours.` : `Push ${j.ahead} commit${j.ahead === 1 ? "" : "s"} to ${j.repo}:${j.branch}? It is never forced. Read the diff in the review first.`;
      out.push(this.confirmBox(j.id, say, pending === "post" ? "Post" : "Push", () => void this.run(j, pending === "post" ? "review_post" : "review_push", pending === "post" ? { ids: picked } : {})));
    }
    return { buttons: bar, below: out };
  }

  /**
   * The top of the findings panel: quick picks by severity, then the list.
   * A pick redraws the header with the panel still open, and gives the focus
   * back to what was clicked.
   */
  private picker(key: string, rows: Finding[], ticked: Set<string>, busy: boolean): HTMLElement {
    const box = el("div", "r-picker");
    const refocus = (sel: string) => this.head.querySelector<HTMLElement>(`.r-find-panel ${sel}`)?.focus();
    const set = (ids: string[], which: string) => {
      this.ticked.set(key, new Set(ids));
      this.render(true);
      refocus(`[data-quick="${which}"]`);
    };
    const quick = el("div", "r-quick");
    const q = (label: string, which: string, ids: () => string[]) => {
      const b = btn(label, () => set(ids(), which), "r-btn quiet");
      b.dataset.quick = which;
      b.disabled = busy;
      return b;
    };
    quick.append(
      q("Pick all", "all", () => rows.map((f) => f.id)),
      q("Blockers and majors", "bm", () => rows.filter((f) => f.severity === "blocker" || f.severity === "major").map((f) => f.id)),
      q("Clear", "none", () => []),
    );
    box.append(quick);
    const ul = el("ul", "r-findings");
    for (const f of rows) {
      const li = el("li");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = ticked.has(f.id);
      cb.disabled = busy;
      cb.dataset.fid = f.id;
      cb.setAttribute("aria-label", `${f.severity}: ${f.summary}`);
      cb.addEventListener("change", () => {
        const t = this.ticked.get(key) ?? new Set<string>();
        if (cb.checked) t.add(f.id);
        else t.delete(f.id);
        this.ticked.set(key, t);
        this.render(true);
        refocus(`input[data-fid="${CSS.escape(f.id)}"]`);
      });
      const label = el("label");
      label.title = `${f.file}:${f.line}: ${f.summary}`;
      // Chip and place lead the first line; the title flows after them and
      // wraps to a second line (clamped), so it is not cut mid-word.
      const text = el("span", "r-find-text");
      text.append(el("span", `r-sev ${f.severity}`, f.severity), " ", el("span", "r-loc", `${f.file.split("/").pop()}:${f.line}`), " ", el("span", "r-sum", f.summary));
      label.append(cb, text);
      li.append(label);
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  /** A yes/cancel strip; yes clears the pending confirm, then acts. */
  private confirmBox(key: string, say: string, yes: string, act: () => void): HTMLElement {
    const c = el("div", "r-confirm");
    c.append(
      el("span", "", say),
      btn(yes, () => {
        this.confirm.delete(key);
        act();
      }, "r-btn primary"),
      btn("Cancel", () => {
        this.confirm.delete(key);
        this.render(true);
      }, "r-btn quiet"),
    );
    return c;
  }

  // ---- suggestions under the input ----

  private async showPicks(): Promise<void> {
    this.pickBox.hidden = false;
    this.drawPicks();
    await this.loadPicks();
  }

  private drawPicks(): void {
    if (this.pickBox.hidden) return;
    const q = this.input.value.trim().toLowerCase();
    const parts: HTMLElement[] = [];
    if (!this.picks) parts.push(el("p", "r-none", "Asking GitHub…"));
    else {
      const match = (p: Pick) => !q || p.input.toLowerCase().includes(q) || p.title.toLowerCase().includes(q);
      const group = (label: string, ps: Pick[]) => {
        const shown = ps.filter(match);
        if (!shown.length) return;
        parts.push(el("h4", "r-pick-sec", label));
        for (const p of shown) {
          const b = el("button", "r-pick");
          b.type = "button";
          const top = el("span", "r-pick-title", p.title || p.input);
          const sub = el("span", "r-pick-sub", `${p.input}${p.updated ? ` · ${ago(p.updated)}` : ""}`);
          b.append(top, sub);
          b.addEventListener("click", () => {
            this.input.value = p.input;
            this.pickBox.hidden = true;
            this.go.focus();
          });
          parts.push(b);
        }
      };
      group("Waiting on your review", this.picks.requested);
      group("Your pull requests", this.picks.mine);
      group("Recent branches", this.picks.branches);
      if (this.picks.problem) parts.push(el("p", "r-none", `GitHub didn't answer: ${this.picks.problem}`));
      if (!parts.length) parts.push(el("p", "r-none", q ? "No match. Review runs whatever you typed." : "Nothing open on GitHub, and no pushed branches nearby."));
    }
    this.pickBox.replaceChildren(...parts);
  }
}
