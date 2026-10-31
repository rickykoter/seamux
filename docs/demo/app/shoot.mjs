#!/usr/bin/env node
// shoot — screenshots of the seamux app against the demo world (no Tauri, no cmux).
//
//   node docs/demo/app/shoot.mjs                      every view, to docs/demo/media
//   node docs/demo/app/shoot.mjs --out DIR            somewhere else
//   node docs/demo/app/shoot.mjs dock wake            just these
//   node docs/demo/app/shoot.mjs --intent http://127.0.0.1:PORT
//                         frame plans, reviews and asks from that intent server
//   node docs/demo/app/shoot.mjs --scale 2            2x pixels (2880x1800)
//   node docs/demo/app/shoot.mjs --serve              just run the server, print its URL
//
// Needs app/node_modules (cd app && npm ci) and docs/demo/reel/node_modules
// (playwright-core). A recorder reuses the same pieces:
//
//   import { startServer, launch, openApp, VIEWS } from "./shoot.mjs";
//   const srv = await startServer();
//   const { browser, page } = await launch({ url: srv.url });
//   await openApp(page, "dock", { url: srv.url });     // ...film it...
//   await browser.close(); await srv.close();
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { byKey } from "./world.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const require = createRequire(join(REPO, "docs", "demo", "reel", "package.json"));

/** Start Vite on app/ui with the demo mock. Resolves to { url, close }. */
export async function startServer({ port } = {}) {
  if (port) process.env.DEMO_PORT = String(port);
  const { createServer } = await import(pathToFileURL(join(REPO, "app", "node_modules", "vite", "dist", "node", "index.js")).href);
  const server = await createServer({ configFile: join(HERE, "vite.config.mjs") });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  return { url, server, close: () => server.close() };
}

/** Headless Chromium at 1440x900, dark. Resolves to { browser, context, page, errors }. */
export async function launch({ width = 1440, height = 900, scale = 1, dark = true } = {}) {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: dark ? "dark" : "light" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return { browser, context, page, errors };
}

const settle = (page, ms = 900) => page.waitForTimeout(ms);
const tab = (page, label) => page.locator("#strip .tab", { hasText: label }).first().click();

/** Load the app afresh (every view starts from the same world). */
async function load(page, url, query = "") {
  await page.goto(url + query);
  await page.locator("#conn.good").waitFor({ timeout: 15000 });
}

/** Each view: how to get there from a fresh load. */
export const VIEWS = {
  async dock(page) {
    await page.locator(".dockview .sheet .native-term .xterm-rows").first().waitFor();
    // The board frame, rendered.
    await page.frameLocator(".dock-board iframe").locator("#rows .row").first().waitFor();
    await settle(page, 1500);
  },
  async newws(page) {
    await VIEWS.dock(page);
    await page.locator(".dock-new").click();
    await page.locator(".newws-card select option").first().waitFor({ state: "attached" });
    await page.locator(".newws-prompt").fill("Show the coupon's discount on the receipt, under the total.");
    await page.locator(".newws-branch").focus();
    await settle(page, 500);
  },
  async reclaim(page) {
    await VIEWS.dock(page);
    // search-index merged: its card is folded; open it, then its reclaim chip.
    const row = page.frameLocator(".dock-board iframe").locator(`.row[data-id="${byKey.search.id}"]`);
    const chip = row.locator(".chip", { hasText: /^reclaim$/ }).first();
    if (!(await chip.isVisible())) await row.locator('.top[data-a="fold"]').first().click();
    await chip.click();
    await page.locator(".reclaim .rc-checks").waitFor();
    await settle(page, 600);
  },
  async wake(page) {
    await tab(page, "Wake");
    await page.locator("#wake .w-list li").first().waitFor();
    await settle(page);
  },
  async lookout(page) {
    await tab(page, "Lookout");
    await page.locator(".r-item", { hasText: "PR #41" }).click();
    await page.locator(".r-btn.pickbtn:not([disabled])").click();
    await page.locator(".r-findings li").first().waitFor();
    await settle(page);
  },
  async palette(page) {
    await VIEWS.dock(page);
    await page.keyboard.press("Meta+k");
    await page.locator(".palette-row").first().waitFor();
    await settle(page, 500);
  },
};

/** Show `view` (a VIEWS key) in `page`, freshly loaded from `url`. */
export async function openApp(page, view, { url, intent = "" } = {}) {
  const go = VIEWS[view];
  if (!go) throw new Error(`no view ${view}; one of ${Object.keys(VIEWS).join(", ")}`);
  await load(page, url, intent ? `?intent=${encodeURIComponent(intent)}` : "");
  await go(page);
}

async function main(argv) {
  const opt = (flag, d) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : d);
  const out = resolve(opt("--out", join(REPO, "docs", "demo", "media")));
  const intent = opt("--intent", "");
  const scale = Number(opt("--scale", 1));
  const valued = new Set(["--out", "--intent", "--scale"]);
  const wanted = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1]));
  const srv = await startServer();
  if (argv.includes("--serve")) {
    console.log(`demo app at ${srv.url}  (?intent=http://127.0.0.1:PORT to frame a real intent server)`);
    return;
  }
  mkdirSync(out, { recursive: true });
  const { browser, page, errors } = await launch({ scale });
  let bad = 0;
  try {
    for (const view of wanted.length ? wanted : Object.keys(VIEWS)) {
      errors.length = 0;
      const file = join(out, `app-${view}.png`);
      try {
        await openApp(page, view, { url: srv.url, intent });
        await page.screenshot({ path: file });
        console.log(`${view.padEnd(9)} ${file}`);
      } catch (e) {
        bad++;
        console.log(`${view.padEnd(9)} FAILED: ${e.message.split("\n")[0]}`);
        await page.screenshot({ path: file.replace(/\.png$/, ".failed.png") }).catch(() => {});
      }
      for (const e of errors) console.log(`          ${e}`);
    }
  } finally {
    await browser.close();
    await srv.close();
  }
  process.exitCode = bad ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
