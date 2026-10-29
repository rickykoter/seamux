// Shared plan state: where a plan's state branch lives, and the backend that
// reads and writes it.
//
// Every plan gets a branch, <prefix><slug> (default seamux-state/<slug>),
// whose tree holds the plan's bundle files at their data-root paths
// (deep-plan/state/<slug>.json, plans/<slug>.md, ...) plus a meta.json
// {slug, writer, at}. What a branch may hold is import-state's rule
// (bundleNames in deep_plan.mjs); this file moves bytes and checks nothing.
//
// Config, later sources winning:
//   defaults                 remote origin, prefix seamux-state/, sync transitions
//   <repo>/.seamux/state.json {remote, prefix, sync}
//   SEAMUX_STATE_REMOTE  SEAMUX_STATE_PREFIX  SEAMUX_STATE_SYNC
//
// The remote is a remote name of the repo ("inside": the repo's own object
// store, remote-tracking refs only), or any other git URL or path
// ("outside": fetched into a bare cache under the data root). Either way the
// code checkout's HEAD, index, working tree and local branches are never
// touched: trees are built in a scratch index and commits with commit-tree.
//
// The backend has four verbs, so an object store can stand in for git later:
//   read(slug)                         -> { version, files, meta }
//   write(slug, files, expected, meta) -> { ok, version } | { ok: false, moved: true }
//   list()                             -> [{ slug, version }]
//   remove(slug, expected)             -> { ok } | { ok: false, moved: true }
// A version is the branch's commit ("" when there is none). A write or
// remove is pinned to the version its caller read and refused if the branch
// moved since; a remote that cannot be reached throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { STATE_DIR, sessionId } from "./state.mjs";

export const SYNC_MODES = ["transitions", "manual", "off"];
export const DEFAULTS = Object.freeze({ remote: "origin", prefix: "seamux-state/", sync: "transitions" });
const ENV_KEYS = { remote: "SEAMUX_STATE_REMOTE", prefix: "SEAMUX_STATE_PREFIX", sync: "SEAMUX_STATE_SYNC" };

// Bare caches for remotes outside the repo sit beside the state folder, so
// the probe's overrides move them too.
export const CACHE_DIR = path.join(path.dirname(STATE_DIR), "state-cache");

export function repoTop(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

// A prefix is a run of ref path parts; it may end in "/" or not.
const PREFIX_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9._-]*$/;
const prefixOk = p => PREFIX_RE.test(p) && !p.includes("..") && !/\.lock(\/|$)/.test(p);

// The config for the repo holding `dir`. Never throws: a bad file or value is
// reported in `problems` and its key falls back. A sync mode that cannot be
// read becomes manual, so a typo never starts pushing.
export function loadConfig(dir = process.cwd(), env = process.env) {
  const top = dir ? repoTop(dir) : "";
  const file = top ? path.join(top, ".seamux", "state.json") : "";
  const problems = [];
  let fromFile = {};
  if (file && fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j && typeof j === "object" && !Array.isArray(j)) fromFile = j;
      else problems.push(`${file} is not a JSON object; using the defaults`);
    } catch (e) { problems.push(`${file} does not parse (${e.message}); using the defaults`); }
  }
  const cfg = { ...DEFAULTS }, source = {};
  for (const k of Object.keys(DEFAULTS)) {
    source[k] = "default";
    const f = fromFile[k];
    if (f !== undefined) {
      if (typeof f === "string" && (f.trim() || k === "prefix")) { cfg[k] = f.trim(); source[k] = file; }
      else problems.push(`${file}: ${k} must be a string`);
    }
    const e = env[ENV_KEYS[k]];
    if (e !== undefined && (e.trim() || k === "prefix")) { cfg[k] = e.trim(); source[k] = ENV_KEYS[k]; }
  }
  cfg.sync = cfg.sync.toLowerCase();
  if (!SYNC_MODES.includes(cfg.sync)) {
    problems.push(`sync "${cfg.sync}" (from ${source.sync}) is not one of ${SYNC_MODES.join(", ")}; treating it as manual`);
    cfg.sync = "manual";
  }
  if (!prefixOk(cfg.prefix)) {
    problems.push(`prefix "${cfg.prefix}" (from ${source.prefix}) is not a branch name prefix; using ${DEFAULTS.prefix}`);
    cfg.prefix = DEFAULTS.prefix; source.prefix = "default";
  }
  return { ...cfg, source, file, top, problems };
}

const isUrl = r => /^[a-z][a-z0-9+.-]*:\/\//i.test(r) || /^[^/\s]+@[^/\s:]+:/.test(r);
const isPath = r => /^(\/|\.\.?(\/|$)|~\/)/.test(r) || r.includes("/");

