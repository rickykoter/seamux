// deep-plan serve: the plugin's own server for the plan and ask pages.
//
// The routes, query names and replies are crew-board's (app/crates/crew-board
// src/routes.rs, plans.rs, ask.rs), so a page cannot tell which server it came
// from, and crew-board can forward to this one without changing a byte. The
// guards are crew's too: every request must name this server's own loopback
// Host, and every route that acts needs the token the served page carries.
//
// The server is started on demand (`deep-plan serve --url <path>`, or any verb
// that opens a page), records itself in serve.json at mode 0600, and exits
// after IDLE_MS without a request. A dead or stale record costs one restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { STATE_DIR, PLANS_DIR } from "./state.mjs";
import { mermaidPath } from "./validate.mjs";
import { cmuxBin } from "./browser.mjs";
import { alive, sleep } from "./runner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE_DIR = path.join(HERE, "..", "serve");
export const SERVE_FILE = process.env.DEEP_PLAN_SERVE_FILE ||
  path.join(os.homedir(), ".claude", "deep-plan", "serve.json");
export const LOG_FILE = SERVE_FILE.replace(/\.json$/, "") + ".log";
export const IDLE_MS = Number(process.env.DEEP_PLAN_SERVE_IDLE_MS) || 30 * 60 * 1000;
export const SERVER_NAME = "deep-plan-serve";
const LOOKOUT_SERVE_FILE = process.env.LOOKOUT_SERVE_FILE ||
  path.join(os.homedir(), ".claude", "lookout", "serve.json");
const LOOKOUT_ENGINE_FILE = process.env.LOOKOUT_ENGINE_FILE ||
  path.join(os.homedir(), ".claude", "lookout", "engine.json");

export const SLUG_OK = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const CHECK_ID_OK = /^[a-z0-9-]{1,120}$/;
const ENV_NAME_OK = /^[A-Z_][A-Z0-9_]{0,63}$/;
const EVIDENCE_OK = /^inc\d+-[A-Za-z0-9._-]+-\d+\/(frame-\d{1,6}\.png|run\.png|trace\.jsonl)$/;
export const INC_ACTIONS = ["go", "start", "done", "block", "reset"];
export const CHECK_VERBS = ["run", "answer", "tab", "evidence", "proof", "attach"];
const ASKS_DIR = () => path.join(PLANS_DIR, "asks");

function log(msg) {
  const p = n => String(n).padStart(2, "0"), d = new Date();
  try { fs.appendFileSync(LOG_FILE, `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}\n`); }
  catch { /* a log we cannot write is not a failure */ }
}

export function ctEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- paths

// os.path.realpath: symlinks resolved as far as the path exists.
export function realpath(p) {
  let out = "/";
  for (const part of path.resolve(p).split(path.sep).filter(Boolean)) {
    if (part === "..") { out = path.dirname(out); continue; }
    out = path.join(out, part);
    try { out = fs.realpathSync(out); } catch { /* the rest does not exist yet */ }
  }
  return out;
}
const within = (t, base) => t === base || t.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

function unquote(s) { try { return decodeURIComponent(s); } catch { return s; } }

