// The fake cmux behind the demo: every Tauri command the app's pages invoke,
// answered from the demo world, and the wall and views frames pushed as
// events so the panes look live. Loaded by vite.config.mjs before main.ts.
//
// The shapes are the Rust side's (app/crates/seamux-app/src): wall.rs Frame
// and Tile, views.rs ViewsFrame, pty_app.rs's native terminal (bytes over a Channel),
// crew-board wake.rs wake_data, review_app.rs jobs, reclaim.rs Report,
// newws_app.rs Options, sessions.rs SessionRow, shell.rs IntentServer.
//
// Query parameters (on the app's URL):
//   ?intent=http://127.0.0.1:PORT  frame plans, reviews and asks from that
//                                  server (proxied by the stand-in, which
//                                  keeps serving the demo board)
//   &board=intent                  take /board from that server too
//   ?intent=none                   no intent server at all: the down states
//   &plain=checkout,api            those workspaces' panes are not native: the
//                                  Dock shows Move to native for them
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { QUESTION, HOME, REPO, TREES, GH, WORKSPACES, byKey, treeOf } from "./world.mjs";

const T0 = Date.now();
const MIN = 60_000;
const ago = (min) => T0 - min * MIN;
const secs = (ms) => Math.floor(ms / 1000);
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- intent

const params = new URLSearchParams(location.search);
const intentArg = params.get("intent") ?? "";
const boardFromIntent = params.get("board") === "intent";
/** Surfaces of the panes that are not native (?plain=<workspace keys>). */
const plainPanes = new Set((params.get("plain") ?? "").split(",").filter(Boolean).map((k) => byKey[k]?.surface).filter(Boolean));
const demoCfg = window.__SEAMUX_DEMO__ ?? { intentPort: 0 };
const STUB = demoCfg.intentPort ? `http://127.0.0.1:${demoCfg.intentPort}` : "";
/** Pages beyond the board exist only when a real intent server is given. */
const PAGES = !!intentArg && intentArg !== "none";
const INTENT =
  intentArg === "none"
    ? { origin: null, up: false, reason: "not running in this demo" }
    : PAGES && boardFromIntent
      ? { origin: intentArg.replace(/\/+$/, ""), up: true, reason: null }
      : STUB
        ? { origin: STUB, up: true, reason: null }
        : { origin: null, up: false, reason: "the demo's stand-in server did not start" };
// The stand-in proxies everything but /board to the given server.
void fetch(`/__demo/intent?target=${encodeURIComponent(PAGES && !boardFromIntent ? intentArg : "")}`).catch(() => {});

// ---------------------------------------------------------------- terminal text

const esc = (code) => (t) => `\x1b[${code}m${t}\x1b[0m`;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
const fg = (hex) => esc(`38;2;${rgb(hex)}`);
const bg = (hex, fgHex) => esc(`48;2;${rgb(hex)}${fgHex ? `;38;2;${rgb(fgHex)}` : ""}`);
const C = {
  claude: fg("#d77757"),
  ok: fg("#4eba65"),
  dim: fg("#8b8b92"),
  faint: fg("#5c5c63"),
  bold: esc("1"),
  red: fg("#ff6b80"),
  pick: fg("#b1b9f9"),
  yellow: fg("#e5c07b"),
  cyan: fg("#7fbbb3"),
  user: bg("#2b2b31", "#c8c8ce"),
  add: bg("#1f3a28", "#c9e7cf"),
  del: bg("#41232a", "#f0c6cc"),
};
const RULE = "\u0000rule";
const plainLen = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;

const BOX = 56;
const boxLine = (s) => `${C.claude("│")}${s}${" ".repeat(Math.max(0, BOX - plainLen(s)))}${C.claude("│")}`;
const welcome = (w) => [
  C.claude(`╭${"─".repeat(BOX)}╮`),
  boxLine(` ${C.claude("✻")} Welcome to ${C.bold("Claude Code")}!`),
  boxLine(""),
  boxLine(`   ${C.dim("/help for help, /status for your current setup")}`),
  boxLine(""),
  boxLine(`   ${C.dim(`cwd: ~${treeOf(w).slice(HOME.length)}`)}`),
  C.claude(`╰${"─".repeat(BOX)}╯`),
  "",
];
const you = (t) => [C.user(`> ${t} `), ""];
const say = (...ls) => [`${"⏺"} ${ls[0]}`, ...ls.slice(1).map((l) => `  ${l}`), ""];
const tool = (name, arg, ...out) => [`${C.ok("⏺")} ${C.bold(name)}(${arg})`, ...out.map((l, i) => `  ${i ? "   " : C.dim("⎿  ")}${l}`), ""];
const diff = (n, sign, code) => `${C.faint(String(n).padStart(5))} ${sign === "+" ? C.add(`+ ${code}`) : sign === "-" ? C.del(`- ${code}`) : `  ${code}`}`;
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const clock = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
function spinner(word, startedMs, tokens0) {
  const s = Math.max(1, Math.floor((Date.now() - startedMs) / 1000));
  const g = GLYPHS[Math.floor(Date.now() / 400) % GLYPHS.length];
  const k = (tokens0 + s * 0.04).toFixed(1);
  return [`${C.claude(g)} ${C.claude(word + "…")} ${C.dim(`(${clock(s)} · ↓ ${k}k tokens · esc to interrupt)`)}`, ""];
}
const footer = (input, mode) => [RULE, `${C.dim("❯")} ${input}`, RULE, `  ${C.dim(mode)}`];

/** A pane's state, as the fake cmux holds it. */
const panes = new Map();

