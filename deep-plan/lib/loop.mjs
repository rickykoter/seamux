// Refactor loops (ADR 0067): a deliverable may carry
//
//   "loop": { "targets": ["path/or/call-site", …], "batch": 2 }
//
// and render expands it, before validation, into one increment per batch of
// targets. Each is an ordinary increment: the deliverable's checks, gate,
// review and auto-go, with its batch's targets named in its title and body.
// A target that is a file under the root joins that increment's files.
//
// The expanded spec is what render archives, each increment marked
// `loopOf`, so rehydrate draws the same plan and a re-render of the archive
// does not expand twice. References by deliverable follow the expansion:
// review.increments numbers and a risk's deliverableRef.
import fs from "node:fs";
import path from "node:path";

export const TITLE_TARGETS = 60;

export function loopProblems(spec) {
  const errs = [];
  (spec.deliverables || []).forEach((d, i) => {
    if (!d || d.loop === undefined) return;
    const L = d.loop, at = `deliverable ${i + 1} loop`;
    if (!L || typeof L !== "object" || Array.isArray(L)) { errs.push(`${at}: { "targets": [...], "batch": n }`); return; }
    if (!Array.isArray(L.targets) || !L.targets.length || L.targets.some(t => typeof t !== "string" || !t.trim()))
      errs.push(`${at}: targets is a list of one or more non-empty strings (paths or call sites)`);
    else if (new Set(L.targets).size !== L.targets.length) errs.push(`${at}: a target is listed twice`);
    if (L.batch !== undefined && !(Number.isInteger(L.batch) && L.batch >= 1)) errs.push(`${at}: batch is a whole number, 1 or more`);
    for (const k of Object.keys(L)) if (!["targets", "batch"].includes(k)) errs.push(`${at}: ${k} is not a loop field (targets, batch)`);
    if (spec.workstreams) errs.push(`${at}: a parent plan's deliverables do not loop; loop in a child plan`);
  });
  return errs;
}

const filePath = d => (typeof d === "string" ? d : d && d.path);

// A target names a file the batch edits only when it is a relative path to
// a regular file inside the root: not a directory, not outside it.
export function isFileTarget(root, t) {
  if (!root || path.isAbsolute(t)) return false;
  const p = path.resolve(root, t);
  if (p !== path.resolve(root) && !p.startsWith(path.resolve(root) + path.sep)) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// A re-render reconciles increments by number. When a loop's batches change
// under work that has started, a started increment's progress would land on
// another batch or deliverable; refuse that and say what to do instead.
export function movedProgress(prevIncs, oldSpec, spec) {
  const out = [];
  const oldDs = (oldSpec && oldSpec.deliverables) || [];
  (prevIncs || []).forEach(p => {
    if (!p || !p.status || p.status === "pending") return;
    const was = oldDs[p.n - 1], now = (spec.deliverables || [])[p.n - 1];
    if (!(was && (was.loopOf || (now && now.loopOf)))) return;
    if (!now || now.title !== p.title)
      out.push(`increment ${p.n} ("${p.title}") is ${p.status}, but after this render increment ${p.n} is ${now ? `"${now.title}"` : "gone"}`);
  });
  return out;
}

// The spec with each loop expanded, or the spec as given when none loops.
// `root` decides which targets are files. Call only after loopProblems
// returned nothing.
export function expandLoops(spec, root) {
  if (!(spec.deliverables || []).some(d => d && d.loop)) return spec;
  const out = [], map = new Map();   // old 1-based n -> new 1-based ns
  const titles = new Map();          // old title -> first new title
  spec.deliverables.forEach((d, i) => {
    if (!d.loop) { out.push(d); map.set(i + 1, [out.length]); return; }
    // A commit list belongs to the work as it landed, never to every batch.
    const { loop, commits: _c, ...base } = d;
    const size = loop.batch || 1, targets = loop.targets;
    const batches = [];
    for (let k = 0; k < targets.length; k += size) batches.push(targets.slice(k, k + size));
    const ns = [];
    batches.forEach((batch, k) => {
      const named = batch.join(", ");
      const title = `${d.title} (${k + 1}/${batches.length}: ${named.length > TITLE_TARGETS ? named.slice(0, TITLE_TARGETS - 1) + "…" : named})`;
      const files = [...(d.files || [])];
      for (const t of batch) if (isFileTarget(root, t) && !files.some(f => filePath(f) === t)) files.push(t);
      const inc = { ...base, title, files,
        body: `${d.body || ""}\n\nThis batch (${k + 1} of ${batches.length}): ${batch.join(", ")}.`.trim(),
        loopOf: { title: d.title, batch: k + 1, of: batches.length, targets: batch } };
      // A person's stop belongs to the loop's start, not to every batch.
      if (k > 0) delete inc.go;
      out.push(inc); ns.push(out.length);
      if (k === 0) titles.set(d.title, title);
    });
    map.set(i + 1, ns);
  });
  const next = { ...spec, deliverables: out };
  const inc = spec.review && spec.review.increments;
  // A number past the old end stays past the new one, so it is still refused.
  const grew = out.length - spec.deliverables.length;
  if (Array.isArray(inc)) next.review = { ...spec.review, increments: inc.flatMap(n => map.get(n) || [typeof n === "number" && n > spec.deliverables.length ? n + grew : n]) };
  if (Array.isArray(spec.risks))
    next.risks = spec.risks.map(r => r && typeof r === "object" && titles.has(r.deliverableRef) ? { ...r, deliverableRef: titles.get(r.deliverableRef) } : r);
  return next;
}

// Loop targets are output of the plan's pattern, not input it read one by
// one, so the read-before-plan floor skips them; but a loop none of whose
// file targets is cited was planned without reading any.
export const isLoopTarget = (d, f) => !!(d.loopOf && d.loopOf.targets.includes(f));
export function uncitedLoops(spec, root, cited) {
  const seen = new Map();
  for (const d of spec.deliverables || []) {
    if (!d.loopOf) continue;
    const e = seen.get(d.loopOf.title) || { files: [], cited: false };
    for (const t of d.loopOf.targets) if (isFileTarget(root, t)) { e.files.push(t); if (cited(t)) e.cited = true; }
    seen.set(d.loopOf.title, e);
  }
  return [...seen.entries()].filter(([, e]) => e.files.length && !e.cited)
    .map(([title]) => `loop "${title}": no verifiedFact cites any of its file targets; read one and cite it (path:line)`);
}