export function planPage(slug) {
  if (!SLUG_OK.test(slug)) return null;
  for (const sfx of [".working.html", ".review.html"]) {
    const p = path.join(PLANS_DIR, slug + sfx);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// A /plan/ segment: a bare slug, a plan's own page (<slug>.working.html or
// <slug>.review.html), or a .md inside PLANS_DIR. No other .html: anything
// else under PLANS_DIR (lookout's reviews/<id>.html, an export) is not a plan
// page, and served from this origin it could read a token-bearing page.
const PLAN_HTML = /^([a-z0-9][a-z0-9._-]{0,120})\.(working|review)\.html$/;
export function planAsset(rel) {
  rel = unquote(rel).trim();
  if (!rel || rel.startsWith("/")) return null;
  if (rel.endsWith(".html")) {
    const m = rel.match(PLAN_HTML);
    if (!m || !SLUG_OK.test(m[1])) return null;
  } else if (!rel.endsWith(".md")) return planPage(rel);
  const base = realpath(PLANS_DIR), target = realpath(path.join(PLANS_DIR, rel));
  if (!within(target, base)) return null;
  try { return fs.statSync(target).isFile() ? target : null; } catch { return null; }
}

// The slug a served plan page belongs to, from the file it resolved to.
export function planSlugOf(file) {
  const m = path.basename(file).match(PLAN_HTML);
  return m && realpath(path.dirname(file)) === realpath(PLANS_DIR) ? m[1] : null;
}

// A file's change stamp: inode, size and mtime to the sub-millisecond, so two
// writes in one second, or a rename over it, never look the same.
export function fileStamp(file) {
  try { const s = fs.statSync(file); return `${s.ino}-${s.size}-${s.mtimeMs}`; } catch { return ""; }
}

export function evidenceFile(slug, rel) {
  if (!SLUG_OK.test(slug)) return null;
  rel = unquote(rel);
  if (!EVIDENCE_OK.test(rel)) return null;
  const base = realpath(path.join(PLANS_DIR, slug + ".runs")), target = realpath(path.join(base, rel));
  try { return within(target, base) && fs.statSync(target).isFile() ? target : null; } catch { return null; }
}

export function askPath(id, ext) {
  if (!SLUG_OK.test(id)) return null;
  const base = realpath(ASKS_DIR()), target = realpath(path.join(ASKS_DIR(), id + ext));
  if (!within(target, base) || target === base) return null;
  try { return fs.statSync(target).isFile() ? target : null; } catch { return null; }
}

export function swapMermaid(html) {
  return html.replace(/src="data:text\/javascript;base64,[A-Za-z0-9+/=]+"/, 'src="/mermaid.min.js"');
}

function injectFirst(html, boot) {
  const i = html.indexOf("</body>");
  return i < 0 ? html + boot : html.slice(0, i) + boot + html.slice(i);
}

function planRoot(slug) {
  if (!SLUG_OK.test(slug)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, slug + ".json"), "utf8")).root || null; }
  catch { return null; }
}

// ---------------------------------------------------------------- actions

function lastLine(s, n) { return String(s).trim().split("\n").pop().slice(0, n); }

// Asynchronous, so a slow engine call (a proof can take minutes) never stops
// this server answering /health or another page. DEEP_PLAN_FROM_SERVE: the
// page that asked is already open, so the engine must not open it again.
// Resolves null on a timeout.
// Only a transition marks the call as the page's own (fromServe): a check
// run detaches a runner whose recipe commands must see a normal environment.
function runEngine(script, args, secs, { fromServe = false } = {}) {
  return new Promise(resolve => {
    let out = "", err = "", done = false;
    const env = { ...process.env };
    if (fromServe) env.DEEP_PLAN_FROM_SERVE = "1"; else delete env.DEEP_PLAN_FROM_SERVE;
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill("SIGKILL"); resolve(null); } }, secs * 1000);
    child.stdout.on("data", c => out += c);
    child.stderr.on("data", c => err += c);
    child.on("error", e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: 1, out: "", err: e.message }); } });
    child.on("close", code => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? 1, out, err }); } });
  });
}

const runCli = (cli, args, secs) => runEngine(cli, args, secs);

export async function increment(script, slug, n, action, why) {
  if (!SLUG_OK.test(slug)) return [false, "bad slug"];
  if (!/^\d+$/.test(n)) return [false, "bad increment"];
  if (!INC_ACTIONS.includes(action)) return [false, "bad transition"];
  const args = [action, slug, n];
  if (action === "block") args.push(why || "blocked from the plan surface");
  // A go from the page is a person's click, as on crew's page.
  if (action === "go") args.push("--by", "human");
  const r = await runEngine(script, args, 90, { fromServe: true });
  if (!r) { log(`FAIL inc ${action} ${slug} ${n}: timed out`); return [false, "deep-plan did not finish in 90s"]; }
  const detail = lastLine(r.out + r.err, 160);
  if (r.code !== 0) { log(`FAIL inc ${action} ${slug} ${n}: ${detail}`); return [false, detail || "deep-plan refused it"]; }
  return [true, `${action} ${slug} ${n}`];
}