function pane(surface, o) {
  panes.set(surface, { surface, input: "", extra: [], ...o });
}

function questionBox(sel) {
  const opt = (i, o) => {
    const on = i === sel;
    const head = `${on ? C.pick("❯") : " "} ${on ? C.pick(`${i + 1}. ${o.label}`) : `${i + 1}. ${o.label}`}`;
    return [head, `     ${C.dim(o.description)}`];
  };
  return [
    RULE,
    ` ${C.pick("☐")} ${C.bold(QUESTION.header)} `,
    "",
    C.bold(QUESTION.question),
    "",
    ...QUESTION.options.flatMap((o, i) => opt(i, o)),
    `  ${QUESTION.options.length + 1}. Type something.`,
    "",
    C.dim("Enter to select · ↑/↓ to navigate · Esc to cancel"),
  ];
}

const W = byKey;
pane(W.checkout.surface, {
  body: () => [
    ...welcome(W.checkout),
    ...you("Bad coupon codes crash checkout with a 500. Plan clear errors with deep-plan."),
    ...say("I'll plan it first: the route, the coupon lookup and the form each play a part."),
    ...tool("Bash", "deep-plan render checkout-errors", "Plan \"Clear errors for bad coupon codes\" · 4 increments", "review page open beside this pane"),
    ...you("go 1"),
    ...tool("Update", "src/coupons/lookup.js", "Updated src/coupons/lookup.js with 9 additions and 2 removals"),
    ...tool("Bash", "npm test -- coupons", `${C.ok("PASS")} test/coupons.test.js`, "Tests: 6 passed, 6 total"),
    ...say("Increment 1 is done: the lookup now says why a code fails (unknown, expired)."),
    ...you("go 2"),
    ...say("Increment 2 of 4: the route turns each failure into a clear error."),
    ...tool("Read", "src/checkout/route.js", "Read 38 lines"),
    ...tool("Read", "src/coupons/lookup.js", "Read 31 lines"),
    ...say("The lookup already tells an expired code from an unknown one, so the route only has to pick a status for each. Unknown is a 404. Expired is your call:"),
  ],
  question: 0,
  mode: "⏵⏵ accept edits on (shift+tab to cycle)",
});
pane(W.api.surface, {
  body: () => [
    ...welcome(W.api),
    ...you("Take coupon codes at checkout. Plan it with deep-plan; split the form off to a child plan."),
    ...tool("Bash", "deep-plan render demo-coupons", "Plan \"Take coupon codes at checkout\" · 3 increments", "family: coupons-ui (child) waits on increment 1"),
    ...you("go 1"),
    ...tool("Write", "src/coupons/lookup.js", "Wrote 31 lines to src/coupons/lookup.js"),
    ...tool("Bash", "npm test", `${C.ok("PASS")} test/coupons.test.js`, "Tests: 11 passed, 11 total"),
    ...say("Increment 1 is done and lookout's review is closed. coupons-ui can start."),
    ...you("go 2"),
    ...say("Increment 2 of 3: apply the coupon in the checkout total."),
    ...tool("Update", "src/checkout/total.js", "Updated src/checkout/total.js with 3 additions and 1 removal",
      diff(7, " ", "export function total(cart, coupon) {"),
      diff(8, " ", "  const sub = cart.items.reduce((n, i) => n + i.price * i.qty, 0);"),
      diff(9, "-", "  const discount = 0;"),
      diff(9, "+", "  const discount = coupon"),
      diff(10, "+", "    ? Math.round((sub * coupon.percent_off) / 100)"),
      diff(11, "+", "    : 0;"),
    ),
    ...tool("Bash", "npm test -- checkout", `${C.ok("PASS")} test/checkout.test.js`, `${C.ok("PASS")} test/total.test.js`, "Tests: 14 passed, 14 total"),
    ...tool("Update", "src/checkout/route.js", "Updated src/checkout/route.js with 9 additions"),
  ],
  spin: () => spinner("Applying the coupon", ago(2.3), 3.1),
  mode: "⏵⏵ accept edits on · deep-plan inc 2/3",
});
pane(W.ui.surface, {
  body: () => [
    ...welcome(W.ui),
    ...you("You're the coupons-ui child of demo-coupons. Build the coupon field on the checkout form."),
    ...say("Increment 1 of 2: a coupon field that asks the server and shows the discount."),
    ...tool("Read", "src/checkout/route.js", "Read 47 lines"),
    ...tool("Write", "src/checkout/CouponField.js", "Wrote 58 lines to src/checkout/CouponField.js"),
    ...tool("Bash", "npm run lint", `${C.ok("✓")} 0 problems`),
    ...say("The field posts the code and waits for the server's answer before it shows a discount, as the parent plan decided."),
    ...tool("Update", "src/checkout/form.html", "Updated src/checkout/form.html with 6 additions"),
  ],
  spin: () => spinner("Wiring the field", ago(1.6), 1.2),
  mode: "⏵⏵ accept edits on · deep-plan inc 1/2",
});
pane(W.search.surface, {
  body: () => [
    ...welcome(W.search),
    ...you("go 3"),
    ...tool("Update", "src/search/index.js", "Updated src/search/index.js with 14 additions and 3 removals"),
    ...tool("Bash", "npm test", `${C.ok("PASS")} test/search.test.js`, "Tests: 19 passed, 19 total"),
    ...tool("Bash", "deep-plan done 3", "increment 3 done · plan search-index done (3/3)"),
    ...tool("Bash", "gh pr create --fill", `https://github.com/${GH}/pull/41`),
    ...you("merge it"),
    ...tool("Bash", "gh pr merge 41 --squash", `${C.ok("✓")} Squashed and merged pull request #41`),
    ...say(
      "Merged. PR #41 reindexes search when a product is renamed:",
      "",
      `${C.dim("•")} the rename writes a reindex job instead of reindexing in the request`,
      `${C.dim("•")} the worker picks it up within a second; 19 tests cover it`,
      "",
      "The worktree can be reclaimed from the Dock.",
    ),
  ],
  mode: "? for shortcuts",
});
const zsh = (dir, cmd) => `${C.ok("sam")}${C.dim("@demo")} ${C.cyan(dir)} ${C.dim("%")} ${cmd}`;
pane(W.docs.surface, {
  shell: true,
  body: () => [
    zsh("docs-copy", "git log --oneline -4"),
    `${C.yellow("c81e0f4")} docs: shorter checkout help text`,
    `${C.yellow("5a9d2b7")} docs: coupon codes in the FAQ`,
    `${C.yellow("e03b6c1")} docs: link the returns page`,
    `${C.yellow("91f4a8e")} shop: cart, totals, checkout`,
    zsh("docs-copy", "npm run lint"),
    "",
    "> shop@0.3.0 lint",
    "> node scripts/lint.mjs",
    "",
    `${C.ok("✓")} 23 files, 0 problems`,
  ],
  prompt: () => zsh("docs-copy", ""),
});
pane(W.api.shell.surface, {
  shell: true,
  body: () => [
    zsh("coupons-api", "npm test -- --watch"),
    "",
    `${C.ok(" PASS ")} test/coupons.test.js`,
    `${C.ok(" PASS ")} test/checkout.test.js`,
    `${C.ok(" PASS ")} test/total.test.js`,
    "",
    `${C.bold("Tests:")}       ${C.ok("14 passed")}, 14 total`,
    `${C.bold("Time:")}        0.84 s`,
    "",
    C.dim("Watching for file changes. Press q to quit."),
  ],
  prompt: () => null,
});

