// Auto-go: a plan whose human chose, at planning time, to let each increment
// follow the last once its checks pass. `done` gives the next increment's go
// itself (recorded `by: auto`), so no agent ever runs `go` and the gate's rule
// that an agent's go is the human's word is untouched. An increment the spec
// marks `go: { human: "<why>" }` stops the chain for a person's go.
//
//   "go": "human" | "auto" | { "mode": "human" | "auto", "between": "commit" | "draft-pr" }
//   deliverables[].go: { "human": "why a person must look before this one starts" }
//
// `between` is what the agent does after a `done` that auto-goes and before
// it starts the next increment: "commit" (already done before `done`) or
// "draft-pr" (push the branch and open or update a draft PR).

export const GO_MODES = ["human", "auto"];
export const BETWEEN = ["commit", "draft-pr"];

// The plan's go policy. A plan that does not say is a person's, as before.
export function goPolicy(spec) {
  const g = (spec || {}).go;
  if (g === "auto") return { auto: true, between: "commit" };
  if (g && typeof g === "object" && !Array.isArray(g) && g.mode === "auto")
    return { auto: true, between: BETWEEN.includes(g.between) ? g.between : "commit" };
  return { auto: false, between: "commit" };
}

// Why increment n (1-based) waits for a person on an auto plan, or "".
export function humanStop(spec, n) {
  const d = ((spec || {}).deliverables || [])[n - 1];
  const g = d && d.go;
  return g && typeof g === "object" && typeof g.human === "string" ? g.human.trim() : "";
}

// Whether increment n carries a lookout review: one it declares, or one the
// human chose with review.increments.
function reviewed(spec, n) {
  const d = (spec.deliverables || [])[n - 1] || {};
  if ((d.checks || []).some(c => c && c.kind === "review")) return true;
  const chosen = spec.review && spec.review.increments;
  return chosen === "all" || (Array.isArray(chosen) && chosen.includes(n));
}

// Spec problems, for validate(). Shape first, then the one rule that keeps an
// auto chain from stalling unseen: a reviewed increment followed by one that
// auto-goes needs review.agentMayClose, or the chain waits on a person
// closing findings without anyone being asked.
export function goProblems(spec) {
  const errs = [];
  const g = spec.go;
  if (g !== undefined) {
    const isObj = g && typeof g === "object" && !Array.isArray(g);
    if (!(GO_MODES.includes(g) || isObj))
      errs.push('go: "human", "auto", or { "mode": "auto", "between": "commit" | "draft-pr" }');
    else if (isObj) {
      if (!GO_MODES.includes(g.mode)) errs.push('go.mode: "human" or "auto"');
      if (g.between !== undefined && !BETWEEN.includes(g.between)) errs.push('go.between: "commit" or "draft-pr"');
      if (g.mode !== "auto" && g.between !== undefined) errs.push("go.between: only an auto plan has a step between increments");
      for (const k of Object.keys(g)) if (!["mode", "between"].includes(k)) errs.push(`go.${k}: not a go field (mode, between)`);
    }
  }
  const pol = goPolicy(spec);
  const ds = spec.deliverables || [];
  ds.forEach((d, i) => {
    if (!d || d.go === undefined) return;
    const ok = d.go && typeof d.go === "object" && !Array.isArray(d.go) &&
      typeof d.go.human === "string" && d.go.human.trim() && Object.keys(d.go).length === 1;
    if (!ok) errs.push(`deliverable ${i + 1}: go is { "human": "why a person must look before it starts" }`);
    else if (!pol.auto) errs.push(`deliverable ${i + 1}: go.human stops an auto plan; this plan's go is a person's already`);
    else if (i === 0) errs.push("deliverable 1: go.human is implied, the first go after the alignment check is a person's");
  });
  if (pol.auto && !(spec.review && spec.review.agentMayClose === true)) {
    for (let n = 1; n < ds.length; n++) {
      if (reviewed(spec, n) && !humanStop(spec, n + 1))
        errs.push(`go auto: increment ${n} has a lookout review and increment ${n + 1} auto-goes after it, ` +
          `but only a person may close its findings. Set review.agentMayClose, or stop increment ${n + 1} ` +
          `for a person with go: { "human": "<why>" }`);
    }
  }
  return errs;
}

