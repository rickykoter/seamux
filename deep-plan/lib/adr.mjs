// deep-plan ADR support: config, home discovery, templates, numbering.
// Pure resolvers — nothing here writes. The callers decide where output
// lands: `render` drafts into PLANS_DIR, `adr apply` writes the repo file,
// and only after the alignment check has passed (tenet 8: generate, never
// apply).
//
// Style is the adopter's: .seamux/adr.json at the plan root names the
// template ("nygard", "madr", or a repo-relative path to their own template
// file) and optionally the target dir. No config, no dir -> discovery, then
// the docs/adr default.
import fs from "node:fs";
import path from "node:path";

export const ADR_DEFAULT_DIR = "docs/adr";

// ---------------------------------------------------------------- config

// {template: "nygard" | "madr" | {path}, dir: string|null}
// A template value that is not a known name is a repo-relative path — the
// adopter's own file, so a typo'd name surfaces as "template file missing"
// at render, never as a silent fall-back to a style they did not choose.
export function loadAdrConfig(root) {
  const def = { template: "nygard", dir: null };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, ".seamux", "adr.json"), "utf8")); }
  catch { return def; }
  const t = typeof raw.template === "string" ? raw.template : "nygard";
  return {
    template: (t === "nygard" || t === "madr") ? t : { path: t },
    dir: typeof raw.dir === "string" && raw.dir ? raw.dir : null,
  };
}

// ---------------------------------------------------------------- numbering

const ADR_FILE = /^(\d{4})-.+\.md$/;

// max existing NNNN + 1; a fresh tree starts at 1. Allocation happens at
// apply time — a preseeded number can go stale between render and apply, so
// apply re-runs this and says so when it moved.
export function nextNumber(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 1; }
  let max = 0;
  for (const n of names) {
    const m = ADR_FILE.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

export function adrFileName(number, title) {
  const slug = String(title).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "decision";
  return String(number).padStart(4, "0") + "-" + slug + ".md";
}

// ---------------------------------------------------------------- discovery

const SKIP_DIRS = new Set(["node_modules", "vendor", ".git", ".hg", "dist", "build"]);

// Every directory under root that already holds ADRs (NNNN-*.md), or is an
// empty tree unmistakably named for them (…/adr, …/adrs). Multi-project
// repos keep per-project trees — docs/adr/<project>/NNNN-*.md — and each
// such subfolder is its own candidate.
function adrCandidates(root, dir = root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const hasAdrFiles = entries.some(e => e.isFile() && ADR_FILE.test(e.name));
  const namedAdr = /(^|\/)adrs?$/i.test(dir.replace(/\\/g, "/"));
  if (hasAdrFiles || (namedAdr && dir !== root)) out.push(dir);
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    adrCandidates(root, path.join(dir, e.name), depth + 1, out);
  }
  return out;
}

// The home nearest the change: score each candidate by shared path segments
// with the deliverables' files, so a plan touching services/payments/… lands
// in docs/adr/payments-service/ when that tree exists. Ties go to the
// shallower candidate; no candidates -> null (caller falls back to the
// default). `files` are repo-relative.
export function discoverAdrHome(root, files = []) {
  const cands = adrCandidates(root);
  if (!cands.length) return null;
  const segs = p => p.split(path.sep).filter(Boolean);
  const score = cand => {
    const rel = segs(path.relative(root, cand));
    // Segments of the candidate that appear anywhere in a file's path —
    // "payments-service" in docs/adr/payments-service matches
    // services/payments-service/worker.js even though the prefixes differ.
    let best = 0;
    for (const f of files) {
      const fset = new Set(segs(f).flatMap(s => [s, ...s.split(/[-_.]/)]));
      let hit = 0;
      for (const s of rel) {
        if (s === "docs" || /^adrs?$/i.test(s)) continue;
        if (fset.has(s) || s.split(/[-_.]/).some(w => w.length > 2 && fset.has(w))) hit++;
      }
      best = Math.max(best, hit);
    }
    return best;
  };
  cands.sort((a, b) => score(b) - score(a) ||
    segs(a).length - segs(b).length || a.localeCompare(b));
  return path.relative(root, cands[0]) || null;
}

// dir precedence: explicit config > discovered tree > docs/adr default.
// Returns {dir, source} so surfaces can say WHY this destination was chosen.
export function resolveAdrDir(root, config, files) {
  if (config && config.dir) return { dir: config.dir, source: "config" };
  const found = discoverAdrHome(root, files);
  if (found) return { dir: found, source: "discovered" };
  return { dir: ADR_DEFAULT_DIR, source: "default" };
}

// ---------------------------------------------------------------- templates

const NYGARD = `# {{number}}. {{title}}

Date: {{date}}

## Status

{{status}}

## Context

{{context}}

## Decision

{{decision}}

## Consequences

{{consequences}}
`;

// Minimal MADR — not the full option matrix (documented as a known limit).
const MADR = `# {{title}}

* Status: {{status}}
* Date: {{date}}

## Context and Problem Statement

{{context}}

## Considered Options

{{alternatives}}

## Decision Outcome

{{decision}}

### Consequences

{{consequences}}
`;

// Fill a template from a flagged spec decision. `entry` is the decisions[]
// element ({decision, why, adr: {context?, consequences, alternatives?,
// status?}}); meta carries what only the caller knows: {number, root,
// date?, status?}. Dates default to a placeholder so render output stays
// deterministic (rehydrate must be byte-identical) — apply fills the real
// date. Unknown {{placeholders}} in a custom template are left intact:
// visible beats silently blank.
export function renderAdr(entry, config, meta) {
  const adr = entry.adr || {};
  let tpl;
  if (config && typeof config.template === "object") {
    tpl = fs.readFileSync(path.join(meta.root, config.template.path), "utf8");
  } else {
    tpl = (config && config.template === "madr") ? MADR : NYGARD;
  }
  const alts = Array.isArray(adr.alternatives) && adr.alternatives.length
    ? adr.alternatives.map(a => "* " + a).join("\n")
    : "* (alternatives not recorded)";
  const fields = {
    number: String(meta.number).padStart(4, "0"),
    title: entry.decision,
    status: meta.status || adr.status || "Proposed",
    date: meta.date || "(pending apply)",
    context: adr.context || entry.why,
    decision: entry.decision,
    consequences: adr.consequences || "",
    alternatives: alts,
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fields ? fields[k] : m));
}

// The flagged subset, in spec order — the single definition of "is an ADR".
export function adrEntries(spec) {
  return (spec.decisions || []).filter(d => d && d.adr);
}
