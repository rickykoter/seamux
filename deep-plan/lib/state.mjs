// deep-plan state: one small JSON file per plan, plus the single decision
// function ("may this call edit this path") shared by the CLI and the gate.
//
// Env overrides exist for the probe, and only for the probe:
//   DEEP_PLAN_STATE_DIR  DEEP_PLAN_KEYS_DIR  DEEP_PLAN_PLANS_DIR
// On the remote host (lib/host.mjs) the defaults move into the repo, under
// <git root>/.seamux/state, because the sandbox's home does not survive it
// (ADR 0043). The overrides still win there.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { remoteStateDir } from "./host.mjs";
import { matchesGlob } from "./verify.mjs";
import { EXT_DIR } from "./ext.mjs";

// The tree the defaults hang off: ~/.claude, or the repo's on the remote host.
// Both have the same layout below it.
export const REMOTE_DIR = remoteStateDir();
export const DATA_ROOT = REMOTE_DIR || path.join(os.homedir(), ".claude");
export const STATE_DIR = process.env.DEEP_PLAN_STATE_DIR || path.join(DATA_ROOT, "deep-plan", "state");
export const KEYS_DIR = process.env.DEEP_PLAN_KEYS_DIR || path.join(DATA_ROOT, "deep-plan", "keys");
export const PLANS_DIR = process.env.DEEP_PLAN_PLANS_DIR || path.join(DATA_ROOT, "plans");

export function statePath(slug) { return path.join(STATE_DIR, slug + ".json"); }

export function readState(slug) {
  try { return JSON.parse(fs.readFileSync(statePath(slug), "utf8")); }
  catch { return null; }
}

// Single-writer lock: mkdir is atomic on every filesystem we care about, and
// the writers (the CLI, the board's transitions through it, a detached check
// runner and the gate hook's flip-to-working) can race. A holder that died
// leaves a stale dir; one older than 5s whose holder (its pid, in the dir) is
// gone is reclaimed, and a live holder's only past 2 minutes, so a writer still
// at work is never robbed. Holds are short:
// every writer does its slow work (hashing a tree, running a recipe) before it
// takes the lock. On sustained contention the write fails, loudly, rather
// than proceeding unlocked: an unlocked write is how a person's click on the
// board was lost under an agent's slow `done`.
// DEEP_PLAN_LOCK_WAIT_MS is for the probe.
const LOCK_WAIT_MS = Number(process.env.DEEP_PLAN_LOCK_WAIT_MS) || 10000;
const nap = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB: spin */ const u = Date.now() + ms; while (Date.now() < u) { /* spin */ } } };
export class LockBusy extends Error {}
// Who holds a lock dir and since when: {pid, mtime}; throws when it is gone.
function lockOwner(dir) {
  const mtime = fs.statSync(dir).mtimeMs;
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8")) || 0; } catch { /* none written yet */ }
  return { pid, mtime };
}
function acquireLock(slug) {
  const dir = path.join(STATE_DIR, ".lock-" + slug);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      try { fs.writeFileSync(path.join(dir, "pid"), String(process.pid)); } catch { /* an unnamed holder ages out */ }
      return dir;
    }
    catch (e) {
      // Only "it exists" is contention; anything else (no permission, no
      // parent) will not clear by waiting.
      if (e.code !== "EEXIST") throw new LockBusy(`deep-plan: cannot take ${slug}'s state lock (${dir}): ${e.message}`);
      try {
        const seen = lockOwner(dir);
        const age = Date.now() - seen.mtime;
        const live = seen.pid && (() => { try { process.kill(seen.pid, 0); return true; } catch (e) { return e.code === "EPERM"; } })();
        if ((age > 5000 && !live) || age > 120000) {
          // Owner-checked: removed only if it is still the lock judged stale
          // (same holder, same time), never one another writer just took.
          const now = lockOwner(dir);
          if (now.pid === seen.pid && now.mtime === seen.mtime) fs.rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch { nap(1); continue; }        // it went away under us: try again
      nap(10);
    }
  }
  throw new LockBusy(`deep-plan: ${slug}'s state is locked by another writer (${dir}) and stayed locked for ` +
    `${Math.round(LOCK_WAIT_MS / 1000)}s; nothing was written. Try again; if no deep-plan command is running, remove that directory.`);
}
const releaseLock = lock => {
  // Only our own: a lock reclaimed from us and taken by another is theirs.
  try { if (Number(fs.readFileSync(path.join(lock, "pid"), "utf8")) !== process.pid) return; } catch { /* unnamed: ours */ }
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* already reclaimed */ }
};

function writeFileAtomic(st) {
  const p = statePath(st.slug);
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

// Read-modify-write under the lock: `fn` gets the state as it is on disk now
// and changes it in place; it may throw, and then nothing is written. Returns
// the state written. For a change that must not be built on a stale copy (a
// transition: a person's board click and an agent's `done` can land together),
// do the slow work first, then apply the change here.
export function updateState(slug, fn, { stamp = true } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = acquireLock(slug);
  try {
    const st = readState(slug);
    if (!st) throw new Error("no plan " + slug);
    if (fn(st) === false) return st;
    if (stamp) stampOwner(st);
    writeFileAtomic(st);
    return st;
  } finally { releaseLock(lock); }
}

// Who is working on a plan. Claude Code exports CLAUDE_CODE_SESSION_ID (the
// older CLAUDE_SESSION_ID is still read); cmux exports CMUX_WORKSPACE_ID. The
// session id changes on /clear, the workspace does not, so both are kept: a
// pane can then find the plan its session or workspace touched last even when
// that plan's root is another repo, and back-to-back plans in one workspace
// resolve to the newest.
export function sessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
}

// Stamped on every write made from inside a session. A write with no session
// in its environment (a board chip, a shell outside Claude) leaves the owner
// as it was rather than clearing it. The owner is a pane: cmux's
// CMUX_SURFACE_ID, which a /clear or a resume keeps while the session id
// changes. A deep-plan write from another pane moves ownership there.
export function stampOwner(st, now = Date.now()) {
  const session = sessionId();
  if (!session) return st;
  st.owner = { session, workspace: process.env.CMUX_WORKSPACE_ID || "", surface: process.env.CMUX_SURFACE_ID || "", at: now };
  st.session = session;
  return st;
}

// Whether `who` ({surface, session, workspace}) is the plan's owner: the same
// pane in cmux (a /clear keeps it), or the same session (a resume in another
// pane keeps that). An owner stamped before panes were recorded matches by
// workspace. A plan with no owner is anyone's.
export function isOwner(owner, who) {
  if (!owner) return true;
  if (owner.surface && who.surface && owner.surface === who.surface) return true;
  if (owner.session && who.session && owner.session === who.session) return true;
  if (owner.surface && who.surface) return false;
  if (!owner.surface && owner.workspace && who.workspace) return owner.workspace === who.workspace;
  return !owner.session && !owner.surface && !owner.workspace;
}

// How a person finds the owner: its pane (and workspace), else its session.
export function ownerName(owner) {
  if (!owner) return "nobody";
  const short = s => String(s).slice(0, 8);
  if (owner.surface) return `pane ${short(owner.surface)}` + (owner.workspace ? ` in workspace ${short(owner.workspace)}` : "");
  if (owner.workspace) return `workspace ${short(owner.workspace)}`;
  return `session ${short(owner.session)}`;
}

// Atomic: the gate reads this on every tool call, and a half-written JSON
// reads as "no plan" — exactly the wrong default for a gate.
//
// And merged: every writer reads the file, changes it, and writes it back,
// and a detached check runner records its verdict while the CLI, the gate or
// the board may be mid-way through the same cycle. So the write re-reads what
// is on disk under the lock and keeps what the writer never saw: a check
// verdict stamped later than the writer's copy of it, and log lines it did
// not have. Everything else is the writer's.
export function writeState(st, { stamp = true } = {}) {
  // The gate's own writes pass stamp: false: the hook runs in whichever
  // session made the tool call, and a guest's edit must not take the plan.
  if (stamp) stampOwner(st);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = acquireLock(st.slug);
  try {
    mergeConcurrent(st, readState(st.slug));
    writeFileAtomic(st);
  } finally { releaseLock(lock); }
}

// What an increment's status is, as opposed to what the spec says it is. A
// transition stamps `changedAt`; a writer holding an older copy keeps the
// newer status it never saw.
const INC_STATUS_FIELDS = ["status", "note", "startSha", "authorizedAt", "startedAt", "doneAt", "by", "changedAt"];

