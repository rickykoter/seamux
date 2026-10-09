// The review store: one JSON file per review under ~/.claude/plans/reviews,
// beside its derived files (the patch, the drawn rows, the page). The JSON is
// the record — source, policy, files, findings, threads — and everything else
// can be rebuilt from it and git. Writers are this CLI and, for comments and
// closes from the page, crew's intent server; both write a temp file and
// rename it under the same lock directory, so a reader never sees half a file
// and two writers never interleave.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const REVIEWS_DIR = process.env.LOOKOUT_REVIEWS_DIR ||
  path.join(os.homedir(), ".claude", "plans", "reviews");
export const STORE_VERSION = 1;

// The same rule crew's intent server applies to a slug from a URL
// (crew/board/crew-board-intent, SLUG_OK): an id is joined onto a path, so it
// can only ever name a file inside REVIEWS_DIR.
export const ID_OK = /^[a-z0-9][a-z0-9._-]{0,120}$/;

export function paths(id) {
  if (!ID_OK.test(id)) throw new Error("not a review id: " + id);
  const b = path.join(REVIEWS_DIR, id);
  return { json: b + ".json", patch: b + ".patch", rows: b + ".rows.json", html: b + ".html",
           lock: b + ".lock" };
}

export function idFrom(...parts) {
  const s = parts.filter(Boolean).join("-").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[^a-z0-9]+|[-.]+$/g, "");
  return (s || "review").slice(0, 100);
}

// The id a source gets when none is given: stable across re-opens of the same
// thing, so a second `lookout open` on a branch updates that branch's review
// (and keeps its findings) instead of starting another.
export function defaultId(src, o = {}) {
  if (o.plan) return idFrom(o.plan, "inc" + (o.inc || ""));
  if (src.kind === "patch") return idFrom("patch", path.basename(src.file).replace(/\.(patch|diff)$/, ""));
  if (src.kind === "range") return idFrom(src.repo, src.range.replace(/\.\.\.?/g, "_"));
  if (src.kind === "worktree") return idFrom(src.repo, src.branch, "wt");
  return idFrom(src.repo, src.branch);
}

export function exists(id) { return fs.existsSync(paths(id).json); }

export function read(id) {
  return JSON.parse(fs.readFileSync(paths(id).json, "utf8"));
}

export function list() {
  let names = [];
  try { names = fs.readdirSync(REVIEWS_DIR); } catch { return []; }
  return names.filter(n => n.endsWith(".json") && !n.endsWith(".rows.json") && !n.endsWith(".seen.json"))
    .map(n => { try { return read(n.slice(0, -5)); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// A lock directory: mkdir is atomic on every filesystem this runs on, from
// node and from python alike. A lock older than STALE_MS is a crashed writer's.
const STALE_MS = 10_000;
export function withLock(id, fn) {
  const { lock } = paths(id);
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) { fs.rmdirSync(lock); continue; } }
      catch { continue; }
      if (Date.now() > deadline) throw new Error("review " + id + " is locked by another writer");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch { /* already gone */ } }
}

// Read-modify-write under the lock. `fn` gets the current review (or null)
// and returns the one to write.
export function update(id, fn) {
  return withLock(id, () => {
    const cur = exists(id) ? read(id) : null;
    const next = fn(cur);
    next.updatedAt = new Date().toISOString();
    writeAtomic(paths(id).json, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

export function patchHash(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// A fresh review from an open, folded onto the one already stored under the
// id: the source, files and patch are replaced; what people said (findings,
// threads) and how the review was opened (policy, createdAt) are kept.
export function merge(cur, fresh) {
  if (!cur) return { version: STORE_VERSION, createdAt: new Date().toISOString(),
                     findings: [], groups: [], scoring: null, ...fresh };
  return { ...cur, ...fresh, version: STORE_VERSION, createdAt: cur.createdAt,
           findings: cur.findings || [],
           policy: { ...(cur.policy || {}), ...(fresh.policy || {}) },
           // A score cache is only good for the patch it scored; one the open
           // just computed wins.
           scoring: fresh.scoring !== undefined ? fresh.scoring
             : cur.patchHash === fresh.patchHash ? cur.scoring : null,
           groups: fresh.groups !== undefined ? fresh.groups
             : cur.patchHash === fresh.patchHash ? cur.groups || [] : [] };
}
