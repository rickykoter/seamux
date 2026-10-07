// deep-plan state: one small JSON file per plan, plus the single decision
// function ("may this call edit this path") shared by the CLI and the gate.
//
// Env overrides exist for the probe, and only for the probe:
//   DEEP_PLAN_STATE_DIR  DEEP_PLAN_KEYS_DIR  DEEP_PLAN_PLANS_DIR
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const STATE_DIR = process.env.DEEP_PLAN_STATE_DIR ||
  path.join(os.homedir(), ".claude", "deep-plan", "state");
export const KEYS_DIR = process.env.DEEP_PLAN_KEYS_DIR ||
  path.join(os.homedir(), ".claude", "deep-plan", "keys");
export const PLANS_DIR = process.env.DEEP_PLAN_PLANS_DIR ||
  path.join(os.homedir(), ".claude", "plans");

export function statePath(slug) { return path.join(STATE_DIR, slug + ".json"); }

export function readState(slug) {
  try { return JSON.parse(fs.readFileSync(statePath(slug), "utf8")); }
  catch { return null; }
}

// Single-writer lock: mkdir is atomic on every filesystem we care about, and
// the two writers (the CLI and the gate hook's flip-to-working) can race.
// A holder that died leaves a stale dir; anything older than 5s is reclaimed.
// On sustained contention we proceed unlocked — a lost log line beats a
// deadlocked gate.
function acquireLock(slug) {
  const dir = path.join(STATE_DIR, ".lock-" + slug);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try { fs.mkdirSync(dir, { recursive: false }); return dir; }
    catch {
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 5000) { fs.rmdirSync(dir); continue; }
      } catch { continue; }
      const until = Date.now() + 10;
      while (Date.now() < until) { /* spin: hold times are single-digit ms */ }
    }
  }
  return null;
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
// as it was rather than clearing it.
export function stampOwner(st, now = Date.now()) {
  const session = sessionId();
  if (!session) return st;
  st.owner = { session, workspace: process.env.CMUX_WORKSPACE_ID || "", at: now };
  st.session = session;
  return st;
}

