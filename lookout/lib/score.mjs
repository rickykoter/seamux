// How risky each changed file is, in [0,1], with the reasons a reader sees.
//
// Two halves, blended in code:
//   signals — deterministic and always present: churn, what kind of path it is
//             (hooks, servers and routes, schemas and migrations, config,
//             auth and secrets, docs), tests-only and generated files
//             down-weighted, and the worst open finding on the file.
//   jev     — one TypeSafe `score` per file, all files in batched requests,
//             read from the answer's distribution. By default the request
//             carries only path, status and line counts; hunk text goes only
//             to a loopback endpoint or with `.seamux/lookout.json`
//             { "sendContent": true }. Any failure drops the whole Jev half:
//             risk falls back to signals only and the page says why.
//
// Jev answers are cached in the store by patch hash (scoring.jev), so
// re-ranking after a finding lands, or re-opening an unchanged diff, costs no
// request.
import * as T from "./typesafe.mjs";

export const BANDS = [["high", 0.6], ["medium", 0.35], ["low", 0]];
export const bandOf = r => BANDS.find(([, min]) => r >= min)[0];

const KINDS = [
  // [label, risk, test] — first match wins, so the order is the precedence.
  ["auth or secrets", 0.85, /(^|[\/_.-])(auth|login|session|token|secret|credential|crypt|permission|guard|sandbox)/i],
  ["schema or migration", 0.8, /(^|\/)(migrations?|schema)|\.(sql|proto|graphql|gql|prisma)$/i],
  ["hook", 0.75, /(^|\/)(\.githooks|hooks?)\//i],
  ["server or route", 0.7, /(^|[\/_.-])(server|routes?|api|handlers?|controllers?|endpoints?|intent|middleware)([\/_.-]|$)/i],
  ["install or CI", 0.65, /(^|\/)(install\.sh|Dockerfile|Makefile|\.github\/workflows\/)|\.ya?ml$/i],
  ["config", 0.55, /(^|\/)(\.seamux|config|settings)\/|\.(json|toml|ini|cfg|conf|env)$|(^|\/)\.[a-z]+rc$/i],
  ["docs", 0.1, /\.(md|mdx|txt|rst|adoc)$|(^|\/)(docs?|CHANGELOG|LICENSE)(\/|$|\.)/i],
];
const TEST = /(^|\/)(tests?|__tests__|spec|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)probe\.mjs$|_probe\.(mjs|py)$/i;
export const isTest = p => TEST.test(p);

const SEVERITY = { blocker: 1, major: 0.75, minor: 0.35, nit: 0.1 };

// The deterministic half for one file: { value, reasons }. Findings are not
// in it: they apply after the blend, so no score can water a blocker down.
export function signals(f) {
  const reasons = [];
  const changed = f.adds + f.dels;
  const churn = Math.min(1, Math.log10(1 + changed) / 3);           // 1000 lines → 1
  if (changed >= 200) reasons.push(`${changed} lines changed`);
  const kind = KINDS.find(([, , re]) => re.test(f.path));
  let pathRisk = kind ? kind[1] : 0.4;
  if (kind) reasons.push(kind[0]);
  if (f.status === "D") { pathRisk = Math.max(pathRisk, 0.5); reasons.push("deleted"); }
  let v = 0.4 * churn + 0.6 * pathRisk;
  if (isTest(f.path)) { v *= 0.5; reasons.push("tests only"); }
  if (f.generated) { v *= 0.3; reasons.push("generated"); }
  return { value: Math.min(1, Math.max(0, v)), reasons };
}

// The worst finding still open on a file: { weight, severity } or null.
// "addressed" still counts: only a human's resolve or dismiss closes one.
export function worstFinding(file, findings = []) {
  let best = null;
  for (const x of findings) {
    if (x.file !== file || x.status === "resolved" || x.status === "dismissed") continue;
    const w = SEVERITY[x.severity] || 0;
    if (w && (!best || w > best.weight)) best = { weight: w, severity: x.severity };
  }
  return best;
}

const CRITERIA = [
  "Cosmetic: docs, comments, formatting or naming; no behavior changes.",
  "Low: a contained logic change, a test, or something trivially reverted.",
  "Moderate: changes behavior that other code or people rely on.",
  "High: security, auth, data or persistence, concurrency, public interfaces, install or deploy paths, or hard to revert.",
];
const BATCH = 25;               // questions per request
const MAX_FILES = 100;          // files scored by Jev per review; the rest: signals
const CONTENT_CAP = 2500;       // hunk characters per file, when content is allowed

// The Jev half: { ok, jev: {path: [0,1]}, content, why }. `hunkText(path)`
// supplies the changed lines when content may be sent.
export function jevScores(files, { cfg = {}, hunkText = () => "" } = {}) {
  const content = T.contentAllowed(cfg);
  const pick = files.filter(f => !f.binary && !f.generated).slice(0, MAX_FILES);
  const jev = {};
  for (let i = 0; i < pick.length; i += BATCH) {
    const state = {}, questions = {};
    pick.slice(i, i + BATCH).forEach((f, k) => {
      const id = "f" + (i + k);
      state[id] = { path: f.path, status: f.status, added_lines: f.adds, removed_lines: f.dels };
      if (content) state[id].changed_hunks = String(hunkText(f.path) || "").slice(0, CONTENT_CAP);
      questions[id] = {
        type: "score",
        instructions: "`" + id + "` describes one file changed in a code change under review: its " +
          "path, status (M modified, A added, D deleted, R renamed) and added/removed line counts" +
          (content ? ", and `" + id + ".changed_hunks`, the changed lines" : "") +
          ". How risky is this file's change to ship — how likely to break something, and how badly?",
        criteria: CRITERIA,
      };
    });
    const r = T.ask(state, questions);
    if (!r.ok) return { ok: false, jev: {}, content, why: r.why };
    for (const [id, ans] of Object.entries(r.answers || {})) {
      const f = pick[Number(id.slice(1))];
      const v = T.expected(ans);
      if (f && v != null) jev[f.path] = Math.round(v * 1000) / 1000;
    }
  }
  if (pick.length && !Object.keys(jev).length)
    return { ok: false, jev: {}, content, why: "TypeSafe answered without usable scores" };
  return { ok: true, jev, content, why: "" };
}

// Every file's risk from signals and the cached Jev scores. Mutates the file
// entries (risk, band, reasons, jev) and returns them.
export function rank(files, findings, scoring) {
  const jev = (scoring && scoring.ok && scoring.jev) || {};
  for (const f of files) {
    const s = signals(f);
    const j = jev[f.path];
    let risk = s.value;
    const reasons = [...s.reasons];
    if (typeof j === "number") {
      // Jev reads the change; signals read the path. Neither alone, and a test
      // or a generated file stays down-weighted whatever Jev thought of it.
      const damp = (isTest(f.path) ? 0.5 : 1) * (f.generated ? 0.3 : 1);
      risk = 0.5 * s.value + 0.5 * j * damp;
      reasons.unshift(`Jev ${Math.round(j * 100)}%`);
    }
    const worst = worstFinding(f.path, findings);
    if (worst) { risk = 1 - (1 - risk) * (1 - worst.weight); reasons.push(`open ${worst.severity} finding`); }
    f.risk = Math.round(risk * 1000) / 1000;
    f.band = bandOf(f.risk);
    f.reasons = reasons;
    f.jev = typeof j === "number" ? j : null;
  }
  return files;
}
