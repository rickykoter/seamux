// The fake cmux behind the demo: every Tauri command the app's pages invoke,
// answered from the demo world, and the wall and views frames pushed as
// events so the panes look live. Loaded by vite.config.mjs before main.ts.
//
// The shapes are the Rust side's (app/crates/seamux-app/src): wall.rs Frame
// and Tile, views.rs ViewsFrame, pty_app.rs's native terminal (bytes over a Channel),
// crew-board wake.rs wake_data, review_app.rs jobs, reclaim.rs Report,
// newws_app.rs Options, sessions.rs SessionRow, shell.rs IntentServer.
//
// The scroll lab's page (/scroll-lab, vite.config.mjs) draws surfaces named
// SCROLL-LAB-*: each is a fake fullscreen Claude (scrollclaude.mjs). A write
// to one reaches it ?ipc= ms later (2 by default), as a Tauri invoke does,
// and each wheel report scrolls it ?speed= lines (1 by default).
//
// Query parameters (on the app's URL):
//   ?intent=http://127.0.0.1:PORT  frame plans, reviews and asks from that
//                                  server (proxied by the stand-in, which
//                                  keeps serving the demo board)
//   &board=intent                  take /board from that server too
//   ?intent=none                   no intent server at all: the down states
//   &backend=tmux                  the app's own tmux, not cmux: cmux-only
//                                  controls hide
//   &plain=checkout,api            those workspaces' panes are not native: the
//                                  Dock shows Move to native for them
//
// Links in a pane, for a tour: type them into a pane (a digit stays in the
// message once typing has begun), or have a pane print one with
// window.__seamuxDemo.print("api", "see notes/error-codes.md"), by the
// workspace's key in world.mjs (checkout, api, ui, search, docs). The
// terminal draws on a WebGL canvas; to find a line's text in the DOM, set
// localStorage "seamux.scrollLab" to {"renderer":"dom"} before the page loads
// (xterm then draws a .xterm-rows div per line), and hover a link before
// clicking it. A path with a file extension is taken to exist, Markdown and
// pictures render, a path under a missing/ folder is gone, and
// window.__seamuxDemo.opened lists what the app asked to open elsewhere
// (open_url, open_in_editor, open_in_cmux).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { QUESTION, HOME, REPO, TREES, GH, WORKSPACES, byKey, treeOf } from "./world.mjs";
import { FakeClaude } from "./scrollclaude.mjs";

const T0 = Date.now();
const MIN = 60_000;
const ago = (min) => T0 - min * MIN;
const secs = (ms) => Math.floor(ms / 1000);
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- intent

const params = new URLSearchParams(location.search);
const intentArg = params.get("intent") ?? "";
const boardFromIntent = params.get("board") === "intent";
const backend = params.get("backend") === "tmux" ? "tmux" : "cmux";
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
    ...tool("Bash", "gh pr merge 41 --squash", "Blocked by bash-guard: gh pr merge", "A PR merge is yours: the banner above can run it."),
    C.user("! gh pr merge 41 --squash "),
    `  ${C.ok("✓")} Squashed and merged pull request #41`,
    "",
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
  body: () => [
    ...welcome(W.docs),
    ...you("go 1"),
    ...tool("Update", "docs/help/coupons.md", "Updated docs/help/coupons.md with 22 additions"),
    ...tool("Bash", "npm run lint", `${C.ok("✓")} 23 files, 0 problems`),
    ...tool("Bash", "deep-plan deliver docs-copy", "plan docs-copy delivered (1/1)"),
    ...tool("Bash", "deep-plan ship docs-copy", "pushed sam/docs-copy; opened " + `https://github.com/${GH}/pull/45`, "at auto-pr, PR #45 is open for a person to merge"),
    ...you("merge it"),
    ...tool("Bash", "gh pr merge 45 --squash", "Blocked by bash-guard: gh pr merge", "A PR merge is yours: the banner above can run it."),
    ...say(
      "bash-guard held the merge for you. Run it from the banner (or allow PR #45 for this session),",
      "or press Ship it at the PR's Merge stage in Lookout, which merges it through deep-plan ship.",
    ),
  ],
  mode: "? for shortcuts",
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

// What the app asked to open somewhere else (the browser, VS Code, cmux): kept
// in order, and said on the console, so a tour can tell where a link went.
const opened = [];
function opening(cmd, args) {
  opened.push({ cmd, ...args });
  console.info(`[demo] ${cmd}`, JSON.stringify(args ?? {}));
  return null;
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
  // Pictures, a video and a page from one prompt: what the Wake's preview flips through.
  [18, "api", "image", "checkout-after.png", 30, { path: `${TREES}/coupons-api/docs/checkout-after.png`, prompt: "go 2" }],
  [19, "api", "image", "coupon-error.png", 29, { path: "/tmp/claude/coupon-error.png", prompt: "go 2", state: "risk" }],
  [20, "api", "temp", "checkout-walkthrough.webm", 28, { path: "/tmp/claude/checkout-walkthrough.webm", prompt: "go 2" }],
  [21, "api", "temp", "totals-report.html", 27, { path: "/tmp/claude/totals-report.html", prompt: "go 2" }],
];

