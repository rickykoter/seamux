// deep-plan families: a parent plan whose `workstreams` block names child
// plans, says what each owns, and is the one place membership lives.
//
// Children never name their parent. That is what lets a plan already
// mid-increment join a family without a re-render, and it means every reader
// (render, the gate, the news hook, status) resolves membership through the
// index this module writes: state/families/<parent>/index.json.
//
// Claims compare as (repo, repo-relative path). Each child is its own worktree,
// so two agents editing "the same file" are editing different absolute paths;
// what they share is the repository, identified by its git common dir. That is
// read from the filesystem here rather than by spawning git, because the gate
// asks on every Edit and a git process per call would double its cost.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { STATE_DIR, KEYS_DIR, readState, allStates, canon } from "./state.mjs";
import { matchesGlob } from "./verify.mjs";

export const FAMILIES_DIR = path.join(STATE_DIR, "families");
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------- repos

// Kept as its own name for readers of this module: canon() resolves a path
// that does not exist yet through its nearest existing ancestor.
export const canonDeep = canon;

// The repository a path sits in: {id, top, name}. `id` is the git common dir
// with symlinks resolved, equal for every worktree of one repo; `top` is the
// working tree holding the path; `name` is for people. Null outside any repo.
//
// A worktree's `.git` is a file, `gitdir: <repo>/.git/worktrees/<name>`, and
// that directory's `commondir` file points back at the shared dir. A path that
// does not exist yet (a file about to be written) is walked from its nearest
// existing ancestor.
export function repoOf(p) {
  let dir = canonDeep(p);
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); }
  catch { dir = path.dirname(dir); }
  for (;;) {
    const dotgit = path.join(dir, ".git");
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* keep walking */ }
    if (st) {
      let common = dotgit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8"));
        if (!m) return null;
        const gitdir = path.resolve(dir, m[1].trim());
        common = gitdir;
        try {
          common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
        } catch { /* a plain gitdir pointer (submodule): it is its own common dir */ }
      }
      const id = canon(common);
      const name = path.basename(id) === ".git" ? path.basename(path.dirname(id)) : path.basename(id).replace(/\.git$/, "");
      return { id, top: dir, name };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Forward-slashed path of `file` relative to the repo's working tree, or null.
