import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// A job as review_app.rs serves it.
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
/** A lookout review opened from a terminal session. */
type Other = { id: string; title: string; root: string; branch: string; updated: number; open: Record<string, number> };
type Pick = { input: string; repo: string; title: string; updated: number };
type Picks = { requested: Pick[]; mine: Pick[]; branches: Pick[]; problem: string };
type Finding = { id: string; file: string; line: number; severity: string; summary: string; status?: string };
type IntentServer = { origin: string | null; up: boolean; reason: string | null };

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

function openSummary(open: Record<string, number>): string {
  const parts = SEVERITIES.filter((s) => open[s]).map((s) => `${open[s]} ${s}`);
  return parts.length ? parts.join(" · ") : "no open findings";
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

  private side = el("aside", "r-side");
  private main = el("section", "r-main");
  private input = el("input", "r-input");
  private pickBox = el("div", "r-picks");
  private depth = select(DEPTHS, "high");
  private model = select(MODELS, "");
  private go = el("button", "r-btn primary", "Review");
  private err = el("p", "r-err");
  private list = el("div", "r-list");
  private head = el("header", "r-mhead");
  private ctl = el("div", "r-ctl");
  private frameBox = el("div", "r-frame");
  /** What the head and controls, and the frame, last drew. */
  private drawn = "";
  private framed = "";

  private findings = new Map<string, { key: string; rows: Finding[] }>();
  /** Per job: the ticked findings, whether the picker is open, a pending confirm. */
  private ticked = new Map<string, Set<string>>();
  private pickerOpen = new Set<string>();
  /** Logs the reader opened or closed, so a redraw keeps them that way. */
  private logOpen = new Map<string, boolean>();
  private confirm = new Map<string, "post" | "push" | "remove" | "remove-unreadable">();
  /** Per job: the run its ticks, findings, picker and confirm belong to. */
  private runs = new Map<string, string>();

  constructor(private root: HTMLElement) {
    this.root.className = "review";
    try {
      this.selected = localStorage.getItem(SEL_KEY);
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
    const means = () => (this.depth.title = DEPTH_MEANS[this.depth.value] ?? "");
    means();
    this.depth.addEventListener("change", means);

    const form = el("form", "r-form");
    const field = el("div", "r-field");
    field.append(this.input, this.pickBox);
    const opts = el("div", "r-opts");
    opts.append(this.depth, this.model, this.go);
    form.append(el("span", "r-title", "New review"), field, opts, this.err);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.start(this.input.value.trim(), this.depth.value, this.model.value);
    });
    this.side.append(form, this.list);
    this.main.append(this.head, this.ctl, this.frameBox);
    this.root.append(this.side, this.main);

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
    this.pickerOpen.delete(id);
    this.confirm.delete(id);
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
    const key = `${runOf(j)}|${JSON.stringify(j.open)}|${j.busy}|${j.ahead}`;
    if (this.findings.get(j.id)?.key === key) return;
    this.findings.set(j.id, { key, rows: this.findings.get(j.id)?.rows ?? [] });
    try {
      const all = await invoke<Finding[]>("review_findings", { id: j.id });
      const rows = all.filter((f) => f.status !== "resolved" && f.status !== "dismissed");
      // A newer run, or a newer state of this one, asked since: its answer stands.
      if (this.findings.get(j.id)?.key !== key) return;
      this.findings.set(j.id, { key, rows });
      if (!this.ticked.has(j.id)) this.ticked.set(j.id, new Set(rows.filter((f) => f.severity === "blocker" || f.severity === "major").map((f) => f.id)));
      this.render();
    } catch (e) {
      this.err.textContent = String(e);
    }
  }

  // ---- actions ----

  private async start(input: string, depth: string, model: string): Promise<void> {
    this.err.textContent = "";
    if (!input) return;
    this.go.disabled = true;
    try {
      const id = await invoke<string>("review_start", { input, depth, model });
      this.forget(id);
      if (input === this.input.value.trim()) this.input.value = "";
      this.pickBox.hidden = true;
      this.pick(`job:${id}`);
    } catch (e) {
      this.err.textContent = String(e);
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
      if (why.includes("nothing was removed")) this.confirm.set(j.id, "remove");
      else if (why.includes("couldn't read its worktree")) this.confirm.set(j.id, "remove-unreadable");
      this.render(true);
    }
  }

  private pick(sel: string | null): void {
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
        const line = el("span", "r-item-line", `${n ? `${n} open` : "all closed"} · ${ago(o.updated)}`);
        items.push(row(`other:${o.id}`, o.title, line, n ? "open" : "closed"));
      }
    }
    this.list.replaceChildren(...items);
  }

  private drawMain(force: boolean): void {
    const sel = this.selected;
    const job = sel?.startsWith("job:") ? this.jobs.find((j) => `job:${j.id}` === sel) : undefined;
    const other = sel?.startsWith("other:") ? this.others.find((o) => `other:${o.id}` === sel) : undefined;

    const key = JSON.stringify([sel, job, other, this.confirm.get(job?.id ?? ""), [...(this.ticked.get(job?.id ?? "") ?? [])], this.pickerOpen.has(job?.id ?? ""), this.findings.get(job?.id ?? "")?.rows.length]);
    if (force || key !== this.drawn) {
      this.drawn = key;
      if (job) this.drawJob(job);
      else if (other) this.drawOther(other);
      else this.drawEmpty();
    }

    // The page is drawn once per review and kept: moving or redrawing an
    // iframe reloads it, losing the reader's place.
    const page = job && job.status === "ready" && job.review_id ? job.review_id : other ? other.id : "";
    if (page !== this.framed) {
      this.framed = page;
      this.frameBox.replaceChildren();
      this.frameBox.hidden = !page;
      if (page) this.showFrame(page, job ? this.title(job) : other?.title ?? page);
    }
    if (job?.status === "ready") void this.loadFindings(job);
  }

  private drawEmpty(): void {
    const msg = el("div", "r-empty");
    msg.append(el("p", "", this.jobs.length || this.others.length ? "Pick a review on the left." : "Start a review on the left: paste a pull request, or pick one of yours."));
    this.head.replaceChildren();
    this.ctl.replaceChildren(msg);
  }

  private headOf(name: string, chip: HTMLElement | null, meta: string, link: string | null, buttons: HTMLElement[]): void {
    const h = el("div", "r-mhead-row");
    h.append(el("h2", "r-name", name));
    if (chip) h.append(chip);
    h.append(el("span", "r-meta", meta));
    if (link) {
      const a = el("a", "r-link", "GitHub");
      a.href = link;
      a.target = "_blank";
      a.rel = "noreferrer";
      h.append(a);
    }
    h.append(el("span", "r-grow"), ...buttons);
    this.head.replaceChildren(h);
  }

  private drawOther(o: Other): void {
    const dir = o.root.split("/").filter(Boolean).pop() ?? o.root;
    this.headOf(o.title, null, `from a terminal · ${dir}${o.branch ? ` · ${o.branch}` : ""} · ${ago(o.updated)}`, null, []);
    const p = el("p", "r-detail", `${openSummary(o.open)}. Edit, fix and post from the session that opened it.`);
    this.ctl.replaceChildren(p);
  }

  private drawJob(j: Job): void {
    const running = RUNNING.has(j.status);
    const chip = el("span", `r-chip ${running ? "running" : j.status}`, j.busy || (running ? "reviewing" : j.status));
    const buttons: HTMLElement[] = [];
    if (!running && !j.busy) {
      const again = btn("Re-review", () => void this.start(j.input, j.depth, j.model));
      again.title = "Review it again from its latest commit. This replaces this run and its worktree.";
      buttons.push(again, btn("Remove", () => {
        this.confirm.set(j.id, "remove");
        this.render(true);
      }, "r-btn quiet"));
    }
    const link = j.repo ? `https://github.com/${j.repo}${j.pr ? `/pull/${j.pr}` : j.branch ? `/tree/${j.branch}` : ""}` : null;
    this.headOf(this.title(j), chip, `${j.depth} · ${j.model || "default model"}${j.base ? ` · against ${j.base}` : ""}`, link, buttons);

    const parts: HTMLElement[] = [];
    if (this.confirm.get(j.id) === "remove") {
      const changed = j.dirty ? Math.max(j.changed ?? 0, 1) : 0;
      const commits = j.ahead > 0 && !j.pushed ? j.ahead : 0;
      const edits = changed ? ` Uncommitted edits to ${changed} file${changed === 1 ? "" : "s"} are deleted.` : "";
      const unpushed = commits ? ` Its ${commits} unpushed commit${commits === 1 ? " is" : "s are"} lost.` : "";
      parts.push(this.confirmBox(j, `Remove this review and its worktree?${edits}${unpushed}`, "Remove", () => void this.remove(j, changed, commits, false)));
    } else if (this.confirm.get(j.id) === "remove-unreadable") {
      parts.push(this.confirmBox(j, "Git couldn't read this review's worktree, so what it holds is unknown. Remove the review and delete the worktree anyway, with whatever is in it?", "Delete anyway", () => void this.remove(j, 0, 0, true)));
    }
    if (running) parts.push(this.progress(j));
    else if (j.status === "failed") {
      parts.push(el("p", "r-detail bad", j.detail || "it failed"));
      parts.push(el("p", "r-detail", "Re-review runs it again from the start."));
    } else parts.push(...this.actions(j));
    if (j.log.length) parts.push(this.logBox(j));
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

  private logBox(j: Job): HTMLElement {
    const d = el("details", "r-log");
    d.open = this.logOpen.get(j.id) ?? j.status === "failed";
    d.addEventListener("toggle", () => this.logOpen.set(j.id, d.open));
    const pre = el("pre", "", j.log.join("\n"));
    d.append(el("summary", "", `log (${j.log.length})`), pre);
    // Newest at the bottom, in view.
    requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
    return d;
  }

  /** Asks where the intent server is each time: it can come back on a new port. */
  private showFrame(rid: string, title: string): void {
    const down = (why: string) => {
      if (this.framed !== rid) return;
      const p = el("p", "r-detail bad", `The intent server is down (${why}), so the review page can't be shown here. `);
      p.append(btn("Retry", () => this.showFrame(rid, title), "r-btn quiet"));
      this.frameBox.replaceChildren(p);
    };
    invoke<IntentServer>("intent_server").then((s) => {
      if (!s.up || !s.origin) return down(s.reason ?? "no answer");
      if (this.framed !== rid) return;
      const f = el("iframe");
      f.src = `${s.origin}/review/${encodeURIComponent(rid)}`;
      f.title = title;
      this.frameBox.replaceChildren(f);
    }, (e) => down(String(e)));
  }

  /** Edit, fix, post and push, over the findings ticked in the picker. */
  private actions(j: Job): HTMLElement[] {
    const out: HTMLElement[] = [];
    const rows = this.findings.get(j.id)?.rows ?? [];
    const ticked = this.ticked.get(j.id) ?? new Set<string>();
    const picked = [...ticked].filter((id) => rows.some((r) => r.id === id));
    const n = picked.length;
    const busy = !!j.busy;

    if (j.cross) out.push(el("p", "r-detail bad", "From a fork: its code is untrusted. Editing and fixing run an agent over it; read the diff before trusting a result."));

    const bar = el("div", "r-bar");
    const open = this.pickerOpen.has(j.id);
    const toggle = btn(`Findings ${n} of ${rows.length} ${open ? "▴" : "▾"}`, () => {
      if (!this.pickerOpen.delete(j.id)) this.pickerOpen.add(j.id);
      this.render(true);
    }, "r-btn pickbtn");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.disabled = !rows.length;
    const suffix = n ? ` (${n})` : "";
    const edit = btn(`Edit${suffix}`, () => void this.run(j, "review_fix", { ids: picked, commit: false }));
    edit.title = "The reviewer's session changes files in the worktree. Nothing is committed.";
    const fix = btn(`Fix with commits${suffix}`, () => void this.run(j, "review_fix", { ids: picked, commit: true }));
    fix.title = "Same, one commit per fix. Nothing is pushed.";
    const post = btn(`Post comments${suffix}`, () => {
      this.confirm.set(j.id, "post");
      this.render(true);
    });
    post.title = j.pr ? `One review on PR #${j.pr}` : "This branch has no open pull request";
    edit.disabled = fix.disabled = busy || !n;
    post.disabled = busy || !j.pr || !n;
    bar.append(toggle, edit, fix, post);
    if (j.ahead || j.dirty) {
      const push = btn(`Push ${j.ahead} commit${j.ahead === 1 ? "" : "s"}`, () => {
        this.confirm.set(j.id, "push");
        this.render(true);
      });
      push.disabled = busy || j.cross || j.dirty || !j.ahead || j.pushed;
      push.title = j.cross ? "A pull request from a fork: the fixes stay local" : j.dirty ? "Uncommitted edits: commit them with Fix, or leave them" : `To ${j.branch}`;
      bar.append(push);
    }
    const summary = el("span", "r-meta", openSummary(j.open));
    bar.append(el("span", "r-grow"), summary);
    out.push(bar);

    if (open && rows.length) out.push(this.picker(j, rows, ticked, busy));

    if (busy) {
      const p = el("p", "r-now");
      p.append(`${j.busy}: ${j.activity || "starting"}`);
      out.push(p);
    }
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
      out.push(this.confirmBox(j, say, pending === "post" ? "Post" : "Push", () => void this.run(j, pending === "post" ? "review_post" : "review_push", pending === "post" ? { ids: picked } : {})));
    }
    return out;
  }

  /** Which findings the buttons act on, with quick picks by severity. */
  private picker(j: Job, rows: Finding[], ticked: Set<string>, busy: boolean): HTMLElement {
    const box = el("div", "r-picker");
    const set = (ids: string[]) => {
      this.ticked.set(j.id, new Set(ids));
      this.render(true);
    };
    const quick = el("div", "r-quick");
    quick.append(
      btn("All", () => set(rows.map((f) => f.id)), "r-btn quiet"),
      btn("Blockers and majors", () => set(rows.filter((f) => f.severity === "blocker" || f.severity === "major").map((f) => f.id)), "r-btn quiet"),
      btn("None", () => set([]), "r-btn quiet"),
    );
    box.append(quick);
    const ul = el("ul", "r-findings");
    for (const f of rows) {
      const li = el("li");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = ticked.has(f.id);
      cb.disabled = busy;
      cb.setAttribute("aria-label", `${f.id}: ${f.summary}`);
      cb.addEventListener("change", () => {
        const t = this.ticked.get(j.id) ?? new Set<string>();
        if (cb.checked) t.add(f.id);
        else t.delete(f.id);
        this.ticked.set(j.id, t);
        this.render(true);
      });
      const label = el("label");
      label.append(cb, el("span", `r-sev ${f.severity}`, f.severity), el("span", "r-loc", `${f.file.split("/").pop()}:${f.line}`), el("span", "r-sum", f.summary));
      li.append(label);
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  /** A yes/cancel strip; yes clears the pending confirm, then acts. */
  private confirmBox(j: Job, say: string, yes: string, act: () => void): HTMLElement {
    const c = el("div", "r-confirm");
    c.append(
      el("span", "", say),
      btn(yes, () => {
        this.confirm.delete(j.id);
        act();
      }, "r-btn primary"),
      btn("Cancel", () => {
        this.confirm.delete(j.id);
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
