// A browser step: a repo script run through `cmux browser repl`, whose API is
// Playwright's over the cmux workspace's own browser panes. cmux's browser is
// WebKit with no CDP port, so Playwright itself cannot attach to it; the repl
// is the way in (see the ADR on browser checks).
//
// The run, as runner.mjs calls it:
//   1. the script is read from the repo and wrapped in browser/prelude.js,
//      which supplies `env`, `step`, `expect`, loads STORAGE_STATE and starts
//      session.record();
//   2. the repl runs with its cwd set to the check's evidence directory under
//      <slug>.runs/: the repl writes files only under its cwd and its own temp
//      dir, so this is where the prelude can leave progress.jsonl;
//   3. record() writes frames and trace.jsonl into its temp dir while the run
//      goes on; syncEvidence copies them into the evidence directory, during
//      the run (whoever reads the evidence calls it) and once at the end.
// The verdict is the repl's exit code, as for a run step.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRELUDE = path.join(HERE, "..", "browser", "prelude.js");
export const KEEP_RUNS = 3;

// The cmux CLI, in crew's order (app/crates/cmux/src/cli_seam.rs): CREW_CMUX,
// CMUX_CLAUDE_HOOK_CMUX_BIN, CMUX_BIN, PATH, then the newest app bundle.
export function cmuxBin(env = process.env) {
  for (const k of ["CREW_CMUX", "CMUX_CLAUDE_HOOK_CMUX_BIN", "CMUX_BIN"])
    if (env[k] && fs.existsSync(env[k])) return env[k];
  for (const d of String(env.PATH || "").split(path.delimiter)) {
    const p = d && path.join(d, "cmux");
    if (p && fs.existsSync(p)) return p;
  }
  try {
    const apps = fs.readdirSync("/Applications").filter(a => /^cmux.*\.app$/.test(a))
      .map(a => path.join("/Applications", a, "Contents/Resources/bin/cmux"))
      .filter(p => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (apps.length) return apps[0];
  } catch { /* no /Applications to look in */ }
  return "";
}

const canon = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The cmux workspace a plan root lives in, from crew's board targets (its id,
// which outlives a short ref). A detached runner has no workspace of its own,
// and a repl session otherwise binds to whichever one is focused.
export function workspaceFor(root, env = process.env) {
  const file = env.DEEP_PLAN_BOARD_TARGETS || path.join(os.homedir(), ".cache", "cmux-crew", "board-targets.json");
  let targets;
  try { targets = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return ""; }
  const want = canon(root);
  let best = "", bestLen = -1;
  for (const [id, t] of Object.entries(targets || {})) {
    if (!t || !t.cwd) continue;
    const cwd = canon(t.cwd);
    // The workspace whose cwd is the root, else the deepest one holding it.
    if (cwd === want) return t.id || id;
    if (want.startsWith(cwd + path.sep) && cwd.length > bestLen) { best = t.id || id; bestLen = cwd.length; }
  }
  return best;
}

// The program the repl runs: the prelude with the env and the script in it.
export function program(script, env) {
  const tmpl = fs.readFileSync(PRELUDE, "utf8");
  return tmpl.replace("/*__DP_ENV__*/", () => JSON.stringify(env))
    .replace("/*__DP_SCRIPT__*/", () => script);
}

const readJsonl = f => {
  try {
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

// Copy what record() has written so far into the evidence directory. Frames
// are written once and never change, so a copy that exists is skipped.
export function syncEvidence(dir) {
  const start = readJsonl(path.join(dir, "progress.jsonl")).find(e => e.event === "start");
  const rec = start && start.record;
  if (!rec) return 0;
  let n = 0;
  let files;
  try { files = fs.readdirSync(rec); } catch { return 0; }
  for (const f of files) {
    if (!/^(frame-\d+\.png|trace\.jsonl|run\.png)$/.test(f)) continue;
    const to = path.join(dir, f);
    // A frame or the replay may have been copied while still being written,
    // and the trace grows while the run goes on: a size that differs is re-copied.
    try { if (fs.statSync(to).size === fs.statSync(path.join(rec, f)).size) continue; } catch { /* not copied yet */ }
    try { fs.copyFileSync(path.join(rec, f), to); n++; } catch { /* still being written */ }
  }
  return n;
}

// What a run left, as the surfaces read it. `dir` is relative to the runs
// directory; every file named is inside it.
export function readEvidence(runsDir, rel, { live = false } = {}) {
  const dir = path.join(runsDir, rel);
  if (!rel || !fs.existsSync(dir)) return null;
  if (live) syncEvidence(dir);
  const events = readJsonl(path.join(dir, "progress.jsonl"));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* gone */ }
  const frames = names.filter(f => /^frame-\d+\.png$/.test(f)).sort();
  const steps = [];
  for (const e of events) {
    if (e.event === "step") steps.push({ label: e.label, from: e.frame, to: null, status: "running" });
    if (e.event === "done" || e.event === "fail") {
      const s = [...steps].reverse().find(x => x.label === e.label && x.to === null);
      if (s) { s.to = e.frame; s.status = e.event === "done" ? "pass" : "fail"; if (e.key) s.key = e.key; }
    }
    // The failing step's key frame is logged before its fail event.
    if (e.event === "key" && e.key) {
      const s = [...steps].reverse().find(x => x.label === e.label && !x.key);
      if (s) s.key = e.key;
    }
  }
  const end = events.find(e => e.event === "pass" || e.event === "fail");
  const start = events.find(e => e.event === "start");
  const open = [...steps].reverse().find(s => s.status === "running");
  return {
    // Live only for the run in flight: a finished run that never reached its
    // browser step has no pass or fail event either.
    dir: rel, live: !!live && !end,
    frames: frames.length, framesList: frames,
    latest: frames[frames.length - 1] || "",
    label: end && end.event === "fail" ? (end.label || "") : (open ? open.label : (steps.length ? steps[steps.length - 1].label : "")),
    steps,
    result: end ? end.event : "",
    error: end && end.event === "fail" ? end.error || "" : "",
    tab: (end && end.tab) || (start && start.tab) || "",
    animation: names.includes("run.png") ? "run.png" : "",
    trace: names.includes("trace.jsonl") ? "trace.jsonl" : "",
  };
}

// The few fields status --json and the board carry; the frame list stays in
// `check evidence --json`.
export function evidenceSummary(ev) {
  if (!ev) return null;
  const { framesList, steps, tab, ...rest } = ev;
  return { ...rest, steps: steps.length };
}

// A fresh evidence directory for one run of one check.
export function newEvidenceDir(runsDir, n, id) {
  const rel = `inc${n}-${String(id).replace(/[^a-z0-9._-]+/gi, "_")}-${Date.now()}`;
  fs.mkdirSync(path.join(runsDir, rel), { recursive: true });
  return rel;
}

// Keep the latest KEEP_RUNS evidence directories of one check.
export function pruneEvidence(runsDir, n, id, keep = KEEP_RUNS) {
  const pre = `inc${n}-${String(id).replace(/[^a-z0-9._-]+/gi, "_")}-`;
  let dirs;
  // Exactly <pre><digits>: a check whose id extends this one's (flow, flow-x)
  // shares the prefix, and its evidence is not this check's to prune.
  try { dirs = fs.readdirSync(runsDir).filter(d => d.startsWith(pre) && /^\d+$/.test(d.slice(pre.length))); } catch { return []; }
  const gone = dirs.sort((a, b) => Number(b.slice(b.lastIndexOf("-") + 1)) - Number(a.slice(a.lastIndexOf("-") + 1))).slice(keep);
  for (const d of gone) {
    const p = path.join(runsDir, d);
    try { if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ }
  }
  return gone;
}

// Bring a run's tab to the front of its workspace, in the check's own repl
// session (whose tabs outlive a run). Returns { ok, out }.
export function showTab(tab, { session, root } = {}) {
  const bin = cmuxBin(process.env);
  if (!bin) return { ok: false, out: "no cmux CLI found" };
  if (!tab) return { ok: false, out: "the run recorded no tab" };
  const ws = root ? workspaceFor(root) : "";
  const r = spawnSync(bin, ["browser", "repl", "--timeout", "20000", ...(session ? ["--session", session] : []),
    ...(ws ? ["--workspace", ws] : []),
    `const t = await tabs.get(${JSON.stringify(tab)}); if (!t) throw new Error("the run's tab is gone"); await t.bringToFront(); "shown"`],
  { encoding: "utf8", timeout: 30000 });
  return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

// Run one browser step. Returns the shape runner.mjs's sh() does (ok, code,
// timedOut, ms, out, value), plus `evidence`, the run's evidence directory.
export function runBrowser(step, { cwd, env = {}, log = "", timeout = 900, browser = {} } = {}) {
  const started = Date.now();
  const append = s => { if (log) try { fs.appendFileSync(log, s); } catch { /* best effort */ } };
  const fail = (out, code = -1) => {
    append(out + "\n");
    return { command: step.command, ok: false, code, timedOut: false, ms: Date.now() - started, out, value: "" };
  };
  const scriptPath = path.resolve(cwd, step.command);
  append(`\n$ browser ${step.command}\n`);
  if (!fs.existsSync(scriptPath)) return fail(`the browser script ${step.command} does not exist (in ${cwd})`);
  const bin = cmuxBin(process.env);
  if (!bin) return fail("no cmux CLI found (CREW_CMUX, CMUX_BIN, PATH, /Applications/cmux*.app) — browser checks run where cmux runs");
  const { runsDir, evidence, session, root } = browser;
  if (!runsDir || !evidence) return fail("the browser step was run without an evidence directory");
  const dir = path.join(runsDir, evidence);
  const vars = { ...env, DEEP_PLAN_EVIDENCE: dir };
  // The repl reads files only under its cwd, which is the evidence directory,
  // so a seed's storage state is copied in and the copy is what loads.
  if (vars.STORAGE_STATE) {
    const from = path.resolve(cwd, vars.STORAGE_STATE);
    if (!fs.existsSync(from)) return fail(`STORAGE_STATE ${vars.STORAGE_STATE} does not exist (in ${cwd})`);
    const to = path.join(dir, "storage-state.json");
    fs.copyFileSync(from, to);
    vars.STORAGE_STATE = to;
  }
  const ws = root ? workspaceFor(root) : "";
  if (!ws) append(`[no cmux workspace found for ${root || "this run"}; its tabs open in the focused workspace]\n`);
  const args = ["browser", "repl", "--timeout", String(timeout * 1000), "--max-output", "0",
    ...(session ? ["--session", session] : []), ...(ws ? ["--workspace", ws] : []), "--eval", "-"];
  append(`[cmux ${args.join(" ")}]\n`);
  const r = spawnSync(bin, args, {
    cwd: dir, input: program(fs.readFileSync(scriptPath, "utf8"), vars), encoding: "utf8",
    timeout: (timeout + 30) * 1000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, env: process.env,
  });
  const full = (r.stdout || "") + (r.stderr || "");
  append(full);
  syncEvidence(dir);
  const timedOut = !!(r.error && r.error.code === "ETIMEDOUT");
  const code = r.status === null ? -1 : r.status;
  append(timedOut ? `\n[timed out after ${timeout}s]\n` : `\n[exit ${code}]\n`);
  const ev = readEvidence(runsDir, evidence);
  const tailLines = full.replace(/\s+$/, "").split("\n").slice(-20).join("\n");
  const where = ev && ev.result === "fail"
    ? `step "${ev.label || "?"}": ${(ev.error || "").split("\n")[0]}` : "";
  return {
    command: step.command, ok: !timedOut && code === 0, code, timedOut, ms: Date.now() - started,
    out: (where ? where + "\n" : "") + tailLines, value: "", evidence, failedAt: where,
    workspace: ws,
  };
}
