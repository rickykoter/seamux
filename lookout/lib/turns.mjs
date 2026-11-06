// Turn snapshots (ADR 0069, 0070). At each prompt and each stop the working
// tree, untracked files included, is captured the way a worktree review
// captures it (worktreeTree, on a scratch index) and kept as a parentless
// commit under refs/seamux/turns/<session>/<n>/{start,end}. Nothing touches
// the branch, the real index or the stash; the ref alone keeps the objects.
// Each finished turn is logged to <data>/plans/turns/<session>.jsonl, which
// crew's Wake indexers read (they read stores, not git).
//
// Run from hooks/turns.sh as `turns.mjs start|end|prune` with the hook payload
// on stdin. It never prints and never fails the prompt: past the budget (8 s)
// or on any error it records nothing.
//
//   start   UserPromptSubmit: the next turn's start, and an open-turn marker
//           holding its number and the prompt's first 120 characters
//   end     Stop: the open turn's end, and its line in the log
//   prune   SessionStart: each session's last 50 turns are kept; a session
//           idle for 7 days loses its refs and its log
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { git, repoInfo, worktreeTree } from "./patch.mjs";
import { REVIEWS_DIR, writeAtomic } from "./store.mjs";
import { detectHost } from "./host.mjs";

export const REF_ROOT = "refs/seamux/turns";
export const KEEP = 50;
export const IDLE_MS = 7 * 24 * 3600 * 1000;
export const PROMPT_CHARS = 120;
export const BUDGET_MS = Number(process.env.LOOKOUT_TURN_BUDGET_MS) || 8000;
export const TURNS_DIR = process.env.LOOKOUT_TURNS_DIR || path.join(path.dirname(REVIEWS_DIR), "turns");

