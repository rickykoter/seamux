// node app/ui/search_probe.ts — the session search's rows, matching and
// order (search.ts), with no DOM. Node runs this file as TypeScript.
import { fuzzy, rowsOf, search, type Inputs, type TileIn } from "./search.ts";

const checks: [string, boolean, string?][] = [];
const ok = (name: string, cond: boolean, detail = "") => checks.push([name, cond, detail]);

const tile = (ws: string, surface: string, over: Partial<TileIn> = {}): TileIn => ({
  surface, workspace: ws, workspace_title: "", label: "Claude Code", cwd: `/code/${ws}`, agent: "claude",
  state: "idle", since: 1_000, lines: [], topic: null, root: "", owner: null, ...over,
});
const inputs = (over: Partial<Inputs> = {}): Inputs => ({ tiles: [], plans: [], asks: [], tucked: [], priority: {}, branches: {}, ...over });
const names = (q: string, i: Inputs) => search(rowsOf(i), q).map((h) => h.row.name);

// ---- fuzzy ---------------------------------------------------------------
{
  const run = fuzzy("pay", "payments-retry")!, spread = fuzzy("pay", "p-a-y")!;
  ok("fuzzy: a run of the query beats the same letters spread out", run.score > spread.score, `${run.score} ${spread.score}`);
  ok("fuzzy: a run at a word start beats one inside a word",
    fuzzy("retry", "payments-retry")!.score > fuzzy("retry", "payretryments")!.score);
  ok("fuzzy: letters out of order do not match", fuzzy("yap", "payments") === null);
  ok("fuzzy: initials across words match, at the word starts",
    JSON.stringify(fuzzy("pr", "payments-retry")?.at) === "[0,9]", JSON.stringify(fuzzy("pr", "payments-retry")));
  ok("fuzzy: preferring a word start never loses a match the plain walk finds", fuzzy("ab", "xaYb aZ") !== null);
  ok("fuzzy: case does not matter", fuzzy("DOCK", "dev/dock-density") !== null);
}

// ---- rows ----------------------------------------------------------------
{
  const i = inputs({
    tiles: [
      tile("W1", "S1", { workspace_title: "payments", state: "idle", topic: "retry backoff", lines: ["$ cargo test"] }),
      tile("W1", "S2", { state: "needs_input", since: 2_000 }),
      tile("W1", "T1", { agent: null, state: "shell" }),
      tile("W2", "S3", { state: "working", root: "/code/dock" }),
      tile("W3", "S4", { workspace_title: "tucked-but-open" }),
    ],
    plans: [{ ws: "W1", slug: "pay-retry" }],
    asks: [{ ws: "W1", text: "which backoff?" }],
    tucked: [
      { path: "/code/payroll", name: "payroll-spike", branch: "dev/payroll", level: "tuck", waiting: false, last: 500, workspaces: [] },
      { path: "/code/t3", name: "tucked-but-open", branch: "dev/t3", level: "mute", waiting: false, last: 600, workspaces: ["W3"] },
    ],
    priority: { W1: 0.8 },
    branches: { W1: "dev/pay-retry", W2: "dev/dock-density" },
  });
  const rows = rowsOf(i);
  const w1 = rows.find((r) => r.ws === "W1")!;
  ok("rows: one per live workspace, its waiting pane leading", rows.filter((r) => r.ws === "W1").length === 1 && w1.pane === "S2" && w1.state === "needs_input", JSON.stringify(w1));
  ok("rows: a live row carries its branch, topic, plan, ask and priority",
    w1.branch === "dev/pay-retry" && w1.topic === "retry backoff" && w1.plan === "pay-retry" && w1.ask === "which backoff?" && w1.priority === 0.8);
  ok("rows: a workspace with no title is named by its worktree", rows.find((r) => r.ws === "W2")!.name === "dock");
  const t3 = rows.filter((r) => r.name === "tucked-but-open");
  ok("rows: a tucked worktree still open is one row, the tucked one, that can still jump",
    t3.length === 1 && t3[0].level === "mute" && t3[0].ws === "W3" && t3[0].tuckPath === "/code/t3", JSON.stringify(t3));
  ok("rows: a tucked worktree with nothing open has no workspace to jump to", rows.find((r) => r.name === "payroll-spike")!.ws === "");
  const snz = rowsOf(inputs({ tucked: [{ path: "/s", name: "snoozy", branch: "", level: "snooze", until: 9_000, waiting: false, last: 0, workspaces: [] }] }))[0];
  ok("rows: a hidden-for-now row carries when it comes back, so the list can say until when; a live one carries 0",
    snz.level === "snooze" && snz.until === 9_000 && w1.until === 0, JSON.stringify(snz));

  // ---- order -------------------------------------------------------------
  ok("order: part of a branch finds its session", names("density", i)[0] === "dock", JSON.stringify(names("density", i)));
  ok("order: an ask's words find the session that asked", names("backoff", i)[0] === "payments");
  ok("order: tucked rows sit below live ones, even when they match better",
    JSON.stringify(names("pay", i)) === JSON.stringify(["payments", "payroll-spike"]), JSON.stringify(names("pay", i)));
  ok("order: every word must match somewhere", names("pay zzz", i).length === 0 && names("pay retry", i)[0] === "payments");
  ok("order: with no query, live first, the waiting and higher priority on top, tucked last",
    JSON.stringify(names("", i)) === JSON.stringify(["payments", "dock", "tucked-but-open", "payroll-spike"]), JSON.stringify(names("", i)));
  const h = search(rows, "dock")[0];
  ok("marks: the matched letters are kept per field, for the page to underline",
    JSON.stringify(h.marks.name) === "[0,1,2,3]" || JSON.stringify(h.marks.branch) === "[4,5,6,7]", JSON.stringify(h.marks));
}

