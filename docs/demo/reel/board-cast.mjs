// The board reel's cast: five board states (render.js rows) that tell its
// story. search-index finishes and ripples down, `go 3` puts checkout-flow to
// work while a new question jumps to the top, and rate-limits' red checks go
// green. Ported from docs/demo/board-demo.py's scenes when the crew Python was
// deleted; the rows are fake and inert.

const PLAN_SLUG = "example-outbox-retry";
const COLORS = {
  "checkout-flow": "#dfa000", "rate-limits": "#d699b6", "search-index": "#83c092",
  "login-copy": "#e69875", "payments-idem": "#7fbbb3",
};

const row = (o) => ({ color: COLORS[o.id], ...o });

const QUIET = [
  row({ id: "docs-site", kind: "quiet", name: "docs-site — zsh", badge: "", frac: null, branch: "dev/docs-site" }),
  row({ id: "spike-cache", kind: "quiet", name: "spike-cache — idle 3h", badge: "", frac: null, branch: "dev/spike-cache" }),
];

const LOGIN = row({
  id: "login-copy", kind: "done", name: "login-copy", badge: "MERGED", said: "Merged — {{reclaim}} when ready.",
  frac: 1, branch: "dev/login-copy", pr: "#137", cost: 2.05, chips: ["jump"], meta: "4/4 increments",
});

function checkout(state) {
  if (state === "attend") {
    return row({
      id: "checkout-flow", kind: "attend", name: "checkout-flow", badge: "PLAN GATE", slug: PLAN_SLUG,
      said: "Increment 3 ready — {{go 3}} authorizes `coupon at capture`.", frac: 0.5,
      branch: "dev/checkout-flow", dirty: true, pr: "#142", pr_state: "open", cost: 4.2,
      chips: ["go 3", "plan", "diff", "jump"], meta: "2/4 increments · checkout-flow",
    });
  }
  return row({
    id: "checkout-flow", kind: "running", name: "checkout-flow", badge: "WORKING", slug: PLAN_SLUG,
    said: "Increment 3 authorized — applying `coupon at capture`.", frac: null,
    branch: "dev/checkout-flow", dirty: true, pr: "#142", pr_state: "open", cost: 4.31,
    chips: ["plan", "diff", "jump"], meta: "3/4 increments · checkout-flow",
  });
}

function ratelimits(state) {
  if (state === "wilt") {
    return row({
      id: "rate-limits", kind: "wilt", name: "rate-limits", badge: "CHECKS RED",
      said: "Checks are red on `dev/rate-limits`.", frac: 0.75, branch: "dev/rate-limits", pr: "#139",
      pr_state: "open", cost: 11.87, chips: ["checks", "diff", "jump"], meta: "3/4 increments",
    });
  }
  return row({
    id: "rate-limits", kind: "done", name: "rate-limits", badge: "CHECKS GREEN",
    said: "Checks green — {{ready to merge}}.", frac: 1, branch: "dev/rate-limits", pr: "#139",
    pr_state: "open", cost: 12.02, chips: ["jump"], meta: "4/4 increments",
  });
}

function search(frac, said, kind = "running") {
  const done = kind === "done";
  return row({
    id: "search-index", kind, name: "search-index", badge: done ? "DONE" : "WORKING", said, frac,
    branch: "dev/search-index", dirty: !done, pr: done ? "#145" : "", pr_state: "open", cost: 0.62,
    chips: done ? ["jump"] : ["diff", "jump"],
    meta: (done ? "4/4" : frac >= 0.5 ? "2/4" : "1/4") + " increments",
  });
}

function payments(nowSec) {
  return row({
    id: "payments-idem", kind: "attend", name: "payments-idem", badge: "QUESTION", slug: PLAN_SLUG,
    said: "Reuse the idempotency table, or a new ledger? The {{plan}} carries the trade-off.",
    frac: null, branch: "dev/payments-idem", cost: 1.14, chips: ["take the check", "plan"],
    meta: "alignment check pending", feedby: nowSec + 95,
  });
}

// A deep-plan family: stage 0 has a child waiting on its gate, stage 1 has it
// working, so the card goes back to the parent's own badge.
function billing(stage) {
  const fam = { family: "billing-revamp", famtier: stage === 0 ? "attend" : "running", slug: PLAN_SLUG };
  const ledger = stage === 0
    ? row({ id: "billing-ledger", kind: "attend", name: "billing-ledger", badge: "GATE SHUT",
        said: "{{Ledger schema}} needs your go-ahead.", frac: 0.25, branch: "dev/billing-ledger",
        chips: ["go 2", "diff", "jump"], meta: "1/4 increments", color: "#e69875", famrole: "child", famkid: true, ...fam })
    : row({ id: "billing-ledger", kind: "running", name: "billing-ledger", badge: "WORKING",
        said: "{{Ledger schema}} in progress.", frac: null, branch: "dev/billing-ledger", dirty: true,
        chips: ["diff", "jump"], meta: "1/4 increments", color: "#e69875", famrole: "child", famkid: true, ...fam });
  return [
    row({ id: "billing-revamp", kind: "running", name: "billing-revamp", badge: "WORKING",
      said: "{{Split the ledger}} in progress.", frac: 0.33, branch: "dev/billing-revamp", chips: ["diff", "jump"],
      meta: "1/3 increments", color: "#d699b6", famrole: "parent", famkid: false, ...fam }),
    ledger,
    row({ id: "billing-emails", kind: "quiet", name: "billing-emails", badge: "PLAN IDLE", frac: 0,
      branch: "dev/billing-emails", chips: ["jump"], meta: "0/3 increments", famrole: "child", famkid: true, ...fam }),
  ];
}

const snap = (rows) => ({ rows, quiet: "", src: "demo data · board-cast.mjs", stamp: "just now", stale: false });

/** The five scenes, in order. */
export function boardScenes(nowSec = Math.floor(Date.now() / 1000)) {
  const done = search(1, "Done — all four increments landed, PR opened.", "done");
  return [
    snap([checkout("attend"), ...billing(0), ratelimits("wilt"),
      search(0.25, "Inc 2 in progress — building the tokenizer."), LOGIN, ...QUIET]),
    snap([checkout("attend"), ...billing(0), ratelimits("wilt"),
      search(0.5, "Inc 2 — tokenizer wired, tests running."), LOGIN, ...QUIET]),
    snap([checkout("attend"), ratelimits("wilt"), ...billing(1), done, LOGIN, ...QUIET]),
    snap([payments(nowSec), checkout("running"), ...billing(1), ratelimits("wilt"), done, LOGIN, ...QUIET]),
    snap([payments(nowSec), checkout("running"), ...billing(1), ratelimits("done"), done, LOGIN, ...QUIET]),
  ];
}
