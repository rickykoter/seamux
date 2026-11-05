// `deep-plan seamux consolidate`: bring a repo's untracked .seamux files
// into the main checkout, and carry them to a teammate (ADR 0068).
//
// Under ADR 0068 an untracked .seamux file is read from the main checkout,
// so a file only a worktree has stops being read. consolidate lists every
// worktree's untracked .seamux files against main's (only-here, differs,
// same), and with --write copies the only-here ones into main. A file that
// differs is printed with a diff for the person to settle; nothing is ever
// deleted, and nothing in main is overwritten.
//
// --export <dir> writes main's untracked .seamux files to <dir>/<project>/
// (state/ and evidence/ left out: they belong to one machine), for a git
// repo the person pushes themselves. --import <dir> shows what
// <dir>/<project>/ would change in main, and writes only with --yes, the
// person's ok.
//
// Files git tracks belong to the branch and are never touched.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Folders a .seamux search never enters: build output, dependencies and VCS.
const SKIP = new Set([".git", "node_modules", "vendor", "tmp", "log", "dist", "build", "target", "coverage", ".bundle", ".venv", "__pycache__"]);
const MAX_DEPTH = 5;
// Machine-local parts of a .seamux folder, never moved or shared.
const LOCAL = /(^|\/)\.seamux\/(state|evidence)(\/|$)/;

const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const trackedSeamux = top => new Set((git(top, ["ls-files", "-z", "--", ":(glob)**/.seamux/**"]).stdout || "").split("\0").filter(Boolean));

// { main, worktrees: [path] } for the repo at `root`; main is the parent of
// the shared .git. null outside git or with a git dir not named .git.
export function checkouts(root) {
  const c = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (c.status !== 0) return null;
  const common = c.stdout.trim();
  if (path.basename(common) !== ".git") return null;
  const main = path.dirname(common);
  const wts = [];
  for (const line of (git(main, ["worktree", "list", "--porcelain"]).stdout || "").split("\n"))
    if (line.startsWith("worktree ")) {
      const p = line.slice(9);
      if (path.resolve(p) !== path.resolve(main) && fs.existsSync(p)) wts.push(p);
    }
  return { main, worktrees: wts };
}

function safeDir(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
}
const read = p => { try { return fs.readFileSync(p); } catch { return null; } };

// Every untracked file under a .seamux folder in one checkout, as paths
// relative to it, machine-local folders left out.
export function untrackedSeamux(top) {
  const tracked = trackedSeamux(top);
  const out = [];
  const walkSeamux = (abs, rel) => {
    for (const e of safeDir(abs)) {
      const r = rel + "/" + e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!LOCAL.test(r + "/")) walkSeamux(path.join(abs, e.name), r); }
      else if (e.isFile() && !LOCAL.test(r) && !tracked.has(r)) out.push(r);
    }
  };
  const walk = (abs, rel, depth) => {
    for (const e of safeDir(abs)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.name === ".seamux") walkSeamux(path.join(abs, e.name), r);
      else if (!SKIP.has(e.name) && !e.name.startsWith(".") && depth < MAX_DEPTH) walk(path.join(abs, e.name), r, depth + 1);
    }
  };
  walk(top, "", 0);
  return out.sort();
}

// The survey: one row per (worktree, file), status only-here (main has
// none), differs or same. A file several worktrees have and main lacks is
// a conflict when their contents disagree, and none of them is copied.
export function survey(root) {
  const co = checkouts(root);
  if (!co) return null;
  const rows = [];
  for (const wt of co.worktrees)
    for (const rel of untrackedSeamux(wt)) {
      const mine = read(path.join(wt, rel)), theirs = read(path.join(co.main, rel));
      const status = theirs === null ? "only-here" : mine.equals(theirs) ? "same" : "differs";
      rows.push({ worktree: wt, rel, status, copy: false });
    }
  const byRel = new Map();
  for (const r of rows.filter(r => r.status === "only-here")) {
    if (!byRel.has(r.rel)) byRel.set(r.rel, []);
    byRel.get(r.rel).push(r);
  }
  for (const group of byRel.values()) {
    const first = read(path.join(group[0].worktree, group[0].rel));
    const agree = group.every(r => read(path.join(r.worktree, r.rel)).equals(first));
    group.forEach((r, k) => { r.copy = agree && k === 0; if (!agree) r.status = "conflict"; });
  }
  return { main: co.main, worktrees: co.worktrees, rows };
}

// Copy the only-here files into main, never over an existing file.
// Returns the paths written.
export function writeOnlyHere(sv) {
  const written = [];
  for (const r of sv.rows.filter(r => r.copy)) {
    const dst = path.join(sv.main, r.rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(r.worktree, r.rel), dst);
    written.push(r.rel);
  }
  return written;
}

// A unified diff of two files, for the person to settle by hand.
export function diffText(a, b) {
  return spawnSync("diff", ["-u", a, b], { encoding: "utf8" }).stdout || "";
}

const bundleBase = (dir, main) => path.join(path.resolve(dir), path.basename(main));

// Main's untracked .seamux files into <dir>/<project>/.
export function exportBundle(root, dir) {
  const co = checkouts(root);
  if (!co) throw new Error(`${root} is not in a git repo whose git dir is .git`);
  const base = bundleBase(dir, co.main);
  const files = untrackedSeamux(co.main);
  for (const rel of files) {
    const dst = path.join(base, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(co.main, rel), dst);
  }
  return { main: co.main, base, files };
}

// What <dir>/<project>/ would change in main: new, differs, same, or
// tracked (left alone). Written only when `yes`: the person has seen the
// diffs and said so, which is also what lets a differing file be replaced.
export function importBundle(root, dir, { yes = false } = {}) {
  const co = checkouts(root);
  if (!co) throw new Error(`${root} is not in a git repo whose git dir is .git`);
  const base = bundleBase(dir, co.main);
  if (!fs.existsSync(base)) throw new Error(`no bundle for ${path.basename(co.main)} at ${base}`);
  const tracked = trackedSeamux(co.main);
  const rels = [];
  const walk = (abs, rel) => {
    for (const e of safeDir(abs)) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory() && !e.isSymbolicLink()) { if (e.name !== ".git") walk(path.join(abs, e.name), r); }
      else if (e.isFile() && /(^|\/)\.seamux\//.test(r) && !LOCAL.test(r)) rels.push(r);
    }
  };
  walk(base, "");
  const rows = rels.sort().map(rel => {
    if (tracked.has(rel)) return { rel, status: "tracked" };
    const mine = read(path.join(co.main, rel)), theirs = read(path.join(base, rel));
    return { rel, status: mine === null ? "new" : mine.equals(theirs) ? "same" : "differs" };
  });
  const written = [];
  if (yes) for (const r of rows.filter(r => r.status === "new" || r.status === "differs")) {
    const dst = path.join(co.main, r.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(base, r.rel), dst);
    written.push(r.rel);
  }
  return { main: co.main, base, rows, written };
}