export function checkActionArgs(verb, slug, n, id, name, value) {
  if (!CHECK_VERBS.includes(verb)) throw new Error("bad check action");
  if (!SLUG_OK.test(slug)) throw new Error("bad slug");
  if (!/^\d+$/.test(n)) throw new Error("bad increment");
  if (!CHECK_ID_OK.test(id)) throw new Error("bad check id");
  switch (verb) {
    case "run": return ["check", "run", slug, n, id, "--detach"];
    case "tab": return ["check", "tab", slug, n, id];
    case "evidence": return ["check", "evidence", slug, n, id, "--json"];
    case "proof": return ["proof", slug, n, id, "--json"];
    case "attach": return ["proof", slug, n, id, "--attach", "--yes"];
  }
  if (!ENV_NAME_OK.test(name)) throw new Error("the answer needs the claim's variable name");
  value = String(value || "").trim();
  if (!value) throw new Error("an empty answer is no answer");
  // eslint-disable-next-line no-control-regex
  if ([...value].length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error("the answer is too long or carries control characters");
  return ["check", "run", slug, n, id, "--detach", "--set", `${name}=${value}`];
}

// Where /open sends a file: crew's opener when crew is installed, else an
// editor or the system's default app.
function openerFor(arg) {
  const crew = path.join(process.env.CREW_HOME || path.join(os.homedir(), ".config", "cmux", "crew"), "bin", "crew-code-open");
  if (fs.existsSync(crew)) return ["bash", [crew, arg]];
  const onPath = b => String(process.env.PATH || "").split(path.delimiter).some(d => d && fs.existsSync(path.join(d, b)));
  if (onPath("code")) return ["code", ["--goto", arg]];
  const bare = arg.replace(/(:\d+){1,2}$/, "");
  // -t: as text in the default editor, so a .command or .app is shown, never run.
  if (process.platform === "darwin") return ["open", ["-t", bare]];
  return ["xdg-open", [bare]];
}

export function openFile(slug, rel) {
  const root = planRoot(slug);
  if (!root) return [false, `no worktree recorded for ${slug || "?"}`];
  rel = unquote(rel).trim();
  if (!rel || rel.startsWith("/")) return [false, "not a relative path"];
  const m = rel.match(/^(.*?)((?::\d+){1,2})$/);
  const [bare, suffix] = m ? [m[1], m[2]] : [rel, ""];
  const base = realpath(root), target = realpath(path.join(base, bare));
  if (!within(target, base)) return [false, "outside the worktree"];
  if (!fs.existsSync(target)) return [false, `not created yet: ${bare}`];
  const [cmd, args] = (process.env.DEEP_PLAN_OPENER ? [process.env.DEEP_PLAN_OPENER, [target + suffix]] : openerFor(target + suffix));
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 20000 });
  const ok = r.status === 0;
  return [ok, ok ? `opened ${rel}` : `the opener refused ${rel}`];
}

// ---------------------------------------------------------------- asks

const CONFIRM_TRIES = 5;
const CONFIRM_GAP = Number(process.env.DEEP_PLAN_CONFIRM_GAP_MS) || 300;

function cmuxRun(argv) {
  const bin = cmuxBin();
  if (!bin) return [1, "cmux is not reachable"];
  const r = spawnSync(bin, argv, { encoding: "utf8", timeout: 10000, env: { ...process.env, CMUX_QUIET: "1" } });
  return [r.status === 0 ? 0 : 1, (r.stdout || "") + (r.stderr || "") + (r.error ? r.error.message : "")];
}

const squash = s => String(s).replace(/\s+/g, "");
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Python's `pattern % value`: the first %s or %d filled, %% a literal %.
// Only the pattern's own %% are collapsed, never the value's.
function fill(pat, slot, value) {
  let used = false;
  return pat.replace(/%%|%[sd]/g, m => {
    if (m === "%%") return "%";
    if (m === slot && !used) { used = true; return value; }
    return m;
  });
}
function compile(name, pat, flags = "") {
  try { return new RegExp(pat, flags); } catch (e) { log(`FAIL ${name} does not compile: ${e.message}`); return null; }
}
const resolvedRe = label => compile("CREW_ASK_RESOLVED_RE", fill(process.env.CREW_ASK_RESOLVED_RE || "→\\s*%s\\s*$", "%s", reEscape(label)));
function selectedRe(n) {
  let pat = fill(process.env.CREW_ASK_SELECTED_RE || "^\\s*[❯›>]\\s*%d[.)]", "%d", String(n));
  if (!pat.startsWith("^")) pat = `^(?:${pat})`;
  return compile("CREW_ASK_SELECTED_RE", pat);
}

