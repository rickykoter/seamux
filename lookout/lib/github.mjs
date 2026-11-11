// A review's GitHub pull request: which PR it belongs to, what GitHub says
// about it now, and posting findings to it. Every gh call lookout makes is
// here, through LOOKOUT_GH so the probe can stand a fake in.
//
// `sync` writes one block onto the review record, `github`:
//   { repo, pr, url, state, draft, title, headRef, head, reviewed, behind,
//     threads: [{ id, path, line, originalLine, side, outdated, resolved,
//                 comments: [{ id, author, body, at, url }] }],
//     checks: [{ name, workflow, bucket, state, link, startedAt, completedAt }],
//     viewer, stale: { <f#|t#>: why }, error, changedAt }
// and each posted item carries `github: { commentId, url, reviewUrl, postedAt }`.
// The record is rewritten only when that block changes, so a quiet PR never
// redraws an open page. When a sync last ran, and any back-off after a rate
// limit, live in lookout's own state file, not in the record.
//
// Staleness is per line, as GitHub's "outdated" is: an item is stale when
// the code within CONTEXT lines of it changed between the head it was
// reviewed at (its `at`, else the review's head) and the PR's head, or its
// file was deleted there. GitHub threads keep GitHub's own word.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as S from "./store.mjs";

export const GH = () => process.env.LOOKOUT_GH || "gh";
export const STATE_FILE = process.env.LOOKOUT_GH_STATE ||
  path.join(os.homedir(), ".claude", "lookout", "gh-sync.json");
// A sync this recent is skipped unless forced: the page server and the app
// both ask, and either may ask twice.
export const MIN_GAP_MS = Number(process.env.LOOKOUT_GH_MIN_GAP_MS) || 45 * 1000;
// A branch with no PR is asked again after this long.
export const NO_PR_GAP_MS = 10 * 60 * 1000;
// After a rate limit, nothing is asked for this long.
export const BACKOFF_MS = 10 * 60 * 1000;
export const CONTEXT = 3;
export const IDLE_MS = 14 * 24 * 3600 * 1000;
const MAX_BODY = 4000;
const TIMEOUT = 60 * 1000;

const clip = (s, n = MAX_BODY) => String(s ?? "").slice(0, n);
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

export function gh(args, { cwd, input } = {}) {
  const r = spawnSync(GH(), args, { encoding: "utf8", cwd, input, timeout: TIMEOUT,
                                    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (r.error && r.error.code === "ENOENT") return { error: `${GH()} is not installed (or not on PATH)` };
  if (r.error) return { error: `${GH()} ${args.slice(0, 2).join(" ")}: ${r.error.message}` };
  return { status: r.status, out: r.stdout || "", err: (r.stderr || "").trim() };
}
// A reply that says GitHub is limiting us: back off rather than ask again.
// A 403 alone is a permission error, not a limit: only the words say so.
export const limited = r => !!r && r.status !== 0 && /rate limit|secondary rate|abuse detection|HTTP 429/i.test(r.err || "");
const fail = (r, what) => r.error || `${what}: ${(r.err || r.out || "").split("\n").filter(Boolean).pop() || "exit " + r.status}`;

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: TIMEOUT });
  return r.status === 0 ? r.stdout : null;
}

// ---------------------------------------------------------------- state

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}; } catch { return {}; }
}
export function writeState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* a state we cannot write costs only an extra sync */ }
}
// The page server and the app both write the file: read-modify-write under
// a lock directory, broken when older than a few seconds.
function withStateLock(fn) {
  const lock = STATE_FILE + ".lock";
  let held = false;
  for (let i = 0; i < 100 && !held; i++) {
    try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.mkdirSync(lock); held = true; }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock); } catch { /* raced */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { if (held) try { fs.rmdirSync(lock); } catch { /* gone */ } }
}
// `key` is a review id, or VIEWER (no review id can start with "_").
export const VIEWER = "_viewer";
function setState(key, patch) {
  return withStateLock(() => {
    const st = readState();
    st[key] = { ...(st[key] || {}), ...patch };
    writeState(st);
    return st[key];
  });
}

