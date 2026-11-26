// A family child stacked on its parent's branch: the child's branch carries
// parent commits that are not in the base yet. Policy merges squash, so once
// the parent lands its commits are in the base under a new sha, and the
// child must drop its copies with `git rebase --onto <base> <fork point>`.
// The child restacks itself (its ship verdict and its family news say how);
// nothing here acts on any worktree. Every git call is read-only.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PLANS_DIR } from "./state.mjs";

const git = (root, args, input) => spawnSync("git", ["-C", root, ...args],
  { encoding: "utf8", timeout: 20000, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
const out = r => (r.status === 0 ? (r.stdout || "").trim() : "");

// The commit and branch checked out at root: {head, branch}, branch "" when
// detached; null when root is gone or not a repo.
export function headAt(root) {
  if (!root || !fs.existsSync(root)) return null;
  const head = out(git(root, ["rev-parse", "HEAD"]));
  if (!head) return null;
  const b = out(git(root, ["rev-parse", "--abbrev-ref", "HEAD"]));
  return { head, branch: b && b !== "HEAD" ? b : "" };
}

// Where root's HEAD meets the parent's head (the fork point X), and whether
// the branch is stacked: X is not in the base, so the branch carries parent
// commits the base does not have. Null when either side cannot be read; a
// base that cannot be read reads as not stacked (nothing to measure against).
export function forkOf(root, parentHead, base) {
  if (!root || !parentHead || !fs.existsSync(root)) return null;
  const fork = out(git(root, ["merge-base", "HEAD", parentHead]));
  if (!fork) return null;
  if (!base || git(root, ["rev-parse", "--verify", "--quiet", base]).status !== 0) return { fork, stacked: false };
  return { fork, stacked: git(root, ["merge-base", "--is-ancestor", fork, base]).status !== 0 };
}

// The restack, said the same way by ship and the news. Each conflicting hunk
// is resolved by hand (lesson L13): taking one side's whole file drops the
// other side's edits.
export function restackLine(base, fork) {
  return `git fetch origin && git rebase --onto ${base} ${fork.slice(0, 12)}, resolving each conflicting hunk by hand ` +
    `(never git checkout --ours or --theirs on a file both sides changed)`;
}

// The commit on the base whose patch is the parent's whole branch squashed,
// or "": how the news tells, from local refs alone, that the parent landed.
// A squash that differs (main changed the same lines first) is not found;
// the child's ship verdict asks GitHub and still catches it.
// The news calls it at every prompt while a child is stacked, so it reads
// file names first: only a commit touching exactly the parent's files is a
// candidate, and only candidates are diffed (none, until the parent lands).
export function squashOf(root, parentHead, base, { limit = 50 } = {}) {
  const p0 = out(git(root, ["merge-base", parentHead, base]));
  if (!p0) return "";
  const files = out(git(root, ["diff", "--name-only", p0, parentHead])).split("\n").filter(Boolean).sort().join("\n");
  if (!files) return "";
  const log = git(root, ["log", "--first-parent", "--no-merges", "--format=%x00%H", "--name-only", "-n", String(limit), `${p0}..${base}`]);
  if (log.status !== 0) return "";
  const cands = log.stdout.split("\0").filter(Boolean).map(c => c.split("\n").filter(Boolean))
    .filter(([, ...fs]) => fs.sort().join("\n") === files).map(([sha]) => sha);
  if (!cands.length) return "";
  const pid = text => (out(git(root, ["patch-id", "--stable"], text)).split(/\s+/)[0] || "");
  const want = pid(out(git(root, ["diff", p0, parentHead])) + "\n");
  if (!want) return "";
  return cands.find(sha => pid(out(git(root, ["show", "--format=", sha])) + "\n") === want) || "";
}

// The parent's tip, as {head, branch}: the ref of the branch the family index
// recorded at render, which the shared repo keeps whatever the parent's
// worktree has checked out since (main after the merge, a hotfix branch).
// Only an index from before that field falls back to the worktree's HEAD,
// and only while it is on a branch other than the base. Null when the
// recorded branch is gone (deleted) or the parent has none of its own.
export function parentTip(parent, root, base) {
  const baseBranch = String(base || "").replace(/^origin\//, "");
  const b = parent.branch;
  if (b === undefined) {
    const here = headAt(parent.root);
    return here && here.branch && here.branch !== baseBranch ? here : null;
  }
  if (!b || b === baseBranch || !root || !fs.existsSync(root)) return null;
  const head = out(git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`]));
  return head ? { head, branch: b } : null;
}

// The plan's ship record (deep-plan ship writes it), or null.
export function shipRecord(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(PLANS_DIR, `${slug}.ship.json`), "utf8")); } catch { return null; }
}
