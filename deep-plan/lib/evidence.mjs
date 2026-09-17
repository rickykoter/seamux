// deep-plan evidence check — the OTHER direction of the read-before-plan
// floor. That floor proves every planned file has a citation; nothing proved
// the citations themselves. Here code does what code can (the cited path
// exists, the line is in range) and, when a TypeSafe key is on the machine,
// one batched request asks Jev per fact whether the cited lines support the
// claim, contradict it, or say nothing about it (the citation-check pattern).
//
// Warn-only by decision: a TypeSafe result can only add warnings — render
// never refuses over evidence, the gate never hears about it, and any failure
// (no client, no key, timeout, odd answer) is silence, not a guess. What
// leaves the machine per fact: the claim sentence and the cited lines with
// ±CONTEXT lines around them, capped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CONTEXT = 3;
const EXCERPT_CAP = 2000;
// Below this Choice confidence the verdict is noise, not a warning. As
// provisional as every other TypeSafe number here; tune against real plans.
const CONFIDENCE_FLOOR = Number(process.env.DEEP_PLAN_EVIDENCE_CONFIDENCE || 0.6);

// path:line or path:line-line, repo-relative. Absolute paths, URLs and plain
// prose carry no such token and produce no refs — free-text evidence is legal,
// it is just not checkable.
const REF = /(?<![\w/])([A-Za-z0-9_][A-Za-z0-9_.\/-]*):(\d+)(?:-(\d+))?/g;

export function parseRefs(evidence) {
  const out = [];
  for (const m of String(evidence || "").matchAll(REF)) {
    if (m[1].startsWith("/") || m[1].includes("://")) continue;
    const from = parseInt(m[2], 10);
    out.push({ file: m[1], from, to: m[3] ? parseInt(m[3], 10) : from });
  }
  return out;
}

// Deterministic half: {warnings, resolvable} — resolvable carries what the
// judged half needs, so the file is read once.
export function deterministicCheck(spec, root) {
  const warnings = [], resolvable = [];
  (spec.verifiedFacts || []).forEach((v, i) => {
    for (const ref of parseRefs(v.evidence)) {
      const p = path.join(root, ref.file);
      let lines;
      try { lines = fs.readFileSync(p, "utf8").split("\n"); }
      catch {
        warnings.push(`fact ${i + 1} cites ${ref.file}:${ref.from} — no such file under the plan root`);
        continue;
      }
      if (ref.from > lines.length) {
        warnings.push(`fact ${i + 1} cites ${ref.file}:${ref.from} — the file ends at line ${lines.length}`);
        continue;
      }
      const lo = Math.max(0, ref.from - 1 - CONTEXT);
      const hi = Math.min(lines.length, ref.to + CONTEXT);
      resolvable.push({ i, claim: String(v.claim || ""), ref,
        excerpt: lines.slice(lo, hi).join("\n").slice(0, EXCERPT_CAP) });
    }
  });
  return { warnings, resolvable };
}

// The one shared client (crew/hooks/typesafe.py): env override for the probe,
// the installed crew tree, then the repo layout for work inside seamux itself.
export function clientPath() {
  // The env override is authoritative, not a first preference: the probe
  // points it at a mock (or at nothing, to force the deterministic-only
  // path), and falling through to the machine's real client from under a
  // test would put a probe on the network.
  if ("DEEP_PLAN_TYPESAFE_CLIENT" in process.env) {
    const c = process.env.DEEP_PLAN_TYPESAFE_CLIENT;
    try { return c && fs.existsSync(c) ? c : ""; } catch { return ""; }
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(os.homedir(), ".config", "cmux", "crew", "hooks", "typesafe.py"),
    path.join(here, "..", "..", "crew", "hooks", "typesafe.py"),
  ];
  return candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } }) || "";
}

function clientAvailable(client) {
  const r = spawnSync("python3", [client, "available"], { timeout: 5000 });
  return r.status === 0;
}

// One batched request: every fact's question rides together (they are
// independent; System One answers a questions map in parallel). Question ids
// are not sent to the model, so each instruction names its own state fields.
export function judgeFacts(resolvable, client) {
  if (!resolvable.length) return [];
  const state = {}, questions = {};
  resolvable.forEach((r, n) => {
    const id = "f" + n;
    state[id] = { claim: r.claim, excerpt: r.excerpt };
    questions[id] = {
      type: "choice",
      instructions:
        "`" + id + ".claim` is a statement a plan makes about a codebase. `" +
        id + ".excerpt` is the source text the plan cites for it, with a few " +
        "lines of surrounding context. Judge whether the cited text backs " +
        "the claim.",
      criteria: {
        supports: "The excerpt states or directly implies the claim.",
        contradicts: "The excerpt states the opposite, or makes the claim false as written.",
        says_nothing: "The excerpt does not address the claim either way.",
      },
    };
  });
  const r = spawnSync("python3", [client, "ask"],
    { input: JSON.stringify({ state, questions }), encoding: "utf8", timeout: 45000 });
  if (r.status !== 0 || !r.stdout) return [];
  let answers;
  try { answers = JSON.parse(r.stdout); } catch { return []; }
  const warnings = [];
  resolvable.forEach((item, n) => {
    const a = answers["f" + n] || {};
    if ((a.confidence ?? 0) < CONFIDENCE_FLOOR) return;
    const where = `${item.ref.file}:${item.ref.from}`;
    if (a.choice === "contradicts")
      warnings.push(`fact ${item.i + 1} — the cited lines at ${where} read as contradicting the claim`);
    else if (a.choice === "says_nothing")
      warnings.push(`fact ${item.i + 1} — the cited lines at ${where} do not appear to mention the claim`);
  });
  return warnings;
}

// The whole check. Never throws, never blocks long: the deterministic half is
// local file reads, the judged half is one bounded subprocess, and any
// failure returns whatever was gathered before it.
export function checkEvidence(spec, root) {
  try {
    const { warnings, resolvable } = deterministicCheck(spec, root);
    const client = clientPath();
    if (client && resolvable.length && clientAvailable(client)) {
      try { warnings.push(...judgeFacts(resolvable, client)); }
      catch { /* judged half is optional by construction */ }
    }
    return warnings;
  } catch {
    return [];
  }
}