// ---------------------------------------------------------------- linking

// A PR as pasted: 123, #123, owner/repo#123, or a github.com /pull/ URL.
export function parsePrRef(s) {
  const t = String(s || "").trim();
  let m = /^#?(\d+)$/.exec(t);
  if (m) return { repo: "", pr: Number(m[1]) };
  m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t);
  if (m) return { repo: m[1], pr: Number(m[2]) };
  m = /^(?:https?:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/pull\/(\d+)/.exec(t);
  if (m) return { repo: m[1], pr: Number(m[2]) };
  return null;
}
const repoOfUrl = u => (/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/.exec(u || "") || [])[1] || "";

const PR_FIELDS = "number,url,state,isDraft,title,headRefName,headRefOid";

// The PR a review belongs to: the one its record already names, the one it
// was opened with (--pr, kept as prRef), else the open PR for its branch.
// A patch review has no branch to ask about. Returns { link } or { none } or
// { error, limited }.
export function findLink(review) {
  const src = review.source || {};
  const root = src.root;
  // A --pr the review was (re-)opened with wins over the PR a sync saved.
  const asked = review.prRef ? parsePrRef(review.prRef) : null;
  const known = review.github && review.github.pr ? { repo: review.github.repo, pr: review.github.pr } : null;
  const ref = asked && !(known && known.pr === asked.pr && (!asked.repo || sameRepo(asked.repo, known.repo))) ? asked : known || asked;
  let r;
  if (ref) r = gh(["pr", "view", String(ref.pr), ...(ref.repo ? ["-R", ref.repo] : []), "--json", PR_FIELDS], { cwd: root });
  else if (src.kind === "patch" || !src.branch) return { none: "no branch to find a pull request for" };
  else r = gh(["pr", "view", src.branch, "--json", PR_FIELDS], { cwd: root });
  if (r.error) return { error: r.error };
  if (limited(r)) return { error: fail(r, "gh pr view"), limited: true };
  if (r.status !== 0) return ref ? { error: fail(r, "gh pr view") } : { none: `no pull request for ${src.branch}` };
  const v = parse(r.out);
  if (!v || !v.number) return { error: "gh pr view answered without a PR" };
  return { link: { repo: repoOfUrl(v.url) || (ref && ref.repo) || "", pr: v.number, view: v } };
}

// Whether the review was (re-)opened with a --pr other than the one it saved.
export function switching(review) {
  const asked = review.prRef ? parsePrRef(review.prRef) : null;
  const g = review.github || {};
  return !!asked && !!g.pr && (asked.pr !== g.pr || (!!asked.repo && !sameRepo(asked.repo, g.repo)));
}
// GitHub names are case-blind: Owner/Repo and owner/repo are one repository.
export const sameRepo = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

// ---------------------------------------------------------------- reading

// Threads come 100 a page, followed to MAX_THREAD_PAGES; a thread's first
// 100 comments are read and the rest counted (`more`).
export const THREADS_QUERY = `query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$n){
reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id path line originalLine diffSide isOutdated isResolved
comments(first:100){totalCount nodes{databaseId author{login} body createdAt url}}}}}}}`;
export const MAX_THREAD_PAGES = 10;
const threadsPage = v => (((((v || {}).data || {}).repository || {}).pullRequest || {}).reviewThreads) || null;

export function threadsOf(v) {
  const nodes = (threadsPage(v) || {}).nodes;
  if (!Array.isArray(nodes)) return null;
  return nodes.filter(Boolean).map(t => ({
    id: String(t.id || ""), path: String(t.path || ""),
    line: Number.isInteger(t.line) ? t.line : null,
    originalLine: Number.isInteger(t.originalLine) ? t.originalLine : null,
    side: t.diffSide === "LEFT" ? "old" : "new",
    outdated: !!t.isOutdated, resolved: !!t.isResolved,
    comments: (((t.comments || {}).nodes) || []).filter(Boolean).map(c => ({
      id: c.databaseId, author: (c.author && c.author.login) || "ghost",
      body: clip(c.body), at: c.createdAt || "", url: c.url || "" })),
    more: Math.max(0, ((t.comments || {}).totalCount || 0) - (((t.comments || {}).nodes) || []).length),
  }));
}

