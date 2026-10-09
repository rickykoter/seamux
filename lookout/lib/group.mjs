// Which changed files belong together: the second sort key, after risk.
//
// Grouping is a list of EDGE PROVIDERS. Each one is
//
//     { name, needsText, edges(files, ctx) -> [{ a, b, why, weight }] }
//
// where a and b are changed paths, why is the sentence the page shows on the
// group's rail, and weight is in (0,1]. Groups are the connected components of
// every provider's edges at or above LINK_WEIGHT; nothing else knows how an
// edge was found. A new provider — a Jev provider that asks which files
// change together, say — is one more entry in PROVIDERS and one more name
// in `.seamux/lookout.json` "edgeProviders"; the grouping, the store and the
// page do not change.
//
// ctx: { text(path) -> the file's new-side text or "", findings }.
import path from "node:path";

export const LINK_WEIGHT = 0.5;

const stem = p => path.basename(p).replace(/\.[^.]+$/, "");
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Names too common to mean "this file" when another file mentions them.
const VAGUE = new Set(["index", "main", "utils", "util", "types", "test", "tests", "mod", "init",
  "__init__", "readme", "lib", "app", "config", "setup", "common", "helpers", "constants"]);

// Docs and data name files in prose and lists; reading them as references
// links everything a README mentions. Only code is a reference source.
const NOT_CODE = /\.(md|mdx|txt|rst|adoc|json|jsonl|ya?ml|toml|ini|cfg|lock|csv|svg|html?|css)$/i;
export const isCode = p => !NOT_CODE.test(p);

// A code file that names another changed file the way code does: inside a
// string or after a slash (an import, a require, a path it opens, a source
// line, a path in a comment), or a Python import of its module name.
// Bounded on purpose: it is one regex per target over every source's text,
// so past these sizes a sweeping change (a rename across a monorepo) would
// stall the open. Over the file cap it finds nothing and the other providers
// still group; each source is read up to the text cap.
export const REF_MAX_FILES = 300;
const REF_TEXT_CAP = 200_000;
const references = {
  name: "references",
  needsText: true,
  edges(files, ctx) {
    const out = [];
    if (files.length > REF_MAX_FILES) return out;
    const targets = files.map(f => {
      // The shortest path suffix no other changed file shares: two changed
      // READMEs are crew/README.md and board/README.md, never README.md. An
      // extensionless name (a bin shim, a hook) is a word as often as it is a
      // file, so it always comes with its folder: bin/lookout, not lookout.
      const segs = f.path.split("/");
      let k = !path.basename(f.path).includes(".") && segs.length > 1 ? 2 : 1;
      const suffix = n => segs.slice(-n).join("/");
      while (k < segs.length && files.some(o => o !== f && (o.path === suffix(k) || o.path.endsWith("/" + suffix(k))))) k++;
      const base = escapeRe(suffix(k));
      const s = stem(f.path);
      const forms = [`[\\'"\`/]${base}(?![A-Za-z0-9_.-])`];
      if (s.length >= 3 && !VAGUE.has(s.toLowerCase()) && s !== path.basename(f.path)) {
        // A relative import names a path ("./patch", "../lib/patch"); a bare
        // "patch" string is a package, or just a word.
        forms.push(`['"\`](?:\\.{1,2}/|[\\w@.-]+/)+${escapeRe(s)}['"\`]`);
        if (/\.py$/.test(f.path)) forms.push(`(?:^|\\n)\\s*(?:from|import)\\s+[\\w.]*\\b${escapeRe(s)}\\b`);
      }
      return { f, re: new RegExp(forms.join("|")) };
    });
    for (const a of files) {
      if (!isCode(a.path)) continue;
      const text = (ctx.text(a.path) || "").slice(0, REF_TEXT_CAP);
      if (!text) continue;
      for (const { f: b, re } of targets) {
        if (a === b || !re.test(text)) continue;
        out.push({ a: a.path, b: b.path, weight: 1, why: `${path.basename(a.path)} references ${path.basename(b.path)}` });
      }
    }
    return out;
  },
};

// foo.test.js ↔ foo.js, test_foo.py ↔ foo.py, foo_test.go ↔ foo.go,
// spec/foo_spec.rb ↔ foo.rb, and a probe.mjs with the code under its folder.
const testPair = {
  name: "test-pair",
  needsText: false,
  edges(files) {
    const out = [];
    const core = p => stem(p).replace(/^test_|[._-](test|spec)$|_probe$/i, "").replace(/\.(test|spec)$/i, "").toLowerCase();
    const isTest = p => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|_test\.go$|probe\.mjs$|_probe\.[^/]+$/i.test(p);
    const tests = files.filter(f => isTest(f.path)), srcs = files.filter(f => !isTest(f.path));
    for (const t of tests) {
      const c = core(t.path);
      for (const s of srcs) {
        // A probe.mjs tests the folder it sits in (a seamux plugin's probe).
        const probeOf = path.basename(t.path) === "probe.mjs" && s.path.startsWith(path.dirname(t.path) + "/");
        if (!isCode(s.path)) continue;
        if ((c && core(s.path) === c) || probeOf)
          out.push({ a: t.path, b: s.path, weight: 1, why: `${path.basename(t.path)} tests ${path.basename(s.path)}` });
      }
    }
    return out;
  },
};

