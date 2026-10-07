// judge — the optional layer of judgment, over the same client crew uses.
//
// THE RULE, AND IT IS ENFORCED HERE RATHER THAN TRUSTED TO CALLERS:
//
//     a judgment may ESCALATE, never AUTHORIZE.
//
// Kev can turn an automatic resolution into a human stop. It can never turn
// a human stop into an automatic resolution, promote a file into an
// artifact, clear a stale mark, or let a push through. Every function below
// returns a set of things to ESCALATE and nothing else — there is no return
// value that means "go ahead", so a miscalibrated model, a truncated answer
// or a compromised endpoint can cost you an extra look and nothing worse.
// (The thresholds on this machine were set for a different model and are
// explicitly untuned; that is exactly the situation this rule is for.)
//
// Everything else follows deep-plan's TypeSafe doctrine: one shared client
// (crew/hooks/typesafe.py), one batched request, a bounded subprocess, and
// any failure — no key, no server, timeout, odd answer — is silence and
// today's behaviour, never a guess.
//
// WHAT LEAVES THE MACHINE. On this laptop the client points at a local Kev,
// so file content never leaves it, and these questions are written for that:
// they carry conflict hunks and file heads, which is what makes them
// answerable. If the endpoint is NOT loopback, the content questions are
// dropped to paths and subjects only, with two exceptions for the glob guard:
// the artifact's regen command (the repo's config, not a file), and one line
// from the top of the file that already SAYS it is generated ("DO NOT EDIT",
// "@generated"), found here, so nothing else from the file goes with it. That check is here and not in the
// caller because "is it safe to send this" is a property of the transport,
// not of the feature that wants an answer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sideStage } from "./git.mjs";

// THE THRESHOLD IS ASYMMETRIC, AND THAT IS THE WHOLE POINT.
//
// The naive rule — "escalate when the model says handwritten with confidence
// >= 0.7" — is wrong here, and measurably so. Kev reports `confidence` as the
// MARGIN between its top two options, so a file it reads as
// {generated 0.14, handwritten 0.48, unclear 0.38} — one it is clearly not
// willing to call generated — arrives with confidence 0.21 and would be
// auto-resolved anyway. A model returning a flat three-way split would sail
// through the same way. Under that rule, uncertainty authorizes.
//
// So the question asked of the answer is inverted: not "is it confident in
// the alarming option", but "is it positively confident in the SAFE one".
// Escalate unless P(safe) clears the floor. Uncertainty then escalates, which
// is the only reading consistent with a layer that may never authorize.
//
// The floor is 0.5 by default: "unless you think this is more likely safe
// than not, let a human look". Raise it toward 1 for a more cautious tool,
// lower it for a quieter one; `judge.safeFloor` in .seamux/restack.json.
export const DEFAULT_SAFE_FLOOR = 0.5;
const ASK_TIMEOUT_MS = 45000;
const EXCERPT_CAP = 1600;

export function clientPath() {
  // Authoritative when set, like deep-plan's: the probe points it at a
  // stand-in, and an empty value means "no client" so a test can never reach
  // the machine's real one.
  if ("RESTACK_TYPESAFE_CLIENT" in process.env) {
    const c = process.env.RESTACK_TYPESAFE_CLIENT;
    try { return c && fs.existsSync(c) ? c : ""; } catch { return ""; }
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(os.homedir(), ".config", "cmux", "crew", "hooks", "typesafe.py"),
    path.join(here, "..", "..", "crew", "hooks", "typesafe.py"),
  ];
  return candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } }) || "";
}

export function available(client) {
  if (!client) return false;
  const r = spawnSync("python3", [client, "available"], { timeout: 5000 });
  return r.status === 0;
}

// Loopback means the content stays on this machine. Anything else — a
// hostname, a LAN address, a proxy — is treated as off-machine, because the
// question "can I send a customer's source code there" has exactly one safe
// default.
export function contentAllowed() {
  const url = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").trim();
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0:0:0:0:0:0:0:1)(:\d+)?(\/|$)/i.test(url);
}

export function judgeState(cfg) {
  const j = cfg.judge || {};
  const client = j.enabled === false ? "" : clientPath();
  return {
    client,
    on: !!client && available(client),
    safeFloor: clamp(j.safeFloor ?? j.threshold, DEFAULT_SAFE_FLOOR),
    content: contentAllowed(),
  };
}
function clamp(v, d) { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : d; }

