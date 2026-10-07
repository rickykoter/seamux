// .seamux/verify.json — how a project proves a change works.
//
// A recipe is a check the engine can run: a test suite, an e2e run against a
// deployed preview, a query against an observability stack. Recipes live
// beside the code they verify, the way a project owns its package.json or
// go.mod, so a monorepo keeps one file per project and they move with it.
//
//   { "recipes": [
//       { "id": "unit", "kind": "test", "run": "npm test",
//         "match": ["src/**"], "default": true },
//       { "id": "e2e", "kind": "e2e", "tier": "expensive", "steps": [
//           { "acquire": "git push -u origin HEAD", "note": "opens a preview" },
//           { "wait": "scripts/preview-url.sh", "export": "BASE_URL", "timeout": 1200 },
//           { "run": "npx playwright test" } ] } ] }
//
// RESOLUTION. A file lands on the config of its nearest ancestor directory
// holding `.seamux/verify.json`. The root's recipes are inherited unless that
// config redefines the same id; configs in between are not. `match` globs and
// `cwd` are relative to the directory holding the config — the project — so
// `match: ["src/**"]` in apps/web/ means apps/web/src/**.
//
// TRUST. Every step is a shell command read out of the working tree. Running
// a repo's recipes is trusting it the way you trust its Makefile. `verify
// resolve` prints what would apply without running anything.
//
// The glob matcher is copied from restack/lib/config.mjs rather than imported:
// each plugin installs from its own source directory, so deep-plan cannot
// reach restack's lib at runtime (ADR 0004).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const VERIFY_REL = path.join(".seamux", "verify.json");
export const RECIPE_KINDS = ["test", "e2e", "observability"];
export const TIERS = ["cheap", "expensive"];
export const STEP_KINDS = ["acquire", "wait", "run"];
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
// Seconds. A recipe's timeout bounds each run step; a wait step has its own,
// because a deploy is slower than a test suite and polls rather than runs.
export const DEFAULT_TIMEOUT = 900;
export const DEFAULT_WAIT = { timeout: 1200, interval: 15 };

// -------------------------------------------------------------- globs
// A small matcher rather than a dependency: `**`, `*`, `?`, and a bare
// directory prefix meaning everything under it. Paths are forward-slashed and
// relative to the directory the glob was written in.
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

// -------------------------------------------------------------- load

const posix = p => p.split(path.sep).join("/");

// A recipe as the engine runs it: every field present, `run` shorthand
// expanded to one step, `match` always an array. Invalid input is kept as
// written so the error can name it; `validateRecipe` says what is wrong.
function normalizeRecipe(r) {
  const steps = Array.isArray(r.steps) ? r.steps.map(normalizeStep)
    : (r.run !== undefined ? [normalizeStep({ run: r.run })] : []);
  const remote = steps.some(s => s.kind === "acquire" || s.kind === "wait");
  return {
    id: r.id === undefined ? "" : String(r.id),
    kind: r.kind || "test",
    name: r.name || String(r.id || ""),
    // A recipe that waits on a deploy can outlast any foreground command, so
    // it runs detached unless the author says otherwise (and validation then
    // refuses that, rather than let an inline run hang).
    tier: r.tier || (remote ? "expensive" : "cheap"),
    match: r.match === undefined ? [] : (Array.isArray(r.match) ? r.match : [r.match]),
    default: r.default === true,
    cwd: r.cwd === undefined ? "." : r.cwd,
    timeout: r.timeout === undefined ? DEFAULT_TIMEOUT : r.timeout,
    steps,
    note: r.note || "",
    _raw: r,
  };
}

function normalizeStep(s) {
  const kinds = STEP_KINDS.filter(k => s && s[k] !== undefined);
  const kind = kinds.length === 1 ? kinds[0] : "";
  const out = { kind, command: kind ? s[kind] : "", note: (s && s.note) || "" };
  if (s && s.export !== undefined) out.export = s.export;
  if (kind === "wait") {
    out.timeout = s.timeout === undefined ? DEFAULT_WAIT.timeout : s.timeout;
    out.interval = s.interval === undefined ? DEFAULT_WAIT.interval : s.interval;
  } else if (s && s.timeout !== undefined) out.timeout = s.timeout;
  if (kinds.length !== 1) out._kinds = kinds;
  return out;
}

