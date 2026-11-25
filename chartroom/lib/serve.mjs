// chartroom serve: one loopback server per machine for every repo's studio.
//
// The guards are lookout's (lookout/lib/serve.mjs), copied rather than
// imported (ADR 0004): a request must name this server's own loopback Host;
// the studio's data routes need the token the page carries; a POST also needs
// this server's Origin, a JSON body and a size cap. The server records itself
// in serve.json at mode 0600 and exits after IDLE_MS without a visible page.
//
// A repo's chart dir is a "room", named by a hash of its path and listed in
// rooms.json by `chartroom open`. Routes:
//
//   GET  /health
//   GET  /static/<studio.css|studio.js>          the studio's own files
//   GET  /room/<room>/                           the studio, booted with the token
//   GET  /room/<room>/api/state?t=               every chart in the room
//   GET  /room/<room>/api/chart/<id>?t=          one chart and its threads
//   GET  /room/<room>/pane/<id>/<n>/<key>        one pane, sandboxed, no token
//   POST /room/<room>/api/op                     an op (lib/ops.mjs), token in the body
//
// A pane is the chart's own HTML, which Claude wrote and may have copied in
// from elsewhere. It is served with a CSP sandbox (scripts, no same-origin),
// no network but the CDNs a published Artifact allows, and page/anchor.js
// injected so the studio can place pins through postMessage. It never sees
// the token: the URL carries none and the sandbox gives it an opaque origin.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as S from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, "..", "page");
export const serveFile = () => path.join(S.homeDir(), "serve.json");
export const roomsFile = () => path.join(S.homeDir(), "rooms.json");
export const logFile = () => path.join(S.homeDir(), "serve.log");
export const portFile = () => path.join(S.homeDir(), "serve.port");
// Long, because a studio link waits in the terminal until someone clicks it,
// and an idle node process costs next to nothing.
export const IDLE_MS = Number(process.env.CHARTROOM_SERVE_IDLE_MS) || 8 * 60 * 60 * 1000;
export const SERVER_NAME = "chartroom-serve";
export const MAX_BODY = 64 * 1024;
export const ROOM_OK = /^[a-f0-9]{12}$/;

export const CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"];
export const PANE_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDNS.join(" ")}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src data: https://fonts.gstatic.com",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
export const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

function log(msg) {
  const p = n => String(n).padStart(2, "0"), d = new Date();
  try { fs.appendFileSync(logFile(), `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}\n`); }
  catch { /* a log we cannot write is not a failure */ }
}

export function ctEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------ rooms

export const roomId = dir => crypto.createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 12);

// Remember a chart dir as a room; returns its id. The file is small and
// rewritten whole, under the store's lock.
export function addRoom(loc) {
  const id = roomId(loc.dir);
  const file = roomsFile();
  S.withLock(file + ".lock", () => {
    const cur = readJson(file) || {};
    cur[id] = { dir: loc.dir, top: loc.top, mode: loc.mode, seen: new Date().toISOString() };
    S.writeAtomic(file, JSON.stringify(cur, null, 2) + "\n");
  });
  return id;
}

export function room(id) {
  if (!ROOM_OK.test(id)) return null;
  const r = (readJson(roomsFile()) || {})[id];
  if (!r || typeof r.dir !== "string" || roomId(r.dir) !== id) return null;
  return r;
}

// ------------------------------------------------------------ data

function threadsOf(dir, id) {
  const t = readJson(S.chartPaths(dir, id).threads);
  return t && Array.isArray(t.threads) ? t.threads : [];
}

// What the studio's poll compares: a change in any chart.json or
// threads.json changes it.
function signature(dir, charts) {
  const h = crypto.createHash("sha256");
  for (const c of charts) {
    const p = S.chartPaths(dir, c.id);
    for (const f of [p.json, p.threads]) {
      try { const st = fs.statSync(f); h.update(f + ":" + st.mtimeMs + ":" + st.size + ";"); } catch { h.update(f + ":-;"); }
    }
  }
  return h.digest("hex").slice(0, 16);
}

export function state(r) {
  const charts = S.list(r.dir).map(c => {
    const th = threadsOf(r.dir, c.id);
    return { ...c, threads: th.length, open: th.filter(t => !t.resolved).length };
  });
  return { dir: r.dir, top: r.top, repo: path.basename(r.top || r.dir), mode: r.mode, charts, sig: signature(r.dir, charts) };
}

export function chart(r, id) {
  if (!S.exists(r.dir, id)) return null;
  return { chart: S.read(r.dir, id), threads: threadsOf(r.dir, id) };
}

