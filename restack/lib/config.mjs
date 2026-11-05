// .seamux/restack.json — what this repo generates, and how to rebuild it.
//
// WHY THE CONFIG IS PER-REPO AND NOT PER-MACHINE. The knowledge here is not
// "how I like to rebase", it is "this repo checks in a GraphQL dump, a Rails
// schema and a buf-generated client, and CI fails if any of the three is
// stale". That is a property of the repo, it changes when the repo changes,
// and everyone restacking it needs the same answer. Same placement as
// `.seamux/adr.json` and `.seamux/observability.json`.
//
// TRUST. `regen` and `check.run` are shell commands read out of the working
// tree. Running the tool in a repo is therefore trusting that repo's config
// the same way you trust its Makefile or its git hooks. `--dry-run` prints
// every command without running it; `restack doctor` lists them.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CONFIG_REL = path.join(".seamux", "restack.json");

export const DEFAULTS = {
  remote: "origin",
  base: null,              // null = ask git (origin/HEAD), never a guessed name
  rerere: true,            // per-invocation `-c rerere.enabled=true`, see stack.mjs
  timeout: 900,            // seconds, per recipe/check
  stack: { tool: "auto" }, // auto | graphite | git
  artifacts: [],
  checks: [],
  // Printed, never run — see PUSH in restack.mjs. Unset, each line pins its
  // lease to the remote tip the walk recorded (pushLine in restack.mjs); a
  // command set here is printed as `<command> <remote> <branch>` instead.
  push: { command: null },
};

export const RESOLUTIONS = ["regen", "take-base", "take-branch", "union", "manual"];
export const TIERS = ["cheap", "expensive"];

// RESTACK_CONFIG wins; otherwise the branch's tracked file, else main's
// (resolveSeamux, below).
export function configPath(root) {
  return process.env.RESTACK_CONFIG || resolveSeamux(root, CONFIG_REL).path;
}

// Missing config is not an error: `status`, `plan` and the rebase walk all
// work without one — you just get no artifact classification, which is
// exactly the "plain conflicts" case. `doctor` and `init` are how you notice.
export function load(root) {
  const p = configPath(root);
  let raw = null, present = false;
  try { raw = fs.readFileSync(p, "utf8"); present = true; } catch { /* absent */ }
  if (!present) return { ...DEFAULTS, present: false, path: p, errors: [] };
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { return { ...DEFAULTS, present: true, path: p, errors: [`not valid JSON: ${e.message}`] }; }
  const cfg = {
    ...DEFAULTS, ...obj,
    stack: { ...DEFAULTS.stack, ...(obj.stack || {}) },
    push: { ...DEFAULTS.push, ...(obj.push || {}) },
    artifacts: (obj.artifacts || []).map(normalizeArtifact),
    checks: (obj.checks || []).map(normalizeCheck),
    present: true, path: p,
  };
  cfg.errors = validate(cfg);
  return cfg;
}

function normalizeArtifact(a, i) {
  return {
    name: a.name || `artifact-${i + 1}`,
    paths: Array.isArray(a.paths) ? a.paths : (a.paths ? [a.paths] : []),
    resolve: a.resolve || (a.regen ? "regen" : "take-base"),
    tier: a.tier || (a.regen ? "expensive" : "cheap"),
    regen: a.regen || "",
    note: a.note || "",
    breaks: a.breaks || "",          // free text: what a stale copy costs you in CI
  };
}
function normalizeCheck(c, i) {
  return {
    name: c.name || `check-${i + 1}`,
    run: c.run || "",
    tier: c.tier || "cheap",
    needsBase: c.needsBase !== false,  // most breaking-change checks diff against the base
    note: c.note || "",
  };
}

function validate(cfg) {
  const errs = [];
  for (const a of cfg.artifacts) {
    if (!a.paths.length) errs.push(`artifact "${a.name}": no paths`);
    // An artifact glob is a licence to resolve a conflict without asking. One
    // that matches the whole repo hands that licence to every file a human
    // wrote, so it is refused rather than warned about.
    for (const gl of a.paths)
      if (["*", "**", "**/*", "./**", "**/**"].includes(gl.trim()))
        errs.push(`artifact "${a.name}": the glob "${gl}" matches every file — name the generated paths`);
    if (!RESOLUTIONS.includes(a.resolve))
      errs.push(`artifact "${a.name}": resolve must be one of ${RESOLUTIONS.join("|")}`);
    if (!TIERS.includes(a.tier))
      errs.push(`artifact "${a.name}": tier must be cheap|expensive`);
    // The one combination that lies: "regen" with nothing to run resolves to
    // the base copy and calls it done, which is how a stale artifact ships.
    if (a.resolve === "regen" && !a.regen)
      errs.push(`artifact "${a.name}": resolve "regen" needs a regen command (or use take-base)`);
  }
  for (const c of cfg.checks) {
    if (!c.run) errs.push(`check "${c.name}": no run command`);
    if (!TIERS.includes(c.tier)) errs.push(`check "${c.name}": tier must be cheap|expensive`);
  }
  if (!["auto", "graphite", "git"].includes(cfg.stack.tool))
    errs.push("stack.tool must be auto|graphite|git");
  const pc = cfg.push && cfg.push.command;
  if (pc !== null && pc !== undefined && (typeof pc !== "string" || !pc.trim()))
    errs.push(`push.command must be a non-empty string (got ${JSON.stringify(pc)}); leave it out for the pinned-lease default`);
  return errs;
}

