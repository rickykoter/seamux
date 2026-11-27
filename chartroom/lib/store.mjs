// chartroom's store: where a repo's charts live, and every write to them.
//
// A chart is a folder of plain files (ADR: a chart is a folder):
//
//   <dir>/<id>/chart.json      kind, title, purpose, status, versions, links
//   <dir>/<id>/threads.json    comments, replies and picks (lib/ops.mjs)
//   <dir>/<id>/v<n>/<pane>.html one file per option or view of version n
//
// Where <dir> is, in order:
//   1. .chartroom.json at the worktree's top names { "dir": "docs/charts" }:
//      that folder in this worktree, tracked like any file.
//   2. the repo shares its charts (git config chartroom.share true, or
//      .chartroom/ already holds tracked files here): <worktree top>/.chartroom.
//   3. any other git repo: <main checkout>/.chartroom, listed in the shared
//      .git/info/exclude so git never sees it, and one folder for every
//      worktree of the repo.
//   4. outside git: $CHARTROOM_HOME/<hash of the folder> (~/.claude/chartroom).
//
// Writes are atomic (a temp file renamed into place) and each chart's
// read-modify-write runs under a lock directory, as lookout's store does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { applyOp, normalize, emptyThreads } from "./ops.mjs";

export const KINDS = ["ux", "arch", "domain"];
export const STATUSES = ["exploring", "chosen", "superseded"];
export const ROLES = ["option", "view"];
export const DEFAULT_DIR = ".chartroom";
export const CONFIG_FILE = ".chartroom.json";
export const EXCLUDE_LINE = "/" + DEFAULT_DIR + "/";
export const ID_OK = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KEY_OK = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_PANE = 5 * 1024 * 1024;
export const STORE_VERSION = 1;

export const homeDir = (env = process.env) =>
  env.CHARTROOM_HOME || path.join(os.homedir(), ".claude", "chartroom");

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The git facts the dir rule needs, or null outside git.
export function gitInfo(cwd) {
  const out = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (!out) return null;
  const [top, common] = out.split("\n");
  if (!top || !common) return null;
  // The main checkout is the shared .git's parent; a git dir not named .git
  // (a submodule, a separate git dir) has no other checkout to share with.
  const main = path.basename(common) === ".git" ? path.dirname(common) : top;
  return { top, common, main, exclude: path.join(common, "info", "exclude") };
}

export function shareFlag(g) {
  return git(g.top, ["config", "--get", "chartroom.share"]) === "true";
}

function hasTracked(g, rel) {
  const r = spawnSync("git", ["-C", g.top, "ls-files", "--", rel], { encoding: "utf8", timeout: 10000 });
  return r.status === 0 && r.stdout.trim() !== "";
}

// { dir, mode: "config" | "shared" | "hidden" | "home", top, main, shared, configured, why }
// The CLI passes its cwd; a hook passes the session's.
export function resolve(cwd = process.cwd(), env = process.env) {
  const from = cwd;
  const g = gitInfo(from);
  if (!g) {
    const key = crypto.createHash("sha256").update(real(from)).digest("hex").slice(0, 12);
    return { dir: path.join(homeDir(env), key), mode: "home", top: real(from), main: "", shared: false,
      why: "not a git repo: kept under " + homeDir(env) };
  }
  const cfg = readJson(path.join(g.top, CONFIG_FILE));
  if (cfg && typeof cfg.dir === "string" && cfg.dir.trim()) {
    const rel = cfg.dir.trim().replace(/\/+$/, "");
    const dir = path.resolve(g.top, rel);
    const inside = path.relative(g.top, dir);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
      throw new Error(`${CONFIG_FILE}: dir ${JSON.stringify(cfg.dir)} must be a folder inside the repo`);
    return { dir, mode: "config", top: g.top, main: g.main, shared: true, git: g,
      why: `${CONFIG_FILE} names ${rel}` };
  }
  if (shareFlag(g) || hasTracked(g, DEFAULT_DIR)) {
    return { dir: path.join(g.top, DEFAULT_DIR), mode: "shared", top: g.top, main: g.main, shared: true, git: g,
      why: shareFlag(g) ? "shared (git config chartroom.share)" : "shared (.chartroom/ holds tracked files)" };
  }
  return { dir: path.join(g.main, DEFAULT_DIR), mode: "hidden", top: g.top, main: g.main, shared: false, git: g,
    why: "hidden: kept out of git through .git/info/exclude (chartroom share on to commit it)" };
}

