// The TypeSafe client, reached the way every seamux plugin reaches it: by
// running crew's one client (`seamux typesafe`, or crew/hooks/typesafe.py
// until the crew Python is deleted) with JSON on stdin. A
// plugin cannot import another's libs (ADR 0004), so the two small rules
// below are restated here rather than shared: where the client is
// (deep-plan/lib/evidence.mjs, clientCmd) and when file content may leave the
// machine (restack/lib/judge.mjs, contentAllowed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The client as a command: `seamux typesafe` at $SEAMUX_BIN or
// ~/.local/bin/seamux, else crew's typesafe.py from the installed tree or this
// checkout. The env override is authoritative, not a first preference: the
// probe points it at a mock (or at nothing), and falling through to the
// machine's real client from under a test would put a probe on the network.
export function clientCmd() {
  const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  if ("LOOKOUT_TYPESAFE_CLIENT" in process.env) {
    const c = process.env.LOOKOUT_TYPESAFE_CLIENT;
    return c && exists(c) ? ["python3", c] : null;
  }
  // Only a seamux that lists the tool: an older build without it would read
  // as "TypeSafe not configured" and never reach the fallback below.
  const lists = (s) => {
    const r = spawnSync(s, ["--tools"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 && (r.stdout || "").split("\n").includes("typesafe");
  };
  for (const s of [process.env.SEAMUX_BIN, path.join(os.homedir(), ".local", "bin", "seamux")]) {
    if (s && exists(s) && lists(s)) return [s, "typesafe"];
  }
  const py = [
    path.join(os.homedir(), ".config", "cmux", "crew", "hooks", "typesafe.py"),
    path.join(HERE, "..", "..", "crew", "hooks", "typesafe.py"),
  ].find(exists);
  return py ? ["python3", py] : null;
}

// Loopback keeps content on this machine; anything else is off-machine.
export function loopback() {
  const url = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").trim();
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0:0:0:0:0:0:0:1)(:\d+)?(\/|$)/i.test(url);
}

// May hunk text go to the scorer? Only to a loopback endpoint, or when the
// repository opted in with .seamux/lookout.json { "sendContent": true }.
export function contentAllowed(cfg) {
  return loopback() || (cfg && cfg.sendContent === true);
}

// .seamux/lookout.json at the review source's repo root, or {}.
export function repoConfig(root) {
  if (!root) return {};
  try { return JSON.parse(fs.readFileSync(path.join(root, ".seamux", "lookout.json"), "utf8")) || {}; }
  catch { return {}; }
}

// One request. { ok: true, answers } or { ok: false, why } — never throws, and
// a failure is a reason to fall back, not a guess.
export function ask(state, questions, { timeout = 60000 } = {}) {
  const client = clientCmd();
  if (!client) return { ok: false, why: "no TypeSafe client found (seamux typesafe, or crew's hooks/typesafe.py)" };
  const [cmd, ...pre] = client;
  const a = spawnSync(cmd, [...pre, "available"], { timeout: 5000 });
  if (a.status !== 0) return { ok: false, why: "TypeSafe is not configured (no API key)" };
  const r = spawnSync(cmd, [...pre, "ask"],
    { input: JSON.stringify({ state, questions }), encoding: "utf8", timeout });
  if (r.error) return { ok: false, why: "TypeSafe did not answer in time" };
  if (r.status !== 0 || !r.stdout) {
    const why = (r.stderr || "").trim().split("\n").pop();
    return { ok: false, why: "TypeSafe request failed" + (why ? ": " + why.replace(/^typesafe:\s*/, "") : "") };
  }
  try { return { ok: true, answers: JSON.parse(r.stdout) }; }
  catch { return { ok: false, why: "TypeSafe returned something that is not JSON" }; }
}

// A score answer as a number in [0,1], read from its distribution: the
// expected criterion index over the last index. `confidence` is a margin
// between the top two options, not a probability (deep-plan/lib/evidence.mjs
// explains the measurement), so it is never read. Null when there is no
// usable distribution.
export function expected(answer) {
  const p = answer && answer.probabilities;
  if (!p || typeof p !== "object") return null;
  const keys = Object.keys(p).map(Number).filter(Number.isFinite);
  if (!keys.length) return null;
  const top = Math.max(...keys);
  let mass = 0, sum = 0;
  for (const k of keys) { const v = Number(p[k]) || 0; mass += v; sum += k * v; }
  if (!(mass > 0) || top === 0) return null;
  return Math.min(1, Math.max(0, sum / mass / top));
}
