// The Doctor tab (⋯ > Doctor): what is broken about the app's tmux
// workspaces, worst first, with a fix on each row (crew_core::doctor via
// doctor_app.rs). It scans when shown and on Rescan, never on a timer.
// Fix all safe runs only fixes that touch files and records nothing runs
// from; every other fix asks first, and reclaim opens its wizard.
import { invoke } from "@tauri-apps/api/core";
import {
  ACTIONS, ago, asks, counts, filterRows, headline, leftoversSaid, safeIds, STATES, triage,
  type Finding, type Fix, type Group, type Row, type RowState, type Scan,
} from "./doctor_model";
import { ReclaimWizard } from "./reclaim";

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

const SVG = "http://www.w3.org/2000/svg";

/** A stethoscope-ish mark for the calm state: a ring on a curve, drawn. */
function calm(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("doc-calm-mark");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M12 8v12a10 10 0 0 0 20 0V8M22 30v4a8 8 0 0 0 16 0v-6");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.4");
  path.setAttribute("stroke-linecap", "round");
  const ring = document.createElementNS(SVG, "circle");
  ring.setAttribute("cx", "38");
  ring.setAttribute("cy", "24");
  ring.setAttribute("r", "4");
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "currentColor");
  ring.setAttribute("stroke-width", "2.4");
  svg.append(path, ring);
  return svg;
}

/** A line of what a fix did: kept above the list until the next scan's. */
type Said = { ok: boolean; text: string };

export class DoctorView {
  private head = el("div", "doc-head");
  private line = el("span", "doc-headline");
  private rescan = button("Rescan", "", () => void this.scan());
  private safe = button("Fix all safe", "doc-primary", () => void this.fixSafe());
  private log = el("div", "doc-log");
  private body = el("div", "doc-body");
  private reclaim = new ReclaimWizard();
  private seq = 0;
  private busy = false;
  private said: Said[] = [];
  /** The fix waiting on its confirm click: `${id} ${verb}`. */
  private arming = "";
  private home = "";
  /** All workspaces (crew-resume's rows), below the triage list. */
  private rowsEl = el("section", "doc-all");
  private rows: Row[] = [];
  private rowsSeq = 0;
  private rowsNote = "Loading…";
  private filter: RowState | "all" = "all";
  private query = "";
  /** How many rows show before "Show all". */
  private limit = 60;

  constructor(private root: HTMLElement) {
    root.classList.add("doctor");
    const title = el("b", "doc-title", "Doctor");
    const grow = el("span", "doc-grow");
    this.head.append(title, this.line, grow, this.rescan, this.safe);
    root.append(this.head, this.log, this.body, this.rowsEl);
    this.reclaim.onReclaimed = () => void this.scan();
    void invoke<string>("home_dir").then((h) => (this.home = h), () => {});
  }

  /** main.ts: the tab was selected. Keys go to the first fix under Needs
   *  you, else the first workspace row's action. False until a scan draws one. */
  focusMain(): boolean {
    const b =
      this.root.querySelector<HTMLElement>(".doc-needs .doc-acts button:not(:disabled)") ??
      this.root.querySelector<HTMLElement>(".doc-ws .doc-acts button:not(:disabled)");
    b?.focus();
    return !!b && document.activeElement === b;
  }

  /** The tab was selected: look again. */
  shown(): void {
    void this.scan();
    void this.loadRows();
  }

  private tidy(p: string): string {
    return this.home && p.startsWith(this.home + "/") ? "~" + p.slice(this.home.length) : p;
  }

  private async scan(quiet = false): Promise<void> {
    const seq = ++this.seq;
    this.arming = "";
    if (!quiet) {
      this.line.textContent = "Scanning…";
      this.rescan.disabled = true;
    }
    let scan: Scan | null;
    try {
      scan = await invoke<Scan | null>("doctor_scan");
    } catch (e) {
      if (seq !== this.seq) return;
      this.rescan.disabled = false;
      this.line.textContent = "The scan failed";
      this.body.replaceChildren(el("p", "doc-error", String(e)));
      return;
    }
    if (seq !== this.seq) return;
    this.rescan.disabled = false;
    this.draw(scan);
  }

  private draw(scan: Scan | null): void {
    this.drawLog();
    if (!scan) {
      this.line.textContent = "";
      this.safe.hidden = true;
      this.body.replaceChildren(
        el("p", "doc-note", "The doctor looks after the app's own tmux workspaces, and this app runs on cmux."),
      );
      return;
    }
    const t = triage(scan);
    const safe = safeIds(scan);
    this.line.textContent = headline(t);
    this.line.classList.toggle("bad", !!t.blocked);
    this.safe.hidden = false;
    this.safe.disabled = this.busy || safe.length === 0;
    this.safe.textContent = safe.length ? `Fix all safe (${safe.length})` : "Fix all safe";
    const parts: HTMLElement[] = [];
    if (t.blocked) parts.push(el("p", "doc-blocked", t.blocked));
    if (t.needs.length) {
      const sec = el("section", "doc-needs");
      sec.append(el("h3", "", "Needs you"));
      for (const g of t.needs) sec.append(this.group(g, !t.blocked));
      parts.push(sec);
    }
    if (t.leftovers.length) parts.push(this.leftovers(t.leftovers));
    if (!t.needs.length && !t.leftovers.length && !t.blocked) {
      const c = el("div", "doc-calm");
      c.append(calm(), el("p", "", "Every workspace has its panes, its Claude and its folder."));
      parts.push(c);
    }
    this.body.replaceChildren(...parts);
  }