// ------------------------------------------------------------ the exclude

function excludeLines(g) {
  try { return fs.readFileSync(g.exclude, "utf8").split("\n"); } catch { return []; }
}
export function excluded(g) { return excludeLines(g).includes(EXCLUDE_LINE); }

export function addExclude(g) {
  if (excluded(g)) return false;
  const cur = excludeLines(g).join("\n");
  fs.mkdirSync(path.dirname(g.exclude), { recursive: true });
  fs.appendFileSync(g.exclude, (cur && !cur.endsWith("\n") ? "\n" : "") + EXCLUDE_LINE + "\n");
  return true;
}

export function removeExclude(g) {
  if (!excluded(g)) return false;
  const kept = excludeLines(g).filter(l => l !== EXCLUDE_LINE);
  writeAtomic(g.exclude, kept.join("\n"));
  return true;
}

// The dir, made and (when hidden) excluded, before the first write.
export function prepare(loc) {
  if (loc.mode === "hidden") addExclude(loc.git);
  fs.mkdirSync(loc.dir, { recursive: true });
  return loc.dir;
}

// ------------------------------------------------------------ files

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const STALE_MS = 30 * 1000;
const OWNER = "owner";
const isStale = p => Date.now() - fs.statSync(p).mtimeMs > STALE_MS;
const removeLock = lock => { fs.rmSync(path.join(lock, OWNER), { force: true }); fs.rmdirSync(lock); };

// lookout's stale-lock break (lookout/lib/store.mjs): one breaker at a time,
// through a guard directory beside the lock.
function breakStale(lock) {
  const guard = lock + "-break";
  try { if (!isStale(lock)) return false; } catch (e) { return e.code === "ENOENT"; }
  try { fs.mkdirSync(guard); }
  catch (e) {
    try { if (e.code === "EEXIST" && isStale(guard)) fs.rmdirSync(guard); } catch { /* raced */ }
    return false;
  }
  try {
    if (!isStale(lock)) return false;
    removeLock(lock);
    return true;
  } catch (e) { return e.code === "ENOENT"; }
  finally { try { fs.rmdirSync(guard); } catch { /* gone */ } }
}

export function withLock(lock, fn) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5000;
  const nonce = process.pid + "-" + crypto.randomBytes(8).toString("hex");
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    const gone = breakStale(lock);
    if (Date.now() > deadline) throw new Error("chart is locked by another writer: " + lock);
    if (!gone) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try { fs.writeFileSync(path.join(lock, OWNER), nonce); }
  catch (e) { try { fs.rmdirSync(lock); } catch { /* gone */ } throw e; }
  try { return fn(); }
  finally {
    try { if (fs.readFileSync(path.join(lock, OWNER), "utf8") === nonce) removeLock(lock); }
    catch { /* gone, or not ours */ }
  }
}

// ------------------------------------------------------------ charts

export function chartPaths(dir, id) {
  if (!ID_OK.test(id)) throw new Error(`not a chart id: ${JSON.stringify(id)}`);
  const root = path.join(dir, id);
  return { root, json: path.join(root, "chart.json"), threads: path.join(root, "threads.json"),
    lock: path.join(dir, "." + id + ".lock"), version: n => path.join(root, "v" + n) };
}

export function slug(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "chart";
}

export function exists(dir, id) { return ID_OK.test(id) && fs.existsSync(chartPaths(dir, id).json); }

export function read(dir, id) {
  const p = chartPaths(dir, id);
  let c;
  try { c = JSON.parse(fs.readFileSync(p.json, "utf8")); }
  catch (e) { throw new Error(e.code === "ENOENT" ? `no chart ${id} in ${dir}` : `${p.json}: ${e.message}`); }
  return c;
}

export function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!ID_OK.test(n)) continue;
    const c = readJson(path.join(dir, n, "chart.json"));
    if (c && c.id === n) out.push(c);
  }
  return out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.id.localeCompare(b.id));
}

