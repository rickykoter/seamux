// deep-plan's browser prelude for the Playwright driver. lib/browser.mjs fills
// the markers, writes the result as run.mjs in the evidence directory and
// runs it with node, where cmux is not the host (ADR 0042). It keeps the
// contract browser/prelude.js gives a script under cmux's repl:
//   env              the recipe's earlier exports and DEEP_PLAN_*, frozen
//   step(label, fn)  labels the frames recorded while fn runs
//   expect(target)   the same small Playwright-style expect, polling up to 5s
//   STORAGE_STATE    loaded into the context before the script starts
//   page, sleep, fs  a fresh page, a pause, and node's fs
// and writes the same evidence: progress.jsonl, frame-NNNN.png, key-NN.png and
// trace.jsonl (console messages, page errors and navigations). There is no
// run.png and no tab to bring forward: the browser is headless and gone when
// the run ends. The verdict is the exit code, as under cmux.
import fs from "node:fs";
import { createRequire } from "node:module";

const env = Object.freeze(/*__DP_ENV__*/);
const __pwFrom = /*__DP_PLAYWRIGHT__*/;
const __dpDir = env.DEEP_PLAN_EVIDENCE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const __dpLog = o => {
  try { fs.appendFileSync(__dpDir + "/progress.jsonl", JSON.stringify({ t: Date.now(), ...o }) + "\n"); }
  catch { /* progress is for the plan page; the run does not depend on it */ }
};
const __trace = o => {
  try { fs.appendFileSync(__dpDir + "/trace.jsonl", JSON.stringify({ t: Date.now(), ...o }) + "\n"); } catch { /* best effort */ }
};

let __nFrames = 0, __keys = 0, __label = "", __failedIn = "";
let page = null, __browser = null, __timer = null, __shooting = false;
const __frames = () => __nFrames;
// One frame: the page as it is now. Never two at once, and never fatal.
const __shoot = async () => {
  if (!page || __shooting) return;
  __shooting = true;
  try {
    const buf = await Promise.race([page.screenshot(), sleep(5000).then(() => null)]);
    if (buf) fs.writeFileSync(__dpDir + "/frame-" + String(++__nFrames).padStart(4, "0") + ".png", buf);
  } catch { /* a page mid-navigation has nothing to show */ }
  finally { __shooting = false; }
};
const __key = async () => {
  try {
    const buf = page && await Promise.race([page.screenshot(), sleep(5000).then(() => null)]);
    if (!buf) return "";
    const name = "key-" + String(++__keys).padStart(2, "0") + ".png";
    fs.writeFileSync(__dpDir + "/" + name, buf);
    return name;
  } catch { return ""; }
};
const step = async (label, fn) => {
  const outer = __label;
  __label = String(label);
  await __shoot();
  __dpLog({ event: "step", label: __label, frame: __frames() });
  try {
    const v = await fn();
    await __shoot();
    __dpLog({ event: "done", label: __label, frame: __frames(), key: await __key() });
    return v;
  } catch (e) {
    if (!__failedIn) { __failedIn = __label; __dpLog({ event: "key", label: __label, key: await __key() }); }
    throw e;
  } finally { __label = outer; }
};
const __show = v => v instanceof RegExp ? String(v) : JSON.stringify(v);
const __match = (got, want, contains) => want instanceof RegExp ? want.test(String(got))
  : contains ? String(got).includes(String(want)) : String(got).trim() === String(want).trim();
const expect = (target, what) => {
  const isPage = target && typeof target.goto === "function";
  const name = what || (isPage ? "page" : "locator");
  const matchers = negate => {
    const check = (matcher, want, read, test, timeout = 5000) => (async () => {
      const until = Date.now() + timeout;
      let got;
      for (;;) {
        try { got = await read(); } catch (e) { got = "(" + (e && e.message || e) + ")"; }
        if (test(got) !== negate) return;
        if (Date.now() >= until) break;
        await sleep(100);
      }
      throw new Error(`expect(${name})${negate ? ".not" : ""}.${matcher}(${want === undefined ? "" : __show(want)}) ` +
        `failed after ${timeout}ms: got ${__show(got)}`);
    })();
    const opt = o => (o && o.timeout) || 5000;
    return {
      toBeVisible: o => check("toBeVisible", undefined, () => target.isVisible(), g => g === true, opt(o)),
      toBeHidden: o => check("toBeHidden", undefined, () => target.isVisible(), g => g === false, opt(o)),
      toHaveText: (w, o) => check("toHaveText", w, () => target.innerText(), g => __match(g, w, false), opt(o)),
      toContainText: (w, o) => check("toContainText", w, () => target.innerText(), g => __match(g, w, true), opt(o)),
      toHaveCount: (w, o) => check("toHaveCount", w, () => target.count(), g => g === w, opt(o)),
      toHaveValue: (w, o) => check("toHaveValue", w, () => target.inputValue(), g => __match(g, w, false), opt(o)),
      toHaveURL: (w, o) => check("toHaveURL", w, () => target.url(), g => __match(g, w, false), opt(o)),
      toHaveTitle: (w, o) => check("toHaveTitle", w, () => target.title(), g => __match(g, w, false), opt(o)),
    };
  };
  return Object.assign(matchers(false), { not: matchers(true) });
};

let __err = null;
try {
  __label = "setup";
  const { chromium } = createRequire(__pwFrom)("playwright");
  __browser = await chromium.launch({ headless: true });
  const context = await __browser.newContext(env.STORAGE_STATE ? { storageState: env.STORAGE_STATE } : {});
  page = await context.newPage();
  page.on("console", m => __trace({ type: "console", level: m.type(), text: m.text().slice(0, 2000) }));
  page.on("pageerror", e => __trace({ type: "pageerror", text: String(e && e.message || e).slice(0, 2000) }));
  page.on("framenavigated", f => { if (f === page.mainFrame()) __trace({ type: "navigate", url: f.url() }); });
  __dpLog({ event: "start", record: __dpDir, driver: "playwright" });
  // A frame a second while the script runs, as cmux's recorder gives.
  __timer = setInterval(() => { void __shoot(); }, 1000);
  __label = "";
  await (async () => {
    /*__DP_SCRIPT__*/
  })();
} catch (e) { __err = e; }
if (__timer) clearInterval(__timer);
await __shoot();
__dpLog(__err
  ? { event: "fail", label: __failedIn || __label, error: String((__err && __err.message) || __err).slice(0, 2000), frame: __frames(), tab: "" }
  : { event: "pass", frame: __frames(), tab: "" });
__dpLog({ event: "stop" });
try { if (__browser) await __browser.close(); } catch { /* already gone */ }
if (__err) { console.error("Error: " + ((__err && __err.stack) || __err)); process.exit(1); }
process.exit(0);
