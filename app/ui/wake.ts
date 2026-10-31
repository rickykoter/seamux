import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sheet, type Sheet, type Shown } from "./sheet";
import { dotsMenu, type MenuItem, type TuckRow } from "./tuck";

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

/** The files the sheet shows itself (wake_app.rs show_kind). */
const VIEWABLE = /\.(png|jpe?g|gif|webp|svg|html?|pdf)$/i;

export const KINDS = ["plan", "review", "ask", "artifact", "doc", "temp", "image", "file", "commit", "pr", "issue"];

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
  if (r.kind === "commit") return r.url ? r.url.replace(/^https:\/\//, "").replace(/\/commit\/.*$/, "") : "";
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
  private title = el("h1", "w-title");
  private stats = el("span", "w-stats");
  private keepAllBtn = button("", "w-act keepall");
  private picker = el("select", "w-ws");
  private q = el("input", "w-q");
  private chipsEl = el("div", "w-chips");
  private list = el("div", "w-list");
  private toastEl = el("div", "w-toast");
  private help = el("div", "w-help");
  private data: Data = { ws: "", rows: [], limit: 0, truncated: false, workspaces: [] };
  private ws = "";
  private query = "";
  private kinds = new Set<string>();
  private openGroups = new Set<string>();
  private vis: Row[] = [];
  private sel = -1;
  private home = "";
  private seq = 0;
  private lastTop = -1;
  /** Muted and tucked worktrees, from the views feed: tucked ones sink in the picker. */
  private tucked: TuckRow[] = [];

  /** Embedded: the copy in the chat sheet, which has the keys while the sheet is open. */
  private embedded: boolean;
  /** The sheet this Wake is a tab of: what it opens goes there, beside it,
   *  for the workspace shown (the Dock view stays). Else the app's sheet. */
  private host: Sheet | null;

  constructor(readonly root: HTMLElement, opts: { embedded?: boolean; host?: Sheet } = {}) {
    this.embedded = !!opts.embedded;
    this.host = opts.host ?? null;
    root.classList.add("wake");
    if (this.embedded) root.classList.add("embedded");
    this.picker.setAttribute("aria-label", "workspace");
    this.picker.addEventListener("change", () => {
      this.ws = this.picker.value;
      this.kinds.clear();
      this.sel = -1;
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
    const keys = button("?", "w-act w-keys");
    keys.setAttribute("aria-label", "keys");
    keys.addEventListener("click", () => (this.help.hidden = !this.help.hidden));
    this.help.hidden = true;
    this.help.append(
      el("h3", "", "keys"),
      ...[
        ["/", "search · Esc clears"],
        ["j k", "next · previous row"],
        ["Enter", "open the row (⌘ in cmux)"],
        ["Space", "show the whole prompt"],
        ["K", "keep an at-risk file"],
        ["c", "copy the path"],
        ["r", "copy the resume command"],
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
    // In the Dock the sheet's tab already says "the wake · ws".
    if (this.embedded) ttl.append(sub);
    else ttl.append(this.title, sub);
    head.append(ttl, this.picker);
    const bar = el("div", "w-bar");
    bar.append(this.q, keys);
    this.toastEl.setAttribute("role", "status");
    root.replaceChildren(head, bar, this.chipsEl, this.list, this.help, this.toastEl);
    this.chipsEl.addEventListener("click", (e) => this.chip(e));
    document.addEventListener("keydown", (e) => this.key(e));
  }

  async start(): Promise<void> {
    try {
      this.home = await invoke<string>("home_dir");
    } catch {
      this.home = "";
    }
    // New rows land at each turn's end; the views feed says when.
    await listen<{ wake: { id: number }[]; tucked?: TuckRow[] }>("views:frame", (e) => {
      const tucked = (e.payload.tucked ?? []).filter((r) => r.level === "tuck");
      if (JSON.stringify(tucked.map((r) => r.path)) !== JSON.stringify(this.tucked.map((r) => r.path))) {
        this.tucked = tucked;
        if (this.data.workspaces.length) this.draw();
      }
      const top = e.payload.wake?.[0]?.id ?? -1;
      if (top !== this.lastTop) {
        this.lastTop = top;
        if (this.visible()) void this.load(true);
      }
    });
    await this.load();
  }

  private visible(): boolean {
    return this.root.offsetParent !== null;
  }

  /** Called when the tab is shown: fresh rows. */
  shown(): void {
    void this.load(true);
  }

  /** Show the Wake of the worktree at `dir` (the sheet's workspace), fresh. */
  showDir(dir: string): void {
    if (dir && dir !== this.ws) {
      this.ws = dir;
      this.kinds.clear();
      this.sel = -1;
      this.q.value = "";
      this.query = "";
      void this.load();
    } else void this.load(true);
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
      const d = await invoke<Data>("wake_data", { ws: this.ws, q: this.query });
      if (seq !== this.seq) return; // a newer search or workspace is in flight
      this.data = d;
      if (d.ws && d.ws !== this.ws) this.ws = d.ws;
      if (!this.ws && d.workspaces.length) {
        this.ws = d.workspaces[0].ws; // the most recent workspace
        return this.load(quiet);
      }
      this.draw();
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
      g.label = "Tucked";
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
    this.title.replaceChildren(document.createTextNode("the wake"), el("span", "w-dot", " · "), document.createTextNode(this.ws.split("/").pop() ?? ""));

    // Chips: all, then each kind with its count.
    const rows = this.data.rows;
    const n = new Map<string, number>();
    for (const r of rows) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
    const all = button("", `w-chip${this.kinds.size ? "" : " on"}`);
    all.dataset.k = "";
    all.append(document.createTextNode("all "), el("span", "", String(rows.length)));
    this.chipsEl.replaceChildren(
      all,
      ...KINDS.map((k) => {
        const b = button("", `w-chip k-${k}${this.kinds.has(k) ? " on" : ""}`);
        // A kind with nothing in it is no filter: hidden, unless it is the one picked.
        b.hidden = !n.get(k) && !this.kinds.has(k);
        b.dataset.k = k;
        b.append(el("i"), document.createTextNode(`${k} `), el("span", "", String(n.get(k) ?? 0)));
        return b;
      }),
    );

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
    this.keepAllBtn.hidden = !risk || !!this.query;
    if (!this.keepAllBtn.classList.contains("sure")) this.keepAllBtn.textContent = `keep all ${risk}`;
    this.keepAllBtn.dataset.n = String(risk);

    // Rows by day, then by the prompt that made them.
    const keepId = this.vis[this.sel]?.id;
    this.vis = rows.filter((r) => !this.kinds.size || this.kinds.has(r.kind));
    const out: HTMLElement[] = [];
    let day = "";
    let group = "";
    let section: HTMLElement | null = null;
    let ul: HTMLElement | null = null;
    this.vis.forEach((r, i) => {
      const d = local(r.created_at);
      const dk = dayKey(d);
      const gk = `${dk}|${r.session_id}|${r.prompt}|${r.prompt ? "" : r.kind}`;
      if (dk !== day) {
        section = el("section", "w-day");
        section.append(el("h2", "", dayLabel(d)));
        out.push(section);
        day = dk;
        group = "";
      }
      if (gk !== group) {
        const g = el("div", `w-grp${this.openGroups.has(gk) ? " open" : ""}`);
        const ph = el("div", "w-ph");
        const prompt = el("span", `w-prompt${r.prompt ? "" : " none"}`);
        prompt.title = r.prompt;
        prompt.append(r.prompt ? marked(r.prompt, this.query) : document.createTextNode(SOURCE[r.source] ?? "no prompt recorded"));
        prompt.addEventListener("click", () => {
          if (this.openGroups.has(gk)) this.openGroups.delete(gk);
          else this.openGroups.add(gk);
          g.classList.toggle("open");
        });
        ph.append(el("time", "", hm(d)), prompt);
        if (r.branch) ph.append(el("span", "w-br", r.branch));
        if (r.session_id) {
          const s = button(r.session_id.slice(0, 8), "w-sess");
          s.title = "copy the command that resumes this session";
          s.addEventListener("click", () => void this.copy(resumeCmd(r), "the resume command"));
          ph.append(s);
        }
        ul = el("ul", "w-rows");
        g.append(ph, ul);
        section!.append(g);
        group = gk;
      }
      ul!.append(this.row(r, i, r.id === keepId));
    });
    if (!this.vis.length) {
      const e = el("div", "w-empty");
      e.textContent = this.query
        ? `nothing in the wake matches “${this.query}”`
        : this.ws
          ? "nothing in this workspace's wake yet. Rows land at the end of each turn; crew-artifacts backfill reads every transcript once."
          : "no workspace yet.";
      out.push(e);
    }
    this.list.replaceChildren(...out);
    this.sel = keepId === undefined ? -1 : this.vis.findIndex((r) => r.id === keepId);
  }

  private row(r: Row, i: number, sel: boolean): HTMLElement {
    const li = el("li", `w-row ${r.state}${sel ? " sel" : ""}`);
    li.dataset.i = String(i);
    li.append(el("span", `w-k k-${r.kind}`, r.kind));
    const t = el("span", "w-t");
    const gh = ghLink(r);
    // A link made with a title shows it; one only named shows owner/repo #n.
    const title = r.title || (gh ? `${gh.repo} #${gh.n}` : r.locator);
    t.title = gh ? r.url : title;
    t.append(marked(title, this.query));
    li.append(t);
    const badges = el("span", "w-badges");
    if (r.state === "risk") badges.append(el("span", "w-st risk", "at risk"));
    else if (r.state === "kept") badges.append(el("span", "w-st kept", "kept"));
    else if (r.state === "gone") badges.append(el("span", "w-st", "gone"));
    if (r.published) badges.append(el("span", "w-st pub", "claude.ai"));
    if (r.kind === "commit" && r.sha) badges.append(el("span", "w-st", r.sha));
    if (gh && r.title) badges.append(el("span", "w-st", `#${gh.n}`));
    li.append(badges);
    const w = where(r, this.home);
    if (w) {
      // Cut by whole folders, the full path on hover; a search shows it whole.
      const p = el("span", "w-p");
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
    if (primary === keep) shown(keep.label, keep.title ?? "", () => void this.keep(r));
    else if (primary === publish) shown(pubLabel, pubTitle, (b) => void this.publish(r, b)).classList.add("pub");
    if (r.kind === "plan") {
      items.push(
        { label: "working", title: "in the sheet; ⌘-click in cmux", run: (e) => void this.open(r, "working", e) },
        { label: "review", run: (e) => void this.open(r, "review", e) },
        { label: "markdown", run: (e) => void this.open(r, "md", e) },
      );
    } else if (this.openable(r)) {
      items.push({ label: "open", hint: "↵", title: "pages in the sheet; ⌘-click opens in cmux", run: (e) => void this.open(r, "", e) });
    }
    if (r.publishable && primary !== publish) items.push(publish);
    if (r.path) items.push({ label: "copy path", hint: "c", run: () => void this.copy(r.path, "the path") });
    if (r.session_id) items.push({ label: "copy resume", hint: "r", run: () => void this.copy(resumeCmd(r), "the resume command") });
    if (items.length) acts.append(dotsMenu(`${title}: more`, items));
    li.append(acts);
    // A click opens the row, as Enter does; the arrows still only select.
    li.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, a, .tuck-wrap")) return;
      // A drag that selected some text ends in a click: that is a copy, not an open.
      const s = window.getSelection();
      if (s && !s.isCollapsed && li.contains(s.anchorNode)) return;
      this.select(i);
      if (this.openable(r)) void this.open(r, "", e);
    });
    return li;
  }

  /** Whether the row has anything to open: a gone file has nothing, unless a URL or commit stands in. */
  private openable(r: Row): boolean {
    return r.kind === "plan" || r.state !== "gone" || !!r.url || r.kind === "commit";
  }

  private chip(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".w-chip");
    if (!b) return;
    const k = b.dataset.k ?? "";
    if (!k) this.kinds.clear();
    else if (e.shiftKey) {
      if (this.kinds.has(k)) this.kinds.delete(k);
      else this.kinds.add(k);
    } else {
      const only = this.kinds.has(k) && this.kinds.size === 1;
      this.kinds.clear();
      if (!only) this.kinds.add(k);
    }
    this.sel = -1;
    this.draw();
  }

  private select(i: number, scroll = false): void {
    const els = this.list.querySelectorAll<HTMLElement>(".w-row");
    els.forEach((x) => x.classList.remove("sel"));
    this.sel = Math.max(-1, Math.min(i, this.vis.length - 1));
    const at = els[this.sel];
    if (at) {
      at.classList.add("sel");
      if (scroll) at.scrollIntoView({ block: "nearest" });
    }
  }

  private async open(r: Row, sub: string, e?: MouseEvent | KeyboardEvent): Promise<void> {
    // Open in cmux, as /artifacts does: beside the workspace in front.
    const toCmux = async () => {
      const o = await invoke<{ detail: string }>("wake_open", { id: r.id, sub, here: false });
      if (o.detail) this.toast(o.detail);
    };
    try {
      if (e?.metaKey) return await toCmux();
      if (r.path && VIEWABLE.test(r.path) && r.state !== "gone" && !["plan", "review", "ask", "commit", "artifact"].includes(r.kind)) {
        try {
          const shown = await invoke<Shown>("wake_file", { id: r.id });
          return this.host ? this.host.show(shown, toCmux, this.host.here()) : sheet().show(shown, toCmux, { dir: r.ws });
        } catch (err) {
          this.toast(`${String(err)} · opening it in cmux`, true);
          return await toCmux();
        }
      }
      const o = await invoke<{ sheet: string | null; detail: string }>("wake_open", { id: r.id, sub, here: true });
      if (o.sheet && this.host) await this.host.open({ path: o.sheet, title: r.title || r.locator, toCmux, ...this.host.here() });
      else if (o.sheet) await sheet().open({ path: o.sheet, title: r.title || r.locator, toCmux, dir: r.ws });
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

  private async keepAll(): Promise<void> {
    const b = this.keepAllBtn;
    if (!b.classList.contains("sure")) {
      arm(b);
      b.classList.add("sure");
      b.textContent = `sure? copy ${this.data.truncated ? "at least " : ""}${b.dataset.n} files`;
      clearTimeout(Number(b.dataset.timer));
      b.dataset.timer = String(
        window.setTimeout(() => {
          b.classList.remove("sure");
          b.textContent = `keep all ${b.dataset.n}`;
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
    // The Wake tab yields to the sheet; the sheet's own Wake has the keys there.
    if (!!document.querySelector(".sheet:not([hidden])") !== this.embedded) return;
    const inQ = document.activeElement === this.q;
    if (e.key === "Escape") {
      if (!this.help.hidden) {
        this.help.hidden = true;
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
        this.select(0, true);
      }
      return;
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLSelectElement || focused instanceof HTMLInputElement) return;
    // A focused button takes its own Enter and Space.
    if (focused instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
    const r = this.vis[this.sel];
    if (e.metaKey) {
      if (e.key === "Enter" && r) {
        e.preventDefault();
        void this.open(r, "", e);
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
        this.select(this.sel + 1, true);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        this.select(this.sel - 1, true);
        break;
      case "Enter":
        if (r) {
          e.preventDefault();
          void this.open(r, "");
        }
        break;
      case " ":
        if (r) {
          e.preventDefault();
          this.list.querySelectorAll(".w-row")[this.sel]?.closest(".w-grp")?.querySelector<HTMLElement>(".w-prompt")?.click();
        }
        break;
      case "K":
        void this.keep(r);
        break;
      case "c":
        if (r?.path) void this.copy(r.path, "the path");
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