// ---- priority breaks a tie, never a clear win ------------------------------
{
  const i = inputs({
    tiles: [tile("A", "SA", { workspace_title: "api-alpha", since: 9_000 }), tile("B", "SB", { workspace_title: "api-beta", since: 1_000 })],
    priority: { B: 0.9 },
  });
  ok("order: two equal matches go to the higher priority", names("api", i)[0] === "api-beta", JSON.stringify(names("api", i)));
  const j = inputs({
    tiles: [tile("A", "SA", { workspace_title: "alpha" }), tile("B", "SB", { workspace_title: "a-l-p-h-a" })],
    priority: { B: 1 },
  });
  ok("order: a clearly better match wins over a higher priority", names("alpha", j)[0] === "alpha", JSON.stringify(names("alpha", j)));
  const k = inputs({ tiles: [tile("A", "SA", { workspace_title: "api-alpha", since: 1_000 }), tile("B", "SB", { workspace_title: "api-beta", since: 9_000 })] });
  ok("order: with equal match and priority, the most recent first", names("api", k)[0] === "api-beta");
}

// ---- the order is well defined, and marks line up with the text -----------
{
  const t = (ws: string, title: string, since: number) => tile(ws, "S" + ws, { workspace_title: title, since });
  const i = inputs({ tiles: [t("A", "api", 3), t("B", "api-b", 2), t("C", "x-api-c", 1), t("D", "a-p-i", 4)], priority: { C: 0.5 } });
  const once = names("api", i);
  const again = names("api", inputs({ ...i, tiles: [...i.tiles].reverse() }));
  ok("order: the same rows in another order rank the same", JSON.stringify(once) === JSON.stringify(again), `${once} | ${again}`);
  // A strong tucked match must not turn a clear live win into a tie.
  const w = inputs({
    tiles: [t("A", "alpha", 1), t("B", "a-l-p-h-a", 2)], priority: { B: 1 },
    tucked: [{ path: "/t", name: "alpha alpha alpha", branch: "alpha", level: "tuck", waiting: false, last: 0, workspaces: [] }],
  });
  ok("order: tie bands are counted within live rows, apart from tucked ones", names("alpha", w)[0] === "alpha", JSON.stringify(names("alpha", w)));
  const m = fuzzy("x", "İx");
  ok("fuzzy: marks are indices into the text as written, past a letter whose lower case is longer",
    JSON.stringify(m?.at) === "[1]", JSON.stringify(m));
}