export function relInRepo(repo, file) {
  const rel = path.relative(repo.top, canonDeep(path.resolve(repo.top, file)));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

// A claim's `repo`: an absolute or ~ path to any checkout of it, or a bare name
// under $CREW_CODE_ROOT (~/code) — the convention crew-worktree uses.
export function resolveRepoRef(ref) {
  if (!ref) return null;
  let p = String(ref);
  if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  else if (!path.isAbsolute(p)) p = path.join(process.env.CREW_CODE_ROOT || path.join(os.homedir(), "code"), p);
  return fs.existsSync(p) ? repoOf(p) : null;
}

// ---------------------------------------------------------------- spec shape

// Shape only: what can be judged from the spec alone. Membership (does the
// child exist, is it in another family, do roots collide) needs state and is
// buildIndex's job.
export function validateWorkstreams(spec) {
  const errs = [];
  const ws = spec.workstreams;
  if (ws === undefined) return errs;
  if (!Array.isArray(ws)) return ["workstreams must be an array"];
  const seen = new Set();
  const nInc = (spec.deliverables || []).length;
  ws.forEach((w, i) => {
    const at = `workstreams[${i}]`;
    if (!w || typeof w !== "object") { errs.push(`${at} must be an object`); return; }
    if (!SLUG.test(w.slug || "")) errs.push(`${at}: slug must be a kebab-case plan slug`);
    else if (w.slug === spec.slug) errs.push(`${at}: a plan cannot be its own workstream`);
    else if (seen.has(w.slug)) errs.push(`${at}: ${w.slug} is listed twice`);
    seen.add(w.slug);
    for (const f of ["owns", "shared"]) {
      if (w[f] === undefined) continue;
      if (!Array.isArray(w[f])) { errs.push(`${at}.${f} must be an array`); continue; }
      w[f].forEach((c, j) => {
        const ok = typeof c === "string" ? !!c.trim()
          : c && typeof c === "object" && typeof c.glob === "string" && c.glob.trim() &&
            (c.repo === undefined || (typeof c.repo === "string" && c.repo.trim()));
        if (!ok) errs.push(`${at}.${f}[${j}] must be a glob, or {repo, glob}`);
      });
    }
    for (const f of ["contracts", "consumes"]) {
      if (w[f] === undefined) continue;
      if (!Array.isArray(w[f]) || w[f].some(s => typeof s !== "string" || !s.trim()))
        errs.push(`${at}.${f} must be an array of contract surfaces`);
    }
    if (w.after !== undefined) {
      if (!Array.isArray(w.after) || w.after.some(n => !Number.isInteger(n) || n < 1 || n > nInc))
        errs.push(`${at}.after must list this plan's increment numbers (1..${nInc})`);
    }
    if (w.repo !== undefined && (typeof w.repo !== "string" || !w.repo.trim()))
      errs.push(`${at}.repo must be a path or a repo name`);
  });
  return errs;
}

// ---------------------------------------------------------------- the index

export function indexPath(parent) { return path.join(FAMILIES_DIR, parent, "index.json"); }

export function readIndex(parent) {
  try { return JSON.parse(fs.readFileSync(indexPath(parent), "utf8")); }
  catch { return null; }
}

// Every family whose parent is still tracked and not closed. A closed or
// deleted parent's index stays on disk (its colours and trespass log are
// history) but governs nothing.
export function allIndexes() {
  let names = [];
  try { names = fs.readdirSync(FAMILIES_DIR); } catch { return []; }
  const out = [];
  for (const n of names) {
    const idx = readIndex(n);
    if (!idx) continue;
    const st = readState(idx.parent);
    if (!st || st.phase === "closed") continue;
    out.push(idx);
  }
  return out;
}

export function writeIndex(idx) {
  const p = indexPath(idx.parent);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

// The family a plan belongs to, as parent or child; null when none.
export function familyOf(slug) {
  return allIndexes().find(idx => idx.members.some(m => m.slug === slug)) || null;
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

// A plan's archived spec: what its last render reviewed.
function archivedSpec(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(KEYS_DIR, slug + ".spec.json"), "utf8")); }
  catch { return null; }
}

// What a member's own deliverables name, as repo-relative paths: the derived
// claims. A file outside any repo claims nothing.
function derivedOf(spec, root) {
  const out = [];
  (spec && spec.deliverables || []).forEach((d, i) => {
    for (const f of d.files || []) {
      const abs = path.resolve(root, f);
      const repo = repoOf(abs);
      const rel = repo && relInRepo(repo, abs);
      if (rel) out.push({ repo: repo.id, path: rel, deliverable: i + 1 });
    }
  });
  return out;
}