function mergeConcurrent(st, disk) {
  if (!disk) return;
  const dincs = new Map((disk.increments || []).map(i => [i.n, i]));
  let tookStatus = false;
  for (const inc of st.increments || []) {
    const d = dincs.get(inc.n);
    if (d && (d.changedAt || 0) > (inc.changedAt || 0)) {
      for (const f of INC_STATUS_FIELDS) { if (d[f] === undefined) delete inc[f]; else inc[f] = d[f]; }
      tookStatus = true;
    }
    if (!d || !d.checks || !inc.checks || typeof inc.checks !== "object") continue;
    for (const [id, v] of Object.entries(inc.checks)) {
      const dv = d.checks[id];
      if (!dv || (dv.at || 0) <= (v.at || 0)) continue;
      // The verdict is disk's; what the check IS stays the writer's, since a
      // render re-resolving recipes is exactly such a writer.
      const meta = Object.fromEntries(Object.entries(v).filter(([k]) => !VERDICT_FIELDS.includes(k)));
      inc.checks[id] = { ...meta, ...verdictOf(dv) };
    }
  }
  // A status kept from disk can make the writer's phase wrong: a complete plan
  // with work again is implementing, and a plan disk completed is disk's.
  if (tookStatus) {
    const allDone = (st.increments || []).length > 0 && st.increments.every(i => i.status === "done");
    if (allDone && (disk.phase === "done" || disk.phase === "delivery")) st.phase = disk.phase;
    else if (!allDone && (st.phase === "done" || st.phase === "delivery")) st.phase = "implementing";
  }
  // Guests told by the gate while this writer held its copy stay told.
  if (disk.guests && typeof disk.guests === "object") st.guests = { ...disk.guests, ...(st.guests || {}) };
  if ((disk.log || []).length) {
    const key = l => `${l.at}\u0000${l.what}`;
    const have = new Set((st.log || []).map(key));
    const extra = disk.log.filter(l => !have.has(key(l)));
    if (extra.length) st.log = [...(st.log || []), ...extra].sort((a, b) => a.at - b.at).slice(-200);
  }
}

export function allStates() {
  let names = [];
  try { names = fs.readdirSync(STATE_DIR).filter(n => n.endsWith(".json")); }
  catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(STATE_DIR, n), "utf8"))); }
    catch { /* half-written or corrupt: skip, never throw from the hot path */ }
  }
  return out;
}

export function log1(st, what) {
  st.log = st.log || [];
  st.log.push({ at: Date.now(), what });
  if (st.log.length > 200) st.log = st.log.slice(-200);
}

// --------------------------------------------------------- checks
//
// A deliverable's checks are what prove the increment works: a test suite, an
// e2e run, an observability signal, or a step a human performs. `done` is
// refused until every one has passed against the tree being closed, because a
// plan that promises a proof and ships without it has promised nothing.
//
// One model for all four kinds. Observability used to be its own verdict
// (`inc.obs`); it is now one kind of check, and the legacy spec fields still
// read: `observability.checks` become observability checks, and per-deliverable
// `verification` strings become manual ones.
// `review` is opt-in: a deliverable that declares one is gated on lookout's
// verdict (`lookout gate`), which passes when no blocker or major finding is
// open. deep-plan synthesizes its command; no recipe names it.
// `browser` is a recipe-backed check whose last step drives cmux's browser
// (lib/browser.mjs); its verdict is the exit code like any recipe's, and its
// run leaves evidence (frames, trace, replay) the surfaces show.
export const CHECK_KINDS = ["test", "e2e", "observability", "manual", "review", "browser"];
// needs-value: a claim step asks a person for a value and has nothing to poll.
export const CHECK_STATUSES = ["pending", "running", "needs-variant", "needs-value", "pass", "fail"];
// What a verdict is, as opposed to what the spec says the check is. Only these
// survive a re-render; the description is always the spec's current one.
// `at` is when the verdict last changed — every change stamps it, a reset
// included, because concurrent writes are merged by it (writeState).
// `runner` is a run in flight (token, pid, log); `acquire` what a person must run;
// `evidence` the last browser run's frames, trace and replay (lib/browser.mjs);
// `ask` a claim's open question, `answer` a person's reply to it, `claims`
// what a run holds and must release (lib/claims.mjs).
export const VERDICT_FIELDS = ["status", "at", "note", "by", "ran", "tree", "runner", "acquire", "evidence", "ask", "answer", "claims"];
const ID_PREFIX = { observability: "obs" };

function checkSlug(kind, name) {
  const kebab = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  return `${ID_PREFIX[kind] || kind}-${kebab || "check"}`;
}

// The spec's checks for one deliverable, normalized: declared first, then the
// legacy fields. An id is the author's when given, else derived from kind and
// name — stable across re-renders, so a verdict follows its check, and a
// renamed check is a new one that has to be proven again.
export function specChecks(d) {
  if (!d) return [];
  const out = [], seen = new Set();
  const add = (c, legacy) => {
    const name = String(c.name || c.system || c.recipe || c.run || (c.kind === "review" ? "code review" : "")).trim();
    let id = c.id ? String(c.id) : checkSlug(c.kind, name);
    if (!c.id) for (let k = 2, base = id; seen.has(id); k++) id = `${base}-${k}`;
    seen.add(id);
    const o = { id, kind: c.kind, name };
    for (const f of ["recipe", "run", "system", "query", "expect"]) if (c[f]) o[f] = c[f];
    // The spec's `note` describes the check; the verdict's `note` is what was
    // seen. Kept apart so recording a verdict never overwrites the brief.
    if (c.note) o.hint = c.note;
    if (legacy) o.legacy = legacy;
    out.push(o);
  };
  for (const c of d.checks || []) add(c);
  for (const c of (d.observability && d.observability.checks) || [])
    add({ ...c, kind: "observability" }, "observability");
  for (const v of d.verification || []) add({ kind: "manual", name: String(v) }, "verification");
  return out;
}

// A state file written before checks existed carries `inc.obs`, one verdict for
// the whole increment. Read it as one observability check until a render
// replaces it, so `done` gates an old plan exactly as it did before.
function legacyObs(inc) {
  const o = inc && inc.obs;
  return o && o.status && o.status !== "n/a" ? o : null;
}

// The increment's checks map, migrating the legacy verdict in place. Writers
// persist the migration; readers only see it.
export function checksOf(inc) {
  if (!inc) return {};
  if (!inc.checks || typeof inc.checks !== "object") {
    const o = legacyObs(inc);
    inc.checks = o ? { obs: { kind: "observability", name: "observability",
      status: o.status, at: o.at || 0, note: o.note || "" } } : {};
  }
  delete inc.obs;
  return inc.checks;
}

const verdictOf = v =>
  Object.fromEntries(VERDICT_FIELDS.filter(f => v[f] !== undefined).map(f => [f, v[f]]));

// What a check IS, without where its verdict stands: the shape render resolved
// from the spec and the recipes. Surfaces that show the plan as reviewed read
// this, so recording a verdict never changes the md or the review page.
export function checkMeta(id, v) {
  const out = { id };
  for (const [k, x] of Object.entries(v)) if (!VERDICT_FIELDS.includes(k) && k !== "retired") out[k] = x;
  return out;
}

// Re-render: each check keeps the verdict recorded under its id, a new one
// starts pending, and adding checks to a plan whose state already exists gates
// it rather than leaving it un-gated. A check dropped from the spec keeps a
// pass or fail as a retired entry — it was true when recorded, and silently
// deleting evidence is worse than keeping a verdict nothing gates on. A pass
// recorded against a recipe that has since changed proves nothing about the
// recipe as it now is, so it goes back to pending.
//
// `checks` is the resolved list render built (declared, recipe-backed and
// inferred); a deliverable is accepted too and read with specChecks.
export function reconcileChecks(prev, checks) {
  const fromObs = prev && !prev.checks ? legacyObs(prev) : null;
  const old = prev && prev.checks && typeof prev.checks === "object" ? prev.checks : {};
  const out = {};
  let obsUsed = false;
  for (const c of Array.isArray(checks) ? checks : specChecks(checks)) {
    const { id, ...meta } = c;
    let was = old[id];
    if (!was && fromObs && c.legacy === "observability") {
      was = { status: fromObs.status, at: fromObs.at || 0, note: fromObs.note || "" };
      obsUsed = true;
    }
    let verdict = was ? verdictOf(was) : { status: "pending", at: 0, note: "" };
    if (was && was.hash && meta.hash && was.hash !== meta.hash && verdict.status !== "pending") {
      const { ran, tree, by, runner, acquire, evidence, ...rest } = verdict;
      verdict = { ...rest, status: "pending", at: Date.now(),
        note: `was ${was.status}${was.note ? `: ${was.note}` : ""} (recipe changed since — re-run)` };
    }
    out[id] = { ...meta, ...verdict };
  }
  for (const [id, v] of Object.entries(old))
    if (!(id in out) && (v.status === "pass" || v.status === "fail")) out[id] = { ...v, retired: true };
  if (fromObs && !obsUsed && (fromObs.status === "pass" || fromObs.status === "fail"))
    out.obs = { kind: "observability", name: "observability", status: fromObs.status,
      at: fromObs.at || 0, note: fromObs.note || "", retired: true };
  return out;
}

