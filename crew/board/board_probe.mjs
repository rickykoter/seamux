#!/usr/bin/env node
// Probe the board's render path without cmux, a browser, or a Dock.
//
//   node board/board_probe.mjs
//
// The render path is the riskiest untested piece: a JS error there produces a *blank
// surface*, not an error message, and the daemon would keep pushing happily into it. So
// the script is pulled out of board.html, run against a minimal DOM stub, and asserted.
//
// The last check is the important one. `said` can carry raw terminal text captured with
// `cmux read-screen`, which means agent output reaches innerHTML. It must be escaped.

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// render.js, not an inline script in the page: the renderer is pushed with each update
// because a page-resident entry point was not reachable, and because a wrong BOARD_HTML
// path once loaded a nonexistent file and the failure was indistinguishable.
const script = readFileSync(join(HERE, "render.js"), "utf8");

const els = {};
const mk = (id) => (els[id] = {
  id, innerHTML: "", textContent: "", className: "", attrs: {},
  getAttribute(k) { return this.attrs[k] ?? null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
});
["need", "rows", "quiet", "src", "stamp", "cat", "says", "tally"].forEach(mk);

// The stub grew a query path because the reorder animation needs one. render.js
// measures each row's offsetTop BEFORE it replaces innerHTML -- that is the only
// moment the old geometry exists -- so `querySelectorAll` here parses whatever is
// currently in els.rows.innerHTML, which at call time is still the PREVIOUS
// render. That makes the stub faithful to the real sequence rather than merely
// non-throwing, and it means the enter/up/down logic is tested, not skipped.
const ANIMS = [];      // every .animate() call render.js makes, in order
const ADDED = [];      // every classList.add() it makes: [id, class]
function synthRows() {
  const html = els.rows.innerHTML;
  const out = [];
  const re = /class="row ([^"]*)"\s+data-id="([^"]+)"/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const id = m[2];
    out.push({
      // Rows are uniform-height in the stub; only the ORDER matters to a FLIP.
      offsetTop: i++ * 50,
      getAttribute: (k) => (k === "data-id" ? id : null),
      classList: { add: (c) => ADDED.push([id, c]) },
      animate: (frames, opts) => { ANIMS.push({ id, frames, opts }); return {}; },
    });
  }
  return out;
}
const sandbox = {
  document: {
    getElementById: (id) => els[id] || mk(id),
    querySelectorAll: (sel) => (/\.row\[data-id\]/.test(sel) ? synthRows() : []),
    // Not reduced: the probe must exercise the motion path, not the bypass.
    defaultView: { matchMedia: () => ({ matches: false }) },
  },
  JSON, Math,
};
sandbox.window = sandbox;
createContext(sandbox);
runInContext(script, sandbox);
const render = sandbox.__boardRender;
if (typeof render !== "function") {
  console.log("  FAIL render.js does not define __boardRender");
  process.exit(1);
}

// The fixture is ALWAYS what the structural assertions below run against.
//
// This used to try live state first and fall back to the fixture "so the probe is
// deterministic on a fresh machine" -- which inverted it. Three of the assertions are
// fixture-specific: they need an `attend` row, a {{subject}} to bold, and a non-zero dial.
// A machine WITH live state guarantees none of those, so the probe failed 3/14 against a
// single idle workspace. Determinism comes from the fixture, not from the absence of work.
const FIXTURE = {
  rows: [
    { id: "a", name: "fixture-attend", kind: "attend", badge: "gate shut",
      said: "{{Inc 2}} needs your go-ahead.", chips: ["go 2", "plan"], frac: 0.25, meta: "1/4",
      cost: 4.2, issue: "#87", issue_url: "https://github.com/x/y/issues/87" },
    { id: "b", name: "fixture-run", kind: "running", badge: "working",
      said: "{{Inc 3}} in progress.", chips: ["diff"], frac: 0.5, meta: "2/4",
      cost: 0.31 },
    { id: "c", name: "fixture-done", kind: "done", badge: "merged",
      said: "Merged.", chips: [], frac: 1, meta: "4/4" },
  ], quiet: "3 quiet", stamp: "00:00:00", src: "fixture",
};
const state = FIXTURE;
render(state);

