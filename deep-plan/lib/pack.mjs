// Packs (ADR 0109): a folder that sets a repo up for a stack in one step.
//
//   <dir>/pack.json
//   { "pack": "node-web", "version": "1.0.0", "describes": "…",
//     "detect": ["package.json"],          files whose presence suggests it
//     "needs": ["node", "npx"],            tools it expects on PATH
//     "recipes": [ …verify.json recipes… ],
//     "land": [ …land recipes… ],
//     "scenarios": { "harness": {…}, "style": "…" },
//     "policy": { "default": "auto-go", "paths": [ … ] },
//     "mcp": { "<server>": { "command": "…", "args": [ … ] } },
//     "skills": ["skills/<name>"] }       folders holding a SKILL.md
//
// A pack comes from deep-plan's own packs/ folder, the person's
// ~/.claude/deep-plan/packs/ (which wins on a name), a folder path, or a
// git URL, cloned to a cache. `pack add` merges each item into the repo:
//   recipes and land     .seamux/verify.json, each marked pack: <name>@<version>
//   scenarios            .seamux/scenarios.json, field by field
//   mcp                  .mcp.json, by server name
//   skills               .claude/skills/<name>
//   policy               .seamux/policy.json: whole when the repo has none;
//                        else only path entries for paths it does not cover,
//                        never above its default, and nothing it has changed
// An item the repo already has, differently, is kept and named. Each merged
// item's hash goes in .seamux/packs.json, so `pack check` shows drift (edited
// by hand, gone, or the pack changed since) and `pack update` re-merges only
// what nobody edited. The person reviews and commits what a pack wrote; a
// clone with no pack installed works the same.
//
// Edits to verify.json and policy.json touch only the array elements they
// add, replace or remove, so a hand-formatted file keeps its layout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load as loadVerify, matchesGlob } from "./verify.mjs";
import { validatePolicy, LEVELS, POLICY_REL } from "./policy.mjs";
import { scenariosConfig, SCENARIOS_REL } from "./scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKS_REL = ".seamux/packs.json";
export const BUILTIN_DIR = path.join(HERE, "..", "packs");
export const USER_DIR = () => process.env.DEEP_PLAN_PACKS_DIR || path.join(os.homedir(), ".claude", "deep-plan", "packs");
export const CACHE_DIR = () => process.env.DEEP_PLAN_PACK_CACHE || path.join(os.homedir(), ".cache", "deep-plan", "packs");
const VERIFY_FILE = ".seamux/verify.json";
const MCP_FILE = ".mcp.json";
const SKILLS_DIR = ".claude/skills";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,40}$/;
const FIELDS = ["pack", "version", "describes", "detect", "needs", "recipes", "land", "scenarios", "policy", "mcp", "skills", "$schema", "note"];
const SCN_FIELDS = ["harness", "style", "writer", "judge", "threshold"];

// ---------------------------------------------------------------- hashing

export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}
export const hashOf = v => crypto.createHash("sha256").update(stable(v)).digest("hex").slice(0, 12);
const withoutPack = r => { if (!r || typeof r !== "object") return r; const { pack, ...rest } = r; return rest; };

// A folder's files, for a skill's hash: relative path → content hash.
function treeOf(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out[r] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
    }
  };
  try { walk(dir, ""); } catch { return undefined; }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- JSON text surgery