// What the tree under `root` contains, independent of what is committed: HEAD,
// and the tree hash of the working copy staged into a scratch index (`add -A`,
// so untracked files count and ignored ones do not). A pass records this; a
// commit after it leaves `content` unchanged, any edit changes it. Null outside
// a git repository — there is then nothing to compare, and nothing goes stale.
//
// `scope` limits it to what a check covers: root-relative globs (a recipe's
// `match` and setup files) or directories ("." is the root). The content is
// then a tree of only those paths, so an edit or a stray untracked file
// elsewhere does not stale the pass, and `add` never hashes files outside it.
// The recorded tree carries its scope, so a later comparison hashes the same
// paths. A pass recorded before scopes (no `scope`) compares the whole tree.
export function treeOf(root, scope = null) {
  if (!root) return null;
  const git = (args, env, input) => spawnSync("git", ["-C", root, ...args],
    { encoding: "utf8", env: { ...process.env, ...env }, ...(input !== undefined ? { input } : {}) });
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0) return null;
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).stdout.trim();
  const tmp = path.join(os.tmpdir(), `deep-plan-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const only = tmp + ".scope";
  try {
    // Seeded from the real index so `add` only rehashes what changed. The copy
    // keeps the index's own mtime: git trusts an entry's cached stat only when
    // the entry is older than the index file ("racy git"), so a copy stamped
    // now would read a same-size edit from the second of `git add` as unchanged.
    try {
      fs.copyFileSync(index, tmp);
      const s = fs.statSync(index);
      fs.utimesSync(tmp, s.atime, s.mtime);
    } catch { /* no index yet: add builds one */ }
    const env = { GIT_INDEX_FILE: tmp };
    if (!scope) {
      const tree = git(["add", "-A"], env).status === 0 ? git(["write-tree"], env) : null;
      return { head: head.stdout.trim(), content: tree && tree.status === 0 ? tree.stdout.trim() : "" };
    }
    // A scope entry outside the root (`../x` once normalized) is no pathspec
    // git takes: dropped, and said on the tree.
    const inRoot = scope.filter(g => !path.posix.normalize(String(g).replace(/^\.\//, "") || ".").startsWith(".."));
    const dropped = scope.filter(g => !inRoot.includes(g));
    // The scope's files are chosen by deep-plan's own matcher (lib/verify.mjs),
    // the one that decided what the recipe covers, and handed to git as
    // literal paths: git's glob magic reads [..] as a class and has its own
    // ** rules, so the same glob would mean another set of files.
    const whole = !inRoot.length || inRoot.some(g => g === "." || g === "" || g === "./");
    const globs = inRoot.map(g => path.posix.normalize(String(g).replace(/^\.\//, "")));
    const covered = f => whole || globs.some(g => matchesGlob(f, g));
    let specs = ["."];
    if (!whole) {
      const all = git(["ls-files", "-z", "-c", "-o", "--exclude-standard"], env);
      if (all.status !== 0) return { head: head.stdout.trim(), content: "", scope, error: `git could not list files: ${(all.stderr || "").trim().split("\n")[0]}` };
      specs = [...new Set(all.stdout.split("\0").filter(f => f && covered(f)))];
    }
    const failed = why => ({ head: head.stdout.trim(), content: "", scope, error: why });
    // Literal paths, fed on stdin (no argv limit). A tracked file deleted from
    // the work tree is still listed, and add records its removal.
    if (whole) { if (git(["add", "-A"], env).status !== 0) return failed("git could not stage the work tree"); }
    else if (specs.length) {
      const add = spawnSync("git", ["--literal-pathspecs", "-C", root, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
        { encoding: "utf8", env: { ...process.env, ...env }, input: specs.join("\0") });
      if (add.status !== 0) return failed(`git could not stage the scope: ${(add.stderr || "").trim().split("\n")[0]}`);
    }
    // Only the scope's entries, into an index of their own, make the tree.
    const ls = git(["ls-files", "-s", "-z"], env);
    if (ls.status !== 0) return failed(`git could not list the scope: ${(ls.stderr || "").trim().split("\n")[0]}`);
    const entries = ls.stdout.split("\0").filter(e => e && covered(e.slice(e.indexOf("\t") + 1)));
    const ui = git(["update-index", "-z", "--index-info"], { GIT_INDEX_FILE: only }, entries.map(e => e + "\0").join(""));
    if (ui.status !== 0) return failed(`git could not index the scope: ${(ui.stderr || "").trim().split("\n")[0]}`);
    const tree = git(["write-tree"], { GIT_INDEX_FILE: only });
    if (tree.status !== 0) return failed(`git could not write the scope's tree: ${(tree.stderr || "").trim().split("\n")[0]}`);
    return { head: head.stdout.trim(), content: tree.stdout.trim(), scope,
      ...(dropped.length ? { dropped } : {}) };
  } finally {
    for (const f of [tmp, tmp + ".lock", only, only + ".lock"]) try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
  }
}


// A memo of treeOf by scope, for judging every pass of an increment (or a
// plan) against the tree now while hashing each scope once. Old passes (no
// scope) share the whole-tree entry.
export function treesAt(root) {
  const memo = new Map();
  return scope => {
    const key = scope ? JSON.stringify(scope) : "";
    if (!memo.has(key)) memo.set(key, treeOf(root, scope));
    return memo.get(key);
  };
}

// What a check's pass covers, as a scope for treeOf: the scope render stored
// with its recipe (match globs and setup files), else the plan root.
export function scopeOf(v) {
  return v && Array.isArray(v.scope) && v.scope.length ? v.scope : ["."];
}

// Paths that differ between two recorded trees (tree objects in the repo),
// at most `max`. [] when either is gone or git cannot say.
export function treeChanges(root, was, now, max = 10) {
  if (!root || !was || !now || was === now) return [];
  const r = spawnSync("git", ["-C", root, "diff", "--name-only", "--no-renames", was, now], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).slice(0, max);
}

// Each path that differs between two recorded trees with git's status letter
// (A added, M modified, D deleted, T type). [] when git cannot say.
export function treeDiff(root, was, now) {
  if (!root || !was || !now || was === now) return [];
  const r = spawnSync("git", ["-C", root, "diff", "--name-status", "--no-renames", was, now], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean).map(l => { const [status, ...p] = l.split("\t"); return { status: status[0], path: p.join("\t") }; });
}

// Does judging this increment's passes need the current tree? Only when a pass
// recorded one to compare against.
export function needsTree(inc) {
  return Object.values(checksOf(inc))
    .some(v => !v.retired && v.status === "pass" && v.tree && (v.tree.content || v.tree.error));
}

// The checks standing in the way of `done`: everything not passed, and a pass
// recorded against other content than the tree now (reported as "stale"). Without a
// tree a pass stands — status runs every few seconds and cannot afford to hash
// the working copy; `done` passes one. `tree` is either one tree (compared
// with every pass, the old way) or a treesAt() memo, which hashes each pass's
// own scope. A stale row carries the two tree hashes (`was`, `now`).
export function checksBlock(inc, tree = null) {
  const out = [];
  for (const [id, v] of Object.entries(checksOf(inc))) {
    if (v.retired) continue;
    let status = CHECK_STATUSES.includes(v.status) ? v.status : "pending";
    let was = "", now = "";
    let note = v.note || "";
    if (status === "pass") {
      was = v.tree && v.tree.content;
      // A pass whose tree git could not take proves nothing it can be held
      // to: stale, with the reason, rather than standing because "" matches nothing.
      const unverifiable = v.tree && v.tree.error;
      const t = typeof tree === "function" ? (was || unverifiable ? tree(v.tree.scope || null) : null) : tree;
      now = t && t.content;
      if (unverifiable && tree) note = `unverifiable: ${v.tree.error}`;
      else if (was && t && t.error) note = `unverifiable now: ${t.error}`;
      else if (!(was && now && was !== now)) continue;
      status = "stale";
    }
    out.push({ id, kind: v.kind || "", name: v.name || "", status, note,
      ...(v.recipe ? { recipe: v.recipe } : {}), ...(status === "stale" ? { was, now } : {}) });
  }
  return out;
}

// One word for the whole increment, for readers that predate checks (the
// pane's `obs`, the board's obsOutstanding): n/a with no checks, fail if any
// failed, pending while any has not passed, else pass.
export function checksAggregate(inc) {
  const active = Object.values(checksOf(inc)).filter(v => !v.retired);
  if (!active.length) return "n/a";
  if (active.some(v => v.status === "fail")) return "fail";
  return active.every(v => v.status === "pass") ? "pass" : "pending";
}

