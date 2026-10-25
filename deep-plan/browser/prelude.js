// deep-plan's browser prelude. lib/browser.mjs fills the two markers and hands
// the result to `cmux browser repl --eval -`, so this file is not a module: it
// runs inside the repl, where `page`, `session`, `fs` and `sleep` are globals.
//
// What a browser script can rely on (the contract, ADR "browser checks run a
// repo script through cmux browser repl"):
//   env              the recipe's earlier exports and DEEP_PLAN_*, frozen. The
//                    repl has no process.env, so this is the only way in.
//   step(label, fn)  labels the frames recorded while fn runs; the Dock shows
//                    the label, and a failure names the step it happened in.
//   expect(target)   a small Playwright-style expect for locators and the page,
//                    polling up to 5s: toBeVisible, toBeHidden, toHaveText,
//                    toContainText, toHaveCount, toHaveValue, toHaveURL,
//                    toHaveTitle, each with .not.
//   STORAGE_STATE    when an earlier step exported one (a Playwright seed),
//                    it is loaded before the script starts.
// The verdict is the exit code: a script passes by finishing and fails by
// throwing. Everything the page did is recorded (frames, trace, run.png).
await (async () => {
  const env = Object.freeze(/*__DP_ENV__*/);
  const __dpDir = env.DEEP_PLAN_EVIDENCE;
  const __dpLog = o => {
    try { fs.appendFileSync(__dpDir + "/progress.jsonl", JSON.stringify({ t: Date.now(), ...o }) + "\n"); }
    catch { /* progress is for the Dock; the run does not depend on it */ }
  };
  let __rec = null;
  const __frames = () => {
    try { return __rec ? fs.readdirSync(__rec.dir).filter(f => /^frame-\d+\.png$/.test(f)).length : 0; }
    catch { return 0; }
  };
  let __label = "", __failedIn = "";
  const step = async (label, fn) => {
    const outer = __label;
    __label = String(label);
    __dpLog({ event: "step", label: __label, frame: __frames() });
    try {
      const v = await fn();
      __dpLog({ event: "done", label: __label, frame: __frames() });
      return v;
    } catch (e) {
      if (!__failedIn) __failedIn = __label;
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
    // Inside the try, so a bad storage state or a recorder that will not
    // start fails the run with a fail event like any other error.
    __label = "setup";
    if (env.STORAGE_STATE) await session.setStorageState(env.STORAGE_STATE);
    __rec = session.record();
    __dpLog({ event: "start", record: __rec.dir });
    __label = "";
    /*__DP_SCRIPT__*/
  } catch (e) { __err = e; }
  let __out = null;
  try { if (__rec) __out = await __rec.stop(); } catch { /* a run that crashed its tab may have nothing to stop */ }
  __dpLog(__err
    ? { event: "fail", label: __failedIn || __label, error: String((__err && __err.message) || __err).slice(0, 2000), frame: __frames() }
    : { event: "pass", frame: __frames() });
  __dpLog({ event: "stop", ...(__out || {}) });
  if (__err) {
    // Kept so the Dock's `open tab` can show the page as it failed.
    try { page.keep(); } catch { /* no tab was opened */ }
    throw __err;
  }
})();
