// The reclaim wizard: what reclaiming a shipped workspace would remove, every
// guard crew-reclaim checks, and one button that does it once they all pass.
// The board's reclaim chip opens it when the app frames the board (dock.ts);
// crew-reclaim does the checking and the deleting (reclaim_app.rs), this only
// shows and asks.
import { invoke } from "@tauri-apps/api/core";

type Check = { kind: "pass" | "fail" | "skip" | "warn"; text: string; hint: string | null };
type Report = {
  worktree: string;
  branch: string | null;
  size: string | null;
  base: string | null;
  workspace: { id: string; name: string } | null;
  plan: string | null;
  sandbox: string | null;
  checks: Check[];
  blockers: number;
  remove: { what: string; target: string; note: string }[];
};
type Step = { kind: "done" | "note" | "error"; text: string };

const SVG = "http://www.w3.org/2000/svg";
/** Small marks, drawn: a tick, a cross, a dot, a bang. */
const MARKS: Record<string, string> = {
  pass: "M2.5 5.3 4.3 7.1 7.6 3",
  done: "M2.5 5.3 4.3 7.1 7.6 3",
  fail: "M3 3l4 4M7 3 3 7",
  error: "M3 3l4 4M7 3 3 7",
  warn: "M5 2.4v3.4M5 7.4v.2",
  skip: "M4.6 5h.8",
  note: "M3 5h3.4M5.2 3.6 6.6 5 5.2 6.4",
};
function mark(kind: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `rc-mark ${kind}`);
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", MARKS[kind] ?? MARKS.skip);
  svg.append(p);
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(label: string, cls: string, on: () => void): HTMLButtonElement {
  const b = el("button", `sheet-btn ${cls}`.trim(), label);
  b.type = "button";
  b.addEventListener("click", on);
  return b;
}
/** A cmux ref in parentheses, "(workspace:4)": the person reads the name
 *  beside it, so the ref goes to the tooltip. */
const REF = /\s*\((?:workspace|pane|surface|tab|window):[\w-]+\)/g;
/** A span of `text` with any cmux ref left out; the full text, ref and
 *  all, is its tooltip. Text that is only a ref keeps it. */
