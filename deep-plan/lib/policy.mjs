// A repo's autonomy policy (ADR 0108): how far work on each path may go
// without a person.
//
//   .seamux/policy.json
//   { "default": "auto-go",
//     "paths": [{ "match": "docs/**", "level": "auto-merge", "fix": "off" }],
//     "scenarios": { "require": "auto-pr", "threshold": 0.8, "writer": "opus", "judge": "sonnet" },
//     "merge": { "method": "squash" } }
//
// Levels, lowest first:
//   supervised  a person says go to every increment
//   auto-go     increments follow on by themselves (a plan's go: auto); a
//               person opens and merges the PR
//   auto-pr     deep-plan ship opens the PR (or marks a draft ready)
//   auto-merge  deep-plan ship merges it once every gate passes
// Land write approvals stay a person's at every level.
//
// The policy is read from the base branch (origin/<base>, fetched), never
// the worktree, so a change cannot raise its own level: the way CODEOWNERS
// works. A repo with no policy keeps today's behavior, auto-go. A policy that
// cannot be read (the fetch failed, the file is not JSON, or it does not
// validate) falls to supervised, never higher.
//
// A path's level is the lowest of the entries that match it, else the
// default; a change's level is the lowest of its files'. `fix` (off,
// diagnose, draft-pr) is the next plan's: validated and shown, never acted on.
import { spawnSync } from "node:child_process";
import { matchesGlob } from "./verify.mjs";

export const POLICY_REL = ".seamux/policy.json";
export const LEVELS = ["supervised", "auto-go", "auto-pr", "auto-merge"];
export const FIX_LEVELS = ["off", "diagnose", "draft-pr"];
export const MERGE_METHODS = ["merge", "squash", "rebase"];
// Today's behavior, for a repo that has no policy.
export const NO_POLICY_LEVEL = "auto-go";
export const FALLBACK_LEVEL = "supervised";
const FETCH_TIMEOUT_MS = 20000;

export const rank = l => LEVELS.indexOf(l);
export const lowest = ls => ls.reduce((a, b) => (rank(b) < rank(a) ? b : a), LEVELS[LEVELS.length - 1]);
export const atLeast = (l, floor) => rank(l) >= rank(floor);

export function validatePolicy(p) {
  const errs = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["the policy is a JSON object"];
  for (const k of Object.keys(p)) if (!["default", "paths", "scenarios", "merge", "$schema", "note"].includes(k)) errs.push(`${k}: not a policy field (default, paths, scenarios, merge)`);
  if (!LEVELS.includes(p.default)) errs.push(`default: one of ${LEVELS.join(", ")}`);
  if (p.paths !== undefined) {
    if (!Array.isArray(p.paths)) errs.push("paths: a list of { match, level, fix? }");
    else p.paths.forEach((e, i) => {
      const at = `paths[${i}]`;
      if (!e || typeof e !== "object") { errs.push(`${at}: an object`); return; }
      const m = Array.isArray(e.match) ? e.match : [e.match];
      if (!m.length || m.some(x => typeof x !== "string" || !x.trim())) errs.push(`${at}.match: a glob, or a list of globs`);
      if (!LEVELS.includes(e.level)) errs.push(`${at}.level: one of ${LEVELS.join(", ")}`);
      if (e.fix !== undefined && !FIX_LEVELS.includes(e.fix)) errs.push(`${at}.fix: one of ${FIX_LEVELS.join(", ")}`);
      for (const k of Object.keys(e)) if (!["match", "level", "fix", "note"].includes(k)) errs.push(`${at}.${k}: not a path field (match, level, fix)`);
    });
  }
  const s = p.scenarios;
  if (s !== undefined) {
    if (!s || typeof s !== "object") errs.push("scenarios: an object");
    else {
      if (s.require !== undefined && typeof s.require !== "boolean" && !LEVELS.includes(s.require))
        errs.push(`scenarios.require: true (at auto-pr and above), false, or the lowest level that needs them`);
      if (s.threshold !== undefined && !(typeof s.threshold === "number" && s.threshold >= 0 && s.threshold <= 1))
        errs.push("scenarios.threshold: a number from 0 to 1");
      for (const k of ["writer", "judge"]) if (s[k] !== undefined && (typeof s[k] !== "string" || !s[k].trim())) errs.push(`scenarios.${k}: a model name`);
    }
  }
  if (p.merge !== undefined && (!p.merge || typeof p.merge !== "object" || (p.merge.method !== undefined && !MERGE_METHODS.includes(p.merge.method))))
    errs.push(`merge.method: one of ${MERGE_METHODS.join(", ")}`);
  return errs;
}