// A pane's file, or null: every part checked, and the real path inside the room.
export function panePath(r, id, n, key) {
  if (!S.ID_OK.test(id) || !/^[1-9][0-9]{0,5}$/.test(n) || !S.KEY_OK.test(key)) return null;
  const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
  const base = real(r.dir), f = real(path.join(r.dir, id, "v" + n, key + ".html"));
  if (!base || !f || !f.startsWith(base + path.sep)) return null;
  try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
}

// The pane's HTML with the anchor script in it, before </body> (or at the
// end when there is none). Exported for the published page, which inlines
// the same thing.
export function withAnchor(html, anchor = fs.readFileSync(path.join(PAGE, "anchor.js"), "utf8")) {
  const tag = `<script data-chartroom-anchor>\n${anchor}\n</script>\n`;
  // Found in the html itself: lowercasing can change a string's length (some
  // non-ASCII letters), so an index from a lowercased copy may not fit.
  let i = -1;
  for (const m of html.matchAll(/<\/body\s*>/gi)) i = m.index;
  return i < 0 ? html + tag : html.slice(0, i) + tag + html.slice(i);
}

export function studioHtml(roomIdValue, token) {
  const html = fs.readFileSync(path.join(PAGE, "studio.html"), "utf8");
  const boot = `<script>window.CHARTROOM_BOOT = ${JSON.stringify({ transport: "local", room: roomIdValue, token })};</script>`;
  return html.replace("<!-- chartroom:boot -->", boot)
    .replace("<!-- chartroom:css -->", '<link rel="stylesheet" href="/static/studio.css">')
    .replace("<!-- chartroom:js -->", '<script src="/static/studio.js"></script>');
}

// ------------------------------------------------------------ server

function send(res, code, ctype, body, extra = {}) {
  res.writeHead(code, { "Content-Type": ctype, "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body),
    "Server": SERVER_NAME, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...extra });
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

const STATIC = { "studio.css": "text/css; charset=utf-8", "studio.js": "text/javascript; charset=utf-8" };

// `apply(room, body)` runs an op and returns [code, reply]; lib/ops.mjs's.
export function makeServer({ version, root, token, onRequest = () => {}, apply = () => [400, { error: "unknown op" }] }) {
  let port = 0;
  const server = http.createServer(async (req, res) => {
    onRequest(req);
    try {
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        log(`DENY host ${host === undefined ? "None" : `'${host}'`}`);
        return reply(res, 403, { error: "unknown host" });
      }
      const u = new URL(req.url, "http://x"), p = u.pathname;
      if (req.method === "GET" || req.method === "HEAD") {
        if (p === "/health") return reply(res, 200, { ok: true, server: "chartroom", pid: process.pid, version, root });
        if (p.startsWith("/static/")) {
          const name = p.slice("/static/".length);
          if (!STATIC[name]) return reply(res, 404, { error: "no such file" });
          return send(res, 200, STATIC[name], fs.readFileSync(path.join(PAGE, name), "utf8"));
        }
        const m = /^\/room\/([a-f0-9]{12})(\/.*)?$/.exec(p);
        if (!m) return reply(res, 404, { error: "no such path" });
        const r = room(m[1]);
        if (!r) return reply(res, 404, { error: "no such room (run chartroom open in the repo)" });
        const rest = m[2] || "/";
        if (rest === "/") return send(res, 200, "text/html; charset=utf-8", studioHtml(m[1], token), { "Content-Security-Policy": STUDIO_CSP });
        const pane = /^\/pane\/([a-z0-9-]+)\/([0-9]+)\/([a-z0-9-]+)$/.exec(rest);
        if (pane) {
          const f = panePath(r, pane[1], pane[2], pane[3]);
          if (!f) return reply(res, 404, { error: "no such pane" });
          return send(res, 200, "text/html; charset=utf-8", withAnchor(fs.readFileSync(f, "utf8")), { "Content-Security-Policy": PANE_CSP });
        }
        if (rest.startsWith("/api/")) {
          if (!ctEq(u.searchParams.get("t") || "", token)) { log(`DENY bad token on ${p}`); return reply(res, 403, { error: "bad token" }); }
          if (rest === "/api/state") return reply(res, 200, state(r));
          const c = /^\/api\/chart\/([a-z0-9-]+)$/.exec(rest);
          if (c) { const out = chart(r, c[1]); return out ? reply(res, 200, out) : reply(res, 404, { error: "no such chart" }); }
        }
        return reply(res, 404, { error: "no such path" });
      }
      if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });
      res.setHeader("Connection", "close");
      const m = /^\/room\/([a-f0-9]{12})\/api\/op$/.exec(p);
      if (!m) return reply(res, 404, { error: "no such path" });
      // The guards, in lookout's order: Origin, JSON, length, size, token.
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
        log(`DENY bad token on POST ${p}`);
        return reply(res, 403, { error: "bad token" });
      }
      const r = room(m[1]);
      if (!r) return reply(res, 404, { error: "no such room" });
      const { t, ...op } = body;
      const [code, out] = apply(r, op);
      log(`${code === 200 ? "OK  " : "FAIL"} ${m[1]} ${op.op ?? "None"} ${op.chart ?? ""} ${out.error || out.item || ""}`);
      return reply(res, code, out);
    } catch (e) {
      log(`FAIL ${req.method} ${req.url}: ${e.message}`);
      if (!res.headersSent) reply(res, 500, { error: e.message });
    }
  });
  server.on("listening", () => { port = server.address().port; });
  return server;
}

