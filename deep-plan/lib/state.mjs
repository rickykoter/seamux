// deep-plan state: one small JSON file per plan, plus the single decision
// function ("may this call edit this path") shared by the CLI and the gate.
//
// Env overrides exist for the probe, and only for the probe:
//   DEEP_PLAN_STATE_DIR  DEEP_PLAN_KEYS_DIR  DEEP_PLAN_PLANS_DIR
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Atomic: the gate reads this on every tool call, and a half-written JSON
// reads as "no plan" — exactly the wrong default for a gate.
export function writeState(st) {
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