function said(cls: string, text: string): HTMLSpanElement {
  const bare = text.replace(REF, "").trim();
  const s = el("span", cls, bare || text);
  if (bare && bare !== text) s.title = text;
  return s;
}
/** A long path, its home shown as ~. */
const tidy = (p: string, home: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

type Stage = "check" | "review" | "run" | "done";

export class ReclaimWizard {
  el = el("div", "reclaim");
  /** After a reclaim that went through: the workspace is gone. */
  onReclaimed: (ws: string) => void = () => {};
  private card = el("div", "reclaim-card");
  private ws = "";
  private name = "";
  private stage: Stage = "check";
  private seq = 0;
  private home = "";

  constructor() {
    this.el.hidden = true;
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.el.append(this.card);
    // A click on the dimmed backdrop cancels, as Esc does (never mid-run).
    this.el.addEventListener("mousedown", (e) => e.target === this.el && this.cancel());
    // Keys stay in the card. Esc cancels wherever the focus is while it is
    // open (a click on its text leaves the focus on the page, not the card).
    this.card.addEventListener("keydown", (e) => e.stopPropagation());
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.el.hidden || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
      },
      true,
    );
    document.body.append(this.el);
    void invoke<string>("home_dir").then((h) => (this.home = h), () => {});
  }

  /** Open for workspace `ws` (named `name` on the board): check it at once. */
  open(ws: string, name: string): void {
    // A reclaim under way finishes, and says how it went, before another starts.
    if (!this.el.hidden && this.stage === "run") return;
    this.ws = ws;
    this.name = name || ws;
    this.el.hidden = false;
    void this.check();
  }

  private cancel(): void {
    if (this.stage === "run") return; // past the point of asking: it finishes
    this.seq++;
    this.el.hidden = true;
  }

  private frame(stage: Stage, title: string): HTMLElement {
    this.stage = stage;
    const head = el("div", "rc-head");
    head.append(el("b", "", title));
    const steps = el("ol", "rc-steps");
    const order: Stage[] = ["check", "review", "done"];
    const at = stage === "run" ? 2 : order.indexOf(stage);
    ["Check", "Review", "Done"].forEach((label, i) => {
      const li = el("li", i < at ? "past" : i === at ? "now" : "", label);
      steps.append(li);
    });
    head.append(steps);
    const body = el("div", "rc-body");
    this.card.replaceChildren(head, body);
    this.card.setAttribute("aria-label", title);
    return body;
  }

  private foot(...buttons: HTMLButtonElement[]): HTMLElement {
    const f = el("div", "rc-foot");
    f.append(...buttons);
    this.card.append(f);
    return f;
  }

  private busy(body: HTMLElement, text: string): void {
    const b = el("div", "rc-busy");
    b.append(el("span", "rc-spin"), el("span", "", text));
    body.append(b);
  }

  private async check(): Promise<void> {
    const seq = ++this.seq;
    const body = this.frame("check", `Reclaim ${this.name}`);
    this.busy(body, "Checking every guard. Fetching origin can take a few seconds.");
    const cancel = button("Cancel", "", () => this.cancel());
    this.foot(cancel);
    cancel.focus();
    let r: Report;
    try {
      r = await invoke<Report>("reclaim_check", { ws: this.ws });
    } catch (e) {
      if (seq !== this.seq) return;
      const b = this.frame("review", `Reclaim ${this.name}`);
      b.append(el("p", "rc-error", `Couldn't check this workspace: ${e}`));
      const retry = button("Try again", "", () => void this.check());
      this.foot(button("Close", "", () => this.cancel()), retry);
      retry.focus();
      return;
    }
    if (seq !== this.seq) return;
    this.review(r);
  }

  /** What would go first: it is the decision. One table of facts (what
   *  would be removed, then the plan and sandbox), a line each; then what
   *  needs reading (blockers, warnings); then every check that passed,
   *  folded. With a blocker there is nothing to remove, so the blockers
   *  lead. */
  private review(r: Report): void {
    const body = this.frame("review", `Reclaim ${r.branch ?? this.name}`);
    const ok = r.blockers === 0;

    // One line a fact: the value, then its note muted beside it. A long
    // value (a path) ellipsizes; its full text is the tooltip.
    const facts = el("dl", "rc-facts");
    const fact = (k: string, v: string | null | undefined, note = "", mono = false, full = v, stays = false) => {
      if (!v) return;
      // "search-index (done 3/3)": the parenthesis is the note.
      const m = !note && !mono && v.replace(REF, "") === v ? /^(.+?)\s*\(([^()]+)\)$/.exec(v) : null;
      if (m) [v, note] = [m[1], m[2]];
      // Under "Would remove", a fact that is not removed says so.
      if (stays) note = note ? `${note} · stays` : "stays";
      facts.append(el("dt", "", k));
      const dd = el("dd");
      const val = said(mono ? "rc-val mono" : "rc-val", v);
      val.title = (full ?? v).trim();
      dd.append(val);
      if (note) {
        const n = said("rc-note", note);
        n.title = note;
        dd.append(n);
      }
      facts.append(dd);
    };
    const named = new Set(ok ? r.remove.map((x) => x.what) : []);
    if (ok) {
      body.append(el("h3", "rc-sub", "Would remove"));
      for (const x of r.remove) {
        const tree = x.what === "worktree";
        fact(x.what, tree ? tidy(x.target, this.home) : x.target, x.note, tree || x.what === "branch", x.target);
      }
    }
    // The facts "Would remove" has not said already.
    const told = ok ? r.remove.map((x) => `${x.target} ${x.note}`).join(" ") : "";
    // Under "Would remove", a fact reclaim leaves alone says "stays".
    if (!named.has("worktree")) fact("worktree", tidy(r.worktree, this.home), "", true, r.worktree, ok);
    if (!named.has("branch")) fact("branch", r.branch, "", true, r.branch, ok);
    if (r.size && !told.includes(r.size)) fact("size", r.size);
    if (!named.has("workspace")) fact("workspace", r.workspace?.name, "", false, r.workspace?.name, ok);
    // The plan lives outside the worktree: reclaim leaves it.
    fact("plan", r.plan, "", false, r.plan, ok);
    fact("sandbox", r.sandbox, "", false, r.sandbox, ok);

    const row = (c: Check) => {
      const li = el("li", `rc-check ${c.kind}`);
      const text = el("div", "rc-text");
      text.append(said("", c.text));
      if (c.hint) text.append(said("rc-hint", c.hint));
      li.append(mark(c.kind), text);
      return li;
    };
    // Blockers, then warnings, open: they are what the person has to read.
    const loud = r.checks.filter((c) => c.kind === "fail" || c.kind === "warn").sort((a, b) => (a.kind === "fail" ? 0 : 1) - (b.kind === "fail" ? 0 : 1));
    const list = el("ul", "rc-checks");
    list.append(...loud.map(row));
    const parts = ok ? [facts, list] : [list, facts];
    for (const x of parts) if (x.childElementCount) body.append(x);

    // Every check that passed (or had nothing to check) folds into one line.
    const quiet = r.checks.filter((c) => c.kind === "pass" || c.kind === "skip");
    if (quiet.length) {
      const fold = el("details", "rc-passed");
      const sum = el("summary");
      sum.append(mark("pass"), el("span", "", `${quiet.length} check${quiet.length === 1 ? " passes" : "s pass"}`));
      const list = el("ul", "rc-checks");
      list.append(...quiet.map(row));
      fold.append(sum, list);
      body.append(fold);
    }

    if (!ok) {
      body.append(el("p", "rc-verdict bad", `${r.blockers} blocker${r.blockers === 1 ? "" : "s"}. Nothing will change.`));
      const again = button("Re-check", "rc-primary", () => void this.check());
      this.foot(button("Close", "", () => this.cancel()), again);
      again.focus();
      return;
    }

    const cancel = button("Cancel", "", () => this.cancel());
    const go = button(`Reclaim${r.size ? ` ${r.size}` : ""}`, "rc-danger", () => void this.run(r));
    this.foot(cancel, go);
    // The safe answer has the focus: Enter alone never deletes.
    cancel.focus();
  }

  private async run(r: Report): Promise<void> {
    const seq = ++this.seq;
    const body = this.frame("run", `Reclaiming ${r.branch ?? this.name}`);
    this.busy(body, "Closing the workspace and removing the worktree. crew-reclaim checks every guard once more first.");
    let out: { ok: boolean; steps: Step[] };
    try {
      out = await invoke<{ ok: boolean; steps: Step[] }>("reclaim_run", { ws: this.ws });
    } catch (e) {
      out = { ok: false, steps: [{ kind: "error", text: String(e) }] };
    }
    if (seq !== this.seq) return;
    const done = this.frame("done", out.ok ? `Reclaimed ${r.branch ?? this.name}` : `${r.branch ?? this.name} was not reclaimed`);
    const list = el("ul", "rc-checks");
    for (const s of out.steps) {
      const li = el("li", `rc-check ${s.kind}`);
      const text = el("div", "rc-text");
      text.append(el("span", "", s.text));
      li.append(mark(s.kind), text);
      list.append(li);
    }
    if (!out.steps.length) list.append(el("li", "rc-check note", out.ok ? "Done." : "crew-reclaim stopped without saying why."));
    done.append(list);
    if (out.ok) {
      const ok = button("Done", "rc-primary", () => this.cancel());
      this.foot(ok);
      ok.focus();
      this.onReclaimed(this.ws);
    } else {
      done.append(el("p", "rc-verdict bad", "Nothing was forced. What it kept is still there."));
      const again = button("Re-check", "rc-primary", () => void this.check());
      this.foot(button("Close", "", () => this.cancel()), again);
      again.focus();
    }
  }
}
