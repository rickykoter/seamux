// Landing: what runs after a PR merges (plan landing; ADRs 0098-0104).
//
// A project writes land recipes beside its checks in .seamux/verify.json
// (kind "land"). For a merge, `plan` finds the recipes whose match covers
// the files the merge changed; `run` runs one of them in the repo's kept
// checkout, a step at a time, each step a stage the engine times. A step
// marked `writes` (it changes an outside system: a deploy, a notebook) waits
// until the person has approved that recipe, as it is now. The run records
// everything in one state file per merge, which the app, the Lookout tab
// and deep-plan read:
//
//   <crew home>/landings/<repo key>/<merge>.json
//   { repo, key, pr, merge, recipes: { <recipe key>: { key, id, name, hash,
//     status: running|awaiting|done|failed|skipped, stages: [{ name,
//     status, start, end }], version: { expect, live, match }, links:
//     [{ label, url }], exports, log, error, tail, started, ended } } }
//
// The crew home is CREW_DURABLE_DIR, else ~/.claude/crew (ADR 0024).
// Approvals live beside it in land-approvals.json, keyed by repo, recipe
// and the recipe's hash, so an edited recipe asks again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolver, LAND_VARS, LAND_VAR_RE } from "./verify.mjs";
import { runExec } from "./runner.mjs";

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function crewHome(env = process.env) {
  return env.CREW_DURABLE_DIR || path.join(os.homedir(), ".claude", "crew");
}

const git = (root, args) => {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};

// The repo's key in the landings folder: owner__name from its origin when
// that is a GitHub remote (the app keys a PR the same way), else the
// checkout's folder name. Only letters, digits, dot, dash and underscore.
export function repoKey(root) {
  const url = (git(root, ["remote", "get-url", "origin"]) || "").trim();
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  const raw = m ? `${m[1]}__${m[2]}` : path.basename(path.resolve(root));
  return raw.replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
}

const safe = s => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

export function statePath(home, key, merge) {
  return path.join(home, "landings", safe(key), `${safe(merge)}.json`);
}

function logPath(home, key, merge, recipe) {
  return path.join(home, "landings", safe(key), `${safe(merge)}.${safe(recipe)}.log`);
}

// Written whole (a temp file moved into place), readable only by its owner:
// a step's exports can hold a deploy's id or a token-bearing URL.
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// An exclusive lock file holding its owner's pid. False while a live
// process holds it; a lock whose owner is gone is taken over.
//
// The lock appears whole: the pid is written to a file of this process's
// own, which is then hard-linked to the lock's name (link fails if the name
// exists), so no reader ever sees a lock with no pid in it.
//
// Taking over a dead holder's lock is done by one process at a time, under
// a second lock (`<lock>.takeover`, held only for the few calls it takes).
// Inside it the holder is read again: one still dead is removed and our own
// linked in its place. A live holder that took the lock first is always
// seen, and a process that links between the removal and ours simply wins:
// our link then fails, and we hold nothing. A takeover lock left by a crash
// is cleared once it is ten seconds old.
export function takeLock(p) {
  const mine = `${p}.${process.pid}`;
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 });
  const link = () => {
    try { fs.linkSync(mine, p); return true; } catch (err) { if (err.code !== "EEXIST") throw err; return false; }
  };
  try {
    if (link()) return true;
    const holder = () => Number(String(readText(p)).trim());
    if (holder() && alive(holder())) return false;
    const tk = `${p}.takeover`;
    try { fs.linkSync(mine, tk); }
    catch (err) {
      if (err.code !== "EEXIST") throw err;
      let age = 0;
      try { age = Date.now() - fs.statSync(tk).mtimeMs; } catch { /* gone: another takeover finished */ }
      if (age > 10_000) fs.rmSync(tk, { force: true });
      return false;
    }
    try {
      const pid = holder();
      if (pid && alive(pid)) return false;
      fs.rmSync(p, { force: true });
      return link();
    } finally {
      fs.rmSync(tk, { force: true });
    }
  } finally {
    fs.rmSync(mine, { force: true });
  }
}
const readText = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

