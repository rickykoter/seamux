// The reviewer's brief. The implementing session spawns ONE fresh subagent
// with this text as its prompt; the subagent reads the diff, writes findings
// as JSON, and ingests them with `lookout findings add`. Reviewing in the
// implementer's own context is weak (it reads its intent, not the code), and
// a separate headless session costs a whole session; a subagent is neither.
//
// The rubric merges the built-in /code-review's stance — real defects with a
// concrete failure, verified before reporting, nothing stylistic — with
// engineering:code-review's four dimensions, which become the categories.
import fs from "node:fs";
import path from "node:path";
import { SCHEMA, SEVERITIES } from "./findings.mjs";

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
  const prior = (review.findings || []).length
    ? `\nThis review already has ${(review.findings || []).length} finding(s) (\`lookout findings list ${review.id}\`). ` +
      "Do not report them again; an exact repeat is skipped anyway.\n" : "";

  return `You are reviewing a code change. Report real defects only, as JSON.

## What you are reviewing

${review.title} — ${where}.
The whole diff is in ${patchPath}.${show}
Files, riskiest first (lookout's ranking; spend your attention in this order):

${order || "  (no files)"}
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
- No style, formatting or preference comments. No praise. No summaries.
- Anchor each finding to a line in the diff: \`side: "new"\` with the new-side
  line number for added or context lines, \`side: "old"\` with the old-side
  number for a removed line. Point at context outside the hunks only when the
  change breaks that line.
- Report at most 15 findings, most severe first. None is a fine answer: [].

Severity:
- blocker — data loss, a security hole, or the change cannot work at all.
- major — a real bug users or callers will hit; must be fixed before merge.
- minor — a real but contained problem (a rare edge case, a leak in a
  short-lived process); worth fixing.
- nit — a small thing that is still a defect, not taste.

## Output

Write a JSON array of findings to ${outPath}, matching this schema:

${JSON.stringify(SCHEMA, null, 2)}

Then ingest it:

  lookout findings add ${review.id} ${outPath}

It prints what it accepted and why it rejected anything; fix rejected items and
run it again (accepted ones are not duplicated). Finish by replying with the
number of findings per severity (${SEVERITIES.join(", ")}) and nothing else —
the findings themselves live in the review, where the human reads them.
`;
}
