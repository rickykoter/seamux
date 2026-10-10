#!/usr/bin/env node
// lookout — review a diff in a browser pane beside the terminal.
//
// A review is a source (a base, a range, the working tree, a patch file), the
// diff it yields, and what people say about it. `lookout open` builds the diff
// without touching the real git index, stores the review under
// ~/.claude/plans/reviews/<id>.json, draws the page, and puts it in a browser
// tab beside the terminal. The page is VS Code's Source Control layout: the
// changed files on the left, one file's split or unified diff on the right,
// highlighted whole-file so a hunk inside a block comment still reads right.
//
// deep-plan reaches lookout only through this CLI and its exit codes; it never
// reads the store (ADR 0004: a plugin cannot import another's libs).
//
// Exit codes:
//   0  done (gate: pass)
//   1  refused or failed, the reason on stderr (gate: a blocker or major is open)
//   3  gate only: no review, or no reviewer has reported on it yet
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as V from "./lib/vendor.mjs";
import * as S from "./lib/store.mjs";
import { resolveSource, buildPatch, parsePatch, sideText, buildRows, looksGenerated,
         generatedByAttr, LARGE_LINES } from "./lib/patch.mjs";
import * as SC from "./lib/score.mjs";
import * as GR from "./lib/group.mjs";
import { repoConfig } from "./lib/typesafe.mjs";
import * as FD from "./lib/findings.mjs";
import * as N from "./lib/notes.mjs";
import { brief } from "./lib/prompt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- argv
const argv = process.argv.slice(2);
const verb = argv.includes("--help") || argv.includes("-h") ? "help"
  : argv.find(a => !a.startsWith("-")) || "help";
const rest = argv.slice(argv.indexOf(verb) + 1);
const flag = n => rest.includes("--" + n);
const opt = (n, d = null) => {
  const i = rest.indexOf("--" + n);
  return i >= 0 && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[i + 1] : d;
};
// Options that take a value; every other --flag stands alone.
const VALUED = new Set(["--base", "--range", "--patch", "--id", "--title", "--plan", "--inc", "--at", "--file"]);
const positional = () => rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(rest[i - 1])));

const say = s => process.stdout.write(s + "\n");
function die(msg, code = 1) { process.stderr.write("lookout: " + msg + "\n"); process.exit(code); }

// ---------------------------------------------------------------- page

const pageTitle = id => "lookout · " + id;

// JSON inside a <script> element: nothing in it may close the element or open
// a comment, whatever the diff contains.
const scriptJson = v => JSON.stringify(v).replace(/</g, "\\u003c")
  .replace(/[\u2028\u2029]/g, c => "\\u" + c.charCodeAt(0).toString(16));

