// A change from review to release, as the Lookout tab draws it (plan
// landing): a rail of four stages (Review, PR, Merge, Land) over the
// selected change, and the panel for each stage past Review. The PR and its
// merge come from the workspace's PR list (crew-sync), the landing from
// land_watch.rs (landing_get). Merge is read-only. What can be done at Land
// (approve, skip, retry) goes back through land_act. release_probe.ts checks
// the pure parts under node.

/** A workspace's PR, as landing_prs gives it. */
export type PrRow = {
  n: number;
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  review?: string;
  conflict?: boolean;
  checks?: { fail: number; run: number; pass: number; gate: number; unseen: number } | null;
  failing?: { name: string; url: string }[];
  gating?: { name: string; url: string }[];
  merge?: { sha: string; at: string; base: string };
  cwd: string;
  ws: string;
  ws_title: string;
};

export type Stage = "review" | "pr" | "merge" | "land";
export const STAGES: Stage[] = ["review", "pr", "merge", "land"];
const NAMES: Record<Stage, string> = { review: "Review", pr: "PR", merge: "Merge", land: "Land" };

export type LandStage = { name: string; status: string; start?: number; end?: number };
export type LandRecipe = {
  key: string;
  name?: string;
  status: string;
  stages: LandStage[];
  version?: { expect: string; live: string; match: boolean };
  links?: { label: string; url: string }[];
  error?: string;
  tail?: string;
};
export type Landing = {
  state: { pr?: string; merge: string; recipes: Record<string, LandRecipe> };
  overall: { status: string; stage: string; recipe: string; live: boolean };
};

/** Each stage's state for a change: done, now (where it is), waiting,
 *  needs (the person), failed, or none (not reached). */
export type StageState = "done" | "now" | "needs" | "failed" | "none";

export function stagesOf(hasReview: boolean, pr: PrRow | null, land: Landing | null, reviewing = false): Record<Stage, StageState> {
  const merged = pr?.state === "merged";
  const red = (pr?.checks?.fail ?? 0) > 0 || !!pr?.conflict;
  const o = land?.overall.status ?? "";
  return {
    // A review still running is where the change is, not a stage it has passed.
    review: reviewing ? "now" : hasReview ? "done" : "none",
    pr: !pr ? "none" : merged || pr.state === "closed" ? "done" : red ? "failed" : "now",
    merge: merged ? "done" : "none",
    land: !merged ? "none" : o === "done" ? "done" : o === "awaiting" ? "needs" : o === "failed" || o === "stopped" ? "failed" : o === "landing" ? "now" : "none",
  };
}

/** The stage a change opens at: where it is now. */
export function stageFor(hasReview: boolean, pr: PrRow | null, land: Landing | null): Stage {
  if (pr?.state === "merged" && land) return "land";
  if (pr?.state === "merged") return "merge";
  return hasReview ? "review" : "pr";
}

/** A side-list row's few words for where the change is. */
export function chipFor(pr: PrRow | null, land: Landing | null): { text: string; cls: string } | null {
  if (!pr) return null;
  if (pr.state === "merged") {
    const o = land?.overall;
    if (!o) return { text: "merged", cls: "done" };
    if (o.status === "landing") return { text: o.stage ? `landing · ${o.stage}` : "landing", cls: "now" };
    if (o.status === "awaiting") return { text: "landing needs you", cls: "needs" };
    if (o.status === "failed" || o.status === "stopped") return { text: `landing ${o.status}`, cls: "failed" };
    if (o.status === "done") return { text: o.live ? "live ✓" : "landed", cls: "done" };
    return { text: "merged", cls: "done" };
  }
  if (pr.state === "closed") return { text: "closed", cls: "none" };
  const c = pr.checks;
  if (c?.fail) return { text: `PR · ✗${c.fail}`, cls: "failed" };
  if (c?.run) return { text: `PR · ${c.run} running`, cls: "now" };
  return { text: pr.state === "draft" ? "draft PR" : "PR open", cls: "now" };
}

