// Findings and threads: what the reviewer reported and what people said.
//
// A finding is the built-in /code-review's ReportFindings shape — file, line,
// summary, failure_scenario, category, verdict CONFIRMED|PLAUSIBLE,
// short_summary — plus what a conversation and a gate need: severity
// (blocker|major|minor|nit), side (old|new), status and a thread. The
// categories default to engineering:code-review's four dimensions.
//
// A thread is a line comment that is not a finding (a human's note on a
// line); it carries the same messages and its own open/resolved status.
//
// Who may do what. The agent may reply, and may mark a finding addressed.
// Only a human closes one — resolve or dismiss — unless the review's policy
// says the agent may (`lookout open --agent-may-close`, or the plan's
// `review.agentMayClose`). A gate that passed on the agent's word about its
// own fixes would be the self-certification ADR 0006 removed.
export const SEVERITIES = ["blocker", "major", "minor", "nit"];
export const BLOCKING = new Set(["blocker", "major"]);
export const CATEGORIES = ["correctness", "security", "performance", "maintainability"];
export const VERDICTS = ["CONFIRMED", "PLAUSIBLE"];
export const STATUSES = ["open", "addressed", "resolved", "dismissed"];
const CLOSED = new Set(["resolved", "dismissed"]);
export const isOpen = f => !CLOSED.has(f.status || "open");

const MAX_TEXT = 4000;
const clip = (s, n = MAX_TEXT) => String(s ?? "").trim().slice(0, n);
const now = () => new Date().toISOString();

// The JSON a reviewer writes, as a schema it can follow (printed by
// `lookout prompt`).
export const SCHEMA = {
  type: "array",
  items: {
    type: "object",
    required: ["file", "line", "severity", "summary", "failure_scenario"],
    properties: {
      file: { type: "string", description: "repo-relative path, exactly as the review lists it" },
      line: { type: "integer", minimum: 1, description: "line number on `side`" },
      side: { enum: ["new", "old"], default: "new", description: "old only for a removed line" },
      severity: { enum: SEVERITIES },
      category: { type: "string", default: "correctness", description: CATEGORIES.join(" | ") + " (or another short kebab-case slug)" },
      verdict: { enum: VERDICTS, default: "PLAUSIBLE", description: "CONFIRMED only when you traced it through the code" },
      summary: { type: "string", description: "one sentence: the defect" },
      failure_scenario: { type: "string", description: "concrete inputs or state -> the wrong output or crash" },
      short_summary: { type: "string", maxLength: 60, description: "the claim alone, for a compact list" },
    },
  },
};

// A reviewer's output to an array: a bare array, {findings: [...]}, or either
// inside a ```json fence with prose around it.
export function parseInput(text) {
  const t = String(text || "").trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) tries.push(fence[1]);
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const x of tries) {
    try {
      const v = JSON.parse(x);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.findings)) return v.findings;
    } catch { /* next form */ }
  }
  throw new Error("no JSON array of findings in the input");
}

// The lines a finding may anchor to, per file and side, from the drawn rows.
export function anchorsFrom(rows) {
  const out = {};
  for (const [file, d] of Object.entries(rows || {})) {
    const a = { old: new Set(), new: new Set() };
    for (const h of d.hunks || []) for (const [, o, n] of h.rows) {
      if (o != null) a.old.add(o);
      if (n != null) a.new.add(n);
    }
    out[file] = a;
  }
  return out;
}

const nextNum = (list, prefix) =>
  1 + Math.max(0, ...list.map(x => parseInt(String(x.id || "").slice(prefix.length), 10)).filter(Number.isFinite));

// Validate and normalize. Returns { accepted, rejected: [{index, why}] }. A
// finding on a file the review does not contain is rejected; one on a line
// the diff does not show is kept, flagged `outside`, and drawn at the top of
// its file — a reviewer may rightly point at context the hunk left out.
export function validate(review, items, anchors) {
  const files = new Set((review.files || []).map(f => f.path));
  const accepted = [], rejected = [];
  items.forEach((x, index) => {
    const bad = why => rejected.push({ index, why });
    if (!x || typeof x !== "object") return bad("not an object");
    const file = String(x.file || "").replace(/^\.?\//, "");
    if (!files.has(file)) return bad(`file ${JSON.stringify(x.file)} is not in this review`);
    const line = Number(x.line);
    if (!Number.isInteger(line) || line < 1) return bad("line must be a positive integer");
    const severity = String(x.severity || "").toLowerCase();
    if (!SEVERITIES.includes(severity)) return bad(`severity must be one of ${SEVERITIES.join(", ")}`);
    const side = x.side ? String(x.side).toLowerCase() : "new";
    if (side !== "new" && side !== "old") return bad("side must be new or old");
    if (!clip(x.summary)) return bad("summary is required");
    if (!clip(x.failure_scenario)) return bad("failure_scenario is required");
    const verdict = String(x.verdict || "PLAUSIBLE").toUpperCase();
    if (!VERDICTS.includes(verdict)) return bad("verdict must be CONFIRMED or PLAUSIBLE");
    const category = String(x.category || "correctness").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40) || "correctness";
    const summary = clip(x.summary, 1000);
    const a = anchors && anchors[file];
    accepted.push({
      file, line, side, severity, category, verdict, summary,
      short_summary: clip(x.short_summary || summary, 60),
      failure_scenario: clip(x.failure_scenario),
      outside: a ? !a[side].has(line) : false,
    });
  });
  return { accepted, rejected };
}

