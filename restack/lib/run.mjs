// Running things: resolutions, regen recipes, and the checks that mirror CI.
//
// EVERYTHING HERE IS SUMMARISED BEFORE IT IS RETURNED. The caller is usually
// an agent, and a generator that prints 4,000 lines of progress costs real
// money to hand back verbatim. So a command returns its exit code, its
// duration and the LAST twenty lines, and the full log goes to a file whose
// path is in the result. Twenty lines is where the error message lives;
// anything that needs more than that is a human opening the log.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, sideFlag, sideStage } from "./git.mjs";

export const TAIL_LINES = 20;

export function tail(s, n = TAIL_LINES) {
  const lines = String(s || "").replace(/\s+$/, "").split("\n");
  return lines.length <= n ? lines.join("\n")
    : `… ${lines.length - n} earlier lines\n` + lines.slice(-n).join("\n");
}

export function logDir() {
  const d = process.env.RESTACK_LOG_DIR ||
    path.join(os.tmpdir(), "seamux-restack-logs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// One shell command, with a timeout that is a refusal rather than a hang.
// `sh -c` on purpose: these come from the repo's config and are written as
// shell (pipes, docker compose, bundle exec). See the trust note in config.mjs.
export function sh(cwd, command, opts = {}) {
  const started = Date.now();
  if (opts.dryRun) return { command, skipped: true, ok: true, code: 0, ms: 0, out: "", log: null };
  const r = spawnSync("sh", ["-c", command], {
    cwd, encoding: "utf8", timeout: (opts.timeout || 900) * 1000,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...(opts.env || {}) },
  });
  const full = (r.stdout || "") + (r.stderr || "");
  const file = path.join(logDir(),
    `${(opts.label || "cmd").replace(/[^a-z0-9._-]/gi, "-")}-${Date.now()}.log`);
  try { fs.writeFileSync(file, `$ ${command}\n\n${full}`); } catch { /* a log we cannot write is not a failure */ }
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  return {
    command, skipped: false,
    ok: !timedOut && r.status === 0,
    code: r.status === null ? -1 : r.status,
    timedOut: !!timedOut,
    ms: Date.now() - started,
    out: timedOut ? `timed out after ${opts.timeout || 900}s\n` + tail(full) : tail(full),
    log: file,
  };
}

// ------------------------------------------------------------ resolutions
//
// `side` is asked for by MEANING ("base", "branch") and translated by git.mjs
// against the operation actually in progress. No call site in this file writes
// `--ours`.
function takeSide(cwd, op, p, side) {
  const flag = sideFlag(op, side);
  const co = git(cwd, ["checkout", flag, "--", p]);
  if (!co.ok) return { path: p, action: `take-${side}`, ok: false, why: co.err };
  const add = git(cwd, ["add", "--", p]);
  return { path: p, action: `take-${side}`, ok: add.ok, why: add.ok ? "" : add.err };
}

// Union: keep both sides' added lines. Only ever right for a file that is a
// SET — a generated list of exports, a fixture index. It is wrong for anything
// with ordering or a header (a Rails schema's version line, a lockfile's
// resolution graph), which is why it is never a default.
function unionMerge(cwd, op, p) {
  const stage = n => {
    const r = git(cwd, ["show", `:${n}:${p}`]);
    return r.ok ? r.out + "\n" : null;
  };
  const ancestor = stage(1), ours = stage(sideStage(op, "base")), theirs = stage(sideStage(op, "branch"));
  if (ours === null || theirs === null)
    return { path: p, action: "union", ok: false, why: "one side of the conflict is missing (add/delete, not a text conflict)" };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restack-union-"));
  const f = (n, c) => { const q = path.join(tmp, n); fs.writeFileSync(q, c); return q; };
  const a = f("ours", ours), b = f("base", ancestor ?? ""), c = f("theirs", theirs);
  const m = spawnSync("git", ["merge-file", "-p", "--union", a, b, c], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (m.status === null) return { path: p, action: "union", ok: false, why: "git merge-file did not run" };
  fs.writeFileSync(path.join(cwd, p), m.stdout);
  fs.rmSync(tmp, { recursive: true, force: true });
  const add = git(cwd, ["add", "--", p]);
  return { path: p, action: "union", ok: add.ok, why: add.ok ? "" : add.err };
}

// Resolve every conflicted path belonging to ONE artifact. Returns what it
// did, and whether the artifact still needs its generator run.
//
// `regen` resolves to the BASE copy first and regenerates on top. Taking the
// branch copy and regenerating would work too when the generator is total,
// but it is not the same when the generator only rewrites part of the file:
// starting from the base leaves master's new content in place and re-derives
// yours, which is the direction that cannot lose someone else's change.
export function resolveArtifact(cwd, op, artifact, paths, opts = {}) {
  const actions = [];
  let needsRegen = false;
  for (const p of paths) {
    switch (artifact.resolve) {
      case "take-base":   actions.push(takeSide(cwd, op, p, "base")); break;
      case "take-branch": actions.push(takeSide(cwd, op, p, "branch")); break;
      case "union":       actions.push(unionMerge(cwd, op, p)); break;
      case "regen":       actions.push(takeSide(cwd, op, p, "base")); needsRegen = true; break;
      case "manual":      actions.push({ path: p, action: "manual", ok: false, why: "config says a human resolves this one" }); break;
      default:            actions.push({ path: p, action: artifact.resolve, ok: false, why: "unknown resolve policy" });
    }
  }
  return { artifact: artifact.name, actions, needsRegen, ok: actions.every(a => a.ok) };
}

// ------------------------------------------------------------ regen
//
// The tier is the whole reason this is not just "run the command". A buf
// generate is seconds and can run inside a stopped rebase; a migrate-and-dump
// wants a database and several minutes, and running it five times while
// walking a five-branch stack is how a restack becomes an afternoon. So
// expensive recipes run only when asked (`--deep`), and when they do not run
// the artifact is recorded stale with the command that fixes it.
export function regen(cwd, artifact, opts = {}) {
  if (!artifact.regen)
    return { artifact: artifact.name, ran: false, ok: false, why: "no regen command configured" };
  if (artifact.tier === "expensive" && !opts.deep)
    return { artifact: artifact.name, ran: false, ok: false, deferred: true,
             why: "expensive tier — run with --deep, or run the command yourself", command: artifact.regen };
  const r = sh(cwd, artifact.regen, { ...opts, label: `regen-${artifact.name}` });
  const changed = stagePaths(cwd, artifact.paths, opts);
  return { artifact: artifact.name, ran: true, ok: r.ok, command: artifact.regen,
           ms: r.ms, out: r.out, log: r.log, changed };
}

// Stage whatever the generator rewrote, within the artifact's own paths only:
// a recipe that also touches your source files should not have those swept
// into the commit by us.
function stagePaths(cwd, globs, opts = {}) {
  if (opts.dryRun) return [];
  const before = git(cwd, ["diff", "--name-only", "-z", "--", ...globs]).out.split("\0").filter(Boolean);
  git(cwd, ["add", "--", ...globs]);
  return before;
}

// Is this artifact clean against what is committed? The local mirror of the
// CI step that regenerates and asserts no diff.
export function verifyClean(cwd, artifact, opts = {}) {
  const res = { artifact: artifact.name, checked: false, clean: null, dirty: [], regen: null };
  if (artifact.regen && !(artifact.tier === "expensive" && !opts.deep)) {
    res.regen = sh(cwd, artifact.regen, { ...opts, label: `verify-${artifact.name}` });
    if (!res.regen.ok && !res.regen.skipped) return { ...res, error: "the regen command failed" };
  } else if (artifact.regen) {
    return { ...res, deferred: true, command: artifact.regen,
             error: "expensive tier — not run; pass --deep to prove it here" };
  }
  // Against HEAD, not against the index: a regenerated file that someone
  // already `git add`-ed is still a difference from what is committed, and
  // committed content is what CI regenerates and compares.
  const d = git(cwd, ["diff", "HEAD", "--name-only", "-z", "--", ...artifact.paths]);
  res.checked = true;
  res.dirty = d.out.split("\0").filter(Boolean);
  res.clean = res.dirty.length === 0;
  return res;
}

// ------------------------------------------------------------ checks
export function runCheck(cwd, check, opts = {}) {
  if (check.tier === "expensive" && !opts.deep)
    return { name: check.name, ran: false, deferred: true, command: check.run,
             why: "expensive tier — run with --deep" };
  const r = sh(cwd, check.run, { ...opts, label: `check-${check.name}` });
  return { name: check.name, ran: true, ok: r.ok, code: r.code, ms: r.ms,
           command: check.run, out: r.ok ? "" : r.out, log: r.log, timedOut: r.timedOut };
}