/** "3m12s", "9s". */
export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, title: string, go: () => void, cls = "r-btn quiet"): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", go);
  return b;
}

/** The rail: four stages, each a button with its state; the current one pressed. */
export function railEl(states: Record<Stage, StageState>, current: Stage, pick: (s: Stage) => void, can: Record<Stage, boolean>): HTMLElement {
  const rail = el("nav", "r-rail");
  rail.setAttribute("aria-label", "From review to release");
  STAGES.forEach((s, i) => {
    if (i) rail.append(el("span", "r-rail-sep", "──"));
    const b = el("button", `r-rail-stage ${states[s]}${s === current ? " on" : ""}`);
    b.type = "button";
    b.disabled = !can[s];
    b.setAttribute("aria-pressed", String(s === current));
    const mark = { done: "✓", now: "●", needs: "!", failed: "✗", none: "○" }[states[s]];
    b.append(el("span", "r-rail-mark", mark), el("span", "", NAMES[s]));
    b.addEventListener("click", () => pick(s));
    rail.append(b);
  });
  return rail;
}

/** The PR stage: its state, review and checks, and its red and gating checks. */
export function prPanel(pr: PrRow, open: (url: string) => void): HTMLElement {
  const box = el("div", "r-stage-panel");
  const c = pr.checks;
  const head = el("p", "r-detail", `PR #${pr.n} is ${pr.state}${pr.review ? ` · review ${pr.review.toLowerCase().replace(/_/g, " ")}` : ""}${pr.conflict ? " · has conflicts" : ""}.`);
  box.append(head);
  if (c) box.append(el("p", "r-detail", `Checks: ${c.fail} failed, ${c.run} running, ${c.pass} passed${c.gate ? `, ${c.gate} waiting on a person` : ""}${c.unseen ? `, ${c.unseen} more not read` : ""}.`));
  for (const [label, list] of [["Failed", pr.failing ?? []], ["Waiting on a person", pr.gating ?? []]] as const) {
    if (!list.length) continue;
    const ul = el("ul", "r-stage-list");
    for (const f of list) {
      const li = el("li", "");
      if (/^https:\/\//.test(f.url)) li.append(button(f.name, `Open ${f.name} in the browser`, () => open(f.url), "r-link"));
      else li.textContent = f.name;
      ul.append(li);
    }
    box.append(el("h4", "r-stage-h", label), ul);
  }
  box.append(button("Open on GitHub", "Open the pull request in the browser", () => open(pr.url)));
  return box;
}

/** What `deep-plan ship --dry-run --json` says of the worktree: the
 *  change's level on the repo policy, its gates, and the one act ship would
 *  take (ship_view in land_watch.rs). */
export type ShipView = {
  plan: string | null;
  level: "supervised" | "auto-go" | "auto-pr" | "auto-merge" | string;
  levelBy: string;
  capped?: string;
  policy: { source: string; ref: string; why: string };
  gates: { gate: string; ok: boolean; why: string; warn?: boolean; info?: boolean; missing?: string[] }[];
  action: "none" | "wait" | "push" | "open" | "ready" | "merge" | "merge-when-green" | string;
  waits: string[];
  say?: string;
  /** The branch's PR as ship read it, at every level. */
  pr?: { number: number; url: string; state: string; draft?: boolean } | null;
  /** What ship would have done at the policy's observe level, acting on none of it. */
  observe?: { level: string; by: string; action: string; would: string; waits: string[]; capped?: string } | null;
  /** "ship --merge" on the person's merge through ship. */
  lever?: string | null;
};

/** What `deep-plan ship --merge --json` answered the person's Ship it
 *  (ship_merge in land_watch.rs): the verdict it acted on, and what it did. */
export type ShipMerged = ShipView & { result?: { ok: boolean; note: string } };

/** The Merge stage's two lines from ship's verdict: the level and where it
 *  came from, and who merges and what ship waits on. Pure, for the probe. */
export function shipSummary(v: ShipView): { level: string; next: string; observe?: string; reads?: string[] } {
  const from = v.policy.source === "none" ? "no repo policy, so as before" : v.policy.source === "unreadable" ? `the policy could not be read: ${v.policy.why}` : v.levelBy;
  const level = `Policy level: ${v.level} (${from}).`;
  if (!v.plan) return { level, next: "No deep-plan plan is at this worktree, so ship does not act on it: a person opens and merges the PR." };
  // What ship read of the PR's checks below auto-merge, and a token that
  // could not read them: lines that hold nothing.
  const reads = v.gates.filter((g) => (g.gate === "ci" && g.info) || (g.gate === "token" && g.warn))
    .map((g) => `${g.gate === "ci" ? "Checks" : "Token"}: ${g.why}.`);
  const o = v.observe;
  const observe = o ? `Observed at ${o.level} (${o.by}): ship ${o.would}${o.waits.length ? `, once these are met: ${o.waits.join("; ")}` : ""}.` : undefined;
  if (v.level !== "auto-merge" || v.capped) {
    const who = v.level === "auto-pr" ? "ship opens the PR; a person merges it" : "a person opens the PR and merges it";
    // Ship's own gates hold a person's merge too (seamux/ship), so they show
    // at every level (note ne6be8da8).
    const waits = v.waits.length ? ` Ship's gates wait on: ${v.waits.join("; ")}.` : "";
    return { level, next: (v.capped ? `${v.capped[0].toUpperCase()}${v.capped.slice(1)}.` : `At this level ${who}.`) + waits,
      ...(observe ? { observe } : {}), ...(reads.length ? { reads } : {}) };
  }
  if (v.action === "merge") return { level, next: "Every gate has passed: deep-plan ship merges it." };
  if (v.action === "merge-when-green") return { level, next: "deep-plan ship merges it once its checks are green." };
  if (v.action === "open" || v.action === "ready") return { level, next: "deep-plan ship opens it for review, then merges it once every gate passes." };
  if (v.action === "wait") return { level, next: `deep-plan ship merges it once these are met: ${v.waits.join("; ")}.` };
  return { level, next: v.say ? `${v.say[0].toUpperCase()}${v.say.slice(1)}.` : "Nothing for ship to do." };
}

/** Whether the Merge stage offers the person's Ship it, and if not why:
 *  below auto-merge (or capped there), with ship's verdict on a plan and an
 *  open PR. Ship's own gates must pass first; checks still running are
 *  ship's to wait out. Pure, for the probe. */
export function shipItOffer(v: ShipView | null): { show: boolean; ready: boolean; why: string } {
  const none = { show: false, ready: false, why: "" };
  if (!v || !v.plan || !v.pr || v.pr.state !== "OPEN") return none;
  if (v.level === "auto-merge" && !v.capped) return none;
  if (v.waits.length) return { show: true, ready: false, why: `Ship's gates wait on: ${v.waits.join("; ")}` };
  return { show: true, ready: true, why: `Merge PR #${v.pr.number} through deep-plan ship: every gate still holds it, and it merges once the checks are green` };
}

/** What the Ship it answer says, in a line. Pure, for the probe. */
export function shipItSaid(r: ShipMerged): string {
  const note = r.result?.note ?? "";
  if (r.action === "wait") return `Ship waits on: ${r.waits.join("; ") || note}.`;
  if (r.result && !r.result.ok) return `Ship could not: ${note}`;
  return note ? `${note[0].toUpperCase()}${note.slice(1)}.` : "Done.";
}

/** The Merge stage: merged when and into what, or what stands between the
 *  PR and a merge, and (with ship's verdict) the policy's level, what ship
 *  waits on, what an observed level would do, and the person's Ship it.
 *  Merging is ship's at auto-merge, else the person's: on GitHub, or here. */
export function mergePanel(pr: PrRow, open: (url: string) => void, ship: ShipView | null = null,
  shipIt: (() => Promise<ShipMerged>) | null = null): HTMLElement {
  const box = el("div", "r-stage-panel");
  if (pr.state === "merged") {
    const m = pr.merge;
    box.append(el("p", "r-detail", m ? `Merged into ${m.base || "its base"} as ${m.sha.slice(0, 7)}${m.at ? ` at ${new Date(m.at).toLocaleString()}` : ""}.` : "Merged."));
  } else if (pr.state === "closed") {
    box.append(el("p", "r-detail", "Closed without a merge."));
  } else {
    const holds: string[] = [];
    if (pr.state === "draft") holds.push("it is a draft");
    if (pr.conflict) holds.push("it has conflicts with its base");
    if (pr.checks?.fail) holds.push(`${pr.checks.fail} check${pr.checks.fail === 1 ? "" : "s"} failed`);
    if (pr.checks?.run) holds.push(`${pr.checks.run} check${pr.checks.run === 1 ? " is" : "s are"} still running`);
    if (pr.gating?.length) holds.push(`${pr.gating.length} wait${pr.gating.length === 1 ? "s" : ""} on a person`);
    if (pr.review && pr.review !== "APPROVED") holds.push(`review is ${pr.review.toLowerCase().replace(/_/g, " ")}`);
    box.append(el("p", "r-detail", holds.length ? `Not ready to merge: ${holds.join(", ")}.` : "Nothing seen stands in the way of a merge."));
    if (ship) {
      const s = shipSummary(ship);
      box.append(el("p", "r-detail", s.level), el("p", "r-detail", s.next));
      for (const r of s.reads ?? []) box.append(el("p", "r-detail", r));
      if (s.observe) box.append(el("p", "r-detail r-observe", s.observe));
    }
    const offer = shipItOffer(ship);
    if (offer.show && shipIt) box.append(shipItButton(ship!, offer, shipIt));
    box.append(el("p", "r-note", ship && ship.level === "auto-merge" && !ship.capped
      ? "Land approvals stay yours; seamux lands the merge once it is in."
      : offer.show ? "Merge here with Ship it, or on GitHub; seamux lands the merge once it is in."
      : "Merging happens on GitHub; seamux lands the merge once it is in."));
  }
  box.append(button("Open on GitHub", "Open the pull request in the browser", () => open(pr.url)));
  return box;
}

/** Ship it, in two clicks: the first asks, the second merges. It takes no
 *  focus when drawn (L12), and says what ship answered under it. */
function shipItButton(v: ShipView, offer: { ready: boolean; why: string }, go: () => Promise<ShipMerged>): HTMLElement {
  const wrap = el("div", "r-shipit");
  const said = el("p", "r-detail");
  const n = v.pr?.number;
  const b = button("Ship it", offer.why, () => {
    if (b.dataset.ask !== "1") {
      b.dataset.ask = "1";
      b.textContent = `Merge PR #${n} now`;
      b.title = "Click again to merge it through deep-plan ship";
      return;
    }
    b.disabled = true;
    b.textContent = "Shipping…";
    void go().then(
      (r) => {
        const merged = r.action === "merge" && r.result?.ok !== false;
        said.textContent = shipItSaid(r); b.textContent = merged ? "Merged" : "Ship it"; b.disabled = merged; delete b.dataset.ask;
      },
      (e) => { said.textContent = `Ship could not: ${e}`; b.textContent = "Ship it"; b.disabled = false; delete b.dataset.ask; });
  }, "r-btn primary");
  if (!offer.ready) b.disabled = true;
  wrap.append(b, said);
  return wrap;
}

export type LandActs = {
  act: (recipe: string, what: "approve" | "skip" | "retry" | "dismiss") => void;
  log: (recipe: string) => Promise<string>;
  open: (url: string) => void;
};

/** The Land stage: one line per recipe, its stages with their times, the
 *  live version against the merge, its links and log, and what the person
 *  can do when it waits or failed. */
export function landPanel(land: Landing | null, merged: boolean, acts: LandActs): HTMLElement {
  const box = el("div", "r-stage-panel");
  if (!merged) {
    box.append(el("p", "r-detail", "Lands once the PR merges."));
    return box;
  }
  if (!land) {
    box.append(el("p", "r-detail", "Nothing has landed for this merge: no land recipe covers what it changed, or it merged before seamux watched for it."));
    return box;
  }
  const recipes = Object.values(land.state.recipes);
  if (!recipes.length) box.append(el("p", "r-detail", "Its landing has not started a recipe yet."));
  if (land.overall.status === "failed" || land.overall.status === "stopped") {
    const first = recipes[0]?.key ?? "";
    box.append(button("Dismiss", "Take this landing off the Dock card: you have seen to it", () => acts.act(first, "dismiss")));
  }
  for (const r of recipes) {
    const row = el("div", `r-land ${r.status}`);
    const head = el("div", "r-land-head");
    head.append(el("span", "r-land-name", r.name || r.key), el("span", `r-land-status ${r.status}`, r.status));
    const stages = el("div", "r-land-stages");
    r.stages.forEach((s, i) => {
      if (i) stages.append(el("span", "r-land-sep", "│"));
      const t = s.start && s.end ? ` ${took(s.end - s.start)}` : s.status === "running" ? " …" : "";
      stages.append(el("span", `r-land-stage ${s.status}`, `${s.name}${t}`));
    });
    row.append(head, stages);
    if (r.version && (r.version.expect || r.version.live)) {
      const v = r.version;
      row.append(el("p", `r-land-version ${v.match ? "match" : "differs"}`,
        `live ${v.live || "unknown"} ${v.match ? "=" : "≠"} ${v.expect || "?"}${v.match ? " ✓" : ""}`));
    }
    const tools = el("div", "r-land-tools");
    for (const l of r.links ?? []) if (/^https?:\/\//.test(l.url)) tools.append(button(`${l.label} ↗`, l.url, () => acts.open(l.url), "r-btn quiet"));
    if (r.status === "awaiting") {
      tools.append(button("Approve", "Approve this recipe's writing steps as it is now, and let it go on", () => acts.act(r.key, "approve"), "r-btn primary"));
      tools.append(button("Skip", "Skip this recipe for this merge", () => acts.act(r.key, "skip")));
    }
    // Retry only a recipe that has not finished: a done one is not landed
    // again from here, and its writing steps never run twice.
    const unfinished = r.status === "failed" || (land.overall.status === "stopped" && !["done", "skipped"].includes(r.status));
    if (unfinished) tools.append(button("Retry", "Run it again from the stage that stopped", () => acts.act(r.key, "retry"), "r-btn primary"));
    const logBox = el("pre", "r-land-log");
    logBox.hidden = true;
    tools.append(button("Log", "Show the end of this recipe's log", () => {
      if (!logBox.hidden) { logBox.hidden = true; return; }
      void acts.log(r.key).then((t) => { logBox.textContent = t || "(empty)"; logBox.hidden = false; }, (e) => { logBox.textContent = String(e); logBox.hidden = false; });
    }));
    row.append(tools);
    if (r.error) row.append(el("p", "r-land-error", r.error));
    if (r.tail && r.status === "failed") row.append(el("pre", "r-land-log", r.tail));
    row.append(logBox);
    box.append(row);
  }
  return box;
}

/** Read each merged PR's landing into `into` (by merge commit), through
 *  `get` (landing_get). Whether any changed. The Lookout tab and the Wake
 *  both read landings this way. */
export async function readLandings(prs: { cwd: string; merge?: { sha: string } }[], into: Map<string, Landing | null>,
                                   get: (cwd: string, merge: string) => Promise<Landing | null>): Promise<boolean> {
  let moved = false;
  await Promise.all(prs.filter((p) => p.merge).map(async (p) => {
    const sha = p.merge!.sha;
    const got = await get(p.cwd, sha).catch(() => undefined);
    if (got === undefined) return;
    if (JSON.stringify(got) !== JSON.stringify(into.get(sha) ?? null)) moved = true;
    into.set(sha, got);
  }));
  return moved;
}
