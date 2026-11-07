// crew_impl.mjs — the node twin of crew_impl.py, for board_probe.mjs and any
// other node probe. Same lookup, same answers; see crew_impl.py for the why.
//
//   import { argv, env } from "../tools/crew_impl.mjs";
//   const [cmd, ...rest] = argv("costs");   // [seamux, "costs"]
//   execFileSync(cmd, rest, { env: env(process.env) });

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const CREW = path.join(REPO, "crew");
const BUILD = "cargo build --manifest-path app/Cargo.toml -p seamux-cli";

/** seamux is missing, or does not register the tool. */
export class NotPorted extends Error {}

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

export function seamuxBin() {
  if (process.env.SEAMUX_BIN) return process.env.SEAMUX_BIN;
  const built = path.join(REPO, "app", "target", "debug", "seamux");
  if (executable(built)) return built;
  // Never `seamux` on PATH: the installed app's build is not this branch's.
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
    cache.set(b, new Set(out.split("\n").map(s => s.trim()).filter(Boolean)));
  }
  return cache.get(b);
}

/** [seamux, tool], or NotPorted naming what is missing. */
export function argv(tool) {
  const b = seamuxBin();
  if (!b) throw new NotPorted(`no seamux: set SEAMUX_BIN or build app/target/debug/seamux (${BUILD})`);
  if (!registered().has(tool)) throw new NotPorted(`seamux (${b}) does not register ${JSON.stringify(tool)}`);
  return [b, tool];
}

export function has(tool) {
  return registered().has(tool);
}

/** A copy of base with what the tools need in a probe. */
export function env(base = process.env) {
  const e = { ...base };
  e.CREW_CMUX_TRANSPORT = "cli";
  if (!e.CREW_HOME) e.CREW_HOME = CREW;
  return e;
}