const git = (root, ...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8", timeout: FETCH_TIMEOUT_MS });

// The base branch, as a ref the policy is read from: origin's HEAD, else
// origin/main or origin/master, else a local main or master (a repo with no
// remote). null when there is none.
export function baseOf(root) {
  const head = git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^refs\/remotes\//, "");
  for (const r of ["origin/main", "origin/master", "main", "master"])
    if (git(root, "rev-parse", "--verify", "--quiet", `${r}^{commit}`).status === 0) return r;
  return null;
}

// The policy as the base branch holds it.
// { source: "base" | "none" | "unreadable", ref, policy, why, fallback }
// fetch: false reads the ref as it is locally (status, the board); render and
// ship fetch first, and a failed fetch is unreadable.
export function readPolicy(root, { fetch = true, base } = {}) {
  const ref = base || baseOf(root);
  if (!ref) return { source: "none", ref: "", policy: null, why: "no base branch to read a policy from" };
  if (fetch && ref.startsWith("origin/")) {
    const f = git(root, "fetch", "--quiet", "origin", ref.slice("origin/".length));
    if (f.status !== 0)
      return { source: "unreadable", ref, policy: null, why: `could not fetch ${ref} (${(f.stderr || f.error && f.error.message || "").trim().split("\n").pop() || "git fetch failed"})` };
  }
  const show = git(root, "show", `${ref}:${POLICY_REL}`);
  if (show.status !== 0) {
    const missing = /does not exist|exists on disk, but not in|not in '|path '.*' does not exist/i.test(show.stderr || "");
    if (missing) return { source: "none", ref, policy: null, why: `${ref} has no ${POLICY_REL}` };
    return { source: "unreadable", ref, policy: null, why: `could not read ${ref}:${POLICY_REL} (${(show.stderr || "").trim().split("\n").pop()})` };
  }
  let p;
  try { p = JSON.parse(show.stdout); }
  catch (e) { return { source: "unreadable", ref, policy: null, why: `${ref}:${POLICY_REL} is not JSON (${e.message})` }; }
  const errs = validatePolicy(p);
  if (errs.length) return { source: "unreadable", ref, policy: null, why: `${ref}:${POLICY_REL}: ${errs.join("; ")}`, errors: errs };
  return { source: "base", ref, policy: p, why: `${ref}:${POLICY_REL}` };
}

// One path's level and the entry that set it: { level, by, fix }.
export function levelOf(pol, file) {
  if (!pol || pol.source === "none") return { level: NO_POLICY_LEVEL, by: "no policy", fix: "off" };
  if (pol.source !== "base") return { level: FALLBACK_LEVEL, by: pol.why, fix: "off" };
  const p = pol.policy;
  const hits = (p.paths || []).filter(e => (Array.isArray(e.match) ? e.match : [e.match]).some(g => matchesGlob(file, g)));
  if (!hits.length) return { level: p.default, by: "default", fix: "off" };
  const low = hits.reduce((a, b) => (rank(b.level) < rank(a.level) ? b : a));
  return { level: low.level, by: [].concat(low.match).join(", "), fix: low.fix || "off" };
}

// A set of files' level: the lowest, and the file that set it. No files is
// the default (or the fallback when the policy is unreadable).
export function changeLevel(pol, files) {
  const list = [...new Set((files || []).filter(Boolean))];
  if (!list.length) {
    const l = levelOf(pol, "");
    const lv = pol && pol.source === "base" ? pol.policy.default : l.level;
    return { level: lv, file: "", by: pol && pol.source === "base" ? "default" : l.by };
  }
  let best = null;
  for (const f of list) {
    const l = levelOf(pol, f);
    if (!best || rank(l.level) < rank(best.level)) best = { ...l, file: f };
  }
  return best;
}

// The lowest level at which the policy wants a scenarios check, or null.
export function scenariosRequiredAt(pol) {
  const s = pol && pol.source === "base" && pol.policy.scenarios;
  if (!s || s.require === undefined || s.require === false) return null;
  return s.require === true ? "auto-pr" : s.require;
}

export const mergeMethod = pol => (pol && pol.source === "base" && pol.policy.merge && pol.policy.merge.method) || "squash";

// The files a branch changes against its base: committed since the merge base.
export function branchFiles(root, ref) {
  const mb = git(root, "merge-base", "HEAD", ref);
  if (mb.status !== 0) return null;
  // --no-renames: a file moved out of a supervised path is its old path too
  // (a delete there), not only its new one.
  const d = git(root, "diff", "--no-renames", "--name-only", mb.stdout.trim(), "HEAD");
  return d.status === 0 ? d.stdout.split("\n").map(s => s.trim()).filter(Boolean) : null;
}

// What `policy show` prints, as lines.
export function describe(pol, files = []) {
  const out = [];
  if (pol.source === "none") out.push(`no policy (${pol.why}): every path is ${NO_POLICY_LEVEL}, as before policies`);
  else if (pol.source === "unreadable") out.push(`policy unreadable: ${pol.why}; every path falls to ${FALLBACK_LEVEL}`);
  else {
    const p = pol.policy;
    out.push(`policy from ${pol.ref}: default ${p.default}`);
    for (const e of p.paths || []) out.push(`  ${[].concat(e.match).join(", ")}  ${e.level}${e.fix && e.fix !== "off" ? `  (fix: ${e.fix}, not acted on yet)` : ""}`);
    const req = scenariosRequiredAt(pol);
    if (req) out.push(`  scenarios required at ${req} and above${p.scenarios.threshold !== undefined ? `, threshold ${p.scenarios.threshold}` : ""}`);
    out.push(`  merges by ${mergeMethod(pol)}`);
  }
  for (const f of files) { const l = levelOf(pol, f); out.push(`${f}: ${l.level} (${l.by})`); }
  return out;
}