const THEME = { background: "#17181b", foreground: "#d8d8dc", cursor: "#d8d8dc" };

function screenLines(p) {
  if (p.shell) {
    const pr = p.prompt();
    return [...p.body(), ...p.extra, ...(pr === null ? [] : [pr + p.input])];
  }
  const tail = p.question !== undefined && p.question !== null ? questionBox(p.question) : [...(p.spin ? p.spin() : []), ...footer(p.input, p.mode)];
  return [...p.body(), ...p.extra, ...tail];
}

const plain = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
/** wall.rs's clean(): the agent's words, without the prompt box and footer. */
function tileLines(p) {
  const body = [...p.body(), ...p.extra];
  if (p.shell) {
    const pr = p.prompt();
    return [...body, ...(pr === null ? [] : [pr + p.input])].map(plain).slice(-80);
  }
  const q = p.question !== undefined && p.question !== null ? questionBox(p.question) : p.spin ? p.spin() : [];
  return [...body, ...q]
    .filter((l) => l !== RULE)
    .map(plain)
    .slice(-80);
}

// ---------------------------------------------------------------- the world's state

const ws = WORKSPACES.map((w) => ({ ...w, since: ago(w.sinceMin) }));
let decisions = [{ kind: "question", ws: W.checkout.id, surface: W.checkout.surface, since: ago(W.checkout.sinceMin), questions: [QUESTION] }];

function tiles() {
  const out = [];
  for (const w of ws) {
    const p = panes.get(w.surface);
    out.push({
      surface: w.surface,
      workspace: w.id,
      workspace_title: w.title,
      label: w.agent ? LABELS[w.key] : "zsh",
      cwd: treeOf(w),
      agent: w.agent,
      state: w.state,
      lines: tileLines(p),
      error: null,
      color: w.color,
      since: w.since,
      running: w.agent ? null : null,
      bell: false,
      root: treeOf(w),
      owner: w.agent && w.plan ? w.plan.slug : null,
      outside: false,
    });
    if (w.shell) {
      out.push({
        surface: w.shell.surface,
        workspace: w.id,
        workspace_title: w.title,
        label: w.shell.label,
        cwd: treeOf(w),
        agent: null,
        state: "shell",
        lines: tileLines(panes.get(w.shell.surface)),
        error: null,
        color: w.color,
        since: ago(30),
        running: w.shell.running,
        bell: false,
        root: treeOf(w),
        owner: null,
        outside: false,
      });
    }
  }
  return out;
}
const LABELS = { checkout: "Expired coupon status", api: "Apply coupon at checkout", ui: "Coupon field component", search: "Search reindex on rename", fresh: "New workspace" };

const wallFrame = () => ({ tiles: tiles(), error: null });

// Two hours of state spans per agent workspace (minutes ago), for the history.
const SPANS = {
  checkout: [["working", 96, 81], ["needs_input", 81, 77], ["working", 77, 52], ["idle", 52, 49], ["working", 49, 4], ["needs_input", 4, 0]],
  api: [["working", 112, 72], ["idle", 72, 64], ["needs_input", 64, 57], ["working", 57, 0]],
  ui: [["working", 40, 26], ["needs_input", 26, 21], ["working", 21, 0]],
  search: [["working", 124, 62], ["needs_input", 62, 58], ["working", 58, 41], ["idle", 41, 0]],
};
function history() {
  const out = [];
  for (const w of ws) for (const s of SPANS[w.key] ?? []) out.push({ at: ago(s[1]), ws: w.id, surface: w.surface, state: s[0], source: "hook", detail: "" });
  return out.sort((a, b) => a.at - b.at);
}