// progress summary in exactly the shape crew-board consumes.
export function progress(st) {
  const incs = st.increments || [];
  const done = incs.filter(i => i.status === "done");
  const blocked = incs.filter(i => i.status === "blocked")
    .map(i => ({ n: i.n, title: i.title, note: i.note || "" }));
  const open = incs.filter(i => i.status === "authorized" || i.status === "working")
    .map(i => ({ n: i.n, title: i.title }));
  const next = incs.find(i => i.status === "pending");
  return {
    total: incs.length,
    done: done.length,
    blocked,
    open,
    next: next ? { n: next.n, title: next.title } : null,
  };
}

// gate summary for the board: {allow, why}.
export function gateView(st) {
  const p = progress(st);
  if (st.gate === "open") return { allow: true, why: "gate opened by hand" };
  if (st.phase === "review") return { allow: false, why: "Alignment check not taken." };
  // Counted, never taken from the phase: a reset, a block or an amend that
  // adds an increment leaves work pending under a "done" or "delivery" phase.
  const allDone = p.total > 0 && p.done === p.total;
  // The full delivery's lookout review holds the plan open; its fixes are
  // edits like any other, so the gate stays open while it runs.
  if (st.phase === "delivery" && allDone)
    return { allow: true, why: `every increment is done; the delivery review holds the plan open — deep-plan deliver ${st.slug}` };
  if (allDone) return { allow: true, why: "every increment is done" };
  if (p.open.length > 0) return { allow: true, why: "increment authorized" };
  return { allow: false, why: "No increment is authorized — `deep-plan go` opens the next one." };
}

// realpath both sides: on macOS /tmp and /var are symlinks into /private, and
// a containment test on the spelled paths silently disarms the gate.
//
// A path that does not exist yet resolves through its nearest existing
// ancestor, however far up. Resolving only the parent left a new file in a new
// directory spelled /var/…, outside a root recorded as /private/var/…, and the
// gate let that write through as "no plan tracks this path".
//
// The native realpath: on a case-insensitive volume (macOS's default) it
// returns the case on disk, where fs.realpathSync keeps the case it was given,
// so ~/code/REPO/a.ts read as outside a root recorded as ~/code/repo.
export function canon(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...tail.reverse()); }
    catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = up;
    }
  }
}

function inside(target, root) {
  const t = canon(target);
  const r = canon(root);
  return t === r || t.startsWith(r + path.sep);
}

// Find the plan whose root contains `target`. An existing recorded root is
// authoritative; a state file whose root no longer exists gates nothing
// (fails open, deliberately — and `status` prints the root so it is visible).
// Plans whose recorded root no longer exists. The gate still fails open on
// these (a deleted worktree must not block unrelated work), but silence was
// the real defect: decide.mjs surfaces them and `status` prints BROKEN ROOT.
export function brokenRoots() {
  return allStates()
    .filter(st => st && st.root && st.phase !== "closed" && (!path.isAbsolute(st.root) || !fs.existsSync(st.root)))
    .map(st => ({ slug: st.slug, root: st.root }));
}

// A relative root is broken too: resolved against the hook's cwd, `.` would
// claim whichever worktree the agent stands in.
export function planFor(target) {
  for (const st of allStates()) {
    if (!st || !st.root) continue;
    if (!path.isAbsolute(st.root) || !fs.existsSync(st.root)) continue;
    if (st.phase === "closed") continue;
    if (inside(target, st.root)) return st;
  }
  return null;
}

// THE decision. Returns {allow, why, plan} for a write-shaped call at `target`.
// Only paths inside a tracked plan's root are ever gated.
export function mayEdit(target) {
  const st = planFor(target);
  if (!st) return { allow: true, why: "no plan tracks this path", plan: null };
  const g = gateView(st);
  return { allow: g.allow, why: g.why, plan: st };
}

