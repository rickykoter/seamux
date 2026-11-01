// The End state map's model: the plan's files as cards, and one hop of the
// code around them. Built once, at render, and stored as st.map; every
// surface (and rehydrate) draws from that stored copy and never reads the
// repo again, so a planned file appearing on disk cannot change a page.
//
// A card is a planned path: the increments that list it, its change (remove
// when the author declared it, else new or modify from the disk the first
// time render saw it, kept after that), the facts whose evidence cites it and
// the contracts whose `at` names it. Neighbours are the files that reference
// it (used by) and the files its own imports name (uses), capped per side.
//
// The data is portable on purpose (a later multiplayer plan reads it): paths
// are relative to the plan root, a card's id is its path, and nothing in the
// model names this machine.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planFiles } from "./state.mjs";

export const MAP_VERSION = 1;
export const NEIGHBOUR_CAP = 6;

// Lookout's reference rules (lookout/lib/group.mjs), copied: ADR 0004 keeps
// plugins from importing each other. Keep the two in step.
// Names too common to mean "this file" when another file mentions them.
export const VAGUE = new Set(["index", "main", "utils", "util", "types", "test", "tests", "mod", "init",
  "__init__", "readme", "lib", "app", "config", "setup", "common", "helpers", "constants"]);
// Docs and data name files in prose and lists; only code is a reference source.
const NOT_CODE = /\.(md|mdx|txt|rst|adoc|json|jsonl|ya?ml|toml|ini|cfg|lock|csv|svg|html?|css)$/i;
export const isCode = p => !NOT_CODE.test(p);
const TEXT_CAP = 200_000;
const stem = p => path.basename(p).replace(/\.[^.]+$/, "");
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// How code names `target`: inside a string or after a slash, by its shortest
// path suffix no other planned file shares; a relative import of its stem;
// a Python import of its module. Returns the regex and the fixed strings a
// git grep can pre-filter on.
function refForms(target, planned) {
  const segs = target.split("/");
  // An extensionless name (a bin shim) is a word as often as a file: keep its folder.
  let k = !path.basename(target).includes(".") && segs.length > 1 ? 2 : 1;
  const suffix = n => segs.slice(-n).join("/");
  while (k < segs.length && planned.some(o => o !== target && (o === suffix(k) || o.endsWith("/" + suffix(k))))) k++;
  const base = suffix(k);
  const s = stem(target);
  const forms = [`[\\'"\`/]${escapeRe(base)}(?![A-Za-z0-9_.-])`];
  const fixed = [base];
  if (s.length >= 3 && !VAGUE.has(s.toLowerCase()) && s !== path.basename(target)) {
    forms.push(`['"\`](?:\\.{1,2}/|[\\w@.-]+/)+${escapeRe(s)}['"\`]`);
    // The pre-filter is as narrow as the form: a relative import always has
    // "/stem" in it, so a short stem (map, state) does not match the repo.
    fixed.push("/" + s);
    if (/\.py$/.test(target)) {
      forms.push(`(?:^|\\n)\\s*(?:from|import)\\s+[\\w.]*\\b${escapeRe(s)}\\b`);
      fixed.push(s);
    }
  }
  return { re: new RegExp(forms.join("|")), fixed };
}

// The paths a file's own imports name, resolved against the plan root.
// Relative JS/TS imports and requires, and Python relative imports. A path
// that does not resolve to a file on disk is dropped: probe fixtures and
// examples name files that do not exist.
const JS_EXT = ["", ".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".json", "/index.mjs", "/index.js", "/index.ts"];
export function importsOf(rel, text, root) {
  const out = new Set();
  const dir = path.posix.dirname(rel);
  const add = cand => {
    const norm = path.posix.normalize(cand);
    if (norm.startsWith("..") || norm === rel) return false;
    try { if (fs.statSync(path.join(root, norm)).isFile()) { out.add(norm); return true; } } catch { /* not there */ }
    return false;
  };
  if (/\.(m?[jt]sx?|cjs)$/.test(rel)) {
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gm;
    for (const m of text.matchAll(re)) JS_EXT.some(e => add(path.posix.join(dir, m[2] + e)));
  } else if (/\.py$/.test(rel)) {
    for (const m of text.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\b/gm)) {
      let base = dir;
      for (let i = 1; i < m[1].length; i++) base = path.posix.dirname(base);
      const mod = m[2] ? m[2].replace(/\./g, "/") : "";
      if (mod) add(path.posix.join(base, mod + ".py")) || add(path.posix.join(base, mod, "__init__.py"));
    }
  }
  return [...out];
}

const read = (root, rel) => {
  try { return fs.readFileSync(path.join(root, rel), "utf8").slice(0, TEXT_CAP); } catch { return ""; }
};

// A side's list, sorted and capped: { paths, more }.
const capped = list => {
  const all = [...new Set(list)].sort();
  return { paths: all.slice(0, NEIGHBOUR_CAP), more: Math.max(0, all.length - NEIGHBOUR_CAP) };
};