  private drawLog(): void {
    this.log.replaceChildren(...this.said.map((s) => el("p", s.ok ? "doc-ok" : "doc-refused", `${s.ok ? "✓" : "✗"} ${s.text}`)));
    this.log.hidden = this.said.length === 0;
  }

  /** One workspace: its worst finding's summary and fixes, the rest below. */
  private group(g: Group, fixable: boolean): HTMLElement {
    const row = el("div", "doc-row");
    const top = el("div", "doc-row-top");
    const name = el("div", "doc-name");
    name.append(el("b", "", g.title));
    if (g.cwd) name.append(el("span", "doc-cwd", this.tidy(g.cwd)));
    const worst = g.findings[0];
    const what = el("span", `doc-what ${worst.class}`, worst.summary);
    const acts = el("div", "doc-acts");
    if (fixable) for (const fx of worst.fixes) acts.append(this.fixButton(worst, fx));
    top.append(name, what, acts);
    row.append(top);
    const more = el("details", "doc-more");
    more.append(el("summary", "", g.findings.length > 1 ? `${g.findings.length - 1} more, and what was seen` : "What was seen"));
    for (const f of g.findings) more.append(this.item(f, fixable && f !== worst));
    row.append(more);
    return row;
  }

  private item(f: Finding, withFixes: boolean): HTMLElement {
    const it = el("div", "doc-item");
    const words = el("div", "doc-item-words");
    words.append(el("span", `doc-what ${f.class}`, f.summary), el("p", "doc-detail", f.detail));
    it.append(words);
    if (withFixes && f.fixes.length) {
      const acts = el("div", "doc-acts");
      for (const fx of f.fixes) acts.append(this.fixButton(f, fx));
      it.append(acts);
    }
    return it;
  }

  /** A fix's button: safe ones act, the rest ask with a second click. */
  private fixButton(f: Finding, fx: Fix): HTMLButtonElement {
    const how = asks(f, fx);
    const key = `${f.id} ${fx.verb}`;
    const armed = this.arming === key;
    const b = button(armed ? `Confirm: ${fx.label}` : fx.label, armed ? "doc-danger" : "", () => {
      if (how === "wizard") {
        this.reclaim.open(f.ws, f.title);
        return;
      }
      if (how === "confirm" && this.arming !== key) {
        this.arming = key;
        // Only this one turns to Confirm: one armed anywhere in the tab
        // (a finding or a workspace row) goes back.
        for (const o of this.root.querySelectorAll<HTMLButtonElement>("button.doc-danger")) {
          o.textContent = o.dataset.label ?? o.textContent;
          o.classList.remove("doc-danger");
        }
        b.textContent = `Confirm: ${fx.label}`;
        b.classList.add("doc-danger");
        b.title = f.detail;
        b.focus();
        return;
      }
      void this.fix(f, fx);
    });
    b.dataset.label = fx.label;
    b.disabled = this.busy;
    if (how === "confirm") b.title = "Asks once more before it acts";
    return b;
  }

  private leftovers(fs: Finding[]): HTMLElement {
    const sec = el("section", "doc-leftovers");
    const top = el("div", "doc-row-top");
    top.append(el("span", "doc-left-said", leftoversSaid(fs)), button("Clean", "", () => void this.fixSafe()));
    const more = el("details", "doc-more");
    more.append(el("summary", "", "Each one"));
    for (const f of fs) {
      const it = el("div", "doc-item");
      const words = el("div", "doc-item-words");
      words.append(el("span", "doc-what safe", `${f.title || f.subject.slice(0, 8)}: ${f.summary}`), el("p", "doc-detail", f.detail));
      it.append(words);
      more.append(it);
    }
    sec.append(top, more);
    return sec;
  }

  private async fix(f: Finding, fx: Fix): Promise<void> {
    this.busy = true;
    this.arming = "";
    this.line.textContent = `${fx.label}…`;
    try {
      const said = await invoke<string>("doctor_fix", { id: f.id, verb: fx.verb });
      this.said = [{ ok: true, text: said }];
    } catch (e) {
      this.said = [{ ok: false, text: `${f.title || f.subject}: ${e}` }];
    }
    this.busy = false;
    await this.scan(true);
    void this.loadRows();
  }