// Type option n into the ask's own cmux surface, and prove it landed. Looks
// before typing, and sends Enter only when the pointer moved to n without the
// prompt resolving. Never blind. (crew-board ask.rs deliver, ADR 0003.)
// The third value says whether the digit reached the terminal at all: when
// it did not, nothing changed there and the pick may be tried again.
export async function deliver(surface, n, label, run = cmuxRun) {
  if (!surface) return [false, `the ask recorded no terminal surface — press ${n} in the terminal`, false];
  let [rc, screen] = run(["read-screen", "--surface", surface, "--lines", "60"]);
  if (label && (rc !== 0 || !squash(screen).includes(squash(label))))
    return [false, `the terminal is not showing this question — switch to it, then press ${n}`, false];
  let out;
  [rc, out] = run(["send", "--surface", surface, String(n)]);
  if (rc !== 0) return [false, `cmux send failed (${out.trim().slice(0, 80)}) — press ${n} in the terminal`, false];
  for (let attempt = 0; attempt <= CONFIRM_TRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, CONFIRM_GAP));
    [rc, screen] = run(["read-screen", "--surface", surface, "--lines", "60"]);
    const lines = rc === 0 ? screen.split(/\r\n|\r|\n/) : [];
    const res = label && resolvedRe(label);
    if (res && lines.some(l => res.test(l))) return [true, `delivered ${n} — the prompt took it`, true];
    const sel = selectedRe(n);
    if (sel && lines.some(l => sel.test(l))) {
      [rc, out] = run(["send-key", "--surface", surface, "enter"]);
      if (rc !== 0) return [false, `${n} is selected; Enter did not send (${out.trim().slice(0, 80)}) — press Enter`, true];
      return [true, `delivered ${n} — selected, then Enter`, true];
    }
  }
  return [false, `typed ${n} but could not confirm it on screen — check the terminal`, true];
}

