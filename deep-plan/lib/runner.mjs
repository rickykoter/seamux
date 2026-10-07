// Running a recipe-backed check: the steps render resolved and stored in
// state, executed in order, with the verdict taken from exit codes.
//
//   acquire   a person runs it. The engine never does — it acts outside this
//             machine (a push, a preview channel, a remote run). Reaching one
//             stops the run at "needs-variant" and hands the command back;
//             `check run --from wait` resumes once the variant exists.
//   wait      polled until it exits 0 (and, when it exports, prints a value),
//             every `interval` seconds, up to its `timeout`. Reads remote
//             state; changes nothing.
//   run       one shell command; non-zero, or past the timeout, is a fail.
//
// A step's `export` puts the last line it printed into the environment of
// every step after it — how a preview URL reaches the e2e run.
//
// EVERYTHING IS SUMMARISED BEFORE IT IS RETURNED, as in restack's runner this
// is copied from (restack/lib/run.mjs; copied, not imported, because each
// plugin installs from its own source directory): the exit code, the
// duration and the last twenty lines. The full output goes to the log file.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TAIL_LINES = 20;

export function tail(s, n = TAIL_LINES) {
  const lines = String(s || "").replace(/\s+$/, "").split("\n");
  return lines.length <= n ? lines.join("\n")
    : `… ${lines.length - n} earlier lines\n` + lines.slice(-n).join("\n");
}

// A synchronous pause for the wait loop. The runner is a process of its own
// (or a foreground command), so blocking it is the point.
export function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

const append = (log, s) => { if (log) try { fs.appendFileSync(log, s); } catch { /* a log we cannot write is not a failure */ } };

// One shell command, with a timeout that is a refusal rather than a hang.
// `sh -c` on purpose: recipes are written as shell (pipes, env, npx). See the
// trust note in verify.mjs.
export function sh(cwd, command, opts = {}) {
  const started = Date.now();
  const secs = opts.timeout || 900;
  append(opts.log, `\n$ ${command}\n`);
  const r = spawnSync("sh", ["-c", command], {
    cwd, encoding: "utf8", timeout: secs * 1000, killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...(opts.env || {}) },
  });
  const stdout = r.stdout || "", full = stdout + (r.stderr || "");
  append(opts.log, full);
  const timedOut = !!(r.error && r.error.code === "ETIMEDOUT");
  const code = r.status === null ? -1 : r.status;
  append(opts.log, timedOut ? `\n[timed out after ${secs}s]\n` : `\n[exit ${code}]\n`);
  return {
    command, ok: !timedOut && r.status === 0, code, timedOut,
    ms: Date.now() - started,
    // The value a step hands on: its last non-empty line of stdout.
    value: stdout.split("\n").map(l => l.trim()).filter(Boolean).pop() || "",
    out: timedOut ? `timed out after ${secs}s\n` + tail(full) : tail(full),
  };
}

// The acquire steps a run would stop at: all of them come first (verify.mjs
// refuses any other order), so a run that does not resume past them stops
// before anything executes.
export function acquireSteps(exec) {
  return ((exec && exec.steps) || []).filter(s => s.kind === "acquire");
}

// Run `exec` (a check's stored recipe: steps, cwd, timeout) under `root`.
// Returns { status: pass|fail|needs-variant, note, ran } — what the caller
// records as the verdict.
export function runExec(exec, { root, from = "", log = "", env = {} } = {}) {
  const started = Date.now();
  const cwd = path.resolve(root, exec.cwd || ".");
  const steps = exec.steps || [];
  const acquire = acquireSteps(exec);
  if (acquire.length && from !== "wait")
    return { status: "needs-variant", acquire: acquire.map(s => ({ command: s.command, note: s.note || "" })),
      note: `a person runs: ${acquire.map(s => s.command).join(" && ")}` };
  const vars = { ...env };
  const done = (status, note, extra = {}) =>
    ({ status, note, ran: { ms: Date.now() - started, log, ...extra } });
  if (!fs.existsSync(cwd)) return done("fail", `the recipe's cwd ${exec.cwd} does not exist`, { code: -1 });
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (s.kind === "acquire") continue;
    const at = { step: k + 1, kind: s.kind, command: s.command };
    if (s.kind === "wait") {
      const limit = (s.timeout || 1200) * 1000, every = (s.interval || 15) * 1000;
      const until = Date.now() + limit;
      let last = null, polls = 0;
      for (;;) {
        polls++;
        const left = Math.max(1, Math.ceil((until - Date.now()) / 1000));
        last = sh(cwd, s.command, { timeout: left, log, env: vars });
        if (last.ok && (!s.export || last.value)) break;
        if (Date.now() + every >= until)
          return done("fail", `wait gave up after ${s.timeout || 1200}s (${polls} polls): ${s.command}`,
            { ...at, code: last.code, timedOut: true, tail: last.out });
        sleep(every);
      }
      if (s.export) vars[s.export] = last.value;
      append(log, s.export ? `[${s.export}=${last.value}]\n` : "");
      continue;
    }
    const r = sh(cwd, s.command, { timeout: s.timeout || exec.timeout || 900, log, env: vars });
    if (!r.ok)
      return done("fail", r.timedOut
        ? `timed out after ${s.timeout || exec.timeout || 900}s at step ${k + 1}: ${s.command}`
        : `exit ${r.code} at step ${k + 1}: ${s.command}`,
      { ...at, code: r.code, timedOut: r.timedOut, tail: r.out });
    if (s.export) { vars[s.export] = r.value; append(log, `[${s.export}=${r.value}]\n`); }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  return done("pass", `exit 0 in ${secs}s`, { code: 0 });
}

// Is this process alive? Signal 0 checks without sending anything. EPERM means
// it exists but is not ours — alive, for this purpose.
export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}
