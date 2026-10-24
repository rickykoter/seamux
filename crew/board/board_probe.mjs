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

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// A crew tool by name, through the CREW_IMPL helper: `seamux <name>` when
// CREW_IMPL=rust and seamux registers it, else python3 <file> as always.
const crewImpl = await import("../tools/crew_impl.mjs");
const crewTool = (name, file, args, opts = {}) => {
  const [cmd, ...pre] = crewImpl.argv(name, file, "python3");
  return execFileSync(cmd, [...pre, ...args],
    { encoding: "utf8", ...opts, env: crewImpl.env(opts.env || process.env) });
};
// The argv that runs one board tool, as [cmd, ...args]: the one place this
// probe names crew-board, crew-board-intent, news, judgments and cat_poses.
// Through the CREW_IMPL helper, so under CREW_IMPL=rust a tool seamux
// registers runs as `seamux <basename>` and the rest stay Python.
const tool = (name) => name.endsWith(".py")
  ? crewImpl.argv(name.slice(0, -3), join(HERE, name), "python3")
  : crewImpl.argv(name, join(HERE, name));
// The env any board tool or the server it starts runs in.
const toolEnv = (base = process.env) => crewImpl.env(base);
const runTool = (name, args, opts = {}) => {
  const [cmd, ...pre] = tool(name);
  return execFileSync(cmd, [...pre, ...args], { encoding: "utf8", ...opts, env: toolEnv(opts.env || process.env) });
};
// crew-board's ranking over a fixture: {plans: {root: plan}, workspaces: [...]}
// in place of deep-plan and cmux; no workspaces is the cmux-down path. Returns
// the state, whose rows are rank()'s rows followed by its quiet ones.
const stateFrom = (fx) => {
  const dir = mkdtempSync(join(tmpdir(), "board-probe-fx-"));
  try {
    writeFileSync(join(dir, "fx.json"), JSON.stringify(fx));
    return JSON.parse(runTool("crew-board", ["state", "--json", "--fixture", join(dir, "fx.json")]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
// render.js, not an inline script in the page: the renderer is pushed with each update
// because a page-resident entry point was not reachable, and because a wrong BOARD_HTML
// path once loaded a nonexistent file and the failure was indistinguishable.
const script = readFileSync(join(HERE, "render.js"), "utf8");

const els = {};
const mk = (id) => (els[id] = {
  id, innerHTML: "", textContent: "", className: "", attrs: {},
  getAttribute(k) { return this.attrs[k] ?? null; },
  setAttribute(k, v) { this.attrs[k] = String(v); },
  removeAttribute(k) { delete this.attrs[k]; },
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
// Geometry for the tests that need it: each query render.js makes takes the
// next id -> offsetTop map off this queue -- the first is where rows were
// before the push, the second where they are after it. Empty: uniform rows.
const STUB_GEO = [];
function synthRows() {
  const html = els.rows.innerHTML;
  const out = [];
  const geo = STUB_GEO.length ? STUB_GEO.shift() : {};
  const re = /class="row ([^"]*)"\s+data-id="([^"]+)"([^>]*)>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const id = m[2];
    const inCard = (/data-in="([^"]+)"/.exec(m[3]) || [])[1] || null;
    out.push({
      // Rows are uniform-height in the stub; only the ORDER matters to a FLIP.
      offsetTop: id in geo ? geo[id] : i * 50,
      _i: i++,
      getAttribute: (k) => (k === "data-id" ? id : k === "data-in" ? inCard : null),
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
// Names land in double-quoted attributes too (title=, data-id=), and git allows a quote
// in a branch name: it must not close the attribute and open a handler.
render({ rows: [{ id: 'q"', name: 'x" onmouseover="alert(1)', kind: "attend", badge: "b",
  said: "", chips: [], frac: 0.5, meta: "m" }], quiet: "" });
const escq = els.rows.innerHTML;
checks.push(["a quote cannot break out of an attribute",
  !escq.includes('" onmouseover=') && escq.includes("x&quot; onmouseover=")]);

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
  /<span class="meta">2\/4 increments<\/span>/.test(f)]);
// Actionable signals are buttons in the button row; status signals are text in
// the footer. Both wear the collector's colour, lifted until it reads on a card.
const fChips = (f.match(/<div class="chips">.*?<\/div>/) || [""])[0];
const fFoot = (f.match(/<div class="foot">.*?<\/div>/) || [""])[0];
checks.push(["an actionable signal is a button, a status signal is footer text",
  /class="chip sig" style="color:#[0-9a-f]{6}" data-a="checks"/.test(fChips) &&
  /class="sig" style="color:#[0-9a-f]{6}"[^>]*>draft</.test(fFoot) &&
  !/data-a=/.test(fFoot.replace(/class="(branch|pr[^"]*|issue)" data-a="[^"]+"/g, ""))]);
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

// Every card folds. Unfolded to start: the tiers that ask something of you.
// Folded, a loud card keeps its first chip, filled, on its header line.
render({ rows: ["attend", "wilt", "running", "done"].map((k) => ({
  id: k, name: k, kind: k, badge: "b", said: "said", chips: ["first", "jump"], frac: null, meta: "", ref: "workspace:1" })),
  quiet: "" });
const fo = els.rows.innerHTML;
checks.push(["fold: waiting and broken cards start unfolded; working and done start folded",
  /class="row attend fd open" data-id="attend" data-k="attend"/.test(fo) && /class="row wilt fd open" data-id="wilt"/.test(fo) &&
  /class="row running fd" data-id="running"/.test(fo) && /class="row done fd" data-id="done"/.test(fo)]);
checks.push(["fold: the header folds, the rail jumps, and the body is what folds away",
  /data-id="running"[^>]*><span class="jmp" data-a="jump" title="Switch to this workspace"><svg[^]*?<\/svg><\/span><div class="top" data-a="fold"><span class="caret"><\/span>[^]*?<\/div><div class="fold"><p class="said">/.test(fo)]);
checks.push(["fold: a loud card carries its first chip on the header for when it is folded",
  /data-id="wilt"[^]*?<div class="top loud" data-a="fold">[^]*?<span class="chip pri fq"[^>]*>first<\/span><\/div>/.test(fo) &&
  !/data-id="running"[^]*?class="chip pri fq/.test(fo.split('data-id="done"')[0])]);
els.rows.attrs["data-fold"] = JSON.stringify({ running: [1, "running"], attend: [0, "attend"] });
render({ rows: [{ id: "running", name: "r", kind: "running", said: "s", chips: [], ref: "w" },
  { id: "attend", name: "a", kind: "attend", said: "s", chips: [], ref: "w" }], quiet: "" });
checks.push(["fold: a choice made by hand holds across a push, either way",
  /class="row running fd open"/.test(els.rows.innerHTML) && /class="row attend fd"/.test(els.rows.innerHTML)]);
els.rows.attrs["data-fold"] = "{}";

checks.push(["the worktree's Peacock colour rides on the row",
  /class="row wilt owned( fd open)?"/.test(f) && f.includes('style="--own:#1565C0"')]);

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
render({ rows: [{ id: "b", name: "bare", kind: "running", badge: "", said: "",
  chips: [], frac: null, meta: "", branch: "", dirty: false, pr: "", pr_state: "",
  color: "", signals: [], feedby: 0, feedgate: "", ref: "workspace:1" }], quiet: "" });
checks.push(["a bare row emits no empty button row, footer or badge",
  !/class="(chips|foot|said|badge)"/.test(els.rows.innerHTML)]);

// --- the tidy card -------------------------------------------------------
// Readability and clickability were the point of the redesign, so both are
// measured here rather than eyeballed: a later palette tweak or a "slightly
// smaller" button fails the probe instead of quietly shipping.
//
// Contrast. Every `color:` in board.html's stylesheet is resolved through the
// :root tokens and measured against every ground a card can sit on. A filled
// button's text is measured against the tier colours instead, which are its
// ground.
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const lumOf = (h) => {
  const v = hexRgb(h).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const css = (pageHtml.match(/<style>([\s\S]*?)<\/style>/) || ["", ""])[1].replace(/\/\*[\s\S]*?\*\//g, "");
const TOK = {};
for (const m of (css.match(/:root\{([^}]*)\}/) || ["", ""])[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) TOK[m[1]] = m[2];
const GROUNDS = ["bg", "bg1", "bg-attend"].map((k) => TOK[k]);
const FILLS = ["attend", "running", "wilt", "done"].map((k) => TOK[k]);
const lows = [];
let measured = 0;
for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = rule[1].trim();
  if (sel.startsWith(":root") || /^(from|to|\d)/.test(sel)) continue;     // tokens, keyframes
  for (const d of rule[2].matchAll(/(?:^|[;{\s])color:\s*([^;]+)/g)) {
    const v = d[1].trim();
    const tok = /^var\(--([\w-]+)\)$/.exec(v);
    const hex = tok ? TOK[tok[1]] : (/^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
    if (!hex) {
      if (!/^(currentColor|inherit)$/.test(v)) lows.push(`${sel}: ${v} is not a measurable colour`);
      continue;
    }
    measured++;
    for (const g of /\.pri\b/.test(sel) ? FILLS : GROUNDS) {
      const r = ratio(hex, g);
      if (r < 4.5) lows.push(`${sel}: ${v} on ${g} is ${r.toFixed(2)}:1`);
    }
  }
}
checks.push([`every text colour reads at 4.5:1 on every ground (${measured} measured)`,
  measured > 20 && lows.length === 0]);
if (lows.length) console.log("    " + lows.join("\n    "));
// Opacity was how the old board dimmed quiet rows and small costs, and it is
// invisible to the measurement above, so it is not allowed on text at all.
checks.push(["nothing dims text with opacity",
  ![...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(([, sel, body]) =>
    /(^|;)opacity:\s*\.\d/.test(body) && !/#cat|\.zz|@keyframes|^\s*(\d|from|to)/.test(sel))]);

// The collector's signal colours are the Swift sidebar's. render.js lifts each
// one until it reads on the lightest card; every colour the collector can send
// is pushed through here.
const SIGCOLS = ["#4ADE80", "#60A5FA", "#859289", "#8E8E93", "#A78BFA", "#F5A524", "#F97066"];
render({ rows: [{ id: "s", name: "s", kind: "attend", badge: "b", said: "", chips: ["jump"],
  frac: null, meta: "", ref: "workspace:1",
  signals: SIGCOLS.flatMap((c, i) => [{ t: "a" + i, c, h: "", a: "checks" }, { t: "s" + i, c, h: "" }]
    ).concat([{ t: "bad", c: "red;background:url(x)", h: "", a: "checks" }]) }], quiet: "" });
const sigOut = els.rows.innerHTML;
const lifted = [...sigOut.matchAll(/style="color:(#[0-9a-f]{6})"/g)].map((m) => m[1]);
checks.push(["every collector signal colour is lifted to 4.5:1 on a card",
  lifted.length === SIGCOLS.length * 2 &&
  lifted.every((c) => ratio(c, TOK["bg-attend"]) >= 4.5 && ratio(c, TOK.bg1) >= 4.5)]);
checks.push(["...and a bright one comes back unchanged", lifted.includes("#4ade80")]);
checks.push(["a signal colour that is not a hex never reaches a style attribute",
  !sigOut.includes("url(") && /class="chip sig" data-a="checks"[^>]*>bad</.test(sigOut)]);
render({ rows: [{ id: "c", name: "c", kind: "running", badge: "b", said: "", chips: [], frac: null,
  meta: "", ref: "workspace:1", color: "red;background:url(x)" }], quiet: "" });
checks.push(["a worktree colour that is not a hex never reaches a style attribute",
  !els.rows.innerHTML.includes("url(") && !els.rows.innerHTML.includes("owned")]);

// One filled button, and only where the row asks something of you.
const tiers = ["attend", "wilt", "done", "running"].map((kind) => ({
  id: kind, name: kind, kind, badge: "b", said: "", chips: ["first", "second"], frac: 0.5,
  meta: "", ref: "workspace:1" }));
render({ rows: tiers, quiet: "" });
const pri = els.rows.innerHTML;
const priOf = (id) => {
  const card = pri.split('data-id="' + id + '"')[1].split('<div class="row ')[0];
  return (card.match(/class="chip pri"[^>]*>(\w+)</g) || []).map((m) => m.replace(/.*>/, "").replace("<", ""));
};
checks.push(["attend, wilt and done fill their first button, and only that one",
  ["attend", "wilt", "done"].every((k) => priOf(k).join() === "first")]);
checks.push(["a working card's buttons are all ghosts", priOf("running").length === 0]);

// A quiet row is one line: dot, name, badge if it has one. No dial, no said,
// no buttons, no footer -- the row is the target.
render({ rows: [
  { id: "q1", name: "q-with", kind: "quiet", badge: "pr open", said: "", chips: ["jump", "pr"],
    frac: 0.3, meta: "1/3 increments", branch: "dev/q", pr: "#9", color: "#7fbbb3", ref: "workspace:1" },
  { id: "q2", name: "q-bare", kind: "quiet", badge: "", said: "", chips: ["jump"], frac: null,
    meta: "", ref: "workspace:2" },
], quiet: "" });
const qo = els.rows.innerHTML;
// Its footer is there, folded: unfolding a quiet row shows its branch and PR.
// One with no footer has nothing to fold, and its line selects it.
checks.push(["a quiet row is one line: no dial, said, or footer until unfolded",
  !/class="(dial|said|feed)/.test(qo) && (qo.match(/class="top"/g) || []).length === 2 &&
  !/<div class="chips">/.test(qo) && !/ open"/.test(qo) &&
  /class="row quiet owned fd"[^]*<div class="top" data-a="fold"><span class="caret"><\/span>[^]*<div class="fold"><div class="foot"><span class="branch"/.test(qo) &&
  !/class="cost|class="wk/.test((qo.match(/<div class="fold">[^]*?<\/div><\/div>/) || [""])[0]) &&
  /class="row quiet" data-id="q2"[^]*?<div class="top">/.test(qo) && !qo.split('data-id="q2"')[1].includes("fold")]);
// Its chips stay, as ghosts on that line -- except jump, which the row itself
// does. Buttons say what the badge would, so the badge steps aside for them.
const q1 = qo.split('data-id="q2"')[0];
checks.push(["a quiet row keeps its chips as ghost buttons on its one line",
  /<div class="top"[^>]*>.*<span class="chips"><span class="chip"[^>]*>pr<\/span><\/span><\/div>/.test(q1) &&
  !/>jump</.test(qo) && !/chip pri/.test(qo)]);
checks.push(["...with the badge only when there are none, and no empty badge",
  !q1.includes('class="badge"') && (qo.match(/class="badge"/g) || []).length === 0]);
render({ rows: [{ id: "q3", name: "q-idle", kind: "quiet", badge: "idle", said: "", chips: ["jump"],
  frac: null, meta: "", ref: "workspace:3" }], quiet: "" });
checks.push(["...and an idle quiet row shows its badge", els.rows.innerHTML.includes('class="badge">idle<')]);
render({ rows: [
  { id: "q4", name: "q-idle-wake", kind: "quiet", badge: "idle", said: "", chips: ["jump", "wake"], frac: null, meta: "", ref: "workspace:4" },
  { id: "q5", name: "q-pr-wake", kind: "quiet", badge: "pr open", said: "", chips: ["jump", "pr", "wake"], frac: null, meta: "", ref: "workspace:5", cost: 2.5 },
  { id: "c6", name: "c-wake", kind: "running", badge: "working", said: "", chips: ["diff", "wake"], frac: null, meta: "", ref: "workspace:6", cost: 4.12, branch: "dev/x" },
  { id: "c7", name: "c-bare", kind: "running", badge: "working", said: "", chips: ["wake"], frac: null, meta: "", ref: "workspace:7" },
  { id: "c8", name: "c-none", kind: "running", badge: "working", said: "", chips: ["diff"], frac: null, meta: "", ref: "workspace:8" },
], quiet: "" });
{
  const h = els.rows.innerHTML;
  const [w4, rest] = h.split('data-id="q5"');
  const [w5, rest2] = rest.split('data-id="c6"');
  const [w6, rest3] = rest2.split('data-id="c7"');
  const [w7, w8] = rest3.split('data-id="c8"');
  const icon = /<span class="wk" data-a="wake" title="Open the Wake[^"]*"><svg [^>]*aria-hidden="true">/;
  checks.push(["wake: an icon with data-a=wake and a tooltip, never a text chip",
    icon.test(w4) && !/>wake<\/span>/.test(h) && !/class="chip"[^>]*>wake</.test(h)]);
  checks.push(["wake: an idle quiet row with only the Wake still says idle",
    w4.includes('class="badge">idle<')]);
  checks.push(["wake: ...while a quiet row with pr lets its badge step aside, spend then the Wake last",
    !w5.includes('class="badge"') && />pr<\/span>/.test(w5) &&
    /class="cost[^"]*"[^>]*>\$2\.50<\/span><span class="wk"/.test(w5) && /<\/svg><\/span><\/div><\/div><div class="row [^"]*" $/.test(w5)]);
  checks.push(["wake: a card's footer ends with the spend and then the Wake",
    /<div class="foot">.*<span class="end"><span class="cost[^"]*"[^>]*>\$4\.12<\/span><span class="wk".*<\/svg><\/span><\/span><\/div>/.test(w6) &&
    !/<div class="chips">[^]*wk/.test(w6.split('<div class="foot">')[0])]);
  checks.push(["wake: a card with nothing else in its footer still gets one for the Wake, and no empty chip row",
    /<div class="foot"><span class="end"><span class="wk"/.test(w7) && !w7.includes('class="chips"')]);
  checks.push(["wake: the spend and the Wake wrap as one unit, held at the right end",
    /\.foot>\.end\{[^}]*display:inline-flex[^}]*margin-left:auto/.test(css) &&
    !/\.foot>\.end\{[^}]*flex-wrap:wrap/.test(css)]);
  checks.push(["wake: a row the collector gave no wake has no icon", !w8.includes('class="wk"')]);
}

// A family card holds rows of other tiers, so a tier rule that reaches its
// badge or quiet line through a DESCENDANT selector paints the children too:
// an attend child's badge came out the working parent's teal.
checks.push(["tier rules style a row's own head, never its children's",
  !/\.(attend|running|wilt|done|quiet) \.(badge|top|nm|cost|chips|dial)\b/.test(css)]);

// One rail. The worktree colour is a dot by the name, not a second stripe.
checks.push(["the worktree colour is a dot, not a second stripe",
  qo.includes('<span class="own"></span>') && !/inset\s+\d+px\s+0\s+0\s+0\s+var\(--own\)/.test(css)]);

// Targets. The sizes live in CSS, so the CSS is what is asserted.
const ruleBody = (sel) => {
  for (const [, s, b] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (s.trim() === sel) return b;
  return "";
};
const px = (body, prop) => Number((new RegExp("(?:^|;)" + prop + ":(\\d+(?:\\.\\d+)?)px").exec(body) || [])[1] || 0);
checks.push(["every button is at least 28px tall", px(ruleBody(".chip"), "min-height") >= 28]);
checks.push(["a footer item that runs long ends in an ellipsis, not past the card",
  /text-overflow:ellipsis/.test(ruleBody(".foot>span")) && /max-width:100%/.test(ruleBody(".foot>span"))]);
checks.push(["every footer link is at least 24px tall",
  px(ruleBody(".foot>span"), "min-height") >= 24 && px(ruleBody(".foot>span"), "line-height") >= 24]);
checks.push(["body text is 13px", /font:13px\//.test(ruleBody("body")) && /font-size:13px/.test(ruleBody(".said"))]);

// The header: the tally shares the headline's line, and the caption is a
// sentence at full strength, not 9px at half opacity.
checks.push(["the tally folds into the headline's line",
  /<div class="hud">\s*<span id="need">[^<]*<\/span>\s*<span id="tally">/.test(pageHtml)]);
checks.push(["the cat's caption is legible", px(ruleBody("#says"), "font:italic ") >= 11 ||
  /font:italic 1[1-9](\.\d+)?px/.test(ruleBody("#says"))]);

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
  // The mood is the first class; a reaction may follow it (see below).
  return (els.cat.attrs.class || "").split(" ")[0];
};
checks.push(["cat swats when a human is waited on", moodFor(["running", "attend"]) === "swat"]);
checks.push(["cat paces over work in progress", moodFor(["running"]) === "pace"]);
checks.push(["cat paces over a broken build too, as the sidebar's does",
  moodFor(["wilt"]) === "pace"]);
checks.push(["cat naps when the board is clear", moodFor(["quiet"]) === "nap"]);
checks.push(["and it has something to say about each",
  ["off duty", "nothing needs you", "all quiet. nap time.", "zzz", "dreaming of green checks"]
    .includes(els.says.textContent)]);

// Reactions: this push against the last, one at a time, each for one push.
{
  const P = (rows, stamp = "00:00:01") => { render({ rows, quiet: "", stamp }); return els.cat.attrs.class; };
  const Rw = (id, kind, name = id) => ({ id, name, kind, badge: "b", said: "", chips: [], frac: null, meta: "", ref: "w" });
  els.rows.attrs["data-prev"] = "{}";
  delete els.rows.attrs["data-pushed"];
  checks.push(["cat: the first push of a page is not a reaction", P([Rw("a", "attend"), Rw("r", "running")]) === "swat"]);
  checks.push(["cat: nothing changed, no reaction", P([Rw("a", "attend"), Rw("r", "running")]) === "swat"]);
  checks.push(["cat: a row newly needing you perks its ears, and says which",
    P([Rw("a", "attend"), Rw("b", "attend", "billing-ledger"), Rw("r", "running")]) === "swat perk" &&
    els.says.textContent.includes("billing-ledger")]);
  checks.push(["cat: ...for that push only", P([Rw("a", "attend"), Rw("b", "attend"), Rw("r", "running")]) === "swat"]);
  checks.push(["cat: the last thing needing you going away is a stretch",
    P([Rw("r", "running")]) === "pace stretch"]);
  checks.push(["cat: a row turning done is a hop, and it names the row",
    P([Rw("r", "done", "login-copy")]) === "nap hop" && els.says.textContent.includes("login-copy")]);
  P([Rw("a", "attend"), Rw("r", "running")]);
  checks.push(["cat: a hop outranks a stretch when both happen at once",
    P([Rw("r", "done")]) === "nap hop"]);
  // The same reaction two pushes running: the class has to come off and go
  // back on, with a style flush between, or CSS does not replay it.
  const seen = [];
  const realSet = els.cat.setAttribute;
  els.cat.setAttribute = function (k, v) { seen.push(v); return realSet.call(this, k, v); };
  els.cat.getBoundingClientRect = () => { seen.push("flush"); return {}; };
  P([Rw("a", "attend")]);
  seen.length = 0;
  P([Rw("a", "attend"), Rw("b", "attend")]);
  checks.push(["cat: a second perk in a row replays: off, flush, on",
    seen.join() === "swat,flush,swat perk"]);
  els.cat.setAttribute = realSet;
  delete els.cat.getBoundingClientRect;
  // A board that was empty a moment ago has an empty data-prev too; its first
  // waiting row is still news.
  P([]);
  checks.push(["cat: a row needing you right after an empty board still perks",
    P([Rw("z", "attend")]) === "swat perk"]);
  P([Rw("x", "running")]);
  // ---- celebrations ------------------------------------------------------
  const R4 = (id, kind, extra = {}) => ({ id, name: id, kind, badge: "b", said: "", chips: [], frac: null, meta: "", ref: "w", ...extra });
  P([R4("c1", "running")]);
  render({ rows: [R4("c1", "done")], quiet: "", stamp: "1" });
  const conf1 = els.rows.innerHTML;
  checks.push(["confetti: a card that turns done throws a handful of pixel bits",
    /class="row done ripple[^"]*"[^>]*><span class="confetti" aria-hidden="true">(<i style="[^"]+"><\/i>){12}<\/span>/.test(conf1)]);
  els.rows.attrs["data-prev"] = JSON.stringify({ c1: "running" });
  render({ rows: [R4("c1", "done")], quiet: "", stamp: "1" });
  checks.push(["confetti: ...the same handful every time, from the row id", els.rows.innerHTML === conf1]);
  render({ rows: [R4("c1", "done")], quiet: "", stamp: "2" });
  checks.push(["confetti: ...and only on the push it turned done", !els.rows.innerHTML.includes("confetti")]);

  const famRows = (k1, k2) => [R4("FP", "running", { family: "F4", famrole: "parent", famkid: false }),
    R4("F1", k1, { family: "F4", famrole: "child", famkid: true }),
    R4("F2", k2, { family: "F4", famrole: "child", famkid: true })];
  render({ rows: famRows("done", "running"), quiet: "" });
  checks.push(["pips: one kitten head per child, in its tier, most urgent first",
    /<span class="pips"><svg class="pip running"[^>]*><title>F2 · b<\/title>[^]*?<\/svg><svg class="pip done"[^>]*><title>F1 · b/.test(els.rows.innerHTML) &&
    (els.rows.innerHTML.match(/class="pip /g) || []).length === 2]);
  checks.push(["family: not complete while a child is still working", !els.rows.innerHTML.includes("famdone")]);
  render({ rows: famRows("done", "done"), quiet: "" });
  const fd = els.rows.innerHTML;
  checks.push(["family: the push its last child turns done, the whole card celebrates",
    /class="row running fam famdone fd"[^>]*data-id="FP"[^>]*><span class="jmp"[^]*?<\/span><span class="confetti" aria-hidden="true">(<i [^>]+><\/i>){22}/.test(fd)]);
  render({ rows: famRows("done", "done"), quiet: "" });
  checks.push(["family: ...once", !els.rows.innerHTML.includes("famdone")]);
  render({ rows: [R4("S1", "done", { family: "S", famrole: "child", famkid: true, famlabel: "S" }),
    R4("S2", "done", { family: "S", famrole: "child", famkid: true })], quiet: "" });
  checks.push(["family: a shell whose children are all done says so",
    els.rows.innerHTML.includes('<span class="badge roll done">all 2 done</span>')]);

  // A big family: five pips, then a count, so the name keeps its room.
  render({ rows: [R4("BP", "running", { family: "B", famrole: "parent", famkid: false }),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => R4("B" + i, i === 6 ? "attend" : "quiet", { family: "B", famrole: "child", famkid: true }))], quiet: "" });
  checks.push(["pips: a big family shows five, the most urgent among them, then +N",
    (els.rows.innerHTML.match(/class="pip /g) || []).length === 5 &&
    /<span class="pips"><svg class="pip attend"/.test(els.rows.innerHTML) &&
    els.rows.innerHTML.includes('<span class="pipmore">+3</span>')]);
  checks.push(["family: a card that climbs on the push it turns done keeps its ring",
    /\.row\.up\.ripple\{animation:ripple/.test(css) && /\.row\.up\.famdone\{animation:famdone/.test(css) &&
    css.indexOf(".row.up.ripple{") > css.indexOf(".row.up{")]);

  // ---- the sky ------------------------------------------------------------
  // The context's own Date is shadowed for one render by a sandbox property,
  // then the property goes and the builtin is back.
  const skyAt = (h) => {
    sandbox.Date = class extends Date { getHours() { return h; } };
    render({ rows: [], quiet: "" });
    delete sandbox.Date;
    return els.shelf.attrs["data-sky"];
  };
  delete (els.shelf || mk("shelf")).attrs["data-sky"];
  const firstSky = skyAt(6);
  checks.push(["sky: a page's first push shows its sky at once", els.shelf.attrs["data-sky-first"] === "1"]);
  checks.push(["sky: dawn, day, dusk and night follow the local hour",
    firstSky === "dawn" && skyAt(12) === "day" && skyAt(19) === "dusk" && skyAt(23) === "night" &&
    skyAt(3) === "night" && skyAt(5) === "dawn" && skyAt(8) === "day" && skyAt(21) === "night"]);
  checks.push(["sky: ...and fades between them after that", !("data-sky-first" in els.shelf.attrs)]);
  checks.push(["sky: every sky keeps the shelf's bottom edge",
    /#shelf \.sky\{[^}]*box-shadow:inset 0 -1px 0 0 #171c1f/.test(css)]);
  checks.push(["sky: every hour's layer is in the page and is shown by its data-sky",
    ["dawn", "day", "dusk", "night"].every((k) => pageHtml.includes('<div class="sky ' + k + '">') &&
      css.includes("#shelf[data-sky=" + k + "] .sky." + k))]);

  // ---- the nap, idling ------------------------------------------------------
  // One cycle for all of it: a peek and a flick on cycles of their own drifted
  // into each other and drew two full poses at once. So: the same duration for
  // the two shows and the hide, show windows that never overlap, and the hide
  // covering exactly their union. And none of it on a push with a reaction.
  {
    const IDLE = "#cat\\.nap:not\\(\\.hop\\):not\\(\\.perk\\):not\\(\\.stretch\\) ";
    const dur = (sel, name) => (new RegExp(IDLE + sel + "\\{animation:" + name + " (\\d+)s").exec(css) || [])[1];
    const d1 = dur("\\.peek", "peekshow"), d2 = dur("\\.flick", "flickshow"), d3 = dur("\\.pose:not\\(\\.x\\) path", "idlehide");
    const windows = (name, prop, on) => {
      const body = (new RegExp("@keyframes " + name + "\\{([\\s\\S]*?)\\}\\}").exec(css) || ["", ""])[1] + "}";
      const out = [];
      for (const [, sel, decl] of body.matchAll(/([\d.%,\s]+)\{([^}]*)\}/g)) {
        if (decl.includes(prop + ":" + on)) {
          const ps = sel.split(",").map((x) => parseFloat(x));
          out.push([Math.min(...ps), Math.max(...ps)]);
        }
      }
      return out;
    };
    const pw = windows("peekshow", "visibility", "visible"), fw = windows("flickshow", "visibility", "visible");
    const hw = windows("idlehide", "opacity", "0");
    const overlap = pw.some(([a, b]) => fw.some(([c, e]) => a <= e && c <= b));
    const union = [...pw, ...fw].sort((x, y) => x[0] - y[0]);
    checks.push(["nap: peek and flick share one long cycle, and the nap hides on it too",
      d1 && +d1 >= 30 && d1 === d2 && d2 === d3]);
    checks.push(["nap: ...their moments never overlap, and the nap hides for exactly those",
      pw.length >= 2 && fw.length >= 1 && !overlap && JSON.stringify(hw) === JSON.stringify(union)]);
    checks.push(["nap: ...and none of it runs on a push that carries a reaction",
      !/#cat\.nap \.(peek|flick)\{/.test(css) && !/#cat\.nap \.pose:not\(\.x\) path\{/.test(css)]);
  }

  P([Rw("x", "running")]);
  checks.push(["cat: a $ in a row's name reaches the caption as written",
    P([Rw("x", "done", "fix-$&-and-$$")]) === "nap hop" && els.says.textContent.includes("fix-$&-and-$$")]);

  // The caption: still within a push, moving across pushes, naming the top row.
  const said = (stamp, rows) => { render({ rows, quiet: "", stamp }); return els.says.textContent; };
  const busy = [Rw("w", "running", "search-index")];
  const lines = new Set();
  for (let i = 0; i < 40; i++) lines.add(said("12:00:" + String(i).padStart(2, "0"), busy));
  checks.push(["cat: the caption rotates across pushes", lines.size >= 3]);
  checks.push(["cat: ...holds still for the same push", said("12:00:07", busy) === said("12:00:07", busy)]);
  checks.push(["cat: ...and can name the row it is watching",
    [...lines].some((l) => l.includes("search-index"))]);
  const idle = new Set();
  for (let i = 0; i < 40; i++) idle.add(said("13:00:" + String(i).padStart(2, "0"), [Rw("q", "quiet")]));
  checks.push(["cat: a line about a row is never used with no row to name",
    ![...idle].some((l) => /^\s|\s$|  |\{top\}/.test(l))]);
  els.rows.attrs["data-prev"] = "{}";
}

// The tally counts every tier, in the ranking's own order, and says nothing about
// the tiers that are empty.
render({ rows: [
  { id: "a", name: "a", kind: "attend", badge: "b", said: "", chips: [], frac: null, meta: "" },
  { id: "b", name: "b", kind: "wilt", badge: "b", said: "", chips: [], frac: null, meta: "" },
  { id: "c", name: "c", kind: "wilt", badge: "b", said: "", chips: [], frac: null, meta: "" },
  { id: "d", name: "d", kind: "quiet", badge: "b", said: "", chips: [], frac: null, meta: "" },
], quiet: "" });
const tal = els.tally.innerHTML;
// Attend is the headline's number and quiet is the divider's, so the tally
// that shares the headline's line counts neither.
checks.push(["the tally counts the tiers between the headline and the divider",
  /class="tl wilt"><b>2<\/b> broken/.test(tal) && !/need you|quiet/.test(tal)]);
checks.push(["...omits the empty ones", !tal.includes("working") && !tal.includes("to close")]);
render({ rows: [
  { id: "d", name: "d", kind: "done", badge: "b", said: "", chips: [], frac: 1, meta: "" },
  { id: "r", name: "r", kind: "running", badge: "b", said: "", chips: [], frac: null, meta: "" },
  { id: "w", name: "w", kind: "wilt", badge: "b", said: "", chips: [], frac: null, meta: "" },
], quiet: "" });
const tal2 = els.tally.innerHTML;
checks.push(["...in the ranking's order",
  tal2.indexOf("broken") < tal2.indexOf("working") && tal2.indexOf("working") < tal2.indexOf("to close")]);
render({ rows: [], quiet: "" });
checks.push(["...and disappears when there is nothing", els.tally.innerHTML === ""]);
// The headline counts one tier, so it must not speak for the others.
render({ rows: [
  { id: "w", name: "w", kind: "wilt", badge: "b", said: "", chips: [], frac: null, meta: "" },
], quiet: "" });
checks.push(["the headline never says all-clear over a broken board",
  !/all clear/i.test(els.need.textContent) && /nothing needs you/i.test(els.need.textContent)]);

// The board-only poses are generated too, from cat_poses.py's grids.
checks.push(["the board-only poses are in sync with cat_poses.py",
  (() => { try { runTool("cat_poses.py", ["--check"],
    { encoding: "utf8" }); return true; } catch { return false; } })()]);
// They sit inside the sprite, so they walk and turn with it, and every
// reaction render.js can set has a pose to show and a rule to show it.
{
  const sprite = (pageHtml.match(/<!-- CAT:BEGIN[\s\S]*?<!-- CAT:END -->/) || [""])[0];
  const facing = (sprite.match(/<g class="facing">([\s\S]*)<\/g><\/g>/) || ["", ""])[1];
  checks.push(["the new poses are inside the cat's svg, in the turning group",
    ["hop-a", "hop-b", "heart", "perk", "stretch", "peek", "flick"].every((p) => facing.includes('class="pose x ' + p + '"'))]);
  checks.push(["every reaction has its poses shown and the mood hidden for as long",
    ["hop", "perk", "stretch"].every((r) => new RegExp("#cat\\." + r + " \\.pose:not\\(\\.x\\) path\\{animation:rxhide").test(css)) &&
    /#cat\.hop \.hop-a\{/.test(css) && /#cat\.perk \.perk\{/.test(css) && /#cat\.stretch \.stretch\{/.test(css)]);
  // Reduced motion stops EVERYTHING, and names each rule by its OWN selector. A
  // broader selector loses on specificity: the mood's frames stayed hidden for
  // a reaction's length while the reaction's poses were stopped, and the cat
  // vanished. So every selector of every rule that starts an animation has to
  // appear, verbatim, in the reduce block's animation:none list. One
  // exception: the reply window's bar, which is not decoration -- it is the
  // only thing on the page that says how long is left to answer.
  const reduce = (css.match(/@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\}\s*\}/) || ["", ""])[1];
  const stopped = new Set(((reduce.match(/([^{}]+)\{animation:none\}/) || ["", ""])[1]).split(",").map((x) => x.trim()));
  const outside = css.replace(/@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\}\s*\}/, "");
  const rxSels = [];
  for (const [, sel, body] of outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(^|;)\s*animation(-name)?\s*:/.test(body) || /animation:\s*none/.test(body) ||
        /^@keyframes|^\d|^from|^to/.test(sel.trim())) continue;
    for (const one of sel.split(",").map((x) => x.trim())) {
      if (one !== ".feedbar") rxSels.push(one);
    }
  }
  const missing = rxSels.filter((x) => !stopped.has(x));
  checks.push([`reduced motion stops every animation by its own selector (${rxSels.length})`,
    rxSels.length >= 30 && missing.length === 0]);
  checks.push(["...and, stopped, each mood holds its first frame instead of vanishing",
    /#cat\.swat \.swat-a,#cat\.pace \.walk-a,#cat\.nap \.nap-a\{visibility:visible\}/.test(reduce)]);
  checks.push(["...and the sky changes without fading", /#shelf \.sky,#shelf \.orb\{transition:none\b/.test(reduce)]);
  if (missing.length) console.log("    not stopped: " + missing.join(" | "));
}

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
  live = JSON.parse(runTool("crew-board", ["state", "--json"]));
} catch { /* cmux down, or no crew-board: not a probe failure */ }
if (live && Array.isArray(live.rows)) {
  render(live);
  const lout = els.rows.innerHTML;
  checks.push([`live state renders (${live.rows.length} row(s))`,
    live.rows.length ? (lout.match(/class="row /g) || []).length === live.rows.length
                     : lout.includes("empty")]);
  checks.push(["live state leaks no undefined", !lout.includes("undefined")]);
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
  const runAttr = (...cwds) => JSON.parse(crewTool("costs", join(HERE, "costs.py"),
    ["--attribute", fixture, ...cwds]));
  const r1 = runAttr(A, B, C);
  checks.push(["costs: today/week split by date", r1[A]?.today === 1.5 && r1[A]?.week === 3.5]);
  checks.push(["costs: munge collision resolves to the first claim, once",
    r1[A] !== undefined && r1[B] === undefined]);
  checks.push(["costs: a dir matching no known cwd is dropped, not guessed",
    !JSON.stringify(r1).includes("99")]);
  checks.push(["costs: week-only workspace has a zero today", r1[C]?.today === 0 && r1[C]?.week === 0.25]);
  // The CI path: no ccusage on PATH -> {} and exit 0, never a traceback.
  const r2 = crewTool("costs", join(HERE, "costs.py"), [A],
    { env: { ...process.env, PATH: "/usr/bin:/bin", CREW_COSTS_TTL: "0", HOME: tmp } });
  checks.push(["costs: missing ccusage degrades to {}", r2.trim() === "{}"]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- pricing overrides + unpriced usage, through a fake ccusage -------------
// The fake records its argv and answers with output recorded from ccusage
// 20.0.23 against a transcript fixture holding one model it cannot price
// (claude-test-9-9): `missingPricing` on that breakdown, $0 for its tokens.
// So nothing here needs ccusage, the network or this machine's transcripts.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "pricing-probe-"));
  const PRICING = join(HERE, "pricing.py");
  const d = new Date();
  const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const sonnet = { modelName: "claude-sonnet-5-5", cost: 0.1145, inputTokens: 1000,
    outputTokens: 1000, cacheCreationTokens: 1000, cacheReadTokens: 1000000 };
  const unknown = { modelName: "claude-test-9-9", cost: 0, missingPricing: true,
    inputTokens: 5000, outputTokens: 5000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const row = (extra) => ({ totalCost: 0.1145, totalTokens: 1013000,
    modelsUsed: ["claude-sonnet-5-5", "claude-test-9-9"], modelBreakdowns: [sonnet, unknown], ...extra });
  const CWD = "/tmp/fx/ws", OTHER = "/tmp/fx/priced";
  fs.writeFileSync(join(tmp, "daily.json"), JSON.stringify({
    projects: {
      "-tmp-fx-ws": [row({ date: TODAY, project: "-tmp-fx-ws" })],
      "-tmp-fx-priced": [{ date: TODAY, totalCost: 2, modelBreakdowns: [{ ...sonnet, cost: 2 }] }],
    },
    totals: { totalCost: 2.1145, unpricedModels: ["claude-test-9-9"] },
  }));
  fs.writeFileSync(join(tmp, "monthly.json"), JSON.stringify({
    monthly: [row({ period: TODAY.slice(0, 7) })],
    totals: { totalCost: 0.1145, unpricedModels: ["claude-test-9-9"] },
  }));
  // The unified (all-agent) reports /usage reads: rows keyed by `period`.
  fs.writeFileSync(join(tmp, "unified-daily.json"), JSON.stringify({
    daily: [row({ period: TODAY, agent: "claude" })] }));
  fs.writeFileSync(join(tmp, "weekly.json"), JSON.stringify({
    weekly: [row({ period: TODAY, agent: "claude" })] }));
  fs.writeFileSync(join(tmp, "blocks.json"), JSON.stringify({ blocks: [] }));
  const bin = join(tmp, "bin"), log = join(tmp, "argv.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, "ccusage"),
    `#!/bin/sh\necho "$*" >> "${log}"\ncase " $* " in\n` +
    `  *" --instances "*) cat "${join(tmp, "daily.json")}" ;;\n` +
    `  *" monthly "*) cat "${join(tmp, "monthly.json")}" ;;\n` +
    `  *" weekly "*) cat "${join(tmp, "weekly.json")}" ;;\n` +
    `  *" blocks "*) cat "${join(tmp, "blocks.json")}" ;;\n` +
    `  *) cat "${join(tmp, "unified-daily.json")}" ;;\nesac\n`, { mode: 0o755 });
  const local = join(tmp, "crew-local"), home = join(tmp, "home"), claudeDir = join(tmp, "claude");
  fs.mkdirSync(local); fs.mkdirSync(home); fs.mkdirSync(claudeDir);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: home, CREW_LOCAL: local,
    CREW_COSTS_TTL: "0", CLAUDE_CONFIG_DIR: claudeDir, CREW_BILLING: "usage" };
  // pricing.py, costs.py and the status line go through the CREW_IMPL helper.
  // The status line runs with no workspace id, so it never asks cmux for a colour.
  const STATUSLINE = join(HERE, "..", "claude", "statusline.py");
  const PORTED = { [PRICING]: "pricing", [join(HERE, "costs.py")]: "costs", [STATUSLINE]: "statusline" };
  const py = (args, opts = {}) => PORTED[args[0]]
    ? crewTool(PORTED[args[0]], args[0], args.slice(1), { env, ...opts })
    : execFileSync("python3", args, { encoding: "utf8", env, ...opts });
  const args = () => JSON.parse(py([PRICING, "--args"]));
  const lastArgv = () => fs.readFileSync(log, "utf8").trim().split("\n").pop();

  // No local file: only the shipped set. While that is empty (the normal
  // state) there is no --config at all, so ccusage still discovers the user's
  // own config exactly as it did before. Asked of the shipped file rather than
  // assumed, so adding a real shipped entry does not break the probe.
  const shipped = JSON.parse(fs.readFileSync(join(HERE, "..", "config", "ccusage-pricing.json"), "utf8"));
  const shippedEmpty = !Object.keys(shipped.defaults?.pricingOverrides || {}).length;
  const base = args();
  checks.push([shippedEmpty ? "pricing: nothing to override means no --config"
                            : "pricing: the shipped overrides alone give a --config",
    shippedEmpty ? base.length === 0 : base[0] === "--config"]);
  py([join(HERE, "costs.py"), CWD]);
  checks.push(["pricing: ...and costs.py runs ccusage accordingly",
    shippedEmpty ? !lastArgv().includes("--config") : lastArgv().includes(`--config ${base[1]}`)]);

  // A local override: --config, pointing at a generated file holding only what
  // ccusage accepts (a provenance key passes through crew's file, not ccusage's).
  fs.writeFileSync(join(local, "ccusage-pricing.json"), JSON.stringify({ defaults: { pricingOverrides: {
    "claude-test-9-9": { inputCostPerToken: 1e-6, source: "probe" } } } }));
  // The user's own ccusage.json, which a bare --config would silently replace.
  fs.writeFileSync(join(claudeDir, "ccusage.json"), JSON.stringify({ defaults: { timezone: "UTC",
    pricingOverrides: { "claude-test-9-9": { outputCostPerToken: 5e-6, inputCostPerToken: 9 } } } }));
  const a2 = args();
  let gen = {};
  try { gen = JSON.parse(fs.readFileSync(a2[1], "utf8")); } catch { /* checked below */ }
  const ent = gen.defaults?.pricingOverrides?.["claude-test-9-9"] || {};
  checks.push(["pricing: an override file means --config <generated file>",
    a2[0] === "--config" && a2[1].startsWith(home)]);
  checks.push(["pricing: crew's field wins over the user's for the same model",
    ent.inputCostPerToken === 1e-6]);
  checks.push(["pricing: ...and the user's config survives underneath it",
    ent.outputCostPerToken === 5e-6 && gen.defaults?.timezone === "UTC"]);
  checks.push(["pricing: provenance keys never reach ccusage", !("source" in ent)]);
  py([join(HERE, "costs.py"), CWD]);
  checks.push(["pricing: costs.py passes the same --config", lastArgv().includes(`--config ${a2[1]}`)]);
  py([STATUSLINE], { input: "{}", env: { ...env, CMUX_WORKSPACE_ID: "" } });
  checks.push(["pricing: the status line passes it too", lastArgv().includes("--config")]);

  // A broken local file degrades to what there was without it, never an error.
  // The user's ccusage.json is moved aside first: with it present, the
  // generated file's name would differ from `base` even for the same overrides.
  fs.rmSync(join(claudeDir, "ccusage.json"));
  const same = (x) => JSON.stringify(x) === JSON.stringify(base);
  fs.writeFileSync(join(local, "ccusage-pricing.json"), "{ not json");
  checks.push(["pricing: an unreadable local file is ignored, not an error", same(args())]);
  // ...and so is a value ccusage would choke on (it drops the WHOLE config).
  fs.writeFileSync(join(local, "ccusage-pricing.json"), JSON.stringify({ defaults: { pricingOverrides: {
    "claude-test-9-9": { inputCostPerToken: "cheap" } } } }));
  checks.push(["pricing: a non-numeric price is dropped, not passed on", same(args())]);
  fs.rmSync(join(local, "ccusage-pricing.json"));

  // Local entries win over shipped ones, per model and wholesale.
  const shippedF = join(tmp, "shipped.json"), localF = join(tmp, "local.json");
  fs.writeFileSync(shippedF, JSON.stringify({ defaults: { pricingOverrides: {
    "m-a": { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6 }, "m-b": { inputCostPerToken: 2e-6 } } } }));
  fs.writeFileSync(localF, JSON.stringify({ defaults: { pricingOverrides: {
    "m-a": { cacheReadInputTokenCost: 1e-7 } } } }));
  const merged = JSON.parse(py([PRICING, "--merge", shippedF, localF]));
  checks.push(["pricing: a local entry replaces the shipped one for its model",
    JSON.stringify(merged["m-a"]) === JSON.stringify({ cacheReadInputTokenCost: 1e-7 })]);
  checks.push(["pricing: ...and shipped entries for other models remain", merged["m-b"]?.inputCostPerToken === 2e-6]);
  const mergedNoLocal = JSON.parse(py([PRICING, "--merge", shippedF, join(tmp, "absent.json")]));
  checks.push(["pricing: a missing local file leaves the shipped set as is",
    Object.keys(mergedNoLocal).sort().join() === "m-a,m-b"]);

  // Doctor's comparison, pure: the override against upstream's cached entry.
  const ovF = join(tmp, "ov.json"), upF = join(tmp, "up.json");
  fs.writeFileSync(ovF, JSON.stringify({
    "m-same": { cacheReadInputTokenCost: 1e-7 },
    "m-diff": { cacheReadInputTokenCost: 2e-7 },
    "m-gap": { inputCostPerToken: 1e-6 },
  }));
  fs.writeFileSync(upF, JSON.stringify({
    "m-same": { cache_read_input_token_cost: 1e-7, input_cost_per_token: 2e-6 },
    "m-diff": { cache_read_input_token_cost: 1e-7 },
  }));
  const cmp = JSON.parse(py([PRICING, "--compare", ovF, upF]));
  const said = (lvl, re) => cmp.some(([l, m]) => l === lvl && re.test(m));
  checks.push(["doctor: an override equal to upstream says remove it",
    said("warn", /override for m-same now matches upstream — remove it/)]);
  checks.push(["doctor: a differing override quotes both values",
    said("note", /m-diff.*2e-07.*upstream 1e-07/)]);
  checks.push(["doctor: no upstream entry means the override fills a gap",
    said("warn", /m-gap: upstream has no entry — the override is filling a gap.*outputCostPerToken/)]);
  const noCache = JSON.parse(py([PRICING, "--compare", ovF, "-"]));
  checks.push(["doctor: no price cache skips with a note",
    noCache.length === 1 && noCache[0][0] === "note" && /skipped/.test(noCache[0][1])]);
  fs.writeFileSync(ovF, "{}");
  checks.push(["doctor: no overrides says nothing about upstream",
    JSON.parse(py([PRICING, "--compare", ovF, upF])).length === 0]);

  // Unpriced usage, end to end: ccusage output -> costs.py -> board row render.
  const cm = JSON.parse(py([join(HERE, "costs.py"), CWD, OTHER]));
  checks.push(["unpriced: costs.py names the model ccusage could not price",
    JSON.stringify(cm[CWD]?.unpricedToday) === '["claude-test-9-9"]' &&
    JSON.stringify(cm[CWD]?.unpriced) === '["claude-test-9-9"]']);
  checks.push(["unpriced: a fully priced workspace carries none",
    cm[OTHER]?.today === 2 && cm[OTHER]?.unpricedToday?.length === 0]);
  render({ rows: [
    { id: "u", name: "unpriced", kind: "running", badge: "b", said: "", chips: [], frac: 0.5, meta: "",
      cost: cm[CWD].today, cost_unpriced: cm[CWD].unpricedToday },
    { id: "p", name: "priced", kind: "running", badge: "b", said: "", chips: [], frac: 0.5, meta: "",
      cost: cm[OTHER].today, cost_unpriced: cm[OTHER].unpricedToday },
    { id: "z", name: "only-unpriced", kind: "running", badge: "b", said: "", chips: [], frac: 0.5, meta: "",
      cost: 0, cost_unpriced: ["claude-test-9-9"] },
  ], quiet: "" });
  const uout = els.rows.innerHTML;
  checks.push(["unpriced: the row's dollars carry a + marker", uout.includes(">$0.11+<")]);
  checks.push(["unpriced: ...and a title naming the model",
    /class="cost"[^>]*title="[^"]*no price for claude-test-9-9[^"]*">\$0\.11\+</.test(uout)]);
  checks.push(["unpriced: a priced row has no marker", uout.includes(">$2.00<")]);
  checks.push(["unpriced: $0 of only-unpriced usage still shows, as a floor", uout.includes(">$0.00+<")]);

  // The status line, on usage billing, where it shows dollars.
  // The whole line: on usage billing it is the month line, then any cache segment.
  const sl = py([STATUSLINE], { input: "{}", env: { ...env, CMUX_WORKSPACE_ID: "" } });
  checks.push(["unpriced: the status line's month figure carries a +", /\$0\.11\+ this month/.test(sl)]);

  // /usage: every dollar figure in usage_data carries its own list, and all
  // five of its ccusage calls (four reports plus costs.py) get the override.
  // (The fake answers the same either way; it is the argv being checked.)
  fs.writeFileSync(join(local, "ccusage-pricing.json"), JSON.stringify({ defaults: { pricingOverrides: {
    "claude-test-9-9": { inputCostPerToken: 1e-6 } } } }));
  fs.mkdirSync(join(home, ".cache", "cmux-crew"), { recursive: true });
  fs.writeFileSync(join(home, ".cache", "cmux-crew", "board-targets.json"),
    JSON.stringify({ w1: { cwd: CWD, name: "fx-ws" } }));
  let ud = {};
  try {
    ud = JSON.parse(runTool("crew-board-intent", ["--usage-json"], { env }));
  } catch (e) { console.log("  --   usage_data run failed: " + String(e.message).split("\n")[0]); }
  const U = '["claude-test-9-9"]';
  checks.push(["unpriced: /usage day, week and month each name the model",
    JSON.stringify(ud.daily?.[0]?.unpriced) === U && JSON.stringify(ud.week?.unpriced) === U &&
    JSON.stringify(ud.month?.unpriced) === U]);
  checks.push(["unpriced: ...and so does the per-workspace card",
    JSON.stringify(ud.costs?.[0]?.unpricedToday) === U]);
  checks.push(["pricing: /usage passes the --config to every ccusage call", (() => {
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").slice(-5);
    return ["blocks", "daily", "weekly", "monthly", "--instances"].every((c) =>
      lines.some((l) => l.includes(c) && l.includes("--config")));
  })()]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- the Wake's page: store text reaches the DOM escaped -------------------
// artifacts.tmpl.html's script, run against a stub DOM and a stub fetch whose
// rows carry markup in every free-text field. What reaches innerHTML must be
// text. Also: one header per prompt, states on rows, open by id, no emoji.
{
  const fs = await import("node:fs");
  const html = fs.readFileSync(join(HERE, "artifacts.tmpl.html"), "utf8");
  const script = (html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/) || [])[1] || "";
  const els = {};
  const el = id => els[id] || (els[id] = {
    id, innerHTML: "", value: "", hidden: true, attrs: {},
    textContent: id === "boot" ? JSON.stringify({ t: "tok", ws: "/w/a" }) : "",
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
    addEventListener() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    focus() {}, blur() {}, select() {} });
  const evil = "</span><img src=x onerror=alert(1)>";
  const now = new Date().toISOString();
  const row = (o) => ({ id: 1, kind: "temp", title: "t", path: "", was_path: "", url: "", sha: "", created_at: now,
    session_id: "s1", branch: "main", prompt: "p", source: "", locator: "", state: "ok", published: false, ws: "/w/a", ...o });
  const rows = [
    row({ id: 1, title: evil, path: "/tmp/" + evil, branch: evil, prompt: evil + " first", state: "risk" }),
    row({ id: 2, title: "b.txt", path: "/tmp/b.txt", prompt: evil + " first", state: "gone" }),
    row({ id: 3, kind: "doc", title: "c.md", path: "/w/a/c.md", prompt: "second", state: "kept", was_path: "/tmp/" + evil }),
  ];
  const fetched = [];
  const ctx = createContext({
    document: { getElementById: el, addEventListener() {}, title: "", activeElement: null, visibilityState: "visible",
                querySelectorAll: () => [], body: { appendChild() {}, removeChild() {} } },
    fetch: u => { fetched.push(u); return Promise.resolve({ json: () => Promise.resolve(
      { ws: "/w/a", rows, workspaces: [{ ws: "/w/a", n: 3, last: now, name: "a", here: true }] }) }); },
    setInterval() {}, setTimeout, clearTimeout, history: { replaceState() {} }, navigator: {} });
  let ran = true;
  try { runInContext(script, ctx); } catch (e) { ran = false; console.log("  --   wake page script threw: " + e.message); }
  await new Promise(r => setTimeout(r, 30));
  const all = Object.values(els).map(e => e.innerHTML).join("\n");
  checks.push(["wake page: the script runs and asks for rows with its token and workspace",
    ran && (fetched[0] || "").startsWith("/artifacts/data?t=tok&ws=%2Fw%2Fa")]);
  checks.push(["wake page: titles, paths, prompts and branches reach the DOM as text",
    all.includes("&lt;img src=x") && !/<img\b/.test(all) && !all.includes("</span><img")]);
  checks.push(["wake page: a prompt is said once for the rows it produced",
    (els.list.innerHTML.match(/class="ph"/g) || []).length === 2]);
  checks.push(["wake page: rows carry their state, and a kept row says where it was",
    /class="row risk/.test(els.list.innerHTML) && /class="row gone/.test(els.list.innerHTML) &&
    /class="row kept/.test(els.list.innerHTML) && els.list.innerHTML.includes("<i>was</i><span><bdi>/tmp/&lt;/span&gt;")]);
  checks.push(["wake page: open sends a row id and never a path",
    /"\/artifacts\/open\?t=" \+ encodeURIComponent\(T\) \+ "&id=" \+ r\.id/.test(html) && !/[?&]path=/.test(html)]);
  checks.push(["wake page: an at-risk row offers Keep, and keep all counts them",
    /data-act="keep"/.test(els.list.innerHTML) && els.keepall.hidden === false && els.keepall.textContent === "keep all 1"]);
  checks.push(["wake page: keep posts a row id or the workspace, never a path",
    html.includes('post("/artifacts/keep", {id: r.id})') && html.includes('post("/artifacts/keep", {ws: WS, all: true})')]);
  checks.push(["wake page: publish asks first, naming the file, then posts the row id",
    html.includes('"send " + r.path.split("/").pop() + " to claude.ai?"') && html.includes('post("/artifacts/publish", {id: r.id})')]);
  checks.push(["wake page: every icon is an inline SVG, no emoji",
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html)]);
  checks.push(["wake page: reduced motion stills the crab",
    /@media \(prefers-reduced-motion: reduce\)\{\s*\.crab \*/.test(html)]);
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
  const r = JSON.parse(runTool("judgments.py", ["--apply", fixture], { env }));
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
  runTool("judgments.py", ["--record", "/w/a", "111", "0.9"], { env, input: JSON.stringify({ stuck: 0.7, urgency: 2.0 }) });
  runTool("judgments.py", ["--record", "/w/b", "222"], { env, input: JSON.stringify({ stuck: 0.1, urgency: 0.5 }) });
  const cache = JSON.parse(fs.readFileSync(join(tmp, "j.json"), "utf8"));
  checks.push(["judgments: record keeps other worktrees' entries",
    cache["/w/a"]?.stuck === 0.7 && cache["/w/b"]?.urgency === 0.5]);
  checks.push(["judgments: blocked rides as an arg, size as an int",
    cache["/w/a"]?.blocked === 0.9 && cache["/w/a"]?.transcript_size === 111]);
  // Turn-ends in the same instant: each writer must see the others' entries.
  // Sixteen writers started together, each its own process as asked.sh runs it.
  const { spawn: spawnJ } = await import("node:child_process");
  const [jcmd, ...jpre] = tool("judgments.py");
  await Promise.all([...Array(16).keys()].map(i => new Promise(res => {
    const c = spawnJ(jcmd, [...jpre, "--record", "/w/r" + i, String(i)], { env: toolEnv(env), stdio: ["pipe", "ignore", "ignore"] });
    c.on("exit", res);
    c.stdin.end(JSON.stringify({ stuck: 0.1 }));
  })));
  const raced = String(Object.keys(JSON.parse(fs.readFileSync(join(tmp, "j.json"), "utf8")))
    .filter(k => k.startsWith("/w/r")).length);
  checks.push(["judgments: concurrent records all survive", raced === "16"]);
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

// ---- intent.js: what a click on a family child sends ----------------------
// intent.js runs against a small fake DOM shaped like render.js's family card:
// a parent row holding two children, one with an inline filled button. Every
// fetch it makes is recorded, which is the whole of what a click does.
{
  const mkEl = (tag, attrs = {}, kids = [], text = "") => {
    const el = {
      tagName: tag.toUpperCase(), attrs: { ...attrs }, children: [], parentElement: null, text,
      listeners: [],
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      hasAttribute(k) { return k in this.attrs; },
      get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); },
      set textContent(v) { this.text = v; this.children = []; },
      get classList() {
        const self = this;
        const list = () => (self.attrs.class || "").split(/\s+/).filter(Boolean);
        return {
          contains: (c) => list().includes(c),
          add: (c) => { if (!list().includes(c)) self.attrs.class = [...list(), c].join(" "); },
          remove: (c) => { self.attrs.class = list().filter((x) => x !== c).join(" "); },
        };
      },
      matches(sel) {
        return sel.split(",").map((x) => x.trim()).some((one) =>
          one.startsWith(".") ? this.classList.contains(one.slice(1)) :
          one.startsWith("[") ? this.hasAttribute(one.slice(1, -1)) :
          one.startsWith("#") ? this.attrs.id === one.slice(1) : this.tagName === one.toUpperCase());
      },
      closest(sel) { for (let e = this; e; e = e.parentElement) if (e.matches(sel)) return e; return null; },
      addEventListener(type, fn) { this.listeners.push(fn); },
      appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    };
    kids.forEach((k) => el.appendChild(k));
    return el;
  };
  const span = (cls, text = "", attrs = {}) => mkEl("span", { class: cls, ...attrs }, [], text);
  // Every row has a rail; one with a workspace makes it the jump, and the
  // click lands on the arrow inside it.
  const railOf = (on = true) => on ? mkEl("span", { class: "jmp", "data-a": "jump" }, [mkEl("svg")]) : span("jmp");
  const goA = span("chip pri", "go 2");
  const hdA = mkEl("div", { class: "top kidhd loud", "data-a": "fold" }, [span("caret"), span("nm", "A"), goA]);
  const diffA = span("chip", "diff");
  const saidA = mkEl("p", { class: "said" }, [], "Inc 2 needs you");
  // A delegated child's go, as crew-board labels it: still a go a person can press.
  const ownA = span("chip", "parent goes \u00b7 inc 3", { title: "parent goes \u00b7 inc 3" });
  const bodyA = mkEl("div", { class: "kbody" }, [saidA, mkEl("div", { class: "chips" }, [span("chip pri", "go 2"), diffA, ownA])]);
  const railA = railOf();
  const kidA = mkEl("div", { class: "row attend fam kid fd", "data-id": "A", "data-k": "attend", "data-in": "P" }, [railA, hdA, bodyA]);
  const hdW = mkEl("div", { class: "top kidhd", "data-a": "fold" }, [span("caret"), span("nm", "W")]);
  // A plan child with no workspace: its rail is colour only.
  const hdN = mkEl("div", { class: "top kidhd", "data-a": "fold" }, [span("caret"), span("nm", "N")]);
  const railN = railOf(false);
  const kidN = mkEl("div", { class: "row quiet fam kid fd", "data-id": "N", "data-k": "quiet", "data-in": "P" }, [railN, hdN]);
  const kidW = mkEl("div", { class: "row running fam kid fd", "data-id": "W", "data-k": "running", "data-in": "P" }, [railOf(), hdW]);
  const jumpP = span("chip", "jump");
  // The Wake's icon, as render.js draws it: the click lands on the svg inside.
  const wakeSvg = mkEl("svg", { "aria-hidden": "true" });
  const wakeP = mkEl("span", { class: "wk", "data-a": "wake" }, [wakeSvg]);
  const hdP = mkEl("div", { class: "top", "data-a": "fold" }, [span("caret"), span("nm", "P")]);
  const saidP = mkEl("p", { class: "said" }, [], "Mid-turn.");
  const card = mkEl("div", { class: "row running fam fd open", "data-id": "P", "data-k": "running" },
    [railOf(), hdP, mkEl("div", { class: "fold" }, [saidP, mkEl("div", { class: "chips" }, [jumpP]),
     mkEl("div", { class: "foot" }, [wakeP]), mkEl("div", { class: "kids" }, [kidA, kidW, kidN])])]);
  const host = mkEl("div", { id: "rows", "data-fold": "{}" }, [card]);
  const oldCss = mkEl("style", { id: "intent-css" }, [], ".chip{cursor:pointer}");
  const head = mkEl("head", {}, [oldCss]);
  // A page an older handler already wired: its stamp listener has no version
  // check, so it will act on every click whatever version is installed.
  const stampEl = mkEl("span", { id: "stamp", "data-intent": "3" });
  stampEl.listeners.push(() => fetched.push("http://127.0.0.1:4242/do?t=t&a=sync&r=-&x="));
  const byId = { rows: host, "intent-css": oldCss, stamp: stampEl };
  const fetched = [];
  const doc = {
    head,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => mkEl(tag),
  };
  const box = {
    document: doc, JSON, Math, encodeURIComponent,
    setTimeout: () => 0,
    fetch: (url) => { fetched.push(url); return Promise.resolve({ json: () => ({ ok: true }) }); },
  };
  createContext(box);
  runInContext(readFileSync(join(HERE, "intent.js"), "utf8"), box);
  box.__boardIntent({ port: 4242, token: "t" });
  box.__boardIntent({ port: 4242, token: "t" });     // a second push: still one listener acting
  const click = (el) => {
    const ev = { target: el, preventDefault() {}, stopPropagation() {} };
    host.listeners.forEach((fn) => fn(ev));
  };
  const q = (u) => Object.fromEntries(new URL(u).searchParams);
  const last = () => q(fetched[fetched.length - 1]);

  checks.push(["intent: an older page's click CSS is replaced on upgrade",
    oldCss.getAttribute("data-v") === "10" && oldCss.textContent.includes(".kids>.row.kid:not(.inert):hover")]);
  checks.push(["intent: a delegated child's go chip is muted, never filled or breathing",
    /\.row \.chip\.chip\[title\^="parent goes"\]\{[^}]*background:transparent[^}]*animation:none/.test(oldCss.textContent)]);
  const fold = () => JSON.parse(host.getAttribute("data-fold"));

  click(hdA.children[1]);                            // the name, inside the header
  checks.push(["intent: a child's header unfolds it in place, and sends nothing",
    fetched.length === 0 && kidA.classList.contains("open") && JSON.stringify(fold()) === '{"A":[1,"attend"]}']);
  click(hdA);
  checks.push(["intent: ...and folds it again, remembering the choice and its tier",
    fetched.length === 0 && !kidA.classList.contains("open") && JSON.stringify(fold()) === '{"A":[0,"attend"]}']);
  click(goA);
  checks.push(["intent: a child's inline button fires its own verb for the child, not the fold",
    fetched.length === 1 && last().a === "go" && last().x === "2" && last().r === "A" &&
    !kidA.classList.contains("open")]);
  click(railA.children[0]);
  checks.push(["intent: the rail jumps to the child's workspace, folded",
    fetched.length === 2 && last().a === "jump" && last().r === "A" && !kidA.classList.contains("open")]);
  click(kidA);
  checks.push(["intent: a click anywhere on a folded child unfolds it",
    fetched.length === 2 && kidA.classList.contains("open")]);
  click(saidA);
  checks.push(["intent: a click on an unfolded child's body selects its workspace",
    fetched.length === 3 && last().a === "row" && last().r === "A"]);
  click(railA);
  checks.push(["intent: ...and the rail still jumps, unfolded",
    fetched.length === 4 && last().a === "jump" && last().r === "A" && kidA.classList.contains("open")]);
  click(diffA);
  checks.push(["intent: a chip inside an opened child fires with the child's row id",
    fetched.length === 5 && last().a === "diff" && last().r === "A"]);
  click(ownA);
  checks.push(["intent: 'parent goes · inc N' is still a go a person can give, for the child",
    fetched.length === 6 && last().a === "go" && last().x === "3" && last().r === "A"]);
  fetched.pop();
  click(jumpP);
  checks.push(["intent: the parent's own chips still fire for the parent",
    fetched.length === 6 && last().a === "jump" && last().r === "P"]);
  click(wakeSvg);
  checks.push(["wake: a click on the icon sends a=wake for its row",
    fetched.length === 7 && last().a === "wake" && last().r === "P"]);
  click(saidP);
  checks.push(["intent: an unfolded card's body selects its workspace",
    fetched.length === 8 && last().a === "row" && last().r === "P"]);
  click(hdP);
  checks.push(["intent: a card's header folds it, and sends nothing",
    fetched.length === 8 && !card.classList.contains("open") && fold().P[0] === 0]);
  click(saidP);
  checks.push(["intent: a click on a folded card unfolds it instead of selecting",
    fetched.length === 8 && card.classList.contains("open") && fold().P[0] === 1]);
  click(hdW);
  checks.push(["intent: two children can be open at once",
    kidA.classList.contains("open") && kidW.classList.contains("open") && fold().W[0] === 1]);
  const n0 = fetched.length;
  click(railN); click(hdN);
  checks.push(["intent: a child with no workspace has a rail that sends nothing, and still folds",
    fetched.length === n0 && kidN.classList.contains("open")]);
  stampEl.listeners.forEach((fn) => fn({}));
  checks.push(["intent: an upgrade does not add a second sync listener to the stamp",
    stampEl.listeners.length === 1 && fetched.length === n0 + 1]);
  checks.push(["intent: an inert row keeps its card ground (a shell card is inert)",
    !/\.row\.inert[^{]*\{[^}]*background/.test(oldCss.textContent) && /\.row:not\(\.inert\):hover/.test(oldCss.textContent)]);
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
  const P = (s, ph, allow, fam) => ({ slug: s, root: "/w/" + s, phase: ph, gate: { allow, why: "" },
    progress: { total: 2, done: 0, blocked: [], open: [], next: { n: 1, title: "t" } }, ...(fam ? { family: fam } : {}) });
  const po = stateFrom({ plans: { "/w/x": P("x", "implementing", true),
    "/w/par": P("par", "implementing", true, { parent: "par", role: "parent" }),
    "/w/kid": P("kid", "review", false, { parent: "par", role: "child" }) } })
    .rows.map(r => [r.id, r.kind, r.famtier ?? ""]);
  checks.push(["families: crew-board with cmux down groups plan rows at the family's tier",
    JSON.stringify(po) === JSON.stringify([["par", "running", "attend"], ["kid", "attend", "attend"], ["x", "running", ""]])]);

  render({ rows: [...g.rows, ...g.quiet], quietCount: g.quiet.length, quiet: "" });
  const html = els.rows.innerHTML;
  // The card that holds a family runs from its opening tag to the next card at
  // the top level; sub-rows are .row too, so "next card" is the next row not
  // marked kid.
  const cardOf = (h, id) => {
    const at = h.indexOf('data-id="' + id + '"');
    const start = h.lastIndexOf('<div class="row ', at);
    const rest = h.slice(at);
    const end = rest.search(/<div class="sect">|<div class="row (?![^"]*\bkid\b)/);
    return h.slice(start, end < 0 ? h.length : at + end);
  };
  const pc = cardOf(html, "p");
  checks.push(["families: the children sit inside the parent's card, each its own .row",
    /class="row done[^"]* fam fd open"[^>]*data-id="p" data-k="attend"/.test(html) &&
    /<div class="fold">[^]*<div class="kids">/.test(pc) &&
    /class="row attend[^"]* fam kid fd"[^>]*data-id="k2" data-k="attend" title="k2" data-in="p"/.test(pc) &&
    /class="row quiet[^"]* fam kid fd"[^>]*data-id="k3"[^>]*data-in="p"/.test(pc)]);
  checks.push(["families: the parent's badge rolls up its children",
    /<span class="badge roll attend">1 needs you<\/span>/.test(pc)]);
  checks.push(["families: the quiet divider counts only rows below it",
    /<div class="sect">quiet · 3<\/div>/.test(html) && html.indexOf('class="sect"') > html.indexOf('data-id="k3"')]);
  const gc = cardOf(html, "fam:G");
  checks.push(["families: a family with no parent row gets a shell card named by its label",
    /<div class="row quiet fam shell inert fd" data-id="fam:G" data-k="quiet" title="G"><span class="jmp"><\/span><div class="top" data-a="fold"><span class="caret"><\/span><span class="nm">G<\/span><span class="pips">.*?<\/span><span class="badge">2 plans<\/span>/.test(html) &&
    /data-id="g1"[^>]*data-in="fam:G"/.test(gc) && /data-id="g2"[^>]*data-in="fam:G"/.test(gc)]);

  // A child is one line until opened. One that needs you or is broken also
  // shows what it said and its first chip, filled, without being opened.
  const fr = (extra = {}) => [
    R("P", "running", { family: "F", famrole: "parent", famkid: false, ref: "w:p", chips: ["diff", "jump"] }),
    R("A", "attend", { family: "F", famrole: "child", famkid: true, ref: "w:a", said: "{{Inc 2}} needs your go-ahead.", chips: ["go 2", "diff", "jump"], branch: "dev/a" }),
    R("W", "running", { family: "F", famrole: "child", famkid: true, ref: "w:w", said: "Mid-turn.", chips: ["diff", "jump"] }),
  ];
  els.rows.attrs["data-fold"] = "{}";
  // A family card folds by the family's tier: a working parent holding a
  // child that needs you starts open, and keys its fold on that tier.
  render({ rows: fr().map((r) => ({ ...r, famtier: "attend" })), quiet: "" });
  checks.push(["fold: a working family card with a child waiting on you starts open",
    /class="row running[^"]* fam fd open"[^>]*data-id="P" data-k="attend"/.test(els.rows.innerHTML)]);
  render({ rows: fr(), quiet: "" });
  const fh = els.rows.innerHTML;
  const kA = cardOf(fh, "A").split('data-id="W"')[0], kW = cardOf(fh, "W");
  checks.push(["families: a child's header is its fold, with a caret, and its rail is the jump",
    /<span class="jmp" data-a="jump"[^>]*><svg[^]*?<\/svg><\/span><div class="top kidhd loud" data-a="fold"><span class="caret"><\/span>/.test(kA) &&
    /<div class="top kidhd" data-a="fold">/.test(kW) && !/data-x="select"/.test(fh)]);
  checks.push(["families: a child that needs you shows its line and its filled button inline",
    /<div class="top kidhd loud"[^]*<span class="chip pri"[^>]*>go 2<\/span><\/div><p class="said nest" data-a="fold">/.test(kA)]);
  checks.push(["families: a working child is one line: no inline button, no line",
    !/kidhd[^]*chip[^]*<\/div><div class="kbody"/.test(kW.split('<div class="kbody">')[0] + '<div class="kbody">') &&
    !kW.includes("said nest")]);
  checks.push(["families: every child carries its full card, closed",
    /<div class="kbody"><p class="said">/.test(kA) && /class="chip pri"[^>]*>go 2<\/span><span class="chip"/.test(kA.split('<div class="kbody">')[1]) &&
    /class="branch" data-a="code"/.test(kA) && !/ open"/.test(fh)]);
  // What was folded by hand survives a push, and loses ids that left the board.
  els.rows.attrs["data-fold"] = JSON.stringify({ W: [1, "running"], gone: [1, "quiet"] });
  render({ rows: fr(), quiet: "" });
  checks.push(["families: an opened child is still open after the next push",
    /class="row running[^"]* fam kid fd open"[^>]*data-id="W"/.test(els.rows.innerHTML) &&
    !/kid fd open"[^>]*data-id="A"/.test(els.rows.innerHTML)]);
  checks.push(["families: ...and the fold map forgets ids that left the board",
    els.rows.attrs["data-fold"] === '{"W":[1,"running"]}']);
  // A choice is for the tier it was made in: W turning broken drops it.
  render({ rows: fr().map((r) => r.id === "W" ? { ...r, kind: "wilt" } : r), quiet: "" });
  checks.push(["fold: a card that changes tier drops its fold choice",
    !/kid fd open"[^>]*data-id="W"/.test(els.rows.innerHTML) && els.rows.attrs["data-fold"] === "{}"]);
  els.rows.attrs["data-fold"] = "{}";
  render({ rows: [R("P2", "running", { family: "H", famrole: "parent", famkid: false, ref: "w" }),
    R("X", "wilt", { family: "H", famrole: "child", famkid: true, ref: "x", chips: ["checks"] }),
    R("Y", "wilt", { family: "H", famrole: "child", famkid: true, ref: "y", chips: ["jump"] })], quiet: "" });
  checks.push(["families: with nothing waiting, the rollup counts the broken",
    els.rows.innerHTML.includes('<span class="badge roll wilt">2 broken</span>')]);
  render({ rows: [R("P3", "running", { family: "J", famrole: "parent", famkid: false, ref: "w", badge: "working" }),
    R("Z", "running", { family: "J", famrole: "child", famkid: true, ref: "z" })], quiet: "" });
  render({ rows: [R("P4", "attend", { family: "K", famrole: "parent", famkid: false, ref: "w", badge: "gate shut" }),
    R("V", "wilt", { family: "K", famrole: "child", famkid: true, ref: "v" })], quiet: "" });
  checks.push(["families: a parent that needs you keeps saying so over a broken child",
    /data-id="P4"[^]*?<span class="badge">gate shut<\/span>/.test(els.rows.innerHTML) && !els.rows.innerHTML.includes("roll")]);
  render({ rows: [R("P5", "running", { family: "L", famrole: "parent", famkid: false, ref: "w" }),
    R("NR", "quiet", { family: "L", famrole: "child", famkid: true, slug: "nr" })], quiet: "" });
  checks.push(["families: a child with no workspace ref gets a colour-only rail, and still folds",
    /data-id="NR"[^>]*><span class="jmp"><\/span><div class="top kidhd" data-a="fold"><span class="caret">/.test(els.rows.innerHTML)]);
  render({ rows: [R("P3", "running", { family: "J", famrole: "parent", famkid: false, ref: "w", badge: "working" }),
    R("Z", "running", { family: "J", famrole: "child", famkid: true, ref: "z" })], quiet: "" });
  checks.push(["families: with nothing to report, the parent keeps its own badge",
    /data-id="P3"[^]*?<span class="badge">working<\/span>/.test(els.rows.innerHTML) && !els.rows.innerHTML.includes("roll")]);

  // The FLIP on nested rows. A whole family climbs: the card slides, and its
  // child -- carried by the card -- must not slide the same distance again.
  // Then the child moves inside a card that stayed put: only the child slides.
  const fam2 = (order) => ({ rows: order.map((id) => id === "P"
    ? R("P", "running", { family: "F", famrole: "parent", famkid: false, ref: "w:p" })
    : id === "K" ? R("K", "running", { family: "F", famrole: "child", famkid: true, ref: "w:k" })
    : R(id, "running", { ref: "w:" + id })), quiet: "" });
  render(fam2(["o", "P", "K"]));
  STUB_GEO.push({ o: 0, P: 100, K: 140 }, { P: 0, K: 40, o: 200 });
  ANIMS.length = 0;
  render(fam2(["P", "K", "o"]));
  const slid = (id) => ANIMS.filter((a) => a.id === id).map((a) => JSON.stringify(a.frames[0]));
  checks.push(["families: a climbing family slides its card, not its child a second time",
    /translateY\(100px\)/.test(slid("P").join()) && slid("K").length === 0]);
  STUB_GEO.push({ P: 0, K: 40, o: 200 }, { P: 0, K: 70, o: 200 });
  ANIMS.length = 0;
  render(fam2(["P", "K", "o"]));
  checks.push(["families: a child that moved inside a still card slides by its own distance",
    slid("P").length === 0 && /translateY\(-30px\)/.test(slid("K").join())]);
  STUB_GEO.length = 0;
}

// ---- tidy/adopt: a board surface is the one whose URL is board.html ---------
// Not a substring of the tree line: tidy closes every match but the recorded one.
// White-box on purpose, and always against the Python: tree_url_is serves only
// `crew-board tidy`/`open` and crew-board-diag, which stay Python until the
// cutover deletes them with the Dock board (plan port-board).
{
  const tm = JSON.parse(execFileSync("python3", ["-c", `
import importlib.machinery, importlib.util, json, sys
l = importlib.machinery.SourceFileLoader("cb", sys.argv[1])
m = importlib.util.module_from_spec(importlib.util.spec_from_loader("cb", l)); l.exec_module(m)
U = "E80C26CC-48A8-4BB1-A439-65887FA2F457"
L = lambda t, u: '├── surface surface:1 %s [browser] "%s" %s' % (U, t, u)
print(json.dumps([m.tree_url_is(L("crew · who needs you", "file:///h/.config/cmux/crew/board/board.html"), "board.html"),
  m.tree_url_is(L("x", "file:///x/dashboard.html"), "board.html"),
  m.tree_url_is(L("notes on board.html", "https://example.com/a"), "board.html"),
  m.tree_url_is(L("usage", "http://127.0.0.1:7345/usage"), "/usage"),
  m.tree_url_is(L("x", "http://127.0.0.1:7345/plan/usage-dash"), "/usage")]))
`, join(HERE, "crew-board")], { encoding: "utf8" }));
  checks.push(["tidy/adopt: board.html and /usage match by URL, not dashboard.html or a title",
    JSON.stringify(tm) === JSON.stringify([true, false, false, true, false])]);

  // crew-board-diag carries its own copy (it must run when crew-board is
  // broken), so its duplicate count is one tidy can clear. Same code, and a
  // dashboard.html tab is not counted.
  const dm = JSON.parse(execFileSync("python3", ["-c", `
import ast, json, re, sys
def fn(path):
    for n in ast.walk(ast.parse(open(path).read())):
        if isinstance(n, ast.FunctionDef) and n.name == "tree_url_is":
            n.body = [b for b in n.body if not (isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant))]
            return n
d, b = fn(sys.argv[1]), fn(sys.argv[2])
if not (d and b):
    print(json.dumps([False, -1])); sys.exit()
ns = {"re": re}
exec(compile(ast.fix_missing_locations(ast.Module(body=[d], type_ignores=[])), "diag", "exec"), ns)
U = "E80C26CC-48A8-4BB1-A439-65887FA2F457"
L = lambda t, u: '├── surface surface:%s %s [browser] "%s" %s' % (t, U, t, u)
tree = "\\n".join([L("1", "file:///h/crew/board/board.html"), L("2", "file:///x/dashboard.html"), L("board.html", "https://e.com/a")])
print(json.dumps([ast.dump(d) == ast.dump(b), sum(ns["tree_url_is"](l, "board.html") for l in tree.splitlines())]))
`, join(HERE, "crew-board-diag"), join(HERE, "crew-board")], { encoding: "utf8" }));
  checks.push(["diag: counts board surfaces with crew-board's own tree_url_is, not dashboard.html",
    JSON.stringify(dm) === JSON.stringify([true, 1])]);
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
    return JSON.parse(runTool("news.py", ["--compose", f]));
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
  const del = compose([
    R("ft-parent", "running", "working", { family: "ft-parent", famrole: "parent", famgo: "human", famtier: "attend" }),
    R("ft-kid", "attend", "gate shut", { subject: "Retry sweep", family: "ft-parent", famrole: "child", famgo: "parent", famtier: "attend" }),
    R("ft-own", "attend", "gate shut", { subject: "Own go", family: "ft-parent", famrole: "child", famgo: "human", famtier: "attend" }),
  ]);
  checks.push(["news: a delegated child at a shut gate waits on its parent, as its card says",
    del.items[0].text.includes("{{ft-kid}} waits on its go from the parent, ft-parent, for Retry sweep") &&
    del.items[0].text.includes("{{ft-own}} needs your go-ahead on Own go") && !/ft-kid\}\} needs your go-ahead/.test(del.items[0].text)]);
  const empty = compose([]);
  checks.push(["news: no rows give no items and an empty lede",
    empty.items.length === 0 && empty.lede === "" && empty.hours === 5]);
  checks.push(["news: a narrower window drops older commits",
    /1 commit in the last 0.5h/.test(compose([R("b", "running", "working",
      { commits: [{ at: NOW - 600, s: "a" }, { at: NOW - 3600, s: "b" }] })], 0.5).items[0].text)]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- the fast pass reads what the full pass cached --------------------------
// The 15s board tick is affordable only because a fast build skips the
// per-workspace sidebar-state call and reads branch/PR/live-turn from a cache
// (2104ms -> 136ms measured). That is a correctness risk, not just a speed
// trick: if the cache and the full read disagree, the board quietly shows the
// wrong branch. Compared on a fixed fakecmux, not the live machine: two live
// builds seconds apart race every agent and plan that moves between them.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "board-fast-"));
  const fake = join(tmp, "fake"), home = join(tmp, "home"), wt = join(tmp, "wt");
  [fake, home, wt].forEach(d => fs.mkdirSync(d));
  fs.writeFileSync(join(fake, "workspaces.json"), JSON.stringify([
    { id: "W-A", ref: "workspace:1", title: "busy", current_directory: wt, claude: "Running", git_branch: "dev/a clean",
      pr: "#41 open https://github.com/o/r/pull/41", description: "ci:pass" },
    { id: "W-B", ref: "workspace:2", title: "merged", current_directory: wt, git_branch: "dev/b dirty", description: "gone:merged" },
    { id: "W-C", ref: "workspace:3", title: "idle", current_directory: wt, git_branch: "main clean" },
  ]));
  const env = { ...process.env, HOME: home, CREW_CMUX: join(HERE, "..", "tools", "fakecmux.py"), FAKE_CMUX_DIR: fake,
    PATH: "/usr/bin:/bin:" + dirname(process.execPath) };
  const build = (...a) => JSON.parse(runTool("crew-board", ["state", "--json", ...a], { env }));
  const full = build();
  fs.writeFileSync(join(fake, "cmux.log"), "");
  const fast = build("--fast");
  const calls = fs.readFileSync(join(fake, "cmux.log"), "utf8");
  const key = (d) => JSON.stringify((d.rows || []).map((r) =>
    [r.id, r.kind, r.branch, r.pr, r.pr_url, r.dirty, r.meta, r.chips]));
  checks.push(["a fast build agrees with a full build", key(fast) === key(full) && full.rows.length === 3 &&
    full.rows.find(r => r.id === "W-A").pr_url === "https://github.com/o/r/pull/41", key(full) + "\n" + key(fast)]);
  checks.push(["a fast build carries the same news as a full build", JSON.stringify(fast.news) === JSON.stringify(full.news)]);
  checks.push(["...and asks cmux only for the list, not sidebar-state", !/sidebar-state/.test(calls) && /workspace list/.test(calls), calls]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- parity: the Rust prints the Python's bytes ---------------------------
// Under CREW_IMPL=rust, news and judgments run as seamux everywhere above. Here
// both implementations get the same fixtures (every badge, families, commit
// windows, odd types, non-ASCII) and their stdout must match byte for byte.
if (crewImpl.isRust("news") || crewImpl.isRust("judgments")) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "board-parity-"));
  const both = (name, args, opts = {}) => {
    const py = execFileSync("python3", [join(HERE, name + ".py"), ...args], { encoding: "utf8", ...opts });
    const [cmd, ...pre] = crewImpl.argv(name, join(HERE, name + ".py"), "python3");
    const rs = execFileSync(cmd, [...pre, ...args], { encoding: "utf8", ...opts, env: toolEnv(opts.env || process.env) });
    return [py, rs];
  };
  const NOW = 1790000000.25;
  const badges = ["asked you", "review", "gate shut", "ci failed", "check failed", "conflicts", "changes",
    "blocked", "stuck", "working", "merged", "plan done", "something else", ""];
  const rows = badges.flatMap((b, i) => [
    { id: "b" + i, name: "név {{" + i + "}}", kind: i % 3 ? "attend" : "running", badge: b,
      subject: i % 2 ? "the `thing` " + i : "", branch: i % 2 ? "dev/x" + i : "",
      meta: i % 4 ? `${i}/${i + 3} increments · s` : (i ? "0/0 increments" : ""),
      commits: i % 3 ? [{ at: NOW - 60 * i, s: "c" + i + " ✓" }, { at: String(NOW - 7200), s: "str-at" }, { at: null }, "junk"] : [] },
  ]).concat([
    { id: 7, kind: "quiet", commits: [{ at: NOW - 5, s: "x".repeat(90) }] },
    { name: "", id: "", kind: "quiet" },
    { id: "f1", name: "par", kind: "running", badge: "working", family: "Fam", famtier: "attend", famrole: "parent" },
    { id: "f2", name: "kid", kind: "attend", badge: "review", family: "Fam", meta: "0/1 increments" },
    { id: "f3", name: "idle", kind: "quiet", family: "Fam" },
    { id: "g1", name: "q", kind: "quiet", family: "G2" },
    { id: "d1", name: "dp", kind: "running", badge: "working", family: "Del", famrole: "parent", famgo: "human" },
    { id: "d2", name: "dk", kind: "attend", badge: "gate shut", subject: "Retry `sweep`", family: "Del", famrole: "child", famgo: "parent" },
    { id: "d3", name: "dk2", kind: "attend", badge: "gate shut", family: "Del", famgo: "parent" },
  ]);
  const cases = [{ rows, now: NOW, hours: 5 }, { rows, now: NOW, hours: 0.25 }, { rows: [], now: NOW, hours: 2.5 },
    { rows: rows.slice(0, 3), now: NOW }];
  const newsSame = cases.every((fx, i) => {
    const f = join(tmp, `news${i}.json`);
    fs.writeFileSync(f, JSON.stringify(fx));
    const [py, rs] = both("news", ["--compose", f], { env: { ...process.env, CREW_NEWS_HOURS: "3" } });
    if (py !== rs) console.log(`  --   news case ${i}\n       py ${py.slice(0, 300)}\n       rs ${rs.slice(0, 300)}`);
    return py === rs;
  });
  checks.push(["parity: news --compose prints the Python's bytes, every badge and family", newsSame]);
  const jfx = join(tmp, "j.json");
  fs.writeFileSync(jfx, JSON.stringify({ now: NOW, threshold: 0.5,
    workspaces: [{ cwd: "/w/a" }, { cwd: "/w/b", running: true }, { cwd: "/w/c" }, { cwd: "/w/d" }, { cwd: "/w/e" }, {}],
    cache: { "/w/a": { at: NOW - 10, stuck: 0.5, urgency: 2 }, "/w/b": { at: NOW - 10, stuck: 0.9 },
      "/w/c": { at: NOW - 999999, stuck: 1 }, "/w/d": { at: String(NOW), stuck: "0.75", urgency: "1e1" },
      "/w/e": { at: NOW, stuck: "nope", urgency: [] } } }));
  const [jp, jr] = both("judgments", ["--apply", jfx]);
  checks.push(["parity: judgments --apply prints the Python's bytes", jp === jr, jp + " | " + jr]);
  // The writer: the same records into two caches, read back as bytes (times aside).
  const rec = (impl, file) => {
    const env = { ...process.env, CREW_JUDGMENTS_FILE: file };
    for (const [cwd, size, extra, vals] of [["/w/a", "12", "0.4", { stuck: 0.25, urgency: "3" }], ["/w/b", "", null, {}],
      ["/w/ü", "7", "x", { blocked: 1, stuck: true }]]) {
      const args = ["--record", cwd, size, ...(extra == null ? [] : [extra])];
      if (impl === "py") execFileSync("python3", [join(HERE, "judgments.py"), ...args], { input: JSON.stringify(vals), env });
      else { const [cmd, ...pre] = crewImpl.argv("judgments", join(HERE, "judgments.py"), "python3");
        execFileSync(cmd, [...pre, ...args], { input: JSON.stringify(vals), env: toolEnv(env) }); }
    }
    return fs.readFileSync(file, "utf8").replace(/"at": [0-9.e+]+/g, '"at": T');
  };
  const rp = rec("py", join(tmp, "jp.json")), rr = rec("rs", join(tmp, "jr.json"));
  checks.push(["parity: judgments --record writes the Python's cache", rp === rr, rp + " | " + rr]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- parity: the Rust ranks as the Python does -----------------------------
// One fixture through every tier (asked, review, gate shut, ci failed, check
// failed, blocked, working, merged, plan done, quiet), signals, a family, and
// the cmux-down path without workspaces: both implementations, JSON and text,
// compared byte for byte with the clock line set aside.
if (crewImpl.isRust("crew-board")) {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(join(os.tmpdir(), "board-rank-parity-"));
  const FX = {"plans": {"/w/f": {"slug": "f", "root": "/w/f", "phase": "implementing", "gate": {"allow": true, "why": ""}, "progress": {"total": 3, "done": 1, "blocked": [], "open": [{"n": 2, "title": "t"}], "next": null}, "checksOutstanding": [{"n": 2, "id": "test-a", "kind": "test", "status": "fail"}]}, "/w/g": {"slug": "g", "root": "/w/g", "phase": "implementing", "gate": {"allow": false, "why": "Alignment check not taken."}, "progress": {"total": 4, "done": 2, "blocked": [], "open": [], "next": {"n": 3, "title": "Gate me"}}, "family": {"parent": "g", "role": "parent", "go": "human", "holds": {"k": "wait for the schema", "b": "a second"}}}, "/w/k": {"slug": "k", "root": "/w/k", "phase": "implementing", "gate": {"allow": false, "why": "Its go is the parent's to give (g)."}, "progress": {"total": 2, "done": 0, "blocked": [], "open": [], "next": {"n": 1, "title": "Owned"}}, "family": {"parent": "g", "role": "child", "go": "parent", "holds": {}}}, "/w/r": {"slug": "r", "root": "/w/r", "phase": "review", "gate": {"allow": false, "why": ""}, "progress": {"total": 0, "done": 0, "blocked": [], "open": [], "next": null}}, "/w/b": {"slug": "b", "root": "/w/b", "phase": "implementing", "gate": {"allow": true, "why": ""}, "progress": {"total": 2, "done": 0, "blocked": [{"title": "Blk", "note": null}], "open": [], "next": null}, "family": {"parent": "g", "role": "child"}}, "/w/d": {"slug": "d", "root": "/w/d", "phase": "done", "gate": {"allow": true, "why": ""}, "progress": {"total": 2, "done": 2, "blocked": [], "open": [], "next": null}}}, "workspaces": [{"id": "f", "title": "f PROJ-12", "cwd": "/w/f", "desc": "ci:pass review:approved planinc:1/3 plannext:2 planpath:x", "running": true, "branch": "dev/f", "pr": "#5", "dirty": false, "commits": [{"at": 1, "s": "x"}], "pr_url": "https://x/pull/5"}, {"id": "g", "title": "g", "cwd": "/w/g", "desc": "pr:draft jira:in-review", "running": false, "branch": "none", "pr": "none", "dirty": true}, {"id": "r", "title": "r", "cwd": "/w/r", "desc": "phase:waiting feedby:9999999999 feedgate:allow", "running": false, "branch": "", "pr": "none", "dirty": false}, {"id": "b", "title": "b", "cwd": "/w/b", "desc": "", "running": false, "branch": "b", "pr": "none", "dirty": false}, {"id": "c", "title": "c", "cwd": "/w/c", "desc": "ci:fail stack:ready sandbox:running", "running": false, "branch": "none", "pr": "#9", "dirty": false}, {"id": "m", "title": "m", "cwd": "/w/m", "desc": "gone:merged", "running": false, "branch": "m", "pr": "none", "dirty": false}, {"id": "d", "title": "d", "cwd": "/w/d", "desc": "", "running": false, "branch": "d", "pr": "none", "dirty": false}, {"id": "k", "title": "k", "cwd": "/w/k", "desc": "plannext:1", "running": false, "branch": "k", "pr": "none", "dirty": false}, {"id": "q", "title": "quiet one", "cwd": "/w/q", "desc": "", "running": false, "branch": "q", "pr": "#3", "dirty": true, "pr_state": "open", "color": "#123456", "selected": true}]};
  const noPlans = { plans: FX.plans };
  const out = (impl, fx, json) => {
    const f = join(tmp, "fx.json");
    fs.writeFileSync(f, JSON.stringify(fx));
    const args = ["state", ...(json ? ["--json"] : []), "--fixture", f];
    const [cmd, ...pre] = impl === "py" ? [join(HERE, "crew-board")] : crewImpl.argv("crew-board", join(HERE, "crew-board"));
    return execFileSync(cmd, [...pre, ...args], { encoding: "utf8", env: toolEnv(process.env) })
      .replace(/"stamp": "[0-9:]+"/, '"stamp": "T"').replace(/^\d\d:\d\d:\d\d · /, "T · ");
  };
  const same = (fx, json) => { const p = out("py", fx, json), r = out("rs", fx, json);
    if (p !== r) console.log(`  --   rank parity (${json ? "json" : "text"})\n       py ${p.slice(0, 400)}\n       rs ${r.slice(0, 400)}`);
    return p === r; };
  checks.push(["parity: state --json ranks every tier as the Python does", same(FX, true)]);
  checks.push(["parity: ...and the cmux-down path, from plans alone", same(noPlans, true)]);
  checks.push(["parity: ...and the text listing", same(FX, false) && same(noPlans, false)]);
  // An unknown subcommand prints the docstring and exits 2, on both sides.
  const usage = (argv) => { try { execFileSync(argv[0], [...argv.slice(1), "bogus"], { encoding: "utf8", env: toolEnv(process.env) });
    return "exit 0"; } catch (e) { return `exit ${e.status}\n${e.stdout}`; } };
  const up = usage([join(HERE, "crew-board")]), ur = usage(crewImpl.argv("crew-board", join(HERE, "crew-board")));
  checks.push(["parity: an unknown subcommand prints the same usage and exits 2", up === ur && up.startsWith("exit 2\n")]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- a delegated child: who goes, on both rank paths ------------------------
// status --json's family.go says whose go a child's is. Delegated to the
// parent, the gate-shut chip reads 'parent goes · inc N' and the sentence names
// the parent; anyone else keeps `go N`. A parent row lists its written holds.
{
  const P = (s, allow, fam) => ({ slug: s, root: "/w/" + s, phase: "implementing",
    gate: { allow, why: allow ? "" : "No increment is authorized." },
    progress: { total: 3, done: 1, blocked: [], open: allow ? [{ n: 2, title: "t" }] : [], next: { n: 2, title: "Wire it" } },
    family: { parent: "par", holds: {}, ...fam } });
  const pb = { "/w/par": P("par", true, { role: "parent", go: "human", holds: { kid: "wait for the schema" } }),
    "/w/kid": P("kid", false, { role: "child", go: "parent" }),
    "/w/own": P("own", false, { role: "child", go: "human" }) };
  const W = (s, desc = "") => ({ id: s, title: s, cwd: "/w/" + s, desc, running: false,
    branch: "none", pr: "none", dirty: false });
  const live = Object.fromEntries(stateFrom({ plans: pb, workspaces: [W("par"), W("kid", "plannext:2"), W("own")] })
    .rows.map(r => [r.id, r]));
  const off = Object.fromEntries(stateFrom({ plans: pb }).rows.map(r => [r.id, r]));
  for (const [path, rows] of [["", live], [" (cmux down)", off]]) {
    checks.push(["delegated: a child whose go is the parent's offers 'parent goes · inc 2'" + path,
      rows.kid.chips[0] === "parent goes \u00b7 inc 2" && rows.kid.badge === "gate shut"]);
    checks.push(["delegated: ...and says the parent is expected to give it, and you still can" + path,
      rows.kid.said === "{{Wire it}} waits on its go from the parent, par. You can still give it."]);
    checks.push(["delegated: a child whose go is a person's keeps `go 2`" + path,
      rows.own.chips[0] === "go 2" && rows.own.said.startsWith("{{Wire it}} needs your go-ahead.")]);
    checks.push(["delegated: the parent row shows the hold it wrote" + path,
      rows.par.meta.includes("held kid: wait for the schema") && !rows.kid.meta.includes("held")]);
  }
  checks.push(["delegated: the plannext signal does not repeat the owner chip as a second go",
    !(live.kid.signals || []).some(e => e.a === "go")]);
  render({ rows: [live.kid], quiet: "" });
  checks.push(["delegated: the chip renders titled by its label, which is what mutes it",
    els.rows.innerHTML.includes('title="parent goes \u00b7 inc 2">parent goes \u00b7 inc 2</span>')]);
}

// ---- failed validation ranks wilt, on both rank paths ----------------------
{
  const P = (s, ph, chk) => ({ slug: s, root: "/w/" + s, phase: ph, gate: { allow: true, why: "" },
    progress: { total: 3, done: 1, blocked: [], open: [{ n: 2, title: "t" }], next: null },
    checksOutstanding: chk });
  const pb = { "/w/f": P("f", "implementing", [{ n: 2, id: "test-a", kind: "test", status: "fail" }]),
    "/w/l": P("l", "implementing", [{ n: 2, id: "e2e-b", kind: "e2e", status: "lost" }]),
    "/w/p": P("p", "implementing", [{ n: 2, id: "test-c", kind: "test", status: "pending" }]),
    "/w/d": P("d", "done", [{ n: 3, id: "test-d", kind: "test", status: "fail" }]) };
  const W = (s, running) => ({ id: s, title: s, cwd: "/w/" + s, desc: "", running,
    branch: "none", pr: "none", dirty: false, commits: [{ at: 1, s: "x" }] });
  const all = stateFrom({ plans: pb, workspaces: [W("f", true), W("l", false), W("p", true), W("d", false), W("q", false)] }).rows;
  const po = stateFrom({ plans: pb }).rows;
  const out = {
    rank: Object.fromEntries(all.map(r => [r.id, [r.kind, r.badge, r.subject ?? ""]])),
    plans: Object.fromEntries(po.map(r => [r.id, [r.kind, r.badge]])),
    commits: all.find(r => r.id === "f").commits,
    chips: Object.fromEntries(all.map(r => [r.id, r.chips])),
  };
  checks.push(["checks: a failed check ranks wilt even mid-turn, naming it",
    JSON.stringify(out.rank.f) === JSON.stringify(["wilt", "check failed", "increment 2 · test-a"])]);
  checks.push(["checks: a lost runner ranks wilt too", out.rank.l[0] === "wilt" && out.rank.l[1] === "check failed"]);
  checks.push(["checks: a pending check leaves the row working", out.rank.p[1] === "working"]);
  checks.push(["checks: a done plan never climbs back to wilt", out.rank.d[0] === "done"]);
  checks.push(["checks: the plans-only path agrees",
    out.plans.f[1] === "check failed" && out.plans.l[1] === "check failed" && out.plans.p[1] === "working" && out.plans.d[0] === "done"]);
  checks.push(["wake: every row, tiered and quiet, ends with the wake chip",
    Object.keys(out.chips).length === 5 && Object.values(out.chips).every(c => c[c.length - 1] === "wake") &&
    out.chips.q[0] === "jump" && out.chips.f[0] !== "wake"]);
  checks.push(["rank: a row carries its workspace's commits for the news", out.commits.length === 1 && out.commits[0].s === "x"]);
}

// ---- muted and tucked (the app's tucked.json, marked by crew-board) -------
{
  const rowsT = [
    { id: "ma", name: "ma", kind: "attend", badge: "b", said: "", chips: [], frac: null, meta: "", cwd: "/w/ma", tuck: "mute" },
    { id: "mr", name: "mr", kind: "running", badge: "b", said: "", chips: [], frac: null, meta: "", cwd: "/w/mr", tuck: "mute" },
    { id: "ta", name: "ta", kind: "attend", badge: "b", said: "", chips: [], frac: null, meta: "", cwd: "/w/ta", tuck: "tuck" },
    { id: "tq", name: "tq", kind: "quiet", badge: "idle", said: "", chips: ["jump"], frac: null, meta: "", cwd: "/w/tq", tuck: "tuck" },
    { id: "pl", name: "pl", kind: "running", badge: "b", said: "", chips: [], frac: null, meta: "" },
  ];
  els.rows.attrs["data-tuck-open"] = "0";
  render({ rows: rowsT, quiet: "" });
  const h = els.rows.innerHTML;
  const tuckAt = h.indexOf('<details class="tucked"');
  checks.push(["tuck: tucked rows leave the list for a collapsed 'tucked · 2' section at the end",
    tuckAt > h.indexOf('data-id="pl"') && /<details class="tucked"><summary class="sect">tucked · 2<\/summary>/.test(h) &&
    h.indexOf('data-id="ta"') > tuckAt && h.indexOf('data-id="tq"') > tuckAt]);
  // Two rows wait on you (ma, muted; ta, tucked): only the muted one counts.
  const need = String(els.need.textContent || "") + " " + String(els.need.innerHTML || "");
  checks.push([`tuck: a tucked row counts toward nothing above the section (${need.trim()})`,
    /\b1\b/.test(need) && !/\b2\b/.test(need)]);
  checks.push(["tuck: a muted row is greyed until it needs you",
    /class="row running[^"]* muted/.test(h) && !/class="row attend[^"]* muted/.test(h)]);
  checks.push(["tuck: top-level (cmux's Dock) there is no ⋯ menu", !/data-a="tk"/.test(h)]);
  els.rows.attrs["data-tuck-open"] = "1";
  sandbox.parent = { postMessage() {} };
  render({ rows: rowsT, quiet: "" });
  const hf = els.rows.innerHTML;
  delete sandbox.parent;
  checks.push(["tuck: framed by the app, a workspace row has the ⋯ menu, set by its level",
    /data-id="mr"[^]*?data-a="tk"[^]*?data-x="none">Unmute<[^]*?data-x="tuck">Tuck away</.test(hf) &&
    /data-id="tq"[^]*?data-x="mute">Mute<[^]*?data-x="none">Bring back</.test(hf)]);
  const plAt = hf.indexOf('data-id="pl"');
  const plCard = hf.slice(plAt, hf.indexOf('<div class="row ', plAt) > 0 ? hf.indexOf('<div class="row ', plAt) : hf.indexOf("<details", plAt));
  checks.push(["tuck: a plan row with no workspace has no menu", plAt > 0 && plCard.length > 0 && !/data-a="tk"/.test(plCard)]);
  checks.push(["tuck: the section stays open across a push when it was open", /<details class="tucked" open>/.test(hf)]);
  els.rows.attrs["data-tuck-open"] = "0";
}

// ---- the archive chip: on a quiet row, never on a working one -------------
// (What the server does with a press is checked against the running server,
// with the review routes below.)
{
  const W = (s, running) => ({ id: s, title: s, cwd: "/w/" + s, desc: "", running,
    branch: "none", pr: "none", dirty: false });
  const out = Object.fromEntries(stateFrom({ plans: {}, workspaces: [W("idle", false), W("busy", true)] })
    .rows.map(r => [r.id, [r.kind, r.chips]]));
  checks.push(["archive: a quiet row offers the archive chip",
    out.idle[0] === "quiet" && out.idle[1].includes("archive")]);
  checks.push(["archive: a working row does not", out.busy[0] === "running" && !out.busy[1].includes("archive")]);
  const intent = readFileSync(join(HERE, "intent.js"), "utf8"), rjs = readFileSync(join(HERE, "render.js"), "utf8");
  checks.push(["archive: the chip is clickable and has a tooltip",
    /"archive": "archive"/.test(intent) && /"archive": "Close this workspace/.test(rjs)]);
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
  // A token file left world-readable: the server must discard it and tighten the file.
  fs.mkdirSync(join(HOME, ".cache", "cmux-crew"), { recursive: true });
  fs.writeFileSync(join(HOME, ".cache", "cmux-crew", "board-intent.token"), "loose", { mode: 0o644 });
  fs.chmodSync(join(HOME, ".cache", "cmux-crew", "board-intent.token"), 0o644);
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
  // A stand-in for VS Code's `code`: it records what it was asked to open.
  const fakeCode = join(HOME, "fake-code");
  fs.writeFileSync(fakeCode, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${join(HOME, "fake-code.log")}"\n`, { mode: 0o755 });
  // cmux is fakecmux, which logs each call's argv to cmux.jsonl: the row
  // buttons below are judged by what the server sent, not by stubbing it.
  const FAKE_DIR = join(HOME, "fakecmux");
  fs.mkdirSync(FAKE_DIR);
  const ienv = { ...process.env, HOME, CREW_INTENT_PORT: String(pinned), PYTHONFAULTHANDLER: "1", CREW_CODE_BIN: fakeCode,
    CREW_CMUX: join(HERE, "..", "tools", "fakecmux.py"), FAKE_CMUX_DIR: FAKE_DIR, CREW_BOARD_HEARTBEAT: "1" };
  const [icmd, ...ipre] = tool("crew-board-intent");
  const srv = spawn(icmd, ipre, { env: toolEnv(ienv), stdio: ["ignore", "pipe", "pipe"] });
  // Kept, not discarded: when the server does not come up on a runner, its
  // own output and log are the only account of why, and HOME is gone after.
  let srvOut = "", srvExit = null;
  const keep = c => { srvOut = (srvOut + c).slice(-4000); };
  srv.stdout.on("data", keep);
  srv.stderr.on("data", keep);
  srv.on("exit", (code, sig) => { srvExit = sig || code; });
  const tokenFile = join(HOME, ".cache", "cmux-crew", "board-intent.token");
  const portFile = join(HOME, ".cache", "cmux-crew", "board-intent.port");
  const logFile = join(HOME, ".cache", "cmux-crew", "board-intent.log");
  const why = () => {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-2000) : "(no board-intent.log)";
    return `server ${srvExit === null ? "still running" : "exited " + srvExit}; ` +
      `port file ${fs.existsSync(portFile) ? fs.readFileSync(portFile, "utf8").trim() : "missing"}, ` +
      `token file ${fs.existsSync(tokenFile) ? "present" : "missing"}\n--- output ---\n${srvOut.trim() || "(none)"}\n--- log ---\n${log.trim()}`;
  };
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
  for (const deadline = Date.now() + 20000; Date.now() < deadline && srvExit === null; await new Promise(r => setTimeout(r, 100))) {
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
    if (!token) {
      // Still running but never listening: abort it, and faulthandler
      // (PYTHONFAULTHANDLER) prints the stack it was stuck in.
      if (srvExit === null) {
        srv.kill("SIGABRT");
        for (let i = 0; i < 30 && srvExit === null; i++) await new Promise(r => setTimeout(r, 100));
      }
      throw new Error("the intent server never answered; the review route checks are skipped\n" + why());
    }
    checks.push(["intent token: a loose token file is replaced and made 0600",
      token !== "loose" && (fs.statSync(tokenFile).mode & 0o777) === 0o600]);
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
    // DNS rebinding: the page is reached at 127.0.0.1, but the browser names the attacker's host.
    const rebound = await req("GET", "/review/demo", { headers: { Host: `evil.example:${port}` } });
    const localhost = await req("GET", "/health", { headers: { Host: `localhost:${port}` } });
    checks.push(["intent server: a foreign Host is refused, localhost on its port is not",
      rebound.status === 403 && !rebound.body.includes(token) && localhost.status === 200 &&
      (await req("GET", "/health", { headers: { Host: "127.0.0.1:1" } })).status === 403]);

    // The Wake's routes, against a store seeded under the temp HOME. The page
    // names row ids; nothing it sends is a path.
    const kept = join(HOME, "notes.md");
    fs.writeFileSync(kept, "# notes\n");
    execFileSync("python3", ["-c", [
      "import sys; sys.path.insert(0, sys.argv[1]); import artifacts as A",
      "db = A.connect(); db.execute('BEGIN IMMEDIATE')",
      "row = lambda **k: dict(dict.fromkeys(A.FIELDS, ''), ws='/w/wake', **k)",
      "A.write_rows(db, [row(kind='file', locator=sys.argv[2], path=sys.argv[2], title='notes.md', prompt='write the notes'),",
      "                  row(kind='temp', locator='/private/tmp/wake-gone.txt', path='/private/tmp/wake-gone.txt', title='gone.txt'),",
      "                  row(kind='plan', locator='wake-plan', title='a plan')])",
      "db.execute('COMMIT')"].join("\n"), HERE, kept], { env: { ...process.env, HOME } });
    const tq = `t=${encodeURIComponent(token)}`;
    const wp = await req("GET", "/artifacts?ws=" + encodeURIComponent("</script><b>x"));
    checks.push(["wake: the page carries its token, and a ws cannot close the boot block",
      wp.status === 200 && wp.body.includes(`"t": "${token}"`) && wp.body.includes("\\u003c/script\\u003e") &&
      !wp.body.includes("</script><b>x")]);
    const wd0 = await req("GET", "/artifacts/data?ws=%2Fw%2Fwake");
    const wd = await req("GET", `/artifacts/data?${tq}&ws=%2Fw%2Fwake`);
    let wj = {};
    try { wj = JSON.parse(wd.body); } catch {}
    const byTitle = t => (wj.rows || []).find(r => r.title === t) || {};
    checks.push(["wake: rows need the token, and open to no other origin",
      wd0.status === 403 && wd.status === 200 && !("access-control-allow-origin" in wd.headers) &&
      (wj.rows || []).length === 3]);
    checks.push(["wake: a missing file is gone, a present one is not",
      byTitle("gone.txt").state === "gone" && ["ok", "risk"].includes(byTitle("notes.md").state)]);
    checks.push(["wake: search goes through the prompt", await (async () => {
      const r = await req("GET", `/artifacts/data?${tq}&ws=%2Fw%2Fwake&q=notes+write`);
      try { return JSON.parse(r.body).rows.map(x => x.title).join() === "notes.md"; } catch { return false; }
    })()]);
    const wo = async q => { const r = await req("GET", `/artifacts/open?${tq}&${q}`); try { return JSON.parse(r.body); } catch { return {}; } };
    checks.push(["wake: open needs the token", (await req("GET", `/artifacts/open?id=${byTitle("gone.txt").id}`)).status === 403]);
    checks.push(["wake: open takes a row id, not a path",
      (await wo("path=" + encodeURIComponent(kept))).detail === "bad id" && (await wo("id=99999")).detail === "no such row"]);
    checks.push(["wake: a gone row says so instead of opening",
      /^gone: /.test((await wo("id=" + byTitle("gone.txt").id)).detail || "")]);
    const kp = (obj, o = {}) => post({ t: token, ...obj }, { path: "/artifacts/keep", ...o });
    checks.push(["wake keep: the POST guards hold (Origin, JSON, token)",
      (await kp({ id: byTitle("notes.md").id }, { origin: "" })).status === 403 &&
      (await kp({ id: byTitle("notes.md").id }, { origin: "https://evil.example" })).status === 403 &&
      (await kp({ id: byTitle("notes.md").id }, { type: "text/plain" })).status === 415 &&
      (await kp({ id: byTitle("notes.md").id, t: "nope" })).status === 403]);
    checks.push(["wake keep: a path in the body is not an id",
      JSON.parse((await kp({ path: kept })).body).error === "bad id" &&
      JSON.parse((await kp({ id: String(byTitle("notes.md").id) })).body).error === "bad id"]);
    checks.push(["wake keep: a gone file is refused with its reason",
      JSON.parse((await kp({ id: byTitle("gone.txt").id })).body).why === "the file is gone"]);
    const kr = await kp({ id: byTitle("notes.md").id });
    let kj = {};
    try { kj = JSON.parse(kr.body); } catch {}
    // notes.md sits under the temp HOME, itself in a temp root on every runner.
    checks.push(["wake keep: an at-risk file is copied into kept/ and the row repointed",
      kr.status === 200 && kj.ok && kj.path.startsWith(join(HOME, ".claude", "crew", "kept") + "/") &&
      fs.readFileSync(kj.path, "utf8") === "# notes\n" && kj.was === kept]);
    const pp = (obj, o = {}) => post({ t: token, ...obj }, { path: "/artifacts/publish", ...o });
    checks.push(["wake publish: the POST guards hold, and it takes an id",
      (await pp({ id: byTitle("gone.txt").id }, { origin: "https://evil.example" })).status === 403 &&
      (await pp({ id: byTitle("gone.txt").id, t: "nope" })).status === 403 &&
      JSON.parse((await pp({ path: kept })).body).error === "bad id"]);
    checks.push(["wake publish: a gone or non-page file is refused before any terminal opens",
      /only a present HTML/.test(JSON.parse((await pp({ id: byTitle("gone.txt").id })).body).detail) &&
      /only a present HTML/.test(JSON.parse((await pp({ id: byTitle("a plan").id })).body).detail)]);
    checks.push(["wake publish: the row says whether it can be published",
      byTitle("notes.md").publishable === true && byTitle("gone.txt").publishable === false]);
    // The kept copy sits in ~/.claude/crew/kept, outside any repo, where
    // crew-code-open exits 1 by design: the Wake falls through to the editor.
    const ed = await wo("id=" + byTitle("notes.md").id);
    const edLog = fs.existsSync(join(HOME, "fake-code.log")) ? fs.readFileSync(join(HOME, "fake-code.log"), "utf8") : "";
    checks.push(["wake open: a file outside any repo still opens in the editor",
      ed.ok === true && edLog.includes(kj.path), JSON.stringify(ed) + " " + edLog]);
    const ka = await kp({ ws: "/w/wake", all: true });
    checks.push(["wake keep: keep all answers per row", ka.status === 200 && Array.isArray(JSON.parse(ka.body).results)]);
    checks.push(["wake: a plan surface is one of three names",
      (await wo(`id=${byTitle("a plan").id}&s=..%2F..%2Fetc`)).detail === "unknown plan surface"]);

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
      !fs.readdirSync(reviews).some(n => n.includes(".tmp-") || n.endsWith(".lock") || n.endsWith(".lock-break"))]);
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
      (await post({ op: "comment", t: token, item: "t1", text: "after a crash" })).status === 200 &&
      !fs.existsSync(lock) && !fs.existsSync(lock + "-break")]);

    // ---- row buttons, through /do ------------------------------------------
    // What the server actually sends for a row's buttons. cmux refuses
    // notification.create outright over an unknown key, and a camelCase
    // workspaceId beside workspace_id was that key: every row-scoped RPC button
    // (reclaim, archive, code, go, sandbox, feed) failed before triage.py ran.
    // The collector writes the click table; lookout is a stand-in that logs
    // each run and, while `slow` exists, takes a second over it.
    const U = "8B5F643D-E94F-41B8-945C-EBCB4DF64FB1";
    runTool("crew-board", ["write-targets"], { env: ienv, input: JSON.stringify({ rows: [
      { id: U, ref: "workspace:9", cwd: HERE, name: "n", slug: "s" },
      { id: "not-a-uuid", ref: "workspace:9", cwd: HERE, name: "n", slug: "s" }] }) });
    const LK = join(HOME, "fake-lookout"), lkLog = join(HOME, "lookout.jsonl"), slow = join(HOME, "slow");
    fs.mkdirSync(LK);
    fs.writeFileSync(join(LK, "lookout.mjs"), `import fs from "node:fs";
if (fs.existsSync(${JSON.stringify(slow)})) await new Promise(r => setTimeout(r, 1000));
fs.appendFileSync(${JSON.stringify(lkLog)}, JSON.stringify({ argv: process.argv.slice(2), ws: process.env.CMUX_WORKSPACE_ID || "" }) + "\\n");\n`);
    fs.mkdirSync(join(HOME, ".claude", "lookout"), { recursive: true });
    fs.writeFileSync(join(HOME, ".claude", "lookout", "engine.json"), JSON.stringify({ root: LK }));
    const jsonl = f => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    const press = async (a, r = U, x = "") => {
      for (const f of [join(FAKE_DIR, "cmux.jsonl"), lkLog]) fs.rmSync(f, { force: true });
      const res = await req("GET", `/do?a=${encodeURIComponent(a)}&r=${encodeURIComponent(r)}&x=${x}&t=${encodeURIComponent(token)}`);
      return { res: JSON.parse(res.body || "{}"), cmux: jsonl(join(FAKE_DIR, "cmux.jsonl")), lookout: jsonl(lkLog) };
    };
    const rpcOf = p => p.cmux.filter(c => c[0] === "rpc" && c[1] === "notification.create").map(c => JSON.parse(c[2]));
    const sent = {};
    for (const a of ["reclaim", "archive", "code", "sandbox-up", "feed-deny"]) sent[a] = await press(a);
    sent.go = await press("go", U, "3");
    checks.push(["buttons: every row-scoped RPC names its workspace once, as workspace_id",
      ["reclaim", "archive", "code", "sandbox-up", "feed-deny", "go"].every((a) => {
        const p = rpcOf(sent[a]);
        return sent[a].res.ok === true && p.length === 1 && p[0].workspace_id === U &&
          !("workspaceId" in p[0]) && p[0].subtitle === "crew:" + (a === "go" ? "plan-go" : a);
      }), JSON.stringify(Object.fromEntries(Object.entries(sent).map(([k, v]) => [k, v.cmux])))]);
    const jump = await press("jump");
    checks.push(["buttons: jump selects by the workspace uuid, which a cmux restart does not renumber",
      JSON.stringify(jump.cmux) === JSON.stringify([["workspace", "select", U]]), JSON.stringify(jump.cmux)]);
    const diff = await press("diff");
    checks.push(["buttons: diff opens the branch in lookout, in the row's workspace, and brings it forward",
      diff.res.ok === true && diff.lookout.length === 1 && diff.lookout[0].ws === U &&
      JSON.stringify(diff.lookout[0].argv) === JSON.stringify(["open", "--view-only", "--at", HERE]) &&
      JSON.stringify(diff.cmux) === JSON.stringify([["workspace", "select", U]]), JSON.stringify(diff)]);
    const dref = await press("diff", "not-a-uuid");
    checks.push(["buttons: a row without a uuid hands lookout its ref, and selects it",
      dref.lookout.length === 1 && dref.lookout[0].ws === "workspace:9" &&
      JSON.stringify(dref.cmux) === JSON.stringify([["workspace", "select", "workspace:9"]]), JSON.stringify(dref)]);
    // Two presses while the first build runs: one build, and the second says so.
    fs.writeFileSync(slow, "");
    fs.rmSync(lkLog, { force: true });
    const both = await Promise.all([1, 2].map(() =>
      req("GET", `/do?a=diff&r=${U}&t=${encodeURIComponent(token)}`).then(r => JSON.parse(r.body).detail)));
    fs.rmSync(slow);
    const builds = jsonl(lkLog).length;
    const third = await press("diff");
    checks.push(["buttons: a diff pressed while its lookout build runs does not start another",
      builds === 1 && both.filter(d => d.startsWith("lookout already opening")).length === 1 &&
      third.lookout.length === 1, JSON.stringify({ both, builds, third: third.lookout.length })]);
    const unk = await req("GET", `/do?a=rm&r=${U}&t=${encodeURIComponent(token)}`);
    checks.push(["buttons: an action outside the allowlist is refused, and archive is in it",
      unk.status === 400 && sent.archive.res.ok === true]);
    fs.rmSync(join(HOME, ".claude", "lookout"), { recursive: true, force: true });

    // ---- the served board: /board and its /board/events feed ---------------
    // Last in this server's life: once a page subscribes, the feed rebuilds on
    // every heartbeat (1s here) and its cmux reads would land in the log the
    // button checks above read.
    const WS = (id, n, title) => ({ id, ref: "workspace:" + n, title, current_directory: HOME });
    fs.writeFileSync(join(FAKE_DIR, "workspaces.json"), JSON.stringify([WS("W-FEED-1", 5, "feed one")]));
    const bp = await req("GET", "/board");
    checks.push(["board page: board.html with the renderer, the click targets and the feed, before </body>",
      bp.status === 200 && bp.body.includes('id="rows"') && bp.body.includes("function __boardRender") &&
      bp.body.includes("function __boardIntent") && bp.body.includes(`new EventSource("/board/events?t=" + encodeURIComponent(T))`) &&
      bp.body.includes(`var T = "${token}", PORT = ${port};`) &&
      bp.body.lastIndexOf("EventSource") < bp.body.lastIndexOf("</body>")]);
    checks.push(["board page: the feed needs the token", (await req("GET", "/board/events")).status === 403 &&
      (await req("GET", "/board/events?t=nope")).status === 403]);
    // Read `state` events off the stream until `want` holds for one, or time runs out.
    const states = (want, ms) => new Promise(res => {
      let buf = "", done = false;
      const r = http.request({ host: "127.0.0.1", port, method: "GET", path: `/board/events?t=${encodeURIComponent(token)}` }, resp => {
        if (resp.headers["content-type"] !== "text/event-stream") { done = true; r.destroy(); return res(null); }
        resp.on("data", c => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!/^event: state$/m.test(block)) continue;
            let d = null;
            try { d = JSON.parse((block.match(/^data: (.*)$/m) || [])[1]); } catch {}
            if (d && want(d) && !done) { done = true; r.destroy(); res(d); }
          }
        });
      });
      r.on("error", () => { if (!done) { done = true; res(null); } });
      setTimeout(() => { if (!done) { done = true; r.destroy(); res(null); } }, ms);
      r.end();
    });
    const ids = d => (d.rows || []).map(x => x.id);
    const first = await states(() => true, 30000);
    checks.push(["board feed: the first state arrives on connect, ranked from cmux",
      !!first && ids(first).includes("W-FEED-1") && typeof first.stamp === "string" && first.news && first.stale === false,
      JSON.stringify(first).slice(0, 300)]);
    const tgt = JSON.parse(fs.readFileSync(join(HOME, ".cache", "cmux-crew", "board-targets.json"), "utf8"));
    checks.push(["board feed: each build writes the click table, so /do knows the rows shown",
      tgt["W-FEED-1"]?.ref === "workspace:5"]);
    const clk = await req("GET", `/do?a=jump&r=W-FEED-1&t=${encodeURIComponent(token)}`);
    checks.push(["board feed: a click on a fed row acts", clk.status === 200 && JSON.parse(clk.body).ok === true]);
    fs.writeFileSync(join(FAKE_DIR, "workspaces.json"),
      JSON.stringify([WS("W-FEED-1", 5, "feed one"), WS("W-FEED-2", 6, "feed two")]));
    const second = await states(d => ids(d).includes("W-FEED-2"), 30000);
    checks.push(["board feed: a change reaches an open page as a new state event", !!second && ids(second).includes("W-FEED-1")]);
  } catch (e) {
    checks.push(["review routes ran to the end: " + e.message, false]);
  } finally {
    srv.kill();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The review lock's two twins, review_lock here and withLock in lookout's
// store, against each other: the file contract they share (<id>.lock, broken
// through <id>.lock-break) has to hold from both sides. Each case runs in a
// child with a hard timeout, because the failure being guarded against is a
// writer that never comes back.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const DIR = fs.mkdtempSync(join(os.tmpdir(), "board-probe-lock-"));
  const STORE = pathToFileURL(join(HERE, "..", "..", "lookout", "lib", "store.mjs")).href;
  const env = toolEnv({ ...process.env, LOOKOUT_REVIEWS_DIR: DIR });
  // One lock attempt, or (with a count) that many counter increments under the
  // lock, 2ms apart. Prints {took, err, s}; null when the child had to be killed.
  // Counting writers are also given an unlucky scheduler: a pause of up to 2ms
  // after every stat. Two breakers race only in the gap between "I saw it
  // stale" and "I removed it", which on an idle machine is a microsecond or
  // two; the pause widens it, without touching the lock code, so the race
  // shows in a second instead of a day.
  const JS = `
const fs = (await import("node:fs")).default, stat = fs.statSync;
const nap = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const [rid, n] = [process.argv[2], +process.argv[3]];
if (n) fs.statSync = (...a) => { const r = stat(...a); nap(Math.random() * 2); return r; };
const S = await import(process.argv[1]);
const t = Date.now();
try {
  for (let i = 0; i < Math.max(n, 1); i++)
    if (n) { S.update(rid, r => ({ ...r, n: r.n + 1 })); nap(2); } else S.withLock(rid, () => {});
  console.log(JSON.stringify({ took: true, s: (Date.now() - t) / 1000 }));
} catch (e) { console.log(JSON.stringify({ took: false, err: e.message, s: (Date.now() - t) / 1000 })); }
`;
  const run = (cmd, args, ms) => new Promise(res => {
    const c = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", d => (out += d));
    const kill = setTimeout(() => c.kill("SIGKILL"), ms);
    c.on("exit", () => { clearTimeout(kill); try { res(JSON.parse(out.trim().split("\n").pop())); } catch { res(null); } });
  });
  // The Python twin's writer is the server's own --lock-test, which takes the
  // lock N times (jittering every os.stat when counting) from the command line.
  const [lcmd, ...lpre] = tool("crew-board-intent");
  const py = (rid, n = 0, ms = 10000) =>
    run(lcmd, [...lpre, "--lock-test", rid, String(n), ...(n ? ["--jitter"] : [])], ms);
  const js = (rid, n = 0, ms = 10000) => run(process.execPath, ["--input-type=module", "-e", JS, STORE, rid, String(n)], ms);
  const old = new Date(Date.now() - 60000);
  const plant = (p, stale) => { fs.mkdirSync(p); if (stale) fs.utimesSync(p, old, old); };
  const lk = rid => join(DIR, rid + ".lock");
  let planter = null;
  const timedOut = r => r && r.took === false && /locked by another writer/.test(r.err) && r.s >= 4.5 && r.s < 8;
  try {
    // guard: a stale lock with a breaker at work on it (a fresh guard) is not
    // broken a second time; the writer waits it out and gives up as normal.
    // A guard left by a crashed breaker is itself stale and is broken.
    // spin: a stale lock that will not go (rmdir gets ENOTEMPTY) is a timeout,
    // not a writer stuck in a loop.
    for (const s of ["p", "n"]) {
      plant(lk("guard" + s), true); plant(lk("guard" + s) + "-break", false);
      plant(lk("crash" + s), true); plant(lk("crash" + s) + "-break", true);
      plant(lk("spin" + s), true); fs.writeFileSync(join(lk("spin" + s), "x"), "");
      fs.utimesSync(lk("spin" + s), old, old);
    }
    const [gp, gn, cp, cn, sp, sn] = await Promise.all([
      py("guardp"), js("guardn"), py("crashp"), js("crashn"), py("spinp"), js("spinn")]);
    checks.push(["review lock (python): a stale lock under a fresh break guard is waited out, not broken",
      timedOut(gp) && fs.existsSync(lk("guardp")) && fs.existsSync(lk("guardp") + "-break")]);
    checks.push(["review lock (node): a stale lock under a fresh break guard is waited out, not broken",
      timedOut(gn) && fs.existsSync(lk("guardn")) && fs.existsSync(lk("guardn") + "-break")]);
    checks.push(["review lock (python): a crashed breaker's stale guard is cleared, then the lock is broken",
      cp?.took === true && !fs.existsSync(lk("crashp")) && !fs.existsSync(lk("crashp") + "-break")]);
    checks.push(["review lock (node): a crashed breaker's stale guard is cleared, then the lock is broken",
      cn?.took === true && !fs.existsSync(lk("crashn")) && !fs.existsSync(lk("crashn") + "-break")]);
    checks.push(["review lock (python): a stale lock that will not go is a timeout, not a hang",
      timedOut(sp) && !fs.existsSync(lk("spinp") + "-break")]);
    checks.push(["review lock (node): a stale lock that will not go is a timeout, not a hang",
      timedOut(sn) && !fs.existsSync(lk("spinn") + "-break")]);

    // stress: python and node writers increment one counter while stale locks
    // keep appearing (a writer crashing every 5ms, whenever the lock is free).
    // Two writers that both break the same stale lock must not both end up
    // holding it. The planter tries once per beat and never spins: a planter
    // that pounced on every freed lock would starve the writers, not test them.
    fs.writeFileSync(join(DIR, "stress.json"), JSON.stringify({ id: "stress", n: 0 }));
    planter = spawn(process.execPath, ["-e", `
const fs = require("fs"), p = process.argv[1], old = new Date(Date.now() - 60000);
setInterval(() => { try { fs.mkdirSync(p); fs.utimesSync(p, old, old); } catch {} }, 5);`, lk("stress")],
      { stdio: "ignore" });
    const N = 40, W = 3;
    const t0 = Date.now();
    const rs = await Promise.all([...Array(W)].flatMap(() => [py("stress", N, 20000), js("stress", N, 20000)]));
    const n = JSON.parse(fs.readFileSync(join(DIR, "stress.json"), "utf8")).n;
    checks.push([`review lock: ${W} python and ${W} node writers under planted stale locks lose no increment ` +
      `(${n}/${2 * W * N}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      rs.every(r => r?.took === true) && n === 2 * W * N]);
  } catch (e) {
    checks.push(["review lock checks ran to the end: " + e.message, false]);
  } finally {
    planter?.kill("SIGKILL");
    fs.rmSync(DIR, { recursive: true, force: true });
  }
}

let bad = 0;
for (const [n, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); }
console.log(`\n${bad ? "\x1b[31m" : "\x1b[32m"}board probe: ${checks.length - bad} passed, ${bad} failed\x1b[0m`);
process.exit(bad ? 1 : 0);
