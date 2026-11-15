// node app/ui/release_probe.ts — the Lookout tab's rail from review to
// release (release.ts): each stage's state, where a change opens, and a
// list row's chip, with no DOM. Node runs this file as TypeScript.
import { chipFor, stageFor, stagesOf, took, type Landing, type PrRow } from "./release.ts";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail = "") => checks.push([name, cond, detail]);

const pr = (extra: Partial<PrRow> = {}): PrRow => ({ n: 231, url: "https://github.com/o/r/pull/231", title: "landing", state: "open",
  checks: { fail: 0, run: 0, pass: 3, gate: 0, unseen: 0 }, cwd: "/w", ws: "W", ws_title: "w", ...extra });
const merged = (extra: Partial<PrRow> = {}) => pr({ state: "merged", checks: null, merge: { sha: "a".repeat(40), at: "2026-11-15T09:00:00Z", base: "main" }, ...extra });
const land = (status: string, stage = "", live = false): Landing => ({ state: { merge: "a".repeat(40), recipes: {} }, overall: { status, stage, recipe: "seamux", live } });

// ---- the rail's stages ----------------------------------------------------
{
  const s = stagesOf(true, pr(), null);
  ok("rail: an open green PR with a review is reviewed, at PR, not merged, not landed",
    s.review === "done" && s.pr === "now" && s.merge === "none" && s.land === "none", JSON.stringify(s));
  ok("rail: a red PR is failed at PR", stagesOf(true, pr({ checks: { fail: 2, run: 0, pass: 1, gate: 0, unseen: 0 } }), null).pr === "failed");
  ok("rail: a conflict is failed at PR too", stagesOf(false, pr({ conflict: true }), null).pr === "failed");
  ok("rail: no review, the Review stage is none", stagesOf(false, pr(), null).review === "none");
  const m = stagesOf(true, merged(), land("landing", "install"));
  ok("rail: merged and landing", m.pr === "done" && m.merge === "done" && m.land === "now", JSON.stringify(m));
  ok("rail: a landing waiting on you needs you", stagesOf(true, merged(), land("awaiting", "notebook")).land === "needs");
  ok("rail: failed and stopped both read failed", stagesOf(true, merged(), land("failed")).land === "failed" && stagesOf(true, merged(), land("stopped")).land === "failed");
  ok("rail: landed is done", stagesOf(true, merged(), land("done", "", true)).land === "done");
}

// ---- where a change opens ---------------------------------------------------
ok("open: a reviewed open PR opens at Review", stageFor(true, pr(), null) === "review");
ok("open: an open PR with no review opens at PR", stageFor(false, pr(), null) === "pr");
ok("open: a merged PR with a landing opens at Land", stageFor(true, merged(), land("landing")) === "land");
ok("open: a merged PR with no landing opens at Merge", stageFor(true, merged(), null) === "merge");

// ---- a row's chip -----------------------------------------------------------
{
  const t = (p: PrRow | null, l: Landing | null) => chipFor(p, l)?.text ?? "";
  ok("chip: none without a PR", chipFor(null, null) === null);
  ok("chip: an open PR, red, running and green", t(pr({ checks: { fail: 2, run: 0, pass: 0, gate: 0, unseen: 0 } }), null) === "PR · ✗2" &&
    t(pr({ checks: { fail: 0, run: 3, pass: 0, gate: 0, unseen: 0 } }), null) === "PR · 3 running" && t(pr(), null) === "PR open");
  ok("chip: a draft says so", t(pr({ state: "draft" }), null) === "draft PR");
  ok("chip: merged with no landing", t(merged(), null) === "merged");
  ok("chip: landing names its stage", t(merged(), land("landing", "install")) === "landing · install");
  ok("chip: waiting, failed, stopped", t(merged(), land("awaiting")) === "landing needs you" && t(merged(), land("failed")) === "landing failed" &&
    t(merged(), land("stopped")) === "landing stopped");
  ok("chip: live only when the version matched", t(merged(), land("done", "", true)) === "live ✓" && t(merged(), land("done", "", false)) === "landed");
  ok("chip: its class says how it reads", chipFor(merged(), land("awaiting"))?.cls === "needs" && chipFor(merged(), land("failed"))?.cls === "failed");
}

// ---- a stage's time -------------------------------------------------------------
ok("took: seconds, then minutes and seconds", took(9_400) === "9s" && took(192_000) === "3m12s" && took(-5) === "0s");

let bad = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) bad++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` — ${detail}`}`);
}
console.log(`\n${checks.length - bad}/${checks.length} passed`);
process.exit(bad ? 1 : 0);