function normClaims(list, homeRepo, errs, where) {
  const out = [];
  for (const c of list || []) {
    const glob = typeof c === "string" ? c : c.glob;
    let repo = homeRepo;
    if (typeof c === "object" && c.repo) {
      repo = resolveRepoRef(c.repo);
      if (!repo) { errs.push(`${where}: repo "${c.repo}" is not a git checkout here`); continue; }
    }
    if (!repo) { errs.push(`${where}: "${glob}" has no repo (its root is not in a git checkout)`); continue; }
    out.push({ repo: repo.id, repoName: repo.name, glob: glob.replace(/^\.\//, "") });
  }
  return out;
}

const contains = (a, b) => a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);

// Resolve a parent spec into the index, or say why it cannot be. `errors`
// refuse a render; `index` is written only when there are none.
export function buildIndex(spec, parentRoot) {
  const errors = [];
  const ws = spec.workstreams || [];
  const members = [];
  const parentRepo = repoOf(parentRoot);
  members.push({
    slug: spec.slug, role: "parent", root: parentRoot, repo: parentRepo ? parentRepo.id : "",
    repoName: parentRepo ? parentRepo.name : "", owns: [], shared: [], contracts: [], consumes: [], after: [],
    derived: derivedOf(spec, parentRoot),
    base: parentRepo ? baseRef(parentRoot) || "" : "",
  });
  for (const w of ws) {
    const st = readState(w.slug);
    if (!st) { errors.push(`workstream ${w.slug}: no tracked plan by that slug — render it first`); continue; }
    if (st.phase === "closed") { errors.push(`workstream ${w.slug}: that plan is closed`); continue; }
    if (!st.root || !fs.existsSync(st.root)) { errors.push(`workstream ${w.slug}: its root is gone (${st.root || "none"})`); continue; }
    const home = w.repo ? resolveRepoRef(w.repo) : repoOf(st.root);
    if (w.repo && !home) errors.push(`workstream ${w.slug}: repo "${w.repo}" is not a git checkout here`);
    const where = `workstream ${w.slug}`;
    members.push({
      slug: w.slug, role: "child", root: st.root, repo: home ? home.id : "", repoName: home ? home.name : "",
      owns: normClaims(w.owns, home, errors, where + " owns"),
      shared: normClaims(w.shared, home, errors, where + " shared"),
      contracts: w.contracts || [], consumes: w.consumes || [], after: w.after || [],
      derived: derivedOf(archivedSpec(w.slug), st.root),
      // The ref news measures this member's base against, resolved once here
      // so the per-prompt hook needs a single git call.
      base: baseRef(st.root) || "",
    });
  }
  // One family per plan: a second parent claiming a child would make every
  // reader's answer depend on directory order.
  for (const idx of allIndexes()) {
    if (idx.parent === spec.slug) continue;
    for (const m of members) if (idx.members.some(o => o.slug === m.slug))
      errors.push(`${m.slug} already belongs to family ${idx.parent}`);
  }
  // Roots must not nest or coincide. The board keys plans by root, and
  // resolveSlugAt and the gate take the first root that contains a path, so
  // nested roots make "which plan is this" an accident of directory order.
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const a = canon(members[i].root), b = canon(members[j].root);
    if (contains(a, b) || contains(b, a))
      errors.push(`roots collide: ${members[i].slug} (${members[i].root}) and ${members[j].slug} (${members[j].root}) — ` +
        "each member needs its own worktree, and none may sit inside another");
  }
  const index = {
    parent: spec.slug,
    increments: (spec.deliverables || []).length,
    members,
    // Per-surface fingerprints of the parent's contracts: news compares these
    // to tell a consumer that a surface it depends on changed shape.
    contracts: Object.fromEntries((spec.contracts || []).map(c => [c.surface, sha(JSON.stringify(c))])),
  };
  return { index, errors };
}

// Re-resolve the family a plan belongs to, after that plan re-rendered (its
// derived claims may have moved). Rebuilt whole from the parent's archived
// spec; a failure leaves the old index rather than writing a broken one.
export function refreshFamilyFor(slug) {
  const idx = familyOf(slug);
  if (!idx) return null;
  const spec = archivedSpec(idx.parent);
  const st = readState(idx.parent);
  if (!spec || !st) return null;
  const { index, errors } = buildIndex(spec, st.root);
  if (errors.length) return { parent: idx.parent, errors };
  writeIndex({ ...idx, ...index });
  return { parent: idx.parent, errors: [] };
}

// ---------------------------------------------------------------- claims

function sharedHere(idx, repo, rel) {
  return idx.members.some(m => (m.shared || []).some(c => c.repo === repo && matchesGlob(rel, c.glob)));
}

// Who other than `except` claims (repo, rel): declared globs first, then
// deliverable files. Empty when the path is shared or unclaimed.
export function claimantsOf(idx, repo, rel, except) {
  if (sharedHere(idx, repo, rel)) return [];
  const out = [];
  for (const m of idx.members) {
    if (m.slug === except) continue;
    const g = (m.owns || []).find(c => c.repo === repo && matchesGlob(rel, c.glob));
    if (g) { out.push({ slug: m.slug, how: "owns", glob: g.glob }); continue; }
    const d = (m.derived || []).find(c => c.repo === repo && c.path === rel);
    if (d) out.push({ slug: m.slug, how: "plans", glob: rel, deliverable: d.deliverable });
  }
  return out;
}

// Overlaps the family carries by construction: a member's deliverable names a
// path a sibling owns or also plans to edit, or two members own one contract.
// The report render prints and `family check` repeats.
export function overlaps(idx) {
  const out = [];
  const seen = new Set();
  for (const m of idx.members) for (const d of m.derived || []) {
    for (const c of claimantsOf(idx, d.repo, d.path, m.slug)) {
      const key = [m.slug, c.slug, d.repo, d.path].sort().join("\u0000") + c.how;
      if (c.how === "plans" && seen.has(key)) continue;
      // Both name it, but this member owns it: the sibling's side of the pair
      // reports it as "owned by", which is the one line worth reading.
      if (c.how === "plans" && (m.owns || []).some(o => o.repo === d.repo && matchesGlob(d.path, o.glob))) continue;
      seen.add(key);
      out.push(c.how === "owns"
        ? `${m.slug} deliverable ${d.deliverable} names ${d.path} — owned by ${c.slug} (${c.glob})`
        : `${m.slug} deliverable ${d.deliverable} and ${c.slug} deliverable ${c.deliverable} both name ${d.path}`);
    }
  }
  const owners = {};
  for (const m of idx.members) for (const s of m.contracts || []) (owners[s] = owners[s] || []).push(m.slug);
  for (const [s, who] of Object.entries(owners))
    if (who.length > 1) out.push(`contract "${s}" is owned by ${who.join(" and ")}`);
  return out;
}

// ---------------------------------------------------------------- family check

// The ref a branch is measured against: the remote's default, then the usual
// names. Local refs only; the caller decides whether to fetch.
function baseRef(root) {
  const g = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  const head = g("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
  if (head.status === 0) return head.stdout.trim().replace(/^refs\/remotes\//, "");
  for (const r of ["origin/main", "origin/master", "main", "master"])
    if (g("rev-parse", "--verify", "--quiet", r).status === 0) return r;
  return null;
}

// Every path a member's worktree has touched: committed since it forked from
// the base, staged, unstaged and untracked. Repo-relative, forward-slashed.
export function touchedFiles(root) {
  const g = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  const files = new Set();
  const add = r => { if (r.status === 0) for (const l of r.stdout.split("\n")) if (l.trim()) files.add(l.trim()); };
  const base = baseRef(root);
  if (base) {
    const mb = g("merge-base", "HEAD", base);
    if (mb.status === 0) add(g("diff", "--name-only", mb.stdout.trim(), "HEAD"));
  }
  add(g("diff", "--name-only", "HEAD"));
  add(g("ls-files", "--others", "--exclude-standard", "--full-name"));
  // git reports paths relative to the top of the working tree, which is the
  // frame claims are written in.
  return { base, files: [...files].sort() };
}

// What each member has actually touched that a sibling claims. This is the
// backstop for writes the gate never sees (Bash, codegen, a checkout).
export function checkFamily(idx) {
  const out = [];
  for (const m of idx.members) {
    if (!m.root || !fs.existsSync(m.root)) { out.push({ slug: m.slug, problem: `root gone: ${m.root}` }); continue; }
    const repo = repoOf(m.root);
    if (!repo) continue;
    const { base, files } = touchedFiles(m.root);
    for (const f of files)
      for (const c of claimantsOf(idx, repo.id, f, m.slug))
        out.push({ slug: m.slug, path: f, owner: c.slug, how: c.how, glob: c.glob, base });
  }
  return out;
}

// ---------------------------------------------------------------- adoption

// Globs a reviewer can start from: each deliverable file's directory as
// `dir/**`, or the file itself at the top of the repo. A suggestion, printed
// for a person to cut down — never a claim until it is in a rendered spec.
export function suggestGlobs(derived) {
  const out = new Set();
  for (const d of derived) {
    const dir = path.posix.dirname(d.path);
    out.add(dir === "." ? d.path : dir + "/**");
  }
  return [...out].sort();
}

// A parent spec skeleton for plans that already exist: workstreams with
// suggested globs and the contracts each child declared, plus the overlap
// report as it would stand. Everything a review needs is left as a TODO.
export function draftParent(parent, children) {
  const problems = [];
  const workstreams = [];
  const members = [];
  for (const slug of children) {
    const st = readState(slug);
    const spec = archivedSpec(slug);
    if (!st || !spec) { problems.push(`${slug}: no tracked plan with an archived spec`); continue; }
    const derived = derivedOf(spec, st.root);
    const w = { slug, owns: suggestGlobs(derived) };
    const contracts = (spec.contracts || []).map(c => c.surface).filter(Boolean);
    if (contracts.length) w.contracts = contracts;
    workstreams.push(w);
    members.push({ slug, owns: [], shared: [], contracts: w.contracts || [], derived });
  }
  const draft = {
    slug: parent,
    title: "TODO: the common goal, imperative",
    context: "TODO: why these workstreams belong together, and what the parent itself lands first",
    workstreams,
    decisions: [], contracts: [], verifiedFacts: [], risks: [], diagrams: [],
    deliverables: [], quiz: [],
  };
  // Overlap as it stands from deliverable files alone: the suggested globs are
  // each child's own directories, so judging by them would only restate this.
  return { draft, problems, overlaps: overlaps({ members }) };
}

// ---------------------------------------------------------------- the guard

export function trespassPath(parent) { return path.join(FAMILIES_DIR, parent, "trespass.jsonl"); }

export function readTrespasses(parent) {
  let text = "";
  try { text = fs.readFileSync(trespassPath(parent), "utf8"); } catch { return []; }
  const out = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* a torn line: skip it */ }
  }
  return out;
}

const insideRoot = (p, root) => { const r = canon(root); return p === r || p.startsWith(r + path.sep); };

// The soft guard's whole decision, for an edit the increment gate already
// allowed. Returns null when there is nothing to say: the session is not in a
// family, the target is unclaimed, shared or its own, or this session was
// already told about this path. Otherwise it records the trespass and returns
// the note the agent is shown. It never refuses: that stays the increment
// gate's alone.
//
// The editor is the member whose root holds the session's cwd. The target can
// be in that member's own worktree (the usual case: the same repo-relative
// path a sibling owns) or in a sibling's worktree outright.
export function trespass({ cwd, target, session, tool }) {
  let names;
  try { names = fs.readdirSync(FAMILIES_DIR); } catch { return null; }
  if (!names.length) return null;
  const here = canonDeep(cwd);
  const idx = allIndexes().find(i => i.members.some(m => m.root && insideRoot(here, m.root)));
  if (!idx) return null;
  const me = idx.members.find(m => m.root && insideRoot(here, m.root));
  const abs = canonDeep(path.resolve(cwd, target));
  const repo = repoOf(abs);
  const rel = repo && relInRepo(repo, abs);
  if (!rel) return null;
  const owners = claimantsOf(idx, repo.id, rel, me.slug);
  const foreign = idx.members.find(m => m.slug !== me.slug && m.root && insideRoot(abs, m.root));
  if (!owners.length && !foreign) return null;
  if (session && readTrespasses(idx.parent).some(t => t.session === session && t.repo === repo.id && t.path === rel))
    return null;
  const owner = owners[0] || { slug: foreign.slug, how: "worktree", glob: "" };
  const rec = { at: Date.now(), session: session || "", from: me.slug, owner: owner.slug, how: owner.how,
    glob: owner.glob || "", repo: repo.id, repoName: repo.name, path: rel, tool: tool || "" };
  try {
    fs.mkdirSync(path.dirname(trespassPath(idx.parent)), { recursive: true });
    fs.appendFileSync(trespassPath(idx.parent), JSON.stringify(rec) + "\n");
  } catch { /* the note still goes out; a lost record beats a broken gate */ }
  // Facts, not instructions: hook context reaches the model as a system
  // reminder, and imperative out-of-band text reads as an injection.
  const why = owner.how === "owns" ? `workstream ${owner.slug} owns it (${owner.glob})`
    : owner.how === "plans" ? `workstream ${owner.slug}'s plan names it (deliverable ${owner.deliverable})`
    : `it sits in workstream ${owner.slug}'s worktree`;
  const also = foreign && foreign.slug !== owner.slug ? `; the file is in workstream ${foreign.slug}'s worktree` : "";
  return {
    family: idx.parent,
    note: `deep-plan family ${idx.parent}: ${rel} (${repo.name}) is outside this plan's claims — ${why}${also}. ` +
      `This session works on ${me.slug}. The edit was allowed and the overlap is recorded on the family; ` +
      `\`deep-plan family check ${idx.parent}\` lists every overlap.`,
  };
}

// ---------------------------------------------------------------- sequencing

// The parent increments a child's workstream names in `after` that are not
// done yet: [{parent, n, title, status}]. Empty for a plan in no family, a
// parent, or a child with nothing outstanding. `go` refuses while this is
// non-empty; the gate's reason names it so a shut gate explains itself.
export function waitingOn(slug) {
  const idx = familyOf(slug);
  if (!idx) return [];
  const me = idx.members.find(m => m.slug === slug);
  if (!me || me.role !== "child" || !(me.after || []).length) return [];
  const pst = readState(idx.parent);
  if (!pst) return [];
  return me.after.map(n => {
    const inc = (pst.increments || []).find(i => i.n === n);
    return { parent: idx.parent, n, title: inc ? inc.title : "", status: inc ? inc.status : "missing" };
  }).filter(w => w.status !== "done");
}

export function waitText(waits) {
  return waits.map(w => `${w.parent} increment ${w.n}${w.title ? ` (${w.title})` : ""} is ${w.status}`).join("; ");
}

// A family is done when every member is: the parent's own increments and each
// child plan. The parent's phase is left as it is; this is the family's.
export function familyDone(idx) {
  return idx.members.every(m => {
    const st = readState(m.slug);
    if (!st) return false;
    const incs = st.increments || [];
    return st.phase === "done" || st.phase === "closed" || (incs.length > 0 && incs.every(i => i.status === "done"));
  });
}

// ---------------------------------------------------------------- news

export function seenPath(parent, slug) { return path.join(FAMILIES_DIR, parent, "seen", slug + ".json"); }

export function readSeen(parent, slug) {
  try { return JSON.parse(fs.readFileSync(seenPath(parent, slug), "utf8")); } catch { return null; }
}

export function writeSeen(parent, slug, seen) {
  const p = seenPath(parent, slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(seen) + "\n");
  fs.renameSync(tmp, p);
}

// The member a working directory belongs to, with its family.
export function memberAt(cwd) {
  const here = canon(cwd);
  for (const idx of allIndexes()) {
    const me = idx.members.find(m => m.root && insideRoot(here, m.root));
    if (me) return { idx, me };
  }
  return null;
}

const claimsMatch = (me, repo, rel) =>
  (me.owns || []).some(c => c.repo === repo && matchesGlob(rel, c.glob)) ||
  (me.derived || []).some(d => d.repo === repo && d.path === rel);

const MAX_NEWS = 12;

// What changed around a member since its cursor, as factual lines. A first
// look (no cursor) is an orientation instead: who the family is and what
// this member owns. Nothing here fetches: the base ref is as fresh as the
// last fetch, and restack is how a member actually catches up.
//
// Returns {lines, seen}: the cursor to store if the lines are delivered.
export function gatherNews(idx, me, seen, { git = true } = {}) {
  const now = Date.now();
  const nextSeen = { at: now, contracts: idx.contracts || {} };
  const others = idx.members.filter(m => m.slug !== me.slug);
  if (!seen) {
    const sib = others.map(m => `${m.slug}${m.role === "parent" ? " (parent)" : ""}` +
      ((m.owns || []).length ? ` owns ${m.owns.map(c => c.glob).join(", ")}` : "")).join("; ");
    const mine = (me.owns || []).map(c => c.glob).join(", ") || "only its own deliverable files";
    const lines = [`This plan (${me.slug}) is ${me.role === "parent" ? "the parent" : "a workstream"} of deep-plan family ${idx.parent}. ` +
      `Members: ${sib}. ${me.slug} claims ${mine}.`];
    const waits = waitingOn(me.slug);
    if (waits.length) lines.push(`Its next go waits on ${waitText(waits)}.`);
    lines.push(`\`deep-plan family news ${me.slug}\` repeats what changed in the family; \`deep-plan family check ${idx.parent}\` lists overlaps.`);
    return { lines, seen: nextSeen };
  }
  const since = seen.at || 0;
  const lines = [];
  // Increments finished anywhere else in the family.
  for (const m of others) {
    const st = readState(m.slug);
    for (const i of (st && st.increments) || [])
      if (i.status === "done" && (i.doneAt || 0) > since)
        lines.push(`${m.slug}${m.role === "parent" ? " (parent)" : ""} finished increment ${i.n} (${i.title}).`);
  }
  // A wait that cleared: the parent landed what this member's go was held on.
  if (me.role === "child" && (me.after || []).length) {
    const pst = readState(idx.parent);
    for (const n of me.after) {
      const i = ((pst && pst.increments) || []).find(x => x.n === n);
      if (i && i.status === "done" && (i.doneAt || 0) > since)
        lines.push(`Parent increment ${n} is done, so go on ${me.slug} is no longer held by it.`);
    }
  }
  // Contracts this member owns or consumes whose parent entry changed shape.
  const mineC = new Set([...(me.contracts || []), ...(me.consumes || [])]);
  for (const surface of mineC) {
    const was = (seen.contracts || {})[surface], is = (idx.contracts || {})[surface];
    if (was && is && was !== is) lines.push(`The parent's contract "${surface}" changed since this session last looked.`);
    else if (was && !is) lines.push(`The parent no longer declares contract "${surface}".`);
  }
  // Commits on the base ref since the last look that touch this member's claims.
  if (git && me.base && me.root && fs.existsSync(me.root)) {
    // Commit times are whole seconds; a second's slack keeps a commit made in
    // the same second as the last look from falling between two cursors.
    const r = spawnSync("git", ["-C", me.root, "log", `--since=${new Date(since - 1000).toISOString()}`,
      "--format=%x00%h %s", "--name-only", "-n", "50", me.base], { encoding: "utf8" });
    const repo = repoOf(me.root);
    if (r.status === 0 && repo) {
      for (const chunk of r.stdout.split("\0").filter(Boolean)) {
        const [head, ...files] = chunk.split("\n").filter(Boolean);
        const hit = files.filter(f => claimsMatch(me, repo.id, f));
        if (hit.length) lines.push(`${me.base} gained ${head} touching ${hit.slice(0, 3).join(", ")}${hit.length > 3 ? " …" : ""}.`);
      }
    }
  }
  // Other members' edits into this member's claims.
  const tres = readTrespasses(idx.parent).filter(t => t.owner === me.slug && t.at > since);
  for (const t of tres) lines.push(`${t.from} edited ${t.path}, which ${me.slug} claims (${t.glob || "its worktree"}).`);
  if (lines.length > MAX_NEWS) {
    const more = lines.length - MAX_NEWS + 1;
    lines.splice(MAX_NEWS - 1, lines.length, `…and ${more} more: \`deep-plan family news ${me.slug}\`.`);
  }
  return { lines, seen: nextSeen };
}

export function newsText(idx, lines) {
  return `deep-plan family ${idx.parent} — what changed since this session last looked:\n` +
    lines.map(l => "- " + l).join("\n");
}

// ---------------------------------------------------------------- status

// The `family` field of a status row: who the plan is to its family and how
// the family stands. Called for every row on every `status --json`, which the
// pane polls every few seconds, so it reads state files only: the news count
// leaves out base-ref commits (a git call per row per poll), and the hook and
// `family news` still report them.
export function familyRow(idx, slug) {
  const me = idx.members.find(m => m.slug === slug);
  if (!me) return null;
  const members = idx.members.map(m => {
    const st = readState(m.slug);
    const incs = (st && st.increments) || [];
    return { slug: m.slug, role: m.role, phase: st ? st.phase : "missing",
      done: incs.filter(i => i.status === "done").length, total: incs.length };
  });
  const pairs = {};
  const tres = readTrespasses(idx.parent).filter(t => me.role === "parent" || t.from === slug || t.owner === slug);
  for (const t of tres) { const k = t.from + "\u0000" + t.owner; pairs[k] = (pairs[k] || 0) + 1; }
  const seen = readSeen(idx.parent, slug);
  return {
    role: me.role,
    parent: idx.parent,
    members,
    owns: (me.owns || []).map(c => c.glob),
    after: me.after || [],
    waitingOn: waitingOn(slug).map(({ n, title, status }) => ({ n, title, status })),
    trespasses: {
      total: tres.length,
      pairs: Object.entries(pairs).map(([k, count]) => { const [from, owner] = k.split("\u0000"); return { from, owner, count }; }),
    },
    news: seen ? gatherNews(idx, me, seen, { git: false }).lines.length : 0,
    done: familyDone(idx),
  };
}

// Every live family keyed by member slug, read once per status call.
export function familiesBySlug() {
  const out = new Map();
  for (const idx of allIndexes()) for (const m of idx.members) out.set(m.slug, idx);
  return out;
}
