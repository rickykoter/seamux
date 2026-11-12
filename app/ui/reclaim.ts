// The reclaim wizard: what reclaiming a shipped workspace would remove, every
// guard crew-reclaim checks, and one button that does it once they all pass.
// A guard that fails shows what is behind it (the files, the commits) and the
// fixes crew-reclaim offers for it; each fix runs, then every guard is checked
// again. "Sort it out with Claude" opens a Claude in the workspace that is told
// what failed.
// The board's reclaim chip opens it when the app frames the board (dock.ts);
// crew-reclaim does the checking and the deleting (reclaim_app.rs), this only
// shows and asks.
import { invoke } from "@tauri-apps/api/core";

/** crew-reclaim's kinds, and "info": a note that reassures (nothing to
 *  act on), drawn with an i rather than a bang. */
type Check = {
  kind: "pass" | "fail" | "skip" | "warn" | "info";
  text: string;
  hint: string | null;
  /** Which guard (dirty, ignored, sandbox, …); absent from an older crew. */
  id?: string | null;
  /** What is behind the text: the changed files, the commits, the workspaces. */
  items?: string[];
  /** crew-reclaim --fix actions that clear it. */
  fixes?: string[];
};
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
type Ran = { ok: boolean; steps: Step[] };

/** Each fix crew-reclaim offers: its button, the busy line while it runs, and
 *  for one that loses data, the question asked first (n is how many). */
const FIX: Record<string, { label: string; doing: string; ask?: (n: number) => string; yes?: (n: number) => string }> = {
  stash: { label: "Stash them", doing: "Stashing" },
  discard: {
    label: "Discard…",
    doing: "Discarding",
    ask: (n) => `Discard ${n} uncommitted change${n === 1 ? "" : "s"}? Edits are reset and untracked files deleted. This cannot be undone.`,
    yes: (n) => `Discard ${n}`,
  },
  aside: { label: "Move aside", doing: "Moving them to ~/.cache/cmux-crew/reclaimed" },
  "delete-ignored": {
    label: "Delete…",
    doing: "Deleting",
    ask: (n) => `Delete ${n} ignored file${n === 1 ? "" : "s"}? Git has no copy of them. This cannot be undone.`,
    yes: (n) => `Delete ${n}`,
  },
  "sandbox-down": { label: "Stop sandbox", doing: "Stopping the sandbox" },
  "close-others": { label: "Close them", doing: "Closing the other workspaces" },
};
/** Guards whose cause is in the files: the worktree opens in VS Code. */
const LOOK = new Set(["dirty", "ignored", "merged", "detached"]);
/** Items shown before the rest fold behind "N more". */
const SHOWN = 6;
/** While an agent is mid-turn, how often the guards are checked again. */
const TURN_POLL_MS = 15_000;

