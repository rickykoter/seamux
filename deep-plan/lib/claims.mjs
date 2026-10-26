// A claim step: acquisition the engine runs itself, because the developer
// wrote it into the recipe (see the ADR that supersedes 0009 in part).
// What a claim does is each repo's own config: poll a bot for a free QA
// environment and claim it, wait for another test to let go of port 5432,
// or ask a person which variant to use. The engine only polls, asks, locks
// and releases.
//
//   { "claim": "scripts/claim-qa.sh",      polled until it exits 0 printing a value
//     "export": "QA_ENV",                   the value's name for every later step
//     "ask": "Which QA env?",               also offered to a person on the Dock
//     "choices": "scripts/list-qa.sh",      one candidate per line, re-listed each poll
//     "lock": "port:5432",                  held machine-wide from claim to release
//     "release": "scripts/release-qa.sh",   run when the run ends, pass or fail
//     "interval": 15, "timeout": 1200 }
//
// With `ask` the polling goes on while a person may answer, and the first to
// land wins. A claim with `ask` and no command has nothing to poll: the check
// parks at needs-value until `check run … --from claim --set NAME=value`.
import fs from "node:fs";
import path from "node:path";
import { sh, sleep, alive } from "./runner.mjs";

const lockName = name => String(name).replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) + ".lock";
const readLock = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// Take a machine-wide lock, waiting while a live process holds it. A lock
// whose pid is dead is broken: a runner killed with SIGKILL never released it.
// Returns { ok, waited, holder } — holder is the last live one seen.
export function takeLock(dir, name, { owner, until, every, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, lockName(name));
  let waited = false, holder = null;
  for (;;) {
    try {
      const fd = fs.openSync(f, "wx");
      fs.writeSync(fd, JSON.stringify({ name, pid: process.pid, ...owner, at: Date.now() }) + "\n");
      fs.closeSync(fd);
      return { ok: true, waited, holder, file: f };
    } catch (e) {
      if (e.code !== "EEXIST") return { ok: false, waited, holder, error: e.message };
    }
    const h = readLock(f);
    if (!h || !alive(h.pid) || h.pid === process.pid) {
      // Broken under a mutex, and only if it is still the dead holder's: two
      // waiters breaking it at once must not remove the one the first just took.
      const m = f + ".break";
      try { fs.mkdirSync(m); }
      catch {
        try { if (Date.now() - fs.statSync(m).mtimeMs > 10000) fs.rmSync(m, { recursive: true, force: true }); } catch { /* gone */ }
        sleep(50); continue;
      }
      try {
        const again = readLock(f);
        if (JSON.stringify(again) === JSON.stringify(h)) {
          if (log) log(`[lock ${name}: ${h ? `pid ${h.pid} is gone` : "unreadable"}, breaking it]\n`);
          fs.rmSync(f, { force: true });
        }
      } finally { try { fs.rmdirSync(m); } catch { /* gone */ } }
      continue;
    }
    if (!waited || !holder || holder.pid !== h.pid)
      if (log) log(`[lock ${name}: waiting on pid ${h.pid}${h.slug ? ` (${h.slug} ${h.n} ${h.id})` : ""}]\n`);
    waited = true; holder = h;
    if (Date.now() + every >= until) return { ok: false, waited, holder };
    sleep(every);
  }
}

export function dropLock(dir, name, pid = process.pid) {
  const f = path.join(dir, lockName(name));
  const h = readLock(f);
  if (h && h.pid !== pid && alive(h.pid)) return false;
  try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
  return true;
}