// The identity a state commit carries: the person's, when git knows it.
function identityEnv(gitArgs) {
  const r = spawnSync("git", [...gitArgs, "var", "GIT_COMMITTER_IDENT"], { encoding: "utf8", timeout: 5000 });
  if (r.status === 0) return {};
  return { GIT_AUTHOR_NAME: "deep-plan", GIT_AUTHOR_EMAIL: "deep-plan@localhost",
    GIT_COMMITTER_NAME: "deep-plan", GIT_COMMITTER_EMAIL: "deep-plan@localhost" };
}

export function writerName() {
  const s = sessionId();
  if (s) return "session " + s.slice(0, 8);
  try { return os.userInfo().username + "@" + os.hostname(); } catch { return os.hostname(); }
}

export class GitBackend {
  // cfg: loadConfig's result (top, remote, prefix). timeout: ms per network call.
  constructor(cfg, { cacheDir = CACHE_DIR, timeout = 20000 } = {}) {
    this.prefix = cfg.prefix;
    this.remote = cfg.remote;
    this.timeout = timeout;
    const top = cfg.top || "";
    const names = top ? (spawnSync("git", ["-C", top, "remote"], { encoding: "utf8", timeout: 5000 }).stdout || "").split("\n").filter(Boolean) : [];
    if (names.includes(cfg.remote)) {
      this.inside = true;
      this.gitArgs = ["-C", top];
      this.target = cfg.remote;
      this.where = `remote ${cfg.remote}`;
      this.track = b => `refs/remotes/${cfg.remote}/${b}`;
    } else if (isUrl(cfg.remote) || isPath(cfg.remote)) {
      this.inside = false;
      let url = cfg.remote;
      if (!isUrl(url)) url = path.resolve(top || process.cwd(), url.replace(/^~(?=\/)/, os.homedir()));
      this.target = url;
      this.where = url;
      this.cache = path.join(cacheDir, crypto.createHash("sha1").update(url).digest("hex").slice(0, 16) + ".git");
      this.gitArgs = ["--git-dir", this.cache];
      this.track = b => `refs/heads/${b}`;
    } else {
      throw new Error(`no git remote named ${cfg.remote}` + (top ? ` in ${top}` : " (not in a git repo)") +
        `; set remote in .seamux/state.json or SEAMUX_STATE_REMOTE to a remote name, URL or path`);
    }
  }

  branch(slug) { return this.prefix + slug; }

  git(args, { input, net = false, env = {} } = {}) {
    if (!this.inside && !fs.existsSync(path.join(this.cache, "HEAD"))) {
      fs.mkdirSync(path.dirname(this.cache), { recursive: true });
      const r = spawnSync("git", ["init", "-q", "--bare", this.cache], { encoding: "utf8", timeout: 10000 });
      if (r.status !== 0) throw new Error(`cannot make the state cache ${this.cache}: ${r.stderr.trim()}`);
    }
    return spawnSync("git", [...this.gitArgs, ...args], {
      input, encoding: input && Buffer.isBuffer(input) ? "buffer" : "utf8",
      timeout: net ? this.timeout : 10000, maxBuffer: 64 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
    });
  }

  netFail(what, r) {
    const why = r.error ? (r.error.code === "ETIMEDOUT" ? "timed out" : r.error.message) : String(r.stderr || "").trim().split("\n").pop();
    return new Error(`${what} ${this.where} failed: ${why}`);
  }

  // The branch's commit on the remote, or "" when it has none.
  version(slug) {
    const r = this.git(["ls-remote", "--heads", this.target, "refs/heads/" + this.branch(slug)], { net: true });
    if (r.status !== 0 || r.error) throw this.netFail("reading", r);
    const line = r.stdout.split("\n").find(l => l.endsWith("\trefs/heads/" + this.branch(slug)));
    return line ? line.split("\t")[0] : "";
  }

  // Fetch a version into the local store, unless it is already here.
  ensure(slug, version) {
    const have = this.git(["cat-file", "-e", version + "^{commit}"]);
    if (have.status !== 0) {
      const b = this.branch(slug);
      const r = this.git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", this.target, `+refs/heads/${b}:${this.track(b)}`], { net: true });
      if (r.status !== 0 || r.error) throw this.netFail("fetching from", r);
    }
    this.git(["update-ref", this.track(this.branch(slug)), version]);
  }

