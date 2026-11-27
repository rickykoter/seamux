// node app/ui/wakeshelf_probe.ts — the Wake's shelves and turn cards
// (wakeshelf.ts), a pure module, which Node runs as TypeScript.
import {
  backgroundTask, incrementAt, laneStates, lanesOf, atRiskFirst, kept, needsOf, planState, reviewName, shelfOf, shelves, stageSaid, stepKey, timelineOrder, turns,
  type Input, type PlanRow, type ReviewSum, type ShelfPr, type ShelfRow,
} from "./wakeshelf.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${extra !== undefined ? "  :: " + JSON.stringify(extra) : ""}`);
  }
}

const WS = "/code/shop.worktrees/coupons";
const at = (h: number, m: number, day = 26) => new Date(2026, 10, day, h, m).toISOString();
let nextId = 100;
function row(kind: string, title: string, prompt: string, when: string, extra: Partial<ShelfRow> = {}): ShelfRow {
  return { id: nextId++, kind, title, path: `${WS}/${title}`, url: "", sha: "", created_at: when, session_id: "s1", prompt, locator: "", state: "ok", ...extra };
}
function pr(n: number, state: string, group: string, extra: Partial<ShelfPr> = {}): ShelfPr {
  return { n, url: `https://github.com/o/r/pull/${n}`, title: `PR ${n}`, state, group, checks: { fail: 0, run: 0, pass: 4, gate: 0 }, ...extra };
}
function review(id: string, extra: Partial<ReviewSum> = {}): ReviewSum {
  return {
    id, title: id, plan: "", inc: null, updatedAt: at(12, 0), reviewer: "agent", stage: "fix", gate: { code: 1, why: "" },
    counts: { blocker: 0, major: 1, minor: 0, nit: 0 }, unaddressed: 1, addressed: 0, round: { sealed: 0, pending: 0, max: 2, n: 0 },
    claims: { unchecked: 0, broken: 0 }, needsPerson: false, closeIds: [], past: false, closedAt: null, ...extra,
  };
}
const empty: Input = { ws: WS, rows: [], prs: [], reviews: [], plans: [] };

// ------------------------------------------------------------ needs
{
  ok("nothing waiting: no needs (the page says 'Nothing needs you')", needsOf(empty).length === 0);
  const prs = [
    pr(39, "merged", "done", { merge: { sha: "m39", at: at(11, 0) }, landing: { overall: { status: "awaiting", stage: "notebook", recipe: "deploy", live: true } } }),
    pr(47, "open", "you", { checks: { fail: 2, run: 0, pass: 6, gate: 0 } }),
    pr(46, "open", "people"),
  ];
  const reviews = [review("inc1", { stage: "close", needsPerson: true, closeIds: ["f1"] }), review("inc2")];
  const rows = [
    row("temp", "coupon-totals.json", "go 2", at(13, 33), { state: "risk" }), row("image", "coupon-error.png", "go 2", at(13, 16), { state: "risk" }),
    row("ask", "Bad code: what should checkout do?", "go 2", at(13, 10)),
  ];
  const n = needsOf({ ...empty, prs, reviews, rows });
  ok("needs: landing, red PR, review to close, files at risk, in that order",
    n.map((x) => x.kind).join() === "landing,pr,review,risk", n.map((x) => x.kind));
  // An ask's page says it waits until answered there; one answered in
  // Claude's terminal would stay. So asks are not in Needs you.
  ok("needs: an ask is not in Needs you; it is on Plans and asks",
    !n.some((x) => (x.kind as string) === "ask") && shelves({ ...empty, rows }).plans.some((r) => r.kind === "ask"));
  const land = n.find((x) => x.kind === "landing");
  ok("needs: a landing names the stage it waits at", land?.kind === "landing" && land.stage === "notebook" && /approve notebook/.test(land.title));
  const red = n.find((x) => x.kind === "pr");
  ok("needs: a red PR says why", red?.kind === "pr" && red.why === "2 checks failing");
  const asked = needsOf({ ...empty, reviews: [review("used", { stage: "ask", needsPerson: true, addressed: 3, round: { sealed: 2, pending: 3, max: 2, n: 2 } })] });
  ok("needs: a review whose rounds are used up counts its waiting fixes and says it is the person's call",
    asked[0]?.kind === "review" && asked[0].findings === 3 && /your call/.test(asked[0].why), asked);
  const risk = n.find((x) => x.kind === "risk");
  ok("needs: files at risk are one item that lists them", risk?.kind === "risk" && risk.rows.length === 2 && risk.title === "1 file and 1 picture will be lost", risk?.title);
}

