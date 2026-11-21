#!/usr/bin/env node
// mock_probe — the demo mock keeps up with the app.
//
//   node docs/demo/app/mock_probe.mjs
//
// Every command app/ui invokes has a handler in mock.js (the demo-mock recipe
// in .seamux/verify.json runs this on any change to app/ui or docs/demo/app).
// Two halves:
//
//   static  each invoke("name") in app/ui/*.ts against the keys of
//           window.__seamuxDemo.handlers, read from a loaded page
//   tour    each view, on cmux and on ?backend=tmux, waiting until it shows
//           what it is for; fails on a page error, a console error, or a
//           "[demo] no mock for" warning (which also catches a command named
//           through a variable, which the static half cannot see)
//
// KNOWN lists what is still broken. It may only shrink: anything broken and
// not listed fails, and so does a listed entry that is fine now.
//
// Needs app/node_modules and docs/demo/reel/node_modules (the recipe installs
// them); installs chromium-headless-shell for playwright-core when missing.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, launch } from "./shoot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const UI = join(REPO, "app", "ui");

/** What is still broken on the mock. Delete an entry in the change that fixes it. */
export const KNOWN = {
  /** Commands app/ui invokes that mock.js has no handler for. */
  commands: [
    "bg_shells", "bg_stop", "clip_read", "held_act", "link_file", "notify_looking", "notify_take_link",
    "pane_held", "pane_stop", "pane_stop_cancel", "pty_shell_run", "resume_set", "session_last_exchange", "wake_prs",
  ],
  /** Views that do not yet show what they are for. */
  views: [],
  /** Page and console errors a listed command still causes, as a piece of
   *  their text. Each may show or not (some race), and is stale once its
   *  command leaves KNOWN.commands. */
  errors: [],
};

/** Commands invoked through a template literal, spelled out. A template not
 *  listed here fails: add it, with the names it can take. */
export const TEMPLATES = {
  // doctor.ts: the All workspaces rows' verbs (doctor_model.ts ACTIONS).
  "doctor_${verb}": ["doctor_archive", "doctor_restore", "doctor_forget", "doctor_resume"],
};