// Two files a finding ties together: a finding on one that names the other.
const sharedFinding = {
  name: "shared-finding",
  needsText: false,
  edges(files, ctx) {
    const out = [];
    for (const x of ctx.findings || []) {
      if (!files.some(f => f.path === x.file)) continue;
      const text = `${x.summary || ""} ${x.failure_scenario || ""}`;
      for (const f of files) {
        if (f.path === x.file) continue;
        if (text.includes(f.path) || new RegExp(`(^|[^\\w-])${escapeRe(path.basename(f.path))}(?![\\w-])`).test(text))
          out.push({ a: x.file, b: f.path, weight: 0.8, why: `finding ${x.id || ""} on ${path.basename(x.file)} names ${path.basename(f.path)}`.replace("  ", " ") });
      }
    }
    return out;
  },
};

// Files side by side in a small changed directory. Weak on purpose: a folder
// with many changed files is a feature's worth of work, and linking all of
// it would make one group of everything.
const SAME_DIR_MAX = 4;
const sameDir = {
  name: "same-dir",
  needsText: false,
  edges(files) {
    const by = new Map();
    for (const f of files) {
      const d = path.dirname(f.path);
      if (d === ".") continue;
      if (!by.has(d)) by.set(d, []);
      by.get(d).push(f);
    }
    const out = [];
    for (const [d, fs] of by) {
      if (fs.length < 2 || fs.length > SAME_DIR_MAX) continue;
      for (let i = 1; i < fs.length; i++)
        out.push({ a: fs[0].path, b: fs[i].path, weight: 0.5, why: `both in ${d}/` });
    }
    return out;
  },
};

export const PROVIDERS = { references, "test-pair": testPair, "shared-finding": sharedFinding, "same-dir": sameDir };
export const DEFAULT_PROVIDERS = ["references", "test-pair", "shared-finding", "same-dir"];

// Run the named providers. Unknown names are skipped and reported, never fatal.
export function edges(files, ctx, names = DEFAULT_PROVIDERS) {
  const out = [], unknown = [];
  for (const n of names) {
    const p = PROVIDERS[n];
    if (!p) { unknown.push(n); continue; }
    try {
      for (const e of p.edges(files, ctx) || [])
        if (e && e.a !== e.b && e.weight > 0) out.push({ ...e, provider: p.name });
    } catch { /* one provider failing never costs the others */ }
  }
  return { edges: out, unknown };
}

// Connected components over edges at LINK_WEIGHT or more, grown strongest
// edge first and capped at MAX_GROUP files: a hub that touches everything (an
// entry point importing every module) links its closest neighbours, not the
// whole change. Groups sort by their riskiest file; files within a group by
// risk, then path. Each group keeps the edges inside it, for the page's rail.
export const MAX_GROUP = 6;
const RANK = { "test-pair": 0, references: 1, "shared-finding": 2, "same-dir": 3 };
export function group(files, allEdges) {
  const parent = new Map(files.map(f => [f.path, f.path]));
  const size = new Map(files.map(f => [f.path, 1]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const strong = allEdges.filter(e => e.weight >= LINK_WEIGHT && parent.has(e.a) && parent.has(e.b))
    .sort((x, y) => y.weight - x.weight || (RANK[x.provider] ?? 9) - (RANK[y.provider] ?? 9) ||
                    x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  for (const e of strong) {
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb || size.get(ra) + size.get(rb) > MAX_GROUP) continue;
    parent.set(ra, rb);
    size.set(rb, size.get(ra) + size.get(rb));
  }
  const comps = new Map();
  for (const f of files) {
    const r = find(f.path);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(f);
  }
  const byRisk = (a, b) => (b.risk ?? 0) - (a.risk ?? 0) || a.path.localeCompare(b.path);
  const groups = [...comps.values()].map(fs => {
    fs.sort(byRisk);
    const set = new Set(fs.map(f => f.path));
    const seen = new Set();
    const inside = strong.filter(e => set.has(e.a) && set.has(e.b)).filter(e => {
      const k = [e.a, e.b].sort().join("\0") + e.provider;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    return { files: fs.map(f => f.path), risk: fs[0].risk ?? 0,
             edges: inside.map(({ a, b, why, provider, weight }) => ({ a, b, why, provider, weight })) };
  });
  groups.sort((a, b) => b.risk - a.risk || a.files[0].localeCompare(b.files[0]));
  groups.forEach((g, i) => { g.id = "g" + (i + 1); });
  return groups;
}