  private async fixSafe(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.safe.disabled = true;
    this.line.textContent = "Fixing the safe ones…";
    try {
      const done = await invoke<{ id: string; ok: boolean; message: string }[]>("doctor_fix_safe");
      const bad = done.filter((d) => !d.ok);
      this.said = [{ ok: bad.length === 0, text: `fixed ${done.length - bad.length} of ${done.length}` }, ...bad.map((d) => ({ ok: false, text: `${d.id}: ${d.message}` }))];
    } catch (e) {
      this.said = [{ ok: false, text: String(e) }];
    }
    this.busy = false;
    await this.scan(true);
  }

  // --- All workspaces ------------------------------------------------------

  private async loadRows(): Promise<void> {
    const seq = ++this.rowsSeq;
    if (!this.rows.length) {
      this.rowsNote = "Loading every workspace…";
      this.drawRows();
    }
    try {
      const r = await invoke<{ rows: Row[]; live_known: boolean }>("doctor_rows");
      if (seq !== this.rowsSeq) return;
      this.rows = r.rows;
      this.rowsNote = r.live_known ? "" : "The backend did not list its open workspaces: open ones show as past or archived.";
    } catch (e) {
      if (seq !== this.rowsSeq) return;
      this.rowsNote = `Couldn't list the workspaces: ${e}`;
    }
    this.drawRows();
  }

  private drawRows(): void {
    const head = el("div", "doc-all-head");
    head.append(el("h3", "", "All workspaces"));
    const chips = el("div", "doc-chips");
    const c = counts(this.rows);
    const chip = (id: RowState | "all", text: string) => {
      const b = button(text, `doc-chip ${this.filter === id ? "on" : ""}`, () => {
        this.filter = id;
        this.limit = 60;
        this.drawRows();
      });
      b.setAttribute("aria-pressed", String(this.filter === id));
      return b;
    };
    chips.append(chip("all", `All ${this.rows.length}`), ...STATES.map((st) => chip(st, `${st} ${c[st]}`)));
    const search = el("input", "doc-search");
    search.type = "search";
    search.placeholder = "Search folders, branches, prompts";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.limit = 60;
      this.drawList(list);
    });
    head.append(chips, search);
    const list = el("div", "doc-list");
    const parts: HTMLElement[] = [head];
    if (this.rowsNote) parts.push(el("p", "doc-note", this.rowsNote));
    parts.push(list);
    this.rowsEl.replaceChildren(...parts);
    this.drawList(list);
  }

  private drawList(list: HTMLElement): void {
    const shown = filterRows(this.rows, this.filter, this.query);
    const now = Date.now() / 1000;
    const items = shown.slice(0, this.limit).map((r) => this.rowItem(r, now));
    if (shown.length > this.limit) {
      items.push(button(`Show all ${shown.length}`, "doc-more-rows", () => {
        this.limit = Infinity;
        this.drawList(list);
      }));
    }
    if (!shown.length && this.rows.length) items.push(el("p", "doc-note", "No workspace matches."));
    list.replaceChildren(...items);
  }

  private rowItem(r: Row, now: number): HTMLElement {
    const it = el("div", `doc-ws ${r.state}`);
    const dot = el("span", `doc-dot ${r.state}`);
    dot.title = r.state;
    const name = el("div", "doc-name");
    name.append(el("b", "", r.title));
    name.append(el("span", "doc-cwd", this.tidy(r.cwd) + (r.branch ? `  ·  ${r.branch}` : "")));
    const latest = el("span", "doc-latest", r.state === "gone" ? (r.transcript ? `transcript: ${this.tidy(r.transcript)}` : "its folder is gone") : r.latest);
    const when = el("span", "doc-when", ago(r.when, now));
    const acts = el("div", "doc-acts");
    for (const a of ACTIONS[r.state]) acts.append(this.rowButton(r, a.verb, a.label, a.confirm));
    it.append(dot, name, latest, when, acts);
    return it;
  }

  private rowButton(r: Row, verb: "archive" | "restore" | "forget" | "resume", label: string, confirm: boolean): HTMLButtonElement {
    const key = `row ${r.cwd} ${verb}`;
    const b = button(label, "", () => {
      if (confirm && this.arming !== key) {
        for (const o of this.root.querySelectorAll<HTMLButtonElement>("button.doc-danger")) {
          o.textContent = o.dataset.label ?? o.textContent;
          o.classList.remove("doc-danger");
        }
        this.arming = key;
        b.textContent = `Confirm: ${label}`;
        b.classList.add("doc-danger");
        b.focus();
        return;
      }
      void this.rowAct(r, verb, label);
    });
    b.dataset.label = label;
    b.disabled = this.busy;
    return b;
  }

  private async rowAct(r: Row, verb: string, label: string): Promise<void> {
    this.busy = true;
    this.arming = "";
    this.line.textContent = `${label} ${r.title}…`;
    try {
      const said = await invoke<string>(`doctor_${verb}`, { cwd: r.cwd });
      this.said = [{ ok: true, text: said }];
    } catch (e) {
      this.said = [{ ok: false, text: `${r.title}: ${e}` }];
    }
    this.busy = false;
    await this.scan(true);
    await this.loadRows();
  }
}
