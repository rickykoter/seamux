#!/usr/bin/env node
// The `ci` check kind (ADR 0066): the branch's PR checks, behind the same
// gate as every other proof. deep-plan synthesizes the command; no recipe
// names it. Run from the plan root:
//
//   node lib/ci.mjs wait [--timeout <seconds>] [--interval <seconds>]
//
// It fails at once when the branch has no PR, or the PR head is not local
// HEAD (a verdict must be about the tree being closed, and the engine never
// pushes). Otherwise it polls `gh pr checks` until nothing is pending: exit
// 0 when every check passed or was skipped, 1 when any failed (each named,
// with the failed job's log tail when it is an Actions job). Exit 3 is "no
// CI verdict": no PR, not pushed, gh failing, or the wait timed out. It
// fails the check but does not count toward the retry cap, since no CI run
// went red.
// Between looks it waits on `gh event listen` (gh 2.105+, GitHub Event
// Streams) for the PR's next check suite, push or state change, and looks
// again at once. The regular interval stays the longest wait: a listener that
// connects but never delivers, or hangs, costs no more than polling did, so
// events only make a wait faster. When the listener cannot run (an older gh,
// the account not in the preview, GHES, or DEEP_PLAN_GH_EVENTS=0) it says so
// once and polls on the interval as before.
// gh is DEEP_PLAN_GH, so the probe can stand a fake in.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GH = () => process.env.DEEP_PLAN_GH || "gh";
export const CI_TIMEOUT_S = 1800;
const INTERVAL_S = 30, LOG_LINES = 60, LOGS_CAP = 3;
export const NO_VERDICT = 3;
// The pull request events a wait on checks cares about: a check suite
// finished, the head moved (a push), or the PR was merged, closed or drafted.
const EV = e => `com.github.pull_request.${e}.v1`;
export const PR_EVENTS = [EV("check_suite.status.changed"), EV("head.changed"), EV("state.changed")];
export const MERGE_CONFLICT_EVENT = EV("merge_conflict");
// Why the listener is off for the rest of this process, once gh refused it
// for good; a failure that may pass (a dropped stream, a 5xx) only polls the
// one pause, until TRANSIENT_MAX of them in a row turn it off too.
let listenOff = process.env.DEEP_PLAN_GH_EVENTS === "0" ? "DEEP_PLAN_GH_EVENTS=0" : "";
let transient = 0;
const TRANSIENT_MAX = 3;
// gh's refusals that will not change within a wait: an older gh with no
// `gh event`, an account outside the preview, a host without Event Streams.
const REFUSED = /unknown command|not enabled|HTTP 40[134]|not available|Enterprise|GHE\.com/i;
// A stderr line that reports an error rather than the stream attaching.
const ERROR_LINE = /error|failed|HTTP \d{3}|not enabled|unknown command/i;

