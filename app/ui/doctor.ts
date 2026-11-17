// The Doctor tab (⋯ > Doctor): what is broken about the app's tmux
// workspaces, worst first, with a fix on each row (crew_core::doctor via
// doctor_app.rs). It scans when shown and on Rescan, never on a timer.
// Fix all safe runs only fixes that touch files and records nothing runs
// from; every other fix asks first, and reclaim opens its wizard.
import { invoke } from "@tauri-apps/api/core";
import { asks, headline, leftoversSaid, safeIds, triage, type Finding, type Fix, type Group, type Scan } from "./doctor_model";
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

  constructor(private root: HTMLElement) {
    root.classList.add("doctor");
    const title = el("b", "doc-title", "Doctor");
    const grow = el("span", "doc-grow");
    this.head.append(title, this.line, grow, this.rescan, this.safe);
    root.append(this.head, this.log, this.body);
    this.reclaim.onReclaimed = () => void this.scan();
    void invoke<string>("home_dir").then((h) => (this.home = h), () => {});
  }

  /** The tab was selected: look again. */
  shown(): void {
    void this.scan();
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
        // Only this one turns to Confirm: one armed elsewhere goes back.
        for (const o of this.body.querySelectorAll<HTMLButtonElement>("button.doc-danger")) {
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
}
