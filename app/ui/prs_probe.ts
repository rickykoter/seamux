// node app/ui/prs_probe.ts — the Wake's PR grouping and mini bar (prs.ts), a
// pure module, which Node runs as TypeScript.
import { age, badgeOf, bar, byUrl, countsSaid, doneSaid, grouped, groupOf, type Pr } from "./prs.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${extra !== undefined ? "  :: " + JSON.stringify(extra) : ""}`);
  }
}

const pr = (n: number, state: string, c: [number, number, number, number] | null, extra: Partial<Pr> = {}): Pr => ({
  n, url: `https://github.com/o/r/pull/${n}`, title: `pr ${n}`, state,
  checks: c && { fail: c[0], run: c[1], pass: c[2], gate: c[3], unseen: 0 }, ...extra,
});

ok("an open red PR needs you", groupOf(pr(1, "open", [1, 0, 3, 0])) === "you");
ok("changes requested needs you", groupOf(pr(2, "open", [0, 0, 3, 0], { review: "CHANGES_REQUESTED" })) === "you");
ok("a conflict needs you", groupOf(pr(3, "open", [0, 0, 1, 0], { conflict: true })) === "you");
ok("a gate check needs people", groupOf(pr(4, "open", [0, 0, 3, 1])) === "people");
ok("a required review needs people", groupOf(pr(5, "open", [0, 0, 3, 0], { review: "REVIEW_REQUIRED" })) === "people");
ok("a red draft stays a draft", groupOf(pr(6, "draft", [2, 0, 0, 0])) === "draft");
ok("a draft waits on review without being people", groupOf(pr(7, "draft", [0, 1, 1, 0], { review: "REVIEW_REQUIRED" })) === "draft");
ok("a draft's gate check is people", groupOf(pr(8, "draft", [0, 0, 1, 1])) === "people");
ok("merged and closed are done", groupOf(pr(9, "merged", null)) === "done" && groupOf(pr(10, "closed", null)) === "done");

const all = [pr(1, "open", [1, 0, 3, 0]), pr(4, "open", [0, 0, 3, 1]), pr(6, "draft", [2, 0, 0, 0]), pr(11, "open", [0, 0, 2, 0], { review: "APPROVED" }),
  pr(9, "merged", null), pr(12, "merged", null), pr(10, "closed", null)];
const g = grouped(all);
ok("grouped keeps every group, in the list's order", [...g.keys()].join() === "you,people,draft,open,done" &&
  g.get("done")!.map((p) => p.n).join() === "9,12,10", [...g.entries()].map(([k, v]) => [k, v.map((p) => p.n)]));
ok("the done fold says merged and closed", doneSaid(g.get("done")!) === "2 merged · 1 closed");

const w = (s: { kind: string; cells: number }[]) => s.map((x) => `${x.kind}${x.cells}`).join(" ");
ok("the bar is always its width", [bar({ fail: 2, run: 0, pass: 6, gate: 1 }), bar({ fail: 1, run: 1, pass: 97, gate: 1 }), bar({ fail: 0, run: 3, pass: 5, gate: 0 })]
  .every((b) => b.reduce((s, x) => s + x.cells, 0) === 10));
ok("the bar puts fail first and gives each bucket a cell", w(bar({ fail: 1, run: 1, pass: 97, gate: 1 })) === "fail1 run1 pass7 gate1", w(bar({ fail: 1, run: 1, pass: 97, gate: 1 })));
ok("the bar splits by share", w(bar({ fail: 2, run: 0, pass: 6, gate: 1 })) === "fail2 pass7 gate1", w(bar({ fail: 2, run: 0, pass: 6, gate: 1 })));
ok("no checks, no bar", bar(null).length === 0 && bar({ fail: 0, run: 0, pass: 0, gate: 0 }).length === 0);
ok("the hover gives exact counts and what was not read", countsSaid({ fail: 2, run: 0, pass: 6, gate: 1, unseen: 4 }) === "2 failed · 6 passed · 1 waiting on people · 4 more not read");

const now = Date.parse("2026-11-12T12:00:00Z");
ok("age reads minutes, hours, days", age("2026-11-12T11:55:00Z", now) === "5m" && age("2026-11-12T10:00:00Z", now) === "2h" && age("2026-11-09T12:00:00Z", now) === "3d" && age("", now) === "");
const map = byUrl(all);
ok("a Wake row finds its PR by URL", map.get("https://github.com/o/r/pull/4")?.n === 4 && map.size === all.length);
ok("a row badge says the state, red only when a check failed",
  badgeOf(pr(1, "open", [1, 0, 3, 0])).cls === "bad" && badgeOf(pr(4, "open", [0, 0, 3, 1])).cls === "wait" &&
  badgeOf(pr(9, "merged", null)).text === "merged" && badgeOf(pr(11, "open", [0, 0, 2, 0])).cls === "ok");

console.log(`prs probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
