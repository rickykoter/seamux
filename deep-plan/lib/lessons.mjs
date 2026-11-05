// Lessons: what a repo's plans learned from their misses (ADRs 0061, 0062).
//
// Two stores, on purpose:
//   candidates  <state>/<slug>.lessons.jsonl, beside the plan's state and
//               notes. A miss lands here the moment it happens: the agent
//               files one after a correction (`deep-plan lesson`), and the
//               engine files one at a failed grade, a done --force, a review
//               failing on an open blocker or major, and the retry cap.
//   lessons     <repo>/.seamux/lessons.md, read where resolveSeamux points
//               (ADR 0068): committed on the branch, or main's when the
//               repo ignores .seamux. Only `deep-plan retro`
//               writes it, one candidate at a time, kept, merged or dropped
//               by a person. At most LESSON_CAP rules, so it stays readable.
//
// The candidates file is append-only like notes (lib/notes.mjs), with two
// kinds of line:
//   open    {id, at, by, plan, inc, source, text}
//   settle  {id, at, by, settled: "keep"|"merge"|"drop", lesson?, why?}
import fs from "node:fs";
import path from "node:path";
import { resolveSeamux } from "./host.mjs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { STATE_DIR } from "./state.mjs";
import { appendJsonLine } from "./notes.mjs";

export const CANDIDATES_SUFFIX = ".lessons.jsonl";
export const LESSON_CAP = 30;
// How much of one rule a session start tells.
export const RULE_CAP = 500;
export const SOURCES = ["correction", "grade", "force", "review", "retry"];
export const candidatesPath = slug => path.join(STATE_DIR, slug + CANDIDATES_SUFFIX);

// ------------------------------------------------------------ candidates

function readLines(slug) {
  let raw = "";
  try { raw = fs.readFileSync(candidatesPath(slug), "utf8"); } catch { return []; }
  const out = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o.id === "string") out.push(o); } catch { /* torn line */ }
  }
  return out;
}

// One row per candidate, in filing order, with `settled` once a retro
// decided it.
export function foldCandidates(slug) {
  const rows = new Map(), early = new Map();
  for (const l of readLines(slug)) {
    if (typeof l.settled === "string") {
      const s = { at: l.at, by: l.by, how: l.settled, ...(l.lesson ? { lesson: l.lesson } : {}), ...(l.why ? { why: l.why } : {}) };
      const r = rows.get(l.id);
      if (r) { if (!r.settled) r.settled = s; } else if (!early.has(l.id)) early.set(l.id, s);
      continue;
    }
    if (typeof l.text !== "string" || rows.has(l.id)) continue;
    const r = { id: l.id, at: l.at, by: l.by, plan: l.plan, inc: l.inc ?? null, source: l.source, text: l.text };
    if (early.has(l.id)) r.settled = early.get(l.id);
    rows.set(l.id, r);
  }
  return [...rows.values()];
}

export const unsettled = slug => foldCandidates(slug).filter(r => !r.settled);

// File a candidate. The same text from the same source, still unsettled, is
// not filed twice: a check that fails at the cap on every later run, or a
// grade retried with the same wrong answers, is one miss.
export function fileCandidate({ slug, inc = null, source, text, by }) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const rows = foldCandidates(slug);
  const dup = rows.find(r => !r.settled && r.source === source && r.text === text);
  if (dup) return dup;
  const taken = new Set(rows.map(r => r.id));
  let id;
  do id = "c" + crypto.randomBytes(4).toString("hex"); while (taken.has(id));
  const line = { id, at: new Date().toISOString(), by, plan: slug, inc, source, text };
  appendJsonLine(candidatesPath(slug), line);
  return line;
}

export function settleCandidate(slug, id, { how, by, lesson = "", why = "" }) {
  const line = { id, at: new Date().toISOString(), by, settled: how, ...(lesson ? { lesson } : {}), ...(why ? { why } : {}) };
  appendJsonLine(candidatesPath(slug), line);
  return line;
}

// ------------------------------------------------------------ lessons.md

