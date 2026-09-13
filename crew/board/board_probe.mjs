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
      said: "{{Inc 2}} needs your go-ahead.", chips: ["go 2", "plan"], frac: 0.25, meta: "1/4" },
    { id: "b", name: "fixture-run", kind: "running", badge: "working",
      said: "{{Inc 3}} in progress.", chips: ["diff"], frac: 0.5, meta: "2/4" },
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
  } catch {
    console.log("  --   fast build unavailable — skipped");
  }
} else {
  console.log("  --   live state unavailable (cmux down?) — fixture checks only");
}

let bad = 0;
for (const [n, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); }
console.log(`\n${bad ? "\x1b[31m" : "\x1b[32m"}board probe: ${checks.length - bad} passed, ${bad} failed\x1b[0m`);
process.exit(bad ? 1 : 0);