// What `done` on increment `doneN` does next on an auto plan. `st` is the
// plan state with doneN already marked done; `forced` means a check was
// outstanding (the proof was skipped, so the chain stops); `owner` and
// `waits` are the family's goOwner and waitingOn for the plan; `familyError`
// says they could not be read.
// Returns { go: n } to authorize, { stop: n, why } when a person must give
// it, or null when there is nothing to say (not auto, or nothing pending).
export function autoNext(spec, st, doneN, { forced = false, owner = null, waits = [], familyError = "" } = {}) {
  if (!goPolicy(spec).auto) return null;
  const incs = st.increments || [];
  const next = incs.find(i => i.status === "pending");
  if (!next) return null;
  const stop = why => ({ stop: next.n, why });
  if (forced) return stop(`increment ${doneN} closed with --force past its checks, so the chain stops for a person`);
  const open = incs.find(i => i.status === "authorized" || i.status === "working");
  if (open) return stop(`increment ${open.n} is already ${open.status}`);
  // A blocked increment is a person's to unblock; the chain never runs past it.
  const blocked = incs.find(i => i.status === "blocked");
  if (blocked) return stop(`increment ${blocked.n} is blocked${blocked.note ? ` (${blocked.note})` : ""}`);
  if (familyError) return stop(`the family's state could not be read (${familyError})`);
  const why = humanStop(spec, next.n);
  if (why) return stop(why);
  if (owner && owner.delegated) return stop(`its go is delegated to the family parent (${owner.parent})`);
  if (owner && owner.hold) return stop(`the family parent is holding it: "${owner.hold.reason}"`);
  if (waits.length) return stop("it waits on its family's parent");
  return { go: next.n };
}

// The repo policy's word on an auto plan (lib/policy.mjs, ADR 0108). `levels`
// is each increment's level, [{ level, file, by }], from its files on the
// base branch's policy; `requiredAt` the lowest level that needs a scenarios
// check (or null); `why` where the policy came from. An increment after the
// first that would auto-go is refused when its files are supervised, unless
// it stops for a person. A plan whose files all sit at or above requiredAt
// (ship would open or merge it alone) needs a scenarios check somewhere.
export function policyProblems(spec, levels, { requiredAt = null, why = "" } = {}) {
  const errs = [];
  const pol = goPolicy(spec);
  const ds = spec.deliverables || [];
  if (pol.auto) ds.forEach((d, i) => {
    const l = levels[i];
    if (i === 0 || !l || l.level !== "supervised" || humanStop(spec, i + 1)) return;
    errs.push(`deliverable ${i + 1}: go auto, but the policy holds ${l.file || "its files"} supervised (${l.by}; ${why}). ` +
      `Stop it for a person with go: { "human": "<why>" }, or make the plan's go a person's`);
  });
  if (requiredAt && levels.length) {
    const rankOf = l => ["supervised", "auto-go", "auto-pr", "auto-merge"].indexOf(l);
    const planLevel = levels.reduce((a, b) => (rankOf(b.level) < rankOf(a.level) ? b : a));
    const has = ds.some(d => (d.checks || []).some(c => c && c.kind === "scenarios"));
    if (rankOf(planLevel.level) >= rankOf(requiredAt) && !has)
      errs.push(`the plan's files are at ${planLevel.level}, and the policy needs a scenarios check at ${requiredAt} and above (${why}): ` +
        `add { "kind": "scenarios" } to an increment's checks (deep-plan scenarios write drafts them after the grade)`);
  }
  return errs;
}
