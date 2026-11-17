// node app/ui/doctor_probe.ts — the Doctor tab's triage model
// (doctor_model.ts), a pure module, which Node runs as TypeScript.
import { ACTIONS, ago, asks, counts, filterRows, headline, leftoversSaid, safeIds, triage, type Finding, type Row, type Scan } from "./doctor_model.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${extra !== undefined ? "  :: " + JSON.stringify(extra) : ""}`);
  }
}

const f = (kind: string, cls: Finding["class"], ws: string, title: string, fixes: string[] = []): Finding => ({
  id: `${kind}:${ws || title}`, kind, class: cls, ws, title, cwd: `/w/${title}`, pane: "", summary: kind, detail: "",
  session: "", subject: title, fixes: fixes.map((verb) => ({ verb, label: verb })),
});

const scan: Scan = {
  tmux: "ok", registry: "ok",
  findings: [
    f("merged-live", "confirm", "A", "alpha", ["reclaim"]),
    f("dead-gone", "safe", "B", "beta", ["forget"]),
    f("claude-exited", "confirm", "A", "alpha", ["resume", "fresh"]),
    f("missing-worktree", "confirm", "C", "gamma", ["forget"]),
    f("gone-owner", "report", "D", "delta"),
    f("orphan-held", "safe", "", "EEEEEEEE-2222-4333-8444-555555555555", ["delete"]),
    f("dead-gone", "safe", "F", "phi", ["forget"]),
  ],
};
const t = triage(scan);
ok("needs you groups by workspace", t.needs.map((g) => g.key).join() === "C,A,D", t.needs.map((g) => g.key));
ok("a group's worst finding is first", t.needs[1].findings.map((x) => x.kind).join() === "claude-exited,merged-live");
ok("safe findings fold into leftovers", t.leftovers.length === 3 && t.leftovers.every((x) => x.class === "safe"));
ok("the leftovers line counts by kind", leftoversSaid(t.leftovers) === "3 leftovers: 2 lost panes that can never restart, 1 stale held command", leftoversSaid(t.leftovers));
ok("the headline counts workspaces", headline(t) === "3 workspaces need you", headline(t));
ok("fix all safe takes every safe finding", safeIds(scan).length === 3);
ok("a safe fix runs at once", asks(scan.findings[1], scan.findings[1].fixes[0]) === "now");
ok("a confirm fix asks first", asks(scan.findings[2], scan.findings[2].fixes[0]) === "confirm");
ok("reclaim opens the wizard", asks(scan.findings[0], scan.findings[0].fixes[0]) === "wizard");

const blocked: Scan = { ...scan, tmux: "unreachable", findings: scan.findings.map((x) => ({ ...x, class: "report", fixes: [] })) };
const tb = triage(blocked);
ok("an unreachable tmux blocks the page", tb.blocked.includes("could not be asked") && headline(tb) === tb.blocked);
ok("nothing is safe to fix while blocked", safeIds(blocked).length === 0 && tb.leftovers.length === 0);
const unread: Scan = { tmux: "ok", registry: "x is not a registry", findings: [f("registry-unreadable", "report", "", "")] };
ok("an unreadable registry blocks the page", triage(unread).blocked.includes("registry"));

const healthy = triage({ tmux: "ok", registry: "ok", findings: [] });
ok("a healthy scan says so", headline(healthy) === "Every workspace looks healthy." && healthy.needs.length === 0);
ok("only leftovers is its own line", headline(triage({ tmux: "ok", registry: "ok", findings: [scan.findings[1]] })) === "Nothing needs you; only leftovers to clean.");
ok("a finding with no workspace is named by its subject, short", t.needs.every((g) => g.title) &&
  triage({ ...scan, findings: [f("orphan-session", "confirm", "", "AAAAAAAA-2222-4333-8444-555555555555", ["kill"])] }).needs[0].title === "AAAAAAAA-2222-4333-8444-555555555555");


const row = (cwd: string, state: Row["state"], when: number, extra: Partial<Row> = {}): Row => ({
  cwd, state, title: cwd.split("/").pop()!, latest: "", branch: "", when, exists: state !== "gone", ws: state === "live" ? "W" : "", sessions: [], transcript: "", ...extra,
});
const rows = [row("/w/alpha", "live", 100), row("/w/beta", "archived", 300, { branch: "dev/beta" }), row("/w/gamma", "past", 200, { latest: "fix the dock" }), row("/w/delta", "gone", 50)];
ok("counts each state", JSON.stringify(counts(rows)) === JSON.stringify({ live: 1, archived: 1, past: 1, gone: 1 }));
ok("all rows, newest first", filterRows(rows, "all", "").map((r) => r.title).join() === "beta,gamma,alpha,delta");
ok("a state filter keeps only its rows", filterRows(rows, "archived", "").map((r) => r.title).join() === "beta");
ok("search matches every word across title, branch and prompt", filterRows(rows, "all", "dock fix").map((r) => r.title).join() === "gamma" &&
  filterRows(rows, "all", "dev/beta").length === 1 && filterRows(rows, "all", "nope").length === 0);
ok("live archives with a confirm; archived restores at once and forgets with one", ACTIONS.live[0].confirm && !ACTIONS.archived[0].confirm && ACTIONS.archived[1].confirm);
ok("a gone row offers nothing to click", ACTIONS.gone.length === 0 && ACTIONS.past[0].verb === "resume");
ok("ago reads as crew-resume's", ago(1000, 1000 + 300) === "5m" && ago(1000, 1000 + 7200) === "2h" && ago(1000, 1000 + 3 * 86400) === "3d" && ago(0, 5) === "");

console.log(`doctor_probe: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