// Run one claim step. `hooks` lets the caller keep the check's state in step
// with it: ask(question) records what a person is asked, answer() returns a
// value a person gave (or null), held(claim) records what will need
// releasing. Returns { ok, value, claim, note, needsValue, tail }.
export function runClaim(s, { cwd, vars, log, preset = {}, hooks = {}, locksDir, owner = {} }) {
  const append = t => { if (log) try { fs.appendFileSync(log, t); } catch { /* best effort */ } };
  const limit = (s.timeout || 1200) * 1000, every = (s.interval || 15) * 1000;
  const until = Date.now() + limit;
  const name = s.export || "";
  append(`\n$ claim ${s.command || "(asks a person)"}${s.ask ? `  — asks: ${s.ask}` : ""}${s.lock ? `  — lock ${s.lock}` : ""}\n`);
  // Registered for release only once something is claimed; until then, a
  // taken lock is all it holds (and its release is not run).
  const claim = { release: "", lock: s.lock || "", name, value: "", env: { ...vars } };
  if (s.lock) {
    const l = takeLock(locksDir, s.lock, { owner, until, every, log: append });
    if (!l.ok) return { ok: false, note: `claim gave up waiting on lock ${s.lock}` +
      (l.holder ? ` (held by pid ${l.holder.pid})` : l.error ? `: ${l.error}` : "") };
    append(`[lock ${s.lock} taken${l.waited ? " after waiting" : ""}]\n`);
    if (hooks.held) hooks.held(claim);
  }
  const got = value => {
    claim.value = value; claim.release = s.release || ""; claim.env = { ...vars, ...(name ? { [name]: value } : {}) };
    if (hooks.held) hooks.held(claim);
    // Answered, by the command or a person: the Dock stops offering a picker.
    if (s.ask && hooks.ask) hooks.ask(null);
    append(name ? `[${name}=${value}]\n` : "[claimed]\n");
    return { ok: true, value, claim };
  };
  if (name && preset[name] !== undefined) return got(preset[name]);
  let lastAsk = "";
  let polls = 0, last = null;
  for (;;) {
    polls++;
    if (s.ask) {
      let choices = [];
      if (s.choices) {
        const c = sh(cwd, s.choices, { timeout: 60, log, env: vars });
        choices = c.ok ? c.out.split("\n").map(x => x.trim()).filter(x => x && !x.startsWith("… ")) : [];
      }
      const ask = JSON.stringify({ question: s.ask, name, choices });
      if (ask !== lastAsk && hooks.ask) hooks.ask({ question: s.ask, name, choices });
      lastAsk = ask;
      const a = hooks.answer ? hooks.answer() : null;
      if (a !== null && a !== undefined && String(a) !== "") { append(`[a person answered ${name}=${a}]\n`); return got(String(a)); }
      if (!s.command) return { ok: false, needsValue: true, claim,
        note: `waiting for a person: ${s.ask}${choices.length ? ` (choices: ${choices.slice(0, 5).join(", ")})` : ""}` };
    }
    if (s.command) {
      const left = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      last = sh(cwd, s.command, { timeout: left, log, env: vars });
      if (last.signal) return { ok: false, claim, signal: last.signal, note: `terminated by ${last.signal} in the claim: ${s.command}` };
      if (last.ok && (!name || last.value)) return got(last.value);
    } else if (!s.ask) {
      // A lock-only claim: holding the lock is the claim.
      return got("");
    }
    if (Date.now() + every >= until)
      return { ok: false, claim, tail: last && last.out,
        note: `claim gave up after ${s.timeout || 1200}s (${polls} polls)${s.command ? `: ${s.command}` : ""}` };
    sleep(every);
  }
}

// Undo what a claim took, newest first: its release command with the env it
// claimed under, then its lock. Never throws. Returns what it did, and the
// claims whose release failed (kept, so `check release` can try them again;
// their lock is kept with them).
export function releaseClaims(claims, { cwd, log, locksDir, pid = process.pid }) {
  const said = [], failed = [];
  for (const c of [...claims].reverse()) {
    if (c.release) {
      const r = sh(cwd, c.release, { timeout: 300, log, env: c.env || {} });
      said.push(`${c.release} → ${r.ok ? "ok" : `exit ${r.code}`}`);
      if (!r.ok) { failed.push(c); continue; }
    }
    if (c.lock && locksDir) { dropLock(locksDir, c.lock, pid); said.push(`lock ${c.lock} released`); }
  }
  return { said, failed: failed.reverse() };
}
