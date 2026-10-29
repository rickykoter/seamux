// Shared plan state: where a plan's state branch lives, and the backend that
// reads and writes it.
//
// Every plan gets a branch, <prefix><slug> (default seamux-state/<slug>),
// whose tree holds the plan's bundle files at their data-root paths
// (deep-plan/state/<slug>.json, plans/<slug>.md, ...) plus a meta.json
// {slug, writer, at}. What a branch may hold is import-state's rule
// (bundleNames in deep_plan.mjs); this file moves bytes and checks nothing.
//
// The plan holds its own config. Its spec says share: true (the defaults) or
// share: {remote, prefix, sync}; render records it in the plan state, and a
// family child uses its parent's. Later sources win:
//   defaults                 remote origin, prefix seamux-state/, sync transitions
//   the plan's share         {remote, prefix, sync}
//   SEAMUX_STATE_REMOTE  SEAMUX_STATE_PREFIX  SEAMUX_STATE_SYNC (this machine only)
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
//   archive(slug, expected)            -> { ok, tag } | { ok: false, moved: true }  (git only:
//                                         the branch becomes seamux-state-archive/<slug>)
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
export const ARCHIVE_PREFIX = "seamux-state-archive/";
export const DEFAULTS = Object.freeze({ remote: "origin", prefix: "seamux-state/", sync: "transitions" });
const ENV_KEYS = { remote: "SEAMUX_STATE_REMOTE", prefix: "SEAMUX_STATE_PREFIX", sync: "SEAMUX_STATE_SYNC" };

// Bare caches for remotes outside the repo sit beside the state folder, so
// the probe's overrides move them too.
export const CACHE_DIR = path.join(path.dirname(STATE_DIR), "state-cache");

export function repoTop(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : "";
}