// The page is one self-contained file: template, styles, script and data
// inlined, so it opens from disk as well as from the intent server.
export function renderPage(id) {
  const r = S.read(id);
  const p = S.paths(id);
  let rows = {};
  try { rows = JSON.parse(fs.readFileSync(p.rows, "utf8")); } catch { /* drawn without rows */ }
  const tpl = fs.readFileSync(path.join(HERE, "page", "review.html"), "utf8");
  const css = fs.readFileSync(path.join(HERE, "page", "review.css"), "utf8");
  const js = fs.readFileSync(path.join(HERE, "page", "review.js"), "utf8");
  // One pass over the template, so a placeholder that appears INSIDE the
  // substituted content (a review of this very file does) is never rescanned.
  const fill = {
    "__TITLE__": () => V.escapeHtml(pageTitle(id)),
    "/*__CSS__*/": () => css,
    "__DATA__": () => scriptJson({ review: r, rows }),
    "/*__JS__*/": () => js.replace(/<\/script/gi, "<\\/script"),
  };
  const html = tpl.replace(/__TITLE__|\/\*__CSS__\*\/|__DATA__|\/\*__JS__\*\//g, m => fill[m]());
  S.writeAtomic(p.html, html);
  return p.html;
}

// ---------------------------------------------------------------- arrange

// Risk per file and the groups, from what the review already holds: the
// cached Jev scores, the stored text edges, the reviewer's edges and the
// findings as they are now; then each note finds its group. Called on every
// open and whenever findings or notes change. Mutates and returns.
// The edge providers a review runs: the repo's own edgeProviders list as it
// was when the review opened, else the default. A review opened before the
// reviewer provider existed stored the old default, and gets it added; only a
// list the repo chose can leave it out.
export function providerNames(review) {
  const sc = review.scoring || {};
  if (sc.providersFromConfig && Array.isArray(sc.providers)) return sc.providers;
  return [...new Set([...(Array.isArray(sc.providers) ? sc.providers : GR.DEFAULT_PROVIDERS), "reviewer"])];
}

export function arrange(review) {
  const files = review.files || [];
  SC.rank(files, review.findings || [], review.scoring);
  const names = providerNames(review);
  const live = GR.edges(files, { text: () => "", findings: review.findings || [], reviewerEdges: review.reviewerEdges || [] },
    GR.LIVE_PROVIDERS.filter(n => names.includes(n))).edges;
  review.groups = GR.group(files, [...(review.edges || []), ...live]);
  for (const g of review.groups) g.band = SC.bandOf(g.risk);
  return N.attach(review);
}

// ---------------------------------------------------------------- open

// The cmux workspace to put the page in: the caller's own, else the one the
// board lists for this directory.
function workspaceFor(cwd) {
  if (process.env.CMUX_WORKSPACE_ID) return process.env.CMUX_WORKSPACE_ID;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cache", "cmux-crew", "board-targets.json"), "utf8"));
    const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    return Object.keys(t).find(k => t[k] && t[k].cwd && real(t[k].cwd) === real(cwd)) || "";
  } catch { return ""; }
}

// The review's served URL when crew's intent server is up AND knows the
// /review route (an older crew answers 404), else "". Served, the page takes
// comments and polls for replies; from a file it is read-only.
function servedUrl(id) {
  if (process.env.LOOKOUT_REVIEWS_DIR && !process.env.LOOKOUT_INTENT_DIR) return "";
  const dir = process.env.LOOKOUT_INTENT_DIR || path.join(os.homedir(), ".cache", "cmux-crew");
  try {
    const port = parseInt(fs.readFileSync(path.join(dir, "board-intent.port"), "utf8").trim(), 10);
    const token = fs.readFileSync(path.join(dir, "board-intent.token"), "utf8").trim();
    if (!port || !token) return "";
    const base = `http://127.0.0.1:${port}/review/${id}`;
    const r = spawnSync("curl", ["-fsS", "-m", "2", "-o", "/dev/null", `${base}.json?t=${encodeURIComponent(token)}`]);
    return r.status === 0 ? base : "";
  } catch { return ""; }
}

// Best-effort, never a failure: a tab already showing this review is pointed
// at the page again (a re-open refreshes, it does not stack tabs); otherwise a
// new browser tab opens beside the terminal without taking focus.
function showPage(id, file, cwd, { onlyIfOpen = false } = {}) {
  if (process.env.LOOKOUT_REVIEWS_DIR || flag("no-open")) return "";
  const ws = workspaceFor(cwd);
  if (!ws) return "";
  const served = servedUrl(id);
  const url = served || "file://" + encodeURI(file);
  const env = { ...process.env, CMUX_QUIET: "1" };
  try {
    const r = spawnSync("cmux", ["list-panels", "--workspace", ws, "--json"], { encoding: "utf8", env, timeout: 10000 });
    const tab = (JSON.parse(r.stdout || "{}").surfaces || [])
      .find(s => s.type === "browser" && s.title === pageTitle(id));
    if (tab) {
      // A served tab polls for changes itself; only a file tab needs a reload.
      // Asked by URL, not by whether a server answers now: a live tab must
      // never be navigated back to the read-only file.
      if (onlyIfOpen) {
        const u = spawnSync("cmux", ["browser", "--surface", tab.ref, "url"], { encoding: "utf8", env, timeout: 10000 });
        if (/^https?:/.test((u.stdout || "").trim())) return "live";
      }
      const n = spawnSync("cmux", ["browser", "--surface", tab.ref, "navigate", url], { encoding: "utf8", env, timeout: 10000 });
      if (n.status === 0) return "refreshed the open tab" + (served ? "" : ", read-only: crew's intent server is not serving reviews");
    }
  } catch { /* fall through to a new tab */ }
  if (onlyIfOpen) return "";
  const o = spawnSync("cmux", ["open", served || file, "--workspace", ws, "--focus", "false"], { encoding: "utf8", env, timeout: 10000 });
  return o.status === 0 ? "opened beside the terminal" + (served ? "" : ", read-only: crew's intent server is not serving reviews") : "";
}

