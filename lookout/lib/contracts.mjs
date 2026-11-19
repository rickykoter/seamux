// Contract files: the ones other systems read or write by, so a change to
// one reaches code outside the diff. A message schema, a .proto, a GraphQL
// SDL, an OpenAPI document, a migration.
//
// Two jobs:
//   contractKind — is this changed file a contract, and of what kind? Built-in
//     rules on the path and, when lookout has it, the new side's text, plus
//     the globs a repo lists in .seamux/lookout.json `contracts`.
//   outside — for a review that covers only part of its branch (a range, an
//     increment opened at its start sha, a turn, the uncommitted work), the
//     contract files the branch changed outside the review's own diff. The
//     brief names them, so a review of consumer code learns which contract
//     it consumes even when the contract changed in another commit.
import { git, defaultBase } from "./patch.mjs";

// Text sniffed per file, at most; a contract announces itself in its head.
const SNIFF = 4000;
// Carried-in files listed per review, at most.
export const MAX_OUTSIDE = 20;

// [kind, test(path, text)] — first match wins.
const RULES = [
  ["protobuf", p => /\.proto$/i.test(p)],
  ["GraphQL schema", p => /\.(graphql|graphqls|gql)$/i.test(p)],
  ["OpenAPI", (p, t) => /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(p) ||
    (/\.(ya?ml|json)$/i.test(p) && /^\s*["']?(openapi|swagger)["']?\s*:/m.test(t.slice(0, SNIFF)))],
  ["JSON Schema", (p, t) => /\.json$/i.test(p) &&
    (/"\$schema"\s*:\s*"[^"]*json-schema/.test(t.slice(0, SNIFF)) || /(^|\/)[^/]*schema[^/]*\//i.test(p))],
  ["migration", p => /(^|\/)(migrations?|migrate)\//i.test(p) && !/\.(md|txt)$/i.test(p)],
];

// A glob as a regex: ** any depth, * within one segment, ? one character.
export function globRe(g) {
  let re = "";
  const s = String(g).replace(/^\.?\//, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*" && s[i + 1] === "*") { re += s[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += s[i + 2] === "/" ? 2 : 1; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

// The repo's own globs, from .seamux/lookout.json `contracts`; a value that
// is not a list of strings counts as none.
export function repoGlobs(cfg) {
  const g = cfg && cfg.contracts;
  return Array.isArray(g) ? g.filter(x => typeof x === "string" && x.trim()) : [];
}

// The kind of contract a file is, or "" when it is none.
export function contractKind(p, text = "", globs = []) {
  const t = String(text || "");
  for (const [kind, test] of RULES) if (test(p, t)) return kind;
  if (globs.some(g => globRe(g).test(p))) return "listed in .seamux/lookout.json";
  return "";
}

const line1 = s => String(s || "").split("\n")[0].trim();

// The commit a source's new side grows from: a range's own end, else HEAD.
function headOf(src) {
  return src.kind === "range" ? src.newRev : src.head;
}

// Contract files the branch changed outside this review. Returns
// { files: [{path, status, kind}], base, head, more } when the review covers
// part of its branch, { files: [] , ...} when it covers all of it, or
// { skipped: why } when there is no branch to look at.
export function outside(src, reviewFiles, globs = []) {
  if (!src || src.kind === "patch") return { skipped: "a patch file has no branch" };
  const root = src.root, head = headOf(src);
  if (!root || !head) return { skipped: "no commit to start from" };
  const def = defaultBase(root);
  if (!def) return { skipped: "no default branch (origin/HEAD, main or master) to find the branch's start" };
  const base = line1(git(root, ["merge-base", def, head], { allowFail: true }));
  if (!base) return { skipped: `${head.slice(0, 8)} shares no history with ${def}` };
  // The review already starts where the branch does: nothing is outside it.
  if (base === src.oldRev) return { files: [], base, head };
  const inReview = new Set(reviewFiles);
  const out = [];
  const listed = git(root, ["diff", "--name-status", "--no-renames", "--no-color", "--no-ext-diff", base, head], { allowFail: true });
  for (const row of String(listed || "").split("\n")) {
    const [status, p] = row.split("\t");
    if (!p || inReview.has(p)) continue;
    const text = status === "D" ? "" : git(root, ["show", `${head}:${p}`], { allowFail: true }) || "";
    const kind = contractKind(p, String(text).slice(0, SNIFF), globs);
    if (kind) out.push({ path: p, status: status[0], kind });
  }
  return { files: out.slice(0, MAX_OUTSIDE), more: Math.max(0, out.length - MAX_OUTSIDE), base, head };
}