// ------------------------------------------------------------ lanes
{
  ok("lane: an open PR with a check running", laneStates(pr(45, "open", "open", { review: "REVIEW_REQUIRED", checks: { fail: 0, run: 3, pass: 5, gate: 0 } })).join() === "now,now,none,none");
  ok("lane: a merged PR landing at deploy", laneStates(pr(41, "merged", "done", { review: "APPROVED", landing: { overall: { status: "landing", stage: "deploy", recipe: "d", live: false } } })).join() === "done,done,done,now");
  ok("lane: a landing that waits on the person", laneStates(pr(39, "merged", "done", { landing: { overall: { status: "awaiting", stage: "notebook", recipe: "d", live: true } } }))[3] === "needs");
  ok("lane: failing checks and changes requested", laneStates(pr(47, "open", "you", { review: "CHANGES_REQUESTED", checks: { fail: 1, run: 0, pass: 0, gate: 0 } })).slice(0, 2).join() === "failed,failed");
  const lanes = lanesOf([
    pr(38, "merged", "done", { landing: { overall: { status: "done", stage: "", recipe: "d", live: true } } }),
    pr(36, "merged", "done", { landing: { overall: { status: "done", stage: "", recipe: "d", live: true } } }),
    pr(42, "draft", "draft"), pr(45, "open", "open"), pr(46, "open", "people"),
    pr(41, "merged", "done", { landing: { overall: { status: "landing", stage: "deploy", recipe: "d", live: false } } }),
    pr(39, "merged", "done", { landing: { overall: { status: "awaiting", stage: "notebook", recipe: "d", live: true } } }),
    pr(47, "open", "you"),
  ]);
  ok("lanes: needs you, then landings, people, open, draft, done", lanes.map((l) => l.pr.n).join() === "47,39,41,46,45,42,38,36", lanes.map((l) => l.pr.n));
  ok("lanes: every PR has a lane, finished ones included (none folds away)", lanes.length === 8);
}

// ------------------------------------------------------------ shelves
{
  ok("shelf: images and videos are pictures", shelfOf("image") === "pictures" && shelfOf("video") === "pictures");
  ok("shelf: commits and lookout's turn rows are commits", shelfOf("commit") === "commits" && shelfOf("turn") === "commits");
  ok("shelf: plans, asks and issues share a shelf", ["plan", "ask", "issue"].every((k) => shelfOf(k) === "plans"));
  ok("shelf: docs, temp files and the rest are files", ["doc", "temp", "file", "artifact"].every((k) => shelfOf(k) === "files"));
  const rows = [
    row("commit", "checkout: apply percent_off", "go 2", at(13, 36)),
    row("temp", "coupon-totals.json", "go 2", at(13, 33), { state: "risk" }),
    row("doc", "totals-report.html", "go 2", at(13, 18)),
    row("video", "checkout-walkthrough.webm", "go 2", at(13, 17)),
    row("image", "checkout-after.png", "go 2", at(13, 15)),
    row("review", "coupons · increment 1", "go 1", at(12, 39), { locator: "coupons-inc1" }),
    row("ask", "Bad code?", "Take coupons", at(12, 41)),
    row("plan", "Take coupons", "Take coupons", at(11, 53)),
  ];
  const reviews = [review("live1"), review("old", { past: true, stage: "past", closedAt: at(9, 0) }), review("older", { past: true, stage: "past", closedAt: at(8, 0) })];
  const s = shelves({ ...empty, rows, reviews, prs: [pr(47, "open", "you"), pr(42, "draft", "draft")] });
  ok("shelves: pictures, files, commits and plans from the rows", s.pictures.length === 2 && s.files.length === 2 && s.commits.length === 1 && s.plans.length === 2);
  ok("shelves: a file at risk comes first, even when older", s.files.map((r) => r.title).join() === "coupon-totals.json,totals-report.html");
  ok("shelves: review rows stay off the shelves (lookout's reviews are drawn there)", !s.order.some((k) => k === `row:${rows[5].id}`));
  ok("shelves: past reviews newest closed first", s.reviews.past.map((r) => r.id).join() === "old,older");
  const kinds = s.order.map((k) => k.split(":")[0]);
  ok("shelves: reading order is needs, reviews, plans, PRs, pictures, files, commits",
    kinds.join() === "needpr,risk,review,review,review,row,row,pr,pr,row,row,row,row,row", kinds);
}

