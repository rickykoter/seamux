// Group notes and reviewer edges: what the reviewer says a group of changes
// MEANS, beside the findings that say what is wrong with it.
//
// A note is keyed by the files it covers, never by a group id: the reviewer's
// own edges regroup files after it writes, and group ids are handed out in
// risk order. On every arrange a note attaches to the group holding most of
// its files (partial when they are split), and goes stale when one of its
// files' hunks changes or leaves the diff.
//
//   { id, files, why_risky, direction, watch: [{text, file, line, side, outside}],
//     touches: [...TOUCHES], quiz?: {prompt, options, answer, why, answered?},
//     fileHash: {path: hash at write}, by, createdAt,
//     // derived on every arrange:
//     group, partial, stale, drift: [finding ids] }
//
// The quiz is optional (policy.quiz, fixed when the review is created). With
// it on, a note on a high-band group must carry one multiple-choice question,
// held to the non-leading lint deep-plan's alignment quiz uses (ported here:
// ADR 0004, no plugin imports another's libs). It never gates.
//
// A reviewer edge {a, b, why} is one more edge provider (group.mjs
// `reviewer`): it can join files under the same six-file cap, never split
// them, and its why shows on the group's rail.
import * as SC from "./score.mjs";
import { FINDING } from "./findings.mjs";

export const TOUCHES = ["invariant", "security-boundary", "data-model", "cross-system-assumption"];
export const MAX_WATCH = 6;
export const MAX_EDGES = 24;
const TEXT_CAP = 700;
const clip = (s, n = TEXT_CAP) => String(s ?? "").trim().slice(0, n);
const now = () => new Date().toISOString();
const norm = p => String(p || "").replace(/^\.?\//, "");

export const EDGE_SCHEMA = {
  type: "object",
  required: ["a", "b", "why"],
  properties: {
    a: { type: "string", description: "a changed file, exactly as the review lists it" },
    b: { type: "string", description: "another changed file" },
    why: { type: "string", maxLength: 160, description: "what ties them, for the group's rail: the contract, call or data they share" },
  },
};

export const QUIZ_SCHEMA = {
  type: "object",
  required: ["prompt", "options", "answer", "why"],
  properties: {
    prompt: { type: "string", description: "a consequence of the change the human should be able to predict from the code" },
    options: { type: "array", minItems: 3, maxItems: 5, items: { type: "string" } },
    answer: { type: "integer", minimum: 0, description: "index into options as written (the page shuffles them)" },
    why: { type: "string", description: "one sentence: why that option is the consequence, shown once answered" },
  },
};

export function noteSchema(quiz) {
  return {
    type: "object",
    required: ["files", "why_risky", "direction", "watch", "touches"],
    properties: {
      files: { type: "array", minItems: 1, items: { type: "string" }, description: "the files this note covers: a group's files as the brief lists them" },
      why_risky: { type: "string", description: "what could break, for whom, if this group is wrong" },
      direction: { type: "string", description: "the concept or design this moves toward (a boundary, an invariant, an ownership change), not a restatement of the lines" },
      watch: { type: "array", maxItems: MAX_WATCH, description: "what to check by hand, each at a line",
        items: { type: "object", required: ["text", "file", "line"], properties: {
          text: { type: "string" }, file: { type: "string" }, line: { type: "integer", minimum: 1 },
          side: { enum: ["new", "old"], default: "new" } } } },
      touches: { type: "array", items: { enum: TOUCHES }, description: "the fundamentals it touches; [] when none" },
      ...(quiz ? { quiz: { ...QUIZ_SCHEMA, description: "required on a high group; omit elsewhere" } } : {}),
    },
  };
}

// Everything a reviewer writes, in one object (`lookout prompt` prints it).
export function outputSchema(quiz) {
  return {
    type: "object",
    required: ["findings", "edges", "notes"],
    properties: {
      findings: { type: "array", maxItems: 15, items: FINDING, description: "defects; [] when none" },
      edges: { type: "array", maxItems: MAX_EDGES, items: EDGE_SCHEMA, description: "links lookout's rules missed; [] when none" },
      notes: { type: "array", items: noteSchema(quiz), description: "one per high or medium group" },
    },
  };
}

// The non-leading lint, from deep-plan's alignment quiz: no leading words, no
// all/none of the above, the answer not the one longest option, option
// lengths within 2.2x, and no word unique to the answer echoed in the prompt.
// Returns the problems; [] is a pass.
const BANNED = /\b(recommended|correct|obviously|of course|as decided|as we agreed|best practice|the right)\b/i;
export function lintQuiz(q) {
  const errs = [];
  if (!q || typeof q !== "object") return ["quiz must be an object"];
  const opts = Array.isArray(q.options) ? q.options.map(o => String(o ?? "").trim()) : [];
  if (!clip(q.prompt)) errs.push("quiz.prompt is required");
  if (opts.length < 3 || opts.length > 5) errs.push("quiz.options: 3 to 5 options");
  if (opts.some(o => !o)) errs.push("quiz.options: an option is empty");
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= opts.length) errs.push("quiz.answer must index options as written");
  if (!clip(q.why)) errs.push("quiz.why is required");
  if (errs.length) return errs;
  if (BANNED.test(q.prompt)) errs.push("quiz.prompt contains a leading word");
  for (const o of opts) {
    if (BANNED.test(o)) errs.push(`option "${o}" contains a leading word`);
    if (/\b(all|none) of the above\b/i.test(o)) errs.push(`option "${o}": no all/none of the above`);
  }
  const lens = opts.map(o => o.length);
  const right = opts[q.answer];
  if (right.length === Math.max(...lens) && lens.filter(l => l === right.length).length === 1)
    errs.push("the answer is the single longest option, the classic length tell");
  if (Math.max(...lens) / Math.max(1, Math.min(...lens)) > 2.2) errs.push("option lengths spread wider than 2.2x");
  for (const tok of right.split(/\W+/))
    if (tok.length > 6 && String(q.prompt).includes(tok) && !opts.some((o, i) => i !== q.answer && o.includes(tok)))
      errs.push(`the prompt echoes "${tok}", which only the answer contains`);
  return errs;
}