export function checksOf(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.map(c => ({ name: String(c.name || ""), workflow: c.workflow || "", bucket: c.bucket || "",
    state: c.state || "", link: c.link || "", startedAt: c.startedAt || "", completedAt: c.completedAt || "" }));
}

function viewer(st, now) {
  const v = st[VIEWER];
  if (v && v.login && now - (v.at || 0) < 24 * 3600 * 1000) return v.login;
  const r = gh(["api", "user", "--jq", ".login"]);
  const login = r.status === 0 ? r.out.trim() : "";
  if (login) setState(VIEWER, { login, at: now });
  return login;
}

// ---------------------------------------------------------------- staleness

// The hunks of `git diff -U0 a b -- file` as old-side ranges [start, end].
export function changedRanges(diff) {
  const out = [];
  for (const m of String(diff || "").matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
    // A pure insertion (n = 0) sits after line `start`.
    out.push(n === 0 ? [start, start + 1] : [start, start + n - 1]);
  }
  return out;
}
export const touches = (ranges, line, ctx = CONTEXT) => ranges.some(([a, b]) => line >= a - ctx && line <= b + ctx);

// The head's objects, so it can be diffed: already here (the usual case in a
// session, where the branch is checked out), else fetched from the remote
// whose URL is the PR's repo, into refs/lookout/<id>/head only.
function haveHead(root, id, repo, pr, head) {
  if (git(root, ["cat-file", "-e", head + "^{commit}"]) !== null) return true;
  const remotes = git(root, ["remote", "-v"]) || "";
  const want = repo.toLowerCase();
  let remote = "";
  for (const line of remotes.split("\n")) {
    const [name, url] = line.split(/\s+/);
    if (!name || !url) continue;
    const p = url.toLowerCase().replace(/^(https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]/, "").replace(/\/$/, "").replace(/\.git$/, "");
    if (p === want && (!remote || name === "origin")) remote = name;
  }
  if (!remote) return false;
  git(root, ["fetch", "--quiet", "--no-tags", remote, `+refs/pull/${pr}/head:refs/lookout/${id}/head`]);
  return git(root, ["cat-file", "-e", head + "^{commit}"]) !== null;
}

// { <id>: why } for the review's findings and comment threads on the new
// side. Items whose head cannot be read are left alone.
export function staleness(review, head, root) {
  const stale = {};
  const base = (review.source || {}).head || "";
  const cache = new Map();
  const rangesFor = (at, file) => {
    const k = at + "\0" + file;
    if (!cache.has(k)) {
      const d = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", at, head, "--", file]);
      cache.set(k, d === null ? null : { gone: /^deleted file mode/m.test(d), ranges: changedRanges(d) });
    }
    return cache.get(k);
  };
  for (const x of [...(review.findings || []), ...(review.threads || [])]) {
    if (!x || !x.file || (x.side || "new") !== "new") continue;
    const at = x.at || base;
    if (!at || at === head) continue;
    const r = rangesFor(at, x.file);
    if (!r) continue;
    if (r.gone) stale[x.id] = "its file was deleted on the PR's head";
    else if (touches(r.ranges, x.line)) stale[x.id] = `the code around line ${x.line} changed after it was reviewed`;
  }
  return stale;
}

// ---------------------------------------------------------------- sync

