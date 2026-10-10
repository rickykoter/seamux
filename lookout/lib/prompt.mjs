// The reviewer's brief. The implementing session spawns ONE fresh subagent
// with this text as its prompt; the subagent reads the diff, writes findings,
// edges and a note per group as one JSON object, and ingests it with
// `lookout findings add`. Reviewing in the
// implementer's own context is weak (it reads its intent, not the code), and
// a separate headless session costs a whole session; a subagent is neither.
//
// The rubric merges the built-in /code-review's stance — real defects with a
// concrete failure, verified before reporting, nothing stylistic — with
// engineering:code-review's four dimensions, which become the categories.
// The notes ask for what Karpathy's agentic-engineering review asks of the
// human: the architecture a group moves toward, its hidden cross-system
// assumptions, and the fundamentals it touches, so the reader keeps
// conceptual ownership instead of inheriting the agent's account.
import fs from "node:fs";
import path from "node:path";
import { SEVERITIES, DRIFT } from "./findings.mjs";
import { outputSchema, TOUCHES, MAX_WATCH, MAX_EDGES } from "./notes.mjs";

const PLAN_CAP = 6000;

// A plan increment's own description, when the review came from a plan: the
// cutover file deep-plan writes per increment, made to be read alone.
export function planContext(plansDir, slug, inc) {
  if (!slug || !inc) return "";
  const dir = path.join(plansDir, slug + ".cutover");
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ""; }
  const want = String(inc).padStart(2, "0") + "-";
  const f = names.find(n => n.startsWith(want) && n.endsWith(".md"));
  if (!f) return "";
  try { return fs.readFileSync(path.join(dir, f), "utf8").slice(0, PLAN_CAP); } catch { return ""; }
}