const SVG = "http://www.w3.org/2000/svg";
/** Small marks, drawn: a tick, a cross, a dot, a bang, an i in a ring. */
const MARKS: Record<string, string> = {
  pass: "M2.5 5.3 4.3 7.1 7.6 3",
  done: "M2.5 5.3 4.3 7.1 7.6 3",
  fail: "M3 3l4 4M7 3 3 7",
  error: "M3 3l4 4M7 3 3 7",
  warn: "M5 2.4v3.4M5 7.4v.2",
  skip: "M4.6 5h.8",
  info: "M5 1.2a3.8 3.8 0 1 1 0 7.6a3.8 3.8 0 1 1 0-7.6M5 4.7v2.2M5 3.2v.05",
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
  /** A Claude was started in `ws` (its pane `pane`) to clear the blockers. */
  onClaude: (ws: string, pane: string) => void = () => {};
  private card = el("div", "reclaim-card");
  private ws = "";
  private name = "";
  private stage: Stage = "check";
  private seq = 0;
  private home = "";
  /** What the fixes did since the wizard opened, shown above the checks. */
  private log: Step[] = [];
  /** A fix or a Claude start is under way: the other buttons wait. */
  private fixing = false;
  private poll = 0;

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
    if (this.ws !== ws) this.log = [];
    this.ws = ws;
    this.name = name || ws;
    this.el.hidden = false;
    void this.check();
  }

  private cancel(): void {
    if (this.stage === "run") return; // past the point of asking: it finishes
    this.seq++;
    this.stopPoll();
    this.fixing = false;
    this.el.hidden = true;
  }

  private stopPoll(): void {
    window.clearTimeout(this.poll);
    this.poll = 0;
  }

  private frame(stage: Stage, title: string): HTMLElement {
    this.stage = stage;
    this.stopPoll();
    this.fixing = false;
    // No stepper: the flow is one screen, and while it checks or runs the
    // busy line under the title says what it is doing.
    const head = el("div", "rc-head");
    head.append(el("b", "", title));
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

  /** Check every guard. `quiet` (after a fix, or while a turn runs) keeps
   *  the screen as it is until the answer comes, so it does not flash. */
  private async check(quiet = false): Promise<void> {
    const seq = ++this.seq;
    if (!quiet) {
      const body = this.frame("check", `Reclaim ${this.name}`);
      this.busy(body, "Checking every guard. Fetching origin can take a few seconds.");
      const cancel = button("Cancel", "", () => this.cancel());
      this.foot(cancel);
      cancel.focus();
    }
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
   *  would be removed), a line each, and under it a dim Keeps line for what
   *  reclaim leaves (the plan, and anything else that stays); then what
   *  needs reading (blockers, warnings, notes); then every check that
   *  passed, folded. With a blocker there is nothing to remove, so the
   *  blockers lead and every fact is one table. */
  private review(r: Report): void {
    const body = this.frame("review", `Reclaim ${r.branch ?? this.name}`);
    const ok = r.blockers === 0;
    // What the fixes did so far: the path files went to, the stash's name.
    if (this.log.length) {
      const done = el("ul", "rc-checks rc-log");
      for (const s of this.log) {
        const li = el("li", `rc-check ${s.kind}`);
        const text = el("div", "rc-text");
        text.append(said("", this.home ? s.text.split(this.home + "/").join("~/") : s.text));
        li.append(mark(s.kind), text);
        done.append(li);
      }
      body.append(done);
    }

    // One line a fact: the value, then its note muted beside it. A long
    // value (a path) ellipsizes; its full text is the tooltip.
    const facts = el("dl", "rc-facts");
    // What stays, under "Would remove": "plan search-index (done 3/3)".
    const keeps: { k: string; v: string; full: string }[] = [];
    const fact = (k: string, v: string | null | undefined, note = "", mono = false, full = v, stays = false) => {
      if (!v) return;
      if (stays) {
        keeps.push({ k, v: v.replace(REF, "").trim() || v, full: (full ?? v).trim() });
        return;
      }
      // "search-index (done 3/3)": the parenthesis is the note.
      const m = !note && !mono && v.replace(REF, "") === v ? /^(.+?)\s*\(([^()]+)\)$/.exec(v) : null;
      if (m) [v, note] = [m[1], m[2]];
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
    // Under "Would remove", a fact reclaim leaves alone goes on the Keeps line.
    if (!named.has("worktree")) fact("worktree", tidy(r.worktree, this.home), "", true, r.worktree, ok);
    if (!named.has("branch")) fact("branch", r.branch, "", true, r.branch, ok);
    if (r.size && !told.includes(r.size)) fact("size", r.size);
    if (!named.has("workspace")) fact("workspace", r.workspace?.name, "", false, r.workspace?.name, ok);
    // The plan lives outside the worktree: reclaim leaves it.
    fact("plan", r.plan, "", false, r.plan, ok);
    if (!named.has("sandbox")) fact("sandbox", r.sandbox, "", false, r.sandbox, ok);

    const row = (c: Check) => {
      const li = el("li", `rc-check ${c.kind}`);
      const text = el("div", "rc-text");
      text.append(said("", c.text));
      if (c.hint) text.append(said("rc-hint", c.hint));
      li.append(mark(c.kind), text);
      if (c.kind === "fail" || c.kind === "warn") this.mend(r, c, text);
      return li;
    };
    // Blockers, then warnings, open: they are what the person has to read.
    const loud = r.checks.filter((c) => c.kind === "fail" || c.kind === "warn").sort((a, b) => (a.kind === "fail" ? 0 : 1) - (b.kind === "fail" ? 0 : 1));
    const list = el("ul", "rc-checks");
    list.append(...loud.map(row));
    // Notes that reassure come after them, quieter.
    list.append(...r.checks.filter((c) => c.kind === "info").map(row));
    const kept = el("p", "rc-keeps");
    if (keeps.length) {
      kept.append(el("span", "rc-keeps-k", "Keeps"));
      keeps.forEach((x, i) => {
        const s = el("span", "rc-keeps-v", `${i ? " · " : ""}${x.k} ${x.v}`);
        s.title = x.full;
        kept.append(s);
      });
    }
    const parts = ok ? [facts, kept, list] : [list, facts];
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
      body.append(el("p", "rc-verdict bad", `${r.blockers} blocker${r.blockers === 1 ? "" : "s"}. Nothing will change until they are cleared.`));
      const again = button("Re-check", "rc-primary", () => void this.check());
      const ask = button("Sort it out with Claude", "", () => void this.claude(r, ask));
      ask.title = "Opens Claude in this workspace, told what failed. It asks before it loses any work, and leaves the reclaim to you.";
      this.foot(button("Close", "", () => this.cancel()), ask, again);
      again.focus();
      // A turn ends on its own: check again until it has.
      if (r.checks.some((c) => c.kind === "fail" && c.id === "agent")) {
        const seq = this.seq;
        this.poll = window.setTimeout(() => {
          if (seq === this.seq && !this.fixing && this.stage === "review") void this.check(true);
        }, TURN_POLL_MS);
      }
      return;
    }

    const cancel = button("Cancel", "", () => this.cancel());
    const go = button(`Reclaim${r.size ? ` ${r.size}` : ""}`, "rc-danger", () => void this.run(r));
    this.foot(cancel, go);
    // The safe answer has the focus: Enter alone never deletes.
    cancel.focus();
  }

  /** Under a blocker's text: what is behind it (a few items, the rest
   *  folded) and a button for each fix, plus Open in VS Code where the cause
   *  is in the files. A fix that loses data asks first, in place. */
  private mend(r: Report, c: Check, into: HTMLElement): void {
    const items = c.items ?? [];
    if (items.length) {
      const ul = el("ul", "rc-items mono");
      const li = (t: string) => {
        const x = el("li", "", t);
        x.title = t;
        return x;
      };
      ul.append(...items.slice(0, SHOWN).map(li));
      if (items.length > SHOWN) {
        const more = el("button", "rc-more", `${items.length - SHOWN} more`);
        more.type = "button";
        more.addEventListener("click", () => {
          more.remove();
          ul.append(...items.slice(SHOWN).map(li));
        });
        ul.append(more);
      }
      into.append(ul);
    }
    const acts = el("div", "rc-fixes");
    for (const f of c.fixes ?? []) {
      const d = FIX[f];
      if (!d) continue;
      const b = button(d.label, d.ask ? "rc-danger" : "", () => {
        if (this.fixing) return;
        if (d.ask) this.confirm(r, c, f, acts);
        else void this.fix(f, acts);
      });
      acts.append(b);
    }
    if (c.id && LOOK.has(c.id)) {
      const b = button("Open in VS Code", "", () => {
        void invoke<{ folder: string; note: string | null }>("open_in_vscode", { dir: r.worktree }).then(
          (o) => o.note && this.say(acts, { kind: "note", text: o.note }),
          (e) => this.say(acts, { kind: "error", text: `Couldn't open VS Code: ${e}` }),
        );
      });
      acts.append(b);
    }
    if (c.id === "agent" && c.kind === "fail") acts.append(el("span", "rc-hint", "Checks again every 15s until the turn ends."));
    if (acts.childElementCount) into.append(acts);
  }

  /** The question before a fix that loses data, in place of its buttons:
   *  the safe answer has the focus. */
  private confirm(r: Report, c: Check, f: string, acts: HTMLElement): void {
    const d = FIX[f];
    // The count the check says: its items stop at 200.
    const n = Number(/^(\d+)/.exec(c.text)?.[1]) || c.items?.length || 1;
    const was = [...acts.childNodes];
    const ask = el("div", "rc-confirm");
    ask.append(el("p", "", d.ask!(n)));
    const no = button("Keep them", "", () => acts.replaceChildren(...was));
    const yes = button(d.yes!(n), "rc-danger", () => void this.fix(f, acts));
    const row = el("div", "rc-fixes");
    row.append(no, yes);
    ask.append(row);
    acts.replaceChildren(ask);
    no.focus();
  }

  /** A line under a blocker: what a fix or an open said. */
  private say(acts: HTMLElement, s: Step): void {
    acts.querySelector(".rc-said")?.remove();
    const p = el("p", `rc-said ${s.kind}`);
    p.append(mark(s.kind), said("", s.text));
    acts.after(p);
  }

  /** Run fix `f`, then check every guard again. What it said, done or
   *  failed, goes on the log above the checks, and the re-check draws the
   *  buttons fresh, so a fix that failed can be tried again. */
  private async fix(f: string, acts: HTMLElement): Promise<void> {
    if (this.fixing) return;
    this.fixing = true;
    this.stopPoll();
    const seq = this.seq;
    this.card.querySelectorAll<HTMLButtonElement>(".rc-fixes button, .rc-foot button").forEach((b) => (b.disabled = true));
    const busy = el("div", "rc-busy");
    busy.append(el("span", "rc-spin"), el("span", "", `${FIX[f].doing}…`));
    acts.replaceChildren(busy);
    let out: Ran;
    try {
      out = await invoke<Ran>("reclaim_fix", { ws: this.ws, action: f });
    } catch (e) {
      out = { ok: false, steps: [{ kind: "error", text: String(e) }] };
    }
    if (seq !== this.seq) return;
    if (!out.ok && !out.steps.some((s) => s.kind === "error")) out.steps.push({ kind: "error", text: "crew-reclaim stopped without saying why." });
    this.log.push(...out.steps);
    busy.lastElementChild!.textContent = "Checking every guard again…";
    await this.check(true);
  }

  /** Start a Claude in the workspace, told what failed, and show it. */
  private async claude(r: Report, b: HTMLButtonElement): Promise<void> {
    if (this.fixing) return;
    this.fixing = true;
    b.disabled = true;
    b.textContent = "Starting Claude…";
    const blockers = r.checks
      .filter((c) => c.kind === "fail")
      .map((c) => ({ text: c.text, hint: c.hint, items: c.items ?? [] }));
    try {
      const pane = await invoke<string>("reclaim_claude", { ws: this.ws, worktree: r.worktree, branch: r.branch, blockers });
      this.cancel();
      this.onClaude(this.ws, pane);
    } catch (e) {
      this.fixing = false;
      b.disabled = false;
      b.textContent = "Sort it out with Claude";
      const foot = this.card.querySelector(".rc-foot");
      foot?.querySelector(".rc-error")?.remove();
      const p = el("p", "rc-error", `Couldn't start Claude: ${e}`);
      foot?.prepend(p);
    }
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