// The Wake: what each workspace left behind.
const SESS = { checkout: "3f6c1e2a-8b4d-4c7e-9a1f-2d3e4f5a6b70", api: "4a7d2f3b-9c5e-4d8f-8b2a-3e4f5a6b7c81", ui: "5b8e3a4c-ad6f-4e9a-9c3b-4f5a6b7c8d92", search: "6c9f4b5d-be7a-4fab-8d4c-5a6b7c8d9ea3", docs: "" };
const DP = `${HOME}/.claude/deep-plan/plans`;
const WAKE = [
  [1, "api", "plan", "Take coupon codes at checkout", 112, { path: `${DP}/demo-coupons.md`, locator: "demo-coupons", source: "deep-plan", prompt: "Take coupon codes at checkout" }],
  [2, "api", "ask", "Bad code: what should checkout do?", 64, { locator: "ask-bad-code", source: "ask", prompt: "Take coupon codes at checkout" }],
  [3, "api", "commit", "coupons: look codes up case-insensitively", 73, { sha: "a41c9e2", url: `https://github.com/${GH}/commit/a41c9e2`, prompt: "go 1" }],
  [4, "api", "review", "demo-coupons · increment 1", 66, { locator: "rv-coupons-inc1", source: "lookout", prompt: "go 1" }],
  [5, "api", "image", "checkout-before.png", 31, { path: `${TREES}/coupons-api/docs/checkout-before.png`, prompt: "go 2" }],
  [6, "api", "temp", "coupon-totals.json", 12, { path: "/tmp/claude/coupon-totals.json", prompt: "go 2", state: "risk" }],
  [7, "api", "commit", "checkout: apply percent_off in total()", 9, { sha: "7be03d1", url: `https://github.com/${GH}/commit/7be03d1`, prompt: "go 2" }],
  [8, "checkout", "plan", "Clear errors for bad coupon codes", 95, { path: `${DP}/checkout-errors.md`, locator: "checkout-errors", source: "deep-plan", prompt: "Bad coupon codes crash checkout with a 500." }],
  [9, "checkout", "commit", "coupons: say why a code fails", 52, { sha: "c52e8b0", url: `https://github.com/${GH}/commit/c52e8b0`, prompt: "go 1" }],
  [10, "checkout", "doc", "error-codes.md", 20, { path: `${TREES}/checkout-flow/notes/error-codes.md`, prompt: "go 2" }],
  [11, "ui", "plan", "Coupon field on the checkout form", 40, { path: `${DP}/coupons-ui.md`, locator: "coupons-ui", source: "deep-plan", prompt: "Build the coupon field" }],
  [12, "ui", "image", "coupon-field.png", 22, { path: `${TREES}/coupons-ui/docs/coupon-field.png`, prompt: "Build the coupon field" }],
  [13, "search", "plan", "Reindex search when a product is renamed", 125, { path: `${DP}/search-index.md`, locator: "search-index", source: "deep-plan", prompt: "Reindex on rename" }],
  [14, "search", "commit", "search: reindex on product rename", 46, { sha: "e7d1a93", url: `https://github.com/${GH}/commit/e7d1a93`, prompt: "go 3" }],
  [15, "search", "review", "search-index · increment 3", 43, { locator: "rv-search-41", source: "lookout", prompt: "go 3" }],
  [16, "search", "pr", "Reindex search when a product is renamed", 41, { url: `https://github.com/${GH}/pull/41`, prompt: "merge it" }],
  [17, "docs", "commit", "docs: shorter checkout help text", 25, { sha: "c81e0f4", url: `https://github.com/${GH}/commit/c81e0f4` }],
];
function wakeRows() {
  return WAKE.filter(([, k]) => ws.some((w) => w.key === k))
    .map(([id, k, kind, title, m, o]) => {
      const w = byKey[k];
      return {
        id, kind, title,
        path: o.path ?? "", was_path: "", url: o.url ?? "", sha: o.sha ?? "",
        created_at: iso(ago(m)), session_id: SESS[k], branch: w.branch, prompt: o.prompt ?? "",
        source: o.source ?? "", locator: o.locator ?? "", state: o.state ?? "ok",
        published: false, publishable: ["image", "doc"].includes(kind), ws: treeOf(w),
        _ws: w.id, _at: ago(m),
      };
    })
    .sort((a, b) => b._at - a._at);
}
const strip = ({ _ws, _at, ...r }) => r;

const plans = () => ws.filter((w) => w.plan).map((w) => ({ ws: w.id, ...w.plan, touched: ago(Math.min(w.sinceMin, 30)) }));
const reviews = () =>
  [
    { ws: W.api.id, id: "rv-coupons-inc1", plan: "demo-coupons", inc: 1, open: 0, addressed: 1, closed: 3, since: ago(66) },
    { ws: W.search.id, id: "rv-search-41", plan: "search-index", inc: 3, open: 0, addressed: 0, closed: 4, since: ago(43) },
  ].filter((r) => ws.some((w) => w.id === r.ws));
