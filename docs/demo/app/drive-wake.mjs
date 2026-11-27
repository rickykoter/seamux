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

    // A video: a muted frame for its poster and its length, once in view.
    const vid = wake.locator(".w-thumb", { hasText: "checkout-walkthrough.webm" });
    say((await vid.count()) === 1, "the webm is on Pictures and recordings, as a video");
    await vid.scrollIntoViewIfNeeded();
    await vid.locator("video").waitFor({ timeout: 8000 }).catch(() => {});
    say(await vid.locator("video").isVisible().catch(() => false), "a video shows a frame of itself as its poster");
    // The demo's clip is a canvas recording, which does not state its length:
    // it shows its frame and no length, rather than reading the whole file.
    const durShown = await vid.locator(".w-dur").isVisible();
    const durText = durShown ? await vid.locator(".w-dur").textContent() : "";
    say(!durShown || /^\d+:\d\d$/.test(durText ?? ""), "a length shows only when the file states it", durShown ? durText : "not stated: none shown");
    say((await vid.locator(".w-thumb-play").count()) === 1, "one play mark on the poster");
    say(await vid.evaluate((e) => e.classList.contains("risk")), "a video at risk says so");
    await vid.click();
    await page.waitForTimeout(500);
    say(await page.locator(".sheet-wake .wv video").first().isVisible().catch(() => false), "a click on a video opens it in the preview");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // t switches to Timeline and back; the choice is kept.
    await wake.locator(".w-shelf-h").first().click();
    await page.keyboard.press("t");
    await page.waitForTimeout(400);
    say(await wake.locator('.w-seg-b[aria-pressed="true"]', { hasText: "Timeline" }).isVisible(), "t switches to Timeline");
    await page.screenshot({ path: join(out, "timeline.png") });

    // Timeline: Needs you on top, then one card per turn, split into sections.
    const cards = wake.locator(".w-card");
    say((await cards.count()) >= 3, "Timeline draws a card per turn", String(await cards.count()));
    say(await wake.locator(".w-need").first().isVisible(), "Needs you stays on top in Timeline");
    const names = await wake.locator(".w-card-n").allTextContents();
    say(names.some((n) => /^Increment 2 of Take coupon codes at checkout$/.test(n)), "a go 2 card is named after its increment", names.join(" | "));
    const sects = await cards.first().locator(".w-sect").evaluateAll((els) => els.map((e) => e.className.replace("w-sect ", "")));
    const order7 = ["reviews", "plans", "prs", "pictures", "files", "commits"];
    say(sects.length > 0 && sects.every((x, i) => i === 0 || order7.indexOf(x) > order7.indexOf(sects[i - 1])), "a card's sections follow the shelves' order", sects.join());
    // j walks the cards in the order they show, every key once.
    await wake.locator(".w-card-hd").first().click({ position: { x: 4, y: 4 } });
    const tl = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("j");
      const k = await sel(page);
      if (!k || tl[tl.length - 1] === k) break;
      tl.push(k);
    }
    const raw = await wake.locator("[data-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
    const tlShown = [...new Set(raw)];
    say(raw.length === tlShown.length, "every item in Timeline has a key of its own", `${raw.length} drawn, ${tlShown.length} keys`);
    // From wherever the pick was (Shelves' pick carries over), to the end.
    const from = tlShown.indexOf(tl[0]);
    say(tl.length > 0 && JSON.stringify(tl) === JSON.stringify(tlShown.slice(from)), "j walks Timeline in the order it shows", `${tl.length} from ${from} of ${tlShown.length}`);
    // Space opens the picked row's card prompt whole.
    const rowInCard = wake.locator(".w-card .w-row").first();
    const rk = await rowInCard.getAttribute("data-key");
    await page.evaluate((k) => document.querySelector(`.sheet-wake [data-key="${k}"]`)?.scrollIntoView(), rk);
    // k from the top lets the pick go; then j down to the row.
    for (let i = 0; i < 60 && (await sel(page)) !== null; i++) await page.keyboard.press("k");
    for (let i = 0; i < 60 && (await sel(page)) !== rk; i++) await page.keyboard.press("j");
    await page.keyboard.press(" ");
    await page.waitForTimeout(200);
    const openWhole = (k) => page.evaluate((k) => {
      const c = document.querySelector(`.sheet-wake [data-key="${k}"]`)?.closest(".w-card");
      const w = c?.querySelector(".w-card-p");
      return !!c && c.classList.contains("open") && !!w && !w.hidden && w.getBoundingClientRect().height > 0 ? w.textContent : "";
    }, k);
    const shownWhole = await openWhole(rk);
    say(!!shownWhole, "Space opens the card's whole prompt, shown under its heading", shownWhole.slice(0, 40));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    say(!(await openWhole(rk)) && (await wake.isVisible()), "Esc closes the card's prompt, and the Wake stays");
    // Two cards opened: Esc closes the latest first, then the other, then nothing is left open.
    const cardKeys = await wake.locator(".w-card").evaluateAll((els) => els.slice(0, 2).map((c) => c.getAttribute("data-turn")));
    for (const k of cardKeys) await wake.locator(`.w-card[data-turn="${k}"] .w-card-hd .w-prompt`).click();
    const openNow = () => wake.locator(".w-card.open").evaluateAll((els) => els.map((c) => c.getAttribute("data-turn")));
    const both = await openNow();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const one = await openNow();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const none = await openNow();
    say(both.length === 2 && one.length === 1 && one[0] === cardKeys[0] && none.length === 0 && (await wake.isVisible()),
      "Esc closes opened cards latest first, one at a time", JSON.stringify({ both, one, none }));
    // Space on a pick outside any card (a Needs you tile) opens the card of the turn it came from.
    const needKey = await wake.locator(".w-need").first().getAttribute("data-key");
    for (let i = 0; i < 60 && (await sel(page)) !== null; i++) await page.keyboard.press("k");
    for (let i = 0; i < 60 && (await sel(page)) !== needKey; i++) await page.keyboard.press("j");
    await page.keyboard.press(" ");
    await page.waitForTimeout(200);
    const fromNeed = await wake.locator(".w-card.open .w-card-p").count();
    say((await sel(page)) === needKey && fromNeed === 1, "Space on a Needs you tile opens its turn's card", `${needKey} → ${fromNeed} open`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    for (let i = 0; i < 60 && (await sel(page)) !== null; i++) await page.keyboard.press("k");
    for (let i = 0; i < 60 && (await sel(page)) !== rk; i++) await page.keyboard.press("j");

    await page.keyboard.press("t");
    await page.waitForTimeout(400);
    say(await wake.locator('.w-shelf[data-shelf="needs"]').isVisible(), "t switches back to Shelves");
    say((await sel(page)) === rk, "the pick stays across the switch when both show it", String(await sel(page)));

    // Space on a Shelves row shows its turn's whole prompt under the list;
    // Enter's preview opens over it, and Esc closes the preview, then the prompt.
    await page.keyboard.press(" ");
    await page.waitForTimeout(200);
    const turnp = wake.locator(".w-turnp");
    const ptext = (await turnp.isVisible()) ? await turnp.locator(".w-turnp-b").textContent() : "";
    say(!!ptext && ptext.length > 0, "Space on a Shelves row shows its turn's prompt", ptext?.slice(0, 40));
    await page.keyboard.press("j");
    await page.waitForTimeout(150);
    say(await turnp.isVisible(), "the prompt follows the pick");
    const pickedPic = await wake.locator(".w-thumb").first().getAttribute("data-key");
    await page.evaluate((k) => document.querySelector(`.sheet-wake [data-key="${k}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true })), pickedPic);
    await page.waitForTimeout(400);
    const viewerUp = await page.locator(".sheet-wake .wv").first().isVisible().catch(() => false);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const afterOne = { viewer: await page.locator(".sheet-wake .wv-img, .sheet-wake .wv video").first().isVisible().catch(() => false), prompt: await turnp.isVisible() };
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    say(viewerUp && !afterOne.viewer && afterOne.prompt && !(await turnp.isVisible()) && (await wake.isVisible()),
      "Esc closes the preview first, then the prompt, and the Wake stays", JSON.stringify({ viewerUp, ...afterOne }));
    // Space on a pull request's lane shows the prompt of the turn that opened it.
    const laneKey = await wake.locator(".w-shelf.prs .w-lane").first().getAttribute("data-key");
    for (let i = 0; i < 60 && (await sel(page)) !== null; i++) await page.keyboard.press("k");
    for (let i = 0; i < 60 && (await sel(page)) !== laneKey; i++) await page.keyboard.press("j");
    await page.keyboard.press(" ");
    await page.waitForTimeout(200);
    const laneP = (await turnp.isVisible()) ? await turnp.locator(".w-turnp-b").textContent() : "";
    // coupons-api's #44 came from crew-sync's list, not a turn: the panel says so.
    say((await sel(page)) === laneKey && /no turn in this Wake made it/.test(laneP ?? ""), "Space on a PR lane no turn made says there is no prompt", `${laneKey}: ${laneP}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    say(!(await turnp.isVisible()) && (await wake.isVisible()), "Esc closes it, and the Wake stays");
    // Space with nothing picked picks the first item and shows its prompt, whatever was on before.
    for (const before of ["on", "off"]) {
      if (before === "on") {
        await page.keyboard.press("j");
        await page.keyboard.press(" ");
      }
      for (let i = 0; i < 60 && (await sel(page)) !== null; i++) await page.keyboard.press("k");
      await page.keyboard.press(" ");
      await page.waitForTimeout(150);
      say((await sel(page)) !== null && (await turnp.isVisible()), `Space with nothing picked shows the first item's prompt (panel ${before} before)`, String(await sel(page)));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
    }

    // A redraw (a search, then clearing it) keeps each thumbnail: the same element, not fetched again.
    const tk = await wake.locator(".w-thumb").first().getAttribute("data-key");
    await page.evaluate((k) => (document.querySelector(`.sheet-wake [data-key="${k}"]`).__kept = 1), tk);
    await wake.locator(".w-q, input[type=search]").first().fill("zz-no-such-thing");
    await page.waitForTimeout(700);
    await wake.locator(".w-q, input[type=search]").first().fill("");
    await page.waitForTimeout(900);
    say(await page.evaluate((k) => document.querySelector(`.sheet-wake [data-key="${k}"]`)?.__kept === 1, tk), "a thumbnail survives a search and its clearing", tk);
    // Out of the search box (Esc there clears it and lets go), so t is a key again.
    await page.keyboard.press("Escape");
    await wake.locator(".w-shelf-h").first().click();
    await page.keyboard.press("t");
    await page.keyboard.press("t");
    await page.waitForTimeout(500);
    say(await page.evaluate((k) => document.querySelector(`.sheet-wake [data-key="${k}"]`)?.__kept === 1, tk), "a thumbnail survives Timeline and back", tk);

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
    // A recording saved in the worktree is marked "repo" (checkout-flow's mp4).
    await wake.locator(".w-ws").selectOption(treeOf(byKey.checkout));
    const mp4 = wake.locator(".w-thumb", { hasText: "coupon-error-flow.mp4" });
    await mp4.waitFor({ timeout: 8000 }).catch(() => {});
    say(await mp4.locator(".w-repo").isVisible().catch(() => false), "a recording saved in the worktree is marked repo");
    say(!(await wake.locator(".w-thumb", { hasText: "checkout-walkthrough.webm" }).count()), "another worktree's videos are not shown");
    await page.screenshot({ path: join(out, "videos-repo.png") });

    // search-index's #41 was opened in a turn ("merge it"): Space on its lane shows that prompt.
    await wake.locator(".w-ws").selectOption(treeOf(byKey.search));
    await wake.locator('.w-shelf.prs .w-lane[data-key="pr:41"]').waitFor({ timeout: 8000 }).catch(() => {});
    await wake.locator(".w-shelf-h").first().click();
    for (let i = 0; i < 60 && (await sel(page)) !== "pr:41"; i++) await page.keyboard.press("j");
    await page.keyboard.press(" ");
    await page.waitForTimeout(200);
    const p41 = (await wake.locator(".w-turnp").isVisible()) ? await wake.locator(".w-turnp .w-turnp-b").textContent() : "";
    say(p41 === "merge it", "Space on a PR lane shows the prompt of the turn that opened it", `pr:41: ${p41}`);
    await page.keyboard.press("Escape");

    // A video that will not load keeps its play tile (the webm, row 20, made
    // to point nowhere; coming back to coupons-api draws its poster afresh).
    // Only the load failure that causes may follow in the errors.
    const beforeBreak = errors.length;
    await page.evaluate(() => {
      const T = window.__TAURI_INTERNALS__;
      const was = T.convertFileSrc;
      T.convertFileSrc = (id, p) => (p === "wakefile" && String(id) === "20" ? "wakefile://localhost/no-such-video" : was(id, p));
    });
    await wake.locator(".w-ws").selectOption(treeOf(byKey.api));
    const broken = wake.locator(".w-thumb", { hasText: "checkout-walkthrough.webm" });
    await broken.waitFor();
    await broken.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    say((await broken.locator(".w-thumb-tile").isVisible()) && !(await broken.locator("video").isVisible().catch(() => false)),
      "a video that will not load keeps its play tile");

    const real = errors.filter((e, i) => i < beforeBreak || !/Failed to load resource|no-such-video/.test(e));
    say(real.length === 0, "no page errors", real.join(" | "));
    return errors;
  } finally {
    await browser.close();
  }
}

// The Dock's PR pill (crew/board/intent.js sends it from the board frame): the
// Wake opens beside the terminal, even with its column folded, on the lane of
// the group asked for, picked and in view. The demo's worktrees have one PR
// each, so the board draws no pill: the frame sends its message itself.
async function runPill() {
  const { browser, page, errors } = await launch({ dark: true, width: 1440 });
  try {
    await openApp(page, "dock", { url: srv.url });
    await page.frameLocator(".dock-board iframe").locator("#rows .row").first().waitFor();
    const frame = page.frames().find((f) => f.url().includes("/board"));
    for (const [k, group, want] of [["checkout", "open", "pr:43"], ["search", "done", "pr:41"]]) {
      await frame.evaluate(([ws, g]) => window.parent.postMessage({ crew: "prs", ws, group: g }, "*"), [byKey[k].id, group]);
      await page.waitForTimeout(1500);
      const st = await page.evaluate(() => {
        const w = document.querySelector(".dockview .sheet .sheet-wake");
        const s = w?.querySelector(".sel[data-key]");
        const L = w?.querySelector(".w-list")?.getBoundingClientRect();
        const r = s?.getBoundingClientRect();
        return { shown: !!w && w.offsetParent !== null, sel: s?.getAttribute("data-key") ?? null, inView: !!(r && L && r.top >= L.top - 1 && r.bottom <= L.bottom + 1) };
      });
      say(st.shown && st.sel === want && st.inView, `the PR pill (${group}) shows the Wake on that lane, picked and in view`, JSON.stringify(st));
    }
    await page.screenshot({ path: join(out, "pill.png") });
    say(errors.length === 0, "no page errors (pill)", errors.join(" | "));
  } finally {
    await browser.close();
  }
}

try {
  await run();
  await run({ dark: false, tag: "-light" });
  await run({ width: 900, tag: "-narrow" });
  await runPill();
} finally {
  await srv.close();
  console.log(seen.join("\n"));
}
console.log(`drive-wake: ${seen.length - failed} ok, ${failed} failed (shots in ${out})`);
process.exit(failed ? 1 : 0);
