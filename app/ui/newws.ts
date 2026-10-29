// The Dock's New workspace form: a repo, a branch and Claude's first
// message, made with no terminal (newws_app.rs). The steps show as they run;
// the new workspace opens in the Dock when it is up.
import { Channel, invoke } from "@tauri-apps/api/core";

type Repo = { name: string; path: string; base: string };
type Options = { repos: Repo[]; prefix: string; remote: boolean; sandbox: boolean };
type StepMsg = { step: string; phase: "start" | "done" | "warn" | "failed"; detail: string };
type Made = { path: string; branch: string; workspaceRef: string; workspaceId: string | null };

const STEPS: Record<string, string> = {
  fetch: "Fetch origin",
  worktree: "Add the worktree",
  fixups: "Get it ready to commit",
  sandbox: "Start the sandbox",
  workspace: "Open the workspace",
};

const LAST_REPO = "seamux.newws.repo";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SVG = "http://www.w3.org/2000/svg";
/** A step's mark: a turning arc, a check, a bang or a cross. */
function mark(phase: StepMsg["phase"] | "wait"): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 12 12");
  s.setAttribute("class", `newws-mark ${phase}`);
  const p = document.createElementNS(SVG, "path");
  p.setAttribute(
    "d",
    {
      wait: "M6 1.5a4.5 4.5 0 1 1-4.5 4.5",
      start: "M6 1.5a4.5 4.5 0 1 1-4.5 4.5",
      done: "M2.5 6.2 5 8.5l4.5-5",
      warn: "M6 2.5v4.5M6 9.2v.3",
      failed: "M3 3l6 6M9 3 3 9",
    }[phase],
  );
  s.append(p);
  return s;
}

/** A branch name out of a sentence: "Fix the login bug!" -> "fix-the-login-bug". */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "")
    .replace(TRAILING, "");
}

/** Small words a cut-off name should not end on ("…-loop-on"). */
const TRAILING = /(-(a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with))+$/;

function remembered(): string {
  try {
    return localStorage.getItem(LAST_REPO) ?? "";
  } catch {
    return "";
  }
}

function remember(repo: string): void {
  try {
    localStorage.setItem(LAST_REPO, repo);
  } catch {
    /* a private store: the first repo is the default next time */
  }
}

export class NewWorkspace {
  /** Called with the new workspace's UUID once it is open. */
  onMade: (ws: string) => void = () => {};
  private el = el("div", "newws");
  private card = el("form", "newws-card");
  private repo = el("select", "newws-repo");
  private prefix = el("span", "newws-prefix");
  private branch = el("input", "newws-branch");
  private prompt = el("textarea", "newws-prompt");
  private more = el("details", "newws-more");
  private moreSum = el("summary");
  private base = el("input", "newws-base");
  private remote = el("input");
  private sandbox = el("select", "newws-sandbox");
  private sandboxRow = el("label", "newws-row");
  private steps = el("ol", "newws-steps");
  private say = el("p", "newws-say");
  private cancel = el("button", "sheet-btn", "Cancel");
  private create = el("button", "sheet-btn newws-go", "Create");
  private opts: Options | null = null;
  private busy = false;
  /** Made this opening, though not yet listed: Create (⌘↵, Enter) is done. */
  private made = false;