const inc = (n, title, status, checks, review, by) => ({ n, title, status, checks, review, by });
const families = () => [
  {
    parent: "demo-coupons",
    done: 0,
    total: 2,
    members: [
      {
        slug: "demo-coupons", role: "parent", phase: "working", done: 1, total: 3, n: 2, open: true, ws: W.api.id,
        waits: [], ready: false, go: "human", held: "",
        increments: [inc(1, "Coupon lookup", "done", "pass", "pass", "human"), inc(2, "Apply the coupon at checkout", "working", "pending", "", "human"), inc(3, "Coupons table", "planned", "", "", "")],
      },
      {
        slug: "coupons-ui", role: "child", phase: "working", done: 0, total: 2, n: 1, open: true, ws: W.ui.id,
        waits: [], ready: false, go: "parent", held: "",
        increments: [inc(1, "Coupon field", "working", "pending", "", "parent"), inc(2, "Show the discount", "planned", "", "", "")],
      },
    ],
  },
];
const PAGE_LIST = [
  ["checkout", "plan", "/plan/checkout-errors", "checkout-errors", "working inc 2/4", false],
  ["checkout", "ask", "/ask/ask-expired-codes", "Expired codes", "waiting", true],
  ["api", "plan", "/plan/demo-coupons", "demo-coupons", "working inc 2/3", false],
  ["api", "review", "/review/rv-coupons-inc1", "demo-coupons inc 1", "1 addressed", true],
  ["ui", "plan", "/plan/coupons-ui", "coupons-ui", "working inc 1/2", false],
  ["search", "plan", "/plan/search-index", "search-index", "done", false],
];
const pages = () =>
  PAGES
    ? PAGE_LIST.filter(([k]) => ws.some((w) => w.key === k)).map(([k, kind, path, label, state, waiting]) => ({ ws: byKey[k].id, kind, path, label, state, waiting, since: ago(10) }))
    : [];
let tucked = [
  { path: `${TREES}/legacy-cart`, level: "tuck", at: ago(60 * 26), name: "legacy-cart", branch: "sam/legacy-cart", workspaces: [], waiting: false, last: ago(60 * 26) },
  { path: `${TREES}/gift-cards`, level: "tuck", at: ago(60 * 50), name: "gift-cards", branch: "sam/gift-cards", workspaces: [], waiting: false, last: ago(60 * 49) },
  { path: `${TREES}/perf-spike`, level: "mute", at: ago(60 * 3), name: "perf-spike", branch: "sam/perf-spike", workspaces: [], waiting: false, last: ago(95) },
];

function viewsFrame() {
  return {
    decisions,
    wake: wakeRows().map((r) => ({ id: r.id, kind: r.kind, title: r.title, dir: r.ws, ws: r._ws, at: r._at })),
    history: history(),
    plans: plans(),
    reviews: reviews(),
    tucked,
    families: families(),
    pages: pages(),
    levels: {},
    problems: [],
  };
}

// Lookout.
const REVIEW_LOG = [
  "resolving demo-shop/shop@sam/coupons-api",
  "fetching origin (sam/coupons-api, main)",
  "worktree at ~/.claude/lookout/trees/coupons-api",
  "diff: 6 files, +142 −18 against main",
  "reviewer: sonnet, high depth",
];
let jobs = [
  {
    id: "j-41", input: `${GH}#41`, repo: GH, branch: "sam/search-index", pr: 41, base: "main", cross: false, depth: "high", model: "sonnet",
    status: "ready", detail: "", review_id: "rv-search-41", session: "", started: secs(ago(48)), stage_at: secs(ago(44)),
    activity: "", busy: "", log: ["resolving demo-shop/shop#41", "fetching origin (pull/41/head)", "diff: 4 files, +96 −11 against main", "review: 4 findings", "saved rv-search-41"],
    open: { major: 1, minor: 2, nit: 1 }, ahead: 0, dirty: false, pushed: false, posted: "",
  },
  {
    id: "j-44", input: `${GH}@sam/coupons-api`, repo: GH, branch: "sam/coupons-api", pr: 44, base: "main", cross: false, depth: "high", model: "sonnet",
    status: "reviewing", detail: "", review_id: "", session: "", started: secs(ago(3.4)), stage_at: secs(ago(2.6)),
    activity: "Reading src/checkout/total.js and its callers", busy: "", log: REVIEW_LOG,
    open: {}, ahead: 0, dirty: false, pushed: false, posted: "",
  },
];
const FINDINGS = {
  "j-41": [
    { id: "F1", file: "src/search/index.js", line: 42, severity: "major", summary: "A rename during a reindex can drop the job: the worker deletes by name, not id", status: "open" },
    { id: "F2", file: "src/search/worker.js", line: 17, severity: "minor", summary: "The retry has no backoff; a down index spins the worker", status: "open" },
    { id: "F3", file: "test/search.test.js", line: 88, severity: "minor", summary: "No test for two renames of one product inside a second", status: "open" },
    { id: "F4", file: "src/search/index.js", line: 9, severity: "nit", summary: "reindexOne is exported but only used here", status: "open" },
  ],
};
const others = [
  { id: "rv-coupons-inc1", title: "demo-coupons · increment 1", root: treeOf(W.api), branch: "sam/coupons-api", updated: secs(ago(66)), open: { minor: 1 } },
];