// ---- the preview's plan progress, panes and family -------------------------
{
  const i = inputs({
    tiles: [
      tile("W1", "S1", { workspace_title: "payments", state: "idle" }),
      tile("W1", "T1", { agent: null, label: "zsh", state: "shell", running: "cargo test" }),
      tile("W1", "S2", { state: "needs_input", label: "Claude Code" }),
      tile("W1", "T2", { agent: null, label: "", state: "shell", running: null }),
      tile("W2", "S3", { workspace_title: "child-a" }),
      tile("W4", "S5", { workspace_title: "loose" }),
    ],
    plans: [
      { ws: "W1", slug: "pay-retry", phase: "implementing", done: 2, total: 6, n: 3, open: true, title: "Retry with backoff" },
      { ws: "W2", slug: "child-a", phase: "planning", done: 0, total: 0, n: 0, open: false, title: "" },
    ],
    gates: [
      { ws: "W1", slug: "pay-retry", n: 3, checks: [{ name: "unit", status: "pass" }, { name: "e2e checkout", status: "fail" }] },
      { ws: "W2", slug: "other-plan", n: 1, checks: [{ name: "lint", status: "fail" }] },
    ],
    families: [{ parent: "pay-retry", members: [
      { slug: "pay-retry", role: "parent", phase: "implementing", done: 2, total: 6, ws: "W1" },
      { slug: "child-a", role: "child", phase: "planning", done: 0, total: 0, ws: "W2" },
    ] }],
  });
  const rows = rowsOf(i);
  const w1 = rows.find((r) => r.ws === "W1")!, w2 = rows.find((r) => r.ws === "W2")!, w4 = rows.find((r) => r.ws === "W4")!;
  ok("progress: a row carries its plan's phase, done of total and the open increment's number and title",
    JSON.stringify(w1.progress) === JSON.stringify({ slug: "pay-retry", phase: "implementing", done: 2, total: 6, n: 3, open: true, title: "Retry with backoff", failing: "e2e checkout" }),
    JSON.stringify(w1.progress));
  ok("progress: a lost check counts as failing, as the Dock counts it",
    rowsOf({ ...i, gates: [{ ws: "W1", slug: "pay-retry", n: 3, checks: [{ name: "e2e", status: "lost" }] }] }).find((r) => r.ws === "W1")!.progress?.failing === "e2e");
  ok("progress: a failing check counts only from its own plan's gate", w2.progress?.failing === "", JSON.stringify(w2.progress));
  ok("progress: a workspace with no plan has none", w4.progress === null);
  ok("panes: every pane, agents first with the waiting one on top, then shells",
    JSON.stringify(w1.panes.map((p) => p.surface)) === JSON.stringify(["S2", "S1", "T1", "T2"]), JSON.stringify(w1.panes));
  ok("panes: an agent says its state, a shell what it runs, else that it is a shell",
    JSON.stringify(w1.panes.map((p) => p.doing)) === JSON.stringify(["needs_input", "idle", "cargo test", "shell"])
    && w1.panes[2].who === "zsh" && w1.panes[3].who === "terminal", JSON.stringify(w1.panes));
  ok("family: a member's row carries its parent, every member and which one it is",
    w2.family?.parent === "pay-retry" && w2.family.self === "child-a" && w2.family.members.length === 2, JSON.stringify(w2.family));
  ok("family: a workspace outside any family has none", w4.family === null);
  const pr = { n: "12", url: "https://x/12", state: "open", ci: "fail", review: "" };
  const withPr = rowsOf({ ...i, pr: { W1: pr } });
  ok("pr: a row carries its workspace's PR and CI as published, and none without",
    JSON.stringify(withPr.find((r) => r.ws === "W1")!.pr) === JSON.stringify(pr) && withPr.find((r) => r.ws === "W4")!.pr === null && w1.pr === null);
  ok("inputs: rows still build with no families or gates given",
    rowsOf(inputs({ tiles: [tile("X", "SX")], plans: [{ ws: "X", slug: "p" }] }))[0].progress?.failing === "");
}

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : `\n       ${detail}`}`);
}
console.log(`search probe: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