// A session id as a ref segment and a file name: what a uuid already is.
export const sessionKey = s => String(s || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

const logPath = sid => path.join(TURNS_DIR, sid + ".jsonl");
const openPath = sid => path.join(TURNS_DIR, sid + ".open.json");
const line1 = s => (s || "").trim();
// commit-tree needs an identity; a repo without user.name must still snapshot.
const ID_ENV = { GIT_AUTHOR_NAME: "seamux", GIT_AUTHOR_EMAIL: "turns@seamux",
                 GIT_COMMITTER_NAME: "seamux", GIT_COMMITTER_EMAIL: "turns@seamux" };

// Every turn ref in the repo: [{session, n, side, sha, at}] (at: commit time, ms).
export function turnRefs(root, session = "") {
  const pat = session ? `${REF_ROOT}/${session}/` : REF_ROOT + "/";
  const out = git(root, ["for-each-ref", "--format=%(refname) %(objectname) %(committerdate:unix)", pat], { allowFail: true }) || "";
  const refs = [];
  for (const l of out.split("\n")) {
    const m = l.match(/^refs\/seamux\/turns\/([^/]+)\/(\d+)\/(start|end) ([0-9a-f]+) (\d+)$/);
    if (m) refs.push({ session: m[1], n: Number(m[2]), side: m[3], sha: m[4], at: Number(m[5]) * 1000 });
  }
  return refs;
}

function snapshot(root, label) {
  const tree = worktreeTree(root);
  return line1(git(root, ["commit-tree", tree, "-m", label], { env: ID_ENV }));
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// A turn's end at `sha`, and its line in the log (replacing one for the same
// turn). The turn is the open marker's; its start ref must still be the one
// the marker took, or it was pruned or belongs to another repo.
function close(root, sid, open, sha, now) {
  const startSha = line1(git(root, ["rev-parse", "-q", "--verify", `${REF_ROOT}/${sid}/${open.n}/start`], { allowFail: true }));
  if (!startSha || startSha !== open.start) return null;
  git(root, ["update-ref", `${REF_ROOT}/${sid}/${open.n}/end`, sha]);
  const changed = line1(git(root, ["diff", "--no-renames", "--no-ext-diff", "--name-only", startSha, sha]) || "");
  const entry = { n: open.n, session: sid, root, prompt: open.prompt || "", start: startSha, end: sha,
                  files: changed ? changed.split("\n").length : 0, at: new Date(now).toISOString() };
  const keep = readLog(sid).filter(e => e.n !== open.n);
  keep.push(entry);
  writeAtomic(logPath(sid), keep.slice(-KEEP).map(e => JSON.stringify(e)).join("\n") + "\n");
  writeAtomic(openPath(sid), JSON.stringify({ ...open, ended: true }) + "\n");
  return entry;
}

const isOpen = m => m && Number.isInteger(m.n) && typeof m.start === "string";

// UserPromptSubmit: snapshot as turn n+1's start. A turn still open (a prompt
// sent while the agent worked, or a stop that never ran) ends at this same
// snapshot, so it keeps a diff and a log line.
export function start({ cwd, session, prompt = "", now = Date.now() }) {
  const sid = sessionKey(session);
  if (!sid) return null;
  const { root } = repoInfo(cwd);
  const prev = readJson(openPath(sid));
  const n = Math.max(0, ...turnRefs(root, sid).map(r => r.n)) + 1;
  const sha = snapshot(root, `seamux turn ${sid}/${n} start`);
  git(root, ["update-ref", `${REF_ROOT}/${sid}/${n}/start`, sha]);
  fs.mkdirSync(TURNS_DIR, { recursive: true });
  if (isOpen(prev) && !prev.ended) close(root, sid, prev, sha, now);
  writeAtomic(openPath(sid), JSON.stringify({ n, root, start: sha, at: new Date(now).toISOString(),
    prompt: String(prompt).replace(/\s+/g, " ").trim().slice(0, PROMPT_CHARS) }) + "\n");
  return { n, sha };
}

// Stop: the open turn's end, and its log line. A second stop in the same turn
// (a Stop hook that sent the agent back) moves the end and replaces the line.
// A marker gone stale (a later start was tried and did not finish) is not
// this turn's, and is left alone.
export function end({ cwd, session, now = Date.now() }) {
  const sid = sessionKey(session);
  if (!sid) return null;
  const open = readJson(openPath(sid));
  if (!isOpen(open) || open.stale) return null;   // this turn's start was never taken
  const { root } = repoInfo(cwd);
  return close(root, sid, open, snapshot(root, `seamux turn ${sid}/${open.n} end`), now);
}

export function readLog(sid) {
  let text = "";
  try { text = fs.readFileSync(logPath(sid), "utf8"); } catch { return []; }
  const out = [];
  for (const l of text.split("\n")) { try { if (l.trim()) out.push(JSON.parse(l)); } catch { /* a torn line */ } }
  return out;
}

const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// SessionStart: each session keeps its last KEEP turns; one idle IDLE_MS (by
// its log, else its newest snapshot) loses its refs and its files. The
// session starting now is never swept.
export function prune({ cwd, session = "", now = Date.now() }) {
  const me = sessionKey(session);
  const { root } = repoInfo(cwd);
  const by = new Map();
  for (const r of turnRefs(root)) (by.get(r.session) || by.set(r.session, []).get(r.session)).push(r);
  const drop = [];
  for (const [sid, refs] of by) {
    const last = Math.max(mtime(logPath(sid)), mtime(openPath(sid)), ...refs.map(r => r.at));
    if (sid !== me && now - last > IDLE_MS) {
      drop.push(...refs);
      fs.rmSync(logPath(sid), { force: true });
      fs.rmSync(openPath(sid), { force: true });
      continue;
    }
    const ns = [...new Set(refs.map(r => r.n))].sort((a, b) => b - a);
    const cut = new Set(ns.slice(KEEP));
    drop.push(...refs.filter(r => cut.has(r.n)));
  }
  if (drop.length)
    git(root, ["update-ref", "--stdin"], { input: drop.map(r => `delete ${REF_ROOT}/${r.session}/${r.n}/${r.side} ${r.sha}\n`).join("") });
  return drop.length;
}

// ---------------------------------------------------------------- hook
// The parent reads the payload and runs the work in a child it kills past the
// budget, so a slow `git add -A` on a big repo never holds the prompt longer.
const SELF = fileURLToPath(import.meta.url);
const VERBS = { start, end, prune };

async function main() {
  const verb = process.argv[2];
  if (!VERBS[verb]) return;
  if (detectHost().host === "remote") return;          // cloud sessions are out of frame
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return; }
  const args = { cwd: payload.cwd || process.cwd(),
                 session: payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || "",
                 prompt: payload.prompt || "" };
  if (process.env.LOOKOUT_TURN_CHILD === "1") { VERBS[verb](args); return; }
  const sid = sessionKey(args.session);
  if (verb === "start" && sid) {
    // Mark the last turn's marker stale first: if this start does not finish,
    // the next stop must not move an older turn's end. The child still reads
    // it, to close a turn that never ended.
    const m = readJson(openPath(sid));
    if (m) writeAtomic(openPath(sid), JSON.stringify({ ...m, stale: true }) + "\n");
  }
  // Its own process group, so the budget kills the git it is running too: an
  // orphaned `git add -A` would finish later and write its scratch index back.
  const child = spawn(process.execPath, [SELF, verb], { detached: true, stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, LOOKOUT_TURN_CHILD: "1" } });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(payload));
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }, BUDGET_MS);
  await new Promise(res => child.on("close", res).on("error", res));
  clearTimeout(timer);
  // A killed child never ran worktreeTree's finally: remove the scratch index
  // it named after its pid (lib/patch.mjs). The group is dead, so nothing
  // writes it back.
  if (killed && child.pid) {
    const tmp = os.tmpdir();
    try { for (const f of fs.readdirSync(tmp)) if (f.startsWith(`lookout-index-${child.pid}-`)) fs.rmSync(path.join(tmp, f), { force: true }); }
    catch { /* nothing to clean */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { await main(); } catch { /* silence beats a broken prompt */ }
  process.exit(0);
}
