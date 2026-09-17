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
// The default file convention: NNNN-kebab-title.md, scanned by the same shape.
// Both are overridable because "one ADR per file, numbered, in a folder" is the
// only part every adopter shares — the spelling is house style, and a repo with
// 348 ADRs under `adr_001_snake_case.md` is not going to restyle them to suit a
// planning tool. Getting this wrong is not cosmetic: a scan that matches none
// of the existing files reports "next number = 1" and writes a second ADR 1.
// Discovery is deliberately broader than any one convention: it runs BEFORE a
// config is known, and its only job is "does this folder look like an ADR
// home". A folder NAMED adr/adrs is recognised by name (see adrCandidates),
// so this pattern is what finds the other case: a folder that is full of ADRs
// but not called that — docs/decisions/, architecture/, a per-component tree.
// Matching the three common spellings (0001-x.md, adr_001_x.md, 001_x.md)
// means such a folder is found whatever the house style; the previous
// 4-digit-only test recognised only one of the three.
const ADR_DISCOVERY = /^(?:adr[-_])?\d{1,4}[-_].+\.md$/i;

export const ADR_DEFAULT_PATTERN = "{nnnn}-{kebab}.md";
export const ADR_DEFAULT_SCAN = "^(\\d{4})-.+\\.md$";

export function loadAdrConfig(root) {
  const def = {
    template: "nygard", dir: null,
    filePattern: ADR_DEFAULT_PATTERN, numberScan: ADR_DEFAULT_SCAN,
  };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, ".seamux", "adr.json"), "utf8")); }
  catch { return def; }
  const t = typeof raw.template === "string" ? raw.template : "nygard";
  return {
    template: (t === "nygard" || t === "madr") ? t : { path: t },
    dir: typeof raw.dir === "string" && raw.dir ? raw.dir : null,
    filePattern: validPattern(raw.filePattern) || ADR_DEFAULT_PATTERN,
    numberScan: validScan(raw.numberScan) || ADR_DEFAULT_SCAN,
  };
}

// A pattern produces a FILENAME, so it must not be able to produce a path:
// without this, `"../../{kebab}.md"` writes outside the ADR directory. It must
// also carry a number placeholder, or every ADR overwrites the last.
function validPattern(v) {
  if (typeof v !== "string" || !v) return null;
  if (v.includes("/") || v.includes("\\") || v.includes("..")) {
    console.error(`deep-plan: .seamux/adr.json filePattern must be a filename, not a path — ignoring ${JSON.stringify(v)}`);
    return null;
  }
  if (!/\{n{1,4}\}/.test(v)) {
    console.error(`deep-plan: .seamux/adr.json filePattern has no {n}/{nn}/{nnn}/{nnnn} — ignoring ${JSON.stringify(v)}`);
    return null;
  }
  return v;
}

// Compiled here so a bad regex is a message naming the config, not a stack
// trace from inside a readdir loop. One capture group is the number.
function validScan(v) {
  if (typeof v !== "string" || !v) return null;
  let re;
  try { re = new RegExp(v); }
  catch (e) {
    console.error(`deep-plan: .seamux/adr.json numberScan is not a valid regex (${e.message}) — ignoring it`);
    return null;
  }
  if (!/\((?!\?)/.test(v)) {
    console.error(`deep-plan: .seamux/adr.json numberScan needs a capture group around the number — ignoring ${JSON.stringify(v)}`);
    return null;
  }
  return v;
}

// ---------------------------------------------------------------- numbering

// max existing number + 1; a fresh tree starts at 1. Allocation happens at
// apply time — a preseeded number can go stale between render and apply, so
// apply re-runs this and says so when it moved.
//
// `scan` is the configured convention. A scan that matches nothing returns 1,
// which is right for an empty folder and WRONG for a folder whose files it
// simply does not recognise — so `adrScanReport` exists for callers to say so.
export function nextNumber(dir, scan) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 1; }
  const re = compileScan(scan);
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m && m[1] !== undefined) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function compileScan(scan) {
  if (!scan) return new RegExp(ADR_DEFAULT_SCAN);
  try { return new RegExp(scan); } catch { return new RegExp(ADR_DEFAULT_SCAN); }
}

// "there are N markdown files here and the scan recognised none of them" — the
// one situation where starting at 1 silently duplicates an existing number.
// Returns null when there is nothing to say.
export function adrScanReport(dir, scan) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const mds = names.filter(n => n.endsWith(".md"));
  if (!mds.length) return null;
  const re = compileScan(scan);
  const seen = mds.filter(n => { const m = re.exec(n); return m && m[1] !== undefined; });
  if (seen.length) return null;
  return { total: mds.length, examples: mds.slice(0, 3) };
}

const slugify = (title, sep) => String(title).toLowerCase()
  .replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "")
  .slice(0, 60) || "decision";

// {n}/{nn}/{nnn}/{nnnn} choose the number's width; {kebab}/{snake} the title's
// word separator. Anything else in the pattern is literal.
export function adrFileName(number, title, pattern) {
  const pat = pattern || ADR_DEFAULT_PATTERN;
  return pat.replace(/\{(n{1,4}|kebab|snake|title)\}/g, (m, k) => {
    if (k === "kebab") return slugify(title, "-");
    if (k === "snake" || k === "title") return slugify(title, "_");
    return String(number).padStart(k.length, "0");
  });
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
  const hasAdrFiles = entries.some(e => e.isFile() && ADR_DISCOVERY.test(e.name));
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
    // {{number}} stays 4-padded for the built-in templates. A house template
    // whose files read `adr_013_...` wants {{nnn}}, and one whose heading is
    // "# ADR 13" wants {{n}} — the width is house style, same as the filename.
    number: String(meta.number).padStart(4, "0"),
    n: String(meta.number),
    nn: String(meta.number).padStart(2, "0"),
    nnn: String(meta.number).padStart(3, "0"),
    nnnn: String(meta.number).padStart(4, "0"),
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