function validateRecipe(r, i) {
  const errs = [];
  const label = `recipe ${r.id ? `"${r.id}"` : `#${i + 1}`}`;
  const raw = r._raw;
  if (!r.id) errs.push(`${label}: id is required`);
  else if (!ID_RE.test(r.id)) errs.push(`${label}: id must be letters, digits, dot, dash or underscore`);
  if (!RECIPE_KINDS.includes(r.kind)) errs.push(`${label}: kind must be one of ${RECIPE_KINDS.join("|")}`);
  if (!TIERS.includes(r.tier)) errs.push(`${label}: tier must be cheap|expensive`);
  if (raw.run !== undefined && raw.steps !== undefined) errs.push(`${label}: give run or steps, not both`);
  if (!r.steps.length) errs.push(`${label}: nothing to run — give run or steps`);
  if (r.match.some(g => typeof g !== "string" || !g.trim())) errs.push(`${label}: match must be glob strings`);
  if (raw.default !== undefined && typeof raw.default !== "boolean") errs.push(`${label}: default must be true or false`);
  if (typeof r.cwd !== "string" || path.isAbsolute(r.cwd) || posix(path.normalize(r.cwd)).startsWith(".."))
    errs.push(`${label}: cwd must be a path inside the project`);
  if (!(typeof r.timeout === "number" && r.timeout > 0)) errs.push(`${label}: timeout must be a positive number of seconds`);
  // Order is the protocol: what the human does (acquire), what the engine
  // waits for (wait), what it then runs (run). `check run --from wait`
  // resumes at the first wait, which only means something in this order.
  let stage = 0;
  r.steps.forEach((s, k) => {
    const at = `${label} step ${k + 1}`;
    if (!s.kind) {
      errs.push(`${at}: needs exactly one of ${STEP_KINDS.join("|")}` +
        (s._kinds && s._kinds.length ? ` (has ${s._kinds.join(" and ")})` : ""));
      return;
    }
    if (typeof s.command !== "string" || !s.command.trim()) errs.push(`${at}: ${s.kind} must be a command string`);
    const st = STEP_KINDS.indexOf(s.kind);
    if (st < stage) errs.push(`${at}: ${s.kind} after ${STEP_KINDS[stage]} — steps go acquire, then wait, then run`);
    stage = Math.max(stage, st);
    if (s.export !== undefined) {
      if (s.kind === "acquire") errs.push(`${at}: an acquire step is run by a person, so it cannot export`);
      else if (typeof s.export !== "string" || !ENV_RE.test(s.export))
        errs.push(`${at}: export must be an env var name (A-Z, 0-9, _)`);
    }
    if (s.timeout !== undefined && !(typeof s.timeout === "number" && s.timeout > 0))
      errs.push(`${at}: timeout must be a positive number of seconds`);
    if (s.kind === "wait" && !(typeof s.interval === "number" && s.interval > 0))
      errs.push(`${at}: interval must be a positive number of seconds`);
  });
  if (r.steps.length && !r.steps.some(s => s.kind === "run"))
    errs.push(`${label}: needs a run step — waiting on a deploy proves nothing until something runs against it`);
  if (r.tier === "cheap" && r.steps.some(s => s.kind === "acquire" || s.kind === "wait"))
    errs.push(`${label}: a recipe with acquire or wait steps must be expensive — a deploy wait outlasts an inline run`);
  return errs;
}

// One config file. Missing is not an error — most directories have none, and
// a repo with none at all still plans; it just infers no checks.
export function load(dir) {
  const p = path.join(dir, VERIFY_REL);
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch { return { present: false, path: p, dir, recipes: [], errors: [] }; }
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { return { present: true, path: p, dir, recipes: [], errors: [`not valid JSON: ${e.message}`] }; }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.recipes))
    return { present: true, path: p, dir, recipes: [], errors: ['expected { "recipes": [ … ] }'] };
  const recipes = obj.recipes.map(r => normalizeRecipe(r && typeof r === "object" ? r : {}));
  const errors = recipes.flatMap(validateRecipe);
  const ids = recipes.map(r => r.id).filter(Boolean);
  for (const id of new Set(ids.filter((x, k) => ids.indexOf(x) !== k)))
    errors.push(`two recipes share the id "${id}"`);
  return { present: true, path: p, dir, recipes, errors };
}