// The span of a JSON value starting at i: the index just past it.
function skipWs(t, i) { while (i < t.length && /\s/.test(t[i])) i++; return i; }
function valueEnd(t, i) {
  const c = t[i];
  if (c === '"') { i++; while (i < t.length && t[i] !== '"') { if (t[i] === "\\") i++; i++; } return i + 1; }
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    i++;
    for (;;) {
      i = skipWs(t, i);
      if (t[i] === close) return i + 1;
      if (i >= t.length) throw new Error("unterminated JSON");
      if (c === "{") { i = valueEnd(t, i); i = skipWs(t, i); if (t[i] !== ":") throw new Error("expected :"); i = skipWs(t, i + 1); }
      i = valueEnd(t, i);
      i = skipWs(t, i);
      if (t[i] === ",") i++;
    }
  }
  while (i < t.length && !/[,\]}\s]/.test(t[i])) i++;
  return i;
}
// The top-level member `key` of the object in t: {start, end} of its value.
function memberSpan(t, key) {
  let i = skipWs(t, 0);
  if (t[i] !== "{") return null;
  i++;
  for (;;) {
    i = skipWs(t, i);
    if (t[i] === "}" || i >= t.length) return null;
    const ks = i, ke = valueEnd(t, i);
    const k = JSON.parse(t.slice(ks, ke));
    i = skipWs(t, ke) + 1;
    const vs = skipWs(t, i), ve = valueEnd(t, vs);
    if (k === key) return { start: vs, end: ve };
    i = skipWs(t, ve);
    if (t[i] === ",") i++;
  }
}
// The elements of the array spanning [start, end): [{start, end}].
function elementSpans(t, span) {
  const out = [];
  let i = span.start + 1;
  for (;;) {
    i = skipWs(t, i);
    if (t[i] === "]" || i >= span.end) return out;
    const e = valueEnd(t, i);
    out.push({ start: i, end: e });
    i = skipWs(t, e);
    if (t[i] === ",") i++;
  }
}
// The indent of the line a position is on.
const indentAt = (t, i) => { const ls = t.lastIndexOf("\n", i - 1) + 1; return (t.slice(ls, i).match(/^\s*/) || [""])[0]; };