// Mutating-Bash heuristic. False negatives are acceptable; false positives are
// not — blocking `grep` makes the whole thing intolerable within an hour.
const REDIRECT = /(^|[^>])>>?\s*[^&|;\s]/;  // redirect into a file (not >&2)
// curl writes a file with -o/--output (unless to /dev/null or -), -O or
// --remote-name, -D/--dump-header and -c/--cookie-jar. Read by its arguments,
// short clusters included (-sSLo f), with the options that take a value
// (-XPOST's POST is X's) stepped over.
const CURL_ARG = new Set("AbcCdDeEFHKmorQtTuUwxXyYz".split(""));
const CURL_FILE = { o: true, D: true, c: true };
function curlWrites(cmd) {
  for (const seg of cmd.split(/[;&|\n]/)) {
    const toks = seg.trim().split(/\s+/).map(t => t.replace(/^['"]|['"]$/g, ""));
    const at = toks.findIndex(t => path.basename(t) === "curl");
    if (at < 0) continue;
    const toFile = v => v !== undefined && v !== "/dev/null" && v !== "-";
    for (let i = at + 1; i < toks.length; i++) {
      const t = toks[i];
      if (t.startsWith("--")) {
        const [name, eq] = t.slice(2).split(/=(.*)/s);
        if (name === "remote-name" || name === "remote-name-all") return true;
        if (["output", "dump-header", "cookie-jar"].includes(name)) { if (toFile(eq !== undefined ? eq : toks[++i])) return true; }
        continue;
      }
      if (!/^-[a-zA-Z]/.test(t)) continue;
      for (let k = 1; k < t.length; k++) {
        const c = t[k];
        if (c === "O") return true;
        if (CURL_ARG.has(c)) {
          const v = k + 1 < t.length ? t.slice(k + 1) : toks[++i];
          if (CURL_FILE[c] && toFile(v)) return true;
          break;
        }
      }
    }
  }
  return false;
}

const MUTATORS = [
  /\bsed\s+(-[a-zA-Z]*\s+)*-i\b/,          // sed -i, sed -E -i
  /<<-?\s*['"]?\w+/,                        // heredoc
  /\btee\s+(?!-a\s*$)/,
  /\brm(\s|$|[;&|)`])/, /\bmv\s+/, /\bcp\s+/, // rm last too: `xargs rm`
  /\bfind\b[^;&|]*\s['"]?-(delete|fprint\w*|fls)\b/, // find's own writes
  // Anything that moves the work tree or the index, as checkout does: restore
  // --staged and add write the index, which is the next commit.
  /\bgit\s+(commit|checkout|reset|clean|apply|stash|merge|rebase|cherry-pick|rm|mv|restore|switch|pull|add|am|revert)\b/,
  // perl -pi -e, perl -i.bak, perl -lni: -i in a cluster of perl's argument-free
  // switches only, so -Mstrict, -MList::Util and -I lib are not it.
  /\bperl\b[^;&|\n]*?\s-[acnplsTtuUwWX]*i(\.\S*)?(\s|$)/,
  // Formatters and fixers in their writing form: --write, --fix, -w, or the
  // ones that write unless told to --check.
  /\s--(write|fix)(=\S*)?(\s|$)/,
  /\b(gofmt|goimports)\b[^;&|\n]*\s-[a-zA-Z]*w\b/,
  /\bcargo\s+fmt\b(?![^;&|\n]*\s--check\b)/,
  /(^|[;&|(\n]\s*|\b(npx|bunx|uvx|exec|xargs|poetry\s+run|python3?\s+-m)\s+)(black|rustfmt|isort)\b(?![^;&|\n]*\s--(check|diff)\b)/,
  /\bruff\s+format\b(?![^;&|\n]*\s--(check|diff)\b)/,
  // Downloads and unpacking into files.
  // -o/-O on its own or ending a short cluster (-sSLo f), never an option
  // that merely holds the letter (-XPOST).
  // -o/--output to /dev/null or - (stdout) writes no file.
  { test: s => curlWrites(s) },
  /\btar\s+(-?[a-zA-Z]*[xc][a-zA-Z]*(\s|$)|([^;&|\n]*\s)?-[a-zA-Z]*[xc][a-zA-Z]*(\s|$)|[^;&|\n]*\s--(extract|create|get)\b)/,
  /\bunzip(?![^;&|\n]*\s-[a-zA-Z]*[lptvZ]\b)\s/,
  /\brsync(?![^;&|\n]*\s(--dry-run|-[a-zA-Z]*n)\b)\s/,
  /\bdd\b[^;&|\n]*\bof=/,
  /\btouch\s+/, /\bmkdir\s+/, /\bln\s+/, /\bchmod\s+/, /\bchown\s+/, /\bchgrp\s+/,
  /\b(unlink|rmdir|shred)(\s|$)/,
  /\btruncate\s+/, /\binstall\s+/, /\bpatch\b/,
  /\bnpm\s+(install|i|uninstall|update)\b/, /\bpip3?\s+install\b/,
];
// SAFE only when the command is one plain reader with no redirect/heredoc/chain
// or second line after it — `cat <<EOF > f` must not ride on `cat` being a
// reader. It is tested on the command with its substitutions taken out.
const SAFE = [
  /^\s*(grep|rg|ag|find|ls|cat|head|tail|wc|git\s+(status|log|diff|show|branch|blame)|which|file|stat|du|df)\b[^><;&|\n]*$/,
];
// find runs or writes things with these; it is then no plain reader.
const FIND_ACTS = /\s['"]?-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/;

// Redirecting a stream to /dev/null (or fd-to-fd, 2>&1) writes nothing.
// Un-scrubbed, `lsof 2>/dev/null` reads as "redirect into a file" and the
// gate blocked four read-only commands in one session on exactly this.
const scrub = cmd => cmd.replace(/\d*>>?\s*\/dev\/null/g, " ").replace(/\d+>&\d+/g, " ");

// The command with each quoted string's contents blanked, length kept, so
// `rg "=>" src` and `jq ".a > 1" f.json` read as the arguments they are. A
// double-quoted string that runs a command (`$(`, a backtick) is kept as
// written. Null when a quote never closes, or for $'…' (its \' would fool
// this scan): the caller then reads the command as written.
export function blankQuotes(cmd) {
  if (cmd.includes("$'")) return null;
  let out = "", q = null, start = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === null) {
      if (c === "\\") { out += cmd.slice(i, i + 2); i++; }
      else if (c === "'" || c === '"') { q = c; start = i; }
      else out += c;
      continue;
    }
    if (q === '"' && c === "\\") { i++; continue; }
    if (c !== q) continue;
    const body = cmd.slice(start + 1, i);
    out += q + (q === '"' && /\$\(|`/.test(body) ? body : " ".repeat(body.length)) + q;
    q = null;
  }
  return q === null ? out : null;
}

// Where the substitution opened just before `i` closes: the index of its `)`
// (closer ")") or backtick (closer "`"), or -1 when it never does. Quotes,
// escapes and nested substitutions are stepped over, so a `)` inside them
// closes nothing.
function closeOf(cmd, i, closer) {
  let dq = false, depth = 0;
  for (; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") { i++; continue; }
    if (c === "'" && !dq) {
      i = cmd.indexOf("'", i + 1);
      if (i < 0) return -1;
      continue;
    }
    if (c === '"') { dq = !dq; continue; }
    if (c === closer && closer === "`") return i;
    if (c === "$" && cmd[i + 1] === "(") { i = closeOf(cmd, i + 2, ")"); if (i < 0) return -1; continue; }
    if (c === "`") { i = closeOf(cmd, i + 1, "`"); if (i < 0) return -1; continue; }
    if (dq || closer === "`") continue;
    if (c === "(") depth++;
    else if (c === ")" && depth-- === 0) return i;
  }
  return -1;
}

// The command split into its top level, each `$(…)` and backtick replaced by a
// space, and the bodies those ran. Null when a quote or substitution never
// closes: the command is then no plain reader.
function substitutions(cmd) {
  let outer = "", q = null;
  const inner = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { outer += c; if (c === "'") q = null; continue; }
    if (c === "\\") { outer += cmd.slice(i, i + 2); i++; continue; }
    if (c === "'" && q === null) { q = c; outer += c; continue; }
    if (c === '"') { q = q ? null : c; outer += c; continue; }
    const open = c === "`" ? 1 : c === "$" && cmd[i + 1] === "(" ? 2 : 0;
    if (!open) { outer += c; continue; }
    const end = closeOf(cmd, i + open, open === 1 ? "`" : ")");
    if (end < 0) return null;
    inner.push(cmd.slice(i + open, end));
    outer += " ";
    i = end;
  }
  return q === null ? { outer, inner } : null;
}

// One plain reader: the command passes SAFE as written (so this test only ever
// gets stricter), so does its top level with the substitutions taken out, and
// every substitution body is itself no write. Any doubt (a process
// substitution, $'…', a quote that never closes) is no reader, which only
// hands the command to the denylist below.
function plainReader(cmd) {
  if (cmd.includes("$'")) return false;
  const whole = blankQuotes(cmd);
  if (whole === null || !SAFE.some(re => re.test(whole))) return false;
  const split = substitutions(cmd);
  if (!split) return false;
  const bare = blankQuotes(split.outer);
  if (bare === null || /[<>]\(/.test(bare) || !SAFE.some(re => re.test(bare))) return false;
  if (/^\s*find\b/.test(bare) && FIND_ACTS.test(cmd)) return false;
  return split.inner.every(body => !bashMutates(body));
}

export function bashMutates(cmd) {
  if (!cmd) return false;
  if (plainReader(cmd)) return false;
  // Quotes matter only to the reader test and the redirect: every other
  // mutator still reads the command as written (`bash -c "rm -rf x"`).
  const bare = blankQuotes(cmd) ?? cmd;
  return REDIRECT.test(scrub(bare)) || MUTATORS.some(re => re.test(scrub(cmd)));
}

// The plan's own CLI in command position: `deep-plan …` by any path, node on
// deep_plan.mjs, or a script under the old skills copy.
function ownCli(seg, OWN) {
  const words = seg.trim().replace(/^(\w+=\S*\s+)*/, "").split(/\s+/);
  const prog = (/^(node|bash|sh)$/.test(words[0]) ? words[1] || "" : words[0])
    .replace(/^["']|["']$/g, "").replace(/^~(?=\/)/, os.homedir());
  return /(^|\/)(deep-plan|deep_plan\.mjs)$/.test(prog) || prog.startsWith(OWN + path.sep);
}

// The CLI's arguments are not the shell's: a note like "rm the cache > 5
// rows" must not read as a write. But the word alone was the old test, and
// `sed -i … deep-plan/x.mjs` or `git commit -m "deep-plan: x"` rode it. So
// every link of the chain must be the CLI or no write; a CLI link may not
// redirect into a file, and any command substitution reads as written.
function ownTooling(cmd, OWN) {
  const bare = blankQuotes(cmd);
  if (bare === null || /\$\(|`|[<>]\(/.test(bare)) return false;
  const links = [];
  let at = 0;
  for (const m of bare.matchAll(/&&|\|\||[;\n|]|(?<![<>&])&(?![>&])/g)) {
    links.push([cmd.slice(at, m.index), bare.slice(at, m.index)]);
    at = m.index + m[0].length;
  }
  links.push([cmd.slice(at), bare.slice(at)]);
  // Every link is the CLI, a plain `cd`, or a plain reader (`| tail -1`):
  // anything else beside it, an interpreter's one-liner included, goes
  // through the ordinary checks.
  let own = false;
  for (const [raw, b] of links) {
    if (ownCli(raw, OWN)) { own = true; if (REDIRECT.test(scrub(b))) return false; }
    else if (!/^\s*(cd(\s+[^\s;&|<>]+)?)?\s*$/.test(b) && !plainReader(raw)) return false;
  }
  return own;
}

// The command with each link that is the CLI replaced by `true` (same
// separators around it), so a note like "rm the cache > 5 rows" in its
// arguments is not read as a write while the links beside it still are. A CLI
// link that redirects into a file keeps its text: that write is the shell's.
// Null when the command cannot be split safely (a quote that never closes, a
// substitution): it is then read as written.
function cliBlanked(cmd, OWN) {
  const bare = blankQuotes(cmd);
  if (bare === null || /\$\(|`|[<>]\(/.test(bare)) return null;
  let out = "", at = 0, any = false;
  const take = (end, sepText) => {
    const raw = cmd.slice(at, end), b = bare.slice(at, end);
    if (ownCli(raw, OWN) && !REDIRECT.test(scrub(b))) { out += " true "; any = true; }
    else out += raw;
    out += sepText;
  };
  for (const m of bare.matchAll(/&&|\|\||[;\n|]|(?<![<>&])&(?![>&])/g)) { take(m.index, m[0]); at = m.index + m[0].length; }
  take(cmd.length, "");
  return any ? out : cmd;
}

// ------------------------------------------------- the human's levers
//
// The deep-plan CLI calls a Bash command makes: [{verb, words}], `words` the
// arguments after the verb, quotes stripped. The program is `deep-plan` or
// deep_plan.mjs by any path, in command position or anywhere a shell would run
// it (`xargs`, a heredoc, `bash -c "…"`, `eval '…'`). A mention inside a quoted
// argument that nothing runs (a commit message, a grep pattern) is no call.
// Heuristic, like the write test: it reads the command, it cannot run it.
const PROG_RE = /(deep-plan|deep_plan\.mjs)(?=['"]?[ \t])/g;
// A line that pipes into a shell (`| sh`, `| bash`, `| xargs`, `| eval`) runs
// what is fed to it: its heredoc body and its quoted strings are code there.
const PIPES_TO_SHELL = /\|\s*(\S*\/)?(sh|bash|zsh|dash|ksh|eval|xargs)\b/;
// Words that run the next word as a command, so a deep-plan word after them
// is still in command position (with their options, a duration, and VAR=value).
const WRAPPERS = new Set(["env", "sudo", "command", "exec", "xargs", "npx", "nohup", "time", "timeout", "nice", "eval",
  "node", "bash", "sh", "zsh", "dash"]);
const SHELLS = /^(bash|sh|zsh|dash|ksh|eval|xargs)$/;
// Shell keywords that start a command after them: `then deep-plan go`.
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "time"]);

// One forward pass over a command line, linear in its length. It tracks quote
// state (with $( … ) and backticks inside double quotes as code), comments,
// (( )) and [[ ]], and which word starts are in command position. With
// `heredocs`, it also finds real heredocs (an operator outside quotes,
// comments and (( / [[, not `<<<`) and steps over their bodies, returning
// each as {op, lineStart, start, end}; one with no terminator line is not a
// heredoc, and what follows is read as code.
//   code[i]     1 where char i is shell code (not quoted, not a comment, not arithmetic)
//   cmdPos[i]   1 at the first char of a word in command position
//   wordAt[i]   the index the word holding char i starts at, or -1
//   nextSep[i]  the first separator at or after i (or the length)
function scanShell(t, { heredocs = false } = {}) {
  const n = t.length;
  const code = new Uint8Array(n), cmdPos = new Uint8Array(n);
  const wordAt = new Int32Array(n).fill(-1), sepAt = new Uint8Array(n);
  const bodies = [];
  const stack = [];          // contexts: '"', "'", "$(", "`"
  let arith = 0, bracket = 0, w = -1;
  let canCmd = true, wrap = false, prevFlag = false, wordIsCmd = false;
  let pending = [];          // heredocs whose body starts after this line
  let lineStart = 0;
  const top = () => stack[stack.length - 1];
  const inCode = () => !stack.length || top() === "$(" || top() === "`";
  const endWord = end => {
    if (w < 0) return;
    if (wordIsCmd) {
      const word = t.slice(w, end).replace(/['"]/g, "");
      const base = word.slice(word.lastIndexOf("/") + 1);
      if (word === "[[") bracket++;
      if (KEYWORDS.has(word) && !wrap) { canCmd = true; }
      else if (WRAPPERS.has(base) || /^\w+=/.test(word)) { canCmd = true; wrap = true; prevFlag = false; }
      else if (wrap && word.startsWith("-")) { canCmd = true; prevFlag = true; }
      else if (wrap && (prevFlag || /^\d+(\.\d+)?[smhd]?$/.test(word))) { canCmd = true; prevFlag = false; }
      else { canCmd = false; wrap = false; prevFlag = false; }
    } else if (t.slice(w, end) === "]]" && bracket) bracket--;
    w = -1; wordIsCmd = false;
  };
  const separate = () => { canCmd = true; wrap = false; prevFlag = false; };
  for (let i = 0; i < n; i++) {
    const c = t[i];
    const ctx = top();
    if (ctx === "'") { if (c === "'") stack.pop(); if (w >= 0) wordAt[i] = w; continue; }
    if (ctx === '"') {
      if (w >= 0) wordAt[i] = w;
      if (c === "\\") { i++; if (i < n && w >= 0) wordAt[i] = w; continue; }
      if (c === '"') { stack.pop(); continue; }
      if (c === "$" && t[i + 1] === "(" && t[i + 2] !== "(") { stack.push("$("); i++; separate(); w = -1; continue; }
      if (c === "`") { stack.push("`"); separate(); w = -1; continue; }
      continue;
    }
    // Code context (top level, or inside $( … ) / backticks).
    if (arith) {
      if (c === ")" && t[i + 1] === ")") { arith--; i++; }
      else if (c === "(" && t[i + 1] === "(") { arith++; i++; }
      continue;
    }
    if (c === "\\") { if (w < 0) { w = i; wordIsCmd = canCmd; if (canCmd) cmdPos[i] = 1; } wordAt[i] = w; code[i] = 1; i++; if (i < n) { wordAt[i] = w; } continue; }
    if (c === "\n" || c === " " || c === "\t") {
      endWord(i);
      if (c === "\n") {
        sepAt[i] = 1; code[i] = 1; separate();
        if (pending.length && stack.length === 0) {
          // The bodies, one after another, each up to its terminator line.
          let at = i + 1, ok = true;
          for (const h of pending) {
            const re = new RegExp(`^[ \\t]*${h.tag}[ \\t]*$`, "m");
            re.lastIndex = 0;
            const m = re.exec(t.slice(at));
            if (!m) { ok = false; break; }
            const end = at + m.index;
            bodies.push({ op: h.op, lineStart: h.lineStart, start: at, end });
            const nl = t.indexOf("\n", end);
            at = nl < 0 ? n : nl + 1;
          }
          pending = [];
          if (ok) { i = at - 1; }
        }
        lineStart = i + 1;
      }
      continue;
    }
    if (c === "#" && w < 0) { const nl = t.indexOf("\n", i); i = (nl < 0 ? n : nl) - 1; continue; }
    if (c === "'" || c === '"') { if (w < 0) { w = i; wordIsCmd = canCmd; if (canCmd) cmdPos[i] = 1; } wordAt[i] = w; stack.push(c); continue; }
    if (c === "(" && t[i + 1] === "(" && w < 0 || (c === "$" && t[i + 1] === "(" && t[i + 2] === "(")) {
      endWord(i); arith++; i += c === "$" ? 2 : 1; continue;
    }
    if (c === "$" && t[i + 1] === "(") { endWord(i); stack.push("$("); i++; sepAt[i] = 1; separate(); continue; }
    if (c === "`") {
      endWord(i); sepAt[i] = 1;
      if (ctx === "`") stack.pop(); else stack.push("`");
      separate(); continue;
    }
    if (c === ")" && ctx === "$(") { endWord(i); sepAt[i] = 1; stack.pop(); canCmd = false; wrap = false; continue; }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endWord(i); sepAt[i] = 1; code[i] = 1;
      if (c === ")") { canCmd = false; wrap = false; } else separate();
      continue;
    }
    if (heredocs && c === "<" && t[i + 1] === "<" && t[i + 2] !== "<" && t[i - 1] !== "<" && !bracket && !stack.length) {
      const m = /^<<-?[ \t]*(['"]?)(\w+)\1/.exec(t.slice(i, i + 200));
      if (m) { endWord(i); pending.push({ tag: m[2], op: i, lineStart }); i += m[0].length - 1; continue; }
    }
    if (w < 0) { w = i; wordIsCmd = canCmd; if (canCmd) cmdPos[i] = 1; }
    wordAt[i] = w; code[i] = 1;
  }
  endWord(n);
  const nextSep = new Int32Array(n + 1);
  nextSep[n] = n;
  for (let i = n - 1; i >= 0; i--) nextSep[i] = sepAt[i] ? i : nextSep[i + 1];
  return { code, cmdPos, wordAt, nextSep, bodies };
}

// Heredoc bodies fed to anything but a shell (cat, tee, git, gh, grep…) are
// text, not commands: blanked, length kept, so `cat <<EOF > notes` holding
// the words "deep-plan open-gate" is no call. A shell (after any wrappers:
// `sudo bash <<EOF`), or a line piped into one, keeps its body.
function blankHeredocs(cmd) {
  if (!cmd.includes("<<")) return cmd;
  const { bodies } = scanShell(cmd, { heredocs: true });
  if (!bodies.length) return cmd;
  let out = "", at = 0;
  for (const b of bodies) {
    const lineEnd = cmd.indexOf("\n", b.op);
    const line = cmd.slice(b.lineStart, lineEnd < 0 ? cmd.length : lineEnd);
    const head = cmd.slice(b.lineStart, b.op).split(/[;&|(]/).pop().trim().split(/\s+/).filter(Boolean);
    let k = 0;
    while (k < head.length) {
      const x = head[k], base = path.basename(x);
      if (/^\w+=/.test(x) || (WRAPPERS.has(base) && !SHELLS.test(base)) || x.startsWith("-") ||
        (k && head[k - 1] === "timeout" && /^\d/.test(x))) { k++; continue; }
      break;
    }
    const first = path.basename(head[k] || "");
    if (SHELLS.test(first) || PIPES_TO_SHELL.test(line)) continue;
    out += cmd.slice(at, b.start) + cmd.slice(b.start, b.end).replace(/[^\n]/g, " ");
    at = b.end;
  }
  return out + cmd.slice(at);
}

// The bodies of quoted strings handed to a shell: the argument after a
// shell's `-c` (any short cluster ending in c) or `eval`, at a word start (after
// whitespace or ; & | ( ` and $( ). One linear pass with the quote state
// tracked by hand; a regex here backtracked exponentially on an unclosed
// quote full of escapes, and the gate runs this on every Bash call.
function shellStrings(text) {
  const out = [];
  const n = text.length;
  // Candidates found by a simple, linear regex; each is then read by hand.
  const cand = /(?:^|[\s;&|(`])(?=eval|-[a-zA-Z]*c[\s])/g;
  for (let mm; (mm = cand.exec(text));) {
    const i = mm.index + mm[0].length;
    if (cand.lastIndex === mm.index) cand.lastIndex++;
    let j = i;
    if (text.startsWith("eval", i)) j = i + 4;
    else if (text[i] === "-") {
      j = i + 1; while (j < n && /[a-zA-Z]/.test(text[j])) j++;
      if (text[j - 1] !== "c" || j === i + 1) continue;
      // Only a shell's -c runs its argument (grep -c "…" counts lines): the
      // program before this option and any others is sh, bash, zsh, dash or ksh.
      const words = text.slice(Math.max(0, i - 400), i).split(/[;&|(\n]/).pop().trim().split(/\s+/).filter(Boolean);
      while (words.length && words[words.length - 1].startsWith("-")) words.pop();
      if (!/^(sh|bash|zsh|dash|ksh)$/.test(path.basename(words.length ? words[words.length - 1] : ""))) continue;
    }
    else continue;
    let k = j;
    while (k < n && (text[k] === " " || text[k] === "\t")) k++;
    if (k === j || (text[k] !== '"' && text[k] !== "'")) continue;
    const q = text[k];
    let e = k + 1;
    while (e < n && text[e] !== q) e += (q === '"' && text[e] === "\\") ? 2 : 1;
    if (e >= n) continue;                     // never closes: nothing a shell would run
    out.push(text.slice(k + 1, e));
    cand.lastIndex = Math.max(cand.lastIndex, e + 1);
  }
  return out;
}

// Every quoted string's body in `line`, one linear pass.
function quotedStrings(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    const q = line[i];
    if (q === "\\") { i++; continue; }
    if (q !== '"' && q !== "'") continue;
    let e = i + 1;
    while (e < line.length && line[e] !== q) e += (q === '"' && line[e] === "\\") ? 2 : 1;
    if (e >= line.length) break;
    out.push(line.slice(i + 1, e));
    i = e;
  }
  return out;
}

// The scan reads at most this much of a command: a call past it is not seen,
// and nothing here may stall the gate.
const CALL_SCAN_MAX = 1 << 20;
// Past the cap nothing is read, so a tail that could hold a call or a forged
// env fails closed: the reason, or "".
export function tooLongForGate(cmd) {
  const c = String(cmd || "");
  return c.length > CALL_SCAN_MAX && /deep-plan|deep_plan|DEEP_PLAN_|CLAUDECODE|CLAUDE_CODE_SESSION_ID/.test(c.slice(CALL_SCAN_MAX - 64))
    ? "command too long for the gate to check; split it" : "";
}

export function deepPlanCalls(cmd, depth = 0) {
  const out = [];
  if (!cmd || depth > 3) return out;
  // A backslash-newline continues the line: joined first, so `deep-plan \
  // go x` is read as the one call it is.
  cmd = String(cmd).slice(0, CALL_SCAN_MAX).replace(/\\\r?\n/g, "  ");
  const text = blankHeredocs(cmd);
  const sc = scanShell(text);
  // A quoted string a shell runs (bash -c "…", eval '…') is a command line of its own.
  for (const body of shellStrings(text)) out.push(...deepPlanCalls(body, depth + 1));
  // On a line piped into a shell, every quoted string may be what it runs.
  for (const line of text.split("\n")) if (PIPES_TO_SHELL.test(line)) for (const body of quotedStrings(line)) out.push(...deepPlanCalls(body, depth + 1));
  for (const m of text.matchAll(PROG_RE)) {
    const i = m.index, after = i + m[0].length;
    if (i && !/[\s;&|(`'"/]/.test(text[i - 1])) continue;
    // The whole word (from the scan): a path to the program, or the program
    // name in quotes, at a command position.
    const w = sc.wordAt[i];
    if (w < 0 || !sc.cmdPos[w]) continue;
    let next = after;
    if (!sc.code[i]) {
      // Inside quotes: only a quoted program name ("deep-plan" go) runs here.
      const q = text[w];
      if (!(q === '"' || q === "'") || text[after] !== q) continue;
      next = after + 1;
    }
    if (!/^['"]?(\S*\/)?(deep-plan|deep_plan\.mjs)$/.test(text.slice(w, after))) continue;
    const end = Math.min(next >= text.length ? text.length : sc.nextSep[next], next + 4096);
    const words = text.slice(next, end).replace(/['"]/g, " ").trim().split(/\s+/).filter(Boolean);
    const verb = words.shift() || "";
    if (/^[a-z][a-z-]*$/.test(verb)) out.push({ verb, words });
  }
  return out;
}

// The one lever a person pulls from their own shell, the board or the plan
// pane, never a Claude Code session: lifting the gate. A Bash call from a
// session that pulls it is refused with this reason ("" when none does).
// Outside a session (no hook runs) it works as before.
// A command that would change what the CLI trusts about its caller: the
// server's mark (DEEP_PLAN_FROM_SERVE), the session's identity
// (CLAUDE_CODE_SESSION_ID / CLAUDE_SESSION_ID), or Claude Code's own CLAUDECODE
// unset or emptied (env -u, env -i, VAR=, unset). From a session, with a
// deep-plan call in it, that is how the one-per-turn record is dodged. The
// reason, or "".
export function trustOverride(cmd) {
  const c = String(cmd || "").slice(0, CALL_SCAN_MAX);
  if (/\bDEEP_PLAN_FROM_SERVE\b/.test(c)) return "sets DEEP_PLAN_FROM_SERVE, the server's own mark";
  if (/\bCLAUDE(_CODE)?_SESSION_ID\s*=|-u\s*CLAUDE(_CODE)?_SESSION_ID\b|\bunset\b[^;&|\n]*\bCLAUDE(_CODE)?_SESSION_ID\b/.test(c)) return "changes the session id";
  if (/-u\s*CLAUDECODE\b|--unset[= ]CLAUDECODE\b|\bCLAUDECODE=(?!1\b)|\bunset\b[^;&|\n]*\bCLAUDECODE\b|\benv\s+(-\S+\s+)*-i\b|\benv\s+(-\S+\s+)*--ignore-environment\b/.test(c))
    return "unsets or empties CLAUDECODE";
  return "";
}

// Human-only from a session (refused outright): what lifts the gate, or
// replaces existing state with a file the agent could have written
// (import-state --force). A plain import-state is the CLI's to refuse over
// existing state, so from a session it only brings a plan into a fresh one;
// state pull reads the plan's own branch. See DEVELOPING.md for the table.
export function humanLever(calls) {
  for (const c of calls) {
    if (c.verb === "open-gate") return "`deep-plan open-gate` lifts the gate; it is the human's lever";
    if (c.verb === "import-state" && c.words.includes("--force")) return "`deep-plan import-state --force` replaces a plan's state from a file; it is the human's to do";
  }
  return "";
}

// What an agent may run only on the human's word: a go, a --force (go, done,
// check pass, render), --by human, and close. Refused while the gate's refusal
// in this turn is unanswered (deniedThisTurn); the human's next prompt clears
// it. The reason names the first such call, "" when there is none.
// How many of a command's calls need the human's word: more than one in one
// command is refused (it would spend the turn's one several times).
export function humansWordCount(calls) {
  return calls.filter(c => onHumansWord([c])).length;
}

export function onHumansWord(calls) {
  for (const c of calls) {
    if (c.words.some((w, k) => (w === "--by" && c.words[k + 1] === "human") || w === "--by=human")) return "--by human";
    if (["go", "done", "check", "render"].includes(c.verb) && c.words.includes("--force")) return `${c.verb} --force`;
    if (c.verb === "go" || c.verb === "close") return c.verb;
  }
  return "";
}

// One small file per session under the state dir: the gate refused an edit
// in this session's current turn. The UserPromptSubmit hook (news.sh) deletes
// it when the human speaks, so "a refusal newer than the last human prompt" is
// "the file exists". A `deep-plan go` while it does is the agent answering the
// gate itself, and is refused. Session ids from the payload are uuids; any
// other shape is not used as a file name.
export const TURNS_DIR = path.join(STATE_DIR, "turns");
const turnFile = session => /^[A-Za-z0-9_-]{1,128}$/.test(session || "") ? path.join(TURNS_DIR, session + ".denied") : "";
export function markDenied(session, slug = "") {
  const f = turnFile(session);
  if (!f) return;
  try {
    fs.mkdirSync(TURNS_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: Date.now(), slug }) + "\n");
    // The session has met the gate: news.sh keeps its prompts from now on.
    fs.writeFileSync(f.replace(/\.denied$/, ".seen"), "");
  }
  catch { /* the refusal stands without it */ }
}
// Whether this turn's human prompt (its first 300 characters, kept by
// news.sh) plainly says go: then a refusal earlier in the same turn (the agent
// tried an edit before running the go it was given) does not hold the go
// back. A short prompt must be essentially an approval ("go", "go 2", "yes
// go", "lgtm"); a longer one must carry an explicit go phrase tied to the plan
// ("go next", "go 3", "go ahead", "deep-plan go"). A plain "yes", "ok" or
// "continue" in a longer prompt is not one. A negation anywhere ("don't go
// yet", "no", "wait") reads as no.
const SHORT_APPROVAL = /^(yes[,.!]?\s+|ok[,.!]?\s+|okay[,.!]?\s+)?(go(\s+ahead|\s+next|\s+\d+)?|approved?|lgtm|ship\s+it|proceed|yes|do\s+it)(\s+(please|now|thanks))?[.!]*$/i;
const GO_PHRASE = /(\bdeep-plan\s+go\b|\bgo\s+(ahead|next)\b|\bgo\s+\d+\b)/i;
const DOUBTS = /\b(don'?t|do not|not|no|never|stop|wait|hold)\b/i;
export function approvesGo(prompt) {
  // Curly and modifier apostrophes read as the straight one: "don’t" is a no.
  const p = String(prompt || "").slice(0, 300).replace(/\\"/g, '"').replace(/[\u2018\u2019\u02bc]/g, "'").toLowerCase().trim();
  if (!p || DOUBTS.test(p)) return false;
  if (p.length <= 60 && SHORT_APPROVAL.test(p)) return true;
  // A question is not a go: "should we go next?", "what does go 3 do?".
  if (/\?\s*$/.test(p)) return false;
  for (const sentence of p.match(/[^.!?\n]+[.!?]?/g) || []) {
    const m = GO_PHRASE.exec(sentence);
    if (!m) continue;
    if (/\?\s*$/.test(sentence)) continue;
    if (/\b(should|can|could|would|what|why|how|does|do|is)\b/.test(sentence.slice(0, m.index))) continue;
    return true;
  }
  return false;
}
export function promptApproves(session) {
  const f = turnFile(session);
  if (!f) return false;
  try { return approvesGo(fs.readFileSync(f.replace(/\.denied$/, ".prompt"), "utf8")); } catch { return false; }
}

// The session already ran a go (or --force, --by human, close) this turn: a
// second one waits for the human's next prompt, which deletes the marker
// (news.sh), as it does the refusal's.
const actedFile = session => { const f = turnFile(session); return f ? f.replace(/\.denied$/, ".acted") : ""; };
export function markActed(session, what) {
  const f = actedFile(session);
  if (!f) return;
  try { fs.mkdirSync(TURNS_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ at: Date.now(), what }) + "\n"); }
  catch { /* best-effort */ }
}
// A lever call in flight: the gate claims the turn's one with an atomic mkdir
// before letting it run, so parallel calls cannot all pass; the CLI turns the
// claim into `.acted` on success, or gives it back on failure.
const claimDir = session => { const f = turnFile(session); return f ? f.replace(/\.denied$/, ".claimed") : ""; };
// The claim is pending until the CLI turns it into `.acted`: one older than
// two minutes is a call that never ran (the person declined the permission
// prompt, or another hook refused it) and is taken back.
const CLAIM_TTL_MS = 120000;
export function claimLever(session) {
  const d = claimDir(session);
  if (!d) return true;
  for (let tries = 0; tries < 2; tries++) {
    try { fs.mkdirSync(TURNS_DIR, { recursive: true }); fs.mkdirSync(d); return true; }
    catch (e) {
      if (e.code !== "EEXIST") return true;
      try { if (Date.now() - fs.statSync(d).mtimeMs > CLAIM_TTL_MS) { fs.rmSync(d, { recursive: true, force: true }); continue; } }
      catch { continue; }
      return false;
    }
  }
  return false;
}
export function releaseLever(session) {
  const d = claimDir(session);
  if (d) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ }
}

export function actedThisTurn(session) {
  const f = actedFile(session);
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return f && fs.existsSync(f) ? { what: "?" } : null; }
}

export function deniedThisTurn(session) {
  const f = turnFile(session);
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return f && fs.existsSync(f) ? { at: 0 } : null; }
}

// deep-plan's own records: plan state, keys and archived specs. An agent's
// Edit or Write there is how a gate gets opened by hand-editing its JSON.
// Extension verbs (EXT_DIR) run with the state dirs in hand, so they are
// deep-plan's own too: an agent's file there would be a verb that writes state.
export function ownRecords(target) {
  return [STATE_DIR, KEYS_DIR, EXT_DIR].some(d => inside(target, d));
}

// The same for Bash: a command that writes (the write test, or an interpreter
// that can: python, node, ruby, perl) and names the state or keys dir, in any
// spelling an agent would type (as set, resolved, ~/…, $HOME/…), or that runs
// from inside one. Reading them with a plain reader (cat, jq, grep) still
// passes; an interpreter (python, node, ruby, perl, deno, bun) naming them is
// treated as a write whatever its script does, since its text cannot say.
const INTERP = /(^|[\s;&|(`])(python3?|node|ruby|perl|deno|bun)\b/;
//
// Where the command runs counts too: the payload's cwd, and each `cd X` in it
// (resolved in order, ~ expanded), so `cd ~/.claude/deep-plan/state && rm x`
// is caught. A path built at run time ($(…), variables, a script's own logic)
// stays out of reach of a text test, as every other Bash rule here does.
export function bashTouchesRecords(cmd, cwd) {
  if (!cmd) return false;
  const writes = () => bashMutates(cmd) || INTERP.test(cmd);
  if (cwd && ownRecords(cwd) && writes()) return true;
  let at = cwd || process.cwd();
  for (const m of cmd.matchAll(/(?:^|[;&|(]\s*)cd\s+(['"]?)([^\s;&|'"()]+)\1/g)) {
    const to = m[2].replace(/^~(?=\/|$)/, os.homedir()).replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir());
    if (to === "-" || /[$`*?]/.test(to)) continue;
    at = path.resolve(at, to);
    if (ownRecords(at) && writes()) return true;
  }
  const home = os.homedir();
  const names = new Set();
  for (const d of [STATE_DIR, KEYS_DIR, EXT_DIR]) for (const p of [d, canon(d)]) {
    names.add(p);
    if (p.startsWith(home + path.sep)) { const rest = p.slice(home.length); names.add("~" + rest); names.add("$HOME" + rest); names.add("${HOME}" + rest); }
  }
  if ([...names].some(n => cmd.includes(n)) && writes()) return true;
  // A write aimed at a directory holding them (rm -rf ~/.claude/deep-plan,
  // mv ~/.claude x, or `rm -rf deep-plan` after a cd into ~/.claude). Only
  // ancestors at or below the data root (or a dir's own parent, for an
  // override) count, so a write at the repo root or $HOME is not caught up in it.
  const dirs = [STATE_DIR, KEYS_DIR, EXT_DIR].flatMap(d => [d, canon(d)]);
  const floor = [DATA_ROOT, canon(DATA_ROOT), ...dirs.map(d => path.dirname(d))];
  const holds = p => dirs.some(d => d.startsWith(p + path.sep)) &&
    floor.some(f => p === f || p.startsWith(f + path.sep));
  if (!writes()) return false;
  const within = p => dirs.some(d => p === d || p.startsWith(d + path.sep));
  for (const tok of cmd.slice(0, 1 << 20).split(/[\s;&|()<>'"=]+/)) {
    if (!tok || tok.startsWith("-") || /[$`*?]/.test(tok.replace(/^\$\{?HOME\}?(?=\/|$)/, ""))) continue;
    const p = path.resolve(at, tok.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home)).replace(/\/+$/, "") || "/";
    if (holds(p) || within(p)) return true;
  }
  return false;
}

// Where a bash command "lands": its cwd. We gate bash by cwd, not by parsing
// paths out of the command — conservative in the false-negative direction.
export function decideToolCall(toolName, input, cwd) {
  const OWN = path.join(os.homedir(), ".claude", "skills", "deep-plan");
  if (toolName === "Bash") {
    const cmd = (input && input.command) || "";
    // The CLI's own links are taken out (their arguments are the CLI's, not
    // the shell's), and the write and records tests read what is left.
    const scan = cliBlanked(cmd, OWN) ?? cmd;
    if (bashTouchesRecords(scan, cwd))
      return { allow: false, records: true, plan: null,
        why: "this command writes into deep-plan's own state; it changes only through the deep-plan CLI, the board or the plan pane." };
    if (ownTooling(cmd, OWN)) return { allow: true, why: "the plan's own tooling" };
    if (!bashMutates(scan)) return { allow: true, why: "not a write" };
    return mayEdit(cwd || process.cwd());
  }
  // Edit | Write | MultiEdit | NotebookEdit
  const target = (input && (input.file_path || input.notebook_path)) || "";
  if (!target) return { allow: true, why: "no target path" };
  if (ownRecords(target))
    return { allow: false, records: true, plan: null,
      why: `${target} is deep-plan's own state; it changes only through the deep-plan CLI, the board or the plan pane.` };
  if (inside(target, OWN)) return { allow: true, why: "the plan's own tooling" };
  return mayEdit(target);
}