// Reviewer edges, validated. Both ends must be distinct files in the review
// and the why is required: an edge is drawn on the rail with its reason, so
// a link nobody can explain is not one.
export function validateEdges(review, items) {
  const files = new Set((review.files || []).map(f => f.path));
  const accepted = [], rejected = [];
  (items || []).forEach((x, index) => {
    const bad = why => rejected.push({ index, why });
    if (!x || typeof x !== "object") return bad("not an object");
    const a = norm(x.a), b = norm(x.b);
    if (!files.has(a)) return bad(`file ${JSON.stringify(x.a)} is not in this review`);
    if (!files.has(b)) return bad(`file ${JSON.stringify(x.b)} is not in this review`);
    if (a === b) return bad("an edge joins two different files");
    const why = clip(x.why, 160);
    if (!why) return bad("why is required: the rail shows it");
    if (accepted.length >= MAX_EDGES) return bad(`at most ${MAX_EDGES} edges`);
    accepted.push({ a, b, why });
  });
  return { accepted, rejected };
}

// Stored edges are a set of pairs: a repeat updates the why.
export function ingestEdges(review, accepted) {
  const list = review.reviewerEdges = review.reviewerEdges || [];
  const key = e => [e.a, e.b].sort().join("\0");
  let added = 0;
  for (const e of accepted) {
    const i = list.findIndex(x => key(x) === key(e));
    if (i >= 0) list[i] = { ...list[i], why: e.why };
    else { list.push({ ...e, at: now() }); added++; }
  }
  return added;
}

// Which group a set of files lands in: the one holding most of them, the
// riskier on a tie (groups are in risk order). Partial when they are split.
export function placement(groups, files) {
  const counts = new Map();
  for (const f of files) {
    const g = (groups || []).find(x => x.files.includes(f));
    if (g) counts.set(g, (counts.get(g) || 0) + 1);
  }
  let best = null;
  for (const g of groups || []) if (counts.has(g) && (!best || counts.get(g) > counts.get(best))) best = g;
  return { group: best, partial: counts.size > 1 };
}

const hashes = review => Object.fromEntries((review.files || []).map(f => [f.path, f.hash]));