// Reclaim.
function reclaimReport(id) {
  const w = ws.find((x) => x.id === id);
  if (!w) throw "that workspace is gone";
  const merged = w.key === "search";
  const pass = (text, hint = null) => ({ kind: "pass", text, hint });
  const checks = merged
    ? [
        pass(`Merged into origin/main as PR #${w.pr}`),
        pass("No uncommitted changes in the worktree"),
        pass("No commits ahead of origin/main"),
        pass("Plan search-index is done (3/3)"),
        pass("No agent is mid-turn in the workspace"),
        { kind: "warn", text: "1 Wake row points into the worktree", hint: "It stays in the Wake; the file goes with the worktree." },
        { kind: "skip", text: "No sandbox to stop", hint: null },
      ]
    : [
        { kind: "fail", text: `${w.branch} is not merged: 3 commits ahead of origin/main`, hint: "Merge or close its pull request first." },
        { kind: "fail", text: "Uncommitted changes in 2 files", hint: "Commit or stash them, or keep the worktree." },
        w.agent ? { kind: "fail", text: "Claude is still running in the workspace", hint: "Let it finish, or end the session." } : pass("No agent is running"),
      ];
  return {
    worktree: treeOf(w),
    branch: w.branch,
    size: merged ? "184 MB" : "212 MB",
    base: "origin/main",
    workspace: { id: w.id, name: w.title },
    plan: w.plan ? `${w.plan.slug} (${w.plan.phase === "done" ? "done" : "working"} ${w.plan.done}/${w.plan.total})` : null,
    sandbox: null,
    checks,
    blockers: checks.filter((c) => c.kind === "fail").length,
    remove: [
      { what: "workspace", target: `${w.title} (${w.ref})`, note: "closed in cmux" },
      { what: "worktree", target: treeOf(w), note: merged ? "184 MB" : "" },
      { what: "branch", target: w.branch, note: "merged; origin keeps its copy" },
    ],
  };
}

// ---------------------------------------------------------------- live changes

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function emit(event, payload) {
  return window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload });
}
const push = () => {
  void emit("wall:frame", wallFrame());
  void emit("views:frame", viewsFrame());
};

function setState(w, state) {
  if (w.state === state) return;
  w.state = state;
  w.since = Date.now();
  push();
}

/** Checkout-flow's question, answered: the agent goes back to work. */
function answer(n) {
  const w = ws.find((x) => x.key === "checkout");
  const p = panes.get(w.surface);
  const o = QUESTION.options[n - 1];
  if (!o || p.question === null) throw "no question is open there";
  p.question = null;
  decisions = decisions.filter((d) => d.ws !== w.id);
  p.extra.push(
    `${C.ok("⏺")} User answered Claude's questions:`,
    `  ${C.dim("⎿  ")}· ${QUESTION.question} → ${o.label}`,
    "",
    ...say(n === 1 ? "422 it is: an expired code is a well-formed request that can't be applied." : "400 it is: every bad code is a bad request."),
  );
  p.spin = () => spinner("Mapping the errors", w.since, 0.4);
  setState(w, "working");
  setTimeout(() => {
    p.extra.push(...tool("Update", "src/checkout/route.js", `Updated src/checkout/route.js with 8 additions and 1 removal`));
    push();
  }, 4000);
  return `Typed ${n} (${o.label}) into ${w.title}`;
}

function reply(surface, text) {
  const w = ws.find((x) => x.surface === surface);
  const p = panes.get(surface);
  if (!w || !p) throw "no such pane";
  if (!w.agent) throw "no agent is running in that pane";
  if (p.question !== undefined && p.question !== null) {
    const n = Number(text.trim());
    if (n >= 1 && n <= QUESTION.options.length) return answer(n);
    p.question = null;
    decisions = decisions.filter((d) => d.ws !== w.id);
  }
  p.extra.push(...you(text), ...say("On it."));
  const started = Date.now();
  p.spin = () => spinner("Working", started, 0.2);
  setState(w, "working");
  return "Sent";
}

function key(surface, k) {
  const p = panes.get(surface);
  if (!p) throw "no such surface";
  if (p.question !== undefined && p.question !== null) {
    if (k === "up") p.question = Math.max(0, p.question - 1);
    else if (k === "down") p.question = Math.min(QUESTION.options.length - 1, p.question + 1);
    else if (k === "enter") answer(p.question + 1);
    return;
  }
  if (k === "backspace") p.input = [...p.input].slice(0, -1).join("");
  else if (k === "enter" && p.input.trim()) {
    const text = p.input;
    p.input = "";
    if (p.shell) p.extra.push(p.prompt() + text, `zsh: demo shell: ${text.split(" ")[0]} is not run here`);
    else reply(surface, text);
  }
}

function input(surface, text) {
  const p = panes.get(surface);
  if (!p) throw "no such surface";
  if (p.question !== undefined && p.question !== null && /^[1-9]$/.test(text)) {
    answer(Number(text));
    return;
  }
  if (text === "\r") return key(surface, "enter");
  p.input += text.replace(/[\x00-\x1f]/g, "");
}

// ── native terminals: a pane's screen as bytes for xterm.js ─────────────────

const ptys = new Map();
let nextPty = 1;
const enc = new TextEncoder();

/** The pane's whole screen, scrollback cleared first, as xterm.js writes it. */
function screenBytes(p, cols) {
  const lines = screenLines(p).map((l) => (l === RULE ? C.faint("─".repeat(cols)) : l));
  return "\x1b[H\x1b[2J\x1b[3J" + lines.join("\r\n");
}

function attach(surface, cols, ch) {
  const p = panes.get(surface);
  if (!p) throw "no such surface";
  const id = nextPty++;
  const t = { surface, cols, ch, last: "", timer: 0 };
  const draw = () => {
    const s = screenBytes(panes.get(surface), t.cols);
    if (s === t.last) return;
    t.last = s;
    ch?.onmessage?.(enc.encode(s));
  };
  t.draw = draw;
  t.timer = setInterval(draw, 300);
  ptys.set(id, t);
  setTimeout(draw, 0);
  return id;
}

function detach(id) {
  const t = ptys.get(id);
  if (t) clearInterval(t.timer);
  ptys.delete(id);
}

function resize(id, cols) {
  const t = ptys.get(id);
  if (!t) return;
  t.cols = cols;
  t.last = "";
  t.draw();
}

