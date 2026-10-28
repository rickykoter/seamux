// lookout serve: the plugin's own server for review pages.
//
// The routes and replies are crew-board's (app/crates/crew-board src/routes.rs
// review_get and post, review.rs apply), so the page (page/review.js serve())
// works the same from either server, and crew-board can forward to this one
// unchanged. The guards are crew's too: the request must name this server's
// own loopback Host; the record and every POST need the token the page
// carries; a POST also needs this server's Origin, a JSON body and a size cap.
//
// Started on demand by `lookout serve --url <path>` or `lookout open`, it
// records itself in serve.json at mode 0600 and exits after IDLE_MS idle.
// deep-plan's server (deep-plan/lib/serve.mjs) has the same shape; ADR 0004
// keeps the two plugins from sharing the code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as S from "./store.mjs";

export const SERVE_FILE = process.env.LOOKOUT_SERVE_FILE ||
  path.join(os.homedir(), ".claude", "lookout", "serve.json");
export const LOG_FILE = SERVE_FILE.replace(/\.json$/, "") + ".log";
export const IDLE_MS = Number(process.env.LOOKOUT_SERVE_IDLE_MS) || 30 * 60 * 1000;
export const SERVER_NAME = "lookout-serve";
export const MAX_BODY = 64 * 1024;
const MAX_TEXT = 4000;
const OPS = ["comment", "resolve", "dismiss", "reopen", "answer"];

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

function log(msg) {
  const p = n => String(n).padStart(2, "0"), d = new Date();
  try { fs.appendFileSync(LOG_FILE, `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}\n`); }
  catch { /* a log we cannot write is not a failure */ }
}

export function ctEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// A review id from a URL to its file, or null: anchored, and inside REVIEWS_DIR.
export function reviewPath(id, ext) {
  if (!S.ID_OK.test(id)) return null;
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const base = real(S.REVIEWS_DIR), target = real(path.join(S.REVIEWS_DIR, id + ext));
  if (target === base || !target.startsWith(base + path.sep)) return null;
  try { return fs.statSync(target).isFile() ? target : null; } catch { return null; }
}

// ---------------------------------------------------------------- ops

function nextId(items, prefix) {
  let n = 0;
  for (const x of items) {
    const id = x && typeof x.id === "string" ? x.id : "";
    if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) n = Math.max(n, Number(id.slice(prefix.length)));
  }
  return prefix + (n + 1);
}

const now = () => new Date().toISOString();
const isInt = v => typeof v === "number" && Number.isInteger(v);
const list = (o, k) => { if (!Array.isArray(o[k])) o[k] = []; return o[k]; };
function message(msgs, text, extra = {}) {
  msgs.push({ id: nextId(msgs, "m"), by: "human", at: now(), text, ...extra });
}