// Validate notes against the review as arranged (the reviewer's edges already
// in its groups). Returns { accepted, rejected: [{index, why}], dropped: [why] }.
export function validateNotes(review, items, anchors) {
  const files = new Set((review.files || []).map(f => f.path));
  const quizOn = !!(review.policy && review.policy.quiz);
  const accepted = [], rejected = [], dropped = [];
  (items || []).forEach((x, index) => {
    const bad = why => rejected.push({ index, why });
    if (!x || typeof x !== "object") return bad("not an object");
    if (!Array.isArray(x.files) || !x.files.length) return bad("files: the files this note covers, as a non-empty array");
    const nf = [...new Set(x.files.map(norm))];
    const missing = nf.filter(f => !files.has(f));
    if (missing.length) return bad(`file ${JSON.stringify(missing[0])} is not in this review`);
    const why_risky = clip(x.why_risky), direction = clip(x.direction);
    if (!why_risky) return bad("why_risky is required");
    if (!direction) return bad("direction is required");
    const touches = Array.isArray(x.touches) ? [...new Set(x.touches.map(t => String(t).toLowerCase()))] : [];
    const odd = touches.find(t => !TOUCHES.includes(t));
    if (odd) return bad(`touches: ${JSON.stringify(odd)} is not one of ${TOUCHES.join(", ")}`);
    const watchIn = Array.isArray(x.watch) ? x.watch : [];
    if (watchIn.length > MAX_WATCH) return bad(`watch: at most ${MAX_WATCH} items`);
    const watch = [];
    for (const [i, w] of watchIn.entries()) {
      const file = norm(w && w.file), line = Number(w && w.line), side = w && w.side === "old" ? "old" : "new";
      if (!clip(w && w.text)) return bad(`watch[${i}].text is required`);
      if (!files.has(file)) return bad(`watch[${i}]: file ${JSON.stringify(w.file)} is not in this review`);
      if (!Number.isInteger(line) || line < 1) return bad(`watch[${i}].line must be a positive integer`);
      const a = anchors && anchors[file];
      watch.push({ text: clip(w.text, 300), file, line, side, outside: a ? !a[side].has(line) : false });
    }
    const { group } = placement(review.groups, nf);
    const high = !!group && SC.bandOf(group.risk) === "high";
    let quiz;
    if (x.quiz !== undefined && x.quiz !== null) {
      if (!quizOn) dropped.push(`note ${index}: the quiz is off for this review; its question was dropped`);
      else if (!high) dropped.push(`note ${index}: only a high group gets a question (${group ? group.id : "?"} is not high); dropped`);
      else {
        const errs = lintQuiz(x.quiz);
        if (errs.length) return bad("quiz: " + errs.join("; "));
        quiz = { prompt: clip(x.quiz.prompt, 400), options: x.quiz.options.map(o => clip(o, 200)),
                 answer: x.quiz.answer, why: clip(x.quiz.why, 400) };
      }
    } else if (quizOn && high)
      return bad(`${group.id} is a high group and the quiz is on: this note needs a quiz`);
    accepted.push({ files: nf, why_risky, direction, watch, touches, ...(quiz ? { quiz } : {}) });
  });
  return { accepted, rejected, dropped };
}

// Add or replace notes (mutates). A note replaces every earlier note whose
// files it covers: the same group written again, or a group that grew (by an
// edge, a shared finding, a re-open) and was written whole. The first one's
// id is kept, and so is a question already answered on any of them, since an
// answer is recorded once. Returns { added, replaced }.
export function ingestNotes(review, accepted, by = "reviewer") {
  const list = review.notes = review.notes || [];
  const h = hashes(review);
  let n = 1 + Math.max(0, ...list.map(x => parseInt(String(x.id || "").slice(1), 10)).filter(Number.isFinite));
  let added = 0, replaced = 0;
  for (const x of accepted) {
    const fileHash = Object.fromEntries(x.files.map(f => [f, h[f] ?? null]));
    const covered = list.filter(o => o.files.every(f => x.files.includes(f)));
    if (covered.length) {
      const old = covered[0];
      const answered = covered.find(o => o.quiz && o.quiz.answered);
      const quiz = answered ? answered.quiz : x.quiz;
      const i = list.indexOf(old);
      list[i] = { ...old, ...x, quiz, fileHash, at: now() };
      if (!quiz) delete list[i].quiz;
      for (const o of covered.slice(1)) list.splice(list.indexOf(o), 1);
      replaced += covered.length;
    } else {
      list.push({ id: "n" + n++, ...x, fileHash, by, createdAt: now() });
      added++;
    }
  }
  return { added, replaced };
}

// On every arrange: where each note sits now, and whether it still describes
// the diff. Mutates notes (group, partial, stale, drift) and groups (notes).
export function attach(review) {
  const groups = review.groups || [];
  for (const g of groups) g.notes = [];
  const h = hashes(review);
  const drift = (review.findings || []).filter(f => f.category === "plan-drift");
  for (const note of review.notes || []) {
    const { group, partial } = placement(groups, note.files);
    note.group = group ? group.id : null;
    note.partial = partial;
    // A file with no hash on either side (a review opened before hashes) is
    // unknown, not changed; one that left the diff is changed.
    const was = f => note.fileHash ? note.fileHash[f] : null;
    note.stale = note.files.some(f => !(f in h) || (was(f) != null && h[f] != null && was(f) !== h[f]));
    note.drift = drift.filter(f => note.files.includes(f.file)).map(f => f.id);
    if (group) group.notes.push(note.id);
  }
  return review;
}

// Groups the reviewer still owes: a note for every high or medium group, and
// with the quiz on, a question on every high one.
export function missing(review) {
  const out = [];
  const quizOn = !!(review.policy && review.policy.quiz);
  for (const g of review.groups || []) {
    const band = SC.bandOf(g.risk);
    if (band === "low") continue;
    const notes = (review.notes || []).filter(n => n.group === g.id);
    if (!notes.length) out.push(`${g.id} (${band}: ${g.files.join(", ")}) has no note`);
    else if (quizOn && band === "high" && !notes.some(n => n.quiz))
      out.push(`${g.id} (high: ${g.files.join(", ")}) has no question, and the quiz is on`);
  }
  return out;
}
