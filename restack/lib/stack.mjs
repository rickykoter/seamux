// Which branches are in this stack, in the order they have to be replayed.
//
// THREE SOURCES, IN THIS ORDER, AND THE TOOL SAYS WHICH ONE ANSWERED.
//
//   config    `stack.branches` — an explicit list wins over every inference.
//   graphite  `gt` is installed and this repo has graphite metadata. Then gt
//             OWNS the stack: we do not re-derive its parents and we do not
//             drive the rebase ourselves, we let `gt restack` stop on each
//             conflict and do our resolving in between. Two tools writing the
//             same refs is how a stack ends up half-restacked.
//   gh        one `gh pr list` call maps head -> base for every open PR, which
//             is the only source that knows the intended parent of a branch
//             whose commits have already been squashed under it.
//   topology  local branches that are ancestors of HEAD and not ancestors of
//             the base, ordered by distance from the base. Always available,
//             and wrong exactly when a stacked branch has no local ref.
//
// Reporting the source matters more than being clever: "topology" next to a
// two-branch chain is how you notice that the third branch of your stack is
// not checked out locally, before a rebase silently leaves it behind.
import { revParse, mergeBase, isAncestor, localBranches, countRange, defaultBase } from "./git.mjs";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function hasGraphite(cwd, gitDirPath) {
  if (!whichSync("gt")) return false;
  for (const n of [".graphite_repo_config", ".graphite_cache_persist"])
    if (gitDirPath && fs.existsSync(path.join(gitDirPath, n))) return true;
  return false;
}

function whichSync(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}
export { whichSync };

// Resolve the base ref once, loudly. Everything downstream — drift, the walk,
// the breaking checks — is measured against this one ref, and a wrong one is
// not a subtle failure, it is a stack rebased onto someone else's branch.
export function resolveBase(cwd, cfg) {
  const want = cfg.base || defaultBase(cwd, cfg.remote);
  if (!want) return { ref: null, sha: null, error: `no base branch: set "base" in the config, or fetch ${cfg.remote}` };
  const sha = revParse(cwd, want);
  if (!sha) return { ref: want, sha: null, error: `base ref "${want}" does not resolve — fetch it first` };
  return { ref: want, sha, error: null };
}

// gh answers with the INTENDED parents. Absent gh, an unauthenticated gh, or
// a repo with no open PRs all mean "no answer", never an error: this is an
// accelerator, and the topology fallback below is the floor.
function fromGh(cwd, branch, baseBranchName) {
  if (!whichSync("gh")) return null;
  const g = spawnSync("gh", ["pr", "list", "--state", "open", "--limit", "100",
    "--json", "headRefName,baseRefName,number,url,isDraft"],
    { cwd, encoding: "utf8", timeout: 20000 });
  if (g.status !== 0 || !g.stdout) return null;
  let prs;
  try { prs = JSON.parse(g.stdout); } catch { return null; }
  const byHead = new Map(prs.map(p => [p.headRefName, p]));
  if (!byHead.has(branch)) return null;
  // Walk DOWN from the current branch to the base, then reverse: the replay
  // order is bottom-first, and a stack is described top-down by its tip.
  const chain = [];
  const seen = new Set();
  let b = branch;
  while (b && byHead.has(b) && !seen.has(b)) {
    seen.add(b);
    const pr = byHead.get(b);
    chain.unshift({ name: b, pr: { number: pr.number, url: pr.url, draft: !!pr.isDraft }, parent: pr.baseRefName });
    if (pr.baseRefName === baseBranchName) break;
    b = pr.baseRefName;
  }
  return chain.length ? chain : null;
}

function fromTopology(cwd, branch, baseRef) {
  const tip = revParse(cwd, branch);
  if (!tip) return [];
  const out = [];
  for (const b of localBranches(cwd)) {
    if (b.name === branch) continue;
    // NOT "is the base an ancestor of this branch": the base has moved, which
    // is the entire reason you are here, so no branch in the stack contains
    // it. What makes a branch part of THIS stack is that it sits under the
    // branch you are on and is not already contained in the base.
    if (isAncestor(cwd, b.sha, baseRef)) continue;             // merged, or behind the base
    if (!isAncestor(cwd, b.sha, tip)) continue;                // not under the current branch
    if (!countRange(cwd, `${baseRef}..${b.name}`)) continue;   // nothing of its own to replay
    out.push({ name: b.name, ahead: countRange(cwd, `${baseRef}..${b.name}`) ?? 0 });
  }
  out.sort((a, b) => a.ahead - b.ahead);
  const chain = out.map(b => ({ name: b.name, pr: null, parent: null }));
  chain.push({ name: branch, pr: null, parent: null });
  for (let i = 0; i < chain.length; i++)
    chain[i].parent = i === 0 ? baseRef : chain[i - 1].name;
  return chain;
}

// The whole picture, cheap enough to call on every status.
export function discover(cwd, cfg, branch, base, gitDirPath) {
  const baseName = base.ref ? base.ref.replace(/^[^/]+\//, "") : "";
  const graphite = cfg.stack.tool === "graphite" ||
    (cfg.stack.tool === "auto" && hasGraphite(cwd, gitDirPath));

  if (Array.isArray(cfg.stack.branches) && cfg.stack.branches.length) {
    const chain = cfg.stack.branches.map((name, i) => ({
      name, pr: null, parent: i === 0 ? base.ref : cfg.stack.branches[i - 1],
    }));
    return { tool: graphite ? "graphite" : "git", source: "config", chain, driver: graphite ? "gt" : "git" };
  }
  if (!branch) return { tool: graphite ? "graphite" : "git", source: "detached", chain: [], driver: graphite ? "gt" : "git" };

  const gh = fromGh(cwd, branch, baseName);
  const chain = gh || fromTopology(cwd, branch, base.ref);
  return {
    tool: graphite ? "graphite" : "git",
    source: gh ? "gh" : "topology",
    driver: graphite ? "gt" : "git",
    chain,
  };
}

// The replay order, with the exclusive upstream each branch is lifted off.
//
// `git rebase --onto <newParentTip> <oldParentTip> <branch>` is the only form
// that survives a stack: rebasing a middle branch onto its already-rewritten
// parent WITHOUT --onto replays the parent's old commits a second time, which
// is where duplicated commits in a restacked stack come from. So the tips are
// recorded BEFORE anything moves, and the walk reads the recording.
export function planWalk(cwd, chain, base) {
  const steps = [];
  for (let i = 0; i < chain.length; i++) {
    const b = chain[i];
    const tip = revParse(cwd, b.name);
    if (!tip) { steps.push({ branch: b.name, error: "no local ref", pr: b.pr }); continue; }
    const upstream = i === 0
      ? mergeBase(cwd, base.ref, b.name)          // fork point from the base
      : revParse(cwd, chain[i - 1].name);         // the parent AS IT IS NOW
    steps.push({
      branch: b.name, pr: b.pr, tip, upstream,
      onto: i === 0 ? base.ref : chain[i - 1].name,   // resolved again at run time
      parentIndex: i - 1,
      ahead: countRange(cwd, `${upstream}..${b.name}`) ?? null,
    });
  }
  return steps;
}