export function serveForeground({ version, root, apply }) {
  const token = crypto.randomBytes(24).toString("hex");
  const SERVE_FILE = serveFile();
  let last = Date.now(), started = false, missing = 0;
  // A hidden tab's poll (bg=1) is not activity: a tab left open behind
  // others must not keep the server up forever.
  const server = makeServer({ version, root, token, apply, onRequest: req => {
    if (!/[?&]bg=1(&|$)/.test(req.url || "")) last = Date.now();
  } });
  const tidy = () => { const cur = readJson(SERVE_FILE); if (cur && cur.pid === process.pid) fs.rmSync(SERVE_FILE, { force: true }); };
  // The port this machine's server used last, so a link printed before a
  // restart works again once anything starts the server; any free port when
  // that one is taken.
  const want = Number(process.env.CHARTROOM_PORT) || Number((() => { try { return fs.readFileSync(portFile(), "utf8").trim(); } catch { return ""; } })()) || 0;
  let retried = false;
  server.on("error", e => {
    if (e.code === "EADDRINUSE" && want && !retried) { retried = true; log(`port ${want} is taken; using another`); server.listen(0, "127.0.0.1"); return; }
    log(`FAIL listen: ${e.message}`); process.exit(1);
  });
  server.listen(want > 0 && want < 65536 ? want : 0, "127.0.0.1");
  server.on("listening", () => {
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
    const release = () => { if (held) try { fs.rmdirSync(lock); } catch { /* gone */ } };
    const other = readJson(SERVE_FILE);
    if (other && other.pid !== process.pid && alive(other.pid) && (health(other.port) || {}).pid === other.pid) {
      release();
      log(`another server (pid ${other.pid}) is already recorded; exiting`);
      server.close(); process.exit(0);
    }
    const rec = { port: server.address().port, token, pid: process.pid, version, root, started: new Date().toISOString() };
    const tmp = SERVE_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, SERVE_FILE);
    try { S.writeAtomic(portFile(), String(rec.port) + "\n"); } catch { /* the next start picks any port */ }
    release();
    started = true;
    log(`listening on 127.0.0.1:${rec.port} (pid ${process.pid}, ${root})`);
  });
  const timer = setInterval(() => {
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

// ------------------------------------------------------------ client

function health(port) {
  const js = `fetch("http://127.0.0.1:${port}/health",{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.exit(e&&e.name==="TimeoutError"?3:1))`;
  const r = spawnSync(process.execPath, ["-e", js], { encoding: "utf8", timeout: 8000 });
  if (r.status === 3) return { busy: true };
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// The recorded server when it is alive and answers as chartroom, else null.
// A server from another copy of chartroom is used as it is: its open pages
// keep their port and token.
export function liveServer() {
  const rec = readJson(serveFile());
  if (!rec || !rec.port || !rec.token || !alive(rec.pid)) return null;
  const h = health(rec.port);
  if (h && h.busy) return rec;
  if (!h || h.server !== "chartroom" || h.pid !== rec.pid) return null;
  return rec;
}

export function ensureServer({ cli }) {
  let rec = liveServer();
  if (rec) return rec;
  fs.mkdirSync(S.homeDir(), { recursive: true });
  const fd = fs.openSync(logFile(), "a");
  const child = spawn(process.execPath, [cli, "serve", "--foreground"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
  child.unref();
  fs.closeSync(fd);
  for (let i = 0; i < 50; i++) {
    sleep(100);
    rec = readJson(serveFile());
    if (rec && rec.pid && alive(rec.pid) && (rec.pid === child.pid || liveServer())) {
      if (rec.pid !== child.pid) { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } }
      return rec;
    }
  }
  return null;
}

export function stopServer() {
  const rec = liveServer();
  if (!rec) { fs.rmSync(serveFile(), { force: true }); return false; }
  try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 20 && alive(rec.pid); i++) sleep(100);
  return true;
}

export const urlFor = (rec, rel) => `http://127.0.0.1:${rec.port}${rel.startsWith("/") ? rel : "/" + rel}`;