function cmdOpen() {
  const cwd = path.resolve(opt("at", process.cwd()));
  const o = { base: opt("base"), range: opt("range"), patch: opt("patch"), worktree: flag("worktree"),
              plan: opt("plan"), inc: opt("inc") };
  if ([o.base, o.range, o.patch, o.worktree || null].filter(Boolean).length > 1)
    die("pick one of --base, --range, --patch, --worktree");
  let src;
  try { src = resolveSource(o, cwd); } catch (e) { die(e.message); }
  const id = opt("id") || S.defaultId(src, o);
  if (!S.ID_OK.test(id)) die("not a usable review id: " + id + " (lowercase letters, digits, . _ -)");

  const text = buildPatch(src);
  const files = parsePatch(text);
  const gen = src.kind === "patch" ? new Set() : generatedByAttr(src.root, files.map(f => f.path));
  const plain = flag("plain") || !!V.hljsMissing();
  const rows = {}, texts = {}, hunks = {};
  const meta = files.map(f => {
    const changed = f.adds + f.dels;
    const generated = looksGenerated(f.path) || gen.has(f.path);
    const large = changed > LARGE_LINES;
    // A file the page starts collapsed is drawn plain: nobody reads a lockfile
    // for its colors, and highlighting thousands of rows is the slow part.
    const skip = generated || large || f.binary;
    const newText = skip ? null : sideText(src, "new", f);
    const drawn = buildRows(f, skip ? null : sideText(src, "old", f), newText, { plain: plain || skip });
    rows[f.path] = drawn;
    // What the edge providers read: the new side, or (from a patch file) the
    // lines the hunks carry. Collapsed files are read by nobody.
    texts[f.path] = skip ? "" : newText ?? f.hunks.flatMap(h => h.lines.filter(r => r[0] !== "-").map(r => r[3])).join("\n");
    hunks[f.path] = f.hunks.map(h => h.lines.filter(r => r[0] !== " ").map(r => r[0] + r[3]).join("\n")).join("\n");
    // What a note remembers of each file it covers: a changed hunk makes it
    // stale. A binary file has no hunks, so its blob ids stand in.
    const hash = S.patchHash(f.binary ? "binary " + (f.blobs || "") : hunks[f.path]);
    return { path: f.path, oldPath: f.oldPath, status: f.status, adds: f.adds, dels: f.dels, hash,
             binary: f.binary, generated, large, hunks: f.hunks.length, lang: drawn.lang || "",
             collapsed: f.binary || generated || large || !!drawn.note };
  });

  // Risk and relatedness. Jev answers are reused while the patch is the same.
  const prior = S.exists(id) ? S.read(id) : null;
  const hash = S.patchHash(text);
  const cfg = repoConfig(src.root);
  let scoring;
  if (prior && prior.scoring && prior.scoring.patchHash === hash && prior.scoring.ok && !flag("rescore")) scoring = prior.scoring;
  else if (flag("no-jev")) scoring = { ok: false, jev: {}, why: "Jev scoring was turned off (--no-jev)" };
  else scoring = SC.jevScores(meta, { cfg, hunkText: p => hunks[p] });
  scoring = { ...scoring, patchHash: hash, at: scoring.at || new Date().toISOString() };
  const names = Array.isArray(cfg.edgeProviders) ? cfg.edgeProviders : GR.DEFAULT_PROVIDERS;
  // Edges that need file text are found now, while the text is in hand, and
  // kept; shared-finding and reviewer edges are recomputed on every arrange.
  const found = GR.edges(meta, { text: q => texts[q] || "", findings: [] }, names.filter(n => !GR.LIVE_PROVIDERS.includes(n)));
  scoring.providers = names;
  scoring.providersFromConfig = Array.isArray(cfg.edgeProviders);
  if (found.unknown.length) scoring.unknownProviders = found.unknown;

  const p = S.paths(id);
  const fresh = {
    id, title: opt("title") || (o.plan ? `${o.plan} · increment ${o.inc}` : src.label),
    source: { ...src, plan: o.plan || undefined, inc: o.inc ? Number(o.inc) : undefined },
    patchHash: hash,
    stats: { files: meta.length, adds: meta.reduce((x, f) => x + f.adds, 0), dels: meta.reduce((x, f) => x + f.dels, 0) },
    files: meta,
    edges: found.edges,
    scoring,
    highlight: plain ? (flag("plain") ? "off" : V.hljsMissing()) : "highlight.js " + V.HLJS_VERSION,
  };
  // Who may close findings is decided when a review is created, never on a
  // later open: otherwise the agent the policy restrains could re-open its
  // own review with the flag and grant itself the right.
  if (flag("agent-may-close")) {
    if (S.exists(id) && !(S.read(id).policy || {}).agentMayClose)
      die(`review ${id} was created without --agent-may-close, and that is not changed on a re-open. ` +
          "Only the human closes its findings, on the page.");
    fresh.policy = { agentMayClose: true };
  }
  // The quiz too: --quiz or the repo's default, fixed at creation, so a
  // re-open (with or without the flag) neither starts nor stops it.
  const quizAsked = flag("quiz") || cfg.quiz === true;
  let quizNote = "";
  if (!S.exists(id)) fresh.policy = { ...(fresh.policy || {}), quiz: quizAsked };
  else if (flag("quiz") && !(S.read(id).policy || {}).quiz)
    quizNote = `review ${id} was created without the quiz, and a re-open does not add it; open a new review (--id) to quiz`;
  const review = S.update(id, cur => {
    const m = S.merge(cur, fresh);
    m.policy = { agentMayClose: false, quiz: false, ...(m.policy || {}) };
    return arrange(m);
  });
  S.writeAtomic(p.patch, text);
  S.writeAtomic(p.rows, JSON.stringify(rows));
  const page = renderPage(id);
  const shown = showPage(id, page, src.root || cwd);
  if (flag("json")) {
    process.stdout.write(JSON.stringify({ id, page, store: p.json, patch: p.patch, files: meta.length,
      shown: shown || null, highlight: review.highlight, quiz: !!review.policy.quiz,
      scoring: { ok: review.scoring.ok, content: !!review.scoring.content, why: review.scoring.why || "" } }, null, 2) + "\n");
    return;
  }
  say(`lookout ${id}: ${review.title}`);
  say(`  ${meta.length} file(s), +${review.stats.adds} −${review.stats.dels}` +
      (plain ? `  (no highlighting: ${review.highlight})` : ""));
  const bands = SC.BANDS.map(([b]) => `${review.files.filter(f => f.band === b).length} ${b}`).join(", ");
  say(`  risk:  ${bands}; ${review.groups.filter(g => g.files.length > 1).length} related group(s)` +
      (review.scoring.ok ? `  (Jev${review.scoring.content ? " with hunk text" : ", paths and counts only"})`
                         : `  (signals only: ${review.scoring.why})`));
  say(`  page:  ${page}${shown ? "  (" + shown + ")" : ""}`);
  if (review.policy.quiz) say("  quiz:  on (a question on each high group before its note)");
  if (quizNote) say("  note:  " + quizNote);
  say(`  store: ${p.json}`);
  // --view-only: someone only wants to look (deep-plan diff); no reviewer hint.
  if (!flag("view-only") && !review.reviewedAt)
    say(`  next:  brief ONE reviewer subagent with \`lookout prompt ${id}\``);
}

