import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { answerable, type Decision, type ViewsFrame } from "./desk";
import type { Frame as WallFrame, Tile } from "./wall";
import { ago } from "./wall";
import { levelOf, menu } from "./tuck";
import { familyOf, grouped, header as familyHeader, waitText, type FamilyBrief } from "./family";

type Span = { state: string; start: number; end: number };
type Mark = { kind: "go" | "done" | "review"; at: number; n: number; label: string };
type Lane = { ws: string; spans: Span[]; marks: Mark[] };
type PlanBrief = { ws: string; slug: string; phase: string; done: number; total: number; n: number; open: boolean };
type Views = ViewsFrame & { lanes?: Lane[]; plans?: PlanBrief[]; families?: FamilyBrief[] };

/** The window Timeline shows, as views.rs's HISTORY_WINDOW. */
export const WINDOW_MS = 2 * 3600 * 1000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const hm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** A position in the window as a percentage of the track. */
export function pct(t: number, start: number, end: number): number {
  return Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100));
}

/** A lane that did nothing but rest in the window folds into a count. */
export function active(l: Lane): boolean {
  return l.spans.some((s) => s.state === "working" || s.state === "needs_input") || l.marks.length > 0;
}

const WORDS: Record<string, string> = { working: "working", needs_input: "waiting on you", idle: "idle", ended: "ended" };

/** Timeline: who waited, and how long, over the last two hours. */
export class Timeline {
  private legend = el("div", "t-legend");
  private lanesEl = el("div", "t-lanes");
  private axis = el("div", "t-axis");
  private pop = el("div", "t-pop");
  private head = el("span", "t-now");
  private views: Views = { decisions: [], wake: [], history: [], problems: [] };
  private tiles: Tile[] = [];
  /** The workspace whose wait the popover answers; "" = the oldest. */
  private picked = "";
  private draft = "";
  /** The popover's last message, for the wait it was about. */
  private note: { ws: string; text: string; bad: boolean } | null = null;

  constructor(private root: HTMLElement) {
    root.classList.add("timeline");
    const top = el("div", "t-top");
    top.append(el("h2", "", "Who waited, and how long"), el("span", "grow"), this.head);
    const item = (cls: string, text: string) => {
      const s = el("span", "t-key");
      s.append(el("i", cls), document.createTextNode(text));
      return s;
    };
    this.legend.append(
      item("k-work", "working"),
      item("k-wait", "waiting on you"),
      item("k-go", "plan increment"),
      item("k-look", "lookout review"),
      item("k-wake", "Wake: commit, PR, page"),
    );
    root.replaceChildren(top, this.legend, this.lanesEl, this.axis, this.pop);
    // The now line and the waits move without a frame.
    setInterval(() => this.draw(), 30_000);
  }

  async start(): Promise<void> {
    await listen<Views>("views:frame", (e) => {
      this.views = e.payload;
      this.draw();
    });
    await listen<WallFrame>("wall:frame", (e) => {
      this.tiles = e.payload.tiles;
      this.draw();
    });
    const [v, w] = await Promise.all([invoke<Views | null>("views_frame"), invoke<WallFrame | null>("wall_frame")]);
    if (w) this.tiles = w.tiles;
    if (v) this.views = v;
    this.draw();
  }

  private title(ws: string): string {
    const t = this.tiles.find((x) => x.workspace === ws);
    return t?.workspace_title || t?.label || "workspace";
  }

  private color(ws: string): string {
    const c = this.tiles.find((x) => x.workspace === ws)?.color;
    return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : "var(--line)";
  }

  /** The waits the popover can answer: open questions and asked turns, oldest first. */
  private waits(): Extract<Decision, { kind: "question" | "asked" }>[] {
    return this.views.decisions.filter(
      (d): d is Extract<Decision, { kind: "question" | "asked" }> => (d.kind === "question" || d.kind === "asked") && levelOf(this.views.levels, d.ws) !== "tuck",
    );
  }