// Write `entry` as recipe `rk`'s in the merge's state file, leaving every
// other recipe's as it is on disk now. The read and the write hold a short
// lock, waited on for up to five seconds.
function updateEntry(sp, base, rk, entry) {
  const lock = `${sp}.lock`;
  const until = Date.now() + 5000;
  while (!takeLock(lock)) {
    if (Date.now() > until) throw new Error(`could not lock ${sp}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  try {
    const st = readJson(sp) || { ...base, recipes: {} };
    if (base.pr) st.pr = base.pr;
    st.recipes = { ...(st.recipes || {}), [rk]: entry };
    writeJson(sp, st);
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// The files a merge changed: its diff against its first parent (a squash
// or a merge commit alike). Null when the commit is not in this checkout,
// which then needs a fetch first.
export function changedFiles(root, merge) {
  if (!SHA_RE.test(String(merge || ""))) return { error: `not a commit sha: ${merge}` };
  if (git(root, ["rev-parse", "--verify", "--quiet", `${merge}^{commit}`]) === null)
    return { error: `${merge} is not in ${root}: fetch first` };
  const parent = git(root, ["rev-parse", "--verify", "--quiet", `${merge}^1`]) !== null;
  const out = parent ? git(root, ["diff", "--name-only", `${merge}^1`, merge])
    : git(root, ["show", "--name-only", "--format=", merge]);
  if (out === null) return { error: `could not list ${merge}'s files` };
  return { files: out.split("\n").map(s => s.trim()).filter(Boolean) };
}

const stageName = (s, k) => s.stage || `step ${k + 1}`;
// A failed stage's error, naming the stage once: runExec's run and timeout
// notes say "at <stage>" already; a wait's give-up, a claim's or a browser
// step's note does not, so the name goes in front.
export const namedError = (note, stage) => String(note).includes(`at ${stage}:`) ? String(note) : `${stage}: ${note}`;

// The land recipes a merge lands: every one whose match covers a file it
// changed, each once (by its key, so two projects' same-named recipes stay
// two). Config errors anywhere resolution looked are returned too.
export function landPlan(root, merge) {
  const ch = changedFiles(root, merge);
  if (ch.error) return { error: ch.error };
  const R = resolver(root, { land: true });
  const byKey = new Map();
  for (const f of ch.files) for (const r of R.file(f).recipes) if (!byKey.has(r.key)) byKey.set(r.key, r);
  const recipes = [...byKey.values()];
  return {
    root: R.root, merge, files: ch.files, errors: R.errors(),
    recipes: recipes.map(r => ({ key: r.key, id: r.id, name: r.name, project: r.project, hash: r.hash,
      stages: r.steps.map(stageName), writes: r.steps.some(s => s.writes === true) })),
    _recipes: recipes,
  };
}

// ---------------------------------------------------------------- approvals

const approvalsPath = home => path.join(home, "land-approvals.json");

export function approved(home, key, recipe, hash) {
  const a = readJson(approvalsPath(home)) || {};
  return !!(a[key] && a[key][recipe] && a[key][recipe].hash === hash);
}

// The person's yes for `recipe` as it is now (its hash): its writing steps
// run from then on, until the recipe changes.
export function approve(home, key, recipe, hash, now = Date.now()) {
  const p = approvalsPath(home);
  const a = readJson(p) || {};
  a[key] = { ...(a[key] || {}), [recipe]: { hash, at: now } };
  writeJson(p, a);
}

// ---------------------------------------------------------------- run

// A land output string with $NAME and ${NAME} filled from the run's
// variables; a name the run never set is left empty.
export function fill(s, vars) {
  return typeof s === "string" ? s.replace(LAND_VAR_RE, (_, a, b) => vars[a || b] ?? "").trim() : "";
}

// Whether a live version is the one expected. Commit shas match on a common
// prefix of seven or more characters; anything else matches exactly.
export function versionMatch(expect, live) {
  if (!expect || !live) return false;
  if (expect === live) return true;
  const a = expect.toLowerCase(), b = live.toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(a) && /^[0-9a-f]{7,40}$/.test(b) && (a.startsWith(b) || b.startsWith(a));
}

function outputsOf(recipe, vars) {
  const o = recipe.outputs || {};
  const out = {};
  if (o.version) {
    const expect = fill(o.version.expect, vars), live = fill(o.version.live, vars);
    out.version = { expect, live, match: versionMatch(expect, live) };
  }
  // A link is drawn as one in the app, so it must be a web address: an
  // exported value that is anything else (a javascript: or file: URL, a
  // path) is dropped.
  out.links = (o.links || []).map(l => ({ label: l.label, url: fill(l.url, vars) })).filter(l => /^https?:\/\/\S+$/i.test(l.url));
  return out;
}

// Run one land recipe for a merge, from its first stage that has not
// passed (a retry, or a run that waited for approval, picks up there with
// the exports it had). Returns { status, note } and leaves the state file
// saying the same. `pr` is the PR's number, if known.
export function landRun(root, { merge, recipe: wanted, pr = "", home = crewHome(), fresh = false } = {}) {
  root = path.resolve(root);
  const plan = landPlan(root, merge);
  if (plan.error) return { status: "error", note: plan.error };
  if (plan.errors.length) return { status: "error", note: `config errors: ${plan.errors.join("; ")}` };
  const recipe = plan._recipes.find(r => r.key === wanted || r.id === wanted);
  if (!recipe) return { status: "error", note: `no land recipe "${wanted}" covers ${merge}'s files` };
  const key = repoKey(root);
  const sp = statePath(home, key, merge);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  // One run of a recipe at a time: a second would start its stages, and its
  // writing steps, again. The lock names its holder; a holder that is gone
  // (a crash, a kill) leaves a lock the next run takes back.
  const runLock = `${sp.replace(/\.json$/, "")}.${safe(recipe.key)}.run`;
  if (!takeLock(runLock)) return { status: "busy", note: `${recipe.key} is already landing ${merge}` };
  try {
    return runLocked(root, { plan, recipe, key, sp, merge, pr, home, fresh });
  } finally {
    fs.rmSync(runLock, { force: true });
  }
}

function runLocked(root, { recipe, key, sp, merge, pr, home, fresh }) {
  const base = { repo: root, key, pr: String(pr || ""), merge, recipes: {} };
  const prev = ((readJson(sp) || base).recipes || {})[recipe.key];
  // A done or skipped recipe is not landed again unless asked: a re-run would
  // repeat its writing steps.
  if (!fresh && prev && prev.hash === recipe.hash && ["done", "skipped"].includes(prev.status))
    return { status: prev.status, note: `${recipe.key} is already ${prev.status} for ${merge} (--force lands it again)` };
  let e = null;
  // Each save writes this recipe's entry alone into the merge's file, under
  // a short lock, so two recipes of one merge running side by side never
  // drop each other's.
  const save = () => updateEntry(sp, base, recipe.key, e);
  const log = logPath(home, key, merge, recipe.key);
  const stages = recipe.steps.map((s, k) => ({ name: stageName(s, k), status: "pending" }));
  // Resume where a failed or waiting run stopped, unless asked to start
  // over or the recipe changed under it. Every stage done but the status
  // left behind (a run killed after its last step): nothing runs again.
  let start = 0;
  let exports = {};
  let recrashed = -1;
  if (!fresh && prev && prev.hash === recipe.hash && ["failed", "awaiting", "running"].includes(prev.status)) {
    const at = (prev.stages || []).findIndex(s => s.status !== "done");
    start = at < 0 ? recipe.steps.length : at;
    for (let k = 0; k < start; k++) stages[k] = prev.stages[k];
    exports = prev.exports || {};
    // A writing stage a crash cut off may have written already: it is not
    // run again on its own, but waits for the person, approved or not.
    const cut = prev.stages && prev.stages[start];
    if (cut && cut.status === "running" && recipe.steps[start] && recipe.steps[start].writes) recrashed = start;
  } else if (fs.existsSync(log)) fs.rmSync(log, { force: true });
  // Owner-only from the start, as the state file is: a step's output can
  // name what its exports hold.
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.closeSync(fs.openSync(log, "a", 0o600));
  e = {
    key: recipe.key, id: recipe.id, name: recipe.name, hash: recipe.hash, status: "running",
    started: start && prev ? prev.started : Date.now(), stages, exports, log, error: "", tail: "",
  };
  save();
  const prNow = String(pr || (readJson(sp) || {}).pr || "");
  let vars = { ...exports, MERGE_SHA: merge, PR: prNow, REPO: root };
  const cwd = path.posix.join(recipe.project || ".", recipe.cwd || ".");
  for (let k = start; k < recipe.steps.length; k++) {
    // The step keeps its stage, so runExec's notes name it ("exit 1 at
    // install: …") rather than counting within this one-step exec.
    const { writes, ...rest } = recipe.steps[k];
    const step = { ...rest, stage: stageName(recipe.steps[k], k) };
    if (k === recrashed) {
      e.status = "awaiting";
      e.stages[k] = { name: e.stages[k].name, status: "awaiting", cut: true };
      save();
      return { status: "awaiting", note: `${e.stages[k].name} was cut off mid-run and may have written already: retry the landing to run it again, or skip it` };
    }
    if (writes && !approved(home, key, recipe.key, recipe.hash)) {
      e.status = "awaiting";
      e.stages[k] = { ...e.stages[k], status: "awaiting" };
      save();
      return { status: "awaiting", note: `${e.stages[k].name} writes to an outside system: approve ${recipe.key} to run it` };
    }
    e.stages[k] = { name: e.stages[k].name, status: "running", start: Date.now() };
    save();
    const exec = { cwd, timeout: recipe.timeout, steps: [step], env: recipe.env || {},
      ...(k === 0 && recipe.prereqs && recipe.prereqs.length ? { prereqs: recipe.prereqs } : {}) };
    const r = runExec(exec, { root, log, env: vars, vars: true });
    e.stages[k] = { ...e.stages[k], end: Date.now(), status: r.status === "pass" ? "done" : "failed" };
    if (r.status !== "pass") {
      e.status = "failed";
      e.error = namedError(r.note || r.status, step.stage);
      e.tail = (r.ran && r.ran.tail) || "";
      save();
      return { status: "failed", note: e.error };
    }
    vars = r.vars || vars;
    e.exports = Object.fromEntries(Object.entries(vars).filter(([n]) => !LAND_VARS.includes(n) && !(n in (recipe.env || {}))));
    save();
  }
  Object.assign(e, outputsOf(recipe, vars), { status: "done", ended: Date.now() });
  save();
  return { status: "done", note: e.version ? `live ${e.version.live || "?"}${e.version.match ? " = " : " ≠ "}${e.version.expect}` : "done" };
}

// The person's no for a recipe waiting on its approval: it is left for
// this merge.
export function landSkip(root, { merge, recipe, home = crewHome() } = {}) {
  const sp = statePath(home, repoKey(root), merge);
  const found = Object.values((readJson(sp) || {}).recipes || {}).find(x => x.key === recipe || x.id === recipe);
  // Under the recipe's run lock, so a run that starts meanwhile and a skip
  // never write over each other.
  const runLock = found && `${sp.replace(/\.json$/, "")}.${safe(found.key)}.run`;
  if (runLock && !takeLock(runLock)) return { status: "error", note: `${found.key} is landing now; skip it once it waits again` };
  try { return skipLocked(sp, merge, recipe); } finally { if (runLock) fs.rmSync(runLock, { force: true }); }
}

function skipLocked(sp, merge, recipe) {
  const st = readJson(sp);
  const e = st && st.recipes && Object.values(st.recipes).find(x => x.key === recipe || x.id === recipe);
  if (!e) return { status: "error", note: `no landing of ${recipe} for ${merge}` };
  if (e.status !== "awaiting") return { status: "error", note: `${e.key} is ${e.status}, not waiting for approval` };
  e.status = "skipped";
  e.stages = (e.stages || []).map(s => (s.status === "awaiting" || s.status === "pending" ? { ...s, status: "skipped" } : s));
  updateEntry(sp, st, e.key, e);
  return { status: "skipped", note: `${e.key} skipped for ${merge}` };
}

export function landStatus(root, merge, home = crewHome()) {
  return readJson(statePath(home, repoKey(root), merge));
}