/** Keys from xterm.js, to the fake pane's keys and typing. */
function write(id, data) {
  const t = ptys.get(id);
  if (!t) return;
  const keys = { "\r": "enter", "\x7f": "backspace", "\x1b[A": "up", "\x1b[B": "down" };
  if (keys[data]) key(t.surface, keys[data]);
  else input(t.surface, data);
  t.draw();
}

/** The New workspace form's Create: the steps, then a working agent. */
async function create(form, ch) {
  const step = (s, phase, detail = "") => ch?.onmessage?.({ step: s, phase, detail });
  const branch = form.branch.includes("/") ? form.branch : `sam/${form.branch}`;
  const name = branch.split("/").pop();
  const path = `${TREES}/${name}`;
  step("fetch", "start");
  await wait(700);
  step("fetch", "done", "origin/main at 3f2c1a9");
  step("worktree", "start");
  await wait(900);
  step("worktree", "done", `~${path.slice(HOME.length)}`);
  step("fixups", "start");
  await wait(1100);
  step("fixups", "done", "npm ci · hooks installed");
  if (form.sandbox) {
    step("sandbox", "start");
    await wait(900);
    step("sandbox", "done", `${form.sandbox} sandbox up`);
  }
  step("workspace", "start");
  await wait(800);
  const n = ws.length + 1;
  const w = {
    key: "fresh", id: `F6B8DAEC-5A7C-4EB6-9F48-0BCDE6A8C9${String(n).padStart(2, "0")}`, ref: `workspace:${n}`, title: name, color: "#a7c080",
    branch, surface: `0F5D6BCC-B8A7-4C5A-8D6F-5B8C0D2E4F${String(n).padStart(2, "0")}`, agent: "claude", state: "working", sinceMin: 0, since: Date.now(), plan: null,
  };
  byKey.fresh = w;
  const prompt = form.prompt || `Start on ${name}`;
  pane(w.surface, {
    body: () => [...welcome(w), ...you(prompt), ...say("I'll start by reading how checkout is put together."), ...tool("Read", "src/checkout/route.js", "Read 38 lines")],
    spin: () => spinner("Reading the code", w.since, 0.3),
    mode: "⏵⏵ accept edits on (shift+tab to cycle)",
  });
  ws.push(w);
  step("workspace", "done", w.ref);
  push();
  return { path, branch, workspaceRef: w.ref, workspaceId: w.id };
}

// ---------------------------------------------------------------- the commands

const LOOK = { palette: {}, background: THEME.background, foreground: THEME.foreground, cursor: THEME.cursor, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 };
const CARD = {
  kind: "pr", number: 41, title: "Reindex search when a product is renamed", state: "MERGED", author: "sam-rivera", branch: "sam/search-index",
  checks: [6, 0, 0], review: "APPROVED", additions: 96, deletions: 11, excerpt: "A rename writes a reindex job; the worker picks it up within a second.", labels: ["search"],
};

