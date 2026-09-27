// verify — did the restack change anything of yours?
//
// THE QUESTION NOBODY ASKS AFTER A REBASE. `git rebase` reports success when
// every commit applied, not when every commit still says what it said. A
// resolution that took the wrong side, a hunk that landed in the wrong
// commit, a change quietly absorbed into someone else's edit: all of those
// are a clean rebase with a different patch at the end of it.
//
// `git range-diff <oldBase>..<oldTip> <newBase>..<newTip>` answers it exactly
// — it diffs the PATCHES, not the trees — and restack already records every
// branch's pre-rebase tip and upstream before anything moves, because the
// walk needs them anyway. So the check costs one git call per branch.
//
// The whole art is in what gets filtered out. On a restack, two kinds of
// patch change are expected:
//
//   * a generated artifact, which we deliberately re-derived — that IS the
//     tool working;
//   * a file the human resolved by hand during this run, recorded at the
//     stop it happened at.
//
// What is left over is a file nobody touched whose patch moved anyway. That
// is the one worth a human's eye, and on a clean run there is none of it.
import { git, countRange } from "./git.mjs";
import { artifactFor } from "./config.mjs";

// range-diff pairs commits by similarity and gives up at 60% by default,
// which on a restack that regenerated a big schema dump reports two unrelated
// commits instead of one changed one. Pairing aggressively is right here: a
// wrong pairing shows up as noise a human dismisses, a missing pairing shows
// up as "your commit vanished", which is a fire drill.
export const CREATION_FACTOR = 95;

export function rangeDiff(cwd, oldRange, newRange, factor = CREATION_FACTOR) {
  const r = git(cwd, ["range-diff", `--creation-factor=${factor}`, "--no-color", oldRange, newRange]);
  return r.ok ? r.out : null;
}

// Header: `1:  abc1234 ! 1:  def5678 subject` — or `-` on either side when a
// commit exists only in one range.
const HEAD = /^(\d+|-):\s+(\S+)\s+([=!<>])\s+(\d+|-):\s+(\S+)\s+(.*)$/;
// Inside a commit's body, a file section header. The leading marker says
// whether the whole section is gone from the old patch (`-`), new in the
// new one (`+`), or present in both (space).
const FILE = /^\s{0,4}([-+ ]?)\s*##\s+(.+?)\s+##/;

export function parseRangeDiff(text) {
  const commits = [];
  let cur = null, file = null;
  for (const raw of String(text || "").split("\n")) {
    const h = raw.match(HEAD);
    if (h) {
      cur = { oldN: h[1], oldSha: h[2], status: h[3], newN: h[4], newSha: h[5], subject: h[6], files: [] };
      commits.push(cur);
      file = null;
      continue;
    }
    if (!cur) continue;
    const f = raw.match(FILE);
    if (f) {
      const name = f[2].replace(/^[ab]\//, "");
      if (/^Commit message$/i.test(name) || /^Metadata$/i.test(name)) { file = null; continue; }
      file = { file: name, changed: f[1] === "-" || f[1] === "+" ? 1 : 0, sample: [] };
      cur.files.push(file);
      continue;
    }
    if (!file) continue;
    // The marker column is range-diff's own, one level out from the diff it
    // is quoting: `-` means this line was in the old patch and is not in the
    // new one, `+` the reverse. A space means both patches agree.
    const body = raw.replace(/^ {0,4}/, "");
    const mark = body[0];
    if (mark === "-" || mark === "+") {
      file.changed++;
      if (file.sample.length < 6) file.sample.push(body.slice(0, 160));
    }
  }
  return commits;
}

// Bucket every changed file: expected because we generated it, expected
// because a human resolved it here, or unexplained.
export function classify(commits, cfg, humanResolved = []) {
  const resolved = new Set(humanResolved);
  const out = { generated: [], resolved: [], unexplained: [], vanished: [], added: [] };
  for (const c of commits) {
    if (c.status === "=") continue;
    if (c.status === "<") { out.vanished.push({ sha: c.oldSha, subject: c.subject }); continue; }
    if (c.status === ">") { out.added.push({ sha: c.newSha, subject: c.subject }); continue; }
    for (const f of c.files) {
      if (!f.changed) continue;
      const entry = { file: f.file, commit: c.newSha, subject: c.subject, sample: f.sample };
      if (artifactFor(cfg, f.file)) out.generated.push(entry);
      else if (resolved.has(f.file)) out.resolved.push(entry);
      else out.unexplained.push(entry);
    }
  }
  return out;
}

function listCommits(cwd, range) {
  const r = git(cwd, ["log", "--format=%h\t%s", range]);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").filter(Boolean).map(l => {
    const [sha, ...rest] = l.split("\t");
    return { sha, subject: rest.join("\t") };
  });
}

// One branch, end to end. Ranges come from the walk's own record: the
// upstream it was lifted off and the tip it had, against where both are now.
export function verifyBranch(cwd, cfg, step, newParent, humanResolved, factor) {
  if (!step.tip || !step.upstream || !step.newTip)
    return { branch: step.branch, checked: false, why: "no recorded before/after for this branch" };
  const oldRange = `${step.upstream}..${step.tip}`;
  const newRange = `${newParent}..${step.newTip}`;

  // `git range-diff` refuses an EMPTY range ("need two commit ranges"), and
  // the empty one is the case that matters most: a branch all of whose
  // commits became empty and were dropped. Handled here rather than read as a
  // tool failure, because the first version of this reported "could not
  // check" and then printed "nothing of yours moved" — a false green on
  // exactly the outcome a human most needs to see.
  // null means git could not read the range at all (a recorded sha that no
  // longer resolves, a pruned reflog). That is NOT an empty range, and
  // treating it as one made a broken check look like "every commit is new".
  const oldCount = countRange(cwd, oldRange);
  const newCount = countRange(cwd, newRange);
  if (oldCount === null || newCount === null)
    return { branch: step.branch, checked: false,
             why: `could not read the recorded range (${oldCount === null ? oldRange : newRange}) — was it garbage collected?` };
  if (newCount === 0) {
    const gone = oldCount === 0 ? [] : listCommits(cwd, oldRange);
    return {
      branch: step.branch, checked: true, oldRange, newRange, commits: oldCount,
      generated: [], resolved: [], unexplained: [], added: [],
      vanished: gone,
      note: gone.length ? "every commit on this branch is gone after the restack" : null,
    };
  }
  if (oldCount === 0) {
    return {
      branch: step.branch, checked: true, oldRange, newRange, commits: newCount,
      generated: [], resolved: [], unexplained: [], vanished: [],
      added: listCommits(cwd, newRange),
    };
  }

  const text = rangeDiff(cwd, oldRange, newRange, factor);
  if (text === null)
    return { branch: step.branch, checked: false, why: "git range-diff failed (is this git older than 2.19?)" };
  const commits = parseRangeDiff(text);
  const buckets = classify(commits, cfg, humanResolved);
  return {
    branch: step.branch, checked: true, oldRange, newRange,
    commits: commits.length, ...buckets,
  };
}
