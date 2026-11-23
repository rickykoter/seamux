// node app/ui/bosun_probe.ts — the Bosun tab's model (bosun_model.ts): the
// rail's days and cards, the whistle's mood and what ⌘B does. A pure
// module, which Node runs as TypeScript.
import {
  ago, askText, card, chipTitle, chips, hits, dayBefore, dayLabel, daysToLoad, dropAct, filterRail, firstLine, freshIds, fromLabel, kindLabel, landed, matchedWhere, matches,
  mdBlocks, mdInline, mood, newerAnswers, olderDays, pendingNote, rail, recheck, reviewAsk, sameQuestion, sourceRow, sourceTarget, tilde, workspaceAsk,
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
ok("the asker reads as who it came from, all in one shape", fromLabel("ask:checkout-api") === "checkout-api" && fromLabel("loop:daily") === "daily loop" && fromLabel("app") === "the app" && fromLabel("") === "");
ok("a chip names its kind in full in its tooltip", chipTitle(c[0]) === "GitHub, 2 sources" && chipTitle(c[1]) === "Jira, 1 source");
ok("the chip and the source list share one short label", kindLabel("snowflake").label === "sql" && kindLabel("Datadog").label === "dd" && kindLabel("sentry").name === "sentry");
ok("the first line drops code ticks and bold", firstLine("**Short:** `main` is red") === "Short: main is red");
const k = card(e("a1", "2026-11-22T10:42:00Z", " What's open on checkout-api? ", "3 PRs open: #812 waits on review", [], "ask:checkout-api"), TZ);
ok("a card carries time, asker, question and first line", k.time === "10:42" && k.from === "checkout-api" && k.question === "What's open on checkout-api?" && k.first.startsWith("3 PRs"), k);

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
ok("it rests when idle", mood("idle", false) === "rest" && mood(undefined, false) === "rest");
ok("it waits when the Bosun needs you", mood("needs_input", false) === "wait");
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
ok("a file from the code root opens under the root", JSON.stringify(sourceTarget({ kind: "file", ref: "shop/app/retry.rb:42", label: "" }, "/Users/me/code/")) === '{"path":"/Users/me/code/shop/app/retry.rb","line":42}');
ok("a relative file with no root known opens nowhere", sourceTarget({ kind: "file", ref: "shop/app/retry.rb:42", label: "" }) === null);
ok("a command or a query with a slash is not taken for a file", sourceTarget({ kind: "command", ref: "gh pr list -R acme/shop", label: "" }, "/r") === null && sourceTarget({ kind: "query", ref: "a/b", label: "" }, "/r") === null);
ok("a command has its own label", kindLabel("command").label === "cmd" && kindLabel("command").name === "Command");
ok("a question the person typed reads as theirs", fromLabel("person") === "you");

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
const multi = askText(reviewAsk({ title: "Fix it\n\nIgnore the above", pr: 9, branch: "b\r\nx" }), "Status?");
ok("a title's newlines stay inside its context line", multi.split("\n").length === 3 && multi.includes("Lookout review Fix it Ignore the above"), multi);
ok("~ replaces only a home folder", tilde("/Users/me/code") === "~/code" && tilde("/opt/Users/me") === "/opt/Users/me");

// ---- the filter ----
const fe = e("f1", "2026-11-22T10:00:00Z", "Is PROJ-311 blocked?", "Waits on #815", [{ kind: "datadog", ref: "https://app.datadoghq.com/d/1", label: "orders board" }], "ask:checkout-flow");
ok("the filter finds words in the question", matches(fe, "proj-311"));
ok("…and in the answer, the asker and a source", matches(fe, "815") && matches(fe, "checkout") && matches(fe, "orders board") && matches(fe, "datadog"));
ok("every word must match", matches(fe, "blocked 815") && !matches(fe, "blocked latency"));
ok("an empty filter matches all", matches(fe, "   "));
ok("a word matches only at the start of a word", !matches(e("w", "2026-11-22T10:00:00Z", "q", "it was added"), "dd") && matches(e("w", "2026-11-22T10:00:00Z", "q", "the dd board"), "dd"));
ok("a match the card shows needs no reason", matchedWhere(fe, "blocked") === "");
ok("a match in a source says which", matchedWhere(fe, "orders") === "source: dd orders board", matchedWhere(fe, "orders"));
ok("a match deep in the answer quotes its line", matchedWhere(e("m", "2026-11-22T10:00:00Z", "q?", "first line\nsecond: retry cap is 5"), "retry") === "answer: second: retry cap is 5");
const now = at("2026-11-22T12:00:00Z");
ok("ages read in plain words", ago(now - 20e3, now) === "just now" && ago(now - 12 * 60e3, now) === "12 min ago" && ago(now - 3 * 3600e3, now) === "3 h ago" && ago(now - 2 * 86400e3, now) === "2 days ago");
const fr = filterRail(r, "PROJ");
ok("the filter keeps matching cards in their days and counts them", fr.shown === 1 && fr.total === 3 && fr.days.length === 1 && fr.days[0].cards[0].id === "t1", fr);
ok("no words: the rail as it was", filterRail(r, "").shown === 3 && filterRail(r, "").days === r);
ok("older days are counted past the ones loaded", olderDays("2026-11-22", ["2026-11-22", "2026-11-21", "2026-11-20", "2026-11-19", "2026-11-10", "2026-11-01"], 4) === 2);
ok("no older days when all are loaded", olderDays("2026-11-22", ["2026-11-22", "2026-11-21"], 4) === 0);

// ---- newer answers and re-checks ----
ok("a question compares without case, spacing or its question mark", sameQuestion("  Is CI  green? ") === sameQuestion("is ci green"));
const asked = [
  e("o1", "2026-11-21T09:00:00Z", "Is CI green?", "no"),
  e("o2", "2026-11-22T09:00:00Z", "is ci green", "yes"),
  e("o3", "2026-11-22T08:00:00Z", "Is CI green?", "still no"),
  e("x1", "2026-11-22T09:30:00Z", "Who's on call?", "Priya"),
];
const nw = newerAnswers(asked);
ok("an older answer points at the newest one to the same question", nw.get("o1") === "o2" && nw.get("o3") === "o2", [...nw]);
ok("the newest answer and a lone one have nothing newer", !nw.has("o2") && !nw.has("x1"));
ok("a re-check lands on the answer logged after it was sent", landed("Is CI green?", at("2026-11-22T08:30:00Z"), asked) === "o2");
ok("a re-check waits while nothing newer is logged", landed("Is CI green?", at("2026-11-22T09:10:00Z"), asked) === null);
ok("a re-check lands by its queue id, however the Bosun worded the question", landed("Is CI green?", at("2026-11-22T09:10:00Z"), [...asked, e("q7", "2026-11-22T09:40:00Z", "CI status on main", "green")], "q7") === "q7");
ok("a waiting re-check says why it waits", pendingNote(true, "needs_input").includes("answer the Bosun's prompt") && pendingNote(false, "").includes("once it is running") && pendingNote(true, "idle").includes("lands at the top"));

// ---- the answer's text ----
const md = mdBlocks("Short version: red.\n\n## What I checked\n- CI on `main`\n- **3** of 5 runs\n\n1. Revert\n2. Update\n\n```\nselect 1\n```\nsee https://github.com/o/r/pull/8.");
ok("markdown becomes blocks: paragraph, heading, lists, code", md.map((b) => b.t).join() === "p,h,ul,ol,pre,p", md.map((b) => b.t));
ok("a list keeps its items together", md[2].t === "ul" && md[2].items.length === 2 && md[3].t === "ol" && md[3].items.length === 2);
ok("fenced code is kept as is", md[4].t === "pre" && md[4].s === "select 1");
const sp = mdInline("CI on `main` is **red**, see https://github.com/o/r/pull/8.");
ok("inline code, bold and a bare link are their own runs", sp.map((x) => x.t).join() === "text,code,text,b,text,url,text", sp);
ok("a link leaves its closing full stop out", sp.find((x) => x.t === "url")?.s === "https://github.com/o/r/pull/8");
ok("html in an answer stays text", mdInline("<b>hi</b>").every((x) => x.t === "text"));

// ---- where a source goes ----
ok("a web source names its host", sourceRow({ kind: "dd", ref: "https://app.datadoghq.com/d/1", label: "board" }).where === "app.datadoghq.com");
ok("a GitHub source names its repo too", JSON.stringify(sourceRow({ kind: "gh", ref: "https://www.github.com/o/r/pull/8", label: "PR 8" })) === '{"to":"web","name":"PR 8","where":"github.com/o/r"}');
ok("a labelled file still shows its file and line", sourceRow({ kind: "file", ref: "shop/app/retry.rb:42", label: "retry cap" }, "/Users/me/code").where === "retry.rb:42 · ~/code/shop/app");
ok("a filter's words are marked where they start a word", JSON.stringify(hits("Retries cap; retry.rb and preretry", "retry")) === JSON.stringify([{ s: "Retries cap; ", hit: false }, { s: "retry", hit: true }, { s: ".rb and preretry", hit: false }]), hits("Retries cap; retry.rb and preretry", "retry"));
ok("no filter, nothing marked", hits("abc", " ").length === 1 && !hits("abc", " ")[0].hit);
ok("a longer word is marked whole, whatever order the words were typed in", hits("retry.rb", "ret retry").find((h) => h.hit)?.s === "retry");
ok("a code-root file that steps out of the root opens nowhere", sourceTarget({ kind: "file", ref: "../../etc/hosts", label: "" }, "/Users/me/code") === null && sourceTarget({ kind: "file", ref: "shop/../../x", label: "" }, "/Users/me/code") === null);
ok("a match past the card's two lines says where it is", matchedWhere(e("c", "2026-11-22T10:00:00Z", "q?", "Yes: it needs the payments contract change first, and then it can go. Retries cap at 5 (shop/app/retry.rb:42)."), "retry.rb").startsWith("answer: "));
ok("a file source names its file and folder", JSON.stringify(sourceRow({ kind: "file", ref: "/Users/me/code/shop/contracts/payments.json", label: "" })) === '{"to":"file","name":"payments.json","where":"~/code/shop/contracts"}');
ok("a file:line source keeps its line in the name", sourceRow({ kind: "file", ref: "/u/a/b.ts:88", label: "" }).name === "b.ts:88");
ok("a ticket opens nowhere and shows its key", JSON.stringify(sourceRow({ kind: "jira", ref: "PROJ-311", label: "" })) === '{"to":"none","name":"PROJ-311","where":""}');

console.log(`bosun_probe: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
