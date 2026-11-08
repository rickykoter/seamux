// crew_impl.mjs — the node twin of crew_impl.py, for board_probe.mjs and any
// other node probe. Same lookup, same build, same answers; see crew_impl.py
// for the why.
//
//   import { argv, env } from "../tools/crew_impl.mjs";
//   const [cmd, ...rest] = argv("costs");   // [seamux, "costs"]
//   execFileSync(cmd, rest, { env: env(process.env) });

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));
const CREW = path.join(REPO, "crew");
const BUILD = "cargo build -q --manifest-path app/Cargo.toml -p seamux-cli";
// The env at import: a probe may swap in a throwaway HOME before it first asks
// for seamux, and cargo's rustup proxy would look for its toolchain there.
const BUILD_ENV = { ...process.env };

/** seamux is missing, or does not register the tool. */
export class NotPorted extends Error {}
/** cargo could not build this checkout's seamux. */
export class BuildFailed extends NotPorted {}

function executable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function buildEnv() {
  const e = { ...BUILD_ENV };
  let home = "";
  try { home = os.userInfo().homedir; } catch { home = e.HOME || ""; }
  if (home) {
    if (!e.CARGO_HOME) e.CARGO_HOME = path.join(home, ".cargo");
    if (!e.RUSTUP_HOME) e.RUSTUP_HOME = path.join(home, ".rustup");
  }
  return e;
}

let built = null;

/** Where cargo leaves seamux: CARGO_TARGET_DIR (from the repo root) or app/target. */
export function builtPath() {
  return path.resolve(REPO, BUILD_ENV.CARGO_TARGET_DIR || path.join("app", "target"), "debug", "seamux");
}

/** Build this checkout's seamux, once per process; BuildFailed if cargo cannot. */
export function build() {
  if (built) return built;
  const bin = builtPath();
  // A cold build, or one queued on cargo's lock behind a sibling probe, can
  // take a while; say so, since -q hides cargo's own progress.
  process.stderr.write(`crew_impl: ${BUILD}\n`);
  const [cmd, ...args] = BUILD.split(" ");
  const r = spawnSync(cmd, args, { cwd: REPO, env: buildEnv(), encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) throw new BuildFailed(`cannot build seamux: ${r.error.message} (${BUILD}); put cargo on PATH or set SEAMUX_BIN`);
  if (r.status !== 0) {
    const tail = ((r.stdout || "") + (r.stderr || "")).trim().split("\n").slice(-30).join("\n");
    throw new BuildFailed(`seamux did not build (${BUILD}, exit ${r.status}):\n${tail}`);
  }
  if (!executable(bin)) throw new BuildFailed(`${BUILD} exited 0 but left no ${bin}`);
  built = bin;
  return built;
}

/** SEAMUX_BIN, else this checkout's seamux, built first. Never `seamux` on PATH:
 * the installed app's build is not this branch's. */
export function seamuxBin() {
  if (process.env.SEAMUX_BIN) return process.env.SEAMUX_BIN;
  return build();
}

const cache = new Map();

/** The tool names `seamux --tools` lists; empty when that seamux is not there. */
export function registered() {
  const b = seamuxBin();
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