const handlers = {
  backend_status: () => ({ state: "connected", backend: "cmux", transport: "socket", access_mode: null, workspaces: ws.map((w) => ({ id: w.id, ref: w.ref, title: w.title })) }),
  wall_frame: wallFrame,
  views_frame: viewsFrame,
  wall_reply: ({ surfaceId, text }) => reply(surfaceId, text),
  wall_jump: () => null,
  desk_cleanup_plan: () => [],
  desk_cleanup_run: () => ({ ok: true, steps: [] }),
  hide_overlay: () => null,
  home_dir: () => HOME,
  intent_server: () => INTENT,
  intent_page: async ({ path }) => {
    if (!INTENT.up) throw "the intent server is down";
    if (PAGES && boardFromIntent) return 200;
    const r = await fetch(`/__demo/page?path=${encodeURIComponent(path)}`).then((x) => x.json()).catch(() => ({ code: 0 }));
    return r.code;
  },
  open_in_cmux: () => null,
  open_in_vscode: ({ dir }) => ({ folder: dir, note: null }),
  open_in_editor: () => null,
  open_url: () => null,
  copy_text: () => null,
  gh_card: ({ url }) => (/\/pull\/41\b/.test(url) ? CARD : null),

  term_look: () => LOOK,

  // Native panes: every demo pane is one, its ANSI lines redrawn as they change.
  pty_native: ({ surfaceId }) => panes.has(surfaceId) && !plainPanes.has(surfaceId),
  pty_reset: () => null,
  pty_attach: ({ surfaceId, cols, onData }) => attach(surfaceId, cols, onData),
  pty_detach: ({ id }) => (detach(id), null),
  pty_write: ({ id, data }) => (write(id, data ?? ""), null),
  pty_resize: ({ id, cols }) => (resize(id, cols), null),
  pty_scroll: () => null,
  pty_leave_scroll: () => null,
  pty_line_key: () => null,
  pty_seen: () => null,
  pty_shell: () => false,
  pty_paths: () => [],
  pty_workspace: () => null,

  workspace_sessions: ({ workspace }) => {
    const w = ws.find((x) => x.id === workspace);
    if (!w || !w.agent) return [];
    const sid = SESS[w.key] || "7d0a5c6e-cf8b-4abc-9e5d-6b7c8d9eafb4";
    return [
      { id: sid, cwd: treeOf(w), updated: secs(w.since), active: true, label: LABELS[w.key] },
      { id: sid.replace(/^.{4}/, "9e2b"), cwd: treeOf(w), updated: secs(ago(60 * 20)), active: false, label: "earlier: read the checkout code" },
    ];
  },
  session_resume: () => null,
  native_session: () => {
    throw "native sessions need a real cmux";
  },
  // The pane becomes native; the real one resumes Claude in a new pane.
  move_native: ({ surfaceId }) => {
    if (!plainPanes.delete(surfaceId)) throw "this pane is native already";
    return surfaceId;
  },

  tuck_set: ({ path, level }) => {
    tucked = tucked.filter((r) => r.path !== path);
    push();
    return level;
  },
  tuck_restore: ({ path }) => {
    tucked = tucked.filter((r) => r.path !== path);
    push();
    return null;
  },
  tuck_unmute_all: () => {
    const n = tucked.filter((r) => r.level === "mute").length;
    tucked = tucked.filter((r) => r.level !== "mute");
    push();
    return n;
  },

  wake_data: ({ ws: dir, q }) => {
    const all = wakeRows();
    const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const rows = all.filter((r) => (!dir || r.ws === dir) && words.every((x) => `${r.title} ${r.kind} ${r.prompt} ${r.path}`.toLowerCase().includes(x)));
    const trees = new Map();
    for (const r of all) {
      const t = trees.get(r.ws) ?? { ws: r.ws, n: 0, last: r.created_at, name: r.ws.split("/").pop(), here: true };
      t.n++;
      if (r.created_at > t.last) t.last = r.created_at;
      trees.set(r.ws, t);
    }
    const workspaces = [...trees.values(), { ws: `${TREES}/legacy-cart`, n: 6, last: iso(ago(60 * 26)), name: "legacy-cart", here: false }].sort((a, b) => (a.last < b.last ? 1 : -1));
    return { ws: dir ?? "", rows: rows.map(strip), limit: 500, truncated: false, workspaces };
  },
  wake_open: () => ({ sheet: null, detail: "opened in cmux" }),
  wake_file: () => {
    throw "the demo has no files to show";
  },
  wake_keep: () => ({ path: `${HOME}/.claude/crew/kept/coupon-totals.json` }),
  wake_keep_all: () => ({ results: [{ ok: true }] }),
  wake_publish: () => "publishing needs a real Claude account",

  review_jobs: () => jobs,
  review_others: () => others,
  review_findings: ({ id }) => FINDINGS[id] ?? [],
  review_suggest: () => ({
    requested: [{ input: `${GH}#45`, repo: GH, title: "Show the discount on the receipt", updated: secs(ago(90)) }],
    mine: [
      { input: `${GH}#44`, repo: GH, title: "Take coupon codes at checkout", updated: secs(ago(9)) },
      { input: `${GH}#43`, repo: GH, title: "Clear errors for bad coupon codes", updated: secs(ago(52)) },
    ],
    branches: [{ input: `${GH}@sam/coupons-ui`, repo: GH, title: "sam/coupons-ui", updated: secs(ago(5)) }],
    problem: "",
  }),
  review_start: ({ input: inp, depth, model }) => {
    const id = `j-${jobs.length + 50}`;
    jobs = [...jobs, { ...jobs[1], id, input: inp, depth, model, status: "resolving", started: secs(Date.now()), stage_at: secs(Date.now()), activity: "Asking GitHub", log: [`resolving ${inp}`] }];
    void emit("review:frame", jobs);
    return id;
  },
  review_remove: ({ id }) => {
    jobs = jobs.filter((j) => j.id !== id);
    void emit("review:frame", jobs);
    return null;
  },
  review_fix: () => null,
  review_post: () => null,
  review_push: () => null,

  new_ws_options: () => ({
    repos: [
      { name: "shop", path: REPO, base: "origin/main" },
      { name: "shop-admin", path: `${HOME}/code/shop-admin`, base: "origin/main" },
      { name: "design-tokens", path: `${HOME}/code/design-tokens`, base: "origin/trunk" },
    ],
    prefix: "sam/",
    remote: false,
    sandbox: true,
  }),
  new_ws_create: ({ form, onStep }) => create(form, onStep),

  reclaim_check: async ({ ws: id }) => {
    await wait(900);
    return reclaimReport(id);
  },
  reclaim_run: async ({ ws: id }) => {
    await wait(1400);
    const w = ws.find((x) => x.id === id);
    if (!w) return { ok: false, steps: [{ kind: "error", text: "that workspace is gone" }] };
    ws.splice(ws.indexOf(w), 1);
    push();
    return {
      ok: true,
      steps: [
        { kind: "done", text: `Closed ${w.title} (${w.ref}) in cmux` },
        { kind: "done", text: `Removed the worktree ~${treeOf(w).slice(HOME.length)} (184 MB)` },
        { kind: "done", text: `Deleted the branch ${w.branch}` },
        { kind: "note", text: `origin/${w.branch} is left for GitHub to clean up` },
      ],
    };
  },
};

/** Commands the views never named: logged once, answered with null. */
const unknown = new Set();
mockWindows("main");
mockIPC(
  async (cmd, args) => {
    const h = handlers[cmd];
    if (h) return h(args ?? {});
    // The window and webview plugins (drag-and-drop, window state): nothing to do.
    if (cmd.startsWith("plugin:")) return null;
    if (!unknown.has(cmd)) {
      unknown.add(cmd);
      console.warn(`[demo] no mock for ${cmd}`, args);
    }
    return null;
  },
  { shouldMockEvents: true },
);

// Live: the spinners turn, the wait clocks move, and views keep their frames.
setInterval(push, 2000);
setTimeout(push, 300);
window.__seamuxDemo = { answer, reply, push, ws, panes, handlers };