// Whether `root` is inside a git work tree.
function inGit(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

// Tracked code files that mention any of `fixed`, one git grep for the lot.
// Tracked only: a scratch file is not a neighbour worth freezing into state.
// -z, so a name with non-ASCII bytes comes back as itself, not quoted.
function grepCandidates(root, fixed) {
  if (!fixed.length) return [];
  const args = ["-C", root, "grep", "-l", "-z", "-I", "-F", ...fixed.flatMap(f => ["-e", f]), "--", "."];
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return []; // 1: no match
  return r.stdout.split("\0").filter(Boolean).filter(isCode);
}

// Whether `rel` existed at commit `sha` (the plan's first go). null when
// that cannot be asked: no sha, or not a git checkout.
function atBase(root, sha, rel) {
  if (!sha) return null;
  const r = spawnSync("git", ["-C", root, "cat-file", "-e", `${sha}:./${rel}`], { encoding: "utf8" });
  if (r.status === 0) return true;
  const ok = spawnSync("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`], { encoding: "utf8" });
  return ok.status === 0 ? false : null;
}

// The model. `prior` is the st.map a previous render stored, or null;
// `base` is the commit the plan's first increment started from, when it has one.
export function buildMap(spec, root, prior = null, base = "") {
  // The first base this plan's map saw stays its base: a reset and a fresh
  // go, or increments taken out of order, must not move it.
  base = (prior && prior.base) || base || "";
  const byPath = new Map();
  (spec.deliverables || []).forEach((d, i) => {
    for (const f of planFiles(d)) {
      if (!f.path) continue;
      const c = byPath.get(f.path) || { id: f.path, path: f.path, increments: [], declared: null };
      if (!c.increments.includes(i + 1)) c.increments.push(i + 1);
      if (f.change) c.declared = f.change;
      byPath.set(f.path, c);
    }
  });
  const planned = [...byPath.keys()];
  const was = new Map(((prior && prior.cards) || []).map(c => [c.path, c.change]));
  const cites = (ev, p) => ev === p || ev.startsWith(p + ":");

  const cards = planned.map(p => {
    const c = byPath.get(p);
    // Inferred once: a path an earlier render recorded keeps its new or
    // modify, so a file the plan created does not flip to modify midway.
    const kept = was.get(p);
    // The base commit answers for a plan already under way, and answers the
    // same on every render. Before the first go there is none, so the first
    // render's look at the disk is kept: a file the plan creates later must
    // not flip to modify.
    const before = atBase(root, base, p);
    const change = c.declared ||
      (before !== null ? (before ? "modify" : "new") : null) ||
      (kept && kept !== "remove" ? kept : null) ||
      (fs.existsSync(path.join(root, p)) ? "modify" : "new");
    return {
      id: p, path: p, increments: c.increments, change,
      facts: (spec.verifiedFacts || []).map((v, i) => ({ i, claim: v.claim || "", evidence: String(v.evidence || "") }))
        .filter(v => cites(v.evidence, p)),
      contracts: (spec.contracts || []).map((k, i) => ({ i, surface: k.surface || "", kind: k.kind || "", change: k.change || "", at: k.at }))
        .filter(k => Array.isArray(k.at) && k.at.includes(p)).map(({ at, ...k }) => k),
      usedBy: { paths: [], more: 0 }, uses: { paths: [], more: 0 }, links: [],
    };
  });
  // The tray: every contract no card carries. An at may name a file a fact
  // cites but no deliverable lists; it has no card, so it waits here, its at kept.
  const onCard = new Set(cards.flatMap(c => c.contracts.map(k => k.i)));
  const unplaced = (spec.contracts || []).map((k, i) => ({ i, surface: k.surface || "", kind: k.kind || "", change: k.change || "",
    ...(Array.isArray(k.at) && k.at.length ? { at: k.at } : {}) })).filter(k => !onCard.has(k.i));

  const model = { version: MAP_VERSION, slug: spec.slug, base, neighbours: true, why: "", cards, unplaced };
  if (!inGit(root)) {
    model.neighbours = false;
    model.why = "the plan root is not a git work tree, so no neighbours were looked for";
    return model;
  }

  // Used by: one git grep for every planned file's fixed strings, then each
  // candidate's text tested against each target's reference forms.
  const forms = new Map(planned.map(p => [p, refForms(p, planned)]));
  const cand = grepCandidates(root, [...new Set([...forms.values()].flatMap(f => f.fixed))]);
  const usedBy = new Map(planned.map(p => [p, []]));
  for (const src of cand) {
    const text = read(root, src);
    if (!text) continue;
    for (const [p, f] of forms) if (src !== p && f.re.test(text)) usedBy.get(p).push(src);
  }
  const plannedSet = new Set(planned);
  for (const card of cards) {
    const users = usedBy.get(card.path);
    // A planned file that uses another planned file is a link inside the
    // plan's lane, not a neighbour.
    const own = card.path;
    card.usedBy = capped(users.filter(u => !plannedSet.has(u)));
    const uses = isCode(own) ? importsOf(own, read(root, own), root) : [];
    card.uses = capped(uses.filter(u => !plannedSet.has(u)));
    card.links = [...new Set([...uses.filter(u => plannedSet.has(u) && u !== own),
      ...planned.filter(q => q !== own && (usedBy.get(q) || []).includes(own))])].sort();
  }
  return model;
}
