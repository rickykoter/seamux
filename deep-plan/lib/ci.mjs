#!/usr/bin/env node
// The `ci` check kind (ADR 0066): the branch's PR checks, behind the same
// gate as every other proof. deep-plan synthesizes the command; no recipe
// names it. Run from the plan root:
//
//   node lib/ci.mjs wait [--timeout <seconds>] [--interval <seconds>]
//
// It fails at once when the branch has no PR, or the PR head is not local
// HEAD (a verdict must be about the tree being closed, and the engine never
// pushes). Otherwise it polls `gh pr checks` until nothing is pending: exit
// 0 when every check passed or was skipped, 1 when any failed (each named,
// with the failed job's log tail when it is an Actions job). Exit 3 is "no
// CI verdict": no PR, not pushed, gh failing, or the wait timed out. It
// fails the check but does not count toward the retry cap, since no CI run
// went red.
// gh is DEEP_PLAN_GH, so the probe can stand a fake in.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GH = () => process.env.DEEP_PLAN_GH || "gh";
export const CI_TIMEOUT_S = 1800;
const INTERVAL_S = 30, LOG_LINES = 60, LOGS_CAP = 3;
export const NO_VERDICT = 3;

function gh(args, cwd) {
  const r = spawnSync(GH(), args, { encoding: "utf8", cwd, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error && r.error.code === "ENOENT") return { err: `${GH()} is not installed (or not on PATH); a ci check reads the PR through it` };
  if (r.error) return { err: `${GH()} ${args.slice(0, 2).join(" ")}: ${r.error.message}` };
  return { status: r.status, out: r.stdout || "", errText: (r.stderr || "").trim() };
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

// The PR for the branch at cwd, and whether its head is local HEAD.
export function prState(cwd) {
  const v = gh(["pr", "view", "--json", "number,url,headRefOid,isDraft"], cwd);
  if (v.err) return { error: v.err };
  const pr = v.status === 0 ? parse(v.out) : null;
  if (!pr) return { error: `no PR for this branch (${v.errText.split("\n").pop() || "gh pr view found none"}): push it and open the draft PR first` };
  const h = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" });
  const head = h.status === 0 ? h.stdout.trim() : "";
  if (!head || head !== pr.headRefOid)
    return { pr, error: `the PR head (${String(pr.headRefOid).slice(0, 8)}) is not local HEAD (${head.slice(0, 8) || "?"}): push first, so CI runs on the tree being closed` };
  return { pr };
}

// One look at the checks: {pending, failed, passed} lists of {name, link}.
export function checksNow(cwd) {
  const c = gh(["pr", "checks", "--json", "name,bucket,link,workflow"], cwd);
  if (c.err) return { error: c.err };
  // gh exits 8 while checks are pending and 1 when one failed; the JSON is
  // the answer either way.
  // Right after a push gh may say no checks are reported yet: that is none
  // pending so far, and the wait goes on.
  if (!c.out.trim() && /no checks reported/i.test(c.errText)) return { pending: [], failed: [], passed: [], total: 0 };
  const rows = parse(c.out);
  if (!Array.isArray(rows)) return { error: `gh pr checks: ${c.errText.split("\n").pop() || "no JSON"}` };
  const by = b => rows.filter(r => r.bucket === b).map(r => ({ name: r.workflow ? `${r.workflow} / ${r.name}` : r.name, link: r.link || "" }));
  return { pending: by("pending"), failed: [...by("fail"), ...by("cancel")], passed: [...by("pass"), ...by("skipping")], total: rows.length };
}

// The tail of a failed Actions job's log, when the link is one.
function jobTail(link, cwd) {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(link || "");
  if (!m) return "";
  const r = gh(["run", "view", m[1], "--job", m[2], "--log-failed"], cwd);
  if (r.err || r.status !== 0) return "";
  return r.out.split("\n").filter(l => l.trim()).slice(-LOG_LINES)
    .map(l => l.split("\t").slice(2).join("\t") || l).join("\n");
}

export async function wait({ cwd = process.cwd(), timeoutS = CI_TIMEOUT_S, intervalS = INTERVAL_S, say = console.log } = {}) {
  const p = prState(cwd);
  if (p.error) { say(`ci: ${p.error}`); return NO_VERDICT; }
  say(`ci: PR #${p.pr.number} ${p.pr.url} at ${String(p.pr.headRefOid).slice(0, 8)}`);
  const end = Date.now() + timeoutS * 1000;
  for (let first = true; ; first = false) {
    const c = checksNow(cwd);
    if (c.error) { say(`ci: ${c.error}`); return NO_VERDICT; }
    if (!c.pending.length && c.total) {
      if (!c.failed.length) { say(`ci: all ${c.passed.length} check(s) passed`); return 0; }
      say(`ci: ${c.failed.length} of ${c.total} check(s) failed: ${c.failed.map(f => f.name).join(", ")}`);
      for (const f of c.failed.slice(0, LOGS_CAP)) {
        const t = jobTail(f.link, cwd);
        if (t) say(`\n--- ${f.name} (${f.link})\n${t}`);
        else if (f.link) say(`  ${f.name}: ${f.link}`);
      }
      return 1;
    }
    if (Date.now() >= end) {
      say(`ci: timed out after ${timeoutS}s with ${c.pending.length || "no"} check(s) still pending${c.pending.length ? ": " + c.pending.map(x => x.name).join(", ") : " (none reported yet)"}`);
      return NO_VERDICT;
    }
    if (first) say(`ci: waiting on ${c.pending.length || "not yet reported"} check(s)…`);
    await new Promise(r => setTimeout(r, intervalS * 1000));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const opt = (k, d) => {
    const i = a.indexOf(k);
    if (i < 0) return d;
    const v = Number(a[i + 1]);
    if (!Number.isFinite(v) || v < 0) { console.error(`ci.mjs: ${k} takes a number of seconds`); process.exit(2); }
    return v;
  };
  if (a[0] !== "wait") { console.error("usage: ci.mjs wait [--timeout <seconds>] [--interval <seconds>]"); process.exit(2); }
  process.exit(await wait({ timeoutS: opt("--timeout", CI_TIMEOUT_S), intervalS: opt("--interval", process.env.DEEP_PLAN_CI_INTERVAL_S !== undefined ? Number(process.env.DEEP_PLAN_CI_INTERVAL_S) : INTERVAL_S) }));
}