// Read-modify-write under the chart's lock; `fn` gets the chart and returns it.
export function update(dir, id, fn) {
  const p = chartPaths(dir, id);
  return withLock(p.lock, () => {
    const cur = read(dir, id);
    const next = fn(cur) || cur;
    next.updated = new Date().toISOString();
    writeAtomic(p.json, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

// The Claude Code session a chart was made in, when there is one: the seamux
// app's Wake shows the chart on that session's turn.
export const sessionOf = (env = process.env) => env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "";

export function create(dir, { kind, title, purpose = "", id = "", session = sessionOf() }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}, not ${JSON.stringify(kind)}`);
  if (!String(title || "").trim()) throw new Error("a chart needs a title");
  fs.mkdirSync(dir, { recursive: true });
  let base = id || slug(title);
  if (!ID_OK.test(base)) throw new Error(`not a chart id: ${JSON.stringify(base)}`);
  // A new id, never a taken one: mkdir is the claim, so two writers racing on
  // one title get two charts.
  for (let n = 1; ; n++) {
    const cand = n === 1 ? base : `${base.slice(0, 60)}-${n}`;
    if (id && n > 1) throw new Error(`chart ${id} already exists`);
    try { fs.mkdirSync(path.join(dir, cand)); base = cand; break; }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  const at = new Date().toISOString();
  const chart = { v: STORE_VERSION, id: base, kind, title: String(title).trim(), purpose: String(purpose || "").trim(),
    status: "exploring", decision: "", chosen: null, created: at, updated: at, versions: [], published: [],
    ...(session ? { session: String(session) } : {}) };
  const p = chartPaths(dir, base);
  writeAtomic(p.json, JSON.stringify(chart, null, 2) + "\n");
  writeAtomic(p.threads, JSON.stringify({ v: STORE_VERSION, threads: [] }, null, 2) + "\n");
  return chart;
}

// A pane spec from the command line: "path", "key=path" or "key:Label=path".
export function parsePane(arg) {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,31})(?::([^=]+))?=(.+)$/.exec(arg);
  if (m && !fs.existsSync(arg)) return { key: m[1].toLowerCase(), label: m[2] ? m[2].trim() : "", file: m[3] };
  return { key: "", label: "", file: arg };
}

// A new version from pane files. `role` defaults by kind: ux panes are
// options (pickable), arch and domain panes are views.
export function addVersion(dir, id, panes, { role = "", note = "" } = {}) {
  if (!panes.length) throw new Error("add needs at least one pane file");
  if (role && !ROLES.includes(role)) throw new Error(`role must be option or view, not ${JSON.stringify(role)}`);
  const p = chartPaths(dir, id);
  const read0 = read(dir, id);
  const as = role || (read0.kind === "ux" ? "option" : "view");
  const seen = new Set();
  const ready = panes.map((x, i) => {
    const file = path.resolve(x.file);
    let st;
    try { st = fs.statSync(file); } catch { throw new Error(`no such pane file: ${x.file}`); }
    if (!st.isFile()) throw new Error(`not a file: ${x.file}`);
    if (!/\.html?$/i.test(file)) throw new Error(`a pane is an .html file: ${x.file}`);
    if (st.size > MAX_PANE) throw new Error(`${x.file} is over ${MAX_PANE / 1024 / 1024}MB`);
    // Options default to a, b, c; views to their file's name.
    let key = x.key || (as === "option" ? String.fromCharCode(97 + i) : slug(path.basename(file).replace(/\.html?$/i, "")).slice(0, 32));
    if (!KEY_OK.test(key)) throw new Error(`not a pane key: ${JSON.stringify(key)}`);
    if (seen.has(key)) throw new Error(`two panes named ${key}`);
    seen.add(key);
    const label = x.label || (as === "option" ? key.toUpperCase() : key.replace(/-/g, " "));
    return { key, label, role: as, src: file, text: fs.readFileSync(file) };
  });
  return update(dir, id, c => {
    const n = (c.versions.length ? Math.max(...c.versions.map(v => v.n)) : 0) + 1;
    const vdir = p.version(n);
    fs.mkdirSync(vdir, { recursive: true });
    for (const r of ready) writeAtomic(path.join(vdir, r.key + ".html"), r.text);
    c.versions.push({ n, at: new Date().toISOString(), note: String(note || ""),
      panes: ready.map(r => ({ key: r.key, label: r.label, role: r.role, file: `v${n}/${r.key}.html` })) });
    return c;
  });
}

export function setStatus(dir, id, status, decision) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  return update(dir, id, c => {
    c.status = status;
    if (decision !== undefined) c.decision = String(decision);
    if (status === "exploring") c.chosen = null;
    return c;
  });
}

export const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+\/?$/;

export function link(dir, id, url, version) {
  if (!ARTIFACT_URL.test(url)) throw new Error(`not a claude.ai artifact link: ${url}`);
  return update(dir, id, c => {
    const latest = c.versions.length ? c.versions[c.versions.length - 1].n : 0;
    const n = version === undefined ? latest : Number(version);
    if (!c.versions.some(v => v.n === n)) throw new Error(`chart ${id} has no version ${version ?? n}`);
    c.published = (c.published || []).filter(x => x.url !== url);
    c.published.push({ url, version: n, at: new Date().toISOString() });
    return c;
  });
}

// ------------------------------------------------------------ share

// share on: git config chartroom.share true, the exclude line gone, and any
// charts held in the main checkout's hidden folder copied into this
// worktree's (they are untracked there, so copying loses nothing).
export function shareOn(loc) {
  if (!loc.git) throw new Error("share needs a git repo; outside one, charts stay under " + homeDir());
  if (loc.mode === "config") return { changed: false, copied: [], dir: loc.dir, note: `${CONFIG_FILE} already puts charts in ${path.relative(loc.top, loc.dir)}` };
  const g = loc.git;
  const was = shareFlag(g);
  spawnSync("git", ["-C", g.top, "config", "chartroom.share", "true"], { timeout: 10000 });
  const unexcluded = removeExclude(g);
  const dir = path.join(g.top, DEFAULT_DIR), from = path.join(g.main, DEFAULT_DIR);
  const copied = [];
  if (real(from) !== real(dir) && fs.existsSync(from)) {
    for (const n of fs.readdirSync(from)) {
      if (!ID_OK.test(n) || fs.existsSync(path.join(dir, n))) continue;
      fs.cpSync(path.join(from, n), path.join(dir, n), { recursive: true });
      copied.push(n);
    }
  }
  return { changed: !was || unexcluded, copied, dir };
}

export function shareOff(loc) {
  if (!loc.git) throw new Error("share needs a git repo");
  if (loc.mode === "config") throw new Error(`${CONFIG_FILE} names the chart dir; remove it to go back to the hidden default`);
  const g = loc.git;
  spawnSync("git", ["-C", g.top, "config", "--unset", "chartroom.share"], { timeout: 10000 });
  const added = addExclude(g);
  const tracked = hasTracked(g, DEFAULT_DIR);
  // From a worktree, the hidden folder is the main checkout's: charts made
  // or copied here while shared are copied there, so none goes unread.
  const here = path.join(g.top, DEFAULT_DIR), main = path.join(g.main, DEFAULT_DIR), copied = [];
  if (real(here) !== real(main) && fs.existsSync(here)) {
    fs.mkdirSync(main, { recursive: true });
    for (const n of fs.readdirSync(here)) {
      if (!ID_OK.test(n) || fs.existsSync(path.join(main, n))) continue;
      fs.cpSync(path.join(here, n), path.join(main, n), { recursive: true });
      copied.push(n);
    }
  }
  return { changed: added, tracked, copied };
}

// ------------------------------------------------------------ ops

// A room is a chart dir, named by a hash of its path (the server's routes,
// the seen cursor).
export const roomId = dir => crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 12);

// A missing threads.json is an empty one. One that will not parse is an
// error: returning it as empty would let the next write erase every thread.
export function readThreads(dir, id) {
  const f = chartPaths(dir, id).threads;
  let text;
  try { text = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") return emptyThreads(); throw e; }
  try { return normalize(JSON.parse(text)); }
  catch (e) { throw new Error(`${f} is not valid JSON (${e.message}); fix or restore it before chartroom writes to it`); }
}

// One op on one chart, under its lock: [code, reply]. chart.json is written
// only when the op changed it (a pick), threads.json on every success.
export function applyChartOp(dir, id, body, by, at) {
  if (!exists(dir, id)) return [404, { error: `no chart ${id}` }];
  const p = chartPaths(dir, id);
  return withLock(p.lock, () => {
    const state = { chart: read(dir, id), threads: readThreads(dir, id) };
    const before = JSON.stringify(state.chart);
    const out = applyOp(state, body, at || new Date().toISOString(), by);
    if (out[0] !== 200) return out;
    writeAtomic(p.threads, JSON.stringify(state.threads, null, 2) + "\n");
    if (JSON.stringify(state.chart) !== before) {
      state.chart.updated = new Date().toISOString();
      writeAtomic(p.json, JSON.stringify(state.chart, null, 2) + "\n");
    }
    return out;
  });
}