// ---------------------------------------------------------------- findings

// Change a review under its lock, re-rank (findings move risk and groups),
// redraw the page, and refresh a tab already showing it.
function mutate(id, fn) {
  let out;
  const r = S.update(id, cur => { out = fn(cur); return arrange(cur); });
  const page = renderPage(id);
  showPage(id, page, (r.source && r.source.root) || process.cwd(), { onlyIfOpen: true });
  return { review: r, out };
}

function readInput(arg) {
  if (!arg || arg === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(path.resolve(arg), "utf8");
}

// The text of a reply or note: the words after the ids, else --file, else stdin
// when it is not a terminal.
function textArg(words) {
  if (opt("file")) return fs.readFileSync(path.resolve(opt("file")), "utf8");
  if (words.length) return words.join(" ");
  if (!process.stdin.isTTY) { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } }
  return "";
}

function cmdPrompt() {
  const id = reviewArg();
  const r = S.read(id);
  const p = S.paths(id);
  process.stdout.write(brief(r, { patchPath: p.patch, plansDir: path.dirname(S.REVIEWS_DIR),
                                  outPath: path.join(S.REVIEWS_DIR, id + ".incoming.json") }));
}

function cmdFindings() {
  const sub = positional()[0];
  const id = positional()[1];
  if (!id || !S.ID_OK.test(id) || !S.exists(id)) die(`findings ${sub || "add|list"} wants a review id (lookout list)`);
  if (sub === "add") {
    let input;
    try { input = FD.parseOutput(readInput(positional()[2])); } catch (e) { die(e.message); }
    const items = input.findings;
    let rows = {};
    try { rows = JSON.parse(fs.readFileSync(S.paths(id).rows, "utf8")); } catch { /* no rows: nothing is outside */ }
    const anchors = FD.anchorsFrom(rows);
    // A reviewer that answered [] has reviewed; one whose every finding was
    // rejected has not, and must not turn the gate's "no verdict" into a
    // pass, whatever notes came with them.
    const peek = FD.validate(S.read(id), items, anchors);
    if (items.length && !peek.accepted.length) {
      for (const r of peek.rejected) say(`  rejected item ${r.index}: ${r.why}`);
      die(`nothing accepted: all ${items.length} finding(s) were rejected; the review is unchanged`);
    }
    let fv, ev, nv, edgesAdded = 0, notesIn = { added: 0, replaced: 0 }, owed = [];
    const { out, review } = mutate(id, cur => {
      fv = FD.validate(cur, items, anchors);
      const added = FD.ingest(cur, fv.accepted, "reviewer");
      // Edges first, then a re-arrange, so each note is checked against the
      // groups the reviewer's own links produced (a quiz is owed by a group
      // that is high once they are in).
      ev = N.validateEdges(cur, input.edges);
      edgesAdded = N.ingestEdges(cur, ev.accepted);
      arrange(cur);
      nv = N.validateNotes(cur, input.notes, anchors);
      notesIn = N.ingestNotes(cur, nv.accepted, "reviewer");
      arrange(cur);
      owed = N.missing(cur);
      return added;
    });
    const dup = fv.accepted.length - out.length;
    say(`lookout ${id}: ${out.length} finding(s) added` + (dup ? `, ${dup} already there` : "") +
        (fv.rejected.length ? `, ${fv.rejected.length} rejected` : "") +
        `; ${edgesAdded} edge(s)` + (ev.rejected.length ? ` (${ev.rejected.length} rejected)` : "") +
        `; ${notesIn.added} note(s) added` + (notesIn.replaced ? `, ${notesIn.replaced} replaced` : "") +
        (nv.rejected.length ? `, ${nv.rejected.length} rejected` : ""));
    for (const f of out) say(`  ${f.id} ${f.severity.padEnd(7)} ${f.file}:${f.line}${f.outside ? " (outside the diff)" : ""}  ${f.short_summary}`);
    for (const r of fv.rejected) say(`  rejected item ${r.index}: ${r.why}`);
    for (const r of ev.rejected) say(`  rejected edge ${r.index}: ${r.why}`);
    if (ev.accepted.length && !providerNames(review).includes("reviewer"))
      say("  the edges are stored but not drawn: this repo's .seamux/lookout.json edgeProviders leaves out reviewer");
    for (const r of nv.rejected) say(`  rejected note ${r.index}: ${r.why}`);
    for (const d of nv.dropped) say(`  ${d}`);
    for (const n of review.notes || [])
      say(`  ${n.id} ${String(n.group || "-").padEnd(4)} ${n.files.join(", ")}` +
          (n.quiz ? "  [quiz]" : "") + (n.partial ? "  (partial: its files are split)" : "") + (n.stale ? "  (stale)" : ""));
    for (const m of owed) say(`  still owed: ${m}`);
    return;
  }
  if (sub === "list") {
    const r = S.read(id);
    let fs_ = r.findings || [];
    if (flag("open")) fs_ = fs_.filter(FD.isOpen);
    if (flag("json")) { process.stdout.write(JSON.stringify({ findings: fs_, threads: r.threads || [], notes: r.notes || [] }, null, 2) + "\n"); return; }
    if (!fs_.length && !(r.threads || []).length) { say("no findings"); return; }
    for (const f of fs_) {
      say(`${f.id} [${f.status}] ${f.severity} ${f.category} ${f.verdict} ${f.file}:${f.line}${f.side === "old" ? " (old)" : ""}`);
      say(`   ${f.summary}`);
      for (const m of f.thread || []) say(`   ${m.by}: ${m.kind === "status" ? `→ ${m.to}` + (m.text ? " — " + m.text : "") : m.text}`);
    }
    for (const t of r.threads || []) {
      say(`${t.id} [${t.status}] comment ${t.file}:${t.line}${t.side === "old" ? " (old)" : ""}`);
      for (const m of t.messages || []) say(`   ${m.by}: ${m.kind === "status" ? `→ ${m.to}` : m.text}`);
    }
    return;
  }
  die("findings add <id> <file|-> | findings list <id> [--open] [--json]");
}