const out = els.rows.innerHTML;
const checks = [
  ["rows rendered", out.length > 200],
  ["one .row per state row", (out.match(/class="row /g) || []).length === state.rows.length],
  ["attend carries its class", out.includes('class="row attend')],
  ["{{subject}} became <b>", out.includes("<b>") && !out.includes("{{")],
  ["SVG dial present", out.includes('<svg class="dial"')],
  ["dial shows a percentage", /<text[^>]*>\d+<\/text>/.test(out)],
  ["header counts need-you", /need(s)? you|all clear/.test(els.need.textContent)],
  ["no undefined leaked", !out.includes("undefined")],
];

// A plan with no increments must show a dot, not a lying 0%.
render({ rows: [{ id: "n", name: "no-increments", kind: "attend", badge: "review",
  said: "x", chips: [], frac: null, meta: "" }], quiet: "" });
checks.push(["null progress renders a dot, not 0%", !/<text/.test(els.rows.innerHTML)]);

// Today's-$ fact: rendered with dollars, dimmed when small, absent when the
// field is missing (the CI/no-ccusage path sends rows without it).
checks.push(["cost fact rendered with dollars", out.includes(">$4.20<")]);
checks.push(["a small cost is dimmed", /class="cost small"[^>]*>\$0\.31</.test(out)]);
// Linked-issue chip: rendered when the collector supplied it (integration
// enabled), absent otherwise — the un-enabled row must show none.
checks.push(["issue chip renders as its own target",
  /class="issue" data-a="issue"[^>]*>#87</.test(out)]);
checks.push(["rows without an issue field show no issue chip",
  (out.match(/class="issue"/g) || []).length === 1]);
checks.push(["a row without cost shows no dollar fact",
  (out.match(/class="cost/g) || []).length === 2]);

// The one that matters: agent output must not become markup.
render({ rows: [{ id: "x", name: "<img src=x onerror=1>", kind: "attend",
  badge: "b", said: "<script>alert(1)</script> {{safe}}", chips: ["<b>c</b>"],
  frac: 0.5, meta: "m" }], quiet: "" });
const esc = els.rows.innerHTML;
checks.push(["agent text escaped, not executed",
  !esc.includes("<img") && !esc.includes("<script>") && esc.includes("&lt;img")]);

// The page must have no script of its own: that dependency is what broke.
const pageHtml = readFileSync(join(HERE, "board.html"), "utf8");
checks.push(["board.html carries no <script>", !pageHtml.includes("<script")]);
checks.push(["board.html has the render targets",
  ["rows", "need", "quiet", "src", "stamp", "cat"].every((id) => pageHtml.includes('id="' + id + '"'))]);
// The cat is static art in the page, and render.js only ever sets its mood class.
// If the sprite's geometry ever migrates into the pushed script, this fails --
// which is the point: render.js is re-sent on every push and the cat never changes.
checks.push(["cat lives in the page, not in the push",
  pageHtml.includes('id="cat"') && !script.includes("<svg id=")]);

// Cross-push memory lives on the DOM, so a success ripple fires once and not every push.
render({ rows: [{ id: "r", name: "r", kind: "running", badge: "b", said: "", chips: [], frac: 0.5, meta: "" }], quiet: "" });
render({ rows: [{ id: "r", name: "r", kind: "done", badge: "b", said: "", chips: [], frac: 1, meta: "" }], quiet: "" });
const rippled = els.rows.innerHTML.includes("ripple");
render({ rows: [{ id: "r", name: "r", kind: "done", badge: "b", said: "", chips: [], frac: 1, meta: "" }], quiet: "" });
const settled = !els.rows.innerHTML.includes("ripple");
checks.push(["success ripples on transition", rippled]);
checks.push(["and not on the next push", settled]);

// --- the facts line, the signals strip, and the identity colour -----------
// These are the Swift row's click targets, restored. The branch one is the whole
// point: it opens the worktree in VS Code, and it spent a while folded into the
// grey meta string where it was neither clickable nor legible.
render({ rows: [{
  id: "f", name: "facts", kind: "wilt", badge: "ci failed", said: "",
  chips: ["diff"], frac: null, meta: "2/4 increments",
  branch: "dev/PROJ-1039-prelim-invoice-dedupe-match-process", dirty: true,
  pr: "#51852", pr_state: "open", color: "#1565C0",
  // A real row always has a workspace ref; without one it also renders .inert,
  // which is correct but not what this block is about.
  ref: "workspace:9", cwd: "/tmp/wt", slug: "",
  signals: [{ t: "✗ CI", c: "#F97066", h: "Open the failing checks", a: "checks" },
            { t: "draft", c: "#859289", h: "The PR is still a draft" },
            { t: "⊙ PROJ-1039", c: "#F5A524", h: "Jira: In Review — open PROJ-1039 in Jira",
              a: "jira", x: "PROJ-1039" },
            { t: "go 5", c: "#F5A524", h: "Authorize increment 5", a: "go", x: "5" }],
  feedby: 0, feedgate: "",
}], quiet: "" });
const f = els.rows.innerHTML;
checks.push(["the branch is a click target that opens VS Code",
  /<span class="branch" data-a="code"/.test(f)]);
checks.push(["the branch is clipped from the head, keeping the distinctive tail",
  f.includes("…") && f.includes("prelim-invoice-dedupe-match-process") &&
  !f.includes(">dev/PROJ-1039")]);
checks.push(["the whole branch survives in the tooltip",
  /title="Open this worktree in VS Code — dev\/PROJ-1039-prelim/.test(f)]);
checks.push(["the PR number is its own target", /class="pr open" data-a="pr"/.test(f)]);
checks.push(["uncommitted work is marked", f.includes('class="dirty"')]);
checks.push(["branch and PR are no longer buried in meta",
  /<div class="meta">2\/4 increments<\/div>/.test(f)]);
checks.push(["an actionable signal is a target, a status signal is not",
  /class="sig act" style="color:#F97066" data-a="checks"/.test(f) &&
  /class="sig" style="color:#859289"/.test(f)]);
checks.push(["a signal can carry an argument", /data-a="go" data-x="5"/.test(f)]);
// A linked Jira chip is just a signal wearing the ticket key: actionable,
// state-colored, carrying the key as its argument for the server to resolve.
checks.push(["a jira ticket chip is an actionable, state-colored signal",
  /data-a="jira" data-x="PROJ-1039"/.test(f) && f.includes("⊙ PROJ-1039")]);
// Where you are standing, marked but not reordered.
render({ rows: [
  { id: "h", name: "here", kind: "running", badge: "b", said: "", chips: [], frac: null,
    meta: "", branch: "", dirty: false, pr: "", pr_state: "", color: "#7D6608",
    signals: [], feedby: 0, feedgate: "", selected: true, ref: "workspace:1", cwd: "/tmp" },
  { id: "t", name: "there", kind: "running", badge: "b", said: "", chips: [], frac: null,
    meta: "", branch: "", dirty: false, pr: "", pr_state: "", color: "#1565C0",
    signals: [], feedby: 0, feedgate: "", selected: false, ref: "workspace:2", cwd: "/tmp" },
], quiet: "" });
const h = els.rows.innerHTML;
checks.push(["the current workspace's card is marked",
  /class="row running here owned" data-id="h"/.test(h) &&
  /class="row running owned" data-id="t"/.test(h)]);
checks.push(["exactly one card is marked", (h.match(/ here /g) || []).length === 1]);

checks.push(["the worktree's Peacock colour rides on the row",
  f.includes('class="row wilt owned"') && f.includes('style="--own:#1565C0"')]);

// The reply window is a CSS animation whose duration IS the time left, so it
// drains in real time instead of showing a number that goes stale between pushes.
const soon = Math.floor(Date.now() / 1000) + 42;
render({ rows: [{ id: "w", name: "w", kind: "attend", badge: "asked you", said: "",
  chips: [], frac: null, meta: "", branch: "", dirty: false, pr: "", pr_state: "",
  color: "", signals: [], feedby: soon, feedgate: "allow" }], quiet: "" });
checks.push(["the reply window drains for exactly the time remaining",
  /animation-duration:4[12]s/.test(els.rows.innerHTML)]);
render({ rows: [{ id: "w", name: "w", kind: "attend", badge: "asked you", said: "",
  chips: [], frac: null, meta: "", branch: "", dirty: false, pr: "", pr_state: "",
  color: "", signals: [], feedby: Math.floor(Date.now() / 1000) - 5, feedgate: "allow" }],
  quiet: "" });
checks.push(["a closed window shows no bar", !els.rows.innerHTML.includes("feedbar")]);

// A row with none of these must not emit empty containers.
render({ rows: [{ id: "b", name: "bare", kind: "quiet", badge: "idle", said: "",
  chips: [], frac: null, meta: "", branch: "", dirty: false, pr: "", pr_state: "",
  color: "", signals: [], feedby: 0, feedgate: "" }], quiet: "" });
checks.push(["a bare row emits no empty facts or signals blocks",
  !els.rows.innerHTML.includes('class="facts"') &&
  !els.rows.innerHTML.includes('class="sigs"')]);

// --- motion ---------------------------------------------------------------
// Whimsy's rule is that motion means something, so each of these asserts that a
// specific animation happens for a specific reason -- and, just as importantly,
// that it does NOT happen when nothing moved.
const twoRows = (order) => ({
  rows: order.map((id, i) => ({
    id, name: id, kind: id === "hot" ? "attend" : "running", badge: "b",
    said: "", chips: ["go 1"], frac: 0.5, meta: "",
  })), quiet: "",
});

ANIMS.length = 0; ADDED.length = 0;
render(twoRows(["cool", "hot"]));          // first sight of both rows
const entered = ADDED.filter(([, c]) => c === "enter").map(([id]) => id).sort();
checks.push(["a row seen for the first time animates in",
  entered.join(",") === "cool,hot" && ANIMS.length === 2]);

ANIMS.length = 0; ADDED.length = 0;
render(twoRows(["cool", "hot"]));          // identical order
checks.push(["an unchanged order animates nothing", ANIMS.length === 0 && ADDED.length === 0]);

ANIMS.length = 0; ADDED.length = 0;
render(twoRows(["hot", "cool"]));          // swapped
const up = ADDED.filter(([, c]) => c === "up").map(([id]) => id);
const down = ADDED.filter(([, c]) => c === "down").map(([id]) => id);
checks.push(["a reorder slides both rows", ANIMS.length === 2]);
checks.push(["the row that climbed is marked up, the other down",
  up.join() === "hot" && down.join() === "cool"]);
// A FLIP starts the element where it USED to be, or it just teleports.
const hotAnim = ANIMS.find((a) => a.id === "hot");
checks.push(["the climb starts from the old position, not the new one",
  /translateY\(50px\)/.test(JSON.stringify(hotAnim.frames[0])) &&
  /none/.test(JSON.stringify(hotAnim.frames[1]))]);

// The distinction the first version got wrong: a row can move on the PAGE
// without moving in the RANKING. Insert a row at the top and everything below it
// shifts down a slot in pixels while keeping its rank -- those rows should glide,
// and none of them should claim to have climbed.
ANIMS.length = 0; ADDED.length = 0;
render({ rows: ["new", "hot", "cool"].map((id) => ({
  id, name: id, kind: "running", badge: "b", said: "", chips: [], frac: 0.5, meta: "" })),
  quiet: "" });
const shifted = ADDED.filter(([, c]) => c === "up" || c === "down");
checks.push(["a row displaced by an insertion still slides",
  ANIMS.filter((a) => a.id !== "new").length === 2]);
checks.push(["...but is not credited with a climb",
  shifted.filter(([id]) => id !== "new").length === 0]);

// The cat says, in one word, what the board says in fourteen rows.
const moodFor = (kinds) => {
  render({ rows: kinds.map((k, i) => ({ id: "m" + i, name: "m", kind: k, badge: "b",
    said: "", chips: [], frac: null, meta: "" })), quiet: "" });
  // Read the ATTRIBUTE, not a .className property. #cat is an <svg>, where
  // className is a read-only SVGAnimatedString -- the stub happily accepted a
  // .className assignment that the real element silently ignored, so this probe
  // passed while the cat never once changed mood.
  return els.cat.attrs.class;
};
checks.push(["cat swats when a human is waited on", moodFor(["running", "attend"]) === "swat"]);
checks.push(["cat paces over work in progress", moodFor(["running"]) === "pace"]);
checks.push(["cat paces over a broken build too, as the sidebar's does",
  moodFor(["wilt"]) === "pace"]);
checks.push(["cat naps when the board is clear", moodFor(["quiet"]) === "nap"]);
checks.push(["and it has something to say about each", els.says.textContent === "off duty"]);

// The tally counts every tier, in the ranking's own order, and says nothing about
// the tiers that are empty.
render({ rows: [
  { id: "a", name: "a", kind: "attend", badge: "b", said: "", chips: [], frac: null, meta: "" },
  { id: "b", name: "b", kind: "wilt", badge: "b", said: "", chips: [], frac: null, meta: "" },
  { id: "c", name: "c", kind: "wilt", badge: "b", said: "", chips: [], frac: null, meta: "" },
  { id: "d", name: "d", kind: "quiet", badge: "b", said: "", chips: [], frac: null, meta: "" },
], quiet: "" });
const tal = els.tally.innerHTML;
checks.push(["the tally counts each state", /class="tl attend"><b>1<\/b> need you/.test(tal) &&
  /class="tl wilt"><b>2<\/b> broken/.test(tal) && /class="tl quiet"><b>1<\/b> quiet/.test(tal)]);
checks.push(["...omits the empty ones", !tal.includes("working") && !tal.includes("to close")]);
checks.push(["...in the ranking's order",
  tal.indexOf("need you") < tal.indexOf("broken") && tal.indexOf("broken") < tal.indexOf("quiet")]);
render({ rows: [], quiet: "" });
checks.push(["...and disappears when there is nothing", els.tally.innerHTML === ""]);
// The headline counts one tier, so it must not speak for the others.
render({ rows: [
  { id: "w", name: "w", kind: "wilt", badge: "b", said: "", chips: [], frac: null, meta: "" },
], quiet: "" });
checks.push(["the headline never says all-clear over a broken board",
  !/all clear/i.test(els.need.textContent) && /nothing needs you/i.test(els.need.textContent)]);

// The sprite is generated from crew.swift, so the two boards cannot drift apart
// silently. This is the check that notices if the sidebar's cat moves on.
checks.push(["the cat is in sync with the sidebar's",
  (() => { try { execFileSync("python3", [join(HERE, "cat_from_swift.py"), "--check"],
    { encoding: "utf8" }); return true; } catch { return false; } })()]);

// An indeterminate dial is the only one allowed to spin; one with a number is not.
render({ rows: [{ id: "p", name: "p", kind: "running", badge: "b", said: "",
  chips: [], frac: null, meta: "" }], quiet: "" });
checks.push(["a dial with no number is marked pending", els.rows.innerHTML.includes('class="dial pending"')]);
render({ rows: [{ id: "p", name: "p", kind: "running", badge: "b", said: "",
  chips: [], frac: 0.5, meta: "" }], quiet: "" });
checks.push(["a dial with a number is not", !els.rows.innerHTML.includes("pending")]);

// A stationary arc reads as a stalled spinner, so only a working row gets one.
render({ rows: [{ id: "w", name: "w", kind: "wilt", badge: "b", said: "",
  chips: [], frac: null, meta: "" }], quiet: "" });
checks.push(["a broken row gets a bare dot, not a frozen arc",
  !els.rows.innerHTML.includes('class="arc"')]);

// The empty state says it once. It used to say it twice: once in .empty and again
// in #quiet, which only became visible when quiet workspaces moved into rows.
render({ rows: [], quiet: "nothing else in flight" });
checks.push(["an empty board does not say the same thing twice",
  els.rows.innerHTML.includes("nothing else in flight") && els.quiet.textContent === ""]);

// Live state still gets exercised -- which is what the old code was reaching for -- but
// only against assertions real data can satisfy: that it renders, and that nothing leaks.
let live = null;
try {
  live = JSON.parse(execFileSync(join(HERE, "crew-board"), ["state", "--json"], { encoding: "utf8" }));
} catch { /* cmux down, or no crew-board: not a probe failure */ }
if (live && Array.isArray(live.rows)) {
  render(live);
  const lout = els.rows.innerHTML;
  checks.push([`live state renders (${live.rows.length} row(s))`,
    live.rows.length ? (lout.match(/class="row /g) || []).length === live.rows.length
                     : lout.includes("empty")]);
  checks.push(["live state leaks no undefined", !lout.includes("undefined")]);
  // The 15s board tick is affordable only because a fast build skips the
  // per-workspace sidebar-state call and reads branch/PR/live-turn from a cache
  // (2104ms -> 136ms measured). That is a correctness risk, not just a speed
  // trick: if the cache and the full read disagree, the board quietly shows the
  // wrong branch. So the two are compared on every probe run.
  try {
    const fast = JSON.parse(execFileSync(join(HERE, "crew-board"),
      ["state", "--fast", "--json"], { encoding: "utf8" }));
    const key = (d) => JSON.stringify((d.rows || []).map((r) =>
      [r.id, r.kind, r.branch, r.pr, r.pr_url, r.meta, r.chips]));
    checks.push(["a fast build agrees with a full build", key(fast) === key(live)]);
    // Commits reach the news from the full pass's cache, so the two must tell
    // the same story too.
    checks.push(["a fast build carries the same news as a full build",
      JSON.stringify(fast.news) === JSON.stringify(live.news)]);
  } catch {
    console.log("  --   fast build unavailable — skipped");
  }
} else {
  console.log("  --   live state unavailable (cmux down?) — fixture checks only");
}

// ---- costs.py attribution: pure, fixture-driven, no ccusage needed --------
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "costs-probe-"));
  const fixture = join(tmp, "fx.json");
  // Two real-shaped cwds that collide after munging: dots and slashes both
  // become dashes. First claim wins; the point is a stable, non-crashing pick.
  const A = "/code/app.worktrees/x", B = "/code/app-worktrees/x", C = "/code/other";
  fs.writeFileSync(fixture, JSON.stringify({
    today: "2026-09-13",
    projects: {
      "-code-app-worktrees-x": [
        { date: "2026-09-13", totalCost: 1.5 }, { date: "2026-09-12", totalCost: 2.0 }],
      "-code-other": [{ date: "2026-09-12", totalCost: 0.25 }],
      "-code-unknown": [{ date: "2026-09-13", totalCost: 99 }],
    },
  }));
  const runAttr = (...cwds) => JSON.parse(execFileSync("python3",
    [join(HERE, "costs.py"), "--attribute", fixture, ...cwds], { encoding: "utf8" }));
  const r1 = runAttr(A, B, C);
  checks.push(["costs: today/week split by date", r1[A]?.today === 1.5 && r1[A]?.week === 3.5]);
  checks.push(["costs: munge collision resolves to the first claim, once",
    r1[A] !== undefined && r1[B] === undefined]);
  checks.push(["costs: a dir matching no known cwd is dropped, not guessed",
    !JSON.stringify(r1).includes("99")]);
  checks.push(["costs: week-only workspace has a zero today", r1[C]?.today === 0 && r1[C]?.week === 0.25]);
  // The CI path: no ccusage on PATH -> {} and exit 0, never a traceback.
  const r2 = execFileSync("python3", [join(HERE, "costs.py"), A],
    { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin", CREW_COSTS_TTL: "0",
      HOME: tmp } });
  checks.push(["costs: missing ccusage degrades to {}", r2.trim() === "{}"]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- judgments.py: turn-end TypeSafe policy, pure, no network -------------
// The policy the board actually applies: stuck>=threshold flags wilt, urgency
// is the within-tier sort key, and anything missing or stale answers exactly
// like a machine that never heard of TypeSafe (false / 0).
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "judg-probe-"));
  const NOW = 1_800_000_000;
  const fixture = join(tmp, "fx.json");
  fs.writeFileSync(fixture, JSON.stringify({
    now: NOW, threshold: 0.8,
    workspaces: [
      { cwd: "/w/stuck", running: false },
      { cwd: "/w/typing", running: true },     // same judgment, but mid-turn
      { cwd: "/w/old", running: false },
      { cwd: "/w/mild", running: false },
      { cwd: "/w/unjudged", running: false },
    ],
    cache: {
      "/w/stuck":  { at: NOW - 60,     stuck: 0.93, urgency: 2.8 },
      "/w/typing": { at: NOW - 60,     stuck: 0.93, urgency: 2.8 },
      "/w/old":    { at: NOW - 100000, stuck: 0.99, urgency: 3.0 }, // > TTL
      "/w/mild":   { at: NOW - 60,     stuck: 0.42, urgency: 1.2 },
    },
  }));
  const env = { ...process.env, CREW_JUDGMENTS_FILE: join(tmp, "j.json") };
  const r = JSON.parse(execFileSync("python3",
    [join(HERE, "judgments.py"), "--apply", fixture], { encoding: "utf8", env }));
  checks.push(["judgments: fresh + over threshold reads stuck",
    r["/w/stuck"]?.stuck === true && r["/w/stuck"]?.urgency === 2.8]);
  checks.push(["judgments: a mid-turn row is never stuck — the turn it judged is over",
    r["/w/typing"]?.stuck === false]);
  checks.push(["judgments: past TTL answers like no judgment at all",
    r["/w/old"]?.stuck === false && r["/w/old"]?.urgency === 0]);
  checks.push(["judgments: under threshold stays un-flagged but keeps its order key",
    r["/w/mild"]?.stuck === false && r["/w/mild"]?.urgency === 1.2]);
  checks.push(["judgments: no cache entry means false/0, not an error",
    r["/w/unjudged"]?.stuck === false && r["/w/unjudged"]?.urgency === 0]);

  // The writer half: --record merges one cwd without blanking the others and
  // folds the blocked arg in beside the stdin values.
  execFileSync("python3", [join(HERE, "judgments.py"), "--record", "/w/a", "111", "0.9"],
    { encoding: "utf8", env, input: JSON.stringify({ stuck: 0.7, urgency: 2.0 }) });
  execFileSync("python3", [join(HERE, "judgments.py"), "--record", "/w/b", "222"],
    { encoding: "utf8", env, input: JSON.stringify({ stuck: 0.1, urgency: 0.5 }) });
  const cache = JSON.parse(fs.readFileSync(join(tmp, "j.json"), "utf8"));
  checks.push(["judgments: record keeps other worktrees' entries",
    cache["/w/a"]?.stuck === 0.7 && cache["/w/b"]?.urgency === 0.5]);
  checks.push(["judgments: blocked rides as an arg, size as an int",
    cache["/w/a"]?.blocked === 0.9 && cache["/w/a"]?.transcript_size === 111]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- crew-overlay: the machine-local config merge -------------------------
// The overlay is how a real install keeps its company-shaped answers out of the
// public repo. Two properties are load-bearing and both fail silently if broken:
// a machine WITHOUT an overlay must get byte-identical output, and a BROKEN
// overlay must refuse rather than ship an unmerged config.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const OV = join(HERE, "..", "bin", "crew-overlay");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "overlay-probe-"));
  // Returns null instead of throwing: a crew-overlay that dies should fail the
  // assertion that cares, not abort the probe and hide every check after it.
  const run = (tmplText, ovText) => {
    const ov = join(tmp, "ov.json");
    fs.writeFileSync(ov, ovText);
    try {
      return execFileSync("python3", [OV, ov],
        { encoding: "utf8", input: tmplText, stdio: ["pipe", "pipe", "pipe"] });
    } catch { return null; }
  };
  const runJson = (tmplText, ovText) => {
    const out = run(tmplText, ovText);
    try { return out === null ? null : JSON.parse(out); } catch { return null; }
  };

  // Comments, and a "https://" inside a string value: every regex-based comment
  // stripper that looked right also ate the // in the URL.
  const tmpl = `{
  // a leading comment
  "a": 1,
  "url": "https://example.com/x", // trailing comment
  "nest": { "keep": true, "over": "base" },
  "list": [1, 2],
  "controls": [ { "id": "one", "h": 1 }, { "id": "two", "h": 2 } ]
}`;
  const merged = runJson(tmpl, JSON.stringify({
    nest: { over: "winner" },
    list: [9],
    controls: [{ id: "two", h: 22 }, { id: "three", h: 3 }],
  })) ?? {};
  checks.push(["overlay: a // inside a string value survives comment stripping",
    merged.url === "https://example.com/x"]);
  checks.push(["overlay: untouched keys survive", merged.a === 1 && merged.nest?.keep === true]);
  checks.push(["overlay: scalars replace", merged.nest?.over === "winner"]);
  checks.push(["overlay: plain lists replace wholesale",
    Array.isArray(merged.list) && merged.list.length === 1 && merged.list[0] === 9]);
  checks.push(["overlay: controls merge by id, order kept, extras appended",
    (merged.controls ?? []).map(c => c.id).join(",") === "one,two,three"]);
  checks.push(["overlay: an amended control keeps its other fields and takes the new one",
    merged.controls?.[1]?.h === 22 && merged.controls?.[0]?.h === 1]);

  // A broken overlay must produce nothing on stdout and a non-zero exit, and
  // must name the file. Shipping a half-merged config would be worse than
  // failing, because it looks like the overlay was simply ignored.
  let refused = false, named = false, wrote = "x";
  try {
    const ov = join(tmp, "broken.json");
    fs.writeFileSync(ov, "{ not json");
    wrote = execFileSync("python3", [OV, ov, "/my/real/path.json"],
      { encoding: "utf8", input: tmpl, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    refused = e.status !== 0;
    wrote = e.stdout ?? "";
    named = /\/my\/real\/path\.json/.test(String(e.stderr ?? ""));
  }
  checks.push(["overlay: invalid JSON refuses and writes nothing", refused && wrote === ""]);
  checks.push(["overlay: the error names the real overlay path, not /dev/fd/N", named]);

  // The three real templates must still parse after stripping, or `crew apply`
  // would fail on a machine that has an overlay.
  for (const f of ["cmux.jsonc", "dock.json", "dock.global.json"]) {
    const text = fs.readFileSync(join(HERE, "..", "config", f), "utf8")
      .replaceAll("__HOME__", "/h").replaceAll("__INTENT_PORT__", "7345");
    checks.push([`overlay: config/${f} survives the merge path`,
      runJson(text, "{}") !== null]);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- deep-plan families: grouped, ordered by the most urgent member --------
{
  const R = (id, kind, extra = {}) => ({ id, name: id, kind, badge: "b", said: "", chips: [], frac: null, meta: "", ...extra });
  const grouped = (rows, quiet) => JSON.parse(execFileSync("python3", [join(HERE, "families.py")],
    { encoding: "utf8", input: JSON.stringify({ rows, quiet }) }));
  const plain = { rows: [R("a", "attend"), R("r", "running")], quiet: [R("q", "quiet")] };
  const same = grouped(plain.rows, plain.quiet);
  checks.push(["families: a board with no family comes back unchanged",
    JSON.stringify(same) === JSON.stringify(plain)]);
  const g = grouped([
    R("a1", "attend"),
    R("k2", "attend", { family: "F", famrole: "child", urgency: 1 }),
    R("r1", "running"),
    R("p", "done", { family: "F", famrole: "parent" }),
  ], [
    R("q1", "quiet"),
    R("k3", "quiet", { family: "F", famrole: "child" }),
    R("g1", "quiet", { family: "G", famrole: "child" }),
    R("g2", "quiet", { family: "G", famrole: "child" }),
  ]);
  const ids = g.rows.map(r => r.id);
  const fi = ids.indexOf("p");
  checks.push(["families: members sit together, the parent first",
    fi >= 0 && ids.slice(fi, fi + 3).join() === "p,k2,k3"]);
  checks.push(["families: the family sorts at its most urgent member's tier",
    fi < ids.indexOf("r1") && g.rows.find(r => r.id === "p").famtier === "attend"]);
  checks.push(["families: a quiet member is pulled up into its family",
    ids.includes("k3") && !g.quiet.some(r => r.id === "k3")]);
  checks.push(["families: children are marked to indent; the parent is not",
    g.rows.find(r => r.id === "k2").famkid === true && g.rows.find(r => r.id === "p").famkid === false]);
  checks.push(["families: an all-quiet family stays quiet, grouped, under its label",
    g.quiet.map(r => r.id).join() === "q1,g1,g2" && g.quiet[1].famlabel === "G" && !g.quiet[2].famlabel]);
  checks.push(["families: other rows keep their order", ids.indexOf("a1") < ids.indexOf("r1")]);

  // crew-board itself, on the path that needs no cmux: plan rows carry the
  // family and come back grouped.
  const po = JSON.parse(execFileSync("python3", ["-c", `
import importlib.machinery, importlib.util, json, sys
l = importlib.machinery.SourceFileLoader("cb", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("cb", l)); l.exec_module(m)
P = lambda s, ph, allow, fam=None: {"slug": s, "root": "/w/" + s, "phase": ph, "gate": {"allow": allow, "why": ""},
  "progress": {"total": 2, "done": 0, "blocked": [], "open": [], "next": {"n": 1, "title": "t"}}, **({"family": fam} if fam else {})}
pb = {"/w/x": P("x", "implementing", True), "/w/par": P("par", "implementing", True, {"parent": "par", "role": "parent"}),
  "/w/kid": P("kid", "review", False, {"parent": "par", "role": "child"})}
print(json.dumps([[r["id"], r["kind"], r.get("famtier", "")] for r in m.rank_plans_only(pb)]))
`, join(HERE, "crew-board")], { encoding: "utf8" }));
  checks.push(["families: crew-board with cmux down groups plan rows at the family's tier",
    JSON.stringify(po) === JSON.stringify([["par", "running", "attend"], ["kid", "attend", "attend"], ["x", "running", ""]])]);

  render({ rows: [...g.rows, ...g.quiet], quietCount: g.quiet.length, quiet: "" });
  const html = els.rows.innerHTML;
  checks.push(["families: render indents children and leaves the parent flush",
    /class="row attend[^"]* fam kid"[^>]*data-id="k2"/.test(html) && /class="row done[^"]* fam"[^>]*data-id="p"/.test(html)]);
  checks.push(["families: the quiet divider counts only rows below it",
    /<div class="sect">quiet · 3<\/div>/.test(html) && html.indexOf('class="sect"') > html.indexOf('data-id="k3"')]);
  checks.push(["families: a family with no parent row is headed by its name",
    /<div class="famhd">family · G<\/div><div class="row quiet[^"]* fam kid"[^>]*data-id="g1"/.test(html)]);
}

// ---- crew-color: a family's shades, and the colors from before ------------
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "crew-color-fam-"));
  const env = { ...process.env, XDG_CACHE_HOME: join(tmp, "cache"), CREW_CMUX: "/usr/bin/false" };
  const [P, A, B] = ["p", "a", "b"].map(n => { const d = join(tmp, n); fs.mkdirSync(d); return d; });
  const cc = (...a) => execFileSync("python3", [join(HERE, "..", "bin", "crew-color"), ...a], { encoding: "utf8", env });
  // Not trim(): a member restored to no color ends its line in a bare tab.
  const lines = out => Object.fromEntries(out.split("\n").filter(Boolean).map(l => l.split("\t")));
  cc("assign", A);
  const before = cc("peek", A).trim();
  const fam = lines(cc("family", P, A, B));
  checks.push(["crew-color: a family's children take shades, distinct from the parent and each other",
    /^#[0-9A-F]{6}$/.test(fam[A]) && /^#[0-9A-F]{6}$/.test(fam[B]) &&
    new Set([fam[P], fam[A], fam[B]]).size === 3 && fam[A] !== before]);
  checks.push(["crew-color: forming a family again changes nothing",
    JSON.stringify(lines(cc("family", P, A, B))) === JSON.stringify(fam)]);
  const back = lines(cc("unfamily", "--stale"));
  checks.push(["crew-color: a closed family gives each member its color from before",
    back[A] === before && back[B] === "" && cc("peek", A).trim() === before && cc("peek", B).trim() === ""]);
  checks.push(["crew-color: --stale spares a family still named",
    (cc("family", P, A, B), cc("unfamily", "--stale", P).trim() === "")]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- news: the board's rows as sentences, in the board's own order ----------
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "board-news-"));
  const NOW = 1_800_000_000;
  const R = (id, kind, badge, extra = {}) => ({ id, name: id, kind, badge, said: "", chips: [], frac: null, meta: "", ...extra });
  const compose = (rows, hours = 5) => {
    const f = join(tmp, "fx.json");
    fs.writeFileSync(f, JSON.stringify({ rows, now: NOW, hours }));
    return JSON.parse(execFileSync("python3", [join(HERE, "news.py"), "--compose", f], { encoding: "utf8" }));
  };
  const n = compose([
    R("gate", "attend", "gate shut", { subject: "Wire the cache" }),
    R("red", "wilt", "ci failed", { branch: "dev/red" }),
    R("chk", "wilt", "check failed", { subject: "increment 3 · test-probe" }),
    R("busy", "running", "working", { subject: "Footer", meta: "2/5 increments",
      commits: [{ at: NOW - 600, s: "newest" }, { at: NOW - 3600, s: "older" }, { at: NOW - 6 * 3600, s: "outside" }] }),
    R("par", "running", "working", { family: "F", famrole: "parent", famtier: "attend" }),
    R("kid", "attend", "review", { family: "F", famrole: "child", famtier: "attend", meta: "0/8 increments" }),
    R("kid2", "quiet", "plan idle", { family: "F", famrole: "child", famtier: "attend" }),
    R("q1", "quiet", "idle", { commits: [{ at: NOW - 60, s: "tidy {{x}} `y`" }] }),
    R("q2", "quiet", "idle"),
    R("q3", "quiet", "idle", { commits: [{ at: NOW - 9 * 3600, s: "old" }] }),
  ]);
  const ids = n.items.map(i => i.id);
  checks.push(["news: items follow the board's order, attend before wilt before running",
    ids.join() === "gate,red,chk,busy,family:F,q1,quiet"]);
  checks.push(["news: the lede is the first item",
    n.lede === n.items[0].text && n.lede.includes("{{gate}}") && n.lede.includes("Wire the cache")]);
  checks.push(["news: a family is one item at its lead tier, members joined",
    n.items[4].tier === "attend" && n.items[4].family === "F" &&
    /Family \{\{F\}\}: \{\{par\}\} is working; \{\{kid\}\} needs its alignment check taken; 8 increments are locked behind it; 1 more is quiet\./.test(n.items[4].text)]);
  checks.push(["news: commits inside the window are counted, newest named",
    /2 commits in the last 5h, latest “newest”/.test(n.items[3].text) && n.items[3].text.includes("(2/5 increments)")]);
  checks.push(["news: a quiet row speaks only when it committed in the window",
    n.items[5].text.startsWith("{{q1}} is quiet, with 1 commit") && !ids.includes("q2") && !ids.includes("q3")]);
  checks.push(["news: quiet rows without commits collapse to one count",
    n.items[6].text === "2 other workspaces are quiet."]);
  checks.push(["news: a commit subject cannot open bold or code",
    !/tidy \{\{|`y`/.test(n.items[5].text) && n.items[5].text.includes("tidy x y")]);
  checks.push(["news: red CI names the branch, a failed check names it",
    n.items[1].text === "{{red}} is red on CI on `dev/red`." && n.items[2].text.includes("(increment 3 · test-probe)")]);
  const empty = compose([]);
  checks.push(["news: no rows give no items and an empty lede",
    empty.items.length === 0 && empty.lede === "" && empty.hours === 5]);
  checks.push(["news: a narrower window drops older commits",
    /1 commit in the last 0.5h/.test(compose([R("b", "running", "working",
      { commits: [{ at: NOW - 600, s: "a" }, { at: NOW - 3600, s: "b" }] })], 0.5).items[0].text)]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- failed validation ranks wilt, on both rank paths ----------------------
{
  const out = JSON.parse(execFileSync("python3", ["-c", `
import importlib.machinery, importlib.util, json, sys
l = importlib.machinery.SourceFileLoader("cb", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("cb", l)); l.exec_module(m)
P = lambda s, ph, chk: {"slug": s, "root": "/w/" + s, "phase": ph, "gate": {"allow": True, "why": ""},
  "progress": {"total": 3, "done": 1, "blocked": [], "open": [{"n": 2, "title": "t"}], "next": None},
  "checksOutstanding": chk}
pb = {"/w/f": P("f", "implementing", [{"n": 2, "id": "test-a", "kind": "test", "status": "fail"}]),
      "/w/l": P("l", "implementing", [{"n": 2, "id": "e2e-b", "kind": "e2e", "status": "lost"}]),
      "/w/p": P("p", "implementing", [{"n": 2, "id": "test-c", "kind": "test", "status": "pending"}]),
      "/w/d": P("d", "done", [{"n": 3, "id": "test-d", "kind": "test", "status": "fail"}])}
W = lambda s, running: {"id": s, "title": s, "cwd": "/w/" + s, "desc": "", "running": running,
  "branch": "none", "pr": "none", "dirty": False, "commits": [{"at": 1, "s": "x"}]}
rows, quiet = m.rank([W("f", True), W("l", False), W("p", True), W("d", False)], pb)
po = m.rank_plans_only(pb)
print(json.dumps({"rank": {r["id"]: [r["kind"], r["badge"], r.get("subject", "")] for r in rows + quiet},
                  "plans": {r["id"]: [r["kind"], r["badge"]] for r in po},
                  "commits": [r["commits"] for r in rows + quiet if r["id"] == "f"][0]}))
`, join(HERE, "crew-board")], { encoding: "utf8" }));
  checks.push(["checks: a failed check ranks wilt even mid-turn, naming it",
    JSON.stringify(out.rank.f) === JSON.stringify(["wilt", "check failed", "increment 2 · test-a"])]);
  checks.push(["checks: a lost runner ranks wilt too", out.rank.l[0] === "wilt" && out.rank.l[1] === "check failed"]);
  checks.push(["checks: a pending check leaves the row working", out.rank.p[1] === "working"]);
  checks.push(["checks: a done plan never climbs back to wilt", out.rank.d[0] === "done"]);
  checks.push(["checks: the plans-only path agrees",
    out.plans.f[1] === "check failed" && out.plans.l[1] === "check failed" && out.plans.p[1] === "working" && out.plans.d[0] === "done"]);
  checks.push(["rank: a row carries its workspace's commits for the news", out.commits.length === 1 && out.commits[0].s === "x"]);
}

// ---- the news footer: escaped, keeps its open state, hides when empty ------
{
  const NEWS = { hours: 5, lede: "{{gate}} needs your go-ahead on <img src=x onerror=1>.",
    items: [{ id: "gate", tier: "attend", family: "", text: "{{gate}} needs your go-ahead on <img src=x onerror=1>." },
            { id: "red", tier: "wilt", family: "", text: "{{red}} is red on CI on `dev/red`." },
            { id: "x", tier: "\"><script>", family: "", text: "odd tier" }] };
  els.news = mk("news");
  els.news.setAttribute("open", "");
  render({ rows: [{ id: "gate", name: "gate", kind: "attend", badge: "gate shut", said: "", chips: [], frac: null, meta: "" }],
    quiet: "", news: NEWS });
  const body = els["news-body"].innerHTML, lede = els["news-lede"].innerHTML;
  checks.push(["news: footer shows when there is news", els.news.hidden === false]);
  checks.push(["news: the window is in the title", els["news-ttl"].textContent === "news · 5h"]);
  checks.push(["news: one paragraph per item, coloured by tier",
    (body.match(/<p class="ni /g) || []).length === 3 && body.includes('class="ni attend"') && body.includes('class="ni wilt"')]);
  checks.push(["news: text is escaped, affordances kept",
    !body.includes("<img") && !lede.includes("<img") && lede.includes("<b>gate</b>") && body.includes("<code>dev/red</code>")]);
  checks.push(["news: an unknown tier cannot reach the class attribute",
    body.includes('class="ni quiet"') && !body.includes("<script")]);
  render({ rows: [], quiet: "", news: NEWS });
  checks.push(["news: the <details> keeps its open state across a push", els.news.getAttribute("open") === ""]);
  render({ rows: [], quiet: "", news: { hours: 5, lede: "", items: [] } });
  checks.push(["news: no items hides the footer", els.news.hidden === true]);
  render({ rows: [], quiet: "" });
  checks.push(["news: a push without news (an old collector) hides it too", els.news.hidden === true]);
  checks.push(["board.html has the news targets inside a <details>",
    /<details id="news"[^>]*>[\s\S]*id="news-ttl"[\s\S]*id="news-lede"[\s\S]*id="news-body"[\s\S]*<\/details>/.test(pageHtml)]);
}

// ---------------------------------------------------------------------------
// The intent server's review routes, against the real server booted under a
// temp HOME (its PLANS and token files resolve from HOME at import), on a
// port of its own so a running board is never touched.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const net = await import("node:net");
  const http = await import("node:http");
  const { spawn } = await import("node:child_process");
  const HOME = fs.mkdtempSync(join(os.tmpdir(), "board-probe-intent-"));
  const reviews = join(HOME, ".claude", "plans", "reviews");
  fs.mkdirSync(reviews, { recursive: true });
  const review = {
    id: "demo", title: "demo", updatedAt: "2026-01-01T00:00:00.000Z",
    files: [{ path: "a.js" }],
    findings: [{ id: "f1", file: "a.js", line: 2, severity: "major", status: "open", thread: [] }],
    threads: [],
  };
  fs.writeFileSync(join(reviews, "demo.json"), JSON.stringify(review));
  fs.writeFileSync(join(reviews, "demo.html"), "<!doctype html><html><body><p>page</p></body></html>");
  // A review with the ownership quiz on: two notes with questions, answered
  // through op answer and graded against the stored answer.
  const q = (prompt, answer) => ({ prompt, options: ["one", "two", "three"], answer, why: "because" });
  fs.writeFileSync(join(reviews, "quiz.json"), JSON.stringify({
    id: "quiz", title: "quiz", updatedAt: "2026-01-01T00:00:00.000Z", policy: { quiz: true },
    files: [{ path: "a.js" }], findings: [], threads: [],
    notes: [{ id: "n1", files: ["a.js"], quiz: q("first?", 1) }, { id: "n2", files: ["a.js"], quiz: q("second?", 2) },
            { id: "n3", files: ["a.js"] }],
  }));
  const pinned = await new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const srv = spawn("python3", [join(HERE, "crew-board-intent")],
    { env: { ...process.env, HOME, CREW_INTENT_PORT: String(pinned) }, stdio: "ignore" });
  const tokenFile = join(HOME, ".cache", "cmux-crew", "board-intent.token");
  const portFile = join(HOME, ".cache", "cmux-crew", "board-intent.port");
  // Up when it answers, on the port it wrote: the pin is a preference the
  // server may fall back from, and a cold python on a CI runner can take
  // seconds to start. Never a fixed sleep.
  let port = 0;
  const ping = p => new Promise(res => {
    const r = http.request({ host: "127.0.0.1", port: p, method: "GET", path: "/review/demo" }, resp => { resp.resume(); res(true); });
    r.on("error", () => res(false));
    r.setTimeout(1000, () => { r.destroy(); res(false); });
    r.end();
  });
  for (const deadline = Date.now() + 20000; Date.now() < deadline; await new Promise(r => setTimeout(r, 100))) {
    const p = fs.existsSync(portFile) ? parseInt(fs.readFileSync(portFile, "utf8"), 10) : 0;
    if (p && fs.existsSync(tokenFile) && await ping(p)) { port = p; break; }
  }
  const token = port && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const ORIGIN = `http://127.0.0.1:${port}`;
  const req = (method, path, { headers = {}, body = null } = {}) => new Promise(res => {
    const r = http.request({ host: "127.0.0.1", port, method, path, headers }, resp => {
      let d = ""; resp.on("data", c => (d += c)); resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, body: d }));
    });
    r.on("error", e => res({ status: 0, headers: {}, body: String(e) }));
    if (body != null) r.write(body);
    r.end();
  });
  const post = (obj, { origin = ORIGIN, type = "application/json", path = "/review/demo", raw = null } = {}) => {
    const body = raw ?? JSON.stringify(obj);
    const headers = { "Content-Type": type, "Content-Length": Buffer.byteLength(body) };
    if (origin) headers.Origin = origin;
    return req("POST", path, { headers, body });
  };
  const store = () => JSON.parse(fs.readFileSync(join(reviews, "demo.json"), "utf8"));
  try {
    checks.push(["review route: the server came up under the temp HOME", !!token]);
    if (!token) throw new Error("the intent server never answered; the review route checks are skipped");
    const page = await req("GET", "/review/demo");
    checks.push(["review route: the page is served with its token script before </body>",
      page.status === 200 && page.body.includes(`window.lookout.serve({ token: "${token}", id: "demo" })`) &&
      page.body.indexOf("window.lookout.serve") < page.body.indexOf("</body>")]);
    const noTok = await req("GET", "/review/demo.json");
    const withTok = await req("GET", `/review/demo.json?t=${encodeURIComponent(token)}`);
    checks.push(["review route: the record needs the token, and opens to no other origin",
      noTok.status === 403 && withTok.status === 200 && JSON.parse(withTok.body).id === "demo" &&
      !("access-control-allow-origin" in withTok.headers)]);
    checks.push(["review route: an id that is not a slug is not a file",
      (await req("GET", "/review/..%2Fdemo")).status === 404 && (await req("GET", "/review/nope")).status === 404]);

    const ok = { op: "comment", t: token, file: "a.js", line: 1, side: "new", text: "why?" };
    checks.push(["review POST: no Origin is refused", (await post(ok, { origin: "" })).status === 403]);
    checks.push(["review POST: another origin is refused", (await post(ok, { origin: "https://evil.example" })).status === 403]);
    checks.push(["review POST: only JSON", (await post(ok, { type: "text/plain" })).status === 415]);
    checks.push(["review POST: over 64KB is refused", (await post({ ...ok, text: "x".repeat(70 * 1024) })).status === 413]);
    checks.push(["review POST: a wrong token is refused", (await post({ ...ok, t: "nope" })).status === 403]);
    checks.push(["review POST: an unknown op is refused", (await post({ ...ok, op: "delete" })).status === 400]);
    checks.push(["review POST: an unknown review is 404", (await post(ok, { path: "/review/nope" })).status === 404]);
    checks.push(["review POST: a file outside the review is refused", (await post({ ...ok, file: "zzz.js" })).status === 400]);
    checks.push(["review store untouched by every refusal", store().threads.length === 0 && store().updatedAt === review.updatedAt]);

    const c = await post(ok);
    const s1 = store();
    checks.push(["review POST comment: a new thread, written as the human",
      c.status === 200 && JSON.parse(c.body).item === "t1" && s1.threads[0].messages[0].by === "human" &&
      s1.threads[0].messages[0].text === "why?" && s1.updatedAt !== review.updatedAt]);
    await post({ op: "comment", t: token, item: "f1", text: "is this real?" });
    await post({ op: "resolve", t: token, item: "f1", text: "fixed, thanks" });
    const s2 = store();
    const f1 = s2.findings[0];
    checks.push(["review POST: a reply and a resolve on a finding, both the human's",
      f1.thread.length === 2 && f1.thread[0].text === "is this real?" && f1.status === "resolved" &&
      f1.statusBy === "human" && f1.thread[1].kind === "status" && f1.thread[1].to === "resolved"]);
    await post({ op: "reopen", t: token, item: "f1" });
    await post({ op: "dismiss", t: token, item: "t1" });
    const s3 = store();
    checks.push(["review POST: reopen; and a comment thread is resolved, never dismissed",
      s3.findings[0].status === "open" && s3.threads[0].status === "resolved"]);
    checks.push(["review POST: writes are atomic (no temp files left)",
      !fs.readdirSync(reviews).some(n => n.includes(".tmp-") || n.endsWith(".lock"))]);
    // The quiz's answer op: refused without a quiz, a question or a usable
    // pick; graded and recorded once, as the human's.
    const qstore = () => JSON.parse(fs.readFileSync(join(reviews, "quiz.json"), "utf8"));
    const ans = (o, path = "/review/quiz") => post({ op: "answer", t: token, ...o }, { path });
    checks.push(["review POST answer: a review without the quiz refuses it",
      (await ans({ item: "f1", pick: 0 }, "/review/demo")).status === 400]);
    checks.push(["review POST answer: a note without a question, or no such note, is 404",
      (await ans({ item: "n3", pick: 0 })).status === 404 && (await ans({ item: "n9", pick: 0 })).status === 404]);
    checks.push(["review POST answer: the pick is an index as written (not a bool, a string, or off the end)",
      (await ans({ item: "n1", pick: true })).status === 400 && (await ans({ item: "n1", pick: "1" })).status === 400 &&
      (await ans({ item: "n1", pick: 3 })).status === 400 && (await ans({ item: "n1", pick: -1 })).status === 400 &&
      !qstore().notes[0].quiz.answered]);
    const wrong = await ans({ item: "n1", pick: 2 });
    const a1 = qstore().notes[0].quiz.answered;
    checks.push(["review POST answer: a wrong pick is graded and recorded as the human's",
      wrong.status === 200 && a1 && a1.pick === 2 && a1.correct === false && a1.by === "human" && !!a1.at &&
      JSON.parse(wrong.body).review.notes[0].quiz.answered.pick === 2]);
    const again = await ans({ item: "n1", pick: 1 });
    checks.push(["review POST answer: recorded once (a second answer is refused, the first kept)",
      again.status === 409 && qstore().notes[0].quiz.answered.pick === 2]);
    checks.push(["review POST answer: a right pick is graded right",
      (await ans({ item: "n2", pick: 2 })).status === 200 && qstore().notes[1].quiz.answered.correct === true]);
    // A lock left by a crashed writer is broken once stale.
    const lock = join(reviews, "demo.lock");
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    checks.push(["review POST: a stale lock is broken, not waited on",
      (await post({ op: "comment", t: token, item: "t1", text: "after a crash" })).status === 200 && !fs.existsSync(lock)]);
  } catch (e) {
    checks.push(["review routes ran to the end: " + e.message, false]);
  } finally {
    srv.kill();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

let bad = 0;
for (const [n, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); }
console.log(`\n${bad ? "\x1b[31m" : "\x1b[32m"}board probe: ${checks.length - bad} passed, ${bad} failed\x1b[0m`);
process.exit(bad ? 1 : 0);
