// Notes: side findings filed under the plan and increment they were found
// in (ADR 0044). One append-only file per plan beside its state,
// <state>/<slug>.notes.jsonl, so it rides the plan's state branch and its
// export bundle. Two kinds of line:
//   open   {id, at, by, plan, inc, text}
//   close  {id, at, by, closed, into?}
// A close is appended, never rewritten, so two machines' copies merge by
// line. Ids are random hex, not a counter, so two machines that note at the
// same time do not pick the same one.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "./state.mjs";

export const NOTES_SUFFIX = ".notes.jsonl";
export const notesPath = slug => path.join(STATE_DIR, slug + NOTES_SUFFIX);

export function newNoteId(taken = new Set()) {
  for (;;) {
    const id = "n" + crypto.randomBytes(4).toString("hex");
    if (!taken.has(id)) return id;
  }
}

// Every parseable line, in file order. A torn or foreign line is skipped,
// never thrown: the news hook reads this on a prompt.
export function readNoteLines(slug) {
  let raw = "";
  try { raw = fs.readFileSync(notesPath(slug), "utf8"); } catch { return []; }
  const out = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o.id === "string") out.push(o);
    } catch { /* torn line */ }
  }
  return out;
}

// One line, one write with O_APPEND, so a concurrent writer's line is never
// interleaved into it. A file whose last write was torn gets a newline first,
// so the new line is not glued to the broken one.
export function appendNoteLine(slug, line) {
  const p = notesPath(slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let lead = "";
  try {
    const fd = fs.openSync(p, "r");
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, size - 1);
        if (b[0] !== 0x0a) lead = "\n";
      }
    } finally { fs.closeSync(fd); }
  } catch { /* no file yet */ }
  fs.appendFileSync(p, lead + JSON.stringify(line) + "\n");
}

// The file folded into one row per note, in the order the notes were opened:
// {id, at, by, plan, inc, text, file, closed?: {at, by, why, into?}}. A close
// with no open line (its open line not merged here yet) is kept aside, and
// applied if the open line turns up later in the file.
export function foldNotes(slug, lines = readNoteLines(slug)) {
  const rows = new Map(), early = new Map();
  for (const l of lines) {
    if (typeof l.closed === "string") {
      const c = { at: l.at, by: l.by, why: l.closed, ...(l.into ? { into: l.into } : {}) };
      const r = rows.get(l.id);
      if (r) { if (!r.closed) r.closed = c; } else if (!early.has(l.id)) early.set(l.id, c);
      continue;
    }
    if (typeof l.text !== "string" || rows.has(l.id)) continue;
    const r = { id: l.id, at: l.at, by: l.by, plan: l.plan, inc: l.inc ?? null, text: l.text, file: slug };
    if (early.has(l.id)) r.closed = early.get(l.id);
    rows.set(l.id, r);
  }
  return [...rows.values()];
}

export const openNotes = slug => foldNotes(slug).filter(r => !r.closed);

// Every plan that has a notes file here, by slug.
export function notedSlugs() {
  try {
    return fs.readdirSync(STATE_DIR).filter(n => n.endsWith(NOTES_SUFFIX)).map(n => n.slice(0, -NOTES_SUFFIX.length));
  } catch { return []; }
}

// A note filed now. `taken` is every id this machine knows, so an id is
// never reused even across plans.
export function fileNote({ slug, inc = null, text, by, taken }) {
  const line = { id: newNoteId(taken), at: new Date().toISOString(), by, plan: slug, inc, text };
  appendNoteLine(slug, line);
  return line;
}

// Close note `row` (from foldNotes) with a reason. With `into`, the note's
// open line is copied as it was (same id, same origin plan and increment)
// into the live plan `into`'s file first, so it is never on no plan at all.
export function closeNote(row, { why, by, into = "" }) {
  if (into) {
    const orig = readNoteLines(row.file).find(l => l.id === row.id && typeof l.text === "string");
    appendNoteLine(into, orig || { id: row.id, at: row.at, by: row.by, plan: row.plan, inc: row.inc, text: row.text });
  }
  const line = { id: row.id, at: new Date().toISOString(), by, closed: why, ...(into ? { into } : {}) };
  appendNoteLine(row.file, line);
  return line;
}