// One op from the page, as the human: [http code, reply]. The same rules as
// crew-board's review.rs apply, under lookout's own lock.
export function apply(id, body, { sync = syncReview } = {}) {
  const op = typeof body.op === "string" ? body.op : "";
  if (!OPS.includes(op)) return [400, { error: "unknown op" }];
  const text = [...String(body.text ?? "").trim()].slice(0, MAX_TEXT).join("");
  let itemId = body.item == null ? "" : String(body.item);
  let result;
  try {
    result = S.withLock(id, () => {
      const file = S.paths(id).json;
      let review;
      try { review = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { return e.code === "ENOENT" ? [404, { error: "no such review" }] : [409, { error: e.message }]; }
      if (!review || typeof review !== "object" || Array.isArray(review)) return [409, { error: "the review record is not an object" }];
      list(review, "findings"); list(review, "threads");
      let item = null; // [listName, index]
      if (op === "answer") {
        if (!(review.policy && review.policy.quiz)) return [400, { error: "this review has no quiz" }];
        const note = (Array.isArray(review.notes) ? review.notes : []).find(n => n && n.id === itemId);
        const quiz = note && note.quiz && typeof note.quiz === "object" && !Array.isArray(note.quiz) ? note.quiz : null;
        if (!quiz) return [404, { error: `no question on note ${itemId}` }];
        const nOpts = Array.isArray(quiz.options) ? quiz.options.length : 0;
        if (!isInt(body.pick) || body.pick < 0 || body.pick >= nOpts) return [400, { error: "pick is an option's index as written" }];
        if (quiz.answered) return [409, { error: "already answered", review }];
        quiz.answered = { pick: body.pick, correct: quiz.answer === body.pick, at: now(), by: "human" };
      } else if (itemId) {
        let i = review.findings.findIndex(f => f && f.id === itemId);
        if (i >= 0) item = ["findings", i];
        else if ((i = review.threads.findIndex(t => t && t.id === itemId)) >= 0) item = ["threads", i];
        else return [404, { error: `no finding or thread ${itemId}` }];
      }
      if (op === "comment") {
        if (!text) return [400, { error: "an empty comment says nothing" }];
        if (item) {
          const it = review[item[0]][item[1]];
          if (!it || typeof it !== "object" || Array.isArray(it)) return [400, { error: "the item is not an object" }];
          message(list(it, item[0] === "findings" ? "thread" : "messages"), text);
        } else {
          const f = body.file == null ? "" : String(body.file);
          const side = body.side ? body.side : "new";
          if (!(review.files || []).some(x => x && x.path === f)) return [400, { error: "file is not in this review" }];
          if (!isInt(body.line) || body.line < 1 || (side !== "new" && side !== "old"))
            return [400, { error: "a comment needs a line and a side" }];
          const tid = nextId(review.threads, "t"), msgs = [];
          message(msgs, text);
          review.threads.push({ id: tid, file: f, line: body.line, side, status: "open", by: "human", createdAt: now(), messages: msgs });
          itemId = tid;
        }
      } else if (op !== "answer") {
        if (!item) return [400, { error: `${op} needs an item` }];
        let to = op === "resolve" ? "resolved" : op === "dismiss" ? "dismissed" : "open";
        if (item[0] === "threads" && to === "dismissed") to = "resolved";
        const it = review[item[0]][item[1]];
        if (!it || typeof it !== "object" || Array.isArray(it)) return [400, { error: "the item is not an object" }];
        const from = it.status || "open";
        Object.assign(it, { status: to, statusBy: "human", statusAt: now() });
        message(list(it, item[0] === "findings" ? "thread" : "messages"), text, { kind: "status", from, to });
      }
      review.updatedAt = now();
      try { S.writeAtomic(file, JSON.stringify(review, null, 2) + "\n"); }
      catch (e) { return [409, { error: e.message }]; }
      return [200, { ok: true, item: itemId, review }];
    });
  } catch (e) { return [409, { error: e.message }]; }
  if (result[0] === 200) sync(id);
  return result;
}

// Re-rank and redraw in the background, as crew's server does; best-effort.
export function syncReview(id) {
  try {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lookout.mjs");
    spawn(process.execPath, [cli, "sync", id], { detached: true, stdio: "ignore", env: process.env }).unref();
  } catch { /* the page polls the record either way */ }
}

// ---------------------------------------------------------------- server

function send(res, code, ctype, body) {
  res.writeHead(code, { "Content-Type": ctype, "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body), "Server": SERVER_NAME });
  res.end(body);
}
const reply = (res, code, obj) => send(res, code, "application/json", typeof obj === "string" ? obj : JSON.stringify(obj));

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

export function makeServer({ version, root, token, onRequest = () => {}, sync }) {
  let port = 0;
  const server = http.createServer(async (req, res) => {
    onRequest();
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        log(`DENY host ${host === undefined ? "None" : `'${host}'`}`);
        return reply(res, 403, { error: "unknown host" });
      }
      const u = new URL(req.url, "http://x"), p = u.pathname;
      if (req.method === "GET" || req.method === "HEAD") {
        if (p === "/health") return reply(res, 200, { ok: true, server: "lookout", pid: process.pid, version, root });
        if (!p.startsWith("/review/")) return reply(res, 404, '{"error":"no such path"}');
        const rest = p.slice("/review/".length);
        if (rest.endsWith(".json")) {
          if (!ctEq(u.searchParams.get("t") || "", token)) { log("DENY bad token on /review json from 127.0.0.1"); return reply(res, 403, { error: "bad token" }); }
          const f = reviewPath(rest.slice(0, -5), ".json");
          if (!f) return reply(res, 404, { error: "no such review" });
          return send(res, 200, "application/json", fs.readFileSync(f));
        }
        const f = reviewPath(rest, ".html");
        if (!f) return reply(res, 404, { error: "no such review" });
        const html = fs.readFileSync(f, "utf8");
        const boot = `<script>window.lookout && window.lookout.serve({ token: "${token}", id: "${rest}" });</script>\n`;
        const i = html.lastIndexOf("</body>");
        return send(res, 200, "text/html; charset=utf-8", i < 0 ? html + boot : html.slice(0, i) + boot + html.slice(i));
      }
      if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });
      // A refusal can come before the body is read; the connection then
      // closes, so a keep-alive client cannot send its next request into it.
      res.setHeader("Connection", "close");
      if (!p.startsWith("/review/")) return reply(res, 404, { error: "no such path" });
      // The guards, in crew's order: Origin, JSON, length, size, token.
      const origin = req.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        log(`DENY POST ${p} from origin ${origin === undefined ? "None" : `'${origin}'`}`);
        return reply(res, 403, { error: "cross-origin request refused" });
      }
      const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (ctype !== "application/json") return reply(res, 415, { error: "JSON only" });
      const len = req.headers["content-length"] === undefined ? -1 : Number(String(req.headers["content-length"]).trim());
      if (!Number.isInteger(len) || len < 0) return reply(res, 411, { error: "length required" });
      if (len > MAX_BODY) return reply(res, 413, { error: "too large" });
      let raw;
      try { raw = await readBody(req, MAX_BODY); } catch { return reply(res, 413, { error: "too large" }); }
      let body;
      try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { return reply(res, 400, { error: "not JSON" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(res, 400, { error: "not a JSON object" });
      if (!ctEq(typeof body.t === "string" ? body.t : "", token)) {
        log(`DENY bad token on POST ${p} from 127.0.0.1`);
        return reply(res, 403, { error: "bad token" });
      }
      const id = p.slice("/review/".length);
      if (!reviewPath(id, ".json")) return reply(res, 404, { error: "no such review" });
      const [code, out] = apply(id, body, sync ? { sync } : {});
      log(`${code === 200 ? "OK  " : "FAIL"} review ${id} ${body.op ?? "None"} ${out.error || out.item || ""}`);
      return reply(res, code, out);
    } catch (e) {
      log(`FAIL ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) reply(res, 500, { error: e.message });
    }
  });
  server.on("listening", () => { port = server.address().port; });
  return server;
}

export function serveForeground({ version, root }) {
  const token = crypto.randomBytes(24).toString("hex");
  let last = Date.now(), started = false, missing = 0;
  const server = makeServer({ version, root, token, onRequest: () => { last = Date.now(); } });
  const tidy = () => { const cur = readJson(SERVE_FILE); if (cur && cur.pid === process.pid) fs.rmSync(SERVE_FILE, { force: true }); };
  server.listen(0, "127.0.0.1", () => {
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

function health(port) {
  const js = `fetch("http://127.0.0.1:${port}/health",{signal:AbortSignal.timeout(2000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))`;
  const r = spawnSync(process.execPath, ["-e", js], { encoding: "utf8", timeout: 4000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// A server from another copy of lookout is used as it is, not replaced: its
// open pages keep their port and token.
export function liveServer(root) {
  const rec = readJson(SERVE_FILE);
  if (!rec || !rec.port || !rec.token || !alive(rec.pid)) return null;
  const h = health(rec.port);
  if (!h || h.server !== "lookout" || h.pid !== rec.pid) return null;
  return root && h.root !== root ? { ...rec, foreign: true } : rec;
}

export function ensureServer({ cli, root }) {
  let rec = liveServer(root);
  if (rec) return rec;
  fs.mkdirSync(path.dirname(SERVE_FILE), { recursive: true });
  const fd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [cli, "serve", "--foreground"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
  // Two starters can race; whichever server's record lands, both use it.
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
  // Signal only a pid that answers /health as this server.
  const rec = liveServer();
  if (!rec) { fs.rmSync(SERVE_FILE, { force: true }); return false; }
  try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 20 && alive(rec.pid); i++) sleep(100);
  return true;
}

export const urlFor = (rec, rel) => `http://127.0.0.1:${rec.port}${rel.startsWith("/") ? rel : "/" + rel}`;