// reply / address / resolve / dismiss / reopen <id> <finding-or-thread> [text]
function cmdThread(op) {
  const [id, fid, ...words] = positional();
  if (!id || !fid) die(`${op} <review-id> <finding-or-thread-id> [text]`);
  if (!S.ID_OK.test(id) || !S.exists(id)) die("no review " + id);
  const text = textArg(words);
  try {
    const { out } = mutate(id, cur => {
      if (op === "reply") return FD.reply(cur, fid, text, "agent");
      const to = { address: "addressed", resolve: "resolved", dismiss: "dismissed", reopen: "open" }[op];
      return FD.setStatus(cur, fid, to, "agent", text);
    });
    say(op === "reply" ? `replied on ${fid} (${out.id})` : `${fid} is now ${out.status}`);
  } catch (e) { die(e.message); }
}

// The gate deep-plan's review check runs. Exit 0 pass, 1 blocker/major open,
// 3 nothing to judge.
function cmdGate() {
  let id = positional()[0];
  if (!id && opt("plan")) id = S.idFrom(opt("plan"), "inc" + (opt("inc") || ""));
  if (!id) die("gate <id> | gate --plan SLUG --inc N");
  const r = S.ID_OK.test(id) && S.exists(id) ? S.read(id) : null;
  const g = FD.gate(r);
  if (flag("json")) process.stdout.write(JSON.stringify({ id, ...g }) + "\n");
  else say(`lookout gate ${id}: ${g.code === 0 ? "pass" : g.code === 1 ? "blocked" : "no verdict"} — ${g.why}` +
           (g.code === 3 && !r ? `\n  open one: lookout open${opt("plan") ? ` --plan ${opt("plan")} --inc ${opt("inc")}` : ""}, then run its reviewer (lookout prompt <id>)` : "") +
           (g.code === 3 && r ? `\n  brief a reviewer subagent with: lookout prompt ${id}` : ""));
  process.exit(g.code);
}