// -------------------------------------------------------------- globs
// A small matcher rather than a dependency: `**`, `*`, `?`, and a bare
// directory prefix meaning everything under it. Paths are git's, so always
// forward-slashed and repo-relative.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may match nothing at all, so `**/x` also matches a top-level x.
        if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export function matchesGlob(p, glob) {
  if (globToRegExp(glob).test(p)) return true;
  // A directory named on its own covers its contents: "protobuf" == "protobuf/**".
  if (!glob.includes("*") && p.startsWith(glob.replace(/\/$/, "") + "/")) return true;
  return false;
}

// The artifact a path belongs to, or null for "a human wrote this line".
export function artifactFor(cfg, p) {
  for (const a of cfg.artifacts)
    for (const g of a.paths) if (matchesGlob(p, g)) return a;
  return null;
}

export function artifactsTouching(cfg, paths) {
  const seen = new Map();
  for (const p of paths) {
    const a = artifactFor(cfg, p);
    if (!a) continue;
    if (!seen.has(a.name)) seen.set(a.name, { artifact: a, paths: [] });
    seen.get(a.name).paths.push(p);
  }
  return [...seen.values()];
}

// -------------------------------------------------------------- init
// Detection is a starting point, never an answer: every entry lands with the
// regen command blank and a TODO note, because guessing a migrate-and-dump
// for someone is how a config acquires a command nobody has ever run.
const SIGNATURES = [
  { name: "rails-schema", test: p => /(^|\/)db\/schema\.rb$/.test(p), glob: "**/db/schema.rb",
    resolve: "take-base", tier: "expensive",
    note: "TODO regen: migrate a dev DB and dump. take-base keeps the base copy; re-running your own migration re-adds your lines." },
  { name: "rails-structure", test: p => /(^|\/)db\/structure\.sql$/.test(p), glob: "**/db/structure.sql",
    resolve: "take-base", tier: "expensive", note: "TODO regen command" },
  { name: "graphql-schema", test: p => /\.graphql$/.test(p) && /schema/i.test(p), glob: null,
    resolve: "regen", tier: "expensive", note: "TODO regen command (dump the schema)" },
  { name: "graphql-json", test: p => /schema\.json$/.test(p) && /graphql|mesh/i.test(p), glob: null,
    resolve: "regen", tier: "expensive", note: "TODO regen command" },
  { name: "protobuf-generated", test: p => /_pb\.rb$|_pb2\.py$|\.pb\.go$|_pb\.d\.ts$/.test(p), glob: null,
    resolve: "regen", tier: "cheap", note: "TODO regen command (generate from the proto tree)" },
  { name: "openapi", test: p => /(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(p), glob: null,
    resolve: "regen", tier: "cheap", note: "TODO regen command" },
  { name: "lockfile", test: p => /(^|\/)(yarn\.lock|package-lock\.json|Gemfile\.lock|poetry\.lock)$/.test(p), glob: null,
    resolve: "take-base", tier: "cheap",
    note: "take-base then re-resolve deps; a hand-merged lockfile is a lockfile that locks nothing" },
];

const MAX_LISTED = 50;

export function detect(files) {
  const out = [];
  for (const sig of SIGNATURES) {
    const hits = dedupe(files.filter(sig.test));
    if (!hits.length) continue;
    // A few files are listed as themselves; a generated tree is collapsed to
    // one glob. Thirty-two paths in a config is a config nobody maintains,
    // and the real repos this was tried on produce exactly that.
    const collapsed = sig.glob || (hits.length > 3 ? summarize(hits) : null);
    const paths = collapsed ? [collapsed] : hits.slice(0, MAX_LISTED);
    out.push({
      name: sig.name, paths,
      resolve: sig.resolve, tier: sig.tier, regen: "",
      note: sig.note
        + (collapsed && hits.length > 3
          ? ` (matched ${hits.length} files; \`restack doctor\` shows what the glob actually covers)` : "")
        + (!collapsed && hits.length > MAX_LISTED
          ? ` (${hits.length} files matched and they share no directory or naming convention — the first ${MAX_LISTED} are listed; narrow this by hand)` : ""),
    });
  }
  return out;
}
function dedupe(a) { return [...new Set(a)].sort(); }

// The narrowest glob that covers every hit: their common directory, plus the
// longest suffix their basenames share. BOTH halves are required, and when
// either is missing this returns null and the caller lists the files instead.
//
// Tried against a real monolith, the earlier version of this collapsed two
// signatures whose hits shared neither a directory nor a suffix all the way
// down to `**/*`. That is not a cosmetic bug: every path in the repo would
// then classify as generated, and the engine would "resolve" a human's
// conflict by regenerating something. A wide glob here is the one mistake
// this tool must not make, so the degenerate answer is no answer.
export function summarize(hits) {
  const dirs = hits.map(h => h.split("/").slice(0, -1));
  let common = dirs[0] || [];
  for (const d of dirs)
    common = common.filter((seg, i) => d[i] === seg);
  const bases = hits.map(h => h.split("/").pop());
  let suffix = bases[0] || "";
  for (const b of bases) {
    while (suffix && !b.endsWith(suffix)) suffix = suffix.slice(1);
  }
  // A suffix that starts mid-word ("_pb.rb" is a convention, "b.rb" is a
  // coincidence) is trimmed forward to its FIRST separator.
  const cut = suffix.search(/[._-]/);
  if (cut > 0) suffix = suffix.slice(cut);
  const dir = common.join("/");
  if (!dir || suffix.length < 3) return null;
  return `${dir}/**/*${suffix}`;
}

// ------------------------------------------------- .seamux file resolution
// Where a .seamux file is read from (ADR 0068). A file git tracks in this
// worktree is the branch's own, read where it is. Any other path maps to the
// same place under the main checkout (the parent of the shared .git), so
// ignored .seamux folders in many worktrees read one copy. A nested project
// folder (ops/.seamux/...) maps to the same relative path. Outside git, in
// the main checkout, or with a git dir not named .git, the path is used as
// given. Returns { path, from: "checkout" | "branch" | "main", warning }; the
// warning names an untracked worktree copy that differs from main's, and is
// printed to stderr once per file unless { warn: false }.
//
// The same function is copied into deep-plan/lib/host.mjs,
// lookout/lib/host.mjs and restack/lib/config.mjs (ADR 0004); the probes
// check the copies agree. Change all three together.
const seamuxGit = new Map(), seamuxSeen = new Map(), seamuxWarned = new Set();
export function resolveSeamux(root, rel, { warn = true } = {}) {
  // The path as given is what callers print and compare; the real path is
  // only for placing it against git's (resolved) top level.
  const given = path.resolve(root || "."), abs = path.join(given, rel);
  if (seamuxSeen.has(abs)) return seamuxSeen.get(abs);
  let base = given;
  try { base = fs.realpathSync(given); } catch { /* a folder not made yet: as given */ }
  const plain = { path: abs, from: "checkout", warning: "" };
  if (!seamuxGit.has(base)) {
    const r = spawnSync("git", ["-C", base, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { encoding: "utf8", timeout: 5000 });
    const [top, common] = r.status === 0 ? r.stdout.trim().split("\n") : [];
    seamuxGit.set(base, top && common ? { top, main: path.basename(common) === ".git" ? path.dirname(common) : "" } : null);
  }
  const g = seamuxGit.get(base);
  const inTop = g && path.relative(g.top, path.join(base, rel));
  let out = plain;
  if (g && g.main && g.main !== g.top && inTop && !inTop.startsWith("..") && !path.isAbsolute(inTop)) {
    const tracked = spawnSync("git", ["-C", g.top, "ls-files", "--error-unmatch", "--", inTop],
      { encoding: "utf8", timeout: 5000 }).status === 0;
    if (tracked) out = { path: abs, from: "branch", warning: "" };
    else {
      const mp = path.join(g.main, inTop);
      const read = p => { try { return fs.readFileSync(p); } catch { return null; } };
      const mine = read(abs), theirs = mine === null ? null : read(mp);
      const warning = mine !== null && (theirs === null || !mine.equals(theirs))
        ? `seamux: ${abs} is not tracked and differs from the main checkout's copy; reading ${mp}` : "";
      out = { path: mp, from: "main", warning };
    }
  }
  seamuxSeen.set(abs, out);
  if (warn && out.warning && !seamuxWarned.has(abs)) { seamuxWarned.add(abs); console.error(out.warning); }
  return out;
}