function gh(args, cwd) {
  const r = spawnSync(GH(), args, { encoding: "utf8", cwd, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error && r.error.code === "ENOENT") return { err: `${GH()} is not installed (or not on PATH); a ci check reads the PR through it` };
  if (r.error) return { err: `${GH()} ${args.slice(0, 2).join(" ")}: ${r.error.message}` };
  return { status: r.status, out: r.stdout || "", errText: (r.stderr || "").trim() };
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

// The PR for the branch at cwd, and whether its head is local HEAD.
export function prState(cwd) {
  const v = gh(["pr", "view", "--json", "number,url,headRefOid,isDraft"], cwd);
  if (v.err) return { error: v.err };
  const pr = v.status === 0 ? parse(v.out) : null;
  if (!pr) return { error: `no PR for this branch (${v.errText.split("\n").pop() || "gh pr view found none"}): push it and open the draft PR first` };
  const h = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" });
  const head = h.status === 0 ? h.stdout.trim() : "";
  if (!head || head !== pr.headRefOid)
    return { pr, error: `the PR head (${String(pr.headRefOid).slice(0, 8)}) is not local HEAD (${head.slice(0, 8) || "?"}): push first, so CI runs on the tree being closed` };
  return { pr };
}

// One look at the checks: {pending, failed, passed} lists of {name, link,
// check}, where check is the check's own name (a required check's context).
// head is the commit whose Actions runs stand in when gh pr checks is
// refused; it defaults to local HEAD.
// gh pr checks reads GraphQL's statusCheckRollup, which a fine-grained token
// without Checks read is refused (note n9ae07128). Then the checks come from
// the head commit's Actions runs, which that token still reads, with via
// "actions" and the refusal in refused: a check from another service than
// Actions is not seen there.
export function checksNow(cwd, head) {
  const c = gh(["pr", "checks", "--json", "name,bucket,link,workflow"], cwd);
  if (c.err) return { error: c.err };
  // gh exits 8 while checks are pending and 1 when one failed; the JSON is
  // the answer either way.
  // Right after a push gh may say no checks are reported yet: that is none
  // pending so far, and the wait goes on.
  if (!c.out.trim() && /no checks reported/i.test(c.errText)) return { pending: [], failed: [], passed: [], total: 0, names: [] };
  const rows = parse(c.out);
  if (!Array.isArray(rows)) {
    const why = c.errText.split("\n").pop() || "no JSON";
    if (!TOKEN_REFUSED.test(c.errText)) return { error: `gh pr checks: ${why}` };
    const a = actionsChecks(cwd, head || localHead(cwd));
    if (a.error) return { error: `gh pr checks was refused (${why}), and the Actions runs could not be read either: ${a.error}` };
    return { ...a, via: "actions", refused: why };
  }
  return bucketed(rows.map(r => ({ check: r.name, workflow: r.workflow, bucket: r.bucket, link: r.link })));
}

// A refusal a narrower token gets, rather than a missing PR or a gh fault.
const TOKEN_REFUSED = /Resource not accessible by (personal access token|integration)|HTTP 403|not have permission|insufficient (scope|permission)/i;
const localHead = cwd => {
  const h = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" });
  return h.status === 0 ? h.stdout.trim() : "";
};
function bucketed(rows) {
  const by = b => rows.filter(r => r.bucket === b).map(r => ({ name: r.workflow ? `${r.workflow} / ${r.check}` : r.check, link: r.link || "", check: r.check }));
  return { pending: by("pending"), failed: [...by("fail"), ...by("cancel")], passed: [...by("pass"), ...by("skipping")], total: rows.length,
    names: rows.map(r => r.check) };
}

// The jobs of a commit's Actions runs, bucketed as gh pr checks buckets them.
// The newest run of each workflow counts (gh run list lists newest first), and
// gh run view gives its latest attempt's jobs. {pending, failed, passed,
// total, names} or {error}.
const PASSED = new Set(["success", "skipped", "neutral"]);
const CANCELLED = new Set(["cancelled", "stale"]);
export function actionsChecks(cwd, sha) {
  if (!sha) return { error: "no commit to read the runs of" };
  const l = gh(["run", "list", "--commit", sha, "--json", "databaseId,workflowName,status,conclusion", "--limit", "50"], cwd);
  if (l.err) return { error: l.err };
  const runs = l.status === 0 ? parse(l.out) : null;
  if (!Array.isArray(runs)) return { error: `gh run list: ${l.errText.split("\n").pop() || "no JSON"}` };
  const seen = new Set(), rows = [];
  for (const run of runs) {
    if (seen.has(run.workflowName)) continue;
    seen.add(run.workflowName);
    const v = gh(["run", "view", String(run.databaseId), "--json", "jobs"], cwd);
    const jobs = !v.err && v.status === 0 ? (parse(v.out) || {}).jobs : null;
    if (!Array.isArray(jobs)) return { error: `gh run view ${run.databaseId}: ${v.err || v.errText.split("\n").pop() || "no JSON"}` };
    for (const j of jobs)
      rows.push({ check: j.name, workflow: run.workflowName, link: j.url || "",
        bucket: j.status !== "completed" ? "pending" : PASSED.has(j.conclusion) ? (j.conclusion === "success" ? "pass" : "skipping")
          : CANCELLED.has(j.conclusion) ? "cancel" : "fail" });
  }
  return bucketed(rows);
}

// The checks failing on a commit (the base's tip), read from its Actions
// runs so any token that reads PRs can tell: a Set of check names, or null
// when they could not be read.
export function failingAt(cwd, sha) {
  const a = actionsChecks(cwd, sha);
  return a.error ? null : new Set(a.failed.map(f => f.check));
}

// What ship's token reads (ADR 0108, the token gate): one GET each for the
// head commit's check runs and its combined status, with -i so a refusal's
// X-Accepted-GitHub-Permissions header names the permission it needed. The
// token itself never appears. {missing: ["checks=read", ...], unread:
// ["why a probe said nothing"]}, kept per commit for this process.
const tokenSeen = new Map();
export function tokenReads(cwd, sha) {
  const key = `${cwd}\0${sha}`;
  if (tokenSeen.has(key)) return tokenSeen.get(key);
  const out = { missing: [], unread: [] };
  for (const [want, ep] of [["checks=read", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=1`], ["statuses=read", `repos/{owner}/{repo}/commits/${sha}/status`]]) {
    const r = gh(["api", "-i", ep], cwd);
    if (r.err) { out.unread.push(`${want}: ${r.err}`); continue; }
    const code = Number((/^HTTP\/[\d.]+ (\d{3})/m.exec(r.out) || [])[1]) || 0;
    if (code >= 200 && code < 300) continue;
    const named = (/^x-accepted-github-permissions:\s*(.+)$/im.exec(r.out) || [])[1];
    if (code === 403 || code === 404) out.missing.push(named ? named.trim() : want);
    else out.unread.push(`${want}: ${code ? `HTTP ${code}` : (r.errText.split("\n").pop() || "no answer")}`);
  }
  tokenSeen.set(key, out);
  return out;
}
// What ship needs of its token, in GitHub's fine-grained permission names.
export const SHIP_NEEDS = ["pull_requests=write", "contents=write", "checks=read", "statuses=read", "statuses=write"];

// For deep-plan ship (ADR 0108): the branch's PR with what a merge needs to
// know, whether or not its head is local HEAD. {pr} or {error}; a branch with
// no PR is {pr: null}.
export function prView(cwd) {
  return viewPr(cwd, []);
}

// The PR whose head is `branch`, open, merged or closed (gh pr view takes a
// branch name): ship's stacked gate reads a family parent's PR from a child's
// worktree with it. {pr}, {pr: null} when the branch has none, or {error}.
export function prViewBranch(cwd, branch) {
  return viewPr(cwd, [branch]);
}

function viewPr(cwd, which) {
  const v = gh(["pr", "view", ...which, "--json", "number,url,headRefOid,isDraft,state,baseRefName,headRefName,mergeable"], cwd);
  if (v.err) return { error: v.err };
  if (v.status !== 0) return /no pull requests found|no open pull requests/i.test(v.errText) ? { pr: null }
    : { error: `gh pr view exited ${v.status}: ${v.errText.split("\n").pop() || "no message"}` };
  const pr = parse(v.out);
  return pr ? { pr } : { error: "gh pr view: no JSON" };
}

// Whether GitHub's own auto-merge can be used: the repo allows it, the base
// branch requires status checks (with none required, GitHub merges at once,
// which is not waiting for green), and every check on the PR is a required
// one (GitHub would merge past a failing check that is not). gh repo view has
// no autoMergeAllowed field, so GraphQL says whether the repo allows it.
const AUTO_MERGE_Q = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed}}";
export function githubAutoMerge(cwd, base, names = []) {
  const r = gh(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${AUTO_MERGE_Q}`], cwd);
  const d = !r.err && r.status === 0 ? parse(r.out) : null;
  if (!(d && d.data && d.data.repository && d.data.repository.autoMergeAllowed === true)) return false;
  const need = requiredChecks(cwd, base);
  return need.length > 0 && names.length > 0 && names.every(n => need.includes(n));
}

// The checks the base branch requires, by context: from its rulesets first
// (repos/{owner}/{repo}/rules/branches/<base>, which any token that reads the
// repo can read), then from classic branch protection, which needs
// administration read and is often refused.
export function requiredChecks(cwd, base) {
  const r = gh(["api", `repos/{owner}/{repo}/rules/branches/${base}`], cwd);
  const rules = !r.err && r.status === 0 ? parse(r.out) : null;
  const fromRules = Array.isArray(rules) ? rules.filter(x => x && x.type === "required_status_checks")
    .flatMap(x => ((x.parameters || {}).required_status_checks || []).map(c => c && c.context)).filter(Boolean) : [];
  if (fromRules.length) return [...new Set(fromRules)];
  const p = gh(["api", `repos/{owner}/{repo}/branches/${base}/protection/required_status_checks`], cwd);
  const req = !p.err && p.status === 0 && parse(p.out);
  return req ? [...new Set([...(req.contexts || []), ...((req.checks || []).map(c => c && c.context).filter(Boolean))])] : [];
}

// One gh call for ship's acts (pr create, ready, merge): {ok, out}.
export function ghAct(args, cwd) {
  const r = gh(args, cwd);
  if (r.err) return { ok: false, out: r.err };
  return { ok: r.status === 0, out: (r.out || "").trim() || r.errText };
}

// The tail of a failed Actions job's log, when the link is one.
function jobTail(link, cwd) {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(link || "");
  if (!m) return "";
  const r = gh(["run", "view", m[1], "--job", m[2], "--log-failed"], cwd);
  if (r.err || r.status !== 0) return "";
  return r.out.split("\n").filter(l => l.trim()).slice(-LOG_LINES)
    .map(l => l.split("\t").slice(2).join("\t") || l).join("\n");
}

// Wait for the PR at url to change, up to maxS: "event" when one arrived,
// "timeout" when none did, "settled" when recheck() said the wait is over,
// "poll" when the listener could not run and fallbackS was slept instead.
// gh delivers only events after its stream attaches (it says so on stderr),
// so recheck runs on each such line, once per line: a check that finished
// between the caller's look and the attach is not missed, and a reconnect
// looks again too. Error lines do not run it.
export function pause({ url, cwd, maxS, fallbackS, events = PR_EVENTS, recheck = () => false, say = console.log }) {
  const sleep = () => new Promise(r => setTimeout(() => r("poll"), Math.max(0, fallbackS) * 1000));
  if (listenOff || !url || !(maxS >= 1)) return sleep();
  return new Promise(resolve => {
    let done = false, errText = "", partial = "";
    const child = spawn(GH(), ["event", "listen", "--resource", url, "--event", events.join(","), "--timeout", `${Math.ceil(maxS)}s`],
      { cwd, stdio: ["ignore", "pipe", "pipe"] });
    // gh's own --timeout ends the listen; this ends it if gh does not.
    const watchdog = setTimeout(() => finish("timeout"), (Math.ceil(maxS) + 15) * 1000);
    const finish = how => {
      if (done) return;
      done = true; clearTimeout(watchdog);
      if (how !== "settled") transient = 0;
      try { child.kill(); } catch { /* gone */ }
      resolve(how);
    };
    const failed = (why, refused) => {
      if (done) return;
      done = true; clearTimeout(watchdog);
      if (refused || ++transient >= TRANSIENT_MAX) {
        listenOff = why;
        say(`ci: gh event listen is unavailable (${why}); polling every ${fallbackS}s instead`);
      } else say(`ci: gh event listen failed (${why}); polling this once and listening again after`);
      sleep().then(resolve);
    };
    child.on("error", e => failed(e.code === "ENOENT" ? `${GH()} is not installed` : e.message, e.code === "ENOENT"));
    child.stdout.on("data", () => finish("event"));
    child.stderr.on("data", d => {
      errText += d;
      const lines = (partial + d).split("\n");
      partial = lines.pop();
      for (const l of lines) if (!done && l.trim() && !ERROR_LINE.test(l) && recheck()) return finish("settled");
    });
    child.on("close", code => {
      if (code === 0) return finish("event");
      if (code === 8) return finish("timeout");
      const why = errText.trim().split("\n").pop() || `gh event listen exited ${code === null ? "on a signal" : code}`;
      failed(why, REFUSED.test(errText));
    });
  });
}

export async function wait({ cwd = process.cwd(), timeoutS = CI_TIMEOUT_S, intervalS = INTERVAL_S, say = console.log } = {}) {
  const p = prState(cwd);
  if (p.error) { say(`ci: ${p.error}`); return NO_VERDICT; }
  say(`ci: PR #${p.pr.number} ${p.pr.url} at ${String(p.pr.headRefOid).slice(0, 8)}`);
  const end = Date.now() + timeoutS * 1000;
  let first = true, toldVia = false;
  // One look: an exit code when the wait is over, null while checks pend.
  const look = () => {
    const c = checksNow(cwd, p.pr.headRefOid);
    if (c.error) { say(`ci: ${c.error}`); return NO_VERDICT; }
    if (c.via === "actions" && !toldVia) { toldVia = true; say(`ci: gh pr checks was refused (${c.refused}); reading the head's Actions runs instead`); }
    if (!c.pending.length && c.total) {
      if (!c.failed.length) { say(`ci: all ${c.passed.length} check(s) passed`); return 0; }
      say(`ci: ${c.failed.length} of ${c.total} check(s) failed: ${c.failed.map(f => f.name).join(", ")}`);
      for (const f of c.failed.slice(0, LOGS_CAP)) {
        const t = jobTail(f.link, cwd);
        if (t) say(`\n--- ${f.name} (${f.link})\n${t}`);
        else if (f.link) say(`  ${f.name}: ${f.link}`);
      }
      return 1;
    }
    if (Date.now() >= end) {
      say(`ci: timed out after ${timeoutS}s with ${c.pending.length || "no"} check(s) still pending${c.pending.length ? ": " + c.pending.map(x => x.name).join(", ") : " (none reported yet)"}`);
      return NO_VERDICT;
    }
    if (first) say(`ci: waiting on ${c.pending.length || "not yet reported"} check(s)…`);
    first = false;
    return null;
  };
  for (;;) {
    let v = look();
    if (v !== null) return v;
    const left = Math.ceil((end - Date.now()) / 1000);
    const how = await pause({ url: p.pr.url, cwd, maxS: Math.min(intervalS, left), fallbackS: intervalS, say,
      recheck: () => (v = look()) !== null });
    if (how === "settled") return v;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const opt = (k, d) => {
    const i = a.indexOf(k);
    if (i < 0) return d;
    const v = Number(a[i + 1]);
    if (!Number.isFinite(v) || v < 0) { console.error(`ci.mjs: ${k} takes a number of seconds`); process.exit(2); }
    return v;
  };
  if (a[0] !== "wait") { console.error("usage: ci.mjs wait [--timeout <seconds>] [--interval <seconds>]"); process.exit(2); }
  process.exit(await wait({ timeoutS: opt("--timeout", CI_TIMEOUT_S), intervalS: opt("--interval", process.env.DEEP_PLAN_CI_INTERVAL_S !== undefined ? Number(process.env.DEEP_PLAN_CI_INTERVAL_S) : INTERVAL_S) }));
}