// ---------------------------------------------------------------- the rest

function cmdSetup() {
  say(`  ok    engine pointer -> ${V.ENGINE_FILE} (root ${HERE})`);
  say("  " + V.installShim());
  if (!(process.env.PATH || "").split(":").includes(V.SHIM_DIR))
    say(`  warn  ${V.SHIM_DIR} is not on PATH; add it to call \`lookout\` from your own shell`);
  const h = V.fetchHljs();
  if (h.ok) say(`  ok    highlight.js ${V.HLJS_VERSION}: ${h.how} (${V.HLJS_HOME})`);
  else { say(`  FAIL  highlight.js: ${h.why}`); process.exitCode = 1; }
}

function reviewArg() {
  const id = positional()[0];
  if (!id) die(`${verb} wants a review id (lookout list)`);
  if (!S.ID_OK.test(id) || !S.exists(id)) die("no review " + id);
  return id;
}

function cmdShow() {
  const r = S.read(reviewArg());
  if (flag("json")) { process.stdout.write(JSON.stringify(r, null, 2) + "\n"); return; }
  say(`${r.id}: ${r.title}`);
  for (const f of r.files)
    say(`  ${(f.band || "").padEnd(6)} ${f.status} ${f.path}${f.oldPath ? " (from " + f.oldPath + ")" : ""}  +${f.adds} −${f.dels}` +
        (f.collapsed ? "  [collapsed" + (f.binary ? ": binary" : f.generated ? ": generated" : f.large ? ": large" : "") + "]" : ""));
}