// Edit one top-level array of a JSON file's text: ops are {replace: index,
// value}, {remove: index} or {append: value}. Everything else is kept as it was.
export function editArray(text, key, ops) {
  let t = text;
  if (!t.trim()) t = "{}\n";
  let span = memberSpan(t, key);
  if (!span) {
    // No such member yet: add it, and append into it.
    const close = t.lastIndexOf("}");
    const before = t.slice(0, close).replace(/\s*$/, "");
    const sep = /\{\s*$/.test(before) ? "" : ",";
    t = `${before}${sep}\n  ${JSON.stringify(key)}: []\n${t.slice(close)}`;
    span = memberSpan(t, key);
  }
  const els = elementSpans(t, span);
  // Replacements, marks and removals from the end, so earlier spans stay valid.
  const at = o => o.replace ?? o.remove ?? o.mark;
  const edits = ops.filter(o => at(o) !== undefined).sort((a, b) => at(b) - at(a));
  for (const o of edits) {
    const idx = at(o), e = els[idx];
    if (!e) continue;
    if (o.mark !== undefined) {
      // Only the element's "pack" member: set where it is, else put after its id.
      const el = t.slice(e.start, e.end), tag = JSON.stringify(o.tag);
      let next = el.replace(/("pack"\s*:\s*)"[^"]*"/, (m, k) => k + tag);
      if (next === el) next = el.replace(/("id"\s*:\s*"(?:[^"\\]|\\.)*")/, m => `${m}, "pack": ${tag}`);
      t = t.slice(0, e.start) + (next === el ? JSON.stringify({ ...JSON.parse(el), pack: o.tag }) : next) + t.slice(e.end);
    } else if (o.replace !== undefined) t = t.slice(0, e.start) + JSON.stringify(o.value) + t.slice(e.end);
    else {
      // Take the element and the comma on one side of it.
      let s = e.start, end = e.end;
      const after = skipWs(t, end);
      if (t[after] === ",") end = after + 1;
      else {
        let b = s - 1; while (b > span.start && /\s/.test(t[b])) b--;
        if (t[b] === ",") s = b;
      }
      t = t.slice(0, s) + t.slice(end);
    }
    span = memberSpan(t, key);
  }
  const adds = ops.filter(o => o.append !== undefined);
  if (adds.length) {
    span = memberSpan(t, key);
    const now = elementSpans(t, span);
    const last = now[now.length - 1];
    const ind = last ? indentAt(t, last.start) : "    ";
    const body = adds.map(o => JSON.stringify(o.append)).join(`,\n${ind}`);
    if (last) t = t.slice(0, last.end) + `,\n${ind}${body}` + t.slice(last.end);
    else t = t.slice(0, span.start + 1) + `\n${ind}${body}\n  ` + t.slice(span.end - 1);
  }
  return t;
}

// ---------------------------------------------------------------- loading

const isUrl = s => /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(s) || /\.git(#.*)?$/.test(s);

// A git URL's checkout in the cache, cloned or brought up to date.
function fetchUrl(spec) {
  const [url, ref] = spec.split("#");
  const dir = path.join(CACHE_DIR(), crypto.createHash("sha256").update(spec).digest("hex").slice(0, 16));
  fs.mkdirSync(CACHE_DIR(), { recursive: true });
  const git = (...a) => spawnSync("git", a, { encoding: "utf8", timeout: 120000 });
  if (fs.existsSync(path.join(dir, ".git"))) {
    const f = git("-C", dir, "fetch", "--quiet", "--depth", "1", "origin", ref || "HEAD");
    if (f.status !== 0) return { error: `git fetch ${url}: ${(f.stderr || "").trim().split("\n").pop()}` };
    git("-C", dir, "reset", "--quiet", "--hard", "FETCH_HEAD");
  } else {
    const c = git("clone", "--quiet", "--depth", "1", ...(ref ? ["--branch", ref] : []), url, dir);
    if (c.status !== 0) return { error: `git clone ${url}: ${(c.stderr || "").trim().split("\n").pop()}` };
  }
  return { dir };
}

// Where a pack named by `spec` lives: {dir, source} or {error}.
export function locate(spec) {
  if (!spec) return { error: "name a pack, a folder or a git URL" };
  if (isUrl(spec)) { const f = fetchUrl(spec); return f.error ? f : { dir: f.dir, source: spec }; }
  if (spec.includes("/") || spec.startsWith(".")) {
    const d = path.resolve(spec);
    return fs.existsSync(path.join(d, "pack.json")) ? { dir: d, source: d } : { error: `no pack.json in ${d}` };
  }
  for (const base of [USER_DIR(), BUILTIN_DIR]) {
    const d = path.join(base, spec);
    if (fs.existsSync(path.join(d, "pack.json"))) return { dir: d, source: base === BUILTIN_DIR ? `deep-plan:${spec}` : d };
  }
  return { error: `no pack "${spec}" in ${USER_DIR()} or deep-plan's packs (deep-plan pack list names them)` };
}

// Validate a pack's recipes as verify.json would, in a scratch folder.
function recipeErrors(recipes, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-pack-"));
  try {
    fs.mkdirSync(path.join(tmp, ".seamux"));
    fs.writeFileSync(path.join(tmp, VERIFY_FILE), JSON.stringify({ recipes }));
    const v = loadVerify(tmp);
    return [...v.errors, ...v.warnings].map(e => `${label}: ${e}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function validatePack(p, dir) {
  const errs = [];
  if (!p || typeof p !== "object") return ["pack.json is a JSON object"];
  for (const k of Object.keys(p)) if (!FIELDS.includes(k)) errs.push(`${k}: not a pack field`);
  if (!NAME_RE.test(String(p.pack || ""))) errs.push("pack: a name of lowercase letters, digits and dashes");
  if (!VERSION_RE.test(String(p.version || ""))) errs.push("version: like 1.0.0");
  if (typeof p.describes !== "string" || !p.describes.trim()) errs.push("describes: a sentence saying what the pack sets up");
  for (const k of ["detect", "needs"]) if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].every(x => typeof x === "string" && x.trim()))) errs.push(`${k}: a list of strings`);
  if (p.recipes !== undefined) {
    if (!Array.isArray(p.recipes)) errs.push("recipes: a list of verify.json recipes");
    else {
      if (p.recipes.some(r => r && r.kind === "land")) errs.push("recipes: a land recipe goes under land");
      errs.push(...recipeErrors(p.recipes, "recipes"));
    }
  }
  if (p.land !== undefined) {
    if (!Array.isArray(p.land) || p.land.some(r => !r || r.kind !== "land")) errs.push("land: a list of recipes of kind land");
    else errs.push(...recipeErrors(p.land, "land"));
  }
  const ids = [...(p.recipes || []), ...(p.land || [])].map(r => r && r.id);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) errs.push(`two recipes share the id "${id}"`);
  if (p.scenarios !== undefined) {
    if (!p.scenarios || typeof p.scenarios !== "object") errs.push("scenarios: an object");
    else {
      for (const k of Object.keys(p.scenarios)) if (!SCN_FIELDS.includes(k)) errs.push(`scenarios.${k}: not a scenarios field`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-pack-"));
      try {
        fs.mkdirSync(path.join(tmp, ".seamux"));
        fs.writeFileSync(path.join(tmp, SCENARIOS_REL), JSON.stringify(p.scenarios));
        errs.push(...scenariosConfig(tmp).errors.map(e => `scenarios: ${e}`));
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }
  if (p.policy !== undefined) errs.push(...validatePolicy(p.policy).map(e => `policy: ${e}`));
  if (p.mcp !== undefined && (!p.mcp || typeof p.mcp !== "object" || Array.isArray(p.mcp) ||
    Object.entries(p.mcp).some(([k, v]) => !/^[A-Za-z0-9_.-]+$/.test(k) || !v || typeof v !== "object")))
    errs.push("mcp: an object of server name → server config");
  if (p.skills !== undefined) {
    if (!Array.isArray(p.skills)) errs.push("skills: a list of folders in the pack");
    else for (const s of p.skills) {
      const d = path.resolve(dir, String(s));
      if (!d.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(path.join(d, "SKILL.md"))) errs.push(`skills: ${s} is not a folder with a SKILL.md inside the pack`);
    }
  }
  return errs;
}

export function loadPack(spec) {
  const at = locate(spec);
  if (at.error) return { error: at.error };
  let p;
  try { p = JSON.parse(fs.readFileSync(path.join(at.dir, "pack.json"), "utf8")); }
  catch (e) { return { error: `${path.join(at.dir, "pack.json")}: ${e.message}` }; }
  const errors = validatePack(p, at.dir);
  return { pack: p, dir: at.dir, source: at.source, errors };
}

// Every pack deep-plan can find by name, the person's first.
export function listPacks(root) {
  const seen = new Map();
  for (const base of [USER_DIR(), BUILTIN_DIR]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names.sort()) {
      if (seen.has(n) || !fs.existsSync(path.join(base, n, "pack.json"))) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(base, n, "pack.json"), "utf8"));
        seen.set(n, { name: p.pack || n, version: p.version || "", describes: p.describes || "",
          from: base === BUILTIN_DIR ? "deep-plan" : base, detected: root ? detected(root, p) : false });
      } catch { seen.set(n, { name: n, version: "", describes: "(pack.json does not parse)", from: base, detected: false }); }
    }
  }
  return [...seen.values()];
}
export const detected = (root, p) => (p.detect || []).some(f => fs.existsSync(path.join(root, f)));
export const missingTools = p => (p.needs || []).filter(t => spawnSync("sh", ["-c", `command -v ${JSON.stringify(t)}`], { stdio: "ignore" }).status !== 0);

// ---------------------------------------------------------------- the repo

const readText = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return null; } };
const readJson = (root, rel) => { const t = readText(root, rel); if (t === null) return null; try { return JSON.parse(t); } catch { return undefined; } };
const writeText = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text.endsWith("\n") ? text : text + "\n"); };

export function readStamp(root) { const s = readJson(root, PACKS_REL); return s && typeof s === "object" && s.packs ? s : { version: 1, packs: {} }; }
function writeStamp(root, s) { writeText(root, PACKS_REL, JSON.stringify(s, null, 2)); }

// The policy entry key for a match (a glob or a list of them).
const matchKey = m => [].concat(m).join(",");
// Whether the repo's policy already covers a pack entry's paths: an entry with
// the same match, or one whose glob takes in the pack glob's literal head.
function covered(policy, entry) {
  const mine = (policy.paths || []).map(e => [].concat(e.match));
  return [].concat(entry.match).every(g => mine.some(globs => globs.includes(g) ||
    globs.some(h => { const head = g.split(/[*?[{]/)[0].replace(/\/$/, ""); return head && matchesGlob(`${head}/x`, h); })));
}
const rankOf = l => LEVELS.indexOf(l);

// The items a pack holds, each what it would write. `policy` is the repo's
// current policy (null when there is none), which decides how the draft
// merges.
function packItems(p, dir, policy) {
  const tag = `${p.pack}@${p.version}`;
  const items = [];
  for (const r of [...(p.recipes || []), ...(p.land || [])]) items.push({ key: `recipe:${r.id}`, kind: "recipe", id: r.id, value: { ...r, pack: tag } });
  for (const k of SCN_FIELDS) if (p.scenarios && p.scenarios[k] !== undefined) items.push({ key: `scenarios:${k}`, kind: "scenarios", field: k, value: p.scenarios[k] });
  for (const [name, cfg] of Object.entries(p.mcp || {})) items.push({ key: `mcp:${name}`, kind: "mcp", name, value: cfg });
  for (const s of p.skills || []) { const name = path.basename(String(s)); items.push({ key: `skill:${name}`, kind: "skill", name, src: path.join(dir, String(s)), value: treeOf(path.join(dir, String(s))) }); }
  if (p.policy) {
    if (!policy) items.push({ key: "policy", kind: "policy", value: p.policy });
    else for (const e of p.policy.paths || []) {
      const capped = rankOf(e.level) > rankOf(policy.default) ? policy.default : e.level;
      items.push({ key: `policy:path:${matchKey(e.match)}`, kind: "policy-path", match: e.match, value: { ...e, level: capped }, asked: e.level });
    }
  }
  return items;
}

// What the repo holds now for an item, or undefined.
function current(root, item) {
  if (item.kind === "recipe") {
    const v = readJson(root, VERIFY_FILE);
    return v && Array.isArray(v.recipes) ? v.recipes.find(r => r && r.id === item.id) : undefined;
  }
  if (item.kind === "scenarios") { const s = readJson(root, SCENARIOS_REL); return s ? s[item.field] : undefined; }
  if (item.kind === "mcp") { const m = readJson(root, MCP_FILE); return m && m.mcpServers ? m.mcpServers[item.name] : undefined; }
  if (item.kind === "skill") return treeOf(path.join(root, SKILLS_DIR, item.name));
  if (item.kind === "policy") { const p = readJson(root, POLICY_REL); return p === null ? undefined : p; }
  if (item.kind === "policy-path") {
    const p = readJson(root, POLICY_REL);
    return p && Array.isArray(p.paths) ? p.paths.find(e => matchKey(e.match) === matchKey(item.match)) : undefined;
  }
  return undefined;
}
const same = (item, cur) => item.kind === "recipe" ? stable(withoutPack(cur)) === stable(withoutPack(item.value)) : stable(cur) === stable(item.value);

// Write an item (or remove it, with value undefined).
function put(root, item, value) {
  if (item.kind === "recipe") {
    const text = readText(root, VERIFY_FILE) || '{ "recipes": [] }\n';
    const list = (JSON.parse(text).recipes || []);
    const i = list.findIndex(r => r && r.id === item.id);
    // A recipe that differs only in its pack mark gets the mark alone, so its
    // own layout stays.
    const onlyMark = value !== undefined && i >= 0 && stable(withoutPack(list[i])) === stable(withoutPack(value));
    writeText(root, VERIFY_FILE, editArray(text, "recipes", [value === undefined ? { remove: i } : onlyMark ? { mark: i, tag: value.pack }
      : i >= 0 ? { replace: i, value } : { append: value }]
      .filter(o => !(o.remove !== undefined && o.remove < 0))));
  } else if (item.kind === "scenarios") {
    const s = readJson(root, SCENARIOS_REL) || {};
    if (value === undefined) delete s[item.field]; else s[item.field] = value;
    writeText(root, SCENARIOS_REL, JSON.stringify(s, null, 2));
  } else if (item.kind === "mcp") {
    const m = readJson(root, MCP_FILE) || {};
    m.mcpServers = m.mcpServers || {};
    if (value === undefined) delete m.mcpServers[item.name]; else m.mcpServers[item.name] = value;
    writeText(root, MCP_FILE, JSON.stringify(m, null, 2));
  } else if (item.kind === "skill") {
    const d = path.join(root, SKILLS_DIR, item.name);
    fs.rmSync(d, { recursive: true, force: true });
    if (value !== undefined) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.cpSync(item.src, d, { recursive: true }); }
  } else if (item.kind === "policy") {
    if (value === undefined) fs.rmSync(path.join(root, POLICY_REL), { force: true });
    else writeText(root, POLICY_REL, JSON.stringify(value, null, 2));
  } else if (item.kind === "policy-path") {
    const text = readText(root, POLICY_REL);
    const list = JSON.parse(text).paths || [];
    const i = list.findIndex(e => matchKey(e.match) === matchKey(item.match));
    writeText(root, POLICY_REL, editArray(text, "paths", [value === undefined ? { remove: i } : i >= 0 ? { replace: i, value } : { append: value }]
      .filter(o => !(o.remove !== undefined && o.remove < 0))));
  }
}
// The hash an item is stamped with: what it is in the repo.
const stampHash = (item, value) => hashOf(value);

// ---------------------------------------------------------------- the verbs

// Merge a pack into the repo. Returns {lines, errors}.
export function addPack(root, spec) {
  const L = loadPack(spec);
  if (L.error) return { errors: [L.error], lines: [] };
  if (L.errors.length) return { errors: L.errors.map(e => `${L.pack.pack || spec}: ${e}`), lines: [] };
  const p = L.pack;
  const stamp = readStamp(root);
  if (stamp.packs[p.pack]) return { errors: [`${p.pack} is already added (${stamp.packs[p.pack].version}): deep-plan pack update ${p.pack}`], lines: [] };
  const policy = readJson(root, POLICY_REL);
  if (policy === undefined) return { errors: [`${POLICY_REL} is not JSON; fix it before adding a pack`], lines: [] };
  for (const f of [VERIFY_FILE, MCP_FILE, SCENARIOS_REL]) if (readJson(root, f) === undefined) return { errors: [`${f} is not JSON; fix it before adding a pack`], lines: [] };
  const lines = [], items = {}, kept = [];
  for (const it of packItems(p, L.dir, policy)) {
    if (it.kind === "policy-path" && covered(policy, it)) { lines.push(`  kept    ${it.key}: your policy already covers it`); continue; }
    const cur = current(root, it);
    if (cur === undefined) { put(root, it, it.value); items[it.key] = stampHash(it, it.value); lines.push(`  added   ${it.key}${it.asked && it.asked !== it.value.level ? ` (at ${it.value.level}, your default; the pack asks ${it.asked})` : ""}`); }
    else if (same(it, cur)) {
      if (it.kind === "recipe" && cur.pack !== it.value.pack) put(root, it, it.value);
      items[it.key] = stampHash(it, it.value); lines.push(`  adopted ${it.key}: yours already matches`);
    } else { kept.push(it.key); lines.push(`  kept    ${it.key}: yours differs from the pack's, so it is left as it is`); }
  }
  if (p.policy && policy) {
    for (const k of ["default", "scenarios", "merge"]) if (p.policy[k] !== undefined && stable(p.policy[k]) !== stable(policy[k]))
      lines.push(`  kept    policy ${k}: yours (${JSON.stringify(policy[k] ?? null)}) stays; the pack's draft says ${JSON.stringify(p.policy[k])}`);
  }
  // `kept` names what the repo had its own way: not drift, and left alone.
  stamp.packs[p.pack] = { version: p.version, source: L.source, addedAt: new Date().toISOString(), items, ...(kept.length ? { kept } : {}) };
  writeStamp(root, stamp);
  const missing = missingTools(p);
  return { errors: [], lines: [`added ${p.pack}@${p.version} from ${L.source}: ${Object.keys(items).length} item(s) merged`, ...lines,
    ...(missing.length ? [`  needs   ${missing.join(", ")}: not on PATH here`] : []),
    `review and commit what it wrote (${[VERIFY_FILE, SCENARIOS_REL, POLICY_REL, MCP_FILE, SKILLS_DIR, PACKS_REL].join(", ")})`] };
}

// Each stamped item against the repo and the pack now: ok, edited (by hand
// since it was merged), missing, or outdated (the pack has changed since).
export function checkPacks(root, name) {
  const stamp = readStamp(root);
  const rows = [];
  const names = name ? [name] : Object.keys(stamp.packs);
  for (const n of names) {
    const s = stamp.packs[n];
    if (!s) { rows.push({ pack: n, key: "", state: "not-added" }); continue; }
    const L = loadPack(s.source && s.source.startsWith("deep-plan:") ? s.source.slice("deep-plan:".length) : s.source || n);
    const policy = readJson(root, POLICY_REL);
    // The items the pack holds now, keyed; the whole-policy item stays one
    // even once the repo has a policy (it was written whole).
    const want = new Map();
    if (!L.error) for (const it of packItems(L.pack, L.dir, s.items.policy ? null : policy)) want.set(it.key, it);
    for (const [key, h] of Object.entries(s.items)) {
      const it = want.get(key) || itemFromKey(key);
      const cur = current(root, it);
      let state = cur === undefined ? "missing" : hashOf(cur) !== h ? "edited" : "ok";
      if (state === "ok" && !L.error && (!want.has(key) || stampHash(it, want.get(key).value) !== h)) state = "outdated";
      rows.push({ pack: n, key, state });
    }
    if (!L.error) for (const [key] of want) if (!(key in s.items) && !(s.kept || []).includes(key) && !(key.startsWith("policy:path:") && policy && covered(policy, want.get(key))))
      rows.push({ pack: n, key, state: "new-in-pack" });
    if (L.error) rows.push({ pack: n, key: "", state: "unreadable", why: L.error });
  }
  return rows;
}
// An item rebuilt from its stamp key alone (the pack no longer holds it).
function itemFromKey(key) {
  const [kind, ...rest] = key.split(":");
  const v = rest.join(":");
  if (kind === "recipe") return { key, kind: "recipe", id: v };
  if (kind === "scenarios") return { key, kind: "scenarios", field: v };
  if (kind === "mcp") return { key, kind: "mcp", name: v };
  if (kind === "skill") return { key, kind: "skill", name: v };
  if (kind === "policy" && !v) return { key, kind: "policy" };
  return { key, kind: "policy-path", match: v.replace(/^path:/, "").split(",") };
}

// Re-merge what nobody edited from the pack as it is now; name the rest.
export function updatePack(root, name) {
  const stamp = readStamp(root);
  const s = stamp.packs[name];
  if (!s) return { errors: [`${name} is not added here (deep-plan pack add ${name})`], lines: [] };
  const L = loadPack(s.source && s.source.startsWith("deep-plan:") ? s.source.slice("deep-plan:".length) : s.source || name);
  if (L.error) return { errors: [L.error], lines: [] };
  if (L.errors.length) return { errors: L.errors, lines: [] };
  const policy = readJson(root, POLICY_REL);
  const want = new Map(packItems(L.pack, L.dir, s.items.policy ? null : policy).map(it => [it.key, it]));
  const items = {}, lines = [], kept = [];
  for (const [key, h] of Object.entries(s.items)) {
    const it = want.get(key) || itemFromKey(key);
    const cur = current(root, it);
    if (cur !== undefined && hashOf(cur) !== h) { items[key] = h; lines.push(`  kept    ${key}: edited by hand since it was merged`); continue; }
    if (!want.has(key)) { if (cur !== undefined) put(root, it, undefined); lines.push(`  removed ${key}: the pack no longer has it`); continue; }
    const next = want.get(key);
    if (cur === undefined || hashOf(cur) !== hashOf(next.value)) { put(root, next, next.value); lines.push(`  updated ${key}`); }
    items[key] = stampHash(next, next.value);
  }
  for (const [key, it] of want) {
    if (key in s.items) continue;
    if (it.kind === "policy-path" && policy && covered(policy, it)) continue;
    const cur = current(root, it);
    if (cur === undefined) { put(root, it, it.value); items[key] = stampHash(it, it.value); lines.push(`  added   ${key}`); }
    else if (same(it, cur)) { if (it.kind === "recipe") put(root, it, it.value); items[key] = stampHash(it, it.value); lines.push(`  adopted ${key}`); }
    else { kept.push(key); if (!(s.kept || []).includes(key)) lines.push(`  kept    ${key}: yours differs from the pack's`); }
  }
  const { kept: _k, ...rest } = s;
  stamp.packs[name] = { ...rest, version: L.pack.version, updatedAt: new Date().toISOString(), items, ...(kept.length ? { kept } : {}) };
  writeStamp(root, stamp);
  return { errors: [], lines: [`updated ${name} to ${L.pack.version}`, ...lines] };
}

// Take out what the pack merged and nobody edited; leave and name the rest.
export function removePack(root, name) {
  const stamp = readStamp(root);
  const s = stamp.packs[name];
  if (!s) return { errors: [`${name} is not added here`], lines: [] };
  const lines = [];
  for (const [key, h] of Object.entries(s.items)) {
    const it = itemFromKey(key);
    const cur = current(root, it);
    if (cur === undefined) continue;
    if (hashOf(cur) !== h) { lines.push(`  kept    ${key}: edited by hand since it was merged`); continue; }
    put(root, it, undefined);
    lines.push(`  removed ${key}`);
  }
  delete stamp.packs[name];
  writeStamp(root, stamp);
  return { errors: [], lines: [`removed ${name}`, ...lines] };
}