// ------------------------------------------------------------ turns
{
  const plans: PlanRow[] = [{
    slug: "coupons", title: "Take coupon codes at checkout",
    increments: [
      { n: 1, title: "one", status: "done", authorizedAt: Date.parse(at(12, 30)), doneAt: Date.parse(at(12, 45)) },
      { n: 2, title: "two", status: "working", authorizedAt: Date.parse(at(13, 10)), doneAt: 0 },
    ],
  }];
  ok("incrementAt: inside a done increment's window", incrementAt(plans, Date.parse(at(12, 39))) === "coupons · increment 1");
  ok("incrementAt: an open increment's window runs on", incrementAt(plans, Date.parse(at(18, 0))) === "coupons · increment 2");
  ok("incrementAt: between increments there is no name", incrementAt(plans, Date.parse(at(13, 0))) === null);
  ok("incrementAt: named by the plan's slug, as Reviews names it", incrementAt([{ slug: "s", title: "A long title", increments: [{ n: 3, title: "", status: "working", authorizedAt: 1 }] }], 5) === "s · increment 3");
  const rows = [
    row("commit", "c2", "go 2", at(13, 36)), row("image", "after.png", "go 2", at(13, 15)), row("temp", "totals.json", "go 2", at(13, 14), { state: "risk" }),
    row("commit", "c1", "go 1", at(12, 32)), row("review", "inc1", "go 1", at(12, 39)),
    row("plan", "Take coupons", "Take coupons", at(11, 53)),
    row("commit", "yesterday", "go 1", at(16, 0, 25)),
  ];
  const cards = turns({ ...empty, rows, plans });
  ok("turns: one card per run of a prompt, a new day a new card", cards.map((c) => c.prompt).join("|") === "go 2|go 1|Take coupons|go 1", cards.map((c) => c.prompt));
  ok("turns: a card spans its rows' times", cards[0].start === Date.parse(at(13, 14)) && cards[0].end === Date.parse(at(13, 36)));
  ok("turns: named by the increment whose window holds the turn", cards[0].name === "coupons · increment 2" && cards[1].name === "coupons · increment 1" && cards[2].name === null);
  ok("turns: sections follow the shelves' order and skip empty ones", cards[0].sections.map((s) => s.shelf).join() === "pictures,files,commits" && cards[1].sections.map((s) => s.shelf).join() === "reviews,commits");
  ok("turns: a card's day is local", cards[3].day === "2026-11-25" && cards[0].day === "2026-11-26");
  const order = timelineOrder([{ key: "risk", kind: "risk", title: "", rows: [] }], cards);
  ok("timeline order: needs first, then each card's sections in order", order[0] === "risk" && order[1] === `row:${rows[1].id}` && order[2] === `row:${rows[2].id}` && order[3] === `row:${rows[0].id}`, order);
}

// ------------------------------------------------------------ keys and words
{
  const o = ["a", "b", "c"];
  ok("step: nothing selected goes to the first", stepKey(o, null, 1) === "a" && stepKey(o, null, -1) === "c");
  ok("step: forward and back", stepKey(o, "a", 1) === "b" && stepKey(o, "c", -1) === "b");
  ok("step: the ends hold", stepKey(o, "c", 1) === "c" && stepKey(o, "a", -1) === "a");
  ok("step: an empty list has nothing", stepKey([], null, 1) === null);
  ok("stage words", stageSaid(review("r", { stage: "round", round: { sealed: 0, pending: 2, max: 2, n: 1 } })) === "round 1 of 2" &&
    stageSaid(review("r", { stage: "finding", reviewer: "panel" })) === "panel · finding" &&
    stageSaid(review("r", { stage: "close", needsPerson: true })) === "you close it" &&
    stageSaid(review("r", { stage: "claims", claims: { unchecked: 3, broken: 0 } })) === "3 claims unchecked");
}