function cmdList() {
  const all = S.list();
  if (flag("json")) {
    process.stdout.write(JSON.stringify(all.map(r => ({ id: r.id, title: r.title, root: r.source?.root,
      updatedAt: r.updatedAt, files: r.stats?.files })), null, 2) + "\n");
    return;
  }
  if (!all.length) { say("no reviews yet (lookout open)"); return; }
  for (const r of all) say(`  ${r.id}  ${r.title}  (${r.stats?.files ?? 0} files, ${r.updatedAt})`);
}

function usage() {
  say(`lookout — review a diff in a browser pane beside the terminal

  lookout open [--base REF | --worktree | --range A..B | --patch FILE]
               [--id ID] [--title T] [--plan SLUG --inc N] [--agent-may-close] [--quiz]
               [--plain] [--no-jev] [--rescore] [--view-only] [--no-open] [--json]
        build the diff, store the review, draw the page and show it.
        Default: --base <origin's default branch, else main/master>, which
        compares the merge base with the working tree (uncommitted included).
        Files are ranked by risk (signals + one Jev score per file; hunk text
        is sent only to a loopback endpoint or with .seamux/lookout.json
        sendContent: true) and grouped by how they relate. --quiz (or
        .seamux/lookout.json quiz: true) puts a question before each high
        group's note; it never gates, and is fixed when the review is created.
  lookout prompt <id>       the reviewer brief: give it to ONE fresh subagent
  lookout findings add <id> <file|->     validate and ingest a reviewer's JSON:
                            {findings, edges, notes}, or a bare array of findings
  lookout findings list <id> [--open] [--json]
  lookout reply <id> <f#|t#> <text>      answer in a finding's or comment's thread
  lookout address <id> <f#> [note]       say a finding is fixed; the human closes it
  lookout resolve|dismiss <id> <f#> [note]  refused unless opened --agent-may-close
  lookout reopen <id> <f#|t#> [note]
  lookout gate <id> | --plan SLUG --inc N   exit 0 pass, 1 blocker/major open, 3 no review
  lookout render <id>       redraw the page from the store
  lookout sync <id>         re-rank and redraw (crew's intent server runs it after a page edit)
  lookout show <id> [--json]
  lookout list [--json]
  lookout setup             engine pointer, ~/.local/bin shim, pinned highlight.js
  lookout engine            print the engine pointer

  store: ${S.REVIEWS_DIR}/<id>.json`);
}

// ---------------------------------------------------------------- dispatch
// Every run refreshes the pointer, so whichever copy ran last is the one the
// shim finds. Never at the cost of the command itself.
let pointerBody = null;
try { pointerBody = V.writeEnginePointer(HERE); } catch { /* read-only home */ }

switch (verb) {
  case "open":   cmdOpen(); break;
  case "render": say(renderPage(reviewArg())); break;
  case "sync": {
    // After the intent server stores a comment or a close: re-rank and redraw.
    const id = reviewArg();
    S.update(id, cur => arrange(cur));
    renderPage(id);
    break;
  }
  case "prompt": cmdPrompt(); break;
  case "findings": cmdFindings(); break;
  case "reply": case "address": case "resolve": case "dismiss": case "reopen": cmdThread(verb); break;
  case "gate":   cmdGate(); break;
  case "show":   cmdShow(); break;
  case "list":   cmdList(); break;
  case "setup":  cmdSetup(); break;
  case "engine": process.stdout.write(pointerBody || JSON.stringify({ root: HERE, pointer: "not written" }, null, 2) + "\n"); break;
  case "help":   usage(); break;
  default:       usage(); die("unknown verb: " + verb);
}
