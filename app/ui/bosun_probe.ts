// node app/ui/bosun_probe.ts — the Bosun tab's model (bosun_model.ts): the
// rail's days and cards, the whistle's mood and what ⌘B does. A pure
// module, which Node runs as TypeScript.
import {
  askText, card, chips, dayBefore, dayLabel, daysToLoad, dropAct, firstLine, freshIds, fromLabel, mood, rail, recheck, reviewAsk, sourceTarget, tilde, workspaceAsk,
  type Entry, type LogPage,
} from "./bosun_model.ts";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}${extra !== undefined ? "  :: " + JSON.stringify(extra) : ""}`);
  }
}

const TZ = "UTC";
const at = (iso: string) => Date.parse(iso);
const e = (id: string, iso: string, question: string, answer: string, sources: Entry["sources"] = [], asker = ""): Entry =>
  ({ id, at: at(iso), question, answer, sources, asker });

// ---- days ----
ok("the day before crosses a month", dayBefore("2026-12-01") === "2026-11-30", dayBefore("2026-12-01"));
ok("the day before crosses a year", dayBefore("2026-01-01") === "2025-12-31");
ok("today is Today", dayLabel("2026-11-22", "2026-11-22") === "Today");
ok("the day before is Yesterday", dayLabel("2026-11-21", "2026-11-22") === "Yesterday");
ok("an older day is its weekday and date", dayLabel("2026-11-19", "2026-11-22") === "Thu 19 Nov", dayLabel("2026-11-19", "2026-11-22"));
ok("another year says its year", dayLabel("2025-12-30", "2026-01-02") === "Tue 30 Dec 2025", dayLabel("2025-12-30", "2026-01-02"));
ok("the rail loads today and the newest older days", daysToLoad("2026-11-22", ["2026-11-22", "2026-11-20", "2026-11-19", "2026-11-02", "2026-10-01"]).join() === "2026-11-22,2026-11-20,2026-11-19,2026-11-02");
ok("a day after today (a clock change) is not loaded", !daysToLoad("2026-11-22", ["2026-11-23", "2026-11-21"]).includes("2026-11-23"));

// ---- cards ----
ok("the first line skips blanks and markdown marks", firstLine("\n\n## 3 PRs open\n- #812") === "3 PRs open");
ok("a long first line is cut with an ellipsis", firstLine("x".repeat(200), 20).length === 20 && firstLine("x".repeat(200), 20).endsWith("…"));
const c = chips([
  { kind: "github", ref: "https://github.com/o/r/pull/812", label: "PR 812" },
  { kind: "jira", ref: "PROJ-311", label: "PROJ-311" },
  { kind: "gh", ref: "https://github.com/o/r/pull/815", label: "PR 815" },
]);
ok("one chip per kind, counted, in first-seen order", c.map((x) => `${x.label} ${x.n}`).join() === "gh 2,jira 1", c);
ok("an unknown kind keeps its own name", chips([{ kind: "Sentry", ref: "x", label: "" }])[0].label === "sentry");
ok("a source with no kind is a link", chips([{ kind: "", ref: "x", label: "" }])[0].label === "link");
ok("the asker reads as who it came from", fromLabel("ask:workspace checkout-api") === "from workspace checkout-api" && fromLabel("loop:daily") === "loop daily" && fromLabel("app") === "from the app" && fromLabel("") === "");
const k = card(e("a1", "2026-11-22T10:42:00Z", " What's open on checkout-api? ", "3 PRs open: #812 waits on review", [], "ask:checkout-api"), TZ);
ok("a card carries time, asker, question and first line", k.time === "10:42" && k.from === "from checkout-api" && k.question === "What's open on checkout-api?" && k.first.startsWith("3 PRs"), k);

// ---- the rail ----
const pages: LogPage[] = [
  { day: "2026-11-21", today: "2026-11-22", days: [], entries: [e("y1", "2026-11-21T17:03:00Z", "p95 on orders?", "180ms")] },
  { day: "2026-11-22", today: "2026-11-22", days: [], entries: [e("t1", "2026-11-22T09:15:00Z", "PROJ-311?", "in review"), e("t2", "2026-11-22T10:42:00Z", "PRs?", "3 open")] },
  { day: "2026-11-19", today: "2026-11-22", days: [], entries: [] },
];
const r = rail(pages, TZ);
ok("days run newest first, empty older days left out", r.map((d) => d.label).join() === "Today,Yesterday", r.map((d) => d.label));
ok("cards run newest first within a day", r[0].cards.map((x) => x.id).join() === "t2,t1");
ok("an empty today still shows, so the rail says nothing yet", rail([{ day: "2026-11-22", today: "2026-11-22", days: [], entries: [] }]).length === 1);
ok("a day loaded twice shows once", rail([...pages, pages[0]], TZ).length === 2);

// ---- the whistle ----
ok("the whistle pipes while the Bosun works", mood("working", false) === "pipe");
ok("it rests when idle or waiting on you", mood("idle", false) === "rest" && mood("needs_input", false) === "rest" && mood(undefined, false) === "rest");
ok("a new answer trills, even mid-work", mood("working", true) === "trill");
ok("the first look finds nothing fresh", freshIds(null, ["a", "b"]).length === 0);
ok("a later look finds the new ids", freshIds(new Set(["a"]), ["a", "b"]).join() === "b");

// ---- ⌘B ----
ok("⌘B on the Bosun tab focuses its terminal", dropAct("bosun", false) === "focus" && dropAct("bosun", true) === "focus");
ok("⌘B elsewhere drops the Bosun down", dropAct("dock", false) === "open");
ok("⌘B again puts it away", dropAct("review", true) === "close");

// ---- re-check and sources ----
ok("re-check queues the same question", recheck(e("x", "2026-11-22T00:00:00Z", "  is CI green?\n", "yes")) === "is CI green?");
ok("a URL source opens as a URL", JSON.stringify(sourceTarget({ kind: "gh", ref: "https://github.com/o/r/pull/8", label: "" })) === '{"url":"https://github.com/o/r/pull/8"}');
ok("a file:line source opens the file at its line", JSON.stringify(sourceTarget({ kind: "file", ref: "/u/code/r/src/a.rs:42", label: "" })) === '{"path":"/u/code/r/src/a.rs","line":42}');
ok("a file:line:col source keeps its line", JSON.stringify(sourceTarget({ kind: "file", ref: "/u/code/r/a.rs:42:7", label: "" })) === '{"path":"/u/code/r/a.rs","line":42}');
ok("a query or ticket key opens nowhere", sourceTarget({ kind: "sql", ref: "select 1", label: "" }) === null && sourceTarget({ kind: "jira", ref: "PROJ-9", label: "" }) === null);

// ---- Ask the Bosun ----
const w = workspaceAsk({
  title: "checkout-api", branch: "feat/coupons", root: "/Users/me/code/shop.worktrees/coupons",
  editing: ["api/routes.rs", "api/coupons.rs", "web/form.tsx", "web/receipt.tsx"], planned: [{ plan: "coupons", inc: 2 }, { plan: "coupons", inc: 2 }],
});
ok("a Radar ask's chip is the workspace and its branch", w.chip === "checkout-api · feat/coupons" && w.from === "Radar");
ok("its facts name the worktree with ~", w.facts.includes("worktree ~/code/shop.worktrees/coupons"), w.facts);
ok("its files are counted and the first few named", w.facts.includes("editing 4 files: routes.rs, coupons.rs, form.tsx and 1 more"), w.facts);
ok("a plan increment is named once", w.facts.filter((f) => f.startsWith("planned")).join() === "planned in coupons increment 2", w.facts);
ok("a workspace with no branch or files says only its name", workspaceAsk({ title: "x", branch: "", root: "", editing: [], planned: [] }).facts.join() === "workspace x");
const j = reviewAsk({ title: "coupons", repo: "acme/shop", branch: "feat/coupons", pr: 812, url: "https://github.com/acme/shop/pull/812", open: { blocker: 1, major: 0, minor: 2 } });
ok("a review ask's chip names its PR", j.chip === "coupons · PR #812" && j.from === "Lookout");
ok("its facts carry the PR link and the open findings", j.facts.includes("PR #812 (https://github.com/acme/shop/pull/812)") && j.facts.includes("open findings: 1 blocker, 2 minor"), j.facts);
ok("a title that names its PR is not told it twice", reviewAsk({ title: "shop · PR #41", pr: 41 }).chip === "shop · PR #41");
ok("a review with nothing open says so", reviewAsk({ title: "t", open: {} }).facts.includes("no open findings"));
ok("a PR row carries its state", reviewAsk({ title: "Fix it", pr: 9, url: "u", state: "draft" }).facts.includes("PR #9 (u), draft"));
ok("a review with no PR asks about the change", reviewAsk({ title: "t", branch: "b" }).suggest.startsWith("What's the state of this change"));
const text = askText(w, "  Is this safe to merge?  ");
ok("the queued text leads with the question", text.startsWith("Is this safe to merge?\n\nContext (asked from the app's Radar): workspace checkout-api; branch feat/coupons;"), text);
ok("the context ends in one full stop", text.endsWith("planned in coupons increment 2."), text);
ok("~ replaces only a home folder", tilde("/Users/me/code") === "~/code" && tilde("/opt/Users/me") === "/opt/Users/me");

console.log(`bosun_probe: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
