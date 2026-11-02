// Checks ui/source.ts, the New workspace card's source parser. Run by
// `npm run build`. TypeScript's own transpiler strips the types, so this
// works on any Node the build runs on.
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { parseLink } from "../../deep-plan/lib/intake.mjs";

const src = fs.readFileSync(new URL("../ui/source.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseSource, firstMessage } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const pick = s => s && { kind: s.kind, n: s.n, repo: s.repo, link: s.link, branch: s.branch, rest: s.rest };

// GitHub links, anywhere in the text.
assert.deepEqual(pick(parseSource("https://github.com/o/r/issues/42")),
  { kind: "issue", n: "42", repo: "o/r", link: "https://github.com/o/r/issues/42", branch: "fix-issue-42", rest: "" });
assert.equal(parseSource("https://github.com/o/r/issues/42").label, "GitHub issue #42 · o/r");
assert.deepEqual(pick(parseSource("please look at https://github.com/o/r/pull/7/files, it flakes")),
  { kind: "pr", n: "7", repo: "o/r", link: "https://github.com/o/r/pull/7/files", branch: "fix-pr-7", rest: "please look at it flakes" });
const run = parseSource("CI broke: https://github.com/o/r/actions/runs/41442906818/job/9.");
assert.deepEqual(pick(run),
  { kind: "run", n: "41442906818", repo: "o/r", link: "https://github.com/o/r/actions/runs/41442906818/job/9", branch: "fix-run-41442906818", rest: "CI broke:" });
assert.equal(run.label, "GitHub Actions run 41442906818 · o/r");

// Jira links and keys.
assert.deepEqual(pick(parseSource("https://acme.atlassian.net/browse/PROJ-9")),
  { kind: "jira", n: "PROJ-9", repo: "", link: "https://acme.atlassian.net/browse/PROJ-9", branch: "fix-proj-9", rest: "" });
assert.equal(parseSource("PROJ-9").label, "Jira PROJ-9");
assert.equal(parseSource("  PROJ-9 ").link, "PROJ-9");

// A bare number only when it is the whole prompt.
assert.deepEqual(pick(parseSource("#42")), { kind: "issue", n: "42", repo: "", link: "#42", branch: "fix-issue-42", rest: "" });
assert.equal(parseSource("#42").label, "GitHub issue #42 · this repo");
assert.equal(parseSource("42"), null);
assert.equal(parseSource("2024"), null);
assert.equal(parseSource("look at #42 when you can"), null);
assert.equal(parseSource("fix PROJ-9 today"), null);

// Free-form text and other links stay free-form.
assert.equal(parseSource(""), null);
assert.equal(parseSource("Fix the login bug"), null);
assert.equal(parseSource("see https://github.com/o/r and https://example.com/x"), null);
assert.equal(parseSource("proj-9"), null);
// The first link that is a source wins over earlier links that are not.
assert.equal(parseSource("docs https://example.com then https://github.com/o/r/issues/3").n, "3");

// A markdown link reads as its label plus the URL.
assert.equal(parseSource("see [the bug](https://github.com/o/r/issues/42) now").rest, "see the bug now");

// Every link the card accepts, deep-plan intake reads the same way.
for (const text of [
  "https://github.com/o/r/issues/42", "x https://github.com/o/r/pull/7/files, y",
  "https://github.com/o/r/actions/runs/41442906818/job/9.", "https://acme.atlassian.net/browse/PROJ-9",
  "#42", "PROJ-9",
]) {
  const s = parseSource(text), d = parseLink(s.link);
  assert.ok(d, `intake refuses ${s.link}`);
  assert.equal(d.kind, s.kind, s.link);
  assert.equal(d.kind === "jira" ? d.key : d.n, s.n, s.link);
  assert.equal(d.repo ?? "", s.repo, s.link);
}

// The first message.
assert.equal(firstMessage(parseSource("https://github.com/o/r/issues/42")),
  "/deep-plan Run deep-plan intake on https://github.com/o/r/issues/42 to gather the bug, then plan its fix in the bug lane.");
assert.equal(firstMessage(parseSource("https://github.com/o/r/issues/42 only on Safari")),
  "/deep-plan Run deep-plan intake on https://github.com/o/r/issues/42 to gather the bug, then plan its fix in the bug lane.\n\nonly on Safari");

console.log("source.check: ok");