// A prefix is a run of ref path parts; it may end in "/" or not. It is never
// empty, so a state branch can never be named like a code branch, and with a
// slug after it it must make a ref name git accepts.
const PREFIX_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*(?:[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;
const prefixOk = p => !!p && PREFIX_RE.test(p) &&
  spawnSync("git", ["check-ref-format", `refs/heads/${p}a`], { timeout: 5000 }).status === 0;

// What a spec's share may be: true, false, or an object of these keys. Render
// refuses anything else, so a plan's recorded share is always one of them.
export function shareProblems(share) {
  if (share === undefined || typeof share === "boolean") return [];
  if (!share || typeof share !== "object" || Array.isArray(share))
    return ['share: true, false, or { "remote": "...", "prefix": "...", "sync": "transitions|manual" }'];
  const out = [];
  for (const k of Object.keys(share)) if (!(k in DEFAULTS)) out.push(`share.${k}: not a share setting (remote, prefix, sync)`);
  for (const k of Object.keys(DEFAULTS))
    if (share[k] !== undefined && (typeof share[k] !== "string" || !share[k].trim())) out.push(`share.${k}: a non-empty string`);
  if (typeof share.sync === "string" && !["transitions", "manual"].includes(share.sync.trim().toLowerCase()))
    out.push("share.sync: transitions or manual");
  if (typeof share.prefix === "string" && share.prefix.trim() && !prefixOk(share.prefix.trim()))
    out.push(`share.prefix: "${share.prefix}" does not make a branch name with a slug after it`);
  return out;
}

// Where a plan's state branch lives, from the plan's share (its spec's
// share, recorded at render) and the SEAMUX_STATE_* overrides, for the repo
// holding `dir`. `shared` says whether the plan asked to sync at all; the
// remote, prefix and sync mode are resolved either way, so a person can
// still push or pull a plan by hand. The overrides are for a machine or
// sandbox that must reach the branch some other way; SEAMUX_STATE_SYNC=off
// stops the automatic pushes there. Never throws: a bad value is reported
// in `problems` and its key falls back, and a sync mode that cannot be read
// becomes manual, so a typo never starts pushing.
export function loadConfig(share, dir = process.cwd(), env = process.env) {
  const top = dir ? repoTop(dir) : "";
  const problems = [];
  const plan = share && typeof share === "object" && !Array.isArray(share) ? share : {};
  const cfg = { ...DEFAULTS }, source = {};
  for (const k of Object.keys(DEFAULTS)) {
    source[k] = "default";
    if (typeof plan[k] === "string" && plan[k].trim()) { cfg[k] = plan[k].trim(); source[k] = "plan"; }
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
  return { ...cfg, shared: !!share, source, top, problems };
}

// A URL with a scheme, or scp's [user@]host:path (no slash before the colon).
const isUrl = r => /^[a-z][a-z0-9+.-]*:\/\//i.test(r) || /^(?:[^/\s@]+@)?[^/\s:@]+:/.test(r);
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
    const cfgOf = k => (spawnSync("git", ["-C", top, "config", "--get", k], { encoding: "utf8", timeout: 5000 }).stdout || "").trim();
    // A partial clone (a cloud sandbox's usually is) leaves fetched files to
    // be fetched one by one when read, which a sandbox's git proxy cannot be
    // relied on for. Its own remote then goes through the full cache, by URL.
    const partial = names.includes(cfg.remote) && (cfgOf(`remote.${cfg.remote}.promisor`) === "true" || !!cfgOf(`remote.${cfg.remote}.partialclonefilter`));
    if (partial) {
      const url = cfgOf(`remote.${cfg.remote}.url`);
      if (!url) throw new Error(`remote ${cfg.remote} in ${top} has no url`);
      this.inside = false;
      this.target = url;
      this.where = `remote ${cfg.remote}`;
      this.cache = path.join(cacheDir, crypto.createHash("sha1").update(url).digest("hex").slice(0, 16) + ".git");
      this.gitArgs = ["--git-dir", this.cache];
      this.track = b => `refs/heads/${b}`;
    } else if (names.includes(cfg.remote)) {
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
        `; set the plan's share.remote, or SEAMUX_STATE_REMOTE, to a remote name, URL or path`);
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
      // Local calls get a long limit: they only stop on a stalled machine.
      timeout: net ? this.timeout : 60000, maxBuffer: 64 << 20,
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

  // Fetch a version into the local store, unless it is already here. False
  // when the branch has moved past it and it never reached this store.
  ensure(slug, version) {
    const has = () => this.git(["cat-file", "-e", version + "^{commit}"]).status === 0;
    if (!has()) {
      const b = this.branch(slug);
      // Only the branch, and none of a fetch's housekeeping: the state is a
      // few small files, and a cloud sandbox's git proxy makes every second count.
      const r = this.git(["fetch", "-q", "--no-tags", "--no-write-fetch-head", "--no-auto-gc", "--no-auto-maintenance",
        "--no-write-commit-graph", "--no-recurse-submodules", this.target, `+refs/heads/${b}:${this.track(b)}`], { net: true });
      if (r.status !== 0 || r.error) throw this.netFail("fetching from", r);
      if (!has()) return false;
    }
    const u = this.git(["update-ref", this.track(this.branch(slug)), version]);
    if (u.status !== 0) throw new Error(`cannot record ${this.track(this.branch(slug))}: ${u.stderr.trim()}`);
    return true;
  }

  read(slug) {
    let version = this.version(slug);
    if (!version) return { version: "", files: null, meta: null };
    // A branch that moves between the listing and the fetch is read again.
    if (!this.ensure(slug, version)) {
      version = this.version(slug);
      if (!version) return { version: "", files: null, meta: null };
      if (!this.ensure(slug, version)) throw new Error(`${this.branch(slug)} on ${this.where} kept moving while it was read; run it again`);
    }
    const ls = this.git(["ls-tree", "-r", "-z", version]);
    if (ls.status !== 0) throw new Error(`cannot list ${this.branch(slug)} at ${version}: ${ls.stderr.trim()}`);
    const files = {};
    for (const ent of ls.stdout.split("\0").filter(Boolean)) {
      const tab = ent.indexOf("\t");
      const [, type, sha] = ent.slice(0, tab).split(" ");
      if (type !== "blob") continue;
      const blob = spawnSync("git", [...this.gitArgs, "cat-file", "blob", sha], { maxBuffer: 64 << 20, timeout: 60000 });
      if (blob.status !== 0) throw new Error(`cannot read ${ent.slice(tab + 1)} from ${this.branch(slug)}: ` +
        (blob.error ? blob.error.message : String(blob.stderr || "").trim().split("\n").pop() || `git exited ${blob.status}`));
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
    const tmpd = idx.replace(/\.index$/, ".files");
    const ienv = { GIT_INDEX_FILE: idx };
    try {
      const all = { ...files, "meta.json": JSON.stringify({ slug, writer: writerName(), at: new Date().toISOString(), ...meta }, null, 2) + "\n" };
      // Every blob in one git call: a spawn per file is slow, and each one
      // can stall on a loaded machine. The bytes go in as they are.
      const rels = Object.keys(all);
      fs.mkdirSync(tmpd, { recursive: true });
      const paths = rels.map((rel, i) => { const f = path.join(tmpd, String(i)); fs.writeFileSync(f, Buffer.from(all[rel])); return f; });
      const h = this.git(["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: paths.join("\n") + "\n" });
      const shas = h.status === 0 ? h.stdout.trim().split("\n") : [];
      if (shas.length !== rels.length) throw new Error(`cannot store the plan's files: ${h.error ? h.error.message : String(h.stderr).trim()}`);
      const lines = rels.map((rel, i) => `100644 blob ${shas[i]}\t${rel}`);
      const u = this.git(["update-index", "--add", "--index-info"], { input: lines.join("\n") + "\n", env: ienv });
      if (u.status !== 0) throw new Error(`cannot build the state tree: ${u.stderr.trim()}`);
      const t = this.git(["write-tree"], { env: ienv });
      if (t.status !== 0) throw new Error(`cannot write the state tree: ${t.stderr.trim()}`);
      // A parent this store cannot get is a branch that moved on without it.
      if (expected && !this.ensure(slug, expected)) return { ok: false, moved: true };
      const c = this.git(["commit-tree", t.stdout.trim(), ...(expected ? ["-p", expected] : []), "-m", `deep-plan state: ${slug}`],
        { env: identityEnv(this.gitArgs) });
      if (c.status !== 0) throw new Error(`cannot commit the state: ${c.stderr.trim()}`);
      const sha = c.stdout.trim();
      const p = this.git(["push", "--porcelain", `--force-with-lease=refs/heads/${b}:${expected}`,
        this.target, `${sha}:refs/heads/${b}`], { net: true });
      if (p.status === 0 && !p.error) { this.git(["update-ref", this.track(b), sha]); return { ok: true, version: sha }; }
      if (refused(p)) return { ok: false, moved: true };
      throw this.netFail("pushing to", p);
    } finally { for (const x of [idx, tmpd]) { try { fs.rmSync(x, { force: true, recursive: true }); } catch { /* gone */ } } }
  }

  list() {
    const r = this.git(["ls-remote", "--heads", this.target, `refs/heads/${this.prefix}*`], { net: true });
    if (r.status !== 0 || r.error) throw this.netFail("listing", r);
    const head = "refs/heads/" + this.prefix;
    return r.stdout.split("\n").filter(Boolean).map(l => l.split("\t"))
      .filter(([, ref]) => ref && ref.startsWith(head) && !ref.slice(head.length).includes("/"))
      .map(([version, ref]) => ({ slug: ref.slice(head.length), version }));
  }

  // A plan that ended: its branch becomes a tag and is deleted, in one atomic
  // push leased on the version the caller read. A tag left by an earlier
  // plan of the same slug is replaced.
  archive(slug, expected) {
    const b = this.branch(slug), tag = `${ARCHIVE_PREFIX}${slug}`;
    if (!this.ensure(slug, expected)) return { ok: false, moved: true };
    const p = this.git(["push", "--porcelain", "--atomic", `--force-with-lease=refs/heads/${b}:${expected}`, this.target,
      `+${expected}:refs/tags/${tag}`, `:refs/heads/${b}`], { net: true });
    if (p.status === 0 && !p.error) { this.git(["update-ref", "-d", this.track(b)]); return { ok: true, tag }; }
    if (refused(p)) return { ok: false, moved: true };
    throw this.netFail("archiving on", p);
  }

  // Whether a plan's branch was archived: its tag is on the remote.
  archived(slug) {
    const tag = `refs/tags/${ARCHIVE_PREFIX}${slug}`;
    const r = this.git(["ls-remote", "--tags", this.target, tag], { net: true });
    if (r.status !== 0 || r.error) throw this.netFail("reading", r);
    return r.stdout.split("\n").some(l => l.endsWith("\t" + tag));
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

// The backend for a plan with this share, in the repo holding `dir`, with its config. Throws only when
// the remote names nothing; callers that must not fail catch it.
export function openBackend(share, dir = process.cwd(), opts = {}) {
  const cfg = opts.config || loadConfig(share, dir, opts.env || process.env);
  return { cfg, backend: new GitBackend(cfg, opts) };
}