// Atomic: the gate reads this on every tool call, and a half-written JSON
// reads as "no plan" — exactly the wrong default for a gate.
export function writeState(st) {
  stampOwner(st);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = acquireLock(st.slug);
  try {
    const p = statePath(st.slug);
    const tmp = p + ".tmp." + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
    fs.renameSync(tmp, p);
  } finally {
    if (lock) { try { fs.rmdirSync(lock); } catch { /* already reclaimed */ } }
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
export const CHECK_KINDS = ["test", "e2e", "observability", "manual"];
export const CHECK_STATUSES = ["pending", "running", "needs-variant", "pass", "fail"];
// What a verdict is, as opposed to what the spec says the check is. Only these
// survive a re-render; the description is always the spec's current one.
const VERDICT_FIELDS = ["status", "at", "note", "by", "ran", "tree"];
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
    const name = String(c.name || c.system || c.recipe || c.run || "").trim();
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
      const { ran, tree, by, ...rest } = verdict;
      verdict = { ...rest, status: "pending", at: 0,
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
export function treeOf(root) {
  if (!root) return null;
  const git = (args, env) => spawnSync("git", ["-C", root, ...args],
    { encoding: "utf8", env: { ...process.env, ...env } });
  const head = git(["rev-parse", "HEAD"]);
  if (head.status !== 0) return null;
  const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).stdout.trim();
  const tmp = path.join(os.tmpdir(), `deep-plan-index-${process.pid}-${Date.now()}`);
  try {
    // Seeded from the real index so `add` only rehashes what changed.
    try { fs.copyFileSync(index, tmp); } catch { /* no index yet: add builds one */ }
    const env = { GIT_INDEX_FILE: tmp };
    const tree = git(["add", "-A"], env).status === 0 ? git(["write-tree"], env) : null;
    return { head: head.stdout.trim(), content: tree && tree.status === 0 ? tree.stdout.trim() : "" };
  } finally {
    for (const f of [tmp, tmp + ".lock"]) try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
  }
}

// Does judging this increment's passes need the current tree? Only when a pass
// recorded one to compare against.
export function needsTree(inc) {
  return Object.values(checksOf(inc))
    .some(v => !v.retired && v.status === "pass" && v.tree && v.tree.content);
}

// The checks standing in the way of `done`: everything not passed, and a pass
// recorded against other content than `tree` (reported as "stale"). Without a
// tree a pass stands — status runs every few seconds and cannot afford to hash
// the working copy; `done` passes one.
export function checksBlock(inc, tree = null) {
  const out = [];
  for (const [id, v] of Object.entries(checksOf(inc))) {
    if (v.retired) continue;
    let status = CHECK_STATUSES.includes(v.status) ? v.status : "pending";
    if (status === "pass") {
      const was = v.tree && v.tree.content, now = tree && tree.content;
      if (!(was && now && was !== now)) continue;
      status = "stale";
    }
    out.push({ id, kind: v.kind || "", name: v.name || "", status, note: v.note || "" });
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
  if (st.phase === "done" || (p.total > 0 && p.done === p.total))
    return { allow: true, why: "every increment is done" };
  if (p.open.length > 0) return { allow: true, why: "increment authorized" };
  return { allow: false, why: "No increment is authorized — `deep-plan go` opens the next one." };
}

// realpath both sides: on macOS /tmp and /var are symlinks into /private, and
// a containment test on the spelled paths silently disarms the gate.
function canon(p) {
  try { return fs.realpathSync(p); }
  catch {
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); }
    catch { return path.resolve(p); }
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
    .filter(st => st && st.root && st.phase !== "closed" && !fs.existsSync(st.root))
    .map(st => ({ slug: st.slug, root: st.root }));
}

export function planFor(target) {
  for (const st of allStates()) {
    if (!st || !st.root) continue;
    if (!fs.existsSync(st.root)) continue;
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
const MUTATORS = [
  /\bsed\s+(-[a-zA-Z]*\s+)*-i\b/,          // sed -i, sed -E -i
  /(^|[^>])>>?\s*[^&|;\s]/,                // redirect into a file (not >&2)
  /<<-?\s*['"]?\w+/,                        // heredoc
  /\btee\s+(?!-a\s*$)/,
  /\brm\s+/, /\bmv\s+/, /\bcp\s+/,
  /\bgit\s+(commit|checkout|reset|clean|apply|stash|merge|rebase|cherry-pick|rm|mv)\b/,
  /\btouch\s+/, /\bmkdir\s+/, /\bln\s+/, /\bchmod\s+/, /\bchown\s+/,
  /\btruncate\s+/, /\binstall\s+/, /\bpatch\b/,
  /\bnpm\s+(install|i|uninstall|update)\b/, /\bpip3?\s+install\b/,
];
// SAFE only when the command is one plain reader with no redirect/heredoc/chain
// after it — `cat <<EOF > f` must not ride on `cat` being a reader.
const SAFE = [
  /^\s*(grep|rg|ag|find|ls|cat|head|tail|wc|git\s+(status|log|diff|show|branch|blame)|which|file|stat|du|df)\b[^><;&|]*$/,
];

export function bashMutates(cmd) {
  if (!cmd) return false;
  if (SAFE.some(re => re.test(cmd))) return false;
  // Redirecting a stream to /dev/null (or fd-to-fd, 2>&1) writes nothing.
  // Un-scrubbed, `lsof 2>/dev/null` reads as "redirect into a file" and the
  // gate blocked four read-only commands in one session on exactly this.
  const scrubbed = cmd.replace(/\d*>>?\s*\/dev\/null/g, " ").replace(/\d+>&\d+/g, " ");
  return MUTATORS.some(re => re.test(scrubbed));
}

// Where a bash command "lands": its cwd. We gate bash by cwd, not by parsing
// paths out of the command — conservative in the false-negative direction.
export function decideToolCall(toolName, input, cwd) {
  const OWN = path.join(os.homedir(), ".claude", "skills", "deep-plan");
  if (toolName === "Bash") {
    const cmd = (input && input.command) || "";
    if (cmd.includes(OWN) || /\bdeep-plan\b/.test(cmd))
      return { allow: true, why: "the plan's own tooling" };
    if (!bashMutates(cmd)) return { allow: true, why: "not a write" };
    return mayEdit(cwd || process.cwd());
  }
  // Edit | Write | MultiEdit | NotebookEdit
  const target = (input && (input.file_path || input.notebook_path)) || "";
  if (!target) return { allow: true, why: "no target path" };
  if (inside(target, OWN)) return { allow: true, why: "the plan's own tooling" };
  return mayEdit(target);
}