  constructor() {
    this.el.hidden = true;
    this.card.setAttribute("role", "dialog");
    this.card.setAttribute("aria-label", "New workspace");
    this.card.noValidate = true;

    const head = el("header", "newws-head");
    head.append(el("b", "", "New workspace"), el("span", "newws-hint", "a worktree, a cmux workspace, Claude running"));

    this.repo.setAttribute("aria-label", "Repo");
    this.repo.addEventListener("change", () => this.drawMore());
    this.branch.type = "text";
    this.branch.spellcheck = false;
    this.branch.autocomplete = "off";
    this.branch.setAttribute("aria-label", "Branch");
    this.branch.addEventListener("input", () => this.drawBranch());
    const branchBox = el("span", "newws-branchbox");
    branchBox.append(this.prefix, this.branch);

    this.prompt.rows = 4;
    this.prompt.placeholder = "What should Claude start on? (optional)";
    this.prompt.setAttribute("aria-label", "First prompt");
    this.prompt.addEventListener("input", () => this.drawBranch());

    this.base.type = "text";
    this.base.spellcheck = false;
    this.base.setAttribute("aria-label", "Base branch");
    this.base.addEventListener("input", () => this.drawMore());
    this.remote.type = "checkbox";
    this.remote.addEventListener("change", () => this.drawMore());
    for (const [v, t] of [
      ["", "off"],
      ["link", "linked: your Claude setup, read-only"],
      ["isolated", "isolated: a clean Claude"],
    ]) {
      const o = el("option", "", t);
      o.value = v;
      this.sandbox.append(o);
    }
    this.sandbox.setAttribute("aria-label", "Sandbox");
    this.sandbox.addEventListener("change", () => this.drawMore());
    this.more.append(
      this.moreSum,
      this.row("Base", this.base),
      this.row("Remote Control", this.remote, "newws-check"),
      this.sandboxRow,
    );
    this.sandboxRow.append(el("span", "newws-label", "Sandbox"), this.sandbox);

    this.cancel.type = "button";
    this.cancel.addEventListener("click", () => this.close());
    this.create.type = "submit";
    const foot = el("footer", "newws-foot");
    foot.append(el("span", "newws-keys", "⌘↵ create · esc"), this.cancel, this.create);

    this.steps.hidden = true;
    this.say.hidden = true;
    this.card.append(
      head,
      this.row("Repo", this.repo),
      this.row("Branch", branchBox),
      this.row("Prompt", this.prompt, "newws-top"),
      this.more,
      this.steps,
      this.say,
      foot,
    );
    // The views' keys (⌘1…⌘9 and the rest) stay out of the form's fields.
    this.card.addEventListener("keydown", (e) => e.stopPropagation());
    this.card.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.go();
    });
    this.el.append(this.card);
    // A click outside closes it, but never mid-make: the steps are the news.
    this.el.addEventListener("click", (e) => e.target === this.el && !this.busy && this.close());
    document.body.append(this.el);

    // While open the form has every key; ⌘N opens it from the app's own views.
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.el.hidden) {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!this.busy) this.close();
          } else if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
            void this.go();
          } else if (!this.card.contains(e.target as Node)) {
            e.stopImmediatePropagation();
          }
          return;
        }
        if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
          e.preventDefault();
          e.stopImmediatePropagation();
          void this.open();
        }
      },
      true,
    );
  }

  private row(label: string, field: HTMLElement, cls = ""): HTMLLabelElement {
    const r = el("label", `newws-row ${cls}`.trim());
    r.append(el("span", "newws-label", label), field);
    return r;
  }

  /** The repo picked, or `want` when it is one of them. */
  private pick(want = ""): void {
    const repos = this.opts?.repos ?? [];
    this.repo.replaceChildren(
      ...repos.map((r) => {
        const o = el("option", "", r.name);
        o.value = r.name;
        return o;
      }),
    );
    const keep = repos.find((r) => r.name === want) ?? repos.find((r) => r.name === remembered()) ?? repos[0];
    if (keep) this.repo.value = keep.name;
  }

  /** Open the form, `repo` picked when given. */
  async open(repo = ""): Promise<void> {
    if (!this.el.hidden) return;
    this.el.hidden = false;
    this.say.hidden = true;
    this.steps.hidden = true;
    this.made = false;
    this.setBusy(false);
    try {
      this.opts = await invoke<Options>("new_ws_options");
    } catch (e) {
      this.tell(`Could not list the repos: ${String(e)}`, true);
      return;
    }
    if (!this.opts.repos.length) {
      this.tell("No git checkouts under your code root (CREW_CODE_ROOT, else ~/code).", true);
    }
    this.pick(repo);
    this.prefix.textContent = this.opts.prefix;
    this.remote.checked = this.opts.remote;
    this.sandboxRow.hidden = !this.opts.sandbox;
    this.sandbox.value = "";
    this.base.value = "";
    this.drawBranch();
    this.drawMore();
    this.branch.focus();
  }

  close(): void {
    this.el.hidden = true;
    this.branch.value = "";
    this.prompt.value = "";
    this.steps.replaceChildren();
  }

  /** The branch to make: what was typed, else one from the prompt. */
  private branchName(): string {
    return this.branch.value.trim() || slug(this.prompt.value);
  }

  private drawBranch(): void {
    const typed = this.branch.value.trim();
    this.prefix.hidden = typed.includes("/");
    this.branch.placeholder = slug(this.prompt.value) || "branch-name";
  }

  private drawMore(): void {
    const repo = this.opts?.repos.find((r) => r.name === this.repo.value);
    this.base.placeholder = repo?.base ?? "origin/main";
    const sandboxed = this.sandbox.value !== "";
    this.prompt.disabled = sandboxed || this.busy;
    this.prompt.placeholder = sandboxed ? "A sandboxed workspace can't take a first prompt yet" : "What should Claude start on? (optional)";
    this.remote.disabled = sandboxed || this.busy;
    const bits = [`base ${this.base.value.trim() || this.base.placeholder}`];
    if (sandboxed) bits.push(`sandbox ${this.sandbox.value}`);
    else bits.push(this.remote.checked ? "Remote Control on" : "Remote Control off");
    this.moreSum.textContent = `More · ${bits.join(" · ")}`;
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    for (const f of [this.repo, this.branch, this.base, this.sandbox, this.cancel, this.create]) f.disabled = on;
    this.create.textContent = on ? "Creating…" : "Create";
    this.drawMore();
  }

  private tell(text: string, bad = false): void {
    this.say.hidden = !text;
    this.say.textContent = text;
    this.say.classList.toggle("bad", bad);
  }

  /** The step list, every step waiting, sandbox only when asked. */
  private drawSteps(sandboxed: boolean): Map<string, HTMLLIElement> {
    const rows = new Map<string, HTMLLIElement>();
    this.steps.replaceChildren();
    for (const [key, label] of Object.entries(STEPS)) {
      if (key === "sandbox" && !sandboxed) continue;
      const li = el("li", "newws-step wait");
      li.append(mark("wait"), el("span", "newws-step-name", label), el("span", "newws-step-detail"));
      rows.set(key, li);
      this.steps.append(li);
    }
    this.steps.hidden = false;
    return rows;
  }

  private async go(): Promise<void> {
    if (this.busy || this.made || !this.opts) return;
    const branch = this.branchName();
    if (!this.repo.value) return this.tell("Pick a repo.", true);
    if (!branch) {
      this.branch.focus();
      return this.tell("Name the branch, or write a prompt to name it from.", true);
    }
    const sandbox = this.sandbox.value || null;
    const rows = this.drawSteps(!!sandbox);
    this.tell("");
    this.setBusy(true);
    const ch = new Channel<StepMsg>();
    ch.onmessage = (m) => {
      const li = rows.get(m.step);
      if (!li) return;
      li.className = `newws-step ${m.phase}`;
      li.firstElementChild?.replaceWith(mark(m.phase));
      const detail = li.querySelector(".newws-step-detail");
      if (detail) detail.textContent = m.detail;
    };
    try {
      const made = await invoke<Made>("new_ws_create", {
        form: {
          repo: this.repo.value,
          branch,
          base: this.base.value.trim() || null,
          prompt: sandbox ? null : this.prompt.value.trim() || null,
          sandbox,
          remote: this.remote.checked,
        },
        onStep: ch,
      });
      remember(this.repo.value);
      this.setBusy(false);
      if (made.workspaceId) {
        this.close();
        this.onMade(made.workspaceId);
      } else {
        // Made, but cmux's lists did not name it yet: say where it is.
        this.tell(`${made.branch} is open in cmux as ${made.workspaceRef || "a new workspace"}; pick it in the Dock when it shows.`);
        this.made = true;
        this.create.textContent = "Done";
        this.create.disabled = true;
      }
    } catch (e) {
      this.setBusy(false);
      // A step that failed already says why, beside it.
      const said = [...rows.values()].some((li) => li.classList.contains("failed"));
      if (!said) this.tell(String(e), true);
    }
  }
}
