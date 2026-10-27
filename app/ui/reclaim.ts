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
    this.card.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancel();
      }
    });
    document.body.append(this.el);
    void invoke<string>("home_dir").then((h) => (this.home = h), () => {});
  }

  /** Open for workspace `ws` (named `name` on the board): check it at once. */
  open(ws: string, name: string): void {
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

  private review(r: Report): void {
    const body = this.frame("review", `Reclaim ${r.branch ?? this.name}`);
    const facts = el("dl", "rc-facts");
    const fact = (k: string, v: string | null | undefined, mono = false) => {
      if (!v) return;
      facts.append(el("dt", "", k), el("dd", mono ? "mono" : "", v));
    };
    fact("worktree", tidy(r.worktree, this.home), true);
    fact("branch", r.branch, true);
    fact("size", r.size);
    fact("workspace", r.workspace?.name);
    fact("plan", r.plan);
    fact("sandbox", r.sandbox);
    body.append(facts);

    const list = el("ul", "rc-checks");
    // Blockers first: they are what the person has to act on.
    const order = { fail: 0, warn: 1, pass: 2, skip: 3 } as const;
    for (const c of [...r.checks].sort((a, b) => order[a.kind] - order[b.kind])) {
      const li = el("li", `rc-check ${c.kind}`);
      const text = el("div", "rc-text");
      text.append(el("span", "", c.text));
      if (c.hint) text.append(el("span", "rc-hint", c.hint));
      li.append(mark(c.kind), text);
      list.append(li);
    }
    body.append(list);

    if (r.blockers > 0) {
      body.append(el("p", "rc-verdict bad", `${r.blockers} blocker${r.blockers === 1 ? "" : "s"}. Nothing will change.`));
      const again = button("Re-check", "rc-primary", () => void this.check());
      this.foot(button("Close", "", () => this.cancel()), again);
      again.focus();
      return;
    }

    body.append(el("h3", "rc-sub", "Would remove"));
    const gone = el("ul", "rc-remove");
    for (const x of r.remove) {
      const li = el("li");
      li.append(el("span", "rc-what", x.what), el("span", x.what === "worktree" || x.what === "branch" ? "rc-target mono" : "rc-target", x.what === "worktree" ? tidy(x.target, this.home) : x.target));
      if (x.note) li.append(el("span", "rc-note", x.note));
      gone.append(li);
    }
    body.append(gone);
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
