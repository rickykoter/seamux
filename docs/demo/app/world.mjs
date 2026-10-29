// The demo world the app runs against: repo "shop", five cmux workspaces,
// Sam Rivera at the keyboard. Nothing here reads a real cmux, plan or path.
//
// Shared by mock.js (in the page: every Tauri command's answer) and board.mjs
// (in Node: the Dock's board, built from crew/board with this cast).

export const HOME = "/home/demo";
export const REPO = `${HOME}/code/shop`;
export const TREES = `${HOME}/code/shop.worktrees`;
export const GH = "demo-shop/shop";
export const USER = "Sam Rivera";

/** The five workspaces, in cmux's sidebar order. */
export const WORKSPACES = [
  {
    key: "checkout",
    id: "A1C3E5F7-0B2D-4F61-8A93-5C7E9B1D3F01",
    ref: "workspace:1",
    title: "checkout-flow",
    color: "#dfa000",
    branch: "sam/checkout-flow",
    surface: "5A0E1C77-63B2-4D0B-9E1A-0C3D5E7F9A11",
    agent: "claude",
    state: "needs_input",
    sinceMin: 4,
    plan: { slug: "checkout-errors", title: "Clear errors for bad coupon codes", phase: "working", done: 1, total: 4, n: 2, open: true },
  },
  {
    key: "api",
    id: "B2D4F6A8-1C3E-4A72-9B04-6D8FA2C4E502",
    ref: "workspace:2",
    title: "coupons-api",
    color: "#7fbbb3",
    branch: "sam/coupons-api",
    surface: "6B1F2D88-74C3-4E1C-8F2B-1D4E6F8A0B22",
    agent: "claude",
    state: "working",
    sinceMin: 7,
    plan: { slug: "demo-coupons", title: "Take coupon codes at checkout", phase: "working", done: 1, total: 3, n: 2, open: true },
    // A second pane: the test watcher beside Claude.
    shell: { surface: "6B1F2D88-74C3-4E1C-8F2B-1D4E6F8A0B23", label: "npm test", running: "npm test -- --watch" },
  },
  {
    key: "ui",
    id: "C3E5A7B9-2D4F-4B83-8C15-7E9AB3D5F603",
    ref: "workspace:3",
    title: "coupons-ui",
    color: "#d699b6",
    branch: "sam/coupons-ui",
    surface: "7C2A3E99-85D4-4F2D-9A3C-2E5F7A9B1C33",
    agent: "claude",
    state: "working",
    sinceMin: 2,
    plan: { slug: "coupons-ui", title: "Coupon field on the checkout form", phase: "working", done: 0, total: 2, n: 1, open: true },
  },
  {
    key: "search",
    id: "D4F6B8CA-3E5A-4C94-9D26-8FABC4E6A704",
    ref: "workspace:4",
    title: "search-index",
    color: "#83c092",
    branch: "sam/search-index",
    surface: "8D3B4FAA-96E5-4A3E-8B4D-3F6A8B0C2D44",
    agent: "claude",
    state: "idle",
    sinceMin: 41,
    plan: { slug: "search-index", title: "Reindex search when a product is renamed", phase: "done", done: 3, total: 3, n: 0, open: false },
    pr: 41,
  },
  {
    key: "docs",
    id: "E5A7C9DB-4F6B-4DA5-8E37-9ABCD5F7B805",
    ref: "workspace:5",
    title: "docs-copy",
    color: "#e69875",
    branch: "sam/docs-copy",
    surface: "9E4C5ABB-A7F6-4B4F-9C5E-4A7B9C1D3E55",
    agent: null,
    state: "shell",
    sinceMin: 25,
    plan: null,
  },
];

export const byKey = Object.fromEntries(WORKSPACES.map((w) => [w.key, w]));
export const treeOf = (w) => `${TREES}/${w.title}`;

/** The question checkout-flow's agent is waiting on. */
export const QUESTION = {
  question: "Should expired codes return 422 or 400?",
  header: "Expired codes",
  multiSelect: false,
  options: [
    { label: "422 Unprocessable Entity", description: "The body parsed; the code just can't be applied. The form shows \"expired\" under the field." },
    { label: "400 Bad Request", description: "The same status as any malformed body. The client can't tell expired from garbage." },
  ],
};

/** The board's cast (crew/board render.js rows), keyed by workspace id so a
 *  click selects that workspace in the app. */
export function boardCast(nowSec) {
  const [c, a, u, s, d] = WORKSPACES;
  const sig = (t, col, h, act) => (act ? { t, c: col, h, a: act } : { t, c: col, h });
  const row = (o) => ({ said: "", chips: [], meta: "", frac: null, ...o });
  return {
    rows: [
      row({
        id: c.id, kind: "attend", name: c.title, badge: "asked you", ref: c.ref, slug: c.plan.slug,
        said: "Should expired codes return 422 or 400? The {{plan}} leaves it open.",
        frac: 0.25, branch: c.branch, dirty: true, cost: 1.84, chips: ["jump"], meta: "1/4 increments", color: c.color,
      }),
      row({
        id: a.id, kind: "running", name: a.title, badge: "working", ref: a.ref, slug: a.plan.slug,
        said: "{{Apply the coupon at checkout}} in progress.", frac: 1 / 3, branch: a.branch, dirty: true,
        cost: 3.1, chips: ["diff", "jump"], meta: "1/3 increments", color: a.color,
        family: "demo-coupons", famrole: "parent", famtier: "running", famkid: false,
        signals: [sig("● lookout", "#F5A524", "A lookout review of this branch is running")],
      }),
      row({
        id: u.id, kind: "running", name: u.title, badge: "working", ref: u.ref, slug: u.plan.slug,
        said: "{{Coupon field}} in progress.", frac: 0, branch: u.branch, dirty: true, cost: 0.92,
        chips: ["diff", "jump"], meta: "0/2 increments", color: u.color,
        family: "demo-coupons", famrole: "child", famtier: "running", famkid: true,
      }),
      row({
        id: s.id, kind: "done", name: s.title, badge: "merged", ref: s.ref, slug: s.plan.slug,
        said: "Merged. The worktree can be reclaimed.", frac: 1, branch: s.branch, pr: `#${s.pr}`, cost: 2.37,
        chips: ["reclaim", "jump"], meta: "3/3 increments", color: s.color,
      }),
      row({ id: d.id, kind: "quiet", name: `${d.title} — zsh`, badge: "", ref: d.ref, branch: d.branch, chips: ["jump"] }),
    ],
    quiet: "",
    src: "demo",
    stamp: new Date(nowSec * 1000).toTimeString().slice(0, 8),
    stale: false,
    news: {
      hours: 3,
      lede: "{{checkout-flow}} asked you a question.",
      items: [
        { tier: "attend", text: "{{checkout-flow}} asked you a question." },
        { tier: "running", text: "{{coupons-api}} started increment 2." },
        { tier: "done", text: "{{search-index}} merged as PR #41." },
      ],
    },
  };
}
