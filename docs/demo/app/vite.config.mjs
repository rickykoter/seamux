// The seamux app's pages (app/ui) in a plain browser, against a fake cmux.
//
//   app/node_modules/.bin/vite --config docs/demo/app/vite.config.mjs
//   (or node docs/demo/app/shoot.mjs, which starts this itself)
//
// Nothing under app/ changes. This config serves app/ui as is and puts
// mock.js in front of main.ts: Tauri's mockIPC answers every invoke with the
// demo world (world.mjs), and its event mock carries the wall and views
// frames. It also runs a stand-in intent server on a second port, which
// serves the Dock's board (board.mjs) and, when the page is opened with
// ?intent=http://127.0.0.1:PORT, proxies every other page (plans, reviews,
// asks, usage) to that server.
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boardPage } from "./board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const APP = join(REPO, "app");

/** The stand-in intent server: its port, and where it proxies pages to. */
const intent = { port: 0, target: "" };

function placeholder(path) {
  return `<!doctype html><meta charset="utf-8"><title>demo</title>
<style>:root{color-scheme:dark light}body{margin:0;height:100vh;display:grid;place-items:center;background:#1c1c1e;color:#a1a1a6;font:13px/1.5 -apple-system,system-ui,sans-serif}
@media (prefers-color-scheme: light){body{background:#fbfbfd;color:#6e6e73}}p{max-width:420px;text-align:center}code{font:12px ui-monospace,Menlo,monospace}</style>
<p>${path.replace(/[<>&]/g, "")} comes from the intent server.<br>Open the demo with <code>?intent=http://127.0.0.1:PORT</code> to show it here.</p>`;
}

function startIntent() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/board" || url.pathname === "/board/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(boardPage());
      return;
    }
    if (intent.target) {
      const to = new URL(req.url ?? "/", intent.target);
      const up = http.request(to, { method: req.method, headers: { ...req.headers, host: to.host } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", (e) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`demo proxy: ${intent.target} did not answer (${e.message})`);
      });
      req.pipe(up);
      return;
    }
    // 200, so the frame loads quietly; intent_page asks status() for the truth.
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(placeholder(url.pathname));
  });
  srv.listen(Number(process.env.DEMO_INTENT_PORT || 0), "127.0.0.1", () => {
    intent.port = srv.address().port;
  });
  return srv;
}

/** What a page path answers on the stand-in (for intent_page). */
function status(path) {
  if (path === "/board") return Promise.resolve(200);
  if (!intent.target) return Promise.resolve(404);
  return new Promise((ok) => {
    const r = http.get(new URL(path, intent.target), (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    r.on("error", () => ok(0));
    r.setTimeout(3000, () => r.destroy());
  });
}

function demo() {
  let srv = null;
  return {
    name: "seamux-demo",
    configureServer(server) {
      srv = startIntent();
      server.httpServer?.on("close", () => srv?.close());
      server.middlewares.use("/__demo", (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const json = (v) => {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(v));
        };
        if (url.pathname === "/intent") {
          // The page says which real intent server to proxy pages to ("" for none).
          intent.target = url.searchParams.get("target") ?? "";
          return json({ port: intent.port, target: intent.target });
        }
        if (url.pathname === "/page") return void status(url.searchParams.get("path") ?? "/").then((code) => json({ code }));
        res.writeHead(404);
        res.end();
      });
    },
    transformIndexHtml() {
      return [
        { tag: "script", injectTo: "head-prepend", children: `window.__SEAMUX_DEMO__ = ${JSON.stringify({ intentPort: intent.port })};` },
        { tag: "script", injectTo: "head-prepend", attrs: { type: "module", src: `/@fs${join(HERE, "mock.js")}` } },
      ];
    },
  };
}

export default {
  root: join(APP, "ui"),
  clearScreen: false,
  logLevel: process.env.DEMO_VITE_LOG || "warn",
  resolve: {
    // mock.js lives outside app/: it gets the app's own copy of the Tauri API.
    alias: { "@tauri-apps/api": join(APP, "node_modules", "@tauri-apps", "api") },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.DEMO_PORT || 5199),
    strictPort: false,
    fs: { allow: [REPO] },
  },
  optimizeDeps: { include: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-web-links", "@xterm/addon-clipboard"] },
  plugins: [demo()],
};