/** A stand-in screenshot for a Wake image row: a checkout card in the row's hue. */
function demoShot(id) {
  const hue = (Number(id) * 67) % 360;
  const title = WAKE.find(([i]) => String(i) === String(id))?.[3] ?? "image";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
<rect width="1280" height="800" fill="hsl(${hue} 30% 92%)"/><rect x="0" y="0" width="1280" height="64" fill="hsl(${hue} 35% 30%)"/>
<text x="40" y="42" font-family="-apple-system,sans-serif" font-size="24" fill="#fff">Checkout</text>
<rect x="340" y="140" width="600" height="520" rx="18" fill="#fff" stroke="hsl(${hue} 20% 80%)"/>
<text x="380" y="200" font-family="-apple-system,sans-serif" font-size="28" fill="#222">Order summary</text>
${[0, 1, 2].map((i) => `<rect x="380" y="${240 + i * 60}" width="${420 - i * 70}" height="18" rx="9" fill="hsl(${hue} 15% 85%)"/>`).join("")}
<rect x="380" y="440" width="380" height="48" rx="10" fill="none" stroke="hsl(${hue} 40% 55%)" stroke-width="2"/>
<text x="398" y="472" font-family="ui-monospace,monospace" font-size="20" fill="#555">SPRING25</text>
<rect x="380" y="560" width="520" height="60" rx="12" fill="hsl(${hue} 45% 45%)"/>
<text x="560" y="598" font-family="-apple-system,sans-serif" font-size="22" fill="#fff">Place order</text>
<text x="40" y="770" font-family="ui-monospace,monospace" font-size="18" fill="hsl(${hue} 20% 45%)">${title}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
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
// Every workspace's open pages, as views.rs sends them: framed from the
// stand-in's placeholder unless a real intent server is given (PAGES).
const pages = () =>
  PAGE_LIST.filter(([k]) => ws.some((w) => w.key === k)).map(([k, kind, path, label, state, waiting]) => ({ ws: byKey[k].id, kind, path, label, state, waiting, since: ago(10) }));
let tucked = [
  { path: `${TREES}/legacy-cart`, level: "tuck", at: ago(60 * 26), name: "legacy-cart", branch: "sam/legacy-cart", workspaces: [], waiting: false, last: ago(60 * 26) },
  { path: `${TREES}/gift-cards`, level: "tuck", at: ago(60 * 50), name: "gift-cards", branch: "sam/gift-cards", workspaces: [], waiting: false, last: ago(60 * 49) },
  { path: `${TREES}/perf-spike`, level: "mute", at: ago(60 * 3), name: "perf-spike", branch: "sam/perf-spike", workspaces: [], waiting: false, last: ago(95) },
  // Snoozed to the top of the hour after next: search says "until 3 PM".
  { path: `${TREES}/tax-rounding`, level: "snooze", until: Math.ceil(T0 / 3_600_000) * 3_600_000 + 3_600_000, at: ago(40), name: "tax-rounding", branch: "sam/tax-rounding", workspaces: [], waiting: false, last: ago(42) },
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
    // Each workspace's branch, as views.rs reads it from its worktree.
    branches: Object.fromEntries(ws.filter((w) => w.branch).map((w) => [w.id, w.branch])),
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
const OTHER_FINDINGS = {
  "rv-coupons-inc1": [
    { id: "f1", file: "src/checkout/total.js", line: 14, severity: "minor", summary: "A coupon over the cart total makes the total negative", status: "open" },
  ],
};

// The workspaces' PRs (land_watch.rs workspace_prs: crew-sync's lists with
// their worktree), the landing of #41's merge (landing_get), and what ship
// says of each open PR's worktree (ship_view). #41 and #44 are the PRs the
// reviews above cover; #43 is one no review covers yet. #45 is a delivered
// plan at auto-pr with green checks: the Merge stage offers Ship it there,
// and the mock's ship_merge merges it.
const MERGE_41 = "4f1c2ab9e07d3c5a81b6e2d94f0a7c3e5b8d1f26";
const prUrl = (n) => `https://github.com/${GH}/pull/${n}`;
const prRow = (w, o) => ({ cwd: treeOf(w), ws: w.id, ws_title: w.title, url: prUrl(o.n), review: "", conflict: false, failing: [], gating: [], ...o });
const PRS = [
  prRow(W.search, {
    n: 41, title: "Reindex search when a product is renamed", state: "merged", review: "APPROVED",
    checks: { fail: 0, run: 0, pass: 6, gate: 0, unseen: 0 }, merge: { sha: MERGE_41, at: iso(ago(38)), base: "main" },
  }),
  prRow(W.api, { n: 44, title: "Take coupon codes at checkout", state: "open", review: "REVIEW_REQUIRED", checks: { fail: 0, run: 2, pass: 4, gate: 0, unseen: 0 } }),
  prRow(W.checkout, {
    n: 43, title: "Clear errors for bad coupon codes", state: "draft", checks: { fail: 1, run: 0, pass: 5, gate: 0, unseen: 0 },
    failing: [{ name: "test / checkout", url: `https://github.com/${GH}/actions/runs/1187` }],
  }),
  prRow(W.docs, { n: 45, title: "Coupon codes in the help pages", state: "open", review: "", checks: { fail: 0, run: 0, pass: 3, gate: 0, unseen: 0 } }),
];
const landStage = (name, status, startMin, endMin) => ({ name, status, ...(startMin != null ? { start: ago(startMin) } : {}), ...(endMin != null ? { end: ago(endMin) } : {}) });
const landing41 = {
  state: {
    pr: "41",
    merge: MERGE_41,
    recipes: {
      deploy: {
        key: "deploy", name: "Deploy the shop", status: "running",
        stages: [landStage("build", "done", 37, 34), landStage("deploy", "running", 34), landStage("live", "pending")],
        version: { expect: MERGE_41.slice(0, 7), live: "9a3e7c1", match: false },
        links: [{ label: "Deploy run", url: `https://github.com/${GH}/actions/runs/1192` }],
      },
      notebook: {
        key: "notebook", name: "Rollout notebook", status: "awaiting",
        stages: [landStage("notebook", "pending")],
      },
    },
  },
  overall: { status: "landing", stage: "deploy", recipe: "deploy", live: false },
};
const LAND_LOG = {
  deploy: ["$ npm ci", "added 412 packages in 9s", "$ npm run build", "built dist/ in 3.1s", "$ scripts/deploy.sh", "uploading dist/ (2.4 MB)", "waiting on the rollout: 2 of 4 hosts"],
  notebook: ["waiting for a person to approve: this recipe writes a rollout notebook"],
};
const SHIP = {
  [treeOf(W.api)]: {
    plan: "demo-coupons", level: "auto-merge", levelBy: "src/** (auto-merge)",
    policy: { source: "origin/main", ref: "origin/main", why: "" },
    gates: [
      { gate: "delivered", ok: false, why: "increment 2 of 3 is still working" },
      { gate: "checks", ok: false, why: "2 checks are running" },
      { gate: "conflict", ok: true, why: "" },
    ],
    action: "wait", waits: ["the plan is delivered", "its checks are green"],
  },
  [treeOf(W.checkout)]: {
    plan: "checkout-errors", level: "auto-pr", levelBy: "default (auto-pr)",
    policy: { source: "origin/main", ref: "origin/main", why: "" },
    gates: [{ gate: "delivered", ok: false, why: "increment 2 of 4 is waiting on you" }],
    action: "wait", waits: ["the plan is delivered"],
    pr: { number: 43, url: prUrl(43), state: "OPEN", draft: true },
  },
  [treeOf(W.docs)]: {
    plan: "docs-copy", level: "auto-pr", levelBy: "docs/help/coupons.md: docs/** (auto-pr)",
    policy: { source: "base", ref: "origin/main", why: "origin/main:.seamux/policy.json" },
    gates: [
      { gate: "delivered", ok: true, why: "the plan is delivered" },
      { gate: "kept checkout", ok: true, why: "the kept checkout is on main, clean for the landing" },
      { gate: "pushed", ok: true, why: "the branch is pushed" },
      { gate: "token", ok: true, why: "the token reads checks and commit statuses" },
    ],
    action: "none", waits: [], say: "at auto-pr, PR #45 is open for a person to merge: ship --merge on their word",
    pr: { number: 45, url: prUrl(45), state: "OPEN", draft: false },
    observe: { level: "auto-merge", by: "docs/help/coupons.md: docs/**", action: "merge", would: "would merge", waits: [] },
    status: { state: "success", description: "ship's gates passed at auto-pr; a person merges; observe auto-merge: would merge" },
  },
};
// The one held command in the demo: Claude's gh pr merge in the docs pane,
// held by bash-guard (held_app.rs). "Run and allow" adds its PR to the
// session's merge allow; an approval would be copy only, with no allow.
let heldDocs = {
  pane: W.docs.surface, workspace: W.docs.id, session: "demo-docs", cwd: treeOf(W.docs), reason: "gh pr merge", kind: "run",
  command: "gh pr merge 45 --squash", truncated: false, branch: null, pr: `${GH}#45`, at: ago(1),
  run: true, chat: true, allow: `${GH}#45`, allowKind: "merge", lines: 1, idle: true,
};
const mergeAllow = [];
function heldAct(surface, at, act) {
  if (surface !== W.docs.surface || !heldDocs) throw "nothing is held in this pane now";
  if (at !== heldDocs.at) throw "a newer command was held since: look again";
  if (!["ran", "dismiss", "allow"].includes(act)) throw `unknown answer: ${act}`;
  if (act === "allow") mergeAllow.push(heldDocs.pr);
  heldDocs = null;
  return true;
}

/** ship_merge: deep-plan ship --merge's answer. A verdict that waits on
 *  nothing merges at once (the PR turns merged, as GitHub would tell crew);
 *  one that waits says on what, and merges nothing. */
function shipMerge(cwd) {
  const v = SHIP[cwd];
  if (!v || !v.plan) throw "ship acts on a deep-plan plan; this worktree has none";
  if (v.waits.length) return { ...v, lever: "ship --merge", action: "wait", result: { ok: true, note: "ship waits; run it again once those are met" } };
  const pr = PRS.find((p) => p.cwd === cwd && p.state === "open");
  if (!pr) throw "no open PR for this worktree";
  pr.state = "merged";
  pr.merge = { sha: "7b2e9d41c08a5f36e1d4b7c90a2f5e83d6c1b049", at: iso(ago(0)), base: "main" };
  SHIP[cwd] = { ...v, pr: { ...v.pr, state: "MERGED" }, action: "none", say: `PR #${pr.n} is merged`, observe: undefined, status: null };
  return { ...v, lever: "ship --merge", action: "merge", result: { ok: true, note: `merged PR #${pr.n} on your ship --merge; its landing runs from the app` } };
}

/** land_act: what the person did at the Land stage, as the watcher tells it. */
function landAct(merge, recipe, act) {
  if (merge !== MERGE_41) throw "no landing for that merge";
  const r = landing41.state.recipes[recipe];
  if (!r) throw `no recipe ${recipe}`;
  if (act === "approve") {
    if (r.status !== "awaiting") throw `${recipe} is not waiting on you`;
    r.status = "running";
    r.stages = [landStage("notebook", "running", 0)];
    return `approved ${recipe}; it runs on`;
  }
  if (act === "skip") {
    r.status = "skipped";
    r.stages = r.stages.map((s) => ({ ...s, status: s.status === "done" ? "done" : "skipped" }));
    return `skipped ${recipe}`;
  }
  if (act === "retry") return `retrying ${recipe}`;
  if (act === "dismiss") return "dismissed";
  throw `unknown answer: ${act}`;
}

// Radar (radar.rs radar_frame): each open workspace's edited and planned
// files. coupons-api and coupons-ui both edit total.js now; checkout-flow's
// plan reaches form.js, which coupons-ui edits.
const RADAR = {
  checkout: { editing: ["src/checkout/errors.js", "test/checkout.test.js"], planned: [{ path: "src/checkout/form.js", plan: "checkout-errors", inc: 3, title: "Show the error under the field" }] },
  api: { editing: ["src/checkout/total.js", "src/coupons/apply.js", "test/coupons.test.js"], planned: [] },
  ui: { editing: ["src/checkout/total.js", "src/checkout/form.js", "src/checkout/form.css"], planned: [{ path: "src/checkout/receipt.js", plan: "coupons-ui", inc: 2, title: "Show the discount on the receipt" }] },
  search: { editing: [], planned: [] },
  docs: { editing: ["docs/coupons.md"], planned: [] },
};
function radarFrame() {
  const contacts = ws.map((w) => ({
    ws: w.id, pane: w.surface, title: w.title, root: treeOf(w), branch: w.branch, color: w.color,
    state: w.state, editing: RADAR[w.key]?.editing ?? [], planned: RADAR[w.key]?.planned ?? [],
  }));
  const by = new Map();
  for (const c of contacts) for (const f of c.editing) by.set(f, (by.get(f) ?? 0) + 1);
  return { repos: [{ name: "shop", common: `${REPO}/.git`, contacts, collisions: [...by].filter(([, n]) => n > 1).map(([f]) => f) }] };
}

// Doctor (crew_core::doctor's scan and crew-resume's rows). The scan is the
// app's own tmux's: on cmux it answers none, as the app does.
const finding = (w, o) => ({ id: "", kind: "", class: "report", ws: w?.id ?? "", title: w?.title ?? "", cwd: w ? treeOf(w) : "", pane: w?.surface ?? "", summary: "", detail: "", session: "", subject: "", fixes: [], ...o });
let doctorFindings = [
  finding(W.checkout, {
    id: "d1", kind: "claude-exited", class: "confirm", session: SESS.checkout,
    summary: "Claude exited in its second pane 12 minutes ago", detail: "The pane is a shell now. Resuming starts claude --resume on the same conversation.",
    fixes: [{ verb: "resume", label: "Resume Claude" }],
  }),
  finding(W.search, {
    id: "d2", kind: "merged-live", class: "report",
    summary: "Its PR #41 merged 38 minutes ago, and the workspace is still open", detail: "Reclaim checks for unpushed work, then closes it and removes the worktree.",
    fixes: [{ verb: "reclaim", label: "Reclaim" }],
  }),
  finding(null, { id: "d3", kind: "orphan-pane-file", class: "safe", subject: "%41", summary: "A pane file for a pane tmux no longer has", fixes: [{ verb: "remove", label: "Remove" }] }),
  finding(null, { id: "d4", kind: "orphan-pane-file", class: "safe", subject: "%57", summary: "A pane file for a pane tmux no longer has", fixes: [{ verb: "remove", label: "Remove" }] }),
  finding(null, { id: "d5", kind: "dead-pane", class: "safe", subject: "%12", summary: "A pane whose command ended", fixes: [{ verb: "close", label: "Close" }] }),
];
const doctorScan = () => (backend === "tmux" ? { tmux: "ok", registry: "ok", findings: doctorFindings } : null);
const doctorRow = (o) => ({ state: "live", latest: "", branch: "", when: 0, exists: true, ws: "", sessions: [], transcript: "", ...o });
let doctorRows = [
  ...WORKSPACES.map((w) => doctorRow({ cwd: treeOf(w), title: w.title, branch: w.branch, ws: w.id, when: secs(ago(w.sinceMin)), latest: LABELS[w.key] ?? "", sessions: w.agent ? [SESS[w.key]] : [] })),
  doctorRow({ cwd: `${TREES}/legacy-cart`, state: "archived", title: "legacy-cart", branch: "sam/legacy-cart", when: secs(ago(60 * 26)), latest: "Move the cart's totals into one module", sessions: ["5b2c9e10-4a7d-4f3e-8c61-2d9e0b7a4f15"] }),
  doctorRow({ cwd: `${TREES}/receipt-copy`, state: "past", title: "receipt-copy", branch: "sam/receipt-copy", when: secs(ago(60 * 52)), latest: "Reword the receipt's footer", sessions: ["c41e8a2b-7d90-4b15-a3e6-9f0c2d4b8e71"] }),
  doctorRow({ cwd: `${TREES}/old-spike`, state: "gone", title: "old-spike", branch: "", exists: false, when: secs(ago(60 * 24 * 9)), latest: "Try a second search index" }),
];
/** An All workspaces row's verb (doctor_archive, _restore, _forget, _resume). */
function rowAct(verb, cwd) {
  const r = doctorRows.find((x) => x.cwd === cwd);
  if (!r) throw "no workspace at that folder";
  const to = { archive: ["live", "archived", "archived"], restore: ["archived", "live", "restored"], resume: ["past", "live", "resumed"] }[verb];
  if (verb === "forget") {
    if (r.state !== "archived") throw `${r.title} is not archived`;
    doctorRows = doctorRows.filter((x) => x !== r);
    return `forgot ${r.title}`;
  }
  if (r.state !== to[0]) throw `${r.title} is ${r.state}, not ${to[0]}`;
  r.state = to[1];
  r.when = secs(Date.now());
  return `${to[2]} ${r.title}`;
}

// The Dock's strips. coupons-api's Claude has two background shells (bg_app.rs):
// its dev server, still running, and a test run that passed.
const bgShells = new Map([
  [W.api.surface, [
    { id: "b1", command: "npm run dev -- --port 5173", label: "npm run dev", state: "running", exit: null, at: ago(31), ended: null,
      tail: "  VITE v5.4.2  ready in 412 ms\n  ➜  Local:   http://localhost:5173/\n  page reload src/checkout/total.js" },
    { id: "b2", command: "npm test -- coupons", label: "npm test", state: "done", exit: 0, at: ago(6), ended: ago(5.6),
      tail: " ✓ test/coupons.test.js (9 tests) 41ms\n Test Files  1 passed (1)\n      Tests  9 passed (9)" },
  ]],
]);
const shellsOf = (surface, tails) => (bgShells.get(surface) ?? []).map((s) => (tails ? s : { ...s, tail: undefined }));
function stopShell(surface, id) {
  const s = (bgShells.get(surface) ?? []).find((x) => x.id === id);
  if (!s || s.state !== "running") return 0;
  Object.assign(s, { state: "cancelled", exit: 143, ended: Date.now() });
  return 1;
}
// The palette's preview of a Claude workspace (sessions.rs LastExchange).
const EXCHANGE = {
  checkout: ["Expired codes should get their own message, not the generic one.", "I'll add an expired check before the lookup. One question first: should an expired code answer 422 or 400?"],
  api: ["Apply the coupon in total(), after tax.", "Done: total() now takes the coupon and applies it after tax. The test watcher is green; I'm adding a case for a coupon over the cart total."],
  ui: ["Put the coupon field above the total, with its error under it.", "Wiring the field into the checkout form now: it posts to /api/coupons/apply and shows the server's message under the input."],
  search: ["Merge it once the checks pass.", "PR #41 merged into main. The worktree has nothing unpushed, so it can be reclaimed."],
};
/** A workspace's PRs as the Wake lists them (crew-sync's list for its worktree). */
function wakePrs(dir) {
  const d = (dir ?? "").replace(/\/+$/, "");
  return PRS.filter((p) => p.cwd === d).map(({ cwd, ws: _ws, ws_title, ...p }) => ({ ...p, branch: WORKSPACES.find((w) => treeOf(w) === cwd)?.branch, updatedAt: iso(ago(p.n === 41 ? 38 : 9)) }));
}

// Reclaim. The fixes the wizard ran, by workspace: each clears its blocker.
const reclaimFixed = new Map();
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
        { kind: "info", text: "1 Wake row points into the worktree", hint: "The Wake keeps its entry; the file goes with the worktree." },
        { kind: "skip", text: "No sandbox to stop", hint: null },
      ]
    : (() => {
        const fixed = reclaimFixed.get(id) ?? new Set();
        const gone = (...f) => f.some((x) => fixed.has(x));
        return [
          { kind: "fail", id: "merged", text: "3 commit(s) not in origin/main — not merged", hint: null,
            items: ["a41c9e2 Tighten the coupon expiry check", "7be0d13 Coupon codes are case-blind", "19f3a7c Wire coupons into checkout"] },
          gone("stash", "discard")
            ? pass("clean tree, nothing uncommitted", null)
            : { kind: "fail", id: "dirty", text: "2 uncommitted change(s)", hint: null, items: [" M src/coupons/expiry.ts", "?? notes/coupon-edge-cases.md"], fixes: ["stash", "discard"] },
          gone("aside", "delete-ignored")
            ? pass("no ignored files that would be lost (build output and caches aside)")
            : { kind: "fail", id: "ignored", text: "1 ignored file(s) would be deleted with it: .env.local",
                hint: "git status does not show these and git worktree remove does not ask — move them out first", items: [".env.local"], fixes: ["aside", "delete-ignored"] },
          w.agent ? { kind: "fail", id: "agent", text: "an agent is mid-turn in the workspace — let the turn end first", hint: null } : pass("No agent is running"),
        ];
      })();
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
    // In crew-reclaim's order and words (crew/bin/crew-reclaim, "removes").
    remove: [
      { what: "worktree", target: treeOf(w), note: merged ? "184 MB" : "212 MB" },
      { what: "branch", target: w.branch, note: "safe delete; kept if git declines" },
      { what: "workspace", target: w.title, note: "closed first, with whatever runs in it" },
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
  // A digit picks an answer, as Claude's question box takes it, but only
  // before anything is typed: a message's own digits (a port) stay in it.
  if (p.question !== undefined && p.question !== null && /^[1-9]$/.test(text) && !p.input) {
    answer(Number(text));
    return;
  }
  if (text === "\r") return key(surface, "enter");
  p.input += text.replace(/[\x00-\x1f]/g, "");
}

// ── native terminals: a pane's screen as bytes for xterm.js ─────────────────

/** The scroll lab's fake Claudes, by terminal id. */
const labPtys = new Map();
const isLab = (surface) => typeof surface === "string" && surface.startsWith("SCROLL-LAB-");
const ipcMs = Math.max(0, Number(params.get("ipc") ?? 2) || 0);
const labSpeed = Math.max(1, Number(params.get("speed") ?? 1) || 1);

function labAttach(cols, rows, frames, ch) {
  const id = 9000 + nextPty++;
  labPtys.set(id, new FakeClaude({ cols, rows, frames: frames === "raw" ? "raw" : "whole", speed: labSpeed, send: (b) => ch?.onmessage?.(b) }));
  return id;
}

/** A write to a lab pane: it gets there a moment later, and the page's
 *  invoke answers then, so writes sent one after another wait their turn. */
function labWrite(id, data) {
  return new Promise((ok) =>
    setTimeout(() => {
      labPtys.get(id)?.write(data);
      ok(null);
    }, ipcMs),
  );
}

const ptys = new Map();

/** The workspace a pane's terminal (by pty id) is in. */
function wsOfPty(id) {
  const t = ptys.get(id);
  return t ? ws.find((w) => w.surface === t.surface || w.shell?.surface === t.surface) : undefined;
}
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
// The light look, as a light terminal theme answers it (Everforest Light Med).
const LIGHT_PALETTE = ["#7a8478", "#e67e80", "#9ab373", "#c1a266", "#7fbbb3", "#d699b6", "#83c092", "#b2af9f", "#a6b0a0", "#f85552", "#8da101", "#dfa000", "#3a94c5", "#df69ba", "#35a77c", "#fffbef"];
const LIGHT_LOOK = {
  palette: Object.fromEntries(LIGHT_PALETTE.map((c, i) => [String(i), c])), background: "#efebd4", foreground: "#5c6a72", cursor: "#f57d26",
  selectionBackground: "#eaedc8", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12,
};
const CARD = {
  kind: "pr", number: 41, title: "Reindex search when a product is renamed", state: "MERGED", author: "sam-rivera", branch: "sam/search-index",
  checks: [6, 0, 0], review: "APPROVED", additions: 96, deletions: 11, excerpt: "A rename writes a reindex job; the worker picks it up within a second.", labels: ["search"],
};

// Terminals that stopped with tmux (a reboot), for the Dock's restart banner
// (migrate.ts): ?migrate=N offers N of them, and ?migratefail=K makes the
// first K fail to restart, each for its own reason. Off by default.
const MIGRATE_NAMES = ["ux-sweep", "coupons-bf", "resume-reset", "turn-ckpt", "board-snooze", "search-preview", "auto-go", "floor-plan"];
const MIGRATE_WHY = [
  (n) => `tmux could not start ${n}: its worktree is gone`,
  (n) => `claude --resume found no conversation for ${n}`,
  (n) => `tmux could not start ${n}`,
];
const migrateQ = new URLSearchParams(location.search);
const migrateFail = Number(migrateQ.get("migratefail") || 0);
let migrateOffers = MIGRATE_NAMES.slice(0, Number(migrateQ.get("migrate") || 0)).map((n, i) => ({
  kind: "restart", pane: `P${i}`, ws: `W${i}`, title: n, cwd: `~/code/shop.worktrees/${n}`, claude: `s${i}`, state: "idle", busy: false,
}));
const dropOffer = (pane) => (migrateOffers = migrateOffers.filter((o) => o.pane !== pane));

// The Bosun (app/crates/seamux-app/src/bosun_app.rs): on tmux, a live one
// drawn in the first demo pane, with two days of answers; on cmux, the note
// that it needs tmux. Asks and re-checks go into a queue nobody types.
const bosunDay = (msAgo) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
const BOSUN_LOG = (() => {
  const now = Date.now();
  const e = (id, minAgo, question, answer, sources, asker) => ({ id, at: now - minAgo * 60e3, question, answer, sources, asker });
  // A morning report run (crew_core::bosun::reports): one section needs you,
  // one is fine, one was not checked because its server needs a login.
  const morning = {
    ...e("r1", 20, "Morning report",
      "- Pull requests: #812 waits 2 days on your review\n- Tickets: nothing changed since yesterday\n- Monitors: Not checked: datadog needs authentication", [
        { kind: "github", ref: "https://github.com/acme/shop/pull/812", label: "PR 812" },
        { kind: "doc", ref: "https://claude.ai/artifact/morning-report", label: "Morning report doc" },
      ], "report:morning"),
    report: {
      id: "morning", run: "r1", title: "Morning report", doc: "https://claude.ai/artifact/morning-report",
      sections: [
        { title: "Pull requests", status: "needs", line: "#812 waits 2 days on your review" },
        { title: "Tickets", status: "ok", line: "nothing changed since yesterday" },
        { title: "Monitors", status: "unchecked", line: "Not checked: datadog needs authentication", why: "datadog needs authentication" },
      ],
    },
  };
  const today = [
    morning,
    e("b2", 40, "What's open on checkout-api?", "3 PRs open: #812 waits on review, #815 has red CI, #819 is a draft.", [
      { kind: "github", ref: "https://github.com/acme/shop/pull/812", label: "PR 812" },
      { kind: "github", ref: "https://github.com/acme/shop/pull/815", label: "PR 815" },
    ], "app"),
    e("b1", 180, "Is PROJ-311 still blocked?", "Yes. It waits on #815, whose CI is red on the payments contract test.", [
      { kind: "jira", ref: "PROJ-311", label: "PROJ-311" },
    ], "ask:checkout-flow"),
  ];
  const yesterday = [
    e("b0", 26 * 60, "p95 latency on orders over the last 24h?", "180ms, inside the 250ms budget. One spike at 14:05 to 610ms.", [
      { kind: "datadog", ref: "https://app.datadoghq.com/dashboard/orders", label: "orders dashboard" },
    ], "loop:systems"),
  ];
  return { [bosunDay(0)]: today, [bosunDay(86400e3)]: yesterday };
})();
const bosunQueue = [];
const bosunStatus = () =>
  backend === "tmux"
    ? { backend, tmux: true, known: true, live: true, ws: "WBOSUN", pane: [...panes.keys()][0], state: "idle", session: "bosun", day: bosunDay(0), root: `${HOME}/code` }
    : { backend, tmux: false, known: false, live: false, why: "The Bosun runs on the app's tmux backend; this app runs on cmux." };

const handlers = {
  bosun_status: bosunStatus,
  bosun_ensure: () => {
    if (backend !== "tmux") throw "The Bosun runs on the app's tmux backend; this app runs on cmux.";
    return bosunStatus();
  },
  bosun_log: ({ day } = {}) => {
    const today = bosunDay(0);
    const d = day ?? today;
    return { day: d, today, days: Object.keys(BOSUN_LOG).sort().reverse(), entries: BOSUN_LOG[d] ?? [] };
  },
  bosun_send: ({ text }) => {
    if (backend !== "tmux") throw "The Bosun runs on the app's tmux backend; this app runs on cmux.";
    bosunQueue.push(text);
    return `q${bosunQueue.length}`;
  },
  bosun_report_run: ({ id }) => {
    if (backend !== "tmux") throw "The Bosun runs on the app's tmux backend; this app runs on cmux.";
    bosunQueue.push(`[Report ${id}]`);
    return `run${bosunQueue.length}`;
  },
  migrate_offers: () => migrateOffers,
  migrate_apply: async ({ pane }) => {
    await new Promise((r) => setTimeout(r, 150));
    const o = migrateOffers.find((x) => x.pane === pane);
    const at = Number(pane.slice(1));
    if (at < migrateFail) {
      // As the app's restart does, a failure keeps the gone pane on offer.
      throw MIGRATE_WHY[at % MIGRATE_WHY.length](o ? o.title : pane);
    }
    dropOffer(pane);
    return `restarted ${o ? o.title : pane}`;
  },
  migrate_forget: ({ pane }) => (dropOffer(pane), null),
  backend_status: () => ({ state: "connected", backend, transport: backend === "cmux" ? "socket" : "tmux", access_mode: null, workspaces: ws.map((w) => ({ id: w.id, ref: w.ref, title: w.title })) }),
  wall_frame: wallFrame,
  views_frame: viewsFrame,
  wall_reply: ({ surfaceId, text }) => reply(surfaceId, text),
  wall_jump: () => null,
  desk_cleanup_plan: () => [],
  desk_cleanup_run: () => ({ ok: true, steps: [] }),
  hide_overlay: () => null,
  focus_tab: () => null,
  focus_away: () => null,
  home_dir: () => HOME,
  intent_server: () => INTENT,
  // A plan's scenarios page key (shell.rs scenarios_key): the demo seals
  // none, so it answers as the app does for a plan without scenarios.
  scenarios_key: ({ slug }) => { throw `${slug} has no sealed scenarios yet: deep-plan scenarios write ${slug}`; },
  intent_page: async ({ path }) => {
    if (!INTENT.up) throw "the intent server is down";
    if (PAGES && boardFromIntent) return 200;
    const r = await fetch(`/__demo/page?path=${encodeURIComponent(path)}`).then((x) => x.json()).catch(() => ({ code: 0 }));
    return r.code;
  },
  // shell.rs cmux_path_ok: every seamux page and a plain query, nothing else.
  open_in_cmux: (a) => {
    const [path, query = ""] = String(a?.path ?? "").split("?", 2);
    const ok = /^\/(plan|review|ask|agent|run|runs)\/[A-Za-z0-9._\/-]+$/.test(path) && !/\.\.|\/\//.test(path + "?" + query) && /^[A-Za-z0-9._=&%\/-]*$/.test(query);
    if (!ok) throw `not a page cmux opens from here: ${JSON.stringify(a?.path)}`;
    return opening("open_in_cmux", a);
  },
  open_in_vscode: ({ dir }) => ({ folder: dir, note: null }),
  // A path under a missing/ folder is gone, as a file deleted since it was
  // printed: VS Code says so, as the app's open_in_editor would.
  open_in_editor: (a) => {
    if (/\/missing\//.test(String(a?.path ?? ""))) throw `${a.path}: no such file`;
    return opening("open_in_editor", a);
  },
  open_url: (a) => opening("open_url", a),
  copy_text: () => null,
  gh_card: ({ url }) => (/\/pull\/41\b/.test(url) ? CARD : null),

  term_look: ({ dark } = {}) => (dark === false ? LIGHT_LOOK : LOOK),

  // Native panes: every demo pane is one, its ANSI lines redrawn as they change.
  pty_native: ({ surfaceId }) => isLab(surfaceId) || (panes.has(surfaceId) && !plainPanes.has(surfaceId)),
  pty_reset: () => null,
  pty_attach: ({ surfaceId, cols, rows, frames, onData }) => (isLab(surfaceId) ? labAttach(cols, rows, frames, onData) : attach(surfaceId, cols, onData)),
  pty_detach: ({ id }) => (labPtys.get(id)?.close(), labPtys.delete(id), detach(id), null),
  pty_write: ({ id, data }) => (labPtys.has(id) ? labWrite(id, data ?? "") : (write(id, data ?? ""), null)),
  pty_resize: ({ id, cols, rows }) => (labPtys.has(id) ? labPtys.get(id).resize(cols, rows) : resize(id, cols), null),
  pty_scroll: () => null,
  pty_leave_scroll: () => null,
  pty_line_key: () => null,
  pty_seen: () => null,
  pty_shell: () => false,
  // Links in a pane: a path with a file extension is taken to exist, in the
  // pane's worktree when it is relative; the pane's workspace is its own.
  pty_paths: ({ id, paths }) => {
    const w = wsOfPty(id);
    const base = w ? treeOf(w) : HOME;
    return (paths ?? []).map((q) => {
      const bare = q.replace(/:\d+(:\d+)?$/, "");
      if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(bare)) return null;
      const abs = bare.startsWith("/") ? bare : bare.startsWith("~/") ? HOME + bare.slice(1) : `${base}/${bare.replace(/^\.\//, "")}`;
      return abs;
    });
  },
  pty_workspace: ({ id }) => wsOfPty(id)?.id ?? null,

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
  // A plan, ask or review row opens as a sheet page, as the app's does with
  // here: the rest says it went to cmux.
  wake_open: ({ id, here }) => {
    const row = WAKE.find(([i]) => i === id);
    const kind = row?.[2];
    if (here && row?.[5].locator && ["plan", "ask", "review"].includes(kind)) return { sheet: `/${kind}/${row[5].locator}`, detail: "" };
    opening("wake_open", { id, here });
    return { sheet: null, detail: "opened in cmux" };
  },
  wake_file: ({ id }) => {
    if (id !== 21) throw "the demo has no files to show";
    const page = `<!doctype html><body style="font:15px -apple-system,sans-serif;padding:28px;color:#222"><h2>Coupon totals</h2>
<table cellpadding="6"><tr><th align="left">code</th><th align="right">orders</th><th align="right">saved</th></tr>
<tr><td>SPRING25</td><td align="right">412</td><td align="right">$3,180</td></tr><tr><td>WELCOME10</td><td align="right">1,094</td><td align="right">$2,207</td></tr></table></body>`;
    return { kind: "html", title: "totals-report.html", data: `data:text/html;base64,${btoa(page)}` };
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
  review_other_findings: ({ id }) => OTHER_FINDINGS[id] ?? [],
  review_other_post: ({ id }) => {
    if (!OTHER_FINDINGS[id]) throw "that review has no pull request to post to";
    return `${prUrl(44)}#pullrequestreview-2207`;
  },
  review_stop_orphan: () => null,
  notify_review_looking: () => null,

  // The change from review to release (release.ts).
  landing_prs: () => PRS,
  landing_get: ({ merge }) => (merge === MERGE_41 ? landing41 : null),
  landing_log: ({ merge, recipe }) => {
    if (merge !== MERGE_41 || !LAND_LOG[recipe]) throw "no log for that recipe";
    return LAND_LOG[recipe].join("\n");
  },
  // A worktree with no plan: ship names the level and leaves the PR to a person.
  ship_view: ({ cwd }) =>
    SHIP[cwd] ?? { plan: null, level: "auto-merge", levelBy: "src/** (auto-merge)", policy: { source: "origin/main", ref: "origin/main", why: "" }, gates: [], action: "none", waits: [] },
  land_act: ({ merge, recipe, act }) => landAct(merge, recipe, act),
  // The person's Ship it (land_watch.rs ship_merge, deep-plan ship --merge):
  // it merges a verdict with nothing to wait on, and says what a wait holds.
  ship_merge: ({ cwd }) => shipMerge(cwd),

  radar_frame: radarFrame,

  doctor_scan: doctorScan,
  doctor_rows: () => ({ rows: doctorRows, live_known: true }),
  doctor_fix: ({ id, verb }) => {
    const f = doctorFindings.find((x) => x.id === id);
    if (!f) throw "that finding is gone: scan again";
    doctorFindings = doctorFindings.filter((x) => x !== f);
    return `${verb === "resume" ? "resumed Claude in" : verb === "remove" ? "removed the pane file for" : `${verb}d`} ${f.title || f.subject}`;
  },
  doctor_fix_safe: () => {
    // No tmux workspaces on cmux, so nothing for the doctor to fix.
    if (backend !== "tmux") return [];
    const safe = doctorFindings.filter((f) => f.class === "safe" && f.fixes.length);
    doctorFindings = doctorFindings.filter((f) => !safe.includes(f));
    return safe.map((f) => ({ id: f.id, ok: true, message: "" }));
  },
  doctor_archive: ({ cwd }) => rowAct("archive", cwd),
  doctor_restore: ({ cwd }) => rowAct("restore", cwd),
  doctor_forget: ({ cwd }) => rowAct("forget", cwd),
  doctor_resume: ({ cwd }) => rowAct("resume", cwd),

  // A pane's strips and banners. Nothing is held and nothing stopped in the
  // demo, so those banners stay away, as on a quiet pane.
  wake_prs: ({ dir }) => wakePrs(dir),
  bg_shells: ({ surface, tails }) => shellsOf(surface, tails),
  bg_stop: ({ surface, id }) => stopShell(surface, id),
  pane_held: ({ surface }) => (surface === W.docs.surface ? heldDocs : null),
  held_act: ({ surface, at, act }) => heldAct(surface, at, act),
  pane_stop: () => null,
  pane_stop_cancel: () => false,
  pty_shell_run: () => null,
  clip_read: () => ({ kind: "empty" }),
  // A file a pane links to, as links_app.rs shows it: Markdown rendered, a
  // picture as itself. The demo has no PDFs or other files to show.
  link_file: ({ path }) => {
    const title = path.split("/").pop() || path;
    if (/\.(md|markdown)$/i.test(path)) {
      const page = `<!doctype html><body style="font:15px -apple-system,sans-serif;padding:24px;color:#222"><h1>${title}</h1><p>A demo file at <code>${path}</code>.</p><ul><li>BAD_CODE: the code is not one we know</li><li>EXPIRED: the code's date has passed</li></ul></body>`;
      return { kind: "html", title, data: `data:text/html;base64,${btoa(page)}` };
    }
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) return { kind: "image", title, data: demoShot(title.length) };
    throw "the demo has no such file to show";
  },
  session_last_exchange: ({ workspace }) => {
    const w = ws.find((x) => x.id === workspace);
    const x = w && EXCHANGE[w.key];
    return x ? { prompt: x[0], reply: x[1], session: SESS[w.key], at: w.since } : null;
  },
  resume_set: () => null,
  notify_looking: () => null,
  notify_take_link: () => null,

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

  // The board's diff chip on tmux (dock.ts openDiff): the review it made.
  board_diff: async () => {
    await wait(600);
    return "rv-coupons-inc1";
  },
  reclaim_check: async ({ ws: id }) => {
    await wait(900);
    return reclaimReport(id);
  },
  reclaim_fix: async ({ ws: id, action }) => {
    await wait(700);
    const w = ws.find((x) => x.id === id);
    if (!reclaimFixed.has(id)) reclaimFixed.set(id, new Set());
    reclaimFixed.get(id).add(action);
    const said = {
      stash: `stashed 2 change(s) as "crew-reclaim: ${w?.branch} 2026-11-11 10:42"`,
      discard: "discarded 2 uncommitted change(s)",
      aside: `moved 1 ignored file(s) to ${HOME}/.cache/cmux-crew/reclaimed/${(w?.branch ?? "").replace(/\//g, "-")}-20261111-104212`,
      "delete-ignored": "deleted 1 ignored file(s)",
    }[action] ?? `did ${action}`;
    return { ok: true, steps: [{ kind: "done", text: said }] };
  },
  reclaim_claude: async ({ ws: id }) => {
    await wait(500);
    return `${id}-reclaim-claude`;
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
// The Wake's images stream from the app's wakefile: scheme by row id; here, drawn.
window.__TAURI_INTERNALS__.convertFileSrc = (id, protocol) => (protocol === "wakefile" && WAKE.some(([i, , kind]) => String(i) === id && kind === "image") ? demoShot(id) : `${protocol}://localhost/${id}`);
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
// Have workspace `key`'s pane print `line` (a link to follow, for a tour).
function print(key, line) {
  const w = byKey[key];
  const p = w && panes.get(w.surface);
  if (!p) throw `no pane for ${key}`;
  p.extra.push(String(line));
}

window.__seamuxDemo = { answer, reply, push, ws, panes, handlers, opened, print };