const sameBlock = (a, b) => {
  const strip = g => g ? { ...g, changedAt: undefined } : null;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

// One look at GitHub for review `id`. Returns { skipped } | { linked: false,
// why } | { changed, github } | { error }.
export function sync(id, { force = false, now = Date.now() } = {}) {
  if (!S.exists(id)) return { error: "no review " + id };
  const st0 = readState();
  const me = st0[id] || {};
  if (!force && me.backoffUntil && now < me.backoffUntil) return { skipped: "backing off after a GitHub rate limit" };
  if (!force && me.at && now - me.at < MIN_GAP_MS) return { skipped: "synced moments ago" };
  if (!force && me.noPrAt && now - me.noPrAt < NO_PR_GAP_MS) return { skipped: "no pull request, asked recently" };
  const review = S.read(id);
  // A merged or closed PR had its last sync when it was seen so; a review
  // nobody has touched in IDLE_MS is left alone too. Both still sync forced.
  const was = (review.github || {}).state;
  if (!force && was && was !== "OPEN" && !switching(review)) return { skipped: `the pull request is ${was.toLowerCase()}` };
  if (!force && Date.parse(review.updatedAt || "") < now - IDLE_MS) return { skipped: "the review has been idle for two weeks" };
  setState(id, { at: now });

  const root = (review.source || {}).root;
  const found = findLink(review);
  if (found.limited) { setState(id, { backoffUntil: now + BACKOFF_MS }); return record(id, review, { error: found.error }); }
  if (found.error) return record(id, review, { error: found.error });
  if (found.none) { setState(id, { noPrAt: now }); return { linked: false, why: found.none }; }
  const { repo, pr, view } = found.link;
  const [owner, name] = repo.split("/");

  // -f for the names: -F would send a repo called "123" as a number.
  let tq, threads = [];
  for (let page = 0, after = ""; page < MAX_THREAD_PAGES; page++) {
    tq = gh(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${pr}`,
             ...(after ? ["-f", `after=${after}`] : []), "-f", `query=${THREADS_QUERY}`], { cwd: root });
    const v = tq.status === 0 ? parse(tq.out) : null;
    const got = v ? threadsOf(v) : null;
    if (!got) { threads = null; break; }
    threads.push(...got);
    const info = (threadsPage(v) || {}).pageInfo || {};
    if (!info.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  const cq = gh(["pr", "checks", String(pr), "-R", repo, "--json", "name,state,bucket,link,workflow,startedAt,completedAt"], { cwd: root });
  if (limited(tq) || limited(cq)) {
    setState(id, { backoffUntil: now + BACKOFF_MS });
    return record(id, review, { error: "GitHub is rate limiting; lookout waits ten minutes before asking again" });
  }
  // What the last sync saw stands in for a failed read, but only for the same PR.
  const prev = review.github && review.github.pr === pr && sameRepo(review.github.repo, repo) ? review.github : {};
  // gh exits 8 while checks are pending and 1 when one failed; the JSON is
  // the answer either way. None reported yet is an empty list.
  const checks = cq.out && cq.out.trim() ? checksOf(parse(cq.out))
    : /no checks reported/i.test(cq.err || "") ? [] : null;
  const head = view.headRefOid || "";
  const reviewed = (review.source || {}).head || "";
  let behind = null, stale = prev.stale || {};
  if (head && root && haveHead(root, id, repo, pr, head)) {
    if (reviewed && reviewed !== head) {
      const n = git(root, ["rev-list", "--count", `${reviewed}..${head}`]);
      behind = n === null ? null : Number(n.trim());
    } else behind = 0;
    stale = staleness(review, head, root);
  }
  const errors = [threads ? "" : fail(tq, "review threads"), checks ? "" : fail(cq, "gh pr checks")].filter(Boolean);
  const block = {
    repo, pr, url: view.url || "", state: view.state || "", draft: !!view.isDraft, title: view.title || "",
    headRef: view.headRefName || "", head, reviewed, behind,
    threads: threads || prev.threads || [], checks: checks || prev.checks || [],
    viewer: viewer(st0, now) || prev.viewer || "", stale,
    error: errors.join("; ") || null,
  };
  return record(id, review, block);
}

// Write the block (or an error onto the block already there) only when it
// changed.
function record(id, review, block) {
  const next = block.repo ? block : { ...(review.github || {}), error: block.error };
  if (sameBlock(review.github, next)) return { changed: false, github: review.github };
  next.changedAt = new Date().toISOString();
  const out = S.update(id, cur => { cur.github = next; return cur; });
  return { changed: true, github: out.github, ...(block.repo ? {} : { error: block.error }) };
}

// ---------------------------------------------------------------- posting

// One item as a GitHub comment's text.
export function commentText(x) {
  if (!String(x.id || "").startsWith("f")) return clip(((x.messages || [])[0] || {}).text || "");
  let t = `**${x.severity || "finding"}** · ${x.category || "correctness"} — ${x.summary || ""}`;
  if (x.failure_scenario) t += "\n\n" + x.failure_scenario;
  return clip(t);
}

// The body of POST /repos/{o}/{r}/pulls/{n}/reviews, pinned to the commit
// reviewed. `folded` puts every item in the body instead of on its line: the
// retry when GitHub says a line is not in its diff.
export function reviewPayload(items, sha, intro, folded) {
  if (folded) {
    const list = items.map(x => `- \`${x.file}:${x.line}\` ${commentText(x).replace(/\n/g, "\n  ")}`);
    return { commit_id: sha, event: "COMMENT", body: `${intro}\n\n${list.join("\n")}` };
  }
  return { commit_id: sha, event: "COMMENT", body: intro,
    comments: items.map(x => ({ path: x.file, line: x.line || 1, side: x.side === "old" ? "LEFT" : "RIGHT", body: commentText(x) })) };
}

// Post items `ids` (findings or comment threads) as one GitHub review and
// save each comment's id on its item. Returns { url, posted, folded }.
// Throws with the reason.
export function post(id, ids, { intro = "", again = false } = {}) {
  let review = S.read(id);
  if (!review.github || !review.github.pr) {
    const r = sync(id, { force: true });
    if (r.error) throw new Error(r.error);
    review = S.read(id);
    if (!review.github || !review.github.pr) throw new Error(r.why || "this review has no pull request to post to");
  }
  const { repo, pr } = review.github;
  const all = [...(review.findings || []), ...(review.threads || [])];
  const items = [];
  for (const i of [...new Set(ids)]) {
    const x = all.find(y => y.id === i);
    if (!x) throw new Error("no finding or comment " + i);
    if (x.github && x.github.postedAt && !again) throw new Error(`${i} is already posted (${x.github.url || x.github.reviewUrl}); pass --again to post it again`);
    items.push(x);
  }
  if (!items.length) throw new Error("name at least one finding or comment to post");
  // The commit the items were read on: the earliest-made item's, else the review's.
  const made = items.filter(x => x.at).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const sha = (made[0] && made[0].at) || (review.source || {}).head || review.github.head;
  const words = intro || `Lookout review: ${items.length} item${items.length === 1 ? "" : "s"}.`;
  const path_ = `repos/${repo}/pulls/${pr}/reviews`;
  const send = folded => gh(["api", "-X", "POST", path_, "--input", "-"], { cwd: (review.source || {}).root, input: JSON.stringify(reviewPayload(items, sha, words, folded)) });
  let folded = false;
  let r = send(false);
  if (r.status !== 0 && /422|Unprocessable/i.test((r.err || "") + (r.out || ""))) { folded = true; r = send(true); }
  if (r.error || r.status !== 0) throw new Error(fail(r, "gh api " + path_));
  const v = parse(r.out) || {};
  const reviewUrl = v.html_url || "";
  // Which comment is which item: GitHub lists the review's comments; match
  // each on path, line and text.
  const byItem = {};
  if (!folded && v.id) {
    const c = gh(["api", `${path_}/${v.id}/comments`], { cwd: (review.source || {}).root });
    const listed = c.status === 0 ? parse(c.out) : null;
    for (const m of Array.isArray(listed) ? listed : []) {
      const x = items.find(y => !byItem[y.id] && y.file === m.path && (m.line == null || m.line === y.line) && commentText(y) === m.body);
      if (x) byItem[x.id] = { commentId: m.id, url: m.html_url || "" };
    }
  }
  const postedAt = new Date().toISOString();
  S.update(id, cur => {
    for (const x of [...(cur.findings || []), ...(cur.threads || [])]) {
      if (!ids.includes(x.id)) continue;
      x.github = { ...(byItem[x.id] || {}), reviewUrl, postedAt, ...(folded ? { folded: true } : {}) };
    }
    return cur;
  });
  return { url: reviewUrl, posted: items.map(x => x.id), folded };
}