  private draw(): void {
    if (this.root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    const now = Date.now();
    const start = now - WINDOW_MS;
    this.head.textContent = `last 2h · now ${hm(now)}`;
    // Tucked workspaces have no lane; muted ones sit last, dimmed.
    const lv = this.views.levels;
    const lanes = (this.views.lanes ?? []).filter((l) => levelOf(lv, l.ws) !== "tuck");
    const rank = (ws: string) => {
      const s = this.tiles.find((t) => t.workspace === ws)?.state;
      return s === "needs_input" ? 0 : s === "working" ? 1 : 2;
    };
    const muted = (ws: string) => (levelOf(lv, ws) === "mute" ? 10 : 0);
    const shown = lanes.filter(active).sort((a, b) => muted(a.ws) + rank(a.ws) - (muted(b.ws) + rank(b.ws)));
    const resting = lanes.length - shown.length;
    const shells = this.tiles.filter((t) => t.state === "shell").length;
    const waitWs = new Set(this.waits().map((d) => d.ws));

    // A family's lanes sit together under its header.
    const fams = this.views.families;
    const rows: HTMLElement[] = grouped(shown, (l) => familyOf(fams, l.ws)?.fam.parent ?? "").flatMap((g) => {
      const lanes = g.items.map((l) => this.lane(l, start, now, waitWs.has(l.ws)));
      const fam = g.key ? fams?.find((f) => f.parent === g.key) : undefined;
      return fam ? [familyHeader(fam, "fam-head t-fam"), ...lanes] : lanes;
    });
    if (resting || shells) rows.push(el("div", "t-fold", [resting ? `+${resting} idle` : "", shells ? `${shells} terminals` : ""].filter(Boolean).join(" · ")));
    if (!lanes.length) rows.push(el("p", "t-empty", "No agent has a lane yet: lanes fill from the state history as agents work, ask and wait."));
    this.lanesEl.replaceChildren(...rows);

    const ticks = [0, 30, 60, 90, 120].map((m) => {
      const s = el("span", "", m === 120 ? "now" : hm(start + m * 60_000));
      s.style.left = `${(m / 120) * 100}%`;
      return s;
    });
    this.axis.replaceChildren(...ticks);
    this.drawPop();
  }

  private lane(l: Lane, start: number, now: number, waiting: boolean): HTMLElement {
    const level = levelOf(this.views.levels, l.ws);
    const row = el("div", `t-lane${level === "mute" ? " muted" : ""}`);
    const name = el("div", "t-name");
    const tile = this.tiles.find((t) => t.workspace === l.ws);
    const plan = (this.views.plans ?? []).find((p) => p.ws === l.ws);
    let sub = WORDS[tile?.state ?? ""] ?? "";
    const last = l.spans[l.spans.length - 1];
    if (tile?.state === "needs_input" && last?.state === "needs_input") sub = `waiting ${ago(now - last.start)}`;
    if (tile?.state === "working" && plan && plan.open) sub = `working · inc ${plan.n}/${plan.total}`;
    if (tile?.state !== "working" && tile?.state !== "needs_input" && plan?.phase === "done") sub = "delivered";
    const kin = familyOf(this.views.families, l.ws);
    const waits = kin ? waitText(kin.fam, kin.member) : "";
    if (waits && tile?.state !== "needs_input") sub = waits;
    if (level === "mute") sub = sub ? `${sub} · muted` : "muted";
    const top = el("span", "t-name-top");
    top.append(el("b", "", this.title(l.ws)), menu(l.ws, this.title(l.ws), level));
    name.append(top, el("span", `t-sub ${tile?.state ?? ""}`, sub));
    const track = el("div", "t-track");
    track.style.setProperty("--ws", this.color(l.ws));
    for (const [i, s0] of l.spans.entries()) {
      // The feed's clock moves in minutes: the run still going reaches now.
      const s = i === l.spans.length - 1 && tile?.state === s0.state ? { ...s0, end: now } : s0;
      if (s.state !== "working" && s.state !== "needs_input") continue;
      // A wait the popover can answer is a button: keys and screen readers reach it.
      // The lane's last span is the wait still open (frames come only on change, so its end may lag now).
      const open = s.state === "needs_input" && waiting && i === l.spans.length - 1;
      const b = open ? el("button", "t-span wait open") : el("span", `t-span ${s.state === "working" ? "work" : "wait"}`);
      b.style.left = `${pct(s.start, start, now)}%`;
      b.style.width = `${Math.max(0.4, pct(s.end, start, now) - pct(s.start, start, now))}%`;
      b.title = `${WORDS[s.state]} ${ago(s.end - s.start)} (${hm(s.start)}–${hm(s.end)})`;
      if (open) {
        (b as HTMLButtonElement).type = "button";
        b.setAttribute("aria-label", `${this.title(l.ws)}: ${b.title}; answer it below`);
        b.addEventListener("click", () => {
          this.picked = l.ws;
          this.drawPop();
        });
      }
      track.append(b);
    }
    for (const m of l.marks) {
      const k = el("span", `t-mark ${m.kind}`);
      k.style.left = `${pct(m.at, start, now)}%`;
      k.title = `${m.kind === "review" ? "lookout review" : m.kind === "go" ? `go: increment ${m.n}` : `done: increment ${m.n}`} · ${m.label} · ${hm(m.at)}`;
      track.append(k);
    }
    for (const w of this.views.wake.filter((r) => r.ws === l.ws && r.kind !== "temp" && r.at >= start)) {
      const k = el("span", "t-mark wake");
      k.style.left = `${pct(w.at, start, now)}%`;
      k.title = `Wake: ${w.kind} · ${w.title} · ${hm(w.at)}`;
      track.append(k);
    }
    row.append(name, track);
    return row;
  }

  /** The popover: the picked wait, else the oldest, answered as Desk answers it. */
  private drawPop(): void {
    const waits = this.waits();
    const d = waits.find((x) => x.ws === this.picked) ?? waits[0];
    if (!d) {
      this.pop.hidden = true;
      return;
    }
    if (d.ws !== this.picked) this.draft = "";
    this.picked = d.ws;
    this.pop.hidden = false;
    const head = el("span", "t-pop-head", `${this.title(d.ws)} · waiting since ${hm(d.since)}${waits.length > 1 ? ` · ${waits.length} waits; click an amber span for another` : ""}`);
    const q = el("p", "t-pop-q", d.kind === "question" ? d.questions[0]?.question ?? "" : d.question || "The turn ended on a question.");
    const actions = el("div", "t-pop-acts");
    const jump = el("button", "d-btn", "Jump ↗");
    jump.type = "button";
    jump.addEventListener("click", async () => {
      try {
        await invoke("wall_jump", { surfaceId: d.surface });
        await invoke("hide_overlay");
      } catch (e) {
        this.say(String(e), true);
      }
    });
    if (d.kind === "question" && answerable(d)) {
      d.questions[0].options.forEach((o, i) => {
        const b = el("button", "d-btn", `${i + 1}  ${o.label}`);
        b.type = "button";
        b.addEventListener("click", async () => {
          try {
            this.say(await invoke<string>("desk_answer", { workspace: d.ws, n: i + 1 }));
          } catch (e) {
            this.say(`${String(e)} · Jump goes to the pane`, true);
          }
        });
        actions.append(b);
      });
    } else if (d.kind === "asked") {
      const yes = el("button", "d-btn primary", "Yes");
      yes.type = "button";
      const input = el("input", "t-pop-in");
      input.placeholder = "Reply…";
      input.spellcheck = false;
      input.value = this.draft;
      input.addEventListener("input", () => (this.draft = input.value));
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && input.value.trim()) void send(input.value);
        if (e.key === "Escape") input.blur();
      });
      const send = async (text: string) => {
        try {
          await invoke("wall_reply", { surfaceId: d.surface, text });
          this.draft = "";
          input.blur();
          this.say("Sent");
        } catch (e) {
          this.say(String(e), true);
        }
      };
      yes.addEventListener("click", () => void send("yes"));
      actions.append(yes, input);
    } else {
      actions.append(el("span", "d-fine", "Answer this one in the pane."));
    }
    actions.append(jump);
    this.pop.replaceChildren(head, q, actions);
    if (this.note && this.note.ws === d.ws) this.pop.append(el("p", `d-note${this.note.bad ? " bad" : ""}`, this.note.text));
  }

  private say(text: string, bad = false): void {
    this.note = { ws: this.picked, text, bad };
    this.drawPop();
    if (!bad)
      setTimeout(() => {
        if (this.note?.text === text) {
          this.note = null;
          this.drawPop();
        }
      }, 4000);
  }
}