export function brief(review, { patchPath, plansDir, outPath }) {
  const src = review.source || {};
  const where = src.kind === "patch" ? `the patch file ${src.file}`
    : src.kind === "range" ? `the commit range ${src.range} in ${src.root}`
    : src.kind === "worktree" ? `the uncommitted work on ${src.branch || "HEAD"} in ${src.root}`
    : `branch ${src.branch} against ${src.base} (merge base ${String(src.oldRev || "").slice(0, 8)}, working tree included) in ${src.root}`;
  const show = src.kind === "patch" ? ""
    : `\nFull files: the new side is \`git -C ${src.root} show ${src.newRev}:<path>\`, ` +
      `the old side \`git -C ${src.root} show ${src.oldRev}:<path>\`. Read whatever you need around a hunk; ` +
      "a hunk alone hides the caller that breaks.\n";
  const plan = src.plan ? planContext(plansDir, src.plan, src.inc) : "";
  const order = [...(review.files || [])].sort((a, b) => (b.risk ?? 0) - (a.risk ?? 0))
    .map(f => `  ${(f.band || "").padEnd(6)} ${f.status} ${f.path}  +${f.adds} −${f.dels}` +
      (f.collapsed ? "  (collapsed: " + (f.binary ? "binary" : f.generated ? "generated" : "large") + ")" : "") +
      (f.reasons && f.reasons.length ? "  — " + f.reasons.join(", ") : ""))
    .join("\n");
  const quiz = !!(review.policy && review.policy.quiz);
  const groups = (review.groups || []).map(g => {
    const owes = g.band === "high" || g.band === "medium" ? (quiz && g.band === "high" ? "  note + quiz" : "  note") : "";
    const rails = (g.edges || []).map(e => `      ${e.why}`).join("\n");
    return `  ${g.id} ${(g.band || "").padEnd(6)}${owes}`.trimEnd() + "\n" + g.files.map(f => `      ${f}`).join("\n") +
      (rails ? "\n    linked because:\n" + rails : "");
  }).join("\n");
  const prior = (review.findings || []).length
    ? `\nThis review already has ${(review.findings || []).length} finding(s) (\`lookout findings list ${review.id}\`). ` +
      "Do not report them again; an exact repeat is skipped anyway.\n" : "";

  return `You are reviewing a code change. Report its real defects, and explain what
each group of changes means, as one JSON object.

## What you are reviewing

${review.title} — ${where}.
The whole diff is in ${patchPath}.${show}
Files, riskiest first (lookout's ranking; spend your attention in this order):

${order || "  (no files)"}

Groups (lookout's, by imports, test pairs and folders; riskiest first). The
ones marked "note" are owed a note${quiz ? ', and "note + quiz" a question too' : ""}:

${groups || "  (no groups)"}
${plan ? `
## What the change is for (the plan increment it implements)

${plan.trim()}
` : ""}${prior}
## How to review

Look for defects that would make this code wrong in use, across four dimensions:

- correctness — logic errors, wrong conditions, off-by-one, unhandled error
  paths, broken edge cases (empty, null, very large, concurrent), a contract
  a caller relies on changed without the caller.
- security — injection (shell, SQL, path, HTML), secrets in code or logs,
  missing auth or validation at a trust boundary, unsafe deserialization.
- performance — work that grows badly with input (N+1, quadratic loops),
  unbounded memory or output, blocking calls on a hot path.
- maintainability — only when it will cause a bug: duplicated logic that
  will drift, a misleading name or comment that invites a wrong change.

Rules:
- Every finding needs a concrete failure_scenario: the input or state, and
  the wrong result. If you cannot name one, it is not a finding.
- Verify before you report: read the surrounding code and the callers. Mark
  verdict CONFIRMED only when you traced it; otherwise PLAUSIBLE.
- No style, formatting or preference comments. No praise. A finding is a
  defect, never a summary; what a change means goes in its group's note.
- Anchor each finding to a line in the diff: \`side: "new"\` with the new-side
  line number for added or context lines, \`side: "old"\` with the old-side
  number for a removed line. Point at context outside the hunks only when the
  change breaks that line.
- Report at most 15 findings, most severe first. None is a fine answer: [].
${plan ? `- Plan drift: when a group heads somewhere the increment above does not
  say (a different design, scope it did not name, a contract it did not
  mention), file a finding with category "${DRIFT}" at the line that shows
  it. It is always major or worse; the human dismisses it if it was meant.
` : ""}
Severity:
- blocker — data loss, a security hole, or the change cannot work at all.
- major — a real bug users or callers will hit; must be fixed before merge.
- minor — a real but contained problem (a rare edge case, a leak in a
  short-lived process); worth fixing.
- nit — a small thing that is still a defect, not taste.

## Notes: what each group means

Findings say what is wrong. A note says what a group of changes IS, so the
human can judge its architecture rather than read lines. Write one for every
group marked "note" above (low groups may have one too). A note names the
files it covers, normally the group's files as listed.

- why_risky — what breaks, and for whom, if this group is wrong. Concrete:
  "a forged cookie reaches every route behind requireUser", not "auth code".
- direction — the concept the change moves the design toward: a boundary
  moved, an invariant introduced or relaxed, ownership of data shifting, a
  new dependency between systems. Name the concept in your own words; do not
  restate the diff ("adds a function that…") or guess at intent the code
  does not show.
- watch — up to ${MAX_WATCH} things a human should verify by hand, each anchored to the
  line where it shows (same file/line/side rules as findings). Hidden
  assumptions belong here: what this code expects of a caller, a config, a
  schema, another service.
- touches — which fundamentals it touches, from: ${TOUCHES.join(", ")}.
  [] when none.
${quiz ? `- quiz — required on every group marked "note + quiz", and only there. One
  multiple-choice question the human answers BEFORE seeing your note, so it
  must be answerable from the code: a consequence of the change ("a request
  with an expired cookie now…"), not a fact about your note. 3 to 5 options,
  "answer" the index as written (the page shuffles them), "why" one sentence
  shown after. It is linted and rejected if it leads: no "correct",
  "recommended", "obviously", "best practice" or "the right"; no all/none of
  the above; the answer must not be the single longest option; the longest
  option at most 2.2 times the shortest; and the prompt must not echo a word
  of 7+ letters that only the answer contains.
` : ""}
## Edges: links lookout's rules missed

When two changed files belong together for a reason the rules above cannot
see (a contract and its consumer in another language, a config and the code
reading it, a migration and the query it changes), add an edge {a, b, why}.
The why is drawn on the group's rail, so it names the shared thing. Edges
only join files, groups stay at six files or fewer, and a link the rules
already made needs no edge. At most ${MAX_EDGES}; [] is the usual answer. Notes are
matched to groups after your edges apply, so write each note for the files
it covers and it lands on whichever group holds them.

## Output

Write ONE JSON object to ${outPath}, matching this schema:

${JSON.stringify(outputSchema(quiz), null, 2)}

Then ingest it:

  lookout findings add ${review.id} ${outPath}

It prints what it accepted, why it rejected anything, and any group still
owed a note${quiz ? " or a question" : ""}; fix those and run it again (accepted findings are not
duplicated, and a note for the same files replaces the earlier one). Finish by
replying with the number of findings per severity (${SEVERITIES.join(", ")}) and
of notes, and nothing else — the review is where the human reads them.
`;
}
