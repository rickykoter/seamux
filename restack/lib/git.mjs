// git primitives for restack — every one of them returns data, never prose.
//
// THE FOOTGUN THIS FILE EXISTS FOR. During a rebase, `--ours` is the side you
// are replaying ONTO (the new base: master) and `--theirs` is your own commit.
// During a merge it is the other way round. Every hand-resolution of a
// generated file that "took ours" and shipped master's stale artifact — or
// took the branch's and buried master's new columns — is this inversion. So
// the engine never writes `--ours` at a call site: it asks `sideFlag(op,
// "base")` and the op is read off the repo, not assumed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(cwd, args, opts = {}) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts,
  });
  return {
    status: r.status === null ? 1 : r.status,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    ok: r.status === 0,
  };
}
// The throwing flavour, for the handful of reads whose failure means the
// caller was handed something that is not a repo.
export function gitx(cwd, args) {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err || "failed"}`);
  return r.out;
}

export function repoRoot(cwd) {
  const r = git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out : null;
}
// Worktree-specific on purpose: `.git/worktrees/<name>` for a linked worktree,
// so two worktrees of the same repo restack independently and neither can read
// the other's half-finished state.
export function gitDir(cwd) {
  const r = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  return r.ok ? r.out : null;
}

export function currentBranch(cwd) {
  const r = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.ok ? r.out : null;   // null = detached, which mid-rebase is normal
}

export function isDirty(cwd) {
  const r = git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return r.ok && r.out.length > 0;
}

// Which operation is stopped in this worktree. Read off the repo rather than
// remembered from our own state file: a human who ran `git rebase` by hand
// before calling us is the common case, not the exotic one.
export function operation(cwd) {
  const d = gitDir(cwd);
  if (!d) return null;
  if (fs.existsSync(path.join(d, "rebase-merge")) ||
      fs.existsSync(path.join(d, "rebase-apply"))) return "rebase";
  if (fs.existsSync(path.join(d, "MERGE_HEAD"))) return "merge";
  if (fs.existsSync(path.join(d, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  return null;
}

// base = the branch you are landing on (master); branch = the work being
// replayed. Rebase and cherry-pick invert what merge does.
export function sideFlag(op, side) {
  if (side !== "base" && side !== "branch") throw new Error("side must be base|branch");
  const inverted = op === "rebase" || op === "cherry-pick";
  if (side === "base") return inverted ? "--ours" : "--theirs";
  return inverted ? "--theirs" : "--ours";
}
// Same mapping in index-stage numbers, for reading a side without touching the
// worktree (`git show :2:path`). Stage 2 is "ours", stage 3 is "theirs".
export function sideStage(op, side) {
  return sideFlag(op, side) === "--ours" ? 2 : 3;
}

export function conflictedPaths(cwd) {
  const r = git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (!r.ok) return [];
  return r.out.split("\0").filter(Boolean);
}

// Where a stopped rebase is: which commit of how many, and its subject. Read
// from the rebase state files because `git status` prose changes between
// versions and we hand this to an agent as data.
export function rebaseProgress(cwd) {
  const d = gitDir(cwd);
  if (!d) return null;
  const dir = ["rebase-merge", "rebase-apply"]
    .map(n => path.join(d, n)).find(p => fs.existsSync(p));
  if (!dir) return null;
  const read = n => { try { return fs.readFileSync(path.join(dir, n), "utf8").trim(); } catch { return ""; } };
  const sha = read("stopped-sha") || read("original-commit") || "";
  // msgnum/end count `exec` lines too, and a walk that regenerates on replay
  // adds one after every pick: count the commits, which is what "3/4" means.
  const commits = n => read(n).split("\n").filter(l => l && !l.startsWith("#") && !/^(exec|x)\s/.test(l)).length;
  const viaTodo = fs.existsSync(path.join(dir, "done"));
  return {
    at: (viaTodo ? commits("done") : Number(read("msgnum"))) || null,
    of: (viaTodo ? commits("done") + commits("git-rebase-todo") : Number(read("end"))) || null,
    onto: read("onto") || "",
    branch: (read("head-name") || "").replace(/^refs\/heads\//, ""),
    sha,
    subject: sha ? git(cwd, ["log", "-1", "--format=%s", sha]).out : "",
  };
}

// The `exec` command a rebase just stopped on, or null when it stopped on
// anything else (a conflicted pick, an empty commit). The last line of `done`
// is the most recent todo command run, and a failing exec is the only way an
// exec line is last while the rebase is still in progress.
export function stoppedExec(cwd) {
  const d = gitDir(cwd);
  if (!d) return null;
  let done = "";
  try { done = fs.readFileSync(path.join(d, "rebase-merge", "done"), "utf8"); } catch { return null; }
  const last = done.trim().split("\n").pop() || "";
  const m = last.match(/^(?:exec|x) (.*)$/);
  return m ? m[1] : null;
}

export function revParse(cwd, ref) {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"]);
  return r.ok && r.out ? r.out : null;
}

export function mergeBase(cwd, a, b) {
  const r = git(cwd, ["merge-base", a, b]);
  return r.ok ? r.out : null;
}

export function isAncestor(cwd, a, b) {
  return git(cwd, ["merge-base", "--is-ancestor", a, b]).status === 0;
}

export function countRange(cwd, range) {
  const r = git(cwd, ["rev-list", "--count", range]);
  return r.ok ? Number(r.out) : null;
}

// Paths touched between two revs. Used twice, for the two halves of drift:
// what YOUR branch changed, and what the base moved under you.
export function changedPaths(cwd, from, to) {
  const r = git(cwd, ["diff", "--name-only", "-z", from, to]);
  if (!r.ok) return [];
  return r.out.split("\0").filter(Boolean);
}

export function localBranches(cwd) {
  const r = git(cwd, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"]);
  if (!r.ok) return [];
  return r.out.split("\n").filter(Boolean).map(l => {
    const [name, sha] = l.split("\t");
    return { name, sha };
  });
}

// origin/HEAD when the clone knows it, else the remote's advertised default,
// else nothing — a guessed default branch is how a stack gets rebased onto the
// wrong thing, so an unknown one is reported, never assumed.
export function defaultBase(cwd, remote) {
  const sym = git(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (sym.ok && sym.out) return sym.out;
  for (const n of ["main", "master"]) {
    if (revParse(cwd, `${remote}/${n}`)) return `${remote}/${n}`;
  }
  return null;
}