// ------------------------------------------------------------ gone last, background tasks, review names
{
  const rs = [row("temp", "a", "go", at(13, 3), { state: "gone" }), row("temp", "b", "go", at(13, 2)), row("temp", "c", "go", at(13, 1), { state: "risk" })];
  ok("atRiskFirst: at risk, then what lasts, then gone", atRiskFirst(rs).map((r) => r.title).join() === "c,b,a");
  const s2 = shelves({ ...empty, rows: [row("image", "dead.png", "go", at(13, 5), { state: "gone" }), row("image", "live.png", "go", at(13, 4))] });
  ok("shelves: a gone picture sorts after a live one", s2.pictures.map((r) => r.title).join() === "live.png,dead.png");
  const mixed = needsOf({ ...empty, rows: [row("temp", "a.log", "go", at(13, 3), { state: "risk" }), row("image", "b.png", "go", at(13, 2), { state: "risk" }), row("image", "c.png", "go", at(13, 1), { state: "risk" })] });
  ok("needs: the risk tile counts files and pictures as the shelves do", mixed[0]?.title === "1 file and 2 pictures will be lost", mixed[0]?.title);

  const note = 'ba8u2crv3 toolu_01CWm2gazdggKGnc85nzSxaL /private/tmp/claude-501/x/tasks/ba8u2crv3.output completed Background command "Run the full Rust suite" completed (exit code 0)';
  ok("backgroundTask: a notification's command description", backgroundTask(note) === "Run the full Rust suite");
  ok("backgroundTask: the person's own prompt is not one", backgroundTask("go 3") === null && backgroundTask("toolu_ is a word here") === null);
  // Oldest last: the person says "go 3", files land, a background task
  // finishes and leaves more: one card, the person's prompt, one task.
  const rows = [
    row("temp", "after-task.log", note, at(14, 20)),
    row("temp", "first.log", "go 3", at(14, 10)),
    row("commit", "c1", "go 3", at(14, 5)),
  ];
  const cards = turns({ ...empty, rows });
  ok("turns: a background task's rows join the person's prompt before it", cards.length === 1 && cards[0].prompt === "go 3", cards.map((c) => c.prompt));
  ok("turns: the card counts the background task it took in", cards[0].background.join() === "Run the full Rust suite");
  const alone = turns({ ...empty, rows: [row("temp", "x.log", note, at(9, 0), { session_id: "s9" })] });
  ok("turns: a background task with no prompt before it is its own card, with no prompt", alone.length === 1 && alone[0].prompt === "" && alone[0].background.length === 1);

  const late = turns({ ...empty, rows: [row("temp", "morning.log", note, at(8, 0, 27)), row("temp", "evening.log", "go 3", at(22, 0, 26))] });
  ok("turns: a background task the next morning takes no prompt from the day before", late.length === 2 && late[0].prompt === "" && late[1].prompt === "go 3", late.map((c) => c.prompt));
  const older = row("temp", "one.log", "go 4", at(15, 0));
  const k1 = turns({ ...empty, rows: [older] })[0].key;
  const k2 = turns({ ...empty, rows: [row("temp", "two.log", "go 4", at(15, 5)), older] })[0].key;
  ok("turns: a card keeps its key when a new row joins the turn", k1 === k2 && k1 === `turn:${older.id}`, [k1, k2]);
  ok("reviewName: plan and increment when lookout knows them", reviewName(review("x", { plan: "wake-shelves", inc: 6, title: "dev/wake-shelves vs 1c0ee2e4" })) === "wake-shelves · increment 6");
  ok("reviewName: a delivery review", reviewName(review("x", { plan: "p", inc: "all" })) === "p · delivery");
  ok("reviewName: its own title otherwise", reviewName(review("x", { title: "main vs spike" })) === "main vs spike");
  const tile = needsOf({ ...empty, reviews: [review("r", { stage: "ask", needsPerson: true, addressed: 2, plan: "p", inc: 2, round: { sealed: 2, pending: 2, max: 2, n: 2 } })] })[0];
  ok("needs: a review's tile says its stage in the Reviews shelf's words", tile?.kind === "review" && tile.why === "2 rounds done: your call" && tile.title === "p · increment 2", tile);
}

// ------------------------------------------------------------ plan cards, kept kinds
{
  const p: PlanRow = {
    slug: "p", title: "P", phase: "implementing", progress: { total: 3, done: 2 },
    checksOutstanding: [{ n: 3, id: "t", kind: "test", status: "pending" }, { n: 1, id: "old", kind: "manual", status: "pending" }],
    increments: [{ n: 1, title: "a", status: "done" }, { n: 2, title: "b", status: "done" }, { n: 3, title: "c", status: "working" }],
  };
  const st = planState(p);
  ok("planState: a mark per increment", st.dots.map((d) => d.mark).join() === "done,done,now" && st.now === 3);
  ok("planState: says the open increment and its checks to go (not another increment's)", st.said === "increment 3 of 3 · 1 check to go", st.said);
  ok("planState: a finished plan says so", planState({ ...p, progress: { total: 3, done: 3 }, increments: p.increments!.map((i) => ({ ...i, status: "done" })) }).said === "every increment done");
  ok("kept: reviews, plans, asks, pull requests and issues are never folded", ["review", "plan", "ask", "pr", "issue"].every((k) => kept({ kind: k })) && !kept({ kind: "temp" }) && !kept({ kind: "image" }));
}

console.log(`wakeshelf probe: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
