// crew_impl.mjs — the node twin of crew_impl.py, for board_probe.mjs and any
// other node probe. Same modes, same lookup, same answers; see crew_impl.py
// for the why.
//
//   import { argv, env } from "../tools/crew_impl.mjs";
//   const [cmd, ...rest] = argv("costs", COSTS_PY, "python3");
//   execFileSync(cmd, rest, { env: env(process.env) });
//
//   CREW_IMPL unset        the Python
//   CREW_IMPL=rust         `seamux <tool>` when seamux registers it, else the Python
//   CREW_IMPL=rust-strict  as rust, but an unregistered tool throws NotPorted

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const CREW = path.join(REPO, "crew");
const MODES = ["", "rust", "rust-strict"];

export class NotPorted extends Error {}

export function mode() {
  const m = process.env.CREW_IMPL || "";
  if (!MODES.includes(m)) throw new Error(`CREW_IMPL must be unset, rust or rust-strict, not ${JSON.stringify(m)}`);
  return m;
}

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

export function seamuxBin() {
  if (process.env.SEAMUX_BIN) return process.env.SEAMUX_BIN;
  const built = path.join(REPO, "app", "target", "debug", "seamux");
  if (executable(built)) return built;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && executable(path.join(dir, "seamux"))) return path.join(dir, "seamux");
  }
  return null;
}

const cache = new Map();

/** The tool names `seamux --tools` lists; empty when there is no seamux. */
export function registered() {
  const b = seamuxBin();
  if (!b) return new Set();
  if (!cache.has(b)) {
    let out = "";
    try { out = execFileSync(b, ["--tools"], { encoding: "utf8", timeout: 10000 }); } catch { out = ""; }
    cache.set(b, new Set(out.split("\n").map((l) => l.trim()).filter(Boolean)));
  }
  return cache.get(b);
}

/** The argv that runs `tool`: [seamux, tool] or the Python's own argv. */
export function argv(tool, file, interp = null) {
  const m = mode();
  const python = interp ? [interp, file] : [file];
  if (!m) return python;
  if (registered().has(tool)) return [seamuxBin(), tool];
  if (m === "rust-strict") {
    throw new NotPorted(`CREW_IMPL=rust-strict: seamux does not register ${JSON.stringify(tool)} (seamux: ${seamuxBin() || "not found"})`);
  }
  return python;
}

export function isRust(tool) {
  return Boolean(mode()) && registered().has(tool);
}

/** A copy of base with what the Rust needs under CREW_IMPL. */
export function env(base = process.env) {
  const e = { ...base };
  if (mode()) {
    e.CREW_CMUX_TRANSPORT = "cli";
    if (!e.CREW_HOME) e.CREW_HOME = CREW;
  }
  return e;
}
