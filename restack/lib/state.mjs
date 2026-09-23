// Run state, in the git dir.
//
// WHY THERE AND NOT UNDER ~/.claude. Three reasons, all learned from things
// that go wrong elsewhere: a linked worktree has its OWN git dir, so two
// worktrees of the same repo restack without seeing each other's half-finished
// walk; `git rebase --abort` and the state that describes it die together when
// the repo does; and nothing here is worth syncing between machines. It is
// never committed — the git dir is not the work tree.
//
// THE PART THAT OUTLIVES THE RUN IS THE STALE LIST. A finished walk still
// leaves commits carrying a generated file that was resolved to the base copy
// and never rebuilt. That is the exact state CI fails on, so it survives the
// run, `check` refuses while it is non-empty, and only a successful regen (or
// an explicit `restack reset --stale`) clears it.
import fs from "node:fs";
import path from "node:path";

export const VERSION = 1;

export function statePath(gitDirPath) {
  return process.env.RESTACK_STATE || path.join(gitDirPath, "seamux-restack.json");
}

export function read(gitDirPath) {
  try {
    const st = JSON.parse(fs.readFileSync(statePath(gitDirPath), "utf8"));
    return st && st.version === VERSION ? st : fresh();
  } catch { return fresh(); }
}

export function fresh() {
  return {
    version: VERSION, phase: "idle", startedAt: null, finishedAt: null,
    base: null, driver: null, steps: [], index: 0,
    stale: [], resolved: [], log: [],
  };
}

export function write(gitDirPath, st) {
  const p = statePath(gitDirPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(st, null, 2) + "\n");
  return p;
}

export function clearRun(gitDirPath, st) {
  const next = fresh();
  next.stale = st.stale || [];      // deliberately survives an abort, see above
  write(gitDirPath, next);
  return next;
}

export function log(st, line) {
  st.log = (st.log || []).slice(-199);
  st.log.push({ at: new Date().toISOString(), line });
  return st;
}

// One stale entry per artifact, not per event: restacking five branches that
// each conflict on the same GraphQL dump is one thing to rebuild, and a list
// that repeats it five times reads as five problems.
export function markStale(st, entry) {
  st.stale = st.stale || [];
  const prev = st.stale.find(s => s.artifact === entry.artifact);
  if (prev) {
    prev.paths = [...new Set([...(prev.paths || []), ...(entry.paths || [])])].sort();
    prev.branches = [...new Set([...(prev.branches || []), ...(entry.branches || [])])].sort();
    prev.why = entry.why || prev.why;
    prev.command = entry.command || prev.command;
    prev.at = new Date().toISOString();
    return st;
  }
  st.stale.push({ ...entry, at: new Date().toISOString() });
  return st;
}

export function clearStale(st, artifactName) {
  st.stale = (st.stale || []).filter(s => s.artifact !== artifactName);
  return st;
}