// Add validated findings to the review (mutates). Exact repeats — same file,
// side, line and summary as one already there — are skipped, so ingesting a
// reviewer's file twice adds nothing. Returns the added findings.
export function ingest(review, accepted, by = "reviewer") {
  review.findings = review.findings || [];
  const key = f => [f.file, f.side, f.line, f.summary].join("\0");
  const have = new Set(review.findings.map(key));
  let n = nextNum(review.findings, "f");
  const added = [];
  for (const x of accepted) {
    if (have.has(key(x))) continue;
    have.add(key(x));
    const f = { id: "f" + n++, ...x, status: "open", by, createdAt: now(), thread: [] };
    review.findings.push(f);
    added.push(f);
  }
  review.reviewedAt = now();
  return added;
}

// A finding (f…) or a thread (t…) by id.
export function item(review, id) {
  const f = (review.findings || []).find(x => x.id === id);
  if (f) return { kind: "finding", it: f };
  const t = (review.threads || []).find(x => x.id === id);
  if (t) return { kind: "thread", it: t };
  return null;
}

function message(list, by, text, extra = {}) {
  const msgs = list;
  const n = 1 + Math.max(0, ...msgs.map(m => parseInt(String(m.id || "").slice(1), 10)).filter(Number.isFinite));
  const m = { id: "m" + n, by, at: now(), text: clip(text), ...extra };
  msgs.push(m);
  return m;
}
const msgsOf = (kind, it) => kind === "finding" ? (it.thread = it.thread || []) : (it.messages = it.messages || []);

export function reply(review, id, text, by = "agent") {
  const x = item(review, id);
  if (!x) throw new Error("no finding or thread " + id);
  if (!clip(text)) throw new Error("an empty reply says nothing");
  return message(msgsOf(x.kind, x.it), by, text);
}

// A new line comment (a human's, from the page; or the agent's).
export function comment(review, { file, line, side = "new", text }, by = "human") {
  if (!(review.files || []).some(f => f.path === file)) throw new Error("file is not in this review: " + file);
  if (!Number.isInteger(line) || line < 1) throw new Error("line must be a positive integer");
  if (side !== "new" && side !== "old") throw new Error("side must be new or old");
  if (!clip(text)) throw new Error("an empty comment says nothing");
  review.threads = review.threads || [];
  const t = { id: "t" + nextNum(review.threads, "t"), file, line, side, status: "open", by, createdAt: now(), messages: [] };
  message(t.messages, by, text);
  review.threads.push(t);
  return t;
}

// Status changes. `by` is "human" or "agent"; the policy decides whether an
// agent may close. Every change leaves a status message in the thread.
export function setStatus(review, id, to, by, note = "") {
  const x = item(review, id);
  if (!x) throw new Error("no finding or thread " + id);
  const closing = to === "resolved" || to === "dismissed";
  if (closing && by !== "human" && !(review.policy && review.policy.agentMayClose))
    throw new Error(`only the human closes a finding: ${to === "resolved" ? "resolve" : "dismiss"} it on the page. ` +
      "(The agent may reply or `address` it; a review opened with --agent-may-close lets the agent close too.)");
  if (x.kind === "thread" && to !== "resolved" && to !== "open") throw new Error("a comment thread is open or resolved");
  if (to === "addressed" && x.kind === "finding" && !isOpen(x.it)) throw new Error(`${id} is already ${x.it.status}`);
  const from = x.it.status || "open";
  x.it.status = to;
  x.it.statusBy = by;
  x.it.statusAt = now();
  message(msgsOf(x.kind, x.it), by, note || "", { kind: "status", from, to });
  return x.it;
}

// The gate's answer. 3: nothing to judge (no review, or no reviewer has run);
// 1: a blocker or major finding is open or only addressed; 0: pass. Minor and
// nit findings never hold the gate.
export function gate(review) {
  if (!review) return { code: 3, why: "no review" };
  if (!review.reviewedAt) return { code: 3, why: "no reviewer has reported on this review yet" };
  const open = (review.findings || []).filter(f => isOpen(f));
  const blocking = open.filter(f => BLOCKING.has(f.severity));
  const tail = `${open.length} open finding(s)`;
  if (blocking.length)
    return { code: 1, why: `${blocking.length} blocker/major finding(s) open: ` +
      blocking.map(f => `${f.id} ${f.severity} ${f.file}:${f.line}${f.status === "addressed" ? " (addressed, awaiting the human)" : ""}`).join("; "),
      blocking: blocking.map(f => f.id), open: open.length };
  return { code: 0, why: open.length ? `no blocker or major open (${tail}, minor/nit only)` : "no open findings", open: open.length };
}