export const HEADER = "# Lessons\n\n" +
  "Rules this repo's plans learned from their misses. `deep-plan retro` adds,\n" +
  `merges and retires them, at most ${LESSON_CAP}. Each names the paths it applies to;\n` +
  "a plan that touches them says how it heeds the rule (cite its id).\n";

// The repo a plan root belongs to: its worktree's top level, so a lesson is
// committed on the branch that learned it.
export function repoTop(root) {
  if (!root) return "";
  const r = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}
export const lessonsFile = top => path.join(top, ".seamux", "lessons.md");

// {head, lessons: [{id, n, applies: [globs], from: [..], rule}]}. Anything
// before the first `## L<n>` heading is kept as the head. A section whose
// heading does not parse is kept as text in the one before it, never lost.
export function parseLessons(text) {
  const out = { head: "", lessons: [] };
  if (!text) return out;
  const parts = text.split(/^(?=## L\d+\b)/m);
  out.head = /^## L\d+\b/.test(parts[0]) ? "" : parts.shift();
  for (const p of parts) {
    const m = /^## (L(\d+))\b([^\n]*)(?:\n([\s\S]*))?$/.exec(p);
    if (!m) continue;
    const body = (m[4] || "").split("\n");
    // A title a person put after the id ("## L3 - tests first") is kept.
    const lesson = { id: m[1], n: Number(m[2]), title: m[3].trim(), applies: [], from: [], rule: "" };
    const rest = [];
    for (const line of body) {
      const a = /^applies:\s*(.*)$/.exec(line), f = /^from:\s*(.*)$/.exec(line);
      if (a && !rest.some(x => x.trim())) lesson.applies = a[1].split(",").map(s => s.trim()).filter(Boolean);
      else if (f && !rest.some(x => x.trim())) lesson.from = f[1].split(";").map(s => s.trim()).filter(Boolean);
      else rest.push(line);
    }
    lesson.rule = rest.join("\n").trim();
    out.lessons.push(lesson);
  }
  return out;
}

export function formatLessons({ head, lessons }) {
  const h = (head && head.trim() ? head.replace(/\s+$/, "") : HEADER.replace(/\s+$/, "")) + "\n";
  const body = lessons.map(l =>
    `## ${l.id}${l.title ? " " + l.title : ""}\n` +
    `applies: ${(l.applies || []).join(", ")}\n` +
    `from: ${(l.from || []).join("; ")}\n\n` +
    `${l.rule.trim()}\n`).join("\n");
  return h + (body ? "\n" + body : "");
}

export function readLessons(top) {
  let text = "";
  try { text = fs.readFileSync(resolveSeamux(top, path.join(".seamux", "lessons.md")).path, "utf8"); } catch { return { head: "", lessons: [], exists: false }; }
  return { ...parseLessons(text), exists: true };
}

export function writeLessons(top, doc) {
  const f = lessonsFile(top);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp." + process.pid;
  fs.writeFileSync(tmp, formatLessons(doc));
  fs.renameSync(tmp, f);
  return f;
}

// The next id is one past the highest ever written, so a retired id is not
// handed to a new rule while an old spec still cites it. The head records
// the high-water mark as a comment.
const NEXT_RE = /<!-- next: L(\d+) -->/;
export function nextId(doc) {
  const seen = Math.max(0, ...doc.lessons.map(l => l.n));
  const m = NEXT_RE.exec(doc.head || "");
  return Math.max(seen + 1, m ? Number(m[1]) : 1);
}
function bumpNext(doc, n) {
  const head = (doc.head && doc.head.trim()) ? doc.head : HEADER;
  doc.head = NEXT_RE.test(head) ? head.replace(NEXT_RE, `<!-- next: L${n} -->`) : head.replace(/\s+$/, "") + `\n\n<!-- next: L${n} -->\n`;
}

// Where a candidate came from, for the lesson's from: line.
// It carries the candidate's id, so a keep or merge that wrote the rule but
// failed to settle the candidate is recognized on the next try.
export const fromOf = c => `${c.plan}${c.inc == null ? "" : ` inc ${c.inc}`} (${c.source}${c.id ? " " + c.id : ""}), ${String(c.at || "").slice(0, 10)}`;
export const lessonFrom = (doc, cid) => doc.lessons.find(l => (l.from || []).some(f => new RegExp(`[ (]${cid}\\)`).test(f)));

export function keepLesson(doc, cand, { rule, applies }) {
  if (doc.lessons.length >= LESSON_CAP)
    throw new Error(`.seamux/lessons.md holds ${doc.lessons.length} lessons, the cap is ${LESSON_CAP}: merge this candidate into one, or retire one first`);
  const n = nextId(doc);
  const lesson = { id: "L" + n, n, applies, from: [fromOf(cand)], rule };
  doc.lessons.push(lesson);
  bumpNext(doc, n + 1);
  return lesson;
}

export function mergeLesson(doc, cand, id, { rule = "", applies = [] } = {}) {
  const l = doc.lessons.find(x => x.id === id);
  if (!l) throw new Error(`no lesson ${id} in .seamux/lessons.md`);
  if (rule) l.rule = rule;
  for (const a of applies) if (!l.applies.includes(a)) l.applies.push(a);
  l.from.push(fromOf(cand));
  return l;
}

export function retireLesson(doc, id) {
  const i = doc.lessons.findIndex(x => x.id === id);
  if (i < 0) throw new Error(`no lesson ${id} in .seamux/lessons.md`);
  bumpNext(doc, nextId(doc));
  return doc.lessons.splice(i, 1)[0];
}

// ------------------------------------------------------------ at render

// What render says about a spec against its repo's lessons: `over` when the
// file holds more than the cap (render refuses, so a hand edit cannot grow
// it past what a person can read), and a warning for each lesson whose
// applies globs match a file a deliverable names while no decision or risk
// cites its id. `files` are repo-relative paths.
export function lessonReport(doc, spec, files, matches) {
  const over = doc.lessons.length > LESSON_CAP
    ? `.seamux/lessons.md holds ${doc.lessons.length} lessons, over the cap of ${LESSON_CAP}: retire or merge some (deep-plan retro <slug> retire L<n> "<why>")`
    : "";
  const said = JSON.stringify([spec.decisions || [], spec.risks || []]);
  const warns = [];
  for (const l of doc.lessons) {
    if (new RegExp(`\\b${l.id}\\b`).test(said)) continue;
    const hit = files.find(f => l.applies.some(g => matches(f, g)));
    if (hit) warns.push(`lesson ${l.id} applies to ${hit}, and no decision or risk cites it: ` +
      `"${l.rule.split("\n")[0].slice(0, 120)}" (say how the plan heeds it, citing ${l.id})`);
  }
  return { over, warns };
}

// The lessons a session starting in `top` is told, cut to `cap` bytes.
export function lessonsBrief(top, cap = 4096) {
  let text = "";
  try { text = fs.readFileSync(resolveSeamux(top, path.join(".seamux", "lessons.md"), { warn: false }).path, "utf8"); } catch { return ""; }
  const doc = parseLessons(text);
  if (!doc.lessons.length) return "";
  let out = "";
  for (const l of doc.lessons) {
    // Each rule is cut on its own, so one long rule cannot crowd out the
    // rest, and quoted as a JSON string, so its text cannot end the quote.
    let rule = l.rule.replace(/\s+/g, " ").trim();
    if (rule.length > RULE_CAP) rule = rule.slice(0, RULE_CAP - 1) + "…";
    // The globs are file text too, so they are quoted like the rule.
    const line = `${l.id}${l.applies.length ? ` applies to ${JSON.stringify(l.applies.join(", "))}` : ""}: ${JSON.stringify(rule)}\n`;
    if (Buffer.byteLength(out + line) > cap) { out += `…and ${doc.lessons.length - out.split("\n").length + 1} more in .seamux/lessons.md\n`; break; }
    out += line;
  }
  return out;
}