function localTime() {
  const d = new Date(), p = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// One answer at a time: a double submit types the digit once.
let answering = Promise.resolve();
export function answer(id, nRaw, run) {
  const next = answering.then(() => answerOne(id, nRaw, run));
  answering = next.catch(() => {});
  return next;
}

async function answerOne(id, nRaw, run) {
  const jp = askPath(id, ".json");
  if (!jp) return [false, false, "no such ask"];
  let ask;
  try { ask = JSON.parse(fs.readFileSync(jp, "utf8")); } catch (e) { return [false, false, `unreadable ask: ${e.message}`]; }
  if (!/^\d+$/.test(nRaw || "")) return [false, false, "bad option"];
  const n = Number(nRaw), options = Array.isArray(ask.options) ? ask.options : [];
  if (n < 1 || n > options.length) return [false, false, `option ${n} is not one of ${options.length}`];
  if (ask.answer) return [false, false, `already answered: ${ask.answer.n ?? 0}`];
  const label = String(options[n - 1].label || "");
  // Typing happens only where the ask recorded a cmux surface. Anywhere else
  // the page records the pick and the chat prompt stays the answer of record.
  const [delivered, detail, typed] = ask.surface
    ? await deliver(String(ask.surface), n, label, run)
    : [false, `answer ${n} in the chat prompt — this page shows the options but cannot type there`, false];
  // Nothing reached the terminal: record nothing, so the pick can be made
  // again once the question is on screen. A digit that was typed (even
  // unconfirmed) is recorded: typing it twice could answer the next prompt.
  if (ask.surface && !typed) {
    log(`ask ${id} not delivered (${detail}); left open`);
    return [false, false, detail];
  }
  ask.answer = { n, at: localTime(), delivered };
  try { fs.writeFileSync(jp, JSON.stringify(ask, null, 2) + "\n"); }
  catch (e) { return [false, delivered, `recorded nothing: ${e.message}`]; }
  log(`ask ${id} answered ${n} (${delivered ? "typed" : "shown"})`);
  return [true, delivered, detail];
}

// ---------------------------------------------------------------- lookout

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// lookout serve's URL for a path, starting it through lookout's own CLI when
// nothing answers. ADR 0004: never an import, only the CLI.
export async function lookoutUrl(rel) {
  const eng = readJson(LOOKOUT_ENGINE_FILE);
  const cli = eng && eng.root && path.join(eng.root, "lookout.mjs");
  if (!cli || !fs.existsSync(cli)) return "";
  const r = await runCli(cli, ["serve", "--url", rel], 15);
  const url = r && r.code === 0 && r.out.trim().split("\n").pop();
  return url && /^http:\/\/127\.0\.0\.1:\d+\//.test(url) ? url : "";
}

// ---------------------------------------------------------------- server

function send(res, code, ctype, body, cache = "no-store") {
  res.writeHead(code, { "Content-Type": ctype, "Cache-Control": cache, "Content-Length": Buffer.byteLength(body), "Server": SERVER_NAME });
  res.end(body);
}
const reply = (res, code, obj) => send(res, code, "application/json", typeof obj === "string" ? obj : JSON.stringify(obj));

export function makeServer({ script, version, root, token, onRequest = () => {}, run }) {
  const asset = name => fs.readFileSync(path.join(SERVE_DIR, name), "utf8");
  let port = 0;
  const server = http.createServer(async (req, res) => {
    onRequest();
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        log(`DENY host ${host === undefined ? "None" : `'${host}'`}`);
        return reply(res, 403, { error: "unknown host" });
      }
      const u = new URL(req.url, "http://x");
      const p = u.pathname, one = k => u.searchParams.get(k) || "";
      const tokenOk = () => ctEq(one("t"), token);
      const deny = what => { log(`DENY bad token on ${what} from 127.0.0.1`); reply(res, 403, '{"error":"bad token"}'); };
      if (req.method === "POST") {
        res.setHeader("Connection", "close"); // the body is never read
        // The plan and ask pages never POST; review POSTs belong to lookout's
        // server, whose page posts to its own origin.
        return reply(res, 404, { error: "no such path" });
      }
      if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method not allowed" });
      if (p === "/health") return reply(res, 200, { ok: true, server: "deep-plan", pid: process.pid, version, root });
      if (p === "/mermaid.min.js") {
        const m = mermaidPath();
        if (!m) return reply(res, 404, '{"error":"no vendored mermaid"}');
        return send(res, 200, "text/javascript; charset=utf-8", fs.readFileSync(m), "public, max-age=31536000, immutable");
      }
      if (p === "/plan-stamp") {
        // `slug` is the served page's own segment (a slug or <slug>.review.html).
        // `mtime` (whole seconds) is kept for an older page; `stamp` is exact.
        const a = planAsset(one("slug"));
        let mt = 0; try { mt = a ? Math.floor(fs.statSync(a).mtimeMs / 1000) : 0; } catch { /* gone */ }
        return reply(res, 200, { mtime: mt, stamp: a ? fileStamp(a) : "" });
      }
      if (p === "/open") {
        if (!tokenOk()) return deny("/open");
        const [ok, detail] = openFile(one("slug"), one("path"));
        log(`${ok ? "OK  " : "FAIL"} open ${detail}`);
        return reply(res, ok ? 200 : 500, { ok, detail });
      }
      if (p === "/answer") {
        if (!tokenOk()) return deny("/answer");
        const [ok, delivered, detail] = await answer(one("id"), one("n"), run);
        log(`${ok ? "OK  " : "FAIL"} answer ${one("id")}: ${detail}`);
        return reply(res, ok ? 200 : 400, { ok, delivered, detail });
      }
      if (p === "/inc") {
        if (!tokenOk()) return deny("/inc");
        const [ok, detail] = await increment(script, one("slug"), one("n"), one("a"), one("why"));
        log(`${ok ? "OK  " : "FAIL"} inc ${detail}`);
        return reply(res, ok ? 200 : 500, { ok, detail });
      }
      if (p.startsWith("/check/")) {
        let verb = p.slice("/check/".length);
        if (!["run", "answer", "tab", "evidence", "proof"].includes(verb)) return reply(res, 404, '{"error":"no such path"}');
        if (verb === "proof" && one("attach") === "1") verb = "attach";
        if (!tokenOk()) return deny(`/check/${verb}`);
        let args;
        try { args = checkActionArgs(verb, one("slug"), one("n"), one("id"), one("name"), one("value")); }
        catch (e) { return reply(res, 400, { ok: false, detail: e.message }); }
        const limit = verb === "proof" || verb === "attach" ? 300 : 60;
        const r = await runEngine(script, args, limit);
        if (!r) return reply(res, 400, { ok: false, detail: `deep-plan did not finish in ${limit}s` });
        if (r.code !== 0) return reply(res, 400, { ok: false, detail: lastLine(r.out + r.err, 200) || "deep-plan refused it" });
        if (verb === "evidence" || verb === "proof") {
          try { return reply(res, 200, JSON.parse(r.out)); }
          catch { return reply(res, 500, { ok: false, detail: "deep-plan's evidence was not JSON" }); }
        }
        log(`OK   check ${verb} ${one("slug")} ${one("n")} ${one("id")}`);
        return reply(res, 200, { ok: true, detail: lastLine(r.out, 200) });
      }
      if (p.startsWith("/plan/")) {
        const seg = unquote(p.slice("/plan/".length)).trim();
        const page = planAsset(seg);
        if (!page) return reply(res, 404, '{"error":"no such plan page"}');
        // The stamp before the read: a write between the two shows as a change.
        const stamp = fileStamp(page);
        const html = fs.readFileSync(page, "utf8");
        if (page.endsWith(".md")) return send(res, 200, "text/plain; charset=utf-8", html);
        const slug = planSlugOf(page);
        if (!slug) return reply(res, 404, '{"error":"no such plan page"}');
        // Function replacers: a $& or $' in a value is text, not a pattern.
        const boot = asset("plan.js").replace("__TOKEN__", () => token).replace("__SLUG__", () => slug)
          .replace("__PAGE__", () => seg).replace("__STAMP__", () => stamp);
        return send(res, 200, "text/html; charset=utf-8", injectFirst(swapMermaid(html), boot));
      }
      if (p.startsWith("/plan-evidence/")) {
        const rest = p.slice("/plan-evidence/".length), i = rest.indexOf("/");
        const file = i > 0 && evidenceFile(unquote(rest.slice(0, i)), rest.slice(i + 1));
        if (!file) return reply(res, 404, '{"error":"no such evidence"}');
        return send(res, 200, file.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8", fs.readFileSync(file));
      }
      if (p.startsWith("/ask/")) {
        const id = p.slice("/ask/".length), page = askPath(id, ".html");
        if (!page) return reply(res, 404, '{"error":"no such ask"}');
        const boot = asset("ask.js").replace("__TOKEN__", () => token).replace("__ID__", () => id);
        return send(res, 200, "text/html; charset=utf-8", injectFirst(swapMermaid(fs.readFileSync(page, "utf8")), boot));
      }
      if (p.startsWith("/review/")) {
        // The working page links its increments' reviews here. They are
        // lookout's pages: send the browser to lookout's own server.
        const to = await lookoutUrl(p + u.search);
        if (!to) return reply(res, 404, { error: "lookout is not installed, so there is no review server" });
        res.writeHead(302, { Location: to, "Content-Length": 0, "Server": SERVER_NAME });
        return res.end();
      }
      return reply(res, 404, '{"error":"no such path"}');
    } catch (e) {
      log(`FAIL ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) reply(res, 500, { error: e.message });
    }
  });
  server.on("listening", () => { port = server.address().port; });
  return server;
}

// The foreground server: listens, records itself, exits when idle.
export function serveForeground({ script, version, root, port = 0 }) {
  const token = crypto.randomBytes(24).toString("hex");
  let last = Date.now(), started = false, missing = 0;
  const server = makeServer({ script, version, root, token, onRequest: () => { last = Date.now(); } });
  const tidy = () => {
    const cur = readJson(SERVE_FILE);
    if (cur && cur.pid === process.pid) fs.rmSync(SERVE_FILE, { force: true });
  };
  server.listen(port, "127.0.0.1", () => {
    // Look, then write, under a start lock: two servers starting at once
    // must not both find no record and both write one.
    fs.mkdirSync(path.dirname(SERVE_FILE), { recursive: true });
    const lock = SERVE_FILE + ".start";
    let held = false;
    for (let i = 0; i < 60 && !held; i++) {
      try { fs.mkdirSync(lock); held = true; break; }
      catch {
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch { /* raced */ }
        sleep(50);
      }
    }
    // Only the holder removes the lock; a starter that waited it out goes on
    // without it and leaves the holder's lock alone.
    const release = () => { if (held) try { fs.rmdirSync(lock); } catch { /* gone */ } };
    // A starter that lost a race: another server is recorded and healthy.
    const other = readJson(SERVE_FILE);
    if (other && other.pid !== process.pid && alive(other.pid) && (health(other.port) || {}).pid === other.pid) {
      release();
      log(`another server (pid ${other.pid}) is already recorded; exiting`);
      server.close(); process.exit(0);
    }
    const rec = { port: server.address().port, token, pid: process.pid, version, root, started: new Date().toISOString() };
    fs.mkdirSync(path.dirname(SERVE_FILE), { recursive: true });
    const tmp = SERVE_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, SERVE_FILE);
    release();
    started = true;
    log(`listening on 127.0.0.1:${rec.port} (pid ${process.pid}, ${root})`);
  });
  const timer = setInterval(() => {
    // No longer the recorded server (stopped, or replaced): nobody can find
    // this one, so it goes.
    // Another live server recorded, or no record three checks running (a
    // file being rewritten is never mistaken for a stop).
    const cur = readJson(SERVE_FILE);
    missing = cur ? 0 : missing + 1;
    if (started && ((cur && cur.pid !== process.pid && alive(cur.pid)) || missing >= 3)) {
      log("serve.json no longer names this server, exiting");
      clearInterval(timer); server.close(); process.exit(0);
    }
    if (Date.now() - last < IDLE_MS) return;
    log(`idle for ${Math.round(IDLE_MS / 60000)} min, exiting`);
    clearInterval(timer); tidy(); server.close(); process.exit(0);
  }, Math.min(IDLE_MS, 10000));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { tidy(); process.exit(0); });
  return server;
}

// ---------------------------------------------------------------- client

// GET /health on a recorded port, synchronously (verbs are synchronous).
// /health's reply, or { busy: true } when the port took the connection but
// did not answer in time (a server held up under a review's lock), or null.
function health(port) {
  const js = `fetch("http://127.0.0.1:${port}/health",{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.exit(e&&e.name==="TimeoutError"?3:1))`;
  const r = spawnSync(process.execPath, ["-e", js], { encoding: "utf8", timeout: 8000 });
  if (r.status === 3) return { busy: true };
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// The live server's record, when it is ours: the pid in serve.json answers
// /health on that port, from this engine's root. Anything else is stale.
// A server from another copy of the engine (the kept checkout and a worktree)
// is used as it is, not replaced: its open pages keep their port and token.
export function liveServer(root) {
  const rec = readJson(SERVE_FILE);
  if (!rec || !rec.port || !rec.token || !alive(rec.pid)) return null;
  const h = health(rec.port);
  // Busy and its pid alive: still the live server; another would change the
  // open pages' token.
  if (h && h.busy) return root && rec.root && rec.root !== root ? { ...rec, foreign: true } : rec;
  if (!h || h.server !== "deep-plan" || h.pid !== rec.pid) return null;
  return root && h.root !== root ? { ...rec, foreign: true } : rec;
}

// Start a server unless one of ours answers; returns its record or null.
export function ensureServer({ script, root }) {
  let rec = liveServer(root);
  if (rec) return rec;
  fs.mkdirSync(path.dirname(SERVE_FILE), { recursive: true });
  const fd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [script, "serve", "--foreground"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
  // Two starters can race; whichever server's record lands, both use it, and
  // a child that lost exits.
  for (let i = 0; i < 50; i++) {
    sleep(100);
    rec = readJson(SERVE_FILE);
    if (rec && rec.pid && alive(rec.pid) && (rec.pid === child.pid || liveServer(root))) {
      if (rec.pid !== child.pid) { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } }
      return rec;
    }
  }
  return null;
}

export function stopServer() {
  // Signal only a pid that answers /health as this server: a pid in a stale
  // record may since belong to something else.
  const rec = liveServer();
  if (!rec) { fs.rmSync(SERVE_FILE, { force: true }); return false; }
  try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 20 && alive(rec.pid); i++) sleep(100);
  return true;
}

export const urlFor = (rec, rel) => `http://127.0.0.1:${rec.port}${rel.startsWith("/") ? rel : "/" + rel}`;
