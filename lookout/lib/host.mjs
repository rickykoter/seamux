// Which host Claude is running in, so a verb knows where a page can go.
//
// The same rule lives in deep-plan/lib/host.mjs: ADR 0004 keeps the plugins from
// importing each other, so each carries a copy, and both probes check that
// the two copies agree. Change both together.
//
//   SEAMUX_HOST=cmux|desktop|terminal|remote  beats every signal below
//   CMUX_WORKSPACE_ID set                     cmux
//   CLAUDE_CODE_REMOTE=true                   remote (documented)
//   CLAUDE_CODE_ENTRYPOINT desktop values     desktop (undocumented; may move)
//   anything else                             terminal

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const HOSTS = ["cmux", "desktop", "terminal", "remote"];
export const DESKTOP_ENTRYPOINTS = ["claude-desktop", "claude-desktop-3p", "local-agent"];

// Returns { host, why }. An unknown SEAMUX_HOST is reported and ignored, so a
// typo never sends pages nowhere.
export function detectHost(env = process.env) {
  const o = (env.SEAMUX_HOST || "").trim().toLowerCase();
  const note = o && !HOSTS.includes(o) ? ` (SEAMUX_HOST=${env.SEAMUX_HOST} ignored: not one of ${HOSTS.join(", ")})` : "";
  if (HOSTS.includes(o)) return { host: o, why: "SEAMUX_HOST=" + o };
  if (env.CMUX_WORKSPACE_ID) return { host: "cmux", why: "CMUX_WORKSPACE_ID is set" + note };
  if (env.CLAUDE_CODE_REMOTE === "true") return { host: "remote", why: "CLAUDE_CODE_REMOTE=true" + note };
  const ep = env.CLAUDE_CODE_ENTRYPOINT || "";
  if (DESKTOP_ENTRYPOINTS.includes(ep)) return { host: "desktop", why: "CLAUDE_CODE_ENTRYPOINT=" + ep + note };
  return { host: "terminal", why: "no cmux, remote or desktop signal" + note };
}

// One line for doctor-style output.
export function hostLine(env = process.env) {
  const h = detectHost(env);
  return `host: ${h.host} (${h.why})`;
}

// Where state lives on the remote host: <git root>/.seamux/state, so it
// survives in the repo when the sandbox's home does not. "" on any other
// host, or outside a git repo. The repo is CLAUDE_PROJECT_DIR's when set,
// else the cwd's. The folder is kept out of git through .git/info/exclude
// (never .gitignore, which would be a change to the repo itself).
export function remoteStateDir(env = process.env, cwd = process.cwd()) {
  if (detectHost(env).host !== "remote") return "";
  const from = env.CLAUDE_PROJECT_DIR || cwd;
  const git = a => spawnSync("git", ["-C", from, ...a], { encoding: "utf8", timeout: 5000 });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !top.stdout.trim()) return "";
  const root = top.stdout.trim();
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.status === 0 && common.stdout.trim()) {
    const ex = path.join(common.stdout.trim(), "info", "exclude");
    try {
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, "utf8") : "";
      if (!cur.split("\n").includes("/.seamux/state/")) {
        fs.mkdirSync(path.dirname(ex), { recursive: true });
        fs.appendFileSync(ex, (cur && !cur.endsWith("\n") ? "\n" : "") + "/.seamux/state/\n");
      }
    } catch { /* a read-only .git: the folder shows as untracked, nothing worse */ }
  }
  return path.join(root, ".seamux", "state");
}