// One reading of an answer for all three judgments: does this clear the bar
// for "safe", or does a human look? `p` is the probability mass on the safe
// option when the model reports a distribution.
//
// No distribution (another model, an older endpoint): fall back to the chosen
// option, so a model that only says "generated" is still believed. A missing
// or unparsable ANSWER never reaches here — that is handled by ask() returning
// null, and silence, not escalation, is correct there: no answer means the
// feature behaves exactly as it does with no client at all.
export function safeVerdict(answer, safeOption, floor) {
  const a = answer || {};
  const probs = a.probabilities;
  if (probs && typeof probs[safeOption] === "number") {
    const p = probs[safeOption];
    return { escalate: p < floor, p, basis: "probability" };
  }
  if (typeof a.choice === "string")
    return { escalate: a.choice !== safeOption, p: null, basis: "choice" };
  return { escalate: false, p: null, basis: "none" };   // unreadable: stay silent
}

function ask(client, state, questions) {
  const r = spawnSync("python3", [client, "ask"], {
    input: JSON.stringify({ state, questions }), encoding: "utf8", timeout: ASK_TIMEOUT_MS,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Every answer is logged with its score, because the thresholds here are
// provisional and the only way to tune them is against real runs.
function logJudgments(kind, rows) {
  try {
    const dir = process.env.RESTACK_JUDGE_LOG_DIR ||
      path.join(os.homedir(), ".cache", "seamux-restack");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "judgments.log"),
      rows.map(r => JSON.stringify({ at: new Date().toISOString(), kind, ...r })).join("\n") + "\n");
  } catch { /* a log we cannot write is not a failure */ }
}

function head(cwd, p, lines = 24) {
  try {
    return fs.readFileSync(path.join(cwd, p), "utf8")
      .split("\n").slice(0, lines).join("\n").slice(0, EXCERPT_CAP);
  } catch { return ""; }
}

// The top of a conflicted file as the base has it: a generator's output with
// no conflict markers in it, which mid-conflict make any file look hand-edited.
// The working copy when the base has none (an add/add, or not mid-op).
function baseHead(cwd, op, p, lines = 24) {
  const r = op ? spawnSync("git", ["show", `:${sideStage(op, "base")}:${p}`], { cwd, encoding: "utf8", timeout: 10000 }) : null;
  if (!r || r.status !== 0) return head(cwd, p, lines);
  return r.stdout.split("\n").slice(0, lines).join("\n").slice(0, EXCERPT_CAP);
}

// The first line near the top that declares the file generated, or "".
const GENERATED_MARK = /do not edit|@generated|auto-?generated|(code|file) (is )?generated|generated (by|from|with)\b/i;
export function generatedBanner(text, lines = 12) {
  const hit = String(text || "").split("\n").slice(0, lines).find(l => GENERATED_MARK.test(l));
  return hit ? hit.trim().slice(0, 200) : "";
}

// ---------------------------------------------------------------- 1. the glob guard
//
// Before auto-resolving a conflicted file because a glob claimed it, ask
// whether it reads as generated. A `protobuf/**` that quietly covers a
// hand-written README is the one mistake this tool must not make, and it is
// invisible to every deterministic check: the glob is narrow, the config is
// valid, the file just is not generated.
//
// `items` are `{ path, regen }`: the conflicted path and its artifact's regen
// command. The command and a generated-file banner are evidence the question
// was missing; they can make "generated" likelier, and the floor it has to
// clear is the same, so they still cannot authorise anything.
//
// Returns the paths to ESCALATE. An answer of "generated" returns nothing —
// it cannot authorise anything, because resolving was already the plan.
export function guardArtifactPaths(cwd, j, items, op = null) {
  if (!j.on || !items.length) return [];
  const state = {}, questions = {}, index = [];
  items.forEach(({ path: p, regen = "" }, n) => {
    const id = "p" + n;
    index.push({ id, path: p });
    const top = baseHead(cwd, op, p);
    const banner = generatedBanner(top);
    state[id] = {
      path: p,
      ...(regen ? { regen } : {}),
      ...(j.content ? { head: top } : banner ? { banner } : {}),
    };
    questions[id] = {
      type: "choice",
      instructions:
        "`" + id + ".path` is a file that conflicted during a rebase" +
        (j.content ? ", and `" + id + ".head` is the top of it as the base branch has it"
          : banner ? ", and `" + id + ".banner` is a line from the top of it" : "") +
        (regen ? ". `" + id + ".regen` is the command this repository's config says rebuilds it" : "") +
        ". A tool is about to resolve this conflict automatically by rebuilding the file from a generator " +
        "instead of merging it. Judge whether that is safe: is this file the output of a generator, or does a person edit it directly?",
      criteria: {
        generated: "The file is produced by a generator, dump or codegen step; a person editing it by hand would be a mistake.",
        handwritten: "A person writes and edits this file directly; rebuilding it would discard their work.",
        unclear: "There is not enough here to tell.",
      },
    };
  });
  const answers = ask(j.client, state, questions);
  if (!answers) return [];
  const rows = [], escalate = [];
  for (const { id, path: p } of index) {
    const a = answers[id] || {};
    const v = safeVerdict(a, "generated", j.safeFloor);
    rows.push({ path: p, choice: a.choice, pSafe: v.p, basis: v.basis, floor: j.safeFloor, escalated: v.escalate });
    if (v.escalate)
      escalate.push({ path: p, pGenerated: v.p, choice: a.choice,
        why: v.p === null ? `reads as ${a.choice}, not generated`
          : `only ${(v.p * 100).toFixed(0)}% likely to be generated` });
  }
  logJudgments("artifact-guard", rows);
  return escalate;
}

// ---------------------------------------------------------------- 2. dropped commits
//
// A commit that became empty is reported either way. This decides whether it
// is reported as a LINE or as a STOP: `chore: regenerate protos` disappearing
// once master did the same regen is housekeeping; `feat: add phone field`
// disappearing means either someone else shipped it or the change is gone.
export function judgeDropped(cwd, j, dropped) {
  if (!j.on || !dropped.length) return [];
  const state = {}, questions = {};
  dropped.forEach((d, n) => {
    const id = "d" + n;
    const stat = git_show_stat(cwd, d.sha);
    state[id] = { subject: d.subject, files: stat };
    questions[id] = {
      type: "choice",
      instructions:
        "`" + id + ".subject` is the message of a commit that became EMPTY while rebasing — after the rebase, " +
        "it changed nothing — and `" + id + ".files` is what it used to touch. Judge what the commit was claiming to do.",
      criteria: {
        regeneration_only: "It only regenerated, reformatted or synced derived files; nothing is lost if it disappears.",
        claims_other_work: "It claims a behaviour change, a fix or a feature, so it vanishing needs a human to confirm the change is present some other way.",
        unclear: "The message does not say enough to tell.",
      },
    };
  });
  const answers = ask(j.client, state, questions);
  if (!answers) return [];
  const rows = [], escalate = [];
  dropped.forEach((d, n) => {
    const a = answers["d" + n] || {};
    const v = safeVerdict(a, "regeneration_only", j.safeFloor);
    rows.push({ sha: d.sha, subject: d.subject, choice: a.choice, pSafe: v.p, basis: v.basis, escalated: v.escalate });
    if (v.escalate)
      escalate.push({ ...d, pRegenOnly: v.p, why: "this commit claimed more than a regeneration, and it is gone" });
  });
  logJudgments("dropped", rows);
  return escalate;
}

function git_show_stat(cwd, sha) {
  const r = spawnSync("git", ["show", "--stat", "--format=", sha], { cwd, encoding: "utf8", timeout: 10000 });
  return (r.stdout || "").trim().slice(0, 600);
}

// ---------------------------------------------------------------- 3. residue triage
//
// `verify` finds files whose patch changed during the restack and that
// nothing explains. Most are a context line moving. Ranking them is the
// narrow, bounded question this layer is good at — and it only ever adds a
// "look here first" flag, never removes one.
export function judgeResidue(j, residue) {
  if (!j.on || !residue.length || !j.content) return [];
  const state = {}, questions = {};
  residue.forEach((r, n) => {
    const id = "r" + n;
    state[id] = { file: r.file, subject: r.subject, change: (r.sample || []).join("\n").slice(0, EXCERPT_CAP) };
    questions[id] = {
      type: "choice",
      instructions:
        "A commit was rebased and its patch came out different. `" + id + ".file` is the file, `" + id +
        ".change` shows how the patch itself changed (lines starting with '-' were in the patch before the " +
        "rebase and are not in it now; '+' is the reverse). Judge whether the commit still does what it did.",
      criteria: {
        benign: "Only context, whitespace, imports or line positions moved; the change the commit makes is the same.",
        semantic: "The commit's own change is different now — something it did was dropped, altered, or replaced.",
        unclear: "The excerpt does not settle it.",
      },
    };
  });
  const answers = ask(j.client, state, questions);
  if (!answers) return [];
  const rows = [], flagged = [];
  residue.forEach((r, n) => {
    const a = answers["r" + n] || {};
    const v = safeVerdict(a, "benign", j.safeFloor);
    rows.push({ file: r.file, choice: a.choice, pSafe: v.p, basis: v.basis, escalated: v.escalate });
    if (v.escalate)
      flagged.push({ ...r, pBenign: v.p, why: "the commit's own change may be different after the rebase" });
  });
  logJudgments("residue", rows);
  return flagged;
}