  read(slug) {
    const version = this.version(slug);
    if (!version) return { version: "", files: null, meta: null };
    this.ensure(slug, version);
    const ls = this.git(["ls-tree", "-r", "-z", version]);
    if (ls.status !== 0) throw new Error(`cannot list ${this.branch(slug)} at ${version}: ${ls.stderr.trim()}`);
    const files = {};
    for (const ent of ls.stdout.split("\0").filter(Boolean)) {
      const tab = ent.indexOf("\t");
      const [, type, sha] = ent.slice(0, tab).split(" ");
      if (type !== "blob") continue;
      const blob = spawnSync("git", [...this.gitArgs, "cat-file", "blob", sha], { maxBuffer: 64 << 20, timeout: 10000 });
      if (blob.status !== 0) throw new Error(`cannot read ${ent.slice(tab + 1)} from ${this.branch(slug)}`);
      files[ent.slice(tab + 1)] = blob.stdout;
    }
    let meta = null;
    if (files["meta.json"]) { try { meta = JSON.parse(files["meta.json"].toString("utf8")); } catch { /* a bad meta reads as none */ } }
    delete files["meta.json"];
    return { version, files, meta };
  }

  // files: { "deep-plan/state/<slug>.json": Buffer|string, ... }. The commit's
  // parent is `expected`, and the push is leased on it: if the branch is no
  // longer there, nothing changes and the caller merges and tries again.
  write(slug, files, expected = "", meta = {}) {
    const b = this.branch(slug);
    const idx = path.join(os.tmpdir(), `deep-plan-sync-${process.pid}-${crypto.randomBytes(4).toString("hex")}.index`);
    const ienv = { GIT_INDEX_FILE: idx };
    try {
      const all = { ...files, "meta.json": JSON.stringify({ slug, writer: writerName(), at: new Date().toISOString(), ...meta }, null, 2) + "\n" };
      const lines = [];
      for (const [rel, data] of Object.entries(all)) {
        const h = this.git(["hash-object", "-w", "--stdin"], { input: Buffer.from(data) });
        if (h.status !== 0) throw new Error(`cannot store ${rel}: ${String(h.stderr).trim()}`);
        lines.push(`100644 blob ${String(h.stdout).trim()}\t${rel}`);
      }
      const u = this.git(["update-index", "--add", "--index-info"], { input: lines.join("\n") + "\n", env: ienv });
      if (u.status !== 0) throw new Error(`cannot build the state tree: ${u.stderr.trim()}`);
      const t = this.git(["write-tree"], { env: ienv });
      if (t.status !== 0) throw new Error(`cannot write the state tree: ${t.stderr.trim()}`);
      if (expected) this.ensure(slug, expected);
      const c = this.git(["commit-tree", t.stdout.trim(), ...(expected ? ["-p", expected] : []), "-m", `deep-plan state: ${slug}`],
        { env: identityEnv(this.gitArgs) });
      if (c.status !== 0) throw new Error(`cannot commit the state: ${c.stderr.trim()}`);
      const sha = c.stdout.trim();
      const p = this.git(["push", "--porcelain", `--force-with-lease=refs/heads/${b}:${expected}`,
        this.target, `${sha}:refs/heads/${b}`], { net: true });
      if (p.status === 0 && !p.error) { this.git(["update-ref", this.track(b), sha]); return { ok: true, version: sha }; }
      if (refused(p)) return { ok: false, moved: true };
      throw this.netFail("pushing to", p);
    } finally { try { fs.rmSync(idx, { force: true }); } catch { /* gone */ } }
  }

  list() {
    const r = this.git(["ls-remote", "--heads", this.target, `refs/heads/${this.prefix}*`], { net: true });
    if (r.status !== 0 || r.error) throw this.netFail("listing", r);
    const head = "refs/heads/" + this.prefix;
    return r.stdout.split("\n").filter(Boolean).map(l => l.split("\t"))
      .filter(([, ref]) => ref && ref.startsWith(head) && !ref.slice(head.length).includes("/"))
      .map(([version, ref]) => ({ slug: ref.slice(head.length), version }));
  }

  remove(slug, expected) {
    const b = this.branch(slug);
    const p = this.git(["push", "--porcelain", `--force-with-lease=refs/heads/${b}:${expected || ""}`, this.target, `:refs/heads/${b}`], { net: true });
    if (p.status === 0 && !p.error) { this.git(["update-ref", "-d", this.track(b)]); return { ok: true }; }
    if (refused(p)) return { ok: false, moved: true };
    throw this.netFail("deleting on", p);
  }
}

// A push the remote turned down because the branch is not where the lease
// said, as opposed to one that never got there.
function refused(p) {
  const out = String(p.stdout || "") + String(p.stderr || "");
  return !p.error && /stale info|\[rejected\]|fetch first|non-fast-forward|already exists/.test(out);
}

// The backend for the repo holding `dir`, with its config. Throws only when
// the remote names nothing; callers that must not fail catch it.
export function openBackend(dir = process.cwd(), opts = {}) {
  const cfg = opts.config || loadConfig(dir, opts.env || process.env);
  return { cfg, backend: new GitBackend(cfg, opts) };
}
