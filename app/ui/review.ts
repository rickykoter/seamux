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
  busy: string;
  log: string[];
  open: Record<string, number>;
  ahead: number;
  dirty: boolean;
  pushed: boolean;
  posted: string;
};
type Finding = { id: string; file: string; line: number; severity: string; summary: string; status?: string };
type IntentServer = { origin: string | null; up: boolean; reason: string | null };

const DEPTHS: [string, string][] = [
  ["low", "Low · blockers and majors"],
  ["medium", "Medium · no nits"],
  ["high", "High · everything supported"],
  ["xhigh", "Extra high · whole files and callers"],
  ["max", "Max · exhaustive"],
];
const MODELS: [string, string][] = [
  ["", "Default model"],
  ["haiku", "Haiku"],
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["fable", "Fable"],
];
const SEVERITIES = ["blocker", "major", "minor", "nit"];
const RUNNING = new Set(["resolving", "cloning", "fetching", "opening", "reviewing"]);

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

/** The Lookout tab: paste a repo, branch or pull request, review it in a new headless agent, then edit, comment or fix. */
export class ReviewView {
  private jobs: Job[] = [];
  private form = el("form", "r-form");
  private input = el("input", "r-input");
  private depth = select(DEPTHS, "high");
  private model = select(MODELS, "");
  private go = el("button", "r-btn primary", "Review");
  private err = el("p", "r-err");
  private list = el("div", "r-list");
  private cards = new Map<string, HTMLElement>();
  /** What each card last drew, so a frame that changes nothing redraws nothing. */
  private drawn = new Map<string, string>();
  private findings = new Map<string, { key: string; rows: Finding[] }>();
  /** Per job: the ticked findings, whether its page is open, and a pending confirm. */
  private ticked = new Map<string, Set<string>>();
  private framed = new Set<string>();
  private confirm = new Map<string, "post" | "push" | "remove">();
  private origin: string | null = null;