/** Every invoke("name") in app/ui's own sources (not the probes). */
export function invoked(dir = UI) {
  const names = new Set();
  let computed = 0;
  const templates = new Set();
  const call = /\binvoke\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*(["'`])([^"'`]*)\1/g;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith("_probe.ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(call)) {
      if (m[2].startsWith("plugin:")) continue;
      if (m[1] === "`" && m[2].includes("${")) {
        templates.add(m[2]);
        for (const n of TEMPLATES[m[2]] ?? []) names.add(n);
      } else names.add(m[2]);
    }
    computed += [...src.matchAll(/\binvoke\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\(\s*[^"'`\s)]/g)].length;
  }
  return { names, computed, templates };
}

const tab = (page, label) => page.locator("#strip .tab", { hasText: label }).first().click();
const menu = async (page, label) => {
  await page.locator("#strip .tab.more").click();
  await page.locator(".menu-item", { hasText: label }).click();
};
const emit = (page, event, payload) =>
  page.evaluate(([event, payload]) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload }), [event, payload]);

/** Each view: how to reach it from the Dock, and what it shows once it works. */
export const VIEWS = {
  dock: { go: (p) => tab(p, "Dock"), shows: ".dockview .sheet .native-term .xterm-rows" },
  wake: {
    go: async (p) => {
      await tab(p, "Dock");
      if (!(await p.locator(".dockview .sheet .sheet-wake .w-list li").first().isVisible().catch(() => false))) await emit(p, "sheet:key", "wake");
    },
    shows: ".dockview .sheet .sheet-wake .w-list li",
  },
  lookout: { go: (p) => tab(p, "Lookout"), shows: ".review .r-stage-chip, .r-side .r-stage-chip" },
  // A contact's row in the card: drawn only once a frame has workspaces in it.
  radar: { go: (p) => tab(p, "Radar"), shows: ".radar-card .radar-name" },
  doctor: { go: (p) => menu(p, "Doctor"), shows: ".doc-ws" },
  usage: { go: (p) => menu(p, "Usage"), shows: null },
  palette: {
    go: async (p) => {
      await tab(p, "Dock");
      await p.keyboard.press("Meta+k");
    },
    shows: ".palette-row",
    after: (p) => p.keyboard.press("Escape"),
  },
};

/** How long a view has to show what it is for, and to settle once it has. */
const WAIT = Number(process.env.MOCK_PROBE_WAIT_MS || 8000);
const SETTLE = 700;

async function browser() {
  try {
    return await launch();
  } catch (e) {
    if (!/Executable doesn't exist|playwright-core install/i.test(String(e?.message))) throw e;
    console.log("installing chromium-headless-shell for playwright-core…");
    execFileSync("npx", ["playwright-core", "install", "chromium-headless-shell"], { cwd: join(REPO, "docs", "demo", "reel"), stdio: "inherit" });
    return await launch();
  }
}

/** Load the app on one backend and visit every view. */
async function tour(url, query, seen) {
  const { browser: b, page } = await browser();
  const got = { handlers: [], views: {} };
  const note = (kind, text) => seen.push({ kind, text, backend: query || "cmux" });
  page.on("pageerror", (e) => note("error", `pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    const miss = /^\[demo\] no mock for ([\w:-]+)/.exec(t);
    if (miss) note("unmocked", miss[1]);
    else if (m.type() === "error") note("error", `console: ${t}`);
  });
  try {
    await page.goto(url + query);
    await page.locator("#conn.good").waitFor({ timeout: 20000 });
    got.handlers = await page.evaluate(() => Object.keys(window.__seamuxDemo?.handlers ?? {}));
    for (const [name, v] of Object.entries(VIEWS)) {
      let ok = true;
      try {
        await v.go(page);
        if (v.shows) await page.locator(v.shows).first().waitFor({ state: "visible", timeout: WAIT });
      } catch {
        ok = false;
      }
      // What the view asked for on arrival has answered (or not) by now: the
      // mock answers at once, and the pages poll, so the network never idles.
      await page.waitForTimeout(SETTLE);
      if (v.after) await v.after(page).catch(() => {});
      got.views[name] = ok;
    }
  } finally {
    await b.close();
  }
  return got;
}

async function main() {
  const fail = [];
  const { names, computed, templates } = invoked();
  const srv = await startServer();
  const seen = [];
  let runs;
  try {
    runs = [await tour(srv.url, "", seen), await tour(srv.url, "?backend=tmux", seen)];
  } finally {
    await srv.close();
  }
  const handlers = new Set(runs[0].handlers);
  if (!handlers.size) fail.push("the page exposed no handlers (window.__seamuxDemo.handlers): did mock.js load?");

  // static
  for (const t of templates) if (!TEMPLATES[t]) fail.push(`app/ui invokes the template \`${t}\`: list the commands it can name in TEMPLATES in mock_probe.mjs`);
  for (const t of Object.keys(TEMPLATES)) if (!templates.has(t)) fail.push(`TEMPLATES names \`${t}\`, which app/ui no longer invokes: delete it`);
  const known = new Set(KNOWN.commands);
  const unmocked = [...names].filter((n) => !handlers.has(n)).sort();
  for (const n of unmocked) if (!known.has(n)) fail.push(`app/ui invokes ${n}, and docs/demo/app/mock.js has no handler for it`);
  for (const n of KNOWN.commands) {
    if (handlers.has(n)) fail.push(`${n} has a mock handler now: delete it from KNOWN.commands in mock_probe.mjs`);
    else if (!names.has(n)) fail.push(`${n} is no longer invoked by app/ui: delete it from KNOWN.commands in mock_probe.mjs`);
  }

  // tour
  const asked = new Set(seen.filter((s) => s.kind === "unmocked").map((s) => s.text));
  for (const n of [...asked].sort()) if (!known.has(n)) fail.push(`the tour hit ${n}, which docs/demo/app/mock.js has no handler for`);
  const knownViews = new Set(KNOWN.views);
  for (const run of runs) {
    for (const [name, ok] of Object.entries(run.views)) {
      const backend = run === runs[0] ? "cmux" : "tmux";
      if (!ok && !knownViews.has(name)) fail.push(`${name} (${backend}) never showed ${VIEWS[name].shows}`);
    }
  }
  for (const name of KNOWN.views) {
    if (!VIEWS[name]) fail.push(`KNOWN.views names ${name}, which is not a view`);
    else if (runs.every((r) => r.views[name])) fail.push(`${name} shows what it is for now: delete it from KNOWN.views in mock_probe.mjs`);
  }
  const errors = seen.filter((s) => s.kind === "error");
  const firstLine = (t) => t.split("\n")[0];
  for (const t of new Set(errors.filter((e) => !KNOWN.errors.some((k) => e.text.includes(k.text))).map((e) => `${e.backend}: ${firstLine(e.text)}`))) fail.push(`unexpected error on ${t}`);
  for (const k of KNOWN.errors) if (!known.has(k.while)) fail.push(`KNOWN.errors' ${k.text} waits on ${k.while}, which is not in KNOWN.commands now: delete it`);

  const views = Object.keys(VIEWS);
  console.log(`static: ${names.size} commands invoked in app/ui, ${handlers.size} mock handlers, ${unmocked.length} unanswered (${KNOWN.commands.length} known)` +
    (computed ? `; ${computed} invoke call(s) with a computed name, covered by the tour only` : ""));
  for (const [i, run] of runs.entries()) {
    console.log(`tour ${i ? "tmux" : "cmux"}: ${views.map((v) => `${v} ${run.views[v] ? "ok" : knownViews.has(v) ? "known" : "FAIL"}`).join(", ")}`);
  }
  console.log(`errors: ${errors.length} (${KNOWN.errors.length} known kinds); unmocked on the tour: ${asked.size}`);
  if (fail.length) {
    console.log(`\nFAIL (${fail.length}):`);
    for (const f of fail) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else console.log("\nok: the mock answers everything app/ui asks, apart from what KNOWN lists");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