// -------------------------------------------------------------- resolve

// What a recipe is, for telling whether it changed: everything that decides
// what runs and where. A check records this at render; a recipe edited after
// the plan was reviewed then no longer matches what was reviewed.
export function recipeHash(r, dir) {
  const { _raw, ...rest } = r;
  const steps = rest.steps.map(({ _kinds, ...s }) => s);
  return crypto.createHash("sha256")
    .update(JSON.stringify({ ...rest, steps, dir })).digest("hex").slice(0, 12);
}

// Where a path sits relative to the root, forward-slashed; null when it is
// outside it (a deliverable naming a file in another repo verifies nothing here).
export function relToRoot(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return posix(rel);
}

// The nearest directory at or above the file (stopping at the root) whose
// config file exists. The file itself need not exist yet: a plan names files
// it is about to create.
function nearestDir(root, rel) {
  let d = path.dirname(path.join(root, rel));
  for (;;) {
    if (fs.existsSync(path.join(d, VERIFY_REL))) return d;
    if (path.resolve(d) === path.resolve(root)) return null;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// A resolver over one root, loading each config once.
export function resolver(root) {
  root = path.resolve(root);
  const cache = new Map();
  const cfg = dir => {
    if (!cache.has(dir)) cache.set(dir, load(dir));
    return cache.get(dir);
  };

  // Every recipe that can apply to files under `dir`'s config: its own, then
  // the root's not redefined there. Each carries where it came from and its
  // hash; `key` tells two projects' same-named recipes apart.
  const available = dir => {
    const own = cfg(dir);
    const out = own.recipes.filter(r => r.id).map(r => describe(r, dir, false));
    if (dir !== root) {
      const ids = new Set(out.map(r => r.id));
      for (const r of cfg(root).recipes)
        if (r.id && !ids.has(r.id)) out.push(describe(r, root, true));
    }
    return out;
  };
  const describe = (r, dir, inherited) => {
    const project = posix(path.relative(root, dir));
    const { _raw, ...clean } = r;
    return { ...clean, steps: clean.steps.map(({ _kinds, ...s }) => s),
      key: project ? `${r.id}@${project}` : r.id,
      project, source: posix(path.relative(root, path.join(dir, VERIFY_REL))),
      inherited, hash: recipeHash(r, project) };
  };

  // One file: the config it lands on, and the recipes whose match covers it
  // (a recipe with no match covers its whole project).
  const file = f => {
    const rel = relToRoot(root, f);
    if (rel === null) return { file: f, rel: null, config: null, recipes: [], outside: true };
    const dir = nearestDir(root, rel);
    if (!dir) return { file: f, rel, config: null, recipes: [] };
    const recipes = available(dir).filter(r => {
      const base = r.project ? path.join(root, r.project) : root;
      const local = posix(path.relative(base, path.join(root, rel)));
      if (local.startsWith("..")) return false;
      return !r.match.length || r.match.some(g => matchesGlob(local, g));
    });
    return { file: f, rel, config: posix(path.relative(root, path.join(dir, VERIFY_REL))), recipes };
  };

  // Config errors anywhere resolution looked, so a broken file is never
  // silently read as "no recipes".
  const errors = () => [...cache.values()].flatMap(c =>
    c.errors.map(e => `${posix(path.relative(root, c.path))}: ${e}`));

  return { root, file, available, errors, load: cfg };
}

// The deliverable view: each file's landing, and the distinct recipes across
// them, keyed so apps/web's `unit` and apps/api's `unit` stay two checks.
export function resolveFiles(root, files) {
  const R = resolver(root);
  const rows = files.map(R.file);
  const recipes = new Map();
  for (const row of rows) for (const r of row.recipes) if (!recipes.has(r.key)) recipes.set(r.key, r);
  return { root: R.root, files: rows, recipes: [...recipes.values()], errors: R.errors() };
}