  constructor(private root: HTMLElement) {
    this.root.className = "review";
    this.input.type = "text";
    this.input.placeholder = "github.com/owner/repo/pull/123 · owner/repo@branch · owner/repo#123";
    this.input.setAttribute("aria-label", "GitHub repo, branch or pull request");
    this.input.spellcheck = false;
    this.go.type = "submit";
    const head = el("div", "r-head");
    head.append(el("span", "r-title", "Lookout"), el("span", "r-hint", "paste a branch or pull request; a fresh agent reviews it in a throwaway worktree"));
    const row = el("div", "r-row");
    row.append(this.input, this.depth, this.model, this.go);
    this.form.append(row, this.err);
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.start();
    });
    this.root.append(head, this.form, this.list);
  }

  async start(): Promise<void> {
    this.err.textContent = "";
    const input = this.input.value.trim();
    if (!input) return;
    this.go.disabled = true;
    try {
      await invoke("review_start", { input, depth: this.depth.value, model: this.model.value });
      this.input.value = "";
    } catch (e) {
      this.err.textContent = String(e);
    } finally {
      this.go.disabled = false;
    }
  }

  async begin(): Promise<void> {
    await listen<Job[]>("review:frame", (e) => this.take(e.payload));
    this.take(await invoke<Job[]>("review_jobs"));
  }

  private take(jobs: Job[]): void {
    this.jobs = jobs;
    const live = new Set(jobs.map((j) => j.id));
    for (const [id, card] of this.cards) {
      if (!live.has(id)) {
        card.remove();
        this.cards.delete(id);
        this.drawn.delete(id);
      }
    }
    let before: Element | null = null;
    for (const j of [...jobs].reverse()) {
      const key = JSON.stringify(j) + (this.confirm.get(j.id) ?? "") + [...(this.ticked.get(j.id) ?? [])].join() + this.framed.has(j.id);
      let card = this.cards.get(j.id);
      if (!card) {
        card = el("article", "r-card");
        this.cards.set(j.id, card);
      }
      if (this.drawn.get(j.id) !== key) {
        this.drawn.set(j.id, key);
        this.draw(card, j);
      }
      // Newest first: each card goes before the one drawn after it.
      this.list.insertBefore(card, before);
      before = card;
    }
    if (!jobs.length && !this.list.firstChild) this.list.append(el("p", "r-empty", "No reviews yet."));
    else if (jobs.length) this.list.querySelector(".r-empty")?.remove();
  }

  private redraw(id: string): void {
    this.drawn.delete(id);
    this.take(this.jobs);
  }

  private title(j: Job): string {
    return `${j.repo} · ${j.pr ? `PR #${j.pr}` : j.branch || j.input}`;
  }

  private draw(card: HTMLElement, j: Job): void {
    card.replaceChildren();
    const head = el("div", "r-card-head");
    head.append(el("span", "r-name", this.title(j)), el("span", `r-chip ${j.status}`, j.busy || j.status), el("span", "r-meta", `${j.depth} · ${j.model || "default model"}`));
    const grow = el("span", "r-grow");
    head.append(grow);
    if (!RUNNING.has(j.status) && !j.busy)
      head.append(btn("Remove", () => {
        this.confirm.set(j.id, "remove");
        this.redraw(j.id);
      }, "r-btn quiet"));
    card.append(head);
    // An in-card confirm: the webview shows no window.confirm dialog.
    if (this.confirm.get(j.id) === "remove") {
      const unpushed = j.ahead && !j.pushed ? ` Its ${j.ahead} unpushed commit${j.ahead === 1 ? " is" : "s are"} lost.` : "";
      card.append(this.confirmBox(j, `Remove this review and its worktree?${unpushed}`, "Remove", () => void this.remove(j)));
    }

    if (j.status !== "ready") {
      card.append(el("p", j.status === "failed" ? "r-detail bad" : "r-detail", j.detail || "starting"));
      if (j.log.length) card.append(this.logBox(j));
      return;
    }

    const open = SEVERITIES.filter((s) => j.open[s]).map((s) => `${j.open[s]} ${s}`);
    card.append(el("p", "r-detail", `${open.length ? open.join(" · ") : "no open findings"}${j.base ? ` · against ${j.base}` : ""}`));

    const bar = el("div", "r-bar");
    bar.append(btn(this.framed.has(j.id) ? "Hide review" : "Open review", () => this.toggleFrame(j)));
    card.append(bar);
    if (this.framed.has(j.id)) card.append(this.frame(j));
    card.append(this.actions(j));
    if (j.log.length) card.append(this.logBox(j));
    void this.loadFindings(j);
  }

  private logBox(j: Job): HTMLElement {
    const d = el("details", "r-log");
    d.append(el("summary", "", `log (${j.log.length})`), el("pre", "", j.log.join("\n")));
    return d;
  }

  private frame(j: Job): HTMLElement {
    const box = el("div", "r-frame");
    const show = (origin: string) => {
      const f = el("iframe");
      f.src = `${origin}/review/${encodeURIComponent(j.review_id)}`;
      f.title = this.title(j);
      box.replaceChildren(f);
    };
    if (this.origin) show(this.origin);
    else
      void invoke<IntentServer>("intent_server").then((s) => {
        if (s.up && s.origin) {
          this.origin = s.origin;
          show(s.origin);
        } else box.replaceChildren(el("p", "r-detail bad", `The intent server is down (${s.reason ?? "no answer"}), so the review page can't be shown here.`));
      });
    return box;
  }

  private toggleFrame(j: Job): void {
    if (!this.framed.delete(j.id)) this.framed.add(j.id);
    this.redraw(j.id);
  }

  private async loadFindings(j: Job): Promise<void> {
    const key = `${JSON.stringify(j.open)}|${j.busy}|${j.ahead}`;
    if (this.findings.get(j.id)?.key === key) return;
    try {
      const all = await invoke<Finding[]>("review_findings", { id: j.id });
      const rows = all.filter((f) => f.status !== "resolved" && f.status !== "dismissed");
      this.findings.set(j.id, { key, rows });
      if (!this.ticked.has(j.id)) this.ticked.set(j.id, new Set(rows.filter((f) => f.severity === "blocker" || f.severity === "major").map((f) => f.id)));
      this.drawn.delete(j.id);
      this.take(this.jobs);
    } catch (e) {
      this.err.textContent = String(e);
    }
  }

  private actions(j: Job): HTMLElement {
    const box = el("div", "r-actions");
    const rows = this.findings.get(j.id)?.rows ?? [];
    const ticked = this.ticked.get(j.id) ?? new Set<string>();
    const busy = !!j.busy;

    if (rows.length) {
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
          this.redraw(j.id);
        });
        const label = el("label");
        label.append(cb, el("span", `r-sev ${f.severity}`, f.severity), el("span", "r-loc", `${f.file.split("/").pop()}:${f.line}`), el("span", "r-sum", f.summary));
        li.append(label);
        ul.append(li);
      }
      box.append(ul);
    }

    const picked = [...ticked].filter((id) => rows.some((r) => r.id === id));
    const row = el("div", "r-bar");
    const n = picked.length;
    const edit = btn(`Edit${n ? ` (${n})` : ""}`, () => void this.run(j, "review_fix", { ids: picked, commit: false }));
    edit.title = "The reviewer's session changes files in the worktree. Nothing is committed.";
    const fix = btn(`Fix with commits${n ? ` (${n})` : ""}`, () => void this.run(j, "review_fix", { ids: picked, commit: true }));
    fix.title = "Same, one commit per fix. Nothing is pushed.";
    const post = btn(`Post comments${n ? ` (${n})` : ""}`, () => {
      this.confirm.set(j.id, "post");
      this.redraw(j.id);
    });
    post.title = j.pr ? `One review on PR #${j.pr}` : "This branch has no open pull request";
    post.disabled = !j.pr || !n;
    edit.disabled = fix.disabled = busy || !rows.length;
    post.disabled = post.disabled || busy;
    row.append(edit, fix, post);
    if (j.cross) box.append(el("p", "r-detail bad", "From a fork: its code is untrusted. Editing and fixing run an agent over it; read the diff before trusting a result."));
    if (j.ahead || j.dirty) {
      const push = btn(`Push ${j.ahead} commit${j.ahead === 1 ? "" : "s"}`, () => {
        this.confirm.set(j.id, "push");
        this.redraw(j.id);
      });
      push.disabled = busy || j.cross || j.dirty || !j.ahead || j.pushed;
      push.title = j.cross ? "A pull request from a fork: the fixes stay local" : j.dirty ? "Uncommitted edits: commit them with Fix, or leave them" : `To ${j.branch}`;
      row.append(push);
    }
    box.append(row);

    const state: string[] = [];
    if (j.ahead) state.push(`${j.ahead} local commit${j.ahead === 1 ? "" : "s"}${j.pushed ? " (pushed)" : ""}`);
    if (j.dirty) state.push("uncommitted edits in the worktree");
    if (j.posted) state.push("comments posted");
    if (state.length) box.append(el("p", "r-detail", state.join(" · ")));
    if (j.posted) {
      const a = el("a", "r-link", j.posted);
      a.href = j.posted;
      a.target = "_blank";
      a.rel = "noreferrer";
      box.append(a);
    }

    const pending = this.confirm.get(j.id);
    if (pending === "post" || pending === "push") {
      const say = pending === "post" ? `Post ${n} finding${n === 1 ? "" : "s"} as one review on ${j.repo} PR #${j.pr}? Everyone watching the pull request is notified, and the text is the reviewer's, not yours.` : `Push ${j.ahead} commit${j.ahead === 1 ? "" : "s"} to ${j.repo}:${j.branch}? It is never forced. Read the diff in the review first.`;
      box.append(this.confirmBox(j, say, pending === "post" ? "Post" : "Push", () => void this.run(j, pending === "post" ? "review_post" : "review_push", pending === "post" ? { ids: picked } : {})));
    }
    return box;
  }

  /** A yes/cancel strip in the card; yes clears the pending confirm, then acts. */
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
        this.redraw(j.id);
      }, "r-btn quiet"),
    );
    return c;
  }

  private async run(j: Job, cmd: string, args: Record<string, unknown>): Promise<void> {
    this.err.textContent = "";
    try {
      await invoke(cmd, { id: j.id, ...args });
    } catch (e) {
      this.err.textContent = String(e);
    }
    this.redraw(j.id);
  }

  private async remove(j: Job): Promise<void> {
    try {
      await invoke("review_remove", { id: j.id });
    } catch (e) {
      this.err.textContent = String(e);
      this.redraw(j.id);
    }
  }
}
