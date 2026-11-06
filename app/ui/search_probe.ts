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

let failed = 0;
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : `\n       ${detail}`}`);
}
console.log(`search probe: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
