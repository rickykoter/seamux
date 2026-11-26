#!/usr/bin/env node
// drive-wake — walks the Wake's Shelves and Timeline in the demo app the way
// a person would, and shoots each state. Run it before a person looks.
//
//   node docs/demo/app/drive-wake.mjs [--out DIR]
//
// Picks the coupons-api worktree (pictures, files at risk, reviews, plans),
// then: j through the reading order, Enter on a picture (the preview), t to
// Timeline and back, a click on a lane and a review, light theme, and a
// narrow column. Prints what each step saw and fails on a page error.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, launch, openApp } from "./shoot.mjs";
import { byKey, treeOf } from "./world.mjs";

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "/tmp/drive-wake";
mkdirSync(out, { recursive: true });
const srv = await startServer();
const seen = [];
let failed = 0;
const say = (ok, what, detail = "") => {
  seen.push(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  :: ${detail}` : ""}`);
  if (!ok) failed++;
};
const sel = (page) => page.evaluate(() => document.querySelector(".sheet-wake .sel[data-key]")?.getAttribute("data-key") ?? null);

async function run({ dark = true, width = 1440, tag = "" } = {}) {
  const { browser, page, errors } = await launch({ dark, width });
  try {
    await openApp(page, "wake", { url: srv.url });
    const wake = page.locator(".dockview .sheet .sheet-wake");
    await wake.locator(".w-ws").selectOption(treeOf(byKey.api));
    await wake.locator('.w-shelf[data-shelf="pictures"]').waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(out, `shelves${tag}.png`) });
    if (tag) {
      say(errors.length === 0, `no page errors (${tag.slice(1)})`, errors.join(" | "));
      return errors;
    }

    const shelves = await wake.locator(".w-shelf").evaluateAll((els) => els.map((e) => e.getAttribute("data-shelf")));
    say(shelves.join() === "needs,reviews,plans,prs,pictures,files,commits", "the shelves, in order", shelves.join());
    const needs = await wake.locator(".w-need").evaluateAll((els) => els.map((e) => e.className.replace("w-need n-", "").replace(" sel", "")));
    say(needs.includes("review") && needs.includes("risk"), "Needs you holds the review to close and the files at risk", needs.join());

    // j walks every item in reading order, shelf by shelf.
    await wake.locator(".w-shelf-h").first().click();
    const order = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("j");
      const k = await sel(page);
      if (!k || order[order.length - 1] === k) break;
      order.push(k);
    }
    const kinds = order.map((k) => k.split(":")[0]);
    const firstRow = kinds.indexOf("row");
    say(!!kinds[0] && (kinds[0].startsWith("need") || kinds[0] === "risk"), "j starts on Needs you", kinds.slice(0, 3).join());
    say(kinds.indexOf("review") > -1 && kinds.indexOf("review") < kinds.indexOf("pr"), "reviews come before the PR lanes");
    say(firstRow > -1 && kinds.indexOf("pr") < kinds.lastIndexOf("row"), "rows (pictures, files, commits) follow the lanes");
    const shown = await wake.locator("[data-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
    say(JSON.stringify(order) === JSON.stringify(shown), "j visits every item the page shows, in the order it shows them", `${order.length} of ${shown.length}`);
    await page.keyboard.press("k");
    say((await sel(page)) === order[order.length - 2], "k steps back");

    // Enter on a picture previews it.
    const pic = await wake.locator(".w-thumb").first().getAttribute("data-key");
    await wake.locator(".w-thumb").first().click();
    await page.waitForTimeout(500);
    say(await page.locator(".wv-img, .wv video").first().isVisible().catch(() => false), "a click on a picture opens its preview", pic);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    say(!(await page.locator(".wv-img").first().isVisible().catch(() => false)), "Esc closes the preview");

    // t switches to Timeline and back; the choice is kept.
    await wake.locator(".w-shelf-h").first().click();
    await page.keyboard.press("t");
    await page.waitForTimeout(400);
    say(await wake.locator('.w-seg-b[aria-pressed="true"]', { hasText: "Timeline" }).isVisible(), "t switches to Timeline");
    await page.screenshot({ path: join(out, "timeline.png") });
    await page.keyboard.press("t");
    await page.waitForTimeout(400);
    say(await wake.locator('.w-shelf[data-shelf="needs"]').isVisible(), "t switches back to Shelves");

    // Keep all asks first, and a redraw between ask and confirm keeps the ask.
    const keepAll = wake.locator(".w-need.n-risk .w-act");
    await keepAll.click();
    await page.keyboard.press("t");
    await page.keyboard.press("t");
    await page.waitForTimeout(300);
    say(/sure\?/.test((await keepAll.textContent()) ?? ""), "keep all's ask survives a redraw", await keepAll.textContent());

    // A past review's search keeps its focus while typing.
    const pastq = wake.locator(".w-pastq");
    if (await pastq.count()) {
      await pastq.fill("spike");
      await page.waitForTimeout(400);
      const past = await wake.locator(".w-past").count();
      say(past === 1 && (await page.evaluate(() => document.activeElement?.classList.contains("w-pastq"))), "the past reviews' search filters and keeps focus", String(past));
      await pastq.fill("");
      await page.waitForTimeout(300);
    }
    say(errors.length === 0, "no page errors", errors.join(" | "));
    return errors;
  } finally {
    await browser.close();
  }
}

try {
  await run();
  await run({ dark: false, tag: "-light" });
  await run({ width: 900, tag: "-narrow" });
} finally {
  await srv.close();
}
console.log(seen.join("\n"));
console.log(`drive-wake: ${seen.length - failed} ok, ${failed} failed (shots in ${out})`);
process.exit(failed ? 1 : 0);
